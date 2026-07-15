/**
 * plugins/reports/config-crud.js — CRUD для настроек отчётов
 *
 * Регистрирует HTTP-эндпоинты:
 *   GET    /reports/:dashboardId        — получить конфиг
 *   PUT    /reports/:dashboardId        — создать/обновить конфиг
 *   DELETE /reports/:dashboardId        — удалить конфиг
 *   POST   /reports/:dashboardId/test   — отправить тестовый отчёт
 *   GET    /reports/:dashboardId/history — история отправок
 */
'use strict';

const crypto = require('crypto');
const auth   = require('../../auth');
const { shouldSendNowDetailed, parseTimezoneOffset, getLocalTime, formatHHMM, formatDate, hhmmToMinutes, WINDOW_MINUTES } = require('../shared/schedule-utils');

const VALID_SCHEDULE_TYPES = ['daily', 'weekly', 'interval'];
const VALID_SIZES = ['9:16', '16:9', '1:1', 'A4'];
const VALID_DAYS_RE = /^[0-6](,[0-6])*$/;

/**
 * Регистрация HTTP-маршрутов.
 * @param {object} server — http.Server
 * @param {object} db     — better-sqlite3 Database
 * @param {object} deps   — { dispatcher, schedulerStatus, generateXml }
 */
function registerRoutes(server, db, deps) {
  const origListener = server.listeners('request')[0];

  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    try {
      // Быстрый пропуск: не /reports → передаём оригинальному обработчику
      if (!req.url.startsWith('/reports')) {
        return origListener(req, res);
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const segments = url.pathname.split('/').filter(Boolean);
      // ['/reports', ':dashboardId'] или ['/reports', ':dashboardId', 'test'] или ...
      const dashboardId = segments[1] || '';
      const action = segments[2] || '';

      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      // Auth: все /reports-эндпоинты требуют сессию
      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });

      // ── GET /reports/:dashboardId — получить конфиг ──
      if (req.method === 'GET' && !action && dashboardId !== 'scheduler-status') {
        const row = db.prepare('SELECT * FROM report_configs WHERE dashboard_id = ?')
          .get(dashboardId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        // Маскируем bot_token — показываем только последние 4 символа
        return auth.json(res, 200, { config: sanitizeConfig(row) });
      }

      // ── GET /reports/:dashboardId/tokens — получить токены в открытом виде ──
      if (req.method === 'GET' && action === 'tokens') {
        const row = db.prepare('SELECT * FROM report_configs WHERE dashboard_id = ?')
          .get(dashboardId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        return auth.json(res, 200, {
          bot_token: row.bot_token || '',
          telegram_bot_token: row.telegram_bot_token || '',
        });
      }

      // ── PUT /reports/:dashboardId — создать/обновить ──
      if (req.method === 'PUT' && !action) {
        // Проверяем что дашборд принадлежит пользователю
        const dash = auth.getDashboard(db, dashboardId);
        if (!dash) return auth.json(res, 404, { error: 'dashboard_not_found' });
        if (dash.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        let body;
        try { body = await auth.readJsonBody(req); }
        catch (_) { return auth.json(res, 400, { error: 'invalid_json' }); }

        // Проверяем, существует ли уже конфиг (для обновления vs создания)
        const existingRow = db.prepare('SELECT * FROM report_configs WHERE dashboard_id = ?')
          .get(dashboardId);

        // isUpdate: при обновлении bot_token и telegram_bot_token могут быть пустыми
        // (пользователь не менял — оставляем старые)
        const isUpdate = !!existingRow;
        const validation = validateConfig(body, isUpdate);
        if (!validation.ok) return auth.json(res, 400, { error: validation.error });

        const cfg = validation.config;
        const now = new Date().toISOString();

        if (existingRow) {
          // Обновляем: если bot_token пустой — сохраняем старый
          const finalBotToken = cfg.bot_token || existingRow.bot_token;
          const finalTgToken = cfg.telegram_bot_token || existingRow.telegram_bot_token || '';

          db.prepare(`
            UPDATE report_configs SET
              is_active = ?, bot_id = ?, bot_token = ?, function_id = ?,
              prompt = ?, size = ?, files_url = ?, telegram_bot_token = ?,
              chat_ids = ?, emails = ?, schedule_type = ?, schedule_time = ?,
              schedule_days = ?, schedule_hours = ?, timezone = ?,
              updated_at = ?
            WHERE dashboard_id = ?
          `).run(
            cfg.is_active ? 1 : 0,
            cfg.bot_id, finalBotToken, cfg.function_id,
            cfg.prompt, cfg.size, cfg.files_url, finalTgToken,
            cfg.chat_ids, cfg.emails, cfg.schedule_type, cfg.schedule_time,
            cfg.schedule_days, cfg.schedule_hours, cfg.timezone,
            now, dashboardId
          );
        } else {
          // Создаём — bot_token обязателен
          if (!cfg.bot_token) return auth.json(res, 400, { error: 'invalid_bot_token' });
          const id = 'rc_' + crypto.randomBytes(8).toString('hex');
          // INSERT ... ON CONFLICT: если по dashboard_id уже есть запись
          // (UNIQUE INDEX), перезаписываем её. Страховка от редкой гонки,
          // когда два запроса пришли одновременно.
          db.prepare(`
            INSERT INTO report_configs (
              id, dashboard_id, src, is_active, bot_id, bot_token, function_id,
              prompt, size, files_url, telegram_bot_token, chat_ids, emails,
              schedule_type, schedule_time, schedule_days, schedule_hours,
              timezone, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dashboard_id) DO UPDATE SET
              is_active = excluded.is_active,
              bot_id = excluded.bot_id,
              bot_token = excluded.bot_token,
              function_id = excluded.function_id,
              prompt = excluded.prompt,
              size = excluded.size,
              files_url = excluded.files_url,
              telegram_bot_token = excluded.telegram_bot_token,
              chat_ids = excluded.chat_ids,
              emails = excluded.emails,
              schedule_type = excluded.schedule_type,
              schedule_time = excluded.schedule_time,
              schedule_days = excluded.schedule_days,
              schedule_hours = excluded.schedule_hours,
              timezone = excluded.timezone,
              src = excluded.src,
              updated_at = excluded.updated_at
          `).run(
            id, dashboardId, session.src,
            cfg.is_active ? 1 : 0,
            cfg.bot_id, cfg.bot_token, cfg.function_id,
            cfg.prompt, cfg.size, cfg.files_url, cfg.telegram_bot_token,
            cfg.chat_ids, cfg.emails, cfg.schedule_type, cfg.schedule_time,
            cfg.schedule_days, cfg.schedule_hours, cfg.timezone,
            now, now
          );
        }

        const saved = db.prepare('SELECT * FROM report_configs WHERE dashboard_id = ?')
          .get(dashboardId);
        return auth.json(res, 200, { config: sanitizeConfig(saved) });
      }

      // ── DELETE /reports/:dashboardId ──
      if (req.method === 'DELETE' && !action) {
        const row = db.prepare('SELECT * FROM report_configs WHERE dashboard_id = ?')
          .get(dashboardId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        db.prepare('DELETE FROM report_configs WHERE dashboard_id = ?').run(dashboardId);
        return auth.json(res, 200, { ok: true });
      }

      // ── POST /reports/:dashboardId/test — тестовая отправка ──
      if (req.method === 'POST' && action === 'test') {
        const row = db.prepare('SELECT * FROM report_configs WHERE dashboard_id = ?')
          .get(dashboardId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        // Rate-limit: не чаще 1 раза в 5 минут
        const recent = db.prepare(
          'SELECT id FROM report_history WHERE config_id = ? AND trigger_type = ? AND started_at > ?'
        ).get(row.id, 'test', new Date(Date.now() - 5 * 60 * 1000).toISOString());
        if (recent) return auth.json(res, 429, { error: 'too_frequent', remainSec: 290 });

        if (deps && deps.dispatcher) {
          // Запускаем асинхронно, возвращаем history_id
          const historyId = db.prepare(
            `INSERT INTO report_history (config_id, dashboard_id, src, started_at, status, trigger_type)
             VALUES (?, ?, ?, ?, 'working', 'test')`
          ).run(row.id, dashboardId, session.src, new Date().toISOString()).lastInsertRowid;

          deps.dispatcher.dispatchReport(db, row, historyId).catch(() => {});

          return auth.json(res, 200, { historyId, status: 'working' });
        }

        return auth.json(res, 500, { error: 'dispatcher_not_loaded' });
      }

      // ── GET /reports/:dashboardId/history — история отправок ──
      if (req.method === 'GET' && action === 'history' && !segments[3]) {
        const row = db.prepare('SELECT src FROM report_configs WHERE dashboard_id = ?')
          .get(dashboardId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        const history = db.prepare(
          `SELECT id, config_id, started_at, finished_at, status, image_url, error_message, trigger_type, duration_ms
           FROM report_history
           WHERE dashboard_id = ?
           ORDER BY started_at DESC
           LIMIT 20`
        ).all(dashboardId);

        return auth.json(res, 200, { history });
      }

      // ── GET /reports/:dashboardId/history/:historyId — статус конкретной отправки ──
      if (req.method === 'GET' && action === 'history' && segments[3]) {
        const historyId = parseInt(segments[3], 10);
        if (isNaN(historyId)) return auth.json(res, 400, { error: 'bad_history_id' });

        const hRow = db.prepare(
          'SELECT * FROM report_history WHERE id = ? AND dashboard_id = ?'
        ).get(historyId, dashboardId);
        if (!hRow) return auth.json(res, 404, { error: 'not_found' });

        let phases = [];
        try { phases = JSON.parse(hRow.phases || '[]'); } catch (_) {}

        return auth.json(res, 200, {
          id: hRow.id,
          status: hRow.status,
          image_url: hRow.image_url,
          error_message: hRow.error_message,
          started_at: hRow.started_at,
          finished_at: hRow.finished_at,
          duration_ms: hRow.duration_ms || 0,
          trigger_type: hRow.trigger_type,
          phases: phases,
        });
      }

      // ── GET /reports/:dashboardId/check-schedule — проверка расписания «прямо сейчас» ──
      if (req.method === 'GET' && action === 'check-schedule') {
        const row = db.prepare('SELECT * FROM report_configs WHERE dashboard_id = ?')
          .get(dashboardId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        const utcNow = new Date();
        const offset = parseTimezoneOffset(row.timezone);
        const localNow = getLocalTime(utcNow, offset);
        const localHHMM = formatHHMM(localNow);
        const localDate = formatDate(localNow);
        const localDay = localNow.getUTCDay();

        // Сработал бы таймер прямо сейчас? (с причиной)
        const detail = shouldSendNowDetailed(row, utcNow);
        const wouldSend = detail.send;

        // Вычисляем когда следующее срабатывание
        let nextSendAt = null;
        let minutesUntilNext = null;

        const target = row.schedule_time || '09:00';
        const targetMin = hhmmToMinutes(target);
        const nowMin = hhmmToMinutes(localHHMM);

        if (detail.alreadySentToday) {
          // Уже отправлено сегодня — следующее = завтра (или ближайший подходящий день)
          if (row.schedule_type === 'daily') {
            let nextDay = new Date(localNow.getTime() + 86400000);
            nextDay.setUTCHours(parseInt(target.split(':')[0], 10), parseInt(target.split(':')[1], 10), 0, 0);
            nextSendAt = new Date(nextDay.getTime() - offset * 3600000).toISOString();
            minutesUntilNext = Math.round((new Date(nextSendAt).getTime() - utcNow.getTime()) / 60000);
          } else if (row.schedule_type === 'weekly') {
            const allowedDays = String(row.schedule_days || '1,2,3,4,5')
              .split(',').map(d => parseInt(d.trim(), 10)).filter(d => !isNaN(d));
            for (let add = 1; add <= 7; add++) {
              const candidateDate = new Date(localNow.getTime() + add * 86400000);
              const candidateDay = candidateDate.getUTCDay();
              if (!allowedDays.includes(candidateDay)) continue;
              candidateDate.setUTCHours(parseInt(target.split(':')[0], 10), parseInt(target.split(':')[1], 10), 0, 0);
              nextSendAt = new Date(candidateDate.getTime() - offset * 3600000).toISOString();
              minutesUntilNext = Math.round((new Date(nextSendAt).getTime() - utcNow.getTime()) / 60000);
              break;
            }
          }
        } else if (wouldSend) {
          // Сработал бы прямо сейчас — nextSendAt = текущее время (0 мин)
          nextSendAt = utcNow.toISOString();
          minutesUntilNext = 0;
        } else if (row.schedule_type === 'daily' || row.schedule_type === 'weekly') {
          // Ещё не время — вычисляем когда наступит окно
          if (nowMin < targetMin) {
            // Сегодня ещё будет
            let nextDay = new Date(localNow);
            nextDay.setUTCHours(parseInt(target.split(':')[0], 10), parseInt(target.split(':')[1], 10), 0, 0);
            nextSendAt = new Date(nextDay.getTime() - offset * 3600000).toISOString();
            minutesUntilNext = Math.round((new Date(nextSendAt).getTime() - utcNow.getTime()) / 60000);
          } else {
            // Сегодня уже прошло — завтра / ближайший день
            if (row.schedule_type === 'weekly') {
              const allowedDays = String(row.schedule_days || '1,2,3,4,5')
                .split(',').map(d => parseInt(d.trim(), 10)).filter(d => !isNaN(d));
              for (let add = 1; add <= 7; add++) {
                const candidateDate = new Date(localNow.getTime() + add * 86400000);
                const candidateDay = candidateDate.getUTCDay();
                if (!allowedDays.includes(candidateDay)) continue;
                candidateDate.setUTCHours(parseInt(target.split(':')[0], 10), parseInt(target.split(':')[1], 10), 0, 0);
                nextSendAt = new Date(candidateDate.getTime() - offset * 3600000).toISOString();
                minutesUntilNext = Math.round((new Date(nextSendAt).getTime() - utcNow.getTime()) / 60000);
                break;
              }
            } else {
              let nextDay = new Date(localNow.getTime() + 86400000);
              nextDay.setUTCHours(parseInt(target.split(':')[0], 10), parseInt(target.split(':')[1], 10), 0, 0);
              nextSendAt = new Date(nextDay.getTime() - offset * 3600000).toISOString();
              minutesUntilNext = Math.round((new Date(nextSendAt).getTime() - utcNow.getTime()) / 60000);
            }
          }
        } else if (row.schedule_type === 'interval') {
          const hours = Number(row.schedule_hours) || 0;
          if (hours > 0 && row.last_sent_at) {
            const lastSent = new Date(row.last_sent_at);
            const elapsed = utcNow.getTime() - lastSent.getTime();
            const intervalMs = hours * 3600000;
            if (elapsed < intervalMs) {
              nextSendAt = new Date(lastSent.getTime() + intervalMs).toISOString();
              minutesUntilNext = Math.round((new Date(nextSendAt).getTime() - utcNow.getTime()) / 60000);
            } else {
              nextSendAt = utcNow.toISOString();
              minutesUntilNext = 0;
            }
          } else if (hours > 0) {
            nextSendAt = utcNow.toISOString();
            minutesUntilNext = 0;
          }
        }

        // Форматируем время для отображения
        const serverTimeStr = utcNow.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
        const localTimeStr = localDate + ' ' + localHHMM;

        // Окно расписания для визуального таймлайна
        const windowStart = target;
        const windowEndHHMM = (row.schedule_type === 'interval') ? null : (function() {
          let total = targetMin + WINDOW_MINUTES;
          if (total >= 1440) total -= 1440;
          return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
        })();

        // Retry info: если сегодня уже отправляли, но были ошибки
        let retryInfo = null;
        if (!wouldSend && detail.alreadySentToday &&
            (row.schedule_type === 'daily' || row.schedule_type === 'weekly')) {
          const todayStartLocal = new Date(localNow);
          todayStartLocal.setUTCHours(0, 0, 0, 0);
          const todayStartUtc = new Date(todayStartLocal.getTime() - offset * 3600000).toISOString();

          const errorsToday = db.prepare(
            "SELECT COUNT(*) as cnt FROM report_history WHERE config_id = ? AND status = 'error' AND started_at > ?"
          ).get(row.id, todayStartUtc).cnt;

          const lastSuccess = db.prepare(
            "SELECT id FROM report_history WHERE config_id = ? AND status = 'done' AND started_at > ? ORDER BY started_at DESC LIMIT 1"
          ).get(row.id, todayStartUtc);

          if (errorsToday > 0 && !lastSuccess) {
            const maxRetries = 2;
            retryInfo = {
              errorsToday,
              maxRetries,
              willRetry: errorsToday < maxRetries,
            };
          }
        }

        return auth.json(res, 200, {
          serverTime: utcNow.toISOString(),
          serverTimeStr,
          localTime: localTimeStr,
          localDayOfWeek: localDay,
          localDayName: ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][localDay],
          timezone: row.timezone,
          timezoneOffset: offset,
          scheduleType: row.schedule_type,
          scheduleTime: row.schedule_time,
          scheduleDays: row.schedule_days,
          scheduleHours: row.schedule_hours,
          lastSentAt: row.last_sent_at,
          isActive: !!row.is_active,
          wouldSendNow: wouldSend,
          wouldSendReason: detail.reason,
          inWindow: detail.inWindow,
          alreadySentToday: detail.alreadySentToday,
          catchUp: detail.catchUp || false,
          retryInfo: retryInfo,
          windowStart: windowStart,
          windowEnd: windowEndHHMM,
          windowMinutes: WINDOW_MINUTES,
          nextSendAt: nextSendAt,
          minutesUntilNext: minutesUntilNext,
        });
      }

      // ── GET /reports/scheduler-status — глобальный heartbeat планировщика ──
      if (req.method === 'GET' && dashboardId === 'scheduler-status' && !action) {
        const statusFn = deps && deps.schedulerStatus;
        const status = typeof statusFn === 'function' ? statusFn() : { error: 'not_available' };

        // Дополнительно: считаем активные конфигы и недавние ошибки
        const activeCount = db.prepare('SELECT COUNT(*) as cnt FROM report_configs WHERE is_active = 1').get().cnt;
        const recentErrors = db.prepare(
          "SELECT COUNT(*) as cnt FROM report_history WHERE status = 'error' AND started_at > ?"
        ).get(new Date(Date.now() - 3600000).toISOString()).cnt;
        const recentDone = db.prepare(
          "SELECT COUNT(*) as cnt FROM report_history WHERE status = 'done' AND started_at > ?"
        ).get(new Date(Date.now() - 3600000).toISOString()).cnt;

        return auth.json(res, 200, Object.assign({}, status, {
          activeConfigs: activeCount,
          recentErrors1h: recentErrors,
          recentDone1h: recentDone,
        }));
      }

      // ── POST /reports/:dashboardId/preview-xml — предпросмотр XML ──
      if (req.method === 'POST' && action === 'preview-xml') {
        const row = db.prepare('SELECT * FROM report_configs WHERE dashboard_id = ?')
          .get(dashboardId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        try {
          const { generateDashboardXml } = require('./xml-generator');
          const xml = await generateDashboardXml(db, dashboardId);
          return auth.json(res, 200, {
            xml: xml,
            length: xml.length,
            sizeKB: (xml.length / 1024).toFixed(1),
          });
        } catch (err) {
          return auth.json(res, 500, { error: 'xml_generation_failed', message: err.message });
        }
      }

      // ── GET /reports/:dashboardId/stats — статистика за 7 дней ──
      if (req.method === 'GET' && action === 'stats') {
        const row = db.prepare('SELECT src FROM report_configs WHERE dashboard_id = ?')
          .get(dashboardId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        const since7d = new Date(Date.now() - 7 * 86400000).toISOString();
        const since24h = new Date(Date.now() - 86400000).toISOString();

        const total7d = db.prepare(
          'SELECT COUNT(*) as cnt FROM report_history WHERE dashboard_id = ? AND started_at > ?'
        ).get(dashboardId, since7d).cnt;

        const done7d = db.prepare(
          "SELECT COUNT(*) as cnt FROM report_history WHERE dashboard_id = ? AND status = 'done' AND started_at > ?"
        ).get(dashboardId, since7d).cnt;

        const error7d = db.prepare(
          "SELECT COUNT(*) as cnt FROM report_history WHERE dashboard_id = ? AND status = 'error' AND started_at > ?"
        ).get(dashboardId, since7d).cnt;

        const avgDuration = db.prepare(
          "SELECT AVG(duration_ms) as avg_ms FROM report_history WHERE dashboard_id = ? AND status = 'done' AND started_at > ? AND duration_ms > 0"
        ).get(dashboardId, since7d).avg_ms || 0;

        const total24h = db.prepare(
          'SELECT COUNT(*) as cnt FROM report_history WHERE dashboard_id = ? AND started_at > ?'
        ).get(dashboardId, since24h).cnt;

        const done24h = db.prepare(
          "SELECT COUNT(*) as cnt FROM report_history WHERE dashboard_id = ? AND status = 'done' AND started_at > ?"
        ).get(dashboardId, since24h).cnt;

        const error24h = db.prepare(
          "SELECT COUNT(*) as cnt FROM report_history WHERE dashboard_id = ? AND status = 'error' AND started_at > ?"
        ).get(dashboardId, since24h).cnt;

        // Последняя ошибка
        const lastError = db.prepare(
          "SELECT error_message, started_at FROM report_history WHERE dashboard_id = ? AND status = 'error' ORDER BY started_at DESC LIMIT 1"
        ).get(dashboardId);

        return auth.json(res, 200, {
          period7d: { total: total7d, done: done7d, error: error7d },
          period24h: { total: total24h, done: done24h, error: error24h },
          avgDurationMs: Math.round(avgDuration),
          avgDurationStr: avgDuration > 0 ? (avgDuration > 60000 ? Math.round(avgDuration / 60000) + ' мин' : Math.round(avgDuration / 1000) + ' сек') : '—',
          lastError: lastError ? { message: lastError.error_message, at: lastError.started_at } : null,
        });
      }

      // Несовпавшие маршруты
      return auth.json(res, 404, { error: 'not_found' });

    } catch (e) {
      console.error('[reports] route error:', e.message);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'internal' }));
      }
    }
  });
}

/**
 * Валидация тела запроса PUT /reports/:id
 */
function validateConfig(body, isUpdate) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_body' };

  // bot_id — обязательное число
  const botId = Number(body.bot_id);
  if (!botId || botId <= 0) return { ok: false, error: 'invalid_bot_id' };

  // bot_token — обязательная строка (минимум 8 символов)
  // При обновлении может быть пустым (оставляем старый)
  const botToken = String(body.bot_token || '').trim();
  if (!isUpdate && botToken.length < 8) return { ok: false, error: 'invalid_bot_token' };
  if (botToken.length > 0 && botToken.length < 8) return { ok: false, error: 'invalid_bot_token' };

  // function_id — число, default 697
  const functionId = Number(body.function_id) || 697;

  // prompt — строка (может быть пустой)
  const prompt = String(body.prompt || '').trim();

  // size
  const size = VALID_SIZES.includes(body.size) ? body.size : '9:16';

  // files_url
  const filesUrl = String(body.files_url || '').trim();

  // telegram_bot_token — может быть пустым
  const telegramBotToken = String(body.telegram_bot_token || '').trim();

  // chat_ids — строка через запятую
  const chatIds = String(body.chat_ids || '').trim();

  // emails — строка через запятую
  const emails = String(body.emails || '').trim();

  // schedule_type
  const scheduleType = VALID_SCHEDULE_TYPES.includes(body.schedule_type)
    ? body.schedule_type : 'daily';

  // schedule_time — HH:MM
  const scheduleTime = /^\d{2}:\d{2}$/.test(body.schedule_time)
    ? body.schedule_time : '09:00';

  // schedule_days — "1,2,3,4,5"
  let scheduleDays = String(body.schedule_days || '1,2,3,4,5').trim();
  if (!VALID_DAYS_RE.test(scheduleDays)) scheduleDays = '1,2,3,4,5';

  // schedule_hours — целое число
  const scheduleHours = Math.max(0, Math.min(168, Number(body.schedule_hours) || 0));

  // Для interval-типа schedule_hours должен быть > 0
  if (scheduleType === 'interval' && scheduleHours <= 0) {
    return { ok: false, error: 'invalid_schedule_hours' };
  }

  // timezone
  const timezone = /^UTC[+-]\d{2}:\d{2}$/.test(body.timezone)
    ? body.timezone : 'UTC+03:00';

  // is_active
  const isActive = !!body.is_active;

  return {
    ok: true,
    config: {
      is_active: isActive,
      bot_id: botId,
      bot_token: botToken,
      function_id: functionId,
      prompt,
      size,
      files_url: filesUrl,
      telegram_bot_token: telegramBotToken,
      chat_ids: chatIds,
      emails,
      schedule_type: scheduleType,
      schedule_time: scheduleTime,
      schedule_days: scheduleDays,
      schedule_hours: scheduleHours,
      timezone,
    }
  };
}

/**
 * Санитизация конфига для отдачи клиенту:
 * bot_token маскируется, показываем только последние 4 символа.
 */
function sanitizeConfig(row) {
  if (!row) return null;
  const masked = row.bot_token
    ? '••••••••' + String(row.bot_token).slice(-4)
    : '';
  return {
    dashboard_id: row.dashboard_id,
    is_active: !!row.is_active,
    bot_id: row.bot_id,
    bot_token: masked,
    bot_token_hint: masked, // alias для UI
    function_id: row.function_id,
    prompt: row.prompt,
    size: row.size,
    files_url: row.files_url,
    telegram_bot_token: row.telegram_bot_token ? '••••••••' + String(row.telegram_bot_token).slice(-4) : '',
    chat_ids: row.chat_ids,
    emails: row.emails,
    schedule_type: row.schedule_type,
    schedule_time: row.schedule_time,
    schedule_days: row.schedule_days,
    schedule_hours: row.schedule_hours,
    timezone: row.timezone,
    last_sent_at: row.last_sent_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = { registerRoutes, validateConfig, sanitizeConfig };

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

const VALID_SCHEDULE_TYPES = ['daily', 'weekly', 'interval'];
const VALID_SIZES = ['9:16', '16:9', '1:1', 'A4'];
const VALID_DAYS_RE = /^[0-6](,[0-6])*$/;

/**
 * Регистрация HTTP-маршрутов.
 * @param {object} server — http.Server
 * @param {object} db     — better-sqlite3 Database
 * @param {object} deps   — { scheduler, dispatcher, xmlGenerator }
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
      if (req.method === 'GET' && !action) {
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
          db.prepare(`
            INSERT INTO report_configs (
              id, dashboard_id, src, is_active, bot_id, bot_token, function_id,
              prompt, size, files_url, telegram_bot_token, chat_ids, emails,
              schedule_type, schedule_time, schedule_days, schedule_hours,
              timezone, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      if (req.method === 'GET' && action === 'history') {
        const row = db.prepare('SELECT src FROM report_configs WHERE dashboard_id = ?')
          .get(dashboardId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        const history = db.prepare(
          `SELECT id, config_id, started_at, finished_at, status, image_url, error_message, trigger_type
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

        return auth.json(res, 200, {
          id: hRow.id,
          status: hRow.status,
          image_url: hRow.image_url,
          error_message: hRow.error_message,
          started_at: hRow.started_at,
          finished_at: hRow.finished_at,
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

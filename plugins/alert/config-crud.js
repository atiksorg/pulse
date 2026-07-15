/**
 * plugins/alert/config-crud.js — CRUD для настроек пороговых уведомлений
 *
 * Регистрирует HTTP-эндпоинты:
 *   GET    /alerts/:panelId              — получить конфиг
 *   GET    /alerts/:panelId/token        — токен в открытом виде
 *   PUT    /alerts/:panelId              — создать/обновить
 *   DELETE /alerts/:panelId              — удалить
 *   POST   /alerts/:panelId/test         — тестовая отправка
 *   GET    /alerts/:panelId/history      — история срабатываний
 *   GET    /alerts/:panelId/history/:id  — статус с фазами
 *   GET    /alerts/scheduler-status      — heartbeat планировщика
 *   POST   /alerts/:panelId/preview-value — текущее значение метрики (live-превью)
 *
 * Все эндпоинты требуют сессии. Идентификатор — panel_id, но для авторизации
 * используется dashboard_id из самой записи (а не из URL) — это гарантирует,
 * что пользователь не сможет «угадать» чужие config_id.
 */
'use strict';

const crypto = require('crypto');
const auth   = require('../../auth');
const { evaluatePanelMetric, findPanelInDashboard } = require('./metric-evaluator');
const { dispatchAlert } = require('./dispatcher');

const VALID_CONDITIONS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'outside_range'];

/**
 * Регистрация HTTP-маршрутов.
 * @param {object} server — http.Server
 * @param {object} db     — better-sqlite3 Database
 * @param {object} deps   — { schedulerStatus }
 */
function registerRoutes(server, db, deps) {
  const origListener = server.listeners('request')[0];

  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    try {
      // Быстрый пропуск: не /alerts → передаём оригинальному обработчику
      if (!req.url.startsWith('/alerts')) {
        return origListener(req, res);
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const segments = url.pathname.split('/').filter(Boolean);
      // ['/alerts', ':panelId'] или ['/alerts', ':panelId', 'token'] или ...
      const panelId = decodeURIComponent(segments[1] || '');
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

      // Auth: все /alerts-эндпоинты требуют сессию
      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });

      // ── GET /alerts/scheduler-status — heartbeat (без panelId) ──
      if (req.method === 'GET' && panelId === 'scheduler-status' && !action) {
        const statusFn = deps && deps.schedulerStatus;
        const status = typeof statusFn === 'function' ? statusFn() : { error: 'not_available' };

        const activeCount = db.prepare('SELECT COUNT(*) as cnt FROM alert_configs WHERE is_active = 1').get().cnt;
        const recentErrors = db.prepare(
          "SELECT COUNT(*) as cnt FROM alert_history WHERE status = 'error' AND fired_at > ?"
        ).get(new Date(Date.now() - 3600000).toISOString()).cnt;
        const recentSent = db.prepare(
          "SELECT COUNT(*) as cnt FROM alert_history WHERE status = 'sent' AND fired_at > ?"
        ).get(new Date(Date.now() - 3600000).toISOString()).cnt;

        return auth.json(res, 200, Object.assign({}, status, {
          activeConfigs: activeCount,
          recentErrors1h: recentErrors,
          recentSent1h: recentSent,
        }));
      }

      // ── GET /alerts/:panelId — получить конфиг ──
      if (req.method === 'GET' && !action) {
        const row = db.prepare('SELECT * FROM alert_configs WHERE panel_id = ?')
          .get(panelId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        return auth.json(res, 200, { config: sanitizeConfig(row) });
      }

      // ── GET /alerts/:panelId/token — токены в открытом виде ──
      if (req.method === 'GET' && action === 'token') {
        const row = db.prepare('SELECT * FROM alert_configs WHERE panel_id = ?')
          .get(panelId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        // Достаём первый telegram-канал и возвращаем его токен
        let botToken = '';
        try {
          const channels = JSON.parse(row.channels || '[]');
          const tg = Array.isArray(channels) ? channels.find(c => c && c.type === 'telegram') : null;
          if (tg) botToken = tg.bot_token || '';
        } catch (_) {}

        return auth.json(res, 200, { bot_token: botToken });
      }

      // ── PUT /alerts/:panelId — создать/обновить ──
      if (req.method === 'PUT' && !action) {
        // ВАЖНО: panel_id и dashboard_id берём из query/body, а НЕ из URL —
        // URL содержит только panelId, а dashboard_id живёт в самом config.
        // Для авторизации проверяем, что дашборд принадлежит пользователю.
        let body;
        try { body = await auth.readJsonBody(req); }
        catch (_) { return auth.json(res, 400, { error: 'invalid_json' }); }

        const dashboardId = String(body.dashboard_id || '').trim();
        if (!dashboardId) return auth.json(res, 400, { error: 'missing_dashboard_id' });
        if (!panelId) return auth.json(res, 400, { error: 'missing_panel_id' });

        const dash = auth.getDashboard(db, dashboardId);
        if (!dash) return auth.json(res, 404, { error: 'dashboard_not_found' });
        if (dash.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        // Проверяем что панель существует в дашборде и viz='kpi'/'gauge'
        const panel = findPanelInDashboard(dashboardId, panelId);
        if (!panel) return auth.json(res, 404, { error: 'panel_not_found' });
        if (panel.viz !== 'kpi' && panel.viz !== 'gauge') {
          return auth.json(res, 400, { error: 'unsupported_panel_viz:' + (panel.viz || 'unknown') });
        }

        // Существующая запись?
        const existingRow = db.prepare('SELECT * FROM alert_configs WHERE panel_id = ?')
          .get(panelId);
        const isUpdate = !!existingRow;

        const validation = validateConfig(body, isUpdate);
        if (!validation.ok) return auth.json(res, 400, { error: validation.error });

        const cfg = validation.config;
        const now = new Date().toISOString();

        if (existingRow) {
          // Обновляем: при пустом bot_token — сохраняем старый
          const channels = mergeChannels(existingRow.channels, cfg.channels);
          db.prepare(`
            UPDATE alert_configs SET
              dashboard_id = ?, is_active = ?,
              condition = ?, threshold = ?, threshold_min = ?, threshold_max = ?,
              check_interval_sec = ?, cooldown_min = ?,
              channels = ?, message_template = ?,
              updated_at = ?
            WHERE panel_id = ?
          `).run(
            dashboardId, cfg.is_active ? 1 : 0,
            cfg.condition, cfg.threshold, cfg.threshold_min, cfg.threshold_max,
            cfg.check_interval_sec, cfg.cooldown_min,
            JSON.stringify(channels), cfg.message_template,
            now, panelId
          );
        } else {
          const id = 'al_' + crypto.randomBytes(8).toString('hex');
          // INSERT ... ON CONFLICT: страховка от редкой гонки
          db.prepare(`
            INSERT INTO alert_configs (
              id, panel_id, dashboard_id, src, is_active,
              condition, threshold, threshold_min, threshold_max,
              check_interval_sec, cooldown_min,
              channels, message_template,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(panel_id) DO UPDATE SET
              dashboard_id = excluded.dashboard_id,
              is_active = excluded.is_active,
              condition = excluded.condition,
              threshold = excluded.threshold,
              threshold_min = excluded.threshold_min,
              threshold_max = excluded.threshold_max,
              check_interval_sec = excluded.check_interval_sec,
              cooldown_min = excluded.cooldown_min,
              channels = excluded.channels,
              message_template = excluded.message_template,
              src = excluded.src,
              updated_at = excluded.updated_at
          `).run(
            id, panelId, dashboardId, session.src,
            cfg.is_active ? 1 : 0,
            cfg.condition, cfg.threshold, cfg.threshold_min, cfg.threshold_max,
            cfg.check_interval_sec, cfg.cooldown_min,
            JSON.stringify(cfg.channels), cfg.message_template,
            now, now
          );
        }

        const saved = db.prepare('SELECT * FROM alert_configs WHERE panel_id = ?')
          .get(panelId);
        return auth.json(res, 200, { config: sanitizeConfig(saved) });
      }

      // ── DELETE /alerts/:panelId ──
      if (req.method === 'DELETE' && !action) {
        const row = db.prepare('SELECT * FROM alert_configs WHERE panel_id = ?')
          .get(panelId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        db.prepare('DELETE FROM alert_configs WHERE panel_id = ?').run(panelId);
        return auth.json(res, 200, { ok: true });
      }

      // ── POST /alerts/:panelId/test — тестовая отправка ──
      if (req.method === 'POST' && action === 'test') {
        const row = db.prepare('SELECT * FROM alert_configs WHERE panel_id = ?')
          .get(panelId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        // Rate-limit: не чаще 1 раза в 5 минут
        const recent = db.prepare(
          "SELECT id FROM alert_history WHERE config_id = ? AND trigger_type = ? AND fired_at > ?"
        ).get(row.id, 'test', new Date(Date.now() - 5 * 60 * 1000).toISOString());
        if (recent) return auth.json(res, 429, { error: 'too_frequent', remainSec: 290 });

        // Загружаем панель для контекста сообщения
        const panel = findPanelInDashboard(row.dashboard_id, row.panel_id);
        if (!panel) return auth.json(res, 404, { error: 'panel_not_found' });

        // Вычисляем текущее значение (даже для test — чтобы в сообщении был актуальный value)
        const evalResult = await evaluatePanelMetric(panel, row.src);
        const value = evalResult.value === null ? 0 : evalResult.value;

        // Создаём history-запись со статусом 'working' и trigger='test'
        const historyId = db.prepare(
          `INSERT INTO alert_history (config_id, panel_id, dashboard_id, src, fired_at, value, threshold, condition, status, trigger_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'working', 'test')`
        ).run(
          row.id, row.panel_id, row.dashboard_id, row.src,
          new Date().toISOString(),
          value, row.threshold, row.condition
        ).lastInsertRowid;

        const ctx = {
          value,
          threshold: row.threshold,
          threshold_min: row.threshold_min,
          threshold_max: row.threshold_max,
          condition: row.condition,
          title: panel.title || 'KPI-алерт',
          panel_id: row.panel_id,
          dashboard_id: row.dashboard_id,
          src: row.src,
          agg: panel.agg,
          range: panel.range,
          type: panel.type,
        };

        dispatchAlert(db, row, ctx, historyId)
          .catch(err => console.error('[alerts-test] dispatch error:', err.message));

        return auth.json(res, 200, { historyId, status: 'working', value });
      }

      // ── GET /alerts/:panelId/history — история срабатываний ──
      if (req.method === 'GET' && action === 'history' && !segments[3]) {
        const row = db.prepare('SELECT src FROM alert_configs WHERE panel_id = ?')
          .get(panelId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        const history = db.prepare(
          `SELECT id, config_id, fired_at, finished_at, status, error_message, trigger_type, duration_ms, value, threshold
           FROM alert_history
           WHERE panel_id = ?
           ORDER BY fired_at DESC
           LIMIT 20`
        ).all(panelId);

        return auth.json(res, 200, { history });
      }

      // ── GET /alerts/:panelId/history/:historyId — статус конкретной отправки ──
      if (req.method === 'GET' && action === 'history' && segments[3]) {
        const historyId = parseInt(segments[3], 10);
        if (isNaN(historyId)) return auth.json(res, 400, { error: 'bad_history_id' });

        const hRow = db.prepare(
          'SELECT * FROM alert_history WHERE id = ? AND panel_id = ?'
        ).get(historyId, panelId);
        if (!hRow) return auth.json(res, 404, { error: 'not_found' });
        if (hRow.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        let phases = [];
        try { phases = JSON.parse(hRow.phases || '[]'); } catch (_) {}

        return auth.json(res, 200, {
          id: hRow.id,
          status: hRow.status,
          error_message: hRow.error_message,
          fired_at: hRow.fired_at,
          finished_at: hRow.finished_at,
          duration_ms: hRow.duration_ms || 0,
          trigger_type: hRow.trigger_type,
          value: hRow.value,
          threshold: hRow.threshold,
          phases: phases,
        });
      }

      // ── POST /alerts/:panelId/preview-value — текущее значение метрики ──
      if (req.method === 'POST' && action === 'preview-value') {
        const row = db.prepare('SELECT * FROM alert_configs WHERE panel_id = ?')
          .get(panelId);
        if (!row) return auth.json(res, 404, { error: 'not_found' });
        if (row.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        const panel = findPanelInDashboard(row.dashboard_id, row.panel_id);
        if (!panel) return auth.json(res, 404, { error: 'panel_not_found' });

        const evalResult = await evaluatePanelMetric(panel, row.src);
        return auth.json(res, 200, {
          value: evalResult.value,
          aggMode: evalResult.aggMode,
          error: evalResult.error || null,
        });
      }

      // Несовпавшие маршруты
      return auth.json(res, 404, { error: 'not_found' });

    } catch (e) {
      console.error('[alerts] route error:', e.message);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'internal' }));
      }
    }
  });
}

/**
 * Смерджить старые и новые каналы. Если у нового telegram-канала
 * bot_token пустой — оставляем старый.
 */
function mergeChannels(existingChannelsJson, newChannels) {
  let existing = [];
  try { existing = JSON.parse(existingChannelsJson || '[]'); } catch (_) { existing = []; }
  if (!Array.isArray(existing)) existing = [];
  if (!Array.isArray(newChannels)) newChannels = [];

  return newChannels.map((nc, i) => {
    if (!nc || nc.type !== 'telegram') return nc;
    // Ищем соответствующий старый telegram-канал (по chat_id)
    const old = existing[i] && existing[i].type === 'telegram' ? existing[i] : null;
    if (old && (!nc.bot_token || nc.bot_token.length < 8)) {
      return Object.assign({}, nc, { bot_token: old.bot_token || '' });
    }
    return nc;
  });
}

/**
 * Валидация тела PUT /alerts/:id
 */
function validateConfig(body, isUpdate) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_body' };

  // condition
  const condition = String(body.condition || 'gt').toLowerCase();
  if (!VALID_CONDITIONS.includes(condition)) {
    return { ok: false, error: 'invalid_condition' };
  }

  // threshold / threshold_min / threshold_max
  let threshold = null, thresholdMin = null, thresholdMax = null;
  if (condition === 'outside_range') {
    thresholdMin = Number(body.threshold_min);
    thresholdMax = Number(body.threshold_max);
    if (isNaN(thresholdMin) || isNaN(thresholdMax)) {
      return { ok: false, error: 'invalid_threshold_range' };
    }
  } else {
    threshold = Number(body.threshold);
    if (isNaN(threshold)) {
      return { ok: false, error: 'invalid_threshold' };
    }
  }

  // check_interval_sec (30..3600)
  const checkIntervalSec = Math.max(30, Math.min(3600, Number(body.check_interval_sec) || 60));

  // cooldown_min (0..1440)
  const cooldownMin = Math.max(0, Math.min(1440, Number(body.cooldown_min) || 30));

  // Каналы
  let channels = [];
  if (Array.isArray(body.channels)) {
    channels = body.channels.filter(c => c && c.type === 'telegram');
  } else if (body.channels && typeof body.channels === 'object') {
    // Альтернативный формат: { type:'telegram', bot_token, chat_id }
    if (body.channels.type === 'telegram') channels = [body.channels];
  }
  // Валидируем и нормализуем telegram-каналы
  channels = channels.map(c => {
    const botToken = String(c.bot_token || '').trim();
    const chatId = String(c.chat_id || '').trim();
    let parseMode = String(c.parse_mode || 'HTML').toUpperCase();
    if (!['HTML', 'MARKDOWN', 'MARKDOWNV2'].includes(parseMode)) parseMode = 'HTML';
    return { type: 'telegram', bot_token: botToken, chat_id: chatId, parse_mode: parseMode };
  }).filter(c => c.chat_id); // chat_id обязателен

  if (channels.length === 0) {
    return { ok: false, error: 'no_channels' };
  }

  // message_template
  const messageTemplate = String(body.message_template || '').slice(0, 2000);

  // is_active
  const isActive = !!body.is_active;

  return {
    ok: true,
    config: {
      is_active: isActive,
      condition,
      threshold,
      threshold_min: thresholdMin,
      threshold_max: thresholdMax,
      check_interval_sec: checkIntervalSec,
      cooldown_min: cooldownMin,
      channels,
      message_template: messageTemplate,
    }
  };
}

/**
 * Санитизация конфига для отдачи клиенту: bot_token маскируется.
 */
function sanitizeConfig(row) {
  if (!row) return null;
  let channels = [];
  try { channels = JSON.parse(row.channels || '[]'); } catch (_) { channels = []; }
  if (!Array.isArray(channels)) channels = [];

  const safeChannels = channels.map(c => {
    if (!c || c.type !== 'telegram') return c;
    const masked = c.bot_token
      ? '••••••••' + String(c.bot_token).slice(-4)
      : '';
    return { type: c.type, bot_token: masked, chat_id: c.chat_id, parse_mode: c.parse_mode };
  });

  return {
    panel_id: row.panel_id,
    dashboard_id: row.dashboard_id,
    is_active: !!row.is_active,
    condition: row.condition,
    threshold: row.threshold,
    threshold_min: row.threshold_min,
    threshold_max: row.threshold_max,
    check_interval_sec: row.check_interval_sec,
    cooldown_min: row.cooldown_min,
    channels: safeChannels,
    message_template: row.message_template || '',
    last_value: row.last_value,
    last_checked_at: row.last_checked_at,
    last_fired_at: row.last_fired_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = { registerRoutes, validateConfig, sanitizeConfig };

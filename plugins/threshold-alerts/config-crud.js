/**
 * plugins/threshold-alerts/config-crud.js — CRUD для правил пороговых уведомлений
 *
 * Регистрирует HTTP-эндпоинты:
 *   GET    /alerts/:dashboardId               — список правил дашборда
 *   GET    /alerts/config/:configId            — получить одно правило
 *   PUT    /alerts/:dashboardId/:panelId       — создать/обновить правило для панели
 *   DELETE /alerts/config/:configId            — удалить правило
 *   POST   /alerts/config/:configId/test       — тестовая проверка/отправка
 *   GET    /alerts/config/:configId/history    — история срабатываний
 */
'use strict';

const crypto = require('crypto');
const auth   = require('../../auth');
const { checkAlertConfig } = require('./checker');

const VALID_AGG = ['count', 'sum', 'avg', 'max', 'min'];
const VALID_RANGE = ['24h', '7d', '30d', 'all'];

function registerRoutes(server, db) {
  const origListener = server.listeners('request')[0];

  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    try {
      if (!req.url.startsWith('/alerts')) {
        return origListener(req, res);
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const segments = url.pathname.split('/').filter(Boolean);
      // ['alerts', dashboardId] | ['alerts', dashboardId, panelId]
      // ['alerts', 'config', configId] | ['alerts', 'config', configId, 'test'|'history']

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });

      // ── GET /alerts/:dashboardId — список правил дашборда ──
      if (req.method === 'GET' && segments.length === 2 && segments[1] !== 'config') {
        const dashboardId = segments[1];
        const dash = auth.getDashboard(db, dashboardId);
        if (!dash) return auth.json(res, 404, { error: 'dashboard_not_found' });
        if (dash.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        const rows = db.prepare('SELECT * FROM alert_configs WHERE dashboard_id = ? ORDER BY created_at ASC')
          .all(dashboardId);
        return auth.json(res, 200, { configs: rows.map(sanitizeConfig) });
      }

      // ── GET /alerts/config/:configId ──
      if (req.method === 'GET' && segments[1] === 'config' && segments.length === 3) {
        const row = getOwnedConfig(db, segments[2], session.src);
        if (row.error) return auth.json(res, row.code, { error: row.error });
        return auth.json(res, 200, { config: sanitizeConfig(row.config) });
      }

      // ── GET /alerts/config/:configId/history ──
      if (req.method === 'GET' && segments[1] === 'config' && segments[3] === 'history') {
        const row = getOwnedConfig(db, segments[2], session.src);
        if (row.error) return auth.json(res, row.code, { error: row.error });

        const history = db.prepare(
          'SELECT * FROM alert_history WHERE config_id = ? ORDER BY ts DESC LIMIT 50'
        ).all(row.config.id);
        return auth.json(res, 200, { history });
      }

      // ── PUT /alerts/:dashboardId/:panelId — создать/обновить ──
      if (req.method === 'PUT' && segments.length === 3 && segments[1] !== 'config') {
        const dashboardId = segments[1];
        const panelId = segments[2];

        const dash = auth.getDashboard(db, dashboardId);
        if (!dash) return auth.json(res, 404, { error: 'dashboard_not_found' });
        if (dash.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        const panel = (dash.panels || []).find(p => p.id === panelId);
        if (!panel) return auth.json(res, 404, { error: 'panel_not_found' });

        let body;
        try { body = await auth.readJsonBody(req); }
        catch (_) { return auth.json(res, 400, { error: 'invalid_json' }); }

        const existingRow = db.prepare('SELECT * FROM alert_configs WHERE panel_id = ?').get(panelId);
        const isUpdate = !!existingRow;

        const validation = validateConfig(body, isUpdate, existingRow);
        if (!validation.ok) return auth.json(res, 400, { error: validation.error });

        const cfg = validation.config;
        const now = new Date().toISOString();

        if (existingRow) {
          const finalToken = cfg.telegram_bot_token || existingRow.telegram_bot_token;
          db.prepare(`
            UPDATE alert_configs SET
              is_active = ?, label = ?, panel_type = ?, panel_agg = ?, panel_aggfield = ?,
              panel_range = ?, panel_filters = ?, min_value = ?, max_value = ?,
              telegram_bot_token = ?, chat_ids = ?, check_interval_sec = ?, cooldown_sec = ?,
              notify_on_recovery = ?, updated_at = ?
            WHERE panel_id = ?
          `).run(
            cfg.is_active ? 1 : 0, cfg.label, cfg.panel_type, cfg.panel_agg, cfg.panel_aggfield,
            cfg.panel_range, cfg.panel_filters, cfg.min_value, cfg.max_value,
            finalToken, cfg.chat_ids, cfg.check_interval_sec, cfg.cooldown_sec,
            cfg.notify_on_recovery ? 1 : 0, now, panelId
          );
        } else {
          if (!cfg.telegram_bot_token) return auth.json(res, 400, { error: 'invalid_bot_token' });
          if (!cfg.chat_ids) return auth.json(res, 400, { error: 'invalid_chat_ids' });

          const id = 'ac_' + crypto.randomBytes(8).toString('hex');
          db.prepare(`
            INSERT INTO alert_configs (
              id, dashboard_id, panel_id, src, is_active, label,
              panel_type, panel_agg, panel_aggfield, panel_range, panel_filters,
              min_value, max_value, telegram_bot_token, chat_ids,
              check_interval_sec, cooldown_sec, notify_on_recovery,
              state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)
            ON CONFLICT(panel_id) DO UPDATE SET
              is_active = excluded.is_active, label = excluded.label,
              panel_type = excluded.panel_type, panel_agg = excluded.panel_agg,
              panel_aggfield = excluded.panel_aggfield, panel_range = excluded.panel_range,
              panel_filters = excluded.panel_filters, min_value = excluded.min_value,
              max_value = excluded.max_value, telegram_bot_token = excluded.telegram_bot_token,
              chat_ids = excluded.chat_ids, check_interval_sec = excluded.check_interval_sec,
              cooldown_sec = excluded.cooldown_sec, notify_on_recovery = excluded.notify_on_recovery,
              updated_at = excluded.updated_at
          `).run(
            id, dashboardId, panelId, session.src, cfg.is_active ? 1 : 0, cfg.label,
            cfg.panel_type, cfg.panel_agg, cfg.panel_aggfield, cfg.panel_range, cfg.panel_filters,
            cfg.min_value, cfg.max_value, cfg.telegram_bot_token, cfg.chat_ids,
            cfg.check_interval_sec, cfg.cooldown_sec, cfg.notify_on_recovery ? 1 : 0,
            now, now
          );
        }

        const saved = db.prepare('SELECT * FROM alert_configs WHERE panel_id = ?').get(panelId);
        return auth.json(res, 200, { config: sanitizeConfig(saved) });
      }

      // ── DELETE /alerts/config/:configId ──
      if (req.method === 'DELETE' && segments[1] === 'config' && segments.length === 3) {
        const row = getOwnedConfig(db, segments[2], session.src);
        if (row.error) return auth.json(res, row.code, { error: row.error });

        db.prepare('DELETE FROM alert_configs WHERE id = ?').run(row.config.id);
        return auth.json(res, 200, { ok: true });
      }

      // ── POST /alerts/config/:configId/test ──
      if (req.method === 'POST' && segments[1] === 'config' && segments[3] === 'test') {
        const row = getOwnedConfig(db, segments[2], session.src);
        if (row.error) return auth.json(res, row.code, { error: row.error });

        const recent = db.prepare(
          "SELECT id FROM alert_history WHERE config_id = ? AND trigger_type = 'test' AND ts > ?"
        ).get(row.config.id, new Date(Date.now() - 60 * 1000).toISOString());
        if (recent) return auth.json(res, 429, { error: 'too_frequent', remainSec: 55 });

        const result = await checkAlertConfig(db, row.config, { triggerType: 'test', force: true });
        const updated = db.prepare('SELECT * FROM alert_configs WHERE id = ?').get(row.config.id);
        return auth.json(res, 200, { result, config: sanitizeConfig(updated) });
      }

      return auth.json(res, 404, { error: 'not_found' });
    } catch (e) {
      console.error('[threshold-alerts-crud] error:', e.message);
      return auth.json(res, 500, { error: 'internal_error' });
    }
  });
}

function getOwnedConfig(db, configId, src) {
  const config = db.prepare('SELECT * FROM alert_configs WHERE id = ?').get(configId);
  if (!config) return { error: 'not_found', code: 404 };
  if (config.src !== src) return { error: 'forbidden', code: 403 };
  return { config };
}

/**
 * Валидация тела запроса PUT.
 * Ожидаемые поля: is_active, label, panel_type, panel_agg, panel_aggfield,
 * panel_range, filters(array), min_value, max_value, telegram_bot_token,
 * chat_ids, check_interval_sec, cooldown_sec, notify_on_recovery
 */
function validateConfig(body, isUpdate, existingRow) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_body' };

  const minV = body.min_value === '' || body.min_value === undefined || body.min_value === null
    ? null : Number(body.min_value);
  const maxV = body.max_value === '' || body.max_value === undefined || body.max_value === null
    ? null : Number(body.max_value);

  if (minV !== null && Number.isNaN(minV)) return { ok: false, error: 'invalid_min_value' };
  if (maxV !== null && Number.isNaN(maxV)) return { ok: false, error: 'invalid_max_value' };
  if (minV === null && maxV === null) return { ok: false, error: 'min_or_max_required' };
  if (minV !== null && maxV !== null && minV > maxV) return { ok: false, error: 'min_greater_than_max' };

  const agg = VALID_AGG.includes(body.panel_agg) ? body.panel_agg : 'count';
  const range = VALID_RANGE.includes(body.panel_range) ? body.panel_range : '24h';
  if ((agg === 'sum' || agg === 'avg' || agg === 'max' || agg === 'min') && !body.panel_aggfield) {
    return { ok: false, error: 'aggfield_required' };
  }

  const chatIds = typeof body.chat_ids === 'string' ? body.chat_ids.trim() : '';
  if (!isUpdate && !chatIds) return { ok: false, error: 'invalid_chat_ids' };

  const checkInterval = Math.max(30, Number(body.check_interval_sec) || 60);
  const cooldown = Math.max(60, Number(body.cooldown_sec) || 900);

  let filters = [];
  if (Array.isArray(body.filters)) filters = body.filters.slice(0, 5);

  return {
    ok: true,
    config: {
      is_active: !!body.is_active,
      label: String(body.label || '').slice(0, 200),
      panel_type: String(body.panel_type || ''),
      panel_agg: agg,
      panel_aggfield: String(body.panel_aggfield || ''),
      panel_range: range,
      panel_filters: JSON.stringify(filters),
      min_value: minV,
      max_value: maxV,
      telegram_bot_token: typeof body.telegram_bot_token === 'string' ? body.telegram_bot_token.trim() : '',
      chat_ids: chatIds,
      check_interval_sec: checkInterval,
      cooldown_sec: cooldown,
      notify_on_recovery: body.notify_on_recovery !== false,
    },
  };
}

/** Скрываем токен бота — показываем только последние 4 символа. */
function sanitizeConfig(row) {
  if (!row) return row;
  const out = Object.assign({}, row);
  if (out.telegram_bot_token) {
    out.telegram_bot_token_masked = '***' + out.telegram_bot_token.slice(-4);
  }
  delete out.telegram_bot_token;
  out.panel_filters = safeParse(out.panel_filters);
  return out;
}

function safeParse(json) {
  try { return JSON.parse(json || '[]'); } catch (_) { return []; }
}

module.exports = { registerRoutes, validateConfig, sanitizeConfig };

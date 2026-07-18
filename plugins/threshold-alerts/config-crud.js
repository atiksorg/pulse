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
const { FormulaEvaluator, resolveFormulaMetrics } = require('./metric-query');

const VALID_AGG = ['count', 'sum', 'avg', 'max', 'min'];
const VALID_RANGE = ['1h', '6h', '24h', '7d', '30d', 'all'];
const VALID_CHECK_MODE = ['absolute', 'delta_pct', 'anomaly', 'formula'];
const VALID_ON_EMPTY = ['treat_as_zero', 'alert', 'ignore'];
const VALID_DELTA_RANGE = ['1h', '6h', '24h', '7d', '30d'];

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
              notify_on_recovery = ?, group_field = ?, group_value = ?, check_mode = ?,
              delta_range = ?, anomaly_window = ?, on_empty = ?, thresholds_json = ?,
              formula_text = ?, formula_conditions = ?,
              updated_at = ?
            WHERE panel_id = ?
          `).run(
            cfg.is_active ? 1 : 0, cfg.label, cfg.panel_type, cfg.panel_agg, cfg.panel_aggfield,
            cfg.panel_range, cfg.panel_filters, cfg.min_value, cfg.max_value,
            finalToken, cfg.chat_ids, cfg.check_interval_sec, cfg.cooldown_sec,
            cfg.notify_on_recovery ? 1 : 0,
            cfg.group_field, cfg.group_value, cfg.check_mode,
            cfg.delta_range, cfg.anomaly_window, cfg.on_empty, cfg.thresholds_json,
            cfg.formula_text || '', cfg.formula_conditions || '[]',
            now, panelId
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
              group_field, group_value, check_mode, delta_range,
              anomaly_window, on_empty, thresholds_json,
              formula_text, formula_conditions,
              state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)
            ON CONFLICT(panel_id) DO UPDATE SET
              is_active = excluded.is_active, label = excluded.label,
              panel_type = excluded.panel_type, panel_agg = excluded.panel_agg,
              panel_aggfield = excluded.panel_aggfield, panel_range = excluded.panel_range,
              panel_filters = excluded.panel_filters, min_value = excluded.min_value,
              max_value = excluded.max_value, telegram_bot_token = excluded.telegram_bot_token,
              chat_ids = excluded.chat_ids, check_interval_sec = excluded.check_interval_sec,
              cooldown_sec = excluded.cooldown_sec, notify_on_recovery = excluded.notify_on_recovery,
              group_field = excluded.group_field, group_value = excluded.group_value,
              check_mode = excluded.check_mode, delta_range = excluded.delta_range,
              anomaly_window = excluded.anomaly_window, on_empty = excluded.on_empty,
              thresholds_json = excluded.thresholds_json,
              formula_text = excluded.formula_text, formula_conditions = excluded.formula_conditions,
              updated_at = excluded.updated_at
          `).run(
            id, dashboardId, panelId, session.src, cfg.is_active ? 1 : 0, cfg.label,
            cfg.panel_type, cfg.panel_agg, cfg.panel_aggfield, cfg.panel_range, cfg.panel_filters,
            cfg.min_value, cfg.max_value, cfg.telegram_bot_token, cfg.chat_ids,
            cfg.check_interval_sec, cfg.cooldown_sec, cfg.notify_on_recovery ? 1 : 0,
            cfg.group_field, cfg.group_value, cfg.check_mode, cfg.delta_range,
            cfg.anomaly_window, cfg.on_empty, cfg.thresholds_json,
            cfg.formula_text || '', cfg.formula_conditions || '[]',
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

      // ── POST /alerts/config/:configId/formula-eval — тестовый расчёт формулы ──
      if (req.method === 'POST' && segments[1] === 'config' && segments[3] === 'formula-eval') {
        const row = getOwnedConfig(db, segments[2], session.src);
        if (row.error) return auth.json(res, row.code, { error: row.error });

        let body;
        try { body = await auth.readJsonBody(req); }
        catch (_) { body = {}; }

        const formulaText = (body && body.formula_text) || row.config.formula_text || '';
        const formulaConditions = (body && body.formula_conditions) || row.config.formula_conditions || '[]';
        if (!formulaText) return auth.json(res, 400, { error: 'no_formula' });

        const fv = FormulaEvaluator.validate(formulaText);
        if (!fv.valid) return auth.json(res, 400, { error: 'formula_syntax_error', detail: fv.error });

        try {
          const evalResult = resolveFormulaMetrics(
            db,
            {
              ...row.config,
              formula_text: formulaText,
              formula_conditions: typeof formulaConditions === 'string' ? formulaConditions : JSON.stringify(formulaConditions),
            },
            session.src
          );
          return auth.json(res, 200, {
            result: evalResult.result,
            metrics: evalResult.metrics,
            formula: evalResult.formula,
            breach: evalResult.result > 0,
          });
        } catch (e) {
          return auth.json(res, 400, { error: 'formula_eval_error', detail: e.message });
        }
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

/** Санитизация метрики-алиаса для хранения в formula_conditions */
function _cleanMetricAlias(m) {
  if (!m || typeof m !== 'object') return null;
  const VALID_AGG_M = ['count', 'sum', 'avg', 'max', 'min'];
  return {
    type: 'metric',
    name: String(m.name || '').trim().slice(0, 32),
    agg: VALID_AGG_M.includes(m.agg) ? m.agg : 'count',
    aggfield: String(m.aggfield || '').trim().slice(0, 64),
    range: VALID_RANGE.includes(m.range) ? m.range : undefined,
  };
}

/**
 * Валидация тела запроса PUT.
 * Ожидаемые поля: is_active, label, panel_type, panel_agg, panel_aggfield,
 * panel_range, filters(array), min_value, max_value, telegram_bot_token,
 * chat_ids, check_interval_sec, cooldown_sec, notify_on_recovery,
 * group_field, group_value, check_mode, delta_range, anomaly_window,
 * on_empty, thresholds_json
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

  // ── Новые поля ──
  const checkMode = VALID_CHECK_MODE.includes(body.check_mode) ? body.check_mode : 'absolute';
  const onEmpty = VALID_ON_EMPTY.includes(body.on_empty) ? body.on_empty : 'treat_as_zero';
  const deltaRange = VALID_DELTA_RANGE.includes(body.delta_range) ? body.delta_range : '1h';
  const anomalyWindow = Math.max(2, Math.min(30, Number(body.anomaly_window) || 7));
  const groupField = String(body.group_field || '').trim().slice(0, 64);
  const groupValue = String(body.group_value || '').trim().slice(0, 256);

  // ── Formula mode: ранний возврат (formula_text + formula_conditions) ──
  if (checkMode === 'formula') {
    const formulaText = String(body.formula_text || '').trim();
    if (!formulaText) return { ok: false, error: 'formula_text_required' };
    const fv = FormulaEvaluator.validate(formulaText);
    if (!fv.valid) return { ok: false, error: 'formula_syntax_error', detail: fv.error };
    const formulaVars = FormulaEvaluator.extractVariables(formulaText);
    if (formulaVars.length === 0) return { ok: false, error: 'formula_no_variables' };
    if (formulaVars.length > 20) return { ok: false, error: 'formula_too_many_variables' };

    let formulaConditions = '[]';
    if (Array.isArray(body.formula_conditions)) {
      const cleaned = body.formula_conditions.slice(0, 20).map(c => ({
        left_metric: _cleanMetricAlias(c.left_metric),
        operator: ['>', '<', '>=', '<=', '==', '!='].includes(c.operator) ? c.operator : '>',
        right_metric: _cleanMetricAlias(c.right_metric),
        logic: ['AND', 'OR'].includes(c.logic) ? c.logic : 'AND',
      }));
      formulaConditions = JSON.stringify(cleaned);
    } else if (typeof body.formula_conditions === 'string') {
      try {
        const parsed = JSON.parse(body.formula_conditions);
        if (Array.isArray(parsed)) formulaConditions = body.formula_conditions;
      } catch (_) {}
    }

    return {
      ok: true,
      config: {
        is_active: !!body.is_active,
        label: String(body.label || '').slice(0, 200),
        panel_type: String(body.panel_type || ''),
        panel_agg: agg, panel_aggfield: String(body.panel_aggfield || ''),
        panel_range: range, panel_filters: JSON.stringify(filters),
        min_value: 0, max_value: null,
        telegram_bot_token: typeof body.telegram_bot_token === 'string' ? body.telegram_bot_token.trim() : '',
        chat_ids: chatIds, check_interval_sec: checkInterval, cooldown_sec: cooldown,
        notify_on_recovery: body.notify_on_recovery !== false,
        group_field: groupField, group_value: groupValue,
        check_mode: 'formula', delta_range: deltaRange, anomaly_window: anomalyWindow,
        on_empty: onEmpty, thresholds_json: '[]',
        formula_text: formulaText, formula_conditions: formulaConditions,
      },
    };
  }

  // thresholds_json: валидируем структуру
  let thresholdsJson = '[]';
  if (body.thresholds_json && Array.isArray(body.thresholds_json)) {
    const cleaned = body.thresholds_json.slice(0, 10).map(t => ({
      min: t.min !== null && t.min !== undefined && t.min !== '' ? Number(t.min) : null,
      max: t.max !== null && t.max !== undefined && t.max !== '' ? Number(t.max) : null,
      severity: ['critical', 'warning', 'info'].includes(t.severity) ? t.severity : 'warning',
      chat_ids: typeof t.chat_ids === 'string' ? t.chat_ids.trim() : '',
    }));
    thresholdsJson = JSON.stringify(cleaned);
  } else if (typeof body.thresholds_json === 'string') {
    try {
      const parsed = JSON.parse(body.thresholds_json);
      if (Array.isArray(parsed)) thresholdsJson = body.thresholds_json;
    } catch (_) { /* invalid JSON, use default */ }
  }

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
      group_field: groupField,
      group_value: groupValue,
      check_mode: checkMode,
      delta_range: deltaRange,
      anomaly_window: anomalyWindow,
      on_empty: onEmpty,
      thresholds_json: thresholdsJson,
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
  out.thresholds_json = safeParse(out.thresholds_json);
  return out;
}

function safeParse(json) {
  try { return JSON.parse(json || '[]'); } catch (_) { return []; }
}

module.exports = { registerRoutes, validateConfig, sanitizeConfig };

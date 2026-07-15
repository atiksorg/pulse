/**
 * plugins/kpi-alerts/config-crud.js — REST CRUD + test dispatch for alert rules
 */
'use strict';

const auth = require('../../auth');
const { evaluatePanelValue } = require('./evaluator');
const { evaluateAndDispatch } = require('./dispatcher');

const VALID_CONDITIONS = ['above', 'below', 'equals'];

function safeMask(token) {
  if (!token) return '';
  const s = String(token);
  return s.length <= 4 ? '••••' : '••••' + s.slice(-4);
}

function mapRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    dashboard_id: row.dashboard_id,
    panel_id: row.panel_id,
    condition: row.condition,
    threshold: row.threshold,
    cooldown_minutes: row.cooldown_minutes,
    check_interval_minutes: row.check_interval_minutes,
    chat_ids: row.chat_ids,
    message_template: row.message_template,
    is_active: !!row.is_active,
    state: row.state,
    last_value: row.last_value,
    last_state_change_at: row.last_state_change_at,
    last_sent_at: row.last_sent_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    telegram_bot_token_masked: safeMask(row.telegram_bot_token),
  };
}

function validateCreate(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_body' };

  const panelId = String(body.panel_id || '').trim();
  if (!panelId) return { ok: false, error: 'invalid_panel_id' };

  const condition = VALID_CONDITIONS.includes(body.condition) ? body.condition : 'above';
  const threshold = Number(body.threshold);
  if (!Number.isFinite(threshold)) return { ok: false, error: 'invalid_threshold' };

  const cooldown = Math.max(1, Math.min(1440, Number(body.cooldown_minutes) || 15));
  const checkInterval = Math.max(1, Math.min(1440, Number(body.check_interval_minutes) || 5));
  const chatIds = String(body.chat_ids || '').trim();
  const messageTemplate = String(body.message_template || '').trim();
  const isActive = !!body.is_active;

  let telegramBotToken = String(body.telegram_bot_token || '').trim();
  if (telegramBotToken && telegramBotToken.length < 8) {
    return { ok: false, error: 'invalid_telegram_bot_token' };
  }

  return {
    ok: true,
    rule: {
      panel_id: panelId,
      condition,
      threshold,
      cooldown_minutes: cooldown,
      check_interval_minutes: checkInterval,
      chat_ids: chatIds,
      message_template: messageTemplate,
      telegram_bot_token: telegramBotToken,
      is_active: isActive
    }
  };
}

function registerRoutes(server, db, deps) {
  const origListener = server.listeners('request')[0];

  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    try {
      if (!req.url.startsWith('/alerts')) {
        return origListener(req, res);
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const segments = url.pathname.split('/').filter(Boolean);
      const dashboardId = segments[1] || '';
      const ruleId = segments[2] || '';
      const action = segments[3] || '';

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });

      function checkDashboardOwnership(dashId) {
        const dash = auth.getDashboard(db, dashId);
        if (!dash) return { ok: false, code: 404, error: 'dashboard_not_found' };
        if (dash.src !== session.src) return { ok: false, code: 403, error: 'forbidden' };
        return { ok: true, dashboard: dash };
      }

      function checkRuleOwnership(ruleRow, dashId) {
        if (!ruleRow) return { ok: false, code: 404, error: 'not_found' };
        if (String(ruleRow.dashboard_id) !== String(dashId)) return { ok: false, code: 404, error: 'not_found' };
        if (ruleRow.src !== session.src) return { ok: false, code: 403, error: 'forbidden' };
        return { ok: true };
      }

      // GET /alerts/:dashboardId
      if (req.method === 'GET' && dashboardId && !ruleId) {
        const own = checkDashboardOwnership(dashboardId);
        if (!own.ok) return auth.json(res, own.code, { error: own.error });

        const rows = db.prepare('SELECT * FROM alert_rules WHERE dashboard_id = ? AND src = ? ORDER BY created_at DESC').all(dashboardId, session.src);
        return auth.json(res, 200, { rules: rows.map(mapRule) });
      }

      // POST /alerts/:dashboardId
      if (req.method === 'POST' && dashboardId && !ruleId) {
        const own = checkDashboardOwnership(dashboardId);
        if (!own.ok) return auth.json(res, own.code, { error: own.error });

        let body;
        try { body = await auth.readJsonBody(req); } catch (_) { return auth.json(res, 400, { error: 'invalid_json' }); }

        const v = validateCreate(body);
        if (!v.ok) return auth.json(res, 400, { error: v.error });

        const r = v.rule;
        const now = new Date().toISOString();
        const result = db.prepare(`
          INSERT INTO alert_rules (
            dashboard_id, src, panel_id, condition, threshold, cooldown_minutes,
            check_interval_minutes, telegram_bot_token, chat_ids, message_template,
            is_active, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)
        `).run(
          dashboardId, session.src, r.panel_id, r.condition, r.threshold, r.cooldown_minutes,
          r.check_interval_minutes, r.telegram_bot_token, r.chat_ids, r.message_template,
          r.is_active ? 1 : 0, now, now
        );

        const row = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(result.lastInsertRowid);
        return auth.json(res, 200, { rule: mapRule(row) });
      }

      // PUT /alerts/:dashboardId/:ruleId
      if (req.method === 'PUT' && dashboardId && ruleId && !action) {
        const own = checkDashboardOwnership(dashboardId);
        if (!own.ok) return auth.json(res, own.code, { error: own.error });

        const ruleRow = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(Number(ruleId));
        const ruleOwn = checkRuleOwnership(ruleRow, dashboardId);
        if (!ruleOwn.ok) return auth.json(res, ruleOwn.code, { error: ruleOwn.error });

        let body;
        try { body = await auth.readJsonBody(req); } catch (_) { return auth.json(res, 400, { error: 'invalid_json' }); }

        const v = validateCreate(body);
        if (!v.ok) return auth.json(res, 400, { error: v.error });

        const r = v.rule;
        const finalToken = r.telegram_bot_token || ruleRow.telegram_bot_token || '';
        const now = new Date().toISOString();

        db.prepare(`
          UPDATE alert_rules SET
            panel_id = ?, condition = ?, threshold = ?, cooldown_minutes = ?,
            check_interval_minutes = ?, telegram_bot_token = ?, chat_ids = ?,
            message_template = ?, is_active = ?, updated_at = ?
          WHERE id = ?
        `).run(
          r.panel_id, r.condition, r.threshold, r.cooldown_minutes,
          r.check_interval_minutes, finalToken, r.chat_ids, r.message_template,
          r.is_active ? 1 : 0, now, ruleRow.id
        );

        const updated = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(ruleRow.id);
        return auth.json(res, 200, { rule: mapRule(updated) });
      }

      // DELETE /alerts/:dashboardId/:ruleId
      if (req.method === 'DELETE' && dashboardId && ruleId && !action) {
        const own = checkDashboardOwnership(dashboardId);
        if (!own.ok) return auth.json(res, own.code, { error: own.error });

        const ruleRow = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(Number(ruleId));
        const ruleOwn = checkRuleOwnership(ruleRow, dashboardId);
        if (!ruleOwn.ok) return auth.json(res, ruleOwn.code, { error: ruleOwn.error });

        db.prepare('DELETE FROM alert_rules WHERE id = ?').run(ruleRow.id);
        return auth.json(res, 200, { ok: true });
      }

      // POST /alerts/:dashboardId/:ruleId/test
      if (req.method === 'POST' && dashboardId && ruleId && action === 'test') {
        const own = checkDashboardOwnership(dashboardId);
        if (!own.ok) return auth.json(res, own.code, { error: own.error });

        const ruleRow = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(Number(ruleId));
        const ruleOwn = checkRuleOwnership(ruleRow, dashboardId);
        if (!ruleOwn.ok) return auth.json(res, ruleOwn.code, { error: ruleOwn.error });

        // rate limit: 5 minutes per rule
        const recent = db.prepare(
          'SELECT id FROM alert_history WHERE rule_id = ? AND event_type = ? AND ts > ?'
        ).get(ruleRow.id, 'test', new Date(Date.now() - 5 * 60 * 1000).toISOString());
        if (recent) return auth.json(res, 429, { error: 'too_frequent', remainSec: 290 });

        // Persist a lightweight test event immediately so consecutive test clicks are rate-limited.
        db.prepare(`
          INSERT INTO alert_history (rule_id, ts, value, threshold, event_type, delivery_status, error, attempt)
          VALUES (?, ?, ?, ?, 'test', 'ok', '', 0)
        `).run(ruleRow.id, new Date().toISOString(), null, ruleRow.threshold);

        const evalResult = await evaluatePanelValue(db, dashboardId, ruleRow.panel_id);
        if (!evalResult.ok) {
          return auth.json(res, 400, { error: evalResult.error });
        }

        const enrichedRule = Object.assign({}, ruleRow, {
          _panel: evalResult.panel,
          _dashboard_name: evalResult.dashboardName
        });

        await evaluateAndDispatch(db, enrichedRule, evalResult.value);

        return auth.json(res, 200, {
          ok: true,
          current_value: evalResult.value,
          rule_state: db.prepare('SELECT state, last_value FROM alert_rules WHERE id = ?').get(ruleRow.id)
        });
      }

      // GET /alerts/:dashboardId/:ruleId/history
      if (req.method === 'GET' && dashboardId && ruleId && action === 'history') {
        const own = checkDashboardOwnership(dashboardId);
        if (!own.ok) return auth.json(res, own.code, { error: own.error });

        const ruleRow = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(Number(ruleId));
        const ruleOwn = checkRuleOwnership(ruleRow, dashboardId);
        if (!ruleOwn.ok) return auth.json(res, ruleOwn.code, { error: ruleOwn.error });

        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        const rows = db.prepare('SELECT * FROM alert_history WHERE rule_id = ? ORDER BY ts DESC LIMIT ?').all(ruleRow.id, limit);

        return auth.json(res, 200, { history: rows });
      }

      // GET /alerts/checker-status
      if (req.method === 'GET' && dashboardId === 'checker-status') {
        const statusFn = deps && deps.checkerStatus;
        const status = typeof statusFn === 'function' ? statusFn() : { error: 'not_available' };

        const activeRules = db.prepare('SELECT COUNT(*) AS cnt FROM alert_rules WHERE is_active = 1').get().cnt;
        const recentErrors = db.prepare(
          "SELECT COUNT(*) AS cnt FROM alert_history WHERE delivery_status = 'failed' AND ts > ?"
        ).get(new Date(Date.now() - 3600000).toISOString()).cnt;
        const recentOk = db.prepare(
          "SELECT COUNT(*) AS cnt FROM alert_history WHERE delivery_status = 'ok' AND ts > ?"
        ).get(new Date(Date.now() - 3600000).toISOString()).cnt;

        return auth.json(res, 200, Object.assign({}, status, {
          activeRules,
          recentErrors1h: recentErrors,
          recentOk1h: recentOk
        }));
      }

      return auth.json(res, 404, { error: 'not_found' });
    } catch (e) {
      console.error('[kpi-alerts] route error:', e.message);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'internal' }));
      }
    }
  });
}

module.exports = {
  registerRoutes
};

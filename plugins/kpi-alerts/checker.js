/**
 * plugins/kpi-alerts/checker.js — Tick-based KPI/Gauge alert checker
 *
 * Pattern mirrors reports/scheduler.js:
 * - Subscribe to global._pluginOnFlush for fast reaction.
 * - Use setInterval fallback for quiet metrics.
 * - CAS-style dedup with last_sent_at IS NOT DISTINCT FROM.
 */
'use strict';

const { evaluatePanelValue } = require('./evaluator');
const { evaluateAndDispatch } = require('./dispatcher');

const CHECK_INTERVAL_MS = 60 * 1000;
let lastCheckTime = 0;

function normalizeMinuteWindow(minutes) {
  const n = Number(minutes);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

async function checkAlertRules(db) {
  const now = Date.now();
  if (now - lastCheckTime < CHECK_INTERVAL_MS) {
    return;
  }

  lastCheckTime = now;

  try {
    const rules = db.prepare('SELECT * FROM alert_rules WHERE is_active = 1').all();
    if (!rules.length) {
      return;
    }

    for (const rule of rules) {
      try {
        const intervalMs = normalizeMinuteWindow(rule.check_interval_minutes) * 60000;
        const lastSentAt = rule.last_sent_at ? new Date(rule.last_sent_at).getTime() : 0;

        if (lastSentAt && (now - lastSentAt) < intervalMs) {
          console.log(`[kpi-alerts] rule ${rule.id} skip: interval not elapsed`);
          continue;
        }

        const evalResult = await evaluatePanelValue(db, rule.dashboard_id, rule.panel_id);
        if (!evalResult.ok) {
          console.warn(`[kpi-alerts] rule ${rule.id} skip: ${evalResult.error}`);
          continue;
        }

        const newSentAt = new Date().toISOString();
        const oldSentAt = rule.last_sent_at || null;

        const upd = db.prepare(`
          UPDATE alert_rules SET last_sent_at = ?
          WHERE id = ? AND last_sent_at IS NOT DISTINCT FROM ?
        `).run(newSentAt, rule.id, oldSentAt);

        if (upd.changes === 1) {
          const enrichedRule = Object.assign({}, rule, {
            last_sent_at: newSentAt,
            _panel: evalResult.panel,
            _dashboard_name: evalResult.dashboardName
          });

          await evaluateAndDispatch(db, enrichedRule, evalResult.value);
        } else {
          console.log(`[kpi-alerts] rule ${rule.id} dedup: another tick updated last_sent_at`);
        }
      } catch (e) {
        console.error(`[kpi-alerts] rule ${rule.id} check error:`, e.message);
      }
    }
  } catch (e) {
    console.error('[kpi-alerts] checker error:', e.message);
  }
}

function getCheckerStatus() {
  return {
    lastCheckTime: lastCheckTime ? new Date(lastCheckTime).toISOString() : null,
    lastCheckAgeMs: lastCheckTime ? Date.now() - lastCheckTime : null,
    checkIntervalMs: CHECK_INTERVAL_MS
  };
}

module.exports = {
  checkAlertRules,
  getCheckerStatus
};

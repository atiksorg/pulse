/**
 * plugins/threshold-alerts/scheduler.js — Тиковый механизм проверки правил
 *
 * Каждый тик (не чаще раза в CHECK_INTERVAL_MS) проходит по всем активным
 * alert_configs и для тех, у кого истёк их персональный check_interval_sec
 * с момента last_checked_at, выполняет проверку.
 */
'use strict';

const { checkAlertConfig } = require('./checker');

const CHECK_INTERVAL_MS = 30 * 1000; // тик планировщика — раз в 30 сек
let lastTickTime = 0;
let activeChecks = 0;

async function checkAndDispatchAlerts(db) {
  const now = Date.now();
  if (now - lastTickTime < CHECK_INTERVAL_MS) return;
  lastTickTime = now;

  try {
    const configs = db.prepare('SELECT * FROM alert_configs WHERE is_active = 1').all();
    if (!configs.length) return;

    for (const cfg of configs) {
      const intervalMs = (cfg.check_interval_sec || 60) * 1000;
      const lastChecked = cfg.last_checked_at ? new Date(cfg.last_checked_at).getTime() : 0;
      if (now - lastChecked < intervalMs) continue;

      activeChecks++;
      checkAlertConfig(db, cfg, { triggerType: 'schedule' })
        .catch(err => console.error('[threshold-alerts] check error:', cfg.id, err.message))
        .finally(() => { activeChecks--; });
    }
  } catch (err) {
    console.error('[threshold-alerts] tick error:', err.message);
  }
}

function getSchedulerStatus() {
  return {
    lastTickTime: lastTickTime ? new Date(lastTickTime).toISOString() : null,
    lastTickAgeMs: lastTickTime ? Date.now() - lastTickTime : null,
    activeChecks,
    checkIntervalMs: CHECK_INTERVAL_MS,
  };
}

module.exports = { checkAndDispatchAlerts, getSchedulerStatus };

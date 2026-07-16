/**
 * plugins/threshold-alerts/index.js — Точка входа плагина «Пороговые уведомления»
 *
 * Lifecycle:
 *   1. schema(db)                 — создаёт таблицы alert_configs, alert_history
 *   2. registerRoutes(server, db) — регистрирует HTTP-эндпоинты /alerts/*
 *   3. hooks(db)                  — подписывается на flush (тик) + fallback-таймер
 */
'use strict';

const { initAlertTables } = require('./schema');
const { registerRoutes: registerConfigRoutes } = require('./config-crud');
const { checkAndDispatchAlerts, getSchedulerStatus } = require('./scheduler');

function schema(db) {
  initAlertTables(db);
}

function registerRoutes(server, db) {
  registerConfigRoutes(server, db);
}

function hooks(db) {
  if (global._thresholdAlertsHooksRegistered) {
    console.log('[threshold-alerts] hooks already registered, skipping');
    return;
  }
  global._thresholdAlertsHooksRegistered = true;

  // Встраиваемся в тот же общий хук flush, что использует reports —
  // не перезаписываем его, а дополняем.
  const existingOnFlush = global._pluginOnFlush;
  global._pluginOnFlush = () => {
    if (typeof existingOnFlush === 'function') existingOnFlush();
    checkAndDispatchAlerts(db).catch(() => {});
  };

  // Fallback-таймер: гарантирует проверку, даже если нет входящего трафика.
  setInterval(() => {
    checkAndDispatchAlerts(db).catch(() => {});
  }, 30 * 1000);

  console.log('[threshold-alerts] scheduler hooks registered (flush + 30s timer)');
}

module.exports = { schema, registerRoutes, hooks, getSchedulerStatus };

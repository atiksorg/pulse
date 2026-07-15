/**
 * plugins/kpi-alerts/index.js — Lifecycle for KPI/Gauge alerts plugin
 */
'use strict';

const { initAlertTables } = require('./schema');
const { registerRoutes: registerConfigRoutes } = require('./config-crud');
const { checkAlertRules, getCheckerStatus } = require('./checker');

function schema(db) {
  initAlertTables(db);
}

function registerRoutes(server, db) {
  registerConfigRoutes(server, db, {
    checkerStatus: getCheckerStatus,
  });
}

function hooks(db) {
  if (global._kpiAlertsHooksRegistered) {
    console.log('[kpi-alerts] hooks already registered, skipping');
    return;
  }

  global._kpiAlertsHooksRegistered = true;

  const existingOnFlush = global._pluginOnFlush;
  global._pluginOnFlush = () => {
    if (typeof existingOnFlush === 'function') {
      existingOnFlush();
    }
    checkAlertRules(db).catch(() => {});
  };

  setInterval(() => {
    checkAlertRules(db).catch(() => {});
  }, 60 * 1000);

  console.log('[kpi-alerts] checker hooks registered (flush + 1min timer)');
}

module.exports = {
  schema,
  registerRoutes,
  hooks
};

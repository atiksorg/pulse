/**
 * plugins/alert/index.js — Точка входа плагина «Уведомления»
 *
 * Lifecycle:
 *   1. schema(db)           — создаёт таблицы alert_configs, alert_history
 *   2. registerRoutes(server, db) — регистрирует HTTP-эндпоинты /alerts/*
 *   3. hooks(db)            — подписывается на flush (тик проверки) + fallback-таймер
 */
'use strict';

const { initAlertTables } = require('./schema');
const { registerRoutes: registerConfigRoutes } = require('./config-crud');
const { checkAndDispatchAlerts, getSchedulerStatus } = require('./scheduler');

/**
 * Миграции: создание таблиц.
 */
function schema(db) {
  initAlertTables(db);
}

/**
 * Регистрация HTTP-маршрутов.
 * Прокидываем schedulerStatus в deps, чтобы config-crud мог отдавать heartbeat.
 */
function registerRoutes(server, db) {
  registerConfigRoutes(server, db, {
    schedulerStatus: getSchedulerStatus,
  });
}

/**
 * Подписка на хуки.
 */
function hooks(db) {
  // Защита от двойной регистрации (если плагин грузится несколько раз —
  // например, два процесса Node или хот-релоад модуля).
  if (global._alertHooksRegistered) {
    console.log('[alert] hooks already registered, skipping');
    return;
  }
  global._alertHooksRegistered = true;

  // ── Хук flush: при каждом flush-событии проверяем пороги ──
  const existingOnFlush = global._pluginOnFlush;
  global._pluginOnFlush = () => {
    if (typeof existingOnFlush === 'function') existingOnFlush();
    checkAndDispatchAlerts(db).catch(() => {});
  };

  // ── Основной таймер: каждую минуту, независимо от трафика ──
  // Это гарантирует, что планировщик не пропустит окно проверки,
  // даже если нет входящих событий (flush не вызывается).
  setInterval(() => {
    checkAndDispatchAlerts(db).catch(() => {});
  }, 60 * 1000);

  console.log('[alert] scheduler hooks registered (flush + 1min timer)');
}

module.exports = { schema, registerRoutes, hooks };

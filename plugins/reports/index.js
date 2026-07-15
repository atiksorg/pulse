/**
 * plugins/reports/index.js — Точка входа плагина «Отчёты»
 *
 * Lifecycle:
 *   1. schema(db)           — создаёт таблицы report_configs, report_history
 *   2. registerRoutes(server, db) — регистрирует HTTP-эндпоинты /reports/*
 *   3. hooks(db)            — подписывается на flush (тик расписания) + fallback-таймер
 */
'use strict';

const { initReportTables } = require('./schema');
const { registerRoutes: registerConfigRoutes } = require('./config-crud');
const { dispatchReport } = require('./dispatcher');
const { checkAndDispatchReports } = require('./scheduler');

/**
 * Миграции: создание таблиц.
 */
function schema(db) {
  initReportTables(db);
}

/**
 * Регистрация HTTP-маршрутов.
 * Прокидываем dispatcher в deps, чтобы config-crud мог вызвать test-отправку.
 */
function registerRoutes(server, db) {
  registerConfigRoutes(server, db, { dispatcher: { dispatchReport } });
}

/**
 * Подписка на хуки.
 */
function hooks(db) {
  // ── Хук flush: при каждом flush-событии проверяем расписание ──
  const existingOnFlush = global._pluginOnFlush;
  global._pluginOnFlush = () => {
    if (typeof existingOnFlush === 'function') existingOnFlush();
    checkAndDispatchReports(db).catch(() => {});
  };

  // ── Основной таймер: каждую минуту, независимо от трафика ──
  // Это гарантирует, что планировщик не пропустит окно расписания,
  // даже если нет входящих событий (flush не вызывается).
  setInterval(() => {
    checkAndDispatchReports(db).catch(() => {});
  }, 60 * 1000);

  console.log('[reports] scheduler hooks registered (flush + 1min timer)');
}

module.exports = { schema, registerRoutes, hooks };

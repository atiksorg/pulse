/**
 * plugins/ai-copilot/index.js — Точка входа плагина «AI-копилот»
 *
 * Lifecycle:
 *   1. schema(db)           — создаёт таблицы ai_copilot_sessions, ai_copilot_messages
 *   2. registerRoutes(server, db) — регистрирует HTTP-эндпоинты /ai-copilot/*
 *   3. hooks(db)            — подписка на события (flush, таймер очистки)
 */
'use strict';

const { initCopilotTables } = require('./schema');
const { registerRoutes: registerCopilotRoutes } = require('./config-crud');

/**
 * Миграции: создание таблиц.
 */
function schema(db) {
  initCopilotTables(db);
}

/**
 * Регистрация HTTP-маршрутов.
 */
function registerRoutes(server, db) {
  registerCopilotRoutes(server, db);
}

/**
 * Подписка на хуки.
 */
function hooks(db) {
  // Защита от двойной регистрации
  if (global._copilotHooksRegistered) {
    console.log('[ai-copilot] hooks already registered, skipping');
    return;
  }
  global._copilotHooksRegistered = true;

  // ── Таймер очистки: удаляем сообщения старше 30 дней ──
  const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // раз в сутки
  setInterval(() => {
    try {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const r = db.prepare(
        'DELETE FROM ai_copilot_messages WHERE created_at < ?'
      ).run(cutoff);
      if (r.changes > 0) {
        console.log(`[ai-copilot] cleanup: removed ${r.changes} old messages`);
      }
      // Также удаляем сессии без сообщений (orphaned)
      db.prepare(`
        DELETE FROM ai_copilot_sessions
        WHERE id NOT IN (SELECT DISTINCT session_id FROM ai_copilot_messages)
        AND updated_at < ?
      `).run(cutoff);
    } catch (e) {
      console.error('[ai-copilot] cleanup error:', e.message);
    }
  }, CLEANUP_INTERVAL);

  console.log('[ai-copilot] hooks registered (cleanup timer)');
}

module.exports = { schema, registerRoutes, hooks };

/**
 * plugins/ai-copilot/schema.js — Миграции для AI-копилота
 *
 * Таблицы:
 *   ai_copilot_sessions — чат-сессии (привязаны к src)
 *   ai_copilot_messages — сообщения + tool-вызовы + подтверждения
 */
'use strict';

function initCopilotTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_copilot_sessions (
      id            TEXT PRIMARY KEY,
      src           TEXT NOT NULL,
      title         TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS 'idx_copilot_sessions_src'
      ON ai_copilot_sessions(src, updated_at DESC);

    CREATE TABLE IF NOT EXISTS ai_copilot_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      role          TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool_result')),
      content       TEXT NOT NULL DEFAULT '',
      tool_name     TEXT,
      tool_args     TEXT,
      tool_result   TEXT,
      status        TEXT NOT NULL DEFAULT 'done'
                    CHECK(status IN ('done', 'pending_confirmation', 'confirmed', 'rejected', 'error')),
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS 'idx_copilot_messages_session'
      ON ai_copilot_messages(session_id, id ASC);
    CREATE INDEX IF NOT EXISTS 'idx_copilot_messages_created'
      ON ai_copilot_messages(created_at);
  `);

  // Миграция v2: добавить copilot_metrics (если нужно в будущем)
  // Для v1 — только две таблицы выше.
}

module.exports = { initCopilotTables };

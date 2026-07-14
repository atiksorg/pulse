/**
 * plugins/reports/schema.js — Миграции таблиц для плагина «Отчёты»
 *
 * Создаёт:
 *   report_configs  — настройки отчёта (привязан к dashboard_id)
 *   report_history  — история отправок
 */
'use strict';

function initReportTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS report_configs (
      id                 TEXT PRIMARY KEY,
      dashboard_id       TEXT NOT NULL,
      src                TEXT NOT NULL,
      is_active          INTEGER DEFAULT 0,
      bot_id             INTEGER NOT NULL,
      bot_token          TEXT NOT NULL,
      function_id        INTEGER DEFAULT 697,
      prompt             TEXT NOT NULL DEFAULT '',
      size               TEXT DEFAULT '9:16',
      files_url          TEXT DEFAULT '',
      telegram_bot_token TEXT DEFAULT '',
      chat_ids           TEXT DEFAULT '',
      emails             TEXT DEFAULT '',
      schedule_type      TEXT NOT NULL DEFAULT 'daily',
      schedule_time      TEXT DEFAULT '09:00',
      schedule_days      TEXT DEFAULT '1,2,3,4,5',
      schedule_hours     INTEGER DEFAULT 0,
      timezone           TEXT DEFAULT 'UTC+03:00',
      last_sent_at       TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rc_dashboard ON report_configs(dashboard_id);
    CREATE INDEX IF NOT EXISTS idx_rc_src ON report_configs(src);
    CREATE INDEX IF NOT EXISTS idx_rc_active ON report_configs(is_active);

    CREATE TABLE IF NOT EXISTS report_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id       TEXT NOT NULL,
      dashboard_id    TEXT NOT NULL,
      src             TEXT NOT NULL,
      started_at      TEXT NOT NULL,
      finished_at     TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      image_url       TEXT,
      error_message   TEXT,
      trigger_type    TEXT DEFAULT 'schedule'
    );
    CREATE INDEX IF NOT EXISTS idx_rh_config ON report_history(config_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rh_src ON report_history(src, started_at DESC);
  `);
}

module.exports = { initReportTables };

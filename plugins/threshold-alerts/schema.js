/**
 * plugins/threshold-alerts/schema.js — Миграции таблиц для плагина «Пороговые уведомления»
 *
 * Создаёт:
 *   alert_configs  — правило проверки метрики (привязано к dashboard_id + panel_id)
 *   alert_history  — журнал срабатываний / отправок в Telegram
 */
'use strict';

function initAlertTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_configs (
      id                 TEXT PRIMARY KEY,
      dashboard_id       TEXT NOT NULL,
      panel_id           TEXT NOT NULL,
      src                TEXT NOT NULL,
      is_active          INTEGER DEFAULT 0,
      label              TEXT NOT NULL DEFAULT '',
      panel_type         TEXT DEFAULT '',
      panel_agg          TEXT DEFAULT 'count',
      panel_aggfield     TEXT DEFAULT '',
      panel_range        TEXT DEFAULT '24h',
      panel_filters      TEXT DEFAULT '[]',
      min_value          REAL,
      max_value          REAL,
      telegram_bot_token TEXT NOT NULL,
      chat_ids           TEXT NOT NULL DEFAULT '',
      check_interval_sec INTEGER NOT NULL DEFAULT 60,
      cooldown_sec        INTEGER NOT NULL DEFAULT 900,
      notify_on_recovery  INTEGER DEFAULT 1,
      state               TEXT NOT NULL DEFAULT 'ok',
      last_value          REAL,
      last_checked_at     TEXT,
      last_notified_at    TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ac_dashboard ON alert_configs(dashboard_id);
    CREATE INDEX IF NOT EXISTS idx_ac_panel ON alert_configs(panel_id);
    CREATE INDEX IF NOT EXISTS idx_ac_src ON alert_configs(src);
    CREATE INDEX IF NOT EXISTS idx_ac_active ON alert_configs(is_active);

    CREATE TABLE IF NOT EXISTS alert_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id     TEXT NOT NULL,
      dashboard_id  TEXT NOT NULL,
      src           TEXT NOT NULL,
      ts            TEXT NOT NULL,
      value         REAL,
      direction     TEXT,             -- 'above' | 'below' | 'recovered'
      status        TEXT NOT NULL,    -- 'sent' | 'error' | 'skipped'
      error_message TEXT,
      trigger_type  TEXT DEFAULT 'schedule'  -- 'schedule' | 'test'
    );
    CREATE INDEX IF NOT EXISTS idx_ah_config ON alert_history(config_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_ah_src ON alert_history(src, ts DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ac_panel_unique ON alert_configs(panel_id);
  `);
}

module.exports = { initAlertTables };

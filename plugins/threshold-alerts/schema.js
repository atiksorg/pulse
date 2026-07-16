/**
 * plugins/threshold-alerts/schema.js — Миграции таблиц для плагина «Пороговые уведомления»
 *
 * Создаёт:
 *   alert_configs  — правило проверки метрики (привязано к dashboard_id + panel_id)
 *   alert_history  — журнал срабатываний / отправок в Telegram
 */
'use strict';

function initAlertTables(db) {
  // ── Миграции: добавляем колонки, которых может не быть в уже созданных таблицах ──
  const migrations = [
    // alert_configs — все колонки, кроме PK (id, dashboard_id, panel_id, created_at, updated_at были в оригинале)
    `ALTER TABLE alert_configs ADD COLUMN src TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE alert_configs ADD COLUMN is_active INTEGER DEFAULT 0`,
    `ALTER TABLE alert_configs ADD COLUMN label TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE alert_configs ADD COLUMN panel_type TEXT DEFAULT ''`,
    `ALTER TABLE alert_configs ADD COLUMN panel_agg TEXT DEFAULT 'count'`,
    `ALTER TABLE alert_configs ADD COLUMN panel_aggfield TEXT DEFAULT ''`,
    `ALTER TABLE alert_configs ADD COLUMN panel_range TEXT DEFAULT '24h'`,
    `ALTER TABLE alert_configs ADD COLUMN panel_filters TEXT DEFAULT '[]'`,
    `ALTER TABLE alert_configs ADD COLUMN min_value REAL`,
    `ALTER TABLE alert_configs ADD COLUMN max_value REAL`,
    `ALTER TABLE alert_configs ADD COLUMN telegram_bot_token TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE alert_configs ADD COLUMN chat_ids TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE alert_configs ADD COLUMN check_interval_sec INTEGER NOT NULL DEFAULT 60`,
    `ALTER TABLE alert_configs ADD COLUMN cooldown_sec INTEGER NOT NULL DEFAULT 900`,
    `ALTER TABLE alert_configs ADD COLUMN notify_on_recovery INTEGER DEFAULT 1`,
    `ALTER TABLE alert_configs ADD COLUMN state TEXT NOT NULL DEFAULT 'ok'`,
    `ALTER TABLE alert_configs ADD COLUMN last_value REAL`,
    `ALTER TABLE alert_configs ADD COLUMN last_checked_at TEXT`,
    `ALTER TABLE alert_configs ADD COLUMN last_notified_at TEXT`,
    // alert_history — все колонки, кроме PK (id, config_id были в оригинале)
    `ALTER TABLE alert_history ADD COLUMN dashboard_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE alert_history ADD COLUMN src TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE alert_history ADD COLUMN ts TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE alert_history ADD COLUMN value REAL`,
    `ALTER TABLE alert_history ADD COLUMN direction TEXT`,
    `ALTER TABLE alert_history ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'`,
    `ALTER TABLE alert_history ADD COLUMN error_message TEXT`,
    `ALTER TABLE alert_history ADD COLUMN trigger_type TEXT DEFAULT 'schedule'`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
  }

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

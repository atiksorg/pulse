/**
 * plugins/kpi-alerts/schema.js — Migrations for alert_rules / alert_history
 */
'use strict';

function initAlertTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      dashboard_id              TEXT NOT NULL,
      src                       TEXT NOT NULL,
      panel_id                  TEXT NOT NULL,
      condition                 TEXT NOT NULL DEFAULT 'above',
      threshold                 REAL NOT NULL DEFAULT 0,
      cooldown_minutes          INTEGER NOT NULL DEFAULT 15,
      check_interval_minutes    INTEGER NOT NULL DEFAULT 5,
      telegram_bot_token        TEXT NOT NULL DEFAULT '',
      chat_ids                  TEXT NOT NULL DEFAULT '',
      message_template          TEXT NOT NULL DEFAULT '',
      is_active                 INTEGER NOT NULL DEFAULT 0,
      state                     TEXT NOT NULL DEFAULT 'ok',
      last_value                REAL,
      last_state_change_at      TEXT,
      last_sent_at              TEXT,
      created_at                TEXT NOT NULL,
      updated_at                TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_rules_dashboard ON alert_rules(dashboard_id);
    CREATE INDEX IF NOT EXISTS idx_alert_rules_src       ON alert_rules(src);
    CREATE INDEX IF NOT EXISTS idx_alert_rules_active    ON alert_rules(is_active);

    CREATE TABLE IF NOT EXISTS alert_history (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id           INTEGER NOT NULL,
      ts                TEXT NOT NULL,
      value             REAL,
      threshold         REAL,
      event_type        TEXT NOT NULL,
      delivery_status   TEXT NOT NULL DEFAULT 'pending',
      error             TEXT,
      attempt           INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_alert_history_rule   ON alert_history(rule_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_alert_history_status ON alert_history(ts DESC);
  `);

  // Migrations if schema grows later
  const cols = db.prepare('PRAGMA table_info(alert_rules)').all();
  const colNames = new Set(cols.map(c => c.name));

  if (!colNames.has('telegram_bot_token')) {
    db.exec("ALTER TABLE alert_rules ADD COLUMN telegram_bot_token TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.has('chat_ids')) {
    db.exec("ALTER TABLE alert_rules ADD COLUMN chat_ids TEXT NOT NULL DEFAULT ''");
  }
}

module.exports = {
  initAlertTables
};

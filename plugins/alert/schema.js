/**
 * plugins/alert/schema.js — Миграции таблиц для плагина «Уведомления» v2
 *
 * Создаёт:
 *   alert_rules     — N правил на панель, severity, FSM-состояния,
 *                      escalation policy, audit trail
 *   alert_history   — история срабатываний с FSM-фазами
 *   alert_silences  — ручное подавление алертов (silence на N часов)
 *   alert_queue     — персистентная очередь доставки с retry/backoff
 *
 * Миграции из v1:
 *   - alert_configs → alert_rules (перенос данных с новой схемой)
 *   - alert_history: добавление недостающих столбцов
 *   - удаление старого UNIQUE INDEX на panel_id
 */
'use strict';

function initAlertTables(db) {
  // ── 1. alert_rules — основная таблица правил ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id                    TEXT PRIMARY KEY,
      panel_id              TEXT,
      dashboard_id          TEXT NOT NULL,
      src                   TEXT NOT NULL,
      name                  TEXT DEFAULT '',

      -- Состояние (FSM): ok → pending → firing → resolved
      state                 TEXT NOT NULL DEFAULT 'ok',
      -- Счётчик последовательных срабатываний (anti-flapping)
      pending_count         INTEGER DEFAULT 0,
      -- Сколько последовательных срабатываний нужно для перехода pending→firing
      pending_threshold     INTEGER NOT NULL DEFAULT 1,
      -- Сколько последовательных «нормальных» нужно для перехода firing→resolved
      resolve_threshold     INTEGER NOT NULL DEFAULT 1,
      -- Счётчик последовательных «нормальных» значений
      resolve_count         INTEGER DEFAULT 0,

      -- Severity: info / warning / critical
      severity              TEXT NOT NULL DEFAULT 'warning',

      -- Активность
      is_active             INTEGER DEFAULT 1,

      -- Условие срабатывания
      condition             TEXT NOT NULL DEFAULT 'gt',
      threshold             REAL,
      threshold_min         REAL,
      threshold_max         REAL,

      -- Условие для no_data-алерта (секунды без событий)
      no_data_sec           INTEGER DEFAULT 0,

      -- Условие для rate_of_change (процент изменения за период)
      rate_of_change_pct    REAL DEFAULT 0,
      rate_of_change_window TEXT DEFAULT '',

      -- Периодичность проверки
      check_interval_sec    INTEGER NOT NULL DEFAULT 60,
      cooldown_min          INTEGER NOT NULL DEFAULT 30,

      -- Каналы доставки (JSON-массив объектов { type, ...params })
      channels              TEXT NOT NULL DEFAULT '[]',

      -- Escalation policy (JSON): [{ delay_min, channels }, ...]
      escalation_policy     TEXT NOT NULL DEFAULT '[]',

      -- Шаблон сообщения с плейсхолдерами
      message_template      TEXT DEFAULT '',

      -- Шаблон для resolve-уведомления (когда метрика вернулась в норму)
      resolve_template      TEXT DEFAULT '',

      -- Для обратной совместимости с v1: id старого конфига
      legacy_config_id      TEXT DEFAULT '',

      -- Состояние
      last_checked_at       TEXT,
      last_value            REAL,
      last_fired_at         TEXT,
      last_resolved_at      TEXT,

      -- Metadata
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ar_panel      ON alert_rules(panel_id);
    CREATE INDEX IF NOT EXISTS idx_ar_dashboard  ON alert_rules(dashboard_id);
    CREATE INDEX IF NOT EXISTS idx_ar_src        ON alert_rules(src);
    CREATE INDEX IF NOT EXISTS idx_ar_active     ON alert_rules(is_active);
    CREATE INDEX IF NOT EXISTS idx_ar_state      ON alert_rules(state);
    CREATE INDEX IF NOT EXISTS idx_ar_severity   ON alert_rules(severity);
  `);

  // ── 2. alert_history — расширенная история ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id         TEXT NOT NULL,
      panel_id        TEXT,
      dashboard_id    TEXT NOT NULL,
      src             TEXT NOT NULL,
      fired_at        TEXT NOT NULL,
      finished_at     TEXT,
      value           REAL,
      threshold       REAL,
      condition       TEXT,
      severity        TEXT DEFAULT 'warning',
      channel_type    TEXT DEFAULT 'telegram',
      status          TEXT NOT NULL DEFAULT 'pending',
      error_message   TEXT,
      duration_ms     INTEGER DEFAULT 0,
      trigger_type    TEXT DEFAULT 'auto',
      event_type      TEXT DEFAULT 'fire',
      phases          TEXT DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_ah_rule     ON alert_history(rule_id, fired_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ah_panel    ON alert_history(panel_id, fired_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ah_src      ON alert_history(src, fired_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ah_finished ON alert_history(finished_at);
    CREATE INDEX IF NOT EXISTS idx_ah_severity ON alert_history(severity);
    CREATE INDEX IF NOT EXISTS idx_ah_event    ON alert_history(event_type);
  `);

  // ── 3. alert_silences — подавление алертов ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_silences (
      id           TEXT PRIMARY KEY,
      rule_id      TEXT DEFAULT '',
      dashboard_id TEXT DEFAULT '',
      src          TEXT NOT NULL,
      reason       TEXT DEFAULT '',
      created_by   TEXT DEFAULT '',
      starts_at    TEXT NOT NULL,
      ends_at      TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_as_rule ON alert_silences(rule_id);
    CREATE INDEX IF NOT EXISTS idx_as_src  ON alert_silences(src);
    CREATE INDEX IF NOT EXISTS idx_as_end  ON alert_silences(ends_at);
  `);

  // ── 4. alert_queue — персистентная очередь доставки ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_queue (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id         TEXT NOT NULL,
      history_id      INTEGER NOT NULL,
      channel_type    TEXT NOT NULL DEFAULT 'telegram',
      channel_config  TEXT NOT NULL DEFAULT '{}',
      message_text    TEXT NOT NULL DEFAULT '',
      parse_mode      TEXT DEFAULT 'HTML',
      -- Для Telegram: chat_id
      target          TEXT NOT NULL DEFAULT '',
      -- Retry
      retry_count     INTEGER DEFAULT 0,
      max_retries     INTEGER DEFAULT 3,
      next_retry_at   TEXT NOT NULL,
      -- Status: pending / processing / done / failed
      status          TEXT NOT NULL DEFAULT 'pending',
      error_message   TEXT DEFAULT '',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aq_status ON alert_queue(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_aq_rule   ON alert_queue(rule_id);
  `);

  // ── 5. alert_audit — аудит изменений правил ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id     TEXT NOT NULL,
      action      TEXT NOT NULL,
      old_value   TEXT DEFAULT '{}',
      new_value   TEXT DEFAULT '{}',
      changed_by  TEXT DEFAULT '',
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aa_rule ON alert_audit(rule_id, created_at DESC);
  `);

  // ── Миграции из v1 ──
  _migrateFromV1(db);

  // ── Миграции столбцов (для существующих БД) ──
  _migrateColumns(db);

  // ── Cleanup: удаляем устаревшие таблицы/индексы ──
  _cleanupLegacy(db);
}

/**
 * Миграция данных из alert_configs → alert_rules.
 */
function _migrateFromV1(db) {
  // Проверяем, существует ли старая таблица alert_configs
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='alert_configs'"
  ).all();

  if (!tables.length) return; // Нет старой таблицы — нечего мигрировать

  // Проверяем, пуста ли alert_rules — если уже есть данные, миграция уже прошла
  const ruleCount = db.prepare('SELECT COUNT(*) as c FROM alert_rules').get().c;
  if (ruleCount > 0) {
    // Удаляем старую таблицу (данные уже перенесены)
    try {
      db.exec('DROP TABLE IF EXISTS alert_configs');
      console.log('[alert-schema] cleanup: dropped old alert_configs table');
    } catch (_) {}
    return;
  }

  // Переносим данные
  try {
    const oldConfigs = db.prepare('SELECT * FROM alert_configs').all();
    if (!oldConfigs.length) {
      db.exec('DROP TABLE IF EXISTS alert_configs');
      return;
    }

    const insertRule = db.prepare(`
      INSERT INTO alert_rules (
        id, panel_id, dashboard_id, src, name, state, severity,
        is_active, condition, threshold, threshold_min, threshold_max,
        check_interval_sec, cooldown_min, channels, message_template,
        last_checked_at, last_value, last_fired_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const migrateMany = db.transaction(() => {
      for (const old of oldConfigs) {
        insertRule.run(
          old.id,
          old.panel_id,
          old.dashboard_id,
          old.src,
          '',               // name
          old.is_active ? 'ok' : 'ok',  // state
          'warning',        // severity (default)
          old.is_active,
          old.condition,
          old.threshold,
          old.threshold_min,
          old.threshold_max,
          old.check_interval_sec,
          old.cooldown_min,
          old.channels,
          old.message_template,
          old.last_checked_at,
          old.last_value,
          old.last_fired_at,
          old.created_at,
          old.updated_at
        );
      }
    });

    migrateMany();

    // Перебрасываем history: старый config_id → новый rule_id
    // (в старой схеме config_id = id из alert_configs, в новой — rule_id = id из alert_rules)
    try {
      db.prepare(
        'UPDATE alert_history SET rule_id = config_id WHERE rule_id = "" OR rule_id IS NULL'
      ).run();
    } catch (_) {}

    console.log(`[alert-schema] migration: moved ${oldConfigs.length} config(s) from alert_configs → alert_rules`);
    db.exec('DROP TABLE IF EXISTS alert_configs');
  } catch (e) {
    console.error('[alert-schema] migration v1→v2 error:', e.message);
  }
}

/**
 * Миграция столбцов: добавляем новые, если их нет.
 */
function _migrateColumns(db) {
  // alert_rules
  const arCols = db.prepare("PRAGMA table_info(alert_rules)").all();
  const arNames = new Set(arCols.map(c => c.name));

  const arMigrations = [
    ['name',                 "ALTER TABLE alert_rules ADD COLUMN name TEXT DEFAULT ''"],
    ['pending_count',        "ALTER TABLE alert_rules ADD COLUMN pending_count INTEGER DEFAULT 0"],
    ['pending_threshold',    "ALTER TABLE alert_rules ADD COLUMN pending_threshold INTEGER NOT NULL DEFAULT 1"],
    ['resolve_threshold',    "ALTER TABLE alert_rules ADD COLUMN resolve_threshold INTEGER NOT NULL DEFAULT 1"],
    ['resolve_count',        "ALTER TABLE alert_rules ADD COLUMN resolve_count INTEGER DEFAULT 0"],
    ['severity',             "ALTER TABLE alert_rules ADD COLUMN severity TEXT NOT NULL DEFAULT 'warning'"],
    ['no_data_sec',          "ALTER TABLE alert_rules ADD COLUMN no_data_sec INTEGER DEFAULT 0"],
    ['rate_of_change_pct',   "ALTER TABLE alert_rules ADD COLUMN rate_of_change_pct REAL DEFAULT 0"],
    ['rate_of_change_window',"ALTER TABLE alert_rules ADD COLUMN rate_of_change_window TEXT DEFAULT ''"],
    ['escalation_policy',    "ALTER TABLE alert_rules ADD COLUMN escalation_policy TEXT NOT NULL DEFAULT '[]'"],
    ['resolve_template',     "ALTER TABLE alert_rules ADD COLUMN resolve_template TEXT DEFAULT ''"],
    ['legacy_config_id',     "ALTER TABLE alert_rules ADD COLUMN legacy_config_id TEXT DEFAULT ''"],
    ['last_resolved_at',     "ALTER TABLE alert_rules ADD COLUMN last_resolved_at TEXT"],
  ];

  for (const [col, sql] of arMigrations) {
    if (!arNames.has(col)) {
      try {
        db.exec(sql);
        console.log(`[alert-schema] migration: added alert_rules.${col}`);
      } catch (_) {}
    }
  }

  // alert_history: поддержка старого имени config_id → rule_id
  // (history может содержать config_id из v1)
  const ahCols = db.prepare("PRAGMA table_info(alert_history)").all();
  const ahNames = new Set(ahCols.map(c => c.name));

  const ahMigrations = [
    ['finished_at',  "ALTER TABLE alert_history ADD COLUMN finished_at TEXT"],
    ['severity',     "ALTER TABLE alert_history ADD COLUMN severity TEXT DEFAULT 'warning'"],
    ['event_type',   "ALTER TABLE alert_history ADD COLUMN event_type TEXT DEFAULT 'fire'"],
    ['rule_id',      "ALTER TABLE alert_history ADD COLUMN rule_id TEXT NOT NULL DEFAULT ''"],
  ];

  for (const [col, sql] of ahMigrations) {
    if (!ahNames.has(col)) {
      try {
        db.exec(sql);
        console.log(`[alert-schema] migration: added alert_history.${col}`);
      } catch (_) {}
    }
  }

  // Заполняем rule_id из config_id, если history была создана в v1
  try {
    if (ahNames.has('config_id') && !ahNames.has('rule_id')) {
      // rule_id уже добавили выше, копируем данные
    }
    // Безопасная миграция: если rule_id пуст — копируем из config_id
    db.prepare(
      "UPDATE alert_history SET rule_id = config_id WHERE (rule_id = '' OR rule_id IS NULL) AND config_id IS NOT NULL AND config_id != ''"
    ).run();
  } catch (_) {}
}

/**
 * Очистка устаревших объектов.
 */
function _cleanupLegacy(db) {
  // Удаляем UNIQUE INDEX на panel_id (v1) — в v2 допустимо N правил на панель
  try {
    const idx = db.prepare("PRAGMA index_list('alert_rules')").all();
    for (const i of idx) {
      if (i.name === 'idx_ac_panel_unique' && i.unique === 1) {
        db.exec('DROP INDEX IF EXISTS idx_ac_panel_unique');
        console.log('[alert-schema] migration: dropped UNIQUE INDEX idx_ac_panel_unique (v1)');
      }
    }
  } catch (_) {}
}

module.exports = { initAlertTables };

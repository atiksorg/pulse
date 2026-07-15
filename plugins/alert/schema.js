/**
 * plugins/alert/schema.js — Миграции таблиц для плагина «Уведомления»
 *
 * Создаёт:
 *   alert_configs   — настройки порогового уведомления (привязан к panel_id)
 *   alert_history   — история срабатываний
 *
 * ГИБКОСТЬ НА БУДУЩЕЕ:
 *   - channels: JSON-массив каналов. Сейчас поддерживается только telegram,
 *     но новые каналы (email/webhook/slack) добавляются без миграции.
 *   - condition: строка с оператором сравнения. Расширяется без миграции.
 *   - message_template: пользовательский шаблон с плейсхолдерами.
 */
'use strict';

function initAlertTables(db) {
  // ── 1. Создаём таблицы ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_configs (
      id                 TEXT PRIMARY KEY,
      panel_id           TEXT NOT NULL,
      dashboard_id       TEXT NOT NULL,
      src                TEXT NOT NULL,
      is_active          INTEGER DEFAULT 0,

      -- Условие срабатывания
      condition          TEXT NOT NULL DEFAULT 'gt',
      threshold          REAL,
      threshold_min      REAL,
      threshold_max      REAL,

      -- Периодичность
      check_interval_sec INTEGER NOT NULL DEFAULT 60,
      cooldown_min       INTEGER NOT NULL DEFAULT 30,

      -- Каналы (JSON-массив объектов { type, ...params })
      channels           TEXT NOT NULL DEFAULT '[]',

      -- Шаблон сообщения с плейсхолдерами {{value}} {{threshold}} и т.д.
      message_template   TEXT DEFAULT '',

      -- Состояние (для дедупликации и cooldown)
      last_checked_at    TEXT,
      last_value         REAL,
      last_fired_at      TEXT,

      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ac_panel      ON alert_configs(panel_id);
    CREATE INDEX IF NOT EXISTS idx_ac_dashboard  ON alert_configs(dashboard_id);
    CREATE INDEX IF NOT EXISTS idx_ac_src        ON alert_configs(src);
    CREATE INDEX IF NOT EXISTS idx_ac_active     ON alert_configs(is_active);

    CREATE TABLE IF NOT EXISTS alert_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id       TEXT NOT NULL,
      panel_id        TEXT NOT NULL,
      dashboard_id    TEXT NOT NULL,
      src             TEXT NOT NULL,
      fired_at        TEXT NOT NULL,
      value           REAL,
      threshold       REAL,
      condition       TEXT,
      channel_type    TEXT DEFAULT 'telegram',
      status          TEXT NOT NULL DEFAULT 'pending',
      error_message   TEXT,
      duration_ms     INTEGER DEFAULT 0,
      trigger_type    TEXT DEFAULT 'auto',
      phases          TEXT DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_ah_config ON alert_history(config_id, fired_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ah_panel  ON alert_history(panel_id, fired_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ah_src    ON alert_history(src, fired_at DESC);
  `);

  // ── 2. Миграции: добавляем новые столбцы если их нет ──
  const acCols = db.prepare("PRAGMA table_info(alert_configs)").all();
  const acNames = acCols.map(c => c.name);

  // На случай будущих миграций (пока все нужные поля создаются изначально,
  // но паттерн оставлен — потом добавим сюда ALTER TABLE блоки)
  if (!acNames.includes('message_template')) {
    db.exec(`ALTER TABLE alert_configs ADD COLUMN message_template TEXT DEFAULT ''`);
    console.log('[alert-schema] migration: added message_template column');
  }

  // ── 3. UNIQUE INDEX по panel_id (один конфиг на панель) ──
  // Защищает от дублей и позволяет использовать ON CONFLICT(panel_id) в PUT.
  try {
    const idx = db.prepare("PRAGMA index_list('alert_configs')").all();
    const hasUnique = idx.some(i => i.name === 'idx_ac_panel_unique' && i.unique === 1);
    if (!hasUnique) {
      db.exec(`DROP INDEX IF EXISTS idx_ac_panel`);
      db.exec(`CREATE UNIQUE INDEX idx_ac_panel_unique ON alert_configs(panel_id)`);
      console.log('[alert-schema] migration: created UNIQUE INDEX idx_ac_panel_unique');
    }
  } catch (e) {
    console.error('[alert-schema] unique index error:', e.message);
  }

  // ── 4. Дедупликация: убираем дубли по panel_id (на случай устаревших БД) ──
  try {
    const dupes = db.prepare(`
      SELECT panel_id, COUNT(*) as cnt
      FROM alert_configs
      GROUP BY panel_id
      HAVING cnt > 1
    `).all();

    if (dupes.length) {
      console.log(`[alert-schema] dedup: found ${dupes.length} panel(s) with duplicate configs`);
      for (const d of dupes) {
        // Берём самую свежую запись, остальные удаляем
        const rows = db.prepare(
          `SELECT id FROM alert_configs WHERE panel_id = ?
           ORDER BY updated_at DESC, created_at DESC`
        ).all(d.panel_id);
        const keepId = rows[0].id;
        const removeIds = rows.slice(1).map(r => r.id);
        if (removeIds.length) {
          const placeholders = removeIds.map(() => '?').join(',');
          // Перекидываем history на «главную» запись
          db.prepare(
            `UPDATE alert_history SET config_id = ? WHERE config_id IN (${placeholders})`
          ).run(keepId, ...removeIds);
          // Удаляем дубли
          db.prepare(
            `DELETE FROM alert_configs WHERE id IN (${placeholders})`
          ).run(...removeIds);
          console.log(`[alert-schema] dedup: panel ${d.panel_id} — kept ${keepId}, removed ${removeIds.length} duplicate(s)`);
        }
      }
    }
  } catch (e) {
    console.error('[alert-schema] dedup error:', e.message);
  }
}

module.exports = { initAlertTables };

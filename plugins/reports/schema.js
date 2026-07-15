/**
 * plugins/reports/schema.js — Миграции таблиц для плагина «Отчёты»
 *
 * Создаёт:
 *   report_configs  — настройки отчёта (привязан к dashboard_id)
 *   report_history  — история отправок
 */
'use strict';

function initReportTables(db) {
  // ── 1. Сначала создаём таблицы (если не существуют) ──
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

  // ── 2. Затем миграции: добавляем новые столбцы если их нет ──
  const columns = db.prepare("PRAGMA table_info(report_history)").all();
  const colNames = columns.map(c => c.name);

  if (!colNames.includes('phases')) {
    db.exec(`ALTER TABLE report_history ADD COLUMN phases TEXT DEFAULT '[]'`);
    console.log('[reports-schema] migration: added phases column to report_history');
  }

  if (!colNames.includes('duration_ms')) {
    db.exec(`ALTER TABLE report_history ADD COLUMN duration_ms INTEGER DEFAULT 0`);
    console.log('[reports-schema] migration: added duration_ms column to report_history');
  }

  // ── 3. Дедупликация: убираем «лишние» строки по dashboard_id ──
  // (оставляем самую свежую по updated_at; её id остаётся, старые удаляем)
  // Идемпотентно: после первого запуска дубли исчезают, повторно нечего удалять.
  try {
    const dupes = db.prepare(`
      SELECT dashboard_id, COUNT(*) as cnt
      FROM report_configs
      GROUP BY dashboard_id
      HAVING cnt > 1
    `).all();

    if (dupes.length) {
      console.log(`[reports-schema] dedup: found ${dupes.length} dashboard(s) with duplicate configs`);
      for (const d of dupes) {
        // Берём самую свежую запись (по updated_at DESC, потом created_at DESC)
        const rows = db.prepare(
          `SELECT id FROM report_configs WHERE dashboard_id = ?
           ORDER BY updated_at DESC, created_at DESC`
        ).all(d.dashboard_id);
        const keepId = rows[0].id;
        const removeIds = rows.slice(1).map(r => r.id);
        if (removeIds.length) {
          const placeholders = removeIds.map(() => '?').join(',');
          // Сначала перекидываем history на «главную» запись
          db.prepare(
            `UPDATE report_history SET config_id = ? WHERE config_id IN (${placeholders})`
          ).run(keepId, ...removeIds);
          // Затем удаляем дубли
          db.prepare(
            `DELETE FROM report_configs WHERE id IN (${placeholders})`
          ).run(...removeIds);
          console.log(`[reports-schema] dedup: dashboard ${d.dashboard_id} — kept ${keepId}, removed ${removeIds.length} duplicate(s)`);
        }
      }
    }
  } catch (e) {
    console.error('[reports-schema] dedup error:', e.message);
  }

  // ── 4. UNIQUE INDEX по dashboard_id (защита от дублей в будущем) ──
  // SQLite не поддерживает CREATE INDEX IF NOT EXISTS для UNIQUE,
  // поэтому проверяем через pragma.
  try {
    const idx = db.prepare("PRAGMA index_list('report_configs')").all();
    const hasUnique = idx.some(i => i.name === 'idx_rc_dashboard_unique' && i.unique === 1);
    if (!hasUnique) {
      // Удаляем старый не-уникальный индекс если он есть (создан в v1)
      db.exec(`DROP INDEX IF EXISTS idx_rc_dashboard`);
      db.exec(`CREATE UNIQUE INDEX idx_rc_dashboard_unique ON report_configs(dashboard_id)`);
      console.log('[reports-schema] migration: created UNIQUE INDEX idx_rc_dashboard_unique');
    }
  } catch (e) {
    console.error('[reports-schema] unique index error:', e.message);
  }
}

module.exports = { initReportTables };

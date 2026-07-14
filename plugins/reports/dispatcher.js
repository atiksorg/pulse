/**
 * plugins/reports/dispatcher.js — Отправка отчёта: XML → API → polling → логирование
 *
 * Ограничивает параллелизм (макс. 3 одновременных отправки),
 * логирует результат в report_history.
 */
'use strict';

const { generateDashboardXml } = require('./xml-generator');
const { runReportFunction }    = require('./api-client');

const MAX_PARALLEL = 3;
let activeDispatches = 0;

/**
 * Отправить отчёт по конфигу.
 * Если historyId передан — обновляет существующую запись.
 * Если нет — создаёт новую.
 *
 * @param {object} db      — better-sqlite3 Database
 * @param {object} config  — строка из report_configs
 * @param {number} [historyId] — ID записи в report_history (для test-отправки)
 */
async function dispatchReport(db, config, historyId) {
  if (activeDispatches >= MAX_PARALLEL) {
    console.warn('[reports-dispatch] max parallel reached, skipping');
    if (historyId) {
      db.prepare('UPDATE report_history SET status = ?, error_message = ?, finished_at = ? WHERE id = ?')
        .run('error', 'max_parallel_reached', new Date().toISOString(), historyId);
    }
    return;
  }

  activeDispatches++;

  // Создаём запись в истории если ещё нет
  if (!historyId) {
    historyId = db.prepare(
      `INSERT INTO report_history (config_id, dashboard_id, src, started_at, status, trigger_type)
       VALUES (?, ?, ?, ?, 'working', 'schedule')`
    ).run(
      config.id, config.dashboard_id, config.src,
      new Date().toISOString()
    ).lastInsertRowid;
  }

  try {
    // 1. Генерируем XML-снимок
    console.log(`[reports-dispatch] generating XML for dashboard ${config.dashboard_id}...`);
    const xml = await generateDashboardXml(db, config.dashboard_id);
    console.log(`[reports-dispatch] XML generated (${xml.length} chars)`);

    // 2. Отправляем во внешний API и ждём результата
    console.log(`[reports-dispatch] calling external API (bot_id=${config.bot_id}, func=${config.function_id || 697})...`);
    const result = await runReportFunction({
      bot_id:            config.bot_id,
      bot_token:         config.bot_token,
      function_id:       config.function_id || 697,
      data_xml:          xml,
      prompt:            config.prompt,
      size:              config.size,
      files_url:         config.files_url,
      telegram_bot_token: config.telegram_bot_token,
      chat_ids:          config.chat_ids,
      emails:            config.emails,
      onPoll: (status) => {
        // Обновляем статус в истории
        if (status === 'working') {
          // Не спамим обновлениями — только логируем
        }
      },
    });

    // 3. Успех — обновляем историю и last_sent_at
    db.prepare(
      'UPDATE report_history SET status = ?, image_url = ?, finished_at = ? WHERE id = ?'
    ).run('done', result.image_url || null, new Date().toISOString(), historyId);

    db.prepare('UPDATE report_configs SET last_sent_at = ? WHERE id = ?')
      .run(new Date().toISOString(), config.id);

    console.log(`[reports-dispatch] ✓ report done: ${config.dashboard_id} → ${result.image_url || '(no image)'}`);

  } catch (err) {
    // Ошибка — логируем, но НЕ откатываем last_sent_at (повтор в следующем окне)
    db.prepare(
      'UPDATE report_history SET status = ?, error_message = ?, finished_at = ? WHERE id = ?'
    ).run('error', String(err.message).slice(0, 500), new Date().toISOString(), historyId);

    console.error(`[reports-dispatch] ✗ report error: ${err.message}`);
  } finally {
    activeDispatches--;
  }
}

module.exports = { dispatchReport };

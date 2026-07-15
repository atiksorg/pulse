/**
 * plugins/reports/dispatcher.js — Отправка отчёта: XML → API → polling → логирование
 *
 * Ограничивает параллелизм (макс. 3 одновременных отправки),
 * логирует результат в report_history с фазами (phases JSON).
 */
'use strict';

const { generateDashboardXml } = require('./xml-generator');
const { runReportFunction }    = require('./api-client');

const MAX_PARALLEL = 3;
let activeDispatches = 0;

/**
 * Добавить фазу в phases JSON записи report_history.
 */
function appendPhase(db, historyId, phase, detail) {
  try {
    const row = db.prepare('SELECT phases FROM report_history WHERE id = ?').get(historyId);
    let phases = [];
    try { phases = JSON.parse(row.phases || '[]'); } catch (_) {}
    phases.push({
      phase,
      detail: detail || '',
      at: new Date().toISOString(),
    });
    db.prepare('UPDATE report_history SET phases = ? WHERE id = ?')
      .run(JSON.stringify(phases), historyId);
  } catch (_) {}
}

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

  const startTime = Date.now();

  try {
    // 1. Генерируем XML-снимок
    console.log(`[reports-dispatch] generating XML for dashboard ${config.dashboard_id}...`);
    appendPhase(db, historyId, 'xml_start', `dashboard=${config.dashboard_id}`);
    const xml = await generateDashboardXml(db, config.dashboard_id);
    const xmlSizeKB = (xml.length / 1024).toFixed(1);
    appendPhase(db, historyId, 'xml_generated', `${xmlSizeKB} KB, ${xml.length} chars`);
    console.log(`[reports-dispatch] XML generated (${xml.length} chars)`);

    // 2. Отправляем во внешний API и ждём результата
    console.log(`[reports-dispatch] calling external API (bot_id=${config.bot_id}, func=${config.function_id || 697})...`);
    appendPhase(db, historyId, 'api_call', `bot_id=${config.bot_id}, func=${config.function_id || 697}`);
    let pollCount = 0;
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
        pollCount++;
        if (status === 'working' && pollCount % 5 === 1) {
          appendPhase(db, historyId, 'polling', `poll #${pollCount}, status=${status}`);
        }
      },
    });
    appendPhase(db, historyId, 'api_done', `polls=${pollCount}, image=${result.image_url || 'none'}`);

    // 3. Успех — обновляем историю и last_sent_at
    const durationMs = Date.now() - startTime;
    db.prepare(
      'UPDATE report_history SET status = ?, image_url = ?, finished_at = ?, duration_ms = ? WHERE id = ?'
    ).run('done', result.image_url || null, new Date().toISOString(), durationMs, historyId);

    db.prepare('UPDATE report_configs SET last_sent_at = ? WHERE id = ?')
      .run(new Date().toISOString(), config.id);

    appendPhase(db, historyId, 'done', `total ${durationMs}ms`);
    console.log(`[reports-dispatch] ✓ report done: ${config.dashboard_id} → ${result.image_url || '(no image)'} (${durationMs}ms)`);

  } catch (err) {
    const durationMs = Date.now() - startTime;
    // Ошибка — логируем, но НЕ откатываем last_sent_at (повтор в следующем окне)
    db.prepare(
      'UPDATE report_history SET status = ?, error_message = ?, finished_at = ?, duration_ms = ? WHERE id = ?'
    ).run('error', String(err.message).slice(0, 500), new Date().toISOString(), durationMs, historyId);

    appendPhase(db, historyId, 'error', String(err.message).slice(0, 200));
    console.error(`[reports-dispatch] ✗ report error: ${err.message} (${durationMs}ms)`);
  } finally {
    activeDispatches--;
  }
}

/**
 * Получить количество текущих параллельных отправок.
 */
function getActiveDispatches() {
  return activeDispatches;
}

module.exports = { dispatchReport, getActiveDispatches };

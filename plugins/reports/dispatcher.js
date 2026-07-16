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
const MAX_QUEUE = 10;
let activeDispatches = 0;
const pendingQueue = []; // [{db, config, historyId}]

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
    if (pendingQueue.length >= MAX_QUEUE) {
      console.warn('[reports-dispatch] max parallel reached and queue full, dropping');
      if (historyId) {
        db.prepare('UPDATE report_history SET status = ?, error_message = ?, finished_at = ? WHERE id = ?')
          .run('error', 'queue_full', new Date().toISOString(), historyId);
      }
      return;
    }
    console.log(`[reports-dispatch] max parallel reached, queueing (pos ${pendingQueue.length + 1})`);
    if (historyId) {
      appendPhase(db, historyId, 'queued', `position=${pendingQueue.length + 1}`);
    }
    pendingQueue.push({ db, config, historyId });
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
    // 1. Генерируем XML-снимок (summary-режим: выжимка для рендерера картинки)
    console.log(`[reports-dispatch] generating XML for dashboard ${config.dashboard_id}...`);
    appendPhase(db, historyId, 'xml_start', `dashboard=${config.dashboard_id}`);
    const xml = await generateDashboardXml(db, config.dashboard_id, 'summary');
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

    // 3. Успех — обновляем историю. last_sent_at НЕ обновляем здесь:
    //    его уже поставил планировщик при атомарном захвате (см. scheduler.js).
    //    Повторное обновление в эту же секунду бесполезно и может
    //    затереть более свежее значение при гонке.
    const durationMs = Date.now() - startTime;
    db.prepare(
      'UPDATE report_history SET status = ?, image_url = ?, finished_at = ?, duration_ms = ? WHERE id = ?'
    ).run('done', result.image_url || null, new Date().toISOString(), durationMs, historyId);

    appendPhase(db, historyId, 'done', `total ${durationMs}ms`);
    console.log(`[reports-dispatch] ✓ report done: ${config.dashboard_id} → ${result.image_url || '(no image)'} (${durationMs}ms)`);

  } catch (err) {
    const durationMs = Date.now() - startTime;
    // Ошибка — логируем, но НЕ откатываем last_sent_at.
    // Повторная попытка (retry) — на стороне планировщика (scheduler.js),
    // который проверяет report_history на наличие ошибок за сегодня.
    db.prepare(
      'UPDATE report_history SET status = ?, error_message = ?, finished_at = ?, duration_ms = ? WHERE id = ?'
    ).run('error', String(err.message).slice(0, 500), new Date().toISOString(), durationMs, historyId);

    appendPhase(db, historyId, 'error', String(err.message).slice(0, 200));
    console.error(`[reports-dispatch] ✗ report error: ${err.message} (${durationMs}ms)`);
  } finally {
    activeDispatches--;
    processQueue();
  }
}

/**
 * Обработать очередь ожидающих отчётов (до MAX_PARALLEL слотов).
 */
function processQueue() {
  while (pendingQueue.length > 0 && activeDispatches < MAX_PARALLEL) {
    const next = pendingQueue.shift();
    console.log(`[reports-dispatch] dequeuing report for dashboard ${next.config.dashboard_id}`);
    dispatchReport(next.db, next.config, next.historyId)
      .catch(err => console.error('[reports-dispatch] queue dispatch error:', err.message));
  }
}

/**
 * Получить количество текущих параллельных отправок.
 */
function getActiveDispatches() {
  return activeDispatches;
}

/**
 * Получить длину очереди ожидающих отправки.
 */
function getQueueLength() {
  return pendingQueue.length;
}

module.exports = { dispatchReport, getActiveDispatches, getQueueLength };

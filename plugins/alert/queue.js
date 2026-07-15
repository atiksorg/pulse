/**
 * plugins/alert/queue.js — Управление персистентной очередью доставки
 *
 * Функции для enqueue/dequeue/обработки retry с exponential backoff.
 * Используется scheduler.js для обработки отложенных/неудачных отправок.
 */
'use strict';

/**
 * Поставить сообщение в очередь доставки.
 *
 * @param {object} db — better-sqlite3 Database
 * @param {object} opts — { ruleId, historyId, channelType, channelConfig, messageText, parseMode, target }
 * @returns {number} id записи в очереди
 */
function enqueue(db, opts) {
  const now = new Date().toISOString();
  const id = db.prepare(`
    INSERT INTO alert_queue (
      rule_id, history_id, channel_type, channel_config,
      message_text, parse_mode, target,
      retry_count, max_retries, next_retry_at,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 3, ?, 'pending', ?, ?)
  `).run(
    opts.ruleId || '',
    opts.historyId || 0,
    opts.channelType || 'telegram',
    typeof opts.channelConfig === 'string' ? opts.channelConfig : JSON.stringify(opts.channelConfig || {}),
    opts.messageText || '',
    opts.parseMode || 'HTML',
    opts.target || '',
    now,
    now,
    now
  ).lastInsertRowid;
  return id;
}

/**
 * Получить задачи ready к обработке (status=pending, next_retry_at <= now).
 *
 * @param {object} db
 * @param {number} limit
 * @returns {Array} массив записей из alert_queue
 */
function getPending(db, limit = 10) {
  const now = new Date().toISOString();
  return db.prepare(
    `SELECT * FROM alert_queue
     WHERE status = 'pending' AND next_retry_at <= ?
     ORDER BY id ASC
     LIMIT ?`
  ).all(now, limit);
}

/**
 * Атомарно захватить задачу (pending → processing).
 *
 * @param {object} db
 * @param {number} id
 * @returns {boolean} true если успешно захвачена
 */
function grabTask(db, id) {
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE alert_queue SET status = 'processing', updated_at = ?
     WHERE id = ? AND status = 'pending'`
  ).run(now, id);
  return result.changes === 1;
}

/**
 * Отметить задачу как выполненную.
 *
 * @param {object} db
 * @param {number} id
 */
function markDone(db, id) {
  db.prepare(
    `UPDATE alert_queue SET status = 'done', updated_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), id);
}

/**
 * Отметить задачу как окончательно провалившуюся (не будет retry).
 *
 * @param {object} db
 * @param {number} id
 * @param {string} errorMessage
 */
function markFailed(db, id, errorMessage) {
  db.prepare(
    `UPDATE alert_queue SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`
  ).run(String(errorMessage || '').slice(0, 500), new Date().toISOString(), id);
}

/**
 * Обработка неудачной отправки: вернуть в pending с exponential backoff,
 * или пометить как failed если retry_count >= max_retries.
 *
 * @param {object} db
 * @param {object} item — запись из alert_queue
 * @param {string} errorMessage
 * @returns {'retried'|'failed'}
 */
function handleFailure(db, item, errorMessage) {
  const retryCount = (item.retry_count || 0) + 1;
  const maxRetries = item.max_retries || 3;
  const now = new Date();

  if (retryCount >= maxRetries) {
    markFailed(db, item.id, errorMessage);
    return 'failed';
  }

  // Exponential backoff: 5s, 15s, 45s, 2.25m, 6.75m, ...
  const backoffMs = Math.min(300000, 5000 * Math.pow(3, retryCount));
  const nextRetryAt = new Date(now.getTime() + backoffMs).toISOString();

  db.prepare(
    `UPDATE alert_queue SET status = 'pending', retry_count = ?, next_retry_at = ?, error_message = ?, updated_at = ? WHERE id = ?`
  ).run(retryCount, nextRetryAt, String(errorMessage || '').slice(0, 500), now.toISOString(), item.id);
  return 'retried';
}

/**
 * Cleanup: удалить done-задачи старше cutoffMs и failed старше cutoffMs*3.
 *
 * @param {object} db
 * @param {number} cutoffMs — TTL для done (по умолчанию 1 час)
 */
function cleanup(db, cutoffMs = 3600000) {
  const now = Date.now();
  const doneCutoff = new Date(now - cutoffMs).toISOString();
  const failedCutoff = new Date(now - cutoffMs * 3).toISOString();
  try {
    db.prepare(`DELETE FROM alert_queue WHERE status = 'done' AND updated_at < ?`).run(doneCutoff);
    db.prepare(`DELETE FROM alert_queue WHERE status = 'failed' AND updated_at < ?`).run(failedCutoff);
  } catch (_) {}
}

/**
 * Получить статистику очереди.
 *
 * @param {object} db
 * @returns {{ pending: number, processing: number, done: number, failed: number }}
 */
function getStats(db) {
  try {
    const rows = db.prepare(
      `SELECT status, COUNT(*) as cnt FROM alert_queue GROUP BY status`
    ).all();
    const stats = { pending: 0, processing: 0, done: 0, failed: 0 };
    for (const r of rows) {
      if (stats.hasOwnProperty(r.status)) stats[r.status] = r.cnt;
    }
    return stats;
  } catch (_) {
    return { pending: 0, processing: 0, done: 0, failed: 0 };
  }
}

module.exports = {
  enqueue,
  getPending,
  grabTask,
  markDone,
  markFailed,
  handleFailure,
  cleanup,
  getStats,
};

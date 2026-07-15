const { dispatchMessage } = require('./dispatcher');

const MAX_RETRIES = 5;
const RETRY_DELAYS = [5000, 15000, 45000, 120000, 300000]; // 5s, 15s, 45s, 2m, 5m

let isProcessing = false;

/**
 * Восстановление зависших задач при старте сервера
 */
function recoverColdStart(db) {
    const info = db.prepare(`
        UPDATE alert_queue 
        SET status = 'pending' 
        WHERE status = 'processing'
    `).run();
    if (info.changes > 0) {
        console.log(`[Alert Queue] Recovered ${info.changes} stuck tasks from 'processing' to 'pending'`);
    }
}

/**
 * Очистка старых выполненных задач (GC)
 */
function garbageCollect(db) {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const info = db.prepare(`
        DELETE FROM alert_queue 
        WHERE status = 'done' AND updated_at < ?
    `).run(oneHourAgo);
    if (info.changes > 0) {
        console.log(`[Alert Queue] GC removed ${info.changes} old done tasks`);
    }
}

/**
 * Обработка очереди
 */
async function processQueue(db) {
    if (isProcessing) return;
    isProcessing = true;

    try {
        const now = Math.floor(Date.now() / 1000);
        
        // Берем задачи, которые pending или retry (и время пришло)
        // Ограничиваем LIMIT 10 для защиты от OOM
        const tasks = db.prepare(`
            SELECT * FROM alert_queue 
            WHERE (status = 'pending') OR (status = 'retry' AND next_retry_at <= ?)
            ORDER BY created_at ASC
            LIMIT 10
        `).all(now);

        for (const task of tasks) {
            // Атомарно переводим в processing
            const updateInfo = db.prepare(`
                UPDATE alert_queue 
                SET status = 'processing', updated_at = ? 
                WHERE id = ? AND status = ?
            `).run(now, task.id, task.status);

            if (updateInfo.changes === 0) continue; // Кто-то другой перехватил

            try {
                const config = JSON.parse(task.channel_config);
                await dispatchMessage(task.channel_type, config, task.message_text);
                
                // Успех
                db.prepare(`
                    UPDATE alert_queue 
                    SET status = 'done', updated_at = ? 
                    WHERE id = ?
                `).run(Math.floor(Date.now() / 1000), task.id);
                
            } catch (error) {
                // Ошибка
                const attempts = task.attempts + 1;
                if (attempts >= MAX_RETRIES) {
                    db.prepare(`
                        UPDATE alert_queue 
                        SET status = 'failed', attempts = ?, error_log = ?, updated_at = ? 
                        WHERE id = ?
                    `).run(attempts, error.message, Math.floor(Date.now() / 1000), task.id);
                } else {
                    const delayMs = RETRY_DELAYS[attempts - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
                    const nextRetryAt = Math.floor(Date.now() / 1000) + Math.floor(delayMs / 1000);
                    
                    db.prepare(`
                        UPDATE alert_queue 
                        SET status = 'retry', attempts = ?, next_retry_at = ?, error_log = ?, updated_at = ? 
                        WHERE id = ?
                    `).run(attempts, nextRetryAt, error.message, Math.floor(Date.now() / 1000), task.id);
                }
            }
        }
    } catch (e) {
        console.error('[Alert Queue] Error processing queue:', e);
    } finally {
        isProcessing = false;
    }
}

let queueInterval = null;
let gcInterval = null;

function startQueue(db) {
    recoverColdStart(db);
    
    // Проверка очереди каждую секунду
    queueInterval = setInterval(() => processQueue(db), 1000);
    
    // GC раз в час
    gcInterval = setInterval(() => garbageCollect(db), 3600 * 1000);
}

function stopQueue() {
    if (queueInterval) clearInterval(queueInterval);
    if (gcInterval) clearInterval(gcInterval);
}

function getQueueStats(db) {
    const stats = db.prepare(`
        SELECT status, COUNT(*) as count 
        FROM alert_queue 
        GROUP BY status
    `).all();
    
    const result = { pending: 0, processing: 0, retry: 0, done: 0, failed: 0 };
    for (const row of stats) {
        result[row.status] = row.count;
    }
    return result;
}

module.exports = {
    startQueue,
    stopQueue,
    getQueueStats
};

const { evaluateRule } = require('./evaluator');
const { processFSM } = require('./fsm');

let isRunning = false;
let schedulerInterval = null;

async function runSchedulerTick(db) {
    if (isRunning) return;
    isRunning = true;

    try {
        const now = Math.floor(Date.now() / 1000);

        // Выбираем правила, которые пора проверить
        const rules = db.prepare(`
            SELECT * FROM alert_rules 
            WHERE next_check_at <= ?
        `).all(now);

        for (const rule of rules) {
            // Атомарный захват (защита от гонки, если onFlush и setInterval сработают одновременно)
            const nextCheckAt = now + rule.check_interval_sec;
            const updateInfo = db.prepare(`
                UPDATE alert_rules 
                SET next_check_at = ? 
                WHERE id = ? AND next_check_at = ?
            `).run(nextCheckAt, rule.id, rule.next_check_at);

            if (updateInfo.changes === 0) continue; // Кто-то другой уже захватил

            try {
                // Вычисляем метрику
                const value = await evaluateRule(rule);
                
                // Пропускаем через FSM
                processFSM(rule, value, db);
            } catch (error) {
                console.error(`[Alert Scheduler] Error evaluating rule ${rule.id}:`, error);
            }
        }
    } catch (e) {
        console.error('[Alert Scheduler] Tick error:', e);
    } finally {
        isRunning = false;
    }
}

function startScheduler(db) {
    // Запускаем каждые 15 секунд
    schedulerInterval = setInterval(() => runSchedulerTick(db), 15000);
}

function stopScheduler() {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
    }
}

module.exports = {
    startScheduler,
    stopScheduler,
    runSchedulerTick
};

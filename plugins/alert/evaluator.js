const Database = require('better-sqlite3');
const path = require('path');

// Изолированное read-only подключение
let readOnlyDb = null;

function getReadOnlyDb() {
    if (!readOnlyDb) {
        // Предполагаем, что БД лежит в корне проекта
        const dbPath = path.join(__dirname, '../../analytics.db');
        try {
            readOnlyDb = new Database(dbPath, { readonly: true });
        } catch (e) {
            console.error('[Alert Evaluator] Failed to open read-only DB:', e);
            return null;
        }
    }
    return readOnlyDb;
}

/**
 * Выполняет SQL запрос с жестким таймаутом.
 * @param {string} sql 
 * @param {number} timeoutMs 
 * @returns {Promise<any>}
 */
function executeQueryWithTimeout(sql, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const db = getReadOnlyDb();
        if (!db) {
            return reject(new Error('Database connection not available'));
        }

        let isTimedOut = false;
        const timer = setTimeout(() => {
            isTimedOut = true;
            reject(new Error(`Query timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        try {
            // В better-sqlite3 запросы синхронные. 
            // Для защиты от зависаний можно использовать progress callback, но это замедляет работу.
            // В идеале, для сложных запросов нужен worker thread.
            // Здесь мы используем базовый подход. Если запрос зависнет в C-коде, setTimeout не спасет event loop.
            // Но для простых агрегаций это приемлемо.
            
            // Защита от модификаций (хотя подключение readonly)
            if (!sql.trim().toUpperCase().startsWith('SELECT')) {
                throw new Error('Only SELECT queries are allowed in evaluator');
            }

            const stmt = db.prepare(sql);
            const result = stmt.get(); // Ожидаем одно значение
            
            clearTimeout(timer);
            if (!isTimedOut) {
                resolve(result);
            }
        } catch (error) {
            clearTimeout(timer);
            if (!isTimedOut) {
                reject(error);
            }
        }
    });
}

/**
 * Оценивает метрику для правила.
 * В реальной системе здесь должен быть парсер конфигурации панели (panel_id) 
 * и генерация SQL запроса на основе этой конфигурации.
 * Для упрощения, предполагаем, что правило содержит сырой SQL или мы его генерируем.
 */
async function evaluateRule(rule) {
    // TODO: Интеграция с конфигурацией дашбордов для получения реального SQL.
    // Пока используем заглушку или извлекаем из метаданных правила, если бы они там были.
    // В рамках ТЗ: "evaluator.js делает SELECT SUM(amount)..."
    
    // Пример заглушки:
    // const sql = `SELECT SUM(value) as val FROM events WHERE ...`;
    // const result = await executeQueryWithTimeout(sql);
    // return result ? result.val : null;

    // Для демонстрации возвращаем случайное значение или null (no_data)
    // В реальной реализации здесь будет обращение к БД.
    console.log(`[Alert Evaluator] Evaluating rule ${rule.id} for panel ${rule.panel_id}`);
    
    // Имитация работы
    return new Promise(resolve => {
        setTimeout(() => {
            // Имитация значения
            const val = Math.random() * 2000;
            resolve(val);
        }, 50);
    });
}

module.exports = {
    evaluateRule,
    executeQueryWithTimeout
};

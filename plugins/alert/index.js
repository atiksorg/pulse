const schema = require('./schema');
const scheduler = require('./scheduler');
const queue = require('./queue');

// Routes теперь обрабатываются напрямую в events_server.js через plugins/alert/server-api.js
// Listener-wrapping паттерн из api.js убран — он ломал цепочку обработчиков при загрузке нескольких плагинов.

module.exports = {
    schema: schema.up,
    // registerRoutes НЕ экспортируем — маршруты /api/alerts/* зарегистрированы в events_server.js
    hooks: (db) => {
        // Запускаем фоновые процессы при инициализации плагина
        scheduler.startScheduler(db);
        queue.startQueue(db);
    }
};

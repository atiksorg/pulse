const schema = require('./schema');
const api = require('./api');
const scheduler = require('./scheduler');
const queue = require('./queue');

module.exports = {
    schema: schema.up,
    registerRoutes: api.registerRoutes,
    hooks: (db) => {
        // Запускаем фоновые процессы при инициализации плагина
        scheduler.startScheduler(db);
        queue.startQueue(db);
        
        // Можно добавить хук onFlush, если система поддерживает события
        // Например, если есть глобальный event emitter:
        // global.events.on('flush', () => scheduler.runSchedulerTick(db));
    }
};

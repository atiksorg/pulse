/**
 * analytics_worker.js — Worker Thread для тяжёлых SQL-запросов
 *
 * Запускается из основного потока (events_server.js) через worker_threads.
 * Открывает собственное read-only подключение к той же SQLite БД.
 * Принимает SQL-запросы через postMessage, выполняет их и возвращает результат.
 *
 * Это позволяет тяжёлым агрегациям (/s, /suggestions) не блокировать
 * основной event loop — запись событий (/e) продолжается без задержек.
 */
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

const DB_PATH = workerData && workerData.dbPath ? workerData.dbPath : './events.db';

// Read-only подключение — воркер не пишет, только читает
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('journal_mode = WAL');
db.pragma('cache_size = -32000'); // 32 МБ кэш
db.pragma('temp_store = MEMORY');

if (parentPort) {
  parentPort.on('message', (msg) => {
    const { id, sql, params } = msg;
    try {
      const rows = db.prepare(sql).all(...(params || []));
      parentPort.postMessage({ id, ok: true, rows });
    } catch (e) {
      parentPort.postMessage({ id, ok: false, error: e.message });
    }
  });

  parentPort.postMessage({ type: 'ready' });
}

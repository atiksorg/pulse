/**
 * Events Analytics Server
 * URL: http://events.atiks.org
 * 
 * Endpoints:
 *   GET  /health        — быстрая проверка здоровья
 *   GET  /status        — расширенный мониторинг состояния
 *   GET  /e             — запись события (query params)
 *   POST /e             — запись события (JSON body)
 *   POST /e/batch       — пакетная запись событий
 *   GET  /s             — статистика и агрегации
 *   GET  /export        — экспорт в CSV
 */
const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const Database = require('better-sqlite3');
const auth = require('./auth');
const ai = require('./ai');

// ── Настройки ──────────────────────────────────────────
const PORT                = process.env.PORT              || 3333;
const DB_PATH             = process.env.DB_PATH           || './events.db';
const BATCH_SIZE          = process.env.BATCH_SIZE         ? Number(process.env.BATCH_SIZE)         : 200;
const BATCH_INTERVAL_MS   = process.env.BATCH_INTERVAL_MS  ? Number(process.env.BATCH_INTERVAL_MS)  : 1500;
const RETENTION_MONTHS    = process.env.RETENTION_MONTHS   ? Number(process.env.RETENTION_MONTHS)   : 6;
const ALLOWED_SRC         = new Set((process.env.ALLOWED_SRC || '').split(',').filter(Boolean));
const MAX_PAYLOAD_LENGTH  = process.env.MAX_PAYLOAD_LENGTH ? Number(process.env.MAX_PAYLOAD_LENGTH) : 10000;
const STATUS_TOKEN        = process.env.STATUS_TOKEN || '';
const MAX_BODY_SIZE       = 1024 * 1024; // 1 МБ
const MAX_BATCH_EVENTS    = 1000;
const MAX_EXPORT_ROWS     = 100000;
const CLEANUP_INTERVAL_MS = 86400000; // раз в сутки
const IDENT_RE            = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const BODY_TIMEOUT_MS     = 10000; // 10 сек на чтение тела — защита от Slowloris
const DEFAULT_GROUP_LIMIT = 500;   // лимит групп по умолчанию, если не указан
const FLUSH_FAIL_THRESHOLD = 5;    // после N подряд ошибок flush — сброс буфера
const BUFFER_HARD_LIMIT   = 50000; // жёсткий лимит буфера — после него 429
const ANALYZE_INTERVAL_MS = 3600000; // раз в час — обновление статистики SQLite
const TRUST_PROXY         = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';
const STATS_CACHE_TTL_MS  = 5000;   // TTL кэша /s-агрегаций (5 сек)
const WAL_CHECKPOINT_MS   = 300000; // WAL checkpoint PASSIVE каждые 5 минут
// ───────────────────────────────────────────────────────

// Инициализация БД
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous  = NORMAL');
db.pragma('cache_size   = -64000');
db.pragma('temp_store   = MEMORY');

// Глобальное состояние
const buffer = [];
const stmts = new Map();
const knownTables = new Set();
let lastFlushTime = Date.now();
let lastAdaptiveCheck = Date.now();
let eventsSinceLastCheck = 0;
let flushFailCount = 0;

// ── Stats cache (in-memory, invalidated on flush) ──
const _statsCache = new Map();
let _statsCacheGen = 0; // incremented on each flush

// ── Пул воркеров для тяжёлых аналитических запросов ──
const WORKER_COUNT = Math.max(1, (process.env.WORKER_COUNT ? Number(process.env.WORKER_COUNT) : Math.min(os.cpus().length - 1, 4)));
const workers = [];
const workerQueue = []; // очередь запросов, ожидающих свободного воркера
let workerMsgId = 0;

function setupWorkerHandlers(worker, index) {
  worker._busy = false;
  worker._pending = new Map();

  worker.on('message', (msg) => {
    if (msg.type === 'ready') {
      console.log(`[worker ${index}] ready`);
      return;
    }
    if (msg.id !== undefined && worker._pending.has(msg.id)) {
      const { resolve, reject } = worker._pending.get(msg.id);
      worker._pending.delete(msg.id);
      if (msg.ok) resolve(msg.rows);
      else reject(new Error(msg.error));
    }
    // Воркер освободился — проверяем очередь
    worker._busy = false;
    processWorkerQueue();
  });

  worker.on('error', (e) => {
    console.error(`[worker ${index}] crashed:`, e.message);
    // Отклоняем все ожидающие запросы
    for (const [, { reject }] of worker._pending) {
      reject(new Error('worker crashed'));
    }
    worker._pending.clear();
    worker._busy = false;
    // Перезапускаем упавший воркер через 1 секунду
    setTimeout(() => {
      try { worker.terminate(); } catch (_) {}
      recreateWorker(index);
    }, 1000);
  });
}

function recreateWorker(index) {
  console.log(`[worker-pool] recreating worker ${index}`);
  const worker = new Worker(path.join(__dirname, 'analytics_worker.js'), {
    workerData: { dbPath: DB_PATH }
  });
  setupWorkerHandlers(worker, index);
  workers[index] = worker;
}

function initWorkerPool() {
  for (let i = 0; i < WORKER_COUNT; i++) {
    const worker = new Worker(path.join(__dirname, 'analytics_worker.js'), {
      workerData: { dbPath: DB_PATH }
    });
    setupWorkerHandlers(worker, i);
    workers.push(worker);
  }
}

function processWorkerQueue() {
  if (workerQueue.length === 0) return;
  const freeWorker = workers.find(w => !w._busy);
  if (!freeWorker) return;
  const { sql, params, resolve, reject } = workerQueue.shift();
  freeWorker._busy = true;
  const id = ++workerMsgId;
  freeWorker._pending.set(id, { resolve, reject });
  freeWorker.postMessage({ id, sql, params });
}

function workerQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    const freeWorker = workers.find(w => !w._busy);
    if (freeWorker) {
      freeWorker._busy = true;
      const id = ++workerMsgId;
      freeWorker._pending.set(id, { resolve, reject });
      freeWorker.postMessage({ id, sql, params });
    } else {
      // Нет свободного воркера — ставим в очередь
      workerQueue.push({ sql, params, resolve, reject });
    }
  });
}

// ── Утилиты ────────────────────────────────────────────
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function normalizeIp(ip) {
  if (!ip) return null;
  return ip.replace(/^::ffff:/, '');
}

// ── Определение IP с учётом reverse-proxy ──────────
// Если перед Node.js нет доверенного прокси (Nginx/Cloudflare), 
// X-Forwarded-For может быть подделан клиентом. 
// TRUST_PROXY=true — доверяем заголовку (прокси перезаписывает его).
// TRUST_PROXY=false (по умолчанию) — приоритет req.socket.remoteAddress.
function getClientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }
  }
  return normalizeIp(req.socket.remoteAddress);
}

function safeField(name) {
  return IDENT_RE.test(name) ? name : null;
}

function readBody(req, limit = MAX_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        req.destroy();
        reject(new Error('body timeout'));
      }
    }, BODY_TIMEOUT_MS);

    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error('body too large'));
        }
        return;
      }
      body += c;
    });
    req.on('end', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve(body);
      }
    });
    req.on('error', e => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        reject(e);
      }
    });
  });
}

function getTableName(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `events_${y}_${m}`;
}

function initKnownTables() {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%'"
  ).all();
  for (const t of tables) knownTables.add(t.name);
}

function ensureTable(tableName) {
  if (knownTables.has(tableName)) return tableName;
  db.exec(`
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      TEXT    NOT NULL,
      src     TEXT    NOT NULL,
      type    TEXT    NOT NULL,
      payload TEXT    NOT NULL DEFAULT '{}',
      ip      TEXT,
      ua      TEXT
    );
    CREATE INDEX IF NOT EXISTS "idx_${tableName}_src_ts" ON "${tableName}"(src, ts DESC);
    CREATE INDEX IF NOT EXISTS "idx_${tableName}_type"   ON "${tableName}"(src, type);
  `);
  knownTables.add(tableName);
  return tableName;
}

function getInsertStmt(tableName) {
  if (!stmts.has(tableName)) {
    stmts.set(tableName, db.prepare(
      `INSERT INTO "${tableName}" (ts, src, type, payload, ip, ua) VALUES (?, ?, ?, ?, ?, ?)`
    ));
  }
  return stmts.get(tableName);
}

function safeJsonString(str) {
  try { JSON.parse(str); return true; } catch (_) { return false; }
}

function parsePayload(qs) {
  const reserved = new Set(['src', 'type']);
  const payload = {};
  for (const [k, v] of Object.entries(qs)) {
    if (reserved.has(k)) continue;
    const num = Number(v);
    payload[k] = v !== '' && !isNaN(num) ? num : v;
  }
  return JSON.stringify(payload);
}

// ── Filter helpers for /s ──────────────────────────────
const MAX_FILTERS = 5;
const MAX_IN_VALUES = 20;
const ALLOWED_FILTER_OPS = ['eq', 'neq', 'gt', 'lt', 'in', 'contains'];
const ALLOWED_SORT_MODES = ['key', 'value_desc', 'value_asc'];

function parseFiltersParam(filtersStr) {
  if (!filtersStr) return [];
  let arr;
  try { arr = JSON.parse(filtersStr); } catch (_) { return null; }
  if (!Array.isArray(arr)) return null;
  if (arr.length > MAX_FILTERS) return null;
  const result = [];
  for (const f of arr) {
    if (!f || typeof f !== 'object') return null;
    if (typeof f.field !== 'string' || !f.field.trim()) return null;
    const field = safeField(f.field.trim());
    if (!field) return null;
    const op = String(f.op || '').toLowerCase();
    if (!ALLOWED_FILTER_OPS.includes(op)) return null;
    let value = f.value;
    if (op === 'in') {
      if (!Array.isArray(value)) return null;
      if (value.length > MAX_IN_VALUES) return null;
      value = value.map(v => String(v));
    } else if (op === 'gt' || op === 'lt') {
      value = Number(value);
      if (isNaN(value)) return null;
    } else if (op === 'contains') {
      value = String(value);
      if (value.length > 200) return null;
    } else {
      value = String(value);
    }
    result.push({ field, op, value });
  }
  return result;
}

function buildFilterWhereClauses(filters, params) {
  const clauses = [];
  for (const f of filters) {
    const col = `json_extract(payload, '$."${f.field}"')`;
    if (f.op === 'eq') {
      clauses.push(`(${col} = ? OR ${col} = ?)`);
      params.push(f.value, String(f.value));
    } else if (f.op === 'neq') {
      clauses.push(`(${col} != ? OR ${col} IS NULL OR ${col} = '')`);
      params.push(String(f.value));
    } else if (f.op === 'gt') {
      clauses.push(`CAST(${col} AS REAL) > ?`);
      params.push(f.value);
    } else if (f.op === 'lt') {
      clauses.push(`CAST(${col} AS REAL) < ?`);
      params.push(f.value);
    } else if (f.op === 'in') {
      if (f.value.length === 0) {
        clauses.push('1 = 0');
      } else {
        const placeholders = f.value.map(() => '?').join(',');
        clauses.push(`${col} IN (${placeholders})`);
        params.push(...f.value);
      }
    } else if (f.op === 'contains') {
      clauses.push(`${col} LIKE ?`);
      params.push('%' + f.value + '%');
    }
  }
  return clauses;
}

function applyFiltersToValue(fieldValue, f) {
  if (fieldValue === null || fieldValue === undefined) return f.op === 'neq';
  const sv = String(fieldValue);
  if (f.op === 'eq') return sv === f.value || sv === String(f.value);
  if (f.op === 'neq') return sv !== f.value && sv !== String(f.value);
  if (f.op === 'gt') return Number(sv) > f.value;
  if (f.op === 'lt') return Number(sv) < f.value;
  if (f.op === 'in') return f.value.includes(sv);
  if (f.op === 'contains') return sv.includes(f.value);
  return true;
}

function applyFiltersToPayload(payloadStr, filters) {
  let pl;
  try { pl = JSON.parse(payloadStr); } catch (_) { return false; }
  for (const f of filters) {
    if (!applyFiltersToValue(pl[f.field], f)) return false;
  }
  return true;
}

function filterTablesByDate(tables, from, to) {
  if (!from && !to) return tables;
  let minTable = null;
  let maxTable = null;
  if (from && from.length >= 7) {
    minTable = `events_${from.slice(0, 4)}_${from.slice(5, 7)}`;
  }
  if (to && to.length >= 7) {
    maxTable = `events_${to.slice(0, 4)}_${to.slice(5, 7)}`;
  }
  return tables.filter(t => {
    if (minTable && t.name < minTable) return false;
    if (maxTable && t.name > maxTable) return false;
    return true;
  });
}

function applySortAndLimit(groups, sort, limit, responseGroupKey) {
  // Sort
  if (sort === 'value_desc') {
    groups.sort((a, b) => (b.value || 0) - (a.value || 0));
  } else if (sort === 'value_asc') {
    groups.sort((a, b) => (a.value || 0) - (b.value || 0));
  } else {
    // sort === 'key' (default).
    // ВАЖНО: явно пересортируем объединённый массив groups по ключу группы.
    // Нельзя полагаться на SQL ORDER BY: данные мержатся из буфера (вставляется
    // первым, до обхода таблиц) + из нескольких помесячных таблиц (каждая
    // таблица сортируется в своём SQL-запросе, но результаты разных таблиц
    // просто накапливаются в общий объект в порядке обхода, а не
    // пересортировываются вместе). Без финального .sort() порядок точек
    // на line-графиках по дням/часам может быть перепутан, особенно при
    // наличии несброшенного буфера или данных за несколько месяцев.
    groups.sort((a, b) => {
      const ak = String(a[responseGroupKey] ?? '');
      const bk = String(b[responseGroupKey] ?? '');
      // Лексикографическое сравнение корректно работает для ISO-дат ('YYYY-MM-DD'),
      // для 'YYYY-MM-DD HH:00', и для строковых значений произвольных полей.
      // Для чисел (если payload-поле хранит число) сравниваем как числа,
      // чтобы '10' шло после '2' а не после '1' (порядок '2' < '10' верный
      // и для чисел, и для строк — но '2' < '10' только при числовом сравнении).
      const an = Number(ak);
      const bn = Number(bk);
      if (!isNaN(an) && !isNaN(bn) && ak !== '' && bk !== '') {
        return an - bn;
      }
      return ak.localeCompare(bk);
    });
  }

  // Limit (after sort)
  if (limit && limit > 0 && groups.length > limit) {
    groups.length = limit;
  }
}

function cleanupOldTables() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
  const keepTable = getTableName(cutoff);

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%'"
  ).all();

  for (const { name } of tables) {
    if (name < keepTable) {
      db.exec(`DROP TABLE IF EXISTS "${name}"`);
      stmts.delete(name);
      knownTables.delete(name);
      console.log(`[cleanup] dropped ${name}`);
    }
  }
}

// ── Batch-запись ───────────────────────────────────────
function flush() {
  if (buffer.length === 0) return;
  const batch = buffer.slice();
  try {
    const tableName = ensureTable(getTableName());
    const insertStmt = getInsertStmt(tableName);
    const insertMany = db.transaction((rows) => {
      for (const r of rows) {
        if (r.payload.length > MAX_PAYLOAD_LENGTH) r.payload = '{}';
        if (!safeJsonString(r.payload)) r.payload = '{}';
        insertStmt.run(r.ts, r.src, r.type, r.payload, r.ip, r.ua);
      }
    });    insertMany(batch);
    buffer.splice(0, batch.length); // Удаляем только успешно записанные
    lastFlushTime = Date.now();
    flushFailCount = 0;
    _statsCache.clear(); // Инвалидируем кэш статистики после записи
    _statsCacheGen++;
    truncateBufferWAL(); // Очищаем WAL-лог после успешной записи в БД
  } catch (e) {
    console.error('[flush] error:', e.message);
    flushFailCount++;
    // Если flush падает N раз подряд — сбрасываем буфер, чтобы не переполнить память
    if (flushFailCount >= FLUSH_FAIL_THRESHOLD) {
      console.error(`[flush] ${flushFailCount} consecutive failures — dropping buffer (${buffer.length} events)`);
      buffer.length = 0;
      flushFailCount = 0;
      lastFlushTime = Date.now();
    }
  }
}

function adaptiveFlush() {
  const now = Date.now();
  const dt = Math.max(1, now - lastAdaptiveCheck);
  const ratePerSec = (eventsSinceLastCheck * 1000) / dt;
  lastAdaptiveCheck = now;
  eventsSinceLastCheck = 0;

  const dynamicInterval = Math.max(100, Math.min(5000,
    BATCH_SIZE / Math.max(1, ratePerSec) * 1000
  ));

  const timeSinceLastFlush = now - lastFlushTime;
  if (buffer.length >= BATCH_SIZE ||
      (buffer.length > 0 && timeSinceLastFlush > dynamicInterval)) {
    flush();
  }
}

// ── Crash Recovery (WAL для буфера) ─────────────────
// Лёгкий append-only лог на диске: события пишутся перед добавлением в buffer,
// очищаются после успешного flush(). При старте сервера лог восстанавливается.
//
// ВАЖНО: Не удерживаем постоянный файловый дескриптор (walFd). Раньше
// fs.openSync('a') + fs.truncateSync(path, 0) приводили к битым смещениям:
// ОС кэшировала позицию записи в дескрипторе, truncate сбрасывал файл на диске,
// но дескриптор об этом не знал → следующая запись шла по старому смещению,
// заполняя начало файла нулевыми байтами → JSON.parse падал при восстановлении.
// Теперь пишем напрямую по пути — fs.appendFileSync(WAL_PATH, ...) каждый раз
// открывает и закрывает файл, а truncate заменён на writeFileSync(WAL_PATH, '').
const WAL_PATH = DB_PATH + '.walbuf';

function initBufferWAL() {
  // Просто проверяем доступность записи при старте
  try {
    fs.appendFileSync(WAL_PATH, '');
  } catch (e) {
    console.error('[walbuf] init error:', e.message);
  }
}

function writeBufferWAL(event) {
  try {
    fs.appendFileSync(WAL_PATH, JSON.stringify(event) + '\n');
  } catch (_) {}
}

function truncateBufferWAL() {
  try {
    fs.writeFileSync(WAL_PATH, '');
  } catch (_) {}
}

function recoverBufferWAL() {
  try {
    if (!fs.existsSync(WAL_PATH)) return;
    const data = fs.readFileSync(WAL_PATH, 'utf8');
    if (!data || !data.trim()) return;
    const lines = data.split('\n').filter(Boolean);
    let recovered = 0;
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev && ev.src && ev.type) {
          buffer.push(ev);
          recovered++;
        }
      } catch (_) {}
    }
    if (recovered > 0) {
      console.log(`[walbuf] recovered ${recovered} events from crash recovery log`);
    }
    // Очищаем после восстановления
    truncateBufferWAL();
  } catch (e) {
    console.error('[walbuf] recovery error:', e.message);
  }
}

// ── Сервер ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);    // Health — лёгкая проверка, без COUNT(*) по таблицам
    if (url.pathname === '/health') {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%'"
      ).all();      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        uptime: process.uptime(),
        buffer_size: buffer.length,
        tables: tables.length,
        last_flush_ms_ago: Date.now() - lastFlushTime,
        server_time: new Date().toISOString()
      }));
      return;
    }

    // GET /status — расширенный мониторинг состояния (требует токен если задан)
    if (url.pathname === '/status' && req.method === 'GET') {
      if (STATUS_TOKEN) {
        const auth = req.headers['authorization'] || url.searchParams.get('token') || '';
        const token = auth.replace(/^Bearer\s+/i, '');
        if (token !== STATUS_TOKEN) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'forbidden — set Authorization: Bearer <token> or ?token=' }));
          return;
        }
      }
      const memUsage = process.memoryUsage();
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%' ORDER BY name"
      ).all();

      // Оценка количества событий через метаданные SQLite (быстро, без fullscan)
      let totalEvents = 0;
      const tableStats = [];
      for (const { name } of tables) {
        try {
          // sqlite_stat1 хранит примерное количество строк (если ANALYZE запускался)
          // Если статистики нет — используем max(rowid) как быструю оценку
          const row = db.prepare(`SELECT MAX(rowid) as max_id FROM "${name}"`).get();
          const approx = row && row.max_id ? row.max_id : 0;
          totalEvents += approx;
          tableStats.push({ table: name, approx_count: approx });
        } catch (e) {
          tableStats.push({ table: name, error: e.message });
        }
      }

      const diskUsage = db.prepare("PRAGMA page_count").get();
      const pageSize = db.prepare("PRAGMA page_size").get();
      const dbSize = (diskUsage.page_count * pageSize.page_size) / (1024 * 1024);

      const status = {
        service: 'events-analytics',
        url: 'http://events.atiks.org',
        uptime: process.uptime(),
        uptime_human: formatUptime(process.uptime()),
        memory: {
          rss_mb: (memUsage.rss / 1024 / 1024).toFixed(2),
          heap_used_mb: (memUsage.heapUsed / 1024 / 1024).toFixed(2),
          heap_total_mb: (memUsage.heapTotal / 1024 / 1024).toFixed(2),
          external_mb: (memUsage.external / 1024 / 1024).toFixed(2)
        },
        database: {
          path: DB_PATH,
          size_mb: dbSize.toFixed(2),
          tables_count: tables.length,
          total_events: totalEvents,
          table_details: tableStats
        },        performance: {
          buffer_size: buffer.length,
          buffer_hard_limit: BUFFER_HARD_LIMIT,
          backpressure_active: buffer.length >= BUFFER_HARD_LIMIT,
          batch_size: BATCH_SIZE,
          batch_interval_ms: BATCH_INTERVAL_MS,
          adaptive_flush_active: true,
          last_flush_ms_ago: Date.now() - lastFlushTime,
          events_since_last_check: eventsSinceLastCheck,
          worker_pool_size: WORKER_COUNT,
          worker_alive_count: workers.filter(w => w !== undefined && w !== null).length,
          worker_queue_length: workerQueue.length
        },
        configuration: {
          retention_months: RETENTION_MONTHS,
          allowed_src: ALLOWED_SRC.size > 0 ? Array.from(ALLOWED_SRC) : 'all',
          max_payload_length: MAX_PAYLOAD_LENGTH,
          max_body_size_bytes: MAX_BODY_SIZE,
          max_batch_events: MAX_BATCH_EVENTS,
          max_export_rows: MAX_EXPORT_ROWS,
          trust_proxy: TRUST_PROXY
        },
        ai: ai.getMetrics(),
        timestamp: new Date().toISOString()
      };

      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(status, null, 2));
      return;
    }    // GET /e?src=...&type=...&...
    if (url.pathname === '/e' && req.method === 'GET') {
      const qs = Object.fromEntries(url.searchParams);
      if (!qs.src || !qs.type) { res.statusCode = 400; res.end('src and type required'); return; }
      if (ALLOWED_SRC.size && !ALLOWED_SRC.has(qs.src)) { res.statusCode = 403; res.end('src not allowed'); return; }

      // Backpressure: если буфер переполнен — 429
      if (buffer.length >= BUFFER_HARD_LIMIT) {
        res.statusCode = 429;
        res.setHeader('Retry-After', '5');
        res.end(JSON.stringify({ error: 'buffer_full', retry_after: 5 }));
        return;
      }

      res.statusCode = 204;
      res.end();

      buffer.push({
        ts: new Date().toISOString(),
        src: qs.src,
        type: qs.type,
        payload: parsePayload(qs),
        ip: getClientIp(req),
        ua: req.headers['user-agent'] || null,
      });
      writeBufferWAL(buffer[buffer.length - 1]);
      eventsSinceLastCheck++;
      if (buffer.length >= BATCH_SIZE) flush();
      return;
    }

    // POST /e  { src, type, ...payload }
    if (url.pathname === '/e' && req.method === 'POST') {
      // Backpressure: если буфер переполнен — 429
      if (buffer.length >= BUFFER_HARD_LIMIT) {
        res.statusCode = 429;
        res.setHeader('Retry-After', '5');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'buffer_full', retry_after: 5 }));
        return;
      }

      res.statusCode = 204;
      res.end();

      try {
        const body = await readBody(req);
        const j = JSON.parse(body);
        if (!j.src || !j.type) return;
        if (ALLOWED_SRC.size && !ALLOWED_SRC.has(j.src)) return;
        const { src, type, ...payload } = j;
        buffer.push({
          ts: new Date().toISOString(),
          src, type,
          payload: JSON.stringify(payload),
          ip: getClientIp(req),
          ua: req.headers['user-agent'] || null,
        });
        writeBufferWAL(buffer[buffer.length - 1]);
        eventsSinceLastCheck++;
        if (buffer.length >= BATCH_SIZE) flush();
      } catch (e) {
        console.error('[POST /e] error:', e.message);
      }
      return;
    }    // POST /e/clear — удаление событий по src (и опционально type)
    if (url.pathname === '/e/clear' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const j = JSON.parse(body);
        if (!j.src) { res.statusCode = 400; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({error:'src required'})); return; }

        // Требуем сессию, src в теле должен совпадать с src сессии
        const session = auth.resolveSession(db, auth.extractToken(req));
        if (!session) { res.statusCode = 401; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({error:'unauthorized'})); return; }
        if (j.src !== session.src) { res.statusCode = 403; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({error:'forbidden — src mismatch'})); return; }

        const tables = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%' ORDER BY name"
        ).all();

        let totalDeleted = 0;
        const params = [j.src];
        let whereClause = 'src = ?';
        if (j.type) { whereClause += ' AND type = ?'; params.push(j.type); }

        for (const { name } of tables) {
          try {
            const result = db.prepare(`DELETE FROM "${name}" WHERE ${whereClause}`).run(...params);
            totalDeleted += result.changes;
          } catch (e) {
            console.error(`[/e/clear] error deleting from ${name}:`, e.message);
          }
        }

        // Also clear from buffer
        if (j.type) {
          for (let i = buffer.length - 1; i >= 0; i--) {
            if (buffer[i].src === j.src && buffer[i].type === j.type) buffer.splice(i, 1);
          }
        } else {
          for (let i = buffer.length - 1; i >= 0; i--) {
            if (buffer[i].src === j.src) buffer.splice(i, 1);
          }
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ deleted: totalDeleted }));
        return;
      } catch (_) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({error:'invalid JSON'}));
        return;
      }
    }    // POST /e/batch  [{ src, type, ... }, ...]
    if (url.pathname === '/e/batch' && req.method === 'POST') {
      // Backpressure: если буфер переполнен — 429
      if (buffer.length >= BUFFER_HARD_LIMIT) {
        res.statusCode = 429;
        res.setHeader('Retry-After', '5');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'buffer_full', retry_after: 5 }));
        return;
      }

      res.statusCode = 204;
      res.end();

      try {
        const body = await readBody(req);
        const events = JSON.parse(body);
        if (!Array.isArray(events) || events.length > MAX_BATCH_EVENTS) return;
        const now = new Date().toISOString();
        for (const ev of events) {
          if (!ev.src || !ev.type) continue;
          if (ALLOWED_SRC.size && !ALLOWED_SRC.has(ev.src)) continue;
          const { src, type, ...payload } = ev;
          buffer.push({
            ts: now,
            src, type,
            payload: JSON.stringify(payload),
            ip: getClientIp(req),
            ua: req.headers['user-agent'] || null,
          });
          writeBufferWAL(buffer[buffer.length - 1]);
          eventsSinceLastCheck++;
        }
        if (buffer.length >= BATCH_SIZE) flush();
      } catch (e) {
        console.error('[POST /e/batch] error:', e.message);
      }
      return;    }    // GET /s?src=...&type=...&group=raw — return raw events (for logs panel)
    // GET /s?src=...&type=...&group=...&agg=...&from=...&to=...&sort=...&limit=...&filters=... — aggregated stats    if (url.pathname === '/s' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      if (!q.src) { res.statusCode = 400; res.end('src required'); return; }

      // ── Parse new params: sort, limit, filters ─────────
      const sort = ALLOWED_SORT_MODES.includes(q.sort) ? q.sort : 'key';
      const limitParam = q.limit ? Math.min(Number(q.limit), 500) : DEFAULT_GROUP_LIMIT;
      let filters = [];
      if (q.filters) {
        filters = parseFiltersParam(q.filters);
        if (filters === null) { res.statusCode = 400; res.end('invalid filters'); return; }
      }

      // ── Cache key & check ──────────────────────────────
      const _cacheKey = url.search;
      const _cached = _statsCache.get(_cacheKey);
      if (_cached && (Date.now() - _cached.ts < STATS_CACHE_TTL_MS) && _cached.gen === _statsCacheGen) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Cache', 'HIT');
        res.end(_cached.body);
        return;
      }

      // ── group=raw → return last N raw events (for logs table) ──────
      if (q.group === 'raw') {
        const rawLimit = Math.min(Number(q.limit) || 100, 500);
        const where = ['src = ?'];
        const params = [q.src];
        if (q.type) { where.push('type = ?'); params.push(q.type); }
        if (q.from) { where.push('ts >= ?'); params.push(q.from); }
        if (q.to)   { where.push('ts <= ?'); params.push(q.to); }

        // Add filter WHERE clauses for raw logs
        if (filters.length) {
          const filterClauses = buildFilterWhereClauses(filters, params);
          where.push(...filterClauses);
        }

        const events = [];

        // Include buffered (not yet flushed) events
        const buf = buffer.slice();
        for (const ev of buf) {
          if (ev.src !== q.src) continue;
          if (q.type && ev.type !== q.type) continue;
          if (q.from && ev.ts < q.from) continue;
          if (q.to && ev.ts > q.to) continue;
          // Apply filters to buffered events
          if (filters.length && !applyFiltersToPayload(ev.payload, filters)) continue;
          events.push({ ts: ev.ts, type: ev.type, payload: ev.payload });
        }

        // Fetch from DB tables (newest first)
        const tables = await workerQuery(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%' ORDER BY name DESC"
        );
        const filteredTables = filterTablesByDate(tables, q.from, q.to);
        for (const { name } of filteredTables) {
          if (events.length >= rawLimit) break;
          try {
            const remaining = rawLimit - events.length;
            const rows = await workerQuery(
              `SELECT ts, type, payload FROM "${name}" WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`,
              [...params, remaining]
            );
            for (const r of rows) {
              events.push({ ts: r.ts, type: r.type, payload: r.payload });
            }
          } catch (e) {
            console.error(`[GET /s raw] error reading table ${name}:`, e.message);
          }
        }

        // Sort by timestamp descending and trim to limit
        events.sort((a, b) => b.ts.localeCompare(a.ts));
        const trimmed = events.slice(0, rawLimit);

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ events: trimmed }));
        return;
      }

      const where = ['src = ?'];
      const params = [q.src];
      if (q.type) { where.push('type = ?'); params.push(q.type); }
      if (q.from) { where.push('ts >= ?'); params.push(q.from); }
      if (q.to)   { where.push('ts <= ?'); params.push(q.to); }

      // Add filter WHERE clauses
      if (filters.length) {
        const filterClauses = buildFilterWhereClauses(filters, params);
        where.push(...filterClauses);
      }      // ── Parse breakdown param (compound group) ───────
      const breakdownField = q.breakdown && typeof q.breakdown === 'string' && IDENT_RE.test(q.breakdown) ? q.breakdown : null;

      let groupExpr = '1';
      if (q.group === 'day')   groupExpr = "date(ts)";
      if (q.group === 'hour')  groupExpr = "strftime('%Y-%m-%d %H:00', ts)";
      if (q.group && q.group.startsWith('field:')) {
        const field = safeField(q.group.slice(6));
        if (!field) { res.statusCode = 400; res.end('invalid field'); return; }
        groupExpr = `json_extract(payload, '$."${field}"')`;
      }
      let breakdownExpr = null;
      if (breakdownField) {
        breakdownExpr = `json_extract(payload, '$."${breakdownField}"')`;
      }

      let aggExpr = 'COUNT(*)';
      let aggMode = 'count';
      if (q.agg && q.agg.startsWith('sum:')) {
        const field = safeField(q.agg.slice(4));
        if (!field) { res.statusCode = 400; res.end('invalid field'); return; }
        aggExpr = `SUM(json_extract(payload, '$."${field}"'))`;
        aggMode = 'sum';
      }
      if (q.agg && q.agg.startsWith('avg:')) {
        const field = safeField(q.agg.slice(4));
        if (!field) { res.statusCode = 400; res.end('invalid field'); return; }
        // For weighted avg: fetch SUM and COUNT separately per table
        aggExpr = `SUM(json_extract(payload, '$."${field}"'))`;
        aggMode = 'avg';
      }      const tables = await workerQuery(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%' ORDER BY name"
      );
      const filteredTables = filterTablesByDate(tables, q.from, q.to);

      // ── BREAKDOWN (compound group) → return early with series ──
      if (breakdownExpr) {
        const seriesMap = {}; // { fieldVal: { bucket: value } }

        // Buffer events
        const bufBD = buffer.slice();
        for (const ev of bufBD) {
          if (ev.src !== q.src) continue;
          if (q.type && ev.type !== q.type) continue;
          if (q.from && ev.ts < q.from) continue;
          if (q.to && ev.ts > q.to) continue;
          if (filters.length && !applyFiltersToPayload(ev.payload, filters)) continue;
          let bkt;
          if (q.group === 'day')  bkt = ev.ts.slice(0, 10);
          else if (q.group === 'hour') bkt = ev.ts.slice(0, 13) + ':00';
          else bkt = '1';
          let fv = 'null';
          try { const pl = JSON.parse(ev.payload); fv = String(pl[breakdownField] ?? 'null'); } catch (_) {}
          if (!seriesMap[fv]) seriesMap[fv] = {};
          if (aggMode === 'count') {
            seriesMap[fv][bkt] = (seriesMap[fv][bkt] || 0) + 1;
          } else if (aggMode === 'sum' || aggMode === 'avg') {
            const fld = q.agg.slice(4);
            try { const pl = JSON.parse(ev.payload); const v = Number(pl[fld]); if (!isNaN(v)) { seriesMap[fv][bkt] = (seriesMap[fv][bkt] || 0) + v; } } catch (_) {}
          }
        }

        // DB tables
        for (const { name } of filteredTables) {
          try {
            const selectVal = aggMode === 'sum' || aggMode === 'avg'
              ? `SUM(json_extract(payload, '$."${safeField(q.agg.slice(4))}"'))`
              : 'COUNT(*)';
            const sql = `
              SELECT ${groupExpr} AS bkt, ${breakdownExpr} AS fv, ${selectVal} AS v
              FROM "${name}"
              WHERE ${where.join(' AND ')}
              GROUP BY bkt, fv
              ORDER BY bkt
            `;
            const rows = await workerQuery(sql, params);
            for (const r of rows) {
              const bkt = String(r.bkt ?? '');
              const fv  = String(r.fv ?? 'null');
              if (!seriesMap[fv]) seriesMap[fv] = {};
              seriesMap[fv][bkt] = (seriesMap[fv][bkt] || 0) + (r.v || 0);
            }
          } catch (e) {
            console.error(`[GET /s breakdown] error reading table ${name}:`, e.message);
          }
        }

        // Build series array
        const series = [];
        const allBucketsSet = new Set();
        for (const fv of Object.keys(seriesMap)) {
          for (const bkt of Object.keys(seriesMap[fv])) {
            allBucketsSet.add(bkt);
          }
        }
        const allBuckets = Array.from(allBucketsSet).sort();

        for (const fv of Object.keys(seriesMap)) {
          const points = allBuckets.map(b => ({ bucket: b, value: seriesMap[fv][b] || 0 }));
          series.push({ key: fv, points });
        }

        // Sort series
        if (sort === 'value_desc') {
          series.sort((a, b) => {
            const sa = a.points.reduce((s, p) => s + p.value, 0);
            const sb = b.points.reduce((s, p) => s + p.value, 0);
            return sb - sa;
          });
        } else if (sort === 'value_asc') {
          series.sort((a, b) => {
            const sa = a.points.reduce((s, p) => s + p.value, 0);
            const sb = b.points.reduce((s, p) => s + p.value, 0);
            return sa - sb;
          });
        } else {
          series.sort((a, b) => String(a.key).localeCompare(String(b.key)));
        }

        // Limit series
        if (limitParam && limitParam > 0 && series.length > limitParam) {
          series.length = limitParam;
        }

        // Total
        let total = null;
        if (aggMode === 'count') {
          total = series.reduce((s, sr) => s + sr.points.reduce((ss, p) => ss + p.value, 0), 0);
        }

        const respBD = JSON.stringify({ total, series });
        _statsCache.set(_cacheKey, { ts: Date.now(), gen: _statsCacheGen, body: respBD });
        res.setHeader('Content-Type', 'application/json');
        res.end(respBD);
        return;
      }

      // ── Standard (single-group) aggregation below ──
      const merged = {};
      const countsForAvg = {};

      // ── Include buffered (not yet flushed) events ───────
      const buf = buffer.slice(); // snapshot
      for (const ev of buf) {
        if (ev.src !== q.src) continue;
        if (q.type && ev.type !== q.type) continue;
        if (q.from && ev.ts < q.from) continue;
        if (q.to && ev.ts > q.to) continue;
        // Apply filters to buffered events
        if (filters.length && !applyFiltersToPayload(ev.payload, filters)) continue;

        let key;
        if (q.group === 'day') {
          key = ev.ts.slice(0, 10);
        } else if (q.group === 'hour') {
          key = ev.ts.slice(0, 13) + ':00';
        } else if (q.group && q.group.startsWith('field:')) {
          const f = q.group.slice(6);
          try {
            const pl = JSON.parse(ev.payload);
            key = String(pl[f] ?? 'null');
          } catch (_) { key = 'null'; }
        } else if (!q.group) {
          key = '1';
        } else {
          key = '1';
        }

        if (aggMode === 'count') {
          merged[key] = (merged[key] || 0) + 1;
        } else if (aggMode === 'sum' || aggMode === 'avg') {
          const f = q.agg.slice(4);
          try {
            const pl = JSON.parse(ev.payload);
            const v = Number(pl[f]);
            if (!isNaN(v)) {
              merged[key] = (merged[key] || 0) + v;
              if (aggMode === 'avg') countsForAvg[key] = (countsForAvg[key] || 0) + 1;
            }
          } catch (_) {}
        }
      }

      for (const { name } of filteredTables) {
        try {
          if (aggMode === 'avg') {
            const sql = `
              SELECT ${groupExpr} AS g,
                     SUM(json_extract(payload, '$."${safeField(q.agg.slice(4))}"')) AS v,
                     COUNT(*) AS cnt
              FROM "${name}"
              WHERE ${where.join(' AND ')}
              GROUP BY g
              ORDER BY g
            `;
            const rows = await workerQuery(sql, params);
            for (const r of rows) {
              const key = String(r.g ?? 'null');
              merged[key] = (merged[key] || 0) + (r.v || 0);
              countsForAvg[key] = (countsForAvg[key] || 0) + (r.cnt || 0);
            }
          } else {
            const sql = `
              SELECT ${groupExpr} AS g, ${aggExpr} AS v
              FROM "${name}"
              WHERE ${where.join(' AND ')}
              GROUP BY g
              ORDER BY g
            `;
            const rows = await workerQuery(sql, params);
            for (const r of rows) {
              const key = String(r.g ?? 'null');
              merged[key] = (merged[key] || 0) + (r.v || 0);
            }
          }
        } catch (e) {
          console.error(`[GET /s agg] error reading table ${name}:`, e.message);
        }
      }

      // Finalize: for avg, divide sum by count
      if (aggMode === 'avg') {
        for (const key of Object.keys(merged)) {
          const cnt = countsForAvg[key] || 0;
          if (cnt > 0) merged[key] = merged[key] / cnt;
          else merged[key] = 0;
        }
      }

      // Вычисляем чистое имя ключа для ответа (без префикса "field:")
      const responseGroupKey = (q.group && q.group.startsWith('field:')) ? q.group.slice(6) : (q.group || 'bucket');

      // Build groups array
      const groups = Object.entries(merged)
        .map(([g, v]) => ({ [responseGroupKey]: g, value: aggMode === 'avg' ? Math.round(v * 100) / 100 : v }));

      // Compute total BEFORE sort/limit (total = sum over all groups)
      let total = null;
      if (aggMode === 'count') {
        total = groups.reduce((s, r) => s + r.value, 0);
      } else if (aggMode === 'avg') {
        let allSum = 0, allCnt = 0;
        for (const [key, avg] of Object.entries(merged)) {
          const cnt = countsForAvg[key] || 0;
          allSum += avg * cnt;
          allCnt += cnt;
        }
        total = allCnt > 0 ? Math.round((allSum / allCnt) * 100) / 100 : 0;
      }      // Apply sort + limit (AFTER total is computed)
      applySortAndLimit(groups, sort, limitParam, responseGroupKey);

      const _respBody = JSON.stringify({ total, groups });
      _statsCache.set(_cacheKey, { ts: Date.now(), gen: _statsCacheGen, body: _respBody });
      res.setHeader('Content-Type', 'application/json');
      res.end(_respBody);
      return;
    }    // GET /export?src=...
    if (url.pathname === '/export' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      if (!q.src) { res.statusCode = 400; res.end('src required'); return; }

      // Требуем сессию, src в query должен совпадать с src сессии
      const session = auth.resolveSession(db, auth.extractToken(req));
      if (!session) { res.statusCode = 401; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({error:'unauthorized'})); return; }
      if (q.src !== session.src) { res.statusCode = 403; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({error:'forbidden — src mismatch'})); return; }

      const tables = await workerQuery(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%' ORDER BY name DESC"
      );

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${q.src}_events.csv`);
      res.write('timestamp,type,payload\n');

      let rowCount = 0;
      for (const { name } of tables) {
        const remaining = MAX_EXPORT_ROWS - rowCount;
        if (remaining <= 0) break;

        try {
          const rows = await workerQuery(
            `SELECT ts, type, payload FROM "${name}" WHERE src = ? ORDER BY ts DESC LIMIT ?`,
            [q.src, remaining]
          );

          for (const row of rows) {
            rowCount++;
            const safePayload = String(row.payload)
              .replace(/"/g, '""')
              .replace(/[\r\n]+/g, ' ');
            res.write(`${row.ts},${row.type},"${safePayload}"\n`);
          }
        } catch (_) {}
      }
      res.end();
      return;
    }    // ═══════════════════════════════════════════════════════
    // AUTH & DASHBOARDS & SHARES
    // ═══════════════════════════════════════════════════════

    // POST /auth/register {src, pin}
    if (url.pathname === '/auth/register' && req.method === 'POST') {
      try {
        const body = await auth.readJsonBody(req);
        const result = auth.registerSrc(db, body.src, body.pin);
        if (!result.ok) return auth.json(res, result.code, { error: result.error });
        auth.json(res, 200, {
          src: result.src,
          token: result.session.token,
          expiresAt: result.session.expiresAt.toISOString(),
        });
      } catch (e) {
        auth.json(res, 400, { error: 'invalid json' });
      }
      return;
    }

    // POST /auth/login {src, pin}
    if (url.pathname === '/auth/login' && req.method === 'POST') {
      // IP-based rate limiting — защита от lockout DoS
      const ip = getClientIp(req);
      const rl = auth.checkLoginRateLimit(ip);
      if (!rl.ok) {
        return auth.json(res, 429, { error: 'rate_limited', remainSec: rl.remainSec });
      }
      try {
        const body = await auth.readJsonBody(req);
        const result = auth.loginSrc(db, body.src, body.pin);
        if (!result.ok) {
          const out = { error: result.error };
          if (result.remainSec) out.remainSec = result.remainSec;
          if (result.lockedUntil) out.lockedUntil = result.lockedUntil;
          return auth.json(res, result.code, out);
        }
        auth.json(res, 200, {
          src: result.src,
          token: result.session.token,
          expiresAt: result.session.expiresAt.toISOString(),
        });
      } catch (e) {
        auth.json(res, 400, { error: 'invalid json' });
      }
      return;
    }

    // POST /auth/logout (auth)
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      const token = auth.extractToken(req);
      if (token) auth.deleteSession(db, token);
      auth.json(res, 200, { ok: true });
      return;
    }

    // GET /auth/me (auth) — возвращает src сессии
    if (url.pathname === '/auth/me' && req.method === 'GET') {
      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });
      auth.json(res, 200, { src: session.src });
      return;
    }

    // GET /dashboards (auth) — список дашбордов текущего src
    if (url.pathname === '/dashboards' && req.method === 'GET') {
      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });
      auth.json(res, 200, { dashboards: auth.listDashboards(db, session.src) });
      return;
    }

    // POST /dashboards (auth) — создать дашборд
    if (url.pathname === '/dashboards' && req.method === 'POST') {
      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });
      try {
        const body = await auth.readJsonBody(req);
        const dashboard = auth.createDashboard(db, session.src, body.name, body.panels, body.layoutMode);
        auth.json(res, 200, { dashboard });
      } catch (e) {
        auth.json(res, 400, { error: 'invalid json' });
      }
      return;
    }

    // PUT /dashboards/:id (auth) — обновить дашборд
    if (url.pathname.startsWith('/dashboards/') && req.method === 'PUT') {
      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });
      const id = url.pathname.slice('/dashboards/'.length);
      if (!id || id.includes('/')) { auth.json(res, 400, { error: 'bad_id' }); return; }
      try {
        const body = await auth.readJsonBody(req);
        const result = auth.updateDashboard(db, id, session.src, body);
        if (!result.ok) return auth.json(res, result.code, { error: result.error });
        auth.json(res, 200, { dashboard: result.dashboard });
      } catch (e) {
        auth.json(res, 400, { error: 'invalid json' });
      }
      return;
    }

    // DELETE /dashboards/:id (auth)
    if (url.pathname.startsWith('/dashboards/') && req.method === 'DELETE') {
      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });
      const id = url.pathname.slice('/dashboards/'.length);
      if (!id || id.includes('/')) { auth.json(res, 400, { error: 'bad_id' }); return; }
      const result = auth.deleteDashboard(db, id, session.src);
      if (!result.ok) return auth.json(res, result.code, { error: result.error });
      auth.json(res, 200, { ok: true });
      return;
    }

    // POST /dashboards/:id/share (auth) — создать публичную ссылку
    if (url.pathname.match(/^\/dashboards\/[^/]+\/share$/) && req.method === 'POST') {
      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });
      const id = url.pathname.slice('/dashboards/'.length, -'/share'.length);
      const result = auth.createShare(db, id, session.src);
      if (!result.ok) return auth.json(res, result.code, { error: result.error });
      auth.json(res, 200, { shareId: result.shareId });
      return;
    }

    // GET /shares (auth) — список публичных ссылок текущего пользователя
    if (url.pathname === '/shares' && req.method === 'GET') {
      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });
      const rows = db.prepare(`
        SELECT s.share_id, s.dashboard_id, s.created_at, s.revoked, d.name
        FROM public_shares s
        JOIN dashboards d ON d.id = s.dashboard_id
        WHERE s.src = ? ORDER BY s.created_at DESC
      `).all(session.src);
      auth.json(res, 200, { shares: rows });
      return;
    }

    // POST /shares/:share_id/revoke (auth)
    if (url.pathname.match(/^\/shares\/[^/]+\/revoke$/) && req.method === 'POST') {
      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });
      const sid = url.pathname.slice('/shares/'.length, -'/revoke'.length);
      const result = auth.revokeShare(db, sid, session.src);
      if (!result.ok) return auth.json(res, result.code, { error: result.error });
      auth.json(res, 200, { ok: true });
      return;
    }

    // GET /suggestions (auth) — получить уникальные типы событий и поля payload
    if (url.pathname === '/suggestions' && req.method === 'GET') {
      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });

      const src = session.src;
      const tables = await workerQuery(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%'"
      );

      const typesSet = new Set();
      const fieldsSet = new Set();

      for (const { name } of tables) {
        try {
          // Собираем типы
          const types = await workerQuery(`SELECT DISTINCT type FROM "${name}" WHERE src = ?`, [src]);
          for (const t of types) {
            if (t.type) typesSet.add(t.type);
          }

          // Собираем ключи из JSON payload
          const keys = await workerQuery(`
            SELECT DISTINCT json_each.key AS k 
            FROM "${name}", json_each(payload) 
            WHERE src = ?
          `, [src]);
          for (const k of keys) {
            if (k.k) fieldsSet.add(k.k);
          }
        } catch (_) {}
      }

      auth.json(res, 200, {
        types: Array.from(typesSet).sort(),
        fields: Array.from(fieldsSet).sort()
      });
      return;
    }

    // POST /ai/suggest-panel (auth) — AI-помощник по метрикам
    if (url.pathname === '/ai/suggest-panel' && req.method === 'POST') {
      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });

      // Rate-limit per src
      const rl = ai.checkRateLimit(session.src);
      if (!rl.ok) {
        res.setHeader('Retry-After', String(rl.remainSec || 60));
        return auth.json(res, 429, { error: 'rate_limited', remainSec: rl.remainSec });
      }

      let body;
      try { body = await auth.readJsonBody(req); }
      catch (_) { return auth.json(res, 400, { error: 'invalid json' }); }

      const prompt = (body && typeof body.prompt === 'string') ? body.prompt.trim() : '';
      if (!prompt) return auth.json(res, 400, { error: 'empty_prompt' });

      // Собираем существующие типы событий НА СЕРВЕРЕ — клиенту не доверяем
      const existingTypes = ai.collectExistingTypes(db, session.src);

      try {
        const panel = await ai.suggestPanel(prompt, existingTypes);
        auth.json(res, 200, { panel, existingTypes });
      } catch (e) {
        const code = (e && e.code) ? e.code : 'unknown';
        const msg = (e && e.message) ? e.message : 'unknown';
        // Ошибки валидации модели / парсинга / таймаута → 502 Bad Gateway
        if (msg.startsWith('ai_') || msg === 'timeout' || msg === 'fetch_failed') {
          return auth.json(res, 502, { error: 'ai_invalid_response', code, message: msg });
        }
        // Любая другая ошибка → 500
        auth.json(res, 500, { error: 'internal', message: msg });
      }
      return;
    }

    // GET /public/:share_id (без auth) — read-only конфиг дашборда
    if (url.pathname.startsWith('/public/') && req.method === 'GET') {
      const sid = url.pathname.slice('/public/'.length);
      if (!sid) { res.statusCode = 404; res.end('Not found'); return; }
      const result = auth.resolveShare(db, sid);
      if (!result.ok) {
        return auth.json(res, result.code, { error: result.error });
      }
      auth.json(res, 200, {
        share: result.share,
        dashboard: result.dashboard,
      });
      return;
    }

    // ── /src/:id — redirect to dashboard with src ─────────
    if (url.pathname.startsWith('/src/') && req.method === 'GET') {
      const afterSrc = url.pathname.slice(5); // '/src/protalk_stat' → 'protalk_stat', '/src/app.js' → 'app.js'

      // If the path has a file extension → serve static file from public/
      const ext = path.extname(afterSrc).toLowerCase();
      if (ext) {
        const safePath = path.normalize('/' + afterSrc).replace(/^(\.\.[\/\\])+/, '');
        const filePath = path.join(__dirname, 'public', safePath);
        const publicDir = path.join(__dirname, 'public');
        if (filePath.startsWith(publicDir)) {
          try {
            const stat = await fsp.stat(filePath);
            if (stat.isFile()) {
              const mimeTypes = {
                '.html': 'text/html; charset=utf-8',
                '.css':  'text/css; charset=utf-8',
                '.js':   'application/javascript; charset=utf-8',
                '.json': 'application/json; charset=utf-8',
                '.svg':  'image/svg+xml',
                '.png':  'image/png',
                '.jpg':  'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif':  'image/gif',
                '.ico':  'image/x-icon',
                '.woff': 'font/woff',
                '.woff2':'font/woff2',
                '.ttf':  'font/ttf',
              };
              const contentType = mimeTypes[ext] || 'application/octet-stream';
              const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
              const content = await fsp.readFile(filePath);
              res.setHeader('Content-Type', contentType);
              res.setHeader('Cache-Control', cacheControl);
              res.end(content);
              return;
            }
          } catch (_) {}
        }
        // Static file not found under /src/ — fall through to 404
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      // No file extension → this is a src ID → serve index.html
      if (afterSrc && IDENT_RE.test(afterSrc)) {
        const indexPath = path.join(__dirname, 'public', 'index.html');
        try {
          const content = await fsp.readFile(indexPath);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(content);
          return;
        } catch (_) {}
      }
      res.statusCode = 302;
      res.setHeader('Location', '/');
      res.end();
      return;
    }

    // ── Static files (public/) ────────────────────────────
    if (req.method === 'GET') {
      // '/' → 'index.html'
      let reqPath = url.pathname === '/' ? '/index.html' : url.pathname;

      // Защита от path traversal: запрещаем '..' и выход за пределы public
      const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
      const filePath = path.join(__dirname, 'public', safePath);

      // Дополнительная проверка: файл должен быть внутри public
      const publicDir = path.join(__dirname, 'public');
      if (!filePath.startsWith(publicDir)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }

      try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.css':  'text/css; charset=utf-8',
          '.js':   'application/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg':  'image/svg+xml',
          '.png':  'image/png',
          '.jpg':  'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif':  'image/gif',
          '.ico':  'image/x-icon',
          '.woff': 'font/woff',
          '.woff2':'font/woff2',
          '.ttf':  'font/ttf',
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        // Кэширование: no-cache для HTML (чтобы видели правки сразу),
        // max-age=3600 для всего остального (шрифты, картинки и т.д.)
        const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=3600';

        const content = await fsp.readFile(filePath);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', cacheControl);
        res.end(content);
        return;
      } catch (e) {
        // Файл не найден — падаем в стандартный 404 ниже
      }
    }

    res.statusCode = 404;
    res.end();
  } catch (e) {
    console.error('[server] error:', e.message);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  }
});

// ── Запуск ─────────────────────────────────────────────
initKnownTables();
auth.initAuthTables(db);
initWorkerPool();
initBufferWAL();
recoverBufferWAL();
setInterval(adaptiveFlush, 500);
setInterval(cleanupOldTables, CLEANUP_INTERVAL_MS);
cleanupOldTables();

// Периодический ANALYZE — обновляет статистику SQLite для query planner
setInterval(() => {
  try {
    db.pragma('analyze');
    console.log('[analyze] SQLite statistics updated');
  } catch (e) {
    console.error('[analyze] error:', e.message);
  }
}, ANALYZE_INTERVAL_MS);

// Периодический WAL checkpoint — не даёт WAL-файлу расти бесконечно
setInterval(() => {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch (_) {}
}, WAL_CHECKPOINT_MS);

server.listen(PORT, () => console.log(`listening on :${PORT}`));

function shutdownWorkers() {
  for (const w of workers) {
    try { w.terminate(); } catch (_) {}
  }
}

process.on('SIGINT', () => {
  flush();
  shutdownWorkers();
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  db.close();
  process.exit();
});

process.on('SIGTERM', () => {
  flush();
  shutdownWorkers();
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  db.close();
  process.exit();
});
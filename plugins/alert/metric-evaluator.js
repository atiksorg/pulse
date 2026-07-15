/**
 * plugins/alert/metric-evaluator.js — Вычисление текущего значения метрики
 *                                            KPI-панели на сервере
 *
 * Читает конфиг панели из dashboards.panels_json, вычисляет total
 * (count/sum/avg/min/max) с теми же фильтрами и диапазонами, что
 * использует клиент при загрузке панели. Не дублирует логику
 * xml-generator: использует похожие SQL-примитивы, но без зависимости
 * от dispatch-контекста.
 *
 * Открывает своё read-only подключение к SQLite (не блокирует writer-поток
 * events_server.js, который пишет в WAL).
 *
 * v2: Поддержка no_data и rate_of_change типов проверок.
 * v2: Убрано ограничение viz — теперь работает с любыми панелями.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

const MAX_PARALLEL = 4;
let activeEvals = 0;

let db = null;
let initPromise = null;

function _dbPath() {
  return process.env.DB_PATH || path.join(__dirname, '..', '..', 'events.db');
}

function _ensureDb() {
  if (db) return db;
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve, reject) => {
    try {
      const p = _dbPath();
      if (!fs.existsSync(p)) {
        return reject(new Error('events database not found at ' + p));
      }
      db = new Database(p, { readonly: true, fileMustExist: true });
      db.pragma('journal_mode = WAL');
      db.pragma('cache_size = -16000');
      db.pragma('temp_store = MEMORY');
      resolve(db);
    } catch (e) {
      reject(e);
    }
  });

  // Очищаем кэш Promise в случае ошибки, чтобы дать шанс переподключиться
  initPromise.catch(() => { initPromise = null; });

  return initPromise;
}

function safeField(name) {
  return IDENT_RE.test(name) ? name : null;
}

function resolveRange(range, from, to) {
  if (range === 'custom') return { from: from || null, to: to || null };
  if (range === 'all') return { from: null, to: null };
  const now = new Date();
  let fromDate = null;
  if (range === '24h')  fromDate = new Date(now.getTime() - 24 * 3600000);
  else if (range === '7d')  fromDate = new Date(now.getTime() - 7 * 24 * 3600000);
  else if (range === '30d') fromDate = new Date(now.getTime() - 30 * 24 * 3600000);
  return {
    from: fromDate ? fromDate.toISOString() : null,
    to: null,
  };
}

function filterTablesByDate(tables, from, to) {
  if (!from && !to) return tables;
  let minTable = null;
  let maxTable = null;
  if (from && from.length >= 7) minTable = `events_${from.slice(0, 4)}_${from.slice(5, 7)}`;
  if (to && to.length >= 7)     maxTable = `events_${to.slice(0, 4)}_${to.slice(5, 7)}`;
  return tables.filter(t => {
    if (minTable && t.name < minTable) return false;
    if (maxTable && t.name > maxTable) return false;
    return true;
  });
}

/**
 * Вычислить значение метрики для панели.
 * v2: Убрано ограничение viz — работает с любыми панелями (kpi, gauge, line, table...).
 * Возвращает { value: number|null, error?: string, aggMode?: string, count?: number }.
 */
async function evaluatePanelMetric(panel, src) {
  if (!panel) return { value: null, error: 'panel_missing' };

  if (activeEvals >= MAX_PARALLEL) {
    return { value: null, error: 'metric_evaluator_busy' };
  }
  activeEvals++;

  try {
    const database = await _ensureDb();

    const type = panel.type || '';
    const agg = panel.agg || 'count';
    const aggfield = panel.aggfield || '';
    const field = panel.field || '';
    const range = panel.range || '7d';
    const filters = Array.isArray(panel.filters) ? panel.filters : [];

    const { from, to } = resolveRange(range, panel.from, panel.to);

    // WHERE
    const where = ['src = ?'];
    const params = [src];
    if (type) { where.push('type = ?'); params.push(type); }
    if (from) { where.push('ts >= ?'); params.push(from); }
    if (to)   { where.push('ts <= ?'); params.push(to); }

    // Filters
    for (const f of filters.slice(0, 5)) {
      if (!f || !f.field || !IDENT_RE.test(f.field)) continue;
      const col = `json_extract(payload, '$."${f.field}"')`;
      const op = String(f.op || '').toLowerCase();
      if (op === 'eq') {
        where.push(`(${col} = ? OR ${col} = ?)`);
        params.push(String(f.value), String(f.value));
      } else if (op === 'gt') {
        where.push(`CAST(${col} AS REAL) > ?`);
        params.push(Number(f.value));
      } else if (op === 'lt') {
        where.push(`CAST(${col} AS REAL) < ?`);
        params.push(Number(f.value));
      } else if (op === 'neq') {
        where.push(`(${col} != ? OR ${col} IS NULL OR ${col} = '')`);
        params.push(String(f.value));
      } else if (op === 'contains') {
        where.push(`${col} LIKE ?`);
        params.push('%' + String(f.value) + '%');
      }
    }

    // Agg expression
    let aggExpr = 'COUNT(*)';
    let aggMode = 'count';

    if (agg.startsWith('sum:') && aggfield) {
      const f = safeField(agg.slice(4));
      if (f) { aggExpr = `SUM(json_extract(payload, '$."${f}"'))`; aggMode = 'sum'; }
    } else if (agg.startsWith('avg:') && aggfield) {
      const f = safeField(agg.slice(4));
      if (f) { aggExpr = `AVG(json_extract(payload, '$."${f}"'))`; aggMode = 'avg'; }
    } else if (agg.startsWith('min:') && aggfield) {
      const f = safeField(agg.slice(4));
      if (f) { aggExpr = `MIN(json_extract(payload, '$."${f}"'))`; aggMode = 'min'; }
    } else if (agg.startsWith('max:') && aggfield) {
      const f = safeField(agg.slice(4));
      if (f) { aggExpr = `MAX(json_extract(payload, '$."${f}"'))`; aggMode = 'max'; }
    } else if (agg === 'sum' && aggfield) {
      const f = safeField(aggfield);
      if (f) { aggExpr = `SUM(json_extract(payload, '$."${f}"'))`; aggMode = 'sum'; }
    } else if (agg === 'avg' && aggfield) {
      const f = safeField(aggfield);
      if (f) { aggExpr = `AVG(json_extract(payload, '$."${f}"'))`; aggMode = 'avg'; }
    } else if (agg === 'max' && aggfield) {
      const f = safeField(aggfield);
      if (f) { aggExpr = `MAX(json_extract(payload, '$."${f}"'))`; aggMode = 'max'; }
    }

    // Таблицы
    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%' ORDER BY name"
    ).all();
    const filteredTables = filterTablesByDate(tables, from, to);

    let total = 0;
    let count = 0;

    for (const { name } of filteredTables) {
      try {
        const row = database.prepare(
          `SELECT ${aggExpr} AS v, COUNT(*) AS cnt FROM "${name}" WHERE ${where.join(' AND ')}`
        ).get(...params);
        if (row) {
          total += (row.v || 0);
          count += (row.cnt || 0);
        }
      } catch (_) {}
    }

    let value;
    if (aggMode === 'avg') {
      value = count > 0 ? Math.round((total / count) * 100) / 100 : 0;
    } else if (aggMode === 'min' || aggMode === 'max') {
      value = Math.round(total * 100) / 100;
    } else {
      value = Math.round(total * 100) / 100;
    }

    return { value, aggMode, count };
  } catch (e) {
    return { value: null, error: e.message };
  } finally {
    activeEvals--;
  }
}

/**
 * Проверить наличие данных (no_data detection).
 * Возвращает время (в секундах) с последнего события для данного src+type.
 * Если событий нет — возвращает очень большое число.
 *
 * @param {string} src
 * @param {string} type
 * @returns {Promise<{ secondsSinceLastEvent: number|null, error?: string }>}
 */
async function checkNoData(src, type) {
  if (activeEvals >= MAX_PARALLEL) {
    return { secondsSinceLastEvent: null, error: 'metric_evaluator_busy' };
  }
  activeEvals++;

  try {
    const database = await _ensureDb();

    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%' ORDER BY name DESC"
    ).all();

    let lastTs = null;

    for (const { name } of tables) {
      try {
        const where = ['src = ?'];
        const params = [src];
        if (type) { where.push('type = ?'); params.push(type); }
        const row = database.prepare(
          `SELECT MAX(ts) as last_ts FROM "${name}" WHERE ${where.join(' AND ')}`
        ).get(...params);
        if (row && row.last_ts) {
          if (!lastTs || row.last_ts > lastTs) lastTs = row.last_ts;
          // Таблицы идут в порядке DESC, первая найденная запись = самая свежая
          break;
        }
      } catch (_) {}
    }

    if (!lastTs) {
      return { secondsSinceLastEvent: Infinity };
    }

    const elapsed = Math.floor((Date.now() - new Date(lastTs).getTime()) / 1000);
    return { secondsSinceLastEvent: elapsed, lastTs };
  } catch (e) {
    return { secondsSinceLastEvent: null, error: e.message };
  } finally {
    activeEvals--;
  }
}

/**
 * Вычислить rate_of_change: процент изменения метрики за указанный период.
 *
 * @param {object} panel — конфиг панели
 * @param {string} src
 * @param {string} windowExpr — выражение окна, напр. '1h', '24h', '7d'
 * @returns {Promise<{ pctChange: number|null, currentValue: number|null, previousValue: number|null, error?: string }>}
 */
async function evaluateRateOfChange(panel, src, windowExpr) {
  if (!panel) return { pctChange: null, error: 'panel_missing' };

  // Парсим окно
  const windowMs = _parseWindow(windowExpr);
  if (!windowMs) return { pctChange: null, error: 'invalid_window' };

  // Текущее значение
  const current = await evaluatePanelMetric(panel, src);
  if (current.value === null) return { pctChange: null, error: current.error };

  // Значение в прошлом окне (сдвигаем range)
  const database = await _ensureDb();

  // Создаём копию panel со сдвинутым окном
  const now = new Date();
  const pastPanel = Object.assign({}, panel, {
    range: 'custom',
    from: new Date(now.getTime() - 2 * windowMs).toISOString(),
    to: new Date(now.getTime() - windowMs).toISOString(),
  });

  const previous = await evaluatePanelMetric(pastPanel, src);
  if (previous.value === null) return { pctChange: null, error: previous.error };

  const pctChange = previous.value !== 0
    ? Math.round(((current.value - previous.value) / Math.abs(previous.value)) * 10000) / 100
    : (current.value !== 0 ? 100 : 0);

  return {
    pctChange,
    currentValue: current.value,
    previousValue: previous.value,
  };
}

/**
 * Парсить выражение окна: '1h' → 3600000, '24h' → 86400000, '7d' → 604800000.
 */
function _parseWindow(expr) {
  if (!expr || typeof expr !== 'string') return 0;
  const m = expr.match(/^(\d+)([hdwm])$/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === 'h') return n * 3600000;
  if (unit === 'd') return n * 86400000;
  if (unit === 'w') return n * 7 * 86400000;
  if (unit === 'm') return n * 30 * 86400000;
  return 0;
}

/**
 * Получить текущее кол-во параллельных вычислений (для статуса).
 */
function getActiveEvals() {
  return activeEvals;
}

/**
 * Найти панель в дашборде по panel_id.
 * @param {string} dashboardId
 * @param {string} panelId
 * @returns {object|null} панель или null
 */
function findPanelInDashboard(dashboardId, panelId) {
  if (!db) {
    try {
      const p = _dbPath();
      if (!fs.existsSync(p)) return null;
      db = new Database(p, { readonly: true, fileMustExist: true });
      db.pragma('journal_mode = WAL');
      db.pragma('cache_size = -16000');
      db.pragma('temp_store = MEMORY');
    } catch (_) {
      return null;
    }
  }
  try {
    const row = db.prepare(
      'SELECT id, name, src, panels_json FROM dashboards WHERE id = ?'
    ).get(dashboardId);
    if (!row) return null;
    let panels = [];
    try { panels = JSON.parse(row.panels_json); } catch (_) { panels = []; }
    return panels.find(p => p.id === panelId) || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  evaluatePanelMetric,
  checkNoData,
  evaluateRateOfChange,
  findPanelInDashboard,
  getActiveEvals,
};

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
  // Та же БД, что у events_server.js. По умолчанию ./events.db,
  // но если задан DB_PATH — берём его.
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
      db.pragma('cache_size = -16000'); // 16 МБ
      db.pragma('temp_store = MEMORY');
      resolve(db);
    } catch (e) {
      reject(e);
    }
  });
  return initPromise;
}

function safeField(name) {
  return IDENT_RE.test(name) ? name : null;
}

function resolveRange(range, from, to) {
  if (range === 'custom') return { from: from || null, to: to || null };
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
 * Возвращает { value: number|null, error?: string }.
 * Если viz не 'kpi' и не 'gauge' — возвращает value: null и error.
 */
async function evaluatePanelMetric(panel, src) {
  if (!panel) return { value: null, error: 'panel_missing' };
  const viz = panel.viz || 'line';
  if (viz !== 'kpi' && viz !== 'gauge') {
    return { value: null, error: 'unsupported_viz:' + viz };
  }

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

    // Filters (как в events_server.js, но без op='in'/contains — упрощаем
    // на старте: KPI-пороги редко требуют сложных фильтров, при
    // необходимости расширим)
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
    }
    // count / пустая agg → COUNT(*)

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
    // Синхронный путь: инициализируемся, если ещё не успели
    // (первый вызов будет async, дальше — sync)
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
  findPanelInDashboard,
  getActiveEvals,
};

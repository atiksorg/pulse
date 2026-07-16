/**
 * plugins/threshold-alerts/metric-query.js — Получить текущее скалярное значение панели
 *
 * Работает как kpi/gauge-ветка в plugins/reports/xml-generator.js::queryPanelData,
 * но самодостаточно (без зависимости от плагина reports), т.к. threshold-alerts
 * должен работать даже если reports не установлен.
 *
 * Поддерживает: agg = count | sum | avg | max | min (+ aggfield), range, filters.
 */
'use strict';

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

function safeField(name) {
  return IDENT_RE.test(name) ? name : null;
}

function resolveRange(range) {
  const now = new Date();
  let fromDate = null;
  if (range === '24h')      fromDate = new Date(now.getTime() - 24 * 3600000);
  else if (range === '7d')  fromDate = new Date(now.getTime() - 7 * 24 * 3600000);
  else if (range === '30d') fromDate = new Date(now.getTime() - 30 * 24 * 3600000);
  // 'all' или неизвестное значение → без нижней границы
  return { from: fromDate ? fromDate.toISOString() : null, to: null };
}

function filterTablesByDate(tables, from, to) {
  if (!from && !to) return tables;
  let minTable = null, maxTable = null;
  if (from && from.length >= 7) minTable = `events_${from.slice(0, 4)}_${from.slice(5, 7)}`;
  if (to && to.length >= 7)     maxTable = `events_${to.slice(0, 4)}_${to.slice(5, 7)}`;
  return tables.filter(t => {
    if (minTable && t.name < minTable) return false;
    if (maxTable && t.name > maxTable) return false;
    return true;
  });
}

/**
 * Получить текущее числовое значение метрики, описанной панелью (или прямым конфигом).
 *
 * @param {object} db     — better-sqlite3 Database
 * @param {object} panel  — { type, agg, aggfield, range, filters, src(опционально) }
 * @param {string} src    — источник (владелец дашборда)
 * @returns {number}
 */
function queryMetricValue(db, panel, src) {
  const type      = panel.type || '';
  const agg       = panel.agg  || 'count';
  const aggfield  = panel.aggfield || '';
  const range     = panel.range || '24h';
  const filters   = Array.isArray(panel.filters) ? panel.filters : [];

  const { from, to } = resolveRange(range);

  const where = ['src = ?'];
  const params = [src];
  if (type) { where.push('type = ?'); params.push(type); }
  if (from) { where.push('ts >= ?'); params.push(from); }
  if (to)   { where.push('ts <= ?'); params.push(to); }

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
    } else if (op === 'in' && Array.isArray(f.value)) {
      if (f.value.length === 0) {
        where.push('1 = 0');
      } else {
        const placeholders = f.value.map(() => '?').join(',');
        where.push(`${col} IN (${placeholders})`);
        params.push(...f.value.map(String));
      }
    }
  }

  let aggExpr = 'COUNT(*)';
  if (agg === 'sum' && aggfield)      aggExpr = `SUM(json_extract(payload, '$."${safeField(aggfield)}"'))`;
  else if (agg === 'avg' && aggfield) aggExpr = `SUM(json_extract(payload, '$."${safeField(aggfield)}"'))`;
  else if (agg === 'max' && aggfield) aggExpr = `MAX(json_extract(payload, '$."${safeField(aggfield)}"'))`;
  else if (agg === 'min' && aggfield) aggExpr = `MIN(json_extract(payload, '$."${safeField(aggfield)}"'))`;
  else aggExpr = 'COUNT(*)';

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%' ORDER BY name"
  ).all();
  const filteredTables = filterTablesByDate(tables, from, to);

  let total = 0;
  let count = 0;
  for (const { name } of filteredTables) {
    try {
      const row = db.prepare(
        `SELECT ${aggExpr} AS v, COUNT(*) AS cnt FROM "${name}" WHERE ${where.join(' AND ')}`
      ).get(...params);
      if (row) {
        total += (row.v || 0);
        count += (row.cnt || 0);
      }
    } catch (_) { /* таблица могла не подойти под фильтр — пропускаем */ }
  }

  if (agg === 'avg') {
    total = count > 0 ? total / count : 0;
  }

  return Math.round(total * 100) / 100;
}

module.exports = { queryMetricValue };

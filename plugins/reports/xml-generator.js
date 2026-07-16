/**
 * plugins/reports/xml-generator.js — Серверная генерация XML-снимка дашборда
 *
 * Два режима:
 *   'full'    — полный снимок (точки, события, строки таблиц). Для отладки/импорта.
 *   'summary' — выжимка для рендерера картинки (EG): одна панель = одна строка
 *               <p v="тип" t="заголовок" x="главный показатель" d="тренд"/>.
 *               Вся агрегация и форматирование — на сервере, EG получает
 *               готовые строки и просто рисует карточки.
 */
'use strict';

const { xa } = require('../shared/xml-builder');
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

const MAX_EVENTS_PER_PANEL = 50;
const MAX_POINTS_PER_PANEL = 200;
const MAX_TABLE_ROWS       = 50;

/**
 * Сгенерировать XML-снимок дашборда.
 * @param {object} db          — better-sqlite3 Database
 * @param {string} dashboardId
 * @param {string} [mode]      — 'full' (по умолчанию) или 'summary'
 * @returns {Promise<string>}  — XML-строка
 */
async function generateDashboardXml(db, dashboardId, mode) {
  const summary = mode === 'summary';
  const dash = db.prepare(
    'SELECT id, name, src, panels_json FROM dashboards WHERE id = ?'
  ).get(dashboardId);
  if (!dash) throw new Error('dashboard_not_found');

  let panels = [];
  try { panels = JSON.parse(dash.panels_json); } catch (_) { panels = []; }
  const src = dash.src;
  const now = new Date().toISOString();

  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');

  if (summary) {
    // Компактный корневой тег для EG
    L.push(`<dash name="${xa(dash.name)}" src="${xa(src)}" ts="${xa(now)}">`);
    for (const p of panels) {
      try {
        const data = await queryPanelData(db, p, src, true);
        L.push(buildPanelSummaryXml(p, data));
      } catch (e) {
        console.error(`[xml-gen] panel "${p.title}" error:`, e.message);
        L.push(`  <p v="${xa(p.viz || '')}" t="${xa(p.title || '')}" x="—" s="err"/>`);
      }
    }
    L.push('</dash>');
    return L.join('\n');
  }

  L.push(`<pulse-dashboard name="${xa(dash.name)}" src="${xa(src)}" exported="${xa(now)}">`);

  for (const p of panels) {
    try {
      const data = await queryPanelData(db, p, src, false);
      L.push(...buildPanelXml(p, data));
    } catch (e) {
      console.error(`[xml-gen] panel "${p.title}" error:`, e.message);
      L.push(`  <panel viz="${xa(p.viz)}" title="${xa(p.title)}" error="${xa(e.message)}" />`);
    }
  }

  L.push('</pulse-dashboard>');
  return L.join('\n');
}

/**
 * Выполнить SQL-запрос для одной панели (серверный аналог loadPanel на клиенте).
 * @param {boolean} [summary] — лёгкий режим: минимум данных для headline-показателя
 */
async function queryPanelData(db, panel, src, summary) {
  const viz  = panel.viz  || 'line';
  const type = panel.type || '';
  const group = panel.group || '';
  const agg  = panel.agg  || 'count';
  const aggfield = panel.aggfield || '';
  const field = panel.field || '';
  const range = panel.range || '7d';
  const limit = panel.limit ? Math.min(Number(panel.limit), 500) : 500;
  const filters = Array.isArray(panel.filters) ? panel.filters : [];

  // Определяем from/to из range
  const { from, to } = resolveRange(range, panel.from, panel.to);

  // WHERE clause
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

  // Определяем таблицы
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%' ORDER BY name"
  ).all();
  const filteredTables = filterTablesByDate(tables, from, to);

  // ── logs: raw events ──
  if (viz === 'logs') {
    // summary: только количество событий, без payload
    if (summary) {
      let total = 0;
      for (const { name } of filteredTables) {
        try {
          const row = db.prepare(
            `SELECT COUNT(*) AS cnt FROM "${name}" WHERE ${where.join(' AND ')}`
          ).get(...params);
          if (row) total += (row.cnt || 0);
        } catch (_) {}
      }
      return { type: 'logs', count: total };
    }
    const rawLimit = Math.min(MAX_EVENTS_PER_PANEL, 50);
    const events = [];
    for (const { name } of filteredTables) {
      if (events.length >= rawLimit) break;
      const remaining = rawLimit - events.length;
      try {
        const rows = db.prepare(
          `SELECT ts, type, payload FROM "${name}" WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`
        ).all(...params, remaining);
        events.push(...rows);
      } catch (_) {}
    }
    events.sort((a, b) => b.ts.localeCompare(a.ts));
    return { type: 'logs', events: events.slice(0, rawLimit) };
  }

  // ── kpi / gauge: single value ──
  if (viz === 'kpi' || viz === 'gauge') {
    let aggExpr = 'COUNT(*)';
    if (agg.startsWith('sum:') && aggfield) {
      aggExpr = `SUM(json_extract(payload, '$."${safeField(aggfield)}"'))`;
    } else if (agg.startsWith('avg:') && aggfield) {
      aggExpr = `SUM(json_extract(payload, '$."${safeField(aggfield)}"'))`;
    } else if (agg.startsWith('max:') && aggfield) {
      aggExpr = `MAX(json_extract(payload, '$."${safeField(aggfield)}"'))`;
    } else if (agg.startsWith('min:') && aggfield) {
      aggExpr = `MIN(json_extract(payload, '$."${safeField(aggfield)}"'))`;
    } else if (agg === 'count' || !agg) {
      aggExpr = 'COUNT(*)';
    } else if (agg === 'sum' && aggfield) {
      aggExpr = `SUM(json_extract(payload, '$."${safeField(aggfield)}"'))`;
    } else if (agg === 'avg' && aggfield) {
      aggExpr = `AVG(json_extract(payload, '$."${safeField(aggfield)}"'))`;
    }

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
      } catch (_) {}
    }
    if (agg === 'avg' || agg.startsWith('avg:')) {
      total = count > 0 ? Math.round((total / count) * 100) / 100 : 0;
    }
    return { type: 'kpi', total: Math.round(total * 100) / 100 };
  }

  // ── table: grouped data ──
  if (viz === 'table') {
    let groupCol = 'type';
    if (group === '__field' && field && IDENT_RE.test(field)) {
      groupCol = `json_extract(payload, '$."${safeField(field)}"')`;
    }
    let aggExpr = 'COUNT(*)';
    if (agg.startsWith('sum:') && aggfield) {
      aggExpr = `SUM(json_extract(payload, '$."${safeField(aggfield)}"'))`;
    }

    const merged = {};
    for (const { name } of filteredTables) {
      try {
        const rows = db.prepare(
          `SELECT ${groupCol} AS g, ${aggExpr} AS v FROM "${name}" WHERE ${where.join(' AND ')} GROUP BY g ORDER BY v DESC LIMIT ?`
        ).all(...params, MAX_TABLE_ROWS);
        for (const r of rows) {
          const key = String(r.g ?? 'null');
          merged[key] = (merged[key] || 0) + (r.v || 0);
        }
      } catch (_) {}
    }
    const groups = Object.entries(merged)
      .map(([g, v]) => ({ key: g, value: agg === 'avg' ? Math.round(v * 100) / 100 : v }))
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
    const total = groups.reduce((s, r) => s + r.value, 0);
    return { type: 'table', groups, total };
  }

  // ── line / bar / pie: time-series or field-grouped ──
  {
    let groupExpr = '1';
    if (group === 'day')     groupExpr = 'date(ts)';
    else if (group === 'hour')    groupExpr = "strftime('%Y-%m-%d %H:00', ts)";
    else if (group === 'minute')  groupExpr = "strftime('%Y-%m-%d %H:%M', ts)";
    else if (group === 'week')    groupExpr = "strftime('%Y-W%W', ts)";
    else if (group === 'month')   groupExpr = "strftime('%Y-%m', ts)";
    else if (group === '__field' && field && IDENT_RE.test(field)) {
      groupExpr = `json_extract(payload, '$."${safeField(field)}"')`;
    }

    let aggExpr = 'COUNT(*)';
    let aggMode = 'count';
    if (agg.startsWith('sum:') && aggfield) {
      aggExpr = `SUM(json_extract(payload, '$."${safeField(aggfield)}"'))`;
      aggMode = 'sum';
    } else if (agg.startsWith('avg:') && aggfield) {
      aggExpr = `SUM(json_extract(payload, '$."${safeField(aggfield)}"'))`;
      aggMode = 'avg';
    } else if (agg === 'sum' && aggfield) {
      aggExpr = `SUM(json_extract(payload, '$."${safeField(aggfield)}"'))`;
      aggMode = 'sum';
    } else if (agg === 'avg' && aggfield) {
      aggExpr = `AVG(json_extract(payload, '$."${safeField(aggfield)}"'))`;
      aggMode = 'avg';
    }

    const merged = {};
    const countsForAvg = {};

    for (const { name } of filteredTables) {
      try {
        let sql;
        if (aggMode === 'avg' && !agg.startsWith('avg:')) {
          sql = `SELECT ${groupExpr} AS g, AVG(json_extract(payload, '$."${safeField(aggfield)}"')) AS v
                 FROM "${name}" WHERE ${where.join(' AND ')} GROUP BY g ORDER BY g`;
        } else if (aggMode === 'avg') {
          sql = `SELECT ${groupExpr} AS g,
                        SUM(json_extract(payload, '$."${safeField(aggfield)}"')) AS v,
                        COUNT(*) AS cnt
                 FROM "${name}" WHERE ${where.join(' AND ')} GROUP BY g ORDER BY g`;
        } else {
          sql = `SELECT ${groupExpr} AS g, ${aggExpr} AS v
                 FROM "${name}" WHERE ${where.join(' AND ')} GROUP BY g ORDER BY g`;
        }

        const rows = db.prepare(sql).all(...params);
        for (const r of rows) {
          const key = String(r.g ?? 'null');
          merged[key] = (merged[key] || 0) + (r.v || 0);
          if (aggMode === 'avg' && r.cnt !== undefined) {
            countsForAvg[key] = (countsForAvg[key] || 0) + r.cnt;
          }
        }
      } catch (_) {}
    }

    // Finalize avg
    if (aggMode === 'avg') {
      for (const key of Object.keys(merged)) {
        const cnt = countsForAvg[key] || 0;
        if (cnt > 0) merged[key] = merged[key] / cnt;
        else if (agg.startsWith('avg:')) merged[key] = 0;
      }
    }

    // Sort + limit
    let groups = Object.entries(merged).map(([g, v]) => ({
      key: g,
      value: aggMode === 'avg' ? Math.round(v * 100) / 100 : v,
    }));

    const isTimeGroup = ['day','hour','minute','week','month'].includes(group);
    const sort = panel.sort || 'key';
    // В summary-режиме для time-series всегда хронологический порядок:
    // headline = последняя точка, тренд = last vs first.
    if (summary && isTimeGroup) groups.sort((a, b) => String(a.key).localeCompare(String(b.key)));
    else if (sort === 'value_desc') groups.sort((a, b) => b.value - a.value);
    else if (sort === 'value_asc') groups.sort((a, b) => a.value - b.value);
    else groups.sort((a, b) => String(a.key).localeCompare(String(b.key)));

    if (groups.length > limit) groups.length = limit;

    const total = groups.reduce((s, r) => s + r.value, 0);
    return { type: 'series', groups, total: Math.round(total * 100) / 100 };
  }
}

/**
 * Собрать XML-строки для одной панели.
 */
function buildPanelXml(panel, data) {
  const L = [];
  const viz = panel.viz || '';

  if (data.type === 'kpi') {
    L.push(`  <panel viz="${xa(viz)}" title="${xa(panel.title)}">`);
    L.push(`    <data total="${xa(data.total)}" />`);
    L.push('  </panel>');
  }
  else if (data.type === 'logs') {
    L.push(`  <panel viz="${xa(viz)}" title="${xa(panel.title)}">`);
    L.push(`    <data events="${data.events.length}">`);
    for (const ev of data.events) {
      let msg = '';
      try {
        const pl = JSON.parse(ev.payload);
        const pkeys = Object.keys(pl);
        msg = pkeys.slice(0, 3).map(k => k + '=' + String(pl[k])).join(', ');
      } catch (_) {
        msg = String(ev.payload || '');
      }
      if (msg.length > 120) msg = msg.slice(0, 117) + '…';
      L.push(`      <event time="${xa(ev.ts)}" type="${xa(ev.type)}" msg="${xa(msg)}" />`);
    }
    L.push('    </data>');
    L.push('  </panel>');
  }
  else if (data.type === 'table') {
    L.push(`  <panel viz="${xa(viz)}" title="${xa(panel.title)}">`);
    L.push(`    <data total="${xa(data.total)}" rows="${data.groups.length}">`);
    for (const g of data.groups) {
      L.push(`      <row key="${xa(g.key)}" value="${g.value}" />`);
    }
    L.push('    </data>');
    L.push('  </panel>');
  }
  else {
    // series (line, bar, pie)
    L.push(`  <panel viz="${xa(viz)}" title="${xa(panel.title)}">`);
    L.push(`    <data points="${data.groups.length}" total="${xa(data.total)}">`);
    for (const g of data.groups) {
      L.push(`      <point label="${xa(g.key)}" value="${g.value}" />`);
    }
    L.push('    </data>');
    L.push('  </panel>');
  }

  return L;
}

/**
 * Собрать summary-строку для одной панели (режим 'summary').
 * Одна панель = один тег <p/>:
 *   v — тип визуализации, t — заголовок,
 *   x — главный показатель (уже отформатированная строка),
 *   d — тренд/дельта (опционально, только для time-series).
 */
function buildPanelSummaryXml(panel, data) {
  const viz = panel.viz || '';
  const title = panel.title || '';
  let x = '—';
  let d = '';

  if (data.type === 'kpi') {
    x = fmtNum(data.total);
  }
  else if (data.type === 'logs') {
    x = fmtNum(data.count != null ? data.count : (data.events ? data.events.length : 0));
  }
  else if (data.type === 'table') {
    if (data.groups && data.groups.length) {
      const top = data.groups[0];
      const share = data.total > 0 ? Math.round((top.value / data.total) * 100) : 0;
      x = `${top.key} — ${fmtNum(top.value)}`;
      if (data.groups.length > 1) d = `${share}%`;
    } else {
      x = '0';
    }
  }
  else if (data.type === 'series') {
    const groups = data.groups || [];
    if (groups.length) {
      const isTimeGroup = ['day','hour','minute','week','month'].includes(panel.group);
      if (isTimeGroup) {
        // Time-series: headline = последнее значение, тренд = last vs first
        const last = groups[groups.length - 1].value;
        const first = groups[0].value;
        x = fmtNum(last);
        if (first > 0 && groups.length > 1) {
          const pct = Math.round(((last - first) / first) * 100);
          d = (pct >= 0 ? '+' : '') + pct + '%';
        }
      } else {
        // Распределение по полю (pie/bar): топ-1 сегмент + доля
        const sorted = groups.slice().sort((a, b) => b.value - a.value);
        const top = sorted[0];
        const share = data.total > 0 ? Math.round((top.value / data.total) * 100) : 0;
        x = `${top.key} — ${share}%`;
      }
    } else {
      x = '0';
    }
  }

  const dAttr = d ? ` d="${xa(d)}"` : '';
  return `  <p v="${xa(viz)}" t="${xa(title)}" x="${xa(x)}"${dAttr}/>`;
}

// ── Вспомогательные функции ──

/**
 * Компактное форматирование числа для карточки: 1234 → "1.2K", 2500000 → "2.5M".
 * EG получает готовую строку и не занимается rounding.
 */
function fmtNum(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
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
  // range === 'all' → no from
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

module.exports = { generateDashboardXml, queryPanelData };

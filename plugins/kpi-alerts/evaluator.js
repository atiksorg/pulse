/**
 * plugins/kpi-alerts/evaluator.js — Evaluate KPI/Gauge panel value
 *
 * Mirrors front-end aggregation logic so the alert value equals the value
 * shown on the dashboard.
 *
 * Public API:
 *   evaluatePanelValue(db, dashboardId, panelId) -> { value, panel, dashboardName }
 */
'use strict';

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const RANGE_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function safeField(name) {
  return IDENT_RE.test(name) ? name : null;
}

function getDashboardRow(db, dashboardId) {
  return db.prepare('SELECT id, src, name, panels_json FROM dashboards WHERE id = ?').get(dashboardId);
}

function getPanelFromDashboard(dashboardRow, panelId) {
  if (!dashboardRow) {
    return { error: 'dashboard_not_found' };
  }

  let panels = [];
  try {
    panels = JSON.parse(dashboardRow.panels_json || '[]');
  } catch (_) {
    panels = [];
  }

  const panel = panels.find(p => p && p.id === panelId);
  if (!panel) {
    return { error: 'panel_not_found' };
  }

  if (panel.viz !== 'kpi' && panel.viz !== 'gauge') {
    return { error: 'unsupported_panel_type' };
  }

  return { panel };
}

function buildAggregation(p) {
  let aggMode = 'count';
  let aggExpr = 'COUNT(*)';
  let aggField = null;

  if (p.agg === 'sum' && p.aggfield && safeField(p.aggfield)) {
    aggMode = 'sum';
    aggField = safeField(p.aggfield);
    aggExpr = `SUM(json_extract(payload, '$."${aggField}"'))`;
  } else if (p.agg === 'avg' && p.aggfield && safeField(p.aggfield)) {
    aggMode = 'avg';
    aggField = safeField(p.aggfield);
    aggExpr = `SUM(json_extract(payload, '$."${aggField}"'))`;
  } else if (p.agg === 'min' && p.aggfield && safeField(p.aggfield)) {
    aggMode = 'min';
    aggField = safeField(p.aggfield);
    aggExpr = `MIN(json_extract(payload, '$."${aggField}"'))`;
  } else if (p.agg === 'max' && p.aggfield && safeField(p.aggfield)) {
    aggMode = 'max';
    aggField = safeField(p.aggfield);
    aggExpr = `MAX(json_extract(payload, '$."${aggField}"'))`;
  }

  return { aggMode, aggExpr, aggField };
}

function buildFilterWhereClauses(filters, params) {
  const clauses = [];

  for (const f of filters || []) {
    if (!f || !f.field || !f.op) {
      continue;
    }

    const field = safeField(f.field.trim());
    if (!field) {
      continue;
    }

    const col = `json_extract(payload, '$."${field}"')`;
    const op = String(f.op).toLowerCase();

    if (op === 'eq') {
      const value = f.value !== undefined ? String(f.value) : '';
      clauses.push(`(${col} = ? OR ${col} = ?)`);
      params.push(value, String(Number(value)));
    } else if (op === 'neq') {
      const value = f.value !== undefined ? String(f.value) : '';
      clauses.push(`(${col} != ? OR ${col} IS NULL OR ${col} = '')`);
      params.push(value);
    } else if (op === 'gt' || op === 'lt') {
      const value = Number(f.value);
      if (Number.isFinite(value)) {
        clauses.push(`CAST(${col} AS REAL) ${op === 'gt' ? '>' : '<'} ?`);
        params.push(value);
      }
    } else if (op === 'in') {
      const values = Array.isArray(f.value) ? f.value.map(String) : [];
      if (values.length > 0) {
        clauses.push(`${col} IN (${values.map(() => '?').join(',')})`);
        params.push(...values);
      }
    } else if (op === 'contains') {
      const value = f.value !== undefined ? String(f.value) : '';
      if (value.length > 0) {
        clauses.push(`${col} LIKE ?`);
        params.push(`%${value}%`);
      }
    }
  }

  return clauses;
}

function buildWhere(src, p) {
  const where = ['src = ?'];
  const params = [src];

  if (p.type) {
    where.push('type = ?');
    params.push(p.type);
  }

  if (p.range && p.range !== 'all') {
    if (p.range === 'custom') {
      if (p.from) {
        where.push('ts >= ?');
        params.push(p.from);
      }
      if (p.to) {
        where.push('ts <= ?');
        params.push(p.to);
      }
    } else {
      const ms = RANGE_MS[p.range];
      if (ms) {
        where.push('ts >= ?');
        params.push(new Date(Date.now() - ms).toISOString());
      }
    }
  }

  if (Array.isArray(p.filters) && p.filters.length > 0) {
    const clauses = buildFilterWhereClauses(p.filters, params);
    where.push(...clauses);
  }

  return { where, params };
}

function computeFinalValue(aggMode, raw, counts) {
  if (aggMode === 'avg') {
    const count = counts || 0;
    return count > 0 ? Math.round((raw / count) * 100) / 100 : 0;
  }

  return raw || 0;
}

function getTableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%' ORDER BY name").all();
}

async function evaluatePanelValue(db, dashboardId, panelId) {
  const dashboardRow = getDashboardRow(db, dashboardId);
  const { panel, error } = getPanelFromDashboard(dashboardRow, panelId);

  if (error) {
    return { ok: false, error };
  }

  const { aggMode, aggExpr } = buildAggregation(panel);
  const { where, params } = buildWhere(dashboardRow.src, panel);
  const tables = getTableNames(db);

  let raw = 0;
  let count = 0;

  for (const tableRow of tables) {
    try {
      const sql = `SELECT ${aggExpr} AS v, COUNT(*) AS c FROM "${tableRow.name}" WHERE ${where.join(' AND ')}`;
      const row = db.prepare(sql).get(...params);

      raw += row && row.v != null ? Number(row.v) : 0;
      count += row && row.c != null ? Number(row.c) : 0;
    } catch (e) {
      console.error(`[kpi-alerts] evaluator table read error: ${tableRow.name}:`, e.message);
    }
  }

  return {
    ok: true,
    value: computeFinalValue(aggMode, raw, count),
    panel,
    dashboardName: dashboardRow ? dashboardRow.name : ''
  };
}

module.exports = {
  evaluatePanelValue
};

/**
 * plugins/alert/evaluator.js — Умный evaluator для алертов
 *
 * Получает правило (rule) с dashboard_id + panel_id,
 * читает конфигурацию панели из таблицы dashboards,
 * генерирует SQL-запрос (аналог /s endpoint) и выполняет
 * агрегацию по таблицам events_YYYY_MM.
 *
 * @param {object} rule — строка из alert_rules (dashboard_id, panel_id, ...)
 * @param {object} db   — better-sqlite3 Database
 * @returns {number|null} числовое значение метрики или null если данных нет
 */
'use strict';

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

function safeField(name) {
    if (!name) return null;
    return IDENT_RE.test(name) ? name : null;
}

/* ── Временной диапазон ──────────────────────────────── */
function getTimeRange(range, from, to) {
    var now = Date.now();
    var fromTs = null;
    var toTs = null;

    switch (range) {
        case '1h':   fromTs = new Date(now - 3600000).toISOString(); break;
        case '3h':   fromTs = new Date(now - 3 * 3600000).toISOString(); break;
        case '6h':   fromTs = new Date(now - 6 * 3600000).toISOString(); break;
        case '12h':  fromTs = new Date(now - 12 * 3600000).toISOString(); break;
        case '24h':  fromTs = new Date(now - 86400000).toISOString(); break;
        case '3d':   fromTs = new Date(now - 3 * 86400000).toISOString(); break;
        case '7d':   fromTs = new Date(now - 7 * 86400000).toISOString(); break;
        case '14d':  fromTs = new Date(now - 14 * 86400000).toISOString(); break;
        case '30d':  fromTs = new Date(now - 30 * 86400000).toISOString(); break;
        case 'all':  break; // без фильтра по времени
        case 'custom':
            fromTs = from || null;
            toTs   = to   || null;
            break;
        default:
            fromTs = new Date(now - 86400000).toISOString(); // 24h по умолчанию
            break;
    }

    return { from: fromTs, to: toTs };
}

/* ── Фильтры из конфига панели → WHERE clauses ─────── */
function buildFilterWhereClauses(filters, params) {
    var clauses = [];
    if (!Array.isArray(filters)) return clauses;

    for (var i = 0; i < filters.length; i++) {
        var f = filters[i];
        if (!f || !f.field) continue;
        var field = safeField(f.field);
        if (!field) continue;

        var col = "json_extract(payload, '$.\"" + field + "\"')";

        switch (f.op) {
            case 'eq':
                clauses.push('(' + col + ' = ? OR ' + col + ' = ?)');
                params.push(f.value, String(f.value));
                break;
            case 'neq':
                clauses.push('(' + col + ' != ? OR ' + col + ' IS NULL OR ' + col + " = '')");
                params.push(String(f.value));
                break;
            case 'gt':
                clauses.push('CAST(' + col + ' AS REAL) > ?');
                params.push(Number(f.value));
                break;
            case 'lt':
                clauses.push('CAST(' + col + ' AS REAL) < ?');
                params.push(Number(f.value));
                break;
            case 'in':
                if (Array.isArray(f.value) && f.value.length > 0) {
                    var placeholders = f.value.map(function () { return '?'; }).join(',');
                    clauses.push(col + ' IN (' + placeholders + ')');
                    for (var j = 0; j < f.value.length; j++) params.push(String(f.value[j]));
                }
                break;
            case 'contains':
                clauses.push(col + ' LIKE ?');
                params.push('%' + f.value + '%');
                break;
        }
    }

    return clauses;
}

/* ── Отфильтровать таблицы events_YYYY_MM по дате ───── */
function filterTablesByDate(tables, from, to) {
    if (!from && !to) return tables;

    var minTable = null;
    var maxTable = null;

    if (from && from.length >= 7) {
        minTable = 'events_' + from.slice(0, 4) + '_' + from.slice(5, 7);
    }
    if (to && to.length >= 7) {
        maxTable = 'events_' + to.slice(0, 4) + '_' + to.slice(5, 7);
    }

    return tables.filter(function (t) {
        if (minTable && t.name < minTable) return false;
        if (maxTable && t.name > maxTable) return false;
        return true;
    });
}

/* ═══════════════════════════════════════════════════════
   evaluateRule — главная функция
   ═══════════════════════════════════════════════════════ */
async function evaluateRule(rule, db) {
    try {
        /* 1. Читаем дашборд → получаем src */
        var dashboard = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(rule.dashboard_id);
        if (!dashboard) {
            console.warn('[evaluator] dashboard not found: ' + rule.dashboard_id);
            return null;
        }

        var src = dashboard.src;

        /* 2. Парсим panels_json → ищем панель */
        var panels;
        try { panels = JSON.parse(dashboard.panels_json || '[]'); } catch (_) { panels = []; }

        var panel = null;
        for (var i = 0; i < panels.length; i++) {
            if (panels[i].id === rule.panel_id) { panel = panels[i]; break; }
        }
        if (!panel) {
            console.warn('[evaluator] panel not found: ' + rule.panel_id + ' in dashboard ' + rule.dashboard_id);
            return null;
        }

        /* 3. Временной диапазон */
        var timeRange = getTimeRange(panel.range, panel.from, panel.to);

        /* 4. Получаем список таблиц events_YYYY_MM */
        var allTables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%' ORDER BY name"
        ).all();
        var tables = filterTablesByDate(allTables, timeRange.from, timeRange.to);
        if (tables.length === 0) return null;

        /* 5. Строим WHERE */
        var where  = ['src = ?'];
        var params = [src];

        if (panel.type) {
            where.push('type = ?');
            params.push(panel.type);
        }
        if (timeRange.from) {
            where.push('ts >= ?');
            params.push(timeRange.from);
        }
        if (timeRange.to) {
            where.push('ts <= ?');
            params.push(timeRange.to);
        }

        var filterClauses = buildFilterWhereClauses(panel.filters, params);
        for (var fi = 0; fi < filterClauses.length; fi++) where.push(filterClauses[fi]);

        var whereStr = where.join(' AND ');

        /* 6. Определяем агрегацию */
        var agg      = panel.agg || 'count';
        var aggField = safeField(panel.aggfield);

        // Для sum/avg/min/max — aggfield обязателен
        if (agg !== 'count' && !aggField) {
            console.warn('[evaluator] aggfield required for agg=' + agg + ' in rule ' + rule.id);
            return null;
        }

        /* 7. Выполняем агрегацию по всем таблицам */
        if (agg === 'avg') {
            // AVG = SUM / COUNT — нужны оба значения из каждой таблицы
            var totalSum   = 0;
            var totalCount = 0;
            var avgExpr = "SUM(json_extract(payload, '$.\"" + aggField + "\"'))";

            for (var ti = 0; ti < tables.length; ti++) {
                try {
                    var stmt = db.prepare(
                        'SELECT ' + avgExpr + ' AS s, COUNT(*) AS c FROM "' + tables[ti].name + '" WHERE ' + whereStr
                    );
                    var r = stmt.get.apply(stmt, params);
                    if (r) {
                        totalSum   += (r.s || 0);
                        totalCount += (r.c || 0);
                    }
                } catch (e) {
                    console.error('[evaluator] query error on ' + tables[ti].name + ': ' + e.message);
                }
            }

            return totalCount > 0 ? Math.round((totalSum / totalCount) * 100) / 100 : null;
        }

        // Для count, sum, min, max
        var aggExpr;
        switch (agg) {
            case 'sum':
                aggExpr = "SUM(json_extract(payload, '$.\"" + aggField + "\"'))";
                break;
            case 'min':
                aggExpr = "MIN(json_extract(payload, '$.\"" + aggField + "\"'))";
                break;
            case 'max':
                aggExpr = "MAX(json_extract(payload, '$.\"" + aggField + "\"'))";
                break;
            default: // count
                aggExpr = 'COUNT(*)';
                break;
        }

        var result = null;

        for (var ti3 = 0; ti3 < tables.length; ti3++) {
            try {
                var stmt3 = db.prepare(
                    'SELECT ' + aggExpr + ' AS val FROM "' + tables[ti3].name + '" WHERE ' + whereStr
                );
                var r3 = stmt3.get.apply(stmt3, params);

                if (r3 && r3.val !== null && r3.val !== undefined) {
                    if (agg === 'min') {
                        result = result === null ? r3.val : Math.min(result, r3.val);
                    } else if (agg === 'max') {
                        result = result === null ? r3.val : Math.max(result, r3.val);
                    } else {
                        // count и sum — суммируем
                        result = (result || 0) + r3.val;
                    }
                }
            } catch (e) {
                console.error('[evaluator] query error on ' + tables[ti3].name + ': ' + e.message);
            }
        }

        return result;

    } catch (e) {
        console.error('[evaluator] fatal error for rule ' + (rule && rule.id) + ': ' + e.message);
        return null;
    }
}

module.exports = { evaluateRule };

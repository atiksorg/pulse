/**
 * plugins/threshold-alerts/metric-query.js — Получить текущее скалярное значение панели
 *
 * Работает как kpi/gauge-ветка в plugins/reports/xml-generator.js::queryPanelData,
 * но самодостаточно (без зависимости от плагина reports), т.к. threshold-alerts
 * должен работать даже если reports не установлен.
 *
 * Поддерживает: agg = count | sum | avg | max | min (+ aggfield), range, filters.
 * Расширения: group_field/group_value, delta_pct, anomaly (z-score).
 */
'use strict';

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

function safeField(name) {
  return IDENT_RE.test(name) ? name : null;
}

function resolveRange(range) {
  const now = new Date();
  let fromDate = null;
  if (range === '1h')       fromDate = new Date(now.getTime() - 1 * 3600000);
  else if (range === '6h')  fromDate = new Date(now.getTime() - 6 * 3600000);
  else if (range === '24h') fromDate = new Date(now.getTime() - 24 * 3600000);
  else if (range === '7d')  fromDate = new Date(now.getTime() - 7 * 24 * 3600000);
  else if (range === '30d') fromDate = new Date(now.getTime() - 30 * 24 * 3600000);
  // 'all' или неизвестное значение → без нижней границы
  return { from: fromDate ? fromDate.toISOString() : null, to: null };
}

/** Вернуть длительность range в миллисекундах */
function rangeMs(range) {
  if (range === '1h')  return 1 * 3600000;
  if (range === '6h')  return 6 * 3600000;
  if (range === '24h') return 24 * 3600000;
  if (range === '7d')  return 7 * 24 * 3600000;
  if (range === '30d') return 30 * 24 * 3600000;
  return 24 * 3600000; // fallback
}

/** Resolve range с offset (сдвиг окна назад на offsetMs) */
function resolveRangeWithOffset(range, offsetMs) {
  const now = new Date();
  const ms = rangeMs(range);
  const fromDate = new Date(now.getTime() - offsetMs - ms);
  const toDate = new Date(now.getTime() - offsetMs);
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
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

/** Построить WHERE + params по фильтрам */
function buildWhere(src, type, from, to, filters, groupField, groupValue) {
  const where = ['src = ?'];
  const params = [src];
  if (type) { where.push('type = ?'); params.push(type); }
  if (from) { where.push('ts >= ?'); params.push(from); }
  if (to)   { where.push('ts <= ?'); params.push(to); }

  // ── Групповой фильтр (категория bar chart) ──
  if (groupField && IDENT_RE.test(groupField)) {
    const col = `json_extract(payload, '$."${groupField}"')`;
    if (groupValue !== undefined && groupValue !== null && groupValue !== '') {
      where.push(`${col} = ?`);
      params.push(String(groupValue));
    }
  }

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
  return { where, params };
}

/** Построить агрегатное выражение */
function buildAggExpr(agg, aggfield) {
  const safe = aggfield ? safeField(aggfield) : null;
  if (agg === 'sum' && safe) return { expr: `SUM(json_extract(payload, '$."${safe}"'))`, needsCount: false };
  if (agg === 'avg' && safe) return { expr: `SUM(json_extract(payload, '$."${safe}"'))`, needsCount: true };
  if (agg === 'max' && safe) return { expr: `MAX(json_extract(payload, '$."${safe}"'))`, needsCount: false };
  if (agg === 'min' && safe) return { expr: `MIN(json_extract(payload, '$."${safe}"'))`, needsCount: false };
  return { expr: 'COUNT(*)', needsCount: false };
}

/**
 * Получить текущее числовое значение метрики.
 *
 * @param {object} db     — better-sqlite3 Database
 * @param {object} panel  — { type, agg, aggfield, range, filters, groupField, groupValue }
 * @param {string} src    — источник
 * @param {object} [override] — { from, to } для кастомного диапазона
 * @returns {number}
 */
function queryMetricValue(db, panel, src, override) {
  const type       = panel.type || '';
  const agg        = panel.agg  || 'count';
  const aggfield   = panel.aggfield || '';
  const range      = panel.range || '24h';
  const filters    = Array.isArray(panel.filters) ? panel.filters : [];
  const groupField = panel.groupField || panel.group_field || '';
  const groupValue = panel.groupValue !== undefined ? panel.groupValue : (panel.group_value || '');

  const r = override || resolveRange(range);
  const from = r.from || null;
  const to   = r.to   || null;

  const { where, params } = buildWhere(src, type, from, to, filters, groupField, groupValue);
  const { expr, needsCount } = buildAggExpr(agg, aggfield);

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%' ORDER BY name"
  ).all();
  const filteredTables = filterTablesByDate(tables, from, to);

  let total = 0;
  let count = 0;
  for (const { name } of filteredTables) {
    try {
      const selectCols = needsCount ? `${expr} AS v, COUNT(*) AS cnt` : `${expr} AS v`;
      const row = db.prepare(
        `SELECT ${selectCols} FROM "${name}" WHERE ${where.join(' AND ')}`
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

/**
 * Получить список уникальных значений поля groupField (для автодополнения в UI).
 *
 * @param {object} db
 * @param {object} panel — { type, range, filters }
 * @param {string} src
 * @param {string} groupField
 * @returns {string[]}
 */
function queryGroupValues(db, panel, src, groupField) {
  if (!groupField || !IDENT_RE.test(groupField)) return [];

  const type    = panel.type || '';
  const range   = panel.range || '24h';
  const filters = Array.isArray(panel.filters) ? panel.filters : [];
  const { from, to } = resolveRange(range);

  const where = ['src = ?'];
  const params = [src];
  if (type) { where.push('type = ?'); params.push(type); }
  if (from) { where.push('ts >= ?'); params.push(from); }
  if (to)   { where.push('ts <= ?'); params.push(to); }

  const col = `json_extract(payload, '$."${groupField}"')`;

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%' ORDER BY name"
  ).all();
  const filteredTables = filterTablesByDate(tables, from, to);

  const values = new Set();
  for (const { name } of filteredTables) {
    try {
      const rows = db.prepare(
        `SELECT DISTINCT ${col} AS v FROM "${name}" WHERE ${where.join(' AND ')} AND ${col} IS NOT NULL LIMIT 50`
      ).all(...params);
      for (const r of rows) {
        if (r.v !== null && r.v !== undefined) values.add(String(r.v));
      }
    } catch (_) {}
  }
  return Array.from(values).sort().slice(0, 50);
}

/**
 * Delta-проверка: сравнить текущее значение с предыдущим периодом.
 * Возвращает { current, previous, deltaPct }.
 *
 * @param {object} db
 * @param {object} cfg — alert_config row
 * @param {string} src
 * @returns {{ current: number, previous: number, deltaPct: number|null }}
 */
function queryDeltaValue(db, cfg, src) {
  const panel = {
    type: cfg.panel_type,
    agg: cfg.panel_agg,
    aggfield: cfg.panel_aggfield,
    range: cfg.panel_range,
    filters: safeParseFilters(cfg.panel_filters),
    groupField: cfg.group_field,
    groupValue: cfg.group_value,
  };

  const deltaRange = cfg.delta_range || cfg.panel_range || '1h';
  const offsetMs = rangeMs(deltaRange);

  // Текущий период: [now - deltaRange .. now]
  const current = queryMetricValue(db, { ...panel, range: deltaRange }, src);
  // Предыдущий период: [now - 2*deltaRange .. now - deltaRange]
  const prev = queryMetricValue(db, { ...panel, range: deltaRange }, src, resolveRangeWithOffset(deltaRange, offsetMs));

  let deltaPct = null;
  if (prev !== 0) {
    deltaPct = Math.round((current - prev) / Math.abs(prev) * 10000) / 100;
  }

  return { current, previous: prev, deltaPct };
}

/**
 * Anomaly-проверка: вычислить z-score текущего значения относительно N предыдущих периодов.
 *
 * @param {object} db
 * @param {object} cfg
 * @param {string} src
 * @returns {{ current: number, mean: number, stdDev: number, zScore: number }}
 */
function queryAnomalyValue(db, cfg, src) {
  const panel = {
    type: cfg.panel_type,
    agg: cfg.panel_agg,
    aggfield: cfg.panel_aggfield,
    range: cfg.panel_range,
    filters: safeParseFilters(cfg.panel_filters),
    groupField: cfg.group_field,
    groupValue: cfg.group_value,
  };

  const window = Math.max(2, Math.min(30, cfg.anomaly_window || 7));
  const periodMs = rangeMs(cfg.panel_range || '24h');

  // Собрать значения за N предыдущих периодов (отложенных от текущего)
  const values = [];
  for (let i = 1; i <= window; i++) {
    const r = resolveRangeWithOffset(cfg.panel_range || '24h', periodMs * i);
    const v = queryMetricValue(db, panel, src, r);
    values.push(v);
  }

  const current = queryMetricValue(db, panel, src);

  if (values.length < 2) {
    return { current, mean: current, stdDev: 0, zScore: 0 };
  }

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  const zScore = stdDev > 0 ? Math.round((current - mean) / stdDev * 100) / 100 : 0;

  return { current, mean: Math.round(mean * 100) / 100, stdDev: Math.round(stdDev * 100) / 100, zScore };
}

function safeParseFilters(json) {
  if (!json) return [];
  try { return typeof json === 'string' ? JSON.parse(json) : json; } catch (_) { return []; }
}

// ═══════════════════════════════════════════════════
// Formula Mode: Safe Expression Evaluator
// ═══════════════════════════════════════════════════

/**
 * FormulaEvaluator — безопасный парсер и вычислитель математических формул.
 * Поддерживает: числа, переменные {name}, операторы + - * / % ^,
 * сравнения > < >= <= == !=, скобки, функции min/max/abs/ceil/floor/round.
 */
class FormulaEvaluator {
  constructor(formula) {
    this.formula = formula;
    this.pos = 0;
    this.tokens = this.tokenize(formula);
    this.tokPos = 0;
  }

  tokenize(s) {
    const tokens = [];
    let i = 0;
    while (i < s.length) {
      if (/\s/.test(s[i])) { i++; continue; }
      if (s[i] === '{') {
        const end = s.indexOf('}', i);
        if (end === -1) throw new Error('Незакрытая { на позиции ' + i);
        tokens.push({ type: 'var', value: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
      if (/[0-9.]/.test(s[i])) {
        let num = '';
        while (i < s.length && /[0-9.]/.test(s[i])) { num += s[i]; i++; }
        tokens.push({ type: 'num', value: parseFloat(num) });
        continue;
      }
      if (/[a-zA-Z_]/.test(s[i])) {
        let name = '';
        while (i < s.length && /[a-zA-Z_0-9]/.test(s[i])) { name += s[i]; i++; }
        tokens.push({ type: 'ident', value: name });
        continue;
      }
      const two = s.slice(i, i + 2);
      if (['>=', '<=', '==', '!='].includes(two)) {
        tokens.push({ type: 'op', value: two }); i += 2; continue;
      }
      if ('+-*/%^()>'.includes(s[i])) {
        if (s[i] === '<' || s[i] === '>') {
          tokens.push({ type: 'op', value: s[i] });
        } else {
          tokens.push({ type: 'punc', value: s[i] });
        }
        i++; continue;
      }
      throw new Error('Неизвестный символ: ' + s[i] + ' на позиции ' + i);
    }
    return tokens;
  }

  peek() { return this.tokPos < this.tokens.length ? this.tokens[this.tokPos] : null; }
  next() { return this.tokens[this.tokPos++]; }

  parse() { const e = this.parseLogic(); return e; }

  parseLogic() {
    let left = this.parseComparison();
    while (true) {
      const t = this.peek();
      if (t && t.type === 'ident' && (t.value === 'AND' || t.value === 'OR')) {
        this.next();
        const right = this.parseComparison();
        left = { type: 'binop', op: t.value, left, right };
      } else break;
    }
    return left;
  }

  parseComparison() {
    let left = this.parseExpression();
    const t = this.peek();
    if (t && t.type === 'op' && ['>', '<', '>=', '<=', '==', '!='].includes(t.value)) {
      this.next();
      const right = this.parseExpression();
      return { type: 'binop', op: t.value, left, right };
    }
    return left;
  }

  parseExpression() {
    let left = this.parseTerm();
    while (true) {
      const t = this.peek();
      if (t && t.type === 'punc' && (t.value === '+' || t.value === '-')) {
        this.next();
        const right = this.parseTerm();
        left = { type: 'binop', op: t.value, left, right };
      } else break;
    }
    return left;
  }

  parseTerm() {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (t && t.type === 'punc' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        this.next();
        const right = this.parseUnary();
        left = { type: 'binop', op: t.value, left, right };
      } else break;
    }
    return left;
  }

  parseUnary() {
    const t = this.peek();
    if (t && t.type === 'punc' && t.value === '-') {
      this.next();
      const expr = this.parsePower();
      return { type: 'unary', op: '-', expr };
    }
    return this.parsePower();
  }

  parsePower() {
    let base = this.parseFactor();
    const t = this.peek();
    if (t && t.type === 'punc' && t.value === '^') {
      this.next();
      const exp = this.parseUnary();
      return { type: 'binop', op: '^', left: base, right: exp };
    }
    return base;
  }

  parseFactor() {
    const t = this.peek();
    if (!t) throw new Error('Неожиданный конец формулы');
    if (t.type === 'num') { this.next(); return { type: 'num', value: t.value }; }
    if (t.type === 'var') { this.next(); return { type: 'var', name: t.value }; }
    if (t.type === 'punc' && t.value === '(') {
      this.next();
      const expr = this.parseComparison();
      if (!this.peek() || this.peek().value !== ')') throw new Error('Ожидается )');
      this.next();
      return expr;
    }
    if (t.type === 'ident') {
      this.next();
      const funcs = ['min', 'max', 'abs', 'ceil', 'floor', 'round', 'sqrt', 'log'];
      if (funcs.includes(t.value)) {
        if (!this.peek() || this.peek().value !== '(') throw new Error('Ожидается ( после ' + t.value);
        this.next();
        const args = [];
        if (this.peek() && this.peek().value !== ')') {
          args.push(this.parseComparison());
          while (this.peek() && this.peek().type === 'punc' && this.peek().value === ',') {
            this.next();
            args.push(this.parseComparison());
          }
        }
        if (!this.peek() || this.peek().value !== ')') throw new Error('Ожидается )');
        this.next();
        return { type: 'call', name: t.value, args };
      }
      return { type: 'var', name: t.value };
    }
    throw new Error('Неожиданный токен: ' + JSON.stringify(t));
  }

  eval(node, vars) {
    if (node.type === 'num') return node.value;
    if (node.type === 'var') {
      if (vars && vars[node.name] !== undefined) return vars[node.name];
      throw new Error('Переменная {' + node.name + '} не найдена');
    }
    if (node.type === 'unary') return -this.eval(node.expr, vars);
    if (node.type === 'binop') {
      const l = this.eval(node.left, vars);
      const r = this.eval(node.right, vars);
      if (node.op === '+') return l + r;
      if (node.op === '-') return l - r;
      if (node.op === '*') return l * r;
      if (node.op === '/') return r === 0 ? (l >= 0 ? Infinity : -Infinity) : l / r;
      if (node.op === '%') return r === 0 ? 0 : l % r;
      if (node.op === '^') return Math.pow(l, r);
      if (node.op === '>') return l > r ? 1 : 0;
      if (node.op === '<') return l < r ? 1 : 0;
      if (node.op === '>=') return l >= r ? 1 : 0;
      if (node.op === '<=') return l <= r ? 1 : 0;
      if (node.op === '==') return l === r ? 1 : 0;
      if (node.op === '!=') return l !== r ? 1 : 0;
      if (node.op === 'AND') return (l > 0 && r > 0) ? 1 : 0;
      if (node.op === 'OR') return (l > 0 || r > 0) ? 1 : 0;
    }
    if (node.type === 'call') {
      const args = node.args.map(a => this.eval(a, vars));
      if (node.name === 'min') return Math.min(...args);
      if (node.name === 'max') return Math.max(...args);
      if (node.name === 'abs') return Math.abs(args[0]);
      if (node.name === 'ceil') return Math.ceil(args[0]);
      if (node.name === 'floor') return Math.floor(args[0]);
      if (node.name === 'round') return Math.round(args[0] * 100) / 100;
      if (node.name === 'sqrt') return Math.sqrt(args[0]);
      if (node.name === 'log') return Math.log(args[0]);
      throw new Error('Неизвестная функция: ' + node.name);
    }
    throw new Error('Неизвестный узел: ' + JSON.stringify(node));
  }

  evaluate(vars) {
    this.tokPos = 0;
    const ast = this.parse();
    if (this.tokPos < this.tokens.length) {
      throw new Error('Лишние токены после позиции ' + this.tokPos);
    }
    return this.eval(ast, vars);
  }

  /**
   * Валидация формулы: проверить синтаксис без вычисления.
   * Возвращает { valid, error }
   */
  static validate(formula) {
    try {
      const ev = new FormulaEvaluator(formula);
      ev.tokPos = 0;
      const ast = ev.parse();
      if (ev.tokPos < ev.tokens.length) {
        return { valid: false, error: 'Лишние символы в позиции ' + ev.tokPos };
      }
      return { valid: true, error: null };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }

  /** Извлечь имена переменных {var} из формулы */
  static extractVariables(formula) {
    const vars = new Set();
    const re = /\{([^}]+)\}/g;
    let m;
    while ((m = re.exec(formula)) !== null) {
      vars.add(m[1]);
    }
    return Array.from(vars);
  }
}

/**
 * Получить текущие значения всех метрик-алиасов из formula_conditions,
 * подставить в формулу и вычислить результат.
 *
 * @param {object} db
 * @param {object} cfg — alert_config row
 * @param {string} src
 * @returns {{ result: number, metrics: Object, formula: string }}
 */
function resolveFormulaMetrics(db, cfg, src) {
  const formulaText = cfg.formula_text || '';
  if (!formulaText) throw new Error('formula_text пуст');

  let conditions = [];
  try {
    conditions = typeof cfg.formula_conditions === 'string'
      ? JSON.parse(cfg.formula_conditions) : cfg.formula_conditions;
  } catch (_) { conditions = []; }
  if (!Array.isArray(conditions)) conditions = [];

  // Собираем уникальные метрики из conditions
  const metricMap = {};
  const range = cfg.panel_range || '24h';

  for (const cond of conditions) {
    for (const sideKey of ['left_metric', 'right_metric']) {
      const m = cond[sideKey];
      if (!m || m.type !== 'metric' || !m.name) continue;
      if (metricMap[m.name]) continue;
      metricMap[m.name] = {
        type: cfg.panel_type || '',
        agg: m.agg || 'count',
        aggfield: m.aggfield || '',
        range: m.range || range,
        filters: safeParseFilters(cfg.panel_filters),
        groupField: cfg.group_field,
        groupValue: cfg.group_value,
      };
    }
  }

  // Если метрик нет — возвращаем 0
  if (Object.keys(metricMap).length === 0) {
    return { result: 0, metrics: {}, formula: formulaText };
  }

  const metrics = {};
  for (const [name, panel] of Object.entries(metricMap)) {
    try {
      metrics[name] = queryMetricValue(db, panel, src);
    } catch (_) {
      metrics[name] = 0;
    }
  }

  const ev = new FormulaEvaluator(formulaText);
  const result = ev.evaluate(metrics);

  return {
    result: Math.round((isNaN(result) ? 0 : result) * 100) / 100,
    metrics,
    formula: formulaText,
  };
}

module.exports = {
  queryMetricValue, queryGroupValues, queryDeltaValue, queryAnomalyValue,
  resolveRange, rangeMs,
  FormulaEvaluator, resolveFormulaMetrics
};

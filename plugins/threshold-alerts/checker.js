/**
 * plugins/threshold-alerts/checker.js — Проверка одного правила и отправка алерта
 *
 * State machine на конфиге (config.state):
 *   'ok'       → 'breached'  : метрика вышла за диапазон → отправляем алерт
 *   'breached' → 'breached'  : остаётся вне диапазона → молчим, пока не истёк cooldown_sec
 *   'breached' → 'ok'        : вернулась в диапазон → (опционально) отправляем «восстановлено»
 *
 * Режимы проверки (config.check_mode):
 *   'absolute'  — значение vs порог (min/max)
 *   'delta_pct' — изменение в % между текущим и предыдущим периодом
 *   'anomaly'   — z-score отклонение от среднего за N предыдущих периодов
 *
 * Поведение при пустых данных (config.on_empty):
 *   'treat_as_zero' — 0 как обычное значение (по умолчанию)
 *   'alert'         — 0 = всегда аномалия
 *   'ignore'        — 0 = пропустить проверку
 */
'use strict';

const { queryMetricValue, queryDeltaValue, queryAnomalyValue } = require('./metric-query');
const { broadcastTelegramMessage } = require('./telegram-client');

/**
 * Определить направление нарушения диапазона.
 * @returns {'above'|'below'|null}
 */
function detectBreach(value, min, max) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (max !== null && max !== undefined && value > max) return 'above';
  if (min !== null && min !== undefined && value < min) return 'below';
  return null;
}

/**
 * Найти подходящий severity из thresholds_json.
 * Возвращает { severity, chatIds } или null если ни один порог не сработал.
 */
function findMatchingThreshold(thresholdsJson, value) {
  if (!Array.isArray(thresholdsJson) || !thresholdsJson.length) return null;
  for (const t of thresholdsJson) {
    const tMin = t.min !== null && t.min !== undefined && t.min !== '' ? Number(t.min) : null;
    const tMax = t.max !== null && t.max !== undefined && t.max !== '' ? Number(t.max) : null;
    // match: min <= value < max  (max exclusive for stacked ranges)
    const aboveMin = tMin === null || value >= tMin;
    const belowMax = tMax === null || value < tMax;
    if (aboveMin && belowMax) {
      return { severity: t.severity || 'warning', chatIds: t.chat_ids || null, min: tMin, max: tMax };
    }
  }
  return null;
}

function formatMessage(cfg, value, direction, extra) {
  const label = cfg.label || cfg.panel_id;
  const ex = extra || {};
  const severityIcon = {
    critical: '🔴', warning: '🟡', info: '🔵', recovered: '✅'
  };

  // ── Recovered ──
  if (direction === 'recovered') {
    const parts = [
      `${severityIcon.recovered} <b>${escapeHtml(label)}</b> вернулась в норму`,
      `Текущее значение: <b>${value}</b>`,
    ];
    if (cfg.check_mode === 'delta_pct' && ex.deltaPct !== undefined) {
      parts.push(`Изменение: ${ex.deltaPct > 0 ? '+' : ''}${ex.deltaPct}%`);
    }
    parts.push(`Диапазон: ${rangeStr(cfg)}`);
    return parts.join('\n');
  }

  // ── Delta mode ──
  if (cfg.check_mode === 'delta_pct' && ex.deltaPct !== undefined) {
    const dirText = direction === 'above' ? 'рост' : 'падение';
    const icon = ex.severity ? (severityIcon[ex.severity] || '⚠️') : '⚠️';
    return [
      `${icon} <b>${escapeHtml(label)}</b> — ${dirText} на ${Math.abs(ex.deltaPct)}%`,
      `Текущее: <b>${value}</b> | Было: <b>${ex.previous}</b>`,
      `Порог: ${cfg.min_value !== null ? (cfg.min_value > 0 ? '+' : '') + cfg.min_value + '%' : ''} … ${cfg.max_value !== null ? '+' + cfg.max_value + '%' : ''}`,
    ].join('\n');
  }

  // ── Anomaly mode ──
  if (cfg.check_mode === 'anomaly' && ex.zScore !== undefined) {
    const icon = ex.severity ? (severityIcon[ex.severity] || '⚠️') : '⚠️';
    return [
      `${icon} <b>${escapeHtml(label)}</b> — аномалия (z=${ex.zScore})`,
      `Текущее: <b>${value}</b> | Среднее: <b>${ex.mean}</b> | σ: <b>${ex.stdDev}</b>`,
      `Порог z-score: ±${cfg.max_value || 2}`,
    ].join('\n');
  }

  // ── Empty data ──
  if (ex.empty) {
    return [
      `⚠️ <b>${escapeHtml(label)}</b> — нет данных`,
      `За период не поступило ни одного события`,
      `Диапазон: ${rangeStr(cfg)}`,
    ].join('\n');
  }

  // ── Absolute mode (default) ──
  const icon = ex.severity ? (severityIcon[ex.severity] || '⚠️') : '⚠️';
  const dirText = direction === 'above' ? 'выше максимума' : 'ниже минимума';
  return [
    `${icon} <b>${escapeHtml(label)}</b> вышла за диапазон (${dirText})`,
    `Текущее значение: <b>${value}</b>`,
    `Диапазон: ${rangeStr(cfg)}`,
  ].join('\n');
}

function rangeStr(cfg) {
  const min = cfg.min_value !== null && cfg.min_value !== undefined ? cfg.min_value : '−∞';
  const max = cfg.max_value !== null && cfg.max_value !== undefined ? cfg.max_value : '+∞';
  return `${min} … ${max}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Проверить одно правило: получить значение, сравнить с диапазоном,
 * при необходимости отправить в Telegram и обновить state/history.
 *
 * @param {object} db  — better-sqlite3 Database
 * @param {object} cfg — строка из alert_configs
 * @param {object} [opts] — { triggerType: 'schedule'|'test', force: boolean }
 */
async function checkAlertConfig(db, cfg, opts = {}) {
  const triggerType = opts.triggerType || 'schedule';
  const checkMode = cfg.check_mode || 'absolute';
  const onEmpty = cfg.on_empty || 'treat_as_zero';
  const now = new Date().toISOString();

  let value, extra = {};

  try {
    if (checkMode === 'delta_pct') {
      // ── Delta mode ──
      const delta = queryDeltaValue(db, cfg, cfg.src);
      value = delta.deltaPct !== null ? delta.deltaPct : 0;
      extra = { previous: delta.previous, current: delta.current, deltaPct: delta.deltaPct };
    } else if (checkMode === 'anomaly') {
      // ── Anomaly mode ──
      const anomaly = queryAnomalyValue(db, cfg, cfg.src);
      value = anomaly.zScore;
      extra = { current: anomaly.current, mean: anomaly.mean, stdDev: anomaly.stdDev, zScore: anomaly.zScore };
    } else {
      // ── Absolute mode (default) ──
      value = queryMetricValue(db, {
        type: cfg.panel_type,
        agg: cfg.panel_agg,
        aggfield: cfg.panel_aggfield,
        range: cfg.panel_range,
        filters: safeParseFilters(cfg.panel_filters),
        groupField: cfg.group_field,
        groupValue: cfg.group_value,
      }, cfg.src);
    }
  } catch (e) {
    db.prepare(
      `INSERT INTO alert_history (config_id, dashboard_id, panel_id, src, ts, value, direction, status, error_message, trigger_type, fired_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'error', ?, ?, ?)`
    ).run(cfg.id, cfg.dashboard_id, cfg.panel_id, cfg.src, now, e.message.slice(0, 300), triggerType, now);
    return { ok: false, error: e.message };
  }

  // ── Обработка пустых данных (только для absolute/delta_pct) ──
  const isEmpty = (checkMode !== 'anomaly') && (value === 0 || value === null || value === undefined);
  if (isEmpty && onEmpty === 'ignore') {
    db.prepare('UPDATE alert_configs SET last_value = ?, last_checked_at = ? WHERE id = ?')
      .run(value, now, cfg.id);
    return { ok: true, sent: false, direction: null, value, reason: 'empty_ignored' };
  }

  db.prepare('UPDATE alert_configs SET last_value = ?, last_checked_at = ? WHERE id = ?')
    .run(extra.current !== undefined ? extra.current : value, now, cfg.id);

  // ── Определяем нарушение ──
  let direction;
  let severity = null;
  let matchedThreshold = null;

  if (isEmpty && onEmpty === 'alert') {
    direction = 'below';
    extra.empty = true;
  } else if (checkMode === 'delta_pct') {
    direction = detectBreach(value, cfg.min_value, cfg.max_value);
  } else if (checkMode === 'anomaly') {
    // Для anomaly: max_value = порог z-score (считаем двусторонний)
    const zThreshold = Math.abs(cfg.max_value || 2);
    if (Math.abs(value) > zThreshold) {
      direction = value > 0 ? 'above' : 'below';
    } else {
      direction = null;
    }
  } else {
    direction = detectBreach(value, cfg.min_value, cfg.max_value);
  }

  // ── Multi-threshold severity ──
  const thresholds = safeParseThresholds(cfg.thresholds_json);
  if (thresholds.length && direction) {
    // Для anomaly: severity по абсолютному z-score
    const lookupValue = checkMode === 'anomaly' ? Math.abs(value) : (extra.current !== undefined ? extra.current : value);
    matchedThreshold = findMatchingThreshold(thresholds, lookupValue);
    if (matchedThreshold) {
      severity = matchedThreshold.severity;
      extra.severity = severity;
    }
  }

  const wasBreached = cfg.state === 'breached';

  // ── Всё в норме ──
  if (!direction) {
    if (wasBreached) {
      // Переход breached → ok
      db.prepare('UPDATE alert_configs SET state = ?, last_notified_at = ? WHERE id = ?')
        .run('ok', cfg.notify_on_recovery ? now : cfg.last_notified_at, cfg.id);

      if (cfg.notify_on_recovery) {
        const text = formatMessage(cfg, extra.current !== undefined ? extra.current : value, 'recovered', extra);
        const chatIds = matchedThreshold && matchedThreshold.chatIds ? matchedThreshold.chatIds : cfg.chat_ids;
        const res = await broadcastTelegramMessage(cfg.telegram_bot_token, chatIds, text);
        logHistory(db, cfg, now, value, 'recovered', res, triggerType);
        return { ok: true, sent: true, direction: 'recovered', value, extra };
      }
    }
    return { ok: true, sent: false, direction: null, value, extra };
  }

  // ── Диапазон нарушен ──
  const cooldownMs = (cfg.cooldown_sec || 900) * 1000;
  const lastNotified = cfg.last_notified_at ? new Date(cfg.last_notified_at).getTime() : 0;
  const withinCooldown = wasBreached && (Date.now() - lastNotified) < cooldownMs;

  if (withinCooldown && !opts.force) {
    if (cfg.state !== 'breached') {
      db.prepare('UPDATE alert_configs SET state = ? WHERE id = ?').run('breached', cfg.id);
    }
    return { ok: true, sent: false, direction, value, extra, reason: 'cooldown' };
  }

  const displayValue = extra.current !== undefined ? extra.current : value;
  const text = formatMessage(cfg, displayValue, direction, extra);

  // Определяем chat_ids: из мульти-порога или из конфига
  const chatIds = matchedThreshold && matchedThreshold.chatIds ? matchedThreshold.chatIds : cfg.chat_ids;
  const res = await broadcastTelegramMessage(cfg.telegram_bot_token, chatIds, text);

  db.prepare('UPDATE alert_configs SET state = ?, last_notified_at = ? WHERE id = ?')
    .run('breached', now, cfg.id);

  logHistory(db, cfg, now, value, direction, res, triggerType);

  return { ok: res.ok, sent: true, direction, value, extra, telegram: res };
}

function logHistory(db, cfg, ts, value, direction, telegramResult, triggerType) {
  const status = telegramResult.ok ? 'sent' : 'error';
  const errorMessage = telegramResult.ok
    ? null
    : (telegramResult.errors ? telegramResult.errors.join('; ').slice(0, 400) : (telegramResult.error || 'unknown_error'));

  db.prepare(
    `INSERT INTO alert_history (config_id, dashboard_id, panel_id, src, ts, value, direction, status, error_message, trigger_type, fired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(cfg.id, cfg.dashboard_id, cfg.panel_id, cfg.src, ts, value, direction, status, errorMessage, triggerType, ts);
}

function safeParseFilters(json) {
  if (!json) return [];
  try { return JSON.parse(json); } catch (_) { return []; }
}

function safeParseThresholds(json) {
  if (!json) return [];
  try { return typeof json === 'string' ? JSON.parse(json) : json; } catch (_) { return []; }
}

module.exports = { checkAlertConfig, detectBreach, formatMessage, rangeStr, safeParseThresholds };

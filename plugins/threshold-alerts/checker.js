/**
 * plugins/threshold-alerts/checker.js — Проверка одного правила и отправка алерта
 *
 * State machine на конфиге (config.state):
 *   'ok'       → 'breached'  : метрика вышла за диапазон → отправляем алерт
 *   'breached' → 'breached'  : остаётся вне диапазона → молчим, пока не истёк cooldown_sec
 *   'breached' → 'ok'        : вернулась в диапазон → (опционально) отправляем «восстановлено»
 *
 * Это защищает от спама: при постоянном нарушении диапазона сообщения
 * шлются не чаще, чем раз в cooldown_sec.
 */
'use strict';

const { queryMetricValue } = require('./metric-query');
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

function formatMessage(cfg, value, direction) {
  const label = cfg.label || cfg.panel_id;
  if (direction === 'recovered') {
    return (
      `✅ <b>${escapeHtml(label)}</b> вернулась в норму\n` +
      `Текущее значение: <b>${value}</b>\n` +
      `Диапазон: ${rangeStr(cfg)}`
    );
  }
  const dirText = direction === 'above' ? 'выше максимума' : 'ниже минимума';
  return (
    `⚠️ <b>${escapeHtml(label)}</b> вышла за диапазон (${dirText})\n` +
    `Текущее значение: <b>${value}</b>\n` +
    `Диапазон: ${rangeStr(cfg)}`
  );
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
  const now = new Date().toISOString();

  let value;
  try {
    value = queryMetricValue(db, {
      type: cfg.panel_type,
      agg: cfg.panel_agg,
      aggfield: cfg.panel_aggfield,
      range: cfg.panel_range,
      filters: safeParseFilters(cfg.panel_filters),
    }, cfg.src);
  } catch (e) {
    db.prepare(
      `INSERT INTO alert_history (config_id, dashboard_id, panel_id, src, ts, value, direction, status, error_message, trigger_type, fired_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'error', ?, ?, ?)`
    ).run(cfg.id, cfg.dashboard_id, cfg.panel_id, cfg.src, now, e.message.slice(0, 300), triggerType, now);
    return { ok: false, error: e.message };
  }

  db.prepare(
    'UPDATE alert_configs SET last_value = ?, last_checked_at = ? WHERE id = ?'
  ).run(value, now, cfg.id);

  const direction = detectBreach(value, cfg.min_value, cfg.max_value);
  const wasBreached = cfg.state === 'breached';

  // ── Всё в норме ──
  if (!direction) {
    if (wasBreached) {
      // Переход breached → ok
      db.prepare(
        'UPDATE alert_configs SET state = ?, last_notified_at = ? WHERE id = ?'
      ).run('ok', cfg.notify_on_recovery ? now : cfg.last_notified_at, cfg.id);

      if (cfg.notify_on_recovery) {
        const text = formatMessage(cfg, value, 'recovered');
        const res = await broadcastTelegramMessage(cfg.telegram_bot_token, cfg.chat_ids, text);
        logHistory(db, cfg, now, value, 'recovered', res, triggerType);
        return { ok: true, sent: true, direction: 'recovered', value };
      }
    }
    return { ok: true, sent: false, direction: null, value };
  }

  // ── Диапазон нарушен ──
  const cooldownMs = (cfg.cooldown_sec || 900) * 1000;
  const lastNotified = cfg.last_notified_at ? new Date(cfg.last_notified_at).getTime() : 0;
  const withinCooldown = wasBreached && (Date.now() - lastNotified) < cooldownMs;

  if (withinCooldown && !opts.force) {
    // Уже уведомляли недавно — просто фиксируем состояние, не спамим
    if (cfg.state !== 'breached') {
      db.prepare('UPDATE alert_configs SET state = ? WHERE id = ?').run('breached', cfg.id);
    }
    return { ok: true, sent: false, direction, value, reason: 'cooldown' };
  }

  const text = formatMessage(cfg, value, direction);
  const res = await broadcastTelegramMessage(cfg.telegram_bot_token, cfg.chat_ids, text);

  db.prepare(
    'UPDATE alert_configs SET state = ?, last_notified_at = ? WHERE id = ?'
  ).run('breached', now, cfg.id);

  logHistory(db, cfg, now, value, direction, res, triggerType);

  return { ok: res.ok, sent: true, direction, value, telegram: res };
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

module.exports = { checkAlertConfig, detectBreach };

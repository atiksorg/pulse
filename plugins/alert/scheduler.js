/**
 * plugins/alert/scheduler.js — «Тиковый» механизм проверки KPI-порогов
 *
 * Проверяет все активные конфиги на каждом тике:
 *   1. Берёт активный config, читает актуальную панель из dashboards.panels_json
 *   2. Пересчитывает значение метрики по конфигу панели
 *   3. Сравнивает с порогом; если сработало и cooldown истёк — отправляет
 *
 * Вызывается:
 *   1. Из хука global._pluginOnFlush (каждый flush батча, не чаще раза в минуту)
 *   2. Из основного таймера (каждую минуту, независимо от трафика)
 *
 * Дедупликация проверок: per-config check_interval_sec — каждый config
 * тикает со своим интервалом. Гонка двух тиков в одно окно решается
 * атомарным UPDATE last_checked_at через IS NOT DISTINCT FROM.
 */
'use strict';

const { evaluatePanelMetric, findPanelInDashboard, getActiveEvals } = require('./metric-evaluator');
const { dispatchAlert, recordCooldownSkip, getActiveDispatches } = require('./dispatcher');

const CHECK_INTERVAL_MS = 60 * 1000; // глобальный rate-limit (не чаще раза в минуту)
let lastCheckTime = 0;

/**
 * Сравнить значение с порогом по условию.
 * @returns {boolean} сработало ли
 */
function conditionMatches(condition, value, threshold, thresholdMin, thresholdMax) {
  if (value === null || value === undefined || isNaN(value)) return false;
  const v = Number(value);
  const t = Number(threshold);
  switch (condition) {
    case 'gt':  return v > t;
    case 'gte': return v >= t;
    case 'lt':  return v < t;
    case 'lte': return v <= t;
    case 'eq':  return v === t;
    case 'neq': return v !== t;
    case 'outside_range': {
      const lo = Number(thresholdMin);
      const hi = Number(thresholdMax);
      if (isNaN(lo) || isNaN(hi)) return false;
      return v < lo || v > hi;
    }
    default: return false;
  }
}

/**
 * Проверить все активные конфиги и отправить алерты при срабатывании.
 * @param {object} db — better-sqlite3 Database
 */
async function checkAndDispatchAlerts(db) {
  const now = Date.now();
  if (now - lastCheckTime < CHECK_INTERVAL_MS) return;
  lastCheckTime = now;

  try {
    const configs = db.prepare(
      'SELECT * FROM alert_configs WHERE is_active = 1'
    ).all();

    if (!configs.length) return;

    for (const cfg of configs) {
      try {
        await _checkOneConfig(db, cfg);
      } catch (err) {
        console.error(`[alert-scheduler] config ${cfg.id} error:`, err.message);
      }
    }
  } catch (err) {
    console.error('[alert-scheduler] check error:', err.message);
  }
}

/**
 * Проверить один конфиг: учёт интервала, загрузка панели, вычисление,
 * сравнение с порогом, отправка при срабатывании.
 */
async function _checkOneConfig(db, cfg) {
  const utcNow = new Date();

  // ── 1. Per-config check interval ──
  const intervalSec = Math.max(30, Number(cfg.check_interval_sec) || 60);
  if (cfg.last_checked_at) {
    const elapsedMs = utcNow.getTime() - new Date(cfg.last_checked_at).getTime();
    if (elapsedMs < intervalSec * 1000) return; // ещё рано
  }

  // ── 2. Атомарный захват: обновляем last_checked_at, только если
  // он всё ещё равен прочитанному значению. Это защищает от гонки
  // двух тиков в одно и то же окно.
  const newCheckedAt = utcNow.toISOString();
  const oldCheckedAt = cfg.last_checked_at || null;
  const result = db.prepare(
    `UPDATE alert_configs SET last_checked_at = ?
     WHERE id = ? AND last_checked_at IS NOT DISTINCT FROM ?`
  ).run(newCheckedAt, cfg.id, oldCheckedAt);

  if (result.changes !== 1) {
    // Другой тик уже обновил last_checked_at — пропускаем.
    return;
  }

  // ── 3. Загружаем актуальную панель из дашборда ──
  const panel = findPanelInDashboard(cfg.dashboard_id, cfg.panel_id);
  if (!panel) {
    console.warn(`[alert-scheduler] config ${cfg.id}: panel ${cfg.panel_id} not found in dashboard ${cfg.dashboard_id} — deactivating`);
    db.prepare('UPDATE alert_configs SET is_active = 0, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), cfg.id);
    return;
  }

  const viz = panel.viz || 'line';
  if (viz !== 'kpi' && viz !== 'gauge') {
    console.warn(`[alert-scheduler] config ${cfg.id}: panel viz=${viz} is not KPI/gauge — deactivating`);
    db.prepare('UPDATE alert_configs SET is_active = 0, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), cfg.id);
    return;
  }

  // ── 4. Вычисляем текущее значение метрики ──
  const evalResult = await evaluatePanelMetric(panel, cfg.src);
  if (evalResult.value === null) {
    // Ошибка вычисления — НЕ деактивируем, просто логируем
    console.warn(`[alert-scheduler] config ${cfg.id} (${panel.title || cfg.panel_id}): eval error: ${evalResult.error}`);
    return;
  }

  const value = evalResult.value;

  // Обновляем last_value (для отображения в UI)
  db.prepare('UPDATE alert_configs SET last_value = ? WHERE id = ?')
    .run(value, cfg.id);

  // ── 5. Сравниваем с порогом ──
  const triggered = conditionMatches(
    cfg.condition, value, cfg.threshold, cfg.threshold_min, cfg.threshold_max
  );

  if (!triggered) return;

  // ── 6. Cooldown ──
  const cooldownMin = Math.max(0, Number(cfg.cooldown_min) || 0);
  if (cfg.last_fired_at) {
    const sinceFiredMs = utcNow.getTime() - new Date(cfg.last_fired_at).getTime();
    if (sinceFiredMs < cooldownMin * 60 * 1000) {
      // Записываем в history что «сработало, но подавлено cooldown»
      recordCooldownSkip(db, cfg, {
        value, threshold: cfg.threshold, condition: cfg.condition,
      });
      return;
    }
  }

  // ── 7. Атомарно обновляем last_fired_at (защита от дублей) ──
  const oldFiredAt = cfg.last_fired_at || null;
  const newFiredAt = utcNow.toISOString();
  const firedResult = db.prepare(
    `UPDATE alert_configs SET last_fired_at = ?
     WHERE id = ? AND last_fired_at IS NOT DISTINCT FROM ?`
  ).run(newFiredAt, cfg.id, oldFiredAt);

  if (firedResult.changes !== 1) {
    // Параллельный тик уже отправил — не дублируем
    return;
  }

  // ── 8. Отправляем (fire-and-forget) ──
  const ctx = {
    value,
    threshold: cfg.threshold,
    threshold_min: cfg.threshold_min,
    threshold_max: cfg.threshold_max,
    condition: cfg.condition,
    title: panel.title || 'KPI-алерт',
    panel_id: cfg.panel_id,
    dashboard_id: cfg.dashboard_id,
    src: cfg.src,
    agg: panel.agg,
    range: panel.range,
    type: panel.type,
  };
  console.log(`[alert-scheduler] trigger: panel=${cfg.panel_id} value=${value} ${cfg.condition} ${cfg.threshold}`);
  dispatchAlert(db, Object.assign({}, cfg, { last_fired_at: newFiredAt }), ctx)
    .catch(err => console.error('[alert-scheduler] dispatch error:', err.message));
}

/**
 * Получить статус планировщика (heartbeat).
 */
function getSchedulerStatus() {
  return {
    lastCheckTime: lastCheckTime ? new Date(lastCheckTime).toISOString() : null,
    lastCheckAgeMs: lastCheckTime ? Date.now() - lastCheckTime : null,
    activeDispatches: getActiveDispatches(),
    activeEvals: getActiveEvals(),
    checkIntervalMs: CHECK_INTERVAL_MS,
  };
}

module.exports = { checkAndDispatchAlerts, getSchedulerStatus, conditionMatches };

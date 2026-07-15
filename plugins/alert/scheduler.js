/**
 * plugins/alert/scheduler.js — «Тиковый» механизм проверки KPI-порогов
 *
 * Проверяет все активные правила на каждом тике:
 *   1. Берёт активный rule, читает актуальную панель из dashboards.panels_json
 *   2. Пересчитывает значение метрики по конфигу панели
 *   3. Сравнивает с порогом; применяет FSM-логику состояний
 *
 * FSM: ok → pending → firing → resolved
 *   - ok→pending: первое срабатывание
 *   - pending→firing: N последовательных срабатываний (anti-flapping)
 *   - firing→resolved: M последовательных «нормальных» значений
 *
 * Вызывается:
 *   1. Из хука global._pluginOnFlush (каждый flush батча, не чаще раза в минуту)
 *   2. Из основного таймера (каждую минуту, независимо от трафика)
 *
 * Дедупликация проверок: per-rule check_interval_sec — каждый rule
 * тикает со своим интервалом. Гонка двух тиков в одно окно решается
 * атомарным UPDATE last_checked_at через IS NOT DISTINCT FROM.
 */
'use strict';

const { evaluatePanelMetric, checkNoData, evaluateRateOfChange, findPanelInDashboard, getActiveEvals } = require('./metric-evaluator');
const { dispatchAlert, recordCooldownSkip, getActiveDispatches, getAdapter } = require('./dispatcher');

const CHECK_INTERVAL_MS = 60 * 1000; // глобальный rate-limit (не чаще раза в минуту)
let lastCheckTime = 0;

/**
 * Self-healthcheck: если scheduler не тикал более этого порога —
 * встроенный алерт на деградацию системы.
 */
const SELF_HEALTHCHECK_THRESHOLD_MS = 5 * 60 * 1000; // 5 минут
let selfHealthcheckTriggered = false;

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
 * Проверить, не заглушено ли правило (silence).
 * @returns {boolean} true если заглушено
 */
function isSilenced(db, ruleId, src, dashboardId) {
  try {
    const now = new Date().toISOString();
    const silences = db.prepare(
      `SELECT id FROM alert_silences
       WHERE ends_at > ?
         AND (rule_id = ? OR rule_id = '' OR rule_id IS NULL)
         AND (src = ? OR src = '' OR src IS NULL)
         AND (dashboard_id = ? OR dashboard_id = '' OR dashboard_id IS NULL)
       LIMIT 1`
    ).all(now, ruleId, src, dashboardId);
    return silences.length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * Проверить все активные правила и отправить алерты при срабатывании.
 * @param {object} db — better-sqlite3 Database
 */
async function checkAndDispatchAlerts(db) {
  const now = Date.now();
  if (now - lastCheckTime < CHECK_INTERVAL_MS) return;
  lastCheckTime = now;

  try {
    const rules = db.prepare(
      'SELECT * FROM alert_rules WHERE is_active = 1'
    ).all();

    if (!rules.length) {
      // Self-healthcheck: планировщик работает, но нет правил — не проблема
      return;
    }

    for (const rule of rules) {
      try {
        await _checkOneRule(db, rule);
      } catch (err) {
        console.error(`[alert-scheduler] rule ${rule.id} error:`, err.message);
      }
    }

    // Обработка очереди доставки (retry/backoff)
    _processQueue(db);

    // Self-healthcheck: сбрасываем флаг если всё ок
    selfHealthcheckTriggered = false;

  } catch (err) {
    console.error('[alert-scheduler] check error:', err.message);
  }
}

/**
 * Проверить одно правило: учёт интервала, загрузка панели, вычисление,
 * сравнение с порогом, FSM-переходы.
 */
async function _checkOneRule(db, rule) {
  const utcNow = new Date();

  // ── 0. Silences ──
  if (isSilenced(db, rule.id, rule.src, rule.dashboard_id)) {
    return; // заглушено — пропускаем
  }

  // ── 1. Per-rule check interval ──
  const intervalSec = Math.max(30, Number(rule.check_interval_sec) || 60);
  if (rule.last_checked_at) {
    const elapsedMs = utcNow.getTime() - new Date(rule.last_checked_at).getTime();
    if (elapsedMs < intervalSec * 1000) return; // ещё рано
  }

  // ── 2. Атомарный захват: обновляем last_checked_at, только если
  // он всё ещё равен прочитанному значению. Это защищает от гонки
  // двух тиков в одно и то же окно.
  const newCheckedAt = utcNow.toISOString();
  const oldCheckedAt = rule.last_checked_at || null;
  const result = db.prepare(
    `UPDATE alert_rules SET last_checked_at = ?
     WHERE id = ? AND last_checked_at IS NOT DISTINCT FROM ?`
  ).run(newCheckedAt, rule.id, oldCheckedAt);

  if (result.changes !== 1) {
    // Другой тик уже обновил last_checked_at — пропускаем.
    return;
  }

  // ── 3. Загружаем актуальную панель из дашборда ──
  // (panel_id может быть пустым для standalone-правил)
  let panel = null;
  if (rule.panel_id) {
    panel = findPanelInDashboard(rule.dashboard_id, rule.panel_id);
  }

  // ── 4. Определяем тип проверки и вычисляем ──
  let triggered = false;
  let value = null;

  // 4a. no_data: проверка отсутствия событий
  if (rule.no_data_sec > 0) {
    const noData = await checkNoData(rule.src, '');
    if (noData.secondsSinceLastEvent !== null) {
      value = noData.secondsSinceLastEvent;
      triggered = value >= rule.no_data_sec;
    }
  }
  // 4b. rate_of_change: процент изменения за период
  else if (rule.rate_of_change_pct > 0 && rule.rate_of_change_window && panel) {
    const roc = await evaluateRateOfChange(panel, rule.src, rule.rate_of_change_window);
    if (roc.pctChange !== null) {
      value = roc.pctChange;
      // Проверяем: abs(pctChange) >= threshold
      triggered = Math.abs(value) >= rule.rate_of_change_pct;
      // Обновляем last_value
      db.prepare('UPDATE alert_rules SET last_value = ? WHERE id = ?')
        .run(roc.currentValue, rule.id);
    }
  }
  // 4c. Обычная пороговая проверка
  else {
    if (!panel) {
      if (rule.panel_id) {
        console.warn(`[alert-scheduler] rule ${rule.id}: panel ${rule.panel_id} not found in dashboard ${rule.dashboard_id} — deactivating`);
        db.prepare('UPDATE alert_rules SET is_active = 0, updated_at = ? WHERE id = ?')
          .run(new Date().toISOString(), rule.id);
      }
      return;
    }

    const evalResult = await evaluatePanelMetric(panel, rule.src);
    if (evalResult.value === null) {
      console.warn(`[alert-scheduler] rule ${rule.id} (${rule.name || panel.title || rule.panel_id}): eval error: ${evalResult.error}`);
      return;
    }

    value = evalResult.value;

    // Обновляем last_value
    db.prepare('UPDATE alert_rules SET last_value = ? WHERE id = ?')
      .run(value, rule.id);

    triggered = conditionMatches(
      rule.condition, value, rule.threshold, rule.threshold_min, rule.threshold_max
    );
  }

  // ── 5. FSM-логика ──
  const fsm = _transitionFSM(db, rule, triggered, value);

  if (fsm.action === 'fire') {
    // ── 6. Cooldown ──
    const cooldownMin = Math.max(0, Number(rule.cooldown_min) || 0);
    if (rule.last_fired_at) {
      const sinceFiredMs = utcNow.getTime() - new Date(rule.last_fired_at).getTime();
      if (sinceFiredMs < cooldownMin * 60 * 1000) {
        recordCooldownSkip(db, rule, {
          value, threshold: rule.threshold, condition: rule.condition,
          severity: rule.severity,
        });
        return;
      }
    }

    // Атомарно обновляем last_fired_at (защита от дублей)
    const oldFiredAt = rule.last_fired_at || null;
    const newFiredAt = utcNow.toISOString();
    const firedResult = db.prepare(
      `UPDATE alert_rules SET last_fired_at = ?
       WHERE id = ? AND last_fired_at IS NOT DISTINCT FROM ?`
    ).run(newFiredAt, rule.id, oldFiredAt);

    if (firedResult.changes !== 1) return; // Параллельный тик уже отправил

    // Отправляем (fire-and-forget)
    const ctx = {
      value,
      threshold: rule.threshold,
      threshold_min: rule.threshold_min,
      threshold_max: rule.threshold_max,
      condition: rule.condition,
      title: panel ? (panel.title || 'Алерт') : (rule.name || 'no-data'),
      panel_id: rule.panel_id || '',
      dashboard_id: rule.dashboard_id,
      src: rule.src,
      agg: panel ? panel.agg : '',
      range: panel ? panel.range : '',
      type: panel ? panel.type : '',
      severity: rule.severity,
      state: 'firing',
      rule_id: rule.id,
      rule_name: rule.name,
    };
    console.log(`[alert-scheduler] FIRE: rule=${rule.id} value=${value} ${rule.condition} ${rule.threshold}`);
    dispatchAlert(db, Object.assign({}, rule, { last_fired_at: newFiredAt }), ctx)
      .catch(err => console.error('[alert-scheduler] dispatch error:', err.message));

  } else if (fsm.action === 'resolve') {
    // ── Resolve: отправляем resolve-уведомление ──
    const oldResolvedAt = rule.last_resolved_at || null;
    const newResolvedAt = utcNow.toISOString();
    const resolvedResult = db.prepare(
      `UPDATE alert_rules SET last_resolved_at = ?
       WHERE id = ? AND last_resolved_at IS NOT DISTINCT FROM ?`
    ).run(newResolvedAt, rule.id, oldResolvedAt);

    if (resolvedResult.changes !== 1) return;

    const ctx = {
      value,
      threshold: rule.threshold,
      threshold_min: rule.threshold_min,
      threshold_max: rule.threshold_max,
      condition: rule.condition,
      title: panel ? (panel.title || 'Алерт') : (rule.name || 'no-data'),
      panel_id: rule.panel_id || '',
      dashboard_id: rule.dashboard_id,
      src: rule.src,
      agg: panel ? panel.agg : '',
      range: panel ? panel.range : '',
      type: panel ? panel.type : '',
      severity: rule.severity,
      state: 'resolved',
      rule_id: rule.id,
      rule_name: rule.name,
    };
    console.log(`[alert-scheduler] RESOLVE: rule=${rule.id} value=${value}`);
    dispatchAlert(db, Object.assign({}, rule, { last_resolved_at: newResolvedAt }), ctx, null, 'resolve')
      .catch(err => console.error('[alert-scheduler] resolve dispatch error:', err.message));
  }
  // fsm.action === 'none' — ничего не делаем
}

/**
 * FSM-переход состояния.
 * @returns {{ action: 'fire'|'resolve'|'none', newState: string }}
 */
function _transitionFSM(db, rule, triggered, value) {
  const utcNow = new Date().toISOString();
  let newState = rule.state;
  let pendingCount = rule.pending_count || 0;
  let resolveCount = rule.resolve_count || 0;
  const pendingThreshold = Math.max(1, rule.pending_threshold || 1);
  const resolveThreshold = Math.max(1, rule.resolve_threshold || 1);

  if (triggered) {
    resolveCount = 0; // Сбрасываем счётчик resolve
    switch (rule.state) {
      case 'ok':
        // Первое срабатывание → pending
        pendingCount = 1;
        if (pendingCount >= pendingThreshold) {
          newState = 'firing';
          pendingCount = 0;
        } else {
          newState = 'pending';
        }
        break;
      case 'pending':
        // Продолжаем копить
        pendingCount++;
        if (pendingCount >= pendingThreshold) {
          newState = 'firing';
          pendingCount = 0;
        }
        break;
      case 'resolved':
        // После resolve снова сработало → pending
        pendingCount = 1;
        if (pendingCount >= pendingThreshold) {
          newState = 'firing';
          pendingCount = 0;
        } else {
          newState = 'pending';
        }
        break;
      case 'firing':
        // Уже в firing — ничего не меняем
        break;
    }
  } else {
    // Не сработало
    pendingCount = 0;
    switch (rule.state) {
      case 'pending':
        // Сброс pending → ok
        newState = 'ok';
        resolveCount = 0;
        break;
      case 'firing':
        // Нормальное значение — копим resolve_count
        resolveCount++;
        if (resolveCount >= resolveThreshold) {
          newState = 'resolved';
          resolveCount = 0;
        }
        break;
      case 'resolved':
        // Уже resolved — остаёмся
        break;
      case 'ok':
        // Уже ok — остаёмся
        break;
    }
  }

  // Определяем действие
  let action = 'none';
  if (newState === 'firing' && rule.state !== 'firing') {
    action = 'fire'; // переход в firing
  } else if (newState === 'firing' && rule.state === 'firing') {
    action = 'fire'; // продолжаем firing — шлём повторно (с учётом cooldown)
  } else if (newState === 'resolved' && rule.state === 'firing') {
    action = 'resolve'; // переход firing → resolved
  }

  // Обновляем состояние в БД
  db.prepare(
    `UPDATE alert_rules SET state = ?, pending_count = ?, resolve_count = ?, updated_at = ? WHERE id = ?`
  ).run(newState, pendingCount, resolveCount, utcNow, rule.id);

  // Обновляем правило в памяти для последующего использования
  rule.state = newState;
  rule.pending_count = pendingCount;
  rule.resolve_count = resolveCount;

  return { action, newState };
}

/**
 * Обработка очереди доставки (retry с exponential backoff).
 */
function _processQueue(db) {
  try {
    const now = new Date().toISOString();
    // Берём до 10 задач ready к обработке
    const pending = db.prepare(
      `SELECT * FROM alert_queue WHERE status = 'pending' AND next_retry_at <= ? ORDER BY id LIMIT 10`
    ).all(now);

    for (const item of pending) {
      try {
        // Атомарно захватываем
        const grabbed = db.prepare(
          `UPDATE alert_queue SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'`
        ).run(now, item.id);

        if (grabbed.changes !== 1) continue;

        // Отправляем через адаптер
        const adapter = getAdapter(item.channel_type);
        if (!adapter) {
          db.prepare(
            `UPDATE alert_queue SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`
          ).run('unknown channel: ' + item.channel_type, now, item.id);
          continue;
        }

        let channelConfig = {};
        try { channelConfig = JSON.parse(item.channel_config); } catch (_) {}

        adapter.send(channelConfig, item.message_text, {})
          .then(result => {
            if (result.ok) {
              db.prepare(
                `UPDATE alert_queue SET status = 'done', updated_at = ? WHERE id = ?`
              ).run(new Date().toISOString(), item.id);
            } else {
              _handleQueueFailure(db, item, result.error);
            }
          })
          .catch(err => {
            _handleQueueFailure(db, item, err.message);
          });

      } catch (err) {
        console.error(`[alert-queue] item ${item.id} error:`, err.message);
      }
    }

    // Cleanup: удаляем done-задачи старше 1 часа
    try {
      const cutoff = new Date(Date.now() - 3600000).toISOString();
      db.prepare(`DELETE FROM alert_queue WHERE status = 'done' AND updated_at < ?`).run(cutoff);
    } catch (_) {}

  } catch (err) {
    console.error('[alert-queue] process error:', err.message);
  }
}

/**
 * Обработка неудачной отправки из очереди: retry с exponential backoff.
 */
function _handleQueueFailure(db, item, errorMsg) {
  const retryCount = (item.retry_count || 0) + 1;
  const maxRetries = item.max_retries || 3;
  const now = new Date();

  if (retryCount >= maxRetries) {
    db.prepare(
      `UPDATE alert_queue SET status = 'failed', retry_count = ?, error_message = ?, updated_at = ? WHERE id = ?`
    ).run(retryCount, String(errorMsg || '').slice(0, 500), now.toISOString(), item.id);
    return;
  }

  // Exponential backoff: 5s, 15s, 45s, ...
  const backoffMs = Math.min(300000, 5000 * Math.pow(3, retryCount));
  const nextRetryAt = new Date(now.getTime() + backoffMs).toISOString();

  db.prepare(
    `UPDATE alert_queue SET status = 'pending', retry_count = ?, next_retry_at = ?, error_message = ?, updated_at = ? WHERE id = ?`
  ).run(retryCount, nextRetryAt, String(errorMsg || '').slice(0, 500), now.toISOString(), item.id);
}

/**
 * Получить статус планировщика (heartbeat).
 */
function getSchedulerStatus(db) {
  const status = {
    lastCheckTime: lastCheckTime ? new Date(lastCheckTime).toISOString() : null,
    lastCheckAgeMs: lastCheckTime ? Date.now() - lastCheckTime : null,
    activeDispatches: getActiveDispatches(),
    activeEvals: getActiveEvals(),
    checkIntervalMs: CHECK_INTERVAL_MS,
    selfHealthcheckOk: !selfHealthcheckTriggered,
  };

  // Self-healthcheck: если scheduler молчит дольше порога
  if (lastCheckTime && (Date.now() - lastCheckTime) > SELF_HEALTHCHECK_THRESHOLD_MS) {
    selfHealthcheckTriggered = true;
    status.selfHealthcheckOk = false;
    status.selfHealthcheckWarning = `scheduler silent for ${Math.round((Date.now() - lastCheckTime) / 60000)} min`;
  }

  // Queue stats
  if (db) {
    try {
      const queueStats = db.prepare(
        `SELECT status, COUNT(*) as cnt FROM alert_queue GROUP BY status`
      ).all();
      status.queue = {};
      for (const q of queueStats) status.queue[q.status] = q.cnt;
    } catch (_) {}
  }

  return status;
}

module.exports = { checkAndDispatchAlerts, getSchedulerStatus, conditionMatches };

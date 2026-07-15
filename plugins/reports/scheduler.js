/**
 * plugins/reports/scheduler.js — «Тиковый» механизм проверки расписания
 *
 * Проверяет, нужно ли отправлять отчёт, при каждом вызове checkAndDispatchReports().
 * Вызывается:
 *   1. Из хука global._pluginOnFlush (каждый flush батча событий, не чаще раза в минуту)
 *   2. Из основного таймера (каждую минуту, независимо от трафика)
 *
 * Дедупликация: атомарный UPDATE last_sent_at — кто первый обновил, тот и отправляет.
 */
'use strict';

const { shouldSendNowDetailed, parseTimezoneOffset, getLocalTime, formatHHMM } = require('../shared/schedule-utils');
const { dispatchReport, getActiveDispatches } = require('./dispatcher');

/** Максимум ретраев для daily/weekly при ошибке в пределах одного дня */
const MAX_RETRIES = 2;

const CHECK_INTERVAL_MS = 60 * 1000; // не чаще раза в минуту
let lastCheckTime = 0;

/**
 * Проверить, можно ли повторить failed daily/weekly отчёт.
 * Считает ошибки за сегодня (по локальному времени) и проверяет
 * что успешной отправки ещё не было.
 *
 * @param {object} db  — better-sqlite3 Database
 * @param {object} cfg — строка из report_configs
 * @param {Date} utcNow
 * @returns {{ retryable: boolean, attempt: number, maxRetries: number }}
 */
function checkRetryable(db, cfg, utcNow) {
  const offset = parseTimezoneOffset(cfg.timezone);
  const localNow = getLocalTime(utcNow, offset);

  // Начало сегодняшнего дня (по локальному времени) → в UTC
  const todayStartLocal = new Date(localNow);
  todayStartLocal.setUTCHours(0, 0, 0, 0);
  const todayStartUtc = new Date(todayStartLocal.getTime() - offset * 3600000).toISOString();

  // Считаем ошибки за сегодня
  const errorsToday = db.prepare(
    "SELECT COUNT(*) as cnt FROM report_history WHERE config_id = ? AND status = 'error' AND started_at > ?"
  ).get(cfg.id, todayStartUtc).cnt;

  // Если после ошибок была успешная отправка — ретраить не нужно
  const lastSuccess = db.prepare(
    "SELECT id FROM report_history WHERE config_id = ? AND status = 'done' AND started_at > ? ORDER BY started_at DESC LIMIT 1"
  ).get(cfg.id, todayStartUtc);

  if (lastSuccess) {
    return { retryable: false, attempt: errorsToday, maxRetries: MAX_RETRIES };
  }

  if (errorsToday >= MAX_RETRIES) {
    return { retryable: false, attempt: errorsToday, maxRetries: MAX_RETRIES };
  }

  return { retryable: true, attempt: errorsToday + 1, maxRetries: MAX_RETRIES };
}

/**
 * Проверить расписание всех активных конфигов и отправить созревшие.
 * @param {object} db — better-sqlite3 Database
 */
async function checkAndDispatchReports(db) {
  const now = Date.now();
  if (now - lastCheckTime < CHECK_INTERVAL_MS) return;
  lastCheckTime = now;

  try {
    const configs = db.prepare(
      'SELECT * FROM report_configs WHERE is_active = 1'
    ).all();

    if (!configs.length) return;

    const utcNow = new Date();

    for (const cfg of configs) {
      const detail = shouldSendNowDetailed(cfg, utcNow);
      let wouldSend = detail.send;

      // Ретрай: если сегодня уже отправляли, но последняя попытка провалилась
      if (!wouldSend && detail.alreadySentToday &&
          (cfg.schedule_type === 'daily' || cfg.schedule_type === 'weekly')) {
        const retry = checkRetryable(db, cfg, utcNow);
        if (retry.retryable) {
          wouldSend = true;
          console.log(`[reports-scheduler] retry: dashboard ${cfg.dashboard_id} — attempt ${retry.attempt}/${retry.maxRetries}`);
        }
      }

      if (!wouldSend) {
        // Логируем для отладки: почему не сработало
        const offset = parseTimezoneOffset(cfg.timezone);
        const localNow = getLocalTime(utcNow, offset);
        const localHHMM = formatHHMM(localNow);
        console.log(`[reports-scheduler] skip config ${cfg.id} [dashboard=${cfg.dashboard_id}]: local=${localHHMM}, reason=${detail.reason}, last_sent=${cfg.last_sent_at || 'never'}`);
        continue;
      }

      // Атомарный захват (compare-and-swap): обновляем last_sent_at, только если
      // он всё ещё равен тому значению, которое мы прочитали в SELECT.
      // SQLite-оператор `IS NOT DISTINCT FROM` корректно обрабатывает NULL
      // (в отличие от `=`), поэтому:
      //   • если last_sent_at = NULL  и в БД NULL  → обновим (новая отправка)
      //   • если last_sent_at = вчера и в БД вчера   → обновим (дневное окно)
      //   • если другой тик уже обновил last_sent_at → 0 строк (dedup гонки)
      const newSentAt = utcNow.toISOString();
      const oldSentAt = cfg.last_sent_at || null;
      const result = db.prepare(
        `UPDATE report_configs SET last_sent_at = ?
         WHERE id = ? AND last_sent_at IS NOT DISTINCT FROM ?`
      ).run(newSentAt, cfg.id, oldSentAt);

      if (result.changes === 1) {
        console.log(`[reports-scheduler] dispatching report for dashboard ${cfg.dashboard_id} (config ${cfg.id})`);
        // fire-and-forget: не блокируем проверку других конфигов
        dispatchReport(db, Object.assign({}, cfg, { last_sent_at: newSentAt }))
          .catch(err => console.error('[reports-scheduler] dispatch error:', err.message));
      } else {
        console.log(`[reports-scheduler] config ${cfg.id}: would send but last_sent_at already updated (dedup) — другой тик в этом же окне уже запустил отправку, пропускаем`);
      }
    }
  } catch (err) {
    console.error('[reports-scheduler] check error:', err.message);
  }
}

/**
 * Получить статус планировщика (heartbeat).
 */
function getSchedulerStatus() {
  return {
    lastCheckTime: lastCheckTime ? new Date(lastCheckTime).toISOString() : null,
    lastCheckAgeMs: lastCheckTime ? Date.now() - lastCheckTime : null,
    activeDispatches: getActiveDispatches(),
    checkIntervalMs: CHECK_INTERVAL_MS,
  };
}

module.exports = { checkAndDispatchReports, getSchedulerStatus };

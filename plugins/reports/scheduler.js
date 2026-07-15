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

const { shouldSendNow, parseTimezoneOffset, getLocalTime, formatHHMM, hhmmToMinutes } = require('../shared/schedule-utils');
const { dispatchReport, getActiveDispatches } = require('./dispatcher');

const CHECK_INTERVAL_MS = 60 * 1000; // не чаще раза в минуту
let lastCheckTime = 0;

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
      const wouldSend = shouldSendNow(cfg, utcNow);
      if (!wouldSend) {
        // Логируем для отладки: почему не сработало
        const offset = parseTimezoneOffset(cfg.timezone);
        const localNow = getLocalTime(utcNow, offset);
        const localHHMM = formatHHMM(localNow);
        const targetMin = hhmmToMinutes(cfg.schedule_time || '09:00');
        const nowMin = hhmmToMinutes(localHHMM);
        console.log(`[reports-scheduler] skip config ${cfg.id}: local=${localHHMM}, target=${cfg.schedule_time}, nowMin=${nowMin}, targetMin=${targetMin}, last_sent=${cfg.last_sent_at || 'never'}`);
        continue;
      }

      // Атомарный захват: кто первый обновил — тот и отправляет
      const newSentAt = utcNow.toISOString();
      const result = db.prepare(
        `UPDATE report_configs SET last_sent_at = ?
         WHERE id = ? AND (last_sent_at IS NULL OR last_sent_at < ?)`
      ).run(newSentAt, cfg.id, cfg.last_sent_at || '1970-01-01');

      if (result.changes === 1) {
        console.log(`[reports-scheduler] dispatching report for dashboard ${cfg.dashboard_id} (config ${cfg.id})`);
        // fire-and-forget: не блокируем проверку других конфигов
        dispatchReport(db, Object.assign({}, cfg, { last_sent_at: newSentAt }))
          .catch(err => console.error('[reports-scheduler] dispatch error:', err.message));
      } else {
        console.log(`[reports-scheduler] config ${cfg.id}: would send but last_sent_at already updated (dedup)`);
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

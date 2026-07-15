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
        console.log(`[reports-scheduler] skip config ${cfg.id} [dashboard=${cfg.dashboard_id}]: local=${localHHMM}, target_from_db="${cfg.schedule_time}", nowMin=${nowMin}, targetMin=${targetMin}, last_sent=${cfg.last_sent_at || 'never'}`);
        continue;
      }

      // Атомарный захват (compare-and-swap): обновляем last_sent_at, только если
      // он всё ещё равен тому значению, которое мы прочитали в SELECT.
      // SQLite-оператор `IS NOT DISTINCT FROM` корректно обрабатывает NULL
      // (в отличие от `=`), поэтому:
      //   • если last_sent_at = NULL  и в БД NULL  → обновим (новая отправка)
      //   • если last_sent_at = вчера и в БД вчера   → обновим (дневное окно)
      //   • если другой тик уже обновил last_sent_at → 0 строк (dedup гонки)
      //
      // ⚠️ БЫЛА ОШИБКА: использовалось `last_sent_at < oldValue` со старым
      // значением из SELECT. При равенстве (типичный случай: вчерашняя отправка
      // с last_sent_at = вчера вечером, проверка на следующий день) UPDATE
      // возвращал 0 строк и отправка не запускалась, пока в логах появлялся
      // `dedup` каждый тик в течение всего 30-минутного окна.
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

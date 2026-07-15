/**
 * plugins/shared/schedule-utils.js — Утилиты расписания и timezone
 *
 * Парсинг строки timezone (UTC+03:00 → +3 часа).
 * Сравнение текущего времени с расписанием.
 * Форматирование HH:MM.
 */
'use strict';

/**
 * Парсит строку timezone вида "UTC+03:00" или "UTC-05:00" → offset в часах.
 * Возвращает число (дробное): +3, -5.5 и т.д.
 * При ошибке возвращает 0 (UTC).
 */
function parseTimezoneOffset(tz) {
  if (!tz || typeof tz !== 'string') return 0;
  // "UTC+03:00" → "+03:00", "UTC-05:30" → "-05:30"
  const m = tz.match(/UTC([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  const sign = m[1] === '+' ? 1 : -1;
  const hours = parseInt(m[2], 10);
  const minutes = parseInt(m[3], 10);
  return sign * (hours + minutes / 60);
}

/**
 * Получить локальное время в заданном timezone.
 * Возвращает Date, сдвинутый на offset.
 */
function getLocalTime(utcDate, tzOffsetHours) {
  const ms = utcDate.getTime() + tzOffsetHours * 3600000;
  return new Date(ms);
}

/**
 * Форматирует время как HH:MM (для сравнения с schedule_time).
 */
function formatHHMM(date) {
  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  return h + ':' + m;
}

/**
 * Форматирует дату как YYYY-MM-DD (для проверки "ещё не сегодня").
 */
function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Получить номер дня недели (0=вс, 1=пн ... 6=сб) в локальном времени.
 */
function getLocalDayOfWeek(utcDate, tzOffsetHours) {
  const local = getLocalTime(utcDate, tzOffsetHours);
  return local.getUTCDay();
}

/**
 * Разбирает строку "HH:MM" в минуты от полуночи.
 * @param {string} hhmm — "07:30" → 450
 * @returns {number}
 */
function hhmmToMinutes(hhmm) {
  const parts = String(hhmm || '00:00').split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

/**
 * Проверить, нужно ли отправлять отчёт по данному конфигу.
 * Возвращает true если текущее время попадает в ОКНО расписания
 * (schedule_time ± WINDOW_MINUTES) и last_sent_at указывает,
 * что сегодня/в этом интервале ещё не отправляли.
 *
 * @param {object} config — { schedule_type, schedule_time, schedule_days, schedule_hours, timezone, last_sent_at }
 * @param {Date}   now    — текущее UTC-время (для тестов можно передать)
 * @returns {boolean}
 */
function shouldSendNow(config, now) {
  now = now || new Date();
  const offset = parseTimezoneOffset(config.timezone);
  const localNow = getLocalTime(now, offset);
  const hhmm = formatHHMM(localNow);
  const todayStr = formatDate(localNow);

  // Окно: ±30 минут от schedule_time
  // (планировщик тикает раз в ~1-5 мин, 30 мин — с запасом)
  const WINDOW_MINUTES = 30;

  // Проверка: сегодня ещё не отправляли
  if (config.last_sent_at) {
    const lastSent = new Date(config.last_sent_at);
    const lastSentLocal = getLocalTime(lastSent, offset);
    const lastSentDay = formatDate(lastSentLocal);

    if (config.schedule_type === 'daily' || config.schedule_type === 'weekly') {
      if (lastSentDay === todayStr) return false;
    }
  }

  if (config.schedule_type === 'daily') {
    const target = config.schedule_time || '09:00';
    const nowMin = hhmmToMinutes(hhmm);
    const targetMin = hhmmToMinutes(target);
    // Окно: [targetMin, targetMin + WINDOW_MINUTES)
    return nowMin >= targetMin && nowMin < targetMin + WINDOW_MINUTES;
  }

  if (config.schedule_type === 'weekly') {
    const dayOfWeek = getLocalDayOfWeek(now, offset);
    const allowedDays = String(config.schedule_days || '1,2,3,4,5')
      .split(',')
      .map(d => parseInt(d.trim(), 10))
      .filter(d => !isNaN(d));
    if (!allowedDays.includes(dayOfWeek)) return false;
    const target = config.schedule_time || '09:00';
    const nowMin = hhmmToMinutes(hhmm);
    const targetMin = hhmmToMinutes(target);
    return nowMin >= targetMin && nowMin < targetMin + WINDOW_MINUTES;
  }

  if (config.schedule_type === 'interval') {
    const hours = Number(config.schedule_hours) || 0;
    if (hours <= 0) return false;
    if (!config.last_sent_at) return true;
    const elapsed = now.getTime() - new Date(config.last_sent_at).getTime();
    return elapsed >= hours * 3600000;
  }

  return false;
}

/**
 * Валидация строки timezone. Возвращает true если формат корректный.
 */
function isValidTimezone(tz) {
  return /^UTC[+-]\d{2}:\d{2}$/.test(tz);
}

module.exports = {
  parseTimezoneOffset,
  getLocalTime,
  formatHHMM,
  formatDate,
  getLocalDayOfWeek,
  hhmmToMinutes,
  shouldSendNow,
  isValidTimezone,
};

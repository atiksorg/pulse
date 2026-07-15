/**
 * plugins/alert/dispatcher.js — Отправка уведомления в Telegram
 *
 * Формирует текст по шаблону, шлёт POST в Telegram Bot API,
 * логирует результат в alert_history с фазами.
 * Ограничивает параллелизм (макс. 3 одновременных отправки).
 */
'use strict';

const https = require('https');
const url = require('url');

const MAX_PARALLEL = 3;
let activeDispatches = 0;

/**
 * Добавить фазу в phases JSON записи alert_history.
 */
function appendPhase(db, historyId, phase, detail) {
  try {
    const row = db.prepare('SELECT phases FROM alert_history WHERE id = ?').get(historyId);
    let phases = [];
    try { phases = JSON.parse(row.phases || '[]'); } catch (_) {}
    phases.push({
      phase,
      detail: detail || '',
      at: new Date().toISOString(),
    });
    db.prepare('UPDATE alert_history SET phases = ? WHERE id = ?')
      .run(JSON.stringify(phases), historyId);
  } catch (_) {}
}

/**
 * Рендер шаблона сообщения с плейсхолдерами.
 * Плейсхолдеры: {{value}}, {{threshold}}, {{threshold_min}}, {{threshold_max}},
 * {{condition}}, {{title}}, {{panel_id}}, {{dashboard_id}}, {{src}},
 * {{agg}}, {{range}}, {{type}}.
 */
function renderTemplate(template, ctx) {
  if (!template) {
    // Дефолтный шаблон если пользователь не задал свой
    return `🚨 *${ctx.title || 'KPI-алерт'}*\n\n` +
      `Текущее значение: *${ctx.value}*\n` +
      `Условие: ${ctx.condition} ${ctx.threshold}\n` +
      `Дашборд: \`${ctx.dashboard_id}\``;
  }
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, key) => {
    if (ctx[key] === undefined || ctx[key] === null) return '';
    return String(ctx[key]);
  });
}

/**
 * HTTP POST в Telegram Bot API (sendMessage).
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function telegramSendMessage(botToken, chatId, text, parseMode) {
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify({
        chat_id: String(chatId),
        text: String(text).slice(0, 4096), // Telegram limit
        parse_mode: parseMode || 'HTML',
        disable_web_page_preview: true,
      });

      const parsed = url.parse('https://api.telegram.org/bot' + botToken + '/sendMessage');
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: 'telegram_http_' + res.statusCode + ': ' + data.slice(0, 200) });
          }
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: 'telegram_net: ' + e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'telegram_timeout' }); });
      req.write(body);
      req.end();
    } catch (e) {
      resolve({ ok: false, error: 'telegram_exc: ' + e.message });
    }
  });
}

/**
 * Отправить алерт: рендер шаблона → POST в Telegram → запись в history.
 *
 * @param {object} db      — better-sqlite3 Database
 * @param {object} cfg     — строка из alert_configs
 * @param {object} ctx     — { value, condition, threshold, title, panel_id, ... }
 * @param {number} [historyId] — ID записи в alert_history (для test-отправки)
 * @returns {Promise<{ok: boolean, status?: string, error?: string}>}
 */
async function dispatchAlert(db, cfg, ctx, historyId) {
  if (activeDispatches >= MAX_PARALLEL) {
    console.warn('[alert-dispatch] max parallel reached, skipping');
    if (historyId) {
      db.prepare('UPDATE alert_history SET status = ?, error_message = ?, finished_at = ? WHERE id = ?')
        .run('error', 'max_parallel_reached', new Date().toISOString(), historyId);
    }
    return { ok: false, error: 'max_parallel_reached' };
  }

  activeDispatches++;

  // Создаём запись в истории если ещё нет
  if (!historyId) {
    historyId = db.prepare(
      `INSERT INTO alert_history (config_id, panel_id, dashboard_id, src, fired_at, value, threshold, condition, status, trigger_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'working', 'auto')`
    ).run(
      cfg.id, cfg.panel_id, cfg.dashboard_id, cfg.src,
      new Date().toISOString(),
      ctx.value, ctx.threshold, ctx.condition
    ).lastInsertRowid;
  }

  const startTime = Date.now();

  // Парсим каналы
  let channels = [];
  try { channels = JSON.parse(cfg.channels || '[]'); } catch (_) { channels = []; }
  if (!Array.isArray(channels)) channels = [];

  // Фильтруем по типу (сейчас только telegram)
  const tgChannels = channels.filter(c => c && c.type === 'telegram' && c.bot_token && c.chat_id);

  if (!tgChannels.length) {
    const durationMs = Date.now() - startTime;
    db.prepare(
      'UPDATE alert_history SET status = ?, error_message = ?, finished_at = ?, duration_ms = ? WHERE id = ?'
    ).run('error', 'no_telegram_channels', new Date().toISOString(), durationMs, historyId);
    appendPhase(db, historyId, 'error', 'no_telegram_channels');
    activeDispatches--;
    return { ok: false, error: 'no_telegram_channels' };
  }

  try {
    appendPhase(db, historyId, 'value_computed', `value=${ctx.value}, condition=${ctx.condition} ${ctx.threshold}`);

    // Шлём в каждый Telegram-канал
    let lastError = null;
    for (const ch of tgChannels) {
      const text = renderTemplate(cfg.message_template, Object.assign({}, ctx, {
        bot_token: undefined, // не подставляем токен в шаблон
        chat_id: ch.chat_id,
      }));

      appendPhase(db, historyId, 'telegram_post', `chat_id=${ch.chat_id}, len=${text.length}`);
      const result = await telegramSendMessage(ch.bot_token, ch.chat_id, text, ch.parse_mode);

      if (result.ok) {
        appendPhase(db, historyId, 'telegram_ok', `chat_id=${ch.chat_id}`);
      } else {
        appendPhase(db, historyId, 'telegram_error', `chat_id=${ch.chat_id}: ${result.error}`);
        lastError = result.error;
      }
    }

    const durationMs = Date.now() - startTime;

    if (lastError) {
      db.prepare(
        'UPDATE alert_history SET status = ?, error_message = ?, finished_at = ?, duration_ms = ? WHERE id = ?'
      ).run('error', lastError.slice(0, 500), new Date().toISOString(), durationMs, historyId);
      appendPhase(db, historyId, 'error', lastError.slice(0, 200));
      console.error(`[alert-dispatch] ✗ telegram error: ${lastError} (${durationMs}ms)`);
      return { ok: false, error: lastError };
    } else {
      db.prepare(
        'UPDATE alert_history SET status = ?, finished_at = ?, duration_ms = ? WHERE id = ?'
      ).run('sent', new Date().toISOString(), durationMs, historyId);
      appendPhase(db, historyId, 'done', `${tgChannels.length} channel(s), ${durationMs}ms`);
      console.log(`[alert-dispatch] ✓ alert sent: panel=${cfg.panel_id} (${durationMs}ms)`);
      return { ok: true };
    }
  } catch (e) {
    const durationMs = Date.now() - startTime;
    db.prepare(
      'UPDATE alert_history SET status = ?, error_message = ?, finished_at = ?, duration_ms = ? WHERE id = ?'
    ).run('error', String(e.message).slice(0, 500), new Date().toISOString(), durationMs, historyId);
    appendPhase(db, historyId, 'error', String(e.message).slice(0, 200));
    console.error(`[alert-dispatch] ✗ exception: ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    activeDispatches--;
  }
}

/**
 * Записать в history «пропуск по cooldown» (без отправки).
 */
function recordCooldownSkip(db, cfg, ctx) {
  try {
    db.prepare(
      `INSERT INTO alert_history (config_id, panel_id, dashboard_id, src, fired_at, value, threshold, condition, status, trigger_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'skipped_cooldown', 'auto')`
    ).run(
      cfg.id, cfg.panel_id, cfg.dashboard_id, cfg.src,
      new Date().toISOString(),
      ctx.value, ctx.threshold, ctx.condition
    );
  } catch (_) {}
}

/**
 * Получить количество текущих параллельных отправок.
 */
function getActiveDispatches() {
  return activeDispatches;
}

module.exports = {
  dispatchAlert,
  recordCooldownSkip,
  getActiveDispatches,
  renderTemplate, // экспорт для тестов/предпросмотра
};

/**
 * plugins/alert/dispatcher.js — Мультиканальная доставка уведомлений
 *
 * Архитектура ChannelAdapter:
 *   - Каждый тип канала (telegram, webhook, email...) реализует
 *     интерфейс { type, send(config, text, ctx) → { ok, error } }
 *   - dispatchAlert() перебирает каналы правила, шлёт через нужный адаптер
 *   - Поддержка resolve-уведомлений (когда метрика вернулась в норму)
 *
 * Ограничивает параллелизм (макс. 3 одновременных отправки).
 */
'use strict';

const https = require('https');
const http = require('http');
const url = require('url');

const MAX_PARALLEL = 3;
let activeDispatches = 0;

// ═══════════════════════════════════════════════════
//  CHANNEL ADAPTERS — единый интерфейс доставки
// ═══════════════════════════════════════════════════

/**
 * Реестр адаптеров. Новые каналы добавляются через registerAdapter().
 * @type {Map<string, { type: string, send: Function }>}
 */
const _adapters = new Map();

/**
 * Зарегистрировать новый адаптер канала.
 * @param {string} type — тип канала ('telegram', 'webhook', 'email')
 * @param {{ send: Function }} adapter
 */
function registerAdapter(type, adapter) {
  _adapters.set(type, adapter);
}

/**
 * Получить адаптер по типу.
 * @param {string} type
 * @returns {{ send: Function }|null}
 */
function getAdapter(type) {
  return _adapters.get(type) || null;
}

// ── TelegramAdapter ──────────────────────────────────
registerAdapter('telegram', {
  /**
   * @param {object} config — { bot_token, chat_id, parse_mode }
   * @param {string} text
   * @param {object} ctx — контекст алерта
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async send(config, text, ctx) {
    const botToken = config.bot_token;
    const chatId = config.chat_id;
    const parseMode = config.parse_mode || 'HTML';

    if (!botToken || !chatId) {
      return { ok: false, error: 'missing bot_token or chat_id' };
    }

    const trimmed = String(text == null ? '' : text).slice(0, 4096);
    const safeText = prepareTelegramText(trimmed, parseMode);
    const body = JSON.stringify({
      chat_id: String(chatId),
      text: safeText,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });

    return new Promise((resolve) => {
      try {
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
  },
});

// ── WebhookAdapter (generic HTTP POST) ───────────
registerAdapter('webhook', {
  async send(config, text, ctx) {
    const webhookUrl = config.url;
    if (!webhookUrl) return { ok: false, error: 'missing webhook url' };

    const payload = JSON.stringify({
      text,
      value: ctx.value,
      threshold: ctx.threshold,
      condition: ctx.condition,
      title: ctx.title,
      severity: ctx.severity,
      rule_id: ctx.rule_id,
      state: ctx.state,
      panel_id: ctx.panel_id,
      dashboard_id: ctx.dashboard_id,
      timestamp: new Date().toISOString(),
    });

    return new Promise((resolve) => {
      try {
        const mod = webhookUrl.startsWith('https') ? https : http;
        const parsed = new URL(webhookUrl);
        const req = mod.request({
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 15000,
        }, (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ ok: true });
            } else {
              resolve({ ok: false, error: 'webhook_http_' + res.statusCode });
            }
          });
        });
        req.on('error', (e) => resolve({ ok: false, error: 'webhook_net: ' + e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'webhook_timeout' }); });
        req.write(payload);
        req.end();
      } catch (e) {
        resolve({ ok: false, error: 'webhook_exc: ' + e.message });
      }
    });
  },
});


// ═══════════════════════════════════════════════════
//  TEMPLATE RENDERING & TELEGRAM HELPERS
// ═══════════════════════════════════════════════════

/**
 * Рендер шаблона сообщения с плейсхолдерами.
 * Плейсхолдеры: {{value}}, {{threshold}}, {{threshold_min}}, {{threshold_max}},
 * {{condition}}, {{title}}, {{panel_id}}, {{dashboard_id}}, {{src}},
 * {{agg}}, {{range}}, {{type}}, {{severity}}, {{state}}, {{rule_name}}.
 */
function renderTemplate(template, ctx) {
  if (!template) {
    const severityEmoji = {
      'info': 'ℹ️', 'warning': '⚠️', 'critical': '🔴'
    };
    const emoji = severityEmoji[ctx.severity] || '🚨';
    const stateStr = ctx.state === 'resolved' ? '✅ Восстановлено' : '';
    const prefix = stateStr || (emoji + ' ' + (ctx.title || 'Алерт'));
    return `${prefix}\n\n` +
      `Текущее значение: ${ctx.value}\n` +
      `Условие: ${ctx.condition} ${ctx.threshold}\n` +
      (ctx.rule_name ? `Правило: ${ctx.rule_name}\n` : '') +
      `Дашборд: ${ctx.dashboard_id}`;
  }
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, key) => {
    if (ctx[key] === undefined || ctx[key] === null) return '';
    return String(ctx[key]);
  });
}

/**
 * Спецсимволы, которые в MarkdownV2 Telegram считает управляющими.
 */
const MDV2_SPECIAL = /([_*\[\]()~`>#+\-=|{}.!])/g;

/**
 * Экранировать спецсимволы MarkdownV2 в произвольной строке.
 */
function escapeMarkdownV2(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(MDV2_SPECIAL, '\\$1');
}

/**
 * Подготовить текст к отправке в Telegram с учётом parse_mode.
 */
function prepareTelegramText(text, parseMode) {
  if (parseMode === 'MARKDOWNV2') return escapeMarkdownV2(text);
  return text;
}


// ═══════════════════════════════════════════════════
//  PHASE LOGGING
// ═══════════════════════════════════════════════════

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


// ═══════════════════════════════════════════════════
//  DISPATCH: ОТПРАВКА АЛЕРТА / RESOLVE
// ═══════════════════════════════════════════════════

/**
 * Отправить алерт (fire или resolve) через все каналы правила.
 *
 * @param {object} db      — better-sqlite3 Database
 * @param {object} rule    — строка из alert_rules
 * @param {object} ctx     — { value, condition, threshold, title, severity, state, ... }
 * @param {number} [historyId] — ID записи в alert_history (для test-отправки)
 * @param {string} [eventType] — 'fire' | 'resolve' | 'test'
 * @returns {Promise<{ok: boolean, status?: string, error?: string}>}
 */
async function dispatchAlert(db, rule, ctx, historyId, eventType) {
  if (activeDispatches >= MAX_PARALLEL) {
    console.warn('[alert-dispatch] max parallel reached, skipping');
    if (historyId) {
      db.prepare('UPDATE alert_history SET status = ?, error_message = ?, finished_at = ? WHERE id = ?')
        .run('error', 'max_parallel_reached', new Date().toISOString(), historyId);
    }
    return { ok: false, error: 'max_parallel_reached' };
  }

  activeDispatches++;
  eventType = eventType || (ctx.state === 'resolved' ? 'resolve' : 'fire');

  // Создаём запись в истории если ещё нет
  if (!historyId) {
    historyId = db.prepare(
      `INSERT INTO alert_history (rule_id, panel_id, dashboard_id, src, fired_at, value, threshold, condition, severity, status, trigger_type, event_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', 'auto', ?)`
    ).run(
      rule.id, rule.panel_id || '', rule.dashboard_id, rule.src,
      new Date().toISOString(),
      ctx.value, ctx.threshold, ctx.condition,
      ctx.severity || 'warning', eventType
    ).lastInsertRowid;
  }

  const startTime = Date.now();

  // Парсим каналы
  let channels = [];
  try { channels = JSON.parse(rule.channels || '[]'); } catch (_) { channels = []; }
  if (!Array.isArray(channels)) channels = [];

  if (!channels.length) {
    const durationMs = Date.now() - startTime;
    db.prepare(
      'UPDATE alert_history SET status = ?, error_message = ?, finished_at = ?, duration_ms = ? WHERE id = ?'
    ).run('error', 'no_channels', new Date().toISOString(), durationMs, historyId);
    appendPhase(db, historyId, 'error', 'no_channels');
    activeDispatches--;
    return { ok: false, error: 'no_channels' };
  }

  try {
    appendPhase(db, historyId, 'value_computed', `value=${ctx.value}, condition=${ctx.condition} ${ctx.threshold}`);

    // Определяем шаблон (fire vs resolve)
    const template = eventType === 'resolve'
      ? (rule.resolve_template || rule.message_template || '')
      : (rule.message_template || '');

    // Шлём в каждый канал через адаптер
    let lastError = null;
    let sentCount = 0;

    for (const ch of channels) {
      const adapterType = ch.type || 'telegram';
      const adapter = _adapters.get(adapterType);

      if (!adapter) {
        appendPhase(db, historyId, 'skip_unknown_channel', `type=${adapterType}`);
        continue;
      }

      const text = renderTemplate(template, Object.assign({}, ctx, {
        bot_token: undefined,
        chat_id: ch.chat_id,
        channel_type: adapterType,
      }));

      appendPhase(db, historyId, 'channel_send', `type=${adapterType}, len=${text.length}`);
      const result = await adapter.send(ch, text, ctx);

      if (result.ok) {
        appendPhase(db, historyId, 'channel_ok', `type=${adapterType}`);
        sentCount++;
      } else {
        appendPhase(db, historyId, 'channel_error', `type=${adapterType}: ${result.error}`);
        lastError = result.error;
      }
    }

    const durationMs = Date.now() - startTime;

    if (lastError && sentCount === 0) {
      db.prepare(
        'UPDATE alert_history SET status = ?, error_message = ?, finished_at = ?, duration_ms = ?, event_type = ? WHERE id = ?'
      ).run('error', lastError.slice(0, 500), new Date().toISOString(), durationMs, eventType, historyId);
      appendPhase(db, historyId, 'error', lastError.slice(0, 200));
      console.error(`[alert-dispatch] ✗ error: ${lastError} (${durationMs}ms)`);
      return { ok: false, error: lastError };
    } else {
      const status = lastError ? 'partial' : 'sent';
      db.prepare(
        'UPDATE alert_history SET status = ?, finished_at = ?, duration_ms = ?, error_message = ?, event_type = ? WHERE id = ?'
      ).run(status, new Date().toISOString(), durationMs, lastError ? lastError.slice(0, 500) : null, eventType, historyId);
      appendPhase(db, historyId, 'done', `${sentCount}/${channels.length} channel(s), ${durationMs}ms`);
      console.log(`[alert-dispatch] ✓ ${eventType}: rule=${rule.id} (${durationMs}ms)`);
      return { ok: true };
    }
  } catch (e) {
    const durationMs = Date.now() - startTime;
    db.prepare(
      'UPDATE alert_history SET status = ?, error_message = ?, finished_at = ?, duration_ms = ?, event_type = ? WHERE id = ?'
    ).run('error', String(e.message).slice(0, 500), new Date().toISOString(), durationMs, eventType, historyId);
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
function recordCooldownSkip(db, rule, ctx) {
  try {
    db.prepare(
      `INSERT INTO alert_history (rule_id, panel_id, dashboard_id, src, fired_at, value, threshold, condition, severity, status, trigger_type, event_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'skipped_cooldown', 'auto', 'fire')`
    ).run(
      rule.id, rule.panel_id || '', rule.dashboard_id, rule.src,
      new Date().toISOString(),
      ctx.value, ctx.threshold, ctx.condition, ctx.severity || 'warning'
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
  registerAdapter,
  getAdapter,
  renderTemplate,
  escapeMarkdownV2,
  prepareTelegramText,
};

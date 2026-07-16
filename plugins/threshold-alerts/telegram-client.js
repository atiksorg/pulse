/**
 * plugins/threshold-alerts/telegram-client.js — Клиент Telegram Bot API
 *
 * Простая отправка текстового сообщения через sendMessage.
 * Использует общий httpPost из plugins/shared/http-client.js.
 */
'use strict';

const { httpPost } = require('../shared/http-client');

/**
 * Отправить сообщение одному chat_id.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function sendTelegramMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const res = await httpPost(url, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }, { timeout: 10000 });

    if (res.status >= 400 || !res.data || res.data.ok !== true) {
      const desc = (res.data && res.data.description) || ('http_' + res.status);
      return { ok: false, error: desc };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Отправить сообщение на список chat_id (через запятую).
 * Возвращает сводку: сколько успешно, ошибки по каждому.
 */
async function broadcastTelegramMessage(botToken, chatIdsCsv, text) {
  const ids = String(chatIdsCsv || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!ids.length) return { ok: false, error: 'no_chat_ids', sent: 0, total: 0 };

  const results = await Promise.all(ids.map(id => sendTelegramMessage(botToken, id, text)));
  const sent = results.filter(r => r.ok).length;
  const errors = results
    .map((r, i) => (r.ok ? null : `${ids[i]}: ${r.error}`))
    .filter(Boolean);

  return { ok: sent > 0, sent, total: ids.length, errors };
}

module.exports = { sendTelegramMessage, broadcastTelegramMessage };

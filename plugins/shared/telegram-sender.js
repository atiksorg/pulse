/**
 * plugins/shared/telegram-sender.js — Telegram Bot API wrapper
 *
 * Thin wrapper over shared/http-client for sending messages via
 * POST https://api.telegram.org/bot<token>/sendMessage.
 *
 * Designed for reuse by kpi-alerts plugin and other modules.
 */
'use strict';

const { httpPost, sleep } = require('./http-client');

/**
 * Send a message via Telegram Bot API.
 *
 * @param {object} params
 * @param {string} params.token       — bot token
 * @param {string|number} params.chatId — chat id
 * @param {string} params.text        — message text (HTML parse_mode supported)
 * @param {object} [params.options]   — optional overrides
 * @param {number} [params.options.timeout]
 * @param {string} [params.options.parseMode]
 * @param {boolean} [params.options.disablePreview]
 * @param {number} [params.options.retryCount]
 * @param {number} [params.options.retryBaseMs]
 * @returns {Promise<{ ok: true, data: object } | { ok: false, status: number|null, error: string, data: object|null }>}
 */
async function sendTelegramMessage(params) {
  const {
    token,
    chatId,
    text,
    options = {}
  } = params;

  if (!token) {
    return { ok: false, status: null, error: 'missing_token', data: null };
  }
  if (chatId === undefined || chatId === null || chatId === '') {
    return { ok: false, status: null, error: 'missing_chat_id', data: null };
  }
  if (!text) {
    return { ok: false, status: null, error: 'missing_text', data: null };
  }

  const {
    timeout = 10000,
    parseMode = 'HTML',
    disablePreview = true,
    retryCount = 2,
    retryBaseMs = 300
  } = options;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: String(chatId),
    text,
    parse_mode: parseMode,
    disable_web_page_preview: disablePreview,
  };

  let lastError = null;
  let lastStatus = null;
  let lastData = null;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const res = await httpPost(url, body, {
        timeout,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      lastStatus = res.status;
      lastData = res.data;

      if (res.status >= 200 && res.status < 300 && res.data && res.data.ok) {
        return { ok: true, data: res.data };
      }

      lastError = String(res.data && res.data.description ? res.data.description : 'http_error_' + res.status);

      if (attempt < retryCount) {
        const jitter = Math.floor(Math.random() * Math.max(1, retryBaseMs));
        const waitMs = retryBaseMs * Math.pow(2, attempt) + jitter;
        await sleep(waitMs);
        continue;
      }
    } catch (e) {
      lastError = String(e && e.message ? e.message : 'network_error');
      lastData = null;

      if (attempt < retryCount) {
        const jitter = Math.floor(Math.random() * Math.max(1, retryBaseMs));
        const waitMs = retryBaseMs * Math.pow(2, attempt) + jitter;
        await sleep(waitMs);
        continue;
      }
    }
  }

  return {
    ok: false,
    status: lastStatus,
    error: lastError,
    data: lastData
  };
}

module.exports = {
  sendTelegramMessage
};

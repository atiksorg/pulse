/**
 * plugins/shared/http-client.js — HTTP-клиент к внешнему API
 *
 * Обёртка над https.request для вызова run_function / get_function_result.
 * Не зависит от внешних пакетов.
 */
'use strict';

const https = require('https');
const http  = require('http');

const DEFAULT_TIMEOUT = 15000; // 15 сек на один запрос

/**
 * Выполнить HTTP POST и получить JSON-ответ.
 * @param {string} url  — полный URL
 * @param {object} body — объект, будет сериализован в JSON
 * @param {object} opts — { timeout, headers }
 * @returns {Promise<{status, data}>}
 */
function httpPost(url, body, opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const headers = Object.assign({
    'Content-Type': 'application/json',
  }, opts.headers || {});

  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const parsed = new URL(url);

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: Object.assign(headers, { 'Content-Length': Buffer.byteLength(payload) }),
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (_) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('http_timeout'));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Polling: повторять запрос до получения статуса done/error.
 * @param {string} url
 * @param {object} body
 * @param {object} opts — { interval, timeout, onPoll }
 * @returns {Promise<object>} — финальный ответ
 */
async function pollUntilDone(url, body, opts = {}) {
  const interval = opts.interval || 8000;  // 8 сек между попытками
  const timeout  = opts.timeout  || 300000; // 5 минут максимум
  const onPoll   = opts.onPoll  || (() => {});
  const start    = Date.now();

  while (Date.now() - start < timeout) {
    const res = await httpPost(url, body, { timeout: DEFAULT_TIMEOUT });

    if (res.status >= 400) {
      throw new Error('poll_http_' + res.status);
    }

    const status = res.data && res.data.status;
    onPoll(status, res.data);

    if (status === 'done')  return res.data;
    if (status === 'error') throw new Error(res.data.error || 'remote_error');

    // status === 'working' — ждём
    await sleep(interval);
  }

  throw new Error('poll_timeout');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { httpPost, pollUntilDone, sleep };

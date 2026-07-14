/**
 * plugins/reports/api-client.js — Клиент к внешнему API генерации отчётов
 *
 * Два шага:
 *   1. run_function — отправить задачу (POST /proxy/tasks → task_id)
 *   2. get_function_result — поллить результат (POST /api/v1.0/get_function_result)
 *
 * Аналог Python run_function_api_long из примера пользователя.
 */
'use strict';

const { httpPost, pollUntilDone, sleep } = require('../shared/http-client');

const PROXY_HOST  = 'eu1.account.dialog.ai.atiks.org';
const API_HOST    = 'api.pro-talk.ru';
const POLL_INTERVAL = 8000;   // 8 сек между полами
const POLL_TIMEOUT  = 300000; // 5 минут максимум

// Счётчик для генерации уникальных task_id
let taskCounter = 0;

function generateTaskId(functionId) {
  taskCounter++;
  const rand = Math.random().toString(36).slice(2, 11);
  return `f${functionId}_task_${rand}`;
}

/**
 * Запустить функцию и дождаться результата.
 *
 * @param {object} params
 * @param {number}  params.bot_id
 * @param {string}  params.bot_token
 * @param {number}  params.function_id       — default 697
 * @param {string}  params.data_xml          — XML-снимок дашборда
 * @param {string}  params.prompt
 * @param {string}  params.size              — '9:16' и т.д.
 * @param {string}  params.files_url
 * @param {string}  params.telegram_bot_token
 * @param {string}  params.chat_ids          — через запятую
 * @param {string}  params.emails            — через запятую
 * @param {function} [params.onPoll]         — callback (status, data) на каждый пол
 * @returns {Promise<{success, image_url, notifications, task_id}>}
 */
async function runReportFunction(params) {
  const {
    bot_id, bot_token,
    function_id = 697,
    data_xml, prompt, size, files_url,
    telegram_bot_token, chat_ids, emails,
    onPoll,
  } = params;

  if (!bot_id || !bot_token) throw new Error('missing_bot_credentials');
  if (!data_xml) throw new Error('missing_data_xml');

  const taskId = generateTaskId(function_id);

  // ── Шаг 1: запуск задачи через proxy ──
  const proxyUrl = `https://${PROXY_HOST}/proxy/tasks`;
  const triggerId = String(Date.now());

  const proxyBody = {
    bot_id: bot_id,
    bot_token: bot_token,
    task_type: 'api_call',
    repeat: 'Once',
    trigger_id: triggerId,
    parameters: {
      api_url: `https://${API_HOST}/api/v1.0/run_function`,
      method: 'POST',
      payload: {
        function_id: function_id,
        functions_base_id: 'appkq3HrzrxYxoAV8',
        bot_id: bot_id,
        bot_token: bot_token,
        arguments: {
          task_id: taskId,
          data_json: data_xml,
          size: size || '9:16',
          prompt: prompt || '',
          debug: true,
        },
      },
    },
  };

  // Добавляем опциональные параметры
  const args = proxyBody.parameters.payload.arguments;
  if (files_url)          args.filesUrl = files_url;
  if (telegram_bot_token) args.telegram_bot_token = telegram_bot_token;
  if (chat_ids)           args.chat_ids = chat_ids;
  if (emails)             args.emails = emails;

  const proxyRes = await httpPost(proxyUrl, proxyBody, { timeout: 15000 });
  if (proxyRes.status >= 400) {
    throw new Error('proxy_http_' + proxyRes.status);
  }

  console.log(`[reports-api] task ${taskId} submitted`);

  // ── Шаг 2: polling результата ──
  const pollUrl = `https://${API_HOST}/api/v1.0/get_function_result`;
  const pollBody = {
    task_id: taskId,
    bot_id: bot_id,
    bot_token: bot_token,
    dialogs_api_host: API_HOST,
  };

  const result = await pollUntilDone(pollUrl, pollBody, {
    interval: POLL_INTERVAL,
    timeout: POLL_TIMEOUT,
    onPoll: (status, data) => {
      if (onPoll) onPoll(status, data);
      if (status === 'working') {
        console.log(`[reports-api] task ${taskId} still working...`);
      }
    },
  });

  // Извлекаем image_url из ответа
  const imageUrl = result && result.image_url
    ? result.image_url
    : (result && result.result && result.result.image_url
      ? result.result.image_url
      : null);

  return {
    success: true,
    task_id: taskId,
    image_url: imageUrl,
    notifications: result.notifications || (result.result && result.result.notifications) || [],
    raw: result,
  };
}

module.exports = { runReportFunction };

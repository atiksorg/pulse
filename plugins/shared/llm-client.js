/**
 * plugins/shared/llm-client.js — Общий HTTP-клиент к LLM API
 *
 * Используется плагинами (ai-copilot и потенциально другими) для вызова LLM.
 * НЕ зависит от ai.js и НЕ модифицирует его.
 *
 * Экспортирует:
 *   - callLlm(opts)         — основной вызов LLM
 *   - llmRateLimit(src)     — rate-limit per src
 *   - extractJson(text)     — извлечь JSON-объект из текста ответа
 *   - extractJsonArray(text) — извлечь JSON-массив из текста ответа
 *   - getLlmConfig()        — текущая конфигурация
 *   - getLlmMetrics()       — метрики вызовов
 */
'use strict';

const https = require('https');
const http  = require('http');

// ── Конфигурация ─────────────────────────────────────
const LLM_API_URL    = process.env.LLM_API_URL    || 'https://ai.pro-talk.ru/v1_ai_from_ru/chat/completions';
const LLM_MODEL      = process.env.LLM_MODEL      || 'xiaomi/mimo-v2.5';
const LLM_TIMEOUT_MS = process.env.LLM_TIMEOUT_MS ? Number(process.env.LLM_TIMEOUT_MS) : 120000; // 2 мин
const LLM_MAX_TOKENS = process.env.LLM_MAX_TOKENS ? Number(process.env.LLM_MAX_TOKENS) : 16384;
const LLM_RATE_LIMIT = 30;           // сообщений в чат
const LLM_RATE_WINDOW = 5 * 60000;   // за 5 минут

// ── Метрики (in-memory) ─────────────────────────────
const _metrics = {
  requests: 0,
  failures: 0,
  latencySum: 0,
  latencyCount: 0,
  tokensIn: 0,
  tokensOut: 0,
  lastError: null,
  lastErrorAt: null,
};

function getLlmMetrics() {
  return {
    requests: _metrics.requests,
    failures: _metrics.failures,
    avg_latency_ms: _metrics.latencyCount > 0
      ? Math.round(_metrics.latencySum / _metrics.latencyCount) : 0,
    total_tokens_in: _metrics.tokensIn,
    total_tokens_out: _metrics.tokensOut,
    last_error: _metrics.lastError,
    last_error_at: _metrics.lastErrorAt,
  };
}

function _recordSuccess(latencyMs, tokensIn, tokensOut) {
  _metrics.requests++;
  _metrics.latencySum += latencyMs;
  _metrics.latencyCount++;
  _metrics.tokensIn += (tokensIn || 0);
  _metrics.tokensOut += (tokensOut || 0);
}

function _recordFailure(msg) {
  _metrics.requests++;
  _metrics.failures++;
  _metrics.lastError = msg;
  _metrics.lastErrorAt = new Date().toISOString();
}

// ── Rate-limit (per src) ────────────────────────────
const _rlMap = new Map();

function llmRateLimit(src) {
  const now = Date.now();
  const cutoff = now - LLM_RATE_WINDOW;
  const arr = (_rlMap.get(src) || []).filter(t => t > cutoff);
  if (arr.length >= LLM_RATE_LIMIT) {
    const remainSec = Math.ceil((arr[0] + LLM_RATE_WINDOW - now) / 1000);
    _rlMap.set(src, arr);
    return { ok: false, remainSec };
  }
  arr.push(now);
  _rlMap.set(src, arr);
  return { ok: true };
}

// Очистка устаревших ключей раз в 5 минут
setInterval(() => {
  const cutoff = Date.now() - LLM_RATE_WINDOW;
  for (const [src, arr] of _rlMap.entries()) {
    const filtered = arr.filter(t => t > cutoff);
    if (filtered.length === 0) _rlMap.delete(src);
    else _rlMap.set(src, filtered);
  }
}, 5 * 60000);

// ── Основной вызов LLM ─────────────────────────────
/**
 * @param {object} opts
 * @param {string} opts.model     — модель (по умолчанию LLM_MODEL)
 * @param {Array}  opts.messages  — массив {role, content}
 * @param {number} opts.temperature — температура (по умолчанию 0.3)
 * @param {number} opts.timeout   — таймаут мс (по умолчанию LLM_TIMEOUT_MS)
 * @param {number} opts.maxTokens — макс. токенов ответа
 * @returns {Promise<{content: string, usage: object}>}
 */
async function callLlm(opts = {}) {
  const model   = opts.model || LLM_MODEL;
  const msgs    = opts.messages;
  const temp    = opts.temperature !== undefined ? opts.temperature : 0.3;
  const timeout = opts.timeout || LLM_TIMEOUT_MS;
  const maxTok  = opts.maxTokens || LLM_MAX_TOKENS;

  if (!Array.isArray(msgs) || msgs.length === 0) {
    throw new Error('empty_messages');
  }

  const t0 = Date.now();
  let res;
  try {
    res = await _fetchWithTimeout({
      url: LLM_API_URL,
      body: {
        model,
        stream: false,
        temperature: temp,
        max_tokens: maxTok,
        messages: msgs,
      },
      timeout,
    });
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? 'timeout' : (e.message || 'fetch_failed');
    _recordFailure(msg);
    throw new Error(msg);
  }

  if (!res.ok) {
    _recordFailure('http_' + res.status);
    throw new Error('llm_http_' + res.status);
  }

  let data;
  try { data = await res.json(); }
  catch (_) {
    _recordFailure('bad_json');
    throw new Error('llm_bad_response');
  }

  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message ? choice.message.content : null;
  if (!content) {
    _recordFailure('empty_content');
    throw new Error('llm_empty_content');
  }

  const usage = data.usage || {};
  const latency = Date.now() - t0;
  _recordSuccess(latency, usage.prompt_tokens || 0, usage.completion_tokens || 0);

  return {
    content,
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    },
    latencyMs: latency,
  };
}

// ── HTTP fetch с таймаутом (без внешних зависимостей) ──
function _fetchWithTimeout({ url, body, timeout }) {
  const payload = JSON.stringify(body);
  const mod = url.startsWith('https') ? https : http;
  const parsed = new URL(url);

  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeout);

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        // Мокаем минимальный fetch Response
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: () => Promise.resolve(JSON.parse(data)),
          text: () => Promise.resolve(data),
        });
      });
    });

    req.on('timeout', () => {
      clearTimeout(timer);
      req.destroy();
      const err = new Error('timeout');
      err.name = 'AbortError';
      reject(err);
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.write(payload);
    req.end();
  });
}

// ── Извлечение JSON-объекта из текста ──────────────
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();

  // Снять markdown-обёртку ```json ... ``` или ``` ... ```
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (fence) s = fence[1].trim();

  const firstBrace = s.indexOf('{');
  const lastBrace  = s.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }

  try { return JSON.parse(s); }
  catch (_) {
    const fb = s.indexOf('{'), lb = s.lastIndexOf('}');
    if (fb !== -1 && lb !== -1 && lb > fb) {
      try { return JSON.parse(s.slice(fb, lb + 1)); } catch (_) { return null; }
    }
    return null;
  }
}

// ── Извлечение JSON-массива из текста ──────────────
function extractJsonArray(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();

  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (fence) s = fence[1].trim();

  const firstBracket = s.indexOf('[');
  const lastBracket  = s.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    s = s.slice(firstBracket, lastBracket + 1);
  }

  try { return JSON.parse(s); }
  catch (_) {
    const fb = s.indexOf('['), lb = s.lastIndexOf(']');
    if (fb !== -1 && lb !== -1 && lb > fb) {
      try { return JSON.parse(s.slice(fb, lb + 1)); } catch (_) { return null; }
    }
    return null;
  }
}

// ── Конфигурация (для отладки/тестов) ──────────────
function getLlmConfig() {
  return {
    api_url: LLM_API_URL,
    model: LLM_MODEL,
    timeout_ms: LLM_TIMEOUT_MS,
    max_tokens: LLM_MAX_TOKENS,
    rate_limit: LLM_RATE_LIMIT,
    rate_window_ms: LLM_RATE_WINDOW,
  };
}

module.exports = {
  callLlm,
  llmRateLimit,
  extractJson,
  extractJsonArray,
  getLlmConfig,
  getLlmMetrics,
};

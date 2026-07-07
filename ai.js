/**
 * ai.js — модуль AI-помощника по метрикам
 *
 * Экспортирует:
 *   - suggestPanel(prompt, existingTypes)  — основной вызов LLM
 *   - extractJson(text)                    — устойчивый парсинг ответа модели
 *   - validatePanelConfig(cfg)             — allowlist + санитизация
 *   - checkRateLimit(src)                  — простой in-memory rate-limit
 *   - getMetrics() / recordAiSuccess(latencyMs) / recordAiFailure()
 *
 * Использует встроенный fetch (Node 18+).
 */
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

// ── Настройки ──────────────────────────────────────
const AI_API_URL       = 'https://ai.pro-talk.ru/v1_ai_from_ru/chat/completions';
const AI_MODEL         = 'xiaomi/mimo-v2.5';
const AI_TIMEOUT_MS    = 15000;
const AI_RATE_LIMIT    = 10;          // запросов
const AI_RATE_WINDOW   = 60 * 1000;   // за 60 секунд
const AI_PROMPT_MAX    = 300;         // длина пользовательского промпта
const AI_TYPES_CTX_MAX = 30;          // сколько существующих типов отдаём в контекст

const ALLOWED_VIZ       = ['line', 'bar', 'pie', 'table', 'kpi', 'logs'];
const ALLOWED_AGG       = ['count', 'sum', 'avg'];
const ALLOWED_GROUP     = ['', 'day', 'hour', '__field'];
const ALLOWED_RANGE     = ['24h', '7d', '30d', 'all', 'custom'];
const ALLOWED_WIDTH     = [4, 6, 8, 12];
const ALLOWED_SORT      = ['key', 'value_desc', 'value_asc'];
const ALLOWED_FILTER_OP = ['eq', 'neq', 'gt', 'lt', 'in', 'contains'];
const MAX_FILTERS       = 5;

// ── Метрики (in-memory) ────────────────────────────
const metrics = {
  requestsTotal: 0,
  requestsFailed: 0,
  latencyMsSum: 0,
  latencySamples: 0,
  lastError: null,
  lastErrorAt: null,
};

function getMetrics() {
  const avg = metrics.latencySamples > 0
    ? Math.round(metrics.latencyMsSum / metrics.latencySamples)
    : 0;
  return {
    requests_total: metrics.requestsTotal,
    requests_failed: metrics.requestsFailed,
    avg_latency_ms: avg,
    last_error: metrics.lastError,
    last_error_at: metrics.lastErrorAt,
  };
}
function recordAiSuccess(latencyMs) {
  metrics.requestsTotal++;
  metrics.latencyMsSum += latencyMs;
  metrics.latencySamples++;
}
function recordAiFailure(errMsg) {
  metrics.requestsTotal++;
  metrics.requestsFailed++;
  metrics.lastError = errMsg;
  metrics.lastErrorAt = new Date().toISOString();
}

// ── Rate-limit (Map<src, number[]>) ────────────────
const rateLimitMap = new Map();
function checkRateLimit(src) {
  const now = Date.now();
  const cutoff = now - AI_RATE_WINDOW;
  const arr = (rateLimitMap.get(src) || []).filter(t => t > cutoff);
  if (arr.length >= AI_RATE_LIMIT) {
    const oldest = arr[0];
    const remainSec = Math.ceil((oldest + AI_RATE_WINDOW - now) / 1000);
    rateLimitMap.set(src, arr);
    return { ok: false, remainSec };
  }
  arr.push(now);
  rateLimitMap.set(src, arr);
  return { ok: true };
}

// Периодическая очистка устаревших ключей (раз в 5 минут) — защита от memory leak
setInterval(() => {
  const cutoff = Date.now() - AI_RATE_WINDOW;
  for (const [src, arr] of rateLimitMap.entries()) {
    const filtered = arr.filter(t => t > cutoff);
    if (filtered.length === 0) {
      rateLimitMap.delete(src);
    } else {
      rateLimitMap.set(src, filtered);
    }
  }
}, 5 * 60 * 1000);

// ── Системный промпт ───────────────────────────────
// Включает краткий «скилл» по API и инструкции по форме ответа.
const SYSTEM_PROMPT = `Ты — AI-помощник по метрикам для дашборда events.atiks.org.
Твоя задача: по свободному текстовому запросу пользователя на РУССКОМ языке подобрать конфиг ОДНОЙ панели дашборда.

═══ КРАТКИЙ СКИЛЛ ПО API (events.atiks.org) ═══

Сервис принимает события и отдаёт по ним агрегированную статистику.
src — идентификатор источника (по нему идёт разграничение кабинетов).
type — тип события (например: purchase, signup, click, page_view, error, log).
payload — произвольные поля события, переданные как query-параметры: &amount=42&plan=pro&country=ru.
Чтение: GET /s?src=...&type=...&group=...&agg=...&from=...&to=...

Параметры группировки и агрегации:
  group=day               — по дням
  group=hour              — по часам
  group=__field           — по значению произвольного поля payload (имя поля в "field")
  agg=count               — количество (по умолчанию)
  agg=sum:ИМЯ_ПОЛЯ        — сумма по полю
  agg=avg:ИМЯ_ПОЛЯ        — среднее по полю

═══ ДОПУСТИМЫЕ ЗНАЧЕНИЯ ПОЛЕЙ ПАНЕЛИ ═══

{
  "title":     string,        // название на русском, человекочитаемое
  "viz":       "line"|"bar"|"pie"|"kpi"|"table"|"logs",
  "type":      string|"",     // тип события из payload, или "" — все типы
  "group":     "day"|"hour"|"__field"|"",
  "field":     string|"",     // имя поля payload (если group=__field)
  "agg":       "count"|"sum"|"avg",
  "aggfield":  string|"",     // имя поля для sum/avg
  "range":     "24h"|"7d"|"30d"|"all"|"custom",
  "width":     4|6|8|12,
  "sort":      "key"|"value_desc"|"value_asc",   // сортировка групп
  "limit":     number|null,                        // топ N (null = без лимита)
  "filters":   Array<{field,op,value}>|[]          // доп. условия
}

Фильтры (массив, до 5 условий, все через AND):
  op: "eq"|"neq"|"gt"|"lt"|"in"|"contains"
  value: строка, число, или массив строк для "in"
  Примеры фильтров:
    [{field:"country",op:"eq",value:"ru"}]
    [{field:"amount",op:"gt",value:100}]
    [{field:"plan",op:"in",value:["pro","enterprise"]}]

Правила:
  - group=__field → "field" обязательно (например country, plan, page)
  - agg=sum|avg   → "aggfield" обязательно (числовое поле, например amount, duration)
  - group=day|hour|"", agg=count → "field" и "aggfield" пустые ""
  - viz=logs      → group="__field" НЕ используется; range лучше "24h" или "7d"
  - viz=pie       → чаще всего group=__field с категориальным полем
  - viz=kpi       → group="" (итого), agg=count или sum/avg по полю
  - width: 4=узкая (KPI), 6=средняя, 8=широкая, 12=во всю строку
  - Если пользователь явно просит "по дням" / "по часам" / "за неделю" / "за месяц" — отражай это в group и range
  - title — по возможности конкретный ("Выручка по дням", "Средний чек"), а не "График 1"
  - "type" подбирай, только если в запросе есть явный намёк (покупки → purchase, регистрации → signup). Иначе оставляй "" — все типы.
  - "sort": если пользователь просит "топ", "самые частые", "максимум" → "value_desc"; если "минимум", "редкие" → "value_asc"; иначе "key"
  - "limit": число из запроса ("топ-5" → 5, "10 самых" → 10). Если не указано — null
  - "filters": условия из запроса ("только ru", "партнёр ProTalk", "сумма > 100")

═══ ЖЁСТКИЕ ПРАВИЛА ОТВЕТА ═══

1. Ответ — ТОЛЬКО ОДИН JSON-объект. Никаких пояснений, никакого markdown, никаких code-fence обёрток.
2. JSON должен парситься стандартным JSON.parse без ошибок.
3. Не добавляй лишних полей (id, autorefresh, from, to — НЕ НУЖНЫ).
4. Все строковые значения — в нижнем регистре (кроме title).
5. Не используй null — пустая строка "".
6. Если запрос пользователя бессмысленный (про погоду, про политику, про что-то не связанное с аналитикой) — всё равно верни JSON, лучше простейшую KPI-панель:
   {"title":"Все события (7 дней)","viz":"kpi","type":"","group":"","field":"","agg":"count","aggfield":"","range":"7d","width":4}

═══ ПРИМЕРЫ (few-shot) ═══

Запрос: "Покажи выручку по дням за неделю"
{
  "title":"Выручка по дням",
  "viz":"line",
  "type":"purchase",
  "group":"day",
  "field":"",
  "agg":"sum",
  "aggfield":"amount",
  "range":"7d",
  "width":8
}

Запрос: "Сколько регистраций сегодня?"
{
  "title":"Регистрации за 24 часа",
  "viz":"kpi",
  "type":"signup",
  "group":"",
  "field":"",
  "agg":"count",
  "aggfield":"",
  "range":"24h",
  "width":4
}

Запрос: "Распределение по странам"
{
  "title":"Топ стран",
  "viz":"pie",
  "type":"",
  "group":"__field",
  "field":"country",
  "agg":"count",
  "aggfield":"",
  "range":"7d",
  "width":6
}

Запрос: "Логи ошибок за сутки"
{
  "title":"Логи ошибок",
  "viz":"logs",
  "type":"error",
  "group":"",
  "field":"",
  "agg":"count",
  "aggfield":"",
  "range":"24h",
  "width":8
}

Запрос: "Средний чек за месяц по платежам"
{
  "title":"Средний чек (30 дней)",
  "viz":"kpi",
  "type":"payment",
  "group":"",
  "field":"",
  "agg":"avg",
  "aggfield":"amount",
  "range":"30d",
  "width":4
}

Запрос: "Топ-5 самых частых ошибок"
{
  "title":"Топ-5 типов ошибок",
  "viz":"bar",
  "type":"error",
  "group":"__field",
  "field":"code",
  "agg":"count",
  "aggfield":"",
  "range":"7d",
  "width":6,
  "sort":"value_desc",
  "limit":5,
  "filters":[]
}

Запрос: "Покупки только из России, топ-10 товаров"
{
  "title":"Топ-10 товаров (Россия)",
  "viz":"bar",
  "type":"purchase",
  "group":"__field",
  "field":"product",
  "agg":"count",
  "aggfield":"",
  "range":"7d",
  "width":8,
  "sort":"value_desc",
  "limit":10,
  "filters":[{"field":"country","op":"eq","value":"ru"}]
}

Ответ — ТОЛЬКО JSON.`;

// ── Извлечение JSON из ответа модели ───────────────
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();

  // Снять markdown-обёртку ```json ... ``` или ``` ... ```
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (fence) s = fence[1].trim();

  // Если в строке несколько абзацев — берём самый длинный JSON-фрагмент
  const firstBrace = s.indexOf('{');
  const lastBrace  = s.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }

  try { return JSON.parse(s); }
  catch (_) {
    // Последняя попытка: вырезать всё до первой { и после последней }
    const fb = s.indexOf('{'), lb = s.lastIndexOf('}');
    if (fb !== -1 && lb !== -1 && lb > fb) {
      try { return JSON.parse(s.slice(fb, lb + 1)); } catch (_) { return null; }
    }
    return null;
  }
}

// ── Санитизация строки по IDENT_RE ─────────────────
function safeIdent(s, max = 64) {
  if (typeof s !== 'string') return '';
  s = s.trim();
  if (!s) return '';
  // Оставляем только латиницу/цифры/_ и обрезаем
  s = s.replace(/[^a-zA-Z0-9_]/g, '').slice(0, max);
  if (!s) return '';
  // Должно начинаться с буквы или _
  if (!IDENT_RE.test(s)) {
    s = (IDENT_RE.test(s[0]) ? s : 'x_' + s).slice(0, max);
  }
  return IDENT_RE.test(s) ? s : '';
}
function safeTitle(s) {
  if (typeof s !== 'string') return 'Без названия';
  s = s.trim().slice(0, 120);
  return s || 'Без названия';
}

// ── Валидация панели ───────────────────────────────
function validatePanelConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, error: 'not_an_object' };
  }

  const viz = String(cfg.viz || '').toLowerCase();
  if (!ALLOWED_VIZ.includes(viz)) return { ok: false, error: 'invalid_viz' };

  const group = String(cfg.group || '').toLowerCase();
  if (!ALLOWED_GROUP.includes(group)) return { ok: false, error: 'invalid_group' };

  const agg = String(cfg.agg || 'count').toLowerCase();
  if (!ALLOWED_AGG.includes(agg)) return { ok: false, error: 'invalid_agg' };

  const range = String(cfg.range || '7d').toLowerCase();
  if (!ALLOWED_RANGE.includes(range)) return { ok: false, error: 'invalid_range' };

  let width = Number(cfg.width);
  if (!ALLOWED_WIDTH.includes(width)) width = 6;

  // sort
  const sort = String(cfg.sort || 'key').toLowerCase();
  if (!ALLOWED_SORT.includes(sort)) return { ok: false, error: 'invalid_sort' };

  // limit
  let limit = cfg.limit != null ? Number(cfg.limit) : null;
  if (limit !== null && (isNaN(limit) || limit <= 0)) limit = null;
  if (limit !== null) limit = Math.min(Math.floor(limit), 500);

  // filters (валидируем до MAX_FILTERS штук)
  let filters = [];
  if (Array.isArray(cfg.filters)) {
    if (cfg.filters.length > MAX_FILTERS) {
      return { ok: false, error: 'too_many_filters' };
    }
    for (const f of cfg.filters) {
      if (!f || typeof f !== 'object') continue;
      const field = safeIdent(f.field);
      if (!field) continue;
      const op = String(f.op || '').toLowerCase();
      if (!ALLOWED_FILTER_OP.includes(op)) continue;
      let value = f.value;
      if (op === 'in') {
        if (!Array.isArray(value)) continue;
        value = value.map(v => String(v)).slice(0, 20);
        if (!value.length) continue;
      } else if (op === 'gt' || op === 'lt') {
        value = Number(value);
        if (isNaN(value)) continue;
      } else {
        value = String(value).slice(0, 200);
        if (!value) continue;
      }
      filters.push({ field, op, value });
    }
  }

  // Условные обязательные поля
  let field = safeIdent(cfg.field);
  if (group === '__field' && !field) {
    // group=__field требует field — иначе отказываем в валидации
    return { ok: false, error: 'group_field_missing' };
  }

  let aggfield = safeIdent(cfg.aggfield);
  if ((agg === 'sum' || agg === 'avg') && !aggfield) {
    return { ok: false, error: 'agg_field_missing' };
  }

  // type: либо пусто, либо безопасный идентификатор (в нижнем регистре,
  // чтобы регистр не сломал сопоставление с реальными типами событий в БД)
  const type = safeIdent(cfg.type).toLowerCase();

  const panel = {
    title: safeTitle(cfg.title),
    viz,
    type,
    group,
    field,
    agg,
    aggfield,
    range,
    width,
    sort,
    limit,
    filters,
  };
  return { ok: true, panel };
}

// ── Существующие типы событий из БД ───────────────
function collectExistingTypes(db, src) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'events_%' ORDER BY name DESC"
  ).all();
  if (!tables.length) return [];
  const seen = new Set();
  for (const { name } of tables) {
    try {
      const rows = db.prepare(
        `SELECT DISTINCT type FROM "${name}" WHERE src = ? AND type != '' LIMIT ?`
      ).all(src, AI_TYPES_CTX_MAX);
      for (const r of rows) {
        if (r.type) seen.add(r.type);
        if (seen.size >= AI_TYPES_CTX_MAX) break;
      }
    } catch (_) {}
    if (seen.size >= AI_TYPES_CTX_MAX) break;
  }
  return Array.from(seen).slice(0, AI_TYPES_CTX_MAX);
}

// ── Главная функция: запрос к LLM ──────────────────
async function suggestPanel(prompt, existingTypes, isRetry = false) {
  const userPrompt = String(prompt || '').trim().slice(0, AI_PROMPT_MAX);
  if (!userPrompt) {
    throw new Error('empty_prompt');
  }

  const typesCtx = Array.isArray(existingTypes) && existingTypes.length
    ? `\n\nСуществующие типы событий у пользователя (используй как подсказку для поля "type"): ${existingTypes.slice(0, AI_TYPES_CTX_MAX).join(', ')}`
    : '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const t0 = Date.now();

  let res;
  try {
    res = await fetch(AI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: AI_MODEL,
        stream: false,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userPrompt + typesCtx },
        ],
      }),
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = (e && e.name === 'AbortError') ? 'timeout' : (e.message || 'fetch_failed');
    recordAiFailure(msg);
    throw new Error(msg);
  }
  clearTimeout(timer);

  if (!res.ok) {
    recordAiFailure('http_' + res.status);
    throw new Error('ai_http_' + res.status);
  }

  let data;
  try { data = await res.json(); }
  catch (_) {
    recordAiFailure('bad_json');
    throw new Error('ai_bad_response');
  }

  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;
  if (!content) {
    recordAiFailure('empty_content');
    throw new Error('ai_empty_content');
  }

  const parsed = extractJson(content);
  if (!parsed) {
    if (!isRetry) {
      // Retry 1: попросим вернуть только JSON
      return suggestPanel(prompt + '\n\nОШИБКА: Ты вернул невалидный JSON. Пожалуйста, верни ТОЛЬКО один валидный JSON-объект без markdown-обёрток и текста.', existingTypes, true);
    }
    recordAiFailure('parse_failed');
    throw new Error('ai_parse_failed');
  }

  const validation = validatePanelConfig(parsed);
  if (!validation.ok) {
    if (!isRetry) {
      // Retry 1: укажем на ошибку валидации
      let retryMsg = `\n\nОШИБКА ВАЛИДАЦИИ: ${validation.error}. `;
      if (validation.error === 'group_field_missing') retryMsg += 'Если group="__field", то поле "field" обязательно.';
      if (validation.error === 'agg_field_missing') retryMsg += 'Если agg="sum" или "avg", то поле "aggfield" обязательно.';
      if (validation.error === 'invalid_viz') retryMsg += `Допустимые viz: ${ALLOWED_VIZ.join(', ')}.`;
      if (validation.error === 'invalid_sort') retryMsg += `Допустимые sort: ${ALLOWED_SORT.join(', ')}.`;
      if (validation.error === 'too_many_filters') retryMsg += `Максимум ${MAX_FILTERS} фильтров.`;
      return suggestPanel(prompt + retryMsg, existingTypes, true);
    }
    recordAiFailure('invalid_' + validation.error);
    const e = new Error('ai_invalid_response:' + validation.error);
    e.code = validation.error;
    throw e;
  }

  const ms = Date.now() - t0;
  recordAiSuccess(ms);
  return validation.panel;
}

module.exports = {
  // конфиг (для тестов)
  AI_API_URL, AI_MODEL, AI_TIMEOUT_MS, AI_RATE_LIMIT, AI_RATE_WINDOW, AI_PROMPT_MAX,
  // rate-limit
  checkRateLimit,
  // типы
  collectExistingTypes,
  // ядро
  extractJson, validatePanelConfig, suggestPanel,
  // метрики
  getMetrics, recordAiSuccess, recordAiFailure,
  // реекспорт для тестов
  ALLOWED_VIZ, ALLOWED_GROUP, ALLOWED_AGG, ALLOWED_RANGE, ALLOWED_WIDTH, IDENT_RE,
  ALLOWED_SORT, ALLOWED_FILTER_OP,
};

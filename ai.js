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

// ── Системный промпт для оптимизации существующих панелей ──
const OPTIMIZE_SYSTEM_PROMPT = `Ты — AI-оптимизатор дашбордов для events.atiks.org.
Тебе передают ТЕКУЩИЙ конфиг панели и СЭМПЛ ДАННЫХ (labels + values).
Твоя задача: оценить, оптимален ли текущий конфиг, и если нет — предложить улучшения.

═══ КРАТКИЙ СКИЛЛ ПО API ═══

Тот же, что в suggestPanel:
  viz: line|bar|pie|kpi|table|logs
  group: day|hour|__field|"" (пустая строка = без группировки)
  agg: count|sum|avg
  range: 24h|7d|30d|all
  filters: [{field,op,value}]
  sort: key|value_desc|value_asc
  limit: number|null
  width: 4|6|8|12

═══ ПРАВИЛА ОПТИМИЗАЦИИ ═══

Оцени по следующим критериям:

1. ТИП ГРАФИКА (viz):
   - Если данных ≤ 2 точек → line неинформативен, лучше kpi или bar
   - Если данные категориальные (field-based) и ≤ 8 категорий → pie подходит
   - Если данных > 8 категорий → лучше bar, чем pie
   - Если viz=line, а group="" (без группировки) → это бессмысленно, лучше kpi
   - Если viz=bar + group=day → лучше line для временных рядов
   - Если viz=kpi, а group задан → противоречие, kpi показывает одно число

2. ГРУППИРОВКА (group):
   - Если group=day, а данных ≤ 2 дня → group="" (итого) будет полезнее
   - Если group=hour, а range=30d → слишком много точек, лучше group=day
   - Если group=__field, а все значения одинаковые → бесполезная группировка

3. ДИАПАЗОН (range):
   - Если данных нет (все values = 0) → возможно range слишком мал
   - Если точек > 100 → range можно сузить для лучшей читаемости

4. АГРЕГАЦИЯ (agg):
   - Если agg=sum/avg, а aggfield пуст → ошибка конфигурации
   - Если agg=count с group=__field и есть числовое поле → возможно sum/avg полезнее

5. ФИЛЬТРЫ И СОРТИРОВКА:
   - Если данных очень много и нет limit → предложить limit
   - Если sort=key при group=__field → value_desc обычно полезнее

═══ ФОРМАТ ОТВЕТА ═══

Верни ТОЛЬКО один JSON-объект (без markdown, без пояснений):

Вариант 1 — всё оптимально:
{
  "status": "ok",
  "reason": "Конфигурация оптимальна для текущих данных"
}

Вариант 2 — есть улучшения:
{
  "status": "optimized",
  "reason": "Краткое объяснение на русском (1-2 предложения), почему текущий конфиг не оптимален и что именно меняешь",
  "panel": {
    "title": "Название на русском",
    "viz": "line",
    "type": "",
    "group": "day",
    "field": "",
    "agg": "count",
    "aggfield": "",
    "range": "7d",
    "width": 6,
    "sort": "key",
    "limit": null,
    "filters": []
  }
}

В поле "panel" — ТОЛЬКО стандартные поля конфига панели (те же, что и в suggestPanel).
Не добавляй id, autorefresh, from, to, color, unit и прочие расширенные поля.
Если меняешь только часть параметров — всё равно верни полный конфиг.

ВАЖНО: Если ты считаешь, что текущий конфиг хорош — верни "ok". Не предлагай изменения ради изменений. Изменения оправданы только если текущий конфиг действительно неоптимален.

Ответ — ТОЛЬКО JSON.`;

// ── Валидация ответа optimizePanel ─────────────────
function validateOptimizeResponse(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not_an_object' };
  }
  const status = String(parsed.status || '').toLowerCase();
  if (status !== 'ok' && status !== 'optimized') {
    return { ok: false, error: 'invalid_status' };
  }
  if (status === 'ok') {
    return { ok: true, status: 'ok', reason: String(parsed.reason || '').slice(0, 500) };
  }
  // status === 'optimized' → нужен panel
  if (!parsed.panel || typeof parsed.panel !== 'object') {
    return { ok: false, error: 'missing_panel' };
  }
  const validation = validatePanelConfig(parsed.panel);
  if (!validation.ok) {
    return { ok: false, error: 'invalid_panel:' + validation.error };
  }
  return {
    ok: true,
    status: 'optimized',
    reason: String(parsed.reason || '').slice(0, 500),
    panel: validation.panel,
  };
}

// ── optimizePanel: запрос к LLM для оптимизации ───
async function optimizePanel(config, dataSample, existingTypes, isRetry = false) {
  if (!config || typeof config !== 'object') {
    throw new Error('invalid_config');
  }

  // Собираем контекст: текущий конфиг + сэмпл данных
  const configStr = JSON.stringify({
    viz: config.viz || '',
    type: config.type || '',
    group: config.group || '',
    field: config.field || '',
    agg: config.agg || 'count',
    aggfield: config.aggfield || '',
    range: config.range || '7d',
    width: config.width || 6,
    sort: config.sort || 'key',
    limit: config.limit || null,
    filters: config.filters || [],
  });

  // dataSample: { labels:[], values:[], totalPoints:N }
  const sample = dataSample || {};
  const sampleStr = JSON.stringify({
    labels: Array.isArray(sample.labels) ? sample.labels.slice(0, 20) : [],
    values: Array.isArray(sample.values) ? sample.values.slice(0, 20) : [],
    totalPoints: sample.totalPoints || 0,
  });

  const typesCtx = Array.isArray(existingTypes) && existingTypes.length
    ? `\n\nСуществующие типы событий у пользователя: ${existingTypes.slice(0, AI_TYPES_CTX_MAX).join(', ')}`
    : '';

  const userContent = `Текущий конфиг панели:\n${configStr}\n\nСэмпл данных (первые точки):\n${sampleStr}${typesCtx}`;

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
          { role: 'system', content: OPTIMIZE_SYSTEM_PROMPT },
          { role: 'user',   content: userContent },
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
      return optimizePanel(config, dataSample, existingTypes, true);
    }
    recordAiFailure('parse_failed');
    throw new Error('ai_parse_failed');
  }

  const validation = validateOptimizeResponse(parsed);
  if (!validation.ok) {
    if (!isRetry) {
      return optimizePanel(config, dataSample, existingTypes, true);
    }
    recordAiFailure('invalid_optimize_' + validation.error);
    const e = new Error('ai_invalid_response:' + validation.error);
    e.code = validation.error;
    throw e;
  }

  const ms = Date.now() - t0;
  recordAiSuccess(ms);
  return validation;
}

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

// ═══════════════════════════════════════════════════
// AI DISCOVER — автоматическое создание дашборда из логов
// ═══════════════════════════════════════════════════

// ── Извлечение JSON-массива из ответа модели ──────
function extractJsonArray(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();

  // Снять markdown-обёртку ```json ... ``` или ``` ... ```
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

// ── Статический анализ сэмпла логов (без LLM) ────
// Парсит 100 событий и возвращает компактную схему:
// типы, поля, числовые/строковые, временной диапазон.
function analyzeLogSample(events) {
  const typeCounts = {};
  const fieldTypes = {};
  const fieldValues = {};
  const numericFields = {};
  let minTs = null, maxTs = null;

  for (const ev of events) {
    typeCounts[ev.type] = (typeCounts[ev.type] || 0) + 1;
    if (!minTs || ev.ts < minTs) minTs = ev.ts;
    if (!maxTs || ev.ts > maxTs) maxTs = ev.ts;

    let payload;
    try { payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload; } catch (_) { continue; }
    if (!payload || typeof payload !== 'object') continue;

    for (const [k, v] of Object.entries(payload)) {
      if (v === null || v === undefined) continue;
      if (!fieldTypes[k]) fieldTypes[k] = typeof v === 'number' ? 'number' : 'string';
      if (!fieldValues[k]) fieldValues[k] = new Set();
      if (fieldValues[k].size < 20) fieldValues[k].add(String(v));

      const num = Number(v);
      if (!isNaN(num) && v !== '' && v !== null) {
        if (!numericFields[k]) numericFields[k] = { sum: 0, min: Infinity, max: -Infinity, count: 0 };
        numericFields[k].sum += num;
        numericFields[k].min = Math.min(numericFields[k].min, num);
        numericFields[k].max = Math.max(numericFields[k].max, num);
        numericFields[k].count++;
      }
    }
  }

  // Определяем длительность для подсказки range
  let durationHint = '7d';
  if (minTs && maxTs) {
    const diffMs = new Date(maxTs) - new Date(minTs);
    const diffHours = diffMs / 3600000;
    if (diffHours < 2) durationHint = '24h';
    else if (diffHours < 48) durationHint = '24h';
    else if (diffHours < 24 * 14) durationHint = '7d';
    else if (diffHours < 24 * 60) durationHint = '30d';
    else durationHint = 'all';
  }

  return {
    totalEvents: events.length,
    uniqueTypes: Object.entries(typeCounts).sort((a, b) => b[1] - a[1]),
    fields: Object.entries(fieldTypes).map(([name, type]) => ({
      name, type,
      uniqueValues: fieldValues[name] ? fieldValues[name].size : 0,
      sampleValues: fieldValues[name] ? Array.from(fieldValues[name]).slice(0, 5) : [],
      numeric: numericFields[name] || null
    })),
    timeRange: { from: minTs, to: maxTs },
    durationHint
  };
}

// ── Системный промпт для discover ─────────────────
const DISCOVER_SYSTEM_PROMPT = `Ты — аналитик данных для дашборда events.atiks.org.
Тебе передают СХЕМУ логов (типы событий, поля payload, числовые/строковые).
Твоя задача: предложить 3–4 панели дашборда, которые дадут наибольшую ценность.

═══ КРАТКИЙ СКИЛЛ ПО API ═══

  viz: line|bar|pie|kpi|table|logs
  group: day|hour|__field|"" (пустая строка = без группировки = итого)
  agg: count|sum|avg
  range: 24h|7d|30d|all
  filters: [{field,op,value}]
  sort: key|value_desc|value_asc
  limit: number|null
  width: 4|6|8|12

group=__field → "field" обязательно (имя поля payload)
agg=sum|avg   → "aggfield" обязательно (числовое поле)
viz=pie       → group=__field с категориальным полем (≤8 уникальных значений)
viz=kpi       → group="" (итого), agg=count или sum/avg
viz=line      → group=day или hour (временные ряды)
viz=bar       → group=__field или day/hour
viz=table     → group=__field (агрегация по полю)

═══ ПРАВИЛА ═══

1. Используй РАЗНЫЕ viz — не повторяй один тип дважды.
2. Если есть числовые поля — хотя бы одна панель с agg=sum или avg.
3. Если данные охватывают >1 день — хотя бы одна панель с group=day или hour.
4. Если есть категориальные поля (≤20 уникальных) — pie или bar с group=__field.
5. Всегда включай одну KPI-панель с общим count.
6. type подбирай по самым частым типам из uniqueTypes.
7. range подбирай по durationHint из схемы.
8. width: для KPI — 4, для линий/баров — 6 или 8, для таблиц — 8 или 12.
9. title — конкретный и понятный ("Выручка по дням", а не "График 1").

═══ ФОРМАТ ОТВЕТА ═══

Только JSON-массив. Никакого текста, markdown, пояснений.
[
  {"title":"...","viz":"...","type":"...","group":"...","field":"","agg":"...","aggfield":"","range":"...","width":6,"sort":"key","limit":null,"filters":[]},
  ...
]

Не добавляй id, autorefresh, from, to, color, unit.
Все строковые значения в нижнем регистре (кроме title).
Пустые строки вместо null.
Фильтры — пустой массив [] если не нужны.
sort: "key" по умолчанию, "value_desc" для топов.
limit: null если не нужен, число если просят топ.

Ответ — ТОЛЬКО JSON-массив.`;

// ── Главная функция discover ──────────────────────
async function discoverPanels(events, isRetry = false) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('no_events');
  }

  // 1. Статический анализ сэмпла
  const schema = analyzeLogSample(events);

  // 2. Формируем контекст для LLM
  const typesStr = schema.uniqueTypes.map(([t, c]) => `${t}: ${c}`).join(', ');
  const fieldsStr = schema.fields.map(f => {
    let desc = `${f.name} (${f.type}`;
    if (f.numeric) {
      desc += `, числовой, min=${f.numeric.min}, max=${f.numeric.max}, ${f.numeric.count} значений`;
    } else {
      desc += `, ${f.uniqueValues} уникальных`;
      if (f.sampleValues.length) desc += `: ${f.sampleValues.join(', ')}`;
    }
    desc += ')';
    return desc;
  }).join('\n  ');

  const userContent = `ДАННЫЕ ЛОГОВ (${schema.totalEvents} событий):
Временной диапазон: ${schema.timeRange.from || '?'} → ${schema.timeRange.to || '?'}
Подходящий range: ${schema.durationHint}

Типы событий (по популярности):
  ${typesStr || 'нет данных'}

Поля payload:
  ${fieldsStr || 'нет полей'}`;

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
        temperature: 0.3,
        messages: [
          { role: 'system', content: DISCOVER_SYSTEM_PROMPT },
          { role: 'user',   content: userContent },
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

  // 3. Парсим ответ — ожидаем JSON-массив
  let parsed = extractJsonArray(content);
  if (!parsed || !Array.isArray(parsed)) {
    // Retry: попросим вернуть массив
    if (!isRetry) {
      return discoverPanels(events, true);
    }
    recordAiFailure('parse_failed');
    throw new Error('ai_parse_failed');
  }

  // 4. Валидируем каждую панель
  const validPanels = [];
  for (const cfg of parsed) {
    const v = validatePanelConfig(cfg);
    if (v.ok) validPanels.push(v.panel);
  }

  if (validPanels.length < 1) {
    if (!isRetry) {
      return discoverPanels(events, true);
    }
    recordAiFailure('no_valid_panels');
    throw new Error('ai_no_valid_panels');
  }

  // Ограничиваем до 4 панелей
  const result = validPanels.slice(0, 4);

  const ms = Date.now() - t0;
  recordAiSuccess(ms);

  // 5. Формируем summary
  const summaryTypes = schema.uniqueTypes.slice(0, 4).map(([t]) => t).join(', ');
  const numericFieldNames = schema.fields.filter(f => f.numeric).map(f => f.name);
  const summary = `Найдено ${schema.uniqueTypes.length} тип(ов) событий (${summaryTypes}), ` +
    schema.fields.length + ' полей payload' +
    (numericFieldNames.length ? ', числовые: ' + numericFieldNames.join(', ') : '') +
    '. Сгенерировано ' + result.length + ' панелей.';

  return { panels: result, summary, schema: {
    totalEvents: schema.totalEvents,
    uniqueTypes: schema.uniqueTypes.length,
    fields: schema.fields.length,
    durationHint: schema.durationHint
  }};
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
  extractJson, validatePanelConfig, suggestPanel, optimizePanel, validateOptimizeResponse,
  // discover
  analyzeLogSample, extractJsonArray, discoverPanels,
  // метрики
  getMetrics, recordAiSuccess, recordAiFailure,
  // реекспорт для тестов
  ALLOWED_VIZ, ALLOWED_GROUP, ALLOWED_AGG, ALLOWED_RANGE, ALLOWED_WIDTH, IDENT_RE,
  ALLOWED_SORT, ALLOWED_FILTER_OP,
};

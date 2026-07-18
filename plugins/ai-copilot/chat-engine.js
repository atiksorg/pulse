/**
 * plugins/ai-copilot/chat-engine.js — Agentic loop для AI-копилота
 *
 * Собирает system prompt с описанием инструментов, отправляет в LLM,
 * парсит ответ на наличие tool_call, выполняет инструмент, возвращает
 * результат в LLM — и так до финального текстового ответа.
 *
 * Модель НЕ поддерживает native function-calling — tool-calling
 * эмулируется через форматированный JSON в system prompt.
 */
'use strict';

const { callLlm, extractJson } = require('../shared/llm-client');
const { TOOL_SCHEMAS, executeTool } = require('./tools');

const MAX_TOOL_ROUNDS = 6; // максимум итераций loop'а

// ═══════════════════════════════════════════════════════
// SYSTEM PROMPT
// ═══════════════════════════════════════════════════════

function _buildSystemPrompt(dashboardXml) {
  // Собираем описание всех инструментов
  const toolsDesc = TOOL_SCHEMAS.map(t => {
    const params = Object.entries((t.parameters && t.parameters.properties) || {})
      .map(([k, v]) => `    ${k} (${v.type}): ${v.description || ''}`)
      .join('\n');
    const required = (t.parameters && t.parameters.required) || [];
    return `
  ◆ ${t.name}${t.needsConfirm ? ' ⚠️ НУЖНО ПОДТВЕРЖДЕНИЕ' : ''}
    ${t.description}
    Параметры:
${params || '    (нет параметров)'}
    Обязательные: ${required.length ? required.join(', ') : '(нет)'}
`;
  }).join('\n');

  // Контекст текущего дашборда (XML) — если передан клиентом
  const dashContext = dashboardXml
    ? `

═══════════════════════════════════════════════════════
ТЕКУЩИЙ ДАШБОРД ПОЛЬЗОВАТЕЛЯ (XML)
═══════════════════════════════════════════════════════
Вот XML-описание того, что сейчас отображается на дашборде пользователя.
Используй эти данные, чтобы понимать контекст — какие панели уже есть,
какие типы событий отслеживаются, какие агрегации используются.

${dashboardXml}

При ответе пользователю учитывай, что у него уже есть эти панели.
Не создавай дубликаты без просьбы. При рекомендациях ссылайся на существующие панели.
═══════════════════════════════════════════════════════`
    : '';

  return `Ты — AI-копилот для дашборда аналитики событий events.atiks.org.
Ты помогаешь пользователю исследовать данные, строить графики, настраивать уведомления и отчёты.
Отвечай на РУССКОМ языке. Будь конкретным и полезным.
${dashContext}

═══════════════════════════════════════════════════════
КРАТКИЙ СКИЛЛ ПО API
═══════════════════════════════════════════════════════

POST /e  — запись события:
  GET  /e?src={src}&type=ТИП&ключ=значение
  POST /e  { src, type, ...payload }
  Ответ: 204 (всегда).

POST /e/batch — пакетная запись (до 1000):
  POST /e/batch  [{ src, type, ... }, ...]

GET /s — чтение статистики:
  src    — (обязательно) идентификатор источника
  type   — фильтр по типу события
  group  — day | hour | minute | week | month | field:ИМЯ
  agg    — count | sum:ПОЛЕ | avg:ПОЛЕ
  from   — ISO timestamp
  to     — ISO timestamp
  filters — JSON-массив [{field, op, value}]
  sort   — key | value_desc | value_asc
  limit  — число (макс. 500)
  Ответ: { total, groups: [{bucket, value}, ...] }

group=raw — последние события в виде таблицы:
  group=raw&limit=100 → { events: [{ts, type, payload}, ...] }

═══════════════════════════════════════════════════════
ИНСТРУМЕНТЫ (function calling)
═══════════════════════════════════════════════════════
${toolsDesc}
═══════════════════════════════════════════════════════
ФОРМАТ ОТВЕТА (СТРОГО!)
═══════════════════════════════════════════════════════

Всегда отвечай ТОЛЬКО валидным JSON. Никакого текста вне JSON.

Вариант 1 — вызов ОДНОГО инструмента:
{
  "tool_call": "query_metric",
  "args": { "type": "purchase", "group": "day", "range": "7d" }
}

Вариант 2 — вызов НЕСКОЛЬКИХ инструментов:
[
  { "tool_call": "list_dashboards", "args": {} },
  { "tool_call": "query_metric", "args": { "type": "error", "range": "24h" } }
]

Вариант 3 — финальный ответ пользователю (без tool_call):
{
  "reply": "Текст ответа пользователю на русском языке."
}

═══════════════════════════════════════════════════════
MARKDOWN (для поля reply)
═══════════════════════════════════════════════════════

В поле "reply" используй Markdown для форматирования:
  **жирный**       → жирный текст
  *курсив*         → курсив
  \`код\`           → инлайн-код
  \`\`\`...\\n...\\n\`\`\` → блок кода
  # Заголовок      → заголовок
  - пункт списка   → маркированный список
  1. нумерованный  → нумерованный список
  [текст](url)     → ссылка
  | A | B |        → таблица

═══════════════════════════════════════════════════════
INLINE-КНОПКИ (action buttons)
═══════════════════════════════════════════════════════

В тексте reply ТЫ МОЖЕШЬ вставлять интерактивные кнопки.
Пользователь увидит их как кликабельные кнопки в чате.
При нажатии — система выполнит указанный инструмент.

Формат кнопки (строго без пробелов внутри скобок):

  {btn:Заголовок|tool_name|параметры_JSON}

Примеры:

  {btn:📈 Показать продажи|query_metric|{"type":"purchase","group":"day","range":"7d"}}

  {btn:📊 Добавить график продаж|_add_panel|{"title":"Продажи по дням","viz":"line","type":"purchase","group":"day","range":"7d"}}

  {btn:📋 Список дашбордов|list_dashboards|{}}

  {btn:🔄 Обновить данные|_refresh|{}}

  {btn:🗑 Удалить «Продажи»|_remove_panel|{"panel_id":"panel_abc123"}}

═══════════════════════════════════════════════════════
ВАЖНО: _add_panel vs create_panel
═══════════════════════════════════════════════════════

_add_panel — КЛИЕНТСКИЙ action (мгновенный, без LLM):
  • Панель добавляется НА АКТИВНЫЙ дашборд пользователя мгновенно
  • НЕ требует dashboard_id — берётся текущий активный дашборд
  • НЕ требует подтверждения пользователя
  • НЕ ходит на сервер копилота — всё на клиенте
  • Параметры: title, viz, type, group, field, agg, aggfield,
    range, width, sort, limit, color, unit, formatType,
    lineStyle, tension, stacked, cumulative, compare, secondAxis,
    breakdownfield, filters, thresholds, gaugeMin, gaugeMax
  • Используй В INLINE-КНОПКАХ для быстрого добавления графиков

create_panel — СЕРВЕРНЫЙ инструмент (через agentic loop):
  • Требует dashboard_id
  • Требует ПОДТВЕРЖДЕНИЕ пользователя
  • Используй когда пользователь просит СОЗДАТЬ панель текстом

_remove_panel — КЛИЕНТСКИЙ action (мгновенное удаление):
  • Удаляет панель по panel_id с активного дашборда
  • Параметры: panel_id (обязательно)

Правила кнопок:
1. Добавляй кнопки, когда предлагаешь пользователю конкретные действия.
2. Можно несколько кнопок в одном reply — каждая на отдельной строке.
3. Для ДОБАВЛЕНИЯ графиков на дашборд ВСЕГДА используй _add_panel (не create_panel).
4. Для УДАЛЕНИЯ панелей используй _remove_panel.
5. Для query_metric, list_dashboards и других — используй имя инструмента напрямую.
6. Для сервисных кнопок используй: _refresh, _navigate, _help.
7. Не добавляй кнопки в каждый ответ — только когда это реально полезно.
8. Объясни текстом, что делает кнопка, ПЕРЕД кнопкой.
9. Когда предлагаешь несколько вариантов графиков — давай каждую как отдельную _add_panel кнопку.

═══════════════════════════════════════════════════════
ПРАВИЛА
═══════════════════════════════════════════════════════

1. Отвечай ТОЛЬКО JSON. Никакого текста вне JSON.
2. Если нужны данные — вызови инструмент, НЕ отвечай пользователю «давайте посмотрим».
3. Для создания/обновления/удаления панелей, алертов, отчётов — вызови соответствующий инструмент.
4. Если инструмент с флагом НУЖНО ПОДТВЕРЖДЕНИЕ — он будет выполнен только после подтверждения
   пользователем. Ты можешь вызвать его — система сама предложит подтверждение.
5. Если пользователь просит «покажи» / «построй» / «добавь» — используй _add_panel через inline-кнопку.
6. Если пользователь спрашивает общую информацию — отвечай через reply.
7. Не создавай панели без явной просьбы пользователя.
8. Если данные пустые — скажи об этом, не фантазируй.
9. В reply используй Markdown для форматирования.
10. В reply используй inline-кнопки {btn:...} когда предлагаешь действия.
11. Отвечай подробно и полезно — не односложными фразами.
12. Для быстрого добавления графиков ВСЕГДА используй _add_panel (клиентский, мгновенный).
    НЕ используй create_panel в inline-кнопках — он требует dashboard_id и подтверждения.

═══════════════════════════════════════════════════════
ВАЖНО: параметр type в query_metric и create_panel
═══════════════════════════════════════════════════════

Когда пользователь просит данные по ВСЕМ типам событий («все события»,
«по всем видам», «общая статистика» и т.п.):
  — Передавай type: ""  (пустая строка) или НЕ передавай type вообще.
  — НИКОГДА не передавай type: "*" — символ звёздочки НЕ является валидным
    значением и не будет распознан как «все типы».
  — Пустая строка = API вернёт данные по всем типам событий.

Когда пользователь просит конкретный тип («покажи продажи», «ошибки»):
  — Передавай type: "purchase", type: "error" и т.д.

Ответ — ТОЛЬКО JSON.`;
}

// ═══════════════════════════════════════════════════════
// ОСНОВНОЙ ЦИКЛ
// ═══════════════════════════════════════════════════════

/**
 * Обработать сообщение пользователя через agentic loop.
 *
 * @param {string} userMessage — текст сообщения
 * @param {object} session     — { src, token }
 * @param {Array}  history     — массив предыдущих сообщений [{role, content}, ...]
 * @param {object} context     — { db }
 * @returns {Promise<{reply: string, toolCalls: Array}>}
 */
async function processMessage(userMessage, session, history, context, dashboardXml) {
  const systemPrompt = _buildSystemPrompt(dashboardXml);
  const toolCalls = [];

  // Собираем messages[] для LLM
  const messages = [
    { role: 'system', content: systemPrompt },
  ];

  // Добавляем историю (последние 50 сообщений — модель поддерживает 128K+ токенов)
  const recentHistory = history.slice(-50);
  for (const msg of recentHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Добавляем текущее сообщение пользователя
  messages.push({ role: 'user', content: userMessage });

  // Agentic loop
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let llmResponse;
    try {
      llmResponse = await callLlm({
        messages,
        temperature: 0.3,
        maxTokens: 4096,
      });
    } catch (e) {
      return { reply: `⚠️ Ошибка LLM: ${e.message}`, toolCalls, error: true };
    }

    const content = llmResponse.content;
    const parsed = _parseLlmResponse(content);

    // Если ответ — финальный reply
    if (parsed && parsed.reply) {
      return { reply: parsed.reply, toolCalls };
    }

    // Если ответ — массив tool_calls
    const calls = Array.isArray(parsed) ? parsed : (parsed && parsed.tool_call ? [parsed] : null);

    if (!calls || calls.length === 0) {
      // Модель не вернула ни reply, ни tool_call — возвращаем сырой текст
      return { reply: content, toolCalls };
    }

    // Выполняем каждый tool_call
    let toolResultsForLlm = '';

    for (const call of calls) {
      const toolName = call.tool_call;
      const toolArgs = call.args || {};

      if (!toolName) continue;

      const schema = _getToolMeta(toolName);

      // Записываем tool_call в историю
      toolCalls.push({
        name: toolName,
        args: toolArgs,
        needsConfirm: schema ? schema.needsConfirm : false,
      });

      // Если нужено подтверждение — прерываем loop и возвращаем pending
      if (schema && schema.needsConfirm) {
        return {
          reply: null,
          toolCalls,
          pendingConfirmation: {
            tool: toolName,
            args: toolArgs,
            description: _describeToolCall(toolName, toolArgs),
          },
        };
      }

      // Выполняем инструмент (без подтверждения)
      let result;
      try {
        result = await executeTool(toolName, toolArgs, session, context);
      } catch (e) {
        result = { error: e.message };
      }

      toolResultsForLlm += `\n[Результат ${toolName}]: ${JSON.stringify(result).slice(0, 4000)}\n`;
    }

    // Добавляем результаты в messages для следующей итерации
    messages.push({ role: 'assistant', content: content });
    messages.push({
      role: 'user',
      content: 'Результаты выполнения инструментов:\n' + toolResultsForLlm + '\nОтветь пользователю на основе полученных данных. Только JSON.',
    });
  }

  // Исчерпаны итерации — возвращаем что есть
  return {
    reply: '⚠️ Достигнут лимит итераций. Попробуйте уточнить запрос.',
    toolCalls,
    error: true,
  };
}

/**
 * Обработать подтверждённый tool_call (после confirm от пользователя).
 *
 * @param {string} toolName — имя инструмента
 * @param {object} toolArgs — аргументы
 * @param {object} session  — { src, token }
 * @param {object} context  — { db }
 * @returns {Promise<object>} — результат выполнения
 */
async function executeConfirmedTool(toolName, toolArgs, session, context) {
  return executeTool(toolName, toolArgs, session, context);
}

// ═══════════════════════════════════════════════════════
// ПАРСИНГ ОТВЕТА LLM
// ═══════════════════════════════════════════════════════

/**
 * Парсит ответ LLM. Может быть:
 *   - { reply: "..." } — финальный ответ
 *   - { tool_call: "...", args: {...} } — один инструмент
 *   - [ { tool_call: "...", args: {...} }, ... ] — несколько инструментов
 *   - null — не удалось распарсить
 */
function _parseLlmResponse(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();

  // Снять markdown-обёртку
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (fence) s = fence[1].trim();

  // Попробовать как JSON-массив
  const arr = _tryParseArray(s);
  if (arr) return arr;

  // Попробовать как JSON-объект
  const obj = extractJson(s);
  if (obj) return obj;

  // Последняя попытка: найти JSON в тексте (модель могла добавить текст до/после)
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(s.slice(firstBrace, lastBrace + 1));
    } catch (_) {}
  }

  // Найти JSON-массив в тексте
  const firstBracket = s.indexOf('[');
  const lastBracket = s.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(s.slice(firstBracket, lastBracket + 1));
    } catch (_) {}
  }

  return null;
}

function _tryParseArray(s) {
  const firstBracket = s.indexOf('[');
  const lastBracket = s.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1 || lastBracket <= firstBracket) return null;
  try {
    const arr = JSON.parse(s.slice(firstBracket, lastBracket + 1));
    return Array.isArray(arr) ? arr : null;
  } catch (_) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════
// УТИЛИТЫ
// ═══════════════════════════════════════════════════════

function _getToolMeta(name) {
  return TOOL_SCHEMAS.find(t => t.name === name) || null;
}

/**
 * Сформировать человекочитаемое описание tool_call для карточки подтверждения.
 */
function _describeToolCall(name, args) {
  switch (name) {
    case 'create_panel':
      return `Создать панель "${args.title || 'Без названия'}" (${args.viz || 'kpi'}) в дашборде ${args.dashboard_id || '?'}`;
    case 'update_panel':
      return `Обновить панель ${args.panel_id} в дашборде ${args.dashboard_id}`;
    case 'delete_panel':
      return `Удалить панель ${args.panel_id} из дашборда ${args.dashboard_id}`;
    case 'create_alert_rule':
      return `Создать алерт "${args.label || 'Алерт'}" для панели ${args.panel_id}`;
    case 'create_report_schedule':
      return `Настроить расписание отчёта для дашборда ${args.dashboard_id} (${args.schedule_type || 'daily'} в ${args.schedule_time || '09:00'})`;
    default:
      return `Выполнить ${name}(${JSON.stringify(args).slice(0, 200)})`;
  }
}

module.exports = {
  processMessage,
  executeConfirmedTool,
  buildSystemPrompt: _buildSystemPrompt,
};

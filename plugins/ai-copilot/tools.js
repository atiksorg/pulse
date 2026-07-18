/**
 * plugins/ai-copilot/tools.js — Инструменты для AI-копилота
 *
 * Каждый tool:
 *   - schema — JSON Schema для LLM (имя, описание, параметры)
 *   - needsConfirm — нужно ли подтверждение пользователя перед выполнением
 *   - execute(args, session, context) — реальный HTTP-вызов к API
 *
 * Tools НЕ читают БД напрямую — они делают HTTP-запросы
 * к уже существующим эндпоинтам сервера, как обычный клиент.
 */
'use strict';

const http  = require('http');
const https = require('https');

// ── Утилита: HTTP-запрос к локальному серверу ──────
function _httpRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const PORT = process.env.PORT || 3333;
    const opts = {
      hostname: '127.0.0.1',
      port: PORT,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    };
    if (token) {
      opts.headers['Authorization'] = 'Bearer ' + token;
    }

    const payload = body ? JSON.stringify(body) : null;
    if (payload) {
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            resolve({ ok: false, status: res.statusCode, data: json });
          } else {
            resolve({ ok: true, status: res.statusCode, data: json });
          }
        } catch (_) {
          resolve({ ok: res.statusCode < 400, status: res.statusCode, data: data });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('http_timeout'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════
// ОПРЕДЕЛЕНИЯ ИНСТРУМЕНТОВ (schemas + flags)
// ═══════════════════════════════════════════════════════

const TOOL_SCHEMAS = [
  {
    name: 'query_metric',
    description: 'Получить агрегированную статистику событий. Позволяет узнать количество, сумму, среднее по любому типу событий за период.',
    parameters: {
      type: 'object',
      properties: {
        type:       { type: 'string', description: 'Тип события (purchase, signup, error и т.д.). Пустая строка "" = все типы. Никогда не используй "*"' },
        group:      { type: 'string', enum: ['day', 'hour', 'minute', 'week', 'month', ''], description: 'Группировка' },
        agg:        { type: 'string', description: 'Агрегация: count, sum:ПОЛЕ, avg:ПОЛЕ' },
        range:      { type: 'string', enum: ['24h', '7d', '30d', 'all'], description: 'Диапазон' },
        field:      { type: 'string', description: 'Поле для group=field:ИМЯ (без префикса field:)' },
        sort:       { type: 'string', enum: ['key', 'value_desc', 'value_asc'] },
        limit:      { type: 'number', description: 'Максимум групп (0-500)' },
      },
      required: [],
    },
    needsConfirm: false,
  },
  {
    name: 'list_dashboards',
    description: 'Получить список всех дашбордов текущего пользователя (id, имя, количество панелей).',
    parameters: { type: 'object', properties: {}, required: [] },
    needsConfirm: false,
  },
  {
    name: 'get_dashboard',
    description: 'Получить полный конфиг одного дашборда (включая массив panels с настройками каждой панели).',
    parameters: {
      type: 'object',
      properties: {
        dashboard_id: { type: 'string', description: 'ID дашборда' },
      },
      required: ['dashboard_id'],
    },
    needsConfirm: false,
  },
  {
    name: 'create_panel',
    description: 'Добавить новую панель (график) в дашборд. Автоматически читает текущий дашборд, добавляет панель и отправляет обновление.',
    parameters: {
      type: 'object',
      properties: {
        dashboard_id: { type: 'string', description: 'ID дашборда' },
        title:        { type: 'string', description: 'Название панели' },
        viz:          { type: 'string', enum: ['line', 'bar', 'pie', 'kpi', 'table', 'logs', 'gauge', 'heatmap'] },
        type:         { type: 'string', description: 'Тип события или пустая строка' },
        group:        { type: 'string', enum: ['day', 'hour', 'minute', 'week', 'month', '__field', ''] },
        field:        { type: 'string', description: 'Имя поля payload (для group=__field)' },
        agg:          { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max', 'median', 'p95', 'p99'] },
        aggfield:     { type: 'string', description: 'Поле для sum/avg' },
        range:        { type: 'string', enum: ['24h', '7d', '30d', 'all'] },
        width:        { type: 'number', enum: [4, 6, 8, 12] },
        sort:         { type: 'string', enum: ['key', 'value_desc', 'value_asc'] },
        limit:        { type: 'number', description: 'Топ N (null = без лимита)' },
      },
      required: ['title', 'viz'],
    },
    needsConfirm: true,
  },
  {
    name: 'update_panel',
    description: 'Обновить существующую панель в дашборде. Находит панель по panel_id в panels_json, обновляет её параметры.',
    parameters: {
      type: 'object',
      properties: {
        dashboard_id: { type: 'string' },
        panel_id:     { type: 'string', description: 'ID панели внутри panels_json' },
        title:        { type: 'string' },
        viz:          { type: 'string' },
        type:         { type: 'string' },
        group:        { type: 'string' },
        field:        { type: 'string' },
        agg:          { type: 'string' },
        aggfield:     { type: 'string' },
        range:        { type: 'string' },
        width:        { type: 'number' },
        sort:         { type: 'string' },
        limit:        { type: 'number' },
      },
      required: ['dashboard_id', 'panel_id'],
    },
    needsConfirm: true,
  },
  {
    name: 'delete_panel',
    description: 'Удалить панель из дашборда.',
    parameters: {
      type: 'object',
      properties: {
        dashboard_id: { type: 'string' },
        panel_id:     { type: 'string', description: 'ID панели' },
      },
      required: ['dashboard_id', 'panel_id'],
    },
    needsConfirm: true,
  },
  {
    name: 'create_alert_rule',
    description: 'Создать правило порогового уведомления (alert) для панели. Отправляет уведомление в Telegram при превышении/падении метрики.',
    parameters: {
      type: 'object',
      properties: {
        dashboard_id:       { type: 'string' },
        panel_id:           { type: 'string', description: 'ID панели для привязки алерта' },
        label:              { type: 'string', description: 'Название правила' },
        min_value:          { type: 'number', description: 'Минимальный порог (null = без)' },
        max_value:          { type: 'number', description: 'Максимальный порог (null = без)' },
        telegram_bot_token: { type: 'string', description: 'Токен Telegram-бота' },
        chat_ids:           { type: 'string', description: 'ID чатов через запятую' },
        check_interval_sec: { type: 'number', description: 'Интервал проверки (сек)' },
        cooldown_sec:       { type: 'number', description: 'Cooldown (сек)' },
      },
      required: ['dashboard_id', 'panel_id', 'telegram_bot_token', 'chat_ids'],
    },
    needsConfirm: true,
  },
  {
    name: 'create_report_schedule',
    description: 'Настроить расписание отправки PDF/XML-отчёта по дашборду в Telegram.',
    parameters: {
      type: 'object',
      properties: {
        dashboard_id:       { type: 'string' },
        bot_id:             { type: 'number', description: 'ID бота EG (число)' },
        bot_token:          { type: 'string', description: 'Токен EG-бота' },
        telegram_bot_token: { type: 'string', description: 'Токен Telegram-бота' },
        chat_ids:           { type: 'string', description: 'Telegram chat ID через запятую' },
        schedule_type:      { type: 'string', enum: ['daily', 'weekly', 'interval'] },
        schedule_time:      { type: 'string', description: 'HH:MM' },
        schedule_days:      { type: 'string', description: 'Дни недели 0-6 через запятую' },
        schedule_hours:     { type: 'number', description: 'Интервал (часы, для interval)' },
        timezone:           { type: 'string', description: 'UTC+HH:MM' },
        prompt:             { type: 'string', description: 'Промпт для EG-функции' },
      },
      required: ['dashboard_id', 'bot_id', 'bot_token', 'telegram_bot_token', 'chat_ids'],
    },
    needsConfirm: true,
  },
  {
    name: 'explain_anomaly',
    description: 'Получить сырые события за период для объяснения аномалии (скачок, провал, ошибка). Возвращает последние события.',
    parameters: {
      type: 'object',
      properties: {
        type:       { type: 'string', description: 'Тип события (или пустая строка)' },
        from:       { type: 'string', description: 'ISO timestamp начала' },
        to:         { type: 'string', description: 'ISO timestamp конца' },
        limit:      { type: 'number', description: 'Максимум событий (по умолчанию 50)' },
      },
      required: ['from', 'to'],
    },
    needsConfirm: false,
  },
];

// ═══════════════════════════════════════════════════════
// РЕАЛИЗАЦИИ ИНСТРУМЕНТОВ
// ═══════════════════════════════════════════════════════

/**
 * Выполнить инструмент по имени.
 * @param {string} name — имя tool
 * @param {object} args — аргументы
 * @param {object} session — { src, token }
 * @param {object} context — { db } (для будущего расширения)
 * @returns {Promise<object>} — результат для LLM
 */
async function executeTool(name, args, session, context) {
  const token = session.token;
  const src = session.src;

  try {
    switch (name) {

      // ── query_metric ───────────────────────────────
      case 'query_metric': {
        const params = new URLSearchParams();
        params.set('src', src);
        if (args.type) params.set('type', args.type);
        if (args.group) {
          if (args.field && args.group === '__field') {
            params.set('group', 'field:' + args.field);
          } else {
            params.set('group', args.group);
          }
        }
        if (args.agg && args.agg !== 'count') params.set('agg', args.agg);
        if (args.range) params.set('range', args.range);
        if (args.sort) params.set('sort', args.sort);
        if (args.limit) params.set('limit', String(args.limit));

        const res = await _httpRequest('GET', '/s?' + params.toString(), null, token);
        if (!res.ok) return { error: 'query_failed', status: res.status, detail: res.data };
        // Ограничиваем размер ответа для LLM
        const data = res.data;
        if (data.groups && data.groups.length > 100) {
          data.groups = data.groups.slice(0, 100);
          data._truncated = true;
        }
        return data;
      }

      // ── list_dashboards ────────────────────────────
      case 'list_dashboards': {
        const res = await _httpRequest('GET', '/dashboards', null, token);
        if (!res.ok) return { error: 'list_failed', status: res.status };
        const list = (res.data.dashboards || []).map(d => ({
          id: d.id,
          name: d.name,
          panels_count: d.panels_count,
          layout_mode: d.layout_mode,
          updated_at: d.updated_at,
        }));
        return { dashboards: list };
      }

      // ── get_dashboard ──────────────────────────────
      case 'get_dashboard': {
        const res = await _httpRequest('GET', '/dashboards', null, token);
        if (!res.ok) return { error: 'get_failed', status: res.status };
        const dash = (res.data.dashboards || []).find(d => d.id === args.dashboard_id);
        if (!dash) return { error: 'dashboard_not_found', dashboard_id: args.dashboard_id };
        return {
          id: dash.id,
          name: dash.name,
          panels: dash.panels || [],
          layout_mode: dash.layout_mode,
          updated_at: dash.updated_at,
        };
      }

      // ── create_panel ───────────────────────────────
      case 'create_panel': {
        // 1. Читаем текущий дашборд
        const listRes = await _httpRequest('GET', '/dashboards', null, token);
        if (!listRes.ok) return { error: 'read_failed' };
        const dash = (listRes.data.dashboards || []).find(d => d.id === args.dashboard_id);
        if (!dash) return { error: 'dashboard_not_found' };

        const panels = Array.isArray(dash.panels) ? dash.panels.slice() : [];
        const panelId = 'cp_' + Date.now().toString(36);
        const newPanel = {
          id: panelId,
          title: args.title || 'Новая панель',
          viz: args.viz || 'kpi',
          type: args.type || '',
          group: args.group || '',
          field: args.field || '',
          agg: args.agg || 'count',
          aggfield: args.aggfield || '',
          range: args.range || '7d',
          width: args.width || 6,
          sort: args.sort || 'key',
          limit: args.limit != null ? args.limit : null,
          autorefresh: 0,
        };
        panels.push(newPanel);

        // 2. Отправляем обновлённый массив panels
        const updateRes = await _httpRequest('PUT', '/dashboards/' + args.dashboard_id,
          { panels, name: dash.name, layout_mode: dash.layout_mode }, token);
        if (!updateRes.ok) return { error: 'update_failed', status: updateRes.status, detail: updateRes.data };

        return {
          success: true,
          panel_id: panelId,
          title: newPanel.title,
          viz: newPanel.viz,
          panels_total: panels.length,
        };
      }

      // ── update_panel ───────────────────────────────
      case 'update_panel': {
        const listRes = await _httpRequest('GET', '/dashboards', null, token);
        if (!listRes.ok) return { error: 'read_failed' };
        const dash = (listRes.data.dashboards || []).find(d => d.id === args.dashboard_id);
        if (!dash) return { error: 'dashboard_not_found' };

        const panels = Array.isArray(dash.panels) ? dash.panels.map(p => Object.assign({}, p)) : [];
        const idx = panels.findIndex(p => p.id === args.panel_id);
        if (idx === -1) return { error: 'panel_not_found', panel_id: args.panel_id };

        // Обновляем только переданные поля
        const panel = panels[idx];
        for (const k of ['title','viz','type','group','field','agg','aggfield','range','width','sort','limit']) {
          if (args[k] !== undefined && args[k] !== null) panel[k] = args[k];
        }
        panels[idx] = panel;

        const updateRes = await _httpRequest('PUT', '/dashboards/' + args.dashboard_id,
          { panels, name: dash.name, layout_mode: dash.layout_mode }, token);
        if (!updateRes.ok) return { error: 'update_failed', status: updateRes.status };

        return { success: true, panel_id: args.panel_id, updated_fields: Object.keys(args).filter(k => !['dashboard_id','panel_id'].includes(k)) };
      }

      // ── delete_panel ───────────────────────────────
      case 'delete_panel': {
        const listRes = await _httpRequest('GET', '/dashboards', null, token);
        if (!listRes.ok) return { error: 'read_failed' };
        const dash = (listRes.data.dashboards || []).find(d => d.id === args.dashboard_id);
        if (!dash) return { error: 'dashboard_not_found' };

        const panels = (dash.panels || []).filter(p => p.id !== args.panel_id);
        const updateRes = await _httpRequest('PUT', '/dashboards/' + args.dashboard_id,
          { panels, name: dash.name, layout_mode: dash.layout_mode }, token);
        if (!updateRes.ok) return { error: 'update_failed', status: updateRes.status };

        return { success: true, deleted_panel_id: args.panel_id, panels_remaining: panels.length };
      }

      // ── create_alert_rule ──────────────────────────
      case 'create_alert_rule': {
        if (!args.panel_id) return { error: 'panel_id_required' };
        const body = {
          is_active: true,
          label: args.label || 'Алерт',
          panel_agg: 'count',
          panel_range: '24h',
          min_value: args.min_value != null ? args.min_value : null,
          max_value: args.max_value != null ? args.max_value : null,
          telegram_bot_token: args.telegram_bot_token,
          chat_ids: args.chat_ids,
          check_interval_sec: args.check_interval_sec || 60,
          cooldown_sec: args.cooldown_sec || 900,
          notify_on_recovery: true,
          check_mode: 'absolute',
          on_empty: 'treat_as_zero',
        };

        const res = await _httpRequest('PUT',
          '/alerts/' + args.dashboard_id + '/' + args.panel_id, body, token);
        if (!res.ok) return { error: 'create_alert_failed', status: res.status, detail: res.data };
        return {
          success: true,
          config_id: res.data.config && res.data.config.id,
          label: body.label,
        };
      }

      // ── create_report_schedule ─────────────────────
      case 'create_report_schedule': {
        const body = {
          is_active: true,
          bot_id: args.bot_id,
          bot_token: args.bot_token,
          telegram_bot_token: args.telegram_bot_token,
          chat_ids: args.chat_ids,
          schedule_type: args.schedule_type || 'daily',
          schedule_time: args.schedule_time || '09:00',
          schedule_days: args.schedule_days || '1,2,3,4,5',
          schedule_hours: args.schedule_hours || 0,
          timezone: args.timezone || 'UTC+03:00',
          prompt: args.prompt || '',
          function_id: 697,
          size: '9:16',
        };

        const res = await _httpRequest('PUT', '/reports/' + args.dashboard_id, body, token);
        if (!res.ok) return { error: 'create_report_failed', status: res.status, detail: res.data };
        return {
          success: true,
          dashboard_id: args.dashboard_id,
          schedule_type: body.schedule_type,
          schedule_time: body.schedule_time,
        };
      }

      // ── explain_anomaly ────────────────────────────
      case 'explain_anomaly': {
        const params = new URLSearchParams();
        params.set('src', src);
        params.set('group', 'raw');
        params.set('limit', String(args.limit || 50));
        if (args.type) params.set('type', args.type);
        if (args.from) params.set('from', args.from);
        if (args.to) params.set('to', args.to);

        const res = await _httpRequest('GET', '/s?' + params.toString(), null, token);
        if (!res.ok) return { error: 'explain_failed', status: res.status };

        const events = res.data.events || [];
        // Сжимаем: оставляем ts, type, и ключевые поля payload
        const summary = events.slice(0, 30).map(ev => {
          let payload = {};
          try { payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : (ev.payload || {}); } catch (_) {}
          return { ts: ev.ts, type: ev.type, payload };
        });

        return {
          events_count: events.length,
          time_range: { from: args.from, to: args.to },
          events: summary,
        };
      }

      default:
        return { error: 'unknown_tool', name };
    }
  } catch (e) {
    return { error: 'tool_execution_failed', name, message: e.message };
  }
}

/**
 * Получить описание инструмента по имени (для включения в system prompt).
 */
function getToolSchema(name) {
  return TOOL_SCHEMAS.find(t => t.name === name) || null;
}

module.exports = {
  TOOL_SCHEMAS,
  executeTool,
  getToolSchema,
};

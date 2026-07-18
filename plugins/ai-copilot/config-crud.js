/**
 * plugins/ai-copilot/config-crud.js — HTTP-эндпоинты для AI-копилота
 *
 * Регистрирует:
 *   POST   /ai-copilot/session           — создать сессию
 *   GET    /ai-copilot/sessions           — список сессий
 *   GET    /ai-copilot/session/:id        — получить сессию + сообщения
 *   POST   /ai-copilot/chat               — отправить сообщение (agentic loop)
 *   POST   /ai-copilot/confirm/:messageId — подтвердить action
 *   DELETE /ai-copilot/session/:id        — удалить сессию
 *   POST   /ai-copilot/session/:id/clear  — очистить историю
 */
'use strict';

const crypto = require('crypto');
const auth = require('../../auth');
const { processMessage, executeConfirmedTool } = require('./chat-engine');
const { llmRateLimit } = require('../shared/llm-client');

const MAX_MESSAGES_PER_SESSION = 500;
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function registerRoutes(server, db) {
  const origListener = server.listeners('request')[0];

  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    try {
      if (!req.url.startsWith('/ai-copilot')) {
        return origListener(req, res);
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const segments = url.pathname.split('/').filter(Boolean);
      // segments[0] = 'ai-copilot'
      const resource = segments[1] || '';
      const resourceId = segments[2] || '';
      const action = segments[3] || '';

      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      // Auth: только для чата и сессий (не для health check)
      const token = auth.extractToken(req);
      const session = auth.resolveSession(db, token);
      if (!session) return auth.json(res, 401, { error: 'unauthorized' });

      // ── POST /ai-copilot/session — создать сессию ──
      if (req.method === 'POST' && resource === 'session' && !resourceId) {
        const sessionId = 'cs_' + crypto.randomBytes(8).toString('hex');
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO ai_copilot_sessions (id, src, title, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(sessionId, session.src, '', now, now);

        return auth.json(res, 200, { session_id: sessionId, created_at: now });
      }

      // ── GET /ai-copilot/sessions — список сессий ──
      if (req.method === 'GET' && resource === 'sessions' && !resourceId) {
        const rows = db.prepare(`
          SELECT s.id, s.title, s.created_at, s.updated_at,
            (SELECT COUNT(*) FROM ai_copilot_messages WHERE session_id = s.id) as message_count
          FROM ai_copilot_sessions s
          WHERE s.src = ?
          ORDER BY s.updated_at DESC
          LIMIT 50
        `).all(session.src);
        return auth.json(res, 200, { sessions: rows });
      }

      // ── GET /ai-copilot/session/:id — получить сессию + сообщения ──
      if (req.method === 'GET' && resource === 'session' && resourceId && !action) {
        if (!SAFE_ID_RE.test(resourceId)) return auth.json(res, 400, { error: 'bad_id' });

        const sess = db.prepare('SELECT * FROM ai_copilot_sessions WHERE id = ? AND src = ?')
          .get(resourceId, session.src);
        if (!sess) return auth.json(res, 404, { error: 'not_found' });

        const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
        const before = Number(url.searchParams.get('before')) || 0;

        let messages;
        if (before > 0) {
          messages = db.prepare(
            'SELECT * FROM ai_copilot_messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?'
          ).all(resourceId, before, limit).reverse();
        } else {
          messages = db.prepare(
            'SELECT * FROM ai_copilot_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?'
          ).all(resourceId, limit).reverse();
        }

        return auth.json(res, 200, {
          session: {
            id: sess.id,
            title: sess.title,
            created_at: sess.created_at,
            updated_at: sess.updated_at,
          },
          messages: messages.map(formatMessage),
        });
      }

      // ── POST /ai-copilot/chat — отправить сообщение ──
      if (req.method === 'POST' && resource === 'chat' && !resourceId) {
        // Rate-limit
        const rl = llmRateLimit(session.src);
        if (!rl.ok) {
          res.setHeader('Retry-After', String(rl.remainSec || 60));
          return auth.json(res, 429, { error: 'rate_limited', remainSec: rl.remainSec });
        }

        let body;
        try { body = await auth.readJsonBody(req); }
        catch (_) { return auth.json(res, 400, { error: 'invalid_json' }); }

        const sessionId = (body && body.session_id) || '';
        const userMessage = (body && typeof body.message === 'string') ? body.message.trim() : '';
        // dashboardXml — XML-контекст текущего дашборда (опционально)
        const dashboardXml = (body && typeof body.dashboardXml === 'string') ? body.dashboardXml : null;
        if (!sessionId || !SAFE_ID_RE.test(sessionId)) return auth.json(res, 400, { error: 'session_id_required' });
        if (!userMessage) return auth.json(res, 400, { error: 'empty_message' });
        if (userMessage.length > 4000) return auth.json(res, 400, { error: 'message_too_long' });

        // Проверяем что сессия принадлежит пользователю
        const sess = db.prepare('SELECT * FROM ai_copilot_sessions WHERE id = ? AND src = ?')
          .get(sessionId, session.src);
        if (!sess) return auth.json(res, 404, { error: 'session_not_found' });

        const now = new Date().toISOString();

        // Сохраняем сообщение пользователя
        const userMsgId = db.prepare(`
          INSERT INTO ai_copilot_messages (session_id, role, content, status, created_at)
          VALUES (?, 'user', ?, 'done', ?)
        `).run(sessionId, userMessage, now).lastInsertRowid;

        // Обновляем timestamp сессии
        db.prepare('UPDATE ai_copilot_sessions SET updated_at = ? WHERE id = ?')
          .run(now, sessionId);

        // Загружаем историю (последние 30 сообщений)
        const historyRows = db.prepare(`
          SELECT role, content FROM ai_copilot_messages
          WHERE session_id = ? AND role IN ('user', 'assistant')
          ORDER BY id ASC
        `).all(sessionId);

        const history = historyRows.map(r => ({ role: r.role, content: r.content }));

        // Запускаем agentic loop (с контекстом текущего дашборда)
        let result;
        try {
          result = await processMessage(userMessage, { src: session.src, token }, history, { db }, dashboardXml);
        } catch (e) {
          result = { reply: `⚠️ Ошибка: ${e.message}`, toolCalls: [], error: true };
        }

        const nowResponse = new Date().toISOString();

        // Сохраняем tool calls (если были)
        const toolMsgIds = [];
        if (result.toolCalls && result.toolCalls.length > 0) {
          for (const tc of result.toolCalls) {
            const tcId = db.prepare(`
              INSERT INTO ai_copilot_messages
                (session_id, role, content, tool_name, tool_args, status, created_at)
              VALUES (?, 'system', ?, ?, ?, ?, ?)
            `).run(
              sessionId,
              tc.name,
              tc.name,
              JSON.stringify(tc.args),
              tc.needsConfirm ? 'pending_confirmation' : 'done',
              nowResponse
            ).lastInsertRowid;
            if (tc.needsConfirm) toolMsgIds.push(tcId);
          }
        }

        // Если есть pending confirmation — сохраняем и возвращаем
        if (result.pendingConfirmation) {
          const pc = result.pendingConfirmation;
          // Сохраняем ассистент-ответ с описанием pending action
          db.prepare(`
            INSERT INTO ai_copilot_messages
              (session_id, role, content, tool_name, tool_args, status, created_at)
            VALUES (?, 'assistant', ?, ?, ?, 'pending_confirmation', ?)
          `).run(
            sessionId,
            pc.description,
            pc.tool,
            JSON.stringify(pc.args),
            nowResponse
          );

          return auth.json(res, 200, {
            type: 'pending_confirmation',
            message_id: toolMsgIds[0] || null,
            tool: pc.tool,
            args: pc.args,
            description: pc.description,
          });
        }

        // Сохраняем ответ ассистента
        if (result.reply) {
          db.prepare(`
            INSERT INTO ai_copilot_messages (session_id, role, content, status, created_at)
            VALUES (?, 'assistant', ?, 'done', ?)
          `).run(sessionId, result.reply, nowResponse);
        }

        // Авто-определение заголовка сессии (первое сообщение)
        if (!sess.title) {
          const title = userMessage.slice(0, 80);
          db.prepare('UPDATE ai_copilot_sessions SET title = ? WHERE id = ?')
            .run(title, sessionId);
        }

        return auth.json(res, 200, {
          type: 'reply',
          reply: result.reply || '',
          toolCalls: (result.toolCalls || []).map(tc => ({
            name: tc.name,
            args: tc.args,
            needsConfirm: tc.needsConfirm,
          })),
        });
      }

      // ── POST /ai-copilot/confirm/:messageId — подтвердить действие ──
      if (req.method === 'POST' && resource === 'confirm' && resourceId) {
        const messageId = parseInt(resourceId, 10);
        if (isNaN(messageId)) return auth.json(res, 400, { error: 'bad_message_id' });

        let body;
        try { body = await auth.readJsonBody(req); }
        catch (_) { body = {}; }
        const approve = body && body.approve !== false; // по умолчанию — одобрить

        // Находим сообщение и проверяем владение
        const msg = db.prepare(`
          SELECT m.*, s.src FROM ai_copilot_messages m
          JOIN ai_copilot_sessions s ON s.id = m.session_id
          WHERE m.id = ?
        `).get(messageId);
        if (!msg) return auth.json(res, 404, { error: 'not_found' });
        if (msg.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });
        if (msg.status !== 'pending_confirmation') return auth.json(res, 400, { error: 'not_pending' });

        if (!approve) {
          // Отклонено
          db.prepare(`UPDATE ai_copilot_messages SET status = 'rejected' WHERE id = ?`)
            .run(messageId);
          const rejectMsg = 'Действие отклонено пользователем.';
          db.prepare(`
            INSERT INTO ai_copilot_messages (session_id, role, content, status, created_at)
            VALUES (?, 'assistant', ?, 'done', ?)
          `).run(msg.session_id, rejectMsg, new Date().toISOString());
          return auth.json(res, 200, { status: 'rejected' });
        }

        // Одобрено — выполняем инструмент
        const toolArgs = JSON.parse(msg.tool_args || '{}');
        const toolName = msg.tool_name;

        let result;
        try {
          result = await executeConfirmedTool(toolName, toolArgs, { src: session.src, token }, { db });
        } catch (e) {
          result = { error: e.message };
        }

        const nowDone = new Date().toISOString();
        db.prepare(`UPDATE ai_copilot_messages SET status = 'confirmed', tool_result = ? WHERE id = ?`)
          .run(JSON.stringify(result), messageId);

        // Сохраняем результат как tool_result сообщение
        db.prepare(`
          INSERT INTO ai_copilot_messages
            (session_id, role, content, tool_name, tool_result, status, created_at)
          VALUES (?, 'tool_result', ?, ?, ?, 'done', ?)
        `).run(msg.session_id, `Результат: ${JSON.stringify(result).slice(0, 500)}`, toolName, JSON.stringify(result), nowDone);

        // Запускаем ещё одну итерацию LLM для формирования ответа на основе результата
        const historyRows = db.prepare(`
          SELECT role, content FROM ai_copilot_messages
          WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY id ASC
        `).all(msg.session_id);

        const toolResultSummary = `[Инструмент ${toolName} выполнен]: ${JSON.stringify(result).slice(0, 2000)}`;
        const history = historyRows.map(r => ({ role: r.role, content: r.content }));
        history.push({ role: 'user', content: toolResultSummary });

        let llmResult;
        try {
          llmResult = await processMessage(toolResultSummary, { src: session.src, token }, history, { db });
        } catch (_) {
          llmResult = { reply: `✅ Инструмент ${toolName} выполнен.`, toolCalls: [] };
        }

        const nowFinal = new Date().toISOString();
        if (llmResult.reply) {
          db.prepare(`
            INSERT INTO ai_copilot_messages (session_id, role, content, status, created_at)
            VALUES (?, 'assistant', ?, 'done', ?)
          `).run(msg.session_id, llmResult.reply, nowFinal);
        }

        return auth.json(res, 200, {
          status: 'confirmed',
          result,
          reply: llmResult.reply || '',
        });
      }

      // ── DELETE /ai-copilot/session/:id — удалить сессию ──
      if (req.method === 'DELETE' && resource === 'session' && resourceId && !action) {
        if (!SAFE_ID_RE.test(resourceId)) return auth.json(res, 400, { error: 'bad_id' });
        const sess = db.prepare('SELECT src FROM ai_copilot_sessions WHERE id = ?').get(resourceId);
        if (!sess) return auth.json(res, 404, { error: 'not_found' });
        if (sess.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        db.prepare('DELETE FROM ai_copilot_messages WHERE session_id = ?').run(resourceId);
        db.prepare('DELETE FROM ai_copilot_sessions WHERE id = ?').run(resourceId);
        return auth.json(res, 200, { ok: true });
      }

      // ── POST /ai-copilot/session/:id/clear — очистить историю ──
      if (req.method === 'POST' && resource === 'session' && resourceId && action === 'clear') {
        if (!SAFE_ID_RE.test(resourceId)) return auth.json(res, 400, { error: 'bad_id' });
        const sess = db.prepare('SELECT src FROM ai_copilot_sessions WHERE id = ?').get(resourceId);
        if (!sess) return auth.json(res, 404, { error: 'not_found' });
        if (sess.src !== session.src) return auth.json(res, 403, { error: 'forbidden' });

        const result = db.prepare('DELETE FROM ai_copilot_messages WHERE session_id = ?').run(resourceId);
        db.prepare('UPDATE ai_copilot_sessions SET updated_at = ? WHERE id = ?')
          .run(new Date().toISOString(), resourceId);

        return auth.json(res, 200, { ok: true, deleted: result.changes });
      }

      // Не совпавшие маршруты
      return auth.json(res, 404, { error: 'not_found' });

    } catch (e) {
      console.error('[ai-copilot] route error:', e.message);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'internal' }));
      }
    }
  });
}

/**
 * Форматирование сообщения для ответа клиенту.
 */
function formatMessage(msg) {
  const out = {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    status: msg.status,
    created_at: msg.created_at,
  };
  if (msg.tool_name) out.tool_name = msg.tool_name;
  if (msg.tool_args) {
    try { out.tool_args = JSON.parse(msg.tool_args); } catch (_) { out.tool_args = msg.tool_args; }
  }
  if (msg.tool_result) {
    try { out.tool_result = JSON.parse(msg.tool_result); } catch (_) { out.tool_result = msg.tool_result; }
  }
  return out;
}

module.exports = { registerRoutes };

/**
 * plugins/alert/server-api.js — Серверный API для алертов
 *
 * Обрабатывает HTTP-маршруты /api/alerts/* :
 *   GET    /api/alerts/rules          — список правил
 *   POST   /api/alerts/rules          — создать/обновить правило
 *   DELETE /api/alerts/rules/:id      — удалить правило
 *   POST   /api/alerts/test           — тестовая отправка
 *   GET    /api/alerts/status          — статус очереди
 *
 * Используется из events_server.js напрямую (без listener wrapping).
 */
'use strict';

/* ── Утилита маскирования токена ── */
function maskToken(token) {
    if (!token) return token;
    if (token.length <= 4) return '****';
    return '*'.repeat(token.length - 4) + token.slice(-4);
}

/* ── Чтение тела запроса ── */
function readBody(req, limit) {
    limit = limit || 65536;
    return new Promise(function (resolve, reject) {
        var body = '';
        var size = 0;
        var finished = false;
        var timer = setTimeout(function () {
            if (!finished) { finished = true; req.destroy(); reject(new Error('body timeout')); }
        }, 10000);

        req.on('data', function (c) {
            size += c.length;
            if (size > limit) {
                if (!finished) { finished = true; clearTimeout(timer); req.destroy(); reject(new Error('body too large')); }
                return;
            }
            body += c;
        });
        req.on('end', function () {
            if (!finished) { finished = true; clearTimeout(timer); resolve(body); }
        });
        req.on('error', function (e) {
            if (!finished) { finished = true; clearTimeout(timer); reject(e); }
        });
    });
}

/* ── JSON-ответ ── */
function jsonResponse(res, code, data) {
    var body = JSON.stringify(data);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(body);
}

/**
 * Обработка запроса к /api/alerts/*.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse}  res
 * @param {object}               db   — better-sqlite3 Database
 * @param {string}               url  — req.url (или распарсенный pathname)
 * @returns {boolean} true если маршрут обработан, false если не наш
 */
async function handleAlertRequest(req, res, db, url) {
    // Быстрый фильтр
    if (!url || url.indexOf('/api/alerts') !== 0) {
        return false;
    }

    var parsed;
    try {
        parsed = new URL(url, 'http://localhost');
    } catch (_) {
        return false;
    }
    var segments = parsed.pathname.split('/').filter(Boolean);
    // ['/api', 'alerts', 'rules'] → endpoint=segments[2], id=segments[3]
    var endpoint = segments[2] || '';
    var id = segments[3] || '';

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    try {
        /* ═══════════════════════════════════════════
           GET /api/alerts/rules — список всех правил
           ═══════════════════════════════════════════ */
        if (req.method === 'GET' && endpoint === 'rules' && !id) {
            var rules = db.prepare('SELECT * FROM alert_rules ORDER BY created_at DESC').all();

            var maskedRules = rules.map(function (rule) {
                var channels;
                try { channels = JSON.parse(rule.channels || '[]'); } catch (_) { channels = []; }
                var maskedChannels = channels.map(function (ch) {
                    if (ch.type === 'telegram' && ch.bot_token) {
                        return Object.assign({}, ch, { bot_token: maskToken(ch.bot_token) });
                    }
                    return ch;
                });
                return Object.assign({}, rule, { channels: JSON.stringify(maskedChannels) });
            });

            jsonResponse(res, 200, maskedRules);
            return true;
        }

        /* ═══════════════════════════════════════════
           POST /api/alerts/rules — создать/обновить
           ═══════════════════════════════════════════ */
        if (req.method === 'POST' && endpoint === 'rules') {
            var body = await readBody(req);
            var data;
            try { data = JSON.parse(body); } catch (_) {
                jsonResponse(res, 400, { error: 'invalid_json' });
                return true;
            }

            // Обязательные поля
            if (!data.dashboard_id || !data.panel_id || !data.title || !data.condition_type || data.threshold === undefined) {
                jsonResponse(res, 400, { error: 'Missing required fields', received: { dashboard_id: data.dashboard_id, panel_id: data.panel_id, title: data.title, condition_type: data.condition_type, threshold: data.threshold } });
                return true;
            }

            var channels = data.channels || [];

            // При обновлении: восстанавливаем замаскированные токены
            if (data.id) {
                var existingRule = db.prepare('SELECT channels FROM alert_rules WHERE id = ?').get(data.id);
                if (existingRule) {
                    var existingChannels;
                    try { existingChannels = JSON.parse(existingRule.channels || '[]'); } catch (_) { existingChannels = []; }
                    channels = channels.map(function (ch, index) {
                        var exCh = existingChannels[index];
                        if (ch.type === 'telegram' && ch.bot_token && ch.bot_token.indexOf('****') !== -1) {
                            return Object.assign({}, ch, { bot_token: exCh ? exCh.bot_token : ch.bot_token });
                        }
                        return ch;
                    });
                }
            }

            var channelsJson = JSON.stringify(channels);

            // Проверяем существование таблицы
            var tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='alert_rules'").get();
            if (!tableExists) {
                jsonResponse(res, 500, { error: 'alert_rules table not found — plugin may not be loaded' });
                return true;
            }

            if (data.id) {
                db.prepare(
                    'UPDATE alert_rules SET dashboard_id = ?, panel_id = ?, title = ?, condition_type = ?, ' +
                    'threshold = ?, check_interval_sec = ?, pending_checks_required = ?, channels = ?, ' +
                    "updated_at = strftime('%s', 'now') WHERE id = ?"
                ).run(
                    data.dashboard_id, data.panel_id, data.title, data.condition_type,
                    data.threshold, data.check_interval_sec || 60, data.pending_checks_required || 1,
                    channelsJson, data.id
                );
            } else {
                db.prepare(
                    'INSERT INTO alert_rules (dashboard_id, panel_id, title, condition_type, threshold, ' +
                    'check_interval_sec, pending_checks_required, channels) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                ).run(
                    data.dashboard_id, data.panel_id, data.title, data.condition_type,
                    data.threshold, data.check_interval_sec || 60, data.pending_checks_required || 1,
                    channelsJson
                );
            }

            jsonResponse(res, 200, { success: true });
            return true;
        }

        /* ═══════════════════════════════════════════
           DELETE /api/alerts/rules/:id
           ═══════════════════════════════════════════ */
        if (req.method === 'DELETE' && endpoint === 'rules' && id) {
            db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
            jsonResponse(res, 200, { success: true });
            return true;
        }

        /* ═══════════════════════════════════════════
           POST /api/alerts/test — тестовая отправка
           ═══════════════════════════════════════════ */
        if (req.method === 'POST' && endpoint === 'test') {
            var body = await readBody(req);
            var data;
            try { data = JSON.parse(body); } catch (_) {
                jsonResponse(res, 400, { error: 'invalid_json' });
                return true;
            }

            var channels = data.channels || [];
            if (channels.length === 0) {
                jsonResponse(res, 400, { error: 'No channels provided' });
                return true;
            }

            var stmt = db.prepare(
                'INSERT INTO alert_queue (is_test, channel_type, channel_config, message_text) VALUES (1, ?, ?, ?)'
            );

            var historyIds = [];
            for (var i = 0; i < channels.length; i++) {
                var ch = channels[i];
                if (!ch.type) continue;

                var configToUse = Object.assign({}, ch);
                // Восстанавливаем замаскированный токен
                if (ch.type === 'telegram' && ch.bot_token && ch.bot_token.indexOf('****') !== -1 && data.rule_id) {
                    var existingRule = db.prepare('SELECT channels FROM alert_rules WHERE id = ?').get(data.rule_id);
                    if (existingRule) {
                        var existingChannels;
                        try { existingChannels = JSON.parse(existingRule.channels || '[]'); } catch (_) { existingChannels = []; }
                        var exCh = existingChannels.find(function (c) { return c.type === 'telegram'; });
                        if (exCh) configToUse.bot_token = exCh.bot_token;
                    }
                }

                var info = stmt.run(
                    ch.type,
                    JSON.stringify(configToUse),
                    '\uD83E\uDDEA Тестовое уведомление от Pulse Alerts: ' + (data.title || 'Без названия')
                );
                historyIds.push(info.lastInsertRowid);
            }

            jsonResponse(res, 200, { success: true, queue_ids: historyIds });
            return true;
        }

        /* ═══════════════════════════════════════════
           GET /api/alerts/status — статус очереди
           ═══════════════════════════════════════════ */
        if (req.method === 'GET' && endpoint === 'status') {
            var queueModule = require('./queue');
            var dispatcherModule = require('./dispatcher');

            var queueStats = queueModule.getQueueStats(db);
            var activeRequests = dispatcherModule.getActiveRequestsCount();

            jsonResponse(res, 200, {
                queue: queueStats,
                network: { active_requests: activeRequests }
            });
            return true;
        }

        /* ═══════════════════════════════════════════
           Несовпавшие /api/alerts/* → 404
           ═══════════════════════════════════════════ */
        jsonResponse(res, 404, { error: 'not_found' });
        return true;

    } catch (e) {
        console.error('[alerts-api] error:', e.message, e.stack || '');
        if (!res.headersSent) {
            jsonResponse(res, 500, { error: 'internal', message: e.message || String(e) });
        }
        return true;
    }
}

module.exports = { handleAlertRequest };

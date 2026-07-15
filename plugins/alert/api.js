function maskToken(token) {
    if (!token) return token;
    if (token.length <= 4) return '****';
    return '*'.repeat(token.length - 4) + token.slice(-4);
}

function registerRoutes(server, db) {
    const origListener = server.listeners('request')[0];

    server.removeAllListeners('request');
    server.on('request', async (req, res) => {
        try {
            // Быстрый пропуск: не /api/alerts → передаём оригинальному обработчику
            if (!req.url.startsWith('/api/alerts')) {
                return origListener(req, res);
            }

            const url = new URL(req.url, `http://${req.headers.host}`);
            const segments = url.pathname.split('/').filter(Boolean);
            // ['/api', 'alerts', 'rules'] или ['/api', 'alerts', 'rules', ':id']
            // ['/api', 'alerts', 'test'] или ['/api', 'alerts', 'status']
            const endpoint = segments[2] || ''; // 'rules', 'test', 'status'
            const id = segments[3] || '';       // rule id for DELETE

            // CORS
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            if (req.method === 'OPTIONS') {
                res.statusCode = 204;
                res.end();
                return;
            }

            // ── GET /api/alerts/rules ──
            if (req.method === 'GET' && endpoint === 'rules' && !id) {
                try {
                    const rules = db.prepare('SELECT * FROM alert_rules ORDER BY created_at DESC').all();
                    
                    const maskedRules = rules.map(rule => {
                        const channels = JSON.parse(rule.channels || '[]');
                        const maskedChannels = channels.map(ch => {
                            if (ch.type === 'telegram' && ch.bot_token) {
                                return { ...ch, bot_token: maskToken(ch.bot_token) };
                            }
                            return ch;
                        });
                        return { ...rule, channels: JSON.stringify(maskedChannels) };
                    });

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(maskedRules));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }

            // ── POST /api/alerts/rules ──
            if (req.method === 'POST' && endpoint === 'rules') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        
                        if (!data.dashboard_id || !data.panel_id || !data.title || !data.condition_type || data.threshold === undefined) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            return res.end(JSON.stringify({ error: 'Missing required fields' }));
                        }

                        let channels = data.channels || [];
                        
                        if (data.id) {
                            const existingRule = db.prepare('SELECT channels FROM alert_rules WHERE id = ?').get(data.id);
                            if (existingRule) {
                                const existingChannels = JSON.parse(existingRule.channels || '[]');
                                channels = channels.map((ch, index) => {
                                    const exCh = existingChannels[index];
                                    if (ch.type === 'telegram' && ch.bot_token && ch.bot_token.includes('****')) {
                                        return { ...ch, bot_token: exCh ? exCh.bot_token : ch.bot_token };
                                    }
                                    return ch;
                                });
                            }
                        }

                        const channelsJson = JSON.stringify(channels);

                        if (data.id) {
                            db.prepare(`
                                UPDATE alert_rules 
                                SET dashboard_id = ?, panel_id = ?, title = ?, condition_type = ?, threshold = ?, 
                                    check_interval_sec = ?, pending_checks_required = ?, channels = ?, updated_at = strftime('%s', 'now')
                                WHERE id = ?
                            `).run(
                                data.dashboard_id, data.panel_id, data.title, data.condition_type, data.threshold,
                                data.check_interval_sec || 60, data.pending_checks_required || 1, channelsJson, data.id
                            );
                        } else {
                            db.prepare(`
                                INSERT INTO alert_rules (dashboard_id, panel_id, title, condition_type, threshold, check_interval_sec, pending_checks_required, channels)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            `).run(
                                data.dashboard_id, data.panel_id, data.title, data.condition_type, data.threshold,
                                data.check_interval_sec || 60, data.pending_checks_required || 1, channelsJson
                            );
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true }));
                    } catch (e) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }

            // ── DELETE /api/alerts/rules/:id ──
            if (req.method === 'DELETE' && endpoint === 'rules' && id) {
                try {
                    db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }

            // ── POST /api/alerts/test ──
            if (req.method === 'POST' && endpoint === 'test') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        const channels = data.channels || [];
                        
                        if (channels.length === 0) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            return res.end(JSON.stringify({ error: 'No channels provided' }));
                        }

                        const stmt = db.prepare(`
                            INSERT INTO alert_queue (is_test, channel_type, channel_config, message_text)
                            VALUES (1, ?, ?, ?)
                        `);

                        let historyIds = [];
                        for (const channel of channels) {
                            if (!channel.type) continue;
                            
                            let configToUse = { ...channel };
                            if (channel.type === 'telegram' && channel.bot_token && channel.bot_token.includes('****') && data.rule_id) {
                                const existingRule = db.prepare('SELECT channels FROM alert_rules WHERE id = ?').get(data.rule_id);
                                if (existingRule) {
                                    const existingChannels = JSON.parse(existingRule.channels || '[]');
                                    const exCh = existingChannels.find(c => c.type === 'telegram');
                                    if (exCh) {
                                        configToUse.bot_token = exCh.bot_token;
                                    }
                                }
                            }

                            const info = stmt.run(
                                channel.type,
                                JSON.stringify(configToUse),
                                `🧪 Тестовое уведомление от Pulse Alerts: ${data.title || 'Без названия'}`
                            );
                            historyIds.push(info.lastInsertRowid);
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, queue_ids: historyIds }));
                    } catch (e) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }

            // ── GET /api/alerts/status ──
            if (req.method === 'GET' && endpoint === 'status') {
                try {
                    const { getQueueStats } = require('./queue');
                    const { getActiveRequestsCount } = require('./dispatcher');
                    
                    const queueStats = getQueueStats(db);
                    const activeRequests = getActiveRequestsCount();

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        queue: queueStats,
                        network: {
                            active_requests: activeRequests
                        }
                    }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }

            // Несовпавшие маршруты /api/alerts/* → 404
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found' }));

        } catch (e) {
            console.error('[alerts] route error:', e.message);
            if (!res.headersSent) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: 'internal' }));
            }
        }
    });
}

module.exports = {
    registerRoutes
};

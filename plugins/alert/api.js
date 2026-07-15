function maskToken(token) {
    if (!token) return token;
    if (token.length <= 4) return '****';
    return '*'.repeat(token.length - 4) + token.slice(-4);
}

function registerRoutes(server, db) {
    // Получение списка правил
    server.get('/api/alerts/rules', (req, res) => {
        try {
            const rules = db.prepare('SELECT * FROM alert_rules ORDER BY created_at DESC').all();
            
            // Маскируем токены перед отправкой на клиент
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
    });

    // Создание/обновление правила
    server.post('/api/alerts/rules', (req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                
                // Валидация
                if (!data.dashboard_id || !data.panel_id || !data.title || !data.condition_type || data.threshold === undefined) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Missing required fields' }));
                }

                let channels = data.channels || [];
                
                // Если это обновление, нужно слить старые токены, если пришли замаскированные
                if (data.id) {
                    const existingRule = db.prepare('SELECT channels FROM alert_rules WHERE id = ?').get(data.id);
                    if (existingRule) {
                        const existingChannels = JSON.parse(existingRule.channels || '[]');
                        channels = channels.map((ch, index) => {
                            const exCh = existingChannels[index];
                            if (ch.type === 'telegram' && ch.bot_token && ch.bot_token.includes('****')) {
                                // Восстанавливаем старый токен
                                return { ...ch, bot_token: exCh ? exCh.bot_token : ch.bot_token };
                            }
                            return ch;
                        });
                    }
                }

                const channelsJson = JSON.stringify(channels);

                if (data.id) {
                    // Update
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
                    // Insert
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
    });

    // Удаление правила
    server.delete('/api/alerts/rules/:id', (req, res) => {
        const id = req.url.split('/').pop();
        try {
            db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    });

    // Тестовая отправка (создает задачу в очереди)
    server.post('/api/alerts/test', (req, res) => {
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
                    
                    // Если токен замаскирован, пытаемся достать из БД (если передан rule_id)
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
    });

    // Статус очереди (Телеметрия)
    server.get('/api/alerts/status', (req, res) => {
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
    });
}

module.exports = {
    registerRoutes
};

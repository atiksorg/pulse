/**
 * Конечный автомат для алертов (FSM)
 * Отвечает за логику переходов состояний и Anti-flapping.
 */

function evaluateCondition(value, conditionType, threshold) {
    if (value === null || value === undefined) {
        return conditionType === 'no_data';
    }
    switch (conditionType) {
        case '>': return value > threshold;
        case '<': return value < threshold;
        case '=': return value === threshold;
        case 'no_data': return false; // Если данные есть, то no_data = false
        default: return false;
    }
}

function processFSM(rule, currentValue, db) {
    const isViolating = evaluateCondition(currentValue, rule.condition_type, rule.threshold);
    let newState = rule.state;
    let newPendingCount = rule.pending_count;
    let shouldAlert = false;

    if (isViolating) {
        if (rule.state === 'OK' || rule.state === 'RESOLVED') {
            newState = 'PENDING';
            newPendingCount = 1;
        } else if (rule.state === 'PENDING') {
            newPendingCount += 1;
        }

        if (newState === 'PENDING' && newPendingCount >= rule.pending_checks_required) {
            newState = 'FIRING';
            shouldAlert = true;
        }
    } else {
        if (rule.state === 'FIRING') {
            newState = 'RESOLVED';
            shouldAlert = true; // Отправляем уведомление о восстановлении
            newPendingCount = 0;
        } else {
            newState = 'OK';
            newPendingCount = 0;
        }
    }

    // Если состояние или счетчик изменились, обновляем БД
    if (newState !== rule.state || newPendingCount !== rule.pending_count) {
        db.prepare(`
            UPDATE alert_rules 
            SET state = ?, pending_count = ?, updated_at = strftime('%s', 'now')
            WHERE id = ?
        `).run(newState, newPendingCount, rule.id);

        // Записываем историю, если произошел переход состояния
        if (newState !== rule.state) {
            const info = db.prepare(`
                INSERT INTO alert_history (rule_id, state_from, state_to, metric_value, phases)
                VALUES (?, ?, ?, ?, ?)
            `).run(
                rule.id, 
                rule.state, 
                newState, 
                currentValue, 
                JSON.stringify([{ phase: 'fsm_transition', time: Date.now() }])
            );

            // Если нужно отправить алерт, ставим в очередь
            if (shouldAlert) {
                enqueueAlert(rule, newState, currentValue, info.lastInsertRowid, db);
            }
        }
    }
}

function enqueueAlert(rule, state, value, historyId, db) {
    let channels = [];
    try {
        channels = JSON.parse(rule.channels);
    } catch (e) {
        console.error(\`[Alert FSM] Failed to parse channels for rule \${rule.id}\`);
        return;
    }

    const title = rule.title;
    const threshold = rule.threshold;
    
    let messageText = '';
    if (state === 'FIRING') {
        messageText = \`🚨 \${title} сработал! Текущее значение: \${value} (Порог: \${rule.condition_type} \${threshold})\`;
    } else if (state === 'RESOLVED') {
        messageText = \`✅ \${title} восстановился. Текущее значение: \${value}\`;
    }

    const stmt = db.prepare(\`
        INSERT INTO alert_queue (rule_id, history_id, channel_type, channel_config, message_text)
        VALUES (?, ?, ?, ?, ?)
    \`);

    for (const channel of channels) {
        if (!channel.type) continue;
        stmt.run(
            rule.id,
            historyId,
            channel.type,
            JSON.stringify(channel),
            messageText
        );
    }
}

module.exports = {
    processFSM,
    evaluateCondition
};

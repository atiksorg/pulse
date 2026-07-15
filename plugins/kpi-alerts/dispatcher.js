/**
 * plugins/kpi-alerts/dispatcher.js — Alert state machine + delivery
 */
'use strict';

const { sendTelegramMessage } = require('../shared/telegram-sender');

const MAX_DELIVERY_ATTEMPTS = 3;

function clampString(str, len) {
  return String(str || '').slice(0, len);
}

function insertHistory(db, ruleId, ts, value, threshold, eventType, deliveryStatus, error, attempt) {
  db.prepare(`
    INSERT INTO alert_history (rule_id, ts, value, threshold, event_type, delivery_status, error, attempt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ruleId, ts, value, threshold, eventType, deliveryStatus, clampString(error, 500), attempt);
}

function formatMessage(template, payload) {
  const text = String(template || '').trim();
  if (!text) {
    const stateText = payload.eventType === 'recovered' ? 'восстановилось' : 'превысило порог';
    return `⚠️ ${payload.panelName}: значение ${payload.value} ${stateText} (порог ${payload.threshold}). Дашборд: ${payload.dashboardName}`;
  }

  return text
    .replace(/\{value\}/g, String(payload.value ?? '—'))
    .replace(/\{threshold\}/g, String(payload.threshold ?? '—'))
    .replace(/\{panel_name\}/g, String(payload.panelName || ''))
    .replace(/\{dashboard_name\}/g, String(payload.dashboardName || ''));
}

async function tryDeliver(rule, message) {
  const chatIds = String(rule.chat_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!chatIds.length) {
    return { ok: false, error: 'missing_chat_ids', failedChats: [] };
  }

  let failedChats = [];
  let lastError = '';

  for (const chatId of chatIds) {
    const res = await sendTelegramMessage({
      token: rule.telegram_bot_token,
      chatId,
      text: message
    });

    if (!res.ok) {
      lastError = res.error || 'delivery_failed';
      failedChats.push(chatId);
    }
  }

  return {
    ok: failedChats.length === 0,
    error: lastError,
    failedChats
  };
}

function processRule(db, rule, value) {
  const ts = new Date().toISOString();
  const condition = rule.condition || 'above';
  const threshold = Number(rule.threshold);
  const cooldownMs = Math.max(0, Number(rule.cooldown_minutes || 0)) * 60000;

  const isViolating =
    (condition === 'above' && value > threshold) ||
    (condition === 'below' && value < threshold) ||
    (condition === 'equals' && Number(value) === Number(threshold));

  const prevState = rule.state || 'ok';
  let nextState = prevState;
  let eventType = null;

  if (isViolating) {
    if (prevState === 'ok') {
      nextState = 'alerting';
      eventType = 'triggered';
    } else if (prevState === 'alerting' || prevState === 'recovered') {
      const lastSentAt = rule.last_sent_at ? new Date(rule.last_sent_at).getTime() : 0;
      if (cooldownMs > 0 && lastSentAt && (Date.now() - lastSentAt) < cooldownMs) {
        nextState = 'alerting';
      } else {
        nextState = 'alerting';
        eventType = 'reminder';
      }
    }
  } else {
    if (prevState === 'alerting') {
      nextState = 'recovered';
      eventType = 'recovered';
    } else {
      nextState = 'ok';
    }
  }

  db.prepare(`
    UPDATE alert_rules SET state = ?, last_value = ?, last_state_change_at = ?, updated_at = ?
    WHERE id = ?
  `).run(nextState, value, ts, ts, rule.id);

  if (!eventType) {
    return;
  }

  const message = formatMessage(rule.message_template, {
    value,
    threshold,
    panelName: (rule._panel && rule._panel.title) || rule.panel_id,
    dashboardName: rule._dashboard_name || rule.dashboard_id,
    eventType
  });

  let attempt = 1;
  let lastError = '';
  let delivered = false;

  for (; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
    // eslint-disable-next-line no-loop-func
    const delivery = tryDeliverSyncOrAsync(rule, message);
    if (delivery.then) {
      return deliverAsync(db, rule, value, threshold, ts, eventType, message, attempt);
    }

    if (delivery.ok) {
      delivered = true;
      insertHistory(db, rule.id, ts, value, threshold, eventType, 'ok', '', attempt);
      db.prepare('UPDATE alert_rules SET last_sent_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, rule.id);
      break;
    }

    lastError = delivery.error;
  }

  if (!delivered) {
    insertHistory(db, rule.id, ts, value, threshold, eventType, 'failed', lastError, MAX_DELIVERY_ATTEMPTS);
  }
}

function tryDeliverSyncOrAsync(rule, message) {
  return {
    ok: false,
    error: 'sync_stub'
  };
}

async function deliverAsync(db, rule, value, threshold, ts, eventType, message, startAttempt) {
  let delivered = false;
  let lastError = '';

  for (let attempt = startAttempt; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
    const res = await tryDeliver(rule, message);

    if (res.ok) {
      delivered = true;
      insertHistory(db, rule.id, ts, value, threshold, eventType, 'ok', '', attempt);
      db.prepare('UPDATE alert_rules SET last_sent_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, rule.id);
      break;
    }

    lastError = res.error;
  }

  if (!delivered) {
    insertHistory(db, rule.id, ts, value, threshold, eventType, 'failed', lastError, MAX_DELIVERY_ATTEMPTS);
  }
}

async function evaluateAndDispatch(db, rule, value) {
  const ts = new Date().toISOString();
  const condition = rule.condition || 'above';
  const threshold = Number(rule.threshold);
  const cooldownMs = Math.max(0, Number(rule.cooldown_minutes || 0)) * 60000;

  const isViolating =
    (condition === 'above' && value > threshold) ||
    (condition === 'below' && value < threshold) ||
    (condition === 'equals' && Number(value) === Number(threshold));

  const prevState = rule.state || 'ok';
  let nextState = prevState;
  let eventType = null;

  if (isViolating) {
    if (prevState === 'ok') {
      nextState = 'alerting';
      eventType = 'triggered';
    } else if (prevState === 'alerting' || prevState === 'recovered') {
      const lastSentAt = rule.last_sent_at ? new Date(rule.last_sent_at).getTime() : 0;
      if (cooldownMs > 0 && lastSentAt && (Date.now() - lastSentAt) < cooldownMs) {
        nextState = 'alerting';
      } else {
        nextState = 'alerting';
        eventType = 'reminder';
      }
    }
  } else {
    if (prevState === 'alerting') {
      nextState = 'recovered';
      eventType = 'recovered';
    } else {
      nextState = 'ok';
    }
  }

  db.prepare(`
    UPDATE alert_rules SET state = ?, last_value = ?, last_state_change_at = ?, updated_at = ?
    WHERE id = ?
  `).run(nextState, value, ts, ts, rule.id);

  if (!eventType) {
    return;
  }

  const message = formatMessage(rule.message_template, {
    value,
    threshold,
    panelName: (rule._panel && rule._panel.title) || rule.panel_id,
    dashboardName: rule._dashboard_name || rule.dashboard_id,
    eventType
  });

  let delivered = false;
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
    const res = await tryDeliver(rule, message);

    if (res.ok) {
      delivered = true;
      insertHistory(db, rule.id, ts, value, threshold, eventType, 'ok', '', attempt);
      db.prepare('UPDATE alert_rules SET last_sent_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, rule.id);
      break;
    }

    lastError = res.error;
  }

  if (!delivered) {
    insertHistory(db, rule.id, ts, value, threshold, eventType, 'failed', lastError, MAX_DELIVERY_ATTEMPTS);
  }
}

module.exports = {
  evaluateAndDispatch
};

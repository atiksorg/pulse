/**
 * public/plugins/ai-copilot/copilot-modal.js — Логика чата AI-копилота
 *
 * Отвечает за:
 *   - Загрузку/создание сессий
 *   - Отправку сообщений
 *   - Рендер истории (bubble + tool cards + confirm cards)
 *   - Подтверждение/отклонение actions
 */
'use strict';

(function(){
  if (window._copilotModalLoaded) return;
  window._copilotModalLoaded = true;

  // ── State ────────────────────────────────────────
  var currentSessionId = null;
  var sessions = [];
  var initialized = false;
  var sending = false;

  // ── Elements ─────────────────────────────────────
  var elMessages, elInput, elSendBtn, elSessions;

  // ── Получение токена авторизации ────────────────
  // Токен хранится в sessionStorage через core.js getSession()
  function _getAuthToken() {
    // 1. Пробуем getSession() из core.js
    if (typeof getSession === 'function') {
      var sess = getSession();
      if (sess && sess.token) return sess.token;
    }
    // 2. Fallback: window._pulseToken (старый вариант)
    if (window._pulseToken) return window._pulseToken;
    // 3. Fallback: прямое чтение sessionStorage
    try {
      var raw = sessionStorage.getItem('pulse_session');
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.token) return parsed.token;
      }
    } catch(_) {}
    return null;
  }

  // ── Init (called once when panel first opens) ────
  window._copilotModalInit = function(){
    if (initialized) return;
    initialized = true;

    elMessages = document.getElementById('cpMessages');
    elInput    = document.getElementById('cpInput');
    elSendBtn  = document.getElementById('cpSendBtn');
    elSessions = document.getElementById('cpSessions');

    // Send button — СТАВИМ ДО проверки токена, чтобы кнопка всегда была готова
    elSendBtn.addEventListener('click', sendMessage);

    // Enter to send (Shift+Enter = newline)
    elInput.addEventListener('keydown', function(e){
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Auto-resize textarea
    elInput.addEventListener('input', function(){
      elInput.style.height = 'auto';
      elInput.style.height = Math.min(elInput.scrollHeight, 100) + 'px';
    });

    // New session button
    document.getElementById('cpBtnNewSession').addEventListener('click', createNewSession);

    // Clear history button
    document.getElementById('cpBtnClear').addEventListener('click', function(){
      if (!currentSessionId) return;
      if (!confirm('Очистить историю чата?')) return;
      clearHistory();
    });

    // Brain button — показать контекст (XML текущего дашборда)
    var brainBtn = document.getElementById('cpBtnBrain');
    if (brainBtn) {
      brainBtn.addEventListener('click', toggleBrainContext);
    }

    // Проверяем авторизацию
    var token = _getAuthToken();
    if (!token) {
      showEmptyState('Войдите в аккаунт', 'Чтобы использовать AI-копилот, авторизуйтесь через PIN');
      return;
    }

    // Load sessions
    loadSessions();
  };

  // ── API helpers ──────────────────────────────────
  function apiRequest(method, path, body) {
    var opts = {
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    var token = _getAuthToken();
    if (token) {
      opts.headers['Authorization'] = 'Bearer ' + token;
    }
    if (body) opts.body = JSON.stringify(body);

    return fetch('/ai-copilot' + path, opts).then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok) throw { status: res.status, data: data };
        return data;
      });
    });
  }

  // ── Sessions management ──────────────────────────
  function loadSessions() {
    apiRequest('GET', '/sessions').then(function(data) {
      sessions = data.sessions || [];
      renderSessions();
      if (sessions.length > 0 && !currentSessionId) {
        selectSession(sessions[0].id);
      } else if (sessions.length === 0) {
        createNewSession();
      }
    }).catch(function() {
      showEmptyState('Ошибка загрузки', 'Не удалось загрузить сессии. Проверьте авторизацию.');
    });
  }

  function createNewSession() {
    apiRequest('POST', '/session').then(function(data) {
      currentSessionId = data.session_id;
      sessions.unshift({
        id: data.session_id,
        title: 'Новый чат',
        created_at: data.created_at,
        message_count: 0
      });
      renderSessions();
      renderMessages([]);
      elInput.focus();
    }).catch(function(e) {
      console.error('[copilot] create session error:', e);
    });
  }

  function selectSession(id) {
    currentSessionId = id;
    renderSessions();
    loadMessages(id);
  }

  function loadMessages(sessionId) {
    apiRequest('GET', '/session/' + sessionId).then(function(data) {
      renderMessages(data.messages || []);
    }).catch(function() {
      showEmptyState('Ошибка', 'Не удалось загрузить сообщения');
    });
  }

  function clearHistory() {
    apiRequest('POST', '/session/' + currentSessionId + '/clear').then(function() {
      renderMessages([]);
    });
  }

  // ── Sending messages ─────────────────────────────
  function sendMessage() {
    var text = elInput.value.trim();
    if (!text || sending || !currentSessionId) return;

    sending = true;
    elSendBtn.disabled = true;
    elInput.value = '';
    elInput.style.height = 'auto';

    // Add user message to UI immediately
    appendMessage({ role: 'user', content: text, created_at: new Date().toISOString() });

    // Show typing indicator
    var typingEl = showTyping();

    // Генерируем XML текущего дашборда для контекста LLM
    var dashXml = null;
    try {
      if (typeof window._copilotGetDashboardXml === 'function') {
        dashXml = window._copilotGetDashboardXml();
      }
    } catch(_) {}

    apiRequest('POST', '/chat', {
      session_id: currentSessionId,
      message: text,
      dashboardXml: dashXml
    }).then(function(data) {
      removeTyping(typingEl);

      if (data.type === 'pending_confirmation') {
        // Show confirmation card
        appendConfirmCard(data);
      } else if (data.type === 'reply') {
        // Show tool calls if any
        if (data.toolCalls && data.toolCalls.length > 0) {
          for (var i = 0; i < data.toolCalls.length; i++) {
            appendToolCard(data.toolCalls[i]);
          }
        }
        // Show reply
        if (data.reply) {
          appendMessage({ role: 'assistant', content: data.reply, created_at: new Date().toISOString() });
        }
        // Update session title
        updateSessionTitle(currentSessionId, text);
      }
    }).catch(function(e) {
      removeTyping(typingEl);
      var msg = (e && e.data && e.data.error) ? e.data.error : 'Ошибка соединения';
      appendMessage({ role: 'error', content: '⚠️ ' + msg, created_at: new Date().toISOString() });
    }).finally(function() {
      sending = false;
      elSendBtn.disabled = false;
    });
  }

  // ── Confirmation handling ────────────────────────
  function handleConfirm(messageId, approve) {
    var cardEl = document.querySelector('[data-confirm-id="' + messageId + '"]');
    if (cardEl) {
      var btns = cardEl.querySelectorAll('.cp-confirm-btn');
      for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    }

    // Show typing while executing
    var typingEl = showTyping();

    apiRequest('POST', '/confirm/' + messageId, { approve: approve }).then(function(data) {
      removeTyping(typingEl);

      if (data.status === 'rejected') {
        appendMessage({ role: 'assistant', content: 'Действие отклонено.', created_at: new Date().toISOString() });
      } else if (data.status === 'confirmed') {
        appendToolCard({ name: data.result && data.result.success ? 'confirmed' : 'error', args: {} });
        if (data.reply) {
          appendMessage({ role: 'assistant', content: data.reply, created_at: new Date().toISOString() });
        }
      }
    }).catch(function(e) {
      removeTyping(typingEl);
      appendMessage({ role: 'error', content: '⚠️ Ошибка подтверждения', created_at: new Date().toISOString() });
    });
  }

  // ── Rendering ────────────────────────────────────
  function renderSessions() {
    if (!elSessions) return;
    elSessions.innerHTML = '';

    // New session button
    var newBtn = document.createElement('div');
    newBtn.className = 'cp-session-new';
    newBtn.textContent = '＋ Новый чат';
    newBtn.addEventListener('click', createNewSession);
    elSessions.appendChild(newBtn);

    for (var i = 0; i < Math.min(sessions.length, 10); i++) {
      var s = sessions[i];
      var item = document.createElement('div');
      item.className = 'cp-session-item' + (s.id === currentSessionId ? ' active' : '');
      item.innerHTML = '<span class="cp-session-title">' + escapeHtml(s.title || 'Чат') + '</span>';
      (function(sid){
        item.addEventListener('click', function(){ selectSession(sid); });
      })(s.id);
      elSessions.appendChild(item);
    }
  }

  function renderMessages(messages) {
    if (!elMessages) return;
    elMessages.innerHTML = '';

    if (messages.length === 0) {
      showEmptyState('Начните диалог', 'Задайте вопрос о данных, попросите построить график или настроить алерт.');
      return;
    }

    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      if (msg.role === 'user' || msg.role === 'assistant') {
        appendMessage(msg, true);
      } else if (msg.role === 'system' && msg.tool_name) {
        appendToolCard({ name: msg.tool_name, args: msg.tool_args || {}, status: msg.status }, true);
      } else if (msg.role === 'tool_result') {
        appendToolCard({ name: msg.tool_name || 'result', args: {}, status: 'done' }, true);
      }
    }

    scrollToBottom();
  }

  function appendMessage(msg, noScroll) {
    removeEmptyState();

    var div = document.createElement('div');
    div.className = 'cp-msg cp-msg-' + (msg.role === 'error' ? 'error' : msg.role);
    div.textContent = msg.content || '';

    var ts = document.createElement('div');
    ts.className = 'cp-msg-timestamp';
    ts.textContent = formatTime(msg.created_at);
    div.appendChild(ts);

    elMessages.appendChild(div);
    if (!noScroll) scrollToBottom();
  }

  function appendToolCard(tc, noScroll) {
    removeEmptyState();

    var div = document.createElement('div');
    div.className = 'cp-tool-card';

    var nameEl = document.createElement('div');
    nameEl.className = 'cp-tool-name';
    nameEl.textContent = tc.name;
    div.appendChild(nameEl);

    var statusEl = document.createElement('div');
    var status = tc.status || 'done';
    statusEl.className = 'cp-tool-status status-' + (status === 'done' ? 'done' : status === 'pending_confirmation' ? 'pending' : 'error');
    statusEl.textContent = status === 'done' ? '✓ Выполнено' : status === 'pending_confirmation' ? '⏳ Ожидает подтверждения' : '⚠️ Ошибка';
    div.appendChild(statusEl);

    elMessages.appendChild(div);
    if (!noScroll) scrollToBottom();
  }

  function appendConfirmCard(data) {
    removeEmptyState();

    var div = document.createElement('div');
    div.className = 'cp-confirm-card';
    div.setAttribute('data-confirm-id', data.message_id);

    var descEl = document.createElement('div');
    descEl.className = 'cp-confirm-desc';
    descEl.textContent = '🤖 Копилот предлагает: ' + data.description;
    div.appendChild(descEl);

    var actionsEl = document.createElement('div');
    actionsEl.className = 'cp-confirm-actions';

    var approveBtn = document.createElement('button');
    approveBtn.className = 'cp-confirm-btn cp-confirm-approve';
    approveBtn.textContent = '✓ Выполнить';
    approveBtn.addEventListener('click', function(){ handleConfirm(data.message_id, true); });

    var rejectBtn = document.createElement('button');
    rejectBtn.className = 'cp-confirm-btn cp-confirm-reject';
    rejectBtn.textContent = '✕ Отклонить';
    rejectBtn.addEventListener('click', function(){ handleConfirm(data.message_id, false); });

    actionsEl.appendChild(approveBtn);
    actionsEl.appendChild(rejectBtn);
    div.appendChild(actionsEl);

    elMessages.appendChild(div);
    scrollToBottom();
  }

  function showTyping() {
    var div = document.createElement('div');
    div.className = 'cp-typing';
    div.innerHTML = '<div class="cp-typing-dot"></div><div class="cp-typing-dot"></div><div class="cp-typing-dot"></div>';
    elMessages.appendChild(div);
    scrollToBottom();
    return div;
  }

  function removeTyping(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function showEmptyState(icon, text) {
    if (!elMessages) return;
    elMessages.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'cp-empty';
    div.innerHTML = '<div class="cp-empty-icon">🤖</div>' +
      '<div class="cp-empty-text">' + escapeHtml(text || 'Начните диалог') + '</div>';
    elMessages.appendChild(div);
  }

  function removeEmptyState() {
    var empty = elMessages && elMessages.querySelector('.cp-empty');
    if (empty) empty.parentNode.removeChild(empty);
  }

  function updateSessionTitle(sessionId, text) {
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].id === sessionId && (!sessions[i].title || sessions[i].title === 'Новый чат')) {
        sessions[i].title = text.slice(0, 60);
        renderSessions();
        break;
      }
    }
  }

  function scrollToBottom() {
    if (elMessages) elMessages.scrollTop = elMessages.scrollHeight;
  }

  // ── Brain Context: показать текущий XML дашборда ──
  function toggleBrainContext() {
    var panel = document.getElementById('cpBrainPanel');
    if (!panel) return;
    var isOpen = panel.style.display !== 'none';
    if (isOpen) {
      panel.style.display = 'none';
      return;
    }
    // Генерируем XML текущего дашборда
    var xml = _generateDashboardXml();
    var codeEl = panel.querySelector('.cp-brain-code');
    if (codeEl) codeEl.textContent = xml;
    panel.style.display = 'block';
  }

  /**
   * Сгенерировать XML-описание текущего активного дашборда.
   * Используется для показа в панели «мозг» и для передачи в system prompt.
   */
  function _generateDashboardXml() {
    var dash = null;
    try {
      if (typeof getActiveDashboard === 'function') {
        dash = getActiveDashboard();
      }
    } catch(_) {}

    if (!dash) return '<!-- Нет активного дашборда -->';

    var lines = [];
    lines.push('<dashboard id="' + esc(dash.id) + '" name="' + esc(dash.name) + '">');

    var panels = dash.panels || [];
    for (var i = 0; i < panels.length; i++) {
      var p = panels[i];
      lines.push('  <panel id="' + esc(p.id) + '">');
      lines.push('    <title>' + esc(p.title || '') + '</title>');
      lines.push('    <viz>' + esc(p.viz || 'kpi') + '</viz>');
      lines.push('    <type>' + esc(p.type || '*') + '</type>');
      lines.push('    <group>' + esc(p.group || '') + '</group>');
      if (p.field) lines.push('    <field>' + esc(p.field) + '</field>');
      lines.push('    <agg>' + esc(p.agg || 'count') + '</agg>');
      if (p.aggfield) lines.push('    <aggfield>' + esc(p.aggfield) + '</aggfield>');
      lines.push('    <range>' + esc(p.range || '24h') + '</range>');
      lines.push('    <width>' + (p.width || 6) + '</width>');
      if (p.sort && p.sort !== 'key') lines.push('    <sort>' + esc(p.sort) + '</sort>');
      if (p.limit) lines.push('    <limit>' + p.limit + '</limit>');
      if (p.unit) lines.push('    <unit>' + esc(p.unit) + '</unit>');
      if (p.color) lines.push('    <color>' + esc(p.color) + '</color>');
      if (p.autorefresh) lines.push('    <autorefresh>' + p.autorefresh + '</autorefresh>');
      lines.push('  </panel>');
    }

    lines.push('</dashboard>');
    return lines.join('\n');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Получить XML текущего дашборда (для использования в system prompt).
   */
  window._copilotGetDashboardXml = function() {
    return _generateDashboardXml();
  };

  /**
   * Получить текущий src пользователя.
   */
  window._copilotGetSrc = function() {
    if (typeof getSession === 'function') {
      var sess = getSession();
      if (sess && sess.src) return sess.src;
    }
    try {
      var raw = sessionStorage.getItem('pulse_session');
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.src) return parsed.src;
      }
    } catch(_) {}
    return null;
  };

  // ── Utilities ────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatTime(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return '';
    }
  }
})();

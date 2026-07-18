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

    // Setup inline button delegation
    _setupButtonDelegation();
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

    // Assistant-сообщения рендерим через Markdown
    if (msg.role === 'assistant') {
      var mdWrap = document.createElement('div');
      mdWrap.className = 'cp-md';
      mdWrap.innerHTML = renderMarkdown(msg.content || '');
      div.appendChild(mdWrap);
    } else {
      div.textContent = msg.content || '';
    }

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

  // ── Utilities ────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

  // ═══════════════════════════════════════════════════
  // DASHBOARD XML GENERATION
  // ═══════════════════════════════════════════════════

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

  // ═══════════════════════════════════════════════════
  // MARKDOWN RENDERER (lightweight, no dependencies)
  // ═══════════════════════════════════════════════════

  function renderMarkdown(text) {
    if (!text) return '';
    var html = text;

    // 0. Сначала извлекаем {btn:...} кнопки и заменяем на плейсхолдеры
    var buttons = [];
    html = html.replace(/\{btn:([^|]*)\|([^|]*)\|(\{(?:[^{}]|\{[^{}]*\})*\}|[^}]*)\}/g, function(_, label, action, params) {
      var idx = buttons.length;
      buttons.push({ label: label.trim(), action: action.trim(), params: params.trim() });
      return '%%BTN_' + idx + '%%';
    });

    // 1. Code blocks (```...```) — до всего остального
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
      return '<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>';
    });

    // 2. Inline code (`...`)
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // 3. Tables
    html = html.replace(/^(\|.+\|)\n(\|[\s\-:|]+\|)\n((?:\|.+\|\n?)*)/gm, function(_, header, sep, body) {
      var ths = header.split('|').filter(function(c) { return c.trim(); });
      var thead = '<tr>' + ths.map(function(c) { return '<th>' + c.trim() + '</th>'; }).join('') + '</tr>';
      var rows = body.trim().split('\n').map(function(row) {
        var tds = row.split('|').filter(function(c) { return c.trim(); });
        return '<tr>' + tds.map(function(c) { return '<td>' + c.trim() + '</td>'; }).join('') + '</tr>';
      });
      return '<table><thead>' + thead + '</thead><tbody>' + rows.join('') + '</tbody></table>';
    });

    // 4. Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // 5. Horizontal rules
    html = html.replace(/^---+$/gm, '<hr>');

    // 6. Blockquotes
    html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

    // 7. Bold and italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // 8. Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // 9. Lists — обрабатываем блоками
    // Unordered: - item or * item
    html = html.replace(/^([\-\*] .+(?:\n[\-\*] .+)*)/gm, function(block) {
      var items = block.split('\n').map(function(line) {
        return '<li>' + line.replace(/^[\-\*] /, '') + '</li>';
      });
      return '<ul>' + items.join('') + '</ul>';
    });
    // Ordered: 1. item
    html = html.replace(/^(\d+\. .+(?:\n\d+\. .+)*)/gm, function(block) {
      var items = block.split('\n').map(function(line) {
        return '<li>' + line.replace(/^\d+\. /, '') + '</li>';
      });
      return '<ol>' + items.join('') + '</ol>';
    });

    // 10. Paragraphs — двойной перенос строки = <p>
    html = html.replace(/\n\n+/g, '</p><p>');
    // Single newlines → <br> (except inside pre/code)
    html = html.replace(/\n/g, '<br>');

    // Wrap in <p> if not starting with block element
    if (!/^<[a-z]/i.test(html)) {
      html = '<p>' + html + '</p>';
    }

    // 11. Вставляем кнопки обратно
    html = html.replace(/%%BTN_(\d+)%%/g, function(_, idx) {
      var b = buttons[parseInt(idx)];
      if (!b) return '';
      return '<button class="cp-action-btn" data-action="' + escapeHtml(b.action) +
             '" data-params="' + escapeHtml(b.params) + '">' + escapeHtml(b.label) + '</button>';
    });

    // Группируем соседние кнопки в строки
    html = html.replace(/(<button class="cp-action-btn"[^>]*>[^<]*<\/button>(?:\s*<button class="cp-action-btn"[^>]*>[^<]*<\/button>)*)/g, function(match) {
      return '<div class="cp-btn-row">' + match + '</div>';
    });

    return html;
  }

  // ═══════════════════════════════════════════════════
  // INLINE BUTTON HANDLING
  // ═══════════════════════════════════════════════════

  // Обработка клика по inline-кнопке
  function _handleActionButtonClick(btn) {
    var action = btn.getAttribute('data-action');
    var paramsStr = btn.getAttribute('data-params') || '{}';

    // Визуальная обратная связь
    btn.classList.add('cp-btn-pending');
    btn.textContent = '⏳ ' + btn.textContent;

    if (action === '_refresh') {
      // Сервисные действия — на клиенте
      window.location.reload();
      return;
    }
    if (action === '_help') {
      // Открыть модалку справки
      var helpModal = document.getElementById('helpModal');
      if (helpModal) helpModal.classList.add('open');
      return;
    }
    if (action === '_navigate') {
      try {
        var p = JSON.parse(paramsStr);
        if (p && p.hash) location.hash = p.hash;
      } catch(_) {}
      return;
    }

    // ═══════════════════════════════════════════════════
    // _add_panel — МГНОВЕННОЕ добавление панели на дашборд
    // Не ходит к LLM — работает чисто на клиенте.
    // ═══════════════════════════════════════════════════
    if (action === '_add_panel') {
      var parsedPanelArgs;
      try {
        parsedPanelArgs = JSON.parse(paramsStr || '{}');
      } catch (parseErr) {
        try {
          var fixed2 = paramsStr.replace(/\}+$/, '');
          var openCnt = (fixed2.match(/\{/g) || []).length;
          var closeCnt = (fixed2.match(/\}/g) || []).length;
          while (closeCnt < openCnt) { fixed2 += '}'; closeCnt++; }
          parsedPanelArgs = JSON.parse(fixed2);
        } catch (_) {
          parsedPanelArgs = {};
        }
      }
      _clientAddPanel(parsedPanelArgs, btn);
      return;
    }

    // ═══════════════════════════════════════════════════
    // _remove_panel — МГНОВЕННОЕ удаление панели по ID
    // ═══════════════════════════════════════════════════
    if (action === '_remove_panel') {
      var parsedRemoveArgs;
      try {
        parsedRemoveArgs = JSON.parse(paramsStr || '{}');
      } catch (parseErr) {
        parsedRemoveArgs = {};
      }
      _clientRemovePanel(parsedRemoveArgs, btn);
      return;
    }

    // Все остальные actions — отправляем как сообщение в чат,
    // используя формат который парсится как tool_call
    var parsedArgs;
    try {
      parsedArgs = JSON.parse(paramsStr || '{}');
    } catch (parseErr) {
      console.warn('[copilot] Invalid button params JSON:', paramsStr, parseErr);
      // Пробуем восстановить: дописать недостающие закрывающие скобки
      try {
        var fixed = paramsStr.replace(/\}+$/, '');
        var openCount = (fixed.match(/\{/g) || []).length;
        var closeCount = (fixed.match(/\}/g) || []).length;
        while (closeCount < openCount) { fixed += '}'; closeCount++; }
        parsedArgs = JSON.parse(fixed);
      } catch (_) {
        parsedArgs = {};
      }
    }
    var toolMsg = JSON.stringify({
      tool_call: action,
      args: parsedArgs
    });

    // Показываем как системное сообщение
    appendMessage({ role: 'user', content: '▶ ' + action, created_at: new Date().toISOString() });
    var typingEl = showTyping();

    // Генерируем XML контекст
    var dashXml = null;
    try {
      if (typeof window._copilotGetDashboardXml === 'function') {
        dashXml = window._copilotGetDashboardXml();
      }
    } catch(_) {}

    // Отправляем как запрос "выполни этот инструмент"
    apiRequest('POST', '/chat', {
      session_id: currentSessionId,
      message: 'Выполни инструмент: ' + toolMsg,
      dashboardXml: dashXml
    }).then(function(data) {
      removeTyping(typingEl);
      if (data.type === 'pending_confirmation') {
        appendConfirmCard(data);
      } else if (data.type === 'reply') {
        if (data.toolCalls && data.toolCalls.length > 0) {
          for (var i = 0; i < data.toolCalls.length; i++) {
            appendToolCard(data.toolCalls[i]);
          }
        }
        if (data.reply) {
          appendMessage({ role: 'assistant', content: data.reply, created_at: new Date().toISOString() });
        }
      }
    }).catch(function(e) {
      removeTyping(typingEl);
      appendMessage({ role: 'error', content: '⚠️ Ошибка выполнения', created_at: new Date().toISOString() });
    }).finally(function() {
      btn.classList.remove('cp-btn-pending');
    });
  }

  // ═══════════════════════════════════════════════════
  // _clientAddPanel — мгновенное добавление панели на активный дашборд
  //
  // Работает полностью на клиенте: берёт AppState.activeId,
  // создаёт panel object, сохраняет на сервер, перерисовывает.
  // Никаких round-trip к LLM.
  // ═══════════════════════════════════════════════════
  function _clientAddPanel(args, btn) {
    // 1. Получаем активный дашборд
    var db = null;
    try {
      if (typeof getActiveDashboard === 'function') {
        db = getActiveDashboard();
      }
    } catch(_) {}

    if (!db) {
      appendMessage({
        role: 'error',
        content: '⚠️ Нет активного дашборда. Откройте дашборд и попробуйте снова.',
        created_at: new Date().toISOString()
      });
      if (btn) { btn.classList.remove('cp-btn-pending'); btn.textContent = btn.textContent.replace('⏳ ', ''); }
      return;
    }

    // 2. Генерируем уникальный ID и Z-index
    var panelId = (typeof uid === 'function') ? uid('panel') : 'cp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6);
    var maxZ = 0;
    if (typeof getMaxPanelZ === 'function') {
      maxZ = getMaxPanelZ(db.panels);
    } else {
      (db.panels || []).forEach(function(p) {
        if (p.cz && p.cz > maxZ) maxZ = p.cz;
      });
    }
    var newZ = Math.min(maxZ + 1, 890);

    // 3. Создаём объект панели с дефолтами
    var newPanel = {
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
      limit: (args.limit != null && args.limit !== undefined) ? args.limit : null,
      autorefresh: args.autorefresh || 0,
      color: args.color || '',
      unit: args.unit || '',
      formatType: args.formatType || 'number',
      lineStyle: args.lineStyle || '',
      tension: (args.viz === 'line' && typeof args.tension === 'number') ? args.tension : undefined,
      cz: newZ
    };

    // Копируем опциональные поля
    if (args.stacked) newPanel.stacked = true;
    if (args.cumulative) newPanel.cumulative = true;
    if (args.compare) newPanel.compare = true;
    if (args.secondAxis) newPanel.secondAxis = true;
    if (args.breakdownfield) newPanel.breakdownfield = args.breakdownfield;
    if (args.filters && Array.isArray(args.filters)) newPanel.filters = args.filters;
    if (args.thresholds && Array.isArray(args.thresholds)) newPanel.thresholds = args.thresholds;
    if (args.gaugeMin !== undefined) newPanel.gaugeMin = args.gaugeMin;
    if (args.gaugeMax !== undefined) newPanel.gaugeMax = args.gaugeMax;

    // 4. Canvas: размещение по центру viewport
    var mobile = (typeof isMobile === 'function') ? isMobile() : (window.innerWidth < 860);
    var canvasModeActive = (typeof getLayoutMode === 'function') ? getLayoutMode() : true;

    if (canvasModeActive && !mobile && typeof interactiveCanvas !== 'undefined' && interactiveCanvas && !interactiveCanvas._destroyed) {
      var vp = interactiveCanvas.viewport.getBoundingClientRect();
      var cw = newPanel.cw || 380;
      var ch = newPanel.ch || 280;
      // Заполняем cw/ch из пресетов если доступны
      if (typeof getVizPreset === 'function') {
        var pr = getVizPreset(newPanel.viz);
        if (!newPanel.cw) cw = pr.cw;
        if (!newPanel.ch) ch = pr.ch;
      }
      var centerX = (vp.width / 2 - interactiveCanvas.offsetX) / interactiveCanvas.scale - cw / 2;
      var centerY = (vp.height / 2 - interactiveCanvas.offsetY) / interactiveCanvas.scale - ch / 2;
      newPanel.cx = Math.round(centerX / 20) * 20;
      newPanel.cy = Math.round(centerY / 20) * 20;
      newPanel.cw = cw;
      newPanel.ch = ch;
    }

    // 5. Сохраняем viewport перед перерисовкой
    if (typeof _saveCanvasViewport === 'function') {
      _saveCanvasViewport();
    }

    // 6. Добавляем в массив panels
    if (!Array.isArray(db.panels)) db.panels = [];
    db.panels.push(newPanel);

    // 7. Сохраняем на сервер и перерисовываем
    if (typeof updateDashboardOnServer === 'function') {
      updateDashboardOnServer(db).then(function() {
        // Перерисовываем
        if (typeof renderPanels === 'function') {
          renderPanels();
        }
        // Обновляем XML-контекст для будущих запросов
        appendMessage({
          role: 'assistant',
          content: '✅ Панель **' + (newPanel.title || 'Панель') + '** добавлена на дашборд.',
          created_at: new Date().toISOString()
        });
        if (typeof toast === 'function') {
          toast('✨ Панель «' + (newPanel.title || 'Панель') + '» добавлена');
        }
      }).catch(function(err) {
        // Откатываем: удаляем из массива
        db.panels = db.panels.filter(function(x) { return x.id !== panelId; });
        appendMessage({
          role: 'error',
          content: '⚠️ Ошибка сохранения: ' + (err.message || err),
          created_at: new Date().toISOString()
        });
      }).finally(function() {
        if (btn) { btn.classList.remove('cp-btn-pending'); }
      });
    } else {
      // updateDashboardOnServer недоступна
      appendMessage({
        role: 'error',
        content: '⚠️ Dashboard API недоступен. Откройте дашборд и попробуйте снова.',
        created_at: new Date().toISOString()
      });
      if (btn) { btn.classList.remove('cp-btn-pending'); }
    }
  }

  // ═══════════════════════════════════════════════════
  // _clientRemovePanel — мгновенное удаление панели
  // ═══════════════════════════════════════════════════
  function _clientRemovePanel(args, btn) {
    if (!args.panel_id) {
      appendMessage({
        role: 'error',
        content: '⚠️ Не указан panel_id для удаления.',
        created_at: new Date().toISOString()
      });
      if (btn) { btn.classList.remove('cp-btn-pending'); }
      return;
    }

    var db = null;
    try { db = getActiveDashboard(); } catch(_) {}
    if (!db) {
      appendMessage({ role: 'error', content: '⚠️ Нет активного дашборда.', created_at: new Date().toISOString() });
      if (btn) { btn.classList.remove('cp-btn-pending'); }
      return;
    }

    var found = db.panels.find(function(x) { return x.id === args.panel_id; });
    if (!found) {
      appendMessage({ role: 'error', content: '⚠️ Панель ' + args.panel_id + ' не найдена.', created_at: new Date().toISOString() });
      if (btn) { btn.classList.remove('cp-btn-pending'); }
      return;
    }

    var removedTitle = found.title || args.panel_id;
    if (typeof _saveCanvasViewport === 'function') _saveCanvasViewport();
    db.panels = db.panels.filter(function(x) { return x.id !== args.panel_id; });

    if (typeof updateDashboardOnServer === 'function') {
      updateDashboardOnServer(db).then(function() {
        if (typeof renderPanels === 'function') renderPanels();
        appendMessage({
          role: 'assistant',
          content: '✅ Панель **' + removedTitle + '** удалена.',
          created_at: new Date().toISOString()
        });
        if (typeof toast === 'function') toast('🗑 Панель удалена');
      }).catch(function(err) {
        appendMessage({ role: 'error', content: '⚠️ Ошибка: ' + err.message, created_at: new Date().toISOString() });
      }).finally(function() {
        if (btn) { btn.classList.remove('cp-btn-pending'); }
      });
    }
  }

  // Event delegation для кнопок в сообщениях
  function _setupButtonDelegation() {
    if (!elMessages) return;
    elMessages.addEventListener('click', function(e) {
      var btn = e.target.closest('.cp-action-btn');
      if (btn) {
        e.preventDefault();
        _handleActionButtonClick(btn);
      }
    });
  }

  // ═══════════════════════════════════════════════════
  // BRAIN PANEL: загрузка полного контекста агента
  // ═══════════════════════════════════════════════════

  function toggleBrainContext() {
    var panel = document.getElementById('cpBrainPanel');
    if (!panel) return;
    var isOpen = panel.style.display !== 'none';
    if (isOpen) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';

    // Инициализируем табы (один раз)
    if (!panel._tabsInited) {
      panel._tabsInited = true;
      var tabs = panel.querySelectorAll('.cp-brain-tab');
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].addEventListener('click', function() {
          // Deactivate all tabs
          var allTabs = panel.querySelectorAll('.cp-brain-tab');
          for (var j = 0; j < allTabs.length; j++) allTabs[j].classList.remove('active');
          var allContents = panel.querySelectorAll('.cp-brain-tab-content');
          for (var j = 0; j < allContents.length; j++) allContents[j].classList.remove('visible');
          // Activate clicked
          this.classList.add('active');
          var tabId = this.getAttribute('data-tab');
          var content = document.getElementById('brainTab' + tabId.charAt(0).toUpperCase() + tabId.slice(1));
          if (content) content.classList.add('visible');
        });
      }
    }

    // Загружаем XML дашборда (всегда доступно локально)
    var xml = _generateDashboardXml();
    var codeEl = panel.querySelector('.cp-brain-code');
    if (codeEl) codeEl.textContent = xml;

    // Загружаем полный контекст агента через API
    _loadAgentContext();
  }

  function _loadAgentContext() {
    var instructionsEl = document.getElementById('brainTabInstructions');
    var toolsEl = document.getElementById('brainTabTools');

    // Показываем loading
    if (instructionsEl) instructionsEl.innerHTML = '<div class="cp-brain-loading">Загрузка инструкций...</div>';
    if (toolsEl) toolsEl.innerHTML = '<div class="cp-brain-loading">Загрузка инструментов...</div>';

    apiRequest('GET', '/context').then(function(data) {
      // ── Инструкции: полный system prompt ──
      if (instructionsEl && data.systemPrompt) {
        var sections = _parseSystemPromptSections(data.systemPrompt);
        var html = '';
        for (var i = 0; i < sections.length; i++) {
          html += '<div class="cp-brain-section">';
          html += '<div class="cp-brain-section-title">' + escapeHtml(sections[i].title) + '</div>';
          html += '<div class="cp-brain-md"><pre style="white-space:pre-wrap;word-break:break-word;">' + escapeHtml(sections[i].content) + '</pre></div>';
          html += '</div>';
        }
        instructionsEl.innerHTML = html;
      }

      // ── Инструменты: детальное описание каждого ──
      if (toolsEl && data.tools) {
        var html = '';
        for (var i = 0; i < data.tools.length; i++) {
          var t = data.tools[i];
          html += '<div class="cp-brain-tool">';
          html += '<div class="cp-brain-tool-name">' + escapeHtml(t.name) +
                  (t.needsConfirm ? ' <span class="cp-brain-tool-confirm">⚠️ подтверждение</span>' : '') +
                  '</div>';
          html += '<div class="cp-brain-tool-desc">' + escapeHtml(t.description) + '</div>';
          if (t.parameters && t.parameters.properties) {
            var params = Object.entries(t.parameters.properties);
            if (params.length > 0) {
              html += '<div class="cp-brain-tool-params">';
              for (var j = 0; j < params.length; j++) {
                html += '<div>• ' + escapeHtml(params[j][0]) + ' (' + escapeHtml(params[j][1].type || '?') + ')' +
                        (params[j][1].description ? ': ' + escapeHtml(params[j][1].description) : '') +
                        '</div>';
              }
              html += '</div>'; 
            }
          }
          html += '</div>';
        }
        toolsEl.innerHTML = html;
      }
    }).catch(function() {
      if (instructionsEl) instructionsEl.innerHTML = '<div class="cp-brain-loading" style="color:#ff6b6b;">Ошибка загрузки контекста</div>';
      if (toolsEl) toolsEl.innerHTML = '<div class="cp-brain-loading" style="color:#ff6b6b;">Ошибка загрузки инструментов</div>';
    });
  }

  // Разбить system prompt на секции по разделителям ═══ 
  function _parseSystemPromptSections(prompt) {
    var sections = [];
    var parts = prompt.split(/═{10,}/);
    var currentTitle = 'Общие инструкции';
    var currentContent = '';

    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      if (!part) continue;
      // Если часть содержит заголовок секции (короткая строка с названием)
      var lines = part.split('\n');
      if (lines.length <= 2 && lines[0].length < 80 && /^[А-Яа-яA-Za-z\s()\-]+$/.test(lines[0].trim())) {
        // Сохраняем предыдущую секцию
        if (currentContent.trim()) {
          sections.push({ title: currentTitle, content: currentContent.trim() });
        }
        currentTitle = lines[0].trim();
        currentContent = lines.slice(1).join('\n').trim();
      } else {
        currentContent += '\n' + part;
      }
    }
    if (currentContent.trim()) {
      sections.push({ title: currentTitle, content: currentContent.trim() });
    }
    return sections;
  }
})();

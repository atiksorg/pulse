/**
 * public/plugins/ai-copilot/copilot-widget.js — Плавающая кнопка AI-копилота
 *
 * Инжектит floating-иконку в нижний правый угол + панель чата.
 * Не зависит от других модулей — самодостаточный виджет.
 *
 * ВАЖНО: Виджет показывается ТОЛЬКО в личном кабинете (route === 'dashboard').
 * На лендинге и публичных страницах — скрыт.
 */
'use strict';

(function(){
  if (window._copilotWidgetLoaded) return;
  window._copilotWidgetLoaded = true;

  // ── CSS ──────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = `
    /* ═══ Copilot Widget ═══ */
    .copilot-fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: linear-gradient(135deg, #4DECC7 0%, #3BCFB0 100%);
      color: #0a0a0f;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(77,236,199,0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      z-index: 9998;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .copilot-fab-hidden {
      display: none !important;
    }
    .copilot-fab:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 28px rgba(77,236,199,0.5);
    }
    .copilot-fab .fab-pulse {
      position: absolute;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: rgba(77,236,199,0.3);
      animation: copilot-pulse 2s ease-out infinite;
    }
    @keyframes copilot-pulse {
      0% { transform: scale(1); opacity: 1; }
      100% { transform: scale(1.8); opacity: 0; }
    }

    /* ═══ Copilot Panel ═══ */
    .copilot-panel {
      position: fixed;
      bottom: 90px;
      right: 24px;
      width: 420px;
      max-width: calc(100vw - 48px);
      height: 560px;
      max-height: calc(100vh - 120px);
      background: var(--bg, #111118);
      border: 1px solid var(--border, #2a2a3a);
      border-radius: 16px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.6);
      display: none;
      flex-direction: column;
      z-index: 9999;
      overflow: hidden;
      font-family: 'Inter', -apple-system, sans-serif;
    }
    .copilot-panel.open {
      display: flex;
    }

    /* Panel header */
    .cp-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border, #2a2a3a);
      background: var(--bg-elevated, #16161e);
    }
    .cp-header-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text, #e8e8f0);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .cp-header-title .cp-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #4DECC7;
      display: inline-block;
    }
    .cp-header-actions {
      display: flex;
      gap: 4px;
    }
    .cp-header-btn {
      background: none;
      border: none;
      color: var(--text-muted, #888);
      cursor: pointer;
      padding: 6px;
      border-radius: 6px;
      font-size: 16px;
      transition: background 0.15s;
    }
    .cp-header-btn:hover {
      background: var(--bg-hover, #2a2a3a);
      color: var(--text, #e8e8f0);
    }
    .cp-header-btn.cp-brain-active {
      color: #4DECC7;
      background: rgba(77,236,199,0.12);
    }

    /* Messages area */
    .cp-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .cp-messages::-webkit-scrollbar { width: 6px; }
    .cp-messages::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

    /* Message bubbles */
    .cp-msg {
      max-width: 85%;
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.5;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .cp-msg-user {
      align-self: flex-end;
      background: #2a6b5a;
      color: #e8e8f0;
      border-bottom-right-radius: 4px;
    }
    .cp-msg-assistant {
      align-self: flex-start;
      background: var(--bg-elevated, #16161e);
      color: var(--text, #e8e8f0);
      border: 1px solid var(--border, #2a2a3a);
      border-bottom-left-radius: 4px;
    }
    .cp-msg-error {
      align-self: center;
      background: #3a1a1a;
      color: #ff6b6b;
      font-size: 12px;
      text-align: center;
    }
    .cp-msg-timestamp {
      font-size: 10px;
      color: var(--text-muted, #666);
      margin-top: 4px;
    }

    /* Tool call card */
    .cp-tool-card {
      align-self: flex-start;
      max-width: 90%;
      background: #1a1a2e;
      border: 1px solid #3a3a5a;
      border-radius: 10px;
      padding: 12px;
      font-size: 12px;
    }
    .cp-tool-name {
      font-weight: 600;
      color: #4DECC7;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      margin-bottom: 4px;
    }
    .cp-tool-status {
      font-size: 11px;
      color: var(--text-muted, #888);
      margin-top: 4px;
    }
    .cp-tool-status.status-done { color: #4DECC7; }
    .cp-tool-status.status-pending { color: #ffb84d; }
    .cp-tool-status.status-error { color: #ff6b6b; }

    /* Confirm card */
    .cp-confirm-card {
      align-self: flex-start;
      max-width: 90%;
      background: #2a2a1a;
      border: 1px solid #5a5a3a;
      border-radius: 10px;
      padding: 14px;
    }
    .cp-confirm-desc {
      font-size: 13px;
      color: #e8e8f0;
      margin-bottom: 12px;
    }
    .cp-confirm-actions {
      display: flex;
      gap: 8px;
    }
    .cp-confirm-btn {
      flex: 1;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: opacity 0.15s;
    }
    .cp-confirm-btn:hover { opacity: 0.85; }
    .cp-confirm-approve {
      background: #4DECC7;
      color: #0a0a0f;
    }
    .cp-confirm-reject {
      background: #3a3a4a;
      color: #aaa;
    }

    /* Typing indicator */
    .cp-typing {
      align-self: flex-start;
      display: flex;
      gap: 4px;
      padding: 8px 14px;
    }
    .cp-typing-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #4DECC7;
      animation: cp-bounce 1.4s ease-in-out infinite;
    }
    .cp-typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .cp-typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes cp-bounce {
      0%, 80%, 100% { transform: translateY(0); }
      40% { transform: translateY(-6px); }
    }

    /* Input area */
    .cp-input-area {
      padding: 12px 16px;
      border-top: 1px solid var(--border, #2a2a3a);
      background: var(--bg-elevated, #16161e);
      display: flex;
      gap: 8px;
    }
    .cp-input {
      flex: 1;
      background: var(--bg, #111118);
      border: 1px solid var(--border, #2a2a3a);
      border-radius: 10px;
      padding: 10px 14px;
      color: var(--text, #e8e8f0);
      font-size: 13px;
      font-family: inherit;
      resize: none;
      outline: none;
      min-height: 20px;
      max-height: 100px;
    }
    .cp-input:focus {
      border-color: #4DECC7;
    }
    .cp-input::placeholder {
      color: var(--text-muted, #555);
    }
    .cp-send-btn {
      background: #4DECC7;
      color: #0a0a0f;
      border: none;
      border-radius: 10px;
      width: 40px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      font-weight: 700;
      transition: opacity 0.15s;
    }
    .cp-send-btn:hover { opacity: 0.85; }
    .cp-send-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Empty state */
    .cp-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 32px;
      text-align: center;
    }
    .cp-empty-icon {
      font-size: 40px;
      opacity: 0.7;
    }
    .cp-empty-text {
      font-size: 14px;
      color: var(--text-muted, #888);
      line-height: 1.5;
    }
    .cp-empty-hint {
      font-size: 11px;
      color: var(--text-muted, #666);
    }

    /* Session list (sidebar) */
    .cp-sessions {
      padding: 8px;
      border-bottom: 1px solid var(--border, #2a2a3a);
      max-height: 120px;
      overflow-y: auto;
    }
    .cp-session-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
      color: var(--text-muted, #aaa);
      transition: background 0.15s;
    }
    .cp-session-item:hover {
      background: var(--bg-hover, #2a2a3a);
    }
    .cp-session-item.active {
      background: rgba(77,236,199,0.1);
      color: #4DECC7;
    }
    .cp-session-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 240px;
    }
    .cp-session-new {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
      color: #4DECC7;
      border: 1px dashed #4DECC7;
      margin: 4px 0;
      transition: background 0.15s;
    }
    .cp-session-new:hover {
      background: rgba(77,236,199,0.08);
    }

    /* ═══ Brain Context Panel ═══ */
    .cp-brain-panel {
      display: none;
      border-bottom: 1px solid var(--border, #2a2a3a);
      background: #0d0d14;
      max-height: 200px;
      overflow-y: auto;
    }
    .cp-brain-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      font-size: 11px;
      font-weight: 600;
      color: #4DECC7;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid rgba(77,236,199,0.15);
    }
    .cp-brain-header span {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cp-brain-code {
      padding: 10px 12px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      line-height: 1.5;
      color: #a0a0b0;
      white-space: pre;
      overflow-x: auto;
    }

    /* Mobile responsive */
    @media (max-width: 500px) {
      .copilot-panel {
        width: calc(100vw - 16px);
        height: calc(100vh - 100px);
        bottom: 80px;
        right: 8px;
        border-radius: 12px;
      }
    }
  `;
  document.head.appendChild(style);

  // ── Определяем текущий роут ──────────────────────
  function _currentRoute() {
    var hash = location.hash.replace(/^#/, '') || 'docs';
    return hash.split('?')[0];
  }

  function _isDashboardRoute() {
    var r = _currentRoute();
    return r === 'dashboard';
  }

  // ── FAB (Floating Action Button) ─────────────────
  var fab = document.createElement('button');
  fab.className = 'copilot-fab' + (_isDashboardRoute() ? '' : ' copilot-fab-hidden');
  fab.id = 'copilotFab';
  fab.title = 'AI-копилот';
  fab.innerHTML = '<div class="fab-pulse"></div>🤖';
  document.body.appendChild(fab);

  // ── Panel container ──────────────────────────────
  var panel = document.createElement('div');
  panel.className = 'copilot-panel';
  panel.id = 'copilotPanel';
  panel.innerHTML = `
    <div class="cp-header">
      <div class="cp-header-title"><span class="cp-dot"></span> AI-копилот</div>
      <div class="cp-header-actions">
        <button class="cp-header-btn" id="cpBtnBrain" title="Контекст: XML текущего дашборда">🧠</button>
        <button class="cp-header-btn" id="cpBtnNewSession" title="Новая сессия">＋</button>
        <button class="cp-header-btn" id="cpBtnClear" title="Очистить историю">🗑</button>
        <button class="cp-header-btn" id="cpBtnClose" title="Закрыть">✕</button>
      </div>
    </div>
    <div class="cp-brain-panel" id="cpBrainPanel">
      <div class="cp-brain-header">
        <span>🧠 Контекст агента (XML текущего дашборда)</span>
      </div>
      <pre class="cp-brain-code"><!-- загрузка... --></pre>
    </div>
    <div class="cp-sessions" id="cpSessions"></div>
    <div class="cp-messages" id="cpMessages"></div>
    <div class="cp-input-area">
      <textarea class="cp-input" id="cpInput" placeholder="Спросите что-нибудь..." rows="1"></textarea>
      <button class="cp-send-btn" id="cpSendBtn" title="Отправить">▶</button>
    </div>
  `;
  document.body.appendChild(panel);

  // ── Event listeners (delegated to copilot-modal.js) ──
  var panelOpen = false;
  fab.addEventListener('click', function(){
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    if (panelOpen) {
      // Инициализируем модальное окно при первом открытии
      if (typeof window._copilotModalInit === 'function') {
        window._copilotModalInit();
      }
    }
  });

  // Close button
  document.getElementById('cpBtnClose').addEventListener('click', function(){
    panelOpen = false;
    panel.classList.remove('open');
  });

  // ── Route change → show/hide FAB ─────────────────
  function _updateVisibility() {
    var isDash = _isDashboardRoute();
    if (isDash) {
      fab.classList.remove('copilot-fab-hidden');
    } else {
      fab.classList.add('copilot-fab-hidden');
      // Закрываем панель при уходе с dashboard
      if (panelOpen) {
        panelOpen = false;
        panel.classList.remove('open');
      }
    }
  }

  window.addEventListener('hashchange', _updateVisibility);
  // Первичная проверка
  _updateVisibility();

  // ── Public API ───────────────────────────────────
  window._copilotWidget = {
    open: function(){
      if (!_isDashboardRoute()) return; // не открываем вне dashboard
      panelOpen = true;
      panel.classList.add('open');
      if (typeof window._copilotModalInit === 'function') {
        window._copilotModalInit();
      }
    },
    close: function(){
      panelOpen = false;
      panel.classList.remove('open');
    },
    toggle: function(){
      if (!_isDashboardRoute()) return;
      panelOpen = !panelOpen;
      panel.classList.toggle('open', panelOpen);
      if (panelOpen && typeof window._copilotModalInit === 'function') {
        window._copilotModalInit();
      }
    },
    isOpen: function(){ return panelOpen; }
  };
})();

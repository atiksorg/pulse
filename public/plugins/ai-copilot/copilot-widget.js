/**
 * public/plugins/ai-copilot/copilot-widget.js — Плавающая кнопка AI-копилота
 *
 * Стилистика: Adobe Photoshop — компактная, минималистичная, тёмная.
 * Панель сессий слева, чат справа. Управление сессиями (удаление, переименование).
 *
 * ВАЖНО: Виджет показывается ТОЛЬКО в личном кабинете (route === 'dashboard').
 */
'use strict';

(function(){
  if (window._copilotWidgetLoaded) return;
  window._copilotWidgetLoaded = true;

  // ── CSS — Photoshop-inspired dark compact theme ──
  var style = document.createElement('style');
  style.textContent = `
    /* ═══ Copilot Widget — Photoshop Dark Theme ═══ */

    :root {
      --cp-bg: #1e1e1e;
      --cp-bg-alt: #252526;
      --cp-bg-hover: #2a2a2a;
      --cp-bg-active: #37373d;
      --cp-bg-input: #3c3c3c;
      --cp-border: #3c3c3c;
      --cp-border-light: #474747;
      --cp-text: #cccccc;
      --cp-text-muted: #717171;
      --cp-text-bright: #e0e0e0;
      --cp-accent: #4DECC7;
      --cp-accent-dim: rgba(77,236,199,0.15);
      --cp-red: #f44747;
      --cp-yellow: #cca700;
      --cp-radius: 2px;
    }

    .copilot-fab {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 44px;
      height: 44px;
      border-radius: 4px;
      background: var(--cp-bg-alt);
      color: var(--cp-accent);
      border: 1px solid var(--cp-border);
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      z-index: 9998;
      transition: background 0.12s, border-color 0.12s;
    }
    .copilot-fab-hidden { display: none !important; }
    .copilot-fab:hover {
      background: var(--cp-bg-hover);
      border-color: var(--cp-accent);
    }
    .copilot-fab .fab-pulse {
      position: absolute;
      width: 44px;
      height: 44px;
      border-radius: 4px;
      background: var(--cp-accent-dim);
      animation: copilot-pulse 2s ease-out infinite;
    }
    @keyframes copilot-pulse {
      0% { transform: scale(1); opacity: 1; }
      100% { transform: scale(2); opacity: 0; }
    }

    /* ═══ Copilot Panel ═══ */
    .copilot-panel {
      position: fixed;
      bottom: 72px;
      right: 20px;
      width: 580px;
      max-width: calc(100vw - 40px);
      height: 520px;
      max-height: calc(100vh - 100px);
      background: var(--cp-bg);
      border: 1px solid var(--cp-border);
      border-radius: var(--cp-radius);
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
      display: none;
      flex-direction: column;
      z-index: 9999;
      overflow: hidden;
      font-family: -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
      font-size: 12px;
      color: var(--cp-text);
    }
    .copilot-panel.open { display: flex; }

    /* ═══ Layout: sidebar + main ═══ */
    .cp-layout {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    /* ═══ Sidebar (sessions) ═══ */
    .cp-sidebar {
      width: 180px;
      min-width: 180px;
      border-right: 1px solid var(--cp-border);
      display: flex;
      flex-direction: column;
      background: var(--cp-bg-alt);
    }
    .cp-sidebar-header {
      padding: 8px 10px;
      border-bottom: 1px solid var(--cp-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .cp-sidebar-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--cp-text-muted);
    }
    .cp-sidebar-btn {
      background: none;
      border: none;
      color: var(--cp-text-muted);
      cursor: pointer;
      padding: 2px 4px;
      font-size: 14px;
      line-height: 1;
      border-radius: var(--cp-radius);
      transition: color 0.12s, background 0.12s;
    }
    .cp-sidebar-btn:hover {
      color: var(--cp-accent);
      background: var(--cp-accent-dim);
    }
    .cp-sessions-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px;
    }
    .cp-sessions-list::-webkit-scrollbar { width: 4px; }
    .cp-sessions-list::-webkit-scrollbar-thumb { background: var(--cp-border); }

    .cp-session-item {
      display: flex;
      align-items: center;
      padding: 6px 8px;
      border-radius: var(--cp-radius);
      cursor: pointer;
      color: var(--cp-text-muted);
      transition: background 0.1s, color 0.1s;
      gap: 4px;
      position: relative;
      group: session;
    }
    .cp-session-item:hover {
      background: var(--cp-bg-hover);
      color: var(--cp-text);
    }
    .cp-session-item.active {
      background: var(--cp-bg-active);
      color: var(--cp-text-bright);
    }
    .cp-session-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
      line-height: 1.3;
    }
    .cp-session-actions {
      display: none;
      gap: 2px;
      align-items: center;
    }
    .cp-session-item:hover .cp-session-actions {
      display: flex;
    }
    .cp-session-act-btn {
      background: none;
      border: none;
      color: var(--cp-text-muted);
      cursor: pointer;
      padding: 2px;
      font-size: 10px;
      line-height: 1;
      border-radius: var(--cp-radius);
      transition: color 0.1s;
      opacity: 0.6;
    }
    .cp-session-act-btn:hover {
      color: var(--cp-text-bright);
      opacity: 1;
    }
    .cp-session-act-btn.cp-act-delete:hover {
      color: var(--cp-red);
    }

    /* Inline rename input */
    .cp-session-rename-input {
      flex: 1;
      background: var(--cp-bg-input);
      border: 1px solid var(--cp-accent);
      border-radius: var(--cp-radius);
      color: var(--cp-text-bright);
      font-size: 11px;
      padding: 2px 4px;
      outline: none;
      font-family: inherit;
    }

    /* ═══ Main area (header + messages + input) ═══ */
    .cp-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Header */
    .cp-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      border-bottom: 1px solid var(--cp-border);
      background: var(--cp-bg-alt);
      min-height: 32px;
    }
    .cp-header-title {
      font-size: 12px;
      font-weight: 500;
      color: var(--cp-text-bright);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cp-header-title .cp-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--cp-accent);
      flex-shrink: 0;
    }
    .cp-header-actions {
      display: flex;
      gap: 2px;
    }
    .cp-header-btn {
      background: none;
      border: none;
      color: var(--cp-text-muted);
      cursor: pointer;
      padding: 4px 6px;
      border-radius: var(--cp-radius);
      font-size: 13px;
      transition: color 0.12s, background 0.12s;
    }
    .cp-header-btn:hover {
      background: var(--cp-bg-hover);
      color: var(--cp-text-bright);
    }
    .cp-header-btn.cp-brain-active {
      color: var(--cp-accent);
      background: var(--cp-accent-dim);
    }

    /* Messages area */
    .cp-messages {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .cp-messages::-webkit-scrollbar { width: 5px; }
    .cp-messages::-webkit-scrollbar-thumb { background: var(--cp-border); }

    /* Message bubbles */
    .cp-msg {
      max-width: 85%;
      padding: 8px 10px;
      border-radius: var(--cp-radius);
      font-size: 12px;
      line-height: 1.5;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .cp-msg-user {
      align-self: flex-end;
      background: #264f3d;
      color: var(--cp-text-bright);
    }
    .cp-msg-assistant {
      align-self: flex-start;
      background: var(--cp-bg-alt);
      color: var(--cp-text);
      border: 1px solid var(--cp-border);
    }
    .cp-msg-error {
      align-self: center;
      background: #3a1a1a;
      color: var(--cp-red);
      font-size: 11px;
      text-align: center;
    }
    .cp-msg-timestamp {
      font-size: 10px;
      color: var(--cp-text-muted);
      margin-top: 3px;
      opacity: 0.6;
    }

    /* Tool call card */
    .cp-tool-card {
      align-self: flex-start;
      max-width: 90%;
      background: var(--cp-bg-alt);
      border: 1px solid var(--cp-border);
      border-radius: var(--cp-radius);
      padding: 8px 10px;
      font-size: 11px;
    }
    .cp-tool-name {
      font-weight: 600;
      color: var(--cp-accent);
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 11px;
    }
    .cp-tool-status {
      font-size: 10px;
      color: var(--cp-text-muted);
      margin-top: 2px;
    }
    .cp-tool-status.status-done { color: var(--cp-accent); }
    .cp-tool-status.status-pending { color: var(--cp-yellow); }
    .cp-tool-status.status-error { color: var(--cp-red); }

    /* Confirm card */
    .cp-confirm-card {
      align-self: flex-start;
      max-width: 90%;
      background: #2d2d20;
      border: 1px solid #4a4a30;
      border-radius: var(--cp-radius);
      padding: 10px;
    }
    .cp-confirm-desc {
      font-size: 12px;
      color: var(--cp-text);
      margin-bottom: 8px;
    }
    .cp-confirm-actions {
      display: flex;
      gap: 6px;
    }
    .cp-confirm-btn {
      flex: 1;
      padding: 5px 10px;
      border-radius: var(--cp-radius);
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: opacity 0.1s;
    }
    .cp-confirm-btn:hover { opacity: 0.85; }
    .cp-confirm-approve {
      background: var(--cp-accent);
      color: #1e1e1e;
    }
    .cp-confirm-reject {
      background: var(--cp-bg-input);
      color: var(--cp-text-muted);
      border: 1px solid var(--cp-border);
    }

    /* Typing indicator */
    .cp-typing {
      align-self: flex-start;
      display: flex;
      gap: 3px;
      padding: 6px 10px;
    }
    .cp-typing-dot {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--cp-accent);
      animation: cp-bounce 1.4s ease-in-out infinite;
    }
    .cp-typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .cp-typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes cp-bounce {
      0%, 80%, 100% { transform: translateY(0); }
      40% { transform: translateY(-4px); }
    }

    /* Input area */
    .cp-input-area {
      padding: 8px 10px;
      border-top: 1px solid var(--cp-border);
      background: var(--cp-bg-alt);
      display: flex;
      gap: 6px;
    }
    .cp-input {
      flex: 1;
      background: var(--cp-bg-input);
      border: 1px solid var(--cp-border);
      border-radius: var(--cp-radius);
      padding: 7px 10px;
      color: var(--cp-text-bright);
      font-size: 12px;
      font-family: inherit;
      resize: none;
      outline: none;
      min-height: 18px;
      max-height: 80px;
    }
    .cp-input:focus { border-color: var(--cp-accent); }
    .cp-input::placeholder { color: var(--cp-text-muted); }
    .cp-send-btn {
      background: var(--cp-accent);
      color: #1e1e1e;
      border: none;
      border-radius: var(--cp-radius);
      width: 34px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 700;
      transition: opacity 0.1s;
    }
    .cp-send-btn:hover { opacity: 0.85; }
    .cp-send-btn:disabled { opacity: 0.3; cursor: not-allowed; }

    /* Empty state */
    .cp-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 24px;
      text-align: center;
    }
    .cp-empty-icon {
      font-size: 28px;
      opacity: 0.5;
    }
    .cp-empty-text {
      font-size: 12px;
      color: var(--cp-text-muted);
      line-height: 1.4;
    }

    /* ═══ Brain Context Panel ═══ */
    .cp-brain-panel {
      display: none;
      border-bottom: 1px solid var(--cp-border);
      background: #1a1a1a;
      max-height: 300px;
      overflow-y: auto;
    }
    .cp-brain-tabs {
      display: flex;
      border-bottom: 1px solid var(--cp-border);
    }
    .cp-brain-tab {
      flex: 1;
      padding: 6px 10px;
      font-size: 10px;
      font-weight: 600;
      color: var(--cp-text-muted);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: all 0.1s;
      text-align: center;
    }
    .cp-brain-tab:hover { color: var(--cp-text); }
    .cp-brain-tab.active {
      color: var(--cp-accent);
      border-bottom-color: var(--cp-accent);
    }
    .cp-brain-tab-content {
      display: none;
      max-height: 220px;
      overflow-y: auto;
    }
    .cp-brain-tab-content.visible { display: block; }
    .cp-brain-section {
      padding: 8px 10px;
      border-bottom: 1px solid var(--cp-border);
    }
    .cp-brain-section:last-child { border-bottom: none; }
    .cp-brain-section-title {
      font-size: 9px;
      font-weight: 600;
      color: var(--cp-accent);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .cp-brain-md {
      font-size: 11px;
      line-height: 1.4;
      color: var(--cp-text-muted);
    }
    .cp-brain-code {
      padding: 8px 10px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      line-height: 1.4;
      color: var(--cp-text-muted);
      white-space: pre;
      overflow-x: auto;
    }
    .cp-brain-tool {
      padding: 6px 10px;
      border-bottom: 1px solid var(--cp-border);
    }
    .cp-brain-tool:last-child { border-bottom: none; }
    .cp-brain-tool-name {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      font-weight: 600;
      color: var(--cp-accent);
    }
    .cp-brain-tool-desc {
      font-size: 10px;
      color: var(--cp-text-muted);
      margin-top: 1px;
    }
    .cp-brain-tool-params {
      margin-top: 3px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 9px;
      color: var(--cp-text-muted);
    }
    .cp-brain-tool-confirm {
      font-size: 9px;
      color: var(--cp-yellow);
      margin-left: 4px;
    }
    .cp-brain-loading {
      padding: 16px;
      text-align: center;
      color: var(--cp-text-muted);
      font-size: 11px;
    }

    /* ═══ Markdown Styles ═══ */
    .cp-msg-assistant .cp-md h1,
    .cp-msg-assistant .cp-md h2,
    .cp-msg-assistant .cp-md h3 {
      margin: 8px 0 4px 0;
      font-weight: 600;
      line-height: 1.3;
      color: var(--cp-text-bright);
    }
    .cp-msg-assistant .cp-md h1 { font-size: 14px; }
    .cp-msg-assistant .cp-md h2 { font-size: 13px; }
    .cp-msg-assistant .cp-md h3 { font-size: 12px; }
    .cp-msg-assistant .cp-md p { margin: 4px 0; }
    .cp-msg-assistant .cp-md strong { font-weight: 600; }
    .cp-msg-assistant .cp-md em { font-style: italic; }
    .cp-msg-assistant .cp-md code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      background: rgba(77,236,199,0.08);
      padding: 1px 4px;
      border-radius: var(--cp-radius);
      color: var(--cp-accent);
    }
    .cp-msg-assistant .cp-md pre {
      background: #1a1a1a;
      border: 1px solid var(--cp-border);
      border-radius: var(--cp-radius);
      padding: 8px;
      margin: 6px 0;
      overflow-x: auto;
    }
    .cp-msg-assistant .cp-md pre code {
      background: none;
      padding: 0;
      color: var(--cp-text-muted);
      font-size: 10px;
    }
    .cp-msg-assistant .cp-md ul,
    .cp-msg-assistant .cp-md ol {
      margin: 4px 0;
      padding-left: 18px;
    }
    .cp-msg-assistant .cp-md li { margin: 2px 0; }
    .cp-msg-assistant .cp-md a {
      color: var(--cp-accent);
      text-decoration: none;
    }
    .cp-msg-assistant .cp-md blockquote {
      border-left: 2px solid var(--cp-accent-dim);
      padding-left: 10px;
      margin: 6px 0;
      color: var(--cp-text-muted);
    }
    .cp-msg-assistant .cp-md table {
      border-collapse: collapse;
      margin: 6px 0;
      font-size: 11px;
      width: 100%;
    }
    .cp-msg-assistant .cp-md th,
    .cp-msg-assistant .cp-md td {
      border: 1px solid var(--cp-border);
      padding: 3px 6px;
      text-align: left;
    }
    .cp-msg-assistant .cp-md th {
      background: var(--cp-bg-hover);
      font-weight: 600;
    }
    .cp-msg-assistant .cp-md hr {
      border: none;
      border-top: 1px solid var(--cp-border);
      margin: 8px 0;
    }

    /* ═══ Inline Action Buttons ═══ */
    .cp-btn-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin: 6px 0 2px 0;
    }
    .cp-action-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border: 1px solid var(--cp-border);
      border-radius: var(--cp-radius);
      background: var(--cp-bg-input);
      color: var(--cp-accent);
      font-size: 11px;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.1s;
      white-space: nowrap;
    }
    .cp-action-btn:hover {
      background: var(--cp-accent-dim);
      border-color: var(--cp-accent);
    }
    .cp-action-btn.cp-btn-pending {
      opacity: 0.4;
      pointer-events: none;
    }

    /* Mobile */
    @media (max-width: 600px) {
      .copilot-panel {
        width: calc(100vw - 12px);
        height: calc(100vh - 80px);
        bottom: 60px;
        right: 6px;
      }
      .cp-sidebar { width: 140px; min-width: 140px; }
    }
  `;
  document.head.appendChild(style);

  // ── Определяем текущий роут ──────────────────────
  function _currentRoute() {
    var hash = location.hash.replace(/^#/, '') || 'docs';
    return hash.split('?')[0];
  }
  function _isDashboardRoute() {
    return _currentRoute() === 'dashboard';
  }

  // ── FAB ──────────────────────────────────────────
  var fab = document.createElement('button');
  fab.className = 'copilot-fab' + (_isDashboardRoute() ? '' : ' copilot-fab-hidden');
  fab.id = 'copilotFab';
  fab.title = 'AI-копилот';
  fab.innerHTML = '<div class="fab-pulse"></div>✦';
  document.body.appendChild(fab);

  // ── Panel container ──────────────────────────────
  var panel = document.createElement('div');
  panel.className = 'copilot-panel';
  panel.id = 'copilotPanel';
  panel.innerHTML = `
    <div class="cp-header">
      <div class="cp-header-title"><span class="cp-dot"></span> AI-копилот</div>
      <div class="cp-header-actions">
        <button class="cp-header-btn" id="cpBtnBrain" title="Контекст агента">🧠</button>
        <button class="cp-header-btn" id="cpBtnClose" title="Закрыть">✕</button>
      </div>
    </div>
    <div class="cp-brain-panel" id="cpBrainPanel">
      <div class="cp-brain-tabs" id="cpBrainTabs">
        <button class="cp-brain-tab active" data-tab="instructions">Инструкции</button>
        <button class="cp-brain-tab" data-tab="tools">Инструменты</button>
        <button class="cp-brain-tab" data-tab="xml">XML</button>
      </div>
      <div class="cp-brain-tab-content visible" id="brainTabInstructions">
        <div class="cp-brain-loading">Загрузка...</div>
      </div>
      <div class="cp-brain-tab-content" id="brainTabTools">
        <div class="cp-brain-loading">Загрузка...</div>
      </div>
      <div class="cp-brain-tab-content" id="brainTabXml">
        <pre class="cp-brain-code"><!-- --></pre>
      </div>
    </div>
    <div class="cp-layout">
      <div class="cp-sidebar">
        <div class="cp-sidebar-header">
          <span class="cp-sidebar-title">Чаты</span>
          <button class="cp-sidebar-btn" id="cpBtnNewSession" title="Новый чат">＋</button>
        </div>
        <div class="cp-sessions-list" id="cpSessions"></div>
      </div>
      <div class="cp-main">
        <div class="cp-messages" id="cpMessages"></div>
        <div class="cp-input-area">
          <textarea class="cp-input" id="cpInput" placeholder="Сообщение..." rows="1"></textarea>
          <button class="cp-send-btn" id="cpSendBtn" title="Отправить">▶</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // ── Events ───────────────────────────────────────
  var panelOpen = false;
  fab.addEventListener('click', function(){
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    if (panelOpen && typeof window._copilotModalInit === 'function') {
      window._copilotModalInit();
    }
  });
  document.getElementById('cpBtnClose').addEventListener('click', function(){
    panelOpen = false;
    panel.classList.remove('open');
  });

  function _updateVisibility() {
    var isDash = _isDashboardRoute();
    if (isDash) {
      fab.classList.remove('copilot-fab-hidden');
    } else {
      fab.classList.add('copilot-fab-hidden');
      if (panelOpen) { panelOpen = false; panel.classList.remove('open'); }
    }
  }
  window.addEventListener('hashchange', _updateVisibility);
  _updateVisibility();

  // ── Public API ───────────────────────────────────
  window._copilotWidget = {
    open: function(){ if (!_isDashboardRoute()) return; panelOpen = true; panel.classList.add('open'); if (typeof window._copilotModalInit === 'function') window._copilotModalInit(); },
    close: function(){ panelOpen = false; panel.classList.remove('open'); },
    toggle: function(){ if (!_isDashboardRoute()) return; panelOpen = !panelOpen; panel.classList.toggle('open', panelOpen); if (panelOpen && typeof window._copilotModalInit === 'function') window._copilotModalInit(); },
    isOpen: function(){ return panelOpen; }
  };
})();

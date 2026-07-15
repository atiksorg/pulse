/* ═══════════════════════════════════════════════════
   public/plugins/alert/alert-ui.js — Кнопка «Уведомление» в выпадающем меню KPI-панелей
   + инъекция HTML модалки в DOM
   Зависит от: core.js (API, getSession, authHeaders, escapeHtml, toast, confirmModal),
               panels-render.js (для post-render инъекции), alert-modal.js
   ═══════════════════════════════════════════════════ */
'use strict';

(function() {

  /* ── Состояние ── */
  var _activeKpiPanels = {}; // panelId → { card, panelObj }

  /* ── Иконка уведомления (inline SVG, чтобы не зависеть от panelMenuIcon) ── */
  var ALERT_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

  /* ── Post-render: добавляем пункт «Уведомление» в меню KPI/gauge-панелей ── */
  function _injectAlertMenuItem(card, p) {
    if (!card || !p) return;
    if (p.viz !== 'kpi' && p.viz !== 'gauge') return;

    var dropdown = card.querySelector('.panel-menu-dropdown');
    if (!dropdown) return;

    // Не дублируем, если уже добавлен (при ре-рендере)
    if (dropdown.querySelector('[data-act="alert-config"]')) return;

    // Вставляем ПОСЛЕ «Сглаживание» (для KPI не особо актуально, но для gauge-ok)
    // и ДО «Пример записи» — чтобы логически сгруппировать с интеграциями.
    var anchor = dropdown.querySelector('[data-act="smooth"]');
    var btn = document.createElement('button');
    btn.className = 'panel-menu-item';
    btn.setAttribute('data-act', 'alert-config');
    btn.innerHTML = ALERT_ICON_SVG + '<span>Уведомление</span>';

    if (anchor && anchor.nextSibling) {
      dropdown.insertBefore(btn, anchor.nextSibling);
    } else if (anchor) {
      dropdown.appendChild(btn);
    } else {
      // fallback: перед «Удалить панель»
      var removeItem = dropdown.querySelector('[data-act="remove"]');
      if (removeItem) {
        dropdown.insertBefore(btn, removeItem);
      } else {
        dropdown.appendChild(btn);
      }
    }

    // Запоминаем связку card ↔ panel
    _activeKpiPanels[p.id] = { card: card, panel: p };
  }

  function _processAllCards() {
    var cards = document.querySelectorAll('#panelGrid .panel-card');
    if (!cards.length) return;

    // Достаём активный дашборд (если есть)
    var db = (typeof getActiveDashboard === 'function') ? getActiveDashboard() : null;
    if (!db || !Array.isArray(db.panels)) return;

    // Строим map: panelId → panel
    var byId = {};
    for (var i = 0; i < db.panels.length; i++) byId[db.panels[i].id] = db.panels[i];

    for (var j = 0; j < cards.length; j++) {
      var card = cards[j];
      // Найдём panel.id по data-panel-id (если есть) или по id body
      var pid = card.getAttribute('data-panel-id');
      if (!pid) {
        var body = card.querySelector('.panel-body');
        if (body && body.id && body.id.indexOf('body-') === 0) {
          pid = body.id.slice(5);
        }
      }
      if (!pid) continue;
      var p = byId[pid];
      if (!p) continue;
      _injectAlertMenuItem(card, p);
    }
  }

  /* ── Делегированный обработчик кликов по «Уведомление» ── */
  function _onAlertMenuClick(e) {
    var target = e.target.closest('[data-act="alert-config"]');
    if (!target) return;

    // Прячем dropdown (как делают остальные пункты меню)
    document.querySelectorAll('.panel-menu-dropdown.show').forEach(function(d) {
      d.classList.remove('show');
    });
    // Восстанавливаем z-index если нужно
    if (typeof _restoreDropdownZIndex === 'function') {
      try { _restoreDropdownZIndex(); } catch (_) {}
    }

    // Достаём panel.id из карточки
    var card = target.closest('.panel-card');
    if (!card) return;
    var body = card.querySelector('.panel-body');
    if (!body || !body.id) return;
    var panelId = body.id.indexOf('body-') === 0 ? body.id.slice(5) : null;
    if (!panelId) return;

    // Активный дашборд и panel-объект
    var db = (typeof getActiveDashboard === 'function') ? getActiveDashboard() : null;
    if (!db || !db.id || db.id.indexOf('temp_') === 0) {
      if (typeof toast === 'function') toast('Сначала сохраните дашборд (войдите в кабинет)');
      return;
    }
    var panel = null;
    for (var i = 0; i < db.panels.length; i++) {
      if (db.panels[i].id === panelId) { panel = db.panels[i]; break; }
    }
    if (!panel) return;

    var sess = (typeof getSession === 'function') ? getSession() : null;
    if (!sess) {
      if (typeof toast === 'function') toast('Войдите в кабинет — уведомления работают только для авторизованных');
      return;
    }

    if (window.AlertModal) {
      window.AlertModal.open(panel, db);
    }
  }

  /* ── MutationObserver: следим за изменениями #panelGrid ── */
  var _observer = null;
  function _startObserver() {
    if (_observer) return;
    var grid = document.getElementById('panelGrid');
    if (!grid || typeof MutationObserver === 'undefined') return;

    _observer = new MutationObserver(function() {
      // Не обрабатываем, если прямо сейчас идёт ре-рендер (timing optimization)
      clearTimeout(_observer._t);
      _observer._t = setTimeout(_processAllCards, 60);
    });
    _observer.observe(grid, { childList: true, subtree: true });
  }

  /* ── Инъекция HTML модалки ── */
  function _injectModalHtml() {
    if (document.getElementById('alertModal')) return;

    var html = [
      '<div class="overlay" id="alertModal">',
      '  <div class="modal" style="max-width:600px;max-height:90vh;overflow-y:auto;">',
      '    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">',
      '      <div><h2 style="margin:0;">🔔 Уведомление</h2>',
      '      <span id="alertStatus" style="font-size:11px;color:var(--muted-2);font-family:var(--mono);">—</span></div>',
      '      <button class="btn btn-ghost" id="alertCloseBtn">✕</button>',
      '    </div>',
      '    <div style="font-size:12px;color:var(--muted-2);margin-bottom:12px;">',
      '      Панель: <b id="alertPanelTitle" style="color:var(--text);">—</b>',
      '      <span id="alertCurrentValue" style="margin-left:8px;font-family:var(--mono);">—</span>',
      '    </div>',
      '',
      '    <!-- Tabs -->',
      '    <div style="display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--border,#1A2130);padding-bottom:8px;flex-wrap:wrap;">',
      '      <button class="btn btn-ghost atab active" data-tab="channel">Канал</button>',
      '      <button class="btn btn-ghost atab" data-tab="condition">Условие</button>',
      '      <button class="btn btn-ghost atab" data-tab="timing">Периодичность</button>',
      '      <button class="btn btn-ghost atab" data-tab="message">Сообщение</button>',
      '      <button class="btn btn-ghost atab" data-tab="test">▶ Тест</button>',
      '      <button class="btn btn-ghost atab" data-tab="history">История</button>',
      '      <button class="btn btn-ghost atab" data-tab="monitor">Монитор</button>',
      '    </div>',
      '',
      '    <!-- Tab: Channel -->',
      '    <div class="atab-pane active" data-pane="channel">',
      '      <div style="font-size:11px;color:var(--muted-2);margin-bottom:10px;">Канал: <b>Telegram</b> (на будущее добавим email/webhook)</div>',
      '      <div class="field-row">',
      '        <div class="field" style="flex:1;">',
      '          <label>Bot Token</label>',
      '          <div style="position:relative;">',
      '            <input id="a_botToken" type="password" placeholder="••••••••" style="padding-right:34px;width:100%;box-sizing:border-box;">',
      '            <button type="button" class="eye-btn" data-target="a_botToken" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:14px;padding:4px;line-height:1;">👁</button>',
      '          </div>',
      '        </div>',
      '      </div>',
      '      <div class="field-row">',
      '        <div class="field" style="flex:1;">',
      '          <label>Chat ID</label>',
      '          <input id="a_chatId" placeholder="323994801 (или -100… для группы)">',
      '        </div>',
      '        <div class="field" style="width:140px;">',
      '          <label>Parse Mode</label>',
      '          <select id="a_parseMode">',
      '            <option value="HTML">HTML</option>',
      '            <option value="MARKDOWN">Markdown</option>',
      '            <option value="MARKDOWNV2">MarkdownV2</option>',
      '          </select>',
      '        </div>',
      '      </div>',
      '    </div>',
      '',
      '    <!-- Tab: Condition -->',
      '    <div class="atab-pane" data-pane="condition">',
      '      <div class="field-row">',
      '        <div class="field">',
      '          <label>Условие срабатывания</label>',
      '          <select id="a_condition">',
      '            <option value="gt">больше (&gt;)</option>',
      '            <option value="gte">больше или равно (≥)</option>',
      '            <option value="lt">меньше (&lt;)</option>',
      '            <option value="lte">меньше или равно (≤)</option>',
      '            <option value="eq">равно (=)</option>',
      '            <option value="neq">не равно (≠)</option>',
      '            <option value="outside_range">вне диапазона [min..max]</option>',
      '          </select>',
      '        </div>',
      '        <div class="field" id="a_thresholdWrap">',
      '          <label>Порог</label>',
      '          <input id="a_threshold" type="number" step="any" placeholder="например 100">',
      '        </div>',
      '      </div>',
      '      <div class="field-row" id="a_rangeWrap" style="display:none;">',
      '        <div class="field">',
      '          <label>Минимум</label>',
      '          <input id="a_thresholdMin" type="number" step="any" placeholder="0">',
      '        </div>',
      '        <div class="field">',
      '          <label>Максимум</label>',
      '          <input id="a_thresholdMax" type="number" step="any" placeholder="1000">',
      '        </div>',
      '      </div>',
      '      <div style="margin-top:10px;padding:8px 10px;background:var(--card-bg,#141921);border-radius:6px;font-size:12px;font-family:var(--mono);color:var(--muted-2);">',
      '        Текущее значение: <b id="a_liveValue" style="color:var(--text);">загрузка…</b>',
      '        <button class="btn btn-ghost" id="aBtnRefreshValue" style="margin-left:8px;font-size:11px;padding:2px 8px;">⟳</button>',
      '      </div>',
      '    </div>',
      '',
      '    <!-- Tab: Timing -->',
      '    <div class="atab-pane" data-pane="timing">',
      '      <div class="field-row">',
      '        <div class="field">',
      '          <label style="display:flex;align-items:center;gap:8px;">',
      '            <input type="checkbox" id="a_isActive"> Автоотправка включена',
      '          </label>',
      '        </div>',
      '      </div>',
      '      <div class="field-row">',
      '        <div class="field">',
      '          <label>Интервал проверки (сек)</label>',
      '          <input id="a_checkInterval" type="number" min="30" max="3600" value="60">',
      '          <div style="font-size:10px;color:var(--muted-2);margin-top:3px;">от 30 сек до 1 часа</div>',
      '        </div>',
      '        <div class="field">',
      '          <label>Cooldown (мин)</label>',
      '          <input id="a_cooldown" type="number" min="0" max="1440" value="30">',
      '          <div style="font-size:10px;color:var(--muted-2);margin-top:3px;">подавляет повторы после срабатывания</div>',
      '        </div>',
      '      </div>',
      '    </div>',
      '',
      '    <!-- Tab: Message -->',
      '    <div class="atab-pane" data-pane="message">',
      '      <div class="field-row">',
      '        <div class="field" style="flex:1;">',
      '          <label>Шаблон сообщения</label>',
      '          <textarea id="a_message" rows="6" style="width:100%;background:var(--card-bg,#141921);color:var(--text,#e0e0e0);border:1px solid var(--border,#1A2130);border-radius:6px;padding:8px;font-size:12px;font-family:var(--mono);resize:vertical;"></textarea>',
      '          <div style="font-size:10px;color:var(--muted-2);margin-top:3px;">',
      '            Плейсхолдеры: <code>{{value}}</code> <code>{{threshold}}</code> <code>{{condition}}</code> <code>{{title}}</code> <code>{{type}}</code> <code>{{dashboard_id}}</code> <code>{{agg}}</code> <code>{{range}}</code>',
      '          </div>',
      '        </div>',
      '      </div>',
      '      <div style="margin-top:10px;padding:8px 10px;background:var(--card-bg,#141921);border-radius:6px;font-size:11px;font-family:var(--mono);">',
      '        <div style="color:var(--muted-2);margin-bottom:4px;">Предпросмотр (подставляем текущее значение):</div>',
      '        <div id="aPreview" style="white-space:pre-wrap;color:var(--text);">—</div>',
      '      </div>',
      '    </div>',
      '',
      '    <!-- Tab: Test -->',
      '    <div class="atab-pane" data-pane="test">',
      '      <div style="font-size:12px;color:var(--muted-2);margin-bottom:10px;">',
      '        Отправляет реальное сообщение в Telegram с текущим значением метрики. Rate-limit: не чаще 1 раза в 5 мин.',
      '      </div>',
      '      <div id="aLiveLogSection" style="display:none;margin-bottom:12px;">',
      '        <h3 style="margin:0 0 8px;font-size:13px;">⚡ Живой лог</h3>',
      '        <div id="aLiveLog" style="background:var(--card-bg,#0D1117);border:1px solid var(--border,#1A2130);border-radius:6px;padding:10px;max-height:220px;overflow-y:auto;font-size:11px;font-family:var(--mono);line-height:1.6;"></div>',
      '      </div>',
      '    </div>',
      '',
      '    <!-- Tab: History -->',
      '    <div class="atab-pane" data-pane="history">',
      '      <div id="aHistoryBody" style="max-height:320px;overflow-y:auto;font-size:12px;">',
      '        <div style="color:var(--muted-2);">история пуста</div>',
      '      </div>',
      '    </div>',
      '',
      '    <!-- Tab: Monitor -->',
      '    <div class="atab-pane" data-pane="monitor">',
      '      <div style="margin-bottom:16px;">',
      '        <div style="display:flex;justify-content:space-between;align-items:center;">',
      '          <h3 style="margin:0;font-size:14px;">💓 Планировщик</h3>',
      '          <button class="btn btn-ghost" id="aBtnRefreshHeartbeat" style="font-size:11px;padding:2px 8px;">⟳</button>',
      '        </div>',
      '        <div id="aHeartbeat" style="margin-top:8px;font-size:12px;font-family:var(--mono);color:var(--muted-2);">загрузка…</div>',
      '      </div>',
      '      <div>',
      '        <h3 style="margin:0;font-size:14px;">📊 Состояние конфига</h3>',
      '        <div id="aConfigState" style="margin-top:8px;font-size:12px;font-family:var(--mono);color:var(--muted-2);">загрузка…</div>',
      '      </div>',
      '    </div>',
      '',
      '    <!-- Actions -->',
      '    <div class="modal-actions" style="margin-top:16px;">',
      '      <button class="btn btn-ghost" id="aBtnDelete" style="color:var(--red,#FF6B6B);">Удалить</button>',
      '      <div style="flex:1;"></div>',
      '      <button class="btn btn-primary" id="aBtnSave">Сохранить</button>',
      '    </div>',
      '',
      '  </div>',
      '</div>'
    ].join('\n');

    var container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container.firstElementChild);
  }

  /* ── Инициализация ── */
  function _init() {
    _injectModalHtml();
    // Привязываем обработчики модалки ПОСЛЕ инъекции HTML
    if (window.AlertModal && typeof window.AlertModal.bindEvents === 'function') {
      window.AlertModal.bindEvents();
    }

    // Делегированный клик по пункту «Уведомление»
    document.addEventListener('click', _onAlertMenuClick, false);

    // Запускаем observer
    _startObserver();
    // Первичный проход — на случай если панели уже отрендерены
    setTimeout(_processAllCards, 300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  // Экспорт для тестов / внешних вызовов
  window.AlertUI = {
    processAllCards: _processAllCards,
  };

})();

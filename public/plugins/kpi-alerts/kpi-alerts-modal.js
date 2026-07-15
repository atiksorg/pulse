/* ═══════════════════════════════════════════════════
   public/plugins/kpi-alerts/kpi-alerts-modal.js — Modal UI for KPI/Gauge alerts
   Depends on: core.js (API, getSession, authHeaders, escapeHtml, toast, confirmModal)
   ═══════════════════════════════════════════════════ */
'use strict';

(function() {

  var _currentDashboardId = null;
  var _currentPanelId = null;
  var _currentRuleId = null;

  function openKpiAlertsModal(dashboardId, panelId) {
    _currentDashboardId = dashboardId;
    _currentPanelId = panelId;
    _currentRuleId = null;

    var modal = document.getElementById('kpiAlertsModal');
    if (!modal) return;
    modal.classList.add('active');

    _switchTab('settings');
    _resetForm();
    _loadRule();
  }

  function closeKpiAlertsModal() {
    var modal = document.getElementById('kpiAlertsModal');
    if (modal) modal.classList.remove('active');
  }

  function _injectKpiAlertsModalHtml() {
    if (document.getElementById('kpiAlertsModal')) return;
    var wrapper = document.createElement('div');
    wrapper.innerHTML = [
      '<div class="overlay" id="kpiAlertsModal">',
      '  <div class="modal" style="max-width:560px;max-height:90vh;overflow-y:auto;">',
      '    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">',
      '      <div><h2 style="margin:0;">🔔 Уведомление</h2>',
      '      <span id="ka_status" style="font-size:11px;color:var(--muted-2);font-family:var(--mono);">—</span></div>',
      '      <button class="btn btn-ghost" id="ka_btnClose">✕</button>',
      '    </div>',
      '    <div style="display:flex;gap:4px;margin-bottom:14px;border-bottom:1px solid var(--border,#1A2130);padding-bottom:8px;flex-wrap:wrap;">',
      '      <button class="btn btn-ghost rtab active" data-tab="settings">Настройки</button>',
      '      <button class="btn btn-ghost rtab" data-tab="monitor">🔍 Монитор</button>',
      '      <button class="btn btn-ghost rtab" data-tab="history">История</button>',
      '    </div>',
      '    <div class="rtab-pane active" data-pane="settings">',
      '      <div class="field-row">',
      '        <div class="field"><label>Условие</label><select id="ka_condition"><option value="above">Значение &gt; порога</option><option value="below">Значение &lt; порога</option><option value="equals">Значение = порогу</option></select></div>',
      '        <div class="field"><label>Порог</label><input id="ka_threshold" type="number" step="any" value="0"></div>',
      '      </div>',
      '      <div class="field-row">',
      '        <div class="field"><label>Cooldown (мин)</label><input id="ka_cooldown" type="number" min="1" max="1440" value="15"></div>',
      '        <div class="field"><label>Интервал проверки (мин)</label><input id="ka_interval" type="number" min="1" max="1440" value="5"></div>',
      '      </div>',
      '      <div class="field-row">',
      '        <div class="field"><label>Telegram Bot Token</label><input id="ka_tgToken" type="password" placeholder="••••••••"></div>',
      '        <div class="field"><label>Chat ID(s)</label><input id="ka_chatIds" placeholder="123456, 789012"></div>',
      '      </div>',
      '      <div class="field-row">',
      '        <div class="field"><label>Шаблон сообщения</label><textarea id="ka_template" rows="3" style="width:100%;background:var(--card-bg,#141921);color:var(--text,#e0e0e0);border:1px solid var(--border,#1A2130);border-radius:6px;padding:8px;font-size:12px;font-family:var(--mono);resize:vertical;" placeholder="Оставьте пустым для дефолтного шаблона"></textarea></div>',
      '      </div>',
      '      <div class="field-row"><div class="field"><label style="display:flex;align-items:center;gap:8px;"><input type="checkbox" id="ka_isActive"> Включено</label></div></div>',
      '    </div>',
      '    <div class="rtab-pane" data-pane="monitor">',
      '      <div style="margin-bottom:16px;">',
      '        <div style="display:flex;justify-content:space-between;align-items:center;">',
      '          <h3 style="margin:0;font-size:14px;">💓 Чекер</h3>',
      '          <button class="btn btn-ghost" id="ka_btnRefreshChecker" style="font-size:11px;padding:2px 8px;">⟳ обновить</button>',
      '        </div>',
      '        <div id="ka_checkerStatus" style="margin-top:8px;font-size:12px;font-family:var(--mono);color:var(--muted-2);">загрузка…</div>',
      '      </div>',
      '      <div>',
      '        <h3 style="margin:0 0 8px;font-size:14px;">📈 Статистика</h3>',
      '        <div id="ka_stats" style="font-size:12px;font-family:var(--mono);color:var(--muted-2);">—</div>',
      '      </div>',
      '    </div>',
      '    <div class="rtab-pane" data-pane="history">',
      '      <div id="ka_historyBody" style="max-height:300px;overflow-y:auto;">',
      '        <div style="color:var(--muted-2);font-size:12px;">история пуста</div>',
      '      </div>',
      '    </div>',
      '    <div class="modal-actions" style="margin-top:16px;">',
      '      <button class="btn btn-ghost" id="ka_btnDelete" style="color:var(--red,#FF6B6B);">Удалить</button>',
      '      <div style="flex:1;"></div>',
      '      <button class="btn btn-primary" id="ka_btnTest">🔔 Тест</button>',
      '      <button class="btn btn-primary" id="ka_btnSave">Сохранить</button>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('\n');

    var modalEl = wrapper.firstElementChild;
    document.body.appendChild(modalEl);
  }

  function _switchTab(tab) {
    var tabs = document.querySelectorAll('#kpiAlertsModal .rtab');
    var panes = document.querySelectorAll('#kpiAlertsModal .rtab-pane');
    tabs.forEach(function(t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === tab);
    });
    panes.forEach(function(p) {
      p.classList.toggle('active', p.getAttribute('data-pane') === tab);
    });
    if (tab === 'monitor') {
      _loadCheckerStatus();
      _loadStats();
    }
    if (tab === 'history') {
      _loadHistory();
    }
  }

  function _resetForm() {
    var $ = function(id) { return document.getElementById(id); };
    $('ka_condition').value = 'above';
    $('ka_threshold').value = '0';
    $('ka_cooldown').value = '15';
    $('ka_interval').value = '5';
    $('ka_tgToken').value = '';
    $('ka_chatIds').value = '';
    $('ka_template').value = '';
    $('ka_isActive').checked = false;
    $('ka_status').textContent = 'не настроен';
  }

  async function _loadRule() {
    var statusEl = document.getElementById('ka_status');
    if (statusEl) statusEl.textContent = 'загрузка…';

    try {
      var r = await fetch(API + '/alerts/' + encodeURIComponent(_currentDashboardId), {
        headers: authHeaders()
      });
      if (r.status === 401) { clearSession(); closeKpiAlertsModal(); return; }
      if (!r.ok) {
        if (statusEl) statusEl.textContent = 'ошибка загрузки';
        return;
      }

      var data = await r.json();
      var rules = (data.rules || []).filter(function(x) { return x.panel_id === _currentPanelId; });
      var rule = rules.length ? rules[0] : null;

      if (!rule) {
        _currentRuleId = null;
        if (statusEl) statusEl.textContent = 'нет правила';
        return;
      }

      _currentRuleId = rule.id;
      _fillForm(rule);
      if (statusEl) {
        var state = rule.state || 'ok';
        statusEl.textContent = state === 'ok' ? '🟢 ok' : state === 'alerting' ? '🔴 alerting' : '🟡 recovered';
      }

      _loadHistory();
      _loadStats();
    } catch (err) {
      if (statusEl) statusEl.textContent = 'сеть недоступна';
    }
  }

  function _fillForm(rule) {
    var $ = function(id) { return document.getElementById(id); };
    $('ka_condition').value = rule.condition || 'above';
    $('ka_threshold').value = rule.threshold !== undefined ? String(rule.threshold) : '0';
    $('ka_cooldown').value = rule.cooldown_minutes || 15;
    $('ka_interval').value = rule.check_interval_minutes || 5;
    $('ka_tgToken').value = '';
    $('ka_chatIds').value = rule.chat_ids || '';
    $('ka_template').value = rule.message_template || '';
    $('ka_isActive').checked = !!rule.is_active;
  }

  function _readForm() {
    var $ = function(id) { return document.getElementById(id); };
    return {
      panel_id: _currentPanelId,
      condition: $('ka_condition').value,
      threshold: Number($('ka_threshold').value) || 0,
      cooldown_minutes: Number($('ka_cooldown').value) || 15,
      check_interval_minutes: Number($('ka_interval').value) || 5,
      telegram_bot_token: $('ka_tgToken').value.trim(),
      chat_ids: $('ka_chatIds').value.trim(),
      message_template: $('ka_template').value.trim(),
      is_active: $('ka_isActive').checked,
    };
  }

  async function _saveRule() {
    var body = _readForm();
    if (!body.chat_ids && !_currentRuleId) { toast('Укажите Chat ID'); return; }
    if (!body.telegram_bot_token && !_currentRuleId) { toast('Укажите Telegram Bot Token'); return; }

    var btn = document.getElementById('ka_btnSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Сохранение…'; }

    try {
      var url = _currentRuleId
        ? API + '/alerts/' + encodeURIComponent(_currentDashboardId) + '/' + _currentRuleId
        : API + '/alerts/' + encodeURIComponent(_currentDashboardId);

      var method = _currentRuleId ? 'PUT' : 'POST';

      var r = await fetch(url, {
        method,
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify(body)
      });

      if (r.status === 401) { clearSession(); closeKpiAlertsModal(); return; }
      if (!r.ok) {
        var e = await r.json().catch(function() { return {}; });
        toast('Ошибка: ' + (e.error || r.status));
        return;
      }

      var data = await r.json();
      if (data && data.rule) {
        _currentRuleId = data.rule.id;
        _fillForm(data.rule);
        var st = document.getElementById('ka_status');
        if (st) {
          var state = data.rule.state || 'ok';
          st.textContent = state === 'ok' ? '🟢 ok' : state === 'alerting' ? '🔴 alerting' : '🟡 recovered';
        }
      }

      toast('Правило сохранено ✓');
      _loadHistory();
      _loadStats();
    } catch (err) {
      toast('Сеть недоступна');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
    }
  }

  async function _sendTest() {
    if (!_currentRuleId) { toast('Сначала сохраните правило'); return; }
    var btn = document.getElementById('ka_btnTest');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Проверка…'; }

    try {
      var r = await fetch(API + '/alerts/' + encodeURIComponent(_currentDashboardId) + '/' + _currentRuleId + '/test', {
        method: 'POST',
        headers: authHeaders()
      });

      if (r.status === 401) { clearSession(); closeKpiAlertsModal(); return; }
      if (r.status === 429) {
        toast('Подождите 5 минут перед следующим тестом');
        return;
      }
      if (!r.ok) {
        var e = await r.json().catch(function() { return {}; });
        toast('Ошибка: ' + (e.error || r.status));
        return;
      }

      var data = await r.json();
      toast('Текущее значение: ' + (data.current_value != null ? data.current_value : '—'));
      _loadHistory();
      _loadStats();
    } catch (err) {
      toast('Сеть недоступна');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔔 Тест'; }
    }
  }

  async function _deleteRule() {
    if (!_currentRuleId) { toast('Правило не найдено'); return; }
    if (!await confirmModal('Удалить правило?', 'Правило уведомления будет удалено. История сохранится.', 'Удалить')) return;

    try {
      var r = await fetch(API + '/alerts/' + encodeURIComponent(_currentDashboardId) + '/' + _currentRuleId, {
        method: 'DELETE',
        headers: authHeaders()
      });
      if (r.status === 401) { clearSession(); closeKpiAlertsModal(); return; }
      if (!r.ok) {
        var e = await r.json().catch(function() { return {}; });
        toast('Ошибка: ' + (e.error || r.status));
        return;
      }

      _currentRuleId = null;
      _resetForm();
      toast('Правило удалено');
    } catch (err) {
      toast('Сеть недоступна');
    }
  }

  async function _loadHistory() {
    if (!_currentRuleId) return;
    var container = document.getElementById('ka_historyBody');
    if (!container) return;
    container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">загрузка…</div>';

    try {
      var r = await fetch(API + '/alerts/' + encodeURIComponent(_currentDashboardId) + '/' + _currentRuleId + '/history', {
        headers: authHeaders()
      });
      if (!r.ok) { container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">нет данных</div>'; return; }
      var data = await r.json();
      if (!data.history || !data.history.length) {
        container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">история пуста</div>';
        return;
      }

      var html = '<table class="r-history-table" style="width:100%;border-collapse:collapse;font-size:11px;"><thead><tr>' +
        '<th style="text-align:left;padding:4px 6px;">Дата</th>' +
        '<th style="text-align:left;padding:4px 6px;">Событие</th>' +
        '<th style="text-align:left;padding:4px 6px;">Значение</th>' +
        '<th style="text-align:left;padding:4px 6px;">Доставка</th>' +
        '</tr></thead><tbody>';

      data.history.forEach(function(h) {
        var dt = h.ts ? new Date(h.ts).toLocaleString('ru-RU') : '—';
        var statusIcon = h.delivery_status === 'ok' ? '✅' : (h.delivery_status === 'failed' ? '❌' : '⏳');
        html += '<tr style="border-bottom:1px solid var(--border,#1A2130);">' +
          '<td style="padding:4px 6px;white-space:nowrap;">' + escapeHtml(dt) + '</td>' +
          '<td style="padding:4px 6px;">' + escapeHtml(h.event_type) + '</td>' +
          '<td style="padding:4px 6px;">' + (h.value != null ? h.value : '—') + '</td>' +
          '<td style="padding:4px 6px;">' + statusIcon + '</td>' +
          '</tr>';
      });

      html += '</tbody></table>';
      container.innerHTML = html;
    } catch (_) {
      container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">ошибка загрузки</div>';
    }
  }

  async function _loadStats() {
    if (!_currentRuleId) return;
    var statsEl = document.getElementById('ka_stats');
    if (!statsEl) return;

    try {
      var r = await fetch(API + '/alerts/' + encodeURIComponent(_currentDashboardId) + '/' + _currentRuleId + '/history', {
        headers: authHeaders()
      });
      if (!r.ok) return;
      var data = await r.json();
      var h = data.history || [];
      var ok = h.filter(function(x) { return x.delivery_status === 'ok'; }).length;
      var failed = h.filter(function(x) { return x.delivery_status === 'failed'; }).length;

      statsEl.innerHTML =
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
        '<div style="padding:8px;background:var(--card-bg,#141921);border-radius:6px;text-align:center;">' +
        '<div style="font-size:16px;color:var(--green,#4CAF50);">✅ ' + ok + '</div>' +
        '<div style="font-size:10px;color:var(--muted-2);">успешно</div></div>' +
        '<div style="padding:8px;background:var(--card-bg,#141921);border-radius:6px;text-align:center;">' +
        '<div style="font-size:16px;color:' + (failed > 0 ? 'var(--red,#FF6B6B)' : 'var(--muted-2)') + ';">❌ ' + failed + '</div>' +
        '<div style="font-size:10px;color:var(--muted-2);">ошибок</div></div></div>';
    } catch (_) {}
  }

  async function _loadCheckerStatus() {
    var el = document.getElementById('ka_checkerStatus');
    if (!el) return;
    el.innerHTML = '<span style="color:var(--muted-2);">загрузка…</span>';

    try {
      var r = await fetch(API + '/alerts/checker-status', { headers: authHeaders() });
      if (!r.ok) { el.innerHTML = '<span style="color:var(--red);">ошибка</span>'; return; }
      var data = await r.json();

      var ageStr = '—';
      var ageColor = 'var(--muted-2)';
      if (data.lastCheckAgeMs !== null && data.lastCheckAgeMs !== undefined) {
        if (data.lastCheckAgeMs < 120000) {
          ageStr = Math.round(data.lastCheckAgeMs / 1000) + ' сек назад';
          ageColor = 'var(--green,#4CAF50)';
        } else {
          ageStr = Math.round(data.lastCheckAgeMs / 60000) + ' мин назад';
          ageColor = 'var(--yellow,#FFD93D)';
        }
      }

      el.innerHTML =
        '<div style="display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11px;line-height:1.6;">' +
        '<span style="color:var(--muted-2);">Проверка:</span><span style="color:' + ageColor + ';">' + ageStr + '</span>' +
        '<span style="color:var(--muted-2);">Интервал:</span><span>' + ((data.checkIntervalMs || 60000) / 1000) + ' сек</span>' +
        '<span style="color:var(--muted-2);">Активных правил:</span><span>' + (data.activeRules || 0) + '</span>' +
        '<span style="color:var(--muted-2);">Успешно (1ч):</span><span style="color:var(--green,#4CAF50);">' + (data.recentOk1h || 0) + '</span>' +
        '<span style="color:var(--muted-2);">Ошибок (1ч):</span><span style="color:' + ((data.recentErrors1h || 0) > 0 ? 'var(--red,#FF6B6B)' : 'var(--muted-2)') + ';">' + (data.recentErrors1h || 0) + '</span>' +
        '</div>';
    } catch (_) {
      el.innerHTML = '<span style="color:var(--red);">сеть недоступна</span>';
    }
  }

  function _init() {
    _injectKpiAlertsModalHtml();
    var modal = document.getElementById('kpiAlertsModal');
    if (!modal) return;

    document.getElementById('ka_btnClose').onclick = closeKpiAlertsModal;
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeKpiAlertsModal();
    });

    modal.querySelectorAll('.rtab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        _switchTab(tab.getAttribute('data-tab'));
      });
    });

    document.getElementById('ka_btnSave').onclick = _saveRule;
    document.getElementById('ka_btnTest').onclick = _sendTest;
    document.getElementById('ka_btnDelete').onclick = _deleteRule;
    document.getElementById('ka_btnRefreshChecker').onclick = function() {
      _loadCheckerStatus();
      _loadStats();
    };
  }

  window.KpiAlertsModal = {
    open: openKpiAlertsModal,
    close: closeKpiAlertsModal,
    bindEvents: _init
  };

})();

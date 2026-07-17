/* ═══════════════════════════════════════════════════
   public/plugins/threshold-alerts/alerts-modal.js
   Модалка настройки пороговых Telegram-уведомлений для панели
   Зависит от: core.js (API, getSession, authHeaders, escapeHtml, toast, clearSession)
   ═══════════════════════════════════════════════════ */
'use strict';

(function() {

  var _panel = null;        // текущая панель { id, title, type, agg, aggfield, range, filters }
  var _dashboardId = null;
  var _configId = null;      // id существующего правила (если есть)

  /* ── Открыть модалку для конкретной панели ── */
  function openAlertsModal(panel, dashboardId) {
    _panel = panel;
    _dashboardId = dashboardId;
    _configId = null;

    var modal = document.getElementById('alertsModal');
    if (!modal) return;
    modal.classList.add('active');

    var titleEl = document.getElementById('aPanelTitle');
    if (titleEl) titleEl.textContent = panel.title || panel.id;

    _switchTab('settings');
    _loadConfig();
  }

  function closeAlertsModal() {
    var modal = document.getElementById('alertsModal');
    if (modal) modal.classList.remove('active');
  }

  function _switchTab(tab) {
    var tabs = document.querySelectorAll('#alertsModal .atab');
    var panes = document.querySelectorAll('#alertsModal .atab-pane');
    tabs.forEach(function(t) { t.classList.toggle('active', t.getAttribute('data-tab') === tab); });
    panes.forEach(function(p) { p.classList.toggle('active', p.getAttribute('data-pane') === tab); });
    if (tab === 'history') _loadHistory();
  }

  /* ── Загрузка текущего правила для панели ── */
  async function _loadConfig() {
    var statusEl = document.getElementById('aStatus');
    if (statusEl) statusEl.textContent = 'загрузка…';

    _fillFormDefaults();

    try {
      var r = await fetch(API + '/alerts/' + encodeURIComponent(_dashboardId), {
        headers: authHeaders()
      });
      if (r.status === 401) { clearSession(); closeAlertsModal(); return; }
      if (!r.ok) { if (statusEl) statusEl.textContent = 'ошибка загрузки'; return; }

      var data = await r.json();
      var cfg = (data.configs || []).find(function(c) { return c.panel_id === _panel.id; });

      if (!cfg) {
        if (statusEl) statusEl.textContent = 'не настроено';
        return;
      }

      _configId = cfg.id;
      _fillForm(cfg);
      if (statusEl) {
        if (cfg.is_active) {
          var stateColor = cfg.state === 'breached' ? 'var(--red,#FF6B6B)' : 'var(--green,#4CAF50)';
          statusEl.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + stateColor + ';margin-right:4px;vertical-align:middle;"></span>' +
            '<span style="color:' + stateColor + ';">' + (cfg.state === 'breached' ? 'вне диапазона' : 'в норме') + '</span>';
        } else {
          statusEl.innerHTML = '<span style="color:var(--muted-2);">выключено</span>';
        }
      }

      var delBtn = document.getElementById('aBtnDelete');
      if (delBtn) delBtn.style.display = '';
    } catch (_) {
      if (statusEl) statusEl.textContent = 'сеть недоступна';
    }
  }

  function _stateLabel(state) {
    if (state === 'breached') return '⚠️ вне диапазона';
    return '✅ в норме';
  }

  function _fillForm(cfg) {
    var $ = function(id) { return document.getElementById(id); };
    $('a_label').value        = cfg.label || _panel.title || '';
    $('a_agg').value          = cfg.panel_agg || 'count';
    $('a_aggfield').value     = cfg.panel_aggfield || '';
    $('a_range').value        = cfg.panel_range || '24h';
    $('a_minValue').value     = cfg.min_value === null || cfg.min_value === undefined ? '' : cfg.min_value;
    $('a_maxValue').value     = cfg.max_value === null || cfg.max_value === undefined ? '' : cfg.max_value;
    $('a_tgToken').value      = '';
    $('a_tgToken').setAttribute('placeholder', cfg.telegram_bot_token_masked ? cfg.telegram_bot_token_masked : '••••••••');
    $('a_chatIds').value      = cfg.chat_ids || '';
    $('a_checkInterval').value = cfg.check_interval_sec || 60;
    $('a_cooldown').value     = Math.round((cfg.cooldown_sec || 900) / 60);
    $('a_notifyRecovery').checked = cfg.notify_on_recovery !== false;
    $('a_isActive').checked   = !!cfg.is_active;
    _onAggChange();

    var lastVal = document.getElementById('aLastValue');
    if (lastVal) {
      lastVal.textContent = cfg.last_value !== null && cfg.last_value !== undefined
        ? 'Последнее значение: ' + cfg.last_value + (cfg.last_checked_at ? ' (' + new Date(cfg.last_checked_at).toLocaleString('ru-RU') + ')' : '')
        : '';
    }
  }

  function _fillFormDefaults() {
    var $ = function(id) { return document.getElementById(id); };
    $('a_label').value        = _panel ? (_panel.title || '') : '';
    $('a_agg').value          = (_panel && _panel.agg) || 'count';
    $('a_aggfield').value     = (_panel && _panel.aggfield) || '';
    $('a_range').value        = (_panel && _panel.range) || '24h';
    $('a_minValue').value     = '';
    $('a_maxValue').value     = '';
    $('a_tgToken').value      = '';
    $('a_tgToken').setAttribute('placeholder', '••••••••');
    $('a_chatIds').value      = '';
    $('a_checkInterval').value = 60;
    $('a_cooldown').value     = 15;
    $('a_notifyRecovery').checked = true;
    $('a_isActive').checked   = false;
    _onAggChange();

    var lastVal = document.getElementById('aLastValue');
    if (lastVal) lastVal.textContent = '';

    var delBtn = document.getElementById('aBtnDelete');
    if (delBtn) delBtn.style.display = 'none';
  }

  function _onAggChange() {
    var agg = document.getElementById('a_agg').value;
    var row = document.getElementById('a_aggfieldRow');
    if (row) row.style.display = (agg === 'count') ? 'none' : '';
  }

  /* ── Сохранить правило ── */
  async function _saveConfig() {
    var $ = function(id) { return document.getElementById(id).value; };
    var minRaw = $('a_minValue').trim();
    var maxRaw = $('a_maxValue').trim();

    if (!minRaw && !maxRaw) { toast('Укажите минимум, максимум или оба значения'); return; }

    var body = {
      is_active: document.getElementById('a_isActive').checked,
      label: $('a_label').trim() || _panel.title,
      panel_type: _panel.type || '',
      panel_agg: $('a_agg'),
      panel_aggfield: $('a_aggfield').trim(),
      panel_range: $('a_range'),
      filters: Array.isArray(_panel.filters) ? _panel.filters : [],
      min_value: minRaw === '' ? null : Number(minRaw),
      max_value: maxRaw === '' ? null : Number(maxRaw),
      telegram_bot_token: $('a_tgToken').trim(),
      chat_ids: $('a_chatIds').trim(),
      check_interval_sec: Math.max(30, Number($('a_checkInterval')) || 60),
      cooldown_sec: Math.max(60, (Number($('a_cooldown')) || 15) * 60),
      notify_on_recovery: document.getElementById('a_notifyRecovery').checked,
    };

    var saveBtn = document.getElementById('aBtnSave');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Сохранение…'; }

    try {
      var r = await fetch(
        API + '/alerts/' + encodeURIComponent(_dashboardId) + '/' + encodeURIComponent(_panel.id),
        { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify(body) }
      );
      if (r.status === 401) { clearSession(); closeAlertsModal(); return; }
      if (!r.ok) {
        var e = await r.json().catch(function() { return {}; });
        toast('Ошибка: ' + (e.error || r.status));
        return;
      }
      var data = await r.json();
      _configId = data.config.id;
      toast('Правило сохранено');
      _loadConfig();
    } catch (_) {
      toast('Сеть недоступна');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Сохранить'; }
    }
  }

  /* ── Тестовая проверка/отправка ── */
  async function _sendTest() {
    if (!_configId) { toast('Сначала сохраните правило'); return; }
    var btn = document.getElementById('aBtnTest');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Проверяем…'; }

    try {
      var r = await fetch(API + '/alerts/config/' + encodeURIComponent(_configId) + '/test', {
        method: 'POST', headers: authHeaders()
      });
      if (r.status === 401) { clearSession(); closeAlertsModal(); return; }
      if (r.status === 429) { toast('Слишком часто — подождите минуту'); return; }
      if (!r.ok) { var e = await r.json().catch(function(){return{};}); toast('Ошибка: ' + (e.error || r.status)); return; }

      var data = await r.json();
      var res = data.result;
      if (!res.ok && res.error) {
        toast('Ошибка проверки: ' + res.error);
      } else if (res.sent) {
        toast(res.telegram && !res.telegram.ok ? '⚠️ Значение вне нормы, но Telegram не отправил сообщение' : '📨 Уведомление отправлено (значение: ' + res.value + ')');
      } else {
        toast('✅ Значение в норме (' + res.value + ') — уведомление не требуется');
      }
      _loadConfig();
      _loadHistory();
    } catch (_) {
      toast('Сеть недоступна');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '📨 Проверить сейчас'; }
    }
  }

  /* ── Удалить правило ── */
  async function _deleteConfig() {
    if (!_configId) return;
    if (!await confirmModal('Удалить правило?', 'Уведомления по этой панели больше не будут отправляться.', 'Удалить')) return;

    try {
      var r = await fetch(API + '/alerts/config/' + encodeURIComponent(_configId), {
        method: 'DELETE', headers: authHeaders()
      });
      if (r.ok) {
        toast('Правило удалено');
        _configId = null;
        _fillFormDefaults();
        var statusEl = document.getElementById('aStatus');
        if (statusEl) statusEl.textContent = 'не настроено';
      }
    } catch (_) { toast('Сеть недоступна'); }
  }

  /* ── История срабатываний ── */
  async function _loadHistory() {
    var container = document.getElementById('aHistoryBody');
    if (!container) return;
    if (!_configId) { container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">сначала сохраните правило</div>'; return; }

    container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">загрузка…</div>';
    try {
      var r = await fetch(API + '/alerts/config/' + encodeURIComponent(_configId) + '/history', {
        headers: authHeaders()
      });
      if (!r.ok) { container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">нет данных</div>'; return; }
      var data = await r.json();
      if (!data.history || !data.history.length) {
        container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">история пуста</div>';
        return;
      }

      var html = '<table style="width:100%;border-collapse:separate;border-spacing:0;font-size:11px;border-radius:6px;overflow:hidden;">' +
        '<thead><tr>' +
        '<th style="text-align:left;padding:6px 8px;background:var(--card-bg,#141921);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted-2);">Дата</th>' +
        '<th style="text-align:left;padding:6px 8px;background:var(--card-bg,#141921);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted-2);">Значение</th>' +
        '<th style="text-align:left;padding:6px 8px;background:var(--card-bg,#141921);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted-2);">Направление</th>' +
        '<th style="text-align:left;padding:6px 8px;background:var(--card-bg,#141921);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted-2);">Статус</th>' +
        '<th style="text-align:left;padding:6px 8px;background:var(--card-bg,#141921);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted-2);">Тип</th>' +
        '</tr></thead><tbody>';
      data.history.forEach(function(h, idx) {
        var dt = h.ts ? new Date(h.ts).toLocaleString('ru-RU') : '—';
        var dirIcon = h.direction === 'above' ? '⬆️' : (h.direction === 'below' ? '⬇️' : (h.direction === 'recovered' ? '✅' : '—'));
        var statusIcon = h.status === 'sent' ? '📨' : (h.status === 'error' ? '❌' : '⏭');
        var rowBg = idx % 2 === 0 ? '' : 'background:rgba(255,255,255,0.02);';
        html += '<tr style="border-bottom:1px solid var(--border,#1A2130);' + rowBg + '">' +
          '<td style="padding:6px 8px;white-space:nowrap;">' + escapeHtml(dt) + '</td>' +
          '<td style="padding:6px 8px;font-weight:500;">' + (h.value !== null && h.value !== undefined ? h.value : '—') + '</td>' +
          '<td style="padding:6px 8px;">' + dirIcon + ' ' + escapeHtml(h.direction || '—') + '</td>' +
          '<td style="padding:6px 8px;" title="' + escapeHtml(h.error_message || '') + '">' + statusIcon + ' ' + escapeHtml(h.status) + '</td>' +
          '<td style="padding:6px 8px;color:var(--muted-2);">' + escapeHtml(h.trigger_type || '—') + '</td>' +
          '</tr>';
      });
      html += '</tbody></table>';
      container.innerHTML = html;
    } catch (_) {
      container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">ошибка загрузки</div>';
    }
  }

  /* ── Инициализация обработчиков (вызывается после инъекции HTML) ── */
  function _init() {
    var modal = document.getElementById('alertsModal');
    if (!modal) return;

    var closeBtn = document.getElementById('aCloseBtn');
    if (closeBtn) closeBtn.onclick = closeAlertsModal;
    modal.addEventListener('click', function(e) { if (e.target === modal) closeAlertsModal(); });

    modal.querySelectorAll('.atab').forEach(function(tab) {
      tab.addEventListener('click', function() { _switchTab(tab.getAttribute('data-tab')); });
    });

    var aggSel = document.getElementById('a_agg');
    if (aggSel) aggSel.addEventListener('change', _onAggChange);

    var eyeBtn = modal.querySelector('.eye-btn[data-target="a_tgToken"]');
    if (eyeBtn) eyeBtn.addEventListener('click', function() {
      var input = document.getElementById('a_tgToken');
      var isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      eyeBtn.textContent = isPassword ? '🙈' : '👁';
    });

    var saveBtn = document.getElementById('aBtnSave');
    if (saveBtn) saveBtn.addEventListener('click', _saveConfig);

    var testBtn = document.getElementById('aBtnTest');
    if (testBtn) testBtn.addEventListener('click', _sendTest);

    var delBtn = document.getElementById('aBtnDelete');
    if (delBtn) delBtn.addEventListener('click', _deleteConfig);
  }

  window.AlertsModal = {
    open: openAlertsModal,
    close: closeAlertsModal,
    bindEvents: _init
  };

})();

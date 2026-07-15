/* ═══════════════════════════════════════════════════
   public/plugins/alert/alert-modal.js — Модалка настройки пороговых уведомлений
   Зависит от: core.js (API, getSession, authHeaders, escapeHtml, toast, confirmModal)
   ═══════════════════════════════════════════════════ */
'use strict';

(function() {

  /* ── Состояние ── */
  var _alertConfig = null;    // текущий конфиг (masked)
  var _alertPanel = null;      // объект панели {id, title, viz, ...}
  var _alertDashboard = null;  // объект дашборда {id, ...}
  var _liveValueCache = null;  // текущее значение метрики (для preview)
  // Состояние загрузки конфига: 'loading' | 'loaded' | 'missing' | 'error'
  var _configLoadState = 'loading';
  var _configLoadError = '';

  /* ── Открыть модалку ── */
  function openAlertModal(panel, dashboard) {
    _alertPanel = panel;
    _alertDashboard = dashboard;
    _alertConfig = null;
    _configLoadState = 'loading';
    _configLoadError = '';
    var modal = document.getElementById('alertModal');
    if (!modal) return;
    var titleEl = document.getElementById('alertPanelTitle');
    if (titleEl) titleEl.textContent = (panel && panel.title) || '—';

    // Сбрасываем toggle в нейтральное состояние до загрузки
    var statusText = document.getElementById('alertStatusText');
    if (statusText) statusText.textContent = 'Загрузка…';
    var statusSub = document.getElementById('alertStatusSub');
    if (statusSub) statusSub.textContent = '';
    var statusDot = document.getElementById('alertStatusDot');
    if (statusDot) statusDot.style.background = 'var(--muted-2,#4E5768)';

    // Сбрасываем плейсхолдеры вкладки «Монитор» в исходное состояние,
    // чтобы не висели старые «загрузка…» / stale-данные с прошлой сессии.
    var stateEl = document.getElementById('aConfigState');
    if (stateEl) stateEl.innerHTML = '<span style="color:var(--muted-2);">конфиг загружается…</span>';

    modal.classList.add('active');
    _switchTab('channel');
    _loadConfig(panel.id);
    // Сразу подтягиваем текущее значение для live-превью
    _fetchLiveValue();
  }

  function closeAlertModal() {
    var modal = document.getElementById('alertModal');
    if (modal) modal.classList.remove('active');
    _alertConfig = null;
    _alertPanel = null;
    _alertDashboard = null;
  }

  /* ── Переключение вкладок ── */
  function _switchTab(tab) {
    var tabs = document.querySelectorAll('#alertModal .atab');
    var panes = document.querySelectorAll('#alertModal .atab-pane');
    tabs.forEach(function(t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === tab);
    });
    panes.forEach(function(p) {
      p.classList.toggle('active', p.getAttribute('data-pane') === tab);
    });
    if (tab === 'condition') _fetchLiveValue();
    if (tab === 'message')  _updatePreview();
    if (tab === 'monitor') {
      _loadSchedulerStatus();
      _renderConfigState();
    }
    if (tab === 'history')  _loadHistory();
  }

  /* ── Live-значение: запрос к /preview-value ── */
  async function _fetchLiveValue() {
    if (!_alertPanel || !_alertDashboard) return;
    var el = document.getElementById('a_liveValue');
    if (el) el.textContent = 'загрузка…';

    try {
      var r = await fetch(API + '/alerts/' + encodeURIComponent(_alertPanel.id) + '/preview-value', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ dashboard_id: _alertDashboard.id })
      });
      if (!r.ok) {
        if (el) el.textContent = '—';
        return;
      }
      var data = await r.json();
      if (data.value === null || data.value === undefined) {
        if (el) el.textContent = (data.error ? 'ошибка: ' + data.error : 'нет данных');
        _liveValueCache = null;
      } else {
        if (el) el.textContent = String(data.value) + (data.aggMode ? ' (' + data.aggMode + ')' : '');
        _liveValueCache = data.value;
      }
      _updatePreview();
    } catch (err) {
      if (el) el.textContent = '—';
    }
  }

  /* ── Загрузить конфиг с сервера ── */
  async function _loadConfig(panelId) {
    _configLoadState = 'loading';
    _configLoadError = '';

    try {
      var r = await fetch(API + '/alerts/' + encodeURIComponent(panelId), {
        headers: authHeaders()
      });
      if (r.status === 404) {
        _alertConfig = null;
        _configLoadState = 'missing';
        _fillFormDefaults();
        _updateToggleVisual();
        _renderConfigState();
        return;
      }
      if (r.status === 401) { clearSession(); closeAlertModal(); return; }
      if (!r.ok) {
        var e = await r.json().catch(function() { return {}; });
        _configLoadState = 'error';
        _configLoadError = e.error || ('http_' + r.status);
        _renderConfigState();
        return;
      }
      var data = await r.json();
      _alertConfig = data.config;
      _configLoadState = 'loaded';
      _fillForm(data.config);

      // Если пользователь уже открыл вкладку «Монитор» пока грузился конфиг —
      // обновим её, чтобы «конфиг загружается…» сменилось на реальные данные.
      var monitorPane = document.querySelector('#alertModal .atab-pane[data-pane="monitor"]');
      if (monitorPane && monitorPane.classList.contains('active')) {
        _renderConfigState();
      }

      // Загружаем реальный токен (отдельный endpoint)
      _loadToken(panelId);
    } catch (err) {
      _configLoadState = 'error';
      _configLoadError = 'network';
      _updateToggleVisual();
      // Покажем ошибку и в мониторе, если он активен
      var monitorPane2 = document.querySelector('#alertModal .atab-pane[data-pane="monitor"]');
      if (monitorPane2 && monitorPane2.classList.contains('active')) {
        _renderConfigState();
      }
    }

    _loadHistory();
  }

  /* ── Загрузить токен в открытом виде ── */
  async function _loadToken(panelId) {
    try {
      var r = await fetch(API + '/alerts/' + encodeURIComponent(panelId) + '/token', {
        headers: authHeaders()
      });
      if (!r.ok) return;
      var data = await r.json();
      var botInput = document.getElementById('a_botToken');
      if (botInput && data.bot_token) {
        botInput.value = data.bot_token;
        botInput.setAttribute('data-loaded', 'true');
      }
    } catch (_) {}
  }

  /* ── Заполнить форму из конфига ── */
  function _fillForm(cfg) {
    var $ = function(id) { return document.getElementById(id); };
    var firstChannel = (cfg.channels && cfg.channels[0]) || {};
    $('a_botToken').value      = '';  // заполнится через _loadToken()
    $('a_chatId').value        = firstChannel.chat_id || '';
    $('a_parseMode').value     = firstChannel.parse_mode || 'HTML';
    $('a_condition').value     = cfg.condition || 'gt';
    $('a_threshold').value     = cfg.threshold !== null && cfg.threshold !== undefined ? cfg.threshold : '';
    $('a_thresholdMin').value  = cfg.threshold_min !== null && cfg.threshold_min !== undefined ? cfg.threshold_min : '';
    $('a_thresholdMax').value  = cfg.threshold_max !== null && cfg.threshold_max !== undefined ? cfg.threshold_max : '';
    $('a_checkInterval').value = cfg.check_interval_sec || 60;
    $('a_cooldown').value      = cfg.cooldown_min !== undefined ? cfg.cooldown_min : 30;
    $('a_isActive').checked    = !!cfg.is_active;
    $('a_message').value       = cfg.message_template || '';

    _onConditionChange();
    _updatePreview();
    _updateToggleVisual();
  }

  function _fillFormDefaults() {
    var $ = function(id) { return document.getElementById(id); };
    $('a_botToken').value      = '';
    $('a_chatId').value        = '';
    $('a_parseMode').value     = 'HTML';
    $('a_condition').value     = 'gt';
    $('a_threshold').value     = '';
    $('a_thresholdMin').value  = '';
    $('a_thresholdMax').value  = '';
    $('a_checkInterval').value = '60';
    $('a_cooldown').value      = '30';
    $('a_isActive').checked    = false;
    $('a_message').value       = '';
    _onConditionChange();
    _updatePreview();
    _updateToggleVisual();
  }

  /* ── Обновить визуал toggle вкл/выкл ── */
  function _updateToggleVisual() {
    var cb = document.getElementById('a_isActive');
    if (!cb) return;
    var track = cb.parentElement.querySelector('.alert-toggle-track');
    var knob = cb.parentElement.querySelector('.alert-toggle-knob');
    var statusDot = document.getElementById('alertStatusDot');
    var statusText = document.getElementById('alertStatusText');
    var statusSub = document.getElementById('alertStatusSub');

    if (cb.checked) {
      if (track) track.style.background = 'var(--teal,#4DECC7)';
      if (knob) knob.style.transform = 'translateX(22px)';
      if (statusDot) statusDot.style.background = 'var(--teal,#4DECC7)';
      if (statusText) statusText.textContent = 'Уведомление включено';
      if (statusSub) statusSub.textContent = 'Проверка по расписанию, отправка при срабатывании';
    } else {
      if (track) track.style.background = 'var(--muted-2,#4E5768)';
      if (knob) knob.style.transform = 'translateX(0)';
      if (statusDot) statusDot.style.background = 'var(--muted-2,#4E5768)';
      if (statusText) statusText.textContent = 'Уведомление выключено';
      if (statusSub) statusSub.textContent = 'Настройте параметры и включите';
    }
  }

  /* ── Показ/скрытие полей в зависимости от условия ── */
  function _onConditionChange() {
    var cond = (document.getElementById('a_condition') || {}).value;
    var thresholdWrap = document.getElementById('a_thresholdWrap');
    var rangeWrap = document.getElementById('a_rangeWrap');
    if (cond === 'outside_range') {
      if (thresholdWrap) thresholdWrap.style.display = 'none';
      if (rangeWrap) rangeWrap.style.display = '';
    } else {
      if (thresholdWrap) thresholdWrap.style.display = '';
      if (rangeWrap) rangeWrap.style.display = 'none';
    }
    _updatePreview();
  }

  /* ── Предпросмотр сообщения (на вкладке «Сообщение») ── */
  function _updatePreview() {
    var el = document.getElementById('aPreview');
    if (!el) return;
    var tmplEl = document.getElementById('a_message');
    var tmpl = tmplEl ? tmplEl.value : '';
    if (!tmpl) {
      // Дефолтный шаблон
      el.textContent = '🚨 ' + (_alertPanel && _alertPanel.title ? _alertPanel.title : 'KPI-алерт') +
        '\n\nТекущее значение: ' + (_liveValueCache !== null ? _liveValueCache : '?') +
        '\nУсловие: ' + ((document.getElementById('a_condition') || {}).value || 'gt') + ' ' +
        ((document.getElementById('a_threshold') || {}).value || '?') +
        '\nДашборд: ' + (_alertDashboard ? _alertDashboard.id : '?');
      return;
    }
    var ctx = {
      value: _liveValueCache !== null ? _liveValueCache : '?',
      threshold: (document.getElementById('a_threshold') || {}).value || '?',
      threshold_min: (document.getElementById('a_thresholdMin') || {}).value || '?',
      threshold_max: (document.getElementById('a_thresholdMax') || {}).value || '?',
      condition: (document.getElementById('a_condition') || {}).value || 'gt',
      title: _alertPanel ? (_alertPanel.title || 'KPI-алерт') : 'KPI-алерт',
      panel_id: _alertPanel ? _alertPanel.id : '',
      dashboard_id: _alertDashboard ? _alertDashboard.id : '',
      src: _alertPanel ? (_alertPanel.src || '') : '',
      agg: _alertPanel ? (_alertPanel.agg || '') : '',
      range: _alertPanel ? (_alertPanel.range || '') : '',
      type: _alertPanel ? (_alertPanel.type || '') : '',
    };
    el.textContent = tmpl.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, function(m, key) {
      return ctx[key] === undefined || ctx[key] === null ? '' : String(ctx[key]);
    });
  }

  /* ── Собрать тело запроса из формы ── */
  function _readForm() {
    var $ = function(id) { return document.getElementById(id); };
    var body = {
      dashboard_id: _alertDashboard ? _alertDashboard.id : '',
      is_active: $('a_isActive').checked,
      condition: $('a_condition').value,
      threshold: Number($('a_threshold').value),
      threshold_min: Number($('a_thresholdMin').value),
      threshold_max: Number($('a_thresholdMax').value),
      check_interval_sec: Number($('a_checkInterval').value) || 60,
      cooldown_min: Number($('a_cooldown').value) || 30,
      message_template: $('a_message').value,
    };
    var botToken = $('a_botToken').value.trim();
    var chatId = $('a_chatId').value.trim();
    var parseMode = $('a_parseMode').value;
    var ch = { type: 'telegram', chat_id: chatId, parse_mode: parseMode };
    if (botToken) ch.bot_token = botToken;
    body.channels = [ch];
    return body;
  }

  /* ── Сохранить ── */
  async function _saveConfig() {
    var body = _readForm();
    if (!body.dashboard_id) { toast('Нет активного дашборда'); return; }
    if (!body.channels[0].chat_id) { toast('Укажите Chat ID'); return; }
    if (body.condition === 'outside_range') {
      if (isNaN(body.threshold_min) || isNaN(body.threshold_max)) {
        toast('Укажите минимум и максимум для диапазона'); return;
      }
    } else {
      if (isNaN(body.threshold)) { toast('Укажите пороговое значение'); return; }
    }
    if (!_alertConfig && !body.channels[0].bot_token) {
      toast('Укажите Bot Token (при создании)'); return;
    }

    var btn = document.getElementById('aBtnSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Сохранение…'; }

    try {
      var r = await fetch(API + '/alerts/' + encodeURIComponent(_alertPanel.id), {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify(body)
      });
      if (r.status === 401) { clearSession(); closeAlertModal(); return; }
      if (!r.ok) {
        var e = await r.json().catch(function() { return {}; });
        toast('Ошибка: ' + (e.error || r.status));
        return;
      }
      var data = await r.json();
      _alertConfig = data.config;
      _fillForm(data.config);
      _updateToggleVisual();
      toast('Настройки сохранены ✓');
    } catch (err) {
      toast('Сеть недоступна');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
    }
  }

  /* ── Тестовая отправка ── */
  async function _sendTest() {
    if (!_alertConfig) { toast('Сначала сохраните конфиг'); return; }

    var btn = document.getElementById('aBtnSave'); // используем кнопку «Сохранить» как индикатор занятости
    if (btn) { btn.disabled = true; }

    _showLiveLog('🚀 Запуск тестовой отправки…');

    try {
      var r = await fetch(API + '/alerts/' + encodeURIComponent(_alertPanel.id) + '/test', {
        method: 'POST',
        headers: authHeaders()
      });
      if (r.status === 401) { clearSession(); closeAlertModal(); return; }
      if (r.status === 429) {
        _appendLiveLog('⏳ Подождите 5 минут перед следующим тестом', 'warn');
        toast('Подождите 5 минут перед следующим тестом');
        if (btn) { btn.disabled = false; }
        return;
      }
      if (!r.ok) {
        var e = await r.json().catch(function() { return {}; });
        _appendLiveLog('❌ Ошибка: ' + (e.error || r.status), 'error');
        toast('Ошибка: ' + (e.error || r.status));
        if (btn) { btn.disabled = false; }
        return;
      }
      var data = await r.json();
      _appendLiveLog('✅ Запущено (historyId: ' + data.historyId + ', value=' + data.value + ')', 'ok');
      toast('Тестовое сообщение генерируется… (id: ' + data.historyId + ')');

      _pollHistoryWithPhases(data.historyId, btn);
    } catch (err) {
      _appendLiveLog('❌ Сеть недоступна', 'error');
      toast('Сеть недоступна');
      if (btn) { btn.disabled = false; }
    }
  }

  /* ── Живой лог ── */
  function _showLiveLog(initialMsg) {
    var section = document.getElementById('aLiveLogSection');
    var log = document.getElementById('aLiveLog');
    if (section) section.style.display = '';
    if (log) log.innerHTML = '';
    if (initialMsg) _appendLiveLog(initialMsg);
    _switchTab('test');
  }

  function _appendLiveLog(msg, type) {
    var log = document.getElementById('aLiveLog');
    if (!log) return;
    var color = 'var(--muted-2)';
    if (type === 'ok') color = 'var(--green,#4CAF50)';
    else if (type === 'error') color = 'var(--red,#FF6B6B)';
    else if (type === 'warn') color = 'var(--yellow,#FFD93D)';
    else if (type === 'phase') color = 'var(--teal,#2DD4BF)';

    var time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    log.innerHTML += '<div style="color:' + color + ';">[' + time + '] ' + escapeHtml(msg) + '</div>';
    log.scrollTop = log.scrollHeight;
  }

  /* ── Поллинг с фазами ── */
  function _pollHistoryWithPhases(historyId, btn) {
    var attempts = 0;
    var maxAttempts = 60; // ~3 мин при 3 сек
    var lastPhaseCount = 0;

    var timer = setInterval(async function() {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(timer);
        _appendLiveLog('⏰ Таймаут — проверьте историю', 'warn');
        if (btn) { btn.disabled = false; }
        _loadHistory();
        return;
      }
      try {
        var r = await fetch(API + '/alerts/' + encodeURIComponent(_alertPanel.id) + '/history/' + historyId, {
          headers: authHeaders()
        });
        if (!r.ok) return;
        var data = await r.json();

        if (data.phases && data.phases.length > lastPhaseCount) {
          for (var i = lastPhaseCount; i < data.phases.length; i++) {
            var ph = data.phases[i];
            var icon = _phaseIcon(ph.phase);
            _appendLiveLog(icon + ' ' + ph.phase + (ph.detail ? ': ' + ph.detail : ''), 'phase');
          }
          lastPhaseCount = data.phases.length;
        }

        if (data.status === 'sent') {
          clearInterval(timer);
          var dur = data.duration_ms ? (data.duration_ms > 1000 ? Math.round(data.duration_ms / 1000) + ' сек' : data.duration_ms + ' мс') : '';
          _appendLiveLog('🎉 Готово!' + (dur ? ' (' + dur + ')' : ''), 'ok');
          if (btn) { btn.disabled = false; }
          _loadHistory();
        } else if (data.status === 'error') {
          clearInterval(timer);
          _appendLiveLog('❌ Ошибка: ' + (data.error_message || 'неизвестно'), 'error');
          if (btn) { btn.disabled = false; }
          _loadHistory();
        }
      } catch (_) {}
    }, 3000);
  }

  function _phaseIcon(phase) {
    if (phase === 'value_computed') return '🔢';
    if (phase === 'telegram_post') return '📡';
    if (phase === 'telegram_ok') return '✅';
    if (phase === 'telegram_error') return '⚠️';
    if (phase === 'channel_send') return '📡';
    if (phase === 'channel_ok') return '✅';
    if (phase === 'channel_error') return '⚠️';
    if (phase === 'skip_unknown_channel') return '⏭';
    if (phase === 'done') return '🎉';
    if (phase === 'error') return '❌';
    return '•';
  }

  /* ── История срабатываний ── */
  async function _loadHistory() {
    if (!_alertPanel) return;
    var container = document.getElementById('aHistoryBody');
    if (!container) return;
    container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">загрузка…</div>';

    try {
      var r = await fetch(API + '/alerts/' + encodeURIComponent(_alertPanel.id) + '/history', {
        headers: authHeaders()
      });
      if (!r.ok) { container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">нет данных</div>'; return; }
      var data = await r.json();
      if (!data.history || !data.history.length) {
        container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">история пуста</div>';
        return;
      }

      var html = '<table style="width:100%;border-collapse:collapse;font-size:11px;"><thead><tr>' +
        '<th style="text-align:left;padding:4px 6px;">Дата</th>' +
        '<th style="text-align:left;padding:4px 6px;">Тип</th>' +
        '<th style="text-align:left;padding:4px 6px;">Статус</th>' +
        '<th style="text-align:left;padding:4px 6px;">Значение</th>' +
        '<th style="text-align:left;padding:4px 6px;">Ошибка</th>' +
        '</tr></thead><tbody>';
      data.history.forEach(function(h) {
        var dt = h.fired_at ? new Date(h.fired_at).toLocaleString('ru-RU') : '—';
        var statusIcon = h.status === 'sent' ? '✅'
          : (h.status === 'error' ? '❌'
          : (h.status === 'skipped_cooldown' ? '⏸'
          : (h.status === 'working' ? '⏳' : '•')));
        var statusText = h.status === 'sent' ? 'отправлено'
          : (h.status === 'error' ? 'ошибка'
          : (h.status === 'skipped_cooldown' ? 'cooldown'
          : h.status));
        var valStr = (h.value !== null && h.value !== undefined) ? h.value : '—';
        var errStr = h.error_message
          ? '<span style="color:var(--red);font-size:10px;" title="' + escapeHtml(h.error_message) + '">' +
            escapeHtml(h.error_message.slice(0, 40)) + '</span>'
          : '';
        html += '<tr style="border-bottom:1px solid var(--border,#1A2130);">' +
          '<td style="padding:4px 6px;white-space:nowrap;">' + escapeHtml(dt) + '</td>' +
          '<td style="padding:4px 6px;">' + escapeHtml(h.trigger_type || '—') + '</td>' +
          '<td style="padding:4px 6px;">' + statusIcon + ' ' + statusText + '</td>' +
          '<td style="padding:4px 6px;font-family:var(--mono);">' + valStr + '</td>' +
          '<td style="padding:4px 6px;">' + errStr + '</td>' +
          '</tr>';
      });
      html += '</tbody></table>';
      container.innerHTML = html;
    } catch (_) {
      container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">ошибка загрузки</div>';
    }
  }

  /* ── Статус планировщика (heartbeat) ── */
  async function _loadSchedulerStatus() {
    var el = document.getElementById('aHeartbeat');
    if (!el) return;
    el.innerHTML = '<span style="color:var(--muted-2);">загрузка…</span>';

    try {
      var r = await fetch(API + '/alerts/scheduler-status', {
        headers: authHeaders()
      });
      if (!r.ok) { el.innerHTML = '<span style="color:var(--red);">ошибка</span>'; return; }
      var data = await r.json();

      var ageStr = '—';
      var ageColor = 'var(--muted-2)';
      if (data.lastCheckAgeMs !== null && data.lastCheckAgeMs !== undefined) {
        if (data.lastCheckAgeMs < 120000) {
          ageStr = Math.round(data.lastCheckAgeMs / 1000) + ' сек назад';
          ageColor = 'var(--green,#4CAF50)';
        } else if (data.lastCheckAgeMs < 600000) {
          ageStr = Math.round(data.lastCheckAgeMs / 60000) + ' мин назад';
          ageColor = 'var(--yellow,#FFD93D)';
        } else {
          ageStr = Math.round(data.lastCheckAgeMs / 60000) + ' мин назад ⚠️';
          ageColor = 'var(--red,#FF6B6B)';
        }
      }

      // Self-healthcheck индикатор
      var healthcheckHtml = '';
      if (data.selfHealthcheckOk === false) {
        healthcheckHtml = '<div style="margin-bottom:6px;padding:4px 8px;background:rgba(255,107,107,0.15);border:1px solid var(--red,#FF6B6B);border-radius:4px;font-size:11px;color:var(--red,#FF6B6B);">⚠️ ' + escapeHtml(data.selfHealthcheckWarning || 'scheduler degraded') + '</div>';
      }

      // Queue stats
      var queueHtml = '';
      if (data.queue) {
        var q = data.queue;
        queueHtml = '  <span style="color:var(--muted-2);">Очередь:</span> <span>' +
          (q.pending ? '<span style="color:var(--yellow);">⏳' + q.pending + '</span> ' : '') +
          (q.processing ? '<span style="color:var(--teal);">⚡' + q.processing + '</span> ' : '') +
          (q.failed ? '<span style="color:var(--red);">✗' + q.failed + '</span> ' : '') +
          (!q.pending && !q.processing && !q.failed ? '<span style="color:var(--green);">чисто</span>' : '') +
          '</span>';
      }

      var html = healthcheckHtml + [
        '<div style="display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11px;line-height:1.6;">',
        '  <span style="color:var(--muted-2);">Проверка:</span> <span style="color:' + ageColor + ';">' + ageStr + '</span>',
        '  <span style="color:var(--muted-2);">Self-check:</span> <span style="color:' + (data.selfHealthcheckOk !== false ? 'var(--green,#4CAF50)' : 'var(--red,#FF6B6B)') + ';">' + (data.selfHealthcheckOk !== false ? '✓ ok' : '✗ degraded') + '</span>',
        '  <span style="color:var(--muted-2);">Интервал тиков:</span> <span>' + (data.checkIntervalMs / 1000) + ' сек</span>',
        '  <span style="color:var(--muted-2);">Активных правил:</span> <span>' + data.activeConfigs + '</span>',
        '  <span style="color:var(--muted-2);">Параллельных отправок:</span> <span>' + (data.activeDispatches || 0) + ' / 3</span>',
        '  <span style="color:var(--muted-2);">Активных вычислений:</span> <span>' + (data.activeEvals || 0) + ' / 4</span>',
        '  <span style="color:var(--muted-2);">Отправлено (1ч):</span> <span style="color:var(--green,#4CAF50);">' + (data.recentSent1h || 0) + '</span>',
        '  <span style="color:var(--muted-2);">Ошибок (1ч):</span> <span style="color:' + ((data.recentErrors1h || 0) > 0 ? 'var(--red,#FF6B6B)' : 'var(--muted-2)') + ';">' + (data.recentErrors1h || 0) + '</span>',
        queueHtml,
        '</div>'
      ].join('\n');
      el.innerHTML = html;
    } catch (_) {
      el.innerHTML = '<span style="color:var(--red);">сеть недоступна</span>';
    }
  }

  /* ── Состояние текущего конфига (монитор) ── */
  function _renderConfigState() {
    var el = document.getElementById('aConfigState');
    if (!el) return;

    // Различаем состояния загрузки, чтобы не показывать «конфиг загружается…»
    // в случаях, когда конфиг реально отсутствует или произошла ошибка.
    if (_configLoadState === 'loading' && !_alertConfig) {
      el.innerHTML = '<span style="color:var(--muted-2);">конфиг загружается…</span>';
      return;
    }
    if (_configLoadState === 'error' && !_alertConfig) {
      el.innerHTML = '<span style="color:var(--red,#FF6B6B);">ошибка загрузки: ' +
        escapeHtml(_configLoadError || 'unknown') + '</span>';
      return;
    }
    if (!_alertConfig) {
      // _configLoadState === 'missing' или просто конфига нет
      el.innerHTML = '<span style="color:var(--muted-2);">конфиг не создан — заполните форму и сохраните</span>';
      return;
    }
    var c = _alertConfig;
    var isActiveHtml = c.is_active
      ? '<span style="color:var(--green,#4CAF50);">да</span>'
      : '<span style="color:var(--red,#FF6B6B);">нет</span>';

    // FSM-состояние с цветовой индикацией
    var stateColors = {
      'ok': 'var(--green,#4CAF50)',
      'pending': 'var(--yellow,#FFD93D)',
      'firing': 'var(--red,#FF6B6B)',
      'resolved': 'var(--teal,#2DD4BF)'
    };
    var stateEmoji = {
      'ok': '🟢', 'pending': '🟡', 'firing': '🔴', 'resolved': '🔵'
    };
    var fsmState = c.state || 'ok';
    var stateColor = stateColors[fsmState] || 'var(--muted-2)';
    var stateIcon = stateEmoji[fsmState] || '⚪';

    // Severity badge
    var sevColors = {
      'info': 'var(--teal,#2DD4BF)',
      'warning': 'var(--yellow,#FFD93D)',
      'critical': 'var(--red,#FF6B6B)'
    };
    var sevColor = sevColors[c.severity] || 'var(--muted-2)';

    var html = [
      '<div style="display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11px;line-height:1.6;">',
      '  <span style="color:var(--muted-2);">Активен:</span> <span>' + isActiveHtml + '</span>',
      '  <span style="color:var(--muted-2);">Состояние:</span> <span style="color:' + stateColor + ';font-weight:600;">' + stateIcon + ' ' + escapeHtml(fsmState) + (c.pending_count > 0 ? ' (pending: ' + c.pending_count + ')' : '') + '</span>',
      '  <span style="color:var(--muted-2);">Важность:</span> <span style="color:' + sevColor + ';">' + escapeHtml(c.severity || 'warning') + '</span>',
      '  <span style="color:var(--muted-2);">Условие:</span> <span style="font-family:var(--mono);">' + escapeHtml(c.condition) + '</span>',
      '  <span style="color:var(--muted-2);">Порог:</span> <span style="font-family:var(--mono);">' + (c.threshold !== null && c.threshold !== undefined ? c.threshold : '—') + '</span>',
      '  <span style="color:var(--muted-2);">Интервал:</span> <span style="font-family:var(--mono);">' + c.check_interval_sec + ' сек</span>',
      '  <span style="color:var(--muted-2);">Cooldown:</span> <span style="font-family:var(--mono);">' + c.cooldown_min + ' мин</span>',
      '  <span style="color:var(--muted-2);">last_value:</span> <span style="font-family:var(--mono);">' + (c.last_value !== null && c.last_value !== undefined ? c.last_value : '—') + '</span>',
      '  <span style="color:var(--muted-2);">last_checked:</span> <span>' + (c.last_checked_at ? c.last_checked_at.replace('T', ' ').slice(0, 19) : 'никогда') + '</span>',
      '  <span style="color:var(--muted-2);">last_fired:</span> <span>' + (c.last_fired_at ? c.last_fired_at.replace('T', ' ').slice(0, 19) : 'никогда') + '</span>',
      '</div>'
    ].join('\n');
    el.innerHTML = html;
  }

  /* ── Инициализация (привязка событий после инъекции HTML) ── */
  function _init() {
    var modal = document.getElementById('alertModal');
    if (!modal) return;

    var closeBtn = document.getElementById('alertCloseBtn');
    if (closeBtn) closeBtn.onclick = closeAlertModal;

    // Клик по overlay — закрыть
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeAlertModal();
    });

    // Вкладки
    modal.querySelectorAll('.atab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        _switchTab(tab.getAttribute('data-tab'));
      });
    });

    // Изменение условия → переключение полей
    var condEl = document.getElementById('a_condition');
    if (condEl) condEl.addEventListener('change', _onConditionChange);

    // Изменение шаблона → обновить preview
    var msgEl = document.getElementById('a_message');
    if (msgEl) msgEl.addEventListener('input', _updatePreview);

    // Глазик для токена
    document.querySelectorAll('#alertModal .eye-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var targetId = btn.getAttribute('data-target');
        var input = document.getElementById(targetId);
        if (!input) return;
        var isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.textContent = isPassword ? '🙈' : '👁';
      });
    });

    // Кнопки
    var saveBtn = document.getElementById('aBtnSave');
    if (saveBtn) saveBtn.addEventListener('click', _saveConfig);

    // Toggle вкл/выкл в шапке
    var toggleCb = document.getElementById('a_isActive');
    if (toggleCb) toggleCb.addEventListener('change', function() {
      _updateToggleVisual();
    });

    // Сброс настроек
    var resetBtn = document.getElementById('aBtnResetConfig');
    if (resetBtn) resetBtn.addEventListener('click', async function() {
      if (!_alertConfig) {
        toast('Настройки ещё не созданы');
        return;
      }
      // Выключаем уведомление (is_active = false) вместо удаления
      try {
        var body = _readForm();
        body.is_active = false;
        var r = await fetch(API + '/alerts/' + encodeURIComponent(_alertPanel.id), {
          method: 'PUT',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
          body: JSON.stringify(body)
        });
        if (r.ok) {
          var data = await r.json();
          _alertConfig = data.config;
          _fillForm(data.config);
          toast('Уведомление выключено');
        }
      } catch (_) {
        toast('Сеть недоступна');
      }
    });

    // Кнопка обновления live-значения
    var refBtn = document.getElementById('aBtnRefreshValue');
    if (refBtn) refBtn.addEventListener('click', _fetchLiveValue);

    // Heartbeat refresh
    var hbBtn = document.getElementById('aBtnRefreshHeartbeat');
    if (hbBtn) hbBtn.addEventListener('click', _loadSchedulerStatus);

    // Кнопка «Тест» на вкладке «Условие» / «Периодичность» (если есть)
    // Прячем отдельную кнопку теста: тест запускается с кнопки «Сохранить» после save,
    // а на вкладке test — нет своей кнопки, открываем её программно через _sendTest.
    // Дополнительно: на вкладке test в самой форме показываем кнопку «Отправить тест».
    // Для UX добавим кнопку в test-pane:
    var testPane = document.querySelector('[data-pane="test"]');
    if (testPane && !document.getElementById('aBtnTestNow')) {
      var btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.id = 'aBtnTestNow';
      btn.textContent = '🚀 Отправить тестовое сообщение';
      btn.style.cssText = 'font-size:13px;';
      btn.addEventListener('click', _sendTest);
      testPane.insertBefore(btn, testPane.firstChild);
    }
  }

  // Экспорт (инициализация — bindEvents — вызывается из alert-ui.js ПОСЛЕ инъекции HTML)
  window.AlertModal = {
    open: openAlertModal,
    close: closeAlertModal,
    bindEvents: _init
  };

})();

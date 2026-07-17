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
  var _thresholds = [];       // массив мульти-порогов

  /* ── Открыть модалку для конкретной панели ── */
  function openAlertsModal(panel, dashboardId) {
    _panel = panel;
    _dashboardId = dashboardId;
    _configId = null;
    _thresholds = [];

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

    // ── Новые поля ──
    $('a_checkMode').value    = cfg.check_mode || 'absolute';
    $('a_groupField').value   = cfg.group_field || '';
    $('a_deltaRange').value   = cfg.delta_range || '1h';
    $('a_anomalyWindow').value = cfg.anomaly_window || 7;
    $('a_onEmpty').value      = cfg.on_empty || 'treat_as_zero';

    // Для delta: min/max_value переиспользуются как min/max_pct
    if (cfg.check_mode === 'delta_pct') {
      $('a_minValueDelta').value = cfg.min_value === null || cfg.min_value === undefined ? '' : cfg.min_value;
      $('a_maxValueDelta').value = cfg.max_value === null || cfg.max_value === undefined ? '' : cfg.max_value;
    }
    if (cfg.check_mode === 'anomaly') {
      $('a_maxValueAnomaly').value = cfg.max_value || 2;
    }

    // Мульти-пороги
    _thresholds = Array.isArray(cfg.thresholds_json) ? cfg.thresholds_json.slice() : [];
    _renderThresholdRows();
    _loadGroupValues();

    _onCheckModeChange();
    _onAggChange();
    _updatePreview();
    _updateGaugeIndicator(cfg.last_value);

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

    // ── Новые поля: дефолты ──
    $('a_checkMode').value    = 'absolute';
    $('a_groupField').value   = (_panel && _panel.field) || '';
    $('a_deltaRange').value   = '1h';
    $('a_anomalyWindow').value = 7;
    $('a_onEmpty').value      = 'treat_as_zero';
    $('a_minValueDelta').value = '';
    $('a_maxValueDelta').value = '';
    $('a_maxValueAnomaly').value = 2;

    _thresholds = [];
    _renderThresholdRows();

    _onCheckModeChange();
    _onAggChange();
    _updatePreview();

    var gaugeEl = document.getElementById('aGaugeIndicator');
    if (gaugeEl) gaugeEl.style.display = 'none';

    var lastVal = document.getElementById('aLastValue');
    if (lastVal) lastVal.textContent = '';

    var delBtn = document.getElementById('aBtnDelete');
    if (delBtn) delBtn.style.display = 'none';
  }

  /* ── Скопировать настройки из панели ── */
  function _copyFromPanel() {
    if (!_panel) return;
    var $ = function(id) { return document.getElementById(id); };
    $('a_label').value     = _panel.title || '';
    $('a_agg').value       = _panel.agg || 'count';
    $('a_aggfield').value  = _panel.aggfield || '';
    $('a_range').value     = _panel.range || '24h';
    $('a_groupField').value = _panel.field || '';
    _onAggChange();
    _loadGroupValues();
    _updatePreview();
    toast('Настройки скопированы из панели');
  }

  /* ── Динамическое переключение полей по check_mode ── */
  function _onCheckModeChange() {
    var mode = document.getElementById('a_checkMode').value;
    var absEl = document.getElementById('a_absoluteThresholds');
    var deltaEl = document.getElementById('a_deltaThresholds');
    var anomalyEl = document.getElementById('a_anomalyThresholds');
    var groupSec = document.getElementById('a_groupSection');

    if (absEl)    absEl.style.display = (mode === 'absolute') ? '' : 'none';
    if (deltaEl)  deltaEl.style.display = (mode === 'delta_pct') ? '' : 'none';
    if (anomalyEl) anomalyEl.style.display = (mode === 'anomaly') ? '' : 'none';

    _updatePreview();
  }

  function _onAggChange() {
    var agg = document.getElementById('a_agg').value;
    var row = document.getElementById('a_aggfieldRow');
    if (row) row.style.display = (agg === 'count') ? 'none' : '';
  }

  /* ── Загрузка значений категории для group_value ── */
  async function _loadGroupValues() {
    var groupField = document.getElementById('a_groupField').value.trim();
    var wrap = document.getElementById('a_groupValueWrap');
    var sel = document.getElementById('a_groupValue');
    if (!groupField || !wrap || !sel) {
      if (wrap) wrap.style.display = 'none';
      return;
    }
    wrap.style.display = '';

    // Заполняем базовый option
    sel.innerHTML = '<option value="">— все —</option>';

    try {
      var panel = {
        type: _panel.type || '',
        range: document.getElementById('a_range').value || '24h',
        filters: Array.isArray(_panel.filters) ? _panel.filters : []
      };
      var qs = new URLSearchParams({ group: 'field:' + groupField });
      if (panel.type) qs.set('type', panel.type);
      if (panel.range === '1h') qs.set('from', new Date(Date.now() - 3600000).toISOString());
      else if (panel.range === '6h') qs.set('from', new Date(Date.now() - 6 * 3600000).toISOString());
      else if (panel.range === '24h') qs.set('from', new Date(Date.now() - 24 * 3600000).toISOString());
      else if (panel.range === '7d') qs.set('from', new Date(Date.now() - 7 * 24 * 3600000).toISOString());
      else if (panel.range === '30d') qs.set('from', new Date(Date.now() - 30 * 24 * 3600000).toISOString());

      var r = await fetch(API + '/s?src=' + encodeURIComponent(getSession().src) + '&' + qs.toString(), {
        headers: authHeaders()
      });
      if (r.ok) {
        var data = await r.json();
        var groups = data.groups || [];
        groups.forEach(function(g) {
          var opt = document.createElement('option');
          opt.value = g.bucket;
          opt.textContent = g.bucket + ' (' + g.value + ')';
          sel.appendChild(opt);
        });
      }
    } catch (_) { /* ignore */ }
  }

  /* ── Превью Telegram-сообщения ── */
  function _updatePreview() {
    var previewEl = document.getElementById('aMessagePreview');
    if (!previewEl) return;

    var mode = document.getElementById('a_checkMode').value;
    var label = document.getElementById('a_label').value.trim() || (_panel ? _panel.title : '') || 'Панель';
    var minV = document.getElementById('a_minValue').value;
    var maxV = document.getElementById('a_maxValue').value;
    var groupField = document.getElementById('a_groupField').value.trim();
    var groupValue = document.getElementById('a_groupValue').value;

    var lines = [];
    var escLabel = escapeHtml(label);

    if (groupField && groupValue) {
      escLabel += ' [' + escapeHtml(groupField) + '=' + escapeHtml(groupValue) + ']';
    }

    if (mode === 'delta_pct') {
      var minDelta = document.getElementById('a_minValueDelta').value;
      var maxDelta = document.getElementById('a_maxValueDelta').value;
      lines.push('⚠️ <b>' + escLabel + '</b> — падение на 25%');
      lines.push('Текущее: <b>75</b> | Было: <b>100</b>');
      lines.push('Порог: ' + (minDelta ? minDelta + '%' : '−∞') + ' … ' + (maxDelta ? '+' + maxDelta + '%' : '+∞'));
    } else if (mode === 'anomaly') {
      var zThresh = document.getElementById('a_maxValueAnomaly').value || '2';
      lines.push('⚠️ <b>' + escLabel + '</b> — аномалия (z=2.5)');
      lines.push('Текущее: <b>150</b> | Среднее: <b>80</b> | σ: <b>28</b>');
      lines.push('Порог z-score: ±' + zThresh);
    } else {
      var dirText = 'ниже минимума';
      lines.push('⚠️ <b>' + escLabel + '</b> вышла за диапазон (' + dirText + ')');
      lines.push('Текущее значение: <b>42</b>');
      var minStr = minV !== '' ? minV : '−∞';
      var maxStr = maxV !== '' ? maxV : '+∞';
      lines.push('Диапазон: ' + minStr + ' … ' + maxStr);
    }

    previewEl.innerHTML = lines.join('\n');
  }

  /* ── Визуальный индикатор: текущее значение vs порог ── */
  function _updateGaugeIndicator(lastValue) {
    var gaugeEl = document.getElementById('aGaugeIndicator');
    if (!gaugeEl) return;

    if (lastValue === null || lastValue === undefined) {
      gaugeEl.style.display = 'none';
      return;
    }

    var mode = document.getElementById('a_checkMode').value;
    if (mode !== 'absolute') { gaugeEl.style.display = 'none'; return; }

    var minV = parseFloat(document.getElementById('a_minValue').value);
    var maxV = parseFloat(document.getElementById('a_maxValue').value);
    if (isNaN(minV) && isNaN(maxV)) { gaugeEl.style.display = 'none'; return; }

    gaugeEl.style.display = '';

    // Определяем шкалу
    var lo = isNaN(minV) ? 0 : minV;
    var hi = isNaN(maxV) ? Math.max(lastValue * 1.5, 100) : maxV;
    if (hi <= lo) hi = lo + 100;

    var range = hi - lo;
    var pct = Math.max(0, Math.min(100, ((lastValue - lo) / range) * 100));

    var bar = document.getElementById('aGaugeBar');
    var minLine = document.getElementById('aGaugeMinLine');
    var maxLine = document.getElementById('aGaugeMaxLine');
    var valLabel = document.getElementById('aGaugeValueLabel');
    var minLabel = document.getElementById('aGaugeMinLabel');
    var maxLabel = document.getElementById('aGaugeMaxLabel');

    if (bar) {
      bar.style.width = pct + '%';
      // Цвет: зелёный если в норме, красный если вне
      var inRange = true;
      if (!isNaN(minV) && lastValue < minV) inRange = false;
      if (!isNaN(maxV) && lastValue > maxV) inRange = false;
      bar.style.background = inRange ? 'var(--teal,#4DECC7)' : 'var(--red,#FF6B6B)';
    }

    if (minLine && !isNaN(minV)) {
      var minPct = ((minV - lo) / range) * 100;
      minLine.style.display = '';
      minLine.style.left = minPct + '%';
    } else if (minLine) {
      minLine.style.display = 'none';
    }

    if (maxLine && !isNaN(maxV)) {
      var maxPct = ((maxV - lo) / range) * 100;
      maxLine.style.display = '';
      maxLine.style.left = maxPct + '%';
    } else if (maxLine) {
      maxLine.style.display = 'none';
    }

    if (valLabel) valLabel.textContent = lastValue;
    if (minLabel) minLabel.textContent = isNaN(minV) ? '−∞' : minV;
    if (maxLabel) maxLabel.textContent = isNaN(maxV) ? '+∞' : maxV;
  }

  /* ── Мульти-пороги: рендер строк ── */
  function _renderThresholdRows() {
    var container = document.getElementById('aThresholdRows');
    if (!container) return;
    container.innerHTML = '';

    _thresholds.forEach(function(t, idx) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px;';

      var severityIcons = { critical: '🔴', warning: '🟡', info: '🔵' };
      var icon = severityIcons[t.severity] || '🟡';

      row.innerHTML =
        '<span>' + icon + '</span>' +
        '<input type="number" step="any" placeholder="от" data-idx="' + idx + '" data-field="min" value="' + (t.min !== null && t.min !== undefined ? t.min : '') + '" style="width:70px;font-size:11px;padding:4px 6px;">' +
        '<span style="color:var(--muted-2);">…</span>' +
        '<input type="number" step="any" placeholder="до" data-idx="' + idx + '" data-field="max" value="' + (t.max !== null && t.max !== undefined ? t.max : '') + '" style="width:70px;font-size:11px;padding:4px 6px;">' +
        '<select data-idx="' + idx + '" data-field="severity" style="font-size:11px;padding:4px 6px;">' +
          '<option value="critical"' + (t.severity === 'critical' ? ' selected' : '') + '>Критич</option>' +
          '<option value="warning"' + (t.severity === 'warning' ? ' selected' : '') + '>Важно</option>' +
          '<option value="info"' + (t.severity === 'info' ? ' selected' : '') + '>Инфо</option>' +
        '</select>' +
        '<button type="button" class="btn btn-ghost" data-idx="' + idx + '" data-action="remove" style="font-size:11px;padding:2px 6px;color:var(--coral,#F2664F);">✕</button>';

      container.appendChild(row);
    });

    // Обработчики
    container.querySelectorAll('input, select').forEach(function(el) {
      el.addEventListener('change', function() {
        var idx = parseInt(el.getAttribute('data-idx'));
        var field = el.getAttribute('data-field');
        if (idx >= 0 && idx < _thresholds.length) {
          if (field === 'min' || field === 'max') {
            _thresholds[idx][field] = el.value === '' ? null : Number(el.value);
          } else {
            _thresholds[idx][field] = el.value;
          }
          _renderThresholdRows();
        }
      });
    });

    container.querySelectorAll('button[data-action="remove"]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(btn.getAttribute('data-idx'));
        _thresholds.splice(idx, 1);
        _renderThresholdRows();
      });
    });
  }

  function _addThreshold() {
    _thresholds.push({ min: null, max: null, severity: 'warning', chat_ids: '' });
    _renderThresholdRows();
  }

  /* ── Собрать body для сохранения (включая новые поля) ── */
  function _collectBody() {
    var $ = function(id) { return document.getElementById(id).value; };
    var mode = $('a_checkMode');
    var minRaw, maxRaw;

    if (mode === 'delta_pct') {
      minRaw = $('a_minValueDelta').trim();
      maxRaw = $('a_maxValueDelta').trim();
    } else if (mode === 'anomaly') {
      minRaw = '';
      maxRaw = $('a_maxValueAnomaly').trim();
    } else {
      minRaw = $('a_minValue').trim();
      maxRaw = $('a_maxValue').trim();
    }

    return {
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
      // ── Новые поля ──
      check_mode: mode,
      group_field: $('a_groupField').trim(),
      group_value: $('a_groupValue').trim(),
      delta_range: $('a_deltaRange'),
      anomaly_window: Math.max(2, Math.min(30, Number($('a_anomalyWindow')) || 7)),
      on_empty: $('a_onEmpty'),
      thresholds_json: _thresholds,
    };
  }

  /* ── Сохранить правило ── */
  async function _saveConfig() {
    var body = _collectBody();
    var mode = body.check_mode;

    // Валидация
    if (mode === 'absolute' && body.min_value === null && body.max_value === null) {
      toast('Укажите минимум, максимум или оба значения'); return;
    }
    if (mode === 'delta_pct' && body.min_value === null && body.max_value === null) {
      toast('Укажите порог падения или роста'); return;
    }
    if (mode === 'anomaly' && (body.max_value === null || body.max_value <= 0)) {
      toast('Укажите порог z-score (больше 0)'); return;
    }

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

    // ── Новые обработчики ──
    var checkModeSel = document.getElementById('a_checkMode');
    if (checkModeSel) checkModeSel.addEventListener('change', _onCheckModeChange);

    var copyBtn = document.getElementById('aBtnCopyFromPanel');
    if (copyBtn) copyBtn.addEventListener('click', _copyFromPanel);

    var addThresholdBtn = document.getElementById('aBtnAddThreshold');
    if (addThresholdBtn) addThresholdBtn.addEventListener('click', _addThreshold);

    var groupFieldInput = document.getElementById('a_groupField');
    if (groupFieldInput) {
      groupFieldInput.addEventListener('change', _loadGroupValues);
      groupFieldInput.addEventListener('blur', _loadGroupValues);
    }

    // Обновляем превью при изменении полей
    ['a_label', 'a_minValue', 'a_maxValue', 'a_minValueDelta', 'a_maxValueDelta', 'a_maxValueAnomaly', 'a_checkMode', 'a_groupField', 'a_groupValue'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', _updatePreview);
        el.addEventListener('change', function() {
          _updatePreview();
          // Обновить gauge
          var body = _collectBody();
          _updateGaugeIndicator(null); // скрыть gauge при изменении порогов
        });
      }
    });

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

  /* ── Утилиты ── */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  window.AlertsModal = {
    open: openAlertsModal,
    close: closeAlertsModal,
    bindEvents: _init
  };

})();

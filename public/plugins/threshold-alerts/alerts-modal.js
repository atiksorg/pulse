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
  var _formulaAliases = [];   // массив метрик-алиасов для формулы [{name,agg,aggfield,label,range}]

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

    // Формула: загрузить условия и текст
    if (cfg.check_mode === 'formula') {
      var conds = Array.isArray(cfg.formula_conditions) ? cfg.formula_conditions : (typeof cfg.formula_conditions === 'string' ? (function(){ try { return JSON.parse(cfg.formula_conditions); } catch(_){ return []; } })() : []);
      _formulaAliases = [];
      if (Array.isArray(conds)) {
        conds.forEach(function(c) {
          if (c.left_metric && c.left_metric.name) {
            _formulaAliases.push({
              name: c.left_metric.name,
              label: '',
              agg: c.left_metric.agg || 'count',
              aggfield: c.left_metric.aggfield || '',
              range: c.left_metric.range || cfg.panel_range || '24h',
            });
          }
        });
      }
      if (_formulaAliases.length === 0) _addFormulaAlias();
      _renderMetricRows();
      var ft = document.getElementById('a_formulaText');
      if (ft && cfg.formula_text) ft.value = cfg.formula_text;
      _syncFormulaFromText();
      _validateFormulaText();
    }

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

    _formulaAliases = [];
    var fmContainer = document.getElementById('aFormulaMetricRows');
    if (fmContainer) fmContainer.innerHTML = '';
    var ftEl = document.getElementById('a_formulaText');
    if (ftEl) ftEl.value = '';
    var fmTags = document.getElementById('aFormulaTags');
    if (fmTags) fmTags.innerHTML = '';
    var fmValid = document.getElementById('a_formulaValidation');
    if (fmValid) fmValid.innerHTML = '';
    var fmTestRes = document.getElementById('aFormulaTestResult');
    if (fmTestRes) fmTestRes.innerHTML = '';

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
    var formulaEl = document.getElementById('a_formulaSection');
    var groupSec = document.getElementById('a_groupSection');

    if (absEl)    absEl.style.display = (mode === 'absolute') ? '' : 'none';
    if (deltaEl)  deltaEl.style.display = (mode === 'delta_pct') ? '' : 'none';
    if (anomalyEl) anomalyEl.style.display = (mode === 'anomaly') ? '' : 'none';
    if (formulaEl) formulaEl.style.display = (mode === 'formula') ? '' : 'none';

    if (mode === 'formula' && _formulaAliases.length === 0) {
      _addFormulaAlias(); // Добавить первую метрику по умолчанию
    }

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

    if (mode === 'formula') {
      var ft = document.getElementById('a_formulaText');
      var formula = ft ? ft.value.trim() : '';
      lines.push('⚠️ <b>' + escLabel + '</b> — формула сработала');
      lines.push('Результат: <b>1</b>');
      if (formula) lines.push('Формула: <code>' + escapeHtml(formula).replace(/\{([^}]+)\}/g, '<span style="color:var(--teal);">{$1}</span>') + '</code>');
      var metricParts = _formulaAliases.map(function(m) { return m.name + '=42'; });
      if (metricParts.length) lines.push('Метрики: ' + metricParts.join(' | '));
    } else if (mode === 'delta_pct') {
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

  /* ═══════════════════════════════════════════════════
     Formula Mode: Визуальный конструктор + текстовая формула
     ═══════════════════════════════════════════════════ */

  var _FM_TEMPLATES = {
    error_rate: '{errors} / {total} * 100 > {threshold}',
    conversion: '{purchases} / {visits} * 100 > {threshold}',
    ratio: '{metric_a} / {metric_b} > 1',
    compound: '{count} > 100 AND {avg_value} < 10',
  };

  function _addFormulaAlias() {
    var num = _formulaAliases.length + 1;
    var defaultAgg = _panel ? (_panel.agg || 'count') : 'count';
    var defaultField = _panel ? (_panel.aggfield || _panel.field || '') : '';
    _formulaAliases.push({
      name: 'metric_' + num,
      label: '',
      agg: defaultAgg,
      aggfield: defaultField,
      range: (_panel ? _panel.range : '') || '24h',
    });
    _renderMetricRows();
  }

  function _removeFormulaAlias(idx) {
    _formulaAliases.splice(idx, 1);
    _renderMetricRows();
    _updatePreview();
  }

  function _renderMetricRows() {
    var container = document.getElementById('aFormulaMetricRows');
    if (!container) return;
    container.innerHTML = '';

    _formulaAliases.forEach(function(m, idx) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';

      row.innerHTML =
        '<span style="color:var(--teal,#4DECC7);font-size:11px;font-family:var(--mono);">{</span>' +
        '<input type="text" class="a-fm-alias-name" data-idx="' + idx + '" value="' + _escAttr(m.name) + '" style="width:80px;font-size:11px;padding:4px 6px;font-family:var(--mono);background:var(--input-bg,#0D1117);color:var(--teal,#4DECC7);border:1px solid rgba(77,236,199,0.25);border-radius:4px;" placeholder="имя">' +
        '<span style="color:var(--teal,#4DECC7);font-size:11px;font-family:var(--mono);">}</span>' +
        '<span style="color:var(--muted-2);font-size:11px;">=</span>' +
        '<select class="a-mi-sel a-fm-alias-agg" data-idx="' + idx + '">' +
          '<option value="count"' + (m.agg === 'count' ? ' selected' : '') + '>count</option>' +
          '<option value="sum"' + (m.agg === 'sum' ? ' selected' : '') + '>sum</option>' +
          '<option value="avg"' + (m.agg === 'avg' ? ' selected' : '') + '>avg</option>' +
          '<option value="max"' + (m.agg === 'max' ? ' selected' : '') + '>max</option>' +
          '<option value="min"' + (m.agg === 'min' ? ' selected' : '') + '>min</option>' +
        '</select>' +
        '<input type="text" class="a-fm-alias-field" data-idx="' + idx + '" value="' + _escAttr(m.aggfield) + '" placeholder="поле" style="width:70px;font-size:11px;padding:4px 6px;">' +
        '<select class="a-mi-sel a-fm-alias-range" data-idx="' + idx + '">' +
          '<option value="1h"' + (m.range === '1h' ? ' selected' : '') + '>1ч</option>' +
          '<option value="6h"' + (m.range === '6h' ? ' selected' : '') + '>6ч</option>' +
          '<option value="24h"' + (m.range === '24h' ? ' selected' : '') + '>24ч</option>' +
          '<option value="7d"' + (m.range === '7d' ? ' selected' : '') + '>7д</option>' +
          '<option value="30d"' + (m.range === '30d' ? ' selected' : '') + '>30д</option>' +
        '</select>' +
        '<button type="button" class="a-mi-del" data-idx="' + idx + '" data-action="del-metric" title="Удалить">✕</button>';

      container.appendChild(row);
    });

    // Обработчики
    container.querySelectorAll('.a-fm-alias-name, .a-fm-alias-field').forEach(function(el) {
      el.addEventListener('change', function() {
        var idx = parseInt(el.getAttribute('data-idx'));
        if (idx >= 0 && idx < _formulaAliases.length) {
          if (el.classList.contains('a-fm-alias-name')) {
            _formulaAliases[idx].name = el.value.trim().replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
            if (el.value !== _formulaAliases[idx].name) el.value = _formulaAliases[idx].name;
          } else {
            _formulaAliases[idx].aggfield = el.value.trim().slice(0, 64);
          }
        }
      });
    });

    container.querySelectorAll('.a-fm-alias-agg, .a-fm-alias-range').forEach(function(el) {
      el.addEventListener('change', function() {
        var idx = parseInt(el.getAttribute('data-idx'));
        if (idx >= 0 && idx < _formulaAliases.length) {
          if (el.classList.contains('a-fm-alias-agg')) _formulaAliases[idx].agg = el.value;
          else _formulaAliases[idx].range = el.value;
        }
      });
    });

    container.querySelectorAll('[data-action="del-metric"]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        _removeFormulaAlias(parseInt(btn.getAttribute('data-idx')));
      });
    });
  }

  /* ── Tags (quick operator insert) ── */
  function _addFormulaTag(type, value) {
    var ft = document.getElementById('a_formulaText');
    if (!ft) return;
    var ins = '';
    if (type === 'metric') {
      var m = _formulaAliases.find(function(a) { return a.name === value; });
      ins = '{' + value + '}';
    } else if (type === 'op') {
      ins = ' ' + value + ' ';
    } else if (type === 'num') {
      ins = String(value);
    } else if (type === 'paren') {
      ins = value;
    }
    var pos = ft.selectionStart || ft.value.length;
    ft.value = ft.value.slice(0, pos) + ins + ft.value.slice(pos);
    ft.focus();
    ft.selectionStart = ft.selectionEnd = pos + ins.length;
    _syncFormulaFromText();
    _validateFormulaText();
    _updatePreview();
  }

  /* ── Render tags from formula text ── */
  function _renderFormulaTags() {
    var container = document.getElementById('aFormulaTags');
    if (!container) return;
    container.innerHTML = '';

    var ft = document.getElementById('a_formulaText');
    var text = ft ? ft.value : '';
    if (!text.trim()) {
      container.innerHTML = '<span style="font-size:11px;color:var(--muted-2);">Соберите формулу из блоков или напишите вручную ↓</span>';
      return;
    }

    // Простой токенизатор для отображения
    var re = /(\{[^}]+\})|(\b(?:AND|OR)\b)|(>=|<=|!=|==|[><+\-*/%^])|(\()|(\))|([\d.]+)|(\w+)/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var span = document.createElement('span');
      span.className = 'a-fm-tag';
      if (m[1]) {
        span.className += ' a-fm-tag-metric';
        span.textContent = m[1];
        var aliasName = m[1].slice(1, -1);
        span.setAttribute('data-alias', aliasName);
        span.addEventListener('click', function(e) { _openMetricPicker(e, this.getAttribute('data-alias')); });
      } else if (m[2]) {
        span.className += ' a-fm-tag-op';
        span.textContent = m[2];
      } else if (m[3]) {
        span.className += ' a-fm-tag-op';
        span.textContent = m[3];
      } else if (m[4]) {
        span.className += ' a-fm-tag-paren';
        span.textContent = '(';
      } else if (m[5]) {
        span.className += ' a-fm-tag-paren';
        span.textContent = ')';
      } else if (m[6]) {
        span.className += ' a-fm-tag-num';
        span.textContent = m[6];
      } else if (m[7]) {
        span.className += ' a-fm-tag-op';
        span.textContent = m[7];
      } else continue;
      container.appendChild(span);
    }
  }

  /* ── Inline metric picker ── */
  function _openMetricPicker(e, aliasName) {
    e.stopPropagation();
    var existing = document.querySelector('.a-fm-inline-edit');
    if (existing) existing.remove();

    var idx = _formulaAliases.findIndex(function(a) { return a.name === aliasName; });
    if (idx === -1) return;

    var div = document.createElement('div');
    div.className = 'a-fm-inline-edit';
    div.style.left = e.clientX + 'px';
    div.style.top = (e.clientY + 4) + 'px';

    _formulaAliases.forEach(function(m, i) {
      var opt = document.createElement('button');
      opt.className = 'a-fm-inline-opt';
      opt.textContent = '{' + m.name + '} (' + m.agg + (m.aggfield ? ':' + m.aggfield : '') + ')';
      opt.addEventListener('click', function() {
        _renameAliasInFormula(aliasName, m.name);
        div.remove();
      });
      div.appendChild(opt);
    });

    document.body.appendChild(div);
    setTimeout(function() {
      document.addEventListener('click', function handler() { div.remove(); document.removeEventListener('click', handler); }, { once: true });
    }, 10);
  }

  function _renameAliasInFormula(oldName, newName) {
    var ft = document.getElementById('a_formulaText');
    if (!ft) return;
    ft.value = ft.value.split('{' + oldName + '}').join('{' + newName + '}');
    _syncFormulaFromText();
    _validateFormulaText();
    _updatePreview();
  }

  /* ── Sync formula text to conditions (for preview) ── */
  function _syncFormulaFromText() {
    _renderFormulaTags();
  }

  /* ── Live validation ── */
  function _validateFormulaText() {
    var ft = document.getElementById('a_formulaText');
    var vl = document.getElementById('a_formulaValidation');
    if (!ft || !vl) return;
    var text = ft.value.trim();
    if (!text) { vl.innerHTML = ''; return; }

    // Синтаксическая валидация: проверяем скобки и базовые ошибки
    var depth = 0;
    for (var i = 0; i < text.length; i++) {
      if (text[i] === '(') depth++;
      if (text[i] === ')') depth--;
      if (depth < 0) { vl.innerHTML = '<span style="color:var(--coral,#F2664F);">✗ Лишняя закрывающая скобка на позиции ' + (i+1) + '</span>'; return; }
    }
    if (depth !== 0) { vl.innerHTML = '<span style="color:var(--coral,#F2664F);">✗ Незакрытая скобка</span>'; return; }

    // Проверка: есть ли хотя бы одна переменная
    var vars = text.match(/\{[^}]+\}/g);
    if (!vars || vars.length === 0) { vl.innerHTML = '<span style="color:var(--amber,#FFB74D);">⚠ Нет метрик ({имя})</span>'; return; }

    // Проверка: известные переменные
    var knownNames = _formulaAliases.map(function(a) { return a.name; });
    var unknown = [];
    vars.forEach(function(v) {
      var name = v.slice(1, -1);
      if (knownNames.indexOf(name) === -1 && isNaN(Number(name))) unknown.push(name);
    });
    if (unknown.length) {
      vl.innerHTML = '<span style="color:var(--amber,#FFB74D);">⚠ Неизвестные метрики: ' + unknown.map(function(n){return '{'+n+'}';}).join(', ') + ' (добавьте в «Метрики»)</span>';
      return;
    }

    vl.innerHTML = '<span style="color:var(--teal,#4DECC7);">✓ Синтаксис OK (' + vars.length + ' метрик)</span>';
  }

  /* ── Templates ── */
  function _applyTemplate(tplKey) {
    var tpl = _FM_TEMPLATES[tplKey];
    if (!tpl) return;

    // Автоматически создать метрики-алиасы из шаблона
    var tplAliases = {
      errors: { name: 'errors', agg: 'count', aggfield: '', range: '24h' },
      total: { name: 'total', agg: 'count', aggfield: '', range: '24h' },
      threshold: { name: 'threshold', agg: 'count', aggfield: '', range: '24h' },
      purchases: { name: 'purchases', agg: 'count', aggfield: '', range: '24h' },
      visits: { name: 'visits', agg: 'count', aggfield: '', range: '24h' },
      metric_a: { name: 'metric_a', agg: 'count', aggfield: '', range: '24h' },
      metric_b: { name: 'metric_b', agg: 'count', aggfield: '', range: '24h' },
      count: { name: 'count', agg: 'count', aggfield: '', range: '24h' },
      avg_value: { name: 'avg_value', agg: 'avg', aggfield: 'value', range: '24h' },
    };

    var existingNames = _formulaAliases.map(function(a) { return a.name; });
    var re = /\{([^}]+)\}/g;
    var m;
    while ((m = re.exec(tpl)) !== null) {
      var name = m[1];
      if (existingNames.indexOf(name) === -1 && isNaN(Number(name))) {
        var src = tplAliases[name] || { name: name, agg: 'count', aggfield: '', range: '24h' };
        _formulaAliases.push(Object.assign({}, src));
        existingNames.push(name);
      }
    }

    _renderMetricRows();
    var ft = document.getElementById('a_formulaText');
    if (ft) ft.value = tpl;
    _syncFormulaFromText();
    _validateFormulaText();
    _updatePreview();
    toast('Шаблон применён — настройте имена метрик');
  }

  /* ── Test evaluation ── */
  async function _testFormula() {
    if (!_configId) { toast('Сначала сохраните правило'); return; }
    var btn = document.getElementById('aFormulaTestBtn');
    var resultEl = document.getElementById('aFormulaTestResult');
    if (btn) btn.textContent = '⏳ Считаем…';

    var ft = document.getElementById('a_formulaText');
    var formulaText = ft ? ft.value.trim() : '';
    if (!formulaText) { if (resultEl) resultEl.innerHTML = '<span style="color:var(--coral);">Формула пуста</span>'; if (btn) btn.textContent = '▶ Вычислить'; return; }

    try {
      var r = await fetch(API + '/alerts/config/' + encodeURIComponent(_configId) + '/formula-eval', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ formula_text: formulaText, formula_conditions: _buildFormulaConditions() })
      });
      if (!r.ok) {
        var e = await r.json().catch(function() { return {}; });
        if (resultEl) resultEl.innerHTML = '<span style="color:var(--coral);">✗ ' + (e.detail || e.error || r.status) + '</span>';
        return;
      }
      var data = await r.json();
      if (resultEl) {
        var metrics = data.metrics || {};
        var parts = Object.entries(metrics).map(function(kv) { return '<span style="color:var(--teal);">{' + kv[0] + '}</span>=' + kv[1]; });
        resultEl.innerHTML =
          '<div>Результат: <b style="font-size:14px;color:' + (data.breach ? 'var(--coral,#F2664F)' : 'var(--teal,#4DECC7)') + ';">' + data.result + '</b>' +
          (data.breach ? ' ⚠️ НАРУШЕНИЕ' : ' ✅ В норме') + '</div>' +
          (parts.length ? '<div style="margin-top:3px;color:var(--muted-2);font-size:11px;">' + parts.join(' · ') + '</div>' : '');
      }
    } catch (_) {
      if (resultEl) resultEl.innerHTML = '<span style="color:var(--coral);">Ошибка сети</span>';
    } finally {
      if (btn) btn.textContent = '▶ Вычислить';
    }
  }

  /* ── Build formula_conditions from aliases ── */
  function _buildFormulaConditions() {
    var formulaText = '';
    var ft = document.getElementById('a_formulaText');
    if (ft) formulaText = ft.value.trim();
    if (!formulaText) return [];

    return _formulaAliases.map(function(m) {
      return { left_metric: { type: 'metric', name: m.name, agg: m.agg, aggfield: m.aggfield, range: m.range }, operator: '>', right_metric: null, logic: 'AND' };
    });
  }

  function _escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
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
    } else if (mode === 'formula') {
      minRaw = '';
      maxRaw = '';
    } else {
      minRaw = $('a_minValue').trim();
      maxRaw = $('a_maxValue').trim();
    }

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
      check_mode: mode,
      group_field: $('a_groupField').trim(),
      group_value: $('a_groupValue').trim(),
      delta_range: $('a_deltaRange'),
      anomaly_window: Math.max(2, Math.min(30, Number($('a_anomalyWindow')) || 7)),
      on_empty: $('a_onEmpty'),
      thresholds_json: _thresholds,
    };

    // Formula fields
    if (mode === 'formula') {
      var ft = document.getElementById('a_formulaText');
      body.formula_text = ft ? ft.value.trim() : '';
      body.formula_conditions = _buildFormulaConditions();
    }

    return body;
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
    if (mode === 'formula') {
      if (!body.formula_text) { toast('Укажите формулу'); return; }
      var vars = body.formula_text.match(/\{[^}]+\}/g);
      if (!vars || vars.length === 0) { toast('Формула должна содержать хотя бы одну метрику ({имя})'); return; }
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

    // ── Formula mode handlers ──
    var formulaAddMetric = document.getElementById('aFormulaAddMetric');
    if (formulaAddMetric) formulaAddMetric.addEventListener('click', _addFormulaAlias);

    var formulaText = document.getElementById('a_formulaText');
    if (formulaText) {
      formulaText.addEventListener('input', function() {
        _syncFormulaFromText();
        _validateFormulaText();
        _updatePreview();
      });
      formulaText.addEventListener('change', function() {
        _validateFormulaText();
        _updatePreview();
      });
    }

    document.querySelectorAll('.a-fm-tpl').forEach(function(btn) {
      btn.addEventListener('click', function() { _applyTemplate(btn.getAttribute('data-tpl')); });
    });

    var formulaTestBtn = document.getElementById('aFormulaTestBtn');
    if (formulaTestBtn) formulaTestBtn.addEventListener('click', _testFormula);

    var fmAddOpBtn = document.getElementById('aFmAddOpBtn');
    if (fmAddOpBtn) fmAddOpBtn.addEventListener('click', function() {
      var opSel = document.getElementById('aFmQuickOp');
      var numIn = document.getElementById('aFmQuickNum');
      if (opSel) _addFormulaTag('op', opSel.value);
      if (numIn && numIn.value !== '') _addFormulaTag('num', numIn.value);
    });

    var fmParenBtn = document.getElementById('aFmAddParenBtn');
    if (fmParenBtn) fmParenBtn.addEventListener('click', function() { _addFormulaTag('paren', '('); });

    var fmClearBtn = document.getElementById('aFmClearBtn');
    if (fmClearBtn) fmClearBtn.addEventListener('click', function() {
      var ft = document.getElementById('a_formulaText');
      if (ft) ft.value = '';
      _syncFormulaFromText();
      _validateFormulaText();
      _updatePreview();
    });

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

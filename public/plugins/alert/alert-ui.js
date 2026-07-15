/* ═══════════════════════════════════════════════════
   alert-ui.js — UI для управления алертами (уведомлениями)
   Зависит от: core.js (API, authHeaders, toast, confirmModal, $, getSession)
   ═══════════════════════════════════════════════════ */

(function(){
  'use strict';

  /* ── Глобальный кэш правил ── */
  var _alertRules = [];
  var _alertPollTimers = {};

  /* ── Открыть модалку алерта для конкретной панели ── */
  window.openAlertModal = function openAlertModal(p, src){
    var modal = document.getElementById('alertModal');
    if(!modal){ toast('Модалка алертов не найдена'); return; }

    // Закрываем dropdown
    document.querySelectorAll('.panel-menu-dropdown.show').forEach(function(d){ d.classList.remove('show'); });

    var sess = getSession();
    if(!sess){ toast('Войдите в кабинет для настройки уведомлений'); return; }

    // Заполняем данные
    var titleEl = document.getElementById('alertPanelTitle');
    if(titleEl) titleEl.textContent = p.title || 'Панель';

    // Загружаем существующие правила для этой панели
    _loadAlertRules(p, src, sess);
  };

  /* ── Загрузка правил с сервера ── */
  function _loadAlertRules(p, src, sess){
    var rulesList = document.getElementById('alertRulesList');
    if(rulesList) rulesList.innerHTML = '<div style="color:var(--muted-2);font-family:var(--mono);font-size:12px;padding:12px 0;">загрузка…</div>';

    var db = getActiveDashboard();
    var dashboardId = db ? db.id : '';

    fetch(API + '/api/alerts/rules', { headers: authHeaders() })
      .then(function(r){
        if(r.status === 401){ clearSession(); toast('Сессия истекла'); return []; }
        if(!r.ok) return [];
        return r.json();
      })
      .then(function(allRules){
        // Фильтруем по panel_id
        _alertRules = (allRules || []).filter(function(r){ return r.panel_id === p.id; });
        _renderAlertModal(p, src, sess, dashboardId);
      })
      .catch(function(){
        _alertRules = [];
        _renderAlertModal(p, src, sess, dashboardId);
      });

    // Открываем модалку
    var modal = document.getElementById('alertModal');
    if(modal) modal.classList.add('active');
  }

  /* ── Рендер содержимого модалки ── */
  function _renderAlertModal(p, src, sess, dashboardId){
    var content = document.getElementById('alertContent');
    if(!content) return;

    // Узнаём текущее значение панели
    var bodyEl = document.getElementById('body-' + p.id);
    var currentValue = bodyEl ? bodyEl.getAttribute('data-total') : null;
    var currentValStr = currentValue !== null ? currentValue : '—';

    var esc = escapeHtml;

    var html = '';

    // Текущее значение
    html += '<div class="alert-current-value">';
    html += '  <span class="alert-cv-label">Текущее значение:</span>';
    html += '  <span class="alert-cv-value">' + esc(currentValStr) + '</span>';
    html += '</div>';

    // Список существующих правил
    html += '<div id="alertRulesList">';
    if(!_alertRules.length){
      html += '<div class="alert-empty">Нет настроенных уведомлений для этой панели.</div>';
    } else {
      _alertRules.forEach(function(rule, idx){
        html += _renderRuleCard(rule, idx);
      });
    }
    html += '</div>';

    // Форма добавления/редактирования
    html += '<div class="alert-form" id="alertForm">';
    html += '  <h3 style="margin:0 0 12px;font-size:14px;">' + (_alertRules.length ? 'Добавить правило' : 'Настроить уведомление') + '</h3>';

    // Условие
    html += '  <div class="alert-form-row">';
    html += '    <div class="alert-field"><label>Условие</label>';
    html += '      <select id="alertCondition">';
    html += '        <option value="<">Значение меньше порога (&lt;)</option>';
    html += '        <option value=">">Значение больше порога (&gt;)</option>';
    html += '        <option value="=">Значение равно (=)</option>';
    html += '        <option value="no_data">Нет данных (no_data)</option>';
    html += '      </select>';
    html += '    </div>';
    html += '    <div class="alert-field"><label>Порог</label>';
    html += '      <input id="alertThreshold" type="number" placeholder="например 1000">';
    html += '    </div>';
    html += '  </div>';

    // Интервал и anti-flapping
    html += '  <div class="alert-form-row">';
    html += '    <div class="alert-field"><label>Интервал проверки (сек)</label>';
    html += '      <select id="alertInterval">';
    html += '        <option value="15">15 сек</option>';
    html += '        <option value="30">30 сек</option>';
    html += '        <option value="60" selected>1 мин</option>';
    html += '        <option value="300">5 мин</option>';
    html += '        <option value="900">15 мин</option>';
    html += '        <option value="3600">1 час</option>';
    html += '      </select>';
    html += '    </div>';
    html += '    <div class="alert-field"><label>Проверок до срабатывания (anti-flapping)</label>';
    html += '      <select id="alertPendingChecks">';
    html += '        <option value="1">1 (сразу)</option>';
    html += '        <option value="2">2 подряд</option>';
    html += '        <option value="3" selected>3 подряд</option>';
    html += '        <option value="5">5 подряд</option>';
    html += '      </select>';
    html += '    </div>';
    html += '  </div>';

    // Название
    html += '  <div class="alert-form-row">';
    html += '    <div class="alert-field" style="flex:1;"><label>Название правила</label>';
    html += '      <input id="alertTitle" placeholder="Например: Выручка упала ниже 1000">';
    html += '    </div>';
    html += '  </div>';

    // Каналы доставки
    html += '  <div class="alert-form-row">';
    html += '    <div class="alert-field" style="flex:1;"><label>Канал доставки</label>';
    html += '      <select id="alertChannelType">';
    html += '        <option value="telegram">Telegram</option>';
    html += '        <option value="webhook">Webhook (HTTP)</option>';
    html += '      </select>';
    html += '    </div>';
    html += '  </div>';

    // Telegram-specific fields
    html += '  <div id="alertTelegramFields">';
    html += '    <div class="alert-form-row">';
    html += '      <div class="alert-field" style="flex:1;"><label>Bot Token</label>';
    html += '        <input id="alertBotToken" type="password" placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11">';
    html += '      </div>';
    html += '    </div>';
    html += '    <div class="alert-form-row">';
    html += '      <div class="alert-field" style="flex:1;"><label>Chat ID</label>';
    html += '        <input id="alertChatId" placeholder="например -1001234567890">';
    html += '      </div>';
    html += '    </div>';
    html += '  </div>';

    // Webhook-specific fields
    html += '  <div id="alertWebhookFields" style="display:none;">';
    html += '    <div class="alert-form-row">';
    html += '      <div class="alert-field" style="flex:1;"><label>Webhook URL</label>';
    html += '        <input id="alertWebhookUrl" placeholder="https://example.com/webhook">';
    html += '      </div>';
    html += '    </div>';
    html += '  </div>';

    // Кнопки
    html += '  <div class="alert-form-actions">';
    html += '    <button class="btn btn-primary" id="alertSaveBtn">Сохранить правило</button>';
    html += '    <button class="btn btn-ghost" id="alertTestBtn">Тестовая отправка</button>';
    html += '  </div>';
    html += '</div>';

    // Статус очереди
    html += '<div class="alert-queue-status" id="alertQueueStatus"></div>';

    content.innerHTML = html;

    // Сохраняем данные в data-атрибуты модалки
    var modal = document.getElementById('alertModal');
    if(modal){
      modal._panelData = { p: p, src: src, sess: sess, dashboardId: dashboardId };
    }

    // Привязываем обработчики
    _bindAlertFormHandlers(p, src, sess, dashboardId);
    _loadQueueStatus();
  }

  /* ── Рендер карточки правила ── */
  function _renderRuleCard(rule, idx){
    var esc = escapeHtml;
    var stateColors = { 'OK': '#4DECC7', 'PENDING': '#F2A950', 'FIRING': '#FF6B6B', 'RESOLVED': '#5B8DEF' };
    var stateLabels = { 'OK': '✓ Норма', 'PENDING': '⏳ Ожидание', 'FIRING': '🔴 Сработал', 'RESOLVED': '✓ Восстановлен' };
    var condLabels = { '>': '>', '<': '<', '=': '=', 'no_data': 'нет данных' };

    var stateColor = stateColors[rule.state] || '#7C8798';
    var stateLabel = stateLabels[rule.state] || rule.state;

    var channels = [];
    try { channels = JSON.parse(rule.channels || '[]'); } catch(_){}
    var channelStr = channels.map(function(ch){ return ch.type === 'telegram' ? '📱 Telegram' : '🔗 ' + ch.type; }).join(', ');

    var html = '<div class="alert-rule-card">';
    html += '  <div class="alert-rule-header">';
    html += '    <div class="alert-rule-state" style="color:' + stateColor + ';">' + esc(stateLabel) + '</div>';
    html += '    <div class="alert-rule-actions">';
    html += '      <button class="btn btn-ghost btn-xs" data-alert-edit="' + idx + '" title="Изменить">✏️</button>';
    html += '      <button class="btn btn-ghost btn-xs" data-alert-delete="' + idx + '" title="Удалить" style="color:var(--coral);">🗑️</button>';
    html += '    </div>';
    html += '  </div>';
    html += '  <div class="alert-rule-body">';
    html += '    <div class="alert-rule-title">' + esc(rule.title || 'Без названия') + '</div>';
    html += '    <div class="alert-rule-meta">';
    html += '      <span>' + esc(condLabels[rule.condition_type] || rule.condition_type) + ' ' + esc(String(rule.threshold)) + '</span>';
    html += '      <span>каждые ' + esc(String(rule.check_interval_sec)) + 'с</span>';
    html += '      <span>' + esc(channelStr) + '</span>';
    html += '    </div>';
    html += '  </div>';
    html += '</div>';
    return html;
  }

  /* ── Привязка обработчиков формы ── */
  function _bindAlertFormHandlers(p, src, sess, dashboardId){
    // Переключение типа канала
    var channelTypeEl = document.getElementById('alertChannelType');
    if(channelTypeEl){
      channelTypeEl.onchange = function(){
        var tgFields = document.getElementById('alertTelegramFields');
        var whFields = document.getElementById('alertWebhookFields');
        if(tgFields) tgFields.style.display = channelTypeEl.value === 'telegram' ? '' : 'none';
        if(whFields) whFields.style.display = channelTypeEl.value === 'webhook' ? '' : 'none';
      };
    }

    // Сохранить правило
    var saveBtn = document.getElementById('alertSaveBtn');
    if(saveBtn){
      saveBtn.onclick = function(){ _saveAlertRule(p, sess, dashboardId); };
    }

    // Тестовая отправка
    var testBtn = document.getElementById('alertTestBtn');
    if(testBtn){
      testBtn.onclick = function(){ _testAlertRule(p); };
    }

    // Кнопки редактирования/удаления правил
    document.querySelectorAll('[data-alert-edit]').forEach(function(btn){
      btn.onclick = function(){
        var idx = parseInt(btn.dataset.alertEdit);
        if(_alertRules[idx]) _fillFormFromRule(_alertRules[idx]);
      };
    });
    document.querySelectorAll('[data-alert-delete]').forEach(function(btn){
      btn.onclick = function(){
        var idx = parseInt(btn.dataset.alertDelete);
        if(_alertRules[idx]) _deleteAlertRule(_alertRules[idx].id, p, src, sess, dashboardId);
      };
    });
  }

  /* ── Заполнить форму из правила ── */
  function _fillFormFromRule(rule){
    var el;
    el = document.getElementById('alertCondition'); if(el) el.value = rule.condition_type || '<';
    el = document.getElementById('alertThreshold'); if(el) el.value = rule.threshold || '';
    el = document.getElementById('alertInterval'); if(el) el.value = String(rule.check_interval_sec || 60);
    el = document.getElementById('alertPendingChecks'); if(el) el.value = String(rule.pending_checks_required || 1);
    el = document.getElementById('alertTitle'); if(el) el.value = rule.title || '';

    var channels = [];
    try { channels = JSON.parse(rule.channels || '[]'); } catch(_){}
    var ch = channels[0] || {};
    el = document.getElementById('alertChannelType'); if(el){
      el.value = ch.type || 'telegram';
      if(el.onchange) el.onchange();
    }
    el = document.getElementById('alertBotToken'); if(el) el.value = ch.bot_token || '';
    el = document.getElementById('alertChatId'); if(el) el.value = ch.chat_id || '';
    el = document.getElementById('alertWebhookUrl'); if(el) el.value = ch.url || '';

    // Сохраняем id редактируемого правила
    var modal = document.getElementById('alertModal');
    if(modal) modal._editingRuleId = rule.id;

    // Меняем текст кнопки
    var saveBtn = document.getElementById('alertSaveBtn');
    if(saveBtn) saveBtn.textContent = 'Обновить правило';
  }

  /* ── Сохранить правило ── */
  function _saveAlertRule(p, sess, dashboardId){
    var conditionType = document.getElementById('alertCondition').value;
    var threshold = parseFloat(document.getElementById('alertThreshold').value);
    var interval = parseInt(document.getElementById('alertInterval').value);
    var pendingChecks = parseInt(document.getElementById('alertPendingChecks').value);
    var title = document.getElementById('alertTitle').value.trim();
    var channelType = document.getElementById('alertChannelType').value;

    if(!title){ toast('Введите название правила'); return; }
    if(conditionType !== 'no_data' && isNaN(threshold)){ toast('Введите значение порога'); return; }

    var channel = { type: channelType };
    if(channelType === 'telegram'){
      channel.bot_token = document.getElementById('alertBotToken').value.trim();
      channel.chat_id = document.getElementById('alertChatId').value.trim();
      if(!channel.chat_id){ toast('Введите Chat ID для Telegram'); return; }
    } else if(channelType === 'webhook'){
      channel.url = document.getElementById('alertWebhookUrl').value.trim();
      if(!channel.url){ toast('Введите URL вебхука'); return; }
    }

    var body = {
      dashboard_id: dashboardId,
      panel_id: p.id,
      title: title,
      condition_type: conditionType,
      threshold: conditionType === 'no_data' ? 0 : threshold,
      check_interval_sec: interval,
      pending_checks_required: pendingChecks,
      channels: [channel]
    };

    var modal = document.getElementById('alertModal');
    if(modal && modal._editingRuleId){
      body.id = modal._editingRuleId;
    }

    var saveBtn = document.getElementById('alertSaveBtn');
    if(saveBtn){ saveBtn.disabled = true; saveBtn.innerHTML = '<span class="qs-spinner"></span> Сохранение…'; }

    fetch(API + '/api/alerts/rules', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(body)
    })
    .then(function(r){
      if(r.status === 401){ clearSession(); toast('Сессия истекла'); return null; }
      if(!r.ok) return r.json().then(function(e){ throw new Error(e.error || 'HTTP '+r.status); });
      return r.json();
    })
    .then(function(data){
      if(!data) return;
      toast('✓ Правило сохранено');
      // Очищаем форму
      if(modal) modal._editingRuleId = null;
      var saveBtn = document.getElementById('alertSaveBtn');
      if(saveBtn){ saveBtn.textContent = 'Сохранить правило'; saveBtn.disabled = false; }
      // Перезагружаем правила
      _loadAlertRules(p, p._src || getSrc(), sess);
    })
    .catch(function(err){
      toast('Ошибка: ' + err.message);
      if(saveBtn){ saveBtn.disabled = false; saveBtn.textContent = 'Сохранить правило'; }
    });
  }

  /* ── Удалить правило ── */
  function _deleteAlertRule(ruleId, p, src, sess, dashboardId){
    if(!confirm('Удалить это правило?')) return;

    fetch(API + '/api/alerts/rules/' + ruleId, {
      method: 'DELETE',
      headers: authHeaders()
    })
    .then(function(r){
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(){
      toast('Правило удалено');
      _loadAlertRules(p, src, sess);
    })
    .catch(function(err){
      toast('Ошибка удаления: ' + err.message);
    });
  }

  /* ── Тестовая отправка ── */
  function _testAlertRule(p){
    var channelType = document.getElementById('alertChannelType').value;
    var channel = { type: channelType };
    if(channelType === 'telegram'){
      channel.bot_token = document.getElementById('alertBotToken').value.trim();
      channel.chat_id = document.getElementById('alertChatId').value.trim();
      if(!channel.chat_id){ toast('Введите Chat ID'); return; }
    } else if(channelType === 'webhook'){
      channel.url = document.getElementById('alertWebhookUrl').value.trim();
      if(!channel.url){ toast('Введите URL'); return; }
    }

    var testBtn = document.getElementById('alertTestBtn');
    if(testBtn){ testBtn.disabled = true; testBtn.innerHTML = '<span class="qs-spinner"></span> Отправка…'; }

    fetch(API + '/api/alerts/test', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({
        title: p.title || 'Тест',
        channels: [channel],
        rule_id: null
      })
    })
    .then(function(r){
      if(!r.ok) return r.json().then(function(e){ throw new Error(e.error || 'HTTP '+r.status); });
      return r.json();
    })
    .then(function(){
      toast('🧪 Тестовое уведомление поставлено в очередь');
      _loadQueueStatus();
    })
    .catch(function(err){
      toast('Ошибка: ' + err.message);
    })
    .finally(function(){
      if(testBtn){ testBtn.disabled = false; testBtn.textContent = 'Тестовая отправка'; }
    });
  }

  /* ── Загрузка статуса очереди ── */
  function _loadQueueStatus(){
    var el = document.getElementById('alertQueueStatus');
    if(!el) return;

    fetch(API + '/api/alerts/status', { headers: authHeaders() })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(data){
        if(!data || !data.queue){
          el.innerHTML = '';
          return;
        }
        var q = data.queue;
        var net = data.network || {};
        var html = '<div class="alert-queue-info">';
        html += '  <span>Очередь: <b>' + (q.pending || 0) + '</b> ожидание</span>';
        html += '  <span><b>' + (q.processing || 0) + '</b> обработка</span>';
        html += '  <span><b>' + (q.failed || 0) + '</b> ошибки</span>';
        html += '  <span>Сеть: <b>' + (net.active_requests || 0) + '</b> запросов</span>';
        html += '</div>';
        el.innerHTML = html;
      })
      .catch(function(){});
  }

  /* ── Закрытие модалки ── */
  document.addEventListener('DOMContentLoaded', function(){
    var closeBtn = document.getElementById('alertCloseBtn');
    if(closeBtn){
      closeBtn.onclick = function(){
        var modal = document.getElementById('alertModal');
        if(modal) modal.classList.remove('active');
        modal._editingRuleId = null;
      };
    }
    // Клик по overlay закрывает
    var modal = document.getElementById('alertModal');
    if(modal){
      modal.addEventListener('click', function(e){
        if(e.target === modal){
          modal.classList.remove('active');
          modal._editingRuleId = null;
        }
      });
    }
  });

})();

/* ═══════════════════════════════════════════════════
   public/plugins/reports/reports-modal.js — Модалка настройки отчётов
   Зависит от: core.js (API, getSession, authHeaders, escapeHtml, toast, confirmModal) 
   ═══════════════════════════════════════════════════ */
'use strict';

(function() {

  /* ── Состояние ── */
  var _reportsConfig = null;   // текущий конфиг (masked)
  var _reportsDashboardId = null;

  /* ── Открыть модалку ── */
  function openReportsModal(dashboardId) {
    _reportsDashboardId = dashboardId;
    var modal = document.getElementById('reportsModal');
    if (!modal) return;
    modal.classList.add('active');
    _switchTab('integration');
    _loadConfig(dashboardId);
  }

  function closeReportsModal() {
    var modal = document.getElementById('reportsModal');
    if (modal) modal.classList.remove('active');
  }

  /* ── Переключение вкладок ── */
  function _switchTab(tab) {
    var tabs = document.querySelectorAll('#reportsModal .rtab');
    var panes = document.querySelectorAll('#reportsModal .rtab-pane');
    tabs.forEach(function(t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === tab);
    });
    panes.forEach(function(p) {
      p.classList.toggle('active', p.getAttribute('data-pane') === tab);
    });
  }

  /* ── Загрузить конфиг с сервера ── */
  async function _loadConfig(dashboardId) {
    var statusEl = document.getElementById('rStatus');
    if (statusEl) statusEl.textContent = 'загрузка…';

    try {
      var r = await fetch(API + '/reports/' + encodeURIComponent(dashboardId), {
        headers: authHeaders()
      });
      if (r.status === 404) {
        _reportsConfig = null;
        _fillFormDefaults();
        if (statusEl) statusEl.textContent = 'не настроен';
        return;
      }
      if (r.status === 401) { clearSession(); closeReportsModal(); return; }
      if (!r.ok) {
        var e = await r.json().catch(function() { return {}; });
        if (statusEl) statusEl.textContent = 'ошибка: ' + (e.error || r.status);
        return;
      }
      var data = await r.json();
      _reportsConfig = data.config;
      _fillForm(data.config);
      if (statusEl) statusEl.textContent = data.config.is_active ? 'активен' : 'неактивен';
    } catch (err) {
      if (statusEl) statusEl.textContent = 'сеть недоступна';
    }

    _loadHistory(dashboardId);
  }

  /* ── Заполнить форму из конфига ── */
  function _fillForm(cfg) {
    var $ = function(id) { return document.getElementById(id); };
    $('r_botId').value        = cfg.bot_id || '';
    $('r_botToken').value     = '';  // masked — не заполняем, пользователь введёт новый если нужно
    $('r_botTokenHint').textContent = cfg.bot_token_hint || '';
    $('r_functionId').value   = cfg.function_id || 697;
    $('r_prompt').value       = cfg.prompt || '';
    $('r_size').value         = cfg.size || '9:16';
    $('r_filesUrl').value     = cfg.files_url || '';
    $('r_tgToken').value      = '';  // masked
    $('r_tgTokenHint').textContent = cfg.telegram_bot_token ? cfg.telegram_bot_token : '';
    $('r_chatIds').value      = cfg.chat_ids || '';
    $('r_emails').value       = cfg.emails || '';
    $('r_scheduleType').value = cfg.schedule_type || 'daily';
    $('r_scheduleTime').value = cfg.schedule_time || '09:00';
    $('r_scheduleDays').value = cfg.schedule_days || '1,2,3,4,5';
    $('r_scheduleHours').value = cfg.schedule_hours || 0;
    $('r_timezone').value     = cfg.timezone || 'UTC+03:00';
    $('r_isActive').checked   = !!cfg.is_active;
    _onScheduleTypeChange();
  }

  function _fillFormDefaults() {
    var $ = function(id) { return document.getElementById(id); };
    $('r_botId').value        = '';
    $('r_botToken').value     = '';
    $('r_botTokenHint').textContent = '';
    $('r_functionId').value   = '697';
    $('r_prompt').value       = 'Визуализируй на одном листе все приложенные данные ничего не додумывая, а точно опираясь на указанные цифры.';
    $('r_size').value         = '9:16';
    $('r_filesUrl').value     = '';
    $('r_tgToken').value      = '';
    $('r_tgTokenHint').textContent = '';
    $('r_chatIds').value      = '';
    $('r_emails').value       = '';
    $('r_scheduleType').value = 'daily';
    $('r_scheduleTime').value = '09:00';
    $('r_scheduleDays').value = '1,2,3,4,5';
    $('r_scheduleHours').value = '6';
    $('r_timezone').value     = 'UTC+03:00';
    $('r_isActive').checked   = false;
    _onScheduleTypeChange();
  }

  /* ── Показать/скрыть поля расписания ── */
  function _onScheduleTypeChange() {
    var type = document.getElementById('r_scheduleType').value;
    var timeRow  = document.getElementById('r_scheduleTimeRow');
    var daysRow  = document.getElementById('r_scheduleDaysRow');
    var hoursRow = document.getElementById('r_scheduleHoursRow');
    if (timeRow)  timeRow.style.display  = (type === 'daily' || type === 'weekly') ? '' : 'none';
    if (daysRow)  daysRow.style.display  = (type === 'weekly') ? '' : 'none';
    if (hoursRow) hoursRow.style.display = (type === 'interval') ? '' : 'none';
  }

  /* ── Собрать тело запроса из формы ── */
  function _readForm() {
    var $ = function(id) { return document.getElementById(id); };
    var body = {
      bot_id:            Number($('r_botId').value) || 0,
      function_id:       Number($('r_functionId').value) || 697,
      prompt:            $('r_prompt').value.trim(),
      size:              $('r_size').value,
      files_url:         $('r_filesUrl').value.trim(),
      chat_ids:          $('r_chatIds').value.trim(),
      emails:            $('r_emails').value.trim(),
      schedule_type:     $('r_scheduleType').value,
      schedule_time:     $('r_scheduleTime').value || '09:00',
      schedule_days:     $('r_scheduleDays').value || '1,2,3,4,5',
      schedule_hours:    Number($('r_scheduleHours').value) || 6,
      timezone:          $('r_timezone').value || 'UTC+03:00',
      is_active:         $('r_isActive').checked,
    };
    // bot_token — только если пользователь ввёл новый
    var bt = $('r_botToken').value.trim();
    if (bt) body.bot_token = bt;
    else if (_reportsConfig && _reportsConfig.bot_token_hint) {
      // не обновляем — на сервере останется старый
    }
    // telegram_bot_token — аналогично
    var tt = $('r_tgToken').value.trim();
    if (tt) body.telegram_bot_token = tt;
    return body;
  }

  /* ── Сохранить ── */
  async function _saveConfig() {
    var body = _readForm();
    if (!body.bot_id) { toast('Укажите Bot ID'); return; }
    if (!_reportsConfig && !body.bot_token) { toast('Укажите Bot Token'); return; }

    var btn = document.getElementById('rBtnSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Сохранение…'; }

    try {
      var r = await fetch(API + '/reports/' + encodeURIComponent(_reportsDashboardId), {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify(body)
      });
      if (r.status === 401) { clearSession(); closeReportsModal(); return; }
      if (!r.ok) {
        var e = await r.json().catch(function() { return {}; });
        toast('Ошибка: ' + (e.error || r.status));
        return;
      }
      var data = await r.json();
      _reportsConfig = data.config;
      _fillForm(data.config);
      var statusEl = document.getElementById('rStatus');
      if (statusEl) statusEl.textContent = data.config.is_active ? 'активен' : 'неактивен';
      toast('Настройки сохранены ✓');
    } catch (err) {
      toast('Сеть недоступна');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
    }
  }

  /* ── Тестовая отправка ── */
  async function _sendTest() {
    if (!_reportsConfig) { toast('Сначала сохраните конфиг'); return; }

    var btn = document.getElementById('rBtnTest');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Генерация…'; }

    try {
      var r = await fetch(API + '/reports/' + encodeURIComponent(_reportsDashboardId) + '/test', {
        method: 'POST',
        headers: authHeaders()
      });
      if (r.status === 401) { clearSession(); closeReportsModal(); return; }
      if (r.status === 429) { toast('Подождите 5 минут перед следующим тестом'); return; }
      if (!r.ok) {
        var e = await r.json().catch(function() { return {}; });
        toast('Ошибка: ' + (e.error || r.status));
        return;
      }
      var data = await r.json();
      toast('Отчёт генерируется… (id: ' + data.historyId + ')');

      // Поллим статус каждые 5 сек
      _pollHistory(data.historyId, btn);
    } catch (err) {
      toast('Сеть недоступна');
      if (btn) { btn.disabled = false; btn.textContent = '📊 Отправить тестовый отчёт'; }
    }
  }

  function _pollHistory(historyId, btn) {
    var attempts = 0;
    var maxAttempts = 60; // 5 мин
    var timer = setInterval(async function() {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(timer);
        if (btn) { btn.disabled = false; btn.textContent = '📊 Отправить тестовый отчёт'; }
        toast('Таймаут — проверьте историю');
        _loadHistory(_reportsDashboardId);
        return;
      }
      try {
        var r = await fetch(API + '/reports/' + encodeURIComponent(_reportsDashboardId) + '/history/' + historyId, {
          headers: authHeaders()
        });
        if (!r.ok) return;
        var data = await r.json();
        if (data.status === 'done') {
          clearInterval(timer);
          if (btn) { btn.disabled = false; btn.textContent = '📊 Отправить тестовый отчёт'; }
          toast('✅ Отчёт готов! Картинка отправлена.');
          _loadHistory(_reportsDashboardId);
        } else if (data.status === 'error') {
          clearInterval(timer);
          if (btn) { btn.disabled = false; btn.textContent = '📊 Отправить тестовый отчёт'; }
          toast('❌ Ошибка: ' + (data.error_message || 'неизвестно'));
          _loadHistory(_reportsDashboardId);
        }
        // status === 'working' — продолжаем ждать
      } catch (_) {}
    }, 5000);
  }

  /* ── История отправок ── */
  async function _loadHistory(dashboardId) {
    var container = document.getElementById('rHistoryBody');
    if (!container) return;
    container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">загрузка…</div>';

    try {
      var r = await fetch(API + '/reports/' + encodeURIComponent(dashboardId) + '/history', {
        headers: authHeaders()
      });
      if (!r.ok) { container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">нет данных</div>'; return; }
      var data = await r.json();
      if (!data.history || !data.history.length) {
        container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">история пуста</div>';
        return;
      }

      var html = '<table class="r-history-table"><thead><tr><th>Дата</th><th>Тип</th><th>Статус</th><th>Результат</th></tr></thead><tbody>';
      data.history.forEach(function(h) {
        var dt = h.started_at ? new Date(h.started_at).toLocaleString('ru-RU') : '—';
        var statusIcon = h.status === 'done' ? '✅' : (h.status === 'error' ? '❌' : '⏳');
        var statusText = h.status === 'done' ? 'успех' : (h.status === 'error' ? 'ошибка' : h.status);
        var result = '';
        if (h.image_url) {
          result = '<a href="' + escapeHtml(h.image_url) + '" target="_blank" rel="noopener" style="color:var(--teal);font-size:11px;">🖼 открыть</a>';
        } else if (h.error_message) {
          result = '<span style="color:var(--red);font-size:11px;" title="' + escapeHtml(h.error_message) + '">' + escapeHtml(h.error_message.slice(0, 40)) + '</span>';
        }
        html += '<tr><td>' + escapeHtml(dt) + '</td><td>' + escapeHtml(h.trigger_type || '—') + '</td><td>' + statusIcon + ' ' + statusText + '</td><td>' + result + '</td></tr>';
      });
      html += '</tbody></table>';
      container.innerHTML = html;
    } catch (_) {
      container.innerHTML = '<div style="color:var(--muted-2);font-size:12px;">ошибка загрузки</div>';
    }
  }

  /* ── Инициализация (вызывается после DOM ready) ── */
  function _init() {
    var modal = document.getElementById('reportsModal');
    if (!modal) return;

    // Кнопка закрытия
    var closeBtn = document.getElementById('rCloseBtn');
    if (closeBtn) closeBtn.onclick = closeReportsModal;

    // Клик по overlay — закрыть
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeReportsModal();
    });

    // Вкладки
    modal.querySelectorAll('.rtab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        _switchTab(tab.getAttribute('data-tab'));
      });
    });

    // Тип расписания
    var stEl = document.getElementById('r_scheduleType');
    if (stEl) stEl.addEventListener('change', _onScheduleTypeChange);

    // Кнопки
    var saveBtn = document.getElementById('rBtnSave');
    if (saveBtn) saveBtn.addEventListener('click', _saveConfig);

    var testBtn = document.getElementById('rBtnTest');
    if (testBtn) testBtn.addEventListener('click', _sendTest);

    var delBtn = document.getElementById('rBtnDelete');
    if (delBtn) delBtn.addEventListener('click', async function() {
      if (!await confirmModal('Удалить настройки?', 'Конфигурация отчёта будет удалена. История сохранится.', 'Удалить')) return;
      try {
        var r = await fetch(API + '/reports/' + encodeURIComponent(_reportsDashboardId), {
          method: 'DELETE',
          headers: authHeaders()
        });
        if (r.ok) {
          _reportsConfig = null;
          _fillFormDefaults();
          toast('Настройки удалены');
          var statusEl = document.getElementById('rStatus');
          if (statusEl) statusEl.textContent = 'не настроен';
        }
      } catch (_) { toast('Сеть недоступна'); }
    });
  }

  // Экспорт (инициализация — bindEvents — вызывается из reports-ui.js ПОСЛЕ инъекции HTML)
  window.ReportsModal = {
    open: openReportsModal,
    close: closeReportsModal,
    bindEvents: _init
  };

})();

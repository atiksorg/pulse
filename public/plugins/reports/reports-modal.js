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
    // При переключении на монитор — подгружаем данные
    if (tab === 'monitor') {
      _loadSchedulerStatus();
      _loadStats();
    }
    if (tab === 'history') {
      _loadStats();
    }
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

      // Загружаем реальные токены (в открытом виде) для отображения в полях
      _loadTokens(dashboardId);
    } catch (err) {
      if (statusEl) statusEl.textContent = 'сеть недоступна';
    }

    _loadHistory(dashboardId);
  }

  /* ── Загрузить токены в открытом виде ── */
  async function _loadTokens(dashboardId) {
    try {
      var r = await fetch(API + '/reports/' + encodeURIComponent(dashboardId) + '/tokens', {
        headers: authHeaders()
      });
      if (!r.ok) return;
      var data = await r.json();

      var botInput = document.getElementById('r_botToken');
      var tgInput = document.getElementById('r_tgToken');

      if (botInput && data.bot_token) {
        botInput.value = data.bot_token;
        botInput.setAttribute('data-loaded', 'true');
      }
      if (tgInput && data.telegram_bot_token) {
        tgInput.value = data.telegram_bot_token;
        tgInput.setAttribute('data-loaded', 'true');
      }
    } catch (_) {}
  }

  /* ── Заполнить форму из конфига ── */
  function _fillForm(cfg) {
    var $ = function(id) { return document.getElementById(id); };
    $('r_botId').value        = cfg.bot_id || '';
    $('r_botToken').value     = '';  // заполнится через _loadTokens()
    $('r_functionId').value   = cfg.function_id || 697;
    $('r_prompt').value       = cfg.prompt || '';
    $('r_size').value         = cfg.size || '9:16';
    $('r_filesUrl').value     = cfg.files_url || '';
    $('r_tgToken').value      = '';  // заполнится через _loadTokens()
    $('r_chatIds').value      = cfg.chat_ids || '';
    $('r_emails').value       = cfg.emails || '';
    $('r_scheduleType').value = cfg.schedule_type || 'daily';
    // Разбираем schedule_time на часы и минуты
    var stParts = (cfg.schedule_time || '09:00').split(':');
    var hourSel = document.getElementById('r_scheduleHour');
    var minSel  = document.getElementById('r_scheduleMinute');
    if (hourSel) hourSel.value = stParts[0] || '09';
    if (minSel)  minSel.value  = stParts[1] || '00';
    _syncScheduleTime();
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
    $('r_functionId').value   = '697';
    $('r_prompt').value       = 'Визуализируй на одном листе все приложенные данные ничего не додумывая, а точно опираясь на указанные цифры.';
    $('r_size').value         = '9:16';
    $('r_filesUrl').value     = '';
    $('r_tgToken').value      = '';
    $('r_chatIds').value      = '';
    $('r_emails').value       = '';
    $('r_scheduleType').value = 'daily';
    var hourSel = document.getElementById('r_scheduleHour');
    var minSel  = document.getElementById('r_scheduleMinute');
    if (hourSel) hourSel.value = '09';
    if (minSel)  minSel.value  = '00';
    _syncScheduleTime();
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

  /* ── Синхронизация select'ов часа/минуты → скрытый input ── */
  function _syncScheduleTime() {
    var hourSel = document.getElementById('r_scheduleHour');
    var minSel  = document.getElementById('r_scheduleMinute');
    var hidden  = document.getElementById('r_scheduleTime');
    if (hourSel && minSel && hidden) {
      hidden.value = hourSel.value + ':' + minSel.value;
    }
  }

  /* ── Проверка расписания (запрос к серверу) ── */
  var _checkTimer = null;

  async function _checkSchedule() {
    if (!_reportsDashboardId) { toast('Сначала сохраните конфиг'); return; }

    var resultEl = document.getElementById('rScheduleCheck');
    var btn = document.getElementById('rBtnCheckSchedule');
    if (!resultEl) return;

    resultEl.innerHTML = '<span style="color:var(--muted-2);">⏳ запрос к серверу…</span>';
    if (btn) { btn.disabled = true; }

    try {
      var r = await fetch(API + '/reports/' + encodeURIComponent(_reportsDashboardId) + '/check-schedule', {
        headers: authHeaders()
      });
      if (r.status === 401) { clearSession(); closeReportsModal(); return; }
      if (r.status === 404) { resultEl.innerHTML = '<span style="color:var(--red);">Конфиг не найден — сохраните настройки</span>'; return; }
      if (!r.ok) {
        var e = await r.json().catch(function() { return {}; });
        resultEl.innerHTML = '<span style="color:var(--red);">Ошибка: ' + (e.error || r.status) + '</span>';
        return;
      }
      var data = await r.json();

      // Локальное время браузера
      var browserNow = new Date();
      var browserHHMM = String(browserNow.getHours()).padStart(2,'0') + ':' + String(browserNow.getMinutes()).padStart(2,'0');
      var browserOffsetMin = -browserNow.getTimezoneOffset();
      var browserOffsetStr = 'UTC' + (browserOffsetMin >= 0 ? '+' : '-') +
        String(Math.floor(Math.abs(browserOffsetMin) / 60)).padStart(2,'0') + ':' +
        String(Math.abs(browserOffsetMin) % 60).padStart(2,'0');

      // Разница сервер/браузер
      var serverDate = new Date(data.serverTime);
      var diffMs = serverDate.getTime() - browserNow.getTime();
      var diffSec = Math.round(Math.abs(diffMs) / 1000);
      var diffSign = diffMs >= 0 ? '+' : '-';
      var diffStr = diffSec < 60 ? diffSec + ' сек' : Math.round(diffSec / 60) + ' мин';
      var diffColor = Math.abs(diffMs) > 60000 ? 'var(--red)' : 'var(--green,#4CAF50)';

      // Обратный отсчёт
      var countdownStr = '—';
      if (data.minutesUntilNext !== null && data.minutesUntilNext !== undefined) {
        if (data.minutesUntilNext <= 0) {
          countdownStr = 'сейчас!';
        } else if (data.minutesUntilNext < 60) {
          countdownStr = data.minutesUntilNext + ' мин';
        } else {
          var h = Math.floor(data.minutesUntilNext / 60);
          var m = data.minutesUntilNext % 60;
          countdownStr = h + ' ч ' + m + ' мин';
        }
      }

      // Статус с учётом alreadySentToday
      var statusHtml;
      if (data.alreadySentToday) {
        statusHtml = '<span style="color:var(--yellow,#FFD93D);font-weight:bold;">🟡 УЖЕ ОТПРАВЛЕНО СЕГОДНЯ</span>';
      } else if (data.wouldSendNow) {
        statusHtml = '<span style="color:var(--red,#FF6B6B);font-weight:bold;">🔴 СРАБОТАЛ БЫ СЕЙЧАС</span>';
      } else {
        statusHtml = '<span style="color:var(--green,#4CAF50);">🟢 Не сработал бы</span>';
      }

      // Активность
      var activeStr = data.isActive
        ? '<span style="color:var(--green,#4CAF50);">✅ включено</span>'
        : '<span style="color:var(--red,#FF6B6B);">⛔ выключено</span>';

      // Визуальный таймлайн окна
      var timelineHtml = '';
      if (data.windowStart && data.windowEnd && data.scheduleType !== 'interval') {
        var wsMin = _hhmmToMin(data.windowStart);
        var weMin = _hhmmToMin(data.windowEnd);
        var nowMin = _hhmmToMin(browserHHMM);
        // Показываем 2 часа вокруг окна
        var rangeStart = Math.max(0, wsMin - 60);
        var rangeEnd = Math.min(1439, weMin + 60);
        var rangeLen = rangeEnd - rangeStart;

        var windowLeft = ((wsMin - rangeStart) / rangeLen * 100).toFixed(1);
        var windowWidth = ((weMin - wsMin) / rangeLen * 100).toFixed(1);
        var nowPos = ((nowMin - rangeStart) / rangeLen * 100);
        nowPos = Math.max(0, Math.min(100, nowPos)).toFixed(1);

        timelineHtml = [
          '<div style="margin-top:10px;padding:8px;background:var(--card-bg,#141921);border-radius:6px;">',
          '  <div style="position:relative;height:24px;margin-bottom:4px;">',
          '    <!-- Шкала -->',
          '    <div style="position:absolute;top:10px;left:0;right:0;height:4px;background:var(--border,#1A2130);border-radius:2px;"></div>',
          '    <!-- Окно расписания -->',
          '    <div style="position:absolute;top:6px;left:' + windowLeft + '%;width:' + windowWidth + '%;height:12px;background:var(--teal,#2DD4BF);border-radius:3px;opacity:0.4;"></div>',
          '    <!-- Текущее время -->',
          '    <div style="position:absolute;top:2px;left:' + nowPos + '%;transform:translateX(-50%);font-size:18px;">📍</div>',
          '  </div>',
          '  <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted-2);">',
          '    <span>' + _minToHHMM(rangeStart) + '</span>',
          '    <span style="color:var(--teal);">🞂 ' + data.windowStart + '–' + data.windowEnd + '</span>',
          '    <span>' + _minToHHMM(rangeEnd) + '</span>',
          '  </div>',
          '</div>'
        ].join('\n');
      }

      // Причина
      var reasonHtml = data.wouldSendReason
        ? '<div style="margin-top:6px;padding:6px 8px;background:var(--card-bg,#141921);border-radius:4px;font-size:11px;color:var(--muted-2);">💡 ' + escapeHtml(data.wouldSendReason) + '</div>'
        : '';

      var html = [
        '<div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;line-height:1.6;">',
        '  <span style="color:var(--muted-2);">Сервер:</span> <span>' + escapeHtml(data.serverTimeStr) + '</span>',
        '  <span style="color:var(--muted-2);">Браузер:</span> <span>' + browserHHMM + ' (' + browserOffsetStr + ')</span>',
        '  <span style="color:var(--muted-2);">Разница:</span> <span style="color:' + diffColor + ';">' + diffSign + diffStr + '</span>',
        '  <span style="color:var(--muted-2);">Час.пояс:</span> <span>' + escapeHtml(data.timezone) + ' (offset ' + data.timezoneOffset + ' ч)</span>',
        '  <span style="color:var(--muted-2);">Местное время:</span> <span>' + escapeHtml(data.localTime) + ' (' + data.localDayName + ')</span>',
        '  <span style="color:var(--muted-2);">Расписание:</span> <span>' + escapeHtml(data.scheduleType) + ' → ' + escapeHtml(data.scheduleTime || '—') + '</span>',
        '  <span style="color:var(--muted-2);">Автоотправка:</span> <span>' + activeStr + '</span>',
        '  <span style="color:var(--muted-2);">Статус:</span> <span>' + statusHtml + '</span>',
        '  <span style="color:var(--muted-2);">До отправки:</span> <span style="font-weight:bold;">' + countdownStr + '</span>',
        '  <span style="color:var(--muted-2);">Последняя:</span> <span>' + (data.lastSentAt ? escapeHtml(data.lastSentAt.replace('T',' ').slice(0,19)) : 'никогда') + '</span>',
        '</div>',
        reasonHtml,
        timelineHtml,
      ].join('\n');

      resultEl.innerHTML = html;

      // Обновляем countdown каждые 30 сек (показываем сколько осталось)
      if (_checkTimer) clearInterval(_checkTimer);
      if (data.minutesUntilNext > 0) {
        _checkTimer = setInterval(function() {
          _checkSchedule();
        }, 30000);
      }
    } catch (err) {
      resultEl.innerHTML = '<span style="color:var(--red);">Сеть недоступна</span>';
    } finally {
      if (btn) { btn.disabled = false; }
    }
  }

  /* ── Вспомогательные: HH:MM ↔ минуты ── */
  function _hhmmToMin(hhmm) {
    var p = (hhmm || '00:00').split(':');
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }
  function _minToHHMM(min) {
    var h = String(Math.floor(min / 60)).padStart(2, '0');
    var m = String(min % 60).padStart(2, '0');
    return h + ':' + m;
  }

  /* ── Предпросмотр XML ── */
  async function _previewXml() {
    if (!_reportsDashboardId) { toast('Сначала сохраните конфиг'); return; }

    var el = document.getElementById('rXmlPreview');
    var btn = document.getElementById('rBtnPreviewXml');
    if (!el) return;
    el.innerHTML = '<span style="color:var(--muted-2);">⏳ генерация XML…</span>';
    if (btn) btn.disabled = true;

    try {
      var r = await fetch(API + '/reports/' + encodeURIComponent(_reportsDashboardId) + '/preview-xml', {
        method: 'POST',
        headers: authHeaders()
      });
      if (!r.ok) {
        var e = await r.json().catch(function() { return {}; });
        el.innerHTML = '<span style="color:var(--red);">Ошибка: ' + (e.error || r.status) + '</span>';
        return;
      }
      var data = await r.json();

      var xmlEscaped = escapeHtml(data.xml);
      var isLong = data.xml.length > 3000;
      var displayXml = isLong ? xmlEscaped.slice(0, 3000) + '\n<span style="color:var(--muted-2);">… ещё ' + (data.xml.length - 3000) + ' символов</span>' : xmlEscaped;

      el.innerHTML = [
        '<div style="margin-bottom:6px;font-size:11px;color:var(--muted-2);">',
        '  📄 ' + data.length + ' символов (' + data.sizeKB + ' KB)',
        '</div>',
        '<pre style="background:var(--card-bg,#0D1117);border:1px solid var(--border,#1A2130);border-radius:6px;padding:10px;max-height:300px;overflow:auto;font-size:10px;font-family:var(--mono);line-height:1.5;white-space:pre-wrap;word-break:break-all;margin:0;">' + displayXml + '</pre>'
      ].join('\n');
    } catch (err) {
      el.innerHTML = '<span style="color:var(--red);">Сеть недоступна</span>';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ── Статус планировщика (heartbeat) ── */
  async function _loadSchedulerStatus() {
    var el = document.getElementById('rHeartbeat');
    if (!el) return;
    el.innerHTML = '<span style="color:var(--muted-2);">загрузка…</span>';

    try {
      var r = await fetch(API + '/reports/scheduler-status', {
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

      var html = [
        '<div style="display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11px;line-height:1.6;">',
        '  <span style="color:var(--muted-2);">Проверка:</span> <span style="color:' + ageColor + ';">' + ageStr + '</span>',
        '  <span style="color:var(--muted-2);">Интервал:</span> <span>' + (data.checkIntervalMs / 1000) + ' сек</span>',
        '  <span style="color:var(--muted-2);">Активных конфигов:</span> <span>' + data.activeConfigs + '</span>',
        '  <span style="color:var(--muted-2);">Параллельных отправок:</span> <span>' + (data.activeDispatches || 0) + ' / 3</span>',
        '  <span style="color:var(--muted-2);">Успешно (1ч):</span> <span style="color:var(--green,#4CAF50);">' + (data.recentDone1h || 0) + '</span>',
        '  <span style="color:var(--muted-2);">Ошибок (1ч):</span> <span style="color:' + ((data.recentErrors1h || 0) > 0 ? 'var(--red,#FF6B6B)' : 'var(--muted-2)') + ';">' + (data.recentErrors1h || 0) + '</span>',
        '</div>'
      ].join('\n');
      el.innerHTML = html;
    } catch (err) {
      el.innerHTML = '<span style="color:var(--red);">сеть недоступна</span>';
    }
  }

  /* ── Статистика ── */
  async function _loadStats() {
    if (!_reportsDashboardId) return;

    // Обновляем элементы в обеих вкладках (monitor + history)
    var statsEl = document.getElementById('rStats');
    var historyStatsEl = document.getElementById('rHistoryStats');

    try {
      var r = await fetch(API + '/reports/' + encodeURIComponent(_reportsDashboardId) + '/stats', {
        headers: authHeaders()
      });
      if (!r.ok) return;
      var data = await r.json();

      var html = [
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">',
        '  <div style="padding:8px;background:var(--card-bg,#141921);border-radius:6px;text-align:center;">',
        '    <div style="font-size:18px;font-weight:bold;color:var(--teal);">' + data.period7d.total + '</div>',
        '    <div style="font-size:10px;color:var(--muted-2);">за 7 дней</div>',
        '  </div>',
        '  <div style="padding:8px;background:var(--card-bg,#141921);border-radius:6px;text-align:center;">',
        '    <div style="font-size:18px;font-weight:bold;color:var(--teal);">' + data.period24h.total + '</div>',
        '    <div style="font-size:10px;color:var(--muted-2);">за 24 часа</div>',
        '  </div>',
        '  <div style="padding:8px;background:var(--card-bg,#141921);border-radius:6px;text-align:center;">',
        '    <div style="font-size:16px;color:var(--green,#4CAF50);">✅ ' + data.period7d.done + '</div>',
        '    <div style="font-size:10px;color:var(--muted-2);">успешно</div>',
        '  </div>',
        '  <div style="padding:8px;background:var(--card-bg,#141921);border-radius:6px;text-align:center;">',
        '    <div style="font-size:16px;color:' + (data.period7d.error > 0 ? 'var(--red,#FF6B6B)' : 'var(--muted-2)') + ';">❌ ' + data.period7d.error + '</div>',
        '    <div style="font-size:10px;color:var(--muted-2);">ошибок</div>',
        '  </div>',
        '</div>',
        '<div style="margin-top:8px;font-size:11px;color:var(--muted-2);">',
        '  ⏱ среднее время генерации: <b>' + data.avgDurationStr + '</b>',
        '</div>',
      ];

      if (data.lastError) {
        html.push(
          '<div style="margin-top:6px;font-size:11px;padding:6px 8px;background:rgba(255,107,107,0.1);border-radius:4px;">',
          '  <span style="color:var(--red,#FF6B6B);">⚠ последняя ошибка:</span> ' + escapeHtml((data.lastError.message || '').slice(0, 80)),
          '  <br><span style="color:var(--muted-2);font-size:10px;">' + escapeHtml((data.lastError.at || '').replace('T', ' ').slice(0, 19)) + '</span>',
          '</div>'
        );
      }

      var htmlStr = html.join('\n');
      if (statsEl) statsEl.innerHTML = htmlStr;
      if (historyStatsEl) historyStatsEl.innerHTML = htmlStr;
    } catch (_) {}
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
    // bot_token — отправляем если поле не пустое (включая загруженный из /tokens)
    var bt = $('r_botToken').value.trim();
    if (bt) body.bot_token = bt;
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

    // Показываем живой лог
    _showLiveLog('🚀 Запуск тестовой отправки…');

    try {
      var r = await fetch(API + '/reports/' + encodeURIComponent(_reportsDashboardId) + '/test', {
        method: 'POST',
        headers: authHeaders()
      });
      if (r.status === 401) { clearSession(); closeReportsModal(); return; }
      if (r.status === 429) {
        _appendLiveLog('⏳ Подождите 5 минут перед следующим тестом', 'warn');
        toast('Подождите 5 минут перед следующим тестом');
        if (btn) { btn.disabled = false; btn.textContent = '📊 Отправить тестовый отчёт'; }
        return;
      }
      if (!r.ok) {
        var e = await r.json().catch(function() { return {}; });
        _appendLiveLog('❌ Ошибка: ' + (e.error || r.status), 'error');
        toast('Ошибка: ' + (e.error || r.status));
        if (btn) { btn.disabled = false; btn.textContent = '📊 Отправить тестовый отчёт'; }
        return;
      }
      var data = await r.json();
      _appendLiveLog('✅ Запущено (historyId: ' + data.historyId + ')', 'ok');
      toast('Отчёт генерируется… (id: ' + data.historyId + ')');

      // Поллим статус с фазами каждые 3 сек
      _pollHistoryWithPhases(data.historyId, btn);
    } catch (err) {
      _appendLiveLog('❌ Сеть недоступна', 'error');
      toast('Сеть недоступна');
      if (btn) { btn.disabled = false; btn.textContent = '📊 Отправить тестовый отчёт'; }
    }
  }

  /* ── Живой лог ── */
  function _showLiveLog(initialMsg) {
    var section = document.getElementById('rLiveLogSection');
    var log = document.getElementById('rLiveLog');
    if (section) section.style.display = '';
    if (log) log.innerHTML = '';
    if (initialMsg) _appendLiveLog(initialMsg);
    // Переключаемся на вкладку монитор
    _switchTab('monitor');
  }

  function _appendLiveLog(msg, type) {
    var log = document.getElementById('rLiveLog');
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
    var maxAttempts = 100; // ~5 мин при 3 сек
    var lastPhaseCount = 0;

    var timer = setInterval(async function() {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(timer);
        _appendLiveLog('⏰ Таймаут — проверьте историю', 'warn');
        if (btn) { btn.disabled = false; btn.textContent = '📊 Отправить тестовый отчёт'; }
        _loadHistory(_reportsDashboardId);
        return;
      }
      try {
        var r = await fetch(API + '/reports/' + encodeURIComponent(_reportsDashboardId) + '/history/' + historyId, {
          headers: authHeaders()
        });
        if (!r.ok) return;
        var data = await r.json();

        // Показываем новые фазы
        if (data.phases && data.phases.length > lastPhaseCount) {
          for (var i = lastPhaseCount; i < data.phases.length; i++) {
            var ph = data.phases[i];
            var icon = _phaseIcon(ph.phase);
            _appendLiveLog(icon + ' ' + ph.phase + (ph.detail ? ': ' + ph.detail : ''), 'phase');
          }
          lastPhaseCount = data.phases.length;
        }

        if (data.status === 'done') {
          clearInterval(timer);
          var dur = data.duration_ms ? (data.duration_ms > 1000 ? Math.round(data.duration_ms / 1000) + ' сек' : data.duration_ms + ' мс') : '';
          _appendLiveLog('🎉 Готово!' + (dur ? ' (' + dur + ')' : '') + (data.image_url ? ' → ' + data.image_url : ''), 'ok');
          if (btn) { btn.disabled = false; btn.textContent = '📊 Отправить тестовый отчёт'; }
          _loadHistory(_reportsDashboardId);
          _loadStats();
        } else if (data.status === 'error') {
          clearInterval(timer);
          _appendLiveLog('❌ Ошибка: ' + (data.error_message || 'неизвестно'), 'error');
          if (btn) { btn.disabled = false; btn.textContent = '📊 Отправить тестовый отчёт'; }
          _loadHistory(_reportsDashboardId);
          _loadStats();
        }
      } catch (_) {}
    }, 3000);
  }

  function _phaseIcon(phase) {
    if (phase === 'xml_start') return '📝';
    if (phase === 'xml_generated') return '📄';
    if (phase === 'api_call') return '📡';
    if (phase === 'polling') return '⏳';
    if (phase === 'api_done') return '✅';
    if (phase === 'done') return '🎉';
    if (phase === 'error') return '❌';
    return '•';
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

      var html = '<table class="r-history-table" style="width:100%;border-collapse:collapse;font-size:11px;"><thead><tr>' +
        '<th style="text-align:left;padding:4px 6px;">Дата</th>' +
        '<th style="text-align:left;padding:4px 6px;">Тип</th>' +
        '<th style="text-align:left;padding:4px 6px;">Статус</th>' +
        '<th style="text-align:left;padding:4px 6px;">Время</th>' +
        '<th style="text-align:left;padding:4px 6px;">Результат</th>' +
        '</tr></thead><tbody>';
      data.history.forEach(function(h) {
        var dt = h.started_at ? new Date(h.started_at).toLocaleString('ru-RU') : '—';
        var statusIcon = h.status === 'done' ? '✅' : (h.status === 'error' ? '❌' : '⏳');
        var statusText = h.status === 'done' ? 'успех' : (h.status === 'error' ? 'ошибка' : h.status);
        var dur = '';
        if (h.duration_ms && h.duration_ms > 0) {
          dur = h.duration_ms > 60000 ? Math.round(h.duration_ms / 60000) + ' мин' : Math.round(h.duration_ms / 1000) + ' сек';
        }
        var result = '';
        if (h.image_url) {
          result = '<a href="' + escapeHtml(h.image_url) + '" target="_blank" rel="noopener" style="color:var(--teal);font-size:11px;">🖼 открыть</a>';
        } else if (h.error_message) {
          result = '<span style="color:var(--red);font-size:10px;" title="' + escapeHtml(h.error_message) + '">' + escapeHtml(h.error_message.slice(0, 40)) + '</span>';
        }
        html += '<tr style="border-bottom:1px solid var(--border,#1A2130);">' +
          '<td style="padding:4px 6px;white-space:nowrap;">' + escapeHtml(dt) + '</td>' +
          '<td style="padding:4px 6px;">' + escapeHtml(h.trigger_type || '—') + '</td>' +
          '<td style="padding:4px 6px;">' + statusIcon + ' ' + statusText + '</td>' +
          '<td style="padding:4px 6px;color:var(--muted-2);">' + dur + '</td>' +
          '<td style="padding:4px 6px;">' + result + '</td>' +
          '</tr>';
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

    // Синхронизация select'ов часа/минуты → скрытый инпут
    var hourSel = document.getElementById('r_scheduleHour');
    var minSel  = document.getElementById('r_scheduleMinute');
    if (hourSel) hourSel.addEventListener('change', _syncScheduleTime);
    if (minSel)  minSel.addEventListener('change', _syncScheduleTime);

    // Кнопки-глазики для токенов
    document.querySelectorAll('#reportsModal .eye-btn').forEach(function(btn) {
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

    // Проверка расписания
    var checkBtn = document.getElementById('rBtnCheckSchedule');
    if (checkBtn) checkBtn.addEventListener('click', _checkSchedule);

    // Предпросмотр XML
    var xmlBtn = document.getElementById('rBtnPreviewXml');
    if (xmlBtn) xmlBtn.addEventListener('click', _previewXml);

    // Heartbeat refresh
    var hbBtn = document.getElementById('rBtnRefreshHeartbeat');
    if (hbBtn) hbBtn.addEventListener('click', function() {
      _loadSchedulerStatus();
      _loadStats();
    });
  }

  // Экспорт (инициализация — bindEvents — вызывается из reports-ui.js ПОСЛЕ инъекции HTML)
  window.ReportsModal = {
    open: openReportsModal,
    close: closeReportsModal,
    bindEvents: _init
  };

})();

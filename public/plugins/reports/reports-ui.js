/* ═══════════════════════════════════════════════════
   public/plugins/reports/reports-ui.js — Кнопка «Отчёты» в тулбаре
   + инъекция HTML модалки в DOM
   Зависит от: core.js, reports-modal.js
   ═══════════════════════════════════════════════════ */
'use strict';

(function() {

  /* ── Инъекция HTML модалки в DOM ── */
  function _injectModalHtml() {
    if (document.getElementById('reportsModal')) return; // уже есть

    var html = [
      '<div class="overlay" id="reportsModal">',
      '  <div class="modal" style="max-width:640px;max-height:90vh;overflow-y:auto;">',
      '    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">',
      '      <div><h2 style="margin:0;">📊 Отчёты</h2>',
      '      <span id="rStatus" style="font-size:11px;color:var(--muted-2);font-family:var(--mono);">—</span></div>',
      '      <button class="btn btn-ghost" id="rCloseBtn">✕</button>',
      '    </div>',
      '',
      '    <!-- Tabs -->',
      '    <div style="display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--border,#1A2130);padding-bottom:8px;">',
      '      <button class="btn btn-ghost rtab active" data-tab="integration">Интеграция</button>',
      '      <button class="btn btn-ghost rtab" data-tab="params">Параметры</button>',
      '      <button class="btn btn-ghost rtab" data-tab="schedule">Расписание</button>',
      '      <button class="btn btn-ghost rtab" data-tab="history">История</button>',
      '    </div>',
      '',
      '    <!-- Tab: Integration -->',
      '    <div class="rtab-pane active" data-pane="integration">',
      '      <div class="field-row">',
      '        <div class="field">',
      '          <label>Bot ID</label>',
      '          <input id="r_botId" type="number" placeholder="например 54518">',
      '        </div>',
      '        <div class="field">',
      '          <label>Bot Token</label>',
      '          <div style="position:relative;">',
      '            <input id="r_botToken" type="password" placeholder="••••••••" style="padding-right:34px;width:100%;box-sizing:border-box;">',
      '            <button type="button" class="eye-btn" data-target="r_botToken" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:14px;padding:4px;line-height:1;">👁</button>',
      '          </div>',
      '        </div>',
      '      </div>',
      '      <div class="field-row">',
      '        <div class="field">',
      '          <label>Function ID</label>',
      '          <input id="r_functionId" type="number" value="697" placeholder="697">',
      '        </div>',
      '        <div class="field">',
      '          <label>Формат</label>',
      '          <select id="r_size">',
      '            <option value="9:16">9:16 (портрет)</option>',
      '            <option value="16:9">16:9 (ландшафт)</option>',
      '            <option value="1:1">1:1 (квадрат)</option>',
      '            <option value="A4">A4</option>',
      '          </select>',
      '        </div>',
      '      </div>',
      '      <div class="field-row">',
      '        <div class="field" style="flex:1;">',
      '          <label>Telegram Bot Token (для отправки)</label>',
      '          <div style="position:relative;">',
      '            <input id="r_tgToken" type="password" placeholder="••••••••" style="padding-right:34px;width:100%;box-sizing:border-box;">',
      '            <button type="button" class="eye-btn" data-target="r_tgToken" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:14px;padding:4px;line-height:1;">👁</button>',
      '          </div>',
      '        </div>',
      '      </div>',
      '      <div class="field-row">',
      '        <div class="field">',
      '          <label>Telegram Chat ID(s)</label>',
      '          <input id="r_chatIds" placeholder="323994801 (через запятую)">',
      '        </div>',
      '        <div class="field">',
      '          <label>Email(s)</label>',
      '          <input id="r_emails" placeholder="user@mail.ru (через запятую)">',
      '        </div>',
      '      </div>',
      '    </div>',
      '',
      '    <!-- Tab: Params -->',
      '    <div class="rtab-pane" data-pane="params">',
      '      <div class="field-row">',
      '        <div class="field" style="flex:1;">',
      '          <label>Промпт</label>',
      '          <textarea id="r_prompt" rows="4" style="width:100%;background:var(--card-bg,#141921);color:var(--text,#e0e0e0);border:1px solid var(--border,#1A2130);border-radius:6px;padding:8px;font-size:12px;font-family:var(--mono);resize:vertical;" placeholder="Визуализируй на одном листе все приложенные данные…"></textarea>',
      '        </div>',
      '      </div>',
      '      <div class="field-row">',
      '        <div class="field" style="flex:1;">',
      '          <label>URL логотипа / доп. файлов (опционально)</label>',
      '          <input id="r_filesUrl" placeholder="https://...">',
      '        </div>',
      '      </div>',
      '    </div>',
      '',
      '    <!-- Tab: Schedule -->',
      '    <div class="rtab-pane" data-pane="schedule">',
      '      <div class="field-row">',
      '        <div class="field">',
      '          <label style="display:flex;align-items:center;gap:8px;">',
      '            <input type="checkbox" id="r_isActive"> Автоотправка включена',
      '          </label>',
      '        </div>',
      '      </div>',
      '      <div class="field-row">',
      '        <div class="field">',
      '          <label>Тип расписания</label>',
      '          <select id="r_scheduleType">',
      '            <option value="daily">Ежедневно</option>',
      '            <option value="weekly">По дням недели</option>',
      '            <option value="interval">Каждые N часов</option>',
      '          </select>',
      '        </div>',
      '        <div class="field">',
      '          <label>Часовой пояс</label>',
      '          <select id="r_timezone">',
      '            <option value="UTC+00:00">UTC+00:00</option>',
      '            <option value="UTC+01:00">UTC+01:00</option>',
      '            <option value="UTC+02:00">UTC+02:00</option>',
      '            <option value="UTC+03:00">UTC+03:00 (Москва)</option>',
      '            <option value="UTC+04:00">UTC+04:00</option>',
      '            <option value="UTC+05:00">UTC+05:00 (Екатеринбург)</option>',
      '            <option value="UTC+06:00">UTC+06:00</option>',
      '            <option value="UTC+07:00">UTC+07:00 (Новосибирск)</option>',
      '            <option value="UTC+08:00">UTC+08:00</option>',
      '            <option value="UTC+09:00">UTC+09:00</option>',
      '            <option value="UTC+10:00">UTC+10:00 (Владивосток)</option>',
      '            <option value="UTC-05:00">UTC-05:00 (Нью-Йорк)</option>',
      '            <option value="UTC-08:00">UTC-08:00 (Лос-Анджелес)</option>',
      '            <option value="UTC+00:00">UTC+00:00 (Лондон)</option>',
      '          </select>',
      '        </div>',
      '      </div>',
      '      <div class="field-row" id="r_scheduleTimeRow">',
      '        <div class="field">',
      '          <label>Время отправки</label>',
      '          <input id="r_scheduleTime" type="time" value="09:00">',
      '        </div>',
      '      </div>',
      '      <div class="field-row" id="r_scheduleDaysRow" style="display:none;">',
      '        <div class="field">',
      '          <label>Дни недели (0=вс, 1=пн…6=сб)</label>',
      '          <input id="r_scheduleDays" value="1,2,3,4,5" placeholder="1,2,3,4,5">',
      '        </div>',
      '      </div>',
      '      <div class="field-row" id="r_scheduleHoursRow" style="display:none;">',
      '        <div class="field">',
      '          <label>Интервал (часов)</label>',
      '          <input id="r_scheduleHours" type="number" min="1" max="168" value="6">',
      '        </div>',
      '      </div>',
      '    </div>',
      '',
      '    <!-- Tab: History -->',
      '    <div class="rtab-pane" data-pane="history">',
      '      <div id="rHistoryBody" style="max-height:300px;overflow-y:auto;">',
      '        <div style="color:var(--muted-2);font-size:12px;">история пуста</div>',
      '      </div>',
      '    </div>',
      '',
      '    <!-- Actions -->',
      '    <div class="modal-actions" style="margin-top:16px;">',
      '      <button class="btn btn-ghost" id="rBtnDelete" style="color:var(--red,#FF6B6B);">Удалить</button>',
      '      <div style="flex:1;"></div>',
      '      <button class="btn btn-primary" id="rBtnTest">📊 Отправить тестовый отчёт</button>',
      '      <button class="btn btn-primary" id="rBtnSave">Сохранить</button>',
      '    </div>',
      '',
      '  </div>',
      '</div>'
    ].join('\n');

    var container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container.firstElementChild);
  }

  /* ── Инъекция кнопки в тулбар ── */
  function _injectToolbarButton() {
    var actions = document.querySelector('.ft-actions.toolbar');
    if (!actions) return;
    if (document.getElementById('btnReports')) return;

    var btn = document.createElement('button');
    btn.className = 'icon-btn ft-btn';
    btn.id = 'btnReports';
    btn.title = 'Отчёты';
    btn.textContent = '📊';

    // Вставляем перед кнопкой справки
    var helpBtn = document.getElementById('btnHelpModal');
    if (helpBtn) {
      actions.insertBefore(btn, helpBtn);
    } else {
      actions.appendChild(btn);
    }

    btn.addEventListener('click', function() {
      var db = window.getActiveDashboard ? getActiveDashboard() : null;
      if (!db || !db.id || db.id.startsWith('temp_')) {
        toast('Сначала сохраните дашборд (войдите в кабинет)');
        return;
      }
      if (window.ReportsModal) {
        ReportsModal.open(db.id);
      }
    });
  }

  /* ── Инициализация ── */
  function _init() {
    _injectModalHtml();
    // Привязываем обработчики модалки ПОСЛЕ инъекции HTML
    if (window.ReportsModal && typeof window.ReportsModal.bindEvents === 'function') {
      window.ReportsModal.bindEvents();
    }
    // Кнопку инжектим при смене вида на dashboard
    // Слушаем hashchange
    window.addEventListener('hashchange', function() {
      if (location.hash.indexOf('#dashboard') === 0 || location.hash.indexOf('#view') === 0) {
        setTimeout(_injectToolbarButton, 500);
      }
    });
    // Также при DOMContentLoaded если уже на dashboard
    if (location.hash.indexOf('#dashboard') === 0 || location.hash.indexOf('#view') === 0) {
      setTimeout(_injectToolbarButton, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})();

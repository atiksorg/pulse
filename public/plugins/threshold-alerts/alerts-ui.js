/* ═══════════════════════════════════════════════════
   public/plugins/threshold-alerts/alerts-ui.js
   Инъекция HTML модалки + публичная точка входа AlertsUI.open(panel, dashboardId)
   Зависит от: core.js, alerts-modal.js
   ═══════════════════════════════════════════════════ */
'use strict';

(function() {

  function _injectModalHtml() {
    if (document.getElementById('alertsModal')) return;

    var html = [
      '<div class="overlay" id="alertsModal">',
      '  <div class="modal" style="max-width:560px;max-height:90vh;overflow-y:auto;">',

      '    <!-- Шапка -->',
      '    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">',
      '      <div style="flex:1;min-width:0;">',
      '        <h2 style="margin:0;font-size:18px;letter-spacing:-0.3px;">🔔 Пороговые уведомления</h2>',
      '        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">',
      '          <span id="aPanelTitle" style="font-size:13px;color:var(--muted);font-weight:500;">—</span>',
      '          <span style="color:var(--muted-2);">·</span>',
      '          <span id="aStatus" style="font-size:11px;color:var(--muted-2);font-family:var(--mono);">—</span>',
      '        </div>',
      '      </div>',
      '      <button class="btn btn-ghost" id="aCloseBtn" style="flex-shrink:0;">✕</button>',
      '    </div>',

      '    <!-- Tabs -->',
      '    <div style="display:flex;gap:2px;margin-bottom:20px;background:var(--card-bg,#141921);border-radius:8px;padding:3px;">',
      '      <button class="btn btn-ghost atab active" data-tab="settings" style="flex:1;border-radius:6px;font-size:13px;padding:7px 12px;">⚙️ Настройки</button>',
      '      <button class="btn btn-ghost atab" data-tab="history" style="flex:1;border-radius:6px;font-size:13px;padding:7px 12px;">📋 История</button>',
      '    </div>',

      '    <!-- Pane: Settings -->',
      '    <div class="atab-pane active" data-pane="settings">',

      '      <!-- ── Секция: Правило ── -->',
      '      <div style="margin-bottom:16px;">',
      '        <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">',
      '          <span style="font-size:13px;">📝</span>',
      '          <span style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Правило</span>',
      '        </div>',
      '        <div class="field-row">',
      '          <div class="field" style="flex:1;">',
      '            <label>Название</label>',
      '            <input id="a_label" placeholder="например: Выручка за день">',
      '          </div>',
      '        </div>',
      '        <div class="field-row">',
      '          <div class="field">',
      '            <label>Агрегация</label>',
      '            <select id="a_agg">',
      '              <option value="count">Количество событий</option>',
      '              <option value="sum">Сумма поля</option>',
      '              <option value="avg">Среднее поля</option>',
      '              <option value="max">Максимум поля</option>',
      '              <option value="min">Минимум поля</option>',
      '            </select>',
      '          </div>',
      '          <div class="field" id="a_aggfieldRow">',
      '            <label>Поле (payload)</label>',
      '            <input id="a_aggfield" placeholder="amount">',
      '          </div>',
      '        </div>',
      '        <div class="field-row">',
      '          <div class="field">',
      '            <label>Диапазон</label>',
      '            <select id="a_range">',
      '              <option value="24h">24 часа</option>',
      '              <option value="7d">7 дней</option>',
      '              <option value="30d">30 дней</option>',
      '              <option value="all">Всё время</option>',
      '            </select>',
      '          </div>',
      '        </div>',
      '      </div>',

      '      <!-- ── Секция: Пороги ── -->',
      '      <div style="margin-bottom:16px;padding-top:16px;border-top:1px solid var(--border,#1A2130);">',
      '        <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">',
      '          <span style="font-size:13px;">📊</span>',
      '          <span style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Пороги</span>',
      '        </div>',
      '        <div class="field-row">',
      '          <div class="field">',
      '            <label>Минимум (норма от)</label>',
      '            <input id="a_minValue" type="number" step="any" placeholder="не ограничено">',
      '          </div>',
      '          <div class="field">',
      '            <label>Максимум (норма до)</label>',
      '            <input id="a_maxValue" type="number" step="any" placeholder="не ограничено">',
      '          </div>',
      '        </div>',
      '        <div id="aLastValue" style="font-size:11px;color:var(--muted-2);margin:4px 0 0 2px;"></div>',
      '      </div>',

      '      <!-- ── Секция: Telegram ── -->',
      '      <div style="margin-bottom:16px;padding-top:16px;border-top:1px solid var(--border,#1A2130);">',
      '        <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">',
      '          <span style="font-size:13px;">💬</span>',
      '          <span style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Telegram</span>',
      '        </div>',
      '        <div class="field-row">',
      '          <div class="field" style="flex:1;">',
      '            <label>Bot Token</label>',
      '            <div style="position:relative;">',
      '              <input id="a_tgToken" type="password" placeholder="••••••••" style="padding-right:34px;width:100%;box-sizing:border-box;">',
      '              <button type="button" class="eye-btn" data-target="a_tgToken" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:14px;padding:4px;line-height:1;">👁</button>',
      '            </div>',
      '          </div>',
      '        </div>',
      '        <div class="field-row">',
      '          <div class="field" style="flex:1;">',
      '            <label>Chat ID(s)</label>',
      '            <input id="a_chatIds" placeholder="323994801 (через запятую)">',
      '          </div>',
      '        </div>',
      '      </div>',

      '      <!-- ── Секция: Расписание ── -->',
      '      <div style="margin-bottom:16px;padding-top:16px;border-top:1px solid var(--border,#1A2130);">',
      '        <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">',
      '          <span style="font-size:13px;">⏱</span>',
      '          <span style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Расписание</span>',
      '        </div>',
      '        <div class="field-row">',
      '          <div class="field">',
      '            <label>Проверять каждые (сек)</label>',
      '            <input id="a_checkInterval" type="number" min="30" value="60">',
      '          </div>',
      '          <div class="field">',
      '            <label>Пауза между повторами (мин)</label>',
      '            <input id="a_cooldown" type="number" min="1" value="15">',
      '          </div>',
      '        </div>',
      '        <div style="margin-top:4px;display:flex;flex-direction:column;gap:8px;">',
      '          <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;">',
      '            <input type="checkbox" id="a_notifyRecovery" checked>',
      '            <span>Уведомлять о возврате в норму</span>',
      '          </label>',
      '          <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;">',
      '            <input type="checkbox" id="a_isActive">',
      '            <span>Правило активно</span>',
      '          </label>',
      '        </div>',
      '      </div>',

      '      <!-- Кнопки -->',
      '      <div style="display:flex;gap:8px;margin-top:20px;padding-top:16px;border-top:1px solid var(--border,#1A2130);flex-wrap:wrap;">',
      '        <button class="btn" id="aBtnSave">💾 Сохранить</button>',
      '        <button class="btn btn-ghost" id="aBtnTest">📨 Проверить сейчас</button>',
      '        <button class="btn btn-ghost" id="aBtnDelete" style="color:var(--coral,#F2664F);display:none;margin-left:auto;">🗑 Удалить</button>',
      '      </div>',
      '    </div>',

      '    <!-- Pane: History -->',
      '    <div class="atab-pane" data-pane="history">',
      '      <div id="aHistoryBody"></div>',
      '    </div>',

      '  </div>',
      '</div>'
    ].join('');

    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstChild);
  }

  /* ── Публичная точка входа: открыть модалку для панели ── */
  function openForPanel(panel, dashboardId) {
    _injectModalHtml();
    if (window.AlertsModal && typeof window.AlertsModal.bindEvents === 'function') {
      window.AlertsModal.bindEvents();
    }
    if (window.AlertsModal) window.AlertsModal.open(panel, dashboardId);
  }

  window.AlertsUI = { open: openForPanel };

})();

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
      '    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">',
      '      <div><h2 style="margin:0;">🔔 Пороговые уведомления</h2>',
      '      <div style="font-size:12px;color:var(--muted-2);margin-top:2px;" id="aPanelTitle">—</div>',
      '      <span id="aStatus" style="font-size:11px;color:var(--muted-2);font-family:var(--mono);">—</span></div>',
      '      <button class="btn btn-ghost" id="aCloseBtn">✕</button>',
      '    </div>',

      '    <div style="display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--border,#1A2130);padding-bottom:8px;">',
      '      <button class="btn btn-ghost atab active" data-tab="settings">Настройки</button>',
      '      <button class="btn btn-ghost atab" data-tab="history">История</button>',
      '    </div>',

      '    <div class="atab-pane active" data-pane="settings">',
      '      <div class="field-row">',
      '        <div class="field" style="flex:1;">',
      '          <label>Название правила</label>',
      '          <input id="a_label" placeholder="например: Выручка за день">',
      '        </div>',
      '      </div>',

      '      <div class="field-row">',
      '        <div class="field">',
      '          <label>Агрегация</label>',
      '          <select id="a_agg">',
      '            <option value="count">Количество событий</option>',
      '            <option value="sum">Сумма поля</option>',
      '            <option value="avg">Среднее поля</option>',
      '            <option value="max">Максимум поля</option>',
      '            <option value="min">Минимум поля</option>',
      '          </select>',
      '        </div>',
      '        <div class="field" id="a_aggfieldRow">',
      '          <label>Поле (payload)</label>',
      '          <input id="a_aggfield" placeholder="amount">',
      '        </div>',
      '      </div>',

      '      <div class="field-row">',
      '        <div class="field">',
      '          <label>Диапазон данных</label>',
      '          <select id="a_range">',
      '            <option value="24h">Последние 24 часа</option>',
      '            <option value="7d">Последние 7 дней</option>',
      '            <option value="30d">Последние 30 дней</option>',
      '            <option value="all">Всё время</option>',
      '          </select>',
      '        </div>',
      '      </div>',

      '      <div class="field-row">',
      '        <div class="field">',
      '          <label>Минимум (норма от)</label>',
      '          <input id="a_minValue" type="number" step="any" placeholder="не ограничено">',
      '        </div>',
      '        <div class="field">',
      '          <label>Максимум (норма до)</label>',
      '          <input id="a_maxValue" type="number" step="any" placeholder="не ограничено">',
      '        </div>',
      '      </div>',
      '      <div id="aLastValue" style="font-size:11px;color:var(--muted-2);margin:-6px 0 12px 2px;"></div>',

      '      <div style="margin-top:8px;padding-top:12px;border-top:1px solid var(--border,#1A2130);">',
      '        <div class="field-row">',
      '          <div class="field" style="flex:1;">',
      '            <label>Telegram Bot Token</label>',
      '            <div style="position:relative;">',
      '              <input id="a_tgToken" type="password" placeholder="••••••••" style="padding-right:34px;width:100%;box-sizing:border-box;">',
      '              <button type="button" class="eye-btn" data-target="a_tgToken" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:14px;padding:4px;line-height:1;">👁</button>',
      '            </div>',
      '          </div>',
      '        </div>',
      '        <div class="field-row">',
      '          <div class="field" style="flex:1;">',
      '            <label>Telegram Chat ID(s)</label>',
      '            <input id="a_chatIds" placeholder="323994801 (через запятую)">',
      '          </div>',
      '        </div>',
      '      </div>',

      '      <div style="margin-top:8px;padding-top:12px;border-top:1px solid var(--border,#1A2130);">',
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
      '        <div class="field-row">',
      '          <div class="field">',
      '            <label style="display:flex;align-items:center;gap:8px;">',
      '              <input type="checkbox" id="a_notifyRecovery" checked> Уведомлять о возврате в норму',
      '            </label>',
      '          </div>',
      '        </div>',
      '        <div class="field-row">',
      '          <div class="field">',
      '            <label style="display:flex;align-items:center;gap:8px;">',
      '              <input type="checkbox" id="a_isActive"> Правило активно',
      '            </label>',
      '          </div>',
      '        </div>',
      '      </div>',

      '      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">',
      '        <button class="btn" id="aBtnSave">💾 Сохранить</button>',
      '        <button class="btn btn-ghost" id="aBtnTest">📨 Проверить сейчас</button>',
      '        <button class="btn btn-ghost" id="aBtnDelete" style="color:var(--coral,#F2664F);display:none;margin-left:auto;">🗑 Удалить</button>',
      '      </div>',
      '    </div>',

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

/* ═══════════════════════════════════════════════════
   dashboard-init.js — initDashboard, табы, часы, тулбар,
   onboarding banner, FAB, fullscreen-overlay binding
   Зависит от: core.js, interactive-canvas.js, panels-render.js,
               panels-canvas.js, panels-edit.js
   ═══════════════════════════════════════════════════ */

/* ── initDashboard ───────────────────────────────── */
async function initDashboard(){
  var params = new URLSearchParams(location.hash.split('?')[1] || '');
  var urlDbId = params.get('id');
  if (urlDbId) {
    AppState.activeId = urlDbId;
  }

  // Восстанавливаем кнопки floating-toolbar (share.js мог их заменить)
  var ftActions = document.querySelector('.ft-actions.toolbar');
  if(ftActions){
    ftActions.innerHTML =
      '<button class="icon-btn ft-btn" id="btnFitView" title="Уместить холст">⤢</button>' +
      '<button class="icon-btn ft-btn ft-layout-btn" id="btnArrangeLayout" title="Выстроить графики">▦</button>' +
      '<button class="icon-btn ft-btn" id="btnRefreshAll" title="Обновить">↻</button>' +
      '<button class="icon-btn ft-btn" id="btnExport" title="Экспорт CSV">↓</button>' +
      '<button class="icon-btn ft-btn" id="btnShare" title="Поделиться">🔗</button>' +
      '<button class="icon-btn ft-btn ft-theme-btn" id="btnThemeToggle" title="Сменить тему">◐</button>' +
      '<button class="icon-btn ft-btn ft-help-btn" id="btnHelpModal" title="Справка">?</button>' +
      '<button class="icon-btn ft-btn ft-add-btn" id="btnAddPanel" title="Добавить панель">+</button>';
  }
  // Восстанавливаем видимость табов
  var dashTabsEl = document.getElementById('dashTabs');
  if(dashTabsEl) dashTabsEl.style.display = '';

  $('#viewBanner').innerHTML = '';
  $('#btnFitView').onclick = function(){ resetCanvasView(); };
  $('#btnArrangeLayout').onclick = function(){ arrangeAndFitCanvas(); };
  $('#btnRefreshAll').onclick = function(){ renderPanels(); };
  $('#btnExport').onclick = exportCsv;
  $('#btnShare').onclick = function(){ showShareModal(); };
  $('#btnAddPanel').onclick = openAddPanel;

  // Кнопка темы — цикл по доступным темам
  var themeBtn = document.getElementById('btnThemeToggle');
  if(themeBtn && typeof cycleTheme === 'function'){
    themeBtn.onclick = function(){ cycleTheme(); };
  }

  // Справка → модалка
  var helpBtn = document.getElementById('btnHelpModal');
  if(helpBtn){
    helpBtn.onclick = function(){
      document.getElementById('helpModal').classList.add('active');
    };
  }
  var helpClose = document.getElementById('btnCloseHelp');
  if(helpClose){
    helpClose.onclick = function(){
      document.getElementById('helpModal').classList.remove('active');
    };
  }

  // ── Компактные часы в шапке (с миллисекундами) ──
  _initTopbarClock();

  // Auto-hide floating toolbar
  _initFloatingToolbarAutoHide();

  // FAB — плавающая кнопка на мобилках
  var fab = document.getElementById('fabAddPanel');
  if(fab){
    fab.style.display = isMobile() ? 'flex' : 'none';
    fab.onclick = openAddPanel;
  }

  try {
    await loadDashboardsFromServer();
    await loadSuggestionsFromServer();
  } catch(e) {
    toast('Ошибка загрузки данных: ' + e.message);
  }

  renderDashTabs();
  renderPanels();

  // Автоматически центрируем холст при входе в дашборд
  // (даём время загрузиться графикам, затем fitToContent)
  setTimeout(function(){ resetCanvasView(true); }, 400);
}

/* ── Topbar clock (compact, with milliseconds) ─── */
var _topbarClockRAF = null;
function _initTopbarClock(){
  // Удаляем старый элемент если есть
  var old = document.getElementById('topbarClock');
  if(old) old.remove();
  cancelAnimationFrame(_topbarClockRAF);

  var sessionEl = document.getElementById('sessionIndicator');
  var topbar = document.querySelector('.topbar');
  if(!topbar) return;

  var el = document.createElement('div');
  el.className = 'topbar-clock';
  el.id = 'topbarClock';
  // Вставляем перед sessionIndicator или в конец topbar
  if(sessionEl && sessionEl.parentNode === topbar){
    topbar.insertBefore(el, sessionEl);
  } else {
    topbar.appendChild(el);
  }

  var _tzStr = getUtcOffsetStr();
  var _tzLabel = document.createElement('span');
  _tzLabel.className = 'tc-zone';
  _tzLabel.textContent = _tzStr;
  el.appendChild(_tzLabel);

  var _timeSpan = document.createElement('span');
  _timeSpan.className = 'tc-time';
  el.appendChild(_timeSpan);

  // Индикатор дрифта (если > 2 сек)
  var _driftBadge = document.createElement('span');
  _driftBadge.className = 'tc-drift';
  _driftBadge.style.display = 'none';
  el.appendChild(_driftBadge);

  function tick(){
    var now = new Date();
    var hh = String(now.getHours()).padStart(2,'0');
    var mm = String(now.getMinutes()).padStart(2,'0');
    var ss = String(now.getSeconds()).padStart(2,'0');
    _timeSpan.textContent = hh+':'+mm+':'+ss;

    // Показываем дрифт сервера если > 2 сек
    if(Math.abs(_serverDriftMs) > 2000){
      var driftSec = Math.round(Math.abs(_serverDriftMs) / 1000);
      var driftMin = Math.floor(driftSec / 60);
      var driftRem = driftSec % 60;
      _driftBadge.style.display = '';
      if(driftMin > 0){
        _driftBadge.textContent = 'сервер отстаёт на ' + driftMin + ' мин ' + driftRem + ' сек';
      } else {
        _driftBadge.textContent = 'сервер: ±' + driftSec + ' сек';
      }
      _driftBadge.className = 'tc-drift' + (driftSec > 30 ? ' tc-drift-warn' : '');
    } else {
      _driftBadge.style.display = 'none';
    }

    _topbarClockRAF = requestAnimationFrame(tick);
  }
  tick();
}

/* ── Floating Toolbar: auto-hide logic ──────────── */
var _ftHideTimer = null;
var _ftShowTimer = null;
var _ftGlobalMouseMoveBound = false;

function _initFloatingToolbarAutoHide(){
  var toolbar = document.getElementById('floatingToolbar');
  if(!toolbar) return;
  if(isMobile()) return; // на мобилках не скрываем

  // Начальное состояние: видна
  toolbar.classList.remove('hidden');

  toolbar.addEventListener('mouseenter', function(){
    clearTimeout(_ftHideTimer);
    toolbar.classList.remove('hidden');
  });

  toolbar.addEventListener('mouseleave', function(){
    clearTimeout(_ftHideTimer);
    _ftHideTimer = setTimeout(function(){
      toolbar.classList.add('hidden');
    }, 600);
  });

  // Глобальный mousemove: показываем toolbar при движении мыши в верхней трети экрана
  if(!_ftGlobalMouseMoveBound){
    _ftGlobalMouseMoveBound = true;
    document.addEventListener('mousemove', function(e){
      if(isMobile()) return;
      if(e.clientY < window.innerHeight * 0.25){
        toolbar.classList.remove('hidden');
        clearTimeout(_ftHideTimer);
        _ftHideTimer = setTimeout(function(){
          toolbar.classList.add('hidden');
        }, 1800);
      }
    }, { passive: true });
  }
}

/* ── Dash tabs ───────────────────────────────────── */
function renderDashTabs(){
  var list = AppState.dashboards;
  var activeId = AppState.activeId;
  var el = $('#dashTabs');
  el.innerHTML = '';
  list.forEach(function(db){
    var b = document.createElement('button');
    b.className = 'dash-tab' + (db.id===activeId ? ' active':'');
    b.textContent = db.name;
    b.onclick = function(){ setActiveId(db.id); renderDashTabs(); renderPanels(); setTimeout(function(){ resetCanvasView(true); }, 400); };
    b.ondblclick = async function(){
      var name = await inputModal('Название дашборда', 'Введите название', db.name);
      if(name){
        db.name = name;
        try {
          await updateDashboardOnServer(db);
          renderDashTabs();
        } catch(e) { toast('Ошибка сохранения: ' + e.message); }
      }
    };
    b.oncontextmenu = async function(e){
      e.preventDefault();
      if(list.length<=1){ toast('Нельзя удалить единственный дашборд'); return; }
      if(await confirmModal('Удалить дашборд?','Удалить «'+db.name+'»?')){
        try {
          await deleteDashboardOnServer(db.id);
          renderDashTabs();
          renderPanels();
          setTimeout(function(){ resetCanvasView(true); }, 400);
          toast('Удалён');
        } catch(err) { toast('Ошибка удаления: ' + err.message); }
      }
    };
    if(list.length > 1){
      var del = document.createElement('span');
      del.className = 'dash-tab-del'; del.textContent = '×'; del.title = 'Удалить';
      del.onclick = async function(e){
        e.stopPropagation();
        if(await confirmModal('Удалить дашборд?','«'+db.name+'»?')){
          try {
            await deleteDashboardOnServer(db.id);
            renderDashTabs();
            renderPanels();
            setTimeout(function(){ resetCanvasView(true); }, 400);
            toast('Удалён');
          } catch(err) { toast('Ошибка удаления: ' + err.message); }
        }
      };
      b.appendChild(del);
    }
    el.appendChild(b);
  });
  var add = document.createElement('button');
  add.className = 'dash-tab dash-tab-add'; add.textContent = '+'; add.title = 'Новый дашборд';
  add.onclick = async function(){
    var name = await inputModal('Новый дашборд', 'Введите название', 'Новый дашборд');
    if(!name) return;
    try {
      var db = await createDashboardOnServer(name, [], 'grid');
      setActiveId(db.id);
      renderDashTabs();
      renderPanels();
      setTimeout(function(){ resetCanvasView(true); }, 400);
    } catch(e) { toast('Ошибка создания: ' + e.message); }
  };
  el.appendChild(add);
}

/* ═══════════════════════════════════════════════════
   mobile-core.js — Главный контроллер мобильной логики
   ─────────────────────────────────────────────────
   Загружается ТОЛЬКО при width < 860px + touch.
   Не изменяет ни одну строку существующего кода.
   Работает через Event Bridge: читает AppState,
   вызывает renderPanels(), перехватывает DOM-события.
   ═══════════════════════════════════════════════════ */

(function MobileCore(){
  'use strict';

  /* ── SVG Icons (inline, no external deps) ──────── */
  var ICONS = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
    cases: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    docs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
    profile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
    theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
    wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12c1.5-3 4-6 7-6s4 4 6 4 3-4 7-4"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    'delete': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5L12 2z"/><path d="M18 14l.75 2.25L21 17l-2.25.75L18 20l-.75-2.25L15 17l2.25-.75L18 14z"/></svg>',
    fullscreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
  };

  /* ── Haptic feedback helper ────────────────────── */
  function haptic(style){
    if(!navigator.vibrate) return;
    if(style === 'light') navigator.vibrate(10);
    else if(style === 'medium') navigator.vibrate(25);
    else if(style === 'heavy') navigator.vibrate([30, 10, 30]);
    else if(style === 'success') navigator.vibrate([10, 30, 10]);
    else if(style === 'error') navigator.vibrate([50, 30, 50]);
  }

  /* ── Detect touch device ───────────────────────── */
  function isTouchDevice(){
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  }

  /* ═══════════════════════════════════════════════════
     1. BOTTOM NAVIGATION BAR
     ═══════════════════════════════════════════════════ */
  function createBottomNav(){
    if(document.getElementById('mpBottomNav')) return;

    var nav = document.createElement('div');
    nav.className = 'mp-bottom-nav';
    nav.id = 'mpBottomNav';

    var items = [
      { id: 'mp-nav-dashboard', label: 'Дашборд', icon: 'dashboard', route: 'dashboard' },
      { id: 'mp-nav-cases', label: 'Кейсы', icon: 'cases', route: 'docs' },
      { id: 'mp-nav-add', label: '', icon: 'plus', action: 'add' },
      { id: 'mp-nav-docs', label: 'Документация', icon: 'docs', route: 'docs' },
      { id: 'mp-nav-profile', label: 'Профиль', icon: 'profile', route: 'docs' }
    ];

    items.forEach(function(item){
      var el = document.createElement('div');
      el.className = 'mp-nav-item' + (item.action === 'add' ? ' mp-nav-add' : '');
      el.id = item.id;
      el.innerHTML = '<div class="mp-nav-icon">' + ICONS[item.icon] + '</div>'
        + (item.label ? '<span>' + item.label + '</span>' : '');

      el.addEventListener('click', function(){
        haptic('light');
        if(item.action === 'add'){
          // Вызываем существующую функцию открытия модалки
          if(typeof openAddPanel === 'function') openAddPanel();
          return;
        }
        if(item.route === 'dashboard'){
          var sess = (typeof getSession === 'function') ? getSession() : null;
          if(!sess){
            location.hash = '#docs';
          } else {
            location.hash = '#dashboard';
          }
        } else {
          location.hash = '#' + item.route;
        }
      });

      nav.appendChild(el);
    });

    document.body.appendChild(nav);
    updateBottomNavActive();
  }

  function updateBottomNavActive(){
    var hash = location.hash.replace(/^#/, '').split('?')[0] || 'docs';
    var items = document.querySelectorAll('.mp-nav-item:not(.mp-nav-add)');
    items.forEach(function(el){
      el.classList.remove('active');
    });
    if(hash === 'dashboard' || hash === 'view' || hash === 'public'){
      var db = document.getElementById('mp-nav-dashboard');
      if(db) db.classList.add('active');
    } else if(hash === 'docs'){
      var docs = document.getElementById('mp-nav-docs');
      if(docs) docs.classList.add('active');
    }
  }

  /* ═══════════════════════════════════════════════════
     2. MOBILE HEADER — Dashboard Dropdown
     ═══════════════════════════════════════════════════ */
  var _mobileHeader = null;
  var _dropdownOpen = false;

  function createMobileHeader(){
    if(document.getElementById('mpDashHeader')) return;

    var header = document.createElement('div');
    header.className = 'mp-dash-header';
    header.id = 'mpDashHeader';

    // Left: brand + dropdown
    var left = document.createElement('div');
    left.className = 'mp-dash-header-left';

    var brand = document.createElement('a');
    brand.href = '#docs';
    brand.className = 'brand';
    brand.innerHTML = '<span class="dot"></span> pulse';
    left.appendChild(brand);

    // Dropdown
    var dropdown = document.createElement('div');
    dropdown.className = 'mp-dash-dropdown';
    dropdown.id = 'mpDashDropdown';

    var trigger = document.createElement('div');
    trigger.className = 'mp-dash-dropdown-trigger';
    trigger.innerHTML = '<span class="mp-dash-dropdown-name" id="mpDashName">—</span>'
      + '<span class="mp-dash-dropdown-arrow">' + ICONS.chevronDown + '</span>';

    var menu = document.createElement('div');
    menu.className = 'mp-dash-dropdown-menu';
    menu.id = 'mpDashMenu';

    dropdown.appendChild(trigger);
    dropdown.appendChild(menu);
    left.appendChild(dropdown);

    // Right: buttons
    var right = document.createElement('div');
    right.className = 'mp-dash-header-right';

    var btnRefresh = document.createElement('button');
    btnRefresh.className = 'mp-header-btn';
    btnRefresh.title = 'Обновить';
    btnRefresh.innerHTML = ICONS.refresh;
    btnRefresh.addEventListener('click', function(){
      haptic('light');
      if(typeof renderPanels === 'function') renderPanels();
    });

    var btnShare = document.createElement('button');
    btnShare.className = 'mp-header-btn';
    btnShare.title = 'Поделиться';
    btnShare.innerHTML = ICONS.share;
    btnShare.addEventListener('click', function(){
      haptic('light');
      if(typeof showShareModal === 'function') showShareModal();
    });

    var btnTheme = document.createElement('button');
    btnTheme.className = 'mp-header-btn';
    btnTheme.title = 'Тема';
    btnTheme.innerHTML = ICONS.theme;
    btnTheme.addEventListener('click', function(){
      haptic('light');
      if(typeof cycleTheme === 'function') cycleTheme();
    });

    right.appendChild(btnRefresh);
    right.appendChild(btnShare);
    right.appendChild(btnTheme);

    header.appendChild(left);
    header.appendChild(right);
    document.body.appendChild(header);
    _mobileHeader = header;

    // Dropdown toggle
    trigger.addEventListener('click', function(e){
      e.stopPropagation();
      haptic('light');
      _dropdownOpen = !_dropdownOpen;
      dropdown.classList.toggle('open', _dropdownOpen);
      if(_dropdownOpen) renderMobileDropdown();
    });

    // Close dropdown on outside click
    document.addEventListener('click', function(e){
      if(!e.target.closest('.mp-dash-dropdown')){
        _dropdownOpen = false;
        dropdown.classList.remove('open');
      }
    });
  }

  function renderMobileDropdown(){
    var menu = document.getElementById('mpDashMenu');
    if(!menu) return;
    menu.innerHTML = '';

    var dashboards = (typeof AppState !== 'undefined') ? AppState.dashboards : [];
    var activeId = (typeof AppState !== 'undefined') ? AppState.activeId : null;

    dashboards.forEach(function(db){
      var item = document.createElement('div');
      item.className = 'mp-dash-dropdown-item' + (db.id === activeId ? ' active' : '');
      item.innerHTML = '<span>' + (db.name || 'Без названия') + '</span>'
        + '<span class="mp-dd-check">✓</span>';

      item.addEventListener('click', function(e){
        e.stopPropagation();
        haptic('light');
        if(typeof setActiveId === 'function') setActiveId(db.id);
        if(typeof renderDashTabs === 'function') renderDashTabs();
        if(typeof renderPanels === 'function') renderPanels();
        _dropdownOpen = false;
        document.getElementById('mpDashDropdown').classList.remove('open');
        updateMobileHeaderName();
      });

      // Long press to delete
      var longPressTimer = null;
      item.addEventListener('touchstart', function(){
        longPressTimer = setTimeout(function(){
          haptic('heavy');
          longPressTimer = null;
          // Show delete option
          if(dashboards.length <= 1){
            if(typeof toast === 'function') toast('Нельзя удалить единственный дашборд');
            return;
          }
          if(typeof confirmModal === 'function'){
            confirmModal('Удалить дашборд?', '«' + db.name + '»?', 'Удалить').then(function(ok){
              if(ok && typeof deleteDashboardOnServer === 'function'){
                deleteDashboardOnServer(db.id).then(function(){
                  if(typeof renderDashTabs === 'function') renderDashTabs();
                  if(typeof renderPanels === 'function') renderPanels();
                  updateMobileHeaderName();
                  renderMobileDropdown();
                  if(typeof toast === 'function') toast('Удалён');
                }).catch(function(e){
                  if(typeof toast === 'function') toast('Ошибка: ' + e.message);
                });
              }
            });
          }
        }, 600);
      });
      item.addEventListener('touchend', function(){ clearTimeout(longPressTimer); });
      item.addEventListener('touchmove', function(){ clearTimeout(longPressTimer); });

      menu.appendChild(item);
    });

    // "New dashboard" button
    var addBtn = document.createElement('div');
    addBtn.className = 'mp-dash-dropdown-add';
    addBtn.innerHTML = '<span style="font-size:16px;">+</span> Новый дашборд';
    addBtn.addEventListener('click', function(e){
      e.stopPropagation();
      haptic('light');
      if(typeof inputModal === 'function'){
        inputModal('Новый дашборд', 'Введите название', 'Новый дашборд').then(function(name){
          if(!name) return;
          if(typeof createDashboardOnServer === 'function'){
            createDashboardOnServer(name, [], 'grid').then(function(db){
              if(typeof setActiveId === 'function') setActiveId(db.id);
              if(typeof renderDashTabs === 'function') renderDashTabs();
              if(typeof renderPanels === 'function') renderPanels();
              updateMobileHeaderName();
              renderMobileDropdown();
            }).catch(function(e){
              if(typeof toast === 'function') toast('Ошибка: ' + e.message);
            });
          }
        });
      }
    });
    menu.appendChild(addBtn);
  }

  function updateMobileHeaderName(){
    var nameEl = document.getElementById('mpDashName');
    if(!nameEl) return;
    var dashboards = (typeof AppState !== 'undefined') ? AppState.dashboards : [];
    var activeId = (typeof AppState !== 'undefined') ? AppState.activeId : null;
    var active = dashboards.find(function(d){ return d.id === activeId; });
    nameEl.textContent = active ? active.name : '—';
  }

  /* ═══════════════════════════════════════════════════
     3. BOTTOM SHEET — Panel context menu
     ═══════════════════════════════════════════════════ */
  var _sheetOverlay = null;

  function createSheetOverlay(){
    if(_sheetOverlay) return;
    _sheetOverlay = document.createElement('div');
    _sheetOverlay.className = 'mp-sheet-overlay';
    _sheetOverlay.id = 'mpSheetOverlay';
    _sheetOverlay.addEventListener('click', function(e){
      if(e.target === _sheetOverlay) closeBottomSheet();
    });
    document.body.appendChild(_sheetOverlay);
  }

  function showBottomSheet(panelId, panelTitle, items){
    createSheetOverlay();
    _sheetOverlay.innerHTML = '';

    var sheet = document.createElement('div');
    sheet.className = 'mp-sheet';

    // Handle
    var handle = document.createElement('div');
    handle.className = 'mp-sheet-handle';
    sheet.appendChild(handle);

    // Title
    if(panelTitle){
      var title = document.createElement('div');
      title.className = 'mp-sheet-title';
      title.textContent = panelTitle;
      sheet.appendChild(title);
    }

    // Items
    items.forEach(function(item){
      if(item.separator){
        var sep = document.createElement('div');
        sep.className = 'mp-sheet-sep';
        sheet.appendChild(sep);
        return;
      }
      var el = document.createElement('div');
      el.className = 'mp-sheet-item' + (item.danger ? ' danger' : '');
      el.innerHTML = (item.icon ? '<span>' + (ICONS[item.icon] || '') + '</span>' : '')
        + '<span>' + (item.label || '') + '</span>';
      el.addEventListener('click', function(){
        haptic('light');
        closeBottomSheet();
        if(typeof item.action === 'function') item.action();
      });
      sheet.appendChild(el);
    });

    _sheetOverlay.appendChild(sheet);
    _sheetOverlay.classList.add('active');
    haptic('medium');
  }

  function closeBottomSheet(){
    if(_sheetOverlay){
      _sheetOverlay.classList.remove('active');
      _sheetOverlay.innerHTML = '';
    }
  }

  /* ═══════════════════════════════════════════════════
     4. PANEL MENU INTERCEPT — Replace dropdown with Bottom Sheet
     ═══════════════════════════════════════════════════ */
  function interceptPanelMenus(){
    // Use event delegation on document for panel menu triggers
    document.addEventListener('click', function(e){
      var trigger = e.target.closest('[data-menu-trigger]');
      if(!trigger) return;
      e.preventDefault();
      e.stopPropagation();

      var card = trigger.closest('.panel-card');
      if(!card) return;

      // Find panel data from the card's body id
      var bodyEl = card.querySelector('.panel-body');
      if(!bodyEl) return;
      var bodyId = bodyEl.id; // "body-{panelId}"
      var panelId = bodyId ? bodyId.replace('body-', '') : null;
      if(!panelId) return;

      // Find panel in AppState
      var db = (typeof getActiveDashboard === 'function') ? getActiveDashboard() : null;
      if(!db) return;
      var panel = db.panels.find(function(p){ return p.id === panelId; });
      if(!panel) return;

      var src = (typeof getSrc === 'function') ? getSrc() : null;

      // Build sheet items from the dropdown menu items
      var dropdown = card.querySelector('.panel-menu-dropdown');
      if(!dropdown) return;

      var sheetItems = [];
      dropdown.querySelectorAll('.panel-menu-item').forEach(function(mi){
        var act = mi.getAttribute('data-act');
        var label = mi.querySelector('span') ? mi.querySelector('span').textContent : '';
        var isDanger = mi.classList.contains('danger');

        // Map act to icon
        var iconMap = {
          'edit': 'edit', 'lock': 'lock', 'duplicate': 'copy', 'refresh': 'refresh',
          'fullscreen': 'fullscreen', 'png': 'download', 'copy': 'clipboard',
          'smooth': 'wave', 'example': 'terminal', 'ai-optimize': 'sparkles',
          'ai-discover': 'sparkles', 'clear': 'trash', 'remove': 'delete'
        };

        sheetItems.push({
          icon: iconMap[act] || '',
          label: label,
          danger: isDanger,
          action: function(){
            // Trigger the original click handler
            mi.click();
          }
        });
      });

      showBottomSheet(panelId, panel.title || 'Панель', sheetItems);
    }, true); // Use capture to intercept before the original handler
  }

  /* ═══════════════════════════════════════════════════
     5. PULL-TO-REFRESH
     ═══════════════════════════════════════════════════ */
  var _pullIndicator = null;
  var _pullStartY = 0;
  var _pullActive = false;
  var _pullRefreshing = false;

  function initPullToRefresh(){
    // Create indicator
    _pullIndicator = document.createElement('div');
    _pullIndicator.className = 'mp-pull-indicator';
    _pullIndicator.id = 'mpPullIndicator';
    document.body.appendChild(_pullIndicator);

    var grid = document.getElementById('panelGrid');
    if(!grid) return;

    grid.addEventListener('touchstart', function(e){
      if(_pullRefreshing) return;
      // Only activate if scrolled to top
      if(grid.scrollTop > 5) return;
      _pullStartY = e.touches[0].clientY;
      _pullActive = true;
    }, { passive: true });

    grid.addEventListener('touchmove', function(e){
      if(!_pullActive || _pullRefreshing) return;
      var dy = e.touches[0].clientY - _pullStartY;
      if(dy > 30){
        _pullIndicator.classList.add('visible');
      } else {
        _pullIndicator.classList.remove('visible');
      }
    }, { passive: true });

    grid.addEventListener('touchend', function(){
      if(!_pullActive) return;
      _pullActive = false;
      if(_pullIndicator.classList.contains('visible') && !_pullRefreshing){
        _pullRefreshing = true;
        _pullIndicator.classList.remove('visible');
        _pullIndicator.classList.add('refreshing');
        haptic('medium');
        if(typeof renderPanels === 'function'){
          renderPanels();
        }
        setTimeout(function(){
          _pullRefreshing = false;
          _pullIndicator.classList.remove('refreshing');
          if(typeof toast === 'function') toast('Обновлено');
        }, 1200);
      } else {
        _pullIndicator.classList.remove('visible');
      }
    }, { passive: true });
  }

  /* ═══════════════════════════════════════════════════
     6. SWIPE BETWEEN DASHBOARDS
     ═══════════════════════════════════════════════════ */
  var _swipeStartX = 0;
  var _swipeStartY = 0;
  var _swipeActive = false;
  var _swipeHintLeft = null;
  var _swipeHintRight = null;

  function initDashboardSwipe(){
    // Create swipe hints
    _swipeHintLeft = document.createElement('div');
    _swipeHintLeft.className = 'mp-swipe-hint left';
    _swipeHintLeft.textContent = '‹';
    document.body.appendChild(_swipeHintLeft);

    _swipeHintRight = document.createElement('div');
    _swipeHintRight.className = 'mp-swipe-hint right';
    _swipeHintRight.textContent = '›';
    document.body.appendChild(_swipeHintRight);

    var grid = document.getElementById('panelGrid');
    if(!grid) return;

    grid.addEventListener('touchstart', function(e){
      _swipeStartX = e.touches[0].clientX;
      _swipeStartY = e.touches[0].clientY;
      _swipeActive = true;
    }, { passive: true });

    grid.addEventListener('touchmove', function(e){
      if(!_swipeActive) return;
      var dx = e.touches[0].clientX - _swipeStartX;
      var dy = e.touches[0].clientY - _swipeStartY;
      // Only horizontal swipe (dx > dy)
      if(Math.abs(dx) < 20 || Math.abs(dy) > Math.abs(dx)) return;

      var dashboards = (typeof AppState !== 'undefined') ? AppState.dashboards : [];
      var activeIdx = dashboards.findIndex(function(d){
        return d.id === (typeof AppState !== 'undefined' ? AppState.activeId : null);
      });

      if(dx > 40 && activeIdx > 0){
        _swipeHintLeft.classList.add('visible');
      } else {
        _swipeHintLeft.classList.remove('visible');
      }
      if(dx < -40 && activeIdx < dashboards.length - 1){
        _swipeHintRight.classList.add('visible');
      } else {
        _swipeHintRight.classList.remove('visible');
      }
    }, { passive: true });

    grid.addEventListener('touchend', function(e){
      if(!_swipeActive) return;
      _swipeActive = false;
      _swipeHintLeft.classList.remove('visible');
      _swipeHintRight.classList.remove('visible');

      var dx = e.changedTouches[0].clientX - _swipeStartX;
      if(Math.abs(dx) < 60) return;

      var dashboards = (typeof AppState !== 'undefined') ? AppState.dashboards : [];
      var activeIdx = dashboards.findIndex(function(d){
        return d.id === (typeof AppState !== 'undefined' ? AppState.activeId : null);
      });

      if(dx > 60 && activeIdx > 0){
        // Swipe right → previous dashboard
        haptic('light');
        var prev = dashboards[activeIdx - 1];
        if(typeof setActiveId === 'function') setActiveId(prev.id);
        if(typeof renderDashTabs === 'function') renderDashTabs();
        if(typeof renderPanels === 'function') renderPanels();
        updateMobileHeaderName();
      } else if(dx < -60 && activeIdx < dashboards.length - 1){
        // Swipe left → next dashboard
        haptic('light');
        var next = dashboards[activeIdx + 1];
        if(typeof setActiveId === 'function') setActiveId(next.id);
        if(typeof renderDashTabs === 'function') renderDashTabs();
        if(typeof renderPanels === 'function') renderPanels();
        updateMobileHeaderName();
      }
    }, { passive: true });
  }

  /* ═══════════════════════════════════════════════════
     7. PRESS & DRAG TOOLTIP — Chart value display
     ═══════════════════════════════════════════════════ */
  var _chartTooltip = null;
  var _pressTimer = null;
  var _pressTarget = null;

  function initPressDragTooltip(){
    _chartTooltip = document.createElement('div');
    _chartTooltip.className = 'mp-chart-tooltip';
    _chartTooltip.id = 'mpChartTooltip';
    _chartTooltip.innerHTML = '<div class="mp-chart-tooltip-label"></div><div class="mp-chart-tooltip-value"></div>';
    document.body.appendChild(_chartTooltip);

    document.addEventListener('touchstart', function(e){
      var canvas = e.target.closest('canvas');
      if(!canvas) return;

      var body = canvas.closest('.panel-body');
      if(!body) return;
      var bodyId = body.id;
      var panelId = bodyId ? bodyId.replace('body-', '') : null;
      if(!panelId) return;

      // Start long-press timer
      _pressTarget = { canvas: canvas, panelId: panelId };
      _pressTimer = setTimeout(function(){
        showChartTooltip(e.touches[0], _pressTarget);
      }, 200);
    }, { passive: true });

    document.addEventListener('touchmove', function(e){
      if(!_pressTarget) return;
      clearTimeout(_pressTimer);
      showChartTooltip(e.touches[0], _pressTarget);
    }, { passive: true });

    document.addEventListener('touchend', function(){
      clearTimeout(_pressTimer);
      _pressTarget = null;
      if(_chartTooltip) _chartTooltip.classList.remove('visible');
    }, { passive: true });
  }

  function showChartTooltip(touch, target){
    if(typeof charts === 'undefined' || !charts[target.panelId]) return;
    var chart = charts[target.panelId];
    if(!chart || !chart.canvas) return;

    var rect = chart.canvas.getBoundingClientRect();
    var x = touch.clientX - rect.left;
    var y = touch.clientY - rect.top;

    // Get elements at position
    var points = chart.getElementsAtEventForMode(
      { clientX: touch.clientX, clientY: touch.clientY, type: 'touchstart', target: chart.canvas },
      'nearest', { intersect: true }, false
    );

    if(points.length > 0){
      var idx = points[0].index;
      var dsIdx = points[0].datasetIndex;
      var label = chart.data.labels[idx] || '';
      var value = chart.data.datasets[dsIdx] ? chart.data.datasets[dsIdx].data[idx] : '';

      var labelEl = _chartTooltip.querySelector('.mp-chart-tooltip-label');
      var valueEl = _chartTooltip.querySelector('.mp-chart-tooltip-value');
      if(labelEl) labelEl.textContent = label;
      if(valueEl) valueEl.textContent = (typeof formatNum === 'function') ? formatNum(value) : value;

      _chartTooltip.style.left = Math.min(touch.clientX + 12, window.innerWidth - 160) + 'px';
      _chartTooltip.style.top = (touch.clientY - 60) + 'px';
      _chartTooltip.classList.add('visible');
    }
  }

  /* ═══════════════════════════════════════════════════
     8. OFFLINE INDICATOR
     ═══════════════════════════════════════════════════ */
  function initOfflineIndicator(){
    var bar = document.createElement('div');
    bar.className = 'mp-offline-bar';
    bar.id = 'mpOfflineBar';
    bar.textContent = '⚠ Нет подключения к интернету';
    document.body.appendChild(bar);

    function update(){
      bar.classList.toggle('visible', !navigator.onLine);
    }
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
  }

  /* ═══════════════════════════════════════════════════
     9. THEME-COLOR SYNC
     ═══════════════════════════════════════════════════ */
  function initThemeColorSync(){
    var meta = document.querySelector('meta[name="theme-color"]');
    if(!meta){
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    function update(){
      var theme = document.documentElement.getAttribute('data-theme') || 'dark';
      var colors = { dark: '#0B0F17', light: '#FFFFFF', 'high-contrast': '#000000' };
      meta.content = colors[theme] || '#0B0F17';
    }
    update();
    // Watch for theme changes
    var observer = new MutationObserver(function(mutations){
      mutations.forEach(function(m){
        if(m.attributeName === 'data-theme') update();
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  /* ═══════════════════════════════════════════════════
     10. HAPTIC FEEDBACK ON KEY ACTIONS
     ═══════════════════════════════════════════════════ */
  function initHapticFeedback(){
    // Intercept toast for success/error haptic
    if(typeof toast === 'function'){
      var origToast = toast;
      window.toast = function(msg){
        origToast(msg);
        if(msg && (msg.indexOf('✓') >= 0 || msg.indexOf('Скопировано') >= 0 || msg.indexOf('записано') >= 0 || msg.indexOf('Обновлено') >= 0)){
          haptic('success');
        } else if(msg && (msg.indexOf('Ошибка') >= 0 || msg.indexOf('✕') >= 0)){
          haptic('error');
        }
      };
    }
  }

  /* ═══════════════════════════════════════════════════
     11. HIDE DESKTOP-ONLY ELEMENTS
     ═══════════════════════════════════════════════════ */
  function hideDesktopElements(){
    // Hide the desktop floating toolbar (CSS does this too, but belt-and-suspenders)
    var toolbar = document.getElementById('floatingToolbar');
    if(toolbar) toolbar.style.display = 'none';

    // Hide FAB
    var fab = document.getElementById('fabAddPanel');
    if(fab) fab.style.display = 'none';

    // Hide desktop dash tabs
    var dashTabs = document.getElementById('dashTabs');
    if(dashTabs) dashTabs.style.display = 'none';
  }

  /* ═══════════════════════════════════════════════════
     12. SYNC WITH ROUTER — Update mobile UI on route change
     ═══════════════════════════════════════════════════ */
  function initRouterSync(){
    window.addEventListener('hashchange', function(){
      updateBottomNavActive();
      updateMobileHeaderName();
      hideDesktopElements();

      var hash = location.hash.replace(/^#/, '').split('?')[0] || 'docs';
      var isDashboard = (hash === 'dashboard' || hash === 'view' || hash === 'public');

      // Show/hide mobile header
      if(_mobileHeader){
        _mobileHeader.style.display = isDashboard ? 'flex' : 'none';
      }

      // Show/hide bottom nav
      var nav = document.getElementById('mpBottomNav');
      if(nav) nav.style.display = isDashboard ? 'flex' : 'none';
    });
  }

  /* ═══════════════════════════════════════════════════
     INIT — Bootstrap all mobile features
     ═══════════════════════════════════════════════════ */
  function init(){
    // Wait for DOM ready
    if(document.readyState === 'loading'){
      document.addEventListener('DOMContentLoaded', init);
      return;
    }

    // Only activate on touch devices with narrow screens
    if(!isTouchDevice()) return;

    createBottomNav();
    createMobileHeader();
    interceptPanelMenus();
    initPullToRefresh();
    initDashboardSwipe();
    initPressDragTooltip();
    initOfflineIndicator();
    initThemeColorSync();
    initHapticFeedback();
    hideDesktopElements();
    initRouterSync();

    // Initial state
    updateBottomNavActive();
    updateMobileHeaderName();

    // Update header name when dashboards load
    var origRenderPanels = window.renderPanels;
    if(typeof origRenderPanels === 'function'){
      window.renderPanels = function(){
        origRenderPanels.apply(this, arguments);
        updateMobileHeaderName();
        hideDesktopElements();
      };
    }

    console.log('[Pulse Mobile] Initialized');
  }

  init();

})();

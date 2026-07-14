/* ═══════════════════════════════════════════════════
   panels-render.js — рендеринг панелей: renderPanels, viz, logs, table
   Зависит от: core.js, interactive-canvas.js, panels-canvas.js
   ═══════════════════════════════════════════════════ */

/* ── Стат-хелперы (range, URL, fetch) ────────────── */
function rangeToFromTo(range, p){
  var now = new Date();
  if(range==='all') return {};
  if(range==='custom'){ var r={}; if(p&&p.from) r.from=p.from; if(p&&p.to) r.to=p.to+'T23:59:59.999Z'; return r; }
  var from = new Date(now);
  if(range==='24h') from.setHours(from.getHours()-24);
  if(range==='7d') from.setDate(from.getDate()-7);
  if(range==='30d') from.setDate(from.getDate()-30);
  return { from: from.toISOString() };
}

function buildStatsUrl(src, p){
  var u = new URL(API + '/s');
  u.searchParams.set('src', src);
  if(p.type) u.searchParams.set('type', p.type);
  if(p.group==='__field'||p.group==='field'){ if(p.field) u.searchParams.set('group','field:'+p.field); }
  else if(p.group) u.searchParams.set('group', p.group);
  if(p.agg==='sum'&&p.aggfield) u.searchParams.set('agg','sum:'+p.aggfield);
  if(p.agg==='avg'&&p.aggfield) u.searchParams.set('agg','avg:'+p.aggfield);
  if(p.agg==='min'&&p.aggfield) u.searchParams.set('agg','min:'+p.aggfield);
  if(p.agg==='max'&&p.aggfield) u.searchParams.set('agg','max:'+p.aggfield);
  if(p.agg==='median'&&p.aggfield) u.searchParams.set('agg','median:'+p.aggfield);
  if(p.agg==='p95'&&p.aggfield) u.searchParams.set('agg','p95:'+p.aggfield);
  if(p.agg==='p99'&&p.aggfield) u.searchParams.set('agg','p99:'+p.aggfield);
  var rt = rangeToFromTo(p.range, p);
  if(rt.from) u.searchParams.set('from', rt.from);
  if(rt.to) u.searchParams.set('to', rt.to);
  if(p.sort && p.sort !== 'key') u.searchParams.set('sort', p.sort);
  if(p.limit && Number(p.limit) > 0) u.searchParams.set('limit', String(p.limit));
  if(Array.isArray(p.filters) && p.filters.length){
    u.searchParams.set('filters', JSON.stringify(p.filters));
  }
  if(p.breakdownfield){
    u.searchParams.set('breakdown', p.breakdownfield);
  }
  // Timezone offset (client's local offset in hours)
  var tz = -(new Date().getTimezoneOffset() / 60);
  if(tz !== 0) u.searchParams.set('tz', String(tz));
  return u.toString();
}

async function fetchStats(src, p){
  var url = buildStatsUrl(src, p);
  var res = await fetch(url);
  if(!res.ok) throw new Error('request failed');
  return res.json();
}

async function fetchLogs(src, p){
  var u = new URL(API + '/s');
  u.searchParams.set('src', src);
  u.searchParams.set('group', 'raw');
  u.searchParams.set('limit', '100');
  if(p.type) u.searchParams.set('type', p.type);
  var rt = rangeToFromTo(p.range, p);
  if(rt.from) u.searchParams.set('from', rt.from);
  if(rt.to) u.searchParams.set('to', rt.to);
  if(Array.isArray(p.filters) && p.filters.length){
    u.searchParams.set('filters', JSON.stringify(p.filters));
  }
  var res = await fetch(u.toString());
  if(!res.ok) throw new Error('request failed');
  return res.json();
}

/* ── Smart zero-fill for time series ────────────── */
function zeroFillGroups(groups, p){
  if(p.viz!=='line') return groups;
  if(p.group!=='day' && p.group!=='hour' && p.group!=='minute' && p.group!=='month') return groups;
  var key = panelKey(p);
  var map = {};
  groups.forEach(function(g){ map[String(g[key])] = g.value; });
  var labels = [];
  var now = new Date();
  var from = new Date(now);
  if(p.range==='24h') from.setHours(from.getHours()-24);
  else if(p.range==='7d') from.setDate(from.getDate()-7);
  else if(p.range==='30d') from.setDate(from.getDate()-30);
  else return groups;
  if(p.group==='minute'){
    var m = new Date(from);
    while(m <= now){
      var yyyy = m.getFullYear();
      var mm = String(m.getMonth()+1).padStart(2,'0');
      var dd = String(m.getDate()).padStart(2,'0');
      var hh = String(m.getHours()).padStart(2,'0');
      var mi = String(m.getMinutes()).padStart(2,'0');
      labels.push(yyyy+'-'+mm+'-'+dd+' '+hh+':'+mi);
      m.setMinutes(m.getMinutes()+5); // шаг 5 минут для минутных данных
    }
  } else if(p.group==='hour'){
    var h = new Date(from);
    while(h <= now){
      var lbl = String(h.getHours());
      labels.push(lbl);
      h.setHours(h.getHours()+1);
    }
  } else if(p.group==='day'){
    var d = new Date(from);
    d.setHours(0,0,0,0);
    while(d <= now){
      var yyyy = d.getFullYear();
      var mm = String(d.getMonth()+1).padStart(2,'0');
      var dd = String(d.getDate()).padStart(2,'0');
      labels.push(yyyy+'-'+mm+'-'+dd);
      d.setDate(d.getDate()+1);
    }
  } else if(p.group==='month'){
    var mo = new Date(from.getFullYear(), from.getMonth(), 1);
    while(mo <= now){
      var yyyy = mo.getFullYear();
      var mm = String(mo.getMonth()+1).padStart(2,'0');
      labels.push(yyyy+'-'+mm);
      mo.setMonth(mo.getMonth()+1);
    }
  }
  if(!labels.length) return groups;
  var firstServer = groups.length ? String(groups[0][key]) : '';
  if(firstServer && labels.indexOf(firstServer) === -1) return groups;
  return labels.map(function(lbl){
    return { bucket: lbl, value: map[lbl] !== undefined ? map[lbl] : 0 };
  }).map(function(g){
    var orig = groups.find(function(x){ return String(x[key]) === String(g.bucket); });
    return orig || g;
  });
}

/* ── Render panels (оркестратор) ─────────────────── */
function renderPanels(readonlyData){
  var grid = $('#panelGrid');
  grid.innerHTML = '';
  Object.values(refreshTimers).forEach(clearInterval);
  refreshTimers = {};
  var isShared = !!readonlyData;
  canvasMode = getLayoutMode();
  if(isShared && readonlyData.layoutMode !== undefined) canvasMode = readonlyData.layoutMode;
  document.body.classList.toggle('canvas-mode', canvasMode);
  var db = isShared ? readonlyData.dashboard : getActiveDashboard();
  var src = isShared ? readonlyData.src : getSrc();
  if (!db) { db = { id: uid('db'), name: 'Основной', panels: [] }; }
  if (!Array.isArray(db.panels)) db.panels = [];
  var panels = db.panels;
  if(canvasMode && panels.length && !panels[0].cx){ autoLayoutCanvas(panels); if(!isShared) updateDashboardOnServer(db).catch(function(){}); }

  // ── Заполняем cw/ch из пресетов если не заданы ──
  if(canvasMode){
    panels.forEach(function(p){
      var pr = getVizPreset(p.viz);
      if(!p.cw) p.cw = pr.cw;
      if(!p.ch) p.ch = pr.ch;
    });
  }

  // Запоминаем viewport ПЕРЕД уничтожением, если не был сохранён заранее
  if(canvasMode && !_savedCanvasViewport && interactiveCanvas && !interactiveCanvas._destroyed){
    _saveCanvasViewport();
  }

  if(interactiveCanvas){
    interactiveCanvas.destroy();
    interactiveCanvas = null;
  }

  if(!panels.length){
    grid.innerHTML = '<div class="empty-state"><h3>Дашборд пуст</h3><p>Чтобы увидеть данные, отправьте первое событие или выберите готовый шаблон.</p><div style="margin-top:20px;display:flex;gap:12px;justify-content:center;">'+(isShared?'':'<button class="btn btn-primary" id="btnEmptyAdd">+ Добавить панель</button>')+'<button class="btn btn-ghost" id="btnEmptyCase">Посмотреть кейсы</button></div></div>';
    if(!isShared) $('#btnEmptyAdd').onclick = openAddPanel;
    var btnCase = document.getElementById('btnEmptyCase');
    if(btnCase) btnCase.onclick=function(e){ e.preventDefault(); var m=document.getElementById('helpModal'); if(m) m.classList.add('active'); };
    return;
  }

  var surface = grid;
  if(canvasMode && !isMobile()){
    grid.innerHTML = '';
    var surfaceEl = document.createElement('div');
    surfaceEl.className = 'canvas-surface';
    grid.appendChild(surfaceEl);
    surface = surfaceEl;
    interactiveCanvas = new InteractiveCanvas(grid, surfaceEl, {
      minScale: 0.15,
      maxScale: 3.0,
      zoomSensitivity: 0.0015
    });

    // ── Crosshair: осевые линии в центре viewport ──
    var chH = document.createElement('div');
    chH.className = 'canvas-crosshair-h';
    grid.appendChild(chH);
    var chV = document.createElement('div');
    chV.className = 'canvas-crosshair-v';
    grid.appendChild(chV);
    var chDot = document.createElement('div');
    chDot.className = 'canvas-crosshair-dot';
    grid.appendChild(chDot);
  }

  panels.forEach(function(p){
    var card = document.createElement('div');
    card.className = 'panel-card' + (isShared ? ' readonly' : '') + (p.locked ? ' locked' : '');
    card.style.setProperty('--w', p.width||6);
    var panelMenuItems = [
      { act:'edit', icon:'edit', label:'Изменить', hidden: isShared },
      { act:'lock', icon:'lock', label: p.locked ? 'Разблокировать' : 'Закрепить', hidden: isShared },
      { act:'duplicate', icon:'copy', label:'Дублировать', hidden: isShared },
      { act:'refresh', icon:'refresh', label:'Обновить' },
      { act:'fullscreen', icon:'fullscreen', label:'Полный экран', hidden: isShared },
      { act:'png', icon:'download', label:'Экспорт PNG', hidden: isShared },
      { act:'copy', icon:'clipboard', label:'Копировать данные', hidden: isShared },
      { act:'smooth', icon:'wave', label:'Сглаживание', hidden: isShared },
      { act:'example', icon:'terminal', label:'Пример записи', hidden: isShared },
      { act:'ai-optimize', icon:'sparkles', label:'Оптимизировать (AI)', hidden: isShared },
      { act:'ai-discover', icon:'sparkles', label:'AI: построить дашборд из логов', hidden: isShared || p.viz !== 'logs' },
      { act:'clear', icon:'trash', label:'Очистить данные', danger: true, hidden: isShared },
      { act:'remove', icon:'delete', label:'Удалить панель', danger: true, hidden: isShared }
    ].filter(function(m){ return !m.hidden; });

    function panelMenuIcon(name){
      var icons = {
        edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
        copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
        fullscreen: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
        download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        clipboard: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
        wave: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12c1.5-3 4-6 7-6s4 4 6 4 3-4 7-4"/></svg>',
        terminal: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
        trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
        'delete': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
        ellipsis: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
        lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
        sparkles: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5L12 2z"/><path d="M18 14l.75 2.25L21 17l-2.25.75L18 20l-.75-2.25L15 17l2.25-.75L18 14z"/><path d="M5 17l.5 1.5L7 19l-1.5.5L5 21l-.5-1.5L3 19l1.5-.5L5 17z"/></svg>'
      };
      return icons[name] || '';
    }

    var menuHtml = panelMenuItems.map(function(m){
      return '<button class="panel-menu-item'+(m.danger?' danger':'')+'" data-act="'+m.act+'">'
        + panelMenuIcon(m.icon)
        + '<span>'+escapeHtml(m.label)+'</span>'
        + '</button>';
    }).join('');

    card.innerHTML = '<div class="panel-head"><div><h3>'+escapeHtml(p.title)+'</h3><div class="meta">'+describeMeta(p)+'</div></div></div>'
      +'<div class="panel-menu-floating">'
      +'<button class="pmbtn pmbtn-refresh" data-act="refresh-inline" title="Обновить">'+panelMenuIcon('refresh')+'</button>'
      +'<div class="panel-menu-wrap">'
      +'<button class="pmbtn pmbtn-trigger" data-menu-trigger title="Ещё">'+panelMenuIcon('ellipsis')+'</button>'
      +'<div class="panel-menu-dropdown">'+menuHtml+'</div>'
      +'</div></div>'
      +'<div class="panel-body" id="body-'+p.id+'"><div style="color:var(--muted-2);font-family:var(--mono);font-size:12px;">загрузка…</div></div>'
      +'<div class="panel-code-toggle" data-panel="'+p.id+'"><span class="pct-icon">▸</span> Пример записи данных</div>'
      +'<div class="panel-code-block" id="code-'+p.id+'" style="display:none;">'+buildPanelCodeTabs(p, src)+'</div>';
    surface.appendChild(card);

    var toggleEl = card.querySelector('.panel-code-toggle');
    var codeEl = card.querySelector('#code-'+p.id);
    toggleEl.onclick=function(){ var open=codeEl.style.display==='none'; codeEl.style.display=open?'block':'none'; toggleEl.querySelector('.pct-icon').textContent=open?'▾':'▸'; };
    codeEl.querySelectorAll('.pc-tab').forEach(function(tab){
      tab.onclick=function(ev){ ev.stopPropagation(); codeEl.querySelectorAll('.pc-tab').forEach(function(t){t.classList.remove('active');}); codeEl.querySelectorAll('.pc-panel').forEach(function(pp){pp.classList.remove('active');}); tab.classList.add('active'); var idx=tab.dataset.lang; var pan=codeEl.querySelector('#pc-'+p.id+'-'+idx); if(pan) pan.classList.add('active'); };
    });
    var cpyBtn = codeEl.querySelector('.pc-copy-btn');
    if(cpyBtn){ cpyBtn.onclick=function(ev){ ev.stopPropagation(); var act=codeEl.querySelector('.pc-panel.active pre'); if(act) navigator.clipboard.writeText(act.textContent).then(function(){cpyBtn.textContent='Скопировано!';setTimeout(function(){cpyBtn.textContent='Копировать';},1500);}); }; }

    card.querySelector('[data-act="refresh-inline"]').onclick=function(){loadPanel(p,src);};
    if(!isShared){
      // Делегируем обработчики меню к panels-edit.js (bindPanelMenuActions)
      if(typeof bindPanelMenuActions === 'function'){
        bindPanelMenuActions(card, p, src);
      }
    }
    // Dropdown menu toggle
    var menuTrigger = card.querySelector('[data-menu-trigger]');
    var menuDropdown = card.querySelector('.panel-menu-dropdown');
    if(menuTrigger && menuDropdown){
      menuTrigger.onclick = function(e){
        e.stopPropagation();
        var isOpen = menuDropdown.classList.contains('show');
        // Закрываем ВСЕ открытые dropdown и восстанавливаем z-index
        document.querySelectorAll('.panel-menu-dropdown.show').forEach(function(d){
          d.classList.remove('show');
        });
        if(_activeDropdownCard && _activeDropdownCard !== card){
          _restoreDropdownZIndex();
        }
        if(!isOpen){
          menuDropdown.classList.add('show');
          // Поднимаем карточку наверх, чтобы dropdown гарантированно был
          // поверх ВСЕХ соседних панелей (stacking context).
          // Используем CANVAS_Z_MAX напрямую — не wrap-around, не инкремент.
          if(canvasMode){
            _saveDropdownZIndex(card, p);
            card.style.zIndex = CANVAS_Z_MAX;
            p.cz = CANVAS_Z_MAX;
          }
        } else {
          // Меню закрывается — восстанавливаем z-index
          if(canvasMode){
            _restoreDropdownZIndex();
          }
        }
      };
    }
    if(!isShared){
      if(canvasMode){ applyCanvasPosition(card,p); initCanvasDrag(card,p); initCanvasResize(card,p); }
      else if(!isMobile()){
        card.draggable=true; card.dataset.panelId=p.id;
        card.addEventListener('dragstart',onDragStart); card.addEventListener('dragover',onDragOver); card.addEventListener('drop',onDrop); card.addEventListener('dragend',onDragEnd);
        var rh=document.createElement('div'); rh.className='panel-resize-handle'; rh.title='Ширина';
        rh.onclick=async function(){
          var w=[4,6,8,12],cur=p.width||6,idx=w.indexOf(cur),next=w[(idx+1)%w.length];
          p.width=next;
          card.style.setProperty('--w',next);
          var db2 = getActiveDashboard();
          if (db2) {
            var pp = db2.panels.find(function(x){return x.id===p.id;});
            if (pp) pp.width = next;
            try {
              await updateDashboardOnServer(db2);
              if(charts[p.id]) charts[p.id].resize();
            } catch(err) { toast('Ошибка сохранения: ' + err.message); }
          }
        };
        card.appendChild(rh);
      }
    } else if(canvasMode){
      applyCanvasPosition(card,p);
    }
    if(p.viz === 'logs') p._currentPage = 0;
    loadPanel(p,src);
    if(p.autorefresh && Number(p.autorefresh)>0 && !isShared) refreshTimers[p.id]=setInterval(function(){loadPanel(p,src);},Number(p.autorefresh)*1000 + Math.floor(Math.random()*3000));
  });

  // ── Восстанавливаем viewport после пересоздания холста ──
  if(canvasMode && !isMobile() && !isShared){
    _restoreCanvasViewport();
  }
}

/* ── loadPanel / renderViz / renderLogs ──────────── */
async function loadPanel(p, src){
  var body = document.getElementById('body-'+p.id);
  if(!body) return;
  // Если AI-оптимизация в процессе — не перезаписываем содержимое панели
  if(panelAiActive[p.id]) return;
  showSkeleton(body);
  try{
    if(p.viz==='logs'){ var d=await fetchLogs(src,p); hideSkeleton(body); renderLogs(p,d,body); }
    else {
      var d2=await fetchStats(src,p);
      function waitForChart(cb, attempts){
        attempts = attempts || 0;
        if(typeof Chart !== 'undefined'){ cb(); return; }
        if(attempts > 50){ hideSkeleton(body); body.innerHTML='<div style="color:var(--coral);font-family:var(--mono);font-size:12px;">Chart.js не загружен</div>'; return; }
        setTimeout(function(){ waitForChart(cb, attempts + 1); }, 100);
      }
      waitForChart(function(){ hideSkeleton(body); renderViz(p,d2,body); });
    }
  }catch(e){ hideSkeleton(body); body.innerHTML='<div style="color:var(--coral);font-family:var(--mono);font-size:12px;">Ошибка: '+e.message+'</div>'; }
}

/* ── Skeleton helpers ────────────────────────────── */
function showSkeleton(body){
  if(body.querySelector('.panel-skeleton')) return;
  var skel = document.createElement('div');
  skel.className = 'panel-skeleton';
  body.style.position = body.style.position || 'relative';
  body.appendChild(skel);
}
function hideSkeleton(body){
  var skel = body.querySelector('.panel-skeleton');
  if(skel) skel.remove();
}

var LOGS_PAGE_SIZE = 10;

function renderLogs(p, data, body){
  p._logsEvents = data.events || [];
  if (typeof p._currentPage === 'undefined') {
    p._currentPage = 0;
  }
  renderLogsPage(p, body);
}

/* ── Server clock drift ──────────────────────────── */
var _serverDriftMs = 0;

function formatLocalTime(utcIsoStr){
  if(!utcIsoStr) return '';
  try{
    var d = new Date(utcIsoStr);
    if(isNaN(d.getTime())) return utcIsoStr.replace('T',' ').replace(/\.\d+Z$/,'');
    var yyyy = d.getFullYear();
    var mm = String(d.getMonth()+1).padStart(2,'0');
    var dd = String(d.getDate()).padStart(2,'0');
    var hh = String(d.getHours()).padStart(2,'0');
    var mi = String(d.getMinutes()).padStart(2,'0');
    var ss = String(d.getSeconds()).padStart(2,'0');
    return yyyy+'-'+mm+'-'+dd+' '+hh+':'+mi+':'+ss;
  }catch(_){ return utcIsoStr; }
}

function getUtcOffsetStr(){
  var off = -new Date().getTimezoneOffset();
  var sign = off >= 0 ? '+' : '-';
  var abs = Math.abs(off);
  var h = String(Math.floor(abs/60)).padStart(2,'0');
  var m = String(abs%60).padStart(2,'0');
  return 'UTC'+sign+':'+h+':'+m;
}

function renderLogsPage(p, body){
  var events = p._logsEvents || [];
  if(!events.length){
    body.innerHTML = '<div class="logs-empty-state">'
      + '<div class="logs-empty-pulse"><span class="logs-empty-dot"></span> Ожидание первых событий в реальном времени…</div>'
      + '<div class="logs-empty-hint">Отправьте первый HTTP-запрос с вашим src, и он мгновенно появится в этой таблице.</div>'
      + '<div class="logs-empty-examples">'
      + '<div class="logs-empty-example"><code>type</code> — название действия (например: purchase, page_view, login)</div>'
      + '<div class="logs-empty-example">Любые дополнительные query-параметры превращаются в поля лога (например: <code>&amount=500&user=alex</code>)</div>'
      + '</div>'
      + '</div>';
    return;
  }
  var total = events.length;
  var totalPages = Math.ceil(total / LOGS_PAGE_SIZE);
  var page = p._currentPage || 0;
  if(page >= totalPages) page = totalPages - 1;
  if(page < 0) page = 0;
  p._currentPage = page;
  var slice = events.slice(page * LOGS_PAGE_SIZE, (page + 1) * LOGS_PAGE_SIZE);

  var newestTs = events[0] ? new Date(events[0].ts).getTime() : 0;
  if(newestTs > 0){
    _serverDriftMs = Date.now() - newestTs;
  }

  var html = '';
  html+='<div class="table-scroll-container"><div class="logs-wrap" style="flex:1;overflow-y:auto;padding-right:4px;">';
  html+='<table class="logs-table"><thead><tr><th class="logs-th-time">Время (' + escapeHtml(getUtcOffsetStr()) + ')</th><th class="logs-th-type">Тип</th><th class="logs-th-msg">Сообщение</th></tr></thead><tbody>';
  for(var i=0;i<slice.length;i++){ var ev=slice[i]; var msg=''; try{var pl=JSON.parse(ev.payload); msg=pl.text||pl.message||pl.msg||''; if(!msg){var keys=Object.keys(pl); msg=keys.slice(0,3).map(function(k){return k+'='+String(pl[k]);}).join(', ');} }catch(_){msg=ev.payload;} if(msg.length>120) msg=msg.slice(0,117)+'…'; var time=formatLocalTime(ev.ts); html+='<tr><td class="logs-time">'+escapeHtml(time)+'</td><td class="logs-type">'+escapeHtml(ev.type)+'</td><td class="logs-msg">'+escapeHtml(msg)+'</td></tr>'; }
  html+='</tbody></table></div></div>';

  html+='<div class="logs-pager">';
  html+='<button class="logs-pager-btn" data-dir="prev"'+(page<=0?' disabled':'')+'>&larr; Назад</button>';
  html+='<span class="logs-pager-info">Стр. '+(page+1)+' из '+totalPages+' <span style="color:var(--muted-2);">('+total+' событий)</span></span>';
  html+='<button class="logs-pager-btn" data-dir="next"'+(page>=totalPages-1?' disabled':'')+'>Вперёд &rarr;</button>';
  html+='</div>';

  body.innerHTML = html;

  body.querySelectorAll('.logs-pager-btn').forEach(function(btn){
    btn.onclick = function(){
      var dir = btn.dataset.dir;
      if(dir==='prev' && p._currentPage > 0) p._currentPage--;
      else if(dir==='next' && p._currentPage < totalPages - 1) p._currentPage++;
      renderLogsPage(p, body);
    };
  });
}

/* ── Render table with search & sort ────────────── */
function renderTableViz(p, groups, body, key){
  p._tableData = groups.slice(0, 200);
  p._tableSort = p._tableSort || { col: 'value', dir: 'desc' };
  p._tableSearch = p._tableSearch || '';
  renderTablePage(p, body, key);
}

function renderTablePage(p, body, key){
  var data = (p._tableData || []).slice();
  var search = p._tableSearch || '';
  if(search){
    search = search.toLowerCase();
    data = data.filter(function(g){
      return String(g[key]).toLowerCase().indexOf(search) !== -1 || String(g.value).toLowerCase().indexOf(search) !== -1;
    });
  }
  var sortCol = p._tableSort.col, sortDir = p._tableSort.dir === 'asc' ? 1 : -1;
  data.sort(function(a, b){
    if(sortCol === 'value') return (a.value - b.value) * sortDir;
    return String(a[key]).localeCompare(String(b[key])) * sortDir;
  });
  var maxVal = 0;
  data.forEach(function(g){ if(g.value > maxVal) maxVal = g.value; });
  if(maxVal === 0) maxVal = 1;
  var rows = data.slice(0, 50).map(function(g){
    var pct = Math.round((g.value / maxVal) * 100);
    return '<tr><td>'+escapeHtml(String(g[key]))+'</td><td class="num td-databar"><div class="td-databar-fill" style="width:'+pct+'%;"></div><span class="td-databar-val">'+formatNum(g.value, p.formatType)+'</span></td></tr>';
  }).join('');
  if(!rows) rows = '<tr><td colspan="2" style="color:var(--muted-2);">нет данных</td></tr>';
  var sortIcon = function(col){
    if(p._tableSort.col !== col) return '';
    return p._tableSort.dir === 'asc' ? ' ↑' : ' ↓';
  };
  var html = '<div class="table-search-wrap"><input class="table-search-input" type="text" placeholder="Поиск…" value="'+escapeHtml(p._tableSearch||'')+'"></div>';
  html += '<div class="table-scroll-container"><table class="mini-table"><thead><tr>';
  html += '<th class="th-sortable" data-col="key">'+escapeHtml(key)+sortIcon('key')+'</th>';
  html += '<th class="th-sortable" data-col="value" style="text-align:right;">значение'+sortIcon('value')+'</th>';
  html += '</tr></thead><tbody>'+rows+'</tbody></table></div>';
  body.innerHTML = html;
  var searchInput = body.querySelector('.table-search-input');
  if(searchInput){
    searchInput.oninput = function(){
      p._tableSearch = searchInput.value;
      renderTablePage(p, body, key);
      var restored = body.querySelector('.table-search-input');
      if(restored){ restored.focus(); restored.setSelectionRange(restored.value.length, restored.value.length); }
    };
  }
  body.querySelectorAll('.th-sortable').forEach(function(th){
    th.onclick = function(){
      var col = th.dataset.col;
      if(p._tableSort.col === col){
        p._tableSort.dir = p._tableSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        p._tableSort = { col: col, dir: 'desc' };
      }
      renderTablePage(p, body, key);
    };
  });
}

/* ── Fullscreen (Focus Mode) ────────────────────── */
var focusPanelId = null;

function drillDownToLogs(p, src){
  var logPanel = {
    id: uid('panel'),
    title: 'Логи: ' + (p.title || p.type || 'все'),
    viz: 'logs',
    type: p.type || '',
    group: 'raw',
    agg: 'count',
    field: '',
    aggfield: '',
    range: p.range || '24h',
    filters: p.filters ? p.filters.slice() : [],
    _currentPage: 0
  };
  openFullscreenPanel(logPanel, src);
}

function openFullscreenPanel(p, src){
  var overlay = document.getElementById('focusOverlay');
  if(!overlay) return;
  var title = overlay.querySelector('.focus-title');
  var body = document.getElementById('focusBody');
  if(!title || !body) return;
  title.textContent = p.title;
  focusPanelId = p.id;
  overlay.classList.add('active');
  loadPanelInto(p, src, body);
}

function loadPanelInto(p, src, bodyEl){
  if(p.viz==='logs'){
    fetchLogs(src, p).then(function(d){ renderLogs(p, d, bodyEl); }).catch(function(e){ bodyEl.innerHTML='Ошибка: '+e.message; });
  } else {
    fetchStats(src, p).then(function(d){
      if(typeof Chart === 'undefined'){
        bodyEl.innerHTML='<div style="color:var(--coral);font-family:var(--mono);font-size:12px;">Chart.js не загружен</div>';
        return;
      }
      renderViz(p, d, bodyEl);
      setTimeout(function(){ if(charts[p.id]) charts[p.id].resize(); }, 100);
    }).catch(function(e){ bodyEl.innerHTML='Ошибка: '+e.message; });
  }
}

function renderViz(p, data, body){
  var isFocus = body.id === 'focusBody';
  body.className = isFocus ? 'panel-body focus-body' : 'panel-body';
  var key=panelKey(p), groups=data.groups||[];
  if(charts[p.id]){charts[p.id].destroy();delete charts[p.id];}
  var fmtType = p.formatType || 'number';
  if(p.viz==='kpi'){
    var val=data.total!==null&&data.total!==undefined?data.total:(groups[0]?groups[0].value:0);
    body.className = isFocus ? 'panel-body kpi-body focus-body' : 'panel-body kpi-body';
    var palette = (typeof getChartPalette === 'function') ? getChartPalette() : ['#4DECC7'];
    var kpiColor = p.color || palette[0];
    body.style.color = kpiColor;
    // Мягкое свечение: text-shadow на полупрозрачный цвет
    body.style.textShadow = '0 0 20px ' + kpiColor + '33';
    body.setAttribute('data-total', String(val));
    var compact = (fmtType === 'number' || !fmtType) ? formatCompact(val) : formatNum(val, fmtType);
    var unitSuffix = p.unit ? ' <span style="font-size:18px;color:var(--muted);">'+escapeHtml(p.unit)+'</span>' : '';
    body.innerHTML='<div class="kpi-value" title="'+escapeHtml(String(val))+'">'+compact+unitSuffix+'</div>'+(p.group?'<div class="kpi-sub">'+groups.length+' групп(а)</div>':'');
    body.querySelector('.kpi-value').style.cursor='pointer';
    body.querySelector('.kpi-value').addEventListener('click',function(){
      drillDownToLogs(p, getSrc());
    });
    return;
  }
  if(p.viz==='table'){
    renderTableViz(p, groups, body, key);
    return;
  }
  // ── Gauge ──
  if(p.viz==='gauge'){
    var val = data.total!==null && data.total!==undefined ? data.total : (groups[0]?groups[0].value:0);
    body.className = isFocus ? 'panel-body focus-body' : 'panel-body';
    body.setAttribute('data-total', String(val));
    if(typeof renderGauge === 'function'){
      renderGauge(body, {
        value: val,
        min: p.gaugeMin !== undefined ? Number(p.gaugeMin) : 0,
        max: p.gaugeMax !== undefined ? Number(p.gaugeMax) : 100,
        unit: p.unit || '',
        color: p.color || '#4DECC7',
        title: p.title || '',
        formatType: p.formatType || 'number'
      });
      body.style.cursor = 'pointer';
      body.addEventListener('click', function(){ drillDownToLogs(p, getSrc()); });
    } else {
      body.innerHTML = '<div style="color:var(--coral);font-family:var(--mono);font-size:12px;">chart-gauge.js не загружен</div>';
    }
    return;
  }
  // ── Heatmap ──
  if(p.viz==='heatmap'){
    body.className = isFocus ? 'panel-body focus-body' : 'panel-body';
    if(typeof renderHeatmap === 'function'){
      // Heatmap needs series data (from breakdown or fetched separately)
      if(data.series && Array.isArray(data.series)){
        renderHeatmap(body, {
          series: data.series,
          color: p.color || '#4DECC7',
          formatType: p.formatType || 'number',
          unit: p.unit || ''
        });
      } else {
        body.innerHTML = '<div style="color:var(--muted-2);font-family:var(--mono);font-size:12px;padding:20px;">heatmap требует разбивку по полю (breakdown)</div>';
      }
    } else {
      body.innerHTML = '<div style="color:var(--coral);font-family:var(--mono);font-size:12px;">chart-heatmap.js не загружен</div>';
    }
    return;
  }
  if(typeof Chart==='undefined'){ body.innerHTML='<div style="color:var(--coral);font-family:var(--mono);font-size:12px;">Chart.js не загружен</div>'; return; }

  body.innerHTML='<canvas></canvas>';
  var ctx=body.querySelector('canvas').getContext('2d');
  // Берём палитру из текущей темы
  var palette = (typeof getChartPalette === 'function') ? getChartPalette() : ['#4DECC7','#F2A950','#5B8DEF','#F2664F','#B892FF','#7CE0A0','#63E6BE','#FFD43B','#FF6B6B','#A9E34B'];
  var mainColor = p.color || palette[0];
  var unitStr = p.unit ? ' '+p.unit : '';

  // Line style + tension (плавность) — настраивается пользователем
  var lineStyle = p.lineStyle || 'smooth';
  var dsTension;
  if(typeof p.tension === 'number'){
    // Если tension задан вручную — используем его (clamp 0..1)
    dsTension = Math.max(0, Math.min(1, p.tension));
  } else {
    // Иначе — fallback на lineStyle
    dsTension = lineStyle === 'smooth' ? 0.35 : 0;
  }
  var dsStepped = lineStyle === 'stepped' ? true : false;
  var mobile = isMobile();

  var isMultiSeries = data.series && Array.isArray(data.series);
  var labels, datasets;

  if(isMultiSeries){
    var bucketSet = {};
    data.series.forEach(function(s){
      (s.points||[]).forEach(function(pt){ bucketSet[String(pt.bucket)] = 1; });
    });
    labels = Object.keys(bucketSet).sort();
    datasets = data.series.map(function(s, i){
      var color = palette[i % palette.length];
      var pointMap = {};
      (s.points||[]).forEach(function(pt){ pointMap[String(pt.bucket)] = pt.value; });
      var seriesData = labels.map(function(b){ return pointMap[b] || 0; });
      if(p.cumulative) seriesData = applyCumulative(seriesData);
      var ds = {
        label: String(s.key),
        data: seriesData,
        backgroundColor: p.viz==='pie' ? palette : color+'2E',
        borderColor: p.viz==='pie' ? (typeof getPanelBorderColor === 'function' ? getPanelBorderColor() : '#0B0F17') : color,
        borderWidth: 2,
        tension: dsTension,
        stepped: dsStepped,
        fill: p.viz==='line',
        pointRadius: p.viz==='line' ? 2 : 0,
        pointHoverRadius: 5,
        pointHitRadius: mobile ? 25 : 5
      };
      if(p.stacked) ds.stack = 'main';
      return ds;
    });
  } else {
    groups = zeroFillGroups(groups, p);
    labels = groups.map(function(g){ return String(g[key]); });
    var values = groups.map(function(g){ return g.value; });
    if(p.cumulative) values = applyCumulative(values);
    var ds = {
      label: p.title,
      data: values,
      backgroundColor: p.viz==='pie' ? palette : (p.color ? p.color+'2E' : mainColor+'2E'),
      borderColor: p.viz==='pie' ? (typeof getPanelBorderColor === 'function' ? getPanelBorderColor() : '#0B0F17') : mainColor,
      borderWidth: 2,
      tension: dsTension,
      stepped: dsStepped,
      fill: p.viz==='line',
      pointRadius: p.viz==='line' ? 2 : 0,
      pointHoverRadius: 5,
      pointHitRadius: mobile ? 25 : 5
    };
    if(p.stacked) ds.stack = 'main';
    datasets = [ds];
  }

  // Цвета осей и сетки — из текущей темы
  var axisColor = (typeof getThemeColor === 'function') ? getThemeColor('--muted-2') : '#4E5768';
  var gridColor = (typeof getThemeColor === 'function') ? getThemeColor('--border-soft') : '#1A2130';
  var legendColor = (typeof getThemeColor === 'function') ? getThemeColor('--muted') : '#7C8798';

  // ── Second Y axis: attach second dataset to right scale ──
  if(p.secondAxis && datasets.length > 1){
    for(var di = 1; di < datasets.length; di++){
      datasets[di].yAxisID = 'y2';
    }
  }

  charts[p.id]=new Chart(ctx,{
    type: p.viz==='pie' ? 'pie' : p.viz,
    data: {
      labels: labels,
      datasets: datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onHover: function(event, activeElements){
        if(mobile) return;
        var hoveredLabel = (activeElements && activeElements.length)
                           ? charts[p.id].data.labels[activeElements[0].index]
                           : null;

        Object.keys(charts).forEach(function(cid){
          if(cid === p.id) return;
          var otherChart = charts[cid];
          if(!otherChart) return;

          if(!hoveredLabel){
            try {
              otherChart.setActiveElements([]);
              if(otherChart.tooltip) otherChart.tooltip.setActiveElements([], {x:0, y:0});
              otherChart.update('none');
            } catch(_){}
            return;
          }

          var otherLabels = otherChart.data.labels || [];
          var matchIdx = -1;
          for(var i=0; i<otherLabels.length; i++){
            if(String(otherLabels[i]) === String(hoveredLabel)){ matchIdx = i; break; }
          }
          if(matchIdx >= 0){
            try {
              otherChart.setActiveElements([{ datasetIndex: 0, index: matchIdx }]);
              if(otherChart.tooltip){
                otherChart.tooltip.setActiveElements([{ datasetIndex: 0, index: matchIdx }], {x: 0, y: 0});
              }
              otherChart.update('none');
            } catch(_){}
          }
        });
      },
      plugins: {
        legend: {
          display: (p.viz==='pie' || isMultiSeries) ? !mobile : false,
          labels: { color: legendColor, font:{family:'JetBrains Mono',size:10} },
          onClick: Chart.defaults.plugins.legend.onClick
        },
        tooltip: {
          callbacks: {
            label: function(ctx){
              var v = ctx.parsed.y !== undefined ? ctx.parsed.y : ctx.parsed;
              return formatNum(v, fmtType) + unitStr;
            }
          }
        },
        thresholdLines: {
          lines: (p.thresholds || []).map(function(t){
            return { value: Number(t.value), color: t.color || '#FF6B6B', label: t.label || '' };
          })
        }
      },
      scales: p.viz==='pie' ? {} : Object.assign({
        x: {
          ticks: { color: axisColor, font:{family:'JetBrains Mono',size:10}, maxRotation:45, minRotation:0, autoSkip:true, maxTicksLimit:15 },
          grid: { color: gridColor }
        },
        y: {
          position: 'left',
          ticks: {
            color: axisColor, font:{family:'JetBrains Mono',size:10},
            callback: function(v){ return formatNum(v, fmtType); }
          },
          grid: { color: gridColor }
        }
      }, p.secondAxis ? {
        y2: {
          position: 'right',
          ticks: {
            color: axisColor, font:{family:'JetBrains Mono',size:10},
            callback: function(v){ return formatNum(v, fmtType); }
          },
          grid: { drawOnChartArea: false }
        }
      } : {}, p.stacked ? {
        x: { stacked: true, ticks: { color: axisColor, font:{family:'JetBrains Mono',size:10}, maxRotation:45, minRotation:0, autoSkip:true, maxTicksLimit:15 }, grid: { color: gridColor } },
        y: { stacked: true, position: 'left', ticks: { color: axisColor, font:{family:'JetBrains Mono',size:10}, callback: function(v){ return formatNum(v, fmtType); } }, grid: { color: gridColor } }
      } : {})
    }
  });

  // ── Compare period: fetch prev data and overlay ──
  if(p.compare && p.viz !== 'pie'){
    var prevRange = computeCompareRange(p.range, p);
    if(prevRange){
      var prevP = Object.assign({}, p, { from: prevRange.from, to: prevRange.to, compare: false });
      var srcForPrev = getSrc();
      if(srcForPrev){
        fetchStats(srcForPrev, prevP).then(function(prevData){
          var prevGroups = zeroFillGroups(prevData.groups || [], prevP);
          var prevLabels = prevGroups.map(function(g){ return String(g[panelKey(prevP)]); });
          var prevValues = prevGroups.map(function(g){ return g.value; });
          if(p.cumulative) prevValues = applyCumulative(prevValues);
          // Align to current labels
          var aligned = labels.map(function(lbl, i){
            var idx = prevLabels.indexOf(lbl);
            return idx >= 0 ? prevValues[idx] : null;
          });
          var chart = charts[p.id];
          if(chart){
            chart.data.datasets.push({
              label: 'Пред. период',
              data: aligned,
              borderColor: mainColor + '55',
              backgroundColor: 'transparent',
              borderWidth: 2,
              borderDash: [6, 3],
              tension: dsTension,
              stepped: dsStepped,
              fill: false,
              pointRadius: 0,
              pointHoverRadius: 4,
              pointHitRadius: mobile ? 25 : 5
            });
            chart.update();
          }
        }).catch(function(){});
      }
    }
  }

  // ── Drill-down: click on chart opens logs for that period ──
  if(p.viz !== 'pie'){
    var chartCanvas = body.querySelector('canvas');
    if(chartCanvas){
      chartCanvas.style.cursor = 'pointer';
      chartCanvas.addEventListener('click', function(evt){
        var chart = charts[p.id];
        if(!chart) return;
        var points = chart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, true);
        if(points.length > 0){
          var idx = points[0].index;
          var lbl = chart.data.labels[idx];
          if(lbl){
            // Create a log panel filtered to that bucket
            var drillFilters = p.filters ? p.filters.slice() : [];
            var fromD, toD;
            if(p.group==='day'){
              fromD = lbl; toD = lbl + 'T23:59:59.999Z';
            } else if(p.group==='hour'){
              fromD = lbl.replace(' ','T') + ':00';
              toD = lbl.replace(' ','T') + ':59:59.999Z';
            } else if(p.group==='month'){
              fromD = lbl + '-01'; toD = lbl + '-31T23:59:59.999Z';
            }
            var drillP = {
              id: uid('panel'), title: 'Логи: ' + lbl,
              viz: 'logs', type: p.type || '', group: 'raw', agg: 'count',
              field: '', aggfield: '', range: 'custom',
              from: fromD || '', to: toD || '',
              filters: drillFilters, _currentPage: 0
            };
            openFullscreenPanel(drillP, getSrc());
          }
        }
      });
    }
  }

  if(p.viz==='pie' && mobile){
    var legendHtml = '<div class="custom-pie-legend">';
    labels.forEach(function(lbl, i){
      var color = palette[i % palette.length];
      legendHtml += '<div class="custom-pie-legend-item"><span class="custom-pie-legend-dot" style="background:'+color+';"></span>'+escapeHtml(String(lbl))+'</div>';
    });
    legendHtml += '</div>';
    body.insertAdjacentHTML('beforeend', legendHtml);
  }
}

/* ── buildPanelCodeTabs ──────────────────────────── */
function buildPanelCodeTabs(p, src){
  var esc=escapeHtml;
  var typePart=p.type?'&type='+encodeURIComponent(p.type):'';
  var extra='';
  if(p.agg==='sum'&&p.aggfield) extra+='&'+encodeURIComponent(p.aggfield)+'=42';
  else if(p.agg==='avg'&&p.aggfield) extra+='&'+encodeURIComponent(p.aggfield)+'=42';
  else if(p.group==='__field'&&p.field) extra+='&'+encodeURIComponent(p.field)+'=sample';
  else extra+='&value=1';
  var url=API+'/e?src='+encodeURIComponent(src)+typePart+extra;
  var ex={'JS':'<span class="c1">// fetch</span>\n<span class="k1">fetch</span>(<span class="s1">"'+esc(url)+'"</span>);','Python':'<span class="c1"># requests</span>\n<span class="k1">import</span> requests\nrequests.get(<span class="s1">"'+esc(url)+'"</span>)','cURL':'<span class="c1"># GET</span>\ncurl <span class="s1">"'+esc(url)+'"</span>','PHP':'<span class="c1">// file_get_contents</span>\nfile_get_contents(<span class="s1">"'+esc(url)+'"</span>);','Go':'<span class="c1">// net/http</span>\nresp, _ := http.Get(<span class="s1">"'+esc(url)+'"</span>)'};
  var langs=Object.keys(ex), html='<div class="pc-tabs">';
  langs.forEach(function(l,i){ html+='<button class="pc-tab'+(i===0?' active':'')+'" data-lang="'+i+'">'+l+'</button>'; });
  html+='<button class="pc-copy-btn">Копировать</button></div><div class="pc-panels">';
  langs.forEach(function(l,i){ html+='<div class="pc-panel'+(i===0?' active':'')+'" id="pc-'+p.id+'-'+i+'"><pre>'+ex[l]+'</pre></div>'; });
  html+='</div>'; return html;
}

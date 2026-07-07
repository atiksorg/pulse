/* ═══════════════════════════════════════════════════
   dashboard.js — panels, charts, canvas, add/edit modal
   ═══════════════════════════════════════════════════ */

/* ── Mobile detection helper ─────────────────────── */
function isMobile(){ return window.innerWidth < 860; }

/* ── Panel templates ─────────────────────────────── */
var templates = [
  { id:'events_by_day', title:'События по дням', desc:'Линия: сколько событий приходит каждый день', cfg:{viz:'line', type:'', group:'day', agg:'count', field:'', aggfield:'', range:'7d', width:6}},
  { id:'top_types', title:'Топ типов событий', desc:'Столбцы: распределение по type за период', cfg:{viz:'bar', type:'', group:'day', agg:'count', field:'', aggfield:'', range:'7d', width:6}},
  { id:'total_today', title:'Всего событий сегодня', desc:'Число: счётчик за последние 24 часа', cfg:{viz:'kpi', type:'', group:'', agg:'count', field:'', aggfield:'', range:'24h', width:4}},
  { id:'avg_field', title:'Среднее по полю', desc:'Число: среднее значение указанного поля payload', cfg:{viz:'kpi', type:'', group:'', agg:'avg', field:'', aggfield:'', range:'7d', width:4}},
  { id:'by_hour', title:'Активность по часам', desc:'Линия: распределение событий по часам суток', cfg:{viz:'line', type:'', group:'hour', agg:'count', field:'', aggfield:'', range:'24h', width:6}},
  { id:'logs_table', title:'Логи (таблица)', desc:'Последние события в виде таблицы с фильтрацией по типу', cfg:{viz:'logs', type:'', group:'raw', agg:'count', field:'', aggfield:'', range:'24h', width:8, autorefresh:10}},
  { id:'blank', title:'Пустая панель', desc:'Настроить всё вручную с нуля', cfg:{viz:'line', type:'', group:'day', agg:'count', field:'', aggfield:'', range:'7d', width:6}},
];

/* ── initDashboard ───────────────────────────────── */
async function initDashboard(){
  var params = new URLSearchParams(location.hash.split('?')[1] || '');
  var urlDbId = params.get('id');
  if (urlDbId) {
    AppState.activeId = urlDbId;
  }

  // Рендерим тулбар без кнопки "Сбросить" и без srcInput
  $('.toolbar').innerHTML = '<button class="btn btn-ghost" id="btnLayoutMode" title="Переключить режим раскладки">Сетка</button><button class="btn btn-ghost" id="btnRefreshAll">↻ Обновить</button><button class="btn btn-ghost" id="btnExport">↓ Экспорт CSV</button><button class="btn btn-ghost" id="btnShare">Поделиться ссылкой</button><button class="btn btn-primary btn-add-panel-desktop" id="btnAddPanel">+ Добавить панель</button><button class="btn btn-ai" id="btnAskAI" title="Сгенерировать панель по текстовому запросу">✨ AI-помощник</button>';
  $('#viewBanner').innerHTML = '';
  $('#btnLayoutMode').onclick = toggleLayoutMode;
  $('#btnRefreshAll').onclick = function(){ renderPanels(); };
  $('#btnExport').onclick = exportCsv;
  $('#btnShare').onclick = function(){ showShareModal(); };
  $('#btnAddPanel').onclick = openAddPanel;
  var askBtn = $('#btnAskAI');
  if(askBtn) askBtn.onclick = openAiPanelModal;

  // Пункт 2: FAB — плавающая кнопка на мобилках
  var fab = document.getElementById('fabAddPanel');
  if(fab){
    fab.style.display = isMobile() ? 'flex' : 'none';
    fab.onclick = openAddPanel;
  }

  // Пункт 3: Scroll Shrink — компактная шапка при скролле
  if(!window._scrollShrinkBound){
    window._scrollShrinkBound = true;
    window.addEventListener('scroll', function(){
      if(window.innerWidth < 860){
        if(window.scrollY > 100){
          document.body.classList.add('scrolled');
        } else {
          document.body.classList.remove('scrolled');
        }
      } else {
        document.body.classList.remove('scrolled');
      }
    }, { passive: true });
  }

  try {
    // Загружаем дашборды и suggestions с сервера
    await loadDashboardsFromServer();
    await loadSuggestionsFromServer();
  } catch(e) {
    toast('Ошибка загрузки данных: ' + e.message);
  }

  renderDashTabs();
  renderPanels();
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
    b.onclick = function(){ setActiveId(db.id); renderDashTabs(); renderPanels(); };
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
    } catch(e) { toast('Ошибка создания: ' + e.message); }
  };
  el.appendChild(add);
}

/* ── Stats helpers ───────────────────────────────── */
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
  var rt = rangeToFromTo(p.range, p);
  if(rt.from) u.searchParams.set('from', rt.from);
  if(rt.to) u.searchParams.set('to', rt.to);
  // sort & limit
  if(p.sort && p.sort !== 'key') u.searchParams.set('sort', p.sort);
  if(p.limit && Number(p.limit) > 0) u.searchParams.set('limit', String(p.limit));
  // filters
  if(Array.isArray(p.filters) && p.filters.length){
    u.searchParams.set('filters', JSON.stringify(p.filters));
  }
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
  // filters for logs
  if(Array.isArray(p.filters) && p.filters.length){
    u.searchParams.set('filters', JSON.stringify(p.filters));
  }
  var res = await fetch(u.toString());
  if(!res.ok) throw new Error('request failed');
  return res.json();
}

/* ── Render panels ───────────────────────────────── */
function renderPanels(readonlyData){
  var grid = $('#panelGrid');
  grid.innerHTML = '';
  Object.values(refreshTimers).forEach(clearInterval);
  refreshTimers = {};
  var isShared = !!readonlyData;
  canvasMode = getLayoutMode();
  if(isShared && readonlyData.layoutMode !== undefined) canvasMode = readonlyData.layoutMode;
  var btnLayout = $('#btnLayoutMode');
  if(btnLayout){ btnLayout.textContent = canvasMode?'Холст':'Сетка'; btnLayout.classList.toggle('btn-primary', canvasMode); }
  document.body.classList.toggle('canvas-mode', canvasMode);
  var db = isShared ? readonlyData.dashboard : getActiveDashboard();
  var src = isShared ? readonlyData.src : getSrc();
  if (!db) { db = { id: uid('db'), name: 'Основной', panels: [] }; }
  if (!Array.isArray(db.panels)) db.panels = [];
  var panels = db.panels;
  if(canvasMode && panels.length && !panels[0].cx){ autoLayoutCanvas(panels); if(!isShared) updateDashboardOnServer(db).catch(function(){}); }

  if(!panels.length){
    grid.innerHTML = '<div class="empty-state"><h3>Дашборд пуст</h3><p>Чтобы увидеть данные, отправьте первое событие или выберите готовый шаблон.</p><div style="margin-top:20px;display:flex;gap:12px;justify-content:center;">'+(isShared?'':'<button class="btn btn-primary" id="btnEmptyAdd">+ Добавить панель</button>')+'<button class="btn btn-ghost" id="btnEmptyCase">Посмотреть кейсы</button></div></div>';
    if(!isShared) $('#btnEmptyAdd').onclick = openAddPanel;
    var btnCase = document.getElementById('btnEmptyCase');
    if(btnCase) btnCase.onclick=function(e){ e.preventDefault(); var s=document.getElementById('helpSection'),b=document.getElementById('helpBody'); if(s&&b){s.classList.add('open');b.style.display=''; var c=document.getElementById('cases-block'); if(c) c.scrollIntoView({behavior:'smooth'});} };
    return;
  }

  panels.forEach(function(p){
    var card = document.createElement('div');
    card.className = 'panel-card';
    card.style.setProperty('--w', p.width||6);
    card.innerHTML = '<div class="panel-head"><div><h3>'+escapeHtml(p.title)+'</h3><div class="meta">'+describeMeta(p)+'</div></div><div class="panel-actions"><button class="icon-btn" data-act="refresh" title="Обновить">↻</button>'+(isShared?'':'<button class="icon-btn" data-act="edit" title="Изменить">✎</button>')+(isShared?'':'<button class="icon-btn icon-btn-danger" data-act="remove" title="Удалить панель с дашборда">🗑</button>')+(isShared?'':'<button class="icon-btn panel-clear-btn" data-act="clear" title="Очистить данные (Alt+клик)">🧹</button>')+(isShared?'':'<button class="icon-btn" data-act="png" title="Сохранить график как PNG">📷</button>')+(isShared?'':'<button class="icon-btn" data-act="copy" title="Копировать данные в буфер">📋</button>')+(isShared?'':'<button class="icon-btn" data-act="fullscreen" title="Полноэкранный режим">⛶</button>')+(isShared?'':'<button class="icon-btn" data-act="smooth" title="Переключить сглаживание линий">∡</button>')+'</div></div><div class="panel-body" id="body-'+p.id+'"><div style="color:var(--muted-2);font-family:var(--mono);font-size:12px;">загрузка…</div></div><div class="panel-code-toggle" data-panel="'+p.id+'"><span class="pct-icon">▸</span> Пример записи данных</div><div class="panel-code-block" id="code-'+p.id+'" style="display:none;">'+buildPanelCodeTabs(p, src)+'</div>';
    grid.appendChild(card);

    var toggleEl = card.querySelector('.panel-code-toggle');
    var codeEl = card.querySelector('#code-'+p.id);
    toggleEl.onclick=function(){ var open=codeEl.style.display==='none'; codeEl.style.display=open?'block':'none'; toggleEl.querySelector('.pct-icon').textContent=open?'▾':'▸'; };
    codeEl.querySelectorAll('.pc-tab').forEach(function(tab){
      tab.onclick=function(ev){ ev.stopPropagation(); codeEl.querySelectorAll('.pc-tab').forEach(function(t){t.classList.remove('active');}); codeEl.querySelectorAll('.pc-panel').forEach(function(pp){pp.classList.remove('active');}); tab.classList.add('active'); var idx=tab.dataset.lang; var pan=codeEl.querySelector('#pc-'+p.id+'-'+idx); if(pan) pan.classList.add('active'); };
    });
    var cpyBtn = codeEl.querySelector('.pc-copy-btn');
    if(cpyBtn){ cpyBtn.onclick=function(ev){ ev.stopPropagation(); var act=codeEl.querySelector('.pc-panel.active pre'); if(act) navigator.clipboard.writeText(act.textContent).then(function(){cpyBtn.textContent='Скопировано!';setTimeout(function(){cpyBtn.textContent='Копировать';},1500);}); }; }

    card.querySelector('[data-act="refresh"]').onclick=function(){loadPanel(p,src);};
    if(!isShared){
      card.querySelector('[data-act="edit"]').onclick=function(){openEditPanel(p);};
      card.querySelector('[data-act="remove"]').onclick=async function(){
        if(await confirmModal('Удалить панель?','Удалить панель «'+p.title+'» с дашборда? (Д��нные останутся в базе)','Удалить')){
          if (refreshTimers[p.id]) {
            clearInterval(refreshTimers[p.id]);
            delete refreshTimers[p.id];
          }
          var db2 = getActiveDashboard();
          if (db2) {
            db2.panels = db2.panels.filter(function(x){return x.id!==p.id;});
            try {
              await updateDashboardOnServer(db2);
              renderPanels();
              toast('Панель удалена');
            } catch(err) { toast('Ошибка сохранения: ' + err.message); }
          }
        }
      };
      card.querySelector('[data-act="clear"]').onclick=async function(e){
        if(!e.altKey){ toast('Зажмите Alt для очистки данных'); return; }
        var msg=p.type?'Удалить все события типа «'+p.type+'» из базы?':'Удалить все события из базы?';
        if(await confirmModal('Очистить данные?',msg,'Очистить')){
          try{
            var r = await fetch(API+'/e/clear',{
              method:'POST',
              headers: Object.assign({'Content-Type':'application/json'}, authHeaders()),
              body: JSON.stringify(p.type?{src:src,type:p.type}:{src:src})
            });
            if(r.status === 401){ clearSession(); toast('Сессия истекла — войдите снова'); return; }
            if(r.status === 403){ toast('Нет доступа к этому src'); return; }
            if(!r.ok){ var e = await r.json().catch(function(){return{error:'HTTP '+r.status};}); toast('Ошибка: '+(e.error||r.status)); return; }
          }catch(e){ toast('Сеть недоступна'); return; }
          toast('Данные очищены'); loadPanel(p,src);
        }
      };
      card.querySelector('[data-act="png"]').onclick=function(){ exportPanelPng(p); };
      card.querySelector('[data-act="copy"]').onclick=function(){ copyPanelData(p); };
      card.querySelector('[data-act="fullscreen"]').onclick=function(){ openFullscreenPanel(p,src); };
      card.querySelector('[data-act="smooth"]').onclick=function(){ toggleSmoothing(p); };
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
    }
    loadPanel(p,src);
    if(p.autorefresh && Number(p.autorefresh)>0 && !isShared) refreshTimers[p.id]=setInterval(function(){loadPanel(p,src);},Number(p.autorefresh)*1000);
  });
}

/* ── loadPanel / renderViz / renderLogs ──────────── */
async function loadPanel(p, src){
  var body = document.getElementById('body-'+p.id);
  if(!body) return;
  // Пункт 10: Skeleton Loader — накладываем оверлей, не удаляя существующий график
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

/* ── Skeleton helpers (Пункт 10) ─────────────────── */
function showSkeleton(body){
  // Если уже есть скелетон — не добавляем повторно
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

function renderLogsPage(p, body){
  var events = p._logsEvents || [];
  if(!events.length){ body.innerHTML='<div style="color:var(--muted-2);font-family:var(--mono);font-size:12px;padding:20px;">нет событий</div>'; return; }
  var total = events.length;
  var totalPages = Math.ceil(total / LOGS_PAGE_SIZE);
  var page = p._currentPage || 0;
  if(page >= totalPages) page = totalPages - 1;
  if(page < 0) page = 0;
  p._currentPage = page;
  var slice = events.slice(page * LOGS_PAGE_SIZE, (page + 1) * LOGS_PAGE_SIZE);

  var html='<div class="table-scroll-container"><div class="logs-wrap" style="flex:1;overflow-y:auto;padding-right:4px;">';
  html+='<table class="logs-table"><thead><tr><th class="logs-th-time">Время</th><th class="logs-th-type">Тип</th><th class="logs-th-msg">Сообщение</th></tr></thead><tbody>';
  for(var i=0;i<slice.length;i++){ var ev=slice[i]; var msg=''; try{var pl=JSON.parse(ev.payload); msg=pl.text||pl.message||pl.msg||''; if(!msg){var keys=Object.keys(pl); msg=keys.slice(0,3).map(function(k){return k+'='+String(pl[k]);}).join(', ');} }catch(_){msg=ev.payload;} if(msg.length>120) msg=msg.slice(0,117)+'…'; var time=ev.ts?ev.ts.replace('T',' ').replace(/\.\d+Z$/,''):''; html+='<tr><td class="logs-time">'+escapeHtml(time)+'</td><td class="logs-type">'+escapeHtml(ev.type)+'</td><td class="logs-msg">'+escapeHtml(msg)+'</td></tr>'; }
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

/* ── Smart zero-fill for time series ────────────── */
function zeroFillGroups(groups, p){
  if(p.viz!=='line') return groups;
  if(p.group!=='day' && p.group!=='hour') return groups;
  var key = panelKey(p);
  var map = {};
  groups.forEach(function(g){ map[String(g[key])] = g.value; });
  var labels = [];
  var now = new Date();
  var from = new Date(now);
  if(p.range==='24h') from.setHours(from.getHours()-24);
  else if(p.range==='7d') from.setDate(from.getDate()-7);
  else if(p.range==='30d') from.setDate(from.getDate()-30);
  else return groups; // all/custom — не заполняем
  if(p.group==='hour'){
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
  }
  // Если сервер вернул даты в другом формате — не заполняем
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
  // Пункт 6: Data Bars — вычисляем максимум для прогресс-баров
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
var focusPanelId = null; // id панели, открытой в фокус-режиме

function openFullscreenPanel(p, src){
  var overlay = document.getElementById('focusOverlay');
  if(!overlay) return;
  var title = overlay.querySelector('.focus-title');
  var body = overlay.querySelector('.focus-body');
  title.textContent = p.title;
  focusPanelId = p.id;
  overlay.classList.add('active');
  // Загружаем данные заново в полноэкранный body
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

/* ── Export chart as PNG ─────────────────────────── */
function exportPanelPng(p){
  var chart = charts[p.id];
  if(!chart){ toast('Нет графика для экспорта'); return; }
  var url = chart.toBase64Image('image/png', 1);
  var a = document.createElement('a');
  a.href = url;
  a.download = (p.title || 'chart').replace(/[^a-zA-Z0-9_-]/g,'_') + '.png';
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ a.remove(); }, 100);
  toast('PNG сохранён');
}

/* ── Copy chart data as TSV ──────────────────────── */
function copyPanelData(p){
  var chart = charts[p.id];
  if(!chart){ toast('Нет данных для копирования'); return; }
  var labels = chart.data.labels || [];
  var values = chart.data.datasets[0] ? chart.data.datasets[0].data : [];
  var tsv = 'label\tvalue\n';
  for(var i=0; i<labels.length; i++){
    tsv += labels[i] + '\t' + values[i] + '\n';
  }
  navigator.clipboard.writeText(tsv).then(function(){
    toast('Данные скопированы ('+labels.length+' строк)');
  }).catch(function(){ toast('Не удалось скопировать'); });
}

/* ── Toggle line smoothing ───────────────────────── */
function toggleSmoothing(p){
  var chart = charts[p.id];
  if(!chart || p.viz !== 'line'){ toast('Сглаживание только для линейного графика'); return; }
  var ds = chart.data.datasets[0];
  ds.tension = ds.tension > 0 ? 0 : 0.35;
  chart.update();
  toast(ds.tension > 0 ? 'Сглаживание включено' : 'Сглаживание выключено');
}

function renderViz(p, data, body){
  body.className='panel-body';
  var key=panelKey(p), groups=data.groups||[];
  if(charts[p.id]){charts[p.id].destroy();delete charts[p.id];}
  var fmtType = p.formatType || 'number';
  if(p.viz==='kpi'){
    var val=data.total!==null&&data.total!==undefined?data.total:(groups[0]?groups[0].value:0);
    body.className='panel-body kpi-body';
    var unitSuffix = p.unit ? ' <span style="font-size:18px;color:var(--muted);">'+escapeHtml(p.unit)+'</span>' : '';
    body.innerHTML='<div class="kpi-value">'+formatNum(val, fmtType)+unitSuffix+'</div>'+(p.group?'<div class="kpi-sub">'+groups.length+' групп(а)</div>':'');
    return;
  }
  if(p.viz==='table'){
    renderTableViz(p, groups, body, key);
    return;
  }
  if(typeof Chart==='undefined'){ body.innerHTML='<div style="color:var(--coral);font-family:var(--mono);font-size:12px;">Chart.js не загружен</div>'; return; }

  // Smart zero-fill for time series
  groups = zeroFillGroups(groups, p);

  body.innerHTML='<canvas></canvas>';
  var ctx=body.querySelector('canvas').getContext('2d');
  var labels=groups.map(function(g){return String(g[key]);}), values=groups.map(function(g){return g.value;});
  var palette=['#4DECC7','#F2A950','#5B8DEF','#F2664F','#B892FF','#7CE0A0'];
  var mainColor = p.color || '#4DECC7';
  var unitStr = p.unit ? ' '+p.unit : '';

  // Line style config (Пункт 2)
  var lineStyle = p.lineStyle || 'smooth';
  var dsTension = lineStyle === 'smooth' ? 0.35 : 0;
  var dsStepped = lineStyle === 'stepped' ? true : false;

  var mobile = isMobile();

  charts[p.id]=new Chart(ctx,{
    type: p.viz==='pie' ? 'pie' : p.viz,
    data: {
      labels: labels,
      datasets: [{
        label: p.title,
        data: values,
        backgroundColor: p.viz==='pie' ? palette : (p.color ? p.color+'2E' : 'rgba(77,236,199,0.18)'),
        borderColor: p.viz==='pie' ? '#0B0F17' : mainColor,
        borderWidth: 2,
        tension: dsTension,
        stepped: dsStepped,
        fill: p.viz==='line',
        pointRadius: p.viz==='line' ? 2 : 0,
        pointHoverRadius: 5,
        pointHitRadius: mobile ? 25 : 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onHover: function(event, activeElements){
        // Пункт 8: Отключение кросс-подсветки на мобильных
        if(mobile) return;
        // Пункт 9: Синхронный tooltip — кросс-подсветка
        var hoveredLabel = (activeElements && activeElements.length)
                           ? charts[p.id].data.labels[activeElements[0].index]
                           : null;

        Object.keys(charts).forEach(function(cid){
          if(cid === p.id) return;
          var otherChart = charts[cid];
          if(!otherChart) return;

          if(!hoveredLabel){
            // Мышь ушла — сбрасываем подсветку и тултип на остальных графиках
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
          display: p.viz==='pie' ? !mobile : false,
          labels: { color:'#7C8798', font:{family:'JetBrains Mono',size:10} },
          onClick: Chart.defaults.plugins.legend.onClick
        },
        tooltip: {
          callbacks: {
            label: function(ctx){
              var v = ctx.parsed.y !== undefined ? ctx.parsed.y : ctx.parsed;
              return formatNum(v, fmtType) + unitStr;
            }
          }
        }
      },
      scales: p.viz==='pie' ? {} : {
        x: {
          ticks: { color:'#4E5768', font:{family:'JetBrains Mono',size:10}, maxRotation:45, minRotation:0, autoSkip:true, maxTicksLimit:15 },
          grid: { color:'#1A2130' }
        },
        y: {
          ticks: {
            color:'#4E5768', font:{family:'JetBrains Mono',size:10},
            callback: function(v){ return formatNum(v, fmtType); }
          },
          grid: { color:'#1A2130' }
        }
      }
    }
  });

  // Пункт 7: Кастомная HTML-легенда для pie на мобильных
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

/* ── Drag & Drop ─────────────────────────────────── */
function onDragStart(e){ dragSrcPanelId=e.currentTarget.dataset.panelId; e.currentTarget.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',dragSrcPanelId); }
function onDragOver(e){ e.preventDefault(); e.dataTransfer.dropEffect='move'; if(e.currentTarget.dataset.panelId!==dragSrcPanelId) e.currentTarget.classList.add('drag-over'); }
async function onDrop(e){
  e.preventDefault();
  var tid=e.currentTarget.dataset.panelId;
  if(!dragSrcPanelId||!tid||dragSrcPanelId===tid) return;
  var db = getActiveDashboard();
  if (!db) return;
  var panels = db.panels;
  var fi = panels.findIndex(function(p){return p.id===dragSrcPanelId;});
  var ti = panels.findIndex(function(p){return p.id===tid;});
  if(fi===-1||ti===-1) return;
  var moved = panels.splice(fi,1);
  panels.splice(ti,0,moved[0]);
  try {
    await updateDashboardOnServer(db);
    renderPanels();
  } catch(err) { toast('Ошибка сохранения: ' + err.message); }
}
function onDragEnd(e){ e.currentTarget.classList.remove('dragging'); $$('.panel-card').forEach(function(c){c.classList.remove('drag-over');}); dragSrcPanelId=null; }

/* ── Canvas mode ─────────────────────────────────── */
function toggleLayoutMode(){ canvasMode=!canvasMode; setLayoutMode(canvasMode); $('#btnLayoutMode').textContent=canvasMode?'Холст':'Сетка'; $('#btnLayoutMode').classList.toggle('btn-primary',canvasMode); renderPanels(); }
function autoLayoutCanvas(panels){ var x=20,y=20,cw=380,rh=280,gap=16,mw=($('#panelGrid').clientWidth||1100)-40; panels.forEach(function(p){p.cx=x;p.cy=y;p.cw=cw;p.ch=rh;x+=cw+gap;if(x+cw>mw){x=20;y+=rh+gap;}}); }
function applyCanvasPosition(card,p){ card.style.left=(p.cx||20)+'px'; card.style.top=(p.cy||20)+'px'; card.style.width=(p.cw||380)+'px'; card.style.height=(p.ch||280)+'px'; card.style.zIndex=Math.min(Math.max(p.cz || CANVAS_Z_MIN, CANVAS_Z_MIN), CANVAS_Z_MAX); }
function initCanvasDrag(card,p){ var head=card.querySelector('.panel-head'); head.addEventListener('mousedown',function(e){ if(e.target.closest('.icon-btn')) return; card.classList.add('canvas-dragging'); canvasZCounter = canvasZCounter >= CANVAS_Z_MAX ? CANVAS_Z_MIN : canvasZCounter + 1; card.style.zIndex=canvasZCounter; p.cz=canvasZCounter; canvasDragState={ card:card, p:p, startX:e.clientX, startY:e.clientY, origX:p.cx||0, origY:p.cy||0 }; e.preventDefault(); }); }
function initCanvasResize(card,p){ var h=document.createElement('div'); h.className='canvas-resize-handle'; card.appendChild(h); h.addEventListener('mousedown',function(e){e.stopPropagation();e.preventDefault(); canvasResizeState={ card:card, p:p, startX:e.clientX, startY:e.clientY, origW:p.cw||380, origH:p.ch||280 }; }); }

/* ── Canvas global drag/resize state (single document listener) ── */
var canvasDragState = null;   // { card, p, startX, startY, origX, origY }
var canvasResizeState = null; // { card, p, startX, startY, origW, origH }
var _canvasGlobalHandlersBound = false;

function _bindCanvasGlobalHandlers(){
  if (_canvasGlobalHandlersBound) return;
  _canvasGlobalHandlersBound = true;

  document.addEventListener('mousemove', function(e){
    if (canvasDragState) {
      var d = canvasDragState;
      var GRID_SIZE = 20;
      d.p.cx = Math.round((d.origX + (e.clientX - d.startX)) / GRID_SIZE) * GRID_SIZE;
      d.p.cy = Math.round((d.origY + (e.clientY - d.startY)) / GRID_SIZE) * GRID_SIZE;
      d.card.style.left = d.p.cx + 'px';
      d.card.style.top  = d.p.cy + 'px';
    }
    if (canvasResizeState) {
      var r = canvasResizeState;
      var GRID_SIZE = 20;
      r.p.cw = Math.max(200, Math.round((r.origW + (e.clientX - r.startX)) / GRID_SIZE) * GRID_SIZE);
      r.p.ch = Math.max(150, Math.round((r.origH + (e.clientY - r.startY)) / GRID_SIZE) * GRID_SIZE);
      r.card.style.width  = r.p.cw + 'px';
      r.card.style.height = r.p.ch + 'px';
      if (charts[r.p.id]) charts[r.p.id].resize();
    }
  });

  document.addEventListener('mouseup', async function(){
    if (canvasDragState) {
      var d = canvasDragState;
      d.card.classList.remove('canvas-dragging');
      var db = getActiveDashboard();
      if (db) {
        var pp = db.panels.find(function(x){ return x.id === d.p.id; });
        if (pp) { pp.cx = d.p.cx; pp.cy = d.p.cy; pp.cz = d.p.cz; }
        try { await updateDashboardOnServer(db); } catch(_){}
      }
      canvasDragState = null;
    }
    if (canvasResizeState) {
      var r = canvasResizeState;
      var db2 = getActiveDashboard();
      if (db2) {
        var pp2 = db2.panels.find(function(x){ return x.id === r.p.id; });
        if (pp2) { pp2.cw = r.p.cw; pp2.ch = r.p.ch; }
        try { await updateDashboardOnServer(db2); } catch(_){}
      }
      canvasResizeState = null;
    }
  });
}
_bindCanvasGlobalHandlers();

/* ── Add / Edit panel modal ──────────────────────── */
function openAddPanel(){ editingPanelId=null; $('#modalTitle').textContent='Новая панель'; buildTemplateGrid(); resetAdvForm(); populateSuggestions(); $('#advForm').classList.remove('active'); $('#advToggle').textContent='Настроить вручную →'; $('#panelModal').classList.add('active'); }
function openEditPanel(p){ editingPanelId=p.id; $('#modalTitle').textContent='Изменить панель'; $('#tplGrid').innerHTML=''; $('#advToggle').style.display='none'; $('#advForm').classList.add('active'); populateSuggestions(); fillAdvForm(p); $('#panelModal').classList.add('active'); }
function closePanelModal(){ $('#panelModal').classList.remove('active'); $('#advToggle').style.display=''; editingPanelId=null; }
$('#btnCancelPanel').onclick=closePanelModal;
$('#btnAddPanel').onclick=openAddPanel;
$('#advToggle').onclick=function(){ var f=$('#advForm'); f.classList.toggle('active'); $('#advToggle').textContent=f.classList.contains('active')?'Скрыть ручные настройки':'Настроить вручную →'; };
function buildTemplateGrid(){ var grid=$('#tplGrid'); grid.innerHTML=''; templates.forEach(function(t){ var b=document.createElement('button'); b.className='tpl-card'; b.innerHTML='<div class="t-title">'+t.title+'</div><div class="t-desc">'+t.desc+'</div>'; b.onclick=function(){ var cfg=Object.assign({},t.cfg,{title:t.title}); if(t.cfg.agg==='avg'||t.cfg.group==='__field'){ $('#advForm').classList.add('active'); $('#advToggle').textContent='Скрыть ручные настройки'; fillAdvForm(cfg); } else { addPanelFromConfig(cfg); closePanelModal(); } }; grid.appendChild(b); }); }
function populateSuggestions(){
  var tl = AppState.suggestions.types || [];
  $('#typeSuggestions').innerHTML=tl.map(function(t){return '<option value="'+escapeHtml(t)+'">';}).join('');
  var fl = AppState.suggestions.fields || [];
  $('#fieldSuggestions').innerHTML=fl.map(function(t){return '<option value="'+escapeHtml(t)+'">';}).join('');
}
function resetAdvForm(){ $('#f_title').value=''; $('#f_viz').value='line'; $('#f_type').value=''; $('#f_group').value='day'; $('#f_fieldname').value=''; $('#f_agg').value='count'; $('#f_aggfield').value=''; $('#f_range').value='7d'; $('#f_width').value='6'; $('#f_autorefresh').value='0'; $('#f_sort').value='key'; $('#f_limit').value=''; $('#f_unit').value=''; $('#f_color').value='#4DECC7'; $('#f_linestyle').value='smooth'; $('#f_format').value='number'; renderFilterRows([]); toggleCondFields(); }
function fillAdvForm(p){ $('#f_title').value=p.title; $('#f_viz').value=p.viz; $('#f_type').value=p.type||''; $('#f_group').value=p.group==='__field'?'__field':(p.group||''); $('#f_fieldname').value=p.field||''; $('#f_agg').value=p.agg||'count'; $('#f_aggfield').value=p.aggfield||''; $('#f_range').value=p.range||'7d'; $('#f_width').value=String(p.width||6); $('#f_autorefresh').value=String(p.autorefresh||0); $('#f_sort').value=p.sort||'key'; $('#f_limit').value=p.limit?String(p.limit):''; $('#f_unit').value=p.unit||''; $('#f_color').value=p.color||'#4DECC7'; $('#f_linestyle').value=p.lineStyle||'smooth'; $('#f_format').value=p.formatType||'number'; renderFilterRows(p.filters||[]); if(p.from)$('#f_from').value=p.from.slice(0,10); if(p.to)$('#f_to').value=p.to.slice(0,10); toggleCondFields(); }
function toggleCondFields(){ $('#fieldNameWrap').style.display=$('#f_group').value==='__field'?'flex':'none'; $('#aggFieldWrap').style.display=$('#f_agg').value!=='count'?'flex':'none'; var cr=$('#customRangeWrap'); if(cr)cr.style.display=$('#f_range').value==='custom'?'flex':'none'; }
$('#f_group').addEventListener('change',toggleCondFields); $('#f_agg').addEventListener('change',toggleCondFields); $('#f_range').addEventListener('change',toggleCondFields);
$('#btnAddFilter').addEventListener('click',function(){ addFilterRow('','eq',''); });
function readAdvForm(){ var c={title:$('#f_title').value.trim()||'Без названия',viz:$('#f_viz').value,type:$('#f_type').value.trim(),group:$('#f_group').value,field:$('#f_fieldname').value.trim(),agg:$('#f_agg').value,aggfield:$('#f_aggfield').value.trim(),range:$('#f_range').value,width:Number($('#f_width').value),autorefresh:Number($('#f_autorefresh').value),sort:$('#f_sort').value,key:'key',unit:$('#f_unit').value.trim(),color:$('#f_color').value,lineStyle:$('#f_linestyle').value,formatType:$('#f_format').value}; var limitVal=$('#f_limit').value.trim(); c.limit=limitVal?Number(limitVal):null; if(isNaN(c.limit)||c.limit<=0) c.limit=null; c.filters=readFilterRows(); if(c.range==='custom'){c.from=$('#f_from').value||'';c.to=$('#f_to').value||'';} return c; }

$('#btnSavePanel').onclick=async function(){
  var cfg=readAdvForm();
  var db = getActiveDashboard();
  if (!db) return;

  if(editingPanelId){
    var p=db.panels.find(function(x){return x.id===editingPanelId;});
    if (p) Object.assign(p,cfg);
  } else {
    var pNew = Object.assign({ id: uid('panel') }, cfg);
    db.panels.push(pNew);
  }

  try {
    await updateDashboardOnServer(db);
    renderPanels();
    closePanelModal();
  } catch(e) { toast('Ошибка сохранения: ' + e.message); }
};

/* ── Filter rows UI ─────────────────────────────── */
var FILTER_OPS = [
  { value:'eq', label:'=' },
  { value:'neq', label:'≠' },
  { value:'gt', label:'>' },
  { value:'lt', label:'<' },
  { value:'in', label:'in' },
  { value:'contains', label:'содержит' }
];

function renderFilterRows(filters){
  var container = $('#filterRows');
  if(!container) return;
  container.innerHTML = '';
  (filters || []).forEach(function(f){ addFilterRow(f.field, f.op, f.value); });
}

function addFilterRow(field, op, value){
  var container = $('#filterRows');
  if(!container) return;
  var row = document.createElement('div');
  row.className = 'filter-row';
  var fieldInput = document.createElement('input');
  fieldInput.className = 'filter-field';
  fieldInput.placeholder = 'поле';
  fieldInput.value = field || '';
  fieldInput.setAttribute('list', 'fieldSuggestions');
  var opSelect = document.createElement('select');
  opSelect.className = 'filter-op';
  FILTER_OPS.forEach(function(o){
    var opt = document.createElement('option');
    opt.value = o.value; opt.textContent = o.label;
    if(o.value === op) opt.selected = true;
    opSelect.appendChild(opt);
  });
  var valueInput = document.createElement('input');
  valueInput.className = 'filter-value';
  valueInput.placeholder = 'значение';
  valueInput.value = value || '';
  var delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'filter-del';
  delBtn.textContent = '×';
  delBtn.title = 'Удалить';
  delBtn.onclick = function(){ row.remove(); };
  row.appendChild(fieldInput);
  row.appendChild(opSelect);
  row.appendChild(valueInput);
  row.appendChild(delBtn);
  container.appendChild(row);
}

function readFilterRows(){
  var container = $('#filterRows');
  if(!container) return [];
  var result = [];
  container.querySelectorAll('.filter-row').forEach(function(row){
    var field = row.querySelector('.filter-field').value.trim();
    var op = row.querySelector('.filter-op').value;
    var value = row.querySelector('.filter-value').value.trim();
    if(!field || !value) return;
    var f = { field: field, op: op };
    if(op === 'in') f.value = value.split(',').map(function(v){ return v.trim(); }).filter(Boolean);
    else if(op === 'gt' || op === 'lt') f.value = Number(value);
    else f.value = value;
    if(op === 'in' && Array.isArray(f.value) && f.value.length === 0) return;
    if((op === 'gt' || op === 'lt') && isNaN(f.value)) return;
    result.push(f);
  });
  return result;
}

async function addPanelFromConfig(cfg){
  var db = getActiveDashboard();
  if (!db) return;
  var p = Object.assign({ id: uid('panel') }, cfg);
  db.panels.push(p);
  try {
    await updateDashboardOnServer(db);
    renderPanels();
  } catch(e) { toast('Ошибка сохранения: ' + e.message); }
}

/* ── Share helpers ───────────────────────────────── */
function encodeDashboard(db, src){
  var payload={v:1,src:src,layoutMode:getLayoutMode(),dashboard:{name:db.name,panels:db.panels}};
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}
function decodeDashboard(str){ return JSON.parse(decodeURIComponent(escape(atob(str)))); }

function publicUrlForShare(shareId){
  return location.origin + location.pathname + '#public?id=' + encodeURIComponent(shareId);
}

async function showShareModal(){
  var db=getActiveDashboard();
  if(!db){ toast('Сначала откройте дашборд'); return; }

  var sess = getSession();
  $('#shareModal').classList.add('active');
  $('#shareUrl').value = '';
  $('#shareExisting').innerHTML = '<div style="color:var(--muted-2);font-family:var(--mono);font-size:12px;">загрузка…</div>';

  if(sess && sess.src === getSrc() && db.id && !db.id.startsWith('temp_')){
    try{
      var r = await fetch(API + '/dashboards/' + encodeURIComponent(db.id) + '/share', {
        method:'POST', headers: authHeaders()
      });
      if(r.status === 401){ clearSession(); showShareLocal(db); return; }
      if(!r.ok){
        var err = await r.json().catch(function(){return{error:'HTTP '+r.status};});
        toast('Ошибка: ' + (err.error || r.status));
        showShareLocal(db);
        return;
      }
      var data = await r.json();
      var url = publicUrlForShare(data.shareId);
      $('#shareUrl').value = url;
      var sl = await fetch(API + '/shares', { headers: authHeaders() });
      if(sl.ok){
        var slData = await sl.json();
        renderShareList(slData.shares || [], db.id);
      } else {
        $('#shareExisting').innerHTML = '';
      }
    } catch(e){
      toast('Сеть недоступна');
      showShareLocal(db);
    }
  } else {
    showShareLocal(db);
  }
}

function showShareLocal(db){
  var src = getSrc();
  var encoded = encodeDashboard(db, src);
  var url = location.origin + location.pathname + '#view?d=' + encodeURIComponent(encoded);
  $('#shareUrl').value = url;
  $('#shareExisting').innerHTML = '<div style="color:var(--muted-2);font-family:var(--mono);font-size:12px;">локальная ссылка (только в этом б��аузере)</div>';
}

function renderShareList(shares, currentDbId){
  if(!shares.length){ $('#shareExisting').innerHTML = '<div style="color:var(--muted-2);font-family:var(--mono);font-size:12px;">публичных ссылок нет</div>'; return; }
  var html = '<div style="font-size:12px;color:var(--muted-2);margin-bottom:8px;font-family:var(--mono);">Активные ссылки:</div>';
  shares.forEach(function(s){
    var url = publicUrlForShare(s.share_id);
    var isCurrent = s.dashboard_id === currentDbId;
    var revoked = s.revoked;
    html += '<div class="share-row'+(revoked?' revoked':'')+'">';
    html += '<div class="share-row-info">';
    html += '<div class="share-row-name">'+escapeHtml(s.name || 'без имени')+'</div>';
    html += '<div class="share-row-id">#'+escapeHtml(s.share_id)+' · '+(revoked ? '<span style="color:var(--coral);">отозвана</span>' : 'активна')+'</div>';
    html += '</div>';
    if(!revoked){
      html += '<button class="btn btn-ghost share-copy-btn" data-url="'+escapeHtml(url)+'">Копировать</button>';
      html += '<button class="btn btn-danger share-revoke-btn" data-id="'+escapeHtml(s.share_id)+'">Отозвать</button>';
    }
    html += '</div>';
  });
  $('#shareExisting').innerHTML = html;
  $$('.share-copy-btn', $('#shareExisting')).forEach(function(b){
    b.onclick = function(){ navigator.clipboard.writeText(b.dataset.url).then(function(){toast('Скопировано');}); };
  });
  $$('.share-revoke-btn', $('#shareExisting')).forEach(function(b){
    b.onclick = async function(){
      if(!await confirmModal('Отозвать ссылку?', 'После отзыва все, кто открыл её, увидят ошибку.','Да, отозвать')) return;
      try{
        var r = await fetch(API + '/shares/' + encodeURIComponent(b.dataset.id) + '/revoke', {
          method:'POST', headers: authHeaders()
        });
        if(r.ok){ toast('Ссылка отозвана'); showShareModal(); }
        else { var e = await r.json().catch(function(){return{error:'HTTP '+r.status};}); toast('Ошибка: '+(e.error||r.status)); }
      } catch(e){ toast('Сеть недоступна'); }
    };
  });
}

$('#btnCloseShare').onclick=function(){$('#shareModal').classList.remove('active');};
$('#btnCopyShare').onclick=function(){
  var url = $('#shareUrl').value;
  if(!url){ toast('Нечего копировать'); return; }
  navigator.clipboard.writeText(url).then(function(){toast('Скопировано');});
};

/* ── AI Assistant ──────────────────────────────── */
var lastAiPanel = null; // последний успешный конфиг от AI

function openAiPanelModal(){
  var modal = $('#aiPanelModal');
  if(!modal) return;
  var ta = $('#aiPromptInput');
  ta.value = ta.value || '';
  $('#aiPromptCounter').textContent = (ta.value.length) + ' / 300';
  $('#aiStatus').style.display = 'none';
  $('#aiStatus').innerHTML = '';
  $('#aiPreview').style.display = 'none';
  $('#aiPreview').innerHTML = '';
  lastAiPanel = null;
  modal.classList.add('active');
  setTimeout(function(){ ta.focus(); }, 80);
}

function closeAiPanelModal(){
  var modal = $('#aiPanelModal');
  if(modal) modal.classList.remove('active');
}

(function bindAiModal(){
  function ensureBind(){
    var ta = $('#aiPromptInput');
    if(!ta) return false;
    var counter = $('#aiPromptCounter');
    ta.addEventListener('input', function(){
      counter.textContent = ta.value.length + ' / 300';
    });
    ta.addEventListener('keydown', function(e){
      if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)){
        e.preventDefault();
        askAiForPanel();
      }
    });
    $('#aiAskBtn').onclick = function(){ askAiForPanel(); };
    $('#btnCloseAI').onclick = closeAiPanelModal;
    return true;
  }
  if(!ensureBind()){
    document.addEventListener('DOMContentLoaded', ensureBind);
  }
})();

function renderAiPreview(panel){
  var html = '';
  html += '<div class="ai-preview-panel">';
  html += '  <div class="ai-preview-head">';
  html += '    <div class="ai-preview-viz">'+escapeHtml(panel.viz||'?')+'</div>';
  html += '    <div class="ai-preview-title">'+escapeHtml(panel.title||'Без названия')+'</div>';
  html += '  </div>';
  html += '  <div class="ai-preview-meta">'+describeMeta(panel)+'</div>';
  html += '  <div class="ai-preview-actions">';
  html += '    <button class="btn btn-primary" id="aiAddBtn">+ Добавить</button>';
  html += '    <button class="btn btn-ghost" id="aiEditBtn">Открыть в редакторе</button>';
  html += '    <button class="btn btn-ghost" id="aiRetryBtn">Спросить иначе</button>';
  html += '  </div>';
  html += '</div>';
  $('#aiPreview').innerHTML = html;
  $('#aiPreview').style.display = 'block';

  $('#aiAddBtn').onclick = function(){
    if(!lastAiPanel) return;
    addPanelFromConfig(lastAiPanel);
    closeAiPanelModal();
    toast('Панель добавлена');
  };
  $('#aiEditBtn').onclick = function(){
    if(!lastAiPanel) return;
    var cfg = Object.assign({}, lastAiPanel);
    closeAiPanelModal();
    editingPanelId = null;
    $('#modalTitle').textContent = 'Новая панель (из AI)';
    $('#tplGrid').innerHTML = '';
    $('#advToggle').style.display = 'none';
    $('#advForm').classList.add('active');
    populateSuggestions();
    fillAdvForm(cfg);
    $('#panelModal').classList.add('active');
  };
  $('#aiRetryBtn').onclick = function(){
    $('#aiPreview').style.display = 'none';
    $('#aiPreview').innerHTML = '';
    var ta = $('#aiPromptInput');
    $('#aiStatus').style.display = 'none';
    $('#aiStatus').innerHTML = '';
    lastAiPanel = null;
    setTimeout(function(){ ta.focus(); }, 50);
  };
}

function showAiStatus(kind, text){
  var el = $('#aiStatus');
  el.className = 'ai-status ai-status-'+kind;
  el.innerHTML = text;
  el.style.display = 'block';
}

async function askAiForPanel(retryPrompt){
  var btn = $('#aiAskBtn');
  var ta = $('#aiPromptInput');
  var prompt = retryPrompt || ta.value.trim();
  if(!prompt){
    showAiStatus('err','Введите запрос — что хотите увидеть на графике');
    return;
  }

  $('#aiPreview').style.display = 'none';
  $('#aiPreview').innerHTML = '';
  lastAiPanel = null;

  var sess = getSession();
  if(!sess){
    showAiStatus('err','Сначала войдите в кабинет — AI-помощник работает только для авторизованных пользователей.');
    return;
  }

  btn.disabled = true;
  var orig = btn.textContent;
  btn.innerHTML = '<span class="qs-spinner"></span> Думаю…';
  showAiStatus('pending','Отправляю запрос модели…');

  try{
    var r = await fetch(API + '/ai/suggest-panel', {
      method:'POST',
      headers: Object.assign({'Content-Type':'application/json'}, authHeaders()),
      body: JSON.stringify({ prompt: prompt })
    });
    if(r.status === 401){ clearSession(); showAiStatus('err','Сессия истекла — войдите снова'); btn.disabled = false; btn.textContent = orig; return; }
    if(r.status === 429){
      var d = await r.json().catch(function(){ return {}; });
      var sec = d && d.remainSec ? d.remainSec : 60;
      showAiStatus('err','Слишком много запросов. Подождите <span id="aiRateLimitSec">'+sec+'</span> сек.');
      var rlTimer = setInterval(function(){
        sec--;
        var el = document.getElementById('aiRateLimitSec');
        if(el) el.textContent = sec;
        if(sec <= 0){ clearInterval(rlTimer); showAiStatus('pending','Можете пробовать снова.'); btn.disabled = false; }
      }, 1000);
      btn.textContent = orig;
      return;
    }
    if(r.status === 502){
      var errData = await r.json().catch(function(){ return {}; });
      var code = errData.code || '';
      var msg = 'AI не смог разобрать запрос.';
      if(code === 'group_field_missing') msg = 'AI понял, что нужна группировка по полю, но не понял по какому. Уточните имя поля (например: "по полю country").';
      else if(code === 'agg_field_missing') msg = 'AI понял, что нужно посчитать сумму или среднее, но не понял по какому полю. Уточните (например: "сумма по полю amount").';
      else if(code === 'invalid_viz') msg = 'AI выбрал неподдерживаемый тип графика. Попробуйте переформулировать.';
      else if(code === 'invalid_sort') msg = 'AI выбрал некорректную сортировку. Попробуйте переформулировать.';
      else if(code === 'too_many_filters') msg = 'AI добавил слишком много фильтров (макс. 5). Упростите запрос.';
      else msg = 'AI не смог разобрать запрос — попробуйте переформулировать (например: «выручка по дням за неделю»).';
      
      showAiStatus('err', msg);
      btn.disabled = false; btn.textContent = orig;
      return;
    }
    if(!r.ok){
      var e = await r.json().catch(function(){ return {error:'HTTP '+r.status}; });
      showAiStatus('err','Ошибка: '+(e.error || r.status));
      btn.disabled = false; btn.textContent = orig;
      return;
    }
    var data = await r.json();
    if(!data || !data.panel){
      showAiStatus('err','AI вернул пустой ответ. Попробуйте иначе.');
      btn.disabled = false; btn.textContent = orig;
      return;
    }
    lastAiPanel = data.panel;
    $('#aiStatus').style.display = 'none';
    $('#aiStatus').innerHTML = '';
    renderAiPreview(data.panel);
    btn.disabled = false;
    btn.textContent = orig;
  } catch(e){
    showAiStatus('err','Сеть недоступна: '+e.message);
    btn.disabled = false;
    btn.textContent = orig;
  }
}

/* ── Export CSV (требует сессию) ────────────────── */
async function exportCsv(){
  var sess = getSession();
  if(!sess){ toast('Сначала войдите в кабинет'); return; } 
  var btn = $('#btnExport');
  var orig = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; btn.textContent = '↓ Готовлю…'; }
  try{
    var r = await fetch(API + '/export?src=' + encodeURIComponent(sess.src), {
      headers: authHeaders()
    });
    if(r.status === 401){ clearSession(); toast('Сессия истекла — войдите снова'); return; }
    if(r.status === 403){ toast('Нет доступа к этому src'); return; }
    if(!r.ok){ var e = await r.json().catch(function(){return{error:'HTTP '+r.status};}); toast('Ошибка: '+(e.error||r.status)); return; }
    var blob = await r.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (sess.src || 'events') + '_events.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 100);
    toast('Экспорт готов');
  } catch(e){
    toast('Сеть недоступна');
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = orig || '↓ Экспорт CSV'; }
  }
}

/* ── Fullscreen overlay close ───────────────────── */
(function bindFocusOverlay(){
  function bind(){
    var btn = document.getElementById('btnCloseFocus');
    var overlay = document.getElementById('focusOverlay');
    if(!btn || !overlay) return false;
    function closeAndRedraw(){
      overlay.classList.remove('active');
      // Возвращаем график на дашборд: перерисовываем панель, которая была в фокусе
      if(focusPanelId){
        var db = getActiveDashboard();
        if(db){
          var p = db.panels.find(function(x){ return x.id === focusPanelId; });
          if(p) loadPanel(p, getSrc());
        }
        focusPanelId = null;
      }
    }
    btn.onclick = closeAndRedraw;
    overlay.addEventListener('click', function(e){ if(e.target === overlay) closeAndRedraw(); });
    return true;
  }
  if(!bind()) document.addEventListener('DOMContentLoaded', bind);
})();

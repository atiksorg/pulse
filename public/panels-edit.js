/* ═══════════════════════════════════════════════════
   panels-edit.js — модалка редактирования, фильтры,
   lock/duplicate/smooth/export, share-modal, AI, exportCsv
   Зависит от: core.js, panels-render.js
   ═══════════════════════════════════════════════════ */

/* ── Mobile detection helper (duplicated для самодостаточности) ─── */
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

/* ── Привязка обработчиков контекстного меню панели ── */
function bindPanelMenuActions(card, p, src){
  card.querySelector('[data-act="edit"]') && (card.querySelector('[data-act="edit"]').onclick=function(){openEditPanel(p);});
  card.querySelector('[data-act="lock"]') && (card.querySelector('[data-act="lock"]').onclick=function(){ togglePanelLock(p); });
  card.querySelector('[data-act="remove"]') && (card.querySelector('[data-act="remove"]').onclick=async function(){
    if(await confirmModal('Удалить панель?','Удалить панель «'+p.title+'» с дашборда? (Данные останутся в базе)','Удалить')){
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
  });
  card.querySelector('[data-act="clear"]') && (card.querySelector('[data-act="clear"]').onclick=async function(e){
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
  });
  card.querySelector('[data-act="png"]') && (card.querySelector('[data-act="png"]').onclick=function(){ exportPanelPng(p); });
  card.querySelector('[data-act="copy"]') && (card.querySelector('[data-act="copy"]').onclick=function(){ copyPanelData(p); });
  card.querySelector('[data-act="fullscreen"]') && (card.querySelector('[data-act="fullscreen"]').onclick=function(){ openFullscreenPanel(p,src); });
  card.querySelector('[data-act="smooth"]') && (card.querySelector('[data-act="smooth"]').onclick=function(){ toggleSmoothing(p); });
  card.querySelector('[data-act="duplicate"]') && (card.querySelector('[data-act="duplicate"]').onclick=async function(){ duplicatePanel(p); });
  card.querySelector('[data-act="example"]') && (card.querySelector('[data-act="example"]').onclick=function(){ showExampleToast(p, src); });
}

/* ── Toggle panel lock (pin) — in-place, no full re-render ── */
async function togglePanelLock(p){
  p.locked = !p.locked;
  var db = getActiveDashboard();
  if (db) {
    var pp = db.panels.find(function(x){ return x.id === p.id; });
    if (pp) pp.locked = p.locked;
    try { await updateDashboardOnServer(db); } catch(e) { toast('Ошибка: ' + e.message); }
  }

  var card = document.getElementById('body-' + p.id);
  if(card) card = card.closest('.panel-card');
  if(card){
    card.classList.toggle('locked', p.locked);
    var head = card.querySelector('.panel-head');
    if(head) head.style.cursor = p.locked ? 'default' : 'grab';
    var lockItem = card.querySelector('[data-act="lock"]');
    if(lockItem){
      var lbl = lockItem.querySelector('span');
      if(lbl) lbl.textContent = p.locked ? 'Разблокировать' : 'Закрепить';
    }
  }

  toast(p.locked ? '🔒 Панель закреплена' : '🔓 Панель разблокирована');
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

/* ── Toggle line smoothing (tension toggle) ──────── */
function toggleSmoothing(p){
  var chart = charts[p.id];
  if(!chart || p.viz !== 'line'){ toast('Сглаживание только для линейного графика'); return; }
  var ds = chart.data.datasets[0];
  // Если у панели задан tension — используем его как базу для переключения
  var currentTension = typeof p.tension === 'number' ? p.tension : (ds.tension > 0 ? ds.tension : 0.35);
  var newTension = currentTension > 0 ? 0 : 0.35;
  ds.tension = newTension;
  chart.update();
  p.tension = newTension;
  toast(newTension > 0 ? 'Сглаживание включено' : 'Сглаживание выключено');
}

/* ── Duplicate panel ─────────────────────────────── */
async function duplicatePanel(p){
  var db = getActiveDashboard();
  if(!db) return;
  var clone = Object.assign({}, p, { id: uid('panel'), title: (p.title||'Копия')+' (копия)' });
  canvasZCounter = canvasZCounter >= CANVAS_Z_MAX ? CANVAS_Z_MIN : canvasZCounter + 1;
  clone.cz = canvasZCounter;
  if(typeof clone.cx === 'number'){ clone.cx += 40; clone.cy += 40; }
  db.panels.push(clone);
  try {
    await updateDashboardOnServer(db);
    renderPanels();
    toast('Копия создана');
  } catch(e) { toast('Ошибка сохранения: ' + e.message); }
}

/* ── Show example event toast ────────────────────── */
function showExampleToast(p, src){
  var esc = escapeHtml;
  var typePart = p.type ? '&type=' + encodeURIComponent(p.type) : '';
  var extra = '';
  if(p.agg==='sum' && p.aggfield) extra += '&' + encodeURIComponent(p.aggfield) + '=42';
  else if(p.agg==='avg' && p.aggfield) extra += '&' + encodeURIComponent(p.aggfield) + '=42';
  else if(p.group==='__field' && p.field) extra += '&' + encodeURIComponent(p.field) + '=sample';
  else extra += '&value=1';
  var url = API + '/e?src=' + encodeURIComponent(src) + typePart + extra;
  var code = 'fetch("' + url + '");';
  navigator.clipboard.writeText(code).then(function(){
    toast('📡 Пример скопирован: ' + code);
  }).catch(function(){
    toast('📡 ' + code);
  });
}

/* ── Add / Edit panel modal ──────────────────────── */
function openAddPanel(){ editingPanelId=null; $('#modalTitle').textContent='Новая панель'; buildTemplateGrid(); resetAdvForm(); populateSuggestions(); $('#advForm').classList.remove('active'); $('#advToggle').textContent='Настроить вручную →'; $('#panelModal').classList.add('active'); }
function openEditPanel(p){ editingPanelId=p.id; $('#modalTitle').textContent='Изменить панель'; $('#tplGrid').innerHTML=''; $('#advToggle').style.display='none'; $('#advForm').classList.add('active'); populateSuggestions(); fillAdvForm(p); $('#panelModal').classList.add('active'); }
function closePanelModal(){ $('#panelModal').classList.remove('active'); $('#advToggle').style.display=''; editingPanelId=null; }
$('#btnCancelPanel') && ($('#btnCancelPanel').onclick=closePanelModal);
$('#btnAddPanel') && ($('#btnAddPanel').onclick=openAddPanel);
$('#advToggle') && ($('#advToggle').onclick=function(){ var f=$('#advForm'); f.classList.toggle('active'); $('#advToggle').textContent=f.classList.contains('active')?'Скрыть ручные настройки':'Настроить вручную →'; });

function buildTemplateGrid(){
  var grid=$('#tplGrid'); if(!grid) return;
  grid.innerHTML='';
  templates.forEach(function(t){
    var b=document.createElement('button'); b.className='tpl-card';
    b.innerHTML='<div class="t-title">'+t.title+'</div><div class="t-desc">'+t.desc+'</div>';
    b.onclick=function(){
      var cfg=Object.assign({},t.cfg,{title:t.title});
      if(t.cfg.agg==='avg'||t.cfg.group==='__field'){
        $('#advForm').classList.add('active');
        $('#advToggle').textContent='Скрыть ручные настройки';
        fillAdvForm(cfg);
      } else { addPanelFromConfig(cfg); closePanelModal(); }
    };
    grid.appendChild(b);
  });
}

function populateSuggestions(){
  var tl = AppState.suggestions.types || [];
  var el = $('#typeSuggestions');
  if(el) el.innerHTML=tl.map(function(t){return '<option value="'+escapeHtml(t)+'">';}).join('');
  var fl = AppState.suggestions.fields || [];
  var fel = $('#fieldSuggestions');
  if(fel) fel.innerHTML=fl.map(function(t){return '<option value="'+escapeHtml(t)+'">';}).join('');
}

function resetAdvForm(){
  $('#f_title').value=''; $('#f_viz').value='line'; $('#f_type').value=''; $('#f_group').value='day';
  $('#f_fieldname').value=''; $('#f_agg').value='count'; $('#f_aggfield').value='';
  $('#f_range').value='7d'; $('#f_width').value='6'; $('#f_autorefresh').value='0';
  $('#f_sort').value='key'; $('#f_limit').value=''; $('#f_unit').value='';
  $('#f_color').value='#4DECC7'; $('#f_linestyle').value='smooth'; $('#f_format').value='number';
  // tension: по умолчанию 0.35 (smooth) — соответствует lineStyle=smooth
  var tEl = $('#f_tension'); if(tEl) tEl.value = '0.35';
  var bw=$('#f_breakdownfield'); if(bw)bw.value='';
  renderFilterRows([]); toggleCondFields();
}

function fillAdvForm(p){
  $('#f_title').value=p.title; $('#f_viz').value=p.viz; $('#f_type').value=p.type||'';
  $('#f_group').value=p.group==='__field'?'__field':(p.group||'');
  $('#f_fieldname').value=p.field||''; $('#f_agg').value=p.agg||'count';
  $('#f_aggfield').value=p.aggfield||'';
  $('#f_range').value=p.range||'7d'; $('#f_width').value=String(p.width||6);
  $('#f_autorefresh').value=String(p.autorefresh||0);
  $('#f_sort').value=p.sort||'key';
  $('#f_limit').value=p.limit?String(p.limit):'';
  $('#f_unit').value=p.unit||'';
  $('#f_color').value=p.color||'#4DECC7';
  $('#f_linestyle').value=p.lineStyle||'smooth';
  $('#f_format').value=p.formatType||'number';
  // tension: явное значение, либо вычисляем из lineStyle
  var tEl = $('#f_tension');
  if(tEl){
    if(typeof p.tension === 'number'){
      tEl.value = String(p.tension);
    } else {
      tEl.value = (p.lineStyle === 'smooth' || !p.lineStyle) ? '0.35' : '0';
    }
  }
  renderFilterRows(p.filters||[]);
  if(p.from)$('#f_from').value=p.from.slice(0,10);
  if(p.to)$('#f_to').value=p.to.slice(0,10);
  var dbf=$('#f_breakdownfield'); if(dbf)dbf.value=p.breakdownfield||'';
  toggleCondFields();
}

function toggleCondFields(){
  $('#fieldNameWrap').style.display=$('#f_group').value==='__field'?'flex':'none';
  $('#aggFieldWrap').style.display=$('#f_agg').value!=='count'?'flex':'none';
  var cr=$('#customRangeWrap'); if(cr)cr.style.display=$('#f_range').value==='custom'?'flex':'none';
  var viz=$('#f_viz').value;
  var bw=$('#breakdownWrap');
  if(bw){
    var showBreakdown = (viz==='line'||viz==='bar');
    bw.style.display=showBreakdown?'flex':'none';
    if(!showBreakdown){
      var dbf=$('#f_breakdownfield');
      if(dbf) dbf.value='';
    }
  }
  // tension имеет смысл только для line-графиков
  var ts=$('#tensionWrap');
  if(ts) ts.style.display = (viz==='line') ? 'flex' : 'none';
}
$('#f_group') && $('#f_group').addEventListener('change',toggleCondFields);
$('#f_agg') && $('#f_agg').addEventListener('change',toggleCondFields);
$('#f_range') && $('#f_range').addEventListener('change',toggleCondFields);
$('#f_viz') && $('#f_viz').addEventListener('change',toggleCondFields);
$('#btnAddFilter') && $('#btnAddFilter').addEventListener('click',function(){ addFilterRow('','eq',''); });

/* ── Синхронизация lineStyle ↔ tension ──
 * Если пользователь выбрал stepped/straight — ставим tension=0.
 * Если smooth — возвращаем к дефолту 0.35.
 * Если пользователь двигает слайдер — обновляем lineStyle на smooth.
 */
function _onLineStyleChange(){
  var ls = $('#f_linestyle').value;
  var tEl = $('#f_tension');
  if(!tEl) return;
  if(ls === 'smooth') tEl.value = '0.35';
  else if(ls === 'straight') tEl.value = '0';
  else if(ls === 'stepped') tEl.value = '0';
}
function _onTensionChange(){
  var tEl = $('#f_tension');
  var lsEl = $('#f_linestyle');
  if(!tEl || !lsEl) return;
  var v = parseFloat(tEl.value);
  if(isNaN(v)) return;
  // tension>0 — линия сглажена, <0.01 — прямая
  if(v > 0.01) lsEl.value = 'smooth';
  else lsEl.value = 'straight';
  // обновим label (на случай если _updateTensionLabel не вызван)
  var lbl = $('#f_tension_val');
  if(lbl) lbl.textContent = v.toFixed(2);
}
$('#f_linestyle') && $('#f_linestyle').addEventListener('change', _onLineStyleChange);
$('#f_tension') && $('#f_tension').addEventListener('input', _onTensionChange);

/* ── Обновляем числовой label рядом со слайдером tension ── */
function _updateTensionLabel(){
  var tEl = $('#f_tension');
  var lbl = $('#f_tension_val');
  if(tEl && lbl) lbl.textContent = parseFloat(tEl.value).toFixed(2);
}
$('#f_tension') && $('#f_tension').addEventListener('input', _updateTensionLabel);

function readAdvForm(){
  var c={
    title:$('#f_title').value.trim()||'Без названия',
    viz:$('#f_viz').value, type:$('#f_type').value.trim(),
    group:$('#f_group').value, field:$('#f_fieldname').value.trim(),
    agg:$('#f_agg').value, aggfield:$('#f_aggfield').value.trim(),
    range:$('#f_range').value, width:Number($('#f_width').value),
    autorefresh:Number($('#f_autorefresh').value),
    sort:$('#f_sort').value, key:'key',
    unit:$('#f_unit').value.trim(),
    color:$('#f_color').value,
    lineStyle:$('#f_linestyle').value, formatType:$('#f_format').value
  };
  // tension — только для line; clamp 0..1; null если viz не line
  var tEl = $('#f_tension');
  if(tEl && c.viz === 'line'){
    var t = parseFloat(tEl.value);
    if(!isNaN(t)) c.tension = Math.max(0, Math.min(1, t));
  }
  var limitVal=$('#f_limit').value.trim();
  c.limit=limitVal?Number(limitVal):null;
  if(isNaN(c.limit)||c.limit<=0) c.limit=null;
  c.filters=readFilterRows();
  if(c.range==='custom'){c.from=$('#f_from').value||'';c.to=$('#f_to').value||'';}
  var bw=$('#f_breakdownfield');
  c.breakdownfield=bw?bw.value.trim():'';
  if(c.viz !== 'line' && c.viz !== 'bar') c.breakdownfield = '';
  return c;
}

$('#btnSavePanel') && ($('#btnSavePanel').onclick=async function(){
  var cfg=readAdvForm();
  var db = getActiveDashboard();
  if (!db) return;

  if(editingPanelId){
    var p=db.panels.find(function(x){return x.id===editingPanelId;});
    if (p) Object.assign(p,cfg);
  } else {
    var pNew = Object.assign({ id: uid('panel') }, cfg);
    canvasZCounter = canvasZCounter >= CANVAS_Z_MAX ? CANVAS_Z_MIN : canvasZCounter + 1;
    pNew.cz = canvasZCounter;
    if(canvasMode && !isMobile() && interactiveCanvas){
      var vp = interactiveCanvas.viewport.getBoundingClientRect();
      var cw = pNew.cw || 380;
      var ch = pNew.ch || 280;
      var centerX = (vp.width / 2 - interactiveCanvas.offsetX) / interactiveCanvas.scale - cw / 2;
      var centerY = (vp.height / 2 - interactiveCanvas.offsetY) / interactiveCanvas.scale - ch / 2;
      pNew.cx = Math.round(centerX / 20) * 20;
      pNew.cy = Math.round(centerY / 20) * 20;
      pNew.cw = cw;
      pNew.ch = ch;
    }
    db.panels.push(pNew);
  }

  try {
    await updateDashboardOnServer(db);
    renderPanels();
    if(!editingPanelId && canvasMode && !isMobile()){
      setTimeout(function(){ resetCanvasView(true); }, 300);
    }
    closePanelModal();
  } catch(e) { toast('Ошибка сохранения: ' + e.message); }
});

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

  canvasZCounter = canvasZCounter >= CANVAS_Z_MAX ? CANVAS_Z_MIN : canvasZCounter + 1;
  p.cz = canvasZCounter;

  if(canvasMode && !isMobile() && interactiveCanvas){
    var vp = interactiveCanvas.viewport.getBoundingClientRect();
    var cw = p.cw || 380;
    var ch = p.ch || 280;
    var centerX = (vp.width / 2 - interactiveCanvas.offsetX) / interactiveCanvas.scale - cw / 2;
    var centerY = (vp.height / 2 - interactiveCanvas.offsetY) / interactiveCanvas.scale - ch / 2;
    p.cx = Math.round(centerX / 20) * 20;
    p.cy = Math.round(centerY / 20) * 20;
    p.cw = cw;
    p.ch = ch;
  }

  db.panels.push(p);
  try {
    await updateDashboardOnServer(db);
    renderPanels();
    if(canvasMode && !isMobile()){
      setTimeout(function(){ resetCanvasView(true); }, 300);
    }
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
  $('#shareExisting').innerHTML = '<div style="color:var(--muted-2);font-family:var(--mono);font-size:12px;">локальная ссылка (только в этом браузере)</div>';
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

$('#btnCloseShare') && ($('#btnCloseShare').onclick=function(){$('#shareModal').classList.remove('active');});
$('#btnCopyShare') && ($('#btnCopyShare').onclick=function(){
  var url = $('#shareUrl').value;
  if(!url){ toast('Нечего копировать'); return; }
  navigator.clipboard.writeText(url).then(function(){toast('Скопировано');});
});

/* ── AI Assistant (UI скрыт, функции сохранены) ── */
var lastAiPanel = null;

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

/* ── Quick Start Banner (Онбординг) ─────────────── */
function showQuickStartBanner(){
  var banner = $('#quickStartBanner');
  if(!banner) return;
  try {
    if (sessionStorage.getItem('pulse_onboarding_dismissed') === '1') {
      banner.innerHTML = '';
      return;
    }
  } catch(_) { return; }
  var src = getSrc();
  if(!src) { banner.innerHTML = ''; return; }
  var curlUrl = API + '/e?src=' + encodeURIComponent(src) + '&type=test_event&value=100';
  var esc = escapeHtml;
  var html = '<div class="qs-banner">';
  html += '<button class="qs-banner-close" id="qsBannerClose" title="Закрыть">✕</button>';
  html += '<div class="qs-banner-head">🚀 Добро пожаловать! Ваш источник: <b class="teal">' + esc(src) + '</b></div>';
  html += '<div class="qs-banner-body">';
  html += '<div class="qs-banner-code">';
  html += '<pre><span class="c1"># Отправьте первое событие:</span>\ncurl <span class="s1">"' + esc(curlUrl) + '"</span></pre>';
  html += '<button class="btn btn-ghost qs-banner-copy" id="qsBannerCopy">Копировать</button>';
  html += '</div>';
  html += '<button class="btn btn-primary qs-banner-send" id="qsBannerSend"><span class="pg-btn-icon">▶</span> Отправить тестовое событие</button>';
  html += '</div>';
  html += '<div class="qs-banner-hint">Любые query-параметры превращаются в поля лога: <code>&amount=500&user=alex</code></div>';
  html += '</div>';
  banner.innerHTML = html;
  var closeBtn = $('#qsBannerClose');
  if(closeBtn){
    closeBtn.onclick = function(){
      try { sessionStorage.setItem('pulse_onboarding_dismissed', '1'); } catch(_){}
      banner.innerHTML = '';
    };
  }
  var copyBtn = $('#qsBannerCopy');
  if(copyBtn){
    copyBtn.onclick = function(){
      navigator.clipboard.writeText('curl "' + curlUrl + '"').then(function(){
        copyBtn.textContent = 'Скопировано!';
        setTimeout(function(){ copyBtn.textContent = 'Копировать'; }, 1500);
      }).catch(function(){ toast('Не удалось скопировать'); });
    };
  }
  var sendBtn = $('#qsBannerSend');
  if(sendBtn){
    sendBtn.onclick = async function(){
      sendBtn.disabled = true;
      var orig = sendBtn.innerHTML;
      sendBtn.innerHTML = '<span class="qs-spinner"></span> Отправка…';
      try {
        await fetch(curlUrl);
        sendBtn.innerHTML = '✓ Записано!';
        toast('Тестовое событие отправлено');
        setTimeout(function(){
          renderPanels();
          sendBtn.disabled = false;
          sendBtn.innerHTML = orig;
        }, 1000);
      } catch(e) {
        sendBtn.innerHTML = '✕ Ошибка';
        toast('Сеть недоступна');
        setTimeout(function(){
          sendBtn.disabled = false;
          sendBtn.innerHTML = orig;
        }, 2000);
      }
    };
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

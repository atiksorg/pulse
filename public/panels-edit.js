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
      // Запоминаем viewport ПЕРЕД удалением
      _saveCanvasViewport();
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
  card.querySelector('[data-act="ai-optimize"]') && (card.querySelector('[data-act="ai-optimize"]').onclick=function(){ optimizePanelWithAI(p, src); });
  card.querySelector('[data-act="ai-discover"]') && (card.querySelector('[data-act="ai-discover"]').onclick=function(){ discoverPanelsFromLogs(p, src); });
  card.querySelector('[data-act="kpi-alert"]') && (card.querySelector('[data-act="kpi-alert"]').onclick=function(){
    var db = getActiveDashboard();
    if (!db || !db.id || db.id.startsWith('temp_')) { toast('Сначала сохраните дашборд'); return; }
    if (window.KpiAlertsModal) {
      KpiAlertsModal.open(db.id, p.id);
    }
  });
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
  var maxZ = getMaxPanelZ(db.panels);
  clone.cz = maxZ >= CANVAS_Z_MAX ? CANVAS_Z_MAX : maxZ + 1;
  canvasZCounter = clone.cz;
  if(typeof clone.cx === 'number'){ clone.cx += 40; clone.cy += 40; }
  // Запоминаем viewport ПЕРЕД перерисовкой
  _saveCanvasViewport();
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
  // новые опции
  var sEl=$('#f_stacked'); if(sEl) sEl.checked=false;
  var cEl=$('#f_cumulative'); if(cEl) cEl.checked=false;
  var cmpEl=$('#f_compare'); if(cmpEl) cmpEl.checked=false;
  var saEl=$('#f_secondaxis'); if(saEl) saEl.checked=false;
  var gmEl=$('#f_gaugeMin'); if(gmEl) gmEl.value='';
  var gxEl=$('#f_gaugeMax'); if(gxEl) gxEl.value='';
  renderThresholdRows([]); renderFilterRows([]); toggleCondFields();
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
  // новые опции
  var sEl=$('#f_stacked'); if(sEl) sEl.checked=!!p.stacked;
  var cEl=$('#f_cumulative'); if(cEl) cEl.checked=!!p.cumulative;
  var cmpEl=$('#f_compare'); if(cmpEl) cmpEl.checked=!!p.compare;
  var saEl=$('#f_secondaxis'); if(saEl) saEl.checked=!!p.secondAxis;
  var gmEl=$('#f_gaugeMin'); if(gmEl) gmEl.value=p.gaugeMin!==undefined?String(p.gaugeMin):'';
  var gxEl=$('#f_gaugeMax'); if(gxEl) gxEl.value=p.gaugeMax!==undefined?String(p.gaugeMax):'';
  renderThresholdRows(p.thresholds||[]);
  toggleCondFields();
}

function toggleCondFields(){
  $('#fieldNameWrap').style.display=$('#f_group').value==='__field'?'flex':'none';
  // aggFieldWrap нужен для count НЕ нужен, а для всех остальных — нужен
  $('#aggFieldWrap').style.display=$('#f_agg').value!=='count'?'flex':'none';
  var cr=$('#customRangeWrap'); if(cr)cr.style.display=$('#f_range').value==='custom'?'flex':'none';
  var viz=$('#f_viz').value;
  var bw=$('#breakdownWrap');
  if(bw){
    var showBreakdown = (viz==='line'||viz==='bar'||viz==='heatmap');
    bw.style.display=showBreakdown?'flex':'none';
    if(!showBreakdown){
      var dbf=$('#f_breakdownfield');
      if(dbf) dbf.value='';
    }
  }
  // chart options: stacked, cumulative, compare, secondAxis — для line/bar
  var cow=$('#chartOptsWrap');
  if(cow) cow.style.display=(viz==='line'||viz==='bar')?'flex':'none';
  // gauge min/max — только для gauge
  var gw=$('#gaugeWrap');
  if(gw) gw.style.display=(viz==='gauge')?'flex':'none';
  // thresholds — для line/bar
  var tw=$('#thresholdsWrap');
  if(tw) tw.style.display=(viz==='line'||viz==='bar')?'flex':'none';
  // tension — только для line
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
  // новые опции
  var sEl=$('#f_stacked'); c.stacked=sEl?sEl.checked:false;
  var cEl=$('#f_cumulative'); c.cumulative=cEl?cEl.checked:false;
  var cmpEl=$('#f_compare'); c.compare=cmpEl?cmpEl.checked:false;
  var saEl=$('#f_secondaxis'); c.secondAxis=saEl?saEl.checked:false;
  var gmEl=$('#f_gaugeMin'); c.gaugeMin=(gmEl&&gmEl.value!=='')?Number(gmEl.value):undefined;
  var gxEl=$('#f_gaugeMax'); c.gaugeMax=(gxEl&&gxEl.value!=='')?Number(gxEl.value):undefined;
  c.thresholds=readThresholdRows();
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
    // Получаем максимальный Z-index среди ВСЕХ панелей
    var maxZ = getMaxPanelZ(db.panels);
    pNew.cz = maxZ >= CANVAS_Z_MAX ? CANVAS_Z_MAX : maxZ + 1;
    canvasZCounter = pNew.cz;
    if(canvasMode && !isMobile() && interactiveCanvas){
      // Запоминаем viewport ПЕРЕД перерисовкой
      _saveCanvasViewport();
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
    // centerPanelInViewport НЕ вызываем — viewport восстанавливается из _savedCanvasViewport
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

/* ── Threshold rows UI ─────────────────────────── */
function renderThresholdRows(thresholds){
  var container = $('#thresholdRows');
  if(!container) return;
  container.innerHTML = '';
  (thresholds || []).forEach(function(t){ addThresholdRow(t.value, t.color, t.label); });
}
function addThresholdRow(value, color, label){
  var container = $('#thresholdRows');
  if(!container) return;
  var row = document.createElement('div');
  row.className = 'filter-row';
  var valInput = document.createElement('input');
  valInput.className = 'filter-field';
  valInput.type = 'number';
  valInput.placeholder = 'значение';
  valInput.value = value !== undefined ? value : '';
  var colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'filter-value';
  colorInput.style = 'width:50px;height:32px;padding:2px;cursor:pointer;';
  colorInput.value = color || '#FF6B6B';
  var labelInput = document.createElement('input');
  labelInput.className = 'filter-value';
  labelInput.placeholder = 'подпись';
  labelInput.value = label || '';
  var delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'filter-del';
  delBtn.textContent = '×';
  delBtn.title = 'Удалить';
  delBtn.onclick = function(){ row.remove(); };
  row.appendChild(valInput);
  row.appendChild(colorInput);
  row.appendChild(labelInput);
  row.appendChild(delBtn);
  container.appendChild(row);
}
function readThresholdRows(){
  var container = $('#thresholdRows');
  if(!container) return [];
  var result = [];
  container.querySelectorAll('.filter-row').forEach(function(row){
    var inputs = row.querySelectorAll('input');
    var val = parseFloat(inputs[0].value);
    if(isNaN(val)) return;
    result.push({ value: val, color: inputs[1].value || '#FF6B6B', label: inputs[2].value || '' });
  });
  return result;
}

$('#btnAddThreshold') && $('#btnAddThreshold').addEventListener('click',function(){ addThresholdRow('','#FF6B6B',''); });

async function addPanelFromConfig(cfg){
  var db = getActiveDashboard();
  if (!db) return;
  var p = Object.assign({ id: uid('panel') }, cfg);

  // Получаем максимальный Z-index среди ВСЕХ панелей дашборда,
  // чтобы новая панель всегда была поверх существующих
  var maxZ = getMaxPanelZ(db.panels);
  p.cz = maxZ >= CANVAS_Z_MAX ? CANVAS_Z_MAX : maxZ + 1;
  canvasZCounter = p.cz;

  if(canvasMode && !isMobile() && interactiveCanvas){
    // Запоминаем текущий viewport ПЕРЕД перерисовкой
    _saveCanvasViewport();
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
    // centerPanelInViewport НЕ вызываем — восстанавливаем viewport вместо прыжка
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
  var db = getActiveDashboard();
  if(!db){ toast('Сначала откройте дашборд'); return; }

  var content = document.getElementById('shareContent');
  if(!content) return;

  $('#shareModal').classList.add('active');
  content.innerHTML = '<div style="color:var(--muted-2);font-family:var(--mono);font-size:12px;padding:12px 0;">загрузка…</div>';

  var sess = getSession();

  // Для авторизованных дашбордов — получаем серверную ссылку
  if(sess && db.id && !db.id.startsWith('temp_')){
    try {
      var r = await fetch(API + '/dashboards/' + encodeURIComponent(db.id) + '/share', {
        method:'POST', headers: authHeaders()
      });
      if(r.status === 401){ clearSession(); _renderShareLocal(content, db); return; }
      if(!r.ok){
        var err = await r.json().catch(function(){ return {error:'HTTP '+r.status}; });
        toast('Ошибка: ' + (err.error || r.status));
        _renderShareLocal(content, db);
        return;
      }
      var data = await r.json();
      _renderShareServer(content, publicUrlForShare(data.shareId), db.id);
    } catch(e){
      toast('Сеть недоступна');
      _renderShareLocal(content, db);
    }
  } else {
    _renderShareLocal(content, db);
  }
}

/* Отрисовка серверной ссылки: одна ссылка + Копировать + Перегенерировать */
function _renderShareServer(content, url, dbId){
  var esc = escapeHtml;
  var html = '';
  html += '<div class="share-box">';
  html += '  <input id="shareUrl" readonly value="' + esc(url) + '">';
  html += '  <button class="btn btn-ghost" id="btnCopyShare">Копировать</button>';
  html += '</div>';
  html += '<p class="sub" style="margin-top:14px;">Ссылка закрытая. Получатель увидит графики в режиме чтения.</p>';
  html += '<div style="margin-top:16px;display:flex;gap:10px;">';
  html += '  <button class="btn btn-ghost" id="btnRegenerateShare">🔄 Перегенерировать</button>';
  html += '</div>';
  html += '<p class="sub" style="margin-top:8px;font-size:11px;">Перегенерация отзывает текущую ссылку и создаёт новую. Старая перестанет работать.</p>';
  content.innerHTML = html;

  document.getElementById('btnCopyShare').onclick = function(){
    navigator.clipboard.writeText(url).then(function(){ toast('Скопировано'); });
  };
  document.getElementById('btnRegenerateShare').onclick = async function(){
    if(!await confirmModal('Перегенерировать ссылку?', 'Текущая ссылка перестанет работать. Все, кто открыл её, увидят ошибку.', 'Перегенерировать')) return;
    var btn = document.getElementById('btnRegenerateShare');
    btn.disabled = true;
    btn.innerHTML = '<span class="qs-spinner"></span> Генерация…';
    try {
      var r = await fetch(API + '/dashboards/' + encodeURIComponent(dbId) + '/share/regenerate', {
        method:'POST', headers: authHeaders()
      });
      if(r.status === 401){ clearSession(); toast('Сессия истекла'); return; }
      if(!r.ok){
        var e = await r.json().catch(function(){ return {error:'HTTP '+r.status}; });
        toast('Ошибка: ' + (e.error || r.status));
        btn.disabled = false;
        btn.innerHTML = '🔄 Перегенерировать';
        return;
      }
      var data = await r.json();
      var newUrl = publicUrlForShare(data.shareId);
      _renderShareServer(content, newUrl, dbId);
      toast('Новая ссылка создана');
    } catch(e){
      toast('Сеть недоступна');
      btn.disabled = false;
      btn.innerHTML = '🔄 Перегенерировать';
    }
  };
}

/* Локальная (не серверная) ссылка для неавторизованных / temp-дашбордов */
function _renderShareLocal(content, db){
  var src = getSrc();
  var encoded = encodeDashboard(db, src);
  var url = location.origin + location.pathname + '#view?d=' + encodeURIComponent(encoded);
  var esc = escapeHtml;
  var html = '';
  html += '<div class="share-box">';
  html += '  <input id="shareUrl" readonly value="' + esc(url) + '">';
  html += '  <button class="btn btn-ghost" id="btnCopyShare">Копировать</button>';
  html += '</div>';
  html += '<p class="sub" style="margin-top:14px;color:var(--muted-2);font-family:var(--mono);font-size:12px;">локальная ссылка (данные в URL, не на сервере)</p>';
  content.innerHTML = html;

  document.getElementById('btnCopyShare').onclick = function(){
    navigator.clipboard.writeText(url).then(function(){ toast('Скопировано'); });
  };
}

$('#btnCloseShare') && ($('#btnCloseShare').onclick=function(){$('#shareModal').classList.remove('active');});

/* ── AI Optimize: оптимизация существующей панели ── */
async function optimizePanelWithAI(p, src){
  var sess = getSession();
  if(!sess){ toast('Войдите в кабинет — AI работает только для авторизованных'); return; }

  // Собираем данные с текущего графика
  var chart = charts[p.id];
  var dataSample = { labels:[], values:[], totalPoints:0 };
  if(chart && chart.data){
    dataSample.labels = (chart.data.labels || []).slice(0, 20);
    var ds0 = chart.data.datasets[0];
    dataSample.values = ds0 ? (ds0.data || []).slice(0, 20) : [];
    dataSample.totalPoints = (chart.data.labels || []).length;
  }

  // Текущий конфиг (только стандартные поля)
  var config = {
    viz: p.viz || '',
    type: p.type || '',
    group: p.group || '',
    field: p.field || '',
    agg: p.agg || 'count',
    aggfield: p.aggfield || '',
    range: p.range || '7d',
    width: p.width || 6,
    sort: p.sort || 'key',
    limit: p.limit || null,
    filters: p.filters || []
  };

  // Закрываем dropdown menu
  document.querySelectorAll('.panel-menu-dropdown.show').forEach(function(d){ d.classList.remove('show'); });

  // Показываем спиннер в body панели
  var body = document.getElementById('body-' + p.id);
  var origContent = body ? body.innerHTML : '';
  // Блокируем auto-refresh для этой панели, пока AI думает
  panelAiActive[p.id] = true;
  if(body){
    body.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:20px;color:var(--muted-2);font-family:var(--mono);font-size:12px;"><span class="qs-spinner"></span> AI анализирует график…</div>';
  }

  try{
    var r = await fetch(API + '/ai/optimize-panel', {
      method:'POST',
      headers: Object.assign({'Content-Type':'application/json'}, authHeaders()),
      body: JSON.stringify({ config: config, dataSample: dataSample })
    });

    if(r.status === 401){ clearSession(); toast('Сессия истекла'); delete panelAiActive[p.id]; if(body) body.innerHTML = origContent; return; }
    if(r.status === 429){
      var d = await r.json().catch(function(){ return {}; });
      toast('Слишком много запросов. Подождите '+(d.remainSec||60)+' сек.');
      delete panelAiActive[p.id];
      if(body) body.innerHTML = origContent;
      return;
    }
    if(!r.ok){
      var e = await r.json().catch(function(){ return {error:'HTTP '+r.status}; });
      toast('Ошибка AI: '+(e.error||e.message||r.status));
      delete panelAiActive[p.id];
      if(body) body.innerHTML = origContent;
      return;
    }

    var data = await r.json();

    if(data.status === 'ok'){
      toast('👌 График оптимален: '+(data.reason || 'изменения не требуются'));
      delete panelAiActive[p.id];
      if(body) body.innerHTML = origContent;
      return;
    }

    if(data.status === 'optimized' && data.panel){
      // НЕ восстанавливаем содержимое панели — оставляем спиннер
      // пока пользователь не примет решение в модалке

      // Показываем модалку с предложением
      var reason = data.reason || 'AI предлагает изменения';
      var newPanel = data.panel;
      var changes = [];
      if(newPanel.viz !== config.viz) changes.push('viz: '+config.viz+' → '+newPanel.viz);
      if(newPanel.group !== config.group) changes.push('group: '+config.group+' → '+newPanel.group);
      if(newPanel.range !== config.range) changes.push('range: '+config.range+' → '+newPanel.range);
      if(newPanel.agg !== config.agg) changes.push('agg: '+config.agg+' → '+newPanel.agg);
      if(newPanel.sort !== config.sort) changes.push('sort: '+config.sort+' → '+newPanel.sort);
      if(String(newPanel.limit) !== String(config.limit)) changes.push('limit: '+(config.limit||'нет')+' → '+(newPanel.limit||'нет'));

      var esc = escapeHtml;
      var modalHtml = '<div style="margin-bottom:12px;font-size:13px;color:var(--text);">'+esc(reason)+'</div>';
      if(changes.length){
        modalHtml += '<div style="margin-bottom:16px;font-family:var(--mono);font-size:11px;color:var(--muted-2);">';
        changes.forEach(function(c){ modalHtml += '<div style="padding:2px 0;">• '+esc(c)+'</div>'; });
        modalHtml += '</div>';
      }
      modalHtml += '<div style="display:flex;gap:10px;justify-content:flex-end;">';
      modalHtml += '<button class="btn btn-primary" id="aiOptApply">✓ Применить</button>';
      modalHtml += '<button class="btn btn-ghost" id="aiOptEdit">Открыть в редакторе</button>';
      modalHtml += '<button class="btn btn-ghost" id="aiOptCancel">Отмена</button>';
      modalHtml += '</div>';

      // Создаём overlay
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay active';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';
      var box = document.createElement('div');
      box.className = 'modal-box';
      box.style.cssText = 'max-width:440px;width:90%;';
      box.innerHTML = '<div class="modal-header"><h3>✨ AI предлагает оптимизацию</h3></div><div class="modal-body" style="padding:16px;">'+modalHtml+'</div>';
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      // closeOverlay восстанавливает содержимое панели
      function closeOverlay(){
        overlay.remove();
        delete panelAiActive[p.id];
        if(body) body.innerHTML = origContent;
      }

      box.querySelector('#aiOptCancel').onclick = closeOverlay;
      overlay.addEventListener('click', function(e){ if(e.target === overlay) closeOverlay(); });

      box.querySelector('#aiOptApply').onclick = async function(){
        overlay.remove();
        delete panelAiActive[p.id];
        var db = getActiveDashboard();
        if(!db){ if(body) body.innerHTML = origContent; return; }
        var pp = db.panels.find(function(x){ return x.id === p.id; });
        if(!pp){ if(body) body.innerHTML = origContent; return; }
        Object.assign(pp, newPanel);
        try {
          await updateDashboardOnServer(db);
          _saveCanvasViewport();
          renderPanels();
          toast('✨ Панель оптимизирована AI');
        } catch(err){
          toast('Ошибка сохранения: '+err.message);
          if(body) body.innerHTML = origContent;
        }
      };

      box.querySelector('#aiOptEdit').onclick = function(){
        overlay.remove();
        delete panelAiActive[p.id];
        // Восстанавливаем содержимое панели перед открытием редактора
        if(body) body.innerHTML = origContent;
        editingPanelId = p.id;
        $('#modalTitle').textContent = 'Оптимизация (AI)';
        $('#tplGrid').innerHTML = '';
        $('#advToggle').style.display = 'none';
        $('#advForm').classList.add('active');
        populateSuggestions();
        fillAdvForm(Object.assign({}, p, newPanel));
        $('#panelModal').classList.add('active');
      };
      return;
    }

    toast('AI вернул неожиданный ответ');
    delete panelAiActive[p.id];
    if(body) body.innerHTML = origContent;

  } catch(err){
    toast('Ошибка: '+err.message);
    delete panelAiActive[p.id];
    if(body) body.innerHTML = origContent;
  }
}

/* ── AI Discover: построить дашборд из логов ───────── */
async function discoverPanelsFromLogs(p, src){
  var sess = getSession();
  if(!sess){ toast('Войдите в кабинет — AI работает только для авторизованных'); return; }

  var events = (p._logsEvents || []).slice(0, 100);
  if(events.length < 3){ toast('Нужно минимум 3 события для анализа'); return; }

  // Закрываем dropdown
  document.querySelectorAll('.panel-menu-dropdown.show').forEach(function(d){ d.classList.remove('show'); });

  // Показываем спиннер
  var body = document.getElementById('body-' + p.id);
  var origContent = body ? body.innerHTML : '';
  panelAiActive[p.id] = true;
  if(body){
    body.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:20px;color:var(--muted-2);font-family:var(--mono);font-size:12px;"><span class="qs-spinner"></span> AI анализирует '+events.length+' событий…</div>';
  }

  try{
    var r = await fetch(API + '/ai/discover-panels', {
      method:'POST',
      headers: Object.assign({'Content-Type':'application/json'}, authHeaders()),
      body: JSON.stringify({ events: events, src: src })
    });

    if(r.status === 401){ clearSession(); toast('Сессия истекла'); delete panelAiActive[p.id]; if(body) body.innerHTML = origContent; return; }
    if(r.status === 429){
      var d = await r.json().catch(function(){ return {}; });
      toast('Слишком много запросов. Подождите '+(d.remainSec||60)+' сек.');
      delete panelAiActive[p.id]; if(body) body.innerHTML = origContent;
      return;
    }
    if(!r.ok){
      var e = await r.json().catch(function(){ return {error:'HTTP '+r.status}; });
      toast('Ошибка AI: '+(e.error||e.message||r.status));
      delete panelAiActive[p.id]; if(body) body.innerHTML = origContent;
      return;
    }

    var data = await r.json();
    if(!data || !data.panels || !data.panels.length){
      toast('AI не смог проанализировать логи');
      delete panelAiActive[p.id]; if(body) body.innerHTML = origContent;
      return;
    }

    // Показываем модалку превью (body оставляем со спиннером)
    showDiscoverPreview(data.panels, data.summary || '', p, src, origContent);

  } catch(err){
    toast('Ошибка: '+err.message);
    delete panelAiActive[p.id]; if(body) body.innerHTML = origContent;
  }
}

function showDiscoverPreview(panels, summary, sourcePanel, src, origContent){
  var esc = escapeHtml;
  var body = document.getElementById('body-' + sourcePanel.id);

  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';
  var box = document.createElement('div');
  box.className = 'modal-box';
  box.style.cssText = 'max-width:520px;width:90%;max-height:80vh;overflow-y:auto;';

  var vizLabels = {line:'📈 Линия', bar:'📊 Столбцы', pie:'🥧 Круговая', kpi:'🔢 KPI', table:'📋 Таблица', logs:'📝 Логи', gauge:'⏲ Gauge'};

  var panelsHtml = panels.map(function(panel){
    var vizLabel = vizLabels[panel.viz] || panel.viz;
    return '<div style="background:var(--card-bg,#141921);border:1px solid var(--border,#1A2130);border-radius:8px;padding:10px 12px;margin-bottom:6px;">'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">'
      + '<span style="font-size:13px;font-weight:600;">'+vizLabel+'</span>'
      + '<span style="font-size:12px;color:var(--text);">'+esc(panel.title)+'</span>'
      + '</div>'
      + '<div class="meta" style="font-size:10px;">'+describeMeta(panel)+'</div>'
      + '</div>';
  }).join('');

  var html = '<div style="padding:20px;">'
    + '<h3 style="margin:0 0 8px;">✨ AI нашёл '+panels.length+' график(а)</h3>'
    + (summary ? '<p style="font-size:12px;color:var(--muted-2);margin:0 0 14px;">'+esc(summary)+'</p>' : '')
    + panelsHtml
    + '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">'
    + '<button class="btn btn-primary" id="discApply">✓ Создать '+panels.length+' панели</button>'
    + '<button class="btn btn-ghost" id="discEdit">Открыть в редакторе</button>'
    + '<button class="btn btn-ghost" id="discCancel">Отмена</button>'
    + '</div></div>';

  box.innerHTML = html;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  function closeOverlay(){
    overlay.remove();
    delete panelAiActive[sourcePanel.id];
    if(body) body.innerHTML = origContent;
  }

  box.querySelector('#discCancel').onclick = closeOverlay;
  overlay.addEventListener('click', function(e){ if(e.target === overlay) closeOverlay(); });

  box.querySelector('#discApply').onclick = async function(){
    overlay.remove();
    delete panelAiActive[sourcePanel.id];
    await applyDiscoveredPanels(panels, sourcePanel);
  };

  box.querySelector('#discEdit').onclick = function(){
    // Открываем первую панель в редакторе, остальные — через addPanelFromConfig
    overlay.remove();
    delete panelAiActive[sourcePanel.id];
    if(body) body.innerHTML = origContent;
    if(panels.length > 0){
      var first = panels[0];
      // Добавляем остальные панели сразу
      for(var i = 1; i < panels.length; i++){
        addPanelFromConfig(panels[i]);
      }
      // Первую открываем в редакторе
      editingPanelId = null;
      $('#modalTitle').textContent = 'AI: '+first.title;
      $('#tplGrid').innerHTML = '';
      $('#advToggle').style.display = 'none';
      $('#advForm').classList.add('active');
      populateSuggestions();
      fillAdvForm(first);
      $('#panelModal').classList.add('active');
    }
  };
}

async function applyDiscoveredPanels(panels, sourcePanel){
  var db = getActiveDashboard();
  if(!db) return;

  _saveCanvasViewport();
  var maxZ = getMaxPanelZ(db.panels);
  var gap = 30;
  var baseX = (sourcePanel.cx || 0) + (sourcePanel.cw || 480) + gap;
  var baseY = sourcePanel.cy || 0;

  // Размещаем панели в 2 колонки
  var col = 0, currentY = baseY, maxRowH = 0;
  panels.forEach(function(cfg){
    var pNew = Object.assign({ id: uid('panel') }, cfg);
    pNew.cz = Math.min(++maxZ, CANVAS_Z_MAX);
    var pr = getVizPreset(pNew.viz);
    pNew.cw = pr.cw;
    pNew.ch = pr.ch;
    pNew.cx = baseX + col * (pr.cw + gap);
    pNew.cy = currentY;
    maxRowH = Math.max(maxRowH, pr.ch);
    db.panels.push(pNew);
    col++;
    if(col >= 2){
      col = 0;
      currentY += maxRowH + gap;
      maxRowH = 0;
    }
  });

  try{
    await updateDashboardOnServer(db);
    renderPanels();
    toast('✨ Создано '+panels.length+' панелей из логов');
  } catch(err){
    toast('Ошибка сохранения: '+err.message);
    // Восстанавливаем панель-источник при ошибке
    loadPanel(sourcePanel, getSrc());
  }
}

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

/* ── buildPanelSummary: краткое текстовое описание сути панели ── */
function buildPanelSummary(p, src){
  var vizNames = {line:'Линейный график',bar:'Столбчатая диаграмма',pie:'Круговая диаграмма',kpi:'KPI-число',table:'Таблица',logs:'Таблица логов',gauge:'Шкала-индикатор',heatmap:'Тепловая карта'};
  var rangeNames = {'24h':'24ч','7d':'7д','30d':'30д','all':'всё время','custom':'выбранный период'};
  var groupNames = {'day':'по дням','hour':'по часам','minute':'по минутам','month':'по месяцам','week':'по неделям','__field':'по полю'};
  var aggNames = {'count':'количество','sum':'сумма','avg':'среднее','min':'минимум','max':'максимум','median':'медиана','p95':'p95','p99':'p99'};

  var parts = [];
  parts.push(vizNames[p.viz] || p.viz);
  parts.push(p.type ? 'тип: '+p.type : 'все типы');

  if(p.group === '__field' || p.group === 'field'){
    parts.push('по полю '+(p.field || '?'));
  } else if(p.group){
    parts.push(groupNames[p.group] || p.group);
  }

  if(p.agg && p.agg !== 'count'){
    parts.push(aggNames[p.agg]||p.agg + (p.aggfield ? ' по полю '+p.aggfield : ''));
  }

  parts.push(rangeNames[p.range] || p.range || '—');

  if(p.sort && p.sort !== 'key') parts.push('сортировка: '+(p.sort==='value_desc'?'по убыванию':'по возрастанию'));
  if(p.limit && Number(p.limit)>0) parts.push('топ-'+Number(p.limit));
  if(p.stacked) parts.push('stacked');
  if(p.cumulative) parts.push('нарастающий');
  if(p.compare) parts.push('сравнение периодов');
  if(p.secondAxis) parts.push('две оси Y');
  if(p.breakdownfield) parts.push('разбивка: '+p.breakdownfield);
  if(p.unit) parts.push('ед.: '+p.unit);
  if(Array.isArray(p.filters) && p.filters.length){
    p.filters.forEach(function(f){
      var fv = Array.isArray(f.value) ? f.value.join(',') : String(f.value);
      if(fv.length > 20) fv = fv.slice(0,18)+'…';
      parts.push(f.field+({'eq':'=','neq':'≠','gt':'>','lt':'<','in':'∈','contains':'~'}[f.op]||f.op)+fv);
    });
  }

  /* Добавляем реальные данные, если есть */
  var bodyEl = document.getElementById('body-' + p.id);
  var chart = charts[p.id];

  if(p.viz === 'kpi' || p.viz === 'gauge'){
    var total = bodyEl ? bodyEl.getAttribute('data-total') : null;
    if(total !== null && total !== ''){
      parts.push('значение: '+total);
    }
  }
  else if(p.viz === 'logs'){
    var events = p._logsEvents || [];
    parts.push(events.length+' событий');
    if(events.length > 0){
      /* Считаем топ типов из первых 100 событий */
      var typeMap = {};
      events.slice(0,100).forEach(function(ev){ typeMap[ev.type] = (typeMap[ev.type]||0)+1; });
      var topTypes = Object.keys(typeMap).sort(function(a,b){return typeMap[b]-typeMap[a];}).slice(0,5);
      if(topTypes.length){
        parts.push('типы: '+topTypes.map(function(t){return t+'('+typeMap[t]+')';}).join(', '));
      }
    }
  }
  else if(p.viz === 'table'){
    var rows = p._tableData || [];
    parts.push(rows.length+' строк');
  }
  else if(chart && chart.data){
    var labels = chart.data.labels || [];
    var ds0 = chart.data.datasets[0];
    var values = ds0 ? ds0.data.filter(function(v){return v!==null&&v!==undefined;}) : [];
    if(values.length){
      var min = Math.min.apply(null, values);
      var max = Math.max.apply(null, values);
      var sum = values.reduce(function(a,b){return a+b;},0);
      var avg = sum / values.length;
      parts.push(labels.length+' точек · min='+formatCompact(min)+' max='+formatCompact(max)+' avg='+formatCompact(avg));
    }
    if(chart.data.datasets.length > 1){
      parts.push(chart.data.datasets.length+' серий');
    }
  }

  return parts.join(' · ');
}

/* ── Export XML: compact dashboard snapshot for AI visualization ── */
function exportXml(fullMode){
  var db = getActiveDashboard();
  if(!db || !db.panels || !db.panels.length){
    toast('Нет данных для экспорта');
    return;
  }
  var src = getSrc() || '';
  var now = new Date().toISOString();
  var tz = getUtcOffsetStr();
  var compact = !fullMode;

  /* XML-атрибут экранирование */
  function xa(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  }

  var L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<pulse-dashboard name="' + xa(db.name) + '" src="' + xa(src) + '" exported="' + xa(now) + '" tz="' + xa(tz) + '"' + (compact ? ' compact="true"' : '') + '>');

  /* Viewport холста */
  if(interactiveCanvas && !interactiveCanvas._destroyed){
    L.push('  <canvas scale="' + interactiveCanvas.scale.toFixed(3)
      + '" offsetX="' + Math.round(interactiveCanvas.offsetX)
      + '" offsetY="' + Math.round(interactiveCanvas.offsetY) + '" />');
  }

  /* Каждая панель */
  db.panels.forEach(function(p){
    if(compact){
      /* ── Компактный режим: summary вместо данных ── */
      var summary = buildPanelSummary(p, src);
      L.push('  <panel viz="' + xa(p.viz) + '" title="' + xa(p.title) + '" summary="' + xa(summary) + '" />');
    } else {
      /* ── Полный режим: всё как раньше ── */
      L.push('  <panel id="' + xa(p.id) + '" title="' + xa(p.title) + '" viz="' + xa(p.viz) + '"'
        + ' x="' + (p.cx||0) + '" y="' + (p.cy||0) + '" w="' + (p.cw||0) + '" h="' + (p.ch||0) + '" z="' + (p.cz||0) + '"'
        + ' locked="' + (!!p.locked) + '">');

      /* Конфигурация данных */
      var cfgA = '';
      ['type','group','field','agg','aggfield','range','from','to','sort','limit',
       'unit','color','formatType','lineStyle','tension','width','autorefresh',
       'stacked','cumulative','compare','secondAxis','gaugeMin','gaugeMax','breakdownfield']
        .forEach(function(k){
          var v = p[k];
          if(v !== undefined && v !== null && v !== '') cfgA += ' ' + k + '="' + xa(v) + '"';
        });
      L.push('    <config' + cfgA + ' />');

      /* Фильтры */
      if(Array.isArray(p.filters) && p.filters.length){
        L.push('    <filters>');
        p.filters.forEach(function(f){
          var fv = Array.isArray(f.value) ? f.value.join(',') : String(f.value);
          L.push('      <filter field="' + xa(f.field) + '" op="' + xa(f.op) + '" value="' + xa(fv) + '" />');
        });
        L.push('    </filters>');
      }

      /* Пороговые линии */
      if(Array.isArray(p.thresholds) && p.thresholds.length){
        L.push('    <thresholds>');
        p.thresholds.forEach(function(t){
          L.push('      <threshold value="' + t.value + '" color="' + xa(t.color) + '" label="' + xa(t.label) + '" />');
        });
        L.push('    </thresholds>');
      }

      /* Извлечение данных по типу визуализации */
      var bodyEl = document.getElementById('body-' + p.id);
      var chart = charts[p.id];

      if(p.viz === 'kpi'){
        var total = bodyEl ? bodyEl.getAttribute('data-total') : '';
        L.push('    <data total="' + xa(total) + '" />');
      }
      else if(p.viz === 'gauge'){
        var total = bodyEl ? bodyEl.getAttribute('data-total') : '';
        L.push('    <data total="' + xa(total) + '"'
          + ' min="' + (p.gaugeMin !== undefined ? p.gaugeMin : 0) + '"'
          + ' max="' + (p.gaugeMax !== undefined ? p.gaugeMax : 100) + '" />');
      }
      else if(p.viz === 'table'){
        var rows = p._tableData || [];
        var key = panelKey(p);
        var maxRows = Math.min(rows.length, 20);
        L.push('    <data rows="' + rows.length + '" shown="' + maxRows + '">');
        for(var i = 0; i < maxRows; i++){
          L.push('      <row key="' + xa(rows[i][key]) + '" value="' + rows[i].value + '" />');
        }
        L.push('    </data>');
      }
      else if(p.viz === 'logs'){
        var events = p._logsEvents || [];
        var maxEv = Math.min(events.length, 10);
        L.push('    <data events="' + events.length + '" shown="' + maxEv + '">');
        for(var i = 0; i < maxEv; i++){
          var ev = events[i];
          var msg = '';
          try {
            var pl = JSON.parse(ev.payload);
            var pkeys = Object.keys(pl);
            msg = pkeys.slice(0, 3).map(function(k){ return k + '=' + String(pl[k]); }).join(', ');
          } catch(_){
            msg = String(ev.payload || '');
          }
          if(msg.length > 80) msg = msg.slice(0, 77) + '…';
          L.push('      <event time="' + xa(ev.ts) + '" type="' + xa(ev.type) + '" msg="' + xa(msg) + '" />');
        }
        L.push('    </data>');
      }
      else if(chart && chart.data){
        var labels = chart.data.labels || [];
        var datasets = chart.data.datasets || [];
        if(datasets.length > 1){
          L.push('    <data points="' + labels.length + '" series="' + datasets.length + '">');
          datasets.forEach(function(ds){
            L.push('      <series name="' + xa(ds.label || '') + '">');
            for(var i = 0; i < labels.length; i++){
              var v = ds.data[i];
              if(v !== null && v !== undefined){
                L.push('        <point label="' + xa(labels[i]) + '" value="' + v + '" />');
              }
            }
            L.push('      </series>');
          });
          L.push('    </data>');
        } else {
          var values = datasets[0] ? datasets[0].data : [];
          L.push('    <data points="' + labels.length + '">');
          for(var i = 0; i < labels.length; i++){
            var v = values[i];
            L.push('      <point label="' + xa(labels[i]) + '" value="' + (v != null ? v : '') + '" />');
          }
          L.push('    </data>');
        }
      }
      else {
        L.push('    <data />');
      }

      L.push('  </panel>');
    }
  });

  L.push('</pulse-dashboard>');

  /* Скачивание .xml файла */
  var xml = L.join('\n');
  var blob = new Blob([xml], { type: 'application/xml' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  var suffix = compact ? '_compact' : '_full';
  a.download = (db.name || 'dashboard').replace(/[^a-zA-Z0-9_-]/g, '_') + suffix + '.xml';
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 100);
  toast((compact ? 'Компактный XML' : 'Полный XML') + ' · ' + db.panels.length + ' панелей');
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

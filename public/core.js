/* ═══════════════════════════════════════════════════
   core.js — In-Memory State, сетевые функции, утилиты
   ═══════════════════════════════════════════════════ */

// ── Одноразовая очистка мусора от старых версий ──────
// (выполняется ровно один раз: если в localStorage есть
//  ключи от старой версии — удаляем их. После этого
//  приложение больше НИКОГДА не пишет в localStorage.)
try {
  if (localStorage.getItem('pulse_migrated_v2') !== '1') {
    localStorage.clear();
    localStorage.setItem('pulse_migrated_v2', '1');
  }
} catch(_) {}

const API = "https://events.atiks.org";
const $ = (s,ctx)=> (ctx||document).querySelector(s);
const $$ = (s,ctx)=> Array.from((ctx||document).querySelectorAll(s));

/* ── Mobile / Touch detection (канонический хелпер) ── */
function isMobile(){
  return window.innerWidth < 860;
}
function isTouchDevice(){
  return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

/* ── In-Memory State (единственное место хранения) ── */
var AppState = {
  session: null,        // { src, token, expiresAt } | null
  dashboards: [],       // [{ id, name, panels }]
  activeId: null,       // id активного дашборда
  suggestions: { types: [], fields: [] }
};

/* ── Shared mutable state (UI-only) ───────────────── */
var charts = {};
var refreshTimers = {};
var panelAiActive = {};       // { panelId: true } — AI-оптимизация в процессе, не обновлять
var editingPanelId = null;
var canvasMode = true;
var demoPulseTimer = null;
var currentCase = null;
var toastTimer;
var dragSrcPanelId = null;
var isPublicView = false;
var publicShare = null;

/* ── Canvas z-index layer (Layer 3: 100–899) ────── */
var CANVAS_Z_MIN = 100;
var CANVAS_Z_MAX = 890;
var canvasZCounter = CANVAS_Z_MIN;

/* ── UID ─────────────────────────────────────────── */
function uid(prefix){
  var bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  var id = Array.from(bytes, function(b){ return b.toString(36).padStart(2,'0'); }).join('').slice(0,16);
  return prefix + '_' + id;
}

/* ── Session helpers (только RAM + sessionStorage) ── */
function getSession(){
  if (AppState.session) return AppState.session;
  try { return JSON.parse(sessionStorage.getItem('pulse_session')); } catch(e) { return null; }
}
function getSrc(){ var s = getSession(); return s ? s.src : null; }
function setSession(sess){
  if (!sess) { AppState.session = null; sessionStorage.removeItem('pulse_session'); return; }
  // Проверяем expiresAt
  if (sess.expiresAt && new Date(sess.expiresAt).getTime() < Date.now()) {
    AppState.session = null;
    sessionStorage.removeItem('pulse_session');
    return;
  }
  AppState.session = sess;
  sessionStorage.setItem('pulse_session', JSON.stringify(sess));
}
function clearSession(){ AppState.session = null; sessionStorage.removeItem('pulse_session'); }

/* ── Auth API ────────────────────────────────────── */
async function authRegister(src, pin){
  var r = await fetch(API + '/auth/register', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ src: src, pin: pin })
  });
  var data = await r.json().catch(function(){ return {}; });
  return { ok: r.ok, status: r.status, data: data };
}
async function authLogin(src, pin){
  var r = await fetch(API + '/auth/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ src: src, pin: pin })
  });
  var data = await r.json().catch(function(){ return {}; });
  return { ok: r.ok, status: r.status, data: data };
}
async function authLogout(){
  var sess = getSession();
  if (!sess) return;
  try {
    await fetch(API + '/auth/logout', {
      method:'POST', headers:{ 'Authorization': 'Bearer ' + sess.token }
    });
  } catch(_){}
  clearSession();
}

/* ── API fetch with auth header ──────────────────── */
function authHeaders(){
  var sess = getSession();
  return sess ? { 'Authorization': 'Bearer ' + sess.token } : {};
}

/* ── Dashboards API (только сеть, без кэша) ──────── */
async function loadDashboardsFromServer(){
  var sess = getSession();
  if (!sess) throw new Error('no session');
  var r = await fetch(API + '/dashboards', { headers: authHeaders() });
  if (r.status === 401) { clearSession(); throw new Error('unauthorized'); }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  var data = await r.json();
  AppState.dashboards = data.dashboards || [];
  // Если активный id не из списка — берём первый
  if (!AppState.activeId || !AppState.dashboards.find(function(d){ return d.id === AppState.activeId; })) {
    AppState.activeId = AppState.dashboards.length ? AppState.dashboards[0].id : null;
  }
  return AppState.dashboards;
}

async function createDashboardOnServer(name, panels){
  var r = await fetch(API + '/dashboards', {
    method:'POST',
    headers: Object.assign({'Content-Type':'application/json'}, authHeaders()),
    body: JSON.stringify({ name: name || 'Новый дашборд', panels: panels || [], layoutMode: 'canvas' })
  });
  if (r.status === 401) { clearSession(); throw new Error('unauthorized'); }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  var data = await r.json();
  if (data && data.dashboard) {
    AppState.dashboards.push(data.dashboard);
    return data.dashboard;
  }
  throw new Error('invalid response');
}

async function updateDashboardOnServer(db){
  // Очищаем панели от runtime-данных (_logsEvents, _tableData и т.д.),
  // иначе JSON-пейлоад раздувается и превышает лимит body на сервере → 502
  var cleanPanels = (db.panels || []).map(sanitizePanelForSave);
  var r = await fetch(API + '/dashboards/' + encodeURIComponent(db.id), {
    method:'PUT',
    headers: Object.assign({'Content-Type':'application/json'}, authHeaders()),
    body: JSON.stringify({ name: db.name, panels: cleanPanels, layoutMode: 'canvas' })
  });
  if (r.status === 401) { clearSession(); throw new Error('unauthorized'); }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  var data = await r.json();
  if (data && data.dashboard) {
    // Обновляем в AppState
    var idx = AppState.dashboards.findIndex(function(d){ return d.id === db.id; });
    if (idx !== -1) AppState.dashboards[idx] = data.dashboard;
    return data.dashboard;
  }
  return db;
}

async function deleteDashboardOnServer(id){
  var r = await fetch(API + '/dashboards/' + encodeURIComponent(id), {
    method:'DELETE', headers: authHeaders()
  });
  if (r.status === 401) { clearSession(); throw new Error('unauthorized'); }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  // Удаляем из AppState
  AppState.dashboards = AppState.dashboards.filter(function(d){ return d.id !== id; });
  if (AppState.activeId === id) {
    AppState.activeId = AppState.dashboards.length ? AppState.dashboards[0].id : null;
  }
}

/* ── Suggestions API (с сервера) ─────────────────── */
async function loadSuggestionsFromServer(){
  var sess = getSession();
  if (!sess) return { types: [], fields: [] };
  try {
    var r = await fetch(API + '/suggestions?src=' + encodeURIComponent(sess.src), { headers: authHeaders() });
    if (!r.ok) return { types: [], fields: [] };
    var data = await r.json();
    AppState.suggestions = {
      types: data.types || [],
      fields: data.fields || []
    };
    return AppState.suggestions;
  } catch(_) {
    return { types: [], fields: [] };
  }
}

/* ── Active dashboard helpers ────────────────────── */
function getActiveDashboard(){
  if (!AppState.activeId) return null;
  var db = AppState.dashboards.find(function(d){ return d.id === AppState.activeId; });
  if (db && !Array.isArray(db.panels)) db.panels = [];
  return db || null;
}
function setActiveId(id){
  AppState.activeId = id;
  // Обновляем URL без перезагрузки
  try {
    var newHash = '#dashboard?id=' + encodeURIComponent(id);
    if (location.hash !== newHash) {
      history.replaceState(null, '', newHash);
    }
  } catch(_){}
}

/* ── Layout mode (always canvas now) ────────────── */
function getLayoutMode(){ return true; }
function setLayoutMode(mode){ /* no-op: always canvas */ }

/* ── Toast ───────────────────────────────────────── */
function toast(msg){
  var el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.remove('show'); }, 2400);
}

/* ── Confirm modal ───────────────────────────────── */
function confirmModal(title, message, dangerText){
  return new Promise(function(resolve){
    var modal = $('#confirmModal');
    $('#confirmTitle').textContent = title;
    $('#confirmMessage').textContent = message;
    $('#confirmOk').textContent = dangerText || 'Подтвердить';
    function cleanup(){ modal.classList.remove('active'); $('#confirmOk').onclick = null; $('#confirmCancel').onclick = null; }
    $('#confirmOk').onclick = function(){ cleanup(); resolve(true); };
    $('#confirmCancel').onclick = function(){ cleanup(); resolve(false); };
    modal.classList.add('active');
    setTimeout(function(){ $('#confirmOk').focus(); }, 50);
  });
}

/* ── Input modal ─────────────────────────────────── */
function inputModal(title, placeholder, defaultValue){
  return new Promise(function(resolve){
    var modal = $('#inputModal');
    $('#inputTitle').textContent = title;
    var field = $('#inputField');
    field.placeholder = placeholder || '';
    field.value = defaultValue || '';
    function cleanup(){ modal.classList.remove('active'); $('#inputOk').onclick = null; $('#inputCancel').onclick = null; field.onkeydown = null; }
    $('#inputOk').onclick = function(){ var v = field.value.trim(); cleanup(); resolve(v || null); };
    $('#inputCancel').onclick = function(){ cleanup(); resolve(null); };
    field.onkeydown = function(e){
      if(e.key==='Enter'){ var v = field.value.trim(); cleanup(); resolve(v || null); }
      if(e.key==='Escape'){ cleanup(); resolve(null); }
    };
    modal.classList.add('active');
    setTimeout(function(){ field.focus(); }, 80);
  });
}

/* ── escapeHtml ──────────────────────────────────── */
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; });
}

/* ── formatNum ───────────────────────────────────── */
function formatNum(n, formatType){
  if(n===null||n===undefined) return '—';
  var num = Number(n);
  if(isNaN(num)) return '—';
  var fmt = formatType || 'number';
  if(fmt === 'money'){
    var abs = Math.abs(num);
    if(abs >= 1e9) return (num/1e9).toFixed(2)+'B';
    if(abs >= 1e6) return (num/1e6).toFixed(2)+'M';
    if(abs >= 1e3) return (num/1e3).toFixed(1)+'K';
    return Number.isInteger(num) ? String(num) : num.toFixed(2);
  }
  if(fmt === 'percent'){
    return num.toFixed(1)+'%';
  }
  if(fmt === 'ms'){
    if(num >= 1000) return (num/1000).toFixed(2)+'s';
    return Number.isInteger(num) ? num+'ms' : num.toFixed(0)+'ms';
  }
  // number (default)
  if(Math.abs(num) >= 1000) return num.toLocaleString('ru-RU', {maximumFractionDigits:1});
  return Number.isInteger(num) ? String(num) : num.toFixed(2);
}

/* ── describeMeta ────────────────────────────────── */
function describeMeta(p){
  var esc = escapeHtml;
  var parts = [];
  parts.push(p.type ? 'type:'+esc(p.type) : 'все типы');
  if(p.group === '__field') parts.push('поле:'+(p.field ? esc(p.field) : '—'));
  else if(p.group) parts.push('группа:'+({'minute':'минуты','hour':'часы','day':'дни','week':'недели','month':'месяцы'}[p.group]||esc(p.group)));
  if(p.agg !== 'count') parts.push(esc(p.agg)+':'+(p.aggfield ? esc(p.aggfield) : '—'));
  if(p.stacked) parts.push('stacked');
  if(p.cumulative) parts.push('нараст.');
  if(p.compare) parts.push('сравнение');
  if(p.secondAxis) parts.push('2 оси Y');
  if(p.thresholds && p.thresholds.length) parts.push('пороги: '+p.thresholds.length);
  if(p.sort && p.sort !== 'key') parts.push('сортировка:'+(p.sort==='value_desc'?'↓':'↑'));
  if(p.limit && Number(p.limit) > 0) parts.push('топ-'+Number(p.limit));
  if(Array.isArray(p.filters) && p.filters.length){
    p.filters.forEach(function(f){
      var fval = Array.isArray(f.value) ? f.value.join(',') : String(f.value);
      if(fval.length > 20) fval = fval.slice(0,18)+'…';
      parts.push(esc(f.field)+({'eq':'=','neq':'≠','gt':'>','lt':'<','in':'∈','contains':'~'}[f.op]||esc(f.op))+esc(fval));
    });
  }
  if(p.breakdownfield) parts.push('разбивка:'+esc(p.breakdownfield));
  parts.push(({'24h':'24ч','7d':'7д','30d':'30д','all':'всё время','custom':'выбран'})[p.range] || esc(p.range));
  if(p.unit) parts.push('ед.:'+esc(p.unit));
  // Tension — только если задан и не дефолт (0.35)
  if(typeof p.tension === 'number' && p.viz === 'line' && Math.abs(p.tension - 0.35) > 0.01){
    parts.push('tension:'+p.tension.toFixed(2));
  }
  return parts.map(function(s){ return '<span class="meta-tag">'+s+'</span>'; }).join('');
}

/* ── formatCompact — авто-сокращение больших чисел ── */
function formatCompact(n){
  if(n===null||n===undefined) return '—';
  var num = Number(n);
  if(isNaN(num)) return '—';
  var abs = Math.abs(num);
  if(abs >= 1e12) return (num/1e12).toFixed(1)+'T';
  if(abs >= 1e9)  return (num/1e9).toFixed(1)+'B';
  if(abs >= 1e6)  return (num/1e6).toFixed(1)+'M';
  if(abs >= 1e3)  return (num/1e3).toFixed(1)+'K';
  return Number.isInteger(num) ? String(num) : num.toFixed(1);
}

/* ── panelKey ────────────────────────────────────── */
function panelKey(p){
  if(p.group==='__field') return p.field || 'bucket';
  return p.group || 'bucket';
}

/* ── Sanitize panel: strip runtime properties ────── */
// Во время рендеринга на объекты панелей «налипают» тяжёлые runtime-данные:
// _logsEvents (до 100 событий), _tableData (до 200 строк), _tableSort, _tableSearch, _currentPage.
// Если отправить их на сервер — JSON-пейлоад раздувается и превышает лимит body на сервере,
// что приводит к 502. Функция вырезает всё, что не нужно хранить.
function sanitizePanelForSave(p){
  if(!p || typeof p !== 'object') return p;
  var clean = {};
  var keepKeys = [
    'id','title','viz','type','group','field','agg','aggfield',
    'range','from','to','width','height','autorefresh',
    'sort','limit','key','unit','color','lineStyle','tension','formatType',
    'filters','breakdownfield',
    'cx','cy','cw','ch','cz','locked',
    'thresholds','stacked','cumulative','secondAxis','compare',
    'gaugeMin','gaugeMax','formula','derived'
  ];
  for(var i=0;i<keepKeys.length;i++){
    var k = keepKeys[i];
    if(p[k] !== undefined) clean[k] = p[k];
  }
  return clean;
}

/* ── Public API: loadSharedDashboard ─────────────── */
async function loadSharedDashboard(shareId){
  var r = await fetch(API + '/public/' + encodeURIComponent(shareId));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
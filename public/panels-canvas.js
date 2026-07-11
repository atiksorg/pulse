/* ═══════════════════════════════════════════════════
   panels-canvas.js — canvas layout, drag, resize, DnD
   Вынесен из dashboard.js при разбиении на модули.
   ═══════════════════════════════════════════════════ */

/* ── Canvas state (живёт в одном месте — panels-canvas.js) ─── */
var interactiveCanvas = null;

/* ── Viz size presets for canvas layout ──────────── */
var CANVAS_VIZ_PRESETS = {
  line:  { cw: 380, ch: 280 },
  bar:   { cw: 380, ch: 280 },
  pie:   { cw: 340, ch: 300 },
  kpi:   { cw: 300, ch: 200 },
  table: { cw: 480, ch: 420 },
  logs:  { cw: 520, ch: 480 }
};

function getVizPreset(viz){
  return CANVAS_VIZ_PRESETS[viz] || CANVAS_VIZ_PRESETS.line;
}

/* ── Canvas mode ─────────────────────────────────── */
function resetCanvasView(silent){
  if(interactiveCanvas){
    interactiveCanvas.fitToContent();
    if(!silent) toast('Холст выровнен');
  }
}

/* ── Center viewport on a specific panel ─────────── */
function centerPanelInViewport(p){
  if(!interactiveCanvas || !p) return;
  var vp = interactiveCanvas.viewport;
  if(!vp) return;
  var vpRect = vp.getBoundingClientRect();
  var panelW = p.cw || 380;
  var panelH = p.ch || 280;
  // Центр панели в canvas-координатах
  var panelCenterX = (p.cx || 0) + panelW / 2;
  var panelCenterY = (p.cy || 0) + panelH / 2;
  // Смещение, чтобы центр панели оказался в центре viewport
  var newOffsetX = vpRect.width / 2 - panelCenterX * interactiveCanvas.scale;
  var newOffsetY = vpRect.height / 2 - panelCenterY * interactiveCanvas.scale;
  // Плавная анимация через transition на surface
  var surface = interactiveCanvas.surface;
  if(surface){
    surface.style.transition = 'transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
    interactiveCanvas.offsetX = newOffsetX;
    interactiveCanvas.offsetY = newOffsetY;
    surface.style.transform = 'translate(' + newOffsetX + 'px,' + newOffsetY + 'px) scale(' + interactiveCanvas.scale + ')';
    setTimeout(function(){
      surface.style.transition = '';
    }, 450);
  }
}
function arrangeAndFitCanvas(){
  var db = getActiveDashboard();
  if(!db || !Array.isArray(db.panels) || !db.panels.length){ toast('Нет панелей для выравнивания'); return; }
  autoLayoutCanvas(db.panels);
  updateDashboardOnServer(db).catch(function(){});
  renderPanels();
  setTimeout(function(){ resetCanvasView(true); }, 500);
  toast('Графики выстроены');
}
function autoLayoutCanvas(panels){
  var x=20,y=20,gap=16,mw=($('#panelGrid').clientWidth||1100)-40;

  // ── Сначала определяем нижнюю границу закреплённых блоков,
  //    чтобы свободные блоки не наезжали на них ──
  var maxYLocked = 0;
  panels.forEach(function(p){
    if(p.locked){
      var pr = getVizPreset(p.viz);
      var ch = p.ch || pr.ch;
      var bottom = (p.cy||0) + ch;
      if(bottom > maxYLocked) maxYLocked = bottom;
    }
  });
  // Если есть закреплённые блоки — начинаем ниже них с отступом
  if(maxYLocked > 0){
    y = maxYLocked + gap;
  }

  panels.forEach(function(p){
    if(p.locked) return;   // закреплённые не трогаем
    var pr = getVizPreset(p.viz);
    var cw = pr.cw;
    var rh = pr.ch;
    p.cx=x;p.cy=y;p.cw=cw;p.ch=rh;
    x+=cw+gap;
    if(x+cw>mw){x=20;y+=rh+gap;}
  });
}
function applyCanvasPosition(card,p){
  var pr = getVizPreset(p.viz);
  card.style.left=(p.cx||20)+'px';
  card.style.top=(p.cy||20)+'px';
  card.style.width=(p.cw||pr.cw)+'px';
  card.style.height=(p.ch||pr.ch)+'px';
  card.style.zIndex=Math.min(Math.max(p.cz || CANVAS_Z_MIN, CANVAS_Z_MIN), CANVAS_Z_MAX);
}

/* ── Dead zone threshold (px) — prevents accidental drags ── */
var DRAG_DEAD_ZONE = 5;

function initCanvasDrag(card,p){
  var head = card.querySelector('.panel-head');
  head.style.cursor = p.locked ? 'default' : 'grab';
  head.addEventListener('pointerdown', function(e){
    if(p.locked) return;       // runtime check — respects lock state
    if(e.button !== 0) return;
    e.preventDefault();
    try { head.setPointerCapture(e.pointerId); } catch(_){}
    var scale = interactiveCanvas ? interactiveCanvas.scale : 1;
    canvasDragState = {
      card:card, p:p,
      startX:e.clientX, startY:e.clientY,
      origX:p.cx||0, origY:p.cy||0,
      scale:scale, pointerId:e.pointerId,
      _started:false, _cancelled:false,
      _origCx:p.cx||0, _origCy:p.cy||0
    };
  });
}

function initCanvasResize(card,p){
  var h = document.createElement('div');
  h.className = 'canvas-resize-handle';
  card.appendChild(h);
  h.style.touchAction = 'none';
  h.addEventListener('pointerdown', function(e){
    if(p.locked) return;       // runtime check — respects lock state
    e.stopPropagation(); e.preventDefault();
    try { h.setPointerCapture(e.pointerId); } catch(_){}
    var scale = interactiveCanvas ? interactiveCanvas.scale : 1;
    canvasResizeState = {
      card:card, p:p,
      startX:e.clientX, startY:e.clientY,
      origW:p.cw||380, origH:p.ch||280,
      scale:scale, pointerId:e.pointerId,
      _started:false
    };
  });
}

/* ── Canvas global drag/resize state (single document listener) ── */
var canvasDragState = null;   // { card, p, startX, startY, origX, origY }
var canvasResizeState = null; // { card, p, startX, startY, origW, origH }
var _canvasGlobalHandlersBound = false;

function _bindCanvasGlobalHandlers(){
  if (_canvasGlobalHandlersBound) return;
  _canvasGlobalHandlersBound = true;

  /* ── Pointer move: drag with dead zone ──────────── */
  document.addEventListener('pointermove', function(e){
    if (canvasDragState) {
      var d = canvasDragState;
      if (d._cancelled) return;
      var dx = e.clientX - d.startX;
      var dy = e.clientY - d.startY;
      if (!d._started) {
        if (Math.abs(dx) < DRAG_DEAD_ZONE && Math.abs(dy) < DRAG_DEAD_ZONE) return;
        d._started = true;
        d.card.classList.add('canvas-dragging');
        document.body.classList.add('canvas-dragging');
        canvasZCounter = canvasZCounter >= CANVAS_Z_MAX ? CANVAS_Z_MIN : canvasZCounter + 1;
        d.card.style.zIndex = canvasZCounter;
        d.p.cz = canvasZCounter;
      }
      var GRID_SIZE = 20, scale = d.scale || 1;
      d.p.cx = Math.round((d.origX + dx / scale) / GRID_SIZE) * GRID_SIZE;
      d.p.cy = Math.round((d.origY + dy / scale) / GRID_SIZE) * GRID_SIZE;
      d.card.style.left = d.p.cx + 'px';
      d.card.style.top  = d.p.cy + 'px';
    }
    if (canvasResizeState) {
      var r = canvasResizeState;
      var dx2 = e.clientX - r.startX, dy2 = e.clientY - r.startY;
      if (!r._started) {
        if (Math.abs(dx2) < DRAG_DEAD_ZONE && Math.abs(dy2) < DRAG_DEAD_ZONE) return;
        r._started = true;
      }
      var GRID_SIZE = 20, scale = r.scale || 1;
      r.p.cw = Math.max(200, Math.round((r.origW + dx2 / scale) / GRID_SIZE) * GRID_SIZE);
      r.p.ch = Math.max(150, Math.round((r.origH + dy2 / scale) / GRID_SIZE) * GRID_SIZE);
      r.card.style.width  = r.p.cw + 'px';
      r.card.style.height = r.p.ch + 'px';
      if (charts[r.p.id]) charts[r.p.id].resize();
    }
  });

  /* ── Unified end-drag / end-resize function ─────── */
  function endCanvasDrag(save){
    if (canvasDragState) {
      var d = canvasDragState;
      d.card.classList.remove('canvas-dragging');
      document.body.classList.remove('canvas-dragging');
      if (save && d._started && !d._cancelled) {
        var db = getActiveDashboard();
        if (db) {
          var pp = db.panels.find(function(x){ return x.id === d.p.id; });
          if (pp) { pp.cx = d.p.cx; pp.cy = d.p.cy; pp.cz = d.p.cz; }
          updateDashboardOnServer(db).catch(function(){});
        }
      } else {
        d.p.cx = d._origCx; d.p.cy = d._origCy;
        d.card.style.left = d.p.cx + 'px';
        d.card.style.top  = d.p.cy + 'px';
      }
      canvasDragState = null;
    }
    if (canvasResizeState) {
      var r = canvasResizeState;
      document.body.classList.remove('canvas-dragging');
      if (save && r._started) {
        var db2 = getActiveDashboard();
        if (db2) {
          var pp2 = db2.panels.find(function(x){ return x.id === r.p.id; });
          if (pp2) { pp2.cw = r.p.cw; pp2.ch = r.p.ch; }
          updateDashboardOnServer(db2).catch(function(){});
        }
      }
      canvasResizeState = null;
    }
  }
  window._endCanvasDrag = endCanvasDrag;

  document.addEventListener('pointerup', function(){ endCanvasDrag(true); });
  document.addEventListener('pointercancel', function(){ endCanvasDrag(false); });
  window.addEventListener('blur', function(){ endCanvasDrag(false); });
  document.addEventListener('visibilitychange', function(){ if (document.hidden) endCanvasDrag(false); });
  document.addEventListener('mouseleave', function(e){
    if (canvasDragState && canvasDragState._started && e.buttons === 0) endCanvasDrag(true);
  });
  document.addEventListener('keydown', function(e){
    if ((e.key === 'Escape' || e.code === 'Escape') && (canvasDragState || canvasResizeState)) {
      endCanvasDrag(false);
      e.preventDefault();
    }
  });
}
_bindCanvasGlobalHandlers();

/* ── Drag & Drop (grid mode) ─────────────────────── */
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

/* ── Close all panel dropdowns on outside click ──── */
document.addEventListener('click', function(e){
  if(!e.target.closest('.panel-menu-wrap')){
    document.querySelectorAll('.panel-menu-dropdown.show').forEach(function(d){ d.classList.remove('show'); });
  }
});

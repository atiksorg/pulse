/* ═══════════════════════════════════════════════════
   panels-canvas.js — canvas layout, drag, resize, DnD
   Вынесен из dashboard.js при разбиении на модули.
   ═══════════════════════════════════════════════════ */

/* ── Canvas state (живёт в одном месте — panels-canvas.js) ─── */
var interactiveCanvas = null;

/* ── Dropdown z-index tracking ──────────────────── */
var _activeDropdownCard = null;
var _activeDropdownPanel = null;
var _activeDropdownOrigZ = null;

function _saveDropdownZIndex(card, p){
  _activeDropdownCard = card;
  _activeDropdownPanel = p;
  _activeDropdownOrigZ = (typeof p.cz === 'number') ? p.cz : CANVAS_Z_MIN;
}

function _restoreDropdownZIndex(){
  if(_activeDropdownCard && _activeDropdownPanel){
    _activeDropdownCard.style.zIndex = Math.min(Math.max(_activeDropdownOrigZ, CANVAS_Z_MIN), CANVAS_Z_MAX);
    _activeDropdownPanel.cz = _activeDropdownOrigZ;
  }
  _activeDropdownCard = null;
  _activeDropdownPanel = null;
  _activeDropdownOrigZ = null;
}

/* ── Viz size presets for canvas layout ──────────── */
var CANVAS_VIZ_PRESETS = {
  line:  { cw: 380, ch: 280 },
  bar:   { cw: 380, ch: 280 },
  pie:   { cw: 340, ch: 300 },
  kpi:   { cw: 300, ch: 200 },
  gauge: { cw: 280, ch: 200 },
  heatmap: { cw: 500, ch: 350 },
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
  // Undo snapshot ПЕРЕД мутацией
  if (typeof pushUndoSnapshot === 'function') pushUndoSnapshot('авто-раскладка');
  autoLayoutCanvas(db.panels);
  updateDashboardOnServer(db).catch(function(){});
  _saveCanvasViewport();
  renderPanels();
  // resetCanvasView НЕ вызываем — сохраняем текущий viewport
  toast('Графики выстроены');
}

/* ── Smooth layout animation: плавное перемещение карточек ── */
function applyLayoutTransitions(cards, panels, duration){
  if(!cards || !panels) return;
  duration = duration || 400;
  cards.forEach(function(card, i){
    var p = panels[i];
    if(!card || !p) return;
    card.style.transition = 'left ' + duration + 'ms cubic-bezier(0.25,0.46,0.45,0.94),'
      + 'top ' + duration + 'ms cubic-bezier(0.25,0.46,0.45,0.94),'
      + 'width ' + duration + 'ms cubic-bezier(0.25,0.46,0.45,0.94),'
      + 'height ' + duration + 'ms cubic-bezier(0.25,0.46,0.45,0.94)';
  });
}
function removeLayoutTransitions(cards){
  if(!cards) return;
  cards.forEach(function(card){
    if(card) card.style.transition = '';
  });
}

/* ── Auto-layout v2: адаптивная сетка с коллизиями ──
 *  • Адаптивное число колонок по ширине экрана
 *  • Учёт заблокированных панелей (коллизии)
 *  • Умное растяжение последнего элемента в строке
 *  • Минимальные размеры для каждого типа
 * ─────────────────────────────────────────────────── */
function autoLayoutCanvas(panels){
  var gap = 16;
  var padX = 20;
  // Используем viewportWidth если canvas создан, иначе clientWidth, иначе разумный дефолт
  var gridEl = $('#panelGrid');
  var mw = 1100;
  if(interactiveCanvas && interactiveCanvas.viewport){
    mw = interactiveCanvas.viewport.clientWidth || 1100;
  } else if(gridEl) {
    mw = gridEl.clientWidth || 1100;
  }
  mw = Math.max(mw - padX * 2, 400);

  // ── Минимальные / предпочтительные размеры ──
  var MIN_W = 220, MIN_H = 160;
  var SIZE_MAP = {
    kpi:     { prefW: 260, prefH: 180, minW: 200, minH: 150 },
    gauge:   { prefW: 260, prefH: 200, minW: 200, minH: 160 },
    line:    { prefW: 380, prefH: 280, minW: 260, minH: 200 },
    bar:     { prefW: 380, prefH: 280, minW: 260, minH: 200 },
    pie:     { prefW: 320, prefH: 280, minW: 240, minH: 220 },
    heatmap: { prefW: 480, prefH: 320, minW: 360, minH: 260 },
    table:   { prefW: mw,  prefH: 380, minW: 320, minH: 240 },
    logs:    { prefW: mw,  prefH: 420, minW: 320, minH: 280 }
  };

  function getSize(viz){
    return SIZE_MAP[viz] || SIZE_MAP.line;
  }

  // ── Разделяем на locked и free ──
  var locked = panels.filter(function(p){ return !!p.locked; });
  var free   = panels.filter(function(p){ return !p.locked; });

  // ── Заполняем cw/ch если не заданы ──
  panels.forEach(function(p){
    var sz = getSize(p.viz);
    if(!p.cw || p.cw < sz.minW) p.cw = sz.prefW;
    if(!p.ch || p.ch < sz.minH) p.ch = sz.prefH;
    if(p.cw < sz.minW) p.cw = sz.minW;
    if(p.ch < sz.minH) p.ch = sz.minH;
  });

  // ── Категории свободных панелей ──
  var kpis = [], charts = [], fulls = [];
  free.forEach(function(p){
    var v = p.viz;
    if(v === 'kpi' || v === 'gauge') kpis.push(p);
    else if(v === 'table' || v === 'logs') fulls.push(p);
    else charts.push(p);
  });

  // ── Bounding box для коллизий с locked ──
  function getLockedRects(){
    return locked.map(function(p){
      return { x: p.cx||0, y: p.cy||0, w: p.cw||300, h: p.ch||200 };
    });
  }

  function collidesWithAny(rx, ry, rw, rh, rects){
    for(var i=0; i<rects.length; i++){
      var r = rects[i];
      if(rx < r.x + r.w && rx + rw > r.x && ry < r.y + r.h && ry + rh > r.y){
        return true;
      }
    }
    return false;
  }

  // Найти Y ниже всех locked-панелей в данном X-диапазоне
  function findClearY(x, w, rects, startY){
    var y = startY;
    // Итеративно проверяем коллизии и сдвигаем вниз
    for(var iter=0; iter<20; iter++){
      var blocked = false;
      for(var i=0; i<rects.length; i++){
        var r = rects[i];
        // Проверяем горизонтальное пересечение
        if(x < r.x + r.w && x + w > r.x){
          if(y < r.y + r.h && y + 200 > r.y){
            y = r.y + r.h + gap;
            blocked = true;
            break;
          }
        }
      }
      if(!blocked) break;
    }
    return y;
  }

  // ── Адаптивные колонки ──
  function calcCols(items, preferredCols, cellW){
    if(!items.length) return preferredCols;
    var maxW = mw;
    // Пробуем от preferredCols до 1
    for(var cols = preferredCols; cols >= 1; cols--){
      var rowWidth = cols * cellW + (cols - 1) * gap;
      if(rowWidth <= maxW + 20) return cols;  // +20 — допуск на растяжение
    }
    return 1;
  }

  // ── Умная расстановка строк ──
  var curY = padX;  // начинаем сверху с отступом
  var lockedRects = getLockedRects();

  // 1) KPI / Gauge
  if(kpis.length){
    var kpiCells = kpis.map(function(p){
      var sz = getSize(p.viz);
      return { w: Math.min(sz.prefW, mw), h: sz.prefH };
    });
    var kpiAvgW = kpiCells.reduce(function(s,c){ return s+c.w; }, 0) / kpiCells.length;
    var kpiCols = calcCols(kpis, 4, kpiAvgW);
    var kpiCellW = Math.floor((mw - (kpiCols-1)*gap) / kpiCols);

    var rowIdx = 0;
    kpis.forEach(function(p){
      var col = rowIdx % kpiCols;
      var row = Math.floor(rowIdx / kpiCols);
      var x = padX + col * (kpiCellW + gap);
      var y = curY + row * (p.ch + gap);
      y = findClearY(x, kpiCellW, lockedRects, y);
      p.cx = x;
      p.cy = y;
      p.cw = kpiCellW;
      rowIdx++;
    });
    // Вычисляем высоту занятую KPI
    var kpiRows = Math.ceil(kpis.length / kpiCols);
    var lastKpiH = kpis.length ? kpis[kpis.length-1].ch : 0;
    curY += kpiRows * (lastKpiH + gap);
  }

  // 2) Charts (line, bar, pie, heatmap)
  if(charts.length){
    var chartCells = charts.map(function(p){
      var sz = getSize(p.viz);
      return { w: Math.min(sz.prefW, mw), h: sz.prefH };
    });
    var chartAvgW = chartCells.reduce(function(s,c){ return s+c.w; }, 0) / chartCells.length;
    var chartCols = calcCols(charts, 3, chartAvgW);
    var chartCellW = Math.floor((mw - (chartCols-1)*gap) / chartCols);

    // Разбиваем на строки и растягиваем последний элемент
    var rowStart = 0;
    while(rowStart < charts.length){
      var rowEnd = Math.min(rowStart + chartCols, charts.length);
      var rowItems = charts.slice(rowStart, rowEnd);

      // Определяем максимальную высоту в строке
      var maxRowH = 0;
      rowItems.forEach(function(p){ if(p.ch > maxRowH) maxRowH = p.ch; });

      // Вычисляем X для каждого элемента
      var xCursor = padX;
      rowItems.forEach(function(p, idx){
        // Растягиваем последний элемент если он один в строке или есть место
        var cellW = chartCellW;
        if(idx === rowItems.length - 1 && rowItems.length < chartCols){
          // Последний элемент в неполной строке — растягиваем
          cellW = mw - xCursor + padX;
          cellW = Math.max(cellW, p.cw);
        }

        var y = findClearY(xCursor, cellW, lockedRects, curY);
        p.cx = xCursor;
        p.cy = y;
        p.cw = cellW;
        p.ch = maxRowH;  // выравниваем высоту в строке
        xCursor += cellW + gap;
      });

      curY += maxRowH + gap;
      rowStart = rowEnd;
    }
  }

  // 3) Table / Logs — на всю ширину, каждый на отдельной полосе
  fulls.forEach(function(p){
    var pr = getVizPreset(p.viz);
    var y = findClearY(padX, mw, lockedRects, curY);
    p.cx = padX;
    p.cy = y;
    p.cw = mw;
    p.ch = p.ch || pr.ch;
    curY += p.ch + gap;
  });

  // ── Обновляем lockedRects после расстановки free ──
  // (не нужно — locked не двигаем, а free не перекрываем)
}

/* ── Find max cz among all panels in dashboard ───── */
function getMaxPanelZ(panels){
  var max = CANVAS_Z_MIN;
  if(!Array.isArray(panels)) return max;
  for(var i=0; i<panels.length; i++){
    var cz = panels[i].cz;
    if(typeof cz === 'number' && cz > max) max = cz;
  }
  return max;
}

/* ── Save / Restore canvas viewport (scale + offset) ── */
var _savedCanvasViewport = null;

function _saveCanvasViewport(){
  if(interactiveCanvas && !interactiveCanvas._destroyed){
    _savedCanvasViewport = {
      scale: interactiveCanvas.scale,
      offsetX: interactiveCanvas.offsetX,
      offsetY: interactiveCanvas.offsetY
    };
  }
}
function _restoreCanvasViewport(){
  if(_savedCanvasViewport && interactiveCanvas && !interactiveCanvas._destroyed){
    interactiveCanvas.setView(
      _savedCanvasViewport.scale,
      _savedCanvasViewport.offsetX,
      _savedCanvasViewport.offsetY
    );
    _savedCanvasViewport = null;
  }
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
        // Undo snapshot ПЕРЕД применением изменений
        if (typeof pushUndoSnapshot === 'function') pushUndoSnapshot('перемещение');
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
        // Undo snapshot ПЕРЕД применением изменений
        if (typeof pushUndoSnapshot === 'function') pushUndoSnapshot('размер');
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
    // Undo / Redo горячие клавиши
    // Не срабатываем если фокус в input/textarea/select
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    // Не срабатываем если открыта модалка
    if (document.querySelector('.overlay.active')) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.key === 'z' || e.key === 'Z') {
        if (e.shiftKey) {
          // Ctrl+Shift+Z = Redo
          if (typeof canvasRedo === 'function') canvasRedo();
          e.preventDefault();
        } else {
          // Ctrl+Z = Undo
          if (typeof canvasUndo === 'function') canvasUndo();
          e.preventDefault();
        }
      } else if (e.key === 'y' || e.key === 'Y') {
        // Ctrl+Y = Redo
        if (typeof canvasRedo === 'function') canvasRedo();
        e.preventDefault();
      }
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
  // Undo snapshot ПЕРЕД перестановкой
  if (typeof pushUndoSnapshot === 'function') pushUndoSnapshot('перестановка');
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
    _restoreDropdownZIndex();
  }
});

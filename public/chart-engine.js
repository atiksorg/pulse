/* ═══════════════════════════════════════════════════
   chart-engine.js — Полный графический движок Pulse
   Объединяет:
   • chart-plugins.js   — Chart.js плагины (пороги, нараст.итог, сравнение)
   • chart-gauge.js      — Gauge визуализация (чистый canvas)
   • chart-heatmap.js    — Heatmap визуализация (HTML таблица)
   • panels-canvas.js    — Canvas layout, drag, resize, DnD
   • panels-render.js    — Рендеринг панелей: viz, logs, table
   ═══════════════════════════════════════════════════ */

/* ── Depends on: core.js, interactive-canvas.js, themes.js, Chart.js ── */

/* ═══════════════════════════════════════════════════════════════════════
   РАЗДЕЛ 1: CHART.JS PLUGINS (из chart-plugins.js)
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Threshold Plugin ──────────────────────────────
 * Рисует горизонтальные пунктирные линии на графике.
 * Настройки в dataset._thresholds: [{ value, label, color }]
 */
var thresholdPlugin = {
  id: 'thresholdLines',
  afterDraw: function(chart) {
    var opts = chart.options.plugins && chart.options.plugins.thresholdLines;
    if (!opts || !opts.lines || !opts.lines.length) return;
    var yAxis = chart.scales.y;
    if (!yAxis) return;
    var ctx = chart.ctx;
    // save/restore раньше вызывались на КАЖДУЮ линию; при множестве
    // threshold-линий это лишние push/pop состояния канваса на каждый
    // afterDraw (а он дёргается на каждый repaint/hover). Один save/restore
    // на весь блок дешевле и даёт тот же результат.
    ctx.save();
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    opts.lines.forEach(function(line) {
      var y = yAxis.getPixelForValue(line.value);
      if (y < yAxis.top || y > yAxis.bottom) return;
      var color = line.color || '#FF6B6B';
      ctx.beginPath();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.moveTo(chart.chartArea.left, y);
      ctx.lineTo(chart.chartArea.right, y);
      ctx.stroke();
      if (line.label) {
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.fillText(line.label, chart.chartArea.left + 4, y - 3);
      }
    });
    ctx.restore();
  }
};

/* ── Register threshold plugin ──────────────────── */
if (typeof Chart !== 'undefined') {
  Chart.register(thresholdPlugin);

  /* Отключаем анимации Chart.js по умолчанию.
   * ПОЧЕМУ ЭТО ГЛАВНЫЙ ИСТОЧНИК ФОНОВОЙ НАГРУЗКИ:
   * renderViz() на каждое автообновление (см. autorefresh, setInterval)
   * делает chart.destroy() + new Chart(...) — то есть график создаётся
   * "с нуля" и проигрывает entry-анимацию (~1000ms по умолчанию).
   * Анимация в Chart.js — это requestAnimationFrame-цикл на 60 кадров/сек,
   * который на каждый кадр делает полный layout+redraw канваса.
   * При нескольких панелях с autorefresh (а джиттер в setInterval их не
   * синхронизирует, а размазывает по времени) получается ПОЧТИ
   * непрерывный поток таких анимационных циклов — отсюда стабильные
   * несколько % CPU даже когда пользователь ничего не делает.
   * Для дашборда с автообновлением entry-анимация не несёт пользы —
   * данные просто "должны появиться", а не эффектно наехать. */
  Chart.defaults.animation = false;
  Chart.defaults.animations = false;
  Chart.defaults.transitions.active.animation.duration = 0; // hover тоже без анимации
}

/* ── Cumulative transform ─────────────────────────
 * Превращает обычные values[] в нарастающий итог.
 * Вызывается клиентом ПЕРЕД созданием Chart.
 */
function applyCumulative(values) {
  var result = [];
  var sum = 0;
  for (var i = 0; i < values.length; i++) {
    sum += (Number(values[i]) || 0);
    result.push(sum);
  }
  return result;
}

/* ── Compare period: compute shifted date range ────
 * Для сравнения периодов: возвращает { from, to } предыдущего периода.
 * Пример: 7 дней → предыдущие 7 дней перед текущим диапазоном.
 */
function computeCompareRange(range, p) {
  var now = new Date();
  var from, to, duration;
  if (range === '24h') {
    duration = 24 * 3600 * 1000;
    from = new Date(now.getTime() - duration);
    to = now;
  } else if (range === '7d') {
    duration = 7 * 86400 * 1000;
    from = new Date(now.getTime() - duration);
    to = now;
  } else if (range === '30d') {
    duration = 30 * 86400 * 1000;
    from = new Date(now.getTime() - duration);
    to = now;
  } else if (range === 'custom' && p && p.from && p.to) {
    from = new Date(p.from);
    to = new Date(p.to);
    duration = to.getTime() - from.getTime();
  } else {
    return null;
  }
  var prevTo = new Date(from.getTime() - 1);
  var prevFrom = new Date(prevTo.getTime() - duration);
  return {
    from: prevFrom.toISOString(),
    to: prevTo.toISOString()
  };
}


/* ═══════════════════════════════════════════════════════════════════════
   РАЗДЕЛ 2: GAUGE VISUALIZATION (из chart-gauge.js)
   Чистый canvas, не зависит от Chart.js.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Рендерит gauge-индикатор в указанный контейнер.
 * @param {HTMLElement} container — DOM-элемент для gauge
 * @param {Object} opts
 * @param {number} opts.value — текущее значение
 * @param {number} opts.min — минимальное значение (по умолчанию 0)
 * @param {number} opts.max — максимальное значение (по умолчанию 100)
 * @param {string} opts.unit — единица измерения
 * @param {string} opts.color — основной цвет
 * @param {string} opts.title — подпись под значением
 * @param {Array}  opts.thresholds — [{ value, color, label }] зоны
 */
function renderGauge(container, opts) {
  var value = Number(opts.value) || 0;
  var min = opts.min !== undefined ? Number(opts.min) : 0;
  var max = opts.max !== undefined ? Number(opts.max) : 100;
  var unit = opts.unit || '';
  var color = opts.color || '#4DECC7';
  var title = opts.title || '';
  var thresholds = opts.thresholds || [];
  var fmtType = opts.formatType || 'number';

  // Clamp value
  var clamped = Math.max(min, Math.min(max, value));
  var pct = max > min ? (clamped - min) / (max - min) : 0;

  // Determine zone color from thresholds
  var zoneColor = color;
  if (thresholds.length) {
    var sorted = thresholds.slice().sort(function(a, b) { return a.value - b.value; });
    for (var i = 0; i < sorted.length; i++) {
      if (clamped >= sorted[i].value) zoneColor = sorted[i].color || zoneColor;
    }
  }

  // Canvas: переиспользуем существующий, если он уже есть в контейнере —
  // раньше при каждом обновлении gauge (например, по таймеру поллинга)
  // canvas пересоздавался с нуля, теряя контекст и создавая мусор для GC.
  var w = container.clientWidth || 280;
  var h = container.clientHeight || 200;
  var dpr = window.devicePixelRatio || 1;

  var canvas = container.querySelector('canvas.gauge-canvas');
  var isNew = !canvas;
  if (isNew) {
    canvas = document.createElement('canvas');
    canvas.className = 'gauge-canvas';
    container.innerHTML = '';
    container.appendChild(canvas);
  }
  var targetW = w * dpr, targetH = h * dpr;
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }

  var ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); // сброс перед повторным scale, иначе накопится
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(dpr, dpr);

  var cx = w / 2;
  var cy = h * 0.58;
  var radius = Math.min(w, h) * 0.38;
  var lineW = Math.max(10, radius * 0.2);
  var startAngle = Math.PI * 0.8;  // ~144°
  var endAngle = Math.PI * 2.2;    // ~396°
  var totalAngle = endAngle - startAngle;

  // Background arc
  ctx.beginPath();
  ctx.arc(cx, cy, radius, startAngle, endAngle);
  ctx.strokeStyle = zoneColor + '20';
  ctx.lineWidth = lineW;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Value arc
  var valueAngle = startAngle + totalAngle * pct;
  if (pct > 0.001) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, valueAngle);
    var grad = ctx.createLinearGradient(cx - radius, cy, cx + radius, cy);
    grad.addColorStop(0, zoneColor + '80');
    grad.addColorStop(1, zoneColor);
    ctx.strokeStyle = grad;
    ctx.lineWidth = lineW;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // Glow effect
  ctx.beginPath();
  ctx.arc(cx, cy, radius, Math.max(startAngle, valueAngle - 0.1), valueAngle);
  ctx.strokeStyle = zoneColor + '40';
  ctx.lineWidth = lineW + 6;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Threshold markers
  for (var i = 0; i < thresholds.length; i++) {
    var t = thresholds[i];
    var tPct = max > min ? (t.value - min) / (max - min) : 0;
    tPct = Math.max(0, Math.min(1, tPct));
    var tAngle = startAngle + totalAngle * tPct;
    var ix = cx + Math.cos(tAngle) * (radius - lineW / 2 - 4);
    var iy = cy + Math.sin(tAngle) * (radius - lineW / 2 - 4);
    var ox = cx + Math.cos(tAngle) * (radius + lineW / 2 + 4);
    var oy = cy + Math.sin(tAngle) * (radius + lineW / 2 + 4);
    ctx.beginPath();
    ctx.moveTo(ix, iy);
    ctx.lineTo(ox, oy);
    ctx.strokeStyle = t.color || '#FF6B6B';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Value text
  var displayVal = formatNum(value, fmtType);
  ctx.fillStyle = zoneColor;
  ctx.font = 'bold ' + Math.round(radius * 0.4) + 'px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayVal + (unit ? ' ' + unit : ''), cx, cy - 4);

  // Subtitle
  if (title) {
    ctx.fillStyle = '#7C8798';
    ctx.font = Math.round(radius * 0.15) + 'px JetBrains Mono, monospace';
    ctx.fillText(title, cx, cy + radius * 0.3);
  }

  // Min/Max labels
  ctx.fillStyle = '#4E5768';
  ctx.font = Math.round(radius * 0.13) + 'px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(formatNum(min, fmtType), cx - radius - lineW / 2, cy + radius * 0.55);
  ctx.textAlign = 'right';
  ctx.fillText(formatNum(max, fmtType), cx + radius + lineW / 2, cy + radius * 0.55);

  // Tooltip on hover
  canvas.title = displayVal + (unit ? ' ' + unit : '') + ' (range: ' + formatNum(min, fmtType) + ' – ' + formatNum(max, fmtType) + ')';
  canvas.style.cursor = 'pointer';
}


/* ═══════════════════════════════════════════════════════════════════════
   РАЗДЕЛ 3: HEATMAP VISUALIZATION (из chart-heatmap.js)
   Рисует тепловую карту: HTML таблица с цветовой интерполяцией.
   Зависит от: core.js (escapeHtml, formatNum, formatCompact)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Рендерит heatmap в указанный контейнер.
 * @param {HTMLElement} container — DOM-элемент
 * @param {Object} opts
 * @param {Array}  opts.series — [{ key, points: [{ bucket, value }] }]
 * @param {string} opts.color — базовый цвет (hsl)
 * @param {string} opts.title — заголовок
 * @param {string} opts.formatType — формат значений
 * @param {string} opts.unit — единица измерения
 */
function renderHeatmap(container, opts) {
  var series = opts.series || [];
  var baseColor = opts.color || '#4DECC7';
  var fmtType = opts.formatType || 'number';
  var unit = opts.unit || '';

  if (!series.length) {
    container.innerHTML = '<div style="color:var(--muted-2);font-family:var(--mono);font-size:12px;padding:20px;text-align:center;">нет данных для heatmap</div>';
    return;
  }

  // Собираем все buckets и считаем min/max
  var allBucketsSet = {};
  var allValues = [];
  series.forEach(function(s) {
    (s.points || []).forEach(function(pt) {
      allBucketsSet[String(pt.bucket)] = 1;
      allValues.push(Number(pt.value) || 0);
    });
  });
  var allBuckets = Object.keys(allBucketsSet).sort();
  var minVal = allValues.length ? Math.min.apply(null, allValues) : 0;
  var maxVal = allValues.length ? Math.max.apply(null, allValues) : 1;
  if (maxVal === minVal) maxVal = minVal + 1;

  // Парсим базовый цвет для генерации оттенков (кэшировано)
  var hsl = hexToHslCached(baseColor);
  var baseH = hsl[0], baseS = hsl[1], baseL = hsl[2];

  // Создаём HTML таблицу через массив + join вместо += конкатенации
  // (join() строит одну строку за раз; += в цикле на больших таблицах
  // многократно копирует всю строку заново — O(n²) вместо O(n))
  var parts = [];
  parts.push('<div class="heatmap-wrap"><div class="heatmap-scroll"><table class="heatmap-table">');

  // Header row (buckets)
  parts.push('<thead><tr><th class="heatmap-corner"></th>');
  var bucketLabels = new Array(allBuckets.length);
  for (var bi = 0; bi < allBuckets.length; bi++) {
    var label = allBuckets[bi];
    if (label.length === 10 && label[4] === '-') label = label.slice(5);
    else if (label.length === 13 && label[10] === ' ') label = label.slice(11);
    bucketLabels[bi] = label;
    parts.push('<th class="heatmap-th">', escapeHtml(label), '</th>');
  }
  parts.push('</tr></thead><tbody>');

  var valRange = maxVal - minVal;

  // Data rows — точечная карта строится один раз на серию (не на ячейку)
  series.forEach(function(s) {
    var pointMap = {};
    (s.points || []).forEach(function(pt) {
      pointMap[String(pt.bucket)] = Number(pt.value) || 0;
    });
    parts.push('<tr><td class="heatmap-label">', escapeHtml(String(s.key)), '</td>');
    for (var bj = 0; bj < allBuckets.length; bj++) {
      var b = allBuckets[bj];
      var v = pointMap[b] !== undefined ? pointMap[b] : 0;
      var pct = valRange ? (v - minVal) / valRange : 0;
      var cellL = 8 + pct * 35;
      var cellS = baseS + (1 - pct) * 10;
      var textColor = pct > 0.4 ? '#fff' : '#7C8798';
      var displayVal = formatNum(v, fmtType) + (unit ? ' ' + unit : '');
      parts.push(
        '<td class="heatmap-cell" style="background:hsl(', baseH, ',', cellS, '%,', cellL, '%);color:', textColor, ';" ',
        'title="', escapeHtml(String(s.key)), ' × ', escapeHtml(b), ': ', escapeHtml(displayVal), '">',
        (v !== 0 ? formatCompact(v) : ''), '</td>'
      );
    }
    parts.push('</tr>');
  });

  parts.push('</tbody></table></div>');

  // Legend
  parts.push(
    '<div class="heatmap-legend"><span class="heatmap-legend-label">', formatNum(minVal, fmtType), '</span>',
    '<div class="heatmap-legend-bar" style="background:linear-gradient(to right, hsl(', baseH, ',', baseS, '%,8%), hsl(', baseH, ',', baseS, '%,43%));"></div>',
    '<span class="heatmap-legend-label">', formatNum(maxVal, fmtType), '</span></div></div>'
  );

  container.innerHTML = parts.join('');

  var wrap = container.querySelector('.heatmap-wrap');
  if (wrap) {
    wrap.style.maxWidth = '100%';
    wrap.style.overflowX = 'auto';
  }
}

/* ── Color helpers ──────────────────────────────── */
/* Кэш hex→hsl: тема/базовый цвет обычно не меняется между рендерами,
 * поэтому повторный парсинг hex + матричная конвертация — лишняя работа. */
var _hslCache = {};
function hexToHslCached(hex) {
  if (_hslCache[hex]) return _hslCache[hex];
  var rgb = hexToRgb(hex);
  var hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  _hslCache[hex] = hsl;
  return hsl;
}
function hexToRgb(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}


/* ═══════════════════════════════════════════════════════════════════════
   РАЗДЕЛ 4: CANVAS LAYOUT (из panels-canvas.js)
   Canvas layout, drag, resize, DnD.
   Вынесен из dashboard.js при разбиении на модули.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Mobile detection helper (перенесён из panels-edit.js) ─── */
function isMobile(){ return window.innerWidth < 860; }

/* ── Canvas state (живёт в одном месте — chart-engine.js) ─── */
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
  var panelCenterX = (p.cx || 0) + panelW / 2;
  var panelCenterY = (p.cy || 0) + panelH / 2;
  var newOffsetX = vpRect.width / 2 - panelCenterX * interactiveCanvas.scale;
  var newOffsetY = vpRect.height / 2 - panelCenterY * interactiveCanvas.scale;
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
  _saveCanvasViewport();
  renderPanels();
  toast('Графики выстроены');
}

/* ── Smooth layout animation ────────────────────── */
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

/* ── Auto-layout v2: адаптивная сетка с коллизиями ── */
function autoLayoutCanvas(panels){
  var gap = 16;
  var padX = 20;
  var gridEl = $('#panelGrid');
  var mw = 1100;
  if(interactiveCanvas && interactiveCanvas.viewport){
    mw = interactiveCanvas.viewport.clientWidth || 1100;
  } else if(gridEl) {
    mw = gridEl.clientWidth || 1100;
  }
  mw = Math.max(mw - padX * 2, 400);

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

  var locked = panels.filter(function(p){ return !!p.locked; });
  var free   = panels.filter(function(p){ return !p.locked; });

  panels.forEach(function(p){
    var sz = getSize(p.viz);
    if(!p.cw || p.cw < sz.minW) p.cw = sz.prefW;
    if(!p.ch || p.ch < sz.minH) p.ch = sz.prefH;
    if(p.cw < sz.minW) p.cw = sz.minW;
    if(p.ch < sz.minH) p.ch = sz.minH;
  });

  var kpis = [], charts = [], fulls = [];
  free.forEach(function(p){
    var v = p.viz;
    if(v === 'kpi' || v === 'gauge') kpis.push(p);
    else if(v === 'table' || v === 'logs') fulls.push(p);
    else charts.push(p);
  });

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

  function findClearY(x, w, rects, startY){
    var y = startY;
    for(var iter=0; iter<20; iter++){
      var blocked = false;
      for(var i=0; i<rects.length; i++){
        var r = rects[i];
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

  function calcCols(items, preferredCols, cellW){
    if(!items.length) return preferredCols;
    var maxW = mw;
    for(var cols = preferredCols; cols >= 1; cols--){
      var rowWidth = cols * cellW + (cols - 1) * gap;
      if(rowWidth <= maxW + 20) return cols;
    }
    return 1;
  }

  var curY = padX;
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

    var rowStart = 0;
    while(rowStart < charts.length){
      var rowEnd = Math.min(rowStart + chartCols, charts.length);
      var rowItems = charts.slice(rowStart, rowEnd);

      var maxRowH = 0;
      rowItems.forEach(function(p){ if(p.ch > maxRowH) maxRowH = p.ch; });

      var xCursor = padX;
      rowItems.forEach(function(p, idx){
        var cellW = chartCellW;
        if(idx === rowItems.length - 1 && rowItems.length < chartCols){
          cellW = mw - xCursor + padX;
          cellW = Math.max(cellW, p.cw);
        }

        var y = findClearY(xCursor, cellW, lockedRects, curY);
        p.cx = xCursor;
        p.cy = y;
        p.cw = cellW;
        p.ch = maxRowH;
        xCursor += cellW + gap;
      });

      curY += maxRowH + gap;
      rowStart = rowEnd;
    }
  }

  // 3) Table / Logs — на всю ширину
  fulls.forEach(function(p){
    var pr = getVizPreset(p.viz);
    var y = findClearY(padX, mw, lockedRects, curY);
    p.cx = padX;
    p.cy = y;
    p.cw = mw;
    p.ch = p.ch || pr.ch;
    curY += p.ch + gap;
  });
}

/* ── Find max cz among all panels ────────────────── */
function getMaxPanelZ(panels){
  var max = CANVAS_Z_MIN;
  if(!Array.isArray(panels)) return max;
  for(var i=0; i<panels.length; i++){
    var cz = panels[i].cz;
    if(typeof cz === 'number' && cz > max) max = cz;
  }
  return max;
}

/* ── Save / Restore canvas viewport ──────────────── */
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

/* ── Dead zone threshold (px) ────────────────────── */
var DRAG_DEAD_ZONE = 5;

function initCanvasDrag(card,p){
  var head = card.querySelector('.panel-head');
  head.style.cursor = p.locked ? 'default' : 'grab';
  head.addEventListener('pointerdown', function(e){
    if(p.locked) return;
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
    if(p.locked) return;
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

/* ── Canvas global drag/resize state ─────────────── */
var canvasDragState = null;
var canvasResizeState = null;
var _canvasGlobalHandlersBound = false;

/* ── rAF-троттлинг дорогого chart.resize() во время resize-драга ───
 * Раньше resize() дёргался на КАЖДЫЙ pointermove (до сотен раз/сек).
 * Теперь — максимум раз за кадр, реальный layout Chart.js откладывается. */
var _pendingChartResizeId = null;
function _scheduleChartResize(chartId){
  _pendingChartResizeId = chartId;
  if (_scheduleChartResize._raf) return;
  _scheduleChartResize._raf = requestAnimationFrame(function(){
    _scheduleChartResize._raf = null;
    var id = _pendingChartResizeId;
    _pendingChartResizeId = null;
    if (id && charts[id]) charts[id].resize();
  });
}

function _bindCanvasGlobalHandlers(){
  if (_canvasGlobalHandlersBound) return;
  _canvasGlobalHandlersBound = true;

  // passive:true — обработчик не вызывает preventDefault(), поэтому браузер
  // может не ждать его завершения перед скроллом/композитингом кадра.
  // На высокочастотных pointermove (игровые мыши, трекпады) это заметно
  // снижает задержку и нагрузку на main thread.
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
      _scheduleChartResize(r.p.id);
    }
  }, { passive: true });

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
      if (charts[r.p.id]) charts[r.p.id].resize();
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
/* Раньше каждый клик по документу вызывал querySelectorAll по всему DOM
 * в поисках открытых dropdown'ов. Т.к. открыт максимум один dropdown
 * (см. menuTrigger.onclick ниже), храним прямую ссылку — O(1) вместо
 * полного обхода дерева на КАЖДЫЙ клик в приложении. */
var _openDropdownEl = null;
document.addEventListener('click', function(e){
  if(!e.target.closest('.panel-menu-wrap')){
    if(_openDropdownEl){ _openDropdownEl.classList.remove('show'); _openDropdownEl = null; }
    _restoreDropdownZIndex();
  }
});


/* ═══════════════════════════════════════════════════════════════════════
   РАЗДЕЛ 5: PANEL RENDERING (из panels-render.js)
   Рендеринг панелей: renderPanels, viz, logs, table.
   Зависит от: core.js, interactive-canvas.js, themes.js, chart-engine §1-4
   ═══════════════════════════════════════════════════════════════════════ */

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
      m.setMinutes(m.getMinutes()+5);
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
/* Автообновление панелей, чувствительное к видимости вкладки.
 * ПРОБЛЕМА: raw setInterval() продолжает тикать, даже когда вкладка
 * свёрнута/неактивна — каждый тик это сетевой запрос + полный
 * destroy/recreate графика, впустую сжигающие CPU и трафик, пока
 * пользователь дашборд не видит.
 * РЕШЕНИЕ: храним конфиг таймеров отдельно от самих интервалов;
 * на visibilitychange все интервалы останавливаются/перезапускаются.
 * При возврате на вкладку дополнительно делаем один "catch-up" рефреш,
 * чтобы данные не выглядели устаревшими после паузы. */
var _autorefreshConfigs = {}; // id -> { p, src, ms }
function _startAutorefresh(p, src, ms){
  _autorefreshConfigs[p.id] = { p: p, src: src, ms: ms };
  if (document.hidden) return; // не стартуем таймер, пока вкладка скрыта
  refreshTimers[p.id] = setInterval(function(){ loadPanel(p, src); }, ms + Math.floor(Math.random()*3000));
}
function _pauseAllAutorefresh(){
  Object.keys(refreshTimers).forEach(function(id){ clearInterval(refreshTimers[id]); });
  refreshTimers = {};
}
function _resumeAllAutorefresh(){
  Object.keys(_autorefreshConfigs).forEach(function(id){
    var cfg = _autorefreshConfigs[id];
    if (!cfg) return;
    refreshTimers[id] = setInterval(function(){ loadPanel(cfg.p, cfg.src); }, cfg.ms + Math.floor(Math.random()*3000));
    loadPanel(cfg.p, cfg.src); // один catch-up рефреш после возврата на вкладку
  });
}
if (typeof document !== 'undefined' && !_visibilityAutorefreshBound()) {
  document.addEventListener('visibilitychange', function(){
    if (document.hidden) _pauseAllAutorefresh();
    else _resumeAllAutorefresh();
  });
}
function _visibilityAutorefreshBound(){
  if (window._autorefreshVisibilityBound) return true;
  window._autorefreshVisibilityBound = true;
  return false;
}

function renderPanels(readonlyData){
  var grid = $('#panelGrid');
  grid.innerHTML = '';
  Object.values(refreshTimers).forEach(clearInterval);
  refreshTimers = {};
  _autorefreshConfigs = {};
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

  if(canvasMode){
    panels.forEach(function(p){
      var pr = getVizPreset(p.viz);
      if(!p.cw) p.cw = pr.cw;
      if(!p.ch) p.ch = pr.ch;
    });
  }

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
      { act:'alerts', icon:'bell', label:'Пороговые уведомления', hidden: isShared },
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
        sparkles: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5L12 2z"/><path d="M18 14l.75 2.25L21 17l-2.25.75L18 20l-.75-2.25L15 17l2.25-.75L18 14z"/><path d="M5 17l.5 1.5L7 19l-1.5.5L5 21l-.5-1.5L3 19l1.5-.5L5 17z"/></svg>',
        bell: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
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
      if(typeof bindPanelMenuActions === 'function'){
        bindPanelMenuActions(card, p, src);
      }
    }
    var menuTrigger = card.querySelector('[data-menu-trigger]');
    var menuDropdown = card.querySelector('.panel-menu-dropdown');
    if(menuTrigger && menuDropdown){
      menuTrigger.onclick = function(e){
        e.stopPropagation();
        var isOpen = menuDropdown.classList.contains('show');
        if(_openDropdownEl){ _openDropdownEl.classList.remove('show'); _openDropdownEl = null; }
        if(_activeDropdownCard && _activeDropdownCard !== card){
          _restoreDropdownZIndex();
        }
        if(!isOpen){
          menuDropdown.classList.add('show');
          _openDropdownEl = menuDropdown;
          if(canvasMode){
            _saveDropdownZIndex(card, p);
            card.style.zIndex = CANVAS_Z_MAX;
            p.cz = CANVAS_Z_MAX;
          }
        } else {
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
    if(p.autorefresh && Number(p.autorefresh)>0 && !isShared){
      _startAutorefresh(p, src, Number(p.autorefresh)*1000);
    }
  });

  if(canvasMode && !isMobile() && !isShared){
    _restoreCanvasViewport();
  }
}

/* ── loadPanel / renderViz / renderLogs ──────────── */
async function loadPanel(p, src){
  var body = document.getElementById('body-'+p.id);
  if(!body) return;
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
  for(var i=0;i<slice.length;i++){ var ev=slice[i]; var msg=''; try{var pl=JSON.parse(ev.payload); msg=pl.text||pl.message||pl.msg||''; if(!msg){var keys=Object.keys(pl); msg=keys.map(function(k){return k+'='+String(pl[k]);}).join(', ');} }catch(_){msg=ev.payload;} var time=formatLocalTime(ev.ts); html+='<tr><td class="logs-time">'+escapeHtml(time)+'</td><td class="logs-type">'+escapeHtml(ev.type)+'</td><td class="logs-msg">'+escapeHtml(msg)+'</td></tr>'; }
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
      // Раньше: setTimeout(100) наугад — либо срабатывает раньше готовности
      // layout (визуальный "прыжок"), либо позже необходимого (лишняя
      // задержка). ResizeObserver реагирует ровно в момент, когда контейнер
      // реально принял финальный размер, и сам себя отключает после первого
      // срабатывания — не висит лишним таймером в event loop.
      if (typeof ResizeObserver !== 'undefined') {
        var _ro = new ResizeObserver(function(){
          if (charts[p.id]) charts[p.id].resize();
          _ro.disconnect();
        });
        _ro.observe(bodyEl);
      } else {
        setTimeout(function(){ if(charts[p.id]) charts[p.id].resize(); }, 100);
      }
    }).catch(function(e){ bodyEl.innerHTML='Ошибка: '+e.message; });
  }
}

/* ── Кросс-графиковая синхронизация hover ──────────
 * Раньше на каждый onHover (десятки раз/сек при движении мыши) шёл
 * перебор ВСЕХ графиков (Object.keys(charts).forEach) и внутри — линейный
 * поиск индекса по массиву меток для каждого из них: O(charts × labels)
 * на каждое событие мыши. Теперь:
 *  1) label→index кэшируется на самом объекте чарта (строится один раз,
 *     инвалидируется только если поменялось число меток);
 *  2) реальная синхронизация остальных графиков троттлится через rAF —
 *     не чаще одного раза за кадр, даже если mousemove сыпется чаще.
 */
function _getLabelIndexMap(chart){
  var labels = chart.data.labels || [];
  if (chart._labelIndexMap && chart._labelIndexMapLen === labels.length) {
    return chart._labelIndexMap;
  }
  var map = {};
  for (var i = 0; i < labels.length; i++) map[String(labels[i])] = i;
  chart._labelIndexMap = map;
  chart._labelIndexMapLen = labels.length;
  return map;
}

var _hoverSyncPending = null; // { sourceId, label }
var _hoverSyncRaf = null;
function _scheduleHoverSync(sourceId, hoveredLabel){
  _hoverSyncPending = { sourceId: sourceId, label: hoveredLabel };
  if (_hoverSyncRaf) return;
  _hoverSyncRaf = requestAnimationFrame(function(){
    _hoverSyncRaf = null;
    var job = _hoverSyncPending;
    _hoverSyncPending = null;
    if (!job) return;
    _applyHoverSync(job.sourceId, job.label);
  });
}
function _applyHoverSync(sourceId, hoveredLabel){
  Object.keys(charts).forEach(function(cid){
    if (cid === sourceId) return;
    var otherChart = charts[cid];
    if (!otherChart) return;

    if (!hoveredLabel) {
      try {
        otherChart.setActiveElements([]);
        if (otherChart.tooltip) otherChart.tooltip.setActiveElements([], {x:0, y:0});
        otherChart.update('none');
      } catch(_){}
      return;
    }

    var idxMap = _getLabelIndexMap(otherChart);
    var matchIdx = idxMap[String(hoveredLabel)];
    if (matchIdx !== undefined) {
      try {
        otherChart.setActiveElements([{ datasetIndex: 0, index: matchIdx }]);
        if (otherChart.tooltip) {
          otherChart.tooltip.setActiveElements([{ datasetIndex: 0, index: matchIdx }], {x: 0, y: 0});
        }
        otherChart.update('none');
      } catch(_){}
    }
  });
}

/* ── Кэш цветов темы ─────────────────────────────
 * getThemeColor() читает CSS custom properties (computed style) —
 * не бесплатная операция. Раньше вызывался 3 раза на КАЖДОЕ построение
 * графика, хотя тема меняется редко. Кэшируем и сбрасываем при смене темы. */
var _themeColorsCache = null;
function _getCachedThemeColors(){
  if (_themeColorsCache) return _themeColorsCache;
  _themeColorsCache = {
    axisColor: (typeof getThemeColor === 'function') ? getThemeColor('--muted-2') : '#4E5768',
    gridColor: (typeof getThemeColor === 'function') ? getThemeColor('--border-soft') : '#1A2130',
    legendColor: (typeof getThemeColor === 'function') ? getThemeColor('--muted') : '#7C8798'
  };
  return _themeColorsCache;
}
function invalidateThemeColorsCache(){ _themeColorsCache = null; }
if (typeof document !== 'undefined') {
  // Если приложение диспатчит событие смены темы — подхватываем автоматически.
  document.addEventListener('themechange', invalidateThemeColorsCache);
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
  if(p.viz==='heatmap'){
    body.className = isFocus ? 'panel-body focus-body' : 'panel-body';
    if(typeof renderHeatmap === 'function'){
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
  var palette = (typeof getChartPalette === 'function') ? getChartPalette() : ['#4DECC7','#F2A950','#5B8DEF','#F2664F','#B892FF','#7CE0A0','#63E6BE','#FFD43B','#FF6B6B','#A9E34B'];
  var mainColor = p.color || palette[0];
  var unitStr = p.unit ? ' '+p.unit : '';

  var lineStyle = p.lineStyle || 'smooth';
  var dsTension;
  if(typeof p.tension === 'number'){
    dsTension = Math.max(0, Math.min(1, p.tension));
  } else {
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

  var _theme = _getCachedThemeColors();
  var axisColor = _theme.axisColor, gridColor = _theme.gridColor, legendColor = _theme.legendColor;

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

        // rAF-троттлинг: onHover может стрелять чаще, чем нужно перерисовывать
        // остальные графики (десятки раз/сек при движении мыши).
        _scheduleHoverSync(p.id, hoveredLabel);
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
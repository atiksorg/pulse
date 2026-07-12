/* ═══════════════════════════════════════════════════
   chart-gauge.js — Gauge visualization (pure canvas)
   Не зависит от Chart.js. Рисует дугу с зонами цветов
   и текущим значением в центре.
   ═══════════════════════════════════════════════════ */

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

  // Create canvas
  var w = container.clientWidth || 280;
  var h = container.clientHeight || 200;
  var dpr = window.devicePixelRatio || 1;

  var canvas = document.createElement('canvas');
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  container.innerHTML = '';
  container.appendChild(canvas);

  var ctx = canvas.getContext('2d');
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

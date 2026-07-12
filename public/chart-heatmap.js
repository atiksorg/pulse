/* ═══════════════════════════════════════════════════
   chart-heatmap.js — Heatmap visualization (HTML table)
   Рисует тепловую карту: ось X = buckets (дни/часы),
   ось Y = значения поля, цвет = интенсивность.
   Зависит от: core.js (escapeHtml, formatNum)
   ═══════════════════════════════════════════════════ */

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

  // Парсим базовый цвет для генерации оттенков
  // Ожидаем hex color (#RRGGBB) — конвертируем в HSL
  var rgb = hexToRgb(baseColor);
  var hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  var baseH = hsl[0], baseS = hsl[1], baseL = hsl[2];

  // Создаём HTML таблицу
  var html = '<div class="heatmap-wrap">';
  html += '<div class="heatmap-scroll"><table class="heatmap-table">';

  // Header row (buckets)
  html += '<thead><tr><th class="heatmap-corner"></th>';
  allBuckets.forEach(function(b) {
    var label = String(b);
    // Сокращаем длинные даты: "2025-01-15" → "01-15"
    if (label.length === 10 && label[4] === '-') label = label.slice(5);
    else if (label.length === 13 && label[10] === ' ') label = label.slice(11);
    html += '<th class="heatmap-th">' + escapeHtml(label) + '</th>';
  });
  html += '</tr></thead><tbody>';

  // Data rows
  series.forEach(function(s) {
    var pointMap = {};
    (s.points || []).forEach(function(pt) {
      pointMap[String(pt.bucket)] = Number(pt.value) || 0;
    });
    html += '<tr><td class="heatmap-label">' + escapeHtml(String(s.key)) + '</td>';
    allBuckets.forEach(function(b) {
      var v = pointMap[b] !== undefined ? pointMap[b] : 0;
      var pct = (v - minVal) / (maxVal - minVal);
      // Интерполяция цвета: от тёмного (min) до яркого (max)
      var cellL = 8 + pct * 35; // 8% (тёмный) → 43% (яркий)
      var cellS = baseS + (1 - pct) * 10; // насыщенность растёт с значением
      var bgColor = 'hsl(' + baseH + ', ' + cellS + '%, ' + cellL + '%)';
      var textColor = pct > 0.4 ? '#fff' : '#7C8798';
      var displayVal = formatNum(v, fmtType) + (unit ? ' ' + unit : '');
      html += '<td class="heatmap-cell" style="background:' + bgColor + ';color:' + textColor + ';" '
           + 'title="' + escapeHtml(String(s.key)) + ' × ' + escapeHtml(String(b)) + ': ' + escapeHtml(displayVal) + '">'
           + (v !== 0 ? formatCompact(v) : '') + '</td>';
    });
    html += '</tr>';
  });

  html += '</tbody></table></div>';

  // Legend
  html += '<div class="heatmap-legend">';
  html += '<span class="heatmap-legend-label">' + formatNum(minVal, fmtType) + '</span>';
  html += '<div class="heatmap-legend-bar" style="background:linear-gradient(to right, '
       + 'hsl(' + baseH + ',' + baseS + '%,8%), hsl(' + baseH + ',' + baseS + '%,43%));"></div>';
  html += '<span class="heatmap-legend-label">' + formatNum(maxVal, fmtType) + '</span>';
  html += '</div>';

  html += '</div>';
  container.innerHTML = html;

  // Resize-observer для адаптивной ширины
  var wrap = container.querySelector('.heatmap-wrap');
  if (wrap) {
    wrap.style.maxWidth = '100%';
    wrap.style.overflowX = 'auto';
  }
}

/* ── Color helpers ──────────────────────────────── */
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

/* ═══════════════════════════════════════════════════
   chart-plugins.js — Chart.js custom plugins:
   - thresholdPlugin: горизонтальные линии порогов
   - cumulateDataset: кумулятивное преобразование данных
   - comparePeriodPlugin: пунктирная линия пред. периода
   Зависит от: Chart.js (глобальный объект Chart)
   ═══════════════════════════════════════════════════ */

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
    opts.lines.forEach(function(line) {
      var y = yAxis.getPixelForValue(line.value);
      if (y < yAxis.top || y > yAxis.bottom) return;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = line.color || '#FF6B6B';
      ctx.lineWidth = 1.5;
      ctx.moveTo(chart.chartArea.left, y);
      ctx.lineTo(chart.chartArea.right, y);
      ctx.stroke();
      if (line.label) {
        ctx.setLineDash([]);
        ctx.fillStyle = line.color || '#FF6B6B';
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(line.label, chart.chartArea.left + 4, y - 3);
      }
      ctx.restore();
    });
  }
};

/* ── Register threshold plugin ──────────────────── */
if (typeof Chart !== 'undefined') {
  Chart.register(thresholdPlugin);
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

/* ═══════════════════════════════════════════════════
   themes.js — Цветовые темы (dark / light / high-contrast)
   ─────────────────────────────────────────────────
   • Пресеты палитр задаются через CSS-переменные
   • Сохранение выбора в localStorage (theme key)
   • Theme API для чартов: getChartPalette(), getThemeColor(), getPanelBorderColor()
   • Цикл по темам через кнопку в тулбаре (◐)
   ═══════════════════════════════════════════════════ */

var THEME_STORAGE_KEY = 'pulse_theme';
var THEMES = ['dark', 'light', 'high-contrast'];
var currentTheme = 'dark';

/* ── Применить тему к <html> ─────────────────────── */
function applyTheme(theme){
  if(THEMES.indexOf(theme) === -1) theme = 'dark';
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch(_){}
  // Перерисуем все графики — Chart.js использует цвета на момент создания
  if(typeof Object !== 'undefined' && typeof charts !== 'undefined'){
    Object.keys(charts).forEach(function(cid){
      if(charts[cid] && typeof charts[cid].update === 'function'){
        try { charts[cid].update('none'); } catch(_){}
      }
    });
  }
  // Обновим UI индикатор на кнопке (если есть)
  var btn = document.getElementById('btnThemeToggle');
  if(btn){
    var labels = { 'dark':'◑ Тёмная', 'light':'☀ Светлая', 'high-contrast':'◐ Контраст' };
    btn.textContent = labels[theme] || '◐';
    btn.title = 'Тема: ' + theme + ' (клик — переключить)';
  }
}

/* ── Цикл по темам (для кнопки в тулбаре) ───────── */
function cycleTheme(){
  var idx = THEMES.indexOf(currentTheme);
  var next = THEMES[(idx + 1) % THEMES.length];
  applyTheme(next);
  if(typeof toast === 'function'){
    var labels = { 'dark':'Тёмная', 'light':'Светлая', 'high-contrast':'Высокий контраст' };
    toast('Тема: ' + (labels[next] || next));
  }
}

/* ── Инициализация (вызывается из router.js → init) ─ */
function initTheme(){
  try {
    var saved = localStorage.getItem(THEME_STORAGE_KEY);
    if(saved && THEMES.indexOf(saved) !== -1){
      currentTheme = saved;
    }
  } catch(_){}
  applyTheme(currentTheme);
}

/* ── API для чартов: палитра серий ──────────────── */
function getChartPalette(){
  if(currentTheme === 'light'){
    return ['#0A7A66','#C66A18','#2453B0','#C4442F','#7A4FB8','#2C8A56','#1FA0A0','#C9931A','#C63838','#5B8E1A'];
  }
  if(currentTheme === 'high-contrast'){
    return ['#FFFF00','#00FFFF','#FF00FF','#00FF80','#FF8000','#80FF00','#FF0080','#0080FF','#FF4040','#40FF40'];
  }
  // dark (по умолчанию)
  return ['#4DECC7','#F2A950','#5B8DEF','#F2664F','#B892FF','#7CE0A0','#63E6BE','#FFD43B','#FF6B6B','#A9E34B'];
}

/* ── API для чартов: цвет бордера у pie/doughnut ── */
function getPanelBorderColor(){
  if(currentTheme === 'light') return '#FFFFFF';
  if(currentTheme === 'high-contrast') return '#000000';
  return '#0B0F17';
}

/* ── API для чартов: достать любую CSS-переменную ─ */
function getThemeColor(varName){
  if(!varName) return null;
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || null;
  } catch(_){ return null; }
}

/* ── Применить тему при загрузке (до рендера) ───── */
// Вызывается синхронно при загрузке скрипта, чтобы избежать «вспышки»
// неправильной темы. Если сохранённая тема — light, CSS-переменные
// переопределяются мгновенно.
(function applyThemeEarly(){
  try {
    var saved = localStorage.getItem(THEME_STORAGE_KEY);
    if(saved && THEMES.indexOf(saved) !== -1){
      currentTheme = saved;
      // Не дожидаемся DOMContentLoaded: <html> уже доступен
      if(document.documentElement){
        document.documentElement.setAttribute('data-theme', saved);
      }
    }
  } catch(_){}
})();

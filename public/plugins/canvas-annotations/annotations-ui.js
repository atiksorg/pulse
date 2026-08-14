/* ═══════════════════════════════════════════════════
   annotations-ui.js — Canvas Annotations Plugin
   Статические объекты на холсте: текст, заголовки, стикеры, разделители.
   Данные хранятся как обычные панели (viz: 'annotation-text' | 'sticky-note').
   ═══════════════════════════════════════════════════ */

(function(){
'use strict';

/* ── Константы ──────────────────────────────────── */
var ANNOTATION_TYPES = {
  'annotation-text': {
    label: 'Текст',
    icon: '📝',
    defaultContent: 'Введите текст…',
    defaultCw: 320,
    defaultCh: 80,
    minW: 100,
    minH: 40
  },
  'sticky-note': {
    label: 'Заметка',
    icon: '📌',
    defaultContent: 'Заметка…',
    defaultCw: 240,
    defaultCh: 200,
    minW: 140,
    minH: 100
  }
};

var STICKY_COLORS = [
  { bg: 'rgba(255,209,102,0.12)', border: 'rgba(255,209,102,0.4)', accent: '#FFD166', label: 'Жёлтый' },
  { bg: 'rgba(77,236,199,0.10)',  border: 'rgba(77,236,199,0.35)', accent: '#4DECC7', label: 'Зелёный' },
  { bg: 'rgba(91,141,239,0.10)',  border: 'rgba(91,141,239,0.35)', accent: '#5B8DEF', label: 'Синий' },
  { bg: 'rgba(184,146,255,0.10)', border: 'rgba(184,146,255,0.35)',accent: '#B892FF', label: 'Фиолет.' },
  { bg: 'rgba(242,102,79,0.10)',  border: 'rgba(242,102,79,0.30)', accent: '#F2664F', label: 'Красн.' },
  { bg: 'rgba(124,135,152,0.08)', border: 'rgba(124,135,152,0.30)',accent: '#7C8798', label: 'Серый' }
];

/* ── Публичный API ──────────────────────────────── */
window.CanvasAnnotations = {
  isAnnotation: isAnnotation,
  getAnnotationTypes: function(){ return ANNOTATION_TYPES; },
  addAnnotation: addAnnotation,
  renderAnnotation: renderAnnotation,
  initAnnotationDrag: initAnnotationDrag,
  openEditModal: openEditModal,
  getMenuItems: getMenuItems,
  STICKY_COLORS: STICKY_COLORS
};

/* ── Хелпер: является ли визуализация аннотацией ── */
function isAnnotation(viz){
  return viz === 'annotation-text' || viz === 'sticky-note';
}

/* ── Получить пункты контекстного меню для аннотации ── */
function getMenuItems(p, isShared){
  return [
    { act:'edit', icon:'edit', label:'Изменить', hidden: isShared },
    { act:'lock', icon:'lock', label: p.locked ? 'Разблокировать' : 'Закрепить', hidden: isShared },
    { act:'duplicate', icon:'copy', label:'Дублировать', hidden: isShared },
    { act:'remove', icon:'delete', label:'Удалить', danger: true, hidden: isShared }
  ].filter(function(m){ return !m.hidden; });
}

/* ── Добавить аннотацию на холст ────────────────── */
function addAnnotation(type){
  var db = getActiveDashboard();
  if(!db){ toast('Сначала откройте дашборд'); return; }

  var cfg = ANNOTATION_TYPES[type];
  if(!cfg) return;

  if(typeof pushUndoSnapshot === 'function') pushUndoSnapshot('добавление аннотации');

  var p = {
    id: uid('ann'),
    viz: type,
    title: cfg.label,
    content: cfg.defaultContent,
    width: 6
  };

  // Позиция — центр текущего viewport
  if(canvasMode && !isMobile() && interactiveCanvas){
    _saveCanvasViewport();
    var vp = interactiveCanvas.viewport.getBoundingClientRect();
    var cw = cfg.defaultCw;
    var ch = cfg.defaultCh;
    var centerX = (vp.width / 2 - interactiveCanvas.offsetX) / interactiveCanvas.scale - cw / 2;
    var centerY = (vp.height / 2 - interactiveCanvas.offsetY) / interactiveCanvas.scale - ch / 2;
    p.cx = Math.round(centerX / 20) * 20;
    p.cy = Math.round(centerY / 20) * 20;
    p.cw = cw;
    p.ch = ch;
  }

  // Z-index поверх всех
  var maxZ = getMaxPanelZ(db.panels);
  p.cz = maxZ >= CANVAS_Z_MAX ? CANVAS_Z_MAX : maxZ + 1;
  if(typeof canvasZCounter !== 'undefined') canvasZCounter = p.cz;

  db.panels.push(p);
  updateDashboardOnServer(db).then(function(){
    renderPanels();
    toast(cfg.icon + ' ' + cfg.label + ' добавлен(а)');
  }).catch(function(e){
    toast('Ошибка сохранения: ' + e.message);
  });
}

/* ── Рендер аннотации в panel-body ──────────────── */
function renderAnnotation(p, body){
  var cfg = ANNOTATION_TYPES[p.viz];
  if(!cfg){ body.innerHTML = '<div style="color:var(--coral);">Неизвестный тип</div>'; return; }

  var isSticky = p.viz === 'sticky-note';
  var colorIdx = typeof p.stickyColor === 'number' ? p.stickyColor : 0;
  var stickyTheme = STICKY_COLORS[colorIdx] || STICKY_COLORS[0];

  if(isSticky){
    body.style.background = stickyTheme.bg;
    body.style.borderTop = '3px solid ' + stickyTheme.accent;
  }

  var fontSize = p.annotationFontSize || (isSticky ? 14 : 16);
  var fontWeight = p.annotationFontWeight || 'normal';
  var textAlign = p.annotationAlign || 'left';
  var content = p.content || cfg.defaultContent;

  var div = document.createElement('div');
  div.className = 'annotation-content' + (isSticky ? ' annotation-sticky-content' : ' annotation-text-content');
  div.style.fontSize = fontSize + 'px';
  div.style.fontWeight = fontWeight;
  div.style.textAlign = textAlign;
  div.style.color = 'var(--text)';
  div.style.lineHeight = '1.55';
  div.style.padding = isSticky ? '12px 14px' : '8px 12px';
  div.style.width = '100%';
  div.style.height = '100%';
  div.style.overflow = 'auto';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordBreak = 'break-word';
  div.style.cursor = 'text';
  div.style.userSelect = 'text';
  div.textContent = content;

  body.appendChild(div);

  // Inline-редактирование по двойному клику
  div.addEventListener('dblclick', function(e){
    e.stopPropagation();
    startInlineEdit(div, p);
  });
}

/* ── Inline-редактирование ──────────────────────── */
function startInlineEdit(div, p){
  if(div.contentEditable === 'true') return; // уже редактируется

  div.contentEditable = 'true';
  div.style.outline = '2px solid var(--teal)';
  div.style.outlineOffset = '-2px';
  div.style.borderRadius = '4px';
  div.style.cursor = 'text';
  div.focus();

  // Выделить весь текст
  var range = document.createRange();
  range.selectNodeContents(div);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  var saved = false;

  function save(){
    if(saved) return;
    saved = true;
    div.contentEditable = 'false';
    div.style.outline = '';
    div.style.outlineOffset = '';
    div.style.cursor = 'text';

    var newContent = div.textContent;
    if(newContent !== p.content){
      p.content = newContent;
      var db = getActiveDashboard();
      if(db){
        var pp = db.panels.find(function(x){ return x.id === p.id; });
        if(pp){
          if(typeof pushUndoSnapshot === 'function') pushUndoSnapshot('редактирование текста');
          pp.content = newContent;
          updateDashboardOnServer(db).catch(function(e){
            toast('Ошибка сохранения: ' + e.message);
          });
        }
      }
    }
  }

  div.addEventListener('blur', save, { once: true });
  div.addEventListener('keydown', function handler(e){
    if(e.key === 'Escape'){
      div.textContent = p.content; // откат
      div.blur();
      div.removeEventListener('keydown', handler);
    }
    if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)){
      e.preventDefault();
      div.blur();
      div.removeEventListener('keydown', handler);
    }
  });
}

/* ── Инициализация drag для аннотаций ───────────── */
function initAnnotationDrag(card, p){
  // Обычный drag через panel-head (как у всех панелей)
  if(typeof initCanvasDrag === 'function'){
    initCanvasDrag(card, p);
  }
}

/* ── Модалка редактирования аннотации ───────────── */
function openEditModal(p){
  var cfg = ANNOTATION_TYPES[p.viz];
  if(!cfg) return;

  // Создаём оверлей
  var overlay = document.createElement('div');
  overlay.className = 'overlay active';
  overlay.style.zIndex = '10000';

  var isSticky = p.viz === 'sticky-note';
  var colorIdx = typeof p.stickyColor === 'number' ? p.stickyColor : 0;
  var currentFontSize = p.annotationFontSize || (isSticky ? 14 : 16);
  var currentWeight = p.annotationFontWeight || 'normal';
  var currentAlign = p.annotationAlign || 'left';

  var modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.maxWidth = '480px';

  var html = '<h2>' + cfg.icon + ' ' + (isSticky ? 'Настройка заметки' : 'Настройка текста') + '</h2>';

  // Содержимое
  html += '<div class="field" style="margin:16px 0 12px;">';
  html += '<label style="font-family:var(--mono);font-size:11px;color:var(--muted);">Текст</label>';
  html += '<textarea id="annEditContent" rows="5" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:10px 12px;font-size:14px;font-family:var(--sans);resize:vertical;">'
    + escapeHtml(p.content || '') + '</textarea>';
  html += '</div>';

  // Размер шрифта
  html += '<div class="field-row">';
  html += '<div class="field"><label style="font-family:var(--mono);font-size:11px;color:var(--muted);">Размер шрифта</label>';
  html += '<select id="annEditFontSize" style="background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:9px 11px;font-size:13px;">';
  [10,11,12,13,14,16,18,20,24,28,32,40].forEach(function(s){
    html += '<option value="'+s+'"'+(s===currentFontSize?' selected':'')+'>'+s+'px</option>';
  });
  html += '</select></div>';

  // Выравнивание
  html += '<div class="field"><label style="font-family:var(--mono);font-size:11px;color:var(--muted);">Выравнивание</label>';
  html += '<select id="annEditAlign" style="background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:9px 11px;font-size:13px;">';
  html += '<option value="left"'+(currentAlign==='left'?' selected':'')+'>По левому краю</option>';
  html += '<option value="center"'+(currentAlign==='center'?' selected':'')+'>По центру</option>';
  html += '<option value="right"'+(currentAlign==='right'?' selected':'')+'>По правому краю</option>';
  html += '</select></div>';
  html += '</div>';

  // Жирность
  html += '<div class="field-row">';
  html += '<div class="field"><label style="font-family:var(--mono);font-size:11px;color:var(--muted);">Начертание</label>';
  html += '<select id="annEditWeight" style="background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:9px 11px;font-size:13px;">';
  html += '<option value="normal"'+(currentWeight==='normal'?' selected':'')+'>Обычное</option>';
  html += '<option value="600"'+(currentWeight==='600'?' selected':'')+'>Полужирное</option>';
  html += '<option value="bold"'+(currentWeight==='bold'?' selected':'')+'>Жирное</option>';
  html += '</select></div>';

  // Цвет стикера (только для sticky-note)
  if(isSticky){
    html += '<div class="field"><label style="font-family:var(--mono);font-size:11px;color:var(--muted);">Цвет заметки</label>';
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;padding:4px 0;">';
    STICKY_COLORS.forEach(function(c, i){
      var selected = i === colorIdx;
      html += '<button type="button" class="ann-color-btn" data-idx="'+i+'" style="'
        +'width:28px;height:28px;border-radius:6px;border:2px solid '+(selected?c.accent:'var(--border)')+';'
        +'background:'+c.bg+';cursor:pointer;transition:all .15s;" title="'+c.label+'"></button>';
    });
    html += '</div></div>';
  }
  html += '</div>';

  // Кнопки
  html += '<div class="modal-actions">';
  html += '<button class="btn btn-ghost" id="annEditCancel">Отмена</button>';
  html += '<button class="btn btn-primary" id="annEditSave">Сохранить</button>';
  html += '</div>';

  modal.innerHTML = html;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Обработчики
  var selectedColor = colorIdx;

  overlay.addEventListener('click', function(e){
    if(e.target === overlay) overlay.remove();
  });
  modal.querySelector('#annEditCancel').onclick = function(){ overlay.remove(); };

  // Выбор цвета
  modal.querySelectorAll('.ann-color-btn').forEach(function(btn){
    btn.onclick = function(){
      selectedColor = parseInt(btn.dataset.idx, 10);
      modal.querySelectorAll('.ann-color-btn').forEach(function(b){
        var idx = parseInt(b.dataset.idx, 10);
        b.style.borderColor = idx === selectedColor ? STICKY_COLORS[idx].accent : 'var(--border)';
      });
    };
  });

  // Сохранение
  modal.querySelector('#annEditSave').onclick = function(){
    var newContent = modal.querySelector('#annEditContent').value;
    var newFontSize = parseInt(modal.querySelector('#annEditFontSize').value, 10);
    var newAlign = modal.querySelector('#annEditAlign').value;
    var newWeight = modal.querySelector('#annEditWeight').value;

    if(typeof pushUndoSnapshot === 'function') pushUndoSnapshot('настройка аннотации');

    p.content = newContent;
    p.annotationFontSize = newFontSize;
    p.annotationAlign = newAlign;
    p.annotationFontWeight = newWeight;
    if(isSticky) p.stickyColor = selectedColor;

    // Обновляем в БД
    var db = getActiveDashboard();
    if(db){
      var pp = db.panels.find(function(x){ return x.id === p.id; });
      if(pp){
        Object.assign(pp, {
          content: newContent,
          annotationFontSize: newFontSize,
          annotationAlign: newAlign,
          annotationFontWeight: newWeight
        });
        if(isSticky) pp.stickyColor = selectedColor;
      }
      updateDashboardOnServer(db).then(function(){
        _saveCanvasViewport();
        renderPanels();
        toast('✓ Сохранено');
      }).catch(function(e){
        toast('Ошибка: ' + e.message);
      });
    }
    overlay.remove();
  };
}

})();

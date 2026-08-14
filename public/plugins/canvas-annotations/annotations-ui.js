/* ═══════════════════════════════════════════════════
   annotations-ui.js — Canvas Annotations Plugin
   Статические объекты на холсте: текст, надписи, заметки.
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
    defaultCw: 260,
    defaultCh: 180,
    minW: 140,
    minH: 80
  }
};

var TEXT_PALETTE = [
  { color: '#E8ECF2', label: 'Основной (белый)' },
  { color: '#4DECC7', label: 'Бирюзовый' },
  { color: '#F2A950', label: 'Янтарный' },
  { color: '#F2664F', label: 'Коралловый' },
  { color: '#5B8DEF', label: 'Синий' },
  { color: '#B892FF', label: 'Фиолетовый' },
  { color: '#7CE0A0', label: 'Зелёный' },
  { color: '#7C8798', label: 'Серый' }
];

var STICKY_COLORS = [
  { bg: 'rgba(255,209,102,0.14)', border: 'rgba(255,209,102,0.45)', accent: '#FFD166', label: 'Жёлтый' },
  { bg: 'rgba(77,236,199,0.12)',  border: 'rgba(77,236,199,0.40)', accent: '#4DECC7', label: 'Зелёный' },
  { bg: 'rgba(91,141,239,0.12)',  border: 'rgba(91,141,239,0.40)', accent: '#5B8DEF', label: 'Синий' },
  { bg: 'rgba(184,146,255,0.12)', border: 'rgba(184,146,255,0.40)',accent: '#B892FF', label: 'Фиолет.' },
  { bg: 'rgba(242,102,79,0.12)',  border: 'rgba(242,102,79,0.35)', accent: '#F2664F', label: 'Красн.' },
  { bg: 'rgba(124,135,152,0.10)', border: 'rgba(124,135,152,0.35)',accent: '#7C8798', label: 'Серый' },
  { bg: 'transparent',            border: 'transparent',           accent: 'var(--border)', label: 'Прозрачный' }
];

/* ── Публичный API ──────────────────────────────── */
window.CanvasAnnotations = {
  isAnnotation: isAnnotation,
  getAnnotationTypes: function(){ return ANNOTATION_TYPES; },
  addAnnotation: addAnnotation,
  renderAnnotation: renderAnnotation,
  openEditModal: openEditModal,
  getMenuItems: getMenuItems,
  STICKY_COLORS: STICKY_COLORS,
  TEXT_PALETTE: TEXT_PALETTE
};

/* ── Хелпер: сохранение одного поля аннотации ──── */
function _saveAnnotationField(p, field, value){
  p[field] = value;
  var db = getActiveDashboard();
  if(!db) return;
  var pp = db.panels.find(function(x){ return x.id === p.id; });
  if(pp){
    if(typeof pushUndoSnapshot === 'function') pushUndoSnapshot('настройка текста');
    pp[field] = value;
    updateDashboardOnServer(db).catch(function(e){
      toast('Ошибка сохранения: ' + e.message);
    });
  }
}

/* ── Хелпер: является ли визуализация аннотацией ── */
function isAnnotation(viz){
  return viz === 'annotation-text' || viz === 'sticky-note';
}

/* ── Меню аннотации ────────────────────────────── */
function getMenuItems(p, isShared){
  return [
    { act:'edit', icon:'edit', label:'Настроить', hidden: isShared },
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

  if(typeof pushUndoSnapshot === 'function') pushUndoSnapshot('добавление надписи');

  var p = {
    id: uid('ann'),
    viz: type,
    title: cfg.label,
    content: cfg.defaultContent,
    annotationFontSize: type === 'annotation-text' ? 18 : 15,
    annotationFontWeight: 'normal',
    annotationAlign: 'left',
    annotationTextColor: '#E8ECF2',
    width: 6
  };

  if(type === 'sticky-note') p.stickyColor = 0;

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
  var colorIdx = typeof p.stickyColor === 'number' ? p.stickyColor : (isSticky ? 0 : 6);
  var stickyTheme = STICKY_COLORS[colorIdx] || STICKY_COLORS[0];

  var fontSize = p.annotationFontSize || (isSticky ? 15 : 18);
  var fontWeight = p.annotationFontWeight || 'normal';
  var textAlign = p.annotationAlign || 'left';
  var content = (p.content !== undefined && p.content !== null) ? p.content : cfg.defaultContent;
  var textColor = p.annotationTextColor || '#E8ECF2';

  body.innerHTML = '';
  body.style.background = isSticky ? stickyTheme.bg : 'transparent';
  if(isSticky && stickyTheme.accent !== 'var(--border)'){
    body.style.borderTop = '3px solid ' + stickyTheme.accent;
    body.style.borderRadius = '6px';
  } else {
    body.style.borderTop = 'none';
  }

  // Обёртка
  var wrapper = document.createElement('div');
  wrapper.className = 'annotation-wrapper';
  wrapper.style.cssText = 'position:relative;width:100%;height:100%;display:flex;flex-direction:column;';

  // ── Верхняя ручка захвата (Drag Bar) ──
  // Аккуратная полоска сверху, за которую панель легко перетаскивать
  var dragBar = document.createElement('div');
  dragBar.className = 'annotation-drag-bar';
  dragBar.title = 'Потяните для перемещения';
  dragBar.innerHTML = '<span class="ann-grip-dots">•••••</span>';
  wrapper.appendChild(dragBar);

  // ── Inline-тулбар (появляется при наведении) ──
  var toolbar = document.createElement('div');
  toolbar.className = 'ann-toolbar';

  // Кнопки размера шрифта A- / A+
  var fontSizeDisplay = document.createElement('span');
  fontSizeDisplay.className = 'ann-fs-val';
  fontSizeDisplay.textContent = fontSize + 'px';

  function makeTbBtn(label, title){
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ann-tb-btn';
    b.title = title;
    b.textContent = label;
    return b;
  }

  var btnFsDown = makeTbBtn('A−', 'Уменьшить шрифт');
  var btnFsUp = makeTbBtn('A+', 'Увеличить шрифт');

  btnFsDown.onclick = function(e){
    e.stopPropagation();
    var cur = parseInt(p.annotationFontSize || fontSize, 10);
    var newSize = Math.max(10, cur - 2);
    p.annotationFontSize = newSize;
    fontSize = newSize;
    fontSizeDisplay.textContent = newSize + 'px';
    if(contentEl) contentEl.style.fontSize = newSize + 'px';
    _saveAnnotationField(p, 'annotationFontSize', newSize);
  };
  btnFsUp.onclick = function(e){
    e.stopPropagation();
    var cur = parseInt(p.annotationFontSize || fontSize, 10);
    var newSize = Math.min(72, cur + 2);
    p.annotationFontSize = newSize;
    fontSize = newSize;
    fontSizeDisplay.textContent = newSize + 'px';
    if(contentEl) contentEl.style.fontSize = newSize + 'px';
    _saveAnnotationField(p, 'annotationFontSize', newSize);
  };

  toolbar.appendChild(btnFsDown);
  toolbar.appendChild(fontSizeDisplay);
  toolbar.appendChild(btnFsUp);

  // Разделитель
  var sep1 = document.createElement('span');
  sep1.className = 'ann-tb-sep';
  toolbar.appendChild(sep1);

  // Выбор цвета текста (для надписи и для заметки)
  TEXT_PALETTE.forEach(function(tc){
    var swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'ann-color-swatch' + (tc.color === textColor ? ' active' : '');
    swatch.title = 'Цвет текста: ' + tc.label;
    swatch.style.background = tc.color;
    swatch.onclick = function(e){
      e.stopPropagation();
      p.annotationTextColor = tc.color;
      textColor = tc.color;
      toolbar.querySelectorAll('.ann-color-swatch').forEach(function(s){ s.classList.remove('active'); });
      swatch.classList.add('active');
      if(contentEl) contentEl.style.color = tc.color;
      _saveAnnotationField(p, 'annotationTextColor', tc.color);
    };
    toolbar.appendChild(swatch);
  });

  // Если это стикер — добавляем выбор цвета подложки
  if(isSticky){
    var sep2 = document.createElement('span');
    sep2.className = 'ann-tb-sep';
    toolbar.appendChild(sep2);

    STICKY_COLORS.slice(0, 6).forEach(function(c, i){
      var swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'ann-sticky-swatch' + (i === colorIdx ? ' active' : '');
      swatch.title = 'Цвет стикера: ' + c.label;
      swatch.style.background = c.accent;
      swatch.onclick = function(e){
        e.stopPropagation();
        p.stickyColor = i;
        toolbar.querySelectorAll('.ann-sticky-swatch').forEach(function(s){ s.classList.remove('active'); });
        swatch.classList.add('active');
        body.style.background = c.bg;
        body.style.borderTop = '3px solid ' + c.accent;
        _saveAnnotationField(p, 'stickyColor', i);
      };
      toolbar.appendChild(swatch);
    });
  }

  // Кнопка ⚙ (настройки)
  var sep3 = document.createElement('span');
  sep3.className = 'ann-tb-sep';
  toolbar.appendChild(sep3);

  var btnGear = makeTbBtn('⚙', 'Расширенные настройки');
  btnGear.onclick = function(e){
    e.stopPropagation();
    openEditModal(p);
  };
  toolbar.appendChild(btnGear);

  wrapper.appendChild(toolbar);

  // ── Текстовый контент ──
  var contentEl = document.createElement('div');
  contentEl.className = 'annotation-content' + (isSticky ? ' annotation-sticky-content' : ' annotation-text-content');
  contentEl.style.fontSize = fontSize + 'px';
  contentEl.style.fontWeight = fontWeight;
  contentEl.style.textAlign = textAlign;
  contentEl.style.color = textColor;
  contentEl.style.lineHeight = '1.45';
  contentEl.style.padding = isSticky ? '6px 12px 12px' : '4px 8px 8px';
  contentEl.style.flex = '1';
  contentEl.style.overflow = 'auto';
  contentEl.style.whiteSpace = 'pre-wrap';
  contentEl.style.wordBreak = 'break-word';
  contentEl.style.cursor = 'text';
  contentEl.style.userSelect = 'text';
  contentEl.textContent = content;

  wrapper.appendChild(contentEl);
  body.appendChild(wrapper);

  // Двойной клик — редактирование на месте
  contentEl.addEventListener('dblclick', function(e){
    e.stopPropagation();
    startInlineEdit(contentEl, p);
  });
}

/* ── Inline-редактирование текста ──────────────── */
function startInlineEdit(div, p){
  if(div.contentEditable === 'true') return;

  div.contentEditable = 'true';
  div.classList.add('editing');
  div.focus();

  // Выделить всё содержимое
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
    div.classList.remove('editing');

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
      div.textContent = p.content;
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

/* ── Модалка редактирования аннотации ───────────── */
function openEditModal(p){
  var cfg = ANNOTATION_TYPES[p.viz] || ANNOTATION_TYPES['annotation-text'];

  var overlay = document.createElement('div');
  overlay.className = 'overlay active';
  overlay.style.zIndex = '10000';

  var isSticky = p.viz === 'sticky-note';
  var colorIdx = typeof p.stickyColor === 'number' ? p.stickyColor : 0;
  var currentFontSize = parseInt(p.annotationFontSize || (isSticky ? 15 : 18), 10);
  var currentWeight = p.annotationFontWeight || 'normal';
  var currentAlign = p.annotationAlign || 'left';
  var currentTextColor = p.annotationTextColor || '#E8ECF2';

  var modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.maxWidth = '500px';

  var html = '<h2>' + cfg.icon + ' ' + (isSticky ? 'Настройка заметки' : 'Настройка надписи') + '</h2>';

  // Содержимое
  html += '<div class="field" style="margin:16px 0 12px;">';
  html += '<label style="font-family:var(--mono);font-size:11px;color:var(--muted);">Текст надписи</label>';
  html += '<textarea id="annEditContent" rows="4" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:10px 12px;font-size:14px;font-family:var(--sans);resize:vertical;">'
    + escapeHtml(p.content || '') + '</textarea>';
  html += '</div>';

  // Размер шрифта и цвет текста
  html += '<div class="field-row">';
  html += '<div class="field"><label style="font-family:var(--mono);font-size:11px;color:var(--muted);">Размер шрифта</label>';
  html += '<select id="annEditFontSize" style="background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:9px 11px;font-size:13px;">';
  [12, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36, 42, 48, 60, 72].forEach(function(s){
    html += '<option value="'+s+'"'+(s===currentFontSize?' selected':'')+'>'+s+'px</option>';
  });
  html += '</select></div>';

  html += '<div class="field"><label style="font-family:var(--mono);font-size:11px;color:var(--muted);">Цвет текста</label>';
  html += '<div style="display:flex;align-items:center;gap:8px;margin-top:2px;">';
  html += '<input id="annEditTextColor" type="color" value="'+escapeHtml(currentTextColor)+'" style="width:40px;height:36px;padding:2px;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:var(--bg);">';
  html += '<span id="annEditTextColorVal" style="font-family:var(--mono);font-size:12px;color:var(--muted);">'+escapeHtml(currentTextColor)+'</span>';
  html += '</div></div>';
  html += '</div>';

  // Выравнивание и жирность
  html += '<div class="field-row">';
  html += '<div class="field"><label style="font-family:var(--mono);font-size:11px;color:var(--muted);">Выравнивание</label>';
  html += '<select id="annEditAlign" style="background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:9px 11px;font-size:13px;">';
  html += '<option value="left"'+(currentAlign==='left'?' selected':'')+'>По левому краю</option>';
  html += '<option value="center"'+(currentAlign==='center'?' selected':'')+'>По центру</option>';
  html += '<option value="right"'+(currentAlign==='right'?' selected':'')+'>По правому краю</option>';
  html += '</select></div>';

  html += '<div class="field"><label style="font-family:var(--mono);font-size:11px;color:var(--muted);">Начертание</label>';
  html += '<select id="annEditWeight" style="background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:9px 11px;font-size:13px;">';
  html += '<option value="normal"'+(currentWeight==='normal'?' selected':'')+'>Обычное</option>';
  html += '<option value="600"'+(currentWeight==='600'?' selected':'')+'>Полужирное</option>';
  html += '<option value="bold"'+(currentWeight==='bold'?' selected':'')+'>Жирное</option>';
  html += '</select></div>';
  html += '</div>';

  // Цвет подложки заметки (для sticky-note)
  if(isSticky){
    html += '<div class="field" style="margin-bottom:14px;"><label style="font-family:var(--mono);font-size:11px;color:var(--muted);">Цвет стикера</label>';
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;padding:4px 0;">';
    STICKY_COLORS.forEach(function(c, i){
      var selected = i === colorIdx;
      html += '<button type="button" class="ann-modal-color-btn" data-idx="'+i+'" style="'
        +'width:28px;height:28px;border-radius:6px;border:2px solid '+(selected?c.accent:'var(--border)')+';'
        +'background:'+(c.bg === 'transparent' ? 'var(--panel-2)' : c.bg)+';cursor:pointer;transition:all .15s;" title="'+c.label+'"></button>';
    });
    html += '</div></div>';
  }

  // Кнопки
  html += '<div class="modal-actions">';
  html += '<button class="btn btn-ghost" id="annEditCancel">Отмена</button>';
  html += '<button class="btn btn-primary" id="annEditSave">Сохранить</button>';
  html += '</div>';

  modal.innerHTML = html;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  var selectedStickyColor = colorIdx;

  overlay.addEventListener('click', function(e){
    if(e.target === overlay) overlay.remove();
  });
  modal.querySelector('#annEditCancel').onclick = function(){ overlay.remove(); };

  var colorPicker = modal.querySelector('#annEditTextColor');
  var colorPickerVal = modal.querySelector('#annEditTextColorVal');
  if(colorPicker && colorPickerVal){
    colorPicker.oninput = function(){ colorPickerVal.textContent = colorPicker.value; };
  }

  modal.querySelectorAll('.ann-modal-color-btn').forEach(function(btn){
    btn.onclick = function(){
      selectedStickyColor = parseInt(btn.dataset.idx, 10);
      modal.querySelectorAll('.ann-modal-color-btn').forEach(function(b){
        var idx = parseInt(b.dataset.idx, 10);
        b.style.borderColor = idx === selectedStickyColor ? STICKY_COLORS[idx].accent : 'var(--border)';
      });
    };
  });

  // Сохранение настроек
  modal.querySelector('#annEditSave').onclick = function(){
    var newContent = modal.querySelector('#annEditContent').value;
    var newFontSize = parseInt(modal.querySelector('#annEditFontSize').value, 10);
    var newTextColor = modal.querySelector('#annEditTextColor').value;
    var newAlign = modal.querySelector('#annEditAlign').value;
    var newWeight = modal.querySelector('#annEditWeight').value;

    if(typeof pushUndoSnapshot === 'function') pushUndoSnapshot('настройка надписи');

    p.content = newContent;
    p.annotationFontSize = newFontSize;
    p.annotationTextColor = newTextColor;
    p.annotationAlign = newAlign;
    p.annotationFontWeight = newWeight;
    if(isSticky) p.stickyColor = selectedStickyColor;

    var db = getActiveDashboard();
    if(db){
      var pp = db.panels.find(function(x){ return x.id === p.id; });
      if(pp){
        Object.assign(pp, {
          content: newContent,
          annotationFontSize: newFontSize,
          annotationTextColor: newTextColor,
          annotationAlign: newAlign,
          annotationFontWeight: newWeight
        });
        if(isSticky) pp.stickyColor = selectedStickyColor;
      }
      updateDashboardOnServer(db).then(function(){
        _saveCanvasViewport();
        renderPanels();
        toast('✓ Настройки сохранены');
      }).catch(function(e){
        toast('Ошибка сохранения: ' + e.message);
      });
    }
    overlay.remove();
  };
}

})();

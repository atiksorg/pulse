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

/* ── Хелпер: сохранение одного поля аннотации ──── */
function _saveAnnotationField(p, field, value){
  var db = getActiveDashboard();
  if(!db) return;
  var pp = db.panels.find(function(x){ return x.id === p.id; });
  if(pp){
    if(typeof pushUndoSnapshot === 'function') pushUndoSnapshot('настройка аннотации');
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

  // Контейнер для тулбара и текста
  var wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';
  wrapper.style.display = 'flex';
  wrapper.style.flexDirection = 'column';

  // ── Inline-тулбар (показывается по hover) ──
  var toolbar = document.createElement('div');
  toolbar.className = 'ann-toolbar';
  toolbar.style.cssText = 'display:none;position:absolute;top:0;left:0;right:0;z-index:10;'
    +'padding:4px 8px;background:rgba(19,25,38,0.92);backdrop-filter:blur(6px);'
    +'border-bottom:1px solid var(--border);border-radius:4px 4px 0 0;'
    +'align-items:center;gap:6px;flex-wrap:wrap;font-family:var(--mono);font-size:11px;';

  // Размер шрифта: − / значение / +
  var fontSizeDisplay = document.createElement('span');
  fontSizeDisplay.style.cssText = 'color:var(--muted);min-width:28px;text-align:center;';
  fontSizeDisplay.textContent = fontSize;

  function makeTbBtn(label, title){
    var b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.style.cssText = 'width:22px;height:22px;border-radius:4px;border:1px solid var(--border);'
      +'background:var(--panel-2);color:var(--muted);cursor:pointer;display:flex;'
      +'align-items:center;justify-content:center;font-size:12px;transition:all .12s;';
    b.textContent = label;
    b.onmouseenter = function(){ b.style.color='var(--text)'; b.style.borderColor='var(--muted-2)'; };
    b.onmouseleave = function(){ b.style.color='var(--muted)'; b.style.borderColor='var(--border)'; };
    return b;
  }

  var btnFsDown = makeTbBtn('A−', 'Уменьшить шрифт');
  var btnFsUp = makeTbBtn('A+', 'Увеличить шрифт');

  btnFsDown.onclick = function(e){
    e.stopPropagation();
    var newSize = Math.max(8, (p.annotationFontSize || fontSize) - 2);
    p.annotationFontSize = newSize;
    fontSize = newSize;
    fontSizeDisplay.textContent = newSize;
    var contentEl = wrapper.querySelector('.annotation-content');
    if(contentEl) contentEl.style.fontSize = newSize + 'px';
    _saveAnnotationField(p, 'annotationFontSize', newSize);
  };
  btnFsUp.onclick = function(e){
    e.stopPropagation();
    var newSize = Math.min(72, (p.annotationFontSize || fontSize) + 2);
    p.annotationFontSize = newSize;
    fontSize = newSize;
    fontSizeDisplay.textContent = newSize;
    var contentEl = wrapper.querySelector('.annotation-content');
    if(contentEl) contentEl.style.fontSize = newSize + 'px';
    _saveAnnotationField(p, 'annotationFontSize', newSize);
  };

  toolbar.appendChild(btnFsDown);
  toolbar.appendChild(fontSizeDisplay);
  toolbar.appendChild(btnFsUp);

  // Разделитель
  var sep = document.createElement('span');
  sep.style.cssText = 'width:1px;height:14px;background:var(--border);flex-shrink:0;';
  toolbar.appendChild(sep);

  // Цвет стикера (только для sticky-note)
  if(isSticky){
    STICKY_COLORS.forEach(function(c, i){
      var swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.title = c.label;
      swatch.style.cssText = 'width:18px;height:18px;border-radius:4px;border:2px solid '
        + (i === colorIdx ? c.accent : 'transparent')
        + ';background:' + c.accent + ';cursor:pointer;transition:all .12s;flex-shrink:0;';
      swatch.onclick = function(e){
        e.stopPropagation();
        p.stickyColor = i;
        // Обновляем border подсветку
        toolbar.querySelectorAll('.ann-swatch-active').forEach(function(s){
          s.style.borderColor = 'transparent';
          s.classList.remove('ann-swatch-active');
        });
        swatch.style.borderColor = c.accent;
        swatch.classList.add('ann-swatch-active');
        // Обновляем фон body
        body.style.background = c.bg;
        body.style.borderTop = '3px solid ' + c.accent;
        _saveAnnotationField(p, 'stickyColor', i);
      };
      if(i === colorIdx) swatch.classList.add('ann-swatch-active');
      toolbar.appendChild(swatch);
    });

    // Разделитель
    var sep2 = document.createElement('span');
    sep2.style.cssText = 'width:1px;height:14px;background:var(--border);flex-shrink:0;';
    toolbar.appendChild(sep2);
  }

  // Кнопка «Настроить» (открывает модалку)
  var btnSettings = makeTbBtn('⚙', 'Расширенные настройки');
  btnSettings.style.width = 'auto';
  btnSettings.style.padding = '0 6px';
  btnSettings.onclick = function(e){
    e.stopPropagation();
    openEditModal(p);
  };
  toolbar.appendChild(btnSettings);

  wrapper.appendChild(toolbar);

  // ── Контент ──
  var div = document.createElement('div');
  div.className = 'annotation-content' + (isSticky ? ' annotation-sticky-content' : ' annotation-text-content');
  div.style.fontSize = fontSize + 'px';
  div.style.fontWeight = fontWeight;
  div.style.textAlign = textAlign;
  div.style.color = 'var(--text)';
  div.style.lineHeight = '1.55';
  div.style.padding = isSticky ? '12px 14px' : '8px 12px';
  div.style.flex = '1';
  div.style.overflow = 'auto';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordBreak = 'break-word';
  div.style.cursor = 'text';
  div.style.userSelect = 'text';
  div.textContent = content;

  wrapper.appendChild(div);
  body.appendChild(wrapper);

  // Показываем тулбар по hover на card
  var card = body.closest('.panel-card');
  if(card){
    card.addEventListener('mouseenter', function(){ toolbar.style.display = 'flex'; });
    card.addEventListener('mouseleave', function(e){
      // Не скрываем если идёт редактирование текста
      if(div.contentEditable === 'true') return;
      toolbar.style.display = 'none';
    });
  }

  // Inline-редактирование по двойному клику
  div.addEventListener('dblclick', function(e){
    e.stopPropagation();
    startInlineEdit(div, p, toolbar);
  });
}

/* ── Inline-редактирование ──────────────────────── */
function startInlineEdit(div, p, toolbar){
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

/* ═══════════════════════════════════════════════════
   interactive-canvas.js — InteractiveCanvas component
   Бесконечный холст с панорамированием и зумом.
   Слабосвязанный компонент: не зависит от dashboard.js,
   общается через колбэки и метод screenToLocal().
   ═══════════════════════════════════════════════════ */

(function(global) {
  'use strict';

  var DEFAULTS = {
    minScale: 0.15,
    maxScale: 3.0,
    zoomSensitivity: 0.0015,   // чувствительность колеса
    panGridSize: 0,            // 0 = без привязки к сетке при pan
    dragGridSize: 20,          // привязка карточек к сетке при drag
    resizeGridSize: 20         // привязка карточек к сетке при resize
  };

  /**
   * @class InteractiveCanvas
   * @param {HTMLElement} viewportEl  — контейнер-маска (overflow:hidden)
   * @param {HTMLElement} surfaceEl    — масштабируемая плоскость
   * @param {Object}      options      — настройки
   */
  function InteractiveCanvas(viewportEl, surfaceEl, options) {
    this.viewport = viewportEl;
    this.surface = surfaceEl;
    this.options = Object.assign({}, DEFAULTS, options || {});

    // ── State ──
    this.scale = 1.0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.isPanning = false;
    this._spaceDown = false;
    this._panState = null;
    this._listeners = [];
    this._viewportChangeCallbacks = [];
    this._destroyed = false;

    // ── Init ──
    this._init();
  }

  /* ═══════════════════════════════════════════════════
     Private: init / bind events
     ═══════════════════════════════════════════════════ */

  InteractiveCanvas.prototype._init = function() {
    // Устанавливаем базовые стили
    this.viewport.classList.add('ic-viewport');
    this.surface.classList.add('ic-surface');

    // transform-origin: 0 0 — упрощает расчёты
    this.surface.style.transformOrigin = '0 0';
    this.surface.style.willChange = 'transform';

    this._applyTransform();

    // ── Bind events ──
    this._bind(this.viewport, 'wheel', this._onWheel, { passive: false });
    this._bind(this.viewport, 'mousedown', this._onMouseDown);
    this._bind(document, 'mousemove', this._onMouseMove);
    this._bind(document, 'mouseup', this._onMouseUp);
    this._bind(document, 'keydown', this._onKeyDown);
    this._bind(document, 'keyup', this._onKeyUp);
    this._bind(window, 'resize', this._onResize);
    // Prevent context menu on middle-click pan
    this._bind(this.viewport, 'contextmenu', this._onContextMenu);
  };

  InteractiveCanvas.prototype._bind = function(target, event, handler, opts) {
    var bound = handler.bind(this);
    target.addEventListener(event, bound, opts || false);
    this._listeners.push({ target: target, event: event, handler: bound, opts: opts });
  };

  /* ═══════════════════════════════════════════════════
     Private: transform application
     ═══════════════════════════════════════════════════ */

  InteractiveCanvas.prototype._applyTransform = function() {
    var s = this.scale;
    var x = this.offsetX;
    var y = this.offsetY;
    this.surface.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) scale(' + s + ')';
  };

  InteractiveCanvas.prototype._notifyViewportChange = function() {
    var self = this;
    this._viewportChangeCallbacks.forEach(function(cb) {
      try { cb({ scale: self.scale, offsetX: self.offsetX, offsetY: self.offsetY }); } catch(_) {}
    });
  };

  /* ═══════════════════════════════════════════════════
     Private: wheel zoom (cursor-centered)
     ═══════════════════════════════════════════════════ */

  InteractiveCanvas.prototype._onWheel = function(e) {
    // ── Разграничение: если курсор над прокручиваемым элементом внутри карточки — не зумим ──
    if (this._isOverScrollable(e.target)) return;

    e.preventDefault();

    var rect = this.viewport.getBoundingClientRect();
    var mouseX = e.clientX - rect.left;
    var mouseY = e.clientY - rect.top;

    // Координаты холста под курсором ДО зума
    var canvasX = (mouseX - this.offsetX) / this.scale;
    var canvasY = (mouseY - this.offsetY) / this.scale;

    // Вычисляем новый масштаб
    var delta = -e.deltaY * this.options.zoomSensitivity;
    var newScale = this.scale * (1 + delta);

    // Трекпадный пинч (ctrlKey + wheel) — усиливаем
    if (e.ctrlKey) {
      newScale = this.scale * (1 + delta * 2);
    }

    newScale = this._clampScale(newScale);

    // Корректируем offset так, чтобы точка под курсором осталась на месте
    this.offsetX = mouseX - canvasX * newScale;
    this.offsetY = mouseY - canvasY * newScale;
    this.scale = newScale;

    this._applyTransform();
    this._notifyViewportChange();
  };

  InteractiveCanvas.prototype._clampScale = function(s) {
    if (s < this.options.minScale) return this.options.minScale;
    if (s > this.options.maxScale) return this.options.maxScale;
    return s;
  };

  /* ═══════════════════════════════════════════════════
     Private: detect scrollable element under cursor
     ═══════════════════════════════════════════════════ */

  InteractiveCanvas.prototype._isOverScrollable = function(el) {
    var node = el;
    while (node && node !== this.viewport) {
      if (node.nodeType !== 1) { node = node.parentNode; continue; }
      var style = getComputedStyle(node);
      var overflowY = style.overflowY;
      var overflowX = style.overflowX;
      var canScrollY = (overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight;
      var canScrollX = (overflowX === 'auto' || overflowX === 'scroll') && node.scrollWidth > node.clientWidth;
      if (canScrollY || canScrollX) return true;
      node = node.parentNode;
    }
    return false;
  };

  /* ═══════════════════════════════════════════════════
     Private: pan (Space+drag / middle-click)
     ═══════════════════════════════════════════════════ */

  InteractiveCanvas.prototype._onMouseDown = function(e) {
    // Средняя кнопка мыши (колесико) — всегда пан
    if (e.button === 1) {
      e.preventDefault();
      // Предотвращаем автоскролл браузера при middle-click
      if (e.stopPropagation) e.stopPropagation();
      this._startPan(e.clientX, e.clientY);
      return;
    }

    // Левая кнопка + зажатый Space — пан
    if (e.button === 0 && this._spaceDown) {
      e.preventDefault();
      this._startPan(e.clientX, e.clientY);
      return;
    }

    // Левая кнопка без Space — панорамирование на пустом пространстве
    // (если клик НЕ по заголовку панели и НЕ по интерактивному элементу)
    if (e.button === 0 && !this._spaceDown) {
      var target = e.target;
      // Проверяем, что клик не по заголовку панели или интерактивному элементу
      if (!this._isOverPanelHead(target) && !this._isOverInteractiveElement(target)) {
        e.preventDefault();
        this._startPan(e.clientX, e.clientY);
        return;
      }
    }
  };

  InteractiveCanvas.prototype._isOverPanelHead = function(el) {
    var node = el;
    while (node && node !== this.viewport) {
      if (node.nodeType !== 1) { node = node.parentNode; continue; }
      if (node.classList && node.classList.contains('panel-head')) return true;
      node = node.parentNode;
    }
    return false;
  };

  InteractiveCanvas.prototype._isOverInteractiveElement = function(el) {
    var node = el;
    while (node && node !== this.viewport) {
      if (node.nodeType !== 1) { node = node.parentNode; continue; }
      var tag = node.tagName;
      // Проверяем интерактивные элементы
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A') return true;
      if (node.classList && (node.classList.contains('panel-menu-item') || 
          node.classList.contains('pmbtn') || 
          node.classList.contains('panel-code-toggle') ||
          node.classList.contains('canvas-resize-handle'))) return true;
      node = node.parentNode;
    }
    return false;
  };

  InteractiveCanvas.prototype._startPan = function(clientX, clientY) {
    this.isPanning = true;
    this._panState = {
      startX: clientX,
      startY: clientY,
      origOffsetX: this.offsetX,
      origOffsetY: this.offsetY
    };
    this.viewport.classList.add('ic-panning');
  };

  InteractiveCanvas.prototype._onMouseMove = function(e) {
    if (!this.isPanning || !this._panState) return;

    // Dead zone: не начинаем движение пока не пройдём порог
    if (!this._panState._started) {
      var dx = e.clientX - this._panState.startX;
      var dy = e.clientY - this._panState.startY;
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      this._panState._started = true;
    }

    var dx = e.clientX - this._panState.startX;
    var dy = e.clientY - this._panState.startY;

    this.offsetX = this._panState.origOffsetX + dx;
    this.offsetY = this._panState.origOffsetY + dy;

    this._applyTransform();
  };

  InteractiveCanvas.prototype._onMouseUp = function(e) {
    if (this.isPanning) {
      // Предотвращаем middle-click auto-scroll при завершении
      if (e.button === 1) {
        e.preventDefault();
        // Принудительно снимаем фокус с body, чтобы остановить автоскролл
        if (document.activeElement) {
          try { document.activeElement.blur(); } catch(_) {}
        }
      }
      this.isPanning = false;
      this._panState = null;
      this.viewport.classList.remove('ic-panning');
      this._notifyViewportChange();
    }
  };

  InteractiveCanvas.prototype._onKeyDown = function(e) {
    if (e.code === 'Space' || e.key === ' ') {
      // Не активируем pan, если фокус в input/textarea
      var tag = (document.activeElement || {}).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      this._spaceDown = true;
      if (!this.isPanning) this.viewport.classList.add('ic-pan-ready');
    }
  };

  InteractiveCanvas.prototype._onKeyUp = function(e) {
    if (e.code === 'Space' || e.key === ' ') {
      this._spaceDown = false;
      this.viewport.classList.remove('ic-pan-ready');
    }
  };

  InteractiveCanvas.prototype._onContextMenu = function(e) {
    // Предотвращаем контекстное меню при панорамировании средней кнопкой
    if (this.isPanning) e.preventDefault();
  };

  InteractiveCanvas.prototype._onResize = function() {
    // Ничего не делаем — transform остаётся корректным
  };

  /* ═══════════════════════════════════════════════════
     Public API
     ═══════════════════════════════════════════════════ */

  /**
   * Установка масштаба и смещения программно
   */
  InteractiveCanvas.prototype.setView = function(scale, offsetX, offsetY) {
    this.scale = this._clampScale(scale);
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this._applyTransform();
    this._notifyViewportChange();
  };

  /**
   * Сброс масштаба к 1.0 и центрирование
   */
  InteractiveCanvas.prototype.resetView = function() {
    var rect = this.viewport.getBoundingClientRect();
    var surfaceW = this.surface.scrollWidth || rect.width;
    var surfaceH = this.surface.scrollHeight || rect.height;
    this.scale = 1.0;
    this.offsetX = 0;
    this.offsetY = 0;
    this._applyTransform();
    this._notifyViewportChange();
  };

  /**
   * Уместить всё содержимое surface в viewport (fit-to-content).
   * Вычисляет bounding box всех дочерних элементов, подбирает масштаб
   * и центрирует содержимое.
   */
  InteractiveCanvas.prototype.fitToContent = function() {
    var viewportRect = this.viewport.getBoundingClientRect();
    var vw = viewportRect.width;
    var vh = viewportRect.height;
    if (vw === 0 || vh === 0) return;

    // Вычисляем bounding box всех дочерних элементов surface
    var children = this.surface.children;
    if (!children || !children.length) {
      // Нет элементов — просто сбрасываем
      this.resetView();
      return;
    }

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      if (el.nodeType !== 1) continue;
      var left = parseFloat(el.style.left) || 0;
      var top = parseFloat(el.style.top) || 0;
      var w = el.offsetWidth || parseFloat(el.style.width) || 0;
      var h = el.offsetHeight || parseFloat(el.style.height) || 0;
      if (left < minX) minX = left;
      if (top < minY) minY = top;
      if (left + w > maxX) maxX = left + w;
      if (top + h > maxY) maxY = top + h;
    }

    if (minX === Infinity || maxX === -Infinity) {
      this.resetView();
      return;
    }

    var contentW = maxX - minX;
    var contentH = maxY - minY;
    if (contentW === 0 || contentH === 0) {
      this.resetView();
      return;
    }

    // Padding по 40px с каждой стороны
    var padding = 40;
    var availW = vw - padding * 2;
    var availH = vh - padding * 2;

    // Подбираем масштаб чтобы уместить содержимое
    var scaleX = availW / contentW;
    var scaleY = availH / contentH;
    var newScale = Math.min(scaleX, scaleY, 1.0); // не больше 1.0
    newScale = this._clampScale(newScale);

    // Центрируем содержимое в viewport
    this.scale = newScale;
    this.offsetX = (vw - contentW * newScale) / 2 - minX * newScale;
    this.offsetY = (vh - contentH * newScale) / 2 - minY * newScale;

    this._applyTransform();
    this._notifyViewportChange();
  };

  /**
   * Преобразование экранных координат в локальные координаты холста
   * @param {number} clientX — clientX мыши
   * @param {number} clientY — clientY мыши
   * @returns {{x:number, y:number}}
   */
  InteractiveCanvas.prototype.screenToLocal = function(clientX, clientY) {
    var rect = this.viewport.getBoundingClientRect();
    var x = clientX - rect.left;
    var y = clientY - rect.top;
    return {
      x: (x - this.offsetX) / this.scale,
      y: (y - this.offsetY) / this.scale
    };
  };

  /**
   * Подписка на события изменения вьюпорта
   * @param {Function} callback — вызывается с {scale, offsetX, offsetY}
   */
  InteractiveCanvas.prototype.onViewportChange = function(callback) {
    if (typeof callback === 'function') {
      this._viewportChangeCallbacks.push(callback);
    }
  };

  /**
   * Уничтожение слушателей событий
   */
  InteractiveCanvas.prototype.destroy = function() {
    if (this._destroyed) return;
    this._destroyed = true;

    this._listeners.forEach(function(item) {
      item.target.removeEventListener(item.event, item.handler, item.opts || false);
    });
    this._listeners = [];
    this._viewportChangeCallbacks = [];

    this.viewport.classList.remove('ic-viewport', 'ic-panning', 'ic-pan-ready');
    this.surface.classList.remove('ic-surface');
    this.surface.style.transform = '';
    this.surface.style.transformOrigin = '';
    this.surface.style.willChange = '';
  };

  // ── Экспорт в глобальную область ──
  global.InteractiveCanvas = InteractiveCanvas;

})(typeof window !== 'undefined' ? window : this);

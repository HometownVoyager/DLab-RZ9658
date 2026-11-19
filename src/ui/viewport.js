// src/ui/viewport.js
// 面板视口：滚轮缩放 / 中键（或空格+左键）拖拽平移 / 一键适应窗口。
// ------------------------------------------------------------------
// 【为什么用 CSS transform 而不是改 SVG viewBox】
//   整块面板由两层同 viewBox 的 SVG 叠加而成（#panel-svg + #wire-layer），
//   面板上还有 boardControls / chipTray 用 getBoundingClientRect 定位的 HTML 菜单。
//   只改 #panel 的 CSS transform，两层 SVG 一起缩放、一起平移，天然保持对齐；
//   而且 Chromium 的 getScreenCTM() 已经包含祖先的 CSS transform（实测 a/d 随之变化），
//   所以 wireLayer.screenToSvg / hitTest、boardControls.absoluteAnchor、chipTray
//   这些既有的坐标换算**一行都不用改**，缩放后照样点得准。
//
// 【坐标模型】
//   #panel 的布局矩形（未变换）记作 R0，变换为 translate(tx, ty) scale(s)、transform-origin 0 0。
//   面板内局部点 q 的屏幕位置 = R0.left + tx + q.x * s。
//   反解 R0：R0.left = rect.left - tx，R0.width = rect.width / s（rect 是当前变换后的外接矩形）。
//   于是「以光标为中心缩放」只需让光标下的那个局部点缩放前后落在同一屏幕位置。
//
// 【边界钳制】
//   放大后面板比舞台大：允许平移，但至少保留 minVisible 像素可见，不能把面板拖丢。
//   未放大（面板比舞台小）：平移锁死为 0，保持 flex 居中，避免「适应窗口」状态下乱飘。
(function (global) {
  'use strict';

  var DLab = (global.DLab = global.DLab || {});

  /** 缩放上下限：1 = 适应窗口，8 倍足够看清单个插孔 */
  var MIN_SCALE = 1;
  var MAX_SCALE = 8;
  /** 每次点按 +/－ 的倍率 */
  var STEP = 1.35;
  /** 滚轮灵敏度（每像素 deltaY 的指数系数） */
  var WHEEL_SENSITIVITY = 0.0016;
  /** 平移后至少要留在舞台里的像素 */
  var MIN_VISIBLE = 120;

  /** 数值钳制 */
  function clamp(v, lo, hi) {
    if (!isFinite(v)) {
      return lo;
    }
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** 取元素当前的屏幕外接矩形（含 transform） */
  function rectOf(node) {
    return node.getBoundingClientRect();
  }

  // —— Viewport ——
  /**
   * @param {{stageEl:HTMLElement, panelEl:HTMLElement, svgEl?:SVGElement, onChange?:Function}} opts
   */
  function Viewport(opts) {
    opts = opts || {};
    this.stageEl = opts.stageEl;
    this.panelEl = opts.panelEl;
    this.svgEl = opts.svgEl || null;
    if (!this.stageEl || !this.panelEl) {
      throw new Error('Viewport：缺少 stageEl / panelEl');
    }

    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    /**
     * 真正写进 style 的那组变换值（四舍五入后）。
     * 坐标换算一律以它为准，避免「内存里的精确值」与「屏幕上的实际值」不一致。
     */
    this._applied = { scale: 1, tx: 0, ty: 0 };
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null;

    this.started = false;
    this._bound = [];
    this._panning = false;
    this._panStart = null;
    this._spaceDown = false;
    this._controls = null;
    this._labelEl = null;
    /** 交互去抖定时器：静止后移除 will-change，迫使浏览器按当前倍率重新光栅化 */
    this._crispTimer = 0;

    // transform-origin 必须是左上角，坐标模型才成立
    this.panelEl.style.transformOrigin = '0 0';
    this._apply();
    this._buildControls();
  }

  // —— 坐标模型 ——

  /**
   * 取 #panel **未变换**时的布局矩形（不含 CSS transform）。
   *
   * 【为什么要用「已生效值」而不是 this.scale / this.tx】
   *   _apply() 写进 style 的 transform 是**四舍五入后**的
   *   （scale 保留 4 位、translate 保留 2 位），而 this.scale / this.tx 存的是
   *   未舍入的精确值。两者一旦对不齐，「以光标为中心」的锚点就会漂移：
   *   getBoundingClientRect() 反映的是 DOM 上真正生效的变换，
   *   用精确值去反解，得到的基准矩形就会偏。
   *   所以这里统一用 _applied（= 真正写进 style 的那组数）来反解，
   *   保证「读到的矩形」与「屏幕上画的矩形」严格是同一个变换。
   *
   * @returns {{left:number, top:number, width:number, height:number}}
   */
  Viewport.prototype._baseRect = function () {
    var rect = rectOf(this.panelEl);
    var a = this._applied;
    var s = a.scale || 1;
    return {
      left: rect.left - a.tx,
      top: rect.top - a.ty,
      width: rect.width / s,
      height: rect.height / s
    };
  };

  /** 屏幕坐标 → 面板局部坐标（CSS px，未变换） */
  Viewport.prototype._screenToLocal = function (clientX, clientY) {
    var base = this._baseRect();
    var a = this._applied;
    var s = a.scale || 1;
    return {
      x: (clientX - base.left - a.tx) / s,
      y: (clientY - base.top - a.ty) / s
    };
  };

  /** 把 translate 钳制在「面板不会跑丢」的范围内 */
  Viewport.prototype._clampTranslate = function (tx, ty, scale) {
    var base = this._baseRect();
    var stage = rectOf(this.stageEl);
    var s = scale || this.scale;
    var w = base.width * s;
    var h = base.height * s;
    // 面板未变换时相对舞台左上角的位置
    var baseLeft = base.left - stage.left;
    var baseTop = base.top - stage.top;

    // 面板左边缘 = baseLeft + tx，右边缘 = baseLeft + tx + w。
    // 两个方向各要求「至少 MIN_VISIBLE 像素留在舞台里」：
    //   左边缘 ≤ 舞台右沿 - MIN_VISIBLE   →  tx ≤ 舞台宽 - MIN_VISIBLE - baseLeft
    //   右边缘 ≥ MIN_VISIBLE              →  tx ≥ MIN_VISIBLE - baseLeft - w
    //
    // 注意：这里**不能**因为「面板比舞台小」就把平移锁死为 0。
    // 面板比舞台小时（例如 1.4 倍缩放，面板仍比舞台窄），锁死会让
    // 「以光标为中心缩放」失效——光标下的插孔会跑掉，缩放就变成「往中间缩」。
    // 只保留「不许拖丢」这一条约束，锚点计算才有自由度。
    var rangeX = [MIN_VISIBLE - baseLeft - w, stage.width - MIN_VISIBLE - baseLeft];
    var rangeY = [MIN_VISIBLE - baseTop - h, stage.height - MIN_VISIBLE - baseTop];
    if (rangeX[0] > rangeX[1]) {
      rangeX = [0, 0];
    }
    if (rangeY[0] > rangeY[1]) {
      rangeY = [0, 0];
    }
    return {
      tx: clamp(tx, rangeX[0], rangeX[1]),
      ty: clamp(ty, rangeY[0], rangeY[1])
    };
  };

  /**
   * 标记「正在交互」，临时把 #panel 提升为合成层。
   *
   * 【为什么 will-change 不能常驻】
   *   常驻 will-change:transform 会让 #panel 一直留在合成层上，滚轮缩放时
   *   Chromium 直接把「适应窗口尺寸」下光栅化的位图拉伸放大，SVG 文字与插孔
   *   全部发糊（全屏时布局尺寸变大，基础位图分辨率够高，所以看不出糊）。
   *   这里改为：滚轮/平移期间加 .is-interacting（CSS 里对应 will-change:transform），
   *   停止交互 220ms 后移除，图层降级并按当前缩放倍率重新光栅化，恢复清晰。
   */
  Viewport.prototype._markInteracting = function () {
    var self = this;
    if (this._crispTimer) {
      global.clearTimeout(this._crispTimer);
      this._crispTimer = 0;
    }
    if (!this._interacting) {
      this._interacting = true;
      this.panelEl.classList.add('is-interacting');
    }
    this._crispTimer = global.setTimeout(function () {
      self._crispTimer = 0;
      self._interacting = false;
      self.panelEl.classList.remove('is-interacting');
    }, 220);
  };

  /** 写入 DOM 并广播 */
  Viewport.prototype._apply = function () {
    this._markInteracting();
    var s = this.scale;
    // 回到「适应窗口」时必须把平移清零，否则面板会歪在一边
    if (s <= 1.001) {
      this.tx = 0;
      this.ty = 0;
    }
    // 先定稿再写 style：_applied 必须与 style 里的字符串**逐位一致**。
    // 同时把 this.scale / this.tx / this.ty 也归一到同一组数，
    // 这样「内存里的状态」和「屏幕上的画面」永远是同一个变换，
    // 后续任何一次坐标换算都不会因为舍入而漂移。
    var appliedScale = round4(s);
    var appliedTx = round(this.tx);
    var appliedTy = round(this.ty);
    this._applied = { scale: appliedScale, tx: appliedTx, ty: appliedTy };
    this.scale = appliedScale;
    this.tx = appliedTx;
    this.ty = appliedTy;
    this.panelEl.style.transform = s === 1 && this.tx === 0 && this.ty === 0
      ? ''
      : 'translate(' + appliedTx + 'px,' + appliedTy + 'px) scale(' + appliedScale + ')';
    this.panelEl.classList.toggle('is-zoomed', s > 1.001);
    this._syncControls();
    if (this.onChange) {
      this.onChange(this.getTransform());
    }
  };

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  function round4(n) {
    return Math.round(n * 10000) / 10000;
  }

  // —— 对外 API ——

  /** 以屏幕点为中心缩放（factor > 1 放大） */
  Viewport.prototype.zoomAt = function (clientX, clientY, factor) {
    if (!isFinite(factor) || factor <= 0) {
      return this.scale;
    }
    var target = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    if (Math.abs(target - this.scale) < 1e-6) {
      // 已经到极限：仍要保证 translate 合法
      var lim = this._clampTranslate(this.tx, this.ty, this.scale);
      this.tx = lim.tx;
      this.ty = lim.ty;
      this._apply();
      return this.scale;
    }
    var local = this._screenToLocal(clientX, clientY);
    var base = this._baseRect();
    // 让 local 点在缩放后仍落在同一个屏幕位置
    var tx = clientX - base.left - local.x * target;
    var ty = clientY - base.top - local.y * target;
    var clamped = this._clampTranslate(tx, ty, target);
    this.scale = target;
    this.tx = clamped.tx;
    this.ty = clamped.ty;
    this._apply();
    return this.scale;
  };

  /** 设定缩放（锚点默认取舞台中心） */
  Viewport.prototype.setScale = function (scale, anchorClientX, anchorClientY) {
    var target = clamp(Number(scale), MIN_SCALE, MAX_SCALE);
    var stage = rectOf(this.stageEl);
    var ax = typeof anchorClientX === 'number' ? anchorClientX : stage.left + stage.width / 2;
    var ay = typeof anchorClientY === 'number' ? anchorClientY : stage.top + stage.height / 2;
    return this.zoomAt(ax, ay, target / (this.scale || 1));
  };

  /** 以舞台中心为锚点放大一档 */
  Viewport.prototype.zoomIn = function () {
    var stage = rectOf(this.stageEl);
    return this.zoomAt(stage.left + stage.width / 2, stage.top + stage.height / 2, STEP);
  };

  /** 以舞台中心为锚点缩小一档 */
  Viewport.prototype.zoomOut = function () {
    var stage = rectOf(this.stageEl);
    return this.zoomAt(stage.left + stage.width / 2, stage.top + stage.height / 2, 1 / STEP);
  };

  /** 复位：回到「适应窗口」 */
  Viewport.prototype.reset = function () {
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this._apply();
    return this.scale;
  };

  /** 按像素平移 */
  Viewport.prototype.panBy = function (dxPx, dyPx) {
    if (this.scale <= 1.001) {
      return;
    }
    var clamped = this._clampTranslate(this.tx + (Number(dxPx) || 0), this.ty + (Number(dyPx) || 0), this.scale);
    this.tx = clamped.tx;
    this.ty = clamped.ty;
    this._apply();
  };

  Viewport.prototype.getScale = function () {
    return this.scale;
  };

  Viewport.prototype.getTransform = function () {
    return { scale: this.scale, tx: this.tx, ty: this.ty };
  };

  Viewport.prototype.isZoomed = function () {
    return this.scale > 1.001;
  };

  /** 窗口尺寸变化后重新钳制（由 start() 的 resize 监听调用） */
  Viewport.prototype.handleResize = function () {
    var clamped = this._clampTranslate(this.tx, this.ty, this.scale);
    this.tx = clamped.tx;
    this.ty = clamped.ty;
    this._apply();
  };

  // —— 缩放控件（舞台右下角） ——

  Viewport.prototype._buildControls = function () {
    var self = this;
    var box = document.createElement('div');
    box.className = 'viewport-controls';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', '面板缩放');

    function btn(text, title, act) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'vp-btn';
      b.textContent = text;
      b.title = title;
      b.setAttribute('data-act', act);
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        if (act === 'out') {
          self.zoomOut();
        } else if (act === 'in') {
          self.zoomIn();
        } else if (act === 'reset') {
          self.reset();
        }
      });
      return b;
    }

    var label = document.createElement('span');
    label.className = 'vp-label';
    label.setAttribute('data-act', 'label');
    label.textContent = '100%';

    box.appendChild(btn('\u2212', '缩小一档（滚轮向下同效）', 'out'));
    box.appendChild(label);
    box.appendChild(btn('+', '放大一档（滚轮向上同效）', 'in'));
    box.appendChild(btn('适应窗口', '复位到适应窗口（Ctrl+0）', 'reset'));

    this.stageEl.appendChild(box);
    this._controls = box;
    this._labelEl = label;
    this._syncControls();
  };

  Viewport.prototype._syncControls = function () {
    if (this._labelEl) {
      this._labelEl.textContent = Math.round(this.scale * 100) + '%';
    }
    if (this._controls) {
      this._controls.classList.toggle('is-zoomed', this.isZoomed());
    }
  };

  // —— 事件绑定 ——

  Viewport.prototype._on = function (target, type, fn, options) {
    target.addEventListener(type, fn, options || false);
    this._bound.push({ target: target, type: type, fn: fn, options: options || false });
  };

  Viewport.prototype.start = function () {
    if (this.started) {
      return;
    }
    this.started = true;
    var self = this;
    var stage = this.stageEl;

    // 1. 滚轮缩放（必须以光标为中心；阻止页面滚动）
    this._on(stage, 'wheel', function (e) {
      // 只接管落在舞台内的滚轮；工具栏/时序条上的滚轮不抢
      if (e.target && e.target.closest && e.target.closest('#toolbar, #timeline, #assistant')) {
        return;
      }
      e.preventDefault();
      var unit = 1;
      if (e.deltaMode === 1) {
        unit = 16;          // 行
      } else if (e.deltaMode === 2) {
        unit = 400;         // 页
      }
      var dy = clamp(e.deltaY * unit, -240, 240);
      var factor = Math.exp(-dy * WHEEL_SENSITIVITY);
      self.zoomAt(e.clientX, e.clientY, factor);
    }, { passive: false });

    // 2. 中键拖拽 / 空格+左键拖拽 = 平移
    this._on(stage, 'mousedown', function (e) {
      var isMiddle = e.button === 1;
      var isSpaceLeft = e.button === 0 && self._spaceDown;
      if (!isMiddle && !isSpaceLeft) {
        return;
      }
      if (self.scale <= 1.001) {
        return;
      }
      e.preventDefault();
      self._panning = true;
      self._panStart = { x: e.clientX, y: e.clientY, tx: self.tx, ty: self.ty };
      stage.classList.add('is-panning');
    });

    this._on(global, 'mousemove', function (e) {
      if (!self._panning || !self._panStart) {
        return;
      }
      var dx = e.clientX - self._panStart.x;
      var dy = e.clientY - self._panStart.y;
      var clamped = self._clampTranslate(self._panStart.tx + dx, self._panStart.ty + dy, self.scale);
      self.tx = clamped.tx;
      self.ty = clamped.ty;
      self._apply();
    });

    function endPan() {
      if (!self._panning) {
        return;
      }
      self._panning = false;
      self._panStart = null;
      stage.classList.remove('is-panning');
    }

    this._on(global, 'mouseup', endPan);
    this._on(global, 'blur', endPan);
    // 中键默认行为（Windows 上是自动滚动）要拦掉
    this._on(stage, 'auxclick', function (e) {
      if (e.button === 1) {
        e.preventDefault();
      }
    });

    // 3. 空格按住 = 平移模式；Ctrl+0 复位
    this._on(document, 'keydown', function (e) {
      var tag = e.target && e.target.tagName ? String(e.target.tagName).toUpperCase() : '';
      var editable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        (e.target && e.target.isContentEditable === true);
      if (editable) {
        return;
      }
      if (e.code === 'Space' && !e.repeat) {
        self._spaceDown = true;
        stage.classList.add('is-pan-ready');
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key) === '0') {
        e.preventDefault();
        self.reset();
      }
      // 键盘缩放：Ctrl+= / Ctrl+-（与浏览器整页缩放区分，这里只缩面板）
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        self.zoomIn();
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        self.zoomOut();
      }
    });

    this._on(document, 'keyup', function (e) {
      if (e.code === 'Space') {
        self._spaceDown = false;
        stage.classList.remove('is-pan-ready');
      }
    });

    // 4. 窗口尺寸变化后重新钳制（app.js 的 fitPanel 改过面板尺寸，钳制范围随之变化）
    this._on(global, 'resize', function () {
      if (self._resizeTimer) {
        global.clearTimeout(self._resizeTimer);
      }
      self._resizeTimer = global.setTimeout(function () {
        self._resizeTimer = 0;
        self.handleResize();
      }, 130);
    });

    this._apply();
  };

  Viewport.prototype.stop = function () {
    this.started = false;
    for (var i = 0; i < this._bound.length; i++) {
      var b = this._bound[i];
      b.target.removeEventListener(b.type, b.fn, b.options);
    }
    this._bound.length = 0;
    if (this._crispTimer) {
      global.clearTimeout(this._crispTimer);
      this._crispTimer = 0;
    }
    this._interacting = false;
    this.panelEl.classList.remove('is-interacting');
    if (this._controls && this._controls.parentNode) {
      this._controls.parentNode.removeChild(this._controls);
    }
    this._controls = null;
    this._labelEl = null;
  };

  Viewport.MIN_SCALE = MIN_SCALE;
  Viewport.MAX_SCALE = MAX_SCALE;
  Viewport.STEP = STEP;

  DLab.Viewport = Viewport;
})(typeof globalThis !== 'undefined' ? globalThis : this);

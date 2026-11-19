// src/ui/boardControls.js
// 板载机械控件交互层：逻辑电平输出的 16 只自锁按键（5K1~5K16）与单脉冲输出的 6 只轻触按键（6K1~6K6）。
// ------------------------------------------------------------------
// 为什么需要这一层：
//   面板 SVG 只画了按键的「静态外观」（<use href="#lock-switch"> / <use href="#tact-btn">），
//   它们本身不接收事件、也没有和引擎建立任何联系。本模块在飞线覆盖层里
//   为每只按键补一个透明命中区，点击后调用 engine.setSwitch() / engine.pressPulse()，
//   并把「按下 / 弹起」的机械位移叠加回面板上的 <use> 实例，做到「按下去有手感」。
//
// 职责边界：
//   - 只读面板 SVG 的 <use> 实例坐标，不新增面板布局、不改模板定义；
//   - 命中区画在 #wire-layer 覆盖层里，与插孔命中区同坐标系，零换算；
//   - 电气状态一律交给 engine，本模块只负责「点击 → 调用引擎」与「引擎状态 → 机械位移」。
(function (global) {
  'use strict';

  var DLab = (global.DLab = global.DLab || {});
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';

  /** 自锁按键的命中矩形（相对 <use> 锚点，覆盖键帽 + 上方金属球） */
  var LOCK_HIT = { x: -18, y: -24, w: 36, h: 46 };
  /** 轻触按键的命中矩形（相对 <use> 锚点，覆盖整条键帽） */
  var TACT_HIT = { x: -21, y: -9, w: 42, h: 18 };

  /** 自锁按键「锁存」时键帽下沉量（px，viewBox 单位），模拟真实自锁开关按下去不弹回 */
  var LOCK_PRESS_DY = 1.8;
  /** 轻触按键按下瞬间的下沉量 */
  var TACT_PRESS_DY = 1.2;
  /** 轻触按键回弹延时（ms） */
  var TACT_RELEASE_MS = 130;

  var SW_COUNT = 16;
  var PULSE_COUNT = 6;

  /** 创建 SVG 元素 */
  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) {
          node.setAttribute(k, String(attrs[k]));
        }
      }
    }
    return node;
  }

  /** 取 <use> 的引用目标（去掉 # 前缀） */
  function useRef(node) {
    var href = node.getAttribute('href') || node.getAttributeNS(XLINK_NS, 'href') || '';
    return href.replace(/^#/, '');
  }

  /** 读数值属性，缺失返回 0 */
  function numAttr(node, name) {
    var v = parseFloat(node.getAttribute(name));
    return isNaN(v) ? 0 : v;
  }

  /**
   * 计算 <use> 实例锚点在面板 viewBox 坐标系里的绝对位置。
   *
   * 关键点：<use> 的 x / y 属性等价于「在自身用户空间里再平移一次」，
   * getScreenCTM() 返回的是该用户空间的矩阵，并不包含 x / y 的平移，
   * 所以必须把 (x, y) 当成一个点，用矩阵变换过去，才是真实落点。
   *
   * @param {SVGSVGElement} panelSvg 面板根节点
   * @param {SVGUseElement} node
   * @returns {{x:number, y:number}}
   */
  function absoluteAnchor(panelSvg, node) {
    var ux = numAttr(node, 'x');
    var uy = numAttr(node, 'y');

    var rootCTM = panelSvg.getScreenCTM && panelSvg.getScreenCTM();
    var ownCTM = node.getScreenCTM && node.getScreenCTM();
    if (rootCTM && ownCTM && rootCTM.inverse) {
      var m = rootCTM.inverse().multiply(ownCTM);
      var p = panelSvg.createSVGPoint();
      p.x = ux;
      p.y = uy;
      var q = p.matrixTransform(m);
      return { x: q.x, y: q.y };
    }

    // 退化路径：手工累加祖先 translate 与自身 x / y（面板中只有 translate，足够用）
    var x = ux;
    var y = uy;
    var cur = node;
    while (cur && cur.nodeType === 1) {
      if (cur !== node) {
        var cx = parseFloat(cur.getAttribute && cur.getAttribute('x'));
        var cy = parseFloat(cur.getAttribute && cur.getAttribute('y'));
        if (!isNaN(cx)) x += cx;
        if (!isNaN(cy)) y += cy;
      }
      var tr = cur.getAttribute && cur.getAttribute('transform');
      if (tr) {
        var mm = /translate\(\s*(-?[\d.]+)[\s,]*(-?[\d.]+)?\s*\)/.exec(tr);
        if (mm) {
          x += parseFloat(mm[1]);
          if (mm[2] !== undefined) y += parseFloat(mm[2]);
        }
      }
      if (cur.tagName && cur.tagName.toLowerCase() === 'svg') {
        break;
      }
      cur = cur.parentNode;
    }
    return { x: x, y: y };
  }

  // —— BoardControls ——
  /**
   * @param {{engine:Object, panelSvg:SVGElement, wireLayer:Object, geometry:Object,
   *          onState?:Function, hud?:Object}} opts
   */
  function BoardControls(opts) {
    opts = opts || {};
    this.engine = opts.engine;
    this.panelSvg = opts.panelSvg;
    this.wireLayer = opts.wireLayer || null;
    this.geometry = opts.geometry || (DLab.geometry || { JACKS: {} });
    this.hud = opts.hud || null;
    this.onState = typeof opts.onState === 'function' ? opts.onState : null;

    if (!this.engine) {
      throw new Error('BoardControls：缺少 engine');
    }
    if (!this.panelSvg) {
      throw new Error('BoardControls：缺少面板 SVG 根节点');
    }

    /** '5K1' -> { use, hit } */
    this.switchNodes = Object.create(null);
    /** '6K1' -> { use, hit } */
    this.pulseNodes = Object.create(null);

    this._host = null;        // 覆盖层里的命中区容器 <g>
    this._timers = Object.create(null);
    this._bound = [];
    this._lastSwitches = Object.create(null);
    this._disabled = false;

    this._collect();
    this._buildHits();
    this._bindEvents();
    this.syncVisuals();
  }

  /** 扫描面板，建立「丝印编号 → <use> 实例」索引 */
  BoardControls.prototype._collect = function () {
    var uses = this.panelSvg.querySelectorAll('use');
    var locks = [];
    var tacts = [];
    var i;

    for (i = 0; i < uses.length; i++) {
      var u = uses[i];
      if (BoardControls._inDefs(u)) {
        continue;
      }
      var ref = useRef(u);
      if (ref === 'lock-switch') {
        locks.push(u);
      } else if (ref === 'tact-btn') {
        tacts.push(u);
      }
    }

    // 面板上每一类控件都排在同一行，按 x 从左到右编号即为丝印顺序
    var self = this;
    var lockPos = locks.map(function (u) {
      var a = absoluteAnchor(self.panelSvg, u);
      return { use: u, x: a.x, y: a.y };
    });
    lockPos.sort(function (a, b) { return a.x - b.x; });
    for (i = 0; i < lockPos.length && i < SW_COUNT; i++) {
      this.switchNodes['5K' + (i + 1)] = { use: lockPos[i].use, hit: null, x: lockPos[i].x, y: lockPos[i].y };
    }

    var tactPos = tacts.map(function (u) {
      var a = absoluteAnchor(self.panelSvg, u);
      return { use: u, x: a.x, y: a.y };
    });
    tactPos.sort(function (a, b) { return a.x - b.x; });
    for (i = 0; i < tactPos.length && i < PULSE_COUNT; i++) {
      this.pulseNodes['6K' + (i + 1)] = { use: tactPos[i].use, hit: null, x: tactPos[i].x, y: tactPos[i].y };
    }

    this.collected = { locks: lockPos.length, tacts: tactPos.length };
  };

  /** 判断元素是否在 <defs> 内（模板定义，不是实例） */
  BoardControls._inDefs = function (node) {
    var cur = node.parentNode;
    while (cur && cur.nodeType === 1) {
      var tag = cur.tagName ? cur.tagName.toLowerCase() : '';
      if (tag === 'defs') {
        return true;
      }
      if (tag === 'svg') {
        return false;
      }
      cur = cur.parentNode;
    }
    return false;
  };

  /** 在飞线覆盖层里建命中区（与插孔命中区同坐标系，无需换算） */
  BoardControls.prototype._buildHits = function () {
    var svg = this.wireLayer && this.wireLayer.svg;
    if (!svg) {
      return;
    }
    this._host = svgEl('g', { id: 'board-controls', 'pointer-events': 'none' });

    var key;
    for (key in this.switchNodes) {
      if (!Object.prototype.hasOwnProperty.call(this.switchNodes, key)) {
        continue;
      }
      var sw = this.switchNodes[key];
      var rect = svgEl('rect', {
        x: sw.x + LOCK_HIT.x,
        y: sw.y + LOCK_HIT.y,
        width: LOCK_HIT.w,
        height: LOCK_HIT.h,
        rx: 3,
        'class': 'board-control board-control-switch',
        'data-switch': key,
        'pointer-events': 'all',
        role: 'button',
        'aria-pressed': 'false',
        'aria-label': '逻辑电平开关 ' + key,
        tabindex: '0'
      });
      sw.hit = rect;
      this._host.appendChild(rect);
    }

    for (key in this.pulseNodes) {
      if (!Object.prototype.hasOwnProperty.call(this.pulseNodes, key)) {
        continue;
      }
      var pb = this.pulseNodes[key];
      var r2 = svgEl('rect', {
        x: pb.x + TACT_HIT.x,
        y: pb.y + TACT_HIT.y,
        width: TACT_HIT.w,
        height: TACT_HIT.h,
        rx: 3,
        'class': 'board-control board-control-pulse',
        'data-pulse': key,
        'pointer-events': 'all',
        role: 'button',
        'aria-label': '单脉冲按键 ' + key,
        tabindex: '0'
      });
      pb.hit = r2;
      this._host.appendChild(r2);
    }

    svg.appendChild(this._host);
  };

  /** 绑定点击与键盘事件 */
  BoardControls.prototype._bindEvents = function () {
    if (!this._host) {
      return;
    }
    var self = this;

    var onClick = function (e) {
      var swKey = e.target && e.target.getAttribute ? e.target.getAttribute('data-switch') : null;
      var pKey = e.target && e.target.getAttribute ? e.target.getAttribute('data-pulse') : null;
      if (!swKey && !pKey) {
        return;
      }
      // 阻止冒泡到飞线层的「空白处取消选中」逻辑
      e.preventDefault();
      e.stopPropagation();
      if (swKey) {
        self.toggleSwitch(swKey);
      } else {
        self.pressPulse(pKey);
      }
    };

    var onKeyDown = function (e) {
      var key = e.key || '';
      if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') {
        return;
      }
      var swKey = e.target && e.target.getAttribute ? e.target.getAttribute('data-switch') : null;
      var pKey = e.target && e.target.getAttribute ? e.target.getAttribute('data-pulse') : null;
      if (!swKey && !pKey) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (swKey) {
        self.toggleSwitch(swKey);
      } else {
        self.pressPulse(pKey);
      }
    };

    this._host.addEventListener('click', onClick);
    this._host.addEventListener('keydown', onKeyDown);
    this._bound.push({ target: this._host, type: 'click', fn: onClick });
    this._bound.push({ target: this._host, type: 'keydown', fn: onKeyDown });
  };

  /** 从 '5K12' 里取出编号 12 */
  function switchNumber(key) {
    var m = /^5K(\d+)$/.exec(String(key || ''));
    return m ? parseInt(m[1], 10) : 0;
  }

  /** 从 '6K3' 里取出编号 3 */
  function pulseNumber(key) {
    var m = /^6K(\d+)$/.exec(String(key || ''));
    return m ? parseInt(m[1], 10) : 0;
  }

  /**
   * 翻转一只自锁开关（0 ↔ 1）。
   * @param {string} key 如 '5K1'
   * @returns {number} 翻转后的电平（0 | 1），非法编号返回 -1
   */
  BoardControls.prototype.toggleSwitch = function (key) {
    var n = switchNumber(key);
    if (n < 1 || n > SW_COUNT) {
      return -1;
    }
    var current = this.engine.getSwitch(n);
    var next = current === 1 ? 0 : 1;
    this.engine.setSwitch(n, next);
    this._afterChange();
    this._status('逻辑电平开关 ' + key + ' → ' + (next === 1 ? '高电平 1' : '低电平 0'), 'info');
    return next;
  };

  /** 直接设定一只开关的电平 */
  BoardControls.prototype.setSwitch = function (key, level) {
    var n = switchNumber(key);
    if (n < 1 || n > SW_COUNT) {
      return false;
    }
    this.engine.setSwitch(n, level === 1 || level === '1' || level === true ? 1 : 0);
    this._afterChange();
    return true;
  };

  /**
   * 按下一只单脉冲按键，产生一次正脉冲。
   * @param {string} key 如 '6K1'
   * @returns {boolean} 本次是否真的产生了新脉冲
   */
  BoardControls.prototype.pressPulse = function (key) {
    var n = pulseNumber(key);
    if (n < 1 || n > PULSE_COUNT) {
      return false;
    }
    var fired = this.engine.pressPulse(n);
    this._afterChange();
    this._status('单脉冲 ' + key + (fired ? ' 已触发' : ' 处于防抖窗口内，本次忽略'), fired ? 'info' : 'warn');
    return fired;
  };

  /** 点击后：推进一次仿真并立刻刷新面板视觉，不等下一帧 */
  BoardControls.prototype._afterChange = function () {
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var state = null;
    try {
      state = this.engine.step(now);
    } catch (err) {
      state = null;
    }
    if (!state) {
      try {
        state = this.engine.getState();
      } catch (err2) {
        state = null;
      }
    }
    this.syncVisuals();
    if (state && this.onState) {
      this.onState(state);
    }
  };

  /**
   * 把引擎的开关状态映射成按键的机械位移：
   *   自锁开关锁存为 1 时键帽保持下沉（真实自锁按键按下去不会弹回）；
   *   轻触按键只在点击瞬间短暂下沉，随后回弹。
   */
  BoardControls.prototype.syncVisuals = function () {
    var key;
    for (key in this.switchNodes) {
      if (!Object.prototype.hasOwnProperty.call(this.switchNodes, key)) {
        continue;
      }
      var n = switchNumber(key);
      var on = false;
      try {
        on = this.engine.getSwitch(n) === 1;
      } catch (err) {
        on = false;
      }
      var entry = this.switchNodes[key];
      var want = on ? 'translate(0,' + LOCK_PRESS_DY + ')' : '';
      if ((entry.use.getAttribute('transform') || '') !== want) {
        if (want) {
          entry.use.setAttribute('transform', want);
        } else {
          entry.use.removeAttribute('transform');
        }
      }
      if (entry.hit) {
        entry.hit.setAttribute('aria-pressed', on ? 'true' : 'false');
        entry.hit.classList.toggle('is-on', on);
      }
      this._lastSwitches[key] = on;
    }
  };

  /** 轻触按键的按下/回弹动效 */
  BoardControls.prototype._flashTact = function (key) {
    var entry = this.pulseNodes[key];
    if (!entry) {
      return;
    }
    var self = this;
    entry.use.setAttribute('transform', 'translate(0,' + TACT_PRESS_DY + ')');
    if (this._timers[key]) {
      clearTimeout(this._timers[key]);
    }
    this._timers[key] = setTimeout(function () {
      self._timers[key] = 0;
      if (entry.use && entry.use.parentNode) {
        entry.use.removeAttribute('transform');
      }
    }, TACT_RELEASE_MS);
  };

  /** 面板整体失效（如断电）时可屏蔽点击 */
  BoardControls.prototype.setEnabled = function (on) {
    this._disabled = !on;
    if (this._host) {
      this._host.style.display = this._disabled ? 'none' : '';
    }
  };

  BoardControls.prototype._status = function (text, level) {
    if (this.hud && this.hud.setStatus) {
      this.hud.setStatus(text, level || 'info');
    }
  };

  /** 供自测/调试：当前索引到的控件数量与坐标 */
  BoardControls.prototype.getSnapshot = function () {
    var out = { switches: {}, pulses: {} };
    var key;
    for (key in this.switchNodes) {
      if (Object.prototype.hasOwnProperty.call(this.switchNodes, key)) {
        out.switches[key] = { x: this.switchNodes[key].x, y: this.switchNodes[key].y };
      }
    }
    for (key in this.pulseNodes) {
      if (Object.prototype.hasOwnProperty.call(this.pulseNodes, key)) {
        out.pulses[key] = { x: this.pulseNodes[key].x, y: this.pulseNodes[key].y };
      }
    }
    return out;
  };

  /** 解绑事件、清理定时器 */
  BoardControls.prototype.destroy = function () {
    for (var i = 0; i < this._bound.length; i++) {
      var b = this._bound[i];
      b.target.removeEventListener(b.type, b.fn);
    }
    this._bound.length = 0;
    for (var k in this._timers) {
      if (Object.prototype.hasOwnProperty.call(this._timers, k) && this._timers[k]) {
        clearTimeout(this._timers[k]);
      }
    }
    this._timers = Object.create(null);
    if (this._host && this._host.parentNode) {
      this._host.parentNode.removeChild(this._host);
    }
    this._host = null;
  };

  BoardControls.LOCK_PRESS_DY = LOCK_PRESS_DY;
  BoardControls.absoluteAnchor = absoluteAnchor;

  DLab.BoardControls = BoardControls;
})(typeof globalThis !== 'undefined' ? globalThis : this);

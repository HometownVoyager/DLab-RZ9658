// src/boardView.js
// 面板视图层：把引擎算出的电平状态映射成面板 SVG 上的视觉变化。
// ------------------------------------------------------------------
// 职责边界：
//   - 只读 state，不改任何电气数据；
//   - 只操作已注入的面板 SVG（#panel-svg）内部节点，不新增布局、不改变外观坐标；
//   - 发光二极管（LED）通过切换 <use> 的 href 在「灭 / 亮」两个既有模板间切换，
//     位置与尺寸完全沿用第一阶段产出的模板，保证零位移；
//   - 数码管通过叠加笔段多边形实现任意字形，熄灭底纹仍是模板自带的暗色笔段。
(function (global) {
  'use strict';

  var DLab = (global.DLab = global.DLab || {});
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';

  // —— 七段数码管笔段几何 ——
  // 数值完全取自 SVG.SVG 中 #seg7-off / #seg7-zero 模板，保证叠加后与原图逐像素重合。
  var SEG_POLYGONS = {
    a: '-11,-27 11,-27 8,-23 -8,-23',
    b: '12,-26 15,-23 13,-4 10,-2 9,-5',
    c: '10,2 13,4 11,23 8,25 7,21',
    d: '-8,22 8,22 10,26 -11,26',
    e: '-13,4 -10,2 -9,21 -12,25 -15,23',
    f: '-11,-23 -8,-22 -9,-4 -12,-2 -14,-5',
    g: '-9,-2 9,-2 11,0 9,2 -9,2 -11,0'
  };

  // 小数点位置（取自模板 <circle cx="16" cy="24" r="2.4">）
  var DP_CX = 16;
  var DP_CY = 24;
  var DP_R = 2.4;

  // 点亮笔段的配色，取自 #seg7-zero 模板
  var SEG_LIT_FILL = '#ff2a2a';
  var SEG_LIT_GLOW = 'url(#glow-red)';
  var SEG_ORDER = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  /** 创建 SVG 元素并设置属性 */
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

  /**
   * 规范化 <use> 的引用目标。
   * SVG 的 href 必须是「同文档片段引用」，即必须以 # 开头；
   * 写成 href="led-off"（少了 #）浏览器会当成外部资源去解析，结果是元素彻底不渲染。
   * 这里统一补上 #，保证无论调用方传 'led-off' 还是 '#led-off' 都能正确工作。
   * @param {string} ref
   * @returns {string}
   */
  function normalizeRef(ref) {
    if (typeof ref !== 'string' || ref.length === 0) {
      return ref;
    }
    return ref.charAt(0) === '#' ? ref : '#' + ref;
  }

  /** 设置 <use> 的引用目标（同时兼容 href 与 xlink:href） */
  function setUseRef(useNode, ref) {
    var target = normalizeRef(ref);
    if (useNode.getAttribute('href') !== target) {
      useNode.setAttribute('href', target);
    }
    // 老浏览器回退：仅在原本就存在 xlink:href 时同步，避免产生多余属性
    if (useNode.hasAttributeNS(XLINK_NS, 'href')) {
      useNode.setAttributeNS(XLINK_NS, 'xlink:href', target);
    }
  }

  /** 取 <use> 当前引用的模板 id（去掉 # 前缀） */
  function getUseRef(useNode) {
    var href = useNode.getAttribute('href') || useNode.getAttributeNS(XLINK_NS, 'href') || '';
    return href.replace(/^#/, '');
  }

  /** 从元素的祖先链里找出所属的 <g>（用于找同级丝印文本） */
  function findJackLabelGroup(node) {
    var cur = node;
    for (var i = 0; i < 4 && cur; i++) {
      if (cur.nodeType === 1 && cur.tagName.toLowerCase() === 'g') {
        return cur;
      }
      cur = cur.parentNode;
    }
    return null;
  }

  /**
   * 在父 <g> 里找形如 4L1 / 5L16 / 6L3 的丝印标签，用于把 <use> 与状态键对应起来。
   * @returns {string|null}
   */
  function findLedLabel(useNode) {
    var group = findJackLabelGroup(useNode);
    if (!group) {
      return null;
    }
    var texts = group.querySelectorAll('text');
    for (var i = 0; i < texts.length; i++) {
      var t = (texts[i].textContent || '').trim();
      if (/^[0-9]+L[0-9]+$/.test(t)) {
        return t;
      }
    }
    return null;
  }

  // —— BoardView ——
  /**
   * @param {SVGElement} panelSvgEl 已注入的面板 SVG 根节点
   * @param {Object} geometry DLab.geometry
   */
  function BoardView(panelSvgEl, geometry) {
    if (!panelSvgEl) {
      throw new Error('BoardView：缺少面板 SVG 根节点');
    }
    this.svg = panelSvgEl;
    this.geometry = geometry || (DLab.geometry || { JACKS: {} });

    this.ledNodes = Object.create(null);   // 状态键 -> <use>（4L1…5L16… 与 probe:* / dds:* / scope:RUN）
    this.ledTapList = [];                  // [{ key, node, x, y }] 全部 LED 实例（供点击试点亮层建命中区）
    this.segPosList = [];                  // [{ segId, x, y }] 全部数码管中心（供点击段测试）
    this._litRef = Object.create(null);    // 状态键 -> 点亮时应使用的模板（红色 / 琥珀色）
    this.segGroups = Object.create(null);  // 'seg1' -> { host: <g>, lit: <g> }
    this._lastLed = Object.create(null);
    this._lastSeg = Object.create(null);
    // 点击试点亮期间的「挂起」名单：被挂起的 LED / 数码管不受 update() 刷写，
    // 否则时序循环每帧都会调 applyState → update()，试点亮会在一帧内（<16ms）被打回原形。
    this._tapHoldLeds = Object.create(null);
    this._tapHoldSegs = Object.create(null);

    this._collectLeds();
    this._collectSegments();
  }

  /**
   * 按绝对坐标把「非编号灯位」归入状态键。
   * 面板上逻辑笔（1L2/1L3/1L4）、信号源（1L1/1L2/1L3）的丝印编号重复，
   * 不能按文字匹配，只能按各模块在面板上的绝对位置区分（SVG.SVG 冻结，坐标恒定）。
   * 判定矩形（viewBox 1800×1380）：
   *   - 逻辑笔三灯：x∈[40,360], y∈[40,110]，从左到右 = 高电平/低电平/高阻；
   *   - 信号源三灯：x∈[860,990], y∈[655,712]，从左到右 = 频率/幅度/脉冲；
   *   - 示波器 RUN：x∈[860,990], y∈[540,630]。
   */
  BoardView._classifySpecialLed = function (x, y) {
    if (x >= 40 && x <= 360 && y >= 40 && y <= 110) return 'probe';
    if (x >= 860 && x <= 990 && y >= 655 && y <= 712) return 'dds';
    if (x >= 860 && x <= 990 && y >= 540 && y <= 630) return 'scope';
    return null;
  };

  /** 扫描面板，建立「状态键 → LED 节点」索引 */
  BoardView.prototype._collectLeds = function () {
    var uses = this.svg.querySelectorAll('use');
    var probe = [];
    var dds = [];
    var scope = [];
    for (var i = 0; i < uses.length; i++) {
      var u = uses[i];
      if (BoardView._inDefs(u)) {
        continue;
      }
      var ref = getUseRef(u);
      // 只关心 LED 类模板
      if (ref !== 'led-off' && ref !== 'led-red' && ref !== 'led-amber') {
        continue;
      }
      var label = findLedLabel(u);
      var pos = BoardView._absoluteXY(u);
      var special = BoardView._classifySpecialLed(pos.x, pos.y);
      if (special === 'probe') {
        probe.push({ node: u, x: pos.x, y: pos.y });
      } else if (special === 'dds') {
        dds.push({ node: u, x: pos.x, y: pos.y });
      } else if (special === 'scope') {
        scope.push({ node: u, x: pos.x, y: pos.y });
      } else if (label && !this.ledNodes[label]) {
        this.ledNodes[label] = u;
        this.ledTapList.push({ key: label, node: u, x: pos.x, y: pos.y });
      }
    }

    // 逻辑笔：从左到右 = 高电平 / 低电平 / 高阻
    probe.sort(function (a, b) { return a.x - b.x; });
    var probeKeys = ['probe:H', 'probe:L', 'probe:Z'];
    for (i = 0; i < probe.length && i < 3; i++) {
      this.ledNodes[probeKeys[i]] = probe[i].node;
      this.ledTapList.push({ key: probeKeys[i], node: probe[i].node, x: probe[i].x, y: probe[i].y });
    }
    // 信号源：从左到右 = 频率 / 幅度 / 脉冲
    dds.sort(function (a, b) { return a.x - b.x; });
    var ddsKeys = ['dds:FREQ', 'dds:AMP', 'dds:PULSE'];
    for (i = 0; i < dds.length && i < 3; i++) {
      this.ledNodes[ddsKeys[i]] = dds[i].node;
      this.ledTapList.push({ key: ddsKeys[i], node: dds[i].node, x: dds[i].x, y: dds[i].y });
    }
    // 示波器 RUN 灯
    if (scope.length) {
      this.ledNodes['scope:RUN'] = scope[0].node;
      this.ledTapList.push({ key: 'scope:RUN', node: scope[0].node, x: scope[0].x, y: scope[0].y });
    }

    // 点亮模板：原静态为琥珀色（逻辑笔高阻灯）的保持琥珀色，其余用红色
    for (var key in this.ledNodes) {
      if (Object.prototype.hasOwnProperty.call(this.ledNodes, key)) {
        var initRef = getUseRef(this.ledNodes[key]);
        this._litRef[key] = (initRef === 'led-amber') ? 'led-amber' : 'led-red';
      }
    }
  };

  /**
   * 扫描面板，建立「seg1..seg8 → 数码管宿主」索引。
   * 面板上 8 只数码管均为 <use href="#seg7-xxx" x=".." y="..">，
   * 按 (y, x) 阅读顺序排序即对应 seg1..seg8。
   */
  BoardView.prototype._collectSegments = function () {
    var uses = this.svg.querySelectorAll('use');
    var list = [];
    for (var i = 0; i < uses.length; i++) {
      var u = uses[i];
      // 必须排除 <defs> 里的模板内部引用：
      // 例如 #seg7-zero 与 #seg7-half 模板内部各有一个 <use href="#seg7-off">，
      // 若不去掉，会被误当成两只额外的数码管。
      if (BoardView._inDefs(u)) {
        continue;
      }
      if (getUseRef(u).indexOf('seg7-') !== 0) {
        continue;
      }
      list.push(u);
    }

    // 读取绝对坐标用于排序（getBBox 在隐藏元素上不可靠，改用累积变换）
    var withPos = list.map(function (u, idx) {
      var pt = BoardView._absoluteXY(u);
      return { node: u, x: pt.x, y: pt.y, idx: idx };
    });

    withPos.sort(function (a, b) {
      // 先按行（y 容差 8px 视为同一行），再按 x
      if (Math.abs(a.y - b.y) > 8) {
        return a.y - b.y;
      }
      return a.x - b.x;
    });

    for (var k = 0; k < withPos.length; k++) {
      var node = withPos[k].node;
      // 保证基底引用统一为 seg7-off（全灭底色），彻底杜绝静态残影
      setUseRef(node, 'seg7-off');
      // 宿主 <g>：承载笔段叠加层。
      // 注意：这里用的是「绝对坐标」，因此宿主必须挂在 SVG 根节点下，
      // 不能挂在原 <use> 的父级 <g> 里（那样会叠加父级的 translate 造成双重偏移）。
      var host = svgEl('g', {
        transform: 'translate(' + withPos[k].x + ',' + withPos[k].y + ')'
      });
      var lit = svgEl('g', {
        transform: 'skewX(-7)',
        fill: SEG_LIT_FILL,
        filter: SEG_LIT_GLOW
      });
      host.appendChild(lit);
      // 追加到 SVG 根节点末尾，保证叠加层压在原图之上
      this.svg.appendChild(host);
      var segId = 'seg' + (k + 1);
      this.segGroups[segId] = { host: host, lit: lit, base: node };
      this.segPosList.push({ segId: segId, x: withPos[k].x, y: withPos[k].y });
      this._lastSeg[segId] = '';
    }
  };

  /**
   * 判断元素是否位于 <defs> 内（模板定义，不是实际显示的实例）。
   * @param {Element} node
   * @returns {boolean}
   */
  BoardView._inDefs = function (node) {
    var cur = node.parentNode;
    while (cur && cur.nodeType === 1) {
      if (cur.tagName && cur.tagName.toLowerCase() === 'defs') {
        return true;
      }
      if (cur.tagName && cur.tagName.toLowerCase() === 'svg') {
        return false;
      }
      cur = cur.parentNode;
    }
    return false;
  };

  /**
   * 计算元素相对 SVG 根节点的绝对平移量（只处理 translate，面板中足够）。
   * @returns {{x:number, y:number}}
   */
  BoardView._absoluteXY = function (node) {
    var x = 0;
    var y = 0;
    var cur = node;
    while (cur && cur.nodeType === 1) {
      // <use> 上的 x / y 等价于 translate
      var ux = parseFloat(cur.getAttribute && cur.getAttribute('x'));
      var uy = parseFloat(cur.getAttribute && cur.getAttribute('y'));
      if (!isNaN(ux)) x += ux;
      if (!isNaN(uy)) y += uy;

      var tr = cur.getAttribute && cur.getAttribute('transform');
      if (tr) {
        var m = /translate\(\s*(-?[\d.]+)[\s,]*(-?[\d.]+)?\s*\)/.exec(tr);
        if (m) {
          x += parseFloat(m[1]);
          if (m[2] !== undefined) y += parseFloat(m[2]);
        }
      }
      if (cur.tagName && cur.tagName.toLowerCase() === 'svg') {
        break;
      }
      cur = cur.parentNode;
    }
    return { x: x, y: y };
  };

  /**
   * 根据状态点亮/熄灭单只 LED。
   * @param {string} key 如 '4L1'，或特殊灯位 'probe:Z' / 'dds:FREQ' / 'scope:RUN'
   * @param {boolean} on
   */
  BoardView.prototype.setLed = function (key, on) {
    var node = this.ledNodes[key];
    if (!node) {
      return;
    }
    // 试点亮挂起期间只拦「熄灭」写：时序循环每帧的 update() 无法把灯打回原形，
    // 而试点亮层（乃至引擎真实点亮）的「点亮」写仍然生效 —— 两种调用顺序都亮得起来。
    // 展示结束由 tap 层解除挂起并 invalidate 后按真实状态恢复。
    if (this._tapHoldLeds[key] && !on) {
      return;
    }
    if (this._lastLed[key] === on) {
      return;
    }
    this._lastLed[key] = on;

    if (on) {
      // 点亮模板在收集阶段已定（琥珀色灯位保持琥珀色，其余红色）
      setUseRef(node, this._litRef[key] || 'led-red');
    } else {
      setUseRef(node, 'led-off');
    }
  };

  /** 清除某只 LED 的点亮缓存（下次 update 强制重绘；供点击试点亮后恢复现场用） */
  BoardView.prototype.invalidateLed = function (key) {
    if (key === undefined || key === null) {
      this._lastLed = Object.create(null);
    } else {
      delete this._lastLed[key];
    }
  };

  /**
   * 挂起 / 恢复某只 LED 的状态刷新（点击试点亮期间调用）。
   * @param {string} key 状态键
   * @param {boolean} on true=挂起（update 不再改这只灯），false=解除
   */
  BoardView.prototype.holdLed = function (key, on) {
    if (on) {
      this._tapHoldLeds[key] = true;
    } else {
      delete this._tapHoldLeds[key];
    }
  };

  /** 清除某只数码管的笔段缓存（下次 update 强制重绘） */
  BoardView.prototype.invalidateSeg = function (segId) {
    if (segId === undefined || segId === null) {
      this._lastSeg = Object.create(null);
    } else {
      delete this._lastSeg[segId];
    }
  };

  /** 挂起 / 恢复某只数码管的状态刷新（点击试点亮期间调用，语义同 holdLed） */
  BoardView.prototype.holdSeg = function (segId, on) {
    if (on) {
      this._tapHoldSegs[segId] = true;
    } else {
      delete this._tapHoldSegs[segId];
    }
  };

  /**
   * 渲染一只数码管的笔段。
   * @param {string} segId 如 'seg1'
   * @param {Object} onMap { a:true, b:false, ..., dp:false }
   */
  BoardView.prototype.setSegment = function (segId, onMap) {
    var entry = this.segGroups[segId];
    if (!entry || !onMap) {
      return;
    }
    // 试点亮挂起期间只拦「会熄灭笔段」的写（含部分点亮）；全亮写（试点亮层 / 引擎真全亮）放行，
    // 语义同 holdLed：挂起 = 冻结在全亮态，结束后 invalidate 按真实状态恢复。
    if (this._tapHoldSegs[segId]) {
      var anyOff = false;
      for (var holdKey in onMap) {
        if (Object.prototype.hasOwnProperty.call(onMap, holdKey) && !onMap[holdKey]) {
          anyOff = true;
          break;
        }
      }
      if (anyOff) {
        return;
      }
    }

    // 生成签名，避免无变化时重建 DOM
    var sig = SEG_ORDER.map(function (s) {
      return onMap[s] ? '1' : '0';
    }).join('') + (onMap.dp ? '1' : '0');
    if (this._lastSeg[segId] === sig) {
      return;
    }
    this._lastSeg[segId] = sig;

    var lit = entry.lit;
    while (lit.firstChild) {
      lit.removeChild(lit.firstChild);
    }

    for (var i = 0; i < SEG_ORDER.length; i++) {
      var key = SEG_ORDER[i];
      if (onMap[key]) {
        lit.appendChild(svgEl('polygon', { points: SEG_POLYGONS[key] }));
      }
    }
    if (onMap.dp) {
      lit.appendChild(svgEl('circle', { cx: DP_CX, cy: DP_CY, r: DP_R }));
    }
  };

  /**
   * 用一次完整状态刷新整个面板。
   * @param {Object} state engine.getState() 的返回值
   */
  BoardView.prototype.update = function (state) {
    if (!state) {
      return;
    }

    var i;

    // —— 发光二极管显示区：4L1 ~ 4L16 ——
    var leds = state.leds || {};
    for (var key in leds) {
      if (Object.prototype.hasOwnProperty.call(leds, key)) {
        this.setLed(key, !!leds[key]);
      }
    }

    // —— 逻辑电平输出状态灯：5L1 ~ 5L16 ——
    var swLeds = state.swLeds || {};
    for (key in swLeds) {
      if (Object.prototype.hasOwnProperty.call(swLeds, key)) {
        this.setLed(key, !!swLeds[key]);
      }
    }

    // —— 单脉冲状态灯：6L1 ~ 6L6 ——
    var pulses = state.pulses || {};
    for (key in pulses) {
      if (Object.prototype.hasOwnProperty.call(pulses, key)) {
        this.setLed(key, !!pulses[key]);
      }
    }

    // —— 逻辑笔指示灯：高电平 / 低电平 / 高阻 ——
    var probe = state.probe || null;
    if (probe) {
      this.setLed('probe:H', probe.display === 'H');
      this.setLed('probe:L', probe.display === 'L');
      this.setLed('probe:Z', probe.display === 'Z');
    }

    // —— 信号源编码器参数指示灯：频率 / 幅度 / 脉冲 ——
    // （示波器 RUN 灯由仪器交互层控制开关窗口时点亮，这里不驱动）
    var dds = state.dds || null;
    if (dds) {
      this.setLed('dds:FREQ', dds.sel === 'freq');
      this.setLed('dds:AMP', dds.sel === 'amp');
      this.setLed('dds:PULSE', dds.sel === 'wave');
    }

    // —— 数码管：优先用引擎换算好的 segOn（已处理共阳/共阴极性）——
    var segOn = state.segOn || null;
    if (segOn) {
      for (var segId in segOn) {
        if (Object.prototype.hasOwnProperty.call(segOn, segId)) {
          this.setSegment(segId, segOn[segId]);
        }
      }
    } else if (state.segs) {
      // 兜底：引擎只给了原始电平，按共阴（'1' 点亮）处理
      for (segId in state.segs) {
        if (Object.prototype.hasOwnProperty.call(state.segs, segId)) {
          var raw = state.segs[segId] || {};
          var onMap = {};
          for (i = 0; i < SEG_ORDER.length; i++) {
            onMap[SEG_ORDER[i]] = raw[SEG_ORDER[i]] === '1';
          }
          onMap.dp = raw.dp === '1';
          this.setSegment(segId, onMap);
        }
      }
    }
  };

  /** 全部 LED 熄灭、数码管全灭（用于重置） */
  BoardView.prototype.clear = function () {
    for (var label in this.ledNodes) {
      if (Object.prototype.hasOwnProperty.call(this.ledNodes, label)) {
        this.setLed(label, false);
      }
    }
    for (var segId in this.segGroups) {
      if (Object.prototype.hasOwnProperty.call(this.segGroups, segId)) {
        this.setSegment(segId, {});
      }
    }
  };

  DLab.BoardView = BoardView;
})(typeof globalThis !== 'undefined' ? globalThis : this);

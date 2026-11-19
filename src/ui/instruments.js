// src/ui/instruments.js
// 板载仪器交互层：逻辑笔 SW1 拨码、信号源 2SS1 编码器与读数、电位器旋钮、示波器窗口、蜂鸣器声纹。
// ------------------------------------------------------------------
// 背景：面板 SVG 只画了这些仪器的「静态外观」，本层补上命中区、旋转指针与联动视觉。
//   - SW1：点击在 TTL / CMOS 两种判读阈值间切换（滑块左右位移）；
//   - 2SS1：点击循环选择调节参数（频率→幅度→波形），滚轮按当前参数增减，
//           面板上叠加一条随参数旋转的指针与一行参数读数；
//   - 电位器：滚轮细调（±5%）、点击粗调（+10% 循环），指针角度 0%~100% 对应 -120°~+120°；
//   - 示波器：点击示波器模块打开窗口，用 canvas 画出 ACH1 上的波形（方波 / 脉冲 / 直流），
//            RUN 灯（5DL1）随窗口开关点亮；
//   - 蜂鸣器：BEEP 网为高电平时叠加扩散圆环「声纹」动画。
//
// 职责边界：
//   - 电气状态一律通过 engine 的仪器 API（setProbeMode / setDds / setPotRatio …）修改，
//     修改后走 step + onState 的统一刷新路径，与 boardControls 完全一致；
//   - 命中区挂在 #wire-layer 覆盖层里、位于插孔命中区之下（insertBefore hitGroup），
//     插孔点击永远优先，不会出现「点 ACH1 孔却打开了示波器」；
//   - 滚轮事件 stopPropagation，避免与 viewport 的面板缩放打架。
//
// 坐标来源：全部由插孔坐标反推（SVG.SVG 冻结，插孔与仪器外观的相对位置恒定）：
//   逻辑笔模块原点 = probe:P01 − (65,88)；SW1 开关体在模块内 (182,80,42,18)；
//   中间仪器列原点 = mid:SPK − (26,58)；蜂鸣器圆柱 / 示波器模块 / 信号源子组相对列原点偏移固定；
//   电位器子组原点 = rc:2 + (0,38)；旋钮内盘圆心在子组内 (−4,−6)。
(function (global) {
  'use strict';
  var DLab = (global.DLab = global.DLab || {});
  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* ============================================================
   * 面板几何常量（相对各模块原点，取自冻结的 SVG.SVG）
   * ============================================================ */

  /** 逻辑笔模块内的 SW1 开关体与滑块 */
  var SW1_BODY = { x: 182, y: 80, w: 42, h: 18 };
  var SW1_SLIDER = { w: 16, h: 12, dy: 3, inset: 4 };

  /** 电位器子组内的旋钮：外圈圆心 / 内盘圆心 / 指针长度 */
  var POT_KNOB = { cx: -2, cy: -2, r: 14, innerCx: -4, innerCy: -6, innerR: 11, tick: 10 };

  /** 信号源子组内的编码器 2SS1：中心与指针半长 */
  var ENC = { x: 72, y: 148, capR: 9, half: 8 };

  /** 中间仪器列内各子模块的纵向偏移与尺寸 */
  var MID = { spk: 0, beep: 94, scope: 188, dds: 282, moduleW: 144, scopeH: 94 };
  /** 蜂鸣器子组内的圆柱中心与半径 */
  var BUZZER = { x: 108, y: 56, r: 24 };
  /** 信号源子组内的参数读数框（位于三只指示灯与编码器之间） */
  var DDS_READOUT = { x: 14, y: 90, w: 116, h: 13 };

  /** 交互步长 */
  var POT_WHEEL_STEP = 0.05;
  var POT_CLICK_STEP = 0.1;
  var SCOPE_PERIODS = 4;

  /** 2SS1 编码器当前调节参数的 中文名 */
  var SEL_NAMES = { freq: '频率', amp: '幅度', wave: '波形' };

  /* ============================================================
   * 纯函数（Node 可测）：格式化 / 角度 / 锚点
   * ============================================================ */

  /** 频率格式化：1 → '1Hz'，1000 → '1.000kHz'，1e6 → '1.000MHz' */
  function formatFreq(hz) {
    if (!isFinite(hz) || hz <= 0) return '—';
    if (hz >= 1e6) return (hz / 1e6).toFixed(3) + 'MHz';
    if (hz >= 1000) return (hz / 1000).toFixed(3) + 'kHz';
    return (Math.round(hz * 100) / 100) + 'Hz';
  }

  /** 波形中文名 */
  function waveName(w) {
    return w === 'pulse' ? '脉冲' : '方波';
  }

  /**
   * 2SS1 指针角度（度，0° 指向 12 点钟，顺时针为正）。
   * 指针永远反映「当前选中的参数」在量程里的位置：
   *   频率（对数 1Hz~1MHz）与幅度（0~5V）：-120° ~ +120° 线性铺满；
   *   波形：方波 -60°、脉冲 +60°（两个刻度位）。
   */
  function ddsAngle(dds) {
    if (!dds) return 0;
    if (dds.sel === 'freq') {
      var exp = Math.log10(Math.max(1, Math.min(1e6, dds.freqHz))) / 6;   // 0 ~ 1
      return -120 + 240 * exp;
    }
    if (dds.sel === 'amp') {
      var a = Math.max(0, Math.min(5, dds.amplitudeV)) / 5;
      return -120 + 240 * a;
    }
    return dds.waveform === 'pulse' ? 60 : -60;
  }

  /** 2SS1 读数文本：'1.000kHz · 5.0V · 方波' */
  function ddsReadoutText(dds) {
    if (!dds) return '';
    return formatFreq(dds.freqHz) + ' · ' + dds.amplitudeV.toFixed(1) + 'V · ' + waveName(dds.waveform);
  }

  /**
   * 由插孔坐标反推各仪器的绝对锚点（任一关键插孔缺失时对应项为 null，本层自动降级）。
   * @returns {Object} 各仪器绝对坐标，见字段注释
   */
  function deriveAnchors(geometry) {
    var J = (geometry && geometry.JACKS) || {};
    function at(id, dx, dy) {
      var j = J[id];
      return j ? { x: j.x + (dx || 0), y: j.y + (dy || 0) } : null;
    }
    var probeOrigin = at('probe:P01', -65, -88);      // 逻辑笔模块原点
    var midOrigin = at('mid:SPK', -26, -58);          // 中间仪器列原点
    var potOrigin = at('rc:2', 0, 38);                // 电位器子组原点
    var ddsSub = midOrigin ? { x: midOrigin.x, y: midOrigin.y + MID.dds } : null;
    return {
      probeOrigin: probeOrigin,
      midOrigin: midOrigin,
      potOrigin: potOrigin,
      ddsSub: ddsSub,
      // SW1 开关体左上角（逻辑笔模块内 (182,80)）
      sw1: probeOrigin ? { x: probeOrigin.x + SW1_BODY.x, y: probeOrigin.y + SW1_BODY.y } : null,
      // 蜂鸣器圆柱中心
      buzzer: midOrigin ? {
        x: midOrigin.x + BUZZER.x,
        y: midOrigin.y + MID.beep + BUZZER.y,
        r: BUZZER.r
      } : null,
      // 示波器模块矩形
      scopeRect: midOrigin ? {
        x: midOrigin.x, y: midOrigin.y + MID.scope, w: MID.moduleW, h: MID.scopeH
      } : null,
      // 2SS1 编码器中心
      encoder: ddsSub ? { x: ddsSub.x + ENC.x, y: ddsSub.y + ENC.y } : null,
      // 信号源读数框左上角
      readout: ddsSub ? { x: ddsSub.x + DDS_READOUT.x, y: ddsSub.y + DDS_READOUT.y } : null,
      // 电位器：外圈圆心（命中区用）与内盘圆心（指针轴心）
      potKnob: potOrigin ? { x: potOrigin.x + POT_KNOB.cx, y: potOrigin.y + POT_KNOB.cy } : null,
      potPivot: potOrigin ? { x: potOrigin.x + POT_KNOB.innerCx, y: potOrigin.y + POT_KNOB.innerCy } : null
    };
  }

  /* ============================================================
   * 小工具
   * ============================================================ */

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

  function htmlEl(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, String(attrs[k]));
      }
    }
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /** 角度（度，0°=12 点钟，顺时针为正）→ 单位方向向量 */
  function angleDir(deg) {
    var rad = deg * Math.PI / 180;
    return { x: Math.sin(rad), y: -Math.cos(rad) };
  }

  /** 透明命中区通用属性：不吃视觉、只吃事件 */
  var HIT_ATTRS = {
    fill: '#000',
    'fill-opacity': '0',
    'pointer-events': 'all',
    'class': 'board-instrument',
    tabindex: '0'
  };

  /* ============================================================
   * Instruments
   * ============================================================ */

  /**
   * @param {{engine:Object, wireLayer:Object, boardView:Object, hud:Object,
   *          geometry:Object, onState?:Function}} opts
   */
  function Instruments(opts) {
    opts = opts || {};
    this.engine = opts.engine;
    this.wireLayer = opts.wireLayer || null;
    this.boardView = opts.boardView || null;
    this.hud = opts.hud || null;
    this.geometry = opts.geometry || (DLab.geometry || null);
    this.onState = typeof opts.onState === 'function' ? opts.onState : null;

    if (!this.engine) {
      throw new Error('Instruments：缺少 engine');
    }

    this.anchors = Instruments.deriveAnchors(this.geometry);

    this._host = null;
    this._bound = [];
    this._lastState = null;
    // 示波器窗口
    this._scopeOpen = false;
    this._scopeEl = null;
    this._scopeCtx = null;
    this._scopeFoot = null;
    // 蜂鸣器声纹
    this._beepOn = false;
    this._rippleRaf = 0;
    this._rippleOnceUntil = 0;

    this._build();
    this._bindEvents();
    this.syncVisuals(null);
  }

  /* ---------- 构建 ---------- */

  Instruments.prototype._build = function () {
    var svg = this.wireLayer && this.wireLayer.svg;
    if (!svg) return;                       // Node 环境 / 缺覆盖层：只保留纯函数与 engine 联动
    var a = this.anchors;

    this._host = svgEl('g', { id: 'board-instruments', 'pointer-events': 'none' });

    // —— SW1 拨动开关（视觉覆盖 + 命中区）——
    if (a.sw1) {
      // 覆盖层重画开关体与滑块（与 SVG.SVG 原件同坐标同配色，原指针被盖在下面）
      this._host.appendChild(svgEl('rect', {
        x: a.sw1.x, y: a.sw1.y, width: SW1_BODY.w, height: SW1_BODY.h,
        fill: '#2a2d30', stroke: '#555', 'stroke-width': '1'
      }));
      this._slider = svgEl('rect', {
        x: a.sw1.x + SW1_SLIDER.inset, y: a.sw1.y + SW1_SLIDER.dy,
        width: SW1_SLIDER.w, height: SW1_SLIDER.h,
        fill: '#111', stroke: '#666', 'stroke-width': '0.6'
      });
      this._host.appendChild(this._slider);
      this._sliderX = {
        ttl: a.sw1.x + SW1_BODY.w - SW1_SLIDER.inset - SW1_SLIDER.w,   // 右 = TTL
        cmos: a.sw1.x + SW1_SLIDER.inset                                // 左 = COMS（面板丝印原文）
      };
      this._sw1Hit = svgEl('rect', Object.assign({}, HIT_ATTRS, {
        x: a.sw1.x - 2, y: a.sw1.y - 2, width: SW1_BODY.w + 4, height: SW1_BODY.h + 4,
        rx: '3', 'data-act': 'probe-mode',
        role: 'button', 'aria-label': '逻辑笔模式开关 SW1：点击切换 TTL / CMOS'
      }));
      this._host.appendChild(this._sw1Hit);
    }

    // —— 电位器旋钮（覆盖内盘 + 旋转指针 + 命中区）——
    if (a.potKnob && a.potPivot) {
      this._host.appendChild(svgEl('circle', {
        cx: a.potPivot.x, cy: a.potPivot.y, r: POT_KNOB.innerR,
        fill: '#1f2124', stroke: '#555', 'stroke-width': '0.8'
      }));
      this._potPointer = svgEl('line', {
        stroke: '#aaa', 'stroke-width': '2.5', 'stroke-linecap': 'round'
      });
      this._host.appendChild(this._potPointer);
      this._potHit = svgEl('circle', Object.assign({}, HIT_ATTRS, {
        cx: a.potKnob.x, cy: a.potKnob.y, r: '16', 'data-act': 'pot-turn',
        role: 'slider', 'aria-label': '电位器旋钮：滚轮细调 / 点击进位，当前 50%'
      }));
      this._host.appendChild(this._potHit);
    }

    // —— 2SS1 编码器（覆盖帽面 + 旋转指针 + 参数读数 + 命中区）——
    if (a.encoder) {
      this._host.appendChild(svgEl('circle', {
        cx: a.encoder.x, cy: a.encoder.y, r: ENC.capR,
        fill: '#e2e6ea', stroke: '#444', 'stroke-width': '0.8'
      }));
      this._encPointer = svgEl('line', {
        stroke: '#555', 'stroke-width': '2', 'stroke-linecap': 'round'
      });
      this._host.appendChild(this._encPointer);
      this._encHit = svgEl('circle', Object.assign({}, HIT_ATTRS, {
        cx: a.encoder.x, cy: a.encoder.y, r: '22', 'data-act': 'dds-cycle',
        role: 'button', 'aria-label': '信号源编码器 2SS1：点击切换调节参数，滚轮增减'
      }));
      this._host.appendChild(this._encHit);
    }
    if (a.readout) {
      this._readoutBg = svgEl('rect', {
        x: a.readout.x, y: a.readout.y, width: DDS_READOUT.w, height: DDS_READOUT.h,
        rx: '3', fill: '#14171a', 'fill-opacity': '0.85', stroke: '#2c3540', 'stroke-width': '0.6'
      });
      this._readoutText = svgEl('text', {
        x: a.readout.x + DDS_READOUT.w / 2, y: a.readout.y + DDS_READOUT.h - 3.5,
        'font-size': '8.5', fill: '#cfd8e3', 'text-anchor': 'middle',
        'font-family': 'Consolas, monospace'
      }, '');
      this._host.appendChild(this._readoutBg);
      this._host.appendChild(this._readoutText);
    }

    // —— 示波器模块命中区（插孔命中区在本层之上，点 ACH1 孔不受影响）——
    if (a.scopeRect) {
      this._scopeHit = svgEl('rect', Object.assign({}, HIT_ATTRS, {
        x: a.scopeRect.x, y: a.scopeRect.y, width: a.scopeRect.w, height: a.scopeRect.h,
        rx: '10', 'data-act': 'scope',
        role: 'button', 'aria-label': '示波器：点击打开 / 关闭波形窗口'
      }));
      this._host.appendChild(this._scopeHit);
    }

    // —— 蜂鸣器声纹（3 圈扩散圆环，默认全透明）——
    if (a.buzzer) {
      this._rippleCircles = [];
      for (var i = 0; i < 3; i++) {
        var c = svgEl('circle', {
          cx: a.buzzer.x, cy: a.buzzer.y, r: '6', fill: 'none',
          stroke: '#f59e0b', 'stroke-width': '2', opacity: '0'
        });
        this._rippleCircles.push(c);
        this._host.appendChild(c);
      }
    }

    // 挂到插孔命中区之下：插孔点击永远优先
    if (this.wireLayer.hitGroup && this.wireLayer.hitGroup.parentNode === svg) {
      svg.insertBefore(this._host, this.wireLayer.hitGroup);
    } else {
      svg.appendChild(this._host);
    }
  };

  /* ---------- 事件 ---------- */

  Instruments.prototype._bindEvents = function () {
    if (!this._host) return;
    var self = this;

    var actOf = function (e) {
      return (e.target && e.target.getAttribute) ? e.target.getAttribute('data-act') : null;
    };

    var onClick = function (e) {
      var act = actOf(e);
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();      // 不冒泡到覆盖层的「空白取消选中」逻辑
      self._dispatch(act, null);
    };

    var onKeyDown = function (e) {
      var k = e.key || '';
      if (k !== 'Enter' && k !== ' ' && k !== 'Spacebar') return;
      var act = actOf(e);
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      self._dispatch(act, null);
    };

    // 滚轮：旋钮上滚轮调参数，必须拦下（否则 viewport 会顺手把面板缩放了）。
    // 方向约定与旋钮视觉一致：向上滚 = 顺时针 = 增大（指针向 +120° 转动）。
    var onWheel = function (e) {
      var act = actOf(e);
      if (act !== 'dds-cycle' && act !== 'pot-turn') return;
      e.preventDefault();
      e.stopPropagation();
      self._dispatch(act, e.deltaY < 0 ? 1 : -1);
    };

    this._host.addEventListener('click', onClick);
    this._host.addEventListener('keydown', onKeyDown);
    this._host.addEventListener('wheel', onWheel, { passive: false });
    this._bound.push({ target: this._host, type: 'click', fn: onClick });
    this._bound.push({ target: this._host, type: 'keydown', fn: onKeyDown });
    this._bound.push({ target: this._host, type: 'wheel', fn: onWheel });
  };

  Instruments.prototype._dispatch = function (act, delta) {
    if (act === 'probe-mode') return this._onProbeMode();
    if (act === 'dds-cycle') return delta === null ? this._onDdsCycle() : this._onDdsWheel(delta);
    if (act === 'pot-turn') return delta === null ? this._onPotClick() : this._onPotWheel(delta);
    if (act === 'scope') return this.toggleScope();
  };

  /* ---------- 各交互动作 ---------- */

  /** 修改引擎后推进一次仿真并统一刷新（与 boardControls._afterChange 同构） */
  Instruments.prototype._afterChange = function () {
    var state = null;
    try {
      state = this.engine.step(nowMs());
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
    if (state && this.onState) this.onState(state);
    else if (state) this.syncVisuals(state);
    return state;
  };

  Instruments.prototype._onProbeMode = function () {
    var mode = this.engine.toggleProbeMode();
    this._afterChange();
    this._status(mode === 'TTL'
      ? '逻辑笔模式：TTL（悬空按高电平判读）'
      : '逻辑笔模式：CMOS（悬空按高阻判读）');
  };

  Instruments.prototype._onDdsCycle = function () {
    var sel = this.engine.cycleDdsParam();
    this._afterChange();
    this._status('信号源 2SS1：当前调节「' + SEL_NAMES[sel] + '」（滚轮增减）');
  };

  Instruments.prototype._onDdsWheel = function (delta) {
    var dds = this.engine.adjustDds(delta);
    this._afterChange();
    if (dds.sel === 'freq') {
      this._status('信号源频率：' + formatFreq(dds.freqHz) + '（1-2-5 步进）');
    } else if (dds.sel === 'amp') {
      var thr = (DLab.Engine && DLab.Engine.DDS_TTL_THRESHOLD) || 2.5;
      this._status('信号源幅度：' + dds.amplitudeV.toFixed(1) + 'V' +
        (dds.amplitudeV < thr ? '（低于 TTL 阈值 ' + thr + 'V，输出恒为低电平）' : ''));
    } else {
      this._status('信号源波形：' + waveName(dds.waveform));
    }
  };

  Instruments.prototype._onPotClick = function () {
    var r = this.engine.getPotRatio() + POT_CLICK_STEP;
    if (r > 1.0001) r = 0;               // 满量程后再点回到 0，循环进位
    this.engine.setPotRatio(r);
    this._afterChange();
    this._potStatus();
  };

  Instruments.prototype._onPotWheel = function (delta) {
    this.engine.setPotRatio(this.engine.getPotRatio() + delta * POT_WHEEL_STEP);
    this._afterChange();
    this._potStatus();
  };

  /** 电位器状态提示：优先用引擎求出的滑动端电压 */
  Instruments.prototype._potStatus = function () {
    var ratio = this.engine.getPotRatio();
    var pct = Math.round(ratio * 100) + '%';
    var pot = (this._lastState && this._lastState.pot) || null;
    if (!pot || pot.volts === null || pot.volts === undefined) {
      this._status('电位器 ' + pct + '（两端未接电源，滑动端无输出）', 'warn');
    } else {
      this._status('电位器 ' + pct + '（滑动端 ' + pot.volts.toFixed(1) + 'V' +
        (pot.level === '1' ? '，判读高电平' : '，判读低电平') + '）');
    }
  };

  /* ---------- 示波器窗口 ---------- */

  /** 打开 / 关闭示波器窗口（RUN 灯 5DL1 随动） */
  Instruments.prototype.toggleScope = function () {
    this._scopeOpen = !this._scopeOpen;
    if (this._scopeOpen) {
      this._openScopeWindow();
      this._status('示波器窗口已打开（RUN 灯亮，随接线自动刷新）');
    } else {
      this._closeScopeWindow();
      this._status('示波器窗口已关闭');
    }
    if (this.boardView && typeof this.boardView.setLed === 'function') {
      this.boardView.setLed('scope:RUN', this._scopeOpen);
    }
  };

  Instruments.prototype._openScopeWindow = function () {
    if (this._scopeEl) {
      this._scopeEl.style.display = '';
      this._drawScope(this._lastState);
      return;
    }
    var self = this;
    var box = htmlEl('div', { id: 'dlab-scope', 'class': 'dlab-scope' });
    var head = htmlEl('div', { 'class': 'dlab-scope-head' });
    head.appendChild(htmlEl('span', { 'class': 'dlab-scope-title' }, '示波器 · ACH1'));
    var closeBtn = htmlEl('button', {
      type: 'button', 'class': 'dlab-scope-close', 'aria-label': '关闭示波器窗口',
      title: '关闭（也可点击面板上的示波器模块）'
    }, '×');
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      self.toggleScope();
    });
    head.appendChild(closeBtn);

    var canvas = htmlEl('canvas');
    canvas.width = 600;
    canvas.height = 400;
    canvas.style.width = '300px';
    canvas.style.height = '200px';

    var foot = htmlEl('div', { 'class': 'dlab-scope-foot is-empty' }, '等待信号…');

    box.appendChild(head);
    box.appendChild(canvas);
    box.appendChild(foot);
    document.body.appendChild(box);

    this._scopeEl = box;
    this._scopeCtx = canvas.getContext('2d');
    this._scopeFoot = foot;
    this._drawScope(this._lastState);
  };

  Instruments.prototype._closeScopeWindow = function () {
    if (this._scopeEl) {
      this._scopeEl.style.display = 'none';
    }
  };

  /** 按当前 ACH1 信号重画波形（方波 / 脉冲 / 直流 / 无信号） */
  Instruments.prototype._drawScope = function (state) {
    if (!this._scopeCtx || !this._scopeFoot) return;
    var ctx = this._scopeCtx;
    var W = 300;
    var H = 200;

    ctx.setTransform(2, 0, 0, 2, 0, 0);   // 画布物理 600×400，逻辑 300×200（2 倍抗锯齿）
    ctx.fillStyle = '#0b1210';
    ctx.fillRect(0, 0, W, H);

    // 10×8 网格
    ctx.strokeStyle = '#16241c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var gx = 1; gx < 10; gx++) {
      ctx.moveTo(gx * W / 10, 0);
      ctx.lineTo(gx * W / 10, H);
    }
    for (var gy = 1; gy < 8; gy++) {
      ctx.moveTo(0, gy * H / 8);
      ctx.lineTo(W, gy * H / 8);
    }
    ctx.stroke();

    var ach1 = (state && state.analog && state.analog.ach1) ? state.analog.ach1 : null;
    var kind = ach1 ? ach1.wave : 'none';
    var yHigh = H * 0.28;
    var yLow = H * 0.78;

    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(74, 222, 128, 0.55)';
    ctx.shadowBlur = 6;
    ctx.beginPath();

    if (kind === 'none') {
      ctx.strokeStyle = '#3d5147';
      ctx.shadowBlur = 0;
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();
      this._scopeFoot.textContent = '无信号：把时钟输出或 DDS 输出接到 ACH1';
      this._scopeFoot.className = 'dlab-scope-foot is-empty';
      return;
    }

    if (kind === 'dc') {
      var yDc = (ach1.level === '1') ? yHigh : yLow;
      ctx.moveTo(0, yDc);
      ctx.lineTo(W, yDc);
      ctx.stroke();
      ctx.shadowBlur = 0;
      this._scopeFoot.textContent = '直流  ' + (ach1.level === '1' ? '5.0V' : '0V');
      this._scopeFoot.className = 'dlab-scope-foot';
      return;
    }

    // 方波 / 脉冲：4 个周期铺满宽度，t=0 从高电平开始（与引擎 clockLevel / ddsLevel 相位一致）
    var per = W / SCOPE_PERIODS;
    var duty = (kind === 'pulse') ? 0.1 : 0.5;
    ctx.moveTo(0, yHigh);
    for (var p = 0; p < SCOPE_PERIODS; p++) {
      var x0 = p * per;
      var xFall = x0 + per * duty;
      var x1 = x0 + per;
      ctx.lineTo(xFall, yHigh);   // 高电平段
      ctx.lineTo(xFall, yLow);    // 下降沿
      ctx.lineTo(x1, yLow);       // 低电平段
      if (p < SCOPE_PERIODS - 1) {
        ctx.lineTo(x1, yHigh);    // 下一周期的上升沿
      }
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    var freq = (ach1.source && ach1.source.freqHz) ? ach1.source.freqHz : null;
    this._scopeFoot.textContent =
      'f = ' + (freq ? formatFreq(freq) : '—') +
      '   Vpp = 5.0V   ' + waveName(kind) + '（占空比 ' + Math.round(duty * 100) + '%）';
    this._scopeFoot.className = 'dlab-scope-foot';
  };

  /* ---------- 蜂鸣器声纹 ---------- */

  Instruments.prototype._setBeepOn = function (on) {
    if (this._beepOn === on) return;
    this._beepOn = on;
    if (on) this._startRipple();
  };

  /** 播放一次声纹动画（供点击试用层调用，不影响引擎） */
  Instruments.prototype.playBeepRipple = function (ms) {
    this._rippleOnceUntil = nowMs() + (ms || 320);
    this._startRipple();
  };

  Instruments.prototype._startRipple = function () {
    if (this._rippleRaf || !this._rippleCircles) return;
    var self = this;
    var t0 = nowMs();
    var frame = function (t) {
      var run = self._beepOn || t < self._rippleOnceUntil;
      if (run) {
        var el = t - t0;
        for (var i = 0; i < self._rippleCircles.length; i++) {
          var phase = ((el / 900) + i / self._rippleCircles.length) % 1;
          var c = self._rippleCircles[i];
          c.setAttribute('r', String(6 + phase * 26));
          c.setAttribute('opacity', String(0.8 * (1 - phase)).slice(0, 4));
        }
        self._rippleRaf = requestAnimationFrame(frame);
      } else {
        self._rippleRaf = 0;
        for (var j = 0; j < self._rippleCircles.length; j++) {
          self._rippleCircles[j].setAttribute('opacity', '0');
        }
      }
    };
    this._rippleRaf = requestAnimationFrame(frame);
  };

  /* ---------- 状态刷新 ---------- */

  /**
   * 把引擎当前状态映射到本层视觉（读数 / 指针 / 滑块 / 声纹 / 示波器窗口）。
   * @param {Object} [state] engine.getState() 的返回值；缺省时用上一次缓存
   */
  Instruments.prototype.syncVisuals = function (state) {
    if (state) this._lastState = state;
    if (!this._host) return;
    var eng = this.engine;

    // SW1 滑块：TTL 在右、CMOS 在左
    if (this._slider && typeof eng.getProbeMode === 'function') {
      var wantX = (eng.getProbeMode() === 'TTL') ? this._sliderX.ttl : this._sliderX.cmos;
      if (parseFloat(this._slider.getAttribute('x')) !== wantX) {
        this._slider.setAttribute('x', String(wantX));
      }
    }

    // 2SS1：指针角度 + 读数 + aria
    if (this._encPointer && typeof eng.getDds === 'function') {
      var dds = eng.getDds();
      var dir = angleDir(ddsAngle(dds));
      this._encPointer.setAttribute('x1', String(round2(this.anchors.encoder.x - ENC.half * dir.x)));
      this._encPointer.setAttribute('y1', String(round2(this.anchors.encoder.y - ENC.half * dir.y)));
      this._encPointer.setAttribute('x2', String(round2(this.anchors.encoder.x + ENC.half * dir.x)));
      this._encPointer.setAttribute('y2', String(round2(this.anchors.encoder.y + ENC.half * dir.y)));
      if (this._encHit) {
        this._encHit.setAttribute('aria-label',
          '信号源编码器 2SS1：点击切换调节参数，滚轮增减（当前 ' + SEL_NAMES[dds.sel] + '）');
      }
      if (this._readoutText) {
        var text = ddsReadoutText(dds);
        if (this._readoutText.textContent !== text) {
          this._readoutText.textContent = text;
        }
      }
    }

    // 电位器：指针角度 0% → -120°，100% → +120°
    if (this._potPointer && typeof eng.getPotRatio === 'function') {
      var ratio = eng.getPotRatio();
      var pdir = angleDir(-120 + ratio * 240);
      this._potPointer.setAttribute('x1', String(round2(this.anchors.potPivot.x)));
      this._potPointer.setAttribute('y1', String(round2(this.anchors.potPivot.y)));
      this._potPointer.setAttribute('x2', String(round2(this.anchors.potPivot.x + POT_KNOB.tick * pdir.x)));
      this._potPointer.setAttribute('y2', String(round2(this.anchors.potPivot.y + POT_KNOB.tick * pdir.y)));
      if (this._potHit) {
        this._potHit.setAttribute('aria-label', '电位器旋钮：滚轮细调 / 点击进位，当前 ' + Math.round(ratio * 100) + '%');
      }
    }

    // 蜂鸣器声纹 + 示波器窗口随状态刷新
    var s = this._lastState;
    this._setBeepOn(!!(s && s.analog && s.analog.beep && s.analog.beep.on));
    if (this._scopeOpen) {
      if (this.boardView && typeof this.boardView.setLed === 'function') {
        this.boardView.setLed('scope:RUN', true);   // 自愈：clear() 后重新点亮
      }
      this._drawScope(s);
    }
  };

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  Instruments.prototype._status = function (text, level) {
    if (this.hud && typeof this.hud.setStatus === 'function') {
      this.hud.setStatus(text, level || 'info');
    }
  };

  /** 供自测 / 调试：本层建立的命中区与锚点快照 */
  Instruments.prototype.getSnapshot = function () {
    return { anchors: this.anchors, host: !!this._host, scopeOpen: this._scopeOpen };
  };

  Instruments.prototype.destroy = function () {
    for (var i = 0; i < this._bound.length; i++) {
      this._bound[i].target.removeEventListener(this._bound[i].type, this._bound[i].fn);
    }
    this._bound.length = 0;
    if (this._host && this._host.parentNode) {
      this._host.parentNode.removeChild(this._host);
    }
    this._host = null;
    if (this._scopeEl && this._scopeEl.parentNode) {
      this._scopeEl.parentNode.removeChild(this._scopeEl);
    }
    this._scopeEl = null;
  };

  /* ---------- 导出 ---------- */

  Instruments.deriveAnchors = deriveAnchors;
  Instruments.formatFreq = formatFreq;
  Instruments.waveName = waveName;
  Instruments.ddsAngle = ddsAngle;
  Instruments.ddsReadoutText = ddsReadoutText;
  Instruments.POT_WHEEL_STEP = POT_WHEEL_STEP;
  Instruments.POT_CLICK_STEP = POT_CLICK_STEP;

  DLab.Instruments = Instruments;
})(typeof globalThis !== 'undefined' ? globalThis : this);

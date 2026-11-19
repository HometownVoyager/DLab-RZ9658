// src/ui/tapFeedback.js
// 点击试用层：点一下蜂鸣器叫一声、点一下 LED 亮一下、点一下数码管全亮一瞬。
// ------------------------------------------------------------------
// 定位（与其它层的关系，务必保持）：
//   - 这是「脱离接线、脱离时序」的演示通道：直接点亮的是面板视觉，
//     不经过引擎、不产生任何电气状态 —— 与正常触发的联动（engine 状态 → boardView）
//     完全独立，互不干扰。展示结束后按引擎真实状态恢复现场。
//   - 因此本层对 engine 只有读操作（getState / getDds），绝不调用任何 set/step。
//   - 命中区挂在 #wire-layer 覆盖层的最上方（最后 append），
//     所以 LED / 数码管 / 蜂鸣器圆柱上的点击优先落在这里；
//     而所有命中区都刻意避开插孔半径（LED 与插孔间距 34 > 9+14，
//     蜂鸣器圆环与 BEEP 孔相距 82 > 24+14），不会挡住接线。
//
// 交互清单：
//   LED（4L1~4L16、5L1~5L16、6L1~6L6、逻辑笔三灯、信号源三灯）→ 点亮 260ms；
//   示波器 RUN 灯（5DL1）→ 打开 / 关闭示波器窗口（转发给 onScope）；
//   数码管 seg1~seg8 → 全部笔段点亮 300ms；
//   蜂鸣器圆柱 → 试鸣一声（2.7kHz）+ 声纹动画；
//   功放入模块右侧 → 试听一声 880Hz；
//   信号源标题 → 按当前 DDS 频率试听（超出可听域时钳到 30Hz~8kHz 并提示）。
(function (global) {
  'use strict';
  var DLab = (global.DLab = global.DLab || {});
  var SVG_NS = 'http://www.w3.org/2000/svg';

  /** LED 试点亮时长 */
  var LED_MS = 260;
  /** 数码管试点亮时长 */
  var SEG_MS = 300;
  /** 蜂鸣器试鸣时长 */
  var BEEP_MS = 180;
  /** 功放试听频率 */
  var SPK_TEST_HZ = 880;
  /** 功放试听时长 */
  var SPK_TEST_MS = 220;
  /** 信号源试听时长 */
  var DDS_TEST_MS = 300;
  /** 信号源试听的可听域钳制（与 Sound 模块一致） */
  var AUDIBLE_MIN_HZ = 30;
  var AUDIBLE_MAX_HZ = 8000;

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

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /**
   * @param {{engine:Object, wireLayer:Object, boardView:Object, hud:Object,
   *          geometry:Object, applyState?:Function,
   *          onScope?:Function, onBuzzerRipple?:Function}} opts
   *   onScope —— 点 RUN 灯时转发（由 app 接到 Instruments.toggleScope）；
   *   onBuzzerRipple —— 试鸣时顺带播放声纹动画（由 app 接到 Instruments.playBeepRipple）。
   */
  function TapFeedback(opts) {
    opts = opts || {};
    this.engine = opts.engine;
    this.wireLayer = opts.wireLayer || null;
    this.boardView = opts.boardView || null;
    this.hud = opts.hud || null;
    this.geometry = opts.geometry || (DLab.geometry || null);
    this.applyState = typeof opts.applyState === 'function' ? opts.applyState : null;
    this.onScope = typeof opts.onScope === 'function' ? opts.onScope : null;
    this.onBuzzerRipple = typeof opts.onBuzzerRipple === 'function' ? opts.onBuzzerRipple : null;

    if (!this.engine) {
      throw new Error('TapFeedback：缺少 engine');
    }

    this._host = null;
    this._bound = [];
    this._timers = Object.create(null);

    this._build();
    this._bindEvents();
  }

  /** 命中区通用属性（extra 里给几何形状 cx/cy/r 或 x/y/width/height） */
  function hitAttrs(dataTap, label, extra) {
    var base = {
      fill: '#000',
      'fill-opacity': '0',
      'pointer-events': 'all',
      'class': 'tap-hit',
      'data-tap': dataTap,
      role: 'button',
      'aria-label': label,
      tabindex: '0'
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) base[k] = String(extra[k]);
      }
    }
    return base;
  }

  TapFeedback.prototype._build = function () {
    var svg = this.wireLayer && this.wireLayer.svg;
    if (!svg) return;                       // Node 环境：整体跳过
    var bv = this.boardView;

    this._host = svgEl('g', { id: 'tap-feedback', 'pointer-events': 'none' });

    // —— LED 试点亮（覆盖全部编号灯位与特殊灯位）——
    if (bv && Array.isArray(bv.ledTapList)) {
      for (var i = 0; i < bv.ledTapList.length; i++) {
        var led = bv.ledTapList[i];
        this._host.appendChild(svgEl('circle', hitAttrs('led:' + led.key, '试点亮 LED ' + led.key, {
          cx: led.x, cy: led.y, r: '9'
        })));
      }
    }

    // —— 数码管试点亮 ——
    if (bv && Array.isArray(bv.segPosList)) {
      for (var j = 0; j < bv.segPosList.length; j++) {
        var seg = bv.segPosList[j];
        this._host.appendChild(svgEl('circle', hitAttrs('seg:' + seg.segId, '试点亮数码管 ' + seg.segId, {
          cx: seg.x, cy: seg.y, r: '22'
        })));
      }
    }

    // —— 蜂鸣器 / 功放入 / 信号源标题（坐标由插孔反推，与本层其它来源无关）——
    var anchors = (DLab.Instruments && DLab.Instruments.deriveAnchors)
      ? DLab.Instruments.deriveAnchors(this.geometry) : null;
    if (anchors) {
      if (anchors.buzzer) {
        this._host.appendChild(svgEl('circle', hitAttrs('buzzer', '蜂鸣器试鸣', {
          cx: anchors.buzzer.x, cy: anchors.buzzer.y, r: String(anchors.buzzer.r)
        })));
      }
      if (anchors.midOrigin) {
        // 功放入模块右半边（左半边留给 SPK 插孔接线）
        this._host.appendChild(svgEl('rect', hitAttrs('spk', '功放试听', {
          x: anchors.midOrigin.x + 60, y: anchors.midOrigin.y, width: '84', height: '94', rx: '10'
        })));
      }
      if (anchors.ddsSub) {
        // 信号源标题条（「信 号 源」三个字附近）
        this._host.appendChild(svgEl('rect', hitAttrs('dds', '按当前信号源频率试听', {
          x: anchors.ddsSub.x + 8, y: anchors.ddsSub.y + 8, width: '128', height: '26', rx: '6'
        })));
      }
    }

    // 挂到最上层：LED / 数码管 / 蜂鸣器圆柱上的点击优先命中试用层
    svg.appendChild(this._host);
  };

  TapFeedback.prototype._bindEvents = function () {
    if (!this._host) return;
    var self = this;

    var tapOf = function (e) {
      return (e.target && e.target.getAttribute) ? e.target.getAttribute('data-tap') : null;
    };

    var onTap = function (e) {
      var tap = tapOf(e);
      if (!tap) return;
      e.preventDefault();
      e.stopPropagation();
      self.fire(tap);
    };

    var onKeyDown = function (e) {
      var k = e.key || '';
      if (k !== 'Enter' && k !== ' ' && k !== 'Spacebar') return;
      var tap = tapOf(e);
      if (!tap) return;
      e.preventDefault();
      e.stopPropagation();
      self.fire(tap);
    };

    this._host.addEventListener('click', onTap);
    this._host.addEventListener('keydown', onKeyDown);
    this._bound.push({ target: this._host, type: 'click', fn: onTap });
    this._bound.push({ target: this._host, type: 'keydown', fn: onKeyDown });
  };

  /**
   * 触发一次试用。tap 形如 'led:4L1' / 'seg:seg3' / 'buzzer' / 'spk' / 'dds'。
   * @param {string} tap
   * @returns {boolean} 是否识别了该目标
   */
  TapFeedback.prototype.fire = function (tap) {
    if (typeof tap !== 'string') return false;
    if (tap.indexOf('led:') === 0) return this._tapLed(tap.slice(4));
    if (tap.indexOf('seg:') === 0) return this._tapSeg(tap.slice(4));
    if (tap === 'buzzer') return this._tapBuzzer();
    if (tap === 'spk') return this._tapSpk();
    if (tap === 'dds') return this._tapDds();
    return false;
  };

  /* ---------- 各试用动作 ---------- */

  TapFeedback.prototype._tapLed = function (key) {
    var bv = this.boardView;
    if (!bv || !key) return false;
    if (key === 'scope:RUN') {
      // RUN 灯是示波器窗口的开关指示，点它等效点示波器模块
      if (this.onScope) this.onScope();
      return true;
    }
    if (!bv.ledNodes || !bv.ledNodes[key]) return false;
    var self = this;
    // 先点亮、再挂起该灯的状态刷新（两步同步执行，时序循环插不进来）：
    // 时序循环每帧都会 update() 面板，不挂起的话试点亮会在一帧内（<16ms）被打回原形。
    // boardView 的挂起守卫只拦「熄灭」写，即便调用顺序颠倒也依然点得亮。
    bv.setLed(key, true);
    if (typeof bv.holdLed === 'function') bv.holdLed(key, true);
    this._status('试点亮 ' + key + '（' + LED_MS + 'ms 后按实际状态恢复）');
    clearTimeout(this._timers['led:' + key]);
    this._timers['led:' + key] = setTimeout(function () {
      self._timers['led:' + key] = 0;
      if (typeof bv.holdLed === 'function') bv.holdLed(key, false);
      bv.invalidateLed(key);
      self._restore();
    }, LED_MS);
    return true;
  };

  TapFeedback.prototype._tapSeg = function (segId) {
    var bv = this.boardView;
    if (!bv || !segId || !bv.segGroups || !bv.segGroups[segId]) return false;
    var self = this;
    // 同 LED：先全亮、再挂起该管的 update() 刷写，防止一帧内被打回
    bv.setSegment(segId, { a: true, b: true, c: true, d: true, e: true, f: true, g: true, dp: true });
    if (typeof bv.holdSeg === 'function') bv.holdSeg(segId, true);
    this._status('试点亮 ' + segId + '（' + SEG_MS + 'ms 后按实际状态恢复）');
    clearTimeout(this._timers['seg:' + segId]);
    this._timers['seg:' + segId] = setTimeout(function () {
      self._timers['seg:' + segId] = 0;
      if (typeof bv.holdSeg === 'function') bv.holdSeg(segId, false);
      bv.invalidateSeg(segId);
      self._restore();
    }, SEG_MS);
    return true;
  };

  TapFeedback.prototype._tapBuzzer = function () {
    if (DLab.Sound && typeof DLab.Sound.beep === 'function') {
      DLab.Sound.beep(BEEP_MS);          // 默认蜂鸣器自振频率
    }
    if (this.onBuzzerRipple) this.onBuzzerRipple(BEEP_MS + 140);
    this._status('蜂鸣器试鸣（' + BEEP_MS + 'ms）');
    return true;
  };

  TapFeedback.prototype._tapSpk = function () {
    if (DLab.Sound && typeof DLab.Sound.beep === 'function') {
      DLab.Sound.beep(SPK_TEST_MS, SPK_TEST_HZ);
    }
    this._status('功放试听：' + SPK_TEST_HZ + 'Hz');
    return true;
  };

  TapFeedback.prototype._tapDds = function () {
    var freq = null;
    try {
      if (typeof this.engine.getDds === 'function') {
        freq = this.engine.getDds().freqHz;
      }
    } catch (err) {
      freq = null;
    }
    if (DLab.Sound && typeof DLab.Sound.beep === 'function') {
      var audible = freq ? Math.min(AUDIBLE_MAX_HZ, Math.max(AUDIBLE_MIN_HZ, freq)) : 1000;
      DLab.Sound.beep(DDS_TEST_MS, audible);
      if (freq && audible !== freq) {
        this._status('信号源试听：' + freq + 'Hz 超出扬声器可听域，按 ' + audible + 'Hz 播放');
      } else {
        this._status('信号源试听：' + (freq ? freq + 'Hz' : '默认 1kHz'));
      }
      // 顺带闪一下「频率」指示灯，提示读的是当前 DDS 参数
      var self = this;
      var bv = this.boardView;
      if (bv && bv.ledNodes && bv.ledNodes['dds:FREQ']) {
        bv.setLed('dds:FREQ', true);          // 先点亮再挂起，同 _tapLed
        if (typeof bv.holdLed === 'function') bv.holdLed('dds:FREQ', true);
        clearTimeout(this._timers['led:dds:FREQ']);
        this._timers['led:dds:FREQ'] = setTimeout(function () {
          self._timers['led:dds:FREQ'] = 0;
          if (typeof bv.holdLed === 'function') bv.holdLed('dds:FREQ', false);
          bv.invalidateLed('dds:FREQ');
          self._restore();
        }, LED_MS);
      }
    }
    return true;
  };

  /** 展示结束：按引擎当前真实状态重画（只读，不改电气状态） */
  TapFeedback.prototype._restore = function () {
    var state = null;
    try {
      state = this.engine.getState();
    } catch (err) {
      state = null;
    }
    if (!state) return;
    if (this.applyState) {
      this.applyState(state);
    } else if (this.boardView) {
      this.boardView.update(state);
    }
  };

  TapFeedback.prototype._status = function (text, level) {
    if (this.hud && typeof this.hud.setStatus === 'function') {
      this.hud.setStatus(text, level || 'info');
    }
  };

  /** 供自测 / 调试 */
  TapFeedback.prototype.getSnapshot = function () {
    return { host: !!this._host };
  };

  TapFeedback.prototype.destroy = function () {
    for (var i = 0; i < this._bound.length; i++) {
      this._bound[i].target.removeEventListener(this._bound[i].type, this._bound[i].fn);
    }
    this._bound.length = 0;
    for (var k in this._timers) {
      if (Object.prototype.hasOwnProperty.call(this._timers, k)) {
        clearTimeout(this._timers[k]);
      }
    }
    this._timers = Object.create(null);
    if (this._host && this._host.parentNode) {
      this._host.parentNode.removeChild(this._host);
    }
    this._host = null;
  };

  TapFeedback.LED_MS = LED_MS;
  TapFeedback.SEG_MS = SEG_MS;

  DLab.TapFeedback = TapFeedback;
})(typeof globalThis !== 'undefined' ? globalThis : this);

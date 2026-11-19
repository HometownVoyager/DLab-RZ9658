// src/ui/timeline.js
// 时序控制面板（虚拟时间轴）：运行 / 暂停 / 单步 / 复位时间 / 速度三档 / 时钟使能。
// 核心职责是把「真实时间」换算成「虚拟时间」，由本模块独占调用 engine.step(虚拟毫秒)，
// 这样 74LS74 / 74LS112 / 74LS160 / 74LS161 / 74LS194 / 74LS273 这类时序芯片才能被真正驱动。
// 本文件只负责时间推进与面板控件，不碰飞线、不碰芯片装配（那些属于 Interaction / app.js）。
(function (global) {
  'use strict';
  var DLab = (global.DLab = global.DLab || {});

  /* ============================================================
   * 1. 常量
   * ============================================================ */

  /** 一个「逻辑拍」对应的虚拟毫秒数：每推进一拍，虚拟时间前进 10ms */
  var STEP_MS = 10;
  /** 每帧最多推进的逻辑拍数（切后台/长任务回来后防止一次性补算卡死的兜底上限） */
  var MAX_STEPS_PER_FRAME = 200;
  /**
   * 每帧给引擎 step 的真实时间预算（ms）（H6，2026-10-30 性能审查遗留项）。
   * 旧实现只有 200 拍硬上限：重载电路单拍 ~0.5ms 时最坏帧 46~116ms，必然掉帧。
   * 改为预算制后单帧推进耗时被收敛到本预算附近，剩余积压留给后续帧消化
   * （积压封顶 MAX_BACKLOG_MS，防止长期超载下无界滞后）。
   * 设为 0 可禁用预算（自测需要确定性时用）；MAX_STEPS_PER_FRAME 仍是拍数兜底。
   */
  var STEP_BUDGET_MS = 7;
  /** 帧预算触顶后允许保留的最大虚拟时间积压（ms），超出部分丢弃 */
  var MAX_BACKLOG_MS = 2000;
  /** 面板上的三档仿真速度（虚拟时间相对真实时间的倍率，同时也是每秒逻辑拍数的换算基准） */
  var SPEED_STEPS = [1, 10, 100];
  /** 默认速度：1 倍，即虚拟时间与真实时间同速 */
  var DEFAULT_SPEED = 1;
  /** 速度允许范围（倍率），超出范围时钳制 */
  var MIN_SPEED = 1;
  var MAX_SPEED = 1000;
  /** 虚拟时间读数保留的小数位（单位 s） */
  var TIME_DECIMALS = 2;

  /* ============================================================
   * 2. DOM 适配层
   *    所有 DOM 访问都集中在这里；Node 环境（无 document）下自动退化为空操作，
   *    保证时间累加、速度换算、状态机等纯逻辑可以在自测里直接跑，不需要 jsdom。
   * ============================================================ */

  /** 真实文档引用；Node 环境下为 null */
  var doc = (typeof document !== 'undefined' && document) ? document : null;

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** 翻译辅助：无 i18n 模块（Node 自测）时原样返回中文回退 */
  function tr(key, params, fallback) {
    return (DLab.i18n && typeof DLab.i18n.t === 'function')
      ? DLab.i18n.t(key, params, fallback) : fallback;
  }

  /** 默认 DOM 适配层（可通过构造参数 options.dom 注入替身） */
  var DefaultDom = {
    /** 当前环境是否具备真实 DOM 能力 */
    available: function () {
      return !!(doc && typeof doc.createElement === 'function');
    },
    /**
     * 创建元素。
     * @param {string} tag 标签名
     * @param {Object} [attrs] 属性表；className 直接赋值，text 写入文本，其余走 setAttribute
     * @param {string} [text] 文本内容
     * @returns {HTMLElement|null} 无 DOM 环境返回 null
     */
    create: function (tag, attrs, text) {
      if (!DefaultDom.available()) {
        return null;
      }
      var node = doc.createElement(tag);
      if (attrs) {
        for (var k in attrs) {
          if (!hasOwn(attrs, k)) {
            continue;
          }
          if (k === 'className') {
            node.className = attrs[k];
          } else if (k === 'text') {
            node.textContent = attrs[k];
          } else {
            node.setAttribute(k, String(attrs[k]));
          }
        }
      }
      if (text !== undefined && text !== null) {
        node.textContent = text;
      }
      return node;
    },
    /** 绑定事件（无 DOM 时静默跳过） */
    on: function (node, type, fn) {
      if (!node || typeof node.addEventListener !== 'function') {
        return false;
      }
      node.addEventListener(type, fn, false);
      return true;
    }
  };

  /* ============================================================
   * 3. 工具
   * ============================================================ */

  /** 取单调递增的真实毫秒时间戳（优先 performance.now） */
  function realNow() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  /** 虚拟毫秒 -> 面板读数文本（保留两位小数，单位 s） */
  function formatSeconds(virtualMs) {
    var v = Number(virtualMs);
    if (!isFinite(v)) {
      v = 0;
    }
    return (v / 1000).toFixed(TIME_DECIMALS) + ' s';
  }

  /* ============================================================
   * 4. 构造
   * ============================================================ */

  /**
   * @param {Object} options
   * @param {Object} options.engine       DLab.Engine 实例（必填）
   * @param {HTMLElement} [options.container] 面板容器（index.html 里的 #timeline）
   * @param {Function} [options.onState]  每次推进结束后回调 (state)，供 app.js 刷新面板
   * @param {Object} [options.dom]        DOM 适配层替身（自测用，默认用内置实现）
   */
  function Timeline(options) {
    options = options || {};
    if (!options.engine) {
      throw new Error('Timeline：缺少 engine');
    }

    this.engine = options.engine;
    this.container = options.container || null;
    this.onState = typeof options.onState === 'function' ? options.onState : null;
    this.dom = options.dom || DefaultDom;

    // ---- 时间状态 ----
    this.running = false;      // 是否处于「运行」态（暂停时不再推进）
    this.speed = DEFAULT_SPEED;// 仿真速度（虚拟时间倍率）
    this.virtualTime = 0;      // 当前虚拟毫秒
    this.steps = 0;            // 累计推进的逻辑拍数
    this.acc = 0;              // 真实时间 x 速度的累加器（毫秒），凑满 STEP_MS 推进一拍

    // ---- H6 帧预算（可用 options.frameBudgetMs 覆盖；0 = 禁用）----
    this.frameBudgetMs = (typeof options.frameBudgetMs === 'number' && options.frameBudgetMs >= 0)
      ? options.frameBudgetMs
      : STEP_BUDGET_MS;

    // ---- 循环 / 所有权 ----
    this.started = false;      // rAF 循环是否已启动
    this._owner = false;       // 是否已接管时钟推进（供 app.js 判断要不要让 Interaction 停手）
    this._rafId = 0;
    this._lastFrameTs = 0;
    this._lastError = null;
    this._nodes = null;

    // ---- 推进函数：默认直接调用 engine.step，可被 setEngineStepper 替换 ----
    // 这里先把 engine.step 的原始引用存下来。原因：app.js 为了让 Interaction 的 rAF 循环
    // 不再按真实时间推进，可能会给 engine.step 打一个「已接管就空转」的补丁；
    // 本模块必须始终拿得到原始方法，否则会被自己的补丁拦住而推不动引擎。
    this._rawStep = (this.engine && typeof this.engine.step === 'function') ? this.engine.step : null;

    var self = this;
    this._defaultStepper = function (virtualMs) {
      if (self._rawStep) {
        self._rawStep.call(self.engine, virtualMs);
      }
    };
    this._stepper = this._defaultStepper;

    this._build();
    this.refresh();

    // 语言切换后从自身状态重建控件文案
    var self = this;
    if (DLab.i18n && typeof DLab.i18n.onChange === 'function') {
      DLab.i18n.onChange(function () {
        self._build();
        self.refresh();
      });
    }
  }

  /* ============================================================
   * 5. 面板 DOM
   * ============================================================ */

  /**
   * 在 container 内自建一行横向控件（不依赖外部模板）。
   * 结构：[时序控制] 运行/暂停 单步 复位时间 | 速度 1x 10x 100x | 时钟使能 checkbox | 虚拟时间 0.00 s
   * 控件复用 styles/wires.css 的 .hud-btn / .hud-group / .hud-toggle，保持与底部工具栏一致。
   */
  Timeline.prototype._build = function () {
    var dom = this.dom;
    if (!this.container || !dom.available()) {
      this._nodes = null;
      return;
    }

    var self = this;
    var root = this.container;
    // 容器带 .hud 类，这样 wires.css 里的 .hud-btn / .hud-group / .hud-toggle 才能命中
    root.classList.add('timeline');
    root.classList.add('hud');
    root.textContent = '';

    var nodes = {};

    // —— 主控件行 ——
    var row = dom.create('div', { className: 'hud-group timeline-row' });
    row.appendChild(dom.create('span', { className: 'hud-label' }, tr('timeline.label.title', null, '时序控制')));

    nodes.runBtn = dom.create('button', {
      type: 'button',
      className: 'hud-btn timeline-btn-run',
      'data-act': 'run',
      title: tr('timeline.title.run', null, '开始 / 暂停虚拟时间推进')
    }, tr('timeline.label.run', null, '运行'));

    nodes.stepBtn = dom.create('button', {
      type: 'button',
      className: 'hud-btn timeline-btn-step',
      'data-act': 'step',
      title: tr('timeline.title.step', null, '手动推进一个逻辑拍（虚拟时间 +10ms）')
    }, tr('timeline.label.step', null, '单步'));

    nodes.resetBtn = dom.create('button', {
      type: 'button',
      className: 'hud-btn timeline-btn-reset',
      'data-act': 'reset',
      title: tr('timeline.title.reset', null, '虚拟时间归零并重新求值')
    }, tr('timeline.label.reset', null, '复位时间'));

    row.appendChild(nodes.runBtn);
    row.appendChild(nodes.stepBtn);
    row.appendChild(nodes.resetBtn);

    // —— 速度三档 ——
    var speedGroup = dom.create('div', { className: 'hud-group timeline-speed' });
    speedGroup.appendChild(dom.create('span', { className: 'hud-label' }, tr('timeline.label.speed', null, '速度')));
    nodes.speedBtns = [];
    for (var i = 0; i < SPEED_STEPS.length; i++) {
      var hz = SPEED_STEPS[i];
      var btn = dom.create('button', {
        type: 'button',
        className: 'hud-btn timeline-btn-speed',
        'data-act': 'speed',
        'data-speed': String(hz),
        title: tr('timeline.title.speed', { hz: hz }, '仿真速度 ' + hz + ' 倍：1 秒真实时间推进 ' + hz + ' 秒虚拟时间')
      }, hz + 'x');
      nodes.speedBtns.push(btn);
      speedGroup.appendChild(btn);
    }
    row.appendChild(speedGroup);

    // —— 时钟使能 ——
    var clockLabel = dom.create('label', {
      className: 'hud-toggle',
      title: tr('timeline.title.clockEnable', null, '勾选 = 时钟输出区有信号；取消 = 时钟插孔呈高阻')
    });
    nodes.clockInput = dom.create('input', {
      type: 'checkbox',
      className: 'timeline-clock-input',
      'data-act': 'clock'
    });
    clockLabel.appendChild(nodes.clockInput);
    clockLabel.appendChild(dom.create('span', { className: 'hud-toggle-text' }, tr('timeline.label.clockEnable', null, '时钟使能')));
    row.appendChild(clockLabel);

    // —— 虚拟时间读数 ——
    nodes.timeEl = dom.create('span', {
      className: 'hud-chip timeline-time',
      title: tr('timeline.label.virtualTime', null, '虚拟时间（秒）')
    }, formatSeconds(0));
    row.appendChild(nodes.timeEl);

    root.appendChild(row);
    this._nodes = nodes;

    // —— 事件（容器委托，便于日后重建按钮而不必重绑）——
    dom.on(row, 'click', function (e) {
      var target = e && e.target;
      var act = target && target.getAttribute ? target.getAttribute('data-act') : null;
      if (!act) {
        return;
      }
      if (act === 'run') {
        self.toggleRunning();
      } else if (act === 'step') {
        self.stepOnce();
      } else if (act === 'reset') {
        self.resetTime();
      } else if (act === 'speed') {
        self.setSpeed(Number(target.getAttribute('data-speed')));
      }
    });

    dom.on(nodes.clockInput, 'change', function () {
      self.setClockEnabled(!!nodes.clockInput.checked);
    });
  };

  /** 同步控件外观：运行态按钮文字 / aria-pressed、速度档高亮、时钟勾选、时间读数 */
  Timeline.prototype.refresh = function () {
    var n = this._nodes;
    if (!n) {
      return this;
    }
    var running = !!this.running;

    if (n.runBtn) {
      n.runBtn.textContent = running ? tr('timeline.label.pause', null, '暂停') : tr('timeline.label.run', null, '运行');
      n.runBtn.setAttribute('aria-pressed', running ? 'true' : 'false');
      n.runBtn.classList.toggle('is-active', running);
    }

    if (n.speedBtns) {
      for (var i = 0; i < n.speedBtns.length; i++) {
        var hz = Number(n.speedBtns[i].getAttribute('data-speed'));
        var active = Math.abs(hz - this.speed) < 1e-9;
        n.speedBtns[i].setAttribute('aria-pressed', active ? 'true' : 'false');
        n.speedBtns[i].classList.toggle('is-active', active);
      }
    }

    if (n.clockInput) {
      var on = this.isClockEnabled();
      if (n.clockInput.checked !== on) {
        n.clockInput.checked = on;
      }
    }

    this._syncTimeLabel();
    return this;
  };

  /** 只同步虚拟时间读数（每帧都会调，避免整块控件重排） */
  Timeline.prototype._syncTimeLabel = function () {
    var n = this._nodes;
    if (!n || !n.timeEl) {
      return;
    }
    n.timeEl.textContent = formatSeconds(this.virtualTime);
  };

  /* ============================================================
   * 6. 推进核心
   * ============================================================ */

  /** 用当前推进函数把引擎推到指定虚拟时刻；异常只记录不抛出，避免一帧出错整个面板卡死 */
  Timeline.prototype._advance = function (virtualMs) {
    try {
      this._stepper(virtualMs);
      this._lastError = null;
      return true;
    } catch (err) {
      this._lastError = err || new Error('未知错误');
      return false;
    }
  };

  /** 取引擎最新状态并回调 onState（回调异常同样不影响循环） */
  Timeline.prototype._emitState = function () {
    if (typeof this.onState !== 'function') {
      return null;
    }
    var state = null;
    try {
      state = this.engine.getState();
    } catch (err) {
      state = null;
    }
    try {
      this.onState(state);
    } catch (err) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[DLab.Timeline] onState 回调异常：', err);
      }
    }
    return state;
  };

  /**
   * 推进虚拟时间（rAF 与自测共用的纯入口，不依赖 requestAnimationFrame）。
   * 换算关系：acc += 真实毫秒 x 速度；每凑满 STEP_MS 就推进一拍。
   * 因此 speed=1 时虚拟时间与真实时间同速，speed=10 时快 10 倍。
   * @param {number} realDeltaMs 距上一帧的真实毫秒数
   * @returns {number} 本次实际推进的逻辑拍数
   */
  Timeline.prototype._tickWithDelta = function (realDeltaMs) {
    if (!this.running) {
      return 0;
    }
    var delta = Number(realDeltaMs);
    if (!isFinite(delta) || delta <= 0) {
      delta = 0;
    }

    this.acc += delta * this.speed;

    var budgeted = this.frameBudgetMs > 0;
    var frameStart = budgeted ? realNow() : 0;
    var ticks = 0;
    while (this.acc >= STEP_MS && ticks < MAX_STEPS_PER_FRAME) {
      if (budgeted && ticks > 0 && realNow() - frameStart >= this.frameBudgetMs) {
        // H6：预算耗尽——剩余积压留给后续帧消化，但封顶防止长期超载下无界滞后
        if (this.acc > MAX_BACKLOG_MS) {
          this.acc = MAX_BACKLOG_MS;
        }
        break;
      }
      this.acc -= STEP_MS;
      this.virtualTime += STEP_MS;
      this.steps += 1;
      ticks += 1;
      this._advance(this.virtualTime);
    }

    if (ticks >= MAX_STEPS_PER_FRAME) {
      // 拍数兜底触顶：丢弃积压的虚拟时间，避免下一帧继续追赶形成「越追越慢」的死循环
      this.acc = 0;
    }

    if (ticks > 0) {
      this._syncTimeLabel();
      this._emitState();
    }
    return ticks;
  };

  /** 单步：虚拟时间前进一拍并立即求值（暂停态也可用） */
  Timeline.prototype.stepOnce = function () {
    this.virtualTime += STEP_MS;
    this.steps += 1;
    this.acc = 0;                     // 单步后清空累加器，避免下一帧立刻补拍
    this._advance(this.virtualTime);
    this._syncTimeLabel();
    this._emitState();
    return this.virtualTime;
  };

  /** 虚拟时间归零并重新求值（不清导线、不清芯片） */
  Timeline.prototype.resetTime = function () {
    this.virtualTime = 0;
    this.steps = 0;
    this.acc = 0;
    this._advance(0);
    this._syncTimeLabel();
    this._emitState();
    return this.virtualTime;
  };

  /* ============================================================
   * 7. 生命周期与所有权
   * ============================================================ */

  /**
   * 启动内部 rAF 循环并接管时钟推进。
   * 拿到控制权后把自己的推进函数注入引擎（引擎若提供 setEngineStepper 钩子）。
   */
  Timeline.prototype.start = function () {
    if (this.started) {
      return this;
    }
    this.started = true;
    this._owner = true;
    this._lastFrameTs = 0;

    // 拿到控制权：把自己的推进函数注入引擎，供引擎侧（如 Interaction 的循环）识别
    this._pushStepperToEngine(this._stepper);

    this._loop();
    this.refresh();
    return this;
  };

  /** 停止 rAF 循环并交还控制权（同时退出运行态） */
  Timeline.prototype.stop = function () {
    this.started = false;
    this._owner = false;
    this.running = false;
    if (this._rafId && typeof global.cancelAnimationFrame === 'function') {
      global.cancelAnimationFrame(this._rafId);
    }
    this._rafId = 0;
    this._lastFrameTs = 0;
    // 交还控制权：清掉引擎侧钩子，恢复默认推进方式
    this._pushStepperToEngine(null);
    this.refresh();
    return this;
  };

  /** 是否已接管时钟推进：app.js 据此决定要不要让 Interaction 停止按真实时间推进 */
  Timeline.prototype.isOwner = function () {
    return !!this._owner;
  };

  /** rAF 循环（Node 环境无 requestAnimationFrame 时自动跳过，只保留纯逻辑） */
  Timeline.prototype._loop = function () {
    var self = this;
    if (typeof global.requestAnimationFrame !== 'function') {
      this._rafId = 0;
      return;
    }
    function frame(ts) {
      if (!self.started) {
        return;
      }
      var now = typeof ts === 'number' ? ts : realNow();
      var delta = self._lastFrameTs ? now - self._lastFrameTs : 0;
      self._lastFrameTs = now;
      if (!(delta > 0)) {
        delta = 0;
      }
      self._tickWithDelta(delta);
      self._rafId = global.requestAnimationFrame(frame);
    }
    this._rafId = global.requestAnimationFrame(frame);
  };

  /* ============================================================
   * 8. 运行态 / 速度
   * ============================================================ */

  /** 设置运行态；首次进入运行态会自动启动 rAF 循环 */
  Timeline.prototype.setRunning = function (on) {
    var next = !!on;
    if (next === this.running) {
      this.refresh();
      return this.running;
    }
    this.running = next;
    // 恢复运行时重置时间基准与累加器，避免暂停期间的真实时间被一次性补算
    this._lastFrameTs = 0;
    this.acc = 0;
    if (next && !this.started) {
      this.start();
    }
    this.refresh();
    return this.running;
  };

  Timeline.prototype.isRunning = function () {
    return !!this.running;
  };

  /** 运行 / 暂停切换 */
  Timeline.prototype.toggleRunning = function () {
    return this.setRunning(!this.running);
  };

  /**
   * 设置仿真速度（虚拟时间倍率），允许 1~1000，非法值忽略、越界钳制。
   * @param {number} hz
   * @returns {number} 生效后的速度
   */
  Timeline.prototype.setSpeed = function (hz) {
    var v = Number(hz);
    if (!isFinite(v) || v <= 0) {
      return this.speed;                       // 非法值忽略，保持原速
    }
    if (v < MIN_SPEED) {
      v = MIN_SPEED;
    } else if (v > MAX_SPEED) {
      v = MAX_SPEED;
    }
    this.speed = v;
    this.refresh();
    return this.speed;
  };

  Timeline.prototype.getSpeed = function () {
    return this.speed;
  };

  /* ============================================================
   * 9. 引擎透传
   * ============================================================ */

  /** 时钟输出区使能（勾选 = 时钟插孔有信号） */
  Timeline.prototype.setClockEnabled = function (on) {
    var eng = this.engine;
    if (eng && typeof eng.setClockEnabled === 'function') {
      eng.setClockEnabled(!!on);
    }
    this.refresh();
    return this.isClockEnabled();
  };

  Timeline.prototype.isClockEnabled = function () {
    var eng = this.engine;
    if (eng && typeof eng.getClockEnabled === 'function') {
      return !!eng.getClockEnabled();
    }
    return false;
  };

  /** 单脉冲按键透传（脉冲宽度按虚拟时间计算） */
  Timeline.prototype.pressPulse = function (n) {
    var eng = this.engine;
    if (eng && typeof eng.pressPulse === 'function') {
      return eng.pressPulse(n);
    }
    return false;
  };

  /* ============================================================
   * 10. 推进函数注入与快照
   * ============================================================ */

  /**
   * 注入自定义推进函数（默认实现是直接 engine.step）。
   * app.js 若需要「推进 + 额外刷新」合并成一步，可在这里替换。
   * @param {Function|null} fn 形如 function (virtualMs) {}；传 null 恢复默认
   * @returns {Function} 当前生效的推进函数
   */
  Timeline.prototype.setEngineStepper = function (fn) {
    this._stepper = typeof fn === 'function' ? fn : this._defaultStepper;
    // 已接管时同步给引擎侧的钩子，保证引擎拿到的永远是最新推进函数
    if (this._owner) {
      this._pushStepperToEngine(this._stepper);
    }
    return this._stepper;
  };

  /** 把当前推进函数推给引擎（引擎没有 setEngineStepper 钩子时静默跳过） */
  Timeline.prototype._pushStepperToEngine = function (fn) {
    var eng = this.engine;
    if (!eng || typeof eng.setEngineStepper !== 'function') {
      return false;
    }
    try {
      eng.setEngineStepper(fn);
      return true;
    } catch (err) {
      return false;
    }
  };

  Timeline.prototype.getEngineStepper = function () {
    return this._stepper;
  };

  /**
   * 引擎原始的 step 方法（未被任何补丁包装过的引用）。
   * app.js 若要给 engine.step 打「已接管就空转」的补丁，请先用它把原方法存下来，
   * 否则补丁会连 Timeline 自己的推进一起拦住。
   * @returns {Function|null}
   */
  Timeline.prototype.getOriginalStep = function () {
    return this._rawStep;
  };

  /** 当前虚拟毫秒 */
  Timeline.prototype.getVirtualTime = function () {
    return this.virtualTime;
  };

  /** 最近一次推进时引擎抛出的异常（正常为 null），供 UI 层提示 */
  Timeline.prototype.getLastError = function () {
    return this._lastError;
  };

  /** 状态快照（供自测与调试） */
  Timeline.prototype.getSnapshot = function () {
    return {
      running: this.running,
      speed: this.speed,
      virtualTime: this.virtualTime,
      clockEnabled: this.isClockEnabled(),
      steps: this.steps
    };
  };

  /* ============================================================
   * 11. 静态常量（供 app.js / 自测引用）
   * ============================================================ */

  Timeline.STEP_MS = STEP_MS;
  Timeline.MAX_STEPS_PER_FRAME = MAX_STEPS_PER_FRAME;
  Timeline.STEP_BUDGET_MS = STEP_BUDGET_MS;
  Timeline.MAX_BACKLOG_MS = MAX_BACKLOG_MS;
  Timeline.SPEED_STEPS = SPEED_STEPS.slice();
  Timeline.DEFAULT_SPEED = DEFAULT_SPEED;
  Timeline.MIN_SPEED = MIN_SPEED;
  Timeline.MAX_SPEED = MAX_SPEED;
  Timeline.DomAdapter = DefaultDom;

  DLab.Timeline = Timeline;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// src/core/engine.js
// DLab.Engine：实验箱仿真引擎（纯同步、无 DOM 依赖，可在 Node 中直接 new 出来跑测试）
// 职责：板载驱动源（电源 / 开关 / 时钟 / 单脉冲）、导线网表、芯片插座求值、显示状态汇总。
(function (global) {
  'use strict';

  var DLab = (global.DLab = global.DLab || {});
  var Logic = DLab.Logic;
  var Chips = DLab.Chips;
  // 板内固定铜箔走线模型（可选依赖：未加载时引擎行为与之前完全一致）
  var BoardNets = DLab.BoardNets || null;
  if (!Logic) throw new Error('engine.js 依赖 logic.js，请先加载 src/core/logic.js');
  if (!Chips) throw new Error('engine.js 依赖 chips.js，请先加载 src/core/chips.js');

  var L0 = '0';
  var L1 = '1';
  var LZ = 'Z';
  var LX = 'X';

  /* ============================================================
   * 1. 板载资源规格
   * ============================================================ */

  /** 时钟输出区的固定频率（Hz）；CONT = 连续脉冲输出，按 1Hz 方波处理 */
  var CLOCK_FREQS = {
    '1HZ': 1,
    '2HZ': 2,
    '4HZ': 4,
    '8HZ': 8,
    '1KHZ': 1000,
    '10KHZ': 10000,
    '1MHZ': 1000000,
    'CONT': 1
  };

  /**
   * 时序芯片的时钟引脚号（P2 混叠告警检测用）。
   * 74LS74: 1CLK=3 / 2CLK=11；74LS112: 1CLK=4 / 2CLK=12（沿用本库当前引脚版，
   * 若实验指导书核实为其它引脚版，需与 chips.js 的 pinNames 同步修改）；
   * 74LS160/161: CLK=2；74LS194: CLK=11；74LS273: CLK=11。
   */
  var SEQ_CLOCK_PINS = {
    '74LS74': [3, 11],
    '74LS112': [4, 12],
    '74LS160': [2],
    '74LS161': [2],
    '74LS194': [11],
    '74LS273': [11]
  };

  /** 默认仿真步长（ms）。Timeline 以 STEP_MS=10 推进；实际步长由 step() 观测更新 */
  var DEFAULT_STEP_MS = 10;
  /** step() 观测步长的最大可信间隔（ms）：超过视为手动跳变推进，不更新观测值 */
  var MAX_TRACK_DT_MS = 500;
  /** P3：SPK 测频保留的最近边沿数（滑动窗口） */
  var SPK_EDGE_KEEP = 8;
  /** P3：判定音调所需的最少边沿数（4 条边沿 = 2 个完整周期） */
  var SPK_MIN_EDGES = 4;

  /** 单脉冲按键个数 */
  var PULSE_COUNT = 6;
  /** 单脉冲宽度（毫秒） */
  var PULSE_WIDTH_MS = 200;

  /* ============================================================
   * 板载仪器规格（与南京润众 RZ9658 实物对齐）
   *   - 逻辑笔：SW1 拨动开关选择 TTL / CMOS 判读；悬空输入在 TTL 模式按
   *     「浮空为高」处理，CMOS 模式按高阻处理（面板三灯：高电平/低电平/高阻）。
   *   - 信号源 DDS：2SS1 编码器选择并调节 频率 / 幅度 / 波形（方波|脉冲）；
   *     幅度低于 TTL 阈值时输出恒为低电平（驱动无效）。
   *   - 电位器：1/3 脚为两端、2 脚为滑动端；滑动端按分压模型输出，
   *     负载按高阻处理，判读阈值同 TTL。
   *   - 蜂鸣器：有源器件，输入高电平即鸣叫（板载音频在 UI 层用 WebAudio 合成）。
   * ============================================================ */

  /** DDS 频率序列（1-2-5 十进），范围 1Hz ~ 1MHz */
  var DDS_FREQ_STEPS = [1, 2, 5];
  var DDS_FREQ_MIN = 1;
  var DDS_FREQ_MAX = 1000000;
  /** DDS 幅度步进与范围（V） */
  var DDS_AMP_STEP = 0.5;
  var DDS_AMP_MIN = 0;
  var DDS_AMP_MAX = 5;
  /** DDS 输出达到 TTL 高电平的最小幅度（V） */
  var DDS_TTL_THRESHOLD = 2.5;
  /** 脉冲波形的占空比（每个周期内高电平占比，钳制在 0.05ms ~ 500ms） */
  var DDS_PULSE_DUTY = 0.1;
  /** 逻辑笔判读模式 */
  var PROBE_MODES = ['TTL', 'CMOS'];
  /** 电位器两端电压满量程（V）与数字判读阈值（V） */
  var POT_VMAX = 5;
  var POT_THRESHOLD = 2.5;
  /** 有源蜂鸣器自振频率（Hz，供 UI 层合成音色） */
  var BUZZER_TONE_HZ = 2700;

  /** 开关 / 指示灯 / 数码管数量 */
  var SW_COUNT = 16;
  var LED_COUNT = 16;
  var SEG_COUNT = 8;

  /**
   * 插座规格：插座后缀字母 -> 引脚数。
   * 依据 CONTRACTS 4.2：devA:UA 第 n 脚 <-> 插孔 devA:A<n>，其余字母同理。
   */
  var SOCKET_SPEC = {
    UA: 14, UB: 14,   // 14 脚
    UE: 16, UD: 16,   // 16 脚
    UF: 20            // 20 脚
  };

  /** 迭代求值上限（组合环路的收敛保护） */
  var MAX_ITER = 24;

  /** 各数码管的段孔映射：seg1/seg2 有 8 段，seg3~seg8 只有 a/b/c/d/dp 五个段孔 */
  var SEG_LAYOUT = {
    seg1: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'],
    seg2: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'],
    seg3: ['a', 'b', 'c', 'd', 'dp'],
    seg4: ['a', 'b', 'c', 'd', 'dp'],
    seg5: ['a', 'b', 'c', 'd', 'dp'],
    seg6: ['a', 'b', 'c', 'd', 'dp'],
    seg7: ['a', 'b', 'c', 'd', 'dp'],
    seg8: ['a', 'b', 'c', 'd', 'dp']
  };

  /** 段名 -> 面板丝印前缀（A1/B1/... DP1） */
  var SEG_LABEL_PREFIX = {
    a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', f: 'F', g: 'G', dp: 'DP'
  };

  /** 数码管极性：seg1 = 共阳（段电平 0 点亮）；seg2 = 共阴（段电平 1 点亮） */
  var SEG_ANODE = { seg1: true };

  /**
   * 7段数码管标准十六进制字形译码表（0..15 对应 '0'~'9', 'A', 'b', 'C', 'd', 'E', 'F'）。
   * 笔段顺序：a, b, c, d, e, f, g（true 为点亮）。
   */
  var HEX_SEG_DECODE = [
    { a: true,  b: true,  c: true,  d: true,  e: true,  f: true,  g: false }, // 0
    { a: false, b: true,  c: true,  d: false, e: false, f: false, g: false }, // 1
    { a: true,  b: true,  c: false, d: true,  e: true,  f: false, g: true  }, // 2
    { a: true,  b: true,  c: true,  d: true,  e: false, f: false, g: true  }, // 3
    { a: false, b: true,  c: true,  d: false, e: false, f: true,  g: true  }, // 4
    { a: true,  b: false, c: true,  d: true,  e: false, f: true,  g: true  }, // 5
    { a: true,  b: false, c: true,  d: true,  e: true,  f: true,  g: true  }, // 6
    { a: true,  b: true,  c: true,  d: false, e: false, f: false, g: false }, // 7
    { a: true,  b: true,  c: true,  d: true,  e: true,  f: true,  g: true  }, // 8
    { a: true,  b: true,  c: true,  d: true,  e: false, f: true,  g: true  }, // 9
    { a: true,  b: true,  c: true,  d: false, e: true,  f: true,  g: true  }, // A
    { a: false, b: false, c: true,  d: true,  e: true,  f: true,  g: true  }, // b
    { a: true,  b: false, c: false, d: true,  e: true,  f: true,  g: false }, // C
    { a: false, b: true,  c: true,  d: true,  e: true,  f: false, g: true  }, // d
    { a: true,  b: false, c: false, d: true,  e: true,  f: true,  g: true  }, // E
    { a: true,  b: false, c: false, d: false, e: true,  f: true,  g: true  }  // F
  ];
  var HEX_DIGIT_CHARS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'b', 'C', 'd', 'E', 'F'];

  /* ============================================================
   * 2. 内置回退几何（geometry 缺失时兜底，保证引擎永远可用）
   * ============================================================ */

  /**
   * 生成一份最小可用的插孔表。
   * 仅当构造引擎时既没传 geometry、全局也没有 DLab.geometry 时使用。
   */
  function buildFallbackGeometry() {
    var jacks = {};
    var order = [];

    function add(moduleId, label, kind, fixedNet) {
      var id = moduleId + ':' + label;
      jacks[id] = {
        id: id, label: label, moduleId: moduleId,
        x: 0, y: 0, kind: kind || 'passive', fixedNet: fixedNet || null
      };
      order.push(id);
    }

    var i;
    add('probe', 'P01', 'driver');
    add('rc', '1', 'passive'); add('rc', '2', 'passive'); add('rc', '3', 'passive');
    for (i = 1; i <= LED_COUNT; i++) add('led', '4P' + i, 'sink');
    for (i = 1; i <= SEG_COUNT; i++) {
      var seg = 'seg' + i;
      var segs = SEG_LAYOUT[seg];
      for (var s = 0; s < segs.length; s++) add(seg, SEG_LABEL_PREFIX[segs[s]] + i, 'sink');
    }
    var devs = ['devA', 'devB'];
    for (var d = 0; d < devs.length; d++) {
      var m = devs[d];
      for (i = 1; i <= 14; i++) add(m, 'A' + i, 'passive');
      for (i = 1; i <= 14; i++) add(m, 'B' + i, 'passive');
      for (i = 1; i <= 16; i++) add(m, 'E' + i, 'passive');
      for (i = 1; i <= 16; i++) add(m, 'D' + i, 'passive');
      for (i = 1; i <= 20; i++) add(m, 'F' + i, 'passive');
      add(m, 'VCC', 'power', 'VCC');
      add(m, 'GND', 'ground', 'GND');
    }
    for (i = 1; i <= PULSE_COUNT; i++) {
      add('pulse', '6K' + i + '-', 'driver');
      add('pulse', '6K' + i + '+', 'driver');
    }
    var clocks = ['1HZ', '2HZ', '4HZ', '8HZ', '1KHZ', '10KHZ', '1MHZ', 'CONT'];
    for (i = 0; i < clocks.length; i++) add('clock', clocks[i], 'driver');
    for (i = 0; i < 8; i++) add('analyzer', 'DCH' + i, 'sink');
    add('pwr', '5V1', 'power', 'VCC');
    add('pwr', '5V2', 'power', 'VCC');
    add('gnd', 'GND1', 'ground', 'GND');
    add('gnd', 'GND2', 'ground', 'GND');
    for (i = 1; i <= SW_COUNT; i++) add('sw', '5K' + i, 'driver');
    add('mid', 'SPK', 'sink'); add('mid', 'BEEP', 'sink');
    add('mid', 'ACH1', 'sink'); add('mid', 'DDS', 'sink');

    return { VIEWBOX: { width: 1800, height: 1380 }, JACKS: jacks, JACK_ORDER: order, MODULES: [] };
  }

  /* ============================================================
   * 3. 构造
   * ============================================================ */

  /**
   * @param {object} [options]
   * @param {object} [options.geometry] 插孔几何数据（DLab.geometry）
   * @param {number} [options.pulseWidthMs] 单脉冲宽度，默认 200ms
   * @param {boolean} [options.isTTL] 输入端悬空是否按 TTL 视为高，默认 true
   */
  function Engine(options) {
    options = options || {};
    var geo = options.geometry || (DLab && DLab.geometry) || null;
    this._geometry = geo || buildFallbackGeometry();
    this._fallbackGeometry = !geo;
    // 公开只读引用：UI 层（如 persistence）会读 engine.geometry 取插孔坐标
    this.geometry = this._geometry;

    this._pulseWidthMs = typeof options.pulseWidthMs === 'number' ? options.pulseWidthMs : PULSE_WIDTH_MS;
    this._isTTL = options.isTTL === undefined ? true : !!options.isTTL;

    // ---- 插孔索引 ----
    this._jacks = Object.create(null);   // id -> { id, label, moduleId, kind, fixedNet }
    this._jackIds = [];                  // 稳定顺序
    this._byModuleLabel = Object.create(null);  // 'module:label' -> id
    this._byModule = Object.create(null);       // moduleId -> [id...]
    this._indexGeometry(this._geometry);

    // ---- 网表 ----
    this._netlist = new Logic.Netlist({ jacks: this._jacks, order: this._jackIds });
    this._netVersion = 0;
    this._indexVersion = -1;
    this._netByJack = Object.create(null);
    this._nets = [];

    // ---- 板内固定铜箔走线（可选）----
    // 由 BoardNets 按 geometry 推导「哪些插孔在板内被铜箔硬连在一起」，
    // 并用 Netlist 现成的并查集 union 接口预合并进网表。
    // 不引入并行机制：合并后与普通导线完全同构，删除导线重建网表时也会被 _rebuild() 一并复原。
    this._boardNetGroups = [];
    this._boardNetError = null;
    this._buildBoardNets();

    // ---- 板载状态 ----
    this._power = true;
    this._clockEnabled = true;
    this._switches = [];
    for (var i = 0; i < SW_COUNT; i++) this._switches.push(0);
    this._pulseUntil = [];       // 每路脉冲的结束时刻（ms），0 表示无脉冲
    this._pulseCount = [];
    for (i = 0; i < PULSE_COUNT; i++) { this._pulseUntil.push(0); this._pulseCount.push(0); }

    // ---- 板载仪器 ----
    this._probeMode = 'TTL';     // 逻辑笔判读模式：'TTL' | 'CMOS'
    this._dds = {                // 信号源 DDS：频率 / 幅度 / 波形 / 编码器当前选择的参数
      freqHz: 1000,
      amplitudeV: 5,
      waveform: 'square',        // 'square' | 'pulse'
      sel: 'freq'                // 'freq' | 'amp' | 'wave'
    };
    this._potRatio = 0.5;        // 电位器滑动端位置（0=1脚端，1=3脚端）
    this._potVolts = null;       // 最近一次求值得到的滑动端电压（V），两端都未供电时为 null

    // ---- 芯片 ----
    this._chips = Object.create(null);   // socketId -> { socketId, model, def, ctx }

    // ---- 运行状态 ----
    this._now = 0;
    this._lastAdvanceAt = 0;            // 上次真实推进到的时刻（P7 步长观测基准）
    this._stepDtMs = DEFAULT_STEP_MS;   // 观测步长（ms），由 step() 更新，P2 混叠检测用
    this._state = null;
    this._lastSignature = null;
    this._listeners = [];

    // ---- P2 混叠告警缓存（H2）----
    // _collectAliasWarnings 每步都会被 _buildState 调用，但其结果只取决于
    // 电源 / 时钟使能 / DDS 频率幅度 / 步长观测值 / 网表 / 已插芯片 —— 这些都是
    // 「低频变化」输入。用脏标记缓存结果，相关 API 成功路径上置脏即可。
    this._aliasCache = null;
    this._aliasDirty = true;

    // ---- H1' 同刻记忆化 / H7 批量收尾（2026-10-30 性能审查遗留项）----
    // step() 的结果只取决于 (now, 内部电气状态)：变更类 API / 接线 / reset 都经
    // _touchState() 置脏；「同一时刻且未置脏」的重入 step 直接复用上次状态对象，
    // 把 P1 自动重算、H8 跳帧后的 getState、UI refresh 显式 step 变成 O(1) 缓存命中。
    this._stateDirty = true;    // 构造后首次 step 必须真实求值
    this._stateNow = null;      // 上次真实求值对应的时刻
    this._batchDepth = 0;       // beginBatch / endBatch 嵌套深度

    // ---- P3 门电路驱动扬声器：跨步电平翻转测频 ----
    // 记录 SPK 输入网的最近电平与边沿时刻；同一虚拟时刻只采样一次。
    this._spkTrack = { lastNow: null, lastLevel: null, edges: [] };

    // 初始化一次，保证 getState() / getJackLevel() 在首次 step 之前也可用
    this.step(0);
  }

  /* ---------- 几何索引 ---------- */

  /** 归一化并索引几何数据（容错：缺字段时从 id 推断） */
  Engine.prototype._indexGeometry = function (geo) {
    var jacks = (geo && geo.JACKS) || {};
    var order = (geo && geo.JACK_ORDER) || [];
    var self = this;
    var seen = Object.create(null);

    function push(id, raw) {
      if (!raw) return;
      var moduleId = raw.moduleId;
      var label = raw.label;
      if (!moduleId || !label) {
        var parts = String(id).split(':');
        if (!moduleId) moduleId = parts[0];
        if (!label) label = parts.slice(1).join(':');
      }
      var fixedNet = raw.fixedNet || null;
      if (!fixedNet) fixedNet = self._inferFixedNet(moduleId, label);
      var rec = {
        id: id,
        label: label,
        moduleId: moduleId,
        kind: raw.kind || 'passive',
        fixedNet: fixedNet,
        x: typeof raw.x === 'number' ? raw.x : 0,
        y: typeof raw.y === 'number' ? raw.y : 0,
        role: self._inferDriverRole(moduleId, label)
      };
      self._jacks[id] = rec;
      self._jackIds.push(id);
      self._byModuleLabel[moduleId + ':' + label] = id;
      if (!self._byModule[moduleId]) self._byModule[moduleId] = [];
      self._byModule[moduleId].push(id);
    }

    var i, id;
    for (i = 0; i < order.length; i++) {
      id = order[i];
      if (jacks[id] && !seen[id]) { seen[id] = true; push(id, jacks[id]); }
    }
    for (id in jacks) {
      if (Object.prototype.hasOwnProperty.call(jacks, id) && !seen[id]) {
        seen[id] = true;
        push(id, jacks[id]);
      }
    }
  };

  /** 从模块 / 丝印推断板内硬连接（几何没给 fixedNet 时的兜底） */
  Engine.prototype._inferFixedNet = function (moduleId, label) {
    if (moduleId === 'pwr') return 'VCC';
    if (moduleId === 'gnd') return 'GND';
    if (moduleId === 'devA' || moduleId === 'devB') {
      if (label === 'VCC') return 'VCC';
      if (label === 'GND') return 'GND';
    }
    return null;
  };

  /**
   * 从模块 / 丝印推断插孔的「板载驱动源角色」（构造时算一次，_collectBoardDrivers 每步直接用）。
   * 返回 null 表示该插孔不是驱动源（纯被动孔 / 仪器输入孔）。
   * 角色形如：
   *   { kind:'pwr' }                        电源输出孔（受电源开关影响）
   *   { kind:'gnd' }                        地孔（恒 0）
   *   { kind:'sw', n }                      逻辑电平开关 5Kn
   *   { kind:'clock', freqHz }              时钟输出孔（频率在 CLOCK_FREQS 内才登记）
   *   { kind:'pulse', n, plus }             单脉冲输出孔 6Kn+/6Kn-
   *   { kind:'dds' }                        信号源 DDS 输出孔
   * 与 _collectBoardDrivers 的旧正则逐条等价：不匹配的标签一律返回 null（不产生驱动）。
   */
  Engine.prototype._inferDriverRole = function (moduleId, label) {
    if (moduleId === 'pwr') return { kind: 'pwr' };
    if (moduleId === 'gnd') return { kind: 'gnd' };
    if (moduleId === 'sw') {
      var m = /^(?:5K)(\d+)$/.exec(label);
      if (m) {
        var n = parseInt(m[1], 10);
        if (n >= 1 && n <= SW_COUNT) return { kind: 'sw', n: n };
      }
      return null;
    }
    if (moduleId === 'clock') {
      if (Object.prototype.hasOwnProperty.call(CLOCK_FREQS, label)) {
        return { kind: 'clock', freqHz: CLOCK_FREQS[label] };
      }
      return null;
    }
    if (moduleId === 'pulse') {
      var pm = /^(?:6K)(\d+)([+-])$/.exec(label);
      if (pm) {
        var pn = parseInt(pm[1], 10);
        if (pn >= 1 && pn <= PULSE_COUNT) return { kind: 'pulse', n: pn, plus: pm[2] === '+' };
      }
      return null;
    }
    if (moduleId === 'mid' && label === 'DDS') return { kind: 'dds' };
    return null;
  };

  /* ---------- 板内固定走线 ---------- */

  /**
   * 推导并把板内固定连通组并入网表。
   * BoardNets 未加载时直接返回，引擎行为与之前完全一致。
   * 推导失败（geometry 与走线表不一致）时降级为空组，并在 warnings 里说明，不阻断引擎构造。
   */
  Engine.prototype._buildBoardNets = function () {
    this._boardNetGroups = [];
    if (!BoardNets || typeof BoardNets.buildGroups !== 'function') return;
    var groups;
    try {
      groups = BoardNets.buildGroups(this._geometry).groups || [];
    } catch (err) {
      this._boardNetError = err && err.message ? err.message : String(err);
      return;
    }
    this._boardNetError = null;
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (!g || !g.jacks || g.jacks.length < 2) continue;
      this._boardNetGroups.push({ id: g.id, jacks: g.jacks.slice() });
    }
    this._applyBoardNetGroups();
    this._netVersion += 1;
  };

  /**
   * 把已推导出的板内连通组并进网表（不重新推导）。
   * Netlist._rebuild() 会从零重建并查集，只保留 fixedNet 与导线，
   * 因此删除导线 / 清空导线之后必须调用本方法把板内走线补回去。
   */
  Engine.prototype._applyBoardNetGroups = function () {
    for (var i = 0; i < this._boardNetGroups.length; i++) {
      var jacks = this._boardNetGroups[i].jacks;
      // 用 Netlist 现成的并查集接口合并：把组内所有插孔并到第一个上
      for (var k = 1; k < jacks.length; k++) {
        if (!this._jacks[jacks[0]] || !this._jacks[jacks[k]]) continue;
        this._netlist._union(jacks[0], jacks[k]);
      }
    }
  };

  /* ---------- 网表索引 ---------- */

  /** 网表变化后失效索引 */
  Engine.prototype._touchNets = function () {
    this._netVersion += 1;
    this._aliasDirty = true;   // H2：网拓扑变化影响混叠扫描
    this._touchState();        // H1'：网拓扑变化影响电平，同刻记忆化需失效
  };

  /** 电气状态已变更：失效 H1' 同刻记忆化缓存（与 H2 混叠缓存相互独立） */
  Engine.prototype._touchState = function () {
    this._stateDirty = true;
  };

  /**
   * P1 变更类 API 的统一收尾：批量期间（beginBatch/endBatch 之间，H7）延迟到
   * endBatch 统一补算；否则立即按当前时刻重算一遍（P1 契约）。
   */
  Engine.prototype._stepAfterChange = function () {
    if (this._batchDepth > 0) return;   // H7：批量中，延迟到 endBatch 收尾
    this.step(this._now);
  };

  /**
   * 【H7 批量契约】开始一段批量变更：期间 P1 变更类 API 不再逐步自动重算，
   * 由 endBatch() 在深度归零且期间确有变更时统一补一次收尾 step。
   * 典型批量入口：工程导入（persistence.applyProject）、真值表判分（grader）。
   * 语义与「接线类 API 不自动 step」一致：批量期间的 getState()/getJackLevel()
   * 返回上一次收尾的结果（延迟一致），endBatch 之后立即反映全部变更。
   * 必须与 endBatch 配对（推荐 try/finally）；支持嵌套（按深度计数）。
   */
  Engine.prototype.beginBatch = function () {
    this._batchDepth += 1;
    return this._batchDepth;
  };

  /** 结束一段批量变更（与 beginBatch 配对）；返回剩余嵌套深度 */
  Engine.prototype.endBatch = function () {
    if (this._batchDepth > 0) this._batchDepth -= 1;
    if (this._batchDepth === 0 && this._stateDirty) this.step(this._now);
    return this._batchDepth;
  };

  /** 重建 jack -> net 索引（按版本号懒加载） */
  Engine.prototype._ensureNetIndex = function () {
    if (this._indexVersion === this._netVersion) return;
    this._nets = this._netlist.getNets();
    this._netByJack = Object.create(null);
    for (var i = 0; i < this._nets.length; i++) {
      var net = this._nets[i];
      for (var j = 0; j < net.jacks.length; j++) this._netByJack[net.jacks[j]] = net;
    }
    this._indexVersion = this._netVersion;
  };

  /* ============================================================
   * 4. 插孔查找
   * ============================================================ */

  /** 是否存在该插孔 */
  Engine.prototype.hasJack = function (id) {
    return !!this._jacks[id];
  };

  /** 插孔元数据（未知返回 null） */
  Engine.prototype.getJackInfo = function (id) {
    return this._jacks[id] || null;
  };

  /** 全部插孔 id（稳定顺序） */
  Engine.prototype.getJackIds = function () {
    return this._jackIds.slice();
  };

  /** 按模块 + 丝印查插孔 id（容错不同 id 拼写），查不到返回 null */
  Engine.prototype.findJack = function (moduleId, label) {
    var id = this._byModuleLabel[moduleId + ':' + label];
    if (id) return id;
    var exact = moduleId + ':' + label;
    if (this._jacks[exact]) return exact;
    return null;
  };

  /** 某模块下的全部插孔 id */
  Engine.prototype.jacksOfModule = function (moduleId) {
    var list = this._byModule[moduleId];
    return list ? list.slice() : [];
  };

  /* ============================================================
   * 5. 导线
   * ============================================================ */

  /** 添加导线：{ id?, from, to, color? }，非法参数抛错 */
  Engine.prototype.addWire = function (wire) {
    if (!wire || typeof wire !== 'object') throw new Error('addWire 需要导线对象 { id, from, to, color }');
    var from = wire.from;
    var to = wire.to;
    if (!from || !to) throw new Error('导线缺少 from / to');
    if (from === to) throw new Error('导线两端不能是同一个插孔：' + from);
    if (!this._jacks[from]) throw new Error('未知插孔：' + from);
    if (!this._jacks[to]) throw new Error('未知插孔：' + to);
    if (wire.id && this._netlist.getWires().some(function (w) { return w.id === wire.id; })) {
      throw new Error('导线 id 重复：' + wire.id);
    }
    var rec = this._netlist.addWire({
      id: wire.id,
      from: from,
      to: to,
      color: wire.color || null
    });
    this._touchNets();
    return { id: rec.id, from: rec.from, to: rec.to, color: rec.color };
  };

  /** 删除导线（id 或导线对象），返回是否删除成功 */
  Engine.prototype.removeWire = function (wireOrId) {
    var ok = this._netlist.removeWire(wireOrId);
    if (ok) {
      this._applyBoardNetGroups();   // 重建并查集后补回板内固定走线
      this._touchNets();
    }
    return ok;
  };

  /** 全部导线（副本） */
  Engine.prototype.getWires = function () {
    return this._netlist.getWires();
  };

  /** 清空导线 */
  Engine.prototype.clearWires = function () {
    this._netlist.clearWires();
    this._applyBoardNetGroups();   // 重建并查集后补回板内固定走线
    this._touchNets();
  };

  /* ============================================================
   * 6. 板载器件
   * ============================================================ */

  function checkRange(n, min, max, what) {
    var v = Number(n);
    if (!isFinite(v) || Math.floor(v) !== v || v < min || v > max) {
      throw new Error(what + ' 编号越界：' + n + '（有效范围 ' + min + '~' + max + '）');
    }
    return v;
  }

  /**
   * 【P1 契约】以下「设备状态变更」类 API：
   *   setSwitch / pressPulse / setPower / setClockEnabled / setProbeMode /
   *   setDds / adjustDds / cycleDdsParam / setPotRatio / mountChip / unmountChip
   * 执行成功后会自动重算一遍（_stepAfterChange：按当前时刻 step），getState() /
   * getJackLevel() 立即反映变更，调用方无需（也不妨害）再手动推进。
   * 【H7 补充】beginBatch() / endBatch() 之间的 P1 变更不再逐个重算，由 endBatch
   * 统一收尾一次——批量入口（工程导入 / 真值表判分）以此消掉 N×全量收敛放大。
   * 「接线」类 API（addWire / removeWire / clearWires）保持结构性操作不变：
   * 批量改线后由调用方自行 step()（UI 与判分器均按此约定）。
   * 详见 docs/CONTRACTS.md §5。
   */

  /** 设置开关 5Kn：n = 1..16，level = 0|1 */
  Engine.prototype.setSwitch = function (n, level) {
    var i = checkRange(n, 1, SW_COUNT, '开关');
    var v = (level === 1 || level === '1' || level === true) ? 1 : 0;
    this._switches[i - 1] = v;
    this._touchState();
    this._stepAfterChange();   // P1：变更立即重算（H7 批量期间延迟到 endBatch）
    return v;
  };

  /** 读取开关 5Kn 的状态（0|1） */
  Engine.prototype.getSwitch = function (n) {
    var i = checkRange(n, 1, SW_COUNT, '开关');
    return this._switches[i - 1];
  };

  /** 全部开关状态（1..16 -> 0|1） */
  Engine.prototype.getSwitches = function () {
    var out = {};
    for (var i = 0; i < SW_COUNT; i++) out['5K' + (i + 1)] = this._switches[i];
    return out;
  };

  /**
   * 按下单脉冲按键 6Kn（n = 1..6），产生一次 200ms 正脉冲。
   * 脉冲进行中重复按下会被防抖忽略。
   * @returns {boolean} 本次是否真的产生了一个新脉冲
   */
  Engine.prototype.pressPulse = function (n) {
    var i = checkRange(n, 1, PULSE_COUNT, '脉冲键');
    var idx = i - 1;
    if (this._now < this._pulseUntil[idx]) return false;   // 防抖：脉冲期内忽略
    this._pulseUntil[idx] = this._now + this._pulseWidthMs;
    this._pulseCount[idx] += 1;
    this._touchState();
    this._stepAfterChange();   // P1：变更立即重算（H7 批量期间延迟到 endBatch）
    return true;
  };

  /** 该路脉冲当前是否处于高电平期 */
  Engine.prototype.isPulseActive = function (n) {
    var i = checkRange(n, 1, PULSE_COUNT, '脉冲键');
    return this._now < this._pulseUntil[i - 1];
  };

  /** 该路脉冲累计触发次数 */
  Engine.prototype.getPulseCount = function (n) {
    var i = checkRange(n, 1, PULSE_COUNT, '脉冲键');
    return this._pulseCount[i - 1];
  };

  /** 电源总开关 */
  Engine.prototype.setPower = function (on) {
    this._power = !!on;
    this._aliasDirty = true;   // H2：断电时混叠告警为空，需重扫
    this._touchState();
    this._stepAfterChange();   // P1：变更立即重算（H7 批量期间延迟到 endBatch）
    return this._power;
  };

  /** 读取电源开关 */
  Engine.prototype.getPower = function () {
    return this._power;
  };

  /** 时钟输出区使能 */
  Engine.prototype.setClockEnabled = function (on) {
    this._clockEnabled = !!on;
    this._aliasDirty = true;   // H2：时钟源是否参与扫描取决于使能
    this._touchState();
    this._stepAfterChange();   // P1：变更立即重算（H7 批量期间延迟到 endBatch）
    return this._clockEnabled;
  };

  /** 读取时钟使能 */
  Engine.prototype.getClockEnabled = function () {
    return this._clockEnabled;
  };

  /* ============================================================
   * 6.1 板载仪器（逻辑笔 / 信号源 DDS / 电位器）
   * ============================================================ */

  /** 设置逻辑笔判读模式：'TTL' | 'CMOS'（非法值抛错） */
  Engine.prototype.setProbeMode = function (mode) {
    var m = String(mode || '').toUpperCase();
    if (PROBE_MODES.indexOf(m) < 0) {
      throw new Error('未知逻辑笔模式：' + mode + '（可选 ' + PROBE_MODES.join('/') + '）');
    }
    this._probeMode = m;
    this._touchState();
    this._stepAfterChange();   // P1：变更立即重算（H7 批量期间延迟到 endBatch）
    return this._probeMode;
  };

  /** 读取逻辑笔判读模式 */
  Engine.prototype.getProbeMode = function () {
    return this._probeMode;
  };

  /** 在 TTL / CMOS 之间切换逻辑笔判读模式，返回切换后的模式 */
  Engine.prototype.toggleProbeMode = function () {
    return this.setProbeMode(this._probeMode === 'TTL' ? 'CMOS' : 'TTL');
  };

  /** 读取信号源当前参数（副本）：{ freqHz, amplitudeV, waveform, sel } */
  Engine.prototype.getDds = function () {
    return {
      freqHz: this._dds.freqHz,
      amplitudeV: this._dds.amplitudeV,
      waveform: this._dds.waveform,
      sel: this._dds.sel
    };
  };

  /**
   * 设置信号源参数（部分字段可选，全部做范围钳制）。
   * @param {object} [patch] { freqHz?, amplitudeV?, waveform?, sel? }
   */
  Engine.prototype.setDds = function (patch) {
    patch = patch || {};
    if (patch.freqHz !== undefined) {
      var f = Number(patch.freqHz);
      if (!isFinite(f) || f <= 0) throw new Error('DDS 频率非法：' + patch.freqHz);
      this._dds.freqHz = Math.min(DDS_FREQ_MAX, Math.max(DDS_FREQ_MIN, Math.round(f)));
    }
    if (patch.amplitudeV !== undefined) {
      var a = Number(patch.amplitudeV);
      if (!isFinite(a)) throw new Error('DDS 幅度非法：' + patch.amplitudeV);
      this._dds.amplitudeV = Math.min(DDS_AMP_MAX, Math.max(DDS_AMP_MIN, a));
    }
    if (patch.waveform !== undefined) {
      if (patch.waveform !== 'square' && patch.waveform !== 'pulse') {
        throw new Error('DDS 波形非法：' + patch.waveform + '（可选 square/pulse）');
      }
      this._dds.waveform = patch.waveform;
    }
    if (patch.sel !== undefined) {
      if (['freq', 'amp', 'wave'].indexOf(patch.sel) < 0) {
        throw new Error('DDS 编码器选择非法：' + patch.sel + '（可选 freq/amp/wave）');
      }
      this._dds.sel = patch.sel;
    }
    if (patch.freqHz !== undefined || patch.amplitudeV !== undefined) {
      this._aliasDirty = true;   // H2：DDS 频率 / 幅度参与混叠扫描
    }
    this._touchState();
    this._stepAfterChange();   // P1：变更立即重算（H7 批量期间延迟到 endBatch）
    return this.getDds();
  };

  /** 2SS1 编码器按键：循环切换当前调节参数 频率 → 幅度 → 波形 → 频率 */
  Engine.prototype.cycleDdsParam = function () {
    var order = ['freq', 'amp', 'wave'];
    var next = order[(order.indexOf(this._dds.sel) + 1) % order.length];
    this._dds.sel = next;
    this._touchState();
    this._stepAfterChange();   // P1：变更立即重算（H7 批量期间延迟到 endBatch）
    return next;
  };

  /** 把频率吸附到 1-2-5 十进序列，返回 { value, index } */
  function snapFreq(f) {
    var seq = DDS_FREQ_STEPS;
    var best = 0;
    var bestErr = Infinity;
    for (var d = 0; d <= 6; d++) {
      for (var m = 0; m < seq.length; m++) {
        var v = seq[m] * Math.pow(10, d);
        if (v > DDS_FREQ_MAX) break;
        var err = Math.abs(Math.log(v / f));
        if (err < bestErr) { bestErr = err; best = d * seq.length + m; }
      }
    }
    var value = seq[best % seq.length] * Math.pow(10, Math.floor(best / seq.length));
    return { value: value, index: best };
  }

  function freqByIndex(index) {
    var seq = DDS_FREQ_STEPS;
    var maxIndex = 6 * seq.length; // 1e6
    var i = Math.min(Math.max(index, 0), maxIndex);
    return seq[i % seq.length] * Math.pow(10, Math.floor(i / seq.length));
  }

  /**
   * 2SS1 编码器旋转一格：按当前选择的参数增减。
   * @param {number} delta +1 顺时针 / -1 逆时针；0 表示波形切换（方波↔脉冲）
   * @returns {object} 调整后的信号源参数
   */
  Engine.prototype.adjustDds = function (delta) {
    var sel = this._dds.sel;
    if (sel === 'freq') {
      var idx = snapFreq(this._dds.freqHz).index + (delta >= 0 ? 1 : -1);
      this._dds.freqHz = freqByIndex(idx);
      this._aliasDirty = true;   // H2：频率变化参与混叠扫描
    } else if (sel === 'amp') {
      var a = this._dds.amplitudeV + (delta >= 0 ? DDS_AMP_STEP : -DDS_AMP_STEP);
      this._dds.amplitudeV = Math.min(DDS_AMP_MAX, Math.max(DDS_AMP_MIN, Math.round(a * 10) / 10));
      this._aliasDirty = true;   // H2：幅度变化参与混叠扫描
    } else {
      this._dds.waveform = (delta === 0)
        ? (this._dds.waveform === 'square' ? 'pulse' : 'square')
        : (delta > 0 ? 'pulse' : 'square');
    }
    this._touchState();
    this._stepAfterChange();   // P1：变更立即重算（H7 批量期间延迟到 endBatch）
    return this.getDds();
  };

  /** 设置电位器滑动端位置（0~1，自动钳制） */
  Engine.prototype.setPotRatio = function (ratio) {
    var r = Number(ratio);
    if (!isFinite(r)) throw new Error('电位器位置非法：' + ratio);
    this._potRatio = Math.min(1, Math.max(0, r));
    this._touchState();
    this._stepAfterChange();   // P1：变更立即重算（H7 批量期间延迟到 endBatch）
    return this._potRatio;
  };

  /** 读取电位器滑动端位置（0~1） */
  Engine.prototype.getPotRatio = function () {
    return this._potRatio;
  };

  /* ============================================================
   * 7. 芯片
   * ============================================================ */

  /** 解析插座 id：'devA:UA' -> { moduleId:'devA', letter:'A', pins:14 } */
  Engine.prototype._parseSocket = function (socketId) {
    if (typeof socketId !== 'string') throw new Error('插座 id 必须是字符串：' + socketId);
    var parts = socketId.split(':');
    if (parts.length !== 2) throw new Error('插座 id 格式应为 <模块>:<插座>，收到：' + socketId);
    var moduleId = parts[0];
    var name = parts[1];
    if (moduleId !== 'devA' && moduleId !== 'devB') {
      throw new Error('未知插座模块：' + moduleId + '（只支持 devA / devB）');
    }
    if (!/^U[A-Z]$/.test(name)) throw new Error('未知插座：' + socketId);
    var letter = name.charAt(1);
    var pins = SOCKET_SPEC[name];
    if (!pins) throw new Error('未知插座：' + socketId);
    return { socketId: socketId, moduleId: moduleId, name: name, letter: letter, pins: pins };
  };

  /** 插座第 pin 脚对应的插孔 id（不存在返回 null） */
  Engine.prototype.socketJack = function (socketId, pin) {
    var info = this._parseSocket(socketId);
    var label = info.letter + pin;
    return this.findJack(info.moduleId, label);
  };

  /** 在插座上插入芯片；型号与插座规格不匹配抛错 */
  Engine.prototype.mountChip = function (socketId, model) {
    var info = this._parseSocket(socketId);
    var def = Chips.get(model);
    if (!def) throw new Error('未知芯片型号：' + model);
    if (def.package !== info.pins) {
      throw new Error('型号 ' + model + '（' + def.package + ' 脚）不能插入 ' +
        socketId + '（' + info.pins + ' 脚插座）');
    }
    // P5b（2026-10-30 审查遗留项）：已占插座不再静默换芯，改为显式抛错——
    // 静默换芯会让时序芯片的内部状态（ctx.state）在无提示的情况下清零。
    // 更换芯片请先 unmountChip（ChipTray 更换流程已适配为「先拔后插」）。
    var existing = this._chips[socketId];
    if (existing) {
      throw new Error('插座 ' + socketId + ' 已插有 ' + existing.model + '，请先拔下再插新芯片');
    }
    // H3：挂载时一次性解析「脚号 -> 插孔 id」映射。
    // 每步求值要按脚取电平（输入）与回写输出，旧实现每次都经
    // _parseSocket（正则 + split）+ findJack（字符串拼接）解析，
    // 芯片越多、迭代轮数越多开销越大；插座引脚在挂载后不会变，缓存安全。
    var jackByPin = Object.create(null);
    for (var pi = 0; pi < def.pins.length; pi++) {
      var pinNo = def.pins[pi];
      jackByPin[pinNo] = this.findJack(info.moduleId, info.letter + pinNo);
    }
    this._chips[socketId] = {
      socketId: socketId,
      model: model,
      def: def,
      ctx: { state: {}, isTTL: this._isTTL },
      jackByPin: jackByPin
    };
    this._aliasDirty = true;   // H2：时序芯片集合变化影响混叠扫描
    this._touchState();
    this._stepAfterChange();   // P1：变更立即重算（H7 批量期间延迟到 endBatch）
    return model;
  };

  /** 拔出芯片 */
  Engine.prototype.unmountChip = function (socketId) {
    if (!this._chips[socketId]) return false;
    delete this._chips[socketId];
    this._aliasDirty = true;   // H2：时序芯片集合变化影响混叠扫描
    this._touchState();
    this._stepAfterChange();   // P1：变更立即重算（H7 批量期间延迟到 endBatch）
    return true;
  };

  /** 查询插座上的芯片型号（空插座返回 null） */
  Engine.prototype.getChip = function (socketId) {
    var rec = this._chips[socketId];
    return rec ? rec.model : null;
  };

  /** 全部已插芯片：{ socketId: model } */
  Engine.prototype.getChips = function () {
    var out = {};
    for (var k in this._chips) {
      if (Object.prototype.hasOwnProperty.call(this._chips, k)) out[k] = this._chips[k].model;
    }
    return out;
  };

  /** 插座规格表（供 UI 校验） */
  Engine.prototype.getSocketSpec = function () {
    return { UA: SOCKET_SPEC.UA, UB: SOCKET_SPEC.UB, UE: SOCKET_SPEC.UE, UD: SOCKET_SPEC.UD, UF: SOCKET_SPEC.UF };
  };

  /* ============================================================
   * 8. 板载驱动源
   * ============================================================ */

  /** 计算时钟相位电平（方波，t=0 起高电平） */
  function clockLevel(freq, now) {
    var period = 1000 / freq;                 // 周期（ms）
    var phase = now % period;
    if (phase < 0) phase += period;
    return (phase / period) < 0.5 ? L1 : L0;
  }

  /**
   * 计算信号源 DDS 的相位电平。
   * 方波：50% 占空比；脉冲：每周期输出一个窄高脉冲（占空比 DDS_PULSE_DUTY，
   * 脉宽钳制在 0.05ms ~ 500ms）。幅度低于 TTL 阈值时输出恒为低电平。
   */
  function ddsLevel(dds, now) {
    if (dds.amplitudeV < DDS_TTL_THRESHOLD) return L0;
    var period = 1000 / dds.freqHz;           // 周期（ms）
    var phase = now % period;
    if (phase < 0) phase += period;
    if (dds.waveform === 'pulse') {
      var highMs = Math.max(0.05, Math.min(period * DDS_PULSE_DUTY, 500));
      return phase < highMs ? L1 : L0;
    }
    return (phase / period) < 0.5 ? L1 : L0;
  }

  /**
   * 收集板载驱动源。
   * @returns {{drivers: object, fixed: object}} drivers: jackId -> level；fixed: 'VCC'|'GND' -> level
   */
  Engine.prototype._collectBoardDrivers = function (now) {
    var drivers = Object.create(null);
    var fixed = Object.create(null);
    var ids = this._jackIds;
    var i, id, rec;

    // 驱动角色在 _indexGeometry 时已预计算（rec.role），每步只按当前状态取电平，
    // 不再做正则匹配（H5：每步 288 孔 × 正则 -> 一次对象属性读取）。
    // 分支次序与旧实现逐条对应，保证驱动集合与电平完全一致：
    //   pwr 受电源开关影响；gnd 恒 0；其余在断电时一律输出 LZ（保持出现在驱动表里，
    //   _analyzeSink 依赖这一点把断电开关识别为 'dc' 来源）。
    for (i = 0; i < ids.length; i++) {
      id = ids[i];
      rec = this._jacks[id];
      var role = rec.role;
      if (!role) continue;

      if (role.kind === 'pwr') {
        drivers[id] = this._power ? L1 : LZ;
      } else if (role.kind === 'gnd') {
        drivers[id] = L0;                     // 地永远为 0（不受电源开关影响）
      } else if (!this._power) {
        drivers[id] = LZ;                     // 断电：开关 / 时钟 / 脉冲一律无驱动
      } else if (role.kind === 'sw') {
        drivers[id] = this._switches[role.n - 1] ? L1 : L0;
      } else if (role.kind === 'clock') {
        if (!this._clockEnabled) {
          drivers[id] = LZ;                   // 时钟未使能 -> 高阻
        } else {
          drivers[id] = clockLevel(role.freqHz, now);
        }
      } else if (role.kind === 'pulse') {
        var active = now < this._pulseUntil[role.n - 1];
        drivers[id] = role.plus ? (active ? L1 : L0) : (active ? L0 : L1);
      } else if (role.kind === 'dds') {
        // 信号源 DDS 输出孔：由板载 DDS 仪器驱动（只受电源开关控制，独立于时钟使能）
        drivers[id] = ddsLevel(this._dds, now);
      }
    }

    // 板内硬连接：VCC 恒 1（断电则悬空），GND 恒 0
    fixed.VCC = this._power ? L1 : LZ;
    fixed.GND = L0;

    return { drivers: drivers, fixed: fixed };
  };

  /**
   * P2 混叠检测：引擎按「电平采样」推进（step 只读取 now 时刻的相位），
   * 当时钟 / DDS 周期小于 2×步长时，两次 step 之间会漏掉整个脉冲沿，
   * 表现为触发器不翻转、计数器不计数。这里扫描所有已插芯片的时钟引脚所在网，
   * 若网上挂有「快于 2×步长」的时钟输出孔（时钟使能时）或 DDS 输出孔
   * （幅度达到 TTL 阈值时），则按来源分组给出中文告警。
   * 断电时无任何驱动，直接返回空。连续脉冲 CONT 按 CLOCK_FREQS['CONT']=1Hz 计。
   * @returns {string[]} 告警文本列表（追加到 _buildState 的 warnings）
   */
  /**
   * P2 混叠告警（H2 缓存版）：结果在脏标记未置位时直接复用上次数组。
   * 返回的数组为引擎内部共享实例，调用方只读（_buildState 只做追加拷贝）。
   */
  Engine.prototype._collectAliasWarnings = function () {
    if (!this._aliasDirty && this._aliasCache) return this._aliasCache;
    this._aliasCache = this._scanAliasWarnings();
    this._aliasDirty = false;
    return this._aliasCache;
  };

  /** 混叠告警扫描本体（H2 拆出，仅在脏标记置位时执行） */
  Engine.prototype._scanAliasWarnings = function () {
    var warnings = [];
    if (!this._power) return warnings;
    var dt = this._stepDtMs;
    if (!(dt > 0)) return warnings;
    var limitMs = 2 * dt;
    var maxHz = Math.floor(1000 / limitMs);

    this._ensureNetIndex();
    var groups = Object.create(null);   // key -> { what, freqHz, sockets: [] }
    for (var socketId in this._chips) {
      if (!Object.prototype.hasOwnProperty.call(this._chips, socketId)) continue;
      var rec = this._chips[socketId];
      var clockPins = SEQ_CLOCK_PINS[rec.model];
      if (!clockPins) continue;
      for (var p = 0; p < clockPins.length; p++) {
        var jackId = this.socketJack(socketId, clockPins[p]);
        if (!jackId) continue;
        var net = this._netByJack[jackId];
        if (!net) continue;
        for (var j = 0; j < net.jacks.length; j++) {
          var jrec = this._jacks[net.jacks[j]];
          if (!jrec) continue;
          var freqHz = 0;
          var what = '';
          if (jrec.moduleId === 'clock' && this._clockEnabled &&
              Object.prototype.hasOwnProperty.call(CLOCK_FREQS, jrec.label)) {
            freqHz = CLOCK_FREQS[jrec.label];
            what = '时钟输出 ' + jrec.label;
          } else if (jrec.moduleId === 'mid' && jrec.label === 'DDS' &&
                     this._dds.amplitudeV >= DDS_TTL_THRESHOLD) {
            freqHz = this._dds.freqHz;
            what = '信号源 DDS';
          }
          if (freqHz > 0 && (1000 / freqHz) < limitMs) {
            var key = what + '|' + freqHz;
            if (!groups[key]) groups[key] = { what: what, freqHz: freqHz, sockets: [] };
            var tag = rec.model + '@' + socketId;
            if (groups[key].sockets.indexOf(tag) < 0) groups[key].sockets.push(tag);
          }
        }
      }
    }
    for (var k in groups) {
      if (!Object.prototype.hasOwnProperty.call(groups, k)) continue;
      var g = groups[k];
      var periodMs = 1000 / g.freqHz;
      var periodStr = periodMs >= 1 ? String(Math.round(periodMs * 100) / 100) : periodMs.toFixed(3);
      warnings.push('混叠告警：' + g.what + '（' + g.freqHz + 'Hz，周期 ' + periodStr +
        'ms）快于 2×仿真步长（' + limitMs + 'ms），采样推进时 ' + g.sockets.join('、') +
        ' 的时钟引脚会丢失边沿。请改用 ≤' + maxHz + ' Hz 的时钟、单脉冲按键，或降低时间倍率');
    }
    return warnings;
  };

  /* ============================================================
   * 9. 求值核心
   * ============================================================ */

  /**
   * 由「板载驱动 + 芯片驱动」算出每个网与每个插孔的电平。
   * @param {object} boardDrivers jackId -> level
   * @param {object} chipDrivers  jackId -> level
   * @param {object} fixedLevels  'VCC'|'GND' -> level
   * @returns {{jackLevels:object, netInfo:Array}}
   */
  Engine.prototype._computeLevels = function (boardDrivers, chipDrivers, fixedLevels) {
    this._ensureNetIndex();
    var nets = this._nets;
    var jackLevels = Object.create(null);
    var netInfo = [];
    var i, j, k;

    for (i = 0; i < nets.length; i++) {
      var net = nets[i];
      var levels = [];
      var drivers = [];
      var has0 = false;
      var has1 = false;
      var fixedHere = net.fixedNets || [];

      for (k = 0; k < fixedHere.length; k++) {
        var fv = fixedLevels[fixedHere[k]];
        if (fv !== undefined) {
          levels.push(fv);
          drivers.push(fixedHere[k]);
          if (fv === L0) has0 = true;
          if (fv === L1) has1 = true;
        }
      }

      for (j = 0; j < net.jacks.length; j++) {
        var jid = net.jacks[j];
        if (Object.prototype.hasOwnProperty.call(boardDrivers, jid)) {
          var bv = boardDrivers[jid];
          levels.push(bv);
          drivers.push(jid);
          if (bv === L0) has0 = true;
          if (bv === L1) has1 = true;
        }
        if (Object.prototype.hasOwnProperty.call(chipDrivers, jid)) {
          var cv = chipDrivers[jid];
          levels.push(cv);
          drivers.push(jid);
          if (cv === L0) has0 = true;
          if (cv === L1) has1 = true;
        }
      }

      var level = Logic.resolve(levels);
      for (j = 0; j < net.jacks.length; j++) jackLevels[net.jacks[j]] = level;

      netInfo.push({
        id: net.id,
        jacks: net.jacks.slice(),
        level: level,
        drivers: drivers,
        fixedNets: fixedHere.slice(),
        conflict: has0 && has1
      });
      // 冲突记录：只要迭代过程中出现过「强 1 与强 0 同时存在」就记为短路/冲突，
      // 即使后续 X 传播让某一路驱动变成 X 也不丢失告警信息。
      if (has0 && has1 && this._conflictIds) this._conflictIds[net.id] = true;
    }

    return { jackLevels: jackLevels, netInfo: netInfo };
  };

  /** 取芯片某引脚的输入电平（未连接插孔按 'Z'） */
  Engine.prototype._pinLevels = function (chip, jackLevels) {
    var def = chip.def;
    var jackByPin = chip.jackByPin;   // H3：挂载时缓存的 脚->插孔 映射
    var out = {};
    for (var i = 0; i < def.pins.length; i++) {
      var pin = def.pins[i];
      var jid = jackByPin ? jackByPin[pin] : this.socketJack(chip.socketId, pin);
      out[pin] = jid && jackLevels[jid] ? jackLevels[jid] : LZ;
    }
    return out;
  };

  /** 求值全部芯片，返回输出插孔电平表 */
  Engine.prototype._evalChips = function (jackLevels) {
    var chipDrivers = Object.create(null);
    for (var socketId in this._chips) {
      if (!Object.prototype.hasOwnProperty.call(this._chips, socketId)) continue;
      var chip = this._chips[socketId];
      var info = null;   // H3：仅当缓存缺失需要兜底时才解析插座
      var jackByPin = chip.jackByPin;
      var def = chip.def;

      if (!this._power) {
        // 断电：芯片不驱动任何输出（全部呈高阻）
        continue;
      }

      var pinLevels = this._pinLevels(chip, jackLevels);
      var result;
      try {
        result = def.eval(pinLevels, chip.ctx);
      } catch (err) {
        result = {};
      }
      for (var op in result) {
        if (!Object.prototype.hasOwnProperty.call(result, op)) continue;
        var jackId;
        if (jackByPin && Object.prototype.hasOwnProperty.call(jackByPin, op)) {
          jackId = jackByPin[op];
        } else {
          if (!info) info = this._parseSocket(socketId);
          jackId = this.findJack(info.moduleId, info.letter + op);
        }
        if (jackId) chipDrivers[jackId] = Logic.isLevel(result[op]) ? result[op] : LX;
      }
    }

    // 电位器滑动端：按分压模型驱动 rc:2（负载按高阻处理，与数字输入近似）
    var potLevel = this._evalPot(jackLevels);
    var potJack = this.findJack('rc', '2');
    if (potLevel && potJack) chipDrivers[potJack] = potLevel;

    return chipDrivers;
  };

  /**
   * 电位器求值：由两端（rc:1 / rc:3）的当前电平推算滑动端电压。
   * 两端都供电：线性分压；只有一端供电：另一端悬空时滑动端电位等于供电端
   * （滑动端负载按高阻处理，电阻轨道上没有电流）；两端都悬空：不驱动。
   * @returns {string|null} 滑动端驱动电平，不驱动时返回 null
   */
  Engine.prototype._evalPot = function (jackLevels) {
    var j1 = this.findJack('rc', '1');
    var j3 = this.findJack('rc', '3');
    if (!j1 || !j3) { this._potVolts = null; return null; }

    function endVolt(lv) {
      if (lv === L1) return POT_VMAX;
      if (lv === L0) return 0;
      return null;                 // 悬空或冲突：该端视为未供电
    }

    var v1 = endVolt(jackLevels[j1]);
    var v3 = endVolt(jackLevels[j3]);
    var volts = null;
    if (v1 !== null && v3 !== null) {
      volts = v1 + (v3 - v1) * this._potRatio;
    } else if (v1 !== null) {
      volts = v1;
    } else if (v3 !== null) {
      volts = v3;
    }
    this._potVolts = volts;
    if (volts === null) return null;
    return volts >= POT_THRESHOLD ? L1 : L0;
  };

  /* ============================================================
   * 10. 推进与状态
   * ============================================================ */

  /**
   * 推进仿真到 nowMs（幂等：同样的 nowMs 重复调用结果一致）。
   * 内部按 nowMs 计算时钟相位与脉冲窗口。
   * @param {number} nowMs 单调递增的毫秒时间戳
   */
  Engine.prototype.step = function (nowMs) {
    if (typeof nowMs === 'number' && isFinite(nowMs)) this._now = nowMs;
    var now = this._now;

    // H1'（2026-10-30 性能审查遗留项）：同一时刻且电气状态未变更的重入直接复用
    // 上次求值结果。P1 自动重算、H8 跳帧后的 getState、UI refresh 的显式 step 都
    // 会落到这里——重复「收敛迭代 + _buildState + 签名」是纯浪费（实测约
    // 80~250µs/次）。失效点：所有变更类 API / 接线 / reset（经 _touchState）；
    // 时刻变化（now !== _stateNow）自然绕过缓存。
    // 消费方契约：state 对象只读（全仓审计无写者；advisor 的「审查前后
    // getState() 逐字节一致」在记忆化后由同一引用恒成立）。
    if (!this._stateDirty && this._state && now === this._stateNow) {
      return this._state;
    }

    // P7：观测实际推进步长（0 < Δt ≤ MAX_TRACK_DT_MS 时更新）。
    // 同一时刻的幂等重算（P1 自动重算、H8 跳过帧）不改变观测值；
    // 超过 MAX_TRACK_DT_MS 的跳变视为手动推进，不更新（沿用上次观测值）。
    // 混叠告警阈值（2×步长）随观测值自适应，_stepDtMs 变化时置脏 H2 缓存。
    if (now > this._lastAdvanceAt) {
      var dtObserved = now - this._lastAdvanceAt;
      this._lastAdvanceAt = now;
      if (dtObserved <= MAX_TRACK_DT_MS && this._stepDtMs !== dtObserved) {
        this._stepDtMs = dtObserved;
        this._aliasDirty = true;
      }
    }

    var board = this._collectBoardDrivers(now);
    var fixedLevels = board.fixed;
    var boardDrivers = board.drivers;

    // 本次 step 内的冲突网集合（跨迭代累积）
    this._conflictIds = Object.create(null);

    // 迭代求值：组合逻辑可能需要多拍收敛
    var chipDrivers = Object.create(null);
    var converged = false;
    var iter = 0;
    var result = this._computeLevels(boardDrivers, chipDrivers, fixedLevels);
    for (iter = 0; iter < MAX_ITER; iter++) {
      var next = this._evalChips(result.jackLevels);
      if (sameDriverMap(next, chipDrivers)) {
        converged = true;
        break;
      }
      chipDrivers = next;
      result = this._computeLevels(boardDrivers, chipDrivers, fixedLevels);
    }
    if (!converged) {
      // 最后一次再算一遍，保证输出与驱动一致
      chipDrivers = this._evalChips(result.jackLevels);
      result = this._computeLevels(boardDrivers, chipDrivers, fixedLevels);
    }

    var state = this._buildState(result, converged, now);
    this._state = state;
    this._stateDirty = false;   // H1'：本次结果已覆盖当前 (now, 状态)
    this._stateNow = now;

    var sig = stateSignature(state);
    if (sig !== this._lastSignature) {
      this._lastSignature = sig;
      this._notify(state);
    }
    return state;
  };

  /** 比较两个驱动表是否一致 */
  function sameDriverMap(a, b) {
    var k;
    for (k in a) {
      if (Object.prototype.hasOwnProperty.call(a, k) && a[k] !== b[k]) return false;
    }
    for (k in b) {
      if (Object.prototype.hasOwnProperty.call(b, k) && a[k] !== b[k]) return false;
    }
    return true;
  }

  /** 状态指纹（用于判断是否需要通知订阅者） */
  function stateSignature(state) {
    var parts = [];
    var k;
    for (k in state.jacks) {
      if (Object.prototype.hasOwnProperty.call(state.jacks, k)) parts.push(k + '=' + state.jacks[k]);
    }
    for (k in state.leds) {
      if (Object.prototype.hasOwnProperty.call(state.leds, k)) parts.push(k + ':' + (state.leds[k] ? 1 : 0));
    }
    for (k in state.segOn) {
      if (Object.prototype.hasOwnProperty.call(state.segOn, k)) {
        var seg = state.segOn[k];
        for (var s in seg) {
          if (Object.prototype.hasOwnProperty.call(seg, s)) parts.push(k + '.' + s + ':' + (seg[s] ? 1 : 0));
        }
      }
    }
    parts.push('shorts:' + state.shorts.length);
    // 板载仪器状态（逻辑笔显示 / 信号源编码器灯 / 电位器判读 / 音频与示波器信号）
    if (state.probe) parts.push('probe:' + state.probe.display + ':' + state.probe.mode);
    if (state.dds) {
      // 频率 / 幅度 / 波形都进指纹：只调参数不改电平时，订阅者也要刷新读数与示波器
      parts.push('dds:' + state.dds.sel + ':' + state.dds.freqHz + ':' + state.dds.amplitudeV +
        ':' + state.dds.waveform + ':' + (state.dds.active ? 1 : 0));
    }
    if (state.pot) {
      parts.push('pot:' + state.pot.ratio + ':' +
        (state.pot.volts === null ? 'n' : Math.round(state.pot.volts * 100) / 100) + ':' +
        (state.pot.level === null ? 'n' : state.pot.level));
    }
    var an = state.analog;
    if (an) {
      parts.push('beep:' + (an.beep && an.beep.on ? 1 : 0));
      parts.push('spk:' + (an.spk && an.spk.driveHz ? an.spk.driveHz : 0));
      parts.push('ach1:' + (an.ach1 ? an.ach1.wave + ':' + an.ach1.level : 'none'));
    }
    return parts.join('|');
  }

  /** seg3~seg8 中是否至少有一个段孔被驱动（非 'Z'） */
  function hasDrivenSeg3to8(segs) {
    for (var i = 3; i <= SEG_COUNT; i++) {
      var seg = segs['seg' + i];
      if (!seg) continue;
      for (var k in seg) {
        if (Object.prototype.hasOwnProperty.call(seg, k) && seg[k] !== LZ) return true;
      }
    }
    return false;
  }

  /**
   * P3：根据跨步电平翻转估计 SPK 输入网的驱动频率（测量法，写回 analog.spk）。
   * - clock / DDS 源：保持精确 source.freqHz（既有行为），不产生 measuredHz；
   * - 逻辑源（门电路 / 触发器输出等）与脉冲源：用最近 SPK_EDGE_KEEP 条边沿的
   *   间隔估计频率；边沿不足 SPK_MIN_EDGES 条、或间隔不稳定（均值 ±50% 之外）
   *   时不给音调（driveHz 保持 null，只剩电平边沿「嗒」声）——避免单脉冲、
   *   手动接线抖动被误判成连续音。
   * 同一虚拟时刻只采样一次：P1 幂等重算 / 重复 step 不产生虚假边沿。
   * 假设（已记录）：实测频率超过采样 Nyquist（1/(2×步长)）时不可信；此类接线
   * 在时序芯片时钟脚场景已由 P2 混叠告警覆盖，扬声器侧按实测值发声。
   */
  Engine.prototype._measureSpkTone = function (analog, now) {
    var track = this._spkTrack;
    var spk = analog.spk;
    var level = spk ? spk.level : LZ;

    if (track.lastNow !== now) {
      // 只有 0↔1 的翻转才算音调边沿：Z→电平（首次上电 / 拔线）与 X 参与的
      // 跳变不代表扬声器振动，不进入测频窗口。
      var toneFlip = level !== track.lastLevel &&
        (level === L0 || level === L1) &&
        (track.lastLevel === L0 || track.lastLevel === L1);
      if (track.lastLevel !== null && toneFlip) {
        track.edges.push(now);
        if (track.edges.length > SPK_EDGE_KEEP) track.edges.shift();
      }
      track.lastLevel = level;
      track.lastNow = now;
    }

    var src = spk && spk.source;
    if (src && (src.type === 'clock' || src.type === 'dds')) {
      spk.driveHz = src.freqHz;     // 既有行为：精确源频率
      return;                       // measuredHz 仅在逻辑源测频时有意义（字段条件出现）
    }

    var measured = null;
    var n = track.edges.length;
    if (n >= SPK_MIN_EDGES) {
      var span = track.edges[n - 1] - track.edges[0];
      if (span > 0) {
        var avgHalf = span / (n - 1);            // 平均半周期（ms）
        var stable = true;
        for (var i = 1; i < n; i++) {
          var iv = track.edges[i] - track.edges[i - 1];
          if (iv < avgHalf * 0.5 || iv > avgHalf * 1.5) { stable = false; break; }
        }
        if (stable) {
          var hz = 1000 / (2 * avgHalf);
          // 抖动抑制：≥1kHz 取整，<1kHz 保留 1 位小数（状态签名随之稳定）
          measured = hz >= 1000 ? Math.round(hz) : Math.round(hz * 10) / 10;
        }
      }
    }
    if (measured !== null) {
      spk.measuredHz = measured;    // 实测频率（仅逻辑源测频成功时出现该字段）
      spk.driveHz = measured;
    }
  };

  /**
   * 分析某个「受电」插孔（蜂鸣器 / 功放 / 示波器输入等）所在网的驱动来源。
   * @returns {{level:string, source:object|null}} source 形如
   *   { type:'clock', freqHz } | { type:'dds', freqHz, wave } | { type:'pulse' }
   *   | { type:'dc' } | { type:'logic' }
   */
  Engine.prototype._analyzeSink = function (jackId, netInfo) {
    var net = null;
    for (var i = 0; i < netInfo.length; i++) {
      if (netInfo[i].jacks.indexOf(jackId) >= 0) { net = netInfo[i]; break; }
    }
    if (!net) return { level: LZ, source: null };

    var source = null;
    for (var d = 0; d < net.drivers.length; d++) {
      var drvId = net.drivers[d];
      var rec = this._jacks[drvId];
      if (!rec) {
        // P5a（2026-10-30 审查遗留项）：网表 drivers 里还有「固定铜箔网名」
        // （VCC / GND，_computeLevels 最先推入）。它们是电源性质而非芯片输出，
        // 应按直流源归类——原先一律判 'logic'，会让「接 VCC 的蜂鸣器」来源显示错。
        if (drvId === 'VCC' || drvId === 'GND') {
          if (!source) source = { type: 'dc' };
          continue;
        }
        source = { type: 'logic' };
        continue;
      }
      var mod = rec.moduleId;
      var label = rec.label;
      if (mod === 'clock') {
        source = { type: 'clock', freqHz: CLOCK_FREQS[label] || 1 };
        break;                       // 时钟源信息量最大，优先采用
      }
      if (mod === 'mid' && label === 'DDS') {
        source = { type: 'dds', freqHz: this._dds.freqHz, wave: this._dds.waveform };
        break;
      }
      if (mod === 'pulse') { source = source || { type: 'pulse' }; continue; }
      // P5a：电源 / 地 / 开关都是直流性质（地孔原先也会落到 'logic'，同属本项修正）
      if (mod === 'pwr' || mod === 'gnd' || mod === 'sw') { source = source || { type: 'dc' }; continue; }
      if (mod === 'rc') { source = source || { type: 'dc' }; continue; } // 电位器滑动端
      source = { type: 'logic' };    // 芯片输出等
    }
    return { level: net.level, source: source };
  };

  /** 组装对外状态对象 */
  Engine.prototype._buildState = function (result, converged, now) {
    var jackLevels = result.jackLevels;
    var netInfo = result.netInfo;
    var i, j, id, rec, level;

    // ---- 全量插孔电平 ----
    var jacks = {};
    for (i = 0; i < this._jackIds.length; i++) {
      id = this._jackIds[i];
      level = jackLevels[id];
      jacks[id] = Logic.isLevel(level) ? level : LZ;
    }

    // ---- 发光二极管 4L1~4L16 ----
    var leds = {};
    for (i = 1; i <= LED_COUNT; i++) {
      var ledJack = this.findJack('led', '4P' + i);
      leds['4L' + i] = !!(ledJack && jacks[ledJack] === L1);
    }

    // ---- 开关状态灯 5L1~5L16 ----
    var swLeds = {};
    for (i = 1; i <= SW_COUNT; i++) {
      swLeds['5L' + i] = this._switches[i - 1] === 1;
    }

    // ---- 数码管：显示区 1（seg1/seg2 直驱）与 显示区 2（seg3~seg8 6位内置BCD译码驱动）----
    var segs = {};
    var segOn = {};
    var digits = {};
    for (var si = 1; si <= SEG_COUNT; si++) {
      var segId = 'seg' + si;
      var rawSeg = {};
      var onSeg = {};

      if (si <= 2) {
        // 显示区 1：直驱段码（seg1 共阳，seg2 共阴）
        var segKeys1 = SEG_LAYOUT[segId];
        var anode1 = !!SEG_ANODE[segId];
        for (j = 0; j < segKeys1.length; j++) {
          var k1 = segKeys1[j];
          var lab1 = SEG_LABEL_PREFIX[k1] + si;
          var jid1 = this.findJack(segId, lab1);
          var lv1 = (jid1 && jacks[jid1]) ? jacks[jid1] : LZ;
          rawSeg[k1] = lv1;
          if (!this._power) {
            onSeg[k1] = false;
          } else if (anode1) {
            onSeg[k1] = (lv1 === L0);
          } else {
            onSeg[k1] = (lv1 === L1);
          }
        }
        segs[segId] = rawSeg;
        segOn[segId] = onSeg;
        digits[segId] = null;
      } else {
        // 显示区 2：6 位内置 BCD/十六进制译码器驱动（A:2^0, B:2^1, C:2^2, D:2^3, DP:小数点）
        var inKeys = ['a', 'b', 'c', 'd', 'dp'];
        for (j = 0; j < inKeys.length; j++) {
          var ik = inKeys[j];
          var ilab = SEG_LABEL_PREFIX[ik] + si;
          var ijid = this.findJack(segId, ilab);
          rawSeg[ik] = (ijid && jacks[ijid]) ? jacks[ijid] : LZ;
        }

        var lvA = rawSeg.a;
        var lvB = rawSeg.b;
        var lvC = rawSeg.c;
        var lvD = rawSeg.d;
        var lvDP = rawSeg.dp;

        var allZ = (lvA === LZ && lvB === LZ && lvC === LZ && lvD === LZ);
        var litDp = (this._power && lvDP === L1);

        if (!this._power || allZ) {
          // 未通电或 A/B/C/D 全部悬空未接线时，数码管完全熄灭（全黑，避免悬空显示错误字符）
          onSeg = { a: false, b: false, c: false, d: false, e: false, f: false, g: false, dp: litDp };
          digits[segId] = null;
        } else {
          var b0 = (lvA === L1) ? 1 : 0;
          var b1 = (lvB === L1) ? 2 : 0;
          var b2 = (lvC === L1) ? 4 : 0;
          var b3 = (lvD === L1) ? 8 : 0;
          var code = b3 | b2 | b1 | b0;
          var pat = HEX_SEG_DECODE[code];
          digits[segId] = HEX_DIGIT_CHARS[code];
          onSeg = {
            a: !!pat.a,
            b: !!pat.b,
            c: !!pat.c,
            d: !!pat.d,
            e: !!pat.e,
            f: !!pat.f,
            g: !!pat.g,
            dp: litDp
          };
        }
        segs[segId] = rawSeg;
        segOn[segId] = onSeg;
      }
    }

    // ---- 单脉冲指示灯 6L1~6L6 ----
    var pulses = {};
    for (i = 1; i <= PULSE_COUNT; i++) {
      pulses['6L' + i] = now < this._pulseUntil[i - 1];
    }

    // ---- 逻辑笔：P01 输入判读（TTL 悬空按高，CMOS 悬空按高阻）----
    var probeJack = this.findJack('probe', 'P01');
    var probeLevel = (probeJack && jacks[probeJack]) ? jacks[probeJack] : LZ;
    var probeDisplay = 'Z';
    if (probeLevel === L1) {
      probeDisplay = 'H';
    } else if (probeLevel === L0) {
      probeDisplay = 'L';
    } else if (probeLevel === LZ && this._probeMode === 'TTL') {
      probeDisplay = 'H';          // TTL 输入悬空浮高
    }
    // 冲突（X）按高阻显示：笔尖电压不定，三灯都不给出确定判读
    var probe = { mode: this._probeMode, level: probeLevel, display: probeDisplay };

    // ---- 信号源 DDS ----
    var ddsActive = this._power && this._dds.amplitudeV >= DDS_TTL_THRESHOLD;
    var ddsState = {
      freqHz: this._dds.freqHz,
      amplitudeV: this._dds.amplitudeV,
      waveform: this._dds.waveform,
      sel: this._dds.sel,
      active: ddsActive
    };

    // ---- 电位器 ----
    var potLevel = (this._potVolts === null) ? null : (this._potVolts >= POT_THRESHOLD ? L1 : L0);
    var potState = { ratio: this._potRatio, volts: this._potVolts, level: potLevel };

    // ---- 板载仪器信号分析（蜂鸣器 / 功放 / 示波器输入网）----
    var analog = {
      beep: this._analyzeSink('mid:BEEP', netInfo),
      spk: this._analyzeSink('mid:SPK', netInfo),
      ach1: this._analyzeSink('mid:ACH1', netInfo)
    };
    analog.beep.on = !!(this._power && analog.beep.level === L1);
    analog.spk.driveHz = null;
    if (analog.spk.source && (analog.spk.source.type === 'clock' || analog.spk.source.type === 'dds')) {
      analog.spk.driveHz = analog.spk.source.freqHz;
    }
    var ach1Src = analog.ach1.source;
    if (ach1Src && (ach1Src.type === 'clock' || ach1Src.type === 'dds') &&
        analog.ach1.level !== LZ && analog.ach1.level !== LX) {
      // 时钟 / DDS 接入：示波器按对应交流波形显示。
      // DDS 幅度低于 TTL 阈值时输出恒为低电平（ddsLevel 恒回 L0），按直流处理。
      analog.ach1.wave = (ach1Src.type === 'dds')
        ? (ddsActive ? (ach1Src.wave || 'square') : 'dc')
        : 'square';
    } else if (!analog.ach1.wave) {
      // 未接交流源：按当前电平显示直流（悬空 / 冲突都显示为无信号基线）
      analog.ach1.wave = (ach1Src && analog.ach1.level !== LZ && analog.ach1.level !== LX) ? 'dc' : 'none';
    }

    // ---- P3：扬声器驱动频率（2026-10-30 审查遗留项）----
    // 板载时钟 / DDS 直驱仍用精确源频率；门电路等逻辑源驱动改为「跨步电平
    // 翻转实测」。直流仍只保留接通瞬间的「嗒」声（sound.js 电平边沿检测）。
    this._measureSpkTone(analog, now);

    // ---- 短路 / 冲突 ----
    var shorts = [];
    var conflictIds = this._conflictIds || Object.create(null);
    for (i = 0; i < netInfo.length; i++) {
      var net = netInfo[i];
      if (net.level !== LX) continue;
      var bothFixed = net.fixedNets.indexOf('VCC') >= 0 && net.fixedNets.indexOf('GND') >= 0;
      if (net.conflict || bothFixed || conflictIds[net.id]) {
        shorts.push({ netId: net.id, level: LX, jacks: net.jacks.slice() });
      }
    }

    // ---- 中文告警 ----
    var warnings = [];
    if (!converged) {
      warnings.push('组合逻辑存在环路或振荡，仿真结果可能不稳定');
    }
    if (!this._power) {
      warnings.push('电源总开关已关闭，整板无驱动（插孔呈高阻）');
    }
    for (i = 0; i < shorts.length; i++) {
      var sn = shorts[i];
      var hasVcc = false;
      var hasGnd = false;
      for (j = 0; j < netInfo.length; j++) {
        if (netInfo[j].id === sn.netId) {
          hasVcc = netInfo[j].fixedNets.indexOf('VCC') >= 0;
          hasGnd = netInfo[j].fixedNets.indexOf('GND') >= 0;
          break;
        }
      }
      if (hasVcc && hasGnd) {
        warnings.push('短路告警：VCC 与 GND 被导线直接连通（' + sn.netId + '），请立即断开');
      } else {
        warnings.push('冲突告警：' + sn.netId + ' 上同时存在强 1 与强 0 驱动');
      }
    }
    // seg3~seg8 为内置译码驱动器提示（含十六进制字形假设注明，2026-10-30 P4 决定）
    if (hasDrivenSeg3to8(segs)) {
      warnings.push('数码管 seg3~seg8 为内置 BCD/十六进制译码显示驱动（A/B/C/D 输入，DP 为小数点）。' +
        '输入 0~9 显示十进制数字；输入 10~15 按十六进制字形 A~F 显示——此为本仿真的假设，' +
        '实物内置译码器的实际字形以实验指导书 / 器件手册为准');
    }
    // P2：时钟 / DDS 快于 2×仿真步长时给出混叠告警
    var aliasWarnings = this._collectAliasWarnings();
    for (i = 0; i < aliasWarnings.length; i++) warnings.push(aliasWarnings[i]);
    // 信号源幅度低于 TTL 阈值：输出恒为低电平（只在其输出已接线时提示）
    if (this._power && this._dds.amplitudeV < DDS_TTL_THRESHOLD) {
      var ddsJack = this.findJack('mid', 'DDS');
      var ddsNet = ddsJack ? this._netByJack[ddsJack] : null;
      if (ddsNet && ddsNet.jacks.length > 1) {
        warnings.push('信号源幅度 ' + this._dds.amplitudeV.toFixed(1) + 'V 低于 TTL 阈值 ' +
          DDS_TTL_THRESHOLD + 'V，DDS 输出恒为低电平');
      }
    }
    if (this._fallbackGeometry) {
      warnings.push('未加载 panelGeometry.generated.js，正在使用内置回退插孔表');
    }
    if (this._boardNetError) {
      warnings.push('板内走线模型推导失败，已按「无板内连通」降级：' + this._boardNetError);
    }

    return {
      jacks: jacks,
      nets: netInfo.map(function (n) {
        return { id: n.id, jacks: n.jacks.slice(), level: n.level, drivers: n.drivers.slice() };
      }),
      leds: leds,
      swLeds: swLeds,
      segs: segs,
      segOn: segOn,
      digits: digits,
      pulses: pulses,
      // 板载仪器状态（新增字段，不影响既有字段）
      probe: probe,
      dds: ddsState,
      pot: potState,
      analog: analog,
      shorts: shorts,
      warnings: warnings,
      now: now,
      power: this._power,
      clockEnabled: this._clockEnabled,
      // 板内固定铜箔连通组（新增字段，不影响已有字段）
      boardNetGroups: this._boardNetGroups.map(function (g) {
        return { id: g.id, jacks: g.jacks.slice() };
      })
    };
  };

  /** 读取上一次 step 得到的状态（首次调用前会自动算一遍） */
  Engine.prototype.getState = function () {
    if (!this._state) this.step(this._now);
    return this._state;
  };

  /** 单孔电平：'0' | '1' | 'Z' | 'X'（未知插孔返回 'Z'） */
  Engine.prototype.getJackLevel = function (id) {
    var st = this.getState();
    var v = st.jacks[id];
    return Logic.isLevel(v) ? v : LZ;
  };

  /** 订阅状态变化，返回取消订阅函数 */
  Engine.prototype.onStateUpdate = function (fn) {
    if (typeof fn !== 'function') throw new Error('onStateUpdate 需要一个函数');
    this._listeners.push(fn);
    var self = this;
    return function () {
      var idx = self._listeners.indexOf(fn);
      if (idx >= 0) self._listeners.splice(idx, 1);
    };
  };

  /** 通知订阅者 */
  Engine.prototype._notify = function (state) {
    for (var i = 0; i < this._listeners.length; i++) {
      try {
        this._listeners[i](state);
      } catch (err) {
        // 单个订阅者异常不影响引擎
        if (typeof console !== 'undefined' && console.error) console.error('[DLab.Engine] 订阅者异常：', err);
      }
    }
  };

  /** 复位：清空导线与芯片，开关归零，板载仪器恢复默认，恢复上电与时钟使能 */
  Engine.prototype.reset = function () {
    this._netlist.clearWires();
    this._applyBoardNetGroups();   // 重建并查集后补回板内固定走线
    this._touchNets();
    this._chips = Object.create(null);
    for (var i = 0; i < SW_COUNT; i++) this._switches[i] = 0;
    for (i = 0; i < PULSE_COUNT; i++) { this._pulseUntil[i] = 0; this._pulseCount[i] = 0; }
    this._power = true;
    this._clockEnabled = true;
    this._probeMode = 'TTL';
    this._dds = { freqHz: 1000, amplitudeV: 5, waveform: 'square', sel: 'freq' };
    this._potRatio = 0.5;
    this._potVolts = null;
    this._lastSignature = null;
    this._stepDtMs = DEFAULT_STEP_MS;   // 观测步长一并恢复默认
    this._lastAdvanceAt = this._now;    // P7：观测基准归位，后续 Δt 从当前时刻重新计量
    this._aliasDirty = true;
    this._spkTrack = { lastNow: null, lastLevel: null, edges: [] };   // P3：测频窗口一并清空
    this._touchState();                 // H1'：reset 改变电气状态，同刻记忆化需失效
    return this.step(this._now);
  };

  /* ============================================================
   * 11. 导出
   * ============================================================ */

  Engine.CLOCK_FREQS = CLOCK_FREQS;
  Engine.SOCKET_SPEC = SOCKET_SPEC;
  Engine.SEG_LAYOUT = SEG_LAYOUT;
  Engine.PULSE_WIDTH_MS = PULSE_WIDTH_MS;
  Engine.DDS_FREQ_STEPS = DDS_FREQ_STEPS;
  Engine.DDS_FREQ_MIN = DDS_FREQ_MIN;
  Engine.DDS_FREQ_MAX = DDS_FREQ_MAX;
  Engine.DDS_AMP_STEP = DDS_AMP_STEP;
  Engine.DDS_AMP_MAX = DDS_AMP_MAX;
  Engine.DDS_TTL_THRESHOLD = DDS_TTL_THRESHOLD;
  Engine.PROBE_MODES = PROBE_MODES;
  Engine.POT_THRESHOLD = POT_THRESHOLD;
  Engine.BUZZER_TONE_HZ = BUZZER_TONE_HZ;
  Engine.buildFallbackGeometry = buildFallbackGeometry;

  DLab.Engine = Engine;

})(typeof globalThis !== 'undefined' ? globalThis : this);

// src/core/advisor.js
// 接线审查与故障诊断（纯逻辑、**只读**、Node 可测）。
// ------------------------------------------------------------------
// 契约：docs/STAGE4-CONTRACTS.md §5.1
//   DLab.Advisor = { LEVELS: {...}, review(engine, options) → report }
//
// 铁律（务必保持）：
//   · 本模块**只读**：不增删导线、不插拔芯片、不改开关、不推进仿真。
//     审查前后 engine.getState() 必须逐字节一致（自测里有断言）。
//   · 判据只来自三处：engine.getState()（jacks / nets / shorts）、
//     DLab.Chips.get(model).pinNames（引脚名）、engine.socketJack(socketId, pin)（插孔）。
//   · 经典脚本 + 全局命名空间 DLab，浏览器与 Node 双端可加载；零依赖、零 ES Module。
(function (global) {
  'use strict';
  var DLab = (global.DLab = global.DLab || {});

  /* ============================================================
   * 1. 常量
   * ============================================================ */

  /** 问题级别（契约固定，不可改名） */
  var LEVELS = { ERROR: 'error', WARN: 'warn', INFO: 'info' };

  /**
   * 低有效使能端名里必须出现的关键字（契约 §5.1 ENABLE_FLOATING 一行）：
   * 名字以 '~' 开头，且含 EN / CLR / PRE / LOAD / PE / OE 之一。
   */
  var ENABLE_TOKENS = ['EN', 'CLR', 'PRE', 'LOAD', 'PE', 'OE'];

  /**
   * 异步清零 / 置位端的关键字。
   * 契约写的是 ~CLR / ~PRE；74LS160 / 74LS161 / 74LS194 / 74LS273 的同功能端
   * 在本芯片库里叫 ~MR，语义完全一致（低有效钳位），故一并按 RESET_HELD 处理，
   * 否则「异步清零端接地」这种典型错误会漏报。
   */
  var RESET_TOKENS = ['CLR', 'PRE', 'MR'];

  /**
   * 契约关键词表没覆盖到的低有效使能/选通端（**精确匹配整名**）。
   *   ~G2A / ~G2B —— 74LS138 的低有效地址使能
   *   ~S         —— 74LS151 的低有效选通
   *   ~EI        —— 74LS148 的低有效使能
   *   ~1G / ~2G  —— 74LS153 的低有效使能
   * 这些端子语义上就是「低有效使能端」，契约的关键词表只是没列全；
   * 不补的话，74LS138 最常见的「忘了接地」就会退化成普通输入悬空。
   */
  var EXTRA_ENABLE_NAMES = ['~G2A', '~G2B', '~S', '~EI', '~1G', '~2G'];

  /** 时序芯片型号（契约 §5.1 CLOCK_FLOATING 一行明确列出） */
  var SEQUENTIAL_MODELS = ['74LS74', '74LS112', '74LS160', '74LS161', '74LS194', '74LS273'];

  /** 全部芯片插座 id（与 CONTRACTS §4.2 一致） */
  var SOCKET_IDS = [
    'devA:UA', 'devA:UB', 'devA:UE', 'devA:UD', 'devA:UF',
    'devB:UA', 'devB:UB', 'devB:UE', 'devB:UD', 'devB:UF'
  ];

  /** 英文四态电平 */
  var L0 = '0';
  var L1 = '1';
  var LZ = 'Z';
  var LX = 'X';

  /* ============================================================
   * 2. 小工具
   * ============================================================ */

  /** 是否自有属性 */
  function has(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** 取插孔电平；未知插孔按 'Z' 处理 */
  function levelOf(state, jackId) {
    if (!jackId || !state || !state.jacks) return LZ;
    var v = state.jacks[jackId];
    return (v === L0 || v === L1 || v === LZ || v === LX) ? v : LZ;
  }

  /** 引脚号 -> 引脚名（由 pinNames 反查） */
  function buildPinNameIndex(def) {
    var idx = Object.create(null);
    if (!def || !def.pinNames) return idx;
    for (var name in def.pinNames) {
      if (has(def.pinNames, name)) idx[def.pinNames[name]] = name;
    }
    return idx;
  }

  /** 引脚名是否低有效（以 '~' 开头） */
  function isActiveLow(name) {
    return typeof name === 'string' && name.charAt(0) === '~';
  }

  /** 引脚名是否含指定关键字（区分大小写，与芯片库写法一致） */
  function nameHasToken(name, tokens) {
    if (typeof name !== 'string') return false;
    for (var i = 0; i < tokens.length; i++) {
      if (name.indexOf(tokens[i]) >= 0) return true;
    }
    return false;
  }

  /**
   * 是否低有效使能端。
   * 判据 = 契约关键词规则（'~' 开头且含 EN/CLR/PRE/LOAD/PE/OE）
   *       或 EXTRA_ENABLE_NAMES 里的精确整名。
   */
  function isEnablePinName(name) {
    if (!isActiveLow(name)) return false;
    if (nameHasToken(name, ENABLE_TOKENS)) return true;
    return EXTRA_ENABLE_NAMES.indexOf(name) >= 0;
  }

  /** 是否异步复位/置位端（~CLR / ~PRE / ~MR） */
  function isResetPinName(name) {
    return isActiveLow(name) && nameHasToken(name, RESET_TOKENS);
  }

  /** 是否时钟端（引脚名含 CLK） */
  function isClockPinName(name) {
    return typeof name === 'string' && name.indexOf('CLK') >= 0;
  }

  /** 型号是否为时序芯片 */
  function isSequentialModel(model) {
    return SEQUENTIAL_MODELS.indexOf(model) >= 0;
  }

  /* ============================================================
   * 3. 芯片输出脚识别
   *    芯片库没有单独声明「哪些脚是输出」，但每个型号的 eval()
   *    都会返回「输出引脚号 -> 电平」的表。用一份**一次性**的探测上下文
   *    （不碰引擎里的 ctx）跑一次 eval，取返回表的键即可得到输出脚集合。
   *    这样不需要在助教侧重复维护一份引脚表，也不会与芯片库脱节。
   * ============================================================ */

  var outputPinsCache = Object.create(null);

  /** 兜底：按引脚名猜输出脚（探测失败时用） */
  function guessOutputPins(def) {
    var pins = Object.create(null);
    var names = (def && def.pinNames) || {};
    for (var name in names) {
      if (!has(names, name)) continue;
      var upper = String(name).toUpperCase();
      if (/^~\d+Q$/.test(upper)) { pins[names[name]] = true; continue; }
      if (/^(Q\d+|Y\d+|A\d+|GS|EO|RCO|W|\d+Y|\d+Q|\d+OUT)$/.test(upper)) {
        pins[names[name]] = true;
      }
    }
    return pins;
  }

  /**
   * 取某型号的输出引脚号集合（结果缓存）。
   * @param {object} def DLab.Chips.get(model)
   * @returns {Object} { 引脚号: true }
   */
  function detectOutputPins(def) {
    if (!def) return {};
    var key = def.model || '__unknown__';
    if (has(outputPinsCache, key)) return outputPinsCache[key];

    var pins = Object.create(null);
    var detected = false;
    try {
      var pinLevels = {};
      for (var i = 0; i < def.pins.length; i++) pinLevels[def.pins[i]] = LZ;
      // 探测用一次性上下文：绝不碰引擎里那颗芯片的 ctx（否则会改动引擎状态）
      var probe = { state: {}, isTTL: true };
      var res = def.eval(pinLevels, probe);
      if (res && typeof res === 'object') {
        for (var p in res) {
          if (!has(res, p)) continue;
          var n = parseInt(p, 10);
          if (isFinite(n)) { pins[n] = true; detected = true; }
        }
      }
    } catch (err) {
      detected = false;
    }
    if (!detected) pins = guessOutputPins(def);

    outputPinsCache[key] = pins;
    return pins;
  }

  /* ============================================================
   * 4. 审查主流程
   * ============================================================ */

  /**
   * 审查当前电路。**只读**：不改变引擎任何状态。
   * @param {object} engine DLab.Engine 实例
   * @param {object} [options] { now?: number } 可注入时间戳
   * @returns {object} 契约 §5.1 结构的 report
   */
  function review(engine, options) {
    options = options || {};
    var issues = [];
    var counters = Object.create(null);

    /** 追加一条问题 */
    function push(level, code, title, detail, hint, jacks, socketId, pin) {
      counters[code] = (counters[code] || 0) + 1;
      issues.push({
        id: code + '#' + counters[code],
        level: level,
        code: code,
        title: title,
        detail: detail,
        hint: hint,
        jacks: (jacks && jacks.length) ? jacks.slice() : [],
        socketId: socketId || null,
        pin: (typeof pin === 'number' && isFinite(pin)) ? pin : null
      });
    }

    // ---- 读取（全部只读）----
    var state = null;
    var wires = [];
    var chips = {};
    try {
      state = (engine && typeof engine.getState === 'function') ? engine.getState() : null;
    } catch (err) {
      state = null;
    }
    try {
      wires = (engine && typeof engine.getWires === 'function') ? engine.getWires() : [];
    } catch (err) {
      wires = [];
    }
    try {
      chips = (engine && typeof engine.getChips === 'function') ? engine.getChips() : {};
    } catch (err) {
      chips = {};
    }
    // 兜底：引擎若只有 getChip()，就按已知插座列表逐个问一次
    if ((!chips || !Object.keys(chips).length) && engine && typeof engine.getChip === 'function') {
      chips = {};
      for (var si = 0; si < SOCKET_IDS.length; si++) {
        try {
          var model2 = engine.getChip(SOCKET_IDS[si]);
          if (model2) chips[SOCKET_IDS[si]] = model2;
        } catch (err2) {
          // 非法插座直接跳过
        }
      }
    }
    if (!state) state = { jacks: {}, nets: [], shorts: [] };
    if (!Array.isArray(wires)) wires = [];
    if (!chips || typeof chips !== 'object') chips = {};

    var nets = Array.isArray(state.nets) ? state.nets : [];
    var shorts = Array.isArray(state.shorts) ? state.shorts : [];

    // 插孔 -> 网
    var netByJack = Object.create(null);
    for (var n = 0; n < nets.length; n++) {
      var net = nets[n];
      if (!net || !Array.isArray(net.jacks)) continue;
      for (var j = 0; j < net.jacks.length; j++) netByJack[net.jacks[j]] = net;
    }

    // ---- 统计用：哪些插孔是「芯片输出脚」----
    var Chips = DLab.Chips || null;
    var socketIds = [];
    for (var sid in chips) {
      if (has(chips, sid)) socketIds.push(sid);
    }
    socketIds.sort();

    var outputJacks = Object.create(null);   // jackId -> true
    var chipInfos = [];                       // { socketId, model, def, pinNames }

    for (var s = 0; s < socketIds.length; s++) {
      var socketId = socketIds[s];
      var model = chips[socketId];
      var def = (Chips && typeof Chips.get === 'function') ? Chips.get(model) : null;
      if (!def) continue;
      var outPins = detectOutputPins(def);
      for (var op in outPins) {
        if (!has(outPins, op)) continue;
        var oj = socketJackOf(engine, socketId, parseInt(op, 10));
        if (oj) outputJacks[oj] = true;
      }
      chipInfos.push({
        socketId: socketId,
        model: model,
        def: def,
        pinNames: buildPinNameIndex(def)
      });
    }

    // ---- 1) 供电 / 接地 / 悬空 / 钳位 ----
    var floatingPins = 0;
    var poweredChips = 0;

    for (var ci = 0; ci < chipInfos.length; ci++) {
      var info = chipInfos[ci];
      var def2 = info.def;
      var label = info.socketId + '（' + info.model + '）';

      // VCC
      var vccJack = socketJackOf(engine, info.socketId, def2.vccPin);
      var vccLevel = levelOf(state, vccJack);
      if (vccLevel !== L1) {
        push(LEVELS.ERROR, 'NO_POWER', '芯片未供电',
          label + ' 的 VCC 引脚（' + def2.vccPin + ' 脚，插孔 ' + jackText(vccJack) +
            '）所在网电平为 ' + vccLevel,
          '把 ' + jackText(vccJack) + ' 接到 pwr:5V1（或 devA:VCC / pwr:5V2），并确认电源总开关已打开',
          [vccJack], info.socketId, def2.vccPin);
      } else {
        poweredChips += 1;
      }

      // GND
      var gndJack = socketJackOf(engine, info.socketId, def2.gndPin);
      var gndLevel = levelOf(state, gndJack);
      if (gndLevel !== L0) {
        push(LEVELS.ERROR, 'NO_GROUND', '芯片未接地',
          label + ' 的 GND 引脚（' + def2.gndPin + ' 脚，插孔 ' + jackText(gndJack) +
            '）所在网电平为 ' + gndLevel,
          '把 ' + jackText(gndJack) + ' 接到 gnd:GND1（或 devA:GND / gnd:GND2），芯片必须与地共参考',
          [gndJack], info.socketId, def2.gndPin);
      }

      // 逐脚检查
      var outPins2 = detectOutputPins(def2);
      for (var pi = 0; pi < def2.pins.length; pi++) {
        var pin = def2.pins[pi];
        if (pin === def2.vccPin || pin === def2.gndPin) continue;
        var jackId = socketJackOf(engine, info.socketId, pin);
        var level = levelOf(state, jackId);
        var pinName = has(info.pinNames, pin) ? info.pinNames[pin] : ('pin' + pin);
        var isOut = !!outPins2[pin];

        if (isOut) {
          // 输出脚：悬空（该网再无其它插孔）时提示
          var net = netByJack[jackId];
          var netSize = (net && Array.isArray(net.jacks)) ? net.jacks.length : 1;
          if (level === LZ && netSize <= 1) {
            push(LEVELS.INFO, 'OUTPUT_FLOATING', '输出端悬空',
              label + ' 的 ' + pinName + ' 引脚（' + pin + ' 脚，插孔 ' + jackText(jackId) +
                '）所在网电平为 Z，且该网上没有其它插孔',
              '这个输出没有任何外部连接，电平不会被观测到；请接上负载（指示灯 / 下一级输入），并先确认 VCC、GND 已接好',
              [jackId], info.socketId, pin);
          }
          continue;
        }

        // 输入侧
        if (level === LZ) {
          floatingPins += 1;
          if (isClockPinName(pinName) && isSequentialModel(info.model)) {
            push(LEVELS.WARN, 'CLOCK_FLOATING', '时钟端悬空',
              label + ' 的 ' + pinName + ' 引脚（' + pin + ' 脚，插孔 ' + jackText(jackId) +
                '）所在网电平为 Z（悬空）',
              '时钟端必须接时钟输出（如 clock:1HZ）或单脉冲输出，否则触发器永远不动作',
              [jackId], info.socketId, pin);
          } else if (isEnablePinName(pinName)) {
            push(LEVELS.WARN, 'ENABLE_FLOATING', '使能端悬空',
              label + ' 的 ' + pinName + ' 引脚（' + pin + ' 脚，插孔 ' + jackText(jackId) +
                '）所在网电平为 Z（悬空）',
              '低有效使能端悬空时芯片行为不确定，请把它接到确定的电平（多数情况下接 VCC 或 GND）',
              [jackId], info.socketId, pin);
          } else {
            push(LEVELS.WARN, 'INPUT_FLOATING', '输入端悬空',
              label + ' 的 ' + pinName + ' 引脚（' + pin + ' 脚，插孔 ' + jackText(jackId) +
                '）所在网电平为 Z（悬空）',
              '请把该输入端接到开关、时钟或另一个输出；TTL 芯片悬空会被当成高电平，容易出现「接了却没反应」',
              [jackId], info.socketId, pin);
          }
          continue;
        }

        // 异步清零 / 置位端被钳在低电平
        if (isResetPinName(pinName) && level === L0) {
          push(LEVELS.WARN, 'RESET_HELD', '复位端被持续钳位',
            label + ' 的 ' + pinName + ' 引脚（' + pin + ' 脚，插孔 ' + jackText(jackId) +
              '）所在网恒为 0，触发器一直被钳在复位态',
            '低有效复位端接地会让触发器永远保持复位，请改接到 VCC（或经开关控制）',
            [jackId], info.socketId, pin);
        }
      }
    }

    // ---- 2) 短路 / 冲突 ----
    for (var k = 0; k < shorts.length; k++) {
      var sh = shorts[k];
      var shJacks = (sh && Array.isArray(sh.jacks)) ? sh.jacks : [];
      var hasVcc = false;
      var hasGnd = false;
      for (var q = 0; q < shJacks.length; q++) {
        var jid = shJacks[q];
        if (jid === 'pwr:5V1' || jid === 'pwr:5V2' || jid === 'devA:VCC' || jid === 'devB:VCC') hasVcc = true;
        if (jid === 'gnd:GND1' || jid === 'gnd:GND2' || jid === 'devA:GND' || jid === 'devB:GND') hasGnd = true;
      }
      var isPowerShort = hasVcc && hasGnd;
      push(LEVELS.ERROR, 'SHORT_CIRCUIT',
        isPowerShort ? '电源与地短路' : '同网驱动冲突',
        '网 ' + (sh && sh.netId ? sh.netId : '?') + ' 电平为 ' + (sh && sh.level ? sh.level : LX) +
          '，涉及插孔：' + (shJacks.length ? shJacks.join('、') : '（未知）'),
        isPowerShort
          ? '电源与地被直接连通，请立刻断开这根导线，否则整板都会变成未知电平'
          : '同一个网里同时出现了强 1 与强 0 的驱动，请检查是不是把两个输出接到了一起',
        shJacks, null, null);
    }

    // ---- 2.5) 板载仪器（信号源幅度 / 电位器供电）----
    //   只依据 state（jacks / nets / dds / power），维持本模块只读铁律。
    var ddsState = (state && state.dds) ? state.dds : null;
    if (ddsState && ddsState.active === false && state.power !== false) {
      var ddsNet = netByJack['mid:DDS'];
      if (ddsNet && Array.isArray(ddsNet.jacks) && ddsNet.jacks.length > 1) {
        var ampText = (typeof ddsState.amplitudeV === 'number') ? ddsState.amplitudeV.toFixed(1) + 'V' : '过低';
        push(LEVELS.WARN, 'DDS_AMPLITUDE_LOW', '信号源幅度低于 TTL 阈值',
          '信号源输出孔 mid:DDS 已接线，但幅度 ' + ampText + ' 低于 TTL 阈值 2.5V，输出恒为低电平',
          '点击信号源编码器 2SS1 把调节参数切到「幅度」，再滚轮调高到 2.5V 以上',
          ['mid:DDS'], null, null);
      }
    }

    var potSliderNet = netByJack['rc:2'];
    if (potSliderNet && Array.isArray(potSliderNet.jacks) && potSliderNet.jacks.length > 1) {
      // 滑动端已接负载：再看两端有没有供电（任一端被驱动即可产生分压 / 跟随输出）
      var rc1Level = levelOf(state, 'rc:1');
      var rc3Level = levelOf(state, 'rc:3');
      if (rc1Level === LZ && rc3Level === LZ) {
        push(LEVELS.INFO, 'POT_NO_SUPPLY', '电位器两端未接电源',
          '电位器滑动端 rc:2 已接线，但 1 脚（rc:1）与 3 脚（rc:3）都悬空，滑动端没有输出',
          '把 rc:1 接 VCC、rc:3 接 GND（或其中一端接开关 / 芯片输出），旋钮才有分压输出',
          ['rc:1', 'rc:3'], null, null);
      }
    }

    // ---- 3) 输出冲突：同一网里两个及以上芯片输出脚驱动相反 ----
    //   判据（契约 §5.1）：同一网内两个输出脚驱动相反。
    //   引擎把「强 1 与强 0 同时存在」记为 'X' 并写进 state.shorts，
    //   所以这里取「网上有 >= 2 个芯片输出脚」且「该网电平为 X」为冲突，
    //   正好对应「驱动相反」，也与 shorts 交叉核对。
    for (var n2 = 0; n2 < nets.length; n2++) {
      var net2 = nets[n2];
      if (!net2 || !Array.isArray(net2.drivers)) continue;
      var outs = [];
      for (var d = 0; d < net2.drivers.length; d++) {
        var did = net2.drivers[d];
        if (has(outputJacks, did)) outs.push(did);
      }
      if (outs.length < 2) continue;
      if (net2.level !== LX) continue;   // 同值驱动不算冲突
      push(LEVELS.ERROR, 'OUTPUT_CONFLICT', '输出冲突',
        '网 ' + net2.id + ' 上有 ' + outs.length + ' 个芯片输出脚同时驱动（' + outs.join('、') +
          '），它们驱动相反，该网电平为 ' + net2.level,
        '两个输出脚不能直接相连；请断开其中一根，或改用带使能端（高阻输出）的器件',
        outs, null, null);
    }

    // ---- 4) 完全没有导线 ----
    if (wires.length === 0) {
      push(LEVELS.INFO, 'NO_WIRES', '还没有接线',
        '当前工程里没有任何导线',
        '先给芯片接上 VCC / GND，再从板载开关或时钟引出信号',
        [], null, null);
    }

    // ---- 汇总 ----
    var summary = { error: 0, warn: 0, info: 0 };
    for (var i2 = 0; i2 < issues.length; i2++) {
      var lv = issues[i2].level;
      if (lv === LEVELS.ERROR) summary.error += 1;
      else if (lv === LEVELS.WARN) summary.warn += 1;
      else summary.info += 1;
    }

    return {
      ok: summary.error === 0,
      generatedAt: (typeof options.now === 'number' && isFinite(options.now)) ? options.now : Date.now(),
      summary: summary,
      issues: issues,
      stats: {
        wires: wires.length,
        chips: socketIds.length,
        poweredChips: poweredChips,
        floatingPins: floatingPins,
        shorts: shorts.length
      }
    };
  }

  /** 插孔文本（缺失时给出占位） */
  function jackText(jackId) {
    return jackId ? jackId : '（未知插孔）';
  }

  /** 取引脚对应的插孔（引擎 API，读不到就返回 null） */
  function socketJackOf(engine, socketId, pin) {
    if (!engine || typeof engine.socketJack !== 'function') return null;
    try {
      return engine.socketJack(socketId, pin) || null;
    } catch (err) {
      return null;
    }
  }

  /* ============================================================
   * 5. 导出
   * ============================================================ */

  DLab.Advisor = {
    LEVELS: LEVELS,
    review: review,
    // 额外暴露，便于自测与 UI 复用
    SEQUENTIAL_MODELS: SEQUENTIAL_MODELS,
    ENABLE_TOKENS: ENABLE_TOKENS,
    EXTRA_ENABLE_NAMES: EXTRA_ENABLE_NAMES,
    RESET_TOKENS: RESET_TOKENS,
    SOCKET_IDS: SOCKET_IDS,
    detectOutputPins: detectOutputPins
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);

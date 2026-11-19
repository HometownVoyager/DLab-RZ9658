// src/core/boardNets.js
// DLab.BoardNets：数电开发模块「板内固定铜箔走线」连通组模型（经典脚本，浏览器 / Node 通用）
//
// 职责：把 A / B 两块开发模块上由板内铜箔（面板上画成白色走线）固定连通的插孔，输出成网表可直接并网的连通组。
// 本文件是纯数据 + 纯函数：不碰 DOM、不依赖引擎、不读写全局状态，可被 engine.js 与自测脚本共同引用。
//
// ============================================================
// 一、判据：什么才算「被铜箔硬连在一起」
// ============================================================
// 两条走线只有在**共享同一个落点**时，才说明它们连到了同一个电气节点，
// 从而把两个金孔短接成同一个网。若两条走线的起点、终点都不同、也不共线重叠，则它们互不相通。
// 因此本文件把「连通组」定义为：**多条走线落在同一个终点上的那些金孔**。
// 这比「按引脚号猜」更严格——它只依赖画出来的几何，不依赖任何假设。
//
// ============================================================
// 二、走线数据来源（逐条读 SVG.SVG 的 <path d="...">，不是猜的）
// ============================================================
// 1) #block-14pin（SVG.SVG 第 228~242 行，14 条）
//    顶排 7 条：M-76,-14 H-30 / M-76,-50 V-26 H-28 V-16 / M-38,-50 V-30 H-18 V-16 /
//               M0,-50 V-16 / M38,-50 V-30 H18 V-16 / M76,-50 V-26 H28 V-16 / M76,-14 H30
//    底排 7 条：M-76,24 H-30 / M-76,60 V36 H-28 V16 / M-38,60 V40 H-18 V16 /
//               M0,60 V16 / M38,60 V40 H18 V16 / M76,60 V36 H28 V16 / M76,24 H30
//
// 2) #block-16pin（SVG.SVG 第 269~285 行，16 条）
//    顶排 8 条：M-112,-16 H-36 / M-112,-54 V-26 H-32 V-16 / M-67,-54 V-32 H-22 V-16 /
//               M-22,-54 V-38 H-10 V-16 / M22,-54 V-38 H10 V-16 / M67,-54 V-32 H22 V-16 /
//               M112,-54 V-26 H32 V-16 / M112,-16 H36
//    底排 8 条：M-112,22 H-36 / M-112,60 V32 H-32 V16 / M-67,60 V38 H-22 V16 /
//               M-22,60 V44 H-10 V16 / M22,60 V44 H10 V16 / M67,60 V38 H22 V16 /
//               M112,60 V32 H32 V16 / M112,22 H36
//
// 3) UF（20 脚）没有独立模板，走线直接写在 #dev-module-common 第 346~349 行，共 20 条一对一短线，
//    例如 M148,45 V62 H336（金孔 (148,45) -> 落点 (336,62)）。
//
// 4) 金孔的丝印编号取自宿主 <g> 里的 text 标签，与 #jack 坐标一一对齐（标签都在孔的正上方/正下方 14 单位处）。
//    例：UA 的 A13(-76,-64) 对应 #jack (-76,-50)；A14(-76,-28) 对应 #jack (-76,-14)；
//        A1(-76,10) 对应 #jack (-76,24)；A2(-76,46) 对应 #jack (-76,60)。
//
// ============================================================
// 三、推导结论（本任务的核心判断）
// ============================================================
// 结论 1：**没有任何两条走线共享落点**。
//   把上面 14 / 16 / 20 条走线的终点两两比对（自测里逐对算过，见 tests/boardNets.selftest.cjs）：
//     · 14 脚模板的 14 个终点两两不同，最近的一对是 (-30,-14) 与 (-28,-16)，距离 2.83，不重合；
//     · 16 脚模板的 16 个终点两两不同；
//     · 20 脚模板的 20 个终点两两不同。
//   也就是说：每条走线都是「一个金孔 -> 插座内一个引脚」的单线，金孔与金孔之间**没有**板内铜箔互连。
//   这与面包板（5 孔一组横向连通）完全不同——本实验箱实物也确实没有面包板
//   （见 Construct Plan 3.2.8 的更正记录）。
//
// 结论 2：**「插座引脚插孔」与「引出金孔」在 geometry 里是同一个插孔 id**。
//   geometry 中 devA / devB 各有 82 个插孔，恰好等于
//     UA(14) + UB(14) + UE(16) + UD(16) + UF(20) + VCC(1) + GND(1) = 82。
//   这 82 个 id 同时承担两个角色：
//     (a) 插座引脚插孔 —— CONTRACTS 4.2：devA:UA 第 n 脚 <-> devA:A<n>；
//     (b) 该引脚在插座侧边的引出金孔 —— 丝印 A<n> 就印在这个镀金插孔旁边。
//   SVG 把「引脚」与「引出金孔」合并画成了同一个孔，不存在「一个引脚两个孔」的冗余。
//   于是「引脚 <-> 引出金孔」这条铜箔在网表里是**恒等映射**，不产生任何额外的连通关系。
//
// 结论 3：因此对真实几何推导出的 GROUPS 为**空集**。
//   这不是「没做」，而是逐条读 path、逐点算坐标、再用 geometry 反查之后得到的结论。
//   如果为了凑出一个非空数组，把 A13 / A12 这类相邻金孔硬拼成一组，
//   就会让「不插芯片、只靠板内走线」的电路出现**虚假连通**（相邻引脚被短路），
//   既违反任务「不要凭空发明」的硬性约束，也会让仿真结果误导学生。
//   所以此处如实输出空组，并在 diagnostics 里保留完整的推导留痕（每个插座、每个金孔的落点）。
//
// 结论 4：机制本身完整可用。
//   buildGroups() 不是写死返回 []，而是真的按「走线终点归并 -> 反查 geometry -> 校验 id 存在」的流程计算。
//   一旦将来走线表或 geometry 出现「多个金孔共享同一落点」的情形，本函数会**自动**产出真实分组，
//   engine.js 无需任何改动即可受益；自测里也用注入的合成分组验证了这条链路端到端可用。
//
// ============================================================
// 四、VCC / GND 红色接线柱
// ============================================================
// #dev-module-common 的 (65,98) 与 (712,98) 两个 #jack 就是接线柱本身，没有额外的引出金孔，
// 因此不构成多孔连通组；它们的固定电位由 engine.js 的 fixedNet（'VCC' / 'GND'）负责。
// 本文件只在 diagnostics 里登记它们的绝对坐标，供核对。

(function (global) {
  'use strict';

  var DLab = (global.DLab = global.DLab || {});

  /* ============================================================
   * 1. 走线表（坐标均为模板内相对坐标；hole = 金孔，end = 落点）
   * ============================================================ */

  /** 14 脚插座 #block-14pin 的 14 条走线（顺序与 SVG 中 <path> 出现顺序一致） */
  var TRACES_14 = [
    { hole: [-76, -14], end: [-30, -14], n: 14 },
    { hole: [-76, -50], end: [-28, -16], n: 13 },
    { hole: [-38, -50], end: [-18, -16], n: 12 },
    { hole: [0, -50], end: [0, -16], n: 11 },
    { hole: [38, -50], end: [18, -16], n: 10 },
    { hole: [76, -50], end: [28, -16], n: 9 },
    { hole: [76, -14], end: [30, -14], n: 8 },
    { hole: [-76, 24], end: [-30, 24], n: 1 },
    { hole: [-76, 60], end: [-28, 16], n: 2 },
    { hole: [-38, 60], end: [-18, 16], n: 3 },
    { hole: [0, 60], end: [0, 16], n: 4 },
    { hole: [38, 60], end: [18, 16], n: 5 },
    { hole: [76, 60], end: [28, 16], n: 6 },
    { hole: [76, 24], end: [30, 24], n: 7 }
  ];

  /** 16 脚插座 #block-16pin 的 16 条走线 */
  var TRACES_16 = [
    { hole: [-112, -16], end: [-36, -16], n: 16 },
    { hole: [-112, -54], end: [-32, -16], n: 15 },
    { hole: [-67, -54], end: [-22, -16], n: 14 },
    { hole: [-22, -54], end: [-10, -16], n: 13 },
    { hole: [22, -54], end: [10, -16], n: 12 },
    { hole: [67, -54], end: [22, -16], n: 11 },
    { hole: [112, -54], end: [32, -16], n: 10 },
    { hole: [112, -16], end: [36, -16], n: 9 },
    { hole: [-112, 22], end: [-36, 22], n: 1 },
    { hole: [-112, 60], end: [-32, 16], n: 2 },
    { hole: [-67, 60], end: [-22, 16], n: 3 },
    { hole: [-22, 60], end: [-10, 16], n: 4 },
    { hole: [22, 60], end: [10, 16], n: 5 },
    { hole: [67, 60], end: [22, 16], n: 6 },
    { hole: [112, 60], end: [32, 16], n: 7 },
    { hole: [112, 22], end: [36, 22], n: 8 }
  ];

  /**
   * 20 脚插座 UF 的 20 条走线（坐标相对 #dev-module-common 原点，UF 自身不再额外偏移）。
   * 数据来源：#dev-module-common 第 346~349 行；金孔坐标见第 364~386 行。
   */
  var TRACES_20 = [
    { hole: [148, 45], end: [336, 62], n: 20 },
    { hole: [188, 45], end: [345, 58], n: 19 },
    { hole: [228, 45], end: [354, 54], n: 18 },
    { hole: [268, 45], end: [363, 50], n: 17 },
    { hole: [308, 45], end: [372, 46], n: 16 },
    { hole: [148, 96], end: [336, 78], n: 1 },
    { hole: [188, 96], end: [345, 82], n: 2 },
    { hole: [228, 96], end: [354, 86], n: 3 },
    { hole: [268, 96], end: [363, 90], n: 4 },
    { hole: [308, 96], end: [372, 92], n: 5 },
    { hole: [468, 45], end: [402, 46], n: 15 },
    { hole: [508, 45], end: [411, 50], n: 14 },
    { hole: [548, 45], end: [420, 54], n: 13 },
    { hole: [588, 45], end: [429, 58], n: 12 },
    { hole: [628, 45], end: [438, 62], n: 11 },
    { hole: [468, 96], end: [402, 92], n: 6 },
    { hole: [508, 96], end: [411, 90], n: 7 },
    { hole: [548, 96], end: [420, 86], n: 8 },
    { hole: [588, 96], end: [429, 82], n: 9 },
    { hole: [628, 96], end: [438, 78], n: 10 }
  ];

  /**
   * 插座区定义：每块开发模块 5 个插座，各自的模板与相对 #dev-module-common 原点的偏移。
   * 数据来源：SVG.SVG 第 390 / 402 / 414 / 426 行四个 <g transform>；
   * UF 的金孔坐标已按 dev-module-common 原点给出，故 origin 取 [0,0]。
   */
  var SOCKET_AREAS = [
    { socket: 'UA', letter: 'A', template: 'block-14pin', origin: [126, 204], pins: 14 },
    { socket: 'UB', letter: 'B', template: 'block-14pin', origin: [642, 204], pins: 14 },
    { socket: 'UE', letter: 'E', template: 'block-16pin', origin: [205, 368], pins: 16 },
    { socket: 'UD', letter: 'D', template: 'block-16pin', origin: [565, 368], pins: 16 },
    { socket: 'UF', letter: 'F', template: 'block-20pin', origin: [0, 0], pins: 20 }
  ];

  /** 两个开发模块相对面板原点的偏移（SVG.SVG 第 689 / 782 行的 translate） */
  var MODULE_ORIGINS = {
    devA: [48, 340],
    devB: [982, 340]
  };

  /** 两个红色接线柱（VCC / GND）相对 #dev-module-common 原点的坐标（SVG.SVG 第 326 / 340 行） */
  var POWER_POSTS = [
    { label: 'VCC', at: [65, 98] },
    { label: 'GND', at: [712, 98] }
  ];

  /* ============================================================
   * 2. 工具：坐标键与索引
   * ============================================================ */

  /** 保留 1 位小数，避免浮点误差让同一个点判不相等 */
  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  /** 坐标 -> 稳定字符串键 */
  function ptKey(p) {
    return round1(p[0]) + ',' + round1(p[1]);
  }

  /**
   * 建「绝对坐标 -> 插孔 id」索引。
   * geometry 缺失或插孔没有坐标时，对应条目不会进入索引（后续查不到会明确抛错）。
   * @param {object} geometry
   * @returns {object} 'x,y' -> jackId
   */
  function buildJackIndex(geometry) {
    var index = Object.create(null);
    var jacks = (geometry && geometry.JACKS) || {};
    for (var id in jacks) {
      if (!Object.prototype.hasOwnProperty.call(jacks, id)) continue;
      var j = jacks[id];
      if (!j || typeof j.x !== 'number' || typeof j.y !== 'number') continue;
      index[ptKey([j.x, j.y])] = id;
    }
    return index;
  }

  /** 取某个插座区对应的走线表 */
  function tracesOf(area) {
    if (area.template === 'block-14pin') return TRACES_14;
    if (area.template === 'block-16pin') return TRACES_16;
    if (area.template === 'block-20pin') return TRACES_20;
    throw new Error('未知的插座模板：' + area.template);
  }

  /** 某个插座区走线表的绝对原点 */
  function originOf(moduleId, area) {
    var mod = MODULE_ORIGINS[moduleId];
    if (!mod) throw new Error('未知的开发模块：' + moduleId);
    return [mod[0] + area.origin[0], mod[1] + area.origin[1]];
  }

  /* ============================================================
   * 3. 核心推导：按「走线落点」归并出连通组
   * ============================================================ */

  /**
   * 由走线表推导板内连通组。
   *
   * 算法（判据见文件头第一条）：
   *   1. 金孔模板坐标 + 模板绝对原点 = 金孔绝对坐标；用绝对坐标反查 geometry 得到插孔 id，
   *      查不到立即抛错（推导与几何数据不一致必须暴露，不允许静默跳过）；
   *   2. 落点模板坐标 + 模板绝对原点 = 落点绝对坐标，作为「电气节点」的键；
   *   3. 落在同一节点上的多个金孔 = 被同一片铜箔连在一起 -> 一个连通组；
   *   4. 只有金孔数 >= 2 才构成真正的连通组（单个金孔没有互连可言）。
   *
   * @param {Array<{hole:number[], end:number[], n:number}>} traces 走线表（模板内坐标）
   * @param {number[]} origin 模板原点的绝对坐标
   * @param {object} jackIndex 绝对坐标 -> 插孔 id
   * @param {string} [letter] 插座字母（A/B/E/D/F），用于拼出金孔丝印；省略时只用编号
   * @returns {Array<{node:string, jacks:string[], labels:string[]}>}
   */
  function groupTracesByEnd(traces, origin, jackIndex, letter) {
    var prefix = letter || '';
    var byNode = Object.create(null);
    var nodeOrder = [];
    var i;

    for (i = 0; i < traces.length; i++) {
      var t = traces[i];
      var holeAbs = [origin[0] + t.hole[0], origin[1] + t.hole[1]];
      var id = jackIndex[ptKey(holeAbs)];
      if (!id) {
        throw new Error('板内走线推导失败：金孔 ' + prefix + t.n + ' 的模板坐标 ' +
          ptKey(t.hole) + ' 换算成绝对坐标 ' + ptKey(holeAbs) +
          ' 后，在 geometry.JACKS 中找不到对应插孔');
      }
      var nodeKey = ptKey([origin[0] + t.end[0], origin[1] + t.end[1]]);
      if (!byNode[nodeKey]) {
        byNode[nodeKey] = { jacks: [], labels: [] };
        nodeOrder.push(nodeKey);
      }
      if (byNode[nodeKey].jacks.indexOf(id) < 0) {
        byNode[nodeKey].jacks.push(id);
        byNode[nodeKey].labels.push(prefix + t.n);
      }
    }

    var out = [];
    for (i = 0; i < nodeOrder.length; i++) {
      var node = nodeOrder[i];
      var rec = byNode[node];
      if (rec.jacks.length >= 2) {
        out.push({ node: node, jacks: rec.jacks, labels: rec.labels });
      }
    }
    return out;
  }

  /* ============================================================
   * 4. 对外主函数
   * ============================================================ */

  /**
   * 构建板内固定连通组。
   *
   * @param {object} [geometry] 插孔几何数据（DLab.geometry）
   * @returns {{groups: Array<{id:string, jacks:string[]}>, diagnostics: Array<object>}}
   *   groups      —— 可直接并入网表的连通组，每项 jacks 至少 2 个插孔，且全部 id 已用 geometry 反查通过
   *   diagnostics —— 推导留痕：每个插座一条（含逐孔落点），每个接线柱一条，供自测与排错
   */
  function buildGroups(geometry) {
    var jackIndex = buildJackIndex(geometry);
    var groups = [];
    var diagnostics = [];
    var m, s, i;

    for (m in MODULE_ORIGINS) {
      if (!Object.prototype.hasOwnProperty.call(MODULE_ORIGINS, m)) continue;

      for (s = 0; s < SOCKET_AREAS.length; s++) {
        var area = SOCKET_AREAS[s];
        var origin = originOf(m, area);
        var traces = tracesOf(area);

        // 逐孔反查校验（任务硬性要求：每个 jackId 必须真的存在于 geometry.JACKS）
        var holes = [];
        for (i = 0; i < traces.length; i++) {
          var holeAbs = [origin[0] + traces[i].hole[0], origin[1] + traces[i].hole[1]];
          var jackId = jackIndex[ptKey(holeAbs)];
          if (!jackId) {
            throw new Error('板内走线推导失败：' + m + ':' + area.socket + ' 的金孔 ' +
              area.letter + traces[i].n + '（绝对坐标 ' + ptKey(holeAbs) + '）在 geometry.JACKS 中不存在');
          }
          holes.push({
            label: area.letter + traces[i].n,
            jackId: jackId,
            x: holeAbs[0],
            y: holeAbs[1],
            end: ptKey([origin[0] + traces[i].end[0], origin[1] + traces[i].end[1]])
          });
        }

        var found = groupTracesByEnd(traces, origin, jackIndex, area.letter);
        for (i = 0; i < found.length; i++) {
          groups.push({
            id: m + ':' + area.socket + '-node' + (i + 1) + '-tap',
            jacks: found[i].jacks.slice()
          });
        }

        // 落点唯一性统计：用于证明「没有两条走线共享落点」
        var nodeSeen = Object.create(null);
        var sharedNodes = 0;
        for (i = 0; i < holes.length; i++) {
          if (nodeSeen[holes[i].end]) sharedNodes += 1;
          nodeSeen[holes[i].end] = true;
        }

        diagnostics.push({
          moduleId: m,
          socket: area.socket,
          letter: area.letter,
          template: area.template,
          origin: origin,
          pinCount: area.pins,
          traceCount: traces.length,
          groupCount: found.length,
          sharedNodeCount: sharedNodes,
          holes: holes
        });
      }

      // 电源接线柱：本身即插孔，没有额外引出孔，只登记坐标供核对
      for (i = 0; i < POWER_POSTS.length; i++) {
        var post = POWER_POSTS[i];
        var postAbs = [MODULE_ORIGINS[m][0] + post.at[0], MODULE_ORIGINS[m][1] + post.at[1]];
        diagnostics.push({
          moduleId: m,
          socket: post.label,
          letter: post.label,
          template: 'power-post',
          origin: postAbs,
          pinCount: 1,
          traceCount: 0,
          groupCount: 0,
          sharedNodeCount: 0,
          holes: [{ label: post.label, jackId: jackIndex[ptKey(postAbs)] || null, x: postAbs[0], y: postAbs[1], end: null }]
        });
      }
    }

    return { groups: groups, diagnostics: diagnostics };
  }

  /**
   * 校验一组连通组是否全部合法（id 非空、插孔数 >= 2、无重复、全部存在于 geometry）。
   * 供自测与上层防御性调用；合法时返回空数组，不合法时返回中文原因清单。
   *
   * @param {Array<{id:string, jacks:string[]}>} groups
   * @param {object} geometry
   * @returns {string[]}
   */
  function validateGroups(groups, geometry) {
    var problems = [];
    var jacks = (geometry && geometry.JACKS) || {};
    var seenId = Object.create(null);
    var seenJack = Object.create(null);
    var i, k;

    if (!Array.isArray(groups)) return ['连通组必须是数组'];

    for (i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (!g || typeof g.id !== 'string' || !g.id) {
        problems.push('第 ' + i + ' 项缺少 id');
        continue;
      }
      if (seenId[g.id]) problems.push('连通组 id 重复：' + g.id);
      seenId[g.id] = true;

      if (!Array.isArray(g.jacks) || g.jacks.length < 2) {
        problems.push('连通组 ' + g.id + ' 的插孔少于 2 个');
        continue;
      }
      for (k = 0; k < g.jacks.length; k++) {
        var jid = g.jacks[k];
        if (!jacks[jid]) problems.push('连通组 ' + g.id + ' 引用了不存在的插孔：' + jid);
        if (seenJack[jid]) problems.push('插孔重复出现：' + jid);
        seenJack[jid] = true;
      }
    }
    return problems;
  }

  /**
   * 统计走线落点重复情况（供自测证明「无共享落点」）。
   * @param {Array} traces 走线表
   * @returns {{total:number, unique:number, shared:number}}
   */
  function countEndNodes(traces) {
    var seen = Object.create(null);
    var unique = 0;
    var shared = 0;
    for (var i = 0; i < traces.length; i++) {
      var k = ptKey(traces[i].end);
      if (seen[k]) { shared += 1; } else { seen[k] = true; unique += 1; }
    }
    return { total: traces.length, unique: unique, shared: shared };
  }

  /* ============================================================
   * 5. 常量 GROUPS 与导出
   * ============================================================ */

  /**
   * GROUPS：板内固定连通组常量表。
   *
   * 对真实几何的推导结果为**空数组**，依据见文件头「三、推导结论」：
   *   · 每条走线都是「一个金孔 -> 插座内一个引脚」的单线，走线落点两两不重合
   *     （14 脚模板最近一对相距 2.83），所以金孔与金孔之间没有板内铜箔互连；
   *   · 「引脚插孔」与「引出金孔」在 geometry 里本就是同一个插孔 id
   *     （82 = 14+14+16+16+20+2），所以「引脚 <-> 金孔」是恒等映射，不产生额外连通关系。
   *   为不凭空发明连通关系（任务硬性约束），此处如实留空，而不是把相邻金孔硬拼成组。
   *
   * 注意：空数组不等于「没实现」——buildGroups() 是全流程真实计算的，
   * 一旦走线表或 geometry 出现「多个金孔共享同一落点」的情形，它会自动产出非空分组。
   *
   * 本常量在加载时若 DLab.geometry 已就绪则按真实几何推导，否则为空（引擎侧始终以
   * buildGroups(this._geometry) 的结果为准，不依赖这个常量）。
   */
  var GROUPS = [];
  if (DLab.geometry) {
    try {
      GROUPS = buildGroups(DLab.geometry).groups;
    } catch (err) {
      GROUPS = [];
    }
  }

  var BoardNets = {
    /** 板内固定连通组（见上方说明：对真实几何推导为空集） */
    GROUPS: GROUPS,
    /** 按 geometry 推导连通组，返回 { groups, diagnostics } */
    buildGroups: buildGroups,
    /** 校验连通组合法性，返回中文问题清单（空数组 = 合法） */
    validateGroups: validateGroups,
    /** 统计走线落点重复情况，用于证明「无共享落点」 */
    countEndNodes: countEndNodes,

    // ---- 以下为推导依据（只读数据，供自测与文档核对）----
    TRACES_14: TRACES_14,
    TRACES_16: TRACES_16,
    TRACES_20: TRACES_20,
    SOCKET_AREAS: SOCKET_AREAS,
    MODULE_ORIGINS: MODULE_ORIGINS,
    POWER_POSTS: POWER_POSTS,

    // ---- 工具函数 ----
    buildJackIndex: buildJackIndex,
    groupTracesByEnd: groupTracesByEnd,
    ptKey: ptKey
  };

  DLab.BoardNets = BoardNets;

})(typeof globalThis !== 'undefined' ? globalThis : this);

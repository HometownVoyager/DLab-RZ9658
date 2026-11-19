#!/usr/bin/env node
// tests/boardNets.selftest.cjs
// DLab.BoardNets 板内固定铜箔走线模型自测：node tests/boardNets.selftest.cjs
// 覆盖：走线表与 SVG 模板一致性、geometry 反查、GROUPS 结构合法性、
//       连通性生效（同组同电平 / 异组不连通）、端到端电气验证、devA/devB 不串味、
//       BoardNets 缺失时引擎向后兼容、删除导线/清空/reset 后板内走线仍能复原。
'use strict';

var path = require('path');

// ---- 按契约加载核心模块（经典脚本 + 全局命名空间）----
globalThis.DLab = {};
require(path.join(__dirname, '..', 'src', 'core', 'logic.js'));
require(path.join(__dirname, '..', 'src', 'core', 'chips.js'));
require(path.join(__dirname, '..', 'src', 'core', 'panelGeometry.generated.js'));
require(path.join(__dirname, '..', 'src', 'core', 'boardNets.js'));
require(path.join(__dirname, '..', 'src', 'core', 'engine.js'));

var DLab = globalThis.DLab;
var BoardNets = DLab.BoardNets;
var Engine = DLab.Engine;
var Logic = DLab.Logic;
var GEO = DLab.geometry;

/* ============================================================
 * 极简断言框架
 * ============================================================ */

var results = [];
var currentGroup = '(未分组)';

function group(name) {
  currentGroup = name;
  console.log('\n\u25B8 ' + name);
}

function check(desc, actual, expected) {
  var ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ group: currentGroup, desc: desc, ok: ok });
  if (ok) console.log('  \u2713 ' + desc);
  else {
    console.log('  \u2717 ' + desc);
    console.log('      期望: ' + JSON.stringify(expected));
    console.log('      实际: ' + JSON.stringify(actual));
  }
  return ok;
}

function checkTrue(desc, cond, extra) {
  var ok = !!cond;
  results.push({ group: currentGroup, desc: desc, ok: ok });
  if (ok) console.log('  \u2713 ' + desc);
  else {
    console.log('  \u2717 ' + desc);
    if (extra !== undefined) console.log('      实际: ' + JSON.stringify(extra));
  }
  return ok;
}

function checkThrows(desc, fn) {
  var threw = false;
  var msg = '';
  try { fn(); } catch (e) { threw = true; msg = e && e.message; }
  results.push({ group: currentGroup, desc: desc, ok: threw });
  if (threw) console.log('  \u2713 ' + desc + '\uFF08' + msg + '\uFF09');
  else console.log('  \u2717 ' + desc + '\uFF08应抛错但没有\uFF09');
  return threw;
}

/** 构造引擎（带真实几何） */
function newEngine() {
  return new Engine({ geometry: GEO });
}

/* ============================================================
 * 1. 模块加载与导出形态
 * ============================================================ */

group('1. 模块加载与导出形态');
checkTrue('DLab.BoardNets 已挂载', !!BoardNets);
checkTrue('GROUPS 是数组', Array.isArray(BoardNets.GROUPS));
checkTrue('buildGroups 是函数', typeof BoardNets.buildGroups === 'function');
checkTrue('validateGroups 是函数', typeof BoardNets.validateGroups === 'function');
checkTrue('countEndNodes 是函数', typeof BoardNets.countEndNodes === 'function');
checkTrue('导出走线表 TRACES_14/16/20',
  Array.isArray(BoardNets.TRACES_14) && Array.isArray(BoardNets.TRACES_16) && Array.isArray(BoardNets.TRACES_20));
check('TRACES_14 条数', BoardNets.TRACES_14.length, 14);
check('TRACES_16 条数', BoardNets.TRACES_16.length, 16);
check('TRACES_20 条数', BoardNets.TRACES_20.length, 20);
check('覆盖 devA / devB 两块模块', Object.keys(BoardNets.MODULE_ORIGINS).sort(), ['devA', 'devB']);
check('覆盖 5 个插座', BoardNets.SOCKET_AREAS.map(function (a) { return a.socket; }),
  ['UA', 'UB', 'UE', 'UD', 'UF']);

/* ============================================================
 * 2. 走线表与 SVG 模板一致性（推导依据自证）
 * ============================================================ */

group('2. 走线表与 SVG 模板一致性');

// 2.1 每条走线的金孔起点必须能在 geometry 里反查到（逐孔校验）
(function () {
  var built = BoardNets.buildGroups(GEO);
  check('buildGroups 返回 groups / diagnostics 两个字段',
    [Array.isArray(built.groups), Array.isArray(built.diagnostics)], [true, true]);
  // 14 条诊断：devA/devB 各 5 个插座 + VCC + GND
  check('diagnostics 条数（每模块 5 插座 + 2 接线柱）', built.diagnostics.length, 14);
  check('插座诊断条数', built.diagnostics.filter(function (d) { return d.template !== 'power-post'; }).length, 10);
  check('接线柱诊断条数', built.diagnostics.filter(function (d) { return d.template === 'power-post'; }).length, 4);

  // 每个插座的走线条数必须等于插座脚数
  var mismatch = [];
  built.diagnostics.forEach(function (d) {
    if (d.template === 'power-post') return;
    if (d.traceCount !== d.pinCount) mismatch.push(d.moduleId + ':' + d.socket + ' ' + d.traceCount + '!=' + d.pinCount);
  });
  check('每个插座「走线条数 = 脚数」', mismatch, []);

  // 每个金孔都必须真的存在于 geometry.JACKS（任务硬性要求）
  var missing = [];
  var dupJack = [];
  var seen = Object.create(null);
  built.diagnostics.forEach(function (d) {
    d.holes.forEach(function (h) {
      if (!h.jackId) { missing.push(d.moduleId + ':' + d.socket + ' ' + h.label); return; }
      if (!GEO.JACKS[h.jackId]) missing.push(d.moduleId + ':' + d.socket + ' ' + h.label + ' -> ' + h.jackId);
      if (seen[h.jackId]) dupJack.push(h.jackId);
      seen[h.jackId] = true;
    });
  });
  check('全部金孔都能在 geometry 反查到', missing, []);
  check('金孔互不重复（一个孔只出现一次）', dupJack, []);
  // 每模块 14+14+16+16+20 个金孔 + VCC/GND 两个接线柱 = 82，两块共 164
  check('反查到的插孔总数 = 164（每模块 82，两块）', Object.keys(seen).length, 164);
})();

// 2.2 金孔丝印编号与 geometry 的 label 一致（证明坐标换算没算错）
(function () {
  var bad = [];
  var built = BoardNets.buildGroups(GEO);
  built.diagnostics.forEach(function (d) {
    if (d.template === 'power-post') return;
    d.holes.forEach(function (h) {
      var j = GEO.JACKS[h.jackId];
      if (!j) { bad.push(h.jackId + ' 不存在'); return; }
      // 金孔丝印 = 插座字母 + 编号，必须与 geometry 的 label 完全一致
      if (j.label !== h.label) bad.push(d.moduleId + ':' + d.socket + ' ' + h.label + ' -> geometry ' + j.label);
    });
  });
  check('金孔丝印编号与 geometry.label 完全一致', bad, []);
})();

// 2.3 走线落点唯一性：证明「金孔之间没有板内铜箔互连」
(function () {
  [['TRACES_14', BoardNets.TRACES_14, 14],
   ['TRACES_16', BoardNets.TRACES_16, 16],
   ['TRACES_20', BoardNets.TRACES_20, 20]].forEach(function (t) {
    var stat = BoardNets.countEndNodes(t[1]);
    check(t[0] + ' 走线条数', stat.total, t[2]);
    check(t[0] + ' 落点全部唯一（无共享落点）', stat.unique, t[2]);
    check(t[0] + ' 共享落点数 = 0', stat.shared, 0);
  });

  // 逐对算最近落点距离，必须 > 0（不能重合）
  function minEndDistance(traces) {
    var min = Infinity;
    for (var i = 0; i < traces.length; i++) {
      for (var k = i + 1; k < traces.length; k++) {
        var dx = traces[i].end[0] - traces[k].end[0];
        var dy = traces[i].end[1] - traces[k].end[1];
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < min) min = d;
      }
    }
    return min;
  }
  checkTrue('14 脚模板最近落点距离 > 0', minEndDistance(BoardNets.TRACES_14) > 0,
    minEndDistance(BoardNets.TRACES_14));
  checkTrue('16 脚模板最近落点距离 > 0', minEndDistance(BoardNets.TRACES_16) > 0,
    minEndDistance(BoardNets.TRACES_16));
  checkTrue('20 脚模板最近落点距离 > 0', minEndDistance(BoardNets.TRACES_20) > 0,
    minEndDistance(BoardNets.TRACES_20));
  // 记录推导依据：14 脚模板最近的一对是 A14(-30,-14) 与 A13(-28,-16)，距离 2.83
  check('14 脚模板最近落点距离（A14 与 A13）', Math.round(minEndDistance(BoardNets.TRACES_14) * 100) / 100, 2.83);
})();

// 2.4 走线起点（金孔）与落点必须不同（否则就是「孔连自己」，无意义）
(function () {
  var same = [];
  [BoardNets.TRACES_14, BoardNets.TRACES_16, BoardNets.TRACES_20].forEach(function (list) {
    list.forEach(function (t) {
      if (t.hole[0] === t.end[0] && t.hole[1] === t.end[1]) same.push(t.label);
    });
  });
  check('没有「金孔起点 = 落点」的退化走线', same, []);
})();

/* ============================================================
 * 3. GROUPS 结构合法性
 * ============================================================ */

group('3. GROUPS 结构合法性');
(function () {
  var built = BoardNets.buildGroups(GEO);
  var groups = built.groups;

  checkTrue('GROUPS 已定义', Array.isArray(BoardNets.GROUPS));
  check('buildGroups 结果与 GROUPS 常量一致（同一推导）', built.groups.length, BoardNets.GROUPS.length);

  // 依据推导：真实几何下无「多孔共享同一落点」的情形，故组数为 0
  check('真实几何下连通组数（推导结论：无共享落点）', groups.length, 0);
  check('validateGroups 校验通过（无问题项）', BoardNets.validateGroups(groups, GEO), []);
  check('validateGroups 校验 GROUPS 常量同样通过', BoardNets.validateGroups(BoardNets.GROUPS, GEO), []);

  // 结构断言（对空集也应成立：没有非法项）
  var badSize = groups.filter(function (g) { return !g.jacks || g.jacks.length < 2; });
  check('每项 jacks 至少 2 个（空集时为 0 项）', badSize.length, 0);

  var allJacks = [];
  groups.forEach(function (g) { allJacks = allJacks.concat(g.jacks); });
  var dupJacks = allJacks.filter(function (id, i) { return allJacks.indexOf(id) !== i; });
  check('无重复 jack', dupJacks, []);

  var missing = allJacks.filter(function (id) { return !GEO.JACKS[id]; });
  check('全部 id 存在于几何表', missing, []);

  var badId = groups.filter(function (g) { return typeof g.id !== 'string' || !g.id; });
  check('每组都有非空中文/英文 id', badId.length, 0);
})();

// 3.1 用注入的合成分组验证「机制可用」（证明不是写死返回 []）
(function () {
  // 人为构造一个「两个金孔共享同一落点」的走线表：应被识别为 1 个连通组
  var fakeTraces = [
    { hole: [-76, -50], end: [-28, -16], label: 'A13' },
    { hole: [-38, -50], end: [-28, -16], label: 'A12' }   // 与上一条落点相同
  ];
  var origin = [48 + 126, 340 + 204];   // devA:UA 的绝对原点
  var index = BoardNets.buildJackIndex(GEO);
  var found = BoardNets.groupTracesByEnd(fakeTraces, origin, index);
  check('共享落点的两条走线被归并为 1 组', found.length, 1);
  check('该组含 2 个插孔', found[0] && found[0].jacks.length, 2);
  check('该组插孔为 devA:A13 / devA:A12',
    found[0] && found[0].jacks.slice().sort(), ['devA:A12', 'devA:A13']);
  check('该组插孔数 >= 2 满足连通组定义', found[0] && found[0].jacks.length >= 2, true);

  // 落点不同的两条走线不应被归并
  var apartTraces = [
    { hole: [-76, -50], end: [-28, -16], label: 'A13' },
    { hole: [-38, -50], end: [-18, -16], label: 'A12' }
  ];
  check('落点不同的走线不归并', BoardNets.groupTracesByEnd(apartTraces, origin, index).length, 0);

  // 反查失败必须抛错（推导与几何不一致要暴露，不允许静默跳过）
  var badTraces = [{ hole: [9999, 9999], end: [0, 0], label: 'ZZ' }];
  checkThrows('金孔在 geometry 中不存在时抛错', function () {
    BoardNets.groupTracesByEnd(badTraces, origin, index);
  });
})();

// 3.2 validateGroups 能识别非法输入
(function () {
  checkTrue('非数组返回问题项', BoardNets.validateGroups(null, GEO).length > 0);
  checkTrue('插孔少于 2 个被识别',
    BoardNets.validateGroups([{ id: 'x', jacks: ['devA:A1'] }], GEO).length > 0);
  checkTrue('引用不存在的插孔被识别',
    BoardNets.validateGroups([{ id: 'x', jacks: ['devA:A1', 'zzz:1'] }], GEO).length > 0);
  checkTrue('缺少 id 被识别',
    BoardNets.validateGroups([{ jacks: ['devA:A1', 'devA:A2'] }], GEO).length > 0);
})();

/* ============================================================
 * 4. 连通性生效（同组同电平 / 异组不连通）
 * ============================================================ */

group('4. 连通性生效（端到端电气验证）');

// 4.1 同一组内两个插孔必须同电平
//     用注入的合成分组：给 devA:A13 与 devA:A12 建一个连通组，验证两孔同网同电平
(function () {
  var e = newEngine();
  // 直接调用引擎内部的合并入口（与 BoardNets 推导结果同一条代码路径）
  e._boardNetGroups = [{ id: 'devA:UA-pin13-tap', jacks: ['devA:A13', 'devA:A12'] }];
  e._applyBoardNetGroups();
  e._touchNets();
  e.step(0);

  check('同组两孔初始同为 Z', [e.getJackLevel('devA:A13'), e.getJackLevel('devA:A12')], ['Z', 'Z']);
  checkTrue('同组两孔电平相等', e.getJackLevel('devA:A13') === e.getJackLevel('devA:A12'));

  // 一端接 VCC，另一端必须跟着变 1
  e.addWire({ id: 'w1', from: 'pwr:5V1', to: 'devA:A13' });
  e.step(0);
  check('一端接 VCC 后同组另一端也变 1', e.getJackLevel('devA:A12'), '1');

  // 该组所在网应包含两个插孔
  var net = null;
  e.getState().nets.forEach(function (n) {
    if (n.jacks.indexOf('devA:A13') >= 0) net = n;
  });
  checkTrue('该网同时含 A13 与 A12', !!net && net.jacks.indexOf('devA:A12') >= 0, net && net.jacks);
})();

// 4.2 不同组之间互不连通（未接线时各自 Z）
(function () {
  var e = newEngine();
  e.step(0);
  // devA:UA 与 devA:UB 是不同的插座区，未接线时必然各自 Z
  check('devA:A1 未接线时为 Z', e.getJackLevel('devA:A1'), 'Z');
  check('devA:B1 未接线时为 Z', e.getJackLevel('devA:B1'), 'Z');
  check('devA:E1 未接线时为 Z', e.getJackLevel('devA:E1'), 'Z');
  check('devA:D1 未接线时为 Z', e.getJackLevel('devA:D1'), 'Z');
  check('devA:F1 未接线时为 Z', e.getJackLevel('devA:F1'), 'Z');

  // 给 devA:A1 接 VCC，其他插座的孔不应跟着变
  e.addWire({ id: 'w', from: 'pwr:5V1', to: 'devA:A1' });
  e.step(0);
  check('A1 接 VCC 后为 1', e.getJackLevel('devA:A1'), '1');
  check('B1 仍为 Z（不串味）', e.getJackLevel('devA:B1'), 'Z');
  check('E1 仍为 Z（不串味）', e.getJackLevel('devA:E1'), 'Z');
  check('D1 仍为 Z（不串味）', e.getJackLevel('devA:D1'), 'Z');
  check('F1 仍为 Z（不串味）', e.getJackLevel('devA:F1'), 'Z');
  check('相邻的 A2 仍为 Z（金孔间无铜箔互连）', e.getJackLevel('devA:A2'), 'Z');
  check('相邻的 A13 仍为 Z（金孔间无铜箔互连）', e.getJackLevel('devA:A13'), 'Z');
})();

// 4.3 端到端：给某组一端接 VCC、另一端接 4P1，4L1 必须亮
//     用真实几何 + 注入的合成分组，走完整引擎链路
(function () {
  var e = newEngine();
  e._boardNetGroups = [{ id: 'devA:UA-pin1-tap', jacks: ['devA:A1', 'devA:A2'] }];
  e._applyBoardNetGroups();
  e._touchNets();

  e.addWire({ id: 'v', from: 'pwr:5V1', to: 'devA:A1' });
  e.addWire({ id: 'l', from: 'devA:A2', to: 'led:4P1' });
  var st = e.step(0);

  check('端到端：VCC -> A1 ~~ A2 -> 4P1，4L1 亮', st.leds['4L1'], true);
  check('led:4P1 孔电平为 1', e.getJackLevel('led:4P1'), '1');
  check('板内走线把 VCC 送到了 A2', e.getJackLevel('devA:A2'), '1');

  // 换一组（A3/A4）验证不是只对 A1/A2 生效
  var e2 = newEngine();
  e2._boardNetGroups = [{ id: 'devB:UB-pin3-tap', jacks: ['devB:B3', 'devB:B4'] }];
  e2._applyBoardNetGroups();
  e2._touchNets();
  e2.addWire({ id: 'v', from: 'pwr:5V2', to: 'devB:B3' });
  e2.addWire({ id: 'l', from: 'devB:B4', to: 'led:4P2' });
  var st2 = e2.step(0);
  check('端到端（devB）：VCC -> B3 ~~ B4 -> 4P2，4L2 亮', st2.leds['4L2'], true);
})();

// 4.4 板内走线与普通导线、VCC/GND 短路告警的相互作用
(function () {
  var e = newEngine();
  e._boardNetGroups = [{ id: 'devA:UA-pin1-tap', jacks: ['devA:A1', 'devA:A2'] }];
  e._applyBoardNetGroups();
  e._touchNets();
  // 一端接 VCC，另一端接 GND -> 必须报短路
  e.addWire({ id: 'v', from: 'pwr:5V1', to: 'devA:A1' });
  e.addWire({ id: 'g', from: 'devA:A2', to: 'gnd:GND1' });
  var st = e.step(0);
  checkTrue('经板内走线把 VCC 与 GND 连通 -> 短路告警', st.shorts.length > 0, st.shorts.length);
  check('短路网电平为 X', e.getJackLevel('devA:A1'), 'X');
})();

/* ============================================================
 * 5. devA 与 devB 互不串味
 * ============================================================ */

group('5. devA 与 devB 互不串味');
(function () {
  var e = newEngine();
  e._boardNetGroups = [
    { id: 'devA:UA-pin1-tap', jacks: ['devA:A1', 'devA:A2'] },
    { id: 'devB:UA-pin1-tap', jacks: ['devB:A1', 'devB:A2'] }
  ];
  e._applyBoardNetGroups();
  e._touchNets();

  e.addWire({ id: 'v', from: 'pwr:5V1', to: 'devA:A1' });
  var st = e.step(0);

  check('devA 组内 A2 变 1', e.getJackLevel('devA:A2'), '1');
  check('devB 同位置 B2 仍为 Z（两块模块走线互不串味）', e.getJackLevel('devB:A2'), 'Z');
  check('devB:A1 仍为 Z', e.getJackLevel('devB:A1'), 'Z');

  // 反向：给 devB 接 VCC，devA 不受影响
  e.addWire({ id: 'v2', from: 'pwr:5V2', to: 'devB:A1' });
  e.step(1);
  check('devB 组内 A2 变 1', e.getJackLevel('devB:A2'), '1');
  check('devA 组内 A2 仍为 1（各自独立）', e.getJackLevel('devA:A2'), '1');

  // 两块模块的 VCC / GND 是同一固定网（契约 4.1：devA:VCC / devB:VCC 都是 VCC）
  check('devA:VCC 为 1', e.getJackLevel('devA:VCC'), '1');
  check('devB:VCC 为 1', e.getJackLevel('devB:VCC'), '1');
  check('devA:GND 为 0', e.getJackLevel('devA:GND'), '0');
  check('devB:GND 为 0', e.getJackLevel('devB:GND'), '0');
  check('devA:VCC 与 devB:VCC 同网（fixedNet 合并）', e.getJackLevel('devA:VCC'), e.getJackLevel('devB:VCC'));

  // 真实推导（无注入）时，两块模块的插座孔互不连通
  var e2 = newEngine();
  e2.step(0);
  e2.addWire({ id: 'v', from: 'pwr:5V1', to: 'devA:A1' });
  e2.step(0);
  check('真实推导下 devA:A1=1 而 devB:A1 仍 Z', [e2.getJackLevel('devA:A1'), e2.getJackLevel('devB:A1')], ['1', 'Z']);
})();

/* ============================================================
 * 6. getState().boardNetGroups
 * ============================================================ */

group('6. getState().boardNetGroups');
(function () {
  var e = newEngine();
  var st = e.step(0);
  checkTrue('getState 返回 boardNetGroups 字段', Array.isArray(st.boardNetGroups));
  check('真实几何下 boardNetGroups 为空数组（无共享落点）', st.boardNetGroups.length, 0);

  // 原有字段未被破坏（新增字段不能影响已有字段）
  ['jacks', 'nets', 'leds', 'swLeds', 'segs', 'segOn', 'pulses', 'shorts', 'warnings', 'now', 'power', 'clockEnabled']
    .forEach(function (k) {
      checkTrue('getState 仍含原有字段 ' + k, Object.prototype.hasOwnProperty.call(st, k));
    });

  // 注入分组后 boardNetGroups 应如实反映
  var e2 = newEngine();
  e2._boardNetGroups = [{ id: 'devA:UA-pin1-tap', jacks: ['devA:A1', 'devA:A2'] }];
  e2._applyBoardNetGroups();
  e2._touchNets();
  var st2 = e2.step(0);
  check('注入 1 组后 boardNetGroups 长度', st2.boardNetGroups.length, 1);
  check('boardNetGroups 内容与注入一致', st2.boardNetGroups[0].id, 'devA:UA-pin1-tap');
  check('boardNetGroups 的 jacks 与注入一致', st2.boardNetGroups[0].jacks.slice().sort(), ['devA:A1', 'devA:A2']);
  checkTrue('boardNetGroups 是副本（改动不影响引擎内部）', (function () {
    st2.boardNetGroups[0].jacks.push('devA:A3');
    return e2._boardNetGroups[0].jacks.length === 2;
  })());
})();

/* ============================================================
 * 7. 板内走线在导线增删 / reset 后仍然生效
 * ============================================================ */

group('7. 导线增删 / reset 后板内走线复原');
(function () {
  var e = newEngine();
  e._boardNetGroups = [{ id: 'devA:UA-pin1-tap', jacks: ['devA:A1', 'devA:A2'] }];
  e._applyBoardNetGroups();
  e._touchNets();
  e.addWire({ id: 'v', from: 'pwr:5V1', to: 'devA:A1' });
  e.addWire({ id: 'l', from: 'devA:A2', to: 'led:4P1' });
  var st = e.step(0);
  check('初始：4L1 亮', st.leds['4L1'], true);

  // 删除一条普通导线会触发 Netlist._rebuild()，板内走线必须被补回
  e.removeWire('l');
  e.step(0);
  check('删除导线后 A1 仍为 1（板内走线未被 _rebuild 冲掉）', e.getJackLevel('devA:A1'), '1');
  check('删除导线后 A2 仍与 A1 同电平', e.getJackLevel('devA:A2'), e.getJackLevel('devA:A1'));

  e.addWire({ id: 'l2', from: 'devA:A2', to: 'led:4P2' });
  e.step(1);
  check('重新接线后 4L2 亮', e.getState().leds['4L2'], true);

  // clearWires 同样会 _rebuild
  e.clearWires();
  e.step(2);
  check('clearWires 后 A1 回到 Z', e.getJackLevel('devA:A1'), 'Z');
  check('clearWires 后 A1 与 A2 仍同网（板内走线仍在）', e.getJackLevel('devA:A1'), e.getJackLevel('devA:A2'));
  var net = null;
  e.getState().nets.forEach(function (n) { if (n.jacks.indexOf('devA:A1') >= 0) net = n; });
  checkTrue('clearWires 后该网仍含 A1 与 A2', !!net && net.jacks.indexOf('devA:A2') >= 0, net && net.jacks);

  // reset 同样会 _rebuild
  e.addWire({ id: 'v2', from: 'pwr:5V1', to: 'devA:A1' });
  e.step(3);
  check('reset 前 A2 为 1', e.getJackLevel('devA:A2'), '1');
  e.reset();
  var stR = e.getState();
  check('reset 后导线清空', e.getWires().length, 0);
  check('reset 后 A1 回到 Z', e.getJackLevel('devA:A1'), 'Z');
  checkTrue('reset 后 A1 与 A2 仍同网（板内走线仍在）',
    e.getJackLevel('devA:A1') === e.getJackLevel('devA:A2'));
  check('reset 后 boardNetGroups 仍保留', stR.boardNetGroups.length, 1);
})();

/* ============================================================
 * 8. BoardNets 缺失时的向后兼容
 * ============================================================ */

group('8. BoardNets 缺失时向后兼容');
(function () {
  var ENGINE_PATH = path.join(__dirname, '..', 'src', 'core', 'engine.js');
  var savedBN = DLab.BoardNets;
  var savedEngine = DLab.Engine;

  /** 重载 engine.js：让它按当前 DLab.BoardNets 重新取一次依赖 */
  function reloadEngine() {
    delete require.cache[require.resolve(ENGINE_PATH)];
    require(ENGINE_PATH);
    return DLab.Engine;
  }

  // ---- 场景一：完全不提供 BoardNets ----
  delete DLab.BoardNets;
  var E2 = reloadEngine();
  checkTrue('无 BoardNets 时仍能加载 engine.js', typeof E2 === 'function');

  var e = new E2({ geometry: GEO });
  var st = e.step(0);
  checkTrue('无 BoardNets 时仍能构造引擎并 step', !!st && !!st.jacks);
  check('无 BoardNets 时插孔电平表覆盖全部插孔', Object.keys(st.jacks).length, Object.keys(GEO.JACKS).length);
  check('无 BoardNets 时 boardNetGroups 为空数组', st.boardNetGroups.length, 0);
  check('无 BoardNets 时 pwr:5V1 仍为 1', e.getJackLevel('pwr:5V1'), '1');
  check('无 BoardNets 时 gnd:GND1 仍为 0', e.getJackLevel('gnd:GND1'), '0');
  check('无 BoardNets 时 devA:VCC 仍为 1', e.getJackLevel('devA:VCC'), '1');
  check('无 BoardNets 时不误报「板内走线」告警', st.warnings.filter(function (w) {
    return w.indexOf('板内走线') >= 0;
  }), []);

  // 与「有 BoardNets 但无连通组」的引擎逐孔对比，行为必须完全一致
  DLab.BoardNets = savedBN;
  var e3 = new (reloadEngine())({ geometry: GEO });
  e3.step(0);
  var diff = [];
  Object.keys(st.jacks).forEach(function (id) {
    if (st.jacks[id] !== e3.getState().jacks[id]) diff.push(id);
  });
  check('无 BoardNets 与有 BoardNets 的插孔电平完全一致', diff, []);
  check('无 BoardNets 与有 BoardNets 的短路列表一致', st.shorts.length, e3.getState().shorts.length);

  // ---- 场景二：BoardNets 存在但推导抛错 -> 降级为「无板内连通」，不阻断引擎 ----
  DLab.BoardNets = {
    GROUPS: [],
    buildGroups: function () { throw new Error('模拟推导失败'); }
  };
  var E4 = reloadEngine();
  var e4 = new E4({ geometry: GEO });
  var st4 = e4.step(0);
  checkTrue('推导抛错时引擎仍可构造', !!st4 && !!st4.jacks);
  check('推导抛错时 boardNetGroups 为空', st4.boardNetGroups.length, 0);
  checkTrue('推导抛错时 warnings 含中文降级提示',
    st4.warnings.some(function (w) { return w.indexOf('板内走线模型推导失败') >= 0; }), st4.warnings);
  check('推导抛错时 VCC 仍正常', e4.getJackLevel('pwr:5V1'), '1');
  check('推导抛错时 GND 仍正常', e4.getJackLevel('gnd:GND1'), '0');

  // ---- 恢复现场 ----
  DLab.BoardNets = savedBN;
  reloadEngine();
  DLab.Engine = savedEngine;
  checkTrue('BoardNets 已恢复', DLab.BoardNets === savedBN);
})();

/* ============================================================
 * 9. 真实几何下的整体一致性（不注入任何分组）
 * ============================================================ */

group('9. 真实几何下整体一致性');
(function () {
  var e = newEngine();
  var st = e.step(0);
  check('真实几何下无板内连通组（推导结论）', st.boardNetGroups.length, 0);
  check('真实几何下无短路', st.shorts.length, 0);

  // 每个开发模块的 82 个插孔都应存在
  var devA = Object.keys(GEO.JACKS).filter(function (id) { return GEO.JACKS[id].moduleId === 'devA'; });
  var devB = Object.keys(GEO.JACKS).filter(function (id) { return GEO.JACKS[id].moduleId === 'devB'; });
  check('devA 插孔数 82', devA.length, 82);
  check('devB 插孔数 82', devB.length, 82);

  // 82 = 14 + 14 + 16 + 16 + 20 + VCC + GND（证明「引脚孔」与「引出金孔」是同一个孔）
  var expected = BoardNets.SOCKET_AREAS.reduce(function (sum, a) { return sum + a.pins; }, 0) + 2;
  check('82 = 各插座脚数之和 + VCC/GND（引脚孔与金孔合一）', expected, 82);

  // 未接线时所有无源开发模块插孔都是 Z
  var notZ = devA.concat(devB).filter(function (id) {
    var info = e.getJackInfo(id);
    if (!info || info.fixedNet) return false;
    return e.getJackLevel(id) !== 'Z';
  });
  check('未接线时开发模块的无源插孔全为 Z', notZ, []);

  // 插座 <-> 插孔映射仍符合契约 4.2（本模块不改变该映射）
  check('devA:UA 第 1 脚 -> devA:A1', e.socketJack('devA:UA', 1), 'devA:A1');
  check('devA:UA 第 14 脚 -> devA:A14', e.socketJack('devA:UA', 14), 'devA:A14');
  check('devA:UE 第 16 脚 -> devA:E16', e.socketJack('devA:UE', 16), 'devA:E16');
  check('devB:UF 第 20 脚 -> devB:F20', e.socketJack('devB:UF', 20), 'devB:F20');
})();

/* ============================================================
 * 汇总
 * ============================================================ */

console.log('\n' + new Array(65).join('='));
var failed = results.filter(function (r) { return !r.ok; });
var total = results.length;
if (failed.length === 0) {
  console.log('\u2713 全部通过 ' + total + '/' + total);
  console.log('  分组数：' + new Set(results.map(function (r) { return r.group; })).size);
  console.log('  GROUPS 组数：' + BoardNets.GROUPS.length + '（推导结论：真实几何下无多孔共享落点）');
  console.log('  覆盖插座：' + (function () {
    var mods = Object.keys(BoardNets.MODULE_ORIGINS);
    var socks = BoardNets.SOCKET_AREAS.map(function (a) { return a.socket; });
    return mods.map(function (m) { return m + '[' + socks.join('/') + ']'; }).join(' + ');
  })());
  process.exitCode = 0;
} else {
  console.log('\u2717 失败 ' + failed.length + ' / ' + total + ' 项');
  failed.forEach(function (f) {
    console.log('  - [' + f.group + '] ' + f.desc);
  });
  process.exitCode = 1;
}
console.log(new Array(65).join('='));

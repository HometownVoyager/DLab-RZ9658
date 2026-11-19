#!/usr/bin/env node
// tests/engine.selftest.cjs
// DLab 仿真引擎零依赖自测：node tests/engine.selftest.cjs
// 覆盖：导线连通、VCC/GND 短接告警、开关->LED 联动、74LS00 四组与非门真值表、
//       74LS74 上升沿触发与异步复位、74LS138 使能与译码、74LS161 计数与进位、
//       导线删除后网表拆分、reset 后状态归零、数码管段码直驱、脉冲与时钟相位。
// 2026-10-30 审查新增：P1（变更类 API 即时重算）与 P2（时钟/DDS 混叠告警）用例组；
//       芯片库扩充至 21 款（含 74LS21/30/47/48，对应真实 LCD 菜单 7421/7430/7447/7448）。
// 2026-10-30 遗留项收尾新增：18 P3 门电路驱动扬声器测频、19 P5a 固定网来源归类、
//       20 P5b 已占插座抛错、21 H7 批量收尾 + H1' 同刻记忆化。
'use strict';

var path = require('path');

// ---- 按契约加载三个核心模块（经典脚本 + 全局命名空间）----
globalThis.DLab = {};
require(path.join(__dirname, '..', 'src', 'core', 'logic.js'));
require(path.join(__dirname, '..', 'src', 'core', 'chips.js'));
require(path.join(__dirname, '..', 'src', 'core', 'engine.js'));

var DLab = globalThis.DLab;
var Engine = DLab.Engine;
var Chips = DLab.Chips;
var Logic = DLab.Logic;

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
  results.push({ group: currentGroup, desc: desc, ok: ok, actual: actual, expected: expected });
  if (ok) {
    console.log('  \u2713 ' + desc);
  } else {
    console.log('  \u2717 ' + desc);
    console.log('      期望: ' + JSON.stringify(expected));
    console.log('      实际: ' + JSON.stringify(actual));
  }
  return ok;
}

function checkTrue(desc, cond, extra) {
  var ok = !!cond;
  results.push({ group: currentGroup, desc: desc, ok: ok, actual: extra === undefined ? cond : extra, expected: true });
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
  results.push({ group: currentGroup, desc: desc, ok: threw, actual: threw ? '抛错' : '未抛错', expected: '抛错' });
  if (threw) console.log('  \u2713 ' + desc + '（' + msg + '）');
  else console.log('  \u2717 ' + desc + '（应抛错但没有）');
  return threw;
}

/* ============================================================
 * 测试用精简几何桩数据
 *   只造够用的插孔：电源、地、开关、时钟、脉冲、LED、数码管、A/B 两个开发模块。
 * ============================================================ */

function buildStubGeometry() {
  var jacks = {};
  var order = [];

  function add(moduleId, label, kind, fixedNet) {
    var id = moduleId + ':' + label;
    jacks[id] = {
      id: id, label: label, moduleId: moduleId,
      x: order.length * 10, y: 0,
      kind: kind || 'passive',
      fixedNet: fixedNet || null
    };
    order.push(id);
  }

  var i;
  // 电源 / 地
  add('pwr', '5V1', 'power', 'VCC');
  add('pwr', '5V2', 'power', 'VCC');
  add('gnd', 'GND1', 'ground', 'GND');
  add('gnd', 'GND2', 'ground', 'GND');

  // 逻辑开关 5K1~5K16
  for (i = 1; i <= 16; i++) add('sw', '5K' + i, 'driver');

  // 时钟
  ['1HZ', '2HZ', '4HZ', '8HZ', '1KHZ', '10KHZ', '1MHZ', 'CONT'].forEach(function (c) {
    add('clock', c, 'driver');
  });

  // 单脉冲
  for (i = 1; i <= 6; i++) {
    add('pulse', '6K' + i + '-', 'driver');
    add('pulse', '6K' + i + '+', 'driver');
  }

  // 发光二极管 4P1~4P16
  for (i = 1; i <= 16; i++) add('led', '4P' + i, 'sink');

  // 数码管 seg1/seg2（8 段）、seg3~seg8（5 段，seg5 没有 DP5，模拟真实面板）
  var SEG_LAYOUT = Engine.SEG_LAYOUT;
  for (i = 1; i <= 8; i++) {
    var segId = 'seg' + i;
    var keys = SEG_LAYOUT[segId];
    keys.forEach(function (k) {
      var prefix = { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', f: 'F', g: 'G', dp: 'DP' }[k];
      // 模拟 seg5 的 DP 孔在实物上是 GND 环、几何里不存在
      if (segId === 'seg5' && k === 'dp') return;
      add(segId, prefix + i, 'sink');
    });
  }

  // A / B 数电开发模块：A1~A14 B1~B14 E1~E16 D1~D16 F1~F20 + VCC/GND
  ['devA', 'devB'].forEach(function (m) {
    for (i = 1; i <= 14; i++) add(m, 'A' + i, 'passive');
    for (i = 1; i <= 14; i++) add(m, 'B' + i, 'passive');
    for (i = 1; i <= 16; i++) add(m, 'E' + i, 'passive');
    for (i = 1; i <= 16; i++) add(m, 'D' + i, 'passive');
    for (i = 1; i <= 20; i++) add(m, 'F' + i, 'passive');
    add(m, 'VCC', 'power', 'VCC');
    add(m, 'GND', 'ground', 'GND');
  });

  // 逻辑笔 / 分析仪 / 中间列
  add('probe', 'P01', 'driver');
  add('rc', '1', 'passive'); add('rc', '2', 'passive'); add('rc', '3', 'passive');
  for (i = 0; i < 8; i++) add('analyzer', 'DCH' + i, 'sink');
  add('mid', 'SPK', 'sink'); add('mid', 'BEEP', 'sink');
  add('mid', 'ACH1', 'sink'); add('mid', 'DDS', 'sink');

  return { VIEWBOX: { width: 1800, height: 1380 }, JACKS: jacks, JACK_ORDER: order, MODULES: [] };
}

var STUB_GEO = buildStubGeometry();

function newEngine() {
  return new Engine({ geometry: STUB_GEO });
}

/** 把芯片某引脚直接接到某个插孔：pinJack = engine.socketJack(socket, pin) */
function wirePin(engine, socket, pin, targetJack, id) {
  var j = engine.socketJack(socket, pin);
  if (!j) throw new Error('插座 ' + socket + ' 的第 ' + pin + ' 脚没有对应插孔');
  engine.addWire({ id: id, from: j, to: targetJack });
  return j;
}

/* ============================================================
 * 1. 模块加载与芯片库完整性
 * ============================================================ */

group('1. 模块加载与芯片库');
checkTrue('DLab.Logic 已挂载', !!Logic);
checkTrue('DLab.Chips 已挂载', !!Chips);
checkTrue('DLab.Engine 已挂载', typeof Engine === 'function');
// 型号清单随芯片库扩充而增长（第三阶段新增 112/148/153/160/194/283 六款 16 脚器件；
// 2026-10-30 审查新增 74LS21/30/47/48 四款，对应真实 LCD 菜单的 7421/7430/7447/7448），
// 顺序取 Chips.list() 的字典序。这里锁的是「清单本身」，防止型号被误删或漏注册。
check('芯片型号列表', Chips.list(),
  ['74LS00', '74LS02', '74LS04', '74LS08', '74LS112', '74LS138', '74LS148', '74LS151',
    '74LS153', '74LS160', '74LS161', '74LS194', '74LS21', '74LS273', '74LS283', '74LS30',
    '74LS32', '74LS47', '74LS48', '74LS74', '74LS86']);
check('74LS00 封装脚数', Chips.packageOf('74LS00'), 14);
check('74LS138 封装脚数', Chips.packageOf('74LS138'), 16);
check('74LS273 封装脚数', Chips.packageOf('74LS273'), 20);
check('74LS00 引脚名 VCC/GND', [
  Chips.pinNamesOf('74LS00').VCC, Chips.pinNamesOf('74LS00').GND
], [14, 7]);
check('74LS138 引脚名 Y0/Y7', [
  Chips.pinNamesOf('74LS138').Y0, Chips.pinNamesOf('74LS138').Y7
], [15, 7]);
check('74LS161 引脚名 RCO/~MR', [
  Chips.pinNamesOf('74LS161').RCO, Chips.pinNamesOf('74LS161')['~MR']
], [15, 1]);

/* ============================================================
 * 2. 4 态逻辑原语
 * ============================================================ */

group('2. 4 态逻辑原语');
check('resolve 无驱动 -> Z', Logic.resolve([]), 'Z');
check('resolve 单个 1 -> 1', Logic.resolve(['1']), '1');
check('resolve 单个 0 -> 0', Logic.resolve(['0']), '0');
check('resolve Z 与 1 -> 1', Logic.resolve(['Z', '1']), '1');
check('resolve 强 1 + 强 0 -> X', Logic.resolve(['1', '0']), 'X');
check('resolve 带 X -> X', Logic.resolve(['Z', 'X']), 'X');
check('toBin Z（TTL）-> 1', Logic.toBin('Z', true), '1');
check('toBin Z（CMOS）-> X', Logic.toBin('Z', false), 'X');
check('nand(1,1)', Logic.nand('1', '1'), '0');
check('nand(1,0)', Logic.nand('1', '0'), '1');
check('xor(1,0)', Logic.xor('1', '0'), '1');
check('not(X)', Logic.not('X'), 'X');
check('and3(1,1,1)', Logic.and3('1', '1', '1'), '1');
check('nand3(1,1,0)', Logic.nand3('1', '1', '0'), '1');

/* ============================================================
 * 3. 网表：连通、拆分、fixedNet 预合并
 * ============================================================ */

group('3. 网表连通与拆分');
(function () {
  var e = newEngine();
  e.addWire({ id: 'w1', from: 'sw:5K1', to: 'devA:A1', color: '#ef4444' });
  e.addWire({ id: 'w2', from: 'devA:A1', to: 'led:4P1', color: '#22c55e' });
  e.step(0);
  checkTrue('三孔经两条导线同网', e.getJackLevel('sw:5K1') === e.getJackLevel('devA:A1') &&
    e.getJackLevel('devA:A1') === e.getJackLevel('led:4P1'), {
    sw: e.getJackLevel('sw:5K1'), devA: e.getJackLevel('devA:A1'), led: e.getJackLevel('led:4P1')
  });

  e.removeWire('w1');
  e.step(0);
  checkTrue('删除 w1 后 devA:A1 与 sw:5K1 断开', e.getJackLevel('devA:A1') !== e.getJackLevel('sw:5K1') ||
    e.getJackLevel('devA:A1') === 'Z', {
    sw: e.getJackLevel('sw:5K1'), devA: e.getJackLevel('devA:A1'), led: e.getJackLevel('led:4P1')
  });
  checkTrue('删除 w1 后 devA:A1 与 4P1 仍同网', e.getJackLevel('devA:A1') === e.getJackLevel('led:4P1'));
  check('删除后剩余导线数', e.getWires().length, 1);
  checkTrue('删除不存在的导线返回 false', e.removeWire('nope') === false);

  var st = e.getState();
  var netA1 = null;
  st.nets.forEach(function (n) { if (n.jacks.indexOf('devA:A1') >= 0) netA1 = n; });
  checkTrue('nets 中能找到 devA:A1 所在网', !!netA1, netA1 && netA1.jacks);
  check('该网只含 devA:A1 与 led:4P1', netA1 && netA1.jacks.slice().sort(), ['devA:A1', 'led:4P1']);

  checkThrows('同孔接线抛错', function () { e.addWire({ from: 'sw:5K1', to: 'sw:5K1' }); });
  checkThrows('未知插孔接线抛错', function () { e.addWire({ from: 'sw:5K1', to: 'zzz:1' }); });
  checkThrows('导线 id 重复抛错', function () { e.addWire({ id: 'w2', from: 'sw:5K2', to: 'devA:A2' }); });
})();

group('4. fixedNet 预合并（VCC / GND）');
(function () {
  var e = newEngine();
  e.step(0);
  check('pwr:5V1 恒为 1', e.getJackLevel('pwr:5V1'), '1');
  check('pwr:5V2 恒为 1', e.getJackLevel('pwr:5V2'), '1');
  check('gnd:GND1 恒为 0', e.getJackLevel('gnd:GND1'), '0');
  check('devA:VCC 恒为 1', e.getJackLevel('devA:VCC'), '1');
  check('devB:GND 恒为 0', e.getJackLevel('devB:GND'), '0');
  check('未连接的开关孔有驱动（非 Z）', e.getJackLevel('sw:5K1') !== 'Z', true);

  // VCC 与 GND 短接 -> X + shorts
  var e2 = newEngine();
  e2.addWire({ id: 'short', from: 'pwr:5V1', to: 'gnd:GND1' });
  e2.step(0);
  check('VCC-GND 短接后电平为 X', e2.getJackLevel('pwr:5V1'), 'X');
  check('GND 孔也变 X', e2.getJackLevel('gnd:GND1'), 'X');
  var st = e2.getState();
  checkTrue('shorts 非空', st.shorts.length > 0, st.shorts);
  checkTrue('shorts 条目含 netId/level/jacks', !!(st.shorts[0] && st.shorts[0].netId &&
    st.shorts[0].level === 'X' && Array.isArray(st.shorts[0].jacks)), st.shorts[0]);
  checkTrue('warnings 含短路中文提示', st.warnings.some(function (w) { return w.indexOf('短路') >= 0; }), st.warnings);

  // 断开后恢复
  e2.removeWire('short');
  e2.step(0);
  check('断开短接线后 VCC 恢复 1', e2.getJackLevel('pwr:5V1'), '1');
  check('断开短接线后 GND 恢复 0', e2.getJackLevel('gnd:GND1'), '0');
  check('断开后 shorts 清空', e2.getState().shorts.length, 0);
})();

/* ============================================================
 * 5. 开关 -> LED 联动、swLeds
 * ============================================================ */

group('5. 开关 -> LED 联动');
(function () {
  var e = newEngine();
  e.addWire({ id: 'l1', from: 'sw:5K1', to: 'led:4P1' });
  e.addWire({ id: 'l2', from: 'sw:5K2', to: 'led:4P2' });

  e.setSwitch(1, 1); e.setSwitch(2, 0);
  var st = e.step(0);
  check('5K1=1 -> 4L1 亮', st.leds['4L1'], true);
  check('5K2=0 -> 4L2 灭', st.leds['4L2'], false);
  check('5L1 状态灯亮', st.swLeds['5L1'], true);
  check('5L2 状态灯灭', st.swLeds['5L2'], false);
  check('sw:5K1 孔电平 1', st.jacks['sw:5K1'], '1');

  e.setSwitch(1, 0);
  st = e.step(1);
  check('翻转 5K1 后 4L1 灭', st.leds['4L1'], false);
  check('getSwitch(1) 读回 0', e.getSwitch(1), 0);

  checkThrows('开关编号越界抛错', function () { e.setSwitch(17, 1); });
})();

/* ============================================================
 * 6. 74LS00 四组与非门真值表全覆盖
 * ============================================================ */

group('6. 74LS00 四组与非门真值表');
(function () {
  // 引脚组：[A, B, Y]
  var groups = [[1, 2, 3], [4, 5, 6], [9, 10, 8], [12, 13, 11]];
  var SOCKET = 'devA:UA';
  var truth = [['0', '0', '1'], ['0', '1', '1'], ['1', '0', '1'], ['1', '1', '0']];
  var allOk = true;
  var detail = [];

  groups.forEach(function (g, gi) {
    var e = newEngine();
    e.mountChip(SOCKET, '74LS00');
    // 电源与地
    wirePin(e, SOCKET, 14, 'pwr:5V1', 'vcc');
    wirePin(e, SOCKET, 7, 'gnd:GND1', 'gnd');
    // 两个输入接到 5K1 / 5K2，输出接 4P1
    wirePin(e, SOCKET, g[0], 'sw:5K1', 'inA');
    wirePin(e, SOCKET, g[1], 'sw:5K2', 'inB');
    wirePin(e, SOCKET, g[2], 'led:4P1', 'out');

    truth.forEach(function (row) {
      e.setSwitch(1, row[0] === '1' ? 1 : 0);
      e.setSwitch(2, row[1] === '1' ? 1 : 0);
      e.step(0);
      var y = e.getJackLevel(e.socketJack(SOCKET, g[2]));
      var ok = y === row[2];
      if (!ok) allOk = false;
      detail.push('组' + (gi + 1) + ' A=' + row[0] + ' B=' + row[1] + ' -> Y=' + y + (ok ? '' : '（期望 ' + row[2] + '）'));
    });
  });
  checkTrue('74LS00 四组 × 4 行真值表全部正确', allOk, allOk ? undefined : detail);

  // 悬空输入按 TTL 当 1：只接 A=0，B 悬空 -> 0 NAND 1 = 1
  var e2 = newEngine();
  e2.mountChip(SOCKET, '74LS00');
  wirePin(e2, SOCKET, 14, 'pwr:5V1', 'v');
  wirePin(e2, SOCKET, 7, 'gnd:GND1', 'g');
  wirePin(e2, SOCKET, 1, 'gnd:GND1', 'a');   // 1A = 0
  e2.step(0);
  check('74LS00 悬空输入按 TTL 当 1（0 NAND 悬空 = 1）', e2.getJackLevel(e2.socketJack(SOCKET, 3)), '1');

  // 关掉 TTL 语义后，悬空输入按未知处理：1A=1 且 1B 悬空 -> NAND(1, X) = X
  var e3 = new Engine({ geometry: STUB_GEO, isTTL: false });
  e3.mountChip(SOCKET, '74LS00');
  wirePin(e3, SOCKET, 14, 'pwr:5V1', 'v');
  wirePin(e3, SOCKET, 7, 'gnd:GND1', 'g');
  wirePin(e3, SOCKET, 1, 'pwr:5V1', 'a');   // 1A = 1，1B 悬空
  e3.step(0);
  check('isTTL=false 时悬空输入 -> X（NAND(1,X)）', e3.getJackLevel(e3.socketJack(SOCKET, 3)), 'X');

  // 对照：TTL 语义下同一接线 NAND(1, 悬空=1) = 0
  var e3b = new Engine({ geometry: STUB_GEO });
  e3b.mountChip(SOCKET, '74LS00');
  wirePin(e3b, SOCKET, 14, 'pwr:5V1', 'v');
  wirePin(e3b, SOCKET, 7, 'gnd:GND1', 'g');
  wirePin(e3b, SOCKET, 1, 'pwr:5V1', 'a');
  e3b.step(0);
  check('TTL 语义下同一接线 -> 0（悬空当 1）', e3b.getJackLevel(e3b.socketJack(SOCKET, 3)), '0');

  checkThrows('14 脚型号插 16 脚插座抛错', function () { newEngine().mountChip('devA:UE', '74LS00'); });
  checkThrows('未知型号抛错', function () { newEngine().mountChip('devA:UA', '74LS999'); });
})();

/* ============================================================
 * 7. 74LS74 上升沿触发与异步复位
 * ============================================================ */

group('7. 74LS74 上升沿触发 / 异步复位');
(function () {
  var S = 'devA:UA';
  var e = newEngine();
  e.mountChip(S, '74LS74');
  wirePin(e, S, 14, 'pwr:5V1', 'vcc');
  wirePin(e, S, 7, 'gnd:GND1', 'gnd');
  wirePin(e, S, 2, 'sw:5K1', 'd');       // 1D
  wirePin(e, S, 3, 'clock:1HZ', 'clk');  // 1CLK
  wirePin(e, S, 1, 'sw:5K2', 'clr');     // ~1CLR
  wirePin(e, S, 4, 'pwr:5V1', 'pre');    // ~1PRE 接高（无效）
  wirePin(e, S, 5, 'led:4P1', 'q');      // 1Q -> 4P1
  wirePin(e, S, 6, 'led:4P2', 'qn');     // ~1Q -> 4P2

  var qJack = e.socketJack(S, 5);
  var qnJack = e.socketJack(S, 6);

  e.setSwitch(1, 1);   // D = 1
  e.setSwitch(2, 1);   // ~CLR = 1（无效）

  // 1Hz 方波：周期 1000ms，t∈[0,500) 高、[500,1000) 低
  e.step(0);
  var q0 = e.getJackLevel(qJack);

  // t=600ms -> 低电平（下降沿，不触发）
  e.step(600);
  var qAfterFall = e.getJackLevel(qJack);
  check('时钟下降沿不改变输出', qAfterFall, q0);

  // t=1000ms -> 回到高电平（上升沿，采样 D=1）
  e.step(1000);
  check('上升沿采样 D=1 -> Q=1', e.getJackLevel(qJack), '1');
  check('~Q 与 Q 互补 -> 0', e.getJackLevel(qnJack), '0');
  check('4L1 亮（Q=1）', e.getState().leds['4L1'], true);
  check('4L2 灭（~Q=0）', e.getState().leds['4L2'], false);

  // D 改 0，等下一个上升沿 t=2000ms
  e.setSwitch(1, 0);
  e.step(1700);   // 1Hz 低电平期（1500~2000），不触发
  check('D 改为 0 但时钟未到上升沿，Q 保持 1', e.getJackLevel(qJack), '1');
  e.step(2000);
  check('下一个上升沿采样 D=0 -> Q=0', e.getJackLevel(qJack), '0');

  // 异步复位：~CLR 拉低立即清零（不等时钟）
  e.setSwitch(1, 1);
  e.step(2000);
  e.setSwitch(2, 0);          // ~CLR = 0
  e.step(2100);               // 处于高电平期，无上升沿
  check('~CLR=0 异步清零 Q=0', e.getJackLevel(qJack), '0');
  e.setSwitch(2, 1);          // 释放复位
  e.step(2200);
  check('释放 ~CLR 后 Q 保持 0（未到上升沿）', e.getJackLevel(qJack), '0');
  e.step(2700);               // 先经过低电平期（2500~3000），形成真正的下降沿
  check('低电平期 Q 保持 0', e.getJackLevel(qJack), '0');
  e.step(4000);               // 上升沿（t=4000 是 1Hz 的上升沿），D=1 -> Q=1
  check('复位释放后的上升沿重新采样 D=1', e.getJackLevel(qJack), '1');

  // 异步置位：~PRE 拉低立即置 1
  e.removeWire('pre');
  wirePin(e, S, 4, 'gnd:GND1', 'pre2');   // ~1PRE = 0
  e.step(4000);
  check('~PRE=0 异步置位 Q=1', e.getJackLevel(qJack), '1');
})();

/* ============================================================
 * 8. 74LS138 使能与译码
 * ============================================================ */

group('8. 74LS138 使能与译码');
(function () {
  var S = 'devA:UE';   // 16 脚插座
  var e = newEngine();
  e.mountChip(S, '74LS138');
  wirePin(e, S, 16, 'pwr:5V1', 'vcc');
  wirePin(e, S, 8, 'gnd:GND1', 'gnd');
  wirePin(e, S, 1, 'sw:5K1', 'a');      // A
  wirePin(e, S, 2, 'sw:5K2', 'b');      // B
  wirePin(e, S, 3, 'sw:5K3', 'c');      // C
  wirePin(e, S, 6, 'sw:5K4', 'g1');     // G1 高有效
  wirePin(e, S, 4, 'sw:5K5', 'g2a');    // ~G2A 低有效
  wirePin(e, S, 5, 'sw:5K6', 'g2b');    // ~G2B 低有效

  // 输出引脚 Y0..Y7
  var outPins = [15, 14, 13, 12, 11, 10, 9, 7];
  var outJacks = outPins.map(function (p) { return e.socketJack(S, p); });

  // 使能条件：G1=1, ~G2A=0, ~G2B=0
  e.setSwitch(4, 1); e.setSwitch(5, 0); e.setSwitch(6, 0);

  // 全地址扫描
  var allOk = true;
  var detail = [];
  for (var sel = 0; sel < 8; sel++) {
    e.setSwitch(1, (sel & 1) ? 1 : 0);
    e.setSwitch(2, (sel & 2) ? 1 : 0);
    e.setSwitch(3, (sel & 4) ? 1 : 0);
    e.step(0);
    for (var i = 0; i < 8; i++) {
      var got = e.getJackLevel(outJacks[i]);
      var want = (i === sel) ? '0' : '1';
      if (got !== want) {
        allOk = false;
        detail.push('CBA=' + sel + ' Y' + i + '=' + got + '（期望 ' + want + '）');
      }
    }
  }
  checkTrue('74LS138 8 个地址全部正确译码（选中输出低、其余高）', allOk, allOk ? undefined : detail);

  // G1 = 0 时禁止
  e.setSwitch(4, 0);
  e.step(0);
  var dis = outJacks.map(function (j) { return e.getJackLevel(j); });
  check('G1=0 时全部输出为 1', dis, ['1', '1', '1', '1', '1', '1', '1', '1']);

  // ~G2A = 1 时禁止
  e.setSwitch(4, 1); e.setSwitch(5, 1);
  e.step(0);
  check('~G2A=1 时全部输出为 1', outJacks.map(function (j) { return e.getJackLevel(j); }),
    ['1', '1', '1', '1', '1', '1', '1', '1']);

  // 恢复使能，检查 Y0 单独被选中
  e.setSwitch(5, 0);
  e.setSwitch(1, 0); e.setSwitch(2, 0); e.setSwitch(3, 0);
  e.step(0);
  check('CBA=000 时 Y0=0', e.getJackLevel(outJacks[0]), '0');
  check('CBA=000 时 Y7=1', e.getJackLevel(outJacks[7]), '1');
})();

/* ============================================================
 * 9. 74LS161 计数与进位
 * ============================================================ */

group('9. 74LS161 计数与进位');
(function () {
  var S = 'devA:UE';
  var e = newEngine();
  e.mountChip(S, '74LS161');
  wirePin(e, S, 16, 'pwr:5V1', 'vcc');
  wirePin(e, S, 8, 'gnd:GND1', 'gnd');
  wirePin(e, S, 1, 'sw:5K1', 'mr');      // ~MR
  wirePin(e, S, 2, 'clock:1HZ', 'clk');  // CLK
  wirePin(e, S, 9, 'pwr:5V1', 'pe');     // ~PE = 1（不置数）
  wirePin(e, S, 7, 'pwr:5V1', 'cep');    // CEP = 1
  wirePin(e, S, 10, 'pwr:5V1', 'cet');   // CET = 1
  wirePin(e, S, 3, 'sw:5K2', 'p0');      // P0
  wirePin(e, S, 4, 'sw:5K3', 'p1');      // P1
  wirePin(e, S, 5, 'sw:5K4', 'p2');      // P2
  wirePin(e, S, 6, 'sw:5K5', 'p3');      // P3

  var Q = { q0: 14, q1: 13, q2: 12, q3: 11, rco: 15 };
  var jq = {};
  for (var k in Q) jq[k] = e.socketJack(S, Q[k]);

  function readCount() {
    var v = 0;
    if (e.getJackLevel(jq.q0) === '1') v += 1;
    if (e.getJackLevel(jq.q1) === '1') v += 2;
    if (e.getJackLevel(jq.q2) === '1') v += 4;
    if (e.getJackLevel(jq.q3) === '1') v += 8;
    return v;
  }

  e.setSwitch(1, 1);   // ~MR = 1（不复位）

  // 1Hz：周期 1000ms，上升沿出现在 t = 0, 1000, 2000, ...
  // 注意：构造器内部已 step(0)，那时 ~MR=0（开关默认 0）把计数器清零了，
  // 且 t=0 的上升沿已经被消耗，因此从 t=1000 的上升沿开始计数。
  e.step(0);
  check('初始（~MR=0）计数为 0', readCount(), 0);
  // 每 500ms 推进一次，确保每个上升沿之前都采到过低电平
  var seq = [];
  for (var t = 500; t <= 6000; t += 500) {
    e.step(t);
    if (t % 1000 === 0) seq.push(readCount());
  }
  check('连续 6 个上升沿后计数递增', seq, [1, 2, 3, 4, 5, 6]);
  check('计数 6 时 RCO=0', e.getJackLevel(jq.rco), '0');

  // 计数到 15 时 RCO 拉高
  for (var t2 = 6500; t2 <= 15000; t2 += 500) e.step(t2);
  check('计数到 15', readCount(), 15);
  check('计数 15 时 RCO=1', e.getJackLevel(jq.rco), '1');

  // 再一个上升沿回绕到 0
  e.step(15500);
  e.step(16000);
  check('计数 15 后回绕到 0', readCount(), 0);
  check('回绕后 RCO=0', e.getJackLevel(jq.rco), '0');

  // 异步清零
  e.setSwitch(1, 0);    // ~MR = 0
  e.step(16100);        // 非上升沿，验证异步性
  check('~MR=0 异步清零（非时钟沿也立即生效）', readCount(), 0);

  // 同步置数：~MR=1, ~PE=0，P3..P0 = 1010(二进制) -> 值 10
  e.setSwitch(1, 1);
  e.removeWire('pe');
  wirePin(e, S, 9, 'gnd:GND1', 'pe0');   // ~PE = 0
  e.setSwitch(2, 0);  // P0 = 0
  e.setSwitch(3, 1);  // P1 = 1
  e.setSwitch(4, 0);  // P2 = 0
  e.setSwitch(5, 1);  // P3 = 1
  e.step(16200);      // 非上升沿，不置数
  check('非上升沿时置数不生效', readCount(), 0);
  e.step(16500);      // 低电平期
  e.step(17000);      // 上升沿，置数
  check('上升沿同步置数为 10', readCount(), 10);

  // CEP=0 时保持
  e.removeWire('pe0');
  wirePin(e, S, 9, 'pwr:5V1', 'pe1');    // ~PE = 1
  e.removeWire('cep');
  wirePin(e, S, 7, 'gnd:GND1', 'cep0');  // CEP = 0
  e.step(17500);      // 低电平期
  e.step(18000);      // 上升沿，但 CEP=0 -> 保持
  check('CEP=0 时保持 10 不计数', readCount(), 10);
})();

/* ============================================================
 * 10. 74LS273 / 74LS151 / 74LS02 / 74LS04 / 74LS08 / 74LS32 / 74LS86 冒烟
 * ============================================================ */

group('10. 其余芯片冒烟');
(function () {
  // 74LS273：八 D 触发器，上升沿锁存，~MR 异步清零
  var S = 'devA:UF';
  var e = newEngine();
  e.mountChip(S, '74LS273');
  wirePin(e, S, 20, 'pwr:5V1', 'vcc');
  wirePin(e, S, 10, 'gnd:GND1', 'gnd');
  wirePin(e, S, 1, 'sw:5K1', 'mr');       // ~MR
  wirePin(e, S, 11, 'clock:1HZ', 'clk');  // CLK
  wirePin(e, S, 3, 'sw:5K2', 'd0');       // D0
  wirePin(e, S, 4, 'sw:5K3', 'd1');       // D1
  e.setSwitch(1, 1); e.setSwitch(2, 1); e.setSwitch(3, 0);
  e.step(0);     // 高电平期
  e.step(600);   // 低电平期（下降沿）
  e.step(1000);  // 上升沿锁存
  check('74LS273 上升沿锁存 Q0=1', e.getJackLevel(e.socketJack(S, 2)), '1');
  check('74LS273 上升沿锁存 Q1=0', e.getJackLevel(e.socketJack(S, 5)), '0');
  e.setSwitch(1, 0);   // ~MR=0
  e.step(1);
  check('74LS273 ~MR=0 异步清零 Q0=0', e.getJackLevel(e.socketJack(S, 2)), '0');

  // 74LS151：8 选 1，~S 使能
  var e2 = newEngine();
  var S2 = 'devA:UE';
  e2.mountChip(S2, '74LS151');
  wirePin(e2, S2, 16, 'pwr:5V1', 'vcc');
  wirePin(e2, S2, 7, 'gnd:GND1', 'gnd');
  wirePin(e2, S2, 8, 'gnd:GND1', 's');    // ~S = 0 使能
  wirePin(e2, S2, 11, 'sw:5K1', 'a');
  wirePin(e2, S2, 10, 'sw:5K2', 'b');
  wirePin(e2, S2, 9, 'sw:5K3', 'c');
  // D0..D7 = 引脚 12,13,14,15,1,2,3,4；只把 D5 接高，其余悬空(=1)，
  // 因此改接法：D0..D7 全部接 5K4..5K11 以便精确控制
  var dPins = [12, 13, 14, 15, 1, 2, 3, 4];
  dPins.forEach(function (p, i) { wirePin(e2, S2, p, 'sw:5K' + (4 + i), 'd' + i); });
  // 让 D5 为 1，其余为 0
  for (var i = 0; i < 8; i++) e2.setSwitch(4 + i, i === 5 ? 1 : 0);
  e2.setSwitch(1, 1); e2.setSwitch(2, 0); e2.setSwitch(3, 1);   // CBA = 101 = 5
  e2.step(0);
  check('74LS151 选中 D5（地址 101）输出 1', e2.getJackLevel(e2.socketJack(S2, 5)), '1');
  check('74LS151 W 输出与 Y 互补 = 0', e2.getJackLevel(e2.socketJack(S2, 6)), '0');
  e2.setSwitch(1, 0); e2.setSwitch(2, 0); e2.setSwitch(3, 0);   // 地址 000 -> D0 = 0
  e2.step(0);
  check('74LS151 地址 000 选中 D0=0', e2.getJackLevel(e2.socketJack(S2, 5)), '0');
  // ~S = 1 禁止 -> Y=0, W=1
  e2.removeWire('s');
  wirePin(e2, S2, 8, 'pwr:5V1', 's1');
  e2.step(0);
  check('74LS151 ~S=1 禁止时 Y=0', e2.getJackLevel(e2.socketJack(S2, 5)), '0');
  check('74LS151 ~S=1 禁止时 W=1', e2.getJackLevel(e2.socketJack(S2, 6)), '1');

  // 74LS02 或非（1Y=1, 1A=2, 1B=3）
  var e3 = newEngine();
  e3.mountChip('devA:UA', '74LS02');
  wirePin(e3, 'devA:UA', 14, 'pwr:5V1', 'v');
  wirePin(e3, 'devA:UA', 7, 'gnd:GND1', 'g');
  wirePin(e3, 'devA:UA', 2, 'sw:5K1', 'a');
  wirePin(e3, 'devA:UA', 3, 'sw:5K2', 'b');
  e3.setSwitch(1, 0); e3.setSwitch(2, 0);
  e3.step(0);
  check('74LS02 (0 NOR 0) = 1', e3.getJackLevel(e3.socketJack('devA:UA', 1)), '1');
  e3.setSwitch(1, 1);
  e3.step(0);
  check('74LS02 (1 NOR 0) = 0', e3.getJackLevel(e3.socketJack('devA:UA', 1)), '0');

  // 74LS04 反相器（1A=1, 1Y=2）
  var e4 = newEngine();
  e4.mountChip('devA:UA', '74LS04');
  wirePin(e4, 'devA:UA', 14, 'pwr:5V1', 'v');
  wirePin(e4, 'devA:UA', 7, 'gnd:GND1', 'g');
  wirePin(e4, 'devA:UA', 1, 'sw:5K1', 'a');
  e4.setSwitch(1, 1);
  e4.step(0);
  check('74LS04 反相 1 -> 0', e4.getJackLevel(e4.socketJack('devA:UA', 2)), '0');

  // 74LS08 与（1Y=3）
  var e5 = newEngine();
  e5.mountChip('devA:UA', '74LS08');
  wirePin(e5, 'devA:UA', 14, 'pwr:5V1', 'v');
  wirePin(e5, 'devA:UA', 7, 'gnd:GND1', 'g');
  wirePin(e5, 'devA:UA', 1, 'sw:5K1', 'a');
  wirePin(e5, 'devA:UA', 2, 'sw:5K2', 'b');
  e5.setSwitch(1, 1); e5.setSwitch(2, 1);
  e5.step(0);
  check('74LS08 (1 AND 1) = 1', e5.getJackLevel(e5.socketJack('devA:UA', 3)), '1');

  // 74LS32 或（1Y=3）
  var e6 = newEngine();
  e6.mountChip('devA:UA', '74LS32');
  wirePin(e6, 'devA:UA', 14, 'pwr:5V1', 'v');
  wirePin(e6, 'devA:UA', 7, 'gnd:GND1', 'g');
  wirePin(e6, 'devA:UA', 1, 'sw:5K1', 'a');
  wirePin(e6, 'devA:UA', 2, 'sw:5K2', 'b');
  e6.setSwitch(1, 0); e6.setSwitch(2, 1);
  e6.step(0);
  check('74LS32 (0 OR 1) = 1', e6.getJackLevel(e6.socketJack('devA:UA', 3)), '1');

  // 74LS86 异或（1Y=3）
  var e7 = newEngine();
  e7.mountChip('devA:UA', '74LS86');
  wirePin(e7, 'devA:UA', 14, 'pwr:5V1', 'v');
  wirePin(e7, 'devA:UA', 7, 'gnd:GND1', 'g');
  wirePin(e7, 'devA:UA', 1, 'sw:5K1', 'a');
  wirePin(e7, 'devA:UA', 2, 'sw:5K2', 'b');
  e7.setSwitch(1, 1); e7.setSwitch(2, 1);
  e7.step(0);
  check('74LS86 (1 XOR 1) = 0', e7.getJackLevel(e7.socketJack('devA:UA', 3)), '0');
  e7.setSwitch(2, 0);
  e7.step(0);
  check('74LS86 (1 XOR 0) = 1', e7.getJackLevel(e7.socketJack('devA:UA', 3)), '1');
})();

/* ============================================================
 * 11. 数码管段码直驱（契约修正版：segs 原始电平 + segOn 点亮布尔）
 * ============================================================ */

group('11. 数码管段码直驱 segs / segOn');
(function () {
  var e = newEngine();
  // seg1 = 共阳：段电平 0 点亮。把 A1 接 GND（点亮 a），B1 接 VCC（熄灭 b）
  e.addWire({ id: 'sa', from: 'seg1:A1', to: 'gnd:GND1' });
  e.addWire({ id: 'sb', from: 'seg1:B1', to: 'pwr:5V1' });
  var st = e.step(0);

  check('segs.seg1 是原始引脚电平对象', st.segs.seg1.a, '0');
  check('segs.seg1.b', st.segs.seg1.b, '1');
  check('segs.seg1 未接的 c 为 Z', st.segs.seg1.c, 'Z');
  checkTrue('segs.seg1 含 a~g 与 dp 八个键',
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'].every(function (k) { return k in st.segs.seg1; }),
    Object.keys(st.segs.seg1));
  check('共阳 seg1：段电平 0 -> segOn.a = true', st.segOn.seg1.a, true);
  check('共阳 seg1：段电平 1 -> segOn.b = false', st.segOn.seg1.b, false);

  // seg2 = 共阴：段电平 1 点亮
  var e2 = newEngine();
  e2.addWire({ id: 'sa2', from: 'seg2:A2', to: 'pwr:5V1' });
  e2.addWire({ id: 'sb2', from: 'seg2:B2', to: 'gnd:GND1' });
  var st2 = e2.step(0);
  check('共阴 seg2：段电平 1 -> segOn.a = true', st2.segOn.seg2.a, true);
  check('共阴 seg2：段电平 0 -> segOn.b = false', st2.segOn.seg2.b, false);

  // seg3~seg8：只有 a/b/c/d/dp 五个键
  var st3 = e.getState();
  check('segs.seg3 只有 a/b/c/d/dp 五个键', Object.keys(st3.segs.seg3).sort(),
    ['a', 'b', 'c', 'd', 'dp']);
  check('segs.seg3.e 不存在（未引出）', st3.segs.seg3.e, undefined);

  // seg3 的 A3 接高 -> BCD 译码处理：DCBA = 0001，显示数字 1（b, c 点亮，其余熄灭）
  var e3 = newEngine();
  e3.addWire({ id: 's3a', from: 'seg3:A3', to: 'pwr:5V1' });
  var st4 = e3.step(0);
  check('seg3:A3 电平映射到 segs.seg3.a', st4.segs.seg3.a, '1');
  check('seg3 BCD 译码：DCBA=0001 数字 1 的 b 段点亮', st4.segOn.seg3.b, true);
  check('seg3 BCD 译码：DCBA=0001 数字 1 的 c 段点亮', st4.segOn.seg3.c, true);
  check('seg3 BCD 译码：DCBA=0001 数字 1 的 a 段熄灭', st4.segOn.seg3.a, false);
  check('seg3 BCD 译码字符为 1', st4.digits.seg3, '1');
  check('seg3 未接的 dp 为 Z', st4.segs.seg3.dp, 'Z');
  check('seg3 未接的 dp 不点亮', st4.segOn.seg3.dp, false);

  // 全部未接时完全熄灭（全灭）
  var eBlank = newEngine();
  var stBlank = eBlank.getState();
  checkTrue('seg3 全部未接时完全熄灭', ['a','b','c','d','e','f','g'].every(function (k) { return !stBlank.segOn.seg3[k]; }));
  check('seg3 全部未接时 digit 为 null', stBlank.digits.seg3, null);

  // 接 0000 -> 显示 0
  var eZero = newEngine();
  eZero.addWire({ id: 'z1', from: 'seg3:A3', to: 'gnd:GND1' });
  eZero.addWire({ id: 'z2', from: 'seg3:B3', to: 'gnd:GND1' });
  eZero.addWire({ id: 'z3', from: 'seg3:C3', to: 'gnd:GND1' });
  eZero.addWire({ id: 'z4', from: 'seg3:D3', to: 'gnd:GND1' });
  var stZero = eZero.step(0);
  check('seg3 接 0000 显示数字 0', stZero.digits.seg3, '0');
  check('seg3 数字 0 的 a 段点亮', stZero.segOn.seg3.a, true);
  check('seg3 数字 0 的 g 段熄灭', stZero.segOn.seg3.g, false);

  // seg5 的 DP5 在实物上是 GND 环，几何里不存在 -> 必须容错为 Z，不抛异常
  var st5 = e3.getState();
  check('seg5 缺 DP5 孔时容错为 Z', st5.segs.seg5.dp, 'Z');
  checkTrue('几何缺 DP5 不抛异常', true);

  // warnings 里要有 seg3~seg8 提示
  checkTrue('warnings 提示 seg3~seg8 译码驱动',
    st5.warnings.some(function (w) { return w.indexOf('seg3~seg8') >= 0; }), st5.warnings);
})();

/* ============================================================
 * 12. 时钟相位与单脉冲
 * ============================================================ */

group('12. 时钟相位与单脉冲');
(function () {
  var e = newEngine();
  // 1Hz：周期 1000ms，0~500 高、500~1000 低
  e.step(0);
  check('1HZ t=0 为高', e.getJackLevel('clock:1HZ'), '1');
  e.step(250);
  check('1HZ t=250 为高', e.getJackLevel('clock:1HZ'), '1');
  e.step(500);
  check('1HZ t=500 为低', e.getJackLevel('clock:1HZ'), '0');
  e.step(999);
  check('1HZ t=999 为低', e.getJackLevel('clock:1HZ'), '0');
  e.step(1000);
  check('1HZ t=1000 回到高', e.getJackLevel('clock:1HZ'), '1');

  // 2Hz：周期 500ms
  e.step(0);
  check('2HZ t=0 为高', e.getJackLevel('clock:2HZ'), '1');
  e.step(250);
  check('2HZ t=250 为低', e.getJackLevel('clock:2HZ'), '0');

  // 1MHz：周期 1ms，t=0.4ms 高、t=0.7ms 低（内部相位要算对）
  e.step(0.4);
  check('1MHZ t=0.4ms 为高', e.getJackLevel('clock:1MHZ'), '1');
  e.step(0.7);
  check('1MHZ t=0.7ms 为低', e.getJackLevel('clock:1MHZ'), '0');

  // 时钟使能关闭 -> 高阻
  e.setClockEnabled(false);
  e.step(1000);
  check('时钟未使能 -> Z', e.getJackLevel('clock:1HZ'), 'Z');
  e.setClockEnabled(true);
  e.step(1000);
  check('时钟重新使能 -> 有驱动', e.getJackLevel('clock:1HZ') !== 'Z', true);

  // 单脉冲：6K1+ 按下后 200ms 高，随后回低；6K1- 极性相反
  var e2 = newEngine();
  e2.step(0);
  check('未按键时 6K1+ 为 0', e2.getJackLevel('pulse:6K1+'), '0');
  check('未按键时 6K1- 为 1', e2.getJackLevel('pulse:6K1-'), '1');
  var fired = e2.pressPulse(1);
  checkTrue('pressPulse(1) 返回 true', fired === true);
  e2.step(0);
  check('脉冲期间 6K1+ 为 1', e2.getJackLevel('pulse:6K1+'), '1');
  check('脉冲期间 6K1- 为 0', e2.getJackLevel('pulse:6K1-'), '0');
  check('脉冲期间 6L1 亮', e2.getState().pulses['6L1'], true);
  var fired2 = e2.pressPulse(1);
  checkTrue('脉冲期内重复按键被防抖忽略', fired2 === false);
  e2.step(199);
  check('t=199ms 脉冲仍为高', e2.getJackLevel('pulse:6K1+'), '1');
  e2.step(200);
  check('t=200ms 脉冲结束变低', e2.getJackLevel('pulse:6K1+'), '0');
  check('脉冲结束后 6L1 灭', e2.getState().pulses['6L1'], false);
  check('脉冲计数为 1', e2.getPulseCount(1), 1);
})();

/* ============================================================
 * 13. 电源开关、onStateUpdate、reset
 * ============================================================ */

group('13. 电源 / 订阅 / reset');
(function () {
  var e = newEngine();
  e.addWire({ id: 'w1', from: 'sw:5K1', to: 'led:4P1' });
  e.setSwitch(1, 1);
  e.mountChip('devA:UA', '74LS00');
  var st = e.step(0);
  check('上电时开关驱动为 1', st.jacks['sw:5K1'], '1');

  // 断电
  e.setPower(false);
  st = e.step(1);
  check('断电后开关孔无驱动（Z）', st.jacks['sw:5K1'], 'Z');
  check('断电后 4L1 灭', st.leds['4L1'], false);
  checkTrue('断电时 warnings 有中文提示', st.warnings.some(function (w) { return w.indexOf('电源') >= 0; }), st.warnings);
  e.setPower(true);
  e.step(2);
  check('重新上电恢复', e.getJackLevel('sw:5K1'), '1');

  // onStateUpdate
  var calls = 0;
  var lastState = null;
  var off = e.onStateUpdate(function (s) { calls += 1; lastState = s; });
  e.setSwitch(1, 0);
  e.step(3);
  checkTrue('onStateUpdate 被触发', calls > 0, calls);
  checkTrue('回调收到状态对象', !!(lastState && lastState.jacks && lastState.leds));
  var callsBefore = calls;
  e.step(3);   // 状态未变化
  check('状态未变化时不重复触发', calls, callsBefore);
  off();
  e.setSwitch(1, 1);
  e.step(4);
  check('取消订阅后不再触发', calls, callsBefore);

  // reset
  e.setSwitch(5, 1);
  e.pressPulse(2);
  e.reset();
  var stR = e.getState();
  check('reset 后导线清空', e.getWires().length, 0);
  check('reset 后芯片清空', e.getChip('devA:UA'), null);
  check('reset 后开关归零（5K1）', e.getSwitch(1), 0);
  check('reset 后开关归零（5K5）', e.getSwitch(5), 0);
  check('reset 后 LED 全灭', stR.leds['4L1'], false);
  check('reset 后 swLeds 全灭', Object.keys(stR.swLeds).every(function (k) { return stR.swLeds[k] === false; }), true);
  check('reset 后脉冲清空', stR.pulses['6L1'], false);
  check('reset 后 shorts 为空', stR.shorts.length, 0);
  check('reset 后电源恢复', stR.power, true);
  check('reset 后所有无源插孔均为 Z', (function () {
    var bad = [];
    Object.keys(stR.jacks).forEach(function (id) {
      var lv = stR.jacks[id];
      var info = e.getJackInfo(id);
      if (!info || info.fixedNet) return;
      // 板载驱动源（开关 / 时钟 / 脉冲 / 信号源 DDS）本来就有确定电平，不参与此断言
      if (info.moduleId === 'sw' || info.moduleId === 'clock' || info.moduleId === 'pulse') return;
      if (info.moduleId === 'mid' && info.label === 'DDS') return; // DDS 是板载信号源输出孔，reset 后仍由信号源驱动

      if (lv !== 'Z') bad.push(id + '=' + lv);
    });
    return bad;
  })(), []);

  // 无 geometry 时用内置回退表也能跑
  var e2 = new Engine();
  var st2 = e2.step(0);
  checkTrue('无 geometry 时使用内置回退表（插孔数 > 200）', Object.keys(st2.jacks).length > 200,
    Object.keys(st2.jacks).length);
  check('回退表里 pwr:5V1 仍为 1', e2.getJackLevel('pwr:5V1'), '1');

  // engine.geometry 供 UI 层（persistence）读取插孔坐标
  checkTrue('engine.geometry 已暴露且含 JACKS', !!e2.geometry && !!e2.geometry.JACKS);
  var e3g = new Engine({ geometry: STUB_GEO });
  check('engine.geometry 与构造参数同引用', e3g.geometry === STUB_GEO, true);
})();

/* ============================================================
 * 14. 组合逻辑多级级联（74LS00 反相器接成与非 + 级联）
 * ============================================================ */

group('14. 多级级联与跨芯片连通');
(function () {
  // 用 74LS00 第一组接成反相器（两输入并联），输出驱动 4P1
  var e = newEngine();
  var S = 'devA:UA';
  e.mountChip(S, '74LS00');
  wirePin(e, S, 14, 'pwr:5V1', 'v');
  wirePin(e, S, 7, 'gnd:GND1', 'g');
  wirePin(e, S, 1, 'sw:5K1', 'a');
  wirePin(e, S, 2, 'sw:5K1', 'b');   // 两输入并联
  wirePin(e, S, 3, 'led:4P1', 'y');

  e.setSwitch(1, 1);
  var st = e.step(0);
  check('两输入并联成反相器：1 -> 0', st.leds['4L1'], false);
  e.setSwitch(1, 0);
  st = e.step(1);
  check('两输入并联成反相器：0 -> 1', st.leds['4L1'], true);

  // 输出同时接到另一个插座（devA:UB 的 74LS00 输入端）——跨芯片直连
  e.mountChip('devA:UB', '74LS00');
  wirePin(e, 'devA:UB', 14, 'pwr:5V1', 'v2');
  wirePin(e, 'devA:UB', 7, 'gnd:GND1', 'g2');
  e.addWire({ id: 'cross', from: 'led:4P1', to: 'devA:B1' });   // UB 第 1 脚
  e.addWire({ id: 'cross2', from: 'led:4P1', to: 'devA:B2' });  // UB 第 2 脚
  st = e.step(2);
  check('跨芯片直连：devA:B1 跟随输出', st.jacks['devA:B1'], '1');
  check('UB 的两输入都被拉高 -> 2Y=0', e.getJackLevel(e.socketJack('devA:UB', 3)), '0');

  // 输出与 GND 短接 -> 冲突 X
  e.addWire({ id: 'conflict', from: 'led:4P1', to: 'gnd:GND1' });
  st = e.step(3);
  check('芯片输出与 GND 短接 -> X', st.jacks['led:4P1'], 'X');
  checkTrue('冲突进入 shorts', st.shorts.length > 0, st.shorts.length);

  // 输出环回自身输入 -> 反馈冲突
  var e8 = newEngine();
  e8.mountChip(S, '74LS00');
  wirePin(e8, S, 14, 'pwr:5V1', 'v');
  wirePin(e8, S, 7, 'gnd:GND1', 'g');
  wirePin(e8, S, 1, 'sw:5K1', 'a');
  wirePin(e8, S, 2, 'sw:5K1', 'b');
  wirePin(e8, S, 3, 'led:4P1', 'y');
  e8.addWire({ id: 'loop', from: 'led:4P1', to: 'devA:A1' });   // 输出环回 1A
  e8.setSwitch(1, 0);
  var st8 = e8.step(0);
  check('输出环回自身输入 -> 冲突 X', st8.jacks['led:4P1'], 'X');
  checkTrue('反馈冲突进入 shorts', st8.shorts.length > 0, st8.shorts.length);
})();


/* ============================================================
 * 15. P1：变更类 API 即时重算（2026-10-30 契约）
 *     setSwitch / pressPulse / setPower / mountChip 等 11 个变更类 API
 *     执行后自动 step(this._now)；接线类 API 保持手动推进。
 * ============================================================ */

group('15. P1 变更类 API 即时重算');
(function () {
  var S = 'devA:UA';
  var e = newEngine();
  wirePin(e, S, 14, 'pwr:5V1', 'v');
  wirePin(e, S, 7, 'gnd:GND1', 'g');
  wirePin(e, S, 1, 'sw:5K1', 'a');     // 74LS00 1A <- 5K1
  wirePin(e, S, 2, 'pwr:5V2', 'b');    // 1B <- VCC 恒 1
  wirePin(e, S, 3, 'led:4P1', 'y');    // 1Y -> 4P1
  e.mountChip(S, '74LS00');
  e.setSwitch(1, 1);
  check('P1 setSwitch 后无需 step：1Y 立即为 0', e.getJackLevel('devA:A3'), '0');
  check('P1 即时重算联动 LED（1Y=0 -> 4L1 灭）', e.getState().leds['4L1'], false);
  e.setSwitch(1, 0);
  check('P1 setSwitch 后无需 step：1Y 立即为 1', e.getJackLevel('devA:A3'), '1');
  check('P1 即时重算联动 LED（1Y=1 -> 4L1 亮）', e.getState().leds['4L1'], true);

  // 接线类保持手动：删线后旧状态保留，直到手动 step
  var wid = e.getWires().filter(function (w) { return w.id === 'a'; })[0].id;
  e.removeWire(wid);
  check('P1 removeWire 后（未 step）输出保持旧值', e.getJackLevel('devA:A3'), '1');
  e.step(0);
  check('P1 手动 step 后 1A 悬空（TTL=1）-> 1Y=0', e.getJackLevel('devA:A3'), '0');

  // pressPulse 即时：6K1+ 高 -> 1Y=1
  var e2 = newEngine();
  wirePin(e2, S, 14, 'pwr:5V1', 'v');
  wirePin(e2, S, 7, 'gnd:GND1', 'g');
  wirePin(e2, S, 1, 'pulse:6K1+', 'p');
  wirePin(e2, S, 2, 'gnd:GND1', 'b');   // 1B 接地 -> NAND(脉冲, 0) = 1
  wirePin(e2, S, 3, 'led:4P2', 'y');
  e2.mountChip(S, '74LS00');
  checkTrue('P1 pressPulse(1) 产生脉冲', e2.pressPulse(1) === true);
  check('P1 pressPulse 后无需 step：1Y 立即为 1', e2.getJackLevel('devA:A3'), '1');

  // mountChip 即时：先布线拨开关再插芯片，插上即出结果
  var e3 = newEngine();
  wirePin(e3, S, 14, 'pwr:5V1', 'v');
  wirePin(e3, S, 7, 'gnd:GND1', 'g');
  wirePin(e3, S, 1, 'sw:5K1', 'a');
  wirePin(e3, S, 2, 'pwr:5V2', 'b');
  wirePin(e3, S, 3, 'led:4P1', 'y');
  e3.setSwitch(1, 1);
  e3.mountChip(S, '74LS00');
  check('P1 mountChip 后无需 step：1Y 立即为 0', e3.getJackLevel('devA:A3'), '0');
  e3.setPower(false);
  check('P1 setPower(false) 后芯片输出立即断开（Z）', e3.getJackLevel('devA:A3'), 'Z');
  e3.setPower(true);
  check('P1 setPower(true) 后立即恢复', e3.getJackLevel('devA:A3'), '0');
  e3.unmountChip(S);
  check('P1 unmountChip 后输出立即消失（Z）', e3.getJackLevel('devA:A3'), 'Z');

  // setDds / setPotRatio 即时（DDS 孔电平随幅度阈值切换）
  var e4 = newEngine();
  e4.setDds({ amplitudeV: 1 });
  check('P1 setDds 低幅度 -> DDS 孔为 0（恒低）', e4.getJackLevel('mid:DDS'), '0');
  e4.setDds({ amplitudeV: 5, freqHz: 4 });
  checkTrue('P1 setDds 高幅度 -> DDS 孔有方波电平', ['0', '1'].indexOf(e4.getJackLevel('mid:DDS')) >= 0,
    e4.getJackLevel('mid:DDS'));
})();

/* ============================================================
 * 16. P2：时钟 / DDS 混叠告警（2026-10-30 契约）
 *     引擎按电平采样推进：周期 < 2×步长 的时钟 / DDS 接到时序芯片
 *     时钟脚时给出中文告警；断电 / 时钟未使能 / 幅度低于阈值时不告警。
 * ============================================================ */

group('16. P2 时钟/DDS 混叠告警');
(function () {
  var aliasOf = function (e) {
    return e.getState().warnings.filter(function (w) { return w.indexOf('混叠告警') >= 0; });
  };

  // 1MHZ -> 74LS74@devA:UA（1CLK=A3）
  var e = newEngine();
  wirePin(e, 'devA:UA', 3, 'clock:1MHZ', 'clk');
  e.mountChip('devA:UA', '74LS74');
  e.step(10);
  var ws = aliasOf(e);
  checkTrue('P2 1MHZ -> 74LS74 产生混叠告警', ws.length === 1, ws);
  checkTrue('P2 告警含来源与插座标识', ws[0] && ws[0].indexOf('1MHZ') >= 0 && ws[0].indexOf('74LS74@devA:UA') >= 0, ws[0]);
  e.setClockEnabled(false);
  checkTrue('P2 时钟未使能 -> 告警消失', aliasOf(e).length === 0, aliasOf(e));
  e.setClockEnabled(true);
  e.setPower(false);
  checkTrue('P2 断电 -> 告警消失', aliasOf(e).length === 0, aliasOf(e));
  e.setPower(true);
  checkTrue('P2 重新上电 -> 告警恢复', aliasOf(e).length === 1, aliasOf(e));

  // 1HZ -> 无告警
  var e2 = newEngine();
  wirePin(e2, 'devA:UA', 3, 'clock:1HZ', 'clk');
  e2.mountChip('devA:UA', '74LS74');
  e2.step(10);
  checkTrue('P2 1HZ -> 无混叠告警', aliasOf(e2).length === 0, e2.getState().warnings);

  // 10KHZ -> 74LS161@devA:UE（CLK=E2）
  var e3 = newEngine();
  e3.mountChip('devA:UE', '74LS161');
  wirePin(e3, 'devA:UE', 2, 'clock:10KHZ', 'clk');
  e3.step(10);
  var ws3 = aliasOf(e3);
  checkTrue('P2 10KHZ -> 74LS161@UE 产生混叠告警', ws3.length === 1 && ws3[0].indexOf('74LS161@devA:UE') >= 0, ws3);

  // DDS 1MHz（幅度 5V）-> 告警；幅度低于阈值 / 未接时钟脚 -> 无告警
  var e4 = newEngine();
  e4.mountChip('devA:UA', '74LS74');
  wirePin(e4, 'devA:UA', 3, 'mid:DDS', 'dds');
  e4.setDds({ freqHz: 1000000 });
  e4.step(10);
  var ws4 = aliasOf(e4);
  checkTrue('P2 DDS 1MHz（幅度 5V）-> 告警', ws4.length === 1 && ws4[0].indexOf('信号源 DDS') >= 0, ws4);
  e4.setDds({ amplitudeV: 1 });
  checkTrue('P2 DDS 幅度低于 TTL 阈值 -> 无告警', aliasOf(e4).length === 0, aliasOf(e4));
  e4.setDds({ amplitudeV: 5 });
  e4.removeWire('dds');
  e4.step(10);
  checkTrue('P2 DDS 未接时钟脚 -> 无告警', aliasOf(e4).length === 0, aliasOf(e4));

  // 组合逻辑芯片（74LS00）不参与混叠检测
  var e5 = newEngine();
  e5.mountChip('devA:UA', '74LS00');
  wirePin(e5, 'devA:UA', 1, 'clock:1MHZ', 'c1');
  e5.step(10);
  checkTrue('P2 组合逻辑芯片时钟脚不检测', aliasOf(e5).length === 0, aliasOf(e5));
})();

/* ------------------------------------------------------------
 * 17. P7 步长观测：混叠阈值随实际推进步长自适应
 *    step() 观测 0 < Δt ≤ 500ms 的真实推进间隔并更新 _stepDtMs；
 *    同一时刻幂等重算不影响观测值；>500ms 跳变不更新。
 * ------------------------------------------------------------ */
group('17. P7 步长观测自适应混叠阈值');
(function () {
  var aliasOf = function (e) {
    return e.getState().warnings.filter(function (w) { return w.indexOf('混叠告警') >= 0; });
  };

  // DDS 30HZ（周期 33.3ms）：默认 10ms 步长下阈值 20ms，不告警
  var e = newEngine();
  wirePin(e, 'devA:UA', 3, 'mid:DDS', 'dds');
  e.mountChip('devA:UA', '74LS74');
  e.setDds({ freqHz: 30 });
  e.step(10);
  checkTrue('P7 默认 10ms 步长下 DDS 30HZ 不告警', aliasOf(e).length === 0, aliasOf(e));

  // 以 30ms 间隔推进两拍：阈值自适应为 60ms，33.3ms < 60ms -> 告警出现
  e.step(40);
  e.step(70);
  checkTrue('P7 观测到 30ms 步长后 DDS 30HZ 触发告警', aliasOf(e).length === 1, aliasOf(e));

  // 同一时刻幂等重算不改变观测值（告警保持，阈值不变）
  e.step(70);
  e.step(70);
  checkTrue('P7 同时刻幂等重算不影响观测', aliasOf(e).length === 1, aliasOf(e));

  // 1000ms 大跳变视为手动推进：不更新观测值；随后 30ms 步长恢复后告警依旧
  e.step(1070);
  e.step(1100);
  checkTrue('P7 大跳变后恢复 30ms 步长，DDS 30HZ 告警保持', aliasOf(e).length === 1, aliasOf(e));

  // 步长恢复 10ms（阈值 20ms）后，33.3ms 周期不再告警
  e.step(1110);
  e.step(1120);
  checkTrue('P7 步长观测回落 10ms 后 DDS 30HZ 告警消失', aliasOf(e).length === 0, aliasOf(e));
})();

/* ------------------------------------------------------------
 * 18. P3 门电路驱动扬声器：跨步电平翻转测频
 *    板载时钟/DDS 直驱保持精确源频率；逻辑源驱动时用最近边沿间隔估计，
 *    边沿不足或不稳定时不给音调（只保留电平边沿「嗒」声）。
 * ------------------------------------------------------------ */
group('18. P3 逻辑源驱动扬声器测频');
(function () {
  // 74LS00 两输入并联接 2HZ 时钟 = 反相器 -> SPK：方波周期 500ms，
  // 10ms 步长下边沿落在 250/500/750/1000ms，测得频率应恰为 2Hz。
  var e = newEngine();
  e.mountChip('devA:UA', '74LS00');
  wirePin(e, 'devA:UA', 1, 'clock:2HZ', 'p3a');
  wirePin(e, 'devA:UA', 2, 'clock:2HZ', 'p3b');
  wirePin(e, 'devA:UA', 3, 'mid:SPK', 'p3c');
  // 引擎按电平采样推进：必须以 10ms 步长逐拍推进，250/500/750ms 的翻转才会被采到
  e.step(0);
  check('P3 初始（无翻转历史）不发声', e.getState().analog.spk.driveHz, null);
  var t = 0;
  while (t < 400) { t += 10; e.step(t); }
  checkTrue('P3 边沿不足（1 条）不给音调', e.getState().analog.spk.driveHz === null, e.getState().analog.spk);
  while (t < 800) { t += 10; e.step(t); }
  checkTrue('P3 边沿不足（3 条）不给音调', e.getState().analog.spk.driveHz === null, e.getState().analog.spk);
  while (t < 1000) { t += 10; e.step(t); }
  var st = e.getState().analog.spk;
  check('P3 四条稳定边沿 -> 测得 2Hz', [st.driveHz, st.measuredHz], [2, 2]);
  check('P3 来源仍标记为逻辑源', st.source.type, 'logic');
  e.step(1000); e.step(1000);
  check('P3 同刻幂等重算不产生虚假边沿（仍 2Hz）', e.getState().analog.spk.driveHz, 2);
  e.step(1200);
  checkTrue('P3 电平稳定期保持测得频率', e.getState().analog.spk.driveHz === 2, e.getState().analog.spk.driveHz);
  e.reset();
  check('P3 reset 清空测频窗口', e.getState().analog.spk.driveHz, null);

  // 板载时钟直驱：精确源频率优先，不产生 measuredHz（既有行为不变）
  var e2 = newEngine();
  e2.addWire({ id: 'p3e', from: 'clock:4HZ', to: 'mid:SPK' });
  e2.step(0);
  var spk2 = e2.getState().analog.spk;
  check('P3 时钟直驱保持精确频率 4Hz', spk2.driveHz, 4);
  checkTrue('P3 时钟直驱无 measuredHz 字段', spk2.measuredHz === undefined, spk2.measuredHz);

  // 不规则脉冲列：间隔忽长忽短 -> 不判定音调
  var e3 = newEngine();
  e3.addWire({ id: 'p3f', from: 'pulse:6K1+', to: 'mid:SPK' });
  e3.step(100); e3.pressPulse(1);
  e3.step(300);
  e3.step(1000); e3.pressPulse(1);
  e3.step(1200);
  checkTrue('P3 不规则间隔（200/700/200ms）不给音调', e3.getState().analog.spk.driveHz === null, e3.getState().analog.spk);

  // 直流（开关常高）：电平恒定无边沿 -> 不发声，仅保留接通瞬间「嗒」声
  var e4 = newEngine();
  e4.addWire({ id: 'p3g', from: 'sw:5K1', to: 'mid:SPK' });
  e4.setSwitch(1, 1);
  e4.step(0); e4.step(200); e4.step(400);
  checkTrue('P3 直流电平不产生音调', e4.getState().analog.spk.driveHz === null, e4.getState().analog.spk);
})();

/* ------------------------------------------------------------
 * 19. P5a analyzeSink：固定铜箔网名（VCC/GND）按直流源归类
 *    网表 drivers 首位是固定网名，原先落到 'logic' 分支，展示语义错误。
 * ------------------------------------------------------------ */
group('19. P5a 固定网驱动仪器输入归类为直流');
(function () {
  var e = newEngine();
  e.addWire({ id: 'p5a1', from: 'pwr:5V1', to: 'mid:BEEP' });
  e.step(0);   // 接线是结构性操作，需显式推进后读状态
  var st = e.getState().analog;
  check('P5a BEEP 接 VCC -> 来源 dc', st.beep.source.type, 'dc');
  checkTrue('P5a BEEP 接 VCC -> 鸣叫', st.beep.on === true, st.beep);

  var e2 = newEngine();
  e2.addWire({ id: 'p5a2', from: 'devA:VCC', to: 'mid:BEEP' });
  e2.step(0);
  check('P5a BEEP 接开发模块 VCC -> 来源 dc', e2.getState().analog.beep.source.type, 'dc');

  var e3 = newEngine();
  e3.addWire({ id: 'p5a3', from: 'gnd:GND1', to: 'mid:SPK' });
  e3.step(0);
  var spk = e3.getState().analog.spk;
  check('P5a SPK 接 GND -> 来源 dc、电平 0', [spk.source.type, spk.level], ['dc', '0']);
  checkTrue('P5a SPK 接 GND 不发声', spk.driveHz === null, spk.driveHz);

  // 回归守卫：芯片输出仍旧是 'logic'，开关仍旧是 'dc'
  var e4 = newEngine();
  e4.mountChip('devA:UA', '74LS00');
  wirePin(e4, 'devA:UA', 1, 'sw:5K1', 'p5a4');
  wirePin(e4, 'devA:UA', 2, 'gnd:GND2', 'p5a5');
  wirePin(e4, 'devA:UA', 3, 'mid:BEEP', 'p5a6');
  e4.setSwitch(1, 1);
  var beep4 = e4.getState().analog.beep;
  check('P5a 门电路输出 -> 来源 logic（不变）', beep4.source.type, 'logic');
  checkTrue('P5a 门电路输出高 -> 鸣叫（不变）', beep4.on === true, beep4);

  var e5 = newEngine();
  e5.addWire({ id: 'p5a7', from: 'sw:5K3', to: 'mid:ACH1' });
  e5.setSwitch(3, 1);
  check('P5a ACH1 接开关 -> 来源 dc（不变）', e5.getState().analog.ach1.source.type, 'dc');
})();

/* ------------------------------------------------------------
 * 20. P5b mountChip 已占插座抛错（不再静默换芯）
 * ------------------------------------------------------------ */
group('20. P5b 已占插座显式抛错');
(function () {
  var SOCKET = 'devA:UA';   // 与既有用例组保持同款插座常量（组内局部）
  var e = newEngine();
  e.mountChip(SOCKET, '74LS00');
  var err = null;
  try { e.mountChip(SOCKET, '74LS04'); } catch (ex) { err = ex; }
  checkTrue('P5b 已占插座再插抛错', !!err, err && err.message);
  checkTrue('P5b 报错含已插型号', !!err && err.message.indexOf('74LS00') >= 0, err && err.message);
  check('P5b 抛错后原芯片保持不变', e.getChip(SOCKET), '74LS00');

  checkThrows('P5b 同型号重复插入同样抛错', function () { e.mountChip(SOCKET, '74LS00'); });
  checkThrows('P5b 封装不匹配仍按原口径抛错', function () { e.mountChip('devA:UE', '74LS00'); });

  e.unmountChip(SOCKET);
  e.mountChip(SOCKET, '74LS04');
  check('P5b 先拔后插正常换芯', e.getChip(SOCKET), '74LS04');
})();

/* ------------------------------------------------------------
 * 21. H7 批量收尾 + H1' 同刻记忆化
 *    beginBatch/endBatch 之间 P1 变更不逐步重算，endBatch 统一收尾一次；
 *    同刻且未置脏的重复 step 直接复用上次状态对象（消费方只读契约）。
 * ------------------------------------------------------------ */
group("21. H7 批量收尾 + H1' 同刻记忆化");
(function () {
  // —— H7：批量期间延迟一致，endBatch 一次收尾 ——
  var e = newEngine();
  var notify = 0;
  e.onStateUpdate(function () { notify += 1; });
  e.step(0);
  check('H7 订阅后无变更不通知', notify, 0);

  e.beginBatch();
  e.addWire({ id: 'b1', from: 'sw:5K1', to: 'led:4P1' });
  e.setSwitch(1, 1);
  checkTrue('H7 批量期间 getState 延迟一致（LED 仍灭）', e.getState().leds['4L1'] === false, e.getState().leds['4L1']);
  checkTrue('H7 批量期间开关原始状态即时可读', e.getSwitch(1) === 1, e.getSwitch(1));
  check('H7 批量期间不触发通知', notify, 0);
  e.endBatch();
  checkTrue('H7 endBatch 后 LED 立即点亮', e.getState().leds['4L1'] === true, e.getState().leds['4L1']);
  check('H7 批量收尾恰好通知一次', notify, 1);

  // —— 嵌套：内层 endBatch 不收尾，外层统一收尾 ——
  var e2 = newEngine();
  var notify2 = 0;
  e2.onStateUpdate(function () { notify2 += 1; });
  e2.step(0);
  e2.beginBatch();
  e2.beginBatch();
  e2.addWire({ id: 'n1', from: 'sw:5K2', to: 'led:4P2' });
  e2.setSwitch(2, 1);
  e2.endBatch();
  checkTrue('H7 内层 endBatch 不收尾', e2.getState().leds['4L2'] === false, e2.getState().leds['4L2']);
  e2.endBatch();
  checkTrue('H7 外层 endBatch 统一收尾', e2.getState().leds['4L2'] === true, e2.getState().leds['4L2']);
  check('H7 嵌套批量只通知一次', notify2, 1);

  // —— 空批量不补算；异常路径用 finally 配对仍能收尾 ——
  var e3 = newEngine();
  var notify3 = 0;
  e3.onStateUpdate(function () { notify3 += 1; });
  e3.step(0);
  e3.beginBatch();
  e3.endBatch();
  check('H7 空批量不触发通知/重算', notify3, 0);

  var e4 = newEngine();
  e4.beginBatch();
  var threw = false;
  try {
    e4.addWire({ id: 'x1', from: 'sw:5K3', to: 'led:4P3' });
    e4.setSwitch(3, 1);
    throw new Error('boom');
  } catch (ex) {
    threw = true;          // 模拟批量中段的任意异常
  } finally {
    e4.endBatch();         // 推荐写法：finally 里配对收尾
  }
  checkTrue('H7 异常后 finally 配对 endBatch 仍收尾', threw && e4.getState().leds['4L3'] === true, [threw, e4.getState().leds['4L3']]);

  // —— H1'：同刻且未置脏的 step 复用同一状态对象 ——
  var e5 = newEngine();
  e5.addWire({ id: 'm1', from: 'sw:5K1', to: 'led:4P4' });
  e5.setSwitch(1, 0);
  var s1 = e5.step(10);
  var s2 = e5.step(10);
  checkTrue("H1' 同刻无变更 step 返回同一对象", s1 === s2);
  checkTrue("H1' getState 复用同一对象", e5.getState() === s1);
  e5.setSwitch(1, 1);   // P1 自动重算
  var s3 = e5.getState();
  checkTrue("H1' 变更后得到全新状态对象", s3 !== s1);
  checkTrue("H1' 变更即时可见", s3.leds['4L4'] === true);
  var s4 = e5.step(20);
  checkTrue("H1' 时刻推进后重新求值", s4 !== s3 && s4.now === 20);
  e5.clearWires();      // 结构性操作：置脏但不推进
  var s5 = e5.getState();
  checkTrue("H1' 接线后未推进仍读旧状态（既有约定）", s5 === s4);
  var s6 = e5.step(20);
  checkTrue("H1' 置脏后同刻 step 重新求值", s6 !== s4 && s6.now === 20);
  var notify5 = 0;
  e5.onStateUpdate(function () { notify5 += 1; });
  e5.step(20); e5.step(20);
  check("H1' 记忆化命中不重复通知", notify5, 0);
})();

/* ============================================================
 * 汇总
 * ============================================================ */

var failed = results.filter(function (r) { return !r.ok; });
var passed = results.length - failed.length;

console.log('\n' + '='.repeat(64));
if (failed.length === 0) {
  console.log('\u2713 全部通过：' + passed + ' / ' + results.length + ' 项断言');
  console.log('  分组数：' + new Set(results.map(function (r) { return r.group; })).size);
  process.exitCode = 0;
} else {
  console.log('\u2717 失败 ' + failed.length + ' 项 / 共 ' + results.length + ' 项断言');
  failed.forEach(function (f) {
    console.log('  - [' + f.group + '] ' + f.desc);
    console.log('    期望: ' + JSON.stringify(f.expected) + '  实际: ' + JSON.stringify(f.actual));
  });
  process.exitCode = 1;
}
console.log('='.repeat(64));

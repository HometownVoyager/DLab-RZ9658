#!/usr/bin/env node
// tests/timeline.selftest.cjs
// DLab.Timeline（时序控制面板 / 虚拟时间轴）零依赖自测：node tests/timeline.selftest.cjs
// 覆盖：初始态、运行/暂停、速度三档与钳制、单步、累加器换算、200 拍上限、
//       复位时间、快照字段、时钟使能与脉冲透传、推进函数注入、DOM 适配层降级，
//       以及与 74LS74 的端到端联调（虚拟时钟真的能驱动上升沿触发器）。
// 2026-10-30 遗留项收尾新增：12 H6 帧预算推进（STEP_BUDGET_MS / 积压封顶 / 禁用口径）。
'use strict';

var path = require('path');

// ---- 按契约加载核心模块（经典脚本 + 全局命名空间）----
globalThis.DLab = {};
require(path.join(__dirname, '..', 'src', 'core', 'logic.js'));
require(path.join(__dirname, '..', 'src', 'core', 'chips.js'));
require(path.join(__dirname, '..', 'src', 'core', 'engine.js'));
require(path.join(__dirname, '..', 'src', 'ui', 'timeline.js'));

var DLab = globalThis.DLab;
var Engine = DLab.Engine;
var Timeline = DLab.Timeline;

/* ============================================================
 * 极简断言框架（与 tests/engine.selftest.cjs 同款）
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
 *   只造够用的插孔：电源、地、开关、时钟、脉冲、LED、A/B 两个开发模块。
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
  add('pwr', '5V1', 'power', 'VCC');
  add('pwr', '5V2', 'power', 'VCC');
  add('gnd', 'GND1', 'ground', 'GND');
  add('gnd', 'GND2', 'ground', 'GND');

  for (i = 1; i <= 16; i++) add('sw', '5K' + i, 'driver');

  ['1HZ', '2HZ', '4HZ', '8HZ', '1KHZ', '10KHZ', '1MHZ', 'CONT'].forEach(function (c) {
    add('clock', c, 'driver');
  });

  for (i = 1; i <= 6; i++) {
    add('pulse', '6K' + i + '-', 'driver');
    add('pulse', '6K' + i + '+', 'driver');
  }

  for (i = 1; i <= 16; i++) add('led', '4P' + i, 'sink');

  ['devA', 'devB'].forEach(function (m) {
    for (i = 1; i <= 14; i++) add(m, 'A' + i, 'passive');
    for (i = 1; i <= 14; i++) add(m, 'B' + i, 'passive');
    for (i = 1; i <= 16; i++) add(m, 'E' + i, 'passive');
    for (i = 1; i <= 16; i++) add(m, 'D' + i, 'passive');
    for (i = 1; i <= 20; i++) add(m, 'F' + i, 'passive');
    add(m, 'VCC', 'power', 'VCC');
    add(m, 'GND', 'ground', 'GND');
  });

  return { VIEWBOX: { width: 1800, height: 1380 }, JACKS: jacks, JACK_ORDER: order, MODULES: [] };
}

var STUB_GEO = buildStubGeometry();

function newEngine() {
  return new Engine({ geometry: STUB_GEO });
}

/** 建一个「无容器、无 DOM」的 Timeline，最接近纯逻辑测试环境。
 *  默认禁用 H6 帧预算（frameBudgetMs: 0）：既有断言对「每帧拍数」有精确期望，
 *  真实引擎在慢机器上可能触发 7ms 预算导致抖动；帧预算行为由专门用例组覆盖。 */
function newTimeline(engine, extra) {
  var opts = { engine: engine || newEngine(), frameBudgetMs: 0 };
  if (extra) {
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) opts[k] = extra[k];
    }
  }
  return new Timeline(opts);
}

/* ============================================================
 * 1. 模块加载与静态常量
 * ============================================================ */

group('1. 模块加载与静态常量');
checkTrue('DLab.Timeline 已挂载', typeof Timeline === 'function');
check('一个逻辑拍 = 10ms 虚拟时间', Timeline.STEP_MS, 10);
check('每帧最多 200 拍', Timeline.MAX_STEPS_PER_FRAME, 200);
check('速度三档 1 / 10 / 100', Timeline.SPEED_STEPS, [1, 10, 100]);
check('默认速度 1 倍', Timeline.DEFAULT_SPEED, 1);
check('速度范围 1 ~ 1000', [Timeline.MIN_SPEED, Timeline.MAX_SPEED], [1, 1000]);
checkThrows('缺少 engine 时构造抛错', function () {
  new Timeline({});
});
check('Node 环境（无 document）DOM 适配层不可用', Timeline.DomAdapter.available(), false);

/* ============================================================
 * 2. 初始态
 * ============================================================ */

group('2. 初始态');

(function () {
  var eng = newEngine();
  var tl = newTimeline(eng);

  check('初始未运行', tl.isRunning(), false);
  check('初始速度 1 倍', tl.getSpeed(), 1);
  check('初始虚拟时间 0', tl.getVirtualTime(), 0);
  check('初始拍数 0', tl.getSnapshot().steps, 0);
  check('初始未接管时钟', tl.isOwner(), false);
  check('初始时钟使能（引擎默认 true）', tl.isClockEnabled(), true);
  check('getSnapshot 字段集合', Object.keys(tl.getSnapshot()).sort(),
    ['clockEnabled', 'running', 'speed', 'steps', 'virtualTime']);
  check('无 DOM 时不创建控件节点', tl._nodes, null);
  // 未运行时即便喂 delta 也不推进
  check('未运行时 _tickWithDelta 返回 0', tl._tickWithDelta(1000), 0);
  check('未运行时虚拟时间不动', tl.getVirtualTime(), 0);
})();

/* ============================================================
 * 3. 运行态、启动 / 停止与所有权
 * ============================================================ */

group('3. 运行态与所有权');

(function () {
  var eng = newEngine();
  var tl = newTimeline(eng);

  check('setRunning(true) 返回 true', tl.setRunning(true), true);
  check('isRunning() 为 true', tl.isRunning(), true);
  check('首次运行会自动 start() 并接管', tl.isOwner(), true);
  check('重复 setRunning(true) 幂等', tl.setRunning(true), true);

  check('toggleRunning() 切到暂停', tl.toggleRunning(), false);
  check('暂停后 isRunning() 为 false', tl.isRunning(), false);
  check('暂停后仍持有所有权（循环还在跑）', tl.isOwner(), true);

  tl.setRunning(true);
  tl._tickWithDelta(30);
  var afterRun = tl.getVirtualTime();
  checkTrue('运行态下喂 30ms 会推进 3 拍', afterRun === 30, afterRun);

  tl.stop();
  check('stop() 后 isRunning() 为 false', tl.isRunning(), false);
  check('stop() 后交出所有权', tl.isOwner(), false);
  check('stop() 后 _tickWithDelta 返回 0', tl._tickWithDelta(1000), 0);
  check('stop() 后虚拟时间不再增长', tl.getVirtualTime(), afterRun);

  // 再次 start 可以恢复
  tl.start();
  check('重新 start() 后恢复所有权', tl.isOwner(), true);
  tl.setRunning(true);
  check('重新运行后可以继续推进', tl._tickWithDelta(10) > 0, true);
})();

/* ============================================================
 * 4. 速度设置与钳制
 * ============================================================ */

group('4. 速度设置与钳制');

(function () {
  var tl = newTimeline(newEngine());

  check('setSpeed(10) 生效', tl.setSpeed(10), 10);
  check('getSpeed() 同步', tl.getSpeed(), 10);
  check('setSpeed(100) 生效', tl.setSpeed(100), 100);
  check('setSpeed(1) 生效', tl.setSpeed(1), 1);

  tl.setSpeed(10);
  check('setSpeed(0) 非法被忽略', tl.setSpeed(0), 10);
  check('setSpeed(NaN) 非法被忽略', tl.setSpeed(NaN), 10);
  check('setSpeed(-3) 非法被忽略', tl.setSpeed(-3), 10);
  check('setSpeed("abc") 非法被忽略', tl.setSpeed('abc'), 10);

  check('超上限钳制到 1000', tl.setSpeed(5000), 1000);
  check('低于下限钳制到 1', tl.setSpeed(0.2), 1);

  // 速度确实影响推进倍率
  var eng = newEngine();
  var fast = newTimeline(eng);
  fast.setRunning(true);
  fast.setSpeed(10);
  check('10 倍速下 25ms 真实时间推进 25 拍', fast._tickWithDelta(25), 25);
  check('10 倍速下虚拟时间 = 250ms', fast.getVirtualTime(), 250);
})();

/* ============================================================
 * 5. 单步与复位时间
 * ============================================================ */

group('5. 单步与复位时间');

(function () {
  var eng = newEngine();
  var tl = newTimeline(eng);
  var calls = [];
  tl.onState = function (state) { calls.push(state); };

  check('暂停态也能单步：返回 10ms', tl.stepOnce(), 10);
  check('单步后虚拟时间 10ms', tl.getVirtualTime(), 10);
  check('单步后拍数 1', tl.getSnapshot().steps, 1);
  check('单步真的推进了引擎（now=10）', eng.getState().now, 10);
  check('单步触发一次 onState', calls.length, 1);
  checkTrue('onState 收到的是引擎状态对象', !!(calls[0] && calls[0].jacks && calls[0].now === 10));

  tl.stepOnce();
  check('第二次单步虚拟时间 20ms', tl.getVirtualTime(), 20);
  check('第二次单步引擎 now=20', eng.getState().now, 20);
  check('第二次单步拍数 2', tl.getSnapshot().steps, 2);

  // 单步会清空累加器，避免下一帧补拍
  tl.setRunning(true);
  tl._tickWithDelta(5);          // acc = 5，不够一拍
  tl.stepOnce();                 // 单步清空 acc
  check('单步清空累加器', tl.acc, 0);

  var reset = tl.resetTime();
  check('resetTime() 返回 0', reset, 0);
  check('复位后虚拟时间 0', tl.getVirtualTime(), 0);
  check('复位后拍数归零', tl.getSnapshot().steps, 0);
  check('复位后引擎 now=0', eng.getState().now, 0);
  check('复位不清运行态（仍在运行）', tl.isRunning(), true);
})();

/* ============================================================
 * 6. 累加器换算：真实毫秒 x 速度 -> 逻辑拍
 * ============================================================ */

group('6. 累加器换算');

(function () {
  var tl = newTimeline(newEngine());
  tl.setRunning(true);
  tl.setSpeed(1);

  check('1 倍速 25ms -> 2 拍', tl._tickWithDelta(25), 2);
  check('虚拟时间 20ms', tl.getVirtualTime(), 20);
  check('余下 5ms 留在累加器', tl.acc, 5);

  check('再来 5ms -> 补满 1 拍', tl._tickWithDelta(5), 1);
  check('虚拟时间 30ms', tl.getVirtualTime(), 30);
  check('累加器清零', tl.acc, 0);

  check('不足一拍（9ms）-> 0 拍', tl._tickWithDelta(9), 0);
  check('虚拟时间不变', tl.getVirtualTime(), 30);

  check('delta=0 -> 0 拍', tl._tickWithDelta(0), 0);
  check('delta 为 NaN -> 0 拍', tl._tickWithDelta(NaN), 0);
  check('delta 为负 -> 0 拍', tl._tickWithDelta(-5), 0);
  check('非法 delta 不污染累加器', tl.acc, 9);

  // 100 倍速：10ms 真实时间 = 1000ms 虚拟时间 = 100 拍
  var fast = newTimeline(newEngine());
  fast.setRunning(true);
  fast.setSpeed(100);
  check('100 倍速 10ms -> 100 拍', fast._tickWithDelta(10), 100);
  check('100 倍速下虚拟时间 1000ms', fast.getVirtualTime(), 1000);
  check('100 倍速下拍数 100', fast.getSnapshot().steps, 100);
})();

/* ============================================================
 * 7. 每帧 200 拍上限（防卡死）
 * ============================================================ */

group('7. 每帧 200 拍上限');

(function () {
  var tl = newTimeline(newEngine());
  tl.setRunning(true);
  tl.setSpeed(1);

  var ticks = tl._tickWithDelta(100000);   // 理论 10000 拍，必须被截断到 200
  check('超大 delta 被截断到 200 拍', ticks, 200);
  check('虚拟时间只前进 2000ms', tl.getVirtualTime(), 2000);
  check('拍数只增加 200', tl.getSnapshot().steps, 200);
  check('触顶后累加器被清空', tl.acc, 0);

  check('触顶后下一帧仍能正常推进', tl._tickWithDelta(20), 2);
  check('触顶后虚拟时间 2020ms', tl.getVirtualTime(), 2020);

  // 100 倍速下也受同一上限约束
  var fast = newTimeline(newEngine());
  fast.setRunning(true);
  fast.setSpeed(100);
  check('100 倍速下同样截断到 200 拍', fast._tickWithDelta(1000), 200);
})();

/* ============================================================
 * 8. 推进函数注入与时间戳正确性
 * ============================================================ */

group('8. 推进函数注入与时间戳');

(function () {
  var eng = newEngine();
  var tl = newTimeline(eng);
  var seen = [];

  tl.setEngineStepper(function (virtualMs) { seen.push(virtualMs); });
  tl.setRunning(true);
  tl.setSpeed(1);
  tl._tickWithDelta(30);

  check('注入的推进函数收到 3 次调用', seen.length, 3);
  check('传入的是虚拟时间戳', seen, [10, 20, 30]);
  check('最后一次时间戳 = getVirtualTime()', seen[seen.length - 1], tl.getVirtualTime());
  checkTrue('时间戳严格单调递增', seen[0] < seen[1] && seen[1] < seen[2]);
  check('注入推进函数后引擎未被推进（now 仍为 0）', eng.getState().now, 0);

  // 传 null 恢复默认：直接调用 engine.step
  var stepper = tl.setEngineStepper(null);
  checkTrue('setEngineStepper(null) 恢复默认推进函数', typeof stepper === 'function');
  tl._tickWithDelta(10);
  check('恢复默认后引擎收到虚拟时间', eng.getState().now, 40);
  check('getEngineStepper() 可读回', typeof tl.getEngineStepper(), 'function');

  // 推进函数抛错不应打断循环
  var bad = newTimeline(newEngine());
  bad.setEngineStepper(function () { throw new Error('模拟引擎异常'); });
  bad.setRunning(true);
  var t2 = bad._tickWithDelta(20);
  check('推进函数抛错时仍计数 2 拍', t2, 2);
  checkTrue('异常被记录到 getLastError()', !!bad.getLastError());
  check('异常不影响虚拟时间累加', bad.getVirtualTime(), 20);
})();

/* ============================================================
 * 9. 时钟使能与单脉冲透传
 * ============================================================ */

group('9. 时钟使能与单脉冲透传');

(function () {
  var eng = newEngine();
  var tl = newTimeline(eng);

  check('关闭时钟使能返回 false', tl.setClockEnabled(false), false);
  check('isClockEnabled() 同步为 false', tl.isClockEnabled(), false);
  check('透传到引擎 setClockEnabled', eng.getClockEnabled(), false);
  check('快照里的 clockEnabled 同步', tl.getSnapshot().clockEnabled, false);

  check('重新打开返回 true', tl.setClockEnabled(true), true);
  check('引擎侧同步恢复', eng.getClockEnabled(), true);

  // 时钟未使能 -> 时钟插孔高阻；使能后 -> 有 0/1 电平
  eng.step(0);
  check('使能后 1HZ 时钟孔有电平', eng.getState().jacks['clock:1HZ'], '1');
  tl.setClockEnabled(false);
  eng.step(0);
  check('关闭后 1HZ 时钟孔呈高阻', eng.getState().jacks['clock:1HZ'], 'Z');

  // 单脉冲透传：虚拟时间在脉冲窗口内
  var eng2 = newEngine();
  var tl2 = newTimeline(eng2);
  tl2.setClockEnabled(true);
  check('pressPulse(1) 透传返回 true', tl2.pressPulse(1), true);
  checkTrue('脉冲在虚拟时间窗口内有效', eng2.isPulseActive(1));
  check('pressPulse 计数递增', eng2.getPulseCount(1), 1);
  check('未知脉冲键透传抛错', (function () {
    try { tl2.pressPulse(99); return 'no-throw'; } catch (e) { return 'throw'; }
  })(), 'throw');
})();

/* ============================================================
 * 10. DOM 适配层（无浏览器环境下的降级与可注入性）
 * ============================================================ */

group('10. DOM 适配层');

/** 极简假 DOM：足够让 _build / refresh 跑通，不依赖 jsdom */
function makeFakeDom() {
  function FakeNode(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.className = '';
    this.textContent = '';
    this.checked = false;
    var self = this;
    this.classList = {
      add: function () {},
      remove: function () {},
      toggle: function () {}
    };
    this._classes = {};
    this.addEventListener = function () {};
    this.style = {};
  }
  FakeNode.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
  FakeNode.prototype.getAttribute = function (k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  };
  FakeNode.prototype.appendChild = function (node) { this.children.push(node); return node; };

  return {
    available: function () { return true; },
    create: function (tag, attrs, text) {
      var node = new FakeNode(tag);
      if (attrs) {
        for (var k in attrs) {
          if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
          if (k === 'className') node.className = attrs[k];
          else if (k === 'text') node.textContent = attrs[k];
          else node.setAttribute(k, attrs[k]);
        }
      }
      if (text !== undefined && text !== null) node.textContent = text;
      return node;
    },
    on: function () { return true; }
  };
}

(function () {
  var FakeDom = makeFakeDom();
  var container = FakeDom.create('div');
  var tl = newTimeline(newEngine(), { container: container, dom: FakeDom });

  checkTrue('注入适配层后成功构建控件', !!tl._nodes);
  check('运行按钮初始文字为「运行」', tl._nodes.runBtn.textContent, '运行');
  check('单步按钮文字', tl._nodes.stepBtn.textContent, '单步');
  check('复位按钮文字', tl._nodes.resetBtn.textContent, '复位时间');
  check('速度按钮三档', tl._nodes.speedBtns.map(function (b) { return b.textContent; }), ['1x', '10x', '100x']);
  check('初始速度档高亮 1x', tl._nodes.speedBtns[0].getAttribute('aria-pressed'), 'true');
  check('非当前速度档不高亮', tl._nodes.speedBtns[1].getAttribute('aria-pressed'), 'false');
  check('虚拟时间读数 0.00 s', tl._nodes.timeEl.textContent, '0.00 s');
  check('时钟勾选框与引擎一致', tl._nodes.clockInput.checked, true);

  tl.stepOnce();
  check('单步后读数更新为 0.01 s', tl._nodes.timeEl.textContent, '0.01 s');

  tl.setRunning(true);
  check('运行后按钮文字变「暂停」', tl._nodes.runBtn.textContent, '暂停');
  check('运行按钮 aria-pressed', tl._nodes.runBtn.getAttribute('aria-pressed'), 'true');

  tl.setSpeed(100);
  check('切换速度后 100x 高亮', tl._nodes.speedBtns[2].getAttribute('aria-pressed'), 'true');
  check('原 1x 取消高亮', tl._nodes.speedBtns[0].getAttribute('aria-pressed'), 'false');

  tl.setClockEnabled(false);
  check('关闭时钟后勾选框同步', tl._nodes.clockInput.checked, false);

  tl.stop();
  check('停止后按钮回到「运行」', tl._nodes.runBtn.textContent, '运行');
})();

/* ============================================================
 * 11. 与引擎联调：虚拟时钟真的能驱动 74LS74 上升沿
 * ============================================================ */

group('11. 联调：虚拟时钟驱动 74LS74');

(function () {
  var eng = newEngine();
  eng.mountChip('devA:UA', '74LS74');
  function pin(n) { return eng.socketJack('devA:UA', n); }

  eng.addWire({ id: 'vcc', from: pin(14), to: 'pwr:5V1' });
  eng.addWire({ id: 'gnd', from: pin(7), to: 'gnd:GND1' });
  eng.addWire({ id: 'd', from: pin(2), to: 'pwr:5V1' });      // 1D = 1
  eng.addWire({ id: 'clk', from: pin(3), to: 'clock:1HZ' });  // 1CLK = 1Hz 时钟
  eng.addWire({ id: 'pre', from: pin(4), to: 'pwr:5V1' });    // ~1PRE 无效
  eng.addWire({ id: 'clr', from: pin(1), to: 'pwr:5V1' });    // ~1CLR 无效
  eng.addWire({ id: 'q', from: pin(5), to: 'led:4P1' });      // 1Q -> 4L1

  var tl = newTimeline(eng, {
    onState: function (state) { tl.lastState = state; }
  });
  tl.resetTime();

  check('t=0 时 1Hz 时钟为高电平', eng.getState().jacks['clock:1HZ'], '1');
  check('t=0 尚未出现上升沿，Q=0', eng.getState().leds['4L1'], false);

  // 单步推进到 990ms：时钟仍在低电平区，Q 应保持 0
  var guard = 0;
  while (tl.getVirtualTime() < 990 && guard < 500) { tl.stepOnce(); guard++; }
  check('990ms 时虚拟时间正确', tl.getVirtualTime(), 990);
  check('990ms 时 1Hz 时钟为低电平', eng.getState().jacks['clock:1HZ'], '0');
  check('990ms 时 Q 仍为 0', eng.getState().leds['4L1'], false);

  // 再走一拍到 1000ms：时钟回到高电平，出现上升沿
  tl.stepOnce();
  check('1000ms 时虚拟时间正确', tl.getVirtualTime(), 1000);
  check('1000ms 时 1Hz 时钟回到高电平', eng.getState().jacks['clock:1HZ'], '1');
  check('1000ms 上升沿采样 D=1，Q 翻转为 1', eng.getState().leds['4L1'], true);
  check('引擎 now 与虚拟时间一致', eng.getState().now, 1000);
  checkTrue('onState 回调收到状态', !!(tl.lastState && tl.lastState.leds));

  // 用累加器推进（模拟 rAF）也应产生同样的效果
  var eng2 = newEngine();
  eng2.mountChip('devA:UB', '74LS74');
  function pin2(n) { return eng2.socketJack('devA:UB', n); }
  eng2.addWire({ id: 'v2', from: pin2(14), to: 'pwr:5V1' });
  eng2.addWire({ id: 'g2', from: pin2(7), to: 'gnd:GND1' });
  eng2.addWire({ id: 'd2', from: pin2(2), to: 'pwr:5V1' });
  eng2.addWire({ id: 'c2', from: pin2(3), to: 'clock:1HZ' });
  eng2.addWire({ id: 'p2', from: pin2(4), to: 'pwr:5V1' });
  eng2.addWire({ id: 'r2', from: pin2(1), to: 'pwr:5V1' });
  eng2.addWire({ id: 'q2', from: pin2(5), to: 'led:4P2' });

  var tl2 = newTimeline(eng2);
  tl2.resetTime();
  tl2.setRunning(true);
  tl2.setSpeed(1);
  // 每帧 16.7ms（约 60fps），累计推进到 1000ms 之后
  var frames = 0;
  while (tl2.getVirtualTime() < 1010 && frames < 200) { tl2._tickWithDelta(16.7); frames++; }
  checkTrue('按 60fps 累加 1 秒后虚拟时间超过 1000ms', tl2.getVirtualTime() >= 1000, tl2.getVirtualTime());
  check('rAF 方式推进同样得到 Q=1', eng2.getState().leds['4L2'], true);
  check('rAF 方式推进拍数与虚拟时间一致', tl2.getSnapshot().steps * 10, tl2.getVirtualTime());
})();

/* ============================================================
 * 12. 引擎侧推进函数钩子（setEngineStepper）同步
 * ============================================================ */

group('12. 引擎侧推进函数钩子');

/** 带 setEngineStepper 钩子的假引擎，用来验证 Timeline 的注入 / 撤销时机 */
function makeHookEngine() {
  var hooks = [];
  return {
    step: function () {},
    getState: function () { return { jacks: {}, now: 0 }; },
    setEngineStepper: function (fn) { hooks.push(fn); },
    hooks: hooks
  };
}

(function () {
  var eng = makeHookEngine();
  var tl = new Timeline({ engine: eng });

  check('构造阶段不注入钩子', eng.hooks.length, 0);

  tl.start();
  check('start() 后注入一次推进函数', eng.hooks.length, 1);
  checkTrue('注入的是函数', typeof eng.hooks[0] === 'function');

  tl.stop();
  check('stop() 后再注入一次（传 null 表示撤销）', eng.hooks.length, 2);
  check('stop() 传入的是 null', eng.hooks[1], null);

  // 接管期间替换推进函数，应立即同步给引擎
  tl.start();
  var before = eng.hooks.length;
  var custom = function () {};
  tl.setEngineStepper(custom);
  check('接管期间替换推进函数会同步给引擎', eng.hooks.length, before + 1);
  check('同步过去的正是新函数', eng.hooks[eng.hooks.length - 1], custom);

  // 未接管时替换不打扰引擎
  tl.stop();
  var afterStop = eng.hooks.length;
  tl.setEngineStepper(null);
  check('未接管时替换推进函数不触碰引擎', eng.hooks.length, afterStop);

  // 引擎没有钩子方法时不得抛错
  var plain = { step: function () {}, getState: function () { return { jacks: {} }; } };
  var tl2 = new Timeline({ engine: plain });
  var threw = false;
  try {
    tl2.start();
    tl2.setRunning(true);
    tl2._tickWithDelta(20);
    tl2.stop();
  } catch (e) {
    threw = true;
  }
  checkTrue('引擎无 setEngineStepper 时 start/stop 不抛错', !threw);

  // 引擎 step 被外部补丁包装后，Timeline 仍应推进到原始方法（防「补丁拦自己」）
  var realEngine = newEngine();
  var rawStep = realEngine.step;
  var rawCalls = 0;
  var tl4 = new Timeline({ engine: realEngine });
  check('构造时记录了引擎原始 step', typeof tl4.getOriginalStep(), 'function');
  check('getOriginalStep 返回的就是原始方法', tl4.getOriginalStep(), rawStep);

  // 模拟 app.js 的接管补丁：Interaction 循环若仍按真实时间调用 engine.step，就让它空转
  realEngine.step = function (nowMs) {
    rawCalls += 1;
    return rawStep.call(this, nowMs);
  };
  tl4.setRunning(true);
  tl4._tickWithDelta(30);
  check('引擎 step 被外部补丁包装后 Timeline 仍推进 3 拍', tl4.getSnapshot().steps, 3);
  check('Timeline 绕开补丁、直接驱动原始 step（补丁调用 0 次）', rawCalls, 0);
  check('原始 step 收到的是虚拟时间', realEngine.getState().now, 30);
  check('虚拟时间与引擎 now 保持一致', tl4.getVirtualTime(), 30);

  // 反向确认：外部补丁本身仍然可用（Lead 用它拦 Interaction 的按真实时间推进）
  realEngine.step(999);
  check('外部补丁自身仍然生效', rawCalls, 1);
  check('补丁透传后引擎 now 更新', realEngine.getState().now, 999);
  tl4.stop();

  // 引擎缺 setClockEnabled / getClockEnabled 时也不得抛错
  var tl3 = new Timeline({ engine: { step: function () {}, getState: function () { return { jacks: {} }; } } });
  check('缺 getClockEnabled 时返回 false', tl3.isClockEnabled(), false);
  check('缺 setClockEnabled 时 setClockEnabled 不抛错并返回 false', tl3.setClockEnabled(true), false);
  check('缺 pressPulse 时返回 false', tl3.pressPulse(1), false);
})();

/* ============================================================
 * 12. H6 帧预算推进（2026-10-30 性能审查遗留项）
 *     单帧给 step 的真实时间预算：预算耗尽把积压留给后续帧（封顶防无界滞后）；
 *     0 = 禁用预算（既有 200 拍兜底行为，其余用例组都在禁用态下跑）。
 * ============================================================ */

group('12. H6 帧预算推进');

(function () {
  check('H6 帧预算常量导出', [Timeline.STEP_BUDGET_MS, Timeline.MAX_BACKLOG_MS], [7, 2000]);
  var defTl = new Timeline({ engine: newEngine() });
  check('默认构造启用帧预算（7ms）', defTl.frameBudgetMs, Timeline.STEP_BUDGET_MS);
  checkTrue('本套件 helper 默认禁用预算（保证既有拍数断言确定性）', newTimeline(newEngine()).frameBudgetMs === 0);

  // 慢推进函数：每次调用忙等 ~2ms，用于稳定触发预算
  function slowStepper() {
    return function () {
      var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      while (now - t0 < 2) {
        now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      }
    };
  }

  // 预算 3ms + 每拍 2ms：第 1 拍无条件推进，第 2 拍 2ms<3ms 推进，第 3 拍 4ms≥3ms 触顶
  var tl = newTimeline(newEngine(), { frameBudgetMs: 3 });
  tl.setRunning(true);
  tl.setEngineStepper(slowStepper());
  var ticks = tl._tickWithDelta(200);   // 理论 20 拍
  check('H6 预算内只推进 2 拍（每拍约 2ms）', ticks, 2);
  check('H6 虚拟时间与拍数一致', tl.getVirtualTime(), 20);
  checkTrue('H6 剩余积压保留给后续帧（不丢弃）', tl.acc > 0, tl.acc);
  var ticks2 = tl._tickWithDelta(0);    // delta=0：继续消化积压
  checkTrue('H6 下一帧继续按预算消化积压', ticks2 >= 1 && ticks2 <= 2, ticks2);
  checkTrue('H6 虚拟时间持续推进', tl.getVirtualTime() > 20, tl.getVirtualTime());

  // 积压封顶：预算趋近 0（每帧只推 1 拍）+ 超大 delta → acc 被钳到 MAX_BACKLOG_MS
  var tl2 = newTimeline(newEngine(), { frameBudgetMs: 0.0001 });
  tl2.setRunning(true);
  tl2.setEngineStepper(function () {});
  var t3 = tl2._tickWithDelta(100000);  // 理论 10000 拍
  check('H6 预算极小时每帧仍至少推进 1 拍', t3, 1);
  check('H6 积压被钳到 MAX_BACKLOG_MS', tl2.acc, Timeline.MAX_BACKLOG_MS);
  var total = t3;
  for (var f = 0; f < 5; f++) total += tl2._tickWithDelta(0);
  checkTrue('H6 积压分帧消化（远小于理论 10000 拍）', total < 200, total);

  // 禁用预算（frameBudgetMs: 0）：维持既有 200 拍兜底行为
  var tl3 = newTimeline(newEngine(), { frameBudgetMs: 0 });
  tl3.setRunning(true);
  var t4 = tl3._tickWithDelta(100000);
  check('H6 禁用预算时维持 200 拍兜底', t4, 200);
  check('H6 禁用预算时触顶清空累加器', tl3.acc, 0);
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

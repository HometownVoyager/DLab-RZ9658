#!/usr/bin/env node
// tests/instruments.selftest.cjs
// 板载仪器零依赖自测：node tests/instruments.selftest.cjs
// 覆盖：逻辑笔判读模式（TTL/CMOS 与悬空表现）、信号源 DDS 参数钳制与 1-2-5 步进、
//       DDS 输出波形与幅度阈值、电位器分压模型、BEEP/SPK/ACH1 信号源分析、
//       仪器纯函数（频率格式化 / 编码器角度 / 读数 / 锚点反推）、
//       持久化往返（probeMode / dds / potRatio，含非法值降级）、UI 模块 Node 可加载性。
'use strict';

var path = require('path');

// ---- 按契约加载核心与 UI 模块（经典脚本 + 全局命名空间；UI 模块加载不得触碰 DOM）----
globalThis.DLab = {};
require(path.join(__dirname, '..', 'src', 'core', 'logic.js'));
require(path.join(__dirname, '..', 'src', 'core', 'chips.js'));
require(path.join(__dirname, '..', 'src', 'core', 'engine.js'));
require(path.join(__dirname, '..', 'src', 'ui', 'persistence.js'));
require(path.join(__dirname, '..', 'src', 'ui', 'sound.js'));
require(path.join(__dirname, '..', 'src', 'ui', 'instruments.js'));
require(path.join(__dirname, '..', 'src', 'ui', 'tapFeedback.js'));

var DLab = globalThis.DLab;
var Engine = DLab.Engine;

/* ============================================================
 * 极简断言框架（与 engine.selftest.cjs 同风格）
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

/** 浮点近似比较（角度 / 电压用） */
function checkClose(desc, actual, expected, eps) {
  var tol = eps === undefined ? 1e-6 : eps;
  var ok = typeof actual === 'number' && Math.abs(actual - expected) <= tol;
  results.push({ group: currentGroup, desc: desc, ok: ok, actual: actual, expected: expected + '±' + tol });
  if (ok) {
    console.log('  \u2713 ' + desc);
  } else {
    console.log('  \u2717 ' + desc);
    console.log('      期望: ' + expected + '±' + tol);
    console.log('      实际: ' + actual);
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
 * 测试用精简几何桩（与 engine.selftest.cjs 同思路）
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
    for (i = 1; i <= 20; i++) add(m, 'F' + i, 'passive');
    add(m, 'VCC', 'power', 'VCC');
    add(m, 'GND', 'ground', 'GND');
  });

  add('probe', 'P01', 'driver');
  add('rc', '1', 'passive'); add('rc', '2', 'passive'); add('rc', '3', 'passive');
  add('mid', 'SPK', 'sink'); add('mid', 'BEEP', 'sink');
  add('mid', 'ACH1', 'sink'); add('mid', 'DDS', 'sink');

  return { VIEWBOX: { width: 1800, height: 1380 }, JACKS: jacks, JACK_ORDER: order, MODULES: [] };
}

var STUB_GEO = buildStubGeometry();
DLab.geometry = STUB_GEO;      // persistence.geometryOf 的兜底数据源

function newEngine() {
  return new Engine({ geometry: STUB_GEO });
}

function wire(engine, from, to, id) {
  engine.addWire({ id: id || ('w' + from + '_' + to), from: from, to: to });
}

/** 把 a 与 b 之间的既有导线删掉（不管方向） */
function unwire(engine, a, b) {
  var wires = engine.getWires().slice();
  for (var i = 0; i < wires.length; i++) {
    var w = wires[i];
    if ((w.from === a && w.to === b) || (w.from === b && w.to === a)) {
      engine.removeWire(w.id);
    }
  }
}

/* ============================================================
 * 1. 模块加载与纯函数
 * ============================================================ */

group('1. 模块加载与仪器纯函数');
checkTrue('DLab.Engine 已挂载', typeof Engine === 'function');
checkTrue('DLab.Persistence 已挂载', !!DLab.Persistence);
checkTrue('DLab.Sound 已挂载（Node 下为静默实现）', !!DLab.Sound);
checkTrue('DLab.Instruments 已挂载', !!DLab.Instruments);
checkTrue('DLab.TapFeedback 已挂载', !!DLab.TapFeedback);
check('formatFreq(1)', DLab.Instruments.formatFreq(1), '1Hz');
check('formatFreq(1000)', DLab.Instruments.formatFreq(1000), '1.000kHz');
check('formatFreq(1234567)', DLab.Instruments.formatFreq(1234567), '1.235MHz');
check('formatFreq(0)', DLab.Instruments.formatFreq(0), '—');
check('waveName(square/pulse)', [DLab.Instruments.waveName('square'), DLab.Instruments.waveName('pulse')], ['方波', '脉冲']);
checkClose('ddsAngle：1Hz 在最左端', DLab.Instruments.ddsAngle({ sel: 'freq', freqHz: 1, amplitudeV: 5, waveform: 'square' }), -120);
checkClose('ddsAngle：1MHz 在最右端', DLab.Instruments.ddsAngle({ sel: 'freq', freqHz: 1000000, amplitudeV: 5, waveform: 'square' }), 120, 1e-6);
checkClose('ddsAngle：1kHz 居中', DLab.Instruments.ddsAngle({ sel: 'freq', freqHz: 1000, amplitudeV: 5, waveform: 'square' }), 0, 1e-6);
checkClose('ddsAngle：幅度 5V 满量程', DLab.Instruments.ddsAngle({ sel: 'amp', freqHz: 1000, amplitudeV: 5, waveform: 'square' }), 120);
checkClose('ddsAngle：波形 方波刻度', DLab.Instruments.ddsAngle({ sel: 'wave', freqHz: 1000, amplitudeV: 5, waveform: 'square' }), -60);
checkClose('ddsAngle：波形 脉冲刻度', DLab.Instruments.ddsAngle({ sel: 'wave', freqHz: 1000, amplitudeV: 5, waveform: 'pulse' }), 60);
check('ddsReadoutText', DLab.Instruments.ddsReadoutText({ freqHz: 1000, amplitudeV: 5, waveform: 'square' }), '1.000kHz · 5.0V · 方波');

// 锚点反推：插孔与仪器外观的相对偏移必须与 SVG.SVG 一致
var anchors = DLab.Instruments.deriveAnchors(STUB_GEO);
var spk = STUB_GEO.JACKS['mid:SPK'];
var rc2 = STUB_GEO.JACKS['rc:2'];
var p01 = STUB_GEO.JACKS['probe:P01'];
check('SW1 开关体 = P01 + (117,-8)', [anchors.sw1.x - p01.x, anchors.sw1.y - p01.y], [117, -8]);
check('编码器 = SPK + (46,372)', [anchors.encoder.x - spk.x, anchors.encoder.y - spk.y], [46, 372]);
check('蜂鸣器 = SPK + (82,92)', [anchors.buzzer.x - spk.x, anchors.buzzer.y - spk.y], [82, 92]);
check('示波器矩形 = SPK + (-26,130)', [anchors.scopeRect.x - spk.x, anchors.scopeRect.y - spk.y], [-26, 130]);
check('电位器指针轴心 = rc:2 + (-4,32)', [anchors.potPivot.x - rc2.x, anchors.potPivot.y - rc2.y], [-4, 32]);

// 构造函数在 Node（无 DOM）下必须可用：只保留 engine 联动，跳过覆盖层
var nodeInst = null;
var nodeTap = null;
checkTrue('Instruments 构造不依赖 DOM', (function () {
  try { nodeInst = new DLab.Instruments({ engine: newEngine() }); return !!nodeInst; } catch (e) { return e; }
})());
checkTrue('TapFeedback 构造不依赖 DOM', (function () {
  try { nodeTap = new DLab.TapFeedback({ engine: newEngine() }); return !!nodeTap; } catch (e) { return e; }
})());

/* ============================================================
 * 2. 逻辑笔判读模式
 * ============================================================ */

group('2. 逻辑笔判读模式');
(function () {
  var eng = newEngine();
  wire(eng, 'sw:5K1', 'probe:P01', 'w-probe');

  eng.setSwitch(1, 1);
  check('开关高电平 → 显示 H', eng.step(0).probe.display, 'H');
  eng.setSwitch(1, 0);
  check('开关低电平 → 显示 L', eng.step(0).probe.display, 'L');

  eng.removeWire('w-probe');
  check('悬空 + TTL → 浮高显示 H', eng.step(0).probe.display, 'H');
  eng.toggleProbeMode();
  check('toggleProbeMode TTL→CMOS', eng.getProbeMode(), 'CMOS');
  check('悬空 + CMOS → 显示高阻 Z', eng.step(0).probe.display, 'Z');
  eng.toggleProbeMode();
  check('toggleProbeMode CMOS→TTL', eng.getProbeMode(), 'TTL');
  eng.setProbeMode('cmos');
  check('setProbeMode 大小写归一', eng.getProbeMode(), 'CMOS');
  checkThrows('setProbeMode 非法值抛错', function () { eng.setProbeMode('LSB'); });
  eng.setProbeMode('TTL');
})();

/* ============================================================
 * 3. 信号源 DDS：参数钳制 / 步进 / 波形 / 阈值
 * ============================================================ */

group('3. 信号源 DDS');
(function () {
  var eng = newEngine();
  check('DDS 默认参数', eng.getDds(), { freqHz: 1000, amplitudeV: 5, waveform: 'square', sel: 'freq' });

  checkThrows('频率 0 抛错', function () { eng.setDds({ freqHz: 0 }); });
  checkThrows('频率负数抛错', function () { eng.setDds({ freqHz: -5 }); });
  checkThrows('波形 sine 抛错（本型只有方波/脉冲）', function () { eng.setDds({ waveform: 'sine' }); });
  checkThrows('编码器选择非法抛错', function () { eng.setDds({ sel: 'amp2' }); });

  check('频率上钳 1MHz', eng.setDds({ freqHz: 5e6 }).freqHz, 1000000);
  check('频率下钳 1Hz', eng.setDds({ freqHz: 0.5 }).freqHz, 1);
  check('幅度上钳 5V', eng.setDds({ amplitudeV: 9 }).amplitudeV, 5);
  check('幅度下钳 0V', eng.setDds({ amplitudeV: -1 }).amplitudeV, 0);

  eng.setDds({ sel: 'freq' });
  check('编码器循环 freq→amp', eng.cycleDdsParam(), 'amp');
  check('编码器循环 amp→wave', eng.cycleDdsParam(), 'wave');
  check('编码器循环 wave→freq', eng.cycleDdsParam(), 'freq');

  eng.setDds({ freqHz: 1000, sel: 'freq' });
  check('频率步进 1000→2000（1-2-5）', eng.adjustDds(1).freqHz, 2000);
  check('频率步进 2000→5000', eng.adjustDds(1).freqHz, 5000);
  check('频率步进回落 5000→2000', eng.adjustDds(-1).freqHz, 2000);
  check('频率步进回落 2000→1000', eng.adjustDds(-1).freqHz, 1000);
  check('频率步进回落 1000→500', eng.adjustDds(-1).freqHz, 500);
  eng.setDds({ freqHz: 1000000 });
  check('1MHz 再加不变', eng.adjustDds(1).freqHz, 1000000);
  eng.setDds({ freqHz: 1 });
  check('1Hz 再减不变', eng.adjustDds(-1).freqHz, 1);

  eng.setDds({ sel: 'amp', amplitudeV: 2.5 });
  check('幅度步进 2.5→3.0', eng.adjustDds(1).amplitudeV, 3);
  eng.setDds({ amplitudeV: 5 });
  check('幅度 5V 再加不变', eng.adjustDds(1).amplitudeV, 5);
  eng.setDds({ amplitudeV: 0 });
  check('幅度 0V 再减不变', eng.adjustDds(-1).amplitudeV, 0);

  eng.setDds({ sel: 'wave', waveform: 'square' });
  check('波形切换 delta=0 方波→脉冲', eng.adjustDds(0).waveform, 'pulse');
  check('波形切换 delta=0 脉冲→方波', eng.adjustDds(0).waveform, 'square');
  check('波形 delta>0 → 脉冲', eng.adjustDds(1).waveform, 'pulse');
  check('波形 delta<0 → 方波', eng.adjustDds(-1).waveform, 'square');

  // —— 输出孔电平（幅度阈值 + 相位）——
  wire(eng, 'mid:DDS', 'led:4P1', 'w-dds');
  eng.setDds({ freqHz: 1000, amplitudeV: 2, waveform: 'square' });
  check('幅度 2V 低于阈值 → 恒为低（t=100ms）', eng.step(100).leds['4L1'], false);
  check('幅度 2V 低于阈值 → 恒为低（t=100.9ms）', eng.step(100.9).leds['4L1'], false);
  var warnText = eng.step(100).warnings.join('|');
  checkTrue('幅度低于阈值时出现中文告警', warnText.indexOf('低于 TTL 阈值') >= 0, warnText);

  eng.setDds({ amplitudeV: 5, waveform: 'square' });
  check('方波 1kHz t=100ms（相位 0）→ 高', eng.step(100).leds['4L1'], true);
  check('方波 1kHz t=100.6ms（相位 0.6ms）→ 低', eng.step(100.6).leds['4L1'], false);
  eng.setDds({ waveform: 'pulse' });
  check('脉冲 1kHz t=100.05ms（脉宽 0.1ms）→ 高', eng.step(100.05).leds['4L1'], true);
  check('脉冲 1kHz t=100.5ms → 低', eng.step(100.5).leds['4L1'], false);

  // DDS 独立于时钟使能
  eng.setClockEnabled(false);
  check('时钟使能关闭不影响 DDS 输出（t=100ms 相位 0 → 高）', eng.step(100).leds['4L1'], true);
  eng.setClockEnabled(true);
})();

/* ============================================================
 * 4. 电位器分压模型
 * ============================================================ */

group('4. 电位器分压');
(function () {
  var eng = newEngine();
  wire(eng, 'pwr:5V1', 'rc:1', 'w-p1');
  wire(eng, 'gnd:GND1', 'rc:3', 'w-p3');
  var rc2Level = function () { return eng.step(0).jacks['rc:2']; };
  var potVolts = function () {
    var st = eng.step(0);               // 先推进再读，避免拿到 setPotRatio 之前的缓存状态
    var v = st.pot.volts;
    return (v === null || v === undefined) ? null : Math.round(v * 1000) / 1000;
  };

  eng.setPotRatio(0);
  check('ratio 0（滑到 1 脚端）→ 5V / 电平 1', [potVolts(), rc2Level()], [5, '1']);
  eng.setPotRatio(1);
  check('ratio 1（滑到 3 脚端）→ 0V / 电平 0', [potVolts(), rc2Level()], [0, '0']);
  eng.setPotRatio(0.4);
  check('ratio 0.4 → 3V / 电平 1', [potVolts(), rc2Level()], [3, '1']);
  eng.setPotRatio(0.5);
  check('ratio 0.5 → 2.5V（达到阈值判 1）', [potVolts(), rc2Level()], [2.5, '1']);
  eng.setPotRatio(0.51);
  check('ratio 0.51 → 2.45V（低于阈值判 0）', [potVolts(), rc2Level()], [2.45, '0']);
  check('setPotRatio 上钳 1', eng.setPotRatio(1.5), 1);
  check('setPotRatio 下钳 0', eng.setPotRatio(-0.2), 0);
  checkThrows('setPotRatio 非法抛错', function () { eng.setPotRatio('abc'); });

  // 单端供电：滑动端跟随供电端（负载按高阻，轨道无电流）
  eng.setPotRatio(0.2);
  eng.removeWire('w-p3');
  check('只接 1 脚 5V → 滑动端跟随 5V', [potVolts(), rc2Level()], [5, '1']);
  eng.removeWire('w-p1');
  wire(eng, 'gnd:GND1', 'rc:3', 'w-p3b');
  check('只接 3 脚 GND → 滑动端 0V', [potVolts(), rc2Level()], [0, '0']);

  // 两端都悬空：不驱动
  eng.removeWire('w-p3b');
  check('两端悬空 → volts null / 电平 Z', [potVolts(), rc2Level()], [null, 'Z']);
})();

/* ============================================================
 * 5. BEEP / SPK / ACH1 信号源分析
 * ============================================================ */

group('5. 板载音频与示波器信号分析');
(function () {
  var eng = newEngine();

  // —— 蜂鸣器：直流（开关）驱动 ——
  wire(eng, 'sw:5K2', 'mid:BEEP', 'w-b1');
  eng.setSwitch(2, 1);
  var st = eng.step(0);
  check('BEEP 接开关高电平 → beep.on', st.analog.beep.on, true);
  check('BEEP 驱动来源标记为直流', st.analog.beep.source.type, 'dc');
  eng.setSwitch(2, 0);
  check('BEEP 开关低电平 → 不鸣', eng.step(0).analog.beep.on, false);

  // —— 蜂鸣器：时钟驱动（2Hz，周期 500ms）——
  eng.removeWire('w-b1');
  wire(eng, 'clock:2HZ', 'mid:BEEP', 'w-b2');
  check('BEEP 接 2Hz 时钟 t=0 → 鸣', eng.step(0).analog.beep.on, true);
  check('BEEP 2Hz t=300ms（相位 300>250）→ 停', eng.step(300).analog.beep.on, false);
  check('BEEP 2Hz t=600ms（相位 100<250）→ 鸣', eng.step(600).analog.beep.on, true);
  st = eng.step(0);
  check('BEEP 时钟来源带频率', [st.analog.beep.source.type, st.analog.beep.source.freqHz], ['clock', 2]);

  // —— 功放扬声器：只有交流源给 driveHz ——
  wire(eng, 'clock:1KHZ', 'mid:SPK', 'w-s1');
  check('SPK 接 1kHz 时钟 → driveHz 1000', eng.step(0).analog.spk.driveHz, 1000);
  eng.removeWire('w-s1');
  wire(eng, 'sw:5K3', 'mid:SPK', 'w-s2');
  check('SPK 接直流开关 → driveHz null（只嗒一声）', eng.step(0).analog.spk.driveHz, null);

  // —— 示波器 ACH1 ——
  eng.removeWire('w-s2');
  wire(eng, 'clock:1KHZ', 'mid:ACH1', 'w-a1');
  st = eng.step(0);
  check('ACH1 接时钟 → 波形 square', st.analog.ach1.wave, 'square');
  check('ACH1 时钟来源频率 1000', st.analog.ach1.source.freqHz, 1000);

  eng.removeWire('w-a1');
  wire(eng, 'sw:5K3', 'mid:ACH1', 'w-a2');
  eng.setSwitch(3, 1);
  st = eng.step(0);
  check('ACH1 接直流高 → 波形 dc / 电平 1', [st.analog.ach1.wave, st.analog.ach1.level], ['dc', '1']);
  eng.setSwitch(3, 0);
  st = eng.step(0);
  check('ACH1 接直流低 → 波形 dc / 电平 0', [st.analog.ach1.wave, st.analog.ach1.level], ['dc', '0']);

  eng.removeWire('w-a2');
  check('ACH1 悬空 → 无信号', eng.step(0).analog.ach1.wave, 'none');

  wire(eng, 'mid:DDS', 'mid:ACH1', 'w-a3');
  eng.setDds({ freqHz: 100, amplitudeV: 5, waveform: 'pulse' });
  check('ACH1 接 DDS 脉冲 → 波形 pulse', eng.step(0).analog.ach1.wave, 'pulse');
  eng.setDds({ amplitudeV: 2 });
  st = eng.step(0);
  check('DDS 幅度低于阈值 → ACH1 按直流低显示', [st.analog.ach1.wave, st.analog.ach1.level], ['dc', '0']);

  // —— 状态指纹：只调参数也要通知订阅者 ——
  eng.setDds({ amplitudeV: 5 });
  eng.step(0);
  var sig1 = String(eng._lastSignature);
  eng.setDds({ freqHz: 2000 });
  eng.step(0);
  var sig2 = String(eng._lastSignature);
  checkTrue('指纹包含 DDS 频率（调频后指纹变化）', sig1 !== sig2 && sig2.indexOf(':2000:') >= 0, sig2);
})();

/* ============================================================
 * 6. 持久化：仪器字段往返
 * ============================================================ */

group('6. 持久化往返（probeMode / dds / potRatio）');
(function () {
  var eng1 = newEngine();
  eng1.setProbeMode('CMOS');
  eng1.setDds({ freqHz: 4400, amplitudeV: 3, waveform: 'pulse', sel: 'amp' });
  eng1.setPotRatio(0.75);

  var built = DLab.Persistence.buildProject(eng1);
  check('buildProject 顶字段', [built.probeMode, built.potRatio, built.dds.freqHz, built.dds.waveform],
    ['CMOS', 0.75, 4400, 'pulse']);

  var raw = JSON.parse(JSON.stringify(built));
  var eng2 = newEngine();
  var checked = DLab.Persistence.validateProject(raw, eng2);
  checkTrue('校验通过', checked.ok, checked.message);
  DLab.Persistence.applyProject(checked.project, eng2, []);
  check('逻辑笔模式恢复', eng2.getProbeMode(), 'CMOS');
  check('信号源恢复', eng2.getDds(), { freqHz: 4400, amplitudeV: 3, waveform: 'pulse', sel: 'amp' });
  check('电位器恢复', eng2.getPotRatio(), 0.75);

  // 非法值：不阻断导入，逐项降级为警告
  raw.probeMode = 'LSB';
  raw.dds = { freqHz: -3, amplitudeV: 99, waveform: 'sine', sel: 'zzz' };
  raw.potRatio = 'abc';
  var checked2 = DLab.Persistence.validateProject(raw, eng2);
  checkTrue('非法仪器字段仍校验通过', checked2.ok, checked2.message);
  checkTrue('每个非法字段都有警告', checked2.instrumentWarnings.length >= 4, checked2.instrumentWarnings);
  check('非法幅度钳到 5V', checked2.project.instruments.dds.amplitudeV, 5);
  checkTrue('合法字段保留（无 freqHz 时整个 dds 忽略，波形/选择被丢）',
    checked2.project.instruments.dds.freqHz === undefined &&
    checked2.project.instruments.dds.waveform === undefined,
    checked2.project.instruments.dds);

  // 旧版本文件（无仪器字段）：照常导入
  var eng3 = newEngine();
  var oldRaw = { format: 'dlab-project', version: 1, power: true, switches: {}, chips: {}, wires: [] };
  var checked3 = DLab.Persistence.validateProject(oldRaw, eng3);
  checkTrue('旧文件校验通过', checked3.ok, checked3.message);
  checkTrue('旧文件无仪器警告', checked3.instrumentWarnings.length === 0, checked3.instrumentWarnings);
  DLab.Persistence.applyProject(checked3.project, eng3, []);
  check('旧文件导入后仪器为默认值', [eng3.getProbeMode(), eng3.getPotRatio()], ['TTL', 0.5]);
})();

/* ============================================================
 * 7. reset 归零
 * ============================================================ */

group('7. reset 恢复仪器默认');
(function () {
  var eng = newEngine();
  eng.setProbeMode('CMOS');
  eng.setDds({ freqHz: 99999, amplitudeV: 1, waveform: 'pulse', sel: 'wave' });
  eng.setPotRatio(0.9);
  eng.reset();
  check('reset 后逻辑笔 TTL', eng.getProbeMode(), 'TTL');
  check('reset 后 DDS 默认', eng.getDds(), { freqHz: 1000, amplitudeV: 5, waveform: 'square', sel: 'freq' });
  check('reset 后电位器 0.5', eng.getPotRatio(), 0.5);
})();

/* ============================================================
 * 8. 试点亮挂起顺序（回归：先点亮再挂起，顺序反了会点不亮）
 * ============================================================ */

group('8. 试点亮挂起顺序');
(function () {
  // 曾发生的事故：tapFeedback 先 holdLed 再 setLed，而 boardView 的挂起守卫
  // 把挂起期间的一切写都拦掉 —— 连试点亮自己的「点亮」写也被吃掉，灯从不亮。
  // 本组用桩 boardView 锁死调用顺序与参数。
  function makeStubBV() {
    var calls = [];
    return {
      calls: calls,
      ledNodes: { '4L1': { stub: true }, 'dds:FREQ': { stub: true } },
      segGroups: { seg3: { stub: true } },
      setLed: function (key, on) { calls.push(['setLed', key, on]); },
      holdLed: function (key, on) { calls.push(['holdLed', key, on]); },
      setSegment: function (segId, onMap) { calls.push(['setSegment', segId, onMap]); },
      holdSeg: function (segId, on) { calls.push(['holdSeg', segId, on]); },
      update: function () {},
      invalidateLed: function () {},
      invalidateSeg: function () {}
    };
  }
  function orderOf(calls, names) {
    var seq = [];
    for (var i = 0; i < calls.length; i++) {
      if (names.indexOf(calls[i][0]) >= 0) seq.push(calls[i][0]);
    }
    return seq;
  }

  var bv1 = makeStubBV();
  var tap1 = new DLab.TapFeedback({ engine: newEngine(), boardView: bv1 });
  checkTrue("fire('led:4L1') 识别目标", tap1.fire('led:4L1') === true);
  check('LED 试点亮先点亮后挂起', orderOf(bv1.calls, ['setLed', 'holdLed']), ['setLed', 'holdLed']);
  check('LED 点亮写为 (4L1, true)', bv1.calls[0], ['setLed', '4L1', true]);

  var bv2 = makeStubBV();
  var tap2 = new DLab.TapFeedback({ engine: newEngine(), boardView: bv2 });
  checkTrue("fire('seg:seg3') 识别目标", tap2.fire('seg:seg3') === true);
  check('数码管试点亮先全亮后挂起', orderOf(bv2.calls, ['setSegment', 'holdSeg']), ['setSegment', 'holdSeg']);
  var segMap = bv2.calls[0][2];
  checkTrue('数码管全亮写含全部笔段', !!(segMap && segMap.a && segMap.g && segMap.dp && !segMap.x));

  var bv3 = makeStubBV();
  var tap3 = new DLab.TapFeedback({ engine: newEngine(), boardView: bv3 });
  tap3.fire('dds');
  check('信号源试听先点亮 dds:FREQ 后挂起', orderOf(bv3.calls, ['setLed', 'holdLed']), ['setLed', 'holdLed']);
  check('dds:FREQ 点亮写为 true', bv3.calls[0], ['setLed', 'dds:FREQ', true]);
})();

/* ============================================================
 * 汇总
 * ============================================================ */

var failed = results.filter(function (r) { return !r.ok; });
console.log('\n========================================');
console.log('  板载仪器自测：' + (results.length - failed.length) + ' / ' + results.length + ' 通过');
console.log('========================================');
if (failed.length) {
  failed.forEach(function (r) {
    console.log('  ✗ [' + r.group + '] ' + r.desc);
  });
  process.exitCode = 1;
}

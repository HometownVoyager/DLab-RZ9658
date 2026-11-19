#!/usr/bin/env node
// tests/advisor.selftest.cjs
// DLab.Advisor 接线审查自测（零依赖，Node 直跑）：
//   node tests/advisor.selftest.cjs
//
// 覆盖（契约 docs/STAGE4-CONTRACTS.md §5.1 与 §6.1）：
//   · 10 个 code 各自的「正例 + 反例」共 20 条
//   · 审查**只读**：审查前后 engine.getState() 必须完全一致
//   · 真实几何下不抛错、报告结构固定、options.now 可注入
'use strict';

var path = require('path');
var childProcess = require('child_process');

// ---- 按契约加载核心模块（经典脚本 + 全局命名空间）----
globalThis.DLab = {};
require(path.join(__dirname, '..', 'src', 'core', 'panelGeometry.generated.js'));
require(path.join(__dirname, '..', 'src', 'core', 'logic.js'));
require(path.join(__dirname, '..', 'src', 'core', 'chips.js'));
require(path.join(__dirname, '..', 'src', 'core', 'boardNets.js'));
require(path.join(__dirname, '..', 'src', 'core', 'engine.js'));
require(path.join(__dirname, '..', 'src', 'core', 'advisor.js'));

var DLab = globalThis.DLab;
var Advisor = DLab.Advisor;
var Engine = DLab.Engine;

/* ============================================================
 * 极简断言框架
 * ============================================================ */

var results = [];
var currentGroup = '(未分组)';

function group(name) {
  currentGroup = name;
  console.log('\n▶ ' + name);
}

function record(desc, ok, actual, expected) {
  results.push({ group: currentGroup, desc: desc, ok: !!ok, actual: actual, expected: expected });
  if (ok) {
    console.log('  ✓ ' + desc);
  } else {
    console.log('  ✗ ' + desc);
    console.log('      期望: ' + JSON.stringify(expected));
    console.log('      实际: ' + JSON.stringify(actual));
  }
  return !!ok;
}

function check(desc, actual, expected) {
  var ok = JSON.stringify(actual) === JSON.stringify(expected);
  return record(desc, ok, actual, expected);
}

function checkTrue(desc, cond, extra) {
  return record(desc, !!cond, extra === undefined ? !!cond : extra, true);
}

/** 报告里是否存在某个 code */
function hasCode(report, code) {
  for (var i = 0; i < report.issues.length; i++) {
    if (report.issues[i].code === code) return true;
  }
  return false;
}

/** 取出某个 code 的第一条问题 */
function firstOf(report, code) {
  for (var i = 0; i < report.issues.length; i++) {
    if (report.issues[i].code === code) return report.issues[i];
  }
  return null;
}

/** 某 code 的条数 */
function countOf(report, code) {
  var n = 0;
  for (var i = 0; i < report.issues.length; i++) {
    if (report.issues[i].code === code) n++;
  }
  return n;
}

/* ============================================================
 * 场景搭建
 * ============================================================ */

/** 造一台干净引擎（真实几何） */
function newEngine() {
  return new Engine({ geometry: DLab.geometry });
}

/**
 * 接一根线，并推进一次仿真让电平立刻生效。
 * （引擎的 getState() 返回的是上一次 step 的缓存，改线后必须 step 才会重算）
 */
function wire(engine, id, from, to) {
  engine.addWire({ id: id, from: from, to: to, color: '#3b82f6' });
  settle(engine);
  return id;
}

/** 推进一次仿真（时间单调递增） */
function settle(engine) {
  var now = engine.getState().now;
  engine.step((typeof now === 'number' ? now : 0) + 1);
}

/**
 * 插芯片并接好 VCC / GND。
 * 插座 devA:UA → 插孔 devA:A1..A14；devA:UE → devA:E1..E16；devB:UA → devB:A1..A14。
 */
function mountWithPower(engine, socketId, model, vccPin, gndPin) {
  var parts = socketId.split(':');
  var moduleId = parts[0];            // 'devA' / 'devB'
  var letter = parts[1].charAt(1);    // 'A' / 'B' / 'E' / 'D' / 'F'
  engine.mountChip(socketId, model);
  wire(engine, 'vpwr_' + socketId, 'pwr:5V1', moduleId + ':' + letter + vccPin);
  wire(engine, 'vgnd_' + socketId, 'gnd:GND1', moduleId + ':' + letter + gndPin);
  return socketId;
}

/** 74LS00 最小可用电路：VCC + GND */
function mountNand(engine, socketId) {
  return mountWithPower(engine, socketId || 'devA:UA', '74LS00', 14, 7);
}

/* ============================================================
 * 1. 报告结构
 * ============================================================ */

group('报告结构与固定字段');

var e0 = newEngine();
var r0 = Advisor.review(e0, { now: 1700000000000 });

checkTrue('review 返回对象', !!r0 && typeof r0 === 'object');
check('report.ok 是布尔', typeof r0.ok, 'boolean');
check('report.generatedAt 采纳 options.now', r0.generatedAt, 1700000000000);
check('report.summary 结构固定', Object.keys(r0.summary).sort(), ['error', 'info', 'warn']);
check('report.stats 结构固定', Object.keys(r0.stats).sort(),
  ['chips', 'floatingPins', 'poweredChips', 'shorts', 'wires']);
checkTrue('report.issues 是数组', Array.isArray(r0.issues));
checkTrue('每条 issue 字段齐全', r0.issues.every(function (it) {
  return typeof it.id === 'string' && typeof it.level === 'string' &&
    typeof it.code === 'string' && typeof it.title === 'string' &&
    typeof it.detail === 'string' && typeof it.hint === 'string' &&
    Array.isArray(it.jacks) &&
    (it.socketId === null || typeof it.socketId === 'string') &&
    (it.pin === null || typeof it.pin === 'number');
}));
check('LEVELS 三档固定', Advisor.LEVELS, { ERROR: 'error', WARN: 'warn', INFO: 'info' });
checkTrue('issue id 形如 <code>#<n>', r0.issues.every(function (it) {
  return it.id === it.code + '#' + it.id.split('#')[1];
}));
check('ok 等于「没有 error 级问题」', r0.ok, r0.summary.error === 0);
check('summary 计数与 issues 一致', r0.summary.error + r0.summary.warn + r0.summary.info, r0.issues.length);
checkTrue('未注入 now 时用 Date.now()', Math.abs(Advisor.review(e0).generatedAt - Date.now()) < 5000);

/* ============================================================
 * 2. NO_WIRES
 * ============================================================ */

group('NO_WIRES（没有任何导线）');

var e1 = newEngine();
var r1 = Advisor.review(e1);
checkTrue('正例：无导线时报 NO_WIRES', hasCode(r1, 'NO_WIRES'));
check('NO_WIRES 级别是 info', firstOf(r1, 'NO_WIRES').level, 'info');
check('NO_WIRES 的 jacks 为空数组', firstOf(r1, 'NO_WIRES').jacks, []);

wire(e1, 'w1', 'pwr:5V1', 'gnd:GND1');
var r2 = Advisor.review(e1);
checkTrue('反例：有导线后不再报 NO_WIRES', !hasCode(r2, 'NO_WIRES'));
check('stats.wires 统计正确', r2.stats.wires, 1);

/* ============================================================
 * 3. NO_POWER / NO_GROUND
 * ============================================================ */

group('NO_POWER / NO_GROUND（供电与接地）');

var e3 = newEngine();
e3.mountChip('devA:UA', '74LS00');            // 只插芯片，不接 VCC / GND
settle(e3);
var r3 = Advisor.review(e3);
checkTrue('正例：未接 VCC 报 NO_POWER', hasCode(r3, 'NO_POWER'));
check('NO_POWER 级别是 error', firstOf(r3, 'NO_POWER').level, 'error');
check('NO_POWER 指出插座', firstOf(r3, 'NO_POWER').socketId, 'devA:UA');
check('NO_POWER 指出引脚号', firstOf(r3, 'NO_POWER').pin, 14);
check('NO_POWER 关联 VCC 插孔', firstOf(r3, 'NO_POWER').jacks, ['devA:A14']);
checkTrue('正例：未接 GND 报 NO_GROUND', hasCode(r3, 'NO_GROUND'));
check('NO_GROUND 级别是 error', firstOf(r3, 'NO_GROUND').level, 'error');
check('NO_GROUND 指出引脚号', firstOf(r3, 'NO_GROUND').pin, 7);
check('NO_GROUND 关联 GND 插孔', firstOf(r3, 'NO_GROUND').jacks, ['devA:A7']);

var e4 = newEngine();
mountNand(e4, 'devA:UA');
var r4 = Advisor.review(e4);
checkTrue('反例：接好 VCC 后不再报 NO_POWER', !hasCode(r4, 'NO_POWER'));
checkTrue('反例：接好 GND 后不再报 NO_GROUND', !hasCode(r4, 'NO_GROUND'));
check('stats.chips 统计正确', r4.stats.chips, 1);
check('stats.poweredChips 统计正确', r4.stats.poweredChips, 1);

/* ============================================================
 * 4. SHORT_CIRCUIT
 * ============================================================ */

group('SHORT_CIRCUIT（短路 / 同网冲突）');

var e5 = newEngine();
wire(e5, 'sc1', 'pwr:5V1', 'gnd:GND1');
var r5 = Advisor.review(e5);
checkTrue('正例：VCC 与 GND 短接报 SHORT_CIRCUIT', hasCode(r5, 'SHORT_CIRCUIT'));
check('SHORT_CIRCUIT 级别是 error', firstOf(r5, 'SHORT_CIRCUIT').level, 'error');
checkTrue('SHORT_CIRCUIT 关联插孔非空', firstOf(r5, 'SHORT_CIRCUIT').jacks.length > 0);
check('stats.shorts 统计正确', r5.stats.shorts, 1);
check('ok 为 false（有 error）', r5.ok, false);

var e6 = newEngine();
mountNand(e6, 'devA:UA');
var r6 = Advisor.review(e6);
checkTrue('反例：没有短路时不报 SHORT_CIRCUIT', !hasCode(r6, 'SHORT_CIRCUIT'));
check('反例：stats.shorts 为 0', r6.stats.shorts, 0);

/* ============================================================
 * 5. OUTPUT_CONFLICT
 * ============================================================ */

group('OUTPUT_CONFLICT（两个输出脚共网）');

var e7 = newEngine();
mountNand(e7, 'devA:UA');
mountNand(e7, 'devA:UB');
// UA 的 1Y 输出 1（两输入接 0），UB 的 1Y 输出 0（两输入接 1）
wire(e7, 'ua_in1', 'sw:5K1', 'devA:A1');
wire(e7, 'ua_in2', 'sw:5K2', 'devA:A2');
wire(e7, 'ua_in3', 'sw:5K3', 'devA:B1');
wire(e7, 'ua_in4', 'sw:5K4', 'devA:B2');
e7.setSwitch(1, 0); e7.setSwitch(2, 0); e7.setSwitch(3, 1); e7.setSwitch(4, 1);
wire(e7, 'clash', 'devA:A3', 'devA:B3');
e7.step(1000);
var r7 = Advisor.review(e7);
checkTrue('正例：两个输出脚共网报 OUTPUT_CONFLICT', hasCode(r7, 'OUTPUT_CONFLICT'));
check('OUTPUT_CONFLICT 级别是 error', firstOf(r7, 'OUTPUT_CONFLICT').level, 'error');
checkTrue('OUTPUT_CONFLICT 关联两个输出插孔', firstOf(r7, 'OUTPUT_CONFLICT').jacks.length >= 2);

var e8 = newEngine();
mountNand(e8, 'devA:UA');
wire(e8, 'led1', 'devA:A3', 'led:4P1');
var r8 = Advisor.review(e8);
checkTrue('反例：只有一个输出接负载时不报 OUTPUT_CONFLICT', !hasCode(r8, 'OUTPUT_CONFLICT'));

/* ============================================================
 * 6. ENABLE_FLOATING
 * ============================================================ */

group('ENABLE_FLOATING（低有效使能端悬空）');

var e9 = newEngine();
e9.mountChip('devA:UE', '74LS161');
settle(e9);
wire(e9, 'cv', 'pwr:5V1', 'devA:E16');
wire(e9, 'cg', 'gnd:GND1', 'devA:E8');
var r9 = Advisor.review(e9);
checkTrue('正例：~PE（低有效并行置数端）悬空报 ENABLE_FLOATING', hasCode(r9, 'ENABLE_FLOATING'));
check('ENABLE_FLOATING 级别是 warn', firstOf(r9, 'ENABLE_FLOATING').level, 'warn');
check('ENABLE_FLOATING 指出引脚号', firstOf(r9, 'ENABLE_FLOATING').pin, 9);

wire(e9, 'pe_ok', 'pwr:5V1', 'devA:E9');
var r10 = Advisor.review(e9);
checkTrue('反例：~PE 接上 VCC 后不再报 ENABLE_FLOATING', !hasCode(r10, 'ENABLE_FLOATING'));

// 契约关键词表没列全的低有效使能端（74LS138 的 ~G2A）也要能识别
var e9b = newEngine();
e9b.mountChip('devA:UE', '74LS138');
settle(e9b);
wire(e9b, 'g1_hi', 'pwr:5V1', 'devA:E6');       // G1（高有效使能）
wire(e9b, 'g2b_lo', 'gnd:GND1', 'devA:E5');      // ~G2B 接地
var r9b = Advisor.review(e9b);
checkTrue('正例：74LS138 的 ~G2A 悬空按低有效使能端报 ENABLE_FLOATING',
  r9b.issues.some(function (it) {
    return it.code === 'ENABLE_FLOATING' && it.jacks.indexOf('devA:E4') >= 0;
  }));
wire(e9b, 'g2a_lo', 'gnd:GND1', 'devA:E4');      // ~G2A 接地
var r9c = Advisor.review(e9b);
checkTrue('反例：~G2A 接地后不再报 ENABLE_FLOATING',
  !r9c.issues.some(function (it) {
    return it.code === 'ENABLE_FLOATING' && it.jacks.indexOf('devA:E4') >= 0;
  }));

/* ============================================================
 * 7. INPUT_FLOATING
 * ============================================================ */

group('INPUT_FLOATING（输入端悬空）');

var e11 = newEngine();
mountNand(e11, 'devA:UA');
var r11 = Advisor.review(e11);
checkTrue('正例：1A 输入悬空报 INPUT_FLOATING', hasCode(r11, 'INPUT_FLOATING'));
check('INPUT_FLOATING 级别是 warn', firstOf(r11, 'INPUT_FLOATING').level, 'warn');
checkTrue('stats.floatingPins 统计悬空脚', r11.stats.floatingPins > 0);

wire(e11, 'in1', 'sw:5K1', 'devA:A1');
var r12 = Advisor.review(e11);
checkTrue('反例：1A 接上开关后不再报该脚的 INPUT_FLOATING',
  firstOf(r12, 'INPUT_FLOATING').jacks.indexOf('devA:A1') < 0);

/* ============================================================
 * 8. CLOCK_FLOATING
 * ============================================================ */

group('CLOCK_FLOATING（时序芯片时钟悬空）');

var e13 = newEngine();
e13.mountChip('devA:UA', '74LS74');
settle(e13);
wire(e13, 'cv2', 'pwr:5V1', 'devA:A14');
wire(e13, 'cg2', 'gnd:GND1', 'devA:A7');
var r13 = Advisor.review(e13);
checkTrue('正例：74LS74 的 CLK 悬空报 CLOCK_FLOATING', hasCode(r13, 'CLOCK_FLOATING'));
check('CLOCK_FLOATING 级别是 warn', firstOf(r13, 'CLOCK_FLOATING').level, 'warn');
check('CLOCK_FLOATING 指出引脚号', firstOf(r13, 'CLOCK_FLOATING').pin, 3);

wire(e13, 'clk', 'clock:1HZ', 'devA:A3');
var r14 = Advisor.review(e13);
checkTrue('反例：CLK 接上时钟后该脚不再报 CLOCK_FLOATING',
  !firstOf(r14, 'CLOCK_FLOATING') || firstOf(r14, 'CLOCK_FLOATING').jacks.indexOf('devA:A3') < 0);

/* ============================================================
 * 9. RESET_HELD
 * ============================================================ */

group('RESET_HELD（异步复位端被钳位）');

var e15 = newEngine();
e15.mountChip('devA:UA', '74LS74');
settle(e15);
wire(e15, 'cv3', 'pwr:5V1', 'devA:A14');
wire(e15, 'cg3', 'gnd:GND1', 'devA:A7');
wire(e15, 'clr_lo', 'gnd:GND1', 'devA:A1');        // ~1CLR 接地
var r15 = Advisor.review(e15);
checkTrue('正例：~1CLR 恒为 0 报 RESET_HELD', hasCode(r15, 'RESET_HELD'));
check('RESET_HELD 级别是 warn', firstOf(r15, 'RESET_HELD').level, 'warn');
check('RESET_HELD 指出引脚号', firstOf(r15, 'RESET_HELD').pin, 1);

var e16 = newEngine();
e16.mountChip('devA:UA', '74LS74');
settle(e16);
wire(e16, 'cv4', 'pwr:5V1', 'devA:A14');
wire(e16, 'cg4', 'gnd:GND1', 'devA:A7');
wire(e16, 'clr_hi', 'pwr:5V1', 'devA:A1');          // ~1CLR 接 VCC
var r16 = Advisor.review(e16);
checkTrue('反例：~1CLR 接 VCC 后不再报 RESET_HELD', !hasCode(r16, 'RESET_HELD'));

/* ============================================================
 * 10. OUTPUT_FLOATING
 * ============================================================ */

group('OUTPUT_FLOATING（输出端悬空）');

var e17 = newEngine();
e17.mountChip('devA:UA', '74LS00');                // 插了芯片但整板断电 → 输出全高阻
settle(e17);
e17.setPower(false);
settle(e17);
var r17 = Advisor.review(e17);
checkTrue('正例：输出脚所在网为 Z 且无其它插孔时报 OUTPUT_FLOATING',
  hasCode(r17, 'OUTPUT_FLOATING'));
check('OUTPUT_FLOATING 级别是 info', firstOf(r17, 'OUTPUT_FLOATING').level, 'info');
checkTrue('OUTPUT_FLOATING 关联的是输出插孔', firstOf(r17, 'OUTPUT_FLOATING').jacks.length > 0);
checkTrue('悬空的 1Y（devA:A3）在问题列表里',
  r17.issues.some(function (it) {
    return it.code === 'OUTPUT_FLOATING' && it.jacks.indexOf('devA:A3') >= 0;
  }));

var e18 = newEngine();
e18.mountChip('devA:UA', '74LS00');
settle(e18);
e18.setPower(false);
settle(e18);
wire(e18, 'led2', 'devA:A3', 'led:4P1');
var r18 = Advisor.review(e18);
checkTrue('反例：输出接了负载后该脚不再报 OUTPUT_FLOATING',
  !r18.issues.some(function (it) {
    return it.code === 'OUTPUT_FLOATING' && it.jacks.indexOf('devA:A3') >= 0;
  }));

/* ============================================================
 * 11. 只读性
 * ============================================================ */

group('只读性（审查不改变引擎状态）');

var e19 = newEngine();
mountNand(e19, 'devA:UA');
wire(e19, 'led3', 'devA:A3', 'led:4P1');
wire(e19, 'sig1', 'sw:5K1', 'devA:A1');
e19.setSwitch(5, 1);
e19.step(1000);

var beforeState = JSON.stringify(e19.getState());
var beforeWires = JSON.stringify(e19.getWires());
var beforeChips = JSON.stringify(e19.getChips());
var beforeSwitches = JSON.stringify(e19.getSwitches());

Advisor.review(e19, { now: 42 });

check('审查前后 getState() 完全一致', JSON.stringify(e19.getState()), beforeState);
check('审查前后导线列表完全一致', JSON.stringify(e19.getWires()), beforeWires);
check('审查前后芯片列表完全一致', JSON.stringify(e19.getChips()), beforeChips);
check('审查前后开关状态完全一致', JSON.stringify(e19.getSwitches()), beforeSwitches);
check('审查没有推进虚拟时间', e19.getState().now, JSON.parse(beforeState).now);

/* ============================================================
 * 12. 真实几何下的健壮性
 * ============================================================ */

group('真实几何下不抛错');

var e20 = newEngine();
var models = [
  ['devA:UA', '74LS00'], ['devA:UB', '74LS04'], ['devA:UE', '74LS138'],
  ['devA:UD', '74LS161'], ['devB:UA', '74LS74'], ['devB:UB', '74LS112'],
  ['devB:UE', '74LS153'], ['devB:UD', '74LS151'], ['devB:UF', '74LS273']
];
models.forEach(function (m) {
  try {
    e20.mountChip(m[0], m[1]);
  } catch (err) {
    // 插座封装不匹配时跳过（不影响本组断言）
  }
});
wire(e20, 'real1', 'sw:5K1', 'devA:A1');
wire(e20, 'real2', 'pwr:5V1', 'devA:E16');
wire(e20, 'real3', 'gnd:GND1', 'devA:E8');
e20.step(2000);

var threw = null;
var r20 = null;
try {
  r20 = Advisor.review(e20, { now: 7 });
} catch (err) {
  threw = err;
}
checkTrue('多芯片真实几何审查不抛错', !threw, threw ? String(threw.message || threw) : null);
checkTrue('审查报告仍然结构完整', !!(r20 && r20.issues && r20.stats && r20.summary));
check('generatedAt 依旧可注入', r20.generatedAt, 7);
checkTrue('全部 code 都取自契约的 10 个',
  r20.issues.every(function (it) {
    return ['NO_POWER', 'NO_GROUND', 'SHORT_CIRCUIT', 'OUTPUT_CONFLICT', 'ENABLE_FLOATING',
      'INPUT_FLOATING', 'CLOCK_FLOATING', 'RESET_HELD', 'OUTPUT_FLOATING', 'NO_WIRES']
      .indexOf(it.code) >= 0;
  }));

/* ============================================================
 * 13. 最小加载路径（契约：只 require 四个文件也能用）
 * ============================================================ */

group('最小加载路径');

var appDir = path.join(__dirname, '..');
var minimalScript = [
  'globalThis.DLab = {};',
  'require(' + JSON.stringify(path.join(appDir, 'src', 'core', 'logic.js')) + ');',
  'require(' + JSON.stringify(path.join(appDir, 'src', 'core', 'chips.js')) + ');',
  'require(' + JSON.stringify(path.join(appDir, 'src', 'core', 'engine.js')) + ');',
  'require(' + JSON.stringify(path.join(appDir, 'src', 'core', 'advisor.js')) + ');',
  'var e = new DLab.Engine({ geometry: DLab.geometry });',
  'var r = DLab.Advisor.review(e, { now: 1 });',
  'if (!r || !r.issues || !r.stats) { process.exit(3); }',
  'process.stdout.write("OK");'
].join('\n');

var minimalOk = false;
var minimalErr = '';
try {
  var out = childProcess.execFileSync(process.execPath, ['-e', minimalScript], {
    cwd: appDir, encoding: 'utf8', timeout: 30000
  });
  minimalOk = out.indexOf('OK') >= 0;
} catch (err) {
  minimalErr = String((err && err.stderr) || (err && err.message) || err);
}
checkTrue('只加载 logic/chips/engine/advisor 也能跑（无几何亦不抛错）', minimalOk, minimalErr);

/* ============================================================
 * 汇总
 * ============================================================ */

var pass = results.filter(function (r) { return r.ok; }).length;
var fail = results.length - pass;
console.log('');
console.log('========================================');
console.log('  审查自测：PASS=' + pass + '  FAIL=' + fail + '  （共 ' + results.length + ' 条断言）');
console.log('========================================');
if (fail > 0) {
  console.log('失败明细：');
  results.forEach(function (r) {
    if (!r.ok) console.log('  ✗ [' + r.group + '] ' + r.desc);
  });
}
process.exit(fail === 0 ? 0 : 1);

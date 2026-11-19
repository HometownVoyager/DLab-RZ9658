#!/usr/bin/env node
// tests/grader.selftest.cjs
// DLab.Grader / DLab.Quiz 自测（零依赖，Node 直跑）：
//   node tests/grader.selftest.cjs
//
// 覆盖（契约 docs/STAGE4-CONTRACTS.md §5.2、§5.3 与 §6.1）：
//   · buildTask 归一化
//   · grade 打分正确 / 错误两组
//   · 16 个开关逐一恢复
//   · 3 个模板生成 + Persistence.validateProject 校验 + readTask 导入 + solution 满分
'use strict';

var path = require('path');

// ---- 按契约加载核心模块（经典脚本 + 全局命名空间）----
globalThis.DLab = {};
require(path.join(__dirname, '..', 'src', 'core', 'panelGeometry.generated.js'));
require(path.join(__dirname, '..', 'src', 'core', 'logic.js'));
require(path.join(__dirname, '..', 'src', 'core', 'chips.js'));
require(path.join(__dirname, '..', 'src', 'core', 'boardNets.js'));
require(path.join(__dirname, '..', 'src', 'core', 'engine.js'));
require(path.join(__dirname, '..', 'src', 'core', 'advisor.js'));
require(path.join(__dirname, '..', 'src', 'core', 'grader.js'));
require(path.join(__dirname, '..', 'src', 'core', 'quiz.js'));
require(path.join(__dirname, '..', 'src', 'ui', 'persistence.js'));

var DLab = globalThis.DLab;
var Grader = DLab.Grader;
var Quiz = DLab.Quiz;
var Engine = DLab.Engine;
var Persistence = DLab.Persistence;

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

/* ============================================================
 * 场景搭建
 * ============================================================ */

function newEngine() {
  return new Engine({ geometry: DLab.geometry });
}

/** 接一根线并推进一次仿真 */
function wire(engine, id, from, to) {
  engine.addWire({ id: id, from: from, to: to, color: '#3b82f6' });
  engine.step(engine.getState().now + 1);
  return id;
}

/** 完整搭一个 74LS00 与非门：5K1→1A、5K2→1B、1Y→4P1 */
function buildNand(engine) {
  engine.mountChip('devA:UA', '74LS00');
  wire(engine, 'w1', 'pwr:5V1', 'devA:A14');
  wire(engine, 'w2', 'gnd:GND1', 'devA:A7');
  wire(engine, 'w3', 'sw:5K1', 'devA:A1');
  wire(engine, 'w4', 'sw:5K2', 'devA:A2');
  wire(engine, 'w5', 'devA:A3', 'led:4P1');
  return engine;
}

/** 与非门真值表 */
var NAND_TASK = {
  id: 'test-nand',
  title: '74LS00 与非门',
  description: '两个开关驱动与非门，输出接指示灯',
  inputs: ['sw:5K1', 'sw:5K2'],
  outputs: ['led:4P1'],
  rows: [
    { in: [0, 0], out: [1] },
    { in: [0, 1], out: [1] },
    { in: [1, 0], out: [1] },
    { in: [1, 1], out: [0] }
  ]
};

/* ============================================================
 * 1. buildTask 归一化
 * ============================================================ */

group('buildTask 归一化');

var t0 = Grader.buildTask({
  id: 'x', title: '标题', description: '说明',
  inputs: ['sw:5K1'], outputs: ['led:4P1'],
  rows: [{ in: [0], out: [1] }]
});
check('task 结构固定', Object.keys(t0).sort(),
  ['description', 'id', 'inputs', 'outputs', 'rows', 'title']);
check('rows 每行结构固定', Object.keys(t0.rows[0]).sort(), ['in', 'out']);
check('id 归一化', t0.id, 'x');
check('title 归一化', t0.title, '标题');
check('description 归一化', t0.description, '说明');
check('inputs 归一化', t0.inputs, ['sw:5K1']);
check('outputs 归一化', t0.outputs, ['led:4P1']);
check('rows 归一化', t0.rows, [{ in: [0], out: [1] }]);

var t1 = Grader.buildTask(null);
check('空入参不抛错，字段仍是六个', Object.keys(t1).sort(),
  ['description', 'id', 'inputs', 'outputs', 'rows', 'title']);
check('空入参的 rows 是空数组', t1.rows, []);
check('空入参的 id 是默认 task', t1.id, 'task');

var t2 = Grader.buildTask({ rows: [{ in: ['1', 0, true], out: [2] }] });
check('真值表里的非 0/1 值被收敛成 0/1', t2.rows[0].in, [1, 0, 1]);
check('期望值里的 2 被收敛成 0', t2.rows[0].out, [0]);

/* ============================================================
 * 2. grade 打分正确
 * ============================================================ */

group('grade 打分正确（全通过）');

var e1 = buildNand(newEngine());
var g1 = Grader.grade(e1, NAND_TASK, { timeMs: 1000 });
checkTrue('grade 返回对象', !!g1 && typeof g1 === 'object');
check('grade 结构固定', Object.keys(g1).sort(),
  ['failed', 'message', 'ok', 'passed', 'rows', 'total']);
check('total 等于真值表行数', g1.total, 4);
check('passed 等于 4', g1.passed, 4);
check('failed 等于 0', g1.failed, 0);
check('ok 为 true', g1.ok, true);
check('rows 长度等于 total', g1.rows.length, 4);
check('每行结构固定', Object.keys(g1.rows[0]).sort(), ['actual', 'expected', 'in', 'pass']);
check('第 1 行实测值', g1.rows[0].actual, [1]);
check('第 4 行实测值', g1.rows[3].actual, [0]);
check('每行 pass 均为 true', g1.rows.map(function (r) { return r.pass; }), [true, true, true, true]);
checkTrue('message 是中文说明', typeof g1.message === 'string' && g1.message.length > 0);

/* ============================================================
 * 3. grade 打分错误
 * ============================================================ */

group('grade 打分错误（半成品接错线）');

var e2 = newEngine();
e2.mountChip('devA:UA', '74LS00');
wire(e2, 'w1', 'pwr:5V1', 'devA:A14');
wire(e2, 'w2', 'gnd:GND1', 'devA:A7');
wire(e2, 'w3', 'sw:5K1', 'devA:A1');
wire(e2, 'w4', 'sw:5K2', 'devA:A2');
// 故意不接输出 → 输出恒 0
var g2 = Grader.grade(e2, NAND_TASK, { timeMs: 1000 });
check('total 仍是 4', g2.total, 4);
check('passed 小于 4', g2.passed < 4, true);
check('failed 等于 4 - passed', g2.failed, 4 - g2.passed);
check('ok 为 false', g2.ok, false);
check('未接输出时实测全为 0', g2.rows[0].actual, [0]);
check('存在未通过的行', g2.rows.filter(function (r) { return !r.pass; }).length, g2.failed);

var e3 = buildNand(newEngine());
var wrongTask = {
  id: 'wrong', title: '错题', description: '',
  inputs: ['sw:5K1', 'sw:5K2'], outputs: ['led:4P1'],
  rows: [
    { in: [0, 0], out: [0] },
    { in: [0, 1], out: [1] },
    { in: [1, 0], out: [1] },
    { in: [1, 1], out: [1] }
  ]
};
var g3 = Grader.grade(e3, wrongTask, { timeMs: 1000 });
check('期望值写错时只有 2 行通过', g3.passed, 2);
check('期望值写错时 failed 为 2', g3.failed, 2);
check('期望值写错时 ok 为 false', g3.ok, false);

var g4 = Grader.grade(e3, { id: 'empty', title: '空题', description: '', inputs: [], outputs: [], rows: [] });
check('空真值表 total 为 0', g4.total, 0);
check('空真值表 ok 为 false', g4.ok, false);
check('空真值表 message 有中文提示', typeof g4.message === 'string' && g4.message.length > 0, true);

/* ============================================================
 * 4. 开关恢复
 * ============================================================ */

group('开关恢复（打分后 16 个开关逐一还原）');

var e4 = buildNand(newEngine());
// 先把开关拨成任意状态：1,3,5,7,9,11,13,15 为 1
var pre = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
for (var i = 0; i < 16; i++) e4.setSwitch(i + 1, pre[i]);
var beforeSwitches = e4.getSwitches();
var beforeWires = JSON.stringify(e4.getWires());
var beforeChips = JSON.stringify(e4.getChips());

Grader.grade(e4, NAND_TASK, { timeMs: 1000 });

check('打分后 16 个开关全部恢复', e4.getSwitches(), beforeSwitches);
check('打分没有增删导线', JSON.stringify(e4.getWires()), beforeWires);
check('打分没有插拔芯片', JSON.stringify(e4.getChips()), beforeChips);
checkTrue('恢复后开关逐个比对一致', (function () {
  for (var k = 1; k <= 16; k++) {
    if (e4.getSwitch(k) !== pre[k - 1]) return false;
  }
  return true;
})());

var e5 = buildNand(newEngine());
for (var j = 1; j <= 16; j++) e5.setSwitch(j, 1);
var g5 = Grader.grade(e5, NAND_TASK, { timeMs: 1000, restore: false });
check('restore:false 时不恢复开关（供测试用）', e5.getSwitch(1), 1);
check('restore:false 时打分结果仍然正确', g5.passed, 4);

/* ============================================================
 * 5. 打分不改电路 / 时间固定
 * ============================================================ */

group('打分的其它约束');

var e6 = buildNand(newEngine());
var wiresBefore = JSON.stringify(e6.getWires());
var chipsBefore = JSON.stringify(e6.getChips());
Grader.grade(e6, NAND_TASK, { timeMs: 1234 });
check('打分后导线列表不变', JSON.stringify(e6.getWires()), wiresBefore);
check('打分后芯片列表不变', JSON.stringify(e6.getChips()), chipsBefore);
check('打分把时间推进到 timeMs 之后', e6.getState().now >= 1234, true);

check('switchNumberOf 解析 sw:5K1', Grader.switchNumberOf('sw:5K1'), 1);
check('switchNumberOf 解析 5K16', Grader.switchNumberOf('5K16'), 16);
check('switchNumberOf 拒绝非法插孔', Grader.switchNumberOf('led:4P1'), 0);

/* ============================================================
 * 6. 三个模板生成 + 校验 + 导入 + 满分
 * ============================================================ */

group('Quiz 模板生成与校验');

checkTrue('至少 3 个模板', Quiz.TEMPLATES.length >= 3, Quiz.TEMPLATES.length);
check('模板 id 齐全',
  Quiz.TEMPLATES.map(function (t) { return t.id; }),
  ['quiz-inverter', 'quiz-nand', 'quiz-decoder']);
checkTrue('每个模板字段齐全', Quiz.TEMPLATES.every(function (t) {
  return typeof t.id === 'string' && typeof t.title === 'string' &&
    typeof t.description === 'string' && typeof t.pins === 'string' &&
    typeof t.difficulty === 'number';
}));

var TEMPLATE_IDS = ['quiz-inverter', 'quiz-nand', 'quiz-decoder'];

function applyProject(project, engine) {
  engine.reset();
  engine.setPower(project.power !== false);
  for (var s = 1; s <= 16; s++) {
    if (project.switches['5K' + s]) engine.setSwitch(s, 1);
  }
  for (var sid in project.chips) {
    if (Object.prototype.hasOwnProperty.call(project.chips, sid) && project.chips[sid]) {
      engine.mountChip(sid, project.chips[sid]);
    }
  }
  for (var w = 0; w < project.wires.length; w++) {
    engine.addWire(project.wires[w]);
  }
  engine.step(1000);
}

TEMPLATE_IDS.forEach(function (tid) {
  var gen = Quiz.generate(tid, { now: 0 });
  checkTrue(tid + '：generate 返回 project / task / solution',
    !!gen.project && !!gen.task && !!gen.solution);
  check(tid + '：project.format 正确', gen.project.format, 'dlab-project');
  check(tid + '：project.version 正确', gen.project.version, 1);
  check(tid + '：project.task 就是题面', gen.project.task.id, gen.task.id);
  checkTrue(tid + '：project.task 是新增字段（老版本未知字段忽略）',
    Object.prototype.hasOwnProperty.call(gen.project, 'task'));
  checkTrue(tid + '：半成品已插好芯片', Object.keys(gen.project.chips).length >= 1);
  checkTrue(tid + '：半成品已接 VCC/GND', gen.project.wires.length >= 2);
  checkTrue(tid + '：故意留空了 1~2 根关键导线',
    gen.solution.wires.length >= 1 && gen.solution.wires.length <= 2,
    gen.solution.wires.length);
  checkTrue(tid + '：题面有 inputs / outputs / rows',
    gen.task.inputs.length > 0 && gen.task.outputs.length > 0 && gen.task.rows.length > 0);

  // 校验：必须能通过 Persistence.validateProject
  var eng = newEngine();
  var checked = Persistence.validateProject(gen.project, eng);
  checkTrue(tid + '：通过 Persistence.validateProject', checked.ok, checked.message);
  checkTrue(tid + '：所有插孔 id 真实存在',
    gen.project.wires.every(function (w) {
      return !!eng.getJackInfo(w.from) && !!eng.getJackInfo(w.to);
    }));

  // 半成品：应有部分行不通过
  applyProject(gen.project, eng);
  var half = Grader.grade(eng, gen.task, { timeMs: 1000 });
  checkTrue(tid + '：半成品不是满分', half.passed < half.total, half.passed + '/' + half.total);

  // 补上答案：必须 100% 通过
  for (var i = 0; i < gen.solution.wires.length; i++) {
    eng.addWire(gen.solution.wires[i]);
  }
  var full = Grader.grade(eng, gen.task, { timeMs: 1000 });
  check(tid + '：接上 solution 后 100% 通过', full.passed + '/' + full.total,
    full.total + '/' + full.total);
  check(tid + '：接上 solution 后 ok 为 true', full.ok, true);
  check(tid + '：接上 solution 后 failed 为 0', full.failed, 0);
});

/* ============================================================
 * 7. readTask 读入
 * ============================================================ */

group('Quiz.readTask 读入题面');

var genInv = Quiz.generate('quiz-inverter', { now: 0 });

Promise.all([
  Quiz.readTask(JSON.stringify(genInv.project)),
  Quiz.readTask(genInv.project),
  Quiz.readTask({ text: function () { return Promise.resolve(JSON.stringify(genInv.project)); } })
]).then(function (outs) {
  check('readTask(文本) ok 为 true', outs[0].ok, true);
  check('readTask(文本) 读出题面 id', outs[0].task.id, 'quiz-inverter');
  check('readTask(对象) ok 为 true', outs[1].ok, true);
  check('readTask(对象) 读出题面 id', outs[1].task.id, 'quiz-inverter');
  check('readTask(File 风格对象) ok 为 true', outs[2].ok, true);
  check('readTask(File 风格对象) 读出题面 id', outs[2].task.id, 'quiz-inverter');
  checkTrue('readTask 返回 message', typeof outs[0].message === 'string' && outs[0].message.length > 0);
  check('readTask 读出的题面行数与生成一致', outs[0].task.rows.length, genInv.task.rows.length);
  check('readTask 读出的 inputs 与生成一致', outs[0].task.inputs, genInv.task.inputs);
  check('readTask 读出的 outputs 与生成一致', outs[0].task.outputs, genInv.task.outputs);

  return Promise.all([
    Quiz.readTask('{ 这不是 JSON'),
    Quiz.readTask(JSON.stringify({ format: 'other', version: 1 })),
    Quiz.readTask(JSON.stringify({ format: 'dlab-project', version: 1 }))
  ]);
}).then(function (outs2) {
  check('非法 JSON 返回 ok=false', outs2[0].ok, false);
  checkTrue('非法 JSON 有中文 message', typeof outs2[0].message === 'string' && outs2[0].message.length > 0);
  check('format 不对返回 ok=false', outs2[1].ok, false);
  check('没有 task 字段返回 ok=false', outs2[2].ok, false);
  checkTrue('失败时 task 为 null', outs2[2].task === null, true);
  finish();
}).catch(function (err) {
  record('readTask 异步链路未抛错', false, String(err && err.message ? err.message : err), true);
  finish();
});

/* ============================================================
 * 8. 老版本工程导入（未知字段忽略）
 * ============================================================ */

group('老版本工程导入（project.task 是新增字段）');

var legacy = {
  format: 'dlab-project',
  version: 1,
  power: true,
  switches: { '5K1': 1 },
  chips: { 'devA:UA': '74LS00' },
  wires: [{ id: 'w1', from: 'pwr:5V1', to: 'devA:A14' }]
};
var legacyChecked = Persistence.validateProject(legacy, newEngine());
checkTrue('不含 task 字段的老工程仍能通过校验', legacyChecked.ok, legacyChecked.message);
checkTrue('校验结果不保留未知字段',
  !Object.prototype.hasOwnProperty.call(legacyChecked.project, 'task'));

var withTask = JSON.parse(JSON.stringify(legacy));
withTask.task = genInv.task;
var withTaskChecked = Persistence.validateProject(withTask, newEngine());
checkTrue('含 task 字段的新工程也能通过校验', withTaskChecked.ok, withTaskChecked.message);
checkTrue('校验结果丢弃 task 字段（导入不影响电路）',
  !Object.prototype.hasOwnProperty.call(withTaskChecked.project, 'task'));

/* ============================================================
 * 汇总
 * ============================================================ */

function finish() {
  var pass = results.filter(function (r) { return r.ok; }).length;
  var fail = results.length - pass;
  console.log('');
  console.log('========================================');
  console.log('  打分 + 出题自测：PASS=' + pass + '  FAIL=' + fail + '  （共 ' + results.length + ' 条断言）');
  console.log('========================================');
  if (fail > 0) {
    console.log('失败明细：');
    results.forEach(function (r) {
      if (!r.ok) console.log('  ✗ [' + r.group + '] ' + r.desc);
    });
  }
  process.exit(fail === 0 ? 0 : 1);
}

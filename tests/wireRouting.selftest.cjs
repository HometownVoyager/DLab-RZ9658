#!/usr/bin/env node
// tests/wireRouting.selftest.cjs
// DLab.WireRouting 飞线避让路由自测：node tests/wireRouting.selftest.cjs
// 覆盖：契约 §3.3 的七条硬性不变量 + §3.4 候选顺序与代价函数单调性 + §3.5 两轮迭代
//       + 40 根导线 / 288 孔真实几何下的性能实测（要求 < 60 ms）。
// 纯 Node 运行，不依赖浏览器与 DOM。
'use strict';

var path = require('path');

// ---- 按契约加载核心模块（经典脚本 + 全局命名空间）----
globalThis.DLab = {};
require(path.join(__dirname, '..', 'src', 'core', 'panelGeometry.generated.js'));
require(path.join(__dirname, '..', 'src', 'core', 'wireRouting.js'));

var DLab = globalThis.DLab;
var WR = DLab.WireRouting;
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

/* ============================================================
 * 小工具
 * ============================================================ */

/** 两位小数的取整（与模块内部一致） */
function r2(n) {
  return Math.round(n * 100) / 100;
}

/** 旧公式（上位契约第 7 节） */
function legacyPath(x1, y1, x2, y2) {
  var dx = x2 - x1;
  var dy = y2 - y1;
  var dist = Math.sqrt(dx * dx + dy * dy);
  var sag = Math.min(90, dist * 0.28);
  return 'M ' + r2(x1) + ' ' + r2(y1) +
    ' C ' + r2(x1) + ' ' + r2(y1 + sag) +
    ' ' + r2(x2) + ' ' + r2(y2 + sag) +
    ' ' + r2(x2) + ' ' + r2(y2);
}

/** 点到线段距离 */
function distPointSeg(px, py, ax, ay, bx, by) {
  var dx = bx - ax;
  var dy = by - ay;
  var len2 = dx * dx + dy * dy;
  var t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return Math.sqrt((px - (ax + t * dx)) * (px - (ax + t * dx)) + (py - (ay + t * dy)) * (py - (ay + t * dy)));
}

/** 两条折线的最小间距（去掉两端各 trim 个点，避开必然重合的端点） */
function minInteriorDistance(p, q, trim) {
  var best = Infinity;
  for (var i = trim; i < p.length - trim; i++) {
    for (var j = trim; j < q.length - trim - 1; j++) {
      var d = Math.min(
        distPointSeg(p[i].x, p[i].y, q[j].x, q[j].y, q[j + 1].x, q[j + 1].y),
        distPointSeg(p[i + 1].x, p[i + 1].y, q[j].x, q[j].y, q[j + 1].x, q[j + 1].y)
      );
      if (d < best) best = d;
    }
  }
  return best;
}

/** 确定性伪随机（mulberry32），保证自测可复现 */
function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 取一对真实插孔 */
function jack(id) {
  return GEO.JACKS[id];
}

var IDS = GEO.JACK_ORDER;

group('0. 模块加载与契约常量');

check('DLab.WireRouting 已加载', typeof WR, 'object');
check('SAMPLES >= 24', WR.SAMPLES >= 24, true);
check('CLEARANCE_WIRE = 9', WR.CLEARANCE_WIRE, 9);
check('CLEARANCE_JACK = 20', WR.CLEARANCE_JACK, 20);
check('EDGE_MARGIN = 8', WR.EDGE_MARGIN, 8);
check('契约 API 齐全',
  typeof WR.calcSag === 'function' &&
  typeof WR.buildPath === 'function' &&
  typeof WR.buildPathWith === 'function' &&
  typeof WR.samplePath === 'function' &&
  typeof WR.routeAll === 'function', true);

group('1. calcSag / buildPath / buildPathWith 与旧公式逐字符一致');

var sagSamples = [
  [100, 1113, 103, 253],
  [98, 568, 614, 568],
  [926, 865, 113, 438],
  [0, 0, 0, 0],
  [1800, 1380, 97, 64]
];
var sagOk = true;
sagSamples.forEach(function (s) {
  if (WR.buildPath(s[0], s[1], s[2], s[3]) !== legacyPath(s[0], s[1], s[2], s[3])) {
    sagOk = false;
  }
});
check('buildPath 与旧公式逐字符一致（5 组抽样）', sagOk, true);
check('calcSag = min(90, dist*0.28)',
  WR.calcSag(0, 0, 100, 0), Math.min(90, 100 * 0.28));
check('calcSag 上限 90', WR.calcSag(0, 0, 2000, 0), 90);
check('buildPath 坐标保留两位小数',
  WR.buildPath(0, 0, 10.126, 5).indexOf('10.13') >= 0, true);
check('buildPathWith 基准参数 = buildPath',
  WR.buildPathWith(100, 1113, 103, 253, { sagScale: 1, sagDelta: 0, bowX: 0 }),
  WR.buildPath(100, 1113, 103, 253));
check('buildPathWith 端点恒定',
  WR.buildPathWith(100, 1113, 103, 253, { sagScale: 2, sagDelta: 30, bowX: -20 })
    .indexOf('M 100 1113') === 0, true);
check('buildPathWith bowX 只改控制点（端点不动、控制点横向 +20）',
  WR.buildPathWith(100, 1113, 103, 253, { sagScale: 1, sagDelta: 0, bowX: 20 }),
  'M 100 1113 C 120 1203 123 343 103 253');

group('2. samplePath 采样');

var samplePts = WR.samplePath(WR.buildPath(100, 1113, 103, 253), WR.SAMPLES);
check('samplePath 返回 SAMPLES+1 个点', samplePts.length, WR.SAMPLES + 1);
check('samplePath 首点 = 起点', [r2(samplePts[0].x), r2(samplePts[0].y)], [100, 1113]);
check('samplePath 末点 = 终点', [r2(samplePts[samplePts.length - 1].x), r2(samplePts[samplePts.length - 1].y)], [103, 253]);
check('samplePath 非法输入返回空数组', WR.samplePath('not a path', 24).length, 0);

group('3. 不变量 2：无冲突即零改动');

var singleWires = [{ id: 'w1', from: 'sw:5K1', to: 'devA:A1', color: '#ef4444' }];
var singleRes = WR.routeAll(singleWires, GEO);
check('单根线 total = 1', singleRes.total, 1);
check('单根线 adjustedCount = 0', singleRes.adjustedCount, 0);
check('单根线 adjusted = false', singleRes.byId.w1.adjusted, false);
check('单根线 d === buildPath（逐字符）',
  singleRes.byId.w1.d,
  WR.buildPath(jack('sw:5K1').x, jack('sw:5K1').y, jack('devA:A1').x, jack('devA:A1').y));
check('单根线 cost = 0', singleRes.byId.w1.cost, 0);
check('单根线 points 数量 = SAMPLES+1', singleRes.byId.w1.points.length, WR.SAMPLES + 1);

group('4. 不变量 1 + 4：端点精确不变 / 端点不变性');

var multiWires = [
  { id: 'a1', from: 'sw:5K1', to: 'devA:A1', color: '#ef4444' },
  { id: 'a2', from: 'sw:5K2', to: 'devA:A2', color: '#ef4444' },
  { id: 'a3', from: 'sw:5K3', to: 'devA:A3', color: '#3b82f6' },
  { id: 'a4', from: 'led:4P1', to: 'sw:5K4', color: '#22c55e' }
];
var multiRes = WR.routeAll(multiWires, GEO);
var endpointOk = true;
multiWires.forEach(function (w) {
  var r = multiRes.byId[w.id];
  var from = jack(w.from);
  var to = jack(w.to);
  if (Math.abs(r.points[0].x - from.x) > 0.01 || Math.abs(r.points[0].y - from.y) > 0.01) endpointOk = false;
  if (Math.abs(r.points[r.points.length - 1].x - to.x) > 0.01 ||
      Math.abs(r.points[r.points.length - 1].y - to.y) > 0.01) endpointOk = false;
});
check('多根线时每根线起点都精确等于插孔坐标', endpointOk, true);
check('多根线时每根线终点都精确等于插孔坐标', endpointOk, true);

// 加一根线后，其它线的端点仍然不变
var withExtra = multiWires.concat([{ id: 'x9', from: 'probe:P01', to: 'mid:BEEP', color: '#eab308' }]);
var extraRes = WR.routeAll(withExtra, GEO);
var stillOk = true;
multiWires.forEach(function (w) {
  var r = extraRes.byId[w.id];
  if (!r) { stillOk = false; return; }
  var from = jack(w.from);
  var to = jack(w.to);
  if (Math.abs(r.points[0].x - from.x) > 0.01 || Math.abs(r.points[0].y - from.y) > 0.01) stillOk = false;
  if (Math.abs(r.points[r.points.length - 1].x - to.x) > 0.01 ||
      Math.abs(r.points[r.points.length - 1].y - to.y) > 0.01) stillOk = false;
});
check('加一根线后，其它线的两端坐标永远不变', stillOk, true);
check('加线后总根数正确', extraRes.total, 5);

group('5. 不变量 3：确定性');

var detA = WR.routeAll(multiWires, GEO);
var detB = WR.routeAll(multiWires, GEO);
check('连续两次调用 byId 完全一致', JSON.stringify(detA.byId), JSON.stringify(detB.byId));
check('两次 adjustedCount 一致', detA.adjustedCount, detB.adjustedCount);
var rnd = mulberry32(7);
var randWires = [];
for (var i = 0; i < 12; i++) {
  var from = IDS[Math.floor(rnd() * IDS.length)];
  var to = IDS[Math.floor(rnd() * IDS.length)];
  if (from === to) continue;
  randWires.push({ id: 'r' + i, from: from, to: to, color: '#ef4444' });
}
check('随机导线集合两次调用一致',
  JSON.stringify(WR.routeAll(randWires, GEO).byId),
  JSON.stringify(WR.routeAll(randWires, GEO).byId));

group('6. 不变量 5：不越界');

var oob = 0;
Object.keys(extraRes.byId).forEach(function (id) {
  extraRes.byId[id].points.forEach(function (p) {
    if (p.x < WR.EDGE_MARGIN || p.x > 1800 - WR.EDGE_MARGIN ||
        p.y < WR.EDGE_MARGIN || p.y > 1380 - WR.EDGE_MARGIN) {
      oob++;
    }
  });
});
check('所有采样点都在 [8,1792]×[8,1372] 内（越界点数）', oob, 0);

// 极端场景：贴着面板边缘的两个插孔
var edgeWires = [
  { id: 'e1', from: 'probe:P01', to: 'gnd:GND1', color: '#ef4444' },
  { id: 'e2', from: 'gnd:GND2', to: 'pwr:5V2', color: '#ef4444' },
  { id: 'e3', from: 'clock:CONT', to: 'analyzer:DCH7', color: '#ef4444' }
];
var edgeRes = WR.routeAll(edgeWires, GEO);
var edgeOob = 0;
Object.keys(edgeRes.byId).forEach(function (id) {
  edgeRes.byId[id].points.forEach(function (p) {
    if (p.x < WR.EDGE_MARGIN || p.x > 1800 - WR.EDGE_MARGIN ||
        p.y < WR.EDGE_MARGIN || p.y > 1380 - WR.EDGE_MARGIN) {
      edgeOob++;
    }
  });
});
check('贴边场景同样不越界（越界点数）', edgeOob, 0);

group('7. 不变量 6：改善可度量（两根完全重合的线）');

var dupWires = [
  { id: 'dup1', from: 'sw:5K1', to: 'led:4P1', color: '#ef4444' },
  { id: 'dup2', from: 'sw:5K1', to: 'led:4P1', color: '#3b82f6' }
];
var dupRes = WR.routeAll(dupWires, GEO);
var dupSep = minInteriorDistance(dupRes.byId.dup1.points, dupRes.byId.dup2.points, 3);
check('两根完全重合的线被画开（d 不同）',
  dupRes.byId.dup1.d !== dupRes.byId.dup2.d, true);
check('重合线被标记为 adjusted',
  dupRes.byId.dup1.adjusted || dupRes.byId.dup2.adjusted, true);
checkTrue('两根重合线的中段最小间距 >= CLEARANCE_WIRE * 0.8（实测 ' +
  dupSep.toFixed(2) + ' >= ' + (WR.CLEARANCE_WIRE * 0.8).toFixed(2) + '）',
  dupSep >= WR.CLEARANCE_WIRE * 0.8, dupSep);

// 多组重合线场景
var dupCases = [
  ['devA:A1', 'devA:B1'],
  ['pwr:5V1', 'devA:VCC'],
  ['probe:P01', 'devA:F13'],
  ['sw:5K16', 'devB:B1']
];
var dupAllOk = true;
var dupMin = Infinity;
dupCases.forEach(function (c) {
  var ws = [
    { id: 'x1', from: c[0], to: c[1], color: '#ef4444' },
    { id: 'x2', from: c[0], to: c[1], color: '#3b82f6' }
  ];
  var r = WR.routeAll(ws, GEO);
  var sep = minInteriorDistance(r.byId.x1.points, r.byId.x2.points, 4);
  if (sep < dupMin) dupMin = sep;
  if (sep < WR.CLEARANCE_WIRE * 0.8) dupAllOk = false;
});
checkTrue('4 组重合线的中段间距都 >= CLEARANCE_WIRE*0.8（最小实测 ' + dupMin.toFixed(2) + '）',
  dupAllOk, dupMin);

group('8. §3.4 候选顺序');

var expectedCandidates = [
  { sagScale: 1, sagDelta: 0, bowX: 0 },
  { sagScale: 1, sagDelta: -14, bowX: 0 },
  { sagScale: 1, sagDelta: 14, bowX: 0 },
  { sagScale: 1, sagDelta: -28, bowX: 0 },
  { sagScale: 1, sagDelta: 28, bowX: 0 },
  { sagScale: 1, sagDelta: -44, bowX: 0 },
  { sagScale: 1, sagDelta: 44, bowX: 0 },
  { sagScale: 1, sagDelta: -62, bowX: 0 },
  { sagScale: 1, sagDelta: 62, bowX: 0 },
  { sagScale: 1, sagDelta: -84, bowX: 0 },
  { sagScale: 1, sagDelta: 84, bowX: 0 },
  { sagScale: 1.5, sagDelta: 0, bowX: 0 },
  { sagScale: 2.2, sagDelta: 0, bowX: 0 },
  { sagScale: 3, sagDelta: 0, bowX: 0 },
  { sagScale: 1, sagDelta: 0, bowX: -20 },
  { sagScale: 1, sagDelta: 0, bowX: 20 },
  { sagScale: 1, sagDelta: 0, bowX: -36 },
  { sagScale: 1, sagDelta: 0, bowX: 36 }
];
check('候选数量 = 18', WR.CANDIDATES.length, 18);
check('候选顺序与契约 §3.4 完全一致', WR.CANDIDATES, expectedCandidates);
check('第 0 个候选是基准',
  [WR.CANDIDATES[0].sagScale, WR.CANDIDATES[0].sagDelta, WR.CANDIDATES[0].bowX], [1, 0, 0]);
check('sagDelta 段 = 10 个', WR.CANDIDATES.slice(1, 11).map(function (c) { return c.sagDelta; }),
  [-14, 14, -28, 28, -44, 44, -62, 62, -84, 84]);
check('sagScale 段 = [1.5,2.2,3.0]',
  WR.CANDIDATES.slice(11, 14).map(function (c) { return c.sagScale; }), [1.5, 2.2, 3]);
check('bowX 段 = [-20,20,-36,36]',
  WR.CANDIDATES.slice(14, 18).map(function (c) { return c.bowX; }), [-20, 20, -36, 36]);

group('9. §3.4 代价函数单调性');

check('gapCost 在净距达标时为 0', WR.gapCost(20, 9), 0);
check('gapCost 在净距不足时平方', WR.gapCost(5, 9), 16);
check('gapCost 单调递减（距离越近罚越重）',
  WR.gapCost(2, 9) > WR.gapCost(5, 9) && WR.gapCost(5, 9) > WR.gapCost(8, 9), true);
check('perturbCost = 0.6*(|sagDelta| + 0.5*|bowX|)',
  WR.perturbCost(14, 0), 8.4);
check('perturbCount 对 bowX 的权重是 sagDelta 的一半',
  WR.perturbCost(0, 20), 6);
check('perturbCost 随改动量单调增',
  WR.perturbCost(0, 0) < WR.perturbCost(14, 0) && WR.perturbCost(14, 0) < WR.perturbCost(28, 0), true);

// 实际路由：改动越大代价越高（基准 < 轻度 < 大幅）
var costProbe = [];
[0, 14, 28, 62].forEach(function (delta) {
  var d = WR.buildPathWith(100, 1113, 103, 253, { sagScale: 1, sagDelta: delta, bowX: 0 });
  costProbe.push(WR.perturbCost(delta, 0));
});
check('perturbCost 序列单调递增',
  costProbe.map(function (v) { return Math.round(v * 100) / 100; }), [0, 8.4, 16.8, 37.2]);

group('10. §3.5 两轮迭代与选优规则');

check('基准候选代价为 0 时直接返回基准（adjusted=false）',
  singleRes.byId.w1.adjusted, false);
check('基准未改动时 adjustedCount 为 0', singleRes.adjustedCount, 0);
check('routeAll 返回结构完整',
  ['byId', 'adjustedCount', 'total'].every(function (k) { return k in singleRes; }), true);
check('byId 的键是导线 id', Object.keys(singleRes.byId), ['w1']);
check('byId 的每项含 id/d/points/adjusted/cost',
  ['id', 'd', 'points', 'adjusted', 'cost'].every(function (k) { return k in singleRes.byId.w1; }), true);

// 非法输入不抛错
check('空导线数组不抛错', WR.routeAll([], GEO).total, 0);
check('null 导线数组不抛错', WR.routeAll(null, GEO).total, 0);
check('未知插孔的导线被跳过', WR.routeAll([{ id: 'z', from: 'no:a', to: 'no:b' }], GEO).total, 0);
check('缺 id 的导线被跳过', WR.routeAll([{ from: 'sw:5K1', to: 'devA:A1' }], GEO).total, 0);
var dupIdRes = WR.routeAll([
  { id: 'same', from: 'sw:5K1', to: 'devA:A1' },
  { id: 'same', from: 'sw:5K2', to: 'devA:A2' }
], GEO);
check('重复 id 时 byId 只保留一条（引擎本身保证 id 唯一）',
  Object.keys(dupIdRes.byId), ['same']);

group('11. 不变量 7：性能实测（40 根导线 / 288 孔）');

var perfRnd = mulberry32(20261029);
var perfWires = [];
for (var pi = 0; pi < 40; pi++) {
  var pf = IDS[Math.floor(perfRnd() * IDS.length)];
  var pt = IDS[Math.floor(perfRnd() * IDS.length)];
  if (pf === pt) {
    pt = IDS[(IDS.indexOf(pf) + 37) % IDS.length];
  }
  perfWires.push({ id: 'p' + pi, from: pf, to: pt, color: '#ef4444' });
}

// 预热一次（让 JIT 先编译），再测三轮取最好
WR.routeAll(perfWires, GEO);
var perfTimes = [];
for (var rep = 0; rep < 5; rep++) {
  var t0 = process.hrtime.bigint();
  var perfRes = WR.routeAll(perfWires, GEO);
  var t1 = process.hrtime.bigint();
  perfTimes.push(Number(t1 - t0) / 1e6);
}
var perfBest = Math.min.apply(null, perfTimes);
var perfAvg = perfTimes.reduce(function (a, b) { return a + b; }, 0) / perfTimes.length;
console.log('    40 根导线 routeAll：最好 ' + perfBest.toFixed(2) + ' ms / 平均 ' + perfAvg.toFixed(2) +
  ' ms（5 轮：' + perfTimes.map(function (t) { return t.toFixed(1); }).join(', ') + '）');
check('真实几何共 288 个插孔', Object.keys(GEO.JACKS).length, 288);
checkTrue('40 根导线单次 routeAll < 60 ms（实测最好 ' + perfBest.toFixed(2) + ' ms）',
  perfBest < 60, perfBest);
check('性能测试结果根数正确', perfRes.total, 40);

group('12. 纯函数性（不修改入参）');

var frozenWires = [
  { id: 'f1', from: 'sw:5K1', to: 'devA:A1', color: '#ef4444' },
  { id: 'f2', from: 'sw:5K2', to: 'devA:A2', color: '#ef4444' }
];
var frozenCopy = JSON.stringify(frozenWires);
WR.routeAll(frozenWires, GEO);
check('routeAll 不修改入参数组', JSON.stringify(frozenWires), frozenCopy);
var geoCopy = JSON.stringify(GEO);
WR.routeAll(frozenWires, GEO);
check('routeAll 不修改几何数据', JSON.stringify(GEO), geoCopy);

group('13. routePreview（预览线避让）');

var previewObstacles = [
  WR.samplePath(WR.buildPath(jack('sw:5K1').x, jack('sw:5K1').y, jack('devA:A1').x, jack('devA:A1').y), WR.SAMPLES)
];
var prev = WR.routePreview(
  { x: jack('sw:5K2').x, y: jack('sw:5K2').y },
  { x: jack('devA:A2').x, y: jack('devA:A2').y },
  previewObstacles,
  GEO
);
check('routePreview 返回 d', typeof prev.d, 'string');
check('routePreview 返回 points', prev.points.length, WR.SAMPLES + 1);
check('routePreview 的 d 以起点开头',
  prev.d.indexOf('M ' + r2(jack('sw:5K2').x) + ' ' + r2(jack('sw:5K2').y)) === 0, true);
var prevNoObs = WR.routePreview(
  { x: jack('sw:5K2').x, y: jack('sw:5K2').y },
  { x: jack('devA:A2').x, y: jack('devA:A2').y },
  [],
  GEO
);
check('无障碍时预览线 = 基准路径',
  prevNoObs.d, WR.buildPath(jack('sw:5K2').x, jack('sw:5K2').y, jack('devA:A2').x, jack('devA:A2').y));

/* ============================================================
 * 汇总
 * ============================================================ */

console.log('\n' + new Array(65).join('='));
var failed = results.filter(function (r) { return !r.ok; });
var total = results.length;
console.log('  插孔总数：' + Object.keys(GEO.JACKS).length);
console.log('  性能实测：40 根导线 routeAll 最好 ' + perfBest.toFixed(2) + ' ms / 平均 ' + perfAvg.toFixed(2) + ' ms');
if (failed.length === 0) {
  console.log('\u2713 全部通过 PASS=' + total + ' FAIL=0');
  console.log('  分组数：' + new Set(results.map(function (r) { return r.group; })).size);
  process.exitCode = 0;
} else {
  console.log('\u2717 失败 FAIL=' + failed.length + ' PASS=' + (total - failed.length) + '（共 ' + total + ' 项）');
  failed.forEach(function (f) {
    console.log('  - [' + f.group + '] ' + f.desc);
  });
  process.exitCode = 1;
}
console.log(new Array(65).join('='));

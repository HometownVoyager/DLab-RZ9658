// tests/engine.integration.cjs —— 与 geometry-pipeline 产出的真实几何数据集成冒烟
'use strict';
var path = require('path');
globalThis.DLab = {};
require(path.join(__dirname, '..', 'src', 'core', 'logic.js'));
require(path.join(__dirname, '..', 'src', 'core', 'chips.js'));
require(path.join(__dirname, '..', 'src', 'core', 'panelGeometry.generated.js'));
require(path.join(__dirname, '..', 'src', 'core', 'engine.js'));

var DLab = globalThis.DLab;
var geo = DLab.geometry;
var Engine = DLab.Engine;

var fails = 0;
function check(desc, cond, extra) {
  if (cond) { console.log('  \u2713 ' + desc); }
  else { fails++; console.log('  \u2717 ' + desc + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

console.log('\u25B8 真实几何数据集成冒烟');
check('DLab.geometry 存在', !!geo);
var ids = Object.keys(geo.JACKS);
console.log('  插孔总数: ' + ids.length);
check('插孔总数 >= 280', ids.length >= 280, ids.length);

var e = new Engine({ geometry: geo });
var st = e.step(0);
check('引擎可用真实几何构造', !!st && !!st.jacks);
check('插孔电平表覆盖全部插孔', Object.keys(st.jacks).length === ids.length,
  [Object.keys(st.jacks).length, ids.length]);

// 电源 / 地
check('pwr:5V1 = 1', e.getJackLevel('pwr:5V1') === '1', e.getJackLevel('pwr:5V1'));
check('gnd:GND1 = 0', e.getJackLevel('gnd:GND1') === '0', e.getJackLevel('gnd:GND1'));
check('devA:VCC = 1', e.getJackLevel('devA:VCC') === '1', e.getJackLevel('devA:VCC'));
check('devB:GND = 0', e.getJackLevel('devB:GND') === '0', e.getJackLevel('devB:GND'));

// 真实插孔名抽查
var probes = ['sw:5K1', 'sw:5K16', 'led:4P1', 'led:4P16', 'clock:1HZ', 'clock:CONT',
  'pulse:6K1+', 'pulse:6K6-', 'seg1:A1', 'seg1:DP1', 'seg2:A2', 'seg3:A3',
  'seg8:DP8', 'devA:A1', 'devA:B14', 'devA:E16', 'devA:D16', 'devA:F20',
  'devB:A1', 'devB:F20', 'analyzer:DCH0', 'analyzer:DCH7', 'probe:P01', 'mid:SPK'];
var missing = probes.filter(function (id) { return !e.hasJack(id); });
check('关键插孔全部存在', missing.length === 0, missing);

// 插座映射
var mapOk = true, mapDetail = [];
[['devA:UA', 1, 'devA:A1'], ['devA:UA', 14, 'devA:A14'],
 ['devB:UB', 7, 'devB:B7'], ['devA:UE', 16, 'devA:E16'],
 ['devA:UD', 1, 'devA:D1'], ['devB:UF', 20, 'devB:F20']].forEach(function (t) {
  var got = e.socketJack(t[0], t[1]);
  if (got !== t[2]) { mapOk = false; mapDetail.push(t[0] + '#' + t[1] + ' -> ' + got + '（期望 ' + t[2] + '）'); }
});
check('插座 <-> 插孔映射符合契约 4.2', mapOk, mapDetail);

// 真实几何下的完整演示接线：5K1 -> 74LS00 -> 4L1
e.addWire({ id: 'w1', from: 'sw:5K1', to: 'devA:A1' });
e.addWire({ id: 'w2', from: 'sw:5K1', to: 'devA:A2' });
e.addWire({ id: 'w3', from: 'devA:A14', to: 'pwr:5V1' });
e.addWire({ id: 'w4', from: 'devA:A7', to: 'gnd:GND1' });
e.addWire({ id: 'w5', from: 'devA:A3', to: 'led:4P1' });
e.mountChip('devA:UA', '74LS00');
e.setSwitch(1, 1);
st = e.step(0);
check('5K1=1 经与非门反相 -> 4L1 灭', st.leds['4L1'] === false, st.leds['4L1']);
e.setSwitch(1, 0);
st = e.step(1);
check('5K1=0 经与非门反相 -> 4L1 亮', st.leds['4L1'] === true, st.leds['4L1']);

// 真实几何下 seg5 的 DP5 是否存在（契约提示可能是 GND 环）
console.log('  seg5:DP5 是否存在于几何: ' + e.hasJack('seg5:DP5'));
check('seg5:DP5 缺失时容错为 Z', st.segs.seg5.dp === 'Z', st.segs.seg5.dp);

// seg1 段码直驱
e.addWire({ id: 's1', from: 'seg1:A1', to: 'gnd:GND1' });
st = e.step(2);
check('seg1 共阳：A1 接地 -> segOn.a 亮', st.segOn.seg1.a === true, st.segOn.seg1);
check('segs.seg1.a 原始电平 = 0', st.segs.seg1.a === '0', st.segs.seg1.a);

// VCC-GND 短路
e.addWire({ id: 'short', from: 'pwr:5V1', to: 'gnd:GND1' });
st = e.step(3);
check('真实几何下 VCC-GND 短接 -> shorts 非空', st.shorts.length > 0, st.shorts.length);
check('短路网电平 X', st.jacks['pwr:5V1'] === 'X', st.jacks['pwr:5V1']);

// 性能：连续 600 步
var t0 = Date.now();
for (var i = 0; i < 600; i++) e.step(i * 16);
var dt = Date.now() - t0;
console.log('  600 步耗时: ' + dt + ' ms（约 ' + (dt / 600).toFixed(3) + ' ms/步）');
check('600 步耗时 < 3000ms', dt < 3000, dt);

console.log('');
if (fails === 0) { console.log('\u2713 集成冒烟全部通过'); process.exitCode = 0; }
else { console.log('\u2717 集成冒烟失败 ' + fails + ' 项'); process.exitCode = 1; }

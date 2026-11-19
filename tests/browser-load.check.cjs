// 临时验证：模拟浏览器 file:// 下按 index.html 顺序加载四个经典脚本
var fs = require('fs');
var vm = require('vm');
var base = require('path').join(__dirname, '..');

// 构造一个最小的浏览器式全局环境（无 require / module / process）
var sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
var ctx = vm.createContext(sandbox);

var files = [
  'src/core/panelGeometry.generated.js',
  'src/core/logic.js',
  'src/core/chips.js',
  'src/core/engine.js',
  'src/core/wireRouting.js',
  'src/core/advisor.js',
  'src/core/grader.js',
  'src/core/quiz.js'
];

var ok = true;
files.forEach(function (f) {
  try {
    var code = fs.readFileSync(require('path').join(base, f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
    console.log('  \u2713 加载成功: ' + f);
  } catch (e) {
    ok = false;
    console.log('  \u2717 加载失败: ' + f + ' -> ' + e.message);
  }
});

if (!ok) { console.log('\u2717 经典脚本加载失败'); process.exitCode = 1; return; }

// 在沙箱内验证命名空间与基本 API
var checkCode = [
  'var r = {};',
  'r.hasDLab = typeof DLab === "object";',
  'r.hasLogic = typeof DLab.Logic === "object";',
  'r.hasChips = typeof DLab.Chips === "object";',
  'r.hasEngine = typeof DLab.Engine === "function";',
  'r.hasGeometry = typeof DLab.geometry === "object";',
  'var e = new DLab.Engine({ geometry: DLab.geometry });',
  'e.addWire({ id: "w1", from: "sw:5K1", to: "devA:A1" });',
  'e.setSwitch(1, 1);',
  'var st = e.step(0);',
  'r.wireLevel = st.jacks["devA:A1"];',
  'r.ledCount = Object.keys(st.leds).length;',
  'r.segCount = Object.keys(st.segs).length;',
  'r.jackCount = Object.keys(st.jacks).length;',
  'r.hasSegOn = !!st.segOn;',
  'r.hasWireRouting = typeof DLab.WireRouting === "object" && typeof DLab.WireRouting.routeAll === "function";',
  'r.hasAdvisor = typeof DLab.Advisor === "object" && typeof DLab.Advisor.review === "function";',
  'r.hasGrader = typeof DLab.Grader === "object" && typeof DLab.Grader.grade === "function";',
  'r.hasQuiz = typeof DLab.Quiz === "object" && typeof DLab.Quiz.generate === "function";',
  'r.api = ["addWire","removeWire","getWires","setSwitch","getSwitch","pressPulse",',
  '  "setPower","setClockEnabled","mountChip","unmountChip","getChip","step",',
  '  "getJackLevel","getState","onStateUpdate","reset"].every(function(k){ return typeof e[k] === "function"; });',
  'r'
].join('\n');

var res = vm.runInContext(checkCode, ctx);
console.log('');
console.log('  DLab 命名空间: ' + res.hasDLab + ' / Logic: ' + res.hasLogic +
  ' / Chips: ' + res.hasChips + ' / Engine: ' + res.hasEngine + ' / geometry: ' + res.hasGeometry);
console.log('  导线连通后 devA:A1 电平: ' + res.wireLevel);
console.log('  leds 键数: ' + res.ledCount + ' / segs 键数: ' + res.segCount +
  ' / segOn 存在: ' + res.hasSegOn + ' / 插孔数: ' + res.jackCount);
console.log('  契约 API 齐全: ' + res.api);
console.log('  第四阶段模块: WireRouting=' + res.hasWireRouting +
  ' Advisor=' + res.hasAdvisor + ' Grader=' + res.hasGrader + ' Quiz=' + res.hasQuiz);

var allOk = res.hasDLab && res.hasLogic && res.hasChips && res.hasEngine && res.hasGeometry &&
  res.wireLevel === '1' && res.ledCount === 16 && res.segCount === 8 && res.hasSegOn && res.api &&
  res.hasWireRouting && res.hasAdvisor && res.hasGrader && res.hasQuiz;
console.log('');
console.log(allOk ? '\u2713 浏览器式经典脚本加载 + 引擎可用' : '\u2717 浏览器式加载验证失败');
process.exitCode = allOk ? 0 : 1;

#!/usr/bin/env node
// tests/chips.selftest.cjs
// 芯片库零依赖自测：node tests/chips.selftest.cjs
// 覆盖第三阶段新增的 6 款 16 脚芯片：74LS112 / 74LS153 / 74LS148 / 74LS283 / 74LS194 / 74LS160
// 每款都测：真值表关键行、使能端、未知电平（X）传播；112 / 160 / 194 额外测时钟边沿时序。
// 2026-10-30 审查新增：74LS21 / 74LS30 / 74LS47 / 74LS48（对应真实 LCD 菜单 7421/7430/7447/7448），
//   47/48 段码取自 Renesas HD74LS47 数据手册 Function Table（与 eepw 7448 表交叉一致）。
'use strict';

var path = require('path');

// ---- 按契约加载核心模块（经典脚本 + 全局命名空间）----
globalThis.DLab = {};
require(path.join(__dirname, '..', 'src', 'core', 'logic.js'));
require(path.join(__dirname, '..', 'src', 'core', 'chips.js'));

var DLab = globalThis.DLab;
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

/* ============================================================
 * 测试夹具：直接调用芯片定义的 eval，不经过引擎
 *   pinLevels 是「引脚号 -> 四态电平」的稀疏表，缺省引脚一律按 'Z'（TTL 下等于 1）。
 *   ctx 由我们手工维护，模拟引擎为每颗芯片保存的持久上下文。
 * ============================================================ */

/** 新建一个芯片求值上下文 */
function newCtx(opts) {
  opts = opts || {};
  return { state: {}, isTTL: opts.isTTL === undefined ? true : !!opts.isTTL };
}

/**
 * 取芯片定义并求值一次。
 * @param {string} model 型号
 * @param {object} pins  引脚电平表（引脚号 -> '0'|'1'|'Z'|'X'）
 * @param {object} ctx   上下文
 * @returns {object} 输出引脚电平表
 */
function evalChip(model, pins, ctx) {
  var def = Chips.get(model);
  if (!def) throw new Error('未注册的型号：' + model);
  return def.eval(pins, ctx || newCtx());
}

/** 取某型号定义，不存在直接抛错（让测试失败得明确） */
function defOf(model) {
  var def = Chips.get(model);
  if (!def) throw new Error('未注册的型号：' + model);
  return def;
}

/** 组装引脚电平表：对象键为引脚号（数字或数字字符串），值为电平 */
function mk(map) {
  var out = {};
  for (var k in map) {
    if (Object.prototype.hasOwnProperty.call(map, k)) out[k] = map[k];
  }
  return out;
}

/* ============================================================
 * 1. 芯片库注册与元数据
 * ============================================================ */

group('1. 芯片库注册与元数据');

var NEW_MODELS = ['74LS112', '74LS148', '74LS153', '74LS160', '74LS194', '74LS283'];

checkTrue('6 款新芯片全部已注册',
  NEW_MODELS.every(function (m) { return Chips.has(m); }),
  NEW_MODELS.filter(function (m) { return !Chips.has(m); }));

checkTrue('NE555 未被注册（本实验箱没有 8 脚插座）', Chips.has('NE555') === false);
check('NE555 查不到定义时返回 null', Chips.get('NE555'), null);

check('6 款新芯片全部为 16 脚',
  NEW_MODELS.map(function (m) { return Chips.packageOf(m); }),
  [16, 16, 16, 16, 16, 16]);

checkTrue('每款新芯片都有 pins 数组 1..16',
  NEW_MODELS.every(function (m) {
    var d = defOf(m);
    return Array.isArray(d.pins) && d.pins.length === 16 &&
      d.pins[0] === 1 && d.pins[15] === 16;
  }));

check('6 款新芯片的 VCC 引脚都是 16',
  NEW_MODELS.map(function (m) { return defOf(m).vccPin; }),
  [16, 16, 16, 16, 16, 16]);

check('6 款新芯片的 GND 引脚都是 8',
  NEW_MODELS.map(function (m) { return defOf(m).gndPin; }),
  [8, 8, 8, 8, 8, 8]);

checkTrue('每款新芯片的 pinNames 都包含 VCC=16 与 GND=8',
  NEW_MODELS.every(function (m) {
    var n = defOf(m).pinNames;
    return n.VCC === 16 && n.GND === 8;
  }));

checkTrue('每款新芯片的 pinNames 引脚号都在 1..16 且互不重复',
  NEW_MODELS.every(function (m) {
    var n = defOf(m).pinNames;
    var seen = {};
    for (var k in n) {
      if (!Object.prototype.hasOwnProperty.call(n, k)) continue;
      var v = n[k];
      if (typeof v !== 'number' || v < 1 || v > 16) return false;
      if (seen[v]) return false;
      seen[v] = true;
    }
    return true;
  }));

check('74LS160 与 74LS161 的引脚名表完全一致',
  JSON.stringify(Chips.pinNamesOf('74LS160')), JSON.stringify(Chips.pinNamesOf('74LS161')));

/* ============================================================
 * 2. 74LS112 双 J-K 负沿触发器
 * ============================================================ */

group('2. 74LS112 双 J-K 负沿触发器');

// 引脚约定：~1CLR=1, 1J=2, 1K=3, 1CLK=4, ~1PRE=5, 1Q=6, ~1Q=7, GND=8,
//           ~2Q=9, 2Q=10, ~2PRE=11, 2CLK=12, 2J=13, 2K=14, ~2CLR=15, VCC=16
(function () {
  var M = '74LS112';

  check('74LS112 引脚名表（~1CLR/1J/1K/1CLK/~1PRE/1Q/~1Q）',
    ['~1CLR', '1J', '1K', '1CLK', '~1PRE', '1Q', '~1Q'].map(function (k) {
      return defOf(M).pinNames[k];
    }), [1, 2, 3, 4, 5, 6, 7]);

  check('74LS112 引脚名表（~2Q/2Q/~2PRE/2CLK/2J/2K/~2CLR）',
    ['~2Q', '2Q', '~2PRE', '2CLK', '2J', '2K', '~2CLR'].map(function (k) {
      return defOf(M).pinNames[k];
    }), [9, 10, 11, 12, 13, 14, 15]);

  /**
   * 跑一次触发器时序：
   *   先把时钟拉到高、再拉到低（产生下降沿），返回 Q（引脚 6）。
   *   clk 引脚：4 = 1CLK，12 = 2CLK；j/k 同理。
   */
  function ff112(ctx, opts) {
    var c = ctx || newCtx();
    var clk = opts.clkPin || 4;
    var jPin = opts.jPin || 2;
    var kPin = opts.kPin || 3;
    var prePin = opts.prePin || 5;
    var clrPin = opts.clrPin || 1;
    var qPin = opts.qPin || 6;
    var qnPin = opts.qnPin || 7;
    var base = {};
    base[prePin] = '1';    // 异步端默认无效
    base[clrPin] = '1';
    base[jPin] = opts.j === undefined ? '0' : opts.j;
    base[kPin] = opts.k === undefined ? '0' : opts.k;
    var out = {};

    // 时钟先到高电平（建立 J/K），再到低电平（产生下降沿）
    base[clk] = '1';
    evalChip(M, base, c);
    base[clk] = '0';
    out = evalChip(M, base, c);
    return { q: out[qPin], qn: out[qnPin], ctx: c, levels: base };
  }

  // ---- 真值表关键行（下降沿后）----
  var r;

  r = ff112(null, { j: '0', k: '0' });
  check('J=0 K=0 下降沿后保持 0（初态 0）', r.q, '0');

  r = ff112(null, { j: '1', k: '0' });
  check('J=1 K=0 下降沿后置 1', r.q, '1');
  check('J=1 K=0 时 ~Q 输出 0', r.qn, '0');

  r = ff112(null, { j: '0', k: '1' });
  check('J=0 K=1 下降沿后清零（初态 0 仍为 0）', r.q, '0');

  r = ff112(null, { j: '1', k: '1' });
  check('J=1 K=1 下降沿后翻转 0 -> 1', r.q, '1');

  // 保持与清零用同一个 ctx 连续走：1 -> 保持 1
  (function () {
    var c = newCtx();
    var a = ff112(c, { j: '1', k: '0' });     // 置 1
    var b = ff112(c, { j: '0', k: '0' });     // 保持
    check('J=0 K=0 保持上一拍的 1', [a.q, b.q], ['1', '1']);
    var d = ff112(c, { j: '0', k: '1' });     // 清 0
    check('J=0 K=1 从 1 清零到 0', d.q, '0');
    var e = ff112(c, { j: '1', k: '1' });     // 翻转 0 -> 1
    check('J=1 K=1 从 0 翻转到 1', e.q, '1');
    var f = ff112(c, { j: '1', k: '1' });     // 再翻转 1 -> 0
    check('J=1 K=1 连续翻转回到 0', f.q, '0');
  })();

  // ---- 边沿：只在下降沿动作 ----
  (function () {
    var c = newCtx();
    // 先建立初态 Q=0（默认）
    evalChip(M, mk({ 1: '1', 5: '1', 2: '1', 3: '0', 4: '1' }), c);   // CLK 高
    var afterHigh = evalChip(M, mk({ 1: '1', 5: '1', 2: '1', 3: '0', 4: '1' }), c);
    check('时钟保持高电平不触发（Q 仍为 0）', afterHigh[6], '0');

    // 上升沿（0 -> 1）不应触发：先给低，再给高
    evalChip(M, mk({ 1: '1', 5: '1', 2: '1', 3: '0', 4: '0' }), c);   // 这个下降沿会置 1
    var afterDown = evalChip(M, mk({ 1: '1', 5: '1', 2: '1', 3: '0', 4: '0' }), c);
    check('下降沿（1->0）触发置位 Q=1', afterDown[6], '1');

    // 现在 J=0,K=1，上升沿不该清零
    var afterUp = evalChip(M, mk({ 1: '1', 5: '1', 2: '0', 3: '1', 4: '1' }), c);
    check('上升沿（0->1）不触发，Q 保持 1', afterUp[6], '1');
  })();

  // ---- 异步 ~CLR / ~PRE ----
  (function () {
    var c = newCtx();
    // 先置 1
    ff112(c, { j: '1', k: '0' });
    // ~CLR=0，且时钟保持不动
    var clr = evalChip(M, mk({ 1: '0', 5: '1', 2: '1', 3: '0', 4: '1' }), c);
    check('~CLR=0 异步清零（与时钟无关）Q=0', clr[6], '0');
    check('~CLR=0 时 ~Q=1', clr[7], '1');

    // ~PRE=0 异步置 1
    var pre = evalChip(M, mk({ 1: '1', 5: '0', 2: '0', 3: '1', 4: '1' }), c);
    check('~PRE=0 异步置位（与时钟无关）Q=1', pre[6], '1');

    // 两者同时有效 -> 置位优先
    var both = evalChip(M, mk({ 1: '0', 5: '0', 2: '0', 3: '1', 4: '1' }), c);
    check('~PRE 与 ~CLR 同时为 0 时置位优先 Q=1', both[6], '1');

    // 异步端未知 -> 输出未知
    var unk = evalChip(M, mk({ 1: 'X', 5: '1', 2: '1', 3: '0', 4: '1' }), c);
    check('~CLR=X 时输出未知 Q=X', unk[6], 'X');
  })();

  // ---- 第二个触发器独立工作 ----
  (function () {
    var c = newCtx();
    var out = evalChip(M, mk({
      1: '1', 5: '1',        // 触发器 1 异步端无效
      15: '1', 11: '1',      // 触发器 2 异步端无效
      13: '1', 14: '0',      // 2J=1, 2K=0
      12: '1'                // 2CLK 高
    }), c);
    check('触发器 2 时钟高电平时不动作（2Q=0）', out[10], '0');
    out = evalChip(M, mk({
      1: '1', 5: '1',
      15: '1', 11: '1',
      13: '1', 14: '0',
      12: '0'                // 2CLK 下降沿
    }), c);
    check('触发器 2 下降沿置位 2Q=1', out[10], '1');
    check('触发器 2 置位后 ~2Q=0', out[9], '0');
    checkTrue('触发器 2 动作时触发器 1 不受影响（1Q 仍为 0）', out[6] === '0', out[6]);
  })();

  // ---- 未知 J/K 传播 ----
  (function () {
    var c = newCtx();
    var out = evalChip(M, mk({ 1: '1', 5: '1', 2: 'X', 3: '0', 4: '1' }), c);
    out = evalChip(M, mk({ 1: '1', 5: '1', 2: 'X', 3: '0', 4: '0' }), c);
    check('J=X 时下降沿后输出未知 Q=X', out[6], 'X');
  })();

  // ---- 悬空输入按 TTL 当高电平：J、K 都悬空 = J=1,K=1 -> 翻转 ----
  (function () {
    var c = newCtx();
    var out = evalChip(M, mk({ 1: '1', 5: '1', 4: '1' }), c);   // J/K 悬空
    out = evalChip(M, mk({ 1: '1', 5: '1', 4: '0' }), c);
    check('J/K 悬空（TTL 当 1）下降沿后翻转 0 -> 1', out[6], '1');
  })();

  // ---- 穷举 JK 次态表（J、K、Q 初态各 2 种 = 8 组）----
  (function () {
    var bad = [];
    ['0', '1'].forEach(function (q0) {
      ['0', '1'].forEach(function (j) {
        ['0', '1'].forEach(function (k) {
          // 直接把初态写进 ctx，再从高电平走到低电平制造下降沿
          var ctx = { state: { q1: q0, cp1: '1' }, isTTL: true };
          var out = evalChip(M, mk({ 1: '1', 5: '1', 2: j, 3: k, 4: '0' }), ctx);
          // 期望次态：00 保持、10 置 1、01 清 0、11 翻转
          var want;
          if (j === '0' && k === '0') want = q0;
          else if (j === '1' && k === '0') want = '1';
          else if (j === '0' && k === '1') want = '0';
          else want = (q0 === '0') ? '1' : '0';
          if (out[6] !== want) bad.push('Q0=' + q0 + ' J=' + j + ' K=' + k + ' 得' + out[6] + ' 期望' + want);
        });
      });
    });
    checkTrue('穷举 JK 次态表 8 组全部正确', bad.length === 0, bad);
  })();
})();

/* ============================================================
 * 3. 74LS153 双 4 选 1 数据选择器
 * ============================================================ */

group('3. 74LS153 双 4 选 1 数据选择器');

(function () {
  var M = '74LS153';
  // ~1G=1, B=2, 1C3=3, 1C2=4, 1C1=5, 1C0=6, 1Y=7, GND=8,
  // 2Y=9, 2C0=10, 2C1=11, 2C2=12, 2C3=13, A=14, ~2G=15, VCC=16

  check('74LS153 引脚名表（~1G/B/1C3/1C2/1C1/1C0/1Y）',
    ['~1G', 'B', '1C3', '1C2', '1C1', '1C0', '1Y'].map(function (k) {
      return defOf(M).pinNames[k];
    }), [1, 2, 3, 4, 5, 6, 7]);

  check('74LS153 引脚名表（2Y/2C0/2C1/2C2/2C3/A/~2G）',
    ['2Y', '2C0', '2C1', '2C2', '2C3', 'A', '~2G'].map(function (k) {
      return defOf(M).pinNames[k];
    }), [9, 10, 11, 12, 13, 14, 15]);

  /** 第一组：~1G=0 使能，A/B 给地址，1C0..1C3 给数据，返回 1Y */
  function mux1(a, b, c0, c1, c2, c3, en) {
    var out = evalChip(M, mk({
      1: en === undefined ? '0' : en,
      2: b, 14: a,
      6: c0, 5: c1, 4: c2, 3: c3,
      15: '1'          // 第二组禁用，避免干扰
    }), newCtx());
    return out[7];
  }

  check('地址 BA=00 选中 1C0', mux1('0', '0', '1', '0', '0', '0'), '1');
  check('地址 BA=01 选中 1C1', mux1('1', '0', '0', '1', '0', '0'), '1');
  check('地址 BA=10 选中 1C2', mux1('0', '1', '0', '0', '1', '0'), '1');
  check('地址 BA=11 选中 1C3', mux1('1', '1', '0', '0', '0', '1'), '1');

  check('地址 BA=00 时 1C1 的值被忽略（仍取 1C0=0）',
    mux1('0', '0', '0', '1', '1', '1'), '0');
  check('地址 BA=11 时取 1C3=0 而其余为 1',
    mux1('1', '1', '1', '1', '1', '0'), '0');

  // 使能端
  check('~1G=1 时禁止，1Y 恒为 0（数据手册规定，不是高阻）',
    mux1('0', '0', '1', '1', '1', '1', '1'), '0');
  check('~1G=X 时 1Y 未知', mux1('0', '0', '1', '1', '1', '1', 'X'), 'X');
  check('地址 A=X 时 1Y 未知', mux1('X', '0', '1', '0', '0', '0'), 'X');
  check('地址 B=X 时 1Y 未知', mux1('0', 'X', '1', '0', '0', '0'), 'X');
  check('被选中的数据端为 X 时 1Y 未知', mux1('0', '0', 'X', '0', '0', '0'), 'X');
  check('未被选中的数据端为 X 不影响输出', mux1('0', '0', '1', 'X', 'X', 'X'), '1');

  // 第二组独立
  (function () {
    var out = evalChip(M, mk({
      1: '1',            // 第一组禁用
      15: '0',           // 第二组使能
      14: '1', 2: '0',   // A=1, B=0 -> 地址 01
      10: '0', 11: '1', 12: '0', 13: '0'   // 2C0..2C3 = 0,1,0,0
    }), newCtx());
    check('第二组地址 01 选中 2C1=1', out[9], '1');
    check('第一组被禁用时 1Y=0', out[7], '0');
  })();

  // 两组同时使能，互不干扰
  (function () {
    var out = evalChip(M, mk({
      1: '0', 15: '0',
      14: '0', 2: '0',   // 地址 00
      6: '1', 5: '0', 4: '0', 3: '0',       // 1C0 = 1
      10: '0', 11: '0', 12: '0', 13: '0'    // 2C0 = 0
    }), newCtx());
    check('两组同地址下输出各自独立', [out[7], out[9]], ['1', '0']);
  })();

  // 悬空（TTL 当 1）：地址悬空 = BA=11 -> 选中 C3；C3 悬空 = 1
  check('地址与数据端全悬空（TTL 当 1）-> 地址 11 选中 1C3=1',
    (function () {
      var out = evalChip(M, mk({ 1: '0', 15: '1' }), newCtx());
      return out[7];
    })(), '1');
})();

/* ============================================================
 * 4. 74LS148 8-3 优先编码器
 * ============================================================ */

group('4. 74LS148 8-3 优先编码器');

(function () {
  var M = '74LS148';
  // ~I7=1, ~I6=2, ~I5=3, ~I4=4, ~EI=5, ~I3=6, ~I2=7, GND=8,
  // ~I1=9, ~I0=10, A2=11, A1=12, A0=13, GS=14, EO=15, VCC=16
  var I_PINS = [10, 9, 7, 6, 4, 3, 2, 1];   // I0..I7

  check('74LS148 引脚名表（~EI/A0/A1/A2/GS/EO）',
    ['~EI', 'A0', 'A1', 'A2', 'GS', 'EO'].map(function (k) {
      return defOf(M).pinNames[k];
    }), [5, 13, 12, 11, 14, 15]);

  check('74LS148 引脚名表（~I0..~I7）',
    ['~I0', '~I1', '~I2', '~I3', '~I4', '~I5', '~I6', '~I7'].map(function (k) {
      return defOf(M).pinNames[k];
    }), [10, 9, 7, 6, 4, 3, 2, 1]);

  /**
   * 编码一次：active 是「被拉低（有效）」的输入编号数组，其余输入为高。
   * 返回 { a2, a1, a0, gs, eo } 与原始输出表。
   */
  function encode(active, ei) {
    var levels = { 5: ei === undefined ? '0' : ei };
    for (var i = 0; i < 8; i++) levels[I_PINS[i]] = '1';   // 默认全部无效（高）
    for (var a = 0; a < (active || []).length; a++) levels[I_PINS[active[a]]] = '0';
    var out = evalChip(M, levels, newCtx());
    return { a2: out[11], a1: out[12], a0: out[13], gs: out[14], eo: out[15], raw: out };
  }

  // 逐个输入编码：输出是编号的**反码**（A2A1A0 = 7 - n）
  var single = [];
  for (var n = 0; n < 8; n++) {
    var e = encode([n]);
    single.push(e.a2 + e.a1 + e.a0);
  }
  check('单独选中 I0~I7 时的 A2A1A0（反码 111~000）',
    single, ['111', '110', '101', '100', '011', '010', '001', '000']);

  check('选中 I0 时 GS=0（有编码输出）', encode([0]).gs, '0');
  check('选中 I0 时 EO=1', encode([0]).eo, '1');

  // 优先级：I7 最高、I0 最低
  check('I7 与 I0 同时有效 -> 编码 I7（000）',
    (function () { var e = encode([0, 7]); return e.a2 + e.a1 + e.a0; })(), '000');
  check('I3 与 I5 同时有效 -> 编码 I5（010）',
    (function () { var e = encode([3, 5]); return e.a2 + e.a1 + e.a0; })(), '010');
  check('I0/I2/I4/I6 同时有效 -> 编码 I6（001）',
    (function () { var e = encode([0, 2, 4, 6]); return e.a2 + e.a1 + e.a0; })(), '001');

  // 无有效输入
  var none = encode([]);
  check('无有效输入时 A2A1A0=111', none.a2 + none.a1 + none.a0, '111');
  check('无有效输入时 GS=1', none.gs, '1');
  check('无有效输入时 EO=0（可级联下一级）', none.eo, '0');

  // 使能端
  var dis = encode([0], '1');
  check('~EI=1 禁止时 A2A1A0=111', dis.a2 + dis.a1 + dis.a0, '111');
  check('~EI=1 禁止时 GS=1', dis.gs, '1');
  check('~EI=1 禁止时 EO=1', dis.eo, '1');

  // 未知传播
  var eiX = encode([0], 'X');
  check('~EI=X 时 A2A1A0 未知', [eiX.a2, eiX.a1, eiX.a0], ['X', 'X', 'X']);

  // 无确定有效输入但存在未知输入 -> 输出未知
  (function () {
    var levels = { 5: '0' };
    for (var i = 0; i < 8; i++) levels[I_PINS[i]] = '1';
    levels[I_PINS[3]] = 'X';
    var out = evalChip(M, levels, newCtx());
    check('存在未知输入且无确定有效输入 -> A2A1A0 未知', [out[11], out[12], out[13]], ['X', 'X', 'X']);
    check('存在未知输入且无确定有效输入 -> GS 未知', out[14], 'X');
  })();

  // 低优先级输入未知、但高优先级有确定有效输入 -> 结果确定
  (function () {
    var levels = { 5: '0' };
    for (var i = 0; i < 8; i++) levels[I_PINS[i]] = '1';
    levels[I_PINS[7]] = '0';    // I7 有效（最高优先级）
    levels[I_PINS[0]] = 'X';    // I0 未知，但优先级最低
    var out = evalChip(M, levels, newCtx());
    check('高优先级有确定输入时低优先级未知不影响结果',
      out[11] + out[12] + out[13], '000');
  })();

  // 悬空输入按 TTL 当高 = 无效，等同「无有效输入」
  (function () {
    var out = evalChip(M, mk({ 5: '0' }), newCtx());   // 所有 I 悬空
    check('所有输入悬空（TTL 当 1 = 无效）时 GS=1', out[14], '1');
    check('所有输入悬空时 EO=0', out[15], '0');
  })();

  // 穷举全部 256 种输入组合，逐条比对「最高优先级有效输入」的期望编码
  (function () {
    var bad = [];
    for (var mask = 0; mask < 256; mask++) {
      var levels = { 5: '0' };
      var i;
      for (i = 0; i < 8; i++) levels[I_PINS[i]] = (mask >> i) & 1 ? '1' : '0';
      var out = evalChip(M, levels, newCtx());
      // 期望：从 I7 往 I0 找第一个有效（低电平）输入
      var hit = -1;
      for (i = 7; i >= 0; i--) if (((mask >> i) & 1) === 0) { hit = i; break; }
      var wantCode = hit >= 0 ? (7 - hit) : 7;
      var gotCode = (out[11] === '1' ? 4 : 0) + (out[12] === '1' ? 2 : 0) + (out[13] === '1' ? 1 : 0);
      var wantGS = hit >= 0 ? '0' : '1';
      var wantEO = hit >= 0 ? '1' : '0';
      if (gotCode !== wantCode || out[14] !== wantGS || out[15] !== wantEO) {
        bad.push('mask=' + mask + ' 编码' + gotCode + ' GS' + out[14] + ' EO' + out[15]);
      }
    }
    checkTrue('穷举 256 种输入组合的优先级编码全部正确', bad.length === 0, bad.slice(0, 5));
  })();
})();

/* ============================================================
 * 5. 74LS283 4 位二进制全加器
 * ============================================================ */

group('5. 74LS283 4 位二进制全加器');

(function () {
  var M = '74LS283';
  // S2=1, B2=2, A2=3, S1=4, A1=5, B1=6, C0=7, GND=8,
  // C4=9, S4=10, B4=11, A4=12, S3=13, A3=14, B3=15, VCC=16
  var A_PINS = [5, 3, 14, 12];   // A1..A4
  var B_PINS = [6, 2, 15, 11];   // B1..B4
  var S_PINS = [4, 1, 13, 10];   // S1..S4

  check('74LS283 引脚名表（A1/A2/A3/A4）',
    ['A1', 'A2', 'A3', 'A4'].map(function (k) { return defOf(M).pinNames[k]; }),
    [5, 3, 14, 12]);

  check('74LS283 引脚名表（B1/B2/B3/B4）',
    ['B1', 'B2', 'B3', 'B4'].map(function (k) { return defOf(M).pinNames[k]; }),
    [6, 2, 15, 11]);

  check('74LS283 引脚名表（S1/S2/S3/S4/C0/C4）',
    ['S1', 'S2', 'S3', 'S4', 'C0', 'C4'].map(function (k) { return defOf(M).pinNames[k]; }),
    [4, 1, 13, 10, 7, 9]);

  /** 计算 a + b + c0，返回 { sum: 0..31, s: 'S4S3S2S1', c4: '0'|'1' } */
  function add4(a, b, c0) {
    var levels = { 7: (c0 === undefined || c0 === null) ? '0' : String(c0) };
    for (var i = 0; i < 4; i++) {
      levels[A_PINS[i]] = (a >> i) & 1 ? '1' : '0';
      levels[B_PINS[i]] = (b >> i) & 1 ? '1' : '0';
    }
    var out = evalChip(M, levels, newCtx());
    var sum = 0;
    for (i = 0; i < 4; i++) if (out[S_PINS[i]] === '1') sum += (1 << i);
    return {
      sum: sum,
      s4s1: out[S_PINS[3]] + out[S_PINS[2]] + out[S_PINS[1]] + out[S_PINS[0]],
      c4: out[9],
      raw: out
    };
  }

  check('0 + 0 + 0 = 0，C4=0', [add4(0, 0, 0).sum, add4(0, 0, 0).c4], [0, '0']);
  check('3 + 4 = 7', add4(3, 4).sum, 7);
  check('1 + 1 = 2', add4(1, 1).sum, 2);
  check('7 + 8 = 15，C4=0', [add4(7, 8).sum, add4(7, 8).c4], [15, '0']);
  check('15 + 0 = 15，C4=0', [add4(15, 0).sum, add4(15, 0).c4], [15, '0']);

  // 进位输入
  check('15 + 0 + C0=1 -> 和 0、C4=1（进位溢出）',
    [add4(15, 0, 1).sum, add4(15, 0, 1).c4], [0, '1']);
  check('0 + 0 + C0=1 -> 和 1、C4=0',
    [add4(0, 0, 1).sum, add4(0, 0, 1).c4], [1, '0']);
  check('8 + 8 = 16 -> 和 0、C4=1',
    [add4(8, 8).sum, add4(8, 8).c4], [0, '1']);
  check('10 + 5 = 15，C4=0', [add4(10, 5).sum, add4(10, 5).c4], [15, '0']);
  check('10 + 6 = 16 -> 和 0、C4=1', [add4(10, 6).sum, add4(10, 6).c4], [0, '1']);

  // 和的位序：A=1(0001) + B=0 -> S1=1, S2=S3=S4=0
  check('1 + 0 的 S4S3S2S1 = 0001', add4(1, 0).s4s1, '0001');
  check('2 + 0 的 S4S3S2S1 = 0010', add4(2, 0).s4s1, '0010');
  check('4 + 0 的 S4S3S2S1 = 0100', add4(4, 0).s4s1, '0100');
  check('8 + 0 的 S4S3S2S1 = 1000', add4(8, 0).s4s1, '1000');

  // 穷举验证：a + b + c0 的全部 512 种组合
  (function () {
    var bad = [];
    for (var a = 0; a < 16; a++) {
      for (var b = 0; b < 16; b++) {
        for (var c0 = 0; c0 < 2; c0++) {
          var r = add4(a, b, c0);
          var want = a + b + c0;
          var wantSum = want % 16;
          var wantC4 = want >= 16 ? '1' : '0';
          if (r.sum !== wantSum || r.c4 !== wantC4) {
            bad.push(a + '+' + b + '+' + c0 + ' -> ' + r.sum + '/' + r.c4);
          }
        }
      }
    }
    checkTrue('穷举 512 组 (A + B + C0) 全部正确', bad.length === 0, bad.slice(0, 5));
  })();

  // 未知传播
  (function () {
    var out = evalChip(M, mk({ 5: 'X' }), newCtx());   // A1=X
    check('A1=X 时全部和输出未知',
      [out[4], out[1], out[13], out[10], out[9]], ['X', 'X', 'X', 'X', 'X']);
    var out2 = evalChip(M, mk({ 7: 'X' }), newCtx());  // C0=X
    check('C0=X 时全部和输出未知', out2[4], 'X');
  })();

  // 悬空（TTL 当 1）：A 全悬空、B 全接地 -> 15 + 0 = 15
  (function () {
    var out = evalChip(M, mk({ 6: '0', 2: '0', 15: '0', 11: '0', 7: '0' }), newCtx());
    check('A 全悬空（TTL 当 1）、B 全 0、C0 接地 -> 和为 15',
      [out[4], out[1], out[13], out[10]], ['1', '1', '1', '1']);
    // C0 也悬空时（TTL 当 1）：15 + 0 + 1 = 16 -> 和 0、C4=1
    var out2 = evalChip(M, mk({ 6: '0', 2: '0', 15: '0', 11: '0' }), newCtx());
    check('C0 悬空（TTL 当 1）时 15 + 0 + 1 溢出 -> 和为 0、C4=1',
      [[out2[4], out2[1], out2[13], out2[10]], out2[9]],
      [['0', '0', '0', '0'], '1']);
  })();
})();

/* ============================================================
 * 6. 74LS194 4 位双向移位寄存器
 * ============================================================ */

group('6. 74LS194 4 位双向移位寄存器');

(function () {
  var M = '74LS194';
  // ~MR=1, SR=2, Q0=3, Q1=4, Q2=5, Q3=6, SL=7, GND=8,
  // S1=9, S0=10, CLK=11, D3=12, D2=13, D1=14, D0=15, VCC=16
  var Q_PINS = [3, 4, 5, 6];      // Q0..Q3
  var D_PINS = [15, 14, 13, 12];  // D0..D3
  var CLK = 11;                   // CLK 引脚
  var S1 = 9;
  var S0 = 10;
  var SL = 7;

  check('74LS194 引脚名表（~MR/SR/Q0/Q1/Q2/Q3/SL）',
    ['~MR', 'SR', 'Q0', 'Q1', 'Q2', 'Q3', 'SL'].map(function (k) {
      return defOf(M).pinNames[k];
    }), [1, 2, 3, 4, 5, 6, 7]);

  check('74LS194 引脚名表（S1/S0/CLK/D3/D2/D1/D0）',
    ['S1', 'S0', 'CLK', 'D3', 'D2', 'D1', 'D0'].map(function (k) {
      return defOf(M).pinNames[k];
    }), [9, 10, 11, 12, 13, 14, 15]);

  /** 读当前 4 位状态，返回字符串 Q3Q2Q1Q0 */
  function readQ(out) {
    return out[6] + out[5] + out[4] + out[3];
  }

  /** 在 ctx 上走一个时钟上升沿（先低后高） */
  function clockEdge(ctx, levels) {
    var low = {};
    for (var k in levels) if (Object.prototype.hasOwnProperty.call(levels, k)) low[k] = levels[k];
    low[CLK] = '0';
    evalChip(M, low, ctx);         // 低电平期（不动作）
    var high = {};
    for (k in low) if (Object.prototype.hasOwnProperty.call(low, k)) high[k] = low[k];
    high[CLK] = '1';
    return evalChip(M, high, ctx); // 上升沿
  }

  /** 构造基础电平表（~MR=1，时钟低，模式由 s1/s0 决定） */
  function base(s1, s0, extra) {
    var lv = {};
    lv[1] = '1'; lv[S1] = s1; lv[S0] = s0; lv[CLK] = '0';
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) lv[k] = extra[k];
    return lv;
  }

  // ---- 异步清零 ----
  (function () {
    var c = newCtx();
    var out = clockEdge(c, base('1', '1', { 15: '1', 14: '1', 13: '1', 12: '1' }));
    check('并行置数 1111', readQ(out), '1111');
    var clr = evalChip(M, base('1', '1', { 1: '0' }), c);
    check('~MR=0 异步清零（无需时钟）Q3Q2Q1Q0=0000', readQ(clr), '0000');
    var clrX = evalChip(M, base('1', '1', { 1: 'X' }), c);
    check('~MR=X 时输出未知', readQ(clrX), 'XXXX');
  })();

  // ---- 并行置数（S1=S0=1）----
  (function () {
    var c = newCtx();
    var out = clockEdge(c, base('1', '1', { 15: '1', 14: '0', 13: '1', 12: '0' }));
    check('并行置数 D3D2D1D0=0101 -> Q3Q2Q1Q0=0101', readQ(out), '0101');
    var out2 = clockEdge(c, base('1', '1', { 15: '0', 14: '0', 13: '1', 12: '1' }));
    check('并行置数改为 1100 -> Q3Q2Q1Q0=1100', readQ(out2), '1100');
  })();

  // ---- 保持（S1=S0=0）----
  (function () {
    var c = newCtx();
    clockEdge(c, base('1', '1', { 15: '1', 14: '0', 13: '1', 12: '0' }));   // 0101
    var hold = clockEdge(c, base('0', '0', { 2: '1', 7: '0', 15: '0', 14: '0', 13: '0', 12: '0' }));
    check('保持模式（S1S0=00）经过上升沿状态不变', readQ(hold), '0101');
  })();

  // ---- 右移（S1=0, S0=1）：SR -> Q0，Q0 -> Q1 -> Q2 -> Q3 ----
  (function () {
    var c = newCtx();
    clockEdge(c, base('1', '1', { 15: '0', 14: '0', 13: '0', 12: '1' }));   // 1000
    var r1 = clockEdge(c, base('0', '1', { 2: '1' }));                      // SR=1
    check('右移一拍：1000 -> 0001（SR=1 进入 Q0，原 Q3 移出）', readQ(r1), '0001');
    var r2 = clockEdge(c, base('0', '1', { 2: '0' }));                      // SR=0
    check('右移一拍：0001 -> 0010（SR=0 进入 Q0）', readQ(r2), '0010');
    var r3 = clockEdge(c, base('0', '1', { 2: '1' }));
    check('右移一拍：0010 -> 0101', readQ(r3), '0101');
  })();

  // ---- 左移（S1=1, S0=0）：SL -> Q3，Q3 -> Q2 -> Q1 -> Q0 ----
  (function () {
    var c = newCtx();
    clockEdge(c, base('1', '1', { 15: '0', 14: '0', 13: '0', 12: '1' }));   // 1000
    var l1 = clockEdge(c, base('1', '0', { 7: '0' }));                      // SL=0
    check('左移一拍：1000 -> 0100（SL=0 进入 Q3，原 Q3 移出）', readQ(l1), '0100');

    var c2 = newCtx();
    clockEdge(c2, base('1', '1', { 15: '1', 14: '0', 13: '0', 12: '0' }));  // 0001
    var l2 = clockEdge(c2, base('1', '0', { 7: '1' }));                     // SL=1
    check('左移一拍：0001 -> 1000（SL=1 进入 Q3）', readQ(l2), '1000');
    var l3 = clockEdge(c2, base('1', '0', { 7: '0' }));
    check('左移一拍：1000 -> 0100', readQ(l3), '0100');
    var l4 = clockEdge(c2, base('1', '0', { 7: '1' }));
    check('左移一拍：0100 -> 1010', readQ(l4), '1010');
  })();

  // ---- 时钟边沿：下降沿与电平保持不动作 ----
  (function () {
    var c = newCtx();
    clockEdge(c, base('1', '1', { 15: '1', 14: '1', 13: '0', 12: '0' }));   // 0011
    // 现在时钟在高电平，把模式改成右移并给 SR=1，但不再产生上升沿
    var stay = evalChip(M, base('0', '1', { 2: '1', 11: '1' }), c);
    check('时钟保持高电平不动作（状态仍为 0011）', readQ(stay), '0011');
    // 下降沿（高 -> 低）也不该动作
    var fall = evalChip(M, base('0', '1', { 2: '1', 11: '0' }), c);
    check('时钟下降沿不动作（状态仍为 0011）', readQ(fall), '0011');
    // 再来的上升沿才动作
    var rise = evalChip(M, base('0', '1', { 2: '1', 11: '1' }), c);
    check('下一个上升沿才右移：0011 -> 0111', readQ(rise), '0111');
  })();

  // ---- 未知传播 ----
  (function () {
    var c = newCtx();
    clockEdge(c, base('1', '1', { 15: '1', 14: '0', 13: '1', 12: '0' }));   // 0101
    var out = clockEdge(c, base('X', '1', { 2: '1' }));
    check('模式端 S1=X 时经过上升沿输出全部未知', readQ(out), 'XXXX');

    var c2 = newCtx();
    clockEdge(c2, base('1', '1', { 15: '1', 14: '0', 13: '1', 12: '0' }));  // 0101
    var out2 = clockEdge(c2, base('1', '1', { 15: 'X', 14: '0', 13: '1', 12: '0' }));
    check('并行置数时 D0=X 只让 Q0 未知', readQ(out2), '010X');
  })();

  // ---- 环形移位：QD 反馈到 SR，4 拍回到原状态 ----
  (function () {
    var c = newCtx();
    clockEdge(c, base('1', '1', { 15: '1', 14: '0', 13: '0', 12: '0' }));   // 0001
    var seq = [];
    var sr = '0';    // 初始 Q3=0，先给 SR=0
    for (var i = 0; i < 4; i++) {
      var out = clockEdge(c, base('0', '1', { 2: sr }));
      seq.push(readQ(out));
      sr = out[6];   // Q3 反馈到 SR
    }
    check('环形右移 4 拍回到 0001', seq, ['0010', '0100', '1000', '0001']);
  })();

  // ---- 悬空（TTL 当 1）：S1/S0 悬空 = 11 -> 并行置数；D 悬空 = 1 ----
  (function () {
    var c = newCtx();
    var out = clockEdge(c, { 1: '1', 11: '0' });   // S1/S0/D 全悬空
    check('S1/S0 悬空（TTL 当 1）为并行置数，D 悬空当 1 -> 1111', readQ(out), '1111');
  })();
})();

/* ============================================================
 * 7. 74LS160 十进制同步计数器
 * ============================================================ */

group('7. 74LS160 十进制同步计数器');

(function () {
  var M = '74LS160';
  // ~MR=1, CLK=2, P0=3, P1=4, P2=5, P3=6, CEP=7, GND=8,
  // ~PE=9, CET=10, Q3=11, Q2=12, Q1=13, Q0=14, RCO=15, VCC=16

  check('74LS160 引脚名表与 74LS161 一致',
    ['~MR', 'CLK', 'P0', 'P1', 'P2', 'P3', 'CEP', 'GND', '~PE', 'CET', 'Q3', 'Q2', 'Q1', 'Q0', 'RCO', 'VCC']
      .map(function (k) { return defOf(M).pinNames[k]; }),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

  /** 读当前计数 0..9 */
  function readCount(out) {
    var v = 0;
    if (out[14] === '1') v += 1;
    if (out[13] === '1') v += 2;
    if (out[12] === '1') v += 4;
    if (out[11] === '1') v += 8;
    return v;
  }

  /** 基础电平表：~MR=1, CEP=CET=1, ~PE=1，时钟低 */
  function base(extra) {
    var lv = { 1: '1', 7: '1', 10: '1', 9: '1', 2: '0' };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) lv[k] = extra[k];
    return lv;
  }

  /** 走一个上升沿 */
  function tick(ctx, extra) {
    evalChip(M, base(extra), ctx);                    // 低电平期
    return evalChip(M, base(mkMerge(extra, { 2: '1' })), ctx);   // 上升沿
  }

  function mkMerge(a, b) {
    var out = {};
    var k;
    for (k in a || {}) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (k in b || {}) if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = b[k];
    return out;
  }

  // ---- 模 10 计数：0..9 循环 ----
  (function () {
    var c = newCtx();
    evalChip(M, base(), c);
    check('初始计数为 0', readCount(evalChip(M, base(), c)), 0);

    var seq = [];
    for (var i = 0; i < 12; i++) seq.push(readCount(tick(c)));
    check('连续 12 个上升沿：0~9 后回绕到 0、1',
      seq, [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2]);
  })();

  // ---- RCO 只在计数 9 且 CET=1 时为 1 ----
  (function () {
    var c = newCtx();
    evalChip(M, base(), c);
    var rcoAt = [];
    var last = 0;
    for (var i = 1; i <= 10; i++) {
      var out = tick(c);
      last = readCount(out);
      rcoAt.push(last + ':' + out[15]);
    }
    check('计数 1~9 时 RCO 仅在第 9 拍为 1、第 10 拍回 0',
      rcoAt.slice(7), ['8:0', '9:1', '0:0']);
  })();

  // ---- CET=0 时 RCO 恒为 0 ----
  (function () {
    var c = newCtx();
    evalChip(M, base(), c);
    for (var i = 0; i < 9; i++) tick(c);       // 数到 9
    var out = evalChip(M, base({ 10: '0' }), c);   // CET=0
    check('计数为 9 但 CET=0 时 RCO=0', [readCount(out), out[15]], [9, '0']);
  })();

  // ---- 上升沿触发：下降沿与电平保持不动作 ----
  (function () {
    var c = newCtx();
    evalChip(M, base(), c);
    tick(c);                                   // 计数 1
    var stay = evalChip(M, base({ 2: '1' }), c);
    check('时钟保持高电平不计数', readCount(stay), 1);
    var fall = evalChip(M, base({ 2: '0' }), c);
    check('时钟下降沿不计数', readCount(fall), 1);
    var rise = evalChip(M, base({ 2: '1' }), c);
    check('上升沿才计数 -> 2', readCount(rise), 2);
  })();

  // ---- ~MR 异步清零 ----
  (function () {
    var c = newCtx();
    evalChip(M, base(), c);
    for (var i = 0; i < 5; i++) tick(c);
    check('清零前计数为 5', readCount(evalChip(M, base(), c)), 5);
    var clr = evalChip(M, base({ 1: '0', 2: '0' }), c);   // 非时钟沿
    check('~MR=0 异步清零（非时钟沿也立即生效）', readCount(clr), 0);
    var unk = evalChip(M, base({ 1: 'X' }), c);
    check('~MR=X 时输出未知', [unk[14], unk[13], unk[12], unk[11], unk[15]], ['X', 'X', 'X', 'X', 'X']);
  })();

  // ---- 同步置数 ----
  (function () {
    var c = newCtx();
    evalChip(M, base(), c);
    tick(c);                                   // 1
    // ~PE=0，P3P2P1P0 = 0111 -> 7
    var noEdge = evalChip(M, base({ 9: '0', 6: '0', 5: '1', 4: '1', 3: '1' }), c);
    check('非时钟沿时同步置数不生效（仍为 1）', readCount(noEdge), 1);
    var out = tick(c, { 9: '0', 6: '0', 5: '1', 4: '1', 3: '1' });
    check('上升沿同步置数为 7', readCount(out), 7);
  })();

  // ---- CEP / CET 使能 ----
  (function () {
    var c = newCtx();
    evalChip(M, base(), c);
    tick(c);                                   // 1
    var hold1 = tick(c, { 7: '0' });           // CEP=0
    check('CEP=0 时保持 1 不计数', readCount(hold1), 1);
    var hold2 = tick(c, { 10: '0' });          // CET=0
    check('CET=0 时保持 1 不计数', readCount(hold2), 1);
    var go = tick(c);
    check('CEP=CET=1 时恢复计数 -> 2', readCount(go), 2);
  })();

  // ---- 置入超模值（10~15）保守钳到 0 ----
  (function () {
    var c = newCtx();
    evalChip(M, base(), c);
    var out = tick(c, { 9: '0', 6: '1', 5: '0', 4: '1', 3: '0' });   // P3P2P1P0 = 1010 = 10
    check('置入非法值 10（超出模 10）时保守钳到 0', readCount(out), 0);
  })();

  // ---- 与 74LS161 对照：161 数到 15 才回绕 ----
  (function () {
    var c = newCtx();
    var b161 = function (extra) {
      var lv = { 1: '1', 7: '1', 10: '1', 9: '1', 2: '0' };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) lv[k] = extra[k];
      return lv;
    };
    evalChip('74LS161', b161(), c);
    var seq = [];
    for (var i = 0; i < 17; i++) {
      evalChip('74LS161', b161(), c);
      seq.push(readCount(evalChip('74LS161', b161({ 2: '1' }), c)));
    }
    check('对照：74LS161 数到 15 才回绕',
      seq.slice(13), [14, 15, 0, 1]);
  })();

  // ---- 悬空（TTL 当 1）：CEP/CET 悬空当 1 -> 正常计数；~MR 悬空当 1 -> 不复位 ----
  (function () {
    var c = newCtx();
    evalChip(M, mk({ 2: '0' }), c);            // 除时钟外全部悬空
    var out = evalChip(M, mk({ 2: '1' }), c);
    check('CEP/CET/~MR/~PE 悬空（TTL 当 1）时正常计数 -> 1', readCount(out), 1);
  })();
})();


/* ============================================================
 * 12~15. 2026-10-30 审查新增：74LS21 / 74LS30 / 74LS47 / 74LS48
 *    段码来源：Renesas HD74LS47 Function Table（REJ03D0410 Rev.3.01 p2）
 *    ×eepw 7448 真值表交叉一致；47/48 对 0~15 显示图形完全相同，仅极性相反。
 *    6 = c,d,e,f,g（a、b 不亮）；9 = a,b,c,f,g（d、e 不亮）；
 *    10~14 输出「鉴定输入条件」的独特图形；15 全灭。
 * ============================================================ */

group('12. 74LS21 双四输入与门');
(function () {
  var M = '74LS21';
  check('74LS21 封装 14 脚', defOf(M).package, 14);
  check('74LS21 引脚名 1Y/2Y/VCC', [defOf(M).pinNames['1Y'], defOf(M).pinNames['2Y'], defOf(M).pinNames.VCC], [6, 8, 14]);
  check('74LS21 全 1 -> 1Y=1', evalChip(M, mk({ 1: '1', 2: '1', 4: '1', 5: '1' }))['6'], '1');
  check('74LS21 一个 0 -> 1Y=0', evalChip(M, mk({ 1: '0', 2: '1', 4: '1', 5: '1' }))['6'], '0');
  check('74LS21 悬空全当 1 -> 1Y=1', evalChip(M, mk({}))['6'], '1');
  check('74LS21 X 传播 -> 1Y=X', evalChip(M, mk({ 1: 'X', 2: '1', 4: '1', 5: '1' }))['6'], 'X');
  check('74LS21 2Y 独立：全 1 -> 1', evalChip(M, mk({ 9: '1', 10: '1', 12: '1', 13: '1' }))['8'], '1');
  check('74LS21 2Y 独立：一个 0 -> 0', evalChip(M, mk({ 9: '1', 10: '1', 12: '1', 13: '0' }))['8'], '0');
})();

group('13. 74LS30 八输入与非门');
(function () {
  var M = '74LS30';
  check('74LS30 封装 14 脚', defOf(M).package, 14);
  check('74LS30 引脚名 Y/G/H（NC 9/10/13）',
    [defOf(M).pinNames.Y, defOf(M).pinNames.G, defOf(M).pinNames.H, defOf(M).pinNames.NC1],
    [8, 11, 12, 9]);
  check('74LS30 全 1 -> Y=0', evalChip(M, mk({ 1: '1', 2: '1', 3: '1', 4: '1', 5: '1', 6: '1', 11: '1', 12: '1' }))['8'], '0');
  check('74LS30 一个 0 -> Y=1', evalChip(M, mk({ 3: '0' }))['8'], '1');
  check('74LS30 悬空（全当 1）-> Y=0', evalChip(M, mk({}))['8'], '0');
  check('74LS30 一个 X -> Y=X', evalChip(M, mk({ 6: 'X' }))['8'], 'X');
})();

/** 47/48 共用：按 BCD 位拼引脚表并取段输出串（序 a b c d e f g） */
function bcdSeg(model, a, b, c, d, extra) {
  var pins = { 7: a, 1: b, 2: c, 6: d };   // A=7 B=1 C=2 D=6
  if (extra) {
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) pins[k] = extra[k];
    }
  }
  var o = evalChip(model, pins);
  return [13, 12, 11, 10, 9, 15, 14].map(function (p) { return o[p]; }).join('');
}

group('14. 74LS47 BCD 七段译码驱动（低有效，0=亮）');
(function () {
  var M = '74LS47';
  check('74LS47 封装 16 脚', defOf(M).package, 16);
  check('74LS47 引脚名 a/g/f/~BI', [defOf(M).pinNames.a, defOf(M).pinNames.g, defOf(M).pinNames.f, defOf(M).pinNames['~BI']], [13, 14, 15, 4]);
  check('47 数字 0', bcdSeg(M, '0', '0', '0', '0'), '0000001');
  check('47 数字 1', bcdSeg(M, '1', '0', '0', '0'), '1001111');
  check('47 数字 2', bcdSeg(M, '0', '1', '0', '0'), '0010010');
  check('47 数字 3', bcdSeg(M, '1', '1', '0', '0'), '0000110');
  check('47 数字 4', bcdSeg(M, '0', '0', '1', '0'), '1001100');
  check('47 数字 5', bcdSeg(M, '1', '0', '1', '0'), '0100100');
  check('47 数字 6（a、b 段不亮）', bcdSeg(M, '0', '1', '1', '0'), '1100000');
  check('47 数字 7', bcdSeg(M, '1', '1', '1', '0'), '0001111');
  check('47 数字 8', bcdSeg(M, '0', '0', '0', '1'), '0000000');
  check('47 数字 9（d、e 段不亮）', bcdSeg(M, '1', '0', '0', '1'), '0001100');
  check('47 输入 10（d,e,g 亮）', bcdSeg(M, '0', '1', '0', '1'), '1110010');
  check('47 输入 11（c,d,g 亮）', bcdSeg(M, '1', '1', '0', '1'), '1100110');
  check('47 输入 12（b,f,g 亮）', bcdSeg(M, '0', '0', '1', '1'), '1011100');
  check('47 输入 13（a,d,f,g 亮）', bcdSeg(M, '1', '0', '1', '1'), '0110100');
  check('47 输入 14（d,e,f,g 亮）', bcdSeg(M, '0', '1', '1', '1'), '1110000');
  check('47 输入 15 全灭', bcdSeg(M, '1', '1', '1', '1'), '1111111');
  check('47 ~BI=0 全灭（优先于 ~LT）', bcdSeg(M, '0', '0', '0', '0', { 4: '0', 3: '0' }), '1111111');
  check('47 ~LT=0 全亮', bcdSeg(M, '1', '1', '1', '1', { 3: '0' }), '0000000');
  check('47 ~RBI=0 且数字 0 -> 灭零', bcdSeg(M, '0', '0', '0', '0', { 5: '0' }), '1111111');
  check('47 ~RBI=0 但数字非 0 -> 正常显示', bcdSeg(M, '1', '0', '0', '0', { 5: '0' }), '1001111');
  check('47 ~BI 悬空（TTL 当 1）正常译码', bcdSeg(M, '0', '1', '0', '0'), '0010010');
})();

group('15. 74LS48 BCD 七段译码驱动（高有效，1=亮）');
(function () {
  var M = '74LS48';
  check('74LS48 封装 16 脚', defOf(M).package, 16);
  check('74LS48 引脚名与 47 一致', [defOf(M).pinNames.a, defOf(M).pinNames['~LT'], defOf(M).pinNames['~RBI']], [13, 3, 5]);
  check('48 数字 0', bcdSeg(M, '0', '0', '0', '0'), '1111110');
  check('48 数字 1', bcdSeg(M, '1', '0', '0', '0'), '0110000');
  check('48 数字 6（a、b 段不亮）', bcdSeg(M, '0', '1', '1', '0'), '0011111');
  check('48 数字 9（d、e 段不亮）', bcdSeg(M, '1', '0', '0', '1'), '1110011');
  check('48 输入 13（a,d,f,g 亮）', bcdSeg(M, '1', '0', '1', '1'), '1001011');
  check('48 输入 15 全灭', bcdSeg(M, '1', '1', '1', '1'), '0000000');
  check('48 ~BI=0 全灭', bcdSeg(M, '0', '0', '0', '0', { 4: '0' }), '0000000');
  check('48 ~LT=0 全亮', bcdSeg(M, '1', '1', '1', '1', { 3: '0' }), '1111111');
  check('48 ~RBI=0 且数字 0 -> 灭零', bcdSeg(M, '0', '0', '0', '0', { 5: '0' }), '0000000');
  check('48 与 47 极性严格互补（数字 5）',
    bcdSeg(M, '1', '0', '1', '0').split('').map(function (v) { return v === '0' ? '1' : '0'; }).join(''),
    bcdSeg('74LS47', '1', '0', '1', '0'));
})();

/* ============================================================
 * 汇总
 * ============================================================ */

var failed = results.filter(function (r) { return !r.ok; });
var passed = results.length - failed.length;

console.log('\n' + '='.repeat(64));
if (failed.length === 0) {
  console.log('\u2713 全部通过 ' + passed + '/' + results.length);
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

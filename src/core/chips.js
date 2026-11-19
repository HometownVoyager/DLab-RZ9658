// src/core/chips.js
// 74 系列芯片行为模型库（经典脚本，浏览器 / Node 通用）
// 每个型号声明 { model, package, pins, vccPin, gndPin, pinNames, eval(pinLevels, ctx) }
//   - pins       : 引脚号数组（1..N）
//   - pinNames   : 引脚功能名 -> 引脚号（低有效端名前带 '~'）
//   - eval       : 返回 { <输出引脚号>: <电平> }，电平只可能是 '0' | '1' | 'X'
//   - ctx        : 引擎为每个已插芯片维护的上下文，至少含 state（跨 step 持久）
//
// 【封装范围】本实验箱只有 14P / 16P / 20P 三种 DIP 插座（UA/UB、UE/UD、UF），
// 没有 8 脚插座，NE555 之类的 8 脚器件物理上插不进去，因此本库**不注册 NE555**。
(function (global) {
  'use strict';

  var DLab = (global.DLab = global.DLab || {});
  var Logic = DLab.Logic;
  if (!Logic) throw new Error('chips.js 依赖 logic.js，请先加载 src/core/logic.js');

  var L0 = '0';
  var L1 = '1';
  var LZ = 'Z';
  var LX = 'X';

  /* ============================================================
   * 1. 电平读取小工具
   *    74LS 系列是 TTL：输入端悬空（'Z'）按高电平 '1' 处理；
   *    该行为由 ctx.isTTL 控制，缺省为 true，可整体切换成 CMOS 语义。
   * ============================================================ */

  function useTTL(ctx) {
    return (ctx && ctx.isTTL !== undefined && ctx.isTTL !== null) ? !!ctx.isTTL : true;
  }

  /** 取某引脚原始四态电平（缺失的引脚按 'Z' 处理） */
  function rawLevel(pinLevels, pin) {
    var v = pinLevels ? pinLevels[pin] : undefined;
    return Logic.isLevel(v) ? v : LZ;
  }

  /** 取某引脚的二值电平（已做 TTL 归一化），返回 '0' | '1' | 'X' */
  function binLevel(pinLevels, pin, ctx) {
    return Logic.toBin(rawLevel(pinLevels, pin), useTTL(ctx));
  }

  /** 74 系列推挽输出永远不会是高阻：任何非 '0'/'1' 的结果都归为 'X' */
  function outLevel(v) {
    return (v === L0 || v === L1) ? v : LX;
  }

  /** 生成 1..n 的引脚号数组 */
  function pinRange(n) {
    var a = [];
    for (var i = 1; i <= n; i++) a.push(i);
    return a;
  }

  /* ============================================================
   * 2. 组合逻辑芯片构造器
   * ============================================================ */

  /**
   * 四路二输入门（74LS00 / 08 / 32 / 86 / 02 共用）
   * @param {string} model
   * @param {string} gateName Logic.GATE_FNS 中的门名
   * @param {Array<Array<number>>} groups 每组 [输入A引脚, 输入B引脚, 输出引脚]
   * @param {object} names 引脚名表
   */
  function makeQuad2(model, gateName, groups, names) {
    return {
      model: model,
      package: 14,
      pins: pinRange(14),
      vccPin: 14,
      gndPin: 7,
      pinNames: names,
      eval: function (pinLevels, ctx) {
        var res = {};
        var fn = Logic.GATE_FNS[gateName];
        for (var i = 0; i < groups.length; i++) {
          var a = binLevel(pinLevels, groups[i][0], ctx);
          var b = binLevel(pinLevels, groups[i][1], ctx);
          res[groups[i][2]] = outLevel(fn(a, b));
        }
        return res;
      }
    };
  }

  /** 六反相器（74LS04） */
  function makeHexInverter(model, groups, names) {
    return {
      model: model,
      package: 14,
      pins: pinRange(14),
      vccPin: 14,
      gndPin: 7,
      pinNames: names,
      eval: function (pinLevels, ctx) {
        var res = {};
        for (var i = 0; i < groups.length; i++) {
          res[groups[i][1]] = outLevel(Logic.not(binLevel(pinLevels, groups[i][0], ctx)));
        }
        return res;
      }
    };
  }

  /* ============================================================
   * 3. 时序逻辑辅助
   * ============================================================ */

  /**
   * 单个 D 触发器求值（上升沿触发 + 异步置位/复位，置位优先）。
   * @param {object} ctx  引擎上下文（ctx.state 持久保存 Q 与上一拍时钟）
   * @param {string} key  触发器标识（'1' / '2'）
   * @param {'0'|'1'|'X'} d   数据输入
   * @param {'0'|'1'|'X'} cp  时钟输入
   * @param {'0'|'1'|'X'} preN 异步置位（低有效）
   * @param {'0'|'1'|'X'} clrN 异步复位（低有效）
   * @returns {'0'|'1'|'X'} Q
   */
  function dffStep(ctx, key, d, cp, preN, clrN) {
    var st = ctx.state;
    var qKey = 'q' + key;
    var cpKey = 'cp' + key;
    var q = st[qKey];
    if (q !== L0 && q !== L1 && q !== LX) q = L0;

    var prevCp = st[cpKey];
    st[cpKey] = cp;   // 先记录本拍时钟，保证同一 step 内反复求值不会重复触发

    if (clrN === L0 && preN === L1) {
      q = L0;                                   // 异步清零
    } else if (preN === L0 && clrN === L1) {
      q = L1;                                   // 异步置位
    } else if (preN === L0 && clrN === L0) {
      q = L1;                                   // 两者同时有效：置位优先（7474 数据手册行为）
    } else if (preN === LX || clrN === LX) {
      q = LX;                                   // 异步端未知 -> 输出未知
    } else if (prevCp === L0 && cp === L1) {
      q = (d === L0 || d === L1) ? d : LX;      // 上升沿采样
    }
    st[qKey] = q;
    return q;
  }

  /**
   * 单个 J-K 触发器求值（下降沿触发 + 异步置位/复位，置位优先）。
   * 与 dffStep 的区别只有两处：
   *   1) 触发边沿是 1 -> 0（下降沿），这是 74LS112 数据手册的行为；
   *   2) 次态由 J/K 决定：00 保持、01 清零、10 置位、11 翻转。
   * @param {object} ctx  引擎上下文（ctx.state 持久保存 Q 与上一拍时钟）
   * @param {string} key  触发器标识（'1' / '2'）
   * @param {'0'|'1'|'X'} j    J 输入
   * @param {'0'|'1'|'X'} k    K 输入
   * @param {'0'|'1'|'X'} cp  时钟输入
   * @param {'0'|'1'|'X'} preN 异步置位（低有效）
   * @param {'0'|'1'|'X'} clrN 异步复位（低有效）
   * @returns {'0'|'1'|'X'} Q
   */
  function jkffStep(ctx, key, j, k, cp, preN, clrN) {
    var st = ctx.state;
    var qKey = 'q' + key;
    var cpKey = 'cp' + key;
    var q = st[qKey];
    if (q !== L0 && q !== L1 && q !== LX) q = L0;

    var prevCp = st[cpKey];
    st[cpKey] = cp;   // 先记录本拍时钟，保证同一 step 内反复求值不会重复触发

    if (clrN === L0 && preN === L1) {
      q = L0;                                   // 异步清零
    } else if (preN === L0 && clrN === L1) {
      q = L1;                                   // 异步置位
    } else if (preN === L0 && clrN === L0) {
      q = L1;                                   // 两者同时有效：置位优先（数据手册注明 "不可预测"，此处取保守的置位）
    } else if (preN === LX || clrN === LX) {
      q = LX;                                   // 异步端未知 -> 输出未知
    } else if (prevCp === L1 && cp === L0) {
      // 下降沿采样 J/K：11 翻转、10 置 1、01 清 0、00 保持
      if (j === LX || k === LX) {
        q = LX;
      } else if (j === L1 && k === L1) {
        q = (q === L0) ? L1 : ((q === L1) ? L0 : LX);
      } else if (j === L1) {
        q = L1;
      } else if (k === L1) {
        q = L0;
      }
      // J=0 且 K=0：保持，q 不变
    }
    st[qKey] = q;
    return q;
  }

  /* ============================================================
   * 4. 芯片定义
   * ============================================================ */

  var MODELS = Object.create(null);

  function define(def) {
    MODELS[def.model] = def;
    return def;
  }

  /* ---------- 14 脚：四路二输入门 ---------- */

  define(makeQuad2('74LS00', 'nand',
    [[1, 2, 3], [4, 5, 6], [9, 10, 8], [12, 13, 11]],
    { '1A': 1, '1B': 2, '1Y': 3, '2A': 4, '2B': 5, '2Y': 6, GND: 7,
      '3Y': 8, '3A': 9, '3B': 10, '4Y': 11, '4A': 12, '4B': 13, VCC: 14 }));

  define(makeQuad2('74LS02', 'nor',
    [[2, 3, 1], [5, 6, 4], [8, 9, 10], [11, 12, 13]],
    { '1Y': 1, '1A': 2, '1B': 3, '2Y': 4, '2A': 5, '2B': 6, GND: 7,
      '3A': 8, '3B': 9, '3Y': 10, '4A': 11, '4B': 12, '4Y': 13, VCC: 14 }));

  define(makeQuad2('74LS08', 'and',
    [[1, 2, 3], [4, 5, 6], [9, 10, 8], [12, 13, 11]],
    { '1A': 1, '1B': 2, '1Y': 3, '2A': 4, '2B': 5, '2Y': 6, GND: 7,
      '3Y': 8, '3A': 9, '3B': 10, '4Y': 11, '4A': 12, '4B': 13, VCC: 14 }));

  define(makeQuad2('74LS32', 'or',
    [[1, 2, 3], [4, 5, 6], [9, 10, 8], [12, 13, 11]],
    { '1A': 1, '1B': 2, '1Y': 3, '2A': 4, '2B': 5, '2Y': 6, GND: 7,
      '3Y': 8, '3A': 9, '3B': 10, '4Y': 11, '4A': 12, '4B': 13, VCC: 14 }));

  define(makeQuad2('74LS86', 'xor',
    [[1, 2, 3], [4, 5, 6], [9, 10, 8], [12, 13, 11]],
    { '1A': 1, '1B': 2, '1Y': 3, '2A': 4, '2B': 5, '2Y': 6, GND: 7,
      '3Y': 8, '3A': 9, '3B': 10, '4Y': 11, '4A': 12, '4B': 13, VCC: 14 }));

  define(makeHexInverter('74LS04',
    [[1, 2], [3, 4], [5, 6], [9, 8], [11, 10], [13, 12]],
    { '1A': 1, '1Y': 2, '2A': 3, '2Y': 4, '3A': 5, '3Y': 6, GND: 7,
      '4Y': 8, '4A': 9, '5Y': 10, '5A': 11, '6Y': 12, '6A': 13, VCC: 14 }));

  /* ---------- 14 脚：双 D 触发器 74LS74 ---------- */

  define({
    model: '74LS74',
    package: 14,
    pins: pinRange(14),
    vccPin: 14,
    gndPin: 7,
    pinNames: {
      '~1CLR': 1, '1D': 2, '1CLK': 3, '~1PRE': 4, '1Q': 5, '~1Q': 6, GND: 7,
      '~2Q': 8, '2Q': 9, '~2PRE': 10, '2CLK': 11, '2D': 12, '~2CLR': 13, VCC: 14
    },
    eval: function (pinLevels, ctx) {
      var q1 = dffStep(ctx, '1',
        binLevel(pinLevels, 2, ctx),   // 1D
        binLevel(pinLevels, 3, ctx),   // 1CLK
        binLevel(pinLevels, 4, ctx),   // ~1PRE
        binLevel(pinLevels, 1, ctx));  // ~1CLR
      var q2 = dffStep(ctx, '2',
        binLevel(pinLevels, 12, ctx),  // 2D
        binLevel(pinLevels, 11, ctx),  // 2CLK
        binLevel(pinLevels, 10, ctx),  // ~2PRE
        binLevel(pinLevels, 13, ctx)); // ~2CLR
      var res = {};
      res[5] = outLevel(q1);
      res[6] = outLevel(Logic.not(q1));
      res[9] = outLevel(q2);
      res[8] = outLevel(Logic.not(q2));
      return res;
    }
  });

  /* ---------- 16 脚：3-8 译码器 74LS138 ---------- */

  define({
    model: '74LS138',
    package: 16,
    pins: pinRange(16),
    vccPin: 16,
    gndPin: 8,
    pinNames: {
      A: 1, B: 2, C: 3, '~G2A': 4, '~G2B': 5, G1: 6, Y7: 7, GND: 8,
      Y6: 9, Y5: 10, Y4: 11, Y3: 12, Y2: 13, Y1: 14, Y0: 15, VCC: 16
    },
    eval: function (pinLevels, ctx) {
      var a = binLevel(pinLevels, 1, ctx);
      var b = binLevel(pinLevels, 2, ctx);
      var c = binLevel(pinLevels, 3, ctx);
      var g2a = binLevel(pinLevels, 4, ctx);
      var g2b = binLevel(pinLevels, 5, ctx);
      var g1 = binLevel(pinLevels, 6, ctx);

      // 输出引脚按 Y0..Y7 排列
      var outPins = [15, 14, 13, 12, 11, 10, 9, 7];
      var res = {};
      var i;

      var disabled = (g1 === L0) || (g2a === L1) || (g2b === L1);
      var unknownEn = (g1 === LX) || (g2a === LX) || (g2b === LX);
      if (disabled) {
        for (i = 0; i < 8; i++) res[outPins[i]] = L1;   // 未选中全部输出高
        return res;
      }
      if (unknownEn) {
        for (i = 0; i < 8; i++) res[outPins[i]] = LX;
        return res;
      }
      if (a === LX || b === LX || c === LX) {
        for (i = 0; i < 8; i++) res[outPins[i]] = LX;
        return res;
      }
      var sel = (a === L1 ? 1 : 0) + (b === L1 ? 2 : 0) + (c === L1 ? 4 : 0);
      for (i = 0; i < 8; i++) res[outPins[i]] = (i === sel) ? L0 : L1;
      return res;
    }
  });

  /* ---------- 16 脚：8 选 1 数据选择器 74LS151 ---------- */

  define({
    model: '74LS151',
    package: 16,
    pins: pinRange(16),
    vccPin: 16,
    gndPin: 7,
    pinNames: {
      D4: 1, D5: 2, D6: 3, D7: 4, Y: 5, W: 6, GND: 7, '~S': 8,
      C: 9, B: 10, A: 11, D0: 12, D1: 13, D2: 14, D3: 15, VCC: 16
    },
    eval: function (pinLevels, ctx) {
      var res = {};
      var sN = binLevel(pinLevels, 8, ctx);   // ~S 使能，低有效
      if (sN === L1) {
        res[5] = L0;   // 禁止时 Y=0、W=1（数据手册规定）
        res[6] = L1;
        return res;
      }
      if (sN === LX) {
        res[5] = LX;
        res[6] = LX;
        return res;
      }
      var a = binLevel(pinLevels, 11, ctx);
      var b = binLevel(pinLevels, 10, ctx);
      var c = binLevel(pinLevels, 9, ctx);
      if (a === LX || b === LX || c === LX) {
        res[5] = LX;
        res[6] = LX;
        return res;
      }
      var sel = (a === L1 ? 1 : 0) + (b === L1 ? 2 : 0) + (c === L1 ? 4 : 0);
      var dataPins = [12, 13, 14, 15, 1, 2, 3, 4];   // D0..D7
      var y = binLevel(pinLevels, dataPins[sel], ctx);
      res[5] = outLevel(y);
      res[6] = outLevel(Logic.not(y));
      return res;
    }
  });

  /* ---------- 16 脚：同步计数器工厂（74LS161 / 74LS160 共用） ---------- */

  /**
   * 同步计数器构造器。
   * 74LS160 与 74LS161 引脚完全兼容、行为同构，唯一差别是计数模值：
   *   - 74LS161：模 16（0~15），RCO = Q0·Q1·Q2·Q3·CET
   *   - 74LS160：模 10（0~9）， RCO = Q0·Q3·CET（9 = 1001，故只需 Q0·Q3）
   * 两者都是：~MR 异步清零、~PE 同步置数、CEP·CET 同时为 1 才计数、上升沿触发。
   * @param {string} model   型号
   * @param {number} modulus 计数模值（10 / 16）
   */
  function makeSyncCounter(model, modulus) {
    return {
      model: model,
      package: 16,
      pins: pinRange(16),
      vccPin: 16,
      gndPin: 8,
      pinNames: {
        '~MR': 1, CLK: 2, P0: 3, P1: 4, P2: 5, P3: 6, CEP: 7, GND: 8,
        '~PE': 9, CET: 10, Q3: 11, Q2: 12, Q1: 13, Q0: 14, RCO: 15, VCC: 16
      },
      eval: function (pinLevels, ctx) {
        var st = ctx.state;
        var mr = binLevel(pinLevels, 1, ctx);    // 异步清零，低有效
        var cp = binLevel(pinLevels, 2, ctx);    // 时钟，上升沿有效
        var pe = binLevel(pinLevels, 9, ctx);    // 同步置数，低有效
        var cep = binLevel(pinLevels, 7, ctx);
        var cet = binLevel(pinLevels, 10, ctx);

        var count = st.count;
        if (typeof count !== 'number' || count < 0 || count >= modulus) count = 0;
        var forceX = false;

        var prevCp = st.cp;
        st.cp = cp;

        if (mr === L0) {
          count = 0;                                  // 异步清零：不等时钟，立即生效
        } else if (mr === LX || pe === LX || cep === LX || cet === LX) {
          forceX = true;                              // 控制端未知 -> 输出未知
        } else if (prevCp === L0 && cp === L1) {
          if (pe === L0) {
            // 同步并行置数
            var p0 = binLevel(pinLevels, 3, ctx);
            var p1 = binLevel(pinLevels, 4, ctx);
            var p2 = binLevel(pinLevels, 5, ctx);
            var p3 = binLevel(pinLevels, 6, ctx);
            if (p0 === LX || p1 === LX || p2 === LX || p3 === LX) {
              forceX = true;
            } else {
              count = (p0 === L1 ? 1 : 0) + (p1 === L1 ? 2 : 0) +
                      (p2 === L1 ? 4 : 0) + (p3 === L1 ? 8 : 0);
              // 置入值超模（例如 160 置入 10~15）：数据手册标注为非法状态，
              // 这里保守地钳到 0，保证仿真器永远不进入模值外的状态。
              if (count >= modulus) count = 0;
            }
          } else if (cep === L1 && cet === L1) {
            count = (count + 1) % modulus;            // 计数
          }
          // 其余情况：保持
        }
        st.count = count;

        var res = {};
        if (forceX) {
          res[14] = LX; res[13] = LX; res[12] = LX; res[11] = LX; res[15] = LX;
          return res;
        }
        res[14] = (count & 1) ? L1 : L0;   // Q0
        res[13] = (count & 2) ? L1 : L0;   // Q1
        res[12] = (count & 4) ? L1 : L0;   // Q2
        res[11] = (count & 8) ? L1 : L0;   // Q3
        // 进位输出 RCO：计到最大有效值（模值-1）且 CET=1 时拉高
        if (cet === L0) res[15] = L0;
        else if (cet === L1) res[15] = (count === modulus - 1) ? L1 : L0;
        else res[15] = (count === modulus - 1) ? LX : L0;
        return res;
      }
    };
  }

  /* ---------- 16 脚：4 位同步二进制计数器 74LS161 ---------- */

  define(makeSyncCounter('74LS161', 16));

  /* ---------- 16 脚：十进制同步计数器 74LS160 ---------- */

  // 引脚与 74LS161 完全相同，只是模值为 10（0~9 循环）
  define(makeSyncCounter('74LS160', 10));

  /* ---------- 16 脚：双 J-K 负沿触发器 74LS112 ---------- */

  // 引脚（本库采用的一版，DIP-16 顶视，逆时针）：
  //   1 ~1CLR, 2 1J, 3 1K, 4 1CLK, 5 ~1PRE, 6 1Q, 7 ~1Q, 8 GND,
  //   9 ~2Q, 10 2Q, 11 ~2PRE, 12 2CLK, 13 2J, 14 2K, 15 ~2CLR, 16 VCC
  // 【引脚版本说明 · 务必阅读】
  //   74LS112 的引脚排布在公开资料里**至少有三套互相矛盾的画法**，且两两之间
  //   连 CLK / CLR / PRE 的位置都不一致（实测检索到的变体包括
  //   「1 1CLK, 2 1K, 3 1J, 4 ~1PRE, 5 1Q, 6 ~1Q, 7 ~1CLR, ...」与
  //   「1 ~1CLR, 2 ~1PRE, 3 1K, 4 1Q, 5 ~1Q, 6 1CLK, 7 1J, ...」等）。
  //   注意 74LS112 与 74LS76 **引脚不兼容**（功能相同但排列不同），
  //   而 Nexperia 的 74HC112（CMOS 版）又是第三种排列，三者不能混用。
  //   本库采用上面这一版：它的 1~7 脚与 15~9 脚关于 GND 对称，
  //   与任务书给定的引脚表一致，也是国内数电实验指导书里最常见的一版。
  //   **接线前请以本库 pinNames 为准**；若实物是另一版本，需要同步修改下面的
  //   pinNames 与 eval 里对应的引脚号（两处必须一致，本库沿用既有风格用字面量写死）。
  // 功能：下降沿（1→0）触发；~PRE / ~CLR 异步且低有效；两者同时有效时数据手册注明
  //   结果不可预测，这里取保守的「置位优先」，与库内 74LS74 的处理保持一致。
  define({
    model: '74LS112',
    package: 16,
    pins: pinRange(16),
    vccPin: 16,
    gndPin: 8,
    pinNames: {
      '~1CLR': 1, '1J': 2, '1K': 3, '1CLK': 4, '~1PRE': 5, '1Q': 6, '~1Q': 7, GND: 8,
      '~2Q': 9, '2Q': 10, '~2PRE': 11, '2CLK': 12, '2J': 13, '2K': 14, '~2CLR': 15, VCC: 16
    },
    eval: function (pinLevels, ctx) {
      var q1 = jkffStep(ctx, '1',
        binLevel(pinLevels, 2, ctx),    // 1J
        binLevel(pinLevels, 3, ctx),    // 1K
        binLevel(pinLevels, 4, ctx),    // 1CLK
        binLevel(pinLevels, 5, ctx),    // ~1PRE
        binLevel(pinLevels, 1, ctx));   // ~1CLR
      var q2 = jkffStep(ctx, '2',
        binLevel(pinLevels, 13, ctx),   // 2J
        binLevel(pinLevels, 14, ctx),   // 2K
        binLevel(pinLevels, 12, ctx),   // 2CLK
        binLevel(pinLevels, 11, ctx),   // ~2PRE
        binLevel(pinLevels, 15, ctx));  // ~2CLR
      var res = {};
      res[6] = outLevel(q1);
      res[7] = outLevel(Logic.not(q1));
      res[10] = outLevel(q2);
      res[9] = outLevel(Logic.not(q2));
      return res;
    }
  });

  /* ---------- 16 脚：双 4 选 1 数据选择器 74LS153 ---------- */

  // 引脚（TI / 通用 74153 排列）：
  //   1 ~1G, 2 B, 3 1C3, 4 1C2, 5 1C1, 6 1C0, 7 1Y, 8 GND,
  //   9 2Y, 10 2C0, 11 2C1, 12 2C2, 13 2C3, 14 A, 15 ~2G, 16 VCC
  // 两组完全独立：共用地址端 B(高位) / A(低位)，各有自己的低有效使能 ~1G / ~2G。
  // 使能无效时数据手册规定 Y = 0（不是高阻），这里严格照做。
  // 注意：数据端的编号在芯片上是从 C0 到 C3 逆时针排的（1C0 在 6 脚、1C3 在 3 脚），
  //   与常见的 "从 3 脚开始递增" 写法相反，接线时请以本库 pinNames 为准。
  define({
    model: '74LS153',
    package: 16,
    pins: pinRange(16),
    vccPin: 16,
    gndPin: 8,
    pinNames: {
      '~1G': 1, B: 2, '1C3': 3, '1C2': 4, '1C1': 5, '1C0': 6, '1Y': 7, GND: 8,
      '2Y': 9, '2C0': 10, '2C1': 11, '2C2': 12, '2C3': 13, A: 14, '~2G': 15, VCC: 16
    },
    eval: function (pinLevels, ctx) {
      var a = binLevel(pinLevels, 14, ctx);   // A（低位）
      var b = binLevel(pinLevels, 2, ctx);    // B（高位）
      var res = {};

      // 两组数据端引脚：索引 0..3 对应 C0..C3
      var dataPins = [[6, 5, 4, 3], [10, 11, 12, 13]];
      var enPins = [1, 15];
      var outPins = [7, 9];

      for (var g = 0; g < 2; g++) {
        var en = binLevel(pinLevels, enPins[g], ctx);
        if (en === L1) {                      // 禁止：Y 恒为 0
          res[outPins[g]] = L0;
          continue;
        }
        if (en === LX || a === LX || b === LX) {
          res[outPins[g]] = LX;
          continue;
        }
        var sel = (a === L1 ? 1 : 0) + (b === L1 ? 2 : 0);
        res[outPins[g]] = outLevel(binLevel(pinLevels, dataPins[g][sel], ctx));
      }
      return res;
    }
  });

  /* ---------- 16 脚：8-3 线优先编码器 74LS148 ---------- */

  // 引脚（TI / 通用 74148 排列）：
  //   1 ~I7, 2 ~I6, 3 ~I5, 4 ~I4, 5 ~EI, 6 ~I3, 7 ~I2, 8 GND,
  //   9 ~I1, 10 ~I0, 11 A2, 12 A1, 13 A0, 14 GS, 15 EO, 16 VCC
  // 输入 I0~I7 全部低有效，I7 优先级最高；输出 A2/A1/A0 为**反码**（选中 I7 时输出 000）。
  //   ~EI 低有效使能；GS 有有效输入时为低；EO 无有效输入时为低（用于级联扩展）。
  //   ~EI=1 时 A2/A1/A0 与 GS 均为高，EO 为高（数据手册 "禁止" 行）。
  // 说明：GS / EO 是**高有效**输出（低电平才表示有效/使能下一级），故端名不加 '~'；
  //   与库内 74LS138 的 Y0~Y7 处理方式一致，语义写在注释里而不是靠 '~' 前缀表达。
  define({
    model: '74LS148',
    package: 16,
    pins: pinRange(16),
    vccPin: 16,
    gndPin: 8,
    pinNames: {
      '~EI': 5, '~I0': 10, '~I1': 9, '~I2': 7, '~I3': 6, '~I4': 4, '~I5': 3, '~I6': 2, '~I7': 1,
      A0: 13, A1: 12, A2: 11, GS: 14, EO: 15, GND: 8, VCC: 16
    },
    eval: function (pinLevels, ctx) {
      var ei = binLevel(pinLevels, 5, ctx);    // ~EI 低有效使能
      var res = {};
      var i;

      // 输入引脚：索引 0..7 对应 I0..I7
      var inPins = [10, 9, 7, 6, 4, 3, 2, 1];
      var levels = [];
      for (i = 0; i < 8; i++) levels.push(binLevel(pinLevels, inPins[i], ctx));

      if (ei === L1) {
        // 禁止：所有输出为高（A2A1A0=111、GS=1、EO=1）
        res[13] = L1; res[12] = L1; res[11] = L1; res[14] = L1; res[15] = L1;
        return res;
      }
      if (ei === LX) {
        res[13] = LX; res[12] = LX; res[11] = LX; res[14] = LX; res[15] = LX;
        return res;
      }

      // 从高优先级（I7）往低找第一个有效（低电平）输入
      var hit = -1;
      var hasUnknown = false;
      for (i = 7; i >= 0; i--) {
        if (levels[i] === L0) { hit = i; break; }
        if (levels[i] === LX) hasUnknown = true;
      }

      if (hit >= 0) {
        // 有确定的有效输入：输出反码编号（A2A1A0 = 7 - hit）
        var code = 7 - hit;
        res[11] = (code & 4) ? L1 : L0;   // A2
        res[12] = (code & 2) ? L1 : L0;   // A1
        res[13] = (code & 1) ? L1 : L0;   // A0
        res[14] = L0;                     // GS = 0：有编码输出
        res[15] = L1;                     // EO = 1：本级不向下一级扩展
        return res;
      }
      if (hasUnknown) {
        // 无确定有效输入但存在未知输入：无法确定是否会被编码
        res[13] = LX; res[12] = LX; res[11] = LX; res[14] = LX; res[15] = LX;
        return res;
      }
      // 全部输入为高（无有效输入）：A2A1A0=111、GS=1、EO=0
      res[13] = L1; res[12] = L1; res[11] = L1; res[14] = L1; res[15] = L0;
      return res;
    }
  });

  /* ---------- 16 脚：4 位二进制全加器 74LS283 ---------- */

  // 引脚（TI / 通用 74283 排列）：
  //   1 S2, 2 B2, 3 A2, 4 S1, 5 A1, 6 B1, 7 C0, 8 GND,
  //   9 C4, 10 S4, 11 B4, 12 A4, 13 S3, 14 A3, 15 B3, 16 VCC
  // 计算 (A4..A1) + (B4..B1) + C0 -> S4..S1 与进位 C4；无使能端，纯组合。
  define({
    model: '74LS283',
    package: 16,
    pins: pinRange(16),
    vccPin: 16,
    gndPin: 8,
    pinNames: {
      S2: 1, B2: 2, A2: 3, S1: 4, A1: 5, B1: 6, C0: 7, GND: 8,
      C4: 9, S4: 10, B4: 11, A4: 12, S3: 13, A3: 14, B3: 15, VCC: 16
    },
    eval: function (pinLevels, ctx) {
      var aPins = [5, 3, 14, 12];    // A1..A4
      var bPins = [6, 2, 15, 11];    // B1..B4
      var sPins = [4, 1, 13, 10];    // S1..S4
      var c0 = binLevel(pinLevels, 7, ctx);
      var res = {};
      var i;

      var a = 0;
      var b = 0;
      var unknown = (c0 === LX);
      for (i = 0; i < 4; i++) {
        var av = binLevel(pinLevels, aPins[i], ctx);
        var bv = binLevel(pinLevels, bPins[i], ctx);
        if (av === LX || bv === LX) unknown = true;
        else {
          if (av === L1) a += (1 << i);
          if (bv === L1) b += (1 << i);
        }
      }
      if (unknown) {
        for (i = 0; i < 4; i++) res[sPins[i]] = LX;
        res[9] = LX;
        return res;
      }
      var sum = a + b + (c0 === L1 ? 1 : 0);
      for (i = 0; i < 4; i++) res[sPins[i]] = (sum & (1 << i)) ? L1 : L0;
      res[9] = (sum >= 16) ? L1 : L0;   // C4
      return res;
    }
  });

  /* ---------- 16 脚：4 位双向移位寄存器 74LS194 ---------- */

  // 引脚（TI SN74LS194A / 通用 74194 连接图，DIP-16 顶视，逆时针）：
  //   1 ~MR, 2 SR, 3 Q0, 4 Q1, 5 Q2, 6 Q3, 7 SL, 8 GND,
  //   9 S1, 10 S0, 11 CLK, 12 D3, 13 D2, 14 D1, 15 D0, 16 VCC
  // 即：输出 Q0~Q3 在 3~6 脚（QA/QB/QC/QD），并行输入 D0~D3 在 15~12 脚（A/B/C/D）。
  // 模式（S1 S0）：00 保持、01 右移（SR -> Q0，Q0 -> Q1 -> Q2 -> Q3）、
  //                10 左移（SL -> Q3，Q3 -> Q2 -> Q1 -> Q0）、11 并行置数。
  // 上升沿触发；~MR 异步清零且优先级最高。
  // 【引脚版本说明】Nexperia 的 74HC194（CMOS 版）把并行输入放在 3~6 脚、输出放在 12~15 脚，
  //   与 TTL 的 74LS194 **不兼容**。本库按 74LS194/74194 的 TTL 连接图建模（国内数电教材通用的一版）。
  //   功能表上 "左移/右移" 的叫法在两家手册里方向相反，本库采用 TI 的定义：
  //   右移 = 数据从 SR 进 Q0 往 Q3 走，左移 = 数据从 SL 进 Q3 往 Q0 走。
  define({
    model: '74LS194',
    package: 16,
    pins: pinRange(16),
    vccPin: 16,
    gndPin: 8,
    pinNames: {
      '~MR': 1, SR: 2, Q0: 3, Q1: 4, Q2: 5, Q3: 6, SL: 7, GND: 8,
      S1: 9, S0: 10, CLK: 11, D3: 12, D2: 13, D1: 14, D0: 15, VCC: 16
    },
    eval: function (pinLevels, ctx) {
      var st = ctx.state;
      var mr = binLevel(pinLevels, 1, ctx);     // 异步清零，低有效
      var cp = binLevel(pinLevels, 11, ctx);    // 时钟，上升沿有效
      var s1 = binLevel(pinLevels, 9, ctx);
      var s0 = binLevel(pinLevels, 10, ctx);

      var qs = st.qs;
      if (!qs || qs.length !== 4) {
        qs = [L0, L0, L0, L0];
        st.qs = qs;
      }
      var prevCp = st.cp;
      st.cp = cp;

      var i;
      if (mr === L0) {
        for (i = 0; i < 4; i++) qs[i] = L0;      // 异步清零
      } else if (mr === LX) {
        for (i = 0; i < 4; i++) qs[i] = LX;
      } else if (prevCp === L0 && cp === L1) {
        if (s1 === LX || s0 === LX) {
          for (i = 0; i < 4; i++) qs[i] = LX;
        } else if (s1 === L1 && s0 === L1) {
          // 并行置数：D0~D3 引脚 15,14,13,12
          var dPins = [15, 14, 13, 12];
          for (i = 0; i < 4; i++) {
            var d = binLevel(pinLevels, dPins[i], ctx);
            qs[i] = (d === L0 || d === L1) ? d : LX;
          }
        } else if (s1 === L0 && s0 === L1) {
          // 右移：SR(2) -> Q0，Q0 -> Q1 -> Q2 -> Q3
          var sr = binLevel(pinLevels, 2, ctx);
          var nextR = [(sr === L0 || sr === L1) ? sr : LX, qs[0], qs[1], qs[2]];
          for (i = 0; i < 4; i++) qs[i] = nextR[i];
        } else if (s1 === L1 && s0 === L0) {
          // 左移：SL(7) -> Q3，Q3 -> Q2 -> Q1 -> Q0
          var sl = binLevel(pinLevels, 7, ctx);
          var nextL = [qs[1], qs[2], qs[3], (sl === L0 || sl === L1) ? sl : LX];
          for (i = 0; i < 4; i++) qs[i] = nextL[i];
        }
        // S1=0 且 S0=0：保持
      }

      var res = {};
      var qPins = [3, 4, 5, 6];
      for (i = 0; i < 4; i++) res[qPins[i]] = outLevel(qs[i]);
      return res;
    }
  });

  /* ---------- 20 脚：八 D 触发器 74LS273 ---------- */

  define({
    model: '74LS273',
    package: 20,
    pins: pinRange(20),
    vccPin: 20,
    gndPin: 10,
    pinNames: {
      '~MR': 1, Q0: 2, D0: 3, D1: 4, Q1: 5, Q2: 6, D2: 7, D3: 8, Q3: 9, GND: 10,
      CLK: 11, Q4: 12, D4: 13, D5: 14, Q5: 15, Q6: 16, D6: 17, D7: 18, Q7: 19, VCC: 20
    },
    eval: function (pinLevels, ctx) {
      var st = ctx.state;
      var mr = binLevel(pinLevels, 1, ctx);     // 异步清零，低有效
      var cp = binLevel(pinLevels, 11, ctx);    // 上升沿触发

      var dPins = [3, 4, 7, 8, 13, 14, 17, 18];
      var qPins = [2, 5, 6, 9, 12, 15, 16, 19];
      var qs = st.qs;
      if (!qs || qs.length !== 8) {
        qs = [L0, L0, L0, L0, L0, L0, L0, L0];
        st.qs = qs;
      }
      var prevCp = st.cp;
      st.cp = cp;

      var i;
      if (mr === L0) {
        for (i = 0; i < 8; i++) qs[i] = L0;      // 异步清零
      } else if (mr === LX) {
        for (i = 0; i < 8; i++) qs[i] = LX;
      } else if (prevCp === L0 && cp === L1) {
        for (i = 0; i < 8; i++) {                // 上升沿锁存
          var d = binLevel(pinLevels, dPins[i], ctx);
          qs[i] = (d === L0 || d === L1) ? d : LX;
        }
      }

      var res = {};
      for (i = 0; i < 8; i++) res[qPins[i]] = outLevel(qs[i]);
      return res;
    }
  });

  /* ============================================================
   * 4b. 补充组合芯片（74LS21 / 74LS30 / 74LS47 / 74LS48）
   *     2026-10-30 审查新增：对应真实面板 LCD「芯片真值表」菜单中的
   *     7421 / 7430 / 7447 / 7448（实物菜单不带 LS 前缀，模型统一用 LS 前缀命名）。
   * ============================================================ */

  /** N 输入与（四态）：有 '0' 得 '0'；全 '1' 得 '1'；否则 'X' */
  function andNLevels(levels) {
    var unknown = false;
    for (var i = 0; i < levels.length; i++) {
      if (levels[i] === L0) return L0;
      if (levels[i] === LX) unknown = true;
    }
    return unknown ? LX : L1;
  }

  /** N 输入与非（四态） */
  function nandNLevels(levels) {
    return Logic.not(andNLevels(levels));
  }

  /* ---------- 14 脚：双四输入与门 74LS21（LCD 菜单显示为 7421） ---------- */

  // 引脚（通用 7421 排列，DIP-14 顶视）：1 1A, 2 1B, 3 NC, 4 1C, 5 1D, 6 1Y, 7 GND,
  //   8 2Y, 9 2A, 10 2B, 11 NC, 12 2C, 13 2D, 14 VCC。3、11 为空脚。
  define({
    model: '74LS21',
    package: 14,
    pins: pinRange(14),
    vccPin: 14,
    gndPin: 7,
    pinNames: {
      '1A': 1, '1B': 2, 'NC1': 3, '1C': 4, '1D': 5, '1Y': 6, GND: 7,
      '2Y': 8, '2A': 9, '2B': 10, 'NC2': 11, '2C': 12, '2D': 13, VCC: 14
    },
    eval: function (pinLevels, ctx) {
      var res = {};
      res[6] = outLevel(andNLevels([
        binLevel(pinLevels, 1, ctx), binLevel(pinLevels, 2, ctx),
        binLevel(pinLevels, 4, ctx), binLevel(pinLevels, 5, ctx)]));
      res[8] = outLevel(andNLevels([
        binLevel(pinLevels, 9, ctx), binLevel(pinLevels, 10, ctx),
        binLevel(pinLevels, 12, ctx), binLevel(pinLevels, 13, ctx)]));
      return res;
    }
  });

  /* ---------- 14 脚：八输入与非门 74LS30（LCD 菜单显示为 7430） ---------- */

  // 引脚（通用 7430 排列，DIP-14 顶视）：1 A, 2 B, 3 C, 4 D, 5 E, 6 F, 7 GND,
  //   8 Y, 9 NC, 10 NC, 11 G, 12 H, 13 NC, 14 VCC。9、10、13 为空脚。
  define({
    model: '74LS30',
    package: 14,
    pins: pinRange(14),
    vccPin: 14,
    gndPin: 7,
    pinNames: {
      A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, GND: 7,
      Y: 8, 'NC1': 9, 'NC2': 10, G: 11, H: 12, 'NC3': 13, VCC: 14
    },
    eval: function (pinLevels, ctx) {
      var res = {};
      res[8] = outLevel(nandNLevels([
        binLevel(pinLevels, 1, ctx), binLevel(pinLevels, 2, ctx),
        binLevel(pinLevels, 3, ctx), binLevel(pinLevels, 4, ctx),
        binLevel(pinLevels, 5, ctx), binLevel(pinLevels, 6, ctx),
        binLevel(pinLevels, 11, ctx), binLevel(pinLevels, 12, ctx)]));
      return res;
    }
  });

  /* ---------- 16 脚：BCD 七段译码显示驱动器 74LS47 / 74LS48 ---------- */

  // 真实 LCD「芯片真值表」菜单显示为 7447 / 7448。
  // 段码来源（两表交叉验证一致：47 与 48 对 0~15 的显示图形完全相同，
  // 仅输出极性相反——47 低有效 OC 输出，48 高有效内部上拉）：
  //   1) Renesas HD74LS47 数据手册 Function Table（REJ03D0410 Rev.3.01, p2，
  //      http://www.ic-on-line.net/view_online.php?id=1381044 ）；
  //   2) eepw 7448 真值表（http://m.eepw.com.cn/article/diagram/32842.html）。
  // 注意：47/48 的 6 显示为 b~g（a 段不亮）、9 显示为 a,b,c,f,g（d 段不亮），
  //       与部分资料画法不同，以数据手册为准。
  // 输入 10~15 为非 BCD 码：47/48 输出「鉴定输入条件」的独特图形
  //（10: d,e,g  11: c,d,g  12: b,f,g  13: a,d,f,g  14: d,e,f,g  15: 全灭）。
  // 段序 [a,b,c,d,e,f,g]，1=该段点亮：
  var SEG_BCD7_ON = [
    '1111110', '0110000', '1101101', '1111001',
    '0110011', '1011011', '0011111', '1110000',
    '1111111', '1110011', '0001101', '0011001',
    '0100011', '1001011', '0001111', '0000000'
  ];

  /**
   * 构造 BCD 七段译码驱动器的求值函数。
   * 控制引脚优先级（Renesas HD74LS47 手册 Notes 1~4）：
   *   ~BI=0：全部熄灭（最高优先级，覆盖其它一切输入）；
   *   ~LT=0：全部点亮（灯测试，要求 BI/RBO 节点为高）；
   *   ~RBI=0 且输入为 0：全部熄灭（动态灭零；真实芯片此时还会把 RBO 拉低，
   *     本模型把 4 脚仅当输入用，RBO 不反向驱动，见 CONTRACTS.md §5.2）。
   * @param {boolean} activeLow true=74LS47（点亮输出 '0'）；false=74LS48（点亮输出 '1'）
   */
  function makeBcd7SegEval(activeLow) {
    var ON = activeLow ? L0 : L1;
    var OFF = activeLow ? L1 : L0;
    var segPins = [13, 12, 11, 10, 9, 15, 14];   // a b c d e f g
    return function (pinLevels, ctx) {
      var res = {};
      var i;
      if (binLevel(pinLevels, 4, ctx) === L0) {              // ~BI：灭灯优先
        for (i = 0; i < 7; i++) res[segPins[i]] = OFF;
        return res;
      }
      if (binLevel(pinLevels, 3, ctx) === L0) {              // ~LT：灯测试
        for (i = 0; i < 7; i++) res[segPins[i]] = ON;
        return res;
      }
      var d = binLevel(pinLevels, 6, ctx);
      var c = binLevel(pinLevels, 2, ctx);
      var b = binLevel(pinLevels, 1, ctx);
      var a = binLevel(pinLevels, 7, ctx);
      if (binLevel(pinLevels, 5, ctx) === L0 &&              // ~RBI：动态灭零
          d === L0 && c === L0 && b === L0 && a === L0) {
        for (i = 0; i < 7; i++) res[segPins[i]] = OFF;
        return res;
      }
      var pattern = null;
      if (d !== LX && c !== LX && b !== LX && a !== LX) {    // TTL 悬空输入已被 binLevel 归一为 '1'
        pattern = SEG_BCD7_ON[(d === L1 ? 8 : 0) + (c === L1 ? 4 : 0) +
                              (b === L1 ? 2 : 0) + (a === L1 ? 1 : 0)];
      }
      for (i = 0; i < 7; i++) {
        res[segPins[i]] = pattern ? (pattern.charAt(i) === '1' ? ON : OFF) : LX;
      }
      return res;
    };
  }

  // 引脚（两型号相同，DIP-16 顶视）：1 B, 2 C, 3 ~LT, 4 ~BI/RBO, 5 ~RBI, 6 D, 7 A,
  //   8 GND, 9 e, 10 d, 11 c, 12 b, 13 a, 14 g, 15 f, 16 VCC。
  // 真实 74LS47 为集电极开路输出：点亮=灌电流拉低，熄灭=悬空需外接上拉；
  // 本引擎统一按理想逻辑电平建模（47 点亮输出 '0'、48 点亮输出 '1'），
  // 与面板七段显示 / 示波器的 TTL 读取约定一致。
  define({
    model: '74LS47',
    package: 16,
    pins: pinRange(16),
    vccPin: 16,
    gndPin: 8,
    pinNames: {
      B: 1, C: 2, '~LT': 3, '~BI': 4, '~RBI': 5, D: 6, A: 7, GND: 8,
      e: 9, d: 10, c: 11, b: 12, a: 13, g: 14, f: 15, VCC: 16
    },
    eval: makeBcd7SegEval(true)
  });

  /* ---------- 16 脚：BCD 七段译码显示驱动器 74LS48（高有效输出） ---------- */

  define({
    model: '74LS48',
    package: 16,
    pins: pinRange(16),
    vccPin: 16,
    gndPin: 8,
    pinNames: {
      B: 1, C: 2, '~LT': 3, '~BI': 4, '~RBI': 5, D: 6, A: 7, GND: 8,
      e: 9, d: 10, c: 11, b: 12, a: 13, g: 14, f: 15, VCC: 16
    },
    eval: makeBcd7SegEval(false)
  });

  /* ============================================================
   * 5. 芯片库导出
   * ============================================================ */

  var Chips = {
    MODELS: MODELS,
    /** 取型号定义，不存在返回 null */
    get: function (model) {
      return MODELS[model] || null;
    },
    /** 是否支持该型号 */
    has: function (model) {
      return !!MODELS[model];
    },
    /** 型号列表 */
    list: function () {
      var out = [];
      for (var k in MODELS) {
        if (Object.prototype.hasOwnProperty.call(MODELS, k)) out.push(k);
      }
      out.sort();
      return out;
    },
    /** 型号的封装脚数（14 / 16 / 20），未知型号返回 0 */
    packageOf: function (model) {
      var d = MODELS[model];
      return d ? d.package : 0;
    },
    /** 型号的引脚名 -> 引脚号表（未知型号返回 null） */
    pinNamesOf: function (model) {
      var d = MODELS[model];
      return d ? d.pinNames : null;
    }
  };

  DLab.Chips = Chips;

})(typeof globalThis !== 'undefined' ? globalThis : this);

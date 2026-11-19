// src/core/grader.js
// 真值表批量打分（纯逻辑、Node 可测）。
// ------------------------------------------------------------------
// 契约：docs/STAGE4-CONTRACTS.md §5.2
//   DLab.Grader = { buildTask(def) → task, grade(engine, task, options) → result }
//
// 打分流程（严格按契约）：
//   1. 快照 16 个开关状态
//   2. 逐行施加激励（inputs 用开关驱动 engine.setSwitch）
//   3. engine.step(固定时刻，默认 timeMs = 1000，逐行 timeMs + rowIndex * 10)
//   4. 读 outputs（engine.getJackLevel(id)，'1' 记 1，其它记 0）
//   5. 逐一恢复 16 个开关
// 打分**不得**增删导线、**不得**插拔芯片。
(function (global) {
  'use strict';
  var DLab = (global.DLab = global.DLab || {});

  /* ============================================================
   * 1. 常量
   * ============================================================ */

  /** 板载逻辑电平开关数量 */
  var SWITCH_COUNT = 16;

  /** 默认打分时刻（毫秒）。避开时钟边沿抖动，取 1000 */
  var DEFAULT_TIME_MS = 1000;

  /** 逐行时间步进（毫秒） */
  var ROW_TIME_STEP_MS = 10;

  /* ============================================================
   * 2. 小工具
   * ============================================================ */

  function has(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** 把任意值收敛成 0/1 数字数组 */
  function toBits(value) {
    var out = [];
    if (!Array.isArray(value)) return out;
    for (var i = 0; i < value.length; i++) {
      var v = value[i];
      out.push((v === 1 || v === '1' || v === true) ? 1 : 0);
    }
    return out;
  }

  /**
   * 从插孔 id 里解析出开关编号。
   * 支持 'sw:5K1' / '5K1' / 'sw:5K16' 几种写法。
   * @returns {number} 1..16；解析不出来返回 0
   */
  function switchNumberOf(jackId) {
    if (typeof jackId !== 'string' || !jackId) return 0;
    var label = jackId;
    var idx = label.indexOf(':');
    if (idx >= 0) {
      var mod = label.slice(0, idx);
      if (mod !== 'sw') return 0;
      label = label.slice(idx + 1);
    }
    var m = /^5K(\d+)$/.exec(label);
    if (!m) return 0;
    var n = parseInt(m[1], 10);
    if (!isFinite(n) || n < 1 || n > SWITCH_COUNT) return 0;
    return n;
  }

  /* ============================================================
   * 3. 题面归一化
   * ============================================================ */

  /**
   * 归一化题面。
   * @param {object} def 原始题面
   * @returns {{id,title,description,inputs,outputs,rows:[{in:[],out:[]}]}}
   */
  function buildTask(def) {
    def = (def && typeof def === 'object') ? def : {};
    var inputs = [];
    var outputs = [];
    var rows = [];

    if (Array.isArray(def.inputs)) {
      for (var i = 0; i < def.inputs.length; i++) {
        var inputId = def.inputs[i];
        if (typeof inputId === 'string' && inputId) inputs.push(inputId);
      }
    }
    if (Array.isArray(def.outputs)) {
      for (var o = 0; o < def.outputs.length; o++) {
        var outputId = def.outputs[o];
        if (typeof outputId === 'string' && outputId) outputs.push(outputId);
      }
    }
    if (Array.isArray(def.rows)) {
      for (var r = 0; r < def.rows.length; r++) {
        var row = def.rows[r];
        if (!row || typeof row !== 'object') continue;
        rows.push({
          in: toBits(row.in),
          out: toBits(row.out)
        });
      }
    }

    return {
      id: (typeof def.id === 'string' && def.id) ? def.id : 'task',
      title: (typeof def.title === 'string' && def.title) ? def.title : '未命名题目',
      description: (typeof def.description === 'string') ? def.description : '',
      inputs: inputs,
      outputs: outputs,
      rows: rows
    };
  }

  /* ============================================================
   * 4. 打分
   * ============================================================ */

  /**
   * 静默打分。
   * @param {object} engine DLab.Engine 实例
   * @param {object} task 题面（原始对象或已归一化的对象都行）
   * @param {object} [options] { timeMs?: number, restore?: boolean }
   * @returns {{ok,total,passed,failed,rows:[{in,expected,actual,pass}],message}}
   */
  function grade(engine, task, options) {
    options = options || {};
    var t = buildTask(task);
    var timeMs = (typeof options.timeMs === 'number' && isFinite(options.timeMs))
      ? options.timeMs : DEFAULT_TIME_MS;
    var restore = (options.restore === undefined) ? true : !!options.restore;

    var rows = [];
    var passed = 0;
    var failed = 0;

    if (!engine || typeof engine.step !== 'function') {
      return {
        ok: false,
        total: t.rows.length,
        passed: 0,
        failed: t.rows.length,
        rows: rows,
        message: '打分失败：仿真引擎不可用'
      };
    }

    // ---- 1. 快照开关 ----
    var snapshot = [];
    for (var s = 0; s < SWITCH_COUNT; s++) {
      var v = 0;
      try {
        v = engine.getSwitch(s + 1) ? 1 : 0;
      } catch (err) {
        v = 0;
      }
      snapshot.push(v);
    }

    // ---- 2~4. 逐行施加激励、推进、读输出 ----
    // H7（2026-10-30 性能审查遗留项）：判分表是批量变更路径——P1 让每行的
    // setSwitch 各自自动重算（按旧时刻，结果随即被本行显式 step(lastTime)
    // 覆盖），批量包装后每行只剩显式推进一次；激励施加期间无人读状态，
    // 行为完全等价。
    var batching = false;
    if (typeof engine.beginBatch === 'function' && typeof engine.endBatch === 'function') {
      engine.beginBatch();
      batching = true;
    }
    try {
    var lastTime = timeMs;
    for (var r = 0; r < t.rows.length; r++) {
      var row = t.rows[r];
      var inBits = row.in;
      var expected = row.out;

      // 施加激励：inputs[i] 对应第 i 个开关
      for (var i = 0; i < t.inputs.length; i++) {
        var swNo = switchNumberOf(t.inputs[i]);
        if (!swNo) continue;
        var bit = (i < inBits.length) ? inBits[i] : 0;
        try {
          engine.setSwitch(swNo, bit);
        } catch (err) {
          // 开关编号非法时跳过该路，不影响其它行
        }
      }

      // 推进仿真（固定时刻，逐行 +10ms）
      lastTime = timeMs + r * ROW_TIME_STEP_MS;
      try {
        engine.step(lastTime);
      } catch (err) {
        // 推进失败时按当前状态读输出（尽量给出结果，而不是整份失败）
      }

      // 读输出
      var actual = [];
      for (var o = 0; o < t.outputs.length; o++) {
        var outId = t.outputs[o];
        var level = 'Z';
        try {
          level = engine.getJackLevel(outId);
        } catch (err) {
          level = 'Z';
        }
        actual.push(level === '1' ? 1 : 0);
      }

      var pass = sameBits(expected, actual);
      if (pass) passed += 1;
      else failed += 1;

      rows.push({
        in: inBits.slice(),
        expected: expected.slice(),
        actual: actual,
        pass: pass
      });
    }   // for r（H7 批量 try 内的行循环）
    } finally {
      if (batching) engine.endBatch();
    }

    // ---- 5. 恢复开关 ----
    if (restore) {
      // H7：16 次开关恢复同样走批量，收尾只补一次推进（与下方显式 step 合并）
      var batching2 = false;
      if (typeof engine.beginBatch === 'function' && typeof engine.endBatch === 'function') {
        engine.beginBatch();
        batching2 = true;
      }
      try {
        for (var k = 0; k < SWITCH_COUNT; k++) {
          try {
            engine.setSwitch(k + 1, snapshot[k]);
          } catch (err) {
            // 忽略：恢复失败不影响打分结果
          }
        }
        // 恢复后再推进一步，保证引擎状态与恢复后的开关一致
        try {
          engine.step(lastTime);
        } catch (err) {
          // 忽略
        }
      } finally {
        if (batching2) engine.endBatch();
      }
    }

    var total = rows.length;
    var ok = total > 0 && failed === 0;
    var message;
    if (total === 0) {
      message = '题面没有真值表行，无法打分';
    } else if (ok) {
      message = '全部通过：' + passed + '/' + total + ' 行正确';
    } else {
      message = '未通过：' + passed + '/' + total + ' 行正确，' + failed + ' 行错误';
    }

    return {
      ok: ok,
      total: total,
      passed: passed,
      failed: failed,
      rows: rows,
      message: message
    };
  }

  /** 两个 0/1 数组是否完全一致 */
  function sameBits(a, b) {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /* ============================================================
   * 5. 导出
   * ============================================================ */

  DLab.Grader = {
    buildTask: buildTask,
    grade: grade,
    // 额外暴露，便于自测与 UI 复用
    SWITCH_COUNT: SWITCH_COUNT,
    DEFAULT_TIME_MS: DEFAULT_TIME_MS,
    ROW_TIME_STEP_MS: ROW_TIME_STEP_MS,
    switchNumberOf: switchNumberOf
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);

// src/core/quiz.js
// 自动出题：生成「半成品工程包 + 题面 + 参考答案」。
// ------------------------------------------------------------------
// 契约：docs/STAGE4-CONTRACTS.md §5.3
//   DLab.Quiz = { TEMPLATES, generate(templateId, options), readTask(fileOrText) }
//
// 三个模板（契约要求至少 3 个）：
//   quiz-inverter —— 74LS00 反相器（把与非门两个输入并联）
//   quiz-nand     —— 74LS00 二输入与非门
//   quiz-decoder  —— 74LS138 使能与译码
//
// generate 产生的半成品：已插芯片、已接好 VCC/GND，**故意留空 1~2 根关键导线**；
// solution.wires 是留给教师 / 自测的「补齐用」导线，接上后 Grader.grade 必须 100% 通过。
//
// project 必须能通过 DLab.Persistence.validateProject：
//   format = 'dlab-project'、version = 1、引用的插孔 id 全部真实存在。
// project.task 是新增字段；老版本「未知字段忽略」，导入不报错。
(function (global) {
  'use strict';
  var DLab = (global.DLab = global.DLab || {});

  /* ============================================================
   * 1. 常量
   * ============================================================ */

  var FORMAT = 'dlab-project';
  var VERSION = 1;

  /** 导线颜色板（与 CONTRACTS §7 一致） */
  var COLOR_VCC = '#ef4444';
  var COLOR_GND = '#1f2937';
  var COLOR_SIG = '#3b82f6';
  var COLOR_TIE = '#eab308';
  var COLOR_OUT = '#22c55e';

  /** 板载逻辑电平开关数量 */
  var SWITCH_COUNT = 16;

  /* ============================================================
   * 2. 模板清单（契约固定字段：id / title / description / pins / difficulty）
   * ============================================================ */

  var TEMPLATES = [
    {
      id: 'quiz-inverter',
      title: '用 74LS00 实现反相器',
      description: '74LS00 是四路二输入与非门。把其中一路的两个输入端并联接到同一个信号，输出即为该信号的反相。',
      pins: '14P',
      difficulty: 1
    },
    {
      id: 'quiz-nand',
      title: '74LS00 二输入与非门',
      description: '把开关 5K1、5K2 分别接到 74LS00 第一路与非门的两个输入端，输出接指示灯 4P1。',
      pins: '14P',
      difficulty: 1
    },
    {
      id: 'quiz-decoder',
      title: '74LS138 使能与译码',
      description: '给 74LS138 接好三个地址输入 A/B/C 与使能端（G1 接 +5V，~G2A、~G2B 接 +5V），观察 Y0、Y1 两路译码输出。',
      pins: '16P',
      difficulty: 2
    }
  ];

  /* ============================================================
   * 3. 模板内部定义（接线方案 / 题面 / 留空哪些导线）
   * ============================================================ */

  /**
   * 每个模板的完整接线方案与题面。
   *   socket     插座 id
   *   model      芯片型号
   *   wires      完整方案（顺序即导线顺序）
   *   omit       半成品里**故意留空**的导线在 wires 里的下标（1~2 个）
   *   inputs     题面输入（开关插孔）
   *   outputs    题面输出（观测插孔）
   *   rows       真值表
   *   blankNote  留空说明（写进题面描述）
   */
  var SPECS = {
    'quiz-inverter': {
      socket: 'devA:UA',
      model: '74LS00',
      wires: [
        { from: 'pwr:5V1', to: 'devA:A14', color: COLOR_VCC },
        { from: 'gnd:GND1', to: 'devA:A7', color: COLOR_GND },
        { from: 'sw:5K1', to: 'devA:A1', color: COLOR_SIG },
        { from: 'devA:A1', to: 'devA:A2', color: COLOR_TIE },
        { from: 'devA:A3', to: 'led:4P1', color: COLOR_OUT }
      ],
      omit: [2, 3],
      inputs: ['sw:5K1'],
      outputs: ['led:4P1'],
      rows: [
        { in: [0], out: [1] },
        { in: [1], out: [0] }
      ],
      blankNote: '还差两根线：① 开关 5K1 → 芯片 1A（devA:A1）；② 1A 与 1B（devA:A2）并联。'
    },

    'quiz-nand': {
      socket: 'devA:UA',
      model: '74LS00',
      wires: [
        { from: 'pwr:5V1', to: 'devA:A14', color: COLOR_VCC },
        { from: 'gnd:GND1', to: 'devA:A7', color: COLOR_GND },
        { from: 'sw:5K1', to: 'devA:A1', color: COLOR_SIG },
        { from: 'sw:5K2', to: 'devA:A2', color: COLOR_SIG },
        { from: 'devA:A3', to: 'led:4P1', color: COLOR_OUT }
      ],
      omit: [2, 3],
      inputs: ['sw:5K1', 'sw:5K2'],
      outputs: ['led:4P1'],
      rows: [
        { in: [0, 0], out: [1] },
        { in: [0, 1], out: [1] },
        { in: [1, 0], out: [1] },
        { in: [1, 1], out: [0] }
      ],
      blankNote: '还差两根线：① 开关 5K1 → 1A（devA:A1）；② 开关 5K2 → 1B（devA:A2）。'
    },

    'quiz-decoder': {
      socket: 'devA:UE',
      model: '74LS138',
      wires: [
        { from: 'pwr:5V1', to: 'devA:E16', color: COLOR_VCC },   // VCC
        { from: 'gnd:GND1', to: 'devA:E8', color: COLOR_GND },   // GND
        { from: 'pwr:5V1', to: 'devA:E6', color: COLOR_VCC },    // G1（高有效使能）
        { from: 'gnd:GND1', to: 'devA:E4', color: COLOR_GND },   // ~G2A（低有效使能）
        { from: 'gnd:GND1', to: 'devA:E5', color: COLOR_GND },   // ~G2B（低有效使能）
        { from: 'sw:5K1', to: 'devA:E1', color: COLOR_SIG },     // A
        { from: 'sw:5K2', to: 'devA:E2', color: COLOR_SIG },     // B
        { from: 'sw:5K3', to: 'devA:E3', color: COLOR_SIG },     // C
        { from: 'devA:E15', to: 'led:4P1', color: COLOR_OUT },   // Y0
        { from: 'devA:E14', to: 'led:4P2', color: COLOR_OUT }    // Y1
      ],
      omit: [3, 5],
      inputs: ['sw:5K1', 'sw:5K2', 'sw:5K3'],
      outputs: ['led:4P1', 'led:4P2'],
      rows: [
        { in: [0, 0, 0], out: [0, 1] },
        { in: [1, 0, 0], out: [1, 0] },
        { in: [0, 1, 0], out: [1, 1] },
        { in: [0, 0, 1], out: [1, 1] }
      ],
      blankNote: '还差两根线：① ~G2A（devA:E4）接地；② 地址端 A（devA:E1）接开关 5K1。'
    }
  };

  /* ============================================================
   * 4. 小工具
   * ============================================================ */

  function has(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** 取模板定义（未知 id 返回 null） */
  function specOf(templateId) {
    if (typeof templateId !== 'string') return null;
    return has(SPECS, templateId) ? SPECS[templateId] : null;
  }

  /** 模板元信息（按 id） */
  function templateOf(templateId) {
    for (var i = 0; i < TEMPLATES.length; i++) {
      if (TEMPLATES[i].id === templateId) return TEMPLATES[i];
    }
    return null;
  }

  /** 生成导线 id（半成品与答案分开编号，便于分别导入） */
  function makeWireId(prefix, index) {
    return prefix + (index + 1);
  }

  /** 把「线序 + 下标」变成一根带 id 的导线 */
  function makeWire(prefix, index, spec) {
    return {
      id: makeWireId(prefix, index),
      from: spec.from,
      to: spec.to,
      color: spec.color || COLOR_SIG
    };
  }

  /** 全部开关归零 */
  function zeroSwitches() {
    var out = {};
    for (var i = 1; i <= SWITCH_COUNT; i++) out['5K' + i] = 0;
    return out;
  }

  /* ============================================================
   * 5. 生成半成品
   * ============================================================ */

  /**
   * 生成一套半成品工程 + 题面 + 参考答案。
   * @param {string} templateId 模板 id
   * @param {object} [options] { now?: number|Date, switches?: object }
   * @returns {{project:object, task:object, solution:{wires:object[]}, message:string}}
   */
  function generate(templateId, options) {
    options = options || {};
    var spec = specOf(templateId);
    var meta = templateOf(templateId);
    if (!spec || !meta) {
      return {
        project: null,
        task: null,
        solution: { wires: [] },
        message: '未知的题目模板：' + (templateId === undefined ? '(空)' : templateId)
      };
    }

    // ---- 题面 ----
    var task = {
      id: meta.id,
      title: meta.title,
      description: meta.description + (spec.blankNote ? '\n\n待补接线：' + spec.blankNote : ''),
      inputs: spec.inputs.slice(),
      outputs: spec.outputs.slice(),
      rows: spec.rows.map(function (row) {
        return { in: row.in.slice(), out: row.out.slice() };
      })
    };

    // ---- 半成品导线：去掉 omit 里那几根 ----
    var omit = Array.isArray(spec.omit) ? spec.omit : [];
    var projectWires = [];
    for (var i = 0; i < spec.wires.length; i++) {
      if (omit.indexOf(i) >= 0) continue;
      projectWires.push(makeWire('qw', i, spec.wires[i]));
    }

    // ---- 答案导线：正是被留空的那几根 ----
    var solutionWires = [];
    for (var k = 0; k < omit.length; k++) {
      solutionWires.push(makeWire('sw', omit[k], spec.wires[omit[k]]));
    }

    // ---- 开关初值 ----
    var switches = zeroSwitches();
    if (options.switches && typeof options.switches === 'object') {
      for (var s = 1; s <= SWITCH_COUNT; s++) {
        var key = '5K' + s;
        if (has(options.switches, key)) switches[key] = options.switches[key] ? 1 : 0;
      }
    }

    // ---- 时间戳 ----
    var now = options.now;
    var savedAt;
    if (now instanceof Date) savedAt = now.toISOString();
    else if (typeof now === 'number' && isFinite(now)) savedAt = new Date(now).toISOString();
    else savedAt = new Date().toISOString();

    // ---- 工程包 ----
    var project = {
      format: FORMAT,
      version: VERSION,
      savedAt: savedAt,
      power: true,
      switches: switches,
      chips: {},
      wires: projectWires,
      // 新增字段：题面。老版本「未知字段忽略」，导入不报错。
      task: task
    };
    project.chips[spec.socket] = spec.model;

    var message = '已生成《' + meta.title + '》半成品：芯片 ' + spec.model + ' 已插在 ' + spec.socket +
      '，VCC / GND 已接好，还差 ' + solutionWires.length + ' 根关键导线';

    return {
      project: project,
      task: task,
      solution: { wires: solutionWires },
      message: message
    };
  }

  /* ============================================================
   * 6. 读入题面
   * ============================================================ */

  /** 读出文本（兼容 string / File / Blob / 普通对象） */
  function readTextOf(fileOrText) {
    return new Promise(function (resolve, reject) {
      if (fileOrText === null || fileOrText === undefined) {
        reject(new Error('没有选择文件'));
        return;
      }
      if (typeof fileOrText === 'string') {
        resolve(fileOrText);
        return;
      }
      if (typeof fileOrText === 'object' && typeof fileOrText.text === 'function') {
        // 现代浏览器的 File / Blob
        fileOrText.text().then(resolve, reject);
        return;
      }
      if (typeof fileOrText === 'object' && !Array.isArray(fileOrText)) {
        // 已经是解析好的工程对象
        try {
          resolve(JSON.stringify(fileOrText));
        } catch (err) {
          reject(new Error('文件内容无法序列化'));
        }
        return;
      }
      if (typeof FileReader !== 'undefined') {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result)); };
        reader.onerror = function () { reject(new Error('读取文件失败')); };
        try {
          reader.readAsText(fileOrText, 'utf-8');
        } catch (err) {
          reject(new Error('读取文件失败：' + (err && err.message ? err.message : '未知错误')));
        }
        return;
      }
      reject(new Error('当前环境无法读取文件内容'));
    });
  }

  /**
   * 读入 .dlab.json 文本 / File 对象，抽出题面（**不导入电路**）。
   * @returns {Promise<{ok:boolean, task:object|null, message:string}>}
   */
  function readTask(fileOrText) {
    return readTextOf(fileOrText).then(function (text) {
      var raw;
      try {
        raw = JSON.parse(text);
      } catch (err) {
        return {
          ok: false,
          task: null,
          message: 'JSON 解析失败，文件可能已损坏：' + (err && err.message ? err.message : '未知错误')
        };
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, task: null, message: '不是合法的 DLab 工程文件（内容不是 JSON 对象）' };
      }
      if (raw.format !== FORMAT) {
        return {
          ok: false,
          task: null,
          message: '不是 DLab 工程文件（format 应为 "' + FORMAT + '"，实际为 "' + raw.format + '"）'
        };
      }
      if (!raw.task || typeof raw.task !== 'object') {
        return { ok: false, task: null, message: '文件里没有找到题面（task）字段' };
      }
      var Grader = DLab.Grader;
      var task = raw.task;
      if (Grader && typeof Grader.buildTask === 'function') {
        try {
          task = Grader.buildTask(raw.task);
        } catch (err) {
          task = raw.task;
        }
      }
      return {
        ok: true,
        task: task,
        message: '已读取题面：' + (task && task.title ? task.title : (task && task.id ? task.id : '未命名题目'))
      };
    }).catch(function (err) {
      return {
        ok: false,
        task: null,
        message: '读取失败：' + (err && err.message ? err.message : '未知错误')
      };
    });
  }

  /* ============================================================
   * 7. 导出
   * ============================================================ */

  DLab.Quiz = {
    TEMPLATES: TEMPLATES,
    generate: generate,
    readTask: readTask,
    // 额外暴露，便于自测与 UI 复用
    SPECS: SPECS,
    FORMAT: FORMAT,
    VERSION: VERSION
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);

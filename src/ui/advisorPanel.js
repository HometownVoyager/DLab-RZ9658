// src/ui/advisorPanel.js
// AI 助教侧栏 UI：接线审查 / 载入题目 / 真值表打分。
// ------------------------------------------------------------------
// 职责边界（契约 docs/STAGE4-CONTRACTS.md §5.4）：
//   本文件只做 DOM 与交互，所有判断逻辑都在
//     src/core/advisor.js → DLab.Advisor.review(engine)
//     src/core/grader.js  → DLab.Grader.buildTask / grade
//     src/core/quiz.js    → DLab.Quiz.readTask / generate
//   这三个模块与本模块并行开发，随时可能缺失、抛错或仍是桩，
//   因此这里对**每一次**跨模块调用都做特性检测 + 防御式取值：
//   缺模块只降级成中文提示，绝不抛错、绝不白屏。
//
// 与其它模块的约定：
//   · 插孔高亮统一走 wireLayer.setJackAlert(jackIds)（wire-ui 提供）；
//     该方法不存在时降级为「只在侧栏里列出相关插孔」，不抛错。
//   · 状态提示优先转发给 hud.setStatus(text, level)，hud 缺失时写侧栏底部状态行。
//   · 本模块自己创建「AI 助教」悬浮开关（不改 hud.js，那是别人的文件）。
(function (global) {
  'use strict';
  var DLab = (global.DLab = global.DLab || {});

  /* 侧栏宽度：契约 §5.4 要求 320~380px */
  var PANEL_WIDTH = 344;

  /* 问题级别：排序权重与中文标签（error → warn → info） */
  var LEVEL_ORDER = { error: 0, warn: 1, info: 2 };
  var LEVEL_TEXT = { error: '错误', warn: '警告', info: '提示' };

  /* 侧栏定位：贴住 #stage 的上下边界，底部留出缩放控件的位置 */
  var STAGE_TOP_GAP = 8;
  var STAGE_BOTTOM_RESERVE = 64;
  var MIN_HEIGHT = 240;

  /* 空状态文案（契约 §5.4 固定两句，其余为降级补充） */
  var EMPTY_IDLE = '还没有审查电路';
  var EMPTY_OK = '电路看起来没问题（未发现问题）';
  var EMPTY_NO_TASK = '还没有载入题目';
  var EMPTY_NO_GRADE = '还没有打分';
  var EMPTY_NO_ADVISOR = 'AI 审查模块不可用（src/core/advisor.js 未加载）';
  var EMPTY_NO_GRADER = '打分模块不可用（src/core/grader.js 未加载）';

  /* ---------------- 通用小工具 ---------------- */

  /** 取错误信息文本，任何异常对象都不会让它炸 */
  function msgOf(err) {
    if (!err) {
      return '未知错误';
    }
    if (typeof err === 'string') {
      return err;
    }
    if (err.message) {
      return String(err.message);
    }
    return String(err);
  }

  /** 创建元素（可带类名与文本） */
  function createEl(tag, className, text) {
    var node = global.document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  /** 把任意值收敛成数字数组（打分行用） */
  function toNumArray(value) {
    var out = [];
    if (!Array.isArray(value)) {
      return out;
    }
    for (var i = 0; i < value.length; i++) {
      out.push(Number(value[i]) ? 1 : 0);
    }
    return out;
  }

  /** 中文数字序列：把 [0,1] 显示成「0, 1」 */
  function joinNums(list) {
    if (!list || !list.length) {
      return '—';
    }
    return list.join(', ');
  }

  /**
   * 归一化一条 issue。
   * ai-core 若返回结构不完整（缺 level / title / jacks），这里补齐默认值，
   * 保证渲染层永远拿到形状固定的对象。
   */
  function normalizeIssue(raw, index) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    var level = LEVEL_ORDER.hasOwnProperty(raw.level) ? raw.level : 'info';
    var code = typeof raw.code === 'string' && raw.code ? raw.code : 'UNKNOWN';
    var jacks = [];
    if (Array.isArray(raw.jacks)) {
      for (var i = 0; i < raw.jacks.length; i++) {
        if (typeof raw.jacks[i] === 'string' && raw.jacks[i]) {
          jacks.push(raw.jacks[i]);
        }
      }
    }
    var id = typeof raw.id === 'string' && raw.id ? raw.id : code + '#' + (index + 1);
    return {
      id: id,
      level: level,
      code: code,
      title: typeof raw.title === 'string' && raw.title ? raw.title : code,
      detail: typeof raw.detail === 'string' ? raw.detail : '',
      hint: typeof raw.hint === 'string' ? raw.hint : '',
      jacks: jacks,
      socketId: typeof raw.socketId === 'string' ? raw.socketId : null,
      pin: typeof raw.pin === 'number' && isFinite(raw.pin) ? raw.pin : null
    };
  }

  /**
   * 归一化整份审查报告。
   * @returns {Object|null} 形状固定为契约 §5.1 的 report；入参非法时返回 null
   */
  function normalizeReport(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    var issuesIn = Array.isArray(raw.issues) ? raw.issues : [];
    var issues = [];
    for (var i = 0; i < issuesIn.length; i++) {
      var item = normalizeIssue(issuesIn[i], i);
      if (item) {
        issues.push(item);
      }
    }
    // 稳定排序：error → warn → info；同级保持 ai-core 给出的顺序
    issues.sort(function (a, b) {
      var d = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
      return d !== 0 ? d : 0;
    });
    // 排序稳定性兜底：现代引擎的 Array#sort 稳定，这里再加一层序号保证
    var withIndex = [];
    for (var k = 0; k < issues.length; k++) {
      withIndex.push({ issue: issues[k], order: k, level: LEVEL_ORDER[issues[k].level] });
    }
    withIndex.sort(function (a, b) {
      return a.level !== b.level ? a.level - b.level : a.order - b.order;
    });
    issues = withIndex.map(function (rec) {
      return rec.issue;
    });

    var summary = { error: 0, warn: 0, info: 0 };
    for (var s = 0; s < issues.length; s++) {
      summary[issues[s].level] += 1;
    }
    var rawSummary = raw.summary && typeof raw.summary === 'object' ? raw.summary : null;
    if (rawSummary) {
      // ai-core 的统计优先（它可能统计了未渲染的条目），但缺字段时用本地计数
      if (typeof rawSummary.error === 'number' && isFinite(rawSummary.error)) {
        summary.error = rawSummary.error;
      }
      if (typeof rawSummary.warn === 'number' && isFinite(rawSummary.warn)) {
        summary.warn = rawSummary.warn;
      }
      if (typeof rawSummary.info === 'number' && isFinite(rawSummary.info)) {
        summary.info = rawSummary.info;
      }
    }

    var stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
    return {
      ok: typeof raw.ok === 'boolean' ? raw.ok : summary.error === 0,
      generatedAt: typeof raw.generatedAt === 'number' && isFinite(raw.generatedAt)
        ? raw.generatedAt
        : Date.now(),
      summary: summary,
      issues: issues,
      stats: {
        wires: Number(stats.wires) || 0,
        chips: Number(stats.chips) || 0,
        poweredChips: Number(stats.poweredChips) || 0,
        floatingPins: Number(stats.floatingPins) || 0,
        shorts: Number(stats.shorts) || 0
      }
    };
  }

  /** 归一化题面（Grader.buildTask 存在时优先用它，保证与打分模块一致） */
  function normalizeTask(def) {
    if (!def || typeof def !== 'object') {
      return null;
    }
    var Grader = DLab.Grader;
    if (Grader && typeof Grader.buildTask === 'function') {
      try {
        var built = Grader.buildTask(def);
        if (built && typeof built === 'object') {
          return built;
        }
      } catch (err) {
        // 落到本地兜底
      }
    }
    var rows = [];
    if (Array.isArray(def.rows)) {
      for (var i = 0; i < def.rows.length; i++) {
        var r = def.rows[i];
        if (!r || typeof r !== 'object') {
          continue;
        }
        rows.push({ in: toNumArray(r.in), out: toNumArray(r.out) });
      }
    }
    return {
      id: typeof def.id === 'string' && def.id ? def.id : 'task',
      title: typeof def.title === 'string' && def.title ? def.title : '未命名题目',
      description: typeof def.description === 'string' ? def.description : '',
      inputs: Array.isArray(def.inputs) ? def.inputs.slice() : [],
      outputs: Array.isArray(def.outputs) ? def.outputs.slice() : [],
      rows: rows
    };
  }

  /** 归一化打分结果（ai-core 若仍是桩，这里也能渲染出「0/2」而不是白屏） */
  function normalizeGrade(raw, task) {
    var out = raw && typeof raw === 'object' ? raw : {};
    var taskRows = task && Array.isArray(task.rows) ? task.rows.length : 0;
    var rowsIn = Array.isArray(out.rows) ? out.rows : [];
    var rows = [];
    for (var i = 0; i < rowsIn.length; i++) {
      var r = rowsIn[i];
      if (!r || typeof r !== 'object') {
        continue;
      }
      rows.push({
        in: toNumArray(r.in),
        expected: toNumArray(r.expected),
        actual: toNumArray(r.actual),
        pass: !!r.pass
      });
    }
    var total = typeof out.total === 'number' && isFinite(out.total) && out.total > 0
      ? out.total
      : (taskRows || rows.length);
    var passed;
    if (typeof out.passed === 'number' && isFinite(out.passed)) {
      passed = out.passed;
    } else {
      passed = 0;
      for (var p = 0; p < rows.length; p++) {
        if (rows[p].pass) {
          passed += 1;
        }
      }
    }
    var failed = typeof out.failed === 'number' && isFinite(out.failed)
      ? out.failed
      : Math.max(0, total - passed);
    var ok = typeof out.ok === 'boolean' ? out.ok : (total > 0 && passed === total);
    return {
      ok: ok,
      total: total,
      passed: passed,
      failed: failed,
      rows: rows,
      message: typeof out.message === 'string' ? out.message : ''
    };
  }

  /** 读取文件文本：File / Blob / 字符串 / 普通对象都支持（便于 Node 与测试） */
  function readText(file) {
    return new Promise(function (resolve, reject) {
      if (typeof file === 'string') {
        resolve(file);
        return;
      }
      if (!file) {
        reject(new Error('没有选择文件'));
        return;
      }
      var isBlob = typeof Blob !== 'undefined' && file instanceof Blob;
      if (!isBlob && typeof file === 'object' && typeof file.text !== 'function' && !Array.isArray(file)) {
        // 普通对象：当作已经解析好的工程对象
        try {
          resolve(JSON.stringify(file));
        } catch (err) {
          reject(new Error('文件内容无法序列化'));
        }
        return;
      }
      if (!isBlob && typeof file.text === 'function') {
        file.text().then(resolve, reject);
        return;
      }
      if (typeof FileReader === 'undefined') {
        reject(new Error('当前环境不支持 FileReader'));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result));
      };
      reader.onerror = function () {
        reject(new Error('读取文件失败'));
      };
      try {
        reader.readAsText(file, 'utf-8');
      } catch (err) {
        reject(new Error('读取文件失败：' + msgOf(err)));
      }
    });
  }

  /* ---------------- AdvisorPanel ---------------- */

  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.container 侧栏容器（index.html 的 <aside id="assistant" data-assistant>）
   * @param {Object} opts.engine  DLab.Engine 实例
   * @param {Object} opts.wireLayer DLab.WireLayer 实例（提供 setJackAlert 时用于插孔高亮）
   * @param {Object} opts.hud DLab.Hud 实例（状态提示）
   * @param {Function} opts.onState 面板刷新回调（导入题目后同步 LED / 芯片视觉）
   */
  function AdvisorPanel(opts) {
    opts = opts || {};

    this.engine = opts.engine || null;
    this.wireLayer = opts.wireLayer || null;
    this.hud = opts.hud || null;
    this.onState = typeof opts.onState === 'function' ? opts.onState : null;
    this.container = opts.container || null;

    /* 运行状态 */
    this.isOpen = false;
    this.report = null;
    this.task = null;
    this.grade = null;
    this.highlighted = null;

    /* 内部状态 */
    this.started = false;
    this.built = false;
    this.bound = false;
    this.destroyed = false;
    this.headless = false;
    this._reviewState = 'idle';      // idle | done | missing
    this._reviewNotice = '';
    this._listeners = [];
    this._issueNodes = Object.create(null);
    this._alertSupported = null;      // null=未知，true/false=最近一次调用结果
    this._createdContainer = false;

    this._ensure();
  }

  /* ---------- 构建 DOM ---------- */

  /** 确保 DOM 已构建（构造函数与 start() 都会走到，幂等） */
  AdvisorPanel.prototype._ensure = function () {
    if (this.destroyed || this.built) {
      return this.built;
    }
    if (typeof global.document === 'undefined' || !global.document.createElement) {
      // Node 环境：只保留数据能力，不建 DOM
      this.headless = true;
      return false;
    }
    this._build();
    this._bind();
    this._syncGeometry();
    return this.built;
  };

  AdvisorPanel.prototype._build = function () {
    var doc = global.document;

    // 容器缺失时自建一个，保证本模块可以独立工作
    if (!this.container) {
      this.container = doc.createElement('aside');
      this.container.id = 'assistant';
      this.container.setAttribute('data-assistant', '');
      this.container.setAttribute('aria-label', 'AI 助教');
      if (doc.body) {
        doc.body.appendChild(this.container);
      }
      this._createdContainer = true;
    }
    this.container.textContent = '';

    // —— 悬浮开关：契约要求由本模块自己创建（hud.js 是别人的文件）——
    this.fab = createEl('button', 'assistant-fab', 'AI 助教');
    this.fab.type = 'button';
    this.fab.setAttribute('data-assistant-fab', '');
    this.fab.setAttribute('aria-label', '打开或收起 AI 助教侧栏');
    this.fab.setAttribute('aria-expanded', 'false');
    this.fab.title = 'AI 助教：接线审查 / 载入题目 / 真值表打分';
    this.container.appendChild(this.fab);

    // —— 抽屉本体 ——
    this.drawer = createEl('div', 'assistant-drawer');
    this.drawer.setAttribute('data-assistant-drawer', '');
    this.drawer.setAttribute('role', 'complementary');
    this.drawer.setAttribute('aria-label', 'AI 助教面板');
    this.drawer.setAttribute('aria-hidden', 'true');

    // 标题栏
    var head = createEl('div', 'assistant-head');
    var titleBox = createEl('div', 'assistant-title-box');
    titleBox.appendChild(createEl('span', 'assistant-title', 'AI 助教'));
    titleBox.appendChild(createEl('span', 'assistant-sub', '接线审查 · 真值表打分'));
    head.appendChild(titleBox);

    this.closeBtn = createEl('button', 'assistant-close', '×');
    this.closeBtn.type = 'button';
    this.closeBtn.setAttribute('data-act', 'close');
    this.closeBtn.setAttribute('aria-label', '收起 AI 助教侧栏');
    this.closeBtn.title = '收起侧栏（Esc）';
    head.appendChild(this.closeBtn);
    this.drawer.appendChild(head);

    // 三个动作按钮
    var actions = createEl('div', 'assistant-actions');
    this.reviewBtn = createEl('button', 'assistant-btn', '审查电路');
    this.reviewBtn.type = 'button';
    this.reviewBtn.setAttribute('data-act', 'review');
    this.reviewBtn.title = '检查供电、悬空、短路与输出冲突';

    this.quizBtn = createEl('button', 'assistant-btn', '载入题目');
    this.quizBtn.type = 'button';
    this.quizBtn.setAttribute('data-act', 'quiz');
    this.quizBtn.title = '载入带题面的 .dlab.json 工程文件';

    this.gradeBtn = createEl('button', 'assistant-btn', '打分');
    this.gradeBtn.type = 'button';
    this.gradeBtn.setAttribute('data-act', 'grade');
    this.gradeBtn.title = '按当前题面的真值表静默打分';

    this.fileInput = createEl('input', 'assistant-file');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.json,.dlab.json,application/json';
    this.fileInput.setAttribute('aria-hidden', 'true');
    this.fileInput.tabIndex = -1;

    actions.appendChild(this.reviewBtn);
    actions.appendChild(this.quizBtn);
    actions.appendChild(this.gradeBtn);
    actions.appendChild(this.fileInput);
    this.drawer.appendChild(actions);

    // 主体：问题列表 → 题目信息 → 打分结果
    var body = createEl('div', 'assistant-body');
    this.bodyEl = body;

    // 1) 问题列表
    var issueSection = createEl('section', 'assistant-section assistant-section-issues');
    var issueHead = createEl('h3', 'assistant-section-title');
    issueHead.appendChild(createEl('span', null, '问题列表'));
    this.summaryEl = createEl('span', 'assistant-summary', '');
    issueHead.appendChild(this.summaryEl);
    issueSection.appendChild(issueHead);
    this.issueBox = createEl('div', 'assistant-issues');
    this.issueBox.setAttribute('data-issues', '');
    issueSection.appendChild(this.issueBox);
    body.appendChild(issueSection);

    // 2) 题目信息
    var taskSection = createEl('section', 'assistant-section assistant-section-task');
    taskSection.appendChild(createEl('h3', 'assistant-section-title', '题目信息'));
    this.taskBox = createEl('div', 'assistant-task');
    this.taskBox.setAttribute('data-task', '');
    taskSection.appendChild(this.taskBox);
    body.appendChild(taskSection);

    // 3) 打分结果
    var gradeSection = createEl('section', 'assistant-section assistant-section-grade');
    gradeSection.appendChild(createEl('h3', 'assistant-section-title', '打分结果'));
    this.gradeBox = createEl('div', 'assistant-grade');
    this.gradeBox.setAttribute('data-grade', '');
    gradeSection.appendChild(this.gradeBox);
    body.appendChild(gradeSection);

    this.drawer.appendChild(body);

    // 底部状态行（hud 缺失时的兜底提示位）
    var foot = createEl('div', 'assistant-foot');
    this.statusEl = createEl('span', 'assistant-status is-info', '就绪');
    this.statusEl.setAttribute('data-status', '');
    foot.appendChild(this.statusEl);
    this.drawer.appendChild(foot);

    this.container.appendChild(this.drawer);
    this.built = true;
  };

  /** 绑定事件（只绑一次） */
  AdvisorPanel.prototype._bind = function () {
    if (this.bound || !this.built) {
      return;
    }
    var self = this;

    /** 记录监听器，destroy 时统一解绑 */
    function on(target, type, handler, options) {
      if (!target || typeof target.addEventListener !== 'function') {
        return;
      }
      target.addEventListener(type, handler, options);
      self._listeners.push({ target: target, type: type, handler: handler, options: options });
    }

    // 悬浮开关
    on(this.fab, 'click', function () {
      self.toggle();
    });
    on(this.fab, 'keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        self.toggle();
      }
    });

    // 抽屉内点击：动作按钮 / 关闭 / 问题条目（事件委托）
    on(this.drawer, 'click', function (e) {
      var target = e.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      var issueNode = target.closest('[data-issue]');
      if (issueNode) {
        self._onIssueClick(issueNode.getAttribute('data-issue'));
        return;
      }
      var actNode = target.closest('[data-act]');
      if (!actNode) {
        return;
      }
      var act = actNode.getAttribute('data-act');
      if (act === 'close') {
        self.close();
      } else if (act === 'review') {
        self.runReview();
      } else if (act === 'quiz') {
        if (self.fileInput && typeof self.fileInput.click === 'function') {
          self.fileInput.click();
        }
      } else if (act === 'grade') {
        self.runGrade();
      }
    });

    // 问题条目键盘可达（Enter / 空格 = 点击）
    on(this.issueBox, 'keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') {
        return;
      }
      var target = e.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      var issueNode = target.closest('[data-issue]');
      if (!issueNode) {
        return;
      }
      e.preventDefault();
      self._onIssueClick(issueNode.getAttribute('data-issue'));
    });

    // 选择题目文件
    on(this.fileInput, 'change', function () {
      var file = self.fileInput.files && self.fileInput.files[0];
      if (file) {
        self.loadQuizFile(file);
      }
      // 允许连续选择同一个文件
      try {
        self.fileInput.value = '';
      } catch (err) {
        // 某些环境不允许清空，忽略
      }
    });

    // Esc 收起侧栏
    on(global.document, 'keydown', function (e) {
      if (e.key === 'Escape' && self.isOpen) {
        self.close();
      }
    });

    // 窗口尺寸变化：重新贴住舞台
    on(global, 'resize', function () {
      self._syncGeometry();
    });

    // 导入工程后清掉过期的审查结果（电路已经换了）
    on(global.document, 'dlab:project-imported', function () {
      if (self.report) {
        self.report = null;
        self._reviewState = 'idle';
        self._renderIssues();
        self._renderSummary();
        self.clearHighlight();
      }
    });

    this.bound = true;
  };

  /** 让侧栏贴住 #stage 的可见区域（避开工具栏、时序条与右下角缩放控件） */
  AdvisorPanel.prototype._syncGeometry = function () {
    if (!this.container || !this.built) {
      return;
    }
    var doc = global.document;
    var stage = doc.getElementById ? doc.getElementById('stage') : null;
    if (!stage || typeof stage.getBoundingClientRect !== 'function') {
      return;
    }
    var rect = stage.getBoundingClientRect();
    if (!rect || !rect.height) {
      return;
    }
    var top = Math.round(rect.top + STAGE_TOP_GAP);
    var height = Math.round(rect.height - STAGE_TOP_GAP * 2 - STAGE_BOTTOM_RESERVE);
    if (height < MIN_HEIGHT) {
      height = Math.max(MIN_HEIGHT, Math.round(rect.height - STAGE_TOP_GAP * 2));
    }
    this.container.style.top = top + 'px';
    this.container.style.height = height + 'px';
    this.container.style.bottom = 'auto';
  };

  /* ---------- 开关 ---------- */

  /** 展开侧栏 */
  AdvisorPanel.prototype.open = function () {
    if (this.destroyed) {
      return false;
    }
    this._ensure();
    this.isOpen = true;
    if (this.container) {
      this.container.classList.add('is-open');
    }
    if (this.drawer) {
      this.drawer.setAttribute('aria-hidden', 'false');
    }
    if (this.fab) {
      this.fab.setAttribute('aria-expanded', 'true');
      this.fab.classList.add('is-open');
    }
    this._syncGeometry();
    return true;
  };

  /** 收起侧栏 */
  AdvisorPanel.prototype.close = function () {
    if (this.destroyed) {
      return false;
    }
    this.isOpen = false;
    if (this.container) {
      this.container.classList.remove('is-open');
    }
    if (this.drawer) {
      this.drawer.setAttribute('aria-hidden', 'true');
    }
    if (this.fab) {
      this.fab.setAttribute('aria-expanded', 'false');
      this.fab.classList.remove('is-open');
    }
    this.clearHighlight();
    return true;
  };

  /** 切换开合，返回切换后的状态 */
  AdvisorPanel.prototype.toggle = function () {
    return this.isOpen ? (this.close(), false) : (this.open(), true);
  };

  /** 启动：构建 DOM + 绑定事件 + 初始渲染（app.js 装配时调用） */
  AdvisorPanel.prototype.start = function () {
    if (this.destroyed) {
      return false;
    }
    if (!this._ensure()) {
      return false;
    }
    this.started = true;
    this.close();
    this._renderIssues();
    this._renderSummary();
    this._renderTask();
    this._renderGrade(null);
    return true;
  };

  /* ---------- 审查 ---------- */

  /**
   * 审查当前电路并渲染。
   * @returns {Object|null} 归一化后的 report；Advisor 缺失或抛错时返回 null（已降级提示）
   */
  AdvisorPanel.prototype.runReview = function () {
    if (this.destroyed) {
      return null;
    }
    this._ensure();

    var Advisor = DLab.Advisor;
    if (!Advisor || typeof Advisor.review !== 'function') {
      this.report = null;
      this._reviewState = 'missing';
      this._reviewNotice = EMPTY_NO_ADVISOR;
      this._renderIssues();
      this._renderSummary();
      this._setStatus('AI 审查模块不可用：src/core/advisor.js 未加载', 'warn');
      return null;
    }
    if (!this.engine) {
      this.report = null;
      this._reviewState = 'missing';
      this._reviewNotice = '仿真引擎不可用，无法审查';
      this._renderIssues();
      this._renderSummary();
      this._setStatus('仿真引擎不可用，无法审查', 'warn');
      return null;
    }

    var raw = null;
    try {
      raw = Advisor.review(this.engine, {});
    } catch (err) {
      this.report = null;
      this._reviewState = 'missing';
      this._reviewNotice = '审查失败：' + msgOf(err);
      this._renderIssues();
      this._renderSummary();
      this._setStatus('审查失败：' + msgOf(err), 'error');
      return null;
    }

    var report = normalizeReport(raw);
    if (!report) {
      this.report = null;
      this._reviewState = 'missing';
      this._reviewNotice = '审查结果格式异常（未返回 report 对象）';
      this._renderIssues();
      this._renderSummary();
      this._setStatus('审查结果格式异常，已降级显示', 'warn');
      return null;
    }

    this.report = report;
    this._reviewState = 'done';
    this._reviewNotice = '';
    this.renderReport(report);

    var text;
    if (report.summary.error > 0) {
      text = '审查完成：发现 ' + report.issues.length + ' 个问题（错误 ' + report.summary.error +
        ' / 警告 ' + report.summary.warn + ' / 提示 ' + report.summary.info + '）';
    } else if (report.issues.length) {
      text = '审查完成：未发现错误，有 ' + report.issues.length + ' 条提示';
    } else {
      text = '审查完成：未发现问题';
    }
    this._setStatus(text, report.summary.error > 0 ? 'error' : (report.issues.length ? 'warn' : 'info'));
    return report;
  };

  /**
   * 渲染一份审查报告（可直接传 ai-core 的原始 report）。
   * @returns {boolean} 是否渲染出了问题条目
   */
  AdvisorPanel.prototype.renderReport = function (report) {
    if (this.destroyed) {
      return false;
    }
    this._ensure();
    var normalized = normalizeReport(report);
    if (!normalized) {
      this.report = null;
      this._reviewState = 'idle';
      this._reviewNotice = '';
      this._renderIssues();
      this._renderSummary();
      return false;
    }
    this.report = normalized;
    this._reviewState = 'done';
    this._reviewNotice = '';
    this.clearHighlight();
    this._renderIssues();
    this._renderSummary();
    return normalized.issues.length > 0;
  };

  /** 渲染问题列表（含三种空状态） */
  AdvisorPanel.prototype._renderIssues = function () {
    if (!this.issueBox) {
      return false;
    }
    this.issueBox.textContent = '';
    this._issueNodes = Object.create(null);

    if (this._reviewState === 'missing') {
      this._appendEmpty(this.issueBox, this._reviewNotice || EMPTY_NO_ADVISOR);
      return false;
    }
    if (!this.report) {
      this._appendEmpty(this.issueBox, EMPTY_IDLE);
      return false;
    }
    if (!this.report.issues.length) {
      this._appendEmpty(this.issueBox, EMPTY_OK);
      return false;
    }
    var frag = global.document.createDocumentFragment();
    for (var i = 0; i < this.report.issues.length; i++) {
      frag.appendChild(this._buildIssueNode(this.report.issues[i]));
    }
    this.issueBox.appendChild(frag);
    return true;
  };

  /** 空状态占位 */
  AdvisorPanel.prototype._appendEmpty = function (parent, text) {
    var empty = createEl('p', 'assistant-empty', text);
    empty.setAttribute('data-empty', '');
    parent.appendChild(empty);
  };

  /** 单条问题的 DOM */
  AdvisorPanel.prototype._buildIssueNode = function (issue) {
    var node = createEl('div', 'assistant-issue is-' + issue.level);
    node.setAttribute('data-issue', issue.id);
    node.setAttribute('data-level', issue.level);
    node.setAttribute('data-code', issue.code);
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-label', (LEVEL_TEXT[issue.level] || '提示') + '：' + issue.title);

    var head = createEl('div', 'assistant-issue-head');
    head.appendChild(createEl('span', 'assistant-issue-level', LEVEL_TEXT[issue.level] || '提示'));
    head.appendChild(createEl('span', 'assistant-issue-title', issue.title));
    node.appendChild(head);

    if (issue.detail) {
      node.appendChild(createEl('div', 'assistant-issue-detail', issue.detail));
    }
    if (issue.hint) {
      node.appendChild(createEl('div', 'assistant-issue-hint', '建议：' + issue.hint));
    }
    if (issue.jacks.length) {
      var shown = issue.jacks.slice(0, 4).join('、');
      var suffix = issue.jacks.length > 4 ? ' 等 ' + issue.jacks.length + ' 个' : '';
      node.appendChild(createEl('div', 'assistant-issue-jacks', '相关插孔：' + shown + suffix));
    }
    this._issueNodes[issue.id] = node;
    return node;
  };

  /** 渲染级别汇总（错误 x · 警告 y · 提示 z） */
  AdvisorPanel.prototype._renderSummary = function () {
    if (!this.summaryEl) {
      return;
    }
    var report = this.report;
    if (!report) {
      this.summaryEl.textContent = '';
      this.summaryEl.className = 'assistant-summary';
      return;
    }
    var s = report.summary;
    this.summaryEl.textContent = '错误 ' + s.error + ' · 警告 ' + s.warn + ' · 提示 ' + s.info;
    this.summaryEl.className = 'assistant-summary' +
      (s.error ? ' is-error' : (s.warn ? ' is-warn' : (report.issues.length ? ' is-info' : ' is-ok')));
  };

  /** 点击某条问题：高亮 / 再点一次取消 */
  AdvisorPanel.prototype._onIssueClick = function (issueId) {
    var id = issueId === undefined || issueId === null ? null : String(issueId);
    if (!id) {
      return false;
    }
    if (this.highlighted === id) {
      this.clearHighlight();
      this._setStatus('已取消高亮', 'info');
      return true;
    }
    return this.highlightIssue(id);
  };

  /**
   * 高亮某条问题关联的插孔。
   * 插孔高亮走 wireLayer.setJackAlert（特性检测），缺失时降级为文字说明。
   * @returns {boolean} 是否定位到了这条问题
   */
  AdvisorPanel.prototype.highlightIssue = function (issueId) {
    if (this.destroyed) {
      return false;
    }
    this._ensure();
    var id = issueId === undefined || issueId === null ? null : String(issueId);
    if (!id || !this.report) {
      return false;
    }
    var issue = null;
    for (var i = 0; i < this.report.issues.length; i++) {
      if (this.report.issues[i].id === id) {
        issue = this.report.issues[i];
        break;
      }
    }
    if (!issue) {
      return false;
    }

    this.highlighted = id;
    this._markIssueActive(id);

    var jacks = issue.jacks.slice();
    var applied = this._applyJackAlert(jacks);

    var text;
    var level;
    if (!jacks.length) {
      text = '该问题没有关联插孔：' + issue.title;
      level = 'info';
    } else if (applied) {
      text = '已高亮 ' + jacks.length + ' 个相关插孔：' + jacks.slice(0, 4).join('、');
      level = 'info';
    } else {
      text = '相关插孔（插孔高亮不可用）：' + jacks.slice(0, 4).join('、');
      level = 'warn';
    }
    this._setStatus(text, level);
    return true;
  };

  /** 清除插孔高亮 */
  AdvisorPanel.prototype.clearHighlight = function () {
    this.highlighted = null;
    this._markIssueActive(null);
    this._applyJackAlert(null);
    return true;
  };

  /** 切换问题条目的选中态 */
  AdvisorPanel.prototype._markIssueActive = function (issueId) {
    for (var key in this._issueNodes) {
      if (!Object.prototype.hasOwnProperty.call(this._issueNodes, key)) {
        continue;
      }
      var node = this._issueNodes[key];
      var active = issueId !== null && key === issueId;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  };

  /**
   * 调 wireLayer.setJackAlert 给插孔打高亮。
   * @param {string[]|null} jackIds null 表示清除
   * @returns {boolean} 是否真的执行了（false = 该能力不可用，已降级）
   */
  AdvisorPanel.prototype._applyJackAlert = function (jackIds) {
    var wl = this.wireLayer;
    if (!wl || typeof wl.setJackAlert !== 'function') {
      this._alertSupported = false;
      return false;
    }
    try {
      wl.setJackAlert(jackIds && jackIds.length ? jackIds : null);
      this._alertSupported = true;
      return true;
    } catch (err) {
      this._alertSupported = false;
      return false;
    }
  };

  /* ---------- 题目 ---------- */

  /**
   * 载入题目文件：Quiz.readTask 抽题面 → Persistence.importProject 导入电路 → 记录 task。
   * Quiz 缺失/仍是桩时，本地兜底从工程对象的 task 字段解析（契约 §5.3 的 project.task）。
   * @param {File|Blob|string|Object} file
   * @returns {Promise<{ok:boolean, task:Object|null, message:string}>}
   */
  AdvisorPanel.prototype.loadQuizFile = function (file) {
    if (this.destroyed) {
      return Promise.resolve({ ok: false, task: null, message: '侧栏已销毁' });
    }
    this._ensure();
    var self = this;
    return readText(file).then(function (text) {
      return self._loadQuizText(text);
    }).catch(function (err) {
      return self._quizFail('载入题目失败：' + msgOf(err));
    });
  };

  /** 载入失败：统一提示 + 返回结构 */
  AdvisorPanel.prototype._quizFail = function (message) {
    this._setStatus(message, 'error');
    this._renderTask();
    return { ok: false, task: null, message: message };
  };

  /** 从文本里载入题目（内部实现，返回 Promise） */
  AdvisorPanel.prototype._loadQuizText = function (text) {
    var self = this;
    var raw = null;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      raw = null;
    }

    /** 拿到题面后：先导入工程，再记录 task */
    function finish(task, via) {
      return self._importProjectText(text).then(function (imp) {
        if (!imp || !imp.ok) {
          return self._quizFail(imp && imp.message ? imp.message : '载入题目失败：工程导入失败');
        }
        self.setTask(task);
        var message = '已载入题目：' + task.title + (imp.message ? '（' + imp.message + '）' : '');
        self._setStatus(message, 'info');
        return { ok: true, task: task, message: message, via: via || 'quiz' };
      });
    }

    /** 本地兜底：直接从 JSON 的 task 字段抽题面 */
    function localTask() {
      if (!raw || typeof raw !== 'object') {
        return null;
      }
      return normalizeTask(raw.task);
    }

    var Quiz = DLab.Quiz;
    if (!Quiz || typeof Quiz.readTask !== 'function') {
      var localOnly = localTask();
      if (localOnly) {
        return finish(localOnly, 'local');
      }
      return Promise.resolve(this._quizFail(
        raw ? '载入题目失败：文件里没有找到题面（task）字段' : '载入题目失败：不是合法的 JSON 文件'
      ));
    }

    var res;
    try {
      res = Quiz.readTask(text);
    } catch (err) {
      res = null;
    }
    return Promise.resolve(res).then(function (r) {
      if (r && r.ok && r.task) {
        var task = normalizeTask(r.task);
        if (task) {
          return finish(task, 'quiz');
        }
      }
      // Quiz 返回失败或仍是桩：退到本地解析（ai-core 未完成时也不白屏）
      var local = localTask();
      if (local) {
        return finish(local, 'local');
      }
      var reason = r && typeof r.message === 'string' && r.message ? r.message : '';
      return self._quizFail(
        raw
          ? ('载入题目失败：' + (reason || '文件里没有找到题面（task）字段'))
          : ('载入题目失败：' + (reason || '不是合法的 JSON 文件'))
      );
    }, function (err) {
      var localErr = localTask();
      if (localErr) {
        return finish(localErr, 'local');
      }
      return self._quizFail('载入题目失败：出题模块读取异常（' + msgOf(err) + '）');
    });
  };

  /** 导入工程文本（Persistence 缺失时降级为「只载入题面」） */
  AdvisorPanel.prototype._importProjectText = function (text) {
    var self = this;
    var P = DLab.Persistence;
    if (!P || typeof P.importProject !== 'function') {
      return Promise.resolve({ ok: true, message: '导入模块不可用，仅载入题面' });
    }
    if (!this.engine) {
      return Promise.resolve({ ok: true, message: '引擎不可用，仅载入题面' });
    }
    var ret;
    try {
      ret = P.importProject(text, this.engine);
    } catch (err) {
      return Promise.resolve({ ok: false, message: '导入失败：' + msgOf(err) });
    }
    return Promise.resolve(ret).then(function (r) {
      if (!r || typeof r !== 'object') {
        return { ok: false, message: '导入失败：导入模块返回异常' };
      }
      if (r.ok) {
        self._refreshCircuit();
      }
      return r;
    }, function (err) {
      return { ok: false, message: '导入失败：' + msgOf(err) };
    });
  };

  /** 直接设置当前题面（loadQuizFile 内部用，也便于测试与教师脚本） */
  AdvisorPanel.prototype.setTask = function (task) {
    this._ensure();
    this.task = normalizeTask(task);
    this.grade = null;
    this._renderTask();
    this._renderGrade(null);
    return this.task;
  };

  /** 渲染题目信息区 */
  AdvisorPanel.prototype._renderTask = function () {
    if (!this.taskBox) {
      return false;
    }
    this.taskBox.textContent = '';
    var task = this.task;
    if (!task) {
      this._appendEmpty(this.taskBox, EMPTY_NO_TASK);
      return false;
    }
    var head = createEl('div', 'assistant-task-head');
    head.appendChild(createEl('span', 'assistant-task-title', task.title));
    if (task.id) {
      head.appendChild(createEl('span', 'assistant-task-id', task.id));
    }
    this.taskBox.appendChild(head);

    if (task.description) {
      this.taskBox.appendChild(createEl('p', 'assistant-task-desc', task.description));
    }
    var meta = createEl('div', 'assistant-task-meta');
    meta.appendChild(createEl('span', 'assistant-task-chip', '输入 ' + (task.inputs.length || 0) + ' 个'));
    meta.appendChild(createEl('span', 'assistant-task-chip', '输出 ' + (task.outputs.length || 0) + ' 个'));
    meta.appendChild(createEl('span', 'assistant-task-chip', '真值表 ' + (task.rows.length || 0) + ' 行'));
    this.taskBox.appendChild(meta);

    if (task.inputs.length || task.outputs.length) {
      var io = createEl('div', 'assistant-task-io');
      if (task.inputs.length) {
        io.appendChild(createEl('div', 'assistant-task-io-line', '输入：' + task.inputs.join('、')));
      }
      if (task.outputs.length) {
        io.appendChild(createEl('div', 'assistant-task-io-line', '输出：' + task.outputs.join('、')));
      }
      this.taskBox.appendChild(io);
    }
    return true;
  };

  /* ---------- 打分 ---------- */

  /**
   * 按当前题面静默打分并渲染。
   * @returns {Object|null|Promise} 归一化后的打分结果；无题面或 Grader 缺失时返回 null（已提示）
   */
  AdvisorPanel.prototype.runGrade = function () {
    if (this.destroyed) {
      return null;
    }
    this._ensure();
    if (!this.task) {
      this._renderGradeNotice(EMPTY_NO_TASK);
      this._setStatus('还没有载入题目，无法打分', 'warn');
      return null;
    }
    var Grader = DLab.Grader;
    if (!Grader || typeof Grader.grade !== 'function') {
      this._renderGradeNotice(EMPTY_NO_GRADER);
      this._setStatus('打分模块不可用：src/core/grader.js 未加载', 'warn');
      return null;
    }
    if (!this.engine) {
      this._renderGradeNotice('仿真引擎不可用，无法打分');
      this._setStatus('仿真引擎不可用，无法打分', 'warn');
      return null;
    }

    var raw = null;
    try {
      raw = Grader.grade(this.engine, this.task, { timeMs: 1000, restore: true });
    } catch (err) {
      this._renderGradeNotice('打分失败：' + msgOf(err));
      this._setStatus('打分失败：' + msgOf(err), 'error');
      return null;
    }

    var self = this;
    if (raw && typeof raw.then === 'function') {
      // 兼容 ai-core 若把 grade 写成异步的情况
      return Promise.resolve(raw).then(function (r) {
        return self._finishGrade(r);
      }, function (err) {
        self._renderGradeNotice('打分失败：' + msgOf(err));
        self._setStatus('打分失败：' + msgOf(err), 'error');
        return null;
      });
    }
    return this._finishGrade(raw);
  };

  /** 收尾：归一化 + 渲染 + 状态提示 */
  AdvisorPanel.prototype._finishGrade = function (raw) {
    var grade = normalizeGrade(raw, this.task);
    this.grade = grade;
    this._renderGrade(grade);
    this._refreshCircuit();

    var text = grade.message;
    if (!text) {
      text = grade.ok
        ? '打分完成：' + grade.passed + '/' + grade.total + ' 行通过'
        : '打分完成：' + grade.passed + '/' + grade.total + ' 行通过，' + grade.failed + ' 行未通过';
    }
    this._setStatus(text, grade.ok ? 'info' : 'warn');
    return grade;
  };

  /** 渲染打分结果 */
  AdvisorPanel.prototype._renderGrade = function (grade) {
    if (!this.gradeBox) {
      return false;
    }
    this.gradeBox.textContent = '';
    if (!grade) {
      this._appendEmpty(this.gradeBox, EMPTY_NO_GRADE);
      return false;
    }
    var score = createEl('div', 'assistant-score' + (grade.ok ? ' is-ok' : (grade.total ? ' is-bad' : '')));
    score.appendChild(createEl('span', 'assistant-score-num', grade.passed + '/' + grade.total));
    var label;
    if (!grade.total) {
      label = '题面没有真值表行';
    } else if (grade.ok) {
      label = '全部通过';
    } else {
      label = '未通过 ' + grade.failed + ' 行';
    }
    score.appendChild(createEl('span', 'assistant-score-text', label));
    this.gradeBox.appendChild(score);

    if (grade.rows.length) {
      var list = createEl('div', 'assistant-rows');
      for (var i = 0; i < grade.rows.length; i++) {
        var row = grade.rows[i];
        var item = createEl('div', 'assistant-row' + (row.pass ? ' is-pass' : ' is-fail'));
        item.appendChild(createEl('span', 'assistant-row-index', '#' + (i + 1)));
        item.appendChild(createEl('span', 'assistant-row-in', '输入 ' + joinNums(row.in)));
        item.appendChild(createEl('span', 'assistant-row-expect', '期望 ' + joinNums(row.expected)));
        item.appendChild(createEl('span', 'assistant-row-actual', '实测 ' + joinNums(row.actual)));
        item.appendChild(createEl('span', 'assistant-row-mark', row.pass ? '✓' : '✗'));
        list.appendChild(item);
      }
      this.gradeBox.appendChild(list);
    }
    return true;
  };

  /** 打分区的纯提示状态 */
  AdvisorPanel.prototype._renderGradeNotice = function (text) {
    if (!this.gradeBox) {
      return false;
    }
    this.gradeBox.textContent = '';
    this._appendEmpty(this.gradeBox, text || EMPTY_NO_GRADE);
    return true;
  };

  /* ---------- 状态与刷新 ---------- */

  /** 统一状态出口：优先给 hud，其次写侧栏底部状态行 */
  AdvisorPanel.prototype._setStatus = function (text, level) {
    var lv = level === 'warn' || level === 'error' ? level : 'info';
    if (this.statusEl) {
      this.statusEl.textContent = text ? String(text) : '';
      this.statusEl.className = 'assistant-status is-' + lv;
    }
    if (this.hud && typeof this.hud.setStatus === 'function') {
      try {
        this.hud.setStatus(text ? String(text) : '', lv);
      } catch (err) {
        // hud 内部异常不影响侧栏
      }
    }
  };

  /** 导入题目/打分后刷新面板与飞线（引擎状态可能已变） */
  AdvisorPanel.prototype._refreshCircuit = function () {
    var engine = this.engine;
    try {
      if (this.wireLayer && typeof this.wireLayer.render === 'function' && engine && typeof engine.getWires === 'function') {
        this.wireLayer.render(engine.getWires());
      }
    } catch (err) {
      // 渲染失败不影响业务结果
    }
    try {
      if (this.onState && engine && typeof engine.getState === 'function') {
        this.onState(engine.getState());
      }
    } catch (err) {
      // 同上
    }
  };

  /* ---------- 快照与销毁 ---------- */

  /** 当前状态快照（便于自动化测试） */
  AdvisorPanel.prototype.getSnapshot = function () {
    return {
      open: this.isOpen,
      report: this.report,
      task: this.task,
      grade: this.grade,
      highlighted: this.highlighted,
      // 额外字段（便于回归断言，不属于契约必填项）
      issueCount: this.report ? this.report.issues.length : 0,
      reviewState: this._reviewState,
      alertsSupported: this._alertSupported,
      destroyed: this.destroyed
    };
  };

  /** 销毁：解绑事件、清高亮、移除 DOM */
  AdvisorPanel.prototype.destroy = function () {
    if (this.destroyed) {
      return false;
    }
    this.clearHighlight();
    for (var i = 0; i < this._listeners.length; i++) {
      var rec = this._listeners[i];
      try {
        if (rec.target && typeof rec.target.removeEventListener === 'function') {
          rec.target.removeEventListener(rec.type, rec.handler, rec.options);
        }
      } catch (err) {
        // 忽略解绑异常
      }
    }
    this._listeners = [];

    if (this.container) {
      this.container.textContent = '';
      this.container.classList.remove('is-open');
      if (this._createdContainer && this.container.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }
    }
    this.report = null;
    this.task = null;
    this.grade = null;
    this.highlighted = null;
    this.isOpen = false;
    this.destroyed = true;
    this.started = false;
    return true;
  };

  AdvisorPanel.PANEL_WIDTH = PANEL_WIDTH;
  AdvisorPanel.LEVEL_ORDER = LEVEL_ORDER;
  AdvisorPanel.LEVEL_TEXT = LEVEL_TEXT;
  AdvisorPanel.EMPTY_IDLE = EMPTY_IDLE;
  AdvisorPanel.EMPTY_OK = EMPTY_OK;
  AdvisorPanel.EMPTY_NO_TASK = EMPTY_NO_TASK;

  DLab.AdvisorPanel = AdvisorPanel;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// src/ui/interaction.js
// 接线状态机：点击插孔成线、拖拽预览、右键/Delete 删除、Ctrl+Z 撤销 / Ctrl+Y 重做、悬停高亮。
// 同时驱动 requestAnimationFrame 循环推进 engine.step()，只在数据变化时重绘。
(function (global) {
  'use strict';
  var DLab = (global.DLab = global.DLab || {});

  var DEFAULT_COLOR = '#ef4444';
  var MAX_UNDO = 200;

  /** 取插孔的展示名（丝印 + 模块），未知时回落 id */
  function jackLabel(geometry, jackId) {
    var jacks = (geometry && geometry.JACKS) || {};
    var jack = jacks[jackId];
    if (!jack) {
      return String(jackId);
    }
    var label = jack.label || jackId;
    if (jack.moduleId) {
      return jack.moduleId + ':' + label;
    }
    return String(label);
  }

  /** 事件目标向上找带某属性的祖先（SVG 的 closest 兼容写法） */
  function findAncestor(node, attr) {
    var cur = node;
    while (cur && cur !== document) {
      if (cur.getAttribute && cur.getAttribute(attr) !== null) {
        return cur;
      }
      cur = cur.parentNode;
    }
    return null;
  }

  /** 焦点是否在输入类控件里（避免 Delete/Ctrl+Z 抢输入框） */
  function isEditableTarget(node) {
    if (!node || !node.tagName) {
      return false;
    }
    var tag = String(node.tagName).toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
  }

  // —— Interaction ——
  /**
   * @param {{engine:Object, wireLayer:Object, hud:Object, geometry:Object}} opts
   */
  function Interaction(opts) {
    opts = opts || {};
    this.engine = opts.engine;
    this.wireLayer = opts.wireLayer;
    this.hud = opts.hud || null;
    this.geometry = opts.geometry || (DLab.geometry || { JACKS: {} });
    if (!this.engine) {
      throw new Error('Interaction：缺少 engine');
    }
    if (!this.wireLayer) {
      throw new Error('Interaction：缺少 wireLayer');
    }

    this.currentColor = DEFAULT_COLOR;
    this.selectedJack = null;      // 连线起点
    this.selectedWire = null;      // 当前选中的导线
    this.undoStack = [];
    this.redoStack = [];           // 撤销后又被「重做」回来的操作栈（Ctrl+Y）
    this.wireSeq = 0;
    this.started = false;
    this.wiresVisible = true;
    this.lastPointer = null;       // 最近一次鼠标位置（屏幕坐标）
    this.pointerMoved = false;
    this._rafId = 0;
    this._lastWireSig = null;
    this._lastShortsSig = null;
    this._lastWarnSig = null;
    this._lastState = null;
    this._lastStateRef = null;   // H9：上一帧状态对象引用（引擎每次 step 都新建对象，引用相同 ⇒ 内容相同）
    this._engineErrorShown = false;
    this._bound = [];
    this._handlers = null;

    // 供外部（Lead 的 app.js）订阅电平变化，用于刷新 LED/数码管
    this.onState = typeof opts.onState === 'function' ? opts.onState : null;
    // H8：返回「当前接管引擎推进的所有者」（如 Timeline）时，本模块的 rAF 循环
    // 不再每帧 engine.step —— 所有者已把状态推进到同一虚拟时刻，重复 step 是
    // 一次完整幂等重算（纯浪费）。接线 / 撤销后的显式重算改由 refresh() 承担。
    this._getTimeOwner = typeof opts.getTimeOwner === 'function' ? opts.getTimeOwner : null;
    if (this.wireLayer.setPreviewColor) {
      this.wireLayer.setPreviewColor(this.currentColor);
    }
  }

  // —— 事件绑定 ——
  Interaction.prototype._on = function (target, type, fn, options) {
    target.addEventListener(type, fn, options || false);
    this._bound.push({ target: target, type: type, fn: fn, options: options || false });
  };

  Interaction.prototype._bind = function () {
    var self = this;
    var svg = this.wireLayer.svg;
    var doc = document;

    // 点击：插孔接线 / 导线选中 / 空白处取消
    this._on(svg, 'click', function (e) {
      self._handleClick(e);
    });

    // 右键导线删除
    this._on(svg, 'contextmenu', function (e) {
      e.preventDefault();
      var wireEl = findAncestor(e.target, 'data-wire');
      if (wireEl) {
        self.removeWire(wireEl.getAttribute('data-wire'), '右键删除');
        return;
      }
      // 兜底：指针落在插孔命中圆附近时，仍按“只找导线”再试一次
      var hit = self.wireLayer.hitTest(e.clientX, e.clientY, { ignoreJacks: true });
      if (hit && hit.type === 'wire') {
        self.removeWire(hit.wireId, '右键删除');
      }
    });

    // 鼠标移动：更新悬停与预览曲线（真正的命中测试在 rAF 里做）
    this._on(global, 'mousemove', function (e) {
      self.lastPointer = { clientX: e.clientX, clientY: e.clientY };
      self.pointerMoved = true;
    }, { passive: true });

    // 点击面板空白处（#panel 内、但没点到孔/线）取消当前操作
    this._on(doc, 'click', function (e) {
      var svg = self.wireLayer.svg;
      var panel = svg.parentNode;
      if (!panel || !panel.contains || !panel.contains(e.target)) {
        return;
      }
      if (e.target === svg || e.target === panel || (e.target.id === 'wire-layer')) {
        self.cancelSelection();
        self.selectWire(null);
      }
    });

    // 键盘：Esc 取消、Delete 删除选中线、Ctrl+Z 撤销
    this._on(doc, 'keydown', function (e) {
      if (isEditableTarget(e.target)) {
        return;
      }
      var key = e.key || '';
      if (key === 'Escape') {
        if (self.selectedJack || self.selectedWire) {
          e.preventDefault();
          self.cancelSelection();
          self.selectWire(null);
          self._status('已取消当前操作', 'info');
        }
        return;
      }
      if (key === 'Delete' || key === 'Backspace') {
        if (self.selectedWire) {
          e.preventDefault();
          self.removeWire(self.selectedWire, '删除');
        }
        return;
      }
      // 撤销 / 重做：Ctrl+Z 撤销，Ctrl+Y 或 Ctrl+Shift+Z 重做（两套快捷键都支持，
      // 因为 Windows 用户习惯 Ctrl+Y、macOS 与多数编辑器习惯 Ctrl+Shift+Z）
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        var lower = String(key).toLowerCase();
        if (lower === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            self.redo();
          } else {
            self.undo();
          }
        } else if (lower === 'y') {
          e.preventDefault();
          self.redo();
        }
      }
    });

    // 导入完成后由 Persistence 广播，这里刷新并清空撤销/重做栈
    // （导入是一次「换现场」，旧的撤销记录在新现场上没有意义，留着会撤出错误状态）
    this._on(doc, 'dlab:project-imported', function () {
      self.undoStack.length = 0;
      self.redoStack.length = 0;
      self.cancelSelection();
      self.selectWire(null);
      self.refresh(true);
    });
  };

  /** 点击分发：先判导线，再判插孔 */
  Interaction.prototype._handleClick = function (e) {
    var wireEl = findAncestor(e.target, 'data-wire');
    if (wireEl) {
      var wireId = wireEl.getAttribute('data-wire');
      this.selectWire(this.selectedWire === wireId ? null : wireId);
      if (this.selectedWire) {
        this._status('已选中导线 ' + wireId + '，按 Delete 删除', 'info');
      }
      return;
    }
    var jackEl = findAncestor(e.target, 'data-jack');
    if (jackEl) {
      this.pickJack(jackEl.getAttribute('data-jack'));
    }
  };

  /**
   * 点选插孔：第一次记起点，第二次成线，点自己取消。
   * 契约 §2.3 返回值：
   *   'connected'      新建成功
   *   'cancelled'      重复接线 → 已删除该导线
   *   'cancelled-start' 点了同一个孔 → 取消起点
   *   'rejected'       被拒绝（同网 / 引擎抛错）
   *   null             入参非法
   * 旧调用方忽略返回值，保持兼容。
   */
  Interaction.prototype.pickJack = function (jackId) {
    if (!jackId) {
      return null;
    }
    // 选线状态下点孔，先清掉导线选中态
    if (this.selectedWire) {
      this.selectWire(null);
    }

    if (!this.selectedJack) {
      this.selectedJack = jackId;
      this.wireLayer.setSelectedJack(jackId);
      if (this.hud) {
        this.hud.setSelectedJack(jackId);
      }
      this._updatePreview();
      this._status('起点：' + jackLabel(this.geometry, jackId) + '，点击另一个插孔完成接线（Esc 取消）', 'info');
      return null;
    }

    if (this.selectedJack === jackId) {
      this.cancelSelection();
      this._status('已取消接线', 'info');
      return 'cancelled-start';
    }

    var from = this.selectedJack;

    // 契约 §2：重复接线 = 取消接线。
    // 同一对插孔（不分方向、不看颜色）之间已有导线时，删除全部这些导线。
    var existing = this._safeWires();
    var dups = [];
    for (var i = 0; i < existing.length; i++) {
      var w = existing[i];
      if ((w.from === from && w.to === jackId) || (w.from === jackId && w.to === from)) {
        dups.push(w);
      }
    }
    if (dups.length) {
      return this._cancelDuplicateWires(dups, from, jackId);
    }

    // 同一连通网：两端已在同一网里，再连一次没有电气意义
    var netId = this._findCommonNet(from, jackId);
    if (netId) {
      this.cancelSelection();
      this._status('这两个插孔已经在同一个连通网（' + netId + '）里，无需再连', 'warn');
      return 'rejected';
    }

    var wire = {
      id: this._nextWireId(),
      from: from,
      to: jackId,
      color: this.currentColor
    };
    try {
      var added = this.engine.addWire(wire);
      if (added && added.id) {
        wire = { id: added.id, from: added.from || from, to: added.to || jackId, color: added.color || this.currentColor };
      }
    } catch (err) {
      this._status('接线失败：' + (err && err.message ? err.message : '未知错误'), 'error');
      this.cancelSelection();
      return 'rejected';
    }
    this._pushUndo({ type: 'add', wire: wire });
    this.cancelSelection();
    this.refresh(true);
    this._status('已接线：' + jackLabel(this.geometry, from) + ' ↔ ' + jackLabel(this.geometry, jackId), 'info');
    return 'connected';
  };

  /**
   * 契约 §2：取消重复接线 —— 删除 from↔to 之间的全部直接导线。
   * 删除结果记入撤销栈（1 根用 remove，多根用 removeMany），可完整撤销回来。
   * @param {Array} dups 待删除的导线对象数组
   * @param {string} from 起点插孔 id
   * @param {string} to   终点插孔 id
   * @returns {string} 'cancelled'
   */
  Interaction.prototype._cancelDuplicateWires = function (dups, from, to) {
    var removed = [];
    for (var i = 0; i < dups.length; i++) {
      try {
        this.engine.removeWire(String(dups[i].id));
        removed.push({
          id: dups[i].id,
          from: dups[i].from,
          to: dups[i].to,
          color: dups[i].color
        });
      } catch (err) {
        // 单根删除失败不影响其余，最后按实际删除数提示
      }
    }
    if (!removed.length) {
      this.cancelSelection();
      this._status('取消接线失败：' + jackLabel(this.geometry, from) + ' ↔ ' + jackLabel(this.geometry, to), 'error');
      return 'rejected';
    }
    // 1 根沿用 remove，多根用 removeMany（契约 §2.2）
    if (removed.length >= 2) {
      this._pushUndo({ type: 'removeMany', wires: removed });
    } else {
      this._pushUndo({ type: 'remove', wire: removed[0] });
    }
    this.cancelSelection();
    this.refresh(true);
    this._status(
      '已取消接线：' + jackLabel(this.geometry, from) + ' ↔ ' + jackLabel(this.geometry, to) +
      '（重复接线 = 取消）',
      'info'
    );
    return 'cancelled';
  };

  /** 清除起点与预览曲线 */
  Interaction.prototype.cancelSelection = function () {
    this.selectedJack = null;
    this.wireLayer.setSelectedJack(null);
    this.wireLayer.setPreview(null);
    if (this.hud) {
      this.hud.setSelectedJack(null);
    }
  };

  /** 选中/取消选中导线 */
  Interaction.prototype.selectWire = function (wireId) {
    this.selectedWire = wireId ? String(wireId) : null;
    this.wireLayer.setSelectedWire(this.selectedWire);
  };

  /** 删除导线（记入撤销栈） */
  Interaction.prototype.removeWire = function (wireId, reason) {
    if (!wireId) {
      return false;
    }
    var id = String(wireId);
    var wires = this._safeWires();
    var target = null;
    for (var i = 0; i < wires.length; i++) {
      if (String(wires[i].id) === id) {
        target = wires[i];
        break;
      }
    }
    if (!target) {
      return false;
    }
    try {
      this.engine.removeWire(id);
    } catch (err) {
      this._status('删除失败：' + (err && err.message ? err.message : '未知错误'), 'error');
      return false;
    }
    this._pushUndo({ type: 'remove', wire: target });
    if (this.selectedWire === id) {
      this.selectWire(null);
    }
    this.refresh(true);
    this._status((reason || '删除') + '导线：' + jackLabel(this.geometry, target.from) + ' ↔ ' + jackLabel(this.geometry, target.to), 'info');
    return true;
  };

  /** 清空全部导线（可整体撤销） */
  Interaction.prototype.clearAll = function () {
    var wires = this._safeWires();
    if (!wires.length) {
      this._status('当前没有导线可清空', 'info');
      return;
    }
    var removed = [];
    for (var i = 0; i < wires.length; i++) {
      try {
        this.engine.removeWire(String(wires[i].id));
        removed.push(wires[i]);
      } catch (err) {
        // 单根失败不影响其余，最后汇总提示
      }
    }
    if (removed.length) {
      this._pushUndo({ type: 'clear', wires: removed });
    }
    this.selectWire(null);
    this.cancelSelection();
    this.refresh(true);
    this._status('已清空 ' + removed.length + ' 根导线（Ctrl+Z 可撤销）', 'info');
  };

  /* ---- 撤销 / 重做 ---------------------------------------------------------
   * 撤销栈里存的是「操作」，不是「快照」：add / remove / removeMany / clear 四种原子操作，
   * 每种都有正反两个方向，undo 与 redo 只是同一份数据朝相反方向施加。
   * 这样做的代价是需要为每种操作各写一条反向逻辑，好处是内存占用恒定、
   * 且不会像快照式撤销那样在导线多时拖慢主线程。
   * ---------------------------------------------------------------------- */

  /**
   * 把一条撤销记录朝指定方向施加到引擎上。
   * @param {Object} entry {type:'add'|'remove'|'removeMany'|'clear', ...}
   * @param {string} dir 'undo' | 'redo'
   * @returns {string} 中文操作说明（供状态栏显示）
   */
  Interaction.prototype._applyEntry = function (entry, dir) {
    var back = dir === 'undo';
    var i;
    if (entry.type === 'add') {
      if (back) {
        this.engine.removeWire(String(entry.wire.id));
        return '已撤销接线：' + jackLabel(this.geometry, entry.wire.from) + ' ↔ ' + jackLabel(this.geometry, entry.wire.to);
      }
      this.engine.addWire(entry.wire);
      return '已重做接线：' + jackLabel(this.geometry, entry.wire.from) + ' ↔ ' + jackLabel(this.geometry, entry.wire.to);
    }
    if (entry.type === 'remove') {
      if (back) {
        this.engine.addWire(entry.wire);
        return '已恢复导线：' + jackLabel(this.geometry, entry.wire.from) + ' ↔ ' + jackLabel(this.geometry, entry.wire.to);
      }
      this.engine.removeWire(String(entry.wire.id));
      return '已重做删除：' + jackLabel(this.geometry, entry.wire.from) + ' ↔ ' + jackLabel(this.geometry, entry.wire.to);
    }
    if (entry.type === 'removeMany') {
      if (back) {
        for (i = 0; i < entry.wires.length; i++) {
          this.engine.addWire(entry.wires[i]);
        }
        return '已恢复 ' + entry.wires.length + ' 根导线';
      }
      for (i = 0; i < entry.wires.length; i++) {
        this.engine.removeWire(String(entry.wires[i].id));
      }
      return '已重新删除 ' + entry.wires.length + ' 根导线';
    }
    if (entry.type === 'clear') {
      if (back) {
        for (i = 0; i < entry.wires.length; i++) {
          this.engine.addWire(entry.wires[i]);
        }
        return '已恢复 ' + entry.wires.length + ' 根导线';
      }
      for (i = 0; i < entry.wires.length; i++) {
        this.engine.removeWire(String(entry.wires[i].id));
      }
      return '已重新清空 ' + entry.wires.length + ' 根导线';
    }
    return '';
  };

  /** 记一条新操作：新操作一旦产生，原先的「重做」链就失效了（与编辑器惯例一致） */
  Interaction.prototype._pushUndo = function (entry) {
    this.undoStack.push(entry);
    this.redoStack.length = 0;
    this._trimUndo();
  };

  /** 撤销最近一次接线操作，返回是否成功 */
  Interaction.prototype.undo = function () {
    var entry = this.undoStack.pop();
    if (!entry) {
      this._status('没有可撤销的操作', 'warn');
      return false;
    }
    var ok = true;
    try {
      this._status(this._applyEntry(entry, 'undo'), 'info');
    } catch (err) {
      ok = false;
      this._status('撤销失败：' + (err && err.message ? err.message : '未知错误'), 'error');
    }
    if (ok) {
      // 只有真正撤销成功才进重做栈，否则会留下一条永远对不上的记录
      this.redoStack.push(entry);
      if (this.redoStack.length > MAX_UNDO) {
        this.redoStack.shift();
      }
    }
    this.refresh(true);
    return ok;
  };

  /** 重做上一次被撤销的操作，返回是否成功 */
  Interaction.prototype.redo = function () {
    var entry = this.redoStack.pop();
    if (!entry) {
      this._status('没有可重做的操作', 'warn');
      return false;
    }
    var ok = true;
    try {
      this._status(this._applyEntry(entry, 'redo'), 'info');
    } catch (err) {
      ok = false;
      this._status('重做失败：' + (err && err.message ? err.message : '未知错误'), 'error');
    }
    if (ok) {
      this.undoStack.push(entry);
      this._trimUndo();
    }
    this.refresh(true);
    return ok;
  };

  /** 是否还有可撤销 / 可重做的操作（工具栏按钮据此置灰） */
  Interaction.prototype.canUndo = function () {
    return this.undoStack.length > 0;
  };

  Interaction.prototype.canRedo = function () {
    return this.redoStack.length > 0;
  };

  /** 查两个插孔是否已在同一连通网里；是则返回网 id，否则 null */
  Interaction.prototype._findCommonNet = function (a, b) {
    var state = this._lastState;
    if (!state || !Array.isArray(state.nets)) {
      return null;
    }
    for (var i = 0; i < state.nets.length; i++) {
      var net = state.nets[i];
      var jacks = (net && net.jacks) || [];
      if (jacks.indexOf(a) >= 0 && jacks.indexOf(b) >= 0) {
        return net.id || 'net';
      }
    }
    return null;
  };

  /**
   * 状态签名：只取会影响面板视觉的字段，用来判断是否需要回调 onState。
   * 时钟/脉冲每帧都在变，签名不变就不打扰订阅方。
   *
   * 字段说明（与 logic-engine 交付的 getState() 对齐）：
   *   jacks   全量插孔电平
   *   leds    4L1~4L16 点亮布尔
   *   swLeds  5L1~5L16 状态灯布尔
   *   segs    数码管逐段原始电平（共阳/共阴语义不同）
   *   segOn   数码管逐段点亮布尔（引擎已换算，渲染用这个）
   * 两者都纳入签名：共阳/共阴翻转时原始电平不变但点亮结果会变，漏了会少刷新一帧。
   */
  Interaction.prototype._stateSignature = function (state) {
    if (!state) {
      return 'null';
    }
    try {
      return JSON.stringify({
        j: state.jacks || null,
        l: state.leds || null,
        s: state.swLeds || null,
        g: state.segs || null,
        o: state.segOn || null,
        p: state.pulses || null,
        x: state.shorts || null,
        w: state.warnings || null
      });
    } catch (err) {
      return 'unserializable';
    }
  };

  Interaction.prototype._trimUndo = function () {
    while (this.undoStack.length > MAX_UNDO) {
      this.undoStack.shift();
    }
  };

  /** 生成不重复的导线 id */
  Interaction.prototype._nextWireId = function () {
    var existing = Object.create(null);
    var wires = this._safeWires();
    for (var i = 0; i < wires.length; i++) {
      existing[String(wires[i].id)] = true;
    }
    var id;
    do {
      this.wireSeq += 1;
      id = 'w' + this.wireSeq;
    } while (existing[id]);
    return id;
  };

  Interaction.prototype._safeWires = function () {
    try {
      var wires = this.engine.getWires();
      return Array.isArray(wires) ? wires : [];
    } catch (err) {
      return [];
    }
  };

  /** 换当前导线颜色 */
  Interaction.prototype.setColor = function (color) {
    if (typeof color !== 'string' || !color) {
      return;
    }
    this.currentColor = color;
    if (this.wireLayer.setPreviewColor) {
      this.wireLayer.setPreviewColor(color);
    }
    if (this.hud && this.hud.setColor) {
      this.hud.setColor(color);
    }
  };

  /** 透视开关：隐藏/显示飞线 */
  Interaction.prototype.setWiresVisible = function (visible) {
    this.wiresVisible = !!visible;
    this.wireLayer.setVisible(this.wiresVisible);
  };

  /** 导出当前工程 */
  Interaction.prototype.exportFile = function () {
    if (!DLab.Persistence) {
      this._status('导出失败：Persistence 模块未加载', 'error');
      return;
    }
    try {
      var name = DLab.Persistence.exportProject(this.engine);
      this._status('已导出工程文件 ' + (name || ''), 'info');
    } catch (err) {
      this._status('导出失败：' + (err && err.message ? err.message : '未知错误'), 'error');
    }
  };

  /** 导入工程文件 */
  Interaction.prototype.importFile = function (file) {
    if (!DLab.Persistence) {
      this._status('导入失败：Persistence 模块未加载', 'error');
      return Promise.resolve({ ok: false, message: 'Persistence 模块未加载' });
    }
    var self = this;
    this._status('正在读取 ' + (file && file.name ? file.name : '文件') + ' …', 'info');
    return DLab.Persistence.importProject(file, this.engine).then(function (result) {
      if (result && result.ok) {
        self.undoStack.length = 0;
        self.redoStack.length = 0;
        self.cancelSelection();
        self.selectWire(null);
        self.refresh(true);
        self._status(result.message || '导入成功', 'info');
      } else {
        self._status((result && result.message) || '导入失败', 'error');
      }
      return result;
    });
  };

  /** 给 Hud 用的回调集合 */
  Interaction.prototype.getHandlers = function () {
    if (this._handlers) {
      return this._handlers;
    }
    var self = this;
    this._handlers = {
      onColor: function (color) {
        self.setColor(color);
      },
      onClear: function () {
        self.clearAll();
      },
      onImport: function (file) {
        return self.importFile(file);
      },
      onExport: function () {
        self.exportFile();
      },
      onUndo: function () {
        self.undo();
      },
      onRedo: function () {
        self.redo();
      },
      onToggleWires: function (visible) {
        self.setWiresVisible(visible);
      }
    };
    return this._handlers;
  };

  // —— 生命周期 ——
  Interaction.prototype.start = function () {
    if (this.started) {
      return;
    }
    this.started = true;
    this._bind();
    this._loop();
    this.refresh(true);
    this._status('就绪：点击两个插孔即可接线', 'info');
  };

  Interaction.prototype.stop = function () {
    this.started = false;
    if (this._rafId) {
      if (global.cancelAnimationFrame) {
        global.cancelAnimationFrame(this._rafId);
      }
      this._rafId = 0;
    }
    for (var i = 0; i < this._bound.length; i++) {
      var b = this._bound[i];
      b.target.removeEventListener(b.type, b.fn, b.options);
    }
    this._bound.length = 0;
  };

  Interaction.prototype._loop = function () {
    var self = this;
    function frame() {
      if (!self.started) {
        return;
      }
      self._tick();
      self._rafId = global.requestAnimationFrame(frame);
    }
    this._rafId = global.requestAnimationFrame(frame);
  };

  /** 每帧：推进仿真 → 按需刷新画面（数据没变就不碰 DOM） */
  Interaction.prototype._tick = function () {
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var state = null;
    try {
      if (this._getTimeOwner && this._getTimeOwner()) {
        // H8：Timeline 接管推进时，状态已由其 rAF 循环推进到当前虚拟时刻，
        // 这里再 step 一次是同值幂等重算（每帧约 0.3ms 纯浪费），直接跳过。
        this._engineErrorShown = false;
      } else {
        this.engine.step(now);
        this._engineErrorShown = false;
      }
    } catch (err) {
      if (!this._engineErrorShown) {
        this._engineErrorShown = true;
        this._status('仿真推进失败：' + (err && err.message ? err.message : '未知错误'), 'error');
      }
    }
    try {
      state = this.engine.getState();
    } catch (err) {
      state = null;
    }

    // 1. 导线：只有集合/颜色变化时才重绘
    var wires = this._safeWires();
    var sig = this._wireSignature(wires);
    if (sig !== this._lastWireSig) {
      this._lastWireSig = sig;
      this.wireLayer.render(wires);
      if (this.hud) {
        this.hud.setWireCount(wires.length);
      }
    }

    // 2. 鼠标悬停命中（有移动才重新算）
    if (this.pointerMoved && this.lastPointer) {
      this.pointerMoved = false;
      this._updateHover(this.lastPointer.clientX, this.lastPointer.clientY);
    }

    // 3. 预览曲线跟随鼠标
    if (this.selectedJack && this.lastPointer) {
      this._updatePreview();
    }

    // 4. 状态联动：短路告警、警告、电平回调
    if (state) {
      this._syncState(state);
    }
  };

  Interaction.prototype._wireSignature = function (wires) {
    var parts = [];
    for (var i = 0; i < wires.length; i++) {
      var w = wires[i];
      if (!w) {
        continue;
      }
      parts.push(w.id + '|' + w.from + '|' + w.to + '|' + w.color);
    }
    return parts.join(';');
  };

  Interaction.prototype._updateHover = function (clientX, clientY) {
    var hit = this.wireLayer.hitTest(clientX, clientY);
    var jackId = hit && hit.type === 'jack' ? hit.jackId : null;
    var wireId = hit && hit.type === 'wire' ? hit.wireId : null;

    if (jackId !== this._hoverJack) {
      this._hoverJack = jackId;
      this.wireLayer.setJackHover(jackId, !!jackId);
      this.wireLayer.svg.style.cursor = jackId ? 'crosshair' : '';
    }
    if (wireId !== this._hoverWire) {
      this._hoverWire = wireId;
      this.wireLayer.setWireHover(wireId, !!wireId);
      if (wireId) {
        this.wireLayer.svg.style.cursor = 'pointer';
      } else if (!jackId) {
        this.wireLayer.svg.style.cursor = '';
      }
    }
  };

  Interaction.prototype._updatePreview = function () {
    if (!this.selectedJack || !this.lastPointer) {
      return;
    }
    this.wireLayer.setPreview(this.selectedJack, this.lastPointer.clientX, this.lastPointer.clientY);
  };

  Interaction.prototype._syncState = function (state) {
    // H9 快速路径：引擎的 _buildState 每次都返回全新对象，引用相同必然内容相同。
    // H8 生效后（暂停 / 无变化帧）每帧拿到的是同一个对象，直接跳过三套签名计算
    //（实测整套 JSON 签名约 30µs/帧，暂停态 60fps 即省 ~1.8ms/s）。
    if (state === this._lastStateRef) {
      return;
    }
    this._lastStateRef = state;
    if (this.hud) {
      var shorts = Array.isArray(state.shorts) ? state.shorts : [];
      var shortsSig = JSON.stringify(shorts);
      if (shortsSig !== this._lastShortsSig) {
        this._lastShortsSig = shortsSig;
        this.hud.setShorts(shorts);
      }
      var warnings = Array.isArray(state.warnings) ? state.warnings : [];
      var warnSig = JSON.stringify(warnings);
      if (warnSig !== this._lastWarnSig) {
        this._lastWarnSig = warnSig;
        if (warnings.length && !shorts.length) {
          this._status(warnings[0], 'warn');
        }
      }
    }
    // 只在视觉相关状态变化时回调订阅方（boardView 等），避免每帧刷 DOM
    var sig = this._stateSignature(state);
    if (sig !== this._lastStateSig) {
      this._lastStateSig = sig;
      this._lastState = state;
      if (this.onState) {
        this.onState(state);
      }
      if (typeof document !== 'undefined' && document.dispatchEvent && typeof CustomEvent !== 'undefined') {
        document.dispatchEvent(new CustomEvent('dlab:state', { detail: state }));
      }
    }
  };

  /** 强制重绘（导入、外部改数据后调用） */
  Interaction.prototype.refresh = function (force) {
    var wires = this._safeWires();
    var sig = this._wireSignature(wires);
    if (force || sig !== this._lastWireSig) {
      this._lastWireSig = sig;
      this.wireLayer.render(wires);
      if (this.hud) {
        this.hud.setWireCount(wires.length);
      }
    }
    // H8：接线类 API（addWire/removeWire/clearWires）是结构性操作、不自动重算
    //（契约 §5）。旧实现依赖下一帧 rAF 里的 engine.step 补算；H8 跳过该步后，
    // 改在这里显式补一次无参 step（同一时刻幂等重算，覆盖接线 / 撤销 / 导入全部路径）。
    try {
      this.engine.step();
    } catch (err) {
      // 与 _tick 的容错口径一致：重算失败不炸 UI
    }
  };

  Interaction.prototype._status = function (text, level) {
    if (this.hud && this.hud.setStatus) {
      this.hud.setStatus(text, level || 'info');
    }
  };

  /**
   * 只读：当前仿真状态（供 Lead 的 boardView 画 LED/数码管）。
   * 注意：state.segs 是数码管逐段原始电平，渲染请用 state.segOn（引擎已按共阳/共阴换算）。
   */
  Interaction.prototype.getState = function () {
    if (this._lastState) {
      return this._lastState;
    }
    try {
      return this.engine.getState();
    } catch (err) {
      return null;
    }
  };

  DLab.Interaction = Interaction;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// src/ui/hud.js
// 底部工具栏：导线颜色板、撤销/清空/导入/导出、透视开关，以及状态提示条（选中孔、最近操作、短路告警）。
// 只负责 DOM 与回调分发，所有业务逻辑交给 Interaction。
(function (global) {
  'use strict';
  var DLab = (global.DLab = global.DLab || {});

  // 契约第 7 节的 7 色导线颜色板
  var PALETTE = [
    { color: '#ef4444', name: '红', hint: 'VCC / 电源' },
    { color: '#1f2937', name: '黑', hint: 'GND / 地' },
    { color: '#3b82f6', name: '蓝', hint: 'CLK / 时钟' },
    { color: '#eab308', name: '黄', hint: '信号' },
    { color: '#22c55e', name: '绿', hint: '输出' },
    { color: '#f97316', name: '橙', hint: '信号' },
    { color: '#a855f7', name: '紫', hint: '信号' }
  ];

  var DEFAULT_COLOR = PALETTE[0].color;
  var STATUS_TIMEOUT = 6000;   // 普通提示 6 秒后回落为就绪提示

  /** 创建元素并设置属性/文本 */
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) {
          continue;
        }
        if (k === 'className') {
          node.className = attrs[k];
        } else if (k === 'text') {
          node.textContent = attrs[k];
        } else {
          node.setAttribute(k, String(attrs[k]));
        }
      }
    }
    if (text !== undefined && text !== null) {
      node.textContent = text;
    }
    return node;
  }

  /** 取插孔展示名 */
  function jackLabel(geometry, jackId) {
    var jacks = (geometry && geometry.JACKS) || {};
    var jack = jacks[jackId];
    if (!jack) {
      return String(jackId);
    }
    if (jack.moduleId && jack.label) {
      return jack.moduleId + ':' + jack.label;
    }
    return String(jack.label || jackId);
  }

  // —— Hud ——
  /**
   * @param {HTMLElement} containerEl #toolbar
   * @param {{onColor:Function,onClear:Function,onImport:Function,onExport:Function,onUndo:Function,onToggleWires:Function}} handlers
   */
  function Hud(containerEl, handlers) {
    this.handlers = handlers || {};
    this.geometry = (DLab.geometry) || { JACKS: {} };
    this.color = DEFAULT_COLOR;
    this.selectedJack = null;
    this.wireCount = 0;
    this.shorts = [];
    this._statusTimer = 0;
    this._swatches = Object.create(null);

    if (!containerEl) {
      containerEl = document.createElement('div');
      containerEl.id = 'toolbar';
      if (document.body) {
        document.body.appendChild(containerEl);
      }
    }
    this.root = containerEl;
    this._build();
  }

  Hud.prototype._build = function () {
    var self = this;
    this.root.classList.add('hud');
    this.root.textContent = '';

    // —— 颜色板 ——
    var colorGroup = el('div', { className: 'hud-group hud-colors' });
    colorGroup.appendChild(el('span', { className: 'hud-label' }, '导线颜色'));
    for (var i = 0; i < PALETTE.length; i++) {
      var item = PALETTE[i];
      var swatch = el('button', {
        type: 'button',
        className: 'hud-swatch',
        'data-color': item.color,
        title: item.name + '（' + item.hint + '） ' + item.color,
        'aria-label': item.name + ' ' + item.hint
      });
      swatch.style.backgroundColor = item.color;
      if (item.color === '#1f2937') {
        swatch.classList.add('is-dark');
      }
      this._swatches[item.color] = swatch;
      colorGroup.appendChild(swatch);
    }
    this.root.appendChild(colorGroup);

    // —— 操作按钮 ——
    var actionGroup = el('div', { className: 'hud-group hud-actions' });
    this.undoBtn = el('button', { type: 'button', className: 'hud-btn', 'data-act': 'undo', title: '撤销最近一次接线操作（Ctrl+Z）' }, '撤销');
    this.redoBtn = el('button', { type: 'button', className: 'hud-btn', 'data-act': 'redo', title: '重做被撤销的操作（Ctrl+Y / Ctrl+Shift+Z）' }, '重做');
    this.clearBtn = el('button', { type: 'button', className: 'hud-btn', 'data-act': 'clear', title: '删除全部导线（可撤销）' }, '清空导线');
    this.exportBtn = el('button', { type: 'button', className: 'hud-btn', 'data-act': 'export', title: '导出为 .dlab.json 工程文件' }, '导出');
    this.importBtn = el('button', { type: 'button', className: 'hud-btn', 'data-act': 'import', title: '从 .dlab.json 工程文件导入' }, '导入');
    this.muteBtn = el('button', { type: 'button', className: 'hud-btn', 'data-act': 'mute', title: '静音 / 取消静音板载音频（蜂鸣器与扬声器）' }, '静音');
    this.fileInput = el('input', {
      type: 'file',
      accept: '.json,.dlab.json,application/json',
      className: 'hud-file',
      'aria-hidden': 'true',
      tabindex: '-1'
    });
    actionGroup.appendChild(this.undoBtn);
    actionGroup.appendChild(this.redoBtn);
    actionGroup.appendChild(this.clearBtn);
    actionGroup.appendChild(this.exportBtn);
    actionGroup.appendChild(this.importBtn);
    actionGroup.appendChild(this.muteBtn);
    actionGroup.appendChild(this.fileInput);

    // —— 透视开关 ——
    var toggleLabel = el('label', { className: 'hud-toggle', title: '隐藏飞线以便观察面板（仍可接线）' });
    this.toggleInput = el('input', { type: 'checkbox', 'data-act': 'toggle' });
    this.toggleInput.checked = true;
    toggleLabel.appendChild(this.toggleInput);
    toggleLabel.appendChild(el('span', { className: 'hud-toggle-text' }, '显示导线'));
    actionGroup.appendChild(toggleLabel);

    this.root.appendChild(actionGroup);

    // —— 状态区 ——
    var statusGroup = el('div', { className: 'hud-group hud-status' });
    this.jackChip = el('span', { className: 'hud-chip hud-chip-jack' }, '未选中插孔');
    this.countChip = el('span', { className: 'hud-chip hud-chip-count' }, '导线 0');
    this.messageEl = el('span', { className: 'hud-message' }, '就绪');
    this.shortsEl = el('span', { className: 'hud-shorts', 'aria-live': 'polite' });
    statusGroup.appendChild(this.jackChip);
    statusGroup.appendChild(this.countChip);
    statusGroup.appendChild(this.messageEl);
    statusGroup.appendChild(this.shortsEl);
    this.root.appendChild(statusGroup);

    // —— 事件 ——
    colorGroup.addEventListener('click', function (e) {
      var target = e.target;
      var color = target && target.getAttribute ? target.getAttribute('data-color') : null;
      if (!color) {
        return;
      }
      self.setColor(color);
      if (typeof self.handlers.onColor === 'function') {
        self.handlers.onColor(color);
      }
    });

    actionGroup.addEventListener('click', function (e) {
      var target = e.target;
      var act = target && target.getAttribute ? target.getAttribute('data-act') : null;
      if (act === 'undo' && typeof self.handlers.onUndo === 'function') {
        self.handlers.onUndo();
      } else if (act === 'redo' && typeof self.handlers.onRedo === 'function') {
        self.handlers.onRedo();
      } else if (act === 'clear' && typeof self.handlers.onClear === 'function') {
        self.handlers.onClear();
      } else if (act === 'export' && typeof self.handlers.onExport === 'function') {
        self.handlers.onExport();
      } else if (act === 'import') {
        self.fileInput.click();
      } else if (act === 'mute' && typeof self.handlers.onMute === 'function') {
        self.handlers.onMute();
      }
    });

    this.fileInput.addEventListener('change', function () {
      var file = self.fileInput.files && self.fileInput.files[0];
      if (file && typeof self.handlers.onImport === 'function') {
        self.handlers.onImport(file);
      }
      // 允许连续选择同一个文件
      self.fileInput.value = '';
    });

    this.toggleInput.addEventListener('change', function () {
      var visible = !!self.toggleInput.checked;
      self.root.classList.toggle('is-wires-hidden', !visible);
      if (typeof self.handlers.onToggleWires === 'function') {
        self.handlers.onToggleWires(visible);
      }
    });

    this.setColor(this.color);
    this.setWireCount(0);
  };

  /**
   * 回填/合并回调集合（Interaction 建好之后再挂真实回调时用）。
   * 事件监听采用容器委托，绑定在构建时已完成，这里只需合并 handlers 即可生效。
   * @param {Object} handlers 与构造函数同构的回调对象，只覆盖传入的键
   */
  Hud.prototype.setHandlers = function (handlers) {
    if (!handlers || typeof handlers !== 'object') {
      return this.handlers;
    }
    for (var key in handlers) {
      if (Object.prototype.hasOwnProperty.call(handlers, key) && typeof handlers[key] === 'function') {
        this.handlers[key] = handlers[key];
      }
    }
    return this.handlers;
  };

  /** 同步颜色板选中态 */
  Hud.prototype.setColor = function (color) {
    if (typeof color !== 'string' || !color) {
      return;
    }
    this.color = color;
    for (var key in this._swatches) {
      if (!Object.prototype.hasOwnProperty.call(this._swatches, key)) {
        continue;
      }
      var swatch = this._swatches[key];
      var active = key.toLowerCase() === color.toLowerCase();
      swatch.classList.toggle('is-active', active);
      swatch.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  };

  /**
   * 状态提示条。
   * @param {string} text
   * @param {'info'|'warn'|'error'} [level]
   */
  Hud.prototype.setStatus = function (text, level) {
    if (!this.messageEl) {
      return;
    }
    var lv = level || 'info';
    this.messageEl.textContent = text ? String(text) : '';
    this.messageEl.className = 'hud-message is-' + lv;
    // 错误提示保留更久，普通提示自动回落
    if (this._statusTimer) {
      clearTimeout(this._statusTimer);
      this._statusTimer = 0;
    }
    if (lv === 'info' && text) {
      var self = this;
      this._statusTimer = setTimeout(function () {
        self._statusTimer = 0;
        if (self.messageEl) {
          self.messageEl.textContent = '就绪';
          self.messageEl.className = 'hud-message is-info';
        }
      }, STATUS_TIMEOUT);
    }
  };

  /** 显示当前连线起点插孔（null 清除） */
  Hud.prototype.setSelectedJack = function (jackId) {
    this.selectedJack = jackId || null;
    if (!this.jackChip) {
      return;
    }
    if (this.selectedJack) {
      this.jackChip.textContent = '起点 ' + jackLabel(this.geometry, this.selectedJack);
      this.jackChip.classList.add('is-active');
    } else {
      this.jackChip.textContent = '未选中插孔';
      this.jackChip.classList.remove('is-active');
    }
  };

  /** 更新导线计数 */
  Hud.prototype.setWireCount = function (n) {
    this.wireCount = Number(n) || 0;
    if (this.countChip) {
      this.countChip.textContent = '导线 ' + this.wireCount;
    }
  };

  /** 短路告警：非空时红字闪烁 */
  Hud.prototype.setShorts = function (shorts) {
    this.shorts = Array.isArray(shorts) ? shorts : [];
    if (!this.shortsEl) {
      return;
    }
    if (!this.shorts.length) {
      this.shortsEl.textContent = '';
      this.shortsEl.classList.remove('is-alert');
      this.root.classList.remove('has-short');
      return;
    }
    // 汇总短路网表里涉及的插孔，最多列 4 个
    var names = [];
    for (var i = 0; i < this.shorts.length && names.length < 4; i++) {
      var jacks = (this.shorts[i] && this.shorts[i].jacks) || [];
      for (var j = 0; j < jacks.length && names.length < 4; j++) {
        names.push(jackLabel(this.geometry, jacks[j]));
      }
    }
    this.shortsEl.textContent = '⚠ 短路 ' + this.shorts.length + ' 处' + (names.length ? '：' + names.join(' ↔ ') : '');
    this.shortsEl.classList.add('is-alert');
    this.root.classList.add('has-short');
  };

  /** 当前状态快照（便于自测） */
  Hud.prototype.getSnapshot = function () {
    return {
      color: this.color,
      selectedJack: this.selectedJack,
      wireCount: this.wireCount,
      shorts: this.shorts.slice(),
      message: this.messageEl ? this.messageEl.textContent : '',
      messageLevel: this.messageEl ? this.messageEl.className : ''
    };
  };

  Hud.PALETTE = PALETTE;
  DLab.Hud = Hud;
})(typeof globalThis !== 'undefined' ? globalThis : this);

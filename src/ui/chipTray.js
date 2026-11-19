// src/ui/chipTray.js
// 芯片插座交互层：点击 DIP 插座 -> 弹出兼容型号清单 -> 插上 / 拔下芯片。
//
// 【为什么需要这一层】
//   仿真引擎（engine.js）与芯片库（chips.js）早就支持 mountChip / unmountChip，
//   但面板 SVG 上的 10 个 DIP 插座只是**画上去的图形**：
//     · 没有命中区，点上去毫无反应；
//     · 没有「已插芯片」的视觉反馈，学生看不出插座里有没有芯片；
//     · 界面里没有任何入口能把芯片库里的 17 款器件装上去。
//   结果是：芯片库再全，学生也只能靠控制台敲 mountChip 才能用——这等于没用。
//   本层把「插座」从图形变成可操作实体，补齐这条链路。
//
// 【坐标来源（全部从 SVG.SVG 逐条读出，不臆造）】
//   #dev-module-common 中四个插座区的 <g transform="translate(x,y)">：
//     UA (126,204)  UB (642,204)  UE (205,368)  UD (565,368)  UF (388,68)
//   各插座本体的 <rect>（模板内相对坐标）：
//     14 脚 #block-14pin : x=-36 y=-17 w=72 h=34
//     16 脚 #block-16pin : x=-42 y=-17 w=84 h=34
//     20 脚 UF           : x=-54 y=-20 w=108 h=40
//   两个开发模块的 <g transform>：devA (48,340)、devB (982,340)
//   于是插座中心绝对坐标 = 模块原点 + 插座区原点，例如：
//     devA:UA = (48+126, 340+204) = (174,544)
//   与 geometry 交叉验证：devA:UE 的第 1 脚插孔 E1 在模板 (-112,22)，
//     绝对坐标 = (48+205-112, 340+368+22) = (141,730)，
//     而 DLab.geometry.JACKS['devA:E1'] = (141,730) —— 完全吻合。
//
// 【交互设计取舍】
//   · 点插座弹出浮动菜单（HTML 而非 SVG），因为型号名较长、需要滚动与键盘可达性；
//   · 菜单只列**封装匹配**的型号（14 脚插座不会出现 20 脚芯片），从入口杜绝插错；
//   · 插上后在该插座位置画一枚芯片本体（深色矩形 + 白色丝印型号 + 1 脚圆点），
//     与实物「插上芯片后插座被盖住」的观感一致，同时让状态一眼可见；
//   · 再点一次已插芯片的插座 = 弹出菜单，其中含「拔下芯片」一项。
(function (global) {
  'use strict';

  var DLab = (global.DLab = global.DLab || {});

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* ============================================================
   * 1. 插座几何表（推导过程见文件头，全部来自 SVG.SVG）
   * ============================================================ */

  /** 单个开发模块内部的插座布局（模板内坐标 + 本体尺寸 + 脚数） */
  var AREAS = [
    { name: 'UA', x: 126, y: 204, w: 72, h: 34, pins: 14 },
    { name: 'UB', x: 642, y: 204, w: 72, h: 34, pins: 14 },
    { name: 'UE', x: 205, y: 368, w: 84, h: 34, pins: 16 },
    { name: 'UD', x: 565, y: 368, w: 84, h: 34, pins: 16 },
    { name: 'UF', x: 388, y: 68, w: 108, h: 40, pins: 20 }
  ];

  /** 开发模块原点（与 SVG.SVG 的 <g transform="translate(...)"> 一致） */
  var MODULE_ORIGINS = {
    devA: [48, 340],
    devB: [982, 340]
  };

  /** 命中区相对插座本体的外扩量 */
  var HIT_PAD = 6;
  /** 芯片本体相对插座本体的外扩量：实物芯片比插座略大一圈 */
  var BODY_PAD = 3;

  /* ============================================================
   * 2. 型号说明（面向学生的中文一句话）
   *    放在本文件而不是 chips.js：chips.js 是纯行为模型，
   *    不该掺杂展示文案；而且这里的措辞属于界面层职责。
   * ============================================================ */
  var DESCRIPTIONS = {
    '74LS00': '四路二输入与非门',
    '74LS02': '四路二输入或非门',
    '74LS04': '六反相器',
    '74LS08': '四路二输入与门',
    '74LS32': '四路二输入或门',
    '74LS86': '四路二输入异或门',
    '74LS74': '双 D 上升沿触发器',
    '74LS112': '双 J-K 下降沿触发器',
    '74LS138': '3-8 线译码器',
    '74LS148': '8-3 线优先编码器',
    '74LS151': '8 选 1 数据选择器',
    '74LS153': '双 4 选 1 数据选择器',
    '74LS160': '十进制同步计数器',
    '74LS161': '4 位二进制同步计数器',
    '74LS194': '4 位双向移位寄存器',
    '74LS273': '八 D 上升沿触发器',
    '74LS283': '4 位二进制全加器'
  };

  /* ============================================================
   * 3. 小工具
   * ============================================================ */

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) {
          node.setAttribute(k, String(attrs[k]));
        }
      }
    }
    return node;
  }

  function htmlEl(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = text;
    }
    return node;
  }

  /** 按封装脚数取兼容型号清单（顺序沿用 Chips.list() 的字典序） */
  function modelsOfPackage(pins) {
    if (!DLab.Chips || typeof DLab.Chips.list !== 'function') {
      return [];
    }
    var all = DLab.Chips.list();
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (DLab.Chips.packageOf(all[i]) === pins) {
        out.push(all[i]);
      }
    }
    return out;
  }

  /* ============================================================
   * 4. 构造
   * ============================================================ */

  /**
   * @param {{engine:Object, wireLayer:Object, geometry:Object,
   *          hud:Object, onChange:Function}} opts
   */
  function ChipTray(opts) {
    opts = opts || {};
    this.engine = opts.engine;
    if (!this.engine) {
      throw new Error('ChipTray：缺少 engine');
    }
    this.wireLayer = opts.wireLayer || null;
    this.geometry = opts.geometry || (DLab.geometry || { JACKS: {} });
    this.hud = opts.hud || null;
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null;

    this.sockets = Object.create(null);   // socketId -> 记录
    this.menu = null;                     // 当前弹出的菜单根节点
    this.menuSocket = null;               // 菜单对应的插座 id
    this._host = null;
    this._bound = [];

    this._buildSockets();
    this._bindEvents();
    this.syncVisuals();
  }

  /* ============================================================
   * 5. 插座命中区与芯片本体
   * ============================================================ */

  /** 建立 10 个插座的命中区（画在覆盖层，因为面板 SVG 是 pointer-events:none） */
  ChipTray.prototype._buildSockets = function () {
    var svg = this.wireLayer && this.wireLayer.svg;
    if (!svg) {
      return;
    }

    var host = svgEl('g', { id: 'chip-sockets' });
    var m, a, i;

    for (m in MODULE_ORIGINS) {
      if (!Object.prototype.hasOwnProperty.call(MODULE_ORIGINS, m)) {
        continue;
      }
      var origin = MODULE_ORIGINS[m];
      for (i = 0; i < AREAS.length; i++) {
        a = AREAS[i];
        var cx = origin[0] + a.x;
        var cy = origin[1] + a.y;
        var id = m + ':' + a.name;

        // 命中区：比插座本体外扩 HIT_PAD，保证边框也好点中
        var hit = svgEl('rect', {
          x: cx - a.w / 2 - HIT_PAD,
          y: cy - a.h / 2 - HIT_PAD,
          width: a.w + HIT_PAD * 2,
          height: a.h + HIT_PAD * 2,
          rx: 4,
          'class': 'chip-socket-hit',
          'data-socket': id,
          'data-pins': a.pins,
          'pointer-events': 'all',
          role: 'button',
          tabindex: '0',
          'aria-pressed': 'false',
          'aria-label': '插座 ' + id + '（' + a.pins + ' 脚），点击插入芯片'
        });
        host.appendChild(hit);

        this.sockets[id] = {
          id: id,
          module: m,
          label: a.name,
          x: cx,
          y: cy,
          w: a.w,
          h: a.h,
          pins: a.pins,
          hit: hit,
          body: null,     // 已插芯片的图形（未插时为 null）
          text: null
        };
      }
    }

    // 插到最底层：芯片本体是「盖子」，不该挡住插孔命中圆与飞线
    if (svg.insertBefore) {
      svg.insertBefore(host, svg.firstChild);
    } else {
      svg.appendChild(host);
    }
    this._host = host;
  };

  /** 给某个插座画上「已插芯片」的图形（重复调用会先清掉旧的） */
  ChipTray.prototype._paintChip = function (socketId, model) {
    var rec = this.sockets[socketId];
    if (!rec || !this._host) {
      return;
    }
    this._clearChip(socketId);

    var w = rec.w + BODY_PAD * 2;
    var h = rec.h + BODY_PAD * 2;
    var g = svgEl('g', { 'class': 'chip-body', 'data-chip-socket': socketId, 'pointer-events': 'none' });

    // 芯片本体：深灰塑料 + 浅色描边，与面板上原有的插座底色区分开
    g.appendChild(svgEl('rect', {
      x: rec.x - w / 2, y: rec.y - h / 2, width: w, height: h, rx: 2.5,
      'class': 'chip-body-plate'
    }));
    // 1 脚标记：实物芯片左端的半圆缺口
    g.appendChild(svgEl('circle', {
      cx: rec.x - w / 2 + 5, cy: rec.y, r: 2.6, 'class': 'chip-body-pin1'
    }));

    var text = svgEl('text', {
      x: rec.x, y: rec.y + 3.2,
      'class': 'chip-body-label',
      'text-anchor': 'middle',
      'font-size': rec.pins >= 20 ? 9 : 8.5
    });
    text.textContent = model;
    g.appendChild(text);

    rec.body = g;
    rec.text = text;
    this._host.appendChild(g);
  };

  ChipTray.prototype._clearChip = function (socketId) {
    var rec = this.sockets[socketId];
    if (!rec) {
      return;
    }
    if (rec.body && rec.body.parentNode) {
      rec.body.parentNode.removeChild(rec.body);
    }
    rec.body = null;
    rec.text = null;
  };

  /* ============================================================
   * 6. 浮动菜单
   * ============================================================ */

  /** 关掉当前菜单（无菜单时静默返回） */
  ChipTray.prototype.closeMenu = function () {
    if (this.menu && this.menu.parentNode) {
      this.menu.parentNode.removeChild(this.menu);
    }
    this.menu = null;
    this.menuSocket = null;
    this._markActiveSocket(null);
    return this;
  };

  /**
   * 在某个插座旁弹出型号选择菜单。
   * @param {string} socketId 例如 'devA:UA'
   * @returns {boolean} 插座不存在时返回 false
   */
  ChipTray.prototype.openMenu = function (socketId) {
    var rec = this.sockets[socketId];
    if (!rec) {
      return false;
    }
    this.closeMenu();
    this.menuSocket = socketId;

    var current = null;
    try {
      current = this.engine.getChip(socketId);
    } catch (err) {
      current = null;
    }

    var box = htmlEl('div', 'chip-menu');
    box.setAttribute('role', 'menu');
    box.setAttribute('data-socket', socketId);

    // —— 标题：插座名 + 脚数 + 当前状态 ——
    var head = htmlEl('div', 'chip-menu-head');
    head.appendChild(htmlEl('span', 'chip-menu-title', '插座 ' + socketId));
    head.appendChild(htmlEl('span', 'chip-menu-sub', rec.pins + ' 脚 DIP'));
    box.appendChild(head);

    if (current) {
      var cur = htmlEl('div', 'chip-menu-current');
      cur.textContent = '当前：' + current + (DESCRIPTIONS[current] ? '（' + DESCRIPTIONS[current] + '）' : '');
      box.appendChild(cur);
    } else {
      box.appendChild(htmlEl('div', 'chip-menu-current is-empty', '当前：空插座'));
    }

    // —— 型号清单 ——
    var list = htmlEl('div', 'chip-menu-list');
    var models = modelsOfPackage(rec.pins);
    if (!models.length) {
      list.appendChild(htmlEl('div', 'chip-menu-empty', '芯片库中没有 ' + rec.pins + ' 脚型号'));
    }
    for (var i = 0; i < models.length; i++) {
      var model = models[i];
      var btn = htmlEl('button', 'chip-menu-item' + (model === current ? ' is-current' : ''));
      btn.setAttribute('type', 'button');
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('data-mount', model);
      btn.appendChild(htmlEl('span', 'chip-menu-model', model));
      var desc = DESCRIPTIONS[model];
      if (desc) {
        btn.appendChild(htmlEl('span', 'chip-menu-desc', desc));
      }
      list.appendChild(btn);
    }
    box.appendChild(list);

    // —— 拔下 ——
    if (current) {
      var off = htmlEl('button', 'chip-menu-item chip-menu-remove', '拔下芯片');
      off.setAttribute('type', 'button');
      off.setAttribute('role', 'menuitem');
      off.setAttribute('data-unmount', '1');
      box.appendChild(off);
    }

    // —— 菜单内部的点击（在菜单自己身上委托，避免全局监听误伤）——
    var self = this;
    box.addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== box && !(node.getAttribute &&
             (node.getAttribute('data-mount') || node.getAttribute('data-unmount')))) {
        node = node.parentNode;
      }
      if (!node || node === box || !node.getAttribute) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      var socketIdNow = self.menuSocket;
      var mountModel = node.getAttribute('data-mount');
      var isUnmount = node.getAttribute('data-unmount');
      self.closeMenu();
      if (!socketIdNow) {
        return;
      }
      if (mountModel) {
        self.mount(socketIdNow, mountModel);
      } else if (isUnmount) {
        self.unmount(socketIdNow);
      }
    });

    // —— 定位：贴着插座下方，超出视口则翻到上方 ——
    box.style.visibility = 'hidden';
    document.body.appendChild(box);
    var anchor = rec.hit && rec.hit.getBoundingClientRect ? rec.hit.getBoundingClientRect() : null;
    var mw = box.offsetWidth;
    var mh = box.offsetHeight;
    var vw = global.innerWidth || document.documentElement.clientWidth;
    var vh = global.innerHeight || document.documentElement.clientHeight;
    var left = 8;
    var top = 8;
    if (anchor) {
      left = anchor.left + anchor.width / 2 - mw / 2;
      top = anchor.bottom + 6;
      if (top + mh > vh - 8) {
        top = anchor.top - mh - 6;          // 下方放不下就翻到上方
      }
    }
    if (left < 8) left = 8;
    if (left + mw > vw - 8) left = vw - 8 - mw;
    if (top < 8) top = 8;
    box.style.left = Math.round(left) + 'px';
    box.style.top = Math.round(top) + 'px';
    box.style.visibility = '';

    this.menu = box;
    this._markActiveSocket(socketId);
    return true;
  };

  /** 高亮当前菜单对应的插座（传 null 取消全部高亮） */
  ChipTray.prototype._markActiveSocket = function (socketId) {
    for (var k in this.sockets) {
      if (!Object.prototype.hasOwnProperty.call(this.sockets, k)) {
        continue;
      }
      var hit = this.sockets[k].hit;
      if (!hit) {
        continue;
      }
      if (k === socketId) {
        hit.classList.add('is-open');
      } else {
        hit.classList.remove('is-open');
      }
    }
  };

  /* ============================================================
   * 7. 插拔
   * ============================================================ */

  /**
   * 往插座上插芯片。型号与插座脚数不匹配时由引擎抛错，这里转成中文提示。
   * @returns {boolean} 是否插上
   */
  ChipTray.prototype.mount = function (socketId, model) {
    var rec = this.sockets[socketId];
    if (!rec) {
      this._status('未知插座：' + socketId, 'error');
      return false;
    }
    // P5b（2026-10-30 审查遗留项）：引擎对已占插座改为抛错（不再静默换芯，
    // 避免时序芯片内部状态被无提示清零）。本层保持原有「点型号即更换」的体验：
    // 占用时显式先拔后插；抛错统一转中文提示。
    var occupied = null;
    try {
      occupied = this.engine.getChip(socketId);
    } catch (err) {
      occupied = null;
    }
    try {
      if (occupied) {
        this.engine.unmountChip(socketId);
      }
      this.engine.mountChip(socketId, model);
    } catch (err) {
      this._status('插入失败：' + (err && err.message ? err.message : '未知错误'), 'error');
      return false;
    }
    this._paintChip(socketId, model);
    this._afterChange();
    var desc = DESCRIPTIONS[model];
    this._status('已在 ' + socketId + ' 插上 ' + model + (desc ? '（' + desc + '）' : ''), 'info');
    return true;
  };

  /** 拔下插座上的芯片 */
  ChipTray.prototype.unmount = function (socketId) {
    var rec = this.sockets[socketId];
    if (!rec) {
      return false;
    }
    var model = null;
    try {
      model = this.engine.getChip(socketId);
    } catch (err) {
      model = null;
    }
    if (!model) {
      this._status(socketId + ' 上本来就没有芯片', 'warn');
      return false;
    }
    try {
      this.engine.unmountChip(socketId);
    } catch (err) {
      this._status('拔下失败：' + (err && err.message ? err.message : '未知错误'), 'error');
      return false;
    }
    this._clearChip(socketId);
    this._afterChange();
    this._status('已从 ' + socketId + ' 拔下 ' + model, 'info');
    return true;
  };

  /** 点击后：立刻推进一次仿真并刷新面板，不等下一帧 */
  ChipTray.prototype._afterChange = function () {
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var state = null;
    try {
      state = this.engine.step(now);
    } catch (err) {
      state = null;
    }
    if (!state) {
      try {
        state = this.engine.getState();
      } catch (err2) {
        state = null;
      }
    }
    this.syncVisuals();
    if (this.onChange) {
      this.onChange(state);
    }
  };

  /* ============================================================
   * 8. 视觉同步
   * ============================================================ */

  /**
   * 把引擎的「插座 -> 型号」状态同步成面板上的芯片本体。
   * 供 app.js 的统一刷新入口调用（导入工程后也必须调用，
   * 否则会出现「引擎里有芯片、面板上看不见」的状态错位）。
   */
  ChipTray.prototype.syncVisuals = function () {
    var chips = {};
    try {
      chips = this.engine.getChips ? this.engine.getChips() : {};
    } catch (err) {
      chips = {};
    }
    for (var id in this.sockets) {
      if (!Object.prototype.hasOwnProperty.call(this.sockets, id)) {
        continue;
      }
      var rec = this.sockets[id];
      var model = chips[id] || null;
      if (!model) {
        if (rec.body) {
          this._clearChip(id);
        }
        if (rec.hit) {
          rec.hit.setAttribute('aria-pressed', 'false');
          rec.hit.classList.remove('is-loaded');
        }
        continue;
      }
      if (!rec.body || !rec.text || rec.text.textContent !== model) {
        this._paintChip(id, model);
      }
      if (rec.hit) {
        rec.hit.setAttribute('aria-pressed', 'true');
        rec.hit.classList.add('is-loaded');
      }
    }
    return this;
  };

  /* ============================================================
   * 9. 事件
   * ============================================================ */

  ChipTray.prototype._bindEvents = function () {
    var self = this;
    if (!this._host) {
      return;
    }

    /** 点击插座：开/关菜单 */
    var onHostClick = function (e) {
      var target = e.target;
      var socketId = target && target.getAttribute ? target.getAttribute('data-socket') : null;
      if (!socketId) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();       // 不要冒泡到飞线层的「空白处取消选中」
      if (self.menuSocket === socketId) {
        self.closeMenu();
      } else {
        self.openMenu(socketId);
      }
    };

    /** 键盘：Enter / 空格等同点击 */
    var onHostKeyDown = function (e) {
      var key = e.key || '';
      if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') {
        return;
      }
      var target = e.target;
      var socketId = target && target.getAttribute ? target.getAttribute('data-socket') : null;
      if (!socketId) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (self.menuSocket === socketId) {
        self.closeMenu();
      } else {
        self.openMenu(socketId);
      }
    };

    this._host.addEventListener('click', onHostClick);
    this._host.addEventListener('keydown', onHostKeyDown);
    this._bound.push({ target: this._host, type: 'click', fn: onHostClick });
    this._bound.push({ target: this._host, type: 'keydown', fn: onHostKeyDown });

    /** 点菜单外部关闭（捕获阶段，保证先于其他处理） */
    var onDocClick = function (e) {
      if (!self.menu) {
        return;
      }
      if (self.menu.contains && self.menu.contains(e.target)) {
        return;
      }
      // 点在插座上由 onHostClick 处理（可能是想切到另一个插座），这里不抢
      var t = e.target;
      var socketId = t && t.getAttribute ? t.getAttribute('data-socket') : null;
      if (socketId) {
        return;
      }
      self.closeMenu();
    };

    /** Esc 关闭 */
    var onKeyDown = function (e) {
      if (!self.menu) {
        return;
      }
      if ((e.key || '') === 'Escape') {
        self.closeMenu();
      }
    };

    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeyDown);
    this._bound.push({ target: document, type: 'click', fn: onDocClick, capture: true });
    this._bound.push({ target: document, type: 'keydown', fn: onKeyDown });
  };

  /* ============================================================
   * 10. 收尾与调试
   * ============================================================ */

  ChipTray.prototype._status = function (text, level) {
    if (this.hud && this.hud.setStatus) {
      this.hud.setStatus(text, level || 'info');
    }
  };

  /** 供自测/调试：插座坐标与当前芯片 */
  ChipTray.prototype.getSnapshot = function () {
    var chips = {};
    try {
      chips = this.engine.getChips ? this.engine.getChips() : {};
    } catch (err) {
      chips = {};
    }
    var out = { sockets: {}, chips: chips, menuSocket: this.menuSocket };
    for (var id in this.sockets) {
      if (!Object.prototype.hasOwnProperty.call(this.sockets, id)) {
        continue;
      }
      var rec = this.sockets[id];
      out.sockets[id] = {
        x: rec.x, y: rec.y, w: rec.w, h: rec.h, pins: rec.pins,
        model: chips[id] || null,
        painted: !!rec.body
      };
    }
    return out;
  };

  /** 解绑事件、移除图形与菜单 */
  ChipTray.prototype.destroy = function () {
    this.closeMenu();
    for (var i = 0; i < this._bound.length; i++) {
      var b = this._bound[i];
      b.target.removeEventListener(b.type, b.fn, !!b.capture);
    }
    this._bound.length = 0;
    if (this._host && this._host.parentNode) {
      this._host.parentNode.removeChild(this._host);
    }
    this._host = null;
  };

  ChipTray.AREAS = AREAS;
  ChipTray.MODULE_ORIGINS = MODULE_ORIGINS;
  ChipTray.DESCRIPTIONS = DESCRIPTIONS;

  DLab.ChipTray = ChipTray;
})(typeof globalThis !== 'undefined' ? globalThis : this);

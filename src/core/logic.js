// src/core/logic.js
// 4 态逻辑原语与并查集网表（经典脚本，浏览器 / Node 通用，挂到全局命名空间 DLab）
(function (global) {
  'use strict';

  var DLab = (global.DLab = global.DLab || {});

  /* ============================================================
   * 1. 四态电平常量与基本判定
   * ============================================================ */

  var L0 = '0';   // 强低
  var L1 = '1';   // 强高
  var LZ = 'Z';   // 高阻 / 悬空
  var LX = 'X';   // 冲突（强 1 与强 0 短接）或不可知

  var LEVELS = [L0, L1, LZ, LX];

  /** 是否为合法四态电平 */
  function isLevel(v) {
    return v === L0 || v === L1 || v === LZ || v === LX;
  }

  /** 是否为强驱动电平（只有 0 和 1 才算驱动源） */
  function isStrong(v) {
    return v === L0 || v === L1;
  }

  /** 把任意值规范成合法电平，非法值一律当 'Z'（悬空） */
  function norm(v) {
    return isLevel(v) ? v : LZ;
  }

  /**
   * 合并同一连通网上的所有电平（核心求值规则）。
   *   1) 有强驱动 -> 取驱动值；
   *   2) 强 1 与强 0 同时存在 -> 'X'（短路冲突）；
   *   3) 存在 'X'（上一级传下来的未知）-> 'X'；
   *   4) 完全没有驱动 -> 'Z'。
   * @param {string[]} levels 该网上所有驱动源的电平
   * @returns {'0'|'1'|'Z'|'X'}
   */
  function resolve(levels) {
    var has0 = false;
    var has1 = false;
    var hasX = false;
    if (!levels) return LZ;
    for (var i = 0; i < levels.length; i++) {
      var v = levels[i];
      if (v === L0) has0 = true;
      else if (v === L1) has1 = true;
      else if (v === LX) hasX = true;
      // 'Z' 与非法值不贡献驱动
    }
    if (has0 && has1) return LX;
    if (hasX) return LX;
    if (has1) return L1;
    if (has0) return L0;
    return LZ;
  }

  /* ============================================================
   * 2. TTL 输入归一化
   *    TTL 输入端悬空在电气上等效于高电平，因此 'Z' 按 '1' 处理；
   *    但逻辑笔 / getState().jacks 仍然显示 'Z'（保留诊断信息）。
   *    可通过 setTTL(false) 或逐次传参关掉这一行为（CMOS 语义下悬空视为未知）。
   * ============================================================ */

  var TTL_DEFAULT = true;

  /** 设置全局默认的 TTL 悬空语义 */
  function setTTL(on) {
    TTL_DEFAULT = !!on;
  }

  /** 读取全局默认的 TTL 悬空语义 */
  function getTTL() {
    return TTL_DEFAULT;
  }

  /**
   * 把四态电平归一化成二值逻辑输入。
   * @param {'0'|'1'|'Z'|'X'} level
   * @param {boolean} [isTTL] 省略时用全局默认
   * @returns {'0'|'1'|'X'}
   */
  function toBin(level, isTTL) {
    var ttl = (isTTL === undefined || isTTL === null) ? TTL_DEFAULT : !!isTTL;
    if (level === L0) return L0;
    if (level === L1) return L1;
    if (level === LZ) return ttl ? L1 : LX;
    return LX;
  }

  /* ============================================================
   * 3. 门电路原语
   *    所有门函数接收二值电平（'0' | '1' | 'X'），返回 '0' | '1' | 'X'。
   * ============================================================ */

  function gNot(a) {
    if (a === L0) return L1;
    if (a === L1) return L0;
    return LX;
  }

  function gBuf(a) {
    return a === L0 ? L0 : (a === L1 ? L1 : LX);
  }

  function gAnd(a, b) {
    if (a === L0 || b === L0) return L0;
    if (a === L1 && b === L1) return L1;
    return LX;
  }

  function gOr(a, b) {
    if (a === L1 || b === L1) return L1;
    if (a === L0 && b === L0) return L0;
    return LX;
  }

  function gNand(a, b) {
    return gNot(gAnd(a, b));
  }

  function gNor(a, b) {
    return gNot(gOr(a, b));
  }

  function gXor(a, b) {
    if (a === LX || b === LX) return LX;
    return a === b ? L0 : L1;
  }

  function gXnor(a, b) {
    return gNot(gXor(a, b));
  }

  function gAndN() {
    var r = L1;
    for (var i = 0; i < arguments.length; i++) r = gAnd(r, arguments[i]);
    return r;
  }

  function gOrN() {
    var r = L0;
    for (var i = 0; i < arguments.length; i++) r = gOr(r, arguments[i]);
    return r;
  }

  function gNandN() {
    return gNot(gAndN.apply(null, arguments));
  }

  function gNorN() {
    return gNot(gOrN.apply(null, arguments));
  }

  /** 门函数表：名字 -> 二值实现 */
  var GATE_FNS = {
    not: gNot,
    buf: gBuf,
    and: gAnd,
    or: gOr,
    nand: gNand,
    nor: gNor,
    xor: gXor,
    xnor: gXnor,
    and3: gAndN,
    or3: gOrN,
    nand3: gNandN,
    nor3: gNorN
  };

  /** 各门的输入个数（便于 UI / 校验） */
  var GATE_ARITY = {
    not: 1, buf: 1,
    and: 2, or: 2, nand: 2, nor: 2, xor: 2, xnor: 2,
    and3: 3, or3: 3, nand3: 3, nor3: 3
  };

  /**
   * 直接用四态电平求一个门（自动做 TTL 归一化）。
   * @param {string} name 门名，见 GATE_FNS
   * @param {string[]} levels 输入电平
   * @param {boolean} [isTTL] 覆盖全局 TTL 设置
   * @returns {'0'|'1'|'X'}
   */
  function evalGate(name, levels, isTTL) {
    var fn = GATE_FNS[name];
    if (!fn) throw new Error('未知的门类型：' + name);
    var args = [];
    for (var i = 0; i < levels.length; i++) args.push(toBin(norm(levels[i]), isTTL));
    return fn.apply(null, args);
  }

  /**
   * 生成一个绑定好 TTL 语义的门函数，供芯片库复用。
   * @param {string} name
   * @param {boolean} [isTTL]
   * @returns {function(string[]): ('0'|'1'|'X')}
   */
  function makeGate(name, isTTL) {
    return function (levels) { return evalGate(name, levels, isTTL); };
  }

  /* ============================================================
   * 4. 网表：并查集维护连通分量
   * ============================================================ */

  /**
   * @param {object} [options]
   * @param {object} [options.jacks] 插孔元数据表：id -> { id, fixedNet, kind }
   * @param {string[]} [options.order] 稳定的插孔顺序（决定 net 编号）
   */
  function Netlist(options) {
    options = options || {};
    this._meta = Object.create(null);    // id -> { id, fixedNet, kind }
    this._order = [];                    // 稳定顺序
    this._wires = [];                    // [{ id, from, to, color }]
    this._wiresById = Object.create(null);
    this._parent = Object.create(null);
    this._rank = Object.create(null);
    this._netsCache = null;
    this._wireSeq = 0;

    if (options.jacks) {
      for (var id in options.jacks) {
        if (Object.prototype.hasOwnProperty.call(options.jacks, id)) {
          this.register(options.jacks[id]);
        }
      }
    }
    if (options.order && options.order.length) {
      // 按调用方给出的稳定顺序重排
      var seen = Object.create(null);
      var ordered = [];
      for (var i = 0; i < options.order.length; i++) {
        var oid = options.order[i];
        if (this._meta[oid] && !seen[oid]) { seen[oid] = true; ordered.push(oid); }
      }
      for (var k = 0; k < this._order.length; k++) {
        if (!seen[this._order[k]]) ordered.push(this._order[k]);
      }
      this._order = ordered;
    }
  }

  /** 固定网络用的虚拟节点前缀（VCC / GND 的板内硬连接） */
  var FIXED_PREFIX = '__fixed__:';

  /** 注册一个插孔（幂等） */
  Netlist.prototype.register = function (jack) {
    if (!jack) return null;
    var id = jack.id;
    if (!id) return null;
    if (!this._meta[id]) {
      this._meta[id] = {
        id: id,
        fixedNet: jack.fixedNet || null,
        kind: jack.kind || 'passive'
      };
      this._order.push(id);
      this._ensureNode(id);
      if (jack.fixedNet) {
        var vnode = FIXED_PREFIX + jack.fixedNet;
        this._ensureNode(vnode);
        this._union(id, vnode);
      }
      this._netsCache = null;
    }
    return this._meta[id];
  };

  /** 是否已注册 */
  Netlist.prototype.has = function (id) {
    return !!this._meta[id];
  };

  /** 取插孔元数据 */
  Netlist.prototype.meta = function (id) {
    return this._meta[id] || null;
  };

  Netlist.prototype._ensureNode = function (id) {
    if (!(id in this._parent)) {
      this._parent[id] = id;
      this._rank[id] = 0;
    }
  };

  /** 并查集：查找根节点（带路径压缩） */
  Netlist.prototype.find = function (id) {
    if (!(id in this._parent)) {
      // 未知 id：防御性地当成孤立节点，不抛错
      this._ensureNode(id);
    }
    var root = id;
    while (this._parent[root] !== root) root = this._parent[root];
    // 路径压缩
    var cur = id;
    while (this._parent[cur] !== cur) {
      var nxt = this._parent[cur];
      this._parent[cur] = root;
      cur = nxt;
    }
    return root;
  };

  /** 并查集：按秩合并 */
  Netlist.prototype._union = function (a, b) {
    var ra = this.find(a);
    var rb = this.find(b);
    if (ra === rb) return;
    if (this._rank[ra] < this._rank[rb]) {
      this._parent[ra] = rb;
    } else if (this._rank[ra] > this._rank[rb]) {
      this._parent[rb] = ra;
    } else {
      this._parent[rb] = ra;
      this._rank[ra] += 1;
    }
  };

  /**
   * 添加一条导线。
   * 支持两种调用方式：
   *   addWire({ id, from, to, color })
   *   addWire(from, to)
   * @returns {{id:string, from:string, to:string, color:string}}
   */
  Netlist.prototype.addWire = function (a, b) {
    var rec;
    if (a && typeof a === 'object') {
      rec = {
        id: a.id || ('w' + (++this._wireSeq)),
        from: a.from,
        to: a.to,
        color: a.color || null
      };
    } else {
      rec = { id: 'w' + (++this._wireSeq), from: a, to: b, color: null };
    }
    if (!rec.from || !rec.to) throw new Error('导线缺少 from / to');
    if (rec.from === rec.to) throw new Error('导线两端不能是同一个插孔：' + rec.from);
    if (this._wiresById[rec.id]) throw new Error('导线 id 重复：' + rec.id);

    this.register({ id: rec.from });
    this.register({ id: rec.to });
    this._wires.push(rec);
    this._wiresById[rec.id] = rec;
    this._union(rec.from, rec.to);
    this._netsCache = null;
    return rec;
  };

  /**
   * 删除一条导线（按 id 或导线对象）。
   * 删除后整体重建并查集（导线数量很少，重建成本可忽略，且能保证拆分正确）。
   * @returns {boolean} 是否真的删掉了一条
   */
  Netlist.prototype.removeWire = function (wireOrId) {
    var id = (wireOrId && typeof wireOrId === 'object') ? wireOrId.id : wireOrId;
    if (!id || !this._wiresById[id]) return false;
    var rec = this._wiresById[id];
    delete this._wiresById[id];
    var idx = this._wires.indexOf(rec);
    if (idx >= 0) this._wires.splice(idx, 1);
    this._rebuild();
    return true;
  };

  /** 清空所有导线（保留插孔与 fixedNet） */
  Netlist.prototype.clearWires = function () {
    this._wires.length = 0;
    this._wiresById = Object.create(null);
    this._rebuild();
  };

  /** 重建并查集：从零开始，先把 fixedNet 预合并，再逐条合并导线 */
  Netlist.prototype._rebuild = function () {
    this._parent = Object.create(null);
    this._rank = Object.create(null);
    for (var i = 0; i < this._order.length; i++) {
      var id = this._order[i];
      this._ensureNode(id);
      var fn = this._meta[id] && this._meta[id].fixedNet;
      if (fn) {
        var vnode = FIXED_PREFIX + fn;
        this._ensureNode(vnode);
        this._union(id, vnode);
      }
    }
    for (var w = 0; w < this._wires.length; w++) {
      this._union(this._wires[w].from, this._wires[w].to);
    }
    this._netsCache = null;
  };

  /** 全部导线（返回副本数组，元素为内部记录的浅拷贝） */
  Netlist.prototype.getWires = function () {
    var out = [];
    for (var i = 0; i < this._wires.length; i++) {
      var w = this._wires[i];
      out.push({ id: w.id, from: w.from, to: w.to, color: w.color });
    }
    return out;
  };

  /**
   * 构建全部连通分量（结果缓存，导线变化后失效）。
   * @returns {Array<{id:string, jacks:string[], fixedNets:string[], root:string}>}
   */
  Netlist.prototype.getNets = function () {
    if (this._netsCache) return this._netsCache;
    var rootToNet = Object.create(null);
    var list = [];
    for (var i = 0; i < this._order.length; i++) {
      var id = this._order[i];
      if (!this._meta[id]) continue;
      var root = this.find(id);
      var net = rootToNet[root];
      if (!net) {
        net = { id: 'net' + (list.length + 1), jacks: [], fixedNets: [], root: root };
        rootToNet[root] = net;
        list.push(net);
      }
      net.jacks.push(id);
      var fn = this._meta[id].fixedNet;
      if (fn && net.fixedNets.indexOf(fn) < 0) net.fixedNets.push(fn);
    }
    this._netsCache = list;
    return list;
  };

  /**
   * 取某个插孔所在的网。
   * @returns {{id:string, jacks:string[], fixedNets:string[], root:string}|null}
   */
  Netlist.prototype.getNet = function (id) {
    if (!this._meta[id]) return null;
    var root = this.find(id);
    var nets = this.getNets();
    for (var i = 0; i < nets.length; i++) {
      if (nets[i].root === root) return nets[i];
    }
    return null;
  };

  /** 两个插孔是否在同一网（被导线直接或间接连通） */
  Netlist.prototype.connected = function (a, b) {
    if (!this._meta[a] || !this._meta[b]) return false;
    return this.find(a) === this.find(b);
  };

  /* ============================================================
   * 5. 导出
   * ============================================================ */

  var Logic = {
    L0: L0, L1: L1, LZ: LZ, LX: LX,
    LEVELS: LEVELS,
    isLevel: isLevel,
    isStrong: isStrong,
    norm: norm,
    resolve: resolve,
    toBin: toBin,
    setTTL: setTTL,
    getTTL: getTTL,
    GATE_FNS: GATE_FNS,
    GATE_ARITY: GATE_ARITY,
    evalGate: evalGate,
    makeGate: makeGate,
    // 门函数直接暴露（接收二值输入）
    not: gNot, buf: gBuf, and: gAnd, or: gOr, nand: gNand, nor: gNor,
    xor: gXor, xnor: gXnor,
    and3: gAndN, or3: gOrN, nand3: gNandN, nor3: gNorN,
    Netlist: Netlist
  };

  DLab.Logic = Logic;

})(typeof globalThis !== 'undefined' ? globalThis : this);

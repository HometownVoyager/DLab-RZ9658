// src/ui/wireLayer.js
// 飞线覆盖层：在 #wire-layer 里绘制三次贝塞尔杜邦线、插孔命中区与拖拽预览曲线。
// 只依赖 DLab.geometry.JACKS 的坐标，不持有任何接线状态（状态在 Interaction 里）。
(function (global) {
  'use strict';
  var DLab = (global.DLab = global.DLab || {});
  var NS = 'http://www.w3.org/2000/svg';

  // —— 契约常量（CONTRACTS.md 第 7 节）——
  var WIRE_WIDTH = 3.2;          // 飞线线宽
  var SHADOW_WIDTH = 5.2;        // 阴影线宽
  var SHADOW_OPACITY = 0.25;     // 阴影不透明度
  var SHADOW_DY = 2;             // 阴影向下偏移（px，viewBox 单位）
  var HIT_RADIUS = 14;           // 插孔命中半径
  var SAG_MAX = 90;              // 最大下垂
  var SAG_RATIO = 0.28;          // 下垂比例
  var DEFAULT_COLOR = '#ef4444';
  var PREVIEW_COLOR = '#2563eb';

  var SVG_NS = NS;

  /** 创建 SVG 元素并设置属性 */
  function el(tag, attrs) {
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

  /** 计算下垂量：sag = min(90, dist * 0.28) */
  function calcSag(x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    var dist = Math.sqrt(dx * dx + dy * dy);
    return Math.min(SAG_MAX, dist * SAG_RATIO);
  }

  /** 生成契约规定的贝塞尔路径：M x1 y1 C x1 (y1+sag) x2 (y2+sag) x2 y2 */
  function buildPath(x1, y1, x2, y2) {
    var sag = calcSag(x1, y1, x2, y2);
    return 'M ' + round(x1) + ' ' + round(y1) +
      ' C ' + round(x1) + ' ' + round(y1 + sag) +
      ' ' + round(x2) + ' ' + round(y2 + sag) +
      ' ' + round(x2) + ' ' + round(y2);
  }

  /** 保留两位小数，避免 DOM 上出现超长浮点串 */
  function round(n) {
    return Math.round(n * 100) / 100;
  }

  /** 校验颜色值，非法时回落默认色 */
  function safeColor(color) {
    if (typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color.trim())) {
      return color.trim();
    }
    return DEFAULT_COLOR;
  }

  // —— WireLayer ——
  function WireLayer(svgEl, geometry) {
    if (!svgEl) {
      throw new Error('WireLayer：缺少 #wire-layer 元素');
    }
    this.svg = svgEl;
    this.geometry = geometry || (DLab.geometry || { JACKS: {}, VIEWBOX: { width: 1800, height: 1380 } });

    // 覆盖层本身不吃事件，只有命中区与飞线单独开启 pointer-events
    this.svg.style.pointerEvents = 'none';

    // 三层结构：阴影在下，飞线在中，命中区在上
    this.shadowGroup = el('g', { id: 'wire-shadow' });
    this.pathGroup = el('g', { id: 'wire-paths' });
    this.hitGroup = el('g', { id: 'jack-hits' });
    // 预览层（拖拽中的半透明曲线）不属于契约三层，单独挂在最上方
    this.previewGroup = el('g', { id: 'wire-preview', 'pointer-events': 'none' });

    // 清空可能存在的旧内容（重复构造时保持幂等）
    while (this.svg.firstChild) {
      this.svg.removeChild(this.svg.firstChild);
    }
    this.svg.appendChild(this.shadowGroup);
    this.svg.appendChild(this.pathGroup);
    this.svg.appendChild(this.hitGroup);
    this.svg.appendChild(this.previewGroup);

    // 索引：wireId -> { shadow, path }；jackId -> 命中圆
    this.wireNodes = Object.create(null);
    this.jackNodes = Object.create(null);
    this.hoverJack = null;
    this.hoverWire = null;
    this.selectedJack = null;
    this.selectedWire = null;
    this.visible = true;
    this.wires = [];

    // 第四阶段：避让路由结果
    //   this.routes = { wireId: {id, d, points, adjusted, cost} }
    //   this.wirePolylines = { wireId: [{x,y}, ...] }  渲染后的折线（命中测试用）
    this.routes = Object.create(null);
    this.wirePolylines = Object.create(null);

    // AI 助教高亮的插孔（契约 §3.6 setJackAlert）
    this.alertJacks = Object.create(null);

    this._buildJackHits();
  }

  /** 构建全部插孔的命中圆（一次性，之后只改属性） */
  WireLayer.prototype._buildJackHits = function () {
    var jacks = (this.geometry && this.geometry.JACKS) || {};
    var order = (this.geometry && this.geometry.JACK_ORDER) || null;
    var ids = order && order.length ? order : Object.keys(jacks);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var jack = jacks[id];
      if (!jack || typeof jack.x !== 'number' || typeof jack.y !== 'number') {
        continue;
      }
      var circle = el('circle', {
        cx: jack.x,
        cy: jack.y,
        r: HIT_RADIUS,
        fill: 'transparent',
        'pointer-events': 'all',
        'data-jack': id,
        'class': 'jack-hit'
      });
      this.jackNodes[id] = circle;
      frag.appendChild(circle);
    }
    this.hitGroup.appendChild(frag);
  };

  /** 取插孔坐标，未知插孔返回 null */
  WireLayer.prototype.getJackPos = function (jackId) {
    var jacks = (this.geometry && this.geometry.JACKS) || {};
    var jack = jacks[jackId];
    if (!jack || typeof jack.x !== 'number' || typeof jack.y !== 'number') {
      return null;
    }
    return { x: jack.x, y: jack.y };
  };

  /** 清空全部飞线节点（命中区保留） */
  WireLayer.prototype._clearWires = function () {
    this.shadowGroup.textContent = '';
    this.pathGroup.textContent = '';
    this.wireNodes = Object.create(null);
    this.hoverWire = null;
    this.selectedWire = null;
  };

  /**
   * 重新计算某根线的路径。
   * 优先用避让路由给出的 d（DLab.WireRouting 存在时），
   * 模块缺失时自动回落旧公式 buildPath，保证不白屏。
   * @param {Object} nodes 该线的 DOM 节点
   * @param {string} wireId 导线 id
   * @param {{x:number,y:number}} from 起点坐标
   * @param {{x:number,y:number}} to   终点坐标
   * @param {string} fallbackD 没有路由结果时的兜底路径
   */
  WireLayer.prototype._applyPath = function (nodes, wireId, from, to, fallbackD) {
    var routed = this.routes && this.routes[wireId];
    var d = (routed && routed.d) ? routed.d : fallbackD;
    nodes.path.setAttribute('d', d);
    nodes.shadow.setAttribute('d', d);
  };

  /**
   * 取避让路由模块（可能不存在）。
   * @returns {Object|null} DLab.WireRouting 或 null
   */
  WireLayer.prototype._routing = function () {
    return (typeof DLab !== 'undefined' && DLab.WireRouting) ? DLab.WireRouting : null;
  };

  /**
   * 渲染全部导线。
   * 采用复用策略：同 id 的节点只更新属性，新增/删除的才动 DOM，避免每次刷新重建。
   * @param {Array<{id:string, from:string, to:string, color:string}>} wires
   */
  WireLayer.prototype.render = function (wires) {
    var list = Array.isArray(wires) ? wires : [];
    var seen = Object.create(null);
    var i, wire, id;

    // 0. 避让路由（契约 §3.6）：一次性算出所有导线的路径。
    //    DLab.WireRouting 缺失时自动回落旧公式 buildPath。
    var routing = this._routing();
    var routes = Object.create(null);
    var polylines = Object.create(null);
    if (routing && typeof routing.routeAll === 'function') {
      try {
        var result = routing.routeAll(list, this.geometry);
        routes = result.byId || Object.create(null);
      } catch (err) {
        // 路由出错时不能影响渲染，退回旧公式
        routes = Object.create(null);
      }
    }
    for (i = 0; i < list.length; i++) {
      wire = list[i];
      if (!wire || !wire.id) {
        continue;
      }
      id = String(wire.id);
      var routed = routes[id];
      if (routed && routed.points && routed.points.length) {
        polylines[id] = routed.points;
      }
    }
    this.routes = routes;
    this.wirePolylines = polylines;

    // 1. 删除已不存在的导线
    for (id in this.wireNodes) {
      if (!Object.prototype.hasOwnProperty.call(this.wireNodes, id)) {
        continue;
      }
      seen[id] = false;
    }

    for (i = 0; i < list.length; i++) {
      wire = list[i];
      if (!wire || !wire.id) {
        continue;
      }
      id = String(wire.id);
      var from = this.getJackPos(wire.from);
      var to = this.getJackPos(wire.to);
      if (!from || !to) {
        // 端点插孔不存在：跳过绘制（数据脏时不炸掉整个渲染）
        continue;
      }
      seen[id] = true;
      var nodes = this.wireNodes[id];
      if (!nodes) {
        nodes = {
          shadow: el('path', {
            'class': 'wire-shadow-line',
            fill: 'none',
            stroke: '#000',
            'stroke-width': SHADOW_WIDTH,
            'stroke-linecap': 'round',
            'stroke-opacity': SHADOW_OPACITY,
            'pointer-events': 'none'
          }),
          path: el('path', {
            'class': 'wire-line',
            fill: 'none',
            stroke: safeColor(wire.color),
            'stroke-width': WIRE_WIDTH,
            'stroke-linecap': 'round',
            'pointer-events': 'stroke',
            'data-wire': id
          })
        };
        this.wireNodes[id] = nodes;
      }
      this._applyPath(nodes, id, from, to, buildPath(from.x, from.y, to.x, to.y));
      nodes.shadow.setAttribute('transform', 'translate(0,' + SHADOW_DY + ')');
      nodes.path.setAttribute('stroke', safeColor(wire.color));
      // 节点顺序：先保证在组里，之后统一按 wires 顺序调整层级
      if (nodes.shadow.parentNode !== this.shadowGroup) {
        this.shadowGroup.appendChild(nodes.shadow);
      }
      if (nodes.path.parentNode !== this.pathGroup) {
        this.pathGroup.appendChild(nodes.path);
      }
    }

    // 2. 清理多余节点
    for (id in this.wireNodes) {
      if (!Object.prototype.hasOwnProperty.call(this.wireNodes, id)) {
        continue;
      }
      if (!seen[id]) {
        var stale = this.wireNodes[id];
        if (stale.shadow.parentNode) {
          stale.shadow.parentNode.removeChild(stale.shadow);
        }
        if (stale.path.parentNode) {
          stale.path.parentNode.removeChild(stale.path);
        }
        delete this.wireNodes[id];
      }
    }

    // 3. 层级：新线压在旧线上，保持“最后接的线在上”
    for (i = 0; i < list.length; i++) {
      wire = list[i];
      if (!wire || !wire.id) {
        continue;
      }
      var n = this.wireNodes[String(wire.id)];
      if (!n) {
        continue;
      }
      this.shadowGroup.appendChild(n.shadow);
      this.pathGroup.appendChild(n.path);
    }

    this.wires = list.slice();
    this._syncWireVisual();
    this.setVisible(this.visible);
  };

  /** 根据 hover/selected 状态刷新线宽、颜色与命中区状态 */
  WireLayer.prototype._syncWireVisual = function () {
    var id;
    for (id in this.wireNodes) {
      if (!Object.prototype.hasOwnProperty.call(this.wireNodes, id)) {
        continue;
      }
      var nodes = this.wireNodes[id];
      var isHover = this.hoverWire === id;
      var isSelected = this.selectedWire === id;
      var width = WIRE_WIDTH;
      if (isHover) {
        width = 5;
      } else if (isSelected) {
        width = 4.4;
      }
      nodes.path.setAttribute('stroke-width', String(width));
      nodes.shadow.setAttribute('stroke-width', String(isHover ? 7 : SHADOW_WIDTH));
      nodes.path.classList.toggle('is-hover', isHover);
      nodes.path.classList.toggle('is-selected', isSelected);
      nodes.shadow.classList.toggle('is-hover', isHover);
    }
    this._syncJackVisual();
  };

  /** 刷新插孔命中区的 hover/选中/端点高亮 */
  WireLayer.prototype._syncJackVisual = function () {
    var highlight = Object.create(null);
    // 悬停导线的两端孔同时高亮
    if (this.hoverWire) {
      for (var i = 0; i < this.wires.length; i++) {
        if (String(this.wires[i].id) === this.hoverWire) {
          highlight[this.wires[i].from] = 'endpoint';
          highlight[this.wires[i].to] = 'endpoint';
          break;
        }
      }
    }
    if (this.selectedWire) {
      for (var j = 0; j < this.wires.length; j++) {
        if (String(this.wires[j].id) === this.selectedWire) {
          highlight[this.wires[j].from] = 'endpoint';
          highlight[this.wires[j].to] = 'endpoint';
          break;
        }
      }
    }

    for (var jackId in this.jackNodes) {
      if (!Object.prototype.hasOwnProperty.call(this.jackNodes, jackId)) {
        continue;
      }
      var circle = this.jackNodes[jackId];
      var isHover = this.hoverJack === jackId;
      var isStart = this.selectedJack === jackId;
      var isEnd = highlight[jackId] === 'endpoint';
      circle.setAttribute('r', String(isHover ? 18 : HIT_RADIUS));
      circle.classList.toggle('is-hover', isHover);
      circle.classList.toggle('is-start', isStart);
      circle.classList.toggle('is-endpoint', isEnd && !isStart && !isHover);
    }
  };

  /** 高亮单个插孔 */
  WireLayer.prototype.setJackHover = function (jackId, on) {
    var id = jackId ? String(jackId) : null;
    if (on) {
      this.hoverJack = id;
    } else if (this.hoverJack === id) {
      this.hoverJack = null;
    }
    this._syncJackVisual();
  };

  /** 高亮单根导线（含两端插孔） */
  WireLayer.prototype.setWireHover = function (wireId, on) {
    var id = wireId ? String(wireId) : null;
    if (on) {
      this.hoverWire = id;
    } else if (this.hoverWire === id) {
      this.hoverWire = null;
    }
    this._syncWireVisual();
  };

  /** 选中态（null 取消） */
  WireLayer.prototype.setSelectedWire = function (wireId) {
    this.selectedWire = wireId ? String(wireId) : null;
    this._syncWireVisual();
  };

  /** 连线起点态（null 取消） */
  WireLayer.prototype.setSelectedJack = function (jackId) {
    this.selectedJack = jackId ? String(jackId) : null;
    this._syncJackVisual();
  };

  /**
   * AI 助教 / 审查结果用的高亮：给指定插孔加 is-alert 类。
   * @param {Array<string>|null} jackIds 插孔 id 数组；null 或 [] 表示清除
   */
  WireLayer.prototype.setJackAlert = function (jackIds) {
    var next = Object.create(null);
    if (Array.isArray(jackIds)) {
      for (var i = 0; i < jackIds.length; i++) {
        if (jackIds[i]) {
          next[String(jackIds[i])] = true;
        }
      }
    }
    var changed = false;
    for (var id in this.jackNodes) {
      if (!Object.prototype.hasOwnProperty.call(this.jackNodes, id)) {
        continue;
      }
      var want = !!next[id];
      var had = !!this.alertJacks[id];
      if (want !== had) {
        changed = true;
      }
      this.jackNodes[id].classList.toggle('is-alert', want);
    }
    this.alertJacks = next;
    return changed;
  };

  /**
   * 拖拽预览曲线：从起点插孔画到鼠标位置。
   * fromJackId 为 null 时清除预览。
   */
  WireLayer.prototype.setPreview = function (fromJackId, clientX, clientY) {
    if (!fromJackId) {
      this.previewGroup.textContent = '';
      this._previewFrom = null;
      return;
    }
    var from = this.getJackPos(fromJackId);
    if (!from) {
      this.previewGroup.textContent = '';
      return;
    }
    var point = this.screenToSvg(clientX, clientY);

    // 契约 §3.6：预览线也走避让 —— 把「起点→鼠标」当成一根临时线，
    // 障碍 = 现有导线（与 routeAll 同一套代价函数与候选顺序）。
    var d = buildPath(from.x, from.y, point.x, point.y);
    var routing = this._routing();
    if (routing && typeof routing.routePreview === 'function') {
      try {
        var obstacles = [];
        for (var oid in this.wirePolylines) {
          if (Object.prototype.hasOwnProperty.call(this.wirePolylines, oid)) {
            obstacles.push(this.wirePolylines[oid]);
          }
        }
        var preview = routing.routePreview(
          { x: from.x, y: from.y },
          { x: point.x, y: point.y },
          obstacles,
          this.geometry,
          { excludeJackIds: [String(fromJackId)] }
        );
        if (preview && preview.d) {
          d = preview.d;
        }
      } catch (err) {
        // 路由失败就用旧公式，不影响预览
      }
    }

    if (!this._previewPath) {
      this._previewPath = el('path', {
        'class': 'wire-preview-line',
        fill: 'none',
        stroke: PREVIEW_COLOR,
        'stroke-width': WIRE_WIDTH,
        'stroke-linecap': 'round',
        'stroke-dasharray': '9 7',
        'pointer-events': 'none'
      });
      this.previewGroup.appendChild(this._previewPath);
    }
    this._previewPath.setAttribute('d', d);
    this._previewPath.setAttribute('stroke', this.previewColor || PREVIEW_COLOR);
    this._previewFrom = String(fromJackId);
  };

  /** 屏幕坐标 → SVG 用户坐标（自动处理 #panel 的等比缩放） */
  WireLayer.prototype.screenToSvg = function (clientX, clientY) {
    var ctm = this.svg.getScreenCTM && this.svg.getScreenCTM();
    if (ctm && ctm.inverse) {
      var pt = this.svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      var mapped = pt.matrixTransform(ctm.inverse());
      return { x: mapped.x, y: mapped.y };
    }
    // 退化路径：按 boundingClientRect 与 viewBox 比例换算
    var rect = this.svg.getBoundingClientRect();
    var vb = (this.geometry && this.geometry.VIEWBOX) || { width: 1800, height: 1380 };
    var sx = rect.width ? vb.width / rect.width : 1;
    var sy = rect.height ? vb.height / rect.height : 1;
    return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
  };

  /**
   * 命中测试：先查插孔（半径 14），再查导线（沿线采样 6px 容差）。
   * @param {number} clientX
   * @param {number} clientY
   * @param {{ignoreJacks?:boolean}} [options] ignoreJacks=true 时只找导线（右键删除用）
   * @returns {{type:'jack',jackId:string}|{type:'wire',wireId:string}|null}
   */
  WireLayer.prototype.hitTest = function (clientX, clientY, options) {
    var point = this.screenToSvg(clientX, clientY);
    var ignoreJacks = !!(options && options.ignoreJacks);

    // 1. 插孔：距离最近且落在半径内者优先
    if (!ignoreJacks) {
      var bestId = null;
      var bestDist = HIT_RADIUS * HIT_RADIUS;
      for (var jackId in this.jackNodes) {
        if (!Object.prototype.hasOwnProperty.call(this.jackNodes, jackId)) {
          continue;
        }
        var pos = this.getJackPos(jackId);
        if (!pos) {
          continue;
        }
        var dx = pos.x - point.x;
        var dy = pos.y - point.y;
        var d2 = dx * dx + dy * dy;
        if (d2 <= bestDist) {
          bestDist = d2;
          bestId = jackId;
        }
      }
      if (bestId) {
        return { type: 'jack', jackId: bestId };
      }
    }

    // 2. 导线：倒序遍历（后画的在上层优先命中）
    //    契约 §3.6：命中改用「渲染后的折线」距离 distanceToPolyline，容差仍是 6。
    var TOLERANCE = 6;
    for (var i = this.wires.length - 1; i >= 0; i--) {
      var wire = this.wires[i];
      if (!wire || !wire.id) {
        continue;
      }
      var wid = String(wire.id);
      var poly = this.wirePolylines && this.wirePolylines[wid];
      if (poly && poly.length > 1) {
        if (distanceToPolyline(point.x, point.y, poly) <= TOLERANCE) {
          return { type: 'wire', wireId: wid };
        }
        continue;
      }
      // 没有折线数据（旧数据 / 路由缺失）：退回旧公式
      var a = this.getJackPos(wire.from);
      var b = this.getJackPos(wire.to);
      if (!a || !b) {
        continue;
      }
      var sag = calcSag(a.x, a.y, b.x, b.y);
      if (distanceToBezier(point.x, point.y, a.x, a.y, b.x, b.y, sag) <= TOLERANCE) {
        return { type: 'wire', wireId: wid };
      }
    }
    return null;
  };

  /**
   * 点到折线的最短距离（命中测试用）。
   * 折线由避让路由采样得到，逐段求点到线段的距离再取最小值。
   * @param {number} px 点 x
   * @param {number} py 点 y
   * @param {Array<{x:number,y:number}>} poly 折线顶点数组
   * @returns {number} 最短距离（px 落在折线上时为 0）
   */
  function distanceToPolyline(px, py, poly) {
    if (!poly || !poly.length) {
      return Infinity;
    }
    if (poly.length === 1) {
      var only = poly[0];
      return Math.sqrt((px - only.x) * (px - only.x) + (py - only.y) * (py - only.y));
    }
    var best = Infinity;
    for (var i = 0; i < poly.length - 1; i++) {
      var ax = poly[i].x, ay = poly[i].y;
      var bx = poly[i + 1].x, by = poly[i + 1].y;
      var dx = bx - ax;
      var dy = by - ay;
      var len2 = dx * dx + dy * dy;
      var t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
      var qx = ax + t * dx;
      var qy = ay + t * dy;
      var d = Math.sqrt((px - qx) * (px - qx) + (py - qy) * (py - qy));
      if (d < best) {
        best = d;
        if (best === 0) {
          return 0;
        }
      }
    }
    return best;
  }

  /** 三次贝塞尔（契约控制点）上离点最近的距离，用采样逼近即可 */
  function distanceToBezier(px, py, x1, y1, x2, y2, sag) {
    var c1x = x1, c1y = y1 + sag, c2x = x2, c2y = y2 + sag;
    var STEPS = 24;
    var best = Infinity;
    for (var i = 0; i <= STEPS; i++) {
      var t = i / STEPS;
      var mt = 1 - t;
      var bx = mt * mt * mt * x1 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * x2;
      var by = mt * mt * mt * y1 + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * y2;
      var dx = bx - px;
      var dy = by - py;
      var d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
      }
    }
    return Math.sqrt(best);
  }

  /** 透视面板：隐藏/显示所有飞线（命中区保留，保证仍可接线） */
  WireLayer.prototype.setVisible = function (on) {
    this.visible = !!on;
    var display = this.visible ? '' : 'none';
    this.shadowGroup.style.display = display;
    this.pathGroup.style.display = display;
    if (this.visible) {
      this.svg.classList.remove('wires-hidden');
    } else {
      this.svg.classList.add('wires-hidden');
    }
  };

  /** 预览曲线使用当前选中的导线颜色 */
  WireLayer.prototype.setPreviewColor = function (color) {
    this.previewColor = safeColor(color);
    if (this._previewPath) {
      this._previewPath.setAttribute('stroke', this.previewColor);
    }
  };

  /** 让某根线滚动到最上层（新建线时用） */
  WireLayer.prototype.raiseWire = function (wireId) {
    var nodes = this.wireNodes[wireId ? String(wireId) : ''];
    if (!nodes) {
      return;
    }
    this.shadowGroup.appendChild(nodes.shadow);
    this.pathGroup.appendChild(nodes.path);
  };

  WireLayer.WIRE_WIDTH = WIRE_WIDTH;
  WireLayer.SHADOW_WIDTH = SHADOW_WIDTH;
  WireLayer.HIT_RADIUS = HIT_RADIUS;
  WireLayer.buildPath = buildPath;
  WireLayer.calcSag = calcSag;
  // distanceToBezier 保留导出以兼容旧自测；distanceToPolyline 是新的命中测试用函数
  WireLayer.distanceToBezier = distanceToBezier;
  WireLayer.distanceToPolyline = distanceToPolyline;

  DLab.WireLayer = WireLayer;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// src/core/wireRouting.js
// 飞线避让路由（纯函数、确定性、Node 可测，不依赖 DOM）。
// ------------------------------------------------------------------
// 契约：docs/STAGE4-CONTRACTS.md §3
//   §3.2 API 签名固定；§3.3 七条硬性不变量；§3.4 候选顺序 + 代价函数；§3.5 两轮迭代。
// 归属：wire-ui。浏览器与 Node 双端可直接加载（经典脚本 + 全局命名空间 DLab）。
//
// 【与 §3.4 代价公式的两处工程口径】(已随汇报报 Lead)
//  1) 导线净距项按「逐采样点累加」计罚，而不是只取两条曲线的最小间距。
//     原因：两条飞线交叉时真实间距为 0，min(0) 的惩罚会饱和成常数，
//     候选之间失去梯度，优化器找不到能分开的走法。逐采样点累加后，
//     「重叠的采样点有多少、每个还差多远」都被计入，候选之间保持单调梯度。
//     形式：Σ_障碍 Σ_采样点 w · max(0, C - d)²。
//  2) 插孔障碍只对「相对本线基准曲线新增覆盖」的插孔计罚。
//     原因：真实面板 288 个插孔、孔距仅 36~40，任意一根线的基准曲线都必然从若干
//     插孔旁擦过（实测中位最近插孔距 ≈ 3.3）。若把 20 单位内的插孔全部计罚，
//     基准代价恒不为 0，与 §3.3 第 2 条「无冲突即零改动」直接矛盾。
//     扣除基准项后：基准代价 = 导线重叠惩罚（+ 越界惩罚），为 0 即触发 §3.4 的
//     「基准代价为 0 直接返回基准」快速路径，与 §3.1「只有在真的发生重叠时才
//     整体上抬 / 下压 / 左右鼓出」一致。
(function (global) {
  'use strict';
  var DLab = (global.DLab = global.DLab || {});

  // ============ 契约常量（§3.2） ============
  var SAMPLES = 24;          // 每条候选曲线的采样段数
  var CLEARANCE_WIRE = 9;    // 与其它导线的期望净距
  var CLEARANCE_JACK = 20;   // 与其它插孔圆心的期望净距
  var EDGE_MARGIN = 8;       // 采样点不得越出的面板内缩边距

  var SAG_MAX = 90;          // 最大下垂（与旧公式一致）
  var SAG_RATIO = 0.28;      // 下垂比例（与旧公式一致）
  var DEFAULT_VIEWBOX = { width: 1800, height: 1380 };

  // ============ 代价函数权重（§3.4） ============
  var W_WIRE = 1.0;          // 导线障碍权重
  var W_JACK = 2.0;          // 插孔障碍权重
  var W_PERTURB = 0.6;       // 偏好小改动：0.6 * (|sagDelta| + 0.5 * |bowX|)
  var W_OUT = 4000;          // 越界采样点惩罚

  // ============ 候选集（§3.4，序号小者优先） ============
  // 第 0 个是基准；然后 sagDelta → sagScale → bowX。
  var CANDIDATES = [
    { sagScale: 1, sagDelta: 0, bowX: 0 },
    { sagScale: 1, sagDelta: -14, bowX: 0 },
    { sagScale: 1, sagDelta: 14, bowX: 0 },
    { sagScale: 1, sagDelta: -28, bowX: 0 },
    { sagScale: 1, sagDelta: 28, bowX: 0 },
    { sagScale: 1, sagDelta: -44, bowX: 0 },
    { sagScale: 1, sagDelta: 44, bowX: 0 },
    { sagScale: 1, sagDelta: -62, bowX: 0 },
    { sagScale: 1, sagDelta: 62, bowX: 0 },
    { sagScale: 1, sagDelta: -84, bowX: 0 },
    { sagScale: 1, sagDelta: 84, bowX: 0 },
    { sagScale: 1.5, sagDelta: 0, bowX: 0 },
    { sagScale: 2.2, sagDelta: 0, bowX: 0 },
    { sagScale: 3, sagDelta: 0, bowX: 0 },
    { sagScale: 1, sagDelta: 0, bowX: -20 },
    { sagScale: 1, sagDelta: 0, bowX: 20 },
    { sagScale: 1, sagDelta: 0, bowX: -36 },
    { sagScale: 1, sagDelta: 0, bowX: 36 }
  ];

  /* ================= 基础几何工具 ================= */

  /** 保留两位小数（与旧公式逐字符一致的关键） */
  function round(n) {
    return Math.round(n * 100) / 100;
  }

  /** 垂度：min(90, dist * 0.28) */
  function calcSag(x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    var dist = Math.sqrt(dx * dx + dy * dy);
    return Math.min(SAG_MAX, dist * SAG_RATIO);
  }

  /** 基础路径：必须与旧公式逐字符一致（无冲突时零改动） */
  function buildPath(x1, y1, x2, y2) {
    var sag = calcSag(x1, y1, x2, y2);
    return 'M ' + round(x1) + ' ' + round(y1) +
      ' C ' + round(x1) + ' ' + round(y1 + sag) +
      ' ' + round(x2) + ' ' + round(y2 + sag) +
      ' ' + round(x2) + ' ' + round(y2);
  }

  /**
   * 带参数的路径。
   * @param {number} sagScale 垂度倍率，1 = 原垂度
   * @param {number} sagDelta 控制点整体下移量（可为负 = 上抬）
   * @param {number} bowX     控制点横向鼓出量（正 = 向右）
   */
  function buildPathWith(x1, y1, x2, y2, opts) {
    opts = opts || {};
    var scale = (opts.sagScale === undefined || opts.sagScale === null) ? 1 : opts.sagScale;
    var delta = (opts.sagDelta === undefined || opts.sagDelta === null) ? 0 : opts.sagDelta;
    var bow = (opts.bowX === undefined || opts.bowX === null) ? 0 : opts.bowX;
    var sag = calcSag(x1, y1, x2, y2) * scale + delta;
    return 'M ' + round(x1) + ' ' + round(y1) +
      ' C ' + round(x1 + bow) + ' ' + round(y1 + sag) +
      ' ' + round(x2 + bow) + ' ' + round(y2 + sag) +
      ' ' + round(x2) + ' ' + round(y2);
  }

  var PATH_RE = /^\s*M\s*(-?[\d.]+)\s+(-?[\d.]+)\s+C\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/;

  /** 把路径采样成折线（命中测试与冲突检测共用） */
  function samplePath(d, steps) {
    var n = steps || SAMPLES;
    var m = PATH_RE.exec(String(d === undefined || d === null ? '' : d));
    if (!m) {
      return [];
    }
    var x1 = +m[1], y1 = +m[2];
    var c1x = +m[3], c1y = +m[4];
    var c2x = +m[5], c2y = +m[6];
    var x2 = +m[7], y2 = +m[8];
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var mt = 1 - t;
      pts.push({
        x: mt * mt * mt * x1 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * x2,
        y: mt * mt * mt * y1 + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * y2
      });
    }
    return pts;
  }

  /** 折线 → 带包围盒与线段包围盒的结构 */
  function makePoly(pts) {
    var segs = [];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.x < minX) { minX = p.x; }
      if (p.x > maxX) { maxX = p.x; }
      if (p.y < minY) { minY = p.y; }
      if (p.y > maxY) { maxY = p.y; }
      if (i > 0) {
        var q = pts[i - 1];
        segs.push({
          x1: q.x, y1: q.y, x2: p.x, y2: p.y,
          minX: Math.min(q.x, p.x), maxX: Math.max(q.x, p.x),
          minY: Math.min(q.y, p.y), maxY: Math.max(q.y, p.y)
        });
      }
    }
    return { pts: pts, segs: segs, bbox: { minX: minX, minY: minY, maxX: maxX, maxY: maxY } };
  }

  /** 两个包围盒之间的间隙（0 = 相交或包含） */
  function bboxGap(a, b) {
    var dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
    var dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** 点到线段的最短距离 */
  function distPointSeg(px, py, ax, ay, bx, by) {
    var dx = bx - ax;
    var dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
    var qx = ax + t * dx;
    var qy = ay + t * dy;
    return Math.sqrt((px - qx) * (px - qx) + (py - qy) * (py - qy));
  }

  /**
   * 两条折线之间的最小距离（顶点→对方折线的对称最小值）。
   * 与 wireLayer 的 distanceToPolyline 语义一致：折线按顶点折段处理。
   */
  function polyDistance(p1, p2) {
    if (!p1 || !p2 || !p1.segs.length || !p2.segs.length) {
      return Infinity;
    }
    var best = Infinity;
    for (var i = 0; i < p1.pts.length; i++) {
      var a = p1.pts[i];
      var d = pointPolyDistance(a.x, a.y, p2);
      if (d < best) { best = d; }
    }
    for (var j = 0; j < p2.pts.length; j++) {
      var b = p2.pts[j];
      var d2 = pointPolyDistance(b.x, b.y, p1);
      if (d2 < best) { best = d2; }
    }
    return best;
  }

  /** 点到折线的最短距离 */
  function pointPolyDistance(px, py, poly) {
    var best = Infinity;
    for (var i = 0; i < poly.segs.length; i++) {
      var s = poly.segs[i];
      var d = distPointSeg(px, py, s.x1, s.y1, s.x2, s.y2);
      if (d < best) {
        best = d;
      }
    }
    return best;
  }

  /* ================= 空间索引 ================= */

  /** 插孔按网格分桶，避免每条候选都全表扫描 */
  function JackGrid(jacks) {
    this.cell = 128;
    this.cells = Object.create(null);
    this.jacks = jacks;
    for (var i = 0; i < jacks.length; i++) {
      var j = jacks[i];
      var key = Math.floor(j.x / this.cell) + ':' + Math.floor(j.y / this.cell);
      var bucket = this.cells[key];
      if (!bucket) {
        bucket = [];
        this.cells[key] = bucket;
      }
      bucket.push(i);
    }
  }

  /** 查询矩形范围内的插孔下标（追加到 out，返回 out） */
  JackGrid.prototype.query = function (minX, minY, maxX, maxY, out) {
    var c = this.cell;
    var i0 = Math.floor(minX / c);
    var i1 = Math.floor(maxX / c);
    var j0 = Math.floor(minY / c);
    var j1 = Math.floor(maxY / c);
    for (var i = i0; i <= i1; i++) {
      for (var j = j0; j <= j1; j++) {
        var bucket = this.cells[i + ':' + j];
        if (!bucket) {
          continue;
        }
        for (var k = 0; k < bucket.length; k++) {
          out.push(bucket[k]);
        }
      }
    }
    return out;
  };

  /** 导线线段按网格分桶（用于导线↔导线净距的快速查询） */
  function SegmentGrid() {
    this.cell = 64;
    this.cells = Object.create(null);
    this.entries = [];
  }

  /** 插入一条线段，owner 标记归属的障碍序号 */
  SegmentGrid.prototype.insert = function (seg, owner) {
    var rec = {
      x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2,
      minX: seg.minX, maxX: seg.maxX, minY: seg.minY, maxY: seg.maxY,
      owner: owner
    };
    var idx = this.entries.length;
    this.entries.push(rec);
    var c = this.cell;
    var i0 = Math.floor(rec.minX / c);
    var i1 = Math.floor(rec.maxX / c);
    var j0 = Math.floor(rec.minY / c);
    var j1 = Math.floor(rec.maxY / c);
    for (var i = i0; i <= i1; i++) {
      for (var j = j0; j <= j1; j++) {
        var key = i + ':' + j;
        var bucket = this.cells[key];
        if (!bucket) {
          bucket = [];
          this.cells[key] = bucket;
        }
        bucket.push(idx);
      }
    }
    return rec;
  }

  /** 查询与矩形相交的所有线段记录（追加到 out） */
  SegmentGrid.prototype.query = function (minX, minY, maxX, maxY, out) {
    var c = this.cell;
    var i0 = Math.floor(minX / c);
    var i1 = Math.floor(maxX / c);
    var j0 = Math.floor(minY / c);
    var j1 = Math.floor(maxY / c);
    for (var i = i0; i <= i1; i++) {
      for (var j = j0; j <= j1; j++) {
        var bucket = this.cells[i + ':' + j];
        if (!bucket) {
          continue;
        }
        for (var k = 0; k < bucket.length; k++) {
          out.push(this.entries[bucket[k]]);
        }
      }
    }
    return out;
  };

  /* ================= 代价函数（§3.4） ================= */

  /** 偏好小改动的惩罚项：0.6 * (|sagDelta| + 0.5 * |bowX|) */
  function perturbCost(sagDelta, bowX) {
    return W_PERTURB * (Math.abs(sagDelta || 0) + 0.5 * Math.abs(bowX || 0));
  }

  /** 净距惩罚项：max(0, C - dist)^2 */
  function gapCost(dist, clearance) {
    var gap = clearance - dist;
    return gap > 0 ? gap * gap : 0;
  }

  /** 采样点越界数量 */
  function outOfBoundsCount(poly, bounds) {
    var n = 0;
    var pts = poly.pts;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.x < bounds.minX || p.x > bounds.maxX || p.y < bounds.minY || p.y > bounds.maxY) {
        n++;
      }
    }
    return n;
  }

  /**
   * 导线障碍项：Σ_障碍 Σ_采样点 w · max(0, C - d)^2。
   * 对每个采样点，取它到某根障碍导线折线的最短距离（取网格候选线段里的最小值）。
   * @param {Object} poly  候选折线
   * @param {Object} grid  障碍线段网格（每段带 owner）
   * @param {number} owners 障碍个数
   * @param {Object} ctx   复用缓冲
   * @param {number} skipOwner 需要忽略的障碍序号（自身）
   */
  function wirePenalty(poly, grid, owners, ctx, skipOwner) {
    if (!grid || owners <= 0) {
      return 0;
    }
    var cost = 0;
    var pts = poly.pts;
    var hits = ctx.segHits;
    var ownerMin = ctx.ownerMin;
    var ownerStamp = ctx.ownerStamp;
    var vstamp;
    for (var v = 0; v < pts.length; v++) {
      var p = pts[v];
      vstamp = ctx.stamp++;
      hits.length = 0;
      grid.query(
        p.x - CLEARANCE_WIRE, p.y - CLEARANCE_WIRE,
        p.x + CLEARANCE_WIRE, p.y + CLEARANCE_WIRE,
        hits
      );
      if (!hits.length) {
        continue;
      }
      var touched = ctx.touched;
      touched.length = 0;
      for (var k = 0; k < hits.length; k++) {
        var rec = hits[k];
        var o = rec.owner;
        if (o === skipOwner) {
          continue;
        }
        if (ownerStamp[o] !== vstamp) {
          ownerStamp[o] = vstamp;
          ownerMin[o] = Infinity;
          touched.push(o);
        }
        var d = distPointSeg(p.x, p.y, rec.x1, rec.y1, rec.x2, rec.y2);
        if (d < ownerMin[o]) {
          ownerMin[o] = d;
        }
      }
      for (var t = 0; t < touched.length; t++) {
        var od = ownerMin[touched[t]];
        if (od < CLEARANCE_WIRE) {
          cost += W_WIRE * gapCost(od, CLEARANCE_WIRE);
        }
      }
    }
    return cost;
  }

  /**
   * 插孔障碍项：Σ_插孔 w · max(0, C - d)^2，只对「相对基准曲线新增覆盖」的插孔计罚。
   * @param {Object} poly    候选折线
   * @param {Object} ctx     上下文（插孔表 / 网格 / 复用缓冲）
   * @param {Object} exclude 需要排除的插孔 id 集合（自身两端）
   * @param {Object} baseCov 基准曲线已覆盖的插孔下标集合
   */
  function jackPenalty(poly, ctx, exclude, baseCov) {
    var touched = ctx.jackTouched;
    var jdist = ctx.jdist;
    var jstamp = ctx.jackStamp;
    var stamp = ctx.stamp++;
    touched.length = 0;
    var hits = ctx.jackHits;
    var segs = poly.segs;
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s];
      hits.length = 0;
      ctx.grid.query(
        seg.minX - CLEARANCE_JACK, seg.minY - CLEARANCE_JACK,
        seg.maxX + CLEARANCE_JACK, seg.maxY + CLEARANCE_JACK,
        hits
      );
      for (var k = 0; k < hits.length; k++) {
        var idx = hits[k];
        if (jstamp[idx] !== stamp) {
          jstamp[idx] = stamp;
          jdist[idx] = Infinity;
          touched.push(idx);
        }
        var jack = ctx.jacks[idx];
        var d = distPointSeg(jack.x, jack.y, seg.x1, seg.y1, seg.x2, seg.y2);
        if (d < jdist[idx]) {
          jdist[idx] = d;
        }
      }
    }
    var cost = 0;
    for (var t = 0; t < touched.length; t++) {
      var i = touched[t];
      var jd = jdist[i];
      if (jd >= CLEARANCE_JACK) {
        continue;
      }
      var jack = ctx.jacks[i];
      if (exclude && exclude[jack.id]) {
        continue;
      }
      if (baseCov[i]) {
        continue;
      }
      cost += W_JACK * gapCost(jd, CLEARANCE_JACK);
    }
    return cost;
  }

  /**
   * 计算一条候选曲线的总代价（§3.4）。
   * @param {Object} poly     候选折线
   * @param {Object} cand     候选参数
   * @param {Object} grid     障碍线段网格
   * @param {number} owners   障碍个数
   * @param {number} skipOwner 需要忽略的障碍序号（自身）
   * @param {Object} ctx      上下文
   * @param {Object} exclude  需要排除的插孔 id 集合
   * @param {Object} baseCov  基准曲线已覆盖的插孔下标集合
   */
  function evaluateCost(poly, cand, grid, owners, skipOwner, ctx, exclude, baseCov) {
    var cost = perturbCost(cand.sagDelta, cand.bowX);
    cost += W_OUT * outOfBoundsCount(poly, ctx.bounds);
    cost += wirePenalty(poly, grid, owners, ctx, skipOwner);
    cost += jackPenalty(poly, ctx, exclude, baseCov);
    return cost;
  }

  /* ================= 路由上下文 ================= */

  /** 依据几何数据建立路由上下文（插孔表 + 网格 + 边界 + 复用缓冲） */
  function makeContext(geometry) {
    var g = geometry || {};
    var vb = g.VIEWBOX || DEFAULT_VIEWBOX;
    var jackMap = g.JACKS || {};
    var order = (g.JACK_ORDER && g.JACK_ORDER.length) ? g.JACK_ORDER : Object.keys(jackMap);
    var jacks = [];
    for (var i = 0; i < order.length; i++) {
      var j = jackMap[order[i]];
      if (j && typeof j.x === 'number' && typeof j.y === 'number') {
        jacks.push({ id: order[i], x: j.x, y: j.y });
      }
    }
    var ctx = {
      jacks: jacks,
      grid: new JackGrid(jacks),
      bounds: {
        minX: EDGE_MARGIN,
        minY: EDGE_MARGIN,
        maxX: (vb.width || DEFAULT_VIEWBOX.width) - EDGE_MARGIN,
        maxY: (vb.height || DEFAULT_VIEWBOX.height) - EDGE_MARGIN
      },
      stamp: 0,
      segHits: [],
      touched: [],
      ownerMin: [],
      ownerStamp: [],
      jackHits: [],
      jackTouched: [],
      jdist: [],
      jackStamp: []
    };
    for (var k = 0; k < jacks.length; k++) {
      ctx.jdist.push(Infinity);
      ctx.jackStamp.push(0);
    }
    return ctx;
  }

  /** 为「最多 N 个障碍」准备好 owner 缓冲 */
  function ensureOwnerBuffers(ctx, count) {
    while (ctx.ownerMin.length < count) {
      ctx.ownerMin.push(Infinity);
      ctx.ownerStamp.push(0);
    }
  }

  /** 基准曲线覆盖到的插孔下标集合（距离 < CLEARANCE_JACK） */
  function baseCoverage(basePoly, ctx) {
    var touched = [];
    var hits = [];
    var jdist = [];
    var jstamp = [];
    var i;
    for (i = 0; i < ctx.jacks.length; i++) {
      jdist.push(Infinity);
      jstamp.push(0);
    }
    var stamp = 1;
    var segs = basePoly.segs;
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s];
      hits.length = 0;
      ctx.grid.query(
        seg.minX - CLEARANCE_JACK, seg.minY - CLEARANCE_JACK,
        seg.maxX + CLEARANCE_JACK, seg.maxY + CLEARANCE_JACK,
        hits
      );
      for (var k = 0; k < hits.length; k++) {
        var idx = hits[k];
        if (jstamp[idx] !== stamp) {
          jstamp[idx] = stamp;
          jdist[idx] = Infinity;
          touched.push(idx);
        }
        var jack = ctx.jacks[idx];
        var d = distPointSeg(jack.x, jack.y, seg.x1, seg.y1, seg.x2, seg.y2);
        if (d < jdist[idx]) {
          jdist[idx] = d;
        }
      }
    }
    var set = Object.create(null);
    for (i = 0; i < touched.length; i++) {
      if (jdist[touched[i]] < CLEARANCE_JACK) {
        set[touched[i]] = true;
      }
    }
    return set;
  }

  /**
   * 把控制点夹进边界（端点保持不变）。
   * 矩形是凸集，控制点全在矩形内 ⇒ 整条三次贝塞尔曲线都在矩形内。
   */
  function clampPath(d, bounds) {
    var m = PATH_RE.exec(String(d || ''));
    if (!m) {
      return null;
    }
    var x1 = +m[1], y1 = +m[2];
    var c1x = +m[3], c1y = +m[4];
    var c2x = +m[5], c2y = +m[6];
    var x2 = +m[7], y2 = +m[8];
    var cx1 = Math.min(Math.max(c1x, bounds.minX), bounds.maxX);
    var cy1 = Math.min(Math.max(c1y, bounds.minY), bounds.maxY);
    var cx2 = Math.min(Math.max(c2x, bounds.minX), bounds.maxX);
    var cy2 = Math.min(Math.max(c2y, bounds.minY), bounds.maxY);
    if (cx1 === c1x && cy1 === c1y && cx2 === c2x && cy2 === c2y) {
      return null;
    }
    return 'M ' + round(x1) + ' ' + round(y1) +
      ' C ' + round(cx1) + ' ' + round(cy1) +
      ' ' + round(cx2) + ' ' + round(cy2) +
      ' ' + round(x2) + ' ' + round(y2);
  }

  /**
   * 预计算一对端点的全部候选曲线（采样 + 越界夹紧）。
   * 两轮迭代用的是同一组端点，所以候选表只需算一次 —— 纯性能优化，结果完全一致。
   * @param {number} x1 起点 x
   * @param {number} y1 起点 y
   * @param {number} x2 终点 x
   * @param {number} y2 终点 y
   * @param {Object} ctx 上下文（提供边界）
   * @returns {Array<{d:string, points:Array, poly:Object}>} 下标 = 候选序号
   */
  function buildCandidates(x1, y1, x2, y2, ctx) {
    var table = [];
    for (var ci = 0; ci < CANDIDATES.length; ci++) {
      var cand = CANDIDATES[ci];
      var d = buildPathWith(x1, y1, x2, y2, cand);
      var pts = samplePath(d, SAMPLES);
      var poly = makePoly(pts);
      // 越界时改用夹紧控制点的版本（端点不变），保证采样点不出面板
      if (outOfBoundsCount(poly, ctx.bounds) > 0) {
        var clamped = clampPath(d, ctx.bounds);
        if (clamped) {
          var cpts = samplePath(clamped, SAMPLES);
          var cpoly = makePoly(cpts);
          if (outOfBoundsCount(cpoly, ctx.bounds) === 0) {
            d = clamped;
            pts = cpts;
            poly = cpoly;
          }
        }
      }
      table.push({ d: d, points: pts, poly: poly });
    }
    return table;
  }

  /**
   * 为一对端点挑选最优候选（§3.4 选优规则：代价最小者胜，同价取序号小者）。
   * 基准候选代价为 0 时直接返回基准（快速路径）。
   * @param {Array} table 该端点对预计算好的候选表
   * @param {Object} grid 障碍线段网格
   * @param {number} owners 障碍个数
   * @param {number} skipOwner 需要忽略的障碍序号（自身）
   * @param {Object} ctx 上下文
   * @param {Object} exclude 需要排除的插孔 id 集合
   * @param {Object} baseCov 基准曲线已覆盖的插孔下标集合
   */
  function chooseCandidate(table, grid, owners, skipOwner, ctx, exclude, baseCov) {
    var best = null;
    for (var ci = 0; ci < table.length; ci++) {
      var cand = CANDIDATES[ci];
      var entry = table[ci];
      var cost = evaluateCost(entry.poly, cand, grid, owners, skipOwner, ctx, exclude, baseCov);
      if (ci === 0 && cost <= 0) {
        return { d: entry.d, points: entry.points, poly: entry.poly, adjusted: false, cost: 0, index: 0 };
      }
      if (!best || cost < best.cost) {
        best = { d: entry.d, points: entry.points, poly: entry.poly, adjusted: ci !== 0, cost: cost, index: ci };
      }
    }
    return best;
  }

  /* ================= 对外 API ================= */

  /**
   * 路由全部导线（纯函数、确定性）。
   * @param {Array<{id,from,to,color}>} wires 顺序即优先级（先接的线优先保持原样）
   * @param {Object} geometry DLab.geometry
   * @returns {{byId:Object<string,{id,d,points,adjusted,cost}>, adjustedCount:number, total:number}}
   */
  function routeAll(wires, geometry) {
    var byId = Object.create(null);
    var arr = Array.isArray(wires) ? wires : [];
    var g = geometry || {};
    var jackMap = g.JACKS || {};
    var list = [];
    var i, j;
    for (i = 0; i < arr.length; i++) {
      var w = arr[i];
      if (!w || w.id === undefined || w.id === null) {
        continue;
      }
      var a = jackMap[w.from];
      var b = jackMap[w.to];
      if (!a || !b || typeof a.x !== 'number' || typeof b.x !== 'number') {
        continue;
      }
      list.push({ id: String(w.id), from: w.from, to: w.to, a: a, b: b });
    }
    if (!list.length) {
      return { byId: byId, adjustedCount: 0, total: 0 };
    }

    var ctx = makeContext(g);
    var n = list.length;
    ensureOwnerBuffers(ctx, n + 1);

    // 基准折线、基准路径、基准覆盖集、排除集、预计算的候选表
    var basePolys = [];
    var basePaths = [];
    var baseCovs = [];
    var excludeSets = [];
    var candTables = [];
    for (i = 0; i < n; i++) {
      var bd = buildPath(list[i].a.x, list[i].a.y, list[i].b.x, list[i].b.y);
      basePaths.push(bd);
      var bp = makePoly(samplePath(bd, SAMPLES));
      basePolys.push(bp);
      baseCovs.push(baseCoverage(bp, ctx));
      var ex = Object.create(null);
      ex[list[i].from] = true;
      ex[list[i].to] = true;
      excludeSets.push(ex);
      // 两轮迭代共用同一组端点 → 候选表只算一次
      candTables.push(buildCandidates(list[i].a.x, list[i].a.y, list[i].b.x, list[i].b.y, ctx));
    }

    // —— 第 1 轮：按 wires 顺序逐根路由（障碍 = 已定稿的线 + 尚未处理的线的基准路径）——
    var round1 = [];
    for (i = 0; i < n; i++) {
      var grid1 = new SegmentGrid();
      for (j = 0; j < i; j++) {
        var p1 = round1[j].poly;
        for (var s1 = 0; s1 < p1.segs.length; s1++) {
          grid1.insert(p1.segs[s1], j);
        }
      }
      for (j = i + 1; j < n; j++) {
        var p2 = basePolys[j];
        for (var s2 = 0; s2 < p2.segs.length; s2++) {
          grid1.insert(p2.segs[s2], j);
        }
      }
      round1.push(chooseCandidate(
        candTables[i],
        grid1, n - 1, -1, ctx, excludeSets[i], baseCovs[i]
      ));
    }

    // —— 第 2 轮：用第 1 轮的结果整体重排一次 ——
    // 与第 1 轮同构：障碍 = 本轮已定稿的线 + 尚未处理到的线的第 1 轮结果。
    var round2 = [];
    for (i = 0; i < n; i++) {
      var grid2 = new SegmentGrid();
      var owner2 = 0;
      for (j = 0; j < i; j++) {
        var p1b = round2[j].poly;
        for (var s1b = 0; s1b < p1b.segs.length; s1b++) {
          grid2.insert(p1b.segs[s1b], owner2);
        }
        owner2++;
      }
      for (j = i + 1; j < n; j++) {
        var p2b = round1[j].poly;
        for (var s2b = 0; s2b < p2b.segs.length; s2b++) {
          grid2.insert(p2b.segs[s2b], owner2);
        }
        owner2++;
      }
      round2.push(chooseCandidate(
        candTables[i],
        grid2, owner2, -1, ctx, excludeSets[i], baseCovs[i]
      ));
    }

    var adjustedCount = 0;
    for (i = 0; i < n; i++) {
      var res = round2[i];
      var isAdjusted = res.d !== basePaths[i];
      if (isAdjusted) {
        adjustedCount++;
      }
      byId[list[i].id] = {
        id: list[i].id,
        d: res.d,
        points: res.points,
        adjusted: isAdjusted,
        cost: res.cost
      };
    }
    return { byId: byId, adjustedCount: adjustedCount, total: n };
  }

  /**
   * 预览线避让：把「起点 → 目标点」当成一根临时线，障碍 = 现有导线。
   * 与 routeAll 共用同一套代价函数与候选顺序。
   * @param {{x:number,y:number}} from 起点（SVG 用户坐标）
   * @param {{x:number,y:number}} to   目标点（SVG 用户坐标）
   * @param {Array} wireObstacles 现有导线折线（[[{x,y}...]] 或 [{points:[...]}...]）
   * @param {Object} geometry
   * @param {{excludeJackIds?:Array<string>}} [options]
   * @returns {{d:string, points:Array, adjusted:boolean, cost:number}}
   */
  function routePreview(from, to, wireObstacles, geometry, options) {
    var opts = options || {};
    if (!from || !to) {
      return { d: '', points: [], adjusted: false, cost: 0 };
    }
    var ctx = makeContext(geometry);
    var arr = Array.isArray(wireObstacles) ? wireObstacles : [];
    var grid = new SegmentGrid();
    var owner = 0;
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      var pts = null;
      if (Array.isArray(item)) {
        pts = item;
      } else if (item && Array.isArray(item.points)) {
        pts = item.points;
      }
      if (pts && pts.length > 1) {
        var poly = makePoly(pts);
        for (var s = 0; s < poly.segs.length; s++) {
          grid.insert(poly.segs[s], owner);
        }
        owner++;
      }
    }
    ensureOwnerBuffers(ctx, owner + 1);
    var exclude = Object.create(null);
    var ex = opts.excludeJackIds || [];
    for (var k = 0; k < ex.length; k++) {
      exclude[ex[k]] = true;
    }
    var baseD = buildPath(from.x, from.y, to.x, to.y);
    var basePoly = makePoly(samplePath(baseD, SAMPLES));
    var best = chooseCandidate(
      buildCandidates(from.x, from.y, to.x, to.y, ctx),
      grid, owner, -1, ctx, exclude, baseCoverage(basePoly, ctx)
    );
    return {
      d: best.d,
      points: best.points,
      adjusted: best.d !== baseD,
      cost: best.cost
    };
  }

  DLab.WireRouting = {
    SAMPLES: SAMPLES,
    CLEARANCE_WIRE: CLEARANCE_WIRE,
    CLEARANCE_JACK: CLEARANCE_JACK,
    EDGE_MARGIN: EDGE_MARGIN,
    CANDIDATES: CANDIDATES,
    calcSag: calcSag,
    buildPath: buildPath,
    buildPathWith: buildPathWith,
    samplePath: samplePath,
    routeAll: routeAll,
    routePreview: routePreview,
    // —— 以下为自测辅助（只读片段）——
    perturbCost: perturbCost,
    gapCost: gapCost,
    polyDistance: polyDistance,
    pointPolyDistance: pointPolyDistance,
    makePoly: makePoly
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

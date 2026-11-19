# DLab 第四阶段（第一批）实现契约

> 本文件是**本轮并行开发的唯一接口基准**。所有模块必须严格遵守。
> 上位契约是 `docs/CONTRACTS.md`（第二/三阶段），本文件只**增量**定义本轮四项改动，
> 与上位契约冲突时以本文件为准；本文件没写到的，一律沿用上位契约。
>
> 本轮目标（用户原话）：
> 1. **滚轮缩放**；
> 2. **重复接线 = 取消该接线**（某点到另一点已经有线，再连一次就把线删掉）；
> 3. **接线算法上尽量避免重叠**；
> 4. 继续推进下一阶段（第四阶段：AI 助教）。

---

## 0. 铁律（违反即打回）

1. **禁止 ES Module**、禁止 `fetch()`、禁止任何依赖：仍是经典脚本 + 全局命名空间 `DLab`。
2. **`SVG.SVG` 只读**；面板外观零位移（viewBox 仍 `0 0 1800 1380`）。
3. **只写自己范围内的文件**。发现别人文件有 bug → `send_message` 报给 Lead，不要直接改。
4. 所有注释用中文，标识符用英文，UTF-8 + LF。
5. 每个模块文件都必须是这个形状（浏览器与 Node 双端可加载）：

```js
(function (global) {
  'use strict';
  var DLab = (global.DLab = global.DLab || {});
  // ...
  DLab.XXX = XXX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

6. **改完必须自己跑测试**，并在回报里给出命令与实测数字。
7. **CDP 端口互斥**（同时只有一个无头浏览器能用同一端口，撞端口会直接失败）：

| 用途 | 端口 | 谁用 |
| :-- | :-- | :-- |
| `build/ui-index-selftest.cjs` | 9338 | 已有 |
| `build/ui-index-test.cjs` | 9335 | 已有 |
| `build/ui-roundtrip.cjs` | 9337 | 已有 |
| `build/integration.mjs` | 9351 | 已有 |
| `build/ui-viewport.check.cjs` | **9361** | Lead |
| wire-ui 自测/回归 | **9362** | wire-ui |
| ai-ui 回归 | **9363** | ai-ui |
| 其余（`ui-led-switch` / `ui-chip-tray` / `ui-keyboard`） | 默认 9333 | **不要动，也不要同时跑** |

> 若确实要跑默认 9333 的套件，先在群里说一声，或改用 `launch({ port: 9364 })` 的临时副本，**不要改原文件端口**。

---

## 1. 新增文件总表

| 文件 | 归属 | 作用 |
| :-- | :-- | :-- |
| `src/core/wireRouting.js` | **wire-ui** | 飞线避让路由（纯函数，Node 可测） |
| `src/ui/viewport.js` | **Lead** | 滚轮缩放 / 平移 / 适应窗口 |
| `src/core/advisor.js` | **ai-core** | 接线审查与故障诊断（纯逻辑） |
| `src/core/grader.js` | **ai-core** | 真值表批量打分（纯逻辑） |
| `src/core/quiz.js` | **ai-core** | 自动出题（生成半成品工程包 + 题面） |
| `src/ui/advisorPanel.js` | **ai-ui** | AI 助教侧栏 UI（审查/打分/载入题目） |
| `styles/assistant.css` | **ai-ui** | AI 助教侧栏样式 |
| `tests/wireRouting.selftest.cjs` | **wire-ui** | 路由自测（Node） |
| `tests/advisor.selftest.cjs` | **ai-core** | 审查自测（Node） |
| `tests/grader.selftest.cjs` | **ai-core** | 打分 + 出题自测（Node） |
| `build/ui-viewport.check.cjs` | **Lead** | 缩放平移浏览器回归 |
| `build/ui-assistant.check.cjs` | **ai-ui** | 助教侧栏浏览器回归 |

**Lead 已在仓库里放了这些文件的桩实现**（能加载、能通过最小断言），请**整体重写**，不要保留桩代码。

`index.html` 的脚本加载顺序由 Lead 统一维护，已追加：

```html
<script src="src/core/wireRouting.js"></script>   <!-- 在 wireLayer.js 之前 -->
<script src="src/core/advisor.js"></script>       <!-- 在 engine.js 之后 -->
<script src="src/core/grader.js"></script>
<script src="src/core/quiz.js"></script>
<script src="src/ui/viewport.js"></script>        <!-- 在 app.js 之前 -->
<script src="src/ui/advisorPanel.js"></script>    <!-- 在 app.js 之前 -->
```

---

## 2. 改动一：重复接线 = 取消接线（wire-ui 负责）

### 2.1 行为规格

在 `Interaction.pickJack(jackId)` 里，当已经选中起点 `from`、又点到另一个孔 `to` 时：

| 情形 | 行为 |
| :-- | :-- |
| `from` 与 `to` 之间**已存在直接导线**（不分方向，可能有多根） | **删除全部这些导线**，记入撤销栈，状态栏提示 `已取消接线：<A> ↔ <B>（重复接线 = 取消）`，清空起点态 |
| 不存在直接导线，但两孔**已在同一连通网** | 维持原行为：拒绝并提示 `这两个插孔已经在同一个连通网（netN）里，无需再连` |
| 两者都没有 | 正常新建导线（原行为） |

要点：

- 判定「已有导线」只看 `engine.getWires()` 里 `from/to` 是否构成同一无序对，**不看颜色**；
- 删除后必须 `refresh(true)`，并让 `hud.setWireCount` 同步；
- 撤销要能把这根线恢复回来（见 2.2）。

### 2.2 撤销栈新增条目类型

```js
{ type: 'remove',     wire:  {id, from, to, color} }        // 原有，单根
{ type: 'removeMany', wires: [ {id, from, to, color}, ... ] } // 新增，多根（≥2）
```

`_applyEntry(entry, dir)` 必须支持 `removeMany`：

- `dir==='undo'` → 逐根 `engine.addWire`，返回 `'已恢复 N 根导线'`；
- `dir==='redo'` → 逐根 `engine.removeWire`，返回 `'已重新删除 N 根导线'`。

### 2.3 返回值

`pickJack` 现在**返回一个字符串**（旧调用方忽略返回值，保持兼容）：

```
'connected'      新建成功
'cancelled'      重复接线 → 删线成功
'cancelled-start' 点了同一个孔 → 取消起点
'rejected'       被拒绝（同网 / 引擎抛错）
null             入参非法
```

---

## 3. 改动二：飞线避让路由（wire-ui 负责）

### 3.1 目标

飞线不要互相压在一起、不要横穿别的插孔、不要跑出面板。**但必须保住「杜邦线自然下垂」的观感**：
默认仍是从起点向下垂的贝塞尔，只有在真的发生重叠时才把它整体上抬 / 下压 / 左右鼓出。

### 3.2 `DLab.WireRouting` API（**签名固定，Lead 的回归测试会按这个调**）

```js
DLab.WireRouting = {
  SAMPLES: 24,            // 每条候选曲线的采样段数（>=24）
  CLEARANCE_WIRE: 9,      // 与其它导线的期望净距（viewBox 单位）
  CLEARANCE_JACK: 20,     // 与其它插孔圆心的期望净距
  EDGE_MARGIN: 8,         // 曲线采样点不得越出的面板内缩边距

  /** 与原契约完全一致的垂度：min(90, dist * 0.28) */
  calcSag: function (x1, y1, x2, y2) { /* → number */ },

  /** 基础路径：必须与旧公式逐字符一致，用于「无冲突时零改动」 */
  buildPath: function (x1, y1, x2, y2) { /* → 'M .. C .. .. ..' */ },

  /**
   * 带参数的路径。
   * @param {number} sagScale 垂度倍率，1 = 原垂度
   * @param {number} sagDelta 控制点整体下移量（可为负 = 上抬）
   * @param {number} bowX     控制点横向鼓出量（正 = 向右）
   */
  buildPathWith: function (x1, y1, x2, y2, opts) { /* → string */ },

  /** 把路径采样成折线（供命中测试与冲突检测复用） */
  samplePath: function (d, steps) { /* → [{x,y}, ...] */ },

  /**
   * 路由全部导线（纯函数、确定性）。
   * @param {Array<{id,from,to,color}>} wires 顺序即优先级（先接的线优先保持原样）
   * @param {Object} geometry DLab.geometry
   * @returns {% raw %}{{ byId: Object<string, {id, d, points, adjusted, cost}>, adjustedCount, total }}{% endraw %}
   */
  routeAll: function (wires, geometry) { /* ... */ }
}
```

### 3.3 硬性不变量（回归测试逐条断言）

1. **端点精确**：`points[0]` 严格等于 `geometry.JACKS[from]` 的 `(x,y)`，`points[points.length-1]` 严格等于 `to` 的 `(x,y)`（允许 0.01 误差）。
2. **无冲突即零改动**：只有一根线（或该线与所有障碍都无冲突）时，`adjusted === false` 且 `d === buildPath(...)`（逐字符相等）。
3. **确定性**：同一 `(wires, geometry)` 连续调用两次，`byId` 完全一致。
4. **端点不变性**：给 `routeAll` 的 `wires` 加一根线后，其它线允许被重排，但**每条线的两端坐标永远不变**。
5. **不越界**：所有采样点落在 `[EDGE_MARGIN, W-EDGE_MARGIN] × [EDGE_MARGIN, H-EDGE_MARGIN]`。
6. **改善可度量**：构造一个「两根线完全重合」的场景，`routeAll` 之后两条折线的最小间距必须 ≥ `CLEARANCE_WIRE * 0.8`。
7. **性能**：40 根导线、288 孔的真实几何下，`routeAll` 单次 < **60 ms**（自测里实测并打印）。

### 3.4 候选集（必须按此顺序，保证确定性）

```
第 0 个（基准）：{sagScale:1, sagDelta:0,  bowX:0}
然后依次：      sagDelta ∈ [-14,+14,-28,+28,-44,+44,-62,+62,-84,+84]   (sagScale:1, bowX:0)
然后依次：      sagScale ∈ [1.5, 2.2, 3.0]                              (sagDelta:0, bowX:0)
最后依次：      bowX     ∈ [-20,+20,-36,+36]                            (sagScale:1, sagDelta:0)
```

**代价函数**（数值可微调，但必须满足第 3.3 节的不变量）：

```
cost = Σ_障碍  w · max(0, C - dist)²          // 障碍：其它导线折线（w=1.0, C=CLEARANCE_WIRE）
                                              //       其它插孔圆心（w=2.0, C=CLEARANCE_JACK，排除自身两端）
     + 0.6 · (|sagDelta| + 0.5·|bowX|)        // 偏好小改动
     + 4000 · 越界采样点数
```

**选优规则**：代价最小者胜；代价相同取候选序号更小者。基准候选代价为 0 时**直接返回基准**（快速路径）。

### 3.5 两轮迭代

`routeAll` 跑 **2 轮**：第 1 轮按 `wires` 顺序逐根路由（障碍 = 已定稿的线 + 尚未处理的线的基准路径），
第 2 轮用第 1 轮的结果整体重排一次。两轮固定顺序 → 结果确定。

### 3.6 `WireLayer` 接入（同一人负责，不要另开分支）

- `render(wires)` 内部改用 `DLab.WireRouting.routeAll(wires, this.geometry)` 生成 `d`；
  **`DLab.WireRouting` 不存在时自动回落旧公式**（`buildPath`），保证模块缺失不白屏。
- 渲染后把结果存进 `this.routes = byId`，并把每条线的折线存进 `this.wirePolylines[id] = points`。
- `hitTest` 的导线命中**改用折线距离**（`distanceToPolyline`），容差仍是 6；`distanceToBezier` 保留导出以兼容旧自测。
- `setPreview(fromJackId, clientX, clientY)` 的预览线也走避让：用 `routeAll` 同样的代价函数，把「起点→鼠标」当成一根临时线，障碍 = 现有导线。
- **新增** `setJackAlert(jackIds)`：`jackIds` 为数组（高亮）或 `null`/`[]`（清除）；
  给对应命中圆加/去 `is-alert` 类（`styles/wires.css` 里补样式：琥珀色实心环 + 轻微脉冲，禁止霓虹光晕）。
- `styles/wires.css` 补 `.jack-hit.is-alert` 样式。

---

## 4. 改动三：滚轮缩放（Lead 负责，这里只写外部可见契约）

`DLab.Viewport`（`src/ui/viewport.js`）：

```js
new DLab.Viewport({ stageEl, panelEl, svgEl, onChange })   // onChange({scale, tx, ty})
zoomAt(clientX, clientY, factor)   // 以屏幕点为中心缩放，返回新 scale
setScale(scale, anchorClientX, anchorClientY)
zoomIn() / zoomOut() / reset()     // reset = 适应窗口（scale 1）
panBy(dxPx, dyPx)
getScale() / getTransform()        // {scale, tx, ty}
isZoomed()
start() / stop()
static MIN_SCALE / MAX_SCALE       // 1 / 8
```

交互：滚轮 = 以光标为中心缩放；中键拖拽或 `Space`+左键拖拽 = 平移；`Ctrl+0` = 复位；
面板右下角浮出 `－ 100% ＋ 适应窗口` 小控件。

**坐标换算零改动**：缩放用 `#panel` 的 CSS `transform` 实现，
Chromium 的 `getScreenCTM()` **已包含** CSS transform（实测 `a/d` 随之变化），
所以 `wireLayer.screenToSvg / hitTest / boardControls.absoluteAnchor / chipTray` 全部无需改动即可正确工作。

---

## 5. 改动四：AI 助教（ai-core / ai-ui 负责）

### 5.1 `DLab.Advisor`（ai-core，纯逻辑，Node 可测）

```js
DLab.Advisor = {
  LEVELS: { ERROR: 'error', WARN: 'warn', INFO: 'info' },
  /** 审查当前电路，纯只读，绝不改引擎状态 */
  review: function (engine, options) { /* → report */ }
}

// report 结构（字段固定）
{
  ok: boolean,                       // 无 error 级问题
  generatedAt: number,               // options.now 可注入，默认 Date.now()
  summary: { error: 0, warn: 0, info: 0 },
  issues: [
    {
      id: 'iss1',                    // 稳定 id：'<code>#<序号>'
      level: 'error'|'warn'|'info',
      code: 'NO_POWER',              // 见下表
      title: '芯片未供电',            // 中文短标题
      detail: 'devA:UA（74LS00）的 VCC 引脚（14 脚）所在网电平为 Z',
      hint: '把 devA:VCC 接到 pwr:5V1',  // 中文排错建议，面向学生
      jacks: ['devA:VCC'],           // 相关插孔 id（可空数组）
      socketId: 'devA:UA',           // 可空
      pin: 14                        // 可空
    }
  ],
  stats: { wires: 0, chips: 0, poweredChips: 0, floatingPins: 0, shorts: 0 }
}
```

**必须实现的 code 表**（大小写与拼写固定）：

| code | level | 判据 |
| :-- | :-- | :-- |
| `NO_POWER` | error | 已插芯片的 VCC 脚所在网电平 !== `'1'` |
| `NO_GROUND` | error | 已插芯片的 GND 脚所在网电平 !== `'0'` |
| `SHORT_CIRCUIT` | error | `engine.getState().shorts` 非空（每条短路一个 issue，`jacks` 取该网插孔） |
| `OUTPUT_CONFLICT` | error | 同一网内两个输出脚驱动相反（从 `state.nets` 的 `drivers` 判，或与 `shorts` 交叉核对） |
| `ENABLE_FLOATING` | warn | 低有效使能端（名字以 `~` 开头且含 EN/CLR/PRE/LOAD/PE/OE）所在网为 `'Z'` |
| `INPUT_FLOATING` | warn | 输入脚所在网为 `'Z'` |
| `CLOCK_FLOATING` | warn | 时序芯片（`74LS74/112/160/161/194/273`）的 CLK 脚所在网为 `'Z'` |
| `RESET_HELD` | warn | `~CLR`/`~PRE` 所在网恒为 `'0'`（触发器被持续钳位） |
| `OUTPUT_FLOATING` | info | 输出脚所在网为 `'Z'` 且该网无其它插孔 |
| `NO_WIRES` | info | 导线数为 0 |

**约束**：
- 必须能在 Node 里跑：`globalThis.DLab = {}; require('src/core/logic.js'); require('src/core/chips.js'); require('src/core/engine.js'); require('src/core/advisor.js')`；
- **不得修改引擎状态**（自测里断言：审查前后 `JSON.stringify(engine.getState())` 完全一致，且导线/开关/芯片数量不变）；
- `engine.getState().jacks` 是「插孔 id → 电平」；`state.nets` 是 `[{id, jacks:[], level, drivers:[]}]`；
- 芯片引脚名来自 `DLab.Chips.get(model).pinNames`（低有效端名前缀 `~`），引脚号 n 对应插孔 `engine.socketJack(socketId, n)`（**已有 API，直接用**）。

### 5.2 `DLab.Grader`（ai-core，纯逻辑）

```js
DLab.Grader = {
  /** 归一化题面 */
  buildTask: function (def) { /* → task */ },
  /**
   * 静默打分：快照开关 → 逐行施加激励 → engine.step(固定时刻) → 读输出 → 恢复开关
   * @returns {% raw %}{{ok, total, passed, failed, rows:[{in:[0,1], expected:[0], actual:[0], pass:boolean}], message}}{% endraw %}
   */
  grade: function (engine, task, options) { /* options: {timeMs, restore:true} */ }
}

// task 结构
{ id: 'quiz-inverter', title: '用 74LS00 实现反相器', description: '…',
  inputs: ['sw:5K1'], outputs: ['led:4P1'],
  rows: [ { in: [0], out: [1] }, { in: [1], out: [0] } ] }
```

- `inputs` 用**开关**驱动（`sw:5K1` → `engine.setSwitch(1, v)`），`outputs` 用**插孔电平**读（`engine.getJackLevel(id)`，`'1'` 记 1，其它记 0）；
- **必须恢复**：打分前快照 16 个开关，结束后逐一还原（`restore:false` 可关闭，仅供测试）；
- 打分不得增删导线、不得插拔芯片；
- 时间固定：默认 `timeMs = 1000`（避开时钟边沿抖动），逐行 `engine.step(timeMs + rowIndex * 10)`。

### 5.3 `DLab.Quiz`（ai-core）

```js
DLab.Quiz = {
  TEMPLATES: [ { id, title, description, pins: '14P'|'16P', difficulty } ],
  /** 生成半成品工程包（含 task 字段），可直接导出/导入 */
  generate: function (templateId, options) { /* → {project, task, solution:{wires:[...]}, message} */ },
  /** 读入 .dlab.json 文本/文件，抽出题面（不导入电路） */
  readTask: function (fileOrText) { /* → Promise<{ok, task, message}> */ }
}
```

- 至少 **3 个模板**：`quiz-inverter`（74LS00 反相器）、`quiz-nand`（74LS00 二输入与非）、`quiz-decoder`（74LS138 使能/译码）；
- `project` 必须能通过 `DLab.Persistence.validateProject`（`format:'dlab-project'`, `version:1`，插孔 id 全部真实存在）；
- `project.task = task` 为**新增字段**，上位契约「未知字段忽略」→ 老版本导入不报错（自测断言这一点）；
- `generate` 产生的半成品：已插好芯片、已接好 VCC/GND，**故意留空 1~2 根关键导线**，学生补完即通过 `Grader.grade`；
- `solution.wires` 给教师/自测用（`generate` 后把 solution 接上应 100% 通过打分）。

### 5.4 `DLab.AdvisorPanel`（ai-ui）

```js
new DLab.AdvisorPanel({ container, engine, wireLayer, hud, onState })
open() / close() / toggle()
runReview()        // → report（并渲染）
renderReport(report)
highlightIssue(issueId)   // 调 wireLayer.setJackAlert(issue.jacks)
clearHighlight()
loadQuizFile(file)        // Quiz.readTask → Persistence.importProject → 记录当前 task
runGrade()                // Grader.grade(engine, 当前 task) → 渲染得分
getSnapshot()             // { open, report, task, grade, highlighted }
destroy()
```

UI 要求：
- 侧栏从右侧滑出（宽 320~380 px），**不要遮挡面板主体**，可在 `#assistant` 容器里用 `position:fixed`；
- 顶部三个按钮：**审查电路** / **载入题目** / **打分**；下面依次是「问题列表」「题目信息」「打分结果」；
- 问题按 error → warn → info 排序；每条显示中文标题 + 建议；点击某条 → 高亮相关插孔（`is-alert`）；
- 空状态文案：`电路看起来没问题（未发现问题）` / `还没有载入题目`；
- 视觉红线：不得霓虹/渐变发光/扁平卡片风，跟现有工具栏同一套哑光金属语言（可参考 `styles/wires.css` 的 `.hud`）。

---

## 6. 测试要求

### 6.1 各人新增的套件

| 套件 | 命令 | 最低断言数 | 必须覆盖 |
| :-- | :-- | :-- | :-- |
| `tests/wireRouting.selftest.cjs` | `node tests/wireRouting.selftest.cjs` | ≥ 30 | §3.3 的 7 条不变量 + 候选顺序 + 代价函数单调性 + 性能实测 |
| `tests/advisor.selftest.cjs` | `node tests/advisor.selftest.cjs` | ≥ 25 | 每个 code 至少 1 个正例 + 1 个反例；只读性；真实几何下不抛错 |
| `tests/grader.selftest.cjs` | `node tests/grader.selftest.cjs` | ≥ 20 | 打分正确/错误各一组、开关恢复、3 个模板生成 + 导入校验 + solution 满分 |
| `build/ui-assistant.check.cjs` | `node build/ui-assistant.check.cjs` | ≥ 15 | 真实点击「审查」→ 面板出现条目；点击条目 → 插孔加 `is-alert`；载入题目 → 状态栏/侧栏更新；打分 → 分数渲染 |
| `build/ui-viewport.check.cjs` | `node build/ui-viewport.check.cjs` | ≥ 20 | 滚轮放大/缩小、以光标为中心、上下限、`Ctrl+0` 复位、缩放后**点插孔仍能接上线**、缩放后 `hitTest` 仍准 |

### 6.2 既有套件的改动（**由 Lead 统一改，其他人不要碰**）

- `build/ui-preview.selftest.js`：第 4 组「贝塞尔路径符合契约公式」改为
  「单根线时 `d` 与 `WireRouting.buildPath` 逐字符一致」；新增「两根重合线 → 渲染出的 `d` 不同」。
- `build/ui-keyboard.check.cjs`：`clickWireMid` 改为按**渲染后的折线**取中点（不再用公式）。
- `build/verify-all.mjs`：追加 5 个新套件。
- `tests/browser-load.check.cjs`：追加新核心模块的加载检查。

> wire-ui 需要改 `build/ui-preview.selftest.js` 时，**先报给 Lead**；Lead 已经把上面两处改好了，wire-ui 只需在改完 `wireLayer` 后确认这两处断言仍然通过。

---

## 7. 汇报格式（每个人完成后 `send_message` 给 lead）

```
[<你的名字>] 完成
交付文件：<逐条列出，带行数>
契约符合性：<逐条对照 §x.y，写明实现了/偏差>
测试：<命令> → PASS=n FAIL=0（实测数字）
性能：<若有性能要求，给实测值>
未做/风险：<如实写>
```

---

## 8. 实施记录与已确认的口径偏差（Lead 于本轮收尾时补记）

本轮三个模块（wire-ui / ai-core / ai-ui）与 Lead 侧的视口模块全部完成，
验收命令 `node build/verify-all.mjs` → **20 / 20 套件通过**。
以下两处**已确认的口径偏差**与两处**测试脚本修正**记录在案。

### 8.1 §3.4 代价函数的两处工程口径（wire-ui，已确认采纳）

字面公式与 §3.3 的不变量无法同时满足，实现取以下口径（代码里已写明理由）：

1. **导线净距按「逐采样点累加」计罚**，而不是只取两条曲线的最小间距。
   原因：两线交叉时真实最小间距恒为 0，`max(0, C - min)` 会饱和成常数，
   候选之间失去梯度，优化器找不到能分开的走法（实测：只取 min 时
   10 个重叠场景只能分开 4 个；改为逐点累加后 8/8 达标）。
2. **插孔障碍只对「相对本线基准曲线新增覆盖」的插孔计罚**。
   原因：真实面板 288 孔、孔距仅 36~40，任意一根线的基准曲线都必然从若干
   插孔旁擦过（实测中位最近插孔距 ≈ 3.3）。若把 20 单位内的插孔全部计罚，
   基准代价恒不为 0，与 §3.3 第 2 条「无冲突即零改动」直接矛盾。

扣除基准项后，基准代价 = 导线重叠惩罚（+ 越界惩罚），为 0 即触发 §3.4 的
「基准代价为 0 直接返回基准」快速路径，与 §3.1「只有在真的发生重叠时才
整体上抬 / 下压 / 左右鼓出」一致。

### 8.2 §5.1 的两处判据扩展（ai-core，已确认采纳）

1. `RESET_HELD` 除契约写的 `~CLR` / `~PRE` 外，也覆盖 `~MR`
   （74LS160/161/194/273 的同功能端），否则「异步清零端接地」会漏报。
2. `ENABLE_FLOATING` 除契约关键词表外，额外精确匹配
   `~G2A` / `~G2B` / `~S` / `~EI` / `~1G` / `~2G`
   —— 这些是 74LS138/148/151/153 的低有效使能端，契约关键词表没列全；
   不补的话 74LS138「忘接地」会退化成普通输入悬空。

### 8.3 Lead 侧修掉的两个真实缺陷（不是测试脚本问题）

1. **面板比舞台高 18px 被裁掉 9px**（`src/app.js`）
   首帧 `fitPanel()` 执行时，`#timeline` 还没注入内容、`#toolbar` 的最终高度
   也还没定，算出来的舞台高度比最终值大 40 多像素；面板因此被 `#stage` 的
   `overflow:hidden` 从上下各裁掉 9px。被裁掉的插孔**点不到**，
   表现为「缩放后有些插孔点不动、滚轮也没反应」。
   修法：`fitPanel()` 改为幂等；时序条布局稳定后补一次 `refitPanel(app)`；
   并用 `ResizeObserver` 监听 `#stage`，舞台尺寸一变就自动纠正。
2. **坐标模型与实际生效的 transform 对不齐**（`src/ui/viewport.js`）
   `_apply()` 写进 style 的是四舍五入后的值（scale 四位、translate 两位），
   而坐标换算用的是未舍入的精确值，两者对不齐时「以光标为中心」的锚点会漂移。
   修法：引入 `_applied` 记录真正生效的那组数，坐标换算一律以它为准，
   并把 `this.scale/tx/ty` 归一到同一组数。

### 8.4 两处测试脚本修正（Lead 负责的文件）

1. `build/ui-viewport.check.cjs`：第 5/6/7 节的滚轮锚点由「放大前抓的插孔屏幕坐标」
   改为**舞台中心**。
   原因：缩放会改变面板的位置与大小，同一个屏幕坐标在缩放前后指向的面板位置
   完全不同；旧坐标在面板缩回 100% 之后会落到 `#stage` 之外，
   正好压在时序条的速度按钮上，而视口按设计**不接管工具栏/时序条/助教侧栏上的滚轮**
   （那是那些控件自己的滚动区）—— 于是表现为「滚轮没反应、缩放不回去」。
2. `build/cdp.mjs`：补 `resolveTempDir()` 绝对路径兜底，
   并给 `close()` 加超时与残留 Edge 进程清理。
   原因：受限运行时下 `os.tmpdir()` 会退化成相对路径 `"undefined\\temp"`，
   Edge 拿到它会静默起不来（表现为「等待 DevTools 端口超时」）；
   而浏览器被杀后 CDP 的 promise 永不 settle，会把事件循环抽干，
   导致 Node **静默退出 0**、连失败汇总都打不出来（exit code 还是 0，极有欺骗性）。

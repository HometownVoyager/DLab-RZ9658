# DLab 前端实现契约（CONTRACTS）

> 本文件是**并行开发的唯一接口基准**。所有模块必须严格遵守；如需变更，先通知 Lead。

## 0. 现状

- `Teaching App/SVG.SVG`（1207 行，viewBox 1800×1380）是**已完成的第一阶段产物**，是外观唯一真源，**只读，任何人不得修改**。
- 本阶段目标：把它变成可运行的前端应用，实现**基本接线逻辑**（插孔连线、通断、电平、显示、导入导出）。
- 参考图目录 `Reference Images/` 仅作外观校对，不参与代码。

## 1. 硬性技术约束

1. **零构建、零依赖**：纯原生 HTML/CSS/JS，不允许 npm 包、打包器、CDN。
2. **必须支持双击 index.html 直接运行（file:// 协议）**：
   - 因此**禁止 ES Module**（file:// 下 `<script type="module">` 与 import 会被 CORS 拦截）；
   - 也**禁止 fetch() 本地文件**（file:// 下被拦截）；
   - 一律使用**经典脚本 + 全局命名空间**。
3. 每个 JS 文件统一采用如下形态（浏览器与 Node 均可加载，便于自测）：

```js
// src/core/engine.js
(function (global) {
  'use strict';
  var DLab = (global.DLab = global.DLab || {});

  // ... 实现 ...

  DLab.Engine = Engine;            // 挂到命名空间
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

Node 自测写法（无 package.json，CJS 默认）：

```js
// tests/engine.selftest.cjs
globalThis.DLab = {};
require('../src/core/logic.js');
require('../src/core/chips.js');
require('../src/core/engine.js');
const { Engine } = globalThis.DLab;
```

4. 所有代码注释用中文；标识符用英文。UTF-8，LF。

## 2. 目录结构（最终形态）

```
Teaching App/
├── index.html                        # Lead：应用外壳（内联面板 SVG 容器 + 底部工具栏）
├── styles/
│   ├── app.css                       # Lead：视口/布局/工具栏
│   └── wires.css                     # wire-ui：飞线样式、悬停、选中
├── src/
│   ├── core/
│   │   ├── panelGeometry.generated.js  # geometry-pipeline 生成（插孔坐标表）
│   │   ├── logic.js                    # logic-engine：4 态逻辑原语 + 并查集网表
│   │   ├── chips.js                    # logic-engine：74 系列芯片行为模型（17 款）
│   │   ├── boardNets.js                # logic-engine：板内固定铜箔走线连通组
│   │   └── engine.js                   # logic-engine：Engine 类（唯一的仿真入口）
│   ├── panel/
│   │   ├── panel.annotated.svg         # geometry-pipeline 生成（带 data-jack 的可视预览）
│   │   └── panel.annotated.js          # geometry-pipeline 生成（DLab.panelSvg 字符串，供 index.html 注入）
│   ├── ui/
│   │   ├── wireLayer.js                # wire-ui：SVG 覆盖层 + 贝塞尔飞线渲染
│   │   ├── interaction.js              # wire-ui：点击插孔接线、拖拽预览、删除、悬停高亮
│   │   ├── persistence.js              # wire-ui：.dlab.json 导入导出（纯前端 Blob）
│   │   ├── hud.js                      # wire-ui：工具栏（颜色板、清空、导入导出按钮）与状态提示
│   │   ├── boardControls.js            # Lead：板载机械控件（16 自锁开关 + 6 轻触按键）命中区与点击
│   │   ├── chipTray.js                 # Lead：10 个 DIP 插座的命中区、插拔菜单、已插芯片视觉
│   │   └── timeline.js                 # timeline-ui：虚拟时间轴（运行/暂停/单步/速度/时钟使能）
│   ├── boardView.js                    # Lead：状态 → LED / 数码管的视觉映射
│   └── app.js                          # Lead：装配与启动
├── build/                            # geometry-pipeline：构建脚本（Node，仅开发期使用）
├── tests/                            # logic-engine：Node 自测
└── docs/
    ├── CONTRACTS.md                  # 本文件
    ├── panel-geometry.json           # geometry-pipeline 生成：插孔清单（人工核对用）
    └── wiring-demo.md                # Lead：验收演示接线步骤
```

## 3. 脚本加载顺序（index.html）

```html
<script src="src/core/panelGeometry.generated.js"></script>
<script src="src/core/logic.js"></script>
<script src="src/core/chips.js"></script>
<script src="src/core/boardNets.js"></script>
<script src="src/core/engine.js"></script>
<script src="src/ui/wireLayer.js"></script>
<script src="src/ui/interaction.js"></script>
<script src="src/ui/persistence.js"></script>
<script src="src/ui/hud.js"></script>
<script src="src/ui/boardControls.js"></script>
<script src="src/ui/chipTray.js"></script>
<script src="src/ui/timeline.js"></script>
<script src="src/boardView.js"></script>
<script src="src/app.js"></script>
```

`index.html` 结构（Lead 负责）：

```html
<div id="stage">                     <!-- 等比缩放的舞台 -->
  <div id="panel" data-panel-svg>    <!-- app.js 注入 DLab.panelSvg -->
    <svg id="wire-layer" viewBox="0 0 1800 1380" preserveAspectRatio="xMidYMid meet"></svg>
  </div>
</div>
<div id="toolbar" data-toolbar></div> <!-- hud.js 注入工具栏 -->
```

- `#panel` 内部：先注入面板 SVG（`position:relative`），再叠一层 `#wire-layer`（`position:absolute; inset:0`），两层同 viewBox，坐标天然对齐。
- `#wire-layer` 默认 `pointer-events:none`，其中命中区/飞线单独开启 `pointer-events:all`。

## 4. 插孔几何数据（panelGeometry.generated.js）

```js
(function (global) {
  var DLab = (global.DLab = global.DLab || {});
  DLab.geometry = {
    VIEWBOX: { width: 1800, height: 1380 },
    // 所有插孔，按 id 索引
    JACKS: {
      'sw:5K1': {
        id: 'sw:5K1',          // 唯一 ID，格式 '<module>:<label>'
        label: '5K1',          // 丝印原文
        moduleId: 'sw',        // 见下表
        x: 100.5, y: 1113.0,   // 绝对坐标（面板 viewBox 坐标系，保留 1 位小数）
        kind: 'driver',        // 'driver' | 'sink' | 'passive' | 'power' | 'ground'
        fixedNet: null         // 'VCC' | 'GND' | null（板内硬连接）
      }
      // ...
    },
    JACK_ORDER: ['sw:5K1', ...],   // 稳定顺序（按模块、按编号）
    MODULES: [ { id: 'sw', name: '逻辑电平输出', count: 16 }, ... ]
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

### 4.1 模块 ID 与丝印对照

| moduleId | 丝印/区域 | 插孔标签示例 |
| :-- | :-- | :-- |
| `probe` | 逻辑笔 | `P01` |
| `rc` | 电容电阻区 / 电位器 | `rc:1` `rc:2` `rc:3` |
| `led` | 发光二极管显示 | `4P1` … `4P16` |
| `seg1` … `seg8` | 数码管显示区 1/2（1~8 号管） | `A1`…`D1` `E1`…`DP1` |
| `devA` / `devB` | A / B 数电开发模块 | `A1`…`A14` `B1`…`B14` `E1`…`E16` `D1`…`D16` `F1`…`F20` `VCC` `GND` |
| `pulse` | 单脉冲输出区 | `6K1-` `6K1+` … `6K6-` `6K6+` |
| `clock` | 时钟输出区 | `1HZ` `2HZ` `4HZ` `8HZ` `1KHZ` `10KHZ` `1MHZ` `CONT`(连续脉冲) |
| `analyzer` | 逻辑分析仪 | `DCH0` … `DCH7` |
| `pwr` | 电源 +5V | `pwr:5V1` `pwr:5V2` |
| `gnd` | 接地 | `gnd:GND1` `gnd:GND2` |
| `sw` | 逻辑电平输出（16 位开关） | `5K1` … `5K16` |
| `mid` | 中间仪器列 | `SPK` `BEEP` `ACH1` `DDS` |

- 全部 ID 形如 `<module>:<label>`，同一模块内 label 重复时追加 `#2`、`#3`。
- `fixedNet`：所有 `pwr` 插孔 = `'VCC'`；所有 `gnd` 插孔、`devA:GND`、`devB:GND` = `'GND'`；`devA:VCC`、`devB:VCC` = `'VCC'`；其余 `null`。
- 坐标必须是**展开所有 `<use>` 模板后的绝对坐标**（`block-14pin`/`block-16pin`/`dev-module-common` 都是被 `use` 两次的模板，必须展开两次、分别归属 devA / devB）。

### 4.2 芯片插座 ↔ 插孔映射（引擎依赖）

插座 ID 与引脚映射规则：插座 `devA:UA`（14P）的第 n 脚 ↔ 插孔 `devA:A<n>`；`devA:UB` → `devA:B<n>`；`devA:UE`/`devA:UD`（16P）→ `devA:E<n>` / `devA:D<n>`；`devA:UF`（20P）→ `devA:F<n>`；devB 同理。**引脚号即丝印编号，无需另建映射表。**

## 5. 引擎 API（DLab.Engine）

```js
var engine = new DLab.Engine({ geometry: DLab.geometry });   // 唯一构造方式

// —— 导线 ——
engine.addWire({ id: 'w1', from: 'sw:5K1', to: 'devA:A1', color: '#ef4444' }); // 返回 wire；非法（同孔/未知孔）抛错
engine.removeWire('w1');
engine.getWires();                       // [{id, from, to, color}]

// —— 板载器件 ——
engine.setSwitch(1, 1);                  // 5K1..5K16，level: 0|1（对应拨杆上/下）
engine.getSwitch(1);
engine.pressPulse(1);                    // 6K1..6K6 单脉冲按键，产生一次正脉冲（含防抖，脉宽 200ms 逻辑）
engine.setPower(true);                   // 电源总开关（默认 true）
engine.setClockEnabled(true);            // 时钟输出区使能

// —— 芯片 ——
engine.mountChip('devA:UA', '74LS00');   // 插座 ID + 型号；型号不匹配插座规格抛错
engine.beginBatch() / engine.endBatch(); // H7 批量变更包装（见下）
engine.unmountChip('devA:UA');
engine.getChip('devA:UA');               // '74LS00' | null

// —— 仿真 ——
engine.step(nowMs);                      // 幂等推进（内部按 nowMs 计算时钟相位）
engine.getJackLevel('devA:A1');          // '0' | '1' | 'Z' | 'X'
engine.getState();
// {
//   jacks: { 'sw:5K1': '1', ... },      // 全量插孔电平
//   nets: [ { id:'net3', jacks:[...], level:'1', drivers:[...] } ],
//   leds: { '4L1': true, '5L1': false, ... },   // 发光二极管显示 4L1~4L16
//   swLeds: { '5L1': true, ... },                // 开关旁状态灯
//   segs: { 'seg1': { a:'0', ... }, ... },       // 数码管引脚原始电平
//   segOn: { 'seg1': { a:true, ... }, ... },     // 各段点亮布尔（已处理共阳/共阴/BCD译码）
//   digits: { 'seg3': '5', 'seg4': 'A', ... },   // 3~8 号内置译码字符（0~9 与 A~F；10~15 按 hex 字形显示为仿真假设）
//   pulses: { '6L1': false, ... },
//   shorts: [ { netId, level:'X', jacks:[...] } ],  // 短路/冲突告警
//   warnings: [ '...' ]                           // 中文提示
// }
engine.onStateUpdate(function (state) {});      // 订阅，engine.step() 后有变化时触发（返回退订函数）
//   退订契约：订阅返回函数必须与订阅成对调用。引擎持有监听器强引用，
//   动态订阅（随面板插拔产生/销毁的监听者）若不退订，会把整个 engine 实例
//   连同监听闭包一起钉在内存里（性能审查 §2.3 / §9.3）；页面生命周期单例
//   订阅者（app.js 各模块）不受影响。
engine.reset();                                 // 清空导线与芯片，开关归零
```

**变更类 API 自动重算（2026-10-30 P1 契约）**：`setSwitch / pressPulse / setPower / setClockEnabled / setProbeMode / setDds / adjustDds / cycleDdsParam / setPotRatio / mountChip / unmountChip` 执行成功后会自动 `step(this._now)` 重算一遍，`getState() / getJackLevel()` 立即反映变更，无需再手动推进（`step` 对同一时刻幂等，重复调用无害）。`addWire / removeWire / clearWires` 保持结构性操作：批量改线后由调用方自行 `step()`（UI 与判分器均按此约定，判分器 `setSwitch → step → getJackLevel` 的既有写法仍然正确）。

**批量收尾（2026-10-30 性能审查 H7 契约）**：`engine.beginBatch()` 与 `engine.endBatch()` 之间，上述变更类 API 不再逐步自动重算，由 `endBatch` 在深度归零且期间确有变更时统一补一次收尾 step——批量入口（工程导入 `persistence.applyProject`、真值表判分 `grader`）以此消掉 N×全量收敛放大（实测同一段导入序列 ~2270µs → ~490µs）。支持嵌套（按深度计数），必须配对（推荐 try/finally）。批量期间的 `getState()/getJackLevel()` 返回上一次收尾结果（延迟一致，与接线类 API 的既有约定同口径）；批量期间直接读取引擎原始开关状态（如 `getSwitch`）不受影响。旧引擎没有这对接口时调用方逐条推进（persistence/grader 均已做存在性守卫）。

**同刻记忆化（2026-10-30 性能审查 H1' 契约）**：`step()` 的结果只取决于 (时刻, 电气状态)——「同一时刻且未发生任何变更」的重入 step（P1 自动重算、UI refresh 显式 step 等）直接复用上次状态对象（实测 ~100µs/次 → ~0.1µs/次）。因此 **step/getState 返回的 state 对象在两次真实求值之间是同一引用，消费方必须只读**（全仓审计无写者；advisor「审查前后 getState() 逐字节一致」由同一引用恒成立）。变更类 API / 接线 / reset / 时刻推进都会使缓存失效并产生全新对象。

**mountChip 已占插座抛错（2026-10-30 审查 P5b 契约）**：对已插有芯片的插座再调 `mountChip` 一律抛错（报错含已插型号），不再静默换芯——静默换芯会无提示地清掉时序芯片的内部状态。更换芯片 = 先 `unmountChip` 再 `mountChip`（`ChipTray` 的「点型号即更换」流程已适配为先拔后插；工程导入在 `reset` 后重建，不受影响）。

**扬声器逻辑源测频（2026-10-30 审查 P3 契约）**：`state.analog.spk` 的 `driveHz` 在板载时钟 / DDS 直驱时仍为精确源频率（既有行为）；门电路等逻辑源驱动 SPK 时，引擎按跨步电平翻转实测频率——只有 0↔1 翻转计入、同一虚拟时刻只采样一次、最近 8 条边沿且间隔稳定（均值 ±50% 内）才给出 `driveHz`，同时附 `measuredHz`（该字段仅在逻辑源测频成功时出现）。边沿不足 / 间隔不稳（单脉冲、手动接线抖动）不给音调，只保留 sound.js 的电平边沿「嗒」声。假设（已记录）：实测频率超过采样 Nyquist（1/(2×步长)）时不可信，按实测值发声；时序芯片时钟脚场景由 P2 混叠告警覆盖。

**UI 侧推进分工（2026-10-30 性能审查 H8 补充）**：Timeline 接管推进期间（`timeline.isOwner()`），Interaction 的 rAF 循环不再每帧 `engine.step`（状态已由 Timeline 推进到同一虚拟时刻，重复 step 为纯幂等重算）；接线 / 撤销 / 导入后的电气重算由 `Interaction.refresh()` 重绘导线时显式补一次无参 `step()` 承担。Timeline 未接管时 Interaction 保持每帧按真实时间推进的既有行为。

**混叠告警（2026-10-30 P2 契约）**：引擎按电平采样推进，当时钟 / DDS 周期小于 2×实际步长时，`warnings` 给出「混叠告警：…请改用 ≤N Hz 的时钟、单脉冲按键，或降低时间倍率」。实际步长由 `step()` 观测（0 < Δt ≤ 500ms 时更新，默认 10ms，`reset()` 恢复默认）；检测范围 = 已插时序芯片（74LS74/112/160/161/194/273）时钟脚所在网，来源限「已使能的时钟输出孔」与「幅度 ≥ TTL 阈值的 DDS 输出孔」；断电时不告警。（2026-10-30 性能审查 P7：观测逻辑本日实际接线生效——此前版本 `_stepDtMs` 恒为默认 10ms；固定 10ms 步长推进下行为与此前完全一致，仅粗粒度 / 变步长推进时告警阈值随实测自适应，测试组 17 锁定。）（H2 缓存注记：`_collectAliasWarnings` 命中缓存时返回引擎内部共享数组，消费方只读；仅 `_buildState` 消费，若未来开放外部消费须先拷贝。）

### 5.1 4 态逻辑语义

- `'0'` 强低、`'1'` 强高、`'Z'` 悬空（TTL 输入悬空按 `1` 处理但逻辑笔显示 Z）、`'X'` 冲突（强 1 与强 0 短接）。
- 同一连通网（导线 + 板内 fixedNet 合并）内：有强驱动取驱动值；强驱动冲突 → `'X'`；无驱动 → `'Z'`。
- `VCC` 网恒为 `'1'`，`GND` 网恒为 `'0'`；两者被导线短接 → 整板 `X` + `shorts` 告警。

### 5.2 芯片库（logic-engine 负责）

- 14P（UA/UB，9 款）：`74LS00` `74LS02` `74LS04` `74LS08` `74LS21` `74LS30` `74LS32` `74LS74` `74LS86`
- 16P（UE/UD，11 款）：`74LS47` `74LS48` `74LS112` `74LS138` `74LS148` `74LS151` `74LS153` `74LS160` `74LS161` `74LS194` `74LS283`
- 20P（UF，1 款）：`74LS273`

**共 21 款**（`Chips.list()` 返回字典序全表）：14P 9 款 / 16P 11 款 / 20P 1 款。

**LCD 菜单映射（2026-10-30 审查新增）**：真实面板 LCD「芯片真值表」菜单当前展示 `7421 / 7430 / 7447 / 7448`（不带 LS 前缀）。仿真库按库内惯例以 LS 前缀注册为 `74LS21 / 74LS30 / 74LS47 / 74LS48`，一一对应；后续固件往菜单加新型号时按同一规则补充注册。

**74LS47 / 74LS48 段码来源（已核数据手册）**：两型号对 0~15 的显示图形完全相同，仅输出极性相反（47 低有效 OC 输出点亮输出 `0`，48 高有效点亮输出 `1`）。来源：Renesas HD74LS47 Function Table（REJ03D0410 Rev.3.01 p2）×eepw 7448 真值表，交叉一致。注意 6 = c~g 段（a、b 不亮）、9 = a,b,c,f,g 段（d、e 不亮）；输入 10~14 显示「鉴定输入条件」的独特图形、15 全灭。模型把 4 脚（~BI/RBO）仅当输入：动态灭零时 RBO 不反向驱动，级联灭零需调用层处理。

每个型号声明 `{ model, package, pins, vccPin, gndPin, pinNames, eval(pinLevels, ctx) }`，引脚定义严格按数据手册（低有效端名前加 `~`）。

**NE555 不注册**：本实验箱只有 14P/16P/20P 三种 DIP 插座，没有 8 脚插座，8 脚器件物理上插不进去。这是「实体还原」原则的直接推论，不是遗漏。

**引脚号冲突的如实记录**（接实物前必须以 `pinNames` 为准）：

| 型号 | 冲突情况 | 本项目取值 |
| :-- | :-- | :-- |
| `74LS112` | 公开资料至少 3 套互相矛盾的排布；且 74LS112 / 74LS76 / 74HC112(CMOS) 三者互不兼容 | 1=~1CLR 2=1J 3=1K 4=1CLK 5=~1PRE 6=1Q 7=~1Q 8=GND 9=~2Q 10=2Q 11=~2PRE 12=2CLK 13=2J 14=2K 15=~2CLR 16=VCC |
| `74LS194` | Nexperia 74HC194(CMOS) 把并行输入放 3~6、输出放 12~15，与 TTL 版不兼容 | 经典 TTL 版：3~6=Q0~Q3，15~12=D0~D3，9/10/11=S1/S0/CLK |
| `74LS161` | `~PE` / RCO 引脚号有两种公开版本 | 9=LOAD、15=RCO、11~14=Q3~Q0 |

两处保守取舍：74LS160 同步置数若置入 10~15（数据手册标为非法状态）钳到 0；74LS112 的 `~PRE` 与 `~CLR` 同时有效时取「置位优先」，与库内既有 74LS74 一致。

### 5.3 板内铜箔走线（DLab.BoardNets）

```js
DLab.BoardNets = {
  buildGroups(geometry),   // → { groups: [{id, jacks:[...]}], diagnostics: [...] }
  GROUPS,                  // 由 buildGroups 推导；真实几何下为 []
  MODULE_ORIGINS, TRACES_14, TRACES_16, TRACES_20
}
```

**推导结论：真实几何下 GROUPS 为空集。** 两条硬事实：

1. 三个插座模板的走线（14/16/20 条）全部解析后，**没有任何两条共享落点**（终点唯一数分别 14/14、16/16、20/20）。每条走线都是「一个金孔 → 插座内一个引脚」的单线，金孔之间没有铜箔互连。
2. 「插座引脚插孔」与「引出金孔」在 geometry 里是**同一个插孔 id**（devA/devB 各 82 孔 = 14+14+16+16+20+VCC+GND），所以「引脚 ↔ 金孔」是恒等映射，不产生额外连通关系。

把 A13/A12 这类相邻金孔硬拼成一组会造成「不插芯片也把相邻引脚短路」的虚假连通，违反「不凭空发明」的红线。因此如实输出空组，并在 `diagnostics` 里保留逐孔推导留痕。机制不是写死返回 `[]`：一旦几何或走线表出现多孔共享落点，`buildGroups()` 会自动产出非空分组，引擎无需改动。

引擎接入：`_buildBoardNets()` → `Netlist._union` 合并；`removeWire` / `clearWires` / `reset` 三处补回（它们会触发并查集从零重建）。`getState()` 新增 `boardNetGroups` 字段（只增不改）。`DLab.BoardNets` 缺失时引擎行为与之前完全一致。

## 6. 持久化格式（.dlab.json）

```json
{
  "format": "dlab-project",
  "version": 1,
  "savedAt": "2026-10-28T14:00:00.000Z",
  "power": true,
  "switches": { "5K1": 1, "5K2": 0 },
  "chips": { "devA:UA": "74LS00", "devB:UB": null },
  "wires": [ { "id": "w1", "from": "sw:5K1", "to": "devA:A1", "color": "#ef4444" } ],
  "probeMode": "TTL",
  "dds": { "freqHz": 1000, "amplitudeV": 5, "waveform": "square", "sel": "freq" },
  "potRatio": 0.5
}
```

- 导出：`Blob + a[download]`，文件名 `dlab-YYYYMMDD-HHmm.dlab.json`。
- 导入：`<input type="file" accept=".json,.dlab.json">` + `FileReader`，**必须校验** `format`/`version`/插孔 ID 是否存在，非法时中文报错且不破坏当前工程。
- 兼容未来字段：未知字段忽略，缺失字段取默认值。
- 板载仪器三字段（`probeMode` / `dds` / `potRatio`）为 v1 增量可选字段：旧版本文件没有它们也照常导入；
  单个值非法只降级为中文警告（如「逻辑笔模式 "LSB" 非法，已按 TTL 处理」），不阻止整份文件导入。

## 7. UI 约定（wire-ui）

- 覆盖层 `#wire-layer` 内容分三层（`<g>`）：`#wire-shadow`、`#wire-paths`、`#jack-hits`。
- 命中区：每个插孔一个 `<circle r="14" data-jack="<id>" fill="transparent" pointer-events="all">`。
- 飞线路径：`M x1 y1 C x1 (y1+sag) x2 (y2+sag) x2 y2`，`sag = min(90, dist*0.28)`；线宽 3.2，`stroke-linecap="round"`，`fill="none"`。
- 导线颜色板（hud）：`#ef4444` 红(VCC)、`#1f2937` 黑(GND)、`#3b82f6` 蓝(CLK)、`#eab308` 黄、`#22c55e` 绿、`#f97316` 橙、`#a855f7` 紫。
- 交互：点击插孔 → 进入连线态（该孔高亮 + 跟随鼠标的预览线）→ 点击另一插孔完成；再次点击同一孔或按 `Esc` 取消；右键导线删除；`Delete` 删除当前选中导线；`Ctrl+Z` 撤销最近一次接线操作。
- 悬停插孔：`r` 放大到 18 + 高亮描边；悬停导线：线宽 5 + 两端插孔同时高亮。
- 状态提示条：显示当前选中孔、最近操作、短路告警（`shorts` 非空时红色闪烁提示）。
- **视觉红线**：不得给面板加霓虹/渐变发光/扁平卡片风；飞线要像真实杜邦线（柔和阴影、轻微下垂）。

## 8. 验证方式

- **引擎**：`node tests/engine.selftest.cjs` 必须全绿，覆盖：导线连通、VCC/GND 短接告警、开关→LED 联动、74LS00 与非门真值表、74LS74 上升沿触发、导入导出往返。
- **几何**：`node build/verify.mjs` 必须报告「插孔总数 ≥ 280、无重复 ID、无缺失坐标」，并输出 `docs/panel-geometry.json`。
- **视觉**：`node build/shot.mjs` 用本机 Edge 无头截图（`--headless=new --screenshot`），产出 `artifacts/panel.png`，与 `SVG.SVG` 原图逐区对照，**面板像素不得有位移**。
- **运行态**：`node build/app-shot.mjs` 给真实运行的 `index.html` 截图，产出 `artifacts/app.png`（启动态）与 `app-wired.png`（插芯片 + 接线的演示态），顺带断言启动无报错。
- 手工验收：双击 `index.html` → 能接线、能点开关、能插芯片、能导出再导入还原。

## 9. 分工与写入范围（互不重叠）

| 成员 | 写入范围 | 交付 |
| :-- | :-- | :-- |
| **Lead** | `index.html`、`styles/app.css`、`src/app.js`、`docs/CONTRACTS.md`、`docs/wiring-demo.md`、`Construct Plan.md` | 应用外壳、装配、计划更新、集成验收 |
| **geometry-pipeline** | `build/`、`src/panel/`、`src/core/panelGeometry.generated.js`、`docs/panel-geometry.json` | 插孔坐标表 + 注释版 SVG + 校验脚本 |
| **logic-engine** | `src/core/logic.js`、`src/core/chips.js`、`src/core/engine.js`、`tests/` | 仿真引擎 + Node 自测全绿 |
| **wire-ui** | `src/ui/`、`styles/wires.css` | 飞线渲染、接线交互、导入导出、工具栏 |

- 任何人**不得修改** `SVG.SVG` 与 `Construct Plan.md`；
- 需要契约变更（字段/函数签名）必须先 `send_message` 通知 Lead，由 Lead 更新本文件后广播；
- 只写自己范围内的文件；发现别人文件有 bug，报告给 Lead，不要直接改。

## 10. 里程碑顺序

1. **M1 几何**：`panelGeometry.generated.js` + `panel.annotated.js` 就绪（其他人可先用 3~5 个手写桩数据开工）。
2. **M2 引擎**：`DLab.Engine` 可 new、可 addWire、可 getState。
3. **M3 交互**：点击两孔成线、可见飞线。
4. **M4 集成**：Lead 装配 index.html + app.js，跑通演示接线，截图验收。
## 11. UI 模块导出 API（Lead 的 src/app.js 依赖，务必严格实现）

所有类挂在 `DLab` 命名空间下，构造函数签名固定：

```js
// src/ui/wireLayer.js
DLab.WireLayer = class WireLayer {
  constructor(svgEl, geometry)          // svgEl = #wire-layer，geometry = DLab.geometry
  render(wires)                         // wires: [{id, from, to, color}]
  setJackHover(jackId, on)              // 高亮单个插孔
  setWireHover(wireId, on)              // 高亮单根导线（含两端插孔）
  setSelectedWire(wireId)               // 选中态（null 取消）
  setSelectedJack(jackId)               // 连线起点态（null 取消）
  setPreview(fromJackId, clientX, clientY)  // 拖拽预览曲线；fromJackId 为 null 时清除
  setVisible(on)                        // 透视面板：隐藏/显示所有飞线
  hitTest(clientX, clientY)             // → { type:'jack', jackId } | { type:'wire', wireId } | null
  screenToSvg(clientX, clientY)         // → {x, y}
}

// src/ui/interaction.js
DLab.Interaction = class Interaction {
  constructor({ engine, wireLayer, hud, geometry, onState })
  start()                               // 绑定事件 + 启动 rAF 刷新循环
  stop()
  undo()                                // 撤销最近一次接线操作，返回是否成功
  redo()                                // 重做上一次被撤销的操作，返回是否成功
  canUndo() / canRedo()                 // 撤销/重做栈是否非空（工具栏按钮置灰用）
  // 快捷键：Ctrl+Z 撤销；Ctrl+Y 或 Ctrl+Shift+Z 重做
  // 新操作会清空重做栈；导入工程会同时清空两个栈
}

// src/ui/persistence.js
DLab.Persistence = {
  exportProject(engine),                // → 触发下载
  buildProject(engine),                 // → 工程对象（不下载，便于测试）
  importProject(file, engine)           // → Promise<{ok:boolean, message:string}>
}

// src/ui/boardControls.js —— 板载机械控件交互层（逻辑电平开关 + 单脉冲按键）
DLab.BoardControls = class BoardControls {
  constructor({ engine, panelSvg, wireLayer, geometry, hud, onState })
  toggleSwitch(key)              // key = '5K1'..'5K16'，翻转 0↔1，返回新电平；非法返回 -1
  setSwitch(key, level)          // 直接设定电平，返回是否成功
  pressPulse(key)                // key = '6K1'..'6K6'，触发单脉冲，返回本次是否真的触发
  syncVisuals()                  // 引擎开关状态 → 键帽机械位移 + aria-pressed
  setEnabled(on)                 // 屏蔽/恢复点击
  getSnapshot()                  // → { switches: {5K1:{x,y}}, pulses: {6K1:{x,y}} }
  destroy()                      // 解绑事件与清理定时器
}

// src/ui/chipTray.js —— 芯片插座交互层（10 个 DIP 插座的命中区、插拔菜单、芯片本体）
DLab.ChipTray = class ChipTray {
  constructor({ engine, wireLayer, geometry, hud, onChange })
  openMenu(socketId)             // 在插座旁弹出兼容型号菜单，返回是否成功
  closeMenu()
  mount(socketId, model)         // 插芯片；封装不匹配由引擎拒绝，这里转中文提示并返回 false
  unmount(socketId)              // 拔芯片，返回是否成功
  syncVisuals()                  // 引擎「插座→型号」→ 面板芯片本体（导入工程后必须调用）
  getSnapshot()                  // → { sockets: { 'devA:UA': {x,y,w,h,pins,model,painted} }, chips, menuSocket }
  destroy()
}
// 静态：ChipTray.AREAS / ChipTray.MODULE_ORIGINS / ChipTray.DESCRIPTIONS
// 菜单只列封装匹配的型号：14 脚插座不出现 16/20 脚芯片，从入口杜绝插错。

// src/ui/timeline.js —— 虚拟时间轴（时序控制条）
DLab.Timeline = class Timeline {
  constructor({ engine, container, onState, dom })
  start() / stop()               // 启停 rAF 循环；start 后即持有推进权（isOwner）
  setRunning(on) / isRunning()   // 运行 / 暂停（暂停时虚拟时间冻结，时钟与计数器停摆）
  toggleRunning()
  stepOnce()                     // 手动推进一拍（虚拟时间 +10ms），暂停态也可用
  resetTime()                    // 虚拟时间归零并重新求值（不清导线、不清芯片）
  setSpeed(n) / getSpeed()       // 虚拟时间倍率 1 / 10 / 100
  setClockEnabled(on) / isClockEnabled()
  getVirtualTime() / getSnapshot()
  setEngineStepper(fn) / getEngineStepper() / getOriginalStep()
  getLastError()
}
// 静态：Timeline.STEP_MS(10) / MAX_STEPS_PER_FRAME(200) / SPEED_STEPS / DEFAULT_SPEED / DomAdapter
//       + STEP_BUDGET_MS(7) / MAX_BACKLOG_MS(2000)（2026-10-30 性能审查 H6：每帧给 step 的
//       真实时间预算，超出的积压留给后续帧并封顶；构造 options.frameBudgetMs 可覆盖，0 = 禁用
//       预算只留 200 拍兜底。重载电路最坏帧从 46~116ms 收敛到预算附近）。
// 关键：Timeline 在构造时缓存引擎原始 step，因此 app.js 给 engine.step 打的补丁拦不住它。

// src/ui/hud.js
DLab.Hud = class Hud {
  constructor(containerEl, handlers)    // containerEl = #toolbar
  // handlers: { onColor(color), onClear(), onImport(file), onExport(),
  //             onUndo(), onRedo(), onToggleWires(visible) }
  setColor(color)
  setStatus(text, level)                // level: 'info' | 'warn' | 'error'
  setSelectedJack(jackId)               // 显示当前选中孔，null 清除
  setWireCount(n)
  setShorts(shorts)                     // 短路告警
}

// src/ui/sound.js —— 板载音频（WebAudio 合成；Node 下为静默空实现）
DLab.Sound = {                       // 单例
  supported() / ensure() / unlock(),  // unlock 必须在用户手势里调用（自动播放策略）
  setMuted(on) / getMuted(),
  syncAnalog(analog),                 // 引擎 state.analog → 蜂鸣器连鸣 / 扬声器频率 / 直流嗒声
  thump() / beep(ms, hz)              // 一次性音效（点击试听用）
}

// src/ui/instruments.js —— 板载仪器交互层（逻辑笔 SW1 / 信号源 2SS1 / 电位器 / 示波器窗口 / 声纹）
DLab.Instruments = class Instruments {
  constructor({ engine, wireLayer, boardView, hud, geometry, onState })
  toggleScope()                  // 开关示波器窗口（RUN 灯 5DL1 随动）
  playBeepRipple(ms)             // 播放一次蜂鸣器声纹动画（点击试用层调用）
  syncVisuals(state)             // 引擎状态 → 滑块 / 指针 / 读数 / 声纹 / 窗口（applyState 每帧调用）
  getSnapshot() / destroy()
}
// 静态纯函数（Node 可测）：deriveAnchors(geometry) / formatFreq(hz) / waveName(w) /
//   ddsAngle(dds) / ddsReadoutText(dds)；常量 POT_WHEEL_STEP(0.05) / POT_CLICK_STEP(0.1)
// 命中区挂在 #wire-layer 内、位于 #jack-hits 之下（插孔点击永远优先）；
// 滚轮事件 stopPropagation，避免与 viewport 缩放打架；方向约定：向上滚 = 顺时针 = 增大。
// 覆盖层分组顺序：#wire-shadow → #wire-paths → #board-instruments → #jack-hits
//   → #wire-preview → #board-controls → #tap-feedback（后两者由各自模块 append）。

// src/ui/tapFeedback.js —— 点击试用层（点 LED 亮一下 / 点蜂鸣器叫一声；对引擎只读）
DLab.TapFeedback = class TapFeedback {
  constructor({ engine, wireLayer, boardView, hud, geometry, applyState, onScope, onBuzzerRipple })
  fire(tap)                      // 'led:4L1' | 'seg:seg3' | 'buzzer' | 'spk' | 'dds' → 播放一次演示
  getSnapshot() / destroy()
}
// 独立性红线：本层绝不调用任何 engine.set*/step，展示结束按 engine.getState() 恢复现场。
// 展示期间用 boardView.holdLed(key,true)/holdSeg(segId,true) 挂起 update() 刷写——
// 时序循环每帧都会 applyState，不挂起的话试点亮会在一帧内被打回原形（肉眼不可见）。
// 挂起守卫语义（boardView，踩过的坑）：hold 期间 setLed 只拦「熄灭」写、setSegment 只拦
// 「会熄灭笔段」的写，点亮写永远放行 —— 因此先 hold 再 set 的顺序点不亮（点亮写被吃掉，
// 曾导致试点亮完全无效），必须先 set 再 hold；守卫放宽后两种顺序都安全，但依旧约定
// 「先点亮、再挂起」。回归：build/ui-tap-flash.check.cjs（真实鼠标 + 运行中的时序循环）。

// src/app.js（Lead 实现）装配顺序
// 1. 注入 DLab.panelSvg 到 #panel
// 2. new DLab.Engine({ geometry: DLab.geometry }) / new DLab.WireLayer(#wire-layer, ...)
// 3. new DLab.Hud(#toolbar, 转发回调) → new DLab.BoardView(panelSvgEl, ...)
// 4. new DLab.BoardControls(...) / new DLab.ChipTray(...)
// 5. 定义 app.applyState(state)：boardView.update + boardControls.syncVisuals + chipTray.syncVisuals
//    + instruments.syncVisuals(state) + Sound.syncAnalog(state.analog)
// 5.5 new DLab.Instruments({..., onState: applyState})（boardControls/chipTray 之后、Timeline 之前）
// 5.6 new DLab.TapFeedback({..., applyState, onScope, onBuzzerRipple})
// 5.7 document pointerdown（捕获）→ Sound.unlock()（自动播放策略要求手势后建/恢复 AudioContext）
// 6. new DLab.Timeline({ engine, container: #timeline, onState: applyState })
// 7. 给 engine.step 打「时间源改写」补丁（见下）
// 8. new DLab.Interaction({..., onState: applyState }).start()
// 9. timeline.start() + timeline.setRunning(true)（默认运行，与实物上电即走一致）

// engine.step 补丁的正确写法（Lead 踩过的坑）：
//   Timeline 接管后，引擎时间只能由虚拟时间决定，否则 Interaction 的 rAF 循环会用
//   performance.now() 覆盖虚拟时间，计数器/触发器永远走不动。
//   但补丁**不能空转**——点击开关 / 导入工程 / 测试脚本都靠 step(performance.now()) 强制重算，
//   直接返回旧状态会让电平永不刷新（曾导致「5K1 点了没反应、4L1 不亮、短路检不出」）。
//   正确做法是把外部调用重定向到当前虚拟时刻：
//     var rawStep = engine.step;
//     engine.step = function (ms) {
//       return rawStep.call(engine, timeline.isOwner() ? timeline.getVirtualTime() : ms);
//     };
```

**wire-ui 注意**：`Interaction` 内部需要调用 `engine.addWire / removeWire / setSwitch / mountChip / step / getState / onStateUpdate`；Hud 的颜色选择结果通过 `wireLayer` 与 `interaction` 共享（由 Interaction 持有一个 `currentColor`，Hud 的 onColor 回调里通过 `interaction.setColor(c)` 传入——请给 Interaction 补一个 `setColor(color)` 方法）。

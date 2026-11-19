# DLab 外部 Agent 开发者指南 (Agent Dev Guide)
## —— 虚拟数电实验箱体系架构、插孔寻址、仿真 API 与工程生成全量规范

> **面向读者**：大型语言模型（LLM Agent）、自动化代码生成 Agent、自动出题与批改机器人、数电虚拟教学辅导程序。
> **目标**：为外部智能体提供完整、零歧义的接口契约与操作指导，支持 Agent 自主构建电路工程、排查故障、验证真值表及辅助学生完成实验。

---

## 1. 核心架构与运行环境

### 1.1 项目定位与运行约束
DLab 是面向《数字系统原理》《数字电子技术》等高校核心课程的**实体硬件实验箱（南京润众科技 RZ9658 数字电路实验平台）高保真数字孪生**。
- **零构建、零依赖（Zero-Dependency & Zero-Build）**：整个工程无需 npm 安装，无打包器构建过程。双击 `index.html` 即可在任何现代浏览器中运行（包括离线 `file://` 协议）。
- **无 ES Module、无本地 fetch**：由于支持直接双击运行，所有脚本采用经典自执行函数（IIFE）与全局命名空间 `DLab` 组织，严禁在运行时引入 ES Module 或 `fetch()` 读取本地文件。
- **双端同构（Browser & Node.js）**：所有核心逻辑模块（`logic.js`、`chips.js`、`boardNets.js`、`engine.js`、`advisor.js`、`grader.js`、`quiz.js`）均可在 Node.js 无 DOM 环境中以同步 CommonJS 方式直接 `require` 运行，便于自动化批改与集成测试。

### 1.2 Node.js 环境加载规范
外部 Agent 在 Node.js 环境下对电路进行仿真、审查或批改时，推荐按如下依赖顺序初始化：

```javascript
// 准备全局命名空间
globalThis.DLab = {};

// 按顺序加载核心模块
require('../src/core/panelGeometry.generated.js'); // 几何插孔表
require('../src/core/logic.js');                   // 4态逻辑原语与并查集网表
require('../src/core/chips.js');                   // 21款74系列芯片模型
require('../src/core/boardNets.js');               // 板内铜箔固定走线模型
require('../src/core/wireRouting.js');             // 贝塞尔飞线避让路由
require('../src/core/engine.js');                  // 仿真执行引擎 (DLab.Engine)
require('../src/core/advisor.js');                 // AI 助教：接线审查与诊断
require('../src/core/grader.js');                  // AI 助教：真值表自动打分
require('../src/core/quiz.js');                    // AI 助教：自动出题系统

const { Engine, Chips, Logic, Advisor, Grader, Quiz } = globalThis.DLab;
```

---

## 2. 全板插孔寻址拓扑字典 (Jack Addressing Dictionary)

全板共有 **20 个功能模块、288 个标准测试插孔**。每个插孔具有唯一的全局标识符，格式严格遵循：
`<moduleId>:<label>`

### 2.1 电源、接地与板载激励源
| 模块 ID (`moduleId`) | 插孔 ID (`id`) | 丝印名称 | 类型 | 电气属性与说明 |
| :--- | :--- | :--- | :--- | :--- |
| `pwr` | `pwr:5V1`, `pwr:5V2` | 5V1, 5V2 | `power` | 稳压 +5V 电源输出（逻辑强 '1'） |
| `gnd` | `gnd:GND1`, `gnd:GND2` | GND1, GND2 | `ground` | 模拟地 / 数字地（逻辑强 '0'） |
| `sw` | `sw:5K1` ~ `sw:5K16` | 5K1 ~ 5K16 | `driver` | 16 位逻辑电平输出（点按开关切换 '0'/'1'） |
| `pulse` | `pulse:6K1-` ~ `pulse:6K6-` | 6K1- ~ 6K6- | `driver` | 单脉冲负跳变（常态为 '1'，按键产生 200ms 负脉冲至 '0'） |
| `pulse` | `pulse:6K1+` ~ `pulse:6K6+` | 6K1+ ~ 6K6+ | `driver` | 单脉冲正跳变（常态为 '0'，按键产生 200ms 正脉冲至 '1'） |
| `clock` | `clock:1HZ` ~ `clock:1MHZ`, `clock:CONT` | 1HZ, 2HZ, 4HZ, 8HZ, 1KHZ, 10KHZ, 1MHZ, CONT | `driver` | 连续方波时钟源（时钟使能开启时按固定周期交替输出 '1'/'0'） |

### 2.2 发光二极管与状态指示灯
| 模块 ID | 插孔 ID | 对应丝印灯位 | 说明 |
| :--- | :--- | :--- | :--- |
| `led` | `led:4P1` ~ `led:4P16` | `4L1` ~ `4L16` | 逻辑电平指示灯。高电平 '1' 点亮（红灯），低电平/悬空熄灭。 |
| `sw` | （通过开关关联） | `5L1` ~ `5L16` | 开关状态指示灯。开关输出高时黄红点亮。 |
| `pulse` | （通过脉冲关联） | `6L1` ~ `6L6` | 脉冲动作指示灯。脉冲处于高电平活动期时点亮。 |

### 2.3 数码管显示单元 (Display Areas)
实验箱包含 **8 只共阴/共阳数码管**，分为两个独立显示区：

#### ① 数码管显示区 1（1 号管、2 号管）—— 纯段码直驱（不译码）
- **1 号管（seg1）为「共阳数码管」**：内部阳极接 +5V。引出 8 个段输入插孔：`seg1:A1`、`B1`、`C1`、`D1`、`E1`、`F1`、`G1`、`DP1`。
  - **点亮规则**：**低电平 '0' 点亮**；高电平 '1' 或悬空 'Z' 熄灭。
- **2 号管（seg2）为「共阴数码管」**：内部阴极接地。引出 8 个段输入插孔：`seg2:A2`、`B2`、`C2`、`D2`、`E2`、`F2`、`G2`、`DP2`。
  - **点亮规则**：**高电平 '1' 点亮**；低电平 '0' 或悬空 'Z' 熄灭。

#### ② 数码管显示区 2（3 号管 ~ 8 号管）—— 内置 6 位 BCD 译码器驱动
每只数码管内置专用 BCD/十六进制译码驱动器，每组引出 **5 个插孔**：
- `segX:AX`：二进制输入位 0（最低位 LSB，权值 $2^0 = 1$）
- `segX:BX`：二进制输入位 1（权值 $2^1 = 2$）
- `segX:CX`：二进制输入位 2（权值 $2^2 = 4$）
- `segX:DX`：二进制输入位 3（最高位 MSB，权值 $2^3 = 8$）
- `segX:DPX`：独立小数点驱动孔（高电平 '1' 点亮 DP；注：5 号管位面板为 GND 环，无 DP 孔，容错处理）

**译码规则表**：
| 4位输入 (DCBA) | 十六进制值 | 对应显示字符 | 点亮的笔段 (a~g) |
| :---: | :---: | :---: | :--- |
| `0000` | 0 | **0** | a, b, c, d, e, f |
| `0001` | 1 | **1** | b, c |
| `0010` | 2 | **2** | a, b, d, e, g |
| `0011` | 3 | **3** | a, b, c, d, g |
| `0100` | 4 | **4** | b, c, f, g |
| `0101` | 5 | **5** | a, c, d, f, g |
| `0110` | 6 | **6** | a, c, d, e, f, g |
| `0111` | 7 | **7** | a, b, c |
| `1000` | 8 | **8** | a, b, c, d, e, f, g (全亮) |
| `1001` | 9 | **9** | a, b, c, d, f, g |
| `1010` | 10 | **A** | a, b, c, e, f, g |
| `1011` | 11 | **b** | c, d, e, f, g |
| `1100` | 12 | **C** | a, d, e, f |
| `1101` | 13 | **d** | b, c, d, e, g |
| `1110` | 14 | **E** | a, d, e, f, g |
| `1111` | 15 | **F** | a, e, f, g |
| 全部未接 (`ZZZZ`) | - | **（全灭）** | 笔段完全熄灭，避免悬空杂散发光 |

### 2.4 DIP 芯片插座与引脚映射
实验箱中部包含 A、B 两大通用数电开发模块（`devA` / `devB`），每个模块各提供 5 个标准圆孔 IC 锁紧插座：
| 插座 ID | 封装规格 | 支持芯片引脚数 | 对应侧边测试插孔 | 供电引脚常规定义 |
| :--- | :--- | :--- | :--- | :--- |
| `devA:UA` / `devB:UA` | DIP-14 | 14 脚 | `A1` ~ `A14` | 14 脚接 VCC，7 脚接 GND |
| `devA:UB` / `devB:UB` | DIP-14 | 14 脚 | `B1` ~ `B14` | 14 脚接 VCC，7 脚接 GND |
| `devA:UE` / `devB:UE` | DIP-16 | 16 脚 | `E1` ~ `E16` | 16 脚接 VCC，8 脚接 GND |
| `devA:UD` / `devB:UD` | DIP-16 | 16 脚 | `D1` ~ `D16` | 16 脚接 VCC，8 脚接 GND |
| `devA:UF` / `devB:UF` | DIP-20 | 20 脚 | `F1` ~ `F20` | 20 脚接 VCC，10 脚接 GND |
| 板内供电端 | - | - | `devA:VCC`, `devA:GND`, `devB:VCC`, `devB:GND` | 模块内部固定连接到对应 VCC/GND 网络 |

---

## 3. 工程文件规范 (.dlab.json Schema)

`.dlab.json` 是 DLab 前端导入与导出的唯一格式。外部 Agent 生成此 JSON 文件后，学生可直接在浏览器中「导入工程」一键还原完整接线、芯片和开关。

### 3.1 顶层字段规范
```json
{
  "format": "dlab-project",
  "version": 1,
  "meta": {
    "title": "实验工程标题",
    "description": "实验简要描述",
    "savedAt": "2026-10-29T17:30:00.000Z",
    "generator": "MyAI-Agent/v1.0"
  },
  "chips": {
    "devA:UA": "74LS00",
    "devA:UD": "74LS161"
  },
  "wires": [
    { "id": "w1", "from": "pwr:5V1", "to": "devA:A14", "color": "#ef4444" },
    { "id": "w2", "from": "gnd:GND1", "to": "devA:A7", "color": "#1f2937" }
  ],
  "switches": {
    "5K1": 1,
    "5K2": 0
  },
  "power": true,
  "clockEnabled": true,
  "task": null
}
```

### 3.2 导线色标规范 (Color Palette)
为保证与实体实验室接线习惯对齐，Agent 生成导线时应严格遵循工业标准颜色：
- **电源正极 (+5V)**：`#ef4444`（红色，必须用于 VCC）
- **接地 (GND)**：`#1f2937`（黑色/深灰，必须用于 GND）
- **时钟信号 (CLK)**：`#3b82f6`（蓝色）
- **控制/使能信号**：`#eab308`（黄色）
- **普通逻辑输入**：`#f97316`（橙色）或 `#a855f7`（紫色）
- **测量输出/数码管**：`#22c55e`（绿色）

---

## 4. 仿真执行引擎 API (DLab.Engine API)

### 4.1 构造实例
```javascript
const engine = new DLab.Engine({
  geometry: DLab.geometry, // 插孔几何索引
  pulseWidthMs: 200,       // 单脉冲保持宽度，默认 200ms
  isTTL: true              // 输入端悬空是否按 TTL 规范视为高电平 '1'，默认 true
});
```

### 4.2 导线操作
- `engine.addWire({ id?, from, to, color? })`：添加一条导线。两端不能为同孔，不能已存在重复导线。
- `engine.removeWire(wireOrId)`：按 ID 或对象删除导线。
- `engine.clearWires()`：清空全板飞线并保留板内走线。
- `engine.getWires()`：获取当前全部导线副本数组。

### 4.3 芯片插拔
- `engine.mountChip(socketId, model)`：在指定插座插入芯片（如 `mountChip('devA:UA', '74LS00')`）。引脚数必须与插座严格匹配。
- `engine.unmountChip(socketId)`：拔出插座上的芯片。
- `engine.getChips()`：获取当前插座映射字典对象 `{ 'devA:UA': '74LS00', ... }`。

### 4.4 开关、脉冲与时序控制
- `engine.setSwitch(n, level)`：设置开关 `5Kn`（$n in [1..16]$），电平为 `0` 或 `1`。
- `engine.getSwitch(n)`：读取开关 `5Kn` 当前状态（0 或 1）。
- `engine.pressPulse(n)`：按下单脉冲键 `6Kn`（$n in [1..6]$），启动 200ms 脉冲（含防抖）。
- `engine.setPower(on)`：设置主电源开关（true/false）。关闭时全板无驱动，各孔呈高阻 'Z'。
- `engine.setClockEnabled(on)`：开启或暂停时钟源输出。

### 4.5 步进与状态查询
- `engine.step(timeMs)`：推进虚拟时钟到指定时刻（毫秒），执行完整四态逻辑求值（最多 24 次迭代收敛）。
- `engine.getState()`：获取仿真状态快照。返回对象字段：
  - `jacks`：全量插孔当前电平映射 `{ [jackId]: '0' | '1' | 'Z' | 'X' }`。
  - `leds`：指示灯点亮状态 `{ '4L1': true, ... }`。
  - `swLeds`：开关状态灯 `{ '5L1': true, ... }`。
  - `segs`：数码管原始引脚电平。
  - `segOn`：各数码管 8 个笔段点亮布尔值 `{ seg3: { a:true, b:true, ..., dp:false }, ... }`。
  - `digits`：3~8 号 BCD 译码数码管解析出的字符（如 `{ seg3: '5', ... }`，未点亮为 `null`）。
  - `shorts`：短路与强冲突列表。
  - `warnings`：中文故障警报数组。

---

## 5. 21 款 74 系列芯片行为模型库

DLab 芯片库严格实现 21 款高校数电最常用 74LS 系列芯片（2026-10-30 审查按真实面板 LCD 菜单补齐 21/30/47/48 四款）：
| 封装 | 型号 | 功能描述 | 关键引脚 |
| :--- | :--- | :--- | :--- |
| **DIP-14** | `74LS00` | 四路二输入与非门 | 1A, 1B -> 1Y |
| | `74LS02` | 四路二输入或非门 | 1Y <- 1A, 1B |
| | `74LS04` | 六路反相器 | 1A -> 1Y |
| | `74LS08` | 四路二输入与门 | 1A, 1B -> 1Y |
| | `74LS21` | 双路四输入与门 | 1A..1D -> 1Y |
| | `74LS30` | 八输入与非门 | A..H -> Y |
| | `74LS32` | 四路二输入或门 | 1A, 1B -> 1Y |
| | `74LS74` | 双上升沿 D 触发器 | CLK, D, ~PRE, ~CLR -> Q, ~Q |
| | `74LS86` | 四路二输入异或门 | 1A, 1B -> 1Y |
| **DIP-16** | `74LS47` | BCD-七段译码器（低有效 OC 输出，点亮输出 0） | A..D, ~LT, ~BI, ~RBI -> a..g |
| | `74LS48` | BCD-七段译码器（高有效输出，点亮输出 1） | A..D, ~LT, ~BI, ~RBI -> a..g |
| | `74LS112` | 双下降沿 J-K 触发器 | ~CLK, J, K, ~PRE, ~CLR -> Q, ~Q |
| | `74LS138` | 3线-8线译码器 | A, B, C, G1, ~G2A, ~G2B -> ~Y0..~Y7 |
| | `74LS148` | 8线-3线优先编码器 | ~0..~7, ~EI -> ~A0..~A2, ~GS, ~EO |
| | `74LS151` | 8选1数据选择器 | D0..D7, A, B, C, ~S -> Y, W |
| | `74LS153` | 双4选1数据选择器 | 1C0..1C3, 2C0..2C3, A, B, ~1G, ~2G -> 1Y, 2Y |
| | `74LS160` | 同步十进制（BCD）计数器 | CLK, ~MR, ~LOAD, ENP, ENT, D0..D3 -> Q0..Q3, RCO |
| | `74LS161` | 同步四位二进制计数器 | CLK, ~MR, ~LOAD, ENP, ENT, D0..D3 -> Q0..Q3, RCO |
| | `74LS194` | 四位双向通用移位寄存器 | CLK, ~MR, S0, S1, SL, SR, D0..D3 -> Q0..Q3 |
| | `74LS283` | 四位超前进位二进制全加器 | A1..A4, B1..B4, C0 -> S1..S4, C4 |
| **DIP-20** | `74LS273` | 八路同相 D 触发器 (含复位) | CLK, ~MR, D0..D7 -> Q0..Q7 |

---

## 6. AI 助教诊断与自动打分接口

### 6.1 接线审查 (DLab.Advisor.review)
外部 Agent 可调用审查器对当前电路进行全面体检，诊断是否满足实验要求：
```javascript
const report = DLab.Advisor.review(engine);
console.log(report.summary); // '发现 2 处严重错误，1 处警告'
console.log(report.issues);
// [
//   { code: 'VCC_GND_SHORT', level: 'error', message: 'VCC 与 GND 被导线直接短路！' },
//   { code: 'CHIP_POWER_MISSING', level: 'error', message: 'devA:UA 上的 74LS00 未连接 VCC' },
//   { code: 'ENABLE_FLOATING', level: 'warn', message: 'devA:UE (74LS138) 使能引脚 ~G2A 悬空' }
// ]
```

**10 类内建审查规则代码表**：
1. `VCC_GND_SHORT` (ERROR)：电源与地直接连通，导致全板短路。
2. `OUTPUT_CONFLICT` (ERROR)：两个推挽输出端相撞，导致电平不定。
3. `CHIP_POWER_MISSING` (ERROR)：芯片的 VCC 或 GND 未接入电源网。
4. `RESET_HELD` (WARN)：异步清零/复位端（~CLR / ~MR）被常态钳位在有效电平。
5. `ENABLE_FLOATING` (WARN)：芯片低有效使能端（~EN, ~G2A 等）悬空。
6. `CLOCK_FLOATING` (WARN)：时序芯片时钟端未接脉冲或时钟信号。
7. `INPUT_FLOATING` (INFO)：逻辑门输入引脚完全悬空。
8. `UNUSED_GATE_FLOATING` (INFO)：同一封装内未使用的多余逻辑门引脚悬空。
9. `OUTPUT_UNCONNECTED` (INFO)：芯片逻辑输出孔未接线至指示灯或后续级。
10. `POWER_SWITCH_OFF` (WARN)：面板主电源未开启。

### 6.2 真值表自动打分 (DLab.Grader.grade)
外部 Agent 可定义真值表任务并驱动 Engine 打分：
```javascript
const task = {
  id: 'exp-nand',
  title: '二输入与非门功能测试',
  inputs: ['sw:5K1', 'sw:5K2'],
  outputs: ['led:4P1'],
  rows: [
    { in: [0, 0], out: [1] },
    { in: [0, 1], out: [1] },
    { in: [1, 0], out: [1] },
    { in: [1, 1], out: [0] }
  ]
};

const result = DLab.Grader.grade(engine, task, { timeMs: 1000 });
console.log(`得分: ${result.passed} / ${result.total}`); // 得分: 4 / 4
console.log(result.ok); // true
```

---

## 7. 典型数电实验工程生成示例 (Agent Recipes)

### 7.1 示例一：74LS00 二输入与非门逻辑实验工程
```json
{
  "format": "dlab-project",
  "version": 1,
  "meta": {
    "title": "74LS00 与非门基础实验",
    "description": "5K1/5K2 控制输入，4P1 观察与非门输出"
  },
  "chips": {
    "devA:UA": "74LS00"
  },
  "wires": [
    { "id": "w_vcc", "from": "pwr:5V1", "to": "devA:A14", "color": "#ef4444" },
    { "id": "w_gnd", "from": "gnd:GND1", "to": "devA:A7", "color": "#1f2937" },
    { "id": "w_in1", "from": "sw:5K1", "to": "devA:A1", "color": "#f97316" },
    { "id": "w_in2", "from": "sw:5K2", "to": "devA:A2", "color": "#a855f7" },
    { "id": "w_out", "from": "devA:A3", "to": "led:4P1", "color": "#22c55e" }
  ],
  "switches": { "5K1": 0, "5K2": 0 },
  "power": true,
  "clockEnabled": true
}
```

### 7.2 示例二：74LS160 计数器驱动 BCD 数码管显示实验工程
```json
{
  "format": "dlab-project",
  "version": 1,
  "meta": {
    "title": "74LS160 计数与数码管译码显示实验",
    "description": "74LS160 计数输出 QA~QD 连接数码管显示区 2 的 3 号管 A3~D3，单脉冲 6K1+ 驱动计数"
  },
  "chips": {
    "devA:UE": "74LS160"
  },
  "wires": [
    { "id": "w_pwr", "from": "pwr:5V1", "to": "devA:E16", "color": "#ef4444" },
    { "id": "w_gnd", "from": "gnd:GND1", "to": "devA:E8", "color": "#1f2937" },
    { "id": "w_mr",  "from": "pwr:5V1", "to": "devA:E1", "color": "#ef4444" },
    { "id": "w_load","from": "pwr:5V1", "to": "devA:E9", "color": "#ef4444" },
    { "id": "w_enp", "from": "pwr:5V1", "to": "devA:E7", "color": "#ef4444" },
    { "id": "w_ent", "from": "pwr:5V1", "to": "devA:E10", "color": "#ef4444" },
    { "id": "w_clk", "from": "pulse:6K1+", "to": "devA:E2", "color": "#3b82f6" },
    { "id": "w_qa",  "from": "devA:E14", "to": "seg3:A3", "color": "#22c55e" },
    { "id": "w_qb",  "from": "devA:E13", "to": "seg3:B3", "color": "#22c55e" },
    { "id": "w_qc",  "from": "devA:E12", "to": "seg3:C3", "color": "#22c55e" },
    { "id": "w_qd",  "from": "devA:E11", "to": "seg3:D3", "color": "#22c55e" }
  ],
  "switches": {},
  "power": true,
  "clockEnabled": true
}
```

---

## 8. Agent 操作最佳实践与避坑要点

1. **重复接线 = 取消接线机制**：UI 交互中，在已有导线的两个插孔间再次操作接线会触发撤销该导线。Agent 在编写 UI 自动化行为时需牢记此规则，不可重复触发同一插孔对。
2. **数码管极性区分**：
   - `seg1` 为**共阳**，段电平为 `0` 点亮；
   - `seg2` 为**共阴**，段电平为 `1` 点亮；
   - `seg3` ~ `seg8` 内置 BCD/十六进制译码，按 8421 码输入驱动，全部悬空未接线时保持完全熄灭。
3. **时钟信号频率选择**：
   - 人眼观察 LED / 数码管步进：推荐使用 `clock:1HZ` 或 `clock:2HZ`，或单脉冲 `pulse:6K1+`；
   - 快速自动打分：使用开关 `sw:5Kn` 模拟时钟电平翻转或调用 `engine.step(ms)`。
4. **芯片供电**：
   - 74 系列芯片必须连接 VCC 与 GND。若漏接供电，`DLab.Advisor` 会报错，且芯片内部门电路逻辑将处于浮空异常态。
5. **板载仪器（第五阶段增量）**：
   - `mid:DDS` 是**主动驱动源**（板载信号源输出孔），只受电源开关控制、独立于时钟使能；
     `reset()` 后它仍输出方波（默认 1kHz / 5V），断言「无源插孔均为 Z」时必须排除它；
   - `mid:BEEP`（蜂鸣器）与 `mid:SPK`（功放）是**受电端**：接高电平即鸣 / 接交流源发声，
     引擎在 `state.analog.beep / spk / ach1` 给出驱动来源分析（`clock` / `dds` / `pulse` / `dc` / `logic`）；
   - `rc:1 / rc:2 / rc:3` 为电位器三端：两端供电时滑动端按线性分压驱动 `rc:2`
     （`≥2.5V` 判高）；只接一端时滑动端跟随供电端；两端悬空不驱动；
   - `probe:P01` 为逻辑笔输入：TTL 模式悬空判高（`state.probe.display = 'H'`），
     CMOS 模式悬空判高阻（`'Z'`）；
   - 引擎仪器 API：`setProbeMode / toggleProbeMode / getDds / setDds / cycleDdsParam /
     adjustDds(±1) / setPotRatio / getPotRatio`，全部带范围钳制与中文报错；
   - `state.dds.active = false`（幅度低于 2.5V 且已接线）时引擎与 AI 助教都会给出中文告警；
   - 交互层坐标全部由插孔反推（`DLab.Instruments.deriveAnchors`），改动插孔几何前先读
     `src/ui/instruments.js` 头注释的偏移表。
6. **点击试点亮的挂起机制**：
   - 时序循环每帧都会 `applyState → boardView.update()`，试点亮必须先点亮、再用
     `holdLed(key,true) / holdSeg(segId,true)` 挂起该灯的刷写，结束时解除挂起并
     `invalidate` 后按引擎真实状态恢复；
   - boardView 的挂起守卫**只拦熄灭写**（点亮写放行）——曾因守卫全拦 + 先挂后亮的顺序
     导致试点亮完全无效（Node 测试全绿但肉眼看不到），回归见 `build/ui-tap-flash.check.cjs`；
   - 试点亮对引擎**只读**：展示前后引擎电气状态不得变化（独立性红线）。

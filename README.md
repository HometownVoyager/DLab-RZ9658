# DLab —— 数字电路实验箱

> 纯前端、零构建、零依赖。**双击 `index.html` 即可运行。**
>
> 支持 **中文 / English** 双语界面：点击右上角的 `EN` / `中文` 按钮切换，选择会记住（localStorage）。

## 这是什么

面向《数字系统原理》《数字电子技术》课程的**实体实验箱数字孪生**。面板外观 1:1 复刻自参考照片，
学生可以在浏览器里完成「插芯片 → 插线 → 通电 → 观察 LED/数码管 → 跑时序实验 → 保存工程」的完整流程。

## 快速开始

```
双击 index.html
```

无需安装 Node、无需启动服务器、无需联网。

![运行中的应用](artifacts/app.png)

> 上图是刚启动的空白现场；接线 + 插芯片后的样子见 [artifacts/app-wired.png](artifacts/app-wired.png)。

## 能做什么

| 功能 | 说明 |
| :-- | :-- |
| **插芯片** | 点 A/B 模块上的 10 个 DIP 插座 → 弹出兼容型号菜单 → 选型号即插上；再点可拔下 |
| **接线** | 点击一个插孔 → 点击另一个插孔，生成自然下垂的贝塞尔飞线 |
| **删线** | 右键导线，或选中后按 `Delete` |
| **换色** | 工具栏 7 色板；红=VCC / 黑=GND / 蓝=CLK / 黄绿橙紫=信号 |
| **撤销/重做** | `Ctrl+Z` 撤销，`Ctrl+Y` 或 `Ctrl+Shift+Z` 重做 |
| **板载开关** | 点 5K1~5K16 自锁开关切换电平（键帽会真的沉下去）；点 6K1~6K6 轻触按键产生 200ms 单脉冲 |
| **板载仪器** | 逻辑笔 SW1 点按切换 TTL/CMOS 判读（三灯随接线实时判高/低/高阻）；信号源 2SS1 编码器：点击切参数、滚轮增减（1Hz~1MHz 1-2-5 步进、幅度 0~5V、方波/脉冲），旋钮指针与参数读数实时联动；电位器旋钮滚轮细调/点击进位，滑动端按线性分压驱动 rc:2；**示波器**：点面板示波器模块弹出波形窗口（ACH1 输入方波/脉冲/直流，RUN 灯 5DL1 随动）；**蜂鸣器**：BEEP 接高电平即鸣（2.7kHz 有源音色）并叠加声纹动画；**功放入**：SPK 接交流源时扬声器跟随发声 |
| **点击试用** | 点一下 LED 亮一下、点一下数码管全亮一瞬、点蜂鸣器叫一声、点信号源标题按当前频率试听——与正常触发完全独立（对引擎只读，展示完按真实状态恢复） |
| **音频与静音** | 蜂鸣器/扬声器由 WebAudio 合成（首次点击页面后解锁）；工具栏「静音」一键开关 |
| **时序控制** | 运行/暂停、单步（+10ms）、速度 1x/10x/100x、时钟使能、虚拟时间读数 |
| **透视** | 工具栏「显示导线」临时隐藏全部飞线 |
| **导入导出** | `.dlab.json` 工程文件，导出后可完整还原（含已插芯片、逻辑笔模式、信号源参数、电位器位置） |
| **板载器件** | 16 位电平开关、16 只 LED（4L1~4L16）、16 只状态灯（5L1~5L16）、8 只数码管、时钟输出、单脉冲 |
| **芯片** | **21 种** 74 系列，三种封装：14P 九款 / 16P 十一款 / 20P 一款 |
| **逻辑审查** | VCC-GND 短接、输出相撞自动告警 |
| **滚轮缩放** | 滚轮以**光标为中心**缩放面板（100%~800%）；中键或 `Space`+左键拖拽平移；`Ctrl+0` 复位；右下角浮出 `－ 100% ＋ 适应窗口` 控件 |
| **重复接线=取消** | 同一对插孔已经有线时，再连一次就把这根线**删掉**（可 `Ctrl+Z` 撤销） |
| **飞线避让** | 多根线重叠时自动上抬/下压/左右鼓开，避免互相压在一起 |
| **AI 助教** | 右侧滑出侧栏：审查电路（未供电/未接地/输入悬空/输出冲突/信号源幅度过低/电位器未供电等 12 类问题）、载入题目、真值表自动打分 |
| **中英双语** | 右上角 `EN` / `中文` 按钮切换界面语言（顶栏、工具栏、时序条、状态提示、审查结果等），选择自动保存；面板上的硬件丝印保持原样不翻译 |

完整操作说明见 `docs/wiring-demo.md`。

## 芯片库（21 款）

| 封装 | 数量 | 型号 |
| :-- | :-- | :-- |
| 14P（UA/UB） | 9 | 00 02 04 08 21 30 32 74 86 |
| 16P（UE/UD） | 11 | 47 48 112 138 148 151 153 160 161 194 283 |
| 20P（UF） | 1 | 273 |

**没有 NE555**：本实验箱只有 14P/16P/20P 三种 DIP 插座，没有 8 脚插座，8 脚器件物理上插不进去。
这是「实体还原」原则的直接推论，不是遗漏。

## 项目结构

```
Teaching App/
├── index.html                      # 应用外壳（唯一入口）
├── styles/
│   ├── app.css                     # 视口、舞台缩放、工具栏容器
│   ├── wires.css                   # 飞线、命中区、工具栏、板载控件样式
│   ├── timeline.css                # 时序控制条样式
│   ├── chips.css                   # 芯片插座命中区、芯片本体、型号菜单样式
│   ├── assistant.css               # AI 助教侧栏样式（右侧滑出、哑光金属）
│   └── instruments.css             # 板载仪器命中区与示波器窗口样式
├── src/
│   ├── app.js                      # 装配入口（依赖检查 → 注入面板 → 创建各层）
│   ├── boardView.js                # 面板视图层（状态 → LED/数码管视觉）
│   ├── core/
│   │   ├── panelGeometry.generated.js   # ★ 自动生成：288 个插孔坐标
│   │   ├── logic.js                     # 4 态逻辑 + 并查集网表
│   │   ├── chips.js                     # 74 系列芯片行为模型（21 款）
│   │   ├── boardNets.js                 # 板内固定铜箔走线连通组
│   │   ├── wireRouting.js                # 飞线避让路由（纯函数、确定性）
│   │   ├── advisor.js                    # AI 助教：接线审查与故障诊断（只读）
│   │   ├── grader.js                     # AI 助教：真值表批量打分
│   │   ├── quiz.js                       # AI 助教：自动出题（半成品工程包）
│   │   └── engine.js                    # DLab.Engine 仿真引擎
│   ├── panel/
│   │   ├── panel.annotated.js           # ★ 自动生成：DLab.panelSvg
│   │   └── panel.annotated.svg          # 插孔标注版（人工核对用）
│   └── ui/
│       ├── wireLayer.js                 # SVG 覆盖层与飞线渲染
│       ├── interaction.js               # 接线状态机、撤销/重做、快捷键
│       ├── persistence.js               # 导入导出
│       ├── hud.js                       # 底部工具栏
│       ├── boardControls.js             # 板载机械控件（16 自锁开关 + 6 轻触按键）
│       ├── sound.js                     # 板载音频合成（蜂鸣器/扬声器，WebAudio，Node 下静默）
│       ├── instruments.js               # 板载仪器交互层（SW1/2SS1/电位器/示波器窗口/声纹）
│       ├── tapFeedback.js               # 点击试用层（点 LED 亮一下/点蜂鸣器叫一声，对引擎只读）
│       ├── chipTray.js                  # 芯片插座（命中区、插拔菜单、芯片本体）
│       ├── timeline.js                  # 虚拟时间轴（时序控制条）
│       ├── viewport.js                  # 面板视口（滚轮缩放 / 拖拽平移 / 适应窗口）
│       └── advisorPanel.js              # AI 助教侧栏（审查 / 载入题目 / 打分）
├── build/                          # 构建期脚本与浏览器级回归（开发用，运行时不参与）
├── tests/                          # Node 自测
├── docs/                           # 契约、几何清单、使用说明
├── artifacts/                      # 截图产物（panel*.png 静态面板 / app*.png 运行态整机）
└── SVG.SVG                         # 第一阶段外观产物（只读真源）
```

## 验证

一键跑完全部 **22 个测试套件**（约 2 分钟）：

```
node build/verify-all.mjs
```

| 套件 | 覆盖 | 断言数 |
| :-- | :-- | :-- |
| `build/verify.mjs` | 几何数据硬校验 | 84 |
| `build/extract.selftest.mjs` | 几何提取回归 | 84 |
| `tests/engine.selftest.cjs` | 引擎自测（21 分组） | 258 |
| `tests/engine.integration.cjs` | 引擎 × 真实几何 | 全部通过 |
| `tests/browser-load.check.cjs` | 经典脚本加载顺序 | 全部通过 |
| `build/ui-index-selftest.cjs` | UI 模块（含撤销/重做） | 62 |
| `build/integration.mjs` | 端到端集成 | 12 |
| `build/ui-index-test.cjs` | 真实鼠标交互 | 全部通过 |
| `build/ui-roundtrip.cjs` | 导入导出往返 | 全部通过 |
| `build/ui-led-switch.check.cjs` | **面板 LED 与板载开关回归** | 97 |
| `tests/chips.selftest.cjs` | 芯片库 21 款真值表/时序 | 187 |
| `tests/timeline.selftest.cjs` | 虚拟时间轴 | 166 |
| `build/ui-chip-tray.check.cjs` | **芯片插座插拔交互回归** | 42 |
| `tests/boardNets.selftest.cjs` | 板内走线模型 | 142 |
| `build/ui-keyboard.check.cjs` | **键盘快捷键与真实下载** | 28 |
| `tests/wireRouting.selftest.cjs` | 飞线避让路由（§3.3 七条不变量） | 68 |
| `tests/advisor.selftest.cjs` | AI 助教审查（10 类问题，只读） | 74 |
| `tests/grader.selftest.cjs` | AI 助教打分与出题 | 116 |
| `build/ui-viewport.check.cjs` | **滚轮缩放与平移回归** | 32 |
| `build/ui-assistant.check.cjs` | **AI 助教侧栏回归** | 95 |
| `tests/instruments.selftest.cjs` | 板载仪器（逻辑笔/DDS/电位器/信号分析/持久化往返/试点亮顺序） | 117 |
| `build/ui-tap-flash.check.cjs` | **点击试点亮回归（真实鼠标 + 时序循环运行中）** | 32 |
| `build/ab-equivalence.cjs` | 引擎行为 A/B 等价性快照（43 场景，优化回归用） | 43 |
| `build/bench-engine.cjs` | 引擎步进基准（EMPTY/LOADED/MEMO/BATCH，优化验证用） | — |

> 带 **粗体** 的是「浏览器级」回归：它们用真实鼠标/键盘事件验证**屏幕上看得见**的效果。
> 光有引擎状态正确不够——曾经出现过「测试全绿但整块面板一只灯都不亮」的缺陷（`<use href>` 少了 `#`），
> 以及「Node 测试全绿但试点亮点不亮」的缺陷（挂起守卫把点亮写一起拦掉）。

## 重新生成几何数据

外观资产变更后（注意：`SVG.SVG` 目前冻结，正常情况不需要重跑）：

```
node build/extract.mjs        # 从 SVG.SVG 提取插孔坐标
node build/verify.mjs         # 校验
node build/extract.selftest.mjs
node build/shot.mjs           # 截图比对（静态面板 → panel*.png）
node build/app-shot.mjs       # 运行态整机截图（→ app*.png）
```

## 技术约束（重要）

1. **禁止 ES Module**：必须支持 `file://` 双击运行，`<script type="module">` 会被 CORS 拦截；
2. **禁止 `fetch()` 本地文件**：面板 SVG 以字符串常量内嵌（`panel.annotated.js`）；
3. **仿真层与 DOM 解耦**：`engine.js` 不依赖 `window`，可在 Node 中直接测试；
4. **`SVG.SVG` 只读**：外观唯一真源，改动需走「改 SVG → 重跑提取 → 重跑截图」流程。

## 已知限制

- `74LS112` / `74LS194` 的引脚排布存在多套公开版本，本项目取值与依据见 `src/core/chips.js` 注释与 `Construct Plan.md` §3.3.2；**接实物前必须以 `pinNames` 为准**；
- `74LS161` 的 `~PE` / RCO 引脚号存在两种公开版本，当前采用 9=LOAD、15=RCO；
- 数码管显示区：1号管为共阳直驱（低电平点亮），2号管为共阴直驱（高电平点亮）；3~8号管内置 6 位 BCD 译码驱动器（A/B/C/D 输入 8421 码，DP 为小数点，全悬空熄灭；详见 docs/AGENT_DEV_GUIDE.md）；
- 板内铜箔走线的推导结论为**空集**（相邻金孔之间确实没有互连），理由见 `Construct Plan.md` §3.3.7；
- 撤销栈为内存态，刷新页面即清空；
- 导线支持「点击两次接线」，未实现拖拽接线；
- 高速时钟（1KHZ 及以上）在 1x 速度下视觉上呈半亮，需提速到 100x 才能看清翻转；
- 信号源 DDS 只提供方波（50% 占空比）与脉冲（10% 占空比）两种波形——面板丝印三灯为「频率/幅度/脉冲」，正弦波无从对应（参数对齐依据见 `docs/references/RZ9658-官网资料摘录.md`）；
- 扬声器/试听音调被钳制在人耳可听域 30Hz~8kHz（接 1MHz 时钟不会真的超声）；示波器窗口固定在舞台左上角，不随面板缩放；
- 蜂鸣器/扬声器声音需要先在页面上点击一次（浏览器自动播放策略），未点击前保持静默。

## 后续阶段

- **第四阶段**：AI 助教（接线审查、自动出题、真值表批量打分）。

详见 `Construct Plan.md`。

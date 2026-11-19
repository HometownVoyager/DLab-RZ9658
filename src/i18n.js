// src/i18n.js
// 中文 / English 国际化基础设施。
// ------------------------------------------------------------------
// 约束：
//   · 纯前端、零依赖、零构建；index.html 以经典 <script> 加载（无 ES Module）。
//   · 必须能在 file:// 下双击运行：字典内联在本文件，绝不 fetch 外部 JSON。
//   · 必须能在无 DOM、无 localStorage 的 Node 自测环境中 require()，不抛错。
//   · 默认语言固定为 zh-CN，不依据 navigator.language 自动切换——
//     浏览器自测里有对中文文案的断言（如「短路」），保持默认即保持兼容。
//
// API：
//   DLab.i18n.t(key, params?, fallback?)  翻译（含 {param} 插值）
//   DLab.i18n.setLang('zh-CN'|'en')       切换语言并持久化、通知、重扫 DOM
//   DLab.i18n.getLang()                   当前语言代码
//   DLab.i18n.onChange(cb)                订阅语言变化，返回反订阅函数
//   DLab.i18n.scan(root?)                 按 data-i18n* 属性重扫 DOM
//   DLab.i18n.register(lang, dict)        合并扩展字典
//   DLab.i18n.LANGUAGES / DEFAULT_LANG

(function (global) {
  'use strict';

  var DLab = (global.DLab = global.DLab || {});

  var KEY = 'dlab.lang';
  var DEFAULT_LANG = 'zh-CN';
  var LANGS = ['zh-CN', 'en'];

  /* ------------------------------------------------------------------
   * 字典
   * ------------------------------------------------------------------ */

  var DICT = {
    'zh-CN': {
      // 应用与顶栏
      'app.title': '数字电路实验箱',
      'topbar.title': '数字电路实验箱',
      'topbar.subtitle': 'RZ9658 数字电路实验平台',
      'topbar.lang.title': '切换界面语言',
      'topbar.lang.toEn': 'EN',
      'topbar.lang.toZh': '中文',

      // 通用
      'common.ready': '就绪',
      'common.unknownError': '未知错误',
      'common.yes': '是',
      'common.no': '否',

      // 启动错误（app.js）
      'app.boot.coreMissing': '应用无法启动：核心模块缺失',
      'app.boot.skeletonIncomplete': '应用无法启动：页面骨架不完整',
      'app.boot.skeletonDetail': 'index.html 中缺少 #panel / #wire-layer / #toolbar 节点。',
      'app.boot.svgFailed': '应用无法启动：面板图形注入失败',
      'app.boot.initFailed': '应用初始化失败',
      'app.boot.missingPanelSvg': '缺少面板图形数据：src/panel/panel.annotated.js 未加载或 DLab.panelSvg 为空。',
      'app.boot.missingGeometry': '缺少插孔几何数据：src/core/panelGeometry.generated.js 未加载。',
      'app.boot.missingEngine': '缺少仿真引擎：src/core/engine.js 未加载。',
      'app.boot.missingWireLayer': '缺少飞线渲染层：src/ui/wireLayer.js 未加载。',
      'app.boot.missingInteraction': '缺少接线交互模块：src/ui/interaction.js 未加载。',
      'app.boot.missingHud': '缺少工具栏模块：src/ui/hud.js 未加载。',
      'app.boot.missingPersistence': '缺少导入导出模块：src/ui/persistence.js 未加载。',
      'app.boot.missingBoardView': '缺少面板视图层：src/boardView.js 未加载。',
      'app.boot.missingBoardControls': '缺少板载控件交互层：src/ui/boardControls.js 未加载。',
      'app.boot.missingTimeline': '缺少时序控制模块：src/ui/timeline.js 未加载。',
      'app.boot.missingChipTray': '缺少芯片插座交互层：src/ui/chipTray.js 未加载。',
      'app.boot.degradedViewport': '缺少视口缩放模块：src/ui/viewport.js 未加载，滚轮缩放不可用。',
      'app.boot.degradedRouting': '缺少飞线避让路由：src/core/wireRouting.js 未加载，飞线回落旧公式。',
      'app.boot.degradedAdvisor': '缺少 AI 助教逻辑：src/core/advisor.js / grader.js / quiz.js 未加载，审查与打分不可用。',
      'app.boot.degradedAdvisorPanel': '缺少 AI 助教侧栏：src/ui/advisorPanel.js 未加载。',
      'app.boot.degradedSound': '缺少板载音频模块：src/ui/sound.js 未加载，蜂鸣器与扬声器无声。',
      'app.boot.degradedInstruments': '缺少板载仪器交互层：src/ui/instruments.js 未加载，SW1 / 2SS1 / 电位器 / 示波器不可用。',
      'app.boot.degradedTap': '缺少点击试用层：src/ui/tapFeedback.js 未加载，LED / 蜂鸣器点击试用不可用。',
      'app.status.cleared': '已清空所有导线',
      'app.status.imported': '工程导入成功',
      'app.status.importFailed': '导入失败：{msg}',
      'app.status.muted': '板载音频已静音',
      'app.status.unmuted': '板载音频已开启',
      'app.btn.unmute': '取消静音',
      'app.btn.mute': '静音',
      'app.status.ready': '就绪：点击插孔接线（重复接线即取消）、滚轮缩放面板；时序实验请用上方「时序控制」运行',
      'app.status.degraded': '部分增强功能不可用：{list}',

      // 底部工具栏 hud.js
      'hud.label.color': '导线颜色',
      'hud.color.red': '红', 'hud.color.black': '黑', 'hud.color.blue': '蓝',
      'hud.color.yellow': '黄', 'hud.color.green': '绿', 'hud.color.orange': '橙', 'hud.color.purple': '紫',
      'hud.hint.vcc': 'VCC / 电源', 'hud.hint.gnd': 'GND / 地', 'hud.hint.clk': 'CLK / 时钟',
      'hud.hint.signal': '信号', 'hud.hint.output': '输出',
      'hud.swatch.title': '{name}（{hint}） {color}',
      'hud.action.undo': '撤销', 'hud.action.redo': '重做',
      'hud.action.clear': '清空导线', 'hud.action.export': '导出', 'hud.action.import': '导入',
      'hud.action.mute': '静音',
      'hud.title.undo': '撤销最近一次接线操作（Ctrl+Z）',
      'hud.title.redo': '重做被撤销的操作（Ctrl+Y / Ctrl+Shift+Z）',
      'hud.title.clear': '删除全部导线（可撤销）',
      'hud.title.export': '导出为 .dlab.json 工程文件',
      'hud.title.import': '从 .dlab.json 工程文件导入',
      'hud.title.mute': '静音 / 取消静音板载音频（蜂鸣器与扬声器）',
      'hud.toggle.showWires': '显示导线',
      'hud.title.toggleWires': '隐藏飞线以便观察面板（仍可接线）',
      'hud.chip.none': '未选中插孔',
      'hud.chip.from': '起点 {jack}',
      'hud.chip.count': '导线 {n}',
      'hud.short.alert': '⚠ 短路 {n} 处{suffix}',
      'hud.short.detail': '：{names}',
      'hud.short.separator': ' ↔ ',

      // 时序控制条 timeline.js
      'timeline.aria': '时序控制',
      'timeline.label.title': '时序控制',
      'timeline.label.run': '运行',
      'timeline.label.pause': '暂停',
      'timeline.label.step': '单步',
      'timeline.label.reset': '复位时间',
      'timeline.label.speed': '速度',
      'timeline.label.clockEnable': '时钟使能',
      'timeline.label.virtualTime': '虚拟时间',
      'timeline.title.run': '开始 / 暂停虚拟时间推进',
      'timeline.title.step': '单步推进 10ms',
      'timeline.title.reset': '虚拟时间归零',
      'timeline.title.speed': '仿真速度 {hz} 倍：1 秒真实时间推进 {hz} 秒虚拟时间',
      'timeline.title.clockEnable': '启用 / 禁用时钟输出',
      'timeline.unit.seconds': ' s',

      // AI 助教侧栏 advisorPanel.js
      'assistant.aria': 'AI 助教',
      'assistant.title': 'AI 助教',
      'assistant.level.error': '错误',
      'assistant.level.warn': '警告',
      'assistant.level.info': '提示',
      'assistant.empty.idle': '还没有审查电路',
      'assistant.empty.ok': '电路看起来没问题（未发现问题）',
      'assistant.empty.noTask': '还没有载入题目',
      'assistant.empty.noGrade': '还没有打分',
      'assistant.empty.noAdvisor': 'AI 审查模块不可用（src/core/advisor.js 未加载）',
      'assistant.empty.noGrader': '打分模块不可用（src/core/grader.js 未加载）',
      'assistant.aria.issue': '{level}：{title}',
      'assistant.btn.review': '审查电路',
      'assistant.btn.loadTask': '载入题目',
      'assistant.btn.grade': '打分',
      'assistant.btn.clear': '清除高亮',
      'assistant.tab.issues': '审查结果',
      'assistant.tab.task': '题目',
      'assistant.tab.grade': '打分',
      'assistant.label.truthTable': '真值表',
      'assistant.label.score': '得分',
      'assistant.label.noIssues': '未发现问题',
      'assistant.label.issueCount': '发现 {n} 个问题',
      'assistant.label.jacks': '相关插孔：{jacks}',
      'assistant.msg.reviewed': '审查完成：{n}',
      'assistant.msg.graded': '打分完成：{score}',
      'assistant.msg.taskLoaded': '题目已载入',
      'assistant.msg.noTask': '尚未载入题目，无法打分',

      // advisor 问题（按 issue.code 翻译，在 UI 边界使用）
      'advisor.issue.NO_POWER.title': '芯片未供电',
      'advisor.issue.NO_POWER.detail': '芯片 {chip} 的 VCC 引脚未接到电源。',
      'advisor.issue.NO_GROUND.title': '芯片未接地',
      'advisor.issue.NO_GROUND.detail': '芯片 {chip} 的 GND 引脚未接地。',
      'advisor.issue.OUTPUT_FLOATING.title': '输出悬空',
      'advisor.issue.OUTPUT_FLOATING.detail': '输出引脚未接到任何负载。',
      'advisor.issue.CLOCK_FLOATING.title': '时钟输入悬空',
      'advisor.issue.CLOCK_FLOATING.detail': '时钟输入未接信号源。',
      'advisor.issue.ENABLE_FLOATING.title': '使能端悬空',
      'advisor.issue.ENABLE_FLOATING.detail': '使能引脚未接确定的电平。',
      'advisor.issue.INPUT_FLOATING.title': '输入悬空',
      'advisor.issue.INPUT_FLOATING.detail': '输入引脚未接确定的电平。',
      'advisor.issue.RESET_HELD.title': '复位端持续有效',
      'advisor.issue.RESET_HELD.detail': '复位引脚一直处于有效电平，芯片无法正常工作。',
      'advisor.issue.SHORT_CIRCUIT.title': '电源短路',
      'advisor.issue.SHORT_CIRCUIT.detail': 'VCC 与 GND 之间存在直接连接。',
      'advisor.issue.DDS_AMPLITUDE_LOW.title': '信号源幅度过低',
      'advisor.issue.DDS_AMPLITUDE_LOW.detail': '信号源幅度低于 TTL 判读阈值。',
      'advisor.issue.POT_NO_SUPPLY.title': '电位器未供电',
      'advisor.issue.POT_NO_SUPPLY.detail': '电位器两端未接到电源与地，滑动端输出无效。',
      'advisor.issue.OUTPUT_CONFLICT.title': '输出冲突',
      'advisor.issue.OUTPUT_CONFLICT.detail': '多个输出驱动同一网络。',
      'advisor.issue.NO_WIRES.title': '尚未接线',
      'advisor.issue.NO_WIRES.detail': '面板上没有任何导线。',

      // 交互层提示 interaction.js
      'interaction.status.connected': '已连接 {a} → {b}',
      'interaction.status.disconnected': '已断开 {a} ↔ {b}',
      'interaction.status.removed': '已删除导线',
      'interaction.status.undone': '已撤销',
      'interaction.status.redone': '已重做',
      'interaction.status.clearAsk': '确定清空全部导线？',
      'interaction.status.sameJack': '不能连接同一个插孔',
      'interaction.status.noJack': '请先点击一个插孔',
      'interaction.status.selectStart': '请选择起点插孔',
      'interaction.status.selectEnd': '请选择终点插孔',

      // 导入导出 persistence.js
      'persistence.export.ok': '工程已导出：{name}',
      'persistence.export.empty': '当前没有可导出的内容',
      'persistence.import.ok': '工程导入成功',
      'persistence.import.badFile': '导入失败：不是有效的 .dlab.json 文件',
      'persistence.import.parseError': '导入失败：文件解析错误',
      'persistence.import.unknown': '导入失败：未知错误',

      // 板载仪器 instruments.js
      'instrument.scope.title': '示波器',
      'instrument.scope.run': '运行',
      'instrument.scope.stop': '停止',
      'instrument.scope.channel': '通道',
      'instrument.logicProbe.ttl': 'TTL',
      'instrument.logicProbe.cmos': 'CMOS',
      'instrument.dds.title': '信号源',
      'instrument.pot.title': '电位器',
      'instrument.beep.title': '蜂鸣器',

      // 芯片插座 chipTray.js
      'chip.title': '芯片插座',
      'chip.insert': '插入',
      'chip.remove': '拔下',
      'chip.selectModel': '选择兼容型号',

      // 板载控件 / 视图 / 视口 / 点击试用
      'control.switch.on': '开关已闭合',
      'control.switch.off': '开关已断开',
      'control.pulse': '已产生单脉冲',
      'viewport.reset': '复位视图',
      'viewport.fit': '适应窗口',
      'viewport.zoomIn': '放大',
      'viewport.zoomOut': '缩小',
      'tap.led': 'LED 点击试用',
      'tap.beep': '蜂鸣器点击试用',
      'sound.muted': '已静音',
      'sound.unmuted': '已取消静音'
    },

    en: {
      // App & top bar
      'app.title': 'Digital Circuit Lab',
      'topbar.title': 'Digital Circuit Lab',
      'topbar.subtitle': 'RZ9658 Digital Circuit Platform',
      'topbar.lang.title': 'Switch interface language',
      'topbar.lang.toEn': 'EN',
      'topbar.lang.toZh': '中文',

      // Common
      'common.ready': 'Ready',
      'common.unknownError': 'Unknown error',
      'common.yes': 'Yes',
      'common.no': 'No',

      // Boot errors (app.js)
      'app.boot.coreMissing': 'Cannot start: core modules missing',
      'app.boot.skeletonIncomplete': 'Cannot start: page skeleton incomplete',
      'app.boot.skeletonDetail': 'index.html is missing #panel / #wire-layer / #toolbar.',
      'app.boot.svgFailed': 'Cannot start: panel SVG injection failed',
      'app.boot.initFailed': 'Application initialization failed',
      'app.boot.missingPanelSvg': 'Missing panel graphics: src/panel/panel.annotated.js not loaded or DLab.panelSvg empty.',
      'app.boot.missingGeometry': 'Missing jack geometry: src/core/panelGeometry.generated.js not loaded.',
      'app.boot.missingEngine': 'Missing simulation engine: src/core/engine.js not loaded.',
      'app.boot.missingWireLayer': 'Missing wire rendering layer: src/ui/wireLayer.js not loaded.',
      'app.boot.missingInteraction': 'Missing wiring interaction: src/ui/interaction.js not loaded.',
      'app.boot.missingHud': 'Missing toolbar module: src/ui/hud.js not loaded.',
      'app.boot.missingPersistence': 'Missing import/export module: src/ui/persistence.js not loaded.',
      'app.boot.missingBoardView': 'Missing panel view layer: src/boardView.js not loaded.',
      'app.boot.missingBoardControls': 'Missing onboard controls: src/ui/boardControls.js not loaded.',
      'app.boot.missingTimeline': 'Missing timing control: src/ui/timeline.js not loaded.',
      'app.boot.missingChipTray': 'Missing chip socket layer: src/ui/chipTray.js not loaded.',
      'app.boot.degradedViewport': 'Viewport zoom unavailable: src/ui/viewport.js not loaded.',
      'app.boot.degradedRouting': 'Wire avoidance unavailable: src/core/wireRouting.js not loaded; using legacy routing.',
      'app.boot.degradedAdvisor': 'AI assistant logic unavailable: src/core/advisor.js / grader.js / quiz.js not loaded; review and grading disabled.',
      'app.boot.degradedAdvisorPanel': 'AI assistant panel unavailable: src/ui/advisorPanel.js not loaded.',
      'app.boot.degradedSound': 'Onboard audio unavailable: src/ui/sound.js not loaded; buzzer and speaker silent.',
      'app.boot.degradedInstruments': 'Onboard instruments unavailable: src/ui/instruments.js not loaded; SW1 / 2SS1 / potentiometer / oscilloscope disabled.',
      'app.boot.degradedTap': 'Tap preview unavailable: src/ui/tapFeedback.js not loaded; LED / buzzer tap preview disabled.',
      'app.status.cleared': 'All wires cleared',
      'app.status.imported': 'Project imported successfully',
      'app.status.importFailed': 'Import failed: {msg}',
      'app.status.muted': 'Onboard audio muted',
      'app.status.unmuted': 'Onboard audio enabled',
      'app.btn.unmute': 'Unmute',
      'app.btn.mute': 'Mute',
      'app.status.ready': 'Ready: click jacks to wire (repeat a connection to remove it), scroll to zoom; use "Timing" above for sequential experiments',
      'app.status.degraded': 'Some enhanced features unavailable: {list}',

      // Toolbar hud.js
      'hud.label.color': 'Wire color',
      'hud.color.red': 'Red', 'hud.color.black': 'Black', 'hud.color.blue': 'Blue',
      'hud.color.yellow': 'Yellow', 'hud.color.green': 'Green', 'hud.color.orange': 'Orange', 'hud.color.purple': 'Purple',
      'hud.hint.vcc': 'VCC / power', 'hud.hint.gnd': 'GND / ground', 'hud.hint.clk': 'CLK / clock',
      'hud.hint.signal': 'signal', 'hud.hint.output': 'output',
      'hud.swatch.title': '{name} ({hint}) {color}',
      'hud.action.undo': 'Undo', 'hud.action.redo': 'Redo',
      'hud.action.clear': 'Clear wires', 'hud.action.export': 'Export', 'hud.action.import': 'Import',
      'hud.action.mute': 'Mute',
      'hud.title.undo': 'Undo last wiring operation (Ctrl+Z)',
      'hud.title.redo': 'Redo undone operation (Ctrl+Y / Ctrl+Shift+Z)',
      'hud.title.clear': 'Delete all wires (undoable)',
      'hud.title.export': 'Export to .dlab.json project file',
      'hud.title.import': 'Import from .dlab.json project file',
      'hud.title.mute': 'Mute / unmute onboard audio (buzzer and speaker)',
      'hud.toggle.showWires': 'Show wires',
      'hud.title.toggleWires': 'Hide wires for a clearer panel (wiring still works)',
      'hud.chip.none': 'No jack selected',
      'hud.chip.from': 'From {jack}',
      'hud.chip.count': '{n} wires',
      'hud.short.alert': '⚠ {n} short circuit(s){suffix}',
      'hud.short.detail': ': {names}',
      'hud.short.separator': ' ↔ ',

      // Timeline timeline.js
      'timeline.aria': 'Timing control',
      'timeline.label.title': 'Timing',
      'timeline.label.run': 'Run',
      'timeline.label.pause': 'Pause',
      'timeline.label.step': 'Step',
      'timeline.label.reset': 'Reset time',
      'timeline.label.speed': 'Speed',
      'timeline.label.clockEnable': 'Clock enable',
      'timeline.label.virtualTime': 'Virtual time',
      'timeline.title.run': 'Start / pause virtual time',
      'timeline.title.step': 'Step forward 10ms',
      'timeline.title.reset': 'Reset virtual time to zero',
      'timeline.title.speed': 'Simulation speed {hz}x: 1s real time advances {hz}s virtual time',
      'timeline.title.clockEnable': 'Enable / disable clock output',
      'timeline.unit.seconds': ' s',

      // AI assistant advisorPanel.js
      'assistant.aria': 'AI Assistant',
      'assistant.title': 'AI Assistant',
      'assistant.level.error': 'Error',
      'assistant.level.warn': 'Warning',
      'assistant.level.info': 'Info',
      'assistant.empty.idle': 'No circuit review yet',
      'assistant.empty.ok': 'The circuit looks fine (no issues found)',
      'assistant.empty.noTask': 'No task loaded',
      'assistant.empty.noGrade': 'Not graded yet',
      'assistant.empty.noAdvisor': 'AI review unavailable (src/core/advisor.js not loaded)',
      'assistant.empty.noGrader': 'Grading unavailable (src/core/grader.js not loaded)',
      'assistant.aria.issue': '{level}: {title}',
      'assistant.btn.review': 'Review circuit',
      'assistant.btn.loadTask': 'Load task',
      'assistant.btn.grade': 'Grade',
      'assistant.btn.clear': 'Clear highlights',
      'assistant.tab.issues': 'Review',
      'assistant.tab.task': 'Task',
      'assistant.tab.grade': 'Grade',
      'assistant.label.truthTable': 'Truth table',
      'assistant.label.score': 'Score',
      'assistant.label.noIssues': 'No issues found',
      'assistant.label.issueCount': '{n} issue(s) found',
      'assistant.label.jacks': 'Related jacks: {jacks}',
      'assistant.msg.reviewed': 'Review complete: {n}',
      'assistant.msg.graded': 'Grading complete: {score}',
      'assistant.msg.taskLoaded': 'Task loaded',
      'assistant.msg.noTask': 'No task loaded; cannot grade',

      // Advisor issues (translated at UI boundary via issue.code)
      'advisor.issue.NO_POWER.title': 'Chip not powered',
      'advisor.issue.NO_POWER.detail': 'Chip {chip} VCC pin is not connected to power.',
      'advisor.issue.NO_GROUND.title': 'Chip not grounded',
      'advisor.issue.NO_GROUND.detail': 'Chip {chip} GND pin is not connected to ground.',
      'advisor.issue.OUTPUT_FLOATING.title': 'Floating output',
      'advisor.issue.OUTPUT_FLOATING.detail': 'Output pin is not connected to any load.',
      'advisor.issue.CLOCK_FLOATING.title': 'Floating clock input',
      'advisor.issue.CLOCK_FLOATING.detail': 'Clock input is not connected to a signal source.',
      'advisor.issue.ENABLE_FLOATING.title': 'Floating enable input',
      'advisor.issue.ENABLE_FLOATING.detail': 'Enable pin is not tied to a defined level.',
      'advisor.issue.INPUT_FLOATING.title': 'Floating input',
      'advisor.issue.INPUT_FLOATING.detail': 'Input pin is not tied to a defined level.',
      'advisor.issue.RESET_HELD.title': 'Reset held active',
      'advisor.issue.RESET_HELD.detail': 'Reset pin is held active; the chip cannot operate normally.',
      'advisor.issue.SHORT_CIRCUIT.title': 'Power short circuit',
      'advisor.issue.SHORT_CIRCUIT.detail': 'Direct connection between VCC and GND.',
      'advisor.issue.DDS_AMPLITUDE_LOW.title': 'Signal amplitude too low',
      'advisor.issue.DDS_AMPLITUDE_LOW.detail': 'Signal source amplitude is below the TTL detection threshold.',
      'advisor.issue.POT_NO_SUPPLY.title': 'Potentiometer not powered',
      'advisor.issue.POT_NO_SUPPLY.detail': 'Potentiometer ends are not tied to power and ground; wiper output is invalid.',
      'advisor.issue.OUTPUT_CONFLICT.title': 'Output conflict',
      'advisor.issue.OUTPUT_CONFLICT.detail': 'Multiple outputs drive the same net.',
      'advisor.issue.NO_WIRES.title': 'No wires yet',
      'advisor.issue.NO_WIRES.detail': 'There are no wires on the panel.',

      // Interaction interaction.js
      'interaction.status.connected': 'Connected {a} → {b}',
      'interaction.status.disconnected': 'Disconnected {a} ↔ {b}',
      'interaction.status.removed': 'Wire removed',
      'interaction.status.undone': 'Undone',
      'interaction.status.redone': 'Redone',
      'interaction.status.clearAsk': 'Clear all wires?',
      'interaction.status.sameJack': 'Cannot connect a jack to itself',
      'interaction.status.noJack': 'Click a jack first',
      'interaction.status.selectStart': 'Select the starting jack',
      'interaction.status.selectEnd': 'Select the ending jack',

      // Import/export persistence.js
      'persistence.export.ok': 'Project exported: {name}',
      'persistence.export.empty': 'Nothing to export',
      'persistence.import.ok': 'Project imported successfully',
      'persistence.import.badFile': 'Import failed: not a valid .dlab.json file',
      'persistence.import.parseError': 'Import failed: file parse error',
      'persistence.import.unknown': 'Import failed: unknown error',

      // Instruments instruments.js
      'instrument.scope.title': 'Oscilloscope',
      'instrument.scope.run': 'Run',
      'instrument.scope.stop': 'Stop',
      'instrument.scope.channel': 'Channel',
      'instrument.logicProbe.ttl': 'TTL',
      'instrument.logicProbe.cmos': 'CMOS',
      'instrument.dds.title': 'Signal generator',
      'instrument.pot.title': 'Potentiometer',
      'instrument.beep.title': 'Buzzer',

      // Chip tray chipTray.js
      'chip.title': 'Chip sockets',
      'chip.insert': 'Insert',
      'chip.remove': 'Remove',
      'chip.selectModel': 'Select a compatible model',

      // Onboard controls / view / tap preview
      'control.switch.on': 'Switch closed',
      'control.switch.off': 'Switch open',
      'control.pulse': 'Single pulse generated',
      'viewport.reset': 'Reset view',
      'viewport.fit': 'Fit to window',
      'viewport.zoomIn': 'Zoom in',
      'viewport.zoomOut': 'Zoom out',
      'tap.led': 'LED tap preview',
      'tap.beep': 'Buzzer tap preview',
      'sound.muted': 'Muted',
      'sound.unmuted': 'Unmuted'
    }
  };

  /* ------------------------------------------------------------------
   * 动态文案翻译表（translateText）
   * ------------------------------------------------------------------
   * 大量状态提示由各模块用「中文片段 + 变量」动态拼出，并统一经
   * hud.setStatus() 显示。与其改写每个模块，这里按「整句精确匹配 →
   * 正则模式 → 片段替换」的顺序在显示时翻译。仅当语言为 en 时生效；
   * zh-CN 原样返回，从而保证现有中文自测断言完全不受影响。
   * ------------------------------------------------------------------ */

  // 整句精确匹配（优先级最高）
  var PHRASES_EN = {
    '就绪': 'Ready',
    'AI 助教': 'AI Assistant',
    'AI 助教面板': 'AI Assistant Panel',
    '接线审查 · 真值表打分': 'Circuit review · truth-table grading',
    '审查电路': 'Review circuit',
    '载入题目': 'Load task',
    '打分': 'Grade',
    '问题列表': 'Issues',
    '题目信息': 'Task info',
    '打分结果': 'Grading result',
    '静音': 'Mute',
    '取消静音': 'Unmute',
    '显示导线': 'Show wires',
    '适应窗口': 'Fit to window',
    '面板缩放': 'Panel zoom',
    '缩小一档（滚轮向下同效）': 'Zoom out (same as scrolling down)',
    '放大一档（滚轮向上同效）': 'Zoom in (same as scrolling up)',
    '复位到适应窗口（Ctrl+0）': 'Reset to fit window (Ctrl+0)',
    '时序控制': 'Timing control',
    '时钟使能': 'Clock enable',
    '速度': 'Speed',
    '复位时间': 'Reset time',
    '单步': 'Step',
    '运行': 'Run',
    '暂停': 'Pause',
    '未知错误': 'Unknown error',
    '右键删除': 'Right-click to delete',
    '删除': 'Delete',
    '已取消当前操作': 'Operation cancelled',
    '已取消接线': 'Wiring cancelled',
    '当前没有导线可清空': 'No wires to clear',
    '没有可撤销的操作': 'Nothing to undo',
    '没有可重做的操作': 'Nothing to redo',
    '导入成功': 'Import successful',
    '导入失败': 'Import failed',
    '校验通过': 'Validation passed',
    '已载入题目': 'Task loaded',
    '还没有载入题目，无法打分': 'No task loaded; cannot grade',
    '还没有载入题目': 'No task loaded',
    '还没有打分': 'Not graded yet',
    '还没有审查电路': 'No circuit review yet',
    '电路看起来没问题（未发现问题）': 'The circuit looks fine (no issues found)',
    '全部通过': 'All passed',
    '当前没有可导出的内容': 'Nothing to export',
    '没有选择文件': 'No file selected',
    '文件内容无法序列化': 'File content cannot be serialized',
    '读取文件失败': 'Failed to read file',
    '当前环境无法读取文件内容': 'Cannot read file in this environment',
    '当前环境不支持 FileReader': 'FileReader is not supported in this environment',
    '蜂鸣器试鸣': 'Buzzer test',
    '功放试听': 'Speaker test',
    '按当前信号源频率试听': 'Preview at current signal frequency',
    '已取消高亮': 'Highlights cleared',
    '题面没有真值表行': 'Task has no truth-table rows',
    '题面没有真值表行，无法打分': 'Task has no truth-table rows; cannot grade',
    '待补接线：': 'Wires still needed: '
  };

  // 正则模式（含数字/插孔等变量，按序匹配，第一条命中的即返回）
  var PATTERNS_EN = [
    [/^起点：(.+?)，点击另一个插孔完成接线（Esc 取消）$/, 'Start: $1 — click another jack to complete (Esc to cancel)'],
    [/^已选中导线 (.+?)，按 Delete 删除$/, 'Wire $1 selected — press Delete to remove'],
    [/^这两个插孔已经在同一个连通网（(.+?)）里，无需再连$/, 'These jacks are already on the same net ($1); no connection needed'],
    [/^已清空 (\d+) 根导线（Ctrl\+Z 可撤销）$/, 'Cleared $1 wire(s) (undo with Ctrl+Z)'],
    [/^已恢复 (\d+) 根导线$/, 'Restored $1 wire(s)'],
    [/^已重新删除 (\d+) 根导线$/, 'Re-deleted $1 wire(s)'],
    [/^已重新清空 (\d+) 根导线$/, 'Re-cleared $1 wire(s)'],
    [/^正在读取 (.+?)文件$/, 'Reading $1 file'],
    [/^逻辑笔模式：TTL（悬空按高电平判读）$/, 'Logic probe: TTL (floating reads high)'],
    [/^逻辑笔模式：CMOS（悬空按高阻判读）$/, 'Logic probe: CMOS (floating reads high-impedance)'],
    [/^示波器窗口已打开（RUN 灯亮，随接线自动刷新）$/, 'Oscilloscope opened (RUN LED on, updates with wiring)'],
    [/^示波器窗口已关闭$/, 'Oscilloscope closed'],
    [/^该问题没有关联插孔：$/, 'This issue has no related jacks: '],
    [/^已高亮 (\d+) 个相关插孔：$/, 'Highlighted $1 related jack(s): '],
    [/^相关插孔（插孔高亮不可用）：$/, 'Related jacks (highlight unavailable): '],
    [/^信号源试听：(\S+)Hz 超出扬声器可听域，按 (\S+)Hz 播放$/, 'Source preview: $1 Hz is inaudible; playing at $2 Hz'],
    [/^信号源试听：默认 1kHz$/, 'Source preview: default 1kHz'],
    [/^试点亮数码管 (.+?)ms 后按实际状态恢复）$/, 'Previewing 7-segment $1 — restoring actual state after ms)'],
    [/^已导出工程文件 (.+)$/, 'Exported project: $1'],
    [/^导入成功：(\d+) 根导线，(\d+) 颗芯片$/, 'Imported: $1 wire(s), $2 chip(s)'],
    [/^已生成《(.+?)》半成品：芯片 (.+?) 已插在 (.+?)，VCC \/ GND 已接好，还差 (\d+) 根关键导线$/, 'Generated partially-built task "$1": chip $2 inserted at $3, VCC/GND connected, $4 key wires remaining'],
    [/^载入题目失败：工程导入失败$/, 'Failed to load task: project import failed'],
    [/^载入题目失败：文件里没有找到题面（task）字段$/, 'Failed to load task: no task field found in file'],
    [/^载入题目失败：不是合法的 JSON 文件$/, 'Failed to load task: not a valid JSON file'],
    [/^不是 DLab 工程文件（内容不是 JSON 对象）$/, 'Not a DLab project file (content is not a JSON object)'],
    [/^文件里没有找到题面（task）字段$/, 'No task field found in file'],
    [/^不是合法的 DLab 工程文件（内容不是 JSON 对象）$/, 'Not a valid DLab project file (content is not a JSON object)'],
    [/^全部通过：(\d+)\/(\d+) 行正确$/, 'All passed: $1/$2 rows correct'],
    [/^未通过：(\d+)\/(\d+) 行正确，(\d+) 行错误$/, 'Failed: $1/$2 rows correct, $3 rows wrong'],
    [/^已读取题面：(.+)$/, 'Task loaded: $1'],
    [/^打分完成：(\d+) 行通过，(\d+) 行未通过$/, 'Graded: $1 rows passed, $2 rows failed'],
    [/^打分完成：(\d+) 行通过$/, 'Graded: $1 rows passed'],
    [/^审查完成：未发现问题$/, 'Review complete: no issues found'],
    [/^审查完成：未发现错误，有 (\d+) 条提示$/, 'Review complete: no errors, $1 tips'],
    [/^审查完成：发现 (\d+) 个问题（错误 (\d+) \/ 警告 (\d+) \/ 提示 (\d+)）$/, 'Review complete: $1 issue(s) ($2 errors / $3 warnings / $4 tips)'],
    [/^工程文件版本 (\S+) 高于当前支持的版本 (\S+)，请升级程序$/, 'Project version $1 is newer than supported version $2; please update'],
    [/^第 (\d+) 根导线缺少 from 插孔$/, 'Wire $1 is missing the "from" jack'],
    [/^第 (\d+) 根导线缺少 to 插孔$/, 'Wire $1 is missing the "to" jack']
  ];

  // 片段替换（按长度降序应用；用于「前缀 + 变量」这类组合字符串）
  var FRAGMENTS_EN = {
    '导入失败：': 'Import failed: ',
    '未知错误': 'Unknown error',
    '读取文件失败：': 'Failed to read file: ',
    'JSON 解析失败，文件可能已损坏：': 'JSON parse failed, the file may be corrupted: ',
    '不是合法的 DLab 工程文件（format 应为 "': 'Not a valid DLab project file (format should be "',
    '，实际为 "': '", actual is "',
    '工程文件缺少有效的 version 字段': 'Project is missing a valid version field',
    'wires 字段必须是数组': 'wires must be an array',
    'switches 字段必须是对象': 'switches must be an object',
    'chips 字段必须是对象': 'chips must be an object',
    '字段必须是字符串': ' field must be a string',
    '根导线格式非法': ' wire has invalid format',
    '根导线两端是同一个插孔': ' wire has the same jack on both ends',
    '根导线引用了不存在的插孔：': ' wire references a non-existent jack: ',
    '信号源幅度低于 TTL 阈值': 'Signal amplitude is below the TTL threshold',
    '电位器两端未接电源': 'Potentiometer is not powered on both ends',
    '已忽略未知插座：': 'Ignored unknown socket: ',
    '导入失败：重建工程时出错（': 'Import failed: error rebuilding project (',
    '导出失败：': 'Export failed: ',
    '接线失败：': 'Wiring failed: ',
    '取消接线失败：': 'Cancel wiring failed: ',
    '删除失败：': 'Delete failed: ',
    '撤销失败：': 'Undo failed: ',
    '重做失败：': 'Redo failed: ',
    '仿真推进失败：': 'Simulation step failed: ',
    '插入失败：': 'Insert failed: ',
    '拔下失败：': 'Remove failed: ',
    '审查失败：': 'Review failed: ',
    '打分失败：': 'Grading failed: ',
    '载入题目失败：': 'Failed to load task: ',
    '恢复失败：': 'Restore failed: ',
    '安装失败：': 'install failed: ',
    '未知的题目模板：': 'Unknown task template: ',
    '（空）': '(empty)',
    '「幅度」': '"Amplitude"',
    '「频率」': '"Frequency"',
    '「波形」': '"Waveform"',
    '逻辑笔模式：': 'Logic probe mode: ',
    '信号源 2SS1：当前调节「': 'Signal source 2SS1: adjusting "',
    '」（滚轮增减）': '" (scroll to adjust)',
    '信号源频率：': 'Signal frequency: ',
    '（1-2-5 步进）': ' (1-2-5 steps)',
    '信号源幅度：': 'Signal amplitude: ',
    '（低于 TTL 阈值 ': ' (below TTL threshold ',
    'V，输出恒为低电平）': 'V, output stays low)',
    '信号源波形：': 'Signal waveform: ',
    '电位器 ': 'Potentiometer ',
    '（两端未接电源，滑动端无输出）': ' (ends not powered; wiper has no output)',
    '（滑动端 ': ' (wiper ',
    '，判读高电平': ', reads high',
    '，判读低电平': ', reads low',
    '（占空比 ': ' (duty cycle ',
    '当前：': 'Current: ',
    '（': ' (',
    '）': ')',
    '空插座': 'empty socket',
    ' 脚 DIP': '-pin DIP',
    ' 脚），点击插入芯片': '-pin), click to insert a chip',
    '已在 ': 'Inserted ',
    ' 插上 ': ' into ',
    '已从 ': 'Removed ',
    ' 拔下 ': ' from ',
    '上本来就没有芯片': ' had no chip to begin with',
    '未知插座：': 'Unknown socket: ',
    '插座 ': 'Socket ',
    ' 根导线': ' wire(s)',
    ' 颗芯片': ' chip(s)',
    '已接线：': 'Connected: ',
    '已撤销接线：': 'Wiring undone: ',
    '已重做接线：': 'Wiring redone: ',
    '已恢复导线：': 'Wire restored: ',
    '已重做删除：': 'Deletion redone: ',
    '导线：': 'Wire: ',
    '（重复接线 = 取消）': ' (repeating a connection cancels it)',
    '逻辑电平开关 ': 'Logic switch ',
    '单脉冲按键 ': 'Pulse button ',
    '高电平 1': 'HIGH 1',
    '低电平 0': 'LOW 0',
    '单脉冲 ': 'Pulse ',
    ' 已触发': ' triggered',
    ' 处于防抖窗口内，本次忽略': ' is within debounce window; ignored',
    '试点亮 LED ': 'Previewing LED ',
    '试点亮数码管 ': 'Previewing 7-segment ',
    '蜂鸣器试鸣（': 'Buzzer test (',
    '功放试听：': 'Speaker test: ',
    '信号源试听：': 'Source preview: ',
    'ms 后按实际状态恢复）': ' ms; restoring actual state)',
    '等 ': ' etc. ',
    ' 个': '',
    '相关插孔：': 'Related jacks: ',
    '建议：': 'Suggestion: ',
    '输入 ': 'Inputs ',
    '输出 ': 'Outputs ',
    '真值表 ': 'Truth table ',
    ' 行': ' rows',
    ' 个': '',
    '输入：': 'Inputs: ',
    '期望 ': 'Expected ',
    '实测 ': 'Actual ',
    '问题列表': 'Issues',
    '题目信息': 'Task info',
    '打分结果': 'Grading result',
    '审查结果': 'Review result',
    '未通过 ': 'Failed ',
    '错误 ': 'error(s) ',
    '警告 ': 'warning(s) ',
    '提示 ': 'tip(s) ',
    '脉冲': 'Pulse',
    '方波': 'Square',
    '信号源幅度': 'Source amplitude',
    '信号源波形': 'Source waveform'
  };

  var FRAGMENT_ENTRIES = Object.keys(FRAGMENTS_EN).sort(function (a, b) {
    return b.length - a.length;
  });

  /** 在显示时把任意中文文案翻译成英文（仅 en 生效，zh 原样返回）。 */
  function translateText(text) {
    if (lang !== 'en' || text == null) return text;
    var s = String(text);
    if (hasOwn(PHRASES_EN, s)) return PHRASES_EN[s];
    for (var i = 0; i < PATTERNS_EN.length; i++) {
      var re = PATTERNS_EN[i][0];
      re.lastIndex = 0;
      if (re.test(s)) {
        return s.replace(re, PATTERNS_EN[i][1]);
      }
    }
    for (var j = 0; j < FRAGMENT_ENTRIES.length; j++) {
      var from = FRAGMENT_ENTRIES[j];
      if (s.indexOf(from) >= 0) {
        s = s.split(from).join(FRAGMENTS_EN[from]);
      }
    }
    // 片段替换后可能余下独立的整句片段（如「未知错误」），再过一遍整句表
    if (hasOwn(PHRASES_EN, s)) return PHRASES_EN[s];
    return s;
  }

  /* ------------------------------------------------------------------
   * 工具
   * ------------------------------------------------------------------ */

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function normalizeLang(value) {
    var v = String(value == null ? '' : value);
    if (/^zh(-|_)?(cn|hans)?$/i.test(v)) return 'zh-CN';
    if (/^en(-|_)?/i.test(v)) return 'en';
    return null;
  }

  function readStored() {
    try {
      if (global.localStorage && typeof global.localStorage.getItem === 'function') {
        return normalizeLang(global.localStorage.getItem(KEY));
      }
    } catch (e) { /* file:// 下 localStorage 可能抛 SecurityError，忽略 */ }
    return null;
  }

  function writeStored(lang) {
    try {
      if (global.localStorage && typeof global.localStorage.setItem === 'function') {
        global.localStorage.setItem(KEY, lang);
      }
    } catch (e) { /* 忽略 */ }
  }

  var lang = readStored() || DEFAULT_LANG;
  var listeners = [];
  // 记录首次扫描时节点的原文，保证 zh→en→zh 往返无损（不拿当前译文当回退）。
  var originals = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;

  function t(key, params, fallback) {
    var current = DICT[lang] || DICT[DEFAULT_LANG];
    var base = DICT[DEFAULT_LANG];
    var s;
    if (current && hasOwn(current, key)) {
      s = current[key];
    } else if (base && hasOwn(base, key)) {
      s = base[key];
    } else if (fallback != null) {
      s = String(fallback);
    } else {
      s = key;
    }
    if (params && typeof params === 'object') {
      s = String(s).replace(/\{([\w.-]+)\}/g, function (m, k) {
        return hasOwn(params, k) ? String(params[k]) : m;
      });
    }
    return s;
  }

  function record(node) {
    if (!originals) return null;
    var r = originals.get(node);
    if (!r) {
      // 文本节点的 textContent 就是其 nodeValue
      var initial = (node.nodeType === 3) ? node.nodeValue : node.textContent;
      r = { text: initial, originalText: initial, attrs: Object.create(null) };
      originals.set(node, r);
    }
    return r;
  }

  function setText(node, key, params) {
    var r = record(node);
    node.textContent = t(key, params, r ? r.text : undefined);
  }

  function setAttr(node, attr, key, params) {
    var r = record(node);
    if (r && !(attr in r.attrs)) {
      r.attrs[attr] = node.getAttribute(attr);
    }
    node.setAttribute(attr, t(key, params, r ? r.attrs[attr] : undefined));
  }

  /**
   * 通用静态文案扫描：在英文态下把界面中的中文文本节点 / title / aria-label
   * 通过 translateText 翻译。用于兜底覆盖那些尚未逐条改写成 tr() 的静态标签。
   * 只扫描 UI 容器，跳过面板 SVG（硬件丝印、插孔编号属硬件标识，不可翻译），
   * 也跳过 [data-i18n-ignore]。中文态原样返回，零开销、零行为变化。
   */
  function scanText(root) {
    if (lang !== 'en' || typeof document === 'undefined') return 0;
    root = root || document.body;
    if (!root || !root.querySelectorAll) return 0;

    // 只处理这些 UI 容器，避免误伤面板 SVG 与 <script>/<style>
    var containers = [];
    if (root.id === 'topbar' || root.id === 'toolbar' || root.id === 'timeline' ||
        root.id === 'assistant' || root.classList && root.classList.contains('viewport-controls')) {
      containers.push(root);
    }
    containers = containers.concat(
      Array.prototype.slice.call(root.querySelectorAll('#topbar,#toolbar,#timeline,#assistant,.viewport-controls,#boot-error'))
    );
    if (!containers.length) return 0;

    var count = 0;
    var TEXT_TAGS = { SCRIPT: 1, STYLE: 1 };
    containers.forEach(function (container) {
      // 文本节点（只取直接包含中文的节点；纯数字/符号节点不动）
      var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
      var node;
      while ((node = walker.nextNode())) {
        if (!node.parentNode || TEXT_TAGS[node.parentNode.nodeName]) continue;
        if (node.parentNode.closest && node.parentNode.closest('#panel-svg,[data-i18n-ignore]')) continue;
        var value = node.nodeValue || '';
        if (!/[\u4e00-\u9fff]/.test(value)) continue;
        if (node.parentNode.hasAttribute && node.parentNode.hasAttribute('data-i18n')) continue;
        var r = record(node);  // 文本节点直接以自身为 key 记录原文
        // 若当前值仍是中文（例如 app.js boot 在首次扫描后改写了状态栏），
        // 以当前中文为原文重新记录，避免用首次扫描时的旧值还原出错误文案。
        if (r && /[\u4e00-\u9fff]/.test(value)) r.text = value;
        var original = r ? r.text : value;
        var translated = translateText(original);
        if (translated !== node.nodeValue) { node.nodeValue = translated; count++; }
      }
      // 属性（title / aria-label / placeholder）
      var withTitle = container.querySelectorAll('[title],[aria-label],[placeholder]');
      if (container.hasAttribute && (container.hasAttribute('title') || container.hasAttribute('aria-label'))) {
        withTitle = [container].concat(Array.prototype.slice.call(withTitle));
      }
      Array.prototype.slice.call(withTitle).forEach(function (el) {
        if (el.closest && el.closest('#panel-svg,[data-i18n-ignore]')) return;
        ['title', 'aria-label', 'placeholder'].forEach(function (attr) {
          var attrRec = record(el);
          if (!attrRec) return;
          var attrKey = '@' + attr;
          var v = el.getAttribute(attr);
          // 首次记录原文（仅当当前值仍含中文时记录，避免记到英文译文）
          if (attrRec.attrs[attrKey] == null && v && /[\u4e00-\u9fff]/.test(v)) {
            attrRec.attrs[attrKey] = v;
          }
          var original = attrRec.attrs[attrKey];
          if (!original) return;
          var translated = translateText(original);
          if (translated !== v) { el.setAttribute(attr, translated); count++; }
        });
      });
    });
    return count;
  }

  /** 把静态文案恢复成中文原文（切回 zh-CN 时用） */
  function restoreText(root) {
    if (typeof document === 'undefined' || !originals) return 0;
    root = root || document.body;
    if (!root || !root.querySelectorAll) return 0;
    var count = 0;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      var r = originals.get(node);
      if (r && r.text != null && node.nodeValue !== r.text) {
        node.nodeValue = r.text; count++;
      }
    }
    // 元素的 title / aria-label / placeholder
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var er = originals.get(el);
      if (!er) continue;
      ['title', 'aria-label', 'placeholder'].forEach(function (attr) {
        var k = '@' + attr;
        if (er.attrs[k] != null && el.getAttribute(attr) !== er.attrs[k]) {
          el.setAttribute(attr, er.attrs[k]); count++;
        }
      });
    }
    return count;
  }

  /**
   * 扫描 data-i18n* 属性并重翻译。
   * 跳过 #panel-svg（面板丝印属于硬件标识，不应翻译）与 [data-i18n-ignore]。
   */
  function scan(root) {
    if (typeof document === 'undefined') return 0;
    root = root || document;
    if (!root.querySelectorAll) return 0;
    var nodes = root.querySelectorAll(
      '[data-i18n],[data-i18n-title],[data-i18n-aria-label],[data-i18n-placeholder],[data-i18n-attrs]'
    );
    var count = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.closest && el.closest('#panel-svg,[data-i18n-ignore]')) continue;

      if (el.hasAttribute('data-i18n')) {
        var params = null;
        try { params = JSON.parse(el.getAttribute('data-i18n-params') || 'null'); } catch (e) { /* 忽略 */ }
        setText(el, el.getAttribute('data-i18n'), params);
        count++;
      }

      var list = el.getAttribute('data-i18n-attrs');
      var attrs = list ? list.split(',') : ['title', 'aria-label', 'placeholder'];
      for (var j = 0; j < attrs.length; j++) {
        var attr = attrs[j].trim();
        if (!attr) continue;
        var key = el.getAttribute('data-i18n-' + attr) ||
          ((el.getAttribute('data-i18n') || '') + '.' + attr);
        if (key && (el.hasAttribute(attr) || list)) {
          setAttr(el, attr, key, null);
          count++;
        }
      }
    }
    return count;
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    listeners.push(cb);
    return function () {
      var idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  }

  function setLang(next) {
    var normalized = normalizeLang(next);
    if (!normalized || LANGS.indexOf(normalized) < 0) return lang;
    var changed = normalized !== lang;
    if (changed) {
      lang = normalized;
      writeStored(lang);
    }
    if (typeof document !== 'undefined') {
      if (document.documentElement) {
        document.documentElement.setAttribute('lang', lang);
      }
      document.title = t('app.title');
    }
    if (changed) {
      listeners.slice().forEach(function (cb) {
        try { cb(lang); } catch (e) { /* 单个订阅者出错不影响其他 */ }
      });
    }
    scan();
    // 通用静态文案：英文态翻译，中文态还原原文（顺序放在 tr()/onChange 重绘之后，
    // 以便覆盖那些在回调里重新写入的静态标签）
    if (typeof document !== 'undefined' && document.body) {
      if (lang === 'en') {
        scanText(document.body);
      } else {
        restoreText(document.body);
      }
    }
    return lang;
  }

  function register(language, dict) {
    if (!DICT[language] || !dict) return;
    for (var key in dict) {
      if (hasOwn(dict, key)) DICT[language][key] = dict[key];
    }
  }

  // 顶栏语言切换按钮（DOM 就绪时绑定；无 DOM 时静默跳过）
  function initToggle() {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    // 幂等：若本实例已绑定过，直接跳过（防止多次 initialize 重复绑定）
    if (toggleBound) return;
    var btn = document.getElementById('lang-toggle');
    if (!btn) return;
    toggleBound = true;
    function sync() {
      var api = DLab.i18n || { getLang: getLang, t: t };
      var isZh = api.getLang() === 'zh-CN';
      btn.textContent = api.t(isZh ? 'topbar.lang.toEn' : 'topbar.lang.toZh');
      btn.setAttribute('aria-pressed', isZh ? 'false' : 'true');
    }
    btn.addEventListener('click', function () {
      var api = DLab.i18n;
      if (api && typeof api.setLang === 'function') {
        api.setLang(api.getLang() === 'zh-CN' ? 'en' : 'zh-CN');
      }
      sync();
    });
    onChange(sync);
    sync();
  }
  var toggleBound = false;

  DLab.i18n = {
    t: t,
    translateText: translateText,
    setLang: setLang,
    getLang: function () { return lang; },
    onChange: onChange,
    scan: scan,
    scanText: scanText,
    restoreText: restoreText,
    register: register,
    LANGUAGES: LANGS,
    DEFAULT_LANG: DEFAULT_LANG
  };

  // DOM 就绪后绑定按钮并做一次初始扫描（供 index.html 中的 data-i18n 节点使用）
  function initialize() {
    initToggle();
    setLang(getLang());
    // app.js 的 boot 也监听 DOMContentLoaded，其注入的 HUD / 时序条 / 侧栏 DOM
    // 在本回调之后才出现。延迟一拍再扫一次，确保这些后插入的静态标签也被翻译。
    if (typeof setTimeout === 'function') {
      setTimeout(function () {
        if (getLang() === 'en') scanText(document.body);
      }, 0);
    }
  }
  if (typeof document !== 'undefined') {
    // 绑定顶栏按钮必须等 #lang-toggle 进入 DOM。用「轮询到元素出现再初始化」，
    // 避免 readyState 在 <head> 阶段就变成 interactive 时按钮尚不存在的问题。
    var didInit = false;
    function tryInit() {
      if (didInit) return true;
      if (!document.getElementById('lang-toggle')) return false;
      didInit = true;
      initialize();
      return true;
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryInit);
      global.addEventListener('load', tryInit);
    }
    // 立即尝试一次，并开始短轮询兜底（元素出现即初始化，随后 self-check 停止）
    tryInit();
    if (!didInit && typeof setInterval === 'function') {
      var poll = setInterval(function () {
        if (tryInit() && typeof clearInterval === 'function') clearInterval(poll);
      }, 30);
      if (typeof setTimeout === 'function') {
        setTimeout(function () { if (typeof clearInterval === 'function') clearInterval(poll); }, 10000);
      }
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

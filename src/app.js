/* ============================================================
   src/app.js —— 装配与启动入口
   ------------------------------------------------------------
   职责：
     1. 校验各模块是否加载成功（缺哪个就明确报哪个，而不是白屏）
     2. 把 DLab.panelSvg（第一阶段产出的面板 SVG）注入 #panel
     3. 按视口大小计算等比缩放，保证 1800:1380 不变形
     4. 依次创建 Engine / WireLayer / Hud / Interaction 并启动

   本文件是唯一知道"谁依赖谁"的地方；各模块之间不互相 import，
   全部通过全局 DLab 命名空间与构造函数注入协作。
   ============================================================ */

(function (global) {
  'use strict';

  var DLab = (global.DLab = global.DLab || {});

  /* 面板原始尺寸，与 SVG.SVG 的 viewBox 一致 */
  var PANEL_W = 1800;
  var PANEL_H = 1380;

  /* 舞台四周留白（与 styles/app.css 中 #stage 的 padding 保持一致） */
  var STAGE_PADDING = 12;

  /**
   * 启动失败时在页面上显示明确的中文错误，而不是留一片白屏。
   * @param {string} title 标题
   * @param {string[]} details 逐条原因
   */
  function showBootError(title, details) {
    var old = document.getElementById('boot-error');
    if (old) old.remove();

    var box = document.createElement('div');
    box.id = 'boot-error';

    var inner = document.createElement('div');
    inner.className = 'box';

    var h = document.createElement('h2');
    h.textContent = title;
    inner.appendChild(h);

    if (details && details.length) {
      var ul = document.createElement('ul');
      details.forEach(function (line) {
        var li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      });
      inner.appendChild(ul);
    }

    box.appendChild(inner);
    document.body.appendChild(box);
  }

  /**
   * 检查依赖模块是否齐全。
   * @returns {string[]} 缺失项的中文描述列表，空数组表示齐全
   */
  function checkDependencies() {
    var missing = [];

    if (!DLab.panelSvg) {
      missing.push('缺少面板图形数据：src/panel/panel.annotated.js 未加载或 DLab.panelSvg 为空。');
    }
    if (!DLab.geometry || !DLab.geometry.JACKS) {
      missing.push('缺少插孔几何数据：src/core/panelGeometry.generated.js 未加载。');
    }
    if (!DLab.Engine) {
      missing.push('缺少仿真引擎：src/core/engine.js 未加载。');
    }
    if (!DLab.WireLayer) {
      missing.push('缺少飞线渲染层：src/ui/wireLayer.js 未加载。');
    }
    if (!DLab.Interaction) {
      missing.push('缺少接线交互模块：src/ui/interaction.js 未加载。');
    }
    if (!DLab.Hud) {
      missing.push('缺少工具栏模块：src/ui/hud.js 未加载。');
    }
    if (!DLab.Persistence) {
      missing.push('缺少导入导出模块：src/ui/persistence.js 未加载。');
    }
    if (!DLab.BoardView) {
      missing.push('缺少面板视图层：src/boardView.js 未加载。');
    }
    if (!DLab.BoardControls) {
      missing.push('缺少板载控件交互层：src/ui/boardControls.js 未加载。');
    }
    if (!DLab.Timeline) {
      missing.push('缺少时序控制模块：src/ui/timeline.js 未加载。');
    }
    if (!DLab.ChipTray) {
      missing.push('缺少芯片插座交互层：src/ui/chipTray.js 未加载。');
    }
    // 第四阶段（第一批）：以下模块缺失不阻断启动，只降级对应功能（见 §缺失降级）
    return missing;
  }

  /**
   * 把面板 SVG 字符串注入到 #panel 中（插在 #wire-layer 之前）。
   * 面板 SVG 来自第一阶段产物，注入后只读，不做任何修改。
   * @param {HTMLElement} panelEl
   * @returns {SVGElement} 注入后的面板根节点
   */
  function injectPanelSvg(panelEl) {
    var wireLayer = panelEl.querySelector('#wire-layer');

    // 用 DOMParser 解析，避免 innerHTML 在 SVG 命名空间下的兼容问题
    var parsed = new DOMParser().parseFromString(DLab.panelSvg, 'image/svg+xml');

    var parseError = parsed.querySelector('parsererror');
    if (parseError) {
      throw new Error('面板 SVG 解析失败：' + parseError.textContent.slice(0, 200));
    }

    var svgRoot = parsed.documentElement;
    if (!svgRoot || svgRoot.nodeName.toLowerCase() !== 'svg') {
      throw new Error('面板 SVG 根节点不是 <svg>，实际为：' + (svgRoot ? svgRoot.nodeName : '空'));
    }

    // 从外部文档导入到当前文档
    var imported = document.importNode(svgRoot, true);

    // 规范化：给面板根节点一个稳定 id，并让它铺满 #panel
    imported.setAttribute('id', 'panel-svg');
    imported.setAttribute('width', '100%');
    imported.setAttribute('height', '100%');
    imported.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    // 面板是纯展示层，不接收鼠标事件；所有交互由覆盖层接管
    imported.style.pointerEvents = 'none';

    if (wireLayer && wireLayer.parentNode === panelEl) {
      panelEl.insertBefore(imported, wireLayer);
    } else {
      panelEl.appendChild(imported);
    }

    return imported;
  }

  /**
   * 第四阶段新增的可选模块：缺失时降级而不是白屏。
   * 之所以不放进 checkDependencies()：缩放、避让路由、AI 助教都是增强项，
   * 任何一个文件没加载都不应该让整块面板打不开。
   * @returns {string[]} 降级说明
   */
  function checkOptionalDependencies() {
    var degraded = [];
    if (!DLab.Viewport) {
      degraded.push('缺少视口缩放模块：src/ui/viewport.js 未加载，滚轮缩放不可用。');
    }
    if (!DLab.WireRouting) {
      degraded.push('缺少飞线避让路由：src/core/wireRouting.js 未加载，飞线回落旧公式。');
    }
    if (!DLab.Advisor || !DLab.Grader || !DLab.Quiz) {
      degraded.push('缺少 AI 助教逻辑：src/core/advisor.js / grader.js / quiz.js 未加载，审查与打分不可用。');
    }
    if (!DLab.AdvisorPanel) {
      degraded.push('缺少 AI 助教侧栏：src/ui/advisorPanel.js 未加载。');
    }
    if (!DLab.Sound) {
      degraded.push('缺少板载音频模块：src/ui/sound.js 未加载，蜂鸣器与扬声器无声。');
    }
    if (!DLab.Instruments) {
      degraded.push('缺少板载仪器交互层：src/ui/instruments.js 未加载，SW1 / 2SS1 / 电位器 / 示波器不可用。');
    }
    if (!DLab.TapFeedback) {
      degraded.push('缺少点击试用层：src/ui/tapFeedback.js 未加载，LED / 蜂鸣器点击试用不可用。');
    }
    return degraded;
  }

  /**
   * 按视口大小计算 #panel 的显示尺寸，保持 1800:1380 比例不变形。
   *
   * 【幂等】尺寸没变就不写 style：写 style 会触发一次布局重算，
   * 而 fitPanel 是被 ResizeObserver 驱动的，无脑写会来回抖。
   */
  function fitPanel() {
    var stageEl = document.getElementById('stage');
    var panelEl = document.getElementById('panel');
    if (!stageEl || !panelEl) return;

    var rect = stageEl.getBoundingClientRect();
    var availW = Math.max(0, rect.width - STAGE_PADDING * 2);
    var availH = Math.max(0, rect.height - STAGE_PADDING * 2);
    if (availW <= 0 || availH <= 0) return;

    var scale = Math.min(availW / PANEL_W, availH / PANEL_H);
    var w = Math.floor(PANEL_W * scale) + 'px';
    var h = Math.floor(PANEL_H * scale) + 'px';

    if (panelEl.style.width !== w) {
      panelEl.style.width = w;
    }
    if (panelEl.style.height !== h) {
      panelEl.style.height = h;
    }
    return scale;
  }

  /**
   * 重新按舞台尺寸适配面板，并让视口重新钳制平移量。
   *
   * 【为什么必须重排一次】
   *   首帧 fitPanel() 执行时，#timeline（时序控制条）还没注入内容、
   *   #toolbar 的最终高度也还没定，于是算出来的舞台高度比最终值大 40 多像素，
   *   面板就比舞台高出 18px，被 #stage 的 overflow:hidden 从上下各裁掉 9px。
   *   被裁掉的部分点不到 —— 表现为「滚轮缩放后有些插孔点不动、滚轮也没反应」。
   *   所以要在时序条布局稳定之后再补一次自适应，并且以后舞台尺寸一变就自动纠正。
   *
   * @param {Object} [appRef] 应用对象（用于拿到 viewport 做重新钳制）
   */
  function refitPanel(appRef) {
    fitPanel();
    var vp = appRef && appRef.viewport;
    if (vp && typeof vp.handleResize === 'function') {
      vp.handleResize();
    }
  }

  /**
   * 构造工具栏回调集合。
   * 用转发函数包一层，是为了让 Hud 可以先于 Interaction 创建：
   * 回调真正触发时再去 app.interaction 上取实现。
   * @param {Object} app 应用对象（此时可能尚未填充全部字段）
   * @returns {Object} 工具栏回调
   */
  function buildHudHandlers(app) {
    /** 安全地刷新交互层 */
    function safeRefresh() {
      if (app.interaction && typeof app.interaction.refresh === 'function') {
        app.interaction.refresh();
      } else if (app.wireLayer && app.engine) {
        app.wireLayer.render(app.engine.getWires());
      }
    }

    return {
      onColor: function (color) {
        if (app.interaction) app.interaction.setColor(color);
      },
      onClear: function () {
        // 清空所有导线
        if (!app.engine) return;
        app.engine.getWires().slice().forEach(function (w) {
          app.engine.removeWire(w.id);
        });
        safeRefresh();
        if (app.hud) app.hud.setStatus('已清空所有导线', 'info');
      },
      onUndo: function () {
        if (app.interaction) app.interaction.undo();
      },
      onExport: function () {
        if (!app.engine) return;
        DLab.Persistence.exportProject(app.engine);
      },
      onImport: function (file) {
        if (!app.engine) return;
        DLab.Persistence.importProject(file, app.engine).then(function (res) {
          if (res && res.ok) {
            safeRefresh();
            // 工程里可能带有开关 / 电源 / 时钟使能，导入后把面板与控件全部同步一遍
            if (app.applyState) app.applyState(app.engine.getState());
            if (app.timeline && app.timeline.refresh) app.timeline.refresh();
            if (app.hud) app.hud.setStatus('工程导入成功', 'info');
          } else if (app.hud) {
            app.hud.setStatus('导入失败：' + (res && res.message ? res.message : '未知错误'), 'error');
          }
        });
      },
      onToggleWires: function (visible) {
        if (app.wireLayer) app.wireLayer.setVisible(visible);
      },
      onMute: function () {
        if (!DLab.Sound) return;
        var muted = !DLab.Sound.getMuted();
        DLab.Sound.setMuted(muted);
        if (app.hud && app.hud.muteBtn) {
          app.hud.muteBtn.textContent = muted ? '取消静音' : '静音';
        }
        if (app.hud) app.hud.setStatus(muted ? '板载音频已静音' : '板载音频已开启', 'info');
      }
    };
  }

  /**
   * 启动应用。
   */
  function boot() {
    // ---- 1. 依赖检查 ----
    var missing = checkDependencies();
    if (missing.length) {
      showBootError('应用无法启动：核心模块缺失', missing);
      return;
    }

    var panelEl = document.getElementById('panel');
    var wireLayerEl = document.getElementById('wire-layer');
    var toolbarEl = document.getElementById('toolbar');

    if (!panelEl || !wireLayerEl || !toolbarEl) {
      showBootError('应用无法启动：页面骨架不完整', [
        'index.html 中缺少 #panel / #wire-layer / #toolbar 节点。'
      ]);
      return;
    }

    // ---- 2. 注入面板 SVG ----
    var panelSvgEl;
    try {
      panelSvgEl = injectPanelSvg(panelEl);
    } catch (err) {
      showBootError('应用无法启动：面板图形注入失败', [String(err && err.message ? err.message : err)]);
      return;
    }

    // ---- 3. 尺寸自适应 ----
    fitPanel();
    var resizeTimer = null;
    global.addEventListener('resize', function () {
      if (resizeTimer) global.clearTimeout(resizeTimer);
      resizeTimer = global.setTimeout(function () {
        refitPanel(app);
        // 缩放后飞线层需要重绘一次，保证命中区与视觉一致
        if (app && app.wireLayer && app.engine) {
          app.wireLayer.render(app.engine.getWires());
        }
      }, 120);
    });

    // ---- 4. 创建各层 ----
    // 顺序说明：Interaction 需要 hud 参与状态显示，但 Hud 又需要 Interaction 的回调，
    // 因此先建一个"回调占位"，等 Interaction 建好后再回填真实回调。
    var app = {};
    try {
      app.engine = new DLab.Engine({ geometry: DLab.geometry });
      app.wireLayer = new DLab.WireLayer(wireLayerEl, DLab.geometry);

      // Hud 先建，回调用转发函数（此时 interaction 尚未创建，调用时再取）
      app.hud = new DLab.Hud(toolbarEl, buildHudHandlers(app));

      // 面板视图层：订阅电平变化，把 LED / 数码管画出来
      app.boardView = new DLab.BoardView(panelSvgEl, DLab.geometry);

      // 板载机械控件：逻辑电平输出的 16 只自锁按键 + 单脉冲输出的 6 只轻触按键。
      // 面板 SVG 只画了静态外观，没有命中区也没有电气联系，必须由这一层补上，
      // 否则「点开关没反应、5L 指示灯永远不亮」。
      app.boardControls = new DLab.BoardControls({
        engine: app.engine,
        panelSvg: panelSvgEl,
        wireLayer: app.wireLayer,
        geometry: DLab.geometry,
        hud: app.hud,
        onState: function (state) {
          // 走统一刷新入口：开关切换可能点亮蜂鸣器 / 改变 LED，
          // 板载仪器层与音频层也要同步（applyState 在本函数之后才定义，调用时已就绪）
          if (app.applyState) {
            app.applyState(state);
          } else {
            app.boardView.update(state);
          }
        }
      });

      // 芯片插座：把面板上那 10 个「只是画出来的」DIP 插座变成可插拔实体。
      // 没有这一层，芯片库里的 17 款器件在界面上根本没有入口。
      app.chipTray = new DLab.ChipTray({
        engine: app.engine,
        wireLayer: app.wireLayer,
        geometry: DLab.geometry,
        hud: app.hud,
        onChange: function (state) {
          app.applyState(state);
        }
      });

      /**
       * 统一的面板刷新入口：所有会改变电气状态的路径最终都汇到这里。
       * 集中一处的好处是「LED / 数码管 / 开关机械位移 / 已插芯片」永远不会漏刷。
       */
      app.applyState = function (state) {
        if (!state) {
          return;
        }
        app.boardView.update(state);
        if (app.boardControls) {
          app.boardControls.syncVisuals();
        }
        if (app.chipTray) {
          app.chipTray.syncVisuals();
        }
        if (app.instruments) {
          app.instruments.syncVisuals(state);
        }
        if (DLab.Sound && typeof DLab.Sound.syncAnalog === 'function') {
          DLab.Sound.syncAnalog(state.analog);
        }
      };

      // 板载音频：浏览器自动播放策略要求 AudioContext 在用户手势之后创建/恢复。
      // 页面上任意一次按下都尝试解锁（幂等，重复调用开销可忽略）。
      if (DLab.Sound) {
        document.addEventListener('pointerdown', function () {
          DLab.Sound.unlock();
        }, true);
      }

      // 板载仪器交互层：逻辑笔 SW1 / 信号源 2SS1 / 电位器旋钮 / 示波器窗口 / 蜂鸣器声纹。
      // 没有这一层，这些仪器只是画在面板上的静态外观（点不动、转不了、看不到波形）。
      if (DLab.Instruments) {
        app.instruments = new DLab.Instruments({
          engine: app.engine,
          wireLayer: app.wireLayer,
          boardView: app.boardView,
          hud: app.hud,
          geometry: DLab.geometry,
          onState: app.applyState
        });
      }

      // 点击试用层：点 LED 亮一下、点蜂鸣器叫一声……与正常触发互相独立
      // （本层对引擎只读，展示结束后按真实状态恢复现场）。
      if (DLab.TapFeedback) {
        app.tapFeedback = new DLab.TapFeedback({
          engine: app.engine,
          wireLayer: app.wireLayer,
          boardView: app.boardView,
          hud: app.hud,
          geometry: DLab.geometry,
          applyState: app.applyState,
          onScope: function () {
            if (app.instruments) app.instruments.toggleScope();
          },
          onBuzzerRipple: function (ms) {
            if (app.instruments) app.instruments.playBeepRipple(ms);
          }
        });
      }

      // 时序控制条：虚拟时间轴，驱动时钟输出区与所有时序芯片。
      // 它接管时钟推进后，Interaction 的 rAF 循环不能再按真实时间 step，
      // 否则虚拟时间会被真实时间戳覆盖，计数器/触发器永远走不动。
      app.timeline = new DLab.Timeline({
        engine: app.engine,
        container: document.getElementById('timeline'),
        onState: app.applyState
      });

      // 给 engine.step 打「时间源改写」补丁。
      // 目的：Timeline 接管后，引擎时间只能由虚拟时间决定，
      //   Interaction 的 rAF 循环若继续用 performance.now() 推进，
      //   就会把虚拟时间覆盖成真实时间戳，计数器和触发器永远走不动。
      // 但「改写」不能是「空转」：点击开关、导入工程、测试脚本都会调用
      //   engine.step(performance.now()) 来强制重算，若直接返回旧状态，
      //   电平就永远不刷新（曾导致 5K1 点了没反应、4L1 不亮、短路检不出）。
      // 正确做法：把这些调用重定向到「当前虚拟时刻」，既保住虚拟时间，
      //   又保证任何一次外部推进都能拿到最新电平。
      // Timeline 在构造时已缓存原始 step 引用，因此不会被这道补丁拦住。
      var rawStep = app.engine.step;
      app.engine.step = function (ms) {
        if (app.timeline && app.timeline.isOwner()) {
          return rawStep.call(app.engine, app.timeline.getVirtualTime());
        }
        return rawStep.call(app.engine, ms);
      };

      app.interaction = new DLab.Interaction({
        engine: app.engine,
        wireLayer: app.wireLayer,
        hud: app.hud,
        geometry: DLab.geometry,
        // 引擎状态变化时刷新面板上的 LED 与数码管
        onState: app.applyState,
        // H8：Timeline 接管时钟推进时，Interaction 的 rAF 循环不再自行 step
        //（接线 / 撤销后的重算由 Interaction.refresh 显式补一次无参 step）
        getTimeOwner: function () {
          return (app.timeline && app.timeline.isOwner()) ? app.timeline : null;
        }
      });

      // 若 Interaction 自带接线好的回调（契约第 11 节的增强项），优先采用它，
      // 保证工具栏行为与交互模块内部实现完全一致。
      if (typeof app.interaction.getHandlers === 'function') {
        app.hud.setHandlers(app.interaction.getHandlers());
      }

      app.interaction.start();
      app.wireLayer.render(app.engine.getWires());

      // 视口缩放：滚轮以光标为中心缩放、中键/空格拖拽平移、Ctrl+0 复位。
      // 用 #panel 的 CSS transform 实现，两层 SVG 一起缩放，坐标换算零改动
      // （Chromium 的 getScreenCTM 已包含祖先 CSS transform，见 src/ui/viewport.js 头注释）。
      if (DLab.Viewport) {
        app.viewport = new DLab.Viewport({
          stageEl: document.getElementById('stage'),
          panelEl: panelEl,
          svgEl: wireLayerEl,
          onChange: function (t) {
            // 缩放/平移后命中区与预览线需要按新坐标重算一次：
            // 渲染本身不依赖缩放，但预览线跟的是鼠标位置，必须重画。
            if (app.interaction && app.interaction.selectedJack) {
              app.interaction._updatePreview();
            }
          }
        });
        app.viewport.start();
      }

      // 面板自适应补正：时序条与工具栏此时已经注入完内容，舞台的最终尺寸才确定。
      // 首帧 fitPanel() 是在它们注入之前算的，会把面板算得比舞台高 18px，
      // 上下各被裁掉 9px —— 被裁掉的插孔点不到。必须在这里补一次。
      refitPanel(app);

      // 舞台尺寸一变就自动重新适配（时序条注入、工具栏换行、窗口缩放都走这条路）。
      // 用 ResizeObserver 而不是只听 window.resize：前两者并不触发 window.resize。
      if (typeof global.ResizeObserver === 'function') {
        var stageEl = document.getElementById('stage');
        if (stageEl) {
          var stageObserver = new global.ResizeObserver(function () {
            refitPanel(app);
          });
          stageObserver.observe(stageEl);
          app._stageObserver = stageObserver;
        }
      }

      // AI 助教侧栏：审查电路 / 载入题目 / 真值表打分。
      // 逻辑全部在 core/advisor.js、core/grader.js、core/quiz.js（Node 可测），
      // 这一层只负责把结果画出来，并把 issue 关联到插孔高亮。
      if (DLab.AdvisorPanel) {
        app.advisorPanel = new DLab.AdvisorPanel({
          container: document.getElementById('assistant'),
          engine: app.engine,
          wireLayer: app.wireLayer,
          hud: app.hud,
          onState: app.applyState
        });
        if (typeof app.advisorPanel.start === 'function') {
          app.advisorPanel.start();
        }
        if (app.hud && typeof app.hud.setAssistantHandler === 'function') {
          app.hud.setAssistantHandler(function () {
            return app.advisorPanel.toggle();
          });
        }
      }

      // 启动时序控制的 rAF 循环。
      // 初始即进入「运行」态：真实实验箱的时钟一上电就在走、指示灯立刻响应，
      // 停住不动反而不像实物。默认 1x 速度下虚拟时间与真实时间同速，
      // 与接入时序控制之前的引擎行为完全等价（时钟相位、200ms 单脉冲宽度都不变）。
      // 用户点「暂停」才冻结时间，此时时钟、脉冲、计数器全部停摆——这正是「暂停」的含义。
      app.timeline.start();
      app.timeline.setRunning(true);

      // 首屏提示
      var degraded = checkOptionalDependencies();
      app.hud.setStatus(
        degraded.length
          ? '部分增强功能不可用：' + degraded.join('；')
          : '就绪：点击插孔接线（重复接线即取消）、滚轮缩放面板；时序实验请用上方「时序控制」运行',
        degraded.length ? 'warn' : 'info'
      );
    } catch (err) {
      showBootError('应用初始化失败', [String(err && err.stack ? err.stack : err)]);
      return;
    }

    // 暴露到全局，便于控制台调试与自动化测试
    global.DLabApp = app;
    global.DLab.app = app;
  }

  // DOM 就绪后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
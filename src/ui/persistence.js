// src/ui/persistence.js
// .dlab.json 导入导出：纯前端 Blob 下载 + FileReader 读取，导入前完整校验，失败不破坏当前工程。
(function (global) {
  'use strict';
  var DLab = (global.DLab = global.DLab || {});

  var FORMAT = 'dlab-project';
  var VERSION = 1;
  var DEFAULT_COLOR = '#ef4444';

  // 契约 4.2 节：芯片插座 ID（14P / 16P / 20P）
  var SOCKET_IDS = [
    'devA:UA', 'devA:UB', 'devA:UE', 'devA:UD', 'devA:UF',
    'devB:UA', 'devB:UB', 'devB:UE', 'devB:UD', 'devB:UF'
  ];

  // 16 位逻辑电平开关：丝印 5K1 ~ 5K16
  var SWITCH_COUNT = 16;

  /** 两位补零 */
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** 生成文件名 dlab-YYYYMMDD-HHmm.dlab.json（本地时间） */
  function timestampName(date) {
    var d = date || new Date();
    var stamp = '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
    var clock = pad2(d.getHours()) + pad2(d.getMinutes());
    return 'dlab-' + stamp + '-' + clock + '.dlab.json';
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function geometryOf(engine) {
    return (engine && engine.geometry) || (DLab.geometry) || { JACKS: {} };
  }

  function jackExists(engine, jackId) {
    var jacks = (geometryOf(engine).JACKS) || {};
    return Object.prototype.hasOwnProperty.call(jacks, jackId);
  }

  // —— 读取当前工程 ——

  /** 读出开关状态：{ '5K1': 1, ... } */
  function readSwitches(engine) {
    var out = {};
    for (var i = 1; i <= SWITCH_COUNT; i++) {
      var label = '5K' + i;
      var level = 0;
      try {
        if (typeof engine.getSwitch === 'function') {
          level = engine.getSwitch(i) ? 1 : 0;
        }
      } catch (err) {
        level = 0;
      }
      out[label] = level;
    }
    return out;
  }

  /** 读出芯片状态：{ 'devA:UA': '74LS00', 'devB:UB': null } */
  function readChips(engine) {
    var out = {};
    if (typeof engine.getChip !== 'function') {
      return out;
    }
    for (var i = 0; i < SOCKET_IDS.length; i++) {
      var socketId = SOCKET_IDS[i];
      var model = null;
      try {
        model = engine.getChip(socketId) || null;
      } catch (err) {
        model = null;
      }
      out[socketId] = model;
    }
    return out;
  }

  function readPower(engine) {
    try {
      if (typeof engine.isPowerOn === 'function') {
        return !!engine.isPowerOn();
      }
      if (typeof engine.getPower === 'function') {
        return !!engine.getPower();
      }
      if (typeof engine.power === 'boolean') {
        return engine.power;
      }
      var state = typeof engine.getState === 'function' ? engine.getState() : null;
      if (state && typeof state.power === 'boolean') {
        return state.power;
      }
    } catch (err) {
      // 读不到就当电源开着（引擎默认 true）
    }
    return true;
  }

  function readWires(engine) {
    var wires = [];
    try {
      wires = typeof engine.getWires === 'function' ? engine.getWires() : [];
    } catch (err) {
      wires = [];
    }
    if (!Array.isArray(wires)) {
      return [];
    }
    return wires.map(function (w) {
      return {
        id: String(w.id),
        from: String(w.from),
        to: String(w.to),
        color: typeof w.color === 'string' && w.color ? w.color : DEFAULT_COLOR
      };
    });
  }

  /** 读出板载仪器状态（v1 增量字段；旧引擎没有这些 API 时逐项降级为 null） */
  function readInstruments(engine) {
    var out = { probeMode: null, dds: null, potRatio: null };
    try {
      if (typeof engine.getProbeMode === 'function') {
        out.probeMode = engine.getProbeMode();
      }
    } catch (err) {
      out.probeMode = null;
    }
    try {
      if (typeof engine.getDds === 'function') {
        out.dds = engine.getDds();
      }
    } catch (err) {
      out.dds = null;
    }
    try {
      if (typeof engine.getPotRatio === 'function') {
        out.potRatio = engine.getPotRatio();
      }
    } catch (err) {
      out.potRatio = null;
    }
    return out;
  }

  /** 组装工程对象（不下载，便于测试） */
  function buildProject(engine) {
    var ins = readInstruments(engine);
    return {
      format: FORMAT,
      version: VERSION,
      savedAt: new Date().toISOString(),
      power: readPower(engine),
      switches: readSwitches(engine),
      chips: readChips(engine),
      wires: readWires(engine),
      // 板载仪器（v1 增量可选字段：旧版本文件没有它们也照常导入）
      probeMode: ins.probeMode || 'TTL',
      dds: ins.dds,
      potRatio: (ins.potRatio === null || ins.potRatio === undefined) ? null : ins.potRatio
    };
  }

  /** 导出并触发浏览器下载，返回文件名 */
  function exportProject(engine) {
    var project = buildProject(engine);
    var name = timestampName();
    var text = JSON.stringify(project, null, 2);

    if (typeof Blob === 'undefined' || typeof document === 'undefined') {
      // Node 环境：只返回内容，方便自测
      return { filename: name, text: text };
    }

    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // 下一轮事件循环再回收，避免部分浏览器取消下载
    setTimeout(function () {
      if (a.parentNode) {
        a.parentNode.removeChild(a);
      }
      URL.revokeObjectURL(url);
    }, 0);
    return name;
  }

  // —— 校验 ——

  /**
   * 校验工程对象，返回 { ok, message, project }
   * 任何一处不合法都直接返回，不触碰 engine。
   */
  function validateProject(raw, engine) {
    if (!isPlainObject(raw)) {
      return { ok: false, message: '文件内容不是合法的 JSON 对象' };
    }
    if (raw.format !== FORMAT) {
      return { ok: false, message: '不是 DLab 工程文件（format 应为 "' + FORMAT + '"，实际为 "' + raw.format + '"）' };
    }
    var version = Number(raw.version);
    if (!isFinite(version) || version < 1) {
      return { ok: false, message: '工程文件缺少有效的 version 字段' };
    }
    if (version > VERSION) {
      return { ok: false, message: '工程文件版本 ' + version + ' 高于当前支持的版本 ' + VERSION + '，请升级程序' };
    }

    // 导线：必须引用真实存在的插孔，且两端不同
    var wiresIn = raw.wires;
    if (wiresIn === undefined || wiresIn === null) {
      wiresIn = [];
    }
    if (!Array.isArray(wiresIn)) {
      return { ok: false, message: 'wires 字段必须是数组' };
    }
    var wires = [];
    var usedIds = {};
    for (var i = 0; i < wiresIn.length; i++) {
      var w = wiresIn[i];
      if (!isPlainObject(w)) {
        return { ok: false, message: '第 ' + (i + 1) + ' 根导线格式非法' };
      }
      var from = w.from;
      var to = w.to;
      if (typeof from !== 'string' || !from) {
        return { ok: false, message: '第 ' + (i + 1) + ' 根导线缺少 from 插孔' };
      }
      if (typeof to !== 'string' || !to) {
        return { ok: false, message: '第 ' + (i + 1) + ' 根导线缺少 to 插孔' };
      }
      if (from === to) {
        return { ok: false, message: '第 ' + (i + 1) + ' 根导线两端是同一个插孔 ' + from };
      }
      if (!jackExists(engine, from)) {
        return { ok: false, message: '第 ' + (i + 1) + ' 根导线引用了不存在的插孔：' + from };
      }
      if (!jackExists(engine, to)) {
        return { ok: false, message: '第 ' + (i + 1) + ' 根导线引用了不存在的插孔：' + to };
      }
      var id = typeof w.id === 'string' && w.id ? w.id : 'w' + (i + 1);
      while (usedIds[id]) {
        id = id + '_';
      }
      usedIds[id] = true;
      wires.push({
        id: id,
        from: from,
        to: to,
        color: typeof w.color === 'string' && w.color ? w.color : DEFAULT_COLOR
      });
    }

    // 开关：缺失取默认 0；键支持 '5K1' 与 'sw:5K1' 两种写法
    var switches = {};
    var switchesIn = raw.switches;
    if (switchesIn !== undefined && switchesIn !== null && !isPlainObject(switchesIn)) {
      return { ok: false, message: 'switches 字段必须是对象' };
    }
    switchesIn = switchesIn || {};
    for (var s = 1; s <= SWITCH_COUNT; s++) {
      var label = '5K' + s;
      var value = switchesIn[label];
      if (value === undefined) {
        value = switchesIn['sw:' + label];
      }
      switches[label] = value ? 1 : 0;
    }

    // 芯片：插座 ID 必须已知；型号非法交给 engine 判定，失败时降级为警告
    var chips = {};
    var chipsIn = raw.chips;
    if (chipsIn !== undefined && chipsIn !== null && !isPlainObject(chipsIn)) {
      return { ok: false, message: 'chips 字段必须是对象' };
    }
    chipsIn = chipsIn || {};
    for (var c = 0; c < SOCKET_IDS.length; c++) {
      var socketId = SOCKET_IDS[c];
      var model = chipsIn[socketId];
      if (model === undefined || model === null) {
        continue;
      }
      if (typeof model !== 'string') {
        return { ok: false, message: '芯片 ' + socketId + ' 的型号字段必须是字符串' };
      }
      chips[socketId] = model;
    }
    // 未知插座 ID：忽略但提示（兼容未来扩展）
    var unknownSockets = [];
    for (var key in chipsIn) {
      if (Object.prototype.hasOwnProperty.call(chipsIn, key) && SOCKET_IDS.indexOf(key) < 0) {
        unknownSockets.push(key);
      }
    }

    // 板载仪器（v1 增量可选字段）：单个值非法只降级为警告，不阻止整份文件导入
    var instrumentWarnings = [];
    var instruments = { probeMode: 'TTL', dds: null, potRatio: null };

    if (raw.probeMode !== undefined && raw.probeMode !== null) {
      var probeModeIn = String(raw.probeMode).toUpperCase();
      if (probeModeIn === 'TTL' || probeModeIn === 'CMOS') {
        instruments.probeMode = probeModeIn;
      } else {
        instrumentWarnings.push('逻辑笔模式 "' + raw.probeMode + '" 非法，已按 TTL 处理');
      }
    }

    if (raw.dds !== undefined && raw.dds !== null) {
      if (!isPlainObject(raw.dds)) {
        instrumentWarnings.push('dds 字段必须是对象，已忽略');
      } else {
        var ddsIn = raw.dds;
        var ddsOut = {};
        if (ddsIn.freqHz !== undefined) {
          var fIn = Number(ddsIn.freqHz);
          if (isFinite(fIn) && fIn > 0) {
            ddsOut.freqHz = Math.min(1000000, Math.max(1, Math.round(fIn)));
          } else {
            instrumentWarnings.push('DDS 频率 ' + ddsIn.freqHz + ' 非法，已忽略');
          }
        }
        if (ddsIn.amplitudeV !== undefined) {
          var aIn = Number(ddsIn.amplitudeV);
          if (isFinite(aIn)) {
            ddsOut.amplitudeV = Math.min(5, Math.max(0, Math.round(aIn * 10) / 10));
          } else {
            instrumentWarnings.push('DDS 幅度 ' + ddsIn.amplitudeV + ' 非法，已忽略');
          }
        }
        if (ddsIn.waveform !== undefined) {
          if (ddsIn.waveform === 'square' || ddsIn.waveform === 'pulse') {
            ddsOut.waveform = ddsIn.waveform;
          } else {
            instrumentWarnings.push('DDS 波形 "' + ddsIn.waveform + '" 非法，已忽略');
          }
        }
        if (ddsIn.sel !== undefined) {
          if (['freq', 'amp', 'wave'].indexOf(ddsIn.sel) >= 0) {
            ddsOut.sel = ddsIn.sel;
          } else {
            instrumentWarnings.push('DDS 编码器选择 "' + ddsIn.sel + '" 非法，已忽略');
          }
        }
        if (Object.keys(ddsOut).length) {
          instruments.dds = ddsOut;
        }
      }
    }

    if (raw.potRatio !== undefined && raw.potRatio !== null) {
      var potIn = Number(raw.potRatio);
      if (isFinite(potIn)) {
        instruments.potRatio = Math.min(1, Math.max(0, potIn));
      } else {
        instrumentWarnings.push('电位器位置 ' + raw.potRatio + ' 非法，已忽略');
      }
    }

    return {
      ok: true,
      message: '校验通过',
      project: {
        format: FORMAT,
        version: version,
        savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : null,
        power: raw.power === undefined ? true : !!raw.power,
        switches: switches,
        chips: chips,
        wires: wires,
        instruments: instruments
      },
      unknownSockets: unknownSockets,
      instrumentWarnings: instrumentWarnings
    };
  }

  /** 按校验后的工程重建引擎状态 */
  function applyProject(project, engine, warnings) {
    // H7（2026-10-30 性能审查遗留项）：导入是典型批量变更路径——P1 契约让每个
    // 变更类 API 各自自动重算，一份工程（16 开关 + 10 插座 + N 导线）会放大成
    // 几十次全量收敛。批量包装后只在收尾推进一步；批量期间的读取返回上一次
    // 收尾结果（与接线类 API 的既有约定一致），endBatch 后立即反映全部变更。
    // 旧引擎没有批量接口时逐条推进（行为同前）。
    var batching = false;
    if (typeof engine.beginBatch === 'function' && typeof engine.endBatch === 'function') {
      engine.beginBatch();
      batching = true;
    }
    try {
    applyProjectBody(project, engine, warnings);
    } finally {
      if (batching) engine.endBatch();
    }
  }

  /** applyProject 的实体（在 H7 批量包装内执行） */
  function applyProjectBody(project, engine, warnings) {
    // 1. 清空
    if (typeof engine.reset === 'function') {
      engine.reset();
    } else {
      var oldWires = typeof engine.getWires === 'function' ? engine.getWires() : [];
      for (var i = 0; i < oldWires.length; i++) {
        engine.removeWire(String(oldWires[i].id));
      }
    }

    // 2. 电源
    if (typeof engine.setPower === 'function') {
      engine.setPower(project.power !== false);
    }

    // 3. 开关
    if (typeof engine.setSwitch === 'function') {
      for (var s = 1; s <= SWITCH_COUNT; s++) {
        var label = '5K' + s;
        if (project.switches[label]) {
          engine.setSwitch(s, 1);
        }
      }
    }

    // 3.5 板载仪器（v1 增量字段；旧版本文件没有 instruments 时整段跳过）
    var ins = project.instruments || null;
    if (ins) {
      if (ins.probeMode && typeof engine.setProbeMode === 'function') {
        try {
          engine.setProbeMode(ins.probeMode);
        } catch (errIns1) {
          warnings.push('逻辑笔模式恢复失败：' + (errIns1 && errIns1.message ? errIns1.message : '未知错误'));
        }
      }
      if (ins.dds && typeof engine.setDds === 'function') {
        try {
          engine.setDds(ins.dds);
        } catch (errIns2) {
          warnings.push('信号源参数恢复失败：' + (errIns2 && errIns2.message ? errIns2.message : '未知错误'));
        }
      }
      if (ins.potRatio !== null && ins.potRatio !== undefined && typeof engine.setPotRatio === 'function') {
        try {
          engine.setPotRatio(ins.potRatio);
        } catch (errIns3) {
          warnings.push('电位器位置恢复失败：' + (errIns3 && errIns3.message ? errIns3.message : '未知错误'));
        }
      }
    }

    // 4. 芯片（单个失败只降级为警告）
    if (typeof engine.mountChip === 'function') {
      for (var socketId in project.chips) {
        if (!Object.prototype.hasOwnProperty.call(project.chips, socketId)) {
          continue;
        }
        try {
          // P5b：引擎对已占插座改为抛错。reset 后本应为空，这里兜底防御
          // （无 reset 的旧引擎走降级路径时插座可能仍被占用）。
          if (typeof engine.getChip === 'function' && engine.getChip(socketId)) {
            engine.unmountChip(socketId);
          }
          engine.mountChip(socketId, project.chips[socketId]);
        } catch (err) {
          warnings.push('插座 ' + socketId + ' 安装 ' + project.chips[socketId] + ' 失败：' + (err && err.message ? err.message : '未知错误'));
        }
      }
    }

    // 5. 导线（校验阶段已确认插孔存在，这里失败视为数据冲突）
    for (var w = 0; w < project.wires.length; w++) {
      engine.addWire(project.wires[w]);
    }

    // 6. 推进一次仿真，让电平立即生效
    if (typeof engine.step === 'function') {
      engine.step(typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    }
  }

  /** 读取文件文本（兼容 File / Blob / 字符串 / 普通对象，便于 Node 自测） */
  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      if (typeof file === 'string') {
        resolve(file);
        return;
      }
      if (!file) {
        reject(new Error('没有选择文件'));
        return;
      }
      // 注意：File/Blob 也是 object，必须排在 isPlainObject 之前判断，
      // 否则会被 JSON.stringify 成 "{}"，导致 format 丢失。
      var isBlob = typeof Blob !== 'undefined' && file instanceof Blob;
      if (!isBlob && isPlainObject(file)) {
        resolve(JSON.stringify(file));
        return;
      }
      if (!isBlob && typeof file.text === 'function') {
        // 现代浏览器的 File.text() 兜底
        file.text().then(resolve, reject);
        return;
      }
      if (typeof FileReader === 'undefined') {
        reject(new Error('当前环境不支持 FileReader'));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result));
      };
      reader.onerror = function () {
        reject(new Error('读取文件失败'));
      };
      try {
        reader.readAsText(file, 'utf-8');
      } catch (err) {
        reject(new Error('读取文件失败：' + (err && err.message ? err.message : '未知错误')));
      }
    });
  }

  /**
   * 导入工程。
   * @returns {Promise<{ok:boolean, message:string, warnings?:string[]}>}
   */
  function importProject(file, engine) {
    return readFileText(file).then(function (text) {
      var raw;
      try {
        raw = JSON.parse(text);
      } catch (err) {
        return { ok: false, message: 'JSON 解析失败，文件可能已损坏：' + (err && err.message ? err.message : '未知错误') };
      }
      var checked = validateProject(raw, engine);
      if (!checked.ok) {
        return { ok: false, message: '导入失败：' + checked.message };
      }

      var warnings = [];
      if (checked.unknownSockets.length) {
        warnings.push('已忽略未知插座：' + checked.unknownSockets.join('、'));
      }
      if (checked.instrumentWarnings && checked.instrumentWarnings.length) {
        for (var wi = 0; wi < checked.instrumentWarnings.length; wi++) {
          warnings.push(checked.instrumentWarnings[wi]);
        }
      }
      try {
        applyProject(checked.project, engine, warnings);
      } catch (err) {
        return { ok: false, message: '导入失败：重建工程时出错（' + (err && err.message ? err.message : '未知错误') + '）' };
      }

      // 广播：Interaction 监听后重绘并清空撤销栈
      if (typeof document !== 'undefined' && document.dispatchEvent && typeof CustomEvent !== 'undefined') {
        document.dispatchEvent(new CustomEvent('dlab:project-imported', { detail: checked.project }));
      }

      var message = '导入成功：' + checked.project.wires.length + ' 根导线，' +
        Object.keys(checked.project.chips).length + ' 颗芯片';
      if (warnings.length) {
        message += '（' + warnings.join('；') + '）';
      }
      return { ok: true, message: message, warnings: warnings };
    }).catch(function (err) {
      return { ok: false, message: '导入失败：' + (err && err.message ? err.message : '未知错误') };
    });
  }

  DLab.Persistence = {
    exportProject: exportProject,
    buildProject: buildProject,
    importProject: importProject,
    // 额外暴露，便于 Lead 与自测复用
    validateProject: validateProject,
    applyProject: applyProject,
    timestampName: timestampName,
    SOCKET_IDS: SOCKET_IDS,
    FORMAT: FORMAT,
    VERSION: VERSION
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

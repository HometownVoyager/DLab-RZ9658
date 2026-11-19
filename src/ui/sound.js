// src/ui/sound.js
// 板载音频合成：蜂鸣器（有源，自振音色）与功放扬声器（跟随输入信号频率）的声音输出。
// ------------------------------------------------------------------
// 约束与说明：
//   - 浏览器自动播放策略：AudioContext 必须在用户手势后才能出声。
//     本模块在第一次 pointerdown 时创建/恢复上下文；在此之前保持静默。
//   - Node 环境（无 AudioContext）全部为空操作，保证引擎自测不受影响。
//   - 音频完全由 engine.getState().analog 驱动，本模块不读不改任何电气状态。
(function (global) {
  'use strict';

  var DLab = (global.DLab = global.DLab || {});

  var BUZZER_HZ = (DLab.Engine && DLab.Engine.BUZZER_TONE_HZ) || 2700;
  var SPK_GAIN = 0.09;          // 扬声器连续音量
  var BUZZER_GAIN = 0.12;       // 蜂鸣器音量
  var MASTER_GAIN = 0.9;

  // 人耳可听范围钳制：时钟 1MHz 之类直接播放会超声，钳到可听上限
  var TONE_MIN_HZ = 30;
  var TONE_MAX_HZ = 8000;

  function clampTone(hz) {
    if (!isFinite(hz) || hz <= 0) return null;
    return Math.min(TONE_MAX_HZ, Math.max(TONE_MIN_HZ, hz));
  }

  // —— Sound 单例 ——
  var Sound = {
    _ctx: null,          // AudioContext（懒创建）
    _master: null,
    _buzzerOsc: null,
    _buzzerGain: null,
    _spkOsc: null,
    _spkGain: null,
    _muted: false,
    _spkLastDrive: 0,    // 上一帧扬声器驱动频率（0=无），用于直流「嗒」声的边沿检测
    _spkLastLevel: null,

    /** 音频是否可用（浏览器环境才有） */
    supported: function () {
      return typeof global.AudioContext !== 'undefined' ||
             typeof global.webkitAudioContext !== 'undefined';
    },

    /** 创建音频图（幂等）。由首次用户手势触发，绕开自动播放限制 */
    ensure: function () {
      if (this._ctx || !this.supported()) return this._ctx;
      var AC = global.AudioContext || global.webkitAudioContext;
      var ctx;
      try {
        ctx = new AC();
      } catch (err) {
        return null;
      }
      this._ctx = ctx;

      this._master = ctx.createGain();
      this._master.gain.value = MASTER_GAIN;
      this._master.connect(ctx.destination);

      // 蜂鸣器：有源器件自振音色（方波）+ 门控增益
      this._buzzerOsc = ctx.createOscillator();
      this._buzzerOsc.type = 'square';
      this._buzzerOsc.frequency.value = BUZZER_HZ;
      this._buzzerGain = ctx.createGain();
      this._buzzerGain.gain.value = 0;
      this._buzzerOsc.connect(this._buzzerGain).connect(this._master);
      this._buzzerOsc.start();

      // 扬声器：正弦振荡器跟随输入信号频率
      this._spkOsc = ctx.createOscillator();
      this._spkOsc.type = 'sine';
      this._spkOsc.frequency.value = 440;
      this._spkGain = ctx.createGain();
      this._spkGain.gain.value = 0;
      this._spkOsc.connect(this._spkGain).connect(this._master);
      this._spkOsc.start();

      return ctx;
    },

    /** 恢复/创建音频上下文（绑定到用户手势；页面任意点击都会调用） */
    unlock: function () {
      var ctx = this.ensure();
      if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        ctx.resume();
      }
    },

    /** 静音开关 */
    setMuted: function (m) {
      this._muted = !!m;
      if (this._master) {
        this._master.gain.value = this._muted ? 0 : MASTER_GAIN;
      }
      return this._muted;
    },

    getMuted: function () {
      return this._muted;
    },

    /**
     * 按引擎状态同步蜂鸣器与扬声器（每帧调用；内部按目标值去抖）。
     * @param {object} [analog] engine.getState().analog
     */
    syncAnalog: function (analog) {
      if (!analog || !this._ctx) return;

      // 蜂鸣器：高电平即鸣（电平随时间翻转时自然产生断续鸣叫）
      var beepOn = !!(analog.beep && analog.beep.on);
      if (this._buzzerGain) {
        var want = beepOn && !this._muted ? BUZZER_GAIN : 0;
        if (Math.abs(this._buzzerGain.gain.value - want) > 0.001) {
          this._buzzerGain.gain.setTargetAtTime(want, this._ctx.currentTime, 0.008);
        }
      }

      // 扬声器：只有交流源（时钟 / DDS）才连续发声；直流接通瞬间来一声低频「嗒」
      var drive = analog.spk && analog.spk.driveHz ? clampTone(analog.spk.driveHz) : null;
      if (this._spkGain) {
        var want2 = drive && !this._muted ? SPK_GAIN : 0;
        if (Math.abs(this._spkGain.gain.value - want2) > 0.001) {
          this._spkGain.gain.setTargetAtTime(want2, this._ctx.currentTime, 0.01);
        }
        if (drive && this._spkOsc.frequency.value !== drive) {
          this._spkOsc.frequency.setTargetAtTime(drive, this._ctx.currentTime, 0.01);
        }
      }
      // 直流边沿 → 短促低频声（接通扬声器的「啪」声）
      var spkLevel = analog.spk ? analog.spk.level : 'Z';
      if (spkLevel !== this._spkLastLevel) {
        if (spkLevel === '1' && this._spkLastLevel !== null &&
            (!drive || this._spkLastDrive === null) && !this._muted) {
          this.thump();
        }
        this._spkLastLevel = spkLevel;
      }
      this._spkLastDrive = drive || 0;
    },

    /** 短促低频声（扬声器接通直流时的「嗒」） */
    thump: function () {
      var ctx = this.ensure();
      if (!ctx || this._muted) return;
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(150, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.08);
      g.gain.setValueAtTime(SPK_GAIN * 1.4, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.1);
      osc.connect(g).connect(this._master);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    },

    /**
     * 播放一声短促提示音（点击试听用，与板载电气状态无关）。
     * @param {number} [ms] 时长，默认 180ms
     * @param {number} [hz] 频率，默认蜂鸣器自振频率
     */
    beep: function (ms, hz) {
      var ctx = this.ensure();
      if (!ctx || this._muted) return;
      var dur = Math.max(0.03, (ms || 180) / 1000);
      var freq = clampTone(hz || BUZZER_HZ) || BUZZER_HZ;
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(BUZZER_GAIN, ctx.currentTime + 0.01);
      g.gain.setValueAtTime(BUZZER_GAIN, ctx.currentTime + dur - 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      osc.connect(g).connect(this._master);
      osc.start();
      osc.stop(ctx.currentTime + dur + 0.02);
    }
  };

  DLab.Sound = Sound;
})(typeof globalThis !== 'undefined' ? globalThis : this);

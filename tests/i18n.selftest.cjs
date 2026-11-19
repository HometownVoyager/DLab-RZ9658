// tests/i18n.selftest.cjs
// i18n 基础设施自测（纯 Node，无 DOM / 无 localStorage）。
'use strict';

var assert = require('assert');

// 隔离的全局：不污染真实 globalThis.DLab 之外的测试环境
globalThis.localStorage = undefined;
globalThis.document = undefined;
globalThis.DLab = {};
require('../src/i18n.js');
var i18n = globalThis.DLab.i18n;

assert.ok(i18n, 'DLab.i18n 应被注册');

// —— 默认值 ——
assert.strictEqual(i18n.getLang(), 'zh-CN', '默认语言应为 zh-CN');
assert.strictEqual(i18n.t('topbar.title'), '数字电路实验箱');
assert.strictEqual(i18n.t('hud.action.undo'), '撤销');

// —— 未知 key 与回退 ——
assert.strictEqual(i18n.t('no.such.key'), 'no.such.key', '未知 key 应回退为 key 本身');
assert.strictEqual(i18n.t('no.such.key', null, '回退值'), '回退值', '未知 key 应使用 fallback');

// —— 插值 ——
assert.strictEqual(
  i18n.t('hud.swatch.title', { name: '红', hint: 'VCC / 电源', color: '#ef4444' }),
  '红（VCC / 电源） #ef4444'
);

// —— 切换到英文 ——
var changes = [];
var unsub = i18n.onChange(function (lang) { changes.push(lang); });
assert.strictEqual(i18n.setLang('en'), 'en');
assert.strictEqual(i18n.getLang(), 'en');
assert.deepStrictEqual(changes, ['en'], 'onChange 应以新语言回调一次');
assert.strictEqual(i18n.t('topbar.title'), 'Digital Circuit Lab');
assert.strictEqual(i18n.t('hud.action.undo'), 'Undo');
assert.strictEqual(
  i18n.t('hud.swatch.title', { name: 'Red', hint: 'VCC / power', color: '#ef4444' }),
  'Red (VCC / power) #ef4444'
);

// —— 非法语言被忽略 ——
assert.strictEqual(i18n.setLang('xx'), 'en');
assert.strictEqual(i18n.getLang(), 'en');
assert.strictEqual(i18n.setLang('en'), 'en', '重复设置同一语言不应再次通知');
assert.strictEqual(changes.length, 1);

// —— 动态文案整句 / 正则 / 片段翻译 ——
assert.strictEqual(i18n.translateText('就绪'), 'Ready');
assert.strictEqual(i18n.translateText('已清空 3 根导线（Ctrl+Z 可撤销）'), 'Cleared 3 wire(s) (undo with Ctrl+Z)');
assert.strictEqual(i18n.translateText('导入失败：未知错误'), 'Import failed: Unknown error');
assert.strictEqual(i18n.translateText('起点：devA:A1，点击另一个插孔完成接线（Esc 取消）'),
  'Start: devA:A1 — click another jack to complete (Esc to cancel)');
// 中文态原样返回
i18n.setLang('zh-CN');
assert.strictEqual(i18n.translateText('已清空 3 根导线（Ctrl+Z 可撤销）'), '已清空 3 根导线（Ctrl+Z 可撤销）');
assert.strictEqual(changes.length, 2, '切回中文应再次回调');

// —— 反订阅 ——
unsub();
i18n.setLang('en');
assert.strictEqual(changes.length, 2, '反订阅后不应再收到回调');

// —— 无 DOM 时 scan / scanText 返回 0 且不抛错 ——
assert.strictEqual(i18n.scan(), 0);
assert.strictEqual(i18n.scanText(), 0);

console.log('i18n 自测通过：' + [
  '默认值', '回退', '插值', '语言切换', '非法值忽略',
  '动态文案翻译', '反订阅', '无 DOM 安全'
].join(' / '));

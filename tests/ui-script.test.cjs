const assert = require('node:assert/strict');
const { test } = require('node:test');
const sources = require('./files.cjs');

// README「HtmlService インライン JS の注意」の確認を自動化する。
// GAS 配信時に <script> が崩れると、ログイン画面のボタンなども動かなくなる。
const scripts = sources.uiScriptFiles();

test('the screen scripts are all included', () => {
  assert.deepEqual(scripts, ['UiCore.html', 'UiMedia.html', 'UiPreview.html', 'UiEditors.html', 'UiPublish.html']);
});

test('the screen scripts parse and load in the order Ui.html includes them', () => {
  scripts.forEach((name) => assert.doesNotThrow(() => new Function(sources.uiScriptSource(name)), name));
  assert.doesNotThrow(() => sources.loadClient());
});

test('the screen scripts avoid strings that break when served by HtmlService', () => {
  const offending = scripts.flatMap((name) => sources.read(name).split(/\r?\n/)
    .map((line, index) => ({ line, at: name + ':' + (index + 1) }))
    .filter(({ line }) => /https?:\/\/|\/\/|image\/\*/.test(line))
    .map(({ line, at }) => `${at}: ${line.trim()}`));
  assert.deepEqual(offending, []);
});

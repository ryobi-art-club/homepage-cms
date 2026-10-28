const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

// README「HtmlService インライン JS の注意」の確認を自動化する。
// GAS 配信時に <script> が崩れると、ログイン画面のボタンなども動かなくなる。
const source = fs.readFileSync(path.join(__dirname, '..', 'UiScript.html'), 'utf8');

test('UiScript.html parses as JavaScript', () => {
  const script = source.replace(/^<script>\s*/, '').replace(/\s*<\/script>\s*$/, '');
  assert.doesNotThrow(() => new Function(script));
});

test('UiScript.html avoids strings that break when served by HtmlService', () => {
  const lines = source.split(/\r?\n/);
  const offending = lines
    .map((line, index) => ({line, number: index + 1}))
    .filter(({line}) => /https?:\/\/|\/\/|image\/\*/.test(line))
    .map(({line, number}) => `${number}: ${line.trim()}`);
  assert.deepEqual(offending, []);
});

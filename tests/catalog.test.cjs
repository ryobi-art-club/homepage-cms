const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

function setup() {
  const requests = [];
  const ctx = vm.createContext({
    Logger: {log() {}},
    Utilities: {sleep() {}},
    UrlFetchApp: {
      fetch: (_, options) => {
        requests.push(JSON.parse(options.payload));
        const items = [{sort_order: 1, artist: '山田 花子', title: '春の海', size: 'F10', materials: '油彩'}];
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({output_text: JSON.stringify({items})})
        };
      }
    }
  });
  for (const name of ['Config.js', 'Gemini.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), ctx);
  }
  ctx.getConfig_ = () => ({GEMINI_API_KEY: 'key', GEMINI_MODEL: 'model'});
  ctx.requireSession_ = () => ({});
  ctx.normalizeStringList_ = (value) => value;
  return {ctx, requests};
}

test('legacy PDF request is still accepted', () => {
  const {ctx, requests} = setup();
  const result = ctx.extractExhibitionCatalog('token', {name: '目録.pdf', mimeType: 'application/pdf', data: 'AAAA'});
  assert.equal(result.items.length, 1);
  assert.deepEqual(requests[0].input[0], {type: 'document', data: 'AAAA', mime_type: 'application/pdf'});
  assert.equal(requests[0].input[1].type, 'text');
});

test('multiple images are sent in order, followed by the prompt', () => {
  const {ctx, requests} = setup();
  ctx.extractExhibitionCatalog('token', {name: 'p1.jpg ほか1枚', parts: [
    {kind: 'image', mimeType: 'image/jpeg', data: 'P1'},
    {kind: 'image', mimeType: 'image/heic', data: 'P2'}
  ]});
  const input = requests[0].input;
  assert.equal(input.length, 3);
  assert.deepEqual(input.slice(0, 2).map(x => [x.type, x.data, x.mime_type]), [['image', 'P1', 'image/jpeg'], ['image', 'P2', 'image/heic']]);
  assert.match(input[2].text, /複数の画像/);
});

test('text (including Excel converted to CSV) is sent as text with its file name', () => {
  const {ctx, requests} = setup();
  ctx.extractExhibitionCatalog('token', {name: '目録.xlsx', parts: [{kind: 'text', name: '目録.xlsx', text: '## シート: 目録\nNo,作家\n1,山田'}]});
  assert.equal(requests[0].input[0].type, 'text');
  assert.match(requests[0].input[0].text, /^目録ファイル「目録\.xlsx」の内容:\n## シート/);
});

test('unsupported, empty and oversized parts are rejected before calling Gemini', () => {
  const {ctx, requests} = setup();
  assert.throws(() => ctx.extractExhibitionCatalog('token', {name: 'a.gif', parts: [{kind: 'image', mimeType: 'image/gif', data: 'x'}]}), /対応していない画像形式/);
  assert.throws(() => ctx.extractExhibitionCatalog('token', {name: 'a', parts: [{kind: 'docx', data: 'x'}]}), /対応していない目録ファイル/);
  assert.throws(() => ctx.extractExhibitionCatalog('token', {name: 'a', parts: [{kind: 'text', text: '  '}]}), /空/);
  assert.throws(() => ctx.extractExhibitionCatalog('token', {name: 'a', parts: [{kind: 'pdf', data: 'x'.repeat(15 * 1024 * 1024)}]}), /大きすぎ/);
  assert.throws(() => ctx.extractExhibitionCatalog('token', {name: 'a', parts: Array.from({length: 21}, () => ({kind: 'image', mimeType: 'image/png', data: 'x'}))}), /20枚以下/);
  assert.equal(requests.length, 0);
});

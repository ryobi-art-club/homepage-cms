const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');

class Sheet {
  constructor() {
    this.values = [];
    this.maxRows = 2;
    this.maxColumns = 5;
  }
  getLastRow() {
    return this.values.reduce((last, row, i) => row.some(x => x !== '') ? i + 1 : last, 0);
  }
  getLastColumn() {
    return Math.max(0, ...this.values.map(row => row.reduce((last, x, i) => x !== '' ? i + 1 : last, 0)));
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxColumns; }
  insertRowsAfter(_, count) { this.maxRows += count; }
  insertColumnsAfter(_, count) { this.maxColumns += count; }
  getRange(row, col, rows, cols) {
    return {
      getValues: () => Array.from({length: rows}, (_, r) =>
        Array.from({length: cols}, (_, c) => this.values[row + r - 1]?.[col + c - 1] ?? '')),
      setValues: values => values.forEach((valuesRow, r) => valuesRow.forEach((value, c) => {
        this.values[row + r - 1] ||= [];
        this.values[row + r - 1][col + c - 1] = value;
      }))
    };
  }
}

function setup(geminiReply) {
  const sheets = {};
  const spreadsheet = {
    getSheetByName: name => sheets[name] || null,
    insertSheet: name => (sheets[name] = new Sheet())
  };
  const requests = [];
  const ctx = vm.createContext({
    SpreadsheetApp: {openById: () => spreadsheet, flush() {}},
    LockService: {getScriptLock: () => ({waitLock() {}, releaseLock() {}})},
    Logger: {log() {}},
    Utilities: {
      sleep() {},
      DigestAlgorithm: {SHA_256: 'sha256'},
      Charset: {UTF_8: 'utf8'},
      computeDigest: (_, value) => Array.from(crypto.createHash('sha256').update(value, 'utf8').digest()).map(b => b > 127 ? b - 256 : b)
    },
    UrlFetchApp: {
      fetch: (_, options) => {
        const payload = JSON.parse(options.payload);
        const input = JSON.parse(payload.input[0].text.split('入力:\n')[1]);
        requests.push(input);
        const issues = geminiReply(input);
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({output_text: JSON.stringify({issues})})
        };
      }
    }
  });
  for (const name of ['Config.js', 'Store.js', 'Gemini.js', 'Proofread.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), ctx);
  }
  ctx.getConfig_ = () => ({GEMINI_API_KEY: 'key', GEMINI_MODEL: 'model'});
  ctx.requireSession_ = () => ({});
  ctx.isoNow_ = () => '2026-10-07T00:00:00.000Z';
  return {ctx, sheets, requests};
}

const fields = [
  {id: 'activity:0:title', label: '記事', text: '春の写生会'},
  {id: 'activity:0:body', label: '本文', text: '天候にも恵まれまた。'}
];

test('checking never records; only markProofreadChecked (after publishing) does', () => {
  const {ctx, requests} = setup(() => []);
  const first = ctx.proofreadForPublish('token', fields);
  assert.equal(first.pendingCount, 2);
  assert.deepEqual([...first.cleanFieldIds], ['activity:0:title', 'activity:0:body']);
  assert.equal(requests.length, 1);

  // 公開しなかった（記録しなかった）場合は、次回もチェックされる。
  assert.equal(ctx.proofreadForPublish('token', fields).pendingCount, 2);

  ctx.markProofreadChecked('token', fields.map(x => x.text));
  assert.equal(ctx.proofreadForPublish('token', fields).pendingCount, 0);
  assert.equal(requests.length, 2);

  const edited = ctx.proofreadForPublish('token', [fields[0], {...fields[1], text: '新しい本文'}]);
  assert.equal(edited.pendingCount, 1);
  assert.deepEqual(requests[2].map(x => x.id), ['activity:0:body']);
});

test('fields with issues are not reported as clean', () => {
  const {ctx} = setup(input => input
    .filter(x => x.text.includes('恵まれまた'))
    .map(x => ({id: x.id, original: '恵まれまた', suggestion: '恵まれました', reason: '脱字'})));
  const result = ctx.proofreadForPublish('token', fields);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].fieldId, 'activity:0:body');
  assert.equal(result.issues[0].label, '本文');
  assert.deepEqual([...result.cleanFieldIds], ['activity:0:title']);
});

test('issues that cannot be located in the text are dropped', () => {
  const {ctx} = setup(input => [
    {id: input[0].id, original: '存在しない', suggestion: 'x', reason: '誤字'},
    {id: 'unknown', original: '春', suggestion: '夏', reason: '誤字'},
    {id: input[0].id, original: '春', suggestion: '春', reason: '誤字'}
  ]);
  assert.equal(ctx.proofreadForPublish('token', fields).issues.length, 0);
});

test('issues are kept even when the text appears more than once', () => {
  const text = '絵をかくのは楽しいは。また来年もかくのは楽しみです。';
  const {ctx} = setup(input => [
    {id: input[0].id, original: 'は', suggestion: 'です', reason: '誤字'},
    {id: input[0].id, original: 'は', suggestion: 'です', reason: '誤字'}
  ]);
  const issues = ctx.proofreadForPublish('token', [{id: 'f', label: '', text}]).issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].original, 'は');
});

test('records for texts no longer published are pruned', () => {
  const {ctx, sheets} = setup(() => []);
  ctx.markProofreadChecked('token', fields.map(x => x.text));
  assert.equal(Object.keys(ctx.readProofreadCheckedHashes_()).length, 2);
  ctx.proofreadForPublish('token', [fields[0]]);
  assert.equal(Object.keys(ctx.readProofreadCheckedHashes_()).length, 1);
  assert.ok(sheets._ProofreadChecked);
});

test('a Gemini failure reports the remaining count and no clean fields', () => {
  const {ctx} = setup(() => { throw new Error('boom'); });
  const result = ctx.proofreadForPublish('token', fields);
  assert.match(result.error, /boom/);
  assert.equal(result.remainingCount, 2);
  assert.deepEqual([...result.cleanFieldIds], []);
  assert.equal(ctx.proofreadForPublish('token', fields).pendingCount, 2);
});

test('large content is split into batches', () => {
  const {ctx, requests} = setup(() => []);
  const many = Array.from({length: 5}, (_, i) => ({id: 'f' + i, label: '', text: String(i).repeat(4000)}));
  ctx.proofreadForPublish('token', many);
  assert.equal(requests.length, 5);
});

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

class Sheet {
  constructor(values = []) {
    this.values = values.map(row => row.slice());
    this.maxRows = Math.max(2, values.length);
    this.maxColumns = Math.max(5, ...values.map(row => row.length));
    this.failRow = 0;
    this.writes = 0;
    this.frozenRows = 1;
    this.frozenColumns = 0;
  }
  getLastRow() {
    return this.values.reduce((last, row, i) => row.some(x => x !== '') ? i + 1 : last, 0);
  }
  getLastColumn() {
    return Math.max(0, ...this.values.map(row => row.reduce((last, x, i) => x !== '' ? i + 1 : last, 0)));
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxColumns; }
  getFrozenRows() { return this.frozenRows; }
  getFrozenColumns() { return this.frozenColumns; }
  deleteRows(start, count) {
    assert.ok(start > this.frozenRows + 1);
    assert.ok(start + count - 1 <= this.maxRows);
    this.values.splice(start - 1, count);
    this.maxRows -= count;
  }
  deleteColumns(start, count) {
    assert.ok(start > this.frozenColumns + 1);
    assert.ok(start + count - 1 <= this.maxColumns);
    this.values.forEach(row => row.splice(start - 1, count));
    this.maxColumns -= count;
  }
  insertRowsAfter(_, count) { this.maxRows += count; }
  insertColumnsAfter(_, count) { this.maxColumns += count; }
  insertRowAfter(row) { this.values.splice(row, 0, []); this.maxRows++; }
  deleteRow(row) { this.values.splice(row - 1, 1); this.maxRows--; }
  getRange(row, col, rows, cols) {
    assert.ok(row + rows - 1 <= this.maxRows);
    assert.ok(col + cols - 1 <= this.maxColumns);
    return {
      getValues: () => Array.from({length: rows}, (_, r) =>
        Array.from({length: cols}, (_, c) => this.values[row + r - 1]?.[col + c - 1] ?? '')),
      setValues: values => {
        if (this.failRow === row) throw new Error('Simulated write failure');
        assert.equal(values.length, rows);
        values.forEach(valuesRow => {
          assert.equal(valuesRow.length, cols);
          valuesRow.forEach(value => {
            if (typeof value === 'string') assert.ok(value.length <= 50000);
          });
        });
        this.writes++;
        values.forEach((valuesRow, r) => valuesRow.forEach((value, c) => {
          this.values[row + r - 1] ||= [];
          this.values[row + r - 1][col + c - 1] = value;
        }));
      }
    };
  }
}

function setup() {
  const sheets = {};
  const spreadsheet = {
    getSheetByName: name => sheets[name] || null,
    insertSheet: name => (sheets[name] = new Sheet())
  };
  const ctx = vm.createContext({
    SpreadsheetApp: {openById: () => spreadsheet, flush() {}},
    Utilities: {getUuid: () => 'draft-test'}
  });
  for (const name of ['Config.js', 'Store.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), ctx);
  }
  ctx.getConfig_ = () => ({});
  ctx.isoNow_ = () => '2026-09-24T00:00:00.000Z';
  return {ctx, sheets, spreadsheet};
}

function sample(ctx) {
  const payload = {
    recruitCalendars: [{year: '2026', mediaFileIds: ['calendar']}],
    activityArticles: [{articleId: 'a', title: 'Article', category: 'record', body: 'Text'}],
    requestCases: [{caseId: 'r', title: 'Request', body: 'Text'}],
    exhibitions: [{exhibitionId: 'e', title: 'Exhibition', displayBucket: 'archive',
      workFiles: [{fileId: 'image', sortOrder: 1, title: 'Work', artist: 'Artist'}]}]
  };
  return ctx.normalizePayload_(payload, {}, {allowIncomplete: true});
}

function asRow(ctx, cells) {
  return Object.fromEntries(ctx.payloadCellHeaders_(cells.length).map((key, i) => [key, cells[i]]));
}

test('compact draft restores all compatibility fields and does not mutate the source', () => {
  const {ctx} = setup();
  const state = sample(ctx);
  const original = ctx.stableStringify_(state);
  const cells = ctx.buildPayloadCells_(state);
  assert.ok(cells[0].length < original.length);
  const restored = ctx.restoreStoredPayload_(ctx.readPayloadCells_(asRow(ctx, cells)), true);
  assert.equal(ctx.stableStringify_(restored), original);
  assert.equal(ctx.stableStringify_(state), original);
});

test('legacy draft and public snapshot keep the same client data and hash input', () => {
  const {ctx} = setup();
  const state = sample(ctx);
  const oldDraft = ctx.stableStringify_(state);
  assert.equal(ctx.stableStringify_(ctx.restoreStoredPayload_(ctx.readPayloadCells_({payload_json: oldDraft}), true)), oldDraft);
  const snapshot = ctx.buildPublicSnapshot_(state);
  const original = ctx.stableStringify_(snapshot);
  for (const cells of [[original], ctx.buildPayloadCells_(snapshot)]) {
    assert.equal(ctx.stableStringify_(ctx.restoreStoredPayload_(ctx.readPayloadCells_(asRow(ctx, cells)), false)), original);
  }
});

test('large JSON with Japanese, emoji, escapes and formula-like text round trips', () => {
  const {ctx} = setup();
  const payload = {text: ('作品\n😀\\"=SUM(A1)0123').repeat(12000)};
  const cells = ctx.buildPayloadCells_(payload);
  assert.ok(cells.length > 10);
  assert.ok(cells.every(cell => cell.length <= 50000 && !cell.startsWith('=')));
  assert.equal(ctx.stableStringify_(ctx.readPayloadCells_(asRow(ctx, cells))), ctx.stableStringify_(payload));
  const row = asRow(ctx, cells);
  delete row.payload_json_3;
  assert.throws(() => ctx.readPayloadCells_(row), /JSON/);
});

test('legacy, empty failed rows, large and small drafts coexist', () => {
  const {ctx, sheets} = setup();
  const state = sample(ctx);
  sheets._Drafts = new Sheet([
    ['draft_id', 'saved_at', 'saved_by_name', 'saved_by_email', 'payload_json'],
    ['failed', 'date', 'name', 'email', ''],
    ['old', 'date', 'name', 'email', ctx.stableStringify_(state)]
  ]);
  const large = {...state, manualChangeNote: 'x'.repeat(100000)};
  ctx.saveDraftRecord_(large, 'name', 'email');
  ctx.saveDraftRecord_(state, 'name', 'email');
  const drafts = ctx.readDrafts_();
  assert.equal(drafts.length, 3);
  assert.ok(drafts.some(x => x.payload.manualChangeNote.length === 100000));
  assert.ok(drafts.every(x => x.payload.exhibitions[0].works[0].fileId === 'image'));
  const before = JSON.stringify(sheets._Drafts.values);
  sheets._Drafts.failRow = 2;
  assert.throws(() => ctx.saveDraftRecord_(state, 'name', 'email'), /Simulated/);
  assert.equal(JSON.stringify(sheets._Drafts.values), before);
});

test('published snapshot grows and shrinks without stale chunks or hash changes', () => {
  const {ctx, sheets} = setup();
  const small = ctx.buildPublicSnapshot_(sample(ctx));
  const large = {...small, extra: 'x'.repeat(600000)};
  for (const [i, value] of [large, small].entries()) {
    ctx.writePublishedState_(ctx.stableStringify_(value), 'hash-' + i);
    const result = ctx.readPublishedState_();
    assert.equal(ctx.stableStringify_(result.payload), ctx.stableStringify_(value));
    assert.equal(result.sha256, 'hash-' + i);
    assert.equal(result.revision, i + 1);
  }
  assert.equal(sheets._PublishedState.getLastColumn(), 4);
  const before = JSON.stringify(sheets._PublishedState.values);
  sheets._PublishedState.failRow = 1;
  assert.throws(() => ctx.writePublishedState_(ctx.stableStringify_(large), 'new'), /Simulated/);
  assert.equal(JSON.stringify(sheets._PublishedState.values), before);
});

test('oversized public content fails before any sheet is changed', () => {
  const {ctx, spreadsheet, sheets} = setup();
  const state = sample(ctx);
  state.exhibitions[0].workFiles[0].title = 'x'.repeat(51000);
  const sheet = spreadsheet.insertSheet('Recruit');
  sheet.values = [['previous']];
  assert.throws(() => ctx.writeStateToSheets_(state, '', '', true), /Exhibitions.*work_files/);
  assert.equal(sheet.writes, 0);
  assert.equal(Object.keys(sheets).length, 1);
});

test('publish cleanup removes surplus grids and draft headers; subsequent large saves still work', () => {
  const {ctx, sheets} = setup();
  const state = sample(ctx);
  const large = {...state, manualChangeNote: 'x'.repeat(600000)};
  ctx.saveDraftRecord_(large, 'name', 'email');
  ctx.writePublishedState_(ctx.stableStringify_(ctx.buildPublicSnapshot_(state)), 'hash');
  sheets._Drafts.maxRows = 2000;
  sheets._PublishedState.maxRows = 1000;
  sheets._PublishedState.maxColumns = 60;
  sheets._AdminLog = new Sheet([['timestamp', 'detail'], ['date', 'history'], [], ['later', 'history2']]);
  sheets._AdminLog.maxRows = 1000;
  sheets._AdminLog.maxColumns = 26;
  sheets.Personal = new Sheet([['keep']]);
  sheets.Personal.maxRows = 1000;
  const history = JSON.stringify(sheets._AdminLog.values);
  const snapshot = ctx.stableStringify_(ctx.readPublishedState_());
  ctx.clearDrafts_();
  ctx.compactContentSheetGrids_();
  assert.equal(sheets._Drafts.maxRows, 2);
  assert.equal(sheets._Drafts.maxColumns, 5);
  assert.equal(ctx.readDrafts_().length, 0);
  assert.equal(sheets._PublishedState.maxRows, 2);
  assert.equal(sheets._PublishedState.maxColumns, 4);
  assert.equal(ctx.stableStringify_(ctx.readPublishedState_()), snapshot);
  assert.equal(JSON.stringify(sheets._AdminLog.values), history);
  assert.equal(sheets._AdminLog.maxRows, 4);
  assert.equal(sheets._AdminLog.maxColumns, 2);
  assert.equal(sheets.Personal.maxRows, 1000);
  ctx.compactContentSheetGrids_();
  ctx.saveDraftRecord_(large, 'name', 'email');
  assert.equal(ctx.stableStringify_(ctx.readDrafts_()[0].payload), ctx.stableStringify_(large));
  ctx.writePublishedState_(ctx.stableStringify_(ctx.buildPublicSnapshot_(large)), 'next');
  ctx.writeStateToSheets_(state, '', '', true);
  assert.equal(ctx.readContentState_().exhibitions.length, 1);
});

test('grid cleanup preserves active split drafts, frozen regions and empty sheets', () => {
  const {ctx, sheets} = setup();
  const state = {...sample(ctx), manualChangeNote: 'x'.repeat(100000)};
  ctx.saveDraftRecord_(state, 'name', 'email');
  const before = ctx.stableStringify_(ctx.readDrafts_());
  sheets._Drafts.maxRows = 1000;
  sheets._Drafts.maxColumns = 100;
  sheets.Recruit = new Sheet();
  sheets.Recruit.frozenRows = 3;
  sheets.Recruit.frozenColumns = 2;
  sheets.Recruit.maxRows = 1000;
  sheets.Recruit.maxColumns = 26;
  ctx.compactContentSheetGrids_();
  assert.equal(ctx.stableStringify_(ctx.readDrafts_()), before);
  assert.equal(sheets._Drafts.maxRows, 2);
  assert.equal(sheets._Drafts.maxColumns, sheets._Drafts.getLastColumn());
  assert.equal(sheets.Recruit.maxRows, 4);
  assert.equal(sheets.Recruit.maxColumns, 3);
});

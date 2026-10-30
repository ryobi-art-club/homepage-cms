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
    const range = {
      setNumberFormat: format => {
        this.numberFormat = format;
        return range;
      },
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
    return range;
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
      works: [{fileId: 'image', title: 'Work', artist: 'Artist'}]}]
  };
  return ctx.normalizePayload_(payload, {}, {allowIncomplete: true});
}

function asRow(ctx, cells) {
  return Object.fromEntries(ctx.payloadCellHeaders_(cells.length).map((key, i) => [key, cells[i]]));
}

// 版1（2026年10月までの形）の内容。別名・作品の番号・新歓の写しなどを含む
function versionOneContent() {
  return {
    recruitCalendar: {year: '2026', folderId: 'fr', label: '2026年度 新歓イベントカレンダー'},
    recruitCalendars: [{year: '2026', folderId: 'fr', mediaFolderId: 'fr', mediaFileIds: ['c'], label: '2026年度 新歓イベントカレンダー', published: true, updatedAt: 'x'}],
    activityArticles: [{articleId: 'a', title: 'A', category: 'record', body: 'B', photoFolderId: 'fa', mediaFolderId: 'fa', mediaFileIds: ['p'], published: true, createdAt: '2026-01-01'}],
    exhibitions: [{exhibitionId: 'e', title: 'E', subtitle: '', theme: '', venueName: '', venueAddress: '', dateLine: '', timeLine: '', mapEmbedUrl: 'm',
      displayBucket: 'archive', driveFolderId: 'fe', mediaFolderId: 'fe', dmFileIds: ['dm'], published: true, startDate: '2026-01-01', endDate: '',
      workFiles: [{file_id: 'w2', sort_order: 2, title: 'Two', artist: 'B'}, {file_id: 'w1', sort_order: 1, title: 'One', artist: 'A'}]}],
    requestCases: [{caseId: 'r2', title: 'R2', body: '', photoFolderId: '', mediaFolderId: '', mediaFileIds: [], sortOrder: 2, published: true},
      {caseId: 'r1', title: 'R1', body: '', photoFolderId: 'fq', mediaFolderId: 'fq', mediaFileIds: ['q'], sortOrder: 1, published: true}]
  };
}

test('content saved in version 1 is read as version 2', () => {
  const {ctx, sheets} = setup();
  sheets._PublishedState = new Sheet([['updated_at', 'revision', 'sha256', 'payload_json'], ['t', '1', 'h', JSON.stringify(versionOneContent())]]);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.readPublishedState_().payload)), {
    formatVersion: 2,
    recruitCalendars: [{year: '2026', mediaFolderId: 'fr', mediaFileIds: ['c'], published: true}],
    activityArticles: [{articleId: 'a', title: 'A', category: 'record', body: 'B', mediaFolderId: 'fa', mediaFileIds: ['p'], published: true, createdAt: '2026-01-01'}],
    exhibitions: [{exhibitionId: 'e', title: 'E', subtitle: '', theme: '', venueName: '', venueAddress: '', dateLine: '', timeLine: '',
      displayBucket: 'archive', mediaFolderId: 'fe', dmFileIds: ['dm'], works: [{fileId: 'w1', title: 'One', artist: 'A'}, {fileId: 'w2', title: 'Two', artist: 'B'}],
      published: true, startDate: '2026-01-01', endDate: ''}],
    requestCases: [{caseId: 'r1', title: 'R1', body: '', mediaFolderId: 'fq', mediaFileIds: ['q'], published: true},
      {caseId: 'r2', title: 'R2', body: '', mediaFolderId: '', mediaFileIds: [], published: true}]
  });
  // 古い画面を開いたままの人が送った内容も、同じように受け付ける
  const fromOldScreen = ctx.normalizePayload_(versionOneContent(), ctx.readContentState_(), {allowIncomplete: true});
  assert.equal(ctx.stableStringify_(ctx.buildPublicSnapshot_(fromOldScreen)), ctx.stableStringify_(ctx.readPublishedState_().payload));
});

test('a draft keeps the content and the values used only while editing, but not the change log', () => {
  const {ctx} = setup();
  const state = {...sample(ctx), manualChangeNote: 'メモ'};
  ctx.saveDraftRecord_(state, 'name', 'email');
  const payload = ctx.readDrafts_()[0].payload;
  assert.equal(payload.formatVersion, 2);
  assert.equal(payload.manualChangeNote, 'メモ');
  assert.equal(payload.exhibitions[0].draftCreatedAt, state.exhibitions[0].draftCreatedAt);
  assert.ok(!('changeLog' in payload));
  assert.equal(ctx.stableStringify_(ctx.buildPublicSnapshot_(payload)), ctx.stableStringify_(ctx.buildPublicSnapshot_(state)));
});

test('large JSON with Japanese, emoji, escapes and formula-like text round trips', () => {
  const {ctx} = setup();
  const payload = {text: ('作品\n😀\\"=SUM(A1)0123').repeat(12000)};
  const cells = ctx.buildPayloadCells_(ctx.stableStringify_(payload));
  assert.ok(cells.length > 10);
  assert.ok(cells.every(cell => cell.length <= 50000 && !cell.startsWith('=')));
  assert.equal(ctx.stableStringify_(ctx.readPayloadCells_(asRow(ctx, cells))), ctx.stableStringify_(payload));
  const row = asRow(ctx, cells);
  delete row.payload_json_3;
  assert.throws(() => ctx.readPayloadCells_(row), /JSON/);
});

test('content sheets are written as plain text so formula- and date-like input stays literal', () => {
  const {ctx, sheets, spreadsheet} = setup();
  ctx.writeSheet_(spreadsheet, 'ActivityArticles', [['title', 'body'], ['=IMAGE("x")', '10/1']]);
  assert.equal(sheets.ActivityArticles.numberFormat, '@');
  assert.deepEqual(sheets.ActivityArticles.values[1], ['=IMAGE("x")', '10/1']);
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
  const large = JSON.parse(JSON.stringify(small));
  large.activityArticles[0].body = 'x'.repeat(600000);
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

function publish(ctx, state) {
  ctx.writePublishedState_(ctx.stableStringify_(ctx.buildPublicSnapshot_(state)), 'hash');
}

test('the content is read from _PublishedState, also when it is split over several cells', () => {
  const {ctx, sheets} = setup();
  const state = sample(ctx);
  state.exhibitions[0].works = Array.from({length: 200}, (_, i) => ({fileId: 'w' + i, title: '作品「' + i + '」'.repeat(20), artist: 'A'}));
  ['e2', 'e3', 'e4'].forEach((exhibitionId) => state.exhibitions.push({...state.exhibitions[0], exhibitionId, title: exhibitionId}));
  publish(ctx, state);
  assert.ok(sheets._PublishedState.values[0].includes('payload_json_3'), 'split');
  assert.ok(!sheets.Exhibitions && !sheets.ActivityArticles, 'the old content sheets are not written');
  const read = ctx.readContentState_();
  assert.equal(read.exhibitions.length, 4);
  assert.equal(read.exhibitions[0].works.length, 200);
  assert.equal(read.exhibitions[0].works[199].title, state.exhibitions[0].works[199].title);
  assert.equal(read.activityArticles[0].title, 'Article');
  assert.equal(read.requestCases[0].title, 'Request');
  assert.deepEqual(Array.from(read.recruitCalendars[0].mediaFileIds), ['calendar']);
  // what the CMS reads back is what it would publish again: nothing looks changed
  const again = ctx.normalizePayload_(JSON.parse(JSON.stringify(read)), read, {allowIncomplete: true});
  assert.equal(ctx.stableStringify_(ctx.buildPublicSnapshot_(again)), ctx.stableStringify_(ctx.buildPublicSnapshot_(state)));
});

test('with no snapshot the content is empty; a broken snapshot stops instead of showing nothing', () => {
  const {ctx, sheets} = setup();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.readContentState_())),
    {recruitCalendars: [], activityArticles: [], exhibitions: [], requestCases: [], changeLog: [], manualChangeNote: ''});
  publish(ctx, sample(ctx));
  assert.equal(ctx.readContentState_().activityArticles[0].title, 'Article');
  sheets._PublishedState.values[1][3] = '{broken';
  assert.throws(() => ctx.readContentState_(), /JSON/);
});

test('the change log keeps no e-mail addresses and drops the old columns', () => {
  const {ctx, sheets} = setup();
  sheets.ChangeLog = new Sheet([['timestamp', 'summary', 'actor_name', 'actor_email_input', 'revision'],
    ['2026-04-28T16:59:08.244Z', '前の更新', 'A', 'a@example.com', '1.0']]);
  ctx.appendChangeLog_('B', '展示会「x」を公開');
  assert.deepEqual(sheets.ChangeLog.values.map(row => row.slice(0, 3)), [['timestamp', 'summary', 'actor_name'],
    ['2026-04-28T16:59:08.244Z', '前の更新', 'A'], ['2026-09-24T00:00:00.000Z', '展示会「x」を公開', 'B']]);
  assert.ok(!JSON.stringify(sheets.ChangeLog.values).includes('@'));
  assert.equal(ctx.readContentState_().changeLog.length, 2);
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
  assert.equal(ctx.stableStringify_(ctx.readDrafts_()[0].payload), ctx.stableStringify_(ctx.buildDraftPayload_(large)));
  ctx.writePublishedState_(ctx.stableStringify_(ctx.buildPublicSnapshot_(large)), 'next');
  assert.equal(ctx.readContentState_().exhibitions.length, 1);
});

test('exhibition end dates are saved in their own column and read back; bad values are dropped', () => {
  const {ctx} = setup();
  const state = sample(ctx);
  state.exhibitions[0].endDate = '2026-11-18';
  publish(ctx, state);
  assert.equal(ctx.readContentState_().exhibitions[0].endDate, '2026-11-18');
  const normalized = ctx.normalizePayload_({exhibitions: [{title: 'x', displayBucket: 'archive', endDate: '11/18'}]}, {}, {allowIncomplete: true});
  assert.equal(normalized.exhibitions[0].endDate, '');
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

test('publish timings are written next to the admin log row, adding the column once', () => {
  const {ctx, sheets} = setup();
  sheets._AdminLog = new Sheet([['timestamp', 'actor_name', 'actor_email', 'action', 'detail'], ['t1', 'A', 'a@example.com', 'published', 'x']]);
  ctx.writeAdminLogCell_(2, 'timings', 'read 1.0s, drive 2.0s');
  sheets._AdminLog.values.push(['t2', 'B', 'b@example.com', 'published', 'y']);
  ctx.writeAdminLogCell_(3, 'timings', 'read 0.5s');
  assert.deepEqual(sheets._AdminLog.values.map(row => row[5]), ['timings', 'read 1.0s, drive 2.0s', 'read 0.5s']);
  assert.equal(ctx.readAdminLog_()[0].detail, 'y');
});

test('opening the CMS reads every sheet in one request with the same result, and falls back sheet by sheet', () => {
  const {ctx, sheets} = setup();
  const state = sample(ctx);
  state.exhibitions[0].endDate = '2026-11-18';
  publish(ctx, state);
  ctx.appendChangeLog_('A', '展示会「Exhibition」を公開');
  ctx.saveDraftRecord_(state, 'A', 'a@example.com');
  sheets._AdminLog = new Sheet([['timestamp', 'actor_name', 'actor_email', 'action', 'detail'], ['t1', 'A', 'a@example.com', 'published', 'x']]);
  const names = vm.runInContext('[CONTENT_SHEETS.publishedState, CONTENT_SHEETS.changeLog, CONTENT_SHEETS.drafts, CONTENT_SHEETS.adminLog]', ctx);
  const requests = [];
  let failing = false;
  ctx.console = {warn() {}};
  ctx.Sheets = {Spreadsheets: {Values: {batchGet: (id, options) => {
    requests.push(options);
    if (failing) throw new Error('Sheets API has not been used in project');
    assert.equal(options.valueRenderOption, 'UNFORMATTED_VALUE');
    const wanted = options.ranges.map(range => range.replace(/^'|'$/g, ''));
    // the API leaves out empty trailing cells
    const valueRanges = wanted.map(name => ({values: (sheets[name] ? sheets[name].values : [])
      .map(row => { const cells = row.slice(); while (cells.length && cells[cells.length - 1] === '') cells.pop(); return cells; })}));
    return {valueRanges};
  }}}};
  const plain = JSON.stringify([ctx.readContentState_(), ctx.readDrafts_(), ctx.readAdminLog_()]);
  const source = ctx.prefetchSheets_(names);
  assert.equal(requests.length, 1);
  assert.ok(source.prefetchedRows);
  assert.equal(JSON.stringify([ctx.readContentState_(source), ctx.readDrafts_(source), ctx.readAdminLog_(source)]), plain);
  failing = true;
  const fallback = ctx.prefetchSheets_(names);
  assert.ok(!fallback.prefetchedRows);
  assert.equal(JSON.stringify([ctx.readContentState_(fallback), ctx.readDrafts_(fallback), ctx.readAdminLog_(fallback)]), plain);
});

test('date cells read through the API become yyyy-MM-dd as with getValues', () => {
  const {ctx} = setup();
  assert.equal(ctx.normalizeFetchedCellValue_('2026/11/8'), '2026-11-08');
  assert.equal(ctx.normalizeFetchedCellValue_('2026/11/18 9:00:00'), '2026-11-18');
  assert.equal(ctx.normalizeFetchedCellValue_('2026-11-18'), '2026-11-18');
  assert.equal(ctx.normalizeFetchedCellValue_('2026-10-31T01:25:41.000Z'), '2026-10-31T01:25:41.000Z');
  assert.equal(ctx.normalizeFetchedCellValue_(undefined), '');
  assert.equal(ctx.normalizeFetchedCellValue_(true), true);
});

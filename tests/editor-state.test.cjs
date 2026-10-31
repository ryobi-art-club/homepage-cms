// 入力欄の内容は appState.state だけに持ち、保存・公開・プレビュー・誤字チェックはそこから作る
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const sources = require('./files.cjs');

const plain = (value) => JSON.parse(JSON.stringify(value));

function loadEditors(state) {
  const ctx = sources.loadClient({ document: { addEventListener() {}, querySelector: () => null } });
  const appState = vm.runInContext('appState', ctx);
  appState.state = state;
  ctx.refreshPreview = () => {};
  ctx.scheduleLogsPreviewRefresh = () => {};
  return { ctx, appState };
}

test('the payload trims text, keeps only the digits of a year and puts lists in their saved order', () => {
  const { ctx } = loadEditors({
    recruitCalendars: [{ year: '2025', published: false }, { year: '２０２６年 2027', mediaFileIds: ['a', 'a', ' b '] }],
    activityArticles: [{ articleId: 'a1', title: '  題  ', body: '\n本文\n', createdAt: '2026-10-01T00:00:00.000Z' }, { title: '新しい記事' }],
    exhibitions: [
      { exhibitionId: 'old', displayBucket: 'archive', startDate: '2025-05-01', title: '去年' },
      { exhibitionId: 'next', displayBucket: 'upcoming', startDate: '2026-11-14', endDate: '2026-11-18', title: ' 次 ', works: [{ fileId: 'w', title: ' 作品 ', artist: ' 作者 ', catalogKey: 'k' }] }
    ],
    requestCases: [{ caseId: 'r', title: ' 事例 ', body: '' }],
    manualChangeNote: '\nメモ\n'
  });
  const payload = plain(ctx.buildPayload());

  assert.deepEqual(payload.recruitCalendars.map((item) => item.year), ['2027', '2025']);
  assert.deepEqual(payload.recruitCalendars[0], { year: '2027', mediaFolderId: '', mediaFileIds: ['a', 'b'], published: true });

  assert.deepEqual(payload.activityArticles[0], {
    articleId: 'a1', title: '題', body: '本文', category: 'record', mediaFolderId: '', mediaFileIds: [], published: true, createdAt: '2026-10-01T00:00:00.000Z'
  });
  assert.match(payload.activityArticles[1].createdAt, /^\d{4}-\d{2}-\d{2}T/, 'a new article gets a creation time');

  assert.deepEqual(payload.exhibitions.map((item) => item.exhibitionId), ['next', 'old'], 'upcoming first');
  const next = payload.exhibitions[0];
  assert.equal(next.title, '次');
  assert.equal(next.dateLine, '2026年11月14日(土)〜11月18日(水)', 'an empty date line is made from the dates');
  assert.deepEqual(next.works, [{ fileId: 'w', title: '作品', artist: '作者', catalogKey: 'k' }]);
  assert.equal(payload.exhibitions[1].displayBucket, 'archive');

  assert.deepEqual(payload.requestCases[0], { caseId: 'r', title: '事例', body: '', mediaFolderId: '', mediaFileIds: [], published: true });
  assert.equal(payload.manualChangeNote, 'メモ');
});

test('a hand-written date line is kept until it is cleared', () => {
  const { ctx } = loadEditors({ exhibitions: [{ startDate: '2026-11-14', dateLine: '11月14日〜（会期は延長予定）' }] });
  assert.equal(ctx.buildPayload().exhibitions[0].dateLine, '11月14日〜（会期は延長予定）');
  ctx.setEditorField('exhibition', 0, 'dateLine', '');
  assert.equal(ctx.buildPayload().exhibitions[0].dateLine, '2026年11月14日(土)');
});

test('typing goes into the state as typed, and reaches the payload trimmed', () => {
  const { ctx, appState } = loadEditors({ activityArticles: [{ title: '前' }], manualChangeNote: '' });
  ctx.setEditorField('activity', 0, 'title', '  後の題 ');
  ctx.setEditorField('logs', 0, 'manualChangeNote', '更新しました\n');
  assert.equal(appState.state.activityArticles[0].title, '  後の題 ');
  assert.equal(ctx.buildPayload().activityArticles[0].title, '後の題');
  assert.equal(ctx.buildPayload().manualChangeNote, '更新しました');
});

test('adding, hiding, moving and deleting items mark the content as not saved', () => {
  const { ctx, appState } = loadEditors({ activityArticles: [{ title: '記事' }], requestCases: [{ title: '1' }, { title: '2' }] });
  ctx.renderActivitiesEditor = () => {};
  ctx.renderRequestsEditor = () => {};
  ctx.confirm = () => true;
  const steps = [
    () => ctx.toggleItemPublished('activity', 0),
    () => ctx.addActivityArticle(),
    () => ctx.moveRequestCase(0, 1),
    () => ctx.removeItem('request', 0)
  ];
  steps.forEach((step) => {
    appState.dirty = false;
    step();
    assert.equal(appState.dirty, true);
  });
  assert.equal(appState.state.activityArticles[1].published, false);
  assert.deepEqual(Array.from(appState.state.requestCases, (item) => item.title), ['1']);
});

test('proofreading reads the published texts from the state and writes corrections back to it', () => {
  const { ctx, appState } = loadEditors({
    exhibitions: [{ title: '展示', theme: '概要' }],
    activityArticles: [{ title: '非公開の記事', body: '本文', published: false }, { title: '記事', body: '' }],
    requestCases: [],
    manualChangeNote: 'メモ'
  });
  const fields = ctx.collectProofreadFields();
  assert.deepEqual(Array.from(fields, (field) => field.id), ['exhibition:0:title', 'exhibition:0:theme', 'activity:1:title', 'manualChangeNote']);
  assert.equal(fields[2].label, '活動記録・告知「記事」 › 記事タイトル');
  fields[2].setText('直した記事');
  fields[3].setText('直したメモ');
  assert.equal(appState.state.activityArticles[1].title, '直した記事');
  assert.equal(appState.state.manualChangeNote, '直したメモ');
});

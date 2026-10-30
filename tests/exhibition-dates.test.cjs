const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const sources = require('./files.cjs');

function loadClient() {
  return sources.loadClient();
}

test('the period text is built from the start and end dates', () => {
  const ctx = loadClient();
  assert.equal(ctx.formatExhibitionDateLine('2026-11-14', '2026-11-18'), '2026年11月14日(土)〜11月18日(水)');
  assert.equal(ctx.formatExhibitionDateLine('2026-12-28', '2027-01-05'), '2026年12月28日(月)〜2027年1月5日(火)');
  assert.equal(ctx.formatExhibitionDateLine('2026-05-10', ''), '2026年5月10日(日)');
  assert.equal(ctx.formatExhibitionDateLine('2026-05-10', '2026-05-10'), '2026年5月10日(日)');
  assert.equal(ctx.formatExhibitionDateLine('', '2026-05-10'), '');
});

test('an end date before the start date stops publishing with a message', () => {
  const ctx = loadClient();
  const messages = [];
  vm.runInContext('setStatus = (message) => statusMessages.push(message);', Object.assign(ctx, { statusMessages: messages }));
  const payload = { exhibitions: [{ title: '秋季展', startDate: '2026-11-14', endDate: '2026-11-01' }] };
  assert.equal(ctx.validatePayloadForSubmit(payload), false);
  assert.match(messages[0], /展示会「秋季展」：終了日（開始日より前の日付になっています）/);
  payload.exhibitions[0].endDate = '2026-11-18';
  assert.equal(ctx.validatePayloadForSubmit(payload), true);
});

test('the map link uses the official Google Maps search URL', () => {
  const ctx = loadClient();
  assert.equal(ctx.googleMapsSearchUrl('市民ギャラリー 東京都千代田区'),
    'https:' + '//www.google.com/maps/search/?api=1&query=' + encodeURIComponent('市民ギャラリー 東京都千代田区'));
});

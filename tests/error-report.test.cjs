const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const sources = require('./files.cjs');

function loadClient() {
  return sources.loadClient();
}

function loadServer({ recipient = 'admin@example.com', quota = 100 } = {}) {
  const store = new Map();
  const mails = [];
  const ctx = vm.createContext({
    console: { error() {} },
    CacheService: {
      getScriptCache: () => ({
        get: key => (store.has(key) ? store.get(key) : null),
        put: (key, value) => store.set(key, value),
        remove: key => store.delete(key)
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: key => (key === 'ERROR_NOTIFY_EMAIL' ? recipient : null) })
    },
    MailApp: {
      sendEmail: mail => mails.push(mail),
      getRemainingDailyQuota: () => quota
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (_, value) => Array.from(crypto.createHash('sha256').update(value, 'utf8').digest(), b => (b > 127 ? b - 256 : b))
    }
  });
  sources.loadServer(ctx);
  store.set('session:token', JSON.stringify({ email: 'member@example.com', name: '部員' }));
  return { ctx, mails };
}

const report = (message, operation = '公開') => ({ id: 'E-TEST', time: '2026/10/28 12:00:00', operation, message, panel: '展示会', userAgent: 'test' });

test('system-side errors are important and explain what to do next', () => {
  const ctx = loadClient();
  const github = ctx.describeError(new Error('GitHub Actions の起動に失敗しました: 500'), '公開');
  assert.equal(github.important, true);
  assert.match(github.hint, /保存済み/);
  const quota = ctx.describeError(new Error('Exception: Service invoked too many times for one day: email.'), '確認コードの送信');
  assert.equal(quota.message, 'Service invoked too many times for one day: email.');
  assert.equal(quota.important, true);
  const unexpected = ctx.describeError(new TypeError("Cannot read properties of undefined (reading 'id')"), '公開');
  assert.equal(unexpected.important, true);
  assert.ok(unexpected.hint);
  const excel = ctx.describeError(new Error('Excel 読み込み用ライブラリを取得できませんでした。'), '目録の読み込み');
  assert.equal(excel.important, true);
  assert.match(excel.hint, /CSV/);
});

test('user-side errors are not sent to the administrator', () => {
  const ctx = loadClient();
  for (const message of ['セッションが切れています。もう一度認証してください。', 'アップロードするファイルを選択してください。',
    'Lock timeout: another process was holding the lock for too long.', 'NetworkError: Connection failure due to HTTP 0']) {
    assert.equal(ctx.describeError(new Error(message), '公開').important, false, message);
  }
  assert.equal(ctx.describeError(new Error('アップロードするファイルを選択してください。'), '画像のアップロード').hint, '');
});

test('a lock timeout in Japanese also explains that another save or publish was running', () => {
  const ctx = loadClient();
  const report = ctx.describeError(new Error('ロックのタイムアウト: 別のプロセスがロックを保持している時間が長すぎました。'), '公開');
  assert.equal(report.important, false);
  assert.match(report.hint, /直前に押した操作/);
});

test('copied report names the operation and never contains the session token', () => {
  const ctx = loadClient();
  vm.runInContext("appState.sessionToken = 'secret-session-token';", ctx);
  const item = ctx.describeError(new Error('ファイル取得に失敗しました: timeout'), '画像の削除', new Date(2026, 9, 28, 9, 5, 7));
  assert.match(item.text, /^【凌美会 管理画面 エラー報告】/);
  assert.match(item.text, /操作: 画像の削除/);
  assert.match(item.text, /日時: 2026\/10\/28 09:05:07/);
  assert.match(item.text, new RegExp('エラーID: ' + item.id));
  assert.ok(!item.text.includes('secret-session-token'));
});

test('reportError does nothing until ERROR_NOTIFY_EMAIL is set', () => {
  const { ctx, mails } = loadServer({ recipient: '' });
  assert.deepEqual({ ...ctx.reportError('token', report('GitHub Actions の起動に失敗しました')) }, { notified: false, reason: 'not_configured' });
  assert.equal(mails.length, 0);
});

test('reportError mails the administrator once per error and names the reporter', () => {
  const { ctx, mails } = loadServer();
  assert.equal(ctx.reportError('token', report('GitHub Actions の起動に失敗しました')).notified, true);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'admin@example.com');
  assert.match(mails[0].subject, /公開/);
  assert.match(mails[0].body, /部員 <member@example\.com>/);
  assert.ok(!mails[0].body.includes('token'));
  const again = ctx.reportError('token', report('GitHub Actions の起動に失敗しました'));
  assert.equal(again.duplicate, true);
  assert.equal(mails.length, 1);
});

test('reportError stops at the hourly limit and keeps quota for login codes', () => {
  const { ctx, mails } = loadServer();
  for (let i = 0; i < 5; i += 1) ctx.reportError('token', report('エラー' + i));
  assert.equal(ctx.reportError('token', report('エラー6')).reason, 'limit');
  assert.equal(mails.length, 5);

  const low = loadServer({ quota: 20 });
  assert.equal(low.ctx.reportError('token', report('GitHub Actions の起動に失敗しました')).reason, 'limit');
  assert.equal(low.mails.length, 0);
});

test('reportError requires a valid session', () => {
  const { ctx, mails } = loadServer();
  assert.throws(() => ctx.reportError('unknown', report('x')), /セッション/);
  assert.equal(mails.length, 0);
});

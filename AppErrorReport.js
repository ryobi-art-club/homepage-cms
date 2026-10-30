// 画面で起きたシステム側のエラーを、管理者にメールで知らせる

const ERROR_MAIL_HOURLY_LIMIT = 5;

const ERROR_MAIL_DUPLICATE_SECONDS = 6 * 60 * 60;

const ERROR_MAIL_QUOTA_RESERVE = 20;

// 画面で起きたシステム側のエラーを ERROR_NOTIFY_EMAIL（カンマ区切り）にメールする。未設定なら何もしない。
// getConfig_ 自体が失敗している場合も送れるように、スクリプト プロパティを直接読む
function reportError(sessionToken, report) {
  const session = requireSession_(sessionToken);
  const item = normalizeErrorReport_(report);
  console.error('Client error report', JSON.stringify(Object.assign({ reporter: session.email }, item)));

  const recipient = String(PropertiesService.getScriptProperties().getProperty('ERROR_NOTIFY_EMAIL') || '').trim();
  if (!recipient) return { notified: false, reason: 'not_configured' };

  const cache = CacheService.getScriptCache();
  const duplicateKey = 'error_mail:' + sha256Hex_(item.operation + '\n' + item.message).slice(0, 40);
  if (cache.get(duplicateKey)) return { notified: true, duplicate: true };

  // 1日のメールの上限は確認コードと共有なので、確認コードの分を残しておく
  const hourKey = 'error_mail_count:' + Math.floor(Date.now() / 3600000);
  const sent = parseInt(cache.get(hourKey) || '0', 10);
  if (sent >= ERROR_MAIL_HOURLY_LIMIT || MailApp.getRemainingDailyQuota() <= ERROR_MAIL_QUOTA_RESERVE) {
    return { notified: false, reason: 'limit' };
  }

  MailApp.sendEmail({
    to: recipient,
    subject: '【凌美会 管理画面】エラー: ' + item.operation + '（' + item.id + '）',
    body: buildErrorMailBody_(item, session)
  });
  cache.put(duplicateKey, '1', ERROR_MAIL_DUPLICATE_SECONDS);
  cache.put(hourKey, String(sent + 1), 3600);
  return { notified: true };
}

function normalizeErrorReport_(report) {
  const source = report && typeof report === 'object' ? report : {};
  const field = (value, limit, singleLine) => {
    const text = String(value == null ? '' : value).trim();
    return (singleLine ? text.replace(/\s+/g, ' ') : text).slice(0, limit);
  };
  return {
    id: field(source.id, 40, true) || '-',
    time: field(source.time, 40, true),
    operation: field(source.operation, 60, true) || '操作',
    message: field(source.message, 2000, false) || '不明なエラー',
    panel: field(source.panel, 60, true),
    userAgent: field(source.userAgent, 300, true)
  };
}

function buildErrorMailBody_(item, session) {
  return [
    '凌美会 管理画面でエラーが発生しました。',
    '',
    'エラーID: ' + item.id,
    '日時: ' + item.time,
    '操作: ' + item.operation,
    '内容: ' + item.message,
    '画面: ' + (item.panel || '-'),
    '報告者: ' + (session.name || '-') + ' <' + session.email + '>',
    'ブラウザ: ' + (item.userAgent || '-'),
    '',
    '同じ操作・同じ内容のエラーは6時間に1回だけ通知します。',
    'Apps Script エディタの「実行数」にも同じ内容が記録されています。'
  ].join('\n');
}

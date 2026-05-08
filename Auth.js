function requestOtp(email) {
  const config = getConfig_();
  const normalizedEmail = normalizeEmail_(email);
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error('メールアドレスの形式が正しくありません。');
  }
  const allowed = getAllowedUserByEmail_(normalizedEmail);
  if (!allowed) {
    throw new Error('このメールアドレスにはアクセス権がありません。');
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const record = {
    email: normalizedEmail,
    codeHash: sha256Hex_(code),
    expiresAt: Date.now() + config.OTP_TTL_MINUTES * 60 * 1000,
    attempts: 0
  };
  CacheService.getScriptCache().put('otp:' + normalizedEmail, JSON.stringify(record), config.OTP_TTL_MINUTES * 60);

  MailApp.sendEmail({
    to: normalizedEmail,
    subject: '【凌美会】確認コード',
    htmlBody: [
      '<p>凌美会の管理画面にログインするための確認コードです。</p>',
      '<p style="font-size:28px; font-weight:700; letter-spacing:0.2em;">' + code + '</p>',
      '<p>このコードの有効期限は ' + config.OTP_TTL_MINUTES + ' 分です。</p>'
    ].join('')
  });

  return {
    ok: true,
    email: maskEmail_(normalizedEmail),
    expiresInMinutes: config.OTP_TTL_MINUTES
  };
}

function verifyOtp(email, code) {
  const config = getConfig_();
  const normalizedEmail = normalizeEmail_(email);
  const cache = CacheService.getScriptCache();
  const raw = cache.get('otp:' + normalizedEmail);
  if (!raw) {
    throw new Error('確認コードの有効期限が切れています。もう一度取得してください。');
  }
  const record = JSON.parse(raw);
  if (Date.now() > record.expiresAt) {
    cache.remove('otp:' + normalizedEmail);
    throw new Error('確認コードの有効期限が切れています。');
  }
  if (record.attempts >= 5) {
    cache.remove('otp:' + normalizedEmail);
    throw new Error('確認コードの入力回数が上限に達しました。');
  }
  if (sha256Hex_(String(code || '').trim()) !== record.codeHash) {
    record.attempts += 1;
    cache.put('otp:' + normalizedEmail, JSON.stringify(record), Math.max(60, Math.floor((record.expiresAt - Date.now()) / 1000)));
    throw new Error('確認コードが一致しません。');
  }

  cache.remove('otp:' + normalizedEmail);
  const allowed = getAllowedUserByEmail_(normalizedEmail);
  const sessionToken = Utilities.getUuid() + '-' + Utilities.getUuid();
  cache.put('session:' + sessionToken, JSON.stringify({
    email: normalizedEmail,
    name: allowed && allowed.name ? allowed.name : normalizedEmail,
    issuedAt: Date.now()
  }), config.SESSION_TTL_MINUTES * 60);

  return {
    ok: true,
    sessionToken: sessionToken,
    email: normalizedEmail,
    name: allowed && allowed.name ? allowed.name : normalizedEmail,
    expiresInMinutes: config.SESSION_TTL_MINUTES
  };
}

function requireSession_(sessionToken) {
  const raw = CacheService.getScriptCache().get('session:' + String(sessionToken || '').trim());
  if (!raw) {
    throw new Error('セッションが切れています。もう一度認証してください。');
  }
  return JSON.parse(raw);
}


function getAllowedUserByEmail_(email) {
  const config = getConfig_();
  const sheet = SpreadsheetApp.openById(config.ALLOWLIST_SPREADSHEET_ID).getSheetByName(ALLOWLIST_SHEET_NAME);
  if (!sheet) throw new Error('allowlist シートが見つかりません。');
  const values = sheet.getDataRange().getValues();
  if (!values.length) return null;
  const header = values[0].map((v) => String(v || '').trim());
  const nameIndex = header.indexOf('name');
  const emailIndex = header.indexOf('email');
  if (emailIndex < 0) throw new Error('allowlist シートの1行目に email 列が必要です。');
  for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    const rowEmail = normalizeEmail_(values[rowIndex][emailIndex]);
    if (rowEmail && rowEmail === email) {
      return {
        name: nameIndex >= 0 ? String(values[rowIndex][nameIndex] || '').trim() : '',
        email: rowEmail
      };
    }
  }
  return null;
}

function isAllowedEmail_(email) {
  return !!getAllowedUserByEmail_(email);
}


function maskEmail_(email) {
  const parts = String(email).split('@');
  if (parts.length !== 2) return email;
  const user = parts[0];
  const maskedUser = user.length <= 2 ? user[0] + '*' : user.slice(0, 2) + '*'.repeat(Math.max(1, user.length - 2));
  return maskedUser + '@' + parts[1];
}

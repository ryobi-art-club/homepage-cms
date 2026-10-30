// 分類をまたいで使う道具：日時・ハッシュ・JSON・入力の文字・比べるための文字列

function isoNow_() {
  return new Date().toISOString();
}

function sha256Hex_(value) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  return raw.map((b) => {
    const v = (b + 256) % 256;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

function parseJson_(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function requireString_(value, label, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(label + ' を入力してください。');
  if (maxLength && normalized.length > maxLength) throw new Error(label + ' が長すぎます。');
  return normalized;
}

function cleanMultiline_(value, maxLength) {
  const normalized = String(value || '').replace(/\r/g, '').trim();
  if (maxLength && normalized.length > maxLength) {
    throw new Error('入力が長すぎます。');
  }
  return normalized;
}

function normalizeStringList_(value) {
  if (typeof value === 'string') value = parseJson_(value, []);
  if (!Array.isArray(value)) return [];
  const out = [];
  value.forEach((item) => {
    const text = String(item || '').trim();
    if (text && out.indexOf(text) === -1) out.push(text);
  });
  return out;
}

function stableStringify_(value) {
  return JSON.stringify(sortDeep_(value));
}

function sortDeep_(value) {
  if (Array.isArray(value)) return value.map(sortDeep_);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach((key) => out[key] = sortDeep_(value[key]));
    return out;
  }
  return value;
}

const PROOFREAD_BATCH_CHARS = 6000;
const PROOFREAD_TIME_BUDGET_MS = 120 * 1000;
const PROOFREAD_MAX_FIELDS = 1000;
const PROOFREAD_MAX_ISSUES_PER_FIELD = 20;

// 公開前の誤字脱字チェック。チェック済みの文章は SHA-256 を _ProofreadChecked に記録してあり、
// 記録にない（＝新規・変更された）文章だけを Gemini に送る。ここでは記録を追加しない。
// 記録の追加は公開成功後の markProofreadChecked だけで行う。
function proofreadForPublish(sessionToken, fields) {
  requireSession_(sessionToken);
  const targets = normalizeProofreadFields_(fields);
  const currentHashes = {};
  targets.forEach((field) => { currentHashes[field.hash] = true; });
  // 公開対象から外れた文章の記録を削除する。
  updateProofreadChecked_([], currentHashes);
  const checked = readProofreadCheckedHashes_();
  const pending = targets.filter((field) => !checked[field.hash]);
  const result = { issues: [], cleanFieldIds: [], pendingCount: pending.length, remainingCount: 0, error: '' };
  if (!pending.length) return result;

  const config = getConfig_();
  if (!config.GEMINI_API_KEY) {
    result.error = 'Gemini API キーが未設定です。';
    result.remainingCount = pending.length;
    return result;
  }

  const model = normalizeGeminiModelName_(config.GEMINI_MODEL);
  const startedAt = Date.now();
  const batches = buildProofreadBatches_(pending, PROOFREAD_BATCH_CHARS);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    if (Date.now() - startedAt > PROOFREAD_TIME_BUDGET_MS) {
      result.remainingCount = countProofreadFields_(batches.slice(i));
      break;
    }
    try {
      const issues = proofreadBatchWithRetry_(config.GEMINI_API_KEY, model, batch);
      batch.forEach((field) => {
        const own = issues.filter((issue) => issue.fieldId === field.id);
        if (own.length) {
          own.forEach((issue) => result.issues.push(Object.assign({ label: field.label }, issue)));
        } else {
          result.cleanFieldIds.push(field.id);
        }
      });
    } catch (error) {
      result.error = error && error.message ? error.message : String(error);
      result.remainingCount = countProofreadFields_(batches.slice(i));
      break;
    }
  }
  return result;
}

// 公開成功後に、指摘のなかった文章と、利用者が「問題ない」とした文章をチェック済みとして記録する。
function markProofreadChecked(sessionToken, texts) {
  requireSession_(sessionToken);
  const hashes = (Array.isArray(texts) ? texts : [])
    .slice(0, PROOFREAD_MAX_FIELDS)
    .map(normalizeProofreadText_)
    .filter(Boolean)
    .map(sha256Hex_);
  updateProofreadChecked_(hashes, null);
  return { ok: true };
}

function normalizeProofreadText_(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

function normalizeProofreadFields_(fields) {
  const source = Array.isArray(fields) ? fields : [];
  if (source.length > PROOFREAD_MAX_FIELDS) throw new Error('誤字チェックの対象が多すぎます。');
  const seen = {};
  return source.map((field) => {
    const id = String(field && field.id || '').trim().slice(0, 100);
    const text = normalizeProofreadText_(field && field.text);
    if (!id || !text || seen[id] || text.length > 50000) return null;
    seen[id] = true;
    return {
      id: id,
      label: String(field.label || '').trim().slice(0, 200),
      text: text,
      hash: sha256Hex_(text)
    };
  }).filter(Boolean);
}

function buildProofreadBatches_(fields, maxChars) {
  const batches = [];
  let current = [];
  let size = 0;
  fields.forEach((field) => {
    if (current.length && size + field.text.length > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(field);
    size += field.text.length;
  });
  if (current.length) batches.push(current);
  return batches;
}

function countProofreadFields_(batches) {
  return batches.reduce((sum, batch) => sum + batch.length, 0);
}

function proofreadBatchWithRetry_(apiKey, model, batch) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const responseText = callGeminiProofreader_(apiKey, model, batch, attempt);
      const parsed = parseGeminiCatalogJson_(responseText);
      return normalizeProofreadIssues_(parsed && parsed.issues ? parsed.issues : parsed, batch);
    } catch (error) {
      lastError = error;
      Logger.log('Gemini proofread attempt ' + attempt + ' failed: ' + (error && error.message ? error.message : String(error)));
      if (!isRetryableGeminiError_(error) || attempt >= 2) break;
      Utilities.sleep(700 * attempt);
    }
  }
  throw lastError || new Error('誤字チェックに失敗しました。');
}

function callGeminiProofreader_(apiKey, model, batch, attempt) {
  const schema = {
    type: 'object',
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            original: { type: 'string' },
            suggestion: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['id', 'original', 'suggestion', 'reason']
        }
      }
    },
    required: ['issues']
  };
  const prompt = [
    'あなたは日本語ウェブサイトの校正担当です。入力JSONの各 text について、誤字・脱字・衍字・変換ミス（同音異義語の誤り）・明らかな文法の誤りだけを指摘してください。',
    '文体、言い回し、表記ゆれ、句読点や改行の好み、敬語の言い換えは指摘しないでください。',
    '人名、作品名、展示会名、会場名などの固有名詞は、明らかな誤変換でない限り指摘しないでください。',
    'id には対象の id をそのまま入れてください。',
    'original には誤りを含む部分を text から一字一句変えずに抜き出してください。読み手が本文中で見つけやすいよう、前後の数文字を含めてください。',
    'suggestion には original を置き換える修正後の文字列を入れてください。',
    'reason には「脱字」「誤字」「変換ミス」などの短い理由を書いてください。',
    '誤りがなければ issues は空配列にしてください。',
    '',
    '入力:',
    JSON.stringify(batch.map((field) => ({ id: field.id, text: field.text })))
  ].join('\n');
  const payload = {
    model: model,
    input: [{ type: 'text', text: prompt }],
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: schema
    }
  };
  return postGeminiInteraction_(apiKey, payload, attempt);
}

function normalizeProofreadIssues_(value, batch) {
  const source = Array.isArray(value) ? value : [];
  const textById = {};
  batch.forEach((field) => { textById[field.id] = field.text; });
  const counts = {};
  const seen = {};
  const issues = [];
  source.forEach((issue) => {
    if (!issue || typeof issue !== 'object') return;
    const fieldId = String(issue.id || '').trim();
    const original = String(issue.original || '');
    const suggestion = String(issue.suggestion || '');
    const text = textById[fieldId];
    // 本文に見つからない指摘は読み手が探せないので捨てる。
    if (text === undefined || !original || original === suggestion || text.indexOf(original) === -1) return;
    const key = fieldId + '\u0000' + original;
    if (seen[key]) return;
    if ((counts[fieldId] || 0) >= PROOFREAD_MAX_ISSUES_PER_FIELD) return;
    seen[key] = true;
    counts[fieldId] = (counts[fieldId] || 0) + 1;
    issues.push({
      fieldId: fieldId,
      original: original,
      suggestion: suggestion,
      reason: String(issue.reason || '').trim().slice(0, 40)
    });
  });
  return issues;
}

function readProofreadCheckedHashes_() {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const map = {};
  readSheetObjects_(spreadsheet, CONTENT_SHEETS.proofreadChecked).forEach((row) => {
    const hash = String(row.sha256 || '').trim();
    if (hash) map[hash] = String(row.checked_at || '');
  });
  return map;
}

// addHashes を追記する。keepHashes を渡した場合は、それに含まれない古い記録を削除する。
function updateProofreadChecked_(addHashes, keepHashes) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const existing = readProofreadCheckedHashes_();
    const next = {};
    let changed = false;
    Object.keys(existing).forEach((hash) => {
      if (keepHashes && !keepHashes[hash]) {
        changed = true;
        return;
      }
      next[hash] = existing[hash];
    });
    const now = isoNow_();
    (addHashes || []).forEach((hash) => {
      if (next[hash]) return;
      next[hash] = now;
      changed = true;
    });
    if (!changed) return;
    const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
    writeSheet_(spreadsheet, CONTENT_SHEETS.proofreadChecked, [['sha256', 'checked_at']].concat(
      Object.keys(next).map((hash) => [hash, next[hash]])
    ));
  } finally {
    lock.releaseLock();
  }
}

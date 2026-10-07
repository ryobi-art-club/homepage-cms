function extractExhibitionCatalog(sessionToken, request) {
  requireSession_(sessionToken);
  if (!request || typeof request !== 'object') throw new Error('目録PDFの情報が不正です。');

  const config = getConfig_();
  if (!config.GEMINI_API_KEY) {
    throw new Error('Gemini API キーが未設定です。Script Properties に GEMINI_API_KEY を追加してください。');
  }

  const name = requireString_(request.name, 'ファイル名', 180);
  const mimeType = String(request.mimeType || '').trim() || 'application/pdf';
  if (mimeType !== 'application/pdf' && !/\.pdf$/i.test(name)) {
    throw new Error('目録PDFを選択してください。');
  }

  const data = String(request.data || '').trim();
  if (!data) throw new Error('目録PDFのデータが空です。');
  if (data.length > 12 * 1024 * 1024) {
    throw new Error('目録PDFが大きすぎます。10MB以下のPDFで試してください。');
  }

  const model = normalizeGeminiModelName_(config.GEMINI_MODEL);
  const extraction = extractCatalogWithRetry_(config.GEMINI_API_KEY, model, data);

  return {
    model: model,
    sourceName: name,
    items: extraction.items,
    warnings: extraction.warnings
  };
}

function extractCatalogWithRetry_(apiKey, model, pdfBase64) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const responseText = callGeminiCatalogExtractor_(apiKey, model, pdfBase64, attempt);
      Logger.log('Gemini outputText attempt ' + attempt + ': ' + responseText.slice(0, 5000));
      const parsed = parseGeminiCatalogJson_(responseText);
      const items = normalizeCatalogItems_(parsed && parsed.items ? parsed.items : parsed);
      if (!items.length) throw new Error('目録から作品情報を抽出できませんでした。');
      return {
        items: items,
        warnings: normalizeStringList_(parsed && parsed.warnings ? parsed.warnings : [])
      };
    } catch (error) {
      lastError = error;
      Logger.log('Gemini extract attempt ' + attempt + ' failed: ' + (error && error.message ? error.message : String(error)));
      if (!isRetryableGeminiError_(error) || attempt >= 2) break;
      Utilities.sleep(700 * attempt);
    }
  }
  throw new Error('目録から作品情報を抽出できませんでした。PDFの内容を確認してください。' + (lastError && lastError.message ? ' 詳細: ' + lastError.message : ''));
}

function callGeminiCatalogExtractor_(apiKey, model, pdfBase64, attempt) {
  const schema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sort_order: { type: 'integer' },
            artist: { type: 'string' },
            title: { type: 'string' },
            size: { type: 'string' },
            materials: { type: 'string' }
          },
          required: ['sort_order', 'artist', 'title']
        }
      },
      warnings: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['items']
  };
  const prompt = [
    '展示会の作品目録PDFから作品情報を抽出してください。',
    '作品番号、作家名、作品名を必ず取得してください。',
    'サイズと画材が読み取れる場合は取得してください。',
    '作品名や作家名が改行されている場合は自然な1行に結合してください。',
    '表紙、会場案内、展示会タイトル、日時、会場名は作品として扱わないでください。',
    'PDF内の作品番号順に sort_order を設定してください。',
    '推測で補完せず、読めない項目は空文字にしてください。'
  ].join('\n');
  const payload = {
    model: model,
    input: [
      { type: 'document', data: pdfBase64, mime_type: 'application/pdf' },
      { type: 'text', text: prompt }
    ],
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: schema
    }
  };

  return postGeminiInteraction_(apiKey, payload, attempt);
}

function postGeminiInteraction_(apiKey, payload, attempt) {
  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/interactions';
  const response = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  Logger.log('Gemini status attempt ' + attempt + ': ' + status);
  Logger.log('Gemini body attempt ' + attempt + ': ' + body.slice(0, 5000));
  if (status < 200 || status >= 300) {
    const error = new Error('Gemini API の呼び出しに失敗しました。HTTP ' + status + ': ' + summarizeApiError_(body));
    error.status = status;
    throw error;
  }
  return extractGeminiOutputText_(parseJson_(body, {}));
}

function isRetryableGeminiError_(error) {
  if (!error) return false;
  const status = Number(error.status || 0);
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  const message = String(error.message || error);
  return /JSON|応答が空|抽出できません|解釈できません/.test(message);
}

function normalizeGeminiModelName_(model) {
  return String(model || 'gemini-3.1-flash-lite').replace(/^models\//, '').trim() || 'gemini-3.1-flash-lite';
}

function extractGeminiOutputText_(response) {
  if (!response || typeof response !== 'object') return '';
  if (response.output_text) return String(response.output_text);
  if (response.outputText) return String(response.outputText);
  if (typeof response.text === 'string') return response.text;
  if (Array.isArray(response.output)) {
    const chunks = [];
    response.output.forEach((item) => collectGeminiText_(item, chunks));
    if (chunks.length) return chunks.join('\n');
  }
  if (Array.isArray(response.candidates)) {
    const chunks = [];
    response.candidates.forEach((item) => collectGeminiText_(item, chunks));
    if (chunks.length) return chunks.join('\n');
  }
  if (Array.isArray(response.steps)) {
    const chunks = [];
    response.steps.forEach((item) => collectGeminiText_(item, chunks));
    if (chunks.length) return chunks.join('\n');
  }
  return JSON.stringify(response);
}

function collectGeminiText_(value, chunks) {
  if (value === undefined || value === null) return;
  if (typeof value === 'string') {
    chunks.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectGeminiText_(item, chunks));
    return;
  }
  if (typeof value !== 'object') return;
  if (typeof value.text === 'string') chunks.push(value.text);
  if (typeof value.output_text === 'string') chunks.push(value.output_text);
  if (typeof value.outputText === 'string') chunks.push(value.outputText);
  if (value.content) collectGeminiText_(value.content, chunks);
  if (value.parts) collectGeminiText_(value.parts, chunks);
}

function parseGeminiCatalogJson_(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Gemini API の応答が空です。');
  const direct = parseJson_(raw, null);
  if (direct) return direct;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsedFence = parseJson_(fenced[1].trim(), null);
    if (parsedFence) return parsedFence;
  }

  const startObject = raw.indexOf('{');
  const endObject = raw.lastIndexOf('}');
  if (startObject >= 0 && endObject > startObject) {
    const parsedObject = parseJson_(raw.slice(startObject, endObject + 1), null);
    if (parsedObject) return parsedObject;
  }

  const startArray = raw.indexOf('[');
  const endArray = raw.lastIndexOf(']');
  if (startArray >= 0 && endArray > startArray) {
    const parsedArray = parseJson_(raw.slice(startArray, endArray + 1), null);
    if (parsedArray) return parsedArray;
  }

  throw new Error('Gemini API の応答をJSONとして解釈できませんでした。');
}

function normalizeCatalogItems_(value) {
  const source = Array.isArray(value) ? value : [];
  return source.map((item, index) => ({
    sortOrder: Number(item.sort_order || item.sortOrder || index + 1) || index + 1,
    artist: String(item.artist || item.artist_name || item.artistName || '').trim(),
    title: String(item.title || item.work_title || item.workTitle || '').trim(),
    size: String(item.size || '').trim(),
    materials: String(item.materials || item.medium || '').trim()
  })).filter((item) => item.artist || item.title).sort((a, b) => a.sortOrder - b.sortOrder).slice(0, 200);
}

function summarizeApiError_(body) {
  const parsed = parseJson_(body, null);
  if (parsed && parsed.error && parsed.error.message) return parsed.error.message;
  return String(body || '').slice(0, 300);
}

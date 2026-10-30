// Gemini の呼び出し（目録の読み取りと誤字チェックで共有する）

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

function summarizeApiError_(body) {
  const parsed = parseJson_(body, null);
  if (parsed && parsed.error && parsed.error.message) return parsed.error.message;
  return String(body || '').slice(0, 300);
}

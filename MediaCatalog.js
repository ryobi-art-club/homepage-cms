// 展示会の目録ファイル（PDF・画像・テキスト）から、作品の情報を読み取る

const CATALOG_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

const CATALOG_MAX_BINARY_BASE64 = 14 * 1024 * 1024;

const CATALOG_MAX_TEXT_LENGTH = 300000;

const CATALOG_MAX_PARTS = 20;

// 目録ファイル（PDF・画像・テキスト）から作品情報を抽出する。
// Excel はブラウザ側で CSV テキストに変換して text として送られてくる。
// request の形：{ name, parts: [{ kind: 'pdf' | 'image', mimeType, data（base64） } | { kind: 'text', name, text }] }
function extractExhibitionCatalog(sessionToken, request) {
  requireSession_(sessionToken);
  if (!request || typeof request !== 'object') throw new Error('目録ファイルの情報が不正です。');

  const config = getConfig_();
  if (!config.GEMINI_API_KEY) {
    throw new Error('Gemini API キーが未設定です。Script Properties に GEMINI_API_KEY を追加してください。');
  }

  const name = requireString_(request.name, 'ファイル名', 180);
  const inputParts = buildCatalogInputParts_(request);
  const model = normalizeGeminiModelName_(config.GEMINI_MODEL);
  const extraction = extractCatalogWithRetry_(config.GEMINI_API_KEY, model, inputParts);

  return {
    model: model,
    sourceName: name,
    items: extraction.items,
    warnings: extraction.warnings
  };
}

function buildCatalogInputParts_(request) {
  const parts = Array.isArray(request.parts) ? request.parts : [];
  if (!parts.length) throw new Error('目録ファイルを選択してください。');
  if (parts.length > CATALOG_MAX_PARTS) throw new Error('目録の画像は' + CATALOG_MAX_PARTS + '枚以下にしてください。');

  let binarySize = 0;
  let textSize = 0;
  const input = parts.map((part) => {
    const kind = String(part && part.kind || '');
    if (kind === 'text') {
      const text = String(part.text || '').replace(/\r/g, '').trim();
      if (!text) throw new Error('目録ファイルの内容が空です。');
      textSize += text.length;
      const label = String(part.name || '').trim().slice(0, 180);
      return { type: 'text', text: '目録ファイル' + (label ? '「' + label + '」' : '') + 'の内容:\n' + text };
    }
    const data = String(part && part.data || '').trim();
    if (!data) throw new Error('目録ファイルのデータが空です。');
    binarySize += data.length;
    if (kind === 'pdf') return { type: 'document', data: data, mime_type: 'application/pdf' };
    if (kind === 'image') {
      const mimeType = String(part.mimeType || '').trim().toLowerCase();
      if (CATALOG_IMAGE_MIME_TYPES.indexOf(mimeType) === -1) {
        throw new Error('対応していない画像形式です。JPEG・PNG・WebP・HEIC の画像を選択してください。');
      }
      return { type: 'image', data: data, mime_type: mimeType };
    }
    throw new Error('対応していない目録ファイルです。');
  });
  if (binarySize > CATALOG_MAX_BINARY_BASE64) throw new Error('目録ファイルが大きすぎます。合計10MB以下にしてください。');
  if (textSize > CATALOG_MAX_TEXT_LENGTH) throw new Error('目録ファイルの文字数が多すぎます。');
  return input;
}

function extractCatalogWithRetry_(apiKey, model, inputParts) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const responseText = callGeminiCatalogExtractor_(apiKey, model, inputParts, attempt);
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
  throw new Error('目録から作品情報を抽出できませんでした。ファイルの内容を確認してください。' + (lastError && lastError.message ? ' 詳細: ' + lastError.message : ''));
}

function callGeminiCatalogExtractor_(apiKey, model, inputParts, attempt) {
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
    '展示会の作品目録から作品情報を抽出してください。目録は PDF、画像、表（CSV）、テキストのいずれかです。',
    '複数の画像が渡された場合は、同じ目録の別ページとして扱ってください。',
    '表形式の場合は、列見出しから作品番号・作家名・作品名・サイズ・画材の列を判断してください。',
    '作品番号、作家名、作品名を必ず取得してください。',
    'サイズと画材が読み取れる場合は取得してください。',
    '作品名や作家名が改行されている場合は自然な1行に結合してください。',
    '表紙、会場案内、展示会タイトル、日時、会場名は作品として扱わないでください。',
    '目録内の作品番号順に sort_order を設定してください。作品番号がない場合は掲載順にしてください。',
    '推測で補完せず、読めない項目は空文字にしてください。'
  ].join('\n');
  const payload = {
    model: model,
    input: inputParts.concat([{ type: 'text', text: prompt }]),
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: schema
    }
  };

  return postGeminiInteraction_(apiKey, payload, attempt);
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

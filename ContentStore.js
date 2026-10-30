// スプレッドシートの読み書き：公開した内容・下書き・更新履歴・操作ログ

// 内容は _PublishedState の1か所にある（README「8-4」）。読めないときは readPayloadCells_ がエラーで止め、
// 空の内容を出さない（そのまま公開してサイトを空にしないため）
// spreadsheet は省略できる。prefetchSheets_ の結果も渡せる
function readContentState_(spreadsheet) {
  spreadsheet = spreadsheet || SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  return Object.assign(contentLists_(readPublishedState_(spreadsheet).payload), {
    changeLog: readChangeLog_(spreadsheet),
    manualChangeNote: ''
  });
}

function readPublishedState_(spreadsheet) {
  spreadsheet = spreadsheet || SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const rows = readSheetObjects_(spreadsheet, CONTENT_SHEETS.publishedState);
  const row = rows[0] || {};
  return {
    payload: buildPublicSnapshot_(requireContentFormat_(readPayloadCells_(row))),
    sha256: String(row.sha256 || ''),
    revision: Number(row.revision || 0)
  };
}

function writePublishedState_(payloadJson, sha256) {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const current = readPublishedState_();
  const cells = buildPayloadCells_(payloadJson);
  writeSheet_(spreadsheet, CONTENT_SHEETS.publishedState, [
    ['updated_at', 'revision', 'sha256'].concat(payloadCellHeaders_(cells.length)),
    [isoNow_(), String(current.revision + 1), sha256].concat(cells)
  ]);
}

function readChangeLog_(spreadsheet) {
  return readSheetObjects_(spreadsheet, CONTENT_SHEETS.changeLog)
    .map((row) => ({
      timestamp: row.timestamp,
      summary: row.summary,
      actorName: row.actor_name || ''
    }))
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

// サイトのビルドが読むシートなので、メールアドレスは置かない（_AdminLog にある）。
// シート全体を書き直すので、以前の版の列（actor_email_input・revision）もここで消える
function appendChangeLog_(actorName, summary) {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const rows = readSheetObjects_(spreadsheet, CONTENT_SHEETS.changeLog)
    .map((row) => [row.timestamp, row.summary, row.actor_name || '']);
  rows.push([isoNow_(), summary, actorName]);
  writeSheet_(spreadsheet, CONTENT_SHEETS.changeLog, [['timestamp', 'summary', 'actor_name']].concat(rows));
}

function syncChangeLogTitles_(beforeSnapshot, afterSnapshot) {
  const replacements = buildTitleReplacements_(beforeSnapshot || {}, afterSnapshot || {});
  if (!replacements.length) return;

  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(CONTENT_SHEETS.changeLog);
  if (!sheet || sheet.getLastRow() < 2) return;

  const values = sheet.getDataRange().getValues();
  const headers = values[0].map((header) => String(header || '').trim());
  const summaryIndex = headers.indexOf('summary');
  if (summaryIndex < 0) return;

  let changed = false;
  for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    let summary = String(values[rowIndex][summaryIndex] || '');
    const beforeSummary = summary;
    replacements.forEach((replacement) => {
      summary = applyTitleReplacement_(summary, replacement);
    });
    if (summary !== beforeSummary) {
      values[rowIndex][summaryIndex] = summary;
      changed = true;
    }
  }
  if (changed) {
    sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
  }
}

function saveDraftRecord_(state, actorName, actorEmail) {
  const cells = buildPayloadCells_(stableStringify_(buildDraftPayload_(state)));
  const header = ['draft_id', 'saved_at', 'saved_by_name', 'saved_by_email'].concat(payloadCellHeaders_(cells.length));
  const values = [Utilities.getUuid(), isoNow_(), actorName, actorEmail].concat(cells);
  validateSheetCellLengths_(CONTENT_SHEETS.drafts, [header, values]);
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(CONTENT_SHEETS.drafts) || spreadsheet.insertSheet(CONTENT_SHEETS.drafts);
  ensureSheetSize_(sheet, 2, header.length);
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  sheet.insertRowAfter(1);
  try {
    sheet.getRange(2, 1, 1, values.length).setValues([values]);
  } catch (error) {
    sheet.deleteRow(2);
    throw error;
  }
}

function readDrafts_(spreadsheet) {
  spreadsheet = spreadsheet || SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  return readSheetObjects_(spreadsheet, CONTENT_SHEETS.drafts).filter((row) => row.draft_id && row.payload_json).map((row) => ({
    draftId: row.draft_id,
    savedAt: row.saved_at,
    savedByName: row.saved_by_name,
    savedByEmail: row.saved_by_email,
    payload: buildDraftPayload_(requireContentFormat_(readPayloadCells_(row)))
  })).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

function clearDrafts_() {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(CONTENT_SHEETS.drafts);
  if (!sheet) return;
  writeSheet_(spreadsheet, CONTENT_SHEETS.drafts, [
    ['draft_id', 'saved_at', 'saved_by_name', 'saved_by_email', 'payload_json']
  ]);
}

function readAdminLog_(spreadsheet) {
  spreadsheet = spreadsheet || SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  return readSheetObjects_(spreadsheet, CONTENT_SHEETS.adminLog).map((row) => ({
    timestamp: row.timestamp,
    actorName: row.actor_name,
    actorEmail: row.actor_email,
    action: row.action,
    detail: row.detail
  })).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

function appendAdminLog_(actorName, actorEmail, action, detail) {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(CONTENT_SHEETS.adminLog) || spreadsheet.insertSheet(CONTENT_SHEETS.adminLog);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['timestamp', 'actor_name', 'actor_email', 'action', 'detail']);
  }
  sheet.appendRow([isoNow_(), actorName, actorEmail, action, detail]);
  return sheet.getLastRow();
}

// timings や cleanup の列は、初めて使うときに右端に足す
function writeAdminLogCell_(row, name, text) {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(CONTENT_SHEETS.adminLog);
  if (!sheet) return;
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((value) => String(value || '').trim());
  let column = header.indexOf(name) + 1;
  if (!column) {
    column = header.length + 1;
    ensureSheetSize_(sheet, row, column);
    sheet.getRange(1, column, 1, 1).setValues([[name]]);
  }
  ensureSheetSize_(sheet, row, column);
  sheet.getRange(row, column, 1, 1).setValues([[text]]);
}

function payloadCellHeaders_(count) {
  return Array.from({ length: count }, (_, index) => index === 0 ? 'payload_json' : 'payload_json_' + (index + 1));
}

function buildPayloadCells_(json) {
  if (json.length <= 45000) return [json];
  const chunks = [];
  for (let offset = 0; offset < json.length;) {
    let end = Math.min(offset + 20000, json.length);
    if (end < json.length && /[\uD800-\uDBFF]/.test(json.charAt(end - 1))) end -= 1;
    // JSON の文字列にして書く。分けた先頭が「=」や数字でも、数式や数として扱われないように
    chunks.push(JSON.stringify(json.slice(offset, end)));
    offset = end;
  }
  return [JSON.stringify({ storage_format: 'chunked-json-v1', chunk_count: chunks.length })].concat(chunks);
}

function readPayloadCells_(row) {
  if (!row.payload_json) return {};
  try {
    let payload = JSON.parse(row.payload_json);
    if (payload.storage_format === 'chunked-json-v1') {
      const count = payload.chunk_count;
      if (!Number.isInteger(count) || count < 1 || count > Object.keys(row).length) throw new Error('Invalid chunk count');
      const chunks = [];
      for (let i = 0; i < count; i++) {
        const chunk = JSON.parse(row['payload_json_' + (i + 2)]);
        if (typeof chunk !== 'string') throw new Error('Invalid chunk');
        chunks.push(chunk);
      }
      payload = JSON.parse(chunks.join(''));
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid payload');
    return payload;
  } catch (error) {
    throw new Error('保存データのJSONを復元できません。' + (row.draft_id ? '下書きID: ' + row.draft_id : '公開状態') + 'の payload_json 列と分割列を確認してください。');
  }
}

// シートを Sheets API の1回の問い合わせでまとめて読む（SpreadsheetApp は1枚につき4回ほど問い合わせる）。
// 結果は、読む関数にスプレッドシートの代わりに渡せる。まとめて読めないとき（シートがない、など）は
// スプレッドシートを返し、1枚ずつ読む。
// Sheets API は GAS の「サービス」（appsscript.json）から呼ぶ。UrlFetchApp で直接呼ぶ方法は、
// API が有効になっておらず使えなかった（2026年10月）
function prefetchSheets_(sheetNames) {
  const spreadsheetId = getConfig_().CONTENT_SPREADSHEET_ID;
  try {
    // UNFORMATTED_VALUE なら、文字・数・真偽値は getValues() と同じ値になる。日付のセルだけは表示の文字になる
    const response = Sheets.Spreadsheets.Values.batchGet(spreadsheetId, {
      ranges: sheetNames.map((name) => "'" + name.replace(/'/g, "''") + "'"),
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING'
    });
    const valueRanges = (response && response.valueRanges) || [];
    if (valueRanges.length !== sheetNames.length) throw new Error('unexpected number of ranges: ' + valueRanges.length);
    const prefetchedRows = {};
    sheetNames.forEach((name, index) => {
      prefetchedRows[name] = sheetValuesToObjects_(valueRanges[index].values || [], normalizeFetchedCellValue_);
    });
    return { prefetchedRows };
  } catch (error) {
    console.warn('シートをまとめて読めなかったため、1枚ずつ読みます', error);
    return SpreadsheetApp.openById(spreadsheetId);
  }
}

// 日付のセルを、getValues() で読んだとき（normalizeSheetCellValue_）と同じ yyyy-MM-dd にする。
// API は表示の文字（日本語のスプレッドシートでは 2026/11/18 や 2026/11/18 9:00:00）を返すため
function normalizeFetchedCellValue_(value) {
  if (value === undefined || value === null) return '';
  const match = typeof value === 'string' && value.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?: \d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (match && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return match[1] + '-' + ('0' + match[2]).slice(-2) + '-' + ('0' + match[3]).slice(-2);
  }
  return value;
}

function readSheetObjects_(spreadsheet, sheetName) {
  if (spreadsheet.prefetchedRows) return (spreadsheet.prefetchedRows[sheetName] || []).map((row) => Object.assign({}, row));
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) return [];
  return sheetValuesToObjects_(sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues(), normalizeSheetCellValue_);
}

function sheetValuesToObjects_(values, normalizeCell) {
  if (!values.length) return [];
  const header = values[0];
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    const row = {};
    let hasValue = false;
    for (let j = 0; j < header.length; j += 1) {
      const key = String(header[j] || '').trim();
      if (!key) continue;
      row[key] = normalizeCell((values[i] || [])[j]);
      if (String(row[key] || '') !== '') hasValue = true;
    }
    if (hasValue) rows.push(row);
  }
  return rows;
}

function normalizeSheetCellValue_(value) {
  if (value === undefined || value === null) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (isNaN(value.getTime())) return '';
    return Utilities.formatDate(value, getConfig_().TIMEZONE || 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  return value;
}

function writeSheet_(spreadsheet, sheetName, values) {
  validateSheetCellLengths_(sheetName, values);
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
  const rows = Math.max(values.length, sheet.getLastRow());
  const columns = Math.max(values[0].length, sheet.getLastColumn());
  ensureSheetSize_(sheet, rows, columns);
  // 先に消してから書くと、途中で失敗したときにシートが空になる。余った部分は空欄で上書きする
  const padded = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) => values[r] && c < values[r].length ? values[r][c] : '')
  );
  // 書式なしテキストにして書く。「=…」「10/1」「007」が数式・日付・数にならないように
  sheet.getRange(1, 1, rows, columns).setNumberFormat('@').setValues(padded);
}

function validateSheetCellLengths_(sheetName, values) {
  values.forEach((row, r) => row.forEach((value, c) => {
    if (typeof value === 'string' && value.length > 50000) {
      throw new Error(sheetName + ' の ' + (r + 1) + '行目・' + values[0][c] + ' が50,000文字を超えています。');
    }
  }));
}

function ensureSheetSize_(sheet, rows, columns) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < columns) sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns());
}

function compactContentSheetGrids_() {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  Object.keys(CONTENT_SHEETS).forEach((key) => {
    const sheet = spreadsheet.getSheetByName(CONTENT_SHEETS[key]);
    if (!sheet) return;
    // 固定した見出しの行・列があっても消せるように、固定していない行・列を1つ残す
    const rows = Math.max(2, sheet.getLastRow(), sheet.getFrozenRows() + 1);
    const columns = Math.max(1, sheet.getLastColumn(), sheet.getFrozenColumns() + 1);
    if (sheet.getMaxRows() > rows) sheet.deleteRows(rows + 1, sheet.getMaxRows() - rows);
    if (sheet.getMaxColumns() > columns) sheet.deleteColumns(columns + 1, sheet.getMaxColumns() - columns);
  });
}

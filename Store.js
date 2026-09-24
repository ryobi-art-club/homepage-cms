function getBootstrapData(sessionToken) {
  const session = requireSession_(sessionToken);
  const state = readContentState_();
  return sanitizeForClient_({
    viewerEmail: session.email,
    viewerName: session.name || session.email,
    previewUrl: getConfig_().SITE_PREVIEW_URL,
    options: Object.assign(listDriveFolders(sessionToken), {
      geminiModel: getConfig_().GEMINI_MODEL
    }),
    state: state,
    drafts: readDrafts_(),
    adminLog: readAdminLog_(),
    maintenance: getDriveMaintenanceSummary_(state)
  });
}

function saveDraft(sessionToken, payload) {
  const session = requireSession_(sessionToken);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const normalized = normalizePayload_(payload, readContentState_(), { allowIncomplete: true });
    finalizeManagedMedia_(normalized);
    saveDraftRecord_(normalized, session.name || session.email, session.email);
    return {
      ok: true,
      message: '下書きを保存しました。',
      summary: buildHumanSummary_(normalized)
    };
  } finally {
    lock.releaseLock();
  }
}

function previewSiteHistory(sessionToken, payload) {
  requireSession_(sessionToken);
  const currentState = readContentState_();
  const normalized = normalizePayload_(payload, currentState, { allowIncomplete: true });
  const publishedInfo = readPublishedState_();
  const publicSnapshot = buildPublicSnapshot_(normalized);
  const titleReplacements = buildTitleReplacements_(publishedInfo.payload || {}, publicSnapshot);
  const adjustedLog = applyTitleReplacementsToLog_(currentState.changeLog || [], titleReplacements);
  const adjustedBeforeSnapshot = applyTitleReplacementsToSnapshot_(publishedInfo.payload || {}, titleReplacements);
  const pendingSummary = summarizeChange_(publishedInfo.payload || {}, publicSnapshot, normalized.manualChangeNote);
  const currentEntries = deriveSiteHistoryEntries_(adjustedLog, adjustedBeforeSnapshot, '');
  const nextEntries = deriveSiteHistoryEntries_(adjustedLog, publicSnapshot, pendingSummary);
  return sanitizeForClient_({
    compared: buildSiteHistoryComparison_(currentEntries, nextEntries)
  });
}

function publishState(sessionToken, payload) {
  const session = requireSession_(sessionToken);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const currentState = readContentState_();
    const normalized = normalizePayload_(payload, currentState);
    const publishedInfo = readPublishedState_();
    const currentPayloadJson = stableStringify_(buildPublicSnapshot_(normalized));
    const currentHash = sha256Hex_(currentPayloadJson);

    finalizeManagedFolders_(normalized);
    writeStateToSheets_(normalized, session.name || session.email, session.email, true);

    let changeSummary = '内容を更新しました。';
    const publicSnapshot = buildPublicSnapshot_(normalized);
    if (publishedInfo.sha256 !== currentHash) {
      syncChangeLogTitles_(publishedInfo.payload, publicSnapshot);
      const summarized = summarizeChange_(publishedInfo.payload, publicSnapshot, normalized.manualChangeNote);
      if (summarized) {
        changeSummary = summarized;
        appendChangeLog_(session.name || session.email, session.email, changeSummary);
      }
      writePublishedState_(currentPayloadJson, currentHash);
    }

    clearDrafts_();
    cleanupUnreferencedDraftFolders_(normalized);
    appendAdminLog_(session.name || session.email, session.email, 'published', buildAdminDiffSummary_(publishedInfo.payload, publicSnapshot, normalized.manualChangeNote));
    compactContentSheetGrids_();
    const dispatchInfo = dispatchGithubWorkflow_();
    return {
      ok: true,
      message: '公開を開始しました。',
      changeSummary: changeSummary,
      actionsUrl: dispatchInfo.actionsUrl
    };
  } finally {
    lock.releaseLock();
  }
}

function readContentState_() {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const recruitCalendars = readRecruitCalendars_(spreadsheet);
  return {
    recruitCalendars: recruitCalendars,
    recruitCalendar: getPublishedRecruitCalendar_(recruitCalendars),
    activityArticles: readActivityArticles_(spreadsheet),
    exhibitions: readExhibitions_(spreadsheet),
    requestCases: readRequestCases_(spreadsheet),
    changeLog: readChangeLog_(spreadsheet),
    manualChangeNote: ''
  };
}

function loadDraft(sessionToken, draftId) {
  requireSession_(sessionToken);
  const drafts = readDrafts_();
  const match = drafts.find((item) => item.draftId === draftId);
  if (!match) throw new Error('指定した下書きが見つかりません。');
  return match.payload;
}


function normalizePayload_(payload, existingState, options) {
  options = options || {};
  if (!payload || typeof payload !== 'object') throw new Error('入力データが不正です。');
  const recruitCalendars = normalizeRecruitCalendars_(
    payload.recruitCalendars || (payload.recruitCalendar ? [payload.recruitCalendar] : []),
    existingState.recruitCalendars || []
  );
  const normalized = {
    recruitCalendars: recruitCalendars,
    recruitCalendar: getPublishedRecruitCalendar_(recruitCalendars),
    activityArticles: normalizeActivityArticles_(payload.activityArticles, existingState.activityArticles || [], options),
    exhibitions: normalizeExhibitions_(payload.exhibitions, existingState.exhibitions || [], options),
    requestCases: normalizeRequestCases_(payload.requestCases, options),
    changeLog: existingState.changeLog || [],
    manualChangeNote: cleanMultiline_(payload.manualChangeNote, 500)
  };
  validateBusinessRules_(normalized);
  return normalized;
}

function normalizeRecruitCalendars_(items, existingItems) {
  const rows = (items || []).filter(Boolean).map((item) => {
    const year = String(item.year || '').replace(/[^\d]/g, '').slice(0, 4);
    const mediaFolderId = String(item.mediaFolderId || item.folderId || '').trim();
    const mediaFileIds = normalizeStringList_(item.mediaFileIds || item.fileIds);
    return {
      year: year,
      mediaFolderId: mediaFolderId,
      folderId: mediaFolderId,
      mediaFileIds: mediaFileIds,
      label: year ? year + '年度 新歓イベントカレンダー' : String(item.label || '').trim(),
      published: item.published === false ? false : parseBool_(item.published, true),
      updatedAt: isoNow_()
    };
  }).filter((item) => item.year || item.mediaFolderId || item.mediaFileIds.length);

  if (!rows.length) {
    const year = String(new Date().getFullYear());
    rows.push({
      year: year,
      mediaFolderId: '',
      folderId: '',
      mediaFileIds: [],
      label: year + '年度 新歓イベントカレンダー',
      published: true,
      updatedAt: isoNow_()
    });
  }

  let publishedSeen = false;
  rows.forEach((item) => {
    if (item.published && !publishedSeen) {
      publishedSeen = true;
    } else {
      item.published = false;
    }
  });
  if (!publishedSeen) rows[0].published = true;

  return rows.sort((a, b) => String(b.year || '').localeCompare(String(a.year || '')));
}

function getPublishedRecruitCalendar_(items) {
  const list = (items || []).slice();
  const selected = list.find((item) => item.published !== false) || list[0] || {};
  const year = String(selected.year || '').trim();
  const mediaFolderId = String(selected.mediaFolderId || selected.folderId || '').trim();
  return {
    year: year,
    mediaFolderId: mediaFolderId,
    folderId: mediaFolderId,
    mediaFileIds: normalizeStringList_(selected.mediaFileIds || []),
    label: year ? year + '年度 新歓イベントカレンダー' : String(selected.label || '新歓イベントカレンダー').trim(),
    published: selected.published !== false,
    updatedAt: selected.updatedAt || ''
  };
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

function optionalSingleLine_(value, maxLength) {
  return cleanMultiline_(value, maxLength).replace(/\n+/g, ' ').trim();
}

function requiredOrDraft_(value, label, maxLength, options) {
  if (options && options.allowIncomplete) return optionalSingleLine_(value, maxLength);
  return requireString_(value, label, maxLength);
}

function normalizeActivityArticles_(items, existingItems, options) {
  const existingById = {};
  (existingItems || []).forEach((item) => existingById[item.articleId] = item);
  return (items || []).filter(Boolean).map((item, index) => {
    const articleId = String(item.articleId || '').trim() || 'activity-' + Utilities.getUuid().slice(0, 8);
    const existing = existingById[articleId];
    return {
      articleId: articleId,
      title: requiredOrDraft_(item.title, '活動記事タイトル', 120, options),
      body: cleanMultiline_(item.body, 4000),
      category: requireActivityCategory_(item.category),
      mediaFolderId: String(item.mediaFolderId || item.photoFolderId || '').trim(),
      photoFolderId: String(item.mediaFolderId || item.photoFolderId || '').trim(),
      mediaFileIds: normalizeStringList_(item.mediaFileIds || item.fileIds),
      published: item.published === false ? false : parseBool_(item.published, true),
      createdAt: existing ? existing.createdAt : isoNow_(),
      updatedAt: isoNow_()
    };
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function normalizeExhibitions_(items, existingItems, options) {
  const existingById = {};
  (existingItems || []).forEach((item) => existingById[item.exhibitionId] = item);
  return (items || []).filter(Boolean).map((item) => {
    const exhibitionId = String(item.exhibitionId || '').trim() || 'exhibition-' + Utilities.getUuid().slice(0, 8);
    const folderId = String(item.mediaFolderId || item.driveFolderId || '').trim();
    const dmFileIds = normalizeStringList_(item.dmFileIds || item.dm_file_ids).slice(0, 2);
    const works = normalizeExhibitionWorkFiles_(item.workFiles || item.works);
    return {
      exhibitionId: exhibitionId,
      title: requiredOrDraft_(item.title, '展示会名', 140, options),
      subtitle: optionalSingleLine_(item.subtitle, 140),
      theme: cleanMultiline_(item.theme, 180),
      venueName: optionalSingleLine_(item.venueName, 180),
      venueAddress: cleanMultiline_(item.venueAddress, 240),
      dateLine: optionalSingleLine_(item.dateLine, 180),
      timeLine: optionalSingleLine_(item.timeLine, 220),
      mapEmbedUrl: String(item.mapEmbedUrl || '').trim(),
      displayBucket: requireDisplayBucket_(item.displayBucket),
      mediaFolderId: folderId,
      driveFolderId: folderId,
      dmFileIds: dmFileIds,
      published: item.published === false ? false : parseBool_(item.published, true),
      startDate: String(item.startDate || '').trim(),
      draftCreatedAt: String(item.draftCreatedAt || (existingById[exhibitionId] && existingById[exhibitionId].draftCreatedAt) || isoNow_()),
      updatedAt: isoNow_(),
      workFiles: works,
      works: works
    };
  }).sort(compareExhibitions_);
}

function normalizeRequestCases_(items, options) {
  return (items || []).filter(Boolean).map((item, index) => ({
    caseId: String(item.caseId || '').trim() || 'request-' + Utilities.getUuid().slice(0, 8),
    title: requiredOrDraft_(item.title, '事例タイトル', 120, options),
    body: cleanMultiline_(item.body, 4000),
    mediaFolderId: String(item.mediaFolderId || item.photoFolderId || '').trim(),
    photoFolderId: String(item.mediaFolderId || item.photoFolderId || '').trim(),
    mediaFileIds: normalizeStringList_(item.mediaFileIds || item.fileIds),
    sortOrder: index + 1,
    published: item.published === false ? false : parseBool_(item.published, true),
    updatedAt: isoNow_()
  }));
}

function normalizeExhibitionWorkFiles_(items) {
  return (items || []).filter(Boolean).slice(0, 200).map((work, idx) => {
    const fileId = String(work.fileId || work.file_id || '').trim();
    const title = cleanMultiline_(work.title || work.workTitle, 140);
    const artist = cleanMultiline_(work.artist || work.artistName, 120);
    return {
      fileId: fileId,
      file_id: fileId,
      sortOrder: Number(work.sortOrder || work.sort_order || idx + 1),
      title: title,
      artist: artist,
      workTitle: title,
      artistName: artist
    };
  }).filter((work) => work.fileId);
}



function compareExhibitions_(a, b) {
  const weight = { upcoming: 0, archive: 1 };
  const bucketA = Object.prototype.hasOwnProperty.call(weight, a.displayBucket) ? weight[a.displayBucket] : 99;
  const bucketB = Object.prototype.hasOwnProperty.call(weight, b.displayBucket) ? weight[b.displayBucket] : 99;
  if (bucketA !== bucketB) return bucketA - bucketB;

  const hasDateA = !!String(a.startDate || '').trim();
  const hasDateB = !!String(b.startDate || '').trim();
  if (!hasDateA && !hasDateB) return String(b.draftCreatedAt || '').localeCompare(String(a.draftCreatedAt || ''));
  if (!hasDateA) return -1;
  if (!hasDateB) return 1;

  if (a.displayBucket === 'upcoming') return String(a.startDate || '').localeCompare(String(b.startDate || ''));
  return String(b.startDate || '').localeCompare(String(a.startDate || ''));
}

function requireActivityCategory_(value) {
  const normalized = String(value || 'record').trim().toLowerCase();
  if (['record', 'event', 'other'].indexOf(normalized) === -1) {
    throw new Error('活動記事のカテゴリが不正です。');
  }
  return normalized;
}

function parseBool_(value, fallback) {
  if (value === true || value === false) return value;
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (!normalized) return !!fallback;
  return ['1', 'true', 'yes', 'on', 'y'].indexOf(normalized) !== -1;
}

function requireDisplayBucket_(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['upcoming', 'archive'].indexOf(normalized) === -1) {
    throw new Error('展示会の表示区分が不正です。');
  }
  return normalized;
}

function validateBusinessRules_(state) {
}

function writeStateToSheets_(state, actorName, actorEmail, touchPublishState) {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const tables = [];
  function collect(sheetName, values) { tables.push({ sheetName, values }); }
  collect(CONTENT_SHEETS.recruit, [
    ['year', 'media_folder_id', 'media_file_ids', 'published', 'updated_at']
  ].concat((state.recruitCalendars || []).map((item) => [
    item.year, item.mediaFolderId, JSON.stringify(item.mediaFileIds || []), item.published ? 'TRUE' : 'FALSE', item.updatedAt || isoNow_()
  ])));

  collect(CONTENT_SHEETS.activityArticles, [
    ['article_id', 'title', 'category', 'body', 'media_folder_id', 'media_file_ids', 'published', 'created_at', 'updated_at']
  ].concat(state.activityArticles.map((item) => [
    item.articleId, item.title, item.category, item.body, item.mediaFolderId, JSON.stringify(item.mediaFileIds || []), item.published ? 'TRUE' : 'FALSE', item.createdAt, item.updatedAt
  ])));

  collect(CONTENT_SHEETS.exhibitions, [
    ['exhibition_id', 'title', 'subtitle', 'theme', 'venue_name', 'venue_address', 'date_line', 'time_line', 'map_embed_url', 'display_bucket', 'media_folder_id', 'dm_file_ids', 'work_files', 'published', 'start_date', 'updated_at']
  ].concat(state.exhibitions.map((item) => [
    item.exhibitionId, item.title, item.subtitle || '', item.theme, item.venueName, item.venueAddress, item.dateLine, item.timeLine, item.mapEmbedUrl,
    item.displayBucket, item.mediaFolderId, JSON.stringify(item.dmFileIds || []), JSON.stringify(serializeWorkFiles_(item.workFiles || item.works || [])), item.published ? 'TRUE' : 'FALSE', item.startDate, item.updatedAt
  ])));

  collect(CONTENT_SHEETS.requestCases, [
    ['case_id', 'title', 'body', 'media_folder_id', 'media_file_ids', 'sort_order', 'published', 'updated_at']
  ].concat(state.requestCases.map((item) => [
    item.caseId, item.title, item.body, item.mediaFolderId, JSON.stringify(item.mediaFileIds || []), String(item.sortOrder), item.published ? 'TRUE' : 'FALSE', item.updatedAt
  ])));

  tables.forEach((table) => validateSheetCellLengths_(table.sheetName, table.values));
  tables.forEach((table) => writeSheet_(spreadsheet, table.sheetName, table.values));
  if (touchPublishState) {
    SpreadsheetApp.flush();
  }
}

function writeSheet_(spreadsheet, sheetName, values) {
  validateSheetCellLengths_(sheetName, values);
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
  const rows = Math.max(values.length, sheet.getLastRow());
  const columns = Math.max(values[0].length, sheet.getLastColumn());
  ensureSheetSize_(sheet, rows, columns);
  // Replace data and obsolete cells together, without clearing the old data first.
  const padded = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) => values[r] && c < values[r].length ? values[r][c] : '')
  );
  sheet.getRange(1, 1, rows, columns).setValues(padded);
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
    // Keep an unfrozen row/column so frozen headers do not prevent deletion.
    const rows = Math.max(2, sheet.getLastRow(), sheet.getFrozenRows() + 1);
    const columns = Math.max(1, sheet.getLastColumn(), sheet.getFrozenColumns() + 1);
    if (sheet.getMaxRows() > rows) sheet.deleteRows(rows + 1, sheet.getMaxRows() - rows);
    if (sheet.getMaxColumns() > columns) sheet.deleteColumns(columns + 1, sheet.getMaxColumns() - columns);
  });
}

function readRecruitCalendars_(spreadsheet) {
  const rows = readSheetObjects_(spreadsheet, CONTENT_SHEETS.recruit);
  if (!rows.length) return normalizeRecruitCalendars_([], []);
  return rows.map((row) => {
    const year = String(row.year || '').replace(/[^\d]/g, '').slice(0, 4);
    const mediaFolderId = String(row.media_folder_id || row.recruit_calendar_folder_id || '');
    return {
      year: year,
      mediaFolderId: mediaFolderId,
      folderId: mediaFolderId,
      mediaFileIds: normalizeStringList_(row.media_file_ids),
      label: year ? year + '年度 新歓イベントカレンダー' : String(row.recruit_calendar_label || '新歓イベントカレンダー'),
      published: parseBool_(row.published, true),
      updatedAt: row.updated_at
    };
  }).sort((a, b) => String(b.year || '').localeCompare(String(a.year || '')));
}

function readActivityArticles_(spreadsheet) {
  return readSheetObjects_(spreadsheet, CONTENT_SHEETS.activityArticles).map((row) => ({
    articleId: row.article_id,
    title: row.title,
    category: row.category || 'record',
    body: row.body,
    mediaFolderId: row.media_folder_id || row.photo_folder_id,
    photoFolderId: row.media_folder_id || row.photo_folder_id,
    mediaFileIds: normalizeStringList_(row.media_file_ids),
    published: parseBool_(row.published, true),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function readExhibitions_(spreadsheet) {
  return readSheetObjects_(spreadsheet, CONTENT_SHEETS.exhibitions).map((row) => {
    const works = normalizeExhibitionWorkFiles_(parseJson_(row.work_files, [])).sort((a, b) => a.sortOrder - b.sortOrder);
    return {
      exhibitionId: row.exhibition_id,
      title: row.title,
      subtitle: row.subtitle,
      theme: row.theme,
      venueName: row.venue_name,
      venueAddress: row.venue_address,
      dateLine: row.date_line,
      timeLine: row.time_line,
      mapEmbedUrl: row.map_embed_url,
      displayBucket: row.display_bucket,
      mediaFolderId: row.media_folder_id || row.drive_folder_id,
      driveFolderId: row.media_folder_id || row.drive_folder_id,
      dmFileIds: normalizeStringList_(row.dm_file_ids),
      published: parseBool_(row.published, true),
      startDate: row.start_date,
      workFiles: works,
      works: works
    };
  }).sort(compareExhibitions_);
}

function readRequestCases_(spreadsheet) {
  return readSheetObjects_(spreadsheet, CONTENT_SHEETS.requestCases)
    .map((row) => ({
      caseId: row.case_id,
      title: row.title,
      body: row.body,
      mediaFolderId: row.media_folder_id || row.photo_folder_id,
      photoFolderId: row.media_folder_id || row.photo_folder_id,
      mediaFileIds: normalizeStringList_(row.media_file_ids),
      sortOrder: Number(row.sort_order || 9999),
      published: parseBool_(row.published, true),
      updatedAt: row.updated_at
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function readChangeLog_(spreadsheet) {
  return readSheetObjects_(spreadsheet, CONTENT_SHEETS.changeLog)
    .map((row) => ({
      timestamp: row.timestamp,
      summary: row.summary,
      actorName: row.actor_name || '',
      actorEmailInput: row.actor_email_input,
      revision: row.revision
    }))
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

function readPublishedState_() {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const rows = readSheetObjects_(spreadsheet, CONTENT_SHEETS.publishedState);
  const row = rows[0] || {};
  return {
    payload: restoreStoredPayload_(readPayloadCells_(row), false),
    sha256: String(row.sha256 || ''),
    revision: Number(row.revision || 0)
  };
}

function writePublishedState_(payloadJson, sha256) {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const current = readPublishedState_();
  const cells = buildPayloadCells_(JSON.parse(payloadJson));
  writeSheet_(spreadsheet, CONTENT_SHEETS.publishedState, [
    ['updated_at', 'revision', 'sha256'].concat(payloadCellHeaders_(cells.length)),
    [isoNow_(), String(current.revision + 1), sha256].concat(cells)
  ]);
}


function appendChangeLog_(actorName, actorEmail, summary) {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(CONTENT_SHEETS.changeLog) || spreadsheet.insertSheet(CONTENT_SHEETS.changeLog);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['timestamp', 'summary', 'actor_name', 'actor_email_input', 'revision']);
  }
  const published = readPublishedState_();
  sheet.appendRow([isoNow_(), summary, actorName, actorEmail, String(published.revision + 1)]);
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

function buildTitleReplacements_(beforeSnapshot, afterSnapshot) {
  const replacements = [];
  collectTitleReplacements_(beforeSnapshot.activityArticles, afterSnapshot.activityArticles, 'activity', 'articleId', ['活動記録・告知', '活動記事'], replacements);
  collectTitleReplacements_(beforeSnapshot.requestCases, afterSnapshot.requestCases, 'request', 'caseId', ['取り組み', '取り組み事例', 'ご依頼事例'], replacements);
  collectTitleReplacements_(beforeSnapshot.exhibitions, afterSnapshot.exhibitions, 'exhibition', 'exhibitionId', ['展示会'], replacements);
  return replacements;
}

function collectTitleReplacements_(beforeItems, afterItems, kind, idKey, labels, out) {
  const beforeMap = {};
  (beforeItems || []).forEach((item) => {
    if (item && item[idKey]) beforeMap[item[idKey]] = item;
  });
  (afterItems || []).forEach((item) => {
    if (!item || !item[idKey]) return;
    const before = beforeMap[item[idKey]];
    if (!before) return;
    const oldTitle = String(before.title || '').trim();
    const newTitle = String(item.title || '').trim();
    if (oldTitle && newTitle && oldTitle !== newTitle) {
      out.push({ kind: kind, idKey: idKey, id: item[idKey], labels: labels, oldTitle: oldTitle, newTitle: newTitle });
    }
  });
}

function applyTitleReplacement_(summary, replacement) {
  let out = summary;
  (replacement.labels || []).forEach((label) => {
    const oldNeedle = label + '「' + replacement.oldTitle + '」';
    const newNeedle = label + '「' + replacement.newTitle + '」';
    out = out.split(oldNeedle).join(newNeedle);
  });
  return out;
}

function applyTitleReplacementsToLog_(logItems, replacements) {
  return (logItems || []).map((item) => {
    let summary = String(item.summary || '');
    (replacements || []).forEach((replacement) => {
      summary = applyTitleReplacement_(summary, replacement);
    });
    return Object.assign({}, item, { summary: summary });
  });
}

function applyTitleReplacementsToSnapshot_(snapshot, replacements) {
  const copy = JSON.parse(JSON.stringify(snapshot || {}));
  const collectionMap = {
    activity: { key: 'activityArticles', idKey: 'articleId' },
    request: { key: 'requestCases', idKey: 'caseId' },
    exhibition: { key: 'exhibitions', idKey: 'exhibitionId' }
  };
  (replacements || []).forEach((replacement) => {
    const target = collectionMap[replacement.kind];
    if (!target || !Array.isArray(copy[target.key])) return;
    copy[target.key].forEach((item) => {
      if (item && item[target.idKey] === replacement.id) item.title = replacement.newTitle;
    });
  });
  return copy;
}

function looksLegacySummarySegment_(segment) {
  return segment === '新歓イベントカレンダーを更新'
    || /^(活動記事|活動記録・告知|ご依頼事例|取り組み事例|取り組み)「.+?」(?:を追加|を更新|の情報を公開)?$/.test(segment)
    || /^展示会「.+?」(?:を追加|を更新|の情報を公開)?$/.test(segment);
}

function splitSummarySegments_(summary) {
  const normalized = String(summary || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.indexOf('\n') !== -1) return normalized.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  const legacyParts = normalized.split(/\s\/\s/).map((part) => part.trim()).filter(Boolean);
  if (legacyParts.length > 1 && legacyParts.every(looksLegacySummarySegment_)) return legacyParts;
  return [normalized];
}

function publicSegmentKey_(segment) {
  if (segment === '新歓イベントカレンダーを更新') return { kind: 'recruit', title: '' };
  let match = segment.match(/^(活動記事|活動記録・告知)「(.+?)」(?:を追加|を更新|の情報を公開)?$/);
  if (match) return { kind: 'activity', title: match[2] };
  match = segment.match(/^(ご依頼事例|取り組み事例|取り組み)「(.+?)」(?:を追加|を更新|の情報を公開)?$/);
  if (match) return { kind: 'request', title: match[2] };
  match = segment.match(/^展示会「(.+?)」(?:を追加|を更新|の情報を公開)?$/);
  if (match) return { kind: 'exhibition', title: match[1] };
  return { kind: '', title: '' };
}

function canonicalPublicSummary_(kind, title) {
  if (kind === 'recruit') return '新歓イベントカレンダーを更新';
  if (kind === 'activity' && title) return '活動記録・告知「' + title + '」';
  if (kind === 'request' && title) return '取り組み「' + title + '」';
  if (kind === 'exhibition' && title) return '展示会「' + title + '」の情報を公開';
  return title || '';
}

function buildVisibleTitleSets_(state) {
  const out = { activity: {}, request: {}, exhibition: {} };
  (state.activityArticles || []).filter((item) => item.published !== false && item.title).forEach((item) => out.activity[String(item.title)] = true);
  (state.requestCases || []).filter((item) => item.published !== false && item.title).forEach((item) => out.request[String(item.title)] = true);
  (state.exhibitions || []).filter((item) => item.published !== false && item.title).forEach((item) => out.exhibition[String(item.title)] = true);
  return out;
}

function formatHistoryDate_(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('.');
}

function deriveSiteHistoryEntries_(baseLog, state, pendingSummary) {
  const visible = buildVisibleTitleSets_(state || {});
  const entries = [];
  if (pendingSummary) entries.push({ timestamp: isoNow_(), summary: pendingSummary });
  (baseLog || []).forEach((item) => entries.push(item));

  const groups = [];
  const groupIndex = {};
  entries.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || ''))).forEach((entry) => {
    const dateKey = formatHistoryDate_(entry.timestamp);
    if (!groupIndex[dateKey]) {
      groupIndex[dateKey] = { date: dateKey, items: [], seen: {} };
      groups.push(groupIndex[dateKey]);
    }
    splitSummarySegments_(entry.summary).forEach((segment) => {
      const key = publicSegmentKey_(segment);
      let keep = false;
      let normalized = segment;
      if (key.kind === 'recruit') {
        keep = true;
        normalized = canonicalPublicSummary_('recruit');
      } else if (key.kind && key.title) {
        keep = !!(visible[key.kind] && visible[key.kind][key.title]);
        normalized = canonicalPublicSummary_(key.kind, key.title);
      } else if (!key.kind) {
        keep = !!segment;
      }
      if (keep && !groupIndex[dateKey].seen[normalized]) {
        groupIndex[dateKey].seen[normalized] = true;
        groupIndex[dateKey].items.push(normalized);
      }
    });
  });
  return groups.filter((entry) => entry.items.length).map((entry) => ({ date: entry.date, items: entry.items }));
}

function buildSiteHistoryComparison_(currentEntries, nextEntries) {
  const currentMap = {};
  const nextMap = {};
  const grouped = {};
  const dates = [];
  function ensureDate(date) {
    if (!grouped[date]) {
      grouped[date] = [];
      dates.push(date);
    }
    return grouped[date];
  }

  (currentEntries || []).forEach((entry) => {
    (entry.items || []).forEach((summary, index) => {
      currentMap[entry.date + '::' + summary] = { index: index };
    });
  });
  (nextEntries || []).forEach((entry) => {
    (entry.items || []).forEach((summary, index) => {
      const key = entry.date + '::' + summary;
      nextMap[key] = { index: index };
      ensureDate(entry.date).push({ summary: summary, status: currentMap[key] ? 'unchanged' : 'added', order: index });
    });
  });
  (currentEntries || []).forEach((entry) => {
    (entry.items || []).forEach((summary, index) => {
      const key = entry.date + '::' + summary;
      if (!nextMap[key]) ensureDate(entry.date).push({ summary: summary, status: 'removed', order: 1000 + index });
    });
  });
  return dates.sort((a, b) => String(b).localeCompare(String(a))).map((date) => ({
    date: date,
    items: grouped[date].sort((a, b) => a.order - b.order).map((item) => ({ summary: item.summary, status: item.status }))
  })).filter((entry) => entry.items.length);
}

function appendAdminLog_(actorName, actorEmail, action, detail) {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(CONTENT_SHEETS.adminLog) || spreadsheet.insertSheet(CONTENT_SHEETS.adminLog);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['timestamp', 'actor_name', 'actor_email', 'action', 'detail']);
  }
  sheet.appendRow([isoNow_(), actorName, actorEmail, action, detail]);
}

function saveDraftRecord_(state, actorName, actorEmail) {
  const cells = buildPayloadCells_(state);
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

function readDrafts_() {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  return readSheetObjects_(spreadsheet, CONTENT_SHEETS.drafts).filter((row) => row.draft_id && row.payload_json).map((row) => ({
    draftId: row.draft_id,
    savedAt: row.saved_at,
    savedByName: row.saved_by_name,
    savedByEmail: row.saved_by_email,
    payload: restoreStoredPayload_(readPayloadCells_(row), true)
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

function readAdminLog_() {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  return readSheetObjects_(spreadsheet, CONTENT_SHEETS.adminLog).map((row) => ({
    timestamp: row.timestamp,
    actorName: row.actor_name,
    actorEmail: row.actor_email,
    action: row.action,
    detail: row.detail
  })).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

function readSheetObjects_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) return [];
  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  if (!values.length) return [];
  const header = values[0];
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    const row = {};
    let hasValue = false;
    for (let j = 0; j < header.length; j += 1) {
      const key = String(header[j] || '').trim();
      if (!key) continue;
      row[key] = normalizeSheetCellValue_(values[i][j]);
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

function sanitizeForClient_(value) {
  if (value === undefined) return '';
  if (value === null) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (isNaN(value.getTime())) return '';
    return Utilities.formatDate(value, getConfig_().TIMEZONE || 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForClient_(item));
  }
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((key) => {
      out[key] = sanitizeForClient_(value[key]);
    });
    return out;
  }
  if (typeof value === 'number' && !isFinite(value)) return '';
  return value;
}

function serializeWorkFiles_(items) {
  return (items || []).filter(Boolean).map((work, index) => ({
    file_id: String(work.fileId || work.file_id || '').trim(),
    sort_order: Number(work.sortOrder || work.sort_order || index + 1),
    title: String(work.title || work.workTitle || '').trim(),
    artist: String(work.artist || work.artistName || '').trim()
  })).filter((work) => work.file_id);
}

function compactStoredPayload_(state) {
  const result = Object.assign({}, state);
  if (Array.isArray(state.exhibitions)) {
    result.exhibitions = state.exhibitions.map((item) => {
      const exhibition = Object.assign({}, item, { workFiles: serializeWorkFiles_(item.workFiles || item.works || []) });
      delete exhibition.works;
      return exhibition;
    });
  }
  return result;
}

function restoreStoredPayload_(state, isDraft) {
  const result = Object.assign({}, state);
  if (Array.isArray(state.exhibitions)) {
    result.exhibitions = state.exhibitions.map((item) => {
      const source = item.workFiles || item.works || [];
      const works = isDraft ? normalizeExhibitionWorkFiles_(source) : serializeWorkFiles_(source);
      return Object.assign({}, item, { workFiles: works, works });
    });
  }
  return result;
}

function payloadCellHeaders_(count) {
  return Array.from({ length: count }, (_, index) => index === 0 ? 'payload_json' : 'payload_json_' + (index + 1));
}

function buildPayloadCells_(state) {
  const json = stableStringify_(compactStoredPayload_(state));
  if (json.length <= 45000) return [json];
  const chunks = [];
  for (let offset = 0; offset < json.length;) {
    let end = Math.min(offset + 20000, json.length);
    if (end < json.length && /[\uD800-\uDBFF]/.test(json.charAt(end - 1))) end -= 1;
    // Quoting keeps fragments textual even when they start with '=' or a digit.
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

function buildPublicSnapshot_(state) {
  return {
    recruitCalendar: state.recruitCalendar,
    recruitCalendars: state.recruitCalendars,
    activityArticles: state.activityArticles.map((item) => ({
      articleId: item.articleId,
      title: item.title,
      body: item.body,
      category: item.category,
      mediaFolderId: item.mediaFolderId,
      photoFolderId: item.mediaFolderId,
      mediaFileIds: item.mediaFileIds || [],
      published: item.published,
      createdAt: item.createdAt
    })),
    exhibitions: state.exhibitions.map((item) => ({
      exhibitionId: item.exhibitionId,
      title: item.title,
      subtitle: item.subtitle,
      theme: item.theme,
      venueName: item.venueName,
      venueAddress: item.venueAddress,
      dateLine: item.dateLine,
      timeLine: item.timeLine,
      mapEmbedUrl: item.mapEmbedUrl,
      displayBucket: item.displayBucket,
      mediaFolderId: item.mediaFolderId,
      driveFolderId: item.mediaFolderId,
      dmFileIds: item.dmFileIds || [],
      published: item.published,
      startDate: item.startDate,
      workFiles: serializeWorkFiles_(item.workFiles || item.works || []),
      works: serializeWorkFiles_(item.workFiles || item.works || [])
    })),
    requestCases: state.requestCases.map((item) => ({
      caseId: item.caseId,
      title: item.title,
      body: item.body,
      category: item.category,
      mediaFolderId: item.mediaFolderId,
      photoFolderId: item.mediaFolderId,
      mediaFileIds: item.mediaFileIds || [],
      published: item.published,
      sortOrder: item.sortOrder
    }))
  };
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


function summarizeChange_(beforeSnapshot, afterSnapshot, manualNote) {
  const messages = [];
  const beforeRecruit = beforeSnapshot && beforeSnapshot.recruitCalendar ? beforeSnapshot.recruitCalendar.folderId : '';
  const afterRecruit = afterSnapshot.recruitCalendar ? afterSnapshot.recruitCalendar.folderId : '';
  if (beforeRecruit !== afterRecruit && afterRecruit) messages.push('新歓イベントカレンダーを更新');

  const beforeActivities = {};
  (beforeSnapshot.activityArticles || []).forEach((item) => beforeActivities[item.articleId] = item);
  (afterSnapshot.activityArticles || []).forEach((item) => {
    const before = beforeActivities[item.articleId];
    if ((!before || before.published === false) && item.published !== false) messages.push('活動記録・告知「' + item.title + '」');
  });

  const beforeRequests = {};
  (beforeSnapshot.requestCases || []).forEach((item) => beforeRequests[item.caseId] = item);
  (afterSnapshot.requestCases || []).forEach((item) => {
    const before = beforeRequests[item.caseId];
    if ((!before || before.published === false) && item.published !== false) messages.push('取り組み「' + item.title + '」');
  });

  const beforeExhibitions = {};
  (beforeSnapshot.exhibitions || []).forEach((item) => beforeExhibitions[item.exhibitionId] = item);
  (afterSnapshot.exhibitions || []).forEach((item) => {
    const before = beforeExhibitions[item.exhibitionId];
    if ((!before || before.published === false) && item.published !== false) messages.push('展示会「' + item.title + '」の情報を公開');
  });

  if (manualNote) messages.push(manualNote);
  return messages.length ? messages.join('\n') : '';
}


function buildAdminDiffSummary_(beforeSnapshot, afterSnapshot, manualNote) {
  const messages = [];
  function pushIf(value) {
    if (value && messages.indexOf(value) === -1) messages.push(value);
  }
  function compareCollections(beforeItems, afterItems, idKey, label, stripFn, extraComparator) {
    const beforeMap = {};
    (beforeItems || []).forEach((item) => beforeMap[item[idKey]] = item);
    const afterMap = {};
    (afterItems || []).forEach((item) => afterMap[item[idKey]] = item);
    Object.keys(afterMap).forEach((id) => {
      const before = beforeMap[id];
      const after = afterMap[id];
      if (!before && after.published !== false) {
        pushIf(label + '「' + after.title + '」を公開');
        return;
      }
      if (!before) return;
      if (before.published !== false && after.published === false) {
        pushIf(label + '「' + after.title + '」を非公開');
        return;
      }
      if (before.published === false && after.published !== false) {
        pushIf(label + '「' + after.title + '」を公開に戻す');
      }
      if (extraComparator) {
        const extra = extraComparator(before, after);
        if (extra) pushIf(extra);
      }
      if (stableStringify_(stripFn(before)) !== stableStringify_(stripFn(after))) {
        pushIf(label + '「' + after.title + '」を編集');
      }
    });
    Object.keys(beforeMap).forEach((id) => {
      if (!afterMap[id]) pushIf(label + '「' + beforeMap[id].title + '」を削除');
    });
  }
  const beforeRecruit = beforeSnapshot && beforeSnapshot.recruitCalendar ? beforeSnapshot.recruitCalendar.folderId : '';
  const afterRecruit = afterSnapshot.recruitCalendar ? afterSnapshot.recruitCalendar.folderId : '';
  if (beforeRecruit !== afterRecruit && afterRecruit) pushIf('新歓イベントカレンダーを更新');
  compareCollections(beforeSnapshot.activityArticles || [], afterSnapshot.activityArticles || [], 'articleId', '活動記録・告知', function(item) {
    return { title: item.title, body: item.body, category: item.category, mediaFolderId: item.mediaFolderId, mediaFileIds: item.mediaFileIds, createdAt: item.createdAt, published: item.published };
  });
  compareCollections(beforeSnapshot.requestCases || [], afterSnapshot.requestCases || [], 'caseId', '取り組み', function(item) {
    return { title: item.title, body: item.body, mediaFolderId: item.mediaFolderId, mediaFileIds: item.mediaFileIds, sortOrder: item.sortOrder, published: item.published };
  });
  compareCollections(beforeSnapshot.exhibitions || [], afterSnapshot.exhibitions || [], 'exhibitionId', '展示会', function(item) {
    return { title: item.title, subtitle: item.subtitle, theme: item.theme, venueName: item.venueName, venueAddress: item.venueAddress, dateLine: item.dateLine, timeLine: item.timeLine, mapEmbedUrl: item.mapEmbedUrl, mediaFolderId: item.mediaFolderId, dmFileIds: item.dmFileIds, published: item.published, startDate: item.startDate, workFiles: item.workFiles };
  }, function(before, after) {
    if (before.displayBucket !== after.displayBucket) {
      return after.displayBucket === 'archive' ? '展示会「' + after.title + '」をアーカイブに移動' : '展示会「' + after.title + '」を開催予定に変更';
    }
    return '';
  });
  if (manualNote) pushIf('補足: ' + manualNote);
  return messages.length ? messages.join('\n') : '変更なし';
}

function buildHumanSummary_(state) {
  return {
    activityCount: state.activityArticles.length,
    exhibitionCount: state.exhibitions.length,
    requestCaseCount: state.requestCases.length,
    recruitCalendarSelected: !!state.recruitCalendar.mediaFolderId
  };
}

function getBootstrapData(sessionToken) {
  const session = requireSession_(sessionToken);
  const state = readContentState_();
  return {
    viewerEmail: session.email,
    viewerName: session.name || session.email,
    previewUrl: getConfig_().SITE_PREVIEW_URL,
    options: listDriveFolders(sessionToken),
    state: state,
    drafts: readDrafts_(),
    adminLog: readAdminLog_(),
    maintenance: getDriveMaintenanceSummary_(state)
  };
}

function saveDraft(sessionToken, payload) {
  const session = requireSession_(sessionToken);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const normalized = normalizePayload_(payload, readContentState_());
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


function normalizePayload_(payload, existingState) {
  if (!payload || typeof payload !== 'object') throw new Error('入力データが不正です。');
  const recruitCalendars = normalizeRecruitCalendars_(
    payload.recruitCalendars || (payload.recruitCalendar ? [payload.recruitCalendar] : []),
    existingState.recruitCalendars || []
  );
  const normalized = {
    recruitCalendars: recruitCalendars,
    recruitCalendar: getPublishedRecruitCalendar_(recruitCalendars),
    activityArticles: normalizeActivityArticles_(payload.activityArticles, existingState.activityArticles || []),
    exhibitions: normalizeExhibitions_(payload.exhibitions, existingState.exhibitions || []),
    requestCases: normalizeRequestCases_(payload.requestCases),
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

function normalizeActivityArticles_(items, existingItems) {
  const existingById = {};
  (existingItems || []).forEach((item) => existingById[item.articleId] = item);
  return (items || []).filter(Boolean).map((item, index) => {
    const articleId = String(item.articleId || '').trim() || 'activity-' + Utilities.getUuid().slice(0, 8);
    const existing = existingById[articleId];
    return {
      articleId: articleId,
      title: requireString_(item.title, '活動記事タイトル', 120),
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

function normalizeExhibitions_(items, existingItems) {
  const existingById = {};
  (existingItems || []).forEach((item) => existingById[item.exhibitionId] = item);
  return (items || []).filter(Boolean).map((item) => {
    const exhibitionId = String(item.exhibitionId || '').trim() || 'exhibition-' + Utilities.getUuid().slice(0, 8);
    const folderId = String(item.mediaFolderId || item.driveFolderId || '').trim();
    const dmFileIds = normalizeStringList_(item.dmFileIds || item.dm_file_ids).slice(0, 2);
    const works = normalizeExhibitionWorkFiles_(item.workFiles || item.works);
    const exhibitionLabel = String(item.title || '').trim() || '新規展示会';
    return {
      exhibitionId: exhibitionId,
      title: requireString_(item.title, '展示会名', 140),
      theme: cleanMultiline_(item.theme, 180),
      venueName: requireString_(item.venueName, '展示会「' + exhibitionLabel + '」の会場名（未定の場合は「未定」と入力してください）', 180),
      venueAddress: cleanMultiline_(item.venueAddress, 240),
      dateLine: requireString_(item.dateLine, '展示会「' + exhibitionLabel + '」の会期（未定の場合は「未定」と入力してください）', 180),
      timeLine: requireString_(item.timeLine, '展示会「' + exhibitionLabel + '」の時間帯（未定の場合は「未定」と入力してください）', 220),
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

function normalizeRequestCases_(items) {
  return (items || []).filter(Boolean).map((item, index) => ({
    caseId: String(item.caseId || '').trim() || 'request-' + Utilities.getUuid().slice(0, 8),
    title: requireString_(item.title, '事例タイトル', 120),
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
  writeSheet_(spreadsheet, CONTENT_SHEETS.recruit, [
    ['year', 'media_folder_id', 'media_file_ids', 'published', 'updated_at']
  ].concat((state.recruitCalendars || []).map((item) => [
    item.year, item.mediaFolderId, JSON.stringify(item.mediaFileIds || []), item.published ? 'TRUE' : 'FALSE', item.updatedAt || isoNow_()
  ])));

  writeSheet_(spreadsheet, CONTENT_SHEETS.activityArticles, [
    ['article_id', 'title', 'category', 'body', 'media_folder_id', 'media_file_ids', 'published', 'created_at', 'updated_at']
  ].concat(state.activityArticles.map((item) => [
    item.articleId, item.title, item.category, item.body, item.mediaFolderId, JSON.stringify(item.mediaFileIds || []), item.published ? 'TRUE' : 'FALSE', item.createdAt, item.updatedAt
  ])));

  writeSheet_(spreadsheet, CONTENT_SHEETS.exhibitions, [
    ['exhibition_id', 'title', 'theme', 'venue_name', 'venue_address', 'date_line', 'time_line', 'map_embed_url', 'display_bucket', 'media_folder_id', 'dm_file_ids', 'work_files', 'published', 'start_date', 'updated_at']
  ].concat(state.exhibitions.map((item) => [
    item.exhibitionId, item.title, item.theme, item.venueName, item.venueAddress, item.dateLine, item.timeLine, item.mapEmbedUrl,
    item.displayBucket, item.mediaFolderId, JSON.stringify(item.dmFileIds || []), JSON.stringify(serializeWorkFiles_(item.workFiles || item.works || [])), item.published ? 'TRUE' : 'FALSE', item.startDate, item.updatedAt
  ])));

  writeSheet_(spreadsheet, CONTENT_SHEETS.requestCases, [
    ['case_id', 'title', 'body', 'media_folder_id', 'media_file_ids', 'sort_order', 'published', 'updated_at']
  ].concat(state.requestCases.map((item) => [
    item.caseId, item.title, item.body, item.mediaFolderId, JSON.stringify(item.mediaFileIds || []), String(item.sortOrder), item.published ? 'TRUE' : 'FALSE', item.updatedAt
  ])));

  if (touchPublishState) {
    SpreadsheetApp.flush();
  }
}

function writeSheet_(spreadsheet, sheetName, values) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
  sheet.clearContents();
  sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
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
    payload: parseJson_(row.payload_json, {}),
    sha256: String(row.sha256 || ''),
    revision: Number(row.revision || 0)
  };
}

function writePublishedState_(payloadJson, sha256) {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const current = readPublishedState_();
  writeSheet_(spreadsheet, CONTENT_SHEETS.publishedState, [
    ['updated_at', 'revision', 'sha256', 'payload_json'],
    [isoNow_(), String(current.revision + 1), sha256, payloadJson]
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

function appendAdminLog_(actorName, actorEmail, action, detail) {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(CONTENT_SHEETS.adminLog) || spreadsheet.insertSheet(CONTENT_SHEETS.adminLog);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['timestamp', 'actor_name', 'actor_email', 'action', 'detail']);
  }
  sheet.appendRow([isoNow_(), actorName, actorEmail, action, detail]);
}

function saveDraftRecord_(state, actorName, actorEmail) {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(CONTENT_SHEETS.drafts) || spreadsheet.insertSheet(CONTENT_SHEETS.drafts);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['draft_id', 'saved_at', 'saved_by_name', 'saved_by_email', 'payload_json']);
  }
  sheet.insertRowAfter(1);
  sheet.getRange(2, 1, 1, 5).setValues([[Utilities.getUuid(), isoNow_(), actorName, actorEmail, stableStringify_(state)]]);
}

function readDrafts_() {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  return readSheetObjects_(spreadsheet, CONTENT_SHEETS.drafts).map((row) => ({
    draftId: row.draft_id,
    savedAt: row.saved_at,
    savedByName: row.saved_by_name,
    savedByEmail: row.saved_by_email,
    payload: parseJson_(row.payload_json, {})
  })).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

function clearDrafts_() {
  const spreadsheet = SpreadsheetApp.openById(getConfig_().CONTENT_SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(CONTENT_SHEETS.drafts);
  if (!sheet) return;
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(1, sheet.getLastColumn())).clearContent();
  }
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
      row[key] = values[i][j];
      if (String(values[i][j] || '') !== '') hasValue = true;
    }
    if (hasValue) rows.push(row);
  }
  return rows;
}

function serializeWorkFiles_(items) {
  return (items || []).filter(Boolean).map((work, index) => ({
    file_id: String(work.fileId || work.file_id || '').trim(),
    sort_order: Number(work.sortOrder || work.sort_order || index + 1),
    title: String(work.title || work.workTitle || '').trim(),
    artist: String(work.artist || work.artistName || '').trim()
  })).filter((work) => work.file_id);
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
    return { title: item.title, theme: item.theme, venueName: item.venueName, venueAddress: item.venueAddress, dateLine: item.dateLine, timeLine: item.timeLine, mapEmbedUrl: item.mapEmbedUrl, mediaFolderId: item.mediaFolderId, dmFileIds: item.dmFileIds, published: item.published, startDate: item.startDate, workFiles: item.workFiles };
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

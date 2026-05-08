function getBootstrapData(sessionToken) {
  const session = requireSession_(sessionToken);
  return {
    viewerEmail: session.email,
    viewerName: session.name || session.email,
    previewUrl: getConfig_().SITE_PREVIEW_URL,
    options: listDriveFolders(sessionToken),
    state: readContentState_(),
    drafts: readDrafts_(),
    adminLog: readAdminLog_()
  };
}

function saveDraft(sessionToken, payload) {
  const session = requireSession_(sessionToken);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const normalized = normalizePayload_(payload, readContentState_());
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
  return {
    recruitCalendar: readRecruitCalendar_(spreadsheet),
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
  const normalized = {
    recruitCalendar: normalizeRecruitCalendar_(payload.recruitCalendar),
    activityArticles: normalizeActivityArticles_(payload.activityArticles, existingState.activityArticles || []),
    exhibitions: normalizeExhibitions_(payload.exhibitions, existingState.exhibitions || []),
    requestCases: normalizeRequestCases_(payload.requestCases),
    changeLog: existingState.changeLog || [],
    manualChangeNote: cleanMultiline_(payload.manualChangeNote, 500)
  };
  validateBusinessRules_(normalized);
  return normalized;
}

function normalizeRecruitCalendar_(value) {
  const folderId = String((value && value.folderId) || '').trim();
  return {
    folderId: folderId,
    label: folderId ? String(value.label || '').trim() || '新歓イベントカレンダー' : ''
  };
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
      photoFolderId: String(item.photoFolderId || '').trim(),
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
    const folderId = requireString_(item.driveFolderId, '展示会フォルダ', 200);
    const works = (item.works || []).filter(Boolean).slice(0, 200).map((work, idx) => ({
      imageFileName: requireString_(work.imageFileName, '作品画像ファイル名', 200),
      workTitle: cleanMultiline_(work.workTitle, 140),
      artistName: cleanMultiline_(work.artistName, 120),
      sortOrder: idx + 1
    }));
    return {
      exhibitionId: exhibitionId,
      title: requireString_(item.title, '展示会名', 140),
      theme: cleanMultiline_(item.theme, 180),
      venueName: requireString_(item.venueName, '会場名', 180),
      venueAddress: cleanMultiline_(item.venueAddress, 240),
      dateLine: requireString_(item.dateLine, '会期', 180),
      timeLine: requireString_(item.timeLine, '時間帯', 220),
      mapEmbedUrl: String(item.mapEmbedUrl || '').trim(),
      displayBucket: requireDisplayBucket_(item.displayBucket),
      driveFolderId: folderId,
      published: item.published === false ? false : parseBool_(item.published, true),
      startDate: String(item.startDate || '').trim(),
      draftCreatedAt: String(item.draftCreatedAt || (existingById[exhibitionId] && existingById[exhibitionId].draftCreatedAt) || isoNow_()),
      updatedAt: isoNow_(),
      works: works
    };
  }).sort(compareExhibitions_);
}

function normalizeRequestCases_(items) {
  return (items || []).filter(Boolean).map((item, index) => ({
    caseId: String(item.caseId || '').trim() || 'request-' + Utilities.getUuid().slice(0, 8),
    title: requireString_(item.title, '事例タイトル', 120),
    body: cleanMultiline_(item.body, 4000),
    photoFolderId: String(item.photoFolderId || '').trim(),
    sortOrder: index + 1,
    published: item.published === false ? false : parseBool_(item.published, true),
    updatedAt: isoNow_()
  }));
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
  writeSheet_(spreadsheet, CONTENT_SHEETS.publishControl, [
    ['recruit_calendar_folder_id', 'recruit_calendar_label', 'updated_at'],
    [state.recruitCalendar.folderId, state.recruitCalendar.label, isoNow_()]
  ]);

  writeSheet_(spreadsheet, CONTENT_SHEETS.activityArticles, [
    ['article_id', 'title', 'category', 'body', 'photo_folder_id', 'published', 'created_at', 'updated_at']
  ].concat(state.activityArticles.map((item) => [
    item.articleId, item.title, item.category, item.body, item.photoFolderId, item.published ? 'TRUE' : 'FALSE', item.createdAt, item.updatedAt
  ])));

  writeSheet_(spreadsheet, CONTENT_SHEETS.exhibitions, [
    ['exhibition_id', 'title', 'theme', 'venue_name', 'venue_address', 'date_line', 'time_line', 'map_embed_url', 'display_bucket', 'drive_folder_id', 'published', 'start_date', 'updated_at']
  ].concat(state.exhibitions.map((item) => [
    item.exhibitionId, item.title, item.theme, item.venueName, item.venueAddress, item.dateLine, item.timeLine, item.mapEmbedUrl,
    item.displayBucket, item.driveFolderId, item.published ? 'TRUE' : 'FALSE', item.startDate, item.updatedAt
  ])));

  const workRows = [['exhibition_id', 'image_file_name', 'work_title', 'artist_name', 'sort_order']];
  state.exhibitions.forEach((item) => {
    (item.works || []).forEach((work) => {
      workRows.push([item.exhibitionId, work.imageFileName, work.workTitle, work.artistName, String(work.sortOrder)]);
    });
  });
  writeSheet_(spreadsheet, CONTENT_SHEETS.exhibitionWorks, workRows);

  writeSheet_(spreadsheet, CONTENT_SHEETS.requestCases, [
    ['case_id', 'title', 'body', 'photo_folder_id', 'sort_order', 'published', 'updated_at']
  ].concat(state.requestCases.map((item) => [
    item.caseId, item.title, item.body, item.photoFolderId, String(item.sortOrder), item.published ? 'TRUE' : 'FALSE', item.updatedAt
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

function readRecruitCalendar_(spreadsheet) {
  const rows = readSheetObjects_(spreadsheet, CONTENT_SHEETS.publishControl);
  const row = rows[0] || {};
  return {
    folderId: String(row.recruit_calendar_folder_id || ''),
    label: String(row.recruit_calendar_label || '')
  };
}

function readActivityArticles_(spreadsheet) {
  return readSheetObjects_(spreadsheet, CONTENT_SHEETS.activityArticles).map((row) => ({
    articleId: row.article_id,
    title: row.title,
    category: row.category || 'record',
    body: row.body,
    photoFolderId: row.photo_folder_id,
    published: parseBool_(row.published, true),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function readExhibitions_(spreadsheet) {
  const worksByExhibition = {};
  readSheetObjects_(spreadsheet, CONTENT_SHEETS.exhibitionWorks).forEach((row) => {
    const exId = String(row.exhibition_id || '');
    if (!exId) return;
    worksByExhibition[exId] = worksByExhibition[exId] || [];
    worksByExhibition[exId].push({
      imageFileName: row.image_file_name,
      workTitle: row.work_title,
      artistName: row.artist_name,
      sortOrder: Number(row.sort_order || 9999)
    });
  });

  return readSheetObjects_(spreadsheet, CONTENT_SHEETS.exhibitions).map((row) => ({
    exhibitionId: row.exhibition_id,
    title: row.title,
    theme: row.theme,
    venueName: row.venue_name,
    venueAddress: row.venue_address,
    dateLine: row.date_line,
    timeLine: row.time_line,
    mapEmbedUrl: row.map_embed_url,
    displayBucket: row.display_bucket,
    driveFolderId: row.drive_folder_id,
    published: parseBool_(row.published, true),
    startDate: row.start_date,
    works: (worksByExhibition[row.exhibition_id] || []).sort((a, b) => a.sortOrder - b.sortOrder)
  })).sort(compareExhibitions_);
}

function readRequestCases_(spreadsheet) {
  return readSheetObjects_(spreadsheet, CONTENT_SHEETS.requestCases)
    .map((row) => ({
      caseId: row.case_id,
      title: row.title,
      body: row.body,
      photoFolderId: row.photo_folder_id,
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

function buildPublicSnapshot_(state) {
  return {
    recruitCalendar: state.recruitCalendar,
    activityArticles: state.activityArticles.map((item) => ({
      articleId: item.articleId,
      title: item.title,
      body: item.body,
      category: item.category,
      photoFolderId: item.photoFolderId,
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
      driveFolderId: item.driveFolderId,
      published: item.published,
      startDate: item.startDate,
      works: item.works
    })),
    requestCases: state.requestCases.map((item) => ({
      caseId: item.caseId,
      title: item.title,
      body: item.body,
      category: item.category,
      photoFolderId: item.photoFolderId,
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
    return { title: item.title, body: item.body, category: item.category, photoFolderId: item.photoFolderId, createdAt: item.createdAt, published: item.published };
  });
  compareCollections(beforeSnapshot.requestCases || [], afterSnapshot.requestCases || [], 'caseId', '取り組み', function(item) {
    return { title: item.title, body: item.body, photoFolderId: item.photoFolderId, sortOrder: item.sortOrder, published: item.published };
  });
  compareCollections(beforeSnapshot.exhibitions || [], afterSnapshot.exhibitions || [], 'exhibitionId', '展示会', function(item) {
    return { title: item.title, theme: item.theme, venueName: item.venueName, venueAddress: item.venueAddress, dateLine: item.dateLine, timeLine: item.timeLine, mapEmbedUrl: item.mapEmbedUrl, driveFolderId: item.driveFolderId, published: item.published, startDate: item.startDate, works: item.works };
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
    recruitCalendarSelected: !!state.recruitCalendar.folderId
  };
}

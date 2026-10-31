// 保存する内容の形（版2）：整える・確かめる・保存する形にする

// 保存する内容の形（版2）。管理画面とサイトのビルドの約束なので、項目を変えるときは
// homepage の fetch_google_content.py と、両方の README も直す
const CONTENT_FORMAT_VERSION = 2;

const ACTIVITY_CATEGORIES = ['record', 'event', 'other'];
// 展示会の並び順もこの順（開催予定が先）
const DISPLAY_BUCKETS = ['upcoming', 'archive'];

const CONTENT_FIELDS = {
  recruitCalendars: ['year', 'mediaFolderId', 'mediaFileIds', 'published'],
  activityArticles: ['articleId', 'title', 'category', 'body', 'mediaFolderId', 'mediaFileIds', 'published', 'createdAt'],
  exhibitions: ['exhibitionId', 'title', 'subtitle', 'theme', 'venueName', 'venueAddress', 'dateLine', 'timeLine',
    'displayBucket', 'mediaFolderId', 'dmFileIds', 'works', 'published', 'startDate', 'endDate'],
  requestCases: ['caseId', 'title', 'body', 'mediaFolderId', 'mediaFileIds', 'published']
};

function contentLists_(content) {
  const lists = {};
  Object.keys(CONTENT_FIELDS).forEach((name) => lists[name] = (content && content[name]) || []);
  return lists;
}

function pickFields_(item, fields) {
  const out = {};
  fields.forEach((field) => out[field] = item[field]);
  return out;
}

// 保存されている内容の版を確かめる。版を上げるときは、ここで古い版を新しい版に直してから返す
function requireContentFormat_(content) {
  if (Object.keys(content).length && content.formatVersion !== CONTENT_FORMAT_VERSION) {
    throw new Error('保存データの形（formatVersion: ' + content.formatVersion + '）を読めません。管理画面が古いままになっていないか確認してください。');
  }
  return content;
}

function normalizePayload_(payload, existingState, options) {
  options = options || {};
  if (!payload || typeof payload !== 'object') throw new Error('入力データが不正です。');
  return {
    recruitCalendars: normalizeRecruitCalendars_(payload.recruitCalendars),
    activityArticles: normalizeActivityArticles_(payload.activityArticles, existingState.activityArticles || [], options),
    exhibitions: normalizeExhibitions_(payload.exhibitions, existingState.exhibitions || [], options),
    requestCases: normalizeRequestCases_(payload.requestCases, options),
    changeLog: existingState.changeLog || [],
    manualChangeNote: cleanMultiline_(payload.manualChangeNote, 500)
  };
}

function normalizeRecruitCalendars_(items) {
  const calendars = (items || []).filter(Boolean).map((item) => ({
    year: String(item.year || '').replace(/[^\d]/g, '').slice(0, 4),
    mediaFolderId: String(item.mediaFolderId || '').trim(),
    mediaFileIds: normalizeStringList_(item.mediaFileIds),
    published: parseBool_(item.published, true)
  })).filter((item) => item.year || item.mediaFolderId || item.mediaFileIds.length);
  if (!calendars.length) {
    calendars.push({ year: String(new Date().getFullYear()), mediaFolderId: '', mediaFileIds: [], published: true });
  }
  // 公開するのは1年度だけ
  let publishedSeen = false;
  calendars.forEach((item) => {
    item.published = item.published && !publishedSeen;
    publishedSeen = publishedSeen || item.published;
  });
  if (!publishedSeen) calendars[0].published = true;
  return calendars.sort((a, b) => String(b.year).localeCompare(String(a.year)));
}

function publishedRecruitCalendar_(calendars) {
  return (calendars || []).find((item) => item.published === true) || null;
}

function recruitCalendarLabel_(year) {
  return year ? year + '年度 新歓イベントカレンダー' : '新歓イベントカレンダー';
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
      category: requireOneOf_(item.category || 'record', ACTIVITY_CATEGORIES, '活動記事のカテゴリが不正です。'),
      mediaFolderId: String(item.mediaFolderId || '').trim(),
      mediaFileIds: normalizeStringList_(item.mediaFileIds),
      published: parseBool_(item.published, true),
      createdAt: existing ? existing.createdAt : isoNow_()
    };
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function normalizeExhibitions_(items, existingItems, options) {
  const existingById = {};
  (existingItems || []).forEach((item) => existingById[item.exhibitionId] = item);
  return (items || []).filter(Boolean).map((item) => {
    const exhibitionId = String(item.exhibitionId || '').trim() || 'exhibition-' + Utilities.getUuid().slice(0, 8);
    return {
      exhibitionId: exhibitionId,
      title: requiredOrDraft_(item.title, '展示会名', 140, options),
      subtitle: optionalSingleLine_(item.subtitle, 140),
      /* 概要は数行の文章になることが多いので、記事の本文ほどではないが長めに受け付ける */
      theme: cleanMultiline_(item.theme, 1000),
      venueName: optionalSingleLine_(item.venueName, 180),
      venueAddress: cleanMultiline_(item.venueAddress, 240),
      dateLine: optionalSingleLine_(item.dateLine, 180),
      timeLine: optionalSingleLine_(item.timeLine, 220),
      displayBucket: requireOneOf_(item.displayBucket, DISPLAY_BUCKETS, '展示会の表示区分が不正です。'),
      mediaFolderId: String(item.mediaFolderId || '').trim(),
      dmFileIds: normalizeStringList_(item.dmFileIds).slice(0, 2),
      published: parseBool_(item.published, true),
      startDate: String(item.startDate || '').trim(),
      endDate: normalizeIsoDate_(item.endDate),
      // 日付のない下書きを並べるためだけに使う。公開する内容には含めない
      draftCreatedAt: String(item.draftCreatedAt || (existingById[exhibitionId] && existingById[exhibitionId].draftCreatedAt) || isoNow_()),
      works: normalizeWorks_(item.works)
    };
  }).sort(compareExhibitions_);
}

function normalizeWorks_(items) {
  return (items || []).filter(Boolean).slice(0, 200).map((work) => ({
    fileId: String(work.fileId || '').trim(),
    title: cleanMultiline_(work.title, 140),
    artist: cleanMultiline_(work.artist, 120)
  })).filter((work) => work.fileId);
}

function normalizeRequestCases_(items, options) {
  return (items || []).filter(Boolean).map((item) => ({
    caseId: String(item.caseId || '').trim() || 'request-' + Utilities.getUuid().slice(0, 8),
    title: requiredOrDraft_(item.title, '事例タイトル', 120, options),
    body: cleanMultiline_(item.body, 4000),
    mediaFolderId: String(item.mediaFolderId || '').trim(),
    mediaFileIds: normalizeStringList_(item.mediaFileIds),
    published: parseBool_(item.published, true)
  }));
}

function compareExhibitions_(a, b) {
  const bucketA = DISPLAY_BUCKETS.indexOf(a.displayBucket);
  const bucketB = DISPLAY_BUCKETS.indexOf(b.displayBucket);
  if (bucketA !== bucketB) return bucketA - bucketB;

  const hasDateA = !!String(a.startDate || '').trim();
  const hasDateB = !!String(b.startDate || '').trim();
  if (!hasDateA && !hasDateB) return String(b.draftCreatedAt || '').localeCompare(String(a.draftCreatedAt || ''));
  if (!hasDateA) return -1;
  if (!hasDateB) return 1;

  if (a.displayBucket === 'upcoming') return String(a.startDate || '').localeCompare(String(b.startDate || ''));
  return String(b.startDate || '').localeCompare(String(a.startDate || ''));
}

function normalizeIsoDate_(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function optionalSingleLine_(value, maxLength) {
  return cleanMultiline_(value, maxLength).replace(/\n+/g, ' ').trim();
}

function requiredOrDraft_(value, label, maxLength, options) {
  if (options && options.allowIncomplete) return optionalSingleLine_(value, maxLength);
  return requireString_(value, label, maxLength);
}

function parseBool_(value, fallback) {
  if (value === true || value === false) return value;
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (!normalized) return !!fallback;
  return ['1', 'true', 'yes', 'on', 'y'].indexOf(normalized) !== -1;
}

function buildPublicSnapshot_(state) {
  const snapshot = { formatVersion: CONTENT_FORMAT_VERSION };
  Object.keys(CONTENT_FIELDS).forEach((name) => {
    snapshot[name] = (state[name] || []).map((item) => pickFields_(item, CONTENT_FIELDS[name]));
  });
  return snapshot;
}

// 下書きは公開する内容に、編集中だけ使う値（展示会の draftCreatedAt と更新履歴メモ）を足したもの
function buildDraftPayload_(state) {
  const draft = buildPublicSnapshot_(state);
  draft.exhibitions.forEach((item, index) => item.draftCreatedAt = state.exhibitions[index].draftCreatedAt || '');
  draft.manualChangeNote = state.manualChangeNote || '';
  return draft;
}

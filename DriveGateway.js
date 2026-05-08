function listDriveFolders(sessionToken) {
  requireSession_(sessionToken);
  const config = getConfig_();
  return {
    recruitCalendars: listChildFolders_(config.ROOT_RECRUIT_FOLDER_ID),
    activityPhotoFolders: listChildFolders_(config.ROOT_ACTIVITY_FOLDER_ID),
    exhibitionFolders: listChildFolders_(config.ROOT_EXHIBITION_FOLDER_ID),
    requestPhotoFolders: listChildFolders_(config.ROOT_REQUEST_FOLDER_ID),
    roots: getRootFolderSummary_()
  };
}

function getFolderImages(sessionToken, folderId) {
  requireSession_(sessionToken);
  return getFolderMedia_(folderId).filter((file) => file.kind === 'image');
}

function getFolderMedia(sessionToken, folderId) {
  requireSession_(sessionToken);
  return getFolderMedia_(folderId);
}

function uploadManagedFiles(sessionToken, request) {
  requireSession_(sessionToken);
  if (!request || typeof request !== 'object') throw new Error('アップロード情報が不正です。');

  const files = Array.isArray(request.files) ? request.files : [];
  if (!files.length) throw new Error('アップロードするファイルを選択してください。');

  const kind = requireManagedKind_(request.kind);
  const role = String(request.role || 'image').trim().toLowerCase();
  const folder = ensureManagedFolder_(kind, request.folderId, request.title, request.draft !== false);

  files.forEach((file) => {
    const originalName = requireString_(file && file.name, 'ファイル名', 180);
    const mimeType = String((file && file.mimeType) || '').trim() || 'application/octet-stream';
    const base64 = String((file && file.data) || '').trim();
    if (!base64) throw new Error(originalName + ' のデータが空です。');
    validateUploadMime_(kind, role, mimeType, originalName);
    const bytes = Utilities.base64Decode(base64);
    const name = buildUploadFileName_(folder, kind, role, originalName, mimeType);
    retryDriveOperation_(
      () => folder.createFile(Utilities.newBlob(bytes, mimeType, name)),
      'ファイルアップロード'
    );
  });

  if (kind === 'exhibition') {
    applyExhibitionFolderSharing_(folder);
  }

  return buildFolderMediaResponse_(folder);
}

function renameManagedFile(sessionToken, request) {
  requireSession_(sessionToken);
  if (!request || typeof request !== 'object') throw new Error('名前変更情報が不正です。');

  const folderId = String(request.folderId || '').trim();
  const fileId = requireString_(request.fileId, 'ファイルID', 200);
  const file = retryDriveOperation_(() => DriveApp.getFileById(fileId), 'ファイル取得');
  const folder = folderId ? getDriveFolderWithRetry_(folderId, '画像フォルダ取得') : null;
  const newName = buildRenameFileName_(folder, file, request.name);

  retryDriveOperation_(() => file.setName(newName), 'ファイル名変更');

  if (folder) return buildFolderMediaResponse_(folder);
  return { folderId: folderId, files: [] };
}

function trashManagedFile(sessionToken, request) {
  requireSession_(sessionToken);
  if (!request || typeof request !== 'object') throw new Error('削除情報が不正です。');

  const folderId = String(request.folderId || '').trim();
  const fileId = requireString_(request.fileId, 'ファイルID', 200);
  const file = retryDriveOperation_(() => DriveApp.getFileById(fileId), 'ファイル取得');
  retryDriveOperation_(() => file.setTrashed(true), 'ファイル削除');

  if (!folderId) return { folderId: '', folderUrl: '', files: [], folderTrashed: false };

  if (trashFolderIfEmpty_(folderId)) {
    return { folderId: '', folderUrl: '', files: [], folderTrashed: true };
  }
  return buildFolderMediaResponse_(getDriveFolderWithRetry_(folderId, '画像フォルダ取得'));
}

function getDriveMaintenanceSummary_(state) {
  return {
    storage: getDriveStorageSummary_(),
    recommendations: buildStorageRecommendations_(state || {})
  };
}

function finalizeManagedFolders_(state) {
  renameFolderIfPresent_(state.recruitCalendar && state.recruitCalendar.folderId, state.recruitCalendar && state.recruitCalendar.label, false);

  (state.activityArticles || []).forEach((item) => {
    renameFolderIfPresent_(item.photoFolderId, item.title, false);
  });

  (state.requestCases || []).forEach((item) => {
    renameFolderIfPresent_(item.photoFolderId, item.title, false);
  });

  (state.exhibitions || []).forEach((item) => {
    const folder = renameFolderIfPresent_(item.driveFolderId, item.title, false);
    if (folder) applyExhibitionFolderSharing_(folder);
  });
}

function cleanupUnreferencedDraftFolders_(state) {
  const referenced = buildReferencedFolderIdSet_(state || {});
  const config = getConfig_();
  [
    config.ROOT_RECRUIT_FOLDER_ID,
    config.ROOT_ACTIVITY_FOLDER_ID,
    config.ROOT_EXHIBITION_FOLDER_ID,
    config.ROOT_REQUEST_FOLDER_ID
  ].forEach((rootId) => {
    const root = getDriveFolderWithRetry_(rootId, '下書きフォルダ親取得');
    const folders = retryDriveOperation_(() => root.getFolders(), '下書きフォルダ一覧取得');
    while (folders.hasNext()) {
      const folder = folders.next();
      const folderId = retryDriveOperation_(() => folder.getId(), '下書きフォルダID取得');
      const name = retryDriveOperation_(() => folder.getName(), '下書きフォルダ名取得');
      if (String(name || '').indexOf('_下書き_') === -1) continue;
      if (referenced[folderId]) continue;
      retryDriveOperation_(() => folder.setTrashed(true), '未参照下書きフォルダ削除');
    }
  });
}

function buildReferencedFolderIdSet_(state) {
  const ids = {};
  function add(id) {
    const value = String(id || '').trim();
    if (value) ids[value] = true;
  }
  add(state.recruitCalendar && state.recruitCalendar.folderId);
  (state.activityArticles || []).forEach((item) => add(item.photoFolderId));
  (state.exhibitions || []).forEach((item) => add(item.driveFolderId));
  (state.requestCases || []).forEach((item) => add(item.photoFolderId));
  return ids;
}

function getFolderMedia_(folderId) {
  if (!folderId) return [];

  const folder = getDriveFolderWithRetry_(folderId, '素材フォルダ取得');
  const iterator = retryDriveOperation_(
    () => folder.getFiles(),
    'Drive素材一覧取得'
  );

  const files = [];

  while (iterator.hasNext()) {
    const file = iterator.next();
    const mimeType = retryDriveOperation_(() => file.getMimeType(), '素材mimeType取得');
    const kind = mediaKindFromMime_(mimeType);
    if (!kind) continue;
    const id = retryDriveOperation_(() => file.getId(), '素材ID取得');
    const name = retryDriveOperation_(() => file.getName(), '素材名取得');
    const size = retryDriveOperation_(() => file.getSize(), '素材サイズ取得');
    files.push({
      id,
      name,
      mimeType,
      kind,
      size,
      url: retryDriveOperation_(() => file.getUrl(), '素材URL取得'),
      thumbnailUrl: kind === 'image' ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1000' : ''
    });
  }

  files.sort((a, b) => compareNamesNatural_(a.name, b.name));
  return files;
}

function buildFolderMediaResponse_(folder) {
  const folderId = retryDriveOperation_(() => folder.getId(), '素材フォルダID取得');
  return {
    folderId,
    folderName: retryDriveOperation_(() => folder.getName(), '素材フォルダ名取得'),
    folderUrl: retryDriveOperation_(() => folder.getUrl(), '素材フォルダURL取得'),
    files: getFolderMedia_(folderId)
  };
}

function ensureManagedFolder_(kind, folderId, title, draft) {
  const existingId = String(folderId || '').trim();
  if (existingId) {
    const folder = getDriveFolderWithRetry_(existingId, '素材フォルダ取得');
    if (kind === 'exhibition') applyExhibitionFolderSharing_(folder);
    return folder;
  }

  const root = getDriveFolderWithRetry_(rootFolderIdForKind_(kind), '素材親フォルダ取得');
  const folderName = buildManagedFolderName_(title, draft !== false);
  const folder = retryDriveOperation_(() => root.createFolder(folderName), '素材フォルダ作成');
  if (kind === 'exhibition') applyExhibitionFolderSharing_(folder);
  return folder;
}

function renameFolderIfPresent_(folderId, title, draft) {
  const value = String(folderId || '').trim();
  if (!value) return null;
  const folder = getDriveFolderWithRetry_(value, '素材フォルダ取得');
  const currentName = retryDriveOperation_(() => folder.getName(), '素材フォルダ名取得');
  const nextName = buildManagedFolderName_(title, !!draft, currentName);
  if (currentName !== nextName) {
    retryDriveOperation_(() => folder.setName(nextName), '素材フォルダ名変更');
  }
  return folder;
}

function rootFolderIdForKind_(kind) {
  const config = getConfig_();
  const map = {
    recruit: config.ROOT_RECRUIT_FOLDER_ID,
    activity: config.ROOT_ACTIVITY_FOLDER_ID,
    exhibition: config.ROOT_EXHIBITION_FOLDER_ID,
    request: config.ROOT_REQUEST_FOLDER_ID
  };
  return map[requireManagedKind_(kind)];
}

function requireManagedKind_(kind) {
  const value = String(kind || '').trim().toLowerCase();
  if (['recruit', 'activity', 'exhibition', 'request'].indexOf(value) === -1) {
    throw new Error('素材種別が不正です。');
  }
  return value;
}

function mediaKindFromMime_(mimeType) {
  const value = String(mimeType || '');
  if (value.indexOf('image/') === 0) return 'image';
  if (value === 'application/pdf') return 'pdf';
  return '';
}

function validateUploadMime_(kind, role, mimeType, name) {
  const mediaKind = mediaKindFromMime_(mimeType);
  if (kind !== 'exhibition' && mediaKind !== 'image') {
    throw new Error(name + ' は画像ファイルではありません。');
  }
  if (kind === 'exhibition' && role === 'catalog' && mediaKind !== 'pdf') {
    throw new Error(name + ' はPDF目録としてアップロードできません。');
  }
  if (kind === 'exhibition' && role !== 'catalog' && mediaKind !== 'image') {
    throw new Error(name + ' は画像ファイルではありません。');
  }
}

function buildUploadFileName_(folder, kind, role, originalName, mimeType) {
  const ext = extensionFromNameOrMime_(originalName, mimeType);
  if (kind === 'exhibition' && role === 'dm') {
    return nextDmFileName_(folder, ext);
  }
  return uniqueFileName_(folder, safeFileName_(originalName));
}

function nextDmFileName_(folder, ext) {
  const names = getExistingFileNameSet_(folder);
  for (let i = 1; i <= 2; i += 1) {
    const name = 'DM' + i + ext;
    if (!names[name.toLowerCase()]) return name;
  }
  throw new Error('DM画像は2枚までです。既存のDM画像を削除してから追加してください。');
}

function buildRenameFileName_(folder, file, requestedName) {
  const currentName = retryDriveOperation_(() => file.getName(), 'ファイル名取得');
  let nextName = safeFileName_(requestedName);
  if (nextName.indexOf('.') === -1 && currentName.indexOf('.') !== -1) {
    nextName += currentName.slice(currentName.lastIndexOf('.'));
  }
  return folder ? uniqueFileName_(folder, nextName, retryDriveOperation_(() => file.getId(), 'ファイルID取得')) : nextName;
}

function uniqueFileName_(folder, name, ignoreFileId) {
  const safe = safeFileName_(name);
  const names = getExistingFileNameSet_(folder, ignoreFileId);
  if (!names[safe.toLowerCase()]) return safe;

  const dot = safe.lastIndexOf('.');
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  for (let i = 2; i < 1000; i += 1) {
    const candidate = base + '-' + i + ext;
    if (!names[candidate.toLowerCase()]) return candidate;
  }
  throw new Error('同名ファイルが多すぎます。別の名前にしてください。');
}

function getExistingFileNameSet_(folder, ignoreFileId) {
  const names = {};
  const iterator = retryDriveOperation_(() => folder.getFiles(), '既存ファイル一覧取得');
  while (iterator.hasNext()) {
    const file = iterator.next();
    const id = retryDriveOperation_(() => file.getId(), '既存ファイルID取得');
    if (ignoreFileId && id === ignoreFileId) continue;
    const name = retryDriveOperation_(() => file.getName(), '既存ファイル名取得');
    names[String(name || '').toLowerCase()] = true;
  }
  return names;
}

function safeFileName_(name) {
  const value = String(name || '').trim()
    .replace(/[\\/:*?"<>|#%{}~&]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 180)
    .trim();
  if (!value || value === '.' || value === '..') throw new Error('ファイル名が不正です。');
  return value;
}

function extensionFromNameOrMime_(name, mimeType) {
  const cleaned = safeFileName_(name);
  const dot = cleaned.lastIndexOf('.');
  if (dot > 0 && dot < cleaned.length - 1) return cleaned.slice(dot);
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf'
  };
  return map[String(mimeType || '').toLowerCase()] || '';
}

function buildManagedFolderName_(title, draft, existingName) {
  const base = sanitizeFolderTitle_(title || '素材');
  const tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  if (draft) {
    return base + '_下書き_' + Utilities.formatDate(new Date(), tz, 'yyyyMMdd_HHmm');
  }
  const existingDate = String(existingName || '').match(/_(\d{8})(?:$|[^0-9])/);
  const datePart = existingDate ? existingDate[1] : Utilities.formatDate(new Date(), tz, 'yyyyMMdd');
  return base + '_' + datePart;
}

function sanitizeFolderTitle_(title) {
  const normalized = String(title || '').trim()
    .replace(/_/g, '-')
    .replace(/[\\/:*?"<>|#%{}~&]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
  return normalized || '素材';
}

function applyExhibitionFolderSharing_(folder) {
  retryDriveOperation_(
    () => folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW),
    '展示会フォルダ公開設定'
  );
}

function trashFolderIfEmpty_(folderId) {
  const folder = getDriveFolderWithRetry_(folderId, '素材フォルダ取得');
  const files = retryDriveOperation_(() => folder.getFiles(), '素材フォルダ空チェック');
  if (files.hasNext()) return false;
  retryDriveOperation_(() => folder.setTrashed(true), '空フォルダ削除');
  return true;
}

function getDriveStorageSummary_() {
  let used = 0;
  let limit = 0;
  try {
    used = Number(DriveApp.getStorageUsed() || 0);
    limit = Number(DriveApp.getStorageLimit() || 0);
  } catch (error) {
    return {
      available: false,
      message: error && error.message ? error.message : String(error)
    };
  }
  if (limit <= 0) {
    return {
      available: false,
      message: 'Drive容量の上限を取得できませんでした。'
    };
  }

  const remaining = Math.max(0, limit - used);
  const usageRatio = limit > 0 ? used / limit : 0;
  let level = 'ok';
  if (remaining < 2 * 1024 * 1024 * 1024 || usageRatio >= 0.95) level = 'danger';
  else if (remaining < 3 * 1024 * 1024 * 1024 || usageRatio >= 0.90) level = 'warning';
  else if (remaining < 5 * 1024 * 1024 * 1024 || usageRatio >= 0.80) level = 'notice';

  return {
    available: true,
    used,
    limit,
    remaining,
    usageRatio,
    level
  };
}

function buildStorageRecommendations_(state) {
  const items = [];
  function push(kind, label, title, dateValue, folderId, published) {
    if (!folderId) return;
    items.push({
      kind,
      label,
      title: title || '(タイトル未入力)',
      date: String(dateValue || ''),
      folderId,
      folderUrl: folderUrlSafe_(folderId),
      published: published !== false
    });
  }

  (state.exhibitions || []).forEach((item) => push('exhibition', '展示会', item.title, item.startDate, item.driveFolderId, item.published));
  (state.activityArticles || []).forEach((item) => push('activity', '活動記録・告知', item.title, item.createdAt, item.photoFolderId, item.published));
  (state.requestCases || []).forEach((item) => push('request', '取り組み事例', item.title, item.updatedAt, item.photoFolderId, item.published));

  items.sort((a, b) => {
    return String(a.date || '9999').localeCompare(String(b.date || '9999'));
  });
  return items.slice(0, 10);
}

function folderUrlSafe_(folderId) {
  try {
    return getDriveFolderWithRetry_(folderId, '候補フォルダ取得').getUrl();
  } catch (error) {
    return 'https://drive.google.com/drive/folders/' + encodeURIComponent(folderId);
  }
}

function getFolderSummary_(folderId) {
  const folder = getDriveFolderWithRetry_(folderId, '素材親フォルダ取得');
  return {
    id: folderId,
    name: retryDriveOperation_(() => folder.getName(), '素材親フォルダ名取得'),
    url: retryDriveOperation_(() => folder.getUrl(), '素材親フォルダURL取得')
  };
}

function getRootFolderSummary_() {
  const config = getConfig_();
  return {
    recruit: getFolderSummary_(config.ROOT_RECRUIT_FOLDER_ID),
    activity: getFolderSummary_(config.ROOT_ACTIVITY_FOLDER_ID),
    exhibition: getFolderSummary_(config.ROOT_EXHIBITION_FOLDER_ID),
    request: getFolderSummary_(config.ROOT_REQUEST_FOLDER_ID)
  };
}

function listChildFolders_(rootId) {
  const folder = getDriveFolderWithRetry_(rootId, 'Drive親フォルダ取得');
  const iterator = retryDriveOperation_(
    () => folder.getFolders(),
    'Drive子フォルダ一覧取得'
  );

  const folders = [];

  while (iterator.hasNext()) {
    const child = iterator.next();
    folders.push({
      id: retryDriveOperation_(() => child.getId(), '子フォルダID取得'),
      name: retryDriveOperation_(() => child.getName(), '子フォルダ名取得'),
      url: retryDriveOperation_(() => child.getUrl(), '子フォルダURL取得')
    });
  }

  folders.sort((a, b) => compareNamesNatural_(a.name, b.name));
  return folders;
}

function getDriveFolderWithRetry_(folderId, label) {
  return retryDriveOperation_(
    () => DriveApp.getFolderById(String(folderId || '').trim()),
    label
  );
}

function retryDriveOperation_(operation, label) {
  let lastError;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      Utilities.sleep(400 * Math.pow(2, attempt));
    }
  }

  throw new Error(label + 'に失敗しました: ' + (lastError && lastError.message ? lastError.message : lastError));
}

function compareNamesNatural_(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'ja', {
    numeric: true,
    sensitivity: 'base'
  });
}

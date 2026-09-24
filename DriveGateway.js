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
  const uploads = files.map((file) => {
    const originalName = requireString_(file && file.name, 'ファイル名', 180);
    const mimeType = String((file && file.mimeType) || '').trim() || 'application/octet-stream';
    const base64 = String((file && file.data) || '').trim();
    if (!base64) throw new Error(originalName + ' のデータが空です。');
    validateUploadMime_(kind, role, mimeType, originalName);
    return { originalName, mimeType, bytes: Utilities.base64Decode(base64) };
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const folder = ensureManagedFolder_(kind, request.folderId, request.title, request.draft !== false);
    if (kind === 'exhibition') requireExhibitionMediaFolder_(folder);
    const destination = kind === 'exhibition'
      ? getExhibitionAuxFolder_(folder.getId(), 'staging', true)
      : folder;
    const uploadedFileIds = uploads.map((upload) => {
      const name = buildUploadFileName_(destination, kind, role, upload.originalName, upload.mimeType);
      const file = retryDriveOperation_(
        () => destination.createFile(Utilities.newBlob(upload.bytes, upload.mimeType, name)),
        'ファイルアップロード'
      );
      return file.getId();
    });
    return Object.assign(buildFolderMediaResponse_(folder), { uploadedFileIds });
  } finally {
    lock.releaseLock();
  }
}

function renameManagedFile(sessionToken, request) {
  requireSession_(sessionToken);
  if (!request || typeof request !== 'object') throw new Error('名前変更情報が不正です。');

  const folderId = String(request.folderId || '').trim();
  const fileId = requireString_(request.fileId, 'ファイルID', 200);
  const file = retryDriveOperation_(() => DriveApp.getFileById(fileId), 'ファイル取得');
  const folder = folderId ? getDriveFolderWithRetry_(folderId, '画像フォルダ取得') : null;
  if (folder && isExhibitionMediaFolder_(folder)) {
    throw new Error('展示会のファイル名は、公開時に作品情報から自動設定されます。');
  }
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
  const folder = folderId ? getDriveFolderWithRetry_(folderId, '画像フォルダ取得') : null;
  if (folder && isExhibitionMediaFolder_(folder)) {
    // Keep files for the published site and other saved drafts until publication.
    const result = buildFolderMediaResponse_(folder);
    result.files = result.files.filter((file) => file.id !== fileId);
    result.deferred = true;
    return result;
  }
  const file = retryDriveOperation_(() => DriveApp.getFileById(fileId), 'ファイル取得');
  retryDriveOperation_(() => file.setTrashed(true), 'ファイル削除');

  if (!folderId) return { folderId: '', folderUrl: '', files: [], folderTrashed: false };

  if (trashFolderIfEmpty_(folderId)) {
    return { folderId: '', folderUrl: '', files: [], folderTrashed: true };
  }
  return buildFolderMediaResponse_(getDriveFolderWithRetry_(folderId, '画像フォルダ取得'));
}

function saveMediaSettings(sessionToken, request) {
  requireSession_(sessionToken);
  if (!request || typeof request !== 'object') throw new Error('画像設定が不正です。');

  requireManagedKind_(request.kind);
  const folderId = String(request.folderId || '').trim();
  if (!folderId) return { folderId: '', files: [] };

  const folder = getDriveFolderWithRetry_(folderId, '画像フォルダ取得');
  return buildFolderMediaResponse_(folder);
}

function getDriveMaintenanceSummary_(state) {
  const storage = getDriveStorageSummary_();
  if (!storage.available || storage.level === 'ok') {
    return {
      storage,
      recommendations: []
    };
  }
  const plan = buildStorageRecommendations_(state || {}, storage);
  storage.recommendationBytes = plan.totalBytes;
  storage.projectedRemaining = plan.projectedRemaining;
  storage.recommendationSufficient = plan.sufficient;
  return {
    storage,
    recommendations: plan.items
  };
}

function finalizeManagedFolders_(state) {
  // Validate every exhibition before moving any files.
  const exhibitionPlans = buildExhibitionMediaPlans_(state);
  const emptyExhibitionFolders = [];
  (state.recruitCalendars || []).forEach((item) => {
    renameFolderIfPresent_(item.mediaFolderId || item.folderId, item.label, false);
  });

  (state.activityArticles || []).forEach((item) => {
    renameFolderIfPresent_(item.mediaFolderId || item.photoFolderId, item.title, false);
  });

  (state.requestCases || []).forEach((item) => {
    renameFolderIfPresent_(item.mediaFolderId || item.photoFolderId, item.title, false);
  });

  exhibitionPlans.forEach((plan) => {
    const item = plan.item;
    reconcileExhibitionMedia_(plan);
    if (!plan.keepIds.size) {
      applyPrivateFolderSharing_(plan.folder);
      if (!plan.folder.getFiles().hasNext() && !plan.folder.getFolders().hasNext()) {
        emptyExhibitionFolders.push(plan.folder.getId());
        item.mediaFolderId = '';
        item.driveFolderId = '';
      }
      return;
    }
    const folder = renameFolderIfPresent_(item.mediaFolderId || item.driveFolderId, item.title, false);
    if (folder) {
      renameExhibitionMediaFiles_(folder, item.dmFileIds || [], item.workFiles || item.works || []);
      if (item.published === false) {
        applyPrivateFolderSharing_(folder);
      } else {
        applyExhibitionFolderSharing_(folder);
      }
    }
  });
  return emptyExhibitionFolders;
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
  (state.recruitCalendars || []).forEach((item) => add(item.mediaFolderId || item.folderId));
  add(state.recruitCalendar && (state.recruitCalendar.mediaFolderId || state.recruitCalendar.folderId));
  (state.activityArticles || []).forEach((item) => add(item.mediaFolderId || item.photoFolderId));
  (state.exhibitions || []).forEach((item) => add(item.mediaFolderId || item.driveFolderId));
  (state.requestCases || []).forEach((item) => add(item.mediaFolderId || item.photoFolderId));
  return ids;
}

function getFolderMedia_(folderId) {
  if (!folderId) return [];

  const folder = getDriveFolderWithRetry_(folderId, '素材フォルダ取得');
  const files = [];
  const sources = [folder];
  if (isExhibitionMediaFolder_(folder)) {
    ['staging', 'recovery'].forEach((type) => {
      const auxiliary = getExhibitionAuxFolder_(folderId, type, false);
      if (auxiliary) sources.push(auxiliary);
    });
  }
  sources.forEach((source) => listFolderFiles_(source).forEach((file) => {
    const mimeType = retryDriveOperation_(() => file.getMimeType(), '素材mimeType取得');
    const kind = mediaKindFromMime_(mimeType);
    if (!kind) return;
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
  }));

  files.sort((a, b) => compareNamesNatural_(a.name, b.name));
  return files;
}

function listFolderFiles_(folder) {
  const iterator = retryDriveOperation_(() => folder.getFiles(), 'Drive素材一覧取得');
  const files = [];
  while (iterator.hasNext()) files.push(iterator.next());
  return files;
}

function isExhibitionMediaFolder_(folder) {
  if (/^CMS_(下書き|未登録)_/.test(folder.getName())) return false;
  const rootId = getConfig_().ROOT_EXHIBITION_FOLDER_ID;
  const parents = folder.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === rootId) return true;
  }
  return false;
}

function requireExhibitionMediaFolder_(folder) {
  if (folder.isTrashed() || !isExhibitionMediaFolder_(folder)) {
    throw new Error('展示会の素材フォルダが見つかりません。最新のデータを読み込んでください。');
  }
}

function getExhibitionAuxFolder_(folderId, type, create) {
  const root = getDriveFolderWithRetry_(getConfig_().ROOT_EXHIBITION_FOLDER_ID, '展示会素材親フォルダ取得');
  const name = 'CMS_' + (type === 'staging' ? '下書き' : '未登録') + '_' + folderId;
  const folders = root.getFoldersByName(name);
  const folder = folders.hasNext() ? folders.next() : null;
  if (!create) return folder;
  if (root.getSharingAccess() !== DriveApp.Access.PRIVATE) {
    throw new Error('下書き画像を非公開で保管するため、展示会の親フォルダの共有設定を「制限付き」にしてください。');
  }
  const result = folder || root.createFolder(name);
  applyPrivateFolderSharing_(result);
  return result;
}

function exhibitionMediaIds_(item) {
  return (item.dmFileIds || []).concat((item.workFiles || item.works || [])
    .map((work) => work.fileId || work.file_id)).map((id) => String(id || '').trim()).filter(Boolean);
}

function buildExhibitionMediaPlans_(state) {
  const seenFolders = new Set();
  return (state.exhibitions || []).map((item) => {
    const folderId = item.mediaFolderId || item.driveFolderId;
    const keepIds = new Set(exhibitionMediaIds_(item));
    if (!folderId && !keepIds.size) return null;
    if (!folderId || seenFolders.has(folderId)) {
      throw new Error('展示会「' + item.title + '」の素材フォルダが未設定、または他の展示会と重複しています。');
    }
    seenFolders.add(folderId);
    const folder = getDriveFolderWithRetry_(folderId, '展示会素材フォルダ取得');
    requireExhibitionMediaFolder_(folder);
    const staging = getExhibitionAuxFolder_(folderId, 'staging', false);
    const recovery = getExhibitionAuxFolder_(folderId, 'recovery', false);
    const entries = [folder, staging, recovery].filter(Boolean).flatMap((source) =>
      listFolderFiles_(source).map((file) => ({ file, source })));
    const available = new Set(entries.map((entry) => entry.file.getId()));
    keepIds.forEach((id) => {
      if (!available.has(id)) {
        throw new Error('展示会「' + item.title + '」の登録画像が見つかりません: ' + id);
      }
    });
    return { item, folder, staging, recovery, entries, keepIds };
  }).filter(Boolean);
}

function reconcileExhibitionMedia_(plan) {
  const folderId = plan.folder.getId();
  const unregistered = plan.entries.filter((entry) => !plan.keepIds.has(entry.file.getId()));
  const recovery = unregistered.length ? getExhibitionAuxFolder_(folderId, 'recovery', true) : plan.recovery;
  // Move unregistered files aside first, without destroying older draft references.
  unregistered.forEach((entry) => {
    if (entry.source.getId() !== recovery.getId()) {
      retryDriveOperation_(() => entry.file.moveTo(recovery), '未登録画像の退避');
    }
    if (entry.file.getSharingAccess() !== DriveApp.Access.PRIVATE) {
      retryDriveOperation_(() => entry.file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE), '未登録画像の非公開設定');
    }
  });
  plan.entries.filter((entry) => plan.keepIds.has(entry.file.getId()) && entry.source !== plan.folder).forEach((entry) => {
    retryDriveOperation_(() => entry.file.moveTo(plan.folder), '展示会画像の公開フォルダへの移動');
  });
  if (plan.staging) trashFolderIfEmpty_(plan.staging.getId());
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
    return folder;
  }

  const root = getDriveFolderWithRetry_(rootFolderIdForKind_(kind), '素材親フォルダ取得');
  const folderName = buildManagedFolderName_(title, draft !== false);
  const folder = retryDriveOperation_(() => root.createFolder(folderName), '素材フォルダ作成');
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
  if (kind === 'exhibition' && mediaKind !== 'image') {
    throw new Error(name + ' は画像ファイルではありません。');
  }
}

function buildUploadFileName_(folder, kind, role, originalName, mimeType) {
  return uniqueFileName_(folder, safeFileName_(originalName));
}

function renameExhibitionMediaFiles_(folder, dmFileIds, workFiles) {
  const used = {};
  const dmIds = (dmFileIds || []).map((id) => String(id || '').trim()).filter(Boolean).slice(0, 2);
  dmIds.forEach((fileId, index) => {
    const file = DriveApp.getFileById(fileId);
    const ext = extensionFromNameOrMime_(file.getName(), file.getMimeType());
    const label = index === 0 ? '表' : '裏';
    renameFileUniquely_(folder, file, '0_DM_' + label + ext, used);
  });

  (workFiles || []).filter(Boolean).sort((a, b) => Number(a.sortOrder || a.sort_order || 9999) - Number(b.sortOrder || b.sort_order || 9999)).forEach((work, index) => {
    const fileId = String(work.fileId || work.file_id || '').trim();
    if (!fileId) return;
    const file = DriveApp.getFileById(fileId);
    const ext = extensionFromNameOrMime_(file.getName(), file.getMimeType());
    const order = Number(work.sortOrder || work.sort_order || index + 1) || index + 1;
    const title = String(work.title || work.workTitle || '作品').trim() || '作品';
    const artist = String(work.artist || work.artistName || '作者未設定').trim() || '作者未設定';
    renameFileUniquely_(folder, file, order + '_' + title + '_' + artist + ext, used);
  });
}

function renameFileUniquely_(folder, file, requestedName, used) {
  const fileId = file.getId();
  let nextName = uniqueFileName_(folder, requestedName, fileId);
  const lower = nextName.toLowerCase();
  if (used[lower] && used[lower] !== fileId) {
    const dot = nextName.lastIndexOf('.');
    const base = dot > 0 ? nextName.slice(0, dot) : nextName;
    const ext = dot > 0 ? nextName.slice(dot) : '';
    for (let i = 2; i < 1000; i += 1) {
      const candidate = base + '-' + i + ext;
      const key = candidate.toLowerCase();
      if (!used[key]) {
        nextName = candidate;
        break;
      }
    }
  }
  used[nextName.toLowerCase()] = fileId;
  if (file.getName() !== nextName) file.setName(nextName);
}

function buildRenameFileName_(folder, file, requestedName) {
  const currentName = retryDriveOperation_(() => file.getName(), 'ファイル名取得');
  const currentDot = currentName.lastIndexOf('.');
  const ext = currentDot > 0 ? currentName.slice(currentDot) : '';
  let base = safeFileName_(requestedName);
  const requestedDot = base.lastIndexOf('.');
  if (requestedDot > 0) base = base.slice(0, requestedDot);
  const nextName = safeFileName_(base + ext);
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

function applyPrivateFolderSharing_(folder) {
  retryDriveOperation_(
    () => folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE),
    '展示会フォルダ非公開設定'
  );
}

function trashFolderIfEmpty_(folderId) {
  const folder = getDriveFolderWithRetry_(folderId, '素材フォルダ取得');
  const files = retryDriveOperation_(() => folder.getFiles(), '素材フォルダ空チェック');
  if (files.hasNext()) return false;
  if (folder.getFolders().hasNext()) return false;
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

function buildStorageRecommendations_(state, storage) {
  const items = [];
  const seenFolderIds = {};
  function push(kind, label, title, dateValue, folderId, published) {
    if (!folderId || seenFolderIds[folderId]) return;
    seenFolderIds[folderId] = true;
    items.push({
      kind,
      label,
      title: title || '(タイトル未入力)',
      date: String(dateValue || ''),
      folderId,
      published: published !== false
    });
  }

  (state.exhibitions || []).forEach((item) => push('exhibition', '展示会', item.title, item.startDate, item.mediaFolderId || item.driveFolderId, item.published));
  (state.activityArticles || []).forEach((item) => push('activity', '活動記録・告知', item.title, item.createdAt, item.mediaFolderId || item.photoFolderId, item.published));
  (state.requestCases || []).forEach((item) => push('request', '取り組み事例', item.title, item.updatedAt, item.mediaFolderId || item.photoFolderId, item.published));

  items.sort((a, b) => {
    return String(a.date || '9999').localeCompare(String(b.date || '9999'));
  });
  const requiredBytes = requiredStorageReleaseBytes_(storage);
  const selected = [];
  let totalBytes = 0;

  for (let index = 0; index < items.length && totalBytes < requiredBytes; index++) {
    const details = getRecommendationFolderDetails_(items[index].folderId);
    if (!details || details.size <= 0) continue;
    selected.push(Object.assign({}, items[index], {
      folderUrl: details.url,
      size: details.size
    }));
    totalBytes += details.size;
  }

  return {
    items: selected,
    totalBytes,
    projectedRemaining: Math.min(storage.limit, storage.remaining + totalBytes),
    sufficient: totalBytes >= requiredBytes
  };
}

function requiredStorageReleaseBytes_(storage) {
  const comfortableRemaining = 5 * 1024 * 1024 * 1024;
  const remainingShortfall = Math.max(0, comfortableRemaining - storage.remaining);
  const usageShortfall = Math.max(0, storage.used - storage.limit * 0.8 + 1);
  return Math.ceil(Math.max(remainingShortfall, usageShortfall));
}

function getRecommendationFolderDetails_(folderId) {
  try {
    const folder = getDriveFolderWithRetry_(folderId, '候補フォルダ取得');
    return {
      url: retryDriveOperation_(() => folder.getUrl(), '候補フォルダURL取得'),
      size: getFolderSize_(folder)
    };
  } catch (error) {
    return null;
  }
}

function getFolderSize_(folder) {
  let total = 0;
  const files = retryDriveOperation_(() => folder.getFiles(), '候補ファイル一覧取得');
  while (files.hasNext()) {
    const file = files.next();
    total += Number(retryDriveOperation_(() => file.getSize(), '候補ファイルサイズ取得') || 0);
  }
  const folders = retryDriveOperation_(() => folder.getFolders(), '候補サブフォルダ一覧取得');
  while (folders.hasNext()) {
    total += getFolderSize_(folders.next());
  }
  return total;
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

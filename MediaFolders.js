// 項目ごとのフォルダ：作る・名前・共有・一時置き場と退避先、Drive の操作のやり直し

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

// 項目のフォルダ（4つのルートフォルダの直下で、CMS_ の一時置き場・退避先ではないもの）なら、そのルートの ID。
// それ以外は ''
function managedItemRootId_(folder) {
  const name = retryDriveOperation_(() => folder.getName(), '素材フォルダ名取得');
  if (/^CMS_(下書き|未登録)_/.test(name)) return '';
  const config = getConfig_();
  const roots = [config.ROOT_RECRUIT_FOLDER_ID, config.ROOT_ACTIVITY_FOLDER_ID, config.ROOT_EXHIBITION_FOLDER_ID, config.ROOT_REQUEST_FOLDER_ID];
  const parents = retryDriveOperation_(() => folder.getParents(), '素材フォルダの親取得');
  while (parents.hasNext()) {
    const parentId = parents.next().getId();
    if (roots.indexOf(parentId) !== -1) return parentId;
  }
  return '';
}

function isManagedItemFolder_(folder) {
  return !!managedItemRootId_(folder);
}

function requireManagedItemFolder_(folder) {
  if (folder.isTrashed() || !isManagedItemFolder_(folder)) {
    throw new Error('画像のフォルダが見つかりません。最新のデータを読み込んでください。');
  }
}

// CMS_下書き_<item folder id> (staging) and CMS_未登録_<item folder id> (recovery), next to the item folder.
function getMediaAuxFolder_(folderId, type, create, rootId) {
  const parentId = rootId || managedItemRootId_(getDriveFolderWithRetry_(folderId, '素材フォルダ取得'));
  if (!parentId) throw new Error('画像のフォルダが見つかりません。最新のデータを読み込んでください。');
  const root = getDriveFolderWithRetry_(parentId, '素材親フォルダ取得');
  const name = 'CMS_' + (type === 'staging' ? '下書き' : '未登録') + '_' + folderId;
  const folders = retryDriveOperation_(() => root.getFoldersByName(name), '補助フォルダ取得');
  const folder = folders.hasNext() ? folders.next() : null;
  if (!create) return folder;
  if (root.getSharingAccess() !== DriveApp.Access.PRIVATE) {
    throw new Error('下書き画像を非公開で保管するため、画像の親フォルダ（新歓・活動記録・展示会・ご依頼）の共有設定を「制限付き」にしてください。');
  }
  const result = folder || root.createFolder(name);
  applyPrivateFolderSharing_(result);
  return result;
}

// 項目のフォルダと、その一時置き場・退避先（同じルートフォルダの中にある）
function mediaSourceFolders_(folder) {
  const sources = [folder];
  const rootId = managedItemRootId_(folder);
  if (rootId) {
    const folderId = retryDriveOperation_(() => folder.getId(), '素材フォルダID取得');
    ['staging', 'recovery'].forEach((type) => {
      const auxiliary = getMediaAuxFolder_(folderId, type, false, rootId);
      if (auxiliary) sources.push(auxiliary);
    });
  }
  return sources;
}

function listFolderFiles_(folder) {
  const iterator = retryDriveOperation_(() => folder.getFiles(), 'Drive素材一覧取得');
  const files = [];
  while (iterator.hasNext()) files.push(iterator.next());
  return files;
}

function isLinkShared_(target) {
  const access = retryDriveOperation_(() => target.getSharingAccess(), '共有設定取得');
  return access === DriveApp.Access.ANYONE_WITH_LINK || access === DriveApp.Access.ANYONE;
}

// 公開中の項目のフォルダは「リンクを知っている全員」にする（画像はもともとサイトに載っている）。
// 設定が違うときだけ変える（公開のたびに全部のフォルダを触らないため）
function setFolderLinkSharing_(folder, isPublic) {
  if (isLinkShared_(folder) === isPublic) return;
  if (isPublic) applyExhibitionFolderSharing_(folder);
  else applyPrivateFolderSharing_(folder);
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

function compareNamesNatural_(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'ja', {
    numeric: true,
    sensitivity: 'base'
  });
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

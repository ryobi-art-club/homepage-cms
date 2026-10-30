function getFolderImages(sessionToken, folderId) {
  requireSession_(sessionToken);
  return getFolderMedia_(folderId).filter((file) => file.kind === 'image');
}

function getFolderMedia(sessionToken, folderId) {
  requireSession_(sessionToken);
  return getFolderMedia_(folderId);
}

// Thumbnails for images the browser cannot load from Drive by itself (private folders).
// The web app runs as the owner, so the server can read them and return them as data URLs.
// Only folders directly under the four root folders are served.
const THUMBNAIL_REQUEST_LIMIT = 10;
const THUMBNAIL_ORIGINAL_MAX_BYTES = 1.5 * 1024 * 1024;

function getMediaThumbnails(sessionToken, folderId, fileIds) {
  requireSession_(sessionToken);
  const wanted = new Set((Array.isArray(fileIds) ? fileIds : [])
    .map((id) => String(id || '').trim()).filter(Boolean).slice(0, THUMBNAIL_REQUEST_LIMIT));
  const result = {};
  if (!wanted.size) return result;
  const folder = getDriveFolderWithRetry_(String(folderId || '').trim(), '素材フォルダ取得');
  requireManagedMediaFolder_(folder);
  mediaSourceFolders_(folder).forEach((source) => listFolderFiles_(source).forEach((file) => {
    const id = retryDriveOperation_(() => file.getId(), '素材ID取得');
    if (wanted.has(id) && !Object.prototype.hasOwnProperty.call(result, id)) result[id] = thumbnailDataUrl_(file);
  }));
  wanted.forEach((id) => {
    if (!Object.prototype.hasOwnProperty.call(result, id)) result[id] = '';
  });
  return result;
}

function thumbnailDataUrl_(file) {
  try {
    const mimeType = retryDriveOperation_(() => file.getMimeType(), '素材mimeType取得');
    if (mediaKindFromMime_(mimeType) !== 'image') return '';
    // Drive may not have made a thumbnail yet right after an upload; small originals are sent instead.
    let blob = retryDriveOperation_(() => file.getThumbnail(), 'サムネイル取得');
    if (!blob && retryDriveOperation_(() => file.getSize(), '素材サイズ取得') <= THUMBNAIL_ORIGINAL_MAX_BYTES) {
      blob = retryDriveOperation_(() => file.getBlob(), '画像取得');
    }
    if (!blob) return '';
    return 'data:' + (blob.getContentType() || mimeType) + ';base64,' + Utilities.base64Encode(blob.getBytes());
  } catch (error) {
    console.warn('サムネイルを作れませんでした', error);
    return '';
  }
}

function requireManagedMediaFolder_(folder) {
  const config = getConfig_();
  const roots = [config.ROOT_RECRUIT_FOLDER_ID, config.ROOT_ACTIVITY_FOLDER_ID, config.ROOT_EXHIBITION_FOLDER_ID, config.ROOT_REQUEST_FOLDER_ID];
  const parents = retryDriveOperation_(() => folder.getParents(), '素材フォルダの親取得');
  while (parents.hasNext()) {
    if (roots.indexOf(parents.next().getId()) !== -1) return;
  }
  throw new Error('管理している画像フォルダではありません。');
}

function isLinkShared_(target) {
  const access = retryDriveOperation_(() => target.getSharingAccess(), '共有設定取得');
  return access === DriveApp.Access.ANYONE_WITH_LINK || access === DriveApp.Access.ANYONE;
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
    requireManagedItemFolder_(folder);
    // New images wait in the private staging folder until a publish registers them (all kinds).
    const destination = getMediaAuxFolder_(folder.getId(), 'staging', true);
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

function trashManagedFile(sessionToken, request) {
  requireSession_(sessionToken);
  if (!request || typeof request !== 'object') throw new Error('削除情報が不正です。');

  const folderId = String(request.folderId || '').trim();
  const fileId = requireString_(request.fileId, 'ファイルID', 200);
  const folder = folderId ? getDriveFolderWithRetry_(folderId, '画像フォルダ取得') : null;
  if (folder && isManagedItemFolder_(folder)) {
    // Keep files for the published site and other saved drafts until publication (all kinds).
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

// previousSnapshot: the public snapshot of the last publish. Items whose Drive-related fields are unchanged
// since then are skipped: their folders were already renamed, shared and (exhibitions) reconciled at that
// publish. This keeps publishing time proportional to what changed instead of to all content.
// Without a snapshot every item is processed.
// stats (optional) receives, per kind, how many items were processed out of all.
function finalizeManagedFolders_(state, previousSnapshot, stats) {
  const isChanged = buildDriveChangeFilter_(previousSnapshot);
  const changed = (kind, item) => {
    const result = isChanged(kind, item);
    if (stats) {
      stats[kind] = stats[kind] || { processed: 0, total: 0 };
      stats[kind].total += 1;
      if (result) stats[kind].processed += 1;
    }
    return result;
  };
  const changedItems = [];
  [['recruit', state.recruitCalendars], ['activity', state.activityArticles], ['exhibition', state.exhibitions], ['request', state.requestCases]]
    .forEach(([kind, items]) => (items || []).filter((item) => changed(kind, item)).forEach((item) => changedItems.push({ kind, item })));
  // Validate every changed item before moving any files.
  const plans = buildMediaPlans_(changedItems, previousSnapshot);
  const emptyFolders = [];
  plans.forEach((plan) => {
    const item = plan.item;
    reconcileMediaPlan_(plan);
    if (!plan.keepIds.size) {
      applyPrivateFolderSharing_(plan.folder);
      if (!plan.folder.getFiles().hasNext() && !plan.folder.getFolders().hasNext()) {
        emptyFolders.push(plan.folder.getId());
        item.mediaFolderId = '';
      }
      return;
    }
    const folder = renameFolderIfPresent_(plan.folder.getId(), itemDisplayTitle_(plan.kind, item), false);
    if (!folder) return;
    if (plan.kind === 'exhibition') renameExhibitionMediaFiles_(folder, item.dmFileIds, item.works);
    setFolderLinkSharing_(folder, plan.kind === 'recruit' ? item.published === true : item.published !== false);
  });
  return emptyFolders;
}

// What decides each item's folder name, sharing and (exhibitions) file placement and names.
const DRIVE_CHANGE_KEYS_ = {
  // 新歓のフォルダ名は年度から決まるので、年度（key）が同じなら名前も変わらない
  recruit: {
    key: (item) => String(item.year || ''),
    signature: (item) => [item.published === true, item.mediaFolderId, registeredMediaIds_('recruit', item)]
  },
  activity: {
    key: (item) => String(item.articleId || ''),
    signature: (item) => [item.title, item.published !== false, item.mediaFolderId, registeredMediaIds_('activity', item)]
  },
  request: {
    key: (item) => String(item.caseId || ''),
    signature: (item) => [item.title, item.published !== false, item.mediaFolderId, registeredMediaIds_('request', item)]
  },
  exhibition: {
    key: (item) => String(item.exhibitionId || ''),
    signature: (item) => [item.title, item.published !== false, item.mediaFolderId, item.dmFileIds, item.works]
  }
};

function buildDriveChangeFilter_(previousSnapshot) {
  if (!previousSnapshot) return () => true;
  const lists = {
    recruit: previousSnapshot.recruitCalendars,
    activity: previousSnapshot.activityArticles,
    request: previousSnapshot.requestCases,
    exhibition: previousSnapshot.exhibitions
  };
  const before = {};
  Object.keys(DRIVE_CHANGE_KEYS_).forEach((kind) => {
    const rule = DRIVE_CHANGE_KEYS_[kind];
    (lists[kind] || []).forEach((item) => {
      const key = rule.key(item);
      if (key) before[kind + ':' + key] = stableStringify_(rule.signature(item));
    });
  });
  return (kind, item) => {
    const rule = DRIVE_CHANGE_KEYS_[kind];
    const key = rule.key(item);
    return !key || before[kind + ':' + key] !== stableStringify_(rule.signature(item));
  };
}

// ---------- Cleanup after a successful publish ----------
// Moves to the Drive trash (restorable for 30 days):
//  - folders made by the CMS whose item no longer exists (deleted items, and the staging / recovery
//    folders of deleted exhibitions);
//  - images set aside in an exhibition's recovery folder by an earlier publish. They were kept only so
//    that an interrupted publish could be retried; after this successful publish they are not needed.
// Only folders named the way the CMS names them are touched. Work stops at the time budget and the
// rest is done after the next publish (every step can be repeated safely).
const RECOVERY_STAMP_PREFIX_ = 'cms-unregistered-at:';
const CMS_ITEM_FOLDER_PATTERN_ = /_(\d{8}|下書き_\d{8}_\d{4})$/;
const CMS_AUX_FOLDER_PATTERN_ = /^CMS_(下書き|未登録)_(.+)$/;

function collectGarbage_(state, options) {
  const trash = !!options.trash;
  const deadline = Date.now() + options.budgetMs;
  const publishStartedAt = options.publishStartedAt;
  const referenced = buildReferencedFolderIdSet_(state || {});
  const config = getConfig_();
  const result = { lines: [], finished: true };
  const outOfTime = () => {
    if (Date.now() <= deadline) return false;
    result.finished = false;
    return true;
  };
  const roots = [
    ['新歓', config.ROOT_RECRUIT_FOLDER_ID],
    ['活動記録', config.ROOT_ACTIVITY_FOLDER_ID],
    ['展示会', config.ROOT_EXHIBITION_FOLDER_ID],
    ['ご依頼', config.ROOT_REQUEST_FOLDER_ID]
  ];
  for (const [label, rootId] of roots) {
    if (outOfTime()) break;
    const root = getDriveFolderWithRetry_(rootId, '片付け対象の親フォルダ取得');
    const folders = listSubfolders_(root);
    for (const folder of folders) {
      if (outOfTime()) break;
      const id = retryDriveOperation_(() => folder.getId(), '片付け対象のフォルダID取得');
      const name = retryDriveOperation_(() => folder.getName(), '片付け対象のフォルダ名取得');
      const aux = name.match(CMS_AUX_FOLDER_PATTERN_);
      if (!aux && !CMS_ITEM_FOLDER_PATTERN_.test(name)) continue;
      const ownerId = aux ? aux[2] : id;
      if (!referenced[ownerId]) {
        result.lines.push('フォルダ ' + label + '/' + name + '（削除された項目）');
        if (trash) retryDriveOperation_(() => folder.setTrashed(true), '削除された項目のフォルダの片付け');
        continue;
      }
      if (aux && aux[1] === '未登録') trashOldRecoveryFiles_(folder, label + '/' + name, publishStartedAt, trash, result, outOfTime);
    }
  }
  return result;
}

// Files without a stamp were set aside before the stamp existed, which is also an earlier publish.
function trashOldRecoveryFiles_(folder, path, publishStartedAt, trash, result, outOfTime) {
  for (const file of listFolderFiles_(folder)) {
    if (outOfTime()) return;
    const description = String(retryDriveOperation_(() => file.getDescription(), '退避日時の確認') || '');
    const stamped = description.indexOf(RECOVERY_STAMP_PREFIX_) === 0 ? Date.parse(description.slice(RECOVERY_STAMP_PREFIX_.length)) : NaN;
    if (!isNaN(stamped) && stamped >= publishStartedAt) continue;
    const name = retryDriveOperation_(() => file.getName(), '退避した画像の名前取得');
    result.lines.push('画像 ' + path + '/' + name + '（退避した画像）');
    if (trash) retryDriveOperation_(() => file.setTrashed(true), '退避した画像の片付け');
  }
  if (trash) trashFolderIfEmpty_(retryDriveOperation_(() => folder.getId(), '退避フォルダID取得'));
}

function listSubfolders_(folder) {
  const iterator = retryDriveOperation_(() => folder.getFolders(), 'フォルダ一覧取得');
  const folders = [];
  while (iterator.hasNext()) folders.push(iterator.next());
  return folders;
}

function formatCleanupReport_(result, trash) {
  const head = trash ? 'ゴミ箱に入れました' : '記録のみ（スクリプト プロパティ CLEANUP_MODE が trash ではないので、何も消していません）';
  if (!result.lines.length) return head + '：片付けるものはありません' + (result.finished ? '' : '（時間切れ。残りは次の公開で）');
  const body = result.lines.join('\n');
  const limited = body.length > 40000 ? body.slice(0, 40000) + '\n…（ほかは省略）' : body;
  return head + '（' + result.lines.length + '件' + (result.finished ? '' : '、時間切れ。残りは次の公開で') + '）\n' + limited;
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
  ['recruitCalendars', 'activityArticles', 'exhibitions', 'requestCases'].forEach((name) => {
    (state[name] || []).forEach((item) => add(item.mediaFolderId));
  });
  return ids;
}

function getFolderMedia_(folderId) {
  if (!folderId) return [];

  const folder = getDriveFolderWithRetry_(folderId, '素材フォルダ取得');
  const files = [];
  mediaSourceFolders_(folder).forEach((source) => {
    // public: the browser can load the Drive thumbnail URL directly (anyone with the link can view)
    const isPublic = isLinkShared_(source);
    listFolderFiles_(source).forEach((file) => {
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
        thumbnailUrl: kind === 'image' ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1000' : '',
        public: isPublic,
        folderId
      });
    });
  });

  files.sort((a, b) => compareNamesNatural_(a.name, b.name));
  return files;
}

// The item folder, plus its private staging and recovery folders (next to it in the same root).
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

// An item folder sits directly under one of the four root folders and is not a CMS_ staging / recovery folder.
// Returns the id of that root, or '' for any other folder.
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

function isExhibitionMediaFolder_(folder) {
  return managedItemRootId_(folder) === getConfig_().ROOT_EXHIBITION_FOLDER_ID;
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

function getExhibitionAuxFolder_(folderId, type, create) {
  return getMediaAuxFolder_(folderId, type, create);
}

// The images an item uses: DM and works for exhibitions, mediaFileIds for the others.
function registeredMediaIds_(kind, item) {
  const ids = kind === 'exhibition'
    ? (item.dmFileIds || []).concat((item.works || []).map((work) => work.fileId))
    : (item.mediaFileIds || []);
  return ids.map((id) => String(id || '').trim()).filter(Boolean);
}

const MEDIA_KIND_LABELS_ = { recruit: '新歓カレンダー', activity: '活動記録・告知', exhibition: '展示会', request: '取り組み事例' };

function itemDisplayTitle_(kind, item) {
  return kind === 'recruit' ? recruitCalendarLabel_(item.year) : item.title;
}

// Items saved before images were registered one by one have no mediaFileIds and use every image in
// their folder. They are treated as registering those images, in the order the CMS shows them, until
// a publish writes the list. previousSnapshot tells them apart from an item whose images were all removed.
function wasNeverRegistered_(kind, item, previousSnapshot) {
  if (kind === 'exhibition' || registeredMediaIds_(kind, item).length) return false;
  if (!previousSnapshot) return true;
  const rule = DRIVE_CHANGE_KEYS_[kind];
  const lists = { recruit: previousSnapshot.recruitCalendars, activity: previousSnapshot.activityArticles, request: previousSnapshot.requestCases };
  const before = (lists[kind] || []).find((candidate) => rule.key(candidate) === rule.key(item));
  return !before || !registeredMediaIds_(kind, before).length;
}

function folderImageIdsInOrder_(folder) {
  return listFolderFiles_(folder)
    .filter((file) => mediaKindFromMime_(retryDriveOperation_(() => file.getMimeType(), '素材mimeType取得')) === 'image')
    .map((file) => ({ id: retryDriveOperation_(() => file.getId(), '素材ID取得'), name: retryDriveOperation_(() => file.getName(), '素材名取得') }))
    .sort((a, b) => compareNamesNatural_(a.name, b.name))
    .map((file) => file.id);
}

function buildMediaPlans_(changedItems, previousSnapshot) {
  const seenFolders = new Set();
  return changedItems.map(({ kind, item }) => {
    const label = MEDIA_KIND_LABELS_[kind] + '「' + (itemDisplayTitle_(kind, item) || '') + '」';
    const folderId = item.mediaFolderId;
    let keepIds = new Set(registeredMediaIds_(kind, item));
    if (!folderId && !keepIds.size) return null;
    if (!folderId || seenFolders.has(folderId)) {
      throw new Error(label + 'の素材フォルダが未設定、または他の項目と重複しています。');
    }
    seenFolders.add(folderId);
    const folder = getDriveFolderWithRetry_(folderId, '素材フォルダ取得');
    requireManagedItemFolder_(folder);
    const rootId = managedItemRootId_(folder);
    if (wasNeverRegistered_(kind, item, previousSnapshot)) {
      item.mediaFileIds = folderImageIdsInOrder_(folder);
      keepIds = new Set(item.mediaFileIds);
    }
    const staging = getMediaAuxFolder_(folderId, 'staging', false, rootId);
    const recovery = getMediaAuxFolder_(folderId, 'recovery', false, rootId);
    const entries = [folder, staging, recovery].filter(Boolean).flatMap((source) =>
      listFolderFiles_(source).map((file) => ({ file, source })));
    const available = new Set(entries.map((entry) => entry.file.getId()));
    keepIds.forEach((id) => {
      if (!available.has(id)) {
        throw new Error(label + 'の登録画像が見つかりません: ' + id);
      }
    });
    return { kind, item, folder, rootId, staging, recovery, entries, keepIds };
  }).filter(Boolean);
}

function reconcileMediaPlan_(plan) {
  const folderId = plan.folder.getId();
  const unregistered = plan.entries.filter((entry) => !plan.keepIds.has(entry.file.getId()));
  const recovery = unregistered.length ? getMediaAuxFolder_(folderId, 'recovery', true, plan.rootId) : plan.recovery;
  // Move unregistered files aside first, without destroying older draft references.
  unregistered.forEach((entry) => {
    if (entry.source.getId() !== recovery.getId()) {
      retryDriveOperation_(() => entry.file.moveTo(recovery), '未登録画像の退避');
      // When it was set aside: the cleanup after the next successful publish moves it to the trash.
      retryDriveOperation_(() => entry.file.setDescription(RECOVERY_STAMP_PREFIX_ + isoNow_()), '未登録画像の退避日時記録');
    }
    if (entry.file.getSharingAccess() !== DriveApp.Access.PRIVATE) {
      retryDriveOperation_(() => entry.file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE), '未登録画像の非公開設定');
    }
  });
  plan.entries.filter((entry) => plan.keepIds.has(entry.file.getId()) && entry.source !== plan.folder).forEach((entry) => {
    retryDriveOperation_(() => entry.file.moveTo(plan.folder), '画像の公開フォルダへの移動');
    if (plan.recovery && entry.source.getId() === plan.recovery.getId()) {
      retryDriveOperation_(() => entry.file.setDescription(''), '退避日時の記録の削除');
    }
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

// DM は「0_DM_表」「0_DM_裏」、作品は「番号_作品名_作者名」（番号は並び順）
function renameExhibitionMediaFiles_(folder, dmFileIds, works) {
  const used = {};
  (dmFileIds || []).slice(0, 2).forEach((fileId, index) => {
    const file = DriveApp.getFileById(fileId);
    const ext = extensionFromNameOrMime_(file.getName(), file.getMimeType());
    renameFileUniquely_(folder, file, '0_DM_' + (index === 0 ? '表' : '裏') + ext, used);
  });
  (works || []).forEach((work, index) => {
    const file = DriveApp.getFileById(work.fileId);
    const ext = extensionFromNameOrMime_(file.getName(), file.getMimeType());
    renameFileUniquely_(folder, file, (index + 1) + '_' + (work.title || '作品') + '_' + (work.artist || '作者未設定') + ext, used);
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

// Published items: anyone with the link can view (their images are on the public site anyway).
// Changes the setting only when it differs, so repeated publishes do not touch every folder.
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

  (state.exhibitions || []).forEach((item) => push('exhibition', '展示会', item.title, item.startDate, item.mediaFolderId, item.published));
  (state.activityArticles || []).forEach((item) => push('activity', '活動記録・告知', item.title, item.createdAt, item.mediaFolderId, item.published));
  // ご依頼事例には日付がないので、日付のある項目のあとに並ぶ
  (state.requestCases || []).forEach((item) => push('request', '取り組み事例', item.title, '', item.mediaFolderId, item.published));

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

// 画像の入口：一覧・サムネイル・追加・削除

function getFolderImages(sessionToken, folderId) {
  requireSession_(sessionToken);
  return getFolderMedia_(folderId).filter((file) => file.kind === 'image');
}

function getFolderMedia(sessionToken, folderId) {
  requireSession_(sessionToken);
  return getFolderMedia_(folderId);
}

// 見ている人のブラウザが Drive から直接読めない画像（非公開のフォルダ）のサムネイル。
// ウェブアプリは開発用アカウントの権限で動くので、サーバーが読んでデータとして渡す。
// 4つのルートフォルダの中の項目のフォルダの画像しか返さない
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
    // アップロードの直後は Drive がまだサムネイルを作っていないことがある。小さい画像なら元の画像を送る
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
    // 追加した画像は、公開で登録されるまで非公開の一時置き場に置く
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
  const fileId = requireString_(request.fileId, 'ファイルID', 200);
  const folder = getDriveFolderWithRetry_(requireString_(request.folderId, 'フォルダID', 200), '画像フォルダ取得');
  requireManagedItemFolder_(folder);
  // 公開中のサイトとほかの下書きが使っているかもしれないので、ファイルは公開のときまで動かさない
  const result = buildFolderMediaResponse_(folder);
  result.files = result.files.filter((file) => file.id !== fileId);
  return result;
}

function getFolderMedia_(folderId) {
  if (!folderId) return [];

  const folder = getDriveFolderWithRetry_(folderId, '素材フォルダ取得');
  const files = [];
  mediaSourceFolders_(folder).forEach((source) => {
    // public：フォルダが「リンクを知っている全員」で、ブラウザが Drive のサムネイルを直接読める
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

function buildFolderMediaResponse_(folder) {
  const folderId = retryDriveOperation_(() => folder.getId(), '素材フォルダID取得');
  return {
    folderId,
    folderName: retryDriveOperation_(() => folder.getName(), '素材フォルダ名取得'),
    folderUrl: retryDriveOperation_(() => folder.getUrl(), '素材フォルダURL取得'),
    files: getFolderMedia_(folderId)
  };
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

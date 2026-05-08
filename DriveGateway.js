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
  if (!folderId) return [];

  const folder = getDriveFolderWithRetry_(folderId, '画像フォルダ取得');
  const iterator = retryDriveOperation_(
    () => folder.getFiles(),
    'Drive画像一覧取得'
  );

  const files = [];

  while (iterator.hasNext()) {
    const file = iterator.next();

    const mimeType = retryDriveOperation_(
      () => file.getMimeType(),
      '画像mimeType取得'
    );

    if (String(mimeType).indexOf('image/') !== 0) continue;

    const id = retryDriveOperation_(
      () => file.getId(),
      '画像ID取得'
    );

    files.push({
      id,
      name: retryDriveOperation_(() => file.getName(), '画像名取得'),
      url: retryDriveOperation_(() => file.getUrl(), '画像URL取得'),
      thumbnailUrl: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1000'
    });
  }

  files.sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'ja', {
      numeric: true,
      sensitivity: 'base'
    })
  );

  return files;
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

  folders.sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'ja', {
      numeric: true,
      sensitivity: 'base'
    })
  );
  
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
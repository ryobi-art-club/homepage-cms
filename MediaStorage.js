// Drive の容量の確認と、空けるときのおすすめ

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

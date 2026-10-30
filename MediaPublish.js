// 公開のときの画像とフォルダの処理と、公開のあとの片付け

// 前回公開した内容（previousSnapshot）から Drive に関わる部分が変わった項目だけを処理する。変わっていない
// 項目は前回の公開で整っているので、公開の時間が内容の量ではなく変わった量に比例する。
// previousSnapshot がなければ全部を処理する。stats には種類ごとの処理した数と全体の数を入れる
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
  // ファイルを1つでも動かす前に、全部の項目を確かめる
  const plans = buildMediaPlans_(changedItems);
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

// フォルダの名前・共有・画像の置き場所（展示会はファイル名も）を決める値
const DRIVE_CHANGE_KEYS = {
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
  Object.keys(DRIVE_CHANGE_KEYS).forEach((kind) => {
    const rule = DRIVE_CHANGE_KEYS[kind];
    (lists[kind] || []).forEach((item) => {
      const key = rule.key(item);
      if (key) before[kind + ':' + key] = stableStringify_(rule.signature(item));
    });
  });
  return (kind, item) => {
    const rule = DRIVE_CHANGE_KEYS[kind];
    const key = rule.key(item);
    return !key || before[kind + ':' + key] !== stableStringify_(rule.signature(item));
  };
}

function registeredMediaIds_(kind, item) {
  const ids = kind === 'exhibition'
    ? (item.dmFileIds || []).concat((item.works || []).map((work) => work.fileId))
    : (item.mediaFileIds || []);
  return ids.map((id) => String(id || '').trim()).filter(Boolean);
}

const MEDIA_KIND_LABELS = { recruit: '新歓カレンダー', activity: '活動記録・告知', exhibition: '展示会', request: '取り組み事例' };

function itemDisplayTitle_(kind, item) {
  return kind === 'recruit' ? recruitCalendarLabel_(item.year) : item.title;
}

function buildMediaPlans_(changedItems) {
  const seenFolders = new Set();
  return changedItems.map(({ kind, item }) => {
    const label = MEDIA_KIND_LABELS[kind] + '「' + (itemDisplayTitle_(kind, item) || '') + '」';
    const folderId = item.mediaFolderId;
    const keepIds = new Set(registeredMediaIds_(kind, item));
    if (!folderId && !keepIds.size) return null;
    if (!folderId || seenFolders.has(folderId)) {
      throw new Error(label + 'の素材フォルダが未設定、または他の項目と重複しています。');
    }
    seenFolders.add(folderId);
    const folder = getDriveFolderWithRetry_(folderId, '素材フォルダ取得');
    requireManagedItemFolder_(folder);
    const rootId = managedItemRootId_(folder);
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
  // 登録していない画像は消さずに退避先へ移す（古い下書きが使っているかもしれないため）
  unregistered.forEach((entry) => {
    if (entry.source.getId() !== recovery.getId()) {
      retryDriveOperation_(() => entry.file.moveTo(recovery), '未登録画像の退避');
      // 退避した日時。次に公開が成功したあとの片付けで、ゴミ箱に入れる
      retryDriveOperation_(() => entry.file.setDescription(RECOVERY_STAMP_PREFIX + isoNow_()), '未登録画像の退避日時記録');
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

// ---------- 公開が成功したあとの片付け ----------
// Drive のゴミ箱に入れる（30日間は元に戻せる）もの：
//  - 今の内容で使われていない、CMS が作った名前のフォルダ（削除した項目のフォルダと、その一時置き場・退避先）
//  - 前回までの公開で退避先に移した画像。公開が途中で止まったときのやり直しのために残していたもので、
//    今回の公開が成功したので要らない
// 人が手で作った名前のフォルダには触らない。時間で打ち切り、残りは次の公開で続ける（どれも繰り返して安全）
const RECOVERY_STAMP_PREFIX = 'cms-unregistered-at:';

const CMS_ITEM_FOLDER_PATTERN = /_(\d{8}|下書き_\d{8}_\d{4})$/;

const CMS_AUX_FOLDER_PATTERN = /^CMS_(下書き|未登録)_(.+)$/;

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
      const aux = name.match(CMS_AUX_FOLDER_PATTERN);
      if (!aux && !CMS_ITEM_FOLDER_PATTERN.test(name)) continue;
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

// 退避先の画像のうち、今回の公開より前に退避したもの。日時の記録がないのは記録を始める前に退避したもので、これも含む
function trashOldRecoveryFiles_(folder, path, publishStartedAt, trash, result, outOfTime) {
  for (const file of listFolderFiles_(folder)) {
    if (outOfTime()) return;
    const description = String(retryDriveOperation_(() => file.getDescription(), '退避日時の確認') || '');
    const stamped = description.indexOf(RECOVERY_STAMP_PREFIX) === 0 ? Date.parse(description.slice(RECOVERY_STAMP_PREFIX.length)) : NaN;
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

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

function iterator(items) {
  let index = 0;
  return { hasNext: () => index < items.length, next: () => items[index++] };
}

function setup() {
  const folders = new Map();
  const files = new Map();
  let nextId = 0;
  let locked = false;
  let failingName = '';
  class Folder {
    constructor(name, parent = null) {
      this.id = 'folder-' + ++nextId;
      this.name = name;
      this.parent = parent;
      this.access = 'PRIVATE';
      this.trashed = false;
      folders.set(this.id, this);
    }
    getId() { return this.id; }
    getName() { return this.name; }
    setName(name) { this.name = name; return this; }
    getUrl() { return 'https://drive.test/' + this.id; }
    getParents() { return iterator(this.parent ? [this.parent] : []); }
    getFiles() { return iterator([...files.values()].filter(f => f.parent === this && !f.trashed)); }
    getFolders() { return iterator([...folders.values()].filter(f => f.parent === this && !f.trashed)); }
    getFoldersByName(name) {
      return iterator([...folders.values()].filter(f => f.parent === this && !f.trashed && f.name === name));
    }
    createFolder(name) { return new Folder(name, this); }
    createFile(blob) {
      if (blob.name === failingName) throw new Error('Upload failed');
      return new File(blob.name, this, blob.mimeType);
    }
    getSharingAccess() { return this.access; }
    setSharing(access) { this.access = access; return this; }
    isTrashed() { return this.trashed; }
    setTrashed(value) { this.trashed = value; return this; }
  }
  class File {
    constructor(name, parent, mimeType = 'image/jpeg') {
      this.id = 'file-' + ++nextId;
      this.name = name;
      this.parent = parent;
      this.mimeType = mimeType;
      this.trashed = false;
      this.access = 'PRIVATE';
      this.sharingFails = false;
      files.set(this.id, this);
    }
    getId() { return this.id; }
    getName() { return this.name; }
    getMimeType() { return this.mimeType; }
    getSize() { return 100; }
    getUrl() { return 'https://drive.test/' + this.id; }
    getThumbnail() { return { getContentType: () => 'image/png', getBytes: () => [1, 2, 3] }; }
    getDescription() { return this.description || ''; }
    setDescription(text) { this.description = text; return this; }
    getBlob() { return { getContentType: () => this.mimeType, getBytes: () => [4, 5] }; }
    setName(name) { this.name = name; return this; }
    setTrashed(value) { this.trashed = value; return this; }
    moveTo(folder) { this.parent = folder; return this; }
    getSharingAccess() { return this.access === 'PRIVATE' ? this.parent.access : this.access; }
    setSharing(access) {
      if (this.sharingFails) throw new Error('Sharing failed');
      this.access = access;
      return this;
    }
  }
  const root = new Folder('Exhibitions');
  const activityRoot = new Folder('Activities');
  const recruitRoot = new Folder('Recruit');
  const requestRoot = new Folder('Requests');
  const config = {
    ROOT_EXHIBITION_FOLDER_ID: root.id, ROOT_ACTIVITY_FOLDER_ID: activityRoot.id,
    ROOT_RECRUIT_FOLDER_ID: recruitRoot.id, ROOT_REQUEST_FOLDER_ID: requestRoot.id
  };
  const ctx = vm.createContext({
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
      Permission: { NONE: 'NONE', VIEW: 'VIEW' },
      getFolderById(id) { assert.ok(folders.has(id), id); return folders.get(id); },
      getFileById(id) { assert.ok(files.has(id), id); return files.get(id); }
    },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(locked, false); locked = true; },
      releaseLock() { assert.equal(locked, true); locked = false; }
    }) },
    Utilities: {
      base64Decode: value => Buffer.from(value, 'base64'),
      base64Encode: bytes => Buffer.from(bytes).toString('base64'),
      newBlob: (bytes, mimeType, name) => ({ bytes, mimeType, name }),
      formatDate: (_, __, format) => format === 'yyyyMMdd' ? '20260925' : '20260925_1200',
      sleep() {}
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    requireSession_: () => ({ name: 'Editor', email: 'editor@example.test' }),
    requireString_: value => String(value || ''),
    getConfig_: () => config,
    console: { warn() {}, log() {} },
    isoNow_: () => new Date().toISOString()
  });
  for (const name of ['DriveGateway.js', 'Store.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), ctx);
  }
  const folder = root.createFolder('Exhibition_20260925');
  folder.setSharing('ANYONE_WITH_LINK');
  const image = new File('1_Old_Artist.jpg', folder);
  const item = {
    exhibitionId: 'exhibition', title: 'Exhibition', mediaFolderId: folder.id,
    driveFolderId: folder.id, dmFileIds: [],
    workFiles: [{ fileId: image.id, sortOrder: 1, title: 'Old', artist: 'Artist' }], published: true
  };
  const state = { exhibitions: [item] };
  function upload(names = ['new.jpg'], extra = {}) {
    return ctx.uploadManagedFiles('session', {
      kind: 'exhibition', folderId: folder.id, title: item.title, role: 'work', draft: true,
      files: names.map(name => ({ name, mimeType: 'image/jpeg', data: 'eA==' })), ...extra
    });
  }
  return { ctx, root, folder, image, item, state, folders, files, File, Folder, activityRoot, recruitRoot, upload,
    failUpload: name => { failingName = name; }, isLocked: () => locked };
}

const ids = folder => {
  const values = [];
  const it = folder.getFiles();
  while (it.hasNext()) values.push(it.next().id);
  return values.sort();
};

test('uploads reuse private staging without changing public folder or existing IDs', () => {
  const { ctx, folder, image, upload, files, isLocked } = setup();
  const first = upload();
  const second = upload(['another.jpg']);
  const staging = ctx.getExhibitionAuxFolder_(folder.id, 'staging', false);
  assert.equal(staging.access, 'PRIVATE');
  assert.deepEqual(ids(folder), [image.id]);
  assert.equal(first.folderId, folder.id);
  assert.equal(files.get(first.uploadedFileIds[0]).parent, staging);
  assert.equal(files.get(second.uploadedFileIds[0]).parent, staging);
  assert.equal(ctx.getFolderImages('session', folder.id).length, 3);
  assert.equal(isLocked(), false);
});

test('publication keeps exactly registered DM/work IDs and privately preserves all extras', () => {
  const { ctx, folder, image, item, state, File, upload, files } = setup();
  const orphan = new File('old-unsaved.jpg', folder);
  orphan.access = 'ANYONE_WITH_LINK';
  const pdf = new File('old-catalog.pdf', folder, 'application/pdf');
  const result = upload(['dm.jpg', 'selected.jpg', 'abandoned.jpg']);
  const [dm, work, abandoned] = result.uploadedFileIds;
  item.dmFileIds = [dm];
  item.workFiles.push({ fileId: work, sortOrder: 2, title: 'New', artist: 'Artist' });
  const staging = ctx.getExhibitionAuxFolder_(folder.id, 'staging', false);
  ctx.finalizeManagedFolders_(state);
  assert.deepEqual(ids(folder), [image.id, dm, work].sort());
  assert.equal(item.mediaFolderId, folder.id);
  assert.equal(folder.access, 'ANYONE_WITH_LINK');
  assert.equal(files.get(dm).name, '0_DM_表.jpg');
  assert.equal(files.get(work).name, '2_New_Artist.jpg');
  const recovery = ctx.getExhibitionAuxFolder_(folder.id, 'recovery', false);
  assert.deepEqual(ids(recovery), [orphan.id, pdf.id, abandoned].sort());
  assert.equal(recovery.access, 'PRIVATE');
  assert.equal(orphan.access, 'PRIVATE');
  assert.equal(staging.trashed, true);
  assert.ok([...files.values()].every(file => !file.trashed));
  ctx.finalizeManagedFolders_(state);
  assert.deepEqual(ids(folder), [image.id, dm, work].sort());
});

test('loading an older draft excludes newer uploads on publish, without losing their files', () => {
  const { ctx, folder, image, state, upload, files } = setup();
  const result = upload();
  ctx.finalizeManagedFolders_(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(ids(folder), [image.id]);
  const extra = files.get(result.uploadedFileIds[0]);
  assert.equal(extra.parent, ctx.getExhibitionAuxFolder_(folder.id, 'recovery', false));
  assert.equal(extra.trashed, false);
});

test('delete and draft save never mutate published images; older draft can still restore them', () => {
  const { ctx, folder, image, item, state } = setup();
  const result = ctx.trashManagedFile('session', { folderId: folder.id, fileId: image.id });
  assert.equal(result.deferred, true);
  assert.equal(result.files.length, 0);
  assert.deepEqual(ids(folder), [image.id]);
  assert.equal(ctx.getFolderImages('session', folder.id)[0].id, image.id);
  let saved;
  ctx.readContentState_ = () => state;
  ctx.normalizePayload_ = payload => payload;
  ctx.saveDraftRecord_ = payload => { saved = payload; };
  ctx.buildHumanSummary_ = () => '';
  item.workFiles[0].title = 'Changed';
  ctx.saveDraft('session', state);
  assert.equal(saved.exhibitions[0].workFiles[0].title, 'Changed');
  assert.equal(image.name, '1_Old_Artist.jpg');
});

test('partial upload failure stays private and does not cause later uploads to adopt extras', () => {
  const { ctx, folder, image, upload, files, failUpload, isLocked } = setup();
  failUpload('bad.jpg');
  assert.throws(() => upload(['ok.jpg', 'bad.jpg']), /Upload failed/);
  assert.equal(isLocked(), false);
  assert.deepEqual(ids(folder), [image.id]);
  const failedBatchFile = [...files.values()].find(file => file.name === 'ok.jpg');
  assert.equal(failedBatchFile.parent.access, 'PRIVATE');
  failUpload('');
  const next = upload(['retry.jpg']);
  assert.equal(next.uploadedFileIds.length, 1);
  assert.notEqual(next.uploadedFileIds[0], failedBatchFile.id);
  assert.equal(ctx.getFolderMedia('session', folder.id).length, 3);
});

test('all exhibitions are preflighted before changes, rejecting foreign or missing file IDs', () => {
  const { ctx, root, folder, image, item, state, File } = setup();
  const orphan = new File('orphan.jpg', folder);
  const otherFolder = root.createFolder('Other');
  state.exhibitions.push({ ...item, title: 'Other', mediaFolderId: otherFolder.id });
  assert.throws(() => ctx.finalizeManagedFolders_(state), /登録画像が見つかりません/);
  assert.deepEqual(ids(folder), [image.id, orphan.id].sort());
  assert.equal(ctx.getExhibitionAuxFolder_(folder.id, 'recovery', false), null);
});

test('failed privacy change is retried for files already moved to recovery', () => {
  const { ctx, folder, image, state, File } = setup();
  const orphan = new File('orphan.jpg', folder);
  orphan.access = 'ANYONE_WITH_LINK';
  orphan.sharingFails = true;
  assert.throws(() => ctx.finalizeManagedFolders_(state), /Sharing failed/);
  orphan.sharingFails = false;
  ctx.finalizeManagedFolders_(state);
  assert.equal(orphan.access, 'PRIVATE');
  assert.deepEqual(ids(folder), [image.id]);
});

test('saved IDs in recovery can be restored after an interrupted publication', () => {
  const { ctx, folder, image, item, state, File } = setup();
  const extra = new File('extra.jpg', folder);
  ctx.finalizeManagedFolders_(state);
  item.workFiles.push({ fileId: extra.id, title: 'Restored', artist: 'Artist', sortOrder: 2 });
  ctx.finalizeManagedFolders_(state);
  assert.deepEqual(ids(folder), [image.id, extra.id].sort());
  assert.equal(extra.name, '2_Restored_Artist.jpg');
});

test('publishing without any images clears an empty folder but preserves files privately', () => {
  const { ctx, folder, image, item, state } = setup();
  item.workFiles = [];
  const emptyFolders = ctx.finalizeManagedFolders_(state);
  assert.equal(folder.trashed, false);
  assert.deepEqual(Array.from(emptyFolders), [folder.id]);
  assert.equal(folder.access, 'PRIVATE');
  assert.equal(item.mediaFolderId, '');
  assert.equal(item.driveFolderId, '');
  assert.equal(image.trashed, false);
  assert.equal(image.parent.access, 'PRIVATE');
  emptyFolders.forEach(ctx.trashFolderIfEmpty_);
  assert.equal(folder.trashed, true);
});

test('new exhibitions remain private before publication and retain their IDs afterward', () => {
  const { ctx, upload, files } = setup();
  const result = upload(['first.jpg'], { folderId: '' });
  const folder = ctx.DriveApp.getFolderById(result.folderId);
  const id = result.uploadedFileIds[0];
  assert.equal(folder.access, 'PRIVATE');
  assert.equal(ids(folder).length, 0);
  const item = { title: 'New', mediaFolderId: folder.id, dmFileIds: [id], workFiles: [], published: true };
  ctx.finalizeManagedFolders_({ exhibitions: [item] });
  assert.equal(item.mediaFolderId, result.folderId);
  assert.equal(files.get(id).parent, folder);
  assert.equal(folder.access, 'ANYONE_WITH_LINK');
});

test('sheet failure leaves the empty media folder available for publication retry', () => {
  const { ctx, folder, item, state } = setup();
  item.workFiles = [];
  ctx.readContentState_ = () => ({});
  ctx.normalizePayload_ = payload => JSON.parse(JSON.stringify(payload));
  ctx.readPublishedState_ = () => ({ payload: {}, sha256: '' });
  ctx.buildPublicSnapshot_ = payload => payload;
  ctx.stableStringify_ = JSON.stringify;
  ctx.sha256Hex_ = value => value;
  ctx.writeStateToSheets_ = () => { throw new Error('Sheet failure'); };
  assert.throws(() => ctx.publishState('session', state), /Sheet failure/);
  assert.equal(folder.trashed, false);
  assert.equal(item.mediaFolderId, folder.id);

  let saved;
  let snapshot;
  ctx.writeStateToSheets_ = payload => { saved = payload; };
  ctx.syncChangeLogTitles_ = () => {};
  ctx.summarizeChange_ = () => '';
  ctx.writePublishedState_ = json => { snapshot = JSON.parse(json); };
  ctx.clearDrafts_ = () => {};
  ctx.appendAdminLog_ = () => {};
  ctx.buildAdminDiffSummary_ = () => '';
  ctx.compactContentSheetGrids_ = () => {};
  ctx.dispatchGithubWorkflow_ = () => ({});
  ctx.publishState('session', state);
  assert.equal(saved.exhibitions[0].mediaFolderId, '');
  assert.equal(snapshot.exhibitions[0].mediaFolderId, '');
  assert.equal(folder.trashed, true);
});

test('folders containing subfolders are not mistaken for empty folders', () => {
  const { ctx, folder, image } = setup();
  image.setTrashed(true);
  folder.createFolder('Nested');
  assert.equal(ctx.trashFolderIfEmpty_(folder.id), false);
  assert.equal(folder.trashed, false);
});

test('staging cannot inherit public access from the exhibition root', () => {
  const { root, folder, image, upload, isLocked } = setup();
  root.access = 'ANYONE_WITH_LINK';
  assert.throws(() => upload(), /制限付き/);
  assert.deepEqual(ids(folder), [image.id]);
  assert.equal(isLocked(), false);
});

test('non-exhibition uploads and deletions retain their existing behavior', () => {
  const { ctx, activityRoot, upload, files } = setup();
  const activity = activityRoot.createFolder('Activity');
  const result = upload(['photo.jpg'], { kind: 'activity', folderId: activity.id, role: 'image' });
  const id = result.uploadedFileIds[0];
  assert.equal(files.get(id).parent, activity);
  const deleted = ctx.trashManagedFile('session', { folderId: activity.id, fileId: id });
  assert.equal(files.get(id).trashed, true);
  assert.equal(deleted.folderTrashed, true);
});

test('client retains only explicitly uploaded IDs and preserves removals on the next upload', () => {
  const ctx = vm.createContext({ document: { addEventListener() {} } });
  const source = fs.readFileSync(path.join(__dirname, '..', 'UiScript.html'), 'utf8')
    .replace(/^<script>\s*/, '').replace(/\s*<\/script>\s*$/, '');
  vm.runInContext(source, ctx);
  const item = { mediaFolderId: 'folder', dmFileIds: [], workFiles: [{ fileId: 'kept', title: 'Title' }] };
  ctx.currentMediaContext = () => ({ kind: 'exhibition', item, folderKey: 'mediaFolderId' });
  ctx.syncActiveMediaHiddenFields = () => {};
  ctx.refreshPreviewForKind = () => {};
  ctx.applyMediaResult({ folderId: 'folder', files: ['kept', 'orphan', 'removed', 'added'].map(id => ({ id, kind: 'image' })) },
    { type: 'upload', role: 'work', newIds: ['added'] });
  assert.deepEqual(Array.from(item.workFiles, work => work.fileId), ['kept', 'added']);
  assert.equal(item.workFiles[0].title, 'Title');
});

test('media lists say which images the browser can load from Drive by itself', () => {
  const { ctx, folder, image, upload } = setup();
  const staged = upload().uploadedFileIds[0];
  const media = ctx.getFolderMedia_(folder.id);
  assert.equal(media.find(file => file.id === image.id).public, true);
  assert.equal(media.find(file => file.id === staged).public, false);
  assert.ok(media.every(file => file.folderId === folder.id));
});

test('thumbnails are served only from managed folders, at most ten at a time', () => {
  const { ctx, activityRoot, File, Folder } = setup();
  const articleFolder = activityRoot.createFolder('Article_20260925');
  const photo = new File('photo.jpg', articleFolder);
  const result = ctx.getMediaThumbnails('session', articleFolder.id, [photo.id, 'missing']);
  assert.equal(result[photo.id], 'data:image/png;base64,' + Buffer.from([1, 2, 3]).toString('base64'));
  assert.equal(result.missing, '');
  photo.getThumbnail = () => null;
  assert.equal(ctx.getMediaThumbnails('session', articleFolder.id, [photo.id])[photo.id], 'data:image/jpeg;base64,' + Buffer.from([4, 5]).toString('base64'));
  const outside = new Folder('Personal');
  const secret = new File('secret.jpg', outside);
  assert.throws(() => ctx.getMediaThumbnails('session', outside.id, [secret.id]), /管理している画像フォルダではありません/);
  const many = Array.from({ length: 12 }, (_, i) => new File('p' + i + '.jpg', articleFolder).id);
  assert.equal(Object.keys(ctx.getMediaThumbnails('session', articleFolder.id, many)).length, 10);
});

test('publishing opens the folders of published recruit, activity and request items to link viewers', () => {
  const { ctx, activityRoot, recruitRoot } = setup();
  const published = activityRoot.createFolder('Published_20260925');
  const hidden = activityRoot.createFolder('Hidden_20260925');
  hidden.setSharing('ANYONE_WITH_LINK');
  const thisYear = recruitRoot.createFolder('2026_20260925');
  const lastYear = recruitRoot.createFolder('2025_20250401');
  ctx.finalizeManagedFolders_({
    exhibitions: [],
    activityArticles: [{ title: 'Published', mediaFolderId: published.id, published: true },
      { title: 'Hidden', mediaFolderId: hidden.id, published: false }],
    recruitCalendars: [{ label: '2026', mediaFolderId: thisYear.id, published: true },
      { label: '2025', mediaFolderId: lastYear.id, published: false }],
    requestCases: []
  });
  assert.equal(published.access, 'ANYONE_WITH_LINK');
  assert.equal(hidden.access, 'PRIVATE');
  assert.equal(thisYear.access, 'ANYONE_WITH_LINK');
  assert.equal(lastYear.access, 'PRIVATE');
});

test('publishing again without changes leaves Drive alone; only changed items are processed', () => {
  const { ctx, activityRoot, item } = setup();
  const first = activityRoot.createFolder('First_20260925');
  const second = activityRoot.createFolder('Second_20260925');
  const state = {
    exhibitions: [item],
    recruitCalendars: [],
    recruitCalendar: {},
    activityArticles: [
      { articleId: 'a1', title: 'First', mediaFolderId: first.id, mediaFileIds: [], published: true },
      { articleId: 'a2', title: 'Second', mediaFolderId: second.id, mediaFileIds: [], published: true }
    ],
    requestCases: []
  };
  ctx.finalizeManagedFolders_(state);
  const previous = JSON.parse(JSON.stringify(ctx.buildPublicSnapshot_(state)));

  let lookups = 0;
  const getFolderById = ctx.DriveApp.getFolderById;
  ctx.DriveApp.getFolderById = (id) => { lookups += 1; return getFolderById(id); };
  ctx.finalizeManagedFolders_(JSON.parse(JSON.stringify(state)), previous);
  assert.equal(lookups, 0, 'nothing changed, so no folder is opened');

  const edited = JSON.parse(JSON.stringify(state));
  edited.activityArticles[1].title = 'Second renamed';
  ctx.finalizeManagedFolders_(edited, previous);
  assert.equal(lookups, 1, 'only the renamed article is opened');
  assert.equal(second.name, 'Second renamed_20260925');
  assert.equal(first.name, 'First_20260925');

  const unpublished = JSON.parse(JSON.stringify(state));
  unpublished.activityArticles[0].published = false;
  ctx.finalizeManagedFolders_(unpublished, previous);
  assert.equal(first.access, 'PRIVATE');
  ctx.DriveApp.getFolderById = getFolderById;
});

test('an exhibition with a changed work list is reconciled even when its title is the same', () => {
  const { ctx, folder, image, item, upload } = setup();
  const state = { exhibitions: [item], recruitCalendars: [], recruitCalendar: {}, activityArticles: [], requestCases: [] };
  ctx.finalizeManagedFolders_(state);
  const previous = JSON.parse(JSON.stringify(ctx.buildPublicSnapshot_(state)));
  const added = upload().uploadedFileIds[0];
  item.workFiles.push({ fileId: added, sortOrder: 2, title: 'New', artist: 'Artist' });
  ctx.finalizeManagedFolders_(state, previous);
  assert.deepEqual(ids(folder), [image.id, added].sort());
});

test('cleanup after a publish lists, and in trash mode trashes, only what the published state no longer uses', () => {
  const { ctx, root, folder, item, activityRoot, Folder, File, upload, files } = setup();
  const kept = activityRoot.createFolder('Kept_20260925');
  const deleted = activityRoot.createFolder('Deleted article_20250101');
  const oldDraft = activityRoot.createFolder('Unsaved_下書き_20260925_1200');
  const handMade = activityRoot.createFolder('部員の写真');
  const removedExhibition = root.createFolder('Old exhibition_20240101');
  const removedStaging = root.createFolder('CMS_下書き_' + removedExhibition.id);
  // an image set aside by an earlier publish, with and without a stamp, and one set aside by this publish
  const recovery = ctx.getExhibitionAuxFolder_(folder.id, 'recovery', true);
  const earlier = new File('earlier.jpg', recovery);
  earlier.description = 'cms-unregistered-at:2026-01-01T00:00:00.000Z';
  const unstamped = new File('unstamped.jpg', recovery);
  const publishStartedAt = Date.now();
  const justNow = new File('just-now.jpg', recovery);
  justNow.description = 'cms-unregistered-at:' + new Date(publishStartedAt + 1000).toISOString();
  const state = {
    exhibitions: [item], recruitCalendars: [], recruitCalendar: {}, requestCases: [],
    activityArticles: [{ articleId: 'a', title: 'Kept', mediaFolderId: kept.id, published: true }]
  };

  const report = ctx.collectGarbage_(state, { trash: false, budgetMs: 60000, publishStartedAt });
  assert.equal(report.finished, true);
  assert.deepEqual(JSON.parse(JSON.stringify(report.lines)).sort(), [
    'フォルダ 活動記録/Deleted article_20250101（削除された項目）',
    'フォルダ 活動記録/Unsaved_下書き_20260925_1200（削除された項目）',
    'フォルダ 展示会/CMS_下書き_' + removedExhibition.id + '（削除された項目）',
    'フォルダ 展示会/Old exhibition_20240101（削除された項目）',
    '画像 展示会/CMS_未登録_' + folder.id + '/earlier.jpg（退避した画像）',
    '画像 展示会/CMS_未登録_' + folder.id + '/unstamped.jpg（退避した画像）'
  ].sort());
  assert.ok([deleted, oldDraft, removedExhibition, removedStaging].every(f => !f.trashed), 'report mode trashes nothing');
  assert.ok([earlier, unstamped].every(f => !f.trashed));

  ctx.collectGarbage_(state, { trash: true, budgetMs: 60000, publishStartedAt });
  assert.ok([deleted, oldDraft, removedExhibition, removedStaging].every(f => f.trashed));
  assert.ok(earlier.trashed && unstamped.trashed);
  assert.ok(!justNow.trashed && !kept.trashed && !handMade.trashed && !folder.trashed && !recovery.trashed);

  const late = ctx.collectGarbage_(state, { trash: false, budgetMs: -1, publishStartedAt });
  assert.equal(late.finished, false, 'stops at the time budget');
  assert.match(ctx.formatCleanupReport_(late, false), /時間切れ/);
});

test('images set aside are stamped, and the stamp is cleared when they are registered again', () => {
  const { ctx, folder, image, item, state, File } = setup();
  const other = new File('2_Other_Artist.jpg', folder);
  item.workFiles = [{ fileId: other.id, sortOrder: 1, title: 'Other', artist: 'Artist' }];
  ctx.finalizeManagedFolders_(state);
  assert.match(image.description, /^cms-unregistered-at:/);
  item.workFiles = [{ fileId: image.id, sortOrder: 1, title: 'Old', artist: 'Artist' }, { fileId: other.id, sortOrder: 2, title: 'Other', artist: 'Artist' }];
  ctx.finalizeManagedFolders_(state);
  assert.equal(image.parent, folder);
  assert.equal(image.description, '');
});

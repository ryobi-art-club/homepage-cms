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
      newBlob: (bytes, mimeType, name) => ({ bytes, mimeType, name }),
      formatDate: (_, __, format) => format === 'yyyyMMdd' ? '20260925' : '20260925_1200',
      sleep() {}
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    requireSession_: () => ({ name: 'Editor', email: 'editor@example.test' }),
    requireString_: value => String(value || ''),
    getConfig_: () => config
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
  return { ctx, root, folder, image, item, state, folders, files, File, activityRoot, upload,
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

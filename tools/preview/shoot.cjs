// 管理画面のプレビュー（out/preview.html）で全部の機能を動かし、崩れやすい画面を撮影し、
// 一度も動かなかった画面の関数を報告する。
//   npm install --prefix tools/preview
//   node tools/preview/shoot.cjs [--chrome <chrome.exe の場所>]
// 撮影した画像は tools/preview/out/shots/ に保存する。Excel の手順では SheetJS を CDN から読み込む。
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const puppeteer = require('puppeteer-core');

const chromeArg = process.argv.indexOf('--chrome');
const executablePath = chromeArg > 0 ? process.argv[chromeArg + 1]
  : process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const outDir = path.join(__dirname, 'out');
const shots = path.join(outDir, 'shots');
const fixtures = path.join(outDir, 'fixtures');
const url = pathToFileURL(path.join(outDir, 'preview.html')).href;
const panels = ['dashboard', 'exhibitions', 'activities', 'recruit', 'requests', 'logs'];
const DESKTOP = { width: 1440, height: 900 };
/* isMobile にすると、Chrome が本物のスマホと同じように viewport の指定に従う */
const MOBILE = { width: 390, height: 844, isMobile: true };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* アップロード用の1×1の PNG と、小さなテキストの目録 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const CATALOG_CSV = '番号,作者,作品名,サイズ,技法\n1,山田 花子,作品1,F10,油彩\n2,佐藤 太郎,作品2,F6,水彩\n';

(async () => {
  if (!fs.existsSync(path.join(outDir, 'preview.html'))) throw new Error('先に node tools/preview/build.cjs を実行してください。');
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(fixtures, { recursive: true });
  const imagePath = path.join(fixtures, 'upload.png');
  const csvPath = path.join(fixtures, 'catalog.csv');
  fs.writeFileSync(imagePath, PNG);
  fs.writeFileSync(csvPath, CATALOG_CSV);

  const browser = await puppeteer.launch({ executablePath, headless: true, defaultViewport: null });
  const page = await browser.newPage();
  /* 画面の大きさは CDP で変える。setViewport() は isMobile が変わるたびにページを読み込み直し、
     パソコンとスマホの撮影の間で、開いたダイアログや編集中の内容が消えてしまうため */
  const cdp = await page.createCDPSession();
  const setScreen = (screen) => cdp.send('Emulation.setDeviceMetricsOverride', {
    width: screen.width, height: screen.height, deviceScaleFactor: 1, mobile: Boolean(screen.isMobile)
  });
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
  /* confirm() は全部「OK」で進める */
  page.on('dialog', (dialog) => dialog.accept());

  /* どの関数が動いたかの記録は、ページを読み込むたびに消えるので、その前に集める */
  const coverage = [];
  const startCoverage = () => page.coverage.startJSCoverage({ includeRawScriptCoverage: true, resetOnNavigation: false });
  const collectCoverage = async () => { coverage.push(...(await page.coverage.stopJSCoverage())); };
  await startCoverage();
  const load = async (target) => {
    await collectCoverage();
    await startCoverage();
    await page.goto(target, { waitUntil: 'networkidle0' });
    /* ログインしていない状態から始める（ログインはこのタブの sessionStorage に残っている） */
    await page.evaluate(() => sessionStorage.clear());
    /* # のあとだけが違う URL に移っても、ページは読み込み直されない */
    await page.reload({ waitUntil: 'networkidle0' });
  };
  const reloadKeepingSession = async () => {
    await collectCoverage();
    await startCoverage();
    await page.reload({ waitUntil: 'networkidle0' });
    await wait(600);
  };

  let step = '';
  /* 撮影のたびに、ページが画面の幅からはみ出していないかも確かめる */
  const shot = async (name, fullPage = false) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) problems.push(`${name}: 画面の幅を ${overflow}px はみ出しています`);
    await page.screenshot({ path: path.join(shots, name + '.png'), fullPage });
  };
  /* スマホのキーボード：画面の高さ844pxのうち、キーボードの上に見えるのが420px（画面が visualViewport から読む値） */
  const simulateKeyboard = (open) => page.evaluate((isOpen) => {
    document.body.classList.toggle('keyboard-open', isOpen);
    document.documentElement.style.setProperty('--visible-height', isOpen ? '420px' : '');
    document.documentElement.style.setProperty('--visible-top', '0px');
  }, open);
  /* 入力中の欄が見えている範囲にあり、ダイアログがあればその範囲に収まっていること */
  const checkKeyboardLayout = async (name) => {
    const result = await page.evaluate(() => {
      const field = document.activeElement;
      if (field && field.scrollIntoView) field.scrollIntoView({ block: 'nearest' });
      const rect = field.getBoundingClientRect();
      const panel = document.querySelector('.media-modal:not(.hidden) .media-modal-panel');
      const topbar = getComputedStyle(document.querySelector('.topbar')).position;
      return { fieldTop: Math.round(rect.top), fieldBottom: Math.round(rect.bottom), panelBottom: panel ? Math.round(panel.getBoundingClientRect().bottom) : 0, topbar };
    });
    if (result.fieldTop < 0 || result.fieldBottom > 421 || result.panelBottom > 421 || result.topbar === 'sticky') {
      problems.push(`${name}: キーボードが開いたとき、入力欄が見えない、または場所を取っている ` + JSON.stringify(result));
    }
    await shot(name);
  };
  /* onclick がその関数の呼び出しで始まる要素のうち、押せる最初のものを押す */
  const click = async (onclick, options = {}) => {
    const found = await page.evaluate((prefix, within) => {
      const root = within ? document.querySelector(within) : document;
      const element = Array.from(root.querySelectorAll('[onclick^="' + prefix + '"]')).find((item) => !item.disabled);
      if (!element) return false;
      element.click();
      return true;
    }, onclick, options.within || '');
    if (!found) problems.push(step + ': ' + onclick + ' のボタンが見つかりません');
    await wait(options.wait || 400);
  };
  const clickId = async (id, ms = 400) => { await page.click('#' + id); await wait(ms); };
  /* 操作の途中で showError が呼ばれたら想定外なので、手順の名前と一緒に記録する */
  const watchErrors = () => page.evaluate(() => {
    const original = window.showError;
    window.showError = function (error) {
      window.unexpectedErrors.push(error && error.message ? error.message : String(error));
      return original.apply(this, arguments);
    };
    window.unexpectedErrors = [];
  });
  const checkErrors = async () => {
    const messages = await page.evaluate(() => window.unexpectedErrors.splice(0));
    messages.forEach((message) => problems.push(step + ': ' + message));
  };

  /* --- ログインと、全部のタブ --- */
  for (const [label, viewport] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
    step = label + ' ログイン';
    await setScreen(viewport);
    await load(url + '#login');
    await shot(label + '-0-login');
    await page.type('#authEmail', 'member@example.com');
    await clickId('requestOtpButton');
    if (label === 'mobile') await shot('mobile-0-login-code');
    await page.type('#authOtp', '123456');
    await clickId('verifyOtpButton', 800);
    for (const [index, panel] of panels.entries()) {
      await page.evaluate((id) => activatePanel(id), panel);
      await wait(400);
      /* プレビューは押したときだけ作るので、撮影の前に開く */
      if (label === 'desktop' && panel === 'exhibitions') await shot('desktop-preview-button');
      const opened = await page.evaluate((id) => {
        const button = document.querySelector('#panel-' + id + ' [onclick^="openPreview"]');
        if (button) button.click();
        return !!button;
      }, panel);
      if (opened) await wait(700);
      const pending = await page.evaluate((id) => document.querySelectorAll('#panel-' + id + ' img[data-thumb-id]:not([src]), #panel-' + id + ' .thumb-unavailable').length, panel);
      if (pending) problems.push(`${label} ${panel}: 表示されない画像が ${pending} 枚あります`);
      await shot(`${label}-${index + 1}-${panel}`, label === 'desktop');
    }
    /* 公開中の展示会の画像は Drive から直接読み、非公開の画像はサーバーを通して読む */
    const imageRoutes = await page.evaluate(() => ({
      exhibitionViaServer: document.querySelectorAll('#exhibitionPreview img[data-thumb-id]').length,
      activityViaServer: document.querySelectorAll('#activityPreview img[data-thumb-id]').length,
      requests: window.MOCK_BACKEND.thumbnailRequests
    }));
    if (imageRoutes.exhibitionViaServer || !imageRoutes.activityViaServer || !imageRoutes.requests) {
      problems.push(`${label}: 画像の読み込み方が想定と違います ` + JSON.stringify(imageRoutes));
    }
    /* サーバーが返せない画像は、空の枠ではなく短い文言になる */
    const unavailableShown = await page.evaluate(async () => {
      const box = document.createElement('div');
      box.innerHTML = mediaImageHtml({ id: 'missing-image', folderId: 'f-act-1' });
      document.body.appendChild(box);
      await hydrateThumbnails(box);
      const shown = !!box.querySelector('.thumb-unavailable');
      box.remove();
      return shown;
    });
    if (!unavailableShown) problems.push(`${label}: 取得できない画像に「画像を表示できません」が出ません`);
    if (label === 'mobile') {
      /* キーボードを開いて記事の本文を入力するとき：固定している上部とタブが場所を譲る */
      /* 入力欄が見えるようにページを動かすのはブラウザなので、ここでは画面をキーボードの上の大きさにする */
      await setScreen({ width: 390, height: 420, isMobile: true });
      await page.evaluate(() => { activatePanel('activities'); document.querySelector('#panel-activities [data-field="body"]').focus(); });
      await simulateKeyboard(true);
      await wait(200);
      await checkKeyboardLayout('mobile-edit-keyboard');
      await simulateKeyboard(false);
      await setScreen(MOBILE);
      await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
      /* 下へスクロールするとタブが隠れ、上へスクロールするとステータスの下に戻り、
         タブを選ぶとその先頭から表示する */
      step = 'スマホのタブ';
      const navState = () => page.evaluate(() => ({
        hidden: document.body.classList.contains('is-nav-hidden'),
        top: Math.round(document.querySelector('.sidebar-nav').getBoundingClientRect().top),
        bar: document.querySelector('.topbar').offsetHeight
      }));
      await page.evaluate(() => activatePanel('exhibitions'));
      await page.evaluate(() => window.scrollTo(0, 1200));
      await wait(400);
      if (!(await navState()).hidden) problems.push(step + ': 下へスクロールしてもタブが隠れません');
      await page.evaluate(() => window.scrollBy(0, -100));
      await wait(400);
      const shown = await navState();
      if (shown.hidden || shown.top !== shown.bar) problems.push(step + ': 上へスクロールしてもタブがステータスの下に出ません ' + JSON.stringify(shown));
      await shot('mobile-nav-scroll-up');
      await page.click('[data-panel-target="activities"]');
      await wait(300);
      if (await page.evaluate(() => window.scrollY) !== 0) problems.push(step + ': タブを選んでも一番上から表示されません');
    }
  }

  /* ほかのスマホの大きさと、横向きのスマホ：どのページも画面の幅からはみ出さないこと。
     撮影は、項目のボタンの折り返しを見るために、いちばん長いタブだけ */
  step = '機種ごとの幅';
  for (const [label, viewport] of [['320', { width: 320, height: 568 }], ['360', { width: 360, height: 780 }], ['430', { width: 430, height: 932 }], ['landscape', { width: 844, height: 390 }], ['tablet', { width: 1024, height: 1366 }]]
    .map(([name, size]) => [name, Object.assign({ isMobile: true }, size)])) {
    await setScreen(viewport);
    for (const panel of panels) {
      await page.evaluate((id) => { activatePanel(id); window.scrollTo(0, 0); }, panel);
      await wait(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) problems.push(`${label} ${panel}: 画面の幅を ${overflow}px はみ出しています`);
    }
    if (label === '360' || label === '430') {
      await page.evaluate(() => activatePanel('exhibitions'));
      await wait(300);
      await shot(`mobile${label}-2-exhibitions`);
    }
    if (label === 'tablet') {
      await page.evaluate(() => activatePanel('dashboard'));
      await wait(300);
      await shot('tablet-1-dashboard');
    }
  }
  await setScreen(MOBILE);
  /* 折りたたんだ説明は、見出しの横の ? で開く */
  await page.evaluate(() => activatePanel('exhibitions'));
  await page.click('#panel-exhibitions .help-button');
  await wait(200);
  await shot('mobile-panel-help');
  await page.click('#panel-exhibitions .help-button');
  await setScreen(DESKTOP);
  await watchErrors();

  /* --- 展示会以外の画像のダイアログ（活動記録3に7枚） --- */
  step = '活動記録の画像ダイアログ';
  await page.evaluate(() => activatePanel('activities'));
  await page.evaluate(() => openMediaDialog('activity', 2));
  await wait(500);
  await shot('mobile-dialog-activity');
  await setScreen(DESKTOP);
  await wait(300);
  await shot('desktop-dialog-activity');
  await click('moveMediaFile');
  await (await page.$('#mediaUploadInput_image')).uploadFile(imagePath);
  await click("onMediaUpload('image')", { wait: 600 });
  /* 間違えて選んだ動画は、すぐに選択から外れる */
  const videoRejected = await page.evaluate(() => {
    const input = document.getElementById('mediaUploadInput_image');
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(16)], 'movie.mov', { type: 'video/quicktime' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files.length === 0 && document.getElementById('mediaDialogStatus').classList.contains('is-error');
  });
  if (!videoRejected) problems.push(step + ': 動画を選んでも取り消されません');
  /* 大きな写真は、ブラウザで長い辺2000pxの JPEG に縮める */
  const resized = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2600;
    canvas.height = 1300;
    const context = canvas.getContext('2d');
    context.fillStyle = '#4a64d8';
    context.fillRect(0, 0, 2600, 1300);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'large-photo.png', { type: 'image/png' }));
    document.getElementById('mediaUploadInput_image').files = transfer.files;
    await onMediaUpload('image');
    const sent = window.MOCK_BACKEND.lastUpload.files[0];
    const image = new Image();
    await new Promise((resolve) => { image.onload = resolve; image.src = 'data:' + sent.mimeType + ';base64,' + sent.data; });
    return { name: sent.name, mimeType: sent.mimeType, width: image.naturalWidth, height: image.naturalHeight };
  });
  if (resized.mimeType !== 'image/jpeg' || resized.width !== 2000 || resized.height !== 1000 || !/\.jpg$/.test(resized.name)) {
    problems.push(step + ': 大きい画像が縮小されていません ' + JSON.stringify(resized));
  }
  await click('onMediaDelete');
  await click('closeMediaDialog');
  step = '新歓の画像ダイアログ';
  await page.evaluate(() => { activatePanel('recruit'); return openMediaDialog('recruit', 0); });
  await wait(400);
  await click('moveMediaFile');
  await click('closeMediaDialog');
  step = '画像のない取り組み事例に追加して全部削除';
  await page.evaluate(() => { activatePanel('requests'); return openMediaDialog('request', 1); });
  await wait(400);
  await (await page.$('#mediaUploadInput_image')).uploadFile(imagePath);
  await click("onMediaUpload('image')", { wait: 600 });
  await click('onMediaDelete');
  await click('closeMediaDialog');
  await checkErrors();

  /* 使うのは登録した画像だけ：アップロードした画像は登録に加わり、削除した画像は登録・ダイアログ・
     プレビューから外れ、ほかの画像は残る。公開の前もあとも */
  step = '画像の登録（追加・削除・公開）';
  const registration = await page.evaluate(async () => {
    const article = () => appState.state.activityArticles[0];
    const dialogIds = () => Array.from(document.querySelectorAll('#mediaDialog [onclick^="onMediaDelete"]'))
      .map((button) => button.getAttribute('onclick').match(/onMediaDelete\('([^']+)'/)[1]);
    activatePanel('activities');
    await openMediaDialog('activity', 0);
    const before = article().mediaFileIds.slice();
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'added.png', { type: 'image/png' }));
    document.getElementById('mediaUploadInput_image').files = transfer.files;
    await onMediaUpload('image');
    const afterUpload = article().mediaFileIds.slice();
    const added = afterUpload.filter((id) => before.indexOf(id) === -1);
    const removed = before[0];
    await onMediaDelete(removed, '');
    const afterDelete = article().mediaFileIds.slice();
    const dialogAfterDelete = dialogIds();
    closeMediaDialog();
    /* 開き直すとフォルダを読み直す。削除した画像は Drive には残っているが、一覧には出ない */
    await openMediaDialog('activity', 0);
    const dialogReopened = dialogIds();
    closeMediaDialog();
    openPreview('activity');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const previewImages = document.querySelectorAll('#activityPreview .preview-article')[0];
    const previewCount = previewImages ? previewImages.querySelectorAll('img').length : -1;
    const payload = JSON.parse(JSON.stringify(appState.state));
    /* モックの中だけで公開し、あとの手順のために、ほかのフォルダは元に戻す */
    const savedFolders = JSON.parse(JSON.stringify(window.PREVIEW_DATA.folders));
    const savedBootstrap = JSON.parse(JSON.stringify(window.PREVIEW_DATA.bootstrap));
    window.MOCK_BACKEND.publishState('', payload);
    const folderAfterPublish = window.PREVIEW_DATA.folders[article().mediaFolderId].map((file) => file.id);
    Object.keys(savedFolders).forEach((id) => { if (id !== article().mediaFolderId) window.PREVIEW_DATA.folders[id] = savedFolders[id]; });
    window.PREVIEW_DATA.bootstrap.drafts = savedBootstrap.drafts;
    return { before, afterUpload, added, removed, afterDelete, dialogAfterDelete, dialogReopened, previewCount, folderAfterPublish };
  });
  const expected = registration.before.slice(1).concat(registration.added);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (registration.added.length !== 1) problems.push(step + ': アップロードした画像が登録されていません ' + JSON.stringify(registration));
  if (!same(registration.afterDelete, expected)) problems.push(step + ': 削除後の登録が想定と違います ' + JSON.stringify(registration));
  if (!same(registration.dialogAfterDelete, expected) || !same(registration.dialogReopened, expected)) problems.push(step + ': 画像の一覧に、外した画像が出ているか、残すはずの画像がありません ' + JSON.stringify(registration));
  if (registration.previewCount !== expected.length) problems.push(step + ': プレビューの画像の数が登録と合いません ' + JSON.stringify(registration));
  if (!same(registration.folderAfterPublish.slice().sort(), expected.slice().sort())) problems.push(step + ': 公開後のフォルダが登録と合いません ' + JSON.stringify(registration));
  /* 画面が送る内容は、保存する内容（版2）の名前だけを使う */
  step = '送る内容の名前';
  const oldNames = await page.evaluate(() => {
    const json = JSON.stringify(buildPayloadFromDom());
    return ['workFiles', 'photoFolderId', 'driveFolderId', 'folderId', 'label', 'recruitCalendar', 'sortOrder', 'file_id']
      .filter((name) => json.indexOf('"' + name + '"') !== -1);
  });
  if (oldNames.length) problems.push(step + ': 古い名前が含まれています ' + oldNames.join(', '));
  /* 新歓カレンダーのプレビューは全部の画像を出す。› で次の画像へ */
  step = '新歓カレンダーのプレビュー';
  await page.evaluate(() => { activatePanel('recruit'); openPreview('recruit'); });
  await wait(600);
  await page.click('#recruitPreview .preview-recruit-step.is-next');
  await wait(800);
  const scrolled = await page.evaluate(() => document.querySelector('#recruitPreview .preview-recruit-track').scrollLeft);
  if (!(scrolled > 0)) problems.push(step + ': 次の画像に進めません');
  await checkErrors();

  /* --- 展示会のダイアログ：並べ替え・アップロード・目録の読み込み（テキスト、Excel）・削除 --- */
  step = '展示会の画像ダイアログ';
  await page.evaluate(() => { activatePanel('exhibitions'); return openMediaDialog('exhibition', 0); });
  await wait(600);
  await click('moveExhibitionDm');
  await click('moveExhibitionWork');
  await (await page.$('#mediaUploadInput_work')).uploadFile(imagePath);
  await click("onMediaUpload('work')", { wait: 600 });
  step = '目録の読み込み（テキスト）';
  await (await page.$('#catalogFileInput')).uploadFile(csvPath);
  await click('onCatalogFileExtract', { wait: 800 });
  await page.evaluate(() => {
    const selects = document.querySelectorAll('[data-field="catalogItem"]');
    [selects[0], selects[1]].forEach((select, index) => {
      select.value = select.options[index === 0 ? 3 : 1].value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  await wait(300);
  await click('sortExhibitionWorksByCatalogOrder', { wait: 600 });
  const showCatalog = () => page.evaluate(() => {
    document.querySelector('.catalog-details').open = true;
    document.querySelector('.catalog-import-section').scrollIntoView();
  });
  await showCatalog();
  await shot('desktop-dialog-catalog');
  await setScreen(MOBILE);
  await wait(300);
  await showCatalog();
  await shot('mobile-dialog-catalog');
  /* キーボードを開いて作品名を入力する */
  await page.evaluate(() => document.querySelector('.media-work-card [data-field="title"]').focus());
  await simulateKeyboard(true);
  await wait(200);
  await checkKeyboardLayout('mobile-dialog-keyboard');
  await simulateKeyboard(false);
  await setScreen(DESKTOP);
  await click('clearCatalogDraftAndRender');
  await checkErrors();

  step = '目録の読み込み（Excel）';
  let sheetJs = '';
  try {
    sheetJs = await page.evaluate(async () => {
      const XLSX = await loadSheetJs();
      const sheet = XLSX.utils.aoa_to_sheet([['番号', '作者', '作品名'], [1, '山田 花子', '作品1']]);
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, '出品目録');
      const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'catalog.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      document.getElementById('catalogFileInput').files = transfer.files;
      return XLSX.version;
    });
    await click('onCatalogFileExtract', { wait: 800 });
    const text = await page.evaluate(() => {
      const request = window.MOCK_BACKEND.lastCatalogRequest;
      return request && request.parts[0].text || '';
    });
    if (!/## シート: 出品目録\n番号,作者,作品名\n1,山田 花子,作品1/.test(text)) problems.push(step + ': Excel の内容を読み取れていません: ' + text);
  } catch (error) {
    problems.push(step + ': ' + error.message);
  }
  await click('clearCatalogDraftAndRender');
  await click('onMediaDelete', { within: '#mediaDialogBody' });
  await click('closeMediaDialog');
  await checkErrors();

  /* --- 全部の一覧の編集：追加・公開の切り替え・移動・削除・入力 --- */
  /* 会期の表示：手で直して確定（ボタン・Enter）、Esc で取り消し、自動に戻す。
     日付を変えると、手で直している途中でも作り直す */
  step = '会期表示';
  await page.evaluate(() => activatePanel('exhibitions'));
  const dateLine = () => page.evaluate(() => {
    const box = document.querySelector('[data-exhibition-item] [data-date-line]');
    const input = box.querySelector('input');
    return { text: input.value, manual: box.hasAttribute('data-manual'), editing: box.hasAttribute('data-editing'), readOnly: input.readOnly };
  });
  const typeDateLine = (text) => page.evaluate((value) => {
    const input = document.querySelector('[data-exhibition-item] [data-field="dateLine"]');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  const expectDateLine = async (label, expected) => {
    const actual = await dateLine();
    if (Object.keys(expected).some((key) => actual[key] !== expected[key])) problems.push(`${step}: ${label} ${JSON.stringify(actual)}`);
  };
  await click('editExhibitionDateLine');
  await expectDateLine('編集を始めても入力欄になりません', { editing: true, readOnly: false });
  await typeDateLine('2026年11月14日(土)〜18日(水)');
  await shot('desktop-dateline-editing');
  await click('finishExhibitionDateLine');
  await expectDateLine('完了しても手入力として確定しません', { text: '2026年11月14日(土)〜18日(水)', manual: true, editing: false, readOnly: true });
  await click('editExhibitionDateLine');
  await typeDateLine('取り消す文字');
  await page.keyboard.press('Escape');
  await wait(200);
  await expectDateLine('Esc で取り消せません', { text: '2026年11月14日(土)〜18日(水)', manual: true, editing: false });
  await click('resetExhibitionDateLine');
  await expectDateLine('自動に戻りません', { text: '2026年11月14日(土)〜11月18日(水)', manual: false });
  await click('editExhibitionDateLine');
  await typeDateLine('');
  await page.keyboard.press('Enter');
  await wait(200);
  await expectDateLine('空欄で確定しても自動の表示に戻りません', { text: '2026年11月14日(土)〜11月18日(水)', manual: false, editing: false });
  await click('editExhibitionDateLine');
  await page.evaluate(() => {
    const input = document.querySelector('[data-exhibition-item] [data-field="endDate"]');
    input.value = '2026-11-19';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await wait(400);
  await expectDateLine('日付を変えても会期表示が作り直されません', { text: '2026年11月14日(土)〜11月19日(木)', manual: false, editing: false });
  await checkErrors();

  step = '一覧の編集';
  for (const name of ['addExhibition', 'addActivityArticle', 'addRecruitYear', 'addRequestCase']) await click(name);
  for (const name of ['toggleExhibitionPublished', 'toggleExhibitionBucket', 'toggleActivityPublished', 'toggleRecruitPublished', 'toggleRequestPublished']) {
    await click(name);
    await click(name);
  }
  await click('moveRequestCase');
  await page.evaluate(() => {
    document.querySelectorAll('[oninput]').forEach((element) => element.dispatchEvent(new Event('input', { bubbles: true })));
    document.querySelectorAll('select[onchange], input[onchange]').forEach((element) => {
      if (element.getAttribute('data-field') !== 'catalogItem') element.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  await wait(600);
  await checkErrors();

  /* タイトルのない新しい項目があると、公開の前の確認で止まる（複数行の文言） */
  step = '入力チェック';
  await clickId('publishButton');
  /* 報告文つきのエラーが履歴にも残る（想定どおりなので、問題としては記録しない） */
  await page.evaluate(() => {
    showError(new Error('Failed to fetch'), '下書きの保存');
    window.unexpectedErrors.length = 0;
    const card = document.getElementById('errorReportCard');
    if (card) card.remove();
  });
  await clickId('statusHistoryButton');
  await shot('desktop-status-history');
  await page.evaluate(() => document.querySelector('#statusHistoryPanel .status-copy-button').click());
  await wait(300);
  await clickId('statusHistoryButton');
  for (const name of ['removeExhibition', 'removeActivityArticle', 'removeRecruitYear', 'removeRequestCase']) await click(name);
  await page.evaluate(() => document.querySelectorAll('[data-field="title"]').forEach((input) => {
    if (!input.value.trim()) input.value = 'プレビューで追加した項目';
  }));
  await checkErrors();

  step = '下書き';
  await page.evaluate(() => activatePanel('dashboard'));
  await click('loadDraftIntoEditor', { wait: 600 });
  await clickId('saveDraftButton', 800);
  await checkErrors();

  /* 公開：偽の誤字チェックは、いつも3項目までに指摘を付ける */
  step = '公開';
  await clickId('publishButton', 800);
  /* 公開の途中は、保存も公開も押せない */
  const locked = await page.evaluate(() => ['saveDraftButton', 'publishButton'].every((id) => document.getElementById(id).disabled));
  if (!locked) problems.push(step + ': 公開の途中でも「下書き保存」「公開する」が押せます');
  await shot('desktop-proofread');
  await setScreen(MOBILE);
  await wait(300);
  await shot('mobile-proofread');
  /* スマホのキーボードを開いた状態：ダイアログがキーボードの上の見えている範囲に収まる（画面844px、見えるのは420px） */
  await page.evaluate(() => {
    document.body.classList.add('keyboard-open');
    document.documentElement.style.setProperty('--visible-height', '420px');
    document.documentElement.style.setProperty('--visible-top', '0px');
    document.querySelector('.proofread-item textarea').focus();
  });
  await wait(200);
  const fits = await page.evaluate(() => document.querySelector('.proofread-panel').getBoundingClientRect().bottom <= 421);
  if (!fits) problems.push(step + ': キーボードが開いたとき、ダイアログが見えている範囲に収まりません');
  await shot('mobile-proofread-keyboard');
  await page.evaluate(() => document.body.classList.remove('keyboard-open'));
  await setScreen(DESKTOP);
  await page.click('[data-proofread-action="publish"]');
  await wait(1000);
  await checkErrors();

  /* --- エラーの表示 --- */
  step = 'エラー表示';
  await page.evaluate(() => activatePanel('exhibitions'));
  const errors = [
    ['error-1-user', () => showError(new Error('アップロードするファイルを選択してください。'), '画像のアップロード')],
    ['error-2-system', () => showError(new Error('GitHub Actions の起動に失敗しました: {"message":"Bad credentials","status":"401"}'), '公開')]
  ];
  for (const [name, trigger] of errors) {
    await page.evaluate(trigger);
    await wait(200);
    await shot(name);
    /* a user-side error opens the card only from 詳細 */
    if (name === 'error-1-user') {
      await page.click('#statusMessage .status-detail-button');
      await wait(200);
      await shot('error-1-user-detail');
      /* pressing 詳細 again closes it; opening the history also closes it */
      await page.click('#statusMessage .status-detail-button');
      if (await page.$('#errorReportCard')) problems.push(step + ': もう一度「詳細」を押してもカードが閉じません');
      await page.click('#statusMessage .status-detail-button');
      await clickId('statusHistoryButton', 200);
      if (await page.$('#errorReportCard')) problems.push(step + ': 履歴を開いてもカードが閉じません');
      await clickId('statusHistoryButton', 200);
    }
  }
  /* 管理者への自動の通知を設定しているときの、同じエラー */
  await page.evaluate(() => { window.MOCK_BACKEND.notifyMode = 'sent'; });
  await page.evaluate(errors[1][1]);
  await wait(200);
  await shot('error-2-system-notified');
  await page.evaluate(() => { window.MOCK_BACKEND.notifyMode = 'not_configured'; });
  await page.evaluate(errors[1][1]);
  await wait(200);
  await page.evaluate(() => document.querySelector('#errorReportCard [data-error-report-copy]').click());
  await setScreen(MOBILE);
  await shot('error-3-system-mobile');

  /* 画像のダイアログとログイン画面での、区切りのない長い文字 */
  const longId = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz';
  await setScreen(DESKTOP);
  await page.evaluate(() => { const card = document.getElementById('errorReportCard'); if (card) card.remove(); });
  await page.evaluate(() => openMediaDialog('exhibition', 0));
  await wait(500);
  await page.evaluate((id) => showError(new Error('ファイル取得に失敗しました: File not found: ' + id), '画像の削除', 'media'), longId);
  await wait(200);
  await shot('error-4-media-dialog');

  /* 読み込み直しても、有効期限の間はログインが続く。期限が切れていれば、エラーを出さずにログイン画面に戻る */
  step = 'ログインの維持';
  await page.evaluate(() => { const card = document.getElementById('errorReportCard'); if (card) card.remove(); });
  await reloadKeepingSession();
  await watchErrors();
  const shells = () => page.evaluate(() => ({
    app: !document.getElementById('appShell').classList.contains('hidden'),
    login: !document.getElementById('authShell').classList.contains('hidden'),
    message: document.getElementById('authStatus').textContent,
    saved: sessionStorage.getItem('ryobiCmsSession'),
    emailField: getComputedStyle(document.getElementById('authEmail').closest('.field')).display !== 'none'
  }));
  const resumed = await shells();
  if (!resumed.app || resumed.login) problems.push(step + ': 再読み込みでログインが切れました ' + JSON.stringify(resumed));
  await page.evaluate(() => sessionStorage.setItem('ryobiCmsSession', JSON.stringify({ token: 'expired', email: 'member@example.com' })));
  await reloadKeepingSession();
  await watchErrors();
  const expired = await shells();
  if (expired.app || !expired.login || !/有効期限/.test(expired.message) || expired.saved || !expired.emailField) problems.push(step + ': 期限切れのログインの扱いが違います ' + JSON.stringify(expired));
  await shot('desktop-login-expired');
  await checkErrors();
  await load(url + '#login');
  for (const [label, viewport] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
    await setScreen(viewport);
    await page.evaluate((id) => showError(new Error('allowlist シートが見つかりません。ID: ' + id), 'ログイン', 'auth'), longId);
    await wait(200);
    await shot('error-5-login-' + label);
  }

  await collectCoverage();
  await browser.close();

  console.log('スクリーンショットを保存しました: ' + shots + '（' + fs.readdirSync(shots).length + '枚）');
  console.log(sheetJs ? 'SheetJS ' + sheetJs + ' を整合性チェック付きで読み込めました。' : 'SheetJS を読み込めませんでした。');
  reportCoverage(coverage);
  if (problems.length) {
    console.log('画面で発生したエラー:');
    problems.forEach((problem) => console.log('  ' + problem));
    process.exitCode = 1;
  }
})();

/* 画面のスクリプト（UiCore … UiPublish）の関数のうち、一度でも動いたものを数える */
function reportCoverage(entries) {
  const sources = require(path.join(__dirname, '..', '..', 'tests', 'files.cjs'));
  const declared = new Set();
  sources.uiScriptFiles().forEach((name) => {
    for (const match of sources.read(name).matchAll(/^(?:async )?function ([A-Za-z0-9_]+)\(/gm)) declared.add(match[1]);
  });
  const executed = new Set();
  entries.forEach((entry) => (entry.rawScriptCoverage ? entry.rawScriptCoverage.functions : []).forEach((fn) => {
    if (declared.has(fn.functionName) && fn.ranges[0] && fn.ranges[0].count > 0) executed.add(fn.functionName);
  }));
  const unused = Array.from(declared).filter((name) => !executed.has(name)).sort();
  console.log(`画面の関数: ${declared.size}個中 ${executed.size}個を実行（${Math.round(executed.size / declared.size * 100)}%）`);
  if (unused.length) console.log('  一度も動かなかった関数: ' + unused.join(', '));
}

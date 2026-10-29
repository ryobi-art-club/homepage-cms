// Drives the CMS preview (out/preview.html) through every feature, takes screenshots of the screens
// that can break visually, and reports which UiScript functions never ran.
//   npm install --prefix tools/preview
//   node tools/preview/shoot.cjs [--chrome <path to chrome.exe>]
// Screenshots are written to tools/preview/out/shots/. The Excel step downloads SheetJS from its CDN.
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
const MOBILE = { width: 390, height: 844 };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* 1x1 PNG for uploads and a small text catalog */
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

  const browser = await puppeteer.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
  /* confirm() は全部「OK」で進める */
  page.on('dialog', (dialog) => dialog.accept());

  /* JS coverage is kept across page loads; collect it before every goto/reload */
  const coverage = [];
  const startCoverage = () => page.coverage.startJSCoverage({ includeRawScriptCoverage: true, resetOnNavigation: false });
  const collectCoverage = async () => { coverage.push(...(await page.coverage.stopJSCoverage())); };
  await startCoverage();
  const load = async (target) => {
    await collectCoverage();
    await startCoverage();
    await page.goto(target, { waitUntil: 'networkidle0' });
    /* moving between URLs that differ only in the hash does not reload the page */
    await page.reload({ waitUntil: 'networkidle0' });
  };

  let step = '';
  const shot = (name, fullPage = false) => page.screenshot({ path: path.join(shots, name + '.png'), fullPage });
  /* clicks the first enabled element whose onclick starts with the given function call */
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
  /* showError calls during the operation steps are unexpected; record them with the step name */
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

  /* --- login and every panel --- */
  for (const [label, viewport] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
    step = label + ' ログイン';
    await page.setViewport(viewport);
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
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) problems.push(`${label} ${panel}: 画面の幅を ${overflow}px はみ出しています`);
      await shot(`${label}-${index + 1}-${panel}`, label === 'desktop');
    }
  }
  await watchErrors();

  /* --- image dialogs other than exhibitions (7 images in activity 3) --- */
  step = '活動記録の画像ダイアログ';
  await page.evaluate(() => activatePanel('activities'));
  await page.evaluate(() => openMediaDialog('activity', 2));
  await wait(500);
  await shot('mobile-dialog-activity');
  await page.setViewport(DESKTOP);
  await wait(300);
  await shot('desktop-dialog-activity');
  await click('moveMediaFile');
  await (await page.$('#mediaUploadInput_image')).uploadFile(imagePath);
  await click("onMediaUpload('image')", { wait: 600 });
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

  /* --- exhibition dialog: reorder, upload, catalog import (text, then Excel), delete --- */
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
  await page.setViewport(MOBILE);
  await wait(300);
  await showCatalog();
  await shot('mobile-dialog-catalog');
  await page.setViewport(DESKTOP);
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

  /* --- editing every list: add, publish toggle, move, remove, typing --- */
  step = '一覧の編集';
  await click('autofillExhibitionMap');
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

  /* publishing with the new untitled items fails validation: a multi-line message */
  step = '入力チェック';
  await clickId('publishButton');
  /* an error with a report in the history as well (expected, so it is not recorded as a problem) */
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

  /* publish: the fake proofreader always flags up to 3 fields */
  step = '公開';
  await clickId('publishButton', 800);
  await shot('desktop-proofread');
  await page.setViewport(MOBILE);
  await wait(300);
  await shot('mobile-proofread');
  await page.setViewport(DESKTOP);
  await page.click('[data-proofread-action="publish"]');
  await wait(1000);
  await checkErrors();

  /* --- error displays --- */
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
  }
  await page.evaluate(() => document.querySelector('#errorReportCard [data-error-report-copy]').click());
  await page.setViewport(MOBILE);
  await shot('error-3-system-mobile');

  /* long unbroken text inside the image dialog and on the login screen */
  const longId = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz';
  await page.setViewport(DESKTOP);
  await page.evaluate(() => { const card = document.getElementById('errorReportCard'); if (card) card.remove(); });
  await page.evaluate(() => openMediaDialog('exhibition', 0));
  await wait(500);
  await page.evaluate((id) => showError(new Error('ファイル取得に失敗しました: File not found: ' + id), '画像の削除', 'media'), longId);
  await wait(200);
  await shot('error-4-media-dialog');
  await load(url + '#login');
  for (const [label, viewport] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
    await page.setViewport(viewport);
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

/* Counts the functions declared in UiScript that ran at least once in any page load */
function reportCoverage(entries) {
  const scripts = entries.filter((entry) => entry.text && entry.text.includes('function showError('));
  const declared = new Set();
  scripts.forEach((entry) => {
    for (const match of entry.text.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)\(/gm)) declared.add(match[1]);
  });
  const executed = new Set();
  scripts.forEach((entry) => (entry.rawScriptCoverage ? entry.rawScriptCoverage.functions : []).forEach((fn) => {
    if (declared.has(fn.functionName) && fn.ranges[0] && fn.ranges[0].count > 0) executed.add(fn.functionName);
  }));
  const unused = Array.from(declared).filter((name) => !executed.has(name)).sort();
  console.log(`UiScript の関数: ${declared.size}個中 ${executed.size}個を実行（${Math.round(executed.size / declared.size * 100)}%）`);
  if (unused.length) console.log('  一度も動かなかった関数: ' + unused.join(', '));
}

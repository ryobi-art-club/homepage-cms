// Takes screenshots of every CMS panel (desktop and mobile) and of the error displays from out/preview.html.
//   npm install --prefix tools/preview
//   node tools/preview/shoot.cjs [--chrome <path to chrome.exe>]
// Screenshots are written to tools/preview/out/shots/.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const puppeteer = require('puppeteer-core');

const chromeArg = process.argv.indexOf('--chrome');
const executablePath = chromeArg > 0 ? process.argv[chromeArg + 1]
  : process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const outDir = path.join(__dirname, 'out');
const shots = path.join(outDir, 'shots');
const url = pathToFileURL(path.join(outDir, 'preview.html')).href;
const panels = ['dashboard', 'exhibitions', 'activities', 'recruit', 'requests', 'logs'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  if (!fs.existsSync(path.join(outDir, 'preview.html'))) throw new Error('先に node tools/preview/build.cjs を実行してください。');
  fs.mkdirSync(shots, { recursive: true });
  const browser = await puppeteer.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });

  for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    await page.setViewport({ width, height });
    await page.goto(url + '#login', { waitUntil: 'networkidle0' });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.screenshot({ path: path.join(shots, `${label}-0-login.png`) });
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.reload({ waitUntil: 'networkidle0' });
    await wait(500);
    for (const [index, panel] of panels.entries()) {
      await page.evaluate((id) => activatePanel(id), panel);
      await wait(400);
      await page.screenshot({ path: path.join(shots, `${label}-${index + 1}-${panel}.png`), fullPage: label === 'desktop' });
    }
  }

  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluate(() => activatePanel('exhibitions'));
  const errors = [
    ['error-1-user', () => showError(new Error('アップロードするファイルを選択してください。'), '画像のアップロード')],
    ['error-2-system', () => showError(new Error('GitHub Actions の起動に失敗しました: {"message":"Bad credentials","status":"401"}'), '公開')]
  ];
  for (const [name, trigger] of errors) {
    await page.evaluate(trigger);
    await wait(200);
    await page.screenshot({ path: path.join(shots, `${name}.png`) });
  }
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(shots, 'error-3-system-mobile.png') });

  await browser.close();
  console.log('スクリーンショットを保存しました: ' + shots);
  if (problems.length) {
    console.log('画面で発生したエラー:');
    problems.forEach((problem) => console.log('  ' + problem));
  }
})();

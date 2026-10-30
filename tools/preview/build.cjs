// 見本のデータで、手元で開ける管理画面のプレビューを作る。Ui.html を HtmlService と同じように組み立て、
// 偽のサーバー（モック）を足す。
//   node tools/preview/build.cjs   ->  tools/preview/out/preview.html
const fs = require('node:fs');
const path = require('node:path');

const cmsDir = path.resolve(__dirname, '..', '..');
const outDir = path.join(__dirname, 'out');
const read = (name) => fs.readFileSync(path.join(cmsDir, name), 'utf8');
const data = require('./sample-data.cjs');

// データに「</script>」が含まれてもスクリプトが途中で終わらないように、「<」を書き換える
const injected = '<script>\nwindow.PREVIEW_DATA = ' + JSON.stringify(data).replace(/</g, '\\u003c') + ';\n' +
  fs.readFileSync(path.join(__dirname, 'mock-backend.js'), 'utf8') + '\n</script>\n';
// モックは、それを呼ぶ最初の画面のスクリプト（UiCore）の前に置く
const html = read('Ui.html').replace(/<\?!= include\('(\w+)'\); \?>/g, (_, name) => (name === 'UiCore' ? injected : '') + read(name + '.html'));
if (html.indexOf(injected) < 0) throw new Error('UiCore を読み込む位置が見つかりません。');
// 本物では doGet() が addMetaTag() で足す。これがないと、スマホ（や Chrome の端末表示）はページを幅980pxで表示する
const viewportTag = '<meta name="viewport" content="width=device-width, initial-scale=1">';
const withViewport = html.replace(/(<meta charset="UTF-8">)/, '$1\n    ' + viewportTag);
if (withViewport === html) throw new Error('viewport を入れる位置（<meta charset="UTF-8">）が見つかりません。');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'preview.html'), withViewport);
console.log('プレビューを作成しました: ' + path.join(outDir, 'preview.html'));

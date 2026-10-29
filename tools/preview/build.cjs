// Builds a local preview of the CMS with sample data: Ui.html assembled the way HtmlService does it,
// plus a read-only fake backend.
//   node tools/preview/build.cjs   ->  tools/preview/out/preview.html
const fs = require('node:fs');
const path = require('node:path');

const cmsDir = path.resolve(__dirname, '..', '..');
const outDir = path.join(__dirname, 'out');
const read = (name) => fs.readFileSync(path.join(cmsDir, name), 'utf8');
const data = require('./sample-data.cjs');

const html = read('Ui.html').replace(/<\?!= include\('(\w+)'\); \?>/g, (_, name) => read(name + '.html'));
// doGet() adds this with addMetaTag(); without it a phone (or Chrome's device mode) lays the page out 980px wide.
const viewportTag = '<meta name="viewport" content="width=device-width, initial-scale=1">';
const withViewport = html.replace(/(<meta charset="UTF-8">)/, '$1\n    ' + viewportTag);
if (withViewport === html) throw new Error('viewport を入れる位置（<meta charset="UTF-8">）が見つかりません。');
const marker = withViewport.search(/<script>\r?\nconst appState/);
if (marker < 0) throw new Error('UiScript の開始位置が見つかりません。');
// Escape "<" so that data containing "</script>" cannot end the inline script.
const injected = '<script>\nwindow.PREVIEW_DATA = ' + JSON.stringify(data).replace(/</g, '\\u003c') + ';\n' +
  fs.readFileSync(path.join(__dirname, 'mock-backend.js'), 'utf8') + '\n</script>\n';

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'preview.html'), withViewport.slice(0, marker) + injected + withViewport.slice(marker));
console.log('プレビューを作成しました: ' + path.join(outDir, 'preview.html'));

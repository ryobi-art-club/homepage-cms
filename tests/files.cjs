// テストで読み込むファイル
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

// サーバーのファイル（GAS に送る .js 全部）。テストが偽物として渡した関数や値は、読み込んだあとも偽物のまま残す
function loadServer(ctx) {
  const stubs = Object.assign({}, ctx);
  fs.readdirSync(root).filter((name) => name.endsWith('.js')).sort()
    .forEach((name) => vm.runInContext(read(name), ctx, { filename: name }));
  Object.assign(ctx, stubs);
  return ctx;
}

// 画面のスクリプト（Ui.html が読み込む順）
function uiScriptFiles() {
  return Array.from(read('Ui.html').matchAll(/<\?!= include\('(\w+)'\); \?>/g), (match) => match[1] + '.html')
    .filter((name) => read(name).trimStart().startsWith('<script>'));
}

function uiScriptSource(name) {
  return read(name).replace(/^\s*<script>\s*/, '').replace(/\s*<\/script>\s*$/, '');
}

function loadClient(globals = {}) {
  const ctx = vm.createContext(Object.assign({ document: { addEventListener() {} } }, globals));
  uiScriptFiles().forEach((name) => vm.runInContext(uiScriptSource(name), ctx, { filename: name }));
  return ctx;
}

module.exports = { loadServer, uiScriptFiles, uiScriptSource, loadClient, read };

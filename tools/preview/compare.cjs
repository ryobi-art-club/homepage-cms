// 見た目と動きを変えない作業（作りの整理など）の確認に使う。shoot.cjs のあとに動かす。
//   node tools/preview/compare.cjs --save <控えのフォルダ>   いまの撮影の画像と、画面がサーバーに送った内容を控えに取る
//   node tools/preview/compare.cjs <控えのフォルダ>          控えと比べる（画像は1画素ずつ。送った内容は、名前の並び順のほかを1文字ずつ）
// 違う画像があれば、違う画素に印を付けた画像を out/diff/ に書き、終了コード 1 で終わる。
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

const outDir = path.join(__dirname, 'out');
const shotsDir = path.join(outDir, 'shots');
const callsFile = path.join(outDir, 'server-calls.json');
const diffDir = path.join(outDir, 'diff');

const save = process.argv[2] === '--save';
const baselineDir = process.argv[save ? 3 : 2];
if (!baselineDir) {
  console.error('控えのフォルダを指定してください。');
  process.exit(2);
}

if (save) {
  fs.rmSync(baselineDir, { recursive: true, force: true });
  fs.mkdirSync(baselineDir, { recursive: true });
  fs.cpSync(shotsDir, path.join(baselineDir, 'shots'), { recursive: true });
  fs.copyFileSync(callsFile, path.join(baselineDir, 'server-calls.json'));
  console.log('控えに取りました：' + baselineDir);
  process.exit(0);
}

const problems = [];
const pngs = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith('.png')).sort();
const baseline = pngs(path.join(baselineDir, 'shots'));
const current = pngs(shotsDir);
fs.rmSync(diffDir, { recursive: true, force: true });
fs.mkdirSync(diffDir, { recursive: true });
baseline.filter((name) => !current.includes(name)).forEach((name) => problems.push(name + '：撮影されていません'));
current.filter((name) => !baseline.includes(name)).forEach((name) => problems.push(name + '：控えにありません'));
baseline.filter((name) => current.includes(name)).forEach((name) => {
  const before = PNG.sync.read(fs.readFileSync(path.join(baselineDir, 'shots', name)));
  const after = PNG.sync.read(fs.readFileSync(path.join(shotsDir, name)));
  if (before.width !== after.width || before.height !== after.height) {
    problems.push(`${name}：大きさが違います（${before.width}×${before.height} → ${after.width}×${after.height}）`);
    return;
  }
  const diff = new PNG({ width: before.width, height: before.height });
  const count = pixelmatch(before.data, after.data, diff.data, before.width, before.height, { threshold: 0 });
  if (count) {
    fs.writeFileSync(path.join(diffDir, name), PNG.sync.write(diff));
    problems.push(`${name}：${count}画素が違います`);
  }
});

const beforeCalls = JSON.parse(fs.readFileSync(path.join(baselineDir, 'server-calls.json'), 'utf8'));
const afterCalls = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
/* 名前の並び順は比べない（中身が同じなら同じとする）。配列の並び順は比べる */
const sortedKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((out, key) => Object.assign(out, { [key]: sortedKeys(value[key]) }), {});
};
const firstDifference = (a, b, at) => {
  if (JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b))) return '';
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set(Object.keys(a).concat(Object.keys(b)))) {
      const found = firstDifference(a[key], b[key], at + (Array.isArray(a) ? '[' + key + ']' : '.' + key));
      if (found) return found;
    }
  }
  return at + '：' + JSON.stringify(a) + ' → ' + JSON.stringify(b);
};
const callDifference = firstDifference(beforeCalls, afterCalls, '送った内容');
if (callDifference) problems.push(callDifference.slice(0, 400));

console.log(`画像${baseline.length}枚と、サーバーへの呼び出し${beforeCalls.length}件を比べました。`);
if (problems.length) {
  problems.forEach((problem) => console.log('  ' + problem));
  if (fs.readdirSync(diffDir).length) console.log('違う場所に印を付けた画像：' + diffDir);
  process.exitCode = 1;
} else {
  console.log('すべて同じです。');
}

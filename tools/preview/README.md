# CMS ローカルプレビュー

管理画面（`Ui.html` + `UiScript.html` + `UiStyles.html`）を、GAS にデプロイせずに手元のブラウザで確認するための道具です。
見た目の調整を、`clasp push` の前に確認できます。

- このフォルダは `.claspignore` で除外しているので、GAS には送られません。
- サンプルデータで表示します。Google には一切接続しません。保存・公開・アップロード・削除のボタンを押しても「プレビューではできません」というエラーになるだけです。

## 1. プレビューを作る

```powershell
node tools/preview/build.cjs
```

`tools/preview/out/preview.html` をブラウザで開くと、ログイン後の画面が表示されます。
URL の末尾に `#login` を付けて開くと、ログイン画面を確認できます。
`UiScript.html` や `UiStyles.html` を変更したら、もう一度実行してください（1秒かかりません）。

## 2. スクリーンショットを撮る（任意）

全タブのデスクトップ・スマホ表示と、エラー表示を `tools/preview/out/shots/` に保存します。Chrome が必要です。

```powershell
npm install --prefix tools/preview
node tools/preview/shoot.cjs
```

Chrome が標準の場所にない場合は `--chrome <chrome.exe のパス>` を付けてください。
画面内で JavaScript のエラーが起きた場合は、最後に一覧が表示されます。

## サンプルデータについて

[`sample-data.cjs`](sample-data.cjs) には、本番で表示が崩れやすいケースをわざと入れています。

- 長いタイトル・説明文・会場名、長い URL を含む本文
- 作品 24 点の展示会（縦長・横長・パノラマが混在、作品名や作者名が空の作品あり）
- 画像 7 枚の活動記録（「+3」表示）、画像のない取り組み事例
- 非公開の記事・展示会・年度、長い名前の部員による下書き

本番で表示崩れが見つかったら、同じ条件のデータをここに追加しておくと、次から手元で確認できます。

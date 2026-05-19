# homepage-cms — 開発者向けドキュメント

凌美会ホームページの**CMS（コンテンツ管理システム）**です。  
Google Apps Script（GAS）Web アプリとして動作し、スプレッドシートに記録されたコンテンツを編集・公開するための管理画面を提供します。

---

## 目次

1. [システム全体の流れ](#1-システム全体の流れ)
2. [ファイル構成](#2-ファイル構成)
3. [各ファイルの詳細](#3-各ファイルの詳細)
4. [外部リソース構成](#4-外部リソース構成)
5. [Script Properties（環境変数）](#5-script-properties環境変数)
6. [スプレッドシートのシート構成](#6-スプレッドシートのシート構成)
7. [Google Drive フォルダ構成](#7-google-drive-フォルダ構成)
8. [認証フロー](#8-認証フロー)
9. [セットアップ手順](#9-セットアップ手順)
10. [デプロイ（clasp）](#10-デプロイclasp)

---

## 1. システム全体の流れ

```
ブラウザ（管理者）
    │
    │ GAS Web App URL でアクセス
    ▼
homepage-cms（Google Apps Script）
    │
    ├── 認証（OTP メール送信 → セッション発行）
    │
    ├── コンテンツ読み書き → Google スプレッドシート
    │
    ├── 画像管理 → Google Drive
    │
    └── 公開ボタン → GitHub Actions ワークフロー起動
                         │
                         ▼
                    homepage リポジトリ
                    （Python ビルド → GitHub Pages へデプロイ）
```

管理画面で「公開する」をクリックすると、GitHub Actions が起動し、スプレッドシートのデータと Drive の画像を読み込んで静的サイトをビルド・デプロイします。CMS 側にはビルド結果は保存されません。

---

## 2. ファイル構成

```
homepage-cms/
├── appsscript.json   GAS マニフェスト（OAuth スコープ、ランタイム設定）
├── .clasp.json       clasp 設定（スクリプト ID）
├── .claspignore      clasp push 除外ファイル
├── .gitignore
│
├── Code.js           GAS エントリーポイント（doGet）
├── Config.js         設定管理・ユーティリティ関数群
├── Auth.js           OTP 認証・セッション管理・許可リスト
├── Store.js          コンテンツ CRUD・下書き・変更ログ・公開処理
├── DriveGateway.js   Google Drive 操作（ファイル・フォルダ管理）
├── Github.js         GitHub Actions ワークフロー起動
│
├── Ui.html           メイン HTML テンプレート（GAS テンプレート形式）
├── UiScript.html     フロントエンド JavaScript
├── UiStyles.html     フロントエンド CSS
│
└── docs/
    └── index.html    利用者向けマニュアル
```

---

## 3. 各ファイルの詳細

### `Code.js` — GAS エントリーポイント

| 関数 | 役割 |
|------|------|
| `doGet()` | Web アプリのエントリーポイント。`Ui.html` をテンプレートとして評価して返す |
| `include(filename)` | HTML テンプレートの `<?!= include('...'); ?>` 呼び出し用ヘルパー。UiScript・UiStyles をインライン展開する |

---

### `Config.js` — 設定管理・ユーティリティ

| 関数 | 役割 |
|------|------|
| `getConfig_()` | Script Properties から全設定値を取得する。必須キーが欠けていれば例外を投げる |
| `buildDefaultPreviewUrl_()` | `SITE_PREVIEW_URL` が未設定の場合に `https://{GH_OWNER}.github.io/{GH_REPO}/` を構築 |
| `sha256Hex_(value)` | OTP コードのハッシュ化に使用 |
| `requireString_()` | 入力値のバリデーション（空チェック・最大長チェック）|
| `cleanMultiline_()` | 改行を含む入力値の正規化 |

定数 `CONTENT_SHEETS` にはスプレッドシートの各シート名を定義しています。シート名を変更する場合はここを更新してください。

```javascript
const CONTENT_SHEETS = {
  recruit:        'Recruit',
  activityArticles: 'ActivityArticles',
  exhibitions:    'Exhibitions',
  requestCases:   'RequestCases',
  changeLog:      'ChangeLog',
  publishedState: '_PublishedState',
  drafts:         '_Drafts',
  adminLog:       '_AdminLog'
};
```

---

### `Auth.js` — OTP 認証・セッション管理

**認証の仕組み：メールアドレス OTP（ワンタイムパスワード）方式**

1. ユーザーがメールアドレスを入力 → `requestOtp(email)` を呼び出し
2. 許可リスト（別スプレッドシート）に存在するか確認
3. 6桁乱数コードを生成し SHA-256 ハッシュで GAS Cache に保存（有効期限付き）
4. コードをメール送信
5. ユーザーがコードを入力 → `verifyOtp(email, code)` を呼び出し
6. ハッシュ照合成功でセッショントークン（UUID）を GAS Cache に保存
7. 以降の API 呼び出しはすべてセッショントークンを引数として渡す

| 関数 | 役割 |
|------|------|
| `requestOtp(email)` | OTP 生成・メール送信。Cache に `otp:{email}` キーで保存 |
| `verifyOtp(email, code)` | コード検証。成功でセッショントークンを発行 |
| `requireSession_(token)` | 各 API 関数の先頭で呼び出すセッション検証。Cache に `session:{token}` キーが存在しなければ例外 |
| `getAllowedUserByEmail_(email)` | 許可リストスプレッドシートの `allowlist` シートから該当行を取得 |

**セキュリティ仕様：**
- OTP 有効期限：デフォルト 10 分（`OTP_TTL_MINUTES` で変更可）
- OTP 誤入力上限：5 回（超過でキャッシュを削除し無効化）
- セッション有効期限：デフォルト 30 分（`SESSION_TTL_MINUTES` で変更可）
- コードは平文でキャッシュに保存されず、SHA-256 ハッシュのみ保存

**許可リストスプレッドシートのフォーマット：**

| name | email |
|------|-------|
| 部長 田中 | tanaka@example.com |
| 副部長 鈴木 | suzuki@example.com |

---

### `Store.js` — コンテンツ管理（最重要ファイル）

管理画面のコンテンツ読み書きロジックをすべて担います。

**公開 API（フロントエンドから呼び出される関数）：**

| 関数 | 役割 |
|------|------|
| `getBootstrapData(sessionToken)` | 画面初期化に必要なデータを一括取得（コンテンツ・下書き・Drive フォルダ一覧・管理ログ・ストレージ状況）|
| `saveDraft(sessionToken, payload)` | 下書きをスプレッドシートの `_Drafts` シートに保存 |
| `loadDraft(sessionToken, draftId)` | 下書き ID を指定して payload を取得 |
| `previewSiteHistory(sessionToken, payload)` | 公開前に更新履歴の差分プレビューを生成 |
| `publishState(sessionToken, payload)` | コンテンツをスプレッドシートに書き込み → 変更ログ更新 → GitHub Actions 起動 |

**内部フロー（`publishState` の詳細）：**

```
payload 受信
    │
    ├── normalizePayload_() — バリデーション・正規化
    │
    ├── finalizeManagedFolders_() — Drive フォルダ名の同期
    │
    ├── writeStateToSheets_() — スプレッドシートへ書き込み
    │
    ├── summarizeChange_() — 変更内容のテキスト要約を生成
    │
    ├── appendChangeLog_() — 変更ログシートに追記
    │
    ├── writePublishedState_() — _PublishedState シートを更新（SHA-256 で差分検知）
    │
    ├── clearDrafts_() — 下書きをクリア
    │
    ├── cleanupUnreferencedDraftFolders_() — 未参照の下書きフォルダを Drive から削除
    │
    └── dispatchGithubWorkflow_() — GitHub Actions を起動
```

**コンテンツ種別ごとの正規化ルール：**

| 種別 | 並び順 | 必須項目 | 特記事項 |
|------|--------|---------|---------|
| 新歓カレンダー | 年度降順 | — | 公開中は常に 1 件のみ |
| 活動記事 | `createdAt` 降順 | タイトル | カテゴリ: `record` / `event` / `other` |
| 展示会 | upcoming → archive、日付順 | タイトル・表示区分 | `displayBucket`: `upcoming` / `archive` |
| ご依頼事例 | `sortOrder` 昇順 | タイトル | 管理画面上の並び順で `sortOrder` が決まる |

---

### `DriveGateway.js` — Google Drive 操作

**公開 API（フロントエンドから呼び出される関数）：**

| 関数 | 役割 |
|------|------|
| `listDriveFolders(sessionToken)` | 各コンテンツ種別のルートフォルダ配下のフォルダ一覧を返す |
| `getFolderImages(sessionToken, folderId)` | フォルダ内の画像ファイル一覧を返す |
| `getFolderMedia(sessionToken, folderId)` | フォルダ内のすべてのメディア（画像・PDF）一覧を返す |
| `uploadManagedFiles(sessionToken, request)` | ブラウザからのファイルアップロードを受け付け Drive に保存 |
| `renameManagedFile(sessionToken, request)` | ファイル名を変更 |
| `trashManagedFile(sessionToken, request)` | ファイルをゴミ箱に移動（フォルダが空になれば自動削除）|
| `saveMediaSettings(sessionToken, request)` | 展示会の DM 画像・作品ファイルの整理順を保存 |

**フォルダ命名規則：**

- 下書き中：`{タイトル}_下書き_{yyyyMMdd_HHmm}`
- 公開後：`{タイトル}_{yyyyMMdd}`（作成日を付与）

**フォルダ共有設定（展示会のみ）：**
- 公開状態：リンクを知っている全員が閲覧可（アーカイブページからリンク）
- 非公開状態：プライベート（URL 直接アクセス不可）

**Drive API のリトライ：**  
`retryDriveOperation_()` により最大 4 回、指数バックオフでリトライします（Drive API のレート制限対策）。

---

### `Github.js` — GitHub Actions 起動

| 関数 | 役割 |
|------|------|
| `dispatchGithubWorkflow_()` | GitHub Actions の `workflow_dispatch` API を呼び出す |
| `getGithubToken_()` | `GH_AUTH_MODE` に応じて PAT または GitHub App JWT を取得 |
| `createGithubAppJwt_()` | GitHub App 用の RS256 署名付き JWT を生成 |

**認証モード：**
- `PAT`：`GH_FINE_GRAINED_PAT` に保存した Fine-grained Personal Access Token を使用
- `APP`（デフォルト）：GitHub App の秘密鍵から JWT を生成し、Installation Access Token を取得して使用

---

### `Ui.html` — メイン HTML テンプレート

GAS の `HtmlService.createTemplateFromFile()` で処理されます。  
`<?!= include('UiScript'); ?>` と `<?!= include('UiStyles'); ?>` の部分が、それぞれ UiScript.html・UiStyles.html の内容に置換されて配信されます。

**画面構成：**

```
authShell（未認証時）
│  ├── メールアドレス入力フォーム
│  └── 確認コード入力フォーム
│
appShell（認証後）
├── sidebar（サイドバー）
│   ├── ダッシュボード
│   ├── 展示会
│   ├── 活動記録・告知
│   ├── 入部希望の方
│   ├── ご依頼の方
│   └── 更新履歴
└── content（メインコンテンツエリア）
    ├── topbar（下書き保存・公開ボタン）
    └── 各パネル（サイドバーで切替）
```

---

### `UiScript.html` — フロントエンド JavaScript

GAS の `google.script.run` を介してサーバー側関数を呼び出します。  
すべての状態は `appState` オブジェクトで一元管理されます。

**主要な状態管理：**
- `appState.sessionToken`：認証後に保持するセッショントークン
- `appState.state`：現在の編集中コンテンツ（recruit / activity / exhibitions / requests / changeLog）
- `appState.options`：Drive フォルダ一覧（プルダウン選択肢）
- `appState.dirty`：未保存の変更があるかフラグ（ページ離脱時に警告）
- `appState.imageCache` / `appState.mediaCache`：Drive 画像の取得結果キャッシュ

**サーバー呼び出しラッパー：**
```javascript
function serverCall(functionName, ...args) // Promise を返す。エラーは reject される。
```

**HtmlService インライン JS の注意：**

`UiScript.html` は `Ui.html` にインライン展開されて GAS HtmlService から配信されます。<br>
そのため、通常のブラウザや Node.js では構文エラーにならない文字列でも、GAS 配信時に `<script>` の中身が崩れて `Uncaught SyntaxError: Invalid or unexpected token` になることがあります。

特に `UiScript.html` 内では、以下を直書きしないでください。

- `https://`
- `http://`
- `//`
- `image/*`
- SVG の `xmlns="http://www.w3.org/2000/svg"`

URL は `URL_PROTOCOL = 'https:' + String.fromCharCode(47, 47)` のように組み立て、`image/*` は `'image/' + '*'` のように分割してください。<br>
インライン SVG は `xmlns` 属性なしでも表示できます。

`clasp push` 前に以下を確認してください。

```powershell
node -e "const fs=require('fs'); const s=fs.readFileSync('UiScript.html','utf8').replace(/^<script>\s*/,'').replace(/\s*<\/script>\s*$/,''); new Function(s); console.log('UiScript OK')"
rg -n "https://|http://|image/\*|//" UiScript.html
```

`rg` が何も出さなければ OK です。<br>
このエラーが出ると `onRequestOtp` などの関数が定義されず、「確認コードを送信」ボタンを押しても反応しない状態になります。

---

## 4. 外部リソース構成

| リソース | 用途 |
|---------|------|
| Google スプレッドシート（コンテンツ用） | コンテンツデータの保存先（シート構成は §6 参照）|
| Google スプレッドシート（許可リスト用） | ログインを許可するメールアドレスの管理 |
| Google Drive（4 フォルダ）| 画像・PDF の保管先 |
| GitHub リポジトリ（homepage）| 静的サイトのビルド・公開 |
| GitHub Actions ワークフロー | 公開ボタンで起動されるビルドパイプライン |

---

## 5. Script Properties（環境変数）

GAS スクリプトエディタの「プロジェクトの設定」→「スクリプトのプロパティ」で設定します。

### 必須プロパティ

| プロパティ名 | 説明 |
|------------|------|
| `CONTENT_SPREADSHEET_ID` | コンテンツ用スプレッドシートの ID（URL の `/d/` 以降の部分）|
| `ALLOWLIST_SPREADSHEET_ID` | 許可リスト用スプレッドシートの ID |
| `ROOT_RECRUIT_FOLDER_ID` | 新歓カレンダー画像を置くルートフォルダの Drive ID |
| `ROOT_ACTIVITY_FOLDER_ID` | 活動記事画像を置くルートフォルダの Drive ID |
| `ROOT_EXHIBITION_FOLDER_ID` | 展示会画像を置くルートフォルダの Drive ID |
| `ROOT_REQUEST_FOLDER_ID` | ご依頼事例画像を置くルートフォルダの Drive ID |
| `GH_OWNER` | GitHub ユーザー名またはオーガニゼーション名（例：`ryobi-art-club`）|
| `GH_REPO` | GitHub リポジトリ名（例：`homepage`）|
| `GH_WORKFLOW_FILE` | ワークフローファイル名（例：`deploy.yml`）|
| `GH_BRANCH` | ワークフローを起動するブランチ名（例：`main`）|
| `GH_AUTH_MODE` | GitHub 認証モード：`PAT` または `APP` |

### 認証モード別の追加プロパティ

**PAT モードの場合：**

| プロパティ名 | 説明 |
|------------|------|
| `GH_FINE_GRAINED_PAT` | Fine-grained Personal Access Token（`Actions: Write` 権限が必要）|

**APP モードの場合：**

| プロパティ名 | 説明 |
|------------|------|
| `GH_APP_ID` | GitHub App の App ID |
| `GH_INSTALLATION_ID` | リポジトリへのインストール ID |
| `GH_PRIVATE_KEY` | GitHub App の秘密鍵（PEM 形式。改行は `\n` で記述）|

### 任意プロパティ

| プロパティ名 | デフォルト | 説明 |
|------------|-----------|------|
| `OTP_TTL_MINUTES` | `10` | OTP の有効期限（分）|
| `SESSION_TTL_MINUTES` | `30` | セッションの有効期限（分）|
| `SITE_PREVIEW_URL` | 自動生成 | 「サイトを開く」ボタンのリンク先 URL |

---

## 6. スプレッドシートのシート構成

### コンテンツ用スプレッドシート

#### `Recruit` — 新歓カレンダー

| カラム | 型 | 説明 |
|-------|---|------|
| `year` | 文字列 | 年度（例：`2026`）|
| `media_folder_id` | 文字列 | Drive フォルダ ID |
| `media_file_ids` | JSON 配列 | 使用するファイルの ID リスト |
| `published` | `TRUE`/`FALSE` | 公開フラグ（TRUE は 1 件のみ）|
| `updated_at` | ISO 日時 | 更新日時 |

#### `ActivityArticles` — 活動記事

| カラム | 型 | 説明 |
|-------|---|------|
| `article_id` | 文字列 | 一意の記事 ID（UUID ベース）|
| `title` | 文字列 | 記事タイトル（最大 120 文字）|
| `category` | 文字列 | `record` / `event` / `other` |
| `body` | 文字列 | 本文（最大 4000 文字、改行対応）|
| `media_folder_id` | 文字列 | 画像フォルダ ID |
| `media_file_ids` | JSON 配列 | 使用するファイルの ID リスト |
| `published` | `TRUE`/`FALSE` | 公開フラグ |
| `created_at` | ISO 日時 | 作成日時（変更不可）|
| `updated_at` | ISO 日時 | 更新日時 |

#### `Exhibitions` — 展示会

| カラム | 型 | 説明 |
|-------|---|------|
| `exhibition_id` | 文字列 | 一意の展示会 ID |
| `title` | 文字列 | 展示会名（最大 140 文字）|
| `subtitle` | 文字列 | サブタイトル（任意）|
| `theme` | 文字列 | テーマ・概要テキスト |
| `venue_name` | 文字列 | 会場名 |
| `venue_address` | 文字列 | 会場住所 |
| `date_line` | 文字列 | 会期（例：`2026年8月1日〜8日`）|
| `time_line` | 文字列 | 開場時間（例：`11:00〜18:00`）|
| `map_embed_url` | 文字列 | Google マップ埋め込み URL |
| `display_bucket` | 文字列 | `upcoming`（開催予定）/ `archive`（アーカイブ）|
| `media_folder_id` | 文字列 | 展示会メディアフォルダ ID |
| `dm_file_ids` | JSON 配列 | DM 画像のファイル ID（最大 2 件）|
| `work_files` | JSON 配列 | 作品ファイル情報（`file_id`, `title`, `artist`, `sort_order`）|
| `published` | `TRUE`/`FALSE` | 公開フラグ |
| `start_date` | `yyyy-MM-dd` | 開始日（ソート用）|
| `updated_at` | ISO 日時 | 更新日時 |

#### `RequestCases` — ご依頼事例

| カラム | 型 | 説明 |
|-------|---|------|
| `case_id` | 文字列 | 一意の事例 ID |
| `title` | 文字列 | タイトル（最大 120 文字）|
| `body` | 文字列 | 本文（最大 4000 文字）|
| `media_folder_id` | 文字列 | 画像フォルダ ID |
| `media_file_ids` | JSON 配列 | 使用するファイルの ID リスト |
| `sort_order` | 数値 | 表示順（小さいほど上に表示）|
| `published` | `TRUE`/`FALSE` | 公開フラグ |
| `updated_at` | ISO 日時 | 更新日時 |

#### `ChangeLog` — サイト更新履歴（公開向け）

| カラム | 型 | 説明 |
|-------|---|------|
| `timestamp` | ISO 日時 | 公開日時 |
| `summary` | 文字列 | 変更内容のサマリー（複数行改行区切り）|
| `actor_name` | 文字列 | 操作者名 |
| `actor_email_input` | 文字列 | 操作者メールアドレス |
| `revision` | 数値 | リビジョン番号 |

#### `_PublishedState` — 最終公開状態（内部管理）

| カラム | 型 | 説明 |
|-------|---|------|
| `updated_at` | ISO 日時 | 最終公開日時 |
| `revision` | 数値 | リビジョン番号 |
| `sha256` | 文字列 | 公開コンテンツの SHA-256（差分検知用）|
| `payload_json` | JSON | 公開時点のコンテンツスナップショット |

#### `_Drafts` — 下書き（内部管理）

| カラム | 型 | 説明 |
|-------|---|------|
| `draft_id` | UUID | 下書き ID |
| `saved_at` | ISO 日時 | 保存日時 |
| `saved_by_name` | 文字列 | 保存者名 |
| `saved_by_email` | 文字列 | 保存者メールアドレス |
| `payload_json` | JSON | 下書きのコンテンツデータ |

#### `_AdminLog` — 操作ログ（内部管理）

| カラム | 型 | 説明 |
|-------|---|------|
| `timestamp` | ISO 日時 | 操作日時 |
| `actor_name` | 文字列 | 操作者名 |
| `actor_email` | 文字列 | 操作者メールアドレス |
| `action` | 文字列 | 操作種別（`published` など）|
| `detail` | 文字列 | 操作詳細（差分サマリー）|

---

### 許可リスト用スプレッドシート

**シート名：`allowlist`**（`ALLOWLIST_SHEET_NAME` 定数で変更可）

| name | email |
|------|-------|
| 部員名 | メールアドレス |

1 行目がヘッダー行（`name` / `email` 列が必須）。`email` 列でログイン可否を判定します。

---

## 7. Google Drive フォルダ構成

各コンテンツ種別ごとに「ルートフォルダ」を用意します。  
管理画面から画像フォルダを選択すると、ルートフォルダの配下にあるフォルダが選択肢として表示されます。

```
（ルートフォルダ: 新歓カレンダー）
├── 2026年度 新歓イベントカレンダー_20260401
└── 2025年度 新歓イベントカレンダー_20250401

（ルートフォルダ: 活動記事）
├── 春の合同展_20260501
└── 六甲祭_20251101

（ルートフォルダ: 展示会）
├── 第XX回部展_20260801
└── 夏展2025_20250820

（ルートフォルダ: ご依頼事例）
├── 〇〇大学祭ポスター_20260601
└── △△店舗メニューデザイン_20251001
```

フォルダ名は公開時に自動的にコンテンツタイトルに基づいてリネームされます。

---

## 8. 認証フロー

```
ユーザー → メールアドレス入力 → requestOtp()
               ↓
       GAS Cache に OTP ハッシュを保存（TTL: 10分）
       確認コードをメールで送信
               ↓
ユーザー → コード入力 → verifyOtp()
               ↓
       ハッシュ照合（5回失敗でロック）
               ↓
       セッショントークン（UUID）を GAS Cache に保存（TTL: 30分）
               ↓
       以降の API 呼び出しにトークンを付与
```

---

## 9. セットアップ手順

### 前提条件
- Google アカウント（スクリプトのオーナー）
- clasp（Google Apps Script CLI）がインストール済み
- Node.js 環境

### 手順

#### Step 1: スプレッドシートの準備

1. Google スプレッドシートを新規作成（コンテンツ用）
2. 以下のシートを作成します（名前は完全一致が必要）：
   - `Recruit`
   - `ActivityArticles`
   - `Exhibitions`
   - `RequestCases`
   - `ChangeLog`
3. スプレッドシートの ID をメモ（URL の `https://docs.google.com/spreadsheets/d/{ID}/` の `{ID}` 部分）

4. 許可リスト用スプレッドシートを別途作成
5. `allowlist` シートを作成し、1 行目に `name` / `email` のヘッダーを追加
6. 許可するメールアドレスを入力

#### Step 2: Google Drive フォルダの準備

1. Google Drive で以下の 4 フォルダを作成：
   - 新歓カレンダー用ルートフォルダ
   - 活動記事用ルートフォルダ
   - 展示会用ルートフォルダ
   - ご依頼事例用ルートフォルダ
2. 各フォルダの ID をメモ（URL の `https://drive.google.com/drive/folders/{ID}` の `{ID}` 部分）

#### Step 3: GAS スクリプトのデプロイ

```bash
# clasp のインストール（未インストールの場合）
npm install -g @google/clasp

# Google アカウントでログイン
clasp login

# プロジェクトを push
cd homepage-cms
clasp push
```

#### Step 4: Web アプリとしてデプロイ

GAS スクリプトエディタで：
1. 「デプロイ」→「新しいデプロイ」
2. 種類：「ウェブアプリ」
3. 実行者：「デプロイしているユーザー（自分）」
4. アクセスできるユーザー：「Googleアカウントを持つ全員」
5. 「デプロイ」をクリック → Web アプリ URL をメモ

#### Step 5: Script Properties の設定

GAS スクリプトエディタの「プロジェクトの設定」→「スクリプトのプロパティ」で、§5 で説明した各プロパティを設定します。

#### Step 6: GitHub Actions の設定

GitHub リポジトリの「Settings」→「Secrets and variables」→「Actions」で：

**PAT モードの場合：**
- `GOOGLE_SERVICE_ACCOUNT_JSON`：homepage ビルド用（homepage リポジトリ側の設定）

homepage-cms 側の `GH_FINE_GRAINED_PAT` に設定する PAT には以下の権限が必要です：
- `Actions`：Read and write

---

## 10. デプロイ（clasp）

### コードの変更を GAS に反映する

```bash
cd homepage-cms
clasp push
```

### ウェブアプリを更新する

コードを push 後、GAS スクリプトエディタで：
- 「デプロイ」→「デプロイを管理」→既存のデプロイを選択→「編集」→バージョンを新しいものに変更→「デプロイ」

### ローカルに同期する

```bash
clasp pull
```

### スクリプト ID の確認

`.clasp.json` の `scriptId` フィールドがスクリプト ID です。  
GAS エディタの URL（`https://script.google.com/home/projects/{scriptId}/edit`）からも確認できます。

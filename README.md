# board-mirror

掲示板をスクレイピングして再利用するプロジェクト。2系統の仕組みで動く。

- **系統①(サイト)**: ユーザーがアクセスしたとき、Cloudflare Worker がその時点の最新を対象掲示板からリアルタイム取得して表示(短時間キャッシュあり)
- **系統②(定期バッチ)**: GitHub Actions が毎時スクレイピングし、新着スレッドの詳細を **GitHub Gist** に投稿、その **URL を Discord** に通知

```
系統①:  閲覧者 → Cloudflare Worker → 対象掲示板(リアルタイム取得)
系統②:  GitHub Actions (毎時 cron) → scraper (Node.js) → 新着スレ検出 → Gist 投稿 → Discord webhook(URLのみ)
```

スレッド一覧(→ あれば掲示板一覧)→ スレッド本文(→ 名前欄リンクの個別ページから
メールアドレス抽出)の段階で巡回し、タイトルに特定の文字列を含むスレッドだけを
抽出する(セレクタ・条件はすべて設定ファイル駆動)。

## セットアップ

### 1. スクレイパー設定

`scraper/config.example.json` をコピーして `scraper/config.json` を作成し、対象掲示板の URL と CSS セレクタを設定する。

```sh
cp scraper/config.example.json scraper/config.json
```

設定内容:

| キー | 説明 |
|---|---|
| `targetUrl` | スレッド一覧ページの URL |
| `filters.titleIncludes` | スレッドタイトルに**含まれていたら抽出**する文字列の配列(空ならすべて抽出) |
| `filters.titleExcludes` | スレッドタイトルに含まれていたら**除外**する文字列の配列 |
| `userAgent` | 取得時に送る User-Agent(連絡先を含めておくことを推奨) |
| `request.intervalMs` | リクエスト間の待機時間(ミリ秒)。対象サーバーへの負荷に配慮した値にする |
| `request.timeoutMs` / `retries` / `retryBackoffMs` | タイムアウトとリトライ(指数バックオフ) |
| `categoryList.selector` / `fields` | (オプション)スレ一覧の上位ページ(掲示板一覧)がある場合のセレクタ。`"セレクタ@属性"` 形式(`@text` / `@html` / `@href` など)。未設定なら targetUrl を直接スレ一覧として扱う |
| `threadList.selector` / `fields` | スレッド一覧ページ内の「スレッド 1 行」のセレクタと各フィールド |
| `threadList.fieldPatterns` | 行全体のテキストから正規表現で抽出するフィールド(例: レス数が `#123` のようにテキストノードに直接書かれるなど、CSS セレクタでは取れない値向け。キャプチャグループ `(1)` を使用) |
| `threadList.nextPage` / `maxPages` | スレッド一覧の「次へ」リンクのセレクタと最大取得ページ数 |
| `thread.parser` | 本文ページのパーサー。`"hr-split"`(旧式モバイル掲示板向け:`<hr>` 分割 + 正規表現)または未設定(セレクタベース `postsSelector`) |
| `thread.post.*` | hr-split パーサーの設定。`requireNumberSpan`(本物のレスの目印セレクタ)、`numberPattern` / `namePattern` / `opPattern`(スレ主本文) / `datePattern`、`imagePattern`(レス添付画像の URL。1レスに複数あるため全件マッチで `images` 配列に)、`metaPatterns`(年齢・性別・IP・機種情報などの追加フィールド抽出) |
| `thread.titleSelector` / `titleStrip` | 本文ページのスレタイ取得セレクタと、タイトルから除去する先頭パターン |
| `thread.nextPage` / `maxPages` | スレッド本文の「次へ」リンク(例: `"center a:contains('→')@href"`)と最大取得ページ数 |
| `thread.mailPage.linkPattern` / `emailPattern` | 個別ページ(メール送信ページ)からのメールアドレス抽出。本文ページの名前欄リンク URL を `linkPattern` で抽出し、その個別ページを取得して `emailPattern`(`mailto:`)でアドレスを取り出し、レスごとに `email` として保存する。**1 レス = 1 リクエストが必要なため系統②(バッチ)のみで実施**(系統①の Worker はサブリクエスト上限に収まらないためスキップ) |
| `site.cacheTtlSec` | 系統①の Worker 側キャッシュ有効期限(既定 300 秒) |
| `site.maxDetailThreads` | 系統①で本文を取得するスレッド数の上限(既定 20。Workers のサブリクエスト上限対策) |
| `site.maxThreadPages` | 系統①でスレッド本文を辿るページ数の上限(既定 2。`thread.maxPages` との小さい方が有効) |

`config.json` が存在しない場合や `MOCK=1` を指定した場合は**モックモード**(`scraper/mock/` のサンプル HTML)で動作し、実サイトに当てる前に全パイプラインを検証できる。

### 2. Cloudflare の API トークン

1. Cloudflare ダッシュボード →「マイ プロファイル」→「API トークン」でトークンを作成
   - 権限: **Account → Workers Scripts → Edit**
2. アカウント ID は Workers & Pages の概要ページ(右側)で確認

### 3. GitHub リポジトリシークレット

リポジトリの Settings → Secrets and variables → Actions に登録:

| シークレット名 | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 上記で作成した API トークン |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウント ID |
| `SCRAPER_CONFIG` | `scraper/config.json` の中身を JSON 文字列として貼り付け(省略時はモックモード) |
| `GIST_TOKEN` | **gist 権限を持つ GitHub PAT**(新着スレ詳細の gist 投稿に使用。※ Actions 既定の `GITHUB_TOKEN` では gist を作成できないため、個人の PAT が必要) |
| `DISCORD_WEBHOOK_URL` | Discord チャンネルの webhook URL(gist の URL を投稿する宛先) |

`scraper/config.json` 自体は `.gitignore` でコミット対象外のため、シークレット経由で Actions / Worker に渡す:
- 系統② はジョブ内で `scraper/config.json` として復元
- 系統① はデプロイ時に Worker secret `SCRAPER_CONFIG` として設定され、Worker が実行時に読む

## ローカルでの実行

```sh
npm install

# 系統② の動作確認(スクレイプ → Gist 投稿 → Discord 通知)
npm run scrape                # site/data/ に JSON 生成
DISCORD_WEBHOOK_URL=... GIST_TOKEN=... npm run notify   # 新着スレ検出 → gist 作成 → URL を webhook に投稿
npm run batch                 # 上 2 つを連続実行

# 系統① の動作確認(アクセス時リアルタイム取得)
npm run dev                   # http://localhost:8787
npm run deploy                # Cloudflare Workers へデプロイ
```

Worker に実運用設定を渡すときは、リポジトリ直下に `.dev.vars` を作成(モックモードで試すだけなら不要):

```
SCRAPER_CONFIG={"targetUrl": "https://...", "filters": {"titleIncludes": ["..."]}, ...}
```

## 通知の仕様(Gist + Discord)

`scraper/notify.mjs` が前回実行時(`.scrape-state.json`、GitHub Actions の actions/cache で保持)と比較し、
新しく見つかったスレッドの詳細(レス全文・年齢・性別・IP・機種情報・画像URL・メールアドレスなど)を
**秘密 gist**(`public: false`)に Markdown で投稿し、その URL だけを Discord に投稿する。
初回実行時は現在の対象スレ一覧をすべて投稿する。

- gist の Markdown 形式は `scraper/notify.mjs` の `buildGistContent()` で調整
- Discord へのメッセージ形式は `buildDiscordMessage()` で調整(スレタイの一覧 + gist URL)
- `DISCORD_WEBHOOK_URL` または `GIST_TOKEN` が未設定なら投稿をスキップし、状態も更新しない(設定後に新着として通知される)
- 秘密 gist でも **URL を知っている者は誰でも閲覧できる**ため、メールアドレス・IP などの機微なデータを含む運用では取り扱いに注意すること

## ディレクトリ構成

```
scraper/    共有スクレイピングロジック(parse.mjs)・バッチ(index.mjs)・Discord通知(notify.mjs)・モック(mock/)
site/       静的フロントエンド(ビルド不要。/data/*.json を Worker が動的生成)
worker/     Cloudflare Worker(アクセス時リアルタイム取得)
.github/    scrape.yml(毎時スクレイプ+Discord通知) / deploy.yml(コード変更時デプロイ)
```

### 本文ページのパーサーについて

旧式モバイル掲示板のように各レスが class 付き要素で囲まれていない HTML では、
`thread.parser: "hr-split"` を使う。`<hr>` でページを分割し、
各チャンクを正規表現(レス番号・名前・日時・本文・年齢などの付帯情報)でパースする。
セマンティックな構造のサイトなら `thread.parser` を設定せず `postsSelector` + `fields` を使う。

## 備考

- フロントエンド(`site/app.js`)は取得本文を `textContent` でのみ描画するため、スクレイピング元 HTML にスクリプトが含まれていても実行されない
- カスタムドメインは Cloudflare ダッシュボードの Worker「設定 → ドメインとルート」から追加
- 通知間隔は `.github/workflows/scrape.yml` の `cron` で変更(GitHub Actions の cron は数分遅延する)
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

掲示板をスクレイピングして再利用するプロジェクト。対象は自営・取得許可済みの掲示板。UI とログは日本語。**2系統の仕組みで動く:**

- **系統①(サイト)**: 閲覧者がアクセスした時点で Cloudflare Worker が対象掲示板をリアルタイム取得し、`/data/*.json` を動的生成して静的フロントに表示
- **系統②(定期バッチ)**: GitHub Actions が毎時スクレイピングし、新着スレッドの詳細を GitHub Gist に投稿、その URL を Discord webhook に通知

```
系統①:  閲覧者 → Worker(worker/src/) → 対象掲示板
系統②:  GitHub Actions (cron) → scraper/index.mjs → scraper/notify.mjs → Gist → Discord(URLのみ)
```

## よく使うコマンド

```sh
npm run scrape   # バッチ用スクレイプ(site/data/ に JSON 生成)
npm run notify   # 新着スレ検出 → Discord 投稿(DISCORD_WEBHOOK_URL 環境変数が必要)
npm run batch    # scrape + notify
npm run dev      # wrangler dev → http://localhost:8787(系統①の動作確認)
npm run deploy   # Cloudflare Workers へデプロイ
MOCK=1 npm run scrape  # モックモード明示指定
SCRAPER_TARGET_URL='実サイトのドメイン' npm run scrape  # 実モードで実行(ドメインのみ可。パス・クエリは config.targetUrl から補完)
SCRAPER_TARGET_URL='実サイトのドメイン' SCRAPER_MAX_THREADS=3 npm run scrape  # 詳細取得を先頭3スレに制限(手元の動作確認用)
SCRAPER_TARGET_URL='実サイトのドメイン' SCRAPER_KEYWORDS='梅田,天王寺' npm run scrape  # キーワード(カンマ区切り)ごとにスレ検索して巡回
```

- `scrape` / `notify` / `batch` は **`.env`(ルート、gitignore)を自動読み込み**する(`--env-file-if-exists`)。テンプレートは `.env.example` — 実サイト URL・キーワード・`GIST_TOKEN`・`DISCORD_WEBHOOK_URL` 等をまとめて書ける。シェルで直接渡した環境変数が `.env` の値より優先される

- テスト/リントは現状なし。JS の確認は `node --check <file>`
- Worker のローカル実運用設定は `.dev.vars`(ルート、gitignore)に `SCRAPER_CONFIG=<config.json と同じ JSON>` を書く。未設定ならモックモード
- バッチの実サイト URL は環境変数 `SCRAPER_TARGET_URL`(config.json の targetUrl より優先)でも指定できる。CI ではリポジトリシークレット `SCRAPER_TARGET_URL` を同キーで参照
- `scraper/config.json` は gitignore され、CI ではリポジトリシークレット `SCRAPER_CONFIG` から復元される

## アーキテクチャ

### scraper/parse.mjs — 共有スクレイピングライブラリ(最重要)

Node バッチと Worker の**両方から import される**唯一のロジック。ここは Node 専用機能(fs 等)を使わないこと(Worker でバンドルされるため)。セレクタはすべて config に置かれ、コードにハードコードされない。対象サイトの構造変更は config 修正で対応する。

対象サイトは 3 種類のページで構成される(**A** スレ一覧 / **B** スレ本文 / **C** 個別メールページ)。B のページ送りは昇順(p=1 が最古)で、URL は `thread/index?id=NNN&p=2` 形式。

巡回は 4 段階: ①(オプション)環境変数 `SCRAPER_KEYWORDS`(カンマ区切り)があればキーワードごとにスレ検索 URL(`targetUrl` + `search` ブロックのパラメータ)を組み立て、なければ(オプション)`categoryList` で掲示板一覧を列挙 — どちらも未設定なら `targetUrl` を直接スレ一覧として扱う ②スレ一覧(`threadList.nextPage` + `maxPages` でページング、キーワード間の重複は ID で除去) ③`filters.titleIncludes/titleExcludes` でタイトル絞り込み ④該当スレ本文(`thread.nextPage` + `maxPages` でスレッド内ページ送り)→ レス配列。

**B ページの取得範囲は実行時から `thread.maxAgeDays`(既定 2)日前まで**: p=1 のナビから `thread.lastPagePattern` で最終ページ番号を推定し、新しい側(p=最終ページ)から遡って、全レスが範囲外になったページで打ち切る(昇順のため先頭から取ると古いページを大量取得してしまうため)。ページ URL は `thread.pageParam`(既定 `p`)で組み立て、`thread.maxPages` は 1 スレあたりの安全上限。モックモードではサンプル日時が固定のため範囲制限をしない(テスト時は環境変数 `SCRAPER_MAX_AGE_DAYS` で明示指定)。日時の解釈(`parsePostDateMs`)は UTC+9 固定で実行環境のタイムゾーンに依存しない。

**本文パーサーは2方式**(`thread.parser` で切り替え、実装は parse.mjs):
- 未設定: セレクタベース(`postsSelector` + `fields`)。各レスが class 付き要素に囲まれた HTML 向け
- `"hr-split"`: 旧式モバイル掲示板向け。`<hr>` でチャンク分割し、`<br>` → 改行変換後に正規表現でレス番号・名前・日時・本文・付帯情報(`metaPatterns` で年齢/性別/IP/機種情報など)・添付画像 URL(`imagePattern`、複数マッチで `images` 配列)を抽出。本物のレスは `requireNumberSpan` の有無で判別し、スレ主(>>1)本文は `opPattern` で検出する。正規表現の `\s` は改行を跨ぐため、metaPatterns では `[^\S\n]` を使うこと(跨ぐと次の行の内容を誤取得する)

パースの規約:
- フィールド指定は `"CSSセレクタ@属性"` 形式(`@text` が既定)。url が空の行(見出し・広告行)は自動除外
- **セレクタのマッチは最初の 1 件のみ**を使う(extractFieldValue の `.first()`)。実物の旧式HTMLは `<font>` 等が閉じられず後続の行が入れ子になるため、連結テキストを取ると行全体が連結されてしまう
- 一覧の `fieldPatterns` は行テキストへの正規表現抽出(`#123` のようにテキストノード直接記述で CSS セレクタに載らない値向け)
- スレッド ID は URL から生成(id 系クエリを優先)。カテゴリ・ページ間の重複は ID で、スレッド内ページ送りでの重複レスはレス番号で排除
- 個別ページ(メール送信ページ): `thread.mailPage` で設定。parse.mjs は本文チャンクから `linkPattern` で `post.mailUrl` を抽出するだけ。ページを取得して `mailto:` からメールアドレスを取り出すのは**バッチ(index.mjs)のみ**(1 レス = 1 リクエストのため Worker のサブリクエスト上限に収まらない)。抽出結果は `post.email`
- モック判定: `targetUrl` がプレースホルダ(`https://hoge.com` / `https://board.example.net`)ならモックモード
- モック(すべて実物サンプル): `sample.html`=掲示板一覧(categoryList 使用時のみ)/ `sample-thread-list.html`=スレ一覧(大阪・梅田板)/ `sample-thread.html`=スレ本文(梅田スレ)/ `sample-mail.html`=個別ページ(メール送信)

### 系統① worker/(アクセス時リアルタイム取得)

- `worker/src/worker.ts`: ルーティング。`/data/*` の JSON のみ動的生成、それ以外は静的アセット(`site/`)へ。エラー時は 502 + JSON
- `worker/src/scrape.ts`: 共有ライブラリで巡回し、`/data/threads.json` と `/data/threads/<id>.json` と同じ形式を組み立てる
- 結果は Cache API で `site.cacheTtlSec`(既定 300 秒)キャッシュ。一覧・詳細で同一のスクレイプ結果を共有する
- Workers のサブリクエスト上限(無料プラン 50)対策で、本文取得は `site.maxDetailThreads`(既定 20)スレ × `site.maxThreadPages`(既定 2)ページで頭打ち・並列取得。バッチ側は `thread.maxPages` まで全ページ取得でき、礼儀正しさ(リクエスト間隔・指数バックオフリトライ)もバッチ側にのみある
- Worker は `env.SCRAPER_CONFIG`(secret)を config.example.json の既定値にマージして使う。モック HTML は `scraper/mock/*.html` を wrangler の Text ルールで文字列 import
- **モックモードでは全スレが同じサンプル本文を共有するため、本文側のタイトルで一覧タイトルを上書きしない**(index.mjs / scrape.ts 両方に同じ条件がある)

### 系統② バッチ(index.mjs + notify.mjs)

- `index.mjs`: 全取得は順次・`request.intervalMs`(既定 1500ms)以上の間隔 + リトライ。個別スレの失敗はスキップして継続、一覧取得失敗やフィルタ 0 件は exit 1(Actions を失敗させる)。個別ページ(メール送信ページ)からのメールアドレス抽出もここでのみ行う(重複 URL は実行内キャッシュで 1 回だけ取得)
- `notify.mjs`: 前回実行の状態(`.scrape-state.json`)と差分し、新着スレの詳細(レス全文・付帯情報・メールアドレス)を**秘密 gist** に Markdown で投稿し、その URL だけを Discord に投稿する(本文を Discord に直接は送らない)。**gist の Markdown 形式は仮実装で要調整**(`buildGistContent()` / `buildDiscordMessage()`)。`DISCORD_WEBHOOK_URL` or `GIST_TOKEN` 未設定なら状態を更新しない(設定後に通知される設計)。状態ファイルは actions/cache で次回実行へ引き継ぐ。`GIST_TOKEN` は gist 権限を持つ PAT(Actions 既定の GITHUB_TOKEN では gist 作成不可)
- `scrape.yml`(毎時 cron)は**デプロイしない**。デプロイは `deploy.yml`(コード変更時)のみ

### site/(ビルド不要の静的フロント)

`app.js` が `data-page` 属性でページ種別を判別し、`/data/threads.json` 等を fetch して描画。バニラ JS。

**セキュリティ規約: スクレイピングした本文は必ず `textContent` で描画すること(app.js 内で徹底)。取得元 HTML に含まれるスクリプトを実行させないため、`innerHTML` への変更は禁止。**

Workers は `/thread.html` を `/thread` にリダイレクトするため、フロントエンドのリンクは `/thread?id=` 形式を使う。

### GitHub Actions シークレット

`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `SCRAPER_CONFIG` / `GIST_TOKEN`(gist 権限の PAT)/ `DISCORD_WEBHOOK_URL`。デプロイ時、`SCRAPER_CONFIG` は Worker secret として自動同期される。
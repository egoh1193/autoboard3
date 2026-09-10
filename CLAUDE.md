# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ ユーザー設定ファイルの取り扱い(厳守 — 違反すると実害が発生する)

以下のファイルは**ユーザーが実環境の値を書き込むファイル**である。過去に(2026-09-05)Claude が動作検証中に `.env` を書き換え、ユーザーが入力済みのトークン類を消失させた実事故がある。

- 対象: `.env` / `.dev.vars` / `scraper/config.json` / `.scrape-state.json` / `site/data/`
- **書き込み・上書き・削除・「テンプレートに戻す」「リストア」を絶対に行わない**。読み取りは可(ただしトークン等の値を会話に出力しない)
- テスト用の環境変数・設定値が必要なときは **`/tmp` に別ファイルを作って渡す**(例: `node --env-file=/tmp/test.env …`、`env $(cat /tmp/test.env)` 用途の代替)。リポジトリ内の設定ファイルに書いてはならない
- 「戻す/初期化/復元」系の操作はユーザーが明示的に頼んだときのみ。実行前にそのファイルの mtime・git status を確認し、ユーザー編集の痕跡があれば中止して確認する
- 検証で生成物(`site/data/` など)を作る必要がある場合は、消す前にユーザーに確認する

## シェルコマンドの提示(厳守)

ユーザーはコマンドをそのままコピー&ペーストして実行する。

1. 長いコマンドを複数行で示すときは**単純な改行で分断しない**(後半が別コマンドとして実行されて壊れる)
2. 改行が必要な場合は行末に継続記号 `\` を付けて複数行にする
3. 1 行に収まるなら 1 行のまま提示する

## プロジェクト概要

掲示板をスクレイピングして再利用するプロジェクト。対象は自営・取得許可済みの掲示板。UI とログは日本語。**2系統の仕組みで動く:**

- **系統①(サイト)**: 閲覧者がアクセスした時点で Cloudflare Worker が対象掲示板をリアルタイム取得し、`/data/*.json` を動的生成して静的フロントに表示
- **系統②(定期バッチ)**: GitHub Actions が 5 分おきにスクレイピングし、新着スレッドの新着レスを投稿者ごとにまとめて GitHub Gist に投稿、その URL を Discord webhook に通知

```
系統①:  閲覧者 → Worker(worker/src/) → 対象掲示板
系統②:  GitHub Actions (cron) → scraper/index.mjs → scraper/notify.mjs → Gist → Discord(URLのみ)
系統③:  GitHub Actions post.yml (cron 1時間おき) → poster/index.mjs(Playwright) → 投稿フォーム自動操作
```

## よく使うコマンド

```sh
npm run scrape   # バッチ用スクレイプ(site/data/ に JSON 生成)
npm run notify   # 新着スレ検出 → Discord 投稿(DISCORD_WEBHOOK_URL 環境変数が必要)
npm run batch    # scrape + notify
npm run dev      # wrangler dev → http://localhost:8787(系統①の動作確認。.env があれば自動読み込み)
npm run deploy   # Cloudflare Workers へデプロイ
npm run gh-action-test  # Actions 相当のローカル実行(= batch: scrape + notify)
MOCK=1 npm run scrape  # モックモード明示指定
SCRAPER_DOMAIN='実サイトのドメイン' npm run scrape  # 実モードで実行(ドメインのみ可。パス・クエリは config.targetUrl から補完)
SCRAPER_DOMAIN='実サイトのドメイン' SCRAPER_MAX_THREADS=3 npm run scrape  # 詳細取得を先頭3スレに制限(手元の動作確認用)
SCRAPER_DOMAIN='実サイトのドメイン' SCRAPER_KEYWORDS='梅田,天王寺' npm run scrape  # キーワード(カンマ区切り)ごとにスレ検索して巡回
SCRAPER_DOMAIN='実サイトのドメイン' SCRAPER_SEX_EXCLUDES='排除したい性別キーワード' npm run scrape  # 性別に部分一致するレスを出力から除外
```

- `scrape` / `notify` / `batch` は **`.env`(ルート、gitignore)を自動読み込み**する(`--env-file-if-exists`)。テンプレートは `.env.example` — 実サイト URL・キーワード・`GIST_TOKEN`・`DISCORD_WEBHOOK_URL` 等をまとめて書ける。シェルで直接渡した環境変数が `.env` の値より優先される

- テスト/リントは現状なし。JS の確認は `node --check <file>`
- Worker のローカル実運用設定は `.dev.vars`(ルート、gitignore)に `SCRAPER_CONFIG=<config.json と同じ JSON>` を書く。未設定ならモックモード。`SCRAPER_DOMAIN` にも対応(`npm run dev` は `.env` を自動読み込みするので、バッチと同じ `.env` で実モードに切り替わる)。**wrangler dev の Cache API は `.wrangler/state/` に永続化される**ため、`.env` を変えて挙動が変わらない場合は `rm -rf .wrangler/state/v3/cache` して再起動
- バッチの実サイト URL は環境変数 `SCRAPER_DOMAIN`(config.json の targetUrl より優先)でも指定できる。CI ではリポジトリシークレット `SCRAPER_DOMAIN` を同キーで参照
- `scraper/config.json` は gitignore され、CI ではリポジトリシークレット `SCRAPER_CONFIG` から復元される

## アーキテクチャ

### scraper/parse.mjs — 共有スクレイピングライブラリ(最重要)

Node バッチと Worker の**両方から import される**唯一のロジック。ここは Node 専用機能(fs 等)を使わないこと(Worker でバンドルされるため)。セレクタはすべて config に置かれ、コードにハードコードされない。対象サイトの構造変更は config 修正で対応する。

対象サイトは 3 種類のページで構成される(**A** スレ一覧 / **B** スレ本文 / **C** 個別メールページ)。B のページ送りは昇順(p=1 が最古)で、URL は `thread/index?id=NNN&p=2` 形式。

巡回は 4 段階: ①(オプション)環境変数 `SCRAPER_KEYWORDS`(カンマ区切り)があればキーワードごとにスレ検索 URL(`targetUrl` + `search` ブロックのパラメータ)を組み立て、なければ(オプション)`categoryList` で掲示板一覧を列挙 — どちらも未設定なら `targetUrl` を直接スレ一覧として扱う ②スレ一覧(`threadList.nextPage` + `maxPages` でページング、キーワード間の重複は ID で除去) ③`filters.titleIncludes/titleExcludes` でタイトル絞り込み ④該当スレ本文(`thread.nextPage` + `maxPages` でスレッド内ページ送り)→ レス配列(性別排除: `filters.sexExcludes` / 環境変数 `SCRAPER_SEX_EXCLUDES`(カンマ区切り・部分一致)に該当するレスを出力から除外。`isSexExcluded()` は parse.mjs 共有、Worker も同じく排除)。**`config.directThreads`(配列)で一覧を経由しない「メインスレ」を直接指定できる**: 要素は URL 文字列 or `{url, title, newestFirst, maxPages, maxAgeDays}`(`newestFirst: true` は p=1 が最新の降順ページングのスレ。`maxPages` / `maxAgeDays` は**スレ単位の上限上書き** — 重たいスレを個別に軽量化でき、未指定なら共通値 `thread.maxPages` / `thread.maxAgeDays` を使う。`maxAgeDays: 0` で範囲制限なし)。明示指定のためタイトルフィルタは適用されず、一覧由来スレと ID 重複時は一覧側を優先。**Worker は未対応**(バッチ側のみ)

**本文ブロックの切り出し**: 日時行が本文より後にある形式は従来どおり日時行の直前まで。日時行が番号行より前にある形式(メインスレ)では**本文の後に付帯情報行(性別・年齢・地域・IP・機種)が続く**ため、`metaPatterns` のいずれかに一致する最初の行で本文を打ち切る(打ち切らないと本文にメタ行が混入する)

**B ページの取得範囲は実行時から `thread.maxAgeDays`(既定 2)日前まで**: 昇順スレ(p=1 が最古)は p=1 のナビから `thread.lastPagePattern` で最終ページ番号を推定し、新しい側(p=最終ページ)から遡って、全レスが範囲外になったページで打ち切る(昇順のため先頭から取ると古いページを大量取得してしまうため)。`newestFirst` スレ(降順、p=1 が最新)は p=1 から順に取得して全レスが範囲外になったページで打ち切る。ページ URL は `thread.pageParam`(既定 `p`)で組み立て、`thread.maxPages` は 1 スレあたりの安全上限。モックモードではサンプル日時が固定のため範囲制限をしない(テスト時は環境変数 `SCRAPER_MAX_AGE_DAYS` で明示指定)。日時の解釈(`parsePostDateMs`)は UTC+9 固定で実行環境のタイムゾーンに依存しない。hr-split のレス番号抽出は `numberPattern`(既定 config は `(\d+)\s*\[` — 日時行が先頭にある形式(日時 → レス番号の順)と番号が先頭の形式の両方に対応。日時行が番号行より前にある場合はチャンク全体から日時をフォールバック抽出)。

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

### 系統③ 自動投稿(poster/index.mjs — Playwright)

- 設定 gist の JSON 内の **`post` ブロック**に従い、**Playwright(Chromium ヘッドレス)**で投稿フォーム(`form[name=form01]`)を自動操作して投稿する。対象掲示板は自営・投稿許可済み。**`post` は 1 系統(オブジェクト)でも複数系統(配列)でも書け**、各系統が投稿先・間隔・内容を独立に持つ(系統名 `name` は状態のキー)
- gist の `post` 各系統: `enabled` / `threadIds`(投稿先スレ ID 配列)/ `formPath`(フォームページのパス。`{id}` をスレ ID で置換)/ `intervalMinutes`(投稿間隔。前回試行から未経過なら何もしない)/ `posts[]`(投稿パターン。`fields` はフォームの name 属性 → 値、`sage` はチェックボックス。**順にローテーション**して同じ文面の連投を避ける)
- フォームの値は gist 側の `fields`(name 属性 → 値)で完全指定。select は値(失敗時ラベル)選択、checkbox は truthy でチェック、text/textarea は fill。**画像認証 `image_auth` は設定不要** — フォーム内の認証画像 `image_auth_N.png` のファイル名から数字を表示順に抜いて自動入力する(`fillImageAuth()`)。画像アップロード(`file[1]`/`file[2]`)は未対応
- 状態 `.post-state.json`(actions/cache)に `lastPostedAt` / `rotateIndex` を保存。**成否問わず試行ごとに `lastPostedAt` を進める**(失敗しても間隔内に再試行して連打しない)
- **投稿内容(名前・メール・本文・編集キー)はログに絶対に出さない**(件数のみ)。エラー内の URL も `maskUrl()` でマスク。CI ログ・`log/latest-run.md` と同じ規約
- **Actions は `post.yml`(系統③専用ワークフロー、1 時間おき cron)**で起動し、実際の投稿間隔は gist の `intervalMinutes` で制御する(間隔未経過なら poster が何もせず終了)。`npx playwright install chromium` を実行(~150MB。actions/cache でキャッシュ)。状態 `.post-state.json` は `post-state-v1-` キーの別キャッシュ。**実行結果は post.yml の Actions ログでのみ確認**(件数のみ。log/latest-run.md には書かない)。Worker 内では Playwright は動かない(Cloudflare Browser Rendering なら可だが有料)ため、**系統③はバッチ側のみ**
- `npm run post` で単体実行(`npm run batch` は scrape → notify → post の順。ローカル専用)

### 系統② バッチ(index.mjs + notify.mjs)

- `index.mjs`: 全取得は順次・`request.intervalMs`(既定 1500ms)以上の間隔 + リトライ。個別スレの失敗はスキップして継続、一覧取得失敗やフィルタ 0 件は exit 1(Actions を失敗させる)。個別ページ(メール送信ページ)からのメールアドレス抽出もここでのみ行う(重複 URL は実行内キャッシュで 1 回だけ取得)
- **CI のログは処理ステップのみ・機微情報は出さない**: index.mjs / notify.mjs は環境変数 `CI`(GitHub Actions が自動設定)があれば処理ステップ(件数・`(n/N)` 進行)は出すが、**キーワード値(地名)・実サイトのドメイン・URL・スレタイ・投稿内容・gist URL は出さない**(Actions のログは public のため。エラー内の URL も `maskUrl()` で `***` にマスク。キーワードはローカルでも値を出さず件数のみ)。エラー・統計は `log/latest-run.md` にマスク済みで記録される
- **巡回設定 gist**(`SCRAPER_SETTINGS_GIST_URL`, シークレット): gist 内の最初の `.json` ファイルに `{"keywords": [...], "sexExcludes": [...], "blackList": [...], "directThreads": [...], "post": {...}}` を書いておくと、各設定が未設定時に読み込まれる(優先順: 環境変数 > gist > config。`directThreads` は gist があれば gist 優先)。`directThreads` は一覧を経由しない「メインスレ」の直接指定(要素は URL 文字列 or `{url, title, newestFirst}`。URL は config.targetUrl 基準で解決されるため相対パス `/public/thread/index?id=N` だけでもよい)。`blackList` は**文字列(メールアドレス完全一致。大文字小文字・空白は無視)かオブジェクト(`{ "mail": "...", "keyword": "..." }`)の混合が書ける** — `mail` はメールアドレス完全一致、`keyword` は**投稿本文への部分一致**(大文字小文字無視。メールだけ変えて同じ広告を書く投稿者を落とすための投稿キーワード)。両方指定は AND 条件 — **メールアドレスは個別メールページ取得後に確定するためバッチ専用**(Worker はメールページを取得しない)。秘密 gist を読むため `GIST_TOKEN` が必要。**gist URL・ID・内容はログに出さない**。読み込み失敗時は実行を中止する(意図しないフィルタでの巡回・通知を避ける)。バッチ側のみ(Worker は未対応)
- `notify.mjs`: 前回実行の状態(`.scrape-state.json`)と差分し、新着レス(レス全文・付帯情報・メールアドレス)を**投稿者ごと**にまとめた Markdown を**秘密 gist** に投稿し、その URL だけを Discord に投稿する(本文を Discord に直接は送らない)。各レスの見出しに元投稿スレ(タイトル・URL)を付与(`buildGistContent()`)。**差分はレス単位**: 状態には `knownIds`(既知スレ ID)に加えて `knownPosts`(スレごとの既知最終レス番号)を保存し、**新規スレは取得窓内の全レス・既存スレは既知の最終レス番号より大きいレス番号のレス**が新着になる(旧形式の knownIds のみの状態ファイルもそのまま読める)。基準は単調に進めるため、レス窓の関係で 1 回だけレスが取れない実行があっても同じレスを重複通知しない。**本文が空 or 2 文字以下のレスは募集削除の可能性が高いため gist には載せない**(基準の進行には含むため再通知もされない)。本文未取得スレ(詳細ファイルなし)は基準を進めない → 次回に新着として通知される。`DISCORD_WEBHOOK_URL` or `GIST_TOKEN` 未設定なら状態を更新しない(設定後に通知される設計)。状態ファイルは actions/cache で次回実行へ引き継ぐ。`GIST_TOKEN` は gist 権限を持つ PAT(Actions 既定の GITHUB_TOKEN では gist 作成不可)
- **最新実行ログ**(`log/latest-run.md`): 各実行の統計を public リポジトリに残す仕組み。index.mjs / notify.mjs が実行統計(キーワード・件数・エラー等)を `RUN_SUMMARY_JSON`(/tmp 配下)に JSON 書き出しし、最後のステップ(`if: always()`)で `scraper/run-log.mjs` が `log/latest-run.md` に整形・コミット・push する(push 失敗は警告のみで次回再試行)。**ドメイン・URL・スレタイ・投稿内容・gist URL は含めない**(エラーメッセージ内のドメインは `***` にマスク)。ローカルでは `RUN_SUMMARY_JSON=/tmp/run-summary.json npm run batch` でサマリ生成 → `node scraper/run-log.mjs` で整形を確認できる
- `scrape.yml`(5 分おき cron)は**デプロイしない**。デプロイは `deploy.yml`(コード変更時)のみ

### site/(ビルド不要の静的フロント)

`app.js` が `data-page` 属性でページ種別を判別し、`/data/threads.json` 等を fetch して描画。バニラ JS。

**セキュリティ規約: スクレイピングした本文は必ず `textContent` で描画すること(app.js 内で徹底)。取得元 HTML に含まれるスクリプトを実行させないため、`innerHTML` への変更は禁止。**

Workers は `/thread.html` を `/thread` にリダイレクトするため、フロントエンドのリンクは `/thread?id=` 形式を使う。

### GitHub Actions シークレット

`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `SCRAPER_CONFIG` / `GIST_TOKEN`(gist 権限の PAT)/ `DISCORD_WEBHOOK_URL`。デプロイ時、`SCRAPER_CONFIG` は Worker secret として自動同期される。
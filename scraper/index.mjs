// 定期バッチ用スクレイパーのエントリポイント。
//
// 取得の流れ(パース・フィルタの共有ロジックは parse.mjs):
//   1. 巡回対象の決定。環境変数 SCRAPER_KEYWORDS(カンマ区切り)があれば
//      キーワードごとにスレ検索 URL(targetUrl + 検索パラメータ)を組み立てる
//      - SCRAPER_KEYWORDS がなければ targetUrl(カテゴリ一覧)からカテゴリを列挙
//      - categoryList の設定がない場合、targetUrl を直接スレッド一覧として扱う
//   2. 各キーワード・カテゴリのスレッド一覧(ページネーション対応)を取得
//   3. filters でスレッドタイトルを絞り込み
//   4. 該当スレッドの本文ページを取得してレス配列をパース
//
// 生成した JSON は Discord 通知(scraper/notify.mjs)の入力として使われる。
// scraper/config.json が存在しない、または環境変数 MOCK=1 のときは
// scraper/mock/ 以下のサンプル HTML から同一形式の JSON を生成する(モックモード)。
// セレクタ等の既定値は scraper/config.example.json を使用する。
// 実サイトのドメインは環境変数 SCRAPER_DOMAIN でも指定可能
// (config.json の targetUrl より優先。ドメインのみ指定した場合はパス・クエリを
//  config の targetUrl から補完。モック判定は環境変数より先に MOCK=1 が勝つ)。
//
// 出力:
//   site/data/threads.json        … スレッド一覧 (+ generatedAt)
//   site/data/threads/<id>.json   … 個別スレッド(レス配列)

import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isMockConfig,
  matchesFilters,
  parseList,
  parseNextPageUrl,
  parsePostDateMs,
  parseThread,
  resolveUrl,
  threadIdFromUrl,
} from "./parse.mjs";

const SCRAPER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SITE_DATA_DIR = path.resolve(SCRAPER_DIR, "../site/data");
const CONFIG_PATH = path.join(SCRAPER_DIR, "config.json");
const EXAMPLE_CONFIG_PATH = path.join(SCRAPER_DIR, "config.example.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// キーワード(地名など)1 件のスレ検索 URL を組み立てる。
// targetUrl に検索パラメータを付与する形式(例: board?id=14&keyword=梅田&is_search=スレ検索)。
// パラメータ名・付随パラメータは config.search で上書き可能
function buildSearchUrl(config, keyword) {
  const search = config.search ?? {};
  const url = new URL(config.targetUrl);
  url.searchParams.set(search.keywordParam ?? "keyword", keyword);
  for (const [key, value] of Object.entries(search.extraParams ?? { is_search: "スレ検索" })) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

// B ページ(スレ本文)のページ送り URL(p=N)を組み立てる
function buildThreadPageUrl(threadUrl, pageParam, page) {
  const url = new URL(threadUrl);
  url.searchParams.set(pageParam, String(page));
  return url.toString();
}

// 既定値(config.example.json)に config.json を上書きマージして返す。
// 実サイトのドメインは環境変数 SCRAPER_DOMAIN でも指定できる
// (config.json やシークレットに書きたくない/書けない場合の上書き。空文字は無視)。
// 例: example.com / https://example.com のようなドメイン(オリジン)指定なら
// パス・クエリを設定の targetUrl から補完する。フル URL を書けばそちらを優先
async function loadConfig() {
  const defaults = JSON.parse(await readFile(EXAMPLE_CONFIG_PATH, "utf8"));
  let config = defaults;
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    config = { ...defaults, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
  const domain = process.env.SCRAPER_DOMAIN;
  if (domain) {
    const envUrl = new URL(domain.includes("://") ? domain : `https://${domain}`);
    if (envUrl.pathname === "/" && envUrl.search === "") {
      // ドメイン(オリジン)のみ → パス・クエリは config の targetUrl から流用
      const configUrl = new URL(config.targetUrl);
      config = { ...config, targetUrl: envUrl.origin + configUrl.pathname + configUrl.search };
    } else {
      config = { ...config, targetUrl: envUrl.toString() };
    }
  }
  return config;
}

async function main() {
  const config = await loadConfig();
  const mock = process.env.MOCK === "1" || isMockConfig(config);

  if (mock && process.env.MOCK !== "1") {
    console.log(
      "[scraper] 参考: SCRAPER_DOMAIN 環境変数または config.json の targetUrl で実サイトを取得できます",
    );
  }
  console.log(`[scraper] ${mock ? "モックモード" : `対象: ${config.targetUrl}`} で実行します`);

  const intervalMs = config.request?.intervalMs ?? 1500;
  const generatedAt = new Date().toISOString();

  let lastFetchedAt = 0;

  // 1 リクエストごとに intervalMs 以上の間隔を空けつつページを取得する。
  // モックモードではファイルを読み替える。
  async function getHtml(url, mockFile) {
    if (mock && mockFile) {
      return readFile(path.join(SCRAPER_DIR, "mock", mockFile), "utf8");
    }
    const wait = intervalMs - (Date.now() - lastFetchedAt);
    if (wait > 0) {
      await sleep(wait);
    }
    try {
      return await fetchPage(url, config);
    } finally {
      lastFetchedAt = Date.now();
    }
  }

  // 1. 巡回対象の決定。
  //    環境変数 SCRAPER_KEYWORDS(カンマ区切り)があれば、キーワードごとに
  //    スレ検索 URL を組み立てて各検索結果をスレッド一覧として扱う。
  //    なければ categoryList の取得、それもなければ targetUrl を直接スレッド一覧として扱う
  const keywords = (process.env.SCRAPER_KEYWORDS || "")
    .split(/[,,]/)
    .map((kw) => kw.trim())
    .filter(Boolean);
  let categories = [];
  if (keywords.length > 0) {
    categories = keywords.map((kw) => ({ name: kw, url: buildSearchUrl(config, kw) }));
    console.log(`[scraper] キーワード検索: ${keywords.join(" / ")}`);
    for (const category of categories) {
      console.log(`[scraper]   ${category.name} → ${category.url}`);
    }
  } else if (config.categoryList?.selector) {
    const listHtml = await getHtml(config.targetUrl, "sample.html");
    categories = parseList(listHtml, config.categoryList)
      .map((row) => ({ name: row.name || "", url: resolveUrl(row.url, config.targetUrl) }))
      .filter((c) => c.name || c.url);
    console.log(`[scraper] カテゴリ: ${categories.length} 件`);
  }
  if (categories.length === 0) {
    categories = [{ name: "", url: config.targetUrl }];
  }

  // 2. 各カテゴリのスレッド一覧の取得(ページネーション対応)
  const maxPages = config.threadList?.maxPages ?? 1;
  const seen = new Set();
  const allThreads = [];

  for (const category of categories) {
    let pageUrl = category.url;
    for (let page = 1; page <= maxPages && pageUrl; page++) {
      let html;
      try {
        html = await getHtml(pageUrl, "sample-thread-list.html");
      } catch (err) {
        console.warn(`[scraper] 警告: ${pageUrl} の取得に失敗しました: ${err.message}`);
        break;
      }

      for (const row of parseList(html, config.threadList)) {
        const url = resolveUrl(row.url, pageUrl);
        const id = threadIdFromUrl(url);
        if (seen.has(id)) {
          continue; // 複数カテゴリ・ページでの重複を除外
        }
        seen.add(id);
        allThreads.push({
          id,
          title: row.title || "",
          url,
          category: category.name,
          resCount: Number(row.resCount) || 0,
          createdAt: row.createdAt || "",
        });
      }

      const nextHref = parseNextPageUrl(html, config.threadList);
      pageUrl = nextHref ? resolveUrl(nextHref, pageUrl) : "";
    }
  }
  console.log(`[scraper] スレッド合計: ${allThreads.length} 件`);

  // 3. タイトルによる絞り込み
  const threads = allThreads.filter((t) => matchesFilters(t.title, config.filters));
  console.log(
    `[scraper] フィルタ後: ${threads.length} 件` +
      (threads.length !== allThreads.length ? `(除外 ${allThreads.length - threads.length} 件)` : ""),
  );
  // 詳細取得の件数上限(環境変数 SCRAPER_MAX_THREADS)。手元での動作確認用。
  // 1 スレ = 詳細ページ + メール送信ページの複数リクエストが intervalMs 以上の
  // 間隔で走るため、全件だと時間がかかる(リスト自体は制限前の全件を出力する)
  const maxDetailThreads = Number(process.env.SCRAPER_MAX_THREADS) || 0;
  if (maxDetailThreads > 0 && threads.length > maxDetailThreads) {
    console.log(
      `[scraper] SCRAPER_MAX_THREADS=${maxDetailThreads} のため、詳細取得は先頭 ${maxDetailThreads} 件に制限します`,
    );
  }
  if (threads.length === 0) {
    throw new Error("フィルタ条件に一致するスレッドがありません。filters の設定を確認してください。");
  }

  // 4. 該当スレッドの本文取得(スレッド内のページ送り対応)
  const maxThreadPages = config.thread?.maxPages ?? 1;

  // B ページ(スレ本文)の取得範囲: 実行時から maxAgeDays 日前まで。
  // ページは昇順(p=1 が最古)のため、ナビの p=N リンクから最終ページを推定して
  // 新しい側から遡り、全レスが範囲外になったページで打ち切る
  // (先頭から順に取得すると、伸びたスレの範囲内レスのために古いページを
  //  大量に取得することになるため)。
  // モックのサンプル日時は固定なので、モックモードでは範囲制限をしない
  // (テスト時は SCRAPER_MAX_AGE_DAYS 環境変数で明示指定できる)
  const envMaxAgeDays = Number(process.env.SCRAPER_MAX_AGE_DAYS);
  const maxAgeDays = Number.isFinite(envMaxAgeDays)
    ? envMaxAgeDays
    : mock
      ? 0
      : config.thread?.maxAgeDays ?? 2;
  const cutoffTs = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86400_000 : null;
  if (cutoffTs !== null) {
    console.log(
      `[scraper] スレ内の取得範囲: 直近 ${maxAgeDays} 日(それより古いページは遡りません)`,
    );
  }
  const pageParam = config.thread?.pageParam ?? "p";
  const lastPageRe = new RegExp(config.thread?.lastPagePattern ?? "[?&]p=(\\d+)", "g");

  // レスが取得範囲内(実行時から maxAgeDays 日前以降)か
  const postInRange = (post) => {
    if (cutoffTs === null) return true;
    const ts = parsePostDateMs(post.date);
    return ts !== null && ts >= cutoffTs;
  };

  // 個別ページ(メール送信ページ)からのメールアドレス抽出。
  // 1 レスごとに 1 リクエスト必要なため、サブリクエスト上限のある
  // 系統①(Worker)では行わず、このバッチ側でのみ実施する。
  const mailLinkRe = config.thread?.mailPage?.linkPattern
    ? new RegExp(config.thread.mailPage.linkPattern)
    : null;
  const emailRe = config.thread?.mailPage?.emailPattern
    ? new RegExp(config.thread.mailPage.emailPattern)
    : null;
  const mailEmailCache = new Map(); // メール送信ページ URL → メールアドレス(重複取得防止)

  async function fetchThreadDetail(thread) {
    // 先頭ページ(p=1)を取得: タイトルとページ送りナビ(最終ページの推定元)を得る
    const firstHtml = await getHtml(thread.url, "sample-thread.html");
    const parsedFirst = parseThread(firstHtml, config.thread);
    const title = parsedFirst.title;

    const byNum = new Map(); // レス番号 → レス(ページ送り・ページ跨ぎの重複排除)
    const collect = (pagePosts) => {
      for (const post of pagePosts) {
        if (!byNum.has(post.num)) byNum.set(post.num, post);
      }
    };
    collect(parsedFirst.posts);

    if (cutoffTs !== null) {
      // ナビの p=N リンクから最終ページ番号を推定し、新しい側から遡る
      // (HTML 実体参照の &amp; は先に展開しておく)
      let lastPage = 1;
      for (const m of firstHtml.replace(/&amp;/g, "&").matchAll(lastPageRe)) {
        lastPage = Math.max(lastPage, Number(m[1]));
      }
      let fetchedPages = 1; // p=1 分
      for (let p = lastPage; p >= 2 && fetchedPages < maxThreadPages; p--) {
        const pageUrl = buildThreadPageUrl(thread.url, pageParam, p);
        const parsed = parseThread(await getHtml(pageUrl, "sample-thread.html"), config.thread);
        collect(parsed.posts);
        fetchedPages++;
        // このページのレスがすべて範囲外なら、より古いページも範囲外なので打ち切り
        if (!parsed.posts.some(postInRange)) break;
      }
    } else {
      // 範囲制限なし: 従来どおり nextPage リンクを辿る(maxThreadPages ページまで)
      let pageUrl = thread.url;
      let html = firstHtml;
      for (let page = 1; page <= maxThreadPages && pageUrl; page++) {
        const parsed = page === 1 ? parsedFirst : parseThread(html, config.thread);
        collect(parsed.posts);
        const nextHref = parseNextPageUrl(html, config.thread);
        pageUrl = nextHref ? resolveUrl(nextHref, pageUrl) : "";
      }
    }

    // 範囲内のレスのみ残して昇順に並べる
    const posts = [...byNum.values()]
      .filter(postInRange)
      .sort((a, b) => a.num - b.num);
    return { title, posts };
  }

  const detailTargets = maxDetailThreads > 0 ? threads.slice(0, maxDetailThreads) : threads;
  for (const [i, thread] of detailTargets.entries()) {
    console.log(`[scraper] (${i + 1}/${threads.length}) ${thread.title || thread.url}`);
    try {
      const { title, posts } = await fetchThreadDetail(thread);
      thread.detail = { title, posts };
      // モックモードでは全スレが同じサンプルファイルを共有するため上書きしない
      if (title && !mock) {
        thread.title = title;
      }
      thread.resCount = posts.length;

      // 4.5 名前欄リンクの個別ページからメールアドレスを抽出
      if (mailLinkRe && emailRe) {
        for (const post of posts) {
          if (!post.mailUrl) continue;
          const mailPageUrl = resolveUrl(post.mailUrl, thread.url);
          if (!mailEmailCache.has(mailPageUrl)) {
            try {
              const mailHtml = await getHtml(mailPageUrl, "sample-mail.html");
              const m = mailHtml.match(emailRe);
              mailEmailCache.set(mailPageUrl, m ? m[1] ?? "" : "");
            } catch (err) {
              // 個別ページの失敗も続行(そのレスの email は空欄)
              mailEmailCache.set(mailPageUrl, "");
              console.warn(`[scraper] 警告: ${mailPageUrl} の取得に失敗しました: ${err.message}`);
            }
          }
          post.email = mailEmailCache.get(mailPageUrl) ?? "";
        }
      }
    } catch (err) {
      // 個別スレッドの失敗は全体を中断しない(一覧には resCount 掲載のまま表示)
      console.warn(`[scraper] 警告: ${thread.url} の取得に失敗しました: ${err.message}`);
    }
  }

  // 5. site/data/ へ出力
  await rm(SITE_DATA_DIR, { recursive: true, force: true });
  await mkdir(path.join(SITE_DATA_DIR, "threads"), { recursive: true });

  await writeFile(
    path.join(SITE_DATA_DIR, "threads.json"),
    JSON.stringify(
      { generatedAt, threads: threads.map(({ detail, ...meta }) => meta) },
      null,
      2,
    ),
  );
  for (const { detail, ...meta } of threads) {
    if (!detail) continue;
    await writeFile(
      path.join(SITE_DATA_DIR, "threads", `${meta.id}.json`),
      JSON.stringify({ ...meta, posts: detail.posts }, null, 2),
    );
  }

  const okCount = threads.filter((t) => t.detail).length;
  console.log(`[scraper] 完了: ${threads.length} 件中 ${okCount} 件の詳細を site/data/ に出力しました`);
}

// リトライ(指数バックオフ)付きで1ページを取得する
async function fetchPage(url, config) {
  const { userAgent, request } = config;
  const retries = request?.retries ?? 3;
  const timeoutMs = request?.timeoutMs ?? 15000;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = (request?.retryBackoffMs ?? 2000) * 2 ** (attempt - 1);
      console.warn(`  リトライ ${attempt}/${retries} (${backoff}ms 待機) …`);
      await sleep(backoff);
    }
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": userAgent, Accept: "text/html" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

main().catch((err) => {
  console.error(`[scraper] 失敗: ${err.message}`);
  process.exit(1);
});
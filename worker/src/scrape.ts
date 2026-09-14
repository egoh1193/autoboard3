// アクセス時リアルタイム取得(系統①)のコア。
// scraper/parse.mjs の共有ロジックを使い、対象掲示板をスクレイピングして
// フロントエンドが期待する /data/*.json と同じ形式のデータを組み立てる。
//
// Workers のサブリクエスト上限(無料プラン 50)に収めるため、
// 本文を取得するスレッド数は config.site.maxDetailThreads(既定 20)で頭打ちにする。
// 結果は Cache API で config.site.cacheTtlSec(既定 300 秒)だけキャッシュされ、
// 連続アクセスで対象掲示板へ負荷がかからないようになっている。

import mockCategoryHtml from "../../scraper/mock/sample.html";
import mockThreadListHtml from "../../scraper/mock/sample-thread-list.html";
import mockThreadHtml from "../../scraper/mock/sample-thread.html";
import defaultConfigJson from "../../scraper/config.example.json";
// @ts-expect-error -- JS モジュール(型定義なし、esbuild でバンドルされる)
import { isMockConfig, isSexExcluded, matchesFilters, parseList, parseNextPageUrl, parsePostDateMs, parseThread, resolveUrl, threadIdFromUrl } from "../../scraper/parse.mjs";

export interface Post {
  num: number;
  name?: string;
  date?: string;
  posterId?: string;
  body?: string;
  [key: string]: unknown;
}

export interface ThreadMeta {
  id: string;
  title: string;
  url: string;
  category: string;
  resCount: number;
  createdAt: string;
  // スレ内レス日時の最大値(最終更新日時)。詳細取得できたスレのみ入る
  updatedAt?: string;
}

export interface ThreadData extends ThreadMeta {
  posts: Post[];
}

export interface ScrapeResult {
  generatedAt: string;
  threads: ThreadMeta[];
  // メインスレ(directThreads)。一覧(threads)とは別に、フロントの下部リンクとして表示する
  mainThreads: ThreadMeta[];
  details: Record<string, ThreadData>;
}

export interface BoardConfig {
  targetUrl: string;
  userAgent: string;
  filters?: { titleIncludes: string[]; titleExcludes: string[]; sexExcludes?: string[] };
  categoryList?: {
    selector: string;
    fields: Record<string, string>;
    fieldPatterns?: Record<string, string>;
  };
  threadList?: {
    selector: string;
    fields: Record<string, string>;
    fieldPatterns?: Record<string, string>;
    nextPage?: string;
    maxPages?: number;
  };
  thread?: {
    parser?: string;
    titleSelector?: string;
    titleStrip?: string;
    postsSelector?: string;
    fields?: Record<string, string>;
    post?: {
      requireNumberSpan?: string;
      numberPattern?: string;
      namePattern?: string;
      opPattern?: string;
      datePattern?: string;
      metaPatterns?: Record<string, string>;
    };
    nextPage?: string;
    maxPages?: number;
    // 個別ページ(メール送信ページ)設定。parse.mjs が mailUrl の抽出までを行うが、
    // ページ取得(→ メールアドレス抽出)はサブリクエスト上限のためバッチ側のみ実施
    mailPage?: { linkPattern?: string; emailPattern?: string };
  };
  site?: { cacheTtlSec?: number; maxDetailThreads?: number; maxThreadPages?: number };
  // メインスレ(directThreads)。要素は URL 文字列 or {url, title}。
  // バッチとは異なり Worker は一覧を経由せず、ここで指定されたスレだけを
  // 一覧とは別に(mainThreads として)取得する。タイトルフィルタは適用しない
  directThreads?: (string | { url: string; title?: string; newestFirst?: boolean; maxPages?: number; maxAgeDays?: number })[];
}

export interface Env {
  ASSETS: Fetcher;
  // 実運用設定(scraper/config.json の中身と同じ JSON 文字列)。
  // 未設定の場合は config.example.json の値でモックモードとして動作する。
  SCRAPER_CONFIG?: string;
  // 実サイトのドメイン(.env / .dev.vars で指定)。ドメインのみならパス・クエリは
  // config の targetUrl から補完する(バッチ側 index.mjs と同じ挙動)
  SCRAPER_DOMAIN?: string;
  // 性別排除キーワード(カンマ区切り、部分一致)。
  SCRAPER_SEX_EXCLUDES?: string;
  // メインスレ(directThreads)の JSON 配列。デプロイ時に設定 gist から抽出され
  // 同期される(deploy.yml)。未設定ならメインスレは取得しない
  SCRAPER_DIRECT_THREADS?: string;
}

export function loadConfig(env: Env): BoardConfig {
  const defaults = defaultConfigJson as BoardConfig;
  let config = env.SCRAPER_CONFIG
    ? { ...defaults, ...JSON.parse(env.SCRAPER_CONFIG) }
    : defaults;
  const domain = env.SCRAPER_DOMAIN?.trim();
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
  const sexExcludes = (env.SCRAPER_SEX_EXCLUDES ?? "")
    .split(/[,,]/)
    .map((kw) => kw.trim())
    .filter(Boolean);
  if (sexExcludes.length > 0) {
    config = { ...config, filters: { ...config.filters, sexExcludes } };
  }
  const directRaw = env.SCRAPER_DIRECT_THREADS?.trim();
  if (directRaw) {
    try {
      const parsed = JSON.parse(directRaw);
      if (Array.isArray(parsed)) {
        config = { ...config, directThreads: parsed };
      }
    } catch (err) {
      // 形式が不正な場合は無視する(メインスレなしで継続)
      console.error(`[worker] SCRAPER_DIRECT_THREADS の解釈に失敗: ${err}`);
    }
  }
  return config;
}

async function fetchHtml(url: string, config: BoardConfig): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": config.userAgent, Accept: "text/html" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${url})`);
  }
  return res.text();
}

// 対象掲示板を一巡回してスレッド一覧と本文を取得する
export async function scrapeThreads(config: BoardConfig): Promise<ScrapeResult> {
  const mock = isMockConfig(config);
  const getHtml = (url: string, mockHtml: string): Promise<string> =>
    mock ? Promise.resolve(mockHtml) : fetchHtml(url, config);

  // 1. カテゴリ一覧(categoryList 設定がない場合は targetUrl をスレッド一覧として扱う)
  let categories: { name: string; url: string }[] = [];
  if (config.categoryList?.selector) {
    const html = await getHtml(config.targetUrl, mockCategoryHtml);
    categories = (parseList(html, config.categoryList) as Record<string, string>[])
      .map((row) => ({ name: row.name || "", url: resolveUrl(row.url, config.targetUrl) }))
      .filter((c) => c.name || c.url);
  }
  if (categories.length === 0) {
    categories = [{ name: "", url: config.targetUrl }];
  }

  // 2. 各カテゴリのスレッド一覧(ページネーション対応)
  const maxPages = config.threadList?.maxPages ?? 1;
  const seen = new Set<string>();
  const allThreads: ThreadMeta[] = [];

  for (const category of categories) {
    let pageUrl: string | null = category.url;
    for (let page = 1; page <= maxPages && pageUrl; page++) {
      const html = await getHtml(pageUrl, mockThreadListHtml);
      for (const row of parseList(html, config.threadList) as Record<string, string>[]) {
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
      pageUrl = nextHref ? resolveUrl(nextHref, pageUrl) : null;
    }
  }

  // 3. タイトルによる絞り込み
  const threads = allThreads.filter((t) => matchesFilters(t.title, config.filters));
  if (threads.length === 0) {
    throw new Error("フィルタ条件に一致するスレッドがありません。filters の設定を確認してください。");
  }

  // 4. 該当スレッドの本文取得(サブリクエスト上限対策で同時取得)。
  // スレッド内のページ送り(thread.nextPage)にも対応するが、サブリクエスト数を
  // 抑えるため site.maxThreadPages(既定 2)で頭打ちにする。全ページが必要な場合は
  // バッチ側(系統②)が thread.maxPages 分を取得する。
  const details: Record<string, ThreadData> = {};
  const targets = threads.slice(0, config.site?.maxDetailThreads ?? 20);
  const maxThreadPages = Math.min(config.thread?.maxPages ?? 1, config.site?.maxThreadPages ?? 2);

  // 1 スレ分の本文を取得する(レス番号順ソートと updatedAt の算出まで行う)。
  // メインスレ(directThreads)でも同じ関数を使う
  const collectThread = async (thread: ThreadMeta): Promise<Post[]> => {
    let pageUrl: string | null = thread.url;
    let title = "";
    const seenNums = new Set<number>();
    const posts: Post[] = [];
    for (let page = 1; page <= maxThreadPages && pageUrl; page++) {
      const html = await getHtml(pageUrl, mockThreadHtml);
      const parsed = parseThread(html, config.thread) as {
        title: string;
        posts: Post[];
      };
      if (page === 1) {
        title = parsed.title;
      }
      // ページ送りで重複したレス(モックで全ページ同じファイルなど)と
      // 性別排除キーワードに該当するレスは除外
      for (const post of parsed.posts) {
        if (seenNums.has(post.num) || isSexExcluded(post, config.filters)) {
          continue;
        }
        seenNums.add(post.num);
        posts.push(post);
      }
      const nextHref = parseNextPageUrl(html, config.thread);
      pageUrl = nextHref ? resolveUrl(nextHref, pageUrl) : null;
    }
    // モックモードでは全スレが同じサンプルファイルを共有するため上書きしない
    if (title && !mock) {
      thread.title = title;
    }
    // ページは p=1(最新)から古い側へ取得するため、レス番号順に並べ直す
    // (ページ順のままだとスレ上部に古いレスが来て「最新が古い」ように見える)
    posts.sort((a, b) => a.num - b.num);
    // 最終更新日時 = レス日時の最大値(表示順とは無関係に実レスから算出)
    let updatedAt: string | undefined;
    for (const post of posts) {
      if (!post.date) continue;
      if (!updatedAt || parsePostDateMs(post.date) > parsePostDateMs(updatedAt)) {
        updatedAt = post.date;
      }
    }
    if (updatedAt) thread.updatedAt = updatedAt;
    return posts;
  };

  const buildDetail = (thread: ThreadMeta, posts: Post[]): ThreadData => ({
    ...thread,
    // resCount は一覧の実件数(#672 など)を優先(取得レス数で上書きしない)
    resCount: thread.resCount || posts.length,
    posts,
  });

  await Promise.all(
    targets.map(async (thread) => {
      details[thread.id] = buildDetail(thread, await collectThread(thread));
    }),
  );

  // 5. メインスレ(directThreads)。一覧とは別に mainThreads として返す
  // (フロントの一覧下部に「メインスレ」リンクとして表示する)。
  // タイトルフィルタは適用しない(明示指定)。一覧と ID 重複時は取得済み詳細を流用
  const mainThreads: ThreadMeta[] = [];
  const directList = config.directThreads ?? [];
  if (directList.length > 0) {
    // サブリクエスト上限(無料プラン 50)対策: 一覧・詳細取得の残り予算で頭打ち
    const listRequests = mock ? 1 : Math.max(1, config.threadList?.maxPages ?? 1);
    const budget = Math.max(
      0,
      Math.floor((48 - listRequests - targets.length * maxThreadPages) / Math.max(maxThreadPages, 1)),
    );
    const mains = directList.slice(0, budget);
    await Promise.all(
      mains.map(async (entry) => {
        const spec = typeof entry === "string" ? { url: entry } : entry;
        const url = resolveUrl(spec.url, config.targetUrl);
        const id = threadIdFromUrl(url);
        if (!id) return;
        const existing = details[id];
        if (existing) {
          // 一覧由来と同じスレ → 取得済みの詳細をそのまま使う
          mainThreads.push({ ...existing, category: "メインスレ" });
          return;
        }
        const meta: ThreadMeta = {
          id,
          title: spec.title || "",
          url,
          category: "メインスレ",
          resCount: 0,
          createdAt: "",
        };
        const posts = await collectThread(meta);
        const detail = buildDetail(meta, posts);
        details[id] = detail;
        mainThreads.push({ ...detail });
      }),
    );
  }

  // 一覧は最終更新日時の新しい順に並べ替える(実サイトの最新更新順に合わせる)。
  // 日時が取れないスレは元の順序を保つ
  const sortedThreads = threads
    .map((t, i) => ({ t, i, ms: t.updatedAt ? parsePostDateMs(t.updatedAt) : -1 }))
    .sort((a, b) => (b.ms !== a.ms ? b.ms - a.ms : a.i - b.i))
    .map((e) => e.t);

  return {
    generatedAt: new Date().toISOString(),
    threads: sortedThreads,
    mainThreads,
    details,
  };
}
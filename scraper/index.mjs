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
  isBlacklisted,
  isSexExcluded,
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

// 実行サマリ(RUN_SUMMARY_JSON に JSON で書き出す)。GitHub Actions が
// log/latest-run.md を更新するための入力。ドメイン・URL・スレタイ・投稿内容は
// 入れない(リポジトリは public なため)。エラーメッセージもドメインをマスクする
let runSummary = null;
let summaryTargetUrl = "";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// CI(GitHub Actions)でも処理ステップは出す(どこで止まったか分かるように)。
// ただし Actions のログは public で誰でも見れるため、出力に
// 実サイトの URL・ドメイン・スレタイ・投稿内容・gist URL を含めてはならない。
// ローカル(CI 変数なし)ではこれらの詳細も表示する
const showDetail = !process.env.CI;

function maskUrl(msg) {
  let out = msg.split(summaryTargetUrl).join("***");
  try {
    const origin = new URL(summaryTargetUrl).origin;
    out = out.split(origin).join("***");
  } catch {
    // summaryTargetUrl 未設定(URL なしで実行)の場合はそのまま
  }
  return out;
}

async function writeRunSummary() {
  const outPath = process.env.RUN_SUMMARY_JSON;
  if (!outPath || !runSummary) return;
  runSummary.finishedAt = new Date().toISOString();
  await writeFile(outPath, JSON.stringify(runSummary, null, 2));
}

// "a, b" / ["a"," b"] を配列に正規化する。
// blackList は要素にオブジェクト({ mail, keyword })を許すため、文字列は trim、
// オブジェクトはそのまま残す(文字列専用のリスト側で非文字列を除く)
function splitList(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : v))
      .filter((v) => v != null && (typeof v !== "string" || v.length > 0));
  }
  if (typeof value === "string") {
    return value
      .split(/[,,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// 設定 gist の URL(gist.github.com/<user>/<id> など)または gist ID から ID を取り出す。
// ID 自体も公開ログには出さないため、失敗時のメッセージに含めない
function gistIdFromUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed.includes("://")) return trimmed; // gist ID 直接指定も許容
  try {
    const parts = new URL(trimmed).pathname.split("/").filter(Boolean);
    // gist.githubusercontent.com/<user>/<id>/raw/... 形式なら第2要素が ID
    if (new URL(trimmed).hostname === "gist.githubusercontent.com") {
      return parts[1] ?? "";
    }
    return parts[parts.length - 1] ?? "";
  } catch {
    return "";
  }
}

// 設定 gist(シークレット SCRAPER_SETTINGS_GIST_URL)から巡回設定を読み込む。
// gist 内の最初の .json ファイルに {"keywords": [...], "sexExcludes": [...],
// "blackList": [...]} を書く。
// 秘密 gist を読むため GIST_TOKEN(PAT)があれば付ける。
// URL・ID・取得内容はログに出さない(URL を知れば閲覧可のため)
async function loadGistSettings() {
  const raw = process.env.SCRAPER_SETTINGS_GIST_URL;
  if (!raw) return null;
  const id = gistIdFromUrl(raw);
  if (!id) {
    throw new Error("SCRAPER_SETTINGS_GIST_URL を gist ID として解釈できませんでした");
  }
  const base = (process.env.GIST_API_URL || "https://api.github.com/gists").replace(/\/$/, "");
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "board-mirror-scraper" };
  if (process.env.GIST_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GIST_TOKEN}`;
  }
  const res = await fetch(`${base}/${id}`, { headers });
  if (!res.ok) {
    throw new Error(`設定 gist の取得に失敗しました (HTTP ${res.status})`);
  }
  const data = await res.json();
  const jsonFile = Object.values(data.files ?? {}).find(
    (f) => typeof f?.content === "string" && f?.filename?.endsWith(".json"),
  );
  if (!jsonFile) {
    throw new Error("設定 gist に JSON ファイルが見つかりませんでした");
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonFile.content);
  } catch (err) {
    throw new Error(`設定 gist の JSON を解釈できませんでした: ${err.message}`);
  }
  return {
    // キーワード・性別排除は文字列専用(部分一致のキーワード)
    keywords: splitList(parsed.keywords).filter((v) => typeof v === "string"),
    sexExcludes: splitList(parsed.sexExcludes).filter((v) => typeof v === "string"),
    // blackList は配列(文字列 or {mail, keyword})とオブジェクト
    // ({ mailList, keywordList })の両方を受ける
    blackList: normalizeBlackList(parsed.blackList),
    // 直接指定スレ(directThreads)。文字列 or {url, title, newestFirst} の配列
    directThreads: Array.isArray(parsed.directThreads) ? parsed.directThreads : null,
  };
}

// blackList を判定用の配列(文字列 or { mail, keyword } オブジェクト)に正規化する。
// - 配列形式(従来): ["mail@example.com", { "keyword": "…" }, …]
// - オブジェクト形式: { "mailList": ["mail@example.com", …], "keywordList": [
//     "本文キーワード" または { "keyword": "…", "mail": "…" }, …] }
function normalizeBlackList(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const mailList = splitList(raw.mailList).filter((v) => typeof v === "string");
    const keywordList = Array.isArray(raw.keywordList)
      ? splitList(raw.keywordList)
      : [];
    return [...mailList, ...keywordList];
  }
  return splitList(raw);
}

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
  let config = await loadConfig();
  const mock = process.env.MOCK === "1" || isMockConfig(config);

  if (mock && process.env.MOCK !== "1") {
    console.log(
      "[scraper] 参考: SCRAPER_DOMAIN 環境変数または config.json の targetUrl で実サイトを取得できます",
    );
  }
  console.log(
    `[scraper] ${mock ? "モックモード" : "実サイト"} で実行します` +
      (showDetail && !mock ? `: ${config.targetUrl}` : ""),
  );

  const intervalMs = config.request?.intervalMs ?? 1500;
  const generatedAt = new Date().toISOString();

  summaryTargetUrl = mock ? "" : config.targetUrl;
  runSummary = {
    startedAt: generatedAt,
    finishedAt: null,
    mode: mock ? "mock" : "real",
    keywords: 0,
    listedThreads: 0,
    filteredThreads: 0,
    detailLimit: null,
    detailThreads: 0,
    detailOk: 0,
    detailFailed: 0,
    sexExcluded: 0,
    blackListed: 0,
    settingsGist: false,
    outputWritten: false,
    errors: [],
  };

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

  // 1. 巡回設定の取得。
  //    設定 gist(SCRAPER_SETTINGS_GIST_URL)があれば gist 内の JSON から
  //    キーワード・性別排除を読み込む(URL・ID はログに出さない)。
  //    読み込みに失敗した場合は実行を中止する(意図しないフィルタで
  //    巡回・通知されるのを避けるため)
  let gistSettings = null;
  try {
    gistSettings = await loadGistSettings();
    if (gistSettings) {
      runSummary.settingsGist = true;
      console.log(
        `[scraper] 設定 gist から巡回設定を読み込みました` +
          `(キーワード ${gistSettings.keywords.length} 件 / 性別排除 ${gistSettings.sexExcludes.length} 件` +
          ` / ブラックリスト ${gistSettings.blackList.length} 件)`,
      );
    }
  } catch (err) {
    runSummary.errors.push(maskUrl(err.message));
    throw err;
  }

  // 巡回キーワード: 環境変数 > 設定 gist > なし(categoryList / targetUrl 直巡回)
  const envKeywords = splitList(process.env.SCRAPER_KEYWORDS);
  const keywords = envKeywords.length > 0 ? envKeywords : (gistSettings?.keywords ?? []);
  if (gistSettings && envKeywords.length === 0 && gistSettings.keywords.length > 0) {
    console.log(`[scraper] キーワードは設定 gist 由来`);
  }

  // 性別排除: 環境変数 > 設定 gist > config.filters.sexExcludes
  const envSexExcludes = splitList(process.env.SCRAPER_SEX_EXCLUDES);
  const sexExcludes =
    envSexExcludes.length > 0
      ? envSexExcludes
      : gistSettings?.sexExcludes.length
        ? gistSettings.sexExcludes
        : (config.filters?.sexExcludes ?? []);
  if (sexExcludes.length > 0) {
    config = { ...config, filters: { ...config.filters, sexExcludes } };
  }

  // ブラックリスト(メール完全一致 + 投稿キーワード本文部分一致):
  // 環境変数 > 設定 gist > config.filters.blackList。形式は
  // normalizeBlackList(配列形式 / オブジェクト形式の両方)で正規化する。
  // 判定は parse.mjs の isBlacklisted(バッチのみ。Worker はメールページを取得しないため未対応)
  const envBlackList = normalizeBlackList(process.env.SCRAPER_BLACKLIST);
  const blackList =
    envBlackList.length > 0
      ? envBlackList
      : gistSettings?.blackList.length
        ? gistSettings.blackList
        : normalizeBlackList(config.filters?.blackList);
  if (blackList.length > 0) {
    config = { ...config, filters: { ...config.filters, blackList } };
  }

  // 巡回対象の決定: キーワードがあれば、キーワードごとに
  // スレ検索 URL を組み立てて各検索結果をスレ一覧として扱う。
  // なければ categoryList の取得、それもなければ targetUrl を直接スレッド一覧として扱う
  // キーワードの値(地名など)は実行ログ・実行サマリに出さない(件数のみ)
  //
  // SCRAPER_DIRECT_ONLY=1 の場合はキーワード検索・一覧巡回を省き、
  // directThreads(メインスレ)だけを取得する。メインスレ専用の軽量
  // ワークフロー(高頻度 cron)向け。directThreads は設定 gist から読むため
  // gist の読み込み自体は行う(失敗時は従来どおり実行を中止する)
  const directOnly = process.env.SCRAPER_DIRECT_ONLY === "1";
  // SCRAPER_SKIP_DIRECT=1 の場合は directThreads を巡回しない。
  // 地域別巡回のワークフローで直接指定スレを別ワークフローに任せるためのフラグ
  // (両フラグとも未設定なら、これまでどおり一覧 + directThreads の両方を巡回する)
  const skipDirect = process.env.SCRAPER_SKIP_DIRECT === "1";
  runSummary.keywords = keywords.length;
  let categories = [];
  if (directOnly) {
    console.log("[scraper] 直接指定スレのみを巡回します(SCRAPER_DIRECT_ONLY=1)");
  } else if (keywords.length > 0) {
    categories = keywords.map((kw) => ({ name: kw, url: buildSearchUrl(config, kw) }));
    console.log(`[scraper] キーワード検索: ${keywords.length} 件`);
    for (const [i, category] of categories.entries()) {
      console.log(`[scraper]   (${i + 1}/${keywords.length}) 検索中`);
    }
  } else if (config.categoryList?.selector) {
    const listHtml = await getHtml(config.targetUrl, "sample.html");
    categories = parseList(listHtml, config.categoryList)
      .map((row) => ({ name: row.name || "", url: resolveUrl(row.url, config.targetUrl) }))
      .filter((c) => c.name || c.url);
    console.log(`[scraper] カテゴリ: ${categories.length} 件`);
  }
  if (!directOnly && categories.length === 0) {
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
        const msg = maskUrl(`${pageUrl} の取得に失敗しました: ${err.message}`);
        console.warn(`[scraper] 警告: ${msg}`);
        runSummary.errors.push(msg);
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
  runSummary.listedThreads = allThreads.length;

  // 3. タイトルによる絞り込み
  const threads = allThreads.filter((t) => matchesFilters(t.title, config.filters));
  runSummary.filteredThreads = threads.length;
  console.log(
    `[scraper] フィルタ後: ${threads.length} 件` +
      (threads.length !== allThreads.length ? `(除外 ${allThreads.length - threads.length} 件)` : ""),
  );

  // 3.5 直接指定スレッド(directThreads)。
  // 「メインスレ」など一覧を経由せず毎回巡回したいスレを URL で直接指定する。
  // 要素は URL 文字列 or {url, title, newestFirst}:
  //   - newestFirst: true のスレは降順ページング(p=1 が最新)として取得する
  // 優先順: 設定 gist(gist の JSON に directThreads があればそちら) > config
  // 明示指定のためタイトルフィルタ(matchesFilters)は適用しない。
  // 一覧由来のスレと ID が重複した場合は一覧側を優先してスキップ
  // SCRAPER_SKIP_DIRECT=1 の場合は directThreads をスキップする(直接指定スレは
  // 別ワークフロー(SCRAPER_DIRECT_ONLY=1)が取得・通知するため二重通知を避ける)
  const directThreadSpecs = skipDirect
    ? []
    : gistSettings?.directThreads?.length
      ? gistSettings.directThreads
      : (config.directThreads ?? []);
  if (skipDirect) {
    console.log("[scraper] 直接指定スレはスキップします(SCRAPER_SKIP_DIRECT=1・別実行が担当)");
  }
  let directCount = 0;
  // 直接指定のみのモードでは一覧由来スレが無いため、重複チェックは空から始める
  const seenDirect = new Set(directOnly ? [] : threads.map((t) => t.id));
  for (const entry of directThreadSpecs) {
    const spec = typeof entry === "string" ? { url: entry } : (entry ?? {});
    const url = String(spec.url ?? "").trim();
    if (!url) continue;
    const resolved = resolveUrl(url, config.targetUrl);
    const id = threadIdFromUrl(resolved);
    if (!id || seenDirect.has(id)) continue;
    seenDirect.add(id);
    threads.push({
      id,
      title: String(spec.title ?? ""),
      url: resolved,
      category: "(直接指定)",
      resCount: 0,
      createdAt: "",
      newestFirst: Boolean(spec.newestFirst),
      // スレ単位の上限上書き(重たいスレを個別に軽量化するため)。
      // 未指定なら共通値(thread.maxPages / thread.maxAgeDays)を使う
      maxPages: Number(spec.maxPages) > 0 ? Number(spec.maxPages) : undefined,
      maxAgeDays: spec.maxAgeDays === undefined || spec.maxAgeDays === null
        ? undefined
        : Number(spec.maxAgeDays),
    });
    directCount++;
  }
  if (directCount > 0) {
    console.log(`[scraper] 直接指定スレ: ${directCount} 件を巡回対象に追加`);
    runSummary.directThreads = directCount;
  }

  // 詳細取得の件数上限(環境変数 SCRAPER_MAX_THREADS)。手元での動作確認用。
  // 1 スレ = 詳細ページ + メール送信ページの複数リクエストが intervalMs 以上の
  // 間隔で走るため、全件だと時間がかかる(リスト自体は制限前の全件を出力する)
  const maxDetailThreads = Number(process.env.SCRAPER_MAX_THREADS) || 0;
  runSummary.detailLimit = maxDetailThreads || null;
  if (maxDetailThreads > 0 && threads.length > maxDetailThreads) {
    console.log(
      `[scraper] SCRAPER_MAX_THREADS=${maxDetailThreads} のため、詳細取得は先頭 ${maxDetailThreads} 件に制限します`,
    );
  }
  if (threads.length === 0) {
    if (directOnly) {
      // 直接指定のみのモードで directThreads 未設定のときは、エラーにせず
      // 何もせず正常終了する(毎回失敗する workflow を作らないため)
      console.log("[scraper] 直接指定スレが未設定のため、何もせず終了します");
      await writeRunSummary();
      return;
    }
    throw new Error("フィルタ条件に一致するスレッドがありません。filters の設定を確認してください。");
  }

  // 4. 該当スレッドの本文取得(スレッド内のページ送り対応)
  const maxThreadPages = config.thread?.maxPages ?? 1;

  // B ページ(スレ本文)の取得範囲: 実行時から maxAgeDays 日前まで。
  // 通常スレは昇順(p=1 が最古)のため、ナビの p=N リンクから最終ページを推定して
  // 新しい側から遡り、全レスが範囲外になったページで打ち切る
  // (先頭から順に取得すると、伸びたスレの範囲内レスのために古いページを
  //  大量に取得することになるため)。
  // directThreads で newestFirst: true を指定したスレは降順(p=1 が最新)なので
  // p=1 から順に取得し、全レスが範囲外になったページで打ち切る
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
    // スレ単位の上限上書き(directThreads の各要素の maxPages / maxAgeDays)。
    // 未指定の項目は共通値(thread.maxPages / thread.maxAgeDays)を使う
    const maxPages = Number(thread.maxPages) > 0 ? Number(thread.maxPages) : maxThreadPages;
    const cutoff =
      thread.maxAgeDays === undefined
        ? cutoffTs
        : Number(thread.maxAgeDays) > 0
          ? Date.now() - Number(thread.maxAgeDays) * 86400_000
          : null; // maxAgeDays: 0 なら範囲制限なし
    // レスが取得範囲内(実行時から maxAgeDays 日前以降)か
    const postInRange = (post) => {
      if (cutoff === null) return true;
      const ts = parsePostDateMs(post.date);
      return ts !== null && ts >= cutoff;
    };

    // 先頭ページ(p=1)を取得: タイトルとページ送りナビ(最終ページの推定元)を得る
    const firstHtml = await getHtml(thread.url, "sample-thread.html");
    const parsedFirst = parseThread(firstHtml, config.thread);
    // 直接指定スレ(thread.newestFirst)などタイトル要素がないページは
    // config の title(directThreads の title)をフォールバックに使う
    const title = parsedFirst.title || thread.title || "";

    const byNum = new Map(); // レス番号 → レス(ページ送り・ページ跨ぎの重複排除)
    const collect = (pagePosts) => {
      for (const post of pagePosts) {
        if (!byNum.has(post.num)) byNum.set(post.num, post);
      }
    };
    collect(parsedFirst.posts);

    if (thread.newestFirst) {
      // 降順ページング(p=1 が最新・p=2 が過去)のスレ:
      // 新しい側(p=1)から順に取得し、1 ページ全部が範囲外になった時点で
      // 打ち切る(降順なのでそれより古いページも範囲外のため)
      let fetchedPages = 1; // p=1 分
      for (let p = 2; fetchedPages < maxPages; p++) {
        const pageUrl = buildThreadPageUrl(thread.url, pageParam, p);
        const parsed = parseThread(await getHtml(pageUrl, "sample-thread.html"), config.thread);
        collect(parsed.posts);
        fetchedPages++;
        if (cutoff !== null && !parsed.posts.some(postInRange)) break;
      }
    } else if (cutoff !== null) {
      // ナビの p=N リンクから最終ページ番号を推定し、新しい側から遡る
      // (HTML 実体参照の &amp; は先に展開しておく)
      let lastPage = 1;
      for (const m of firstHtml.replace(/&amp;/g, "&").matchAll(lastPageRe)) {
        lastPage = Math.max(lastPage, Number(m[1]));
      }
      let fetchedPages = 1; // p=1 分
      for (let p = lastPage; p >= 2 && fetchedPages < maxPages; p--) {
        const pageUrl = buildThreadPageUrl(thread.url, pageParam, p);
        const parsed = parseThread(await getHtml(pageUrl, "sample-thread.html"), config.thread);
        collect(parsed.posts);
        fetchedPages++;
        // このページのレスがすべて範囲外なら、より古いページも範囲外なので打ち切り
        if (!parsed.posts.some(postInRange)) break;
      }
    } else {
      // 範囲制限なし: 従来どおり nextPage リンクを辿る(maxPages ページまで)
      let pageUrl = thread.url;
      let html = firstHtml;
      for (let page = 1; page <= maxPages && pageUrl; page++) {
        const parsed = page === 1 ? parsedFirst : parseThread(html, config.thread);
        collect(parsed.posts);
        const nextHref = parseNextPageUrl(html, config.thread);
        pageUrl = nextHref ? resolveUrl(nextHref, pageUrl) : "";
      }
    }

    // 範囲内かつ性別排除キーワードに該当しないレスのみ残して昇順に並べる
    const inRange = [...byNum.values()].filter(postInRange);
    const posts = inRange
      .filter((post) => !isSexExcluded(post, config.filters))
      .sort((a, b) => a.num - b.num);
    return { title, posts, excluded: inRange.length - posts.length };
  }

  const detailTargets = maxDetailThreads > 0 ? threads.slice(0, maxDetailThreads) : threads;
  runSummary.detailThreads = detailTargets.length;
  for (const [i, thread] of detailTargets.entries()) {
    // スレタイ・スレ URL は掲示板から取得した情報なので CI の public ログには出さない
    console.log(
      `[scraper] (${i + 1}/${threads.length}) スレ詳細取得中` +
        (showDetail && (thread.title || thread.url) ? `: ${thread.title || thread.url}` : ""),
    );
    try {
      const { title, posts, excluded } = await fetchThreadDetail(thread);
      runSummary.sexExcluded += excluded;
      if (excluded > 0) {
        console.log(`[scraper]   性別排除: ${excluded} 件を除外`);
      }
      runSummary.detailOk++;

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
              const msg = maskUrl(`${mailPageUrl} の取得に失敗しました: ${err.message}`);
              console.warn(`[scraper] 警告: ${msg}`);
              runSummary.errors.push(msg);
            }
          }
          post.email = mailEmailCache.get(mailPageUrl) ?? "";
        }
      }

      // 4.6 ブラックリスト(メールアドレス完全一致)に該当するレスを出力から除外
      // (メールアドレスは 4.5 で確定した後で判定する)
      let detailPosts = posts;
      if ((config.filters?.blackList ?? []).length > 0) {
        const before = detailPosts.length;
        detailPosts = detailPosts.filter((post) => !isBlacklisted(post, config.filters));
        const blacklisted = before - detailPosts.length;
        if (blacklisted > 0) {
          console.log(`[scraper]   ブラックリスト: ${blacklisted} 件を除外`);
          runSummary.blackListed += blacklisted;
        }
      }

      thread.detail = { title, posts: detailPosts };
      // モックモードでは全スレが同じサンプルファイルを共有するため上書きしない
      if (title && !mock) {
        thread.title = title;
      }
      thread.resCount = detailPosts.length;
    } catch (err) {
      // 個別スレッドの失敗は全体を中断しない(一覧には resCount 掲載のまま表示)
      runSummary.detailFailed++;
      const msg = maskUrl(`(${i + 1}/${threads.length}) スレ(${thread.url})の取得に失敗しました: ${err.message}`);
      console.warn(`[scraper] 警告: ${msg}`);
      runSummary.errors.push(msg);
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
  runSummary.outputWritten = true;
  await writeRunSummary();
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

main().catch(async (err) => {
  console.error(`[scraper] 失敗: ${err.message}`);
  // 失敗時もサマリは書き出す(Actions の log/latest-run.md 更新に使う)
  if (runSummary) {
    runSummary.errors.push(maskUrl(err.message));
    try {
      await writeRunSummary();
    } catch {
      // サマリ書き出しの失敗は本命のエラー報告に支障を出さない
    }
  }
  process.exit(1);
});
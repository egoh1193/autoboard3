// 系統①:サイト本体。
// 静的アセット(site/)はそのまま配信し、/data/* の JSON のみアクセス時に
// リアルタイムでスクレイピングした結果を返す。
// Discord 通知(系統②)は GitHub Actions 側(scraper/notify.mjs)が担う。

import { loadConfig, scrapeThreads, type Env, type ScrapeResult, type ThreadData } from "./scrape";
// @ts-expect-error -- JS モジュール(型定義なし、esbuild でバンドルされる)
import { excerptFromBody, pinForPost } from "../../scraper/map.mjs";

const CACHE_KEY = new Request("https://internal.board-mirror/scrape-result");

// 限定公開: 全レスポンスに noindex を付け、検索エンジンに収集されないようにする
// (robots.txt の Disallow は未収集のクローラーにのみ効く。既に URL を知っている
//  クローラー向けに X-Robots-Tag / meta robots で noindex を重ねがけする)
const ROBOTS_HEADERS: Record<string, string> = { "X-Robots-Tag": "noindex, nofollow" };

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...ROBOTS_HEADERS,
    },
  });

// スクレイピング結果を Cache API(cacheTtlSec 秒)で共有する。
// 一覧とスレッド詳細で同じ結果を使い回すため、どちらのエンドポイントもこの関数を通る。
async function getScrapeResult(env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<ScrapeResult> {
  const cache = caches.default;
  const cached = await cache.match(CACHE_KEY);
  if (cached) {
    return (await cached.json()) as ScrapeResult;
  }

  const config = loadConfig(env);
  const result = await scrapeThreads(config);

  const ttl = config.site?.cacheTtlSec ?? 300;
  waitUntil(
    cache.put(
      CACHE_KEY,
      new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${ttl}` },
      }),
    ),
  );
  return result;
}

async function handleData(pathname: string, env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  const result = await getScrapeResult(env, waitUntil);

  if (pathname === "/data/threads.json") {
    return jsonResponse({
      generatedAt: result.generatedAt,
      threads: result.threads,
      mainThreads: result.mainThreads,
    });
  }

  // /map 用のピンデータ。既存のスクレイプ結果(キャッシュ済み)から
  // 地名対応表(config.map.places)に一致した投稿だけをピン化する
  if (pathname === "/data/map.json") {
    const config = loadConfig(env);
    const pins = Object.values(result.details).flatMap((thread) =>
      thread.posts.flatMap((post) => {
        const pin = pinForPost(post, thread, config);
        if (!pin) return [];
        return [
          {
            threadId: thread.id,
            threadTitle: thread.title,
            num: post.num,
            name: post.name || "名無しさん",
            age: post.age ?? "",
            sex: post.sex ?? "",
            area: post.area ?? "",
            body: excerptFromBody(post.body),
            lat: pin.lat,
            lng: pin.lng,
          },
        ];
      }),
    );
    return jsonResponse({ generatedAt: result.generatedAt, pins });
  }

  // /data/threads/<id>.json
  const id = decodeURIComponent(pathname.slice("/data/threads/".length).replace(/\.json$/, ""));
  const detail: ThreadData | undefined = result.details[id];
  if (!detail) {
    return jsonResponse({ error: "スレッドが見つかりません" }, 404);
  }
  return jsonResponse(detail);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (
      pathname === "/data/threads.json" ||
      pathname === "/data/map.json" ||
      (pathname.startsWith("/data/threads/") && pathname.endsWith(".json"))
    ) {
      try {
        return await handleData(pathname, env, (p) => ctx.waitUntil(p));
      } catch (err) {
        console.error(`[worker] スクレイピング失敗: ${err}`);
        return jsonResponse(
          { error: `掲示板の取得に失敗しました: ${err instanceof Error ? err.message : String(err)}` },
          502,
        );
      }
    }
    // 静的アセット(robots.txt / HTML / JS / CSS)にも noindex ヘッダを付けて返す
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    for (const [key, value] of Object.entries(ROBOTS_HEADERS)) {
      headers.set(key, value);
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },

  // Cron トリガー(*/10)。GitHub Actions の schedule は高頻度 cron が間引かれる
  // (実勢 2〜4 時間おき)ため、Cloudflare Cron から workflow_dispatch で
  // scrape.yml(地域別巡回)を確実に起動する。トークンは Actions: Write 権限の PAT
  // (リポジトリシークレット GH_DISPATCH_TOKEN → deploy.yml が Worker secret に同期)。
  // 未設定なら何もしない(参照系のアクセスには影響しない)
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const token = env.GH_DISPATCH_TOKEN?.trim();
    if (!token) {
      console.log("[worker] cron: GH_DISPATCH_TOKEN 未設定のため dispatch をスキップします");
      return;
    }
    const repo = env.GH_DISPATCH_REPO || "egoh1193/autoboard3";
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/scrape.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "board-mirror-cron",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    if (res.status === 204) {
      console.log("[worker] cron: scrape.yml を dispatch しました");
    } else {
      // 失敗理由はステータスコードのみ(レスポンス本文のログ出力はしない)
      console.error(`[worker] cron: dispatch 失敗 (HTTP ${res.status})`);
    }
  },
};
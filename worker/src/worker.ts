// 系統①:サイト本体。
// 静的アセット(site/)はそのまま配信し、/data/* の JSON のみアクセス時に
// リアルタイムでスクレイピングした結果を返す。
// Discord 通知(系統②)は GitHub Actions 側(scraper/notify.mjs)が担う。

import { loadConfig, scrapeThreads, type Env, type ScrapeResult, type ThreadData } from "./scrape";

const CACHE_KEY = new Request("https://internal.board-mirror/scrape-result");

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
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
    return jsonResponse({ generatedAt: result.generatedAt, threads: result.threads });
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
    return env.ASSETS.fetch(request);
  },
};
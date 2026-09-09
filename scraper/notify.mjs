// 系統②:通知(scraper/notify.mjs)
//
// 直前のスクレイプ結果(site/data/threads.json)と状態ファイル(.scrape-state.json)
// を比較し、前回以降の新着を「投稿者ごと」にまとめて GitHub Gist に投稿し、
// その URL を Discord webhook に投稿する。
// 差分はレス単位: 新規スレは窓内の全レス、既存スレは状態に保存した
// 既知の最終レス番号(knownPosts)より大きいレス番号のレスが新着になる
// (本文そのものは Discord に送らない)。各レスの見出しには元投稿スレ
// (タイトル・URL)を付ける。
// 状態ファイルは GitHub Actions の actions/cache で次回実行へ引き継ぐ。
//
// 環境変数:
//   DISCORD_WEBHOOK_URL … Discord の webhook URL
//   GIST_TOKEN          … gist 権限を持つ GitHub PAT(※ Actions 既定の
//                          GITHUB_TOKEN では gist を作成できないため要 PAT)
//   GIST_API_URL        … gist 作成 API の URL(既定: https://api.github.com/gists)
//                          (テスト用のダミーサーバーなどに差し替え可能)
//   STATE_PATH          … 状態ファイルのパス(既定: リポジトリ直下の .scrape-state.json)
//
// DISCORD_WEBHOOK_URL / GIST_TOKEN が未設定なら投稿をスキップし、状態ファイルも
// 更新しない(=設定後に新着として通知される)。Gist は秘密 gist(public: false)で
// 作成するが、URL を知っている者は誰でも閲覧できるため取り扱いに注意すること。
//
// ※ Gist の Markdown 形式は要調整。buildGistContent() を書き換えること。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRAPER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(SCRAPER_DIR, "../site/data/threads.json");
const DETAIL_DIR = path.resolve(SCRAPER_DIR, "../site/data/threads");
const DEFAULT_STATE_PATH = path.resolve(SCRAPER_DIR, "../.scrape-state.json");

// gist URL は秘密 gist とはいえ URL を知れば閲覧可のため、
// ローカル・CI を問わずログには出さない(投稿済みの件数だけを表示する)

async function loadState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      return null; // 初回実行
    }
    throw err;
  }
}

// レス1件を Markdown に整形する。本文は段落解釈を避けるため
// 4スペースインデント(コードブロック)でそのまま表示する
function formatPost(post) {
  const labels = {
    age: "年齢",
    sex: "性別",
    looks: "ﾙｯｸｽ",
    wish: "区分",
    ip: "IP",
    device: "機種情報",
    email: "メール",
  };
  const known = ["num", "name", "date", "body", "mailUrl", "images"];
  const lines = [];
  const header = [post.name, post.date].filter(Boolean).join(" ");
  lines.push(`#### ${post.num}. ${header}`);
  for (const [key, value] of Object.entries(post)) {
    if (known.includes(key) || !value) continue;
    lines.push(`- ${labels[key] || key}: ${value}`);
  }
  if (Array.isArray(post.images)) {
    for (const src of post.images) {
      lines.push(`- 画像: ${src}`);
    }
  }
  lines.push("");
  for (const line of (post.body || "").split("\n")) {
    lines.push(`    ${line}`);
  }
  lines.push("");
  return lines.join("\n");
}

// 新着スレ・新着レスを「投稿者ごと」にグループ化する。
// entries: [{ thread, posts }](新規スレは全レス、既存スレは新着レスのみ)
// 戻り値: Map(投稿者名 → Map(スレッドID → { thread, posts }))
// 投稿者名が空のレスは「(名前なし)」にまとめる。同一投稿者のレスは
// 元投稿スレ(タイトル・URL)を付けてスレ単位で束ねて出力する
function groupPostsByAuthor(entries) {
  const byAuthor = new Map();
  for (const { thread, posts } of entries) {
    for (const post of posts) {
      const name = (post.name ?? "").trim() || "(名前なし)";
      if (!byAuthor.has(name)) byAuthor.set(name, new Map());
      const threadsMap = byAuthor.get(name);
      if (!threadsMap.has(thread.id)) threadsMap.set(thread.id, { thread, posts: [] });
      threadsMap.get(thread.id).posts.push(post);
    }
  }
  return byAuthor;
}

// 新着投稿一覧を「投稿者ごと」に組み立てて Gist に投稿する Markdown を作る。
// 各レスの見出しに元投稿スレ(タイトル・URL)を付与する
function buildGistContent({ entries, generatedAt, isFirstRun, totalThreads, noDetailCount }) {
  const byAuthor = groupPostsByAuthor(entries);
  const postCount = entries.reduce((n, e) => n + e.posts.length, 0);
  const lines = [];
  lines.push(
    isFirstRun
      ? `# 初回実行: 現在の対象スレ ${entries.length} 件(次回からは新着のみ)`
      : `# 新着投稿 ${postCount} 件(投稿者 ${byAuthor.size} 名 / スレ ${entries.length} 件)`,
  );
  lines.push("");
  lines.push(`- スクレイプ生成日時: ${generatedAt}`);
  lines.push(`- 対象スレ合計: ${totalThreads} 件`);
  // 本文未取得スレは投稿者一覧に出せないため、存在だけ明記する
  if (noDetailCount > 0) {
    lines.push(`- 本文未取得スレ: ${noDetailCount} 件(以下の投稿者一覧には含まれない)`);
  }
  lines.push("");

  for (const [name, threadsMap] of byAuthor) {
    const authorPostCount = [...threadsMap.values()].reduce((x, g) => x + g.posts.length, 0);
    lines.push("---");
    lines.push("");
    lines.push(`## ${name}(${authorPostCount} レス)`);
    lines.push("");
    for (const { thread, posts } of threadsMap.values()) {
      // 元投稿スレの情報(投稿がどこから来たか)
      lines.push(`### 元スレ: ${thread.title || "(タイトルなし)"}`);
      lines.push("");
      lines.push(`- URL: ${thread.url}`);
      if (thread.category) lines.push(`- カテゴリ: ${thread.category}`);
      lines.push("");
      for (const post of posts) {
        lines.push(formatPost(post));
      }
    }
  }
  return lines.join("\n");
}

// 秘密 gist を作成し、その URL を返す
async function createGist(token, apiUrl, filename, description, content) {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "board-mirror-notify",
    },
    body: JSON.stringify({
      description,
      public: false, // 秘密 gist(検索・一覧には出ないが URL を知れば閲覧可)
      files: { [filename]: { content } },
    }),
  });
  if (!res.ok) {
    throw new Error(`Gist 作成に失敗しました (HTTP ${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.html_url;
}

// Discord に投稿する短いメッセージ(本文・スレタイは載せず gist URL のみ)。
// 詳細はすべて gist 側に任せる
function buildDiscordMessage(gistUrl) {
  return `更新がありました。\n${gistUrl}`;
}

async function postToDiscord(webhookUrl, content) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(`Discord 投稿に失敗しました (HTTP ${res.status})`);
  }
}

// 実行サマリ(RUN_SUMMARY_JSON)に通知結果を書き戻す。
// gist URL・Discord webhook URL は public リポジトリのログに入らないため含めない
async function mergeNotifySummary(status) {
  const summaryPath = process.env.RUN_SUMMARY_JSON;
  if (!summaryPath) return;
  try {
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    summary.notify = {
      status,
      newThreads: notifyNewThreads,
      newPosts: notifyNewPosts,
    };
    await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  } catch (err) {
    console.warn(`[notify] 警告: 実行サマリの更新に失敗しました: ${err.message}`);
  }
}

let notifyNewThreads = 0;
let notifyNewPosts = 0;

async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const gistToken = process.env.GIST_TOKEN;
  const gistApiUrl = process.env.GIST_API_URL || "https://api.github.com/gists";
  const statePath = process.env.STATE_PATH || DEFAULT_STATE_PATH;

  const { generatedAt, threads } = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const state = await loadState(statePath);
  const knownIds = new Set(state?.knownIds ?? []);
  // スレごとの既知最終レス番号(レス単位の差分検出用)。
  // 旧形式の状態ファイルには無いため {} として扱う(その実行は新着多めになる)
  const knownPosts = state?.knownPosts ?? {};

  // 本文が空 or 2 文字以下のレスは募集削除の可能性が高いため通知から除外する
  // (基準 knownPosts には通常どおり含むため、後から 本文が変わっても
  // 同じレス番号で再通知されることはない)
  const isNotifiableBody = (post) => String(post?.body ?? "").trim().length > 2;

  // 新着の差分を組み立てる:
  // - 新規スレ(knownIds に無い)→ 窓内の全レスが新着
  // - 既存スレ → 既知の最終レス番号より大きいレス番号のレスが新着
  // 詳細ファイルが無いスレ(本文取得失敗)はレスが拾えないため、
  // レス番号の基準も進めない(次回に新着として通知される)
  const entries = [];
  let noDetailCount = 0;
  const nextKnownPosts = { ...knownPosts };
  for (const thread of threads) {
    const baseline = Number(knownPosts[thread.id]) || 0;
    let posts = [];
    let hasDetail = true;
    try {
      const detail = JSON.parse(
        await readFile(path.join(DETAIL_DIR, `${thread.id}.json`), "utf8"),
      );
      posts = Array.isArray(detail.posts) ? detail.posts : [];
    } catch (err) {
      if (err.code === "ENOENT") hasDetail = false;
      else throw err;
    }
    const maxNum = posts.reduce((m, p) => Math.max(m, Number(p.num) || 0), 0);
    if (!knownIds.has(thread.id)) {
      // 新規スレ: 通知できるレス(窓内・募集削除以外)があれば全レスを新着として通知する
      const notifyPosts = posts.filter(isNotifiableBody);
      if (hasDetail && notifyPosts.length > 0) {
        entries.push({ thread, posts: notifyPosts });
      } else {
        noDetailCount++;
      }
    } else {
      const fresh = posts.filter(
        (p) => (Number(p.num) || 0) > baseline && isNotifiableBody(p),
      );
      if (fresh.length > 0) {
        entries.push({ thread, posts: fresh });
      }
    }
    // 基準は単調に進める(レス窓の関係で 1 回だけレスが取れない実行が
    // あっても基準が下がらず、同じレスを重複通知しない)
    if (maxNum > baseline) nextKnownPosts[thread.id] = maxNum;
  }
  const totalNewPosts = entries.reduce((n, e) => n + e.posts.length, 0);
  notifyNewThreads = entries.length;
  notifyNewPosts = totalNewPosts;

  console.log(
    `[notify] スクレイプ結果: ${threads.length} 件 (生成 ${generatedAt}) / 既知スレ: ${knownIds.size} 件 / 新着: ${entries.length} スレ ${totalNewPosts} レス`,
  );

  if (!webhookUrl || !gistToken) {
    console.warn(
      "[notify] 警告: DISCORD_WEBHOOK_URL または GIST_TOKEN が未設定のため投稿をスキップします(状態は更新しません)",
    );
    await mergeNotifySummary("skipped-unconfigured");
    return;
  }

  if (entries.length > 0) {
    const content = buildGistContent({
      entries,
      generatedAt,
      isFirstRun: state === null,
      totalThreads: threads.length,
      noDetailCount,
    });
    const stamp = new Date(generatedAt).toISOString().replace(/[:.]/g, "-");
    const gistUrl = await createGist(
      gistToken,
      gistApiUrl,
      `new-posts-${stamp}.md`,
      `掲示板ミラー 新着投稿(${entries.length} スレ / ${totalNewPosts} レス / ${stamp})`,
      content,
    );
    // gist URL はログに出さない(URL を知れば閲覧可のため。ローカル・CI 共通)
    console.log(`[notify] Gist を作成しました(新着 ${entries.length} スレ / ${totalNewPosts} レス)`);

    await postToDiscord(webhookUrl, buildDiscordMessage(gistUrl));
    console.log("[notify] Discord に gist URL を投稿しました");
    await mergeNotifySummary("posted");
  } else {
    console.log("[notify] 新着なし。投稿をスキップします");
    await mergeNotifySummary("no-new");
  }

  // 現在の全スレ ID と、スレごとの既知最終レス番号を次回の「既知」として保存する
  const nextKnownIds = [...new Set([...knownIds, ...threads.map((t) => t.id)])];
  await writeFile(
    statePath,
    JSON.stringify({ knownIds: nextKnownIds, knownPosts: nextKnownPosts }, null, 2),
  );
  console.log(`[notify] 状態を保存しました (${statePath}, ${nextKnownIds.length} 件)`);
}

main().catch(async (err) => {
  console.error(`[notify] 失敗: ${err.message}`);
  try {
    await mergeNotifySummary("failed");
  } catch {
    // サマリ更新の失敗は本命のエラー報告に支障を出さない
  }
  process.exit(1);
});
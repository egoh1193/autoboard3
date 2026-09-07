// 系統②:通知(scraper/notify.mjs)
//
// 直前のスクレイプ結果(site/data/threads.json)と状態ファイル(.scrape-state.json)
// を比較し、前回以降に新しく見つかったスレッドの詳細を GitHub Gist に投稿して、
// その URL を Discord webhook に投稿する(本文そのものは Discord に送らない)。
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

// CI(GitHub Actions)でも処理ステップは出す。ただし gist URL は秘密 gist とはいえ
// URL を知れば閲覧可のため、CI の public ログには出さない(ローカルでは表示)
const showDetail = !process.env.CI;

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

// 新着スレ一覧を Gist に投稿する Markdown に組み立てる
function buildGistContent({ newThreads, details, generatedAt, isFirstRun, totalThreads }) {
  const lines = [];
  lines.push(
    isFirstRun
      ? `# 初回実行: 現在の対象スレ ${newThreads.length} 件(次回からは新着のみ)`
      : `# 新着スレッド ${newThreads.length} 件`,
  );
  lines.push("");
  lines.push(`- スクレイプ生成日時: ${generatedAt}`);
  lines.push(`- 対象スレ合計: ${totalThreads} 件`);
  lines.push("");

  for (const thread of newThreads) {
    const detail = details[thread.id];
    lines.push("---");
    lines.push("");
    lines.push(`## ${thread.title || "(タイトルなし)"}`);
    lines.push("");
    lines.push(`- URL: ${thread.url}`);
    lines.push(`- スレッド ID: ${thread.id}`);
    if (thread.category) lines.push(`- カテゴリ: ${thread.category}`);
    lines.push(`- レス数: ${detail ? detail.posts.length : thread.resCount}`);
    lines.push("");
    if (!detail) {
      lines.push("(本文の取得に失敗していたため、詳細はありません)");
      lines.push("");
      continue;
    }
    lines.push("### レス");
    lines.push("");
    for (const post of detail.posts) {
      lines.push(formatPost(post));
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
    summary.notify = { status, newThreads: notifyNewThreads };
    await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  } catch (err) {
    console.warn(`[notify] 警告: 実行サマリの更新に失敗しました: ${err.message}`);
  }
}

let notifyNewThreads = 0;

async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const gistToken = process.env.GIST_TOKEN;
  const gistApiUrl = process.env.GIST_API_URL || "https://api.github.com/gists";
  const statePath = process.env.STATE_PATH || DEFAULT_STATE_PATH;

  const { generatedAt, threads } = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const state = await loadState(statePath);
  const knownIds = new Set(state?.knownIds ?? []);
  const newThreads = threads.filter((t) => !knownIds.has(t.id));
  notifyNewThreads = newThreads.length;

  console.log(
    `[notify] スクレイプ結果: ${threads.length} 件 (生成 ${generatedAt}) / 既知: ${knownIds.size} 件 / 新着: ${newThreads.length} 件`,
  );

  if (!webhookUrl || !gistToken) {
    console.warn(
      "[notify] 警告: DISCORD_WEBHOOK_URL または GIST_TOKEN が未設定のため投稿をスキップします(状態は更新しません)",
    );
    await mergeNotifySummary("skipped-unconfigured");
    return;
  }

  if (newThreads.length > 0) {
    // 新着スレの本文詳細を読み込む(取得失敗でファイルがないスレはメタ情報のみ)
    const details = {};
    for (const thread of newThreads) {
      try {
        details[thread.id] = JSON.parse(
          await readFile(path.join(DETAIL_DIR, `${thread.id}.json`), "utf8"),
        );
      } catch (err) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
    }

    const content = buildGistContent({
      newThreads,
      details,
      generatedAt,
      isFirstRun: state === null,
      totalThreads: threads.length,
    });
    const stamp = new Date(generatedAt).toISOString().replace(/[:.]/g, "-");
    const gistUrl = await createGist(
      gistToken,
      gistApiUrl,
      `new-threads-${stamp}.md`,
      `掲示板ミラー 新着スレッド ${newThreads.length} 件(${stamp})`,
      content,
    );
    // gist URL は秘密 gist とはいえ URL を知れば閲覧可のため、CI の public ログには出さない
    console.log(`[notify] Gist を作成しました${showDetail ? `: ${gistUrl}` : ""}`);

    await postToDiscord(webhookUrl, buildDiscordMessage(gistUrl));
    console.log("[notify] Discord に gist URL を投稿しました");
    await mergeNotifySummary("posted");
  } else {
    console.log("[notify] 新着なし。投稿をスキップします");
    await mergeNotifySummary("no-new");
  }

  // 現在の全スレ ID を次回の「既知」として保存する
  const nextKnownIds = [...new Set([...knownIds, ...threads.map((t) => t.id)])];
  await writeFile(statePath, JSON.stringify({ knownIds: nextKnownIds }, null, 2));
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
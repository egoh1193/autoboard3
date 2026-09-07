// 自動投稿(poster/index.mjs)
//
// 設定 gist(SCRAPER_SETTINGS_GIST_URL)の JSON 内の "post" ブロックに従い、
// Playwright(Chromium ヘッドレス)で投稿フォームを自動操作して掲示板に投稿する。
// 対象掲示板は自営・投稿許可済みのもの。
//
// gist の "post" ブロックは「投稿系統」を 1 個(オブジェクト)または
// 複数(配列)で書ける。各系統は投稿先・間隔・投稿内容を独立に持ち、
// 投稿状態(前回投稿時刻・ローテーション番号)も系統ごとに管理される:
//   {
//     "post": [
//       {
//         "name": "飲み会系統",            // 省略可(状態のキー。省略時は #0, #1 …)
//         "enabled": true,                 // 省略可(false でこの系統を無効化)
//         "threadIds": ["89547", ...],     // 投稿先スレの ID
//         "formPath": "/public/comment/?id={id}", // フォームページのパス({id} を置換)
//         "intervalMinutes": 180,          // 投稿間隔(分)。この間隔ごとに 1 回投稿
//         "posts": [                       // 投稿内容のパターン(順にローテーション)
//           {
//             "fields": {                  // フォームの name 属性 → 値
//               "name": "…", "email": "…", "area": "…",
//               "sex": "…", "age": "…", "type": "…",
//               "free_category2": "…", "free_category3": "…",
//               "content": "…", "edit_password": "…",
//               "send_deny": true          // checkbox は true/false
//             },
//             "sage": true                 // sage チェックボックス(任意)
//             // ※ image_auth(画像認証)は設定不要。フォーム内の認証画像
//             //   (image_auth_N.png)の数字を表示順に並べて自動入力する
//           }
//         ]
//       }
//     ]
//   }
//
// 投稿内容(名前・メール・本文・編集キー)は秘密 gist に置かれ、
// ローカル・CI を問わずログに出さない(件数のみ)。エラー内の URL も
// maskUrl() で *** にマスクする。
//
// 状態(.post-state.json)は actions/cache で次回実行へ引き継ぐ:
//   { configs: { [系統名]: { lastPostedAt: epoch ms, rotateIndex: ローテ番号 } } }
// 1 回の投稿試行(成否問わず)ごとに lastPostedAt を進めるため、
// 失敗しても間隔内に再試行して掲示板を連打することはない。
//
// 環境変数:
//   SCRAPER_SETTINGS_GIST_URL … 設定 gist の URL(必須。post ブロックを読む)
//   GIST_TOKEN                … 秘密 gist を読むための PAT
//   GIST_API_URL              … gist API のベース URL(テスト用差し替え)
//   SCRAPER_DOMAIN            … 実サイトのドメイン(ドメインのみで可)
//   STATE_PATH                … 状態ファイルのパス(既定: リポジトリ直下 .post-state.json)
//   RUN_SUMMARY_JSON          … 実行サマリの書き出し先

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STATE_PATH = path.resolve(REPO_ROOT, ".post-state.json");
const DEFAULT_FORM_PATH = "/public/comment/?id={id}";

// スクレイパー側と同じ: gist 内の最初の .json ファイルを読む
async function loadGistJson() {
  const raw = process.env.SCRAPER_SETTINGS_GIST_URL;
  if (!raw) return null;
  const gistId = gistIdFromUrl(raw);
  if (!gistId) {
    throw new Error("SCRAPER_SETTINGS_GIST_URL を gist ID として解釈できませんでした");
  }
  const base = (process.env.GIST_API_URL || "https://api.github.com/gists").replace(/\/$/, "");
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "board-mirror-poster" };
  if (process.env.GIST_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GIST_TOKEN}`;
  }
  const res = await fetch(`${base}/${gistId}`, { headers });
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
  return JSON.parse(jsonFile.content);
}

function gistIdFromUrl(raw) {
  const value = raw.trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.hostname.endsWith("gist.githubusercontent.com")) return url.pathname.split("/")[1] ?? "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "gist.github.com" && parts.length >= 2) return parts[1];
    return parts[parts.length - 1] ?? "";
  } catch {
    // URL でなければ gist ID そのものとみなす
    return value;
  }
}

// SCRAPER_DOMAIN(ドメインのみ可)または config.example.json の targetUrl から
// オリジンを組み立てる(scraper/index.mjs の loadConfig と同じ補完ルール)
async function resolveOrigin() {
  const raw = process.env.SCRAPER_DOMAIN;
  if (!raw) {
    const configUrl = new URL("../scraper/config.example.json", import.meta.url);
    const config = JSON.parse(await readFile(configUrl, "utf8"));
    return new URL(config.targetUrl).origin;
  }
  const value = raw.trim();
  const withScheme = /^https?:\/\//.test(value) ? value : `https://${value}`;
  return new URL(withScheme).origin;
}

// 実行サマリに投稿結果を書き戻す。投稿内容・URL は含めない
async function mergePostSummary(summary) {
  const summaryPath = process.env.RUN_SUMMARY_JSON;
  if (!summaryPath) return;
  try {
    const current = JSON.parse(await readFile(summaryPath, "utf8"));
    current.post = summary;
    await writeFile(summaryPath, JSON.stringify(current, null, 2));
  } catch (err) {
    console.warn(`[post] 警告: 実行サマリの更新に失敗しました: ${err.message}`);
  }
}

// フォーム 1 フィールドへの値の投入。name 属性で要素を探し、
// select は値(失敗時は表示ラベル)で選択、checkbox は true でチェック、
// それ以外(text/textarea)は fill する
async function fillField(scope, name, value) {
  const el = scope.locator(`[name="${name}"]`).first();
  const kind = await el.evaluate((e) => e.tagName.toLowerCase() + (e.type ? `:${e.type}` : ""));
  const text = String(value ?? "");
  if (kind.startsWith("select")) {
    try {
      await el.selectOption(text);
    } catch {
      await el.selectOption({ label: text });
    }
    return;
  }
  if (kind.startsWith("input:checkbox")) {
    if (text === "1" || /^(true|on|yes)$/i.test(text)) await el.check();
    else await el.uncheck();
    return;
  }
  await el.fill(text);
}

// 画像認証(image_auth)の自動入力。フォーム内の認証画像のファイル名に
// 数字が埋め込まれている(src 例: /public/assets/img/image_auth/image_auth_5.png)
// ので、表示順に数字を抜いて連結した文字列を入力する。
// フォームに image_auth がなければ何もしない
async function fillImageAuth(form) {
  const authInput = form.locator('input[name="image_auth"]').first();
  if ((await authInput.count()) === 0) return;
  const srcs = await form.locator("img").evaluateAll((imgs) =>
    imgs.map((img) => img.getAttribute("src") ?? "").filter((src) => /image_auth/i.test(src)),
  );
  const code = srcs
    .map((src) => src.match(/image_auth[^0-9]*(\d+)/)?.[1] ?? "")
    .join("");
  if (code) await authInput.fill(code);
}

// 投稿系統 1 件の処理。間隔未経過なら何もせず戻る
async function processConfig(config, index, state, origin, context, summary) {
  const key = config.name ?? `#${index}`;
  const conf = state.configs[key] ?? { lastPostedAt: 0, rotateIndex: 0 };
  const threadIds = (config.threadIds ?? []).map(String).filter(Boolean);
  const patterns = Array.isArray(config.posts) ? config.posts : [];
  const intervalMinutes = Number(config.intervalMinutes ?? 0);
  if (threadIds.length === 0 || patterns.length === 0) {
    console.log(`[post] 系統 ${key}: 投稿先スレまたは投稿パターンが未指定のためスキップします`);
    return;
  }

  // 頻度制御: 前回の投稿試行から intervalMinutes 以上経過していなければ何もしない
  const intervalMs = intervalMinutes > 0 ? intervalMinutes * 60_000 : 0;
  const elapsedMs = Date.now() - (conf.lastPostedAt ?? 0);
  if (elapsedMs < intervalMs) {
    const remainingMin = Math.ceil((intervalMs - elapsedMs) / 60_000);
    console.log(
      `[post] 系統 ${key}: 次の投稿まで約 ${remainingMin} 分のためスキップします(間隔 ${intervalMinutes} 分)`,
    );
    summary.notDue++;
    return;
  }

  const formPathTemplate = config.formPath ?? DEFAULT_FORM_PATH;
  // 投稿パターンはローテーションで選択(毎回同じ文面にならないように)
  const rotateIndex = conf.rotateIndex % patterns.length;
  const pattern = patterns[rotateIndex];
  const fields = { ...(pattern.fields ?? {}) };
  console.log(
    `[post] 系統 ${key}: 投稿を実行します(投稿先 ${threadIds.length} スレ / パターン ` +
      `${patterns.length} 件中 ${rotateIndex + 1} 件目 / 間隔 ${intervalMinutes} 分)`,
  );

  let ok = 0;
  let fail = 0;
  for (const threadId of threadIds) {
    const formUrl = origin + formPathTemplate.replace("{id}", encodeURIComponent(threadId));
    try {
      const page = await context.newPage();
      // フォームページ(掲示板)を開いて hidden の csrf_token を含めて送信する
      await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const form = page.locator("form[name=form01]");
      if ((await form.count()) === 0) {
        throw new Error("投稿フォームが見つかりませんでした");
      }
      for (const [name, value] of Object.entries(fields)) {
        await fillField(form, name, value);
      }
      // 画像認証は設定に関係なく毎回自動入力する(ページごとに数字が変わるため)
      await fillImageAuth(form);
      if (pattern.sage) {
        await form.locator('[name="sage"]').first().check().catch(() => {});
      }
      await form.locator('input[type="submit"]').first().click();
      await page.waitForLoadState("load", { timeout: 60_000 });
      // 成否判定: 送信後も空の投稿フォームが見える場合はエラー扱い(戻された場合)
      await page.waitForTimeout(1_000);
      const stillForm = await page.locator("form[name=form01]").count();
      if (stillForm > 0) {
        throw new Error("投稿後にフォームが再表示されました(エラーの可能性)");
      }
      ok++;
      await page.close();
    } catch (err) {
      fail++;
      // URL・スレ ID・投稿内容はログに出さない
      console.warn(`[post] 警告: 系統 ${key} のスレへの投稿に失敗しました: ${maskUrl(err.message)}`);
      summary.errors = summary.errors ?? [];
      summary.errors.push(`系統 ${key}: ${maskUrl(err.message)}`);
    }
    // 掲示板への配慮: 投稿の合間に待つ
    if (ok + fail < threadIds.length) {
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  summary.posted += ok;
  summary.failed += fail;
  console.log(`[post] 系統 ${key}: 完了 ${ok} 件成功 / ${fail} 件失敗(投稿先 ${threadIds.length} スレ)`);

  // 成否問わず試行時刻を記録(間隔内の再試行で掲示板を連打しないため)
  conf.lastPostedAt = Date.now();
  conf.rotateIndex = (conf.rotateIndex + 1) % patterns.length;
  state.configs[key] = conf;
}

async function main() {
  const statePath = process.env.STATE_PATH || DEFAULT_STATE_PATH;
  const summary = {
    status: "skipped-unconfigured",
    posted: 0,
    failed: 0,
    notDue: 0,
    configs: 0,
    intervalMinutes: null,
  };

  // 設定 gist から post ブロックを読む(読めない場合は実行を中止)
  let settings = null;
  try {
    settings = await loadGistJson();
  } catch (err) {
    summary.status = "failed";
    console.warn(`[post] エラー: ${err.message}`);
    await mergePostSummary(summary);
    throw err;
  }
  const postBlock = settings?.post;
  if (!settings || postBlock == null) {
    console.log("[post] 投稿設定なし。スキップします");
    await mergePostSummary(summary);
    return;
  }
  // post ブロックは 1 系統(オブジェクト)でも複数系統(配列)でも受ける
  const configs = (Array.isArray(postBlock) ? postBlock : [postBlock]).filter(
    (c) => c && c.enabled !== false,
  );
  summary.configs = configs.length;
  if (configs.length === 0) {
    console.log("[post] 有効な投稿系統がないためスキップします");
    await mergePostSummary(summary);
    return;
  }

  // 系統ごとの投稿状態(旧形式のフラットな {lastPostedAt, rotateIndex} も許容しない)
  let state = { configs: {} };
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    state = { configs: parsed?.configs ?? {} };
  } catch {
    // 初回実行(ファイルなし)
  }

  const origin = await resolveOrigin();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    for (const [index, config] of configs.entries()) {
      await processConfig(config, index, state, origin, context, summary);
    }
  } finally {
    await browser.close();
  }

  summary.status =
    summary.failed > 0
      ? summary.posted > 0
        ? "partial"
        : "failed"
      : summary.posted > 0
        ? "posted"
        : summary.notDue > 0
          ? "not-due"
          : "skipped-unconfigured";
  console.log(
    `[post] 完了: ${summary.posted} 件成功 / ${summary.failed} 件失敗(系統 ${summary.configs} 件)` +
      (summary.notDue > 0 ? ` / 間隔未経過 ${summary.notDue} 系統` : ""),
  );

  await writeFile(statePath, JSON.stringify(state, null, 2));
  console.log(`[post] 状態を保存しました (${statePath})`);
  await mergePostSummary(summary);
}

// エラーメッセージから実サイトのドメインを *** にマスクする(scraper と同じ規約)
function maskUrl(msg) {
  let out = msg;
  const domain = process.env.SCRAPER_DOMAIN;
  if (domain) {
    const origin = (() => {
      try {
        const withScheme = /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
        return new URL(withScheme).origin;
      } catch {
        return "";
      }
    })();
    if (origin) {
      out = out.split(origin).join("***");
    }
    out = out.split(domain).join("***");
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(async (err) => {
    console.error(`[post] 失敗: ${maskUrl(err.message)}`);
    await mergePostSummary({ status: "failed", posted: 0, failed: 0 }).catch(() => {});
    process.exit(1);
  });
}
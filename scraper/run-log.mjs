// 実行サマリ(RUN_SUMMARY_JSON)を Markdown の「最新実行ログ」に整形して出力する。
//
// GitHub Actions の scrape.yml が各実行の最後にこのスクリプトを呼び、
// log/latest-run.md を上書き・コミットすることで、public リポジトリに
// 「最終実行ログ 1 ファイルだけが常に更新され続ける」状態を作る。
//
// 使い方: node scraper/run-log.mjs [サマリJSONのパス] [出力先Markdownのパス]
//   省略時は 環境変数 RUN_SUMMARY_JSON → log/latest-run.md
//
// リポジトリは public のため、サマリ側でドメイン・URL・スレタイ・投稿内容は
// 除外済み(書くのは件数など統計のみ。スレタイも載せない)。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRAPER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.resolve(SCRAPER_DIR, "../log/latest-run.md");

const NOTIFY_LABELS = {
  posted: "投稿あり",
  "no-new": "新着なし",
  "skipped-unconfigured": "スキップ(トークン未設定)",
  failed: "失敗",
};

// サマリ 1 件から Markdown を組み立てる
export function buildRunLog(s) {
  const lines = [];
  lines.push("# 最新実行ログ(自動更新)");
  lines.push("");
  lines.push(
    "このファイルは定期バッチ([scrape.yml](../.github/workflows/scrape.yml))の実行のたびに",
    "上書きされます。ドメイン・URL・スレタイ・投稿内容は掲載しない設計です。",
  );
  lines.push("");
  lines.push(`- 実行完了: ${s.finishedAt ?? s.startedAt ?? "—"}`);
  lines.push(
    `- モード: ${s.mode === "mock" ? "モック(サンプル HTML)" : "実サイト"}`,
  );
  if (s.settingsGist) {
    lines.push("- 巡回設定: 設定 gist から読み込み");
  }
  if (Array.isArray(s.keywords) && s.keywords.length > 0) {
    lines.push(`- キーワード: ${s.keywords.join(" / ")}`);
  }
  lines.push(
    `- スレ一覧: ${s.listedThreads ?? 0} 件 → フィルタ後 ${s.filteredThreads ?? 0} 件` +
      (s.detailLimit ? `(詳細取得は先頭 ${s.detailLimit} 件に制限)` : ""),
  );
  lines.push(
    `- 詳細取得: ${s.detailOk ?? 0} 件成功 / ${s.detailFailed ?? 0} 件失敗` +
      (s.detailThreads ? `(対象 ${s.detailThreads} 件)` : ""),
  );
  if (s.sexExcluded > 0) {
    lines.push(`- 性別排除: ${s.sexExcluded} 件を除外`);
  }
  const notify = s.notify;
  if (notify) {
    const newThreads =
      notify.newThreads != null ? `(新着 ${notify.newThreads} スレ)` : "";
    lines.push(`- 通知: ${NOTIFY_LABELS[notify.status] ?? notify.status}${newThreads}`);
  } else {
    lines.push("- 通知: 情報なし");
  }
  lines.push(`- 出力: ${s.outputWritten ? "site/data/ への書き出し完了" : "書き出し未完了"}`);
  lines.push("");
  const errors = Array.isArray(s.errors) ? s.errors : [];
  if (errors.length > 0) {
    lines.push("## 警告・エラー");
    lines.push("");
    for (const err of errors) {
      lines.push(`- ${err}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const summaryPath = process.argv[2] || process.env.RUN_SUMMARY_JSON;
  const outputPath = process.argv[3] || DEFAULT_OUTPUT;
  if (!summaryPath) {
    throw new Error("実行サマリのパスが指定されていません(RUN_SUMMARY_JSON)");
  }
  let summary;
  try {
    summary = JSON.parse(await readFile(summaryPath, "utf8"));
  } catch (err) {
    throw new Error(`実行サマリ ${summaryPath} を読めませんでした: ${err.message}`);
  }
  await writeFile(outputPath, buildRunLog(summary));
  console.log(`[run-log] ${outputPath} を更新しました`);
}

// CLI 実行時のみ main を走らせる(import されても何もしない)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[run-log] 失敗: ${err.message}`);
    process.exit(1);
  });
}
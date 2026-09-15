// 設定 gist(シークレット SCRAPER_SETTINGS_GIST_URL)の読み込み。
// バッチ(index.mjs)と通知(notify.mjs)の両方から使う。
// gist URL・ID・内容はログに出さない(URL を知れば閲覧可のため)

// 設定 gist の URL(gist.github.com/<user>/<id> など)または gist ID から ID を取り出す。
// ID 自体も公開ログには出さないため、失敗時のメッセージに含めない
export function gistIdFromUrl(raw) {
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

// gist 内の最初の .json ファイルを取得・パースして返す。
// SCRAPER_SETTINGS_GIST_URL 未設定なら null。読み込み・解析に失敗した場合は
// throw する(呼び出し側が続行可否を決める。index.mjs は中止、notify.mjs は
// ミラーリンクなしで続行)。エラーメッセージに gist ID・URL は含めない
export async function fetchGistSettingsJson() {
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
  try {
    return JSON.parse(jsonFile.content);
  } catch (err) {
    throw new Error(`設定 gist の JSON を解釈できませんでした: ${err.message}`);
  }
}
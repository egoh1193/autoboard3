// /map 機能用の共有ヘルパー(系統① Worker と系統② バッチの両方から使う)。
// parse.mjs と同じ規約:Node 専用 API(fs 等)は使わない(Worker でバンドルされるため)。
//
// 投稿の位置情報は「地名 → 緯度経度」の対応表(config.map.places)で決める。
// 外部ジオコーディング API は使わない(地名の揺れ・レート制限を避けるため)。
//
// config 例(config.example.json 参照):
//   "map": {
//     "places": [
//       { "match": "梅田", "lat": 34.7024, "lng": 135.4959, "label": "梅田" }
//     ]
//   }

// place の照合対象テキストを優先度順に集める(地域メタ → 本文 → スレタイ)
function candidateTexts(post, threadTitle) {
  return [
    post?.area || "",
    post?.body || "",
    threadTitle || "",
  ];
}

// 投稿(とその元スレタイ)が対応表のどの地名に該当するかを返す。
// 照合は大小文字を無視した部分一致。優先度: area → body → threadTitle。
// 該当なしは null。
export function matchPlace(post, threadTitle, config) {
  const places = config?.map?.places ?? [];
  if (places.length === 0) return null;
  for (const text of candidateTexts(post, threadTitle)) {
    if (!text) continue;
    const lower = text.toLowerCase();
    for (const place of places) {
      if (place?.match && lower.includes(String(place.match).toLowerCase())) {
        return { place, source: text };
      }
    }
  }
  return null;
}

// 文字列から決定的な 32bit ハッシュ(FNV-1a)。ジッタの種に使う
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 同一地点のピンが完全に重なるのを避けるため、threadId+レス番号から
// 決定的な微小ジッタ(±約50m)を加える。実行ごとに同じ位置になる
function jittered(pinKey, key, value, amplitudeDeg) {
  const h = hashString(`${pinKey}:${key}`);
  // [0, 1) に正規化 → [-1, 1)
  const unit = (h / 0xffffffff) * 2 - 1;
  return value + unit * amplitudeDeg;
}

// 緯度1度あたり約111km。±50m なら ±0.00045 度程度
const JITTER_DEG = 0.00045;

// 投稿1件のピン情報 { lat, lng, place } を返す(該当地名がなければ null)。
// thread は { id, title } 形式(title はスレタイ照合に使う)
export function pinForPost(post, thread, config) {
  const matched = matchPlace(post, thread?.title, config);
  if (!matched) return null;
  const pinKey = `${thread?.id ?? ""}:${post?.num ?? ""}`;
  return {
    lat: jittered(pinKey, "lat", matched.place.lat, JITTER_DEG),
    lng: jittered(pinKey, "lng", matched.place.lng, JITTER_DEG),
    place: matched.place.label || matched.place.match,
  };
}

// 吹き出し用の本文抜粋。改行は空白化し、max 文字を超える場合は末尾を省略
export function excerptFromBody(body, max = 100) {
  if (!body) return "";
  const flat = String(body).replace(/\s*\n\s*/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}
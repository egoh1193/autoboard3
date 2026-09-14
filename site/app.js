// フロントエンド本体。data 属性でページ種別を判別し、
// スクレイパーが生成した /data/ 以下の JSON を取得して描画する。
// 取得した本文は textContent で描画するため、スクレイピング元の
// HTML が含まれていてもこのページ内では実行されない。

const $ = (sel) => document.querySelector(sel);

function showError(message) {
  const el = $("#error");
  el.textContent = message;
  el.hidden = false;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`データを取得できませんでした (${res.status})`);
  }
  return res.json();
}

function formatGeneratedAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `最終更新: ${d.toLocaleString("ja-JP")}`;
}

// URL の ?area=神田,上野,浅草 をタイトル絞り込みキーワードとして読む。
// カンマ(半角/全角)区切りで、いずれか 1 つでもタイトルに含まれていれば表示(OR)
function readAreaFilter() {
  const raw = new URLSearchParams(location.search).get("area");
  if (!raw) return [];
  return raw
    .split(/[,,]/)
    .map((kw) => kw.trim())
    .filter(Boolean);
}

function showAreaFilter(keywords, shown, total) {
  const info = $("#filter-info");
  if (!info) return;
  if (keywords.length === 0) {
    info.hidden = true;
    info.textContent = "";
    return;
  }
  const clear = document.createElement("a");
  clear.href = "/";
  clear.textContent = "絞り込み解除";
  info.textContent = `絞り込み中: ${keywords.join("・")}(該当 ${shown}/${total} 件) — `;
  info.append(clear);
  info.hidden = false;
}

function buildThreadRow(t) {
  const tr = document.createElement("tr");

  const tdTitle = document.createElement("td");
  tdTitle.className = "col-title";
  const a = document.createElement("a");
  a.href = `/thread?id=${encodeURIComponent(t.id)}`;
  a.textContent = t.title || "(タイトルなし)";
  tdTitle.append(a);
  if (t.category) {
    const cat = document.createElement("span");
    cat.className = "category-tag";
    cat.textContent = t.category;
    tdTitle.append(cat);
  }

  const tdCount = document.createElement("td");
  tdCount.className = "col-count";
  tdCount.textContent = String(t.resCount);

  const tdUpdated = document.createElement("td");
  tdUpdated.className = "col-updated";
  tdUpdated.textContent = t.updatedAt || t.createdAt || "";

  tr.append(tdTitle, tdCount, tdUpdated);
  return tr;
}

// 一覧(キーワード絞り込み適用)を描画する
function renderThreadRows(threads, keywords) {
  const tbody = $("#thread-rows");
  tbody.textContent = "";

  const filtered = keywords.length
    ? threads.filter((t) => keywords.some((kw) => t.title.includes(kw)))
    : threads;

  if (filtered.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "loading";
    td.textContent = keywords.length
      ? "絞り込み条件に一致するスレッドがありません。"
      : "スレッドがありません。";
    tr.append(td);
    tbody.append(tr);
  } else {
    for (const t of filtered) {
      tbody.append(buildThreadRow(t));
    }
  }
  return filtered.length;
}

// メインスレ(directThreads)。一覧の下に固定リンクとして表示する
// (絞り込み中でも常に表示する)
function renderMainThreads(mainThreads) {
  const section = $("#main-threads");
  if (!section) return;
  const tbody = $("#main-thread-rows");
  tbody.textContent = "";
  if (!mainThreads || mainThreads.length === 0) {
    section.hidden = true;
    return;
  }
  for (const t of mainThreads) {
    tbody.append(buildThreadRow(t));
  }
  section.hidden = false;
}

function renderList() {
  const keywords = readAreaFilter();
  fetchJson("/data/threads.json")
    .then((data) => {
      $("#generated-at").textContent = formatGeneratedAt(data.generatedAt);

      const shown = renderThreadRows(data.threads || [], keywords);
      showAreaFilter(keywords, shown, (data.threads || []).length);
      renderMainThreads(data.mainThreads);
    })
    .catch((err) => {
      showError(`スレッド一覧の読み込みに失敗しました: ${err.message}`);
    });
}

function renderThread() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) {
    showError("スレッド ID が指定されていません。");
    return;
  }

  fetchJson(`/data/threads/${encodeURIComponent(id)}.json`)
    .then((thread) => {
      document.title = `${thread.title} - 掲示板ミラー`;
      $("#thread-title").textContent = thread.title || "(タイトルなし)";
      $("#thread-meta").textContent = [
        thread.category ? `カテゴリ: ${thread.category}` : "",
        thread.resCount != null ? `レス数: ${thread.resCount}` : "",
        thread.updatedAt ? `最終更新: ${thread.updatedAt}` : "",
      ]
        .filter(Boolean)
        .join(" ・ ");

      const link = $("#original-link");
      if (thread.url) {
        link.href = thread.url;
      } else {
        link.hidden = true;
      }

      const container = $("#posts");
      container.textContent = "";

      for (const post of thread.posts) {
        const article = document.createElement("article");
        article.className = "post";
        // /map の吹き出しからのリンク(/thread?id=…#post-…)用のアンカー。
        // 投稿 ID(post.key)を持つ板(レス番号のない板)は投稿 ID をアンカーに使う
        // (num は実行ごとに振り直されるため URL が安定しない)
        article.id = `post-${post.key || post.num}`;

        const header = document.createElement("div");
        header.className = "post-header";

        const num = document.createElement("span");
        num.className = "post-num";
        num.textContent = String(post.num ?? "");

        const name = document.createElement("span");
        name.className = "post-name";
        name.textContent = post.name || "名無しさん";

        const meta = document.createElement("span");
        meta.className = "post-meta";
        meta.textContent = [post.date, post.posterId].filter(Boolean).join(" ");

        header.append(num, name, meta);

        // 年齢・性別など、パーサーが追加で抽出した付帯情報
        // mailUrl は内部用(バッチがメールアドレス抽出に使うリンク)、
        // key はアンカー用の投稿 ID(生の ID を付帯情報として出さない)、
        // images は本文の下にリンクとして個別描画するため、ここでは対象外
        const KNOWN_FIELDS = ["num", "key", "name", "date", "posterId", "body", "mailUrl", "email", "images"];
        const LABELS = {
          age: "年齢",
          sex: "性別",
          area: "住所",
          looks: "ﾙｯｸｽ",
          style: "ｽﾀｲﾙ",
          figure: "体型",
          wish: "区分",
          email: "メール",
          ip: "IP",
          device: "機種情報",
        };
        for (const [key, value] of Object.entries(post)) {
          if (KNOWN_FIELDS.includes(key) || !value) continue;
          const extra = document.createElement("span");
          extra.className = "post-meta post-extra";
          extra.textContent = `${LABELS[key] || key}: ${value}`;
          header.append(extra);
        }

        const body = document.createElement("div");
        body.className = "post-body";
        // textContent で描画するため、本文に含まれる HTML は無害化される
        body.textContent = post.body || "";

        article.append(header, body);

        // レス添付画像(サムネイル URL)。対象掲示板への直リンク負荷を避けるため
        // <img> での埋め込みはせず、URL をリンクとして表示する
        if (Array.isArray(post.images) && post.images.length > 0) {
          const imgs = document.createElement("div");
          imgs.className = "post-images";
          const label = document.createElement("span");
          label.className = "post-images-label";
          label.textContent = `添付画像(${post.images.length}件)`;
          imgs.append(label);
          for (const src of post.images) {
            const a = document.createElement("a");
            a.className = "post-image-link";
            a.href = src;
            a.textContent = src;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            imgs.append(a);
          }
          article.append(imgs);
        }
        container.append(article);
      }
    })
    .catch((err) => {
      showError(`スレッドの読み込みに失敗しました: ${err.message}`);
    });
}

// /map: 投稿を地図ピン + 吹き出しで表示する。
// ピン座標は Worker 側(scraper/map.mjs の地名対応表)が計算済み。
// 吹き出しも本文と同じく textContent で描画する(innerHTML 禁止)
function sexClass(sex) {
  const s = String(sex || "");
  if (s.includes("女")) return "pin-female";
  if (s.includes("男")) return "pin-male";
  return "pin-unknown";
}

function buildPopup(pin) {
  const box = document.createElement("div");
  box.className = "map-popup";

  const title = document.createElement("p");
  title.className = "map-popup-name";
  title.textContent = pin.name;
  box.append(title);

  const meta = [pin.age, pin.sex, pin.place].filter(Boolean).join(" ・ ");
  if (meta) {
    const metaEl = document.createElement("p");
    metaEl.className = "map-popup-meta";
    metaEl.textContent = meta;
    box.append(metaEl);
  }

  if (pin.body) {
    const body = document.createElement("p");
    body.className = "map-popup-body";
    body.textContent = pin.body;
    box.append(body);
  }

  const link = document.createElement("a");
  link.className = "map-popup-link";
  // 投稿 ID(post.key)を持つ板(レス番号のない板)は投稿 ID をアンカーに使う
  link.href = `/thread?id=${encodeURIComponent(pin.threadId)}#post-${pin.key || pin.num}`;
  link.textContent = "このスレを開く";
  box.append(link);
  return box;
}

function renderMap() {
  const map = L.map("map");
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  fetchJson("/data/map.json")
    .then((data) => {
      $("#generated-at").textContent = formatGeneratedAt(data.generatedAt);

      if (!data.pins || data.pins.length === 0) {
        showError("地図に表示できる投稿がありません。config.map の地名対応表を確認してください。");
        return;
      }

      const bounds = L.latLngBounds([]);
      for (const pin of data.pins) {
        const marker = L.marker([pin.lat, pin.lng], {
          icon: L.divIcon({
            className: `map-pin ${sexClass(pin.sex)}`,
            iconSize: [22, 30],
            iconAnchor: [11, 30],
            popupAnchor: [0, -26],
            html: "",
          }),
        }).addTo(map);
        marker.bindPopup(buildPopup(pin));
        bounds.extend([pin.lat, pin.lng]);
      }
      map.fitBounds(bounds.pad(0.15));
    })
    .catch((err) => {
      showError(`地図データの読み込みに失敗しました: ${err.message}`);
    });
}

const page = document.body.dataset.page;
if (page === "list") {
  renderList();
} else if (page === "thread") {
  renderThread();
} else if (page === "map") {
  renderMap();
}
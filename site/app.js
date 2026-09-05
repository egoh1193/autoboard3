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

function renderList() {
  fetchJson("/data/threads.json")
    .then((data) => {
      $("#generated-at").textContent = formatGeneratedAt(data.generatedAt);

      const tbody = $("#thread-rows");
      tbody.textContent = "";

      if (data.threads.length === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 3;
        td.className = "loading";
        td.textContent = "スレッドがありません。";
        tr.append(td);
        tbody.append(tr);
        return;
      }

      for (const t of data.threads) {
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

        const tdCreated = document.createElement("td");
        tdCreated.className = "col-created";
        tdCreated.textContent = t.createdAt;

        tr.append(tdTitle, tdCount, tdCreated);
        tbody.append(tr);
      }
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
        thread.createdAt ? `作成: ${thread.createdAt}` : "",
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

        const header = document.createElement("div");
        header.className = "post-header";

        const num = document.createElement("span");
        num.className = "post-num";
        num.textContent = String(post.num);

        const name = document.createElement("span");
        name.className = "post-name";
        name.textContent = post.name || "名無しさん";

        const meta = document.createElement("span");
        meta.className = "post-meta";
        meta.textContent = [post.date, post.posterId].filter(Boolean).join(" ");

        header.append(num, name, meta);

        // 年齢・性別など、パーサーが追加で抽出した付帯情報
        // mailUrl は内部用(バッチがメールアドレス抽出に使うリンク)、
        // images は本文の下にリンクとして個別描画するため、ここでは対象外
        const KNOWN_FIELDS = ["num", "name", "date", "posterId", "body", "mailUrl", "images"];
        const LABELS = {
          age: "年齢",
          sex: "性別",
          looks: "ﾙｯｸｽ",
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

const page = document.body.dataset.page;
if (page === "list") {
  renderList();
} else if (page === "thread") {
  renderThread();
}
// スクレイピング共有ライブラリ。
// Node バッチ(scraper/index.mjs)と Cloudflare Worker(worker/src/scrape.ts)
// の両方から import するため、このファイルは Node 専用機能を使わないこと。

import * as cheerio from "cheerio";

const MOCK_BASE = "https://mock.invalid/"; // 相対 URL 解決用のダミー基地URL

// フィールド指定文字列 "selector@attr" を分解する。
// attr は "text"(既定) / "html" / 任意の属性名 (href, src など)。
export function splitFieldSpec(spec) {
  const at = spec.lastIndexOf("@");
  if (at === -1) {
    return { selector: spec, attr: "text" };
  }
  return { selector: spec.slice(0, at), attr: spec.slice(at + 1) };
}

function extractFieldValue($, el, spec) {
  const { selector, attr } = splitFieldSpec(spec);
  // .first() を忘れると、旧式HTMLの未閉鎖タグによる入れ子構造で
  // マッチ全要素のテキストが連結されてしまうため最初の1つだけを扱う
  const target = (selector ? $(el).find(selector) : $(el)).first();
  if (target.length === 0) {
    return "";
  }
  if (attr === "text") {
    return target.text().trim();
  }
  if (attr === "html") {
    return target.html()?.trim() ?? "";
  }
  return (target.attr(attr) ?? "").trim();
}

// 一覧ページ(カテゴリ一覧・スレッド一覧のどちらでも)をパースし、
// 各行の生データを返す。url フィールドが空の行(見出し行・広告行など)は除外される。
// fields は "セレクタ@属性" で行内の要素から抽出し、fieldPatterns は行全体の
// テキストから正規表現で抽出する(「#123」のようにテキストノードに直接書かれ
// CSS セレクタでは取れない値向け。キャプチャグループ (1) が使われる)。
// 戻り値: [{ <fields / fieldPatterns に指定したキー>: 値, ... }]
export function parseList(html, listConfig) {
  const $ = cheerio.load(html);
  const rows = [];
  $(listConfig.selector).each((_, el) => {
    const row = {};
    for (const [field, spec] of Object.entries(listConfig.fields)) {
      row[field] = extractFieldValue($, el, spec);
    }
    let text = null;
    for (const [field, pattern] of Object.entries(listConfig.fieldPatterns ?? {})) {
      text ??= $(el).text();
      const m = text.match(new RegExp(pattern));
      row[field] = m ? m[1] ?? "" : "";
    }
    if (row.url) {
      rows.push(row);
    }
  });
  return rows;
}

// ページネーションの「次へ」リンクを取得する。
// listConfig.nextPage が空文字/未指定なら常に "" を返す。
export function parseNextPageUrl(html, listConfig) {
  const spec = listConfig.nextPage;
  if (!spec) {
    return "";
  }
  const $ = cheerio.load(html);
  return extractFieldValue($, $.root(), spec);
}

// スレッド個別ページをパースし、タイトルとレス配列を返す。
// threadConfig.parser === "hr-split" のときは旧式掲示板向けの
// <hr> 分割パーサーを使い、それ以外はセレクタベース(postsSelector)で処理する。
export function parseThread(html, threadConfig) {
  if (threadConfig.parser === "hr-split") {
    return parseThreadHrSplit(html, threadConfig);
  }
  return parseThreadBySelector(html, threadConfig);
}

// セレクタベースのパーサー: 各レスが postsSelector で囲まれた要素になっている HTML 向け
function parseThreadBySelector(html, threadConfig) {
  const $ = cheerio.load(html);
  const title = threadConfig.titleSelector
    ? extractFieldValue($, $.root(), threadConfig.titleSelector)
    : "";

  const posts = [];
  $(threadConfig.postsSelector).each((i, el) => {
    const post = { num: i + 1 };
    for (const [field, spec] of Object.entries(threadConfig.fields)) {
      post[field] = extractFieldValue($, el, spec);
    }
    posts.push(post);
  });

  return { title, posts };
}

// hr-split パーサー: <hr> で区切られた旧式モバイル掲示板向け。
// class 構造がないため、チャンクごとに正規表現でレス番号・名前・日時・本文を抽出する。
// 設定例:
//   "parser": "hr-split",
//   "titleSelector": "font[size='+2']@text",
//   "titleStrip": "^[□■]\\s*",
//   "post": {
//     "requireNumberSpan": "span[id^='b']",  // 本物のレスの目印(これが無いチャンクは無視)
//     "numberPattern": "^\\s*(\\d+)",
//     "namePattern": "^\\d+\\s*\\[([^\\]]*)\\]",
//     "opPattern": "\\d+\\s*\\[☆\\]",         // スレ主(>>1)本文の目印
//     "datePattern": "\\d{4}-\\d{2}-\\d{2}[ \\t]+\\d{1,2}:\\d{2}(?::\\d{2})?",
//     "metaPatterns": { "age": "年齢\\s*[：:]\\s*([^\\n]*)", ... }
//   }
function parseThreadHrSplit(html, threadConfig) {
  const c = threadConfig.post || {};
  const $full = cheerio.load(html);
  let title = threadConfig.titleSelector
    ? extractFieldValue($full, $full.root(), threadConfig.titleSelector)
    : "";
  if (title && threadConfig.titleStrip) {
    title = title.replace(new RegExp(threadConfig.titleStrip), "").trim();
  }

  const numberRe = new RegExp(c.numberPattern ?? "^\\s*(\\d+)");
  const nameRe = new RegExp(c.namePattern ?? "^\\d+\\s*\\[([^\\]]*)\\]");
  const dateRe = new RegExp(c.datePattern ?? "\\d{4}-\\d{2}-\\d{2}[ \\t]+\\d{1,2}:\\d{2}(?::\\d{2})?");
  const opRe = new RegExp(c.opPattern ?? "\\d+\\s*\\[☆\\]");
  // 個別ページ(メール送信ページ)へのリンク。href 属性から取るため
  // <br> 置換前の生 HTML に対してマッチさせる。ページ自体の取得はバッチ側が行う
  const mailLinkRe = threadConfig.mailPage?.linkPattern
    ? new RegExp(threadConfig.mailPage.linkPattern)
    : null;
  // レス添付画像の URL(サムネイル)。1 レスに複数あるため全件マッチで配列にする
  const imageRe = c.imagePattern ? new RegExp(c.imagePattern, "g") : null;

  const posts = [];
  for (const rawChunk of html.split(/<hr[^>]*>/i)) {
    // <br> を改行に変換してからテキスト化する(本文の行構造を保つため)
    const $ = cheerio.load(rawChunk.replace(/<br\s*\/?>/gi, "\n"));
    const hasPostMark = !c.requireNumberSpan || $(c.requireNumberSpan).length > 0;
    const lines = $.text()
      .split("\n")
      .map((l) => l.trim());
    const text = lines.join("\n");

    let num = 0;
    let name = "";
    let bodyLines = [];
    let date = "";

    if (!hasPostMark) {
      // 通常レスの目印が無いチャンクはスレ主(>>1)本文のみ対象とする
      const opIdx = lines.findIndex((l) => opRe.test(l));
      if (opIdx === -1) {
        continue; // ナビ・広告などのチャンク
      }
      const m = lines[opIdx].match(/(\d+)\s*\[([^\]]*)\]/);
      if (!m) continue;
      num = Number(m[1]);
      name = m[2];
      const dateIdx = lines.findIndex((l, i) => i > opIdx && dateRe.test(l));
      date = dateIdx === -1 ? "" : lines[dateIdx].match(dateRe)[0];
      bodyLines = lines.slice(opIdx + 1, dateIdx === -1 ? lines.length : dateIdx);
    } else {
      // 通常レス: 先頭行は "NN[名前][編集][通報]..." 形式
      const numIdx = lines.findIndex((l) => numberRe.test(l));
      if (numIdx === -1) continue;
      num = Number(lines[numIdx].match(numberRe)[1]);
      const nm = lines[numIdx].match(nameRe);
      name = nm ? nm[1] : "";
      const dateIdx = lines.findIndex((l, i) => i > numIdx && dateRe.test(l));
      date = dateIdx === -1 ? "" : lines[dateIdx].match(dateRe)[0];
      bodyLines = lines.slice(numIdx + 1, dateIdx === -1 ? lines.length : dateIdx);
    }

    if (!num) continue;

    // 年齢・性別などの付帯情報
    const post = { num, name, date };
    for (const [key, pattern] of Object.entries(c.metaPatterns ?? {})) {
      const m = text.match(new RegExp(pattern));
      post[key] = m ? m[1].trim() : "";
    }
    if (mailLinkRe) {
      const m = rawChunk.match(mailLinkRe);
      post.mailUrl = m ? m[1] ?? m[0] : "";
    }
    if (imageRe) {
      const urls = [];
      imageRe.lastIndex = 0;
      let m;
      while ((m = imageRe.exec(rawChunk))) {
        urls.push(m[1] ?? m[0]);
      }
      post.images = urls;
    }
    post.body = bodyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    posts.push(post);
  }

  // ページ送りで取得した場合に備え、レス番号昇順に並べる
  posts.sort((a, b) => a.num - b.num);
  return { title, posts };
}

// filters 設定に基づき、スレッドタイトルが抽出対象かどうかを判定する。
// titleIncludes: いずれかを含むなら対象(空ならすべて対象)
// titleExcludes: いずれかを含むなら除外
export function matchesFilters(title, filters) {
  const includes = filters?.titleIncludes ?? [];
  const excludes = filters?.titleExcludes ?? [];
  if (excludes.some((s) => title.includes(s))) {
    return false;
  }
  return includes.length === 0 || includes.some((s) => title.includes(s));
}

// URL からスレッドのファイル名に使う ID を作る。
// クエリに id 系パラメータがあればそれを利用し、なければ末尾パスセグメント
// (拡張子除去)を使う。どちらも取れない場合は URL 全体の短いハッシュを用いる。
export function threadIdFromUrl(urlString) {
  const u = new URL(urlString, MOCK_BASE);
  const last = u.pathname.split("/").filter(Boolean).pop() ?? "";

  const idParam = ["id", "tid", "thread_id", "no"].find((k) => u.searchParams.has(k));
  if (idParam) {
    return `id-${u.searchParams.get(idParam)}`;
  }

  let base = last
    .replace(/\.(html?|cgi|php|aspx?)$/i, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base || u.search) {
    let h = 5381;
    for (const ch of urlString) {
      h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
    }
    base = `${base || "t"}-${h.toString(36)}`;
  }
  return base;
}

export function resolveUrl(href, baseUrl) {
  return new URL(href, baseUrl ?? MOCK_BASE).href;
}

// 日時文字列("2026-09-04 22:53" など)を epoch ms に変換する。
// 掲示板の日時は日本時間で書かれているため、実行環境のタイムゾーンに
// 依存しないよう UTC+9 固定で解釈する。解釈できない場合は null
export function parsePostDateMs(dateStr) {
  const m = /(\d{4})-(\d{2})-(\d{2})[ \t]+(\d{1,2}):(\d{2})/.exec(dateStr ?? "");
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 9 * 60 * 60 * 1000;
}

// targetUrl が設定用プレースホルダのままならモックモードとみなす
export function isMockConfig(config) {
  return (
    config.targetUrl.startsWith("https://hoge.com") ||
    config.targetUrl.startsWith("https://board.example.net")
  );
}
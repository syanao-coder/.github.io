console.log("【アドオン】content_youtube_scrape.js ボタン監視スキャンを開始します。");

/* ------------------------------------------------------------
   拡張機能APIの名前空間シム（Firefoxフォーク互換対策）

   ・Firefox系の正式な作法は browser.*（Promiseを返す）
   ・Chrome系は chrome.*（コールバック方式、戻り値なし）
   ・Firefoxは互換のため chrome.* も提供しているが、
     Floorp等のフォークは独自のChrome拡張互換レイヤーを持つため、
     chrome.* の戻り値がPromiseでない場合がある。
     その環境で .catch() を呼ぶと TypeError でスクリプトが即死する。

   browser.* を優先し、送信は戻り値の型を見てから .catch() する。
   ------------------------------------------------------------ */
const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

function sendRuntimeMessage(message) {
  try {
    const result = ext.runtime.sendMessage(message);
    if (result && typeof result.then === 'function') result.catch(() => {});
  } catch (e) { /* 受信側が居ない等。無視してよい */ }
}

/* ============================================================
   対象カードのセレクタ

   ・yt-lockup-view-model は 2025年以降の新レイアウト。
     ホーム画面では ytd-rich-item-renderer の「内側」に入るため入れ子になる。
     → 後述の「内側優先」ロジックで外側をスキップする。
   ・Shorts専用の ytm-shorts-lockup-view-model はここに含めない（＝そもそも対象外）
   ============================================================ */
const cardSelectors = [
  'ytd-rich-item-renderer',    // トップ・ホーム画面（旧）
  'ytd-video-renderer',        // 検索結果・履歴
  'ytd-grid-video-renderer',   // チャンネル等
  'ytd-compact-video-renderer',// 関連動画欄（旧）
  'yt-lockup-view-model'       // 新レイアウト（ホーム・検索結果・関連動画）
].join(',');

/* Shorts判定に使う祖先要素。
   ※旧実装は ytd-rich-shelf-renderer を無条件で除外していたが、
     この要素はShorts以外の各種シェルフでも使われるため通常動画まで巻き添えで
     除外していた。[is-shorts] 属性付きに限定する。 */
const shortsAncestorSelectors = [
  'ytd-reel-item-renderer',
  'ytd-reel-shelf-renderer',
  'ytd-rich-shelf-renderer[is-shorts]',
  'ytm-shorts-lockup-view-model',
  'ytd-rich-grid-slim-media',
  '[is-short]'
].join(',');

const BUTTON_CLASS        = 'sync-send-to-controller-btn';
const COPY_CLASS          = 'sync-copy-url-btn';
const GROUP_CLASS         = 'sync-btn-group';
const LABEL_IDLE          = '➕ 送信';
const LABEL_SENDING       = '… 送信中';
const LABEL_COPY          = '⧉';        // コピー記号（モノクロで環境差が小さい字形）
const COLOR_IDLE          = '#ff4757';
const COLOR_SENDING       = '#747d8c';
const COLOR_OK            = '#2ed573';
const COLOR_NG            = '#c0392b';
const RESULT_RESET_MS     = 2500;   // 結果表示を保持する時間
const COPY_RESET_MS       = 1500;   // コピー結果の表示時間
const RESPONSE_TIMEOUT_MS = 6000;   // A側から応答が無い場合のタイムアウト
const SCAN_INTERVAL_MS    = 2000;   // 自己修復ポーリング間隔

// 診断ログ。挿入が0件のときに原因の内訳をコンソールへ出す。
const DEBUG = true;
const DEBUG_MAX_REPORTS = 5;   // これ以上は静かにする（コンソールを埋めないため）
let debugReportCount = 0;
let structureDumped = false;

// requestId → { button, timeoutId } の対応表。
// A側からの結果通知を「押されたボタンだけ」に反映するために使用する。
const pendingRequests = new Map();
let requestCounter = 0;

function generateRequestId() {
  requestCounter++;
  return 'req_' + Date.now() + '_' + requestCounter;
}

/* ------------------------------------------------------------
   Shorts判定
   ------------------------------------------------------------ */
function isShortsCard(card, href) {
  if (href && href.includes('/shorts/')) return true;
  if (card.closest(shortsAncestorSelectors)) return true;
  if (card.querySelector('ytm-shorts-lockup-view-model')) return true;
  if (card.querySelector('[overlay-style="SHORTS"]')) return true;
  return false;
}

/* ------------------------------------------------------------
   動画リンクの取得
   サムネイルのリンクとタイトルのリンクの両方が /watch?v= を持つ。
   カードが使い回された際に古いURLを送らないよう、クリック時にも再取得する。
   ------------------------------------------------------------ */
function findVideoLink(card) {
  return card.querySelector('a[href*="/watch?v="], a[href*="watch?v="]');
}

/* ------------------------------------------------------------
   URLの整形
   YouTubeのhrefには pp= (トラッキング)、si= 等の余計なパラメータが付く。
   同時視聴で意味を持つ v / list / t / index だけを残して整形する。
   ・コピー時: 手で貼り付けるので短いほうが扱いやすい
   ・送信時 : A側はvideoIdへ正規化するため結果は変わらないが、
             ログや履歴に残るURLがきれいになる
   ------------------------------------------------------------ */
function buildCleanUrl(href) {
  const full = href.startsWith('http') ? href : 'https://www.youtube.com' + href;
  try {
    const u = new URL(full);
    const params = new URLSearchParams();
    ['v', 'list', 't', 'index'].forEach(key => {
      const val = u.searchParams.get(key);
      if (val) params.set(key, val);
    });
    const query = params.toString();
    return u.origin + u.pathname + (query ? '?' + query : '');
  } catch (e) {
    return full;
  }
}

/* ------------------------------------------------------------
   クリップボードへコピー
   navigator.clipboard は https かつユーザー操作起点なら使えるが、
   Permissions-Policy やフォーカス状態で失敗することがあるため
   execCommand('copy') による従来手法をフォールバックに持つ。
   ------------------------------------------------------------ */
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // 画面外へ逃がす（display:none だと選択できずコピーに失敗する）
  ta.style.cssText = 'position:fixed !important; top:-9999px !important; left:-9999px !important; opacity:0 !important;';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => legacyCopy(text)   // 失敗したら従来手法へ
    );
  }
  return Promise.resolve(legacyCopy(text));
}

/* ------------------------------------------------------------
   タイトル取得
   旧実装は aria-label を ' by ' で分割していたため英語UI専用だった。
   日本語UIでは「タイトル 投稿者: チャンネル名 …」形式になり破綻するため、
   ①専用のタイトル要素 → ②title属性 → ③aria-label（多言語対応の分割）
   の順にフォールバックする。

   ★クラス名は YouTube 側の改修で頻繁に変わる（例: *-wiz サフィックスの廃止）ため、
     完全一致ではなく [class*="..."] の部分一致で拾う。
   ------------------------------------------------------------ */
function extractTitle(card, linkEl) {
  const titleSelectors = [
    '[id="video-title"]',
    'a[id="video-title-link"]',
    '[id="video-title-link"]',
    '[class*="lockup-metadata-view-model__title"]',
    'h3 a span',
    'h3 span[role="text"]',
    'h3 a'
  ];

  for (const sel of titleSelectors) {
    const el = card.querySelector(sel);
    if (!el) continue;
    const text = (el.getAttribute('title') || el.textContent || '').trim();
    if (text) return text;
  }

  if (linkEl) {
    const attrTitle = (linkEl.getAttribute('title') || '').trim();
    if (attrTitle) return attrTitle;

    const aria = (linkEl.getAttribute('aria-label') || '').trim();
    if (aria) {
      // 英語UI: "Title by Channel ..." / 日本語UI: "タイトル 投稿者: チャンネル ..."
      const split = aria.split(/\s+(?:by|投稿者:|作成者:|제작자:)\s+/)[0].trim();
      if (split) return split;
    }
  }

  return 'YouTube動画';
}

/* ------------------------------------------------------------
   ボタンの挿入先

   サムネイル上へのオーバーレイも検討したが、
   ・ホバー時の自動プレビュー(inline preview)がサムネイル領域をDOMごと差し替える
   ・レイアウトごとにサムネイルのラッパー構造が異なる
   ため安定性に欠けると判断し、メタデータ行の系統を使う。

   ★旧実装は .yt-content-metadata-view-model-wiz 等の「クラス名完全一致」に
     依存していたため、YouTube側が -wiz サフィックスを廃止した時点で
     全カードで null が返り、ボタンが1つも出ない状態になっていた。
     カスタム要素名（タグ名）は変更されにくいので、そちらを主軸にする。
     最終手段としてカード自体を返すため、この関数は null を返さない。
   ------------------------------------------------------------ */
function findInsertTarget(card) {
  /* 1. 旧レイアウト: 再生回数・投稿日の行（インラインで並ぶ）
        ★YouTubeは全カードが同じidを持つ（#metadata-line 等が重複）。
          IDセレクタは実装によって document 全体の最初の一致を返してしまい、
          「別カードの要素なので配下に無い」＝null と誤判定されうる。
          属性セレクタを使うと確実に card 配下だけを走査できる。 */
  const metaLine = card.querySelector('[id="metadata-line"]');
  if (metaLine) return metaLine;

  // 2. 新レイアウト: メタデータ block（タグ名で拾う＝クラス名変更に強い）
  //    行(row)ではなくブロックへ入れることで、行の overflow:hidden による
  //    見切れを避ける。表示上は「◯回視聴・◯日前」の下に1行増える形になる。
  const contentMeta = card.querySelector('yt-content-metadata-view-model');
  if (contentMeta) return contentMeta;

  // 3. 念のためクラス名の部分一致でも探す
  const contentMetaByClass = card.querySelector('[class*="content-metadata-view-model"]');
  if (contentMetaByClass) return contentMetaByClass;

  const lockupMeta = card.querySelector('yt-lockup-metadata-view-model, [class*="lockup-metadata-view-model__metadata"]');
  if (lockupMeta) return lockupMeta;

  // 4. 旧レイアウトの各種メタ領域
  const legacy = card.querySelector('[id="meta"], [id="details"], [id="byline-container"]');
  if (legacy) return legacy;

  // 5. タイトルの親（h3 等）へ添える
  const titleEl = card.querySelector('[id="video-title"], a[id="video-title-link"], [class*="lockup-metadata-view-model__title"], h3 a');
  if (titleEl && titleEl.parentElement) return titleEl.parentElement;

  // 6. 最終手段: カード直下（位置は崩れるが「出ない」よりは良い）
  return card;
}

function styleButton(button, label, color) {
  button.innerText = label;
  // cssTextで !important を付与しているため、上書きも setProperty で優先度を揃える
  button.style.setProperty('background-color', color, 'important');
}

function resetButtonLater(button) {
  setTimeout(() => {
    styleButton(button, LABEL_IDLE, COLOR_IDLE);
    button.dataset.busy = '0';
  }, RESULT_RESET_MS);
}

function resetCopyLater(button) {
  setTimeout(() => {
    styleButton(button, LABEL_COPY, COLOR_IDLE);
    button.dataset.busy = '0';
  }, COPY_RESET_MS);
}

// A側から返ってきた status に応じたボタン表示
function applyResult(button, status, slotIndex) {
  switch (status) {
    case 'loaded':
      styleButton(button, slotIndex ? ('✓ 枠' + slotIndex + 'へ送信') : '✓ 送信', COLOR_OK);
      break;
    case 'duplicate':
      styleButton(button, slotIndex ? ('⚠ 枠' + slotIndex + 'に追加済み') : '⚠ 追加済み', '#ffa502');
      break;
    case 'slotFull':
      styleButton(button, '✗ 枠が一杯', COLOR_NG);
      break;
    case 'invalid':
      styleButton(button, '✗ 取得失敗', COLOR_NG);
      break;
    default:
      styleButton(button, '✗ エラー', COLOR_NG);
      break;
  }
  resetButtonLater(button);
}

/* ------------------------------------------------------------
   診断用: 挿入先が見つからないカードの構造を1度だけ出力する。
   YouTubeがまたDOMを変えた際、ここのログを見れば
   どのタグ／クラスへ寄せればよいか即座に判断できる。
   ------------------------------------------------------------ */
function dumpCardStructure(card) {
  if (structureDumped) return;
  structureDumped = true;
  const all = Array.from(card.querySelectorAll('*'));
  const tags = Array.from(new Set(all.map(el => el.tagName.toLowerCase()))).slice(0, 40);
  const classHints = new Set();
  all.forEach(el => {
    const cls = (typeof el.className === 'string') ? el.className : '';
    cls.split(/\s+/).forEach(c => {
      if (c && /metadata|lockup|title|meta|byline/i.test(c)) classHints.add(c);
    });
  });
  console.warn('【アドオン】挿入先が見つからないカードの構造:', {
    tag: card.tagName.toLowerCase(),
    id: card.id || '(なし)',
    タグ一覧: tags,
    クラス候補: Array.from(classHints).slice(0, 30)
  });
}

/* ------------------------------------------------------------
   ボタン群の生成

   ［➕ 送信 │ ⧉］ の分割（セグメント）型。
   角丸と影は外側のコンテナが持ち、内側の2つは境界線だけで区切る。
   これにより「1つのボタンを左右に割った」見た目になる。
   送信結果で色が変わるのは左側だけ、コピー結果は右側だけに出る。
   ------------------------------------------------------------ */
const SEGMENT_BASE_CSS = `
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  background-color: ${COLOR_IDLE} !important;
  color: #ffffff !important;
  border: none !important;
  border-radius: 0 !important;
  margin: 0 !important;
  padding: 2px 6px !important;
  font-size: 11px !important;
  font-weight: bold !important;
  cursor: pointer !important;
  line-height: 1.2 !important;
  font-family: sans-serif !important;
  white-space: nowrap !important;
  min-height: 18px !important;
`;

/* ★v2.8.13: resolver は「クリックした瞬間の { url, title }」を返す関数。
   一覧はカードから、再生ページは location から取る。opts.large で再生ページ向けの大きさにする。 */
function createButtonGroup(resolver, opts) {
  opts = opts || {};
  const group = document.createElement('span');
  group.className = GROUP_CLASS;
  group.style.cssText = `
    display: inline-flex !important;
    align-items: stretch !important;
    vertical-align: middle !important;
    margin: 4px 0 0 8px !important;
    border-radius: 4px !important;
    overflow: hidden !important;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3) !important;
    position: relative !important;
    z-index: 100 !important;
  `;

  /* --- 左セグメント: コントローラーへ送信 --- */
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = BUTTON_CLASS;
  sendBtn.dataset.busy = '0';
  sendBtn.innerText = LABEL_IDLE;
  sendBtn.title = 'コントローラーの空き枠へ送信';
  sendBtn.style.cssText = SEGMENT_BASE_CSS;

  /* --- 右セグメント: URLをクリップボードへコピー --- */
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = COPY_CLASS;
  copyBtn.dataset.busy = '0';
  copyBtn.innerText = LABEL_COPY;
  copyBtn.title = 'この動画のURLをコピー';
  copyBtn.style.cssText = SEGMENT_BASE_CSS + `
    border-left: 1px solid rgba(255,255,255,0.5) !important;
    padding-left: 7px !important;
    padding-right: 7px !important;
    font-size: 12px !important;
  `;

  /* ★v2.8.13: 再生ページ向けは YouTube の丸いボタンに合わせて大きくする */
  if (opts.large) {
    group.style.setProperty('margin', '0 0 0 8px', 'important');
    group.style.setProperty('border-radius', '18px', 'important');
    group.style.setProperty('align-self', 'center', 'important');
    [sendBtn, copyBtn].forEach(b => {
      b.style.setProperty('font-size', '13px', 'important');
      b.style.setProperty('min-height', '36px', 'important');
      b.style.setProperty('padding', '0 12px', 'important');
    });
  }

  /* クリック時に毎回URLを取り直す（resolver に任せる）。
     ★カードはスクロール時にYouTube側で使い回され、再生ページは SPA で動画が替わる。
       挿入時点のURLを閉じ込めると別の動画を扱ってしまうため。 */
  const resolveCurrent = resolver;

  sendBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // 連打対策：結果が返る（またはタイムアウトする）まで再送信を無視する
    if (sendBtn.dataset.busy === '1') return;

    const current = resolveCurrent();
    if (!current) {
      styleButton(sendBtn, '✗ 取得失敗', COLOR_NG);
      resetButtonLater(sendBtn);
      return;
    }

    sendBtn.dataset.busy = '1';
    const requestId = generateRequestId();
    console.log("【アドオン】送信ボタンがクリックされました:", requestId, current.title, current.url);

    // 送信直後は「成功」ではなく中間表示にする（結果はA側の判定を待つ）
    styleButton(sendBtn, LABEL_SENDING, COLOR_SENDING);

    const timeoutId = setTimeout(() => {
      if (!pendingRequests.has(requestId)) return;
      pendingRequests.delete(requestId);
      console.warn("【アドオン】A側からの応答がタイムアウトしました:", requestId);
      styleButton(sendBtn, '✗ 応答なし', COLOR_NG);
      resetButtonLater(sendBtn);
    }, RESPONSE_TIMEOUT_MS);

    pendingRequests.set(requestId, { button: sendBtn, timeoutId: timeoutId });

    // 拡張機能の中継API（chrome.runtime）経由でコントローラータブへ送信
    sendRuntimeMessage({
      type: "YOUTUBE_ADD_VIDEO",
      url: current.url,
      title: current.title,
      requestId: requestId
    });
  });

  copyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (copyBtn.dataset.busy === '1') return;

    const current = resolveCurrent();
    if (!current) {
      styleButton(copyBtn, '✗', COLOR_NG);
      resetCopyLater(copyBtn);
      return;
    }

    copyBtn.dataset.busy = '1';
    copyToClipboard(current.url).then(ok => {
      if (ok) {
        console.log("【アドオン】URLをコピーしました:", current.url);
        styleButton(copyBtn, '✓', COLOR_OK);
      } else {
        console.warn("【アドオン】URLのコピーに失敗しました:", current.url);
        styleButton(copyBtn, '✗', COLOR_NG);
      }
      resetCopyLater(copyBtn);
    });
  });

  group.appendChild(sendBtn);
  group.appendChild(copyBtn);
  return group;
}

function injectControllerButtons() {
  const videoCards = document.querySelectorAll(cardSelectors);
  if (videoCards.length === 0) return;

  const stats = { total: videoCards.length, nested: 0, already: 0, noLink: 0, shorts: 0, injected: 0 };

  videoCards.forEach(card => {
    /* ★入れ子対策
       ホーム画面では ytd-rich-item-renderer の内側に yt-lockup-view-model が入る。
       両方がセレクタに一致するため、外側が先に処理されて
       内側が「挿入済み」扱いで潰されていた（＝ボタンが出ない原因のひとつ）。
       より内側の要素の方がメタデータ領域を特定しやすいので内側を優先する。 */
    if (card.querySelector(cardSelectors)) { stats.nested++; return; }

    /* ★挿入済み判定はフラグだけでなく実物の有無も見る。
       YouTubeはカードのDOMを再構築することがあり、
       フラグだけ残ってボタンが消えると二度と復活しなくなるため。 */
    if (card.dataset.buttonInjected === 'true' && card.querySelector('.' + GROUP_CLASS)) {
      stats.already++;
      return;
    }

    const linkEl = findVideoLink(card);
    if (!linkEl) { stats.noLink++; return; }

    const href = linkEl.getAttribute('href');
    if (!href) { stats.noLink++; return; }

    if (isShortsCard(card, href)) { stats.shorts++; return; }

    const insertTarget = findInsertTarget(card);
    if (insertTarget === card && DEBUG) dumpCardStructure(card);

    card.dataset.buttonInjected = 'true';
    insertTarget.appendChild(createButtonGroup(() => {
      const linkEl = findVideoLink(card);
      const href = linkEl ? linkEl.getAttribute('href') : null;
      if (!href) return null;
      return { url: buildCleanUrl(href), title: extractTitle(card, linkEl) };
    }));
    stats.injected++;
  });

  if (stats.injected > 0) {
    console.log(`【アドオン】新たに ${stats.injected} 件の動画カードに「${LABEL_IDLE}」ボタンを挿入しました。`);
    debugReportCount = 0; // 正常に動いたので診断カウンタをリセット
  } else if (DEBUG && stats.already === 0 && debugReportCount < DEBUG_MAX_REPORTS) {
    debugReportCount++;
    console.warn('【アドオン】ボタンを1件も挿入できませんでした。内訳:', stats);
  }
}

/* ------------------------------------------------------------
   ★v2.8.13: 再生ページ（/watch）のボタン
   置き場所はチャンネル登録ボタンの右（ytd-watch-metadata #owner の中）。
   🔴 送る URL はクリックした瞬間の location から取る（SPA で動画が替わってもボタンを作り直さない）。
   /watch 以外へ移ったら取り除く。
   ------------------------------------------------------------ */
const WATCH_GROUP_CLASS = 'sync-watch-btn-group';

function isWatchPage() {
  return location.pathname === '/watch' && new URLSearchParams(location.search).has('v');
}

function resolveWatchPage() {
  if (!isWatchPage()) return null;
  const titleEl = document.querySelector('ytd-watch-metadata h1 yt-formatted-string, ytd-watch-metadata h1, h1.ytd-watch-metadata');
  let title = titleEl ? (titleEl.textContent || '').trim() : '';
  if (!title) title = (document.title || '').replace(/\s*-\s*YouTube\s*$/, '').trim();
  return { url: buildCleanUrl(location.pathname + location.search), title: title };
}

function injectWatchPageButton() {
  const existing = document.querySelectorAll('.' + WATCH_GROUP_CLASS);
  if (!isWatchPage()) { existing.forEach(el => el.remove()); return; }
  const owner = document.querySelector('ytd-watch-metadata #owner');
  if (!owner) return;
  /* 既に正しい場所にあれば何もしない。別の場所に残ったもの（古いレイアウトの残り）は捨てる */
  let kept = false;
  existing.forEach(el => { if (!kept && owner.contains(el)) kept = true; else el.remove(); });
  if (kept) return;
  const group = createButtonGroup(resolveWatchPage, { large: true });
  group.classList.add(WATCH_GROUP_CLASS);
  const sub = owner.querySelector('#subscribe-button');
  if (sub && sub.parentNode === owner) sub.insertAdjacentElement('afterend', group);
  else owner.appendChild(group);
  console.log('【アドオン】再生ページに「' + LABEL_IDLE + '」ボタンを挿入しました。');
}

/* ------------------------------------------------------------
   A側（コントローラー）からの処理結果を受信する
   background.js → ここ、の経路で YOUTUBE_ADD_RESULT が届く。
   requestId が一致する保留中のボタンだけを更新する。
   ------------------------------------------------------------ */
ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "YOUTUBE_ADD_RESULT") return;

  const entry = pendingRequests.get(message.requestId);
  if (!entry) return; // 他タブ宛て、またはタイムアウト済み

  clearTimeout(entry.timeoutId);
  pendingRequests.delete(message.requestId);
  console.log("【アドオン】A側から結果を受信:", message.requestId, message.status, message.slotIndex);
  applyResult(entry.button, message.status, message.slotIndex);
});

/* ------------------------------------------------------------
   起動と監視
   ・MutationObserver: 無限スクロールやSPA遷移に即応
   ・setInterval: 取りこぼしに対する自己修復
   ------------------------------------------------------------ */
let scanScheduled = false;
function scheduleScan(delay) {
  if (scanScheduled) return;
  scanScheduled = true;
  setTimeout(() => {
    scanScheduled = false;
    try { injectControllerButtons(); } catch (e) { console.error('【アドオン】スキャン中のエラー:', e); }
    try { injectWatchPageButton(); } catch (e) { console.error('【アドオン】再生ページのボタンでエラー:', e); }
  }, delay || 300);
}

const observer = new MutationObserver(() => scheduleScan(300));
observer.observe(document.documentElement, { childList: true, subtree: true });

// YouTubeはSPAなので、ページ遷移イベントでも明示的に走らせる
window.addEventListener('yt-navigate-finish', () => scheduleScan(500));

window.addEventListener('load', () => scheduleScan(1000));
setInterval(() => scheduleScan(0), SCAN_INTERVAL_MS);
scheduleScan(500);
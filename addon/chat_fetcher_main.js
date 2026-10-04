/* =====================================================================
   chat_fetcher_main.js  ―  v2.6.0 新規 / ★MAIN world 専用
   ★v2.6.4: 版数はハードコードしない。注入直前に background.js が置く
     window.__SYNC_CHAT_EXPECTED_VERSION を構築時に 1 回だけ読んで保持する。

   YouTube の InnerTube API を直接叩いてアーカイブチャットを取得する。
   yt-dlp / Python / Native Messaging は使わない。

   ■ なぜ MAIN world でなければならないか
   Firefox の content script（ISOLATED world）の fetch は「拡張機能の
   principal」で飛ぶ。youtube.com 上で動いていても Origin は
   moz-extension:// になり、InnerTube は HTTP 403 を返す。
   ページ世界（MAIN world）から投げると Origin が
   https://www.youtube.com になり 200 が返る。
     background      … 403
     content(ISOLATED) … 403（さらに ytcfg が見えない）
     MAIN world      … 200  ★これだけが通る

   ■ MAIN world には browser.* が無い
   結果は window.postMessage でしか外に出せない。
   同一タブの ISOLATED 側（content_yt_chat.js）が受けて中継する。

   ■ 長時間処理をここに置く理由
   MV3 のバックグラウンドは 30 秒アイドルで終了する。
   9 本の取得は数分かかるため、バックグラウンドに置くと必ず落ちる。
   タブはアイドル終了しないので、キューも取得ループもここに置く。

   ■ InnerTube への POST には認証ヘッダが要る（★v2.7.5）
   credentials:'include' だけでは足りない。InnerTube は Authorization
   ヘッダを見ており、無いと responseContext.loggedOut:true として扱う。
   v2.6.0 から v2.7.4 まで、この POST は終始ログアウト扱いだった。
   公開アーカイブは件数が変わらないため表に出なかったが、メンバー限定は
   2,465 バイトの「このライブ ストリームではチャットは無効です。」だけを返す。

   ■ ライブ配信（★v2.8.0）
   配信中は端点が get_live_chat になり、currentPlayerState を送らない。
   応答が返す timeoutMs（実測 10,000ms）の間隔でポーリングし続ける。
   終端が無いので「完走」という概念が成立しない。第3の状態 live:true を
   立てて A 側へ知らせる。complete:false を流用してはいけない
   （A 側が「途中で失敗した」と表示してしまう）。

   ⚠️ ライブでは意図的に sleep を挟む。背面タブのタイマーは 1000ms に
      クランプされるが、待ちたいのは 10,000ms なので実害が無い
      （クランプは下限であって上限ではない）。
      アーカイブ側の取得ループには従来どおりタイマーを入れない。

   ■ ループに setTimeout を混ぜないこと
   背面タブのタイマーは 1000ms にクランプされる。
   fetch の await だけで回している限り間引かれない（実測 16 分で
   最大チャンク間隔 1,055ms）。sleep() は再試行経路にしか無い。
   ===================================================================== */
(function () {
  'use strict';

  /* 多重注入されても 1 個目だけが生きる */
  if (window.__syncChatEngine) return;

  /* ★v2.6.4: 注入側（background.js）が直前に置いた版数を、構築時に 1 回だけ読む。
     ここで固定するのが要点。以後 __SYNC_CHAT_EXPECTED_VERSION が新しくなっても
     この値は変わらないので、両者の食い違い＝旧エンジンの生き残りになる。 */
  const ENGINE_VERSION = window.__SYNC_CHAT_EXPECTED_VERSION || '(unknown)';

  const TAG = '__syncChat';       // MAIN → ISOLATED
  const CMD = '__syncChatCmd';    // ISOLATED → MAIN

  /* --------------------------------------------------------------
     調整可能な定数

     ★段階 1-F 実測済み（2026-07-26 / 逐次・q176a2krHbg・400req）
       束ね  msg   所要   最大チャンク間隔
         1   400  77.4s     445ms
         5    83  54.0s     934ms
        10    43  48.7s   1,692ms
        20    23  43.2s   2,599ms  ← 採用（取得だけの床に到達）
        50    11  43.1s   5,466ms  （同着だが間隔が倍）
       100     7  45.2s  11,244ms  （逆に遅い。巨大メッセージの複製コスト）
     1メッセージあたりの中継コスト = 約91ms（1-E の約120ms と整合）
     初回到達は全条件 1,171〜1,708ms。HEAD_IMMEDIATE=3 が効いている。

     ⚠️ 並列3では回線が律速（22 req/秒）して中継コストが隠れる。
        この手の計測は必ず逐次で行うこと。
     -------------------------------------------------------------- */
  const CFG = {
    CONCURRENCY: 3,           // 同時に走らせる動画の本数（実測で 3〜4 が頭打ち）
    HEAD_IMMEDIATE: 3,        // 先頭 N リクエストぶんは束ねず即送信（初回到達 1.3 秒を守る）
    FLUSH_REQS: 20,           // 以降は N リクエストごとに束ねて送る ★段階1-F で確定（上表）
    /* ⚠️ FLUSH_INTERVAL_MS は「安全弁」であって束ねの条件ではない。
       FLUSH_REQS × 1リクエスト約110ms より必ず大きくすること。
       小さいと時間側が先に発火し、束ねがまったく効かなくなる。 */
    FLUSH_INTERVAL_MS: 15000, // 取得が異常に遅いときデータを取り残さないための保険
    FLUSH_MAX_COMMENTS: 6000, // 1メッセージが巨大になりすぎないための上限
    MAX_REQUESTS: 4000,      // 暴走止め（実測の最大は 1,595 回）
    NO_PROGRESS_LIMIT: 3,    // 位置が進まない応答がこれだけ続いたら打ち切り
    /* ★v2.8.0 ライブ専用。
       🔴 NO_PROGRESS_LIMIT はライブに適用してはいけない。
          誰も書き込まない 10 秒は actions 0 件が正常であり、
          3 回続いたら打ち切る既存の式では 30 秒で取得が死ぬ。
       🔴 束ねもライブには適用しない。FLUSH_REQS=20 のままだと
          10 秒 × 20 = 200 秒ぶん溜め込んでから送ることになり、
          「配信中のチャット」ではなくなる。 */
    LIVE_POLL_MIN_MS: 1000,   // timeoutMs が異常に小さい／無いときの下限
    LIVE_POLL_MAX_MS: 30000,  // 同上の上限（実測は 10,000）
    LIVE_POLL_DEFAULT_MS: 5000,
    /* ★v2.11.0 ライブの自動復帰。
       出口（continuation が返らない・応答の形が違う・回線エラー）に来たら、
       watch ページを取り直して「まだ配信中か」を確かめ、配信中なら continuation を取り直す。
       待ちは BASE から倍々（上限 MAX_WAIT）。正常な応答が1回来たら連続回数を0に戻す。
       連続 LIVE_RECOVER_MAX 回で諦める（5+10+20+40+60×4 ≒ 5分）。 */
    LIVE_RECOVER_BASE_MS: 5000,
    LIVE_RECOVER_MAX_WAIT_MS: 60000,
    LIVE_RECOVER_MAX: 8,
    /* ★v2.11.0 ライブの暴走止め。アーカイブの MAX_REQUESTS（4000回）は10秒間隔だと約11時間で
       打ち切りになり、長時間配信で「配信終了」に見えていた（11節の注記 出口③）。≒55時間。 */
    LIVE_MAX_REQUESTS: 20000,
    COMPLETE_TOLERANCE_MS: 60000, // 動画長との照合の許容差
    RETRY: 3,                // 1 リクエストあたりの再試行回数
    PING_INTERVAL_MS: 5000,   // A 側の watchdog を維持する心拍
    /* 取得ジョブが空になってから、この時間だけ待って「用済み」を通知する。
       0 なら通知しない（タブを保持し続ける）。
       値はA側の設定から background 経由で差し替えられる。
       ⚠️ 0 にせず数秒の猶予を置くこと。枠を1つずつ開くような使い方だと、
          次の要求が来る直前にタブが閉じられ、作り直しに毎回3秒かかる。 */
    IDLE_CLOSE_MS: 0
  };

  const jobs = new Map();   // requestId → job
  const queue = [];         // 待機中の job
  let running = 0;
  let pingTimer = null;
  let idleTimer = null;

  /* ==============================================================
     外向きの送信
     ============================================================== */
  function post(obj) {
    obj[TAG] = 1;
    try { window.postMessage(obj, location.origin); } catch (e) {}
  }

  /* ==============================================================
     JSON の切り出し（HTML 埋め込み用）
     正規表現の {.*?} は巨大なミニファイ JSON で破綻するため、
     文字列リテラルとエスケープを見ながら深さを数える。
     ============================================================== */
  function sliceBalancedJson(text, fromIndex) {
    const start = text.indexOf('{', fromIndex);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
  }

  /* ==============================================================
     INNERTUBE_API_KEY / INNERTUBE_CONTEXT の入手

     第一手段はページの ytcfg。取れなければ watch ページの HTML から
     切り出す。こうしておくと「注入先が完全な YouTube アプリで
     なくても動く」ため、将来もっと軽いページへ移せる。
     ============================================================== */
  function cfgFromPage() {
    try {
      if (typeof window.ytcfg !== 'undefined' && window.ytcfg && window.ytcfg.get) {
        const key = window.ytcfg.get('INNERTUBE_API_KEY');
        const ctx = window.ytcfg.get('INNERTUBE_CONTEXT');
        if (key && ctx) return { key: key, ctx: ctx, from: 'ytcfg' };
      }
    } catch (e) {}
    return null;
  }

  function cfgFromHtml(html) {
    const km = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    const marker = '"INNERTUBE_CONTEXT"';
    const ci = html.indexOf(marker);
    if (!km || ci < 0) return null;
    const json = sliceBalancedJson(html, ci + marker.length);
    if (!json) return null;
    try { return { key: km[1], ctx: JSON.parse(json), from: 'html' }; }
    catch (e) { return null; }
  }

  /* ==============================================================
     watch ページの解析
     ★動画を再生する必要も、watch タブを開く必要もない。
       同一オリジンで HTML を fetch して切り出すだけでよい。
     ============================================================== */
  function findInitialData(html) {
    const marker = 'ytInitialData';
    let idx = html.indexOf(marker);
    while (idx >= 0) {
      const json = sliceBalancedJson(html, idx);
      if (json) {
        try {
          const d = JSON.parse(json);
          if (d && d.contents) return d;
        } catch (e) {}
      }
      idx = html.indexOf(marker, idx + marker.length);
    }
    return null;
  }

  /* ★v2.6.4: 取得できなかった理由を分けるために使う。
     findInitialData と同じ括弧の対応取りで ytInitialPlayerResponse を切り出す。
     取れなくても失敗にしない（判別できないだけなので CHAT_DISABLED へ落とす）。 */
  function findPlayerResponse(html) {
    const marker = 'ytInitialPlayerResponse';
    let idx = html.indexOf(marker);
    while (idx >= 0) {
      const json = sliceBalancedJson(html, idx);
      if (json) {
        try {
          const d = JSON.parse(json);
          if (d && (d.playabilityStatus || d.videoDetails)) return d;
        } catch (e) {}
      }
      idx = html.indexOf(marker, idx + marker.length);
    }
    return null;
  }

  /* ★v2.8.0: continuation の「入れ物」の名前を決め打ちしない。
     実測（段階0 / 2026-08-15）
       アーカイブ 次   : liveChatReplayContinuationData
       ライブ     初回 : reloadContinuationData（watch HTML 側）
       ライブ     次   : invalidationContinuationData（timeoutMs 10,000 を持つ）
     入れ物名で分岐すると、YouTube が名前を変えた時点で無言で止まる。
     「continuation という文字列を持つ子」を探す形にしておく。
     🔴 timeoutMs も同じ入れ物から拾う（別経路で取りに行かない）。 */
  function pickContinuationEntry(node) {
    if (!node || !Array.isArray(node.continuations)) return null;
    for (const c of node.continuations) {
      if (!c || typeof c !== 'object') continue;
      for (const k of Object.keys(c)) {
        const v = c[k];
        if (v && typeof v === 'object' && typeof v.continuation === 'string' && v.continuation) {
          return { box: k, token: v.continuation, timeoutMs: v.timeoutMs };
        }
      }
    }
    return null;
  }

  function pickReloadContinuation(lcr) {
    if (!lcr || !Array.isArray(lcr.continuations)) return null;
    for (const c of lcr.continuations) {
      if (!c || typeof c !== 'object') continue;
      for (const k of Object.keys(c)) {
        const v = c[k];
        if (v && typeof v === 'object' && typeof v.continuation === 'string' && v.continuation) {
          return v.continuation;
        }
      }
    }
    return null;
  }

  /* 🔴 ytInitialData から取れる continuation は「上位のチャットのリプレイ」
     （間引かれた表示）を指している。既定（すべて）では必ず全件側へ切り替えること。
     viewSelector は 1 回目の応答にしか入っていない。
     切替を忘れると件数が減るが「なんとなく少ない気がする」という
     最悪の形でしか気づけない。
     ★v2.10.0: 利用者が「上位のチャット」を選んだ枠では index 0 を使う。
       戻り値 { cont: 切り替え先（切り替え不要なら null）, view: 'top' | 'all' | 'unknown' }
       🔴 index 0 = 上位 / index 1 = すべて（実測 1-3節）。並びが変わったら view が 'unknown' になる。 */
  function pickChatView(lc, mode) {
    let items = null;
    try {
      items = lc.header.liveChatHeaderRenderer
                .viewSelector.sortFilterSubMenuRenderer.subMenuItems;
    } catch (e) { items = null; }
    if (!Array.isArray(items) || items.length < 2) return { cont: null, view: 'unknown' };
    const want = (mode === 'top') ? 0 : 1;
    const view = (want === 0) ? 'top' : 'all';
    if (items[want] && items[want].selected) return { cont: null, view: view };   // すでにその側
    /* ★v2.8.0: ここも入れ物名を決め打ちしない。
       ライブの subMenuItems[1] が reloadContinuationData とは限らないため
       （実測では「トップチャット / チャット」の 2 件が返る）。
       アーカイブでは従来と同じ値が返るので退行しない。 */
    const box = items[want] && items[want].continuation;
    if (!box || typeof box !== 'object') return { cont: null, view: 'unknown' };
    for (const k of Object.keys(box)) {
      const v = box[k];
      if (v && typeof v === 'object' && typeof v.continuation === 'string' && v.continuation) {
        return { cont: v.continuation, view: view };
      }
    }
    return { cont: null, view: 'unknown' };
  }

  /* ==============================================================
     整形（v2.5.x の出力フォーマットをそのまま踏襲）
       { t: 経過ms, n: 投稿者, m: 本文, p: スパチャ金額(任意) }
     ============================================================== */
  function textOf(node) {
    if (!node) return '';
    if (typeof node.simpleText === 'string') return node.simpleText;
    if (Array.isArray(node.runs)) {
      let s = '';
      for (const r of node.runs) if (typeof r.text === 'string') s += r.text;
      return s;
    }
    return '';
  }

  function pickLargestThumb(image) {
    if (!image || !Array.isArray(image.thumbnails) || !image.thumbnails.length) return null;
    let best = null;
    for (const t of image.thumbnails) {
      if (!t || !t.url) continue;
      if (!best || (t.width || 0) >= (best.width || 0)) best = t;
    }
    return best ? best.url : null;
  }

  /* message.runs は text と emoji が混在する。
       カスタム絵文字 … isCustomEmoji:true。shortcuts[0] を本文に入れ、
                        画像 URL を辞書へ登録する
       標準絵文字     … emojiId に Unicode 文字そのものが入っている。
                        そのまま本文へ（辞書不要） */
  function runsToText(msg, job, buf) {
    if (!msg) return '';
    if (!Array.isArray(msg.runs)) return textOf(msg);
    let s = '';
    for (const r of msg.runs) {
      if (typeof r.text === 'string') { s += r.text; continue; }
      const e = r.emoji;
      if (!e) continue;
      if (e.isCustomEmoji) {
        const sc = (e.shortcuts && e.shortcuts[0]) || e.emojiId || '';
        s += sc;
        if (sc && !job.emojiAll[sc]) {
          const url = pickLargestThumb(e.image);
          if (url) { job.emojiAll[sc] = url; buf.emoji[sc] = url; }
        }
      } else {
        s += (e.emojiId || (e.shortcuts && e.shortcuts[0]) || '');
      }
    }
    return s;
  }

  /* ==============================================================
     ★v2.8.0: 配信中かどうかの判定

     段階0 の実測（2026-08-15 / Floorp / IlamoLuHj8c ほか2本）
     | フィールド                          | LIVE | ARCHIVE | 通常動画 |
     | isLiveNow                           | true | false   | (なし)   |
     | videoDetails.isLive                 | true | (なし)  | (なし)   |
     | playabilityStatus.liveStreamability | あり | (なし)  | (なし)   |
     | videoDetails.isLiveContent          | true | true    | false    |
     | videoDetails.isLowLatencyLiveStream | true | true    | (なし)   |

     🔴 isLiveContent は「ライブ配信だったか」なので使えない（既知）。
     🔴 isLowLatencyLiveStream も ARCHIVE で true になる。名前に釣られないこと。
        判定に使えるのは上の 3 つだけである。

     🔴 順に見て、boolean が見つかった時点でそれを正とする。
        OR で束ねると誤検出（アーカイブをライブと誤る）が増える。
        誤検出はキャッシュ不保存・一括シーク除外という退行に直結するので、
        取りこぼす側（従来どおりアーカイブとして扱う）に倒す。
     ============================================================== */
  function detectLiveNow(pr) {
    const out = { live: false, by: 'none', seen: {} };
    if (!pr) return out;
    let lbd = null;
    try { lbd = pr.microformat.playerMicroformatRenderer.liveBroadcastDetails; } catch (e) { lbd = null; }
    const isLive = pr.videoDetails ? pr.videoDetails.isLive : undefined;
    const streamability = pr.playabilityStatus ? pr.playabilityStatus.liveStreamability : undefined;

    out.seen.isLiveNow = lbd ? lbd.isLiveNow : undefined;
    out.seen.isLive = isLive;
    out.seen.liveStreamability = streamability ? true : undefined;
    out.seen.hasEndTimestamp = lbd ? !!lbd.endTimestamp : undefined;

    if (lbd && typeof lbd.isLiveNow === 'boolean') { out.live = (lbd.isLiveNow === true); out.by = 'isLiveNow'; return out; }
    if (typeof isLive === 'boolean') { out.live = (isLive === true); out.by = 'videoDetails.isLive'; return out; }
    if (streamability) { out.live = true; out.by = 'liveStreamability'; return out; }
    return out;
  }

  /* ★v2.11.0: ライブの出口で watch ページを取り直す。
     戻り値 { ended:true, by } … 配信中ではなくなった（本当の終了）
            { ok:true, cont, cfg } … 配信中。取り直した continuation で続ける
            { ok:false, why } … 取り直せなかった（待って再試行する） */
  async function recoverLive(job) {
    const res = await fetch('/watch?v=' + encodeURIComponent(job.videoId), { credentials: 'include' });
    if (!res.ok) return { ok: false, why: 'HTTP ' + res.status };
    const html = await res.text();
    const lv = detectLiveNow(findPlayerResponse(html));
    if (!lv.live) return { ended: true, by: lv.by };
    let lcr = null;
    try {
      lcr = findInitialData(html).contents.twoColumnWatchNextResults.conversationBar.liveChatRenderer;
    } catch (e) { lcr = null; }
    if (!lcr) return { ok: false, why: 'NO_LIVE_CHAT_RENDERER' };
    const cont = pickReloadContinuation(lcr);
    if (!cont) return { ok: false, why: 'NO_CONTINUATION' };
    return { ok: true, cont: cont, cfg: cfgFromPage() || cfgFromHtml(html) };
  }

  /* 配信開始の実時刻(ms)。ライブのコメント時刻をここからの経過に直すために使う。 */
  function liveStartMsOf(pr) {
    try {
      const ts = pr.microformat.playerMicroformatRenderer.liveBroadcastDetails.startTimestamp;
      const v = Date.parse(ts);
      return isFinite(v) ? v : 0;
    } catch (e) { return 0; }
  }

  function toComment(item, t, job, buf) {
    const r = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer;
    if (!r) return null;   // 案内文（liveChatViewerEngagementMessageRenderer）等は捨てる

    /* チャンク境界で同じアイテムが再送されることがあるため id で重複排除 */
    if (r.id) {
      if (job.seen.has(r.id)) return null;
      job.seen.add(r.id);
    }

    const c = { t: t, n: textOf(r.authorName), m: runsToText(r.message, job, buf) };
    const p = textOf(r.purchaseAmountText);
    if (p) c.p = p;   // 通貨記号を保つため数値化しない
    return c;
  }

  /* ==============================================================
     ★v2.7.5: 認証ヘッダ（SAPISIDHASH）の組み立て

     付けるもの
       Authorization  : SAPISIDHASH <unix秒>_<sha1hex>
       X-Origin       : https://www.youtube.com
       X-Goog-AuthUser: 0
     ハッシュの材料 : "<unix秒> <Cookieの値> https://www.youtube.com" を
                      SHA-1 して16進小文字。

     🔴 守ること
       1. リクエストごとに作り直す。時刻を含むので使い回すと期限切れになりうる
       2. Cookie が見つからなければヘッダを付けずに従来どおり投げる。
          非ログインでも公開アーカイブは同じ件数が返る。退行させない
       3. crypto.subtle が失敗してもヘッダ無しで続行する。
          取得タブは https://www.youtube.com なので安全なコンテキストを満たすが、
          例外で取得ごと落とさないこと
       4. 🔴 Cookie の値もハッシュも、ログにもメッセージにも絶対に載せない。
          外に出してよいのは「組み立てられたか」と「どの名前で見つかったか」だけ
       5. credentials:'include' は外さない（watch ページの playabilityStatus が狂う）
     ============================================================== */
  const AUTH_ORIGIN = 'https://www.youtube.com';
  const AUTH_COOKIE_NAMES = ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'];

  /* 診断用の集計。★値は持たない。 */
  const authStat = { built: 0, skipped: 0, name: null, reason: null };

  /* 純関数。document.cookie の文字列を受け取り { name, value } か null を返す。 */
  function pickAuthCookie(jar) {
    const parts = String(jar || '').split(';');
    for (const name of AUTH_COOKIE_NAMES) {
      for (const p of parts) {
        const i = p.indexOf('=');
        if (i < 0) continue;
        if (p.slice(0, i).trim() !== name) continue;
        const v = p.slice(i + 1).trim();
        if (v) return { name: name, value: v };
      }
    }
    return null;
  }

  async function sha1Hex(text) {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    const view = new Uint8Array(digest);
    let s = '';
    for (let i = 0; i < view.length; i++) {
      const h = view[i].toString(16);
      s += (h.length === 1 ? '0' + h : h);
    }
    return s;
  }

  /* 例外を投げない。null を返したらヘッダ無しで投げる（従来の経路）。 */
  async function buildAuthHeaders() {
    let hit = null;
    try { hit = pickAuthCookie(document.cookie); } catch (e) { hit = null; }
    if (!hit) {
      authStat.skipped++; authStat.reason = 'no-cookie';
      return null;
    }
    try {
      const sec = Math.floor(Date.now() / 1000);
      const hash = await sha1Hex(sec + ' ' + hit.value + ' ' + AUTH_ORIGIN);
      authStat.built++; authStat.name = hit.name; authStat.reason = null;
      return {
        'Authorization': 'SAPISIDHASH ' + sec + '_' + hash,
        'X-Origin': AUTH_ORIGIN,
        'X-Goog-AuthUser': '0'
      };
    } catch (e) {
      /* 安全でないコンテキスト等。ここで落とさず、ヘッダ無しで続行させる。 */
      authStat.skipped++; authStat.reason = 'subtle-failed';
      return null;
    }
  }

  /* ==============================================================
     InnerTube への 1 リクエスト
     ============================================================== */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ★v2.8.0: isLive のときだけ端点と body を変える。
     🔴 認証ヘッダの作り方（v2.7.5 / SAPISIDHASH）には手を入れない。
        ライブでも同じヘッダが要る（メンバー限定配信のため）。
     🔴 ライブでは currentPlayerState を送らない。再生位置という概念が無い。 */
  async function postChat(cfg, continuation, offsetMs, isLive) {
    const url = '/youtubei/v1/live_chat/'
      + (isLive ? 'get_live_chat' : 'get_live_chat_replay')
      + '?key=' + encodeURIComponent(cfg.key);
    const payload = { context: cfg.ctx, continuation: continuation };
    if (!isLive) payload.currentPlayerState = { playerOffsetMs: String(offsetMs) };
    const body = JSON.stringify(payload);

    /* ★v2.7.5: 認証ヘッダはリクエストごとに作り直す。
       組み立てられなければ従来どおりヘッダ無しで投げる（非ログインを退行させない）。
       ⚠️ URL・body・再試行のロジックは v2.7.4 のまま。ここではヘッダだけを足している。 */
    const headers = { 'content-type': 'application/json' };
    const auth = await buildAuthHeaders();
    if (auth) for (const k of Object.keys(auth)) headers[k] = auth[k];

    let lastErr = null;
    for (let attempt = 0; attempt < CFG.RETRY; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: headers,
          body: body
        });
        if (res.ok) return await res.json();
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error('HTTP ' + res.status);
          /* ⚠️ ここの sleep は再試行経路にしかない。
             背面タブでは 1000ms にクランプされるが実害はない。
             正常系のループには絶対にタイマーを混ぜないこと。 */
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw new Error('HTTP ' + res.status);
      } catch (e) {
        lastErr = e;
        if (attempt === CFG.RETRY - 1) break;
        await sleep(400 * (attempt + 1));
      }
    }
    throw lastErr || new Error('InnerTube への要求に失敗しました');
  }

  /* ==============================================================
     1 本ぶんの取得
     ============================================================== */
  async function runJob(job) {
    const t0 = performance.now();

    /* ---- ① watch ページ HTML（動画を再生する必要はない） ---- */
    const res = await fetch('/watch?v=' + encodeURIComponent(job.videoId), { credentials: 'include' });
    if (!res.ok) throw new Error('watch ページを取得できませんでした (HTTP ' + res.status + ')');
    const html = await res.text();
    if (job.cancelled) return;

    let cfg = cfgFromPage() || cfgFromHtml(html);
    if (!cfg) throw new Error('INNERTUBE_API_KEY / CONTEXT を取得できませんでした');

    const lenM = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/);
    job.videoMs = lenM ? (parseInt(lenM[1], 10) * 1000) : 0;

    /* ★v2.8.0: playerResponse は「取得できなかった理由を分ける」ためだけでなく、
       配信中かどうかの判定にも要るので、liveChatRenderer の有無によらず常に取る。
       ⚠️ 1.5MB の HTML をもう一度なめることになる。実測値は done の parseMs へ出す。 */
    const prAll = findPlayerResponse(html);
    const live = detectLiveNow(prAll);
    job.live = live.live;
    job.liveBy = live.by;
    job.liveStartMs = live.live ? liveStartMsOf(prAll) : 0;

    const initial = findInitialData(html);
    let lcr = null;
    try {
      lcr = initial.contents.twoColumnWatchNextResults.conversationBar.liveChatRenderer;
    } catch (e) { lcr = null; }
    if (!lcr) {
      /* ★v2.6.4: 原因を分けて返す。A 側が文言を出し分けるため先頭に理由コードを付ける。
         書式は 'CODE: 説明'（半角コロン＋スペース区切り）。
           MEMBERS_ONLY     … 再生自体ができない（メンバー限定・年齢制限など）
           NOT_LIVE_ARCHIVE … ライブ配信のアーカイブではない（通常動画）
           CHAT_DISABLED    … 上 2 つに当たらず liveChatRenderer が無い
         ⚠ credentials:'include' は維持すること。ログイン状態で
            playabilityStatus の内容が変わるため、外すと判定が狂う。 */
      const pr = prAll;   /* ★v2.8.0: 上で取得済みのものを使う（二度なめない） */
      const st = pr && pr.playabilityStatus ? pr.playabilityStatus : null;
      const vd = pr && pr.videoDetails ? pr.videoDetails : null;

      if (st && st.status && st.status !== 'OK') {
        const reason = String(st.reason || (st.messages && st.messages[0]) || '').trim();
        throw new Error('MEMBERS_ONLY: この動画は再生できません'
          + (reason ? '（' + reason + '）' : '（メンバー限定または年齢制限の可能性）'));
      }
      if (vd && vd.isLiveContent !== true) {
        throw new Error('NOT_LIVE_ARCHIVE: ライブ配信のアーカイブではないため、チャットはありません');
      }
      throw new Error('CHAT_DISABLED: この配信ではチャットのリプレイが無効になっています');
    }

    let cont = pickReloadContinuation(lcr);
    if (!cont) throw new Error('チャットの continuation を取り出せませんでした');

    /* ★v2.8.0: live は「配信中」という第3の状態。complete:false を流用しない
       （A 側が「途中で失敗した」と表示してしまう）。
       liveBy は判定に効いたフィールド名。値は真偽だけで個人情報を含まない。 */
    post({
      ev: 'meta', requestId: job.requestId, videoId: job.videoId, ok: true,
      videoMs: job.videoMs, live: job.live, liveBy: job.liveBy
    });

    /* ---- ② continuation を辿る ---- */
    let offsetMs = 0;
    let reqs = 0;
    let noProgress = 0;
    let switched = false;
    let truncated = false;

    let buf = { comments: [], emoji: {} };
    let bufReqs = 0;
    let lastFlush = performance.now();

    /* ループ途中の送信専用。最後の1回はここを通さず done に同梱する。 */
    const flush = function () {
      if (!buf.comments.length) return;
      /* 保険。実測ではチャンク間の順序も保持されているが、
         JS の sort は安定なので同着の順序は壊れない。 */
      buf.comments.sort(function (a, b) { return a.t - b.t; });
      const last = buf.comments[buf.comments.length - 1].t;
      if (last > job.lastT) job.lastT = last;
      job.total += buf.comments.length;
      post({
        ev: 'chunk', requestId: job.requestId, videoId: job.videoId,
        seq: job.seq++, comments: buf.comments, emoji: buf.emoji, lastT: job.lastT,
        view: job.view,   /* ★v2.10.0 */
        liveRecovers: job.live ? job.liveRecovers : undefined   /* ★v2.11.0 */
      });
      buf = { comments: [], emoji: {} };
      bufReqs = 0;
      lastFlush = performance.now();
    };

    /* ★v2.11.0: ライブの出口。'continue' なら取り直した cont で続ける、'stop' なら終える。
       🔴 アーカイブでは呼ばない（終端が正常な終わり方なので）。 */
    let streak = 0;
    const liveExit = async function (kind, detail) {
      job.liveExits[kind] = (job.liveExits[kind] || 0) + 1;
      if (detail) job.recoverError = String(detail).slice(0, 200);
      for (;;) {
        if (job.cancelled) return 'stop';
        streak++;
        if (streak > CFG.LIVE_RECOVER_MAX) { job.endReason = 'RECOVERY_FAILED'; return 'stop'; }
        const wait = Math.min(CFG.LIVE_RECOVER_MAX_WAIT_MS, CFG.LIVE_RECOVER_BASE_MS * Math.pow(2, streak - 1));
        await sleep(wait);
        if (job.cancelled) return 'stop';
        let r;
        try { r = await recoverLive(job); }
        catch (e) { r = { ok: false, why: String(e && e.message ? e.message : e) }; }
        if (r.ended) { job.endReason = 'ENDED'; job.endBy = r.by; return 'stop'; }
        if (r.ok) {
          cont = r.cont;
          if (r.cfg) cfg = r.cfg;
          switched = false;          // 取り直した continuation は「上位」側を指す。v2.10.0 の切替をもう一度通す
          job.liveRecovers++;
          return 'continue';
        }
        job.recoverError = String(r.why || '').slice(0, 200);
      }
    };

    while (cont) {
      if (job.cancelled) return;
      if (job.live) {
        if (reqs >= CFG.LIVE_MAX_REQUESTS) { truncated = true; job.endReason = 'MAX_REQUESTS'; break; }
      } else if (reqs >= CFG.MAX_REQUESTS) { truncated = true; break; }

      let data;
      if (job.live) {
        /* ★v2.11.0: ライブでは回線エラーで取得全体を失敗にしない（出口④） */
        try { data = await postChat(cfg, cont, offsetMs, true); }
        catch (e) {
          if ((await liveExit('error', e && e.message ? e.message : e)) === 'continue') continue;
          break;
        }
      } else {
        data = await postChat(cfg, cont, offsetMs, false);
      }

      let lc = null;
      try { lc = data.continuationContents.liveChatContinuation; } catch (e) { lc = null; }
      if (!lc) {
        /* ★v2.7.5: 「このライブ ストリームではチャットは無効です。」と言われている応答を、
           理由を持たないまま 0 件の完走として扱わない。
           書式は既存に合わせる（'CODE: 説明' / 半角コロン＋スペース区切り）。
           新しいコードは作らない。A 側の出し分けは CHAT_DISABLED で実装済み（8-8節）。

           ⚠️ v2.6.4 の理由コード判定（上の liveChatRenderer が無いとき）とは別の場所。
              あちらは liveChatRenderer へ「到達できなかった」とき、
              こちらは「到達した後」。既存の判定は触っていない。
           🔴 1 回目かどうかで分けない。途中で返っても意味は同じである。
           🔴 messageRenderer が無いときは従来どおり break（正常な終端）。
              ここを変えると全取得が壊れる。 */
        let mr = null;
        try { mr = data.contents.messageRenderer; } catch (e) { mr = null; }
        /* ★v2.11.0: ライブの途中（2回目以降）は失敗にせず出口として扱う。
           配信が終わった直後に返ることがあり、終わったかどうかは recoverLive が判定する。
           1回目の messageRenderer は従来どおり CHAT_DISABLED（チャット無効の配信）。 */
        if (job.live && (reqs > 0 || !mr)) {
          if ((await liveExit(mr ? 'disabled' : 'noLc', mr ? textOf(mr.text) : '')) === 'continue') continue;
          break;
        }
        if (mr) {
          const notice = textOf(mr.text)
            || 'この配信ではチャットのリプレイが無効になっています';
          throw new Error('CHAT_DISABLED: ' + notice);
        }
        break;
      }

      /* 🔴 1 回目だけ「上位のチャット」→「全件」へ切り替える。
         この応答の actions は間引かれた側なので捨てて取り直す。
         ★v2.10.0: 上位を選んだ枠では index 0 のまま（すでに選ばれていれば切り替えず、この応答をそのまま使う）。 */
      if (!switched) {
        switched = true;
        const pick = pickChatView(lc, job.mode);
        job.view = pick.view;
        if (pick.cont) { cont = pick.cont; offsetMs = 0; continue; }
      }

      /* ★reqs は「捨てた1回」を数えない。
         こうしないと HEAD_IMMEDIATE が1つぶん食われ、
         段階1-F で測った値（検証アドオンの firstN / batch）と意味がずれる。
         1-D の実測 req 数（1,192 / 1,595 / 20）とも一致する。 */
      reqs++;
      job.reqs = reqs;

      const actions = Array.isArray(lc.actions) ? lc.actions : [];
      let added = 0;
      /* 🔴 位置は「最後に採用したコメントの t」で進めること。
         応答内の全アクションの最大時刻で進めてはいけない。
         ティッカーやメンバー加入など描画対象にならないアクションの時刻まで
         含めて進めると、次の要求で境界の数件を飛ばすことがある。
         実測: 73,230件の動画で 2件だけ欠けた（0.003%）。
         エラーも欠番も出ないため、件数を照合しないと気づけない。 */
      let lastCommentT = offsetMs;

      if (job.live) {
        /* ★v2.8.0 ライブ。実測（段階0）では replayChatItemAction は 0 件で、
           addChatItemAction が actions の直下に来る。
           各要素には clickTrackingParams が同居するが、見ないので影響しない。

           🔴 videoOffsetTimeMsec が無いので t を自分で作る。
              t = timestampUsec/1000 − 配信開始時刻 ＝ 配信開始からの経過ms。
              こうするとアーカイブ化後の videoOffsetTimeMsec と同じ意味になり、
              チャット欄の時刻表示も自然に出る。単調増加も保たれるので、
              A 側の二分探索・ソートを壊さない。
           ⚠️ startTimestamp が取れなかった場合は最初のコメントを 0 とみなす
              （負の値を A 側へ渡さないため）。 */
        for (const a of actions) {
          const item = a.addChatItemAction && a.addChatItemAction.item;
          if (!item) continue;
          const r = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer;
          const usec = r && r.timestampUsec ? parseInt(r.timestampUsec, 10) : 0;
          let t = 0;
          if (usec) {
            if (!job.liveStartMs) job.liveStartMs = usec / 1000;   // 保険
            t = Math.max(0, Math.round(usec / 1000 - job.liveStartMs));
          } else {
            t = job.lastT;
          }
          if (t < lastCommentT) t = lastCommentT;   // 昇順を必ず保つ
          const c = toComment(item, t, job, buf);
          if (c) { buf.comments.push(c); added++; if (t > lastCommentT) lastCommentT = t; }
        }
      } else {
        for (const a of actions) {
          const rep = a.replayChatItemAction;
          if (!rep) continue;   // ★ティッカーは addLiveChatTickerItemAction なのでここで落ちる
          const t = parseInt(rep.videoOffsetTimeMsec || '0', 10) || 0;
          const inner = Array.isArray(rep.actions) ? rep.actions : [];
          for (const ia of inner) {
            const item = ia.addChatItemAction && ia.addChatItemAction.item;
            if (!item) continue;
            const c = toComment(item, t, job, buf);
            if (c) { buf.comments.push(c); added++; if (t > lastCommentT) lastCommentT = t; }
          }
        }
      }

      /* ---- 束ね規則 ----
         検証用アドオン（chat-probe）の firstN / batch と同じ単位（リクエスト数）で
         数えている。1-F の計測結果をそのままここへ持ってこられるようにするため。 */
      bufReqs++;
      const now = performance.now();
      /* 🔴 ライブは束ねない。10 秒間隔 × FLUSH_REQS 20 = 200 秒ぶん溜め込むことになり、
         「配信中のチャット」として成立しなくなる。1 応答ごとにそのまま送る。
         中継コスト（約120ms）は 10 秒に 1 回なので問題にならない。 */
      if (buf.comments.length &&
          (job.live ||
           reqs <= CFG.HEAD_IMMEDIATE ||
           bufReqs >= CFG.FLUSH_REQS ||
           buf.comments.length >= CFG.FLUSH_MAX_COMMENTS ||
           (now - lastFlush) >= CFG.FLUSH_INTERVAL_MS)) {
        flush();
      }

      /* ---- 次の continuation ----
         ★v2.8.0: 入れ物名を決め打ちしない（アーカイブ liveChatReplayContinuationData /
         ライブ invalidationContinuationData）。timeoutMs も同じ入れ物から拾う。 */
      const nx = pickContinuationEntry(lc);
      const next = nx ? nx.token : null;

      if (job.live) {
        /* 🔴 ライブに NO_PROGRESS_LIMIT を適用してはいけない。
           誰も書き込まない 10 秒は actions 0 件が正常であり、
           3 回続いたら打ち切る既存の式では 30 秒で取得が死ぬ。
           終わるのは「次の continuation が返らなくなったとき」＝配信終了だけ。
           ⚠️ offsetMs も進めない（ライブでは送っていない）。 */
        if (!next) {
          /* ★v2.11.0: 出口②。従来はここで「配信終了」になっていた */
          if ((await liveExit('noNext', '')) === 'continue') continue;
          cont = null; break;
        }
        streak = 0;   // ★v2.11.0: 正常な応答が来たので連続回数を戻す
        let waitMs = (nx && typeof nx.timeoutMs === 'number') ? nx.timeoutMs : CFG.LIVE_POLL_DEFAULT_MS;
        if (!(waitMs > 0)) waitMs = CFG.LIVE_POLL_DEFAULT_MS;
        waitMs = Math.max(CFG.LIVE_POLL_MIN_MS, Math.min(CFG.LIVE_POLL_MAX_MS, waitMs));
        job.livePollMs = waitMs;
        job.livePolls = (job.livePolls || 0) + 1;
        cont = next;
        /* ⚠️ ここだけは意図的に待つ。背面タブの 1000ms クランプは下限なので
           10,000ms の待機には影響しない。アーカイブ側は従来どおり待たない。 */
        await sleep(waitMs);
        continue;
      }

      /* ★playerOffsetMs を進めないと同じ位置を繰り返して無限ループになる */
      if (lastCommentT > offsetMs) {
        offsetMs = lastCommentT;
        noProgress = 0;
      } else if (added === 0) {
        if (++noProgress >= CFG.NO_PROGRESS_LIMIT) break;
      } else {
        noProgress = 0;
      }
      cont = next;
    }

    /* 🔴 最後のチャンクは done と「同じメッセージ」で送る。
       別々に投げると、受け手が done を受けて片付けたあとに最終チャンクが
       届き、そのぶんが丸ごと消える。
       段階1-F フェーズ1で検証アドオンが実際にこれを踏んだ（7回中7回、
       最後に終わった動画だけが最終チャンクを失った）。
       別メッセージにする設計は採らないこと。 */
    let tailComments = null, tailEmoji = null, tailSeq = null;
    if (buf.comments.length) {
      buf.comments.sort(function (a, b) { return a.t - b.t; });
      const lastT = buf.comments[buf.comments.length - 1].t;
      if (lastT > job.lastT) job.lastT = lastT;
      job.total += buf.comments.length;
      tailComments = buf.comments;
      tailEmoji = buf.emoji;
      tailSeq = job.seq++;
      buf = { comments: [], emoji: {} };
    }

    /* 🔴 ライブに「完走」は無い。videoMs も 0（lengthSeconds が "0" で返る）なので
       この式は元から null を返すが、null は A 側で true に丸められる。
       live:true を別に立てて、A 側が第3の状態として扱えるようにする。 */
    const complete = job.live
      ? null
      : (job.videoMs > 0
          ? (job.lastT >= job.videoMs - CFG.COMPLETE_TOLERANCE_MS)
          : null);

    post({
      ev: 'done', requestId: job.requestId, videoId: job.videoId, ok: true,
      seq: tailSeq, comments: tailComments, emoji: tailEmoji,
      total: job.total, complete: complete, truncated: truncated,
      lastT: job.lastT, videoMs: job.videoMs, reqs: reqs,
      live: job.live, liveBy: job.liveBy, livePolls: job.livePolls || 0,
      view: job.view,   /* ★v2.10.0 */
      /* ★v2.11.0: ライブの終わり方。ENDED（配信中でなくなった）/ RECOVERY_FAILED / MAX_REQUESTS。
         アーカイブでは付けない（null）。 */
      endReason: job.live ? (job.endReason || 'ENDED') : null,
      endBy: job.endBy, liveRecovers: job.liveRecovers, liveExits: job.liveExits,
      recoverError: job.recoverError,
      elapsed: Math.round(performance.now() - t0)
    });
  }

  /* ==============================================================
     キュー
     ============================================================== */
  function pump() {
    while (running < CFG.CONCURRENCY && queue.length) {
      const job = queue.shift();
      if (job.cancelled) { jobs.delete(job.requestId); continue; }
      running++;
      job.startedAt = Date.now();
      runJob(job).catch(function (err) {
        if (job.cancelled) return;
        post({
          ev: 'done', requestId: job.requestId, videoId: job.videoId, ok: false,
          total: job.total, complete: false, truncated: false,
          lastT: job.lastT, videoMs: job.videoMs, reqs: job.reqs, elapsed: 0,
          live: job.live, liveBy: job.liveBy, livePolls: job.livePolls || 0,
          error: String(err && err.message ? err.message : err)
        });
      }).then(function () {
        running--;
        jobs.delete(job.requestId);
        pump();
        stopPingIfIdle();
      });
    }
    startPing();
  }

  function enqueue(requestId, videoId, mode) {
    if (!requestId || !videoId) return;
    if (jobs.has(requestId)) return;
    const job = {
      requestId: requestId, videoId: videoId,
      /* ★v2.10.0: 'top' = 上位のチャット / 'all' = すべてのチャット（既定）。
         view は 1回目の応答で実際に選ばれた側（'top' / 'all' / 'unknown'）。 */
      mode: mode === 'top' ? 'top' : 'all', view: 'unknown',
      cancelled: false, seq: 0, total: 0, lastT: 0, reqs: 0, videoMs: 0,
      /* ★v2.8.0 */
      live: false, liveBy: 'none', liveStartMs: 0, livePolls: 0, livePollMs: 0,
      /* ★v2.11.0 自動復帰の記録 */
      liveRecovers: 0, liveExits: {}, endReason: null, endBy: null, recoverError: null,
      seen: new Set(), emojiAll: {}
    };
    cancelIdleClose();
    jobs.set(requestId, job);
    queue.push(job);
    pump();
  }

  /* ジョブが空になったら「もう用済み」を通知する。
     タブを閉じるのは background の仕事で、ここは合図を出すだけ。 */
  function scheduleIdleClose() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!CFG.IDLE_CLOSE_MS || jobs.size) return;
    idleTimer = setTimeout(function () {
      idleTimer = null;
      if (jobs.size) return;            // 待っている間に新しい要求が来た
      post({ ev: 'idle' });
    }, CFG.IDLE_CLOSE_MS);
  }

  function cancelIdleClose() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function cancel(requestId) {
    const job = jobs.get(requestId);
    if (!job) return;
    job.cancelled = true;
    const i = queue.indexOf(job);
    if (i >= 0) { queue.splice(i, 1); jobs.delete(requestId); }
    stopPingIfIdle();
  }

  /* A 側の watchdog を維持する心拍。
     順番待ちの枠にも「残り何本待ちか」を伝えるために使う。 */
  function startPing() {
    if (pingTimer || !jobs.size) return;
    pingTimer = setInterval(function () {
      if (!jobs.size) { stopPingIfIdle(); return; }
      const active = [], waiting = [];
      jobs.forEach(function (j) {
        const e = { requestId: j.requestId, videoId: j.videoId, total: j.total, lastT: j.lastT };
        if (queue.indexOf(j) >= 0) { e.pos = queue.indexOf(j) + 1; waiting.push(e); }
        else active.push(e);
      });
      post({ ev: 'ping', active: active, waiting: waiting });
    }, CFG.PING_INTERVAL_MS);
  }

  function stopPingIfIdle() {
    if (pingTimer && !jobs.size) { clearInterval(pingTimer); pingTimer = null; }
    if (!jobs.size) scheduleIdleClose();
  }

  /* ==============================================================
     ISOLATED からの指示を受ける
     ============================================================== */
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;                 // 必須
    const d = e.data;
    if (!d || d[CMD] !== 1) return;
    if (d.cmd === 'CHAT_ENQUEUE') enqueue(d.requestId, d.videoId, d.mode);
    else if (d.cmd === 'CHAT_CANCEL') cancel(d.requestId);
    else if (d.cmd === 'CHAT_CONFIG' && d.config) {
      /* 段階 1-F の計測用。実行中に束ね方を差し替えられる。 */
      for (const k of Object.keys(d.config)) {
        if (Object.prototype.hasOwnProperty.call(CFG, k)) CFG[k] = d.config[k];
      }
      post({ ev: 'config', config: JSON.parse(JSON.stringify(CFG)) });
      if (!jobs.size) scheduleIdleClose();   // 方針が変わったら計り直す
    }
  });

  /* 取得タブのコンソールから叩ける診断口 */
  window.__syncChatEngine = {
    version: ENGINE_VERSION,
    /* 注入側が最後に置いた版数。version と違えば旧エンジンが生き残っている。 */
    expected: function () { return window.__SYNC_CHAT_EXPECTED_VERSION || '(unknown)'; },
    stale: function () { return ENGINE_VERSION !== (window.__SYNC_CHAT_EXPECTED_VERSION || ENGINE_VERSION); },
    cfg: CFG,
    /* ★v2.7.5: 認証ヘッダを組み立てられているか。🔴 値は返さない。 */
    auth: function () {
      return {
        組み立て成功: authStat.built,
        ヘッダ無しで送信: authStat.skipped,
        使ったCookie名: authStat.name || '(なし)',
        直近の理由: authStat.reason || '(なし)'
      };
    },
    stats: function () {
      const rows = [];
      jobs.forEach(function (j) {
        rows.push({
          requestId: j.requestId, videoId: j.videoId,
          待機中: queue.indexOf(j) >= 0, 件数: j.total,
          req: j.reqs, 最終位置ms: j.lastT, 動画長ms: j.videoMs,
          配信中: !!j.live, 判定元: j.liveBy, ポーリング回数: j.livePolls || 0,
          ポーリング間隔ms: j.livePollMs || 0
        });
      });
      if (console.table) console.table(rows);
      return rows;
    },
    enqueue: enqueue,
    cancel: cancel
  };

  post({ ev: 'ready', version: ENGINE_VERSION });
})();

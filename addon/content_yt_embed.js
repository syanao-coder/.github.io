/* ============================================================
   content_yt_embed.js  ★v2.9.0（R-11）

   コントローラーの枠の中の YouTube（www.youtube.com/embed/）で、
   「その他の動画」（一時停止時・終了時の関連動画）を押したときに
   別タブを開かず、親（コントローラー）へ videoId を渡してその枠で読み込ませる。

   🔴 親がこのツールのときだけ動く。他のサイトの埋め込み動画の挙動は変えない。
   🔴 中クリック・修飾キー付きのクリックは止めない（利用者が別タブを望む操作）。
   🔴 今の動画と同じ ID のリンク（タイトル・YouTube ロゴ）は止めない。
   ============================================================ */
(function () {
    'use strict';
    if (window.top === window) return;          // 埋め込まれていないときは何もしない

    const ALLOWED_PARENT = [
        /^https:\/\/syanao-coder\.github\.io$/,
        /^http:\/\/localhost(:\d+)?$/,
        /^http:\/\/127\.0\.0\.1(:\d+)?$/,
        /^null$/,                                  // file:// から開いたコントローラー
        /^file:\/\/$/
    ];

    function parentOrigin() {
        let o = '';
        try { o = new URLSearchParams(location.search).get('origin') || ''; } catch (e) { }
        if (!o) {
            try { o = document.referrer ? new URL(document.referrer).origin : ''; } catch (e) { }
        }
        return o;
    }
    const PARENT_ORIGIN = parentOrigin();
    if (!ALLOWED_PARENT.some(function (re) { return re.test(PARENT_ORIGIN); })) return;
    const TARGET_ORIGIN = /^https?:/.test(PARENT_ORIGIN) ? PARENT_ORIGIN : '*';
    if (window.__syncEmbedInstalled) return;
    window.__syncEmbedInstalled = true;

    function addonVersion() {
        try { return browser.runtime.getManifest().version; } catch (e) { return null; }
    }

    function currentVideoId() {
        const m = location.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/);
        return m ? m[1] : null;
    }

    /* リンク先の videoId（と list）を取り出す。動画でなければ null。 */
    function parseVideoLink(href) {
        let u;
        try { u = new URL(href, location.href); } catch (e) { return null; }
        let id = null;
        if (/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) {
            if (u.pathname === '/watch') id = u.searchParams.get('v');
            else {
                const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/);
                if (m) id = m[1];
            }
        } else if (u.hostname === 'youtu.be') {
            const m = u.pathname.match(/^\/([A-Za-z0-9_-]{11})/);
            if (m) id = m[1];
        }
        if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
        return { videoId: id, list: u.searchParams.get('list') || null, href: u.href };
    }

    /* 履歴に残す見出し。取れなければ空（A側が URL で代用する）。 */
    function linkTitle(a) {
        const el = a.querySelector('.ytp-videowall-still-info-title, .ytp-suggestion-title, .ytp-modern-videowall-still-info-title');
        let t = (el && el.textContent) || a.getAttribute('title') || a.getAttribute('aria-label') || '';
        t = String(t).replace(/\s+/g, ' ').trim();
        return t.slice(0, 200);
    }

    function post(msg) {
        try { window.parent.postMessage(msg, TARGET_ORIGIN); } catch (e) { }
    }

    /* 🔴 document_start で window の capture に付ける＝YouTube 自身の click 処理より先に走る。 */
    window.addEventListener('click', function (e) {
        if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
        const t = e.target;
        const a = (t && t.closest) ? t.closest('a[href]') : null;
        if (!a) return;
        const link = parseVideoLink(a.getAttribute('href'));
        if (!link) return;
        if (link.videoId === currentVideoId()) return;   // 同じ動画（タイトル・ロゴ）は YouTube に任せる
        e.preventDefault();
        e.stopImmediatePropagation();
        post({
            type: 'SYNC_EMBED_OPEN',
            videoId: link.videoId,
            list: link.list,
            href: link.href,
            title: linkTitle(a),
            embedHref: location.href,
            version: addonVersion()
        });
    }, true);

    /* 親からの点呼に答える（A側がこの枠で content script が動いているかを測る）。 */
    window.addEventListener('message', function (e) {
        if (e.source !== window.parent) return;
        const d = e.data;
        if (!d || typeof d !== 'object' || d.type !== 'SYNC_EMBED_PING') return;
        post({ type: 'SYNC_EMBED_HELLO', nonce: d.nonce, embedHref: location.href, version: addonVersion() });
    });
})();

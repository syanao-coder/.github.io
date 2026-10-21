/* ============================================================
   content_yt_embed.js  ★v2.9.0（R-11）

   コントローラーの枠の中の YouTube（www.youtube.com/embed/）で、
   「その他の動画」（一時停止時・終了時の関連動画）を押したときに
   別タブを開かず、親（コントローラー）へ videoId を渡してその枠で読み込ませる。

   🔴 親がこのツールのときだけ動く。他のサイトの埋め込み動画の挙動は変えない。
   🔴 中クリック・修飾キー付きのクリックは止めない（利用者が別タブを望む操作）。
   🔴 今の動画と同じ ID のリンク（タイトル・YouTube ロゴ）は止めない。
   ★v2.12.0: 音量メーター（下の「音量メーター」の節）。親の指示があるときだけ動く。
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

    /* ============================================================
       ★v2.12.0 音量メーター
       動画の音を Web Audio に付け替えて（createMediaElementSource）大きさを測り、親へ送る。
       🔴 親から SYNC_EMBED_METER の attach:true を受けるまで何もしない（逃げ道。送られなければ 2.11.1 と同じ）。
       🔴 付け替えは元に戻せない。AudioContext が running になったのを確かめてから付け替える
          （suspended のまま付け替えると無音になるおそれ ─ スパイク A1）。
       🔴 mozCaptureStream は使わない（Floorp で元の音が戻らなかった ─ スパイク A1）。
       ============================================================ */
    const meter = {
        allowed: false,        // 親が attach を許可したか
        attached: false,       // 付け替え済みか
        trying: false,
        ctx: null, video: null, an: null, an2: null, buf: null, buf2: null,
        reportUntil: 0, reportTimer: null, watchTimer: null,
        badSince: 0, brokenSent: false, state: 'waiting', why: '', tries: 0, lastTry: 0
    };

    function meterVideo() { return document.querySelector('video'); }

    function rmsDb(an, buf) {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const r = Math.sqrt(s / buf.length);
        return r > 0 ? Math.max(-120, 20 * Math.log10(r)) : -120;
    }

    /* YouTube 自身の「動画全体の音の大きさ」。読めなければ null（未確認の値なので取れたときだけ使う）。 */
    function loudnessInfo() {
        try {
            const mp = document.getElementById('movie_player');
            const raw = (mp && mp.wrappedJSObject) || mp;   // Firefox の content script からはページ側の関数に wrappedJSObject で触る
            const pr = raw && typeof raw.getPlayerResponse === 'function' ? raw.getPlayerResponse() : null;
            const ac = pr && pr.playerConfig && pr.playerConfig.audioConfig;
            if (!ac) return { loudnessDb: null, perceptualLoudnessDb: null };
            const num = function (x) { const v = Number(x); return isFinite(v) ? v : null; };
            return { loudnessDb: num(ac.loudnessDb), perceptualLoudnessDb: num(ac.perceptualLoudnessDb) };
        } catch (e) { return { loudnessDb: null, perceptualLoudnessDb: null }; }
    }

    async function meterTryAttach() {
        if (!meter.allowed || meter.attached || meter.trying) return;
        const v = meterVideo();
        if (!v || v.paused) { meter.state = 'waiting'; return; }   // 再生が始まってから（音を出す許可が出ている）
        if (Date.now() - meter.lastTry < 2000) return;             // 失敗したときに作っては捨てるのを繰り返さない
        meter.lastTry = Date.now();
        meter.trying = true;
        meter.tries++;
        let ctx = null;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            ctx = new Ctx();
            if (ctx.state !== 'running') {
                await Promise.race([ctx.resume().catch(function () { }), new Promise(function (r) { setTimeout(r, 1000); })]);
            }
            if (ctx.state !== 'running') {
                meter.state = 'suspended'; meter.why = 'AudioContext が ' + ctx.state + ' のまま';
                try { ctx.close(); } catch (e) { }
                return;                                              // 🔴 付け替えない。次の playing で試し直す
            }
            const src = ctx.createMediaElementSource(v);
            src.connect(ctx.destination);                            // 🔴 繋がないと音が出なくなる
            const an = ctx.createAnalyser(); an.fftSize = 2048;
            const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1000; bp.Q.value = 0.7;   // 声の帯域（おおよそ）
            const an2 = ctx.createAnalyser(); an2.fftSize = 2048;
            src.connect(an); src.connect(bp); bp.connect(an2);
            meter.ctx = ctx; meter.video = v; meter.an = an; meter.an2 = an2;
            meter.buf = new Float32Array(an.fftSize); meter.buf2 = new Float32Array(an2.fftSize);
            meter.attached = true; meter.state = 'running'; meter.why = '';
            ctx.addEventListener('statechange', function () {
                if (ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(function () { });
            });
            if (!meter.watchTimer) meter.watchTimer = setInterval(meterWatch, 1000);
        } catch (e) {
            meter.state = 'error'; meter.why = String(e && e.message ? e.message : e).slice(0, 160);
            if (ctx && !meter.attached) { try { ctx.close(); } catch (e2) { } }
        } finally {
            meter.trying = false;
        }
    }

    /* 見張り: 付け替えた後、再生中なのに音の処理が止まっていたら再開を試み、3秒続いたら親へ知らせる
       （親はこの枠を付け替えなしで読み直す）。 */
    function meterWatch() {
        const ctx = meter.ctx, v = meter.video;
        if (!ctx || !v) return;
        meter.state = ctx.state === 'running' ? 'running' : 'suspended';
        if (ctx.state === 'running' || v.paused) { meter.badSince = 0; return; }
        ctx.resume().catch(function () { });
        if (!meter.badSince) meter.badSince = Date.now();
        if (!meter.brokenSent && Date.now() - meter.badSince >= 3000) {
            meter.brokenSent = true;
            post({ type: 'SYNC_EMBED_METER_BROKEN', why: 'AudioContext が ' + ctx.state + ' のまま', embedHref: location.href, version: addonVersion() });
        }
    }

    function meterReport() {
        if (Date.now() > meter.reportUntil) { clearInterval(meter.reportTimer); meter.reportTimer = null; return; }
        if (!meter.attached) meterTryAttach();
        const v = meter.video || meterVideo();
        const msg = {
            type: 'SYNC_EMBED_LEVEL', state: !meter.allowed ? 'off' : (meter.attached ? meter.state : (meter.state === 'running' ? 'waiting' : meter.state)),
            why: meter.why || '', db: null, speechDb: null, latencyMs: null,
            volume: v ? v.volume : null, muted: v ? v.muted : null, paused: v ? v.paused : null,
            embedHref: location.href, version: addonVersion()
        };
        if (meter.attached && meter.ctx && meter.ctx.state === 'running') {
            msg.db = rmsDb(meter.an, meter.buf);
            msg.speechDb = rmsDb(meter.an2, meter.buf2);
            const lat = (meter.ctx.baseLatency || 0) + (meter.ctx.outputLatency || 0);
            msg.latencyMs = Math.round(lat * 1000);
        }
        const li = loudnessInfo();
        msg.loudnessDb = li.loudnessDb; msg.perceptualLoudnessDb = li.perceptualLoudnessDb;
        post(msg);
    }

    function meterCommand(d) {
        if (d.attach === true && !meter.allowed) {
            meter.allowed = true;
            /* 再生が始まった瞬間に付け替える（document_start なので video はまだ無いことがある → capture で拾う）。 */
            document.addEventListener('playing', function () { meterTryAttach(); }, true);
        }
        if (meter.allowed) meterTryAttach();
        if (d.report === true) {
            meter.reportUntil = Date.now() + 3000;                   // 貸し出し。親が送り直さなければ3秒で止まる
            if (!meter.reportTimer) meter.reportTimer = setInterval(meterReport, 100);
        }
    }

    /* 親からの点呼に答える（A側がこの枠で content script が動いているかを測る）。 */
    window.addEventListener('message', function (e) {
        if (e.source !== window.parent) return;
        const d = e.data;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'SYNC_EMBED_METER') { meterCommand(d); return; }   // ★v2.12.0
        if (d.type !== 'SYNC_EMBED_PING') return;
        post({ type: 'SYNC_EMBED_HELLO', nonce: d.nonce, embedHref: location.href, version: addonVersion() });
    });
})();

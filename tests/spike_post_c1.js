/* ============================================================
   スパイク C1: 配信中のライブにコメントを投稿できるか（版数を切らない・本番コードもアドオンも変えない）
   🔴 https://www.youtube.com/ のどのページでもよい。コンソールの実行先は「Top」のまま貼る。
   画面の右上に小さなパネルが出る。
     ▶ C1 調べる … 投稿の準備が整っているかを読むだけ（🔴 送らない）
     ▶ C2 送る   … 本文を確認の窓で「OK」したときだけ1回送る（🔴 YouTube のチャットに残る）
   🔴 Cookie の値・ハッシュ・params の中身・チャンネル名・応答の本文は出力に載せない。
   🔴 innerHTML は使わない（YouTube は文字列での HTML の書き込みを禁じている）。
   ============================================================ */
(function () {
    'use strict';
    var SNIP_VERSION = 'post-c1-1.0.0';
    var ORIGIN = 'https://www.youtube.com';
    var AUTH_COOKIE_NAMES = ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'];
    var MAX_LEN = 200;
    var COOLDOWN_MS = 15000;

    if (location.origin !== ORIGIN || window.top !== window) {
        console.warn('[スパイク C1] ここは ' + location.href + ' です。https://www.youtube.com/ のページで、コンソールの実行先を「Top」にして貼ってください。');
        return;
    }
    if (window.__postSpike && window.__postSpike.panel) { try { window.__postSpike.panel.remove(); } catch (e) { } }
    var S = window.__postSpike = { reports: [], running: false, prep: null, lastSendAt: 0 };

    /* ---------- 共通 ---------- */
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function videoIdOf(s) {
        s = String(s || '').trim();
        var m = s.match(/(?:v=|youtu\.be\/|\/live\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
        if (m) return m[1];
        return /^[A-Za-z0-9_-]{11}$/.test(s) ? s : null;
    }
    function sliceBalancedJson(text, from) {
        var start = text.indexOf('{', from);
        if (start < 0) return null;
        var depth = 0, inStr = false, esc = false;
        for (var i = start; i < text.length; i++) {
            var c = text[i];
            if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
            if (c === '"') inStr = true;
            else if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
        }
        return null;
    }
    function initialData(html) {
        var marker = 'ytInitialData', idx = html.indexOf(marker);
        while (idx >= 0) {
            var json = sliceBalancedJson(html, idx);
            if (json) { try { var d = JSON.parse(json); if (d && (d.contents || d.continuationContents)) return d; } catch (e) { } }
            idx = html.indexOf(marker, idx + marker.length);
        }
        return null;
    }
    function cfg() {
        var y = window.ytcfg && window.ytcfg.get ? window.ytcfg : null;
        var g = function (k) { try { return y ? y.get(k) : undefined; } catch (e) { return undefined; } };
        return {
            key: g('INNERTUBE_API_KEY'), ctx: g('INNERTUBE_CONTEXT'),
            clientName: g('INNERTUBE_CONTEXT_CLIENT_NAME'), clientVersion: g('INNERTUBE_CONTEXT_CLIENT_VERSION'),
            sessionIndex: g('SESSION_INDEX'), delegated: g('DELEGATED_SESSION_ID'), loggedIn: g('LOGGED_IN')
        };
    }
    function pickAuthCookie() {
        var parts = String(document.cookie || '').split(';');
        for (var n = 0; n < AUTH_COOKIE_NAMES.length; n++) {
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i], j = p.indexOf('=');
                if (j < 0 || p.slice(0, j).trim() !== AUTH_COOKIE_NAMES[n]) continue;
                var v = p.slice(j + 1).trim();
                if (v) return { name: AUTH_COOKIE_NAMES[n], value: v };
            }
        }
        return null;
    }
    async function sha1Hex(text) {
        var d = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)));
        var s = '';
        for (var i = 0; i < d.length; i++) s += (d[i] < 16 ? '0' : '') + d[i].toString(16);
        return s;
    }
    /* 取得エンジン（chat_fetcher_main.js の buildAuthHeaders）と同じ作り方。値は返すが出力には載せない */
    async function headers(c) {
        var h = { 'content-type': 'application/json' };
        var hit = pickAuthCookie();
        var info = { cookie: hit ? hit.name : '(なし)', authUser: '0', pageId: false, client: false };
        if (hit) {
            var sec = Math.floor(Date.now() / 1000);
            h['Authorization'] = 'SAPISIDHASH ' + sec + '_' + (await sha1Hex(sec + ' ' + hit.value + ' ' + ORIGIN));
            h['X-Origin'] = ORIGIN;
            info.authUser = (c.sessionIndex !== undefined && c.sessionIndex !== null) ? String(c.sessionIndex) : '0';
            h['X-Goog-AuthUser'] = info.authUser;
            if (c.delegated) { h['X-Goog-PageId'] = String(c.delegated); info.pageId = true; }
        }
        if (c.clientName && c.clientVersion) { h['X-Youtube-Client-Name'] = String(c.clientName); h['X-Youtube-Client-Version'] = String(c.clientVersion); info.client = true; }
        return { h: h, info: info };
    }
    function keysOf(o) { return (o && typeof o === 'object') ? Object.keys(o).join(',') : '(なし)'; }
    function textOf(t) {
        if (!t) return '';
        if (t.simpleText) return t.simpleText;
        if (t.runs) return t.runs.map(function (r) { return r.text || (r.emoji && r.emoji.shortcuts ? r.emoji.shortcuts[0] : ''); }).join('');
        return '';
    }
    function firstCont(lcr) {
        var cs = (lcr && lcr.continuations) || [];
        for (var i = 0; i < cs.length; i++) {
            var c = cs[i], d = c.invalidationContinuationData || c.timedContinuationData || c.reloadContinuationData || c.liveChatReplayContinuationData;
            if (d && d.continuation) return d.continuation;
        }
        return null;
    }
    async function getLiveChat(c, continuation) {
        var hh = await headers(c);
        var res = await fetch('/youtubei/v1/live_chat/get_live_chat?key=' + encodeURIComponent(c.key) + '&prettyPrint=false',
            { method: 'POST', credentials: 'include', headers: hh.h, body: JSON.stringify({ context: c.ctx, continuation: continuation }) });
        if (!res.ok) return { status: res.status, body: null };
        return { status: res.status, body: await res.json() };
    }
    function chatTexts(body) {
        var lc = body && body.continuationContents && body.continuationContents.liveChatContinuation;
        var out = [];
        ((lc && lc.actions) || []).forEach(function (a) {
            var it = a.addChatItemAction && a.addChatItemAction.item;
            var r = it && (it.liveChatTextMessageRenderer || it.liveChatPaidMessageRenderer);
            if (r) out.push(textOf(r.message));
        });
        var next = null;
        ((lc && lc.continuations) || []).forEach(function (cc) {
            var d = cc.invalidationContinuationData || cc.timedContinuationData || cc.reloadContinuationData;
            if (!next && d && d.continuation) next = d.continuation;
        });
        return { texts: out, next: next, lc: lc };
    }

    /* ---------- D-P1: 調べる（送らない） ---------- */
    async function probe(input) {
        var r = { id: 'D-P1', name: '投稿の準備（🔴 送らない・読むだけ）', results: [], pcs: [], notes: [] };
        var vid = videoIdOf(input);
        var c = cfg();
        r.pcs.push({ name: 'ここは www.youtube.com のページ（実行先が Top）', ok: true, value: location.origin + location.pathname });
        r.pcs.push({ name: '動画 ID を読めた', ok: !!vid, value: vid || '(読めない: ' + String(input).slice(0, 40) + ')' });
        if (!vid) { r.verdict = '判定不能'; return r; }

        var html = '';
        try { var res = await fetch('/live_chat?is_popout=1&v=' + vid, { credentials: 'include' }); html = res.ok ? await res.text() : ''; r.notes.push({ name: '/live_chat ページの HTTP', value: String(res.status) }); }
        catch (e) { r.notes.push({ name: '/live_chat ページの取得', value: '失敗: ' + (e && e.message) }); }
        var d = html ? initialData(html) : null;
        var lcr = d && d.contents && d.contents.liveChatRenderer;
        r.pcs.push({ name: '🔴 /live_chat ページから liveChatRenderer を取れた（配信中でチャットがある）', ok: !!lcr, value: lcr ? 'あり' : (d ? 'ytInitialData はあるが liveChatRenderer が無い（' + keysOf(d.contents) + '）' : 'ytInitialData が無い') });
        if (!c.key || !c.ctx) {
            var km = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/), ci = html.indexOf('"INNERTUBE_CONTEXT"');
            if (km && ci >= 0) { try { c.key = km[1]; c.ctx = JSON.parse(sliceBalancedJson(html, ci + 19)); r.notes.push({ name: 'キーと文脈の出どころ', value: 'HTML（このページの ytcfg に無かった）' }); } catch (e) { } }
        } else r.notes.push({ name: 'キーと文脈の出どころ', value: 'このページの ytcfg' });
        if (!lcr) { r.verdict = '判定不能'; return r; }

        var hit = pickAuthCookie();
        r.results.push({ name: '🔴 ログイン済み（認証用の Cookie がある）', ok: !!hit, actual: hit ? 'あり（' + hit.name + '）' : 'なし', expected: 'あり' });
        var hh = null;
        try { hh = await headers(c); } catch (e) { }
        r.results.push({ name: '🔴 認証ヘッダを組み立てられる（SAPISIDHASH）', ok: !!(hh && hh.h['Authorization']), actual: hh && hh.h['Authorization'] ? 'ok' : '作れない', expected: 'ok' });
        r.results.push({ name: 'キーと文脈（INNERTUBE_API_KEY / CONTEXT）がある', ok: !!(c.key && c.ctx), actual: (c.key && c.ctx) ? 'ok' : '無い', expected: 'ok' });
        r.notes.push({ name: 'X-Goog-AuthUser / X-Goog-PageId（ブランドアカウント）/ クライアント名のヘッダ', value: (hh ? hh.info.authUser + ' / ' + (hh.info.pageId ? '付けた' : '無し') + ' / ' + (hh.info.client ? '付けた' : '無し') : '-') + '（ytcfg LOGGED_IN=' + String(c.loggedIn) + '）' });

        var ap = lcr.actionPanel || null;
        var inputR = ap && ap.liveChatMessageInputRenderer;
        var params = null;
        try { params = inputR.sendButton.buttonRenderer.serviceEndpoint.sendLiveChatMessageEndpoint.params; } catch (e) { params = null; }
        r.results.push({ name: '🔴 投稿欄がある（actionPanel が liveChatMessageInputRenderer）', ok: !!inputR, actual: ap ? keysOf(ap) : 'actionPanel なし', expected: 'liveChatMessageInputRenderer' });
        r.results.push({ name: '🔴 送るための params がある（sendLiveChatMessageEndpoint）', ok: !!params, actual: params ? 'あり（' + params.length + '文字）' : 'なし', expected: 'あり' });
        if (ap && !inputR) {
            var restr = ap[Object.keys(ap)[0]] || {};
            r.notes.push({ name: '投稿できない理由の文言（actionPanel の中）', value: (textOf(restr.message) || textOf(restr.text) || keysOf(restr)).slice(0, 120) });
        }
        if (inputR) {
            r.notes.push({ name: '投稿欄の子の名前', value: keysOf(inputR) });
            r.notes.push({ name: '投稿者の名前・アイコンが入っているか（中身は載せない）', value: (inputR.authorName ? '名前あり' : '名前なし') + ' / ' + (inputR.authorPhoto ? 'アイコンあり' : 'アイコンなし') });
            var ph = inputR.inputField && inputR.inputField.liveChatTextInputFieldRenderer;
            if (ph) r.notes.push({ name: '入力欄の案内文・文字数の上限', value: (textOf(ph.placeholder) || '-').slice(0, 60) + ' / ' + (ph.maxCharacterLength || '-') });
        }

        /* 今の取得エンジンだけで params を得られるか（watch ページ・get_live_chat の応答） */
        try {
            var wres = await fetch('/watch?v=' + vid, { credentials: 'include' });
            var wd = wres.ok ? initialData(await wres.text()) : null;
            var wl = wd && wd.contents && wd.contents.twoColumnWatchNextResults && wd.contents.twoColumnWatchNextResults.conversationBar && wd.contents.twoColumnWatchNextResults.conversationBar.liveChatRenderer;
            r.notes.push({ name: 'watch ページの liveChatRenderer に actionPanel があるか', value: wl ? (wl.actionPanel ? 'ある（' + keysOf(wl.actionPanel) + '）' : 'ない') : 'liveChatRenderer が無い' });
        } catch (e) { r.notes.push({ name: 'watch ページの liveChatRenderer に actionPanel があるか', value: '取得失敗' }); }
        var cont = firstCont(lcr);
        if (cont && c.key && c.ctx) {
            try {
                var g = await getLiveChat(c, cont);
                var lc = g.body && g.body.continuationContents && g.body.continuationContents.liveChatContinuation;
                r.notes.push({ name: 'get_live_chat の応答に actionPanel があるか', value: 'HTTP ' + g.status + ' / ' + (lc ? (lc.actionPanel ? 'ある（' + keysOf(lc.actionPanel) + '）' : 'ない') : '応答に liveChatContinuation が無い') });
            } catch (e) { r.notes.push({ name: 'get_live_chat の応答に actionPanel があるか', value: '失敗: ' + (e && e.message) }); }
        }

        S.prep = (inputR && params && c.key && c.ctx) ? { vid: vid, params: params, cfg: c, cont: cont } : null;
        var pass = r.results.filter(function (x) { return x.ok; }).length;
        r.pass = pass;
        r.verdict = pass === r.results.length ? '合格' : '不合格';
        return r;
    }

    /* ---------- D-P2: 送る（確認つき・1回） ---------- */
    async function send(text) {
        var r = { id: 'D-P2', name: '投稿（🔴 確認の窓で OK したときだけ1回送る）', results: [], pcs: [], notes: [] };
        var p = S.prep;
        text = String(text || '').trim();
        r.pcs.push({ name: '先に ▶ C1 調べる が合格している（params がある）', ok: !!p, value: p ? '動画 ' + p.vid : 'まだ / 不合格' });
        r.pcs.push({ name: '本文がある（' + MAX_LEN + '字まで）', ok: !!text && text.length <= MAX_LEN, value: text.length + '字' });
        var wait = COOLDOWN_MS - (Date.now() - S.lastSendAt);
        r.pcs.push({ name: '前回の送信から15秒たった（二重送信の防止）', ok: wait <= 0, value: wait > 0 ? 'あと ' + Math.ceil(wait / 1000) + '秒' : 'ok' });
        if (!r.pcs.every(function (x) { return x.ok; })) { r.verdict = '判定不能'; return r; }
        var yes = window.confirm('次の本文を、動画 ' + p.vid + ' のライブチャットに投稿します。\n取り消せません（あとで YouTube のチャットの ⋮ → 削除 で消せます）。\n\n「' + text + '」\n\n投稿しますか？');
        r.pcs.push({ name: '確認の窓で「OK」を選んだ', ok: yes, value: yes ? 'OK' : '取りやめ' });
        if (!yes) { r.verdict = '判定不能'; return r; }

        S.lastSendAt = Date.now();
        var hh = await headers(p.cfg);
        var body = { context: p.cfg.ctx, params: p.params, richMessage: { textSegments: [{ text: text }] }, clientMessageId: 'c1' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) };
        var t0 = performance.now(), res = null, j = null, err = null;
        try {
            res = await fetch('/youtubei/v1/live_chat/send_message?key=' + encodeURIComponent(p.cfg.key) + '&prettyPrint=false',
                { method: 'POST', credentials: 'include', headers: hh.h, body: JSON.stringify(body) });
            try { j = await res.json(); } catch (e) { j = null; }
        } catch (e) { err = e; }
        r.notes.push({ name: '送るのにかかった時間', value: Math.round(performance.now() - t0) + 'ms' });
        r.results.push({ name: '🔴 HTTP 200 が返った', ok: !!(res && res.status === 200), actual: res ? String(res.status) : ('失敗: ' + (err && err.message)), expected: '200' });
        r.notes.push({ name: '応答の一番上の名前', value: keysOf(j) });
        var acts = (j && j.actions) || [];
        r.notes.push({ name: '応答の actions の種類', value: acts.map(function (a) { return Object.keys(a)[0]; }).join(',') || '(なし)' });
        var echo = null;
        acts.forEach(function (a) { var it = a.addChatItemAction && a.addChatItemAction.item; var m = it && it.liveChatTextMessageRenderer; if (m && !echo) echo = textOf(m.message); });
        r.notes.push({ name: '応答に送った本文が返ったか（addChatItemAction）', value: echo === null ? '返らない' : (echo === text ? '一致' : '違う本文') });
        if (j && j.error) r.notes.push({ name: '応答のエラー', value: String(j.error.code) + ' ' + String(j.error.status || '') + ' ' + String(j.error.message || '').slice(0, 100) });

        /* チャットに出たか（最大3回・5秒ごと） */
        var seen = false, tries = 0, cont = p.cont;
        if (res && res.status === 200 && cont) {
            for (tries = 1; tries <= 3 && !seen; tries++) {
                await sleep(5000);
                try {
                    var g = await getLiveChat(p.cfg, cont);
                    var ct = chatTexts(g.body);
                    if (ct.texts.indexOf(text) >= 0) seen = true;
                    if (ct.next) cont = ct.next;
                } catch (e) { }
            }
            tries--;
        }
        r.results.push({ name: '🔴 チャットの流れ（get_live_chat）に送った本文が出た', ok: seen, actual: seen ? '出た（' + tries + '回目）' : (res && res.status === 200 ? '3回読んでも出ない' : '送れていない'), expected: '出た' });
        var pass = r.results.filter(function (x) { return x.ok; }).length;
        r.pass = pass;
        r.verdict = pass === r.results.length ? '合格' : '不合格';
        return r;
    }

    /* ---------- 出力（debug_suite.js と同じ書式） ---------- */
    function toMarkdown() {
        var L = [];
        L.push('### スパイク C1 計測結果（ライブへのコメント投稿）');
        L.push('');
        L.push('## 1. 事実');
        L.push('');
        L.push('- debug_suite: `' + SNIP_VERSION + '` / APP_VERSION: `(YouTube のページ)`');
        L.push('- 実行日時: ' + new Date().toISOString());
        L.push('- 場所: `' + location.origin + location.pathname + '`');
        L.push('- UA: `' + navigator.userAgent + '`');
        L.push('');
        L.push('| テスト | 判定 | 合格/項目数 | PC |');
        L.push('| :--- | :--: | ---: | :--- |');
        S.reports.forEach(function (r) {
            var pcOk = r.pcs.filter(function (p) { return p.ok; }).length;
            L.push('| ' + r.id + ' ' + r.name + ' | ' + (r.verdict === '合格' ? '⚪' : (r.verdict === '不合格' ? '❌' : '⚠️')) + ' ' + r.verdict
                + ' | ' + (r.pass || 0) + '/' + r.results.length + ' | ' + (pcOk === r.pcs.length ? '全' + pcOk + '件成立' : pcOk + '/' + r.pcs.length + '成立') + ' |');
        });
        S.reports.forEach(function (r) {
            L.push('');
            L.push('#### ' + r.id + ' ' + r.name);
            L.push('');
            L.push('| 種別 | 項目 | 実測 | 期待 | 判定 |');
            L.push('| :--- | :--- | :--- | :--- | :--: |');
            r.pcs.forEach(function (p) { L.push('| PC | ' + p.name + ' | ' + p.value + ' | 成立すること | ' + (p.ok ? '⚪' : '❌') + ' |'); });
            r.results.forEach(function (x) { L.push('| 判定 | ' + x.name + ' | ' + x.actual + ' | ' + x.expected + ' | ' + (x.ok ? '⚪' : '❌') + ' |'); });
            r.notes.forEach(function (n) { L.push('| 観測 | ' + n.name + ' | ' + n.value + ' | （期待値なし） | ─ |'); });
        });
        L.push('');
        L.push('## 3. 生データJSON');
        L.push('');
        L.push('```json');
        L.push(JSON.stringify({ snippet: SNIP_VERSION, report: S.reports }, null, 1));
        L.push('```');
        return L.join('\n');
    }

    /* ---------- パネル ---------- */
    function mk(tag, text, css) { var e = document.createElement(tag); if (text) e.textContent = text; if (css) e.style.cssText = css; return e; }
    var panel = mk('div', '', 'position:fixed;right:8px;top:64px;z-index:2147483647;background:rgba(0,0,0,.9);color:#fff;border:1px solid #0fc;'
        + 'border-radius:6px;padding:8px 10px;font:13px/1.5 sans-serif;width:320px;');
    var status = mk('div', '', 'margin:4px 0;font-weight:bold;');
    var inVid = mk('input', '', 'width:100%;box-sizing:border-box;margin:2px 0;padding:3px;color:#000;');
    inVid.placeholder = 'ライブの URL か動画 ID';
    var m0 = location.href.match(/[?&]v=([A-Za-z0-9_-]{11})/); if (m0) inVid.value = m0[1];
    var bProbe = mk('button', '▶ C1 調べる（送らない）', 'margin:2px 0;padding:2px 6px;cursor:pointer;');
    var inText = mk('input', '', 'width:100%;box-sizing:border-box;margin:6px 0 2px;padding:3px;color:#000;');
    inText.placeholder = '投稿する本文（200字まで）'; inText.maxLength = MAX_LEN;
    var bSend = mk('button', '▶ C2 送る（確認あり・1回）', 'margin:2px 0;padding:2px 6px;cursor:pointer;');
    var bCopy = mk('button', '📋 コピー', 'margin:2px;padding:2px 6px;cursor:pointer;');
    var bClose = mk('button', '×', 'margin:2px;padding:2px 6px;cursor:pointer;');
    panel.appendChild(mk('div', 'スパイク C1（' + SNIP_VERSION + '）', 'color:#0fc;font-weight:bold;'));
    panel.appendChild(status); panel.appendChild(inVid); panel.appendChild(bProbe);
    panel.appendChild(inText); panel.appendChild(bSend);
    panel.appendChild(mk('div', '', 'height:4px;')); panel.appendChild(bCopy); panel.appendChild(bClose);
    document.body.appendChild(panel);
    S.panel = panel;
    function setStatus(t, hot) { status.textContent = t; status.style.color = hot ? '#ff0' : '#fff'; }
    setStatus('動画を入れて ▶ C1 調べる');

    async function run(fn) {
        if (S.running) return;
        S.running = true; bProbe.disabled = bSend.disabled = true;
        try {
            var r = await fn();
            S.reports = S.reports.filter(function (x) { return x.id !== r.id; });
            S.reports.push(r);
            setStatus(r.id + ': ' + r.verdict + '（' + (r.pass || 0) + '/' + r.results.length + '）。📋 で結果をコピー', r.verdict !== '合格');
        } catch (e) {
            setStatus('⚠ 失敗: ' + (e && e.message ? e.message : e), true);
        } finally {
            S.running = false; bProbe.disabled = bSend.disabled = false;
        }
    }
    bProbe.onclick = function () { setStatus('調べています…（送りません）'); run(function () { return probe(inVid.value); }); };
    bSend.onclick = function () { setStatus('送っています…'); run(function () { return send(inText.value); }); };
    bCopy.onclick = function () {
        var md = toMarkdown();
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = md; document.body.appendChild(ta); ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { }
            ta.remove();
            setStatus(ok ? 'コピーしました（予備の方法）' : '⚠ コピーできません。コンソールで copy(__postSpike.md()) と打って Enter', !ok);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(md).then(function () { setStatus('コピーしました', false); }, fallback);
        } else fallback();
    };
    bClose.onclick = function () { if (!S.running) panel.remove(); };
    S.md = toMarkdown;
    S._t = { videoIdOf: videoIdOf, initialData: initialData, chatTexts: chatTexts };
    console.log('[スパイク C1] パネルを出しました（画面の右上）。');
})();

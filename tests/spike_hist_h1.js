/* ============================================================
   スパイク H1: YouTube の視聴履歴を読めるか（版数を切らない・本番コードもアドオンも変えない）
   🔴 https://www.youtube.com/ のどのページでもよい。コンソールの実行先は「Top」のまま貼る。
   画面の右上に小さなパネルが出る。
     ▶ Q1 履歴を読む   … 視聴履歴（FEhistory）を2ページぶん読み、形と件数を調べる（🔴 読むだけ）
     ▶ Q2 位置を調べる … 入れた2本の動画が履歴の何番目にあるかを調べる（🔴 読むだけ）
   🔴 履歴は個人の情報。出力には動画のタイトル・ID・チャンネル名を載せない（件数・形・入れた2本の位置だけ）。
   🔴 Cookie の値・ハッシュも載せない。innerHTML は使わない（YouTube は文字列での HTML の書き込みを禁じている）。
   ============================================================ */
(function () {
    'use strict';
    var SNIP_VERSION = 'hist-h1-1.0.0';
    var ORIGIN = 'https://www.youtube.com';
    var AUTH_COOKIE_NAMES = ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'];

    if (location.origin !== ORIGIN || window.top !== window) {
        console.warn('[スパイク H1] ここは ' + location.href + ' です。https://www.youtube.com/ のページで、コンソールの実行先を「Top」にして貼ってください。');
        return;
    }
    if (window.__histSpike && window.__histSpike.panel) { try { window.__histSpike.panel.remove(); } catch (e) { } }
    var S = window.__histSpike = { reports: [], running: false, pages: null };

    /* ---------- 共通 ---------- */
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
            if (json) { try { var d = JSON.parse(json); if (d && (d.contents || d.continuationContents || d.onResponseReceivedActions)) return d; } catch (e) { } }
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
    /* 取得エンジン（chat_fetcher_main.js の buildAuthHeaders）と同じ作り方。値は出力に載せない */
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
        if (typeof t === 'string') return t;
        if (t.content) return String(t.content);
        if (t.simpleText) return t.simpleText;
        if (t.runs) return t.runs.map(function (r) { return r.text || ''; }).join('');
        return '';
    }
    function has(o, key) {   /* o の中のどこかに key があるか（深さ12まで） */
        var stack = [[o, 0]];
        while (stack.length) {
            var top = stack.pop(), v = top[0], d = top[1];
            if (!v || typeof v !== 'object' || d > 12) continue;
            if (Object.prototype.hasOwnProperty.call(v, key)) return true;
            for (var k in v) if (v[k] && typeof v[k] === 'object') stack.push([v[k], d + 1]);
        }
        return false;
    }
    function dig(o, path) { var v = o; for (var i = 0; i < path.length; i++) { if (!v) return undefined; v = v[path[i]]; } return v; }

    /* 応答の中から動画の項目を拾う。🔴 タイトルや ID は返り値に入れるが、出力には載せない */
    var ITEM_KEYS = ['videoRenderer', 'lockupViewModel', 'shortsLockupViewModel', 'reelItemRenderer', 'compactVideoRenderer', 'gridVideoRenderer'];
    function extract(root) {
        var out = { items: [], renderers: {}, sections: 0, headers: [], cont: null };
        var stack = [root];
        while (stack.length) {
            var v = stack.pop();
            if (!v || typeof v !== 'object') continue;
            if (Array.isArray(v)) { for (var a = v.length - 1; a >= 0; a--) stack.push(v[a]); continue; }
            var hit = null;
            for (var i = 0; i < ITEM_KEYS.length; i++) if (v[ITEM_KEYS[i]]) { hit = ITEM_KEYS[i]; break; }
            if (hit) {
                var o = v[hit], it = { kind: hit, id: null, title: '', thumb: false, channel: false, duration: false, progress: false };
                if (hit === 'videoRenderer' || hit === 'compactVideoRenderer' || hit === 'gridVideoRenderer') {
                    it.id = o.videoId || null; it.title = textOf(o.title); it.thumb = !!o.thumbnail;
                    it.channel = !!(o.ownerText || o.shortBylineText || o.longBylineText); it.duration = !!o.lengthText;
                    it.progress = has(o, 'thumbnailOverlayResumePlaybackRenderer');
                } else if (hit === 'lockupViewModel') {
                    if (o.contentType && o.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') { out.renderers['lockupViewModel(' + o.contentType + ')'] = (out.renderers['lockupViewModel(' + o.contentType + ')'] || 0) + 1; continue; }
                    it.id = o.contentId || null; it.title = textOf(dig(o, ['metadata', 'lockupMetadataViewModel', 'title']));
                    it.thumb = !!o.contentImage; it.channel = has(o, 'metadataRows');
                    it.duration = has(o, 'thumbnailBadgeViewModel') || has(o, 'thumbnailOverlayBadgeViewModel');
                    it.progress = has(o, 'thumbnailOverlayProgressBarViewModel') || has(o, 'thumbnailOverlayResumePlaybackRenderer');
                } else if (hit === 'shortsLockupViewModel') {
                    it.id = dig(o, ['onTap', 'innertubeCommand', 'reelWatchEndpoint', 'videoId']) || null;
                    if (!it.id && o.entityId) { var em = String(o.entityId).match(/([A-Za-z0-9_-]{11})$/); if (em) it.id = em[1]; }
                    it.title = textOf(dig(o, ['overlayMetadata', 'primaryText'])); it.thumb = !!o.thumbnail;
                } else if (hit === 'reelItemRenderer') {
                    it.id = o.videoId || null; it.title = textOf(o.headline); it.thumb = !!o.thumbnail;
                }
                out.renderers[hit] = (out.renderers[hit] || 0) + 1;
                out.items.push(it);
                continue;   /* 項目の中は下りない（数え直しを防ぐ） */
            }
            if (v.itemSectionRenderer) {
                out.sections++;
                var ht = textOf(dig(v.itemSectionRenderer, ['header', 'itemSectionHeaderRenderer', 'title']));
                if (ht && out.headers.length < 6) out.headers.push(ht);
            }
            var tok = dig(v, ['continuationItemRenderer', 'continuationEndpoint', 'continuationCommand', 'token']);
            if (tok && !out.cont) out.cont = tok;
            /* 🔴 画面の並び順を保つ（後ろから積むと先頭から取り出せる）。位置（何番目）を数えるので順番が大事 */
            var ks = Object.keys(v);
            for (var q = ks.length - 1; q >= 0; q--) if (v[ks[q]] && typeof v[ks[q]] === 'object') stack.push(v[ks[q]]);
        }
        return out;
    }
    async function browse(c, body) {
        var hh = await headers(c);
        var t0 = performance.now(), res = null, j = null, size = 0;
        res = await fetch('/youtubei/v1/browse?' + (c.key ? 'key=' + encodeURIComponent(c.key) + '&' : '') + 'prettyPrint=false',
            { method: 'POST', credentials: 'include', headers: hh.h, body: JSON.stringify(Object.assign({ context: c.ctx }, body)) });
        var txt = await res.text(); size = txt.length;
        try { j = JSON.parse(txt); } catch (e) { j = null; }
        return { status: res.status, body: j, ms: Math.round(performance.now() - t0), kb: Math.round(size / 1024), info: hh.info };
    }
    function pct(n, d) { return d ? n + '/' + d : '0/0'; }
    function fieldStat(items) {
        var n = items.length, f = function (k) { return items.filter(function (x) { return x[k]; }).length; };
        return 'ID ' + pct(items.filter(function (x) { return x.id; }).length, n) + ' / タイトル ' + pct(items.filter(function (x) { return x.title; }).length, n)
            + ' / サムネ ' + pct(f('thumb'), n) + ' / チャンネル ' + pct(f('channel'), n) + ' / 長さ ' + pct(f('duration'), n) + ' / 再生位置の印 ' + pct(f('progress'), n);
    }
    function renderersText(r) { var k = Object.keys(r); return k.length ? k.map(function (x) { return x + '×' + r[x]; }).join(' / ') : '(なし)'; }

    /* ---------- D-Q1: 履歴を読む（読むだけ） ---------- */
    async function readHistory() {
        var r = { id: 'D-Q1', name: '視聴履歴を読む（🔴 読むだけ・タイトルと ID は載せない）', results: [], pcs: [], notes: [] };
        var c = cfg();
        var hit = pickAuthCookie();
        r.pcs.push({ name: 'ここは www.youtube.com のページ（実行先が Top）', ok: true, value: location.origin + location.pathname });
        r.pcs.push({ name: 'キーと文脈（INNERTUBE_API_KEY / CONTEXT）がある', ok: !!(c.key && c.ctx), value: (c.key && c.ctx) ? 'ok' : '無い（YouTube のページを開き直してから貼る）' });
        r.pcs.push({ name: '🔴 ログイン済み（認証用の Cookie がある）', ok: !!hit, value: hit ? 'あり（' + hit.name + '）' : 'なし' });
        r.notes.push({ name: 'ytcfg の LOGGED_IN / SESSION_INDEX / ブランドアカウント（DELEGATED_SESSION_ID）', value: String(c.loggedIn) + ' / ' + String(c.sessionIndex) + ' / ' + (c.delegated ? 'あり' : 'なし') });
        if (!(c.key && c.ctx)) { r.verdict = '判定不能'; return r; }

        var p1 = null;
        try { p1 = await browse(c, { browseId: 'FEhistory' }); } catch (e) { r.notes.push({ name: 'browse（FEhistory）', value: '失敗: ' + (e && e.message) }); }
        var e1 = p1 && p1.body ? extract(p1.body) : { items: [], renderers: {}, sections: 0, headers: [], cont: null };
        if (p1) {
            r.notes.push({ name: 'browse（FEhistory）の HTTP・時間・大きさ', value: p1.status + ' / ' + p1.ms + 'ms / ' + p1.kb + 'KB' });
            r.notes.push({ name: '応答の一番上の名前', value: keysOf(p1.body) });
            r.notes.push({ name: 'contents の下の名前', value: p1.body && p1.body.contents ? keysOf(p1.body.contents) : '(contents なし)' });
            if (!hit) r.notes.push({ name: 'ログインしていないときの応答（ログインを促す部品があるか）', value: p1.body ? (has(p1.body, 'signInEndpoint') || has(p1.body, 'feedNudgeRenderer') ? 'ある' : 'ない') : '-' });
        }
        if (!hit) { r.verdict = '判定不能'; return r; }   /* ログインしていない回は形の記録だけ */

        r.results.push({ name: '🔴 HTTP 200 が返った', ok: !!(p1 && p1.status === 200), actual: p1 ? String(p1.status) : '失敗', expected: '200' });
        r.results.push({ name: '🔴 履歴の動画の項目が1件以上ある', ok: e1.items.length > 0, actual: e1.items.length + '件', expected: '1件以上' });
        var withId = e1.items.filter(function (x) { return x.id; }).length;
        r.results.push({ name: '🔴 すべての項目から動画 ID を取れた', ok: e1.items.length > 0 && withId === e1.items.length, actual: pct(withId, e1.items.length), expected: '全件' });
        r.notes.push({ name: '1ページ目: 項目の部品と数', value: renderersText(e1.renderers) });
        r.notes.push({ name: '1ページ目: 取れる情報（件数）', value: fieldStat(e1.items) });
        r.notes.push({ name: '1ページ目: 日付の区切り（itemSectionRenderer）の数・見出し', value: e1.sections + ' / ' + (e1.headers.join('・') || '(見出しなし)') });
        r.notes.push({ name: '1ページ目: 続きの番号（continuation）', value: e1.cont ? 'あり' : 'なし' });

        var e2 = { items: [], renderers: {}, sections: 0, headers: [], cont: null };
        if (e1.cont) {
            try {
                var p2 = await browse(c, { continuation: e1.cont });
                e2 = p2.body ? extract(p2.body) : e2;
                r.notes.push({ name: '2ページ目: HTTP・時間・項目の数・部品', value: p2.status + ' / ' + p2.ms + 'ms / ' + e2.items.length + '件 / ' + renderersText(e2.renderers) });
                r.notes.push({ name: '2ページ目の応答の一番上の名前', value: keysOf(p2.body) });
            } catch (e) { r.notes.push({ name: '2ページ目', value: '失敗: ' + (e && e.message) }); }
        }
        r.results.push({ name: '続き（2ページ目）を読めた', ok: !e1.cont || e2.items.length > 0, actual: e1.cont ? (e2.items.length + '件') : '続きなし（1ページで全部）', expected: '1件以上 または 続きなし' });

        /* 予備の経路: /feed/history の HTML（ytInitialData） */
        try {
            var hres = await fetch('/feed/history', { credentials: 'include' });
            var hd = hres.ok ? initialData(await hres.text()) : null;
            var eh = hd ? extract(hd) : null;
            var same = eh && eh.items.length && e1.items.length
                ? eh.items.slice(0, 5).map(function (x) { return x.id; }).join() === e1.items.slice(0, 5).map(function (x) { return x.id; }).join() : false;
            r.notes.push({ name: '予備: /feed/history の HTML の項目の数・部品・先頭5件が browse と同じか', value: hres.status + ' / ' + (eh ? eh.items.length + '件 / ' + renderersText(eh.renderers) + ' / ' + (same ? '同じ' : '違う') : 'ytInitialData なし') });
        } catch (e) { r.notes.push({ name: '予備: /feed/history の HTML', value: '失敗: ' + (e && e.message) }); }

        var all = e1.items.concat(e2.items);
        var ids = all.map(function (x) { return x.id; }).filter(Boolean);
        var dup = ids.length - ids.filter(function (x, i) { return ids.indexOf(x) === i; }).length;
        r.notes.push({ name: '1〜2ページ目の合計・同じ動画の重複', value: all.length + '件 / 重複 ' + dup + '件' });
        S.pages = { ids: ids, at: Date.now() };
        var pass = r.results.filter(function (x) { return x.ok; }).length;
        r.pass = pass;
        r.verdict = pass === r.results.length ? '合格' : '不合格';
        return r;
    }

    /* ---------- D-Q2: 入れた2本の位置（読むだけ） ---------- */
    function posText(ids, id) { var i = ids.indexOf(id); return i >= 0 ? (i + 1) + '番目' : '1〜2ページ目に無い'; }
    async function findTwo(embedIn, siteIn) {
        var r = { id: 'D-Q2', name: '入れた2本が履歴の何番目にあるか（🔴 読むだけ）', results: [], pcs: [], notes: [] };
        var eId = videoIdOf(embedIn), sId = videoIdOf(siteIn);
        r.pcs.push({ name: '先に ▶ Q1 履歴を読む が済んでいる', ok: !!S.pages, value: S.pages ? (S.pages.ids.length + '件を読んだ') : 'まだ' });
        r.pcs.push({ name: '2本の動画 ID を読めた（このツールの枠で見た動画 / YouTube のサイトで見た動画）', ok: !!(eId && sId && eId !== sId), value: (eId || '(読めない)') + ' / ' + (sId || '(読めない)') + (eId && eId === sId ? '（同じ動画は不可）' : '') });
        if (!S.pages || !eId || !sId || eId === sId) { r.verdict = '判定不能'; return r; }
        var ids = S.pages.ids;
        /* 土俵: YouTube のサイトで見た動画は履歴に載るはず（載らなければ、履歴が止まっている・反映待ちなど） */
        r.pcs.push({ name: '🔴 YouTube のサイトで見た動画が履歴にある（測れる土俵）', ok: ids.indexOf(sId) >= 0, value: posText(ids, sId) });
        r.notes.push({ name: '🔴 このツールの枠（埋め込み）で見た動画の位置', value: posText(ids, eId) });
        r.results.push({ name: '2本とも履歴の中を探し終えた', ok: true, actual: '探した（' + ids.length + '件）', expected: '探した' });
        r.pass = 1;
        r.verdict = r.pcs.every(function (p) { return p.ok; }) ? '合格' : '判定不能';
        return r;
    }

    /* ---------- 出力（debug_suite.js と同じ書式） ---------- */
    function toMarkdown() {
        var L = [];
        L.push('### スパイク H1 計測結果（YouTube の視聴履歴）');
        L.push('');
        L.push('## 1. 事実');
        L.push('');
        L.push('- debug_suite: `' + SNIP_VERSION + '` / APP_VERSION: `(YouTube のページ)`');
        L.push('- 実行日時: ' + new Date().toISOString());
        L.push('- 場所: `' + location.origin + location.pathname + '`');
        L.push('- UA: `' + navigator.userAgent + '`');
        L.push('- 🔴 履歴の動画のタイトル・ID・チャンネル名は載せていない（件数・形・入れた2本の位置だけ）');
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
    var bRead = mk('button', '▶ Q1 履歴を読む', 'margin:2px 0;padding:2px 6px;cursor:pointer;');
    var inEmbed = mk('input', '', 'width:100%;box-sizing:border-box;margin:6px 0 2px;padding:3px;color:#000;');
    inEmbed.placeholder = '① このツールの枠で見た動画の URL か ID';
    var inSite = mk('input', '', 'width:100%;box-sizing:border-box;margin:2px 0;padding:3px;color:#000;');
    inSite.placeholder = '② YouTube のサイトで見た動画の URL か ID';
    var bFind = mk('button', '▶ Q2 位置を調べる', 'margin:2px 0;padding:2px 6px;cursor:pointer;');
    var bCopy = mk('button', '📋 コピー', 'margin:2px;padding:2px 6px;cursor:pointer;');
    var bClose = mk('button', '×', 'margin:2px;padding:2px 6px;cursor:pointer;');
    panel.appendChild(mk('div', 'スパイク H1（' + SNIP_VERSION + '）', 'color:#0fc;font-weight:bold;'));
    panel.appendChild(status); panel.appendChild(bRead);
    panel.appendChild(inEmbed); panel.appendChild(inSite); panel.appendChild(bFind);
    panel.appendChild(mk('div', '', 'height:4px;')); panel.appendChild(bCopy); panel.appendChild(bClose);
    document.body.appendChild(panel);
    S.panel = panel;
    function setStatus(t, hot) { status.textContent = t; status.style.color = hot ? '#ff0' : '#fff'; }
    setStatus('▶ Q1 履歴を読む を押す');

    async function run(fn) {
        if (S.running) return;
        S.running = true; bRead.disabled = bFind.disabled = true;
        try {
            var r = await fn();
            S.reports = S.reports.filter(function (x) { return x.id !== r.id; });
            S.reports.push(r);
            setStatus(r.id + ': ' + r.verdict + '（' + (r.pass || 0) + '/' + r.results.length + '）。📋 で結果をコピー', r.verdict !== '合格');
        } catch (e) {
            setStatus('⚠ 失敗: ' + (e && e.message ? e.message : e), true);
        } finally {
            S.running = false; bRead.disabled = bFind.disabled = false;
        }
    }
    bRead.onclick = function () { setStatus('読んでいます…'); run(readHistory); };
    bFind.onclick = function () { setStatus('調べています…'); run(function () { return findTwo(inEmbed.value, inSite.value); }); };
    bCopy.onclick = function () {
        var md = toMarkdown();
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = md; document.body.appendChild(ta); ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { }
            ta.remove();
            setStatus(ok ? 'コピーしました（予備の方法）' : '⚠ コピーできません。コンソールで copy(__histSpike.md()) と打って Enter', !ok);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(md).then(function () { setStatus('コピーしました', false); }, fallback);
        } else fallback();
    };
    bClose.onclick = function () { if (!S.running) panel.remove(); };
    S.md = toMarkdown;
    S._t = { videoIdOf: videoIdOf, extract: extract, initialData: initialData };
    console.log('[スパイク H1] パネルを出しました（画面の右上）。');
})();

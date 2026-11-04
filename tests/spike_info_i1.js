/* ============================================================
   スパイク I1: 動画の概要欄とコメント欄を読めるか（版数を切らない・本番コードもアドオンも変えない）
   🔴 https://www.youtube.com/watch?v=… のページで、コンソールの実行先は「Top」のまま貼る。
   画面の右上に小さなパネルが出る。
     ▶ J1 概要欄を読む   … next / player を読み、概要欄の本文・リンクの種類・位置を調べる（🔴 読むだけ）
     ▶ J2 コメントを読む … コメントの1ページ目・2ページ目・新しい順・返信を読み、形と件数を調べる（🔴 読むだけ・書き込まない）
   🔴 出力には本文・投稿者名・リンク先を載せない（件数・種類・形だけ）。Cookie の値・ハッシュも載せない。
   🔴 innerHTML は使わない（YouTube は文字列での HTML の書き込みを禁じている）。
   ============================================================ */
(function () {
    'use strict';
    var SNIP_VERSION = 'info-i1-1.1.0';   /* 1.1.0: 返信の置き場所を探す（名前だけ・2026-11-04） */
    var ORIGIN = 'https://www.youtube.com';
    var AUTH_COOKIE_NAMES = ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'];

    if (location.origin !== ORIGIN || window.top !== window) {
        console.warn('[スパイク I1] ここは ' + location.href + ' です。https://www.youtube.com/watch?v=… のページで、コンソールの実行先を「Top」にして貼ってください。');
        return;
    }
    if (window.__infoSpike && window.__infoSpike.panel) { try { window.__infoSpike.panel.remove(); } catch (e) { } }
    var S = window.__infoSpike = { reports: [], running: false, next: null, vid: null };

    /* ---------- 共通 ---------- */
    function videoIdOf(s) {
        s = String(s || '').trim();
        var m = s.match(/(?:v=|youtu\.be\/|\/live\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
        if (m) return m[1];
        return /^[A-Za-z0-9_-]{11}$/.test(s) ? s : null;
    }
    function cfg() {
        var y = window.ytcfg && window.ytcfg.get ? window.ytcfg : null;
        var g = function (k) { try { return y ? y.get(k) : undefined; } catch (e) { return undefined; } };
        return {
            key: g('INNERTUBE_API_KEY'), ctx: g('INNERTUBE_CONTEXT'),
            clientName: g('INNERTUBE_CONTEXT_CLIENT_NAME'), clientVersion: g('INNERTUBE_CONTEXT_CLIENT_VERSION'),
            sessionIndex: g('SESSION_INDEX'), loggedIn: g('LOGGED_IN')
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
    /* 取得エンジン（chat_fetcher_main.js の buildAuthHeaders）と同じ作り方。anon なら認証なし・Cookie も送らない */
    async function headers(c, anon) {
        var h = { 'content-type': 'application/json' };
        var hit = anon ? null : pickAuthCookie();
        if (hit) {
            var sec = Math.floor(Date.now() / 1000);
            h['Authorization'] = 'SAPISIDHASH ' + sec + '_' + (await sha1Hex(sec + ' ' + hit.value + ' ' + ORIGIN));
            h['X-Origin'] = ORIGIN;
            h['X-Goog-AuthUser'] = '0';
        }
        return h;
    }
    async function api(path, c, body, anon) {
        var t0 = performance.now(), res, txt = '', j = null;
        res = await fetch('/youtubei/v1/' + path + '?' + (c.key ? 'key=' + encodeURIComponent(c.key) + '&' : '') + 'prettyPrint=false',
            { method: 'POST', credentials: anon ? 'omit' : 'include', headers: await headers(c, anon), body: JSON.stringify(Object.assign({ context: c.ctx }, body)) });
        txt = await res.text();
        try { j = JSON.parse(txt); } catch (e) { j = null; }
        return { status: res.status, body: j, ms: Math.round(performance.now() - t0), kb: Math.round(txt.length / 1024) };
    }
    function keysOf(o) { return (o && typeof o === 'object') ? Object.keys(o).join(',') : '(なし)'; }
    function dig(o, path) { var v = o; for (var i = 0; i < path.length; i++) { if (!v) return undefined; v = v[path[i]]; } return v; }
    /* o の中で key を持つ値をすべて集める（前から順・深さ 30 まで） */
    function findAll(o, key, max) {
        var out = [], stack = [[o, 0]];
        while (stack.length && out.length < (max || 1e9)) {
            var top = stack.shift(), v = top[0], d = top[1];
            if (!v || typeof v !== 'object' || d > 30) continue;
            if (Object.prototype.hasOwnProperty.call(v, key)) out.push(v[key]);
            for (var k in v) if (v[k] && typeof v[k] === 'object') stack.push([v[k], d + 1]);
        }
        return out;
    }
    function findOne(o, key) { var a = findAll(o, key, 1); return a.length ? a[0] : undefined; }
    function tally(arr) { var t = {}; arr.forEach(function (k) { t[k] = (t[k] || 0) + 1; }); var ks = Object.keys(t); return ks.length ? ks.map(function (k) { return k + '×' + t[k]; }).join(' / ') : '(なし)'; }

    /* リンク（commandRuns の1つ）の種類。🔴 リンク先そのものは返さない */
    function runKind(r, vid) {
        var cmd = dig(r, ['onTap', 'innertubeCommand']) || {};
        if (cmd.watchEndpoint) {
            var w = cmd.watchEndpoint, t = (typeof w.startTimeSeconds === 'number');
            if (w.videoId === vid) return t ? '時刻（この動画）' : 'この動画（時刻なし）';
            return t ? '別の動画＋時刻' : '別の動画';
        }
        if (cmd.reelWatchEndpoint) return 'ショート';
        if (cmd.urlEndpoint) {
            var u = String(cmd.urlEndpoint.url || '');
            if (/^https?:\/\/(www\.)?youtube\.com\/redirect/.test(u)) return '外部（youtube.com/redirect 経由）';
            if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(u)) return 'YouTube 内の URL';
            if (/^\//.test(u)) return 'YouTube 内のパス';
            return '外部（直接）';
        }
        if (cmd.browseEndpoint) {
            var b = String(cmd.browseEndpoint.browseId || '');
            if (/^UC/.test(b)) return 'チャンネル';
            if (b === 'FEhashtag') return 'ハッシュタグ';
            return 'browse（' + b.slice(0, 2) + '…）';
        }
        var ks = Object.keys(cmd).filter(function (k) { return k !== 'clickTrackingParams' && k !== 'commandMetadata'; });
        return ks.length ? ks[0] : '(onTap なし)';
    }
    /* 本文と runs の位置の整合（startIndex + length が本文の長さに収まる） */
    function rangesOk(content, runs) {
        var n = String(content || '').length;
        return runs.filter(function (r) { return typeof r.startIndex === 'number' && typeof r.length === 'number' && r.startIndex >= 0 && r.startIndex + r.length <= n; }).length;
    }

    /* ---------- D-J1: 概要欄 ---------- */
    async function readDesc(input) {
        var r = { id: 'D-J1', name: '概要欄を読む（🔴 本文・リンク先は載せない）', results: [], pcs: [], notes: [] };
        var c = cfg(), vid = videoIdOf(input) || videoIdOf(location.href);
        r.pcs.push({ name: 'キーと文脈（INNERTUBE_API_KEY / CONTEXT）がある', ok: !!(c.key && c.ctx), value: (c.key && c.ctx) ? 'ok' : '無い（YouTube のページを開き直してから貼る）' });
        r.pcs.push({ name: '動画 ID を読めた（欄が空ならこのページの動画）', ok: !!vid, value: vid || '(読めない)' });
        r.notes.push({ name: 'ログイン（認証用の Cookie）', value: pickAuthCookie() ? 'あり' : 'なし' });
        if (!(c.key && c.ctx) || !vid) { r.verdict = '判定不能'; return r; }
        S.vid = vid;
        var nx = await api('next', c, { videoId: vid });
        S.next = nx.body;
        r.notes.push({ name: 'next の HTTP・時間・大きさ', value: nx.status + ' / ' + nx.ms + 'ms / ' + nx.kb + 'KB' });
        r.results.push({ name: 'next が読める（HTTP 200）', ok: nx.status === 200 && !!nx.body, actual: String(nx.status), expected: '200' });
        if (!nx.body) { r.pass = r.results.filter(function (x) { return x.ok; }).length; r.verdict = '不合格'; return r; }
        /* 置き場所の候補（新しい順に） */
        var cands = [
            ['videoSecondaryInfoRenderer.attributedDescription', dig(findOne(nx.body, 'videoSecondaryInfoRenderer'), ['attributedDescription'])],
            ['expandableVideoDescriptionBodyRenderer.attributedDescriptionBodyText', dig(findOne(nx.body, 'expandableVideoDescriptionBodyRenderer'), ['attributedDescriptionBodyText'])],
            ['videoSecondaryInfoRenderer.description（runs の古い形）', dig(findOne(nx.body, 'videoSecondaryInfoRenderer'), ['description'])]
        ];
        r.notes.push({ name: '本文の置き場所（あり / なし）', value: cands.map(function (x) { return x[0] + '=' + (x[1] ? 'あり' : 'なし'); }).join(' / ') });
        var ad = cands[0][1] || cands[1][1];
        var content = ad ? String(ad.content || '') : '';
        var runs = (ad && Array.isArray(ad.commandRuns)) ? ad.commandRuns : [];
        r.notes.push({ name: '本文の長さ / 行数', value: content.length + '字 / ' + (content ? content.split('\n').length : 0) + '行' });
        r.notes.push({ name: 'commandRuns / styleRuns / attachmentRuns の数', value: runs.length + ' / ' + (ad && ad.styleRuns ? ad.styleRuns.length : 0) + ' / ' + (ad && ad.attachmentRuns ? ad.attachmentRuns.length : 0) });
        r.notes.push({ name: '🔴 リンクの種類', value: tally(runs.map(function (x) { return runKind(x, vid); })) });
        r.notes.push({ name: 'リンクの onTap 以外の形（commandRuns の中の名前）', value: tally(runs.map(function (x) { return keysOf(x); })) });
        r.results.push({ name: '🔴 概要欄の本文がある（attributedDescription）', ok: !!ad, actual: ad ? 'ある' : '無い', expected: 'ある' });
        r.results.push({ name: 'リンクの位置が本文の中に収まる（startIndex + length）', ok: rangesOk(content, runs) === runs.length, actual: rangesOk(content, runs) + '/' + runs.length, expected: runs.length + '/' + runs.length });
        /* 見出しに出せるもの（純正の概要欄の上: 視聴回数・日付） */
        var vp = findOne(nx.body, 'videoPrimaryInfoRenderer');
        r.notes.push({ name: '見出しの材料（videoPrimaryInfoRenderer の title / viewCount / dateText / relativeDateText）', value: vp ? [!!vp.title, !!vp.viewCount, !!vp.dateText, !!vp.relativeDateText].map(function (b) { return b ? 'あり' : 'なし'; }).join(' / ') : '(videoPrimaryInfoRenderer なし)' });
        /* 予備: player の shortDescription（リンクの情報は無い） */
        try {
            var pl = await api('player', c, { videoId: vid });
            var sd = dig(pl.body, ['videoDetails', 'shortDescription']);
            r.notes.push({ name: '予備 player の HTTP・時間・大きさ / shortDescription の長さ', value: pl.status + ' / ' + pl.ms + 'ms / ' + pl.kb + 'KB / ' + (typeof sd === 'string' ? sd.length + '字' : '無い') });
            r.notes.push({ name: 'shortDescription と attributedDescription の長さが同じ', value: (typeof sd === 'string' && ad) ? (sd.length === content.length ? '同じ' : '違う（' + sd.length + ' / ' + content.length + '）') : '-' });
        } catch (e) { r.notes.push({ name: '予備 player', value: '失敗: ' + (e && e.message) }); }
        /* ログインなし（Cookie を送らない）でも読めるか */
        try {
            var an = await api('next', c, { videoId: vid }, true);
            var ad2 = an.body ? (dig(findOne(an.body, 'videoSecondaryInfoRenderer'), ['attributedDescription']) || dig(findOne(an.body, 'expandableVideoDescriptionBodyRenderer'), ['attributedDescriptionBodyText'])) : null;
            r.notes.push({ name: 'ログインなし（Cookie を送らない）の next / 本文', value: an.status + ' / ' + (ad2 ? 'ある（' + String(ad2.content || '').length + '字）' : '無い') });
        } catch (e) { r.notes.push({ name: 'ログインなしの next', value: '失敗: ' + (e && e.message) }); }
        r.pass = r.results.filter(function (x) { return x.ok; }).length;
        r.verdict = r.pcs.every(function (p) { return p.ok; }) ? (r.pass === r.results.length ? '合格' : '不合格') : '判定不能';
        return r;
    }

    /* ---------- D-J2: コメント ---------- */
    function commentToken(nextBody) {
        /* ① 動画の下の欄（sectionIdentifier = comment-item-section） ② コメントの引き出し（engagement-panel-comments-section） */
        var secs = findAll(nextBody, 'itemSectionRenderer');
        for (var i = 0; i < secs.length; i++) {
            if (secs[i] && secs[i].sectionIdentifier === 'comment-item-section') {
                var t = findOne(secs[i], 'continuationCommand');
                if (t && t.token) return { token: t.token, from: 'comment-item-section' };
            }
        }
        var panels = findAll(nextBody, 'engagementPanelSectionListRenderer');
        for (var p = 0; p < panels.length; p++) {
            if (panels[p] && /comment/.test(String(panels[p].panelIdentifier || ''))) {
                var t2 = findOne(panels[p], 'continuationCommand');
                if (t2 && t2.token) return { token: t2.token, from: 'engagement-panel（' + panels[p].panelIdentifier + '）' };
            }
        }
        return null;
    }
    /* コメントの1回分の応答を数える */
    function parseComments(body, vid) {
        var o = { threads: 0, vm: 0, oldRenderer: 0, payloads: 0, withContent: 0, withAuthor: 0, withLikes: 0, withReplyCount: 0, replyTokens: 0, nextToken: null, firstReplyToken: null, runs: [], sortItems: [], countText: false, replyLevel1: 0, avatar: 0, creatorHeart: 0, pinned: 0 };
        var threads = findAll(body, 'commentThreadRenderer');
        o.threads = threads.length;
        threads.forEach(function (t) {
            if (t.commentViewModel) o.vm++;
            if (t.comment && t.comment.commentRenderer) o.oldRenderer++;
            var rt = t.replies ? findOne(t.replies, 'continuationCommand') : null;
            if (rt && rt.token) { o.replyTokens++; if (!o.firstReplyToken) o.firstReplyToken = rt.token; }
        });
        var muts = findAll(body, 'commentEntityPayload');
        o.payloads = muts.length;
        muts.forEach(function (m) {
            var pr = m.properties || {};
            if (pr.content && typeof pr.content.content === 'string') o.withContent++;
            if (pr.replyLevel === 1) o.replyLevel1++;
            if (m.author && m.author.displayName) o.withAuthor++;
            if (m.author && m.author.avatarThumbnailUrl) o.avatar++;
            if (m.toolbar && (m.toolbar.likeCountNotliked !== undefined || m.toolbar.likeCountLiked !== undefined)) o.withLikes++;
            if (m.toolbar && m.toolbar.replyCount) o.withReplyCount++;
            if (m.toolbar && m.toolbar.creatorThumbnailUrl) o.creatorHeart++;
            if (pr.content && Array.isArray(pr.content.commandRuns)) pr.content.commandRuns.forEach(function (x) { o.runs.push(runKind(x, vid)); });
        });
        o.pinned = findAll(body, 'pinnedText').length + findAll(body, 'pinnedCommentBadge').length;
        /* 次のページ: 一番上の continuationItems の末尾にある continuationItemRenderer だけ。
           🔴 findAll で探すと、スレッドの中の返信の続きを拾ってしまう */
        (body.onResponseReceivedEndpoints || []).forEach(function (ep) {
            var items = dig(ep, ['reloadContinuationItemsCommand', 'continuationItems']) || dig(ep, ['appendContinuationItemsAction', 'continuationItems']) || [];
            var last = items[items.length - 1];
            var t = last && last.continuationItemRenderer ? dig(findOne(last.continuationItemRenderer, 'continuationCommand') || {}, ['token']) : null;
            if (t) o.nextToken = t;
        });
        var sub = findOne(body, 'sortFilterSubMenuRenderer');
        if (sub && Array.isArray(sub.subMenuItems)) o.sortItems = sub.subMenuItems.map(function (x) { return { hasToken: !!dig(findOne(x, 'continuationCommand') || {}, ['token']), token: dig(findOne(x, 'continuationCommand') || {}, ['token']), selected: !!x.selected }; });
        var hdr = findOne(body, 'commentsHeaderRenderer');
        o.countText = !!(hdr && (hdr.countText || hdr.commentsCount));
        return o;
    }
    /* ★1.1.0: 名前（キー）の道筋だけを出す。値は出さない。配列は先頭だけ見る */
    function keyPaths(o, depth, prefix, out) {
        out = out || [];
        if (!o || typeof o !== 'object' || depth < 0 || out.length > 80) return out;
        if (Array.isArray(o)) { if (o.length) keyPaths(o[0], depth, prefix + '[0]', out); return out; }
        Object.keys(o).forEach(function (k) {
            if (k === 'trackingParams' || k === 'clickTrackingParams' || k === 'loggingDirectives' || k === 'accessibility') return;
            var v = o[k], p = prefix ? prefix + '.' + k : k;
            if (v && typeof v === 'object') keyPaths(v, depth - 1, p, out); else out.push(p);
        });
        return out;
    }
    /* ★1.1.0: 名前に repl / Repl を含むキーを全部数える（どこにあるかの手がかり） */
    function replKeys(o) {
        var t = {}, stack = [[o, 0]];
        while (stack.length) {
            var top = stack.pop(), v = top[0], d = top[1];
            if (!v || typeof v !== 'object' || d > 40) continue;
            for (var k in v) {
                if (/repl/i.test(k)) t[k] = (t[k] || 0) + 1;
                if (v[k] && typeof v[k] === 'object') stack.push([v[k], d + 1]);
            }
        }
        return t;
    }
    function threadsOf(body) { return findAll(body, 'commentThreadRenderer').length; }
    async function readComments() {
        var r = { id: 'D-J2', name: 'コメントを読む（🔴 本文・投稿者名は載せない・書き込まない）', results: [], pcs: [], notes: [] };
        var c = cfg(), vid = S.vid;
        r.pcs.push({ name: '先に ▶ J1 概要欄を読む が済んでいる', ok: !!S.next, value: S.next ? (vid + ' の next を読んだ') : 'まだ' });
        if (!S.next) { r.verdict = '判定不能'; return r; }
        var tk = commentToken(S.next);
        r.pcs.push({ name: '🔴 コメント欄の入り口（continuation）が next にある', ok: !!tk, value: tk ? tk.from : '無い（コメントが無効の動画・ライブ中など）' });
        if (!tk) { r.verdict = '判定不能'; return r; }
        var p1 = await api('next', c, { continuation: tk.token });
        r.notes.push({ name: '1ページ目の HTTP・時間・大きさ', value: p1.status + ' / ' + p1.ms + 'ms / ' + p1.kb + 'KB' });
        r.notes.push({ name: '1ページ目の一番上の名前', value: keysOf(p1.body) });
        var a = p1.body ? parseComments(p1.body, vid) : null;
        r.results.push({ name: '🔴 1ページ目が読める（HTTP 200・スレッドが1件以上）', ok: !!(a && p1.status === 200 && a.threads > 0), actual: p1.status + ' / ' + (a ? a.threads : 0) + '件', expected: '200 / 1件以上' });
        if (!a) { r.pass = r.results.filter(function (x) { return x.ok; }).length; r.verdict = '不合格'; return r; }
        r.notes.push({ name: 'スレッド / うち commentViewModel / 古い commentRenderer', value: a.threads + ' / ' + a.vm + ' / ' + a.oldRenderer });
        r.notes.push({ name: 'commentEntityPayload / 本文あり / 投稿者名あり / アイコンあり / 高評価数あり / 返信数あり', value: [a.payloads, a.withContent, a.withAuthor, a.avatar, a.withLikes, a.withReplyCount].join(' / ') });
        r.notes.push({ name: '返信の続き（token）があるスレッド / 固定 / 投稿者のハート', value: a.replyTokens + ' / ' + a.pinned + ' / ' + a.creatorHeart });
        r.notes.push({ name: '🔴 コメントの中のリンクの種類', value: tally(a.runs) });
        r.notes.push({ name: '見出しの件数（countText）/ 並べ替えの項目（token あり・選ばれている）', value: (a.countText ? 'あり' : 'なし') + ' / ' + (a.sortItems.length ? a.sortItems.map(function (x, i) { return (i + 1) + (x.hasToken ? ':token' : ':なし') + (x.selected ? '(選択中)' : ''); }).join(' ') : '(並べ替えなし)') });
        r.results.push({ name: '本文が全件にある（commentEntityPayload）', ok: a.payloads > 0 && a.withContent === a.payloads, actual: a.withContent + '/' + a.payloads, expected: a.payloads + '/' + a.payloads });
        r.results.push({ name: '並べ替え（人気順 / 新しい順）が2つあり token がある', ok: a.sortItems.length >= 2 && a.sortItems.every(function (x) { return x.hasToken; }), actual: a.sortItems.length + '項目', expected: '2項目以上・token あり' });
        /* 2ページ目 */
        if (a.nextToken) {
            var p2 = await api('next', c, { continuation: a.nextToken });
            r.notes.push({ name: '2ページ目の HTTP・時間・大きさ / スレッド', value: p2.status + ' / ' + p2.ms + 'ms / ' + p2.kb + 'KB / ' + (p2.body ? threadsOf(p2.body) : 0) + '件' });
            r.results.push({ name: '続き（2ページ目）が読める', ok: p2.status === 200 && !!p2.body && threadsOf(p2.body) > 0, actual: p2.status + ' / ' + (p2.body ? threadsOf(p2.body) : 0) + '件', expected: '200 / 1件以上' });
        } else r.notes.push({ name: '2ページ目', value: '続きの token なし（コメントが少ない）' });
        /* 新しい順 */
        var newest = a.sortItems[1];
        if (newest && newest.token) {
            var p3 = await api('next', c, { continuation: newest.token });
            var b3 = p3.body ? parseComments(p3.body, vid) : null;
            r.notes.push({ name: '新しい順の HTTP・時間 / スレッド / 選択中の項目', value: p3.status + ' / ' + p3.ms + 'ms / ' + (b3 ? b3.threads : 0) + '件 / ' + (b3 ? b3.sortItems.map(function (x, i) { return x.selected ? (i + 1) : ''; }).join('') : '-') });
            r.results.push({ name: '新しい順が読める', ok: !!(b3 && p3.status === 200 && b3.threads > 0), actual: p3.status + ' / ' + (b3 ? b3.threads : 0) + '件', expected: '200 / 1件以上' });
        }
        /* 返信 */
        if (a.firstReplyToken) {
            var p4 = await api('next', c, { continuation: a.firstReplyToken });
            var b4 = p4.body ? parseComments(p4.body, vid) : null;
            r.notes.push({ name: '返信の HTTP・時間 / commentEntityPayload / replyLevel 1 / スレッド', value: p4.status + ' / ' + p4.ms + 'ms / ' + (b4 ? b4.payloads + ' / ' + b4.replyLevel1 + ' / ' + b4.threads : '-') });
            r.results.push({ name: '返信が読める', ok: !!(b4 && p4.status === 200 && b4.payloads > 0), actual: p4.status + ' / ' + (b4 ? b4.payloads : 0) + '件', expected: '200 / 1件以上' });
        } else r.notes.push({ name: '返信', value: '返信のあるコメントが1ページ目に無い' });
        /* ★1.1.0: 返信の置き場所の手がかり（名前だけ） */
        var rk = replKeys(p1.body);
        r.notes.push({ name: '★ 名前に repl を含むキーと数（1ページ目全体）', value: Object.keys(rk).length ? Object.keys(rk).map(function (k) { return k + '×' + rk[k]; }).join(' / ') : '(なし)' });
        var th0 = findAll(p1.body, 'commentThreadRenderer')[0];
        r.notes.push({ name: '★ 1件目の commentThreadRenderer の道筋（深さ7）', value: th0 ? keyPaths(th0, 7, '').join(' , ') : '-' });
        var thR = findAll(p1.body, 'commentThreadRenderer').filter(function (t) { return t && t.replies; })[0];
        r.notes.push({ name: '★ replies を持つスレッドの数 / その replies の道筋（深さ9）', value: findAll(p1.body, 'commentThreadRenderer').filter(function (t) { return t && t.replies; }).length + ' / ' + (thR ? keyPaths(thR.replies, 9, 'replies').join(' , ') : '-') });
        var py0 = findAll(p1.body, 'commentEntityPayload')[0];
        r.notes.push({ name: '★ 1件目の commentEntityPayload の toolbar と properties の名前', value: py0 ? ('toolbar: ' + keysOf(py0.toolbar) + ' ／ properties: ' + keysOf(py0.properties)) : '-' });
        var mut0 = dig(p1.body, ['frameworkUpdates', 'entityBatchUpdate', 'mutations']) || [];
        r.notes.push({ name: '★ mutations の payload の種類と数', value: tally(mut0.map(function (m) { return keysOf(m && m.payload); })) });
        /* ログインなし */
        try {
            var an = await api('next', c, { continuation: tk.token }, true);
            r.notes.push({ name: 'ログインなし（Cookie を送らない）の1ページ目 / スレッド', value: an.status + ' / ' + (an.body ? threadsOf(an.body) : 0) + '件' });
        } catch (e) { r.notes.push({ name: 'ログインなしの1ページ目', value: '失敗: ' + (e && e.message) }); }
        r.pass = r.results.filter(function (x) { return x.ok; }).length;
        r.verdict = r.pcs.every(function (p) { return p.ok; }) ? (r.pass === r.results.length ? '合格' : '不合格') : '判定不能';
        return r;
    }

    /* ---------- 出力（debug_suite.js と同じ書式） ---------- */
    function toMarkdown() {
        var L = [];
        L.push('### スパイク I1 計測結果（概要欄とコメント欄）');
        L.push('');
        L.push('## 1. 事実');
        L.push('');
        L.push('- debug_suite: `' + SNIP_VERSION + '` / APP_VERSION: `(YouTube のページ)`');
        L.push('- 実行日時: ' + new Date().toISOString());
        L.push('- 場所: `' + location.origin + location.pathname + '`');
        L.push('- 動画: `' + (S.vid || '-') + '`');
        L.push('- UA: `' + navigator.userAgent + '`');
        L.push('- 🔴 本文・投稿者名・リンク先は載せていない（件数・種類・形だけ）');
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
        L.push(JSON.stringify({ snippet: SNIP_VERSION, video: S.vid, report: S.reports }, null, 1));
        L.push('```');
        return L.join('\n');
    }

    /* ---------- パネル ---------- */
    function mk(tag, text, css) { var e = document.createElement(tag); if (text) e.textContent = text; if (css) e.style.cssText = css; return e; }
    var panel = mk('div', '', 'position:fixed;right:8px;top:64px;z-index:2147483647;background:rgba(0,0,0,.9);color:#fff;border:1px solid #0fc;'
        + 'border-radius:6px;padding:8px 10px;font:13px/1.5 sans-serif;width:320px;');
    var status = mk('div', '', 'margin:4px 0;font-weight:bold;');
    var inVid = mk('input', '', 'width:100%;box-sizing:border-box;margin:6px 0 2px;padding:3px;color:#000;');
    inVid.placeholder = '動画の URL か ID（空ならこのページの動画）';
    var bDesc = mk('button', '▶ J1 概要欄を読む', 'margin:2px 0;padding:2px 6px;cursor:pointer;');
    var bCom = mk('button', '▶ J2 コメントを読む', 'margin:2px 0;padding:2px 6px;cursor:pointer;');
    var bCopy = mk('button', '📋 コピー', 'margin:2px;padding:2px 6px;cursor:pointer;');
    var bClose = mk('button', '×', 'margin:2px;padding:2px 6px;cursor:pointer;');
    panel.appendChild(mk('div', 'スパイク I1（' + SNIP_VERSION + '）', 'color:#0fc;font-weight:bold;'));
    panel.appendChild(status); panel.appendChild(inVid); panel.appendChild(bDesc); panel.appendChild(bCom);
    panel.appendChild(mk('div', '', 'height:4px;')); panel.appendChild(bCopy); panel.appendChild(bClose);
    document.body.appendChild(panel);
    S.panel = panel;
    function setStatus(t, hot) { status.textContent = t; status.style.color = hot ? '#ff0' : '#fff'; }
    setStatus('▶ J1 概要欄を読む を押す');

    async function run(fn) {
        if (S.running) return;
        S.running = true; bDesc.disabled = bCom.disabled = true;
        try {
            var r = await fn();
            S.reports = S.reports.filter(function (x) { return x.id !== r.id; });
            S.reports.push(r);
            setStatus(r.id + ': ' + r.verdict + '（' + (r.pass || 0) + '/' + r.results.length + '）。' + (r.id === 'D-J1' ? '次に ▶ J2' : '📋 で結果をコピー'), r.verdict !== '合格');
        } catch (e) {
            setStatus('⚠ 失敗: ' + (e && e.message ? e.message : e), true);
        } finally {
            S.running = false; bDesc.disabled = bCom.disabled = false;
        }
    }
    bDesc.onclick = function () { setStatus('読んでいます…'); run(function () { return readDesc(inVid.value); }); };
    bCom.onclick = function () { setStatus('読んでいます…（数秒）'); run(readComments); };
    bCopy.onclick = function () {
        var md = toMarkdown();
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = md; document.body.appendChild(ta); ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { }
            ta.remove();
            setStatus(ok ? 'コピーしました（予備の方法）' : '⚠ コピーできません。コンソールで copy(__infoSpike.md()) と打って Enter', !ok);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(md).then(function () { setStatus('コピーしました', false); }, fallback);
        } else fallback();
    };
    bClose.onclick = function () { if (!S.running) panel.remove(); };
    S.md = toMarkdown;
    S._t = { videoIdOf: videoIdOf, runKind: runKind, parseComments: parseComments, commentToken: commentToken, rangesOk: rangesOk };
    console.log('[スパイク I1] パネルを出しました（画面の右上）。');
})();

/* ============================================================
   スパイク S1: コメント流しのカクつきの切り分け（版数を切らない・本番コードは変えない）
   使い方: コントローラーのページを開き、流しを出した状態で、この全文をコンソールへ貼って Enter。
   画面左下に小さなパネルが出る。「▶ 計測」で F0・F1・F5・F6・F4 を各20秒ずつ流し、「📋 結果をコピー」で結果を写す。
   🔴 計測のあいだだけ本番の関数（flowRafLoop / flowSpawn / pumpFlowProgress / pumpChatProgress）を包み、
      終わったら元に戻す。終わったらページを読み込み直すこと（F3/F4 で作ったアニメーションが残るため）。
   ============================================================ */
(function () {
    'use strict';
    var SNIP_VERSION = 'flow-s1-1.2.0';
    var RUN_MS = 20000, GAP_MS = 3000;
    /* ★1.2.0（2026-10-23）: 1.1.0 の実機で「描画が毎秒17〜26回しか回っていない・自前の処理は 35 ms/秒」と分かった。
       縁取り（ぼかし付きの影4重）を外すと速くなったが、利用者は「縁取りなしは見にくい」。
       → ぼかし無しの縁取り（F5・F6）と、流しを隠した「動画だけ」の基準（F0）を測る。
       css: そのモードで足す CSS / shadowRe: 計測中のコメントの text-shadow が満たすべき形（切替が効いた証拠） */
    var MODES = [
        { id: 'D-F0', name: '流しを隠す（動画とメーターだけ）', css: '.flow-layer { display: none !important; }', hidden: true, waapi: false },
        { id: 'D-F1', name: '基準（今のまま・ぼかし付きの縁取り）', css: '', waapi: false },
        { id: 'D-F5', name: 'ぼかし無しの縁取り', css: '.flow-msg { text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000 !important; }', shadowRe: /1px 1px 0px/, waapi: false },
        { id: 'D-F6', name: 'ぼかし無しの縁取り＋合成器', css: '.flow-msg { text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000 !important; }', shadowRe: /1px 1px 0px/, waapi: true },
        { id: 'D-F4', name: '縁取りなし＋合成器（1.1.0 で滑らかだった基準）', css: '.flow-msg { text-shadow: none !important; }', shadowRe: /^none$/, waapi: true }
    ];

    if (window.__flowSpike && window.__flowSpike.panel) { try { window.__flowSpike.panel.remove(); } catch (e) { } }
    var S = window.__flowSpike = { reports: [], meta: null, running: false };

    var orig = {
        raf: window.flowRafLoop, spawn: window.flowSpawn,
        pumpFlow: window.pumpFlowProgress, pumpChat: window.pumpChatProgress,
        /* ★1.1.0: v2.12.x の音量メーターと埋め込みからの受信も測る（無い版では null） */
        renderMeters: (typeof window.renderMeters === 'function') ? window.renderMeters : null,
        embed: (typeof window.handleEmbedMessage === 'function') ? window.handleEmbedMessage : null
    };
    var haveAll = typeof orig.raf === 'function' && typeof orig.spawn === 'function'
        && typeof orig.pumpFlow === 'function' && typeof orig.pumpChat === 'function';

    /* ---------- 小道具 ---------- */
    function stats(a) {
        if (!a.length) return { n: 0, mean: 0, p50: 0, p95: 0, max: 0 };
        var s = a.slice().sort(function (x, y) { return x - y; });
        var sum = 0; for (var i = 0; i < s.length; i++) sum += s[i];
        return { n: s.length, mean: sum / s.length, p50: s[Math.floor(s.length * 0.5)],
                 p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] };
    }
    function f1(x) { return (Math.round(x * 10) / 10).toString(); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function flowCards() {
        var out = [];
        try {
            activeCardIds.forEach(function (id) { if (flowVisible[id]) out.push(id); });
        } catch (e) { }
        return out;
    }

    /* ---------- 計測の器 ---------- */
    var m = null;
    function newM(mode) {
        return { mode: mode, frames: [], rafDur: [], tickChat: [], tickFlow: [], spawnPerTick: [], spawnNow: 0,
                 spawnMs: 0, spawns: 0, onscreen: [], clockDev: [], clockBack: 0, clockBig: 0, anims: 0,
                 lastEst: {}, shadowBefore: null, shadowAfter: null, liveCards: 0, archiveCards: 0,
                 /* ★1.1.0: 自前の処理の合計と、ページへ届くメッセージの量 */
                 meterMs: 0, meterN: 0, embedMs: 0, embedN: 0, msgN: 0, msgYt: 0, msgChars: 0 };
    }

    /* ---------- F3/F4: 合成器で動かす ---------- */
    function spawnW(cardId, layer, lanes, c, emojiMap, t0Override) {
        var before = lanes.map(function (l) { return l.length; });
        var t = performance.now();
        orig.spawn.apply(this, arguments);
        for (var i = 0; i < lanes.length; i++) {
            if (lanes[i].length <= (before[i] || 0)) continue;
            var it = lanes[i][lanes[i].length - 1];
            var est = flowLastEstMs[cardId];
            if (flowLive[cardId]) est = performance.now() - (flowLiveT0[cardId] || performance.now());
            if (est === undefined || est === null) est = it.t0;
            var p0 = Math.max(0, Math.min(1, (est - it.t0) / FLOW.durationMs));
            var speed = flowLive[cardId] ? 1 : (currentPlaybackSpeed || 1);
            var rem = Math.max(50, (1 - p0) * FLOW.durationMs / speed);
            try {
                it.anim = it.el.animate(
                    [{ transform: 'translateX(' + (it.target * p0) + 'px)' }, { transform: 'translateX(' + it.target + 'px)' }],
                    { duration: rem, easing: 'linear', fill: 'forwards' });
                m.anims++;
            } catch (e) { }
            break;
        }
        m.spawnMs += performance.now() - t;
    }
    function spawnM(cardId, layer, lanes) {
        var t = performance.now();
        orig.spawn.apply(this, arguments);
        m.spawnMs += performance.now() - t;
    }
    function rafW() {
        flowRaf = requestAnimationFrame(flowRafLoop);
        var any = false;
        for (var k = 0; k < activeCardIds.length; k++) {
            var cardId = activeCardIds[k];
            if (!flowVisible[cardId]) continue;
            var lanes = flowLanes[cardId];
            if (!lanes) continue;
            any = true;
            var ms = flowEstMs(cardId);
            if (ms === null) continue;
            var paused = !flowLive[cardId] && flowIsPaused(cardId);
            for (var i = 0; i < lanes.length; i++) {
                var items = lanes[i];
                for (var j = items.length - 1; j >= 0; j--) {
                    var it = items[j];
                    var p = (ms - it.t0) / FLOW.durationMs;
                    if (p >= 1) { if (it.anim) { try { it.anim.cancel(); } catch (e) { } } it.el.remove(); items.splice(j, 1); continue; }
                    if (it.anim) {
                        try {
                            if (paused && it.anim.playState === 'running') it.anim.pause();
                            else if (!paused && it.anim.playState === 'paused') it.anim.play();
                        } catch (e) { }
                        continue;   // 🔴 位置は書かない（合成器が動かす）
                    }
                    it.el.style.transform = 'translateX(' + (it.target * (p < 0 ? 0 : p)) + 'px)';
                }
            }
        }
        if (!any) { cancelAnimationFrame(flowRaf); flowRaf = null; }
    }

    /* ---------- 包む / 戻す ---------- */
    function install(mode) {
        window.flowRafLoop = function () {
            var t = performance.now();
            (mode.waapi ? rafW : orig.raf).apply(this, arguments);
            var now = performance.now();
            m.rafDur.push(now - t);
            /* アーカイブ枠の時刻源の揺れ: 描いた位置の進み − 実時間 × 速度 */
            flowCards().forEach(function (id) {
                if (flowLive[id]) return;
                var est = flowLastEstMs[id];
                if (est === undefined || est === null) return;
                var prev = m.lastEst[id];
                m.lastEst[id] = { est: est, at: now };
                if (!prev) return;
                var paused = false;
                try { paused = flowIsPaused(id); } catch (e) { }
                if (paused) return;
                var dev = (est - prev.est) - (now - prev.at) * (currentPlaybackSpeed || 1);
                if (Math.abs(dev) > 1000) return;   // シーク
                m.clockDev.push(Math.abs(dev));
                if (est < prev.est - 0.5) m.clockBack++;
                if (Math.abs(dev) > 30) m.clockBig++;
            });
        };
        window.flowSpawn = function () {
            m.spawns++; m.spawnNow++;
            return (mode.waapi ? spawnW : spawnM).apply(this, arguments);
        };
        window.pumpFlowProgress = function () {
            var t = performance.now();
            m.spawnNow = 0;
            orig.pumpFlow.apply(this, arguments);
            m.tickFlow.push(performance.now() - t);
            m.spawnPerTick.push(m.spawnNow);
        };
        window.pumpChatProgress = function () {
            var t = performance.now();
            orig.pumpChat.apply(this, arguments);
            m.tickChat.push(performance.now() - t);
        };
        if (orig.renderMeters) window.renderMeters = function () {
            var t = performance.now();
            var r = orig.renderMeters.apply(this, arguments);
            m.meterMs += performance.now() - t; m.meterN++;
            return r;
        };
        if (orig.embed) window.handleEmbedMessage = function () {
            var t = performance.now();
            var r = orig.embed.apply(this, arguments);
            m.embedMs += performance.now() - t; m.embedN++;
            return r;
        };
        if (mode.css) {
            var st = document.createElement('style');
            st.id = '__flowSpikeStyle';
            st.textContent = mode.css;
            document.head.appendChild(st);
        }
    }
    function uninstall() {
        window.flowRafLoop = orig.raf; window.flowSpawn = orig.spawn;
        window.pumpFlowProgress = orig.pumpFlow; window.pumpChatProgress = orig.pumpChat;
        if (orig.renderMeters) window.renderMeters = orig.renderMeters;
        if (orig.embed) window.handleEmbedMessage = orig.embed;
        var st = document.getElementById('__flowSpikeStyle');
        if (st) st.remove();
    }
    function shadowNow() {
        var el = document.querySelector('.flow-msg');
        return el ? getComputedStyle(el).textShadow : null;
    }

    /* ---------- 1モード分 ---------- */
    async function runMode(mode) {
        m = newM(mode);
        var cards = flowCards();
        cards.forEach(function (id) { if (flowLive[id]) m.liveCards++; else m.archiveCards++; });
        m.shadowBefore = shadowNow();
        install(mode);
        var t0 = performance.now(), last = t0, stop = false;
        function mon(ts) {
            if (stop) return;
            var now = performance.now();
            m.frames.push(now - last); last = now;
            requestAnimationFrame(mon);
        }
        requestAnimationFrame(mon);
        /* ★1.1.0: ページへ届くメッセージを数える（YouTube の枠は 1枠あたり毎秒数回、状態を送ってくる） */
        var onMsg = function (e) {
            m.msgN++;
            if (e.origin === 'https://www.youtube.com') m.msgYt++;
            if (typeof e.data === 'string') m.msgChars += e.data.length;
        };
        window.addEventListener('message', onMsg, true);
        var iv = setInterval(function () {
            m.onscreen.push(document.querySelectorAll('.flow-msg').length);
            if (m.shadowAfter === null) m.shadowAfter = shadowNow();   // 切替後に流れているコメントで見る
            setStatus('計測中: ' + mode.id + ' ' + mode.name + ' … 残り ' + Math.max(0, Math.ceil((RUN_MS - (performance.now() - t0)) / 1000)) + '秒', true);
        }, 500);
        await sleep(RUN_MS);
        stop = true; clearInterval(iv);
        window.removeEventListener('message', onMsg, true);
        uninstall();
        return summarize(m);
    }

    function summarize(m) {
        var fr = stats(m.frames.slice(1));
        var refresh = fr.p50 || 16.7;
        var drops = m.frames.slice(1).filter(function (d) { return d > refresh * 1.5; }).length;
        var big = m.frames.slice(1).filter(function (d) { return d > 50; }).length;
        var rd = stats(m.rafDur), tc = stats(m.tickChat), tf = stats(m.tickFlow), sp = stats(m.spawnPerTick);
        var on = stats(m.onscreen), cd = stats(m.clockDev);
        var res = [], pcs = [], notes = [];
        pcs.push({ name: '流しを出している枠が1つ以上ある', ok: (m.liveCards + m.archiveCards) > 0,
                   value: (m.liveCards + m.archiveCards) + '枠（ライブ ' + m.liveCards + ' / アーカイブ ' + m.archiveCards + '）' });
        if (m.mode.hidden) {
            res.push({ name: '流しの層が隠れていた（切替が効いた）', ok: on.max === 0, actual: '表示中のコメント 最大 ' + on.max + '件', expected: '0件' });
        } else {
            pcs.push({ name: '画面にコメントが流れていた（平均1件以上）', ok: on.mean >= 1, value: '平均 ' + f1(on.mean) + '件' });
        }
        /* 1.1.0 は 300 にしていて、描画が遅い実機（毎秒13回）で判定不能になった。20秒で 100 あれば統計には足りる */
        pcs.push({ name: 'フレームを数えられた（100以上）', ok: fr.n >= 100, value: fr.n + 'フレーム' });
        if (m.mode.shadowRe) {
            res.push({ name: '縁取りが切り替わった（切替が効いた）', ok: m.shadowAfter !== null && m.mode.shadowRe.test(m.shadowAfter),
                       actual: String(m.shadowAfter) + '（切替前: ' + String(m.shadowBefore) + '）', expected: String(m.mode.shadowRe) });
        } else if (!m.mode.hidden) {
            res.push({ name: '縁取りは元のまま', ok: true, actual: String(m.shadowAfter), expected: '（記録）' });
        }
        if (m.mode.waapi) {
            res.push({ name: 'アニメーションを作れた（切替が効いた）', ok: m.anims > 0, actual: m.anims + '個', expected: '1個以上' });
        }
        notes.push({ name: '🔴 1秒あたりの描画回数（フレーム数 ÷ 秒）', value: f1(fr.n / (RUN_MS / 1000)) + ' 回/秒' });
        notes.push({ name: 'フレーム間隔 ms（中央 / 平均 / 95% / 最大）', value: f1(fr.p50) + ' / ' + f1(fr.mean) + ' / ' + f1(fr.p95) + ' / ' + f1(fr.max) });
        notes.push({ name: '落ちたフレーム（中央値の1.5倍超）/ 50ms超', value: drops + ' / ' + big + '（全 ' + fr.n + '）' });
        notes.push({ name: '流しの1フレームの処理 ms（平均 / 95% / 最大）', value: f1(rd.mean) + ' / ' + f1(rd.p95) + ' / ' + f1(rd.max) });
        notes.push({ name: 'tick: チャット欄 ms（平均 / 最大）', value: f1(tc.mean) + ' / ' + f1(tc.max) });
        /* ★1.1.0: 落ちたフレームで失った時間と、自前の処理の合計を同じ単位（ms/秒）で並べる。
           失った時間が自前の処理より大きく多いなら、詰まらせているのは自前の処理ではない（YouTube の処理・GC など）。 */
        var secs = RUN_MS / 1000;
        var lost = 0; m.frames.slice(1).forEach(function (d) { if (d > refresh * 1.5) lost += d - refresh; });
        var sum = function (a) { var t = 0; a.forEach(function (x) { t += x; }); return t; };
        var ours = sum(m.rafDur) + sum(m.tickChat) + sum(m.tickFlow) + m.meterMs + m.embedMs;
        notes.push({ name: '🔴 落ちたフレームで失った時間 ms/秒', value: f1(lost / secs) });
        notes.push({ name: '🔴 自前の処理の合計 ms/秒（流しの描画・tick・メーター・埋め込みの受信）', value: f1(ours / secs)
            + '（内訳: 流し ' + f1(sum(m.rafDur) / secs) + ' / tick ' + f1((sum(m.tickChat) + sum(m.tickFlow)) / secs)
            + ' / メーター ' + f1(m.meterMs / secs) + '（' + m.meterN + '回）/ 受信 ' + f1(m.embedMs / secs) + '（' + m.embedN + '件））' });
        notes.push({ name: 'ページへ届くメッセージ 件/秒（全体 / YouTube から）・文字数/秒', value: f1(m.msgN / secs) + ' / ' + f1(m.msgYt / secs) + ' ・ ' + Math.round(m.msgChars / secs) });
        notes.push({ name: 'tick: 流しの生成 ms（平均 / 最大）', value: f1(tf.mean) + ' / ' + f1(tf.max) });
        notes.push({ name: '1tickの生成数（平均 / 最大）・生成の合計時間', value: f1(sp.mean) + ' / ' + sp.max + ' ・ ' + f1(m.spawnMs) + 'ms（' + m.spawns + '件）' });
        notes.push({ name: '同時表示（平均 / 最大）', value: f1(on.mean) + ' / ' + on.max });
        notes.push({ name: 'アーカイブの時刻源の揺れ ms（平均 / 95% / 最大）・巻き戻り・30ms超', value: m.archiveCards
            ? (f1(cd.mean) + ' / ' + f1(cd.p95) + ' / ' + f1(cd.max) + ' ・ ' + m.clockBack + '回 ・ ' + m.clockBig + '回（' + cd.n + 'フレーム）')
            : '（アーカイブ枠なし）' });
        var pass = res.filter(function (r) { return r.ok; }).length;
        var pcOk = pcs.every(function (p) { return p.ok; });
        return { id: m.mode.id, name: m.mode.name, results: res, pcs: pcs, notes: notes,
                 verdict: !pcOk ? '判定不能' : (pass === res.length ? '合格' : '不合格'), pass: pass };
    }

    function collectMeta() {
        var f = {};
        try { ['durationMs', 'maxOnscreen', 'fontPx', 'opacity', 'areaRatio', 'shadow'].forEach(function (k) { f[k] = FLOW[k]; }); } catch (e) { }
        var cards = [];
        try {
            activeCardIds.forEach(function (id) {
                var key = (typeof getChatKey === 'function') ? getChatKey(id) : null;
                cards.push(id + (flowVisible[id] ? '🌊' : '') + (key ? '(' + key + (flowLive[id] ? '・ライブ' : '') + ')' : ''));
            });
        } catch (e) { }
        return { at: new Date().toISOString(), app: (typeof APP_VERSION !== 'undefined') ? APP_VERSION : '?',
                 screen: innerWidth + ' x ' + innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent,
                 flow: f, cards: cards, total: (typeof activeCardIds !== 'undefined') ? activeCardIds.length : 0 };
    }

    function toMarkdown() {
        var mt = S.meta || collectMeta();
        var L = [];
        L.push('### スパイク S1 計測結果（コメント流しのカクつき）');
        L.push('');
        L.push('## 1. 事実');
        L.push('');
        L.push('- debug_suite: `' + SNIP_VERSION + '` / APP_VERSION: `' + mt.app + '`');
        L.push('- 実行日時: ' + mt.at);
        L.push('- 画面: ' + mt.screen + '（devicePixelRatio ' + mt.dpr + '）');
        L.push('- UA: `' + mt.ua + '`');
        L.push('- 枠: ' + mt.total + '枠 ' + mt.cards.join(' / '));
        L.push('- 流しの設定: `' + JSON.stringify(mt.flow) + '`');
        L.push('');
        L.push('| テスト | 判定 | 合格/項目数 | PC |');
        L.push('| :--- | :--: | ---: | :--- |');
        S.reports.forEach(function (r) {
            var pcOk = r.pcs.filter(function (p) { return p.ok; }).length;
            L.push('| ' + r.id + ' ' + r.name + ' | ' + (r.verdict === '合格' ? '⚪' : (r.verdict === '不合格' ? '❌' : '⚠️')) + ' ' + r.verdict
                + ' | ' + r.pass + '/' + r.results.length + ' | ' + (pcOk === r.pcs.length ? '全' + pcOk + '件成立' : pcOk + '/' + r.pcs.length + '成立') + ' |');
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
        L.push(JSON.stringify({ snippet: SNIP_VERSION, meta: mt, report: S.reports }, null, 1));
        L.push('```');
        return L.join('\n');
    }

    /* ---------- パネル ---------- */
    var panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;background:#111c;color:#fff;'
        + 'border:1px solid #0fc;border-radius:6px;padding:8px 10px;font:13px/1.5 sans-serif;max-width:420px;';
    var title = document.createElement('div');
    title.textContent = 'スパイク S1（' + SNIP_VERSION + '）';
    title.style.cssText = 'color:#0fc;font-weight:bold;';
    var status = document.createElement('div');
    status.style.cssText = 'margin:4px 0;font-size:15px;font-weight:bold;';
    var bRun = document.createElement('button');
    bRun.textContent = '▶ 計測（F0→F1→F5→F6→F4・約2分）';
    var bCopy = document.createElement('button');
    bCopy.textContent = '📋 結果をコピー';
    var bClose = document.createElement('button');
    bClose.textContent = '×';
    [bRun, bCopy, bClose].forEach(function (b) { b.style.cssText = 'margin:2px 4px 2px 0;padding:3px 8px;cursor:pointer;'; });
    panel.appendChild(title); panel.appendChild(status); panel.appendChild(bRun); panel.appendChild(bCopy); panel.appendChild(bClose);
    document.body.appendChild(panel);
    S.panel = panel;
    function setStatus(t, hot) { status.textContent = t; status.style.color = hot ? '#ff0' : '#fff'; }
    setStatus(haveAll ? '準備OK。流しを出して再生してから ▶ を押す' : '⚠ 本番の関数が見つかりません（ページが違う？）');

    bRun.onclick = async function () {
        if (S.running || !haveAll) return;
        S.running = true; S.reports = []; S.meta = collectMeta();
        bRun.disabled = true;
        try {
            for (var i = 0; i < MODES.length; i++) {
                setStatus('次: ' + MODES[i].id + ' ' + MODES[i].name + '（' + (GAP_MS / 1000) + '秒後）', false);
                await sleep(GAP_MS);
                S.reports.push(await runMode(MODES[i]));
            }
            setStatus('終わりました。📋 を押して用紙へ貼ってください（そのあとページを読み込み直す）', false);
        } catch (e) {
            uninstall();
            setStatus('⚠ 途中で失敗: ' + (e && e.message ? e.message : e), false);
        } finally {
            S.running = false; bRun.disabled = false;
        }
    };
    bCopy.onclick = function () {
        var md = toMarkdown();
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = md; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); setStatus('コピーしました（予備の方法）', false); }
            catch (e) { setStatus('⚠ コピーに失敗。コンソールの __flowSpike.md() の出力を写してください', false); }
            ta.remove();
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(md).then(function () { setStatus('コピーしました', false); }, fallback);
        } else fallback();
    };
    bClose.onclick = function () { if (!S.running) { uninstall(); panel.remove(); } };
    S.md = toMarkdown;
})();

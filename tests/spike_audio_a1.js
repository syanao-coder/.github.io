/* ============================================================
   スパイク A1: 枠ごとの音のレベルを測れるか（版数を切らない・本番コードもアドオンも変えない）
   🔴 YouTube の埋め込み（www.youtube.com/embed/…）の「中」で実行する。
      Floorp のコンソールで実行先を「Top」から埋め込みのフレームへ切り替えてから貼る。
   画面（枠の左上）に小さなパネルが出る。
     ▶ A1 … captureStream で音を写し取って測る（音の通り道は変えない）
     ▶ A2 … MediaElementSource で音の通り道を Web Audio に付け替えて測る（🔴 元に戻せない。終わったら読み込み直す）
   各録り方で「そのまま 4秒 → 音量を半分 4秒 → 一時停止 2.5秒（無音が正常）」を自動で流す。
   🔴 innerHTML は使わない（YouTube は文字列での HTML の書き込みを禁じている）。
   ============================================================ */
(function () {
    'use strict';
    var SNIP_VERSION = 'audio-a1-1.0.0';
    var SILENT_DB = -60;

    var inEmbed = location.hostname === 'www.youtube.com' && /^\/embed\//.test(location.pathname);
    if (!inEmbed) {
        console.warn('[スパイク A1] ここは ' + location.href + ' です。コンソールの実行先を YouTube の埋め込み（www.youtube.com/embed/…）に切り替えてから貼ってください。');
        return;
    }
    if (window.__audioSpike && window.__audioSpike.panel) { try { window.__audioSpike.panel.remove(); } catch (e) { } }
    var S = window.__audioSpike = { reports: [], running: false };

    function videoEl() { return document.querySelector('video'); }
    function player() { return document.getElementById('movie_player'); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function f1(x) { return (isFinite(x) ? Math.round(x * 10) / 10 : x).toString(); }
    function db(rms) { return rms > 0 ? 20 * Math.log10(rms) : -Infinity; }

    /* ---------- 1つの録り方 ---------- */
    async function runMethod(id, name, how) {
        var v = videoEl(), mp = player();
        var r = { id: id, name: name, results: [], pcs: [], notes: [] };
        r.pcs.push({ name: '動画の要素がある', ok: !!v, value: v ? ('paused=' + v.paused + ' / volume=' + f1(v.volume) + ' / muted=' + v.muted) : '(なし)' });
        r.pcs.push({ name: 'プレイヤーの操作（setVolume / pauseVideo / playVideo）を呼べる', ok: !!(mp && mp.setVolume && mp.pauseVideo && mp.playVideo && mp.getVolume),
                     value: mp ? 'あり' : '(なし)' });
        r.pcs.push({ name: '測り始めに再生中', ok: !!(v && !v.paused), value: v ? (v.paused ? '止まっている' : '再生中') : '-' });
        if (!r.pcs.every(function (p) { return p.ok; })) { r.verdict = '判定不能'; return r; }

        var userVol = mp.getVolume();
        r.notes.push({ name: 'プレイヤーの音量（getVolume）/ 動画の要素の volume / 比（YouTube の音量の均し）',
                       value: userVol + ' / ' + f1(v.volume) + ' / ' + (userVol > 0 ? f1(v.volume / (userVol / 100)) : '-') });

        var Ctx = window.AudioContext || window.webkitAudioContext;
        var ctx = new Ctx();
        var st0 = ctx.state;
        if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { } }
        r.notes.push({ name: 'AudioContext の状態（作った直後 → resume 後）', value: st0 + ' → ' + ctx.state });

        var src;
        try {
            if (how === 'capture') {
                var stream = v.mozCaptureStream ? v.mozCaptureStream() : v.captureStream();
                r.notes.push({ name: '写し取った音のトラック数', value: String(stream.getAudioTracks().length) });
                src = ctx.createMediaStreamSource(stream);
            } else {
                src = ctx.createMediaElementSource(v);
                src.connect(ctx.destination);   /* 🔴 繋がないと音が出なくなる */
            }
        } catch (e) {
            r.results.push({ name: '音の取り出しを作れた', ok: false, actual: String(e && e.message ? e.message : e), expected: '例外なし' });
            r.verdict = '不合格';
            return r;
        }
        r.results.push({ name: '音の取り出しを作れた', ok: true, actual: '例外なし', expected: '例外なし' });

        var an = ctx.createAnalyser(); an.fftSize = 2048;
        var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1000; bp.Q.value = 0.7;   // 声の帯域（おおよそ 300〜3400Hz）
        var an2 = ctx.createAnalyser(); an2.fftSize = 2048;
        src.connect(an); src.connect(bp); bp.connect(an2);
        var buf = new Float32Array(an.fftSize), buf2 = new Float32Array(an2.fftSize);
        function level(a, b) { a.getFloatTimeDomainData(b); var s = 0; for (var i = 0; i < b.length; i++) s += b[i] * b[i]; return Math.sqrt(s / b.length); }

        async function phase(label, ms) {
            setStatus(id + ' ' + label, true);
            var xs = [], ys = [], t0 = performance.now();
            while (performance.now() - t0 < ms) {
                await sleep(50);
                xs.push(db(level(an, buf))); ys.push(db(level(an2, buf2)));
            }
            var fin = xs.filter(isFinite), fin2 = ys.filter(isFinite);
            var mean = fin.length ? fin.reduce(function (a, b) { return a + b; }, 0) / fin.length : -Infinity;
            var mean2 = fin2.length ? fin2.reduce(function (a, b) { return a + b; }, 0) / fin2.length : -Infinity;
            var loud = xs.filter(function (x) { return x > SILENT_DB; }).length;
            return { mean: mean, max: fin.length ? Math.max.apply(null, fin) : -Infinity, mean2: mean2, loudRatio: xs.length ? loud / xs.length : 0, n: xs.length };
        }

        var p1, p2, p3;
        try {
            p1 = await phase('そのまま（4秒）', 4000);
            mp.setVolume(Math.max(1, Math.round(userVol / 2)));
            await sleep(300);
            p2 = await phase('音量を半分（4秒）', 4000);
            mp.setVolume(userVol);
            mp.pauseVideo();
            await sleep(400);
            p3 = await phase('一時停止（2.5秒・無音が正常）', 2500);
        } finally {
            try { mp.setVolume(userVol); mp.playVideo(); } catch (e) { }
        }
        r.notes.push({ name: 'そのまま: 平均 / 最大 dB・声の帯域の平均 dB・音がある割合', value: f1(p1.mean) + ' / ' + f1(p1.max) + ' ・ ' + f1(p1.mean2) + ' ・ ' + Math.round(p1.loudRatio * 100) + '%（' + p1.n + '回）' });
        r.notes.push({ name: '音量を半分: 平均 dB・そのままとの差', value: f1(p2.mean) + ' ・ ' + f1(p2.mean - p1.mean) + ' dB（音量を掛けた後の音なら約 -6 dB、掛ける前なら約 0 dB）' });
        r.notes.push({ name: '一時停止: 平均 dB・音がある割合', value: f1(p3.mean) + ' ・ ' + Math.round(p3.loudRatio * 100) + '%' });
        r.results.push({ name: '🔴 再生中に音のレベルが取れた（平均 ' + SILENT_DB + ' dB 超）', ok: p1.mean > SILENT_DB, actual: f1(p1.mean) + ' dB', expected: '> ' + SILENT_DB });
        r.results.push({ name: '🔴 一時停止で無音になる（計測が音に反応している）', ok: p3.loudRatio < 0.1, actual: Math.round(p3.loudRatio * 100) + '%', expected: '10% 未満' });
        r.results.push({ name: '音量を半分にするとレベルが動く（記録。動かないなら音量を掛ける前の音）', ok: true, actual: f1(p2.mean - p1.mean) + ' dB', expected: '（記録）' });
        var pass = r.results.filter(function (x) { return x.ok; }).length;
        r.verdict = pass === r.results.length ? '合格' : '不合格';
        r.pass = pass;
        S.keep = S.keep || []; S.keep.push(ctx, src);   // 測り終えても捨てない（A2 は捨てると音が消える）
        return r;
    }

    function toMarkdown() {
        var L = [];
        L.push('### スパイク A1 計測結果（枠ごとの音のレベル）');
        L.push('');
        L.push('## 1. 事実');
        L.push('');
        L.push('- debug_suite: `' + SNIP_VERSION + '` / APP_VERSION: `(埋め込みの中)`');
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

    /* ---------- パネル（埋め込みの中に出す。押すことが埋め込みへの操作になり、音の許可が下りる） ---------- */
    function mk(tag, text, css) { var e = document.createElement(tag); if (text) e.textContent = text; if (css) e.style.cssText = css; return e; }
    var panel = mk('div', '', 'position:fixed;left:6px;top:6px;z-index:2147483647;background:rgba(0,0,0,.85);color:#fff;border:1px solid #0fc;'
        + 'border-radius:6px;padding:6px 8px;font:12px/1.5 sans-serif;max-width:300px;');
    var status = mk('div', '', 'margin:2px 0 4px;font-weight:bold;font-size:13px;');
    var bA1 = mk('button', '▶ A1 写し取り', 'margin:2px;padding:2px 6px;cursor:pointer;');
    var bA2 = mk('button', '▶ A2 付け替え', 'margin:2px;padding:2px 6px;cursor:pointer;');
    var bCopy = mk('button', '📋 コピー', 'margin:2px;padding:2px 6px;cursor:pointer;');
    var bClose = mk('button', '×', 'margin:2px;padding:2px 6px;cursor:pointer;');
    panel.appendChild(mk('div', 'スパイク A1（' + SNIP_VERSION + '）', 'color:#0fc;font-weight:bold;'));
    panel.appendChild(status); panel.appendChild(bA1); panel.appendChild(bA2); panel.appendChild(bCopy); panel.appendChild(bClose);
    document.body.appendChild(panel);
    S.panel = panel;
    function setStatus(t, hot) { status.textContent = t; status.style.color = hot ? '#ff0' : '#fff'; }
    setStatus('再生してから ▶ を押す');

    async function go(id, name, how) {
        if (S.running) return;
        S.running = true; bA1.disabled = bA2.disabled = true;
        try {
            S.reports = S.reports.filter(function (r) { return r.id !== id; });
            S.reports.push(await runMethod(id, name, how));
            setStatus('終わりました。音は聞こえ続けましたか？ 📋 で結果をコピー', false);
        } catch (e) {
            setStatus('⚠ 失敗: ' + (e && e.message ? e.message : e), false);
        } finally {
            S.running = false; bA1.disabled = bA2.disabled = false;
        }
    }
    bA1.onclick = function () { go('D-Q1', '写し取り（captureStream・音の通り道は変えない）', 'capture'); };
    bA2.onclick = function () { go('D-Q2', '付け替え（MediaElementSource・🔴 元に戻せない）', 'element'); };
    bCopy.onclick = function () {
        var md = toMarkdown();
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = md; document.body.appendChild(ta); ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { }
            ta.remove();
            setStatus(ok ? 'コピーしました（予備の方法）' : '⚠ コピーできません。コンソールで copy(__audioSpike.md()) と打って Enter', false);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(md).then(function () { setStatus('コピーしました', false); }, fallback);
        } else fallback();
    };
    bClose.onclick = function () { if (!S.running) panel.remove(); };
    S.md = toMarkdown;
    console.log('[スパイク A1] パネルを出しました（枠の左上）。');
})();

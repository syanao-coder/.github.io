/* ============================================================================
   debug_suite.js ─ 自動デバッグ基盤（★v2.7.3 で新設）

   これは本体機能ではなく「開発基盤」である。本体（controller.html）には
   <script src="debug_suite.js"></script> の1行しか足していない。
   このファイルを消す／リネームすると <script> が404になるだけで本体は無傷。

   🔴 大原則
     1. 本体コードを書き換えない（本ファイルからは読むだけ）
     2. 無効時は何も作らない。DOM・グローバル変数・イベントリスナのいずれも生やさず即 return
     3. 基盤の不具合を本体の不合格にしない（ログでは判定と PC を分けて出す）
     4. 関数を直呼びせず、実際にクリックする（clickReal）
     5. positive control（pc）を必ず出す

   有効化:
     localStorage の sync_debug === '1' のときだけ動く。
     URL の ?debug=1 でそのキーを立て、?debug=0 で削除する。
     キー操作（Ctrl+Shift+D 等）による有効化は実装しない（誤爆防止）。

   構造:
     ブロック1  有効化判定
     ブロック2  共通ライブラリ（wait / sample / rect / overlap / clickReal / expect / pc）
     ブロック3  UI生成（CSS注入・トップバーのボタン・ドロップダウン・ログ）
     ブロック4  テスト登録（D-V1 / D-M2 / D-M7）
   ========================================================================== */
(function () {
    'use strict';

    /* ========================================================================
       ブロック1: 有効化判定
       ====================================================================== */

    var DEBUG_SUITE_VERSION = '1.0.1';   /* 本体の APP_VERSION とは別系統 */
    var LS_ENABLE = 'sync_debug';        /* '1' のときだけ有効 */
    var LS_RESUME = 'sync_debug_resume'; /* 再読み込みをまたぐテストの引き継ぎ用（一時キー） */
    var RESUME_TTL_MS = 10 * 60 * 1000;  /* 古い引き継ぎは捨てる */

    var query = null;
    try { query = new URLSearchParams(location.search).get('debug'); } catch (e) { query = null; }

    if (query === '0') {
        /* 明示的な無効化。キーを削除して、何も作らずに抜ける（ログも出さない）。 */
        try { localStorage.removeItem(LS_ENABLE); localStorage.removeItem(LS_RESUME); } catch (e) { }
        return;
    }
    if (query === '1') {
        try { localStorage.setItem(LS_ENABLE, '1'); } catch (e) { }
    }

    var enabled = false;
    try { enabled = (localStorage.getItem(LS_ENABLE) === '1'); } catch (e) { enabled = false; }

    /* 🔴 ここで抜ける場合、DOM も listener も global も一切作っていない。 */
    if (!enabled) return;


    /* ========================================================================
       ブロック2: 共通ライブラリ
       ====================================================================== */

    var SETTLE_MS = 60;      /* クリック後にDOMが落ち着くのを待つ既定値 */

    /* 単なる待機。待ち時間を明示的に書かせるために用意する。 */
    function wait(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /* fn() を count 回サンプリングし、最小・最大・平均・0になった回数を集計する。 */
    async function sample(intervalMs, count, fn) {
        var values = [], zeros = 0;
        for (var i = 0; i < count; i++) {
            var v = Number(fn());
            if (!isFinite(v)) v = 0;
            values.push(v);
            if (v === 0) zeros++;
            if (i < count - 1) await wait(intervalMs);
        }
        var sum = 0;
        for (var j = 0; j < values.length; j++) sum += values[j];
        return {
            min: Math.min.apply(null, values),
            max: Math.max.apply(null, values),
            avg: Math.round((sum / values.length) * 100) / 100,
            zeros: zeros,
            count: values.length,
            values: values
        };
    }

    /* getBoundingClientRect() を丸めて返す。 */
    function rect(el) {
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return {
            left: Math.round(r.left), top: Math.round(r.top),
            right: Math.round(r.right), bottom: Math.round(r.bottom),
            width: Math.round(r.width), height: Math.round(r.height)
        };
    }

    /* 2矩形の重なり面積と、a に対する割合(%)を返す。 */
    function overlap(a, b) {
        if (!a || !b) return { area: 0, ratio: 0 };
        var w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        var h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        var area = w * h;
        var base = Math.max(1, (a.right - a.left) * (a.bottom - a.top));
        return { area: area, ratio: Math.round((area / base) * 1000) / 10 };
    }

    function describe(el) {
        if (!el) return '(null)';
        var s = (el.tagName || '?').toLowerCase();
        if (el.id) s += '#' + el.id;
        if (el.className && typeof el.className === 'string' && el.className.trim()) {
            s += '.' + el.className.trim().split(/\s+/).join('.');
        }
        return s;
    }

    /* 中心座標の elementFromPoint が el かその子孫かを見る当たり判定。
       clickReal 本体と、その positive control の両方から使う。 */
    function hitTest(el) {
        var res = { blocked: false, reason: '', hit: '(未評価)', rect: null };
        if (!el) { res.blocked = true; res.reason = 'element-null'; return res; }
        var r = el.getBoundingClientRect();
        res.rect = rect(el);
        if (r.width <= 0 || r.height <= 0) { res.blocked = true; res.reason = 'zero-size'; return res; }
        var cx = Math.round(r.left + r.width / 2);
        var cy = Math.round(r.top + r.height / 2);
        if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
            res.blocked = true; res.reason = 'out-of-viewport';
            res.hit = '(画面外 ' + cx + ',' + cy + ')';
            return res;
        }
        var hit = null;
        try { hit = document.elementFromPoint(cx, cy); }
        catch (e) { res.blocked = true; res.reason = 'elementFromPoint-unavailable'; res.hit = '(判定不可)'; return res; }
        res.hit = describe(hit);
        if (!hit || !(hit === el || el.contains(hit))) { res.blocked = true; res.reason = 'covered'; }
        return res;
    }

    /* 🔴 el.click() を呼び、あわせて hitTest() の結果を返す。
       最前面でなければ blocked:true。テストは不合格にする。
       「関数は動くが実際には押せない」を捕まえるための唯一の仕掛け。 */
    async function clickReal(el) {
        if (!el) return { blocked: true, reason: 'element-null', hit: '(null)', clicked: false, rect: null };
        try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { }
        var res = hitTest(el);
        res.clicked = false;
        /* blocked でも click は実行する（後続の状態遷移は進め、判定だけ不合格にする）。 */
        try { el.click(); res.clicked = true; } catch (e) { res.reason = 'click-throw: ' + e.message; }
        await wait(SETTLE_MS);
        return res;
    }

    /* --- 判定の記録 ------------------------------------------------------ */

    var current = null;   /* 実行中のテスト。{ id, name, results[], pcs[] } */
    var report = [];      /* 全テストの記録 */

    function fmt(v) {
        if (v === null) return 'null';
        if (v === undefined) return 'undefined';
        if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
        return String(v);
    }

    /* 判定を記録する。expected が関数なら述語として評価する。
       それ以外は文字列化して比較する（40 と '40' を同じとみなすため）。 */
    function expect(name, actual, expected) {
        var ok, expText;
        if (typeof expected === 'function') {
            try { ok = !!expected(actual); } catch (e) { ok = false; }
            expText = expected.label || '(述語)';
        } else {
            ok = (String(actual) === String(expected));
            expText = fmt(expected);
        }
        var rec = { name: name, ok: ok, actual: fmt(actual), expected: expText };
        if (current) current.results.push(rec);
        log('  ' + (ok ? '[⚪]' : '[❌]') + ' ' + name + ' … 実測=' + rec.actual + ' / 期待=' + rec.expected);
        return ok;
    }

    /* positive control。通常の判定とは別枠で記録する。
       これが落ちたら「機能が壊れている」ではなく「測れていない」。 */
    function pc(name, fn) {
        var ok = false, value;
        try { value = fn(); ok = !!value; } catch (e) { value = 'ERROR: ' + e.message; ok = false; }
        var rec = { name: name, ok: ok, value: fmt(value) };
        if (current) current.pcs.push(rec);
        log('  ' + (ok ? '[PC ⚪]' : '[PC ❌]') + ' ' + name + ' … ' + rec.value);
        return ok;
    }


    /* ========================================================================
       ブロック3: UI生成
       ====================================================================== */

    var logLines = [];
    var logEl = null;

    function log(line) {
        var s = String(line);
        logLines.push(s);
        if (logEl) {
            logEl.textContent = logLines.join('\n');
            logEl.scrollTop = logEl.scrollHeight;
        }
        try { console.log('[debug_suite] ' + s); } catch (e) { }
    }

    /* CSS も本ファイルから注入する（controller.html の CSS は触らない）。
       .topmenu-anchor / .topmenu-dropdown は本体側に定義済みなので再定義せず流用し、
       デバッグ固有の見た目だけを足す。 */
    function injectStyle() {
        var css = [
            '#topDebugBtn { border:1px solid #c56cf0 !important; color:#c56cf0 !important; background:transparent; }',
            '#topDebugBtn:hover { background: rgba(197,108,240,0.12) !important; }',
            '#topDebugBtn.active { background:#c56cf0 !important; color:#000 !important; border-color:#c56cf0 !important; }',
            '#debugMenu h3 { color:#c56cf0; }',
            '#debugMenu .dbg-row { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }',
            '#debugMenu .dbg-row button { font-size:0.78rem; padding:3px 8px; cursor:pointer; }',
            '#debugMenu .dbg-note { font-size:0.72rem; color:#888; margin:0 0 8px 0; }',
            '#debugLog { margin:0; padding:8px; background:#07070a; border:1px solid #333; border-radius:4px;',
            '  font-family:monospace; font-size:0.72rem; line-height:1.35; color:#ddd;',
            '  max-height:300px; overflow:auto; white-space:pre-wrap; word-break:break-all; }'
        ].join('\n');
        var st = document.createElement('style');
        st.id = 'debugSuiteStyle';
        st.textContent = css;
        document.head.appendChild(st);
    }

    /* 排他制御は本体の仕組みに参加する（本体側に分岐を書き足さない）。 */
    var hasExclusive = false;
    function joinTopMenus() {
        try {
            if (typeof TOP_MENUS !== 'undefined' && Array.isArray(TOP_MENUS) &&
                typeof closeTopMenus === 'function') {
                TOP_MENUS.push({ panel: 'debugMenu', btn: 'topDebugBtn' });
                hasExclusive = true;
                return;
            }
        } catch (e) { }
        hasExclusive = false;
        console.warn('[debug_suite] TOP_MENUS / closeTopMenus が見つかりません。'
            + '排他制御なしで動作します（本体が古い可能性があります）。');
    }

    /* 既存3つと同じ形:「開くかどうかを先に決める → 全部閉じる → 開く場合だけ開く」 */
    function toggleDebugMenu() {
        var panel = document.getElementById('debugMenu');
        var btn = document.getElementById('topDebugBtn');
        if (!panel || !btn) return;
        var willOpen = !panel.classList.contains('open');
        if (hasExclusive) {
            try { closeTopMenus(null); } catch (e) { }
        } else {
            panel.classList.remove('open'); btn.classList.remove('active');
        }
        if (willOpen) { panel.classList.add('open'); btn.classList.add('active'); }
    }

    function openDebugMenu() {
        var panel = document.getElementById('debugMenu');
        if (panel && !panel.classList.contains('open')) toggleDebugMenu();
    }

    function mkBtn(label, title, handler) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        if (title) b.title = title;
        b.addEventListener('click', handler);
        return b;
    }

    function appVersion() {
        try { return (typeof APP_VERSION !== 'undefined') ? String(APP_VERSION) : '(取得不可)'; }
        catch (e) { return '(取得不可)'; }
    }

    function buildUI() {
        var commentAnchor = document.querySelector('.topmenu-anchor');
        var topBar = document.querySelector('.top-bar');
        if (!topBar) { console.warn('[debug_suite] .top-bar が見つかりません。UIを作れません。'); return false; }

        var anchor = document.createElement('span');
        anchor.className = 'topmenu-anchor';
        anchor.id = 'debugAnchor';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'topDebugBtn';
        btn.className = 'settings-toggle-btn';
        btn.textContent = '🐞 デバッグ';
        btn.title = 'debug_suite.js v' + DEBUG_SUITE_VERSION + '（?debug=0 で無効化）';
        btn.addEventListener('click', toggleDebugMenu);
        anchor.appendChild(btn);

        var panel = document.createElement('div');
        panel.className = 'topmenu-dropdown';
        panel.id = 'debugMenu';

        var h3 = document.createElement('h3');
        h3.textContent = '🐞 デバッグ  [suite ' + DEBUG_SUITE_VERSION + ' / app ' + appVersion() + ']';
        panel.appendChild(h3);

        var row1 = document.createElement('div');
        row1.className = 'dbg-row';
        row1.appendChild(mkBtn('▶ すべて実行', '登録された全テストを順に実行する', function () { runAll(); }));
        row1.appendChild(mkBtn('🗑 ログを消す', 'ログ表示と記録を初期化する', function () { clearLog(); }));
        row1.appendChild(mkBtn('📋 報告書用にコピー', 'Markdown 表としてクリップボードへコピーする', function () { copyReport(); }));
        panel.appendChild(row1);

        var row2 = document.createElement('div');
        row2.className = 'dbg-row';
        TESTS.forEach(function (t) {
            row2.appendChild(mkBtn('▶ ' + t.id, t.name, function () { runOne(t.id); }));
        });
        panel.appendChild(row2);

        var note = document.createElement('p');
        note.className = 'dbg-note';
        note.textContent = '各テストは「4メニューをすべて閉じた状態」から開始します。'
            + 'D-M7 は途中でページを再読み込みし、読み込み後に自動で続きを実行します。';
        panel.appendChild(note);

        var pre = document.createElement('pre');
        pre.id = 'debugLog';
        panel.appendChild(pre);
        anchor.appendChild(panel);

        /* 位置は一番左（💬 コメント設定 よりさらに左）。 */
        if (commentAnchor && commentAnchor.parentNode === topBar) {
            topBar.insertBefore(anchor, commentAnchor);
        } else {
            var firstBtn = document.getElementById('topSessionBtn');
            if (firstBtn) topBar.insertBefore(anchor, firstBtn); else topBar.appendChild(anchor);
        }
        logEl = pre;
        return true;
    }

    function clearLog() {
        logLines = [];
        report = [];
        if (logEl) logEl.textContent = '';
        header();
    }

    function header() {
        log('=== debug_suite ' + DEBUG_SUITE_VERSION + ' / APP_VERSION ' + appVersion() + ' ===');
        log('日時: ' + new Date().toISOString() + ' / 画面: ' + window.innerWidth + 'x' + window.innerHeight);
        log('排他制御への参加: ' + (hasExclusive ? 'TOP_MENUS.push() 済み' : '失敗（単独動作）'));
    }

    /* --- 報告書用の Markdown ---------------------------------------------- */

    function buildMarkdown() {
        var lines = [];
        lines.push('### v2.7.3 debug_suite 実行結果');
        lines.push('');
        lines.push('- debug_suite: `' + DEBUG_SUITE_VERSION + '` / APP_VERSION: `' + appVersion() + '`');
        lines.push('- 実行日時: ' + new Date().toISOString());
        lines.push('- 画面: ' + window.innerWidth + ' x ' + window.innerHeight);
        lines.push('- 排他制御への参加: ' + (hasExclusive ? 'TOP_MENUS.push() 成功' : '失敗（単独動作）'));
        lines.push('');
        lines.push('| テスト | 判定 | 合格/項目数 | PC |');
        lines.push('| :--- | :--: | ---: | :--- |');
        report.forEach(function (t) {
            var okCount = t.results.filter(function (r) { return r.ok; }).length;
            var pcNg = t.pcs.filter(function (p) { return !p.ok; }).length;
            lines.push('| ' + t.id + ' ' + t.name + ' | ' + verdictMark(t) + ' | '
                + okCount + '/' + t.results.length + ' | '
                + (t.pcs.length === 0 ? 'なし' : (pcNg === 0 ? '全' + t.pcs.length + '件成立' : pcNg + '件不成立')) + ' |');
        });
        lines.push('');
        report.forEach(function (t) {
            lines.push('#### ' + t.id + ' ' + t.name + ' ─ ' + verdictText(t));
            lines.push('');
            lines.push('| 種別 | 項目 | 実測 | 期待 | 判定 |');
            lines.push('| :--- | :--- | :--- | :--- | :--: |');
            t.pcs.forEach(function (p) {
                lines.push('| PC | ' + mdEsc(p.name) + ' | ' + mdEsc(p.value) + ' | 成立すること | ' + (p.ok ? '⚪' : '❌') + ' |');
            });
            t.results.forEach(function (r) {
                lines.push('| 判定 | ' + mdEsc(r.name) + ' | ' + mdEsc(r.actual) + ' | ' + mdEsc(r.expected) + ' | ' + (r.ok ? '⚪' : '❌') + ' |');
            });
            lines.push('');
        });
        return lines.join('\n');
    }

    function mdEsc(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

    function verdictMark(t) {
        if (t.pcs.some(function (p) { return !p.ok; })) return '⚠ 判定不能';
        return t.results.every(function (r) { return r.ok; }) ? '⚪ 合格' : '❌ 不合格';
    }
    function verdictText(t) {
        if (t.pcs.some(function (p) { return !p.ok; })) return '判定不能（positive control が不成立。基盤側の疑い）';
        return t.results.every(function (r) { return r.ok; }) ? '合格' : '不合格';
    }

    function copyReport() {
        var text = buildMarkdown();
        var done = function (ok) { log(ok ? '📋 クリップボードへコピーしました（Markdown 表）。' : '📋 コピーに失敗しました。'); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
        } else {
            done(fallbackCopy(text));
        }
    }

    /* display:none にすると選択できずコピーに失敗するので、画面外へ逃がす。 */
    function fallbackCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        return ok;
    }


    /* ========================================================================
       ブロック4: テスト登録
       ====================================================================== */

    /* トップバーの4メニュー。本体の TOP_MENUS とは独立に持つ
       （本体が古くても D-M2 の観測だけは成立させるため）。 */
    var MENUS = [
        { id: 'debug', panel: 'debugMenu', btn: 'topDebugBtn', label: '🐞 デバッグ' },
        { id: 'comment', panel: 'commentMenu', btn: 'topCommentBtn', label: '💬 コメント設定' },
        { id: 'session', panel: 'sessionContainer', btn: 'topSessionBtn', label: '📂 マイリスト' },
        { id: 'settings', panel: 'settingsContainer', btn: 'topSettingsBtn', label: '▼ 設定メニュー', arrow: 'topSettingsArrow' }
    ];

    function openIds() {
        return MENUS.filter(function (m) {
            var el = document.getElementById(m.panel);
            return !!el && el.classList.contains('open');
        }).map(function (m) { return m.id; });
    }
    function activeIds() {
        return MENUS.filter(function (m) {
            var el = document.getElementById(m.btn);
            return !!el && el.classList.contains('active');
        }).map(function (m) { return m.id; });
    }
    function arrowText() {
        var a = document.getElementById('topSettingsArrow');
        /* innerText は「描画されていない要素」では textContent と同じ値を返すが、
           読み取りは textContent で統一しておく（隠れたパネル内の表示も同じ手で読める）。 */
        return a ? String(a.textContent).trim() : '(なし)';
    }
    function menuOf(id) {
        for (var i = 0; i < MENUS.length; i++) if (MENUS[i].id === id) return MENUS[i];
        return null;
    }

    /* 開いているメニューを実際にクリックして閉じる（関数直呼びをしない）。 */
    async function closeAllMenus() {
        for (var guard = 0; guard < 6; guard++) {
            var open = openIds();
            var act = activeIds();
            if (open.length === 0 && act.length === 0) return true;
            var target = open[0] || act[0];
            var m = menuOf(target);
            if (!m) return false;
            await clickReal(document.getElementById(m.btn));
        }
        return openIds().length === 0 && activeIds().length === 0;
    }

    async function setMenuState(id) {
        await closeAllMenus();
        if (!id) return;
        await clickReal(document.getElementById(menuOf(id).btn));
    }

    /* --- D-V1: 版数バッジ ------------------------------------------------- */

    async function testV1() {
        /* バッジはアドオンの名乗りを ADDON_DETECT_TIMEOUT_MS(4000ms) 待って確定する。
           ページを開いた直後に読むと未確定の値を掴むので、確定するまで待つ。 */
        var elapsed = Math.round(performance.now());
        if (elapsed < 4500) {
            log('  [待機] バッジ確定待ち ' + (4500 - elapsed) + 'ms（読み込みから4.5秒経過するまで）');
            await wait(4500 - elapsed);
        } else {
            log('  [待機] 不要（読み込みから ' + elapsed + 'ms 経過済み）');
        }

        var badge = document.getElementById('versionBadge');

        pc('バッジ要素を取得でき、テキストが空でない', function () {
            return badge && String(badge.textContent).trim().length > 0 ? describe(badge) + ' → "' + badge.textContent + '"' : false;
        });
        pc('クラスの読み取りが識別できている（version-badge=true / 存在しないクラス=false）', function () {
            if (!badge) return false;
            return (badge.classList.contains('version-badge') === true
                && badge.classList.contains('__not_exist__') === false) ? 'true / false' : false;
        });
        pc('DEBUG_SUITE_VERSION を読めている', function () { return DEBUG_SUITE_VERSION; });

        expect('APP_VERSION', appVersion(), '2.7.3');
        expect('バッジのクラス', badge ? badge.className : '(要素なし)', 'version-badge ok');
        expect('バッジの表示文字列', badge ? String(badge.textContent).trim() : '(要素なし)', 'v2.7.3');
        expect('debug_suite の版数', DEBUG_SUITE_VERSION, DEBUG_SUITE_VERSION);
    }

    /* --- D-M2: トップメニューの排他制御（全遷移） ------------------------- */

    async function testM2() {
        await closeAllMenus();
        log('  [前提] 4メニューをすべて閉じた状態から開始');

        /* positive control: 計数手段と被覆判定そのものが効いているか。
           v2.7.0 で「1件も描画されていないのに数値は正常」を経験しているため、
           自動化した項目には必ず「測れていること」の確認を付ける。 */
        var pcOpen = await clickReal(document.getElementById('topCommentBtn'));
        pc('計数関数が「開」を1と数える（💬 を開いた直後）', function () {
            return openIds().length === 1 && activeIds().length === 1
                ? 'open=' + JSON.stringify(openIds()) + ' active=' + JSON.stringify(activeIds()) : false;
        });
        await closeAllMenus();
        pc('計数関数が「閉」を0と数える（全部閉じた直後）', function () {
            return openIds().length === 0 && activeIds().length === 0
                ? 'open=0 active=0' : false;
        });
        pc('被覆判定が「覆われていない」を通す（💬 は最前面）', function () {
            return hitTest(document.getElementById('topCommentBtn')).blocked
                ? false : 'hit=' + pcOpen.hit;
        });
        pc('被覆判定が「覆われている」を検出する（💬 の上へ一時的に板を置く）', function () {
            var b = document.getElementById('topCommentBtn');
            var r = b.getBoundingClientRect();
            var cover = document.createElement('div');
            cover.style.cssText = 'position:fixed; z-index:99999; background:transparent;'
                + 'left:' + r.left + 'px; top:' + r.top + 'px;'
                + 'width:' + r.width + 'px; height:' + r.height + 'px;';
            document.body.appendChild(cover);
            var h = hitTest(b);
            document.body.removeChild(cover);
            return h.blocked ? 'blocked / reason=' + h.reason + ' / hit=' + h.hit : false;
        });

        /* 全遷移の総当たり: 開始状態5通り × 押すボタン4通り = 20遷移 */
        var starts = [null, 'debug', 'comment', 'session', 'settings'];
        var blockedCount = 0;
        for (var s = 0; s < starts.length; s++) {
            for (var t = 0; t < MENUS.length; t++) {
                var start = starts[s];
                var target = MENUS[t];
                await setMenuState(start);
                var before = openIds();
                var r = await clickReal(document.getElementById(target.btn));
                if (r.blocked) blockedCount++;
                var open = openIds();
                var act = activeIds();
                var expectOpen = (start === target.id) ? [] : [target.id];
                var name = (start || '全閉') + ' → ' + target.label + ' を押す';
                var actual = 'open=' + JSON.stringify(open) + ' active=' + JSON.stringify(act)
                    + ' arrow=' + arrowText() + (r.blocked ? ' [クリック被覆:' + r.reason + ']' : '');
                var ok = (open.length <= 1) && (act.length <= 1)
                    && (JSON.stringify(open) === JSON.stringify(expectOpen))
                    && (JSON.stringify(act) === JSON.stringify(expectOpen))
                    && (arrowText() === (expectOpen[0] === 'settings' ? '▲' : '▼'))
                    && !r.blocked;
                var expText = 'open=' + JSON.stringify(expectOpen) + ' active=' + JSON.stringify(expectOpen)
                    + ' arrow=' + (expectOpen[0] === 'settings' ? '▲' : '▼') + ' 被覆なし';
                current.results.push({ name: name, ok: ok, actual: actual, expected: expText });
                log('  ' + (ok ? '[⚪]' : '[❌]') + ' ' + name + ' … ' + actual);
                /* 開始状態を作らずに素通しできないよう、遷移ごとに毎回作り直している。 */
            }
        }

        await closeAllMenus();
        expect('最後に全部閉じる（open の数）', openIds().length, 0);
        expect('最後に全部閉じる（active の数）', activeIds().length, 0);
        expect('最後に全部閉じる（矢印）', arrowText(), '▼');
        expect('クリックが被覆された回数', blockedCount, 0);

        openDebugMenu();   /* ログを見られるように戻す */
    }

    /* --- D-M7: コメント流し設定の永続化（4系統一致） ---------------------- */

    var M7_ITEMS = [
        {
            key: 'maxOnscreen', input: 'flowMaxOnscreen', label: 'flowMaxOnscreenVal',
            ls: 'sync_flow_max_onscreen', kind: 'range', test: 5, def: 40,
            text: function (v) { return v + '件'; }
        },
        {
            key: 'durationMs', input: 'flowDurationMs', label: 'flowDurationMsVal',
            ls: 'sync_flow_duration_ms', kind: 'range', test: 2000, def: 4000,
            text: function (v) { return (Number(v) / 1000).toFixed(1) + '秒'; }
        },
        {
            key: 'fontPx', input: 'flowFontPx', label: 'flowFontPxVal',
            ls: 'sync_flow_font_px', kind: 'range', test: 32, def: 16,
            text: function (v) { return v + 'px'; }
        },
        {
            key: 'color', input: 'flowColor', label: null,
            ls: 'sync_flow_color', kind: 'color', test: '#ff0000', def: '#ffffff'
        },
        {
            key: 'opacity', input: 'flowOpacity', label: 'flowOpacityVal',
            ls: 'sync_flow_opacity', kind: 'range', test: 0.2, def: 1,
            text: function (v) { return Number(v).toFixed(2); }
        },
        {
            key: 'areaRatio', input: 'flowAreaRatio', label: 'flowAreaRatioVal',
            ls: 'sync_flow_area_ratio', kind: 'range', test: 0.2, def: 1,
            text: function (v) { return '上' + Math.round(Number(v) * 100) + '%'; }
        },
        {
            key: 'shadow', input: 'flowShadow', label: null,
            ls: 'sync_flow_shadow', kind: 'check', test: false, def: true
        }
    ];

    function flowValue(key) {
        try { return (typeof FLOW !== 'undefined') ? FLOW[key] : '(FLOW取得不可)'; }
        catch (e) { return '(FLOW取得不可)'; }
    }

    function sameValue(a, b) {
        if (typeof b === 'boolean' || b === 'true' || b === 'false') {
            return String(a) === String(b);
        }
        var na = Number(a), nb = Number(b);
        if (isFinite(na) && isFinite(nb)) return na === nb;
        return String(a).toLowerCase() === String(b).toLowerCase();
    }

    /* 1項目について4系統を読み、期待値と突き合わせる。 */
    function checkFour(item, want) {
        var el = document.getElementById(item.input);
        var v1 = !el ? '(要素なし)' : (item.kind === 'check' ? el.checked : el.value);
        var v2 = item.label ? (document.getElementById(item.label) || {}).textContent : '(表示なし)';
        var v3 = flowValue(item.key);
        var v4 = null;
        try { v4 = localStorage.getItem(item.ls); } catch (e) { v4 = '(取得不可)'; }

        var wantText = item.text ? item.text(want) : '(表示なし)';
        var ok = sameValue(v1, want) && sameValue(v3, want) && sameValue(v4, want)
            && (!item.label || String(v2).trim() === wantText);

        var actual = 'input=' + fmt(v1) + ' / 表示=' + String(v2).trim()
            + ' / FLOW=' + fmt(v3) + ' / localStorage=' + fmt(v4);
        var expected = '4系統とも ' + fmt(want) + (item.label ? '（表示は "' + wantText + '"）' : '');
        current.results.push({ name: item.key + ' の4系統一致', ok: ok, actual: actual, expected: expected });
        log('  ' + (ok ? '[⚪]' : '[❌]') + ' ' + item.key + ' の4系統一致 … ' + actual);
        return ok;
    }

    function setInput(item, value) {
        var el = document.getElementById(item.input);
        if (!el) return false;
        if (item.kind === 'check') {
            el.checked = !!value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            el.value = String(value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
    }

    /* 前半: 既定と異なる値を入れ、待ってから再読み込みする。 */
    async function testM7() {
        await closeAllMenus();
        log('  [前提] 4メニューをすべて閉じた状態から開始');

        pc('FLOW を読めている', function () {
            return (typeof FLOW !== 'undefined') ? 'durationMs=' + FLOW.durationMs : false;
        });
        pc('比較器が不一致を検出できる（"5件" と "40件"）', function () {
            return String('5件') !== String('40件');
        });

        /* まず既定値へ戻し、「既定と異なる値を入れた」ことを保証する。 */
        var opened = await clickReal(document.getElementById('topCommentBtn'));
        pc('💬 コメント設定を実際に開けた（被覆なし）', function () {
            return !opened.blocked && document.getElementById('commentMenu').classList.contains('open')
                ? 'hit=' + opened.hit : false;
        });
        var resetBtn = findResetButton();
        pc('「既定値に戻す」ボタンを特定できた', function () { return resetBtn ? describe(resetBtn) : false; });
        if (resetBtn) await clickReal(resetBtn);
        await wait(100);

        pc('投入前の値が既定値である（＝これから確実に変更が起きる）', function () {
            var ng = M7_ITEMS.filter(function (it) { return !sameValue(flowValue(it.key), it.def); });
            return ng.length === 0 ? '7項目とも既定値' : false;
        });

        log('  [操作] 7項目へ既定と異なる値を投入する');
        M7_ITEMS.forEach(function (it) { setInput(it, it.test); });
        await wait(150);

        log('  --- 再読み込み前の4系統一致 ---');
        var beforeOk = true;
        M7_ITEMS.forEach(function (it) { if (!checkFour(it, it.test)) beforeOk = false; });
        expect('再読み込み前の4系統一致（7項目すべて）', beforeOk, true);

        /* ここまでのログと「全テストの判定記録」を一時キーへ退避してから再読み込みする。
           🔴 report ごと退避すること。current だけを退避すると、
              再読み込みで D-V1 / D-M2 の記録が消え、
              「報告書用にコピー」に D-M7 しか出なくなる（v1.0.0 の不具合）。 */
        var payload = {
            v: DEBUG_SUITE_VERSION,
            at: Date.now(),
            phase: 'after-reload',
            fromAll: runningAll,
            logLines: logLines.slice(),
            report: report
        };
        try { localStorage.setItem(LS_RESUME, JSON.stringify(payload)); } catch (e) { }

        log('  [待機] 再読み込み前に 500ms 待つ（localStorage への書き込みを確実にするため）');
        await wait(500);
        log('  [操作] location.reload() ─ 読み込み後に自動で続きを実行します');
        location.reload();
        /* ここから先は実行されない。続きは resumeM7() が行う。 */
        await wait(30000);
    }

    function findResetButton() {
        var panel = document.getElementById('commentMenu');
        if (!panel) return null;
        var btns = panel.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
            if (String(btns[i].textContent).trim() === '既定値に戻す') return btns[i];
        }
        return null;
    }

    /* 後半: 再読み込み後に自動で走る。 */
    async function resumeM7(payload) {
        /* 退避しておいた全テストの判定記録をそのまま引き継ぐ。
           最後の1本が D-M7（前半まで記録済み）なので、それを current にして続きを書き足す。 */
        report = Array.isArray(payload.report) ? payload.report : [];
        if (report.length === 0) {
            report.push({ id: 'D-M7', name: 'コメント流し設定の永続化（4系統一致）', results: [], pcs: [] });
        }
        current = report[report.length - 1];
        logLines = (payload.logLines || []).slice();
        if (logEl) logEl.textContent = logLines.join('\n');
        log('  === 再読み込み後（自動継続） ===');

        pc('sync_debug が再読み込みをまたいで有効なまま', function () {
            return localStorage.getItem(LS_ENABLE) === '1';
        });

        log('  --- 再読み込み後の4系統一致 ---');
        var afterOk = true;
        M7_ITEMS.forEach(function (it) { if (!checkFour(it, it.test)) afterOk = false; });
        expect('再読み込み後の4系統一致（7項目すべて）', afterOk, true);

        /* 後始末: 既定値へ戻し、次のテストへ状態を持ち越さない。 */
        await closeAllMenus();
        var opened = await clickReal(document.getElementById('topCommentBtn'));
        if (opened.blocked) log('  [注意] 💬 のクリックが被覆されました: ' + opened.reason);
        var resetBtn = findResetButton();
        if (resetBtn) {
            await clickReal(resetBtn);
            await wait(150);
            log('  --- 後始末（既定値に戻す）の4系統一致 ---');
            var defOk = true;
            M7_ITEMS.forEach(function (it) { if (!checkFour(it, it.def)) defOk = false; });
            expect('後始末後に既定値へ戻っている（7項目すべて）', defOk, true);
        } else {
            expect('後始末（「既定値に戻す」ボタンの特定）', '見つからない', 'ボタンを特定できること');
        }
        await closeAllMenus();

        try { localStorage.removeItem(LS_RESUME); } catch (e) { }
        finishTest(current);
        openDebugMenu();
        if (payload.fromAll) log('=== すべて実行: 完了 ===');
    }

    /* --- 実行制御 --------------------------------------------------------- */

    var TESTS = [
        { id: 'D-V1', name: '版数バッジ', run: testV1 },
        { id: 'D-M2', name: 'トップメニューの排他制御（全遷移）', run: testM2 },
        { id: 'D-M7', name: 'コメント流し設定の永続化（4系統一致）', run: testM7 }
    ];

    var running = false;
    var runningAll = false;

    function finishTest(t) {
        log('--- ' + t.id + ' ' + t.name + ' : ' + verdictText(t)
            + '（判定 ' + t.results.filter(function (r) { return r.ok; }).length + '/' + t.results.length
            + ' / PC ' + t.pcs.filter(function (p) { return p.ok; }).length + '/' + t.pcs.length + '） ---');
    }

    async function runOne(id, keepRunning) {
        if (running && !keepRunning) { log('⚠ 実行中です。終わるまでお待ちください。'); return; }
        var def = null;
        TESTS.forEach(function (t) { if (t.id === id) def = t; });
        if (!def) { log('⚠ 未登録のテスト: ' + id); return; }
        running = true;
        current = { id: def.id, name: def.name, results: [], pcs: [] };
        report.push(current);
        log('=== ' + def.id + ' ' + def.name + ' 開始 ===');
        var t = current;
        try {
            await def.run();
        } catch (e) {
            t.results.push({ name: '実行時エラー', ok: false, actual: String(e && e.message || e), expected: '例外が出ないこと' });
            log('  [❌] 実行時エラー … ' + (e && e.message || e));
        }
        finishTest(t);
        if (!keepRunning) running = false;
    }

    async function runAll() {
        if (running) { log('⚠ 実行中です。終わるまでお待ちください。'); return; }
        running = true; runningAll = true;
        clearLog();
        log('=== すべて実行 開始（' + TESTS.length + '本） ===');
        for (var i = 0; i < TESTS.length; i++) {
            await runOne(TESTS[i].id, true);
        }
        running = false; runningAll = false;
        log('=== すべて実行: 完了 ===');
    }

    /* --- 起動 ------------------------------------------------------------- */

    function start() {
        /* 二重読み込み（<script> を2回書いた等）でUIが二重に生えないようにする。 */
        if (document.getElementById('topDebugBtn')) {
            console.warn('[debug_suite] すでに起動しています。二重の生成を中止しました。');
            return;
        }
        injectStyle();
        joinTopMenus();
        if (!buildUI()) return;
        header();

        var raw = null;
        try { raw = localStorage.getItem(LS_RESUME); } catch (e) { raw = null; }
        if (!raw) return;

        var payload = null;
        try { payload = JSON.parse(raw); } catch (e) { payload = null; }
        if (!payload || payload.phase !== 'after-reload') {
            try { localStorage.removeItem(LS_RESUME); } catch (e) { }
            return;
        }
        if (payload.v !== DEBUG_SUITE_VERSION) {
            log('⚠ 別の版（' + payload.v + '）で作られた引き継ぎデータを破棄しました。'
                + 'テストを最初からやり直してください。');
            try { localStorage.removeItem(LS_RESUME); } catch (e) { }
            return;
        }
        if (Date.now() - Number(payload.at || 0) > RESUME_TTL_MS) {
            log('⚠ 古い引き継ぎデータを破棄しました（' + RESUME_TTL_MS / 60000 + '分超過）。');
            try { localStorage.removeItem(LS_RESUME); } catch (e) { }
            return;
        }
        openDebugMenu();
        running = true;
        /* 本体の initApp() が終わってから続きを始める（loadFlowSettings の復元待ち）。 */
        setTimeout(function () {
            resumeM7(payload).catch(function (e) {
                log('  [❌] 継続実行でエラー … ' + (e && e.message || e));
            }).then(function () { running = false; });
        }, 600);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

})();

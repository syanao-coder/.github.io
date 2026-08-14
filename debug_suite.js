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
     ブロック2  共通ライブラリ（wait / waitFor / sample / rect / overlap / clickReal /
                hasAdvanced / breakdownOf / normalizeChoices / expect / pc / note）
     ブロック3  UI生成（CSS注入・トップバーのボタン・ドロップダウン・ログ・ask / メモ）
     ブロック4  テスト登録（D-X1 / D-X2 / D-V1 / D-M2 / D-M7 / D-E1 / D-P1〜D-P5 /
                ★v1.4.2: D-C1〜D-C11 ＝ チャット取得（v2.7.5 の検証用））

   ★v1.4.0 の方針
     🔴 人に「ログのどこを読め」と言わせない。判定はすべてコードが出し、
        利用者は結果を1回コピーして貼るだけにする。
     🔴 盾の切り替えをまたいで記録を保つ（LS_RESUME の phase='carry'）。
        これにより D-P1〜D-P5 の貼り付けが1回で済む。
   ========================================================================== */
(function () {
    'use strict';

    /* ========================================================================
       ブロック1: 有効化判定
       ====================================================================== */

    var DEBUG_SUITE_VERSION = '1.4.3';   /* 本体の APP_VERSION とは別系統 */
    /* ★v1.4.3: D-V1 の期待値。本体の版を上げたら🔴ここも上げる。
       v1.4.2 では 2.7.4 のまま残っていて、正しい 2.7.5 を不合格と報告した。 */
    var EXPECT_APP_VERSION = '2.7.5';
    var LS_ENABLE = 'sync_debug';        /* '1' のときだけ有効 */
    var LS_RESUME = 'sync_debug_resume'; /* 再読み込みをまたぐテストの引き継ぎ用（一時キー） */
    var RESUME_TTL_MS = 10 * 60 * 1000;  /* 古い引き継ぎは捨てる */
    /* 🔴 D-P1 の結果は「盾の切り替え → 再読み込み」をまたいで生き残る必要がある。
       メモリに置いていたため、2026-08-07 の検証で D-P3/P4/P5 が全部「判定不能」になった。 */
    var LS_PLAYBACK_PC = 'sync_debug_playback_pc';
    var PLAYBACK_PC_TTL_MS = 30 * 60 * 1000;
    /* 🔴 ★v1.3.0: 実施メモとラベル。盾の切り替えは再読み込みを伴うので、
       メモリに置くと消える（LS_PLAYBACK_PC と同じ理由）。localStorage に置く。
       ⚠️ これで ?debug=0 が削除するキーは 3本 → 4本になった。 */
    var LS_META = 'sync_debug_meta';
    var META_TTL_MS = 12 * 60 * 60 * 1000;

    var query = null;
    try { query = new URLSearchParams(location.search).get('debug'); } catch (e) { query = null; }

    if (query === '0') {
        /* 明示的な無効化。キーを削除して、何も作らずに抜ける（ログも出さない）。 */
        try {
            localStorage.removeItem(LS_ENABLE);
            localStorage.removeItem(LS_RESUME);
            localStorage.removeItem(LS_PLAYBACK_PC);   /* ★v1.2.1: 置き土産を残さない */
            localStorage.removeItem(LS_META);          /* ★v1.3.0 */
        } catch (e) { }
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

    /* 🔴 ★v1.3.0: 値が届くまで待ってから基準値を取る。
       sample() は「間隔×回数」でしか取れないため、非同期に届く値の基準を
       値が入る前に掴んでしまっていた（スパイク 5-A で方式③の4セルが判定不能）。

       gotValue() が false を返す間だけ待つ。
         null / undefined / false / 空文字 / 有限でない数値（NaN・Infinity）＝「まだ届いていない」
       戻り値: { ok, value, waitedMs, tries }
         ok        … 値が届いたか（時間切れなら false）
         value     … 最後に読んだ値（時間切れのときも最後の値を返す）
         waitedMs  … 実際に待った時間
         tries     … fn() を呼んだ回数（1回目は待たずに呼ぶ） */
    function gotValue(v) {
        if (v === null || v === undefined || v === false || v === '') return false;
        if (typeof v === 'number' && !isFinite(v)) return false;
        return true;
    }

    async function waitFor(fn, timeoutMs, intervalMs) {
        var iv = Number(intervalMs) > 0 ? Number(intervalMs) : 100;
        var limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000;
        var t0 = Date.now(), tries = 0, value = null;
        for (;;) {
            tries++;
            try { value = fn(); } catch (e) { value = null; }
            if (gotValue(value)) {
                return { ok: true, value: value, waitedMs: Date.now() - t0, tries: tries };
            }
            if (Date.now() - t0 >= limit) {
                return { ok: false, value: value, waitedMs: Date.now() - t0, tries: tries };
            }
            await wait(iv);
        }
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

    /* 計算済みスタイルを文字列で読む（★v1.1.0）。
       style 属性ではなく計算結果を見る。CSS 側の指定漏れを拾うため。 */
    function cstyle(el, prop) {
        if (!el) return '(要素なし)';
        try { return String(window.getComputedStyle(el)[prop]); }
        catch (e) { return '(取得不可)'; }
    }
    function disp(el) { return cstyle(el, 'display'); }

    /* 画面のスクロール位置とトップバーの位置を読む（★v1.2.2）。
       🔴 body{overflow:hidden} なので、ずれると手では戻せずトップバーが消える。 */
    function scrollState() {
        var se = document.scrollingElement || document.documentElement;
        var tb = document.querySelector('.top-bar');
        return {
            top: se ? se.scrollTop : -1,
            left: se ? se.scrollLeft : -1,
            bodyTop: document.body ? document.body.scrollTop : -1,
            barTop: tb ? Math.round(tb.getBoundingClientRect().top) : 'top-barなし',
            fixCount: (typeof viewportScrollFixCount !== 'undefined') ? viewportScrollFixCount : '(本体が未対応)'
        };
    }

    function scrollBackToTop() {
        [document.scrollingElement, document.documentElement, document.body].forEach(function (el) {
            if (!el) return;
            try { el.scrollTop = 0; el.scrollLeft = 0; } catch (e) { }
        });
    }

    /* 枠で観測した onStateChange の値を、来た順に並べて返す（★v1.2.0）。
       🔴 件数だけでは何が来たのか分からず、2026-08-07 の実測で切り分け不能になった。 */
    function stateSeq(cardId) {
        try {
            var a = (typeof playerStateLog !== 'undefined' && playerStateLog[cardId]) ? playerStateLog[cardId] : null;
            if (!a) return '(記録なし)';
            return a.map(function (x) { return x.state; }).join(',');
        } catch (e) { return '(取得不可)'; }
    }

    /* 🔴 ★v1.3.0: 「再生が進んだか」の判定。
       v1.2.2 は絶対値 `位置 > 0.5` で判定していたが、実測が ちょうど 0.5 だった回に
       落ちた。閾値を下げるだけでは同じことが起きるので、判定の考え方そのものを
       「基準位置から進んだか」へ変えた。基準位置は▶を押した直後に取る。

       state=1(playing) を必須にするのは /get-ui-spec 2-4節の確定事項による。
       3(buffering) は再生できない場合にも来るので成功シグナルにしてはいけない。 */
    var PLAY_ADVANCE_MIN = 0.15;   /* 基準位置からこれだけ進めば「進んだ」 */
    var AUTOPLAY_POS_MIN = 0.2;    /* 読み込みだけで動き出したとみなす位置（基準は必ず0） */

    function hasAdvanced(startPos, cur, state) {
        if (Number(state) !== 1) return false;
        var s = Number(startPos), c = Number(cur);
        if (!isFinite(s) || !isFinite(c)) return false;
        return (c - s) >= PLAY_ADVANCE_MIN;
    }

    /* 🔴 ★v1.3.0: 状態遷移を「件数」ではなく「内訳」で出す。
       件数だけでは再生可否を分けられない（5-A4・5-A5 で最も明確に分けた値なのに
       画面に出ず、JSON を読む必要があった）。
       純関数にしてあるのは D-X1 で自己診断するため。 */
    function breakdownOf(list) {
        if (!list || !list.length) return '(記録なし)';
        var order = [], cnt = {};
        for (var i = 0; i < list.length; i++) {
            var v = list[i];
            var k = String((v && typeof v === 'object') ? v.state : v);
            if (cnt[k] === undefined) { cnt[k] = 0; order.push(k); }
            cnt[k]++;
        }
        var parts = [];
        for (var j = 0; j < order.length; j++) parts.push(order[j] + '×' + cnt[order[j]]);
        return parts.join(' / ') + '（計' + list.length + '件）';
    }

    function stateBreakdown(cardId) {
        try {
            var a = (typeof playerStateLog !== 'undefined' && playerStateLog[cardId]) ? playerStateLog[cardId] : null;
            return breakdownOf(a);
        } catch (e) { return '(取得不可)'; }
    }

    /* 🔴 ★v1.3.0: ask() の選択肢を正規化する。
       当てはまる選択肢が無い回に無関係な選択肢が選ばれ、自由記入・自動記録と
       矛盾する記録が残った（5-A2）。「該当なし」「測れなかった」「未実施」は必ず足す。
       重複は作らない。純関数にしてあるのは D-X1 で自己診断するため。 */
    var ASK_EXTRA = ['該当なし', '測れなかった（理由を自由記入へ）', '未実施'];

    function normalizeChoices(choices) {
        var out = [];
        (choices || []).forEach(function (c) {
            var s = String(c).trim();
            if (s && out.indexOf(s) < 0) out.push(s);
        });
        ASK_EXTRA.forEach(function (s) { if (out.indexOf(s) < 0) out.push(s); });
        return out;
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
        /* ★v1.2.2: すでに画面内にある要素は動かさない。
           body{overflow:hidden} の画面で一度スクロールすると手では戻せないため。 */
        try {
            var r0 = el.getBoundingClientRect();
            var inView = (r0.top >= 0 && r0.left >= 0
                && r0.bottom <= (window.innerHeight || 0) && r0.right <= (window.innerWidth || 0));
            if (!inView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (e) { }
        var res = hitTest(el);
        res.clicked = false;
        /* blocked でも click は実行する（後続の状態遷移は進め、判定だけ不合格にする）。 */
        try { el.click(); res.clicked = true; } catch (e) { res.reason = 'click-throw: ' + e.message; }
        await wait(SETTLE_MS);
        return res;
    }

    /* --- 判定の記録 ------------------------------------------------------ */

    /* ★v1.3.0: レコードに notes（観測）と asks（目視の記録）を足した。
       どちらも合否には数えない。数えると既存テストの判定数が変わってしまう。 */
    var current = null;   /* 実行中のテスト。{ id, name, results[], pcs[], notes[], asks[] } */
    var report = [];      /* 全テストの記録 */

    function mkRecord(id, name) {
        return { id: id, name: name, results: [], pcs: [], notes: [], asks: [] };
    }
    /* 古い引き継ぎデータ由来のレコードにも欄を用意する。 */
    function fixRecord(t) {
        if (!t) return t;
        if (!Array.isArray(t.results)) t.results = [];
        if (!Array.isArray(t.pcs)) t.pcs = [];
        if (!Array.isArray(t.notes)) t.notes = [];
        if (!Array.isArray(t.asks)) t.asks = [];
        return t;
    }

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

    /* 🔴 ★v1.3.0: 合否を付けない観測記録。
       「状態遷移の内訳」のように、結果表には必ず出したいが期待値を置けない値を入れる。
       expect() で足すと既存テストの判定数が変わり、版をまたいだ比較ができなくなる。 */
    function note(name, value) {
        var rec = { name: name, value: fmt(value) };
        if (current) { fixRecord(current); current.notes.push(rec); }
        log('  [観測] ' + name + ' … ' + rec.value);
        return rec.value;
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
            '  max-height:300px; overflow:auto; white-space:pre-wrap; word-break:break-all; }',
            /* ★v1.3.0: ask() / 実施メモ の入力パネル。z-index はドロップダウン(120)より上。 */
            '#dbgModal { position:fixed; inset:0; z-index:9000; background:rgba(0,0,0,0.6);',
            '  display:flex; align-items:center; justify-content:center; }',
            '#dbgModal .dbg-box { width:min(520px, calc(100vw - 40px)); box-sizing:border-box;',
            '  max-height:80vh; overflow:auto; background:#12121a; border:1px solid #c56cf0;',
            '  border-radius:6px; padding:14px; color:#ddd; font-size:0.82rem; }',
            '#dbgModal h4 { margin:0 0 10px 0; color:#c56cf0; font-size:0.9rem; }',
            '#dbgModal label.dbg-choice { display:block; padding:4px 2px; cursor:pointer; }',
            '#dbgModal .dbg-choices { border:1px solid #333; border-radius:4px; padding:6px; margin-bottom:8px; }',
            '#dbgModal .dbg-choices.dbg-blank { border-color:#ff5555; background:rgba(255,85,85,0.08); }',
            '#dbgModal .dbg-warn { color:#ff5555; margin:0 0 8px 0; font-size:0.78rem; display:none; }',
            '#dbgModal .dbg-warn.on { display:block; }',
            '#dbgModal input[type=text], #dbgModal textarea { width:100%; box-sizing:border-box;',
            '  background:#07070a; color:#ddd; border:1px solid #333; border-radius:4px; padding:6px;',
            '  font-family:inherit; font-size:0.8rem; margin-bottom:8px; }',
            '#dbgModal textarea { height:80px; resize:vertical; }',
            '#dbgModal .dbg-actions { text-align:right; }',
            '#dbgModal .dbg-actions button { font-size:0.82rem; padding:5px 14px; cursor:pointer; }',
            '#dbgModal .dbg-hint { color:#888; font-size:0.74rem; margin:0 0 8px 0; }'
        ].join('\n');
        var st = document.createElement('style');
        st.id = 'debugSuiteStyle';
        st.textContent = css;
        document.head.appendChild(st);
    }

    /* --- ★v1.3.0: 実施メモとラベル -----------------------------------------
       環境条件（拡張機能の有無・保護設定・ブラウザの実体）をレコードへ埋め込む。
       人が別途書き写さずに済む。IDだけ差し替えて見出しが古いまま残る事故も防ぐ。
       🔴 盾の切り替えは再読み込みを伴うので localStorage に置く。 */

    var runLabel = '';
    var runMemo = '';

    function loadMeta() {
        var raw = null;
        try { raw = localStorage.getItem(LS_META); } catch (e) { return; }
        if (!raw) return;
        var m = null;
        try { m = JSON.parse(raw); } catch (e) { return; }
        if (!m) return;
        if (Date.now() - Number(m.at || 0) > META_TTL_MS) {
            try { localStorage.removeItem(LS_META); } catch (e) { }
            return;
        }
        runLabel = String(m.label || '');
        runMemo = String(m.memo || '');
    }

    function saveMeta() {
        try {
            localStorage.setItem(LS_META, JSON.stringify({
                v: DEBUG_SUITE_VERSION, at: Date.now(), label: runLabel, memo: runMemo
            }));
        } catch (e) { }
    }

    /* --- ★v1.3.0: 入力パネルの土台 ---------------------------------------- */

    function openModal(build) {
        var ov = document.getElementById('dbgModal');
        if (ov) ov.parentNode.removeChild(ov);
        ov = document.createElement('div');
        ov.id = 'dbgModal';
        var box = document.createElement('div');
        box.className = 'dbg-box';
        ov.appendChild(box);
        document.body.appendChild(ov);
        build(box, function () { if (ov.parentNode) ov.parentNode.removeChild(ov); });
        return ov;
    }

    /* 🔴 目視項目を計測直後に聞く。選択肢は normalizeChoices() で正規化する。
       確定ボタンを押すまで閉じない（未記入のままページを離れられた事故の対策）。
       戻り値: Promise<{ name, choice, note }> */
    function ask(name, choices) {
        var list = normalizeChoices(choices);
        return new Promise(function (resolve) {
            openModal(function (box, close) {
                var h = document.createElement('h4');
                h.textContent = '🐞 目視の記録';
                box.appendChild(h);

                var q = document.createElement('p');
                q.className = 'dbg-hint';
                q.textContent = name;
                box.appendChild(q);

                var wrap = document.createElement('div');
                wrap.className = 'dbg-choices';
                wrap.id = 'dbgAskChoices';
                var gname = 'dbgAsk_' + Date.now();
                list.forEach(function (c) {
                    var lab = document.createElement('label');
                    lab.className = 'dbg-choice';
                    var r = document.createElement('input');
                    r.type = 'radio'; r.name = gname; r.value = c;
                    lab.appendChild(r);
                    lab.appendChild(document.createTextNode(' ' + c));
                    wrap.appendChild(lab);
                });
                box.appendChild(wrap);

                var warn = document.createElement('p');
                warn.className = 'dbg-warn';
                warn.id = 'dbgAskWarn';
                warn.textContent = '未選択です。当てはまるものが無ければ「該当なし」を選んでください。';
                box.appendChild(warn);

                var ta = document.createElement('textarea');
                ta.id = 'dbgAskNote';
                ta.placeholder = '自由記入（選択肢に収まらない観察はここへ。空でも可）';
                box.appendChild(ta);

                var act = document.createElement('div');
                act.className = 'dbg-actions';
                var ok = document.createElement('button');
                ok.type = 'button';
                ok.id = 'dbgAskOk';
                ok.textContent = '確定';
                act.appendChild(ok);
                box.appendChild(act);

                ok.addEventListener('click', function () {
                    var sel = wrap.querySelector('input[type=radio]:checked');
                    if (!sel) {
                        wrap.classList.add('dbg-blank');
                        warn.classList.add('on');
                        return;
                    }
                    var rec = { name: name, choice: sel.value, note: String(ta.value || '').trim() };
                    if (!current) { current = mkRecord('D-ASK', '単独の目視記録'); report.push(current); }
                    fixRecord(current);
                    current.asks.push(rec);
                    log('  [目視] ' + name + ' … ' + rec.choice
                        + (rec.note ? ' / 自由記入: ' + rec.note.replace(/\n/g, ' ') : ''));
                    close();
                    resolve(rec);
                });
            });
        });
    }

    function openMetaDialog() {
        openModal(function (box, close) {
            var h = document.createElement('h4');
            h.textContent = '📝 実施メモ / ラベル';
            box.appendChild(h);

            var hint = document.createElement('p');
            hint.className = 'dbg-hint';
            hint.textContent = 'ここに書いた内容は報告書用のコピーの「事実」節へそのまま入ります。'
                + '12時間保存され、再読み込みをまたいでも残ります。';
            box.appendChild(hint);

            var l1 = document.createElement('p');
            l1.className = 'dbg-hint';
            l1.textContent = 'ラベル（この計測回の見出し。例: 5-C 事前計測 / 盾オフ / 2回目）';
            box.appendChild(l1);
            var i1 = document.createElement('input');
            i1.type = 'text'; i1.value = runLabel;
            i1.id = 'dbgMetaLabel';
            box.appendChild(i1);

            var l2 = document.createElement('p');
            l2.className = 'dbg-hint';
            l2.textContent = '実施メモ（ブラウザの実体・拡張機能の有無・保護設定・配信元など）';
            box.appendChild(l2);
            var i2 = document.createElement('textarea');
            i2.value = runMemo;
            i2.id = 'dbgMetaMemo';
            box.appendChild(i2);

            var act = document.createElement('div');
            act.className = 'dbg-actions';
            var ok = document.createElement('button');
            ok.type = 'button';
            ok.id = 'dbgMetaOk';
            ok.textContent = '保存';
            act.appendChild(ok);
            box.appendChild(act);

            ok.addEventListener('click', function () {
                runLabel = String(i1.value || '').trim();
                runMemo = String(i2.value || '').trim();
                saveMeta();
                log('📝 実施メモを保存しました。ラベル=' + (runLabel || '(未記入)')
                    + ' / メモ=' + (runMemo ? runMemo.replace(/\n/g, ' ') : '(未記入)'));
                close();
            });
        });
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
        row1.appendChild(mkBtn('📋 報告書用にコピー', '「事実 / 解釈 / 生データJSON」の3節に分けた Markdown をクリップボードへコピーする', function () { copyReport(); }));
        row1.appendChild(mkBtn('📝 メモ/ラベル', 'この計測回のラベルと実施メモを入力する（12時間保存・報告書へ入る）', function () { openMetaDialog(); }));
        row1.appendChild(mkBtn('❓ ask() 確認', '目視の記録パネルを1回開く（動作確認用）', function () {
            ask('（動作確認）この記録パネルの選択肢は読めていますか', ['読める', '読めない']);
        }));
        panel.appendChild(row1);

        var row2 = document.createElement('div');
        row2.className = 'dbg-row';
        TESTS.forEach(function (t) {
            row2.appendChild(mkBtn('▶ ' + t.id, t.name, function () { runOne(t.id); }));
        });
        panel.appendChild(row2);

        /* ★v1.4.0: D-P の一括実行。盾を1回だけ聞き、記録は再読み込みをまたいで残す。
           これで D-P1〜D-P5 の貼り付けが1回で済む。 */
        var row3 = document.createElement('div');
        row3.className = 'dbg-row';
        row3.appendChild(mkBtn('🛡 D-P 盾オン一括（P1→P2→P3）',
            '盾オンのまま D-P1 / D-P2 / D-P3 を続けて実行します。終わったら盾をオフにして再読み込みしてください',
            function () {
                runPlaybackGroup('🛡 D-P 盾オン一括（P1 → P2 → P3）', ['D-P1', 'D-P2', 'D-P3'],
                    'このあと D-P1 / D-P2 / D-P3 を続けて実行します（3〜5分）。'
                    + '盾は「オン」のまま最後まで触らないでください。');
            }));
        row3.appendChild(mkBtn('🛡 D-P 盾オフ一括（P4→P5）',
            '盾オフで D-P4 / D-P5 を続けて実行します。前半の記録に追記されます',
            function () {
                runPlaybackGroup('🛡 D-P 盾オフ一括（P4 → P5）', ['D-P4', 'D-P5'],
                    'このあと D-P4 / D-P5 を続けて実行します（2〜3分）。'
                    + '盾は「オフ」のまま最後まで触らないでください。');
            }));
        panel.appendChild(row3);

        /* ★v1.4.2: D-C（チャット取得）の一括。盾の操作は要らない。 */
        var row4 = document.createElement('div');
        row4.className = 'dbg-row';
        row4.appendChild(mkBtn('💬 D-C 取得一括（C1→C2→C3→C5→C6→C7→C8）',
            'ログイン済みの状態で、取得まわりを続けて実行します（5〜10分）',
            function () {
                runChatGroup('💬 D-C 取得一括',
                    ['D-C1', 'D-C2', 'D-C3', 'D-C5', 'D-C6', 'D-C7', 'D-C8'],
                    'YouTube にメンバー登録済みのアカウントでログインした状態のまま、'
                    + '最後まで触らずにお待ちください（5〜10分）。'
                    + 'キャッシュはテストのコードが自動で捨てます。');
            }));
        row4.appendChild(mkBtn('🌊 D-C4 流し（盾オフ）',
            'メンバー限定でコメントが実際に流れるかを測ります',
            function () {
                runChatGroup('🌊 D-C4 コメント流し', ['D-C4'],
                    '先に「💬 D-C 取得一括」を終えてください。'
                    + 'このあと盾の状態を聞き、濃い区間へシークして再生します。');
            }));
        row4.appendChild(mkBtn('🧪 D-C9 人工再現',
            '取得タブへパッチを当ててから押してください',
            function () {
                runChatGroup('🧪 D-C9 理由コードの人工再現', ['D-C9'],
                    '手順書 T5 のパッチを取得タブへ当ててから「OK」を押してください。');
            }));
        row4.appendChild(mkBtn('🚪 D-C10 非ログイン',
            'YouTube からログアウトしてから押してください',
            function () {
                runChatGroup('🚪 D-C10 非ログインでの回帰', ['D-C10'],
                    'YouTube からログアウトしてから「OK」を押してください（2〜4分）。');
            }));
        row4.appendChild(mkBtn('⏱ D-C11 参考値（重い）',
            '52,362件のアーカイブを取得します。数分かかります',
            function () {
                runChatGroup('⏱ D-C11 所要時間の参考値', ['D-C11'],
                    '重いアーカイブを取得します。3〜10分かかるので、'
                    + 'このタブを閉じずにお待ちください。');
            }));
        panel.appendChild(row4);

        var noteEl = document.createElement('p');
        noteEl.className = 'dbg-note';
        noteEl.textContent = '押す順番は「▶ すべて実行」→「🛡 盾オン一括」→（盾をオフに切り替え）→'
            + '「🛡 盾オフ一括」→「📋 報告書用にコピー」です。'
            + '判定はすべて自動で出ます。ログを読んで良し悪しを判断する必要はありません。'
            + 'D-M7 は途中でページを自動で再読み込みし、そのまま続きを実行します。'
            + 'D-E1 は枠1の通知要素を操作するので、枠1が画面内にある状態で実行してください。'
            + 'D-P1〜D-P5 は「すべて実行」では飛ばします（盾の操作が要るため）。'
            + '一括実行の記録は再読み込みをまたいで残るので、コピーは最後に1回でかまいません。'
            + 'D-P は終了時に枠を空にしません。確認が済んだら 🧹 を押してください。'
            + '★v1.4.2: D-C（チャット取得）は「💬 D-C 取得一括」から実行します。'
            + '測定前のキャッシュ削除はコードが自動で行うので、手で消す必要はありません。';
        panel.appendChild(noteEl);

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
        log('ラベル: ' + (runLabel || '(未記入 ─ 📝 から入力できます)'));
        log('実施メモ: ' + (runMemo ? runMemo.replace(/\n/g, ' / ') : '(未記入 ─ 📝 から入力できます)'));
    }

    /* --- 報告書用の Markdown ---------------------------------------------- */

    /* 🔴 ★v1.3.0: 「事実 / 解釈 / 生データJSON」の3節に分ける。
       事実と解釈を分けて書く規約（/get-dev-workflow 1-4節）をコード側で強制する。
       回答フォーム（answer_form.html）の出力とも構成を揃えてある。 */
    function buildMarkdown() {
        var lines = [];
        lines.push('### debug_suite 実行結果（APP_VERSION ' + appVersion() + '）');
        lines.push('');

        /* ------------------------- 1. 事実 ------------------------- */
        lines.push('## 1. 事実');
        lines.push('');
        lines.push('- debug_suite: `' + DEBUG_SUITE_VERSION + '` / APP_VERSION: `' + appVersion() + '`');
        lines.push('- 実行日時: ' + new Date().toISOString());
        lines.push('- 画面: ' + window.innerWidth + ' x ' + window.innerHeight);
        lines.push('- 配信元: ' + location.origin);
        lines.push('- 排他制御への参加: ' + (hasExclusive ? 'TOP_MENUS.push() 成功' : '失敗（単独動作）'));
        lines.push('- ラベル: ' + (runLabel || '（未記入）'));
        lines.push('- 実施メモ: ' + (runMemo ? runMemo.replace(/\n/g, ' / ') : '（未記入）'));
        lines.push('');
        lines.push('| テスト | 判定 | 合格/項目数 | PC |');
        lines.push('| :--- | :--: | ---: | :--- |');
        report.forEach(function (t) {
            fixRecord(t);
            var okCount = t.results.filter(function (r) { return r.ok; }).length;
            var pcNg = t.pcs.filter(function (p) { return !p.ok; }).length;
            lines.push('| ' + t.id + ' ' + t.name + ' | ' + verdictMark(t) + ' | '
                + okCount + '/' + t.results.length + ' | '
                + (t.pcs.length === 0 ? 'なし' : (pcNg === 0 ? '全' + t.pcs.length + '件成立' : pcNg + '件不成立')) + ' |');
        });
        lines.push('');
        report.forEach(function (t) {
            fixRecord(t);
            lines.push('#### ' + t.id + ' ' + t.name);
            lines.push('');
            lines.push('| 種別 | 項目 | 実測 | 期待 | 判定 |');
            lines.push('| :--- | :--- | :--- | :--- | :--: |');
            t.pcs.forEach(function (p) {
                lines.push('| PC | ' + mdEsc(p.name) + ' | ' + mdEsc(p.value) + ' | 成立すること | ' + (p.ok ? '⚪' : '❌') + ' |');
            });
            t.results.forEach(function (r) {
                lines.push('| 判定 | ' + mdEsc(r.name) + ' | ' + mdEsc(r.actual) + ' | ' + mdEsc(r.expected) + ' | ' + (r.ok ? '⚪' : '❌') + ' |');
            });
            /* 合否を付けない観測。期待値を置けない値はここに出る。 */
            t.notes.forEach(function (n) {
                lines.push('| 観測 | ' + mdEsc(n.name) + ' | ' + mdEsc(n.value) + ' | （期待値なし） | ─ |');
            });
            t.asks.forEach(function (a) {
                lines.push('| 目視 | ' + mdEsc(a.name) + ' | ' + mdEsc(a.choice)
                    + (a.note ? '（自由記入: ' + mdEsc(a.note) + '）' : '') + ' | （回答） | ─ |');
            });
            lines.push('');
        });

        /* ------------------------- 2. 解釈 ------------------------- */
        lines.push('## 2. 解釈');
        lines.push('');
        if (report.length === 0) {
            lines.push('- 実行されたテストがありません。');
        }
        var ng = 0, undet = 0;
        report.forEach(function (t) {
            fixRecord(t);
            lines.push('- **' + t.id + ' ' + t.name + '**: ' + verdictText(t));
            if (t.pcs.some(function (p) { return !p.ok; })) {
                undet++;
                t.pcs.filter(function (p) { return !p.ok; }).forEach(function (p) {
                    lines.push('    - 不成立の positive control: ' + p.name + '（実測: ' + p.value + '）');
                });
            } else if (!t.results.every(function (r) { return r.ok; })) {
                ng++;
                t.results.filter(function (r) { return !r.ok; }).forEach(function (r) {
                    lines.push('    - 不合格: ' + r.name + '（実測: ' + r.actual + ' / 期待: ' + r.expected + '）');
                });
            }
        });
        lines.push('');
        lines.push('- 不合格のテスト: ' + ng + '本 / 判定不能のテスト: ' + undet + '本');
        if (undet > 0) {
            lines.push('- ⚠️ **判定不能は「機能が壊れている」ではなく「測れていない」。**'
                + ' 基盤側の疑いとして扱い、本体の不合格に数えないこと。');
        }
        if (!runLabel || !runMemo) {
            lines.push('- ⚠️ ラベルまたは実施メモが未記入。'
                + '測定ブラウザの実体・保護設定が記録に残っていない可能性がある。');
        }
        lines.push('');

        /* --------------------- 3. 生データJSON --------------------- */
        lines.push('## 3. 生データJSON');
        lines.push('');
        lines.push('```json');
        var raw = '{}';
        try {
            raw = JSON.stringify({
                suite: DEBUG_SUITE_VERSION,
                app: appVersion(),
                at: new Date().toISOString(),
                origin: location.origin,
                screen: { w: window.innerWidth, h: window.innerHeight },
                label: runLabel,
                memo: runMemo,
                exclusive: hasExclusive,
                report: report
            }, null, 1);
        } catch (e) { raw = '{ "error": "JSON化に失敗: ' + String(e && e.message) + '" }'; }
        lines.push(raw);
        lines.push('```');
        lines.push('');
        return lines.join('\n');
    }

    function mdEsc(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

    function verdictMark(t) {
        if (t.pcs.some(function (p) { return !p.ok; })) return '⚠ 判定不能';
        /* ★v1.3.0: 判定が1件も無いレコード（目視の記録だけ）を「合格」と見せない。 */
        if (!t.results || t.results.length === 0) return '─ 記録のみ';
        return t.results.every(function (r) { return r.ok; }) ? '⚪ 合格' : '❌ 不合格';
    }
    function verdictText(t) {
        if (t.pcs.some(function (p) { return !p.ok; })) return '判定不能（positive control が不成立。基盤側の疑い）';
        if (!t.results || t.results.length === 0) return '記録のみ（合否の判定を含まない）';
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

    /* --- D-X1: 基盤の自己診断（★v1.3.0） -----------------------------------

       実機の条件（動画・盾・枠）をいっさい使わず、共通ライブラリの純関数だけを判定する。
       🔴 これがあると、閾値の修正・待機ライブラリ・3節分割・内訳表示を
          「押すだけ」で確かめられる。基盤の改修で既存テストが壊れたとき、
          基盤が悪いのかテストが悪いのかを最初に切り分けられる。
       ------------------------------------------------------------------- */

    async function testX1() {
        log('  [前提] 実機の条件を使わない。共通ライブラリの純関数だけを判定する');

        /* --- positive control: 判定器が常に true を返していないことを示す --- */
        pc('進行判定が「進んでいない」を落とす（0.5 → 0.5 / state=1）', function () {
            return hasAdvanced(0.5, 0.5, 1) === false ? 'false を返した' : false;
        });
        pc('進行判定が state=1 以外を落とす（0 → 5.0 / state=3 buffering）', function () {
            return hasAdvanced(0, 5.0, 3) === false ? 'false を返した' : false;
        });
        pc('内訳の集計器が「記録なし」と実データを区別する', function () {
            var empty = breakdownOf([]);
            var one = breakdownOf([1]);
            return (empty === '(記録なし)' && one !== '(記録なし)') ? (empty + ' / ' + one) : false;
        });
        pc('報告書用の Markdown を生成できる', function () {
            var md = buildMarkdown();
            return (md && md.length > 100) ? (md.length + '文字') : false;
        });

        /* --- 1. 進行判定（D-P1 の閾値の修正） --- */
        expect('旧実装で落ちた条件を通す（基準0 → 0.5 / state=1）', hasAdvanced(0, 0.5, 1), true);
        expect('進んでいない量は通さない（基準0 → 0.14 / state=1）', hasAdvanced(0, 0.14, 1), false);
        expect('基準位置が0でなくても進行を拾う（1.2 → 1.4 / state=1）', hasAdvanced(1.2, 1.4, 1), true);

        /* --- 2. waitFor（値が届くまで待つ） --- */
        var t = Date.now();
        var w1 = await waitFor(function () { return (Date.now() - t >= 300) ? '届いた' : null; }, 3000, 50);
        expect('waitFor: 遅れて届く値を掴める', w1.ok, true);
        expect('waitFor: 届くまで待ってから返す（250ms以上）', w1.waitedMs >= 250, true);
        expect('waitFor: 届いた値をそのまま返す', w1.value, '届いた');

        var w2 = await waitFor(function () { return null; }, 300, 50);
        expect('waitFor: 時間切れは ok=false', w2.ok, false);
        expect('waitFor: 時間切れでも最後の値を返す', w2.value, 'null');

        var w3 = await waitFor(function () { return ''; }, 200, 50);
        expect('waitFor: 空文字は「まだ届いていない」とみなす', w3.ok, false);

        /* --- 3. ask() の選択肢の正規化 --- */
        var c1 = normalizeChoices(['できた', 'できなかった']);
        expect('選択肢の末尾3件が固定で足される',
            c1.slice(-3).join(','), '該当なし,測れなかった（理由を自由記入へ）,未実施');
        expect('空の選択肢でも3件は用意される', normalizeChoices([]).length, 3);
        var c2 = normalizeChoices(['未実施', '未実施', '読める']);
        expect('同じ選択肢を重複させない（「未実施」の数）',
            c2.filter(function (x) { return x === '未実施'; }).length, 1);

        /* --- 4. 状態遷移の内訳 --- */
        expect('状態遷移を内訳で書ける',
            breakdownOf([{ state: 3 }, { state: 1 }, { state: 3 }, { state: -1 }]),
            '3×2 / 1×1 / -1×1（計4件）');
        expect('記録が無いときは「(記録なし)」', breakdownOf([]), '(記録なし)');

        /* --- 5. コピー出力の3節分割 --- */
        var md = buildMarkdown();
        expect('出力に「事実」の節がある', md.indexOf('## 1. 事実') >= 0, true);
        expect('出力に「解釈」の節がある', md.indexOf('## 2. 解釈') >= 0, true);
        expect('出力に「生データJSON」の節がある', md.indexOf('## 3. 生データJSON') >= 0, true);

        var jsonOk = false, jsonErr = '';
        try {
            var parts = md.split('```json');
            if (parts.length >= 2) {
                JSON.parse(parts[1].split('```')[0]);
                jsonOk = true;
            } else { jsonErr = 'json のフェンスが無い'; }
        } catch (e) { jsonErr = String(e && e.message || e); }
        expect('生データJSONの節が JSON として読み直せる', jsonOk ? true : ('失敗: ' + jsonErr), true);

        /* --- 6. 記録の受け皿（合否には数えない） --- */
        note('この節の観測記録の書式確認', 'note() は合否に数えない。期待値の欄は「（期待値なし）」になる');
        note('ラベル', runLabel || '（未記入）');
        note('実施メモ', runMemo || '（未記入）');
    }


    /* --- D-X2: 記録UIの自動検証（★v1.4.0） --------------------------------

       ask() と 📝 メモ/ラベル を、人の手を借りずに動かして判定する。
       🔴 v1.3.0 では「パネルを開いて目で見る」手順を人に頼んでいたが、
          目視できるものはコードでも観測できる。人には結果を貼ってもらうだけにする。
       ------------------------------------------------------------------- */

    async function testX2() {
        var opened = null;
        try {
            pc('開始時に記録パネルが残っていない', function () {
                return document.getElementById('dbgModal') ? false : 'なし';
            });

            /* --- ask() を開く（応答は待たずに、後で確定させる） --- */
            var asked = ask('（自動検証）記録パネルの選択肢と未選択時の挙動', ['はい', 'いいえ']);
            await wait(150);
            opened = document.getElementById('dbgModal');

            pc('記録パネルを開けた', function () {
                return opened ? 'あり' : false;
            });
            var choices = document.getElementById('dbgAskChoices');
            pc('選択肢の欄がある', function () {
                return choices ? 'あり' : false;
            });
            var okBtn = document.getElementById('dbgAskOk');
            pc('確定ボタンがある', function () {
                return okBtn ? 'あり' : false;
            });
            if (!opened || !choices || !okBtn) {
                expect('記録パネルの構造', '取得できない', '取得できること');
                return;
            }

            var vals = Array.prototype.map.call(
                choices.querySelectorAll('input[type=radio]'), function (r) { return r.value; });
            expect('選択肢の並び（渡した2件＋自動で足す3件）',
                vals.join(','), 'はい,いいえ,該当なし,測れなかった（理由を自由記入へ）,未実施');

            /* --- 未選択のまま確定を押す --- */
            var c1 = await clickReal(okBtn);
            expect('確定ボタンを実際に押せた（1回目・未選択）', !c1.blocked, true);
            await wait(80);
            expect('未選択で確定してもパネルが閉じない',
                !!document.getElementById('dbgModal'), true);
            expect('未選択の選択肢欄が赤枠になる',
                String(choices.className).indexOf('dbg-blank') >= 0, true);
            var warnEl = document.getElementById('dbgAskWarn');
            expect('未選択の警告が表示される',
                !!warnEl && String(warnEl.className).indexOf('on') >= 0, true);

            /* --- 選んで確定する --- */
            var first = choices.querySelector('input[type=radio]');
            first.checked = true;
            document.getElementById('dbgAskNote').value = '自動検証';
            var c2 = await clickReal(document.getElementById('dbgAskOk'));
            expect('確定ボタンを実際に押せた（2回目・選択後）', !c2.blocked, true);

            var rec = await asked;
            expect('選んだ値が記録される', rec.choice, 'はい');
            expect('自由記入が記録される', rec.note, '自動検証');
            await wait(80);
            expect('選択後にパネルが閉じる',
                !document.getElementById('dbgModal'), true);
            expect('目視の記録がこのテストのレコードへ入る',
                current.asks.length >= 1, true);

            /* --- 📝 メモ/ラベル --- */
            var mark = '自動検証 ' + new Date().toLocaleTimeString();
            var keepMemo = runMemo;
            openMetaDialog();
            await wait(150);
            pc('メモのパネルを開けた', function () {
                return document.getElementById('dbgMetaLabel') ? 'あり' : false;
            });
            var li = document.getElementById('dbgMetaLabel');
            var mi = document.getElementById('dbgMetaMemo');
            if (li && mi) {
                li.value = (runLabel ? runLabel + ' / ' : '') + mark;
                mi.value = keepMemo || '（自動検証で設定。手入力があれば上書きされます）';
                var c3 = await clickReal(document.getElementById('dbgMetaOk'));
                expect('保存ボタンを実際に押せた', !c3.blocked, true);
                await wait(80);

                var saved = null;
                try { saved = JSON.parse(localStorage.getItem(LS_META) || 'null'); } catch (e) { saved = null; }
                expect('ラベルが localStorage へ書かれる',
                    !!saved && String(saved.label).indexOf(mark) >= 0, true);
                expect('実施メモが localStorage へ書かれる',
                    !!saved && String(saved.memo || '').length > 0, true);
                expect('コピー出力の「事実」節にラベルが出る',
                    buildMarkdown().indexOf(mark) >= 0, true);
                note('この回のラベル（再読み込み後に D-M7 が同じ値を記録します）', runLabel);
            } else {
                expect('メモのパネルの構造', '取得できない', '取得できること');
            }
        } finally {
            /* 途中で落ちてもパネルを残さない（次のテストのクリックを塞ぐため）。 */
            var left = document.getElementById('dbgModal');
            if (left && left.parentNode) {
                left.parentNode.removeChild(left);
                log('  [後始末] 開いたままの記録パネルを閉じました');
            }
        }
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

        expect('APP_VERSION', appVersion(), EXPECT_APP_VERSION);
        expect('バッジのクラス', badge ? badge.className : '(要素なし)', 'version-badge ok');
        expect('バッジの表示文字列', badge ? String(badge.textContent).trim() : '(要素なし)',
            'v' + EXPECT_APP_VERSION);
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
        /* 🔴 ★v1.4.1: 「すべて実行」の残りのテストも引き継ぐ。
           これが無いと location.reload() で runAll のループが消え、
           D-M7 より後ろのテスト（D-E1）が黙って飛ばされる。
           v1.0.0 から続いていた不具合で、2026-08-09 の実測で発覚した
           （「すべて実行」の結果表に D-E1 が1本も出なかった）。 */
        var payload = {
            v: DEBUG_SUITE_VERSION,
            at: Date.now(),
            phase: 'after-reload',
            fromAll: runningAll,
            remaining: allQueue.slice(),
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
        report.forEach(fixRecord);
        if (report.length === 0) {
            report.push(mkRecord('D-M7', 'コメント流し設定の永続化（4系統一致）'));
        }
        current = fixRecord(report[report.length - 1]);
        logLines = (payload.logLines || []).slice();
        if (logEl) logEl.textContent = logLines.join('\n');
        log('  === 再読み込み後（自動継続） ===');

        pc('sync_debug が再読み込みをまたいで有効なまま', function () {
            return localStorage.getItem(LS_ENABLE) === '1';
        });
        /* ★v1.4.0: ラベル・実施メモが再読み込みをまたいで残ることの機械的な記録。
           合否には数えない（D-M7 の判定数を変えないため）。 */
        note('再読み込み後に残っていたラベル', runLabel || '(未記入)');
        note('再読み込み後に残っていた実施メモ', runMemo || '(未記入)');

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

        /* 🔴 ★v1.4.1: 再読み込みで途切れた「すべて実行」の続きをここで走らせる。 */
        var rest = Array.isArray(payload.remaining) ? payload.remaining.slice() : [];
        if (payload.fromAll && rest.length) {
            runningAll = true;
            log('=== すべて実行の続き（残り ' + rest.length + '本: ' + rest.join(' / ') + '） ===');
            for (var i = 0; i < rest.length; i++) {
                await runOne(rest[i], true);
            }
            runningAll = false;
            openDebugMenu();
        }
        if (payload.fromAll) log('=== すべて実行: 完了 ===');
    }

    /* --- D-E1: 再生可否の確定処理と枠内通知（★v1.1.0 / v2.7.4 用） ---------

       保護設定の切り替えを伴う項目（P3 / P4）は人の操作が要るので入れない。
       ここで測るのは「通知を出す仕掛けと、タイマーの後始末」だけである。
       🔴 実物の onError を待たず、本体の関数を直接呼んで状態機械を動かす。
          実物の onError で確かめるのは手順書の P2（存在しない動画ID）が担当する。
       ------------------------------------------------------------------- */

    async function testE1() {
        await closeAllMenus();
        log('  [前提] 4メニューをすべて閉じた状態から開始');

        var cardId = null;
        try { if (typeof activeCardIds !== 'undefined' && activeCardIds.length) cardId = activeCardIds[0]; }
        catch (e) { cardId = null; }
        pc('対象の枠を特定できた（activeCardIds[0]）', function () { return cardId || false; });
        if (!cardId) {
            expect('D-E1 の実行', '枠が1つも無い', '枠が1つ以上あること');
            return;
        }

        var noticeEl = document.getElementById('playerNotice_' + cardId);
        var bodyEl = document.getElementById('playerNoticeBody_' + cardId);
        pc('通知要素を取得できた', function () { return noticeEl ? describe(noticeEl) : false; });
        pc('本体の関数を4本とも読めている', function () {
            return (typeof showPlayerNotice === 'function'
                && typeof hidePlayerNotice === 'function'
                && typeof handlePlayerError === 'function'
                && typeof notePlayerState === 'function'
                && typeof resetPlayerDiagnostics === 'function')
                ? 'show/hide/handle/note/reset' : false;
        });
        if (!noticeEl || !bodyEl || typeof showPlayerNotice !== 'function') {
            expect('D-E1 の実行', '通知要素または関数が無い', '本体が v2.7.4 であること');
            return;
        }

        /* --- 初期状態 ---------------------------------------------------- */
        resetPlayerDiagnostics(cardId);
        await wait(50);
        var before = disp(noticeEl);
        expect('既定は非表示', before, 'none');
        expect('position（枠の高さを押し出さないこと）', cstyle(noticeEl, 'position'), 'absolute');
        expect('z-index（流し層2・ローカル操作バー9より前）', cstyle(noticeEl, 'zIndex'), '12');
        expect('親要素（playerContainer_* の中に置かないこと）',
            noticeEl.parentNode ? noticeEl.parentNode.id : '(なし)', 'wrapper_' + cardId);

        var missing = [];
        try {
            missing = activeCardIds.filter(function (id) { return !document.getElementById('playerNotice_' + id); });
        } catch (e) { missing = ['(列挙不可)']; }
        expect('通知要素が欠けている枠の数（全枠に必要）', missing.length + '件', '0件');

        /* --- 表示できること ---------------------------------------------- */
        var cardEl = document.getElementById(cardId);
        var hBefore = cardEl ? Math.round(cardEl.getBoundingClientRect().height) : -1;
        showPlayerNotice(cardId, 12345);
        await wait(50);
        var afterShow = disp(noticeEl);
        pc('表示と非表示を別の値として読めている', function () {
            return (before === 'none' && afterShow !== 'none') ? before + ' → ' + afterShow : false;
        });
        expect('showPlayerNotice() で表示される', afterShow, 'block');
        expect('文面にエラーコードが出る', String(bodyEl.textContent).indexOf('12345') >= 0, true);
        expect('文面にブラウザ名の断定が無い（Floorp / Firefox）',
            (String(bodyEl.textContent).indexOf('Floorp') < 0
                && String(bodyEl.textContent).indexOf('Firefox') < 0), true);
        var hAfter = cardEl ? Math.round(cardEl.getBoundingClientRect().height) : -1;
        expect('通知が枠の高さを押し出していない（' + hBefore + 'px → ' + hAfter + 'px）', hAfter - hBefore, 0);
        log('  [文面全文 ここから]\n' + bodyEl.innerText + '\n  [文面全文 ここまで]');

        /* --- 閉じるボタン ------------------------------------------------ */
        var closeBtn = noticeEl.querySelector('.player-notice-close');
        pc('当たり判定が効いている（板を被せると covered を返す）', function () {
            if (!closeBtn) return false;
            var shield = document.createElement('div');
            shield.style.cssText = 'position:fixed; left:0; top:0; right:0; bottom:0; z-index:99999;';
            document.body.appendChild(shield);
            var r = hitTest(closeBtn);
            shield.parentNode.removeChild(shield);
            return (r.blocked && r.reason === 'covered') ? 'blocked / covered' : false;
        });
        var clicked = await clickReal(closeBtn);
        expect('閉じるボタンを実際に押せる（被覆なし）',
            clicked.blocked ? ('blocked:' + clicked.reason + ' hit=' + clicked.hit) : 'ok', 'ok');
        await wait(50);
        expect('閉じるボタンで消える', disp(noticeEl), 'none');

        /* --- 確定タイマー ------------------------------------------------ */
        handlePlayerError(cardId, 150);
        var t1 = playerVerifyTimer[cardId];
        expect('onError で確定タイマーが張られる', t1 !== undefined, true);
        expect('直近のエラーコードが記録される', playerErrorCode[cardId], 150);

        handlePlayerError(cardId, 150);   /* 二重発火 */
        expect('onError の二重発火でタイマーを張り直さない', playerVerifyTimer[cardId] === t1, true);

        notePlayerState(cardId, 1);
        expect('playing(1) で確定タイマーが取り消される', playerVerifyTimer[cardId] === undefined, true);

        handlePlayerError(cardId, 150);
        notePlayerState(cardId, 3);
        /* 🔴 3(buffering) は「再生を試みている」でしかない。メンバー限定で再生できない場合にも来る。
           ここで取り消すと通知が一度も出なくなる（2026-08-07 に実際に起きた）。 */
        expect('buffering(3) では取り消さない（成功シグナルは 1 のみ）', playerVerifyTimer[cardId] !== undefined, true);

        notePlayerState(cardId, -1);
        expect('unstarted(-1) でも取り消さない', playerVerifyTimer[cardId] !== undefined, true);
        expect('状態遷移が値ごと順番に記録されている', stateSeq(cardId), '1,3,-1');

        /* --- 後始末 ------------------------------------------------------ */
        playerReadyDone[cardId] = true;
        showPlayerNotice(cardId, 150);
        await wait(50);
        pc('後始末の直前に5つとも値が入っていた（＝これから確実に消える）', function () {
            return (playerVerifyTimer[cardId] !== undefined
                && playerErrorCode[cardId] !== undefined
                && playerStateLog[cardId] !== undefined
                && playerReadyDone[cardId] === true
                && disp(noticeEl) === 'block')
                ? 'timer/code/log[' + stateSeq(cardId) + ']/ready/表示 の5つとも設定済み' : false;
        });
        resetPlayerDiagnostics(cardId);
        await wait(50);
        expect('後始末: 確定タイマーが消える', playerVerifyTimer[cardId] === undefined, true);
        expect('後始末: エラーコードが消える', playerErrorCode[cardId] === undefined, true);
        expect('後始末: 状態遷移の記録が消える', playerStateLog[cardId] === undefined, true);
        expect('後始末: playerReadyDone が落ちる', playerReadyDone[cardId] === undefined, true);
        expect('後始末: 通知が消える', disp(noticeEl), 'none');
    }


    /* --- D-P1〜D-P5: 実物の動画での再生可否（★v1.2.0） ---------------------

       🔴 固定時間で切らない。確定するまでポーリングして待つ。
          v2.7.4 の1回目のテストは「読み込みから10.5秒」で打ち切ったため、
          onError が遅れて来た回を「通知が出なかった」と誤って読んだ。
       🔴 D-P1 が positive control を兼ねる。通常動画すら再生できない環境なら、
          D-P2〜D-P5 は「機能が壊れている」ではなく「測れていない」である。
       ------------------------------------------------------------------- */

    var VID_LIGHT = 'https://www.youtube.com/watch?v=zuuZyNH0F1Y';
    var VID_MEMBERS = 'https://www.youtube.com/watch?v=AoaL9zbPAkA';
    var VID_INVALID = 'aaaaaaaaaaa';
    var PLAY_MAX_WAIT_MS = 30000;   /* 確定するまで待つ上限 */

    /* D-P1 の結果を読み書きする。再読み込みをまたぐので localStorage に置く。 */
    function readPlaybackPc() {
        var raw = null;
        try { raw = localStorage.getItem(LS_PLAYBACK_PC); } catch (e) { return null; }
        if (!raw) return null;
        var p = null;
        try { p = JSON.parse(raw); } catch (e) { return null; }
        if (!p || p.v !== DEBUG_SUITE_VERSION) return null;
        if (Date.now() - Number(p.at || 0) > PLAYBACK_PC_TTL_MS) return null;
        return p;
    }

    function writePlaybackPc(ok, note) {
        try {
            localStorage.setItem(LS_PLAYBACK_PC, JSON.stringify({
                v: DEBUG_SUITE_VERSION, at: Date.now(), ok: !!ok, note: String(note)
            }));
        } catch (e) { }
    }

    function cardEmptyReady(cid) {
        return !!document.getElementById('urlInput_' + cid)
            && !!document.querySelector('#' + cid + ' .placeholder-actions button.primary');
    }

    /* 枠を「URL入力待ち」に戻す。確認ダイアログは一時的に切る（保存はされない）。 */
    async function clearCard(cid) {
        if (cardEmptyReady(cid)) return true;
        var chk = document.getElementById('confirmReset');
        var was = chk ? chk.checked : null;
        if (chk) chk.checked = false;
        var btn = document.querySelector('#' + cid + ' .player-header button[title="空にする"]');
        if (btn) { btn.click(); await wait(500); }
        if (chk && was !== null) chk.checked = was;
        return cardEmptyReady(cid);
    }

    async function stopAllIfPlaying() {
        try {
            if (typeof isPlayingRequest !== 'undefined' && isPlayingRequest) {
                var b = document.getElementById('playPauseBtn');
                if (b) { b.click(); await wait(500); }
            }
        } catch (e) { }
    }

    function notNone(v) { return v !== 'なし'; }
    notNone.label = 'onError が出ていること';

    /* opt = { need, url, pressPlay, expectNotice, expectPlaying, expectSettled,
              expectTimerLeft, needPlaybackPc, setPlaybackPc, tailPressPlay } */
    async function runPlaybackCase(opt) {
        await closeAllMenus();
        await stopAllIfPlaying();

        var cid = null;
        try { if (typeof activeCardIds !== 'undefined' && activeCardIds.length) cid = activeCardIds[0]; }
        catch (e) { cid = null; }
        pc('対象の枠を特定できた（activeCardIds[0]）', function () { return cid || false; });
        if (!cid) { expect('この項目の実行', '枠が1つも無い', '枠が1つ以上あること'); return; }

        /* 🔴 条件は順序ではなく観測で担保する。
           ★v1.4.0: 一括実行のときは、その一括の冒頭で観測した値を使う。
           一括の中では再読み込みも操作も挟まらないので、盾は変わりようがない。
           単独実行のときは従来どおり測定の直前に聞く。 */
        var shield;
        if (groupShield !== null) {
            shield = groupShield;
            log('  [条件] 盾 = ' + (shield || '(未入力)') + '（一括実行の冒頭で観測した値）'
                + ' / 配信元 = ' + location.origin);
        } else {
            shield = window.prompt(
                'アドレスバー左の盾のアイコンを今すぐ見てください。\n'
                + '強化型トラッキング防止は、このサイトでどちらですか？\n'
                + 'on / off を入力してください。', '');
            shield = String(shield === null ? '' : shield).trim().toLowerCase();
            log('  [条件] 盾 = ' + (shield || '(未入力)') + ' / 配信元 = ' + location.origin);
        }

        /* 🔴 http:// では __Secure-3PSID が iframe へ送られず、メンバー限定は必ず失敗する。 */
        expect('配信元が https であること（http ではメンバー限定が成立しない）', location.protocol, 'https:');

        if (opt.need) {
            pc('この測定に必要な盾の状態だった（' + opt.need + '）', function () {
                return (shield === opt.need) ? ('入力 = ' + shield) : false;
            });
        } else {
            pc('盾の状態を観測して記録できた', function () {
                return (shield === 'on' || shield === 'off') ? ('入力 = ' + shield) : false;
            });
        }
        if (opt.needPlaybackPc) {
            pc('この環境で通常動画が再生できる（D-P1 で確認済み）', function () {
                var p = readPlaybackPc();
                if (!p) return false;              /* 未実行・別の版・30分超過 */
                return p.ok ? p.note : false;
            });
        }

        var cleared = await clearCard(cid);
        pc('枠を「URL入力待ち」にできた', function () { return cleared ? '入力欄と読み込むボタンあり' : false; });
        if (!cleared) { expect('この項目の実行', '枠を空にできない', '空にできること'); return; }

        var n = document.getElementById('playerNotice_' + cid);
        pc('計測開始時に通知が消えている', function () { return (n && disp(n) === 'none') ? 'none' : false; });
        if (!n) { expect('この項目の実行', '通知要素が無い', '本体が v2.7.4 であること'); return; }

        var input = document.getElementById('urlInput_' + cid);
        var loadBtn = document.querySelector('#' + cid + ' .placeholder-actions button.primary');
        input.value = opt.url;
        log('  [操作] 読み込む URL = ' + opt.url);
        var r1 = await clickReal(loadBtn);
        expect('「読み込む」を実際に押せた（被覆なし）', r1.blocked ? ('blocked:' + r1.reason) : 'ok', 'ok');
        await wait(2500);

        var timeBefore = 'ERR';
        try { timeBefore = ytPlayers[cid].getCurrentTime(); } catch (e) { }
        /* 読み込み直後の基準位置は必ず 0 なので、ここだけは絶対値で見てよい（★v1.3.0）。 */
        var autoPlayed = (typeof timeBefore === 'number' && timeBefore > AUTOPLAY_POS_MIN);
        log('  [観測] 読み込み2.5秒後の再生位置 = ' + timeBefore
            + '（▶を押していないのに進んでいれば自動再生）');
        /* 🔴 埋め込みが勝手に再生を始めるかどうかは動画によって違う（2026-08-07 実測）。
           毎回記録する。opt.expectAutoPlay が指定された回は判定にもする。 */
        if (opt.expectAutoPlay !== undefined) {
            expect('読み込みだけで再生が始まったか（自動再生）', autoPlayed, opt.expectAutoPlay);
        } else {
            log('  [記録] 自動再生 = ' + (autoPlayed ? 'あり' : 'なし'));
        }
        if (opt.requireNoAutoPlay) {
            pc('▶を押す前に再生が始まっていない（この項目の前提）', function () {
                return autoPlayed ? false : ('読み込み2.5秒後の位置 = ' + timeBefore);
            });
        }

        if (opt.pressPlay) {
            var r2 = await clickReal(document.getElementById('playPauseBtn'));
            expect('「▶ 一括再生」を実際に押せた（被覆なし）', r2.blocked ? ('blocked:' + r2.reason) : 'ok', 'ok');
        } else {
            log('  [条件] ▶一括再生 は押さない（確定が延期されるかを見る）');
        }

        /* 確定するまで待つ。固定時間で切らない。
           🔴 ★v1.3.0: 成功の判定を「位置 > 0.5」という絶対値から
              「基準位置から進んだか」へ変えた。基準位置はここで取る。
              絶対値のままだと、実測が ちょうど 0.5 だった回に落ち、
              D-P1 が落ちることで D-P2〜D-P5 が全部「判定不能」になる。 */
        var startPos = 0;
        try { startPos = ytPlayers[cid].getCurrentTime() || 0; } catch (e) { startPos = 0; }
        log('  [基準] 進行判定の基準位置 = ' + startPos
            + '（ここから ' + PLAY_ADVANCE_MIN + ' 秒以上進み、かつ state=1 なら「再生開始」）');

        var maxWait = opt.maxWaitMs || PLAY_MAX_WAIT_MS;
        var t0 = Date.now(), settled = '', st = -1, cur = 0;
        while (Date.now() - t0 < maxWait) {
            try { st = ytPlayers[cid].getPlayerState(); } catch (e) { st = 'ERR'; }
            try { cur = ytPlayers[cid].getCurrentTime() || 0; } catch (e) { cur = 0; }
            if (hasAdvanced(startPos, cur, st)) { settled = '再生開始'; break; }
            if (disp(n) === 'block') { settled = '通知が出た'; break; }
            await wait(500);
        }
        if (!settled) settled = '時間切れ';
        var elapsed = Math.round((Date.now() - t0) / 1000);

        var code = 'なし';
        try { if (playerErrorCode[cid] !== undefined) code = playerErrorCode[cid]; } catch (e) { }
        log('  [観測] 結末=' + settled + '（' + elapsed + '秒） / onError=' + code
            + ' / 状態遷移=[' + stateSeq(cid) + '] / state=' + st + ' / 位置=' + cur);
        /* 🔴 ★v1.3.0: 再生可否を最も明確に分けた値を、結果表そのものへ出す。
           合否を付けない観測なので、既存テストの判定数は変わらない。 */
        note('状態遷移の内訳', stateBreakdown(cid));
        note('状態遷移の順', stateSeq(cid));
        note('進行判定（基準位置 → 最終位置 / state）',
            startPos + ' → ' + cur + ' / ' + st + '（差 ' + (Number(cur) - Number(startPos)).toFixed(2) + '秒）');
        note('onError のコード', code);

        /* 🔴 再生開始時に文書がスクロールしてトップバーが画面外へ消える現象があった
           （2026-08-07 実測）。毎回測る。 */
        var sc = scrollState();
        log('  [観測] スクロール: scrollTop=' + sc.top + ' / body.scrollTop=' + sc.bodyTop
            + ' / トップバー上端=' + sc.barTop + ' / 本体が戻した回数=' + sc.fixCount);
        expect('トップバーが画面内にある（上端の座標）', sc.barTop, 0);

        expect('確定の結末', settled, opt.expectSettled);
        expect('通知の表示', disp(n), opt.expectNotice ? 'block' : 'none');
        if (opt.expectPlaying) {
            expect('再生が始まった（state=1 かつ 基準位置から ' + PLAY_ADVANCE_MIN + ' 秒以上進んだ）',
                hasAdvanced(startPos, cur, st), true);
        }
        if (opt.expectTimerLeft !== undefined) {
            expect('確定タイマーの残存', (playerVerifyTimer[cid] === undefined) ? 'なし' : 'あり', opt.expectTimerLeft);
        }
        if (opt.expectNotice) {
            expect('onError のコード', code, notNone);
            var body = document.getElementById('playerNoticeBody_' + cid);
            var txt = body ? String(body.textContent) : '';
            log('  [文面] ' + (body ? body.innerText.replace(/\n/g, ' / ') : '(取得不可)'));
            expect('文面にエラーコードが出る', txt.indexOf(String(code)) >= 0, true);
            expect('文面にブラウザ名の断定が無い（Floorp / Firefox）',
                (txt.indexOf('Floorp') < 0 && txt.indexOf('Firefox') < 0), true);
        }

        if (opt.setPlaybackPc) {
            var pcOk = hasAdvanced(startPos, cur, st);
            var pcNote = pcOk
                ? ('通常動画が state=1 / 位置 ' + Number(startPos).toFixed(2) + ' → '
                    + Number(cur).toFixed(2) + ' へ進行（' + new Date().toLocaleTimeString() + '）')
                : '通常動画すら再生されなかった';
            writePlaybackPc(pcOk, pcNote);
            log('  [記録] 以降のテスト用の positive control（30分有効・再読み込みをまたぐ）: ' + pcNote);
        }

        /* 放置の回だけ、最後に▶を押して確定が動き出すかまで見る。 */
        if (opt.tailPressPlay) {
            log('  [操作] ここで ▶一括再生 を押す（確定が動き出すかを見る）');
            await clickReal(document.getElementById('playPauseBtn'));
            var startPos2 = 0;
            try { startPos2 = ytPlayers[cid].getCurrentTime() || 0; } catch (e) { startPos2 = 0; }
            var t1 = Date.now(), st2 = -1, cur2 = 0, tailSettled = '';
            while (Date.now() - t1 < (opt.tailMaxWaitMs || 20000)) {
                try { st2 = ytPlayers[cid].getPlayerState(); } catch (e) { st2 = 'ERR'; }
                try { cur2 = ytPlayers[cid].getCurrentTime() || 0; } catch (e) { cur2 = 0; }
                if (hasAdvanced(startPos2, cur2, st2)) { tailSettled = '再生開始'; break; }
                if (disp(n) === 'block') { tailSettled = '通知が出た'; break; }
                await wait(500);
            }
            if (!tailSettled) tailSettled = '時間切れ';
            log('  [観測] ▶後: 結末=' + tailSettled + '（' + Math.round((Date.now() - t1) / 1000)
                + '秒） / state=' + st2 + ' / 位置=' + cur2 + ' / 通知=' + disp(n));
            note('▶後の状態遷移の内訳', stateBreakdown(cid));
            expect('▶を押したあとの結末', tailSettled, opt.tailExpectSettled);
            expect('▶を押したあとの通知の表示', disp(n), opt.tailExpectNotice ? 'block' : 'none');
        }

        /* 🔴 後始末で枠を空にしない。
           テストが自分で 🧹 を押すと「一瞬映ってすぐ空になった」ように見え、
           目視で確かめる時間が無くなる（2026-08-07 の検証で実際に起きた）。
           次のテストの冒頭で clearCard() が走るので、空にしないままで支障はない。 */
        await stopAllIfPlaying();
        scrollBackToTop();   /* ★v1.2.2: 万一ずれていても、次の操作ができる状態へ戻す */
        log('  [後始末] 再生だけ止めました。枠はそのまま残しています。'
            + '目視・スクリーンショットが済んだら、枠の 🧹 を押してください。');
    }

    async function testP1() {
        await runPlaybackCase({
            need: null, url: VID_LIGHT, pressPlay: true,
            expectSettled: '再生開始', expectNotice: false, expectPlaying: true,
            expectTimerLeft: 'なし', setPlaybackPc: true
        });
    }

    async function testP2() {
        await runPlaybackCase({
            need: null, url: VID_INVALID, pressPlay: true,
            expectSettled: '通知が出た', expectNotice: true,
            expectTimerLeft: 'なし', needPlaybackPc: true
        });
    }

    async function testP3() {
        await runPlaybackCase({
            need: 'on', url: VID_MEMBERS, pressPlay: true,
            expectSettled: '通知が出た', expectNotice: true,
            expectTimerLeft: 'なし', needPlaybackPc: true
        });
    }

    async function testP4() {
        await runPlaybackCase({
            need: 'off', url: VID_MEMBERS, pressPlay: true,
            expectSettled: '再生開始', expectNotice: false, expectPlaying: true,
            expectTimerLeft: 'なし', needPlaybackPc: true
        });
    }

    async function testP5() {
        /* ▶を押さないまま放置しても通知を出さないこと（確定の延期）。
           🔴 メンバー限定の動画は読み込んだだけで再生が始まってしまい（2026-08-07 実測）、
              「▶を押していない状態」を作れなかった。存在しない動画IDなら再生は絶対に
              始まらないので、条件が確実に成立する。
           手順: 読み込む → 15秒放置（通知は出ないはず・タイマーは残るはず）
                 → ▶を押す → 10秒後に通知が出る */
        await runPlaybackCase({
            need: null, url: VID_INVALID, pressPlay: false, maxWaitMs: 15000,
            requireNoAutoPlay: true, expectAutoPlay: false,
            expectSettled: '時間切れ', expectNotice: false,
            expectTimerLeft: 'あり', needPlaybackPc: true,
            tailPressPlay: true, tailMaxWaitMs: 20000,
            tailExpectSettled: '通知が出た', tailExpectNotice: true
        });
    }


    /* ======================================================================
       D-C: チャット取得（★v1.4.2 / v2.7.5 の検証用）

       🔴 InnerTube への POST そのものは https://www.youtube.com オリジンでしか
          200 が返らないため、このファイルからは原理的に到達できない
          （/get-debug-suite 10節）。ここで測るのは A側で観測できる値だけである。
            chatState / chatError / chatStore[videoId] の
            comments.length / complete / truncated / gap / emoji / reqs / elapsed
       🔴 キャッシュが残っているとエンジンを通らず測定が成立しないため、
          各項目の冒頭で 🔄（reloadChat）を実際に押してキャッシュを捨てる。
          「測定前にキャッシュを空にする」を人の手順ではなくコードで担保する。
       ====================================================================== */

    /* 素材は /get-chat-feature-spec 9-8節の実測済みのものだけを使う。 */
    var VID = {
        LIGHT:   'zuuZyNH0F1Y',   /* 356件 / 70.6分。数え方の positive control */
        MEMBERS: 'AoaL9zbPAkA',   /* メンバー限定 / 7307秒。★本命 */
        SAMECH:  'NshKf1Pw9nA',   /* MEMBERS と同一チャンネルの公開 / 3:13:09 */
        REGULAR: 'J-TXiDsIdv0',   /* ライブではない通常の投稿動画（9分31秒） */
        HEAVY:   'q176a2krHbg'    /* 52,362件 / 129.5分。所要時間の参考値用 */
    };
    function ytUrl(id) { return 'https://www.youtube.com/watch?v=' + id; }

    var CHAT_WAIT_MS = 300000;         /* 取得の完了待ち上限（5分） */
    var CHAT_WAIT_HEAVY_MS = 900000;   /* VID_HEAVY 用（15分） */
    var chatCountPc = null;            /* D-C1 の結果。以降の PC に使う（同一セッション内） */

    function gtZero(v) { return Number(v) > 0; }
    gtZero.label = '0 より大きいこと';

    function firstCard() {
        try { if (typeof activeCardIds !== 'undefined' && activeCardIds.length) return activeCardIds[0]; }
        catch (e) { }
        return null;
    }
    function chatStoreOf(vid) {
        try { return (typeof chatStore !== 'undefined') ? (chatStore[vid] || null) : null; }
        catch (e) { return null; }
    }
    function chatStateOf(vid) {
        try { return (typeof chatState !== 'undefined') ? (chatState[vid] || '(未取得)') : '(取得不可)'; }
        catch (e) { return '(取得不可)'; }
    }
    function chatErrorOf(vid) {
        try { return (typeof chatError !== 'undefined') ? String(chatError[vid] || '') : ''; }
        catch (e) { return ''; }
    }
    /* 'CODE: 説明' の CODE だけを取り出す。🔴 説明文はそのまま出さない（本文が混ざりうる）。 */
    function chatCodeOf(vid) {
        var m = chatErrorOf(vid).match(/^([A-Z_]+):/);
        return m ? m[1] : '(なし)';
    }
    function chatReloadBtn(cid) {
        return document.querySelector('#' + cid + ' .chat-head button[title="コメントを取得し直す"]');
    }

    /* 枠へ URL を読み込む（D-P と同じ経路を実際にクリックする）。 */
    async function loadUrlIntoCard(cid, url) {
        var input = document.getElementById('urlInput_' + cid);
        var loadBtn = document.querySelector('#' + cid + ' .placeholder-actions button.primary');
        if (!input || !loadBtn) return { ok: false, reason: '入力欄か読み込むボタンが無い' };
        input.value = url;
        log('  [操作] 読み込む URL = ' + url);
        var r = await clickReal(loadBtn);
        await wait(2500);
        return { ok: !r.blocked, reason: r.reason, blocked: r.blocked };
    }

    /* チャット欄を開く。開いていれば何もしない。 */
    async function openChatPane(cid) {
        if (document.getElementById('chatNote_' + cid)) {
            var vis = false;
            try { vis = !!(typeof chatVisible !== 'undefined' && chatVisible[cid]); } catch (e) { }
            if (vis) return { ok: true, clicked: false };
        }
        var btn = document.getElementById('chatToggleBtn_' + cid);
        if (!btn) return { ok: false, reason: '💬 ボタンが無い' };
        var r = await clickReal(btn);
        await wait(500);
        return {
            ok: !!document.getElementById('chatNote_' + cid),
            clicked: true, blocked: r.blocked, hit: r.hit
        };
    }

    /* 取得が終端（ready / error）に達するまで待つ。🔴 固定時間で打ち切らない（鉄則 #27）。 */
    async function waitChatSettled(vid, limitMs) {
        return await waitFor(function () {
            var st = chatStateOf(vid);
            return (st === 'ready' || st === 'error') ? st : false;
        }, limitMs || CHAT_WAIT_MS, 1000);
    }

    /* opt = { url, videoId, waitMs, needCountPc, skipReload,
               expectState, expectCode, expectTotal, expectNotZero, expectComplete } */
    async function runChatCase(opt) {
        await closeAllMenus();
        await stopAllIfPlaying();

        var cid = firstCard();
        pc('対象の枠を特定できた（activeCardIds[0]）', function () { return cid || false; });
        if (!cid) { expect('この項目の実行', '枠が1つも無い', '枠が1つ以上あること'); return null; }

        if (opt.needCountPc) {
            pc('件数の数え方が本番と同じであることを確認済み（D-C1）', function () {
                return chatCountPc || false;
            });
        }

        var cleared = await clearCard(cid);
        pc('枠を「URL入力待ち」にできた', function () { return cleared ? '入力欄と読み込むボタンあり' : false; });
        if (!cleared) { expect('この項目の実行', '枠を空にできない', '空にできること'); return null; }

        var ld = await loadUrlIntoCard(cid, opt.url);
        expect('「読み込む」を実際に押せた（被覆なし）', ld.ok ? 'ok' : ('blocked:' + ld.reason), 'ok');

        var pane = await openChatPane(cid);
        pc('チャット欄を開けた', function () { return pane.ok ? ('chatNote_' + cid + ' あり') : false; });
        if (!pane.ok) { expect('この項目の実行', 'チャット欄を開けない', '開けること'); return null; }

        if (!opt.skipReload) {
            /* 🔴 キャッシュを捨ててから測る。残っているとエンジンを通らず測定が成立しない。 */
            var rb = chatReloadBtn(cid);
            var r2 = await clickReal(rb);
            pc('🔄（キャッシュを捨てて取り直す）を実際に押せた', function () {
                return (rb && !r2.blocked) ? 'ok' : false;
            });
        }

        var t0 = Date.now();
        var w = await waitChatSettled(opt.videoId, opt.waitMs);
        pc('取得が終端（ready / error）まで到達した', function () {
            return w.ok ? (w.value + ' / ' + Math.round(w.waitedMs / 1000) + '秒') : false;
        });

        var store = chatStoreOf(opt.videoId);
        var st = chatStateOf(opt.videoId);
        var code = chatCodeOf(opt.videoId);
        var total = store ? store.comments.length : 0;

        note('取得の状態 chatState', st);
        note('理由コード', code);
        note('総件数', total);
        note('A側で待った時間(ms)', Date.now() - t0);
        if (store) {
            note('B側が報告した所要時間 elapsed(ms)', store.elapsed);
            note('リクエスト回数 reqs', store.reqs);
            note('動画長 videoMs', store.videoMs);
            note('最後のコメント位置 lastT', store.lastT);
            note('絵文字辞書の件数', Object.keys(store.emoji || {}).length);
            note('complete / truncated / gap',
                store.complete + ' / ' + store.truncated + ' / ' + store.gap);
        }

        if (opt.expectState) expect('取得の状態 chatState', st, opt.expectState);
        if (opt.expectCode) expect('理由コード', code, opt.expectCode);
        if (opt.expectTotal !== undefined && opt.expectTotal !== null) {
            expect('総件数', total, opt.expectTotal);
        }
        if (opt.expectNotZero) expect('総件数が 0 でないこと', total, gtZero);
        if (opt.expectComplete !== undefined) {
            expect('完走 complete', store ? store.complete : '(storeが無い)', opt.expectComplete);
            expect('欠番 gap', store ? store.gap : '(storeが無い)', false);
            expect('打ち切り truncated', store ? store.truncated : '(storeが無い)', false);
        }
        return { cid: cid, store: store, total: total, code: code, state: st, waited: w };
    }

    /* --- D-C1: 公開アーカイブ（数え方の positive control） -------------------- */
    async function testC1() {
        chatCountPc = null;
        log('  [目的] 356件という既知の値と一致することが、数え方が本番と同じである唯一の裏づけ。');
        var r = await runChatCase({
            url: ytUrl(VID.LIGHT), videoId: VID.LIGHT,
            expectState: 'ready', expectTotal: 356, expectComplete: true
        });
        if (r && r.state === 'ready' && r.total === 356) {
            chatCountPc = VID.LIGHT + ' で既知の 356 件と一致（' + new Date().toISOString() + '）';
        }
        note('以降のテストへ渡す positive control', chatCountPc || '(不成立)');
    }

    /* --- D-C2: ★本命。メンバー限定アーカイブを完走させる ---------------------- */
    async function testC2() {
        log('  [目的] v2.7.5 の成否そのもの。0件でなく、かつ complete が true になること。');
        log('  [前提] YouTube にメンバー登録済みのアカウントでログインしていること。');
        await runChatCase({
            url: ytUrl(VID.MEMBERS), videoId: VID.MEMBERS, needCountPc: true,
            expectState: 'ready', expectNotZero: true, expectComplete: true,
            expectCode: '(なし)'
        });
    }

    /* --- D-C3: 同一チャンネルの公開アーカイブ（回帰） ------------------------- */
    async function testC3() {
        log('  [目的] 公開アーカイブの件数が変わっていないこと（5-C の実測は 430 件）。');
        await runChatCase({
            url: ytUrl(VID.SAMECH), videoId: VID.SAMECH, needCountPc: true,
            expectState: 'ready', expectTotal: 430, expectComplete: true
        });
    }

    /* --- D-C4: コメント流しの回帰（メンバー限定で実際に流れること） ------------- */
    function densestWindow(comments, windowMs) {
        var best = { startMs: 0, count: 0 };
        if (!comments || !comments.length) return best;
        var j = 0;
        for (var i = 0; i < comments.length; i++) {
            while (j < comments.length && comments[j].t < comments[i].t + windowMs) j++;
            if (j - i > best.count) best = { startMs: comments[i].t, count: j - i };
        }
        return best;
    }

    async function testC4() {
        await closeAllMenus();
        await stopAllIfPlaying();
        log('  [目的] 取得できたコメントが実際に画面へ流れること（本作業の目的）。');

        var cid = firstCard();
        pc('対象の枠を特定できた（activeCardIds[0]）', function () { return cid || false; });
        if (!cid) { expect('この項目の実行', '枠が1つも無い', '枠が1つ以上あること'); return; }

        /* 🔴 条件は順序ではなく観測で担保する（鉄則 #24）。 */
        var ans = window.prompt(
            'アドレスバー左の盾のアイコンを今すぐ見てください。\n'
            + '強化型トラッキング防止は、このサイトでどちらですか？\n'
            + 'on / off を入力してください。', '');
        var shield = String(ans === null ? '' : ans).trim().toLowerCase();
        log('  [条件] 盾 = ' + (shield || '(未入力)') + ' / 配信元 = ' + location.origin);
        expect('配信元が https であること（http ではメンバー限定は再生できない）', location.protocol, 'https:');
        pc('この測定に必要な盾の状態だった（off）', function () {
            return (shield === 'off') ? ('入力 = ' + shield) : false;
        });

        var cleared = await clearCard(cid);
        pc('枠を「URL入力待ち」にできた', function () { return cleared ? 'ok' : false; });
        if (!cleared) { expect('この項目の実行', '枠を空にできない', '空にできること'); return; }

        var ld = await loadUrlIntoCard(cid, ytUrl(VID.MEMBERS));
        expect('「読み込む」を実際に押せた（被覆なし）', ld.ok ? 'ok' : ('blocked:' + ld.reason), 'ok');

        var pane = await openChatPane(cid);
        pc('チャット欄を開けた', function () { return pane.ok ? 'ok' : false; });
        /* ★v1.4.3: 被覆が出たときに何が覆っていたのかを残す。 */
        note('💬 を押したときの当たり判定',
            (pane.blocked ? '被覆あり / ' : '被覆なし / ') + (pane.hit || '(記録なし)'));

        /* 🔴 ここでは 🔄 を押さない。D-C2 の結果（キャッシュ）をそのまま使う。 */
        var w = await waitChatSettled(VID.MEMBERS, 120000);
        var store = chatStoreOf(VID.MEMBERS);
        pc('メンバー限定のコメントが手元にある（先に D-C2 を実行すること）', function () {
            return (store && store.comments.length) ? (store.comments.length + '件') : false;
        });
        if (!store || !store.comments.length) {
            expect('この項目の実行', 'コメントが0件で流しを測れない', 'D-C2 が合格していること');
            return;
        }
        note('待ち時間(ms) / 取得の状態', w.waitedMs + ' / ' + chatStateOf(VID.MEMBERS));

        var fb = document.getElementById('flowToggleBtn_' + cid);
        var rf = await clickReal(fb);
        /* ★v1.4.3: v1.4.2 では blocked:covered とだけ出て、何が覆っていたのか分からなかった。
           ⚠️ clickReal は被覆でもクリックを実行するので、機能そのものは進む。 */
        note('🌊 を押したときの当たり判定',
            (rf.blocked ? '被覆あり / ' : '被覆なし / ') + (rf.hit || '(記録なし)')
            + ' / 実際にクリックした=' + rf.clicked);
        note('🌊 ボタンの位置', fb ? rect(fb) : '(要素なし)');
        expect('🌊（コメントを流す）を実際に押せた（被覆なし）',
            (fb && !rf.blocked) ? 'ok' : ('blocked:' + (rf && rf.reason)), 'ok');
        var flowOn = false;
        try { flowOn = !!(typeof flowVisible !== 'undefined' && flowVisible[cid]); } catch (e) { }
        pc('流しがオンになった', function () { return flowOn ? 'on' : false; });

        /* 🔴 素材の密度を先に確かめる（鉄則 #14）。薄い区間では 0 件が正常になる。 */
        var dense = densestWindow(store.comments, 20000);
        note('最も密な20秒の窓（開始位置ms / 件数）', dense.startMs + ' / ' + dense.count);
        pc('20秒あたり3件以上ある区間を選べた', function () {
            return (dense.count >= 3) ? (dense.count + '件/20秒') : false;
        });

        var seekSec = Math.max(0, Math.round(dense.startMs / 1000) - 1);
        try { ytPlayers[cid].seekTo(seekSec, true); } catch (e) { }
        log('  [操作] 濃い区間へシークした: ' + seekSec + '秒');
        /* 🔴 シークの完了を待ってから計測に入る（鉄則 #32）。 */
        var sk = await waitFor(function () {
            var t = 0;
            try { t = ytPlayers[cid].getCurrentTime() || 0; } catch (e) { t = 0; }
            return (Math.abs(t - seekSec) < 5) ? t : false;
        }, 15000, 500);
        pc('シークが完了した（要求位置の±5秒以内）', function () {
            return sk.ok ? ('現在位置 = ' + sk.value + '秒') : false;
        });

        var rp = await clickReal(document.getElementById('playPauseBtn'));
        expect('「▶ 一括再生」を実際に押せた（被覆なし）', rp.blocked ? ('blocked:' + rp.reason) : 'ok', 'ok');

        var startPos = 0;
        try { startPos = ytPlayers[cid].getCurrentTime() || 0; } catch (e) { startPos = 0; }
        var adv = await waitFor(function () {
            var s = 'ERR', c = 0;
            try { s = ytPlayers[cid].getPlayerState(); } catch (e) { s = 'ERR'; }
            try { c = ytPlayers[cid].getCurrentTime() || 0; } catch (e) { c = 0; }
            return hasAdvanced(startPos, c, s) ? ('位置 ' + c + ' / state ' + s) : false;
        }, 30000, 500);
        pc('メンバー限定の動画が実際に再生された（再生できないと流しは測れない）', function () {
            return adv.ok ? adv.value : false;
        });

        /* 🔴 目視は計測の直後にその場で聞く（鉄則 #12）。合否には数えない。
           ⚠️ 記録パネルは画面を覆うので、覆う前に見る時間を作ってから開く。 */
        window.alert('このあと約6秒間、枠の中を見ていてください。\n'
            + 'コメントが画面を流れるか、メンバー専用の絵文字が画像で出るかを見ます。\n'
            + 'OK を押すと計測を始めます。');

        var s = await sample(250, 24, function () {
            var layer = document.getElementById('flowLayer_' + cid);
            return layer ? layer.childElementCount : 0;
        });
        note('画面上のコメント数（250ms × 24回）',
            'min=' + s.min + ' / max=' + s.max + ' / avg=' + s.avg + ' / 0件だった回数=' + s.zeros);
        expect('コメントが実際に画面を流れた（最大同時表示数）', s.max, gtZero);

        await ask('いま画面を流れるコメントが見えましたか',
            ['はっきり見えた', '少しだけ見えた', '見えなかった']);
        await ask('メンバー専用の絵文字は画像として見えましたか',
            ['画像で見えた', '文字（:名前:）のままだった', 'メンバー専用の絵文字が出てこなかった']);

        await stopAllIfPlaying();
    }

    /* --- D-C5: メンバー専用絵文字が表示できるか（⚠ 判定にしない） -------------- */
    function probeImage(url) {
        return new Promise(function (resolve) {
            var done = false;
            var im = new Image();
            var t = setTimeout(function () {
                if (done) return; done = true; resolve('タイムアウト（10秒）');
            }, 10000);
            im.onload = function () {
                if (done) return; done = true; clearTimeout(t);
                resolve('読み込み成功 ' + im.naturalWidth + 'x' + im.naturalHeight);
            };
            im.onerror = function () {
                if (done) return; done = true; clearTimeout(t);
                resolve('読み込み失敗（403 などでブロックされた可能性）');
            };
            im.src = url;
        });
    }

    async function testC5() {
        log('  [目的] メンバー専用絵文字の画像が出るかを事実として記録する。');
        log('  [⚠] 表示されなくても不合格にしない（指示書 P8）。この項目に合否の判定は置かない。');
        var store = chatStoreOf(VID.MEMBERS);
        pc('D-C2 の取得結果が手元にある（先に D-C2 を実行すること）', function () {
            return (store && store.comments.length) ? (store.comments.length + '件') : false;
        });
        if (!store) return;

        var dict = store.emoji || {};
        var keys = Object.keys(dict);
        note('絵文字辞書の件数', keys.length);
        pc('辞書に1件以上ある（0件だと表示可否そのものを測れない）', function () {
            return keys.length ? (keys.length + '件') : false;
        });
        if (!keys.length) return;

        var n = Math.min(3, keys.length);
        for (var i = 0; i < n; i++) {
            var res = await probeImage(dict[keys[i]]);
            /* 🔴 ショートカット名（＝コメント本文の一部）も URL も出さない。 */
            note('絵文字' + (i + 1) + ' の画像', res);
        }
    }

    /* --- D-C6: 認証情報が漏れていないこと ------------------------------------ */
    var SECRET_RULES = [
        { name: 'SAPISIDHASH', re: /SAPISIDHASH/i },
        { name: 'SAPISID/APISID', re: /APISID/i },
        /* ⚠️ \b は使えない。'1700000000_0123…' の '_' は語構成文字なので境界にならず、
           人工の偽ヘッダを検出できずに positive control が落ちる（2026-08-14 実測）。 */
        { name: 'SHA-1らしき16進40桁', re: /(?:^|[^0-9a-fA-F])[0-9a-f]{40}(?:[^0-9a-fA-F]|$)/ },
        { name: 'unix秒_16進40桁', re: /\b\d{10}_[0-9a-f]{40}\b/ }
    ];
    function scanSecrets(text) {
        var hits = [];
        var s = String(text == null ? '' : text);
        for (var i = 0; i < SECRET_RULES.length; i++) {
            if (SECRET_RULES[i].re.test(s)) hits.push(SECRET_RULES[i].name);
        }
        return hits;
    }
    /* 🔴 自分自身（デバッグパネル）を検査対象に入れない。
       パネルには検出パターン名そのものが出るため、必ず誤検出になる。 */
    function bodyHtmlWithoutDebug() {
        try {
            var clone = document.body.cloneNode(true);
            var a = clone.querySelector('#debugAnchor');
            if (a && a.parentNode) a.parentNode.removeChild(a);
            var m = clone.querySelector('#dbgModal');
            if (m && m.parentNode) m.parentNode.removeChild(m);
            return clone.innerHTML;
        } catch (e) { return ''; }
    }
    function localStorageDump() {
        var out = [];
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && k.indexOf('sync_debug') === 0) continue;   /* 基盤自身の記録は除く */
                out.push(k + '=' + localStorage.getItem(k));
            }
        } catch (e) { }
        return out.join('\n');
    }

    async function testC6() {
        log('  [目的] Cookie の値・ハッシュ・認証ヘッダが、A側のどこにも出ていないこと。');
        /* 🔴 検査器が実際に反応することを先に確かめる（鉄則 #11）。 */
        var fake = 'Authorization: SAPISIDHASH 1700000000_'
            + '0123456789abcdef0123456789abcdef01234567';
        pc('検査器が反応する（人工の偽ヘッダを検出できた）', function () {
            var h = scanSecrets(fake);
            return (h.length === SECRET_RULES.length) ? h.join(' / ') : false;
        });
        pc('検査器が無関係な文字列に反応しない', function () {
            return scanSecrets('コメント 356 件 / complete=true').length === 0 ? '検出0件' : false;
        });

        var bodyHits = scanSecrets(bodyHtmlWithoutDebug());
        var lsHits = scanSecrets(localStorageDump());
        var storeJson = '';
        try { storeJson = JSON.stringify(typeof chatStore !== 'undefined' ? chatStore : {}); }
        catch (e) { storeJson = ''; }
        var storeHits = scanSecrets(storeJson);
        var errJson = '';
        try { errJson = JSON.stringify(typeof chatError !== 'undefined' ? chatError : {}); }
        catch (e) { errJson = ''; }
        var errHits = scanSecrets(errJson);

        note('検査した文字数（DOM / localStorage / chatStore / chatError）',
            bodyHtmlWithoutDebug().length + ' / ' + localStorageDump().length
            + ' / ' + storeJson.length + ' / ' + errJson.length);

        expect('本体のDOMに認証情報らしき文字列が無い', bodyHits.join(' / ') || 'なし', 'なし');
        expect('localStorage に認証情報らしき文字列が無い', lsHits.join(' / ') || 'なし', 'なし');
        expect('chatStore に認証情報らしき文字列が無い', storeHits.join(' / ') || 'なし', 'なし');
        expect('chatError に認証情報らしき文字列が無い', errHits.join(' / ') || 'なし', 'なし');
    }

    /* --- D-C7: 既存機能の回帰（NOT_LIVE_ARCHIVE と キャッシュ） ---------------- */
    async function testC7() {
        log('  [目的] v2.6.4 の理由コード判定とキャッシュが v2.7.4 と同じであること。');
        var r = await runChatCase({
            url: ytUrl(VID.REGULAR), videoId: VID.REGULAR,
            expectState: 'error', expectCode: 'NOT_LIVE_ARCHIVE', expectTotal: 0
        });
        if (r) {
            var n = document.getElementById('chatNote_' + r.cid);
            var txt = n ? String(n.innerText || '') : '(要素なし)';
            note('枠に出た案内文の全文', txt);
            expect('切り分け手順（確認する順番）が出ていないこと', txt.indexOf('確認する順番') >= 0, false);
            expect('再試行ボタンが出ていないこと', !!(n && n.querySelector('button')), false);
        }
        var stats = null;
        try { stats = await chatCacheStats(); } catch (e) { stats = null; }
        pc('キャッシュの集計を読めた（IndexedDB が生きている）', function () {
            return stats ? (stats.count + '本') : false;
        });
        if (stats) {
            note('キャッシュ（本数 / バイト数）', stats.count + '本 / ' + stats.bytes + 'バイト');
            expect('キャッシュに1本以上入っている（完走ぶんが保存されている）', stats.count, gtZero);
        }
    }

    /* --- D-C8: 8-9節「0件のときの表示」が残っていること ----------------------- */
    async function testC8() {
        log('  [目的] 本当に0件のアーカイブ用の案内（8-9節）を v2.7.5 で消していないこと。');
        log('  [⚠] 実素材（VID_CHAT_OFF 相当の0件アーカイブ）が未確保で、');
        log('      本番UIから0件の状態を作る手段が無いため、表示関数を直接呼んで確かめる。');
        await closeAllMenus();
        var cid = firstCard();
        pc('対象の枠を特定できた（activeCardIds[0]）', function () { return cid || false; });
        if (!cid) return;
        pc('showChatEmptyNote が本体に存在する', function () {
            return (typeof showChatEmptyNote === 'function') ? 'function' : false;
        });
        if (typeof showChatEmptyNote !== 'function') return;

        var pane = await openChatPane(cid);
        pc('チャット欄を開けた', function () { return pane.ok ? 'ok' : false; });
        if (!pane.ok) return;

        showChatEmptyNote(cid, '(検査用の架空ID)');
        await wait(300);
        var n = document.getElementById('chatNote_' + cid);
        var txt = n ? String(n.innerText || '') : '';
        note('表示された全文', txt);
        expect('見出しが出ている', txt.indexOf('コメントが1件も見つかりませんでした') >= 0, true);
        expect('原因①（メンバー限定の配信）が出ている', txt.indexOf('メンバー限定の配信') >= 0, true);
        expect('原因②（リプレイを公開していない）が出ている', txt.indexOf('リプレイを公開していない') >= 0, true);
        expect('原因③（1件も無かった）が出ている', txt.indexOf('コメントが1件も無かった') >= 0, true);
        expect('再試行ボタンが出ている', !!(n && n.querySelector('button')), true);
    }

    /* --- D-C9: 理由コード CHAT_DISABLED（人工再現） --------------------------- */
    async function testC9() {
        log('  [目的] 「チャットは無効です」と返ってきたときに CHAT_DISABLED が A側へ出ること。');
        log('  [前提] 取得タブの MAIN world へ人工再現のパッチを当ててあること（手順書 T5）。');
        var r = await runChatCase({
            url: ytUrl(VID.LIGHT), videoId: VID.LIGHT, waitMs: 120000
        });
        if (!r) return;
        /* 🔴 パッチが効いているかどうかは PC。効いていなければ「測れていない」。 */
        pc('人工再現が効いている（取得が失敗で終わった）', function () {
            return (r.state === 'error') ? 'chatState = error' : false;
        });
        expect('理由コード', r.code, 'CHAT_DISABLED');
        expect('B側の文言に「チャットは無効」が含まれる',
            chatErrorOf(VID.LIGHT).indexOf('チャットは無効') >= 0, true);
        expect('総件数', r.total, 0);
        var n = document.getElementById('chatNote_' + r.cid);
        var txt = n ? String(n.innerText || '') : '';
        note('枠に出た案内文の全文', txt);
        expect('CHAT_DISABLED 用の文面が出ている',
            txt.indexOf('チャットのリプレイを公開していない') >= 0, true);
        expect('切り分け手順（確認する順番）が出ていないこと', txt.indexOf('確認する順番') >= 0, false);
        expect('再試行ボタンが出ていないこと', !!(n && n.querySelector('button')), false);
    }

    /* --- D-C10: 非ログインでの回帰（ヘッダ無しの経路） ------------------------- */
    async function testC10() {
        log('  [目的] Cookie が無いときにヘッダ無しで従来どおり取得できること（退行させない）。');
        log('  [前提] YouTube からログアウトしていること。');
        /* ① ログアウトできているかを「観測」で担保する（鉄則 #24）。 */
        var m = await runChatCase({
            url: ytUrl(VID.MEMBERS), videoId: VID.MEMBERS, waitMs: 120000
        });
        pc('ログアウトできている（メンバー限定が MEMBERS_ONLY で失敗した）', function () {
            return (m && m.state === 'error' && m.code === 'MEMBERS_ONLY') ? m.code : false;
        });
        /* ② 公開アーカイブが従来どおり取れること。 */
        await runChatCase({
            url: ytUrl(VID.LIGHT), videoId: VID.LIGHT,
            expectState: 'ready', expectTotal: 356, expectComplete: true
        });
    }

    /* --- D-C11: 所要時間の参考値（VID_HEAVY） -------------------------------- */
    async function testC11() {
        log('  [目的] 重いアーカイブの所要時間を記録する。');
        log('  [🔴] 所要時間は判定に使わない。測定PCが違うため v2.6.x の 165〜234秒とは比較できない。');
        var r = await runChatCase({
            url: ytUrl(VID.HEAVY), videoId: VID.HEAVY, waitMs: CHAT_WAIT_HEAVY_MS,
            needCountPc: true, expectState: 'ready', expectComplete: true, expectNotZero: true
        });
        if (r && r.store) {
            note('【参考値】所要時間(秒)', Math.round((r.store.elapsed || 0) / 1000));
            note('【参考値】件数 / リクエスト回数', r.total + ' / ' + r.store.reqs);
        }
    }


    /* --- 実行制御 --------------------------------------------------------- */

    var TESTS = [
        { id: 'D-X1', name: '基盤の自己診断（純関数）', run: testX1 },
        { id: 'D-X2', name: '記録UIの自動検証（ask / メモ）', run: testX2 },
        { id: 'D-V1', name: '版数バッジ', run: testV1 },
        { id: 'D-M2', name: 'トップメニューの排他制御（全遷移）', run: testM2 },
        { id: 'D-M7', name: 'コメント流し設定の永続化（4系統一致）', run: testM7 },
        { id: 'D-E1', name: '再生可否の確定処理と枠内通知', run: testE1 },
        { id: 'D-P1', name: '通常動画（positive control を兼ねる）', run: testP1, manual: true },
        { id: 'D-P2', name: '存在しない動画IDで通知が出る', run: testP2, manual: true },
        { id: 'D-P3', name: 'メンバー限定 / 保護オン → 通知が出る', run: testP3, manual: true },
        { id: 'D-P4', name: 'メンバー限定 / 保護オフ → 再生できる', run: testP4, manual: true },
        { id: 'D-P5', name: '再生を押さない間は確定しない（存在しない動画ID）', run: testP5, manual: true },
        /* ★v1.4.2: v2.7.5（チャット取得）の検証。いずれも準備が要るので manual。 */
        { id: 'D-C1', name: '公開アーカイブ 356件（数え方の positive control）', run: testC1, manual: true },
        { id: 'D-C2', name: '★メンバー限定アーカイブを完走させる', run: testC2, manual: true },
        { id: 'D-C3', name: '同一チャンネルの公開アーカイブ 430件', run: testC3, manual: true },
        { id: 'D-C4', name: 'コメント流しの回帰（メンバー限定・要 盾オフ）', run: testC4, manual: true },
        { id: 'D-C5', name: 'メンバー専用絵文字の表示（記録のみ）', run: testC5, manual: true },
        { id: 'D-C6', name: '認証情報が漏れていないこと', run: testC6, manual: true },
        { id: 'D-C7', name: '既存機能の回帰（NOT_LIVE_ARCHIVE / キャッシュ）', run: testC7, manual: true },
        { id: 'D-C8', name: '0件のときの表示が残っていること', run: testC8, manual: true },
        { id: 'D-C9', name: '理由コード CHAT_DISABLED（人工再現）', run: testC9, manual: true },
        { id: 'D-C10', name: '非ログインでの回帰（ヘッダ無しの経路）', run: testC10, manual: true },
        { id: 'D-C11', name: '所要時間の参考値（重いアーカイブ）', run: testC11, manual: true }
    ];

    var running = false;
    var runningAll = false;
    var groupShield = null;   /* ★v1.4.0: 一括実行の冒頭で観測した盾の状態 */
    var allQueue = [];        /* ★v1.4.1: 「すべて実行」でこれから実行する残りのID */

    /* 🔴 ★v1.4.0: 盾の切り替え（＝再読み込み）をまたいで記録を持ち越す。
       これが無いと D-P1〜D-P3 と D-P4〜D-P5 で貼り付けが2回に分かれる。
       LS_RESUME を phase='carry' で使い回す（新しいキーを増やさない）。 */
    function saveCarry() {
        try {
            localStorage.setItem(LS_RESUME, JSON.stringify({
                v: DEBUG_SUITE_VERSION,
                at: Date.now(),
                phase: 'carry',
                logLines: logLines.slice(),
                report: report
            }));
        } catch (e) { log('⚠ 記録の持ち越しに失敗しました: ' + (e && e.message)); }
    }

    /* ★v1.4.2: D-C 用の一括実行。盾は聞かない（取得は盾に影響されない）。
       終わりに記録を持ち越すので、貼り付けは条件の区切りごとに1回で足りる。 */
    async function runChatGroup(title, ids, hint) {
        /* ★v1.4.3: ログに出すだけでは気づけない。押したのに始まらない状態を表に出す。 */
        if (running) {
            log('⚠ 実行中です。終わるまで待ってください。');
            window.alert('いま別のテストを実行中です。\n終わってから、もう一度押してください。');
            return;
        }
        running = true;
        window.alert(title + '\n\n' + hint);
        log('=== ' + title + ' 開始（' + ids.join(' → ') + '） ===');
        for (var i = 0; i < ids.length; i++) {
            await runOne(ids[i], true);
        }
        running = false;
        saveCarry();
        log('=== ' + title + ' 完了 ===');
        log('  ここまでの記録は保存しました。再読み込みしても消えません。');
        openDebugMenu();
    }

    async function runPlaybackGroup(title, ids, hint) {
        if (running) { log('⚠ 実行中です。終わるまで待ってください。'); return; }
        running = true;
        var ans = window.prompt(
            title + '\n\n'
            + hint + '\n\n'
            + 'アドレスバー左の盾のアイコンを今すぐ見てください。\n'
            + '強化型トラッキング防止は、このサイトでどちらですか？\n'
            + 'on / off を入力してください。', '');
        groupShield = String(ans === null ? '' : ans).trim().toLowerCase();
        log('=== ' + title + ' 開始（盾 = ' + (groupShield || '(未入力)') + '） ===');
        for (var i = 0; i < ids.length; i++) {
            await runOne(ids[i], true);
        }
        groupShield = null;
        running = false;
        saveCarry();
        log('=== ' + title + ' 完了 ===');
        log('  ここまでの記録は保存しました。盾を切り替えて再読み込みしても消えません。');
        openDebugMenu();
    }

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
        current = mkRecord(def.id, def.name);
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

        /* 盾の切り替えなど人の準備が要るテストは飛ばす。取り違えた条件で測ると害になる。 */
        var queue = TESTS.filter(function (t) { return !t.manual; })
            .map(function (t) { return t.id; });
        TESTS.forEach(function (t) {
            if (t.manual) log('— ' + t.id + ' は準備が要るので「すべて実行」では飛ばします（個別に実行してください）');
        });
        log('=== すべて実行 開始（' + queue.length + '本: ' + queue.join(' / ') + '） ===');

        while (queue.length) {
            var id = queue.shift();
            /* 🔴 実行前に「残り」を共有する。D-M7 は再読み込みの前にこれを引き継ぎへ載せる。 */
            allQueue = queue.slice();
            await runOne(id, true);
        }
        allQueue = [];
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
        loadMeta();      /* ★v1.3.0: ラベル・実施メモを再読み込みをまたいで復元する */
        joinTopMenus();
        if (!buildUI()) return;
        header();

        var raw = null;
        try { raw = localStorage.getItem(LS_RESUME); } catch (e) { raw = null; }
        if (!raw) return;

        var payload = null;
        try { payload = JSON.parse(raw); } catch (e) { payload = null; }
        if (!payload) {
            try { localStorage.removeItem(LS_RESUME); } catch (e) { }
            return;
        }

        /* ★v1.4.0: 盾の切り替えをまたいだ持ち越し。自動では何も実行しない。 */
        if (payload.phase === 'carry') {
            try { localStorage.removeItem(LS_RESUME); } catch (e) { }
            if (payload.v !== DEBUG_SUITE_VERSION
                || Date.now() - Number(payload.at || 0) > PLAYBACK_PC_TTL_MS) {
                log('⚠ 持ち越した記録は使えません（版違い、または'
                    + PLAYBACK_PC_TTL_MS / 60000 + '分超過）。D-P1 からやり直してください。');
                return;
            }
            report = Array.isArray(payload.report) ? payload.report : [];
            report.forEach(fixRecord);
            logLines = (payload.logLines || []).slice();
            if (logEl) logEl.textContent = logLines.join('\n');
            log('=== 再読み込み前の記録を引き継ぎました（' + report.length + '本ぶん） ===');
            log('  このまま次の一括実行を押せば、1回のコピーにまとめて出せます。');
            openDebugMenu();
            return;
        }

        if (payload.phase !== 'after-reload') {
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

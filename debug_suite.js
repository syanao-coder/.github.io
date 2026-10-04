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
                ★v1.4.2: D-C1〜D-C11 ＝ チャット取得（v2.7.5 の検証用）/
                ★v1.7.0: D-G1〜D-G6 ＝ コメント配列の破棄（v2.8.3 の検証用））

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

    var DEBUG_SUITE_VERSION = '1.17.1';   /* 本体の APP_VERSION とは別系統 */
    /* ★v1.4.3: D-V1 の期待値。本体の版を上げたら🔴ここも上げる。
       v1.4.2 では 2.7.4 のまま残っていて、正しい 2.7.5 を不合格と報告した。 */
    var EXPECT_APP_VERSION = '2.10.0';
    /* ★v1.10.0: 本体の ADDON_REQUIRED_VERSION の期待値（v2.8.8 で導入）。
       🔴 アドオンの .js を変えた版でだけ上げる。版数連動の固定値はこれで3か所
          （EXPECT_APP_VERSION / これ / D-N3 の件数）。 */
    var EXPECT_ADDON_REQUIRED = '2.10.0';
    /* ★v1.10.0: 「🎯 この版の回帰」ボタンで流すテスト。版ごとに差し替える（ボタンを版ごとに増やさない）。 */
    var VERSION_FOCUS = { v: '2.10.0', ids: ['D-V1', 'D-V2', 'D-K1', 'D-K2'] };
    var LS_ENABLE = 'sync_debug';        /* '1' のときだけ有効 */
    var LS_RESUME = 'sync_debug_resume'; /* 再読み込みをまたぐテストの引き継ぎ用（一時キー） */
    var RESUME_TTL_MS = 10 * 60 * 1000;  /* 古い引き継ぎは捨てる */
    /* 🔴 D-P1 の結果は「盾の切り替え → 再読み込み」をまたいで生き残る必要がある。
       メモリに置いていたため、2026-08-07 の検証で D-P3/P4/P5 が全部「判定不能」になった。 */
    var LS_PLAYBACK_PC = 'sync_debug_playback_pc';
    /* ★v1.5.0: 配信中のライブは実施時にしか決まらないので、
       一度聞いた動画IDを持ち回す。TTL 12時間（配信は長くても半日で終わる）。 */
    var LS_LIVE_VID = 'sync_debug_live_vid';
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
            localStorage.removeItem(LS_LIVE_VID);      /* ★v1.5.0 */
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

    function addonRequired() {
        try { return (typeof ADDON_REQUIRED_VERSION !== 'undefined') ? String(ADDON_REQUIRED_VERSION) : '(取得不可)'; }
        catch (e) { return '(取得不可)'; }
    }
    function appVersion() {
        try { return (typeof APP_VERSION !== 'undefined') ? String(APP_VERSION) : '(取得不可)'; }
        catch (e) { return '(取得不可)'; }
    }

    function buildUI() {
        /* 🔴 ★v1.6.1: DOM順で最初の .topmenu-anchor を拾ってはいけない。

           v2.8.2 で版数バッジが .topmenu-anchor（#versionAnchor）で包まれ、
           「最初のアンカー」がトップバー左端のバッジになった。その直前へ 🐞 を入れた結果、
           right:0 で開く幅420pxのパネルが画面の左外へはみ出して押せなくなった。
           ⚠️ 挿入位置は必ずボタンのIDから引く。並び順が変わっても壊れない。 */
        var commentBtn = document.getElementById('topCommentBtn');
        var commentAnchor = (commentBtn && commentBtn.closest)
            ? commentBtn.closest('.topmenu-anchor') : null;
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
        /* ★v1.9.1 棚卸し: 「❓ ask() 確認」を削除した。
           D-X2 が記録パネルの選択肢・未選択時の赤枠・確定の可否を自動で検証しており、
           人が押して目で見る意味が無くなっていた（判定数は変わらない）。 */
        panel.appendChild(row1);

        /* ★v1.9.1 棚卸し: 個別ボタンは本数が増え続け、どれを押せばよいか分からなくなっていた。
           🔴 消さずに畳む。単独実行は「1本だけ測り直す」唯一の手段で、
              2026-09-16 に D-Y11 の再測で実際に必要になった。消していたら
              一括（9〜15分）を回し直すことになる。既定は閉じる。 */
        var row2 = document.createElement('div');
        row2.className = 'dbg-row';
        row2.style.display = 'none';
        TESTS.forEach(function (t) {
            row2.appendChild(mkBtn('▶ ' + t.id, t.name, function () { runOne(t.id); }));
        });
        var row2Head = document.createElement('div');
        row2Head.className = 'dbg-row';
        var row2Btn = mkBtn('▼ 個別に実行（' + TESTS.length + '本）',
            'テストを1本だけ実行する。再測のときに使う', function () {
                var open = row2.style.display !== 'none';
                row2.style.display = open ? 'none' : '';
                row2Btn.textContent = (open ? '▼' : '▲') + ' 個別に実行（' + TESTS.length + '本）';
            });
        row2Head.appendChild(row2Btn);
        panel.appendChild(row2Head);
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
        row4.appendChild(mkBtn('🧪 D-C9 理由コード',
            'CHAT_DISABLED の出し分けを確かめます（準備は不要）',
            function () {
                runChatGroup('🧪 D-C9 理由コードの出し分け', ['D-C9'],
                    '通常の動画を読み込んでから、CHAT_DISABLED の出し分けを確かめます（約30秒）。');
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

        /* ★v1.7.0: D-G（コメント配列の破棄）。
           🔴 ボタンは1つだけにする。手順書の1項目＝ボタン1つに対応させるため（鉄則 #39）。 */
        var row4g = document.createElement('div');
        row4g.className = 'dbg-row';
        row4g.appendChild(mkBtn('♻ D-G 解放一括（G1→G2→G3→G4→G5→G6）',
            '枠の削除・空にする・枠数減・流しだけON の各経路で、コメント配列が正しく捨てられる／捨てられないことを測ります（8〜15分）',
            function () {
                runChatGroup('♻ D-G 解放一括',
                    ['D-G1', 'D-G2', 'D-G3', 'D-G4', 'D-G5', 'D-G6'],
                    'このあと D-G1 〜 D-G6 を続けて実行します（8〜15分）。\n'
                    + '枠の追加・削除・動画の読み込みはテストのコードが自動で行います。\n'
                    + '途中で枠や設定を操作せず、そのままお待ちください。\n'
                    + 'キャッシュもテストのコードが必要なところで自動的に捨てます。');
            }));
        panel.appendChild(row4g);

        /* ★v1.8.0: D-Y（ピン留め時のレイアウト）。
           🔴 ボタンは1つだけにする（鉄則 #39）。動画の読み込みは D-Y4 の中だけ。 */
        var row4y = document.createElement('div');
        row4y.className = 'dbg-row';
        row4y.appendChild(mkBtn('📐 D-Y レイアウト一括（Y1→Y8 / Y10→Y12）',
            'ピン留めしたときに枠が画面やグリッドからはみ出さないこと、薄い枠でURL入力欄を押せること、'
            + 'ピン位置を4隅へ動かしても order と保存URLが動かないことを測ります（9〜15分）',
            function () {
                runChatGroup('📐 D-Y レイアウト一括',
                    ['D-Y1', 'D-Y2', 'D-Y3', 'D-Y4', 'D-Y5', 'D-Y6', 'D-Y7', 'D-Y8',
                        'D-Y10', 'D-Y11', 'D-Y12'],
                    'このあと D-Y1 〜 D-Y8 と D-Y10 〜 D-Y12 を続けて実行します（9〜15分）。\n'
                    + '枠の追加・削除・ピンの付け外し・列数の変更はテストのコードが行います。\n'
                    + '🔴 ウィンドウの大きさを測定中に変えないでください（矩形を見る判定です）。\n'
                    + '🔴 測定中はマウスを動かさないでください（枠のヘッダーと一括コントローラーが反応します）。\n'
                    + '⚠️ D-Y4 と D-Y10 は保存URLを一時的に書き換えますが、終了時に自動で元へ戻します。');
            }));
        panel.appendChild(row4y);

        /* ★v1.10.0: この版で触った箇所の回帰だけを流すボタン。🔴 版ごとにボタンを増やさず、
           VERSION_FOCUS の中身だけを差し替える（/get-dev-workflow 1-5節の棚卸し対策）。 */
        var row4f = document.createElement('div');
        row4f.className = 'dbg-row';
        row4f.appendChild(mkBtn('🎯 この版の回帰（v' + VERSION_FOCUS.v + ': ' + VERSION_FOCUS.ids.join(' → ') + '）',
            'この版で触った画面の部分について、既存の判定と新しい判定を続けて実行します（2〜4分）',
            function () {
                runChatGroup('🎯 この版の回帰',
                    VERSION_FOCUS.ids.slice(),
                    'このあと ' + VERSION_FOCUS.ids.join(' / ') + ' を続けて実行します（2〜4分）。\n'
                    + '枠数・列数の変更はテストのコードが行い、終了時に元へ戻します。\n'
                    + '🔴 ウィンドウの大きさを測定中に変えないでください。\n'
                    + '🔴 測定中はマウスを動かさないでください。');
            }));
        panel.appendChild(row4f);

        /* ★v1.8.1: D-Y9 は動画を1本読み込むので別のボタンにする（鉄則 #39: 1項目1ボタン）。 */
        var row4y2 = document.createElement('div');
        row4y2.className = 'dbg-row';
        row4y2.appendChild(mkBtn('🎬 D-Y9 動画領域とチャット欄（単独）',
            '動画を1本読み込み、動画領域とチャット欄（右配置・下配置）が潰れないことを測ります（1〜3分）',
            function () {
                runChatGroup('🎬 D-Y9 動画領域とチャット欄',
                    ['D-Y9'],
                    'このあと D-Y9 を実行します（1〜3分）。\n'
                    + '動画を1本だけ読み込みます（コメントの取得は行いません）。\n'
                    + '🔴 ウィンドウの大きさを測定中に変えないでください。\n'
                    + '⚠️ 「最近使った動画」の履歴が1件増えます。');
            }));
        panel.appendChild(row4y2);

        /* ★v1.5.0: D-L（ライブ配信）。動画IDは最初の1回だけ聞き、以降は持ち回す。
           🔴 ボタンは2つだけにする。手順書の1項目＝ボタン1つに対応させるため。 */
        var row5 = document.createElement('div');
        row5.className = 'dbg-row';
        row5.appendChild(mkBtn('🔴 D-L ライブ一括（L1→L2→L3→L4→L5→L6）',
            '配信中のライブで、取得・表示・シーク除外・流しを続けて実行します（約3分）',
            function () {
                /* 🔴 ★v1.5.3: 3分待たせてから「測れていません」と言わないため、
                   押した時点で設定を確かめる。D-L6 は close でないと成立しない。 */
                var sel = document.getElementById('chatTabPolicy');
                if (sel && sel.value !== 'close') {
                    var m = '⚠ 「コメント取得用タブ」が ' + sel.value + ' になっています。\n\n'
                        + 'D-L6（取得タブの維持）は「取得のたびに閉じる」でないと成立しません。\n'
                        + 'このまま進めると D-L6 だけ判定不能になります。\n\n'
                        + '▼ 設定メニュー →「コメント取得用タブ」を\n'
                        + '「取得のたびに閉じる」に変えてから、もう一度押してください。';
                    log(m);
                    window.alert(m);
                    return;
                }
                runChatGroup('🔴 D-L ライブ一括',
                    ['D-L1', 'D-L2', 'D-L3', 'D-L4', 'D-L5', 'D-L6'],
                    'はじめに、配信中のライブの動画IDを1回だけ聞きます。\n'
                    + '設定メニューの「コメント取得用タブ」を close（取得のたびに閉じる）に'
                    + 'してから始めてください。\n'
                    + 'そのあとは触らずにお待ちください（約3分）。');
            }));
        row5.appendChild(mkBtn('⏱ D-L7 長時間（30分）',
            'ライブの取得が30分もつかを測ります。記録のみで合否は付けません',
            function () {
                runChatGroup('⏱ D-L7 長時間の継続', ['D-L7'],
                    '先に「🔴 D-L ライブ一括」を終えてください。\n'
                    + '30分かかります。about:debugging の「調査」パネルを閉じてから始めてください。');
            }));
        row5.appendChild(mkBtn('🗑 ライブの動画IDを忘れる',
            '別の配信で測り直すときに押します',
            function () {
                try { localStorage.removeItem(LS_LIVE_VID); } catch (e) { }
                log('ライブの動画IDを忘れました。次の実行でもう一度聞きます。');
            }));
        panel.appendChild(row5);

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
            + '測定前のキャッシュ削除はコードが自動で行うので、手で消す必要はありません。'
            + '★v1.5.0: D-L（ライブ配信）は「🔴 D-L ライブ一括」から実行します。'
            + '配信中のライブの動画IDは最初の1回だけ聞き、12時間は覚えています。'
            + '★v1.6.0: v2.8.2 の判定（D-H1〜D-H5 / D-N1〜D-N5 / D-R1）は '
            + '準備が要らないので「▶ すべて実行」に含まれます。'
            + 'D-M2 はトップメニューが5枚（🐞 / 📜 / 💬 / 📂 / ▼）になり 30遷移・34判定へ増えました。'
            + '★v1.6.1: 🐞 の挿入位置をボタンIDから引くよう直し、'
            + 'パネルが画面外へはみ出していないかを D-N6 で測るようにしました。'
            + '★v1.6.2: 押し下げ式（📂 / ▼）は 0.3秒かけて滑るため、'
            + 'D-N6 は矩形が動かなくなるまで待ってから測るようにしました。'
            + '★v1.9.0: v2.8.7（ピン枠の位置を4隅から選ぶ）の判定 D-Y10 / D-Y11 / D-Y12 を'
            + '「📐 D-Y レイアウト一括」へ追加しました。D-Y10 は保存URLを一時的に書き換えますが、'
            + '終了時に自動で元へ戻します。'
            + '★v1.9.1: 個別ボタンは「▼ 個別に実行」に畳みました（再測に使うので残してあります）。'
            + 'ビューポート基準の自己診断は固定待ちをやめ、合否によらず実測値を残します。'
            + '★v1.10.0: v2.8.8 の判定 D-V2 / D-U1 / D-U2 は「▶ すべて実行」に含まれます。'
            + '「🎯 この版の回帰」はその版で触った画面の回帰だけを流すボタンです（中身は版ごとに替わります）。'
            + '報告書用コピーに UA（ブラウザの版数）を自動で載せるようにしました。'
            + '★v1.11.0: v2.8.9 の音量の判定 D-A1 / D-A2 は「▶ すべて実行」に含まれます。'
            + 'トップメニューが6枚（🔊 音量を追加）になり、D-M2 は 42遷移へ増えました。'
            + '★v1.12.0: v2.8.10 のローカル動画の拡大は D-Z1（枠を1つ足してダミーのファイルを読ませる）。「🎯 この版の回帰」から実行します。'
            + '★v1.13.0: v2.8.11 の境界線ドラッグは D-S1。D-Y / D-Z は保存した枠の比を一時的に無視して均等で測ります（保存値は消しません）。'
            + '★v1.13.1: D-S2 はページを再読み込みして、変えた枠の比が残るかを測ります（「🎯 この版の回帰」の最後に走ります）。'
            + '★v1.13.2: D-Z2 はローカル動画の履歴を押すと選択画面が開くことを測ります（選択画面そのものは開かずに止めます）。'
            + '★v1.14.0: v2.8.12 の上部メニューの出し入れは D-T1、縮小は D-T2。D-T1 は上部メニューを畳んで戻します（終了時に元の状態へ）。';
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
        /* 🔴 ★v1.5.2: 版数バッジの実測をここへ必ず出す。
           2026-08-15 の事故では、出力の見出しだけでは
           「どのファイルが古かったのか」が読み取りにくかった。 */
        (function () {
            var b = document.getElementById('versionBadge');
            lines.push('- 版数バッジ: `' + (b ? String(b.innerText || '') : '(バッジが無い)') + '`'
                + ' / 期待する APP_VERSION: `' + EXPECT_APP_VERSION + '`');
        })();
        lines.push('- 実行日時: ' + new Date().toISOString());
        lines.push('- 画面: ' + window.innerWidth + ' x ' + window.innerHeight);
        lines.push('- 配信元: ' + location.origin);
        /* ★v1.10.0: 測定環境を自動で残す（人に書かせない）。
           ⚠️ Floorp と Firefox は UA が同じなので名前は判別できない。Gecko の版数までは取れる。 */
        lines.push('- UA: `' + navigator.userAgent + '`');
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

    /* トップバーの5メニュー。本体の TOP_MENUS とは独立に持つ
       （本体が古くても D-M2 の観測だけは成立させるため）。
       🔴 ★v1.6.0: 📜 更新履歴（v2.8.2）を足して5枚にした。判定数は 24 → 34。
          足さないと「📜 が開いたままでも openIds() が 0 を返す」ため、
          排他制御の破れをまったく検出できない。
          ⚠️ v2.7.3〜v2.8.1 の D-M2 の記録（24判定）とは直接比較できない。 */
    var MENUS = [
        { id: 'debug', panel: 'debugMenu', btn: 'topDebugBtn', label: '🐞 デバッグ' },
        { id: 'history', panel: 'historyMenu', btn: 'versionBadge', label: '📜 更新履歴' },
        { id: 'comment', panel: 'commentMenu', btn: 'topCommentBtn', label: '💬 コメント設定' },
        { id: 'session', panel: 'sessionContainer', btn: 'topSessionBtn', label: '📂 マイリスト' },
        { id: 'settings', panel: 'settingsContainer', btn: 'topSettingsBtn', label: '▼ 設定メニュー', arrow: 'topSettingsArrow' },
        /* ★v1.11.0: v2.8.9 の 🔊 音量。6枚になり D-M2 は 42遷移・46判定になる。 */
        { id: 'volume', panel: 'volumeMenu', btn: 'topVolumeBtn', label: '🔊 音量' }
    ];

    /* ★v1.6.0: v2.8.2 の判定で使う道具。
       🔴 本体の const（APP_HISTORY / HELP_TEXTS）はグローバル「レキシカル」環境に入り、
          window のプロパティにはならない。名前で直接参照する（TDZ 対策で try/catch）。 */
    function appHistory() {
        try { return (typeof APP_HISTORY !== 'undefined') ? APP_HISTORY : null; }
        catch (e) { return null; }
    }
    function helpTexts() {
        try { return (typeof HELP_TEXTS !== 'undefined') ? HELP_TEXTS : null; }
        catch (e) { return null; }
    }
    function helpQ(key) { return document.querySelector('.help-q[data-help="' + key + '"]'); }
    function tipEl() { return document.getElementById('helpTip'); }
    function tipOpen() {
        var t = tipEl();
        return !!(t && t.classList.contains('open'));
    }
    /* 実際のイベント経路を通す（関数の直呼びで代用しない）。 */
    async function hoverQ(el) {
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await wait(60);
        return tipOpen();
    }
    async function unhoverQ(el) {
        if (!el) return;
        el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        await wait(60);
    }
    /* a が b の外へどれだけ出ているか（px）。0 なら完全に内側。 */
    function outsideOf(a, b) {
        if (!a || !b) return -1;
        return Math.max(0, b.left - a.left) + Math.max(0, a.right - b.right)
            + Math.max(0, b.top - a.top) + Math.max(0, a.bottom - b.bottom);
    }
    /* 🔴 ★v1.6.2: 矩形が動かなくなるまで待つ。
       .settings-container（📂 / ▼）は押し下げ式で transform を 0.3秒かけて滑らせる。
       clickReal() の待ちは SETTLE_MS = 60ms しかないので、
       クリック直後に測ると「滑っている途中の矩形」を掴む。
       ⚠️ 固定の待ち時間を足して誤魔化さないこと。条件（2回続けて同じ）で待つ。 */
    async function waitRectSettled(el, timeoutMs) {
        var limit = timeoutMs || 2000;
        var t0 = performance.now();
        var prev = null, same = 0;
        while (performance.now() - t0 < limit) {
            var r = rect(el);
            var key = r ? [r.left, r.top, r.right, r.bottom].join(',') : 'null';
            if (key === prev) {
                same++;
                if (same >= 2) {
                    return { settled: true, ms: Math.round(performance.now() - t0), rect: r };
                }
            } else {
                same = 0;
                prev = key;
            }
            await wait(50);
        }
        return { settled: false, ms: Math.round(performance.now() - t0), rect: rect(el) };
    }

    function inViewport(r) {
        return !!r && r.left >= 0 && r.top >= 0
            && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
    }

    /* v2.8.2 で ? を付ける11項目。menu は開いておくべきパネル。 */
    var HELP_ITEMS = [
        { key: 'flowMaxOnscreen', label: '同時表示数の上限', menu: 'comment' },
        { key: 'flowDurationMs', label: '画面を横切る時間', menu: 'comment' },
        { key: 'flowFontPx', label: '文字サイズ', menu: 'comment' },
        { key: 'flowColor', label: '文字の色', menu: 'comment' },
        { key: 'flowOpacity', label: '不透明度', menu: 'comment' },
        { key: 'flowAreaRatio', label: '表示位置の範囲', menu: 'comment' },
        { key: 'flowShadow', label: '文字を縁取る', menu: 'comment' },
        { key: 'chatCache', label: 'コメントのキャッシュ', menu: 'comment' },
        { key: 'chatTabPolicy', label: 'コメント取得用タブ', menu: 'settings' },
        { key: 'syncChatRatio', label: 'チャット欄の幅を全枠で連動', menu: 'settings' },
        /* 🔴 ディレイ秒数の行は「ディレイスタート」を有効にするまで display:none。
           存在（D-H1）だけを見て、ホバー（D-H2）と画面端（D-H4）の対象からは外す。 */
        { key: 'delaySec', label: 'ディレイ秒数', menu: 'settings', hidden: true }
    ];
    /* ? を付けない側。行の中に .help-q が無いことを見る。 */
    var NO_HELP_IDS = [
        'activeCountDisplay', 'layout2Dir', 'skipSecBack', 'skipSecForward',
        'uiSizeSelect', 'chatPosition', 'toggleAllChatsBtn'
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
        expect('ADDON_REQUIRED_VERSION', addonRequired(), EXPECT_ADDON_REQUIRED);
        /* ★v1.10.0: HTML とアドオンの版数が違う期間は両方を出す（v2.8.8 / アドオン v2.8.7）。 */
        expect('バッジの表示文字列', badge ? String(badge.textContent).trim() : '(要素なし)',
            EXPECT_APP_VERSION === EXPECT_ADDON_REQUIRED
                ? 'v' + EXPECT_APP_VERSION
                : 'v' + EXPECT_APP_VERSION + ' / アドオン v' + EXPECT_ADDON_REQUIRED);
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

        /* 全遷移の総当たり: 開始状態(全閉 ＋ 各メニュー)通り × 押すボタン(メニュー数)通り。
           🔴 ★v1.6.0: 直書きの配列をやめ MENUS から導出する。
              メニューを足したのに starts を直し忘れる事故を構造的に防ぐ。
              5枚なら 6 × 5 = 30遷移（v1.5.3 までは 5 × 4 = 20遷移）。 */
        var starts = [null].concat(MENUS.map(function (m) { return m.id; }));
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


    /* ======================================================================
       ★v1.6.0 : v2.8.2「設定の解説（?マーク）と更新履歴」の判定
       ==================================================================== */

    /* --- D-H1: ?マークが付いている / 付けない側には無い ------------------- */

    async function testH1() {
        await closeAllMenus();
        log('  [前提] 11項目に ? があり、基本的な設定には無いことを見る');

        pc('セレクタが「存在しないキー」を落とす', function () {
            return helpQ('__not_exist__') === null ? 'null を返した' : false;
        });
        pc('セレクタが「存在するキー」を拾う', function () {
            var e = helpQ('flowMaxOnscreen');
            return e ? describe(e) : false;
        });
        pc('本体の HELP_TEXTS を読めている', function () {
            var h = helpTexts();
            return h ? Object.keys(h).length + '件' : false;
        });

        HELP_ITEMS.forEach(function (it) {
            var el = helpQ(it.key);
            expect('? がある: ' + it.label + '（' + it.key + '）',
                el ? 'あり' : 'なし', 'あり');
        });

        NO_HELP_IDS.forEach(function (id) {
            var base = document.getElementById(id);
            var row = base && base.closest ? base.closest('.control-row') : null;
            var found = row ? !!row.querySelector('.help-q') : null;
            expect('? が無い（付けない側）: #' + id,
                row ? (found ? 'あり' : 'なし') : '(行が見つからない)', 'なし');
        });

        expect('?マークの総数', document.querySelectorAll('.help-q').length, HELP_ITEMS.length);

        var texts = helpTexts() || {};
        var empty = HELP_ITEMS.filter(function (it) {
            return !texts[it.key] || String(texts[it.key]).trim().length < 10;
        }).map(function (it) { return it.key; });
        expect('解説の本文が空・極端に短いもの', empty.length ? empty.join(',') : 'なし', 'なし');
        note('解説の文字数', HELP_ITEMS.map(function (it) {
            return it.key + '=' + String(texts[it.key] || '').length;
        }).join(' / '));
        /* 🔴 ライブ中は設定にかかわらず取得タブを維持する、が解説に入っているか。 */
        expect('取得用タブの解説にライブの注意がある',
            String(texts.chatTabPolicy || '').indexOf('ライブ') >= 0, true);
    }

    /* --- D-H2: ホバーでツールチップが出る -------------------------------- */

    async function testH2() {
        await closeAllMenus();
        log('  [前提] パネルを開いてから ? へ mouseover を送る（関数の直呼びはしない）');

        pc('はじめはツールチップが出ていない', function () {
            return tipOpen() === false ? '閉じている' : false;
        });
        pc('関係のない要素の mouseover では出ない', function () {
            var b = document.getElementById('topSessionBtn');
            if (!b) return false;
            b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            return tipOpen() === false ? '出なかった' : false;
        });

        var groups = { comment: [], settings: [] };
        HELP_ITEMS.forEach(function (it) {
            if (!it.hidden) groups[it.menu].push(it);
        });

        for (var gi = 0; gi < 2; gi++) {
            var menuId = gi === 0 ? 'comment' : 'settings';
            await setMenuState(menuId);
            for (var i = 0; i < groups[menuId].length; i++) {
                var it = groups[menuId][i];
                var el = helpQ(it.key);
                var opened = await hoverQ(el);
                var t = tipEl();
                var body = t ? String(t.textContent).trim() : '';
                expect('ホバーで出て本文がある: ' + it.label,
                    (opened && body.length > 0) ? ('open / ' + body.length + '文字') : ('open=' + opened + ' / ' + body.length + '文字'),
                    function (v) { return /^open \/ \d+文字$/.test(String(v)); });
                await unhoverQ(el);
            }
        }

        pc('mouseout で閉じる', function () {
            return tipOpen() === false ? '閉じた' : false;
        });
        note('ホバーの対象外', 'delaySec（ディレイ秒数の行は既定で display:none のため D-H2・D-H4 の対象外。D-H1 で存在のみ判定）');
        await closeAllMenus();
    }

    /* --- D-H3: パネルの外へはみ出しても切れない（最大の罠） --------------- */

    async function testH3() {
        await setMenuState('comment');
        var panel = document.getElementById('commentMenu');
        var pr = rect(panel);

        pc('パネルに切り取りの土俵がある（overflow-y / max-height）', function () {
            var cs = window.getComputedStyle(panel);
            return (cs.overflowY === 'auto' && cs.maxHeight !== 'none')
                ? (cs.overflowY + ' / ' + cs.maxHeight) : false;
        });
        pc('はみ出し量の測定器が効く（トップバーはパネルの外）', function () {
            var out = outsideOf(rect(document.querySelector('.top-bar')), pr);
            return out > 0 ? out + 'px はみ出しと判定' : false;
        });

        var q0 = helpQ('flowMaxOnscreen');
        await hoverQ(q0);
        var tip = tipEl();

        /* 🔴 ここが今回の最重要判定。親が body でなければ必ず切り取られる。 */
        expect('ツールチップの親要素', tip ? describe(tip.parentElement) : '(要素なし)', 'body');
        expect('position', tip ? window.getComputedStyle(tip).position : '(要素なし)', 'fixed');
        var z = tip ? Number(window.getComputedStyle(tip).zIndex) : 0;
        expect('z-index がパネル(120)より上', z > 120 ? 'true (' + z + ')' : 'false (' + z + ')',
            function (v) { return String(v).indexOf('true') === 0; });
        await unhoverQ(q0);

        /* パネル内の ? を総なめし、はみ出しても画面内に収まることを見る。 */
        var outside = 0, offscreen = [], details = [];
        var list = HELP_ITEMS.filter(function (it) { return it.menu === 'comment'; });
        for (var i = 0; i < list.length; i++) {
            var el = helpQ(list[i].key);
            await hoverQ(el);
            var tr = rect(tipEl());
            var out = outsideOf(tr, pr);
            if (out > 0) outside++;
            if (!inViewport(tr)) offscreen.push(list[i].key);
            details.push(list[i].key + '=' + out + 'px');
            await unhoverQ(el);
        }
        expect('パネルからはみ出した ? の数（1件以上あれば罠の土俵に乗っている）',
            outside, function (v) { return Number(v) >= 1; });
        expect('画面外へ出たツールチップ', offscreen.length ? offscreen.join(',') : 'なし', 'なし');
        note('パネル矩形からのはみ出し量', details.join(' / '));
        note('パネル矩形', JSON.stringify(pr));

        await closeAllMenus();
    }

    /* --- D-H4: 画面端で内側へ寄る ---------------------------------------- */

    async function testH4() {
        await closeAllMenus();
        /* 実機の ? が必ず画面端に来るとは限らないので、
           同じ .help-q として扱われる要素を隅へ置いて補正だけを測る。 */
        function corner(pos) {
            var s = document.createElement('span');
            s.className = 'help-q';
            s.setAttribute('data-help', 'flowFontPx');
            s.textContent = '?';
            s.style.position = 'fixed';
            s.style.zIndex = '150';
            if (pos === 'br') { s.style.right = '2px'; s.style.bottom = '2px'; }
            else { s.style.left = '2px'; s.style.top = '2px'; }
            document.body.appendChild(s);
            return s;
        }

        var br = corner('br');
        pc('右下の ? が画面端から40px以内にある（補正が無ければはみ出す条件）', function () {
            var r = rect(br);
            var d = Math.min(window.innerWidth - r.right, window.innerHeight - r.bottom);
            return d <= 40 ? ('端から ' + d + 'px') : false;
        });
        await hoverQ(br);
        var trBR = rect(tipEl());
        var naive = { left: rect(br).left, top: rect(br).bottom + 6 };
        pc('補正しなければ画面外に出る位置である', function () {
            return (naive.top + (trBR.bottom - trBR.top) > window.innerHeight
                || naive.left + (trBR.right - trBR.left) > window.innerWidth)
                ? ('素の位置 ' + JSON.stringify(naive)) : false;
        });
        expect('右下: ツールチップが画面内に収まる', inViewport(trBR) ? '収まる' : 'はみ出す（' + JSON.stringify(trBR) + '）', '収まる');
        await unhoverQ(br);
        br.parentNode.removeChild(br);

        var tl = corner('tl');
        await hoverQ(tl);
        var trTL = rect(tipEl());
        expect('左上: ツールチップが画面内に収まる', inViewport(trTL) ? '収まる' : 'はみ出す（' + JSON.stringify(trTL) + '）', '収まる');
        await unhoverQ(tl);
        tl.parentNode.removeChild(tl);

        expect('後始末: 合成した ? が残っていない', document.querySelectorAll('.help-q').length, HELP_ITEMS.length);
        note('画面サイズ', window.innerWidth + '×' + window.innerHeight);
    }

    /* --- D-H5: パネルを閉じたらツールチップも消える ---------------------- */

    async function testH5() {
        await closeAllMenus();
        pc('閉じた状態から始めている', function () {
            return (openIds().length === 0 && tipOpen() === false) ? '両方とも閉' : false;
        });

        /* 💬 を閉じる経路 */
        await setMenuState('comment');
        await hoverQ(helpQ('flowOpacity'));
        expect('💬 を開いた状態でツールチップが出ている', tipOpen(), true);
        await clickReal(document.getElementById('topCommentBtn'));
        expect('💬 を閉じるとツールチップも消える', tipOpen(), false);

        /* ▼ を閉じる経路（経路ごとに分ける ─ 鉄則 #10） */
        await setMenuState('settings');
        await hoverQ(helpQ('chatTabPolicy'));
        expect('▼ を開いた状態でツールチップが出ている', tipOpen(), true);
        await clickReal(document.getElementById('topSettingsBtn'));
        expect('▼ を閉じるとツールチップも消える', tipOpen(), false);

        /* 他のメニューへ切り替える経路 */
        await setMenuState('comment');
        await hoverQ(helpQ('flowColor'));
        await clickReal(document.getElementById('topSessionBtn'));
        expect('別のメニューを開いてもツールチップは消える', tipOpen(), false);

        await closeAllMenus();
        expect('後始末: 全メニューが閉じている', openIds().length, 0);
    }

    /* --- D-N1: 版数バッジのクリックで更新履歴が開く ---------------------- */

    async function testN1() {
        await closeAllMenus();
        var badge = document.getElementById('versionBadge');
        var panel = document.getElementById('historyMenu');

        pc('バッジとパネルの両方を取得できる', function () {
            return (badge && panel) ? describe(badge) + ' / ' + describe(panel) : false;
        });
        pc('はじめは閉じている', function () {
            return (!panel.classList.contains('open') && !badge.classList.contains('active'))
                ? '閉じている' : false;
        });
        pc('バッジのカーソルが pointer（押せることが見て分かる）', function () {
            var c = window.getComputedStyle(badge).cursor;
            return c === 'pointer' ? c : false;
        });

        var r1 = await clickReal(badge);
        expect('1回目のクリックが被覆されていない', r1.blocked ? ('被覆: ' + r1.reason) : '被覆なし', '被覆なし');
        expect('1回目: パネルに open が付く', panel.classList.contains('open'), true);
        expect('1回目: バッジに active が付く', badge.classList.contains('active'), true);

        var r2 = await clickReal(badge);
        expect('2回目のクリックが被覆されていない', r2.blocked ? ('被覆: ' + r2.reason) : '被覆なし', '被覆なし');
        expect('2回目: open が外れる', panel.classList.contains('open'), false);
        expect('2回目: active が外れる', badge.classList.contains('active'), false);
    }

    /* --- D-N2: 履歴パネルの形（次にメニューを増やす人の基準になる） -------- */

    async function testN2() {
        await setMenuState('history');
        var panel = document.getElementById('historyMenu');
        var badge = document.getElementById('versionBadge');
        var cs = window.getComputedStyle(panel);
        var pr = rect(panel);
        var br = rect(badge);

        pc('計算後スタイルを読めている', function () {
            return cs.width && cs.width !== 'auto' ? cs.width : false;
        });
        pc('パネルが実際に表示されている（面積がある）', function () {
            return (pr.right - pr.left) > 0 && (pr.bottom - pr.top) > 0
                ? (pr.right - pr.left) + '×' + (pr.bottom - pr.top) : false;
        });

        expect('box-sizing', cs.boxSizing, 'border-box');
        expect('overflow-y', cs.overflowY, 'auto');
        expect('z-index', cs.zIndex, '120');
        var maxH = parseFloat(cs.maxHeight);
        var h = pr.bottom - pr.top;
        expect('高さが max-height を超えない', (h <= maxH + 1) ? 'ok' : (h + ' > ' + maxH), 'ok');
        var dLeft = Math.abs(pr.left - br.left);
        expect('左端がバッジと一致（±2px）', dLeft <= 2 ? 'ok(' + dLeft + 'px)' : 'ずれ ' + dLeft + 'px',
            function (v) { return String(v).indexOf('ok') === 0; });
        expect('右端が画面内に収まる', pr.right <= window.innerWidth ? 'ok' : 'はみ出し', 'ok');
        expect('幅が max-width（100vw-20px）を超えない',
            (pr.right - pr.left) <= (window.innerWidth - 20) + 1 ? 'ok' : 'はみ出し', 'ok');

        note('確定値（幅 / max-height / 実高 / left）',
            cs.width + ' / ' + cs.maxHeight + ' / ' + Math.round(h) + 'px / ' + Math.round(pr.left));
        note('バッジ矩形', JSON.stringify(br));
        await closeAllMenus();
    }

    /* --- D-N3: 履歴の中身 ------------------------------------------------ */

    async function testN3() {
        await setMenuState('history');
        var hist = appHistory();
        var body = document.getElementById('historyBody');

        pc('本体の APP_HISTORY を読めている', function () {
            return (hist && hist.length) ? hist.length + '件' : false;
        });
        pc('履歴の描画先を取得できる', function () {
            return body ? describe(body) : false;
        });

        expect('先頭の版数が APP_VERSION と一致',
            hist && hist.length ? hist[0].v : '(空)', appVersion());
        /* 🔴 ★v1.15.0: 35 → 36（v2.8.13）。★v1.14.0: 34 → 35（v2.8.12）。★v1.13.0: 33 → 34（v2.8.11）。★v1.12.0: 32 → 33（v2.8.10）。★v1.11.0: 31 → 32（v2.8.9）。★v1.10.0: 30 → 31（v2.8.8）。★v1.9.0: 29 → 30（v2.8.7 で1件増えた）。★v1.8.1: 28 → 29（v2.8.6）。★v1.8.0: 27 → 28（v2.8.5）。
           v1.7.0 は本体の APP_HISTORY に足しておきながらこの固定値を上げ忘れ、
           正しい 26 件を不合格として報告した（2026-08-31 実測）。
           ⚠️ 本体の版を上げたら、基盤側の固定値を必ず「機械で」洗うこと。
              2026-09-07 に洗った結果、版数連動の固定値は
              EXPECT_APP_VERSION と この件数 の2か所だけだった。 */
        expect('配列の件数', hist ? hist.length : 0, 38);
        expect('描画された行数が配列と一致',
            document.querySelectorAll('#historyBody .history-entry').length, hist ? hist.length : -1);
        expect('❌ v2.4.1（欠番）の行がある',
            /❌\s*v2\.4\.1/.test(body ? body.textContent : ''), true);
        var vs = (hist || []).map(function (h) { return h.v; });
        var dup = vs.filter(function (v, i) { return vs.indexOf(v) !== i; });
        expect('版数の重複', dup.length ? dup.join(',') : 'なし', 'なし');
        var noText = (hist || []).filter(function (h) { return !h.t || !h.t.length; });
        expect('本文が空の版', noText.length ? noText.map(function (h) { return h.v; }).join(',') : 'なし', 'なし');

        note('先頭3件', vs.slice(0, 3).join(' / '));
        note('末尾', vs[vs.length - 1]);
        await closeAllMenus();
    }

    /* --- D-N4: 縦スクロールが出る ---------------------------------------- */

    async function testN4() {
        await setMenuState('history');
        var panel = document.getElementById('historyMenu');

        pc('スクロール量を読めている', function () {
            return panel ? (panel.scrollHeight + ' / ' + panel.clientHeight) : false;
        });

        expect('中身が max-height を超えている（scrollHeight > clientHeight）',
            panel.scrollHeight > panel.clientHeight ? 'ok' : '超えていない', 'ok');
        panel.scrollTop = 99999;
        await wait(60);
        expect('実際に縦スクロールできる', panel.scrollTop > 0 ? 'ok(' + Math.round(panel.scrollTop) + 'px)' : '動かない',
            function (v) { return String(v).indexOf('ok') === 0; });
        note('scrollHeight / clientHeight', panel.scrollHeight + ' / ' + panel.clientHeight);
        panel.scrollTop = 0;
        await closeAllMenus();
    }

    /* --- D-N5: バッジの既存の役割が変わっていないこと --------------------- */

    async function testN5() {
        await closeAllMenus();
        var badge = document.getElementById('versionBadge');

        function snap() {
            var cs = window.getComputedStyle(badge);
            return {
                text: String(badge.textContent).trim(),
                kind: ['ok', 'warn', 'ng'].filter(function (c) { return badge.classList.contains(c); }).join(',') || '(なし)',
                color: cs.color,
                border: cs.borderTopColor,
                bg: cs.backgroundColor
            };
        }

        pc('バッジの見た目を読み取れている', function () {
            var s = snap();
            return s.text && s.color ? JSON.stringify(s) : false;
        });
        pc('版数照合が緑（ok）で成立している', function () {
            return snap().kind === 'ok' ? 'ok' : false;
        });

        var before = snap();
        await clickReal(badge);
        var during = snap();
        await clickReal(badge);
        var after = snap();

        expect('文言が変わらない（開いている間）', during.text, before.text);
        expect('色が変わらない（開いている間）', during.color + '/' + during.border + '/' + during.bg,
            before.color + '/' + before.border + '/' + before.bg);
        expect('緑/橙/赤の区分が変わらない（開いている間）', during.kind, before.kind);
        expect('閉じたあとも元どおり', JSON.stringify(after), JSON.stringify(before));
        expect('active が残っていない', badge.classList.contains('active'), false);

        note('バッジの見た目', JSON.stringify(before));
    }


    /* --- D-N6: すべてのトップメニューが画面内に収まる（★v1.6.1） ----------

       2026-08-18 の事故の再発防止。
       .topmenu-dropdown は right:0 で開くので、アンカーが画面の左寄りにあると
       パネルが左外へはみ出す。「開くこと」は測れていても「押せること」は別である。
       ---------------------------------------------------------------------- */

    async function testN6() {
        await closeAllMenus();

        pc(MENUS.length + '枚すべてのボタンとパネルを取得できる', function () {
            var miss = MENUS.filter(function (m) {
                return !document.getElementById(m.btn) || !document.getElementById(m.panel);
            });
            return miss.length ? false : MENUS.length + '枚';
        });
        pc('画面内かどうかの判定器が「外」を落とす', function () {
            return inViewport({ left: -10, top: 0, right: 100, bottom: 100 }) === false
                ? 'false を返した' : false;
        });

        var details = [], settles = [], notSettled = [];
        for (var i = 0; i < MENUS.length; i++) {
            var m = MENUS[i];
            await setMenuState(m.id);
            /* 🔴 ★v1.6.2: 開き切るまで待つ。押し下げ式は 0.3秒かけて滑る。 */
            var st = await waitRectSettled(document.getElementById(m.panel), 2000);
            settles.push(m.label + '=' + st.ms + 'ms');
            if (!st.settled) notSettled.push(m.label);
            var pr = st.rect;
            var out = [];
            if (pr.left < 0) out.push('左へ ' + (-pr.left) + 'px');
            if (pr.right > window.innerWidth) out.push('右へ ' + (pr.right - window.innerWidth) + 'px');
            if (pr.top < 0) out.push('上へ ' + (-pr.top) + 'px');
            expect('画面内に収まる: ' + m.label,
                out.length ? out.join(' / ') : '収まる', '収まる');
            details.push(m.label + '=[' + pr.left + ',' + pr.top + '→' + pr.right + ']');
        }
        await closeAllMenus();

        /* 🔴 収束せずに測った枚数があれば、その回の矩形は信用できない。
           前提条件なので expect ではなく pc で落とす。 */
        pc(MENUS.length + '枚とも矩形が動かなくなってから測った（滑っている途中で測っていない）', function () {
            return notSettled.length ? false : settles.join(' / ');
        });
        note('矩形が収束するまでの時間', settles.join(' / '));

        /* 並び順（🐞 は 💬 の直前に入る設計）。ずれていても押せるなら不合格にはしない。 */
        var dbg = document.getElementById('topDebugBtn');
        var cmt = document.getElementById('topCommentBtn');
        var order = '(片方なし)';
        if (dbg && cmt) {
            var a = dbg.closest('.topmenu-anchor'), b = cmt.closest('.topmenu-anchor');
            order = (a && b && a.nextElementSibling === b) ? '🐞 の直後が 💬' : '離れている';
        }
        note('🐞 の挿入位置', order);
        note('各パネルの左右', details.join(' / '));
        note('画面幅', window.innerWidth + 'px');
    }

    /* --- D-R1: 既存操作への非干渉（回帰）--------------------------------- */

    async function testR1() {
        await closeAllMenus();
        /* 一括コントローラーは hover で押し上がる作り。合成イベントでは :hover を作れないので
           同じクラスを直接付けて測り、最後に元へ戻す。 */
        var oc = document.getElementById('overlayController');
        var ocWas = oc ? oc.classList.contains('active') : false;
        if (oc && !ocWas) oc.classList.add('active');
        await wait(400);

        var targets = [
            { id: 'playPauseBtn', label: '▶ 一括再生' },
            { id: 'batchSkipBackBtn', label: '⏪ 一括戻る' },
            { id: 'batchSkipForwardBtn', label: '⏩ 一括進む' },
            { id: 'topSessionBtn', label: '📂 マイリスト' },
            { id: 'topSettingsBtn', label: '▼ 設定メニュー' }
        ];

        pc('被覆判定が「覆われている」を検出する（▶の上へ一時的に板を置く）', function () {
            var b = document.getElementById('playPauseBtn');
            if (!b) return false;
            var r = b.getBoundingClientRect();
            var cover = document.createElement('div');
            cover.style.cssText = 'position:fixed; z-index:99999; background:transparent;'
                + 'left:' + r.left + 'px; top:' + r.top + 'px;'
                + 'width:' + r.width + 'px; height:' + r.height + 'px;';
            document.body.appendChild(cover);
            var h = hitTest(b);
            document.body.removeChild(cover);
            return h.blocked ? 'blocked / ' + h.reason : false;
        });
        pc('板が無ければ ▶ は最前面である', function () {
            return hitTest(document.getElementById('playPauseBtn')).blocked ? false : '最前面';
        });

        /* ① ツールチップを出したまま、下の操作が死んでいないか */
        await setMenuState('comment');
        var q = helpQ('flowMaxOnscreen');
        await hoverQ(q);
        expect('ツールチップの pointer-events',
            tipEl() ? window.getComputedStyle(tipEl()).pointerEvents : '(要素なし)', 'none');

        /* 🔴 ツールチップの真下にある部品が押せるか。重なっていることを先に前提として確かめる。 */
        var below = document.getElementById('flowDurationMs');
        var ov = overlap(rect(below), rect(tipEl()));
        pc('ツールチップが下の行のスライダーに実際に重なっている', function () {
            return ov.ratio > 0 ? ov.ratio + '% 重なり' : false;
        });
        var hb = hitTest(below);
        expect('重なった下のスライダーが押せる（ツールチップが吸わない）',
            hb.blocked ? ('被覆: ' + hb.reason + ' / hit=' + hb.hit) : '被覆なし', '被覆なし');
        note('重なりの割合', ov.ratio + '% / hit=' + hb.hit);

        for (var i = 0; i < targets.length; i++) {
            var el = document.getElementById(targets[i].id);
            var h = hitTest(el);
            expect('ツールチップ表示中に押せる: ' + targets[i].label,
                h.blocked ? ('被覆: ' + h.reason) : '被覆なし', '被覆なし');
        }
        await unhoverQ(q);
        await closeAllMenus();

        /* ② 更新履歴を開いたまま、下の操作が死んでいないか */
        await setMenuState('history');
        for (var j = 0; j < targets.length; j++) {
            if (targets[j].id === 'topSessionBtn' || targets[j].id === 'topSettingsBtn') continue;
            var el2 = document.getElementById(targets[j].id);
            var h2 = hitTest(el2);
            expect('📜 を開いた状態で押せる: ' + targets[j].label,
                h2.blocked ? ('被覆: ' + h2.reason) : '被覆なし', '被覆なし');
        }
        var grid = document.getElementById('playersGrid');
        note('履歴パネルと動画領域の重なり',
            overlap(rect(grid), rect(document.getElementById('historyMenu'))).ratio + '%');
        await closeAllMenus();

        /* ③ 流しの設定が壊れていないこと（D-M7 の簡易版・値は変えない） */
        expect('FLOW の同時表示数を読める', typeof flowValue('maxOnscreen'), 'number');
        expect('FLOW の横切る時間を読める', typeof flowValue('durationMs'), 'number');

        if (oc && !ocWas) oc.classList.remove('active');
        expect('後始末: 一括コントローラーの状態を戻した',
            oc ? oc.classList.contains('active') : false, ocWas);
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
        /* 🔴 ★v1.5.1: v1.5.0 では reset の 50ms 後だけを見ていたため、
           「消えなかった」のか「消えた直後に何かが入れ直した」のかが
           区別できなかった（v2.8.0 の検証で3項目が落ちた際、原因を絞れなかった）。
           reset の直後（await を挟まない）と 50ms 後の2点で測る。
           ⚠️ 直後が消えていて 50ms 後に戻っていれば、犯人は後始末ではなく
              生き残ったタイマーか onReady の再発火である。 */
        var timerIdBefore = playerVerifyTimer[cardId];
        resetPlayerDiagnostics(cardId);

        var at0 = {
            timer: playerVerifyTimer[cardId] === undefined,
            code: playerErrorCode[cardId] === undefined,
            log: playerStateLog[cardId] === undefined,
            ready: playerReadyDone[cardId] === undefined
        };
        note('後始末の直後（0ms / await なし）',
            'timer=' + at0.timer + ' / code=' + at0.code + ' / log=' + at0.log + ' / ready=' + at0.ready);

        await wait(50);
        var at50 = {
            timer: playerVerifyTimer[cardId] === undefined,
            code: playerErrorCode[cardId] === undefined,
            log: playerStateLog[cardId] === undefined,
            ready: playerReadyDone[cardId] === undefined
        };
        note('後始末の 50ms 後',
            'timer=' + at50.timer + ' / code=' + at50.code + ' / log=' + at50.log + ' / ready=' + at50.ready);

        /* 犯人の切り分け: 直後は消えていたのに戻ったものを名指しする。 */
        var revived = [];
        ['timer', 'code', 'log', 'ready'].forEach(function (k) {
            if (at0[k] && !at50[k]) revived.push(k);
        });
        note('🔴 いったん消えたのに 50ms 以内に戻ったもの',
            revived.length ? revived.join(' / ') : '(なし)');
        note('タイマーIDが張り直されたか',
            (playerVerifyTimer[cardId] === undefined) ? '(タイマーは無い)'
                : ((playerVerifyTimer[cardId] === timerIdBefore)
                    ? '同じID（後始末が効いていない）' : '別のID（後から張り直された）'));
        note('後始末の時点の isPlayingRequest',
            (typeof isPlayingRequest !== 'undefined') ? String(isPlayingRequest) : '(読めない)');
        note('この枠にプレイヤーがいるか',
            (function () { try { return ytPlayers[cardId] ? 'いる' : 'いない'; } catch (e) { return '(読めない)'; } })());

        /* 判定は従来どおり 50ms 後の値で行う（合否の基準は変えない）。 */
        expect('後始末: 確定タイマーが消える', at50.timer, true);
        expect('後始末: エラーコードが消える', at50.code, true);
        expect('後始末: 状態遷移の記録が消える', at50.log, true);
        expect('後始末: playerReadyDone が落ちる', at50.ready, true);
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
        HEAVY:   'q176a2krHbg',   /* 52,362件 / 129.5分。所要時間の参考値用 */
        /* ★v1.7.0: D-G2 の「別の動画」側。902件 / 101.3分 ＝ 0.15件/秒。
           ⚠️ 薄いので流しの検証には使わない（鉄則 #14）。 */
        MID:     'd3bgw8r84mA'
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
        log('  [目的] 公開アーカイブが完走すること。');
        /* 🔴 v1.4.3 まで期待値を 430 件としていたが、これは誤りだった（2026-08-14 実測）。
           実測 39,199件 / complete=true / gap=false、videoMs 11,589,000（3:13:09）に対し
           lastT 11,589,782 で動画の最後まで届いている。取得は正常。
           スパイク5-C の「430」は数リクエストぶんの部分計測を総件数と取り違えたもの。
           ⚠️ 件数は YouTube 側の削除で動くので固定の判定には使わない。
              固定値で判定してよいのは positive control の 356件（D-C1）だけである。 */
        log('  [参考値] 2026-08-14 の実測は 39,199件 / 849リクエスト / 112秒。');
        await runChatCase({
            url: ytUrl(VID.SAMECH), videoId: VID.SAMECH, needCountPc: true,
            expectState: 'ready', expectNotZero: true, expectComplete: true
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
        /* ⚠️ 押し下げ式ヘッダーのため、マウスが枠外にあると「被覆あり」になるのが正常。 */
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

        /* 🔴 枠のヘッダーは押し下げ式（`.player-header{height:0;overflow:hidden}` で、
           `.player-card:hover` のときだけ高さが出る）。マウスが枠の外にあるあいだ
           ヘッダーは切り取られているので、elementFromPoint は div.player-card を返す。
           CSS の :hover は合成イベントでは作れないため、
           ⚠️ hover でしか出ないボタンに被覆チェックは適用できない（2026-08-14 確定）。
           ここでは「クリックが実際に発火したか」で判定し、被覆の実測は note に残す。
           トップバーや枠内通知の閉じるボタンは常時表示なので、従来どおり被覆で判定してよい。 */
        var fb = document.getElementById('flowToggleBtn_' + cid);
        pc('🌊 ボタンを特定できた', function () { return fb ? describe(fb) : false; });

        /* 🔴 v1.4.4 まで無条件にクリックしていたが、🌊 はトグルである。
           前の実行がオンのまま終わっていると、押した結果オフになって0件になる
           （2026-08-14 実測: 流しがオンになった=false / 画面上0件）。
           ⚠️ トグルを押すテストは、押す前の状態を必ず読むこと。 */
        var flowWas = false;
        try { flowWas = !!(typeof flowVisible !== 'undefined' && flowVisible[cid]); } catch (e) { }
        note('🌊 を押す前の状態', flowWas ? 'すでにオン（押さない）' : 'オフ（これから押す）');
        var rf = { clicked: false, blocked: false, hit: '(押していない)', reason: '' };
        if (!flowWas) rf = await clickReal(fb);
        /* ★v1.4.3: v1.4.2 では blocked:covered とだけ出て、何が覆っていたのか分からなかった。
           ⚠️ clickReal は被覆でもクリックを実行するので、機能そのものは進む。 */
        note('🌊 を押したときの当たり判定',
            (rf.blocked ? '被覆あり / ' : '被覆なし / ') + (rf.hit || '(記録なし)')
            + ' / 実際にクリックした=' + rf.clicked);
        note('🌊 ボタンの位置', fb ? rect(fb) : '(要素なし)');
        var flowOn = false;
        try { flowOn = !!(typeof flowVisible !== 'undefined' && flowVisible[cid]); } catch (e) { }
        expect('🌊（コメントを流す）がオンになった', flowOn, true);

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
        /* 🔴 後始末: 次に実行するとき「すでにオン」から始まらないよう、オフへ戻す。 */
        var flowEnd = false;
        try { flowEnd = !!(typeof flowVisible !== 'undefined' && flowVisible[cid]); } catch (e) { }
        if (flowEnd) await clickReal(fb);
        try { flowEnd = !!(typeof flowVisible !== 'undefined' && flowVisible[cid]); } catch (e) { }
        note('後始末: 流しの状態', flowEnd ? '★オンのまま残った' : 'オフへ戻した');
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

        /* 🔴 ★v1.7.1: この項目で自分で読み込む（自己完結）。
           v1.7.0 までは「D-C2 が chatStore に残した結果」を後から読んでいたが、
           本体 v2.8.3 が「参照されなくなったコメントを捨てる」ようになったため、
           次の D-C3 が同じ枠に別動画を読み込んだ時点で正しく捨てられ、
           この項目だけが判定不能になった（2026-08-31 実測）。本体は仕様どおり。
           ⚠️ 前の項目の残骸に依存してはいけない（鉄則: 項目ごとの自己完結）。
           ⚠️ 🔄 は押さない。キャッシュがあればそれで足りる（測るのは絵文字であって取得ではない）。 */
        var store = chatStoreOf(VID.MEMBERS);
        if (!store || !store.comments.length) {
            await closeAllMenus();
            await stopAllIfPlaying();
            var cid = firstCard();
            pc('対象の枠を特定できた（activeCardIds[0]）', function () { return cid || false; });
            if (cid) {
                var cleared = await clearCard(cid);
                pc('枠を「URL入力待ち」にできた', function () { return cleared ? 'ok' : false; });
                var ld = await loadUrlIntoCard(cid, ytUrl(VID.MEMBERS));
                expect('「読み込む」を実際に押せた（被覆なし）',
                    ld.ok ? 'ok' : ('blocked:' + ld.reason), 'ok');
                var pane = await openChatPane(cid);
                pc('チャット欄を開けた', function () { return pane.ok ? 'ok' : false; });
                var w = await waitChatSettled(VID.MEMBERS, CHAT_WAIT_MS);
                note('取得の状態 / 待った時間', w.value + ' / ' + Math.round(w.waitedMs / 1000) + '秒');
            }
            store = chatStoreOf(VID.MEMBERS);
        }
        pc('メンバー限定のコメントが手元にある（この項目の中で取得する）', function () {
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

    /* --- D-C9: 理由コード CHAT_DISABLED の出し分け（A側のみ） ------------------ */
    async function testC9() {
        log('  [目的] CHAT_DISABLED が返ったときに、A側が専用の文面で出し分けること。');
        log('  [⚠] 人工再現は取り下げた。JSON.parse の差し替えは res.json() を通らないため空振りし、');
        log('      Response.prototype.json の差し替えも取得タブの取得経路へ届かなかった（2026-08-14 実測 2回）。');
        log('      チャットのリプレイが無効な実素材も未確保である。');
        log('  🔴 そのため、B側が実際に CHAT_DISABLED を throw するかは、このテストでは検証していない。');
        log('      ここで確かめるのは、その文字列を受け取った A側の出し分けだけである。');

        /* 通常の投稿動画を読み込んで、失敗の終点まで到達させる（NOT_LIVE_ARCHIVE）。 */
        var r = await runChatCase({
            url: ytUrl(VID.REGULAR), videoId: VID.REGULAR, waitMs: 120000
        });
        if (!r) return;

        pc('failChat が本体に存在する', function () {
            return (typeof failChat === 'function') ? 'function' : false;
        });
        if (typeof failChat !== 'function') return;
        pc('呼ぶ前は CHAT_DISABLED ではなかった（＝これから確実に変わる）', function () {
            var before = chatCodeOf(VID.REGULAR);
            return (before !== 'CHAT_DISABLED') ? ('直前の理由コード = ' + before) : false;
        });

        /* B側が投げる文字列をそのまま終点へ渡す（書式は 'CODE: 説明'）。 */
        var MSG = 'このライブ ストリームではチャットは無効です。';
        failChat('dbg-c9', VID.REGULAR, 'CHAT_DISABLED: ' + MSG);
        await wait(400);

        var n = document.getElementById('chatNote_' + r.cid);
        var txt = n ? String(n.innerText || '') : '';
        note('枠に出た案内文の全文', txt);
        expect('取得の状態 chatState', chatStateOf(VID.REGULAR), 'error');
        expect('理由コード', chatCodeOf(VID.REGULAR), 'CHAT_DISABLED');
        expect('B側の文言がそのまま出ている', txt.indexOf(MSG) >= 0, true);
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

    /* ======================================================================
       D-L: v2.8.0 ライブ配信のチャット対応

       🔴 素材が特殊である。「配信中のライブ」はその時にしか存在しないため、
          動画IDを定数で持てない。実施時に1回だけ聞いて localStorage へ置く。
       🔴 件数を固定値で期待しない。増え続けるので note に留め、
          判定は「増えていること（単調増加）」で行う
          （固定の件数を期待値に置いてよいのは D-C1 の 356件だけ）。
       ⚠️ B側（InnerTube への POST）は https://www.youtube.com オリジンでしか
          成立しないため、この基盤からは触れない。ここで測るのは
          「A側に何が届いたか」と「A側がどう振る舞ったか」だけである。
       ====================================================================== */

    /* ★v1.5.0: ライブ取得を始める「前」のキャッシュ集計。D-L3 で突き合わせる。
       🔴 前後で比べないと「増えていないこと」を機械で判定できない。 */
    var liveCacheBefore = null;

    var LIVE_SAMPLE_MS = 20000;    /* 件数の推移を見る長さ */
    var LIVE_SAMPLE_N = 10;        /* 何回数えるか（2秒おきに10回） */

    function liveVid() {
        var raw = null;
        try { raw = localStorage.getItem(LS_LIVE_VID); } catch (e) { raw = null; }
        if (raw) {
            try {
                var o = JSON.parse(raw);
                if (o && o.id && (Date.now() - o.at) < 43200000) return o.id;
            } catch (e) { }
        }
        var ans = window.prompt(
            'いま配信中のライブの動画ID（11文字）を入れてください。\n'
            + '例: dQw4w9WgXcQ\n\n'
            + '🔴 チャットが実際に流れている配信を選んでください。\n'
            + '（薄い配信では、正常でも0件になって判定できません）', '');
        var id = String(ans === null ? '' : ans).trim();
        if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
        try {
            localStorage.setItem(LS_LIVE_VID, JSON.stringify({ id: id, at: Date.now() }));
        } catch (e) { }
        return id;
    }

    function isLiveOf(vid) {
        try { return !!(typeof liveVideoIds !== 'undefined' && liveVideoIds[vid]); }
        catch (e) { return false; }
    }
    function countOf(vid) {
        var s = chatStoreOf(vid);
        return s ? s.comments.length : 0;
    }

    /* ライブ枠を1つ用意して取得を始める。戻り値の cid / vid を各テストで使う。 */
    async function setUpLiveCard() {
        await closeAllMenus();
        await stopAllIfPlaying();

        var vid = liveVid();
        pc('配信中のライブの動画IDを受け取れた', function () { return vid || false; });
        if (!vid) {
            expect('この項目の実行', '動画IDが未入力', '11文字の動画IDが入っていること');
            return null;
        }
        log('  [素材] VID_LIVE = ' + vid);

        var cid = firstCard();
        pc('対象の枠を特定できた（activeCardIds[0]）', function () { return cid || false; });
        if (!cid) return null;

        var cleared = await clearCard(cid);
        pc('枠を「URL入力待ち」にできた', function () { return cleared ? 'ok' : false; });
        if (!cleared) return null;

        /* 🔴 取得を始める「前」に集計を取る。D-L3 はこれと突き合わせる。 */
        try { liveCacheBefore = await chatCacheStats(); } catch (e) { liveCacheBefore = null; }
        note('取得前のキャッシュ（本数 / バイト数）', liveCacheBefore
            ? (liveCacheBefore.count + '本 / ' + liveCacheBefore.bytes + 'バイト')
            : '(読めなかった)');

        var ld = await loadUrlIntoCard(cid, ytUrl(vid));
        expect('「読み込む」を実際に押せた（被覆なし）', ld.ok ? 'ok' : ('blocked:' + ld.reason), 'ok');

        var pane = await openChatPane(cid);
        pc('チャット欄を開けた', function () { return pane.ok ? 'ok' : false; });
        if (!pane.ok) return null;

        /* 🔴 固定時間で打ち切らない。届くまで待ってから基準値を取る（鉄則 #27）。 */
        var w = await waitFor(function () {
            var st = chatStateOf(vid);
            return (st === 'streaming' || st === 'ready' || st === 'error') ? st : false;
        }, 120000, 1000);
        pc('取得が始まった（chatState が動いた）', function () {
            return w.ok ? (w.value + ' / ' + Math.round(w.waitedMs / 1000) + '秒') : false;
        });
        note('取得の状態 chatState', chatStateOf(vid));
        note('理由コード', chatCodeOf(vid));
        return { cid: cid, vid: vid, waited: w };
    }

    /* --- D-L1: ★本命。配信中と判定され、コメントが増え続ける ------------------ */
    async function testL1() {
        log('  [目的] v2.8.0 の成否そのもの。live が立ち、件数が単調に増えること。');
        var s = await setUpLiveCard();
        if (!s) return;

        expect('配信中と判定された（chatMeta の live）', isLiveOf(s.vid), true);
        var store = chatStoreOf(s.vid);
        expect('store.live が立っている', store ? !!store.live : '(storeが無い)', true);
        note('判定に効いたフィールド（B側の liveBy）', store && store.liveBy ? store.liveBy : '(未記録)');
        note('動画長 videoMs（ライブは 0 で返る）', store ? store.videoMs : '(なし)');

        /* 🔴 件数は固定値で期待しない。増えていることだけを見る。 */
        var seq = [];
        var sm = await sample(LIVE_SAMPLE_MS / LIVE_SAMPLE_N, LIVE_SAMPLE_N, function () {
            var n = countOf(s.vid);
            seq.push(n);
            return n;
        });
        note('件数の推移（' + (LIVE_SAMPLE_MS / 1000) + '秒 / ' + LIVE_SAMPLE_N + '回）', seq.join(' → '));
        note('件数（最小 / 最大）', sm.min + ' / ' + sm.max);

        var monotone = true;
        for (var i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) monotone = false;
        expect('件数が減っていない（単調非減少）', monotone, true);
        expect('件数が増えた（配信中のチャットが届いている）', sm.max - seq[0], gtZero);
        expect('総件数が 0 でない', sm.max, gtZero);
    }

    /* --- D-L2: 「配信中」が失敗として表示されないこと ------------------------- */
    async function testL2() {
        log('  [目的] complete:false の流用をしていないこと。「取得に失敗」と見えないこと。');
        var vid = liveVid();
        pc('配信中のライブの動画IDを受け取れた', function () { return vid || false; });
        if (!vid) return;
        var cid = firstCard();
        pc('対象の枠を特定できた', function () { return cid || false; });
        if (!cid) return;
        pc('D-L1 でライブの取得が始まっている', function () {
            return isLiveOf(vid) ? 'live=true' : false;
        });
        if (!isLiveOf(vid)) return;

        var store = chatStoreOf(vid);
        note('complete / truncated / gap',
            (store ? store.complete : '?') + ' / ' + (store ? store.truncated : '?')
            + ' / ' + (store ? store.gap : '?'));
        expect('取得の状態が error になっていない', chatStateOf(vid) === 'error', false);
        expect('理由コードが付いていない', chatCodeOf(vid), '(なし)');

        var head = document.getElementById('chatHeadTitle_' + cid);
        var txt = head ? String(head.innerText || '') : '(要素なし)';
        note('チャット欄のヘッダー表記', txt);
        expect('ヘッダーに「配信中」と出ている', txt.indexOf('配信中') >= 0, true);
        expect('ヘッダーに「⚠不完全」が出ていない', txt.indexOf('不完全') >= 0, false);
        expect('ヘッダーに「取得中 0%」が出ていない', txt.indexOf('取得中') >= 0, false);

        var n = document.getElementById('chatNote_' + cid);
        var note1 = (n && n.style.display !== 'none') ? String(n.innerText || '') : '';
        note('案内文（出ていれば全文）', note1 || '(出ていない)');
        expect('「取得できませんでした」の案内が出ていない',
            note1.indexOf('取得できませんでした') >= 0, false);
    }

    /* --- D-L3: キャッシュへ保存されない --------------------------------------- */
    async function testL3() {
        log('  [目的] 配信中のチャットを IndexedDB へ入れないこと（増え続けるため）。');
        var vid = liveVid();
        pc('配信中のライブの動画IDを受け取れた', function () { return vid || false; });
        if (!vid) return;
        pc('D-L1 でライブの取得が始まっている', function () {
            return isLiveOf(vid) ? 'live=true' : false;
        });

        var stats = null;
        try { stats = await chatCacheStats(); } catch (e) { stats = null; }
        pc('キャッシュの集計を読めた（IndexedDB が生きている）', function () {
            return stats ? (stats.count + '本') : false;
        });
        if (!stats) return;
        note('取得後のキャッシュ（本数 / バイト数）', stats.count + '本 / ' + stats.bytes + 'バイト');

        /* 🔴 前後で比べる。D-L1 の冒頭で取った集計と突き合わせること。 */
        pc('取得前のキャッシュ集計がある（先に D-L1 を実行すること）', function () {
            return liveCacheBefore
                ? (liveCacheBefore.count + '本 / ' + liveCacheBefore.bytes + 'バイト') : false;
        });
        if (liveCacheBefore) {
            note('本数の変化', liveCacheBefore.count + ' → ' + stats.count);
            note('バイト数の変化', liveCacheBefore.bytes + ' → ' + stats.bytes);
            expect('キャッシュの本数が増えていない', stats.count <= liveCacheBefore.count, true);
            expect('キャッシュのバイト数が増えていない', stats.bytes <= liveCacheBefore.bytes, true);
        }

        var found = false;
        try {
            if (stats.items) {
                for (var i = 0; i < stats.items.length; i++) {
                    if (stats.items[i] && stats.items[i].videoId === vid) found = true;
                }
            }
        } catch (e) { }
        note('集計に videoId の一覧があるか', stats.items ? 'ある' : '無い（本数で判定する）');

        /* 集計に一覧が無い場合に備えて、取り出しでも確かめる。 */
        var hit = null;
        try { hit = await chatCacheGet(vid); } catch (e) { hit = null; }
        expect('ライブの動画がキャッシュから引けないこと', !!hit || found, false);
    }

    /* --- D-L4: 一括シークの対象外 / ▶一括再生は効く --------------------------- */
    async function testL4() {
        log('  [目的] ⭐「同期しない」が守られていること。');
        log('        ライブ枠は一括シークで動かず、▶一括再生では再生が始まること。');
        var vid = liveVid();
        pc('配信中のライブの動画IDを受け取れた', function () { return vid || false; });
        if (!vid) return;
        var cid = firstCard();
        pc('対象の枠を特定できた', function () { return cid || false; });
        if (!cid) return;
        pc('この枠がライブだと判定できている（判定できないと除外も効かない）', function () {
            return (typeof isLiveCard === 'function' && isLiveCard(cid)) ? 'isLiveCard=true' : false;
        });

        var p = null;
        try { p = ytPlayers[cid]; } catch (e) { p = null; }
        pc('プレイヤーを掴めた', function () { return p ? 'ok' : false; });
        if (!p) return;

        /* まず再生させる（▶一括再生はライブも対象という要件の確認も兼ねる）。 */
        var rp = await clickReal(document.getElementById('playPauseBtn'));
        expect('「▶ 一括再生」を実際に押せた（被覆なし）', rp.blocked ? ('blocked:' + rp.reason) : 'ok', 'ok');
        var start = 0;
        try { start = p.getCurrentTime() || 0; } catch (e) { start = 0; }
        var adv = await waitFor(function () {
            var st = 'ERR', c = 0;
            try { st = p.getPlayerState(); } catch (e) { st = 'ERR'; }
            try { c = p.getCurrentTime() || 0; } catch (e) { c = 0; }
            return hasAdvanced(start, c, st) ? ('位置 ' + c + ' / state ' + st) : false;
        }, 30000, 500);
        expect('▶一括再生でライブ枠の再生が始まった', adv.ok, true);
        note('再生開始の観測', adv.ok ? adv.value : '(始まらなかった)');

        /* 一括シークを投げて、ライブ枠が動かないことを見る。
           🔴 ライブの再生位置は放っておいても進むので、
              「シークで飛んだか」を進行と区別する必要がある。
              −600秒を要求し、位置が減っていないことで判定する。 */
        var before = 0;
        try { before = p.getCurrentTime() || 0; } catch (e) { before = 0; }
        note('一括シーク前の位置(秒)', Math.round(before));
        try { skipAll(-600); } catch (e) { log('  ⚠ skipAll が呼べない: ' + (e && e.message)); }
        await wait(4000);
        var after = 0;
        try { after = p.getCurrentTime() || 0; } catch (e) { after = 0; }
        note('一括シーク後の位置(秒)', Math.round(after));
        note('位置の変化(秒)', Math.round(after - before));
        expect('ライブ枠が巻き戻っていない（一括シークの対象外）', after >= before - 5, true);
    }

    /* --- D-L5: ライブの流し ---------------------------------------------------- */
    async function testL5() {
        log('  [目的] 到着順にそのまま流れること（再生位置と突き合わせない）。');
        var vid = liveVid();
        pc('配信中のライブの動画IDを受け取れた', function () { return vid || false; });
        if (!vid) return;
        var cid = firstCard();
        pc('対象の枠を特定できた', function () { return cid || false; });
        if (!cid) return;
        pc('ライブの取得が始まっている', function () {
            return countOf(vid) ? (countOf(vid) + '件') : false;
        });
        if (!countOf(vid)) return;

        /* 🔴 トグルは押す前の状態を必ず読む（D-C4 で踏んだ罠）。 */
        var fb = document.getElementById('flowToggleBtn_' + cid);
        pc('🌊 ボタンを特定できた', function () { return fb ? describe(fb) : false; });
        var was = false;
        try { was = !!(typeof flowVisible !== 'undefined' && flowVisible[cid]); } catch (e) { }
        note('🌊 を押す前の状態', was ? 'すでにオン（押さない）' : 'オフ（これから押す）');
        if (!was) await clickReal(fb);
        var on = false;
        try { on = !!(typeof flowVisible !== 'undefined' && flowVisible[cid]); } catch (e) { }
        expect('🌊（コメントを流す）がオンになった', on, true);

        /* 🔴 ★v1.5.1: v1.5.0 は 🌊 を押した直後に flowLive を読んでいた。
           流しの tick は 250ms 間隔なので、1度も回る前の初期値を読んでおり
           測定になっていなかった（v2.8.0 の検証で false と出て判定不能になった）。
           1秒待ってから読み、計測後にもう一度読む。 */
        function readFlowLive() {
            try { return String(!!flowLive[cid]); } catch (e) { return '(読めない)'; }
        }
        function readFlowCursor() {
            try { return String(flowCursor[cid]); } catch (e) { return '(読めない)'; }
        }
        await wait(1000);
        var liveFlagBefore = readFlowLive();
        var cursorBefore = readFlowCursor();
        note('ライブとして流しているか（1秒後）', liveFlagBefore);
        note('流しのカーソル（計測前）', cursorBefore);

        var s = await sample(500, 30, function () {
            var layer = document.getElementById('flowLayer_' + cid);
            return layer ? layer.childElementCount : 0;
        });
        note('画面上のコメント数（500ms × 30回 ＝ 15秒）',
            'min=' + s.min + ' / max=' + s.max + ' / avg=' + s.avg + ' / 0件だった回数=' + s.zeros);
        expect('コメントが実際に画面を流れた（最大同時表示数）', s.max, gtZero);

        var liveFlagAfter = readFlowLive();
        note('ライブとして流しているか（計測後）', liveFlagAfter);
        note('流しのカーソル（計測後）', readFlowCursor());
        note('件数（計測後）', countOf(vid));

        /* 🔴 ここが v2.8.0 の要件そのものである。
           ライブ枠がアーカイブ経路で流れていても画面上は流れて見えてしまうため、
           「流れたこと」だけでは実装が意図どおりか判定できない。
           ⚠️ ライブの t は「配信開始からの経過ms」で、ライブの再生位置とも
              桁が一致してしまうので、なおさら見た目では区別がつかない。 */
        expect('ライブ枠がライブとして流れている（アーカイブ経路に落ちていない）',
            liveFlagAfter, 'true');

        /* 後始末: 押したぶんは戻す。 */
        if (!was) { await clickReal(fb); }
    }

    /* --- D-L6: 取得タブの維持と、設定値が書き換わっていないこと ----------------- */
    async function testL6() {
        log('  [目的] 「コメント取得用タブ」を close にしても、ライブ取得中は');
        log('        取得が続くこと。そして設定値そのものが書き換わっていないこと。');
        log('  [注] 取得タブの存在はこの画面から見えない。');
        log('       「件数が増え続けているか」で、取得が生きていることを間接的に測る。');

        var vid = liveVid();
        pc('配信中のライブの動画IDを受け取れた', function () { return vid || false; });
        if (!vid) return;
        pc('ライブの取得が始まっている', function () {
            return isLiveOf(vid) ? 'live=true' : false;
        });
        if (!isLiveOf(vid)) return;

        var sel = document.getElementById('chatTabPolicy');
        pc('「コメント取得用タブ」の設定を特定できた', function () {
            return sel ? ('現在 = ' + sel.value) : false;
        });
        if (!sel) return;
        var before = sel.value;
        note('設定の元の値', before);
        /* 🔴 ★v1.5.3: ここは「測定の前提」であって機能の合否ではない。
           v1.5.2 まで expect で書いており、keep のまま実行したときに
           機能は正常なのに「不合格」として集計された（2026-08-15）。
           pc にすることで「判定不能（測れていない）」として正しく出る。
           ⚠️ keep では取得タブを元から破棄しないので、この項目は成立しない。 */
        pc('この測定に必要な設定になっている（close）', function () {
            return (before === 'close') ? before : false;
        });
        if (before !== 'close') {
            note('この項目を測れなかった理由',
                '「コメント取得用タブ」が ' + before + ' だった。'
                + 'close（取得のたびに閉じる）でないと、タブが維持されたことの証明にならない');
            return;
        }

        var seq = [];
        var sm = await sample(3000, 10, function () {
            var n = countOf(vid);
            seq.push(n);
            return n;
        });
        note('件数の推移（3秒 × 10回 ＝ 30秒）', seq.join(' → '));
        expect('30秒たっても件数が増え続けている（取得タブが生きている）',
            sm.max - seq[0], gtZero);

        /* 🔴 設定値そのものを書き換えていないこと。 */
        var after = sel.value;
        note('設定の現在の値', after);
        expect('「コメント取得用タブ」の設定が書き換わっていない', after, before);
        var saved = '(読めない)';
        try { saved = String(localStorage.getItem('sync_chat_tab_policy')); } catch (e) { }
        note('localStorage の保存値', saved);
    }

    /* --- D-L7: 長時間の継続（MV3 のアイドル終了に耐えるか）--------------------- */
    async function testL7() {
        log('  [目的] MV3 バックグラウンドのアイドル終了に耐えるかを測る。');
        log('  [注] 🔴 止まっても不合格にしない。何分もったかを記録することが目的。');
        var vid = liveVid();
        pc('配信中のライブの動画IDを受け取れた', function () { return vid || false; });
        if (!vid) return;
        pc('ライブの取得が始まっている', function () {
            return isLiveOf(vid) ? 'live=true' : false;
        });
        if (!isLiveOf(vid)) return;

        window.alert('これから30分、1分おきに件数を数えます。\n\n'
            + '・このタブは閉じないでください（他のタブを見るのは自由です）\n'
            + '・about:debugging の「調査」パネルは閉じておいてください\n'
            + '　（開いているとバックグラウンドが終了せず、測定になりません）\n\n'
            + 'OK を押すと始まります。');

        var seq = [], stalledAt = null, prev = -1;
        var t0 = Date.now();
        for (var i = 0; i < 30; i++) {
            var n = countOf(vid);
            seq.push(Math.round((Date.now() - t0) / 60000) + '分:' + n);
            if (prev >= 0 && n === prev && stalledAt === null && i >= 2) {
                /* 1分間まったく増えなかった最初の時点を控える（確定はしない）。 */
                stalledAt = Math.round((Date.now() - t0) / 60000);
            }
            if (prev >= 0 && n > prev) stalledAt = null;   /* また増えたら取り消す */
            prev = n;
            if (i < 29) await wait(60000);
        }
        note('件数の推移（1分 × 30回）', seq.join(' / '));
        note('最初に1分間増えなかった時点', stalledAt === null ? '(最後まで増え続けた)' : (stalledAt + '分'));
        note('30分後の総件数', countOf(vid));
        /* 🔴 合否は付けない。観測そのものが成果である。 */
        await ask('30分のあいだ、チャットは流れ続けていましたか',
            ['ずっと流れていた', '途中で止まった', '見ていなかった']);
    }

    /* ======================================================================
       ★v1.7.0: D-G ─ 参照されなくなったコメント配列の破棄（v2.8.3）

       🔴 この群でいちばん起こりやすい誤判定は「無かったものを『消えた』と読む」ことである。
          そのため、どの項目でも
            ・chatStore を名前で読めていること
            ・測る前にその videoId が実在したこと
          を positive control として必ず先に出す。
       🔴 「残っていること」を見る項目（D-G2 / D-G5）は、それだけでは
          「解放処理が動いていない」場合でも合格に見える。
          参照の無いダミーを1件置き、それが消えたことを PC にして
          「解放処理が実際に走った」ことを担保する。
       ⚠️ chatStore / chatState / chatError / chatInflight は本体の let（グローバル
          レキシカル環境）なので window からは読めない。名前で直接参照し TDZ 対策で try/catch。
       ====================================================================== */

    var ORPHAN_ID = '__debug_orphan_g__';   /* どの枠も参照しない、捨てられるべきダミー */

    function storeKeys() {
        try { return (typeof chatStore !== 'undefined') ? Object.keys(chatStore) : null; }
        catch (e) { return null; }
    }
    function hasStore(vid) {
        var k = storeKeys();
        return !!(k && k.indexOf(vid) >= 0);
    }
    function inflightOf(vid) {
        try { return (typeof chatInflight !== 'undefined') ? (chatInflight[vid] || null) : null; }
        catch (e) { return null; }
    }
    function loadedVidOf(cid) {
        try { return (typeof chatLoadedVideoId !== 'undefined') ? (chatLoadedVideoId[cid] || null) : null; }
        catch (e) { return null; }
    }
    function chatOpenOf(cid) {
        try { return !!(typeof chatVisible !== 'undefined' && chatVisible[cid]); }
        catch (e) { return false; }
    }
    function flowOnOf(cid) {
        try { return !!(typeof flowVisible !== 'undefined' && flowVisible[cid]); }
        catch (e) { return false; }
    }
    function cardCount() {
        try { return (typeof activeCardIds !== 'undefined') ? activeCardIds.length : 0; }
        catch (e) { return 0; }
    }
    function lastCard() {
        try {
            if (typeof activeCardIds !== 'undefined' && activeCardIds.length) {
                return activeCardIds[activeCardIds.length - 1];
            }
        } catch (e) { }
        return null;
    }

    /* 参照の無いダミーを置く。解放処理が走ったかどうかの唯一の裏づけになる。 */
    function seedOrphan() {
        try {
            chatStore[ORPHAN_ID] = {
                comments: [], emoji: {}, source: 'debug_suite',
                complete: true, truncated: false, gap: false,
                videoMs: 0, lastT: 0, nextSeq: 0, live: false
            };
            chatState[ORPHAN_ID] = 'ready';
        } catch (e) { }
        return hasStore(ORPHAN_ID);
    }
    function dropOrphan() {
        try { delete chatStore[ORPHAN_ID]; delete chatState[ORPHAN_ID]; } catch (e) { }
    }

    /* 枠を n 枠以上にする。実際に ➕ を押す（関数の直呼びで代用しない）。 */
    async function ensureCardCount(n) {
        var plus = document.getElementById('topCountPlus');
        var guard = 0;
        while (cardCount() < n && guard < 10) {
            if (!plus) break;
            await clickReal(plus);
            await wait(500);
            guard++;
        }
        return cardCount();
    }

    /* 枠数を1つ減らす。消えるのは activeCardIds の末尾の枠。 */
    async function shrinkCardCount() {
        var minus = document.getElementById('topCountMinus');
        var r = await clickReal(minus);
        await wait(800);
        return r;
    }

    /* 🗑 を実際に押して枠を削除する。確認ダイアログは一時的に切る（保存はしない）。
       ⚠️ 枠のヘッダーは押し下げ式で、マウスが枠外にあると被覆ありと出るのが正常。
          判定は「枠が実際に消えたか」で行い、当たり判定は note に残す。 */
    async function deleteCard(cid) {
        var chk = document.getElementById('confirmDelete');
        var was = chk ? chk.checked : null;
        if (chk) chk.checked = false;
        var btn = document.querySelector('#' + cid + ' .player-header .delete-btn');
        var r = { blocked: true, reason: 'button-null', hit: '(ボタンが無い)', clicked: false };
        if (btn) r = await clickReal(btn);
        await wait(700);
        if (chk && was !== null) chk.checked = was;
        return { ok: !document.getElementById(cid), click: r };
    }

    /* 枠へ動画を入れ、チャット欄を開き、キャッシュを捨ててから完走まで待つ。
       opt = { cid, videoId, skipReload, waitMs, needSettled } */
    async function prepareChatCard(opt) {
        var cleared = await clearCard(opt.cid);
        pc('枠を「URL入力待ち」にできた（' + opt.cid + '）', function () { return cleared ? 'ok' : false; });
        if (!cleared) return false;

        var ld = await loadUrlIntoCard(opt.cid, ytUrl(opt.videoId));
        expect('「読み込む」を実際に押せた（被覆なし / ' + opt.cid + '）',
            ld.ok ? 'ok' : ('blocked:' + ld.reason), 'ok');

        var pane = await openChatPane(opt.cid);
        pc('チャット欄を開けた（' + opt.cid + '）', function () { return pane.ok ? 'ok' : false; });
        if (!pane.ok) return false;

        if (!opt.skipReload) {
            /* 🔴 キャッシュを捨ててから測る。残っていると取得エンジンを通らない。 */
            var rb = chatReloadBtn(opt.cid);
            var r2 = await clickReal(rb);
            pc('🔄（キャッシュを捨てて取り直す）を実際に押せた（' + opt.cid + '）', function () {
                return (rb && !r2.blocked) ? 'ok' : false;
            });
        }
        if (opt.needSettled !== false) {
            var w = await waitChatSettled(opt.videoId, opt.waitMs || CHAT_WAIT_MS);
            pc('取得が終端（ready / error）まで到達した（' + opt.videoId + '）', function () {
                return w.ok ? (w.value + ' / ' + Math.round(w.waitedMs / 1000) + '秒') : false;
            });
        }
        return true;
    }

    /* 全項目で共通の「読めていること」の裏づけ。読めていないと全部0件になり、
       壊れていないのに全部合格に見える。 */
    function pcStoreReadable() {
        pc('🔴 chatStore を名前で読めている（読めないと全項目が0件になり誤って合格に見える）',
            function () {
                var k = storeKeys();
                return k ? ('キー ' + k.length + '件') : false;
            });
    }

    /* --- D-G1: 🗑 枠の削除で解放される --------------------------------------- */
    async function testG1() {
        await closeAllMenus();
        await stopAllIfPlaying();
        log('  [目的] 枠を削除したとき、その動画のコメント配列が捨てられること。');
        pcStoreReadable();

        var started = cardCount();
        await ensureCardCount(2);
        pc('枠が2つ以上ある（削除しても1枠残る）', function () {
            return cardCount() >= 2 ? (cardCount() + '枠') : false;
        });
        var cid = lastCard();
        pc('削除する枠を特定できた', function () { return cid || false; });
        if (!cid || cardCount() < 2) {
            expect('この項目の実行', '枠を2つ用意できない', '2枠以上あること');
            return;
        }

        var okPrep = await prepareChatCard({ cid: cid, videoId: VID.LIGHT });
        if (!okPrep) { expect('この項目の実行', '準備できない', '準備できること'); return; }

        pc('🔴 削除する前に、その videoId が chatStore に実在した', function () {
            return hasStore(VID.LIGHT) ? (countOf(VID.LIGHT) + '件') : false;
        });
        note('削除前の chatStore のキー数', (storeKeys() || []).length);
        note('総件数（参考: 2026-08-31 時点の既知値は 356件）', countOf(VID.LIGHT));

        var del = await deleteCard(cid);
        pc('枠が実際に削除された', function () { return del.ok ? '枠のDOMが無くなった' : false; });
        note('🗑 を押したときの当たり判定',
            (del.click.blocked ? '被覆あり / ' : '被覆なし / ') + (del.click.hit || '(記録なし)'));
        await wait(400);

        expect('chatStore から消えたこと', hasStore(VID.LIGHT), false);
        expect('chatState から消えたこと', chatStateOf(VID.LIGHT), '(未取得)');
        expect('取得も残っていないこと（chatInflight）', inflightOf(VID.LIGHT) ? 'あり' : 'なし', 'なし');
        note('削除後の chatStore のキー数', (storeKeys() || []).length);

        await ensureCardCount(started);
    }

    /* --- D-G2: 🔴 他の枠が同じ動画を使っている間は解放しない（最重要） --------- */
    async function testG2() {
        await closeAllMenus();
        await stopAllIfPlaying();
        log('  [目的] 参照が1つでも残っていれば捨てないこと。ここを誤ると表示が壊れる。');
        pcStoreReadable();

        var started = cardCount();
        await ensureCardCount(2);
        var cidA = firstCard();
        var cidB = lastCard();
        pc('別々の2枠を確保できた', function () {
            return (cidA && cidB && cidA !== cidB) ? (cidA + ' / ' + cidB) : false;
        });
        if (!cidA || !cidB || cidA === cidB) {
            expect('この項目の実行', '枠を2つ用意できない', '2枠以上あること');
            return;
        }

        var okA = await prepareChatCard({ cid: cidA, videoId: VID.LIGHT });
        /* 2枠目はキャッシュから戻るので 🔄 を押さない（同じ動画を2枠で使う状態を作るのが目的）。 */
        var okB = await prepareChatCard({ cid: cidB, videoId: VID.LIGHT, skipReload: true });
        if (!okA || !okB) { expect('この項目の実行', '準備できない', '準備できること'); return; }

        /* 🔴 順序で担保しない。2枠が同じ videoId を指していることを観測する（鉄則 #24）。 */
        pc('🔴 2枠が同じ videoId を指している（観測で担保する）', function () {
            var a = loadedVidOf(cidA), b = loadedVidOf(cidB);
            return (a === VID.LIGHT && b === VID.LIGHT) ? (a + ' / ' + b) : ('A=' + a + ' / B=' + b);
        });
        pc('🔴 削除する前に、その videoId が chatStore に実在した', function () {
            return hasStore(VID.LIGHT) ? (countOf(VID.LIGHT) + '件') : false;
        });

        var before = countOf(VID.LIGHT);
        note('削除前の総件数', before);
        note('削除前の chatStore のキー数', (storeKeys() || []).length);
        pc('参照の無いダミーを置けた（解放処理が走ったことの裏づけに使う）', function () {
            return seedOrphan() ? ORPHAN_ID : false;
        });

        var del = await deleteCard(cidB);
        pc('枠Bが実際に削除された', function () { return del.ok ? '枠のDOMが無くなった' : false; });
        await wait(400);

        pc('🔴 解放処理が実際に走った（参照の無いダミーが消えた）', function () {
            return hasStore(ORPHAN_ID) ? false : 'ダミーは捨てられた';
        });
        expect('🔴 もう一方の枠が使っている動画は残っていること', hasStore(VID.LIGHT), true);
        expect('コメントの件数が減っていないこと', countOf(VID.LIGHT), before);
        expect('chatState が ready のままであること', chatStateOf(VID.LIGHT), 'ready');
        expect('残った枠のチャット欄が元の動画を指したままであること', loadedVidOf(cidA), VID.LIGHT);
        note('削除後の chatStore のキー数', (storeKeys() || []).length);

        dropOrphan();
        await ensureCardCount(started);
    }

    /* --- D-G3: 🧹 枠を空にすると解放され、取得も止まる ------------------------ */
    async function testG3() {
        await closeAllMenus();
        await stopAllIfPlaying();
        log('  [目的] 枠を空にしたとき、取得を止めてから捨てること。');
        log('  [なぜ重い動画を使うか] 軽い動画は押す前に完走してしまい、「止まった」を測れない。');
        pcStoreReadable();

        var cid = firstCard();
        pc('対象の枠を特定できた（activeCardIds[0]）', function () { return cid || false; });
        if (!cid) { expect('この項目の実行', '枠が1つも無い', '枠が1つ以上あること'); return; }

        /* 完走は待たない。取得が走っている最中に 🧹 を押すのがこの項目の目的。 */
        var okPrep = await prepareChatCard({ cid: cid, videoId: VID.HEAVY, needSettled: false });
        if (!okPrep) { expect('この項目の実行', '準備できない', '準備できること'); return; }

        var iw = await waitFor(function () {
            return inflightOf(VID.HEAVY) ? 'あり' : false;
        }, 60000, 500);
        pc('🔴 押す前に取得が走っていた（走っていないと「止まった」を測れない）', function () {
            return iw.ok ? ('chatInflight にあり / ' + Math.round(iw.waitedMs / 1000) + '秒待った') : false;
        });

        var cw = await waitFor(function () {
            var n = countOf(VID.HEAVY);
            return n > 0 ? n : false;
        }, 120000, 500);
        pc('コメントが実際に届き始めていた', function () {
            return cw.ok ? (cw.value + '件') : false;
        });
        note('🧹 を押す直前の件数', countOf(VID.HEAVY));
        note('🧹 を押す直前の chatState', chatStateOf(VID.HEAVY));

        var cleared = await clearCard(cid);   /* 🧹 を実際に押す */
        pc('🧹（枠を空にする）で枠が空になった', function () { return cleared ? 'ok' : false; });
        await wait(400);

        expect('取得が止まっていること（chatInflight から消えた）',
            inflightOf(VID.HEAVY) ? 'あり' : 'なし', 'なし');
        expect('chatStore から消えたこと', hasStore(VID.HEAVY), false);
        expect('chatState から消えたこと', chatStateOf(VID.HEAVY), '(未取得)');

        /* 🔴 中止のあとに届いたチャンクで store が作り直されると、断片だけが残る。 */
        await wait(3000);
        expect('🔴 3秒後も作り直されていないこと（遅れて届いたチャンクの再生成）',
            hasStore(VID.HEAVY), false);
        note('3秒後の chatStore のキー数', (storeKeys() || []).length);
    }

    /* --- D-G4: 枠数を減らすと解放される -------------------------------------- */
    async function testG4() {
        await closeAllMenus();
        await stopAllIfPlaying();
        log('  [目的] ➖ で枠数を減らした経路でも捨てられること。');
        log('  [補足] この経路は clearChatState() をまったく通らない（別の後始末になっている）。');
        pcStoreReadable();

        var started = cardCount();
        await ensureCardCount(2);
        var cid = lastCard();
        pc('枠が2つ以上ある', function () { return cardCount() >= 2 ? (cardCount() + '枠') : false; });
        if (!cid || cardCount() < 2) {
            expect('この項目の実行', '枠を2つ用意できない', '2枠以上あること');
            return;
        }

        var okPrep = await prepareChatCard({ cid: cid, videoId: VID.LIGHT });
        if (!okPrep) { expect('この項目の実行', '準備できない', '準備できること'); return; }

        pc('🔴 減らす前に、その videoId が chatStore に実在した', function () {
            return hasStore(VID.LIGHT) ? (countOf(VID.LIGHT) + '件') : false;
        });
        pc('対象が最後の枠である（➖ で消えるのは最後の枠）', function () {
            return (lastCard() === cid) ? cid : false;
        });
        note('減らす前の枠数', cardCount());
        note('減らす前の chatStore のキー数', (storeKeys() || []).length);

        var before = cardCount();
        await shrinkCardCount();
        pc('枠が実際に減った', function () {
            return (!document.getElementById(cid) && cardCount() < before)
                ? (before + '枠 → ' + cardCount() + '枠') : false;
        });

        expect('chatStore から消えたこと', hasStore(VID.LIGHT), false);
        expect('chatState から消えたこと', chatStateOf(VID.LIGHT), '(未取得)');
        expect('取得も残っていないこと（chatInflight）', inflightOf(VID.LIGHT) ? 'あり' : 'なし', 'なし');
        note('減らした後の chatStore のキー数', (storeKeys() || []).length);

        await ensureCardCount(started);
    }

    /* --- D-G5: 🔴 流しだけONの枠の動画は解放しない（罠の検出） ----------------- */
    async function testG5() {
        await closeAllMenus();
        await stopAllIfPlaying();
        log('  [目的] チャット欄を閉じ 🌊 だけONにした枠のコメントを捨てないこと。');
        log('  [なぜ重い動画を使うか] 薄い素材だと正常でも画面上0件になり、判定が成立しない。');
        pcStoreReadable();

        var started = cardCount();
        await ensureCardCount(2);
        var cidA = firstCard();   /* 流しだけONにする枠（守られる側） */
        var cidB = lastCard();    /* 削除して解放処理を走らせる枠 */
        pc('別々の2枠を確保できた', function () {
            return (cidA && cidB && cidA !== cidB) ? (cidA + ' / ' + cidB) : false;
        });
        if (!cidA || !cidB || cidA === cidB) {
            expect('この項目の実行', '枠を2つ用意できない', '2枠以上あること');
            return;
        }

        /* 🔴 ここでは 🔄 を押さない。キャッシュがあればそのまま使う（測るのは解放であって取得ではない）。 */
        var okPrep = await prepareChatCard({
            cid: cidA, videoId: VID.HEAVY, skipReload: true, needSettled: false
        });
        if (!okPrep) { expect('この項目の実行', '準備できない', '準備できること'); return; }

        var w = await waitFor(function () {
            var n = countOf(VID.HEAVY);
            return n >= 2000 ? n : false;
        }, 240000, 1000);
        pc('流しを測れるだけコメントが届いた（2000件以上）', function () {
            return w.ok ? (w.value + '件') : false;
        });
        var store = chatStoreOf(VID.HEAVY);
        if (!store || store.comments.length < 2000) {
            expect('この項目の実行', 'コメントが足りず流しを測れない', '2000件以上届くこと');
            await ensureCardCount(started);
            return;
        }
        note('取得の状態 chatState', chatStateOf(VID.HEAVY));
        note('手元の総件数', countOf(VID.HEAVY));

        /* 🔴 素材の密度を先に確かめる（鉄則 #14）。 */
        var dense = densestWindow(store.comments, 20000);
        note('最も密な20秒の窓（開始位置ms / 件数）', dense.startMs + ' / ' + dense.count);
        pc('20秒あたり3件以上ある区間を選べた', function () {
            return (dense.count >= 3) ? (dense.count + '件/20秒') : false;
        });

        /* 💬 を閉じ、🌊 だけONにする。これがこの項目の条件そのもの。 */
        var chatBtn = document.getElementById('chatToggleBtn_' + cidA);
        if (chatOpenOf(cidA)) { await clickReal(chatBtn); await wait(400); }
        pc('🔴 チャット欄を閉じられた（流しだけONの状態を作れた）', function () {
            return chatOpenOf(cidA) ? false : 'chatVisible = false';
        });
        var fb = document.getElementById('flowToggleBtn_' + cidA);
        pc('🌊 ボタンを特定できた', function () { return fb ? describe(fb) : false; });
        /* ⚠️ 🌊 はトグル。前の実行がオンのまま終わっていると押した結果オフになる。 */
        var flowWas = flowOnOf(cidA);
        note('🌊 を押す前の状態', flowWas ? 'すでにオン（押さない）' : 'オフ（これから押す）');
        if (!flowWas) { await clickReal(fb); await wait(400); }
        pc('🌊（コメントを流す）がオンになった', function () {
            return flowOnOf(cidA) ? 'flowVisible = true' : false;
        });

        var seekSec = Math.max(0, Math.round(dense.startMs / 1000) - 1);
        try { ytPlayers[cidA].seekTo(seekSec, true); } catch (e) { }
        log('  [操作] 濃い区間へシークした: ' + seekSec + '秒');
        var sk = await waitFor(function () {
            var t = 0;
            try { t = ytPlayers[cidA].getCurrentTime() || 0; } catch (e) { t = 0; }
            return (Math.abs(t - seekSec) < 5) ? t : false;
        }, 20000, 500);
        pc('シークが完了した（要求位置の±5秒以内）', function () {
            return sk.ok ? ('現在位置 = ' + sk.value + '秒') : false;
        });

        await clickReal(document.getElementById('playPauseBtn'));
        var startPos = 0;
        try { startPos = ytPlayers[cidA].getCurrentTime() || 0; } catch (e) { startPos = 0; }
        var adv = await waitFor(function () {
            var s = 'ERR', c = 0;
            try { s = ytPlayers[cidA].getPlayerState(); } catch (e) { s = 'ERR'; }
            try { c = ytPlayers[cidA].getCurrentTime() || 0; } catch (e) { c = 0; }
            return hasAdvanced(startPos, c, s) ? ('位置 ' + c + ' / state ' + s) : false;
        }, 30000, 500);
        pc('動画が実際に再生された（再生しないと流しは進まない）', function () {
            return adv.ok ? adv.value : false;
        });

        function layerCount() {
            var l = document.getElementById('flowLayer_' + cidA);
            return l ? l.childElementCount : 0;
        }

        /* 🔴 解放の前に、実際に描画されていることを確かめる（鉄則 #11）。
           これが無いと「元から流れていなかった」のか「解放で消えた」のかを区別できない。 */
        var s1 = await sample(250, 12, layerCount);
        note('解放前の画面上コメント数（250ms × 12回）',
            'min=' + s1.min + ' / max=' + s1.max + ' / avg=' + s1.avg + ' / 0件だった回数=' + s1.zeros);
        pc('🔴 解放の前に流しが実際に描画されていた（件数を数えるだけでは画面に出ているか分からない）',
            function () { return s1.max > 0 ? ('最大 ' + s1.max + '件') : false; });

        var beforeN = countOf(VID.HEAVY);
        note('解放前の総件数', beforeN);
        pc('参照の無いダミーを置けた（解放処理が走ったことの裏づけに使う）', function () {
            return seedOrphan() ? ORPHAN_ID : false;
        });

        /* 解放処理を実際の経路で走らせる（枠Bを削除する）。 */
        var del = await deleteCard(cidB);
        pc('枠Bが実際に削除された（解放処理の契機）', function () {
            return del.ok ? '枠のDOMが無くなった' : false;
        });
        await wait(400);
        pc('🔴 解放処理が実際に走った（参照の無いダミーが消えた）', function () {
            return hasStore(ORPHAN_ID) ? false : 'ダミーは捨てられた';
        });

        expect('🔴 流しだけONの枠の動画が残っていること', hasStore(VID.HEAVY), true);
        expect('コメントの件数が減っていないこと', countOf(VID.HEAVY) >= beforeN, true);

        var s2 = await sample(250, 12, layerCount);
        note('解放後の画面上コメント数（250ms × 12回）',
            'min=' + s2.min + ' / max=' + s2.max + ' / avg=' + s2.avg + ' / 0件だった回数=' + s2.zeros);
        expect('🔴 解放のあとも流れているコメントが0件にならないこと', s2.max, gtZero);

        /* 止まっていないことの補足。合否は付けない。 */
        function firstX() {
            var l = document.getElementById('flowLayer_' + cidA);
            var c = l && l.firstElementChild;
            if (!c) return null;
            try { return Math.round(c.getBoundingClientRect().left); } catch (e) { return null; }
        }
        var x1 = firstX();
        await wait(500);
        var x2 = firstX();
        note('流しの要素が動いているか（500ms間隔の左端px）', x1 + ' → ' + x2);

        await stopAllIfPlaying();
        dropOrphan();
        /* 🔴 後始末: 次の実行が「すでにオン」から始まらないようオフへ戻す。 */
        if (flowOnOf(cidA)) { await clickReal(fb); await wait(300); }
        note('後始末: 流しの状態', flowOnOf(cidA) ? '★オンのまま残った' : 'オフへ戻した');
        await ensureCardCount(started);
    }

    /* --- D-G6: 既存機能の回帰（解放が効きすぎていないこと） -------------------- */
    async function testG6() {
        await closeAllMenus();
        await stopAllIfPlaying();
        log('  [目的] この版で増えたリスクは「捨てすぎ」である。通常の使い方で消えないことを見る。');
        pcStoreReadable();

        var started = cardCount();
        await ensureCardCount(2);
        var cidA = firstCard();
        var cidB = lastCard();
        pc('別々の2枠を確保できた', function () {
            return (cidA && cidB && cidA !== cidB) ? (cidA + ' / ' + cidB) : false;
        });
        if (!cidA || !cidB || cidA === cidB) {
            expect('この項目の実行', '枠を2つ用意できない', '2枠以上あること');
            return;
        }

        var okA = await prepareChatCard({ cid: cidA, videoId: VID.LIGHT });
        expect('軽いアーカイブの取得が完走したこと', chatStateOf(VID.LIGHT), 'ready');
        note('軽いアーカイブの総件数（参考: 既知値 356件）', countOf(VID.LIGHT));

        var okB = await prepareChatCard({ cid: cidB, videoId: VID.MID });
        expect('別の動画の取得が完走したこと', chatStateOf(VID.MID), 'ready');
        expect('別の動画の総件数が0でないこと', countOf(VID.MID), gtZero);
        note('別の動画の総件数（参考: 2026-08 時点で 902件）', countOf(VID.MID));

        expect('🔴 2本のコメントが同時に手元へ残ること（解放が効きすぎていないこと）',
            (hasStore(VID.LIGHT) && hasStore(VID.MID)), true);
        note('この時点の chatStore のキー数', (storeKeys() || []).length);

        /* 💬 を閉じただけでは捨てない（意図的な設計）。 */
        var chatBtn = document.getElementById('chatToggleBtn_' + cidA);
        if (chatOpenOf(cidA)) { await clickReal(chatBtn); await wait(500); }
        pc('チャット欄を閉じられた', function () {
            return chatOpenOf(cidA) ? false : 'chatVisible = false';
        });
        expect('🔴 チャット欄を閉じても捨てられないこと（意図的な設計）', hasStore(VID.LIGHT), true);

        /* 開き直したときに取り直しになっていないこと。 */
        await clickReal(chatBtn);
        await wait(1200);
        pc('チャット欄を開き直せた', function () {
            return chatOpenOf(cidA) ? 'chatVisible = true' : false;
        });
        expect('開き直しても取り直しになっていないこと（chatState が ready のまま）',
            chatStateOf(VID.LIGHT), 'ready');
        expect('チャット欄が元の動画を指していること', loadedVidOf(cidA), VID.LIGHT);

        await ensureCardCount(started);
    }


    /* ========================================================================
       ★v1.8.0: D-Y 群 ─ ピン留め時のレイアウト（v2.8.5 の検証）

       🔴 いずれも manual: true。「▶ すべて実行」には入れない
          （入れると ▶ すべて実行 の判定数が版をまたいで比較できなくなる）。
          一括ボタンは「📐 D-Y レイアウト一括」。

       🔴 判定の土台について
          getComputedStyle().gridTemplateRows が暗黙トラックを含むかはブラウザ依存で、
          判定の土台にするには弱い。そのため主判定は次の2つに置く。
            ・グリッド矩形からのはみ出し量が 0px であること
            ・全カードのセル座標が「既存トラックの境界」に解決できること
              （暗黙の行へ落ちた枠は、どの境界とも一致しないので必ず -1 になる）
          トラック数は補助判定に留め、測定手段が反応することは
          D-Y6（列数 3 → 5）を positive control として担保する。

       🔴 ピンは必ず「末尾の枠」に付ける。
          先頭の枠は order が 1 なので dense でも最初に置かれ、修正前でも崩れない。
          先頭でどうなるかは D-Y1 の note に残す（判定にはしない）。
       ====================================================================== */

    var CELL_TOL = 3;              /* セル境界の許容差(px) */
    var PIN_SPAN_TOL = 6;          /* 「2倍」の許容差(px)。gap を足して比べる */
    var PIN_BIG_RATIO = 1.8;       /* 「実際に大きくなった」とみなす縦の倍率 */
    var LAYOUT_SETTLE_MS = 3000;   /* .player-card は transition: all 0.3s ease */

    function gridEl() { return document.getElementById('playersGrid'); }
    function gridCards() {
        var g = gridEl();
        return g ? Array.prototype.slice.call(g.children) : [];
    }
    function pinBtnOf(cid) { return document.querySelector('#' + cid + ' .player-header .pin-btn'); }
    /* ★v1.9.0: ヘッダーの ◀▶。専用クラスを持たないので onclick 属性の向きから引く。
       🔴 DOM の並び順に依存させない（並びが変わっても壊れないようにする）。 */
    function moveBtnOf(cid, dir) {
        var list = document.querySelectorAll('#' + cid + ' .player-header button[onclick*="moveCard"]');
        for (var i = 0; i < list.length; i++) {
            var a = list[i].getAttribute('onclick') || '';
            if (dir > 0 ? /,\s*1\s*\)/.test(a) : /,\s*-1\s*\)/.test(a)) return list[i];
        }
        return null;
    }
    /* ⚠️ 枠のヘッダーは押し下げ式なので、マウスが枠外にあると被覆ありと出るのが正常
          （/get-debug-suite 8節）。判定は「効果が出たか」で行い、当たり判定は note に残す。 */
    async function pressMove(cid, dir) {
        var b = moveBtnOf(cid, dir);
        var r = { blocked: true, reason: 'button-null', hit: '(ボタンが無い)', clicked: false };
        if (b) r = await clickReal(b);
        await wait(350);
        return r;
    }
    function pinnedCards() {
        return gridCards().filter(function (c) { return c.classList.contains('is-main'); });
    }

    /* 'repeat(3, ...)' は計算済みでは '343px 343px 343px' に解決される。 */
    function parseTracks(s) {
        if (!s || s === 'none') return [];
        return String(s).trim().split(/\s+/).map(function (v) { return parseFloat(v); })
            .filter(function (v) { return isFinite(v); });
    }
    function trackStarts(sizes, gap, origin) {
        var out = [], x = origin, i;
        for (i = 0; i < sizes.length; i++) { out.push(x); x += sizes[i] + gap; }
        return out;
    }
    function gridGeom() {
        var g = gridEl();
        if (!g) return null;
        var cs, b;
        try { cs = window.getComputedStyle(g); } catch (e) { return null; }
        b = g.getBoundingClientRect();
        var padL = parseFloat(cs.paddingLeft) || 0;
        var padT = parseFloat(cs.paddingTop) || 0;
        var cGap = parseFloat(cs.columnGap) || 0;
        var rGap = parseFloat(cs.rowGap) || 0;
        var cols = parseTracks(cs.gridTemplateColumns);
        var rows = parseTracks(cs.gridTemplateRows);
        return {
            cols: cols, rows: rows, colGap: cGap, rowGap: rGap,
            colStarts: trackStarts(cols, cGap, b.left + padL),
            rowStarts: trackStarts(rows, rGap, b.top + padT),
            rect: rect(g),
            colText: String(cs.gridTemplateColumns),
            rowText: String(cs.gridTemplateRows)
        };
    }
    function nearStart(starts, v) {
        for (var i = 0; i < starts.length; i++) {
            if (Math.abs(starts[i] - v) <= CELL_TOL) return i;
        }
        return -1;
    }
    function nearEnd(starts, sizes, v) {
        for (var i = 0; i < starts.length; i++) {
            if (Math.abs(starts[i] + sizes[i] - v) <= CELL_TOL) return i;
        }
        return -1;
    }
    /* 🔴 矩形からセル座標を逆算する。解決できなければ -1。
       暗黙の行へ落ちた枠は既存トラックのどの境界とも一致しないので、
       暗黙トラックが計算済みスタイルに出るかどうかに依存せず検出できる。 */
    function cellOfCard(card, geom) {
        var b = card.getBoundingClientRect();
        var c0 = nearStart(geom.colStarts, b.left);
        var r0 = nearStart(geom.rowStarts, b.top);
        var c1 = nearEnd(geom.colStarts, geom.cols, b.right);
        var r1 = nearEnd(geom.rowStarts, geom.rows, b.bottom);
        return {
            id: card.id,
            pinned: card.classList.contains('is-main'),
            r: (r0 >= 0) ? (r0 + 1) : -1,
            c: (c0 >= 0) ? (c0 + 1) : -1,
            rs: (r0 >= 0 && r1 >= r0) ? (r1 - r0 + 1) : -1,
            cs: (c0 >= 0 && c1 >= c0) ? (c1 - c0 + 1) : -1,
            rect: {
                left: Math.round(b.left), top: Math.round(b.top),
                width: Math.round(b.width), height: Math.round(b.height)
            }
        };
    }

    /* レイアウト全体を1回で測る。判定はここが返した値だけを見る。 */
    function layoutSnapshot() {
        var geom = gridGeom();
        if (!geom) return null;
        var cards = gridCards();
        var cells = [], used = {}, tops = {};
        var unresolved = 0, overlap = 0, outside = 0;
        /* 🔴 ★v1.8.1: ビューポート基準のはみ出し（/get-dev-workflow 鉄則 #41）。
           親要素（グリッド）自身が伸びる崩れ方では、グリッド基準の outside は
           原理的に常に 0 を返す。v2.8.5 では D-Y5【9枠】と D-Y6【手動2列】が
           実際には画面外へ 102px / 435px 出ていたのに outside = 0 で合格した。
           🔴 利用者が「はみ出した」と言う対象は画面であって親要素ではない。
           ⚠️ グリッド基準の outside は残す。どちらが伸びているかの切り分けに使える。 */
        var vpOut = 0, vpH = window.innerHeight || 0, vpList = [];
        cards.forEach(function (c) {
            var q = cellOfCard(c, geom);
            cells.push(q);
            var rc = rect(c);
            var o = outsideOf(rc, geom.rect);
            if (o > outside) outside = o;
            var vo = Math.max(0, rc.bottom - vpH);
            vpList.push(c.id + ':' + Math.round(vo));
            if (vo > vpOut) vpOut = vo;
            tops[q.rect.top] = 1;
            if (q.r < 0 || q.c < 0 || q.rs < 0 || q.cs < 0) { unresolved++; return; }
            for (var i = 0; i < q.rs; i++) {
                for (var j = 0; j < q.cs; j++) {
                    var k = (q.r + i) + '-' + (q.c + j);
                    if (used[k]) overlap++;
                    used[k] = 1;
                }
            }
        });
        var keys = Object.keys(used).sort();
        var total = geom.rows.length * geom.cols.length;
        return {
            geom: geom, cells: cells, n: cards.length,
            outside: Math.round(outside),
            viewportOutside: Math.round(vpOut), viewportH: vpH,
            viewportList: vpList.join(' / '),
            unresolved: unresolved, overlap: overlap,
            occupied: keys.length, total: total, holes: total - keys.length,
            usedKeys: keys, topsCount: Object.keys(tops).length,
            colCount: geom.cols.length, rowCount: geom.rows.length
        };
    }

    /* 🔴 矩形が落ち着いてから測る（鉄則 #27）。
       グリッド自身は大きさが変わらないので、基準にするのは「枠のほう」。 */
    async function settledSnapshot(cid) {
        var el = cid ? document.getElementById(cid) : null;
        var w = await waitRectSettled(el || gridEl(), LAYOUT_SETTLE_MS);
        return { settled: w.settled, ms: w.ms, snap: layoutSnapshot() };
    }

    /* 枠数をちょうど n にする。➕ / ➖ を実際に押す。 */
    async function setCardCount(n) {
        await ensureCardCount(n);
        var guard = 0;
        while (cardCount() > n && guard < 12) { await shrinkCardCount(); guard++; }
        await wait(300);
        return cardCount();
    }

    /* 📌 を実際に押す。
       ⚠️ 枠のヘッダーは押し下げ式なので、マウスが枠外にあると被覆ありと出るのが正常
          （/get-debug-suite 8節）。判定は「is-main が付いたか」で行い、当たり判定は note。 */
    async function pinCardId(cid) {
        var btn = pinBtnOf(cid);
        var r = { blocked: true, reason: 'button-null', hit: '(ボタンが無い)', clicked: false };
        if (btn) r = await clickReal(btn);
        await wait(350);
        var el = document.getElementById(cid);
        return { ok: !!(el && el.classList.contains('is-main')), click: r };
    }
    async function clearPins() {
        var ps = pinnedCards(), i;
        for (i = 0; i < ps.length; i++) {
            var b = ps[i].querySelector('.pin-btn');
            if (b) { await clickReal(b); await wait(300); }
        }
        await wait(200);
        return pinnedCards().length;
    }

    /* 🔴 「クラスは付いたが見た目が変わっていない」を捕まえる（鉄則 #38）。
       cols が 1 のときは横は広がらないので、縦の倍率だけで見る。 */
    function biggerCheck(snap) {
        if (!snap) return null;
        var pin = null, small = null;
        snap.cells.forEach(function (q) {
            if (q.pinned) { if (!pin) pin = q; }
            else if (!small) small = q;
        });
        if (!pin || !small || small.rect.height <= 0) return null;
        var ratio = pin.rect.height / small.rect.height;
        if (ratio < PIN_BIG_RATIO) return null;
        return {
            pin: pin, small: small, ratio: ratio,
            text: 'ピン ' + pin.rect.width + '×' + pin.rect.height
                + ' / 1×1 ' + small.rect.width + '×' + small.rect.height
                + '（縦 ' + ratio.toFixed(2) + '倍）'
        };
    }
    function pinCellOf(snap) {
        var pin = null;
        if (snap) snap.cells.forEach(function (q) { if (q.pinned && !pin) pin = q; });
        return pin;
    }
    function smallCellsOf(snap) {
        return snap ? snap.cells.filter(function (q) { return !q.pinned; }) : [];
    }

    function noteLayout(snap, tag) {
        var p = tag ? ('（' + tag + '）') : '';
        if (!snap) { note('レイアウトの実測' + p, '(測れず)'); return; }
        note('gridTemplateColumns の実測' + p, snap.geom.colText);
        note('gridTemplateRows の実測' + p, snap.geom.rowText);
        note('列数 / 行数 / セル総数 / 占有 / 空き' + p,
            snap.colCount + ' / ' + snap.rowCount + ' / ' + snap.total
            + ' / ' + snap.occupied + ' / ' + snap.holes);
        note('logicalCount の実測（枠数 + ピンがあれば3）' + p,
            snap.n + ' + ' + (pinCellOf(snap) ? 3 : 0) + ' = ' + (snap.n + (pinCellOf(snap) ? 3 : 0)));
        note('各カードの矩形とセル座標' + p, snap.cells.map(function (q) {
            return (q.pinned ? '📌' : '') + q.id
                + ' [r' + q.r + 'c' + q.c + ' ' + q.rs + '×' + q.cs + '] '
                + q.rect.left + ',' + q.rect.top + ' ' + q.rect.width + '×' + q.rect.height;
        }).join(' / '));
        note('🔴 画面からのはみ出し量' + p
            + '（全カードの bottom − innerHeight の最大 / innerHeight = ' + snap.viewportH + '）',
            snap.viewportOutside + 'px');
        note('カードごとの画面外はみ出し' + p, snap.viewportList);
        note('占有セル' + p, snap.usedKeys.join(','));
    }

    /* --- 保存URLの退避と復元（D-Y4 / D-Y5 / D-Y6 が枠数を触るため） ---------- */
    function urlKeys() {
        var out = [];
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && k.indexOf('sync_url_') === 0) out.push(k);
            }
        } catch (e) { }
        return out.sort();
    }
    function urlSnapshot() {
        var o = {};
        urlKeys().forEach(function (k) {
            try { o[k] = localStorage.getItem(k); } catch (e) { o[k] = null; }
        });
        return o;
    }
    function urlSnapText(o) {
        return Object.keys(o).sort().map(function (k) {
            return k + '=' + (o[k] === null || o[k] === undefined ? '' : o[k]);
        }).join(' | ');
    }
    function indexUrlText() {
        var L = [];
        for (var i = 1; i <= 20; i++) {
            var v = null;
            try { v = localStorage.getItem('sync_url_' + i); } catch (e) { }
            if (v) L.push(i + ':' + v);
        }
        return L.join(' | ');
    }
    function indexUrlCount() {
        var n = 0;
        for (var i = 1; i <= 20; i++) {
            try { if (localStorage.getItem('sync_url_' + i)) n++; } catch (e) { }
        }
        return n;
    }
    /* 🔴 退避したスナップショットへ完全に戻す（余計なキーは消す）。 */
    function restoreUrlSnapshot(snap) {
        try {
            urlKeys().forEach(function (k) { localStorage.removeItem(k); });
            Object.keys(snap).forEach(function (k) {
                if (snap[k] !== null && snap[k] !== undefined) localStorage.setItem(k, snap[k]);
            });
        } catch (e) { }
        return urlSnapText(urlSnapshot());
    }
    function orderText() {
        return gridCards().map(function (c) {
            return c.id + ':' + (c.style.order || '(なし)');
        }).sort().join(' | ');
    }

    /* 枠を n 枠にして末尾の枠へピンを付け、矩形が落ち着いてから測る。
       🔴 各項目は前の項目が残した状態に依存しない（鉄則 #1）。毎回ここから作る。
       ⚠️ ピンを付ける前の「穴」は枠数によって出る（3枠なら1つ）。
          これは既存の設計であり不具合ではないので、PC の条件には入れず note に残す
          （入れると 3枠 の項目が「測れていない」になってしまう）。 */
    async function setupPinned(n, tag) {
        var p = tag ? (tag + ' ') : '';
        await closeAllMenus();
        await stopAllIfPlaying();
        await clearPins();
        var got = await setCardCount(n);
        pc(p + '枠を' + n + 'つにできた', function () {
            return got === n ? (got + '枠') : false;
        });

        var g0 = gridGeom();
        pc(p + 'グリッドの幾何を読めている（列×行のトラック）', function () {
            return (g0 && g0.cols.length && g0.rows.length)
                ? (g0.cols.length + '列 × ' + g0.rows.length + '行') : false;
        });

        var pre = await settledSnapshot(lastCard());
        pc(p + '🔴 ピンを付ける前の矩形が収束した', function () {
            return pre.settled ? (pre.ms + 'ms') : false;
        });
        pc(p + '🔴 矩形が 0 でない', function () {
            var s = pre.snap;
            return (s && s.cells.length && s.cells[0].rect.width > 0 && s.cells[0].rect.height > 0)
                ? (s.cells[0].rect.width + '×' + s.cells[0].rect.height) : false;
        });
        pc(p + '🔴 ピンを付ける前の状態が正常（はみ出し0 / 未解決0 / 重なり0）', function () {
            var s = pre.snap;
            if (!s) return false;
            var t = 'はみ出し' + s.outside + 'px / 未解決' + s.unresolved + ' / 重なり' + s.overlap;
            return (s.outside === 0 && s.unresolved === 0 && s.overlap === 0) ? t : false;
        });
        note(p + '（参考）ピンを付ける前の空きセル数 ─ 枠数によって出るのは既存の設計',
            pre.snap ? pre.snap.holes : '(測れず)');

        var cid = lastCard();
        var pin = await pinCardId(cid);
        pc(p + '🔴 末尾の枠にピンを付けられた（is-main がちょうど1枚）', function () {
            return (pin.ok && pinnedCards().length === 1) ? cid : false;
        });
        note(p + '⤢ を押したときの当たり判定（押し下げ式ヘッダーなので被覆ありが正常）',
            (pin.click.blocked ? '被覆あり / ' : '被覆なし / ') + (pin.click.hit || '(記録なし)'));

        var post = await settledSnapshot(cid);
        pc(p + 'ピンを付けた後の矩形が収束した', function () {
            return post.settled ? (post.ms + 'ms') : false;
        });
        var big = biggerCheck(post.snap);
        pc(p + '🔴 ピン枠が実際に大きくなった（縦が 1×1 の '
            + PIN_BIG_RATIO + '倍以上 ─ クラスが付いただけの状態を弾く）', function () {
            return big ? big.text : false;
        });
        return { cid: cid, pre: pre.snap, snap: post.snap, big: big };
    }

    /* 「グリッド列数」を退避して自動へ倒す道具。
       🔴 判定は自動列数を前提にしているので、利用者の設定が手動のままだと成立しない。
          各項目の冒頭で自動へ倒し、終わったら必ず元へ戻す。 */
    function layoutColsEl() { return document.getElementById('layoutCols'); }
    async function forceAutoCols() {
        var sel = layoutColsEl();
        var was = sel ? sel.value : null;
        if (sel) await setLayoutCols('auto');
        pc('「グリッド列数」を自動にできた（判定は自動列数を前提にする / 元の設定 = '
            + (was === null ? '(欄が無い)' : was) + '）', function () {
            return (sel && sel.value === 'auto') ? 'auto' : false;
        });
        return was;
    }
    async function restoreCols(was) {
        var sel = layoutColsEl();
        if (sel && was !== null && was !== undefined) await setLayoutCols(was);
    }

    /* 🔴 ★v1.8.1: ビューポート基準の測定が「反応する」ことの positive control（鉄則 #22）。
       末尾の枠を一時的に下へずらし、viewportOutside がそれを検出し、戻すと元へ戻ることを見る。
       ⚠️ 「案A（.main-view の min-height:0）を外す」方式はここでは使わない。
          6枠3×3 のように修正前でもはみ出さない構成があり、そこでは反応しないため
          positive control が落ちて項目が丸ごと判定不能になる。案Aの検証は D-Y8 で行う。 */
    var VP_PROBE_MARGIN = 100;     /* 画面の下端をこれだけ超えるまでずらす */

    /* 🔴 ★v1.8.2: ずらす対象は「最も下にある枠」。ずらす量は固定値にしない。
       ⚠️ v1.8.1 は lastCard()（＝末尾の枠）を 300px 固定でずらしていたが、
          ピン留めのあと末尾の枠は左上(r1c1)へ移動しているため下端に届かず、
          D-Y1 / D-Y5【9枠】/ D-Y6 の3本が「反応しない」＝判定不能になった
          （2026-09-13 実測: ピン枠の bottom 644 + 300 = 944 < innerHeight 954。
            D-Y5【3枠】だけ通ったのはピン枠が 907px と高く偶然下端を越えたため）。
       🔴 「どの部品が画面のいちばん下にあるか」は構成で変わる。対象は毎回測って決める。 */
    function bottomMostCard() {
        var best = null, bestB = -Infinity;
        gridCards().forEach(function (c) {
            var r = rect(c);
            if (r && r.bottom > bestB) { bestB = r.bottom; best = c; }
        });
        return best;
    }
    async function pcViewportProbe(tag) {
        var p = tag ? (tag + ' ') : '';
        var el = bottomMostCard();
        var base = layoutSnapshot();
        if (!el || !base) {
            pc(p + '🔴 ビューポート基準の測定が反応する', function () { return false; });
            return;
        }
        var vpH = window.innerHeight || 0;
        var r0 = rect(el);
        var shift = Math.max(120, Math.round(vpH - r0.bottom + VP_PROBE_MARGIN));
        var was = el.style.transform;
        /* 🔴 ★v1.9.1: 固定の wait(400) をやめ、矩形が動かなくなるまで待つ。
           .player-card には transition: all 0.3s ease が効いており、400ms は遷移に対して
           ほとんど余裕が無い。2026-09-16 の実測で D-Y11 だけこの PC が false になり、
           同じ回の D-Y1 / D-Y5 / D-Y6 は成立していた（D-Y11 は矩形の収束に 2012ms
           かかっており、遅い瞬間に「戻し」の遷移が 400ms で終わらなかったと見られる）。 */
        el.style.transform = 'translateY(' + shift + 'px)';
        var w1 = await waitRectSettled(el, LAYOUT_SETTLE_MS);
        var probed = layoutSnapshot();
        el.style.transform = was || '';
        var w2 = await waitRectSettled(el, LAYOUT_SETTLE_MS);
        var back = layoutSnapshot();
        note(p + 'ビューポート基準の測定の自己診断（動かした枠 / 元の bottom / ずらした量）',
            el.id + ' / ' + r0.bottom + ' / ' + shift + 'px（innerHeight = ' + vpH + '）');
        /* 🔴 ★v1.9.1: 合否によらず3値と収束時間を残す。
           v1.9.0 までは失敗すると false だけが残り、「ずらしたのに増えなかった」のか
           「戻したのに元へ戻らなかった」のかが後から分からなかった。 */
        note(p + 'ビューポート基準の測定の実測値（基準 → ずらした → 戻した px / 収束）',
            (base ? base.viewportOutside : '?')
            + ' → ' + (probed ? probed.viewportOutside : '?')
            + ' → ' + (back ? back.viewportOutside : '?') + ' px'
            + ' / ずらし ' + w1.ms + 'ms(' + (w1.settled ? '収束' : '時間切れ') + ')'
            + ' / 戻し ' + w2.ms + 'ms(' + (w2.settled ? '収束' : '時間切れ') + ')');
        pc(p + '🔴 ビューポート基準の測定が反応する（最も下にある枠を ' + shift
            + 'px 下へずらすと検出でき、戻すと元へ戻る）', function () {
            if (!probed || !back) return false;
            var t = base.viewportOutside + ' → ' + probed.viewportOutside
                + ' → ' + back.viewportOutside + ' px';
            return (probed.viewportOutside > base.viewportOutside
                && back.viewportOutside === base.viewportOutside) ? t : false;
        });
    }

    /* --- D-Y1: 🔴 6枠＋ピンでグリッドからはみ出さない（本命） ---------------- */
    async function testY1() {
        log('  [目的] 6枠のうち末尾の枠をピン留めしても、枠がグリッドの外へはみ出さないこと。');
        log('  ⚠️ 先頭の枠をピンすると修正前でも崩れない。判定は必ず末尾の枠で行う。');
        var started = cardCount();
        var wasCols = await forceAutoCols();
        try {
            var st = await setupPinned(6, '');
            var s = st.snap;
            await pcViewportProbe('');

            /* 🔴 ★v1.8.1: 主判定はビューポート基準（鉄則 #41）。グリッド基準も残す。 */
            expect('🔴 画面（ビューポート）からのはみ出し量（全カードの最大 / px）',
                s ? s.viewportOutside : -1, 0);
            expect('グリッドからのはみ出し量（全カードの最大 / px）', s ? s.outside : -1, 0);
            expect('セル座標を解決できなかったカード（＝暗黙の行へ落ちた枠）', s ? s.unresolved : -1, 0);
            expect('セルの重なり', s ? s.overlap : -1, 0);
            expect('行トラック数（補助判定）', s ? s.rowCount : -1, 3);

            noteLayout(s, '6枠＋末尾ピン');
            note('カードの top 座標のユニーク数'
                + '（⚠️ この枠数では崩れても3のままなので判定には使えない。だから観測に留める）',
                s ? s.topsCount : '(測れず)');

            /* ⭐ 先頭の枠をピンした場合を記録に残す。判定は増やさない。
               修正前は「末尾に近い枠をピンしたときだけ」崩れるので、
               先頭で測っていたら検出できなかったことが後から分かるようにする。 */
            await clearPins();
            var f = firstCard();
            var pf = await pinCardId(f);
            var sf = (await settledSnapshot(f)).snap;
            note('⭐ 先頭の枠をピンしたとき（はみ出しpx / 穴 / 未解決）',
                (pf.ok && sf) ? (sf.outside + ' / ' + sf.holes + ' / ' + sf.unresolved) : '(測れず)');
        } finally {
            try { await clearPins(); } catch (e) { }
            await restoreCols(wasCols);
            try { await setCardCount(started); } catch (e) { }
        }
    }

    /* --- D-Y2: ピン枠が左上に置かれ 2×2 を占める ---------------------------- */
    async function testY2() {
        log('  [目的] ピン枠が必ずグリッドの左上に置かれ、2列×2行を占めること。');
        var started = cardCount();
        var wasCols = await forceAutoCols();
        var st = await setupPinned(6, '');
        var s = st.snap;
        var p = pinCellOf(s);
        pc('ピン枠のセル座標を読めている', function () { return p ? ('r' + p.r + 'c' + p.c) : false; });

        expect('ピン枠の開始行', p ? p.r : -1, 1);
        expect('ピン枠の開始列', p ? p.c : -1, 1);
        expect('ピン枠の占有（行×列）', p ? (p.rs + '×' + p.cs) : '(測れず)', '2×2');

        var small = smallCellsOf(s)[0];
        var wOk = (p && small && s)
            ? (Math.abs(p.rect.width - (small.rect.width * 2 + s.geom.colGap)) <= PIN_SPAN_TOL) : false;
        var hOk = (p && small && s)
            ? (Math.abs(p.rect.height - (small.rect.height * 2 + s.geom.rowGap)) <= PIN_SPAN_TOL) : false;
        expect('ピン枠の幅が 1×1 の2倍＋gap（許容 ' + PIN_SPAN_TOL + 'px）',
            wOk ? 'ok' : (p && small ? (p.rect.width + ' vs ' + (small.rect.width * 2 + s.geom.colGap)) : '(測れず)'),
            'ok');
        expect('ピン枠の高さが 1×1 の2倍＋gap（許容 ' + PIN_SPAN_TOL + 'px）',
            hOk ? 'ok' : (p && small ? (p.rect.height + ' vs ' + (small.rect.height * 2 + s.geom.rowGap)) : '(測れず)'),
            'ok');

        noteLayout(s, '6枠＋末尾ピン');
        await clearPins();
        await restoreCols(wasCols);
        await setCardCount(started);
    }

    /* --- D-Y3: 🔴 穴が空いていない（他5枠がL字に張り付く） ------------------- */
    async function testY3() {
        log('  [目的] 6枠＋ピンで空きセルが無く、他5枠が右端の列3つ＋下段の2つに並ぶこと。');
        var started = cardCount();
        var wasCols = await forceAutoCols();
        var st = await setupPinned(6, '');
        var s = st.snap;

        var got = smallCellsOf(s).map(function (q) { return q.r + '-' + q.c; }).sort().join(',');
        var want = ['1-3', '2-3', '3-1', '3-2', '3-3'].sort().join(',');
        pc('1×1 のカードを5枚とも読めている', function () {
            var n = smallCellsOf(s).length;
            return n === 5 ? (n + '枚') : false;
        });

        expect('空きセル数', s ? s.holes : -1, 0);
        expect('セルの重なり', s ? s.overlap : -1, 0);
        expect('1×1 の5枚のセル集合（右端の列3つ＋下段の2つ）', got, want);

        noteLayout(s, '6枠＋末尾ピン');
        await clearPins();
        await restoreCols(wasCols);
        await setCardCount(started);
    }

    /* --- D-Y4: 🔴 order と保存URLが変わらない（退行検出の本命） -------------- */
    async function testY4() {
        await closeAllMenus();
        await stopAllIfPlaying();
        log('  [目的] ピン留め／解除で order と保存URL（sync_url_*）が1文字も動かないこと。');
        log('  ⚠️ この項目は保存URLを一時的に書き換える。終了時に必ず元へ戻す。');

        var started = cardCount();
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        pc('🔴 保存URLを退避できた', function () {
            return 'キー ' + Object.keys(backup).length + '件';
        });
        note('退避した保存URLのキー', Object.keys(backup).sort().join(', ') || '(なし)');

        try {
            await clearPins();
            var got = await setCardCount(7);
            pc('枠を7つにできた（末尾を削除して6枠に戻すため）', function () {
                return got === 7 ? '7枠' : false;
            });

            /* 🔴 sync_url_1..N（連番キー）は URL を読み込むだけでは書かれない。
               書くのは resaveUrlsBasedOnOrder()＝🗑 と ◀▶ の経路だけなので、
               3本を読み込んでから末尾の枠を 🗑 で消して連番キーを成立させる。
               こうしないと「変わっていない」が空欄どうしの比較で自明に成立する。 */
            var ids = [];
            try { ids = activeCardIds.slice(0, 3); } catch (e) { ids = []; }
            var vids = [VID.LIGHT, VID.MID, VID.SAMECH];
            var loaded = 0;
            for (var i = 0; i < ids.length; i++) {
                await clearCard(ids[i]);
                var ld = await loadUrlIntoCard(ids[i], ytUrl(vids[i]));
                if (ld.ok) loaded++;
            }
            pc('3本のURLを枠1〜3へ読み込めた（再生はしない）', function () {
                return loaded === 3 ? (loaded + '本') : (loaded + '本');
            });

            var del = await deleteCard(lastCard());
            pc('🗑 で末尾の枠を削除して6枠になった', function () {
                return (del.ok && cardCount() === 6) ? (cardCount() + '枠') : false;
            });
            pc('🔴 sync_url_1..N に値が3件以上入った（判定が空振りしないこと）', function () {
                var n = indexUrlCount();
                return n >= 3 ? (n + '件') : false;
            });

            var ord0 = orderText();
            var idx0 = indexUrlText();
            var all0 = urlSnapText(urlSnapshot());
            note('基準の order', ord0);
            note('基準の sync_url_1..N の件数', indexUrlCount());

            var cid = lastCard();
            var pin = await pinCardId(cid);
            var s1 = (await settledSnapshot(cid)).snap;
            var big = biggerCheck(s1);
            pc('🔴 ピンが実際に付いて大きくなった（縦が 1×1 の '
                + PIN_BIG_RATIO + '倍以上）', function () {
                return (pin.ok && big) ? big.text : false;
            });

            expect('ピン留めの前後で order が完全一致', orderText(), ord0);
            expect('ピン留めの前後で sync_url_1..N が完全一致', indexUrlText(), idx0);
            expect('ピン留めの前後で sync_url_* の全キーが完全一致', urlSnapText(urlSnapshot()), all0);

            await clearPins();
            await wait(400);
            pc('ピンを解除できた（is-main が0枚）', function () {
                return pinnedCards().length === 0 ? '0枚' : false;
            });
            var el = document.getElementById(cid);
            expect('ピン解除の後も order が完全一致', orderText(), ord0);
            expect('解除後の gridColumn が span 1 に戻っている',
                el ? String(el.style.gridColumn) : '(枠が無い)', 'span 1');
            expect('解除後の gridRow が span 1 に戻っている',
                el ? String(el.style.gridRow) : '(枠が無い)', 'span 1');

        } finally {
            /* 🔴 枠数を先に戻す。➖ は compactSavedUrls() を呼んで連番キーを書き換えるので、
                  保存URLの復元は必ず「枠数を戻したあと」に行う。 */
            try { await clearPins(); } catch (e) { }
            try { await setCardCount(started); } catch (e) { }
            var restored = restoreUrlSnapshot(backup);
            expect('🔴 後始末: 保存URL（sync_url_*）を元どおり復元できた', restored, backupText);
            note('復元後のキー数', Object.keys(urlSnapshot()).length);
            log('  ⚠️ 枠に読み込んだ動画は画面には残るが、保存URLは元に戻した。'
                + 'ページを再読み込みすると元の構成に戻る。');
        }
    }

    /* --- D-Y5: 他の枠数（3枠 / 9枠）でも崩れない ---------------------------- */
    async function testY5() {
        log('  [目的] 3枠（3列2行）と9枠（4列3行）でも、ピン留めで崩れないこと。');
        var started = cardCount();
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        var wasCols = await forceAutoCols();
        try {
            var st3 = await setupPinned(3, '【3枠】');
            var s3 = st3.snap;
            await pcViewportProbe('【3枠】');
            expect('【3枠】🔴 画面からのはみ出し量（px）', s3 ? s3.viewportOutside : -1, 0);
            expect('【3枠】グリッドからのはみ出し量（px）', s3 ? s3.outside : -1, 0);
            expect('【3枠】セル座標を解決できなかったカード', s3 ? s3.unresolved : -1, 0);
            expect('【3枠】セルの重なり', s3 ? s3.overlap : -1, 0);
            note('【3枠】列数 × 行数（参考: 3×2 の想定）',
                s3 ? (s3.colCount + ' × ' + s3.rowCount) : '(測れず)');
            noteLayout(s3, '3枠＋末尾ピン');

            var st9 = await setupPinned(9, '【9枠】');
            var s9 = st9.snap;
            await pcViewportProbe('【9枠】');
            /* ⚠️ v2.8.5 ではこの構成（自動4列＋ピン）で画面外へ 148px 出ていたが、
                  グリッド基準では 0 だったため合格していた（2026-09-08 実測）。 */
            expect('【9枠】🔴 画面からのはみ出し量（px）', s9 ? s9.viewportOutside : -1, 0);
            expect('【9枠】グリッドからのはみ出し量（px）', s9 ? s9.outside : -1, 0);
            expect('【9枠】セル座標を解決できなかったカード', s9 ? s9.unresolved : -1, 0);
            expect('【9枠】セルの重なり', s9 ? s9.overlap : -1, 0);
            note('【9枠】列数 × 行数（参考: 4×3 の想定）',
                s9 ? (s9.colCount + ' × ' + s9.rowCount) : '(測れず)');
            noteLayout(s9, '9枠＋末尾ピン');
        } finally {
            try { await clearPins(); } catch (e) { }
            await restoreCols(wasCols);
            try { await setCardCount(started); } catch (e) { }
            var restored = restoreUrlSnapshot(backup);
            note('後始末: 保存URLの復元（枠数を変えたため）',
                restored === backupText ? '元どおり' : '⚠ 差分あり');
        }
    }

    /* --- D-Y6: 手動でグリッド列数を変えても崩れない ------------------------- */
    async function testY6() {
        log('  [目的] 「グリッド列数」を手動で 2 にしても、ピン留めで崩れないこと。');
        var started = cardCount();
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        var sel = layoutColsEl();
        var wasCols = sel ? sel.value : null;
        pc('「グリッド列数」の選択欄を読めている', function () {
            return sel ? ('現在 = ' + wasCols) : false;
        });

        try {
            await setLayoutCols('auto');
            var st = await setupPinned(6, '');
            var before = st.snap;
            note('列数を変える前の 列数 × 行数', before ? (before.colCount + ' × ' + before.rowCount) : '(測れず)');

            await setLayoutCols('2');
            var after = (await settledSnapshot(st.cid)).snap;

            /* 🔴 positive control: 設定が実際に効いたこと。
               これが無いと「効いていないまま崩れていない」を合格と読んでしまう。
               あわせて、トラック数を読む手段が変化に反応することの担保にもなる。 */
            pc('🔴 列数の変更が実際に効いた（行トラック数 3 → 5 / 列トラック数 → 2）', function () {
                if (!before || !after) return false;
                var t = before.rowCount + '→' + after.rowCount + ' 行 / '
                    + before.colCount + '→' + after.colCount + ' 列';
                return (before.rowCount === 3 && after.rowCount === 5 && after.colCount === 2) ? t : false;
            });
            var big2 = biggerCheck(after);
            pc('🔴 列数を変えた後もピン枠が大きいまま', function () { return big2 ? big2.text : false; });
            await pcViewportProbe('');

            /* ⚠️ v2.8.5 ではこの構成で画面外へ 435px 出ていたが、
                  グリッド基準では 0 だったため合格していた（2026-09-08 実測）。 */
            expect('🔴 画面からのはみ出し量（px）', after ? after.viewportOutside : -1, 0);
            expect('グリッドからのはみ出し量（px）', after ? after.outside : -1, 0);
            expect('セル座標を解決できなかったカード', after ? after.unresolved : -1, 0);
            expect('セルの重なり', after ? after.overlap : -1, 0);
            expect('行トラック数（補助判定 / 6枠＋ピンで2列なら5行）', after ? after.rowCount : -1, 5);

            noteLayout(after, '6枠＋末尾ピン / 手動2列');

        } finally {
            /* ⚠️ 測定後に必ず元の設定へ戻す。 */
            if (sel && wasCols !== null) await setLayoutCols(wasCols);
            expect('🔴 後始末: グリッド列数の設定を元へ戻せた',
                sel ? String(sel.value) : '(欄が無い)', String(wasCols));
            try { await clearPins(); } catch (e) { }
            try { await setCardCount(started); } catch (e) { }
            var restored = restoreUrlSnapshot(backup);
            note('後始末: 保存URLの復元（枠数を変えたため）',
                restored === backupText ? '元どおり' : '⚠ 差分あり');
        }
    }


    /* ========================================================================
       ★v1.8.1: D-Y7 / D-Y8 / D-Y9 ─ v2.8.6 の検証

       D-Y7  薄い枠で URL 入力欄を実際に押せる（修正②）
       D-Y8  一括コントローラーの表示／非表示の両方で画面からはみ出さない（修正①）
       D-Y9  案Aの下で動画領域とチャット欄が潰れない（スパイク 7-A の未回収 #2・#3）
       ====================================================================== */

    var THIN_N = 9;              /* 手動1列 × 9枠 ＝ 枠高が最小になる構成 */

    /* 🔴 CSS の :hover は合成イベントでは作れない（/get-debug-suite 8節）。
       .player-card:hover .player-header と同じ宣言をクラスで再現して「ホバー相当」を作る。
       ⚠️ 実際のマウスホバーそのものは目視項目で担保する（この方法では作れない）。 */
    function ensureHoverStyle() {
        if (document.getElementById('dbgHoverStyle')) return;
        var s = document.createElement('style');
        s.id = 'dbgHoverStyle';
        s.textContent = '.dbg-force-hover .player-header{height:var(--header-height);'
            + 'border-bottom:1px solid var(--border-color);}';
        document.head.appendChild(s);
    }
    function forceHeaderOpen(cid, on) {
        ensureHoverStyle();
        var el = document.getElementById(cid);
        if (!el) return false;
        if (on) el.classList.add('dbg-force-hover');
        else el.classList.remove('dbg-force-hover');
        return true;
    }
    function headerHeightOf(cid) {
        var h = document.querySelector('#' + cid + ' .player-header');
        return h ? rect(h).height : -1;
    }
    /* 空枠の中身。⚠️ .placeholder-box クラスではない（インラインスタイルの div）。
       input → (中央寄せの行) → (flex の中央寄せ領域) → (overflow-y:auto の外箱) */
    function phEls(cid) {
        var input = document.getElementById('urlInput_' + cid);
        var row = input ? input.parentElement : null;
        var mid = row ? row.parentElement : null;
        var box = mid ? mid.parentElement : null;
        return (input && mid && box) ? { input: input, mid: mid, box: box } : null;
    }
    /* 可視領域（外箱）から上下へ出ている量。0 なら完全に見えている。 */
    function clipYOf(inner, outer) {
        if (!inner || !outer) return -1;
        return Math.round(Math.max(0, outer.top - inner.top) + Math.max(0, inner.bottom - outer.bottom));
    }
    /* v2.8.5 の指定（padding:20px / flex:1 1 auto; min-height:0）をその場で再現する。 */
    function applyPreFix(ph) {
        ph.box.style.padding = '20px';
        ph.mid.style.flex = '1 1 auto';
        ph.mid.style.minHeight = '0';
    }
    function restorePh(ph, orig) {
        ph.box.style.padding = orig.pad;
        ph.mid.style.flex = orig.flex;
        ph.mid.style.minHeight = orig.mh;
        ph.box.scrollTop = 0;
    }

    /* --- D-Y7: 🔴 薄い枠で URL 入力欄を押せる ------------------------------- */
    async function testY7() {
        log('  [目的] 枠が薄いとき、ヘッダーが開いた状態でも URL 入力欄を実際に押せること。');
        log('  ⚠️ 動画が入っている枠では症状が出ない。必ず「URL入力待ち」の枠で測る。');
        log('  ⚠️ ホバーは CSS の :hover なので合成イベントでは作れない。同じ宣言のクラスで再現する。');
        var started = cardCount();
        var sel = layoutColsEl();
        var wasCols = sel ? sel.value : null;
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        var cid = null;
        try {
            await closeAllMenus();
            await stopAllIfPlaying();
            await clearPins();

            var okCols = await setLayoutCols('1');
            pc('「グリッド列数」を手動1列にできた（枠高が最小になる構成 / 元の設定 = '
                + (wasCols === null ? '(欄が無い)' : wasCols) + '）', function () {
                return okCols ? '1列' : false;
            });
            var got = await setCardCount(THIN_N);
            pc('枠を' + THIN_N + 'つにできた', function () {
                return got === THIN_N ? (got + '枠') : false;
            });

            cid = lastCard();
            var cleared = await clearCard(cid);
            pc('🔴 対象の枠が「URL入力待ち」になっている（動画が入っていると症状が消える）',
                function () { return cleared ? '入力欄と読み込むボタンあり' : false; });

            var card = document.getElementById(cid);
            var w0 = await waitRectSettled(card, LAYOUT_SETTLE_MS);
            pc('🔴 枠の矩形が収束した', function () { return w0.settled ? (w0.ms + 'ms') : false; });
            pc('🔴 矩形が 0 でない', function () {
                var r = rect(card);
                return (r && r.width > 0 && r.height > 0) ? (r.width + '×' + r.height) : false;
            });

            var ph = phEls(cid);
            pc('空枠の中身（外箱と中央寄せ領域）を読めている', function () {
                return ph ? describe(ph.box) + ' / ' + describe(ph.mid) : false;
            });
            if (!ph) return;
            var orig = { pad: ph.box.style.padding, flex: ph.mid.style.flex, mh: ph.mid.style.minHeight };

            var hist = 0;
            try { hist = (JSON.parse(localStorage.getItem('sync_video_history')) || []).length; } catch (ex) { }
            note('枠の高さ（この構成で最も薄い枠）', rect(card).height + 'px');
            note('動画の履歴件数（履歴帯は flex:0 0 auto で縮まないため症状に効く）', hist);
            note('ホバー前の入力欄の矩形', JSON.stringify(rect(ph.input)));

            /* --- ホバー相当を作る --- */
            forceHeaderOpen(cid, true);
            var w1 = await waitRectSettled(ph.input, LAYOUT_SETTLE_MS);
            pc('🔴 ヘッダーを開いた状態を作れた（高さ > 0）', function () {
                var h = headerHeightOf(cid);
                return h > 0 ? (h + 'px') : false;
            });
            pc('ホバー相当にした後の矩形が収束した', function () {
                return w1.settled ? (w1.ms + 'ms') : false;
            });
            note('ホバー相当のときの 枠高 / ヘッダー高 / 可視領域高',
                rect(card).height + ' / ' + headerHeightOf(cid) + ' / ' + rect(ph.box).height);
            note('ホバー相当のときの入力欄の矩形', JSON.stringify(rect(ph.input)));

            /* --- 🔴 原因の確定: v2.8.5 の指定を再現すると押せなくなること --- */
            applyPreFix(ph);
            await wait(400);
            var clipPre = clipYOf(rect(ph.input), rect(ph.box));
            var rPre = await clickReal(ph.input);
            note('v2.8.5 の指定を再現したときの 入力欄のはみ出し / 当たり判定',
                clipPre + 'px / ' + (rPre.blocked ? ('blocked:' + rPre.reason + ' / ' + rPre.hit) : 'ok'));
            pc('🔴 v2.8.5 の指定（padding:20px / flex:1 1 auto）を再現すると入力欄が使えなくなる'
                + '（＝症状の原因の確定。再現できなければ原因は別にある）', function () {
                return (clipPre > 0 || rPre.blocked)
                    ? ('はみ出し' + clipPre + 'px / '
                        + (rPre.blocked ? rPre.reason : '当たり判定は通る')) : false;
            });
            restorePh(ph, orig);
            await wait(400);

            /* --- 本命の判定（v2.8.6 の状態） --- */
            var csMid = null;
            try { csMid = window.getComputedStyle(ph.mid); } catch (ex) { }
            expect('🔴 本体の空枠が v2.8.6 の指定になっている（中央寄せ領域の flex-shrink）',
                csMid ? csMid.flexShrink : '(読めず)', '0');

            var clipFix = clipYOf(rect(ph.input), rect(ph.box));
            expect('🔴 ホバー相当の状態で 入力欄が枠の可視領域からはみ出していない（px）', clipFix, 0);

            var rFix = await clickReal(ph.input);
            expect('🔴 ホバー相当の状態で 入力欄を実際に押せた（被覆なし）',
                rFix.blocked ? ('blocked:' + rFix.reason) : 'ok', 'ok');

            var typed = false, wasVal = ph.input.value;
            try {
                ph.input.focus();
                ph.input.value = 'dbg';
                ph.input.dispatchEvent(new Event('input', { bubbles: true }));
                typed = (document.activeElement === ph.input && ph.input.value === 'dbg');
            } catch (ex) { }
            ph.input.value = wasVal;
            try { ph.input.blur(); } catch (ex) { }
            expect('🔴 ホバー相当の状態で 入力欄が文字を受け付けた（フォーカス＋値）', typed, true);
            note('判定時の 入力欄の矩形 / 可視領域の矩形',
                JSON.stringify(rect(ph.input)) + ' / ' + JSON.stringify(rect(ph.box)));

            /* --- 枠高ごとの閾値（観測のみ / 合否は付けない） --- */
            forceHeaderOpen(cid, false);
            var sweep = [], ns = [3, 6, 9], i;
            for (i = 0; i < ns.length; i++) {
                await setCardCount(ns[i]);
                var c2 = lastCard();
                await clearCard(c2);
                var p2 = phEls(c2);
                if (!p2) { sweep.push(ns[i] + '枠:(測れず)'); continue; }
                var o2 = { pad: p2.box.style.padding, flex: p2.mid.style.flex, mh: p2.mid.style.minHeight };
                forceHeaderOpen(c2, true);
                await waitRectSettled(p2.input, LAYOUT_SETTLE_MS);
                var hFix = clipYOf(rect(p2.input), rect(p2.box));
                applyPreFix(p2);
                await wait(300);
                var hPre = clipYOf(rect(p2.input), rect(p2.box));
                restorePh(p2, o2);
                forceHeaderOpen(c2, false);
                sweep.push(ns[i] + '枠(枠高' + rect(document.getElementById(c2)).height + 'px): '
                    + 'v2.8.5相当=' + hPre + 'px / v2.8.6=' + hFix + 'px');
                await wait(200);
            }
            note('⭐ 枠高ごとの入力欄のはみ出し（手動1列 / ホバー相当 / 0 なら完全に見えている）',
                sweep.join(' ｜ '));
        } finally {
            if (cid) forceHeaderOpen(cid, false);
            if (sel && wasCols !== null) await setLayoutCols(wasCols);
            try { await setCardCount(started); } catch (ex) { }
            var restored = restoreUrlSnapshot(backup);
            note('後始末: 保存URLの復元（枠数を変えたため）',
                restored === backupText ? '元どおり' : '⚠ 差分あり');
        }
    }

    /* --- D-Y8: 一括コントローラーの表示／非表示の両方で画面からはみ出さない --- */
    async function testY8() {
        log('  [目的] 一括コントローラー（.main-view.controller-active / padding-bottom:55px）が');
        log('         出ている状態でも隠れている状態でも、枠が画面の外へ出ないこと。');
        log('  ⚠️ 構成は「6枠＋末尾ピン＋手動2列」＝ v2.8.5 で画面外へ 435px 出ていた構成。');
        var started = cardCount();
        var sel = layoutColsEl();
        var wasCols = sel ? sel.value : null;
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        var mv = document.getElementById('mainView');
        var wasLocked = null, unlocked = false;
        try {
            try {
                wasLocked = (typeof isControllerLocked !== 'undefined') ? !!isControllerLocked : null;
            } catch (ex) { }
            note('測定開始時の一括コントローラーの固定（🔒）',
                wasLocked === null ? '(読めず)' : (wasLocked ? '固定されている' : '固定されていない'));
            if (wasLocked === true) {
                try { toggleControllerLock(); unlocked = true; } catch (ex) { }
            }

            pc('.main-view を取得できている', function () { return mv ? describe(mv) : false; });
            pc('showController / hideController を呼べる', function () {
                var a = false, b = false;
                try { a = (typeof showController === 'function'); } catch (ex) { }
                try { b = (typeof hideController === 'function'); } catch (ex) { }
                return (a && b) ? 'どちらもあり' : false;
            });

            await setLayoutCols('2');
            var st = await setupPinned(6, '');
            pc('🔴 手動2列になっている', function () {
                return (sel && sel.value === '2') ? '2列' : false;
            });

            /* 🔴 案A（.main-view の min-height:0）を一時的に外すと画面外へ出ること。
               測定手段が反応することと、案Aが効いていることを同時に担保する（鉄則 #22）。 */
            var withFix = (await settledSnapshot(st.cid)).snap;
            if (mv) mv.style.minHeight = 'auto';
            await wait(700);
            var noFix = layoutSnapshot();
            if (mv) mv.style.minHeight = '';
            await wait(700);
            var backFix = (await settledSnapshot(st.cid)).snap;
            pc('🔴 案A（.main-view の min-height:0）を外すと画面外へはみ出し、戻すと収まる'
                + '（案Aが効いていることの確認）', function () {
                if (!withFix || !noFix || !backFix) return false;
                var t = withFix.viewportOutside + ' → ' + noFix.viewportOutside
                    + ' → ' + backFix.viewportOutside + ' px';
                return (noFix.viewportOutside > 0 && backFix.viewportOutside === 0) ? t : false;
            });
            note('案Aを外したときの行トラック', noFix ? noFix.geom.rowText : '(測れず)');

            /* --- 出した状態 --- */
            try { showController(); } catch (ex) { }
            await wait(700);
            var shown = !!(mv && mv.classList.contains('controller-active'));
            pc('🔴 一括コントローラーが出ている（.main-view に controller-active が付いた）',
                function () { return shown ? 'controller-active あり' : false; });
            var sOn = (await settledSnapshot(st.cid)).snap;
            expect('🔴 コントローラーを出した状態での 画面からのはみ出し量（px）',
                sOn ? sOn.viewportOutside : -1, 0);
            expect('（同）グリッドからのはみ出し量（px）', sOn ? sOn.outside : -1, 0);
            noteLayout(sOn, '6枠＋末尾ピン / 手動2列 / コントローラー表示');

            /* --- 隠した状態 --- */
            try { hideController(); } catch (ex) { }
            await wait(700);
            var hidden = !(mv && mv.classList.contains('controller-active'));
            pc('🔴 一括コントローラーが隠れている（controller-active が外れた）',
                function () { return hidden ? 'controller-active なし' : false; });
            var sOff = (await settledSnapshot(st.cid)).snap;
            expect('🔴 コントローラーを隠した状態での 画面からのはみ出し量（px）',
                sOff ? sOff.viewportOutside : -1, 0);
            note('コントローラーの表示／非表示での 1枚目の枠の高さ',
                (sOn && sOff && sOn.cells.length && sOff.cells.length)
                    ? (sOn.cells[0].rect.height + 'px → ' + sOff.cells[0].rect.height + 'px') : '(測れず)');
        } finally {
            try { if (unlocked) toggleControllerLock(); } catch (ex) { }
            if (mv) mv.style.minHeight = '';
            try { await clearPins(); } catch (ex) { }
            if (sel && wasCols !== null) await setLayoutCols(wasCols);
            try { await setCardCount(started); } catch (ex) { }
            var restored = restoreUrlSnapshot(backup);
            note('後始末: 保存URLの復元（枠数を変えたため）',
                restored === backupText ? '元どおり' : '⚠ 差分あり');
        }
    }

    async function setChatPosition(v) {
        var sel = document.getElementById('chatPosition');
        if (!sel) return false;
        sel.value = String(v);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(500);
        return sel.value === String(v);
    }

    /* --- D-Y9: 案Aの下で動画領域とチャット欄が潰れない --------------------- */
    async function testY9() {
        log('  [目的] .main-view { min-height: 0 } を入れた状態で、動画領域とチャット欄が潰れないこと。');
        log('  ⚠️ チャットの取得は行わない。欄は「動画が入っていない枠」で開く（取得が始まらない経路）。');
        var started = cardCount();
        var sel = layoutColsEl();
        var wasCols = sel ? sel.value : null;
        var posEl = document.getElementById('chatPosition');
        var wasPos = posEl ? posEl.value : null;
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        var cidV = null, cidC = null;
        try {
            await closeAllMenus();
            await stopAllIfPlaying();
            await clearPins();
            await setLayoutCols('auto');
            var got = await setCardCount(6);
            pc('枠を6つにできた（自動列数）', function () {
                return got === 6 ? (got + '枠') : false;
            });
            pc('「チャット配置方向」の選択欄を読めている（元の設定 = '
                + (wasPos === null ? '(欄が無い)' : wasPos) + '）', function () {
                return posEl ? ('現在 = ' + posEl.value) : false;
            });

            cidV = firstCard();
            cidC = lastCard();
            await clearCard(cidV);
            var ld = await loadUrlIntoCard(cidV, 'https://www.youtube.com/watch?v=' + VID.LIGHT);
            await wait(1500);
            pc('🔴 動画を読み込めた（' + VID.LIGHT + ' / iframe が入った）', function () {
                var f = document.querySelector('#' + cidV + ' .player-container iframe');
                return (ld.ok && f) ? 'iframe あり' : false;
            });

            var cont = document.querySelector('#' + cidV + ' .player-container');
            var cardV = document.getElementById(cidV);
            var wv = await waitRectSettled(cont, LAYOUT_SETTLE_MS);
            pc('動画領域の矩形が収束した', function () { return wv.settled ? (wv.ms + 'ms') : false; });
            var rc = rect(cont), rk = rect(cardV);
            var ratio = (rk && rk.height > 0) ? (rc.height / rk.height) : 0;
            var ratioPred = function (v) { return Number(v) >= 0.5; };
            ratioPred.label = '0.50 以上';
            expect('🔴 動画領域の高さが枠の高さに対して潰れていない（割合）',
                ratio.toFixed(2), ratioPred);
            note('動画領域 / 枠 の矩形', JSON.stringify(rc) + ' / ' + JSON.stringify(rk));

            /* --- チャット欄（右配置） --- */
            await setChatPosition('right');
            var op = await openChatPane(cidC);
            pc('🔴 チャット欄を開けた（動画が入っていない枠なので取得は始まらない）', function () {
                return op.ok ? '開いた' : false;
            });
            var chat = document.getElementById('chatContainer_' + cidC);
            var wc = await waitRectSettled(chat, LAYOUT_SETTLE_MS);
            pc('チャット欄の矩形が収束した', function () { return wc.settled ? (wc.ms + 'ms') : false; });
            var rr = rect(chat);
            var wPred = function (v) { return Number(v) >= 40; };
            wPred.label = '40px 以上';
            var hPred = function (v) { return Number(v) >= 30; };
            hPred.label = '30px 以上';
            expect('🔴 チャット欄（右配置）の幅（px）', rr ? rr.width : -1, wPred);
            expect('🔴 チャット欄（右配置）の高さ（px）', rr ? rr.height : -1, hPred);
            note('チャット欄（右配置）の矩形', JSON.stringify(rr));

            /* --- チャット欄（下配置） --- */
            await setChatPosition('bottom');
            await wait(600);
            var wb = await waitRectSettled(chat, LAYOUT_SETTLE_MS);
            pc('下配置にしたあとの矩形が収束した', function () { return wb.settled ? (wb.ms + 'ms') : false; });
            var rb = rect(chat);
            expect('🔴 チャット欄（下配置）の高さ（px）', rb ? rb.height : -1, hPred);
            note('チャット欄（下配置）の矩形', JSON.stringify(rb));

            var s = layoutSnapshot();
            expect('🔴 この構成（動画あり＋チャット欄あり）での 画面からのはみ出し量（px）',
                s ? s.viewportOutside : -1, 0);
            noteLayout(s, '6枠 / 動画1本＋チャット欄（下配置）');
        } finally {
            /* チャット欄を閉じる（開けたままにしない）。 */
            try {
                var btn = cidC ? document.getElementById('chatToggleBtn_' + cidC) : null;
                var vis = false;
                try { vis = !!(typeof chatVisible !== 'undefined' && chatVisible[cidC]); } catch (ex2) { }
                if (btn && vis) { await clickReal(btn); await wait(400); }
            } catch (ex) { }
            if (posEl && wasPos !== null) await setChatPosition(wasPos);
            try { if (cidV) await clearCard(cidV); } catch (ex) { }
            if (sel && wasCols !== null) await setLayoutCols(wasCols);
            try { await setCardCount(started); } catch (ex) { }
            var restored = restoreUrlSnapshot(backup);
            note('後始末: 保存URLの復元（動画を読み込んだため）',
                restored === backupText ? '元どおり' : '⚠ 差分あり');
            note('⚠️ この項目は動画を1本読み込むので「最近使った動画」の履歴が1件増える',
                VID.LIGHT);
        }
    }

    /* ======================================================================
       ★v1.9.0: D-Y10 / D-Y11 / D-Y12 ─ v2.8.7（ピン枠の位置を4隅から選ぶ）

       🔴 D-Y10 が退行検出の本命。ピン中の ◀▶ が moveCard() の本体へ入ると
          resaveUrlsBasedOnOrder() が走り、保存URLの並びが入れ替わる。
       🔴 鉄則 #42: 期待座標は固定値で書かず、構成（列数・行数）から毎回計算する。
       ⚠️ 空きセルは枠数によって出るのが既存の設計なので、判定には入れない。
       ====================================================================== */

    /* --- D-Y10: 🔴 ピン中の ◀▶ で order と保存URLが動かない（本命） --------- */
    async function testY10() {
        await closeAllMenus();
        await stopAllIfPlaying();
        log('  [目的] ピン中に ◀▶ を押しても order と保存URL（sync_url_*）が1文字も動かないこと。');
        log('  ⚠️ この項目は保存URLを一時的に書き換える。終了時に必ず元へ戻す。');

        var started = cardCount();
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        var wasCols = await forceAutoCols();
        pc('🔴 保存URLを退避できた', function () {
            return 'キー ' + Object.keys(backup).length + '件';
        });
        note('退避した保存URLのキー', Object.keys(backup).sort().join(', ') || '(なし)');

        try {
            await clearPins();
            var got = await setCardCount(7);
            pc('枠を7つにできた（末尾を削除して6枠に戻すため）', function () {
                return got === 7 ? '7枠' : false;
            });

            /* 🔴 sync_url_1..N（連番キー）は URL を読み込むだけでは書かれない。
               書くのは resaveUrlsBasedOnOrder()＝🗑 と ◀▶ の経路だけなので、
               3本を読み込んでから末尾の枠を 🗑 で消して連番キーを成立させる。
               こうしないと「変わっていない」が空欄どうしの比較で自明に成立する。 */
            var ids = [];
            try { ids = activeCardIds.slice(0, 3); } catch (e) { ids = []; }
            var vids = [VID.LIGHT, VID.MID, VID.SAMECH];
            var loaded = 0;
            for (var i = 0; i < ids.length; i++) {
                await clearCard(ids[i]);
                var ld = await loadUrlIntoCard(ids[i], ytUrl(vids[i]));
                if (ld.ok) loaded++;
            }
            pc('3本のURLを枠1〜3へ読み込めた（再生も取得もしない）', function () {
                return loaded === 3 ? (loaded + '本') : (loaded + '本');
            });

            var del = await deleteCard(lastCard());
            pc('🗑 で末尾の枠を削除して6枠になった', function () {
                return (del.ok && cardCount() === 6) ? (cardCount() + '枠') : false;
            });
            pc('🔴 sync_url_1..N に値が3件以上入った（判定が空振りしないこと）', function () {
                var n = indexUrlCount();
                return n >= 3 ? (n + '件') : false;
            });

            /* 🔴 positive control: ピンを外した状態なら ◀▶ が実際に order を変える。
               これが無いと「押しても何も起きない実装」でも合格してしまう。 */
            var cid = lastCard();
            var ordPre = orderText();
            var mv1 = await pressMove(cid, -1);
            var ordMoved = orderText();
            await pressMove(cid, 1);
            var ordBack = orderText();
            note('◀ を押したときの当たり判定（押し下げ式ヘッダーなので被覆ありが正常）',
                (mv1.blocked ? '被覆あり / ' : '被覆なし / ') + (mv1.hit || '(記録なし)'));
            pc('🔴 ピンが無い状態では ◀▶ が実際に order を変える（◀▶ が生きていることの証明）',
                function () {
                    return (ordMoved !== ordPre && ordBack === ordPre)
                        ? '変化あり → 元へ復帰' : false;
                });

            var pin = await pinCardId(cid);
            var s1 = (await settledSnapshot(cid)).snap;
            var big = biggerCheck(s1);
            pc('🔴 末尾の枠にピンが付いて実際に大きくなった（縦が 1×1 の '
                + PIN_BIG_RATIO + '倍以上）', function () {
                    return (pin.ok && big) ? big.text : false;
                });

            var ord0 = orderText();
            var idx0 = indexUrlText();
            var all0 = urlSnapText(urlSnapshot());
            var cell0 = pinCellOf(s1);
            note('基準の order', ord0);
            note('基準の sync_url_1..N の件数', indexUrlCount());
            note('基準のピン枠のセル', cell0 ? ('r' + cell0.r + 'c' + cell0.c) : '(測れず)');

            /* ▶▶▶ ◀◀ と前後あわせて5回押す。 */
            var seq = [1, 1, 1, -1, -1];
            var cells = [];
            for (var k = 0; k < seq.length; k++) {
                await pressMove(cid, seq[k]);
                var sk = (await settledSnapshot(cid)).snap;
                var q = pinCellOf(sk);
                cells.push((seq[k] > 0 ? '▶' : '◀') + (q ? ('r' + q.r + 'c' + q.c) : '?'));
            }
            note('◀▶ を押すたびのピン枠のセル', cells.join(' → '));
            pc('🔴 ◀▶ でピン位置が実際に動いた（押しても何も起きない実装を弾く）', function () {
                var u = {};
                cells.forEach(function (t) { u[t.slice(1)] = 1; });
                var ks = Object.keys(u);
                return ks.length >= 2 ? ks.join(' / ') : false;
            });

            expect('🔴 ◀▶ の前後で order が完全一致', orderText(), ord0);
            expect('🔴 ◀▶ の前後で sync_url_1..N が完全一致', indexUrlText(), idx0);
            expect('🔴 ◀▶ の前後で sync_url_* の全キーが完全一致', urlSnapText(urlSnapshot()), all0);
            expect('◀▶ の前後で is-main の枚数が1枚のまま', pinnedCards().length, 1);

        } finally {
            /* 🔴 枠数を先に戻す。➖ は compactSavedUrls() を呼んで連番キーを書き換えるので、
                  保存URLの復元は必ず「枠数を戻したあと」に行う。 */
            try { await clearPins(); } catch (e) { }
            await restoreCols(wasCols);
            try { await setCardCount(started); } catch (e) { }
            var restored = restoreUrlSnapshot(backup);
            expect('🔴 後始末: 保存URL（sync_url_*）を元どおり復元できた', restored, backupText);
            note('復元後のキー数', Object.keys(urlSnapshot()).length);
            log('  ⚠️ 枠に読み込んだ動画は画面には残るが、保存URLは元に戻した。'
                + 'ページを再読み込みすると元の構成に戻る。');
        }
    }

    /* 選べる隅を構成から計算する（鉄則 #42）。本体の canPinRight / canPinBottom と同じ式。 */
    function cornerPlanOf(snap) {
        if (!snap) return null;
        var colN = snap.colCount, rowN = snap.rowCount;
        var spanCol = Math.min(2, colN);
        var rightCol = colN - spanCol + 1;
        var bottomRow = rowN - 1;
        return {
            colN: colN, rowN: rowN, spanCol: spanCol,
            rightCol: rightCol, bottomRow: bottomRow,
            canRight: rightCol > 1, canBottom: bottomRow > 1,
            count: (rightCol > 1 ? 2 : 1) * (bottomRow > 1 ? 2 : 1)
        };
    }

    /* --- D-Y11: 4隅それぞれで配置が破綻しない ------------------------------ */
    async function testY11() {
        log('  [目的] 選べる隅すべてで、画面外はみ出し0 / 未解決0 / 重なり0 であること。');
        log('  ⚠️ 空きセルは枠数によって出るのが既存の設計なので判定に入れない。');
        var started = cardCount();
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        var wasCols = await forceAutoCols();
        try {
            var st = await setupPinned(6, '');
            var cid = st.cid;
            await pcViewportProbe('');

            var plan = cornerPlanOf(st.snap);
            pc('🔴 選べる隅の数を構成から計算できた（'
                + (plan ? (plan.colN + '列 × ' + plan.rowN + '行 → ' + plan.count + 'か所') : '(測れず)')
                + '）', function () {
                    return (plan && plan.count === 4) ? '4か所' : false;
                });

            var labels = ['左上', '右上', '左下', '右下'];
            var seen = [];
            for (var i = 0; i < 4; i++) {
                if (i > 0) await pressMove(cid, 1);
                var sn = (await settledSnapshot(cid)).snap;
                var q = pinCellOf(sn);
                seen.push(labels[i] + '=r' + (q ? q.r : '?') + 'c' + (q ? q.c : '?'));
                expect('【' + labels[i] + '】🔴 画面（ビューポート）からのはみ出し量（px）',
                    sn ? sn.viewportOutside : -1, 0);
                expect('【' + labels[i] + '】セル座標を解決できなかったカード', sn ? sn.unresolved : -1, 0);
                expect('【' + labels[i] + '】セルの重なり', sn ? sn.overlap : -1, 0);
                note('【' + labels[i] + '】ピン枠のセル / 空きセル / グリッド基準のはみ出し',
                    (q ? ('r' + q.r + 'c' + q.c + ' ' + q.rs + '×' + q.cs) : '(測れず)')
                    + ' / ' + (sn ? sn.holes : '?') + ' / ' + (sn ? sn.outside : '?') + 'px');
                if (i === 0 || i === 3) noteLayout(sn, '6枠＋末尾ピン / ' + labels[i]);
            }
            pc('🔴 4隅それぞれが別のセルに置かれた（隅の指定が実際に効いたことの証明）', function () {
                var u = {};
                seen.forEach(function (t) { u[t.split('=')[1]] = 1; });
                return Object.keys(u).length === 4 ? seen.join(' / ') : false;
            });
            note('各隅のピン枠セル', seen.join(' / '));
        } finally {
            /* 🔴 枠数を先に戻す。➖ は compactSavedUrls() を呼ぶので順序が重要。 */
            try { await clearPins(); } catch (e) { }
            await restoreCols(wasCols);
            try { await setCardCount(started); } catch (e) { }
            var restored = restoreUrlSnapshot(backup);
            note('後始末: 保存URLの復元（枠数を変えたため）',
                restored === backupText ? '元どおり' : '⚠ 差分あり');
        }
    }

    /* --- D-Y12: ピン枠が指定した隅にある（期待値は構成から計算） ------------ */
    async function testY12() {
        log('  [目的] ピン枠の開始セル座標が、構成から計算した期待値と一致すること。');
        log('  🔴 期待値は固定値で書かない（鉄則 #42）。列数・行数から毎回計算する。');
        var started = cardCount();
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        var wasCols = await forceAutoCols();
        try {
            var st = await setupPinned(6, '');
            var cid = st.cid;
            var plan = cornerPlanOf(st.snap);
            pc('🔴 期待座標を構成から計算できた（'
                + (plan ? (plan.colN + '列 × ' + plan.rowN + '行 / span ' + plan.spanCol
                    + ' → 右 = 列' + plan.rightCol + ' / 下 = 行' + plan.bottomRow) : '(測れず)')
                + '）', function () {
                    return (plan && plan.canRight && plan.canBottom)
                        ? ('列' + plan.rightCol + ' / 行' + plan.bottomRow) : false;
                });
            if (!plan) return;

            var want = [
                { n: '左上', r: 1, c: 1 },
                { n: '右上', r: 1, c: plan.rightCol },
                { n: '左下', r: plan.bottomRow, c: 1 },
                { n: '右下', r: plan.bottomRow, c: plan.rightCol }
            ];
            for (var i = 0; i < 4; i++) {
                if (i > 0) await pressMove(cid, 1);
                var sn = (await settledSnapshot(cid)).snap;
                var q = pinCellOf(sn);
                expect('【' + want[i].n + '】ピン枠の開始セル（構成から計算した期待値と照合）',
                    q ? ('r' + q.r + 'c' + q.c) : '(測れず)', 'r' + want[i].r + 'c' + want[i].c);
                expect('【' + want[i].n + '】ピン枠の占有（行×列）',
                    q ? (q.rs + '×' + q.cs) : '(測れず)', '2×' + plan.spanCol);
            }

            /* 端では止める（循環させない）。 */
            await pressMove(cid, 1);
            var sEnd = (await settledSnapshot(cid)).snap;
            var qe = pinCellOf(sEnd);
            expect('右下でさらに ▶ を押しても動かない（端で止める）',
                qe ? ('r' + qe.r + 'c' + qe.c) : '(測れず)',
                'r' + plan.bottomRow + 'c' + plan.rightCol);

            /* ◀ で1つ戻れる。 */
            await pressMove(cid, -1);
            var sBk = (await settledSnapshot(cid)).snap;
            var qb = pinCellOf(sBk);
            expect('◀ で1つ前（左下）へ戻れる',
                qb ? ('r' + qb.r + 'c' + qb.c) : '(測れず)', 'r' + plan.bottomRow + 'c1');

            /* ピンを外して付け直すと左上へ戻る（位置を保持しない設計）。 */
            await clearPins();
            await wait(300);
            var again = await pinCardId(cid);
            var sAg = (await settledSnapshot(cid)).snap;
            var qa = pinCellOf(sAg);
            pc('ピンを付け直せた', function () {
                return (again.ok && pinnedCards().length === 1) ? cid : false;
            });
            expect('🔴 ピンを外して付け直すと左上へ戻る（位置は保持しない）',
                qa ? ('r' + qa.r + 'c' + qa.c) : '(測れず)', 'r1c1');
            note('付け直し前の隅 / 付け直し後の隅',
                (qb ? ('r' + qb.r + 'c' + qb.c) : '?') + ' → ' + (qa ? ('r' + qa.r + 'c' + qa.c) : '?'));
        } finally {
            /* 🔴 枠数を先に戻す。➖ は compactSavedUrls() を呼ぶので順序が重要。 */
            try { await clearPins(); } catch (e) { }
            await restoreCols(wasCols);
            try { await setCardCount(started); } catch (e) { }
            var restored = restoreUrlSnapshot(backup);
            note('後始末: 保存URLの復元（枠数を変えたため）',
                restored === backupText ? '元どおり' : '⚠ 差分あり');
        }
    }

    /* select は clickReal では変えられない。実際の change イベントを送る
       （onchange="updateLayout(); saveSettings();" は属性のハンドラなので届く）。 */
    async function setLayoutCols(v) {
        var sel = document.getElementById('layoutCols');
        if (!sel) return false;
        sel.value = String(v);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(500);
        return sel.value === String(v);
    }

    /* ======================================================================
       ★v1.10.0 : v2.8.8 の判定
       ==================================================================== */

    /* --- D-V2: 🔴 アドオンの版数は ADDON_REQUIRED_VERSION と完全一致で照合する ----
       >= や範囲で照合すると、アドオンを変えた版で古いアドオンが緑になる。
       addonVersion（本体のトップレベルの let）を一時的に書き換えて確かめ、最後に必ず戻す。 */
    async function testV2() {
        var badge = document.getElementById('versionBadge');
        var req = addonRequired();
        var app = appVersion();
        var was;
        try { was = addonVersion; } catch (e) { was = undefined; }
        pc('本体の addonVersion を読める（アドオンが応答済み）', function () {
            return (was !== undefined && was !== null) ? String(was) : false;
        });
        pc('ADDON_REQUIRED_VERSION を読める', function () { return req !== '(取得不可)' ? req : false; });
        if (was === undefined || was === null || req === '(取得不可)') return;

        function kindNow() {
            return ['ok', 'warn', 'ng'].filter(function (c) { return badge.classList.contains(c); }).join(',') || '(なし)';
        }
        function setAddon(v) {
            try { addonVersion = v; } catch (e) { }
            try { updateVersionBadge(); } catch (e) { }
            return kindNow();
        }
        try {
            /* 🔴 positive control: 書き換えが実際にバッジへ効くこと（効かなければ下の判定は無意味）。 */
            var kGarbage = setAddon('0.0.0');
            pc('🔴 addonVersion を書き換えるとバッジが変わる（0.0.0 → warn）', function () {
                return kGarbage === 'warn' ? 'warn' : false;
            });
            expect('アドオンが ADDON_REQUIRED_VERSION と一致 → 緑', setAddon(req), 'ok');
            if (app !== req) {
                expect('🔴 アドオンが APP_VERSION と一致しても ADDON_REQUIRED_VERSION と違えば → 橙（完全一致の照合）',
                    setAddon(app), 'warn');
            } else {
                note('APP_VERSION と ADDON_REQUIRED_VERSION が同じ版のため、上の判定は省略', app);
            }
            var bumped = req.replace(/(\d+)$/, function (m) { return String(parseInt(m, 10) + 1); });
            expect('🔴 アドオンの方が新しくても → 橙（>= で照合していない）', setAddon(bumped), 'warn');
        } finally {
            setAddon(was);
            note('後始末: addonVersion を元へ戻した', String(was) + ' → ' + kindNow());
        }
    }

    /* --- D-U1: 一括コントローラーの出し方（ホバー / クリックのみ） -------------- */
    function ctlActive() {
        var oc = document.getElementById('overlayController');
        return !!(oc && oc.classList.contains('active'));
    }
    function moveMouseTo(y) {
        try {
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Math.round(window.innerWidth / 2), clientY: y }));
        } catch (e) { }
    }
    async function setTrigger(v) {
        var sel = document.getElementById('controllerTrigger');
        if (!sel) return false;
        sel.value = v;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(100);
        var cur = null;
        try { cur = controllerTrigger; } catch (e) { }
        return cur === v;
    }
    async function testU1() {
        await closeAllMenus();
        var sel = document.getElementById('controllerTrigger');
        var tab = document.getElementById('controllerTab');
        var wasTrigger = null, wasLocked = null, wasActive = ctlActive();
        try { wasTrigger = controllerTrigger; } catch (e) { }
        try { wasLocked = !!isControllerLocked; } catch (e) { }
        pc('設定欄（#controllerTrigger）と ▲ タブ（#controllerTab）がある', function () {
            return (sel && tab) ? describe(sel) + ' / ' + describe(tab) : false;
        });
        if (!sel || !tab) return;
        note('測定開始時の 出し方 / 🔒 / 表示', wasTrigger + ' / ' + wasLocked + ' / ' + wasActive);
        try {
            if (wasLocked) { try { toggleControllerLock(); } catch (e) { } }
            var bottom = window.innerHeight - 10;

            /* 🔴 positive control: ホバーのとき、合成 mousemove で実際に出ること。
               これが成立しないと「クリックのみでは出ない」が自明に合格してしまう。 */
            await setTrigger('hover');
            hideController();
            moveMouseTo(bottom);
            await wait(150);
            var hoverShown = ctlActive();
            pc('🔴 ホバー: 下端への合成 mousemove で一括コントローラーが出る', function () {
                return hoverShown ? '出た' : false;
            });

            var okSet = await setTrigger('click');
            pc('設定を「クリックのみ」に切り替えられた', function () { return okSet ? 'click' : false; });
            hideController();
            moveMouseTo(bottom);
            var oc = document.getElementById('overlayController');
            try { oc.dispatchEvent(new MouseEvent('mouseenter')); } catch (e) { }
            await wait(150);
            expect('🔴 クリックのみ: 下端へ動かしても出ない', ctlActive(), false);

            var c1 = await clickReal(tab);
            expect('クリックのみ: ▲ タブを押すと出る', ctlActive(), true);
            expect('▲ タブを押せた（被覆なし）', c1.blocked ? ('blocked: ' + c1.reason + ' / ' + c1.hit) : 'ok', 'ok');

            moveMouseTo(100);
            try { oc.dispatchEvent(new MouseEvent('mouseleave')); } catch (e) { }
            await wait(1700);
            expect('クリックのみ: マウスが離れても勝手に隠れない（1.7秒待つ）', ctlActive(), true);

            await clickReal(tab);
            expect('クリックのみ: もう一度押すと隠れる', ctlActive(), false);

            var saved = null;
            try { saved = localStorage.getItem('sync_controller_trigger'); } catch (e) { }
            expect('設定が保存される（sync_controller_trigger）', saved, 'click');
        } finally {
            await setTrigger(wasTrigger === 'click' ? 'click' : 'hover');
            if (wasLocked) { try { if (!isControllerLocked) toggleControllerLock(); } catch (e) { } }
            if (wasActive) showController(); else hideController();
            note('後始末: 出し方 / 🔒 / 表示', (function () {
                var t = null, l = null;
                try { t = controllerTrigger; } catch (e) { }
                try { l = !!isControllerLocked; } catch (e) { }
                return t + ' / ' + l + ' / ' + ctlActive();
            })());
        }
    }

    /* --- D-U2: 秒送りボタンに記号と秒数が出て、設定に追従する --------------- */
    function skipTexts() {
        function t(el) { return el ? String(el.textContent).trim() : '(なし)'; }
        var cb = document.querySelectorAll('.skip-back-btn');
        var cf = document.querySelectorAll('.skip-forward-btn');
        return {
            cardBack: Array.prototype.map.call(cb, t),
            cardFwd: Array.prototype.map.call(cf, t),
            batchBack: t(document.getElementById('batchSkipBackBtn')),
            batchFwd: t(document.getElementById('batchSkipForwardBtn'))
        };
    }
    function uniq(a) { var o = {}; a.forEach(function (x) { o[x] = 1; }); return Object.keys(o); }
    async function testU2() {
        await closeAllMenus();
        var inB = document.getElementById('skipSecBack');
        var inF = document.getElementById('skipSecForward');
        pc('秒数の入力欄がある', function () { return (inB && inF) ? inB.value + 's / ' + inF.value + 's' : false; });
        if (!inB || !inF) return;
        var t0 = skipTexts();
        pc('枠ごとの秒送りボタンが1組以上ある', function () {
            return (t0.cardBack.length > 0 && t0.cardBack.length === t0.cardFwd.length) ? t0.cardBack.length + '組' : false;
        });
        var b0 = inB.value, f0 = inF.value;
        expect('一括 戻る', t0.batchBack, '⏪' + b0 + 's');
        expect('一括 進む', t0.batchFwd, f0 + 's⏩');
        expect('枠ごと 戻る（全枠）', uniq(t0.cardBack).join(','), '⏪' + b0 + 's');
        expect('枠ごと 進む（全枠）', uniq(t0.cardFwd).join(','), f0 + 's⏩');
        var b1 = String((parseInt(b0, 10) || 10) + 3), f1 = String((parseInt(f0, 10) || 10) + 7);
        try {
            inB.value = b1; inB.dispatchEvent(new Event('change', { bubbles: true }));
            inF.value = f1; inF.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(100);
            pc('🔴 秒数を実際に変えられた（getSkipSecBack / Forward）', function () {
                var gb = null, gf = null;
                try { gb = getSkipSecBack(); gf = getSkipSecForward(); } catch (e) { }
                return (String(gb) === b1 && String(gf) === f1) ? (gb + 's / ' + gf + 's') : false;
            });
            var t1 = skipTexts();
            expect('変更後: 一括 戻る', t1.batchBack, '⏪' + b1 + 's');
            expect('変更後: 一括 進む', t1.batchFwd, f1 + 's⏩');
            expect('変更後: 枠ごと 戻る（全枠）', uniq(t1.cardBack).join(','), '⏪' + b1 + 's');
            expect('変更後: 枠ごと 進む（全枠）', uniq(t1.cardFwd).join(','), f1 + 's⏩');
            var timerReset = document.querySelector('.timer-reset-btn');
            expect('タイマーのリセット（↺）は変えていない', timerReset ? String(timerReset.textContent).trim() : '(なし)', '↺');
        } finally {
            inB.value = b0; inB.dispatchEvent(new Event('change', { bubbles: true }));
            inF.value = f0; inF.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(100);
            note('後始末: 秒数を戻した', inB.value + 's / ' + inF.value + 's');
        }
    }

    /* --- D-Y13: ヘッダーのボタンが狭い枠でもヘッダー内に収まる（9枠） ---------
       v2.8.8 でアイコンを 1.5倍にし、秒送りを文字（⏪10s）にした。
       🔴 ヘッダー自身の高さは --header-height の固定値で伸びない。壊れ方は「ボタンがヘッダーの外へ
          はみ出して切れる」になる。横は狭い枠ほど厳しいので、最も狭い枠（9枠・自動）で測る。 */
    async function testY13() {
        log('  [目的] 9枠（最も狭い枠）で、ホバー相当のヘッダーに全ボタンが収まること。');
        var started = cardCount();
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        var wasCols = await forceAutoCols();
        var cid = null;
        try {
            await closeAllMenus();
            await clearPins();
            var got = await setCardCount(9);
            pc('枠を9つにできた', function () { return got === 9 ? '9枠' : false; });
            cid = lastCard();
            var card = document.getElementById(cid);
            await waitRectSettled(card, LAYOUT_SETTLE_MS);
            forceHeaderOpen(cid, true);
            var hdr = document.querySelector('#' + cid + ' .player-header');
            await waitRectSettled(hdr, LAYOUT_SETTLE_MS);
            var hr = rect(hdr);
            pc('🔴 ヘッダーを開いた状態を作れた（高さ > 0）', function () {
                return hr && hr.height > 0 ? Math.round(hr.height) + 'px' : false;
            });
            var scale = parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 0;
            pc('--ui-scale を読めている', function () { return scale > 0 ? String(scale) : false; });
            expect('ヘッダー高が --header-height（30px × --ui-scale）のまま（±1px）',
                Math.abs(hr.height - 30 * scale) <= 1 ? 'ok' : (Math.round(hr.height * 10) / 10 + 'px'), 'ok');

            var btns = Array.prototype.filter.call(hdr.querySelectorAll('button'), function (b) { return b.offsetWidth > 0; });
            pc('ヘッダーに表示中のボタンがある', function () { return btns.length > 0 ? btns.length + '個' : false; });
            var out = [];
            btns.forEach(function (b) {
                var r = rect(b);
                var dx = Math.max(0, r.right - hr.right), dl = Math.max(0, hr.left - r.left);
                var dt = Math.max(0, hr.top - r.top), db = Math.max(0, r.bottom - hr.bottom);
                var m = Math.max(dx, dl, dt, db);
                if (m > 0.5) out.push(String(b.textContent).trim() + ' ' + Math.round(m) + 'px');
            });
            expect('🔴 ヘッダーからはみ出したボタン（9枠 / ホバー相当）', out.length ? out.join(' / ') : 'なし', 'なし');

            var chat = hdr.querySelector('.chat-toggle-btn');
            var fBtn = chat ? parseFloat(window.getComputedStyle(chat).fontSize) : 0;
            var fHdr = parseFloat(window.getComputedStyle(hdr).fontSize) || 0;
            pc('字の大きさを読めている（ボタン / 見出し）', function () {
                return (fBtn > 0 && fHdr > 0) ? fBtn + 'px / ' + fHdr + 'px' : false;
            });
            expect('アイコンの字が見出しの文字の 1.5倍（±0.05）',
                (fHdr > 0 && Math.abs(fBtn / fHdr - 1.5) <= 0.05) ? 'ok' : (fHdr > 0 ? (fBtn / fHdr).toFixed(2) + '倍' : '(測れず)'), 'ok');
            note('枠幅 / ヘッダー幅 / ボタンの幅（左から）', Math.round(rect(card).width) + ' / ' + Math.round(hr.width) + ' / '
                + btns.map(function (b) { return Math.round(rect(b).width); }).join(','));
            note('ボタンの右端の最大 − ヘッダーの右端（負なら余裕）',
                Math.round(Math.max.apply(null, btns.map(function (b) { return rect(b).right; })) - hr.right) + 'px');
        } finally {
            if (cid) forceHeaderOpen(cid, false);
            await restoreCols(wasCols);
            try { await setCardCount(started); } catch (e) { }
            var restored = restoreUrlSnapshot(backup);
            note('後始末: 保存URLの復元（枠数を変えたため）', restored === backupText ? '元どおり' : '⚠ 差分あり');
        }
    }

    /* ======================================================================
       ★v1.11.0 : v2.8.9（音量）の判定
       ==================================================================== */
    function volApi() {
        var o = {};
        try { o.eff = effectiveVolume; o.getCard = getCardVolume; o.setCard = setCardVolume;
              o.master = changeMasterVolume; o.getMaster = getMasterVolume; } catch (e) { return null; }
        return (typeof o.eff === 'function' && typeof o.setCard === 'function') ? o : null;
    }
    function sortedCardIds() {
        try { return getSortedCards().map(function (c) { return c.id; }); } catch (e) { return []; }
    }

    /* --- D-A1: 音量ミキサーに全枠の行が並び、枠と対応している -------------- */
    async function testA1() {
        await closeAllMenus();
        var btn = document.getElementById('topVolumeBtn');
        var panel = document.getElementById('volumeMenu');
        pc('🔊 ボタンとパネルがある', function () { return (btn && panel) ? describe(btn) + ' / ' + describe(panel) : false; });
        if (!btn || !panel) return;
        var c1 = await clickReal(btn);
        expect('🔊 を押せた（被覆なし）', c1.blocked ? ('blocked: ' + c1.reason) : 'ok', 'ok');
        expect('パネルが開く', panel.classList.contains('open'), true);
        var ids = sortedCardIds();
        var rows = Array.prototype.slice.call(document.querySelectorAll('#volumeRows .vol-row'));
        pc('枠が1つ以上ある', function () { return ids.length ? ids.length + '枠' : false; });
        expect('行の数が枠の数と一致', rows.length, ids.length);
        expect('行の並びが枠の並び（order）と一致', rows.map(function (r) { return r.dataset.cardId; }).join(','), ids.join(','));
        var labelsOk = rows.every(function (r, i) {
            var no = r.querySelector('.vol-no');
            return no && String(no.textContent).trim() === '枠' + (i + 1);
        });
        expect('各行に「枠N」の番号が出ている', labelsOk, true);
        /* 行にマウスを乗せると対象の枠が光る（どのスライダーがどの枠かを示す仕掛け） */
        if (rows.length) {
            var r0 = rows[0], card0 = document.getElementById(r0.dataset.cardId);
            r0.dispatchEvent(new MouseEvent('mouseenter'));
            var lit = card0 ? card0.classList.contains('vol-highlight') : false;
            r0.dispatchEvent(new MouseEvent('mouseleave'));
            var unlit = card0 ? !card0.classList.contains('vol-highlight') : false;
            expect('行にマウスを乗せると対象の枠が光り、外すと消える', (lit && unlit) ? 'ok' : ('光る=' + lit + ' / 消える=' + unlit), 'ok');
        }
        var enabled = rows.filter(function (r) { var i = r.querySelector('input'); return i && !i.disabled; }).length;
        note('操作できる行 / 全行（動画の入っていない枠は無効）', enabled + ' / ' + rows.length);
        var mm = document.getElementById('mixerMasterVolume'), mb = document.getElementById('masterVolume');
        expect('ミキサーのマスターが下部の音量と同じ値', mm && mb ? (mm.value === mb.value ? 'ok' : mm.value + ' / ' + mb.value) : '(要素なし)', 'ok');
        await closeAllMenus();
        expect('閉じたら光っている枠が残らない', document.querySelectorAll('.player-card.vol-highlight').length, 0);
    }

    /* --- D-A2: 🔴 マスター音量を動かしても枠ごとの音量が崩れない ------------ */
    async function testA2() {
        await closeAllMenus();
        var api = volApi();
        pc('本体の音量関数を読める（effectiveVolume / setCardVolume / changeMasterVolume）', function () { return api ? 'あり' : false; });
        if (!api) return;
        /* ★v1.17.1: 枠が1つしかないと土俵が無く判定不能になった（2026-10-04 実機）。足して測り、後で戻す */
        var startedA2 = cardCount();
        if (sortedCardIds().length < 2) {
            await setCardCount(2);
            note('枠が1つしかなかったので一時的に2枠にした', cardCount() + '枠');
        }
        var ids = sortedCardIds();
        pc('枠が2つ以上ある（差を作るため）', function () { return ids.length >= 2 ? ids.length + '枠' : false; });
        if (ids.length < 2) { await setCardCount(startedA2); return; }
        var a = ids[0], b = ids[1];
        var m0 = api.getMaster(), va0 = api.getCard(a), vb0 = api.getCard(b);
        var stored0 = null;
        try { stored0 = localStorage.getItem('sync_card_volume'); } catch (e) { }
        try {
            api.setCard(a, 80); api.setCard(b, 30);
            api.master(50);
            /* 🔴 positive control: マスターを変えると実効音量が実際に変わること（変わらなければ判定は無意味） */
            var e50 = api.eff(a);
            api.master(100);
            var e100 = api.eff(a);
            /* ⚠️ PC は「独立しているか」に依存させない（依存させると壊れたとき判定不能になり、不合格として出ない）。 */
            pc('🔴 マスターを変えると実効音量が変わる（枠A / マスター 50 → 100）', function () {
                return (e100 > e50) ? (e50 + ' → ' + e100) : false;
            });
            api.master(20);
            expect('🔴 マスターを動かしたあとも枠Aの音量は 80 のまま', api.getCard(a), 80);
            expect('🔴 マスターを動かしたあとも枠Bの音量は 30 のまま', api.getCard(b), 30);
            expect('実効音量 ＝ マスター × 枠ごと（枠A: 20 × 80% ＝ 16）', api.eff(a), 16);
            expect('実効音量 ＝ マスター × 枠ごと（枠B: 20 × 30% ＝ 6）', api.eff(b), 6);
            var saved = null;
            try { saved = JSON.parse(localStorage.getItem('sync_card_volume') || '{}'); } catch (e) { }
            expect('枠ごとの音量が保存される（sync_card_volume）', saved ? (saved[a] + ' / ' + saved[b]) : '(読めず)', '80 / 30');
            var li = document.getElementById('localVolume_' + a);
            expect('枠の操作バーの音量欄（localVolume_）は枠ごとの音量を出す', li ? li.value : '(なし)', '80');
            /* 実プレイヤーがいれば、実際に設定された音量も見る（いなければ観測だけ） */
            var p = null;
            try { p = ytPlayers[a] || ytPlayers[b]; } catch (e) { }
            var pid = null;
            try { pid = ytPlayers[a] ? a : (ytPlayers[b] ? b : null); } catch (e) { }
            if (p && typeof p.getVolume === 'function') {
                await wait(300);
                var got = null;
                try { got = p.getVolume(); } catch (e) { }
                note('YouTube プレイヤーの getVolume()（期待 ' + api.eff(pid) + '）', String(got));
            } else {
                note('YouTube プレイヤーの getVolume()', '(枠A・Bにプレイヤーが無いので観測なし)');
            }
        } finally {
            api.master(m0);
            cardVolume_restore(a, va0); cardVolume_restore(b, vb0);
            try { if (stored0 === null) localStorage.removeItem('sync_card_volume'); else localStorage.setItem('sync_card_volume', stored0); } catch (e) { }
            try { loadCardVolumes(); ids.forEach(function (id) { applyCardVolume(id); }); } catch (e) { }
            note('後始末: マスター / 枠A / 枠B', api.getMaster() + ' / ' + api.getCard(a) + ' / ' + api.getCard(b));
            if (cardCount() !== startedA2) {
                try { await setCardCount(startedA2); } catch (e) { }
                note('後始末: 枠数を戻した', cardCount() + '枠');
            }
        }
        function cardVolume_restore(id, v) { try { api.setCard(id, v); } catch (e) { } }
    }

    /* ======================================================================
       ★v1.12.0 : v2.8.10（ローカル動画の拡大）の判定
       ==================================================================== */
    /* --- D-Z1: 動画だけが拡大され、操作バーは切れない -------------------------
       枠を1つ足し、その枠にダミーのファイルを読ませてローカル動画の枠にする（デコードはされないが
       <video> と操作バーは本物の経路で作られる）。終了時に枠数と保存URLを戻す。 */
    async function testZ1() {
        log('  [目的] 拡大で <video> だけが大きくなり、はみ出しは枠で切られ、操作バーは切れないこと。');
        var started = cardCount();
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        try {
            await closeAllMenus();
            var got = await setCardCount(started + 1);
            pc('枠を1つ足せた', function () { return got === started + 1 ? (got + '枠') : false; });
            var cid = lastCard();
            var file = null;
            try { file = new File([new Uint8Array(64)], 'dbg_zoom.mp4', { type: 'video/mp4' }); } catch (e) { }
            try { handleLocalSelect({ target: { files: [file] } }, cid); } catch (e) { log('  handleLocalSelect: ' + e.message); }
            await wait(300);
            var video = document.getElementById('localVideo_' + cid);
            var container = document.getElementById('playerContainer_' + cid);
            var overlay = document.getElementById('localOverlay_' + cid);
            var sel = document.getElementById('localZoomFit_' + cid);
            var rng = document.getElementById('localZoom_' + cid);
            pc('ローカル動画の枠になった（video / 操作バー / 拡大の欄がある）', function () {
                return (video && overlay && sel && rng) ? describe(video) + ' / ' + describe(overlay) : false;
            });
            if (!video || !overlay || !sel || !rng) return;
            /* 操作バーは .player-container の外（切られない場所）にあること */
            expect('🔴 操作バーは拡大で切られる枠（.player-container）の外にある', container.contains(overlay), false);
            /* ★v1.12.1: 既定は「枠いっぱい（cover）」（2026-10-02 利用者要望）。cover は枠で切るので zoomed が付く。 */
            expect('既定は 枠いっぱい / 100%', sel.value + ' / ' + rng.value, 'cover / 100');
            expect('既定（枠いっぱい）は object-fit が cover', window.getComputedStyle(video).objectFit, 'cover');
            expect('既定（枠いっぱい）は枠で切る（zoomed）', container.classList.contains('zoomed'), true);
            sel.value = 'contain'; sel.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(100);
            expect('全体を表示: object-fit が contain', window.getComputedStyle(video).objectFit, 'contain');
            expect('全体を表示・100%: 枠で切らない', container.classList.contains('zoomed'), false);

            var r0 = rect(video);
            rng.value = '150'; rng.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(150);
            var r1 = rect(video);
            /* 🔴 positive control: 拡大が実際に矩形へ効いたこと（効かなければ下の判定は無意味） */
            pc('🔴 150% にすると video の矩形が実際に大きくなる', function () {
                return (r0.width > 0 && r1.width > r0.width * 1.4) ? (Math.round(r0.width) + ' → ' + Math.round(r1.width) + 'px') : false;
            });
            expect('150%: 枠で切る（zoomed）', container.classList.contains('zoomed'), true);
            expect('150%: 枠の overflow が hidden', window.getComputedStyle(container).overflow, 'hidden');
            var cr = rect(container);
            expect('150%: video は枠からはみ出している（＝切られる側にある）', (r1.width > cr.width + 1) ? 'ok' : (Math.round(r1.width) + ' / ' + Math.round(cr.width)), 'ok');
            expect('150%: 中心は動かない（±2px）', Math.abs((r1.left + r1.width / 2) - (r0.left + r0.width / 2)) <= 2 ? 'ok' : 'ずれた', 'ok');
            var val = document.getElementById('localZoomVal_' + cid);
            expect('表示値', val ? val.innerText : '(なし)', '150%');


            var dbl = document.getElementById('localZoomVal_' + cid);
            dbl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            await wait(100);
            expect('ダブルクリックで 枠いっぱい / 100% に戻る', sel.value + ' / ' + rng.value, 'cover / 100');
            expect('戻したら transform なし', video.style.transform, '');
            note('枠 / 操作バーの矩形', JSON.stringify(cr) + ' / ' + JSON.stringify(rect(overlay)));
        } finally {
            try { await setCardCount(started); } catch (e) { }
            var restored = restoreUrlSnapshot(backup);
            note('後始末: 枠数と保存URLの復元', cardCount() + '枠 / ' + (restored === backupText ? '元どおり' : '⚠ 差分あり'));
        }
    }

    /* ======================================================================
       ★v1.13.0 : v2.8.11 の判定（枠の境界線ドラッグ）
       ==================================================================== */

    /* --- D-S1: 境界線のつまみで隣り合う2本のトラックだけが変わる ----------------
       つまみは #gridSplitterLayer の .grid-splitter。mousedown をつまみへ、mousemove / mouseup を
       document へ合成して送る（本体のリスナーがその位置にある）。
       🔴 保存した比（sync_grid_ratios）・枠数・列数設定・保存URL は終了時に戻す。 */
    function gridTracks(axis) {
        var g = document.getElementById('playersGrid');
        if (!g) return [];
        var cs = window.getComputedStyle(g);
        var t = axis === 'cols' ? cs.gridTemplateColumns : cs.gridTemplateRows;
        return String(t || '').split(/\s+/).map(parseFloat).filter(function (v) { return isFinite(v); });
    }
    function spreadPx(a) { return a.length ? (Math.max.apply(null, a) - Math.min.apply(null, a)) : 0; }
    function sumPx(a) { return a.reduce(function (x, y) { return x + y; }, 0); }
    function splitters() { return Array.from(document.querySelectorAll('#gridSplitterLayer .grid-splitter')); }
    function splitterKeys() {
        var o = {};
        splitters().forEach(function (h) { o[h.dataset.axis + ':' + h.dataset.index] = 1; });
        return Object.keys(o).sort();
    }
    function trackText(a) { return '[' + a.map(function (v) { return Math.round(v); }).join(', ') + ']'; }
    async function dragSplitter(h, dx, dy) {
        var r = h.getBoundingClientRect();
        var x = r.left + r.width / 2, y = r.top + r.height / 2;
        h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
        var steps = 5, i;
        for (i = 1; i <= steps; i++) {
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + dx * i / steps, clientY: y + dy * i / steps }));
            await wait(30);
        }
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + dx, clientY: y + dy }));
        await wait(250);
    }
    /* 本物のマウスに近いダブルクリック: 毎回その座標にある要素へ送る（つまみが作り直されていれば別の要素になる）。
       ネイティブの dblclick は2回とも同じ要素のときだけ、その要素へ送る（違えば発火させない）。 */
    async function realDblClick(x, y) {
        var targets = [], i;
        for (i = 0; i < 2; i++) {
            var el = document.elementFromPoint(x, y);
            targets.push(el);
            if (!el) break;
            var o = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail: i + 1 };
            el.dispatchEvent(new MouseEvent('mousedown', o));
            el.dispatchEvent(new MouseEvent('mouseup', o));
            document.dispatchEvent(new MouseEvent('mouseup', o));
            el.dispatchEvent(new MouseEvent('click', o));
            await wait(60);
        }
        if (targets[0] && targets[0] === targets[1] && targets[0].isConnected) {
            targets[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y, detail: 2 }));
        }
        await wait(400);
        return targets[0] === targets[1] ? '同じ要素' : '別の要素（作り直された）';
    }
    function handleCenter(axis, idx) {
        var h = splitters().filter(function (q) { return q.dataset.axis === axis && q.dataset.index === String(idx); })[0];
        if (!h) return null;
        var r = h.getBoundingClientRect();
        /* 縦と横のつまみが交わる点を避ける（重なった側が拾う） */
        return axis === 'cols' ? { x: r.left + r.width / 2, y: r.top + r.height * 0.25 } : { x: r.left + r.width * 0.25, y: r.top + r.height / 2 };
    }
    function resetBtnShown() {
        var b = document.getElementById('topGridResetBtn');
        return !!(b && b.style.display !== 'none' && b.getBoundingClientRect().width > 0);
    }
    function savedRatios() {
        try { return JSON.parse(localStorage.getItem('sync_grid_ratios') || '{}') || {}; } catch (e) { return {}; }
    }
    async function testS1() {
        log('  [目的] 境界線をドラッグすると隣り合う2本だけが変わり、構成ごとに覚え、order と保存URLは動かないこと。');
        log('  ⚠️ 合成イベントでドラッグする。測定中はマウスを動かさないでください。');
        var started = cardCount();
        var sel = layoutColsEl();
        var wasCols = sel ? sel.value : null;
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        var ratiosRaw = null;
        try { ratiosRaw = localStorage.getItem('sync_grid_ratios'); } catch (e) { }
        var N = 4, N2 = 6, D = 60;
        try {
            await closeAllMenus();
            await stopAllIfPlaying();
            await clearPins();
            /* 前に保存した比を外して均等から始める（終了時に元の値へ戻す） */
            try { localStorage.removeItem('sync_grid_ratios'); } catch (e) { }
            loadGridRatios();
            var okCols = await setLayoutCols('auto');
            pc('「グリッド列数」を自動にできた（元の設定 = ' + (wasCols === null ? '(欄が無い)' : wasCols) + '）',
                function () { return okCols ? '自動' : false; });
            var got = await setCardCount(N);
            pc('枠を' + N + 'つにできた', function () { return got === N ? (got + '枠') : false; });
            await wait(400);

            var c0 = gridTracks('cols'), r0 = gridTracks('rows');
            /* 🔴 positive control: トラックを読めて、始めは均等（つまみの有無やドラッグには依存しない） */
            pc('🔴 列・行のトラックを読める（2列以上 × 2行以上）', function () {
                return (c0.length >= 2 && r0.length >= 2) ? (c0.length + '列×' + r0.length + '行 ' + trackText(c0) + ' / ' + trackText(r0)) : false;
            });
            pc('🔴 始めは均等（差 ≤ 1px）', function () {
                return (c0.length >= 2 && spreadPx(c0) <= 1 && spreadPx(r0) <= 1) ? ('列の差 ' + spreadPx(c0).toFixed(1) + 'px / 行の差 ' + spreadPx(r0).toFixed(1) + 'px') : false;
            });
            var sig0 = (typeof currentGridSig !== 'undefined') ? currentGridSig : null;
            pc('構成の署名を読める', function () { return sig0 ? sig0 : false; });
            if (c0.length < 2 || r0.length < 2 || !sig0) return;

            var orderBefore = orderText();
            var urlBefore = urlSnapText(urlSnapshot());

            /* --- つまみの数と位置 --- */
            expect('つまみの種類 = (列数−1)+(行数−1)', splitterKeys().length, (c0.length - 1) + (r0.length - 1));
            var g = document.getElementById('playersGrid');
            var gr = g.getBoundingClientRect(), gcs = window.getComputedStyle(g);
            var padL = parseFloat(gcs.paddingLeft) || 0, gap = parseFloat(gcs.columnGap) || 0;
            var v0 = splitters().filter(function (h) { return h.dataset.axis === 'cols' && h.dataset.index === '0'; })[0];
            var expX = gr.left + padL + c0[0] + gap / 2;
            var gotX = v0 ? (v0.getBoundingClientRect().left + v0.getBoundingClientRect().width / 2) : NaN;
            expect('縦のつまみ（1本目）が1列目と2列目の隙間の上にある（±2px）',
                Math.abs(gotX - expX) <= 2 ? 'ok' : ('つまみ ' + Math.round(gotX) + ' / 隙間 ' + Math.round(expX)), 'ok');
            if (!v0) return;

            /* --- 列のドラッグ --- */
            var card0 = gridCards().filter(function (c) {
                var r = c.getBoundingClientRect(); return Math.abs(r.left - (gr.left + padL)) <= 2;
            })[0];
            var w0 = card0 ? card0.getBoundingClientRect().width : 0;
            await dragSplitter(v0, D, 0);
            var c1 = gridTracks('cols');
            note('列のドラッグ +' + D + 'px', trackText(c0) + ' → ' + trackText(c1));
            expect('1列目が +' + D + 'px（±2px）', Math.abs((c1[0] - c0[0]) - D) <= 2 ? 'ok' : (Math.round(c1[0] - c0[0]) + 'px'), 'ok');
            expect('2列目が −' + D + 'px（±2px）', Math.abs((c0[1] - c1[1]) - D) <= 2 ? 'ok' : (Math.round(c1[1] - c0[1]) + 'px'), 'ok');
            var othersSame = c0.every(function (v, i) { return i < 2 || Math.abs(c1[i] - v) <= 1; });
            expect('3列目以降は変わらない（±1px）', othersSame ? 'ok' : trackText(c1), 'ok');
            expect('列の合計は変わらない（±1px）', Math.abs(sumPx(c1) - sumPx(c0)) <= 1 ? 'ok' : (Math.round(sumPx(c0)) + ' → ' + Math.round(sumPx(c1))), 'ok');
            /* 鉄則 #38: 値だけでなく見た目（枠の矩形）が変わったこと */
            var w1 = card0 ? card0.getBoundingClientRect().width : 0;
            expect('🔴 左端の枠の幅が実際に +' + D + 'px（±3px）', (card0 && Math.abs((w1 - w0) - D) <= 3) ? 'ok' : (Math.round(w0) + ' → ' + Math.round(w1)), 'ok');
            var v0b = splitters().filter(function (h) { return h.dataset.axis === 'cols' && h.dataset.index === '0'; })[0];
            var gotX2 = v0b ? (v0b.getBoundingClientRect().left + v0b.getBoundingClientRect().width / 2) : NaN;
            expect('つまみも +' + D + 'px 動いた（±2px）', Math.abs((gotX2 - gotX) - D) <= 2 ? 'ok' : (Math.round(gotX2 - gotX) + 'px'), 'ok');
            var sv = savedRatios()[sig0];
            expect('比が署名「' + sig0 + '」で保存された（列数ぶん）', (sv && sv.cols && sv.cols.length === c0.length) ? 'ok' : JSON.stringify(sv || null), 'ok');

            /* --- 行のドラッグ --- */
            var h0 = splitters().filter(function (h) { return h.dataset.axis === 'rows' && h.dataset.index === '0'; })[0];
            if (h0) {
                await dragSplitter(h0, 0, -40);
                var r1 = gridTracks('rows');
                note('行のドラッグ −40px', trackText(r0) + ' → ' + trackText(r1));
                expect('1行目が −40px（±2px）', Math.abs((r0[0] - r1[0]) - 40) <= 2 ? 'ok' : (Math.round(r1[0] - r0[0]) + 'px'), 'ok');
                expect('行の合計は変わらない（±1px）', Math.abs(sumPx(r1) - sumPx(r0)) <= 1 ? 'ok' : 'ずれた', 'ok');
                expect('列の比は行のドラッグで変わらない（±1px）', c1.every(function (v, i) { return Math.abs(gridTracks('cols')[i] - v) <= 1; }) ? 'ok' : trackText(gridTracks('cols')), 'ok');
            } else {
                expect('横のつまみ（1本目）がある', '(無い)', 'ある');
            }
            var cKeep = gridTracks('cols'), rKeep = gridTracks('rows');

            /* --- 最小幅で止まる --- */
            var v0c = splitters().filter(function (h) { return h.dataset.axis === 'cols' && h.dataset.index === '0'; })[0];
            await dragSplitter(v0c, -5000, 0);
            var cMin = gridTracks('cols');
            expect('左へ振り切っても1列目は 80px で止まる（±2px）', Math.abs(cMin[0] - 80) <= 2 ? 'ok' : (Math.round(cMin[0]) + 'px'), 'ok');
            /* 戻す（以降の比較は cKeep を基準にする） */
            var v0d = splitters().filter(function (h) { return h.dataset.axis === 'cols' && h.dataset.index === '0'; })[0];
            await dragSplitter(v0d, cKeep[0] - cMin[0], 0);
            cKeep = gridTracks('cols');

            /* --- 🔴 order と保存URL --- */
            expect('🔴 order が変わっていない', orderText(), orderBefore);
            expect('🔴 保存URLが変わっていない', urlSnapText(urlSnapshot()), urlBefore);

            /* --- 別の構成は均等、戻ると覚えた比 --- */
            var got2 = await setCardCount(N2);
            await wait(400);
            var c2 = gridTracks('cols');
            var sig2 = currentGridSig;
            note('枠を' + N2 + 'つにした構成', got2 + '枠 / ' + sig2 + ' / ' + trackText(c2));
            expect('別の構成（署名が違う）', sig2 !== sig0 ? 'ok' : ('同じ署名 ' + sig2), 'ok');
            expect('別の構成の列は均等（差 ≤ 1px）', spreadPx(c2) <= 1 ? 'ok' : trackText(c2), 'ok');
            await setCardCount(N);
            await wait(400);
            var c3 = gridTracks('cols'), r3 = gridTracks('rows');
            expect('元の構成へ戻すと覚えた列の比に戻る（±2px）', c3.every(function (v, i) { return Math.abs(v - cKeep[i]) <= 2; }) ? 'ok' : (trackText(cKeep) + ' / ' + trackText(c3)), 'ok');
            expect('元の構成へ戻すと覚えた行の比に戻る（±2px）', r3.every(function (v, i) { return Math.abs(v - rKeep[i]) <= 2; }) ? 'ok' : (trackText(rKeep) + ' / ' + trackText(r3)), 'ok');

            /* --- ピン留めは別の署名・ピン枠の上につまみを出さない --- */
            var cards = gridCards();
            var pin = await pinCardId(cards[0].id);
            await wait(400);
            if (pin.ok) {
                var sigP = currentGridSig;
                expect('ピン中は別の署名（:pin）', /:pin$/.test(String(sigP)) ? 'ok' : String(sigP), 'ok');
                expect('ピン中の列は均等（差 ≤ 1px）', spreadPx(gridTracks('cols')) <= 1 ? 'ok' : trackText(gridTracks('cols')), 'ok');
                var pr = document.querySelector('#playersGrid .player-card.is-main').getBoundingClientRect();
                var inside = splitters().filter(function (h) {
                    var r = h.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                    return cx > pr.left + 2 && cx < pr.right - 2 && cy > pr.top + 2 && cy < pr.bottom - 2;
                });
                expect('ピン枠の上につまみが無い', inside.length, 0);
                await clearPins();
                await wait(400);
                expect('ピンを外すと覚えた列の比に戻る（±2px）', gridTracks('cols').every(function (v, i) { return Math.abs(v - cKeep[i]) <= 2; }) ? 'ok' : trackText(gridTracks('cols')), 'ok');
            } else {
                note('ピン留めの判定', '📌 を押せなかったので飛ばした（' + (pin.click && pin.click.reason) + '）');
            }

            /* --- ⊞（均等に戻す）ボタンの出し入れ --- */
            expect('比を変えた構成では上部の ⊞ が出ている', resetBtnShown(), true);
            /* --- ダブルクリックで均等へ（★v1.13.1: 本物のマウスと同じく、毎回その座標の要素へ送る） --- */
            var pt = handleCenter('cols', 0);
            var how = pt ? await realDblClick(pt.x, pt.y) : '(つまみが無い)';
            note('ダブルクリックの2回のクリックが当たった要素', how);
            expect('ダブルクリックで列が均等に戻る（差 ≤ 1px）', spreadPx(gridTracks('cols')) <= 1 ? 'ok' : trackText(gridTracks('cols')), 'ok');
            expect('ダブルクリックで行も均等に戻る（差 ≤ 1px）', spreadPx(gridTracks('rows')) <= 1 ? 'ok' : trackText(gridTracks('rows')), 'ok');
            expect('ダブルクリックでその構成の保存値が消える', savedRatios()[sig0] ? '残っている' : '消えた', '消えた');
            expect('均等に戻すと上部の ⊞ が隠れる', resetBtnShown(), false);
            /* ⊞ ボタンでも戻せること */
            var v0f = splitters().filter(function (h) { return h.dataset.axis === 'cols' && h.dataset.index === '0'; })[0];
            if (v0f) await dragSplitter(v0f, D, 0);
            var rb = document.getElementById('topGridResetBtn');
            var rbClick = rb ? await clickReal(rb) : { blocked: true, reason: 'button-null' };
            await wait(400);
            expect('⊞ を押せた（被覆なし）', rbClick.blocked ? rbClick.reason : 'ok', 'ok');
            expect('⊞ で列が均等に戻る（差 ≤ 1px）', spreadPx(gridTracks('cols')) <= 1 ? 'ok' : trackText(gridTracks('cols')), 'ok');
            expect('🔴 最後まで order が変わっていない', orderText(), orderBefore);
        } finally {
            try { await clearPins(); } catch (e) { }
            try { if (ratiosRaw === null) localStorage.removeItem('sync_grid_ratios'); else localStorage.setItem('sync_grid_ratios', ratiosRaw); } catch (e) { }
            try { loadGridRatios(); } catch (e) { }
            try { await setCardCount(started); } catch (e) { }
            if (wasCols !== null) { try { await setLayoutCols(wasCols); } catch (e) { } }
            var restored = restoreUrlSnapshot(backup);
            note('後始末: 枠数・列数設定・枠の比・保存URLの復元', cardCount() + '枠 / ' + (sel ? sel.value : '-') + ' / '
                + (restored === backupText ? '保存URLは元どおり' : '⚠ 保存URLに差分あり'));
        }
    }

    /* --- D-S2: 再読み込みしても変えた比が残る ----------------------------------
       ★v1.13.1: 実機で「読み込み直したら均等に戻っていた」と報告された（2026-10-02）。headless Chromium では再現しない。
       D-M7 と同じく LS_RESUME（phase='after-reload' / which='S2'）で再読み込みをまたぐ。
       失敗したとき原因を絞れるよう、保存値・メモリ上の値・署名・枠数を全部記録する。 */
    async function testS2() {
        log('  [目的] 境界線で変えた比が、ページの再読み込み後も残ること。');
        var sel = layoutColsEl();
        var wasCols = sel ? sel.value : null;
        var started = cardCount();
        var ratiosRaw = null;
        try { ratiosRaw = localStorage.getItem('sync_grid_ratios'); } catch (e) { }
        await closeAllMenus();
        await stopAllIfPlaying();
        await clearPins();
        var okCols = await setLayoutCols('auto');
        pc('「グリッド列数」を自動にできた（元の設定 = ' + (wasCols === null ? '(欄が無い)' : wasCols) + '）', function () { return okCols ? '自動' : false; });
        var got = await setCardCount(4);
        pc('枠を4つにできた', function () { return got === 4 ? '4枠' : false; });
        await wait(400);
        var sig = currentGridSig;
        /* 前に保存した比があっても、このテストの構成は均等から始める。
           🔴 ★v1.13.2: 基準の c0 は均等へ戻した「後」に読む。v1.13.1 は戻す前に読んだため、
              利用者が比を変えていた実機で PC が不成立（判定不能）になった（2026-10-02）。 */
        if (typeof resetGridRatios === 'function') resetGridRatios(sig);
        await wait(300);
        var c0 = gridTracks('cols');
        pc('🔴 列のトラックを読める（2列以上・均等）', function () {
            return (c0.length >= 2 && spreadPx(c0) <= 1) ? trackText(c0) + ' / ' + sig : false;
        });
        if (c0.length < 2) return;
        var v = splitters().filter(function (h) { return h.dataset.axis === 'cols' && h.dataset.index === '0'; })[0];
        if (v) await dragSplitter(v, 70, 0);
        var c1 = gridTracks('cols');
        pc('🔴 再読み込み前にドラッグが効いた（1列目が +70px ±2px）', function () {
            return (c1.length && Math.abs((c1[0] - c0[0]) - 70) <= 2) ? (trackText(c0) + ' → ' + trackText(c1)) : false;
        });
        var savedBefore = null;
        try { savedBefore = localStorage.getItem('sync_grid_ratios'); } catch (e) { }
        note('再読み込み前の 署名 / 枠数 / 保存値', sig + ' / ' + cardCount() + '枠 / ' + savedBefore);
        var payload = {
            v: DEBUG_SUITE_VERSION, at: Date.now(), phase: 'after-reload', which: 'S2',
            fromAll: runningAll, remaining: allQueue.slice(), logLines: logLines.slice(), report: report,
            s2: { sig: sig, cols: c1, count: cardCount(), wasCols: wasCols, started: started, ratiosRaw: ratiosRaw, savedBefore: savedBefore }
        };
        try { localStorage.setItem(LS_RESUME, JSON.stringify(payload)); } catch (e) { }
        log('  [待機] 再読み込み前に 500ms 待つ');
        await wait(500);
        log('  [操作] location.reload() ─ 読み込み後に自動で続きを実行します');
        location.reload();
        await wait(30000);
    }
    async function resumeS2(payload) {
        report = Array.isArray(payload.report) ? payload.report : [];
        report.forEach(fixRecord);
        if (report.length === 0) report.push(mkRecord('D-S2', '★再読み込みしても変えた枠の比が残る'));
        current = fixRecord(report[report.length - 1]);
        logLines = (payload.logLines || []).slice();
        if (logEl) logEl.textContent = logLines.join('\n');
        log('  === 再読み込み後（自動継続） ===');
        var d = payload.s2 || {};
        await wait(800);
        var c2 = gridTracks('cols');
        var savedAfter = null;
        try { savedAfter = localStorage.getItem('sync_grid_ratios'); } catch (e) { }
        var mem = (typeof gridRatios !== 'undefined') ? JSON.stringify(gridRatios) : '(読めない)';
        note('再読み込み後の 署名 / 枠数 / 列', currentGridSig + ' / ' + cardCount() + '枠 / ' + trackText(c2));
        note('再読み込み後の 保存値 / メモリ上の値', savedAfter + ' / ' + mem);
        note('グリッドの style.gridTemplateColumns', document.getElementById('playersGrid').style.gridTemplateColumns);
        pc('再読み込み後も枠数が同じ', function () { return cardCount() === d.count ? (d.count + '枠') : false; });
        expect('構成の署名が再読み込み前と同じ', String(currentGridSig), String(d.sig));
        expect('保存値が再読み込みで消えていない', savedAfter === d.savedBefore ? 'ok' : '変わった', 'ok');
        expect('🔴 列の比が再読み込み前と同じ（±2px）',
            (c2.length === (d.cols || []).length && c2.every(function (x, i) { return Math.abs(x - d.cols[i]) <= 2; })) ? 'ok' : (trackText(d.cols || []) + ' → ' + trackText(c2)), 'ok');
        expect('再読み込み後も上部の ⊞ が出ている', resetBtnShown(), true);
        /* 後始末 */
        try { if (d.ratiosRaw === null || d.ratiosRaw === undefined) localStorage.removeItem('sync_grid_ratios'); else localStorage.setItem('sync_grid_ratios', d.ratiosRaw); } catch (e) { }
        try { loadGridRatios(); } catch (e) { }
        try { await setCardCount(d.started); } catch (e) { }
        if (d.wasCols !== null && d.wasCols !== undefined) { try { await setLayoutCols(d.wasCols); } catch (e) { } }
        note('後始末: 枠数 / 列数設定 / 枠の比', cardCount() + '枠 / ' + (layoutColsEl() ? layoutColsEl().value : '-') + ' / 元へ戻した');
        try { localStorage.removeItem(LS_RESUME); } catch (e) { }
        finishTest(current);
        openDebugMenu();
    }

    /* --- D-Z2: ローカル動画の履歴を押すと「ファイルを選択」と同じ選択画面が開く ------
       ★v1.13.2。選択画面を本当に開くと測定が止まるので、file input の click を捕まえて preventDefault で止める
       （click イベントを止めれば選択画面は開かない）。履歴は一時的に1件足し、終了時に元へ戻す。 */
    async function testZ2() {
        log('  [目的] ローカル動画の履歴を押すと、警告を出さずにそのままファイルの選択画面が開くこと。');
        var started = cardCount();
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        var histRaw = null;
        try { histRaw = localStorage.getItem('sync_video_history'); } catch (e) { }
        var origAlert = window.alert;
        var alerts = 0;
        try {
            await closeAllMenus();
            var hist = [];
            try { hist = JSON.parse(histRaw || '[]') || []; } catch (e) { hist = []; }
            hist.unshift({ title: 'dbg_local.mp4', url: 'localVideo_dbg', thumbnail: '', isLocal: true, timestamp: Date.now() });
            localStorage.setItem('sync_video_history', JSON.stringify(hist));
            var got = await setCardCount(started + 1);
            pc('枠を1つ足せた', function () { return got === started + 1 ? (got + '枠') : false; });
            var cid = lastCard();
            if (typeof clearCard === 'function') await clearCard(cid);
            restorePlaceholderDefault(cid);
            await wait(200);
            var input = document.getElementById('localFile_' + cid);
            var tile = document.querySelector('#playerContainer_' + cid + ' .history-tile.local');
            pc('空枠に「ファイルを選択」と、ローカル動画の履歴がある', function () {
                return (input && tile) ? describe(input) + ' / ' + describe(tile) : false;
            });
            if (!input || !tile) return;
            var opened = 0;
            var stopper = function (e) { opened++; e.preventDefault(); };
            input.addEventListener('click', stopper, true);
            /* 🔴 positive control: 捕まえ方が効いている（直接 click() すると数えられ、選択画面は開かない） */
            input.click();
            pc('🔴 file input の click を捕まえられる（直接押すと 1 回数えられる）', function () { return opened === 1 ? '1回' : false; });
            opened = 0;
            window.alert = function () { alerts++; };
            tile.click();
            await wait(100);
            window.alert = origAlert;
            input.removeEventListener('click', stopper, true);
            expect('🔴 履歴を押すと file input が押される（選択画面が開く）', opened, 1);
            expect('警告（alert）は出ない', alerts, 0);
            expect('履歴にファイル名のヒントが出る（title）', /dbg_local\.mp4/.test(tile.title) ? 'ok' : tile.title, 'ok');
        } finally {
            window.alert = origAlert;
            try { if (histRaw === null) localStorage.removeItem('sync_video_history'); else localStorage.setItem('sync_video_history', histRaw); } catch (e) { }
            try { await setCardCount(started); } catch (e) { }
            var restored = restoreUrlSnapshot(backup);
            note('後始末: 枠数・履歴・保存URLの復元', cardCount() + '枠 / ' + (restored === backupText ? '保存URLは元どおり' : '⚠ 差分あり'));
        }
    }

    /* ======================================================================
       ★v1.14.0 : v2.8.12 の判定（上部メニューの縮小と出し入れ）
       ==================================================================== */
    function topBarEl() { return document.querySelector('.top-bar'); }
    function mainViewEl() { return document.getElementById('mainView'); }
    function topbarShown() {
        var r = rect(topBarEl());
        return !!(r && r.bottom > 2 && r.top > -2);
    }
    async function moveMouseTo(y) {
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Math.round(window.innerWidth / 3), clientY: y }));
    }
    async function setTopbarTriggerUI(v) {
        var sel = document.getElementById('topbarTrigger');
        if (!sel) return false;
        sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(100);
        return sel.value === v;
    }

    /* --- D-T1: ▲ で畳む・上端で出る（レイアウトは動かない）・メニュー中は隠さない・📌 で戻す --- */
    async function testT1() {
        log('  [目的] 上部メニューを畳むとグリッドが広がり、出すときはグリッドの上に重なるだけで動かないこと。');
        log('  ⚠️ 合成の mousemove で上端に寄せます。測定中はマウスを動かさないでください。');
        var wasCollapsed = (typeof topbarCollapsed !== 'undefined') ? topbarCollapsed : false;
        var wasTrigger = (typeof topbarTrigger !== 'undefined') ? topbarTrigger : 'hover';
        var bar = topBarEl(), mv = mainViewEl();
        var btn = document.getElementById('topbarCollapseBtn');
        var tab = document.getElementById('topbarTab');
        var sel = document.getElementById('topbarTrigger');
        pc('トップバー・▲ ボタン・▼ タブ・出し方の欄がある', function () {
            return (bar && mv && btn && tab && sel) ? describe(btn) + ' / ' + describe(tab) + ' / ' + describe(sel) : false;
        });
        if (!bar || !mv || !btn || !tab || !sel) return;
        /* ★v1.14.2: 「クリックのみにしても近づけると開く」（2026-10-02 実機・headless で再現せず）の切り分け用。
           保存値・本体の変数・欄の表示が食い違っていないかを残す */
        note('開始時の 畳んだ状態 / 出し方（変数 / 欄 / 保存値）', String(wasCollapsed) + ' / ' + wasTrigger + ' / ' + sel.value + ' / '
            + localStorage.getItem('sync_topbar_trigger'));
        try {
            await closeAllMenus();
            if (wasCollapsed) { toggleTopbarCollapsed(); await wait(300); }
            await setTopbarTriggerUI('hover');
            /* 実ポインタがバーの上に残っている扱いを外す（測定中はマウスを動かさない前提） */
            bar.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
            var b0 = rect(bar), m0 = rect(mv);
            /* 🔴 PC: 測り方の確認（畳む前はバーが流れの中にあり、#mainView はバーのすぐ下から始まる） */
            pc('🔴 畳む前: バーの高さ > 0 で、#mainView の上端がバーの下端と一致（±1px）', function () {
                return (b0.height > 0 && Math.abs(m0.top - b0.bottom) <= 1) ? ('バー ' + b0.top + '→' + b0.bottom + ' / mainView.top ' + m0.top) : false;
            });
            var barH = b0.height;

            /* --- ▲ で畳む --- */
            var c1 = await clickReal(btn);
            expect('▲ を押せた（被覆なし）', c1.blocked ? c1.reason : 'ok', 'ok');
            await wait(400);
            var m1 = rect(mv);
            expect('畳むとバーが画面の上へ隠れる', topbarShown(), false);
            expect('🔴 畳むと #mainView の上端がバーの高さぶん上がる（±1px）', Math.abs((m0.top - m1.top) - barH) <= 1 ? 'ok' : (m0.top + ' → ' + m1.top), 'ok');
            expect('畳むと ▼ タブが見える', rect(tab).height > 0, true);
            expect('畳んだ状態が保存される', localStorage.getItem('sync_topbar_collapsed'), 'true');
            /* 🔴 畳んで露出した上端（バーがあった 0〜35px）が、隠れたパネルに吸われず枠に届く */
            var hitTop = document.elementFromPoint(Math.round(window.innerWidth / 4), Math.round(barH / 2));
            expect('🔴 畳んだ後の上端（y=' + Math.round(barH / 2) + '）を押すと枠に届く',
                (hitTop && mv.contains(hitTop)) ? 'ok' : describe(hitTop), 'ok');
            /* 🔴 ★v1.14.1: 見えている「残骸」は当たり判定（elementFromPoint）では捕まらない（pointer-events:none は素通りする）。
               閉じたパネルの矩形そのもので、画面内に残っていないことを確かめる（2026-10-02 実機で設定パネルの下端が残った）。 */
            var leftovers = Array.prototype.slice.call(document.querySelectorAll('.settings-container:not(.open), .topmenu-dropdown:not(.open)'))
                .map(function (el) { var r = el.getBoundingClientRect(); return { el: el, r: r }; })
                .filter(function (x) { return x.r.width > 0 && x.r.height > 0 && x.r.bottom > 0.5 && x.r.top < window.innerHeight; })
                .map(function (x) { return describe(x.el) + '(下端 ' + Math.round(x.r.bottom) + ')'; });
            expect('🔴 畳んだ後、閉じたパネルが画面内に残っていない（矩形で判定）', leftovers.length ? leftovers.join(', ') : 'なし', 'なし');

            /* --- hover: 上端で出る・レイアウトは動かない --- */
            await moveMouseTo(2);
            await wait(400);
            var m2 = rect(mv);
            expect('hover: 上端に寄せるとバーが出る', topbarShown(), true);
            expect('🔴 出してもレイアウトは動かない（#mainView の矩形 ±1px）',
                (Math.abs(m2.top - m1.top) <= 1 && Math.abs(m2.height - m1.height) <= 1) ? 'ok' : (JSON.stringify(m1) + ' → ' + JSON.stringify(m2)), 'ok');
            await moveMouseTo(Math.round(window.innerHeight / 2));
            await wait(900);   /* ★v1.14.3: 0.6秒＋隠れる動き0.2秒。1秒の旧設定ならここで落ちる */
            expect('hover: 離れて約0.6秒で隠れる（0.9秒後に隠れている）', topbarShown(), false);
            /* ★v1.14.1: 速く上へ抜けると帯の中で mousemove が来ない。ページの上辺から外へ出たことでも出る */
            document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, clientX: Math.round(window.innerWidth / 3), clientY: 30, relatedTarget: null }));
            await wait(400);
            expect('hover: 上辺からページの外へ抜けても出る（mousemove が帯に来なくても）', topbarShown(), true);
            /* ★v1.14.2: バーから YouTube の枠（iframe）へ直接下ろすと mousemove が来ない。
               mousemove を送らず、バーの mouseleave だけで約1秒後に隠れること */
            bar.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
            bar.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
            await wait(900);
            expect('🔴 hover: バーから枠（iframe）へ下ろしても約0.6秒で隠れる（mousemove なし・mouseleave だけ）', topbarShown(), false);
            /* ★v1.14.2: Firefox は iframe へ入るときも relatedTarget なしの mouseout を出す。それで出してはいけない */
            var fakeFrame = document.createElement('iframe');
            fakeFrame.style.cssText = 'position:fixed; left:40%; top:6px; width:200px; height:120px; border:0; z-index:300; background:#222;';
            document.body.appendChild(fakeFrame);
            await wait(150);
            var fr = fakeFrame.getBoundingClientRect();
            var hitFr = document.elementFromPoint(fr.left + 20, fr.top + 10);
            pc('ダミーの iframe を上端付近に置けた（elementFromPoint が iframe を返す）', function () {
                return (hitFr === fakeFrame) ? describe(hitFr) : false;
            });
            document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, clientX: fr.left + 20, clientY: fr.top + 10, relatedTarget: null }));
            await wait(400);
            expect('🔴 hover: 上端付近の枠（iframe）へ入っただけでは出ない', topbarShown(), false);
            fakeFrame.remove();
            await moveMouseTo(Math.round(window.innerHeight / 2));
            await wait(1400);

            /* --- メニューを開いている間は隠さない --- */
            await moveMouseTo(2);
            await wait(400);
            var cb = document.getElementById('topCommentBtn');
            var c2 = cb ? await clickReal(cb) : { blocked: true, reason: 'button-null' };
            await wait(200);
            note('💬 を押したときの当たり判定', c2.blocked ? (c2.reason + ' / ' + c2.hit) : 'ok');
            var menuOpen = !!document.querySelector('#commentMenu.open');
            expect('出したバーの 💬 を押してメニューを開けた', menuOpen, true);
            await moveMouseTo(Math.round(window.innerHeight / 2));
            await wait(1400);
            expect('🔴 メニューを開いている間は、離れても隠れない', topbarShown(), true);
            await closeAllMenus();
            await moveMouseTo(Math.round(window.innerHeight / 2));
            await wait(1400);
            expect('メニューを閉じて離れると隠れる', topbarShown(), false);

            /* --- click: 上端では出ず、▼ で出し入れ --- */
            await setTopbarTriggerUI('click');
            expect('出し方の設定が保存される', localStorage.getItem('sync_topbar_trigger'), 'click');
            await moveMouseTo(2);
            await wait(400);
            expect('click: 上端に寄せても出ない', topbarShown(), false);
            var c3 = await clickReal(tab);
            await wait(400);
            expect('click: ▼ を押すと出る', topbarShown(), true);
            expect('出している間のタブは「▲ 隠す」', String(tab.textContent).trim(), '▲ 隠す');
            await moveMouseTo(Math.round(window.innerHeight / 2));
            await wait(1400);
            expect('click: 離れても勝手に隠れない', topbarShown(), true);
            var c4 = await clickReal(tab);
            await wait(400);
            expect('click: ▲ 隠す で隠れる', topbarShown(), false);
            expect('▼ / ▲ のタブを押せた（被覆なし）', (c3.blocked ? c3.reason : 'ok') + ' / ' + (c4.blocked ? c4.reason : 'ok'), 'ok / ok');

            /* --- 📌 で固定に戻す --- */
            await clickReal(tab);
            await wait(400);
            expect('畳んでいる間のボタンは 📌', String(btn.textContent).trim(), '📌');
            var c5 = await clickReal(btn);
            await wait(400);
            var b5 = rect(bar), m5 = rect(mv);
            expect('📌 を押せた（被覆なし）', c5.blocked ? c5.reason : 'ok', 'ok');
            expect('🔴 📌 で戻すとバーが流れに戻り、#mainView がバーの下から始まる（±1px）',
                (Math.abs(m5.top - b5.bottom) <= 1 && Math.abs(m5.top - m0.top) <= 1) ? 'ok' : ('バー下端 ' + b5.bottom + ' / mainView.top ' + m5.top), 'ok');
            expect('戻すと ▼ タブは隠れる', rect(tab).height, 0);
            expect('戻した状態が保存される', localStorage.getItem('sync_topbar_collapsed'), 'false');
        } finally {
            try { await closeAllMenus(); } catch (e) { }
            try { setTopbarTrigger(wasTrigger); } catch (e) { }
            try { if (topbarCollapsed !== wasCollapsed) toggleTopbarCollapsed(); } catch (e) { }
            await moveMouseTo(Math.round(window.innerHeight / 2));
            await wait(300);
            note('後始末: 畳んだ状態 / 出し方', String(topbarCollapsed) + ' / ' + topbarTrigger);
        }
    }

    /* --- D-T2: 今の窓幅でトップバーの部品が重ならず、はみ出さない ------------------- */
    async function testT2() {
        log('  [目的] 縮小した上部メニューの部品が、今の窓幅で重ならずバーに収まること。');
        await closeAllMenus();
        var bar = topBarEl();
        var br = rect(bar);
        var kids = bar ? Array.prototype.slice.call(bar.children).map(function (c) {
            var r = c.getBoundingClientRect();
            return { el: c, name: (c.id || c.className || c.tagName), l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width };
        }).filter(function (k) { return k.w > 0; }) : [];
        pc('トップバーの部品を読める（5個以上・高さ > 0）', function () {
            return (br && br.height > 0 && kids.length >= 5) ? (kids.length + '個 / 窓幅 ' + window.innerWidth + 'px') : false;
        });
        if (!br || kids.length < 5) return;
        var overlaps = [];
        for (var i = 0; i < kids.length; i++) for (var j = i + 1; j < kids.length; j++) {
            var ov = Math.min(kids[i].r, kids[j].r) - Math.max(kids[i].l, kids[j].l);
            if (ov > 1) overlaps.push(kids[i].name + '×' + kids[j].name + '(' + Math.round(ov) + 'px)');
        }
        var outside = kids.filter(function (k) { return k.l < br.left - 1 || k.r > br.right + 1; }).map(function (k) { return k.name; });
        var tooTall = kids.filter(function (k) { return k.t < br.top - 1 || k.b > br.bottom + 1; }).map(function (k) { return k.name; });
        expect('部品どうしが横に重ならない', overlaps.length ? overlaps.join(', ') : 'なし', 'なし');
        expect('部品がバーの左右からはみ出さない', outside.length ? outside.join(', ') : 'なし', 'なし');
        expect('部品がバーの上下からはみ出さない（高さ ' + Math.round(br.height) + 'px）', tooTall.length ? tooTall.join(', ') : 'なし', 'なし');
        expect('バーの中で横スクロールが起きていない', bar.scrollWidth <= bar.clientWidth + 1 ? 'ok' : (bar.scrollWidth + ' > ' + bar.clientWidth), 'ok');
        var last = kids[kids.length - 1], gap = 0;
        for (var k = 1; k < kids.length; k++) gap = Math.max(gap, kids[k].l - kids[k - 1].r);
        note('部品の左右（px）', kids.map(function (k) { return k.name + ':' + Math.round(k.l) + '-' + Math.round(k.r); }).join(' / '));
        note('最も広い空き / 右端の部品', Math.round(gap) + 'px / ' + last.name);
    }

    /* ======================================================================
       ★v1.16.0 : v2.9.0 の判定（枠の中の「その他の動画」をその枠で開く）
       ==================================================================== */
    function ytIframeOf(cid) {
        try {
            var p = ytPlayers[cid];
            return (p && typeof p.getIframe === 'function') ? p.getIframe() : null;
        } catch (e) { return null; }
    }
    function ytCardIds() {
        try { return activeCardIds.filter(function (id) { return !!ytPlayers[id]; }); } catch (e) { return []; }
    }
    function vidOfUrl(u) {
        var m = String(u || '').match(/[?&]v=([A-Za-z0-9_-]{11})/);
        return m ? m[1] : null;
    }

    /* --- D-W1: 実機の YouTube 枠で embed の content script が答え、source だけで枠が決まる --- */
    async function testW1() {
        log('  [目的] 枠の中の YouTube でアドオン 2.9.0 の content script が動き、その返事が event.source だけで正しい枠に結び付くこと。');
        var started = cardCount();
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        var added = null;
        try {
            await closeAllMenus();
            /* YouTube の枠が無ければ1枠足して VID_LIGHT を入れる */
            if (ytCardIds().length === 0) {
                var got = await setCardCount(started + 1);
                added = lastCard();
                if (typeof clearCard === 'function') await clearCard(added);
                var inp = document.getElementById('urlInput_' + added);
                if (inp) inp.value = VID_LIGHT;
                try { localStorage.setItem('sync_url_' + added, VID_LIGHT); } catch (e) { }
                loadSingleYT(added, true);
                note('YouTube の枠が無かったので足した', added + '（' + got + '枠）');
            }
            var ids = ytCardIds();
            var iframes = await waitFor(function () {
                var ok = ids.every(function (id) { var f = ytIframeOf(id); return f && /youtube\.com\/embed\//.test(f.src || ''); });
                return ok ? ids.length : null;
            }, 8000, 200);
            pc('YouTube の枠が1つ以上あり、iframe の src が youtube.com/embed/', function () {
                return iframes.ok ? (ids.length + '枠: ' + ids.join(',')) : false;
            });
            if (!iframes.ok) return;
            pc('A側の受け口（pingEmbed / embedHelloLog）を読める', function () {
                return (typeof pingEmbed === 'function' && typeof embedHelloLog !== 'undefined') ? 'あり' : false;
            });
            var rows = [];
            for (var i = 0; i < ids.length; i++) {
                var id = ids[i];
                var nonce = 'w1_' + id + '_' + Date.now();
                /* content script は embed の読み込み途中だと居ないので、1秒ごとに点呼し直す */
                var r = await waitFor(function () {
                    var hit = null;
                    embedHelloLog.forEach(function (h) { if (h.nonce === nonce) hit = h; });
                    if (!hit) pingEmbed(id, nonce);
                    return hit;
                }, 10000, 1000);
                rows.push({ id: id, hit: r.value, ms: r.waitedMs });
            }
            expect('🔴 全枠から返事が来た（アドオン 2.9.0 の content script が embed の中で動いている）',
                rows.filter(function (x) { return x.hit; }).length, ids.length);
            expect('🔴 返事が event.source だけで送り主の枠に決まった',
                rows.filter(function (x) { return x.hit && x.hit.how === 'source' && x.hit.cardId === x.id; }).length, ids.length);
            note('枠ごとの返事', rows.map(function (x) {
                return x.id + '=' + (x.hit ? (x.hit.how + '→' + x.hit.cardId + ' / v' + x.hit.version + ' / ' + x.ms + 'ms') : '返事なし');
            }).join(' | '));
        } finally {
            if (added) {
                try { await setCardCount(started); } catch (e) { }
                var restored = restoreUrlSnapshot(backup);
                note('後始末: 枠数・保存URL', cardCount() + '枠 / ' + (restored === backupText ? '保存URLは元どおり' : '⚠ 差分あり'));
            }
        }
    }

    /* --- D-W2: A側の受け口（オリジン・枠の特定・読み込み・自動再生しない） --- */
    async function testW2() {
        log('  [目的] embed から届いた「その他の動画」を、送り主の枠にだけ読み込み、オリジン違いは捨て、自動では再生しないこと。');
        var started = cardCount();
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        var histRaw = null;
        try { histRaw = localStorage.getItem('sync_video_history'); } catch (e) { }
        var ifr = null, listener = null, cid = null;
        try {
            await closeAllMenus();
            var got = await setCardCount(started + 1);
            pc('枠を1つ足せた', function () { return got === started + 1 ? (got + '枠') : false; });
            cid = lastCard();
            if (typeof clearCard === 'function') await clearCard(cid);
            pc('A側の受け口（handleEmbedMessage / lastEmbedEvent）を読める', function () {
                return (typeof handleEmbedMessage === 'function' && typeof lastEmbedEvent !== 'undefined') ? 'あり' : false;
            });
            /* 偽の embed: 読み込まれたら HELLO を1回送る（送り主のオリジンはこのページと同じ＝www.youtube.com ではない） */
            var seen = null;
            listener = function (e) { if (e.data && e.data.nonce === 'w2') seen = e; };
            window.addEventListener('message', listener);
            ifr = document.createElement('iframe');
            ifr.style.cssText = 'width:100%;height:100%;border:0;';
            ifr.srcdoc = '<script>parent.postMessage({type:"SYNC_EMBED_HELLO",nonce:"w2"},"*");<\/script>';
            var base = { getIframe: function () { return ifr; } };
            ytPlayers[cid] = new Proxy(base, { get: function (t, k) { return (k in t) ? t[k] : function () { return 0; }; } });
            var otherIds = activeCardIds.filter(function (id) { return id !== cid; });
            var otherText = function () { return otherIds.map(function (id) { return id + '=' + (localStorage.getItem('sync_url_' + id) || ''); }).join(' | '); };
            var otherBefore = otherText();
            var urlBefore = localStorage.getItem('sync_url_' + cid);
            document.getElementById('playerContainer_' + cid).appendChild(ifr);
            await waitFor(function () { return seen; }, 3000, 50);
            await wait(50);
            /* 🔴 positive control: 子の postMessage の event.source が iframe の contentWindow として届く */
            pc('🔴 偽の embed からの postMessage で event.source ＝ iframe の contentWindow', function () {
                return (seen && seen.source === ifr.contentWindow) ? ('一致 / origin=' + seen.origin) : false;
            });
            expect('🔴 オリジン違い（www.youtube.com 以外）は捨てる', lastEmbedEvent && lastEmbedEvent.rejected, 'origin');
            expect('捨てたとき枠の保存URLは変わらない', localStorage.getItem('sync_url_' + cid), urlBefore);

            /* 動画IDの形でないものは読み込まない */
            handleEmbedMessage({ type: 'SYNC_EMBED_OPEN', videoId: '../x', embedHref: '' }, ifr.contentWindow, 'https://www.youtube.com');
            expect('videoId の形でないものは読み込まない', localStorage.getItem('sync_url_' + cid), urlBefore);
            /* 送り主が分からないものは読み込まない */
            handleEmbedMessage({ type: 'SYNC_EMBED_OPEN', videoId: 'zzzzzzzzzzz', embedHref: 'https://www.youtube.com/embed/qqqqqqqqqqq' }, null, 'https://www.youtube.com');
            expect('送り主の枠が分からないときは何もしない（how）', lastEmbedEvent && lastEmbedEvent.how, 'none');
            expect('送り主の枠が分からないときは何もしない（保存URL）', localStorage.getItem('sync_url_' + cid), urlBefore);

            /* 本番: 送り主の枠に VID_LIGHT が入る */
            var vid = vidOfUrl(VID_LIGHT);
            handleEmbedMessage({ type: 'SYNC_EMBED_OPEN', videoId: vid, list: null, title: 'dbg W2', embedHref: 'https://www.youtube.com/embed/AAAAAAAAAAA' },
                ifr.contentWindow, 'https://www.youtube.com');
            expect('🔴 event.source で送り主の枠に決まる', lastEmbedEvent && (lastEmbedEvent.how + '→' + lastEmbedEvent.cardId), 'source→' + cid);
            expect('🔴 その枠の保存URLが新しい動画になる', vidOfUrl(localStorage.getItem('sync_url_' + cid)), vid);
            var otherAfter = otherText();
            expect('🔴 他の枠の保存URLは変わらない', otherAfter === otherBefore ? '不変' : otherAfter, '不変');
            note('他の枠の保存URL（枠ID基準）', otherBefore || '(他の枠なし)');
            var hist = [];
            try { hist = JSON.parse(localStorage.getItem('sync_video_history') || '[]'); } catch (e) { }
            expect('履歴の先頭に見出し付きで残る', hist[0] ? hist[0].title : '(なし)', 'dbg W2');
            var real = await waitFor(function () {
                var f = ytIframeOf(cid);
                return (f && f !== ifr && /youtube\.com\/embed\//.test(f.src || '')) ? f.src : null;
            }, 8000, 200);
            expect('枠に本物の YouTube が作り直された（iframe が embed/' + vid + '）', real.ok && real.value.indexOf('/embed/' + vid) >= 0, true);
            await wait(3000);
            var st = null;
            try { st = ytPlayers[cid].getPlayerState(); } catch (e) { st = '(読めない)'; }
            expect('🔴 自動では再生しない（3秒後に playing(1) でない）', st === 1 ? 'playing' : 'not-playing', 'not-playing');
            note('3秒後の playerState', String(st));
        } finally {
            if (listener) window.removeEventListener('message', listener);
            try { if (histRaw === null) localStorage.removeItem('sync_video_history'); else localStorage.setItem('sync_video_history', histRaw); } catch (e) { }
            try { if (cid && typeof clearCard === 'function') await clearCard(cid); } catch (e) { }
            try { await setCardCount(started); } catch (e) { }
            var restored = restoreUrlSnapshot(backup);
            note('後始末: 枠数・履歴・保存URL', cardCount() + '枠 / ' + (restored === backupText ? '保存URLは元どおり' : '⚠ 差分あり'));
        }
    }

    /* ======================================================================
       ★v1.17.0 : v2.10.0 の判定（チャットの「上位のチャット / すべてのチャット」）
       ==================================================================== */
    function chatModeBtnOf(cid) { return document.getElementById('chatModeBtn_' + cid); }

    /* --- D-K1: A側だけで、キー・要求・切替・保存を確かめる（アドオンへは流さない） --- */
    async function testK1() {
        log('  [目的] 既定は従来どおり videoId のキーで「すべて」を要求し、ボタンで上位にすると #top のキーで mode:top を要求し、前の取得が止まること。');
        var started = cardCount();
        var backup = urlSnapshot();
        var backupText = urlSnapText(backup);
        var modeRaw = null;
        try { modeRaw = localStorage.getItem('sync_chat_mode_map'); } catch (e) { }
        var FAKE = 'dbgK1aaaaaa';
        var origPost = window.postMessage;
        var sent = [];
        var cid = null;
        try {
            await closeAllMenus();
            var got = await setCardCount(started + 1);
            pc('枠を1つ足せた', function () { return got === started + 1 ? (got + '枠') : false; });
            cid = lastCard();
            if (typeof clearCard === 'function') await clearCard(cid);
            pc('A側の関数（getChatKey / setChatMode / chatKeyOf）を読める', function () {
                return (typeof getChatKey === 'function' && typeof setChatMode === 'function' && typeof chatKeyOf === 'function') ? 'あり' : false;
            });
            /* 🔴 取得要求をアドオンへ流さない。CHAT_STREAM_* だけ捕まえて握りつぶす */
            window.postMessage = function (msg, target) {
                if (msg && (msg.type === 'CHAT_STREAM_REQUEST' || msg.type === 'CHAT_STREAM_CANCEL')) { sent.push(msg); return; }
                return origPost.apply(window, arguments);
            };
            cardVideoKeys[cid] = FAKE;   /* 動画を読み込まずに「この枠は FAKE」にする */
            setChatMode(cid, 'all');
            expect('🔴 既定のキーは videoId そのまま（既存のキャッシュ・判定と同じ）', getChatKey(cid), FAKE);
            var pane = await openChatPane(cid);
            var req1 = await waitFor(function () {
                return sent.filter(function (m) { return m.type === 'CHAT_STREAM_REQUEST'; })[0] || null;
            }, 3000, 50);
            pc('チャット欄を開くと取得要求を捕まえられる（1件目）', function () {
                return (pane.ok && req1.ok) ? (req1.value.videoId + ' / mode=' + req1.value.mode) : false;
            });
            if (!req1.ok) return;
            expect('既定の要求: videoId', req1.value.videoId, FAKE);
            expect('既定の要求: mode', req1.value.mode, 'all');
            var btn = chatModeBtnOf(cid);
            expect('見出しに切替ボタンがある（文言「全」）', btn ? btn.textContent : '(無い)', '全');

            sent.length = 0;
            var c1 = await clickReal(btn);
            expect('切替ボタンを押せた（被覆なし）', c1.blocked ? ('blocked:' + c1.reason) : 'ok', 'ok');
            await wait(200);
            expect('上位にした後のキー', getChatKey(cid), FAKE + '#top');
            var reqTop = sent.filter(function (m) { return m.type === 'CHAT_STREAM_REQUEST'; })[0] || null;
            expect('🔴 上位の要求: videoId は素の videoId', reqTop ? reqTop.videoId : '(要求なし)', FAKE);
            expect('🔴 上位の要求: mode', reqTop ? reqTop.mode : '(要求なし)', 'top');
            var cancelled = sent.filter(function (m) { return m.type === 'CHAT_STREAM_CANCEL' && m.requestId === req1.value.requestId; }).length;
            expect('🔴 前のキーの取得を止めた（参照が無くなったので）', cancelled, 1);
            expect('前のキーの取得中フラグが消えた', !!chatInflight[FAKE], false);
            var saved = {};
            try { saved = JSON.parse(localStorage.getItem('sync_chat_mode_map') || '{}'); } catch (e) { }
            expect('枠ごとの設定が保存される（sync_chat_mode_map）', saved[cid], 'top');
            expect('ボタンの文言が「上位」になる', btn.textContent, '上位');
            var title = (document.getElementById('chatHeadTitle_' + cid) || {}).textContent || '';
            expect('見出しに〔上位〕が出る', /〔上位〕/.test(title) ? 'あり' : title, 'あり');

            sent.length = 0;
            await clickReal(btn);
            await wait(200);
            expect('戻した後のキー', getChatKey(cid), FAKE);
            var reqAll = sent.filter(function (m) { return m.type === 'CHAT_STREAM_REQUEST'; })[0] || null;
            expect('戻した後の要求: mode', reqAll ? reqAll.mode : '(要求なし)', 'all');
            saved = {};
            try { saved = JSON.parse(localStorage.getItem('sync_chat_mode_map') || '{}'); } catch (e) { }
            expect('すべてに戻すと保存値から消える（既定は持たない）', saved[cid] === undefined ? '無し' : saved[cid], '無し');
        } finally {
            try {
                if (typeof cancelChatRequest === 'function') { cancelChatRequest(FAKE); cancelChatRequest(FAKE + '#top'); }
            } catch (e) { }
            window.postMessage = origPost;
            try { if (cid && typeof setChatMode === 'function') setChatMode(cid, 'all'); } catch (e) { }
            try { if (cid) delete cardVideoKeys[cid]; } catch (e) { }
            try { await setCardCount(started); } catch (e) { }
            try { if (modeRaw === null) localStorage.removeItem('sync_chat_mode_map'); else localStorage.setItem('sync_chat_mode_map', modeRaw); } catch (e) { }
            var restored = restoreUrlSnapshot(backup);
            note('後始末: 枠数・保存URL', cardCount() + '枠 / ' + (restored === backupText ? '保存URLは元どおり' : '⚠ 差分あり'));
        }
    }

    /* --- D-K2: 実機。すべて → 上位 の順に取り直し、B側が実際に選んだ側を確かめる --- */
    async function testK2() {
        log('  [目的] B側（アドオン 2.10.0）が「すべて」では全件側、「上位」では上位側を選んで返すこと。素材 ' + VID.LIGHT + '（既知 356件）。');
        var cid = null;
        try {
            cid = firstCard();
            if (cid && typeof setChatMode === 'function') setChatMode(cid, 'all');
            var r = await runChatCase({ url: ytUrl(VID.LIGHT), videoId: VID.LIGHT, expectState: 'ready' });
            if (!r || !r.store) return;
            cid = r.cid;
            pc('🔴 すべて: 既知の 356 件と一致（D-C1 と同じ positive control）', function () {
                return r.total === 356 ? '356件' : false;
            });
            expect('🔴 すべて: B側が選んだ表示 view', r.store.view || '(報告なし)', 'all');

            var btn = chatModeBtnOf(cid);
            var c1 = await clickReal(btn);
            expect('切替ボタンを押せた（被覆なし）', c1.blocked ? ('blocked:' + c1.reason) : 'ok', 'ok');
            await wait(300);
            var KEY = VID.LIGHT + '#top';
            /* 🔴 キャッシュが残っていると B側を通らないので 🔄 で取り直す */
            await clickReal(chatReloadBtn(cid));
            var w = await waitChatSettled(KEY, CHAT_WAIT_MS);
            pc('上位: 取得が終端まで到達した', function () {
                return w.ok ? (w.value + ' / ' + Math.round(w.waitedMs / 1000) + '秒') : false;
            });
            var st = chatStoreOf(KEY);
            var nTop = st ? st.comments.length : -1;
            expect('🔴 上位: B側が選んだ表示 view', st ? (st.view || '(報告なし)') : '(storeが無い)', 'top');
            expect('上位: 取得の状態', chatStateOf(KEY), 'ready');
            expect('上位の件数 ≤ すべての件数', (nTop >= 0 && nTop <= r.total) ? 'ok' : (nTop + ' / ' + r.total), 'ok');
            expect('🔴 切り替えた後、すべての側は参照が無いので捨てられた', chatStoreOf(VID.LIGHT) ? '残っている' : '捨てた', '捨てた');
            note('件数（すべて / 上位）', r.total + ' / ' + nTop);
            note('上位: complete / reqs / elapsed(ms)', st ? (st.complete + ' / ' + st.reqs + ' / ' + st.elapsed) : '-');
        } finally {
            try { if (cid && typeof setChatMode === 'function') setChatMode(cid, 'all'); } catch (e) { }
            note('後始末: 枠の表示を「すべて」へ戻した', cid ? getChatMode(cid) : '-');
        }
    }

    var TESTS = [
        { id: 'D-X1', name: '基盤の自己診断（純関数）', run: testX1 },
        { id: 'D-X2', name: '記録UIの自動検証（ask / メモ）', run: testX2 },
        { id: 'D-V1', name: '版数バッジ', run: testV1 },
        /* ★v1.10.0: v2.8.8。準備が要らないので manual にしない。 */
        { id: 'D-V2', name: '★アドオンの版数は ADDON_REQUIRED_VERSION と完全一致で照合する', run: testV2 },
        { id: 'D-U1', name: '一括コントローラーの出し方（ホバー / クリックのみ）', run: testU1 },
        { id: 'D-U2', name: '秒送りボタンに記号と秒数が出て、設定に追従する', run: testU2 },
        /* ★v1.11.0: v2.8.9（音量）。準備が要らないので manual にしない。 */
        { id: 'D-A1', name: '音量ミキサーに全枠の行が並び、枠と対応している', run: testA1 },
        { id: 'D-A2', name: '★マスター音量を動かしても枠ごとの音量が崩れない（実音量＝マスター×枠ごと）', run: testA2 },
        /* ★v1.6.0: v2.8.2（設定の解説と更新履歴）。準備が要らないので manual にしない。 */
        { id: 'D-H1', name: '?マークが11項目に付いている', run: testH1 },
        { id: 'D-H2', name: 'ホバーでツールチップが出る', run: testH2 },
        { id: 'D-H3', name: 'パネルの外へはみ出しても切れない', run: testH3 },
        { id: 'D-H4', name: '画面端で内側へ寄る', run: testH4 },
        { id: 'D-H5', name: 'パネルを閉じたらツールチップも消える', run: testH5 },
        { id: 'D-N1', name: '版数バッジのクリックで更新履歴が開く', run: testN1 },
        { id: 'D-N2', name: '履歴パネルの形（確定値）', run: testN2 },
        { id: 'D-N3', name: '履歴の中身', run: testN3 },
        { id: 'D-N4', name: '履歴の縦スクロール', run: testN4 },
        { id: 'D-N5', name: 'バッジの既存の役割が変わっていない', run: testN5 },
        { id: 'D-N6', name: '全メニューのパネルが画面内に収まる', run: testN6 },
        { id: 'D-R1', name: '既存操作への非干渉（回帰）', run: testR1 },
        { id: 'D-M2', name: 'トップメニューの排他制御（全遷移・6枚）', run: testM2 },
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
        { id: 'D-C3', name: '同一チャンネルの公開アーカイブ（完走）', run: testC3, manual: true },
        { id: 'D-C4', name: 'コメント流しの回帰（メンバー限定・要 盾オフ）', run: testC4, manual: true },
        { id: 'D-C5', name: 'メンバー専用絵文字の表示（記録のみ）', run: testC5, manual: true },
        { id: 'D-C6', name: '認証情報が漏れていないこと', run: testC6, manual: true },
        { id: 'D-C7', name: '既存機能の回帰（NOT_LIVE_ARCHIVE / キャッシュ）', run: testC7, manual: true },
        { id: 'D-C8', name: '0件のときの表示が残っていること', run: testC8, manual: true },
        { id: 'D-C9', name: '理由コード CHAT_DISABLED の出し分け（A側のみ）', run: testC9, manual: true },
        { id: 'D-C10', name: '非ログインでの回帰（ヘッダ無しの経路）', run: testC10, manual: true },
        { id: 'D-C11', name: '所要時間の参考値（重いアーカイブ）', run: testC11, manual: true },
        /* ★v1.5.0: v2.8.0（ライブ配信のチャット対応）。
           素材が実施時にしか決まらないので、いずれも manual。 */
        { id: 'D-L1', name: '★配信中と判定され、コメントが増え続ける', run: testL1, manual: true },
        { id: 'D-L2', name: '「配信中」が失敗として表示されないこと', run: testL2, manual: true },
        { id: 'D-L3', name: 'キャッシュへ保存されないこと', run: testL3, manual: true },
        { id: 'D-L4', name: '一括シークの対象外 / ▶一括再生は効く', run: testL4, manual: true },
        { id: 'D-L5', name: 'ライブの流し（到着順）', run: testL5, manual: true },
        { id: 'D-L6', name: '取得タブの維持と設定値の不変', run: testL6, manual: true },
        { id: 'D-L7', name: '長時間の継続（30分・記録のみ）', run: testL7, manual: true },
        /* ★v1.7.0: v2.8.3（参照されなくなったコメント配列の破棄）。
           🔴 いずれも manual。動画の取得に数分かかるため「すべて実行」からは外す
              （外さないと ▶ すべて実行 の判定数が版をまたいで比較できなくなる）。 */
        { id: 'D-G1', name: '🗑 枠の削除で解放される', run: testG1, manual: true },
        { id: 'D-G2', name: '★他の枠が同じ動画を使っている間は解放しない', run: testG2, manual: true },
        { id: 'D-G3', name: '🧹 枠を空にすると解放され、取得も止まる', run: testG3, manual: true },
        { id: 'D-G4', name: '枠数を減らすと解放される', run: testG4, manual: true },
        { id: 'D-G5', name: '★流しだけONの枠の動画は解放しない', run: testG5, manual: true },
        { id: 'D-G6', name: '既存機能の回帰（捨てすぎていないこと）', run: testG6, manual: true },
        /* ★v1.8.0: v2.8.5（ピン留め時のレイアウト崩れ）。
           🔴 いずれも manual。枠数とピンを付け外しするため「すべて実行」からは外す
              （外さないと ▶ すべて実行 の判定数が版をまたいで比較できなくなる）。 */
        { id: 'D-Y1', name: '★6枠＋ピンでグリッドからはみ出さない', run: testY1, manual: true },
        { id: 'D-Y2', name: 'ピン枠が左上に置かれ 2×2 を占める', run: testY2, manual: true },
        { id: 'D-Y3', name: '穴が空いていない（他5枠がL字に張り付く）', run: testY3, manual: true },
        { id: 'D-Y4', name: '★order と保存URLが変わらない（退行検出）', run: testY4, manual: true },
        { id: 'D-Y5', name: '他の枠数（3枠 / 9枠）でも崩れない', run: testY5, manual: true },
        { id: 'D-Y6', name: '手動でグリッド列数を変えても崩れない', run: testY6, manual: true },
        /* ★v1.8.1: v2.8.6 の検証 */
        { id: 'D-Y7', name: '★薄い枠で URL 入力欄を押せる', run: testY7, manual: true },
        { id: 'D-Y8', name: '★一括コントローラーの表示／非表示でも画面からはみ出さない', run: testY8, manual: true },
        { id: 'D-Y9', name: '動画領域とチャット欄が潰れない', run: testY9, manual: true },
        /* ★v1.9.0: v2.8.7（ピン枠の位置を4隅から選ぶ）の検証 */
        { id: 'D-Y10', name: '★ピン中の ◀▶ で order と保存URLが動かない', run: testY10, manual: true },
        { id: 'D-Y11', name: '4隅それぞれで配置が破綻しない', run: testY11, manual: true },
        { id: 'D-Y13', name: '★ヘッダーのボタンが狭い枠でもヘッダー内に収まる（9枠）', run: testY13, manual: true },
        { id: 'D-Z1', name: '★ローカル動画の拡大（動画だけが拡大され、操作バーは切れない）', run: testZ1, manual: true },
        /* ★v1.13.0: v2.8.11。枠数・ピン・列数設定を変えるので manual。 */
        { id: 'D-S1', name: '★境界線のドラッグで隣り合う2本だけが変わり、構成ごとに覚える', run: testS1, manual: true },
        /* ★v1.13.1: 再読み込みをまたぐ。 */
        { id: 'D-S2', name: '★再読み込みしても変えた枠の比が残る', run: testS2, manual: true },
        /* ★v1.13.2: 枠数と履歴を変えるので manual。 */
        { id: 'D-Z2', name: '★ローカル動画の履歴を押すと選択画面が開く', run: testZ2, manual: true },
        /* ★v1.16.0: v2.9.0。YouTube の枠とアドオン 2.9.0 が要る・枠数を変えるので manual。 */
        { id: 'D-W1', name: '★枠の中の YouTube でアドオンが動き、返事が送り主の枠に結び付く', run: testW1, manual: true },
        { id: 'D-W2', name: '★「その他の動画」を送り主の枠にだけ読み込む（オリジン・自動再生しない）', run: testW2, manual: true },
        /* ★v1.17.0: v2.10.0。D-K1 は枠数を変える・D-K2 は取得に1〜2分かかるので manual。 */
        { id: 'D-K1', name: '★上位 / すべての切替（キー・要求・前の取得の中止・保存）', run: testK1, manual: true },
        { id: 'D-K2', name: '★実機で B側が上位 / すべてを選び分ける（356件の動画）', run: testK2, manual: true },
        /* ★v1.14.0: v2.8.12。D-T1 は上部メニューを畳むので manual。D-T2 は読むだけ。 */
        { id: 'D-T1', name: '★上部メニューを畳む・上端で出る（レイアウトは動かない）・📌 で戻す', run: testT1, manual: true },
        { id: 'D-T2', name: '上部メニューの部品が今の窓幅で重ならずバーに収まる', run: testT2, manual: true },
        { id: 'D-Y12', name: 'ピン枠が指定した隅にある（期待値は構成から計算）', run: testY12, manual: true }
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
    /* 🔴 ★v1.5.2: 設置が反映されているかを、始める前に機械で確かめる。

       2026-08-15 の事故: manifest.json だけ差し替えられ、GitHub Pages 側の
       index.html と debug_suite.js が古いまま一括実行が走った。
       全項目が「古い版の検証」になり、出力を読むまで誰も気づけなかった。
       ⚠️ 目視の確認手順を手順書に書くだけでは防げない。ここで止める。

       見るのは3点。
         ・本体 APP_VERSION が EXPECT_APP_VERSION と一致するか
         ・アドオンの版数が本体と一致するか（バッジが warn でないか）
         ・この基盤自身が最新か（＝ EXPECT_APP_VERSION を持つ版か）
       🔴 3点目は自分自身なので判定できない。だから代わりに
          「本体の版数が期待と違えば、基盤か本体のどちらかが古い」と報告する。 */
    function installCheck() {
        var app = appVersion();
        var badge = document.getElementById('versionBadge');
        var badgeText = badge ? String(badge.innerText || '') : '(バッジが無い)';
        var badgeWarn = !!(badge && (badge.classList.contains('warn') || badge.classList.contains('ng')));
        var appOk = (app === EXPECT_APP_VERSION);
        return {
            ok: appOk && !badgeWarn,
            app: app, expect: EXPECT_APP_VERSION,
            badge: badgeText, badgeWarn: badgeWarn,
            suite: DEBUG_SUITE_VERSION
        };
    }

    /* 一括実行の入口で必ず通す。false を返したら始めない。 */
    function guardInstall(title) {
        var c = installCheck();
        if (c.ok) return true;
        var lines = [];
        lines.push('⚠ 設置が反映されていません。このまま測っても結果は使えません。');
        lines.push('');
        lines.push('  この基盤 debug_suite.js = ' + c.suite);
        lines.push('  本体 APP_VERSION       = ' + c.app + '（期待 ' + c.expect + '）');
        lines.push('  版数バッジ             = ' + c.badge);
        lines.push('');
        if (c.app === '(取得不可)' || !c.app) {
            lines.push('🔴 本体の APP_VERSION を読めません。');
            lines.push('   index.html が読み込まれていないか、本体が壊れています。');
            lines.push('   ページを開き直してください。');
        } else if (c.app !== c.expect) {
            lines.push('🔴 本体の版数が期待と違います。');
            lines.push('   index.html か debug_suite.js のどちらかが古いままです。');
            lines.push('   GitHub Pages 側のファイルは、置き換えても');
            lines.push('   ブラウザのキャッシュで古いものが読まれることがあります。');
            lines.push('   URL は変えずに Ctrl+Shift+R で読み込み直してください。');
        }
        if (c.badgeWarn) {
            lines.push('🔴 HTML とアドオンの版数が揃っていません。');
            lines.push('   about:debugging でアドオンを再読み込みしてください。');
        }
        var msg = lines.join('\n');
        log('=== ' + title + ' 中止 ===');
        log(msg);
        window.alert(msg);
        return false;
    }

    async function runChatGroup(title, ids, hint) {
        /* ★v1.4.3: ログに出すだけでは気づけない。押したのに始まらない状態を表に出す。 */
        if (running) {
            log('⚠ 実行中です。終わるまで待ってください。');
            window.alert('いま別のテストを実行中です。\n終わってから、もう一度押してください。');
            return;
        }
        if (!guardInstall(title)) return;   /* ★v1.5.2 */
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
        if (!guardInstall(title)) return;   /* ★v1.5.2 */
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
        /* ★v1.13.0: D-Y / D-Z は均等なトラックを前提に期待値を作っている。
           利用者がドラッグで比を変えていても同じ条件で測れるよう、その間だけ保存した比を無視する。 */
        var suspendGrid = /^D-[YZ]\d/.test(def.id) && typeof setGridRatiosSuspended === 'function';
        if (suspendGrid) { try { setGridRatiosSuspended(true); await wait(300); } catch (e) { } }
        /* ★v1.14.0: 上部メニューを畳んでいると、ほかのテストはメニューのボタンを押せない。
           D-T 以外の間だけ出した状態にする（保存値は変えない）。 */
        var suspendBar = !/^D-T\d/.test(def.id) && typeof setTopbarSuspended === 'function'
            && typeof topbarCollapsed !== 'undefined' && topbarCollapsed;
        if (suspendBar) { try { setTopbarSuspended(true); await wait(300); } catch (e) { } }
        try {
            await def.run();
        } catch (e) {
            t.results.push({ name: '実行時エラー', ok: false, actual: String(e && e.message || e), expected: '例外が出ないこと' });
            log('  [❌] 実行時エラー … ' + (e && e.message || e));
        }
        if (suspendGrid) { try { setGridRatiosSuspended(false); } catch (e) { } }
        if (suspendBar) { try { setTopbarSuspended(false); } catch (e) { } }
        finishTest(t);
        if (!keepRunning) running = false;
    }

    async function runAll() {
        if (running) { log('⚠ 実行中です。終わるまでお待ちください。'); return; }
        if (!guardInstall('▶ すべて実行')) return;   /* ★v1.5.2 */
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
            /* ★v1.13.1: 再読み込みをまたぐテストは D-M7 と D-S2 の2本。which で振り分ける（無ければ D-M7）。 */
            (payload.which === 'S2' ? resumeS2 : resumeM7)(payload).catch(function (e) {
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

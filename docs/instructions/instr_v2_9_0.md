# v2.9.0 指示書 ─ 枠の中の「その他の動画」をその枠で開く（R-11）

発行: 2026-10-03（Claude Code）
基点: `index.html` v2.8.13 / アドオン 2.8.13 / `debug_suite.js` v1.15.0
読む仕様書: `get-dev-workflow` / `get-debug-suite` / `get-protocol-spec`（0-1節・1節・11節 R-11）
種別: **マイナー（A側が受けるメッセージを2種類足す）。🔴 アドオンを上げる（2.8.13 → 2.9.0・`v2.9.0.zip`）**

## 1. やること（利用者要望 2026-10-03）

枠の中の YouTube で、一時停止時・終了時に出る「その他の動画」（関連動画）を押すと、今は別タブで YouTube が開く。**別タブを開かず、その枠でその動画を読み込む。**

## 2. 着手前に実コードで確かめたこと

| # | 確認 | 結果 |
| :-: | :--- | :--- |
| 1 | 枠の作り方 | `loadSingleYT(cardId)`（と復元の経路）が `new YT.Player('ytPlayer_' + cardId, …)`。`playerVars` は `rel: 0`（同じチャンネルの関連動画だけ出る）。iframe は `ytPlayers[cardId].getIframe()` で取れる |
| 2 | 枠へ別の動画を入れる経路 | 入力欄に URL を入れ `sync_url_<cardId>` を書いて `loadSingleYT(cardId, true)`（`addOrFillVideoSlot` と同じ）。差し替え時のコメントの参照切りと解放は `loadSingleYT` の中で済む |
| 3 | A側の受信 | `window` の `message` は `EXTERNAL_SYNC_EVENT`（`content_controller.js` が中継）だけを見ている。embed からの直接の `postMessage` は無い |
| 4 | アドオンの対象 | `content_youtube_scrape.js` は `https://*.youtube.com/*` の**上位フレームだけ**（`all_frames` なし）。embed の中では何も動いていない |
| 5 | 🔴 A側から embed の中は触れない | 別オリジン。クリックはアドオンの content script でしか取れない |

## 3. 設計

### 3-1. アドオン: `content_yt_embed.js`（新設）

- 対象: `https://www.youtube.com/embed/*`、`all_frames: true`、`run_at: document_start`。
- 🔴 **親がこのツールのときだけ動く**（他のサイトの埋め込み動画の挙動を変えない）。親のオリジンは embed URL の `origin=`（IFrame API が付ける）か `document.referrer` から取り、`https://syanao-coder.github.io`・`http://localhost`・`http://127.0.0.1`（ポート不問）・`file://`（`null`）だけを通す。
- `window` の capture 段階で `click` を見張る。**修飾キーなしの左クリック**で、押した先の `a[href]` が `/watch?v=` などの**別の動画**を指していれば、`preventDefault` と `stopImmediatePropagation` で別タブを止め、親へ `{ type: 'SYNC_EMBED_OPEN', videoId, list, href, embedHref }` を送る。
  - 🔴 中クリック・Ctrl/Shift/⌘ 付きは今まで通り別タブ（利用者が別タブを望む操作）。
  - 🔴 今の動画と同じ ID のリンク（タイトル・YouTube ロゴ）は止めない。
- 親からの `{ type: 'SYNC_EMBED_PING', nonce }` に `{ type: 'SYNC_EMBED_HELLO', nonce, embedHref, version }` で答える（**A側から「この枠で content script が動いているか」を測るため**）。

### 3-2. A側

- `message` で `SYNC_EMBED_OPEN` / `SYNC_EMBED_HELLO` を受ける。🔴 `event.origin` が `https://www.youtube.com` 以外は捨てる。
- 枠の特定（`findCardByEmbedSource`）: ① `event.source` が `ytPlayers[id].getIframe().contentWindow` と一致 ② 一致が無ければ `embedHref` と iframe の `src` の videoId が一致する枠が**1つだけ**のとき。どちらで決めたかを `lastEmbedEvent` に残す。
- 開く（`openVideoInCard(cardId, videoId, list)`）: 入力欄・`sync_url_` を `https://www.youtube.com/watch?v=<ID>` に書き、履歴に足し、`loadSingleYT(cardId, true)`。
  - 🔴 **自動再生しない。** 他の枠と同期して再生するツールなので、1枠だけ勝手に走ると揃わない。読み込んだら ▶（一括でも枠ごとでも）で再生する。→ 利用者の希望が違えば次の版で変える（用紙の FREE で聞く）。
  - 重複（他の枠に同じ動画がある）は弾かない（利用者が明示的に選んだので）。

### 3-3. 版数

`APP_VERSION` 2.9.0・`ADDON_REQUIRED_VERSION` 2.9.0・`manifest.json` 2.9.0・`v2.9.0.zip`（`v2.8.13.zip` 削除）・`APP_HISTORY` 37件。

## 4. 判定（`debug_suite.js` v1.16.0）

| ID | 内容 | PC |
| :--- | :--- | :--- |
| `D-W1` | **実機の YouTube 枠すべて**に `SYNC_EMBED_PING` を送り、🔴 **全枠から HELLO が返り、`event.source` だけで正しい枠に決まる**（Floorp の content script からの `postMessage` で `source` が iframe と一致するかを実機で確かめる） | YouTube の枠が1つ以上ある。🔴 枠の iframe の `src` が `youtube.com/embed/` |
| `D-W2` | A側の受け口: 偽の iframe（`srcdoc`）から送った `SYNC_EMBED_OPEN` を、🔴 オリジン違いは捨てる・正しいオリジン扱いならその枠に別の動画が入り保存URLが替わる・他の枠は変わらない・自動再生しない | 偽の iframe の `contentWindow` が `event.source` として届く（`source` 照合の土俵） |

- `D-W1` は manual（YouTube の枠と アドオン 2.9.0 が要る）。`D-W2` は枠数を変えるので manual。
- `VERSION_FOCUS` = `D-V1` → `D-V2` → `D-W1` → `D-W2`。`D-N3` 36 → 37。
- 🔴 embed の中のクリック横取りは debug_suite から届かない。**embed を模した HTML に content script を読ませる検証台**で headless 確認する（6節）。実機は目視（用紙）。

## 5. 用紙

`tests/test_v2_9_0.html`。アドオンの入れ直し → 「▶ すべて実行」→ 「🎯」→ 目視（一時停止して「その他の動画」を押す・終了画面の動画を押す・中クリックは別タブ・タイトルは別タブ）。

## 6. 実装後の確認（headless・検証台）

検証台: `https://syanao-coder.github.io/` をローカルのファイルで配り、`https://www.youtube.com/iframe_api` を**偽の IFrame API**（`embed/<ID>?enablejsapi=1&origin=…&widgetid=N` の iframe を作る）、`https://www.youtube.com/embed/*` を**偽の embed**（`content_yt_embed.js` を `<head>` の先頭で読み、YouTube の代わりに「クリックで `window.open`」する処理を持つ）に差し替えた。

| 項目 | 結果 |
| :--- | :--- |
| 関連動画（`a.ytp-videowall-still`）の左クリック | 枠1に `BBBBBBBBBBB` が入る・`how=source`・履歴の見出しは「Related B」・`playerState` は -1（自動再生しない） |
| 一時停止の候補（`/watch?v=CCC…&list=PL1`・相対URL） | 枠1に `…?v=CCCCCCCCCCC&list=PL1` が入る |
| タイトル（今の動画と同じ ID） | 止めない（偽 embed の `window.open` が呼ばれる） |
| Ctrl＋クリック / 中クリック | 止めない |
| 親が許可外（`https://evil.example`） | 止めない |
| `D-V1` / `D-V2` / `D-W1` / `D-W2` | すべて合格（`D-W1` は YouTube の枠が無い状態からも合格・返事まで 1〜2秒） |
| 「▶ すべて実行」23本（file://） | すべて合格 |
| 負の検証 | content script なし（旧アドオン）→ `D-W1` **不合格 0/2**。A側でオリジンを見ない＋自動再生 → `D-W2` **不合格 9/11**（いずれも判定不能ではない） |

- 🔴 **実機で未確認の前提**: ① Floorp の content script からの `postMessage` で、親の `event.source` が iframe の `contentWindow` と一致するか（`D-W1` が実機で測る。一致しなくても videoId の照合で動く）② 本物の embed の「その他の動画」がリンク（`a[href]`）で、`click` で開いているか（目視 R3・R4）。②が外れたら、embed の DOM を利用者の環境で読む調査を先に行う。

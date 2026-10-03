# v2.10.0 指示書 ─ チャットの「上位のチャット / すべてのチャット」切り替え

発行: 2026-10-03（Claude Code）
基点: `index.html` v2.9.0 / アドオン 2.9.0 / `debug_suite.js` v1.16.0
読む仕様書: `get-dev-workflow` / `get-debug-suite` / `get-chat-feature-spec`（1-3節・1-6節・8-13節）/ `get-protocol-spec`（3節・4節・11節 v2.11.0）
種別: **マイナー（取得要求に `mode`、応答に `view` を追加）。🔴 アドオンを上げる（2.9.0 → 2.10.0・`v2.10.0.zip`）**
順序: 利用者の指示（2026-10-03「2.11.0からで」）でロードマップの v2.11.0（本件）をライブ取得の自動復帰より先に行う。🔴 **版数は逆戻りさせないため、本件を v2.10.0 として出し、ライブ取得の自動復帰を v2.11.0 へ繰り下げる**（ロードマップの番号を入れ替える）。

## 1. やること

チャット欄の見出しにボタンを置き、**枠ごとに**「すべてのチャット」（既定）と「上位のチャット」（YouTube が間引いた表示）を切り替える。コメント流しも同じ枠の設定に従う。

## 2. 着手前に実コードで確かめたこと

| # | 確認 | 結果 |
| :-: | :--- | :--- |
| 1 | B側の切替 | `chat_fetcher_main.js` の `pickAllChatContinuation(lc)` が 1回目の応答の `viewSelector.subMenuItems[1]`（全件）へ切り替える。`ytInitialData` の初期 continuation は **index 0（上位）**。ライブも1回目の応答に `viewSelector` がある（2回目以降は無い） |
| 2 | 要求の経路 | A `CHAT_STREAM_REQUEST{videoId,requestId}` → `content_controller.js` → background `startChatStream(videoId, requestId)` → `CHAT_ENQUEUE` → `content_yt_chat.js`（`postMessage`）→ `enqueue(requestId, videoId)`。🔴 **4か所すべてがフィールドを名指しで転送している**＝`mode` を4か所に足す |
| 3 | 応答の経路 | `sendChatStreamEvent`（background）と `content_controller.js` が**フィールドを名指しで転送**（7-4節の罠）。`view` を2か所に足す |
| 4 | A側のキー | `chatStore` / `chatState` / `chatInflight` / `chatError` / `chatCacheSkip` / `liveVideoIds` / `chatLoadedVideoId` / `flowVideoId` / IndexedDB はすべて videoId をキーにしている。応答は `chatPending[requestId]` からキーを引く（`d.videoId` は使っていない） |
| 5 | videoId を作る入口 | `getChatVideoId(cardId)`。使っているのは `isLiveCard`・`updateChatContent`・`collectChatRefs`・`pumpChatProgress`（2か所）・`reloadChat`・`openWatchPageAt`・流し（2か所） |

## 3. 設計

- **キー**: `chatKeyOf(videoId, mode)` = 上位なら `videoId + '#top'`、すべてなら **videoId のまま**（🔴 既存のキャッシュ・保存値・debug_suite の判定がそのまま使える＝退行しない）。
- `getChatKey(cardId)` を新設し、**5 の入口のうち `openWatchPageAt` 以外**をこれに差し替える。以降の処理はキーを「videoId」と同じように扱う（変数名は変えない）。
- 要求を出すところ（`requestChatArchive`）だけ、キーから videoId と mode に戻して `CHAT_STREAM_REQUEST{videoId, mode}` を送る。
- 枠ごとの設定 `chatMode[cardId]`（`'top'` のときだけ持つ）。`sync_chat_mode_map` に保存。枠を消すと消える（`clearChatState`）。
- 切替（`setChatMode`）: 設定を変え、その枠のチャット欄と流しを新しいキーで描き直し、**`releaseUnusedChatData` で前のキーを参照が無ければ止めて捨てる**（取得の中止もここで済む）。
- ⚠️ 「上位のチャット」は YouTube 側の間引きなので A側で全件から作れない＝**切り替えると取り直し**（キャッシュがあればキャッシュ）。
- B側: `job.mode`。1回目の応答で `mode==='top'` なら index 0、それ以外は index 1 を選ぶ（**どちらも「すでに選ばれていれば切り替えない」**）。実際に選ばれた側を `job.view`（`'top'` / `'all'` / `'unknown'`＝`viewSelector` が無い）として `chunk` と `done` に載せる。
- 見出し: 上位のときは「💬 チャット〔上位〕 (…)」。ボタンは `chatModeBtn_<cardId>`（「全」/「上位」）。

## 4. 判定（`debug_suite.js` v1.17.0）

| ID | 内容 | PC |
| :--- | :--- | :--- |
| `D-K1` | A側だけで測る（`window.postMessage` を差し替えて要求を捕まえ、アドオンへ流さない）。既定のキーは videoId そのまま・要求に `mode:'all'`・ボタンで上位にするとキー `#top`・要求に `mode:'top'`・前のキーの取得が止まる・保存される・戻すと元のキー | 偽の videoId の枠を作れる・要求を捕まえられる（既定で1件） |
| `D-K2` | 実機。`zuuZyNH0F1Y`（356件）を すべて → 上位 の順に取り直し、🔴 B側が報告した `view` がそれぞれ `all` / `top`・すべては 356件・上位 ≤ すべて | すべての件数が既知の 356件（D-C1 と同じ positive control） |

- `D-K1` は manual（枠数を変える）。`D-K2` は manual（取得に1〜2分）。
- `VERSION_FOCUS` = `D-V1` → `D-V2` → `D-K1` → `D-K2`。`D-N3` 37 → 38。

## 5. 用紙

`tests/test_v2_10_0.html`。アドオンの入れ直し → 「▶ すべて実行」→「🎯」→ 目視（ボタンで切り替わる・見出しの〔上位〕・流しも切り替わる・再読み込み後も残る）。

## 6. 実装後の確認（headless）

| 項目 | 結果 |
| :--- | :--- |
| `D-V1` / `D-V2` / `D-K1`（file:// ・アドオン版数 2.10.0 を偽装） | 合格（`D-K1` 16/16） |
| 「▶ すべて実行」23本 | すべて合格 |
| 負の検証 | `getChatKey` を旧来の `getChatVideoId` に差し戻すと `D-K1` **不合格 10/16**（判定不能ではない） |
| B側 `pickChatView` の単体確認 | 初期が上位で mode=all → 全件側へ切替（`view:'all'`）/ mode=top → 切替なし（`'top'`）/ 初期が全件で mode=top → 上位へ切替 / mode=all → 切替なし / `viewSelector` 無し → `'unknown'` |

- 🔴 **`D-K2`（実機で B側が選び分けるか）は headless では測れない**（YouTube へ出られない）。実機の用紙 R2 で測る。
- 🔴 **管理側の誤り（v2.8.13・v2.9.0）**: Python の `open()`（改行の自動変換あり）で書き換えたため、`addon/manifest.json` と `addon/content_youtube_scrape.js` の改行が **CRLF → LF に変わっていた**（今回も `background.js` など4本で同じことが起き、差分が全行になって気づいた）。動作には影響しない。本版で CRLF に戻した。以後は `newline=''` で開くか、`sed` / Edit で書き換える。

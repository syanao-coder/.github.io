# v2.19.0 指示書 ─ 「最近使った動画」に YouTube の視聴履歴を切り替えで出す／デバッグのログの扱い

発行: 2026-10-30（Claude Code）
基点: `index.html` v2.18.1 / アドオン 2.16.0 / `debug_suite.js` v1.29.0
読む仕様書: `get-dev-workflow` / `get-debug-suite`（9-B-20節・9-B-14-1節 H1）/ `get-protocol-spec`（0-2節・4節 `chatPost` の中継・7-4節 中継の列挙・11節 v2.19.0）/ `get-chat-feature-spec`（1-3-2節 認証ヘッダ・1-7節 取得タブで送る経路）/ 記録 `spike_hist_h1.md`
種別: **マイナー（A→B に `YT_HISTORY_REQUEST`・B→A に `state:'ytHistory'`）。🔴 アドオンを上げる（2.16.0 → 2.17.0・`v2.17.0.zip`）**

## 1. やること

### 1-1. 🔴 利用者と決めたこと（2026-10-26・2026-10-30）

| 項目 | 決めたこと |
| :--- | :--- |
| 見せ方 | 枠の「最近使った動画」の見出しで **「🕒 このツール ／ ▶ YouTube」を切り替える**（置き換えない） |
| 件数 | 30件・同じ動画はまとめる（新しい方を残す） |
| ショート | 除く |
| 読むとき | ▶ YouTube に切り替えたときに取得タブで読む。10分は全枠で使い回す。🔄 で読み直す |
| ログインしていない | 「YouTube にログインすると表示されます」（2026-10-30 の回答は a〜d の4つ。5つ目の案は既定どおりとした） |
| デバッグのログ | 測定を始めたら自動で消す。直前の結果を最大3件残し、実行順に名前つきのコピーボタンを出す（利用者「個別テストは行わない」） |
| 🔴 プライバシー | 履歴のタイトル・ID・チャンネル名はリポジトリ（記録・判定の出力）に残さない。判定は件数と項目の有無だけを出す |

## 2. 着手前に実コードで確かめたこと

| # | 確認 | 結果 |
| :-: | :--- | :--- |
| 1 | 「最近使った動画」 | `generateHistoryGalleryHTML(cardId)`（空の枠の中・`sync_video_history`・30件）。🔴 **履歴が0件だと見出しごと出さない**（`return ''`）→ YouTube の履歴は見られるように、切り替えがあるときは0件でも見出しを出す |
| 2 | 押したとき | `loadHistoryYt(cardId, url)` → `loadSingleYT`（読み込むとこのツールの履歴にも入る。今と同じ） |
| 3 | 取得タブへの経路 | v2.16.0 の投稿と同じ: A `postMessage` → `content_controller.js` → runtime → `background.js`（`ensureChatTab` / `ensureInjected` → `tabs.sendMessage`）→ `content_yt_chat.js`（`PASS_CMD`）→ MAIN `chat_fetcher_main.js` → `post({ev})` → `CHAT_STREAM_EVENT` → `sendChatStreamEvent`（項目を列挙）→ `content_controller.js` `CHAT_STREAM_STATE`（項目を列挙）→ A `EXTERNAL_SYNC_EVENT` |
| 4 | 🔴 中継の列挙 | `items` を `background.js` と `content_controller.js` の**両方**に足す（7-4節の罠） |
| 5 | 認証 | エンジンの `buildAuthHeaders()`（SAPISIDHASH）・`hasAuthCookie()`（v2.17.0）。スパイク H1 はこれと同じ形で HTTP 200 |
| 6 | 応答の形（H1） | `lockupViewModel`（`contentId`・`metadata.lockupMetadataViewModel.title`）が大半・`videoRenderer` が少し・ショートは `shortsLockupViewModel`。1ページ 199件・3.4MB → 🔴 エンジンで30件に絞って送る |
| 7 | デバッグのログ | `runAll` / `runOne` / `runChatGroup` が `clearLog` 相当を持たない（利用者が 🗑 を押していた）。`📋 報告書用にコピー` は `report` から Markdown を作る |

## 3. 設計

### 3-1. アドオン（2.17.0）

- `chat_fetcher_main.js` に `ytHistory(d)`:
  - 🔴 認証の Cookie が無ければ読まずに `{ ok:false, needLogin:true }`。
  - `cfgFromPage()`、無ければ `/` の HTML から `cfgFromHtml`。
  - `POST /youtubei/v1/browse`（`browseId:'FEhistory'`・認証ヘッダ・20秒で打ち切り）。
  - 項目を拾う: `lockupViewModel`（`contentType` が動画のもの）・`videoRenderer`。🔴 ショート（`shortsLockupViewModel` / `reelItemRenderer`）は除く。同じ ID は最初（新しい方）だけ。30件で止める。
  - 1件 = `{ id, title, channel, len, pct }`（チャンネル名・長さ・再生位置の割合は取れなければ空）。タイトル・チャンネルは200字まで。
  - 結果 `post({ ev:'history', requestId, ok, needLogin, items, error, httpStatus })`。
- `content_yt_chat.js`: `PASS_CMD` に `CHAT_HISTORY`。
- `background.js`: `FETCH_YT_HISTORY` → `startYtHistory`（投稿と同じく取得タブを用意して注入）。失敗は `ev:'history'` で返す。`sendChatStreamEvent` に `items`。
- `content_controller.js`: `YT_HISTORY_REQUEST` を中継・`CHAT_STREAM_STATE` に `history: 'ytHistory'`・`items` を転送。
- `manifest.json` 2.17.0・`v2.17.0.zip`（`v2.16.0.zip` を削除）。

### 3-2. A側（v2.19.0）

- 状態: `histView`（`'tool'` / `'yt'`・`sync_hist_view`・全枠共通）、`ytHist = { state, items, at, error, reqId }`（メモリだけ・全枠共通）。
- 見出し: 「🕒 このツール ／ ▶ YouTube」の切り替え（押した方を強調）＋ YouTube のときは 🔄。このツールのときは今までどおり「履歴消去」。
- ▶ YouTube に切り替えたとき・空の枠を描くとき: 10分以内の結果があれば使い、無ければ1回だけ要求（読み込み中は重ねて送らない）。🔄 は必ず要求。
- 表示: 状態ごとに「読み込み中…」／タイル（サムネは `img.youtube.com/vi/ID/mqdefault.jpg`・タイトル2行・チャンネル名・長さ・再生位置の赤い線）／「YouTube にログインすると表示されます」／「読めませんでした（理由）」／「アドオン 2.17.0 が要ります」（25秒で答えが無いとき）／「履歴がありません」。
- 押すと `loadHistoryYt(cardId, 'https://www.youtube.com/watch?v=ID')`。YouTube の履歴には ✕（消す）を付けない（YouTube 側は消さない）。
- 🔴 タイトル・チャンネル名は `escapeHtmlAttr` で逃がす（HTML として解釈させない）。
- 結果が届いたら空の枠を描き直す（YouTube を見ているときだけ）。
- 版数: `APP_VERSION` 2.19.0・`ADDON_REQUIRED_VERSION` 2.17.0・`APP_HISTORY` 57件・`debug_suite.js` v1.30.0（`D-N3` 57・`EXPECT_ADDON_REQUIRED` 2.17.0）。

### 3-3. デバッグのログ（`debug_suite.js` v1.30.0）

- 測定（すべて実行・🎯・個別・一括ボタン）を始めるとき、前の結果（`report` が空でなければ）を「名前・時刻・Markdown」で残し、ログと記録を消してから始める。名前はボタンの名前（`▶ すべて実行`・`🎯 この版の回帰`・`▶ D-W10` など）。
- 残すのは最大3件（新しい順）。`localStorage`（`sync_debug_runs`）に置く（再読み込みをまたぐ測定があるため）。
- パネルの「📋 報告書用にコピー」の下に「📋 前の結果: [▶ D-W10 05:17] [🎯 この版の回帰 05:12] …」を出す。押すとその Markdown をコピーする。
- 🔴 再読み込みのあとの続き（`D-M7` / `D-S2` / `D-A9`）は「始め」ではないので消さない。
- 🗑 ログを消す は残す（今の結果だけ消す）。

## 4. 判定（`debug_suite.js` v1.30.0）🔴 判定の出力に履歴のタイトル・ID・チャンネル名を載せない

| ID | 内容 | PC |
| :--- | :--- | :--- |
| `D-F1` | A側だけ。偽の答え（`window.postMessage` を差し替えて `YT_HISTORY_REQUEST` を捕まえ、`handleYtHistory` に偽の結果を渡す）: 切り替えがある（このツールの履歴が0件でも）・▶ YouTube で1回だけ要求・読み込み中の表示・届いた30件のタイルと順番・🔴 タイトルの `<img onerror>` が HTML にならない・押すとその動画の URL で読み込む（読み込みは差し替えて数えるだけ）・10分以内は別の枠でも要求しない・🔄 で要求する・`needLogin` の文言・答えが無いと「アドオン 2.17.0 が要ります」・🕒 に戻すと今までの履歴・選んだ見せ方を覚える・後始末 | 空の枠がある |
| `D-W11` | 実機（YouTube にログイン・アドオン 2.17.0）。▶ YouTube を要求し、20秒以内に `ok`・1〜30件・全件に ID とタイトル・同じ ID が無い・ショートが無い（ID の形だけで数える）。チャンネル名・長さ・再生位置が付いた件数を数える。🔴 タイトル・ID は出さない | アドオン 2.17.0 |

- `VERSION_FOCUS` = `D-V1` → `D-V2` → `D-F1` → `D-Z2`（`D-Z2` は同じ欄のローカル動画の履歴の回帰。▶ YouTube を選んでいるとローカルの履歴が出ないので、`D-Z2` はその間だけ 🕒 にする）。`D-W11` は 📡 実機に出る。
- デバッグのログ（3-3節）は利用者の指定で個別の判定を作らない。headless で動きだけ確かめる。

## 5. 用紙

`tests/test_v2_19_0.html`: T1 アドオンの入れ直し（2.17.0）→ T2 開く → R1 すべて実行 → R2 🎯 → R3 `D-W11` → R4 目視（空の枠で ▶ YouTube に切り替え・並び・押すと読み込める・別の枠・🔄・🕒 に戻す・読み直し）。デバッグのログは利用者の指定で個別の項目を作らない（R1〜R3 で自然に使う）。🔴 用紙にも履歴のタイトルを書かせない。

## 6. headless の確認（Chromium）

| 項目 | 結果 |
| :--- | :--- |
| エンジン（偽の youtube.com・`rig190`） | 11項目すべて合格: Cookie なしは `browse` を読まずに `needLogin`／要求は `browseId:'FEhistory'`・キー・SAPISIDHASH／30件で止める／並び順（`videoRenderer` と `lockupViewModel` が混ざっても画面の順）／ショート・プレイリストを除き同じ動画は1つ（`shorts` 1・`dups` 1）／`videoRenderer` と `lockupViewModel` のタイトル・チャンネル・長さ・再生位置／タイトルは文字のまま返す／結果に Cookie・認証が載らない／HTTP 500 は理由つきの失敗／401（Cookie あり）は `needLogin` にしない |
| 中継（`content_controller.js` を偽の `chrome` で読む） | A→B `YT_HISTORY_REQUEST` → `FETCH_YT_HISTORY`／B→A `ev:'history'` → `state:'ytHistory'` に `items` / `shorts` / `dups` が載る。`background.js` の `sendChatStreamEvent` にも3項目 |
| `D-F1` | 19/19（PC 2/2）。変異4通り（タイトルを逃がさない／10分の使い回しなし／0件で切り替えを出さない／古い答えを受ける）→ いずれも不合格。旧版（v2.18.1）は「ある」が不合格 |
| `D-W11`（偽の答え） | 25件の答えで 5/5・`needLogin` の答えでは不合格 |
| `D-Z2` | ▶ YouTube を選んだ状態でも合格（その間だけ 🕒）。終わると ▶ YouTube に戻る |
| 回帰 `▶ すべて実行` | 23本合格 |
| デバッグのログ | 個別に5本続けて押すと、ログは最後の1本だけ・「📋 前の結果」は新しい順に3件（`▶ D-N3` / `▶ D-U2` / `▶ D-V2`）・中身はそれぞれの Markdown |
| `D-Y1`・`D-Y5`〜`D-Y7` | 合格（空の枠に切り替えの行が増えても薄い枠の入力欄は押せる） |
| `D-Y8` | ⚠️ 判定不能（PC「案A を外すとはみ出す」が不成立）。**v2.18.1 でも同じ結果**（headless のこの画面の大きさでは外してもはみ出さない）。今回の変更によるものではない |
| ページを開いた直後（▶ YouTube を覚えていた・6枠が空） | アドオンの名乗りが来るまで要求しない（4.5秒で0回）→ 名乗りのあと1回だけ。🔴 `content_controller.js` は `document_end` で、本体の起動との順が決まらないため（要求を取りこぼすと25秒後に「答えがありません」になる）。待ちは1本だけ・最大10秒 |
| 用紙 `tests/test_v2_19_0.html` | R2（🎯）を貼って3つの照合が合格 |
| zip | `v2.17.0.zip`（8ファイル・`manifest.json` 2.17.0）。`v2.16.0.zip` を削除 |

## 7. 測れなかった値・未確認（実装前）

- 🔴 本物の応答の `lockupViewModel` で、チャンネル名（`metadataRows[0]`）・長さ（`thumbnailBadgeViewModel`）・再生位置（`thumbnailOverlayProgressBarViewModel.startPercent`）の置き場所が想定どおりか。H1 は「あるか」しか数えていない → `D-W11` の件数（チャンネル名あり / 長さあり / 再生位置あり）と R4c で見る。取れなくてもタイトルとサムネは出る。
- 取得タブが新しく開いた直後（`ytcfg` が無い）に `/` の HTML から読む経路（headless では `ytcfg` がある）。
- ブランドアカウント・複数アカウント（`X-Goog-AuthUser: 0` 固定）。

# v2.13.0 指示書 ─ 配信中の視聴者数の表示

発行: 2026-10-23（Claude Code）
基点: `index.html` v2.12.2（🔴 **実機未測定のまま積む** ─ 利用者指示「マージせず、順番にテストする」）/ アドオン 2.12.0 / `debug_suite.js` v1.22.0
⚠️ 2026-10-24: v2.12.2 の実機で不具合（ライブのコメントが出ない）→ v2.12.3 を先に `main` へ出し、v2.13.0 はその上へ積み直した（`APP_HISTORY` 46件・`D-N3` 46）
読む仕様書: `get-dev-workflow` / `get-debug-suite` / `get-chat-feature-spec`（1-6節 ライブ・1-6-6節 恒久制約・1-6-7節 自動復帰）/ `get-protocol-spec`（0-2節 採番）
種別: **マイナー（機能追加・心拍に項目を足す）。🔴 アドオンを上げる（2.12.0 → 2.13.0・`v2.13.0.zip`）**

## 0. 進め方（利用者指示 2026-10-23）

- 🔴 **`main` へマージしない。** ブランチに積んで draft PR のまま置く。v2.12.2 の測定が終わってから、順番にマージして測る（Pages は `main` から配られるので、マージした時点で利用者の測定対象が変わる）。
- v2.12.2 の測定で修正が出たら、v2.13.0 より先に直す（v2.13.0 は v2.12.2 の上に積んでいるので、修正はこのブランチへ取り込む）。

## 1. やること

ライブ枠のチャット欄の見出しに、**配信中の視聴者数**（「○人が視聴中」）を出す。要望②（2026-10-08）。

除外: コメント投稿（要望③ ─ 調査が先）。チャット欄を開いていない枠への表示（1-6-6節の恒久制約: 取得していない枠はライブかどうか分からない）。

## 2. 着手前に実コードで確かめたこと

| # | 確認 | 結果 |
| :-: | :--- | :--- |
| 1 | ライブの取得の在りか | `chat_fetcher_main.js`（YouTube のタブの MAIN world）の `runJob` のループ。`postChat` が `/youtubei/v1/live_chat/get_live_chat` を認証ヘッダつきで叩く。`cfg`（`INNERTUBE_API_KEY` / `CONTEXT`）を持っている |
| 2 | watch の取り直し | `recoverLive` が2分ごと（`LIVE_CHECK_INTERVAL_MS`）に watch HTML を取る。`findInitialData` で `ytInitialData` を読める |
| 3 | A側へ様子を送る口 | 心拍（`ev:'ping'`・5秒ごと）の `active[]` の要素。🔴 中継（`background.js` / `content_controller.js`）は `active` / `waiting` を**丸ごと転送する**ので、項目を足しても中継の変更は要らない（v2.11.1 で実証） |
| 4 | A側の受け口 | `handleChatPing` が `e.live === true` の要素を `store` へ写す。見出しは `updateChatHeadTitle` のライブ分岐 |
| 5 | 改行 | `chat_fetcher_main.js` は CRLF（鉄則 #49）・`manifest.json` も CRLF |
| 6 | 🔴 未確認 | 視聴者数を返す API の応答の形は**このプロジェクトでは一度も実測していない**（この環境からは YouTube に繋がらない ─ 403）。→ 3-2節の2つの経路と、効いた経路の記録（`viewersBy`）で、1回の測定を調査も兼ねるものにする |

## 3. 設計

### 3-1. 取得（アドオン `chat_fetcher_main.js`）

| 定数 | 値 | 意味 |
| :--- | :-- | :--- |
| `LIVE_VIEWERS_INTERVAL_MS` | 30000 | 視聴者数を取り直す間隔 |
| `LIVE_VIEWERS_TIMEOUT_MS` | 10000 | 1回の要求の上限 |

- 🔴 **チャットの取得を待たせない。** 視聴者数の要求は `await` せずに投げる（同時に1本まで）。失敗してもチャットには影響させない（記録だけ）。
- 正常な応答の後、前回から `INTERVAL` 経っていれば取りに行く。

### 3-2. 2つの経路（どちらが効いたかを `viewersBy` に残す）

| 順 | 経路 | 中身 |
| :-: | :--- | :--- |
| 1 | `updated_metadata` | `POST /youtubei/v1/updated_metadata?key=…`・body `{ context, videoId }`・認証ヘッダは `postChat` と同じ作り方。YouTube の watch ページが視聴者数の更新に使う口（既知の形: `actions[].updateViewershipAction.viewCount.videoViewCountRenderer`） |
| 2 | watch HTML | 最初の watch と2分ごとの `recoverLive` の HTML の `ytInitialData`（`videoPrimaryInfoRenderer.viewCount.videoViewCountRenderer`）。経路1が失敗したときの予備 |

- 🔴 **入れ物名を決め打ちしない**（1-6節の戒めと同じ）。`videoViewCountRenderer` という子を深さ制限つきで探す。数は `originalViewCount`（数字の文字列）を優先し、無ければ `viewCount` の文字（`simpleText` / `runs`）から数字だけを取る。表示用の文字（例「1,234 人が視聴中」）も残す。
- watch HTML は巨大なので、探す範囲は `contents.twoColumnWatchNextResults.results` の下（深さ 8）に限る。

### 3-3. 送る（心拍に足す項目）

`viewers`（数）・`viewersText`（YouTube の文字）・`viewersAgoMs`（取ってからの時間）・`viewersBy`（`updated_metadata` / `watch`）・`viewersError`（直近の失敗 80字）・`viewersOk` / `viewersFails`（回数）。

### 3-4. A側

- `handleChatPing` で `store` へ写す。数が変わったら見出しを更新。
- 見出し（取得中のライブ）: `💬 チャット (n / 🔴 配信中・👤 1,234人)`。
  - 🔴 **`viewersAgoMs` が 120秒を超えたら出さない**（古い数を今の数に見せない）。旧アドオン（項目なし）・配信終了後も出さない。
  - 数は A側で `toLocaleString()`。YouTube の文字は見出しの `title` に添える。

### 3-5. 版数

`APP_VERSION` 2.13.0・`ADDON_REQUIRED_VERSION` 2.13.0・`manifest.json` 2.13.0・`v2.13.0.zip`（`v2.12.0.zip` 削除）・`APP_HISTORY` 45件・`debug_suite.js` v1.23.0（`D-N3` 45）。

## 4. 判定（`debug_suite.js` v1.23.0）

| ID | 内容 | PC |
| :--- | :--- | :--- |
| `D-L10` | A側だけ。偽のライブの取得へ心拍を流す: 視聴者数ありで「👤 1,234人」・`title` に YouTube の文字／`viewersAgoMs` 200秒で出ない／項目なし（旧アドオン）で出ない／数が変われば見出しも変わる／配信終了後は出ない | 🔴 偽のライブの見出しが「🔴 配信中」（土俵） |
| `D-W5` | 実機（ライブ）。チャット欄を開いたライブ枠で、70秒以内に心拍から視聴者数（数・経路・文字）が届く。見出しに「👤」が出る | チャット欄を開いた配信中のライブ枠がある・心拍が15秒以内に届いている |

- `D-W5` の観測: `viewersBy`・`viewersText`・`viewersOk` / `viewersFails`・`viewersError`。🔴 **経路1が失敗して経路2で取れた場合も合格**（数が届けばよい）だが、記録には経路を残す。
- `VERSION_FOCUS` = `D-V1` → `D-V2` → `D-L10` → `D-W5`。どちらも manual（`D-L10` は枠数を変える・`D-W5` はライブが要る）。
- 目視: YouTube の watch ページに出ている「○人が視聴中」と見出しの数がおおむね合うか（30秒ごとなので少しずれてよい）。

## 5. 用紙

`tests/test_v2_13_0.html`。アドオンの入れ直し（2.13.0）→ R1 すべて実行 → R2 🎯（ライブ1枠・チャット欄を開いて）→ R3 目視（YouTube の表示と見比べる）。v2.11.1 の持ち越し（R6・R7）は引き継ぐ。
🔴 v2.12.2 の用紙と同じライブで測ってよい。

## 6. 測れなかった値・未確認（実装前）

- 🔴 `updated_metadata` の応答の形・認証の要否（実測なし）。
- 視聴者数が非公開の配信（表示されない）での動き → 数が取れず「👤」が出ないだけの想定。
- メンバー限定配信での動き。

## 7. 実装後の確認（headless・Chromium）

| 項目 | 結果 |
| :--- | :--- |
| 「▶ すべて実行」23本 | すべて合格（`D-N3` 45件） |
| `D-L10` | 合格 7/7。見出し `(1 / 🔴 配信中・👤 1,234人)` → 数の変化 → 古い数で消える → 旧アドオンで出ない → `(1 / 配信終了)` |
| `D-W5`（偽のライブ・心拍に視聴者数） | 合格 5/5 |
| アドオンの検証台（本物の `chat_fetcher_main.js` に偽の YouTube を返す `fetch`・localhost） | `updated_metadata` 成功: 5678 / `updated_metadata`・文字「5,678 人が視聴中」・body `{context, videoId}` ／ 403: watch の 1111 / `watch` で表示し失敗を数える ／ watch にも無い: `null`（出さない）／ 応答が返らない: `TIMEOUT 2000ms`。🔴 **4つとも9秒でチャットの要求が9回**（視聴者数の要求がチャットを待たせない） |
| 負の検証（変更前の `index.html`） | `D-L10` / `D-W5` とも不合格 0/1（判定不能ではない） |
| 回帰 `D-L8` / `D-A5` | 合格 |
| 同名関数の検査 | `[]` |
| 用紙 `tests/test_v2_13_0.html` | 🎯 の出力で3つの照合が合格 |
| zip | `v2.13.0.zip`（8ファイル・`manifest.json` 2.13.0）・`v2.12.0.zip` 削除 |

- 🔴 実機で未確認: `updated_metadata` の本物の応答の形と認証の要否・2分ごとの watch の予備経路（検証台では2分待っていない）。
- ⚠️ `tests/test_v2_12_2.html` は v2.12.2 の測定が終わるまで残す（順番に測るため。v2.13.0 をマージするときに消す）。

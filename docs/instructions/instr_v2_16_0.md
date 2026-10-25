# v2.16.0 指示書 ─ 配信中のライブにコメントを投稿する

発行: 2026-10-25（Claude Code）
基点: `index.html` v2.15.1 / アドオン 2.13.0 / `debug_suite.js` v1.25.1
読む仕様書: `get-dev-workflow` / `get-debug-suite` / `get-protocol-spec`（0-2節 採番・4節 メッセージ）/ `get-chat-feature-spec`（1-3-2節 認証ヘッダ・1-6節 ライブ）/ スパイク C1（`docs/instructions/spike_post_c1.md`・`docs/reports/spike_post_c1.md`）
種別: **マイナー（A↔B にメッセージを足す）。🔴 アドオンを上げる（2.13.0 → 2.14.0・`v2.14.0.zip`）**

## 1. やること

要望③（2026-10-08）。スパイク C1（2026-10-25）で「取得エンジンと同じ認証で `send_message` に送れる・`params` は `/live_chat` ページにだけある」と確かめた。

### 1-1. 🔴 利用者の決めごと（2026-10-25）

| 項目 | 決めたこと |
| :--- | :--- |
| 入力欄の場所 | **各ライブ枠のチャット欄の下**（チャット欄を開いていて、取得中のライブの枠だけ） |
| 確認の窓 | **出さない（Enter で送る）** |
| 試験らしい文の制限 | **本番では外す**（スパイクの安全策だった。「テスト期間」のような普通の言葉も止めてしまうため） |
| 🔴 文面 | **定型文・候補・自動入力・前回の文の再利用を作らない。** 毎回、配信の内容に合わせて利用者が手で打つ（「配信は人様の物なのでテストは慎重に」）。送れたら入力欄は空に戻す |

### 1-2. 確認の窓を出さない代わりに作り込むこと

- 🔴 **日本語入力の変換中の Enter で送らない**（`event.isComposing` / `keyCode 229`）。変換の確定のつもりの Enter で投稿するのが最も起きやすい事故。
- **連投しない**: 送っている間は入力欄とボタンを止める・送れてから3秒は次を送れない（`CHAT_POST_COOLDOWN_MS`）。
- 空・200字超は送らない。送れなかったときは**打った文を消さない**（直して送り直せる）。

## 2. 着手前に実コードで確かめたこと

| # | 確認 | 結果 |
| :-: | :--- | :--- |
| 1 | A→B の経路 | A `window.postMessage({type:'CHAT_STREAM_REQUEST'…})` → `content_controller.js` → `runtime 'FETCH_CHAT_STREAM'` → `background.js` `startChatStream`（`ensureChatTab` → `ensureInjected` → `tabs.sendMessage({type:'CHAT_ENQUEUE'})`）→ `content_yt_chat.js`（`PASS_CMD` で選別し `__syncChatCmd` で MAIN へ）→ `chat_fetcher_main.js` |
| 2 | B→A の経路 | エンジン `post({ev…})` → `content_yt_chat.js`（`DROP_EV` は config だけ）→ `runtime 'CHAT_STREAM_EVENT'` → `background.js` `sendChatStreamEvent`（🔴 **転送するフィールドを列挙**している）→ `content_controller.js` `CHAT_STREAM_STATE`（ev → state の対応表・🔴 **ここもフィールドを列挙**）→ A `EXTERNAL_SYNC_EVENT` |
| 3 | 🔴 フィールドの列挙が2か所 | `background.js` と `content_controller.js` の両方に足さないと A に届かない（既知の型 ─ `relativeSeekReport` の `diff` 欠落） |
| 4 | 中継の選別 | `content_yt_chat.js` の `PASS_CMD` に無い命令は捨てる（警告あり）。転送するフィールドも列挙（`requestId / videoId / mode / config`）→ `text`・`dryRun` を足す |
| 5 | 認証 | エンジンの `buildAuthHeaders`（`SAPISIDHASH`・`X-Origin`・`X-Goog-AuthUser: 0`）。スパイクもこの形で通った |
| 6 | キーと文脈 | `cfgFromPage()`（取得タブの ytcfg）、無ければ HTML から（`cfgFromHtml`） |
| 7 | `params` | `/live_chat?is_popout=1&v=ID` の `ytInitialData.contents.liveChatRenderer.actionPanel.liveChatMessageInputRenderer.sendButton.buttonRenderer.serviceEndpoint.sendLiveChatMessageEndpoint.params`（スパイクで実測） |
| 8 | 取得タブの後始末 | ジョブが空になると `scheduleIdleClose`。投稿はジョブに数えない（取得中のライブの枠でしか送らないので、ふだんはジョブがある） |
| 9 | 改行 | アドオンの JS 4本と `manifest.json` は CRLF（鉄則 #49） |
| 10 | チャット欄 | `generateChatPaneHTML(cardId)`。見出しは `updateChatHeadTitle`（状態が変わるたびに呼ばれる） |

## 3. 設計

### 3-1. メッセージ（A↔B に1組足す ＝ マイナー）

| 向き | 名前 | 中身 |
| :--- | :--- | :--- |
| A → B | `CHAT_POST_REQUEST`（window.postMessage） | `requestId, videoId, text, dryRun` |
| B 内 | `POST_CHAT_MESSAGE`（runtime）→ `CHAT_POST`（取得タブへ） | 同じ |
| B → A | `EXTERNAL_SYNC_EVENT` の `state:'chatPost'`（エンジンの `ev:'post'`） | `requestId, videoId, ok, error, canPost, reason, placeholder, httpStatus, echo` |

- `dryRun:true` は**準備だけ**（`params` を取って、投稿できるか・できない理由・入力欄の案内文を返す。送らない）。
- 🔴 送った本文は B から A へ返さない（要らない）。

### 3-2. アドオン（2.14.0）

- `chat_fetcher_main.js`: `CHAT_POST` を受けて `chatPost(d)`。
  - `params` は配信ごとに覚える（`postParams: Map<videoId, {params, at}>`）。無ければ `/live_chat` を読む。
  - 投稿欄が無い（`liveChatRestrictedParticipationRenderer` など）なら `canPost:false`・理由の文言（`message` / `text` の文字）。
  - 送信: `POST /youtubei/v1/live_chat/send_message?key=…&prettyPrint=false`・body `{ context, params, richMessage:{ textSegments:[{ text }] }, clientMessageId }`・ヘッダは `buildAuthHeaders`。打ち切り 15秒（`fetchTimed`）。
  - 🔴 **HTTP 4xx（429 を除く）のときだけ**、`params` を取り直して**1回だけ**送り直す（送れていないことが確かなので二重にならない）。打ち切り・回線エラー・5xx は送り直さない（届いている可能性があるので二重投稿を避ける）。
  - 200 なら `ok:true`。応答に `addChatItemAction`（本文）があれば `echo:true`。
- `content_yt_chat.js`: `PASS_CMD` に `CHAT_POST`、転送に `text`・`dryRun`。
- `background.js`: `POST_CHAT_MESSAGE` → `startChatPost`（`ensureChatTab` → `ensureInjected` → `CHAT_POST`）。失敗は `ev:'post', ok:false`。`sendChatStreamEvent` に `canPost / reason / placeholder / httpStatus / echo`。
- `content_controller.js`: `CHAT_POST_REQUEST` → `POST_CHAT_MESSAGE`。`CHAT_STREAM_STATE` に `post:'chatPost'`・同じ5項目を転送。
- `manifest.json` 2.14.0・`v2.14.0.zip`（`v2.13.0.zip` を削除）。

### 3-3. A側（v2.16.0）

- チャット欄の下に `.chat-post`（`#chatPost_{cardId}`）: 入力欄 `#chatPostInput_`（200字・案内文「コメントを入力（Enter で送信）」）・送るボタン `#chatPostBtn_`・状態 `#chatPostMsg_`。
- 出すのは **取得中のライブ**（`store.live` かつ `chatState === 'streaming'`）のときだけ。`updateChatHeadTitle` の最後で `updateChatPostUI(cardId)`。
- 初めて出すとき（動画ごとに1回）準備（`dryRun`）を送る。結果で入力欄を有効にし、YouTube の案内文（例「チャンネル登録者としてチャット...」）を入力欄の案内に使う。投稿できなければ入力欄を止めて理由を出す。
- 送る: Enter（変換中は除く）またはボタン。送っている間は止める → 結果 `ok` で入力欄を空に・「✓ 送信しました」。失敗は文を残して理由を出す。20秒応答が無ければ「応答がありません」で戻す（`CHAT_POST_TIMEOUT_MS`）。
- 🔴 逃げ道 `CHAT_POST_FEATURE = false` で欄を出さない。
- 版数: `APP_VERSION` 2.16.0・`ADDON_REQUIRED_VERSION` 2.14.0・`APP_HISTORY` 53件・`debug_suite.js` v1.26.0（`D-N3` 53・`EXPECT_ADDON_REQUIRED` 2.14.0）。

## 4. 判定（`debug_suite.js` v1.26.0）🔴 どの判定も実際には投稿しない

| ID | 内容 | PC |
| :--- | :--- | :--- |
| `D-L12` | A側だけ。偽のライブの取得（D-L11 と同じ組み方）・`window.postMessage` を差し替えて要求を捕まえる: 欄が出る・準備（`dryRun`）が1回出る・準備の結果で有効化と案内文・🔴 変換中の Enter で送らない・Enter で `text` と `videoId` が正しい要求・送っている間は止まる・成功で空になる・3秒以内は送らない・失敗で文が残り理由が出る・投稿できない配信で止まり理由が出る・200字超で送らない・アーカイブ（ライブでない）には出ない・応答が無ければ戻る | 偽のライブの見出しが「配信中」 |
| `D-W8` | 実機（ライブ・チャット欄を開く・アドオン 2.14.0）。準備（`dryRun`）だけを送り、15秒以内に `canPost` と理由・案内文が返る。🔴 **送らない** | チャット欄を開いた配信中のライブ枠・心拍が15秒以内 |

- `VERSION_FOCUS` = `D-V1` → `D-V2` → `D-L12` → `D-W8`。
- 🔴 実際の投稿は用紙の目視（R3）で、利用者が配信の内容に合わせて手で打った1回だけ。

## 5. 用紙

`tests/test_v2_16_0.html`。アドオンの入れ直し（2.14.0）→ R1 すべて実行 → R2 🎯（ライブ1枠・チャット欄を開いて）→ R3 目視（🔴 配信を見てから、流れに合った一言を自分で打って Enter で1回だけ・変換中の Enter で送られないこと・送れたら空になること）。

## 6. headless の確認（Chromium）

| 項目 | 結果 |
| :--- | :--- |
| `D-L12`（A側・偽のライブ） | 合格 31/31（PC 4/4）。捕まえた要求がアドオン側へ漏れた数 0 |
| `D-L12` の変異（わざと壊す5通り） | 変換中の Enter の除外を消す／keyCode 229 だけ外す／送れても空にしない／アーカイブにも出す／間隔を外す → いずれも不合格になる |
| `D-W8`（偽のライブ・偽のアドオン） | 投稿できる配信で合格 6/6・投稿できない配信（メンバー限定モード）では「投稿できる配信と判定」が不合格で理由が note に出る。🔴 送信の要求 0 |
| 取得エンジンの `CHAT_POST`（偽の youtube.com・`chat_fetcher_main.js` を MAIN に注入） | 準備: 投稿できる・案内文・`send_message` を叩かない／送信: 1回・200・本文の一致・覚えた `params` を使う（`/live_chat` を読み直さない）・要求の形（`params`・本文の前後の空白を除く・`clientMessageId`・`context`・`key`・`SAPISIDHASH`・`X-Origin`・`X-Goog-AuthUser: 0`）／400 → `params` を取り直して1回だけ送り直す → 成功／400 が続くと2回で止める／500・429 は送り直さない／打ち切り（15秒）は送り直さず「届いたかどうか分からない」と返す／メンバー限定モード: 準備で `canPost:false`・理由・送らない／チャットの無い配信: 理由／空・201字は送らない／結果に Cookie・`params`・ハッシュが載らない ─ 13項目すべて合格 |
| 回帰 `▶ すべて実行`（23本） | 23本すべて合格 |
| 関連の手動判定 | `D-B1` `D-B2` `D-B3` `D-B5` `D-B6` `D-L8` `D-L10` `D-L11` `D-A5` `D-A7` 合格 |
| 旧版（v2.15.1）に v1.26.0 を当てる | `D-V1`（版数）・`D-N3`（52件）・`D-L12`・`D-W8`（投稿欄が無い）が不合格になる。`D-V2` は合格（照合の仕組みは変わらない） |
| 用紙 `tests/test_v2_16_0.html` | R2（🎯）を貼って3つの照合が合格 |

実装中に足したもの:
- 失敗したあとも3秒は送り直させない（打ち切りの失敗は届いている可能性があるので、すぐの送り直しで二重投稿にしない）。エンジンも `send_message` を叩いたあとの例外は「届いたかどうか分からない」と返す。
- 動画が変わったら前の動画の知らせ（「✓ 送信しました」など）を消す。
- 入力欄と送るボタンを1行に収める（細いチャット欄で送るボタンが2行目へ落ちていた）。
- 🔴 `escapeHtmlAttr` が `index.html` に2つあった（v2.8.11 と v2.11.2 で別々に足した・中身は同じ）。`tests/check_dup_functions.js index.html` で見つけ、後の方を消した（管理側の誤り ─ v2.11.2 で重複の確認を `debug_suite.js` にしかしていなかった）。

## 7. 測れなかった値・未確認（実装前）

- 投稿できない配信（メンバー限定・登録者限定・低速モード）での送信時のエラーの形。
- `params` の有効期限（同じ配信で何回使えるか）。4xx で1回取り直す設計で吸収する見込み。
- 9枠で複数のライブに同時に投稿したとき（取得タブは1枚・要求は順に処理）。
- 「▲ 操作メニュー」のつまみ（画面の下の中央）が、枠の並び方によっては投稿欄の送るボタンに重なる（headless の2枠で重なった）。Enter で送れるので実害は小さい見込み → 用紙 R5 で見る。
- 実機の Firefox のアドオン経路（`content_controller` → `background` → `content_yt_chat` → エンジン）は headless で通せない。フィールドの列挙2か所は目で確かめた → 用紙 R2（`D-W8`）で確かめる。

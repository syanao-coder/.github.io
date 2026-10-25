# スパイク C1 指示書 ─ 配信中のライブにコメントを投稿できるか

発行: 2026-10-25（Claude Code）
基点: `index.html` v2.15.1 / アドオン 2.13.0（**本番コードへの変更なし**）
読む仕様書: `get-dev-workflow`（1-4節・3-1-2節「スパイクに限り計測スニペット」）/ `get-chat-feature-spec`（1-3-2節 認証ヘッダ・1-6節 ライブ）/ `get-protocol-spec`（11節 要望③）
種別: **版数を切らないスパイク。** 成果物は `tests/spike_post_c1.js`（YouTube のページのコンソールに貼る計測コード）と `tests/test_spike_post_c1.html`（用紙）。撤退はファイルの削除だけ。

## 1. きっかけ

要望③（2026-10-08）: 配信中の動画へ、このツールからコメントを投稿したい。2026-10-25 利用者選択「1で」（コメント投稿の下調べ）。

🔴 結果によって、続きが「アドオンを変える版（マイナー）」か「撤退」かが決まる → スパイク（1-4節）。

## 2. 前提（実コードと仕組みで確かめたこと）

| # | 確認 | 結果 |
| :-: | :--- | :--- |
| 1 | 取得の仕組み | アドオンの取得エンジン（`chat_fetcher_main.js`・YouTube のタブの MAIN world）が `POST /youtubei/v1/live_chat/get_live_chat` を叩く。キーと文脈は `ytcfg`（無ければ HTML から） |
| 2 | 認証 | v2.7.5 から `SAPISIDHASH`（`Authorization`・`X-Origin`・`X-Goog-AuthUser: 0`）＋ `credentials:'include'`。Cookie 名は `SAPISID` / `__Secure-3PAPISID` / `__Secure-1PAPISID` |
| 3 | 続きの番号の出どころ | watch ページの `conversationBar.liveChatRenderer`。🔴 **投稿欄（`actionPanel`）は watch ページには無い見込み**（`/live_chat` ページの `contents.liveChatRenderer.actionPanel` にある）→ 計測で確かめる |
| 4 | 投稿の口（公開情報からの見込み・未実測） | `POST /youtubei/v1/live_chat/send_message`・body `{ context, params, richMessage:{ textSegments:[{ text }] }, clientMessageId }`。`params` は `actionPanel.liveChatMessageInputRenderer.sendButton.buttonRenderer.serviceEndpoint.sendLiveChatMessageEndpoint.params` |
| 5 | 投稿できない場合 | 非ログイン・メンバー限定モード・登録者限定・チャット停止・低速モード・自分が制限されている、など。`actionPanel` が `liveChatMessageInputRenderer` 以外（例 `liveChatRestrictedParticipationRenderer`）になる見込み |
| 6 | 🔴 外に出る操作 | 投稿は**利用者のアカウントで YouTube のチャットに残る**（取り消しはチャットの ⋮ → 削除）。計測コードは利用者が本文を打ち、確認の窓で「投稿する」を選んだときだけ1回送る |

## 3. 計測コード（`post-c1-1.0.0`）

`https://www.youtube.com/` のどのページでもよい（コンソールの実行先は「Top」のまま）。画面の右上にパネルを出す。

| ID | 中身 | 送るか |
| :--- | :--- | :--- |
| `D-P1` | 動画 ID（URL でも可）を受け取り、① `/live_chat?is_popout=1&v=ID` の HTML から `liveChatRenderer`・`actionPanel`・`params` を探す ② ログイン（認証用の Cookie）・認証ヘッダの組み立て・キーと文脈 ③ watch ページの `liveChatRenderer` に `actionPanel` があるか ④ `get_live_chat` の応答に `actionPanel` があるか（今の取得エンジンだけで `params` を得られるかの手がかり） | 🔴 **送らない**（読むだけ） |
| `D-P2` | 本文（200字まで）を、確認の窓で「投稿する」を選んだときだけ1回 `send_message` へ送る。HTTP の状態・応答の形（中身は出さず、キーの名前と有無だけ）・🔴 **`get_live_chat` を最大3回（5秒ごと）読んで、送った本文がチャットに出たか**。送ったあと15秒はボタンを押せない（二重送信の防止） | 🔴 **1回送る**（利用者の確認つき） |

- 付けるヘッダ: 取得エンジンと同じ（`Authorization: SAPISIDHASH …`・`X-Origin`・`X-Goog-AuthUser`）＋ `X-Youtube-Client-Name` / `Version`。`X-Goog-AuthUser` は `ytcfg` の `SESSION_INDEX`（無ければ 0）。ブランドアカウントで使っている場合（`DELEGATED_SESSION_ID` がある）は `X-Goog-PageId` も付け、付けたかを記録する。
- 🔴 **出力に載せないもの**: Cookie の値・ハッシュ・`params` の中身（長さだけ）・チャンネル名やアイコン（有無だけ）・応答の本文。
- 出力の書式は `debug_suite.js` と同じ（用紙の3つの照合が効く）。

## 4. 結果の読み方（次の一手）

| 結果 | 次の一手 |
| :--- | :--- |
| `D-P2` で HTTP 200・チャットに出た | **作れる。** 設計を詰めて版にする（アドオン: 取得タブで `params` を取り送る口・A側: 枠のチャット欄に入力欄、確認・連投防止）。`params` を `get_live_chat` / watch から取れるかで、取得タブが `/live_chat` ページを別に読む必要があるかが決まる |
| HTTP 200 だがチャットに出ない | 保留（審査待ち・スパム判定の可能性）。YouTube の画面からの投稿と同じか比べる |
| 401 / 403 / エラー | 認証の組み立て（`SESSION_INDEX`・`X-Goog-PageId`）を見直してもう一度。直らなければ撤退か、YouTube のチャット欄（埋め込み）を出す案へ |
| `actionPanel` が投稿欄でない | その配信では投稿できない（理由の文言を記録）。別の配信で再測 |

## 5. headless の確認（Chromium・偽の YouTube）

`https://www.youtube.com/**` を Playwright の `route` で差し替えた検証台（`/live_chat`・`/watch`・`get_live_chat`・`send_message` を偽物で返す。Cookie `SAPISID` を入れる）。

| 項目 | 結果 |
| :--- | :--- |
| YouTube 以外で貼る | 「https://www.youtube.com/ のページで…」と出て何もしない |
| `D-P1`（投稿できる配信） | 合格 5/5（PC 3/3）。キーと文脈は ytcfg から・watch の `liveChatRenderer` に `actionPanel` ない・`get_live_chat` の応答にもない（偽物の設定どおり） |
| `D-P1`（ytcfg の無いページ） | キーと文脈を `/live_chat` の HTML から取れた |
| `D-P1`（メンバー限定モード） | 不合格（投稿欄なし・params なし）・理由の文言「メンバー限定モードがオンです」を記録 |
| `D-P1`（Cookie なし） | 「ログイン済み」「認証ヘッダ」が不合格 |
| `D-P2` 確認の窓で「キャンセル」 | 判定不能（取りやめ）・🔴 `send_message` は1回も送られない |
| `D-P2` 「OK」 | 合格 2/2。送った要求: `Authorization: SAPISIDHASH …`・`X-Origin`・`X-Goog-AuthUser: 0`・`X-Youtube-Client-Name: 1`・body に `params`・本文・`clientMessageId`・`context`。チャットの流れに1回目の読み直しで出た |
| 続けて「送る」 | 「前回の送信から15秒」が不成立で判定不能・🔴 送られない（送信は合計1回） |
| 🔴 出力の漏れ | Cookie の値・`params` の中身・チャンネル名は出力に無い |
| 用紙 `tests/test_spike_post_c1.html` | 計測コードの写しが原本と一致・3つの照合が合格（R1 は D-P1・R2 は D-P1 と D-P2） |

## 6. 測れなかった値・未確認（実施前）

- 🔴 本物の YouTube の `send_message` の応答の形・認証の要否はこのプロジェクトで一度も実測していない（この環境からは YouTube に繋がらない）。
- 本番はアドオンの取得タブ（MAIN world）から送る。計測コードは YouTube のページのコンソール（同じ MAIN world・同じオリジン）なので、条件は近い。
- 低速モード・登録者限定・メンバー限定の配信での文言（出会った配信で記録する）。

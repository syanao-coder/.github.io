# スパイク C1 記録 ─ 配信中のライブにコメントを投稿できるか

測定: 2026-10-25（利用者・Floorp・UA `Firefox/158.0`・Windows）
指示書: `docs/instructions/spike_post_c1.md` / 計測コード `post-c1-1.0.1` / 用紙 `tests/test_spike_post_c1.html`
素材: 他人の配信 `kKTA2s2g9gw`（利用者が配信の内容に合わせて自分で考えた6字の一言を1回だけ投稿）

## 1. 結論

- 🔴 **作れる。** 取得エンジンと同じ認証（`SAPISIDHASH`・`X-Origin`・`X-Goog-AuthUser: 0`・`credentials:'include'`）で `POST /youtubei/v1/live_chat/send_message` が **HTTP 200**、送った本文が **`get_live_chat` の1回目の読み直しで流れに出た**。利用者の目でも YouTube のチャット欄に出た。
- 🔴 **送るための `params` は `/live_chat` ページにしか無い。** watch ページの `liveChatRenderer` にも `get_live_chat` の応答にも `actionPanel` は無かった → 本番では取得タブが配信ごとに1回 `/live_chat?is_popout=1&v=ID` を読んで `params` を得る必要がある。
- 変更ファイル: なし（本番コードへの変更なし）。プロトコル変更なし。
- 測定環境: Floorp・ログイン済み（`SAPISID`）・ブランドアカウントではない（`DELEGATED_SESSION_ID` なし）。

## 2. 実測（事実）

| 項目 | 値 |
| :--- | :--- |
| `D-P1` | 合格 5/5（PC 3/3）。`/live_chat` HTTP 200・キーと文脈は ytcfg から・`actionPanel` = `liveChatMessageInputRenderer`・`params` 88文字 |
| 投稿欄の子 | `authorName, inputField, sendButton, pickers, pickerButtons, authorPhoto, targetId, onInitialFocusCommand, emojiPickerButton, jewelsGiftsButton` |
| 入力欄の案内文・上限 | 「チャンネル登録者としてチャット...」/ `maxCharacterLength` なし |
| watch の `liveChatRenderer` / `get_live_chat` の `actionPanel` | ない / ない（HTTP 200） |
| `D-P2` | 合格 2/2（PC 5/5）。HTTP 200・1191ms・応答の上位 `responseContext, actions`・応答に本文が返った（一致）・流れに1回目で出た |

## 3. 測れなかった値

- 投稿できない配信（メンバー限定・登録者限定・低速モード・チャット停止・自分が制限されている）での `actionPanel` の文言と、送ったときのエラーの形。今回の配信は投稿できる状態だった。
- 低速モードの間隔・連投の制限（YouTube 側の拒否の形）。
- ブランドアカウント（`X-Goog-PageId`）での送信。
- `params` の有効期限（同じ配信で何回使えるか・時間で切れるか）。今回は1回だけ。
- ほかの視聴者の画面に出たか（ログアウトした別の画面）。利用者の画面と自分の取得には出た。
- 「応答の actions の種類」の観測は、各 action の最初のキー（`clickTrackingParams`）を拾っていた（計測コードの書き方の不備 ─ 2種類目のキーが `addChatItemAction` だったと考えられる。本文の一致は別に確かめた）。

## 4. 指示書との差異・手戻り

- 指示書 2節 #3 の見込み（`actionPanel` は watch に無く `/live_chat` にある）が実測で確定。`get_live_chat` の応答にも無い。
- 入力欄の案内文から、この配信は「チャンネル登録者として」投稿する状態だった（登録者限定モードかどうかは区別できない）。

## 5. 管理側の誤り

- 3節の「応答の actions の種類」の取り方（`Object.keys(a)[0]`）。結論に影響なし。

## 6. 規約の新設

なし。利用者指示（2026-10-25）「配信は人様の物なのでテストは慎重に。文面は定型ではなく、都度配信内容を聞いて違和感ないものを手動で入力する仕様」は指示書 2-1節に要件として記録（本番の版の指示書へ引き継ぐ）。

## 7. 次

- 本番に組み込む版（マイナー・A↔B にメッセージが増える・アドオン 2.14.0）を提案する。利用者の確認を取ってから指示書に入る。
- 案: A側のライブ枠のチャット欄の下に入力欄 → `CHAT_POST_REQUEST` → 取得タブが `/live_chat` で `params` を得て（配信ごとに覚える）`send_message` → `CHAT_POST_RESULT`。投稿できない配信は理由の文言を入力欄の代わりに出す。

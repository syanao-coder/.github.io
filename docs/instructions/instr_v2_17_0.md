# v2.17.0 指示書 ─ ログインしていないときに、投稿欄からログイン画面を開く

発行: 2026-10-26（Claude Code）
基点: `index.html` v2.16.0 / アドオン 2.14.0 / `debug_suite.js` v1.26.0
読む仕様書: `get-dev-workflow`（鉄則 #54）/ `get-debug-suite`（9-B-18節）/ `get-protocol-spec`（0-2節・4節 `chatPost`）/ `get-chat-feature-spec`（1-3-2節 認証ヘッダ・1-7節 投稿）
種別: **マイナー（`chatPost` に `needLogin` を足す）。🔴 アドオンを上げる（2.14.0 → 2.15.0・`v2.15.0.zip`）**

## 1. やること

利用者の質問（2026-10-26）「ログインしていない際にログイン画面を出すことは出来る？」→ 案 A を選択。

- アドオンが「YouTube にログインしていない」を判定して A側へ伝える（`needLogin`）。
- A側はそのときだけ、投稿欄に「🔑 YouTube にログイン」ボタンを出す。押すと新しいタブで Google のログイン画面（続きは YouTube）を開く。
- コントローラーのタブへ戻ったら（`focus` / `visibilitychange`）、ログイン待ちの準備をやり直す → ログインできていれば入力欄が使える。
- あわせて v2.16.0 の不具合を直す: 準備の結果を動画ごとに覚えて問い合わせ直さないので、止まったあとにログインしても同じ配信ではページを読み直すまで止まったままだった → 🔄 でも準備をやり直す。
- ⚠️ ログイン画面をコントローラーの中に埋め込むことはできない（Google が他のページへの埋め込みを禁じている）。案 B（理由を問わずボタン）は「メンバー限定モード」などでもログインを促してしまうので採らない。

## 2. 着手前に実コードで確かめたこと

| # | 確認 | 結果 |
| :-: | :--- | :--- |
| 1 | ログインの手がかり | エンジンの `pickAuthCookie(document.cookie)`（`SAPISID` / `__Secure-3PAPISID` / `__Secure-1PAPISID`）。投稿の認証ヘッダ（`buildAuthHeaders`）と同じ Cookie。取得タブは youtube.com のトップレベルのタブなので、利用者がログインすればそのまま見える |
| 2 | v2.16.0 のログアウト時 | Cookie が無くても `/live_chat` を読み、`actionPanel` の中身で `canPost:false`。理由は YouTube の文か「ログインしていないか、この配信には投稿できません」。ログインを案内する手段は無い |
| 3 | 準備の覚え方 | `chatPostPrep[videoId]` は一度決まると消さない（`reloadChat` も触らない）→ 1節の不具合 |
| 4 | 投稿の文脈 | v2.16.0 は覚えた `params` で送るとき `cfgFromPage()`（取得タブを開いたときの `ytcfg`）を使う。ログイン前に開いたタブだとログアウト時の文脈のまま → `/live_chat` の HTML の `ytcfg`（`cfgFromHtml`）を先に使い、`params` と一緒に覚える |
| 5 | 中継 | `needLogin` も `background.js` の `sendChatStreamEvent` と `content_controller.js` の `CHAT_STREAM_STATE` の両方で列挙が要る（7-4節の罠） |
| 6 | 戻ってきたときの合図 | `content_controller.js` が YouTube の許可を `focus` で問い合わせ直している前例あり（4-1節） |

## 3. 設計

### 3-1. アドオン（2.15.0）

- `chat_fetcher_main.js` `loadPostParams`: 🔴 認証の Cookie が無ければ `/live_chat` を読まずに `{ canPost:false, needLogin:true, reason:'YouTube にログインしていません' }`。あれば従来どおり（`needLogin:false`）。`cfg` は `cfgFromHtml(html) || cfgFromPage()`、`postParams` に `cfg` も覚える。
- `chatPost`: 結果に `needLogin`（準備の結果、または送れなかったときに Cookie が無い）。
- `background.js` / `content_controller.js`: `needLogin` を転送。
- `manifest.json` 2.15.0・`v2.15.0.zip`（`v2.14.0.zip` を削除）。

### 3-2. A側（v2.17.0）

- 投稿欄にボタン `#chatPostLogin_{cardId}`「🔑 YouTube にログイン」。`chatPostPrep[videoId]` が `blocked` かつ `needLogin` のときだけ出す。
- 押す → `window.open(CHAT_POST_LOGIN_URL, '_blank')`（クリックの中で同期的に呼ぶ）。`CHAT_POST_LOGIN_URL` は YouTube の「ログイン」と同じ形（`accounts.google.com/ServiceLogin?service=youtube…&continue=https://www.youtube.com/signin?action_handle_signin=true…`）。
- 戻った（`window` の `focus` / `document` が `visible`）→ `blocked` かつ `needLogin` の準備を消して、出ている欄を描き直す（＝準備を1回やり直す）。ログイン待ちでない `blocked`（メンバー限定など）はやり直さない。
- 🔄（`reloadChat`）→ その動画の準備を消す（理由を問わず。次に欄を出すとき1回やり直す）。
- 送信の失敗で `needLogin` が返ったら `blocked`＋`needLogin`（ボタンを出す）。
- 版数: `APP_VERSION` 2.17.0・`ADDON_REQUIRED_VERSION` 2.15.0・`APP_HISTORY` 54件・`debug_suite.js` v1.27.0（`D-N3` 54・`EXPECT_ADDON_REQUIRED` 2.15.0）。

## 4. 判定（`debug_suite.js` v1.27.0）🔴 どの判定も投稿しない（鉄則 #54）

| ID | 内容 | PC |
| :--- | :--- | :--- |
| `D-L13` | A側だけ。偽のライブ（`D-L12` と同じ組み方）で `window.postMessage` と `window.open` を差し替える（ログイン画面は開かない）: 準備の結果 `needLogin` でボタンが出て入力欄は止まる・押すと `window.open` に Google のログイン画面（`service=youtube`・続きが youtube.com）・`focus` で準備を1回やり直す・`ready` でボタンが消え入力欄が使える・ログイン待ちでない `blocked` ではボタンを出さず `focus` でもやり直さない・🔄 で準備をやり直す・送信の失敗の `needLogin` でボタンが出る・捕まえた要求が漏れない | 偽のライブの見出しが「配信中」・ボタンがある |
| `D-W9` | 実機（**ログインしていない**ブラウザ・ライブ・チャット欄を開く・アドオン 2.15.0）。準備をやり直し、15秒以内に `needLogin` が返りボタンが出る。🔴 送らない・ボタンは押さない | ライブ枠・心拍が15秒以内 |

- `VERSION_FOCUS` = `D-V1` → `D-V2` → `D-L13` → `D-L12`（`D-W8` / `D-W9` はログインの状態で分けて個別に押す）。

## 5. 用紙

`tests/test_v2_17_0.html`。ログアウトした状態は**新しい Floorp のプロファイル**で作る（普段のプロファイルのログインに触らない）。
T1 アドオンの入れ直し（普段のプロファイル）→ R1 すべて実行 → R2 🎯 → R3 普段のプロファイルでライブ・`D-W8`（ログイン済みは従来どおり `ready`）→ 新しいプロファイルを作ってアドオンを読み込む → R4 ライブ・`D-W9`（ボタンが出る）→ R5 目視: ボタンを押してログインし、コントローラーへ戻ると数秒で入力欄が使える（🔴 投稿はしない）。

## 6. headless の確認（Chromium）

| 項目 | 結果 |
| :--- | :--- |
| `D-L13` | 合格 15/15（PC 4/4）。開こうとした URL `https://accounts.google.com/ServiceLogin?service=youtube&uilel=3&passive=true&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue…`（開かずに捕まえた）・捕まえた要求の漏れ 0 |
| `D-L13` の変異（5通り） | 理由を問わずボタンを出す／戻ってもやり直さない／🔄 でやり直さない／ログイン待ちでない「投稿できない」も戻るとやり直す／送信の失敗の `needLogin` を無視 → いずれも不合格。旧版（v2.16.0）は「案内がある」が不合格 |
| `D-L12` | 32/32。🔴 v2.16.0 の「準備済みの動画では出し直さない」（`startStream` が `reloadChat` ＝ 🔄 を呼ぶ）は、今回わざと変えた動き（🔄 で準備をやり直す）とぶつかったので、「🔄 で1回やり直す・結果で使える」へ書き換えた。コメントが届いても出し直さない判定は残っている |
| `D-W9`（偽のライブ・偽のアドオン） | `needLogin` で合格 6/6・メンバー限定（`needLogin:false`）では不合格になる。送信の要求 0 |
| 取得エンジン（偽の youtube.com） | v2.16.0 の13項目＋6項目すべて合格: Cookie なしの準備は `/live_chat` を読まずに `needLogin`／Cookie なしの送信は送らない／覚えた `params` で送って 401・Cookie なし → `needLogin`（送り直さない）／Cookie を入れたあとの準備は使える／ログイン後の送信は `/live_chat` の HTML の `ytcfg` のキーで送る／ログインしていて投稿できない配信は `needLogin:false`。結果に Cookie・`params` が載らない |
| 回帰 `▶ すべて実行` | 23本すべて合格 |
| 用紙 `tests/test_v2_17_0.html` | R2（🎯）を貼って3つの照合が合格 |

## 7. 測れなかった値・未確認（実装前）

- 実機のログアウト時に YouTube の `/live_chat` が返す `actionPanel`（v2.17.0 は Cookie が無ければ読まないので、今後も見えない）。
- ログイン直後の送信で `/live_chat` の HTML の `ytcfg` を使う経路（R5 では投稿しないので、送信までは確かめない）。
- ブランドアカウント・複数アカウント（`X-Goog-AuthUser: 0` 固定）。
- 戻ったときのやり直しは `focus` で試した。`visibilitychange` は headless で合成できないので未試験（実機の R5 で見る）。

## 8. 次（利用者と合意 2026-10-26）

- スパイク: YouTube の視聴履歴（InnerTube `browse`・`FEhistory`）が取れるか・応答の形・枠の中の YouTube で見た動画が履歴に載るか。
- 結果が良ければ、枠の「🕒 最近使った動画」と **YouTube の履歴を共存**させる（2列で両方 or 切り替え ─ 利用者の希望。どちらにするかはスパイクのあと）。マイナーの見込み。→ ④で `get-protocol-spec` 11節へ載せる。

# v2.11.0 指示書 ─ ライブ配信のチャット取得の自動復帰＋終了理由コード

発行: 2026-10-04（Claude Code）
基点: `index.html` v2.10.0 / アドオン 2.10.0 / `debug_suite.js` v1.17.1
読む仕様書: `get-dev-workflow` / `get-debug-suite` / `get-chat-feature-spec`（1-6節・8-13節）/ `get-protocol-spec`（4節・11節 v2.11.0 の注記・持ち越し2〜4）
種別: **マイナー（`chatDone` に終了理由コードと復帰の記録、`chatChunk` に復帰回数を追加）。🔴 アドオンを上げる（2.10.0 → 2.11.0・`v2.11.0.zip`）**
進め方: 利用者の指示（2026-10-04）で**ライブ素材の測定時期が未定のまま実装だけ先に進める**。実機の測定は後日。

## 1. やること

ライブのチャット取得が途中で止まり「配信終了」と表示される不具合（利用者は 🔄 の再取得で直していた）を、**自動で復帰させる**。あわせて**なぜ終わったか**を A側へ渡す。

## 2. 着手前に実コードで確かめたこと

| # | 確認 | 結果 |
| :-: | :--- | :--- |
| 1 | ライブ経路の出口（11節の注記） | ① `if (!lc) break;`（`liveChatContinuation` も `messageRenderer` も無い）② `if (!next) { cont = null; break; }` ③ `reqs >= MAX_REQUESTS`（4000回＝約11時間）。どれも `done / ok:true / live:true` |
| 2 | 🔴 **注記に無い4つ目の出口** | `postChat()` は 429 / 5xx を3回再試行したあと**例外を投げる**。ライブでは一時的な回線の乱れで**取得全体が `ok:false` で終わる** |
| 3 | `messageRenderer`（チャット無効）の扱い | 1回目でも途中でも `CHAT_DISABLED` で例外。ライブの途中で返った場合（配信終了直後の可能性）も失敗になる |
| 4 | 重複の排除 | `toComment()` が `r.id` で排除済み（`job.seen`）。**復帰で取り直した continuation が直前のコメントを再送しても二重にならない** |
| 5 | 表示の切替（v2.10.0） | 取り直した continuation は「上位」側を指すので、`switched = false` に戻して1回目と同じ切替を通す |
| 6 | 中継 | `background.js` の `sendChatStreamEvent` と `content_controller.js` は**フィールドを名指しで転送**（7-4節の罠）。新しいフィールドは2か所に足す |

## 3. 設計

### 3-1. B側（`chat_fetcher_main.js`）

- ライブのとき、出口①②・途中の `messageRenderer`・`postChat` の例外を「**出口**」として扱い、すぐには終わらせない。出口の種類を `liveExits`（`noLc` / `noNext` / `disabled` / `error`）に数える。
- 出口では **watch ページを取り直して復帰を試みる**（`recoverLive`）:
  - 🔴 **配信中でなくなっていれば**（`detectLiveNow` が false）→ 終了理由 **`ENDED`** で終える（＝本当の配信終了）。
  - 配信中なら `liveChatRenderer` から continuation を取り直して取得を続ける（`liveRecovers` を1つ増やす）。
  - 取り直せなければ待って再試行。待ち時間は 5秒から倍々（上限60秒）。
- **連続して何回出口に来たか**（`streak`）を数え、正常な応答が1回来たら0に戻す。`streak` が `LIVE_RECOVER_MAX`（8回 ≒ 5分）を超えたら終了理由 **`RECOVERY_FAILED`** で終える。
- ライブの上限は `LIVE_MAX_REQUESTS`（20,000回 ≒ 55時間）。超えたら **`MAX_REQUESTS`**。
- `done` に `endReason` / `endBy` / `liveRecovers` / `liveExits` / `recoverError`、`chunk` に `liveRecovers` を載せる。🔴 アーカイブ経路は変えない（`endReason` は付けない）。

### 3-2. A側

- `chatDone` / `chatChunk` の新しいフィールドを store に持つ。
- 見出し（ライブ）: 取得中は「🔴 配信中」（復帰したら「・復帰N回」）。終わったら `ENDED`＝「配信終了」、`RECOVERY_FAILED`＝「途切れました（🔄で再取得）」、`MAX_REQUESTS`＝「長時間のため打ち切り（🔄で再取得）」。`endReason` が無い（旧アドオン）は従来どおり「配信終了」。

### 3-3. 版数

`APP_VERSION` 2.11.0・`ADDON_REQUIRED_VERSION` 2.11.0・`manifest.json` 2.11.0・`v2.11.0.zip`・`APP_HISTORY` 39件・`debug_suite.js` v1.18.0。

## 4. 判定

| ID | 内容 | 素材 |
| :--- | :--- | :--- |
| `D-L8` | A側だけ。偽のライブの取得を `chatPending` に登録し、`chatChunk` / `chatDone` を直接流して、終了理由ごとの見出し（配信中・復帰N回・配信終了・途切れ・打ち切り・旧アドオン）を確かめる | 不要 |
| `D-L9` | 実機。開いているライブ枠すべての取得状況（`livePolls` / `liveRecovers` / `liveExits` / `endReason`）を記録する（持ち越し3: 配信終了時の挙動の観測） | 🔴 ライブ |

- 🔴 **B側の復帰の流れは debug_suite から届かない。** 取得エンジンを本物のまま読み、`fetch` を差し替えた検証台で headless 確認する（6節）。
- 持ち越し2（同時ポーリングの負荷）・4（ライブでの解放）は実機の測定時に用紙で行う。

## 5. 用紙

`tests/test_v2_11_0.html`（ライブの素材は測定日に利用者が選ぶ。用紙に選び方を書く）。

## 6. 実装後の確認（headless）

取得エンジン（`chat_fetcher_main.js`）を本物のまま `https://www.youtube.com/` のページに読み、`fetch` だけを差し替えた検証台（watch HTML と `get_live_chat` の応答を場面ごとに作る）。

| 場面 | 新エンジン | 変更前のエンジン |
| :--- | :--- | :--- |
| 5回目の応答に `liveChatContinuation` が無い（出口①）→ 後で `continuations` が空（出口②）・その時点で配信終了 | 復帰1回で取得が続き、②で watch を見て **`ENDED`（`isLiveNow`）**。出口 `{noLc:1, noNext:1}`。再送されたコメントは重複せず 14件 | 🔴 **5回目で「配信終了」として止まる（6件）**＝利用者の症状を再現 |
| 4〜6回目が HTTP 500（再試行3回を使い切る＝出口④） | 復帰1回で続き、のちに `ENDED`。`recoverError: HTTP 500` | 🔴 **取得全体が `ok:false`（HTTP 500）で失敗** |
| 3回目以降ずっと 500・watch も 500 | 8回の再試行のあと **`RECOVERY_FAILED`** | ─ |
| 途中でチャット無効の通知（`messageRenderer`）・その時点で配信終了 | 失敗にせず **`ENDED`**。出口 `{disabled:1}` | ─ |
| 上限（試験用に `LIVE_MAX_REQUESTS=6`） | **`MAX_REQUESTS`**・`truncated:true` | ─ |

- A側: `D-V1` / `D-V2` / `D-L8`（7/7）合格。負の検証: 変更前の `index.html` に当てると `D-L8` **不合格 2/7**（判定不能ではない）。
- 「▶ すべて実行」23本（file://・アドオン版数 2.11.0 を偽装）: すべて合格。
- 🔴 **実機で未確認**: 本物のライブで出口①②④がどの頻度で起きるか（11節の仮説）・本物の配信終了で `isLiveNow` が false になるまでの遅れ（遅れると `RECOVERY_FAILED` 側へ倒れうる。上限は約5分）。用紙の R3・R4 で測る。

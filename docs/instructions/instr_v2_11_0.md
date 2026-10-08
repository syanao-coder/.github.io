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

## 7. 再測（2026-10-08）─ 実機測定で見つかった不具合の修正

### 7-1. 実機の結果（1回目）

| 項目 | 結果 |
| :--- | :--- |
| R1 / R2 | 23/23・`D-L8` 7/7 合格 |
| R3（配信中） | `bX4t7sNnYbs`・state=streaming・4,645件・復帰0・出口 `{}` |
| 🔴 R4（配信終了後） | **見出しが「配信中」のまま変わらない**（29,762件・endReason なし）。`D-L9` は「streaming なら合格」の判定だったため**合格になった**（判定の誤り。7-4） |
| 後日（同日中）の観測 | 終了からかなり後に「配信終了」へ変わった。`D-L9`: state=ready・36,147件・polls=496・**出口 `{"noLc":1}`・復帰0・ENDED** |
| FREE | 準備中に何度か止まり、🔄 で直した（自動では戻らなかった） |

結論: **YouTube は配信が終わっても `get_live_chat` に普通の応答（continuation つき）を返し続ける。** 出口（11節の仮説①②）に来るのはずっと後で、そのとき初めて watch を見て `ENDED` になる。v2.11.0 の設計は「出口に来たら確かめる」だけだったので、配信終了をすぐには検知できなかった。

### 7-2. 原因の候補をコードで確かめた結果

| # | 経路 | 変更前の挙動 |
| :-: | :--- | :--- |
| 1 | 終了後も応答が続く | 出口に来ないので「配信中」のまま（R4） |
| 2 | 🔴 `postChat` に打ち切りが無い | 応答が返らないと `await` のまま固まる。**心拍は別のタイマーで出続ける**ので A側の見張り（45秒）も働かず、「配信中」のまま止まる（FREE の「止まった」の候補） |
| 3 | 🔴 `recoverLive` が watch の `playerResponse` を読めない（同意画面など） | `detectLiveNow(null)` が `live:false / by:'none'` を返し、**配信中なのに `ENDED`**（v2.11.0 前からある「途中で配信終了」の候補） |
| 4 | 取得タブが落ちる（メモリ不足でのタブの破棄など） | 心拍が止まり、A側の見張りが `failChat` → `endReason` が無いので見出しは**「配信終了」** |
| 5 | `livePolls` などは `done` でしか送っていない | 取得中の `D-L9` は polls=0 のままで、様子が見えなかった |

### 7-3. 修正（版数は 2.11.0 のまま。未締めの版の手直し）

- B側（`chat_fetcher_main.js`）
  - 正常な応答が続いていても `LIVE_CHECK_INTERVAL_MS`（120秒）ごとに `recoverLive` で watch を見て、配信中でなければ `ENDED`（`liveChecks` / `lastCheck` に記録）。最初の watch を1回目の確認とみなす。
  - ライブの要求に打ち切りを付けた（`fetchTimed`: 本文の読み出しまで含めて `LIVE_FETCH_TIMEOUT_MS` 20秒、watch は `LIVE_WATCH_TIMEOUT_MS` 30秒）。打ち切りは `TIMEOUT` として再試行 → 出口 → 復帰。🔴 アーカイブの取得は変えない。
  - `detectLiveNow` の材料が無い（`by:'none'`）ときは `ENDED` にせず `NO_PLAYER_RESPONSE` で待って再試行。
  - 心拍の `active` にライブの観測値（`live` / `livePolls` / `liveRecovers` / `liveExits` / `liveChecks` / `lastCheck` / `livePhase`（`poll` / `recover`）/ `lastOkAgoMs` / `lastCommentAgoMs` / `recoverError`）。中継は `active` を丸ごと転送するので、中継の変更は要らない。
- A側（`index.html`）
  - `handleChatPing` が観測値を store に入れる（`livePingAt`）。`livePhase==='recover'` のあいだ見出しは「🔴 再接続中」。
  - ライブの取得が落ちた（`failChat`）ときは A側の理由 `STALLED` を置き、見出しは「⚠途切れました・🔄で再取得」（「配信終了」と書かない）。
- `debug_suite.js` v1.18.1
  - `D-L8` に4判定を追加（心拍の「再接続中」・復帰後の表示・観測値が store に入る・取得が落ちたら「途切れました」）。11判定。
  - `D-L9`: 取得中の枠は「心拍が15秒以内に届いている」「最後の成功が60秒以内（再接続中なら可）」で判定する。取得済みの枠は従来どおり `endReason` があること。

### 7-4. 管理側の誤り

- 🔴 **`D-L9` の判定が「state が streaming なら合格」だった。** R4（配信終了後）で「配信中」のまま止まらない不具合をそのまま合格にした。判定が「取得中であること」しか見ておらず、「取得が実際に進んでいるか」「終わるべき時に終わったか」を見ていなかった（鉄則 #41/#42 と同じ型。判定が土俵の成立だけを見ている）。→ 心拍の観測値で判定するよう改めた。
- 設計時に「終了後は出口に来る」という11節の仮説を確かめずに前提にした。実機では出口が来るまでかなり長くかかった。

### 7-5. headless の確認

検証台（`live_mock.js`）に場面を3つ足した。`silentEnd`（6回目で配信終了・以後も応答は普通に続く）・`hang`（4回目の応答が返らない。`AbortSignal` にだけ応じる）・`nopr`（出口のあと最初の watch に `playerResponse` が無い）。

| 場面 | 新エンジン | 変更前のエンジン（`149e3ef`） |
| :--- | :--- | :--- |
| `silentEnd` | 出口なしで定期確認により **`ENDED`**（`isLiveNow`） | 🔴 **781回ポーリングしても終わらない**（R4 を再現） |
| `hang` | 打ち切り → 再試行で続き、のちに `ENDED`。心拍の `lastOkAgoMs` が固まっている間だけ伸びる | 🔴 **4回目で止まったまま**（心拍は出続ける） |
| `nopr` | `NO_PLAYER_RESPONSE` で待ち、次の watch で復帰（復帰1回）→ のちに `ENDED` | 🔴 **配信中なのに `ENDED`（`endBy: none`）** |
| 既存5場面（recover / error / fail / disabled / maxreq） | 6節と同じ結果 | ─ |

- A側: `D-V1` / `D-V2` / `D-L8`（11/11）合格。負の検証: 変更前の `index.html` に当てると `D-L8` **不合格 7/11**。`D-L9` は偽の store で「心拍なし」→不合格 0/2・「最後の成功が200秒前」→不合格 1/2・「新しい心拍」「再接続中」→合格。
- 「▶ すべて実行」23本（file://・アドオン版数 2.11.0 を偽装）: すべて合格。
- 🔴 **実機で未確認**: 本物の配信終了から `isLiveNow` が false になるまでの遅れ（用紙 R4c で時刻を測る）・FREE の「止まった」が 7-2 の #2〜#4 のどれか（用紙 R3d で見出しの文言を写してもらう）。

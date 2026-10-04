---
name: get-chat-feature-spec
description: "説明: アニメ同時視聴コントローラーの「チャット欄表示」機能の実装仕様を取得します。コメント取得方式（v2.6.0でInnerTube直接取得へ転換し、v2.6.2でyt-dlp/Native Messagingを完全撤去）、MAIN world注入とストリーミング中継の実測仕様、チャンク束ねの確定値、IndexedDBキャッシュの実測と設計（v2.6.3・gzip採用）、取得できない理由の切り分けと案内文の出し分け（v2.6.4）、取得は成功したのにコメントが0件だったときの専用表示（v2.6.5）、整形済みJSONのデータ構造、A側の自前描画と再生位置同期、再挑戦してはいけない行き止まり（iframe埋め込み）の記録、メンバー限定アーカイブのチャット取得（v2.7.5 ─ SAPISIDHASH 認証ヘッダ / 1-3-2節）、ライブ配信のチャット取得（v2.8.0 ─ get_live_chat への切替・配信中かどうかの判定・ポーリング・第3の状態 live / 1-6節）を含みます。🔴 2026-09-05 に 8-13節「参照されなくなったコメントの破棄」を新設しました（★v2.8.3 ─ 参照集合の3条件 collectChatRefs、解放の手順 releaseUnusedChatData、中止が先で解放が後という順序、呼び出す5つの経路と各経路の罠、中止 maybeCancelChat の判定も同じ参照集合へ統一したこと、実測値）。⚠️ 2026-08-15 に、ニコニコ風コメント流しと調整UI（旧 8-10節・8-11節）を /get-danmaku-spec 1節・2節へ分離しました。流しの描画方式・レーン・FLOW・調整UIはそちらが正本です。チャット取得・キャッシュ・絵文字・ライブ対応・コメント配列の破棄に関わる実装やデバッグ時には必ず呼び出してください。トップバーのメニュー構造と枠内通知は /get-ui-spec 1節・2節、版数履歴とロードマップは /get-protocol-spec 0-3節・11節。 🔴 2026-09-06 に開発の現在地とスキル管理の規約が /get-mgmt-guide へ分離され、本スキルの参照を張り替えました（スキルは7本）。 最終更新: 2026-09-06"
---

# チャット / コメント流し機能 実装仕様書

最終更新: 2026-08-15 / 現行リリース **v2.8.1**（実機検証済み）
関連スキル: `/get-protocol-spec`（A↔B通信プロトコル、バージョン管理規約、既知の不具合）
関連スキル: `/get-danmaku-spec`（ニコニコ風コメント流しと調整UI ─ 本スキル旧 8-10節・8-11節。★2026-08-15 分離）
関連スキル: `/get-ui-spec`（A側UIの部品仕様 ─ トップバーのメニュー構造・再生可否の確定と枠内通知）
関連スキル: `/get-dev-workflow`（開発フロー規約 ─ セッションの役割分担、報告書の必須項目、テスト手順書の作り方）
関連スキル: `/get-mgmt-guide`（⚠️ 管理用セッション専用 ─ 開発の現在地、スキルの編集権限・出力形式と設置の確認・分割の判断、history 退避。★2026-09-06 新設）
過去の検証記録・撤去記録: `history_chat.md`（ナレッジ内）

---

## 0. 現在の状態

| 機能 | 状態 |
| :--- | :--- |
| A側のチャット欄表示（自前描画・再生位置追従・シーク追従） | ✅ v2.5.0 |
| 文字サイズ調整（`A-` / `A+`） | ✅ v2.5.1 |
| InnerTube 直接取得＋ストリーミング配送 | ✅ v2.6.0 |
| 取得タブの隠蔽・破棄方針 | ✅ v2.6.1 |
| C側ヘルパー（Python / yt-dlp / Native Messaging）の撤去 | ✅ v2.6.2 |
| IndexedDB キャッシュ（gzip） | ✅ v2.6.3 |
| 取得エンジンの版数追従（注入時受け渡し） | ✅ v2.6.4 |
| 取得失敗の理由コードと案内文の出し分け | ✅ v2.6.4 |
| 取得成功かつコメント0件のときの専用表示 | ✅ v2.6.5 |
| ニコニコ風コメント流し | ✅ v2.7.0（`/get-danmaku-spec` 1節） |
| 版数バッジの「YouTube権限なし」表示 | ✅ v2.7.0（`/get-protocol-spec` 4-1節） |
| 流しの調整UI（速さ・同時表示数・色・表示範囲） | ✅ v2.7.1（`/get-danmaku-spec` 2節） |
| コメント系設定の独立メニュー化 | ✅ v2.7.2（`/get-danmaku-spec` 2節 / パネルの構造は `/get-ui-spec` 1節） |
| メンバー限定アーカイブの**再生** | ✅ v2.7.4（条件つき ─ 11節 / 失敗時の扱いは `/get-ui-spec` 2節） |
| メンバー限定アーカイブの**チャット取得** | ✅ v2.7.5（POST に SAPISIDHASH 認証ヘッダ ─ 1-3-2節） |
| **ライブ（配信中）のチャット** | ✅ v2.8.0（1-6節）／v2.8.1 で A側が `liveBy` / `livePolls` を保存 |
| 🔴 **参照されなくなったコメントの破棄** | ✅ **v2.8.3**（8-13節）。中止の判定も同じ参照集合へ統一 |

🔴 **この表は④のたびに実態と突き合わせること。**
2026-08-15 まで **v2.7.5 / v2.8.0 で実装済みのものが「⬜ 予定」のまま2版残っていた**
（分割セッションの指摘で判明）。**11節のロードマップと同じ性質の失効である。**

---

## 1. 取得方式（InnerTube 直接取得）

### 1-1. 🔴 実行コンテキストの鉄則

**取得は必ず MAIN world（ページ世界）で行う。**

| 実行場所 | Origin | 結果 |
| :--- | :--- | :--- |
| background script | `moz-extension://...` | ❌ 403 |
| content script（ISOLATED world） | 同上 + `ytcfg` が見えない | ❌ 403 |
| **ページ世界（MAIN world）** | **`https://www.youtube.com`** | ✅ **200** |

⚠️ **Firefox の content script の `fetch` は拡張機能の principal で飛ぶ。**
youtube.com 上の content script であっても Origin は `moz-extension://` になる。
**必ず `scripting.executeScript({ world:'MAIN' })` でページ世界に落とすこと。**

### 1-2. 取得手順（実証済み）

```js
// すべて MAIN world 内で実行する
const key = ytcfg.get('INNERTUBE_API_KEY');
const ctx = ytcfg.get('INNERTUBE_CONTEXT');

// ① watch ページの HTML を同一オリジンで取得（動画を再生する必要はない）
const html = await (await fetch('/watch?v=' + videoId, { credentials:'include' })).text();
const lenM = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/);          // 完走判定に使う
const m    = html.match(/ytInitialData\s*=\s*(\{.*?\})\s*;\s*<\/script>/s);
const lcr  = JSON.parse(m[1]).contents.twoColumnWatchNextResults
               .conversationBar.liveChatRenderer;                   // 無ければチャット無効/メン限
let cont = lcr.continuations[0].reloadContinuationData.continuation;

// ② continuation を辿る
const post = (c, offsetMs) => fetch('/youtubei/v1/live_chat/get_live_chat_replay?key=' + key, {
  method:'POST', headers:{ 'content-type':'application/json' },
  body: JSON.stringify({ context: ctx, continuation: c,
                         currentPlayerState: { playerOffsetMs: String(offsetMs) } })
}).then(r => r.json());
```

**次の continuation は**
`continuationContents.liveChatContinuation.continuations[0].liveChatReplayContinuationData.continuation`。

**`playerOffsetMs` には直前チャンクの最終 `videoOffsetTimeMsec` を渡す。**
渡さない／進めないと同じ位置を繰り返して無限ループになる。

### 1-3. 🔴 既定の continuation は「上位のチャット」を指す

`ytInitialData` から取れる `reloadContinuationData` は **「上位のチャットのリプレイ」**
（間引かれた表示）側。**必ず全件側へ切り替えること。**

```js
const menu = res.continuationContents.liveChatContinuation
               .header.liveChatHeaderRenderer.viewSelector
               .sortFilterSubMenuRenderer.subMenuItems;
// 実測: ["0:上位のチャットのリプレイ★", "1:チャットのリプレイ"]
if (menu.length > 1 && !menu[1].selected) {
  cont = menu[1].continuation.reloadContinuationData.continuation;   // ← 全件はこちら
}
```

`viewSelector` は **1回目の応答にしか入っていない**（`ytInitialData` 側には無い）。
切替を忘れると件数が減るが、**「なんとなく少ない気がする」という最悪の形でしか気づけない。**

★v2.10.0: 利用者が枠ごとに「上位のチャット」を選べるようにした。B側は `pickChatView(lc, mode)` で **index 0（上位）/ index 1（全件）** を選び、**すでに選ばれている側なら切り替えずその応答を使う。** 実際に選んだ側を `view`（`top` / `all` / `unknown`＝`viewSelector` が無い）として `chunk` / `done` に載せる。
A側の取得結果のキーは **すべて＝videoId のまま／上位＝`videoId#top`**（`getChatKey`）。🔴 **既定にサフィックスを付けないので既存のキャッシュ・判定は退行しない。** 枠の動画そのものが要るとき（⧉ など）は `getChatVideoId`、取得結果を引くときは `getChatKey` を使う。
実測（2026-10-04 `zuuZyNH0F1Y`）: 全件 356 / 上位 350。上位は YouTube 側の間引きなので A側で全件から作れない＝切り替えると取り直し。

### 1-3-2. 🔴 POST には認証ヘッダが要る ★v2.7.5 で実装済み

**v2.6.0 以降、`get_live_chat_replay` の POST は終始ログアウト扱いだった**（`responseContext.loggedOut: true`）。
`credentials:'include'` だけでは足りず、**InnerTube は `Authorization` ヘッダを見ている。**

| 動画 | ヘッダなし | ヘッダあり |
| :--- | ---: | ---: |
| 公開アーカイブ2本 | `actions` 101 / 98 | **同じ 101 / 98**（バイト数だけ +33% 前後） |
| 🔴 メンバー限定 `AoaL9zbPAkA` | **2,465バイト / `actions` キー無し / 0件** | **747,802バイト / `actions` 107 / 採用 102** |

🔴 **公開アーカイブでは件数が変わらない。だから v2.6.0 から今日まで表に出なかった。**

**ヘッダなしのときメンバー限定が返していたもの**（2026-08-10 実測）:
`contents.messageRenderer.text.runs[0].text` = 「このライブ ストリームではチャットは無効です。」

⭐ **「0件だった」のではなく「チャットは無効だと言われていた」。**
B側は `lc === null` で `break` するため、**理由を持たないまま0件で完走扱い**になっていた。

#### 付けるヘッダ

| ヘッダ | 値 |
| :--- | :--- |
| `Authorization` | `SAPISIDHASH <unix秒>_<sha1hex>` |
| `X-Origin` | `https://www.youtube.com` |
| `X-Goog-AuthUser` | `0` |

**ハッシュの材料**: `<unix秒> <Cookieの値> https://www.youtube.com` を SHA-1 して16進小文字。
**Cookie は `SAPISID` → `__Secure-3PAPISID` → `__Secure-1PAPISID` の順に探す**（実測では `SAPISID`）。

🔴 **リクエストごとに作り直すこと。** 時刻を含むため、数分かかるジョブで使い回すと期限切れになりうる
（期限の実測はしていない）。

🔴 **Cookie が見つからなければヘッダを付けずに従来どおり投げること。**
公開アーカイブは認証なしでも同じ件数が返るので退行しない。
⚠️ **`crypto.subtle` は安全なコンテキストでしか使えない。** 取得タブは `https://www.youtube.com` なので
満たすが、**失敗したらヘッダ無しで続行する経路を必ず用意する**（例外で取得ごと落とさない）。

⚠️ **`document.cookie` を読む。** MAIN world なので読めるが、
🔴 **値をログにもメッセージにも載せないこと。**

⚠️ **3つのヘッダを同時に足して確かめている。どれが効いたかは分離していない**
（YouTube の標準的な組み合わせであり、分離しても実装は変わらない）。

⚠️ **`/watch?v=` の fetch は変更不要**（`credentials:'include'` で `playabilityStatus = OK` が返っている）。
⚠️ **再試行は同じヘッダを使う**（`postChat()` の先頭で1回だけ組み立てる）。

#### 🔴 診断口は値を持たない

`__syncChatEngine.auth()` が返すのは
**組み立て成功の回数 / ヘッダ無しで送った回数 / 使った Cookie の「名前」/ 直近の理由**だけ。
**Cookie の値もハッシュも保持しない。**

#### v2.7.5 の実測（2026-08-14 / Floorp 12.16.4@153.0 / GitHub Pages）

| 動画 | 件数 | 完走 | req | 所要 | 絵文字 |
| :--- | ---: | :-: | ---: | ---: | ---: |
| `AoaL9zbPAkA`（メンバー限定 / 7307秒） | **8,522** | ⚪ | 179 | 28.5秒 | 21 |
| `zuuZyNH0F1Y`（公開 / 70.6分） | **356** | ⚪ | 9 | 2.4秒 | 4 |
| `NshKf1Pw9nA`（公開 / 3:13:09） | **39,199** | ⚪ | 849 | 106秒 | 35 |
| `q176a2krHbg`（公開 / 129.5分） | **52,358** | ⚪ | 1,192 | 249秒（参考値） | ─ |

⚪ **非ログイン時**: `AoaL9zbPAkA` は `MEMBERS_ONLY` / `zuuZyNH0F1Y` は **356件のまま**（退行なし）。
⚪ **メンバー専用絵文字は 48x48 で読み込み成功**（403 にならない）。

⚠️ **所要時間 249秒は参考値。** 測定PCが違うため v2.6.x の 165〜234秒とは**比較できない。
今回の値も新しい基準にしないこと。**

### 1-3-3. 🔴 「チャットは無効」応答に理由コードを持たせる ★v2.7.5

`runJob()` のループ内、`continuationContents.liveChatContinuation` が取れなかったときの分岐。

| 条件 | 動作 |
| :--- | :--- |
| `lc` が無く、`data.contents.messageRenderer` **がある** | `throw new Error('CHAT_DISABLED: ' + textOf(mr.text))`。文言が空なら既定文を使う |
| `lc` が無く、`messageRenderer` も**無い** | 🔴 **従来どおり `break`**（正常な終端。**ここを変えると全取得が壊れる**） |

- **1回目かどうかで分けない**（途中で返っても意味は同じ）
- **書式は既存に合わせる**（`'CODE: 説明'` / 半角コロン＋スペース）。**新しいコードは作らない**
- ⚠️ **v2.6.4 の理由コード判定とは別の場所。** あちらは `liveChatRenderer` へ到達**できなかった**とき、こちらは到達**した後**

🔴 **【未検証】B側が実際にこの throw を通るかは確かめられていない。**
実素材（チャットのリプレイが無効なアーカイブ）が未確保で、**人工再現も成立しなかった**（9-8節）。
A側の出し分け（`CHAT_DISABLED` → 専用文面・再試行ボタンなし）は `D-C9` で機械検証済み。
**v2.6.4 から3バージョン目の持ち越しである。**


### 1-4. watch タブは不要

`ytcfg` は youtube.com のどのページでも同じものが取れる。continuation は watch ページの HTML を
同一オリジンで fetch して切り出せばよいため、**軽量な `https://www.youtube.com/` タブ1枚で
9本すべてを処理できる。** 動画を再生する必要も、9枚タブを開く必要もない。

### 1-5. 取得できない理由の切り分け ★v2.6.4

`liveChatRenderer` が無いとき、原因は3つに分かれる。**`ytInitialData` だけでは区別できない**ため、
`ytInitialPlayerResponse` も切り出して判定する。

```js
const pr = findPlayerResponse(html);            // findInitialData と同じ括弧の対応取り
const st = pr && pr.playabilityStatus;
const vd = pr && pr.videoDetails;

if (st && st.status && st.status !== 'OK')  throw new Error('MEMBERS_ONLY: …');
if (vd && vd.isLiveContent !== true)        throw new Error('NOT_LIVE_ARCHIVE: …');
throw new Error('CHAT_DISABLED: …');
```

| 理由コード | 意味 |
| :--- | :--- |
| `MEMBERS_ONLY` | 再生自体ができない（メンバー限定・年齢制限など） |
| `NOT_LIVE_ARCHIVE` | ライブ配信のアーカイブではない（通常動画） |
| `CHAT_DISABLED` | 上2つに当たらず `liveChatRenderer` が無い |

- `findPlayerResponse` が **`null` を返しても失敗にしない。** 判別できないだけなので `CHAT_DISABLED` へ落とす
- `credentials: 'include'` は維持する。**ログイン状態で `playabilityStatus` の内容が変わる**
- 正規表現 `\{.*?\}` は JSON の途中で切れるので使わない（1-2節と同じ理由）
- 判定順は **再生可否 → ライブ由来か → チャット設定** の順。逆にすると
  メンバー限定を `NOT_LIVE_ARCHIVE` と誤診する（非メンバーには `videoDetails` が入らないことがある）

A側の文言の出し分けは 8-8節。プロトコル上の扱いは `/get-protocol-spec` 7-6節。

---

### 1-6. 🔴 ライブ配信のチャット取得 ★v2.8.0

**配信中のライブは端点・応答の形・時刻の持ち方がアーカイブと違う。**
分岐は下表の5点だけで、**アーカイブ側の経路・定数（`FLOW`）には一切手を入れていない。**

| | アーカイブ | **配信中（ライブ）** |
| :--- | :--- | :--- |
| 端点 | `get_live_chat_replay` | **`get_live_chat`** |
| `currentPlayerState` | `playerOffsetMs` を送る | 🔴 **送らない** |
| 次の continuation | `liveChatReplayContinuationData` | **`invalidationContinuationData`**（`timeoutMs` を持つ） |
| actions | `replayChatItemAction` に包まれる | 🔴 **`addChatItemAction` が直に来る** |
| コメントの時刻 | `videoOffsetTimeMsec` | 🔴 **無い。`timestampUsec` から作る** |
| 終わり方 | 終端に達したら完了 | 🔴 **終わらない**（次の continuation が返らなくなったら＝配信終了） |

🔴 **認証ヘッダ（SAPISIDHASH / 1-3-2節）はライブでも同じものが要る。作り方は変えていない。**
⚠️ **continuation の入れ物名を決め打ちにしないこと。** 「`continuation` という文字列を持つ子」を探す形にしてある。
⚠️ **初回 continuation は watch HTML の `reloadContinuationData`。** 既存の関数がそのまま使える。
⚠️ ライブの1回目の応答には `viewSelector` があるが**2回目以降には無い**。

#### 1-6-1. 配信中かどうかの判定（実測 2026-08-15）

**順に見て、boolean が見つかった時点でそれを正とする。OR で束ねない。**

1. `microformat.playerMicroformatRenderer.liveBroadcastDetails.isLiveNow`
2. `videoDetails.isLive`
3. `playabilityStatus.liveStreamability`（あれば true）
4. どれも無ければ false

🔴 **誤検出（アーカイブをライブと誤る）は、キャッシュ不保存・一括シーク除外という退行に直結する。**
**取りこぼす側（従来どおりアーカイブとして扱う）へ倒す設計にしてある。**

🔴 **使ってはいけないフィールドが2つある。**

| フィールド | なぜ使えないか |
| :--- | :--- |
| `videoDetails.isLiveContent` | 「ライブ配信**だったか**」。アーカイブでも true（既知） |
| 🔴 `videoDetails.isLowLatencyLiveStream` | **アーカイブでも true。** 名前は「低遅延で配信中」に読めるが、実体は**履歴フラグ**（2026-08-15 に判明） |

⚠️ `lengthSeconds` はライブで `"0"`。**単独では使わない。**

#### 1-6-2. ポーリング

応答の `timeoutMs`（**実測 10,000ms**）の間隔で問い合わせ続ける。

| 定数 | 値 | 意味 |
| :--- | :-- | :--- |
| `LIVE_POLL_MIN_MS` | 1000 | `timeoutMs` が異常に小さい／無いときの下限 |
| `LIVE_POLL_MAX_MS` | 30000 | 同上の上限 |
| `LIVE_POLL_DEFAULT_MS` | 5000 | `timeoutMs` が取れなかったときの既定 |

⚠️ **ライブでは意図的に `sleep` を挟む。** 「取得ループにタイマーを混ぜない」という既存の戒めは
**アーカイブ側の話。** 背面タブのタイマーは 1000ms にクランプされるが、
**待ちたいのは 10,000ms なのでクランプは下限として働くだけで実害が無い。**

🔴 **`NO_PROGRESS_LIMIT` をライブに適用してはいけない。**
誰も書き込まない10秒は `actions` 0件が正常で、3回続いたら打ち切る式では **30秒で取得が死ぬ。**
🔴 **束ねもライブに適用してはいけない。** `FLUSH_REQS = 20` のままだと **200秒ぶん溜め込んでから送る**。
**ライブは1応答ごとに flush する**（中継コストは約120ms、10秒に1回なので問題にならない）。

#### 1-6-3. コメントの時刻 `t` の作り方

```
t = timestampUsec / 1000 − liveBroadcastDetails.startTimestamp   ＝ 配信開始からの経過ms
```

🔴 **アーカイブ化後の `videoOffsetTimeMsec` と同じ意味になる**ので、チャット欄の時刻表示が自然に出て、
単調増加も保たれる（A側の二分探索・ソートを壊さない）。
`startTimestamp` が取れなければ最初のコメントを 0 とみなす（**負の値を A側へ渡さないため**）。

🔴 **副作用: ライブの `t` は `getCurrentTime()`（DVR の経過秒）と桁が一致する。**
**そのためアーカイブ経路で流してしまっても画面上は流れて見える。**
⚠️ **「流れたこと」だけでは実装が意図どおりか判定できない。** 実際にこれで1回見逃している。

#### 1-6-4. 第3の状態 `live`

| 状態 | 意味 |
| :--- | :--- |
| `complete: true` | アーカイブを最後まで取り切った |
| `complete: false` | 途中で終わった |
| 🔴 **`live: true`** | **配信中。完走という概念が無い**（`complete` は `null`） |

🔴 **`complete: false` を流用してはいけない。** A側が「途中で失敗した」と表示する。
⚠️ `videoMs` はライブでは 0 なので既存の完走判定式は `null` を返すが、
**`null` は A側で true に丸められる**ため別フィールドが要る。

#### 1-6-5. A側の扱い

| 対象 | ライブでの挙動 |
| :--- | :--- |
| ヘッダー表示 | `💬 チャット (n / 🔴 配信中)` / 終了後 `(n / 配信終了)` / 0件 `(配信中・まだコメントなし)` |
| `⚠不完全` / `取得中 0%` | 🔴 **出さない** |
| チャット欄 | **到着順にそのまま追加**（再生位置と突き合わせない） |
| コメント流し | **実時計＋到着順**（`flowEstMs()` が `performance.now()` を返す）。アーカイブは再生位置（`/get-danmaku-spec` 1-3節） |
| キャッシュ | 🔴 **保存しない**（`chatCachePut` を通さない） |
| 一括／相対／絶対シーク・枠単位のスキップ | 🔴 **対象外**（4経路すべてで `isLiveCard()` により除外） |
| ▶一括再生 | ⚪ **対象に含む**（同時再生には対応する） |

| 定数 | 値 | 意味 |
| :--- | :-- | :--- |
| `FLOW_LIVE_SPAWN_PER_TICK` | 4 | 1tick(250ms)で湧かせる上限。10秒ぶんが一度に届くため |
| `FLOW_LIVE_BACKLOG_MAX` | 60 | 超えて溜まったら古い方を捨てて最新へ飛ぶ |

🔴 **流し本体の仕様（描画方式・レーン・`FLOW`・調整UI）は `/get-danmaku-spec` 1節・2節が正本。**
**上の2定数はライブ固有なので本節に置いてある**（`/get-danmaku-spec` 3節から辿れる）。

🔴 **ライブの流しは一時停止で止めない。** 実時計を止めると `t0` との差が飛び、**再開時に全部が一気に消える。**
ライブは巻き戻せないので、止めても後から追いつく意味がない。

#### 1-6-6. 🔴 恒久制約 ─ 取得を始めていないライブ枠は判別できない

**A側が「この枠はライブか」を知る手段は、チャット取得の応答（`chatMeta.live`）しかない。**
チャット欄も流しも一度も開いていない枠は、ライブでも `liveVideoIds` に載らず、
**一括シークの除外が効かない。** v2.8.x では制約として残す。

⚠️ 取り直し（🔄）では `liveVideoIds` からも消す。
**配信が終わってアーカイブになったとき、次の取得で B側が判定し直せるようにするため。**

⚠️ **応答に `liveChatViewerEngagementMessageRenderer` や `liveChatReportModerationStateCommand` が混じる**が、
既存の `toComment()` がレンダラー名で捨てるので素通しでよい。

---


## 2. 確定した定数と見積もり

### 2-1. 導出された定数（2026-07-26 実測 / Firefox 153）

| 指標 | 値 |
| :--- | ---: |
| 1リクエストあたりの件数 | **約45件**（全動画で一定。動画長ではなくコメント数がreq数を決める） |
| 1リクエストの所要 | 約100〜125ms |
| 1コメントあたりのJSONサイズ | 約74バイト |
| 最も濃い動画の消費速度 | **6.7件/秒** |
| 1リクエスト = 再生 約6.5秒ぶん | → **取得は再生の約60倍速** |
| 供給速度（逐次1本） | 約200件/秒 |

### 2-2. 🔴 サイズを1本のサンプルから見積もってはいけない

**9本の実測で 28KB 〜 5.42MB、最大で65倍の開きがある**（合計 207,317件 / 14.2MB）。
最軽量の1本を基準にすると全設計が狂う。**複数本・とくに濃いものを測ること。**

### 2-3. 並列度は3〜4

並列を9に上げても**スループットは1.35倍にしかならず、個別の所要時間はむしろ悪化する。**
**並列3〜4を採用する。**

⚠️ **並列3では回線が律速（約22 req/秒）し、中継コストが他の動画の通信待ちに隠れる。**
**中継に関する計測は必ず逐次で行うこと。**

### 2-4. レート制限は考慮不要

**4,606リクエストを投げても 429 / 403 は一度も出なかった。** 並列9の連投でも発生せず。

### 2-5. ⭐ チャンク束ねの確定値

```
先頭 3 リクエスト     … 即送信（初回到達 1.2〜1.7秒を維持するため）
以降 20 リクエストごと … 束ねて送信（1メッセージ 約900件・約60KB）
```

**確定値: N=3 / M=20**（段階1-F で掃引して確定）。

- 束ね20で「取得だけの床」に到達する。50以上にしても速くならず、チャンク間隔が伸びるだけ
- **100は巨大メッセージの構造化複製が効き始めて逆に遅くなる**
- 1メッセージあたりの中継コストは約91ms

**初回チャンク到達の判定基準は 2,000ms 以下とする。**
実測 1,171〜1,725ms とばらつく（ネットワーク3往復ぶんの揺れ）。
閾値を実測の幅より狭く置くと、正常なばらつきを不合格と誤判定する。

### 2-6. 🔴 件数の基準値は不変ではない

**アーカイブのチャットは投稿者・モデレーター・YouTube による削除で減る。**
実測: `IStEd3a2Jqc` は8時間で 73,230 → 73,228（−2件）。
実測: `q176a2krHbg` は 52,363（2026-07-26）→ **52,362（2026-07-29）**（−1件）。

件数を突き合わせるときは**基準値の測定日を併記**すること。
差が出たら、実装を疑う前に**基準値を測り直す**。
切り分けの決め手は「要求回数が一致しているか」「採用条件が参照実装の上位集合か」。

---

## 3. ストリーミング配送

### 3-1. 一括先読みは不要

コメントは時系列順に取れるため**先頭から順に使える。**
先頭チャンク（約45件）が届いた時点で再生を開始し、残りは再生しながら裏で追いかける。

供給 約200件/秒 に対し消費は最大6.7件/秒で、**30倍以上の余裕**がある。
9本同時（並列3）でも1本あたり毎秒約107件を供給でき、16倍の余裕。

### 3-2. 中継経路（4ホップ）

**MAIN world には `browser.*` API が無い。** そのため結果を返すには必ずこの経路を通る。

```
MAIN world（取得ループ）
  └─ window.postMessage({ __syncChat:1, ev:'chunk', ... })
       └─ content_yt_chat.js（ISOLATED / 同じYouTubeタブ）
            └─ browser.runtime.sendMessage
                 └─ background.js（中継のみ）
                      └─ content_controller.js
                           └─ controller.html
```

ISOLATED 側の中継は `scripting.executeScript`（world 省略）で動的注入できる。
多重注入を防ぐため `window.__chatProbeRelay` のようなフラグで冪等にすること。

```js
window.addEventListener('message', (e) => {
  if (e.source !== window) return;                 // 必須
  const d = e.data;
  if (!d || d.__syncChat !== 1) return;
  browser.runtime.sendMessage({ type:'CHAT_CHUNK', payload: d }).catch(() => {});
});
```

🔴 **最終チャンクは `done` と同じメッセージで送ること。**
別メッセージにすると、受け手が `done` を受けて片付けたあとに最終チャンクが届き、
**そのぶんが丸ごと消える。** `window.postMessage` は非同期なので、
送信側が「送った」と思った時点ではまだ経路の途中にいる。
**タイミングで直そうとせず、構造で消すこと。**

### 3-3. 🔴 中継は fetch より重い

`runtime.sendMessage` はプロセスをまたぎ構造化複製が2回走るため、
**1チャンクあたり約120ms**かかる。fetch 自体が約100msなので**通信より中継の方が重い。**
束ねなしで送ると全体が **×2.14** に膨れる。3-2節の束ね（2-5節）で実質消える。

**細かいメッセージを大量に送る設計は避けること。**

### 3-4. 裏タブでも fetch ループは間引かれない

`setTimeout` を使わず fetch の await だけで回しているため。
背面タブで16分間走らせても最大チャンク間隔は1,055msにとどまった。
**取得ループにタイマーを混ぜないこと**（混ぜるとタイマークランプを受ける）。

### 3-5. 未取得範囲へシークしたときの実挙動

取得が追いついていない位置へシークすると、**取得済みのコメントが到着順にそのまま流れ、
取得が再生位置に追いついた瞬間に同期する。**

理由: 描画ループは `comments[cursor].t <= 再生位置` を満たすものを順に出すため、
シーク先が取得の先端より後ろなら新着がすべて条件を満たし、到着そのままの速度で消化される。

**実用上の問題は無いと判断済み**（この状態になるのは長い動画の取得開始から数十秒だけで、
取得は再生の約60倍速なのですぐ追い越す。ヘッダーに `取得中 ○%` も出る）。

---

## 4. コメントのキャッシュ（v2.6.3 / IndexedDB）

### 4-1. なぜ要るか

**重い1本の取り直しは165〜234秒。** v2.6.2 でC側（NAS上の共有キャッシュ）を撤去したため代替が要る。
**取り直し234秒 → 39ms（約6,000倍）。**

### 4-2. 保存形式は gzip（段階3-A 実測 / 2026-07-27 / 73,228件）

| 形式 | 読出 | 実使用量 |
| :--- | ---: | ---: |
| raw（配列のまま） | 55ms | 2.58MB |
| json（文字列） | 40ms | 1.96MB |
| **gzip** | **39ms** | **1.16MB** ← 採用 |

読出時間には gunzip と `JSON.parse` を含む。**圧縮のCPU代は小さいI/Oで元が取れる。**
「圧縮はCPUを食う」という事前の想定は、この規模では成り立たなかった。

### 4-3. 構成

| 定数 / ストア | 値・内容 |
| :--- | :--- |
| `CHAT_CACHE_DB` | `'syncViewerChat'`（version 1） |
| `CHAT_CACHE_FORMAT` | `2`（整形フォーマットの版。変えれば全件作り直しになる） |
| `CHAT_CACHE_LIMIT_BYTES` | 150MB（重い9本で約4.8MB。実質無制限） |
| objectStore `meta` | `{ v, videoId, fetchedAt, lastUsedAt, total, videoMs, bytes }` |
| objectStore `data` | gzip 済み `ArrayBuffer`（`{ emoji, comments }` を JSON 化して圧縮） |

**meta と data を分けている理由**: 使用量の集計・LRU・本数表示のたびに本体（数MB）を
読みたくないため。meta だけ走査すれば済む。

利用可否は `indexedDB` / `CompressionStream` / `DecompressionStream` の3つが揃うかで判定
（`chatCacheAvailable()`）。**使えない環境では黙って通常の取得へ進む。**

### 4-4. 🔴 IndexedDB のトランザクションの罠

- **トランザクションは、他の非同期処理を待つと勝手に閉じる。**
  **圧縮・伸長は必ずトランザクションの外で行うこと。**
- **完了は `tx.oncomplete` で見る。** `put` の `onsuccess` はコミット前に発火する。

### 4-5. 保存・破棄の方針

| 項目 | 方針 |
| :--- | :--- |
| 保存条件 | **`complete` かつ `gap` / `truncated` でないものだけ。** 途中で失敗したものを完全と誤認させない |
| 取り出し時の検証 | 形式版数・`comments` が配列であること・**件数が `meta.total` と一致すること**。ひとつでも外れたら捨てて `null` を返す |
| 退避 | 合計が上限を超えたら `lastUsedAt` の古い順に削除（LRU） |
| 🔄（取り直し） | `chatCacheSkip[videoId]` を立てて**1回だけキャッシュを無視**し、完走したら入れ直す |
| 永続化 | `navigator.storage.persisted()` は false（実測）。ディスク逼迫で消えることがあるが取り直せるので `persist()` は呼ばない（許可を求める方が高くつく） |
| スコープ | **オリジンごと。** `127.0.0.1:8080` と GitHub Pages のキャッシュは共有されない |

⚠️ **PC間では共有されない。** `storage.sync` は総容量100KBのため転用不可。

⚠️ **0件は `complete` によらず保存されない。** `chatCachePut` は v2.6.3 から
`if (!Array.isArray(store.comments) || !store.comments.length) return;` を持っている。

**このガードは残すことに決定した**（2026-07-29 / 管理用セッション判断）。理由:

1. **メンバー限定の空振りには効かない。** あれは `complete === false` なので、
   ガードの有無にかかわらず保存されない。**外しても v2.6.5 で見つかった問題は改善しない**
2. **バグを固着させる安全弁になっている。** 将来 `chat_fetcher_main.js` の解析が壊れて
   「`complete:true` かつ0件」を返すようになった場合、ガードが無いとその空が保存され、
   **再読み込みしても直らない。** 取得の不具合がキャッシュの不具合に化けるのが最もたちが悪い
3. 得をするのは「本当にコメント0件で完走したアーカイブ」だけで、**その再取得コストは未計測**

⚪ 代償として、0件のアーカイブは開くたびに取得が走る（0件の取得は速いので実害は小さい）。
**外すのは再取得コストを測って痛いと分かってから。** なお `chatCacheGet` 側は0件でも破綻しない
（`body.comments.length !== rec.meta.total` は `0 === 0` で通過する）ため、外す変更自体は容易である。

---

## 5. ⛔ 再挑戦してはいけない行き止まり

| # | 手法 | 結果 |
| :-: | :--- | :--- |
| 1 | `live_chat?v=<終了済みID>` を iframe | 「チャットは無効です」。`live_chat` は配信中専用 |
| 2 | `live_chat_replay?v=<ID>` を iframe | 「Something went wrong」。replay は `v=` を受け付けない |
| 3 | `live_chat_replay?continuation=<token>` を iframe | 外枠だけ描画。`embed_domain` が scheme/port を含められずオリジン不一致 |
| 4 | ローカルHTTPサーバーをA側から叩く | GitHub Pages から `http://127.0.0.1` は混在コンテンツで遮断 |

⚠️ **メンバー限定アーカイブの IFrame Player 埋め込みは、行き止まりに「まだ」入れていない**（2026-08-04）。
スパイク 5-A の実測は `onError = 150` / 文言「このライブ イベントはご覧いただけません。」/
`duration = 0` / 再生進行なし（**状態A・状態Bとも同じ。3方式とも同じ**）。
⚪ **メンバー限定アーカイブは、条件つきで埋め込み再生できる。行き止まりではない。表へ入れてはいけない。**

🔴 **条件は2つある。** ①**HTTPS 配信であること**（`http://127.0.0.1:8080/` では必ず失敗する）
②`syanao-coder.github.io` に対して**強化型トラッキング防止をサイト単位でオフ**にすること。
⚪ **ブラウザ差は無かった**（Floorp でも再生できる / 2026-08-07）。**ブラウザ名で断定しないこと。**
条件は **`syanao-coder.github.io` に対して強化型トラッキング防止をサイト単位でオフにすること**
（ブラウザ全体の設定は変えない）。これでログインのセッション（`__Secure-3PSID`）が埋め込みへ届く。
**`onError = 150` は出るが、その後に再生が始まる**（11節・`/get-protocol-spec` 8節）。

**iframe 方式は仮に表示できても中身をJSから読めない**ため、コメント流しという最終目的には
原理的に到達できない。**復活させないこと。**

- **Holodex** は `X-Frame-Options` を剥がす方式だが「アーカイブチャットは20%程度しか動かない」
  との報告があり採用しない
- **YouTube Data API v3** では終了済み配信のチャットを取得できない（`liveChatEnded`）

---

## 6. ⚠️ 過去に踏んだ地雷（現行構成で有効なもの）

| 地雷 | 症状 | 正しい対処 |
| :--- | :--- | :--- |
| 既定の continuation を使う | 件数が減るが気づけない | `viewSelector` の index 1 へ切替（1-3節） |
| content script から fetch | HTTP 403（Origin が moz-extension://） | `world:'MAIN'` を明示（1-1節） |
| `playerOffsetMs` を進めない | 同じ位置を繰り返し無限ループ | 直前チャンクの最終 `videoOffsetTimeMsec` を渡す |
| MV3 background に長時間処理を置く | 30秒アイドルで終了し「Receiving end does not exist」 | 処理はタブ側に置く。background は中継のみ |
| 1本のサンプルからサイズを見積もる | 83KB と思っていたら実際は最大5.4MB | 複数本・とくに濃いものを測る（2-2節） |
| 上限に達したことに気づかない | 打ち切られた不完全データを完全と誤認 | `lengthSeconds` と最終位置を照合し「完走」を明示表示する |
| 先頭数件だけ見て比率を推定 | 「大半が絵文字」と誤認（実際は18%） | 全件を集計してから判断する |
| 最終チャンクを done と別メッセージで送る | 最後の1束が丸ごと消える。しかも「最後に終わった1本」だけなので偶発的に見える | **done に同梱する**（3-2節） |
| 中継コストを並列条件で測る | 回線律速で差が出ず「束ねは無意味」と誤読する | **逐次1本で測る**（2-3節） |
| 非同期送信の直後にタブ／受信を畳む | 道中のメッセージが消える | 送信件数に受信件数が追いつくまで待つ |
| `permissions.contains` のパターンを手で書き写す | 全権限を許可しているのに「許可がありません」で止まる（`*://*.youtube.com/*` は http も要求するため manifest が https のみだと false） | **manifest から引く。** さらに**事前判定で可否を決めない**（注入の成否だけが権威） |
| 基準値を絶対視する | 正常な実装を「取りこぼしている」と誤診する | **基準値を測り直してから**判断する（2-6節） |
| 取得タブのIDを `storage.session` に置く | アドオンを再読み込みするたびにタブが1枚増える | `storage.local` に置き、`runtime.onStartup` で捨てる |
| URL のクエリを取得タブの目印にする | YouTube 側で書き換えられて機能しない | 拡張機能の永続ストレージで持つ |
| タブ確保を直列化しない | 9枠一括で `startChatStream` が9本同時に走り、タブが9枚できる | Promise の鎖で直列化する |
| 自動追尾を `scrollTop` の位置だけで判定する | マウスオーバーでスクロールバーが出ると本文が折り返し直され、`scrollHeight` が変わって**勝手に追尾が止まる** | 人間の操作イベント（wheel/touchmove/mousedown/keydown）を起点にし、それ以外の scroll は無視する |
| チャット欄を閉じたときに取得を中止する | `chatState` が `streaming` のまま残り、開き直しても「取得中 12%」で永久に止まる | 閉じても中止しない。加えて「`streaming` なのに取得中でない」を検知したら捨てて取り直す |
| タブを隠すのを読み込み完了まで待つ | 読み込みの数秒間だけタブ一覧に見えてしまう | `tabs.create` の**直後**に隠す。隠されたタブは破棄されないので読み込みは続く |
| タブを閉じてよいかの判断をタブ内の設定で行う | 設定を「保持」に変えてもタブ内のエンジンが古い値を持っていると勝手に閉じる | **最終判断は background の保存値**で行う |
| 保持した取得タブで旧エンジンが動き続ける | `window.__syncChatEngine` で冪等化しているため新しいファイルを注入しても差し替わらない。**修正したはずの挙動が直らず、タブを手で閉じると直る** | `runtime.onInstalled` で取得タブを捨てる |
| 宣言だけ撤去して実体を残す | v2.5.0 で「撤去済み」と書いた関数群が background.js に丸ごと残っていた（v2.6.2 で発見） | 撤去したら `grep` で実体の消滅を確認する |
| IndexedDB の tx 内で圧縮・伸長を待つ | トランザクションが勝手に閉じる | 圧縮・伸長は tx の外で終わらせる（4-4節） |
| ISOLATED 中継を「素通し」だと思い込む | エンジンが `post()` しているのに background に何も届かない。**コードを何度見ても原因が分からない** | `content_yt_chat.js` は `ev` で**選別している**。v2.6.4 で `ready` がここで捨てられていた。中継4ホップの各段は素通しではない前提で調べる |
| 失敗理由を1つの文言にまとめる | 通常動画を入れただけで「拡張機能の許可を確認」と案内され、利用者が無関係な調査へ誘導される | 原因ごとに理由コードを付けて出し分ける（1-5節 / 8-8節） |
| 「取得成功」と「表示できる」を同一視する | 0件で終わった枠が無言の空欄になり、不具合と区別がつかない。エラーではないので案内も出ない | 成功・失敗の二値にせず「0件」を第三の状態として扱う（8-9節） |
| 表示の分岐を `updateChatContent` にだけ足す | **取得直後だけ**案内が出ず空欄になる。閉じて開き直すと出るので「たまに直る」ように見え、原因を追いにくい | 取得完了の反映は `handleChatDone` → `refreshChatCardsFor` を通り、そこは `showChatList` / `rebuildChatList` を**直接**呼ぶ。表示の分岐は**2箇所**に要る（8-9節） |

---

## 7. データ構造

### 7-1. InnerTube の応答形式

```json
{ "continuationContents": { "liveChatContinuation": {
    "actions": [{ "replayChatItemAction": {
        "videoOffsetTimeMsec": "8123",
        "actions": [{ "addChatItemAction": { "item": {
            "liveChatTextMessageRenderer": {
              "id": "...",
              "message": { "runs": [
                { "text": "待機！" },
                { "emoji": { "emojiId": "UC.../...",
                             "shortcuts": [":_メイカちゃんねるまがお:"],
                             "isCustomEmoji": true,
                             "image": { "thumbnails": [{ "url":"https://...", "width":24 },
                                                       { "url":"https://...", "width":48 }] } } }
              ]},
              "authorName": { "simpleText": "@凜-e6b" }
            } } }]
    }}],
    "continuations": [{ "liveChatReplayContinuationData": { "continuation": "..." } }],
    "header": { "liveChatHeaderRenderer": { "viewSelector": { ... } } }
}}}
```

### 7-2. イベント種別の振り分け

レンダラー名で判定する。

| レンダラー名 | 内容 | 扱い |
| :--- | :--- | :--- |
| `liveChatTextMessageRenderer` | 通常コメント | ✅ 本命 |
| `liveChatPaidMessageRenderer` | スパチャ | ✅ 採用（金額は `purchaseAmountText`） |
| `liveChatViewerEngagementMessageRenderer` | YouTubeの案内文 | ❌ 除外 |
| ティッカー | スパチャのティッカー表示 | ❌ 除外（重複） |

⚠️ **ティッカーは `addChatItemAction` の中に来ない。** `addLiveChatTickerItemAction` という
別のアクション種別で届くため、レンダラー名を見るより手前で弾かれる。

**重複排除は `renderer.id` で行う。** チャンク境界で同じアイテムが再送されることがある。

### 7-3. `message.runs` は text と emoji が混在する ★重要

| 種別 | 判定 | 扱い |
| :--- | :--- | :--- |
| **カスタム絵文字** | `isCustomEmoji: true` | `shortcuts[0]`（`:_xxx:`）を本文に入れ、**画像URLを辞書へ登録** |
| **標準絵文字** | `isCustomEmoji` なし | `emojiId` に**Unicode文字そのもの**が入っている。そのまま本文へ（辞書不要） |

```js
if (e.isCustomEmoji) {
  const sc = e.shortcuts?.[0] || e.emojiId;
  s += sc;
  if (!emoji[sc]) emoji[sc] = pickLargestThumbnail(e);   // 実測 w48
} else {
  s += (e.emojiId || e.shortcuts?.[0] || '');
}
```

⚠️ 正規表現 `:[^:\s]+:` で数えるとカスタム以外も拾って過大になる。判定は `isCustomEmoji` で行う。
画像は `image.thumbnails[]` の**最大サイズ**を選ぶ（拡大表示で粗くならないようにするため）。

### 7-4. 整形後のフォーマット（確定）

```json
{
  "v": 2,
  "videoId": "d3bgw8r84mA",
  "fetchedAt": 1784941363,
  "emoji": { ":_メイカちゃんねるまがお:": "https://yt3.ggpht.com/..." },
  "comments": [
    { "t": 0,    "n": "@凜-e6b",   "m": "待機！" },
    { "t": 8123, "n": "@ばんそう", "m": ":_あいさつ:", "p": "￥1,000" }
  ]
}
```

| キー | 内容 |
| :--- | :--- |
| `t` | `videoOffsetTimeMsec`（数値ms）。**昇順にソート済み** |
| `n` | 投稿者名 |
| `m` | 本文（カスタム絵文字はショートカット文字列のまま） |
| `p` | スパチャ金額。**表示文字列**（`"￥1,000"`）。通貨記号を保つため数値化しない |

ストリーミングでは `comments` をチャンクに分割して送り、`emoji` は**そのチャンクで新規に
見つかったぶんだけ**を載せる（辞書全体を毎回送らない）。

---

## 8. A側（表示）の実装

### 8-1. 主な状態と定数

| 名前 | 内容 |
| :--- | :--- |
| `chatStore[videoId]` | `{ comments, emoji, source, complete, truncated, gap, videoMs, lastT, nextSeq }` |
| `chatState[videoId]` | `'loading' \| 'streaming' \| 'ready' \| 'error'` |
| `chatInflight[videoId]` | 多重要求の抑止（`applyChatLayoutForCard` から繰り返し呼ばれるため必須） |
| `chatCursor[cardId]` | 次に描画するコメントの添字 |
| `chatLastMs[cardId]` | 前回tickの再生位置（シーク検知に使う） |
| `chatStick[cardId]` | 自動追尾するか |
| `chatUserScrollAt[cardId]` | 最後に人間が操作した時刻 |
| `chatWatchdog[requestId]` | 取得の見張りタイマー |
| `CHAT_MAX_NODES` | 400（超えたら古い方からDOMを捨てる） |
| `CHAT_SEEK_TOLERANCE_MS` | 2500（これ以上飛んだらシークとみなす） |
| `CHAT_CONTEXT_COUNT` | 30（シーク直後に遡って表示する件数） |
| `CHAT_RATIO_MIN` / `MAX` | 15% / 70% |
| `CHAT_FONT_MIN` / `MAX` / `STEP` | 0.6 / 2.4 / 0.1 |
| `flowVisible[cardId]` ★v2.7.0 | 流しを出すか |
| `flowCursor[cardId]` ★v2.7.0 | 次に流すコメントの添字。**`chatCursor` と共用しない**（`/get-danmaku-spec` 1-4節） |
| `flowLastMs[cardId]` ★v2.7.0 | 前回tickの再生位置（シーク検知） |
| `flowLanes[cardId]` ★v2.7.0 | レーンごとの表示中コメント配列 |
| `flowClockMs` / `flowClockAt` ★v2.7.0 | tickで読んだ再生位置と、その時刻（フレーム間の補間用） |
| `flowFrozenMs` / `flowLastEstMs` ★v2.7.0 | 一時停止した瞬間の位置と、直近フレームで描いた位置 |
| `FLOW`（定数群） ★v2.7.0 | `/get-danmaku-spec` 1-1節。**直書きしない。** v2.7.1 からUIで書き換わる |
| `FLOW.color` / `opacity` / `areaRatio` / `shadow` ★v2.7.1 | 見た目の調整値（`/get-danmaku-spec` 2-1節） |
| `FLOW_DEFAULTS` ★v2.7.1 | 既定値。「既定値に戻す」で書き戻す |
| `FLOW_KEYS` ★v2.7.1 | `FLOW` のキー → `localStorage` キーの対応表 |
| `cardUrls[cardId]` ★v2.7.1 | 枠に読み込んだ動画のURL。URL永続化の情報源（`/get-protocol-spec` 8節） |

`source` は `'innertube'`（取得）または `'cache'`（IndexedDB）。
`gap` は `seq` の欠番を検出したフラグで、**立っているとキャッシュに保存しない。**

### 8-2. 同期方式

各枠の `getCurrentTime()`（ms換算）と `t` を比較して追いついた分だけDOMへ追加する。
**postMessage による位置同期は一切不要。**

| 挙動 | 実装 |
| :--- | :--- |
| 通常再生 | tick（250ms）ごとに `chatCursor` から `t <= ms` の分を追加 |
| シーク | 前回位置から `CHAT_SEEK_TOLERANCE_MS` 以上飛んだら**二分探索で位置を出し直して組み直す** |
| 一時停止 | 位置が進まない＝追加されない（特別な処理は不要） |
| 速度変更 | 2倍でも1tick 500msなので許容範囲 |
| スクロール中 | 下端から24px以上離れていたら追尾を止め「▼ 最新へ」ボタンを出す |
| 動画差し替え | tick内で `getChatVideoId()` と比較し、変わっていたら読み直す（自己修復も兼ねる） |

### 8-3. ⚠️ セキュリティ上の必須事項

**コメント本文の描画に `innerHTML` を使ってはいけない。**
必ず `document.createTextNode()` / `textContent` で積むこと。
絵文字だけ `<img>` を `createElement` で作って挿入する。

### 8-4. レイアウト上の注意（既知の罠）

- チャット欄の幅は **px ではなく枠に対する割合(%)** で保持する
  （px固定だと枠が小さいときに flex が縮められず、グリッドのトラック幅を押し広げる）
- `.player-container` の `min-height` は **0**（100px を残すと「下配置」時に枠が膨らむ）

### 8-5. 文字サイズ

チャット欄ヘッダーの `A-` / `A+`。**枠ごとに独立**して 60%〜240% を10%刻みで変更。
`.chat-container` に `--chat-font-scale` を載せ、
`font-size: calc(0.68rem * var(--ui-scale) * var(--chat-font-scale,1))`。
localStorage（`sync_chat_font_map`）とセッションの両方へ保存。

⚠️ 文字サイズを変えると下端判定がずれる。追尾中なら変更後に最新位置へ寄せ直すこと。

### 8-6. 撤去済み（復活させないこと）

`buildReplayChatUrl` / `buildLiveChatUrl` / `encodeContinuation` / `chatInfoCache` /
`chatContinuation*` / `requestChatContinuation` / `handleChatContinuationResult` /
モード切替（📼🔴）一式 / iframe要素 / `requestChatViaHelper` / `handleChatArchiveResult` /
`chatFellBack` / `state:'chatArchive'` 分岐。

### 8-7. 診断

コンソールで **`chatDebug()`** を実行すると、各枠の videoId・状態・件数・絵文字数・
再生位置・カーソル・欠番の有無が `console.table` で出る。

### 8-8. 取得失敗時の案内文 ★v2.6.4

`showChatFailNote(cardId, videoId)` が `chatError[videoId]` の先頭の理由コードで分岐する。

```js
const m    = raw.match(/^([A-Z_]+):\s*([\s\S]*)$/);
const code = m ? m[1] : '';
const msg  = m ? m[2] : raw;
```

| コード | 見出し | 切り分け手順①②③ | 再試行ボタン |
| :--- | :--- | :---: | :---: |
| `NOT_LIVE_ARCHIVE` | `ライブ配信のアーカイブではないため、チャットはありません` | 出さない | 出さない |
| `CHAT_DISABLED` | `この配信ではチャットのリプレイが無効になっています` | 出さない | 出さない |
| `MEMBERS_ONLY` | `この動画は再生できません（YouTubeが返した理由）` | 出さない | **出す** |
| コード無し | `コメントを取得できませんでした。` | **出す** | 出す |

「切り分け手順①②③」とは、画面に出る次の4行のことである。**略号で書かない。**

```
確認する順番:
① YouTubeのタブでツールバーの拡張機能アイコン →「このサイトでの実行を許可」
② 画面右上のバッジが緑（HTMLとアドオンの版数が一致）か
③ チャット無効／メンバー限定の配信ではないか
```

- **理由コードを画面に露出させない。** 必ず分解してから表示する
- `msg` は `escapeChatText` を通す（`showChatNote` は HTML 文字列を受け取る作りのため）
- `MEMBERS_ONLY` だけ再試行を残すのは、**ログインし直せば状況が変わりうる**ため。
  `NOT_LIVE_ARCHIVE` / `CHAT_DISABLED` は何度押しても結果が変わらない

⚠️ **失敗状態の枠でしか案内文は保たれない。** 成功している枠の `chatError` を書き換えても、
tick（250ms）が正しい状態を再適用して**表示が即座に戻る。**
案内文を検証するときは、失敗状態の枠の**失敗理由だけを差し替える**こと。

### 8-9. コメントが0件のときの表示 ★v2.6.5

**「取得成功」「取得失敗」の二値では足りない。** 取得が成功して1件も無い状態があり、
v2.6.4 まではここが**無言の空欄**になっていた（利用者から見て不具合と区別がつかない）。

| 状態 | `chatState` | 表示 | ヘッダー |
| :--- | :--- | :--- | :--- |
| 成功・1件以上 | `ready` | コメント一覧 | `💬 チャット (356)` |
| **成功・0件** | `ready` | **`showChatEmptyNote()`** | **`💬 チャット (コメントなし)`** |
| 失敗 | `error` | `showChatFailNote()`（8-8節） | `💬 チャット` |

```js
function showChatEmptyNote(cardId, videoId) {
    const store = chatStore[videoId];
    const incomplete = !!(store && (store.complete === false || store.truncated || store.gap));
    showChatNote(cardId,
        'コメントが1件も見つかりませんでした。' +
        '<span class="sub">' +
        '考えられる原因:<br>' +
        '① メンバー限定の配信（ログイン済みでもリプレイ本体が空で返ることがあります）<br>' +
        '② 配信者がチャットのリプレイを公開していない<br>' +
        '③ 配信中にコメントが1件も無かった<br>' +
        (incomplete ? '<br>取得は最後まで到達していません。' : '') +
        '</span>' +
        '<button onclick="reloadChat(\'' + cardId + '\')">再試行</button>');
}
```

- **再試行ボタンは出す。** ログインし直すと結果が変わりうる（`MEMBERS_ONLY` と同じ理由）
- `(incomplete ? ...)` の行だけが可変。完走した0件では出ない
- **`⚠不完全` は出さない。** 0件は「不完全」ではなく「無い」

#### 🔴 分岐は2箇所に要る（経路が2本ある）

| 経路 | 通る関数 | いつ |
| :--- | :--- | :--- |
| 取得直後 | `handleChatDone` → **`refreshChatCardsFor`** | 取得が終わった瞬間。チャット欄を開いたまま待っていた場合 |
| 開き直し | `toggleChatVisibility` → **`updateChatContent`** | いったん閉じて開き直した場合 |

**`refreshChatCardsFor` は `updateChatContent` を呼ばない。**
`showChatList` / `updateChatHeadTitle` / `rebuildChatList` を直接呼ぶため、
`updateChatContent` にだけ分岐を足すと**取得直後だけ空欄**になる。

⚠️ `refreshChatCardsFor` 側の分岐は **`ready` のときだけ**にする。
`streaming`（取得中）で0件なのは「まだ届いていない」だけなので案内を出してはいけない。

#### 表示が保たれる理由

`pumpChatProgress`（250ms tick）は `list.style.display === 'none'` で早期脱出する。
案内文を出すと `showChatNote` がリストを `none` にするため、**tick に上書きされない**（実測で確認）。

#### 診断値は変えていない

`chatDebug()` の「完走」列は `complete` をそのまま出す。0件の空振りは `完走=×` / `取得元=innertube` /
`件数=0` として見える。**v2.8.0 の段階5-C でこの内訳が要る**ため、ヘッダー表記に合わせて丸めない。

---

### 8-10. ニコニコ風コメント流しと調整UI → `/get-danmaku-spec` へ移動 ★2026-08-15

⚠️ **8-11 は欠番。** 旧 8-10節（流し）と旧 8-11節（調整UI）を**本節1つに統合した**ため。
🔴 **繰り上げないこと。** 8-12節は `/get-ui-spec` や `/get-mgmt-guide` 4節・history から
**「8-12節」という番号で参照されており、詰めると参照が全部ずれる。**

**旧 8-10節（ニコニコ風コメント流し ★v2.7.0）と旧 8-11節（コメント流しの調整UI ★v2.7.1）は
`/get-danmaku-spec` 1節・2節が正本。** 本スキルが 1,288行となり目安の1,200行を超えたため、
2026-08-15 に「コメント流し」という主題で分離した（`/get-mgmt-guide` 4節。旧 `/get-dev-workflow` 3-7節）。

| 旧番号 | 内容 | 移動先 |
| :--- | :--- | :--- |
| 8-10節 | 描画方式（rAF）・時刻源・間引き・確定した定数（`FLOW`）・実測で覆った前提・罠・恒久制約 | **`/get-danmaku-spec` 1節** |
| 8-11節 | 設定できる7項目・関数の分担・実装上の決めごと・UI上の配置・実測 | **`/get-danmaku-spec` 2節** |

⚠️ **ライブ配信での流しの相違点（1-6節）は本スキルに残してある。**
`FLOW_LIVE_SPAWN_PER_TICK` / `FLOW_LIVE_BACKLOG_MAX` は **1-6-5節**が正本
（取得側の事情に由来する定数のため移していない）。`/get-danmaku-spec` 3節から辿れる。

---

### 8-13. 🔴 参照されなくなったコメントの破棄 ★v2.8.3

#### なぜ要るか

`chatStore[videoId].comments` は動画1本で数万件になる（実測: 52,358件 / 39,119件）。
v2.8.2 まで、枠の後始末は **5つの経路がそれぞれ別の後始末**をしており、
どの経路でもコメント配列は手元に残り続けた。**長く使うほどメモリが積み上がる。**

#### 🔴 経路ごとに「消す／消さない」を書かない

経路ごとに書き足すと、6つ目の経路ができた瞬間にまた漏れる
（v2.7.1 の「URLが復活する」不具合と同じ構造）。
**参照集合を1か所で定義し、「参照が無いものを捨てる」関数を1本だけ持つ。**

#### 参照集合の3条件（`collectChatRefs(exceptCardId)`）

`activeCardIds` の各枠について、次のいずれかに該当する videoId を「参照あり」とする。

| # | 条件 | 落とすとどうなるか |
| :-: | :--- | :--- |
| 1 | `chatLoadedVideoId[cardId]` | チャット欄が描画中のコメントが消える |
| 2 | `flowVideoId[cardId]` | 🔴 **流しだけONの枠**のコメントが消える。流しは `chatStore[videoId].comments` を直接読む |
| 3 | `getChatVideoId(cardId)` | 🔴 **枠に動画は入っているがチャット欄を閉じている**状態。捨てると開き直すたびに取り直しになる。「閉じても取得は止めない」という既存の設計もここが担保する |

⚠️ **`chatVisible` を条件に入れてはいけない。** 上の2と3が漏れる。
`exceptCardId` は、これから消える枠を集合から外すために使う
（枠が `activeCardIds` から外れる前に呼ぶ経路があるため）。

#### 解放の手順（`releaseUnusedChatData(reason)`）

1. 参照集合を作る
2. **参照が無くなった取得を中止する**（`chatInflight` を走査して `cancelChatRequest()`）
3. 中止のあとに `chatInflight` / `chatPending` を数え直し、参照集合へ足す
4. `chatStore` / `chatState` / `chatError` / `liveVideoIds` から参照の無いキーを消す

🔴 **中止が先・解放が後。この順序を関数の内部で保証する。**
先に捨てると、遅れて届いたチャンクが `ensureChatStore()` で store を作り直し、
**途中からの断片だけが残る。**

🔴 **②を飛ばすと解放は原理的に効かない**（③で取得中は捨てないため）。
とくに配信中のライブは取得が終わらないので、**止めない限りコメント配列は伸び続ける。**
⚠️ **2026-08-30 の指示書はこの帰結を書き落としており、開発用セッションが着手前に指摘した**
（管理用セッションの誤り）。**呼び出し表を書いたら参照集合と突き合わせること。**

🔴 **冪等。** いつ何度呼んでも安全であること。呼ぶ場所を増やしても壊れない。

#### 呼び出す5つの経路

| 経路 | 呼ぶ場所 | 注意 |
| :--- | :--- | :--- |
| 🗑 枠の削除 | `deletePlayer()` の末尾 | 🔴 **`updateCardOrder()` の後に呼ぶ。** 先に呼ぶと消したはずの枠がまだ `activeCardIds` に残っていて解放できない |
| 🧹 枠を空にする | `resetPlayer()` の末尾 | `flowVideoId[cardId] = null` を先に行う |
| ➖ 枠数を減らす | `initializeGrid()` の削減ループを**抜けたあと1回だけ** | 🔴 **ループの中では呼ばない**（枠が減っている途中の集合で判定してしまう）。この経路は `clearChatState()` をまったく通らないので、ループ内で `clearFlowState(removeId)` を呼ぶ。⚠️ **`updatePlayerCount()` という関数は存在しない**（実体は `changePlayerCount()` → `initializeGrid()`） |
| ローカル動画へ差し替え | `handleLocalSelect()` | `flowVideoId[cardId] = null` を先に行う |
| 同じ枠に別の動画 | `loadSingleYT()` の末尾 | ⚠️ **`loadSingleYT()` は `updateChatContent()` を呼ばない**（`onReady` の200ms後）。切らずに解放を呼ぶと `chatLoadedVideoId` が旧 videoId のままで**永久に解放されない**。動画が変わったときだけ `chatLoadedVideoId` と `flowVideoId` を null にする（同じ動画の読み直し＝🔄 では切らない） |

🔴 **中止処理を `closeChat()` の中に書かない。**
`closeChat()` は 💬 の開閉からも同種の状態変更が走っており、
**「チャット欄を閉じただけでは取得を止めない」のは意図的な設計である。**

#### 中止の判定も同じ参照集合にする（★v2.8.3 で変更）

`maybeCancelChat(videoId, exceptCardId)` は `collectChatRefs(exceptCardId)` を使う。
⚠️ **v2.8.2 までは「チャット欄を表示している枠」だけを数えていた**（`chatVisible && chatLoadedVideoId`）**ため、
流しだけONの枠・チャット欄を閉じている枠が使っている取得まで止めていた**（既存の潜在不具合）。

#### 実測（2026-08-31 / 2026-09-05 / Floorp / GitHub Pages）

| 経路 | 実測 |
| :--- | :--- |
| 🗑 削除 / ➖ 枠数減 | `chatStore` のキー数 **1 → 0**、`chatInflight` も消滅 |
| 🧹 空にする | **streaming 中（146件到達時点）に押して中止が成立。3秒後も再生成されず** |
| 共有中 | 削除後もキー数 **1のまま**・件数 **356 不変**・`chatState` は `ready` |
| 流しだけON | 解放前 max 17件（0件だった回数1）→ **解放後 max 52件・avg 39.92・0件だった回数 0** |
| 実利用のメモリ | 「読み込み → 🧹」を5回 ＋ 30秒待機で **228MB → 230MB**（積み上がりなし） |

⚠️ **ライブ配信での実測は未了**（`/get-protocol-spec` 11節 持ち越し4）。v2.11.0（ライブ取得の自動復帰 ─ v2.9.0 → v2.10.0 → 2026-10-04 に v2.11.0 へ繰り下げ）で測る。

---

### 8-12. トップバーのメニュー構造 → `/get-ui-spec` 1節へ移動 ★v2.7.3 / 移動先変更 2026-08-07

パネルの確定値（幅420px / `box-sizing: border-box` / `z-index` 120 / `closeTopMenus()` への集約 /
`.top-bar` に `position: relative` を足さないこと）は **`/get-ui-spec` 1節が正本**。
⚠️ v2.7.3 では `/get-protocol-spec` 12節が正本だったが、**2026-08-07 に `/get-ui-spec` 1節へ再移設した。**

**コメント機能に限らないため移した。** v2.7.3 で `debug_suite.js` が同じ確定値のまま
4枚目（`🐞 デバッグ`）を動的生成できることが実証されている。

---

## 9. テストの進め方

### 9-1. 本番コードに触れず、別IDの独立したテストアドオンで検証する

2026-07-26 の取得方式検証は全段階（1-A〜1-F）をこの方式で通した。
**現行リリースを壊すリスクなしに確認できる。**

段階の切り方の原則: **アドオン不要な範囲 → タブ1枚 → 注入 → 複数本 → 中継 → 定数の掃引**。
外側から1つずつ条件を足していくと、どこで壊れたかが必ず1手で分かる。

### 9-2. テスト手順書の作り方

**→ `/get-dev-workflow` 2節を参照。** 依頼のたびに新しく作ること、項目ごとに自己完結させること、
画面に出る文字列を略号でなく全文で載せること、動画IDは 9-8節の実測済みのものを使うことが規約になっている。

### 9-3. 🔴 バックグラウンドスクリプトの `console.log` は見えない

MV3 のバックグラウンドの出力は `Ctrl + Shift + J` には出ない。
`about:debugging` → 対象アドオンの **「調査」ボタン**から開く開発ツールに出る。
**検証ツールは結果を画面に出す作りにした方が確実。**

### 9-4. 「決定的なテスト」を宣言するときは慎重に

過去、iframe方式の検証で「これが決定的」と3回宣言し3回とも外した。
前提条件（実行コンテキスト、オリジン、リクエスト形式）が揃っているかを先に確認すること。

### 9-5. 実測は設計案をよく否定する

2026-07-26 の検証では事前想定6項目が、段階1-F では3項目が覆った。
**性能・比率に関する直感は当てにならない。設計を書く前に測ること。**

### 9-6. ⭐ 計測ツール自身のバグを疑う

実測は設計案をよく否定するが、**計測ツールもよく嘘をつく。**

**見分け方は「規則性があるかどうか」。** 段階1-F の1回目は全7条件で欠落が出たが、
欠けたのは毎回1メッセージだけ・毎回その回で最後に終わった動画・欠落件数が毎回約45件と揃っていた。
**乱れではなく規則があるなら、それは伝送の問題ではない。**
原因は計測アドオンが `executeScript` の解決直後にタブを消していたことだった。

同時に、**本番の設計にも同じ穴があることが分かった**（3-2節の done 同梱）。

### 9-7. 隠しタブの確認方法

`tabs.hide()` したタブはタブバーに出ないため、**枚数を目視で数えられない。**

```js
// about:debugging → 当アドオンの「調査」→ コンソールで実行
(await browser.tabs.query({ url: "https://www.youtube.com/*", hidden: true })).length
```

利用者に説明するときは、タブバー右端の `∨`（すべてのタブを一覧表示）→「隠されたタブ」項目。

⚠️ 「調査」はアドオンを再読み込みすると閉じる。再読み込み後の枚数を見るときは開き直すこと。
⚠️ 「調査」を開いている間はバックグラウンドがアイドル終了しない。

**アドオンを無効化・削除すると、隠していたタブは表示状態に戻る**（Firefox の安全弁）。
隠しタブが溜まって収拾がつかなくなったときの逃げ道になる。

### 9-8. 検証に使った動画ID

| 表記 | 動画ID | 特性 | 測定日 |
| :--- | :--- | :--- | :--- |
| `VID_LIGHT` | `zuuZyNH0F1Y` | 軽いアーカイブ。356件 / 70.6分（`duration` 4259秒）。チャンネル **nemuCh. 音夢多 ねむね** | 2026-07-26 |
| `VID_MID` | `d3bgw8r84mA` | 中量のアーカイブ。902件 / 101.3分 ＝ **0.15件/秒**。⚠️ **流し系の検証には薄すぎる**（下記） | 2026-07-26 |
| `VID_HEAVY` ⚪2026-08-14 再確認 | `q176a2krHbg` | 重いアーカイブ。**52,358件**（2026-08-14 / 従来値 52,362件は 2026-07-29）/ 129.5分。**1,192req・249秒で完走** | 2026-08-14 |
| `VID_ARCHIVE` | `VD8GJ4IYvQY` | ライブ配信のアーカイブ。**`NOT_LIVE_ARCHIVE` が誤爆しないことの確認に使う** | 2026-07-29 |
| `VID_REGULAR` | `J-TXiDsIdv0` | ライブ配信ではない通常の投稿動画（9分31秒） | 2026-07-29 |
| `VID_MEMBERS` | `AoaL9zbPAkA` | メンバー限定のアーカイブ。**7307.061秒（約2時間2分）**。⚪ **v2.7.5 で 8,522件・完走**（179req / 28.5秒 / メンバー専用絵文字21件）。**非ログインは `MEMBERS_ONLY` で失敗**（原因は 1-3-2節 ─ POST に認証ヘッダが無かった / v2.7.5 で解消）。**埋め込みは `onError = 150`**（5-A / 2026-08-04）。チャンネルは `VID_SAMECH_PUBLIC` と同じ | 2026-08-14 |
| `VID_INVALID` ★2026-08-07 | `aaaaaaaaaaa` | **存在しない動画ID。** `onError = 150` が返る（メンバー限定と同じコード）。**「再生が絶対に始まらない状態」を作れるので positive control に使える** | 2026-08-07 |
| `VID_SAMECH_PUBLIC` ★2026-08-04 | `NshKf1Pw9nA` | 🔴 **`VID_MEMBERS` と同一チャンネルの「公開」アーカイブ。** 倉持めると / Kuramochi Meruto【にじさんじ】/ **3:13:09**（`duration` 11589）。⚪ **39,199件・完走**（849req / 106秒 / 2026-08-14）。⚠️ **スパイク5-C の「430件」は8リクエストぶんの部分計測で総件数ではなかった**。⚪ **埋め込み再生できる**（方式①②③・ログイン有無・保護設定を問わず / 5-A2・5-A3）。**メンバー限定との対比を取る素材として今後も有効** | 2026-08-05 |
| `VID_LIVE` | 🔴 **その都度選ぶ** | **配信中のライブ。** 実施時にしか存在しないので固定できない。⚠️ **配信開始から10分以上たっているものを選ぶこと**（開始3分半で `error / 0秒` になった実例あり / 2026-08-15。**再取得ボタンで成功**）。⚠️ **件数を固定値で期待しない**（増え続けるため `note()` に留め、判定は「単調非減少」と「増えたこと」で行う） | ─ |
| `VID_CHAT_OFF` | 🔴 **未確保** | チャットのリプレイが無効なアーカイブ。🔴 **人工再現は成立しないことが確定した**（下記）。**B側判定は未検証のまま。実素材の確保が必要。** 見つけ次第ここへ記入する | — |

⚠️ `VD8GJ4IYvQY` は当初「通常動画」として扱ったが**アーカイブだった。**
動画IDを手順書へ載せる前に、実際にその特性を持つか確かめること。

🔴 **positive control の素材は「変えたい条件だけが違うもの」を選ぶこと。**
5-A では `VID_MEMBERS`（メンバー限定）の対照に `VID_LIGHT`（**別チャンネル**の公開動画）を使ったため、
**チャンネルとメンバー限定の2つが同時に違い、原因を切り分けられなかった**（2026-08-04）。
`VID_SAMECH_PUBLIC` はこの反省から確保した素材である。

🔴 **件数ではなく密度（件/秒）で選ぶ。**
v2.7.0 の流しの検証を `VID_MID`（**0.15件/秒**）で組んだところ、流し時間が4秒なので
**画面上0件が正常な状態**になり、「流れているか」「シークで作り直されたか」が判定できず
1ラウンド無駄にした。**流し・追従など単位時間あたりの件数が効く検証は
`VID_HEAVY`（ピーク6.7件/秒）を使う。**
⚠️ `VID_HEAVY` にも薄い区間がある。**実際に流れている場面で計測させる**と手順書へ書くこと。

🔴 **⛔【行き止まり】`JSON.parse` の差し替えによる人工再現は成立しない**（2026-08-15 確定）

チャットのリプレイが無効なアーカイブは狙って見つけるのが困難なため、
**通常のアーカイブに応答を人工的に細工して B側判定を確認する**方針を 2026-07-29 に採った。
**この方針は取り下げる。**

| 試した手口 | 結果 |
| :--- | :--- |
| 取得タブの MAIN world で **`JSON.parse` を差し替える** | 🔴 **通らない。** `chat_fetcher_main.js` 312行が `return await res.json()` で、**`Response.json()` はネイティブ解析のため `JSON.parse` を一度も通らない** |
| **`Response.prototype.json` を差し替える** | 🔴 **取得経路へ届かなかった**（2回実測） |
| 参考 | `scripting.executeScript({world:'MAIN'})` で置いた `window.__probe` は**別呼び出しからも読める**。**世界そのものは保たれているが、届かない理由は未特定** |

⚠️ **2026-08-02 に「人工再現で確認した」と記録していたのは `liveChatRenderer` を消す別の判定**
（`liveChatRenderer` へ**到達できなかった**とき / 8-8節）であり、
**v2.7.5 で追加した「到達した後」の `CHAT_DISABLED`（1-3-3節）とは別の場所である。混同しないこと。**

🔴 **したがって実素材（`VID_CHAT_OFF`）の確保が必要になった。**
**見つけ次第、上表へ動画IDを登録すること。** 取れるまで 1-3-3節の B側判定は未検証のまま。

⚠️ **取得タブの MAIN world へ外から手を入れる手段は事実上ない**（開発上の制約）。
取得タブの寿命は設定メニュー「コメント取得用タブ」に従う（`keep` = 0 / `idle10` = 600000 / `close` = 3000）。
**コンソールから取得タブへ手を入れる作業は `keep` にしてから行うこと。**

🔴 **測定の前に「コメントのキャッシュ」を空にすること。**
キャッシュが残っていると取得エンジンを通らずキャッシュから表示され、**判定そのものが成立しない。**


### 9-9. 🔴 Firefox の開発ツール特有の落とし穴

検証で2回止まった。**コンソールを使う手順を書くときは毎回明記すること。**

| 症状 | 原因 | 対処 |
| :--- | :--- | :--- |
| `(async () => {...})()` の返り値が出ず `Promise { <state>: "pending" }` で止まる | **Firefox はコンソールで Promise を自動 await しない**（Chrome とは違う） | `.then(r => console.log(...))` で明示的に出力する |
| ページの関数が軒並み `is not defined` | コンソールの**評価対象ドキュメントが埋め込み iframe になっている** | まず `location.href` で確認し、入力欄右上の対象ドキュメント選択で「Top」を選ぶ |

**隠しタブの中を見るのに `tabs.show()` は不要。**
`scripting.executeScript({ world:'MAIN', func })` で隠したまま読める。
表示 → `F12` → 手で閉じる、という手順は閉じ忘れの事故を生むので採らない。

---

## 10. 環境情報

| 項目 | 値 |
| :--- | :--- |
| OS / シェル | Windows / Windows PowerShell 5.1 |
| ブラウザ | **Firefox 153**（MV3、`host_permissions` はオプトイン）/ Floorp |
| `world:'MAIN'` 対応 | Firefox 128以降。153で動作確認済み |
| ローカルサーバー | Simple Web Server で `http://127.0.0.1:8080` |
| 本番環境 | **GitHub Pages** `https://syanao-coder.github.io/` |
| 拡張機能ID | `sync-player-controller-firefox@syanao-coder.github.io` |

⚠️ **PCが複数ある。** ユーザー名が `fiore` / `user` と異なるため、
ユーザー名を含むパスを設定に埋め込まないこと。

🔴 **PCが複数あることは「計測」にも及ぶ。** 負荷の基準値には**測定日だけでなく測定したPCも併記すること。**
実例: v2.7.1 の9枠CPUを v2.7.0 とは別の高性能PCで測ったため、
**基準値（約84% / 2026-07-31）と比較できなくなった**（`/get-danmaku-spec` 1-6節）。
⚠️ キャッシュは**オリジンごと**なので、`127.0.0.1:8080` と GitHub Pages で別物になる。

---

## 11. 残課題とロードマップ

**完了したVerの記録は `history_chat.md`、版数と内容の一覧は `/get-protocol-spec` 0-3節。**
ここは**未着手のものと、決着した調査の結論だけ**を持つ。
🔴 **完了した版の行はここから消すこと。** 残すと「まだやっていない」と読まれる。

⛔ **理由コード `EMPTY_REPLAY` は作らない。** B側は「取れなかった」ではなく「0件だった」としか
言えないため、判定はA側に置くのが正しい（v2.6.5 で確定・8-9節）。

### 🔴 持ち越し

| # | 内容 |
| :-: | :--- |
| 1 | 🔴 **`CHAT_DISABLED`（`liveChatRenderer` 到達後）の B側判定が未検証**（1-3-3節）。**実素材が未確保で人工再現も成立しない**（9-8節）。**v2.6.4 から4バージョン目** |
| 2 | **ライブの同時ポーリングの負荷が未実測**（2026-08-15）。上限を設けるかは測ってから決める |
| 3 | **配信終了時の挙動が未検証**（2026-08-15） |

### ⚪ 5-A / 5-C ─ 完了（2026-08-04〜10）─ 結論のみ

**段階ごとの実測・否定された仮説・撤回の経緯は `history_chat.md` 15〜18節・`history_protocol.md` 13〜21節。**

| | 結論 |
| :--- | :--- |
| **5-A（再生）** | ⚪ **条件つきで埋め込み再生できる**（条件は `/get-protocol-spec` 11節）。**ブラウザ差は無かった**（5-A5 の「Floorp では不可」は誤り）。**5-B は不要になった。** ⭐ **再生そのものには実装が要らなかった**（保護オフなら既存の `loadSingleYT()` が再生する）。失敗時の扱いは `/get-ui-spec` 2節 |
| **5-C（チャット）** | ⚪ **原因は POST に認証ヘッダが無かったこと**（1-3-2節）。`loggedOut` が **v2.6.0 から `true`** だった。**公開アーカイブでは件数が変わらないため2年近く表に出なかった。** v2.7.5 で解消（8,522件・完走） |

🔴 **再挑戦を止める記録（消さないこと）**

- **`spike_5a.html` で再生できなかった理由は未解明。** 候補は3プレイヤー同時埋め込み。
  **5-A6 中止の理由は「実用上不要」であって「解明した」ではない**
- **ライブの `t` はアーカイブ経路で流しても画面上は流れて見える**（1-6-3節）。**「流れたこと」だけでは判定できない**
- **人工再現（`JSON.parse` の差し替え）は成立しない**（9-8節）

### ⚪ v2.8.0（マイナー）／v2.8.1（パッチ）─ ライブ配信のチャット対応 ─ **完了（2026-08-15）**

確定形は **1-6節**。`chatMeta` / `chatDone` に **`live` / `liveBy` / `livePolls`** を追加＝マイナー。
v2.8.1 は A側が `liveBy` / `livePolls` を保存する3行のみ（プロトコル無変更）。

⭐ **利用者と合意した設計上の決定**（次の版でも守ること）

| # | 内容 |
| :-: | :--- |
| 1 | ⭐ **ライブ枠は同期しない。** ラグで正確に揃わないため。**揃えようとする実装を足さないこと** |
| 2 | ⚪ **同時再生には対応する。** ▶一括再生はライブ枠も対象 |
| 3 | ⚪ **チャットは全件を取る**（トップチャットではない）。アーカイブと揃える |
| 4 | ⚪ **ライブ取得中は取得タブの破棄方針を無視して維持する。** ただし**設定値そのものは書き換えない** |

⚠️ **ライブの流しは 0件だった回数が 18/30（15秒）で、10秒ごとのチャンク到着に同期して
バースト的に湧く動きになっている。** `FLOW_LIVE_SPAWN_PER_TICK`（現行4）に調整余地がある。
**利用者の体感は「前回と同じくらい流れた」で不満は出ていないので、版数は切らない。**

### 次の版

**実際に使ってみて出た要望を集める。** v2.7.0 以降は基盤・調査・修正が続いており、
実運用で確かめる機会が少ない（`/get-dev-workflow` 鉄則 #18）。
**ライブも視聴できるようになったので、一度使ってから次を決める。**

## 12. 利用上の注意
- 取得したチャットデータの扱いは、私的利用の範囲にとどめること。
- 取得したコメントの再配布・公開は想定しない。

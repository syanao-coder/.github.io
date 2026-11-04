# v2.20.0 指示書 ─ 動画の概要欄とコメント欄

発行: 2026-11-04（Claude Code）
基点: `index.html` v2.19.4 / アドオン 2.17.0 / `debug_suite.js` v1.30.4
読む仕様書: `get-dev-workflow` / `get-debug-suite` / `get-protocol-spec`（2節・4節・7-4節の中継）/ `get-chat-feature-spec` 1-8節（視聴履歴の経路＝同じ作り）/ `get-ui-spec` 15節（チャット欄の部品）/ 記録 `spike_info_i1.md`（1-3節の「実装に使う形」）
種別: 🔴 **マイナー（A↔B にメッセージを1組追加）。アドオンを 2.18.0 に上げる**（`v2.18.0.zip`）

## 1. やること（利用者と合意 2026-11-03）

チャット欄の場所に、動画の**概要欄**と**コメント欄**（チャットではない）を排他で出す。

| 項目 | 決めたこと |
| :--- | :--- |
| 切り替え | チャット欄の見出しの下にタブ「💬 チャット｜📝 概要欄｜🗨 コメント」。ヘッダーの 💬 は今どおり欄の開け閉め。枠ごと・保存しない（読み直すと 💬） |
| 時刻のリンク | **その枠だけ**シークする（この動画の `watchEndpoint` ＋ `startTimeSeconds`）。ライブの枠ではシークしない（既存の決まり） |
| 外部リンク | 別タブ（`urlEndpoint` の URL をそのまま ─ 純正と同じ `youtube.com/redirect` を通す）。http / https 以外は文字のまま |
| YouTube の中のリンク | チャンネル・ハッシュタグ・別の動画 → 別タブ。🔴 **別の動画のリンクの横に ➕**（空いている枠へ読み込む ─ アドオンの ➕送信と同じ `addOrFillVideoSlot`） |
| コメント | 純正に近く: 件数・人気順／新しい順・投稿者（アイコン・名前）・いつ・本文・👍 の数・「返信 N件」で開く（さらに続きも）・下までスクロールで次の20件。投稿者のハートは出さない（置き場所が未確認 ─ スパイク I1） |
| 🔄 | 概要欄・コメントのタブでは、その中身を読み直す |
| 文字の大きさ | A- / A+ はチャットと共通（`--chat-font-scale`） |

## 2. 経路（視聴履歴と同じ作り）

```
controller.html
  └─ window.postMessage({ type:'YT_INFO_REQUEST', requestId, videoId, op, token })
       └─ content_controller.js → runtime 'FETCH_YT_INFO'
            └─ background.js startYtInfo（取得と同じタブ・注入を確かめる）→ tabs.sendMessage 'CHAT_INFO'
                 └─ content_yt_chat.js（PASS_CMD に CHAT_INFO・op / token を渡す）→ MAIN chat_fetcher_main.js ytInfo
                      └─ 結果は ev:'info' → 取得と同じ中継 → state:'ytInfo'（op / desc / page）
```

- `op:'desc'`: `next`（`videoId`）→ 概要欄（本文・リンク）＋見出し（視聴回数・日付）＋**コメントの入り口の token**。
- `op:'page'`: `next`（`continuation: token`）→ コメントの1ページ（最初のページ・続き・並べ替え・返信のどれも同じ形）。
- 🔴 `op` / `desc` / `page` は `background.js` の `sendChatStreamEvent` と `content_controller.js` の両方で列挙して転送する（7-4節）。`content_yt_chat.js` は `op` / `token` を MAIN へ渡す。
- 失敗（タブ・注入）は `background.js` が `ev:'info', ok:false` を返す。A側は25秒答えが無ければ「答えがありません（アドオン 2.18.0 が要ります）」。

## 3. エンジン（取得タブで必要な項目だけにする ─ 1回 300〜750KB を A側へ流さない）

| 出力 | 中身 |
| :--- | :--- |
| `desc` | `{ content（最大 10000字）, runs:[{s,l,k,t,v,u}], views, date, rel, commentsToken, commentsOff }`。`k` = `seek`（この動画＋時刻）/ `video`（別の動画・`v` と `t`）/ `url`（外部・`u`）/ `channel` / `hashtag` / `yt`（そのほかの YouTube の中・`u`）。`s` / `l` は本文の位置（UTF-16）。範囲外・重なりは捨てる |
| `page` | `{ header:{ count, sort:[{title, selected, token}] } または null, items:[{ key, text（最大 5000字）, runs, author, avatar（https のみ）, published, likes, replies（件数の文字）, repliesToken, level }], next }`。🔴 `next` は**一番上の `continuationItems` の末尾**の continuation だけ（`findAll` すると返信の続きを拾う ─ スパイク I1 の罠） |

- スレッドの本文は `commentViewModel.commentKey` ↔ `mutations[].payload.commentEntityPayload.key` で結ぶ。返信のページの項目は `commentViewModel` が直接並ぶ形もある（両方を受ける）。
- 認証の Cookie があれば `SAPISIDHASH` を付ける（無くても読める）。`ytcfg` は視聴履歴と同じ（ページ → 無ければ `/` の HTML）。打ち切り 20秒。

## 4. A側

- 状態: `infoTab[cardId]`（`chat` / `desc` / `comments`）・`infoStore[videoId]`（`desc` の状態と結果・`comments` の並べ替え・項目・`next`・読み込み中・返信 `threads[key]`）。要求は `infoReqs[requestId]`。
- 🔴 本文は DOM の文字として組み立てる（`textContent`・HTML として解釈しない）。リンクは `<a target="_blank" rel="noopener noreferrer">`。時刻は `href="#"` でクリックを横取りしてシーク。
- 下までスクロール（残り 200px 以内）で次の20件。読み込み中は重ねない。最後のページでは何もしない。
- タブを 💬 に戻したらチャットを描き直す（`updateChatContent(cardId, true)`）。チャットの取得・流しには触らない。
- 動画を替えたら（`getChatVideoId` が変わったら）中身を作り直す。

## 5. 判定（`debug_suite.js` v1.31.0）

- `D-I1`（A側・偽の答え）: タブが3つ・💬 が既定・📝 で `op:'desc'` を1回・本文に `<img onerror>` を入れても解釈しない・時刻のリンクでその枠だけシーク（偽のプレイヤー・ほかの枠は動かない）・外部／チャンネル／ハッシュタグは `target=_blank` で http(s) だけ・`javascript:` は文字のまま・別の動画に ➕ があり押すと `addOrFillVideoSlot` に渡る・🗨 で入り口の token の `op:'page'`・件数と並べ替え・20件・新しい順で token が変わり作り直す・返信を開く（`level` 1・続き）・下までスクロールで次のページ（1回だけ）・最後のページでは要求しない・答えなし（時間を縮める）・古い答えは捨てる・💬 に戻すとチャットが見える・🔄 で読み直し。🔴 偽の本文に長い URL・改行・絵文字を入れる（鉄則 #53）。
- `D-W12`（実機・アドオン 2.18.0・動画の入った枠）: 📝 で 20秒以内に本文（字数 > 0）・リンクの数・🗨 で20件前後・2ページ目・並べ替え。🔴 **本文・投稿者名・リンク先は出力に載せない**（数と形だけ）。
- 版数: `APP_VERSION` 2.20.0・`ADDON_REQUIRED_VERSION` 2.18.0・`APP_HISTORY` 62件・`VERSION_FOCUS` = `D-V1` → `D-V2` → `D-I1` → `D-F1`。

## 6. 用紙（`tests/test_v2_20_0.html`）

素材（スパイク I1 で形を確かめた動画）:
- `cy1VIGFMR-4`（概要欄のリンク 33・時刻 1・ハッシュタグ・コメント2ページ以上・コメントの中の時刻）
- `3rOrpwf4OMo`（返信のあるコメント・別の動画＋時刻のリンク）

R1 すべて実行 → R2 🎯 → R3 `D-W12`（`cy1VIGFMR-4`）→ 目視（概要欄の見た目・時刻でその枠だけ動く・外部リンクが別タブ・別の動画の ➕・コメントの並べ替え・返信・下までスクロール）。🔴 本文や名前は書かない。

## 7. headless の確認

| 項目 | 結果 |
| :--- | :--- |
| エンジン（偽の youtube.com・400KB の応答） | `desc` 735B・コメント1ページ 4.4KB（20件・header・`next`）・2ページ目 `next` なし・返信（`commentViewModel` が直接並ぶ形）`level` 1・続き `RM`・重なり／範囲外／`javascript:` の run は捨てる・HTTP 500 と不正な ID は `ok:false`・認証ヘッダあり |
| `D-I1` | 36/36（PC 3/3）。変異: 旧版・全枠をシーク・本文を HTML として足す・スクロールで重ねて頼む → いずれも不合格 |
| `D-F1` / `D-V1` / `D-N3` / `D-Z2` / `D-Y5` / `D-Y7` / `D-L12` / `D-L13` | 合格（投稿欄はチャットのタブのときだけ） |
| 回帰 `▶ すべて実行` | 23本合格 |
| 用紙の自己診断 | ❌ 0 |
| 見た目（スクリーンショット・1465×967 の1枠目） | タブの文字が細い欄で切れた → 空白を詰めて文字を少し小さく。並べ替えのボタンが件数の横で折り返した → 件数を1行に |

🔴 判定の作りで踏んだこと: 偽の並べ替えの答えが「人気順」に印を付けたままで、A側が答えの見出しをそのまま使うので不合格になった → 実機と同じく選んだ並べ替えに印を付けた（鉄則 #53）。HTML の偽の本文がリンクの前にしか無く、リンクの後ろを HTML として足す変異が通った → 前と後ろの両方に入れた。

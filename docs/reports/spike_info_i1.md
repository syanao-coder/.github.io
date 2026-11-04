# スパイク I1 記録 ─ 動画の概要欄とコメント欄を読めるか

測定: 2026-11-03（利用者・Floorp・UA `Firefox/159.0`・YouTube の watch ページのコンソール）
指示書: `docs/instructions/spike_info_i1.md` / 用紙: `tests/test_spike_info_i1.html`（エンジン 3.0.1）/ 計測コード `info-i1-1.0.0`
素材: `GnwBT8F8gVk`（公開・配信から約3時間のアーカイブ）
🔴 本文・投稿者名・リンク先は記録しない（利用者が R2 に概要欄の本文を貼ってくれたが、ここには写さない）

## 1. 結論（1回目）

- 🔴 **概要欄は作れる。** `next` の `videoSecondaryInfoRenderer.attributedDescription`（＝`expandableVideoDescriptionBodyRenderer.attributedDescriptionBodyText` にも同じものがある）に本文 741字・`commandRuns` 8（チャンネル 1・外部 7）・`styleRuns` 17。リンクの位置は 8/8 が本文に収まる。見出しの材料（タイトル・視聴回数・日付・「○時間前」）もある。🔴 **ログインなし（Cookie を送らない）でも同じ本文が読める。**
- `player` の `shortDescription`（797字）は `attributedDescription`（741字）と長さが違う。R2 の本文で、表示用の本文では長い URL が `https://store.steampowered.com/app/46...` のように**短縮されている**ことが分かった（リンク先は `commandRuns` の `urlEndpoint` が持つ）→ **表示は `attributedDescription`、リンク先は `commandRuns`** を使う。`shortDescription` は使わない。
- 外部リンクは `https://www.youtube.com/redirect?...&q=<本来の URL>` の形（7件すべて）。純正もこの中継を通す → 別タブで `q` の URL を開くか、中継の URL のまま開くかを実装で決める（中継のままが純正と同じ）。
- 🔴 **コメント欄も作れる見込み。** 入り口は `comment-item-section` の continuation。1ページ目 HTTP 200・317KB・0.27秒・スレッド 7件（すべて `commentViewModel`＋`commentEntityPayload`・本文／投稿者名／アイコン／高評価数 7/7）。並べ替え2項目（token あり）・新しい順も読めた（選択中が2番目に変わる）。ログインなしでも 7件読めた。
- ⚠️ **素材のコメントが7件しかなく、確かめられなかった**: 2ページ目（続き）・返信・コメントの中の時刻リンク・固定・投稿者のハート。概要欄の時刻リンク（この動画の時刻）も素材に無かった。→ 補足の測定（コメントが多く、概要欄とコメントに時刻がある動画で J1・J2 をもう一度）。
- R2b（目視）: 純正ではコメントの時刻リンクで**同じ動画のその時刻へ飛んだ**（決めた動きと同じ）。

## 1-2. 結論（2回目・2026-11-04・素材 `cy1VIGFMR-4`・約20万回視聴の配信アーカイブ）

- 概要欄: 2,743字・`commandRuns` 33（外部 redirect 経由 23・**時刻（この動画）1**・**ハッシュタグ 3**・**YouTube 内の URL 1**・チャンネル 5）・位置 33/33・`attachmentRuns` 12（チャンネルのアイコンの差し込み）・`onTapOptions` を持つ run が 13。ログインなしでも同じ本文。→ 概要欄の材料はそろった。
- コメント: 1ページ目 **20件**（741KB・0.25秒）・**2ページ目 8件**（258KB）・新しい順 20件・コメントの中の**時刻（この動画）1**・ログインなしで20件。→ 続き・並べ替え・時刻リンクの材料はそろった。
- ⚠️ **返信はまだ**: 20件すべて「返信の token なし・`replyCount` なし」。人気の配信の上位20件に返信が1件も無いのは不自然 → 計測コードが返信の置き場所を見落としている疑い。→ 1.1.0 で名前（キー）の道筋だけを記録する補足を出す（値・本文は出さない）。
- 利用者が R2 に概要欄の本文を貼った（2回目も）。記録には写さない。用紙の R2 を「数だけ答える」形に変えた。

## 1-3. 結論（3回目・2026-11-04・計測コード 1.1.0・素材 `3rOrpwf4OMo`）→ 🔴 スパイク完了

- 🔴 **返信の置き場所が分かった**: `commentThreadRenderer.replies.commentRepliesRenderer.subThreads[0].continuationItemRenderer.continuationEndpoint.continuationCommand.token`（1.0.0 の `findOne(t.replies, 'continuationCommand')` でも見つかる形。2回目の素材は**上位20件に本当に返信が無かった**と見るのが正しい ─ 1.0.0 の数え方の誤りではなかった）。返信の要求 HTTP 200・130ms・`commentEntityPayload` の `replyLevel` 1。ボタンの文言は `viewReplies` / `hideReplies`（`buttonRenderer.text.runs`）にある。
- 返信数は `commentEntityPayload.toolbar.replyCount`（14件すべてにキーがあり、値があるのは返信のある1件だけ）。
- ⚠️ 「投稿者のハート」の数え方は誤り: `toolbar.creatorThumbnailUrl` は全件にある（14/14）→ ハートの有無は別の場所（`engagementToolbarStateEntityPayload` など・未確認）。実装ではハートを出さない（純正に近づけるのは後回し）。
- `mutations` には `commentEntityPayload` のほか `commentSurfaceEntityPayload` / `engagementToolbarStateEntityPayload` / `triStateButtonStateEntityPayload` / `engagementToolbarSurfaceEntityPayload` / `commentSharedEntityPayload` がある。スレッドと本文は `commentViewModel.commentKey` ↔ `commentEntityPayload.key`（`entityKey`）で結ぶ。
- 概要欄: `commandRuns` 8（ハッシュタグ 2・**別の動画＋時刻 2**・**この動画（時刻なし）1**・時刻 3）。`onTapOptions` を持つ run が多い（純正のリンクの開き方の指定と見られる・実装では使わない）。
- 素材のコメント14件・2ページ目なし（2回目の素材で2ページ目は確認済み）。ログインなしで14件。

### 実装に使う形（まとめ）

| 用途 | 置き場所 |
| :--- | :--- |
| 概要欄の本文・リンク | `next`（`videoId`）の `videoSecondaryInfoRenderer.attributedDescription`（`content`・`commandRuns[].{startIndex,length,onTap.innertubeCommand}`・`styleRuns`） |
| 見出し | `videoPrimaryInfoRenderer` の `viewCount` / `dateText` / `relativeDateText` |
| リンクの種類 | `watchEndpoint`（`videoId` が同じ＋`startTimeSeconds` → この枠をシーク／別の動画 → 別タブ＋➕）・`urlEndpoint`（`youtube.com/redirect?…q=` → 別タブ）・`browseEndpoint`（`UC…` チャンネル／`FEhashtag` ハッシュタグ → 別タブ・`commandMetadata.webCommandMetadata.url`） |
| コメントの入り口 | `next` の `itemSectionRenderer`（`sectionIdentifier` = `comment-item-section`）の continuation |
| コメントの1ページ | `next`（`continuation`）→ `onResponseReceivedEndpoints[].reloadContinuationItemsCommand` / `appendContinuationItemsAction` の `continuationItems`（`commentThreadRenderer`・末尾の `continuationItemRenderer` が次のページ・見出しは `commentsHeaderRenderer`）＋`frameworkUpdates.entityBatchUpdate.mutations[].payload.commentEntityPayload`（`properties.content.{content,commandRuns}`・`properties.publishedTime`・`author.{displayName,avatarThumbnailUrl}`・`toolbar.{likeCountNotliked,replyCount}`） |
| 並べ替え | `sortFilterSubMenuRenderer.subMenuItems[0/1]`（人気順／新しい順）の continuation |
| 返信 | `commentThreadRenderer.replies.commentRepliesRenderer.subThreads[]` の continuation → 同じ形（`replyLevel` 1） |
| 🔴 罠 | 次のページの token は一番上の `continuationItems` の末尾だけを見る（`findAll` すると返信の続きを拾う）。表示用の本文では長い URL が省略されているので、リンク先は `commandRuns` から取る。1回の応答が 300〜750KB → 取得タブで必要な項目だけにして A側へ送る |

## 2. 実測

| 項目 | 値 |
| :--- | :--- |
| `next`（動画） | HTTP 200・1,005ms・517KB |
| 概要欄 | 741字・43行・`commandRuns` 8（チャンネル 1・外部（redirect 経由）7）・`styleRuns` 17・`attachmentRuns` 0・位置 8/8 |
| `player` | HTTP 200・185ms・47KB・`shortDescription` 797字 |
| ログインなしの `next` | HTTP 200・本文 741字 |
| コメント1ページ目 | HTTP 200・265ms・317KB・7件・`commentEntityPayload` 7（本文・投稿者・アイコン・高評価 7/7・返信数 0） |
| 並べ替え | 2項目・token あり・新しい順 HTTP 200・319ms・7件 |
| ログインなしのコメント | HTTP 200・7件 |

## 3. 測れなかった値

- コメントの2ページ目・返信・コメントの中の時刻リンク・固定コメント・投稿者のハート（素材のコメントが少ない）。
- 概要欄の「この動画の時刻」リンク（`watchEndpoint`＋`startTimeSeconds`）と、別の動画・ハッシュタグのリンク（素材に無かった）。
- 取得タブ（アドオン）からの読み込み（条件はコンソールとほぼ同じ）。
- 応答の大きさ: 動画の `next` 517KB・コメント1ページ 317KB → 取得タブで必要な項目に絞って A側へ送る（v2.19.0 の履歴と同じ）。

## 4. 指示書との差異・手戻り

- 素材の条件（コメント100件以上・時刻あり）を満たさない動画で測った → 補足の測定。

## 5. 管理側の誤り

- 用紙の自己診断「check 欄が1つ以上ある」が ❌（この用紙に check 欄を置かなかった）。自己診断の項目に合わせて用紙の欄を作っていなかった。実害なし（照合はすべて ⚪）。次の用紙では check 欄を1つ置く。

## 6. 規約の新設

- なし。

## 7. 次

- ⚪ スパイク完了（2026-11-04）。→ 実装 v2.20.0（マイナー・アドオンを上げる）。
- （経緯）1回目のあと補足の測定を2回行った（2回目 `cy1VIGFMR-4`・3回目 1.1.0 `3rOrpwf4OMo`）。

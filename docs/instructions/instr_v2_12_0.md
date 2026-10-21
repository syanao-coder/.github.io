# v2.12.0 指示書 ─ 音量パネルに枠ごとの音量メーター

発行: 2026-10-21（Claude Code）
基点: `index.html` v2.11.2 / アドオン 2.11.1 / `debug_suite.js` v1.19.1
読む仕様書: `get-dev-workflow` / `get-debug-suite` / `get-protocol-spec`（0-2節・4-2節 埋め込みとのメッセージ）/ `get-ui-spec`（1節）/ 記録 `docs/reports/spike_audio_a1.md`
種別: **マイナー（埋め込みとのメッセージを3種足す）。🔴 アドオンを上げる（2.11.1 → 2.12.0・`v2.12.0.zip`）**

## 1. やること（利用者要望 2026-10-21）

各枠の実際の音量レベルを、音量パネルの中で目で見て比べられるようにする。

決まったこと（利用者と合意）:
- メーターは**音量パネルの中だけ**。
- **最初から付ける**（枠を読み込んで再生が始まったら付け替える）。ただし「見張り」「自動の読み直し」で無音のまま残らないようにする。切るスイッチを置く。
- 🔴 **途中で中断できる逃げ道を残す**（3-4節）。

## 2. 前提（スパイク A1 の結論と実コード）

| # | 確認 | 結果 |
| :-: | :--- | :--- |
| 1 | 測り方 | **`createMediaElementSource`（付け替え）を使う。** Floorp で音が消えず、音量を掛けた後の音（-5.4 dB ≒ -6 dB）を測れた。`mozCaptureStream` は音が戻らず不採用（`spike_audio_a1.md`） |
| 2 | 🔴 付け替えの条件 | `AudioContext` が `running` になってから付け替える。`suspended` のまま付け替えると無音になるおそれ。付け替えは元に戻せない |
| 3 | 埋め込みの content script | `content_yt_embed.js`（v2.9.0）が `www.youtube.com/embed/*` の全フレームで `document_start` に動く。親がこのツールのときだけ動く。親からの `SYNC_EMBED_PING` に答える仕組みがある |
| 4 | A側の受け口 | `window` の `message` で `SYNC_EMBED_OPEN` / `SYNC_EMBED_HELLO` だけを `handleEmbedMessage` に渡す（オリジン `https://www.youtube.com` を確認・`findCardByEmbedSource` で枠を決める） |
| 5 | 枠の読み直し | `loadSingleYT(cardId, silent)` が同じ URL で iframe を作り直す（🔄 `reloadPlayer`）。位置は引き継がない |
| 6 | 改行 | `content_yt_embed.js` は LF、`manifest.json` は CRLF（鉄則 #49） |

## 3. 設計

### 3-1. メッセージ（マイナーの理由）

| 向き | type | 中身 |
| :--- | :--- | :--- |
| A → 埋め込み | `SYNC_EMBED_METER` | `{ attach: true, report: bool }`。`attach` で付け替えを許可、`report` で 0.1秒ごとの報告を3秒間許可（貸し出し。A側が開いている間は1秒ごとに送り直す） |
| 埋め込み → A | `SYNC_EMBED_LEVEL` | `{ db, speechDb, state, latencyMs, volume, loudnessDb, perceptualLoudnessDb, embedHref, version }`。`state` = `running` / `waiting`（再生待ち）/ `suspended` / `error` |
| 埋め込み → A | `SYNC_EMBED_METER_BROKEN` | 付け替えた後に音の処理が止まり、再開できなかった。`{ why, embedHref }` |

### 3-2. アドオン（`content_yt_embed.js`）

- 🔴 **`SYNC_EMBED_METER` の `attach:true` を受けるまで何もしない**（2.11.1 と同じ動き）。
- 付け替え: 動画が**再生中**（`playing` を受けた／`!video.paused`）になってから `new AudioContext()` → `resume()`（最大1秒）。`running` なら `createMediaElementSource(video)` → `destination` と解析（全帯域・声の帯域）へ繋ぐ。`running` にならなければ `close()` して付け替えず、次の `playing` で試し直す。
- 見張り（1秒ごと）: 付け替え後に `state !== 'running'` なら `resume()`。**再生中なのに3秒続けて `running` でない**ときは `SYNC_EMBED_METER_BROKEN` を送る。
- 報告: `report` の貸し出し中だけ 0.1秒ごとに `SYNC_EMBED_LEVEL`。
- 目安の値: YouTube のプレイヤー情報（`movie_player.getPlayerResponse().playerConfig.audioConfig` の `loudnessDb` / `perceptualLoudnessDb`）を読めれば一緒に送る。読めなければ `null`（未確認の値なので、表示は「取れたときだけ」）。

### 3-3. A側

- `METER_FEATURE`（定数）: メーター機能全体の切り替え口。`false` なら A側は `SYNC_EMBED_METER` を一切送らない。
- スイッチ（音量パネル・`sync_meter_on`・既定オン）: オフなら `attach` を送らない。🔴 すでに付け替えた枠は読み直すまでそのまま（パネルに注記）。
- 1秒ごとに全 YouTube 枠へ `SYNC_EMBED_METER { attach, report: パネルが開いているか }` を送る（後から読み込んだ枠も拾える）。
- `SYNC_EMBED_LEVEL` を受けたら枠ごとに保存し、パネルが開いていれば行のメーターを更新する。
  - 行の見出しの下に横バー（-60〜0 dB）と、**3秒平均の数値**（エネルギー平均）。全行で同じ目盛り。
  - 1.5秒届かなければバーを空にして「—」。`state` が `running` 以外なら理由を出す（再生待ち・測れません）。
  - 目安の値が取れたら「全体の目安 -xx」を小さく添える。
- `SYNC_EMBED_METER_BROKEN` を受けたら: その枠の今の位置を控え、**付け替えを止めた状態で**その枠を読み直し（`loadSingleYT`）、`onReady` で控えた位置へ移る（再生中なら再生）。同じ動画のあいだはその枠に `attach` を送らない。

### 3-4. 🔴 逃げ道（利用者指示）

- アドオンは A側の指示なしには付け替えない → A側が送らなければ 2.11.1 と同じ。
- `METER_FEATURE = false` で A側は送らない（中断するときはこれだけで止まる）。
- 作業は段ごとに commit する（①指示書 → ②アドオン → ②A側と判定）。

### 3-5. 版数

`APP_VERSION` 2.12.0・`ADDON_REQUIRED_VERSION` 2.12.0・`manifest.json` 2.12.0・`v2.12.0.zip`（`v2.11.1.zip` 削除）・`APP_HISTORY` 42件・`debug_suite.js` v1.20.0（`D-N3` 42）。

## 4. 判定（`debug_suite.js` v1.20.0）

| ID | 内容 | PC |
| :--- | :--- | :--- |
| `D-A4` | A側だけ。偽の `SYNC_EMBED_LEVEL` を受け口へ流す: 行のバーの幅が dB に比例・3秒平均の数値・1.5秒途絶で「—」・`state` ごとの文言・スイッチの保存。`SYNC_EMBED_METER_BROKEN` で読み直しが呼ばれ、その枠へ `attach` を送らなくなる | 偽の YouTube 枠の行がある |
| `D-W3` | 実機。全 YouTube 枠に貸し出しを送り、🔴 **全枠から `running` の報告**が届き、再生中は -60 dB 超。🔴 1枠を一時停止すると2秒以内にその枠だけ無音になる（計測が音に反応している証拠）→ 再開。遅れ（`latencyMs`）と目安の値を記録 | YouTube の枠が1つ以上・再生中 |

- `VERSION_FOCUS` = `D-V1` → `D-V2` → `D-A1` → `D-A4` → `D-W3`。

## 5. 用紙

`tests/test_v2_12_0.html`。アドオンの入れ直し → すべて実行 → 🎯（2枠・別の動画を再生しながら）→ 目視（メーターの動き・音が途切れないか・9枠での負荷）。v2.11.1 のライブの持ち越し（R5・R6）は引き継ぐ。

## 6. 実装後の確認（headless・Chromium）

| 項目 | 結果 |
| :--- | :--- |
| `D-V1` / `D-V2` / `D-N3`（42件）/ `D-A1` / `D-A3` | 合格 |
| `D-A4` | 合格 15/15（PC 3/3）。負の検証（変更前の `index.html`）: **不合格 0/1**（判定不能ではない） |
| 「▶ すべて実行」23本 | すべて合格 |
| 同名関数の検査（`tests/check_dup_functions.js`・v1.19.1 で追加） | `[]` |
| 検証台 `w12.js`（偽の IFrame API ＋ 偽の埋め込み: 本物の `<video>` で 440Hz を鳴らし、`content_yt_embed.js` を本物のまま読む） | 2枠とも `running`・約 -19 dB・遅れ 42ms・YouTube の目安（偽の `perceptualLoudnessDb` -16.5）も届く。**付け替え後も動画は進む**（0.5秒で 0.50 秒）。`D-W3` 合格 4/4 |
| 〃 BROKEN の場面（付け替え後に `suspend()` し `resume` を効かなくする） | 3秒で `SYNC_EMBED_METER_BROKEN` → A側がその枠を読み直し → 新しい埋め込みには **付け替えない**（`AudioContext` 0個・その枠への `attach` は false）。行の表示は「停止中」 |
| 〃 旧アドオン（content script なし） | `D-W3` **不合格 1/2**（判定不能ではない） |

- 🔴 **実機で未確認**: Floorp の content script（隔離された環境）から `createMediaElementSource` が使えるか（スパイク A1 はページの環境）。`AudioContext` が操作なしで `running` になるか（ならなければ「測れません」が出るだけで音には触らない）。音の遅れの実測（Chromium の検証台では 42ms）。枠を増やしたときの重さ。→ 用紙 R2〜R5。
- 🔴 逃げ道: `index.html` の `METER_FEATURE` を `false` にすると A側は `SYNC_EMBED_METER` を送らず、アドオン 2.12.0 は 2.11.1 と同じ動きになる。

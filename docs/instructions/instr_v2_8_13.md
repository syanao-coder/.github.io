# v2.8.13 指示書 ─ YouTube の再生ページにも送信ボタン（R-10）

発行: 2026-10-03（Claude Code）
基点: `index.html` v2.8.12 / アドオン 2.8.7 / `debug_suite.js` v1.14.3
読む仕様書: `get-dev-workflow` / `get-debug-suite` / `get-protocol-spec`（0-1節・11節 R-10）
種別: **パッチ（メッセージは増やさない）。🔴 アドオンを上げる（2.8.7 → 2.8.13）**

## 1. やること（利用者要望 2026-10-03）

YouTube の通常の再生ページ（`/watch?v=`）に、一覧と同じ「➕ 送信 │ ⧉」を出す。置き場所はチャンネル登録ボタンの右（利用者のスクリーンショットの赤枠）。

## 2. 着手前に実コードで確かめたこと

| # | 確認 | 結果 |
| :-: | :--- | :--- |
| 1 | 送信の経路 | `content_youtube_scrape.js` の `createButtonGroup(card)` → `YOUTUBE_ADD_VIDEO`（url/title/requestId）→ background → A側。結果は `YOUTUBE_ADD_RESULT`。**同じ経路を使えばメッセージは増えない** |
| 2 | URL の取り方 | 一覧はクリック時にカードのリンクから取り直す（`resolveCurrent`）。再生ページは**クリック時に `location` から取る**（SPA で動画が替わってもボタンを作り直さずに済む） |
| 3 | content script の対象 | `https://*.youtube.com/*` の上位フレームだけ（`all_frames` なし）。再生ページも対象に入っている |
| 4 | 監視 | MutationObserver＋`yt-navigate-finish`＋2秒ごとの自己修復。再生ページのボタンも同じ流れで差し込める |

## 3. 設計

- `createButtonGroup(card)` を `createButtonGroup(resolver, opts)` に一般化（一覧は従来どおりカードから、再生ページは `location` から）。
- 差し込み先: `ytd-watch-metadata #owner` の中、`#subscribe-button` の直後。無ければ `#owner` の末尾。
- 見た目: 再生ページのボタンは YouTube の丸いボタンに合わせて大きめ（文字 13px・高さ 36px・角丸 18px）。
- `/watch` 以外へ遷移したら取り除く。二重に差し込まない（実物の有無で判定）。
- 版数: `manifest.json` 2.8.13・`ADDON_REQUIRED_VERSION` '2.8.13'・`APP_VERSION` 2.8.13・`EXPECT_ADDON_REQUIRED` '2.8.13'・`v2.8.13.zip`（`v2.8.7.zip` は削除）。

## 4. 判定

- 🔴 **YouTube 上の content script は debug_suite（A側）からは測れない。** 代わりに **YouTube の再生ページの DOM を模した HTML に content script を読ませ、`browser` を差し替えて** headless で確かめる（scratchpad の検証台。記録に結果を残す）。
  - 差し込み先（チャンネル登録の右）・二重に差し込まない・SPA で URL が替わったら送るURLも替わる・`/watch` 以外で消える・一覧のボタンは従来どおり。
- A側: `D-V1`（版数）・`D-V2`（アドオンの版数を完全一致で照合）が新しい版数で通ること。`D-N3` 35 → 36。
- 実機（利用者）: 本物の再生ページで、ボタンの位置・送信・別の動画へ移った後の送信。

## 5. 用紙

`tests/test_v2_8_13.html`。🔴 アドオンの入れ直しが要る（`about:debugging` で `v2.8.13.zip` または `addon/manifest.json` を一時読み込み）。

## 6. 実装後の確認（headless・検証台）

YouTube の再生ページを模した HTML（`ytd-watch-metadata #owner` に `#subscribe-button`、関連動画のカード1件）を `https://www.youtube.com/watch?v=AAA&pp=xx&list=L1` として配り、`browser.runtime` を差し替えて content script を読ませた。

| 項目 | 結果 |
| :--- | :--- |
| 差し込み先 | チャンネル登録の直後に1組・高さ 36px |
| 二重差し込み | 2.3秒（自己修復1回）後も1組 |
| 送信 | `YOUTUBE_ADD_VIDEO` / url `…/watch?v=AAA&list=L1`（`pp` を落とす）/ title「Video A」。結果 `loaded` で「✓ 枠2へ送信」 |
| SPA 遷移後 | `pushState` で `?v=BBB` へ → 送信は `…?v=BBB` / 「Video B」。組は1つのまま |
| 再生ページ以外 | `/results` へ移ると取り除かれる |
| 一覧のボタン | 関連動画のカードにも従来どおり1組 |
| 負の検証 | 2.8.7 の content script では再生ページのボタンが出ず、クリックが時間切れ |

- `D-V2` は今回 2判定（「アドオン＝APP_VERSION だが要求と違う」の場合が、両者が同じ 2.8.13 なので成り立たない）。
- 古いアドオン（2.8.7）のままだとバッジは橙（`HTML v2.8.13 ⇔ アドオン v2.8.7`）＝入れ直しの合図として正しい。

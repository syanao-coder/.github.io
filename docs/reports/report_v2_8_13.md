# v2.8.13 記録 ─ YouTube の再生ページにも送信ボタン（R-10）

発行: 2026-10-03（Claude Code 自身が参照する記録）
指示書: `docs/instructions/instr_v2_8_13.md`（6節に検証台の結果）

## 1. 結論

| 項目 | 内容 |
| :--- | :--- |
| 合否 | ⚪ **合格。** 「▶ すべて実行」23本すべて合格・判定不能0。目視5件（位置・送信・SPA 遷移後の送信・⧉・一覧のボタン）すべて合格。再測なし |
| プロトコル変更 | なし（`YOUTUBE_ADD_VIDEO` / `YOUTUBE_ADD_RESULT` をそのまま使う） |
| 変更ファイル | `addon/content_youtube_scrape.js`・`addon/manifest.json`（**2.8.13**）・`index.html`（2.8.13・`ADDON_REQUIRED_VERSION` 2.8.13）・`debug_suite.js`（v1.15.0）・`v2.8.13.zip`（`v2.8.7.zip` 削除） |
| 測定環境 | UA `Firefox/157.0` / ビューポート 1460 × 939 |
| バッジ | アドオン入れ直し後に緑 `v2.8.13`（D-V1・D-V2 合格） |

## 2. 検証の方法

- YouTube 上の content script は debug_suite から届かない（`get-debug-suite` 10節）。**再生ページの DOM を模した HTML に content script を読ませ、`browser.runtime` を差し替えた検証台**で headless 確認した（指示書 6節）。負の検証として 2.8.7 の content script ではボタンが出ないことを確かめた。
- 実機は目視5件のみ。自動判定は A側の回帰と版数照合。

## 3. 測れなかった値

| # | 値 | 理由 |
| :-: | :--- | :--- |
| 1 | 未ログイン・チャンネル登録ボタンが無いページ（埋め込み不可の動画・限定公開など）での位置 | 未測定。`#subscribe-button` が無ければ `#owner` の末尾に置く作り |
| 2 | ショート（`/shorts/`）・ライブ（`/live/`）のページ | 対象外（`/watch?v=` だけ）。要望が出たら別の版 |

## 4. 規約の新設

なし。

## 5. 次

v2.9.0（R-11 その他の動画を枠内で開く・マイナー・アドオンを上げる）→ v2.10.0（ライブ取得の自動復帰）→ v2.11.0（上位のチャット切替）。

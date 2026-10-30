# v2.19.1 指示書 ─ ▶ YouTube の履歴のタイルの幅をそろえる

発行: 2026-10-30（Claude Code）
基点: `index.html` v2.19.0 / アドオン 2.17.0 / `debug_suite.js` v1.30.0
読む仕様書: `get-dev-workflow`（鉄則 #53）/ `get-debug-suite` / 記録 `report_v2_19_0.md`
種別: **パッチ（A側のみ・プロトコル変更なし）。アドオンは 2.17.0 のまま**

## 1. やること

v2.19.0 の実機 R4e「履歴のサムネイルや各枠のサイズがバラバラ」。チャンネル名の行（`white-space:nowrap`）が長いタイルだけ、flex の項目が中身の幅（min-content）まで広がる。

- タイル（`.history-tile.yt`）に `width:100px; min-width:0; box-sizing:border-box; overflow:hidden`。
- 版数: `APP_VERSION` 2.19.1・`APP_HISTORY` 58件・`debug_suite.js` v1.30.1（`D-N3` 58）。

## 2. 判定

- `D-F1` に「🔴 タイルの幅がそろう」と PC「長いチャンネル名の行は1枚の幅より長い（広がる土俵がある）」を足す（偽のデータの5件目に長いチャンネル名）。
- `VERSION_FOCUS` = `D-V1` → `D-V2` → `D-F1`。

## 3. headless の確認

| 項目 | 結果 |
| :--- | :--- |
| `D-F1` | 20/20（PC 3/3）・幅はすべて 100px |
| 旧版（v2.19.0） | 「幅がそろう」が不合格（110〜334px） |
| 回帰 `▶ すべて実行` | 23本合格 |

## 4. 用紙

`tests/test_v2_19_1.html`: T1 開く → R1 すべて実行 → R2 🎯 → R3 目視（▶ YouTube のタイルがそろう）。

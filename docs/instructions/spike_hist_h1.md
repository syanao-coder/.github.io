# スパイク H1 指示書 ─ YouTube の視聴履歴を読めるか

発行: 2026-10-26（Claude Code）
基点: `index.html` v2.17.0 / アドオン 2.15.0（**本番コードへの変更なし**）
読む仕様書: `get-dev-workflow`（1-4節・3-1-2節「スパイクに限り計測スニペット」・鉄則 #54）/ `get-chat-feature-spec`（1-3-2節 認証ヘッダ）/ `get-protocol-spec`（11節「スパイク（2026-10-26 合意）」）/ `get-debug-suite`（9節 用紙 3.0.1）
種別: **版数を切らないスパイク。** 成果物は `tests/spike_hist_h1.js`（YouTube のページのコンソールに貼る計測コード `hist-h1-1.0.0`）と `tests/test_spike_hist_h1.html`（用紙）。撤退はファイルの削除だけ。

## 1. きっかけ

利用者の質問（2026-10-26）「ログインをした場合、コントローラの各枠に出る最近使った動画の履歴を youtube 側の履歴にすることは可能？」→「youtube 側の履歴と現在のコントローラ側の履歴は共存できるとよい（2列でどちらも表示 or 切り替えて表示）」。
🔴 結果によって、続きが「アドオンを変える版（マイナー）」か「撤退」かが決まる → スパイク（1-4節）。

## 2. 前提（実コードと仕組みで確かめたこと）

| # | 確認 | 結果 |
| :-: | :--- | :--- |
| 1 | 枠の「🕒 最近使った動画」 | `index.html` の `saveVideoToHistory` / `generateHistoryGalleryHTML`。`localStorage` の `sync_video_history`（最大30件・ローカル動画も入る・押すと読み込む / ローカルはファイル選択を開く） |
| 2 | 正式な API | YouTube Data API v3 には視聴履歴を返す口が無い（2016 年ごろ閉じた。履歴の再生リスト `HL` は空を返す） |
| 3 | 取れる見込みの口 | YouTube の画面が使う InnerTube `POST /youtubei/v1/browse`・`browseId: 'FEhistory'`（ログイン必須）。続きは `continuationItemRenderer…continuationCommand.token` で `continuation` を送る。予備は `/feed/history` の HTML の `ytInitialData` |
| 4 | 認証 | 取得エンジンと同じ `SAPISIDHASH`・`X-Origin`・`X-Goog-AuthUser` ＋ `credentials:'include'`（1-3-2節）。本番では取得タブ（MAIN world・youtube.com）から読む想定で、コンソールの条件と近い |
| 5 | 項目の部品（公開情報からの見込み・未実測） | 旧 `videoRenderer`、新 `lockupViewModel`（`contentId`・`metadata.lockupMetadataViewModel.title.content`）、ショートは `shortsLockupViewModel` / `reelItemRenderer`。日付の区切りは `itemSectionRenderer` の見出し |
| 6 | 埋め込みの視聴が履歴に載るか | 不明。枠の中の YouTube（埋め込み）は Firefox の Cookie の分離でログインしていない扱いになりうる → 載らない可能性が高い（実測する） |
| 7 | 🔴 個人の情報 | 履歴は個人の情報。リポジトリは公開なので、**出力にタイトル・動画 ID・チャンネル名を載せない**（件数・形・利用者が入れた2本の位置だけ） |

## 3. 計測コード（`hist-h1-1.0.0`）

`https://www.youtube.com/` のどのページでもよい（コンソールの実行先は「Top」のまま）。画面の右上にパネルを出す。どれも**読むだけ**。

| ID | 中身 |
| :--- | :--- |
| `D-Q1` | PC: ページ・キーと文脈・ログイン（認証の Cookie）。`browse`（`FEhistory`）の HTTP・時間・大きさ・一番上の名前／項目の部品と数／取れる情報の件数（ID・タイトル・サムネ・チャンネル・長さ・再生位置の印）／日付の区切りの数と見出し（「今日」など）／続きの有無 → 2ページ目も読む／予備の `/feed/history` の HTML と先頭5件が同じか／合計と重複。判定: HTTP 200・項目1件以上・全項目から ID・続きが読めた。ログインしていない回は形だけ記録（判定不能） |
| `D-Q2` | 入れた2本（① このツールの枠で見た動画 ② YouTube のサイトで見た動画）が、`D-Q1` で読んだ1〜2ページ目の何番目にあるか。🔴 **②が見つかることを PC**（履歴が反映されている土俵）にし、①の位置を観測に出す |

## 4. 結果の読み方（次の一手）

| 結果 | 次の一手 |
| :--- | :--- |
| `D-Q1` 合格・項目から ID とタイトルとサムネが取れる | **作れる。** 枠の「最近使った動画」と YouTube の履歴を共存させる版（アドオン: 取得タブで `FEhistory` を読む口・A側: 2列 or 切り替え）。2列か切り替えかは、1ページの件数と枠の大きさで利用者と決める |
| ①（枠の中で見た動画）が履歴に無い | 「このツールで見た動画は YouTube の履歴に入らない」ことを画面に書く（YouTube の履歴＝YouTube のサイトで見たもの）。共存の価値は変わらない |
| HTTP 401 / 403 / 項目が0 | 認証の組み立て（`SESSION_INDEX`・`X-Goog-PageId`）を見直してもう一度。直らなければ撤退 |
| 項目はあるが ID が取れない | 部品の形が見込みと違う。`D-Q1` の部品名を手がかりに計測コードを直して再測 |

## 5. headless の確認（Chromium・偽の YouTube）

`https://www.youtube.com/**` を Playwright の `route` で差し替えた検証台（`browse` は `FEhistory` で1ページ目〔`lockupViewModel` 4件・`videoRenderer` 1件・再生リスト1件・日付の区切り2つ・続きの番号〕、`continuation` で2ページ目〔`lockupViewModel` 2件・`shortsLockupViewModel` 1件・1ページ目と同じ動画1件〕、ログインしていなければログインを促す部品だけ）。

| 項目 | 結果 |
| :--- | :--- |
| YouTube 以外で貼る | 何もしない |
| `D-Q1`（ログイン済み） | 合格 4/4（PC 3/3）。5件（再生リストは数えず部品名に出す）・取れる情報 5/5・区切り「今日・昨日」・2ページ目3件・予備の HTML と先頭5件が同じ・合計8件／重複1件。要求は `browseId: FEhistory`・`context`・`key`・`SAPISIDHASH`・`X-Origin`・`X-Goog-AuthUser: 0`、2ページ目は `continuation` |
| `D-Q2` | ①（2ページ目の動画）6番目・②2番目 → 合格。①が無い → 「1〜2ページ目に無い」。②が無い → 判定不能（土俵が無い） |
| ログインしていない | PC「ログイン済み」が不成立で判定不能・ログインを促す部品が「ある」 |
| 🔴 出力の漏れ | 偽のタイトル・チャンネル名・入れていない ID・Cookie の値は出力に無い |

## 6. 測れなかった値・未確認（実施前）

- 🔴 本物の `FEhistory` の応答の形（この環境からは YouTube に繋がらない）。
- 埋め込みでの視聴が履歴に載るか・載るまでの時間。
- 1ページの件数（本番の表示に何件出せるか）。
- 「履歴を一時停止」している場合の応答。

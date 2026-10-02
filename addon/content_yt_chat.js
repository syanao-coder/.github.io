/* =====================================================================
   content_yt_chat.js  ―  v2.6.0 新規 / ISOLATED world（通常の content script）

   取得タブに動的注入され、MAIN world の chat_fetcher_main.js と
   バックグラウンドの間を双方向に中継するだけのファイル。

   ■ なぜ必要か
   MAIN world には browser.* / chrome.* が無く、外へ出す手段が
   window.postMessage しかない。逆にここからは fetch してはいけない
   （Origin が moz-extension:// になり HTTP 403）。
   このファイルは「郵便受け」に徹し、取得処理は一切持たない。

   ■ 注入方法
   background.js が scripting.executeScript（world 省略＝ISOLATED）で
   動的注入する。manifest の content_scripts には書かない
   （取得タブ以外の YouTube タブに常駐させる必要がないため）。
   多重注入されても実害が出ないようフラグで冪等にしてある。
   ===================================================================== */
(function () {
  'use strict';

  if (window.__syncChatRelay) return;
  window.__syncChatRelay = true;

  const TAG = '__syncChat';       // MAIN → ここ
  const CMD = '__syncChatCmd';    // ここ → MAIN

  console.log('【アドオン】content_yt_chat.js（チャット中継）を開始しました。');

  /* ---- MAIN world → バックグラウンド ---- */
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;              // 必須
    const d = e.data;
    if (!d || d[TAG] !== 1) return;

    /* ★v2.6.5: 落とすものを1箇所に集約する。
       中継は「郵便受け」に見えて選別を持っている。v2.6.4 で ready がここに
       書かれていたために background へ何も届かず、原因の特定に1ラウンドかかった。

       現在エンジンが post する ev: config / ready / meta / chunk / done / ping / idle
         config … 取得タブ内で完結する情報。中継しない
         ready  … background.js が版数照合に使い、そこで消費する
         idle   … background.js が取得タブの後始末に使い、そこで消費する
         meta / chunk / done / ping … A 側まで通す */
    const DROP_EV = ['config'];
    if (DROP_EV.indexOf(d.ev) >= 0) return;

    chrome.runtime.sendMessage({ type: 'CHAT_STREAM_EVENT', payload: d }).catch(function () {});
  });

  /* ---- バックグラウンド → MAIN world ---- */
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || !message.type) return;

    const PASS_CMD = ['CHAT_ENQUEUE', 'CHAT_CANCEL', 'CHAT_CONFIG'];
    if (PASS_CMD.indexOf(message.type) < 0) {
      /* ★v2.6.5: チャット関連の命令だけ警告する。
         他機能の runtime message もここへ流れてくるので、
         接頭辞で絞らないと無関係な警告で埋まる。 */
      if (String(message.type).indexOf('CHAT_') === 0) {
        console.warn('【アドオン】未知のチャット命令を破棄しました。type=' + message.type
          + '  content_yt_chat.js の PASS_CMD に追加が必要かもしれません。');
      }
      return;
    }

    window.postMessage({
      [CMD]: 1,
      cmd: message.type,
      requestId: message.requestId,
      videoId: message.videoId,
      config: message.config
    }, location.origin);
  });
})();

if (document.getElementById('playersGrid')) {
  console.log("【アドオン】content_controller.js が正常に読み込まれました。");

  /* バージョン整合チェック用の自己申告（v2.4.2で新設）
     A側とB側でバージョンがずれていると原因不明の不具合に見えるため、
     アドオン側の版数をHTMLへ伝えて画面上で照合できるようにする。 */
  try {
    const addonVersion = chrome.runtime.getManifest().version;
    console.log("【アドオン】バージョン:", addonVersion);
    const announce = () => window.postMessage({
      type: 'EXTERNAL_SYNC_EVENT', state: 'addonInfo', version: addonVersion
    }, '*');
    announce();
    // HTML側のリスナー登録が後になる場合に備えて数回送る
    setTimeout(announce, 300);
    setTimeout(announce, 1500);
  } catch (e) { /* 版数が取れなくても本体機能には影響しない */ }

  /* ★v2.7.0: YouTube の実行許可の有無を問い合わせる。
     Firefox の MV3 は host_permissions がオプトインで、アドオンの再読み込みや
     更新のあとに YouTube の許可が外れることがある。許可が外れていても
     版数バッジが緑のままだと、チャットが取れない理由が画面から読めない。

     addonInfo と同じ 0 / 300 / 1500ms の3回送信に乗せる。
     A側のリスナー登録が間に合わない問題は権限側にも等しく起きるため。 */
  function askYtPermission() {
    try {
      chrome.runtime.sendMessage({ type: 'QUERY_YT_PERMISSION' }).catch(function () {});
    } catch (e) { /* 問い合わせに失敗してもバッジが緑のままになるだけ */ }
  }
  [0, 300, 1500].forEach(function (ms) { setTimeout(askYtPermission, ms); });

  /* 別タブで許可を与えて戻ってきたときに、再読み込みなしで反映させる。
     新しいメッセージを増やさずに再問い合わせを実現するための仕掛け。 */
  window.addEventListener('focus', askYtPermission);

  // スレッドA（コントローラー）からアドオン方向の中継
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data && event.data.type === 'SYNC_CMD') {
      const { action, value } = event.data;

      chrome.runtime.sendMessage({
        type: "SYNC_COMMAND",
        action: action,
        value: value
      });
    }

    /* ⛔ v2.6.2 で撤去（復活させないこと）
         CHAT_CONTINUATION_REQUEST … iframe方式の名残
         CHAT_ARCHIVE_REQUEST      … C側ヘルパー（yt-dlp）経路 */

    // コントローラー ➔ アドオン（InnerTube 直接取得の開始）★v2.6.0
    if (event.data && event.data.type === 'CHAT_STREAM_REQUEST') {
      chrome.runtime.sendMessage({
        type: "FETCH_CHAT_STREAM",
        videoId: event.data.videoId,
        requestId: event.data.requestId,
        mode: event.data.mode   /* ★v2.10.0: 'top'（上位のチャット）/ それ以外は全件 */
      }).catch(() => {});
    }

    // コントローラー ➔ アドオン（取得用タブの扱い方）★v2.6.1
    if (event.data && event.data.type === 'CHAT_TAB_POLICY') {
      chrome.runtime.sendMessage({
        type: "SET_CHAT_TAB_POLICY",
        policy: event.data.policy
      }).catch(() => {});
    }

    // コントローラー ➔ アドオン（取得の中止）★v2.6.0
    if (event.data && event.data.type === 'CHAT_STREAM_CANCEL') {
      chrome.runtime.sendMessage({
        type: "CANCEL_CHAT_STREAM",
        requestId: event.data.requestId
      }).catch(() => {});
    }

    // コントローラー ➔ YouTubeタブ（➕送信ボタンの処理結果）
    if (event.data && event.data.type === 'CONTROLLER_TO_YOUTUBE') {
      if (event.data.event === 'addVideoResult') {
        chrome.runtime.sendMessage({
          type: "YOUTUBE_ADD_RESULT",
          requestId: event.data.requestId,
          status: event.data.status,
          slotIndex: event.data.slotIndex
        }).catch(() => {});
      }
    }
  });

  // アドオン方向からコントローラーHTML方向への中継（全レシーバー）
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 1. 通常のビデオ時間/サイト名報告の中継
    if (message.type === "EXTERNAL_STATE_UPDATE") {
      window.postMessage({
        type: 'EXTERNAL_SYNC_EVENT',
        state: message.state,
        time: message.time,
        siteName: message.siteName
      }, '*');
    }

    /* ⛔ v2.6.2 で撤去（復活させないこと）
         EXTERNAL_CHAT_CONTINUATION → state:'chatContinuation'
         EXTERNAL_CHAT_ARCHIVE      → state:'chatArchive' */

    // 1-b. InnerTube ストリーミング取得の中継 ★v2.6.0
    // ⚠️ ev ごとに使うフィールドは違うが、まとめて全部転送する。
    //    「この ev では使わないから」と間引くと、中間ファイルで削られて
    //    A側に届かない既知の不具合パターンに嵌る（relativeSeekReport の diff 欠落と同じ構造）。
    if (message.type === "EXTERNAL_CHAT_STREAM") {
      const CHAT_STREAM_STATE = {
        meta: 'chatMeta', chunk: 'chatChunk', done: 'chatDone', ping: 'chatPing'
      };
      const state = CHAT_STREAM_STATE[message.ev];
      if (state) {
        window.postMessage({
          type: 'EXTERNAL_SYNC_EVENT',
          state: state,
          requestId: message.requestId,
          videoId: message.videoId,
          ok: message.ok,
          error: message.error,
          videoMs: message.videoMs,
          seq: message.seq,
          comments: message.comments,
          emoji: message.emoji,
          lastT: message.lastT,
          total: message.total,
          complete: message.complete,
          truncated: message.truncated,
          /* ★v2.8.0: 配信中という第3の状態。background.js と対で明示転送する。 */
          live: message.live,
          liveBy: message.liveBy,
          /* ★v2.10.0: B側が実際に選んだ表示（'top' / 'all' / 'unknown'）。background.js と対で明示転送する。 */
          view: message.view,
          livePolls: message.livePolls,
          reqs: message.reqs,
          elapsed: message.elapsed,
          active: message.active,
          waiting: message.waiting
        }, '*');
      } else {
        /* ★v2.6.5: 未知の ev は黙って捨てず、必ず痕跡を残す。
           v2.6.4 で ready が content_yt_chat.js に捨てられていた事故と同じ構造。
           idle / ready は background.js が消費するのでここには来ない。
           ここに出るということは CHAT_STREAM_STATE への追加漏れである。 */
        console.warn('【アドオン】未知のチャットイベントを破棄しました。ev=' + message.ev
          + '  content_controller.js の CHAT_STREAM_STATE に追加が必要かもしれません。');
      }
    }

    /* 1-c. YouTube の実行許可の有無の中継 ★v2.7.0
       🔴 granted を明示的に転送する。フィールドを落とすと
          relativeSeekReport の diff が中間ファイルで削られている既知バグと
          同じ構造にはまる。 */
    if (message.type === 'EXTERNAL_YT_PERMISSION') {
      window.postMessage({
        type: 'EXTERNAL_SYNC_EVENT',
        state: 'ytPermission',
        granted: !!message.granted
      }, '*');
      return;
    }

    // 2. 単一動画追加（➕ボタン）の中継
    if (message.type === "EXTERNAL_ADD_VIDEO") {
      window.postMessage({
        type: 'EXTERNAL_SYNC_EVENT',
        state: 'addYoutubeVideo',
        url: message.url,
        title: message.title,
        requestId: message.requestId // 結果通知で返すためそのまま引き継ぐ
      }, '*');
    }
  });
}
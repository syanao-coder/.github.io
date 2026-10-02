console.log("【アドオン】動画サイト用 content_video.js が読み込まれました。");

/* ------------------------------------------------------------
   拡張機能APIの名前空間シム（Firefoxフォーク互換対策）

   ・Firefox系の正式な作法は browser.*（Promiseを返す）
   ・Chrome系は chrome.*（コールバック方式、戻り値なし）
   ・Firefoxは互換のため chrome.* も提供しているが、
     Floorp等のフォークは独自のChrome拡張互換レイヤーを持つため、
     chrome.* の戻り値がPromiseでない場合がある。
     その環境で .catch() を呼ぶと TypeError でスクリプトが即死する。

   browser.* を優先し、送信は戻り値の型を見てから .catch() する。
   ------------------------------------------------------------ */
const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

function sendRuntimeMessage(message) {
  try {
    const result = ext.runtime.sendMessage(message);
    if (result && typeof result.then === 'function') result.catch(() => {});
  } catch (e) { /* 受信側が居ない等。無視してよい */ }
}

// ページ内のすべてのvideo要素から「本当に動作している本編」を自動特定する関数
function getActiveVideo() {
  const videos = Array.from(document.querySelectorAll('video'));
  if (videos.length === 0) return null;
  if (videos.length === 1) return videos[0];

  const activeVideo = videos.find(v => {
    const rect = v.getBoundingClientRect();
    const isVisible = rect.width > 100 && rect.height > 100;
    const hasMedia = v.src || v.querySelector('source') || v.currentSrc;
    return isVisible && hasMedia;
  });

  if (activeVideo) return activeVideo;

  const sortedByWidth = videos.sort((a, b) => b.offsetWidth - a.offsetWidth);
  if (sortedByWidth[0] && sortedByWidth[0].offsetWidth > 100) {
    return sortedByWidth[0];
  }

  return videos[0];
}

// Backgroundからの同期コマンド処理
ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, value } = message;
  console.log("【アドオン】動画側で受信したコマンド:", action, value);

  const video = getActiveVideo();
  if (!video) {
    console.warn("【アドオン】操作対象の本編ビデオ要素が見つかりません。");
    return;
  }

  try {
    switch (action) {
      case "play":
        video.play();
        break;
      case "pause":
        video.pause();
        break;
      case "seek":
        if (typeof value === "number") {
          video.currentTime += value; // 【修正】手動イベント発火を完全排除
        }
        break;
      case "seekTo":
        if (typeof value === "number") {
          const wasPaused = video.paused;
          video.currentTime = value; // 【修正】手動イベント発火を完全排除

          setTimeout(() => {
            if (wasPaused) {
              if (!video.paused) video.pause();
            } else {
              if (video.paused) video.play().catch(() => {});
            }
          }, 50);
        }
        break;
      case "speed":
        if (typeof value === "number") {
          video.playbackRate = value;
          video.dispatchEvent(new Event('ratechange'));
        }
        break;
      case "requestTime":
        // 現在アクセスしているドメインから、分かりやすいサイト名を抽出
        let friendlyName = "外部動画";
        const host = window.location.hostname;
        if (host.includes("animestore.docomo")) friendlyName = "dアニメストア";
        else if (host.includes("netflix")) friendlyName = "Netflix";
        else if (host.includes("amazon")) friendlyName = "Amazonプライム";
        else if (host.includes("youtube")) friendlyName = "YouTube";

        // 時間報告（timeReport）に siteName プロパティを追加して送信
        sendRuntimeMessage({
          type: "VIDEO_STATE_CHANGE",
          state: "timeReport",
          time: video.currentTime,
          siteName: friendlyName
        });
        break;
    }
  } catch (error) {
    console.error("【アドオン】動画操作エラー:", error);
  }
});
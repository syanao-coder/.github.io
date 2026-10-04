console.log("【アドオン】background.js が起動しました。");

// --- コントローラー ➔ 動画配信サイトへの命令転送 ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SYNC_COMMAND") {
    const { action, value } = message;
    chrome.tabs.query({
      url: [
        "*://animestore.docomo.ne.jp/*",
        "*://*.amazon.co.jp/*"
      ]
    }, (tabs) => {
      if (chrome.runtime.lastError) return;
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { action, value }).catch(() => {});
      }
    });
  }

  // --- 動画配信サイト ➔ コントローラーへの再生時間報告（逆転送・siteName対応） ---
  if (message.type === "VIDEO_STATE_CHANGE") {
    const { state, time, siteName } = message;
    chrome.tabs.query({
      url: [
        "file:///*",
        "http://localhost/*",
        "http://127.0.0.1/*",
        "https://syanao-coder.github.io/*"
      ]
    }, (tabs) => {
      if (chrome.runtime.lastError) return;
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          type: "EXTERNAL_STATE_UPDATE",
          state: state, // 'timeReport'
          time: time,
          siteName: siteName
        }).catch(() => {});
      }
    });
  }

  // --- 単一YouTube動画追加 ➔ コントローラーへの逆転送 ---
  if (message.type === "YOUTUBE_ADD_VIDEO") {
    chrome.tabs.query({
      url: [
        "file:///*",
        "http://localhost/*",
        "http://127.0.0.1/*",
        "https://syanao-coder.github.io/*"
      ]
    }, (tabs) => {
      if (chrome.runtime.lastError) return;
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          type: "EXTERNAL_ADD_VIDEO",
          url: message.url,
          title: message.title,
          requestId: message.requestId // ★どのボタンからの要求かを識別するID
        }).catch(() => {});
      }
    });
  }

  /* ⛔ v2.6.2 で撤去した受信ハンドラ（復活させないこと）
       FETCH_CHAT_CONTINUATION … iframe方式の名残。v2.5.0 で不成立が確定していた
       FETCH_CHAT_ARCHIVE      … C側ヘルパー（yt-dlp / Native Messaging）経路
     チャット取得は InnerTube 直接取得（FETCH_CHAT_STREAM）に一本化した。 */

  // --- コントローラー ➔ InnerTube 直接取得の開始 ★v2.6.0 ---
  if (message.type === "FETCH_CHAT_STREAM") {
    startChatStream(message.videoId, message.requestId, message.mode).catch((err) => {
      sendChatStreamEvent({
        ev: "done",
        requestId: message.requestId,
        videoId: message.videoId,
        ok: false,
        error: String(err && err.message ? err.message : err)
      });
    });
  }

  // --- コントローラー ➔ 取得の中止 ★v2.6.0 ---
  if (message.type === "CANCEL_CHAT_STREAM") {
    cancelChatStream(message.requestId);
  }

  // --- 取得タブ ➔ コントローラーへの中継（無状態）★v2.6.0 ---
  /* ★v2.6.5: ここで消費して A 側へ流さない ev は idle と ready の2つだけ。
     増やすときは content_controller.js の CHAT_STREAM_STATE との対応も確認すること。 */
  if (message.type === "CHAT_STREAM_EVENT") {
    const p = message.payload;
    if (p && p.ev === "idle") {
      closeChatTab();          // ★取得タブの後始末。A側へは流さない
    } else if (p && p.ev === "ready") {
      /* ★v2.6.4: 取得エンジンの世代照合。A側へは流さない（プロトコル無変更）。
         隠して保持した取得タブでは window.__syncChatEngine による冪等化のため
         新しいファイルを注入しても差し替わらない。ここで食い違いを表に出す。 */
      const mine = chrome.runtime.getManifest().version;
      if (p.version !== mine) {
        console.warn("【アドオン】⚠️ 取得エンジンが古いままです。エンジン=" + p.version
          + " / アドオン=" + mine
          + "  取得タブを閉じて作り直してください。");
      } else {
        console.log("【アドオン】取得エンジン版数: " + p.version + "（アドオンと一致）");
      }
    } else {
      sendChatStreamEvent(p);
    }
  }

  // --- コントローラー ➔ 取得タブの扱い方の設定 ★v2.6.1 ---
  if (message.type === "SET_CHAT_TAB_POLICY") {
    setChatTabPolicy(message.policy);
  }

  /* --- コントローラー ➔ YouTube の実行許可の有無を問い合わせる ★v2.7.0 ---
     content_controller.js が起動時とタブのフォーカス時に問い合わせてくる。
     A側（controller.html）からの問い合わせ経路は作らない。
     A→B のメッセージを増やさずに済み、既存の SYNC_CMD と混ざらない。

     ⚠️ sendResponse は使わない。このリスナーは全分岐が同期応答（return true なし）で
        統一されているため、ここだけ非同期応答を持ち込むとリスナー全体の
        戻り値の扱いを変えることになる。sender.tab.id へ押し返す。

     ⚠️ 判定結果はバッジの表示専用である。これを理由に取得を止めてはいけない。
        permissions.contains のパターン取り違えで正常な環境を弾いた実績がある。
        注入の成否だけが権威。 */
  if (message.type === "QUERY_YT_PERMISSION") {
    if (sender && sender.tab && sender.tab.id != null) {
      const tabId = sender.tab.id;
      hasYouTubePermission().then(function (granted) {
        chrome.tabs.sendMessage(tabId, {
          type: "EXTERNAL_YT_PERMISSION", granted: !!granted
        }).catch(function () {});
      }).catch(function () {});
    }
    return;
  }

  // --- コントローラー ➔ YouTubeタブへの処理結果通知 ---
  // 既存の SYNC_COMMAND は配信サイトのタブ宛にしかルーティングされないため、
  // YouTubeタブ宛の経路をここに新設する。
  if (message.type === "YOUTUBE_ADD_RESULT") {
    chrome.tabs.query({
      url: ["https://*.youtube.com/*"]
    }, (tabs) => {
      if (chrome.runtime.lastError) return;
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          type: "YOUTUBE_ADD_RESULT",
          requestId: message.requestId,
          status: message.status,     // 'loaded' | 'duplicate' | 'slotFull' | 'invalid'
          slotIndex: message.slotIndex // 1始まりの枠番号（loaded / duplicate 時）
        }).catch(() => {});
      }
    });
  }
});

/* ============================================================
   コントローラータブの宛先

   返りの宛先はタブIDを覚えず、毎回 tabs.query で引き直す。
   MV3 のバックグラウンドは30秒アイドルで終了するため、
   ここに状態を溜め込むと必ず失う。
   ============================================================ */

const CONTROLLER_TAB_URLS = [
  "file:///*",
  "http://localhost/*",
  "http://127.0.0.1/*",
  "https://syanao-coder.github.io/*"
];

/* ⛔ v2.6.2 で撤去したコード（復活させないこと）

   ■ iframe方式の名残（v2.4.2 / 不成立が v2.5.0 で確定）
     replyChatInfo / fetchChatInfo / sliceBalancedJson / extractVideoDetails /
     extractChatContinuation / digChatContinuation / pickContinuation /
     deepFindLiveChatContinuation
     … iframe は中身をJSから読めないため、コメント流しには原理的に到達できない。

   ■ C側ヘルパー経路（v2.5.0 / Native Messaging + yt-dlp）
     NATIVE_HOST / CHUNK_GUARD / sendNative / fetchArchiveChat / replyChatArchive
     … 1メッセージ1MB上限のための分割受信・結合も併せて不要になった。
     manifest から nativeMessaging 権限も外している。

   撤去の代償: YouTube の仕様変更に yt-dlp が追従してくれなくなった。
   壊れたときは chat_fetcher_main.js を自分で直すこと。
   詳細は /get-chat-feature-spec 7-4節。 */

/* ============================================================
   アーカイブチャットの取得（★v2.6.0 / InnerTube 直接取得）

   ■ ここは「無状態の中継」に徹する
   MV3 のバックグラウンドは30秒アイドルで終了する。
   9本の取得は数分かかるため、進捗や結果をここに溜め込むと必ず失う。
     ・長時間の処理  … 取得タブの MAIN world（chat_fetcher_main.js）
     ・唯一の状態    … 取得タブの tabId（storage.local）
     ・返りの宛先    … tabs.query で毎回引き直す（タブIDを覚えない）
   これにより、途中でバックグラウンドが終了しても
   次のメッセージで起き直せば復帰できる。

   ⚠️ about:debugging の「調査」を開いている間はバックグラウンドが
      アイドル終了しない。終了まわりの不具合は調査ツールを閉じないと再現しない。
   ============================================================ */

/* 🔴 取得タブの ID は storage.local に置く。
   storage.session は**アドオンを再読み込みすると消える**ため、
   前に作ったタブを見つけられず作り直し、ピン留めタブが際限なく溜まる。
   （実測: 目印つきURLを試したが YouTube 側で失われるため当てにならなかった）
   ブラウザを再起動するとタブIDは振り直されるので、onStartup で捨てる。 */
const CHAT_TAB_KEY = "chatTabId";
/* ★v2.8.3: 自分で作ったタブのID。
   🔴 「隠せなかった取得タブ」を再利用するために要る。
      v2.8.2 まで、隠すのにもピン留めにも失敗すると
      isUsableChatTab() が自分で作ったタブまで拒否し、
      要求のたびに1枚ずつ YouTube のタブが増え続けていた
      （古いタブは誰も閉じないため上限が無い）。
   ⚠️ ブラウザを再起動するとタブIDは振り直されるので、
      onStartup / onInstalled / onRemoved で必ず捨てること。 */
const CHAT_TAB_OWN_KEY = "chatTabOwnId";
const YT_WORKER_MARK = "syncviewer=chat";
const YT_WORKER_URL = "https://www.youtube.com/?" + YT_WORKER_MARK;
const YT_TAB_READY_TIMEOUT_MS = 15000;

/* 🔴 permissions.contains に渡すパターンは manifest の宣言と完全に一致させること。
   manifest が "https://*.youtube.com/*" なのに "*://*.youtube.com/*" を問い合わせると、
   スキームの '*' が http も要求するため false が返る。
   ユーザーは全権限を許可しているのに「許可がありません」と言われる、という
   最悪の形で嵌る（v2.6.0 開発中に実際に踏んだ）。
   手で書き写さず、manifest から引いて取り違えを構造的に不可能にする。 */
function ytOriginPatterns() {
  try {
    const hp = chrome.runtime.getManifest().host_permissions || [];
    const hits = hp.filter((x) => typeof x === "string" && x.indexOf("youtube.com") >= 0);
    if (hits.length) return hits;
  } catch (e) {}
  return ["https://*.youtube.com/*"];
}

async function hasYouTubePermission() {
  try {
    if (chrome.permissions && chrome.permissions.contains) {
      return await chrome.permissions.contains({ origins: ytOriginPatterns() });
    }
  } catch (e) { /* 判定できない環境では通常経路へ進ませる */ }
  return true;
}

/* 取得タブが読み終わるのを待つ。
   ⚠️ ここで待っている間にバックグラウンドが終了する可能性がある。
      その場合はA側の watchdog が拾い、再試行時には
      「既に complete のタブ」が見つかって自己修復する。 */
function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (e) {}
      resolve();
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId)
      .then((t) => { if (t && t.status === "complete") finish(); })
      .catch(() => finish());
    setTimeout(finish, YT_TAB_READY_TIMEOUT_MS);
  });
}

/* 専用の取得タブを1枚だけ確保して使い回す。
   ・ユーザーが開いている YouTube タブは使わない
     （SPA遷移やタブを閉じられると取得ループごと消えるため）
   ・pinned にして存在を分かるようにしつつ場所を取らせない
   ・9本すべてを1枚で処理できる（watchタブは不要） */
/* 🔴 同時に複数の要求が来ても、タブを作るのは1回だけにする。
   9枠を一括で開くと startChatStream が9本ほぼ同時に走る。
   直列化しないと9本すべてが「タブが無い」と判断し、
   ピン留めタブを9枚作ってしまう。
   バックグラウンドが終了してこの鎖が失われても、
   そのときは storage.local か目印から見つかるので問題ない。 */
let chatTabChain = Promise.resolve(null);

function ensureChatTab() {
  const run = () => ensureChatTabInner();
  const next = chatTabChain.then(run, run);
  chatTabChain = next.then(() => {}, () => {});   // 失敗しても後続を止めない
  return next;
}

/* 隠されている youtube.com のタブを探す。
   tabs.hide() できるのは自分の拡張機能が隠したタブだけなので、
   hidden===true は取得タブの目印として十分に強い。 */
async function findHiddenWorkerTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*", hidden: true });
    return tabs.map((t) => t.id);
  } catch (e) { return []; }
}

/* 保険。目印つきのタブが残っていれば拾う。
   YouTube が URL を書き換えると効かないので、当てにはしない。 */
async function findMarkedWorkerTab() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
    for (const t of tabs) {
      if (t && typeof t.url === "string" && t.url.indexOf(YT_WORKER_MARK) >= 0) return t.id;
    }
  } catch (e) {}
  return null;
}

/* 🔴 アドオンを更新／再読み込みしても、隠したまま保持されている取得タブでは
   MAIN world の古いエンジンが動き続ける。
   chat_fetcher_main.js は window.__syncChatEngine で冪等化しているため、
   新しいファイルを注入しても「既にある」と判断されて差し替わらない。
   v2.6.1 で「隠したまま保持」が既定になったので、これは常態化する。

   版数を突き合わせて差し替える設計は経路が増えて壊れやすいので採らない。
   更新時に取得タブごと捨てる。次の要求で自動的に作り直される。 */
chrome.runtime.onInstalled.addListener(async () => {
  const ids = [];
  try {
    const st = await chrome.storage.local.get(CHAT_TAB_KEY);
    if (st && st[CHAT_TAB_KEY] != null) ids.push(st[CHAT_TAB_KEY]);
  } catch (e) {}
  try {
    for (const id of await findHiddenWorkerTabs()) if (ids.indexOf(id) < 0) ids.push(id);
  } catch (e) {}
  for (const id of ids) {
    try { await chrome.tabs.remove(id); } catch (e) {}
  }
  chrome.storage.local.remove([CHAT_TAB_KEY, CHAT_TAB_OWN_KEY]).catch(() => {});
  console.log("【アドオン】更新にともない、チャット取得用タブを作り直します。");
});

/* 🔴 ブラウザを再起動するとタブIDは振り直される。
   しかも**隠したタブはセッションをまたいで復元される**ので、
   ただ ID を捨てるだけだと再起動のたびに隠しタブが1枚ずつ増える。
   復元されたものを1枚だけ残し、残りは閉じる。 */
chrome.runtime.onStartup.addListener(async () => {
  try {
    const ids = await findHiddenWorkerTabs();
    if (ids.length) {
      for (let i = 1; i < ids.length; i++) {
        try { await chrome.tabs.remove(ids[i]); } catch (e) {}
      }
      /* 🔴 復元された隠しタブは自分が作ったものなので所有として記録し直す。
         ⚠️ タブIDは再起動で振り直されるため、ここで書き直さないと
            前のセッションのIDが残って別のタブを指してしまう。 */
      const o = {};
      o[CHAT_TAB_KEY] = ids[0];
      o[CHAT_TAB_OWN_KEY] = ids[0];
      await chrome.storage.local.set(o);
      return;
    }
  } catch (e) {}
  chrome.storage.local.remove([CHAT_TAB_KEY, CHAT_TAB_OWN_KEY]).catch(() => {});
});

/* タブ一覧から隠す。
   ・ピン留めされたタブは hide できない（Firefox の仕様）
   ・現在アクティブなタブも hide できない
   ・初回だけ Firefox が「拡張機能がタブを隠しています」と通知する */
async function tryHideTab(tabId) {
  try {
    if (chrome.tabs.hide) { await chrome.tabs.hide(tabId); return true; }
  } catch (e) {}
  return false;
}

/* 取得タブをいつ閉じるかの方針。A側の設定メニューから届く。
   バックグラウンドは30秒で終了するので、値は storage.local に置く。 */
const CHAT_TAB_POLICY_KEY = "chatTabPolicy";
const CHAT_TAB_POLICY_MS = {
  keep: 0,          // 隠したまま保持
  idle10: 600000,   // 10分使わなければ閉じる
  close: 3000       // 取得が終わるたびに閉じる（数秒の猶予つき）
};

async function setChatTabPolicy(policy) {
  if (!Object.prototype.hasOwnProperty.call(CHAT_TAB_POLICY_MS, policy)) return;
  try {
    const o = {}; o[CHAT_TAB_POLICY_KEY] = policy;
    await chrome.storage.local.set(o);
  } catch (e) {}
  // 取得タブが既にあれば即座に反映する
  try {
    const st = await chrome.storage.local.get(CHAT_TAB_KEY);
    if (st && st[CHAT_TAB_KEY] != null) {
      await chrome.tabs.sendMessage(st[CHAT_TAB_KEY], {
        type: "CHAT_CONFIG",
        config: { IDLE_CLOSE_MS: CHAT_TAB_POLICY_MS[policy] }
      });
    }
  } catch (e) {}
}

async function getChatTabIdleMs() {
  try {
    const st = await chrome.storage.local.get(CHAT_TAB_POLICY_KEY);
    const p = st && st[CHAT_TAB_POLICY_KEY];
    if (Object.prototype.hasOwnProperty.call(CHAT_TAB_POLICY_MS, p)) return CHAT_TAB_POLICY_MS[p];
  } catch (e) {}
  return CHAT_TAB_POLICY_MS.keep;
}

/* エンジンから「用済み」の合図が来たら閉じる。
   閉じたことは storage の後始末も含めて tabs.onRemoved が拾う。

   🔴 閉じてよいかの最終判断は、エンジンが持つ設定ではなく
      background の保存値で行う。
      設定を「保持」に変えても、タブ内のエンジンが古い値を持ったままだと
      勝手に閉じてしまうため。 */
/* ★v2.8.0 の検討結果: ここには「ライブ取得中か」の条件を足していない。
   closeChatTab() は ev:'idle' を受けたときにしか呼ばれず、その idle は
   取得エンジンの jobs.size === 0 でしか発火しない。
   ライブのジョブは配信が終わるまで終わらない＝ jobs が空にならないので、
   「コメント取得用タブ」を close（3秒）にしていてもタブは維持される。
   取得が終われば（配信終了・利用者が止めた）従来どおり方針に従う。
   🔴 利用者が選んだ設定値は書き換えない。ここに状態を持たせないこと自体が、
      MV3 のバックグラウンドが 30 秒で終了することへの備えでもある。
   ⚠️ 実測は v2.8.0 の L5 で行う。想定どおりでなければここへ条件を足す。 */
async function closeChatTab() {
  const ms = await getChatTabIdleMs();
  if (!ms) return;   // 「隠したまま保持」なら閉じない
  try {
    const st = await chrome.storage.local.get(CHAT_TAB_KEY);
    if (!st || st[CHAT_TAB_KEY] == null) return;
    await chrome.tabs.remove(st[CHAT_TAB_KEY]);
    console.log("【アドオン】取得用タブを閉じました。");
  } catch (e) {}
}

async function rememberChatTab(tabId, own) {
  try {
    const o = {}; o[CHAT_TAB_KEY] = tabId;
    if (own) o[CHAT_TAB_OWN_KEY] = tabId;
    await chrome.storage.local.set(o);
  } catch (e) {}
}

/* ★v2.8.3: このセッションで自分が作ったタブのID。無ければ null。 */
async function getOwnChatTabId() {
  try {
    const st = await chrome.storage.local.get(CHAT_TAB_OWN_KEY);
    return (st && st[CHAT_TAB_OWN_KEY] != null) ? st[CHAT_TAB_OWN_KEY] : null;
  } catch (e) { return null; }
}

async function forgetOwnChatTab() {
  try { await chrome.storage.local.remove(CHAT_TAB_OWN_KEY); } catch (e) {}
}

/* 覚えている ID が本当に取得タブかを確かめる。
   「隠されている」または「ピン留めされている」ことも条件に入れて、
   利用者が普通に開いている YouTube のタブを乗っ取らないようにする。 */
async function isUsableChatTab(tabId) {
  const r = await inspectChatTab(tabId);
  return r.ok;
}

/* ★v2.8.3: 再利用できない理由まで返す。
   🔴 「使えない」とだけ分かっても、増え続ける原因は突き止められない。
      作り直した回数と理由をログに出せるようにする。 */
async function inspectChatTab(tabId) {
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); }
  catch (e) { return { ok: false, why: "タブが存在しない" }; }
  if (!tab || typeof tab.url !== "string") return { ok: false, why: "URLを読めない" };
  if (tab.url.indexOf("https://www.youtube.com/") !== 0) {
    return { ok: false, why: "YouTube のタブではない" };
  }
  /* 隠されている／ピン留めされている＝自分が用意したタブの目印。 */
  if (tab.hidden || tab.pinned) {
    return { ok: true, why: tab.hidden ? "隠されている" : "ピン留めされている" };
  }
  /* 🔴 隠せなかった場合の受け皿。
     自分で作って覚えているタブなら、見えていても再利用する。
     ここを拒否していたのが「タブが増え続ける」不具合の実体だった。
     ⚠️ 利用者が自分で開いた YouTube タブを乗っ取らないよう、
        「自分で作った」と記録した ID のときだけ許す。 */
  const own = await getOwnChatTabId();
  if (own != null && own === tabId) {
    return { ok: true, why: "自分で作ったタブ（隠せていない）" };
  }
  return { ok: false, why: "隠れてもピン留めもされておらず、自分で作った記録も無い" };
}

async function ensureChatTabInner() {
  // ① 覚えている ID（storage.local なのでアドオン再読み込みでも残る）
  let tabId = null;
  let why = "覚えている ID が無い";
  try {
    const st = await chrome.storage.local.get(CHAT_TAB_KEY);
    tabId = (st && st[CHAT_TAB_KEY] != null) ? st[CHAT_TAB_KEY] : null;
  } catch (e) {}
  if (tabId != null) {
    const r = await inspectChatTab(tabId);
    if (r.ok) return tabId;
    why = r.why;
  }

  // ② 目印つきの取り残しタブ（保険）
  const found = await findMarkedWorkerTab();
  if (found != null) {
    await rememberChatTab(found, true);
    console.log("【アドオン】既存のチャット取得用タブを再利用します。tabId=" + found);
    return found;
  }

  // ③ 隠されたまま残っているタブ（再起動直後など）
  const hidden = await findHiddenWorkerTabs();
  if (hidden.length) {
    for (let i = 1; i < hidden.length; i++) {
      try { await chrome.tabs.remove(hidden[i]); } catch (e) {}
    }
    await rememberChatTab(hidden[0], true);
    console.log("【アドオン】隠されている取得タブを再利用します。tabId=" + hidden[0]);
    return hidden[0];
  }

  /* ★v2.8.3: 作り直す前に、前に自分で作ったタブを閉じる。
     🔴 これが無いと、隠すのに失敗する環境では取得のたびに1枚ずつ増え続ける。
        ①〜③ で拾えなかった時点でそのタブはもう使えないので、残す理由が無い。
     ⚠️ 閉じてよいのは「自分で作った」と記録した ID だけ。 */
  const stale = await getOwnChatTabId();
  if (stale != null) {
    try {
      const t = await chrome.tabs.get(stale);
      if (t && typeof t.url === "string" && t.url.indexOf("https://www.youtube.com/") === 0) {
        await chrome.tabs.remove(stale);
        console.log("【アドオン】再利用できない取得用タブを閉じました。tabId=" + stale
          + " / 理由=" + why);
      }
    } catch (e) {}
    await forgetOwnChatTab();
  }

  // ④ 無ければ作る。★ピン留めしない（ピン留めしたタブは隠せないため）
  console.log("【アドオン】取得用タブを作り直します。前のタブを使えなかった理由=" + why);
  const tab = await chrome.tabs.create({ url: YT_WORKER_URL, active: false, pinned: false });

  /* 🔴 読み込みを待たずに、作った直後に隠すこと。
     待ってから隠すと、読み込みの数秒間だけタブ一覧に見えてしまう。
     隠されたタブは破棄されないので、読み込みはそのまま進む。 */
  let didHide = await tryHideTab(tab.id);
  await waitForTabComplete(tab.id);
  if (!didHide) didHide = await tryHideTab(tab.id);   // 作成直後に失敗した場合の再試行
  if (!didHide) {
    // 隠せない環境では、せめてピン留めして場所を取らせない
    try { await chrome.tabs.update(tab.id, { pinned: true }); } catch (e) {}
  }

  /* ★v2.8.3: 「自分で作った」ことも記録する。
     隠せなかったときに次の要求で再利用できるようにするため。 */
  await rememberChatTab(tab.id, true);
  let pinned = false;
  if (!didHide) {
    try { const t = await chrome.tabs.get(tab.id); pinned = !!(t && t.pinned); } catch (e) {}
  }
  console.log("【アドオン】チャット取得用タブを作成しました。tabId=" + tab.id
    + " 表示=" + (didHide ? "隠した" : (pinned ? "隠せずピン留め" : "隠せずピン留めもできず")));
  if (!didHide) {
    /* 🔴 利用者に見える形で残るので、原因を必ず名指しする。 */
    console.warn("【アドオン】⚠️ 取得用タブを隠せませんでした。"
      + "Firefox の「拡張機能がタブを隠しています」の通知で「元に戻す」を押すと、"
      + "以後この拡張機能はタブを隠せなくなります。"
      + "about:addons のこの拡張機能の権限で「タブを隠す」を有効にすると隠れます。"
      + "隠せなくてもタブは1枚だけ使い回すので、取得そのものには影響しません。");
  }
  return tab.id;
}

/* 両方とも自前のフラグで冪等なので、毎回呼んでよい。 */
async function ensureInjected(tabId) {
  // ISOLATED（中継）。先に入れる。
  await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ["content_yt_chat.js"] });

  /* ★v2.6.4: 注入しようとしている版数をページ世界へ置く。
     エンジンは構築時にこれを 1 回だけ読んで自分の version にする。
     ここは毎回上書きされるので、旧エンジンが生き残っていると
     __syncChatEngine.version（古い）と食い違い、それが検出結果になる。 */
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: "MAIN",
    func: (v) => { window.__SYNC_CHAT_EXPECTED_VERSION = v; },
    args: [chrome.runtime.getManifest().version]
  });

  // ★world:'MAIN' を省略すると Origin が moz-extension:// になり InnerTube が HTTP 403 を返す
  await chrome.scripting.executeScript({ target: { tabId: tabId }, world: "MAIN", files: ["chat_fetcher_main.js"] });
}

async function startChatStream(videoId, requestId, mode) {
  if (!videoId) throw new Error("videoId が指定されていません");

  const tabId = await ensureChatTab();

  /* ★権限の可否を事前判定で「決めない」。
     注入できるかどうかの唯一の権威は注入そのものである。
     事前チェックはパターンを取り違えると正常な環境を弾いてしまうので、
     失敗したときのエラー文面を良くするためだけに使う。 */
  try {
    await ensureInjected(tabId);
  } catch (e) {
    if (!(await hasYouTubePermission())) {
      throw new Error("YouTube への実行許可がありません。YouTubeのタブでツールバーの拡張機能アイコンを押し、"
        + "「このサイトでの実行を許可」を選んでから、もう一度お試しください。");
    }
    throw new Error("取得スクリプトの注入に失敗しました: " + (e && e.message ? e.message : e));
  }

  /* ★毎回渡す。タブを作り直したときも設定が確実に効くようにするため。 */
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "CHAT_CONFIG",
      config: { IDLE_CLOSE_MS: await getChatTabIdleMs() }
    });
  } catch (e) {}

  await chrome.tabs.sendMessage(tabId, {
    type: "CHAT_ENQUEUE",
    videoId: videoId,
    requestId: requestId,
    mode: mode === 'top' ? 'top' : 'all'   /* ★v2.10.0 */
  });
}

async function cancelChatStream(requestId) {
  try {
    const st = await chrome.storage.local.get(CHAT_TAB_KEY);
    if (!st || st[CHAT_TAB_KEY] == null) return;
    await chrome.tabs.sendMessage(st[CHAT_TAB_KEY], { type: "CHAT_CANCEL", requestId: requestId });
  } catch (e) { /* 既に閉じている等。中止できなくても実害はない */ }
}

/* 取得タブが閉じられたら覚えているIDを捨てる（次回は作り直す） */
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get([CHAT_TAB_KEY, CHAT_TAB_OWN_KEY]).then((st) => {
    const drop = [];
    if (st && st[CHAT_TAB_KEY] === tabId) drop.push(CHAT_TAB_KEY);
    /* ★v2.8.3: 所有の記録も一緒に捨てる。
       残すと、振り直された別のタブを「自分のもの」と誤認する。 */
    if (st && st[CHAT_TAB_OWN_KEY] === tabId) drop.push(CHAT_TAB_OWN_KEY);
    if (drop.length) chrome.storage.local.remove(drop);
  }).catch(() => {});
});

/* A側へ返す。
   ⚠️ ev の種類ごとに使うフィールドは違うが、まとめて全部転送する。
      「この ev では使わないから」と間引くと、中間ファイルで削られて
      A側に届かない既知の不具合パターン（replyChatArchive の diff 欠落）に嵌る。 */
function sendChatStreamEvent(p) {
  if (!p) return;
  chrome.tabs.query({ url: CONTROLLER_TAB_URLS }, (tabs) => {
    if (chrome.runtime.lastError) return;
    const msg = {
      type: "EXTERNAL_CHAT_STREAM",
      ev: p.ev,
      requestId: p.requestId,
      videoId: p.videoId,
      ok: p.ok,
      error: p.error,
      videoMs: p.videoMs,
      seq: p.seq,
      comments: p.comments,
      emoji: p.emoji,
      lastT: p.lastT,
      total: p.total,
      complete: p.complete,
      truncated: p.truncated,
      /* ★v2.8.0: 配信中という第3の状態。complete を流用しないための追加フィールド。
         🔴 ここと content_controller.js の両方に書くこと。片方だけだと A 側へ届かない。 */
      live: p.live,
      liveBy: p.liveBy,
      /* ★v2.10.0: 実際に選んだ表示。🔴 content_controller.js と対で書くこと。 */
      view: p.view,
      /* ★v2.11.0: ライブの終わり方と自動復帰の記録。🔴 content_controller.js と対で書くこと。 */
      endReason: p.endReason,
      endBy: p.endBy,
      liveRecovers: p.liveRecovers,
      liveExits: p.liveExits,
      recoverError: p.recoverError,
      livePolls: p.livePolls,
      reqs: p.reqs,
      elapsed: p.elapsed,
      active: p.active,
      waiting: p.waiting
    };
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  });
}

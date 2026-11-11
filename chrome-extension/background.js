// @ts-check
/**
 * Live Caption Typer — service worker.
 *
 * Keeps a WebSocket connection to the Live Caption Overlay desktop app
 * (ws://127.0.0.1:<port>), authenticates with the pairing token, and types
 * each finalized caption chunk into the focused field of the active tab.
 *
 * Reliability:
 *  - pings every 20 s (an open WebSocket with traffic keeps an MV3 service
 *    worker alive, Chrome 116+);
 *  - reconnects with back-off (1 s → 5 s) and a 30 s alarm that also revives
 *    the worker if Chrome stopped it;
 *  - text is only inserted while the app says typing is active for the same
 *    session, checked again right before each insertion, so nothing is typed
 *    after Stop.
 *
 * With the app's "Chrome" speech engine it also opens the speech page
 * (listener.html) while captioning runs and closes it on Stop. The page runs
 * in a hidden offscreen document; if Chrome refuses speech recognition there,
 * it moves to a pinned background tab instead.
 */

const DEFAULT_PORT = 47821;
const PING_MS = 20000;
const MAX_RETRY_MS = 5000;
const LISTENER_URL = chrome.runtime.getURL("listener.html");
/** Recognition errors after which the speech page moves from the offscreen document to a tab. */
const OFFSCREEN_REFUSALS = ["not-allowed", "service-not-allowed", "audio-capture"];

/** @typedef {"unpaired"|"connecting"|"connected"|"disconnected"|"auth_failed"} ConnState */

/** @type {WebSocket | null} */
let ws = null;
/** @type {ConnState} */
let connState = "disconnected";
let active = false;
let session = 0;
/** Whether the app wants the speech page (Chrome engine, captioning on). */
let listen = false;
let lang = "en-US";
/** @type {{state: string, mode: string, detail: string} | null} */
let listener = null;
let retryMs = 1000;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let retryTimer;
/** @type {ReturnType<typeof setInterval> | undefined} */
let pingTimer;
/**
 * @typedef {{ session: number, seq: number, text: string, provisional: string | null }} TypingJob
 * `text` is newly final caption text; `provisional` the not-yet-final tail
 * (live typing) that replaces the tail typed before, or null when unused.
 */

/** Insertions run one at a time, in arrival order. */
let chain = Promise.resolve();
/** Latest typing message received, so outdated preview-only updates can be skipped. */
let newest = { session: 0, seq: 0 };
/** @type {{result: string, at: number} | null} */
let lastResult = null;

async function getConfig() {
  const { port = DEFAULT_PORT, token = "" } = await chrome.storage.local.get(["port", "token"]);
  return { port: Number(port) || DEFAULT_PORT, token: String(token || "").trim() };
}

// ------------------------------------------------------------- status

async function publish() {
  const { port } = await getConfig();
  await chrome.storage.session.set({ status: { state: connState, active, port, lastResult, listen, lang, listener } });
  const connected = connState === "connected";
  const variant = connected ? "connected" : "disconnected";
  await chrome.action.setIcon({
    path: {
      16: `icons/${variant}-16.png`,
      32: `icons/${variant}-32.png`,
      48: `icons/${variant}-48.png`,
      128: `icons/${variant}-128.png`,
    },
  });
  /** @type {Record<ConnState, string>} */
  const titles = {
    connected: active ? "Connected — typing captions" : "Connected — captioning stopped",
    connecting: "Connecting to the desktop app…",
    disconnected: "Not connected — is Live Caption Overlay running?",
    auth_failed: "Pairing token rejected — open this popup to pair again",
    unpaired: "Not paired — open this popup and enter the pairing token",
  };
  await chrome.action.setTitle({ title: `Live Caption Typer — ${titles[connState]}` });
  const badge = connected && active ? "ON" : connState === "auth_failed" || connState === "unpaired" ? "!" : "";
  await chrome.action.setBadgeText({ text: badge });
  await chrome.action.setBadgeBackgroundColor({ color: badge === "ON" ? "#188038" : "#d93025" });
  await chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
}

/** @param {ConnState} s */
function setState(s) {
  connState = s;
  if (s !== "connected") {
    active = false;
    listen = false;
    syncListener();
  }
  void publish();
}

/** Apply a welcome/state message from the app. @param {any} msg */
function applyAppState(msg) {
  active = !!msg.active;
  session = Number(msg.session) || 0;
  if (msg.lang) lang = String(msg.lang);
  listen = !!msg.listen;
  syncListener();
  void publish();
}

// --------------------------------------------------------- connection

function scheduleReconnect() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void connect(), retryMs);
  retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(retryTimer);
  const { port, token } = await getConfig();
  if (!token) return setState("unpaired");
  setState("connecting");
  /** @type {WebSocket} */
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    setState("disconnected");
    return scheduleReconnect();
  }
  ws = sock;
  sock.onopen = () => {
    sock.send(JSON.stringify({ type: "hello", token, version: chrome.runtime.getManifest().version }));
  };
  sock.onmessage = (ev) => onMessage(sock, String(ev.data));
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    clearInterval(pingTimer);
    if (connState === "auth_failed") return void publish(); // wait for a new token
    setState("disconnected");
    scheduleReconnect();
  };
  sock.onerror = () => {
    /* onclose follows */
  };
}

function disconnect() {
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  const sock = ws;
  ws = null;
  sock?.close();
}

/** @param {WebSocket} sock @param {string} data */
function onMessage(sock, data) {
  /** @type {any} */
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  switch (msg.type) {
    case "welcome":
      retryMs = 1000;
      connState = "connected";
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send('{"type":"ping"}');
      }, PING_MS);
      applyAppState(msg);
      break;
    case "auth_error":
      connState = "auth_failed";
      void publish();
      sock.close();
      break;
    case "state":
      // Applied immediately, before any queued insertion runs.
      applyAppState(msg);
      break;
    case "text": {
      if (!active || msg.session !== session) return;
      /** @type {TypingJob} */
      const job = {
        session: msg.session,
        seq: Number(msg.seq) || 0,
        text: String(msg.text || ""),
        provisional: typeof msg.provisional === "string" ? msg.provisional : null,
      };
      newest = { session: job.session, seq: job.seq };
      chain = chain.then(() => typeText(sock, job)).catch(() => {});
      break;
    }
    default:
      break;
  }
}

// ------------------------------------------------------------ typing

const isCurrent = (/** @type {number} */ s) => active && s === session;

/** @param {WebSocket} sock @param {TypingJob} job */
async function typeText(sock, job) {
  if (!isCurrent(job.session)) return;
  // A preview-only update that a newer message already replaces: skip it.
  // Messages with final text are never skipped.
  if (!job.text && newest.session === job.session && newest.seq > job.seq) return;
  const result = await insertIntoActiveTab(job);
  if (result === "skipped") return;
  lastResult = { result, at: Date.now() };
  void publish();
  if (sock.readyState === WebSocket.OPEN) {
    sock.send(JSON.stringify({ type: "ack", session: job.session, seq: job.seq, result }));
  }
}

/** @param {number} tabId */
async function probeFrames(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => /** @type {any} */ (globalThis).__liveCaptionTyperV2?.probe() ?? null,
  });
  return results.map((r) => ({ frameId: r.frameId, info: /** @type {any} */ (r.result) }));
}

/**
 * @param {TypingJob} job
 * @returns {Promise<string>}
 */
async function insertIntoActiveTab(job) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id === undefined) return "no_tab";
  const tabId = tab.id;
  let frames;
  try {
    frames = await probeFrames(tabId);
    if (frames.every((f) => !f.info)) {
      // Tab was open before the extension was installed/updated.
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
      frames = await probeFrames(tabId);
    }
  } catch {
    return "restricted_page"; // chrome://, Web Store, PDF viewer…
  }
  // Pick the frame that really holds the caret: focused document first, then
  // the most recently focused one (Chrome may not be the foreground app).
  const candidates = frames
    .filter((f) => f.info && f.info.kind && f.info.kind !== "frame")
    .sort((a, b) => Number(b.info.hasFocus) - Number(a.info.hasFocus) || b.info.lastFocusAt - a.info.lastFocusAt);
  const target = candidates[0];
  if (!target) return "no_field";
  if (target.info.kind === "password") return "password_field";
  if (!isCurrent(job.session)) return "skipped"; // Stop arrived meanwhile
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [target.frameId] },
      func: (session, text, provisional) =>
        /** @type {any} */ (globalThis).__liveCaptionTyperV2?.apply(session, text, provisional) ?? "no_field",
      args: [job.session, job.text, job.provisional],
    });
    return String(res?.result ?? "error");
  } catch {
    return "error";
  }
}

// ------------------------------------------------------- speech page

/** Opening and closing run one at a time, so a quick Stop/Start can't race. */
let listenerOps = Promise.resolve();

function syncListener() {
  listenerOps = listenerOps.then(() => (listen ? openListener() : closeListener())).catch(() => {});
}

/** The speech page wherever it runs (offscreen document and/or tab). */
function listenerContexts() {
  return chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT, chrome.runtime.ContextType.TAB],
    documentUrls: [LISTENER_URL],
  });
}

async function openListener() {
  if ((await listenerContexts()).length) return;
  listener = null;
  const { listenerHost = "offscreen" } = await chrome.storage.local.get("listenerHost");
  if (listenerHost === "offscreen") {
    try {
      await chrome.offscreen.createDocument({
        url: "listener.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: "Recognizes speech in the audio streamed by the Live Caption Overlay desktop app.",
      });
      return;
    } catch {
      /* fall back to a tab below */
    }
  }
  await chrome.tabs.create({ url: "listener.html", pinned: true, active: false });
}

async function closeListener() {
  for (const ctx of await listenerContexts()) {
    if (ctx.contextType === chrome.runtime.ContextType.OFFSCREEN_DOCUMENT) await chrome.offscreen.closeDocument();
    else if (ctx.tabId !== undefined && ctx.tabId >= 0) await chrome.tabs.remove(ctx.tabId).catch(() => {});
  }
}

/**
 * Status from the speech page. If Chrome refuses recognition in the hidden
 * offscreen document, remember that and run the page in a tab from now on.
 * @param {any} msg
 * @param {chrome.runtime.MessageSender} sender
 */
function onListenerStatus(msg, sender) {
  listener = { state: String(msg.state), mode: String(msg.mode), detail: String(msg.detail || "") };
  void publish();
  const offscreen = sender.tab === undefined;
  if (offscreen && msg.state === "error" && OFFSCREEN_REFUSALS.includes(msg.detail)) {
    listenerOps = listenerOps
      .then(async () => {
        await chrome.storage.local.set({ listenerHost: "tab" });
        await closeListener();
        if (listen) await openListener();
      })
      .catch(() => {});
  }
}

// ------------------------------------------------------------- events

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.token || changes.port)) {
    retryMs = 1000;
    connState = "disconnected";
    disconnect();
    void connect();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === "listener-config") {
    void Promise.all([getConfig(), chrome.storage.local.get("speechMode")]).then(([{ port, token }, { speechMode }]) =>
      sendResponse({ port, token, mode: speechMode === "online" ? "online" : "auto" }),
    );
    return true;
  }
  if (msg?.type === "listener-status") {
    onListenerStatus(msg, sender);
    return false;
  }
  if (msg?.type === "reconnect") {
    retryMs = 1000;
    if (connState === "auth_failed") connState = "disconnected";
    disconnect();
    void connect().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect" && !ws && connState !== "auth_failed") void connect();
});

/** Make already-open tabs usable without reloading them. */
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((t) =>
      t.id === undefined
        ? null
        : chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ["content.js"] }).catch(() => null),
    ),
  );
}

chrome.runtime.onInstalled.addListener(() => void injectIntoOpenTabs());
chrome.runtime.onStartup.addListener(() => void connect());

void chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
void connect();

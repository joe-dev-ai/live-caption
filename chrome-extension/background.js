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
 */

const DEFAULT_PORT = 47821;
const PING_MS = 20000;
const MAX_RETRY_MS = 5000;

/** @typedef {"unpaired"|"connecting"|"connected"|"disconnected"|"auth_failed"} ConnState */

/** @type {WebSocket | null} */
let ws = null;
/** @type {ConnState} */
let connState = "disconnected";
let active = false;
let session = 0;
let retryMs = 1000;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let retryTimer;
/** @type {ReturnType<typeof setInterval> | undefined} */
let pingTimer;
/** Insertions run one at a time, in arrival order. */
let chain = Promise.resolve();
/** @type {{result: string, at: number} | null} */
let lastResult = null;

async function getConfig() {
  const { port = DEFAULT_PORT, token = "" } = await chrome.storage.local.get(["port", "token"]);
  return { port: Number(port) || DEFAULT_PORT, token: String(token || "").trim() };
}

// ------------------------------------------------------------- status

async function publish() {
  const { port } = await getConfig();
  await chrome.storage.session.set({ status: { state: connState, active, port, lastResult } });
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
  if (s !== "connected") active = false;
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
      active = !!msg.active;
      session = Number(msg.session) || 0;
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send('{"type":"ping"}');
      }, PING_MS);
      void publish();
      break;
    case "auth_error":
      connState = "auth_failed";
      void publish();
      sock.close();
      break;
    case "state":
      // Applied immediately, before any queued insertion runs.
      active = !!msg.active;
      session = Number(msg.session) || 0;
      void publish();
      break;
    case "text": {
      if (!active || msg.session !== session) return;
      const job = { session: msg.session, seq: msg.seq, text: String(msg.text || "") };
      chain = chain.then(() => typeText(sock, job)).catch(() => {});
      break;
    }
    default:
      break;
  }
}

// ------------------------------------------------------------ typing

const isCurrent = (/** @type {number} */ s) => active && s === session;

/** @param {WebSocket} sock @param {{session:number, seq:number, text:string}} job */
async function typeText(sock, job) {
  if (!isCurrent(job.session)) return;
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
    func: () => /** @type {any} */ (globalThis).__liveCaptionTyper?.probe() ?? null,
  });
  return results.map((r) => ({ frameId: r.frameId, info: /** @type {any} */ (r.result) }));
}

/**
 * @param {{session:number, text:string}} job
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
      func: (text) => /** @type {any} */ (globalThis).__liveCaptionTyper?.insert(text) ?? "no_field",
      args: [job.text],
    });
    return String(res?.result ?? "error");
  } catch {
    return "error";
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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

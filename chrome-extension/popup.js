// @ts-check
/** Live Caption Typer — popup: pairing, connection status and the Chrome speech engine. */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const tokenInput = /** @type {HTMLInputElement} */ ($("token"));
const portInput = /** @type {HTMLInputElement} */ ($("port"));
const modeSelect = /** @type {HTMLSelectElement} */ ($("speech-mode"));
const installButton = /** @type {HTMLButtonElement} */ ($("install"));

/** @type {Record<string, string>} */
const RESULT_TEXT = {
  inserted: "Last caption was typed into the focused field.",
  no_field: "No text field focused — click into a text box in this tab.",
  password_field: "A password field is focused — nothing was typed.",
  restricted_page: "Chrome does not allow typing on this page.",
  no_tab: "No active tab.",
  error: "Typing failed on this page.",
};

/** @param {any} status */
function render(status) {
  const s = status ?? { state: "disconnected", active: false };
  const el = $("status");
  const typing = s.state === "connected" && s.active;
  el.dataset.state = typing ? "typing" : s.state;
  /** @type {Record<string, string>} */
  const text = {
    connected: typing ? "Connected — typing captions" : "Connected — captioning stopped",
    connecting: "Connecting…",
    disconnected: "Not connected",
    auth_failed: "Pairing token rejected",
    unpaired: "Not paired",
  };
  $("status-text").textContent = text[s.state] ?? s.state;
  let detail = "";
  if (s.state === "disconnected") detail = `Is Live Caption Overlay running? (127.0.0.1:${s.port ?? 47821})`;
  else if (s.state === "auth_failed") detail = "Copy the current token from the desktop app's Settings.";
  else if (s.state === "unpaired") detail = "Enter the pairing token shown in the desktop app.";
  else if (s.lastResult && Date.now() - s.lastResult.at < 120000) detail = RESULT_TEXT[s.lastResult.result] ?? "";
  else if (s.state === "connected") detail = typing ? "Click into a text field to receive captions." : "Press Start in the desktop app.";
  $("detail").textContent = detail;
  renderEngine(s);
}

/** @type {Record<string, string>} */
const LISTENER_TEXT = {
  starting: "Starting",
  listening: "Listening",
  error: "Error",
  stopped: "Stopped",
  disconnected: "Not connected to the app",
};

/** @param {any} s */
function renderEngine(s) {
  const l = s.listener;
  let text = 'Idle. Runs while the app captions with the "Chrome" speech engine.';
  if (s.listen && !l) text = "Starting…";
  else if (s.listen) text = `${LISTENER_TEXT[l.state] ?? l.state} (${l.mode})${l.detail ? `: ${l.detail}` : ""}`;
  $("engine-status").textContent = text;
  if (s.lang && s.lang !== modelLang) {
    modelLang = s.lang;
    void refreshModel();
  }
}

// ------------------------------------------------ on-device speech model

/** Language of the on-device model shown (the app's caption language). */
let modelLang = "en-US";
/** @type {ReturnType<typeof setTimeout> | undefined} */
let modelPoll;

/** @returns {any} */
const speechRecognitionClass = () =>
  /** @type {any} */ (globalThis).SpeechRecognition ?? /** @type {any} */ (globalThis).webkitSpeechRecognition;

/** @type {Record<string, (lang: string) => string>} */
const MODEL_TEXT = {
  available: (lang) => `On-device model (${lang}) installed: works offline, no limits.`,
  downloadable: (lang) => `On-device model (${lang}) not installed; online recognition is used.`,
  downloading: (lang) => `Downloading the on-device model (${lang})…`,
  unavailable: (lang) => `Chrome has no on-device model for ${lang}; online recognition is used.`,
};

async function refreshModel() {
  clearTimeout(modelPoll);
  const SR = speechRecognitionClass();
  installButton.hidden = true;
  if (typeof SR?.available !== "function") {
    $("model-text").textContent = "On-device recognition needs Chrome 139 or later; online recognition is used.";
    return;
  }
  /** @type {string} */
  let status;
  try {
    status = await SR.available({ langs: [modelLang], processLocally: true });
  } catch {
    status = "unavailable";
  }
  $("model-text").textContent = (MODEL_TEXT[status] ?? MODEL_TEXT.unavailable)(modelLang);
  installButton.hidden = status !== "downloadable";
  if (status === "downloading") modelPoll = setTimeout(() => void refreshModel(), 2000);
}

/** Download the on-device model; Chrome requires this click for it. */
async function installModel() {
  installButton.disabled = true;
  try {
    const started = await speechRecognitionClass().install({ langs: [modelLang], processLocally: true });
    if (!started) $("model-text").textContent = "Chrome could not start the download.";
  } catch (e) {
    $("model-text").textContent = `Download failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    installButton.disabled = false;
  }
  // Give Chrome a moment to report the download before checking again.
  modelPoll = setTimeout(() => void refreshModel(), 1000);
}

async function init() {
  const { token = "", port = 47821, speechMode = "auto" } = await chrome.storage.local.get([
    "token",
    "port",
    "speechMode",
  ]);
  tokenInput.value = String(token);
  portInput.value = String(port);
  modeSelect.value = speechMode === "online" ? "online" : "auto";
  // Takes effect the next time captioning starts.
  modeSelect.addEventListener("change", () => void chrome.storage.local.set({ speechMode: modeSelect.value }));
  installButton.addEventListener("click", () => void installModel());
  const { status } = await chrome.storage.session.get("status");
  render(status);
  void refreshModel();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.status) render(changes.status.newValue);
  });
  $("pair-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = tokenInput.value.trim().toUpperCase();
    const port = Number(portInput.value) || 47821;
    await chrome.storage.local.set({ token, port });
    await chrome.runtime.sendMessage({ type: "reconnect" });
  });
  $("reconnect").addEventListener("click", () => void chrome.runtime.sendMessage({ type: "reconnect" }));
}

void init();

// @ts-check
/** Live Caption Typer — popup: pairing and connection status. */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const tokenInput = /** @type {HTMLInputElement} */ ($("token"));
const portInput = /** @type {HTMLInputElement} */ ($("port"));

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
}

async function init() {
  const { token = "", port = 47821 } = await chrome.storage.local.get(["token", "port"]);
  tokenInput.value = String(token);
  portInput.value = String(port);
  const { status } = await chrome.storage.session.get("status");
  render(status);
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

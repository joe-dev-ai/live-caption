// Settings window: edits are saved automatically (debounced) and applied
// live; the Rust side persists them and notifies every window.

import "./styles/settings.css";
import { describeAllowance, summarizeAllowance } from "./lib/allowance.ts";
import { backend, broadcast, errorText, on } from "./lib/backend.ts";
import type { BridgeStatus, JumpStatus, PuterStatus, Settings } from "./lib/types.ts";
import { modelLabel, profileFor } from "./pipeline/profile.ts";
import { icon } from "./ui/icons.ts";

const LANGUAGES: [string, string][] = [
  ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"],
  ["nl", "Dutch"], ["sv", "Swedish"], ["da", "Danish"], ["no", "Norwegian"], ["fi", "Finnish"], ["pl", "Polish"],
  ["cs", "Czech"], ["ro", "Romanian"], ["hu", "Hungarian"], ["el", "Greek"], ["tr", "Turkish"], ["ru", "Russian"],
  ["uk", "Ukrainian"], ["ar", "Arabic"], ["he", "Hebrew"], ["hi", "Hindi"], ["ja", "Japanese"], ["ko", "Korean"],
  ["zh", "Chinese"], ["vi", "Vietnamese"], ["id", "Indonesian"], ["th", "Thai"], ["tl", "Filipino"],
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let settings: Settings;
let saveTimer: number | undefined;

type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
type NumKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type StrKey = { [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings];

const BOOL_KEYS: BoolKey[] = [
  "useContextPrompt",
  "livePreview",
  "typeIntoChrome",
  "typePreview",
  "showDebug",
  "saveTranscript",
];
const RANGE_KEYS: NumKey[] = ["maxParallel", "fontSize", "bgOpacity"];
const TEXT_KEYS: StrKey[] = ["jumpProcessNames", "transcriptDir"];
const HOTKEY_KEYS: StrKey[] = ["hotkeyToggle", "hotkeyShowHide", "hotkeyTyping"];

function setSaveState(text: string, error = false): void {
  const el = $("save-state");
  el.textContent = text;
  el.classList.toggle("error", error);
}

function update(patch: Partial<Settings>, delay = 250): void {
  settings = { ...settings, ...patch };
  renderDerived();
  setSaveState("Saving…");
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      settings = await backend.saveSettings(settings);
      setSaveState("Saved");
    } catch (e) {
      setSaveState(errorText(e), true);
    }
    await renderHotkeyErrors();
  }, delay);
}

/** Show hotkeys that could not be registered (e.g. taken by another program). */
async function renderHotkeyErrors(): Promise<void> {
  const errors = await backend.hotkeyErrors().catch(() => [] as string[]);
  const el = $("hotkey-errors");
  el.hidden = errors.length === 0;
  el.textContent = errors.join(" ");
}

function formatValue(key: NumKey, v: number): string {
  if (key === "bgOpacity") return `${Math.round(v * 100)}%`;
  if (key === "fontSize") return `${v}px`;
  return String(v);
}

function render(): void {
  for (const key of BOOL_KEYS) $<HTMLInputElement>(key).checked = settings[key];
  for (const key of RANGE_KEYS) {
    $<HTMLInputElement>(key).value = String(settings[key]);
    $(`${key}-out`).textContent = formatValue(key, settings[key]);
  }
  for (const key of [...TEXT_KEYS, ...HOTKEY_KEYS]) {
    const el = $<HTMLInputElement>(key);
    if (document.activeElement !== el) el.value = settings[key];
  }
  $<HTMLSelectElement>("language").value = settings.language;
  $<HTMLSelectElement>("model").value = settings.model;
  $<HTMLInputElement>("pairingToken").value = settings.pairingToken;
  if (document.activeElement !== $("bridgePort")) $<HTMLInputElement>("bridgePort").value = String(settings.bridgePort);
  renderDerived();
}

function renderDerived(): void {
  document.querySelectorAll<HTMLElement>(".segmented").forEach((group) => {
    const key = group.dataset.key as keyof Settings;
    group.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(settings[key] === b.dataset.value));
    });
  });
  // Live typing needs the live preview.
  $<HTMLInputElement>("typePreview").disabled = !settings.livePreview;
  document.body.dataset.engine = settings.engine;
  $("engine-hint").textContent =
    settings.engine === "chrome"
      ? "Chrome's built-in speech recognition, through the Live Caption Typer extension: free, no account, no " +
        "monthly limit. Keep Chrome running with the extension paired; pick on-device or online recognition in " +
        "the extension's popup."
      : "Puter.js speech-to-text with your own Puter account. A free account is never charged, but its monthly " +
        "allowance is small.";
  const p = profileFor(settings.priority, settings.model);
  $("priority-hint").textContent =
    `${modelLabel(p.model)}, chunks ${p.minChunkSec}–${p.maxChunkSec} s, cut at pauses ≥ ${Math.round(p.pauseSec * 1000)} ms.`;
}

function renderJump(j: JumpStatus): void {
  const el = $("jump-status");
  if (!j.supported) {
    el.textContent = "Per-app capture of Jump Desktop is available on Windows 10 (2004+) / 11.";
    el.className = "hint";
  } else if (j.detected) {
    el.textContent = `Jump Desktop detected: ${j.process} (PID ${j.pid}). Other local sounds are ignored in this mode.`;
    el.className = "hint ok";
  } else {
    el.textContent = "Jump Desktop not detected — start it, or use All system audio.";
    el.className = "hint warn";
  }
}

function renderBridge(b: BridgeStatus): void {
  const el = $("bridge-status");
  if (b.error) {
    el.textContent = b.error;
    el.className = "hint warn";
  } else if (b.clients > 0) {
    const speech = b.listeners > 0 ? " Its speech engine is running." : "";
    el.textContent = `Chrome extension connected (${b.clients}) on 127.0.0.1:${b.port}.${speech}`;
    el.className = "hint ok";
  } else {
    el.textContent = b.listening ? `Waiting for the Chrome extension on 127.0.0.1:${b.port}…` : "Starting…";
    el.className = "hint";
  }
}

let puterStatus: PuterStatus = { loaded: false, signedIn: false };

function renderPuter(p: PuterStatus): void {
  puterStatus = p;
  $("puter-status").textContent = !p.loaded
    ? p.error ?? "Puter.js is loading…"
    : p.signedIn
      ? `Signed in${p.username ? ` as ${p.username}` : ""}.`
      : "Not signed in — use the Sign in button on the caption overlay.";
  $<HTMLButtonElement>("puter-signout").disabled = !p.signedIn;
  const usage = $("puter-usage");
  usage.hidden = !p.signedIn || !p.allowance;
  if (usage.hidden || !p.allowance) return;
  const summary = summarizeAllowance(p.allowance, settings.livePreview);
  $("usage-fill").style.width = `${summary.usedPercent.toFixed(1)}%`;
  $("usage-meter").classList.toggle("low", summary.low);
  $("usage-meter").setAttribute("aria-valuenow", String(Math.round(summary.usedPercent)));
  $("usage-text").textContent = describeAllowance(summary);
}

/** Convert a keydown into an accelerator string such as "Ctrl+Alt+Q". */
function accelerator(e: KeyboardEvent): string | null {
  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (/^Numpad\d$/.test(code)) key = code;
  else {
    const named: Record<string, string> = {
      Space: "Space", Enter: "Enter", Tab: "Tab", Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp",
      PageDown: "PageDown", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      Minus: "-", Equal: "=", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", Backquote: "`",
      BracketLeft: "[", BracketRight: "]", Backslash: "\\", Pause: "Pause",
    };
    key = named[code] ?? null;
  }
  if (!key) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  // Require a modifier (except for function keys) so normal typing is never hijacked.
  if (!mods.length && !/^F\d/.test(key)) return null;
  return [...mods, key].join("+");
}

function wire(): void {
  const lang = $<HTMLSelectElement>("language");
  for (const [code, name] of LANGUAGES) lang.add(new Option(`${name} (${code})`, code));
  lang.addEventListener("change", () => update({ language: lang.value }, 0));
  $<HTMLSelectElement>("model").addEventListener("change", (e) => update({ model: (e.target as HTMLSelectElement).value }, 0));

  document.querySelectorAll<HTMLElement>(".segmented").forEach((group) => {
    group.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (b?.dataset.value) update({ [group.dataset.key!]: b.dataset.value } as Partial<Settings>, 0);
    });
  });
  for (const key of BOOL_KEYS) {
    $<HTMLInputElement>(key).addEventListener("change", (e) => update({ [key]: (e.target as HTMLInputElement).checked }, 0));
  }
  for (const key of RANGE_KEYS) {
    $<HTMLInputElement>(key).addEventListener("input", (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      $(`${key}-out`).textContent = formatValue(key, v);
      update({ [key]: v });
    });
  }
  for (const key of TEXT_KEYS) {
    $<HTMLInputElement>(key).addEventListener("input", (e) => update({ [key]: (e.target as HTMLInputElement).value }, 600));
  }
  $<HTMLInputElement>("bridgePort").addEventListener("change", (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    if (v >= 1024 && v <= 65535) update({ bridgePort: v }, 0);
  });

  for (const key of HOTKEY_KEYS) {
    const el = $<HTMLInputElement>(key);
    el.addEventListener("focus", () => {
      el.classList.add("recording");
      el.value = "Press keys…";
      // Otherwise a combination that is already registered would trigger
      // its action instead of reaching this field.
      void backend.suspendHotkeys(true);
    });
    el.addEventListener("blur", () => {
      el.classList.remove("recording");
      el.value = settings[key];
      void backend.suspendHotkeys(false).then(renderHotkeyErrors);
    });
    el.addEventListener("keydown", (e) => {
      e.preventDefault();
      if (e.key === "Escape") return el.blur();
      if (e.key === "Backspace" || e.key === "Delete") {
        update({ [key]: "" }, 0);
        return el.blur();
      }
      const acc = accelerator(e);
      if (acc) {
        update({ [key]: acc }, 0);
        el.blur();
      }
    });
  }

  const copy = $<HTMLButtonElement>("copy-token");
  copy.innerHTML = `${icon("copy")}<span>Copy</span>`;
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(settings.pairingToken);
      setSaveState("Token copied");
    } catch {
      $<HTMLInputElement>("pairingToken").select();
      document.execCommand("copy");
      setSaveState("Token copied");
    }
  });
  const regen = $<HTMLButtonElement>("regen-token");
  regen.innerHTML = `${icon("refresh")}<span>New token</span>`;
  regen.addEventListener("click", async () => {
    if (!confirm("Generate a new pairing token? The Chrome extension must be paired again.")) return;
    try {
      settings = await backend.regenerateToken();
      render();
      setSaveState("New token generated");
    } catch (e) {
      setSaveState(errorText(e), true);
    }
  });
  const signout = $<HTMLButtonElement>("puter-signout");
  signout.innerHTML = `${icon("logout")}<span>Sign out of Puter</span>`;
  signout.addEventListener("click", () => void broadcast("puter-sign-out"));
}

async function main(): Promise<void> {
  wire();
  const [s, bridge, jump, info] = await Promise.all([
    backend.getSettings(),
    backend.bridgeStatus(),
    backend.jumpStatus(),
    backend.appInfo(),
  ]);
  settings = s;
  render();
  renderBridge(bridge);
  renderJump(jump);
  renderPuter({ loaded: false, signedIn: false });
  await renderHotkeyErrors();
  $("version").textContent = `Live Caption Overlay ${info.version} · ${info.os}${info.testAudio ? ` · test audio: ${info.testAudio}` : ""}`;
  await Promise.all([
    on<Settings>("settings-changed", (next) => {
      settings = next;
      render();
      renderPuter(puterStatus); // the estimate depends on Live preview
    }),
    on<BridgeStatus>("bridge-status", renderBridge),
    on<JumpStatus>("jump-status", renderJump),
    on<PuterStatus>("puter-status", renderPuter),
  ]);
  await broadcast("puter-status-request");
}

void main();

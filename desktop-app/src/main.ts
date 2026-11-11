// Caption overlay window: owns the captioning session (Start/Stop), runs the
// transcription pipeline, renders captions and forwards text to Chrome.

import "./styles/overlay.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { backend, broadcast, errorText, newAudioChannel, on } from "./lib/backend.ts";
import type { AckResult, BridgeAck, BridgeStatus, CaptureStatus, JumpStatus, PuterStatus, Settings } from "./lib/types.ts";
import { CaptionPipeline, type PipelineConfig, type PipelineStats } from "./pipeline/pipeline.ts";
import { profileFor } from "./pipeline/profile.ts";
import { fakeTranscribe } from "./pipeline/fake-stt.ts";
import { classifyError, loadPuter, transcribeWithPuter } from "./pipeline/puter.ts";
import { wordErrorRate } from "./pipeline/wer.ts";
import { icon } from "./ui/icons.ts";

// ------------------------------------------------------------------ state

const ui = {
  overlay: document.getElementById("overlay")!,
  status: document.getElementById("status")!,
  statusText: document.getElementById("status-text")!,
  chipSource: document.getElementById("chip-source") as HTMLButtonElement,
  chipChrome: document.getElementById("chip-chrome") as HTMLButtonElement,
  toggle: document.getElementById("btn-toggle") as HTMLButtonElement,
  settings: document.getElementById("btn-settings") as HTMLButtonElement,
  hide: document.getElementById("btn-hide") as HTMLButtonElement,
  banner: document.getElementById("banner")!,
  bannerText: document.getElementById("banner-text")!,
  bannerAction: document.getElementById("banner-action") as HTMLButtonElement,
  bannerClose: document.getElementById("banner-close") as HTMLButtonElement,
  captions: document.getElementById("captions")!,
  debug: document.getElementById("debug")!,
};

type Banner = { text: string; action?: { label: string; run: () => void }; error?: boolean } | null;

const state = {
  settings: null as Settings | null,
  active: false,
  session: 0,
  inFlight: 0,
  capture: null as CaptureStatus | null,
  bridge: { listening: false, port: 0, clients: 0 } as BridgeStatus,
  jump: { supported: false, detected: false } as JumpStatus,
  puter: { loaded: false, signedIn: false } as PuterStatus,
  testAudio: null as string | null,
  /** Accuracy test: reference transcript, full session text, end-of-file time. */
  reference: null as string | null,
  fakeStt: false,
  sessionText: "",
  testFinishedAt: 0,
  lastAck: null as { result: AckResult; at: number } | null,
  transient: null as { text: string; until: number } | null,
  banner: null as Banner,
  lines: [] as string[],
  current: "",
  lastTextAt: 0,
  stats: null as PipelineStats | null,
};

// ------------------------------------------------------------ pipeline

function pipelineConfig(s: Settings): PipelineConfig {
  return {
    profile: profileFor(s.priority, s.model),
    language: s.language,
    useContextPrompt: s.useContextPrompt,
    maxParallel: s.maxParallel,
  };
}

let pipeline: CaptionPipeline | null = null;

function createPipeline(s: Settings): CaptionPipeline {
  return new CaptionPipeline(pipelineConfig(s), state.fakeStt ? fakeTranscribe : transcribeWithPuter, {
    onText: (text, meta) => {
      if (!state.active) return;
      state.sessionText += ` ${text}`;
      appendCaption(text);
      const session = state.session;
      if (state.settings?.typeIntoChrome) void backend.bridgeSendText(session, meta.seq, text);
      if (state.settings?.saveTranscript) void backend.transcriptAppend(`[${clock()}] ${text}`).catch(() => {});
    },
    onBusy: (n) => {
      state.inFlight = n;
      render();
    },
    onError: (error) => {
      if (!state.active) return;
      const err = classifyError(error);
      if (err.kind === "auth") {
        stop();
        void refreshPuter();
        showSignInBanner("Your Puter session expired — sign in again to continue.");
      } else if (err.kind === "quota") {
        stop();
        setBanner({ text: `Puter usage limit reached: ${err.message}`, error: true });
      } else {
        flash(err.kind === "network" ? "Network error — skipped a chunk" : `Skipped a chunk: ${err.message}`);
      }
    },
    onStats: (stats) => {
      state.stats = stats;
      renderDebug();
    },
  });
}

// ------------------------------------------------------- start / stop

async function start(fromClick: boolean): Promise<void> {
  if (state.active || !state.settings) return;
  const puter = window.puter;
  if (state.fakeStt) {
    // Offline test mode: no Puter account needed.
  } else if (!puter) {
    setBanner({ text: "Puter.js is not loaded yet.", action: { label: "Retry", run: () => void initPuter() }, error: true });
    return;
  } else if (!puter.auth.isSignedIn()) {
    if (fromClick) {
      // Called synchronously from the click so the sign-in popup is allowed.
      const ok = await signIn();
      if (!ok) return;
    } else {
      showSignInBanner();
      return;
    }
  }

  state.active = true;
  state.session = Date.now();
  state.capture = null;
  state.lastAck = null;
  state.sessionText = "";
  state.testFinishedAt = 0;
  clearBannerIf((b) => !b?.error);
  pipeline?.reset();
  render(); // instant feedback

  const session = state.session;
  const s = state.settings;
  void backend.setCaptioning(true, s.typeIntoChrome, session);

  const channel = newAudioChannel();
  channel.onmessage = (data) => {
    if (!state.active || state.session !== session) return;
    const pcm = data instanceof ArrayBuffer ? new Int16Array(data) : Int16Array.from(data as number[]);
    pipeline?.pushPcm(pcm);
  };
  try {
    await backend.startCapture(channel);
  } catch (e) {
    if (state.session === session) {
      stop();
      setBanner({ text: errorText(e), error: true });
    }
    return;
  }
  if (s.saveTranscript) {
    backend.transcriptBegin(fileStamp()).catch((e) => flash(`Transcript: ${errorText(e)}`));
  }
}

/** Stop immediately: nothing queued or in flight is shown or typed afterwards. */
function stop(): void {
  if (!state.active) return;
  state.active = false;
  state.session = 0;
  state.inFlight = 0;
  void backend.setCaptioning(false, false, 0);
  pipeline?.reset();
  void backend.stopCapture();
  render();
}

function toggle(fromClick: boolean): void {
  if (state.active) stop();
  else void start(fromClick);
}

// ------------------------------------------------------------- Puter

async function initPuter(): Promise<void> {
  clearBannerIf((b) => !!b?.text.includes("Puter.js"));
  try {
    await loadPuter();
    state.puter.loaded = true;
    state.puter.error = null;
  } catch (e) {
    state.puter = { loaded: false, signedIn: false, error: errorText(e) };
    setBanner({ text: errorText(e), action: { label: "Retry", run: () => void initPuter() }, error: true });
  }
  await refreshPuter();
  if (state.puter.loaded && !state.puter.signedIn) showSignInBanner();
}

async function refreshPuter(): Promise<void> {
  const puter = window.puter;
  if (!puter) return publishPuter();
  state.puter.signedIn = puter.auth.isSignedIn();
  state.puter.username = null;
  if (state.puter.signedIn) {
    try {
      state.puter.username = (await puter.auth.getUser())?.username ?? null;
    } catch {
      /* offline: keep signed-in state */
    }
    clearBannerIf((b) => !!b?.text.includes("Sign in"));
  }
  publishPuter();
  render();
}

function publishPuter(): void {
  void broadcast("puter-status", state.puter);
}

function signIn(): Promise<boolean> {
  const puter = window.puter;
  if (!puter) return Promise.resolve(false);
  setBanner({ text: "Complete the sign-in in the Puter window…" });
  return puter.auth
    .signIn()
    .then(async () => {
      await refreshPuter();
      clearBannerIf(() => true);
      return true;
    })
    .catch((e: unknown) => {
      const code = (e as { error?: string })?.error;
      showSignInBanner(
        code === "auth_window_closed"
          ? "Sign-in was cancelled."
          : code === "popup_blocked"
            ? "The sign-in window was blocked."
            : `Sign-in failed: ${errorText(e)}`,
      );
      return false;
    });
}

function showSignInBanner(text = "Sign in to Puter to start captions (free account; usage is billed to your Puter account)."): void {
  setBanner({ text, action: { label: "Sign in", run: () => void signIn() } });
}

// --------------------------------------------------------- captions

function appendCaption(text: string): void {
  const now = Date.now();
  const cur = state.current;
  const endsSentence = /[.!?…]["'”’)]?$/.test(cur);
  if (cur && (now - state.lastTextAt > 4000 || (endsSentence && cur.length > 70) || cur.length > 220)) {
    state.lines.push(cur);
    state.current = "";
    if (state.lines.length > 30) state.lines.splice(0, state.lines.length - 30);
  }
  state.current = state.current ? `${state.current} ${text}` : text;
  state.lastTextAt = now;
  renderCaptions();
}

function renderCaptions(): void {
  const n = state.settings?.captionLines ?? 4;
  const all = [...state.lines, state.current].filter(Boolean).slice(-n);
  ui.captions.replaceChildren();
  if (!all.length) {
    const p = document.createElement("div");
    p.className = "placeholder";
    p.textContent = state.active ? "Listening…" : `Press Start (${state.settings?.hotkeyToggle || "Start"}) to begin captioning.`;
    ui.captions.append(p);
    return;
  }
  all.forEach((text, i) => {
    const div = document.createElement("div");
    div.className = "line" + (i < all.length - 1 ? " old" : "");
    if (i === all.length - 1 && state.active && state.inFlight > 0) div.classList.add("pending");
    div.textContent = text;
    ui.captions.append(div);
  });
  ui.captions.scrollTop = ui.captions.scrollHeight;
}

// ------------------------------------------------------------ status

const ACK_TEXT: Partial<Record<AckResult, string>> = {
  no_field: "No text field focused",
  password_field: "Password field — not typing",
  restricted_page: "Can't type on this Chrome page",
  no_tab: "No active Chrome tab",
  error: "Typing into Chrome failed",
};

function statusInfo(): { kind: string; text: string } {
  const now = Date.now();
  if (!state.active) {
    if (state.banner?.error) return { kind: "error", text: "Error" };
    return { kind: "idle", text: "Idle" };
  }
  if (state.capture?.state === "error") return { kind: "error", text: state.capture.message };
  if (state.capture?.state === "waiting") return { kind: "warn", text: state.capture.message };
  if (state.capture?.state === "finished" && state.inFlight === 0) return { kind: "listening", text: state.capture.message };
  if (state.transient && state.transient.until > now) return { kind: "warn", text: state.transient.text };
  const ack = state.lastAck;
  if (ack && ack.result !== "inserted" && ack.result !== "inactive" && now - ack.at < 4000) {
    return { kind: "warn", text: ACK_TEXT[ack.result] ?? "Not typing" };
  }
  if (ack?.result === "inserted" && now - ack.at < 2500) return { kind: "typing", text: "Typing to Chrome" };
  if (state.inFlight > 0) return { kind: "transcribing", text: "Transcribing" };
  return { kind: "listening", text: "Listening" };
}

function render(): void {
  const s = state.settings;
  const st = statusInfo();
  ui.status.dataset.kind = st.kind;
  ui.statusText.textContent = st.text;
  ui.overlay.classList.toggle("active", state.active);
  ui.overlay.classList.toggle("attention", !!state.banner);

  ui.toggle.innerHTML = state.active ? `${icon("stop")}<span>Stop</span>` : `${icon("play")}<span>Start</span>`;
  ui.toggle.classList.toggle("live", state.active);
  ui.toggle.title = `${state.active ? "Stop" : "Start"} captioning${s?.hotkeyToggle ? ` (${s.hotkeyToggle})` : ""}`;

  // Audio source chip
  if (state.testAudio) {
    ui.chipSource.className = "chip ok";
    ui.chipSource.innerHTML = `${icon("graphicEq")}<span>Test audio</span>`;
    ui.chipSource.title = `Test audio file: ${state.testAudio}`;
  } else if (s?.captureMode === "system") {
    ui.chipSource.className = "chip ok";
    ui.chipSource.innerHTML = `${icon("graphicEq")}<span>System audio</span>`;
    ui.chipSource.title = "Capturing all system audio";
  } else {
    const ok = state.jump.detected;
    ui.chipSource.className = `chip ${ok ? "ok" : "warn"}`;
    ui.chipSource.innerHTML = `${icon("graphicEq")}<span>${ok ? "Jump Desktop" : "Jump Desktop not detected"}</span>`;
    ui.chipSource.title = ok
      ? `Capturing ${state.jump.process ?? "Jump Desktop"} (PID ${state.jump.pid ?? "?"}) only`
      : state.jump.supported
        ? "Start Jump Desktop, or switch Settings → Capture mode to All system audio"
        : "Per-app capture is available on Windows only";
  }

  // Chrome chip
  if (!s?.typeIntoChrome) {
    ui.chipChrome.className = "chip off";
    ui.chipChrome.innerHTML = `${icon("keyboardOff")}<span>Typing off</span>`;
  } else if (state.bridge.clients > 0) {
    ui.chipChrome.className = "chip ok";
    ui.chipChrome.innerHTML = `${icon("link")}<span>Chrome</span>`;
  } else {
    ui.chipChrome.className = "chip warn";
    ui.chipChrome.innerHTML = `${icon("linkOff")}<span>Chrome offline</span>`;
  }
  ui.chipChrome.title = `${s?.typeIntoChrome ? "Typing into Chrome is ON" : "Typing into Chrome is OFF"}${
    state.bridge.error ? ` — ${state.bridge.error}` : state.bridge.clients ? " — extension connected" : " — extension not connected"
  }. Click to toggle${s?.hotkeyTyping ? ` (${s.hotkeyTyping})` : ""}.`;

  // Banner
  const b = state.banner;
  ui.banner.hidden = !b;
  if (b) {
    ui.banner.classList.toggle("error", !!b.error);
    ui.bannerText.textContent = b.text;
    ui.bannerAction.hidden = !b.action;
    ui.bannerAction.textContent = b.action?.label ?? "";
  }
  renderCaptions();
  renderDebug();
}

function renderDebug(): void {
  const show = !!state.settings?.showDebug;
  ui.debug.hidden = !show;
  if (!show) return;
  const st = state.stats;
  const sec = (ms: number) => (ms / 1000).toFixed(2) + " s";
  const prof = state.settings ? profileFor(state.settings.priority, state.settings.model) : null;
  ui.debug.textContent = st && st.chunks
    ? `${prof?.model} · chunk ${st.avgChunkSec.toFixed(1)} s · API ${sec(st.avgApiMs)} · end→text ${sec(st.avgEndToTextMs)} ` +
      `(p90 ${sec(st.p90EndToTextMs)}) · avg speech→text ${sec(st.avgWordDelayMs)} · in-flight ${st.inFlight} · ` +
      `chunks ${st.chunks} · silent skipped ${st.skippedSilent} · filtered ${st.filtered} · failed ${st.failed}`
    : `${prof?.model ?? ""} · debug: waiting for speech…`;
}

function setBanner(b: Banner): void {
  state.banner = b;
  render();
}

function clearBannerIf(pred: (b: Banner) => boolean): void {
  if (state.banner && pred(state.banner)) setBanner(null);
}

function flash(text: string, ms = 3500): void {
  state.transient = { text, until: Date.now() + ms };
  render();
  setTimeout(render, ms + 50);
}

// -------------------------------------------------------- accuracy test

/** After a test file ends and all requests finished, report WER and delay. */
function maybeReportTest(): void {
  if (!state.active || !state.testFinishedAt || state.inFlight > 0) return;
  if (Date.now() - state.testFinishedAt < 3000) return;
  state.testFinishedAt = 0;
  const st = state.stats;
  const delay = st && st.chunks
    ? `avg speech→text ${(st.avgWordDelayMs / 1000).toFixed(2)} s, end→text ${(st.avgEndToTextMs / 1000).toFixed(2)} s (p90 ${(st.p90EndToTextMs / 1000).toFixed(2)} s), API ${(st.avgApiMs / 1000).toFixed(2)} s`
    : "no speech recognised";
  let text = `Test finished: ${delay}.`;
  if (state.reference) {
    const r = wordErrorRate(state.reference, state.sessionText);
    text =
      `Accuracy test: ${((1 - r.wer) * 100).toFixed(1)}% accuracy (WER ${(r.wer * 100).toFixed(1)}% over ` +
      `${r.referenceWords} words: ${r.substitutions} substituted, ${r.deletions} missed, ${r.insertions} extra). ${delay}.`;
  }
  console.info(text, "\nHypothesis:", state.sessionText.trim());
  if (state.settings?.saveTranscript) void backend.transcriptAppend(`[${clock()}] ${text}`).catch(() => {});
  setBanner({ text });
}

// ------------------------------------------------------------ helpers

const pad = (n: number) => String(n).padStart(2, "0");
function clock(d = new Date()): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fileStamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function applyAppearance(s: Settings): void {
  ui.overlay.style.setProperty("--bg-alpha", String(s.bgOpacity));
  ui.overlay.style.setProperty("--caption-size", `${s.fontSize}px`);
}

async function applySettings(next: Settings): Promise<void> {
  const prev = state.settings;
  state.settings = next;
  applyAppearance(next);
  if (!pipeline) pipeline = createPipeline(next);
  else pipeline.configure(pipelineConfig(next));
  if (state.active && prev) {
    if (prev.typeIntoChrome !== next.typeIntoChrome) {
      void backend.setCaptioning(true, next.typeIntoChrome, state.session);
    }
    // A different audio source needs a fresh capture session.
    if (prev.captureMode !== next.captureMode || prev.jumpProcessNames !== next.jumpProcessNames) {
      stop();
      void start(false);
    }
  }
  render();
}

// ------------------------------------------------------------- wiring

function noFocus(el: HTMLElement): void {
  // Keep clicks from moving focus inside the web view.
  el.addEventListener("mousedown", (e) => e.preventDefault());
}

function wireUi(): void {
  ui.settings.innerHTML = icon("settings");
  ui.hide.innerHTML = icon("minimize");
  ui.bannerClose.innerHTML = icon("close");
  for (const b of [ui.toggle, ui.settings, ui.hide, ui.chipChrome, ui.bannerAction, ui.bannerClose]) noFocus(b);

  ui.toggle.addEventListener("click", () => toggle(true));
  ui.settings.addEventListener("click", () => void backend.openSettings());
  ui.hide.addEventListener("click", () => void backend.hideOverlay());
  ui.bannerAction.addEventListener("click", () => state.banner?.action?.run());
  ui.bannerClose.addEventListener("click", () => setBanner(null));
  ui.chipChrome.addEventListener("click", () => {
    if (!state.settings) return;
    void backend
      .saveSettings({ ...state.settings, typeIntoChrome: !state.settings.typeIntoChrome })
      .then(applySettings)
      .catch((e) => flash(errorText(e)));
  });

  const win = getCurrentWindow();
  document.querySelectorAll<HTMLElement>(".resize").forEach((h) => {
    h.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      void win.startResizeDragging(h.dataset.dir as Parameters<typeof win.startResizeDragging>[0]);
    });
  });
  // Re-evaluate time-based status (ack/transient) once per second.
  setInterval(() => {
    if (!state.active) return;
    maybeReportTest();
    render();
  }, 1000);
}

async function main(): Promise<void> {
  wireUi();
  const [settings, info, bridge, jump] = await Promise.all([
    backend.getSettings(),
    backend.appInfo(),
    backend.bridgeStatus(),
    backend.jumpStatus(),
  ]);
  state.testAudio = info.testAudio ?? null;
  state.reference = info.testReference ?? null;
  state.fakeStt = info.fakeStt;
  state.bridge = bridge;
  state.jump = jump;
  await applySettings(settings);
  if (info.hotkeyErrors.length) flash(info.hotkeyErrors.join("; "), 8000);

  await Promise.all([
    on<Settings>("settings-changed", (s) => void applySettings(s)),
    on<BridgeStatus>("bridge-status", (s) => {
      state.bridge = s;
      render();
    }),
    on<JumpStatus>("jump-status", (s) => {
      state.jump = s;
      render();
    }),
    on<CaptureStatus>("capture-status", (s) => {
      if (!state.active) return;
      if (s.state === "finished") state.testFinishedAt = Date.now();
      state.capture = s;
      render();
    }),
    on<BridgeAck>("bridge-ack", (ack) => {
      if (!state.active || ack.session !== state.session) return;
      state.lastAck = { result: ack.result, at: Date.now() };
      render();
    }),
    on("toggle-captioning", () => toggle(false)),
    on("puter-status-request", () => publishPuter()),
    on("puter-sign-out", async () => {
      stop();
      await window.puter?.auth.signOut();
      await refreshPuter();
      showSignInBanner();
    }),
  ]);
  render();
  if (state.fakeStt) {
    setBanner({ text: "Offline test mode (LCO_FAKE_STT=1): placeholder text instead of real transcription." });
    return;
  }
  await initPuter();
}

void main();

// Caption overlay window: owns the captioning session (Start/Stop), runs the
// transcription pipeline, renders captions and forwards text to Chrome.

import "./styles/overlay.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { backend, broadcast, errorText, newAudioChannel, on } from "./lib/backend.ts";
import type { AckResult, BridgeAck, BridgeStatus, CaptureStatus, JumpStatus, PuterStatus, Settings } from "./lib/types.ts";
import { CaptionPipeline, type PipelineConfig, type PipelineStats } from "./pipeline/pipeline.ts";
import { modelLabel, profileFor } from "./pipeline/profile.ts";
import { fakeTranscribe } from "./pipeline/fake-stt.ts";
import { classifyError, loadPuter, onModelFallback, transcribeWithPuter, warmUpPuter } from "./pipeline/puter.ts";
import { TypingPlanner } from "./pipeline/typing.ts";
import { wordErrorRate } from "./pipeline/wer.ts";
import { CaptionView } from "./ui/captions.ts";
import { icon } from "./ui/icons.ts";

// ------------------------------------------------------------------ state

const ui = {
  overlay: document.getElementById("overlay")!,
  status: document.getElementById("status")!,
  statusText: document.getElementById("status-text")!,
  chipSource: document.getElementById("chip-source") as HTMLButtonElement,
  chipChrome: document.getElementById("chip-chrome") as HTMLButtonElement,
  toggle: document.getElementById("btn-toggle") as HTMLButtonElement,
  copy: document.getElementById("btn-copy") as HTMLButtonElement,
  clear: document.getElementById("btn-clear") as HTMLButtonElement,
  settings: document.getElementById("btn-settings") as HTMLButtonElement,
  hide: document.getElementById("btn-hide") as HTMLButtonElement,
  banner: document.getElementById("banner")!,
  bannerText: document.getElementById("banner-text")!,
  bannerAction: document.getElementById("banner-action") as HTMLButtonElement,
  bannerClose: document.getElementById("banner-close") as HTMLButtonElement,
  captions: document.getElementById("captions")!,
  jumpLatest: document.getElementById("jump-latest") as HTMLButtonElement,
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
  transient: null as { text: string; until: number; kind: "info" | "warn" } | null,
  banner: null as Banner,
  stats: null as PipelineStats | null,
};

// ------------------------------------------------------------ pipeline

function pipelineConfig(s: Settings): PipelineConfig {
  return {
    profile: profileFor(s.priority, s.model),
    language: s.language,
    useContextPrompt: s.useContextPrompt,
    maxParallel: s.maxParallel,
    livePreview: s.livePreview,
  };
}

let pipeline: CaptionPipeline | null = null;

/** Sends final text (and, with live typing, the provisional tail) to Chrome. */
const typing = new TypingPlanner(
  (m) => {
    if (state.active && state.settings?.typeIntoChrome) void backend.bridgeSendText(state.session, m.seq, m.text, m.provisional);
  },
  () => !!state.settings?.livePreview && !!state.settings?.typePreview,
);

function createPipeline(s: Settings): CaptionPipeline {
  return new CaptionPipeline(pipelineConfig(s), state.fakeStt ? fakeTranscribe : transcribeWithPuter, {
    onText: (text) => {
      if (!state.active) return;
      state.sessionText += ` ${text}`;
      captions.append(text);
      typing.final(text);
      if (state.settings?.saveTranscript) void backend.transcriptAppend(`[${clock()}] ${text}`).catch(() => {});
    },
    onPreview: (text) => {
      captions.setPreview(state.active ? text : "");
      typing.previewChanged(state.active ? text : "");
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
      } else if (err.kind === "rate_limit") {
        flash("Puter's request limit was reached — skipped a chunk");
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

  captions.addSeparator(`Started ${clock()}`);
  state.active = true;
  state.session = Date.now();
  state.capture = null;
  state.lastAck = null;
  state.sessionText = "";
  state.testFinishedAt = 0;
  clearBannerIf((b) => !b?.error);
  pipeline?.reset();
  typing.reset();
  render(); // instant feedback

  const session = state.session;
  const s = state.settings;
  void backend.setCaptioning(true, s.typeIntoChrome, session);
  // Free test-mode request so the first real one doesn't pay for connection setup.
  if (!state.fakeStt) void warmUpPuter();

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
  typing.reset();
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

const captions = new CaptionView(ui.captions, ui.jumpLatest);

function renderCaptions(): void {
  captions.setPlaceholder(
    state.active ? "Listening…" : `Press Start (${state.settings?.hotkeyToggle || "Start"}) to begin captioning.`,
  );
  captions.setPending(state.active && state.inFlight > 0);
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
  const transient = state.transient && state.transient.until > now ? state.transient : null;
  if (!state.active) {
    if (transient) return { kind: transient.kind, text: transient.text };
    if (state.banner?.error) return { kind: "error", text: "Error" };
    return { kind: "idle", text: "Idle" };
  }
  if (state.capture?.state === "error") return { kind: "error", text: state.capture.message };
  if (state.capture?.state === "waiting") return { kind: "warn", text: state.capture.message };
  if (state.capture?.state === "finished" && state.inFlight === 0) return { kind: "listening", text: state.capture.message };
  if (transient) return { kind: transient.kind, text: transient.text };
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
    ? `${modelLabel(prof?.model ?? "")} · chunk ${st.avgChunkSec.toFixed(1)} s · API ${sec(st.avgApiMs)} · end→text ${sec(st.avgEndToTextMs)} ` +
      `(p90 ${sec(st.p90EndToTextMs)}) · avg speech→text ${sec(st.avgWordDelayMs)} · in-flight ${st.inFlight} · ` +
      `chunks ${st.chunks}${state.settings?.livePreview ? ` · previews ${st.previews}` : ""} · silent skipped ${st.skippedSilent} · filtered ${st.filtered} · failed ${st.failed}`
    : `${modelLabel(prof?.model ?? "")} · debug: waiting for speech…`;
}

function setBanner(b: Banner): void {
  state.banner = b;
  render();
}

function clearBannerIf(pred: (b: Banner) => boolean): void {
  if (state.banner && pred(state.banner)) setBanner(null);
}

function flash(text: string, ms = 3500, kind: "info" | "warn" = "warn"): void {
  state.transient = { text, until: Date.now() + ms, kind };
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
  ui.copy.innerHTML = icon("copy");
  ui.clear.innerHTML = icon("clearAll");
  ui.settings.innerHTML = icon("settings");
  ui.hide.innerHTML = icon("minimize");
  ui.bannerClose.innerHTML = icon("close");
  // noFocus also keeps the caption selection alive when Copy is clicked.
  for (const b of [ui.toggle, ui.copy, ui.clear, ui.settings, ui.hide, ui.chipChrome, ui.bannerAction, ui.bannerClose]) {
    noFocus(b);
  }

  ui.toggle.addEventListener("click", () => toggle(true));
  ui.copy.addEventListener("click", () => {
    const selected = captions.selectedText();
    const text = selected || captions.allText();
    if (!text) return flash("No captions to copy yet", 2500, "info");
    backend
      .copyText(text)
      .then(() => flash(selected ? "Copied the selected text" : "Copied all captions", 2500, "info"))
      .catch((e) => flash(`Copy failed: ${errorText(e)}`));
  });
  ui.clear.addEventListener("click", () => {
    captions.clear();
    renderCaptions();
    flash("Captions cleared", 2000, "info");
  });
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
  onModelFallback((model) =>
    flash(`Model "${model}" isn't available on Puter, so Puter's default model is used instead.`, 8000),
  );
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

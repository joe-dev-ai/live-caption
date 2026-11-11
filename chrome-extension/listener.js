// @ts-check
/**
 * Live Caption Typer — speech page (the "Chrome" speech engine).
 *
 * Runs Chrome's built-in speech recognition on the audio that the Live
 * Caption Overlay app captures from Jump Desktop. The app streams the audio
 * over the local bridge as binary frames of 16 kHz mono 16-bit PCM; this page
 * turns them into a live MediaStreamTrack, which SpeechRecognition listens to
 * directly (no microphone involved), and sends the recognized text back.
 *
 * The service worker opens this page as a hidden offscreen document while
 * the app captions with the Chrome engine, and closes it on Stop. Chrome on
 * desktop keeps recognizing in hidden pages, and recognizing a track needs no
 * microphone permission.
 */

const SAMPLE_RATE = 16000;
const PING_MS = 20000;
const RECONNECT_MS = 1000;
const MAX_RESTART_MS = 5000;
/**
 * First Chrome version whose SpeechRecognition.start() accepts an audio track.
 * Older versions ignore the track and listen to the microphone instead, which
 * must never happen here.
 */
const MIN_CHROME = 135;
/** Errors that mean the on-device model can't be used here: switch to the online service. */
const ON_DEVICE_ERRORS = ["language-not-supported", "service-not-allowed"];

/** @typedef {"auto" | "online"} SpeechMode "auto": on-device when its model is installed, else online. */
/** @typedef {{ track: MediaStreamTrack, push: (pcm: Int16Array<ArrayBuffer>) => void }} AudioFeed */

/** @type {{ port: number, token: string, mode: SpeechMode }} */
let config = { port: 47821, token: "", mode: "auto" };
/** @type {WebSocket | null} */
let ws = null;
let session = 0;
let lang = "en-US";
let listening = false;
/** Whether recognition runs on-device; decided on each (re)start. */
let onDevice = false;
/** Set once on-device recognition failed on this page. */
let onDeviceFailed = false;
/** @type {AudioFeed | null} */
let feed = null;
/** @type {any} */
let recognition = null;
/** Delay before the next restart; grows only while sessions keep failing. */
let restartMs = 100;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let restartTimer;
/** Words heard but not final yet; kept if Chrome ends the session before finalizing them. */
let interim = "";

const $status = /** @type {HTMLElement} */ (document.getElementById("status"));

/** @param {object} msg */
function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * Tell the app and the service worker (popup, fallback) what recognition is doing.
 * @param {string} state "starting" | "listening" | "error" | "stopped" | "disconnected"
 * @param {string} [detail]
 */
function report(state, detail = "") {
  const mode = onDevice ? "on-device" : "online";
  $status.textContent = `${state} (${mode})${detail ? `: ${detail}` : ""}`;
  send({ type: "listener-status", state, mode, detail });
  chrome.runtime.sendMessage({ type: "listener-status", state, mode, detail }).catch(() => {});
}

// ------------------------------------------------------------------ audio

/** @returns {any} */
const speechRecognitionClass = () =>
  /** @type {any} */ (globalThis).SpeechRecognition ?? /** @type {any} */ (globalThis).webkitSpeechRecognition;

/** A live audio track that plays the PCM packets from the app. @returns {AudioFeed} */
function createFeed() {
  const Generator = /** @type {any} */ (globalThis).MediaStreamTrackGenerator;
  if (Generator) {
    // Chrome's track generator takes the samples as they arrive; no audio
    // output is involved, so autoplay rules can't hold it back.
    const track = new Generator({ kind: "audio" });
    const writer = track.writable.getWriter();
    let frames = 0;
    return {
      track,
      push(pcm) {
        const timestamp = Math.round((frames * 1e6) / SAMPLE_RATE);
        frames += pcm.length;
        const data = new AudioData({
          format: "s16",
          sampleRate: SAMPLE_RATE,
          numberOfFrames: pcm.length,
          numberOfChannels: 1,
          timestamp,
          data: pcm,
        });
        writer.write(data).catch(() => data.close());
      },
    };
  }
  // Fallback: schedule the samples into an AudioContext's stream output.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const destination = context.createMediaStreamDestination();
  let next = 0;
  return {
    track: destination.stream.getAudioTracks()[0],
    push(pcm) {
      if (context.state === "suspended") void context.resume();
      const buffer = context.createBuffer(1, pcm.length, SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      // A small buffer absorbs network jitter; after a gap, start again close to now.
      const now = context.currentTime;
      if (next < now + 0.02 || next > now + 1) next = now + 0.1;
      source.start(next);
      next += buffer.duration;
    },
  };
}

// ------------------------------------------------------------ recognition

/** Whether to recognize on-device: only when wanted and its model for `lang` is installed. */
async function useOnDevice() {
  const SR = speechRecognitionClass();
  if (config.mode !== "auto" || onDeviceFailed || typeof SR?.available !== "function") return false;
  if (!("processLocally" in SR.prototype)) return false;
  try {
    return (await SR.available({ langs: [lang], processLocally: true })) === "available";
  } catch {
    return false;
  }
}

/**
 * Chrome ends recognition sessions now and then (silence, time limits):
 * restart right away. After an error, wait longer each time (0.4 s → 5 s).
 * @param {boolean} afterError
 */
function scheduleRestart(afterError) {
  clearTimeout(restartTimer);
  if (!listening) return;
  restartMs = afterError ? Math.min(MAX_RESTART_MS, restartMs * 4) : 100;
  restartTimer = setTimeout(() => void startRecognition(), restartMs);
}

/** Chrome's major version, or 0 if unknown. */
function chromeVersion() {
  const match = /Chrome\/(\d+)/.exec(navigator.userAgent);
  return match ? Number(match[1]) : 0;
}

async function startRecognition() {
  clearTimeout(restartTimer);
  const SR = speechRecognitionClass();
  if (!SR || chromeVersion() < MIN_CHROME) return report("error", `Chrome ${MIN_CHROME} or later is needed`);
  onDevice = await useOnDevice();
  if (!listening || recognition) return;
  feed ??= createFeed();
  const r = new SR();
  r.lang = lang;
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;
  if (onDevice) r.processLocally = true;
  const owner = session;
  let failed = false;

  r.onstart = () => report("listening");
  r.onresult = (/** @type {any} */ e) => {
    let final = "";
    let pending = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      if (result.isFinal) final += ` ${result[0].transcript}`;
      else pending += ` ${result[0].transcript}`;
    }
    final = final.replace(/\s+/g, " ").trim();
    interim = pending.replace(/\s+/g, " ").trim();
    send({ type: "speech", session: owner, final, interim });
  };
  r.onerror = (/** @type {any} */ e) => {
    // Routine: silence, or our own abort. The session restarts on "end".
    if (e.error === "no-speech" || e.error === "aborted") return;
    if (onDevice && ON_DEVICE_ERRORS.includes(e.error)) {
      onDeviceFailed = true;
      return report("starting", `on-device recognition unavailable (${e.error}), using online recognition`);
    }
    failed = true;
    report("error", e.error);
  };
  r.onend = () => {
    // Chrome ends sessions after a while: keep the words heard so far.
    if (interim && owner === session && listening) send({ type: "speech", session: owner, final: interim, interim: "" });
    interim = "";
    if (recognition === r) recognition = null;
    scheduleRestart(failed);
  };

  try {
    r.start(feed.track);
    recognition = r;
  } catch (e) {
    report("error", e instanceof Error ? e.message : String(e));
    scheduleRestart(true);
  }
}

function stopRecognition() {
  listening = false;
  clearTimeout(restartTimer);
  interim = "";
  const r = recognition;
  recognition = null;
  r?.abort();
}

// ------------------------------------------------------------- connection

/** Captioning state from the app. @param {any} msg */
function onState(msg) {
  const nextSession = Number(msg.session) || 0;
  const nextLang = msg.lang ? String(msg.lang) : lang;
  const changed = nextSession !== session || nextLang !== lang;
  session = nextSession;
  lang = nextLang;
  if (msg.listen && !listening) {
    listening = true;
    restartMs = 100;
    report("starting");
    void startRecognition();
  } else if (msg.listen && changed) {
    // New session or language: start over so no old words leak into it.
    interim = "";
    recognition?.abort();
  } else if (!msg.listen && listening) {
    stopRecognition();
    report("stopped");
  }
}

function connect() {
  const sock = new WebSocket(`ws://127.0.0.1:${config.port}`);
  sock.binaryType = "arraybuffer";
  ws = sock;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let ping;
  sock.onopen = () => {
    // Offscreen documents only get chrome.runtime's messaging, so no getManifest() here.
    sock.send(JSON.stringify({ type: "hello", token: config.token, role: "listener" }));
    ping = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('{"type":"ping"}'), PING_MS);
  };
  sock.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      if (listening) (feed ??= createFeed()).push(new Int16Array(ev.data));
      return;
    }
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type === "welcome" || msg.type === "state") onState(msg);
    else if (msg.type === "auth_error") report("error", "pairing token rejected");
  };
  sock.onclose = () => {
    clearInterval(ping);
    if (ws !== sock) return;
    stopRecognition();
    report("disconnected");
    setTimeout(connect, RECONNECT_MS); // the service worker closes this page when the app goes away
  };
}

async function init() {
  config = { ...config, ...(await chrome.runtime.sendMessage({ type: "listener-config" })) };
  connect();
}

void init();

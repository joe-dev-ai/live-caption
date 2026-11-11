# Live Caption Overlay

Live captions for the audio of a remote computer that you reach with **Jump Desktop**, plus optional
**auto-typing of the captions into the focused text field in Chrome**.

```
Remote computer ──Jump Desktop──▶ Local Windows PC
                                  ├─ Live Caption Overlay (Tauri desktop app)
                                  │    1. WASAPI process loopback: captures only Jump Desktop's audio
                                  │    2. 16 kHz mono PCM → voice-activity chunking (cuts at pauses)
                                  │    3. Puter.js speech-to-text (gpt-transcribe), 3 requests in parallel
                                  │    4. Captions in a transparent, always-on-top overlay
                                  │    5. WebSocket bridge on 127.0.0.1 ──┐
                                  └─ Chrome + "Live Caption Typer" ◀──────┘ types into the focused field
```

| Folder | What it is |
| --- | --- |
| `desktop-app/` | Tauri v2 app: Rust back end (`src-tauri/`) + TypeScript/Vite front end (`src/`) |
| `chrome-extension/` | Manifest V3 companion extension (plain JavaScript, no build step) |

---

## 1. Requirements

**Windows 10 version 2004 (build 19041) or newer, or Windows 11.** Capturing only Jump Desktop's audio uses the
per-process loopback API, which these Windows versions introduced.

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22.18 or newer (LTS) | Vite 8 needs ≥ 20.19. The unit tests use Node's built-in TypeScript support (≥ 22.18). |
| Rust | stable, MSVC toolchain | Install with <https://rustup.rs>, then `rustup default stable-msvc` |
| Microsoft C++ Build Tools | 2022 | In the Visual Studio Installer, select **"Desktop development with C++"** |
| Microsoft Edge WebView2 Runtime | any | Already installed on Windows 11 and up-to-date Windows 10 |
| Google Chrome | 116 or newer | For the typing extension |
| Puter account | free | Speech-to-text runs on Puter's "user-pays" model: you sign in with your own Puter account and usage is billed to it |

The full list of Tauri prerequisites is at <https://v2.tauri.app/start/prerequisites/>.

---

## 2. Desktop app: set up and run

```bash
cd desktop-app
npm install
npm run tauri dev
```

The first `tauri dev` compiles the Rust back end, which takes a few minutes. Later runs are fast.

The app opens **its own window**: a transparent caption bar near the top-left of your main screen, plus a **CC** icon
in the system tray (look under the **^** arrow). It is not a website. The Vite dev server on
`http://127.0.0.1:1420` only feeds that window, and opening it in a normal browser shows an empty bar because the
page needs the desktop app around it.

### Build the installer

```bash
npm run tauri build
```

This builds the installers:

* `desktop-app/src-tauri/target/release/bundle/nsis/Live Caption Overlay_1.0.0_x64-setup.exe`
* `desktop-app/src-tauri/target/release/bundle/msi/Live Caption Overlay_1.0.0_x64_en-US.msi`

---

## 3. Chrome extension: install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `chrome-extension` folder.
4. Optional: pin **Live Caption Typer** in the toolbar so you can see its connection badge.

### Pair the extension with the app (one time)

1. In the overlay, click **⚙ Settings**, then go to **Type into Chrome** and click **Copy** next to the pairing token
   (it looks like `K7QF-M2XP-9WDA-H4TN`).
2. Click the extension icon, paste the token, and click **Save & connect**. Keep the port at 47821 unless you
   changed it in Settings.
3. The popup shows **Connected**, and the overlay's Chrome chip turns green.

The extension stays paired across restarts and reconnects on its own (within about 1–5 s) when the app restarts.
If you click **New token** in Settings, you need to pair again.

Extension icon states:

| Icon / badge | Meaning |
| --- | --- |
| Blue icon, **ON** badge | Connected, captioning is running, and captions are being typed |
| Blue icon, no badge | Connected, captioning is stopped |
| Grey icon | Not connected (the app isn't running) |
| Grey icon, red **!** | Not paired, or the token was rejected |

---

## 4. Using it

### First run

1. Start Jump Desktop and connect to the remote computer.
2. Start Live Caption Overlay. A transparent caption bar appears and a CC icon appears in the system tray.
3. The overlay asks you to **Sign in to Puter**. Click **Sign in**. A Puter window opens; sign in or create a free
   account. You only do this once, because the session is remembered.
   *Tip: use your Puter username or email and password. Google sign-in is sometimes refused inside embedded app
   windows.*

### Captioning and typing

* Click **▶ Start** or press **Ctrl+Alt+Q** (from any app, including Chrome) to start.
* Speech from the remote computer appears as captions within about 2–3 s. The newest line is at the bottom.
* While captioning is running and **Type into Chrome** is on, each finished caption chunk is inserted at the caret
  of the focused field in the active Chrome tab, with spaces added between chunks automatically. Click into a
  chat box or document in Chrome and the text appears there. Enter is never pressed and nothing is submitted.
* Click **■ Stop** or press **Ctrl+Alt+Q** again. Typing stops at once, and any queued or in-flight text is
  discarded.
* Clicking the overlay is designed not to take keyboard focus away from Chrome (see *Known limitations*). For
  hands-free control, use the hotkeys.

### Overlay controls

| Control | Action |
| --- | --- |
| Drag the top bar | Move the window |
| Drag any edge or corner | Resize the window |
| ▶ Start / ■ Stop | Toggle captioning |
| **Chrome** chip | Toggle typing into Chrome (green: extension connected, amber: offline, grey: typing off) |
| **Jump Desktop** chip | Green: Jump Desktop found. Amber: "Jump Desktop not detected" |
| ⚙ | Settings |
| — | Minimize to tray (closing the window also hides it to the tray) |

Status indicator: **Idle**, **Listening**, **Transcribing**, **Typing to Chrome**, **No text field focused**,
**Jump Desktop not detected**, or **Error** with details.

**Tray menu:** Show / Hide, Start / Stop captioning, Settings…, Quit. The tray icon turns red while captioning.
Left-click the tray icon to show or hide the overlay.

### Default hotkeys (change them in Settings)

| Hotkey | Action |
| --- | --- |
| Ctrl+Alt+Q | Start / Stop captioning |
| Ctrl+Alt+H | Show / Hide the overlay |
| Ctrl+Alt+T | Turn typing into Chrome on or off |

---

## 5. Settings

Changes save automatically and apply right away. They are stored in
`%APPDATA%\com.livecaption.overlay\settings.json`. The window size and position are remembered too.

| Section | Setting | Default |
| --- | --- | --- |
| Audio capture | Capture mode: **Jump Desktop only** (process loopback) / **All system audio** (fallback) | Jump Desktop only |
| | Jump Desktop process names (Advanced) | `JumpDesktop.exe, JumpClient.exe, JumpWinClient.exe` |
| Transcription | Language (sent explicitly; no auto-detection) | English |
| | Priority: **Accuracy** (2–5 s chunks) / **Balanced** (1.5–4 s) / **Speed** (1–3 s) | Balanced |
| | Model: **Auto** (Puter's default speech-to-text model, currently `gpt-transcribe`) or `gpt-transcribe`. If Puter refuses a chosen model, the default is used automatically. | Auto |
| | Use recent text as context (sends the last 1–2 sentences as the prompt) | On |
| | Parallel requests (1–4) | 3 |
| Type into Chrome | On/off, pairing token (Copy / New token), local port | On, random token, 47821 |
| Hotkeys | Start/Stop, Show/Hide, Typing on/off (click a field, press the keys; Backspace clears it) | see above |
| Appearance | Font size, background opacity, number of caption lines, debug info | 26 px, 60 %, 4 lines, off |
| Transcript | Save a `.txt` file with timestamps (a new file each time you press Start); folder | Off, `Documents\Live Captions` |
| Puter account | Shows who is signed in; Sign out | — |

**Debug info** adds a line to the overlay showing the model, average chunk length, API time, end-of-chunk→text
delay (average and p90), the average speech→text delay, requests in flight, and how many chunks were skipped
(silent), filtered (hallucinations), or failed. Use it to tune the Priority setting.

---

## 6. How it works

**Audio capture (Rust, `src-tauri/src/audio/`)**

* *Jump Desktop only*: the app finds the Jump Desktop process (the root process whose name matches the list) and
  opens a WASAPI **process loopback** stream on it, including its child processes. Other local sounds are not
  captured. If Jump Desktop isn't running, the status shows "Jump Desktop not detected" and the app keeps checking.
  When Jump Desktop restarts, capture re-attaches on its own.
* *All system audio*: classic WASAPI loopback of the default output device.
* Both request 48 kHz float audio, which is mixed down and resampled (windowed-sinc low-pass) to **16 kHz mono
  16-bit**. It is streamed to the web view in 100 ms packets over a Tauri channel. During silence, when WASAPI
  delivers no packets, the app pads with silent audio so speech chunks still close on time.

**Transcription pipeline (TypeScript, `src/pipeline/`)**

* **VAD and smart chunking** (`vad.ts`, `chunker.ts`): an energy VAD with an adaptive noise floor, applied to
  20 ms frames. A chunk starts at speech onset (with 0.3 s of pre-roll). After the minimum length (≥ 1.5 s), it
  ends at the next natural pause (≥ 300 ms), so a word is never cut in half. A short utterance followed by 0.7 s of
  silence is sent on its own. In the last second before the maximum length (4 s), a short gap between words
  (≥ 120 ms) is also accepted as a cut point. If there is no gap at all, the chunk is cut at the **quietest point
  (60 ms window) in its last 0.5 s**, and the next chunk starts **0.2 s earlier** (overlap). Chunks with less than
  0.25 s of speech are skipped, which saves requests.
* **Normalization and WAV** (`wav.ts`): removes DC offset and applies a gain of up to 12×, bounded by RMS and peak
  so it never clips, then encodes a 16-bit PCM WAV.
* **Puter.js** (`puter.ts`): calls `puter.ai.speech2txt(wav, { language, prompt })`. With Model set to Auto, no model
  is sent, so Puter uses its current default (`gpt-transcribe`). If Puter refuses a chosen model, the app switches to
  the default and says so once; if a model rejects the `prompt` option, the app stops sending it.
* **Parallel and ordered** (`scheduler.ts`): sends up to 3–4 requests at once, numbers them in sequence, and always
  outputs in order. Each request has a 12 s timeout, is retried once, and is then skipped, so the stream never
  stalls.
* **Clean-up** (`postprocess.ts`) does the following:
  * removes common silence hallucinations ("Thank you for watching.", "Subtitles by…", Amara.org,
    "please subscribe", wrong-script output, and prompt echoes),
  * collapses repeated phrases,
  * removes words duplicated by the 0.2 s overlap,
  * drops a wrong sentence-final period at forced cuts,
  * lower-cases common words that continue a sentence,
  * normalizes whitespace and punctuation spacing.

**Bridge and extension**

* The app runs a WebSocket server on **127.0.0.1 only** (`bridge.rs`). Handshakes with any `Origin` other than
  `chrome-extension://…` are rejected, so web pages can't connect. The first message must carry the pairing token
  (compared in constant time, with a delay after a wrong token). Text is forwarded only while typing is active and
  only for the current session id, so nothing from before a Stop can be typed after it.
* The extension's service worker (`background.js`) keeps the connection alive. It pings every 20 s, reconnects
  with back-off, and a 30 s alarm wakes it if Chrome stopped it. For each chunk it finds the frame that holds the
  caret (checking iframes, cross-origin frames, and open shadow DOM too) and calls `content.js`. It applies
  **Stop immediately**, before any queued chunk runs.
* `content.js` types only into `<input type="text|search|email|url">`, `<textarea>`, and `contenteditable`. It
  never types into password fields (including fields with `autocomplete="*password"`), read-only or disabled
  fields, or other elements. It inserts at the caret in this order:
  1. a cancelable `beforeinput` event (for editors that own their model, such as Slate and Lexical);
  2. `document.execCommand('insertText')` (native undo; React, Vue, ProseMirror, and Quill pick it up);
  3. as a fallback, the native value setter plus `input` and `change` events.

---

## 7. Accuracy & latency test (built in)

You can measure word error rate (WER) and delay on your own PC with any clear speech recording. Use a WAV file (any
sample rate, 16/24-bit PCM or 32-bit float) and a text file holding its exact transcript. For example, take a
2-minute LibriVox recording and its text, or record yourself reading a page.

In PowerShell:

```powershell
cd desktop-app
$env:LCO_TEST_AUDIO = "C:\tests\speech.wav"       # played in real time instead of live capture
$env:LCO_TEST_REFERENCE = "C:\tests\speech.txt"   # reference transcript for the WER
npm run tauri dev
```

Turn on **Settings → Show debug info**, then press **Start**. When the file ends and the last request returns, the
overlay shows a line like this:

> Accuracy test: 96.8 % accuracy (WER 3.2 % over 312 words: 6 substituted, 2 missed, 2 extra).
> avg speech→text 2.31 s, end→text 1.12 s (p90 1.60 s), API 0.98 s.

WER is case- and punctuation-insensitive. Numbers written differently ("12" vs "twelve") count as errors, so
transcripts that spell numbers out compare more fairly. The typing path works during the test too, so you can watch
the text arrive in Chrome.

**Offline test mode.** Set `$env:LCO_FAKE_STT = "1"` to replace Puter with a placeholder transcriber that outputs
`Test chunk N (x.x s).` for each chunk. Combined with `LCO_TEST_AUDIO`, this tests capture, chunking, captions, and
Chrome typing without a Puter account or credits.

## 8. Developer tests

```bash
# Front end: VAD/chunking, post-processing, ordered scheduler, WAV, WER, pipeline, Puter wrapper (39 tests)
cd desktop-app
npm test
npm run typecheck

# Back end: resampler, PCM packetising, settings, WebSocket bridge integration tests (14 tests)
cd src-tauri
cargo test

# Run only the WebSocket bridge (no UI/audio) to try the extension by hand:
cargo run --example bridge_server -- 47821 TEST-TOKE-N123-4567
#   then type:  start 1   |   text 1 Hello world.   |   stop
```

---

## 9. Known limitations

* **Delay comes from chunking.** Puter's speech-to-text takes whole files, not a live stream, so text appears after
  each chunk ends: typically 2–3 s from speech to text (chunk length + about 1 s API time). Use **Speed** priority
  for less delay, or **Accuracy** for longer chunks with more context.
* **Puter sign-in and usage.** You need a Puter account. Usage is billed to it under Puter's user-pays model, and
  if your Puter credits or limits run out, captioning stops with a message. The app needs internet access
  (`js.puter.com`, `api.puter.com`, `puter.com`).
* **Accuracy depends on audio quality.** Jump Desktop's audio codec, background music, overlapping speakers, and
  very quiet audio all reduce accuracy. The energy-based VAD can mistake steady loud music for speech, in which case
  the model may transcribe lyrics or nothing.
* **Per-app capture is Windows-only.** It needs Windows 10 2004+ or Windows 11. macOS (ScreenCaptureKit) and Linux
  capture are not implemented; on those systems only the `LCO_TEST_AUDIO` file source works. If your Jump Desktop
  executable has a different name, add it under Settings → Audio capture → Advanced (check Task Manager → Details).
* **Memory.** The Rust process is small, but the system web view (WebView2 on Windows) takes most of the
  memory. Expect roughly 100–170 MB in total across the app and its web view processes, more than the
  100 MB goal. CPU use while idle is about 0 %.
* **Focus.** The overlay is a non-activating window, and the app also returns focus to the previous window if the
  overlay ever becomes the foreground window. Chrome may still flicker briefly on some systems. The hotkeys avoid
  this completely.
* **Chrome typing can't reach every page.** Chrome doesn't allow extensions on `chrome://` pages, the Chrome Web
  Store, or the built-in PDF viewer. Some canvas-based editors (for example Google Docs' canvas mode) may not
  accept inserted text. Closed shadow roots can't be reached.
* **Hallucination filter.** It removes phrases such as "Thanks for watching!" even when someone really says them.
* The transcript is plain text in the selected folder. The pairing token is stored in plain text in
  `settings.json` and in the extension's local storage.

## 10. Troubleshooting

| Problem | Fix |
| --- | --- |
| `program not found` when running `npm run tauri dev` | Rust isn't installed or isn't on PATH. Install the C++ Build Tools and Rust (see Requirements), restart Windows, and check `cargo --version`. |
| `tauri dev` keeps printing "Waiting for your frontend dev server" | Make sure `desktop-app/vite.config.ts` has `host: "127.0.0.1"` and `tauri.conf.json` has `"devUrl": "http://127.0.0.1:1420"`, and that nothing else uses port 1420. |
| `http://localhost:1420` in a browser shows an empty bar | Expected: the UI only works inside the app window. Look for the caption bar on screen and the CC tray icon. |
| "Jump Desktop not detected" | Make sure Jump Desktop is running and connected. Check its process name in Task Manager → Details and add it under Settings → Audio capture → Advanced. Or switch to **All system audio**. |
| No captions, status says Listening | Check that the remote computer's audio plays locally through Jump Desktop, not on the remote machine. Check that Jump Desktop isn't muted in the Windows volume mixer. Try All system audio. |
| Chrome chip says "Chrome offline" | Make sure the extension is installed and paired. Click its icon, then **Reconnect**. If you changed the port, enter the same port in the popup. |
| "Cannot listen on 127.0.0.1:47821" | Another program uses the port. Change Settings → Type into Chrome → Local port, and enter the same port in the popup. |
| "No text field focused" | Click into a text box in the active Chrome tab. Password fields are never typed into. |
| Hotkey doesn't work, or Settings says it "is already used by another program" | Another program owns that combination. Pick a different one in Settings → Global hotkeys (click the field, press the keys). Use Ctrl/Alt/Shift/Win plus a key; plain keys such as Tab can't be global hotkeys. On keyboards where AltGr = Ctrl+Alt (e.g. German), avoid Ctrl+Alt combinations that type characters, such as Ctrl+Alt+Q (@). |

## Credits

* Icons: [Material Symbols](https://fonts.google.com/icons) (Apache License 2.0), inlined as SVG.
* Speech-to-text: [Puter.js](https://developer.puter.com/) `puter.ai.speech2txt()`.
* Built with [Tauri 2](https://v2.tauri.app/), [wasapi-rs](https://github.com/HEnquist/wasapi-rs), and
  [tokio-tungstenite](https://github.com/snapview/tokio-tungstenite).

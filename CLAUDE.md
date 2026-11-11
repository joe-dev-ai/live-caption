# CLAUDE.md — Live Caption Overlay

Rules for anyone (human or AI) changing this repository. They come from the original product brief and the owner's
git policy. If a request conflicts with them, stop and ask the owner before going ahead.

## 1. What this project is

The project is a lightweight Windows desktop utility plus a companion Chrome extension:

1. It captures the audio that **Jump Desktop** streams from a remote computer and plays on this PC.
2. It transcribes that audio with high accuracy and low delay using the **Puter.js** speech-to-text API.
3. It shows live captions in a **transparent, always-on-top overlay** window.
4. While captioning is running, it **types the finalized text into the focused input or textarea of the active Chrome
   tab** through the companion extension.

Flow: remote computer → Jump Desktop → local PC → capture → chunk → Puter STT → overlay + Chrome extension.

## 2. Repository layout

| Path | Responsibility |
| --- | --- |
| `desktop-app/src-tauri/src/audio/` | Rust audio capture: WASAPI process loopback (Jump Desktop) and system loopback, resampling to 16 kHz mono 16-bit PCM, WAV test source |
| `desktop-app/src-tauri/src/bridge.rs` | Rust WebSocket bridge to the extension (127.0.0.1 only, pairing token) |
| `desktop-app/src-tauri/src/{lib,settings,tray,focus,process,transcript}.rs` | Tauri commands, settings persistence, tray, focus guard, Jump Desktop process lookup, transcript file |
| `desktop-app/src/pipeline/` | Front-end transcription pipeline: VAD, chunker, WAV encoding, Puter wrapper, ordered scheduler, post-processing, WER. Pure TypeScript with **no Tauri imports**, so it stays unit-testable |
| `desktop-app/src/main.ts`, `settings-main.ts`, `styles/`, `ui/` | Overlay UI and settings window |
| `desktop-app/tests/` | Front-end unit tests (`node --test`) |
| `desktop-app/src-tauri/tests/`, `examples/` | Rust integration tests and the standalone bridge server |
| `chrome-extension/` | Manifest V3 extension: `background.js`, `content.js`, popup |

Keep this separation. New code goes into the layer it belongs to: Rust capture, WebSocket bridge, front-end
pipeline, UI, or extension.

## 3. Fixed technology decisions

* **Desktop app:** Tauri v2 (Rust back end + system web view). Front end: TypeScript + Vite, vanilla. No UI
  frameworks or heavy UI libraries.
* **Speech-to-text:** **Puter.js only**, loaded from `https://js.puter.com/v2/` and called through
  `puter.ai.speech2txt()`.
  * Never add a local speech-recognition model or another STT provider.
  * Input is WAV chunks: Puter has no live streaming.
  * Sign-in uses Puter's "user-pays" popup flow and must stay clear and explicit in the UI.
* **Models:** `gpt-4o-transcribe` is the default. `gpt-4o-mini-transcribe` is the faster option. `whisper-1` is
  allowed.
* **Chrome extension:** Manifest V3, plain JavaScript with `// @ts-check` and JSDoc types. It is loaded unpacked
  with **no build step**.
  * Never add `package.json` or `node_modules` to `chrome-extension/`: Chrome refuses extensions that contain names
    starting with `_`.
  * `content.js` must not use `chrome.*` APIs, so it keeps working in already-open tabs after an update.
* **UI style:** Material Design 3 tokens, with Material Symbols inlined as SVG in `src/ui/icons.ts`. Use no icon fonts
  and no CDN assets except Puter.js.
* **Target OS:** Windows 10 2004+ / Windows 11. Default caption language: English (`en`).

## 4. Product requirements that must never regress

**Audio capture**
* There are two modes: *Jump Desktop only* (WASAPI process loopback on the Jump Desktop process tree, the default)
  and *All system audio* (fallback). Show "Jump Desktop not detected" when its process is not running.
* Output is 16 kHz mono 16-bit PCM, sent in 100 ms packets. During silence, pad with silent audio so chunks still close
  on time.

**Transcription pipeline**
* Targets: 95%+ accuracy on clear speech, and about 2–3 s from speech to text.
* Smart chunking cuts at natural pauses and never in the middle of a word. Chunks are 1.5 s minimum and 4 s maximum.
  Near the maximum, cut at a word gap. With no gap at all, cut at the quietest point in the last 0.5 s and repeat
  0.2 s of overlap, then remove the duplicated words afterwards.
* Pass the last 1–2 sentences as the `prompt` context, and drop the prompt quietly if the provider rejects it. Always
  set the language explicitly. Apply light normalization. Skip silent chunks.
* Run 3–4 requests in parallel with sequence numbers, and always output in order. Retry a request once, then skip it.
  The UI must never freeze.
* Clean the output: fix spacing, punctuation and capitalization across chunk boundaries, and filter hallucinations
  ("Thank you for watching.", "Subtitles by…", repeated phrases).
* The Priority setting (Accuracy / Balanced / Speed) controls the model and the chunk lengths (`profile.ts`).

**Typing into Chrome**
* Text is inserted only while captioning is ON and **Type into Chrome** is enabled.
* **Stop halts insertion immediately.** Nothing queued or in flight may be typed after Stop. This is enforced with
  session ids in three places (overlay, bridge, extension), so keep all three checks.
* Allowed targets: `input[type=text|search|email|url]`, `textarea`, and `contenteditable`. Never type into password
  fields (including fields with `autocomplete="*password"`), read-only or disabled fields, or non-editable elements.
  Report "No text field focused".
* Insert at the caret and add a separating space automatically. Insertion order:
  1. a cancelable `beforeinput` for contenteditable;
  2. `document.execCommand('insertText')`;
  3. as a fallback, the native value setter plus `input` and `change` events.

  This keeps React, Vue, Slate, Lexical, ProseMirror and Quill working.
* **Never press Enter and never submit forms.**
* The bridge binds to **127.0.0.1 only**. It rejects any `Origin` other than `chrome-extension://`, requires the pairing
  token (constant-time comparison), auto-reconnects, and shows connection status in the app and in the extension
  icon.

**Window, tray and focus**
* The overlay is frameless, transparent, adjustable in opacity, always on top, resizable from all edges, and
  draggable by the top bar. Size, position and settings are remembered between launches.
* The overlay must **never steal keyboard focus from Chrome**: keep `focusable(false)` and the Windows focus guard.
  Global hotkeys are configurable (default Ctrl+Alt+S for Start/Stop).
* Tray menu: Show/Hide, Start/Stop, Settings, Quit. Closing the window hides it to the tray. The tray icon changes
  while captioning is active.

**Performance**
* Low memory (target about 100 MB idle) and low CPU. Start/Stop reacts in under 100 ms. The debug view shows the
  average speech-to-text delay.

## 5. Code quality rules

Code quality has to be right on every commit; there are no "fix later" commits.

* TypeScript is `strict`, with no implicit `any` and no unused locals or parameters.
* Front-end code uses **erasable syntax only**, because the unit tests run through Node's type stripping: no `enum`,
  no `namespace`, no constructor parameter properties. Relative imports use the `.ts` extension.
* Rust must be `cargo fmt` clean (`rustfmt.toml`, 120 columns) and `cargo clippy` clean on **both** Linux and the
  Windows target. Windows-only code lives behind `#[cfg(windows)]`.
* Comment the *why*, keep functions small and typed, and write no dead code.
* **Do not add dependencies** unless they are clearly needed and used. Remove dependencies that become unused.
* Every behavior change comes with a new or updated test (`desktop-app/tests/`, Rust unit tests, or
  `src-tauri/tests/`).
* Never commit secrets, pairing tokens, `node_modules`, `dist`, `target`, `src-tauri/gen` or ZIP archives.
* The word "sprint" must never appear in code comments (or in commit messages, see §7).

## 6. Quality gates: all must pass before every commit

```bash
# Front end (from desktop-app/)
npm ci                 # first time only
npm run typecheck      # tsc for src and tests
npm test               # node --test unit tests
npm run build          # tsc + vite build, no warnings

# Rust (from desktop-app/src-tauri/)
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
# Windows-only code when you are not on Windows (once: rustup target add x86_64-pc-windows-msvc)
cargo clippy --target x86_64-pc-windows-msvc --all-targets -- -D warnings

# Extension syntax (from the repository root)
for f in chrome-extension/*.js; do node --check "$f"; done

# Forbidden word in code comments / sources (must print nothing)
git grep -n -i -w sprint -- . ':!CLAUDE.md'
```

If any gate fails, fix the cause. Do not commit around it, skip tests, or turn off lints.

## 7. Git rules (mandatory for every commit and push)

### Branch
* The working branch is **`dev`**. Commit to `dev` and push with `git push origin dev`.
* Never commit to or push to `main` directly. Never force-push or rewrite published history without the owner's
  explicit approval.

### Identity: author and committer must both be exactly this

| Field | Value |
| --- | --- |
| Author name / Committer name | `joeetzkorn` |
| Author email / Committer email | `joeetzkorn77@gmail.com` |

```bash
git config user.name  "joeetzkorn"
git config user.email "joeetzkorn77@gmail.com"
```

### Unsigned commits (no GPG or SSH signature)
* Every commit must be **unsigned**. Some environments turn on signing globally, so turn it off in the repository's
  own config, which wins over the global one:

  ```bash
  git config commit.gpgsign false
  git config tag.gpgsign false
  ```

* Never pass `-S` / `--gpg-sign`.
* Why: GitHub shows the **"Unverified"** badge when a commit carries a signature it can't match to the account.
  Unsigned commits show no badge, as long as **Settings → SSH and GPG keys → "Flag unsigned commits as unverified"**
  (vigilant mode) is off on the GitHub account.

### Commit message format
* Format: `<type>(<scope>): <description>`. The scope is optional.
* Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
* Suggested scopes: `audio`, `bridge`, `pipeline`, `overlay`, `settings`, `tray`, `hotkeys`, `extension`, `tauri`,
  `deps`.
* The message is **exactly one sentence on one line**: no body, no trailers, no blank lines.
* Write it professionally, like a senior developer: imperative mood ("add", "fix", "handle"), lower-case first word
  after the colon, no trailing period, at most 72 characters, describing the actual change.
* Examples:
  * `feat(tools): add tool checkout 4-stage flow`
  * `fix(auth): handle expired PIN lockout correctly`
  * `docs: update API swagger descriptions`

### Forbidden in commit messages
* Any session link related to Claude (for example `claude.ai/...` URLs), any other AI session link, or any URL at all.
* `Co-Authored-By:`, `Generated with …`, or any other AI-attribution trailer.
* The word "sprint".

### Verify before every push

Run this after committing; it must print `OK`.

```bash
msg="$(git log -1 --format=%B)"
[ "$(printf '%s\n' "$msg" | sed '/^[[:space:]]*$/d' | wc -l)" -eq 1 ] \
  && printf '%s' "$msg" | grep -Eq '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?: [a-z0-9].{0,70}[^.]$' \
  && ! printf '%s' "$msg" | grep -Eq '[.!?] ' \
  && ! printf '%s' "$msg" | grep -Eqi 'sprint|https?://|claude\.(ai|com)|co-authored-by|generated with' \
  && [ "$(git log -1 --format='%an|%ae|%cn|%ce')" = 'joeetzkorn|joeetzkorn77@gmail.com|joeetzkorn|joeetzkorn77@gmail.com' ] \
  && ! git cat-file -p HEAD | grep -q '^gpgsig' \
  && [ "$(git rev-parse --abbrev-ref HEAD)" = dev ] \
  && echo OK
```

If it fails, fix the commit before pushing: `git commit --amend` (unsigned) for the message or identity, or move the
commit to `dev`.

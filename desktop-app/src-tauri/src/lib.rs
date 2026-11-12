//! Live Caption Overlay — Tauri backend.
//!
//! Module map:
//! * `audio`      – loopback capture (WASAPI) → 16 kHz mono PCM packets
//! * `bridge`     – 127.0.0.1 WebSocket server for the Chrome extension
//! * `settings`   – persisted settings
//! * `tray`       – tray icon + menu
//! * `focus`      – keeps Chrome focused when the overlay is clicked (Windows)
//! * `clipboard`  – copies captions with the overlay as clipboard owner (Windows)
//! * `transcript` – optional .txt transcript
//!
//! Speech-to-text itself runs in the Chrome extension (Chrome engine) or in
//! the overlay web view (Puter engine).

mod audio;
pub mod bridge;
mod clipboard;
#[cfg(windows)]
mod focus;
mod process;
mod settings;
mod transcript;
mod tray;

use audio::{CaptureHandle, CaptureStatus, Source};
use bridge::{Bridge, BridgeStatus};
use serde::Serialize;
use settings::{CaptureMode, Engine, Settings};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};
#[cfg(not(windows))]
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use transcript::Transcript;

/// Test switches (see README → "Accuracy & latency test"):
/// replace live capture with a WAV file played in real time,
const TEST_AUDIO_ENV: &str = "LCO_TEST_AUDIO";
/// reference transcript of that file, used to compute the word error rate,
const TEST_REFERENCE_ENV: &str = "LCO_TEST_REFERENCE";
/// and an offline placeholder transcriber (no Puter calls) for UI/typing tests.
const FAKE_STT_ENV: &str = "LCO_FAKE_STT";

struct AppState {
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    capture: Mutex<Option<CaptureHandle>>,
    capture_status: Arc<Mutex<Option<CaptureStatus>>>,
    bridge: Bridge,
    transcript: Mutex<Option<Transcript>>,
    tray: Mutex<Option<tray::Tray>>,
    jump: Arc<Mutex<JumpStatus>>,
    hotkey_errors: Mutex<Vec<String>>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
struct JumpStatus {
    supported: bool,
    detected: bool,
    process: Option<String>,
    pid: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: &'static str,
    os: &'static str,
    test_audio: Option<String>,
    test_reference: Option<String>,
    fake_stt: bool,
    hotkey_errors: Vec<String>,
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<Settings, String> {
    apply_settings(&app, &state, settings.sanitized())
}

#[tauri::command]
fn regenerate_token(app: AppHandle, state: State<AppState>) -> Result<Settings, String> {
    let mut s = state.settings.lock().unwrap().clone();
    s.pairing_token = settings::generate_token();
    apply_settings(&app, &state, s)
}

/// Start audio capture. PCM packets (100 ms, i16 LE, 16 kHz mono) are
/// streamed to `on_audio` as raw bytes.
#[tauri::command]
fn start_capture(app: AppHandle, state: State<AppState>, on_audio: Channel<InvokeResponseBody>) -> Result<(), String> {
    if let Some(old) = state.capture.lock().unwrap().take() {
        old.stop();
    }
    let source = match std::env::var(TEST_AUDIO_ENV) {
        Ok(path) if !path.is_empty() => Source::File(PathBuf::from(path)),
        _ => {
            let s = state.settings.lock().unwrap();
            match s.capture_mode {
                CaptureMode::JumpDesktop => Source::JumpDesktop(s.jump_names()),
                CaptureMode::System => Source::System,
            }
        }
    };
    // With the Chrome engine the audio also goes to the extension's speech
    // page; the web view keeps receiving it either way.
    let bridge = (state.settings.lock().unwrap().engine == Engine::Chrome).then(|| state.bridge.clone());
    let sink = Box::new(move |bytes: Vec<u8>| {
        if let Some(bridge) = &bridge {
            bridge.send_audio(&bytes);
        }
        on_audio.send(InvokeResponseBody::Raw(bytes)).is_ok()
    });
    let last = state.capture_status.clone();
    *last.lock().unwrap() = None;
    let app_status = app.clone();
    let status = Arc::new(move |st: CaptureStatus| {
        let mut prev = last.lock().unwrap();
        if prev.as_ref() != Some(&st) {
            *prev = Some(st.clone());
            let _ = app_status.emit_to("main", "capture-status", st);
        }
    });
    let handle = audio::start(source, sink, status)?;
    *state.capture.lock().unwrap() = Some(handle);
    Ok(())
}

#[tauri::command]
fn stop_capture(state: State<AppState>) {
    if let Some(handle) = state.capture.lock().unwrap().take() {
        handle.stop();
    }
}

/// Called by the overlay whenever captioning starts/stops or typing is toggled.
/// `typing`: type into Chrome; `listen`: run Chrome's speech recognition on the
/// streamed audio (Chrome engine); `lang`: its BCP 47 language.
#[tauri::command]
fn set_captioning(state: State<AppState>, active: bool, typing: bool, listen: bool, lang: String, session: u64) {
    state
        .bridge
        .set_state(active && typing, active && listen, session, &lang);
    if let Some(t) = state.tray.lock().unwrap().as_ref() {
        t.set_active(active);
    }
    if !active {
        *state.transcript.lock().unwrap() = None;
    }
}

#[tauri::command]
fn bridge_send_text(
    state: State<AppState>,
    session: u64,
    seq: u64,
    text: String,
    provisional: Option<String>,
) -> usize {
    state.bridge.send_text(session, seq, &text, provisional.as_deref())
}

#[tauri::command]
fn bridge_status(state: State<AppState>) -> BridgeStatus {
    state.bridge.status()
}

#[tauri::command]
fn jump_status(state: State<AppState>) -> JumpStatus {
    state.jump.lock().unwrap().clone()
}

#[tauri::command]
fn app_info(state: State<AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        test_audio: std::env::var(TEST_AUDIO_ENV).ok().filter(|p| !p.is_empty()),
        test_reference: std::env::var(TEST_REFERENCE_ENV)
            .ok()
            .filter(|p| !p.is_empty())
            .and_then(|p| std::fs::read_to_string(p).ok()),
        fake_stt: std::env::var(FAKE_STT_ENV).map(|v| v == "1").unwrap_or(false),
        hotkey_errors: state.hotkey_errors.lock().unwrap().clone(),
    }
}

/// Problems registering the configured hotkeys, in plain language.
#[tauri::command]
fn hotkey_errors(state: State<AppState>) -> Vec<String> {
    state.hotkey_errors.lock().unwrap().clone()
}

/// Release the global hotkeys while the user records a new one in Settings
/// (otherwise pressing a registered combination triggers it instead of
/// reaching the page), and register them again afterwards.
#[tauri::command]
fn suspend_hotkeys(app: AppHandle, state: State<AppState>, suspended: bool) {
    if suspended {
        let _ = app.global_shortcut().unregister_all();
    } else {
        let s = state.settings.lock().unwrap().clone();
        register_hotkeys(&app, &s);
    }
}

/// Copy caption text to the clipboard. Done natively because the overlay
/// never has keyboard focus, which the web clipboard API requires.
#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    // On Windows the overlay window owns the copied text, so remote-desktop
    // clients such as Jump Desktop forward it (see `clipboard`). This sync
    // command runs on the main thread, which owns that window.
    #[cfg(windows)]
    {
        let overlay = app.get_webview_window("main").ok_or("the caption window is not open")?;
        let hwnd = overlay.hwnd().map_err(|e| e.to_string())?;
        clipboard::write_text(windows::Win32::Foundation::HWND(hwnd.0), &text)
    }
    #[cfg(not(windows))]
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    open_settings_window(&app);
}

#[tauri::command]
fn hide_overlay(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// Begin a transcript file for a captioning session. Returns its path, or
/// `None` when saving transcripts is disabled.
#[tauri::command]
fn transcript_begin(app: AppHandle, state: State<AppState>, stamp: String) -> Result<Option<String>, String> {
    let s = state.settings.lock().unwrap().clone();
    if !s.save_transcript {
        *state.transcript.lock().unwrap() = None;
        return Ok(None);
    }
    let dir = if s.transcript_dir.trim().is_empty() {
        app.path()
            .document_dir()
            .map_err(|e| e.to_string())?
            .join("Live Captions")
    } else {
        PathBuf::from(s.transcript_dir.trim())
    };
    let t = Transcript::create(&dir, &stamp)?;
    let path = t.path.display().to_string();
    *state.transcript.lock().unwrap() = Some(t);
    Ok(Some(path))
}

#[tauri::command]
fn transcript_append(state: State<AppState>, line: String) -> Result<(), String> {
    match state.transcript.lock().unwrap().as_mut() {
        Some(t) => t.append(&line),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------- helpers

fn apply_settings(app: &AppHandle, state: &AppState, new: Settings) -> Result<Settings, String> {
    let old = state.settings.lock().unwrap().clone();
    settings::save(&state.settings_path, &new)?;
    *state.settings.lock().unwrap() = new.clone();
    if old.bridge_port != new.bridge_port || old.pairing_token != new.pairing_token {
        state.bridge.restart(new.bridge_port, &new.pairing_token);
    }
    if (
        old.hotkey_toggle.as_str(),
        old.hotkey_show_hide.as_str(),
        old.hotkey_typing.as_str(),
        old.hotkey_copy.as_str(),
    ) != (
        new.hotkey_toggle.as_str(),
        new.hotkey_show_hide.as_str(),
        new.hotkey_typing.as_str(),
        new.hotkey_copy.as_str(),
    ) {
        register_hotkeys(app, &new);
    }
    let _ = app.emit("settings-changed", &new);
    Ok(new)
}

fn register_hotkeys(app: &AppHandle, s: &Settings) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut errors = Vec::new();
    let bindings: [(&str, &str, &str); 4] = [
        ("Start / Stop", &s.hotkey_toggle, "toggle"),
        ("Show / Hide", &s.hotkey_show_hide, "show_hide"),
        ("Typing on/off", &s.hotkey_typing, "typing"),
        ("Copy captions", &s.hotkey_copy, "copy"),
    ];
    for (label, keys, action) in bindings {
        let keys = keys.trim();
        if keys.is_empty() {
            continue;
        }
        let action = action.to_string();
        let result = gs.on_shortcut(keys, move |app, _shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            match action.as_str() {
                "toggle" => {
                    let _ = app.emit_to("main", "toggle-captioning", ());
                }
                "show_hide" => toggle_overlay(app),
                "typing" => toggle_typing(app),
                // The overlay knows the caption selection, so it does the copying.
                "copy" => {
                    let _ = app.emit_to("main", "copy-captions", ());
                }
                _ => {}
            }
        });
        if let Err(e) = result {
            errors.push(hotkey_problem(label, keys, &e.to_string()));
        }
    }
    *app.state::<AppState>().hotkey_errors.lock().unwrap() = errors;
}

/// Plain-language explanation of why a hotkey could not be registered.
fn hotkey_problem(action: &str, keys: &str, error: &str) -> String {
    if error.to_lowercase().contains("already registered") {
        format!("{action}: {keys} is already used by another program. Choose a different hotkey.")
    } else {
        format!("{action}: {keys} can't be used as a hotkey ({error}).")
    }
}

fn toggle_typing(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut s = state.settings.lock().unwrap().clone();
    s.type_into_chrome = !s.type_into_chrome;
    let _ = apply_settings(app, &state, s);
}

pub(crate) fn toggle_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
        }
    }
}

pub(crate) fn quit(app: &AppHandle) {
    if let Some(c) = app.state::<AppState>().capture.lock().unwrap().take() {
        c.stop();
    }
    let _ = app.save_window_state(StateFlags::SIZE | StateFlags::POSITION);
    app.exit(0);
}

pub(crate) fn open_settings_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    // Callers run on the main thread (the overlay's Settings command and the
    // tray menu handler). On Windows, building a web view there deadlocks
    // WebView2 and leaves an empty white window, so build it on a worker
    // thread; Tauri forwards the native calls to the main thread itself.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if app.get_webview_window("settings").is_some() {
            return; // a second click already created it
        }
        let built = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
            .title("Live Caption Overlay — Settings")
            .inner_size(560.0, 760.0)
            .min_inner_size(420.0, 420.0)
            .always_on_top(true)
            .center()
            .build();
        if let Ok(window) = built {
            // Closing Settings while a hotkey field was being recorded must
            // not leave the hotkeys switched off.
            let app = app.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Destroyed = event {
                    let s = app.state::<AppState>().settings.lock().unwrap().clone();
                    register_hotkeys(&app, &s);
                }
            });
        }
    });
}

/// `window.open` handler for the overlay: Puter's sign-in flow opens a popup
/// and talks to it with `postMessage`, so the popup must be a real child
/// web view that keeps its `opener`.
fn popup_window(app: &AppHandle, url: tauri::Url, features: NewWindowFeatures) -> NewWindowResponse<Wry> {
    static COUNTER: AtomicU32 = AtomicU32::new(1);
    if !matches!(url.scheme(), "https" | "about") {
        return NewWindowResponse::Deny;
    }
    let label = format!("popup-{}", COUNTER.fetch_add(1, Ordering::SeqCst));
    let app_for_children = app.clone();
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External("about:blank".parse().unwrap()))
        .window_features(features)
        .title("Sign in to Puter")
        .always_on_top(true)
        .focused(true)
        .on_new_window(move |url, f| popup_window(&app_for_children, url, f))
        .on_document_title_changed(|w, title| {
            let _ = w.set_title(&title);
        })
        .build();
    match built {
        Ok(window) => NewWindowResponse::Create { window },
        Err(_) => NewWindowResponse::Deny,
    }
}

fn create_overlay(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let app_for_popups = app.clone();
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Live Caption Overlay")
        .inner_size(780.0, 200.0)
        .min_inner_size(320.0, 110.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        // Never take keyboard focus away from Chrome.
        .focused(false)
        .focusable(false)
        .on_new_window(move |url, f| popup_window(&app_for_popups, url, f))
        .build()?;
    let w = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            // Closing the overlay hides it to the tray.
            api.prevent_close();
            let _ = w.hide();
        }
    });
    Ok(window)
}

/// Poll for the Jump Desktop process every 2 s and publish changes.
fn spawn_jump_monitor(app: AppHandle, jump: Arc<Mutex<JumpStatus>>) {
    std::thread::spawn(move || loop {
        let names = app.state::<AppState>().settings.lock().unwrap().jump_names();
        let found = process::find_jump_desktop(&names);
        let status = JumpStatus {
            supported: cfg!(windows),
            detected: found.is_some(),
            process: found.as_ref().map(|p| p.name.clone()),
            pid: found.map(|p| p.pid),
        };
        let changed = {
            let mut cur = jump.lock().unwrap();
            let changed = *cur != status;
            *cur = status.clone();
            changed
        };
        if changed {
            let _ = app.emit("jump-status", status);
        }
        std::thread::sleep(Duration::from_secs(2));
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Windows writes the clipboard itself (see `clipboard`).
    #[cfg(not(windows))]
    let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION)
                .with_filter(|label| label == "main" || label == "settings")
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let settings = settings::load(&settings_path);
            let emitter = handle.clone();
            let bridge = Bridge::new(Arc::new(move |event, payload| {
                let _ = if event == "bridge-ack" {
                    emitter.emit_to("main", event, payload)
                } else {
                    emitter.emit(event, payload)
                };
            }));
            bridge.restart(settings.bridge_port, &settings.pairing_token);
            let jump = Arc::new(Mutex::new(JumpStatus {
                supported: cfg!(windows),
                ..Default::default()
            }));
            app.manage(AppState {
                settings: Mutex::new(settings.clone()),
                settings_path,
                capture: Mutex::new(None),
                capture_status: Arc::default(),
                bridge,
                transcript: Mutex::new(None),
                tray: Mutex::new(None),
                jump: jump.clone(),
                hotkey_errors: Mutex::new(Vec::new()),
            });
            register_hotkeys(&handle, &settings);
            let tray = tray::Tray::create(&handle)?;
            *app.state::<AppState>().tray.lock().unwrap() = Some(tray);

            let overlay = create_overlay(&handle)?;
            #[cfg(windows)]
            if let Ok(hwnd) = overlay.hwnd() {
                focus::install(hwnd.0 as isize);
            }
            #[cfg(not(windows))]
            let _ = overlay;
            spawn_jump_monitor(handle, jump);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            regenerate_token,
            start_capture,
            stop_capture,
            set_captioning,
            bridge_send_text,
            bridge_status,
            jump_status,
            app_info,
            hotkey_errors,
            suspend_hotkeys,
            copy_text,
            open_settings,
            hide_overlay,
            transcript_begin,
            transcript_append,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Live Caption Overlay")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // Keep running in the tray when the last window closes;
                // only an explicit Quit (exit code set) ends the app.
                if code.is_none() {
                    api.prevent_exit();
                } else {
                    let _ = app.save_window_state(StateFlags::SIZE | StateFlags::POSITION);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::hotkey_problem;

    #[test]
    fn hotkey_problems_are_explained_plainly() {
        let taken = hotkey_problem(
            "Start / Stop",
            "Ctrl+Alt+S",
            "HotKey already registered: HotKey { mods: Modifiers(ALT | CONTROL), key: KeyS, id: 589861 }",
        );
        assert_eq!(
            taken,
            "Start / Stop: Ctrl+Alt+S is already used by another program. Choose a different hotkey."
        );
        let invalid = hotkey_problem("Show / Hide", "Tab+Q", "Couldn't recognize \"Tab\" as a valid key");
        assert!(invalid.starts_with("Show / Hide: Tab+Q can't be used as a hotkey"));
    }
}

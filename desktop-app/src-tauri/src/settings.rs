//! Persistent user settings (JSON file in the app config directory).
//!
//! The Rust side owns the canonical copy; every window reads it through the
//! `get_settings` command and is notified of changes with `settings-changed`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CaptureMode {
    /// Capture only the Jump Desktop process tree (WASAPI process loopback).
    JumpDesktop,
    /// Capture everything the default output device plays (WASAPI loopback).
    System,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Accuracy,
    Balanced,
    Speed,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub capture_mode: CaptureMode,
    /// Comma separated executable names that identify Jump Desktop.
    pub jump_process_names: String,
    /// ISO-639-1 language code passed to the speech-to-text model.
    pub language: String,
    pub priority: Priority,
    /// "auto" (derived from priority) or an explicit Puter model id.
    pub model: String,
    /// Pass the last sentence(s) as a prompt to keep names/terms consistent.
    pub use_context_prompt: bool,
    /// Maximum parallel transcription requests (1..=4).
    pub max_parallel: u32,
    /// Show provisional captions while speech is still in progress.
    pub live_preview: bool,
    pub type_into_chrome: bool,
    pub bridge_port: u16,
    pub pairing_token: String,
    /// Global hotkeys (empty string disables a hotkey).
    pub hotkey_toggle: String,
    pub hotkey_show_hide: String,
    pub hotkey_typing: String,
    pub font_size: u32,
    pub bg_opacity: f64,
    pub save_transcript: bool,
    /// Folder for transcript files; empty = Documents/Live Captions.
    pub transcript_dir: String,
    pub show_debug: bool,
}

pub const DEFAULT_JUMP_NAMES: &str = "JumpDesktop.exe, JumpClient.exe, JumpWinClient.exe";

/// Start/Stop hotkey. Ctrl+Alt+S, the first default, is often taken by other
/// programs, so saved settings still using it move to this one.
pub const DEFAULT_TOGGLE_HOTKEY: &str = "Ctrl+Alt+Q";
const OLD_DEFAULT_TOGGLE_HOTKEY: &str = "Ctrl+Alt+S";

/// Models earlier versions offered that Puter no longer lists. Saved settings
/// that still name one switch to "auto" (Puter's default model).
const RETIRED_MODELS: [&str; 3] = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"];

impl Default for Settings {
    fn default() -> Self {
        Self {
            capture_mode: CaptureMode::JumpDesktop,
            jump_process_names: DEFAULT_JUMP_NAMES.to_string(),
            language: "en".into(),
            priority: Priority::Balanced,
            model: "auto".into(),
            use_context_prompt: true,
            max_parallel: 3,
            live_preview: true,
            type_into_chrome: true,
            bridge_port: 47821,
            pairing_token: String::new(),
            hotkey_toggle: DEFAULT_TOGGLE_HOTKEY.into(),
            hotkey_show_hide: "Ctrl+Alt+H".into(),
            hotkey_typing: "Ctrl+Alt+T".into(),
            font_size: 26,
            bg_opacity: 0.6,
            save_transcript: false,
            transcript_dir: String::new(),
            show_debug: false,
        }
    }
}

impl Settings {
    /// Clamp values that come from the UI into safe ranges.
    pub fn sanitized(mut self) -> Self {
        self.max_parallel = self.max_parallel.clamp(1, 4);
        self.font_size = self.font_size.clamp(12, 72);
        self.bg_opacity = self.bg_opacity.clamp(0.0, 1.0);
        if self.bridge_port < 1024 {
            self.bridge_port = 47821;
        }
        self.language = self.language.trim().to_lowercase();
        if self.language.is_empty() {
            self.language = "en".into();
        }
        self.model = self.model.trim().to_string();
        if self.model.is_empty() || RETIRED_MODELS.contains(&self.model.as_str()) {
            self.model = "auto".into();
        }
        if self.hotkey_toggle == OLD_DEFAULT_TOGGLE_HOTKEY {
            self.hotkey_toggle = DEFAULT_TOGGLE_HOTKEY.into();
        }
        if self.jump_process_names.trim().is_empty() {
            self.jump_process_names = DEFAULT_JUMP_NAMES.into();
        }
        self.pairing_token = normalize_token(&self.pairing_token);
        if self.pairing_token.len() < 12 {
            self.pairing_token = generate_token();
        }
        self
    }

    pub fn jump_names(&self) -> Vec<String> {
        self.jump_process_names
            .split([',', ';'])
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect()
    }
}

/// Upper-case, keep only token characters, re-group as XXXX-XXXX-XXXX-XXXX.
pub fn normalize_token(raw: &str) -> String {
    let clean: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    clean
        .as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

/// 16 random characters from an alphabet without look-alikes (no 0/O, 1/I).
pub fn generate_token() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS random generator unavailable");
    let raw: String = bytes
        .iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect();
    normalize_token(&raw)
}

pub fn load(path: &PathBuf) -> Settings {
    let loaded = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .unwrap_or_default();
    let settings = loaded.clone().sanitized();
    if settings != loaded || !path.exists() {
        let _ = save(path, &settings);
    }
    settings
}

pub fn save(path: &PathBuf, settings: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    // Write atomically so a crash never leaves a half-written file.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_roundtrip() {
        let t = generate_token();
        assert_eq!(t.len(), 19);
        assert_eq!(normalize_token(&t.to_lowercase().replace('-', " ")), t);
    }

    #[test]
    fn retired_models_switch_to_auto() {
        for old in RETIRED_MODELS {
            let s = Settings {
                model: old.into(),
                ..Default::default()
            }
            .sanitized();
            assert_eq!(s.model, "auto");
        }
        let kept = Settings {
            model: " gpt-transcribe ".into(),
            ..Default::default()
        }
        .sanitized();
        assert_eq!(kept.model, "gpt-transcribe");
    }

    #[test]
    fn old_default_hotkey_moves_to_new_default() {
        let s = Settings {
            hotkey_toggle: "Ctrl+Alt+S".into(),
            ..Default::default()
        }
        .sanitized();
        assert_eq!(s.hotkey_toggle, "Ctrl+Alt+Q");
        let custom = Settings {
            hotkey_toggle: "Ctrl+Shift+F9".into(),
            ..Default::default()
        }
        .sanitized();
        assert_eq!(custom.hotkey_toggle, "Ctrl+Shift+F9");
    }

    #[test]
    fn sanitize_clamps() {
        let s = Settings {
            max_parallel: 9,
            font_size: 2,
            ..Default::default()
        }
        .sanitized();
        assert_eq!(s.max_parallel, 4);
        assert_eq!(s.font_size, 12);
        assert!(!s.pairing_token.is_empty());
    }
}

//! Optional transcript file: one line per finalized caption with a timestamp.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Transcript {
    pub path: PathBuf,
    file: File,
}

impl Transcript {
    /// Create `transcript-<stamp>.txt` in `dir`. `stamp` comes from the UI in
    /// local time; only digits, '-' and '_' are kept.
    pub fn create(dir: &Path, stamp: &str) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
        let stamp: String = stamp.chars().filter(|c| c.is_ascii_digit() || *c == '-' || *c == '_').collect();
        let path = dir.join(format!("transcript-{stamp}.txt"));
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
        Ok(Self { path, file })
    }

    pub fn append(&mut self, line: &str) -> Result<(), String> {
        let line = line.replace(['\r', '\n'], " ");
        writeln!(self.file, "{line}").map_err(|e| e.to_string())?;
        self.file.flush().map_err(|e| e.to_string())
    }
}

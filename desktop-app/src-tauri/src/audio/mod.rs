//! Audio capture: produces 16 kHz mono 16-bit PCM in 100 ms packets.
//!
//! * Windows: WASAPI process loopback (Jump Desktop only) or system loopback.
//! * Any OS: a WAV file played in real time (`LCO_TEST_AUDIO=path.wav`) for
//!   testing and tuning without Jump Desktop.
//!
//! Capture runs on its own thread; `CaptureHandle::stop` returns immediately
//! and the thread winds down within ~100 ms.

pub mod resample;
pub mod wav_file;
#[cfg(windows)]
mod windows;

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

pub const OUT_RATE: u32 = 16_000;
/// 100 ms of audio per packet sent to the web view.
const PACKET_SAMPLES: usize = (OUT_RATE / 10) as usize;
/// After this much time without any audio, silence is synthesised so the
/// voice-activity detector in the front end can close the current chunk.
const IDLE_PAD_AFTER: Duration = Duration::from_millis(150);

#[derive(Clone, Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum Source {
    /// Executable names (lower case) that identify Jump Desktop.
    JumpDesktop(Vec<String>),
    System,
    File(PathBuf),
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    /// "capturing" | "waiting" | "error" | "stopped" | "finished" (test file ended)
    pub state: &'static str,
    pub message: String,
    pub process: Option<String>,
    pub pid: Option<u32>,
}

impl CaptureStatus {
    pub fn new(state: &'static str, message: impl Into<String>) -> Self {
        Self { state, message: message.into(), process: None, pid: None }
    }
}

pub type StatusFn = Arc<dyn Fn(CaptureStatus) + Send + Sync>;
/// Receives little-endian i16 PCM packets; returns false once the receiver is gone.
pub type PacketSink = Box<dyn FnMut(Vec<u8>) -> bool + Send>;

/// Converts float samples to 16-bit packets and pads silence during gaps.
pub struct PcmOutput {
    sink: PacketSink,
    pending: Vec<i16>,
    last_audio: Instant,
    padded: u64,
    alive: bool,
}

impl PcmOutput {
    pub fn new(sink: PacketSink) -> Self {
        Self { sink, pending: Vec::with_capacity(PACKET_SAMPLES * 2), last_audio: Instant::now(), padded: 0, alive: true }
    }

    /// Whether the web view side is still listening.
    pub fn alive(&self) -> bool {
        self.alive
    }

    /// Push real captured audio (16 kHz mono, -1.0..1.0).
    pub fn push(&mut self, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        self.last_audio = Instant::now();
        self.padded = 0;
        for s in samples {
            self.pending.push((s.clamp(-1.0, 1.0) * 32767.0) as i16);
        }
        self.flush_full();
    }

    /// Call regularly when no audio arrived; emits silence for long gaps so
    /// the timeline keeps moving (process loopback delivers nothing while the
    /// target app is quiet).
    pub fn idle(&mut self) {
        let gap = self.last_audio.elapsed();
        if gap <= IDLE_PAD_AFTER {
            return;
        }
        let owed = ((gap - IDLE_PAD_AFTER).as_secs_f64() * OUT_RATE as f64) as u64;
        if owed > self.padded {
            let n = (owed - self.padded) as usize;
            self.pending.resize(self.pending.len() + n, 0);
            self.padded = owed;
            self.flush_full();
        }
    }

    fn flush_full(&mut self) {
        while self.alive && self.pending.len() >= PACKET_SAMPLES {
            let bytes: Vec<u8> = self.pending.drain(..PACKET_SAMPLES).flat_map(|s| s.to_le_bytes()).collect();
            self.alive = (self.sink)(bytes);
        }
    }
}

pub struct CaptureHandle {
    stop: Arc<AtomicBool>,
}

impl CaptureHandle {
    /// Signal the capture thread to stop. Returns immediately.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Start capturing on a background thread.
pub fn start(source: Source, sink: PacketSink, status: StatusFn) -> Result<CaptureHandle, String> {
    if let Source::File(path) = &source {
        // Validate early so the user gets an immediate error.
        wav_file::read_wav(path)?;
    } else if !cfg!(windows) {
        return Err(
            "Live audio capture is implemented for Windows 10 (2004+) and Windows 11. \
             On this OS set LCO_TEST_AUDIO=<file.wav> to test with a recording."
                .into(),
        );
    }
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    thread::Builder::new()
        .name("audio-capture".into())
        .spawn(move || {
            let mut out = PcmOutput::new(sink);
            match &source {
                Source::File(path) => run_file(path, &stop_thread, &mut out, &status),
                #[cfg(windows)]
                _ => windows::run(&source, &stop_thread, &mut out, &status),
                #[cfg(not(windows))]
                _ => {}
            }
            status(CaptureStatus::new("stopped", "Capture stopped"));
        })
        .map_err(|e| e.to_string())?;
    Ok(CaptureHandle { stop })
}

/// Sleep for `dur` while keeping silence flowing and honouring `stop`.
pub(crate) fn wait_idle(stop: &AtomicBool, out: &mut PcmOutput, dur: Duration) {
    let until = Instant::now() + dur;
    while !stop.load(Ordering::SeqCst) && out.alive() && Instant::now() < until {
        thread::sleep(Duration::from_millis(50));
        out.idle();
    }
}

fn run_file(path: &Path, stop: &AtomicBool, out: &mut PcmOutput, status: &StatusFn) {
    let wav = match wav_file::read_wav(path) {
        Ok(w) => w,
        Err(e) => {
            status(CaptureStatus::new("error", e));
            return;
        }
    };
    let mut resampler = resample::Resampler::new(wav.sample_rate, OUT_RATE);
    let mut samples = Vec::with_capacity(wav.samples.len() / 2);
    resampler.process(&wav.samples, &mut samples);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
    status(CaptureStatus {
        state: "capturing",
        message: format!("Test audio file ({:.0} s)", samples.len() as f64 / OUT_RATE as f64),
        process: name,
        pid: None,
    });
    // Play in real time: one 100 ms packet per 100 ms of wall-clock time.
    let started = Instant::now();
    for (i, packet) in samples.chunks(PACKET_SAMPLES).enumerate() {
        let due = started + Duration::from_millis(100 * i as u64);
        while Instant::now() < due {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        if stop.load(Ordering::SeqCst) || !out.alive() {
            return;
        }
        out.push(packet);
    }
    // End of file: report it, then keep emitting silence until stopped.
    status(CaptureStatus::new("finished", "Test audio finished"));
    while !stop.load(Ordering::SeqCst) && out.alive() {
        wait_idle(stop, out, Duration::from_millis(500));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn packets_are_100ms_and_silence_is_padded() {
        let got: Arc<Mutex<Vec<usize>>> = Arc::default();
        let g = got.clone();
        let mut out = PcmOutput::new(Box::new(move |b| {
            g.lock().unwrap().push(b.len());
            true
        }));
        out.push(&vec![0.1; 4000]);
        assert_eq!(*got.lock().unwrap(), vec![3200, 3200]);
        thread::sleep(Duration::from_millis(400));
        out.idle();
        // ~250 ms of silence owed + 800 pending samples -> at least 2 more packets.
        assert!(got.lock().unwrap().len() >= 4);
    }
}

//! WASAPI loopback capture (Windows 10 2004+ / Windows 11).
//!
//! * Jump Desktop mode uses *process loopback* (`ActivateAudioInterfaceAsync`
//!   with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, via the `wasapi`
//!   crate) on the Jump Desktop process tree, so other local sounds are not
//!   captured.
//! * System mode uses classic loopback on the default render device.
//!
//! Both request 48 kHz stereo float with automatic conversion and are then
//! down-mixed and resampled to 16 kHz mono here.

use super::{resample::Resampler, wait_idle, CaptureStatus, PcmOutput, Source, StatusFn};
use crate::process;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use wasapi::{AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

const CAPTURE_RATE: usize = 48_000;
const CAPTURE_CHANNELS: usize = 2;

enum Target {
    Process(u32),
    System,
}

pub fn run(source: &Source, stop: &AtomicBool, out: &mut PcmOutput, status: &StatusFn) {
    if wasapi::initialize_mta().is_err() {
        status(CaptureStatus::new(
            "error",
            "Could not initialise COM for audio capture",
        ));
        return;
    }
    while !stop.load(Ordering::SeqCst) && out.alive() {
        let result = match source {
            Source::JumpDesktop(names) => match process::find_jump_desktop(names) {
                None => {
                    status(CaptureStatus::new("waiting", "Jump Desktop not detected"));
                    wait_idle(stop, out, Duration::from_millis(1000));
                    continue;
                }
                Some(p) => {
                    status(CaptureStatus {
                        state: "capturing",
                        message: format!("Capturing {}", p.name),
                        process: Some(p.name.clone()),
                        pid: Some(p.pid),
                    });
                    capture(Target::Process(p.pid), stop, out)
                }
            },
            Source::System => {
                status(CaptureStatus::new("capturing", "Capturing all system audio"));
                capture(Target::System, stop, out)
            }
            Source::File(_) => return,
        };
        if let Err(e) = result {
            let hint = if matches!(source, Source::JumpDesktop(_)) {
                " (per-app capture needs Windows 10 version 2004 or newer; try \"All system audio\")"
            } else {
                ""
            };
            status(CaptureStatus::new("error", format!("Audio capture failed: {e}{hint}")));
            // Retry after a pause (e.g. the default device changed).
            wait_idle(stop, out, Duration::from_millis(1500));
        }
    }
}

/// Capture until `stop`, the target process exits, or an error occurs.
fn capture(target: Target, stop: &AtomicBool, out: &mut PcmOutput) -> Result<(), String> {
    let format = WaveFormat::new(32, 32, SampleType::Float, CAPTURE_RATE, CAPTURE_CHANNELS, None);
    let block_align = format.get_blockalign() as usize;
    let (mut client, events) = match target {
        Target::Process(pid) => (
            AudioClient::new_application_loopback_client(pid, true).map_err(|e| e.to_string())?,
            true,
        ),
        Target::System => {
            let device = DeviceEnumerator::new()
                .and_then(|en| en.get_default_device(Direction::Render))
                .map_err(|e| e.to_string())?;
            // Loopback on a render device is polled: some Windows versions
            // never signal the event for loopback streams.
            (device.get_iaudioclient().map_err(|e| e.to_string())?, false)
        }
    };
    let mode = if events {
        StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: 0,
        }
    } else {
        StreamMode::PollingShared {
            autoconvert: true,
            buffer_duration_hns: 1_000_000,
        }
    };
    client
        .initialize_client(&format, Direction::Capture, mode, None)
        .map_err(|e| e.to_string())?;
    let event = if events {
        Some(client.set_get_eventhandle().map_err(|e| e.to_string())?)
    } else {
        None
    };
    let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    client.start_stream().map_err(|e| e.to_string())?;

    let mut resampler = Resampler::new(CAPTURE_RATE as u32, super::OUT_RATE);
    let mut raw = std::collections::VecDeque::<u8>::new();
    let mut mono = Vec::<f32>::with_capacity(4800);
    let mut resampled = Vec::<f32>::with_capacity(1600);
    let mut last_alive_check = Instant::now();

    let result = loop {
        if stop.load(Ordering::SeqCst) || !out.alive() {
            break Ok(());
        }
        match &event {
            // Timeouts are normal while the target is silent.
            Some(ev) => {
                let _ = ev.wait_for_event(100);
            }
            None => std::thread::sleep(Duration::from_millis(10)),
        }
        // Drain every packet that is ready.
        let mut got_audio = false;
        loop {
            match capture.get_next_packet_size() {
                Ok(Some(n)) if n > 0 => {
                    if let Err(e) = capture.read_from_device_to_deque(&mut raw) {
                        return Err(e.to_string());
                    }
                }
                Ok(_) => break,
                Err(e) => return Err(e.to_string()),
            }
        }
        let frames = raw.len() / block_align;
        if frames > 0 {
            got_audio = true;
            mono.clear();
            let (a, b) = raw.as_slices();
            let bytes: Vec<u8> = a.iter().chain(b.iter()).take(frames * block_align).copied().collect();
            raw.drain(..frames * block_align);
            for frame in bytes.chunks_exact(block_align) {
                let mut sum = 0.0f32;
                for ch in frame.chunks_exact(4) {
                    sum += f32::from_le_bytes([ch[0], ch[1], ch[2], ch[3]]);
                }
                mono.push(sum / CAPTURE_CHANNELS as f32);
            }
            resampled.clear();
            resampler.process(&mono, &mut resampled);
            out.push(&resampled);
        }
        if !got_audio {
            out.idle();
        }
        if let Target::Process(pid) = target {
            if last_alive_check.elapsed() > Duration::from_secs(1) {
                last_alive_check = Instant::now();
                if !process::is_alive(pid) {
                    break Ok(()); // caller re-detects Jump Desktop
                }
            }
        }
    };
    let _ = client.stop_stream();
    result
}

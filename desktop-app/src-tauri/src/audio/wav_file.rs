//! Debug/test audio source: plays a WAV file in real time as if it were being
//! captured. Enabled with the `LCO_TEST_AUDIO` environment variable so the
//! whole pipeline can be tuned and tested without Jump Desktop.

use std::fs;
use std::path::Path;

pub struct WavData {
    pub sample_rate: u32,
    /// Mono samples in -1.0..1.0.
    pub samples: Vec<f32>,
}

pub fn read_wav(path: &Path) -> Result<WavData, String> {
    let bytes = fs::read(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("Not a RIFF/WAVE file".into());
    }
    let mut pos = 12;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // format, channels, rate, bits
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = pos + 8;
        let end = (body + size).min(bytes.len());
        if id == b"fmt " && size >= 16 {
            let b = &bytes[body..];
            let mut format = u16::from_le_bytes([b[0], b[1]]);
            let channels = u16::from_le_bytes([b[2], b[3]]);
            let rate = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
            let bits = u16::from_le_bytes([b[14], b[15]]);
            if format == 0xFFFE && size >= 26 {
                // WAVE_FORMAT_EXTENSIBLE: sub-format GUID starts at offset 24.
                format = u16::from_le_bytes([b[24], b[25]]);
            }
            fmt = Some((format, channels, rate, bits));
        } else if id == b"data" {
            let (format, channels, rate, bits) = fmt.ok_or("data chunk before fmt chunk")?;
            let data = &bytes[body..end];
            let ch = channels.max(1) as usize;
            let frame_samples: Vec<f32> = match (format, bits) {
                (1, 16) => data
                    .chunks_exact(2)
                    .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
                    .collect(),
                (1, 24) => data
                    .chunks_exact(3)
                    .map(|c| (i32::from_le_bytes([0, c[0], c[1], c[2]]) >> 8) as f32 / 8_388_608.0)
                    .collect(),
                (3, 32) => data
                    .chunks_exact(4)
                    .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                    .collect(),
                _ => return Err(format!("Unsupported WAV encoding (format {format}, {bits} bit)")),
            };
            let samples = frame_samples
                .chunks_exact(ch)
                .map(|f| f.iter().sum::<f32>() / ch as f32)
                .collect();
            return Ok(WavData { sample_rate: rate, samples });
        }
        pos = body + size + (size & 1);
    }
    Err("No data chunk found".into())
}

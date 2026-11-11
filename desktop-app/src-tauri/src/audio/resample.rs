//! Small streaming resampler: windowed-sinc low-pass FIR followed by linear
//! interpolation. Quality is more than enough for speech at 16 kHz and it has
//! no dependencies. For the common 48 kHz -> 16 kHz case the interpolation
//! positions land exactly on samples, so it degenerates to FIR + decimation.

pub struct Resampler {
    step: f64,
    taps: Vec<f32>,
    /// Last `taps.len() - 1` input samples (FIR history).
    history: Vec<f32>,
    /// Fractional read position into the filtered stream of the next block.
    pos: f64,
    /// Last filtered sample of the previous block (index -1).
    prev: f32,
    passthrough: bool,
    filtered: Vec<f32>,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let passthrough = in_rate == out_rate;
        let taps = if passthrough || in_rate < out_rate {
            vec![1.0]
        } else {
            // Cut off a little below the output Nyquist frequency.
            let cutoff = 0.45 * out_rate as f64 / in_rate as f64; // cycles/sample
            design_lowpass(63, cutoff)
        };
        Self {
            step: in_rate as f64 / out_rate as f64,
            history: vec![0.0; taps.len() - 1],
            taps,
            pos: 0.0,
            prev: 0.0,
            passthrough,
            filtered: Vec::new(),
        }
    }

    /// Resample one block of mono samples, appending the result to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        if self.passthrough {
            out.extend_from_slice(input);
            return;
        }
        // 1. FIR low-pass over history + input.
        let n_hist = self.history.len();
        self.filtered.clear();
        self.filtered.reserve(input.len());
        for i in 0..input.len() {
            let mut acc = 0.0f32;
            // sample at virtual index (n_hist + i - k)
            for (k, tap) in self.taps.iter().enumerate() {
                let idx = n_hist + i;
                let j = idx - k;
                let s = if j < n_hist { self.history[j] } else { input[j - n_hist] };
                acc += tap * s;
            }
            self.filtered.push(acc);
        }
        // Keep the newest samples as the next block's history.
        if input.len() >= n_hist {
            self.history.copy_from_slice(&input[input.len() - n_hist..]);
        } else {
            self.history.drain(..input.len());
            self.history.extend_from_slice(input);
        }
        // 2. Linear interpolation at the output rate. Index -1 is `prev`.
        let n = self.filtered.len() as f64;
        while self.pos <= n - 1.0 {
            let i = self.pos.floor();
            let frac = (self.pos - i) as f32;
            let i = i as isize;
            let a = if i < 0 { self.prev } else { self.filtered[i as usize] };
            let b = self.filtered[(i + 1) as usize];
            out.push(a + (b - a) * frac);
            self.pos += self.step;
        }
        self.pos -= n;
        self.prev = *self.filtered.last().unwrap();
    }
}

/// Blackman-windowed sinc low-pass filter normalised to unity DC gain.
fn design_lowpass(n: usize, cutoff: f64) -> Vec<f32> {
    let m = (n - 1) as f64;
    let mut taps: Vec<f64> = (0..n)
        .map(|i| {
            let x = i as f64 - m / 2.0;
            let sinc = if x == 0.0 {
                2.0 * cutoff
            } else {
                (2.0 * std::f64::consts::PI * cutoff * x).sin() / (std::f64::consts::PI * x)
            };
            let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / m).cos()
                + 0.08 * (4.0 * std::f64::consts::PI * i as f64 / m).cos();
            sinc * w
        })
        .collect();
    let sum: f64 = taps.iter().sum();
    taps.iter_mut().for_each(|t| *t /= sum);
    taps.into_iter().map(|t| t as f32).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, freq: f64, secs: f64) -> Vec<f32> {
        (0..(rate as f64 * secs) as usize)
            .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin() as f32)
            .collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn length_and_passband() {
        let input = tone(48000, 1000.0, 1.0);
        let mut r = Resampler::new(48000, 16000);
        let mut out = Vec::new();
        // Feed in odd-sized blocks to exercise the streaming state.
        for block in input.chunks(441) {
            r.process(block, &mut out);
        }
        assert!((out.len() as i64 - 16000).abs() <= 2, "len {}", out.len());
        let level = rms(&out[200..]);
        assert!((level - 0.707).abs() < 0.03, "passband level {level}");
    }

    #[test]
    fn stopband_attenuated() {
        // 12 kHz would alias to 4 kHz at 16 kHz output; it must be removed.
        let input = tone(48000, 12000.0, 0.5);
        let mut r = Resampler::new(48000, 16000);
        let mut out = Vec::new();
        r.process(&input, &mut out);
        assert!(rms(&out[200..]) < 0.01);
    }

    #[test]
    fn fractional_ratio() {
        let input = tone(44100, 440.0, 1.0);
        let mut r = Resampler::new(44100, 16000);
        let mut out = Vec::new();
        for block in input.chunks(1000) {
            r.process(block, &mut out);
        }
        assert!((out.len() as i64 - 16000).abs() <= 2, "len {}", out.len());
        assert!((rms(&out[200..]) - 0.707).abs() < 0.03);
    }
}

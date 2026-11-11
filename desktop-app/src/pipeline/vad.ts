// Energy-based voice activity detector with an adaptive noise floor.
// Works on 20 ms frames of 16 kHz mono audio. Cheap enough to run on every
// frame in the web view with negligible CPU.

export const SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = 320; // 20 ms
export const FRAME_SEC = FRAME_SAMPLES / SAMPLE_RATE;

/** Absolute floor: quieter than about -50 dBFS is never speech. */
const MIN_SPEECH_RMS = 0.003;
/** Speech must be this many times louder than the tracked noise floor. */
const SNR_FACTOR = 3.0;

export interface FrameInfo {
  rms: number;
  speech: boolean;
}

export class Vad {
  private noiseFloor = 0.001;

  frame(samples: Float32Array): FrameInfo {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.max(1, samples.length));
    const threshold = Math.max(MIN_SPEECH_RMS, this.noiseFloor * SNR_FACTOR);
    const speech = rms > threshold;
    // Minimum tracking: follow the floor down quickly, but let it rise only
    // slowly (~8 %/s) so syllable dips inside continuous speech are not
    // learned as "noise", while steady background noise is learned in time.
    if (rms < this.noiseFloor) this.noiseFloor = this.noiseFloor * 0.8 + rms * 0.2;
    else this.noiseFloor *= 1.0015;
    this.noiseFloor = Math.min(0.05, Math.max(0.0002, this.noiseFloor));
    return { rms, speech };
  }

  reset(): void {
    this.noiseFloor = 0.001;
  }
}

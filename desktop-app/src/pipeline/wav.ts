// Light loudness normalisation and 16-bit PCM WAV encoding.

const TARGET_PEAK = 0.9;
const TARGET_RMS = 0.1; // about -20 dBFS
const MAX_GAIN = 12;

/** Remove DC offset and bring the chunk to a consistent level. */
export function normalize(input: Float32Array): Float32Array {
  const n = input.length;
  if (!n) return input;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += input[i];
  mean /= n;
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = input[i] - mean;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  if (peak < 1e-5) return input;
  // Never clip, never boost more than MAX_GAIN (that would just amplify noise).
  const gain = Math.min(TARGET_PEAK / peak, TARGET_RMS / Math.max(rms, 1e-6), MAX_GAIN);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = (input[i] - mean) * gain;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}

/** Encode mono float samples as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return buf;
}

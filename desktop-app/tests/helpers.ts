// Synthetic audio helpers for the pipeline tests.
import { SAMPLE_RATE } from "../src/pipeline/vad.ts";

/** Deterministic pseudo-random generator (mulberry32). */
export function rng(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** "Speech": amplitude-modulated noise + tone, roughly -20 dBFS. */
export function speech(sec: number, rand = rng(7)): Float32Array {
  const n = Math.round(sec * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
    out[i] = env * (0.15 * Math.sin(2 * Math.PI * 180 * t) + 0.08 * (rand() * 2 - 1));
  }
  return out;
}

/** Near-silence with faint noise (-60 dBFS). */
export function silence(sec: number, rand = rng(3)): Float32Array {
  const n = Math.round(sec * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.001 * (rand() * 2 - 1);
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Feed a signal in 100 ms packets, like the Rust capture does. */
export function feed(push: (s: Float32Array) => void, signal: Float32Array): void {
  for (let i = 0; i < signal.length; i += 1600) push(signal.slice(i, i + 1600));
}

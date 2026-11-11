// Smart chunking: turns a continuous 16 kHz stream into speech chunks that
// end at natural pauses, so words are never cut in half.
//
//  * A chunk starts when speech begins (with 0.3 s of pre-roll).
//  * After `minChunkSec`, a pause of `pauseSec` ends the chunk.
//  * A long silence (0.7 s) ends even a short utterance ("Yes.").
//  * In the last second before `maxChunkSec`, a short gap between words
//    (≥ 120 ms) is also accepted as a cut point.
//  * At `maxChunkSec` without any pause the chunk is cut at the quietest
//    point (60 ms window) of its last 0.5 s, and the next chunk starts
//    `overlapSec` earlier so a clipped word is heard again in full.
//  * Chunks with almost no speech are dropped (no wasted requests).

import { FRAME_SAMPLES, FRAME_SEC, Vad } from "./vad.ts";
import type { PipelineProfile } from "./profile.ts";

/** pause = natural pause, gap = short gap between words, forced = no gap found. */
export type Boundary = "pause" | "gap" | "forced";

export interface AudioChunk {
  id: number;
  samples: Float32Array;
  /** Absolute index (in the capture stream) of the first sample. */
  startSample: number;
  /** Absolute index just after the last sample. */
  endSample: number;
  speechSec: number;
  /** Fraction of 20 ms frames classified as speech. */
  speechRatio: number;
  /** Why this chunk ended. */
  end: Boundary;
  /** True when the previous chunk ended mid-sentence (gap/forced cut). */
  continuesSentence: boolean;
  /** Seconds of audio repeated from the previous chunk. */
  overlapSec: number;
}

interface Frame {
  data: Float32Array;
  rms: number;
  speech: boolean;
  start: number;
}

const PREROLL_FRAMES = 15; // 0.3 s kept before speech onset
const ONSET_FRAMES = 2; // 40 ms of speech starts a chunk
const UTTERANCE_END_SEC = 0.7;
const TRAILING_KEEP_FRAMES = 12; // keep ≤0.24 s of silence at the end
const MIN_SPEECH_SEC = 0.25;
const QUIET_SEARCH_FRAMES = 25; // last 0.5 s
const GAP_FRAMES = 6; // 120 ms gap between words
const GAP_WINDOW_SEC = 1.0; // accept word gaps this close to the maximum

export class Chunker {
  private readonly vad = new Vad();
  private pending = new Float32Array(0);
  private sampleIndex = 0;
  private preroll: Frame[] = [];
  private current: Frame[] | null = null;
  private trailingSilence = 0;
  private onsetCount = 0;
  private continues = false;
  private overlapFrames = 0;
  private nextId = 1;
  /** Number of chunks dropped because they contained too little speech. */
  skipped = 0;

  private profile: PipelineProfile;
  private readonly emit: (chunk: AudioChunk) => void;

  constructor(profile: PipelineProfile, emit: (chunk: AudioChunk) => void) {
    this.profile = profile;
    this.emit = emit;
  }

  setProfile(profile: PipelineProfile): void {
    this.profile = profile;
  }

  /** Total samples consumed so far (absolute stream position). */
  get position(): number {
    return this.sampleIndex + this.pending.length;
  }

  /** The chunk being recorded right now (speech in progress), if any. */
  get activeChunk(): { startSample: number; speechSec: number } | null {
    if (!this.current?.length) return null;
    let speech = 0;
    for (const f of this.current) if (f.speech) speech++;
    return { startSample: this.current[0].start, speechSec: speech * FRAME_SEC };
  }

  reset(): void {
    this.vad.reset();
    this.pending = new Float32Array(0);
    this.sampleIndex = 0;
    this.preroll = [];
    this.current = null;
    this.trailingSilence = 0;
    this.onsetCount = 0;
    this.continues = false;
    this.overlapFrames = 0;
    this.skipped = 0;
  }

  push(samples: Float32Array): void {
    let buf = samples;
    if (this.pending.length) {
      buf = new Float32Array(this.pending.length + samples.length);
      buf.set(this.pending);
      buf.set(samples, this.pending.length);
    }
    let off = 0;
    while (off + FRAME_SAMPLES <= buf.length) {
      const data = buf.slice(off, off + FRAME_SAMPLES);
      const { rms, speech } = this.vad.frame(data);
      this.onFrame({ data, rms, speech, start: this.sampleIndex });
      this.sampleIndex += FRAME_SAMPLES;
      off += FRAME_SAMPLES;
    }
    this.pending = buf.slice(off);
  }

  private onFrame(f: Frame): void {
    if (!this.current) {
      this.preroll.push(f);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      this.onsetCount = f.speech ? this.onsetCount + 1 : 0;
      if (this.onsetCount >= ONSET_FRAMES) {
        this.current = this.preroll;
        this.preroll = [];
        this.trailingSilence = 0;
        this.continues = false;
        this.overlapFrames = 0;
      }
      return;
    }

    const cur = this.current;
    const silenceBefore = this.trailingSilence;
    cur.push(f);
    this.trailingSilence = f.speech ? 0 : this.trailingSilence + 1;
    const durSec = cur.length * FRAME_SEC;
    const silenceSec = this.trailingSilence * FRAME_SEC;
    const gapFrom = Math.max(this.profile.minChunkSec, this.profile.maxChunkSec - GAP_WINDOW_SEC);

    // 1. Natural pause (or end of a short utterance): cut inside the pause.
    if (silenceSec >= UTTERANCE_END_SEC || (silenceSec >= this.profile.pauseSec && durSec >= this.profile.minChunkSec)) {
      const speechEnd = cur.length - this.trailingSilence;
      const keep = Math.min(cur.length, speechEnd + TRAILING_KEEP_FRAMES);
      this.finish(cur.slice(0, keep), "pause");
      this.preroll = cur.slice(keep).slice(-PREROLL_FRAMES);
      this.current = null;
      this.onsetCount = 0;
      return;
    }

    // 2. Close to the maximum, speech resumed after a short gap between
    //    words: cut in the middle of that gap (silence, so no overlap needed).
    if (f.speech && silenceBefore >= GAP_FRAMES && (cur.length - 1) * FRAME_SEC >= gapFrom) {
      const gapStart = cur.length - 1 - silenceBefore;
      this.cutAndContinue(gapStart + Math.floor(silenceBefore / 2), "gap", 0);
      return;
    }

    // 3. Maximum length reached.
    if (durSec >= this.profile.maxChunkSec) {
      if (this.trailingSilence >= GAP_FRAMES) {
        // Inside a gap right now: cut in its middle.
        this.cutAndContinue(cur.length - this.trailingSilence + Math.floor(this.trailingSilence / 2), "gap", 0);
        return;
      }
      // No gap: cut at the quietest point, using a 60 ms window so a real
      // gap wins over a single quiet frame, and repeat `overlapSec` of audio.
      const from = Math.max(1, cur.length - QUIET_SEARCH_FRAMES);
      let best = from;
      let bestEnergy = Infinity;
      for (let i = from; i < cur.length - 1; i++) {
        const e = cur[i - 1].rms + cur[i].rms + cur[i + 1].rms;
        if (e < bestEnergy) {
          bestEnergy = e;
          best = i;
        }
      }
      this.cutAndContinue(best + 1, "forced", Math.round(this.profile.overlapSec / FRAME_SEC));
    }
  }

  /** Emit frames before `cutAt`; the rest (plus `overlap` frames) starts the next chunk. */
  private cutAndContinue(cutAt: number, end: Boundary, overlap: number): void {
    const cur = this.current!;
    this.finish(cur.slice(0, cutAt), end);
    const restStart = Math.max(0, cutAt - overlap);
    this.current = cur.slice(restStart);
    this.overlapFrames = cutAt - restStart;
    this.continues = true;
    let t = 0;
    for (let i = this.current.length - 1; i >= 0 && !this.current[i].speech; i--) t++;
    this.trailingSilence = t;
  }

  private finish(frames: Frame[], end: Boundary): void {
    if (!frames.length) return;
    let speechFrames = 0;
    for (const f of frames) if (f.speech) speechFrames++;
    const speechSec = speechFrames * FRAME_SEC;
    const continuesSentence = this.continues;
    const overlapSec = this.overlapFrames * FRAME_SEC;
    this.continues = false;
    this.overlapFrames = 0;
    if (speechSec < MIN_SPEECH_SEC) {
      this.skipped++;
      return;
    }
    const samples = new Float32Array(frames.length * FRAME_SAMPLES);
    frames.forEach((f, i) => samples.set(f.data, i * FRAME_SAMPLES));
    this.emit({
      id: this.nextId++,
      samples,
      startSample: frames[0].start,
      endSample: frames[frames.length - 1].start + FRAME_SAMPLES,
      speechSec,
      speechRatio: speechFrames / frames.length,
      end,
      continuesSentence,
      overlapSec,
    });
  }
}

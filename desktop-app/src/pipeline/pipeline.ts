// The caption pipeline: PCM in → chunks → parallel transcription → ordered,
// cleaned text out. Pure TypeScript with an injected transcribe function so
// it can be unit-tested and reused outside Tauri.
//
// Live preview: Puter has no streaming speech-to-text on the free plan, so
// while someone is still talking the not-yet-final audio is transcribed about
// once a second (one request at a time) and shown as provisional text. Final,
// in-order chunk results replace it. Previews are never typed or saved.

import { Chunker, type AudioChunk } from "./chunker.ts";
import type { PipelineProfile } from "./profile.ts";
import { contextPrompt, postprocess, trimCovered } from "./postprocess.ts";
import { OrderedScheduler } from "./scheduler.ts";
import { SAMPLE_RATE } from "./vad.ts";
import { encodeWav, normalize } from "./wav.ts";

export interface PipelineConfig {
  profile: PipelineProfile;
  language: string;
  useContextPrompt: boolean;
  maxParallel: number;
  /** Show provisional text while speech is still in progress. */
  livePreview: boolean;
}

export type TranscribeFn = (
  wav: Blob,
  opts: { model: string; language: string; prompt?: string; preview?: boolean },
) => Promise<string>;

export interface Latency {
  chunkSec: number;
  /** Time spent waiting for the transcription API. */
  apiMs: number;
  /** From the end of the chunk's audio to text on screen. */
  endToTextMs: number;
  /** Average speech-to-text delay over the chunk (from its midpoint). */
  wordDelayMs: number;
}

export interface PipelineStats {
  chunks: number;
  skippedSilent: number;
  filtered: number;
  failed: number;
  inFlight: number;
  previews: number;
  avgChunkSec: number;
  avgApiMs: number;
  avgEndToTextMs: number;
  p90EndToTextMs: number;
  avgWordDelayMs: number;
}

export interface PipelineCallbacks {
  onText(text: string, meta: { seq: number; chunk: AudioChunk; latency: Latency }): void;
  /** Provisional text for speech that is not final yet; "" hides it. */
  onPreview(text: string): void;
  onBusy(inFlight: number): void;
  onError(error: unknown, chunk: AudioChunk): void;
  onStats(stats: PipelineStats): void;
}

interface Job {
  chunk: AudioChunk;
  wav: Blob;
  startAt: number;
  endAt: number;
  apiMs: number;
  prompt: string;
}

const HISTORY = 30;
/** Minimum time between the starts of two preview requests. */
export const PREVIEW_INTERVAL_MS = 1000;
/** Only preview once this much speech has been heard in the current chunk. */
const PREVIEW_MIN_SPEECH_SEC = 0.5;
/** Previews cover at most this much of the most recent audio. */
const PREVIEW_MAX_SEC = 8;

/** The last few seconds of audio, addressed by absolute sample index. */
class RecentAudio {
  private parts: { start: number; data: Float32Array }[] = [];
  private end = 0;

  push(start: number, data: Float32Array): void {
    this.parts.push({ start, data });
    this.end = start + data.length;
    const keepFrom = this.end - (PREVIEW_MAX_SEC + 2) * SAMPLE_RATE;
    while (this.parts.length && this.parts[0].start + this.parts[0].data.length < keepFrom) this.parts.shift();
  }

  /** First sample still available. */
  get start(): number {
    return this.parts.length ? this.parts[0].start : this.end;
  }

  slice(from: number, to: number): Float32Array {
    const out = new Float32Array(Math.max(0, to - from));
    for (const p of this.parts) {
      const a = Math.max(from, p.start);
      const b = Math.min(to, p.start + p.data.length);
      if (a < b) out.set(p.data.subarray(a - p.start, b - p.start), a - from);
    }
    return out;
  }

  reset(): void {
    this.parts = [];
    this.end = 0;
  }
}

/** Maps absolute sample positions to wall-clock time (ms, performance.now()). */
class SampleClock {
  private total = 0;
  private lastAt = 0;
  onSamples(count: number, now: number): void {
    this.total += count;
    this.lastAt = now;
  }
  timeOf(sample: number): number {
    return this.lastAt - ((this.total - sample) / SAMPLE_RATE) * 1000;
  }
  reset(): void {
    this.total = 0;
    this.lastAt = 0;
  }
}

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const p90 = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
};

export class CaptionPipeline {
  private cfg: PipelineConfig;
  private readonly transcribe: TranscribeFn;
  private readonly cb: PipelineCallbacks;
  private readonly chunker: Chunker;
  private readonly scheduler: OrderedScheduler<Job, string>;
  private readonly clock = new SampleClock();
  private history = "";
  private previous = "";
  private latencies: Latency[] = [];
  private counts = { chunks: 0, filtered: 0, failed: 0, previews: 0 };
  private readonly now: () => number;
  private readonly recent = new RecentAudio();
  private samplesIn = 0;
  /** Start sample of every chunk sent for final transcription and not finished yet. */
  private readonly pendingStarts = new Map<number, number>();
  /** End sample of the latest chunk whose final result has been handled. */
  private finalizedEnd = 0;
  private preview: { text: string; end: number } | null = null;
  private previewInFlight = false;
  private previewStartedAt = -Infinity;
  /** Incremented on reset so late preview results are ignored. */
  private previewGeneration = 0;
  /** Final texts emitted while the current preview request was running. */
  private finalsDuringPreview: string[] = [];

  constructor(cfg: PipelineConfig, transcribe: TranscribeFn, cb: PipelineCallbacks, now: () => number = () => performance.now()) {
    this.cfg = cfg;
    this.transcribe = transcribe;
    this.cb = cb;
    this.now = now;
    this.chunker = new Chunker(cfg.profile, (c) => this.onChunk(c));
    this.scheduler = new OrderedScheduler<Job, string>({
      maxParallel: cfg.maxParallel,
      timeoutMs: 12000,
      maxQueue: 8,
      run: (job) => this.runJob(job),
      onDone: (job, text, error) => this.onDone(job, text, error),
      isRetryable: (e) => {
        const kind = (e as { kind?: string })?.kind;
        return kind !== "auth" && kind !== "quota";
      },
      onBusyChange: (n) => {
        this.cb.onBusy(n);
        this.emitStats();
      },
    });
  }

  configure(cfg: PipelineConfig): void {
    this.cfg = cfg;
    this.chunker.setProfile(cfg.profile);
    this.scheduler.setMaxParallel(cfg.maxParallel);
  }

  /** Feed 16 kHz mono 16-bit PCM. */
  pushPcm(pcm: Int16Array): void {
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    this.clock.onSamples(f.length, this.now());
    this.recent.push(this.samplesIn, f);
    this.samplesIn += f.length;
    this.chunker.push(f);
    this.maybePreview();
  }

  /** Drop all buffered audio and pending requests (used on Stop/Start). */
  reset(): void {
    this.scheduler.reset();
    this.chunker.reset();
    this.clock.reset();
    this.history = "";
    this.previous = "";
    this.latencies = [];
    this.counts = { chunks: 0, filtered: 0, failed: 0, previews: 0 };
    this.recent.reset();
    this.samplesIn = 0;
    this.pendingStarts.clear();
    this.finalizedEnd = 0;
    this.previewGeneration++;
    this.previewInFlight = false;
    this.previewStartedAt = -Infinity;
    this.finalsDuringPreview = [];
    this.setPreview(null);
    this.emitStats();
  }

  get stats(): PipelineStats {
    const l = this.latencies;
    return {
      chunks: this.counts.chunks,
      skippedSilent: this.chunker.skipped,
      filtered: this.counts.filtered,
      failed: this.counts.failed,
      inFlight: this.scheduler.busy,
      previews: this.counts.previews,
      avgChunkSec: avg(l.map((x) => x.chunkSec)),
      avgApiMs: avg(l.map((x) => x.apiMs)),
      avgEndToTextMs: avg(l.map((x) => x.endToTextMs)),
      p90EndToTextMs: p90(l.map((x) => x.endToTextMs)),
      avgWordDelayMs: avg(l.map((x) => x.wordDelayMs)),
    };
  }

  private emitStats(): void {
    this.cb.onStats(this.stats);
  }

  private onChunk(chunk: AudioChunk): void {
    this.counts.chunks++;
    this.pendingStarts.set(chunk.id, chunk.startSample);
    const wav = new Blob([encodeWav(normalize(chunk.samples), SAMPLE_RATE)], { type: "audio/wav" });
    this.scheduler.push({
      chunk,
      wav,
      startAt: this.clock.timeOf(chunk.startSample),
      endAt: this.clock.timeOf(chunk.endSample),
      apiMs: 0,
      prompt: "",
    });
  }

  private async runJob(job: Job): Promise<string> {
    // Context = the latest text available when the request is sent.
    job.prompt = this.cfg.useContextPrompt ? contextPrompt(this.history) : "";
    const t0 = this.now();
    try {
      return await this.transcribe(job.wav, {
        model: this.cfg.profile.model,
        language: this.cfg.language,
        prompt: job.prompt || undefined,
      });
    } finally {
      job.apiMs = this.now() - t0;
    }
  }

  private onDone(job: Job, raw: string | null, error: unknown): void {
    this.pendingStarts.delete(job.chunk.id);
    this.finalizedEnd = Math.max(this.finalizedEnd, job.chunk.endSample);
    if (raw === null) {
      this.counts.failed++;
      this.cb.onError(error, job.chunk);
      this.afterFinal(job.chunk, "");
      this.emitStats();
      return;
    }
    const res = postprocess(raw, job.chunk, { previous: this.previous, prompt: job.prompt, language: this.cfg.language });
    if (res.dropped) {
      if (res.dropped !== "empty") this.counts.filtered++;
      this.afterFinal(job.chunk, "");
      this.emitStats();
      return;
    }
    const now = this.now();
    const latency: Latency = {
      chunkSec: (job.chunk.endSample - job.chunk.startSample) / SAMPLE_RATE,
      apiMs: job.apiMs,
      endToTextMs: now - job.endAt,
      wordDelayMs: now - (job.startAt + job.endAt) / 2,
    };
    this.latencies.push(latency);
    if (this.latencies.length > HISTORY) this.latencies.shift();
    this.previous = res.text;
    this.history = (this.history + " " + res.text).slice(-600);
    this.cb.onText(res.text, { seq: job.chunk.id, chunk: job.chunk, latency });
    this.afterFinal(job.chunk, res.text);
    this.emitStats();
  }

  // ------------------------------------------------------------ live preview

  /** Start a preview request when speech is in progress and none is running. */
  private maybePreview(): void {
    if (!this.cfg.livePreview || this.previewInFlight) return;
    const now = this.now();
    if (now - this.previewStartedAt < PREVIEW_INTERVAL_MS) return;
    const active = this.chunker.activeChunk;
    if (!active || active.speechSec < PREVIEW_MIN_SPEECH_SEC) return;
    // Cover all audio without final text yet: chunks still being transcribed
    // plus the one being recorded.
    let start = active.startSample;
    for (const s of this.pendingStarts.values()) start = Math.min(start, s);
    const end = this.samplesIn;
    start = Math.max(start, end - PREVIEW_MAX_SEC * SAMPLE_RATE, this.recent.start, this.finalizedEnd);
    if (end - start < PREVIEW_MIN_SPEECH_SEC * SAMPLE_RATE) return;

    const wav = new Blob([encodeWav(normalize(this.recent.slice(start, end)), SAMPLE_RATE)], { type: "audio/wav" });
    const generation = this.previewGeneration;
    const prompt = this.cfg.useContextPrompt ? contextPrompt(this.history) : "";
    this.previewInFlight = true;
    this.previewStartedAt = now;
    this.finalsDuringPreview = [];
    this.counts.previews++;
    this.transcribe(wav, {
      model: this.cfg.profile.model,
      language: this.cfg.language,
      prompt: prompt || undefined,
      preview: true,
    })
      .then((raw) => {
        if (generation === this.previewGeneration) this.onPreviewResult(raw, start, end, prompt);
      })
      .catch((e: unknown) => {
        // Previews are best effort; the final result still comes. When every
        // request slot was busy, nothing was sent: try again on the next packet.
        if ((e as { kind?: string })?.kind === "busy" && generation === this.previewGeneration) {
          this.counts.previews--;
          this.previewStartedAt = -Infinity;
        }
      })
      .finally(() => {
        if (generation === this.previewGeneration) this.previewInFlight = false;
      });
  }

  private onPreviewResult(raw: string, start: number, end: number, prompt: string): void {
    if (end <= this.finalizedEnd) return; // final text already covers it all
    const asChunk: AudioChunk = {
      id: 0,
      samples: new Float32Array(0),
      startSample: start,
      endSample: end,
      speechSec: (end - start) / SAMPLE_RATE,
      speechRatio: 1,
      end: "forced", // speech is still going on
      continuesSentence: false,
      overlapSec: 0,
    };
    const res = postprocess(raw, asChunk, { previous: this.previous, prompt, language: this.cfg.language });
    if (res.dropped) return;
    let text = res.text;
    // Finals that arrived while this request was running cover its start.
    for (const finalText of this.finalsDuringPreview) {
      text = trimCovered(text, finalText);
      if (!text) return;
    }
    this.setPreview({ text, end });
  }

  /** Keep only the part of the preview that a newly finalized chunk doesn't cover. */
  private afterFinal(chunk: AudioChunk, finalText: string): void {
    if (this.previewInFlight && finalText) this.finalsDuringPreview.push(finalText);
    if (!this.preview) return;
    if (this.preview.end <= chunk.endSample) return this.setPreview(null);
    if (!finalText) return;
    const rest = trimCovered(this.preview.text, finalText);
    this.setPreview(rest ? { text: rest, end: this.preview.end } : null);
  }

  private setPreview(preview: { text: string; end: number } | null): void {
    const changed = (this.preview?.text ?? "") !== (preview?.text ?? "");
    this.preview = preview;
    if (changed) this.cb.onPreview(preview?.text ?? "");
  }
}

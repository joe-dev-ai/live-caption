// The caption pipeline: PCM in → chunks → parallel transcription → ordered,
// cleaned text out. Pure TypeScript with an injected transcribe function so
// it can be unit-tested and reused outside Tauri.

import { Chunker, type AudioChunk } from "./chunker.ts";
import type { PipelineProfile } from "./profile.ts";
import { contextPrompt, postprocess } from "./postprocess.ts";
import { OrderedScheduler } from "./scheduler.ts";
import { SAMPLE_RATE } from "./vad.ts";
import { encodeWav, normalize } from "./wav.ts";

export interface PipelineConfig {
  profile: PipelineProfile;
  language: string;
  useContextPrompt: boolean;
  maxParallel: number;
}

export type TranscribeFn = (wav: Blob, opts: { model: string; language: string; prompt?: string }) => Promise<string>;

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
  avgChunkSec: number;
  avgApiMs: number;
  avgEndToTextMs: number;
  p90EndToTextMs: number;
  avgWordDelayMs: number;
}

export interface PipelineCallbacks {
  onText(text: string, meta: { seq: number; chunk: AudioChunk; latency: Latency }): void;
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
  private counts = { chunks: 0, filtered: 0, failed: 0 };
  private readonly now: () => number;

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
    this.chunker.push(f);
  }

  /** Drop all buffered audio and pending requests (used on Stop/Start). */
  reset(): void {
    this.scheduler.reset();
    this.chunker.reset();
    this.clock.reset();
    this.history = "";
    this.previous = "";
    this.latencies = [];
    this.counts = { chunks: 0, filtered: 0, failed: 0 };
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
    if (raw === null) {
      this.counts.failed++;
      this.cb.onError(error, job.chunk);
      this.emitStats();
      return;
    }
    const res = postprocess(raw, job.chunk, { previous: this.previous, prompt: job.prompt, language: this.cfg.language });
    if (res.dropped) {
      if (res.dropped !== "empty") this.counts.filtered++;
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
    this.emitStats();
  }
}

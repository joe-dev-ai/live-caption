// Runs transcription requests in parallel (bounded) and delivers results in
// the original order. Each job is retried once; failures are skipped so the
// stream never stalls. `reset()` invalidates everything in flight.

export interface SchedulerOptions<T, R> {
  maxParallel: number;
  /** Per-attempt timeout. */
  timeoutMs: number;
  /** Oldest queued jobs are dropped beyond this backlog. */
  maxQueue: number;
  run: (item: T, attempt: number) => Promise<R>;
  /** Called in sequence order with the result, or null + error on failure. */
  onDone: (item: T, result: R | null, error: unknown) => void;
  /** Return false for errors that should not be retried (e.g. not signed in). */
  isRetryable?: (error: unknown) => boolean;
  onBusyChange?: (inFlight: number) => void;
}

interface Job<T> {
  seq: number;
  item: T;
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Request timed out after ${Math.round(ms / 1000)} s`);
    this.name = "TimeoutError";
  }
}

function withTimeout<R>(p: Promise<R>, ms: number): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class OrderedScheduler<T, R> {
  private queue: Job<T>[] = [];
  private results = new Map<number, { item: T; result: R | null; error: unknown }>();
  private inFlight = 0;
  private nextSeq = 0;
  private nextEmit = 0;
  private generation = 0;
  private opts: SchedulerOptions<T, R>;

  constructor(opts: SchedulerOptions<T, R>) {
    this.opts = opts;
  }

  setMaxParallel(n: number): void {
    this.opts.maxParallel = Math.max(1, n);
    this.pump();
  }

  get busy(): number {
    return this.inFlight;
  }

  /** Queue an item; returns its sequence number. */
  push(item: T): number {
    const seq = this.nextSeq++;
    this.queue.push({ seq, item });
    while (this.queue.length > this.opts.maxQueue) {
      const dropped = this.queue.shift()!;
      this.complete(dropped, null, new Error("Dropped: transcription backlog too large"));
    }
    this.pump();
    return seq;
  }

  /** Forget all queued and in-flight work; late results are ignored. */
  reset(): void {
    this.generation++;
    this.queue = [];
    this.results.clear();
    this.inFlight = 0;
    this.nextSeq = 0;
    this.nextEmit = 0;
    this.opts.onBusyChange?.(0);
  }

  private pump(): void {
    while (this.inFlight < this.opts.maxParallel && this.queue.length) {
      const job = this.queue.shift()!;
      this.inFlight++;
      this.opts.onBusyChange?.(this.inFlight);
      void this.execute(job, this.generation);
    }
  }

  private async execute(job: Job<T>, generation: number): Promise<void> {
    let result: R | null = null;
    let error: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        result = await withTimeout(this.opts.run(job.item, attempt), this.opts.timeoutMs);
        error = null;
        break;
      } catch (e) {
        error = e;
        if (generation !== this.generation) return;
        if (this.opts.isRetryable && !this.opts.isRetryable(e)) break;
      }
    }
    if (generation !== this.generation) return;
    this.inFlight--;
    this.opts.onBusyChange?.(this.inFlight);
    this.complete(job, result, error);
    this.pump();
  }

  private complete(job: Job<T>, result: R | null, error: unknown): void {
    this.results.set(job.seq, { item: job.item, result, error });
    while (this.results.has(this.nextEmit)) {
      const r = this.results.get(this.nextEmit)!;
      this.results.delete(this.nextEmit);
      this.nextEmit++;
      this.opts.onDone(r.item, r.result, r.error);
    }
  }
}

// Caps how many requests run at once. Puter's free plan allows only 3
// speech-to-text requests per user at the same time; a 4th is refused with
// 429. Final chunks wait for a slot in arrival order; live previews only run
// when a slot is free right now (a late preview is worthless), and never
// overtake final chunks that are waiting.

export class RequestLimiter {
  private readonly max: number;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(max: number) {
    this.max = max;
  }

  /** Slots free right now. */
  get free(): number {
    return Math.max(0, this.max - this.active);
  }

  /** Wait for a slot; resolves to the function that releases it. */
  acquire(): Promise<() => void> {
    if (this.active < this.max && !this.waiting.length) return Promise.resolve(this.take());
    return new Promise((resolve) => this.waiting.push(() => resolve(this.take())));
  }

  /** A slot if one is free and nobody is waiting, otherwise null. */
  tryAcquire(): (() => void) | null {
    return this.active < this.max && !this.waiting.length ? this.take() : null;
  }

  private take(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}

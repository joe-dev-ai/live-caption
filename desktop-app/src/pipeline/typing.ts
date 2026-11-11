// Decides what to send to the Chrome extension.
//
// Final caption text is always sent as it arrives. With live typing on, each
// message also carries the provisional tail: the complete current live
// preview. The extension types it right away and corrects it in place when a
// newer message arrives, so text shows up in Chrome as early as possible
// without waiting for the final result. The last word may still be cut off
// ("wor"), but its correction is nearly always just the missing letters.

export interface TypingMessage {
  seq: number;
  /** Newly finalized text ("" when only the provisional tail changed). */
  text: string;
  /** Complete not-yet-final tail; absent when live typing is off. */
  provisional?: string;
}

export class TypingPlanner {
  private readonly send: (message: TypingMessage) => void;
  private readonly liveTyping: () => boolean;
  private finals: string[] = [];
  private preview = "";
  private sentProvisional = "";
  private seq = 0;
  private generation = 0;
  private scheduled = false;

  constructor(send: (message: TypingMessage) => void, liveTyping: () => boolean) {
    this.send = send;
    this.liveTyping = liveTyping;
  }

  /** New final caption text. */
  final(text: string): void {
    this.finals.push(text);
    this.schedule();
  }

  /** The live preview changed ("" when it was cleared). */
  previewChanged(text: string): void {
    this.preview = text;
    if (this.liveTyping()) this.schedule();
  }

  /** Forget everything (Start/Stop); a pending flush is cancelled. */
  reset(): void {
    this.generation++;
    this.finals = [];
    this.preview = "";
    this.sentProvisional = "";
    this.seq = 0;
    this.scheduled = false;
  }

  /**
   * A final result and the preview update it causes arrive back to back;
   * flushing in a microtask merges them into one message, so the extension
   * replaces the provisional tail with the final text in a single edit.
   */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const generation = this.generation;
    queueMicrotask(() => {
      if (generation !== this.generation) return;
      this.scheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    const text = this.finals.join(" ");
    this.finals = [];
    if (!this.liveTyping()) {
      if (text) this.send({ seq: ++this.seq, text });
      return;
    }
    const provisional = this.preview.trim();
    if (!text && provisional === this.sentProvisional) return;
    this.sentProvisional = provisional;
    this.send({ seq: ++this.seq, text, provisional });
  }
}

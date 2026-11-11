// Scrollable caption history for the overlay: the newest text is at the
// bottom, older lines stay available above it. While the view is scrolled to
// the bottom it follows new captions; once the user scrolls up it stays put
// and a "Latest" button jumps back down. Only the newest line is updated, so
// a long history stays cheap to render.

import { icon } from "./icons.ts";

/** Lines kept in the history (older ones are dropped to bound memory). */
export const MAX_HISTORY_LINES = 1000;
/** Distance from the bottom (px) that still counts as "at the bottom". */
const BOTTOM_SLACK_PX = 24;

/** Whether the next caption chunk should start a new line instead of extending `current`. */
export function startsNewLine(current: string, msSinceLastText: number): boolean {
  if (!current) return false;
  const endsSentence = /[.!?…]["'”’)]?$/.test(current);
  return msSinceLastText > 4000 || (endsSentence && current.length > 70) || current.length > 220;
}

export function isNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= BOTTOM_SLACK_PX;
}

export class CaptionView {
  private readonly scroller: HTMLElement;
  private readonly stack: HTMLElement;
  private readonly jump: HTMLButtonElement;
  private readonly placeholder: HTMLElement;
  private line: HTMLElement | null = null;
  private finalSpan: HTMLSpanElement | null = null;
  private previewSpan: HTMLSpanElement | null = null;
  private current = "";
  private lastTextAt = 0;

  constructor(scroller: HTMLElement, jump: HTMLButtonElement) {
    this.scroller = scroller;
    this.jump = jump;
    this.stack = document.createElement("div");
    this.stack.className = "stack";
    this.placeholder = document.createElement("div");
    this.placeholder.className = "placeholder";
    this.stack.append(this.placeholder);
    scroller.replaceChildren(this.stack);

    jump.innerHTML = `${icon("arrowDown")}<span>Latest</span>`;
    jump.hidden = true;
    jump.addEventListener("mousedown", (e) => e.preventDefault());
    jump.addEventListener("click", () => this.scrollToBottom());
    scroller.addEventListener("scroll", () => {
      if (this.atBottom()) this.jump.hidden = true;
    });
  }

  /** Caption text the user selected with the mouse ("" if none). */
  selectedText(): string {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
    const range = sel.getRangeAt(0);
    if (!this.scroller.contains(range.commonAncestorContainer)) return "";
    return sel.toString().trim();
  }

  /** All final caption text, one line per caption line (no live preview). */
  allText(): string {
    return [...this.stack.querySelectorAll<HTMLElement>(".line > span:first-child")]
      .map((s) => s.textContent ?? "")
      .filter(Boolean)
      .join("\n");
  }

  /** Remove every caption from the view (captioning itself keeps running). */
  clear(): void {
    this.stack.replaceChildren(this.placeholder);
    this.line = null;
    this.finalSpan = null;
    this.previewSpan = null;
    this.current = "";
    this.lastTextAt = 0;
    this.jump.hidden = true;
    document.getSelection()?.removeAllRanges();
  }

  /** Text shown while there are no captions yet. */
  setPlaceholder(text: string): void {
    this.placeholder.textContent = text;
  }

  /** Add finalized caption text. */
  append(text: string, now = Date.now()): void {
    this.update(() => {
      if (!this.line || startsNewLine(this.current, now - this.lastTextAt)) this.newLine();
      this.current = this.current ? `${this.current} ${text}` : text;
      this.finalSpan!.textContent = this.current;
      this.lastTextAt = now;
    });
  }

  /** Provisional text for speech that is not final yet ("" hides it). */
  setPreview(text: string): void {
    this.update(() => {
      if (text && !this.line) this.newLine();
      if (!this.previewSpan) return;
      this.previewSpan.textContent = text && this.current ? ` ${text}` : text;
      this.previewSpan.hidden = !text;
    });
  }

  /** Show that more text is on its way (the animated "…"). */
  setPending(pending: boolean): void {
    this.line?.classList.toggle("pending", pending);
  }

  /** Mark the start of a new captioning session below the existing history. */
  addSeparator(label: string): void {
    if (!this.line) return;
    this.update(() => {
      const sep = document.createElement("div");
      sep.className = "separator";
      sep.textContent = label;
      this.closeLine();
      this.stack.append(sep);
      this.line = null;
    });
  }

  private newLine(): void {
    this.closeLine();
    this.placeholder.remove();
    const line = document.createElement("div");
    line.className = "line";
    this.finalSpan = document.createElement("span");
    this.previewSpan = document.createElement("span");
    this.previewSpan.className = "preview";
    this.previewSpan.hidden = true;
    line.append(this.finalSpan, this.previewSpan);
    this.stack.append(line);
    this.line = line;
    this.current = "";
    // Bound the history.
    const lines = this.stack.children;
    while (lines.length > MAX_HISTORY_LINES) lines[0].remove();
  }

  /** Freeze the current line: drop its preview and pending marker, dim it. */
  private closeLine(): void {
    if (!this.line) return;
    this.previewSpan?.remove();
    this.line.classList.remove("pending");
    this.line.classList.add("old");
    this.previewSpan = null;
  }

  /** Apply a DOM change, keeping the view pinned to the bottom if it was there. */
  private update(change: () => void): void {
    // Don't scroll away from text the user is selecting.
    const follow = this.atBottom() && !this.selectedText();
    change();
    if (follow) this.scrollToBottom();
    else this.jump.hidden = false;
  }

  private atBottom(): boolean {
    const s = this.scroller;
    return isNearBottom(s.scrollHeight, s.scrollTop, s.clientHeight);
  }

  private scrollToBottom(): void {
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.jump.hidden = true;
  }
}

// Cleans raw model output so consecutive chunks read as one natural text:
// hallucination filtering, repeat collapsing, overlap de-duplication and
// punctuation/capitalisation smoothing across chunk boundaries.

import type { AudioChunk } from "./chunker.ts";

export interface PostContext {
  /** Text emitted for the previous chunk ("" if none). */
  previous: string;
  /** Context prompt sent with this request ("" if none). */
  prompt: string;
  language: string;
}

export interface PostResult {
  text: string;
  /** Why the text was dropped, if it was. */
  dropped?: "empty" | "hallucination" | "echo";
}

/** Phrases models produce from silence/noise; removed wherever they appear. */
const ALWAYS_DROP: RegExp[] = [
  /\bthanks? (you )?(so much |very much )?for watching\b/i,
  /\bsubtitles? (by|created by|provided by|made by)\b/i,
  /\b(closed )?captions? (by|provided by)\b/i,
  /\btranscri(bed|ption|pts?) (by|provided by)\b/i,
  /\bamara\.org\b/i,
  /\b(please|don'?t forget to) (like and )?subscribe\b/i,
  /\blike and subscribe\b/i,
  /\bsee you (in|on) the next (video|one|episode)\b/i,
];

/** Short phrases that are hallucinations only when the chunk is mostly silence. */
const WEAK_DROP = new Set([
  "thank you", "thanks", "thank you very much", "thank you so much", "you", "bye", "bye bye",
  "thank you for listening", "the end", "music", "applause",
]);

/** Common function words that should be lower-case mid-sentence. */
const COMMON_LOWER = new Set(
  ("a an and are as at be but by can could did do does for from had has have he her him his how if in into is it " +
    "its it's just like me my no not of on or our she so than that that's the their them then there these they " +
    "this those to too us was we were what when where which while who why will with would you your yeah yes okay " +
    "well also because about after before over under up down out all some any").split(" "),
);

const LATIN_LANGS = new Set([
  "en", "es", "fr", "de", "it", "pt", "nl", "sv", "da", "no", "nb", "fi", "pl", "cs", "sk", "ro", "hu", "tr",
  "id", "ms", "vi", "ca", "hr", "sl", "et", "lv", "lt", "tl",
]);

const word = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

export function normalizeSpaces(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:%])/g, "$1")
    .trim();
}

/** Split into sentences, keeping their punctuation. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+/).filter(Boolean);
}

function normalizedPhrase(text: string): string {
  return text.split(/\s+/).map(word).filter(Boolean).join(" ");
}

function isMostlyNonLatin(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return false;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  return latin / letters.length < 0.5;
}

/** Collapse a phrase repeated 3+ times in a row (4+ for single words). */
export function collapseRepeats(text: string): string {
  let tokens = text.split(/\s+/).filter(Boolean);
  let changed = true;
  while (changed) {
    changed = false;
    for (let n = 1; n <= 8 && !changed; n++) {
      const minRepeats = n === 1 ? 4 : 3;
      for (let i = 0; i + n * minRepeats <= tokens.length; i++) {
        const unit = tokens.slice(i, i + n).map(word).join(" ");
        if (!unit) continue;
        let reps = 1;
        while (
          i + (reps + 1) * n <= tokens.length &&
          tokens.slice(i + reps * n, i + (reps + 1) * n).map(word).join(" ") === unit
        ) {
          reps++;
        }
        if (reps >= minRepeats) {
          tokens = [...tokens.slice(0, i + n), ...tokens.slice(i + reps * n)];
          changed = true;
          break;
        }
      }
    }
  }
  return tokens.join(" ");
}

/**
 * Remove words at the start of `text` that repeat the end of `previous`
 * (caused by the audio overlap between force-cut chunks).
 */
export function removeOverlap(previous: string, text: string, maxWords = 6): string {
  const prev = previous.split(/\s+/).map(word).filter(Boolean);
  const tokens = text.split(/\s+/).filter(Boolean);
  const cur = tokens.map(word);
  for (let k = Math.min(maxWords, prev.length, cur.length); k >= 1; k--) {
    const tail = prev.slice(prev.length - k).join(" ");
    const head = cur.slice(0, k).join(" ");
    if (tail === head && (k > 1 || head.length >= 3)) {
      return tokens.slice(k).join(" ");
    }
  }
  return text;
}

const endsSentence = (t: string) => /[.!?…]["'”’)\]]?$/.test(t.trim());

export function postprocess(raw: string, chunk: AudioChunk, ctx: PostContext): PostResult {
  let text = normalizeSpaces(raw ?? "");
  if (!text) return { text: "", dropped: "empty" };

  // Wrong-script output for a Latin-script language is a classic silence hallucination.
  if (LATIN_LANGS.has(ctx.language) && isMostlyNonLatin(text)) return { text: "", dropped: "hallucination" };

  // Remove known hallucinated sentences anywhere in the chunk.
  text = sentences(text)
    .filter((s) => !ALWAYS_DROP.some((re) => re.test(s)))
    .join(" ");
  const phrase = normalizedPhrase(text);
  if (!phrase) return { text: "", dropped: "hallucination" };
  if (WEAK_DROP.has(phrase) && (chunk.speechRatio < 0.4 || chunk.speechSec < 0.4)) {
    return { text: "", dropped: "hallucination" };
  }
  // The model sometimes echoes the context prompt or the previous chunk on unclear audio.
  if (chunk.speechRatio < 0.5) {
    if (ctx.prompt && normalizedPhrase(ctx.prompt).includes(phrase)) return { text: "", dropped: "echo" };
    if (ctx.previous && normalizedPhrase(ctx.previous) === phrase) return { text: "", dropped: "echo" };
  }

  text = collapseRepeats(text);
  if (chunk.continuesSentence && ctx.previous) {
    text = removeOverlap(ctx.previous, text);
    if (!text) return { text: "", dropped: "empty" };
  }

  // The speaker did not pause, so the model's sentence-final period is wrong.
  if (chunk.end !== "pause") text = text.replace(/(?<![.])\.$/, "");

  // Continue a sentence started in the previous chunk in lower case.
  if (chunk.continuesSentence && ctx.previous && !endsSentence(ctx.previous)) {
    const m = text.match(/^(\S+)/);
    if (m && COMMON_LOWER.has(word(m[1])) && m[1] !== "I" && !/^I'/.test(m[1])) {
      text = text.charAt(0).toLowerCase() + text.slice(1);
    }
  }
  text = normalizeSpaces(text);
  return text ? { text } : { text: "", dropped: "empty" };
}

/** Last one or two sentences of the transcript, used as the context prompt. */
export function contextPrompt(history: string, maxChars = 220): string {
  const s = sentences(history.trim());
  let out = s.slice(-2).join(" ");
  if (out.length > maxChars) out = out.slice(out.length - maxChars).replace(/^\S*\s/, "");
  return out;
}

/**
 * Remove the start of a live preview that a newly finalized chunk already
 * covers, so the same words are not shown twice. The preview and the final
 * text start at the same audio, so the final's last words are looked for near
 * the position where they should appear in the preview. Returns "" when the
 * two cannot be aligned (the preview is then hidden until the next one).
 */
export function trimCovered(preview: string, finalText: string): string {
  const tokens = preview.split(/\s+/).filter(Boolean);
  const pw = tokens.map(word);
  const fw = finalText.split(/\s+/).map(word).filter(Boolean);
  if (!fw.length) return preview;
  for (const k of [2, 1]) {
    if (fw.length < k || (k === 1 && fw[fw.length - 1].length < 3)) continue;
    const anchor = fw.slice(fw.length - k).join(" ");
    const from = Math.max(0, fw.length - k - 3);
    const to = Math.min(pw.length - k, fw.length - k + 3);
    for (let j = from; j <= to; j++) {
      if (pw.slice(j, j + k).join(" ") === anchor) return tokens.slice(j + k).join(" ");
    }
  }
  return "";
}

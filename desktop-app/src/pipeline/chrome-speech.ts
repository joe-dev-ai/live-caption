// The "Chrome" speech engine, app side. The Chrome extension's speech page
// recognizes the captured audio with Chrome's built-in speech recognition and
// sends back, with each update, the newly final text and the current interim
// (not yet final) text. This turns them into captions: final text is cleaned
// and emitted as it arrives, the interim text is the live preview.
//
// The delay is measured like the Puter pipeline's: the same audio that goes
// to Chrome runs through the VAD here, and each utterance's delay is the time
// from the start of its speech to its first words on screen.

import { collapseRepeats, normalizeSpaces } from "./postprocess.ts";
import { FRAME_SAMPLES, SAMPLE_RATE, Vad } from "./vad.ts";

/** BCP 47 tags Chrome's recognizer expects for the app's language codes. */
const SPEECH_LANGS: Record<string, string> = {
  en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE", it: "it-IT", pt: "pt-BR", nl: "nl-NL", sv: "sv-SE",
  da: "da-DK", no: "nb-NO", fi: "fi-FI", pl: "pl-PL", cs: "cs-CZ", ro: "ro-RO", hu: "hu-HU", el: "el-GR",
  tr: "tr-TR", ru: "ru-RU", uk: "uk-UA", ar: "ar-SA", he: "he-IL", hi: "hi-IN", ja: "ja-JP", ko: "ko-KR",
  zh: "zh-CN", vi: "vi-VN", id: "id-ID", th: "th-TH", tl: "fil-PH",
};

export function speechLang(language: string): string {
  return SPEECH_LANGS[language] ?? language;
}

const endsSentence = (t: string) => /[.!?…。？！]["'”’)\]]?$/.test(t.trim());
const hasPunctuation = (t: string) => /[.,!?;:…。，？！]/.test(t);

/**
 * Clean recognized text for display and typing: spacing, repeats, a capital
 * at the start of a sentence, "I" in English. With `endSentence` an
 * unpunctuated text gets a full stop. The interim text gets the same capital
 * as its final will, so typed words only change where the recognizer really
 * changed them.
 */
export function formatSpeech(text: string, previous: string, language: string, endSentence: boolean): string {
  let t = collapseRepeats(normalizeSpaces(text));
  if (!t) return "";
  if (language === "en") t = t.replace(/\bi\b/g, "I").replace(/\bi(?=['’](m|ll|ve|d)\b)/g, "I");
  if (!previous || endsSentence(previous)) t = t.charAt(0).toUpperCase() + t.slice(1);
  if (endSentence && !hasPunctuation(t)) t += language === "ja" || language === "zh" ? "。" : ".";
  return t;
}

export interface SpeechStats {
  finals: number;
  /** Average time from the start of speech to its first words on screen. */
  avgFirstWordsMs: number;
  /** Average time from an utterance's first words to its final text. */
  avgFinalizeMs: number;
}

export interface SpeechCallbacks {
  onText(text: string): void;
  /** Interim text for speech that is not final yet; "" hides it. */
  onPreview(text: string): void;
  onStats(stats: SpeechStats): void;
}

/** Silence before speech that makes it the start of a new utterance. */
const UTTERANCE_GAP_SEC = 0.4;
/** Longer "delays" mean the speech start was missed (e.g. noise); they are not counted. */
const MAX_DELAY_MS = 10000;
const HISTORY = 30;

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pushBounded = (a: number[], v: number) => {
  a.push(v);
  if (a.length > HISTORY) a.shift();
};

export class ChromeSpeech {
  private readonly cb: SpeechCallbacks;
  private readonly now: () => number;
  private language = "en";
  private previous = "";
  private interim = "";
  /**
   * Chrome's online recognizer returns unpunctuated text, its on-device one
   * punctuates. Until punctuation shows up, each final result (which ends at
   * a pause) is treated as a sentence of its own.
   */
  private punctuates = false;
  private finals = 0;
  private readonly vad = new Vad();
  private silentSec = Infinity;
  /** When the speech of the utterance not yet on screen started (ms), or 0. */
  private speechStartAt = 0;
  /** When the current utterance's first words appeared (ms), or 0. */
  private firstWordsAt = 0;
  private firstWordsMs: number[] = [];
  private finalizeMs: number[] = [];

  constructor(cb: SpeechCallbacks, now: () => number = () => performance.now()) {
    this.cb = cb;
    this.now = now;
  }

  setLanguage(language: string): void {
    this.language = language;
  }

  /** The audio Chrome is recognizing (16 kHz mono 16-bit PCM), used only to time the delay. */
  pushPcm(pcm: Int16Array): void {
    const now = this.now();
    const frame = new Float32Array(FRAME_SAMPLES);
    for (let start = 0; start + FRAME_SAMPLES <= pcm.length; start += FRAME_SAMPLES) {
      for (let i = 0; i < FRAME_SAMPLES; i++) frame[i] = pcm[start + i] / 32768;
      if (!this.vad.frame(frame).speech) {
        this.silentSec += FRAME_SAMPLES / SAMPLE_RATE;
        continue;
      }
      if (this.silentSec >= UTTERANCE_GAP_SEC && !this.interim) {
        this.speechStartAt = now - ((pcm.length - start) / SAMPLE_RATE) * 1000;
      }
      this.silentSec = 0;
    }
  }

  /** One update from Chrome: newly final text and the current interim text. */
  update(final: string, interim: string): void {
    const now = this.now();
    if ((final || interim) && !this.firstWordsAt) {
      this.firstWordsAt = now;
      if (this.speechStartAt && now - this.speechStartAt <= MAX_DELAY_MS) {
        pushBounded(this.firstWordsMs, now - this.speechStartAt);
      }
      this.speechStartAt = 0;
    }
    if (hasPunctuation(final)) this.punctuates = true;
    const text = formatSpeech(final, this.previous, this.language, !this.punctuates);
    if (text) {
      this.finals++;
      pushBounded(this.finalizeMs, now - this.firstWordsAt);
      this.previous = text;
      this.cb.onText(text);
    }
    if (final) this.firstWordsAt = interim ? now : 0;
    this.interim = formatSpeech(interim, this.previous, this.language, false);
    this.cb.onPreview(this.interim);
    if (text) this.cb.onStats(this.stats);
  }

  /** Whether words are still waiting to be finalized. */
  get pending(): boolean {
    return !!this.interim;
  }

  get stats(): SpeechStats {
    return { finals: this.finals, avgFirstWordsMs: avg(this.firstWordsMs), avgFinalizeMs: avg(this.finalizeMs) };
  }

  /** Forget everything (Start/Stop). */
  reset(): void {
    this.previous = "";
    this.interim = "";
    this.punctuates = false;
    this.finals = 0;
    this.vad.reset();
    this.silentSec = Infinity;
    this.speechStartAt = 0;
    this.firstWordsAt = 0;
    this.firstWordsMs = [];
    this.finalizeMs = [];
    this.cb.onPreview("");
    this.cb.onStats(this.stats);
  }
}

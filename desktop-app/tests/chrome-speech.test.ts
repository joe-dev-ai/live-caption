import { test } from "node:test";
import assert from "node:assert/strict";
import { ChromeSpeech, formatSpeech, speechLang, type SpeechStats } from "../src/pipeline/chrome-speech.ts";

function engine() {
  let now = 0;
  const texts: string[] = [];
  const previews: string[] = [];
  let stats: SpeechStats | null = null;
  const speech = new ChromeSpeech(
    {
      onText: (t) => texts.push(t),
      onPreview: (t) => previews.push(t),
      onStats: (s) => (stats = s),
    },
    () => now,
  );
  return {
    speech,
    texts,
    previews,
    stats: () => stats,
    at: (ms: number) => (now = ms),
  };
}

/** 100 ms of 16 kHz PCM: a loud tone for speech, zeros for silence. */
function packet(speech: boolean): Int16Array {
  const pcm = new Int16Array(1600);
  if (speech) for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin(i / 3));
  return pcm;
}

test("app languages map to the BCP 47 tags Chrome expects", () => {
  assert.equal(speechLang("en"), "en-US");
  assert.equal(speechLang("no"), "nb-NO");
  assert.equal(speechLang("tl"), "fil-PH");
  assert.equal(speechLang("xx-YY"), "xx-YY");
});

test("unpunctuated final results become sentences; punctuated ones are kept", () => {
  assert.equal(formatSpeech("hello  how are you", "", "en", true), "Hello how are you.");
  assert.equal(formatSpeech("and i'm fine i think", "Hello.", "en", true), "And I'm fine I think.");
  assert.equal(formatSpeech("Hello, how are you?", "", "en", true), "Hello, how are you?");
  assert.equal(formatSpeech("then we left", "We met at noon,", "en", false), "then we left");
  assert.equal(formatSpeech("こんにちは", "", "ja", true), "こんにちは。");
  assert.equal(formatSpeech("   ", "", "en", true), "");
});

test("interim text gets the capital its final will get, but no period", () => {
  assert.equal(formatSpeech("hello how", "", "en", false), "Hello how");
  assert.equal(formatSpeech("hello how", "Fine.", "en", false), "Hello how");
});

test("final text is emitted, interim text is the preview", () => {
  const e = engine();
  e.speech.update("", "hello");
  e.speech.update("", "hello world");
  e.speech.update("hello world", "");
  assert.deepEqual(e.texts, ["Hello world."]);
  assert.deepEqual(e.previews, ["Hello", "Hello world", ""]);
});

test("once the recognizer punctuates, finals are no longer closed with a period", () => {
  const e = engine();
  e.speech.update("We met at noon,", "");
  e.speech.update("then we left", "");
  e.speech.update("and went home.", "");
  assert.deepEqual(e.texts, ["We met at noon,", "then we left", "and went home."]);
});

test("a final and the next utterance's interim can arrive together", () => {
  const e = engine();
  e.speech.update("good morning", "how are");
  assert.deepEqual(e.texts, ["Good morning."]);
  assert.deepEqual(e.previews, ["How are"]);
  assert.equal(e.speech.pending, true);
  e.speech.update("how are you", "");
  assert.deepEqual(e.texts, ["Good morning.", "How are you."]);
  assert.equal(e.speech.pending, false);
});

test("the delay runs from the start of speech to its first words, and on to the final", () => {
  const e = engine();
  // 1 s of silence, then speech starting with the packet received at t = 1100 ms.
  for (let t = 100; t <= 1000; t += 100) {
    e.at(t);
    e.speech.pushPcm(packet(false));
  }
  for (let t = 1100; t <= 2000; t += 100) {
    e.at(t);
    e.speech.pushPcm(packet(true));
  }
  e.at(1700);
  e.speech.update("", "hello");
  e.at(2900);
  e.speech.update("hello there", "");
  const s = e.stats()!;
  assert.equal(s.finals, 1);
  // The speech started 100 ms before the first speech packet arrived (at 1000 ms).
  assert.equal(Math.round(s.avgFirstWordsMs), 700);
  assert.equal(Math.round(s.avgFinalizeMs), 1200);
});

test("reset clears the preview and the statistics", () => {
  const e = engine();
  e.speech.update("one two", "three");
  e.speech.reset();
  assert.equal(e.previews.at(-1), "");
  assert.deepEqual(e.stats(), { finals: 0, avgFirstWordsMs: 0, avgFinalizeMs: 0 });
  assert.equal(e.speech.pending, false);
  // A new session starts a new sentence.
  e.speech.update("four", "");
  assert.deepEqual(e.texts.at(-1), "Four.");
});

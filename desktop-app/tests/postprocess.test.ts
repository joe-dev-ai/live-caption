import { test } from "node:test";
import assert from "node:assert/strict";
import type { AudioChunk } from "../src/pipeline/chunker.ts";
import { collapseRepeats, contextPrompt, postprocess, removeOverlap, trimCovered } from "../src/pipeline/postprocess.ts";

function chunk(p: Partial<AudioChunk> = {}): AudioChunk {
  return {
    id: 1, samples: new Float32Array(0), startSample: 0, endSample: 48000, speechSec: 2, speechRatio: 0.8,
    end: "pause", continuesSentence: false, overlapSec: 0, ...p,
  };
}
const ctx = { previous: "", prompt: "", language: "en" };

test("drops classic silence hallucinations", () => {
  for (const t of ["Thank you for watching.", "Subtitles by the Amara.org community", "Please subscribe!", "Transcribed by ESO."]) {
    assert.equal(postprocess(t, chunk(), ctx).dropped, "hallucination", t);
  }
});

test("removes a hallucinated sentence but keeps real speech", () => {
  assert.equal(postprocess("Let's meet at noon. Thanks for watching!", chunk(), ctx).text, "Let's meet at noon.");
});

test("short phrases are dropped only when the chunk is mostly silence", () => {
  assert.equal(postprocess("Thank you.", chunk({ speechRatio: 0.2, speechSec: 0.3 }), ctx).dropped, "hallucination");
  assert.equal(postprocess("Thank you.", chunk({ speechRatio: 0.7, speechSec: 0.9 }), ctx).text, "Thank you.");
});

test("drops wrong-script output for English", () => {
  assert.equal(postprocess("ご視聴ありがとうございました", chunk(), ctx).dropped, "hallucination");
  assert.equal(postprocess("Café au lait, s'il vous plaît.", chunk(), { ...ctx, language: "fr" }).text, "Café au lait, s'il vous plaît.");
});

test("drops prompt echoes on unclear audio", () => {
  const c = { ...ctx, prompt: "My name is Joe. I work at Acme." };
  assert.equal(postprocess("I work at Acme.", chunk({ speechRatio: 0.3 }), c).dropped, "echo");
  assert.equal(postprocess("I work at Acme.", chunk({ speechRatio: 0.9 }), c).text, "I work at Acme.");
});

test("collapses repeated phrases", () => {
  assert.equal(collapseRepeats("I think I think I think we should go"), "I think we should go");
  assert.equal(collapseRepeats("no no no"), "no no no");
  assert.equal(collapseRepeats("go go go go now"), "go now");
});

test("removes words duplicated by the chunk overlap", () => {
  assert.equal(removeOverlap("we are going to the", "the store tomorrow"), "store tomorrow");
  assert.equal(removeOverlap("we should talk about", "talk about it later"), "it later");
  assert.equal(removeOverlap("I like it", "a lot"), "a lot");
  // Short single words are not treated as duplicates.
  assert.equal(removeOverlap("go to", "to me"), "to me");
});

test("smooths punctuation and capitalisation across a forced cut", () => {
  const a = postprocess("We need to finish the.", chunk({ end: "forced" }), ctx);
  assert.equal(a.text, "We need to finish the");
  const b = postprocess("The report by Friday.", chunk({ continuesSentence: true }), { ...ctx, previous: a.text });
  assert.equal(b.text, "report by Friday.", "overlap word removed");
  const c = postprocess("And then we leave.", chunk({ continuesSentence: true }), { ...ctx, previous: "we finish" });
  assert.equal(c.text, "and then we leave.");
  const d = postprocess("I think so.", chunk({ continuesSentence: true }), { ...ctx, previous: "and" });
  assert.equal(d.text, "I think so.");
  // Proper nouns keep their capital letter.
  const e = postprocess("Microsoft announced it.", chunk({ continuesSentence: true }), { ...ctx, previous: "yesterday" });
  assert.equal(e.text, "Microsoft announced it.");
});

test("normalises whitespace", () => {
  assert.equal(postprocess("  Hello ,   world  !  ", chunk(), ctx).text, "Hello, world!");
});

test("context prompt is the last two sentences", () => {
  assert.equal(contextPrompt("One. Two is here. Three is last."), "Two is here. Three is last.");
  assert.ok(contextPrompt("word ".repeat(200)).length <= 220);
});

test("trims the part of a live preview that the final text already covers", () => {
  assert.equal(trimCovered("We are going to the store and then home", "We are going to the store."), "and then home");
  // Small wording differences at the start do not matter; the end anchors it.
  assert.equal(trimCovered("We are going to the store and then", "We're going to the store"), "and then");
  assert.equal(trimCovered("hello there", "hello there"), "");
  // Cannot align: hide the preview rather than show duplicated words.
  assert.equal(trimCovered("something else entirely", "We are going to the store"), "");
  assert.equal(trimCovered("keep me", ""), "keep me");
});

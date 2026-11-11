import { test } from "node:test";
import assert from "node:assert/strict";
import { Chunker, type AudioChunk } from "../src/pipeline/chunker.ts";
import { profileFor } from "../src/pipeline/profile.ts";
import { SAMPLE_RATE } from "../src/pipeline/vad.ts";
import { concat, feed, silence, speech } from "./helpers.ts";

const balanced = profileFor("balanced", "auto");

function run(signal: Float32Array, profile = balanced): { chunks: AudioChunk[]; chunker: Chunker } {
  const chunks: AudioChunk[] = [];
  const chunker = new Chunker(profile, (c) => chunks.push(c));
  feed((s) => chunker.push(s), signal);
  return { chunks, chunker };
}

const sec = (samples: number) => samples / SAMPLE_RATE;

test("silence produces no chunks", () => {
  const { chunks } = run(silence(10));
  assert.equal(chunks.length, 0);
});

test("cuts at natural pauses, never inside speech", () => {
  // speech 0.5–2.5 s, pause 0.6 s, speech 3.1–4.3 s, silence
  const signal = concat(silence(0.5), speech(2.0), silence(0.6), speech(1.2), silence(1.5));
  const { chunks } = run(signal);
  assert.equal(chunks.length, 2);
  const [a, b] = chunks;
  assert.equal(a.end, "pause");
  assert.equal(b.end, "pause");
  // First chunk starts with pre-roll before 0.5 s and ends inside the pause.
  assert.ok(sec(a.startSample) >= 0.15 && sec(a.startSample) <= 0.5, `start ${sec(a.startSample)}`);
  assert.ok(sec(a.endSample) > 2.5 && sec(a.endSample) < 3.1, `end ${sec(a.endSample)}`);
  // Second chunk covers the second utterance completely.
  assert.ok(sec(b.startSample) < 3.1 && sec(b.endSample) > 4.3);
  assert.ok(!a.continuesSentence && !b.continuesSentence);
});

test("a short utterance is emitted after a long silence", () => {
  const { chunks } = run(concat(silence(1), speech(0.6), silence(1.2)));
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].speechSec >= 0.5);
});

test("short pauses before the minimum length do not cut", () => {
  // 0.8 s speech, 0.35 s pause (< 0.7 s), 0.8 s speech: one chunk.
  const { chunks } = run(concat(silence(0.5), speech(0.8), silence(0.35), speech(0.8), silence(1.2)));
  assert.equal(chunks.length, 1);
});

test("long speech is force-cut at the quietest point with 0.2 s overlap", () => {
  // Continuous speech with a brief 60 ms dip at ~3.75 s (inside the last
  // 0.5 s before 4 s, too short to count as a word gap).
  const s = concat(silence(0.3), speech(9));
  const dip = Math.round(3.744 * SAMPLE_RATE);
  for (let i = dip; i < dip + 960; i++) s[i] *= 0.02;
  const { chunks } = run(concat(s, silence(1.5)));
  assert.ok(chunks.length >= 3, `got ${chunks.length}`);
  const [a, b] = chunks;
  assert.equal(a.end, "forced");
  assert.ok(sec(a.endSample) > 3.744 && sec(a.endSample) <= 3.744 + 0.061, `cut at ${sec(a.endSample)}`);
  assert.ok(sec(a.endSample - a.startSample) <= balanced.maxChunkSec + 0.01);
  assert.ok(b.continuesSentence);
  assert.ok(Math.abs(b.overlapSec - 0.2) < 1e-9);
  assert.ok(Math.abs(sec(a.endSample - b.startSample) - 0.2) < 1e-9, "next chunk starts 0.2 s earlier");
  assert.equal(chunks[chunks.length - 1].end, "pause");
});

test("near the maximum, a short gap between words is used as the cut point", () => {
  // 3.2 s of speech, a 140 ms word gap, more speech: cut in the gap, no overlap.
  const { chunks } = run(concat(silence(0.3), speech(3.2), silence(0.14), speech(1.5), silence(1.5)));
  assert.equal(chunks.length, 2);
  const [a, b] = chunks;
  assert.equal(a.end, "gap");
  assert.ok(sec(a.endSample) > 3.5 && sec(a.endSample) < 3.64, `cut at ${sec(a.endSample)}`);
  assert.ok(sec(b.startSample) === sec(a.endSample), "next chunk starts at the cut");
  assert.ok(b.continuesSentence, "next chunk continues the sentence");
  assert.equal(b.overlapSec, 0);
});

test("a word gap before the gap window does not cut", () => {
  // Gap at 1.8 s (< max - 1 s = 3 s): not a cut point; real pause later is.
  const { chunks } = run(concat(silence(0.3), speech(1.8), silence(0.14), speech(1.0), silence(1.5)));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].end, "pause");
});

test("a sentence pause near the maximum is still a pause, not a gap", () => {
  const { chunks } = run(concat(silence(0.3), speech(3.3), silence(0.8), speech(1.0), silence(1.5)));
  assert.equal(chunks[0].end, "pause");
  assert.equal(chunks[1].continuesSentence, false);
});

test("isolated clicks are skipped as silent chunks", () => {
  const { chunks, chunker } = run(concat(silence(1), speech(0.06), silence(1.5), speech(0.06), silence(1.5)));
  assert.equal(chunks.length, 0);
  assert.equal(chunker.skipped, 2);
});

test("priority changes chunk length", () => {
  const long = concat(silence(0.3), speech(12), silence(1.5));
  const speed = run(long, profileFor("speed", "auto")).chunks;
  const accuracy = run(long, profileFor("accuracy", "auto")).chunks;
  assert.ok(speed.length > accuracy.length);
  for (const c of accuracy) assert.ok(sec(c.endSample - c.startSample) <= 5.01);
  for (const c of speed) assert.ok(sec(c.endSample - c.startSample) <= 3.01);
});

test("reports the chunk being recorded while speech is in progress", () => {
  const chunks: AudioChunk[] = [];
  const chunker = new Chunker(balanced, (c) => chunks.push(c));
  feed((s) => chunker.push(s), silence(1));
  assert.equal(chunker.activeChunk, null);
  feed((s) => chunker.push(s), speech(1.2));
  const active = chunker.activeChunk!;
  assert.ok(sec(active.startSample) >= 0.65 && sec(active.startSample) <= 1.0, `start ${sec(active.startSample)}`);
  assert.ok(active.speechSec > 1.0);
  feed((s) => chunker.push(s), silence(1.2));
  assert.equal(chunker.activeChunk, null, "finished at the pause");
  assert.equal(chunks.length, 1);
});

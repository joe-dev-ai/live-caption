import { test } from "node:test";
import assert from "node:assert/strict";
import { werWords, wordErrorRate } from "../src/pipeline/wer.ts";

test("normalises case and punctuation", () => {
  assert.deepEqual(werWords("Hello, World! It's well-known."), ["hello", "world", "it's", "well", "known"]);
  assert.equal(wordErrorRate("Hello, world.", "hello world").wer, 0);
});

test("counts substitutions, deletions and insertions", () => {
  const r = wordErrorRate("the quick brown fox jumps", "the quack brown jumps high");
  assert.equal(r.substitutions + r.deletions + r.insertions, 3);
  assert.equal(r.referenceWords, 5);
  assert.ok(Math.abs(r.wer - 0.6) < 1e-9);
  const u = wordErrorRate("alpha beta gamma delta", "alpha gamma delta epsilon zeta");
  assert.deepEqual([u.substitutions, u.deletions, u.insertions], [0, 1, 2]);
});

test("edge cases", () => {
  assert.equal(wordErrorRate("", "").wer, 0);
  assert.equal(wordErrorRate("one two", "").wer, 1);
});

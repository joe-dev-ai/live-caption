import { test } from "node:test";
import assert from "node:assert/strict";
import { isNearBottom, startsNewLine } from "../src/ui/captions.ts";

test("a new caption line starts after a long gap, a finished long sentence, or a very long line", () => {
  assert.equal(startsNewLine("", 10_000), false, "first text goes on the first line");
  assert.equal(startsNewLine("Short phrase", 1000), false);
  assert.equal(startsNewLine("Short phrase", 4500), true, "pause in the conversation");
  assert.equal(startsNewLine("A finished sentence that is clearly already more than seventy characters long.", 500), true);
  assert.equal(startsNewLine("An unfinished sentence that is clearly already more than seventy characters long", 500), false);
  assert.equal(startsNewLine("x".repeat(221), 0), true);
});

test("the view follows new captions only while it is scrolled to the bottom", () => {
  assert.equal(isNearBottom(1000, 800, 200), true);
  assert.equal(isNearBottom(1000, 780, 200), true, "within the slack");
  assert.equal(isNearBottom(1000, 500, 200), false, "user scrolled up to reread");
  assert.equal(isNearBottom(150, 0, 200), true, "no scrollbar yet");
});

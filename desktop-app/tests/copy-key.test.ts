import { test } from "node:test";
import assert from "node:assert/strict";
import { CopyKey } from "../src/ui/copy-key.ts";

function key() {
  const calls: boolean[] = [];
  return { k: new CopyKey((b) => calls.push(b)), calls };
}

test("Ctrl+C is borrowed only while pointing at selected captions", () => {
  const { k, calls } = key();
  k.hover(true);
  assert.deepEqual(calls, []); // nothing selected yet
  k.selection(true);
  assert.deepEqual(calls, [true]);
  k.hover(false); // pointer left the overlay: Ctrl+C goes back to the other program
  assert.deepEqual(calls, [true, false]);
  k.hover(true);
  assert.deepEqual(calls, [true, false, true]);
  k.selection(false); // selection cleared
  assert.deepEqual(calls, [true, false, true, false]);
});

test("a selection made elsewhere and repeated updates don't toggle the hotkey", () => {
  const { k, calls } = key();
  k.selection(true);
  k.selection(true);
  k.hover(false);
  assert.deepEqual(calls, []);
  k.hover(true);
  k.hover(true);
  k.selection(true);
  assert.deepEqual(calls, [true]);
});

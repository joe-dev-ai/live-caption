import { test } from "node:test";
import assert from "node:assert/strict";
import { TypingPlanner, type TypingMessage } from "../src/pipeline/typing.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

function planner(live = true) {
  const sent: TypingMessage[] = [];
  let liveTyping = live;
  const p = new TypingPlanner((m) => sent.push(m), () => liveTyping);
  return { p, sent, setLive: (v: boolean) => (liveTyping = v) };
}

test("preview updates are sent as the provisional tail, without repeats", async () => {
  const { p, sent } = planner();
  p.previewChanged("hello wor");
  await tick();
  p.previewChanged("hello world how");
  await tick();
  p.previewChanged("hello world how "); // same words: nothing new to send
  await tick();
  assert.deepEqual(sent, [
    { seq: 1, text: "", provisional: "hello wor" },
    { seq: 2, text: "", provisional: "hello world how" },
  ]);
});

test("a final result and the preview change it causes go out as one message", async () => {
  const { p, sent } = planner();
  p.previewChanged("hello world how are you");
  await tick();
  // What the pipeline does when a chunk is finalized: final text, then the trimmed preview.
  p.final("Hello, world.");
  p.previewChanged("how are you");
  await tick();
  assert.deepEqual(sent.at(-1), { seq: 2, text: "Hello, world.", provisional: "how are you" });
  assert.equal(sent.length, 2);
});

test("with live typing off only final text is sent", async () => {
  const { p, sent } = planner(false);
  p.previewChanged("hello world how");
  await tick();
  p.final("Hello world.");
  await tick();
  assert.deepEqual(sent, [{ seq: 1, text: "Hello world." }]);
});

test("Stop cancels anything not sent yet", async () => {
  const { p, sent } = planner();
  p.final("Never typed.");
  p.reset();
  await tick();
  assert.deepEqual(sent, []);
});

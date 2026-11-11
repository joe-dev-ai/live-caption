import { test } from "node:test";
import assert from "node:assert/strict";
import { CaptionPipeline } from "../src/pipeline/pipeline.ts";
import { profileFor } from "../src/pipeline/profile.ts";
import { concat, silence, speech } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toPcm = (f: Float32Array) => Int16Array.from(f, (v) => Math.round(v * 32767));

test("end-to-end: chunks are transcribed in parallel and emitted in order", async () => {
  const texts: string[] = [];
  const prompts: (string | undefined)[] = [];
  let call = 0;
  const pipeline = new CaptionPipeline(
    { profile: profileFor("balanced", "auto"), language: "en", useContextPrompt: true, maxParallel: 3, livePreview: false },
    async (wav, opts) => {
      const n = ++call;
      prompts.push(opts.prompt);
      assert.equal(opts.model, "", "Auto sends no model so Puter uses its default");
      assert.equal(opts.language, "en");
      assert.equal(wav.type, "audio/wav");
      await sleep(n === 1 ? 60 : 5); // first request is slowest
      return `Sentence number ${n}.`;
    },
    {
      onText: (t) => texts.push(t),
      onPreview: () => assert.fail("live preview is off"),
      onBusy: () => {},
      onError: (e) => assert.fail(String(e)),
      onStats: () => {},
    },
  );
  const utterance = concat(speech(1.8), silence(0.8));
  const signal = concat(silence(0.5), utterance, utterance, utterance);
  for (let i = 0; i < signal.length; i += 1600) pipeline.pushPcm(toPcm(signal.slice(i, i + 1600)));
  await sleep(200);
  assert.deepEqual(texts, ["Sentence number 1.", "Sentence number 2.", "Sentence number 3."]);
  assert.equal(prompts[0], undefined, "no context before any text");
  const st = pipeline.stats;
  assert.equal(st.chunks, 3);
  assert.ok(st.avgApiMs > 0);
});

test("reset (Stop) discards results that arrive later", async () => {
  const texts: string[] = [];
  const pipeline = new CaptionPipeline(
    { profile: profileFor("speed", "auto"), language: "en", useContextPrompt: false, maxParallel: 2, livePreview: false },
    async () => {
      await sleep(50);
      return "late text";
    },
    { onText: (t) => texts.push(t), onPreview: () => {}, onBusy: () => {}, onError: () => {}, onStats: () => {} },
  );
  const signal = concat(silence(0.3), speech(1.5), silence(1));
  for (let i = 0; i < signal.length; i += 1600) pipeline.pushPcm(toPcm(signal.slice(i, i + 1600)));
  pipeline.reset();
  await sleep(150);
  assert.deepEqual(texts, []);
});

/** Fake transcriber: "w1 w2 …", three words per second of audio, so a preview
 * and the final text of the same audio share their first words. */
function wordsFor(wav: Blob): string {
  const n = Math.max(1, Math.round(((wav.size - 44) / 32000) * 3));
  return Array.from({ length: n }, (_, i) => `w${i + 1}`).join(" ");
}

type Event = { kind: "preview" | "final"; text: string };

function previewPipeline(livePreview: boolean, delayMs = 3) {
  const events: Event[] = [];
  let calls = 0;
  let clock = 0;
  const pipeline = new CaptionPipeline(
    { profile: profileFor("balanced", "auto"), language: "en", useContextPrompt: false, maxParallel: 3, livePreview },
    async (wav) => {
      calls++;
      await sleep(delayMs);
      return wordsFor(wav);
    },
    {
      onText: (text) => events.push({ kind: "final", text }),
      onPreview: (text) => events.push({ kind: "preview", text }),
      onBusy: () => {},
      onError: (e) => assert.fail(String(e)),
      onStats: () => {},
    },
    () => clock,
  );
  /** Feed audio in 100 ms packets in (simulated) real time. */
  async function play(signal: Float32Array): Promise<void> {
    for (let i = 0; i < signal.length; i += 1600) {
      clock += 100;
      pipeline.pushPcm(toPcm(signal.slice(i, i + 1600)));
      await sleep(5);
    }
  }
  return { pipeline, events, play, calls: () => calls };
}

test("live preview shows text while speech is in progress, then gives way to the final text", async () => {
  const { events, play } = previewPipeline(true);
  await play(concat(silence(0.3), speech(3.2), silence(1.2)));
  await sleep(50);
  const firstFinal = events.findIndex((e) => e.kind === "final");
  const previews = events.slice(0, firstFinal).filter((e) => e.kind === "preview" && e.text);
  assert.ok(previews.length >= 2, `previews before the final: ${previews.length}`);
  assert.ok(previews[1].text.split(" ").length > previews[0].text.split(" ").length, "previews grow with the speech");
  const finals = events.filter((e) => e.kind === "final");
  assert.equal(finals.length, 1);
  assert.match(finals[0].text, /^w1 w2 w3/);
  assert.deepEqual(events.at(-1), { kind: "preview", text: "" }, "preview cleared once the final text is shown");
});

test("no preview requests when live preview is off", async () => {
  const { events, play, calls } = previewPipeline(false);
  await play(concat(silence(0.3), speech(3.2), silence(1.2)));
  await sleep(50);
  assert.equal(events.filter((e) => e.kind === "preview").length, 0);
  assert.equal(calls(), 1, "one request for the one chunk");
});

test("a preview that returns after Stop is ignored", async () => {
  const { pipeline, events, play, calls } = previewPipeline(true, 80);
  await play(concat(silence(0.3), speech(1.2)));
  assert.ok(calls() >= 1, "a preview request is running");
  pipeline.reset();
  const afterReset = events.length;
  await sleep(150);
  assert.ok(events.slice(afterReset).every((e) => e.kind === "preview" && e.text === ""), JSON.stringify(events.slice(afterReset)));
});

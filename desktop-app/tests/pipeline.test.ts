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
    { profile: profileFor("balanced", "auto"), language: "en", useContextPrompt: true, maxParallel: 3 },
    async (wav, opts) => {
      const n = ++call;
      prompts.push(opts.prompt);
      assert.equal(opts.model, "gpt-4o-transcribe");
      assert.equal(opts.language, "en");
      assert.equal(wav.type, "audio/wav");
      await sleep(n === 1 ? 60 : 5); // first request is slowest
      return `Sentence number ${n}.`;
    },
    {
      onText: (t) => texts.push(t),
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
    { profile: profileFor("speed", "auto"), language: "en", useContextPrompt: false, maxParallel: 2 },
    async () => {
      await sleep(50);
      return "late text";
    },
    { onText: (t) => texts.push(t), onBusy: () => {}, onError: () => {}, onStats: () => {} },
  );
  const signal = concat(silence(0.3), speech(1.5), silence(1));
  for (let i = 0; i < signal.length; i += 1600) pipeline.pushPcm(toPcm(signal.slice(i, i + 1600)));
  pipeline.reset();
  await sleep(150);
  assert.deepEqual(texts, []);
});

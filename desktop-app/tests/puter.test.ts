import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLabel, profileFor } from "../src/pipeline/profile.ts";
import { classifyError, onModelFallback, transcribeWithPuter, type PuterApi } from "../src/pipeline/puter.ts";

type Call = Record<string, unknown>;

/** Install a fake `window.puter` whose speech2txt is `impl`; returns the recorded options. */
function fakePuter(impl: (opts: Call) => Promise<unknown>): Call[] {
  const calls: Call[] = [];
  const puter = {
    ai: {
      speech2txt: (_audio: Blob | string, opts?: Call) => {
        calls.push({ ...opts });
        return impl(opts ?? {});
      },
    },
    auth: { signIn: async () => ({}), signOut: () => {}, isSignedIn: () => true, getUser: async () => ({}) },
  } satisfies PuterApi;
  Object.defineProperty(globalThis, "window", { value: { puter }, configurable: true, writable: true });
  return calls;
}

const wav = new Blob([new Uint8Array(44)], { type: "audio/wav" });

test("Auto uses Puter's default model (no model option is sent)", async () => {
  assert.equal(profileFor("balanced", "auto").model, "");
  assert.equal(profileFor("speed", "gpt-transcribe").model, "gpt-transcribe");
  assert.equal(modelLabel(""), "gpt-transcribe (Puter default)");
  const calls = fakePuter(async () => ({ text: "hello" }));
  assert.equal(await transcribeWithPuter(wav, { model: "", language: "en" }), "hello");
  assert.deepEqual(calls, [{ language: "en" }]);
});

test("a retired model falls back to Puter's default instead of skipping every chunk", async () => {
  const fallbacks: string[] = [];
  onModelFallback((model) => fallbacks.push(model));
  // Reproduces the reported failure: Puter rejects the model and the error is just its id.
  const calls = fakePuter(async (o) => {
    if (o.model === "gpt-4o-transcribe") throw "gpt-4o-transcribe";
    return { text: "it works" };
  });
  assert.equal(await transcribeWithPuter(wav, { model: "gpt-4o-transcribe", language: "en" }), "it works");
  assert.equal(await transcribeWithPuter(wav, { model: "gpt-4o-transcribe", language: "en" }), "it works");
  assert.deepEqual(fallbacks, ["gpt-4o-transcribe"], "user is told once");
  assert.deepEqual(calls.map((c) => c.model), ["gpt-4o-transcribe", undefined, undefined], "refused model not resent");
  onModelFallback(null);
});

test("model_not_found errors are classified and keep their code", async () => {
  const err = classifyError({ success: false, error: { code: "model_not_found", message: "old-model-x" } });
  assert.equal(err.kind, "model");
  assert.equal(err.message, "old-model-x (model_not_found)");
  const calls = fakePuter(async (o) => {
    if (o.model) throw { success: false, error: { code: "model_not_found", message: "Unknown model" } };
    return "plain text result";
  });
  assert.equal(await transcribeWithPuter(wav, { model: "old-model-y", language: "en" }), "plain text result");
  assert.equal(calls.length, 2);
});

test("usage problems are not mistaken for a refused model", async () => {
  const calls = fakePuter(async () => {
    throw { error: { code: "insufficient_funds", message: "Not enough credits for model-z" } };
  });
  await assert.rejects(transcribeWithPuter(wav, { model: "model-z", language: "en" }), (e: { kind?: string }) => e.kind === "quota");
  assert.equal(calls.length, 1, "no pointless retry");
});

test("a refused context prompt is dropped and the request retried", async () => {
  const calls = fakePuter(async (o) => {
    if (o.prompt) throw { error: { code: "bad_request", message: "prompt is not supported by this model" } };
    return { text: "no prompt needed" };
  });
  assert.equal(await transcribeWithPuter(wav, { model: "", language: "en", prompt: "Earlier text." }), "no prompt needed");
  assert.deepEqual(calls, [{ language: "en", prompt: "Earlier text." }, { language: "en" }]);
});

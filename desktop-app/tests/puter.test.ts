import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLabel, profileFor } from "../src/pipeline/profile.ts";
import { classifyError, onModelFallback, transcribeWithPuter, warmUpPuter, type PuterApi } from "../src/pipeline/puter.ts";

type Call = Record<string, unknown>;

/** Install a fake `window.puter` whose speech2txt is `impl`; returns the recorded options. */
function fakePuter(impl: (opts: Call) => Promise<unknown>, signedIn = true): Call[] {
  const calls: Call[] = [];
  const puter = {
    ai: {
      speech2txt: (_audio: Blob | string, opts?: Call) => {
        calls.push({ ...opts });
        return impl(opts ?? {});
      },
    },
    auth: { signIn: async () => ({}), signOut: () => {}, isSignedIn: () => signedIn, getUser: async () => ({}) },
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

test("never more than 3 Puter requests at once; final chunks wait for a free slot", async () => {
  let running = 0;
  let peak = 0;
  fakePuter(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return { text: "ok" };
  });
  const results = await Promise.all(Array.from({ length: 6 }, () => transcribeWithPuter(wav, { model: "", language: "en" })));
  assert.deepEqual(results, Array(6).fill("ok"));
  assert.equal(peak, 3);
});

test("a preview is skipped (not queued) while all slots are busy", async () => {
  const unblock: (() => void)[] = [];
  const calls = fakePuter(async () => {
    await new Promise<void>((r) => unblock.push(r));
    return { text: "done" };
  });
  const finals = [1, 2, 3].map(() => transcribeWithPuter(wav, { model: "", language: "en" }));
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(
    transcribeWithPuter(wav, { model: "", language: "en", preview: true }),
    (e: { kind?: string }) => e.kind === "busy",
  );
  assert.equal(calls.length, 3, "the preview sent nothing");
  unblock.forEach((r) => r());
  assert.deepEqual(await Promise.all(finals), ["done", "done", "done"]);
});

test("a final chunk refused with 429 waits and retries; a preview does not", async () => {
  let attempts = 0;
  const calls = fakePuter(async () => {
    attempts++;
    if (attempts === 1) throw { success: false, error: { code: "too_many_requests", message: "Too many requests" } };
    return { text: "after retry" };
  });
  const t0 = Date.now();
  assert.equal(await transcribeWithPuter(wav, { model: "", language: "en" }), "after retry");
  assert.ok(Date.now() - t0 >= 900, "backed off before retrying");
  assert.equal(calls.length, 2);

  attempts = 0;
  await assert.rejects(
    transcribeWithPuter(wav, { model: "", language: "en", preview: true }),
    (e: { kind?: string }) => e.kind === "rate_limit",
  );
  assert.equal(calls.length, 3, "preview tried once");
});

test("warm-up sends one free test-mode request, and nothing when signed out", async () => {
  const calls = fakePuter(async () => ({ text: "sample" }));
  await warmUpPuter();
  assert.deepEqual(calls, [{ test_mode: true }]);
  const none = fakePuter(async () => ({ text: "sample" }), false);
  await warmUpPuter();
  assert.equal(none.length, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { OrderedScheduler } from "../src/pipeline/scheduler.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(run: (n: number, attempt: number) => Promise<string>, opts: Partial<{ maxParallel: number; timeoutMs: number; maxQueue: number }> = {}) {
  const done: { item: number; result: string | null }[] = [];
  let peak = 0;
  const s = new OrderedScheduler<number, string>({
    maxParallel: opts.maxParallel ?? 3,
    timeoutMs: opts.timeoutMs ?? 1000,
    maxQueue: opts.maxQueue ?? 100,
    run,
    onDone: (item, result) => done.push({ item, result }),
    isRetryable: (e) => !(e instanceof Error && e.message === "fatal"),
    onBusyChange: (n) => (peak = Math.max(peak, n)),
  });
  return { s, done, peak: () => peak };
}

test("delivers results in order with bounded parallelism", async () => {
  const delays = [80, 10, 50, 5, 30, 60, 1, 20];
  const { s, done, peak } = make(async (n) => {
    await sleep(delays[n]);
    return `t${n}`;
  });
  delays.forEach((_, i) => s.push(i));
  await sleep(400);
  assert.deepEqual(done.map((d) => d.result), delays.map((_, i) => `t${i}`));
  assert.equal(peak(), 3);
});

test("retries once, then skips without stalling the stream", async () => {
  const attempts: Record<number, number> = {};
  const { s, done } = make(async (n, attempt) => {
    attempts[n] = attempt;
    if (n === 1 && attempt === 1) throw new Error("flaky");
    if (n === 2) throw new Error("down");
    return `t${n}`;
  });
  [0, 1, 2, 3].forEach((i) => s.push(i));
  await sleep(100);
  assert.deepEqual(done.map((d) => d.result), ["t0", "t1", null, "t3"]);
  assert.equal(attempts[1], 2);
  assert.equal(attempts[2], 2);
});

test("non-retryable errors are not retried", async () => {
  let calls = 0;
  const { s, done } = make(async () => {
    calls++;
    throw new Error("fatal");
  });
  s.push(0);
  await sleep(50);
  assert.equal(calls, 1);
  assert.deepEqual(done, [{ item: 0, result: null }]);
});

test("timeouts count as failures", async () => {
  const { s, done } = make(() => new Promise<string>(() => {}), { timeoutMs: 30 });
  s.push(0);
  await sleep(150);
  assert.deepEqual(done, [{ item: 0, result: null }]);
});

test("reset discards queued and in-flight work", async () => {
  const { s, done } = make(async (n) => {
    await sleep(40);
    return `t${n}`;
  }, { maxParallel: 1 });
  [0, 1, 2].forEach((i) => s.push(i));
  await sleep(10);
  s.reset();
  await sleep(200);
  assert.equal(done.length, 0);
  s.push(9);
  await sleep(80);
  assert.deepEqual(done.map((d) => d.result), ["t9"]);
});

test("drops the oldest work when the backlog is too large", async () => {
  const { s, done } = make(async (n) => {
    await sleep(20);
    return `t${n}`;
  }, { maxParallel: 1, maxQueue: 2 });
  [0, 1, 2, 3, 4].forEach((i) => s.push(i));
  await sleep(200);
  assert.deepEqual(done.map((d) => d.result), ["t0", null, null, "t3", "t4"]);
});

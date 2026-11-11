import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestLimiter } from "../src/pipeline/limiter.ts";

test("at most N slots are in use; waiters are served in order", async () => {
  const limiter = new RequestLimiter(2);
  const a = await limiter.acquire();
  const b = await limiter.acquire();
  assert.equal(limiter.free, 0);
  const order: string[] = [];
  const c = limiter.acquire().then((release) => (order.push("c"), release));
  const d = limiter.acquire().then((release) => (order.push("d"), release));
  assert.equal(limiter.tryAcquire(), null, "full");
  a();
  a(); // releasing twice frees only one slot
  const releaseC = await c;
  assert.deepEqual(order, ["c"]);
  b();
  const releaseD = await d;
  assert.deepEqual(order, ["c", "d"]);
  releaseC();
  releaseD();
  assert.equal(limiter.free, 2);
});

test("tryAcquire never overtakes a waiting request", async () => {
  const limiter = new RequestLimiter(1);
  const first = await limiter.acquire();
  const waiting = limiter.acquire();
  first();
  // The freed slot belongs to the waiter, not to a preview that asks now.
  assert.equal(limiter.tryAcquire(), null);
  (await waiting)();
  const preview = limiter.tryAcquire();
  assert.ok(preview);
  preview();
});

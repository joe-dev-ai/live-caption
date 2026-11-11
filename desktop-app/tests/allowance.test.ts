import { test } from "node:test";
import assert from "node:assert/strict";
import { audioPerSpeechMinute, describeAllowance, summarizeAllowance } from "../src/lib/allowance.ts";

const DOLLAR = 100_000_000; // micro-cents

test("summarizes the allowance in percent, dollars and hours of captioning", () => {
  const s = summarizeAllowance({ allowance: 0.5 * DOLLAR, remaining: 0.3 * DOLLAR }, false);
  assert.equal(Math.round(s.usedPercent), 40);
  assert.equal(s.remainingDollars, 0.3);
  assert.equal(s.allowanceDollars, 0.5);
  // $0.30 / ($0.0045/min × 1.1) ≈ 60.6 min ≈ 1.0 h
  assert.ok(Math.abs(s.hoursLeft - 0.3 / (0.0045 * 1.1) / 60) < 1e-9);
  assert.equal(s.low, false);
  assert.equal(
    describeAllowance(s),
    "40% of this month's allowance used: $0.30 of $0.50 left, about 1.0 h of captioning at the current settings.",
  );
});

test("live preview sends more audio, so the same allowance lasts shorter", () => {
  const a = { allowance: DOLLAR, remaining: DOLLAR };
  assert.ok(audioPerSpeechMinute(true) > audioPerSpeechMinute(false));
  assert.ok(summarizeAllowance(a, true).hoursLeft < summarizeAllowance(a, false).hoursLeft);
});

test("flags a low allowance and handles odd values", () => {
  const low = summarizeAllowance({ allowance: DOLLAR, remaining: 0.05 * DOLLAR }, true);
  assert.equal(low.low, true);
  assert.match(describeAllowance(low), /^95% .* about 3 min of captioning/);
  const empty = summarizeAllowance({ allowance: 0, remaining: 0 }, true);
  assert.equal(empty.usedPercent, 100);
  assert.equal(empty.low, true);
  assert.equal(summarizeAllowance({ allowance: DOLLAR, remaining: -5 }, true).remainingDollars, 0);
  assert.match(describeAllowance(summarizeAllowance({ allowance: DOLLAR, remaining: 1000 }, true)), /<\$0\.01 of \$1\.00/);
});

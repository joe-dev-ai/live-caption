import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWav, normalize } from "../src/pipeline/wav.ts";

test("encodes a valid 16 kHz mono 16-bit WAV", () => {
  const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000);
  const v = new DataView(buf);
  const str = (o: number) => String.fromCharCode(...new Uint8Array(buf, o, 4));
  assert.equal(buf.byteLength, 44 + 10);
  assert.equal(str(0), "RIFF");
  assert.equal(str(8), "WAVE");
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getInt16(44 + 6, true), 32767);
  assert.equal(v.getInt16(44 + 8, true), -32768);
});

test("normalisation boosts quiet audio without clipping", () => {
  const quiet = Float32Array.from({ length: 16000 }, (_, i) => 0.02 * Math.sin(i / 5));
  const out = normalize(quiet);
  const rms = Math.sqrt(out.reduce((a, v) => a + v * v, 0) / out.length);
  assert.ok(Math.abs(rms - 0.1) < 0.005, `rms ${rms}`);
  assert.ok(Math.max(...out.map(Math.abs)) <= 0.9001);
});

test("normalisation tames loud audio and leaves silence alone", () => {
  const loud = Float32Array.from({ length: 1000 }, (_, i) => (i % 2 ? 1 : -1));
  assert.ok(Math.max(...normalize(loud).map(Math.abs)) <= 0.9001);
  const zero = new Float32Array(100);
  assert.equal(normalize(zero), zero);
});

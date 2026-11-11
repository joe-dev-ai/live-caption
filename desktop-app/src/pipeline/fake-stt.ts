// Offline placeholder transcriber (LCO_FAKE_STT=1): exercises chunking,
// captions and Chrome typing without calling Puter or using credits.

let count = 0;

export async function fakeTranscribe(wav: Blob): Promise<string> {
  await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
  const seconds = (wav.size - 44) / 32000; // 16 kHz × 16-bit mono
  return `Test chunk ${++count} (${seconds.toFixed(1)} s).`;
}

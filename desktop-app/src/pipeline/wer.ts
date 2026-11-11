// Word error rate for the built-in accuracy test:
// WER = (substitutions + deletions + insertions) / reference words.

export interface WerResult {
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  referenceWords: number;
}

/** Lower-case, drop punctuation (keep in-word apostrophes), split on spaces/hyphens. */
export function werWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]+/gu, " ")
    .replace(/(^|\s)'+|'+(\s|$)/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
}

export function wordErrorRate(reference: string, hypothesis: string): WerResult {
  const r = werWords(reference);
  const h = werWords(hypothesis);
  // Levenshtein over words, tracking the operation counts of the best path.
  type Cell = { cost: number; s: number; d: number; i: number };
  let prev: Cell[] = Array.from({ length: h.length + 1 }, (_, j) => ({ cost: j, s: 0, d: 0, i: j }));
  for (let a = 1; a <= r.length; a++) {
    const cur: Cell[] = [{ cost: a, s: 0, d: a, i: 0 }];
    for (let b = 1; b <= h.length; b++) {
      const same = r[a - 1] === h[b - 1];
      const sub = { ...prev[b - 1], cost: prev[b - 1].cost + (same ? 0 : 1), s: prev[b - 1].s + (same ? 0 : 1) };
      const del = { ...prev[b], cost: prev[b].cost + 1, d: prev[b].d + 1 };
      const ins = { ...cur[b - 1], cost: cur[b - 1].cost + 1, i: cur[b - 1].i + 1 };
      cur.push([sub, del, ins].reduce((x, y) => (y.cost < x.cost ? y : x)));
    }
    prev = cur;
  }
  const best = prev[h.length];
  return {
    wer: r.length ? best.cost / r.length : h.length ? 1 : 0,
    substitutions: best.s,
    deletions: best.d,
    insertions: best.i,
    referenceWords: r.length,
  };
}

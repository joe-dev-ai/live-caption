import type { Priority } from "../lib/types.ts";

/** Tunables derived from the "Priority" setting. */
export interface PipelineProfile {
  model: string;
  /** Do not cut at a pause before the chunk is this long (seconds). */
  minChunkSec: number;
  /** Force a cut at the quietest point once a chunk reaches this length. */
  maxChunkSec: number;
  /** Silence that counts as a natural pause (seconds). */
  pauseSec: number;
  /** Audio repeated at the start of the next chunk after a forced cut. */
  overlapSec: number;
}

export const MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"] as const;

const PROFILES: Record<Priority, PipelineProfile> = {
  // Longer chunks give the model more context: best accuracy, ~3 s delay.
  accuracy: { model: "gpt-4o-transcribe", minChunkSec: 2.0, maxChunkSec: 5.0, pauseSec: 0.35, overlapSec: 0.2 },
  // Default: high-accuracy model with 1.5–4 s chunks.
  balanced: { model: "gpt-4o-transcribe", minChunkSec: 1.5, maxChunkSec: 4.0, pauseSec: 0.3, overlapSec: 0.2 },
  // Faster model and shorter chunks for the lowest delay.
  speed: { model: "gpt-4o-mini-transcribe", minChunkSec: 1.0, maxChunkSec: 3.0, pauseSec: 0.25, overlapSec: 0.2 },
};

export function profileFor(priority: Priority, model: string): PipelineProfile {
  const base = PROFILES[priority] ?? PROFILES.balanced;
  return { ...base, model: model && model !== "auto" ? model : base.model };
}

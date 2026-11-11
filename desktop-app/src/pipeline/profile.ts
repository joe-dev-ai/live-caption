import type { Priority } from "../lib/types.ts";

/** Tunables derived from the "Priority" setting. */
export interface PipelineProfile {
  /** Puter model id, or "" to let Puter pick its default transcription model. */
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

/**
 * Puter's default OpenAI transcription model, used when no model is sent.
 * Not sending a model keeps the app working when Puter retires or renames
 * models (the gpt-4o transcription models were removed this way).
 */
export const PUTER_DEFAULT_MODEL_NAME = "gpt-transcribe";

// Priority trades delay for context: longer chunks give the model more to
// work with (better accuracy) but text appears later.
const PROFILES: Record<Priority, PipelineProfile> = {
  accuracy: { model: "", minChunkSec: 2.0, maxChunkSec: 5.0, pauseSec: 0.35, overlapSec: 0.2 },
  balanced: { model: "", minChunkSec: 1.5, maxChunkSec: 4.0, pauseSec: 0.3, overlapSec: 0.2 },
  speed: { model: "", minChunkSec: 1.0, maxChunkSec: 3.0, pauseSec: 0.25, overlapSec: 0.2 },
};

export function profileFor(priority: Priority, model: string): PipelineProfile {
  const base = PROFILES[priority] ?? PROFILES.balanced;
  return { ...base, model: model && model !== "auto" ? model : base.model };
}

/** Human-readable model name for the debug line and settings hint. */
export function modelLabel(model: string): string {
  return model || `${PUTER_DEFAULT_MODEL_NAME} (Puter default)`;
}

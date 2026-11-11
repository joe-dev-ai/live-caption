// Thin typed wrapper around Puter.js (https://js.puter.com/v2/).
// Only Puter's cloud speech-to-text is used — no local recognition models.

import { RequestLimiter } from "./limiter.ts";

export interface PuterUser {
  username?: string;
}

export interface PuterApi {
  ai: {
    speech2txt(source: Blob | string, options?: Record<string, unknown>): Promise<unknown>;
  };
  auth: {
    signIn(options?: Record<string, unknown>): Promise<unknown>;
    signOut(): unknown;
    isSignedIn(): boolean;
    getUser(): Promise<PuterUser>;
  };
}

declare global {
  interface Window {
    puter?: PuterApi;
  }
}

export const PUTER_SRC = "https://js.puter.com/v2/";

export type SttErrorKind =
  | "auth"
  | "quota"
  | "rate_limit"
  | "busy"
  | "model"
  | "bad_request"
  | "network"
  | "unknown";

export class SttError extends Error {
  kind: SttErrorKind;
  constructor(kind: SttErrorKind, message: string) {
    super(message);
    this.name = "SttError";
    this.kind = kind;
  }
}

let loading: Promise<PuterApi> | null = null;

/** Inject the Puter.js script once and resolve when `window.puter` exists. */
export function loadPuter(timeoutMs = 20000): Promise<PuterApi> {
  if (window.puter) return Promise.resolve(window.puter);
  if (loading) return loading;
  loading = new Promise<PuterApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PUTER_SRC;
    script.async = true;
    const fail = (msg: string) => {
      loading = null;
      script.remove();
      reject(new SttError("network", msg));
    };
    const timer = setTimeout(() => fail("Timed out loading Puter.js — check your internet connection."), timeoutMs);
    script.onload = () => {
      clearTimeout(timer);
      if (window.puter) resolve(window.puter);
      else fail("Puter.js loaded but did not initialise.");
    };
    script.onerror = () => {
      clearTimeout(timer);
      fail("Could not load Puter.js — check your internet connection.");
    };
    document.head.appendChild(script);
  });
  return loading;
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    const o = e as Record<string, unknown>;
    const inner = (o?.error ?? o) as Record<string, unknown> | string;
    if (typeof inner === "string") return String(o?.msg ?? o?.message ?? inner);
    return String(inner?.message ?? o?.msg ?? o?.message ?? JSON.stringify(e));
  } catch {
    return String(e);
  }
}

/** Machine-readable error code from Puter's error shapes, if any. */
function errorCode(e: unknown): string | undefined {
  if (!e || typeof e !== "object") return undefined;
  const o = e as Record<string, unknown>;
  const inner = o.error && typeof o.error === "object" ? (o.error as Record<string, unknown>) : undefined;
  const code = inner?.code ?? o.code ?? (typeof o.error === "string" ? o.error : undefined);
  return typeof code === "string" && code ? code : undefined;
}

const MODEL_ERROR =
  /model[ _-]?(not[ _-]?found|not[ _-]?supported|unavailable|not[ _-]?allowed|deprecated|invalid)|(unknown|invalid|unsupported|retired|deprecated) model|no such model/i;

/** Map Puter's various error shapes onto a small set of kinds. */
export function classifyError(e: unknown): SttError {
  if (e instanceof SttError) return e;
  const raw = (() => {
    try {
      return JSON.stringify(e) + " " + describe(e);
    } catch {
      return describe(e);
    }
  })();
  const code = errorCode(e);
  const text = describe(e);
  // Show the code too: a bare message such as a model id says little on its own.
  const msg = code && !text.includes(code) ? `${text} (${code})` : text;
  if (/insufficient|funds|usage.?limit|quota|credits|402|payment/i.test(raw)) return new SttError("quota", msg);
  if (/429|too_many_requests|too many requests|rate.?limit/i.test(raw)) return new SttError("rate_limit", msg);
  if (/auth|sign.?in|signed.?in|token|401|403|unauthori[sz]ed|forbidden|session/i.test(raw)) return new SttError("auth", msg);
  if (MODEL_ERROR.test(raw)) return new SttError("model", msg);
  if (/bad_request|400|invalid|unsupported/i.test(raw)) return new SttError("bad_request", msg);
  if (/network|fetch|failed to fetch|timeout|timed out|ECONN|offline|5\d\d/i.test(raw)) return new SttError("network", msg);
  return new SttError("unknown", msg);
}

/** Extract the transcript text from a speech2txt result (string or object). */
export function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.text === "string") return r.text;
    if (Array.isArray(r.segments)) {
      return r.segments.map((s) => (s as { text?: string }).text ?? "").join(" ");
    }
    if (r.success === false) throw classifyError(r);
  }
  return "";
}

export interface TranscribeOptions {
  /** Model id, or "" for Puter's default model. */
  model: string;
  language: string;
  prompt?: string;
  /** Live preview: skip (error kind "busy") instead of waiting when all request slots are in use. */
  preview?: boolean;
}

/** Puter's free plan runs at most 3 speech-to-text requests per user at once. */
export const PUTER_MAX_CONCURRENT = 3;
const slots = new RequestLimiter(PUTER_MAX_CONCURRENT);
/** A request refused with 429 waits this long (times the attempt) and tries again. */
const RATE_LIMIT_BACKOFF_MS = 1000;
const RATE_LIMIT_RETRIES = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether the provider rejected the `prompt` option; then we stop sending it. */
let promptUnsupported = false;
/** Models Puter refused in this run; requests use Puter's default instead. */
const rejectedModels = new Set<string>();
let modelFallbackListener: ((model: string, reason: string) => void) | null = null;

/** Be told (once per model) when a chosen model is refused and the default is used. */
export function onModelFallback(listener: ((model: string, reason: string) => void) | null): void {
  modelFallbackListener = listener;
}

export async function transcribeWithPuter(wav: Blob, o: TranscribeOptions): Promise<string> {
  const puter = window.puter;
  if (!puter) throw new SttError("network", "Puter.js is not loaded");
  const release = o.preview ? slots.tryAcquire() : await slots.acquire();
  if (!release) throw new SttError("busy", "All Puter request slots are in use");
  try {
    return await callSpeech2txt(puter, wav, o);
  } finally {
    release();
  }
}

async function callSpeech2txt(puter: PuterApi, wav: Blob, o: TranscribeOptions): Promise<string> {
  const options: Record<string, unknown> = { language: o.language };
  if (o.model && !rejectedModels.has(o.model)) options.model = o.model;
  if (o.prompt && !promptUnsupported) options.prompt = o.prompt;
  let rateLimited = 0;
  // Each retry either drops an optional setting Puter refused or waits out a
  // rate limit a bounded number of times, so this loop always ends.
  for (;;) {
    try {
      return extractText(await puter.ai.speech2txt(wav, { ...options }));
    } catch (e) {
      const err = classifyError(e);
      if (err.kind === "rate_limit" && !o.preview && rateLimited < RATE_LIMIT_RETRIES) {
        rateLimited++;
        await sleep(RATE_LIMIT_BACKOFF_MS * rateLimited);
        continue;
      }
      const model = typeof options.model === "string" ? options.model : "";
      const usageProblem =
        err.kind === "quota" || err.kind === "auth" || err.kind === "network" || err.kind === "rate_limit";
      if (model && !usageProblem && (err.kind === "model" || err.message.includes(model))) {
        rejectedModels.add(model);
        modelFallbackListener?.(model, err.message);
        delete options.model;
        continue;
      }
      if (options.prompt && err.kind === "bad_request" && /prompt/i.test(err.message)) {
        promptUnsupported = true;
        delete options.prompt;
        continue;
      }
      throw err;
    }
  }
}

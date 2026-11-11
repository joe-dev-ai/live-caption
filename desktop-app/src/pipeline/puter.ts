// Thin typed wrapper around Puter.js (https://js.puter.com/v2/).
// Only Puter's cloud speech-to-text is used — no local recognition models.

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

export type SttErrorKind = "auth" | "quota" | "bad_request" | "network" | "unknown";

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
  const msg = describe(e);
  if (/insufficient|funds|usage.?limit|quota|credits|402|payment/i.test(raw)) return new SttError("quota", msg);
  if (/auth|sign.?in|signed.?in|token|401|403|unauthori[sz]ed|forbidden|session/i.test(raw)) return new SttError("auth", msg);
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
  model: string;
  language: string;
  prompt?: string;
}

/** Whether the provider rejected the `prompt` option; then we stop sending it. */
let promptUnsupported = false;

export async function transcribeWithPuter(wav: Blob, o: TranscribeOptions): Promise<string> {
  const puter = window.puter;
  if (!puter) throw new SttError("network", "Puter.js is not loaded");
  const options: Record<string, unknown> = { model: o.model, language: o.language };
  if (o.prompt && !promptUnsupported) options.prompt = o.prompt;
  try {
    return extractText(await puter.ai.speech2txt(wav, options));
  } catch (e) {
    const err = classifyError(e);
    // Context prompts are optional: if the model refuses them, retry without.
    if (options.prompt && err.kind === "bad_request" && /prompt/i.test(err.message)) {
      promptUnsupported = true;
      delete options.prompt;
      return extractText(await puter.ai.speech2txt(wav, options));
    }
    throw err;
  }
}

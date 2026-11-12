// Shared types mirroring the Rust backend (camelCase JSON).

export type CaptureMode = "jumpDesktop" | "system";
export type Priority = "accuracy" | "balanced" | "speed";
/** "chrome": Chrome's built-in speech recognition via the extension; "puter": Puter.js. */
export type Engine = "chrome" | "puter";

export interface Settings {
  engine: Engine;
  captureMode: CaptureMode;
  jumpProcessNames: string;
  language: string;
  priority: Priority;
  model: string;
  useContextPrompt: boolean;
  maxParallel: number;
  livePreview: boolean;
  typeIntoChrome: boolean;
  /** Type the live preview right away and correct it in place. */
  typePreview: boolean;
  bridgePort: number;
  pairingToken: string;
  hotkeyToggle: string;
  hotkeyShowHide: string;
  hotkeyTyping: string;
  hotkeyCopy: string;
  fontSize: number;
  bgOpacity: number;
  saveTranscript: boolean;
  transcriptDir: string;
  showDebug: boolean;
}

export interface CaptureStatus {
  state: "capturing" | "waiting" | "error" | "stopped" | "finished";
  message: string;
  process?: string | null;
  pid?: number | null;
}

export interface BridgeStatus {
  listening: boolean;
  port: number;
  /** Connected extension instances that type text. */
  clients: number;
  /** Connected speech pages (Chrome engine). */
  listeners: number;
  error?: string | null;
}

export interface JumpStatus {
  supported: boolean;
  detected: boolean;
  process?: string | null;
  pid?: number | null;
}

export interface AppInfo {
  version: string;
  os: string;
  testAudio?: string | null;
  /** Reference transcript for the accuracy test (LCO_TEST_REFERENCE). */
  testReference?: string | null;
  /** Offline placeholder transcriber (LCO_FAKE_STT=1). */
  fakeStt: boolean;
  hotkeyErrors: string[];
}

/** Result the Chrome extension reports for each text chunk. */
export type AckResult =
  | "inserted"
  | "no_field"
  | "password_field"
  | "restricted_page"
  | "no_tab"
  | "inactive"
  | "error";

export interface BridgeAck {
  type: "ack";
  session: number;
  seq: number;
  result: AckResult;
  detail?: string;
}

/** What the extension's speech page reports (Chrome engine). */
export interface ListenerStatus {
  state: "starting" | "listening" | "error" | "stopped" | "disconnected";
  /** "on-device" or "online". */
  mode: string;
  detail: string;
}

/** Recognized speech from the extension's speech page. */
export interface SpeechEvent {
  session: number;
  final: string;
  interim: string;
}

/** Puter account state shared between the overlay and settings windows. */
export interface PuterStatus {
  loaded: boolean;
  signedIn: boolean;
  username?: string | null;
  error?: string | null;
  /** Monthly allowance and what is left of it, in micro-cents. */
  allowance?: { allowance: number; remaining: number } | null;
}

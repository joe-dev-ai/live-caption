// Typed wrappers for the Rust commands and events.

import { Channel, invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppInfo, BridgeStatus, JumpStatus, Settings } from "./types.ts";

export type AudioChannel = Channel<ArrayBuffer | number[]>;

export const backend = {
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  regenerateToken: () => invoke<Settings>("regenerate_token"),
  startCapture: (onAudio: AudioChannel) => invoke<void>("start_capture", { onAudio }),
  stopCapture: () => invoke<void>("stop_capture"),
  setCaptioning: (active: boolean, typing: boolean, session: number) =>
    invoke<void>("set_captioning", { active, typing, session }),
  bridgeSendText: (session: number, seq: number, text: string, provisional?: string) =>
    invoke<number>("bridge_send_text", { session, seq, text, provisional: provisional ?? null }),
  bridgeStatus: () => invoke<BridgeStatus>("bridge_status"),
  jumpStatus: () => invoke<JumpStatus>("jump_status"),
  appInfo: () => invoke<AppInfo>("app_info"),
  hotkeyErrors: () => invoke<string[]>("hotkey_errors"),
  suspendHotkeys: (suspended: boolean) => invoke<void>("suspend_hotkeys", { suspended }),
  openSettings: () => invoke<void>("open_settings"),
  copyText: (text: string) => invoke<void>("copy_text", { text }),
  hideOverlay: () => invoke<void>("hide_overlay"),
  transcriptBegin: (stamp: string) => invoke<string | null>("transcript_begin", { stamp }),
  transcriptAppend: (line: string) => invoke<void>("transcript_append", { line }),
};

export function newAudioChannel(): AudioChannel {
  return new Channel<ArrayBuffer | number[]>();
}

/** Subscribe to a backend/app event and receive only its payload. */
export function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

export function broadcast(event: string, payload?: unknown): Promise<void> {
  return emit(event, payload);
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

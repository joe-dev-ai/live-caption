// @ts-check
/**
 * Live Caption Typer — content script (runs in every frame).
 *
 * Tracks when this frame last received focus and exposes two functions that
 * the service worker calls through chrome.scripting.executeScript:
 *   probe()                              -> what is focused in this frame
 *   apply(session, text, provisional)    -> type at the caret of the focused field
 *
 * Live typing: `provisional` is caption text that is not final yet. It is
 * typed right away and corrected in place when newer text arrives, but only
 * while it is still exactly what precedes the caret: text the user typed,
 * moved away from or already sent is never deleted.
 *
 * It never presses Enter, never submits forms and never types into password
 * fields or non-editable elements. It uses no chrome.* APIs, so it keeps
 * working in already-open tabs after the extension is updated.
 */
(() => {
  /** @type {any} */
  const g = globalThis;
  // Versioned so an update does not reuse an older copy still loaded in open tabs.
  const KEY = "__liveCaptionTyperV2";
  if (g[KEY]) return;

  let lastFocusAt = 0;
  addEventListener("focusin", () => (lastFocusAt = Date.now()), true);

  const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url"]);
  /** Input types where selectionStart/End are unavailable. */
  const NO_SELECTION_TYPES = new Set(["email"]);

  /** The focused element, looking inside open shadow roots. */
  function deepActiveElement() {
    /** @type {Element | null} */
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  /**
   * Classify an element as a typing target.
   * @param {Element | null} el
   * @returns {"input" | "textarea" | "contenteditable" | "password" | "frame" | null}
   */
  function classify(el) {
    if (!el) return null;
    if (el instanceof HTMLIFrameElement || el.tagName === "FRAME") return "frame";
    if (el instanceof HTMLInputElement) {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
      // "Show password" toggles turn password fields into text fields.
      if (type === "password" || ac.includes("password")) return "password";
      if (!TEXT_INPUT_TYPES.has(type) || el.readOnly || el.disabled) return null;
      return "input";
    }
    if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : "textarea";
    if (el instanceof HTMLElement && el.isContentEditable) return "contenteditable";
    return null;
  }

  function probe() {
    const kind = classify(deepActiveElement());
    return {
      kind,
      hasFocus: document.hasFocus(),
      lastFocusAt,
      top: window === window.top,
    };
  }

  /**
   * Provisional text typed for the current session that may still be corrected.
   * @type {{ session: number, el: Element | null, text: string }}
   */
  let owned = { session: 0, el: null, text: "" };

  /** Compare page text with typed text: editors use NBSP for spaces and zero-width fillers. */
  const clean = (/** @type {string} */ s) => s.replace(/\u00a0/g, " ").replace(/[\u200b\ufeff]/g, "");
  const words = (/** @type {string} */ s) =>
    s
      .split(/\s+/)
      .map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ""))
      .filter(Boolean);

  /** @param {Element} el @returns {Selection | null} */
  function selectionOf(el) {
    const root = /** @type {any} */ (el.getRootNode());
    return typeof root.getSelection === "function" ? root.getSelection() : document.getSelection();
  }

  /** @param {HTMLInputElement | HTMLTextAreaElement} el */
  const hasSelectionApi = (el) =>
    !(el instanceof HTMLInputElement && NO_SELECTION_TYPES.has(el.type)) && el.selectionStart != null;

  /**
   * Text before the caret, and whether the caret is a plain cursor (no
   * selected text).
   * @param {Element} el @param {string} kind
   */
  function caret(el, kind) {
    if (kind !== "contenteditable") {
      const c = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (el);
      if (!hasSelectionApi(c)) return { before: c.value, collapsed: true };
      return { before: c.value.slice(0, c.selectionStart ?? 0), collapsed: c.selectionStart === c.selectionEnd };
    }
    const sel = selectionOf(el);
    if (!sel || !sel.rangeCount || !el.contains(sel.getRangeAt(0).startContainer)) {
      return { before: clean(el.textContent || ""), collapsed: true }; // caret goes to the end
    }
    const r = sel.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(r.startContainer, r.startOffset);
    return { before: clean(before.toString()), collapsed: r.collapsed };
  }

  /** Add a separating space unless the caret already follows whitespace. @param {string} prev @param {string} text */
  function withSpacing(prev, text) {
    if (!prev || /\s/.test(prev) || /^[\s,.!?;:)\]}%…]/.test(text) || /[(\[{"“‘\/-]$/.test(prev)) return text;
    return " " + text;
  }

  /** `desired` without the words already typed as `typed` (when it starts with them). @param {string} desired @param {string} typed */
  function afterTypedWords(desired, typed) {
    const tw = words(typed);
    const tokens = desired.split(/\s+/).filter(Boolean);
    const dw = tokens.map((t) => words(t)[0] ?? "");
    if (tw.length && tw.every((w, i) => dw[i] === w)) return tokens.slice(tw.length).join(" ");
    return desired;
  }

  /**
   * Replace the `del` characters before the caret (or the user's selection
   * when `del` is 0) with `text` in an input or textarea.
   * @param {HTMLInputElement | HTMLTextAreaElement} el @param {number} del @param {string} text
   */
  function replaceInControl(el, del, text) {
    const before = el.value;
    const sel = hasSelectionApi(el);
    const end = sel ? (el.selectionEnd ?? before.length) : before.length;
    const start = Math.max(0, (sel ? (el.selectionStart ?? before.length) : before.length) - del);
    if (sel) el.setSelectionRange(start, end);
    let ok = false;
    try {
      // Native editing command: keeps undo history and fires the
      // beforeinput/input events that React/Vue/Angular listen to.
      ok = text ? document.execCommand("insertText", false, text) : document.execCommand("delete");
    } catch {
      ok = false;
    }
    if (ok && el.value !== before) return;

    // Fallback: native value setter + synthetic events (works with React,
    // whose value tracker ignores assignments through the element's own setter).
    const next = before.slice(0, start) + text + before.slice(end);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, next);
    else el.value = next;
    if (sel) el.setSelectionRange(start + text.length, start + text.length);
    const inputType = text ? "insertText" : "deleteContentBackward";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data: text || null }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * Replace the `del` characters before the caret with `text` in a
   * contenteditable editor.
   * @param {HTMLElement} el @param {number} del @param {string} text
   */
  function replaceInEditable(el, del, text) {
    const sel = selectionOf(el);
    if (sel && (!sel.rangeCount || !el.contains(sel.getRangeAt(0).commonAncestorContainer))) {
      // Caret is not inside the editor: put it at the end.
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    if (sel && del) {
      sel.collapseToEnd();
      for (let i = 0; i < del; i++) sel.modify("extend", "backward", "character");
    }
    // 1. Editors that own their document model (Slate, Lexical, …) apply the
    //    change themselves from a cancelable beforeinput event.
    const inputType = text ? "insertText" : "deleteContentBackward";
    const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType, data: text || null });
    if (!el.dispatchEvent(event)) return; // handled by the editor

    // 2. Native editing command: plain contenteditable, ProseMirror, Quill…
    //    (they observe the resulting DOM mutation / input event).
    let ok = false;
    try {
      ok = text ? document.execCommand("insertText", false, text) : document.execCommand("delete");
    } catch {
      ok = false;
    }
    if (ok || !sel || !sel.rangeCount) return;

    // 3. Last resort: replace the selected range with a text node.
    const range = sel.getRangeAt(0);
    range.deleteContents();
    if (text) {
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data: text || null }));
  }

  /** The provisional part of `target` (with the space before it), which may still be corrected. */
  function provisionalPart(/** @type {string} */ target, /** @type {string} */ finalText, /** @type {string} */ prov) {
    if (!prov) return "";
    if (!finalText) return target;
    if (!target.endsWith(prov)) return "";
    return (target.slice(0, target.length - prov.length).endsWith(" ") ? " " : "") + prov;
  }

  /**
   * Type caption text at the caret of the focused field: newly finalized
   * `finalText`, followed by the not-yet-final `provisional` tail, which
   * replaces the tail typed last time.
   * @param {number} session @param {string} finalText @param {string | null} provisional
   * @returns {"inserted" | "no_field" | "password_field" | "error"}
   */
  function apply(session, finalText, provisional) {
    const el = deepActiveElement();
    const kind = classify(el);
    if (kind === "password") return "password_field";
    if (!el || !kind || kind === "frame") return "no_field";
    const prov = provisional || "";
    if (owned.session !== session || owned.el !== el) owned = { session, el, text: "" };
    try {
      const { before, collapsed } = caret(el, kind);
      let had = owned.text;
      let desired = [finalText, prov].filter(Boolean).join(" ");
      if (had && !(collapsed && before.endsWith(clean(had)))) {
        // The user typed, moved the caret or sent the message: leave that
        // text alone and only type the words that were not typed before.
        desired = afterTypedWords(desired, had);
        had = "";
      }
      let target = "";
      if (desired) target = had ? (had.startsWith(" ") ? " " : "") + desired : withSpacing(before.slice(-1), desired);
      // Minimal edit: keep the common start, replace only what changed.
      let common = 0;
      while (common < had.length && common < target.length && had[common] === target[common]) common++;
      const del = had.length - common;
      const insert = target.slice(common);
      if (del || insert) {
        if (kind === "contenteditable") replaceInEditable(/** @type {HTMLElement} */ (el), del, insert);
        else replaceInControl(/** @type {HTMLInputElement | HTMLTextAreaElement} */ (el), del, insert);
      }
      owned.text = provisionalPart(target, finalText, prov);
      return "inserted";
    } catch {
      owned.text = "";
      return "error";
    }
  }

  g[KEY] = { probe, apply };
})();

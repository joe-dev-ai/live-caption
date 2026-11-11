// @ts-check
/**
 * Live Caption Typer — content script (runs in every frame).
 *
 * Tracks when this frame last received focus and exposes two functions that
 * the service worker calls through chrome.scripting.executeScript:
 *   probe()      -> what is focused in this frame
 *   insert(text) -> insert text at the caret of the focused field
 *
 * It never presses Enter, never submits forms and never types into password
 * fields or non-editable elements. It uses no chrome.* APIs, so it keeps
 * working in already-open tabs after the extension is updated.
 */
(() => {
  /** @type {any} */
  const g = globalThis;
  if (g.__liveCaptionTyper) return;

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
   * Characters before the caret, used to decide whether a space is needed.
   * @param {HTMLInputElement | HTMLTextAreaElement} el
   */
  function textBeforeCaretControl(el) {
    const noSel = el instanceof HTMLInputElement && NO_SELECTION_TYPES.has(el.type);
    const pos = noSel || el.selectionStart == null ? el.value.length : el.selectionStart;
    return el.value.slice(Math.max(0, pos - 1), pos);
  }

  /** @param {Selection | null} sel @param {HTMLElement} el */
  function textBeforeCaretEditable(sel, el) {
    if (!sel || !sel.rangeCount) return "";
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer)) return "";
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(r.startContainer, r.startOffset);
    const s = before.toString();
    return s.slice(-1);
  }

  /** Add a separating space unless the caret already follows whitespace. @param {string} prev @param {string} text */
  function withSpacing(prev, text) {
    if (!prev || /\s/.test(prev) || /^[\s,.!?;:)\]}%…]/.test(text) || /[(\[{"“‘\/-]$/.test(prev)) return text;
    return " " + text;
  }

  /** @param {HTMLInputElement | HTMLTextAreaElement} el @param {string} text */
  function insertIntoControl(el, text) {
    const before = el.value;
    let ok = false;
    try {
      // Native editing command: inserts at the caret, keeps undo history and
      // fires beforeinput/input events that React/Vue/Angular listen to.
      ok = document.execCommand("insertText", false, text);
    } catch {
      ok = false;
    }
    if (ok && el.value !== before) return;

    // Fallback: native value setter + synthetic events (works with React,
    // whose value tracker ignores assignments through the element's own setter).
    const noSel = el instanceof HTMLInputElement && NO_SELECTION_TYPES.has(el.type);
    const start = noSel || el.selectionStart == null ? before.length : el.selectionStart;
    const end = noSel || el.selectionEnd == null ? before.length : el.selectionEnd;
    const next = before.slice(0, start) + text + before.slice(end);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, next);
    else el.value = next;
    if (!noSel) {
      try {
        el.setSelectionRange(start + text.length, start + text.length);
      } catch {
        /* type without selection API */
      }
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** @param {HTMLElement} el @param {Selection | null} sel @param {string} text */
  function insertIntoEditable(el, sel, text) {
    if (sel && (!sel.rangeCount || !el.contains(sel.getRangeAt(0).commonAncestorContainer))) {
      // Caret is not inside the editor: put it at the end.
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    // 1. Editors that own their document model (Slate, Lexical, …) insert
    //    text themselves from a cancelable beforeinput event.
    const before = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: "insertText",
      data: text,
    });
    if (!el.dispatchEvent(before)) return; // handled by the editor

    // 2. Native editing command: plain contenteditable, ProseMirror, Quill…
    //    (they observe the resulting DOM mutation / input event).
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch {
      ok = false;
    }
    if (ok || !sel || !sel.rangeCount) return;

    // 3. Last resort: insert a text node at the caret.
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
  }

  /**
   * Insert text at the caret of the focused field.
   * @param {string} text
   * @returns {"inserted" | "no_field" | "password_field" | "error"}
   */
  function insert(text) {
    const el = deepActiveElement();
    const kind = classify(el);
    if (kind === "password") return "password_field";
    if (!el || !kind || kind === "frame") return "no_field";
    try {
      if (kind === "contenteditable") {
        const root = /** @type {any} */ (el.getRootNode());
        /** @type {Selection | null} */
        const sel = typeof root.getSelection === "function" ? root.getSelection() : document.getSelection();
        const html = /** @type {HTMLElement} */ (el);
        insertIntoEditable(html, sel, withSpacing(textBeforeCaretEditable(sel, html), text));
      } else {
        const control = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (el);
        insertIntoControl(control, withSpacing(textBeforeCaretControl(control), text));
      }
      return "inserted";
    } catch {
      return "error";
    }
  }

  g.__liveCaptionTyper = { probe, insert };
})();

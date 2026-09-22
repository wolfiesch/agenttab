const TEXT_INPUT_TYPES: Readonly<Record<string, true>> = {
  "": true,
  text: true,
  search: true,
  email: true,
  url: true,
  tel: true,
  number: true,
};
const UNSUPPORTED_FILL_INPUT_TYPES: Readonly<Record<string, true>> = {
  button: true,
  checkbox: true,
  file: true,
  hidden: true,
  image: true,
  radio: true,
  reset: true,
  submit: true,
};

const STANDARD_PRESS_KEYS: Readonly<Record<string, true>> = {
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
  Enter: true,
  Escape: true,
  Tab: true,
  Home: true,
  End: true,
  Space: true,
  Backspace: true,
  Delete: true,
};
const PRESS_MODIFIERS: Readonly<Record<string, true>> = {
  Alt: true,
  Control: true,
  Meta: true,
  Shift: true,
};
const EDITOR_COMMAND_KEYS: Readonly<Record<string, true>> = {
  Backspace: true,
  Delete: true,
  Enter: true,
  Space: true,
  z: true,
  y: true,
};

export type PressModifier = "Alt" | "Control" | "Meta" | "Shift";

function invalidRequest(message: string): { agenttab_invalid_request: string } {
  return { agenttab_invalid_request: message };
}

function eventWithLegacyCodes(event: Event, keyCode: number): Event {
  for (const property of ["keyCode", "which"] as const) {
    try {
      Object.defineProperty(event, property, { configurable: true, value: keyCode });
    } catch {
      // Browser event implementations may expose these legacy fields as readonly.
    }
  }
  return event;
}

function keyboardCode(key: string): { code: string; keyCode: number } {
  const known: Record<string, { code: string; keyCode: number }> = {
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    Enter: { code: "Enter", keyCode: 13 },
    Escape: { code: "Escape", keyCode: 27 },
    Tab: { code: "Tab", keyCode: 9 },
    Home: { code: "Home", keyCode: 36 },
    End: { code: "End", keyCode: 35 },
    Space: { code: "Space", keyCode: 32 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
  };
  if (known[key]) return known[key];
  if (/^[a-z]$/i.test(key)) return { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, keyCode: key.charCodeAt(0) };
  return { code: "Unidentified", keyCode: key.charCodeAt(0) || 0 };
}

function dispatchKeyboard(
  target: EventTarget,
  type: string,
  key: string,
  modifiers: readonly string[] = [],
): boolean {
  const { code, keyCode } = keyboardCode(key);
  const event = eventWithLegacyCodes(
    new KeyboardEvent(type, {
      key: key === "Space" ? " " : key,
      code,
      keyCode,
      which: keyCode,
      altKey: modifiers.includes("Alt"),
      ctrlKey: modifiers.includes("Control"),
      metaKey: modifiers.includes("Meta"),
      shiftKey: modifiers.includes("Shift"),
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
    keyCode,
  );
  return target.dispatchEvent(event);
}

/**
 * Rejects unsupported key chords before any event is delivered to the page.
 * The lower-case editing chords are intentionally unavailable without their
 * explicit Control or Meta modifier, so this surface cannot route clipboard
 * shortcuts through a target.
 */
export function validatePressChord(
  key: string,
  modifiers: readonly string[],
): { agenttab_invalid_request: string } | void {
  if (modifiers.length > 4 || modifiers.some((modifier) => PRESS_MODIFIERS[modifier] !== true)) {
    return invalidRequest("press modifiers must be a unique subset of Alt, Control, Meta, Shift");
  }
  if (new Set(modifiers).size !== modifiers.length) {
    return invalidRequest("press modifiers must not contain duplicates");
  }
  if (STANDARD_PRESS_KEYS[key] === true) return;
  if (key !== "a" && key !== "z" && key !== "y") {
    return invalidRequest("press requires a supported key");
  }
  const control = modifiers.includes("Control");
  const meta = modifiers.includes("Meta");
  if (control === meta || modifiers.includes("Alt")) {
    return invalidRequest(`press ${key} requires exactly one of Control or Meta, with optional Shift`);
  }
}

function isEditableInput(target: Element): target is HTMLInputElement {
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES[target.type.toLowerCase()] === true;
}

function isTextEditable(target: Element): target is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  return isEditableInput(target) ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLElement && target.isContentEditable;
}

function isEnabledFocusableWidget(target: Element): target is HTMLElement {
  if (target instanceof HTMLElement === false || target.hasAttribute("disabled")) return false;
  if (target.tabIndex >= 0 || target.isContentEditable) return true;
  const role = target.getAttribute("role")?.toLowerCase();
  return ["combobox", "grid", "listbox", "menu", "menubar", "tablist", "tree", "treegrid"].includes(role ?? "") &&
    target.contains(target.ownerDocument.activeElement);
}

/**
 * Focuses a keyboard target only when focus is not already held inside a popup
 * the target controls. Widget popups render through portals, so a plain
 * descendant check would steal focus, fire focusout on the popup, and dismiss
 * the open widget before the keystroke lands.
 */
function focusForWidgetKeyboard(this: HTMLElement): void {
  const active = this.ownerDocument.activeElement;
  if (!active || this.contains(active)) return;
  const controlled = this.getAttribute("aria-controls");
  for (const id of controlled ? controlled.trim().split(/\s+/) : []) {
    const popup = this.ownerDocument.getElementById(id);
    if (popup && (popup === active || popup.contains(active))) return;
  }
  this.focus();
}

function isFillableControl(target: Element): target is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  return target instanceof HTMLInputElement
    ? UNSUPPORTED_FILL_INPUT_TYPES[target.type.toLowerCase()] !== true
    : target instanceof HTMLTextAreaElement || target instanceof HTMLElement && target.isContentEditable;
}

/**
 * Establishes a selection the browser can edit. Typing keeps an existing
 * selection inside the editor; otherwise it consistently starts at the end.
 * Fill deliberately selects the complete editor instead.
 */
function prepareContenteditableSelection(
  target: HTMLElement,
  replaceAll: boolean,
): { agenttab_invalid_request: string } | void {
  const document = target.ownerDocument;
  const selection = document.getSelection();
  if (!selection) return invalidRequest("contenteditable target has no document selection");
  const existing = !replaceAll && selection.rangeCount > 0 && target.contains(selection.getRangeAt(0).commonAncestorContainer)
    ? selection.getRangeAt(0).cloneRange()
    : undefined;
  target.focus();
  const range = existing ?? document.createRange();
  if (!existing) {
    range.selectNodeContents(target);
    if (!replaceAll) range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Rich editors observe execCommand's native editing transaction, selection and
 * undo history. Never fall back to raw DOM mutation after attempting it: a
 * false result is an explicit unsupported outcome, not permission to retry.
 */
function executeContenteditableCommand(
  target: HTMLElement,
  command: string,
  value: string,
  replaceAll = false,
): { agenttab_invalid_request: string } | void {
  const document = target.ownerDocument;
  if (typeof document.execCommand !== "function") {
    return invalidRequest("contenteditable target does not support native editing commands");
  }
  const selectionResult = prepareContenteditableSelection(target, replaceAll);
  if (selectionResult) return selectionResult;
  try {
    if (!document.execCommand(command, false, value)) {
      return invalidRequest(`contenteditable ${command} command was not accepted`);
    }
  } catch {
    return invalidRequest(`contenteditable ${command} command failed`);
  }
}

function setNativeValue(target: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (typeof setter !== "function") throw new Error("Editable target has no native value setter");
  setter.call(target, value);
}

/**
 * Dispatches a background-safe mouse gesture. It deliberately does not use CDP
 * Input events, which can activate Chrome. A cancelled mousedown prevents the
 * focus step just as it does for a user gesture.
 */
export async function dispatchDomClick(this: Element): Promise<{ agenttab_invalid_request: string } | void> {
  if (this.hasAttribute("disabled") || this.getAttribute("aria-disabled") === "true") {
    return invalidRequest("click target is disabled");
  }
  const rectangle = this.getBoundingClientRect();
  const clientX = rectangle.left + rectangle.width / 2;
  const clientY = rectangle.top + rectangle.height / 2;
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    screenX: clientX + window.screenX,
    screenY: clientY + window.screenY,
    button: 0,
    buttons: 1,
    detail: 1,
  };
  const pointer = (type: string, buttons: number): boolean => this.dispatchEvent(new PointerEvent(type, {
    ...init,
    bubbles: type !== "pointerenter",
    buttons,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  }));
  const mouse = (type: string, buttons: number): boolean => this.dispatchEvent(new MouseEvent(type, {
    ...init,
    bubbles: type !== "mouseenter",
    buttons,
  }));

  pointer("pointerover", 0);
  mouse("mouseover", 0);
  pointer("pointerenter", 0);
  mouse("mouseenter", 0);
  pointer("pointermove", 0);
  mouse("mousemove", 0);
  // Let framework hover updates commit before handlers consume the highlighted target.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const pointerDownAccepted = pointer("pointerdown", 1);
  if (!pointerDownAccepted) {
    pointer("pointerup", 0);
    mouse("click", 0);
    return;
  }
  const mouseDownAccepted = mouse("mousedown", 1);
  if (mouseDownAccepted && this instanceof HTMLElement && !this.hasAttribute("disabled")) this.focus();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  pointer("pointerup", 0);
  mouse("mouseup", 0);
  mouse("click", 0);
}

/** Dispatches a typeahead key sequence for one character without inserting text. */
export async function dispatchTypeahead(this: Element, value: string): Promise<{ agenttab_invalid_request: string } | void> {
  if (!isEnabledFocusableWidget(this)) return invalidRequest("type target is not an editable field or focusable widget");
  focusForWidgetKeyboard.call(this);
  for (const character of value) {
    const keyDownAccepted = dispatchKeyboard(this, "keydown", character);
    if (keyDownAccepted) dispatchKeyboard(this, "keypress", character);
    dispatchKeyboard(this, "keyup", character);
  }
  // Let the widget commit its typeahead highlight before the caller sends the committing key.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Performs standard type semantics for editable controls and typeahead for widgets. */
export async function dispatchDomType(this: Element, value: string): Promise<{ agenttab_invalid_request: string } | void> {
  if (
    (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this instanceof HTMLSelectElement) &&
    !isTextEditable(this)
  ) {
    return invalidRequest("type target is not an editable field");
  }
  if (!isTextEditable(this)) return dispatchTypeahead.call(this, value);
  if ((this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) && (this.readOnly || this.disabled)) {
    return invalidRequest(this.disabled ? "type target is disabled" : "type target is readonly");
  }
  if (this instanceof HTMLElement && this.isContentEditable) {
    if (this.hasAttribute("disabled") || this.getAttribute("aria-disabled") === "true") {
      return invalidRequest("type target is disabled");
    }
    return executeContenteditableCommand(this, "insertText", value);
  }
  if (this instanceof HTMLElement) this.focus();
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    const prototype = this instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const getter = Object.getOwnPropertyDescriptor(prototype, "value")?.get;
    const current = typeof getter === "function" ? String(getter.call(this)) : this.value;
    let start: number;
    let end: number;
    try {
      start = this.selectionStart ?? current.length;
      end = this.selectionEnd ?? start;
    } catch {
      start = current.length;
      end = start;
    }
    const next = `${current.slice(0, start)}${value}${current.slice(end)}`;
    setNativeValue(this, next);
    const cursor = start + value.length;
    try {
      this.setSelectionRange(cursor, cursor);
    } catch {
      // Numeric and date inputs do not expose text selections.
    }
    this.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
  }
}

/** Replaces editable content without assigning arbitrary page object properties. */
export function dispatchDomFill(this: Element, value: string): { agenttab_invalid_request: string } | void {
  if (!isFillableControl(this)) return invalidRequest("fill target is not an editable field");
  if ((this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) && (this.readOnly || this.disabled)) {
    return invalidRequest(this.disabled ? "fill target is disabled" : "fill target is readonly");
  }
  if (this instanceof HTMLElement && this.isContentEditable) {
    if (this.hasAttribute("disabled") || this.getAttribute("aria-disabled") === "true") {
      return invalidRequest("fill target is disabled");
    }
    return executeContenteditableCommand(this, "insertText", value, true);
  }
  if (this instanceof HTMLElement) this.focus();
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    setNativeValue(this, value);
    this.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
}

/** Selects only an existing enabled option on an enabled native select element. */
export function dispatchDomSelect(this: Element, value: string): { agenttab_invalid_request: string } | void {
  if (!(this instanceof HTMLSelectElement)) return invalidRequest("select target is not a native HTMLSelectElement");
  if (this.disabled) return invalidRequest("select target is disabled");
  const option = Array.from(this.options).find((candidate) => candidate.value === value);
  if (!option || option.disabled || option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled) {
    return invalidRequest("select value does not name an enabled option");
  }
  this.value = value;
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}
function isNativeActivationTarget(target: Element): target is HTMLButtonElement | HTMLInputElement {
  if (target instanceof HTMLButtonElement) return !target.disabled;
  if (!(target instanceof HTMLInputElement) || target.disabled) return false;
  return ["button", "submit", "reset", "checkbox", "radio"].includes(target.type.toLowerCase());
}

/**
 * Resolves a page-local Tab destination before delivering keyboard events.
 * Crossing either boundary would hand control to browser chrome, so it is
 * refused rather than pretending a DOM action completed.
 */
function pageTabTarget(
  target: Element,
  backwards: boolean,
): HTMLElement | { agenttab_invalid_request: string } {
  if (!(target instanceof HTMLElement)) return invalidRequest("press Tab target is not focusable");
  const candidates = Array.from(target.ownerDocument.querySelectorAll<HTMLElement>(
    "a[href],area[href],button,input,select,textarea,[contenteditable],[tabindex]",
  )).filter((candidate) =>
    candidate.tabIndex >= 0 &&
    !candidate.hasAttribute("disabled") &&
    candidate.getAttribute("aria-disabled") !== "true" &&
    candidate.getClientRects().length > 0
  );
  const index = candidates.indexOf(target);
  const destination = candidates[index + (backwards ? -1 : 1)];
  if (index < 0 || !destination) {
    return invalidRequest(`press ${backwards ? "Shift+Tab" : "Tab"} has no page-local focus target`);
  }
  return destination;
}

function applyNativeTextEdit(
  target: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number,
  value: string,
  inputType: string,
): void {
  const next = `${target.value.slice(0, start)}${value}${target.value.slice(end)}`;
  setNativeValue(target, next);
  const cursor = start + value.length;
  try {
    target.setSelectionRange(cursor, cursor);
  } catch {
    // Numeric and date inputs do not expose text selections.
  }
  target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data: value || null }));
}

function nativeTextSelection(target: HTMLInputElement | HTMLTextAreaElement): { start: number; end: number } {
  try {
    const start = target.selectionStart ?? target.value.length;
    return { start, end: target.selectionEnd ?? start };
  } catch {
    return { start: target.value.length, end: target.value.length };
  }
}

function moveNativeTextSelection(
  target: HTMLInputElement | HTMLTextAreaElement,
  key: string,
  extend: boolean,
): void {
  const { start, end } = nativeTextSelection(target);
  const edge = key === "Home" ? 0 : key === "End" ? target.value.length : key === "ArrowLeft"
    ? Math.max(0, start - 1)
    : Math.min(target.value.length, end + 1);
  try {
    if (extend) {
      const anchor = key === "ArrowLeft" || key === "Home" ? end : start;
      target.setSelectionRange(Math.min(anchor, edge), Math.max(anchor, edge));
    } else {
      target.setSelectionRange(edge, edge);
    }
  } catch {
    // Numeric and date inputs do not expose text selections.
  }
}

function contenteditableCommandForPress(key: string): string | undefined {
  if (key === "Backspace") return "delete";
  if (key === "Delete") return "forwardDelete";
  if (key === "Enter") return "insertLineBreak";
  if (key === "Space") return "insertText";
  if (key === "z") return "undo";
  if (key === "y") return "redo";
}

function validateEditablePressDefault(
  target: Element,
  key: string,
  modifiers: readonly string[],
): { agenttab_invalid_request: string } | void {
  if (
    target instanceof HTMLElement &&
    target.isContentEditable &&
    EDITOR_COMMAND_KEYS[key] === true &&
    !modifiers.includes("Alt") &&
    typeof target.ownerDocument.execCommand !== "function"
  ) {
    return invalidRequest("contenteditable target does not support native editing commands");
  }
}

function dispatchEditablePressDefault(
  target: HTMLInputElement | HTMLTextAreaElement | HTMLElement,
  key: string,
  modifiers: readonly string[],
): { agenttab_invalid_request: string } | void {
  const hasControlOrMeta = modifiers.includes("Control") || modifiers.includes("Meta");
  const hasNonShiftModifier = hasControlOrMeta || modifiers.includes("Alt");
  if (target instanceof HTMLElement && target.isContentEditable) {
    if (key === "a" && hasControlOrMeta) return prepareContenteditableSelection(target, true);
    const command = contenteditableCommandForPress(key);
    if (!command || hasNonShiftModifier && key !== "z" && key !== "y") return;
    return executeContenteditableCommand(target, command, key === "Space" ? " " : "");
  }
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (key === "a" && hasControlOrMeta) {
    try {
      target.setSelectionRange(0, target.value.length);
    } catch {
      // Numeric and date inputs do not expose text selections.
    }
    return;
  }
  if (hasNonShiftModifier) return;
  if (key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End") {
    moveNativeTextSelection(target, key, modifiers.includes("Shift"));
    return;
  }
  if (key === "Tab" || key === "Escape") return;
  if (key === "Enter") {
    if (target instanceof HTMLTextAreaElement) {
      const { start, end } = nativeTextSelection(target);
      applyNativeTextEdit(target, start, end, "\n", "insertLineBreak");
    } else {
      target.form?.requestSubmit();
    }
    return;
  }
  if (key === "Space") {
    const { start, end } = nativeTextSelection(target);
    applyNativeTextEdit(target, start, end, " ", "insertText");
    return;
  }
  if (key === "Backspace" || key === "Delete") {
    const selection = nativeTextSelection(target);
    const start = selection.start === selection.end && key === "Backspace"
      ? Math.max(0, selection.start - 1)
      : selection.start;
    const end = selection.start === selection.end && key === "Delete"
      ? Math.min(target.value.length, selection.end + 1)
      : selection.end;
    applyNativeTextEdit(target, start, end, "", key === "Backspace" ? "deleteContentBackward" : "deleteContentForward");
  }
}

export function dispatchDomPress(
  this: Element,
  key: string,
  modifiers: readonly string[] = [],
): { agenttab_invalid_request: string } | void {
  const chordResult = validatePressChord(key, modifiers);
  if (chordResult) return chordResult;
  if (!isEnabledFocusableWidget(this)) {
    return invalidRequest("press target is not an enabled focusable element");
  }
  if (key === "Tab" && modifiers.some((modifier) => modifier !== "Shift")) {
    return invalidRequest("press modified Tab has no safe page-local default");
  }
  const tabTarget = key === "Tab" ? pageTabTarget(this, modifiers.includes("Shift")) : undefined;
  if (tabTarget && !(tabTarget instanceof HTMLElement)) return tabTarget;
  const editableResult = validateEditablePressDefault(this, key, modifiers);
  if (editableResult) return editableResult;
  focusForWidgetKeyboard.call(this);
  const keyDownAccepted = dispatchKeyboard(this, "keydown", key, modifiers);
  const keyPressAccepted = keyDownAccepted && dispatchKeyboard(this, "keypress", key, modifiers);
  let defaultResult: { agenttab_invalid_request: string } | void = undefined;
  if (keyDownAccepted && keyPressAccepted) {
    if (tabTarget) {
      tabTarget.focus();
    } else if ((key === "Enter" || key === "Space") && isNativeActivationTarget(this)) {
      this.click();
    } else if (isTextEditable(this)) {
      defaultResult = dispatchEditablePressDefault(this, key, modifiers);
    }
  }
  // Keyup is notification only. Its cancellation cannot retroactively undo an accepted default.
  dispatchKeyboard(this, "keyup", key, modifiers);
  return defaultResult;
}

export interface WindowRequest {
  url: string;
  opener_severed: boolean;
  refused?: string;
}

/**
 * Runs a gesture action while diverting the new windows it requests. Chrome
 * activates any window a page opens, so the page's `window.open` returns null
 * and new-window anchor navigations are cancelled; the extension then opens
 * each recorded URL as a background task tab. A handler that stops click
 * propagation or opens a window asynchronously escapes this capture.
 */
export async function captureWindowRequests(target: Element, run: () => unknown): Promise<unknown> {
  const view = target.ownerDocument.defaultView;
  if (!view) return run();
  const requests: WindowRequest[] = [];
  const record = (raw: string, openerSevered: boolean): void => {
    let url: URL;
    try {
      url = new URL(raw, view.document.baseURI);
    } catch {
      requests.push({ url: raw.slice(0, 2048), opener_severed: openerSevered, refused: "invalid_url" });
      return;
    }
    const refused = url.protocol === "http:" || url.protocol === "https:"
      ? undefined
      : "unsupported_scheme";
    requests.push({ url: url.href, opener_severed: openerSevered, ...(refused ? { refused } : {}) });
  };
  const sameBrowsingContext = (name: string): boolean =>
    name === "" || name === "_self" || name === "_top" || name === "_parent";
  const nativeOpen = view.open;
  view.open = function (url?: string | URL, name?: string, features?: string): WindowProxy | null {
    // window.open treats an empty name as _blank; only explicit same-context names navigate in place.
    const targetName = String(name ?? "").toLowerCase();
    if (targetName !== "" && sameBrowsingContext(targetName)) {
      return nativeOpen.call(view, url, name, features);
    }
    const raw = url === undefined ? "" : String(url);
    if (raw === "" || raw === "about:blank") {
      requests.push({ url: "about:blank", opener_severed: true, refused: "script_written_window" });
      return null;
    }
    const featureList = String(features ?? "").toLowerCase().split(/[\s,]+/);
    record(raw, !featureList.includes("noopener") && !featureList.includes("noreferrer"));
    return null;
  };
  const onClick = (event: Event): void => {
    if (event.defaultPrevented) return;
    const anchor = event.composedPath().find((node): node is HTMLAnchorElement =>
      node instanceof view.Element &&
      (node.localName === "a" || node.localName === "area") &&
      node.hasAttribute("href"));
    if (!anchor || anchor.hasAttribute("download")) return;
    if (sameBrowsingContext((anchor.getAttribute("target") ?? "").toLowerCase())) return;
    event.preventDefault();
    const rel = (anchor.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    record(anchor.getAttribute("href") ?? "", rel.includes("opener") && !rel.includes("noopener"));
  };
  view.addEventListener("click", onClick);
  let result: unknown;
  try {
    result = await run();
  } finally {
    view.open = nativeOpen;
    view.removeEventListener("click", onClick);
  }
  if (result !== undefined) return result;
  return requests.length === 0 ? undefined : { agenttab_window_requests: requests };
}

const PAGE_HELPERS = [
  invalidRequest,
  eventWithLegacyCodes,
  keyboardCode,
  dispatchKeyboard,
  validatePressChord,
  isEditableInput,
  isTextEditable,
  isEnabledFocusableWidget,
  focusForWidgetKeyboard,
  isFillableControl,
  prepareContenteditableSelection,
  executeContenteditableCommand,
  setNativeValue,
  dispatchTypeahead,
  isNativeActivationTarget,
  pageTabTarget,
  applyNativeTextEdit,
  nativeTextSelection,
  moveNativeTextSelection,
  contenteditableCommandForPress,
  validateEditablePressDefault,
  dispatchEditablePressDefault,
  captureWindowRequests,
].map((helper) => `const ${helper.name}=${helper.toString()};`).join("");
const PAGE_INPUT_TYPE_TABLES =
  `const TEXT_INPUT_TYPES=${JSON.stringify(TEXT_INPUT_TYPES)};` +
  `const UNSUPPORTED_FILL_INPUT_TYPES=${JSON.stringify(UNSUPPORTED_FILL_INPUT_TYPES)};` +
  `const STANDARD_PRESS_KEYS=${JSON.stringify(STANDARD_PRESS_KEYS)};` +
  `const PRESS_MODIFIERS=${JSON.stringify(PRESS_MODIFIERS)};` +
  `const EDITOR_COMMAND_KEYS=${JSON.stringify(EDITOR_COMMAND_KEYS)};`;

/**
 * Serializes a self-contained DOM action for Runtime.callFunctionOn without
 * depending on a page-global helper or an extension execution context.
 */
export function pageDomActionDeclaration(
  action:
    | typeof dispatchDomClick
    | typeof dispatchDomType
    | typeof dispatchDomFill
    | typeof dispatchDomSelect
    | typeof dispatchDomPress,
  prelude = "",
): string {
  return `function(...args){${prelude}${PAGE_INPUT_TYPE_TABLES}${PAGE_HELPERS}return (${action.toString()}).apply(this,args)}`;
}

/** Serializes a click or press whose requested new windows become background task tabs. */
export function pageGestureActionDeclaration(
  action: typeof dispatchDomClick | typeof dispatchDomPress,
  prelude = "",
): string {
  return `function(...args){${prelude}${PAGE_INPUT_TYPE_TABLES}${PAGE_HELPERS}return captureWindowRequests(this,()=>(${action.toString()}).apply(this,args))}`;
}

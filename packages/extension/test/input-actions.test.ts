import { describe, expect, test } from "bun:test";
import {
  captureWindowRequests,
  dispatchDomClick,
  dispatchDomFill,
  dispatchDomPress,
  dispatchDomSelect,
  dispatchDomType,
} from "../src/input-actions";

class TestEvent {
  defaultPrevented = false;
  key = "";
  code = "";
  keyCode = 0;
  which = 0;
  altKey = false;
  ctrlKey = false;
  metaKey = false;
  shiftKey = false;

  constructor(
    readonly type: string,
    init: Record<string, unknown> = {},
  ) {
    Object.assign(this, init);
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class TestElement {
  readonly events: TestEvent[] = [];
  readonly listeners = new Map<string, Array<(event: TestEvent) => void>>();
  readonly attributes: Record<string, string> = {};
  readonly ownerDocument: TestDocument;
  tabIndex = 0;
  focusCalls = 0;

  constructor() {
    this.ownerDocument = createTestDocument();
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 10, top: 20, width: 40, height: 30 };
  }

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attributes, name);
  }

  getClientRects(): Array<{ width: number }> {
    return [{ width: 40 }];
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  focus(): void {
    this.focusCalls += 1;
    this.ownerDocument.activeElement = this;
  }

  contains(node: unknown): boolean {
    return node === this;
  }

  addEventListener(type: string, listener: (event: TestEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: TestEvent): boolean {
    this.events.push(event);
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return !event.defaultPrevented;
  }
}

class TestContenteditable extends TestElement {
  content = "";
  rawAssignments = 0;
  isContentEditable = true;

  get textContent(): string {
    return this.content;
  }

  set textContent(value: string) {
    this.rawAssignments += 1;
    this.content = value;
  }
}

class TestRange {
  collapsed = false;
  end = 0;
  wholeTarget: TestElement | null = null;

  constructor(
    readonly commonAncestorContainer: TestElement,
    readonly start = 0,
  ) {}

  cloneRange(): TestRange {
    const clone = new TestRange(this.commonAncestorContainer, this.start);
    clone.collapsed = this.collapsed;
    clone.end = this.end;
    clone.wholeTarget = this.wholeTarget;
    return clone;
  }

  selectNodeContents(target: TestElement): void {
    this.wholeTarget = target;
    this.end = target instanceof TestContenteditable ? target.content.length : 0;
  }

  collapse(toStart: boolean): void {
    this.collapsed = true;
    this.end = toStart ? this.start : this.end;
  }
}

class TestSelection {
  range: TestRange | null = null;

  get rangeCount(): number {
    return this.range ? 1 : 0;
  }

  getRangeAt(index: number): TestRange {
    if (index !== 0 || !this.range) throw new Error("missing test selection range");
    return this.range;
  }

  removeAllRanges(): void {
    this.range = null;
  }

  addRange(range: TestRange): void {
    this.range = range;
  }
}

class TestDocument {
  readonly commands: Array<{ command: string; value: string; selectedAll: boolean }> = [];
  readonly selection = new TestSelection();
  activeElement: TestElement | null = null;
  commandAccepted = true;
  readonly focusables: TestElement[] = [];

  getElementById(): null {
    return null;
  }

  querySelectorAll(): TestElement[] {
    return this.focusables;
  }

  getSelection(): TestSelection {
    return this.selection;
  }

  createRange(): TestRange {
    const target = this.activeElement ?? new TestElement();
    return new TestRange(target);
  }

  execCommand(command: string, _showUi: boolean, value: string): boolean {
    const target = this.activeElement;
    const range = this.selection.range;
    this.commands.push({ command, value, selectedAll: range?.wholeTarget === target && range.collapsed === false });
    if (!this.commandAccepted || !(target instanceof TestContenteditable)) return false;
    if (command === "insertText") {
      const start = range?.wholeTarget === target && range.collapsed === false ? 0 : range?.start ?? target.content.length;
      const end = range?.wholeTarget === target && range.collapsed === false ? target.content.length : range?.end ?? start;
      target.content = `${target.content.slice(0, start)}${value}${target.content.slice(end)}`;
      const caret = start + value.length;
      this.selection.addRange(new TestRange(target, caret));
      target.dispatchEvent(new TestEvent("input", { inputType: "insertText", data: value }));
    }
    return true;
  }
}

function createTestDocument(): TestDocument {
  return new TestDocument();
}

class TestButton extends TestElement {
  disabled = false;
  type = "button";
  clicks = 0;

  click(): void {
    this.clicks += 1;
  }
}

class TestInput extends TestElement {
  disabled = false;
  readOnly = false;
  type = "text";
  nativeValue = "";
  selectionEnd: number | null = 0;
  selectionStart: number | null = 0;

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  get value(): string {
    return this.nativeValue;
  }

  set value(value: string) {
    this.nativeValue = value;
  }
}

class TestSelect extends TestElement {
  disabled = false;
  assigned: string | null = null;
  options: Array<{ value: string; disabled: boolean; parentElement: TestElement | null }> = [];

  set value(value: string) {
    this.assigned = value;
  }
}

class TestOptionGroup extends TestElement {
  disabled = false;
}

function installDomConstructors(): () => void {
  const names = [
    "Event",
    "InputEvent",
    "KeyboardEvent",
    "MouseEvent",
    "PointerEvent",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLButtonElement",
    "HTMLSelectElement",
    "HTMLOptGroupElement",
    "window",
  ] as const;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const name of names) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperties(globalThis, {
    Event: { configurable: true, writable: true, value: TestEvent },
    InputEvent: { configurable: true, writable: true, value: TestEvent },
    KeyboardEvent: { configurable: true, writable: true, value: TestEvent },
    MouseEvent: { configurable: true, writable: true, value: TestEvent },
    PointerEvent: { configurable: true, writable: true, value: TestEvent },
    HTMLElement: { configurable: true, writable: true, value: TestElement },
    HTMLInputElement: { configurable: true, writable: true, value: TestInput },
    HTMLTextAreaElement: { configurable: true, writable: true, value: class extends TestInput {} },
    HTMLButtonElement: { configurable: true, writable: true, value: TestButton },
    HTMLSelectElement: { configurable: true, writable: true, value: TestSelect },
    HTMLOptGroupElement: { configurable: true, writable: true, value: TestOptionGroup },
    window: { configurable: true, writable: true, value: { screenX: 0, screenY: 0 } },
  });
  return () => {
    for (const name of names) {
      const descriptor = saved.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

describe("background DOM input actions", () => {
  test("drives custom dropdown pointer handlers at its center without focusing after cancelled mousedown", async () => {
    const restore = installDomConstructors();
    try {
      const dropdown = new TestElement();
      let committed = false;
      dropdown.addEventListener("mousedown", (event) => event.preventDefault());
      dropdown.addEventListener("mouseup", () => {
        committed = true;
      });

      const dropdownNode: Element = dropdown as unknown as Element;
      await dispatchDomClick.call(dropdownNode);

      expect(committed).toBe(true);
      expect(dropdown.focusCalls).toBe(0);
      expect(dropdown.events.map((event) => event.type)).toEqual([
        "pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove",
        "pointerdown", "mousedown", "pointerup", "mouseup", "click",
      ]);
      expect(dropdown.events[6]).toMatchObject({ pointerType: "mouse", button: 0, buttons: 1, clientX: 30, clientY: 35 });
      expect(dropdown.events[8]).toMatchObject({ pointerType: "mouse", button: 0, buttons: 0, clientX: 30, clientY: 35 });

      const pointerCancelled = new TestElement();
      pointerCancelled.addEventListener("pointerdown", (event) => event.preventDefault());
      const pointerCancelledNode: Element = pointerCancelled as unknown as Element;
      await dispatchDomClick.call(pointerCancelledNode);
      expect(pointerCancelled.events.map((event) => event.type)).toEqual([
        "pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove",
        "pointerdown", "pointerup", "click",
      ]);
    } finally {
      restore();
    }
  });


  test("types and presses a listbox through keys without replacing custom properties or stealing descendant focus", () => {
    const restore = installDomConstructors();
    try {
      const listbox = new TestElement();
      listbox.tabIndex = -1;
      listbox.attributes.role = "listbox";
      const option = new TestElement();
      listbox.contains = (node: unknown): boolean => node === listbox || node === option;
      listbox.ownerDocument.activeElement = option;
      const observed: TestEvent[] = [];
      listbox.addEventListener("keydown", (event) => {
        observed.push(event);
        if (event.key === "Enter") event.preventDefault();
      });
      listbox.addEventListener("keypress", (event) => observed.push(event));
      listbox.addEventListener("keyup", (event) => observed.push(event));

      const listboxNode: Element = listbox as unknown as Element;
      dispatchDomType.call(listboxNode, "m");
      dispatchDomPress.call(listboxNode, "ArrowDown");
      dispatchDomPress.call(listboxNode, "Enter");
      dispatchDomPress.call(listboxNode, "Space");

      expect(listbox.focusCalls).toBe(0);
      expect("value" in listbox).toBe(false);
      expect(observed.map((event) => `${event.type}:${event.key}`)).toEqual([
        "keydown:m", "keypress:m", "keyup:m",
        "keydown:ArrowDown", "keypress:ArrowDown", "keyup:ArrowDown",
        "keydown:Enter", "keyup:Enter",
        "keydown: ", "keypress: ", "keyup: ",
      ]);
      expect(observed[3]).toMatchObject({ code: "ArrowDown", keyCode: 40, which: 40 });
      expect(observed[6]).toMatchObject({ code: "Enter", keyCode: 13, which: 13 });
    } finally {
      restore();
    }
  });

  test("activates native keyboard controls only when page handlers do not cancel the key", () => {
    const restore = installDomConstructors();
    try {
      const button = new TestButton();
      const buttonNode: Element = button as unknown as Element;
      dispatchDomPress.call(buttonNode, "Enter");
      expect(button.clicks).toBe(1);

      const cancelled = new TestButton();
      cancelled.addEventListener("keydown", (event) => event.preventDefault());
      const cancelledNode: Element = cancelled as unknown as Element;
      dispatchDomPress.call(cancelledNode, "Space");
      expect(cancelled.clicks).toBe(0);
    } finally {
      restore();
    }
  });

  test("rejects unsupported mutations and disabled or missing native select options before mutation", () => {
    const restore = installDomConstructors();
    try {
      const widget = new TestElement();
      widget.tabIndex = -1;
      const widgetNode: Element = widget as unknown as Element;
      expect(dispatchDomFill.call(widgetNode, "mutate")).toEqual({
        agenttab_invalid_request: "fill target is not an editable field",
      });

      const select = new TestSelect();
      const selectNode: Element = select as unknown as Element;
      select.options = [{ value: "monthly", disabled: true, parentElement: null }];
      expect(dispatchDomSelect.call(selectNode, "monthly")).toEqual({
        agenttab_invalid_request: "select value does not name an enabled option",
      });
      expect(select.assigned).toBeNull();
      expect(select.events).toEqual([]);

      select.options = [{ value: "monthly", disabled: false, parentElement: null }];
      dispatchDomSelect.call(selectNode, "monthly");
      expect(select.assigned).toBe("monthly");
      expect(select.events.map((event) => event.type)).toEqual(["input", "change"]);
      select.events.length = 0;
      select.assigned = null;

      const dateInput = new TestInput();
      dateInput.type = "date";
      const dateInputNode: Element = dateInput as unknown as Element;
      dispatchDomFill.call(dateInputNode, "2026-09-20");
      expect(dateInput.value).toBe("2026-09-20");
      expect(dateInput.events.map((event) => event.type)).toEqual(["input", "change"]);

      select.disabled = true;
      expect(dispatchDomSelect.call(selectNode, "other")).toEqual({
        agenttab_invalid_request: "select target is disabled",
      });
      expect(select.assigned).toBeNull();
    } finally {
      restore();
    }
  });

  test("edits rich content through one native transaction, preserving selection and fill replacement", async () => {
    const restore = installDomConstructors();
    try {
      const editor = new TestContenteditable();
      editor.tabIndex = -1;
      editor.content = "abcdef";
      const selection = new TestRange(editor, 1);
      selection.end = 4;
      editor.ownerDocument.selection.addRange(selection);
      const editorNode: Element = editor as unknown as Element;

      await dispatchDomType.call(editorNode, "X");
      expect(editor.content).toBe("aXef");
      expect(editor.ownerDocument.commands).toEqual([{ command: "insertText", value: "X", selectedAll: false }]);
      expect(editor.rawAssignments).toBe(0);

      dispatchDomFill.call(editorNode, "replacement");
      expect(editor.content).toBe("replacement");
      expect(editor.ownerDocument.commands.at(-1)).toEqual({
        command: "insertText",
        value: "replacement",
        selectedAll: true,
      });

      dispatchDomPress.call(editorNode, "z", ["Control"]);
      expect(editor.ownerDocument.commands.at(-1)).toEqual({
        command: "undo",
        value: "",
        selectedAll: false,
      });
      expect(editor.rawAssignments).toBe(0);
    } finally {
      restore();
    }
  });

  test("does not fall back after a rejected rich-editor command and rejects unsupported presses before events", async () => {
    const restore = installDomConstructors();
    try {
      const editor = new TestContenteditable();
      editor.content = "unchanged";
      editor.ownerDocument.commandAccepted = false;
      const editorNode: Element = editor as unknown as Element;

      expect(await dispatchDomType.call(editorNode, "X")).toEqual({
        agenttab_invalid_request: "contenteditable insertText command was not accepted",
      });
      expect(editor.content).toBe("unchanged");
      expect(editor.rawAssignments).toBe(0);
      expect(editor.events).toEqual([]);

      const input = new TestInput();
      const inputNode: Element = input as unknown as Element;
      expect(dispatchDomPress.call(inputNode, "q")).toEqual({
        agenttab_invalid_request: "press requires a supported key",
      });
      expect(input.events).toEqual([]);

      expect(dispatchDomPress.call(inputNode, "a", ["Control", "Control"])).toEqual({
        agenttab_invalid_request: "press modifiers must not contain duplicates",
      });
      expect(input.events).toEqual([]);
    } finally {
      restore();
    }
  });

  test("uses keydown and keypress cancellation for defaults but never lets keyup undo an accepted default", () => {
    const restore = installDomConstructors();
    try {
      const button = new TestButton();
      button.addEventListener("keyup", (event) => event.preventDefault());
      const buttonNode: Element = button as unknown as Element;
      dispatchDomPress.call(buttonNode, "Enter");
      expect(button.clicks).toBe(1);

      const textarea = new TestInput();
      textarea.addEventListener("keydown", (event) => event.preventDefault());
      const textareaNode: Element = textarea as unknown as Element;
      dispatchDomPress.call(textareaNode, "Enter");
      expect(textarea.value).toBe("");
      expect(textarea.events.map((event) => event.type)).toEqual(["keydown", "keyup"]);

      const keypressCancelled = new TestInput();
      keypressCancelled.addEventListener("keypress", (event) => event.preventDefault());
      const keypressCancelledNode: Element = keypressCancelled as unknown as Element;
      dispatchDomPress.call(keypressCancelledNode, "Space");
      expect(keypressCancelled.value).toBe("");
      expect(keypressCancelled.events.map((event) => event.type)).toEqual(["keydown", "keypress", "keyup"]);

      const selected = new TestInput();
      selected.nativeValue = "model";
      selected.selectionStart = 3;
      selected.selectionEnd = 3;
      const selectedNode: Element = selected as unknown as Element;
      dispatchDomPress.call(selectedNode, "a", ["Control"]);
      expect(selected.selectionStart).toBe(0);
      expect(selected.selectionEnd).toBe(5);
      expect(selected.events[0]).toMatchObject({ key: "a", ctrlKey: true });

      const tabSource = new TestInput();
      const tabDestination = new TestInput();
      tabSource.ownerDocument.focusables.push(tabSource, tabDestination);
      const tabSourceNode: Element = tabSource as unknown as Element;
      dispatchDomPress.call(tabSourceNode, "Tab");
      expect(tabDestination.focusCalls).toBe(1);

      const boundary = new TestInput();
      boundary.ownerDocument.focusables.push(boundary);
      const boundaryNode: Element = boundary as unknown as Element;
      expect(dispatchDomPress.call(boundaryNode, "Tab")).toEqual({
        agenttab_invalid_request: "press Tab has no page-local focus target",
      });
      expect(boundary.events).toEqual([]);
    } finally {
      restore();
    }
  });
});

class CaptureElement {
  constructor(
    readonly localName: string,
    private readonly attributes: Record<string, string> = {},
  ) {}

  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
}

class CaptureClick {
  defaultPrevented = false;

  constructor(private readonly path: unknown[]) {}

  composedPath(): unknown[] {
    return this.path;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

function captureView() {
  const nativeCalls: unknown[][] = [];
  const listeners: Array<(event: CaptureClick) => void> = [];
  const nativeOpen = (...args: unknown[]) => {
    nativeCalls.push(args);
    return { native: true };
  };
  const view = {
    Element: CaptureElement,
    document: { baseURI: "https://app.example/start/" },
    open: nativeOpen as unknown,
    addEventListener: (_type: string, listener: (event: CaptureClick) => void) => listeners.push(listener),
    removeEventListener: (_type: string, listener: (event: CaptureClick) => void) => {
      listeners.splice(listeners.indexOf(listener), 1);
    },
  };
  const click = (anchor: CaptureElement): CaptureClick => {
    const event = new CaptureClick([anchor]);
    for (const listener of [...listeners]) listener(event);
    return event;
  };
  const target = { ownerDocument: { defaultView: view } } as unknown as Element;
  return { view, nativeOpen, nativeCalls, listeners, click, target };
}

describe("window request capture", () => {
  test("diverts new-window requests into a background tab list and restores the page", async () => {
    const page = captureView();
    type Open = (url?: string, name?: string, features?: string) => unknown;
    let returned: unknown[] = [];
    let anchorEvent: CaptureClick | undefined;
    let selfAnchorEvent: CaptureClick | undefined;

    const result = await captureWindowRequests(page.target, () => {
      const open = page.view.open as Open;
      returned = [
        open("/report?id=1", "_blank", "width=420,height=320"),
        open("https://other.example/", "reports", "noopener"),
        open("", "_blank"),
        open("javascript:alert(1)"),
        open("/same", "_self"),
      ];
      anchorEvent = page.click(new CaptureElement("a", { href: "child.html", target: "_blank", rel: "opener" }));
      selfAnchorEvent = page.click(new CaptureElement("a", { href: "next.html" }));
    });

    expect(returned).toEqual([null, null, null, null, { native: true }]);
    expect(page.nativeCalls).toEqual([["/same", "_self", undefined]]);
    expect(anchorEvent?.defaultPrevented).toBe(true);
    expect(selfAnchorEvent?.defaultPrevented).toBe(false);
    expect(result).toEqual({
      agenttab_window_requests: [
        { url: "https://app.example/report?id=1", opener_severed: true },
        { url: "https://other.example/", opener_severed: false },
        { url: "about:blank", opener_severed: true, refused: "script_written_window" },
        { url: "javascript:alert(1)", opener_severed: true, refused: "unsupported_scheme" },
        { url: "https://app.example/start/child.html", opener_severed: true },
      ],
    });
    expect(page.view.open).toBe(page.nativeOpen);
    expect(page.listeners).toEqual([]);
  });

  test("leaves download anchors to the page and keeps action errors and exceptions", async () => {
    const page = captureView();
    let download: CaptureClick | undefined;
    const quiet = await captureWindowRequests(page.target, () => {
      download = page.click(new CaptureElement("a", { href: "file.csv", target: "_blank", download: "" }));
    });
    expect(quiet).toBeUndefined();
    expect(download?.defaultPrevented).toBe(false);

    const failed = await captureWindowRequests(page.target, () => {
      (page.view.open as (url: string) => unknown)("/ignored");
      return { agenttab_invalid_request: "click target is disabled" };
    });
    expect(failed).toEqual({ agenttab_invalid_request: "click target is disabled" });
    expect(page.view.open).toBe(page.nativeOpen);

    await expect(captureWindowRequests(page.target, () => {
      throw new Error("handler failed");
    })).rejects.toThrow("handler failed");
    expect(page.view.open).toBe(page.nativeOpen);
    expect(page.listeners).toEqual([]);
  });
});

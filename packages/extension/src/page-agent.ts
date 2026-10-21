import {
  captureWindowRequests,
  dispatchDomClick,
  dispatchDomFill,
  dispatchDomPress,
  dispatchDomSelect,
  dispatchDomType,
} from "./input-actions";
import { probeSurfaceEvidence } from "./challenge-guard";
import {
  PAGE_AGENT_GLOBAL,
  PAGE_AGENT_VERSION,
  type PageAgentError,
  type PageAgentPointerKind,
  type PageAgentRequest,
} from "./page-agent-protocol";
import { sensitiveFieldState } from "./sensitive-field";

// Work bound so a snapshot of a pathological document stays responsive.
const SNAPSHOT_INSPECT_LIMIT = 25_000;
const NAME_LIMIT = 200;
const VALUE_LIMIT = 500;

const INCLUDED_ROLES: Readonly<Record<string, true>> = {
  alert: true, alertdialog: true, button: true, checkbox: true, combobox: true, dialog: true, form: true,
  heading: true, img: true, link: true, listbox: true, main: true, menu: true, menubar: true, menuitem: true,
  menuitemcheckbox: true, menuitemradio: true, navigation: true, option: true, radio: true, region: true,
  searchbox: true, slider: true, spinbutton: true, status: true, switch: true, tab: true, tablist: true,
  tabpanel: true, textbox: true, treeitem: true,
};
// Landmarks that only help an agent when they carry a name.
const NAMED_ONLY_ROLES: Readonly<Record<string, true>> = { form: true, region: true };
const NAME_FROM_CONTENT_ROLES: Readonly<Record<string, true>> = {
  button: true, heading: true, link: true, menuitem: true, menuitemcheckbox: true, menuitemradio: true,
  option: true, radio: true, checkbox: true, switch: true, tab: true, treeitem: true,
};
const SKIPPED_ELEMENTS: Readonly<Record<string, true>> = {
  head: true, link: true, meta: true, noscript: true, script: true, style: true, template: true,
};

interface Registry {
  next: number;
  byId: Map<number, WeakRef<Element>>;
  ids: WeakMap<Element, number>;
}

function agentError(code: string, message: string): PageAgentError {
  return { agenttab_error: { code, message } };
}

function collapse(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

function register(registry: Registry, element: Element): number {
  const existing = registry.ids.get(element);
  if (existing !== undefined && registry.byId.get(existing)?.deref() === element) return existing;
  const id = registry.next;
  registry.next += 1;
  registry.ids.set(element, id);
  registry.byId.set(id, new WeakRef(element));
  return id;
}

function lookup(registry: Registry, id: number): Element | PageAgentError {
  const element = registry.byId.get(id)?.deref();
  if (!element || !element.isConnected) {
    registry.byId.delete(id);
    return agentError("stale_ref", "Snapshot ref no longer resolves");
  }
  return element;
}

function isAgentError(value: unknown): value is PageAgentError {
  return typeof value === "object" && value !== null && "agenttab_error" in value;
}

/** Collects selector matches across the document and every open shadow root, like the debugger route. */
function selectAll(selector: string): Element[] | PageAgentError {
  const matches = new Set<Element>();
  try {
    const visit = (root: Document | ShadowRoot): void => {
      for (const element of Array.from(root.querySelectorAll(selector))) matches.add(element);
      for (const host of Array.from(root.querySelectorAll("*"))) if (host.shadowRoot) visit(host.shadowRoot);
    };
    visit(document);
  } catch (error) {
    return agentError("invalid_request", `Invalid selector: ${error instanceof Error ? error.message : String(error)}`);
  }
  return [...matches];
}

function selectUnique(selector: string): Element | PageAgentError {
  const matches = selectAll(selector);
  if (isAgentError(matches)) return matches;
  if (matches.length === 0) return agentError("selector_not_found", `Selector did not match: ${selector}`);
  if (matches.length > 1) {
    return agentError("ambiguous_selector", `Selector matched ${matches.length} elements: ${selector}`);
  }
  return matches[0];
}

function implicitRole(element: Element): string | null {
  const tag = element.localName;
  if (tag === "a" || tag === "area") return element.hasAttribute("href") ? "link" : null;
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "option") return "option";
  if (tag === "dialog") return "dialog";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "form") return "form";
  if (tag === "section") return "region";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "img") return element.getAttribute("alt") === "" ? null : "img";
  if (tag === "select") {
    const select = element as HTMLSelectElement;
    return select.multiple || select.size > 1 ? "listbox" : "combobox";
  }
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (type === "hidden") return null;
    if (type === "button" || type === "submit" || type === "reset" || type === "image" || type === "file") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    return "textbox";
  }
  const html = element as Partial<HTMLElement>;
  if (html.isContentEditable === true && (element.parentElement as Partial<HTMLElement> | null)?.isContentEditable !== true) {
    return "textbox";
  }
  return null;
}

function textOf(node: Node | null): string {
  if (!node) return "";
  return String(((node as Partial<HTMLElement>).innerText ?? node.textContent) ?? "");
}

function accessibleName(element: Element, role: string): string {
  const root = element.getRootNode() as Document | ShadowRoot;
  const labelledBy = (element.getAttribute("aria-labelledby") ?? "").trim();
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => textOf(root.getElementById?.(id) ?? document.getElementById(id))).join(" ");
    if (text.trim()) return collapse(text, NAME_LIMIT);
  }
  const label = element.getAttribute("aria-label");
  if (label?.trim()) return collapse(label, NAME_LIMIT);
  const control = element as Partial<HTMLInputElement>;
  if (control.labels && control.labels.length > 0) {
    const text = Array.from(control.labels).map(textOf).join(" ");
    if (text.trim()) return collapse(text, NAME_LIMIT);
  }
  if (element.localName === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if ((type === "button" || type === "submit" || type === "reset") && control.value) {
      return collapse(control.value, NAME_LIMIT);
    }
    if (type === "image" && element.getAttribute("alt")) return collapse(element.getAttribute("alt") ?? "", NAME_LIMIT);
  }
  if (element.localName === "img") {
    const alt = element.getAttribute("alt");
    if (alt?.trim()) return collapse(alt, NAME_LIMIT);
  }
  if (NAME_FROM_CONTENT_ROLES[role] === true) {
    const text = textOf(element);
    if (text.trim()) return collapse(text, NAME_LIMIT);
  }
  const placeholder = element.getAttribute("placeholder");
  if (placeholder?.trim()) return collapse(placeholder, NAME_LIMIT);
  const title = element.getAttribute("title");
  return title?.trim() ? collapse(title, NAME_LIMIT) : "";
}

function isRendered(element: Element): boolean {
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({ checkVisibilityCSS: true });
  }
  return element.getClientRects().length > 0;
}

function encodeNode(element: Element, role: string, name: string, id: number): Record<string, unknown> {
  const node: Record<string, unknown> = { id, role, name };
  const sensitive = sensitiveFieldState.call(element).sensitiveField;
  const tag = element.localName;
  const control = element as Partial<HTMLInputElement>;
  if (tag === "input" && (control.type === "checkbox" || control.type === "radio")) {
    node.checked = control.checked === true;
  } else if (tag === "select") {
    const select = element as HTMLSelectElement;
    const selected = Array.from(select.selectedOptions).map((option) => option.label || option.text).join(", ");
    if (selected) node.value = collapse(selected, VALUE_LIMIT);
  } else if ((tag === "input" || tag === "textarea") && !sensitive && typeof control.value === "string" && control.value) {
    node.value = collapse(control.value, VALUE_LIMIT);
  } else if (role === "textbox" && !sensitive && (element as Partial<HTMLElement>).isContentEditable === true) {
    const text = textOf(element);
    if (text.trim()) node.value = collapse(text, VALUE_LIMIT);
  }
  const ariaChecked = element.getAttribute("aria-checked");
  if (node.checked === undefined && (ariaChecked === "true" || ariaChecked === "false" || ariaChecked === "mixed")) {
    node.checked = ariaChecked === "mixed" ? "mixed" : ariaChecked === "true";
  }
  if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") node.disabled = true;
  const expanded = element.getAttribute("aria-expanded");
  if (expanded === "true" || expanded === "false") node.expanded = expanded === "true";
  if (element.getAttribute("aria-selected") === "true" || (tag === "option" && (element as HTMLOptionElement).selected)) {
    node.selected = true;
  }
  if (role === "heading") {
    const level = Number(element.getAttribute("aria-level") ?? (/^h([1-6])$/.exec(tag)?.[1] ?? ""));
    if (Number.isInteger(level) && level > 0) node.level = level;
  }
  const describedBy = (element.getAttribute("aria-describedby") ?? "").trim();
  if (describedBy) {
    const root = element.getRootNode() as Document | ShadowRoot;
    const description = describedBy.split(/\s+/).map((id) => textOf(root.getElementById?.(id) ?? document.getElementById(id))).join(" ");
    if (description.trim()) node.description = collapse(description, NAME_LIMIT);
  }
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (active === element) node.focused = true;
  return node;
}

/**
 * Builds a compact accessibility-like outline from the DOM: interactive
 * controls, headings, images, dialogs, and named landmarks that are rendered
 * and not hidden from assistive technology. It is an approximation of
 * Chrome's accessibility tree, which only the debugger can read.
 */
function snapshot(registry: Registry, maxNodes: number, maxDepth: number, rootId?: number): unknown {
  let root: Element;
  if (rootId !== undefined) {
    const resolved = lookup(registry, rootId);
    if (isAgentError(resolved)) return resolved;
    root = resolved;
  } else {
    root = document.documentElement;
  }
  const nodes: Array<Record<string, unknown>> = [];
  let inspected = 0;
  let truncated = false;
  const consider = (element: Element): void => {
    const explicit = (element.getAttribute("role") ?? "").trim().split(/\s+/)[0]?.toLowerCase() || null;
    let role = explicit ?? implicitRole(element);
    const tabIndex = element.getAttribute("tabindex");
    const focusable = tabIndex !== null && Number(tabIndex) >= 0;
    if ((role === null || INCLUDED_ROLES[role] !== true) && !focusable) return;
    if (role === null || role === "presentation" || role === "none") role = "generic";
    if (!isRendered(element)) return;
    const name = accessibleName(element, role);
    if (NAMED_ONLY_ROLES[role] === true && !name) return;
    nodes.push(encodeNode(element, role, name, register(registry, element)));
  };
  const walk = (parent: Element | ShadowRoot, depth: number): void => {
    if (depth > maxDepth) return;
    for (const child of Array.from(parent.children)) {
      if (nodes.length > maxNodes || inspected >= SNAPSHOT_INSPECT_LIMIT) {
        truncated = true;
        return;
      }
      inspected += 1;
      if (SKIPPED_ELEMENTS[child.localName] === true) continue;
      if (child.getAttribute("aria-hidden") === "true" || child.hasAttribute("hidden") || child.hasAttribute("inert")) continue;
      consider(child);
      if (child.shadowRoot) walk(child.shadowRoot, depth + 1);
      walk(child, depth + 1);
    }
  };
  if (rootId !== undefined) consider(root);
  walk(root, 1);
  if (nodes.length > maxNodes) truncated = true;
  return { nodes: nodes.slice(0, maxNodes), truncated };
}

function describe(element: Element, requestedValue: string | null): unknown {
  const { sensitiveField, associated, accessible } = sensitiveFieldState.call(element);
  if (requestedValue !== null && sensitiveField) return { agenttab_sensitive_field: true };
  const html = element as Partial<HTMLInputElement> & Partial<HTMLSelectElement>;
  const form = html.form ?? null;
  const option = html.options && requestedValue !== null
    ? Array.from(html.options).find((candidate) => String(candidate.value) === requestedValue)
    : null;
  return {
    tag: element.tagName,
    role: element.getAttribute("role"),
    text: [(element as Partial<HTMLElement>).innerText, element.textContent].filter(Boolean).join(" "),
    aria_label: element.getAttribute("aria-label"),
    title: element.getAttribute("title"),
    name: element.getAttribute("name"),
    id: element.id,
    type: element.getAttribute("type"),
    autocomplete: element.getAttribute("autocomplete"),
    href: element.getAttribute("href"),
    form_action: form?.action,
    form_method: form?.method,
    form_enctype: form?.enctype,
    associated_labels: associated,
    accessible_labels: accessible,
    requested_option_label: option ? [option.label, option.textContent].filter(Boolean).join(" ").trim() : null,
  };
}

function inspectState(element: Element): Record<string, unknown> {
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  const connected = element.isConnected === true;
  const visible = connected && style.display !== "none" && style.visibility !== "hidden" &&
    style.visibility !== "collapse" && Number(style.opacity) !== 0 && box.width > 0 && box.height > 0;
  const disabled = element.matches(":disabled") || element.getAttribute("aria-disabled") === "true";
  const raw = (element as Partial<HTMLInputElement>).value;
  return { connected, visible, enabled: connected && !disabled, value: typeof raw === "string" ? raw : String(element.textContent ?? "") };
}

/** Center of the element, provided it is in the viewport and not obscured, matching the debugger route's hit test. */
function pointerPoint(element: Element): { x: number; y: number } | PageAgentError {
  const box = element.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  if (!(box.width > 0 && box.height > 0) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
    return agentError("action_failed", "Pointer target is outside the visible viewport");
  }
  let hit: Element | null = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  for (let node: Node | null = hit; node; node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null)) {
    if (node === element) return { x, y };
  }
  return agentError("action_failed", "Another element obscures the reviewed pointer target");
}

function dispatchPointer(element: Element, kind: PageAgentPointerKind): unknown {
  const point = pointerPoint(element);
  if (isAgentError(point)) return point;
  const base = { bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y, view: window };
  const fire = (type: string, init: Record<string, unknown> = {}): void => {
    const options = { ...base, ...init };
    element.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, options) : new MouseEvent(type, options));
  };
  fire("pointerover");
  fire("pointerenter", { bubbles: false });
  fire("mouseover");
  fire("mouseenter", { bubbles: false });
  fire("pointermove");
  fire("mousemove");
  if (kind === "hover") return undefined;
  if (kind === "context_click") {
    fire("pointerdown", { button: 2, buttons: 2 });
    fire("mousedown", { button: 2, buttons: 2 });
    fire("pointerup", { button: 2, buttons: 0 });
    fire("mouseup", { button: 2, buttons: 0 });
    fire("contextmenu", { button: 2, buttons: 0 });
    return undefined;
  }
  for (let detail = 1; detail <= 2; detail += 1) {
    fire("pointerdown", { button: 0, buttons: 1, detail });
    fire("mousedown", { button: 0, buttons: 1, detail });
    fire("pointerup", { button: 0, buttons: 0, detail });
    fire("mouseup", { button: 0, buttons: 0, detail });
    fire("click", { button: 0, buttons: 0, detail });
  }
  fire("dblclick", { button: 0, buttons: 0, detail: 2 });
  return undefined;
}

function fillCredential(element: Element, value: string, kind: string): unknown {
  const isInput = element instanceof HTMLInputElement;
  const isTextarea = element instanceof HTMLTextAreaElement;
  if (!isInput && !isTextarea) return agentError("action_failed", "Credential target is not an input");
  const type = (isInput ? element.type : "text").toLowerCase();
  const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
  const valid = kind === "password"
    ? isInput && (type === "password" || autocomplete.includes("password"))
    : kind === "otp"
      ? isInput && (autocomplete === "one-time-code" || ["text", "tel", "number"].includes(type))
      : ["text", "email", "tel"].includes(type) || isTextarea;
  if (!valid) return agentError("action_failed", "Credential target kind does not match the requested field");
  element.focus();
  const prototype = isInput ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) return agentError("action_failed", "Credential target has no value setter");
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return undefined;
}

async function run(registry: Registry, request: PageAgentRequest): Promise<unknown> {
  switch (request.op) {
    case "snapshot":
      return snapshot(registry, request.max_nodes, request.max_depth, request.root_id);
    case "select": {
      const element = selectUnique(request.selector);
      return isAgentError(element) ? element : { id: register(registry, element) };
    }
    case "probe": {
      const element = lookup(registry, request.id);
      return isAgentError(element) ? element : { id: request.id };
    }
    case "describe": {
      const element = lookup(registry, request.id);
      return isAgentError(element) ? element : describe(element, request.requested_value);
    }
    case "act": {
      const element = lookup(registry, request.id);
      if (isAgentError(element)) return element;
      if (request.kind !== "click" && sensitiveFieldState.call(element).sensitiveField) {
        return { agenttab_sensitive_field: true };
      }
      if (request.kind === "click") return captureWindowRequests(element, () => dispatchDomClick.call(element));
      if (request.kind === "press") {
        return captureWindowRequests(
          element,
          () => dispatchDomPress.call(element, String(request.key ?? ""), request.modifiers ?? []),
        );
      }
      if (request.kind === "type") return dispatchDomType.call(element, String(request.text ?? ""));
      if (request.kind === "fill") return dispatchDomFill.call(element, String(request.text ?? ""));
      return dispatchDomSelect.call(element, String(request.text ?? ""));
    }
    case "pointer": {
      const element = lookup(registry, request.id);
      return isAgentError(element) ? element : dispatchPointer(element, request.kind);
    }
    case "scroll": {
      const element = lookup(registry, request.id);
      if (isAgentError(element)) return element;
      element.scrollBy(request.delta_x, request.delta_y);
      return undefined;
    }
    case "inspect_selector": {
      const matches = selectAll(request.selector);
      if (isAgentError(matches)) return matches;
      return matches.length === 1 ? { count: 1, state: inspectState(matches[0]) } : { count: matches.length };
    }
    case "geometry": {
      const viewport = { device_pixel_ratio: devicePixelRatio, viewport_width: innerWidth, viewport_height: innerHeight };
      if (request.selector === undefined) return viewport;
      let element: Element | null;
      try {
        element = document.querySelector(request.selector);
      } catch (error) {
        return agentError("invalid_request", `Invalid selector: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!element) return agentError("selector_not_found", `Selector did not match: ${request.selector}`);
      const box = element.getBoundingClientRect();
      return { ...viewport, rect: { x: box.left, y: box.top, width: box.width, height: box.height } };
    }
    case "fill_credential": {
      const element = lookup(registry, request.id);
      return isAgentError(element) ? element : fillCredential(element, request.value, request.kind);
    }
    case "surface": {
      const element = lookup(registry, request.id);
      return isAgentError(element) ? element : probeSurfaceEvidence(element, request.selectors, false);
    }
  }
}

/** Installs the agent once per document world; a different version replaces it. */
export function installPageAgent(): void {
  const existing: unknown = Reflect.get(globalThis, PAGE_AGENT_GLOBAL);
  if (typeof existing === "object" && existing !== null && Reflect.get(existing, "version") === PAGE_AGENT_VERSION) return;
  const registry: Registry = { next: 1, byId: new Map(), ids: new WeakMap() };
  Reflect.set(globalThis, PAGE_AGENT_GLOBAL, {
    version: PAGE_AGENT_VERSION,
    run: async (request: PageAgentRequest): Promise<unknown> => {
      try {
        return await run(registry, request);
      } catch (error) {
        return agentError("action_failed", error instanceof Error ? error.message : String(error));
      }
    },
  });
}

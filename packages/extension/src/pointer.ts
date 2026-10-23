import { readState } from "./storage";
import { isRecord } from "./type-guards";

// Cosmetic agent pointer: a floating cursor with a soft glow, a dot-matrix veil
// that lights up around the cursor, click ripples, and an action caption. It is
// rendered from the extension's isolated world into a closed shadow root, so it
// never receives input, never appears in accessibility or text snapshots, and is
// concealed while screenshots are captured. Every failure is swallowed: the
// pointer must never change whether or how an action runs.

export const POINTER_HOST_TAG = "agenttab-pointer";
const POINTER_HOST_MARKUP = `<${POINTER_HOST_TAG}></${POINTER_HOST_TAG}>`;
const POINTER_IDLE_MS = 20_000;
const POINTER_SCENE_TIMEOUT_MS = 1_500;
const POINTER_LABEL_MAX = 44;

type Point = { x: number; y: number };
type PointerEffect = "click" | "focus" | "none";
type CdpSend = (
  tabId: number,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => Promise<Record<string, unknown>>;

/** A debugger-resolved node; `sessionId` names an out-of-process frame's session. */
export interface PointerTarget {
  backendNodeId: number;
  sessionId?: string;
}

type SceneCommand =
  | { op: "move"; to: Point; caption: string; effect: PointerEffect; origin: Point | null; idleMs: number }
  | { op: "drag"; from: Point; to: Point; caption: string; origin: Point | null; idleMs: number }
  | { op: "announce"; caption: string; origin: Point | null; idleMs: number }
  | { op: "conceal" }
  | { op: "reveal" };

type SceneResult = { shown: boolean; at?: Point };

interface NodeCue extends Point {
  label: string;
}

export interface ActionPointerCue {
  effect: PointerEffect;
  verb: string;
}

/** Pointer treatment for actions that target one node; other kinds have none or their own. */
export const ACTION_POINTER_CUES: Readonly<Record<string, ActionPointerCue>> = {
  click: { effect: "click", verb: "Click" },
  double_click: { effect: "click", verb: "Double-click" },
  context_click: { effect: "click", verb: "Right-click" },
  hover: { effect: "none", verb: "Hover" },
  type: { effect: "focus", verb: "Type in" },
  fill: { effect: "focus", verb: "Fill" },
  select: { effect: "focus", verb: "Choose in" },
  scroll: { effect: "none", verb: "Scroll" },
  upload_file: { effect: "focus", verb: "Attach file to" },
};

/** Strips the pointer host from serialized page HTML; its closed shadow root never serializes. */
export function withoutPointerHost(html: string): string {
  return html.includes(POINTER_HOST_MARKUP) ? html.split(POINTER_HOST_MARKUP).join("") : html;
}

export class AgentPointer {
  private readonly lastPoint = new Map<number, Point>();
  private readonly liveUntil = new Map<number, number>();
  /** Scene injections still running per tab, including ones `scene` stopped waiting for. */
  private readonly pending = new Map<number, number>();

  constructor(private readonly send: CdpSend) {}

  /**
   * Glides to a node, plays its effect, and resolves once the cursor has arrived.
   * An agent-supplied `intent` replaces the generated caption.
   */
  async point(tabId: number, node: PointerTarget, cue: ActionPointerCue, intent?: string): Promise<void> {
    try {
      if (!(await this.enabled())) return;
      const target = await this.nodeCue(tabId, node);
      if (!target) return;
      await this.play(tabId, {
        op: "move",
        to: { x: target.x, y: target.y },
        caption: intent ?? quoted(cue.verb, target.label),
        effect: cue.effect,
        origin: this.lastPoint.get(tabId) ?? null,
        idleMs: POINTER_IDLE_MS,
      });
    } catch {
      // Cosmetic only.
    }
  }

  async drag(tabId: number, sourceNode: PointerTarget, targetNode: PointerTarget, intent?: string): Promise<void> {
    try {
      if (!(await this.enabled())) return;
      const [source, target] = await Promise.all([
        this.nodeCue(tabId, sourceNode),
        this.nodeCue(tabId, targetNode),
      ]);
      if (!source || !target) return;
      await this.play(tabId, {
        op: "drag",
        from: { x: source.x, y: source.y },
        to: { x: target.x, y: target.y },
        caption: intent ?? quoted("Drag", source.label) + (target.label ? ` to “${target.label}”` : ""),
        origin: this.lastPoint.get(tabId) ?? null,
        idleMs: POINTER_IDLE_MS,
      });
    } catch {
      // Cosmetic only.
    }
  }

  /** Updates the caption without moving the cursor, for page-level actions. */
  async announce(tabId: number, caption: string): Promise<void> {
    try {
      if (!(await this.enabled())) return;
      await this.play(tabId, {
        op: "announce",
        caption,
        origin: this.lastPoint.get(tabId) ?? null,
        idleMs: POINTER_IDLE_MS,
      });
    } catch {
      // Cosmetic only.
    }
  }

  /** Runs a capture with the pointer hidden so screenshots show only the page. */
  async whileConcealed<T>(tabId: number, capture: () => Promise<T>): Promise<T> {
    if ((this.liveUntil.get(tabId) ?? 0) < Date.now() && !this.pending.has(tabId)) return capture();
    await this.scene(tabId, { op: "conceal" }).catch(() => undefined);
    try {
      return await capture();
    } finally {
      await this.scene(tabId, { op: "reveal" }).catch(() => undefined);
    }
  }

  private async enabled(): Promise<boolean> {
    return (await readState()).showAgentPointer;
  }

  private async play(tabId: number, command: SceneCommand): Promise<void> {
    // A busy page can run the injection after `scene` gives up waiting for it.
    // Count it as pending until it settles and record a late arrival, so a
    // screenshot taken meanwhile still conceals the pointer.
    this.pending.set(tabId, (this.pending.get(tabId) ?? 0) + 1);
    await this.scene(tabId, command, (result) => {
      const remaining = (this.pending.get(tabId) ?? 1) - 1;
      if (remaining > 0) this.pending.set(tabId, remaining);
      else this.pending.delete(tabId);
      if (!result?.shown) return;
      if (result.at) this.lastPoint.set(tabId, result.at);
      this.markLive(tabId, Date.now() + POINTER_IDLE_MS + 1_000);
    });
  }

  private markLive(tabId: number, until: number): void {
    const now = Date.now();
    // Forget faded pointers, so closed tabs never accumulate.
    for (const [staleTabId, staleUntil] of this.liveUntil) {
      if (staleUntil >= now) continue;
      this.liveUntil.delete(staleTabId);
      this.lastPoint.delete(staleTabId);
    }
    this.liveUntil.set(tabId, until);
  }

  private async scene(
    tabId: number,
    command: SceneCommand,
    settled?: (result: SceneResult | null) => void,
  ): Promise<SceneResult | null> {
    const { promise: timeout, resolve: expire } = Promise.withResolvers<null>();
    const timer = setTimeout(() => expire(null), POINTER_SCENE_TIMEOUT_MS);
    const injected = chrome.scripting
      .executeScript({ target: { tabId }, func: runPointerScene, args: [command] })
      .then(([frame]) => (isSceneResult(frame?.result) ? frame.result : null));
    // Runs on late completion too; the race only bounds how long the action waits.
    if (settled) void injected.then(settled, () => settled(null));
    try {
      return await Promise.race([injected, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async nodeCue(tabId: number, node: PointerTarget): Promise<NodeCue | null> {
    const resolved = await this.send(tabId, "DOM.resolveNode", { backendNodeId: node.backendNodeId }, node.sessionId);
    if (!isRecord(resolved.object) || typeof resolved.object.objectId !== "string") return null;
    const described = await this.send(tabId, "Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: NODE_CUE_FUNCTION,
      arguments: [{ value: POINTER_LABEL_MAX }],
      returnByValue: true,
    }, node.sessionId);
    const value = isRecord(described.result) ? described.result.value : null;
    if (
      !isRecord(value) ||
      typeof value.x !== "number" ||
      typeof value.y !== "number" ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y)
    ) {
      return null;
    }
    return { x: value.x, y: value.y, label: typeof value.label === "string" ? value.label : "" };
  }
}

function quoted(verb: string, label: string): string {
  return label ? `${verb} “${label}”` : verb;
}

function isSceneResult(value: unknown): value is SceneResult {
  return isRecord(value) && typeof value.shown === "boolean";
}

// Runs in the page's main world through Runtime.callFunctionOn with the target
// node as `this`. It reads geometry and a short visible label only; it never
// reads the value of a text field.
const NODE_CUE_FUNCTION = `function(maxLength){
  const el = this && this.nodeType === 1 ? this : this && this.parentElement;
  if (!el || typeof el.getBoundingClientRect !== "function") return null;
  const rect = el.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  // Map frame-relative geometry into the top viewport. A cross-origin ancestor
  // hides its frame element, so there is no honest position to show.
  let view = el.ownerDocument.defaultView;
  try {
    while (view && view !== view.top) {
      const owner = view.frameElement;
      if (!owner) return null;
      const frame = owner.getBoundingClientRect();
      x += frame.left + owner.clientLeft;
      y += frame.top + owner.clientTop;
      view = view.parent;
    }
  } catch (_) {
    return null;
  }
  const firstLine = (value) => String(value || "").split("\\n").map((line) => line.replace(/\\s+/g, " ").trim()).find(Boolean) || "";
  const attr = (name) => el.getAttribute(name);
  const tag = el.tagName;
  const labelledBy = String(attr("aria-labelledby") || "").split(/\\s+/).filter(Boolean)
    .map((id) => el.ownerDocument.getElementById(id)).filter(Boolean).map((node) => node.innerText).join(" ");
  const buttonValue = tag === "INPUT" && /^(button|submit|reset)$/i.test(el.type) ? el.value : "";
  const fieldLike = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  const candidates = [
    attr("aria-label"),
    labelledBy,
    el.labels && el.labels[0] ? el.labels[0].innerText : "",
    buttonValue,
    attr("placeholder"),
    attr("title"),
    attr("alt"),
    fieldLike ? "" : el.innerText,
    attr("name"),
  ];
  let label = "";
  for (const candidate of candidates) {
    label = firstLine(candidate);
    if (label) break;
  }
  if (label.length > maxLength) label = label.slice(0, maxLength - 1).trimEnd() + "\\u2026";
  return { x, y, label };
}`;

// Serialized into the page's isolated world by chrome.scripting. It must stay
// self-contained: no references to module scope.
export function runPointerScene(command: SceneCommand): SceneResult | Promise<SceneResult> {
  type Scene = {
    host: HTMLElement;
    stage: HTMLElement;
    cursor: HTMLElement;
    arrow: SVGSVGElement;
    caption: HTMLElement;
    glow: HTMLElement;
    wave: HTMLElement;
    at: Point | null;
    motion: number;
    wavePulse: number;
    idle: ReturnType<typeof setTimeout> | undefined;
  };
  const key = "__agenttabPointerScene";
  const store = globalThis as unknown as Record<string, Scene | undefined>;
  let scene = store[key];

  if (command.op === "conceal" || command.op === "reveal") {
    if (scene?.host.isConnected) scene.stage.toggleAttribute("data-concealed", command.op === "conceal");
    return { shown: false };
  }
  if (document.visibilityState !== "visible") return { shown: false };

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (point: Point): Point => ({
    x: Math.min(Math.max(point.x, 4), Math.max(4, innerWidth - 4)),
    y: Math.min(Math.max(point.y, 4), Math.max(4, innerHeight - 4)),
  });

  const build = (): Scene => {
    const host = document.createElement("agenttab-pointer");
    const root = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host { all: initial !important; position: fixed !important; inset: 0 !important; display: block !important;
        z-index: 2147483647 !important; pointer-events: none !important; contain: strict !important; }
      .stage { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity 200ms ease;
        --x: -999px; --y: -999px; --wx: -999px; --wy: -999px; --wr: 0px;
        --dot: rgba(255,255,255,.12); --lit: rgba(255,255,255,.62); --glow: rgba(255,255,255,.26);
        --ring: rgba(255,255,255,.9); --halo: rgba(255,255,255,.35); }
      .stage[data-tone="light"] { --dot: rgba(30,26,60,.075); --lit: rgba(98,76,235,.55);
        --glow: rgba(124,100,255,.18); --ring: rgba(98,76,235,.85); --halo: rgba(124,100,255,.28); }
      .stage[data-live] { opacity: 1; }
      .stage[data-concealed] { display: none; }
      .veil, .lit, .wave { position: absolute; inset: 0; background-size: 12px 12px; background-position: 6px 6px; }
      .veil { background-image: radial-gradient(circle, var(--dot) 0 1px, transparent 1.5px); }
      .lit, .wave { background-image: radial-gradient(circle, var(--lit) 0 1.15px, transparent 1.7px); }
      .lit { -webkit-mask-image: radial-gradient(circle 150px at var(--x) var(--y), #000 0, rgba(0,0,0,.4) 40%, transparent 100%);
        mask-image: radial-gradient(circle 150px at var(--x) var(--y), #000 0, rgba(0,0,0,.4) 40%, transparent 100%); }
      .wave { opacity: 0;
        -webkit-mask-image: radial-gradient(circle at var(--wx) var(--wy), transparent calc(var(--wr) - 30px), #000 var(--wr), transparent calc(var(--wr) + 18px));
        mask-image: radial-gradient(circle at var(--wx) var(--wy), transparent calc(var(--wr) - 30px), #000 var(--wr), transparent calc(var(--wr) + 18px)); }
      .glow { position: absolute; left: -110px; top: -110px; width: 220px; height: 220px; border-radius: 50%;
        background: radial-gradient(circle, var(--glow) 0, transparent 66%); will-change: transform; }
      .cursor { position: absolute; left: 0; top: 0; will-change: transform; }
      .arrow { position: absolute; left: -3px; top: -2px; width: 22px; height: 24px; overflow: visible;
        transform-origin: 3px 2px; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.55)) drop-shadow(0 0 7px var(--halo)); }
      .caption { position: absolute; left: 17px; top: 19px; width: max-content; max-width: 320px; padding: 5px 9px; border-radius: 7px;
        overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere;
        font: 500 12px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; letter-spacing: .01em;
        color: #f4f4f6; background: rgba(18,18,24,.84); border: 1px solid rgba(255,255,255,.14);
        box-shadow: 0 4px 16px rgba(0,0,0,.28); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
      .caption:empty { display: none; }
      .cursor[data-flip-x] .caption { left: auto; right: 6px; }
      .cursor[data-flip-y] .caption { top: auto; bottom: 8px; }
      .ring { position: absolute; left: 0; top: 0; width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%;
        border: 2px solid var(--ring); background: radial-gradient(circle, var(--halo) 0, transparent 70%);
        box-shadow: 0 0 18px var(--halo), inset 0 0 12px var(--halo); opacity: 0; }
    `);
    root.adoptedStyleSheets = [sheet];
    const stage = document.createElement("div");
    stage.className = "stage";
    stage.setAttribute("aria-hidden", "true");
    const veil = document.createElement("div");
    veil.className = "veil";
    const lit = document.createElement("div");
    lit.className = "lit";
    const wave = document.createElement("div");
    wave.className = "wave";
    const glow = document.createElement("div");
    glow.className = "glow";
    const cursor = document.createElement("div");
    cursor.className = "cursor";
    const svgNs = "http://www.w3.org/2000/svg";
    const arrow = document.createElementNS(svgNs, "svg");
    arrow.setAttribute("class", "arrow");
    arrow.setAttribute("viewBox", "0 0 22 24");
    const path = document.createElementNS(svgNs, "path");
    path.setAttribute("d", "M3 2 L3 19.2 L7.4 15.1 L10.3 21.6 L13.4 20.3 L10.6 13.9 L16.6 13.9 Z");
    path.setAttribute("fill", "#121216");
    path.setAttribute("stroke", "#ffffff");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linejoin", "round");
    arrow.append(path);
    const caption = document.createElement("span");
    caption.className = "caption";
    cursor.append(arrow, caption);
    stage.append(veil, lit, wave, glow, cursor);
    root.append(stage);
    document.documentElement.append(host);
    return {
      host,
      stage,
      cursor,
      arrow,
      caption,
      glow,
      wave,
      at: null,
      motion: 0,
      wavePulse: 0,
      idle: undefined,
    };
  };

  if (!scene || !scene.host.isConnected) {
    clearTimeout(scene?.idle);
    scene = build();
    store[key] = scene;
  }
  const active = scene;

  const place = (point: Point): void => {
    active.at = point;
    active.cursor.style.transform = `translate(${point.x}px, ${point.y}px)`;
    active.glow.style.transform = `translate(${point.x}px, ${point.y}px)`;
    active.stage.style.setProperty("--x", `${point.x}px`);
    active.stage.style.setProperty("--y", `${point.y}px`);
    active.cursor.toggleAttribute("data-flip-x", point.x > innerWidth - 300);
    active.cursor.toggleAttribute("data-flip-y", point.y > innerHeight - 56);
  };

  // Tone follows the surface behind the target, not the target itself: a blue
  // button on a black feed is a dark page. Small controls are skipped.
  const tone = (point: Point): "dark" | "light" => {
    const surfaceArea = innerWidth * innerHeight * 0.06;
    let node: Element | null = document.elementFromPoint(point.x, point.y);
    while (node) {
      const rect = node.getBoundingClientRect();
      const match = rect.width * rect.height >= surfaceArea
        ? /rgba?\(([^)]+)\)/.exec(getComputedStyle(node).backgroundColor)
        : null;
      if (match) {
        const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        if (parts.length < 4 || parts[3] > 0.5) {
          const luminance = (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
          return luminance < 0.45 ? "dark" : "light";
        }
      }
      node = node.parentElement;
    }
    return /dark/.test(getComputedStyle(document.documentElement).colorScheme) &&
      matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  };

  const setCaption = (text: string): void => {
    if (active.caption.textContent === text) return;
    active.caption.textContent = text;
    if (text && !reduceMotion) {
      active.caption.animate(
        [{ opacity: 0.4, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }],
        { duration: 200, easing: "ease-out" },
      );
    }
  };

  const glide = (from: Point, to: Point): Promise<void> => {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const duration = reduceMotion || distance < 2 ? 0 : Math.round(Math.min(560, Math.max(200, 150 + distance * 0.45)));
    const token = ++active.motion;
    if (duration === 0) {
      place(to);
      return Promise.resolve();
    }
    const bend = Math.min(56, distance * 0.12);
    const control = {
      x: (from.x + to.x) / 2 - ((to.y - from.y) / distance) * bend,
      y: (from.y + to.y) / 2 + ((to.x - from.x) / distance) * bend,
    };
    const { promise, resolve } = Promise.withResolvers<void>();
    const started = performance.now();
    const finish = (): void => {
      if (token === active.motion) place(to);
      resolve();
    };
    const fallback = setTimeout(finish, duration + 150);
    const step = (now: number): void => {
      if (token !== active.motion) {
        clearTimeout(fallback);
        resolve();
        return;
      }
      const t = Math.min(1, (now - started) / duration);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const u = 1 - e;
      place({
        x: u * u * from.x + 2 * u * e * control.x + e * e * to.x,
        y: u * u * from.y + 2 * u * e * control.y + e * e * to.y,
      });
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        clearTimeout(fallback);
        finish();
      }
    };
    requestAnimationFrame(step);
    return promise;
  };

  const press = (scale: number): void => {
    if (reduceMotion) return;
    active.arrow.animate(
      [{ transform: "scale(1)" }, { transform: `scale(${scale})`, offset: 0.35 }, { transform: "scale(1)" }],
      { duration: 260, easing: "ease-out" },
    );
  };

  const ring = (point: Point, size: number, delay: number, peak: number): void => {
    const element = document.createElement("div");
    element.className = "ring";
    element.style.width = `${size}px`;
    element.style.height = `${size}px`;
    element.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`;
    active.stage.append(element);
    const animation = element.animate(
      [
        { opacity: peak, transform: `translate(${point.x}px, ${point.y}px) scale(.2)` },
        { opacity: 0, transform: `translate(${point.x}px, ${point.y}px) scale(1)` },
      ],
      { duration: reduceMotion ? 1 : 620, delay, easing: "cubic-bezier(.2,.7,.3,1)", fill: "both" },
    );
    animation.finished.then(() => element.remove(), () => element.remove());
  };

  const shockwave = (point: Point): void => {
    if (reduceMotion) return;
    const pulse = ++active.wavePulse;
    active.stage.style.setProperty("--wx", `${point.x}px`);
    active.stage.style.setProperty("--wy", `${point.y}px`);
    const started = performance.now();
    const duration = 820;
    const step = (now: number): void => {
      if (pulse !== active.wavePulse) return;
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      active.stage.style.setProperty("--wr", `${8 + eased * 210}px`);
      active.wave.style.opacity = String((1 - t) * 0.95);
      if (t < 1) requestAnimationFrame(step);
      else active.wave.style.opacity = "0";
    };
    requestAnimationFrame(step);
  };

  const effect = (point: Point, kind: PointerEffect): void => {
    if (kind === "click") {
      press(0.82);
      ring(point, 88, 0, 1);
      ring(point, 52, 120, 0.7);
      shockwave(point);
    } else if (kind === "focus") {
      press(0.9);
      ring(point, 56, 0, 0.8);
    }
  };

  const awaken = (anchor: Point): Point => {
    clearTimeout(active.idle);
    active.idle = setTimeout(() => {
      active.stage.removeAttribute("data-live");
      active.idle = undefined;
    }, command.idleMs);
    active.stage.setAttribute("data-tone", tone(anchor));
    const wasLive = active.stage.hasAttribute("data-live");
    const start = active.at && wasLive
      ? active.at
      : clamp(command.origin ?? { x: anchor.x + 64, y: anchor.y + 84 });
    if (!wasLive || !active.at) place(start);
    active.stage.removeAttribute("data-concealed");
    active.stage.setAttribute("data-live", "");
    return start;
  };

  if (command.op === "announce") {
    const anchor = clamp(active.at ?? command.origin ?? { x: innerWidth / 2, y: innerHeight / 2 });
    awaken(anchor);
    setCaption(command.caption);
    return { shown: true, at: active.at ?? anchor };
  }
  if (command.op === "move") {
    const to = clamp(command.to);
    const start = awaken(to);
    setCaption(command.caption);
    return glide(start, to).then(() => {
      effect(to, command.effect);
      return { shown: true, at: to };
    });
  }
  const from = clamp(command.from);
  const to = clamp(command.to);
  const start = awaken(from);
  setCaption(command.caption);
  return glide(start, from)
    .then(() => {
      press(0.82);
      ring(from, 56, 0, 0.85);
      return glide(from, to);
    })
    .then(() => {
      effect(to, "click");
      return { shown: true, at: to };
    });
}

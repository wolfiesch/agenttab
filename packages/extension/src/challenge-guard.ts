/**
 * browser_act challenge guard (ADR 0002): which actions the guard governs, how an
 * episode's catalog signature defines its surface, and how evidence about a resolved
 * target is combined into an inside / outside / unknown verdict. Pure except for
 * `probeSurfaceEvidence`, which is serialized into the page and never called from the
 * extension context. The runtime (rescans, CDP lookups, refusal) lives in browser.ts.
 */

import { frameMatches, type Condition, type FrameLeaf, type Signature, type UrlFact } from "./challenge";

/** `targeted` actions carry a ref, selector, or frame; `targetless` ones act on the focused element or the page. */
export type GuardClass = "none" | "targeted" | "targetless";

const ELEMENT_ACTION_KINDS: Readonly<Record<string, true>> = {
  click: true,
  double_click: true,
  context_click: true,
  hover: true,
  type: true,
  fill: true,
  select: true,
  drag: true,
  upload_file: true,
};

/**
 * Classifies an action for the guard. `navigate`, `reload`, history movement, `close`, and
 * `dialog` are never guarded: they are how a client leaves or dismisses a challenge.
 */
export function classifyGuardedAction(action: Record<string, unknown>): GuardClass {
  const kind = action.kind;
  if (kind === "press") {
    return typeof action.ref === "string" || typeof action.selector === "string" ? "targeted" : "targetless";
  }
  if (kind === "scroll") {
    return typeof action.ref === "string" ||
      typeof action.selector === "string" ||
      typeof action.frame_id === "string"
      ? "targeted"
      : "targetless";
  }
  return typeof kind === "string" && ELEMENT_ACTION_KINDS[kind] === true ? "targeted" : "none";
}

/** The frame and element leaves of a signature's positive conditions. */
export interface SurfaceMatchers {
  frames: FrameLeaf[];
  selectors: string[];
}

/** Collects the leaves that locate a signature's surface; `not` branches describe exclusions and are skipped. */
export function surfaceMatchers(signature: Signature | undefined): SurfaceMatchers {
  const matchers: SurfaceMatchers = { frames: [], selectors: [] };
  const visit = (condition: Condition): void => {
    if ("all" in condition) condition.all.forEach(visit);
    else if ("any" in condition) condition.any.forEach(visit);
    else if ("frame" in condition) matchers.frames.push(condition.frame);
    else if ("element" in condition) matchers.selectors.push(condition.element.selector);
  };
  for (const rule of signature?.signals ?? []) visit(rule.when);
  matchers.selectors = [...new Set(matchers.selectors)];
  return matchers;
}

/** Host, path, and query of an http(s) URL in the shape frame leaves match against. */
export function urlFact(raw: string): UrlFact | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const query: Record<string, string> = Object.create(null);
    url.searchParams.forEach((value, key) => {
      if (!(key in query)) query[key] = value.slice(0, 64);
    });
    return { host: url.hostname.toLowerCase(), path: url.pathname, query: { ...query } };
  } catch {
    return undefined;
  }
}

/** True when the URL satisfies any frame leaf of the surface. */
export function urlInSurface(matchers: SurfaceMatchers, raw: string): boolean {
  const fact = urlFact(raw);
  return fact !== undefined && matchers.frames.some((leaf) => frameMatches(fact, leaf));
}

/** What the page-side probe reports for one node. */
export interface SurfaceEvidence {
  /** The node or an ancestor (crossing shadow roots and same-origin frame boundaries) matches a surface selector. */
  hit: boolean;
  /** `src` of every iframe element the node sits in or is, innermost first. */
  frames: string[];
}

export function parseSurfaceEvidence(value: unknown): SurfaceEvidence | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { hit, frames } = value as Record<string, unknown>;
  if (typeof hit !== "boolean" || !Array.isArray(frames) || !frames.every((src) => typeof src === "string")) {
    return undefined;
  }
  return { hit, frames: frames as string[] };
}

export type Containment = "inside" | "outside" | "unknown";

/**
 * Combines the evidence for a target.
 * - `ancestry`: URLs of the target's frame and its ancestors below the top document, or
 *   undefined when the frame tree could not be read. A frame whose URL is unavailable is `undefined`.
 * - `page`: the in-page probe result, or undefined when it could not run.
 * Any positive match is `inside`. `outside` needs complete evidence; otherwise the verdict is `unknown`.
 */
export function decideContainment(
  matchers: SurfaceMatchers,
  ancestry: ReadonlyArray<string | undefined> | undefined,
  page: SurfaceEvidence | undefined,
): Containment {
  if (page?.hit === true) return "inside";
  if (page?.frames.some((src) => urlInSurface(matchers, src)) === true) return "inside";
  if (ancestry?.some((url) => url !== undefined && urlInSurface(matchers, url)) === true) return "inside";
  if (ancestry === undefined || page === undefined || ancestry.some((url) => url === undefined || url === "")) {
    return "unknown";
  }
  return "outside";
}

/**
 * Runs inside the page, either through Runtime.callFunctionOn with `start` bound to the
 * resolved target node, or through chrome.scripting.executeScript with `fromActive` set to
 * inspect the focused element. It is serialized, so it MUST NOT reference anything outside
 * its own body. Read-only: no input, focus, scroll, or DOM writes.
 */
export function probeSurfaceEvidence(start: Node | null, selectors: string[], fromActive: boolean): SurfaceEvidence {
  const frames: string[] = [];
  let hit = false;
  let node: Node | null = start;
  if (fromActive) {
    let current: Element | null = document.activeElement;
    for (let hops = 0; hops < 16 && current !== null && current.tagName === "IFRAME"; hops += 1) {
      let inner: Element | null = null;
      try {
        inner = (current as HTMLIFrameElement).contentDocument?.activeElement ?? null;
      } catch {
        inner = null;
      }
      if (inner === null) break;
      current = inner;
    }
    node = current;
  }
  for (let frameHops = 0; node !== null && frameHops < 64; frameHops += 1) {
    let element: Element | null =
      node.nodeType === 1
        ? (node as Element)
        : node.nodeType === 11
          ? ((node as ShadowRoot).host ?? null)
          : node.parentElement;
    for (let steps = 0; element !== null && steps < 4096; steps += 1) {
      for (const selector of selectors) {
        try {
          if (element.matches(selector)) hit = true;
        } catch {
          // An invalid selector cannot match.
        }
      }
      if (element.tagName === "IFRAME") {
        const src = (element as HTMLIFrameElement).src || element.getAttribute("src");
        if (src) frames.push(String(src));
      }
      const parent: Element | null = element.parentElement;
      if (parent !== null) {
        element = parent;
      } else {
        const root = element.getRootNode();
        element = root.nodeType === 11 ? ((root as ShadowRoot).host ?? null) : null;
      }
    }
    const document_: Document | null = node.nodeType === 9 ? (node as Document) : node.ownerDocument;
    let owner: Element | null = null;
    try {
      owner = document_?.defaultView?.frameElement ?? null;
    } catch {
      owner = null;
    }
    node = owner;
  }
  return { hit, frames };
}

/** Runtime.callFunctionOn declaration that probes the node it is called on. Takes one argument: the selector list. */
export const SURFACE_PROBE_DECLARATION = `function(selectors){return (${probeSurfaceEvidence.toString()})(this,selectors,false)}`;

/**
 * Contract between the extension worker and the scripting page agent, the
 * route AgentTab uses when Chrome refuses its debugger for a tab. The agent
 * lives in the extension's isolated world of the tab's top document, so it
 * shares the DOM with the page but not the page's JavaScript globals.
 */

/** Bump whenever a request or response shape changes, so a stale agent reinstalls. */
export const PAGE_AGENT_VERSION = 2;
/** Bundled agent script, injected with `chrome.scripting.executeScript({ files })`. */
export const PAGE_AGENT_FILE = "page-agent.js";

export type PageAgentActionKind = "click" | "type" | "fill" | "select" | "press";
export type PageAgentPointerKind = "hover" | "double_click" | "context_click";

export type PageAgentRequest =
  | { op: "snapshot"; max_nodes: number; max_depth: number; root_id?: number }
  | { op: "select"; selector: string }
  | { op: "probe"; id: number }
  | { op: "describe"; id: number; requested_value: string | null }
  | { op: "act"; id: number; kind: PageAgentActionKind; text?: string; key?: string; modifiers?: string[] }
  | { op: "pointer"; id: number; kind: PageAgentPointerKind }
  | { op: "scroll"; id: number; delta_x: number; delta_y: number }
  | { op: "inspect_selector"; selector: string }
  | { op: "geometry"; selector?: string }
  | { op: "fill_credential"; id: number; value: string; kind: string }
  | { op: "surface"; id: number; selectors: string[] };

export interface PageAgentError {
  agenttab_error: { code: string; message: string };
}

/**
 * Runs one request against the installed agent. Serialized by
 * `chrome.scripting.executeScript({ func })`, so it must not reference module
 * scope: the global name and version arrive as arguments.
 */
export function runPageAgentRequest(request: PageAgentRequest, version: number, globalName: string): unknown {
  const agent: unknown = Reflect.get(globalThis, globalName);
  if (
    typeof agent !== "object" || agent === null ||
    Reflect.get(agent, "version") !== version ||
    typeof Reflect.get(agent, "run") !== "function"
  ) {
    return { agenttab_page_agent_missing: true };
  }
  return Reflect.apply(Reflect.get(agent, "run"), agent, [request]);
}

export const PAGE_AGENT_GLOBAL = "__agenttabPageAgent";

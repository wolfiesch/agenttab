export type AutomationRoute = "full" | "tab_only";

const RESTRICTED_ERROR_PATTERNS = [
  /the extensions gallery cannot be scripted/i,
  /cannot access a chrome(?:-extension)?:\/\/ url/i,
  /cannot access contents of (?:the )?url/i,
];

export function automationRoute(rawUrl: string | undefined): AutomationRoute {
  if (rawUrl === undefined || rawUrl.length === 0) return "tab_only";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "tab_only";
  }
  if (
    url.hostname === "chromewebstore.google.com" ||
    (url.hostname === "chrome.google.com" &&
      (url.pathname === "/webstore" || url.pathname.startsWith("/webstore/")))
  ) {
    return "tab_only";
  }
  if (url.protocol === "http:" || url.protocol === "https:") return "full";
  if (url.protocol === "about:" && url.pathname === "blank") return "full";
  return "tab_only";
}

export function automationRouteFields(rawUrl: string | undefined): Record<string, unknown> {
  const route = automationRoute(rawUrl);
  return route === "full"
    ? { automation_route: route }
    : { automation_route: route, route_reason: "browser_restricted_origin" };
}

export function restrictedOriginError(operation: string): Error {
  return Object.assign(
    new Error(`AgentTab cannot ${operation} on a browser-restricted origin`),
    {
      code: "browser_restricted_origin",
      outcome: "not_started",
      recovery: "Do not retry this AgentTab route. Use browser_handoff for the exact task tab, or navigate the task tab to a supported origin.",
    },
  );
}

/**
 * Chrome refused the debugger for a tab whose origin AgentTab can otherwise
 * script, for example because another extension embedded a frame in the page
 * or DevTools already holds the tab. The scripting route still serves it.
 */
export function debuggerUnavailableError(cause: unknown, operation?: string): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return Object.assign(
    new Error(
      operation === undefined
        ? `Chrome refused AgentTab's debugger for this tab: ${reason}`
        : `${operation} needs Chrome's debugger, which Chrome refused for this tab: ${reason}`,
    ),
    {
      code: "debugger_unavailable",
      outcome: "not_started",
      reason,
      cause,
      recovery: "Snapshots, element actions, credential fills, and load, URL, text, selector, and value waits use AgentTab's scripting route on this tab. Frame-scoped control, drag, file upload, dialogs, downloads, network-idle waits, and full-page or background-tab screenshots need the debugger; they work again once the condition Chrome reports clears, such as another extension's frame on the page or open DevTools.",
    },
  );
}

/** Translates raw Chrome errors only; AgentTab's own coded errors pass through. */
export function normalizeRestrictedOriginError(error: unknown, operation: string): unknown {
  if (typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string") return error;
  const message = error instanceof Error ? error.message : String(error);
  return RESTRICTED_ERROR_PATTERNS.some((pattern) => pattern.test(message))
    ? restrictedOriginError(operation)
    : error;
}

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

export function normalizeRestrictedOriginError(error: unknown, operation: string): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return RESTRICTED_ERROR_PATTERNS.some((pattern) => pattern.test(message))
    ? restrictedOriginError(operation)
    : error;
}

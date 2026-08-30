import type { ToolMethod } from "./tool-method";

export interface RenderTheme {
  fg?(color: string, text: string): string;
  bold?(text: string): string;
}

export interface RenderComponent {
  render(width: number): readonly string[];
  invalidate(): void;
}

export interface RenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
}

export interface ToolResult {
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|token)/i;
const MAX_EXPANDED_LINES = 160;

export function createCallComponent(method: ToolMethod, args: unknown, theme: RenderTheme): RenderComponent {
  const description = describeCall(method, toRecord(args));
  return component((width) => [renderHeader(theme, description.title, description.meta, width)]);
}

export function createResultComponent(
  method: ToolMethod,
  result: ToolResult,
  options: RenderOptions,
  theme: RenderTheme,
  args: unknown,
): RenderComponent {
  const partial = options.isPartial === true;
  const failed = result.isError === true;
  const summary = partial ? "Working…" : failed ? errorSummary(result) : summarizeResult(method, toRecord(args), result.details);
  const details = options.expanded && !partial ? expandedLines(result.details) : [];
  return component((width) => {
    const color = partial ? "warning" : failed ? "error" : "success";
    return [
      fg(theme, color, truncate(summary, width)),
      ...details.map((line) => fg(theme, "dim", `  ${truncate(line, Math.max(1, width - 2))}`)),
    ];
  });
}

function describeCall(method: ToolMethod, args: Record<string, unknown>): { title: string; meta?: string } {
  switch (method) {
    case "browser_open":
      return fieldString(args, "mode") === "adopt_active"
        ? { title: "Adopt active tab", meta: "explicit task ownership" }
        : { title: "Open task tab", meta: joinMeta(safeUrl(fieldString(args, "url")), fieldBoolean(args, "background") === false ? "foreground" : "background") };
    case "browser_snapshot":
      return {
        title: `Snapshot ${fieldString(args, "mode") ?? "page"}`,
        meta: joinMeta(tabMeta(fieldNumber(args, "tab_id")), selectorMeta(fieldString(args, "selector") ?? fieldString(args, "root_ref"))),
      };
    case "browser_act":
      return describeActions(args);
    case "browser_wait": {
      const condition = toRecord(args.condition);
      return {
        title: `Wait for ${humanize(fieldString(condition, "kind") ?? "condition")}`,
        meta: joinMeta(targetMeta(condition), tabMeta(fieldNumber(args, "tab_id"))),
      };
    }
    case "browser_tabs":
      return { title: "List task tabs", meta: "current connection" };
    case "browser_handoff": {
      const completion = toRecord(args.completion);
      return {
        title: "Hand off to user",
        meta: joinMeta(tabMeta(fieldNumber(args, "tab_id")), humanize(fieldString(completion, "kind") ?? "manual completion")),
      };
    }
    case "browser_commit":
      return { title: "Commit staged action", meta: "approved one-use token" };
    case "browser_developer":
      return { title: "Developer action", meta: fieldString(args, "action") };
  }
}

function describeActions(args: Record<string, unknown>): { title: string; meta?: string } {
  const actions = Array.isArray(args.actions) ? args.actions.map(toRecord) : [];
  if (actions.length !== 1) {
    return { title: `Run ${actions.length} browser actions`, meta: tabMeta(fieldNumber(args, "tab_id")) };
  }
  const action = actions[0];
  const kind = fieldString(action, "kind") ?? "action";
  const titles: Record<string, string> = {
    click: "Click",
    type: "Type",
    fill: "Fill",
    select: "Select option",
    scroll: "Scroll",
    drag: "Drag",
    navigate: "Navigate",
    go_back: "Go back",
    go_forward: "Go forward",
    reload: "Reload",
    close: "Close tab",
    dialog: "Resolve dialog",
    upload_file: "Upload file",
  };
  let target: string | undefined;
  if (kind === "type" || kind === "fill") target = joinMeta(selectorMeta(fieldString(action, "ref")), charCount(fieldString(action, "text")));
  else if (kind === "select") target = joinMeta(selectorMeta(fieldString(action, "ref")), "value hidden");
  else if (kind === "drag") target = joinMeta(selectorMeta(fieldString(action, "ref")), "→", selectorMeta(fieldString(action, "target_ref")));
  else if (kind === "navigate") target = safeUrl(fieldString(action, "url"));
  else if (kind === "scroll") target = joinMeta(selectorMeta(fieldString(action, "ref")), `${fieldNumber(action, "delta_x") ?? 0},${fieldNumber(action, "delta_y") ?? 0}`);
  else if (kind === "dialog") target = fieldString(action, "decision");
  else if (kind === "upload_file") target = `${Array.isArray(action.files) ? action.files.length : 0} files`;
  else target = selectorMeta(fieldString(action, "ref"));
  return { title: titles[kind] ?? humanize(kind), meta: joinMeta(target, tabMeta(fieldNumber(args, "tab_id"))) };
}

function summarizeResult(method: ToolMethod, args: Record<string, unknown>, details: unknown): string {
  const result = toRecord(details);
  switch (method) {
    case "browser_open":
      return joinMeta("Task tab ready", tabMeta(fieldNumber(result, "tab_id")), taskMeta(result)) ?? "Task tab ready";
    case "browser_snapshot": {
      const mode = fieldString(args, "mode");
      if (mode === "accessibility") return countSummary(observationItems(details), "node");
      if (mode === "screenshot") return "Screenshot captured";
      const text = fieldString(result, mode === "html" ? "html" : "text");
      return text === undefined ? `${humanize(mode ?? "page")} snapshot ready` : `${text.length.toLocaleString()} characters read`;
    }
    case "browser_act": {
      const outcome = fieldString(result, "outcome");
      if (outcome) return humanize(outcome);
      const actions = Array.isArray(args.actions) ? args.actions.length : 0;
      return `${actions} browser action${actions === 1 ? "" : "s"} complete`;
    }
    case "browser_wait":
      return "Wait condition matched";
    case "browser_tabs":
      return countSummary(Array.isArray(result.tabs) ? result.tabs : [], "task tab");
    case "browser_handoff":
      return "User handoff completed";
    case "browser_commit":
      return humanize(fieldString(result, "outcome") ?? "staged action committed");
    case "browser_developer":
      return "Developer action complete";
  }
}

function observationItems(details: unknown): unknown[] {
  if (Array.isArray(details)) return details;
  const value = toRecord(details);
  if (Array.isArray(value.nodes)) return value.nodes;
  if (Array.isArray(value.items)) return value.items;
  const snapshot = toRecord(value.snapshot);
  return Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
}

function expandedLines(details: unknown): string[] {
  if (details === undefined) return [];
  const safe = sanitize(details);
  let text: string;
  try {
    text = typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
  } catch {
    text = String(safe);
  }
  const lines = text.split("\n");
  return lines.length <= MAX_EXPANDED_LINES
    ? lines
    : [...lines.slice(0, MAX_EXPANDED_LINES), `… ${lines.length - MAX_EXPANDED_LINES} more lines`];
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[redacted]" : sanitize(entry, seen),
  ]));
}

function errorSummary(result: ToolResult): string {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  return text ? text.split("\n", 1)[0] : "AgentTab action failed";
}

function targetMeta(condition: Record<string, unknown>): string | undefined {
  const kind = fieldString(condition, "kind");
  const value = fieldString(condition, "value");
  if (!value) return undefined;
  if (kind === "selector") return selectorMeta(value);
  return kind === "text" || kind === "url" ? quote(value) : value;
}

function taskMeta(value: Record<string, unknown>): string | undefined {
  return shortId(fieldString(value, "task_id") ?? fieldString(value, "taskId"));
}

function countSummary(values: unknown[], noun: string): string {
  return `${values.length} ${noun}${values.length === 1 ? "" : "s"}`;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fieldString(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function fieldNumber(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : undefined;
}

function fieldBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  return typeof value[key] === "boolean" ? value[key] : undefined;
}

function tabMeta(tabId: number | undefined): string | undefined {
  return tabId === undefined ? undefined : `tab ${tabId}`;
}

function selectorMeta(selector: string | undefined): string | undefined {
  if (!selector) return undefined;
  return selector.startsWith("ref=") ? selector.slice(4) : selector;
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

function shortId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function quote(value: string): string {
  return `“${value}”`;
}

function charCount(value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${value.length} character${value.length === 1 ? "" : "s"}`;
}

function humanize(value: string): string {
  const normalized = value.replaceAll("_", " ");
  return normalized.length === 0 ? "Action" : `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
}

function joinMeta(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part));
  return present.length === 0 ? undefined : present.join(" · ");
}

function renderHeader(theme: RenderTheme, title: string, meta: string | undefined, width: number): string {
  const safeWidth = Math.max(1, width || 1);
  if (!meta) return fg(theme, "toolTitle", bold(theme, truncate(title, safeWidth)));
  const available = safeWidth - title.length - 3;
  if (available < 4) return fg(theme, "toolTitle", bold(theme, truncate(title, safeWidth)));
  return `${fg(theme, "toolTitle", bold(theme, title))}${fg(theme, "muted", ` · ${truncate(meta, available)}`)}`;
}

function truncate(value: string, width: number): string {
  const text = value.replace(/[\r\n\t]+/g, " ");
  if (text.length <= width) return text;
  return width <= 1 ? "…" : `${text.slice(0, width - 1)}…`;
}

function fg(theme: RenderTheme, color: string, text: string): string {
  return theme.fg ? theme.fg(color, text) : text;
}

function bold(theme: RenderTheme, text: string): string {
  return theme.bold ? theme.bold(text) : text;
}

function component(render: (width: number) => readonly string[]): RenderComponent {
  return { render, invalidate() { } };
}

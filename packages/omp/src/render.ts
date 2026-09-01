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

export type OperationCardStatus =
  | "planned"
  | "running"
  | "awaiting_user"
  | "awaiting_approval"
  | "executed"
  | "observed"
  | "uncertain"
  | "blocked";

export interface OperationCardStep {
  label: string;
  state: "done" | "active" | "pending" | "uncertain" | "blocked";
}

export interface OperationCard {
  version: 1;
  method: ToolMethod;
  status: OperationCardStatus;
  title: string;
  meta: readonly string[];
  context: {
    taskId?: string;
    tabId?: number;
    pageRevision?: number;
    owned: boolean;
  };
  steps: readonly OperationCardStep[];
  actions: readonly string[];
  notices: readonly string[];
  evidence: readonly string[];
  details?: unknown;
}

const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|token)/i;
const MAX_EXPANDED_LINES = 160;
const STATUS_LABEL: Readonly<Record<OperationCardStatus, string>> = {
  planned: "🧭 Plan",
  running: "🔄 Working",
  awaiting_user: "👤 Your turn",
  awaiting_approval: "🔒 Review",
  executed: "🚀 Executed",
  observed: "🔎 Observed",
  uncertain: "🤔 Uncertain",
  blocked: "🛑 Blocked",
};

export function createCallComponent(method: ToolMethod, args: unknown, theme: RenderTheme): RenderComponent {
  return operationCardComponent(createCallCard(method, args), false, theme);
}

export function createResultComponent(
  method: ToolMethod,
  result: ToolResult,
  options: RenderOptions,
  theme: RenderTheme,
  args: unknown,
): RenderComponent {
  return operationCardComponent(createResultCard(method, result, options, args), options.expanded === true, theme);
}

export function createCallCard(method: ToolMethod, args: unknown): OperationCard {
  const callArgs = toRecord(args);
  const description = describeCall(method, callArgs);
  const context = operationContext(method, callArgs);
  return {
    version: 1,
    method,
    status: "planned",
    title: description.title,
    meta: present(description.meta),
    context,
    steps: operationSteps("planned", method),
    actions: method === "browser_act" ? actionDescriptions(callArgs) : [],
    notices: sensitiveInputNotices(callArgs),
    evidence: [],
  };
}

export function createResultCard(
  method: ToolMethod,
  result: ToolResult,
  options: RenderOptions,
  args: unknown,
): OperationCard {
  const callArgs = toRecord(args);
  const details = result.details;
  const values = toRecord(details);
  const status = resultStatus(method, result, options, values);
  const notices = [
    ...sensitiveInputNotices(callArgs),
    ...resultNotices(status, values),
  ];
  return {
    version: 1,
    method,
    status,
    title: options.isPartial === true
      ? method === "browser_handoff" ? "Waiting for user" : "Working…"
      : result.isError === true
        ? errorSummary(result)
        : summarizeResult(method, callArgs, details, status),
    meta: [],
    context: operationContext(method, callArgs, values),
    steps: operationSteps(status, method),
    actions: method === "browser_act" ? actionDescriptions(callArgs) : [],
    notices,
    evidence: extractEvidence(values),
    ...(options.isPartial === true ? {} : { details }),
  };
}

export function renderOperationCard(
  card: OperationCard,
  width: number,
  expanded: boolean,
  theme: RenderTheme = {},
): readonly string[] {
  const safeWidth = Math.max(1, width || 1);
  const color = card.status === "blocked"
    ? "error"
    : card.status === "planned" || card.status === "running" || card.status === "awaiting_user" ||
      card.status === "awaiting_approval" || card.status === "uncertain"
      ? "warning"
      : card.status === "observed"
        ? "success"
        : "toolTitle";
  const meta = joinMeta(...card.meta, ...contextMeta(card.context));
  const lines = [
    renderHeader(theme, `${statusLabel(card.status)} · ${card.title}`, meta, safeWidth, color),
  ];
  if (card.status === "running") return lines;
  const showLifecycle = expanded || card.status === "planned" ||
    card.status === "awaiting_user" || card.status === "awaiting_approval" ||
    card.status === "uncertain" || card.status === "blocked";
  if (showLifecycle) {
    lines.push(fg(theme, "dim", truncate(`  Flow · ${renderSteps(card.steps)}`, Math.max(1, safeWidth - 2))));
  }
  if (expanded && card.actions.length > 1) {
    lines.push(fg(theme, "muted", truncate("  Actions", Math.max(1, safeWidth - 2))));
    for (const [index, action] of card.actions.entries()) {
      lines.push(fg(theme, "dim", truncate(`    ${index + 1}. ${action}`, Math.max(1, safeWidth - 4))));
    }
  }
  if (expanded || showLifecycle) {
    for (const notice of card.notices) {
      lines.push(fg(theme, "warning", truncate(`  ${notice}`, Math.max(1, safeWidth - 2))));
    }
  }
  if (expanded) {
    for (const evidence of card.evidence) {
      lines.push(fg(theme, "success", truncate(`  ${evidence}`, Math.max(1, safeWidth - 2))));
    }
    if (card.details !== undefined) {
      lines.push(fg(theme, "muted", truncate("  Details · redacted structured result", Math.max(1, safeWidth - 2))));
      lines.push(...expandedLines(card.details).map((line) =>
        fg(theme, "dim", `    ${truncate(line, Math.max(1, safeWidth - 4))}`)
      ));
    }
  }
  return lines;
}

function operationCardComponent(card: OperationCard, expanded: boolean, theme: RenderTheme): RenderComponent {
  return component((width) => renderOperationCard(card, width, expanded, theme));
}

function describeCall(method: ToolMethod, args: Record<string, unknown>): { title: string; meta?: string } {
  switch (method) {
    case "browser_open":
      return fieldString(args, "mode") === "adopt_active"
        ? { title: "Adopt active tab", meta: "explicit task ownership" }
        : fieldString(args, "placement") === "new_window"
          ? {
            title: "Open task window",
            meta: joinMeta(safeUrl(fieldString(args, "url")), "background"),
          }
          : {
            title: "Open task tab",
            meta: joinMeta(
              safeUrl(fieldString(args, "url")),
              fieldBoolean(args, "background") === false ? "foreground" : "background",
            ),
          };
    case "browser_snapshot":
      return {
        title: `Snapshot ${fieldString(args, "mode") ?? "page"}`,
        meta: selectorMeta(fieldString(args, "selector") ?? fieldString(args, "root_ref")),
      };
    case "browser_act":
      return describeActions(args);
    case "browser_wait": {
      const condition = toRecord(args.condition);
      return {
        title: `Wait for ${humanize(fieldString(condition, "kind") ?? "condition")}`,
        meta: targetMeta(condition),
      };
    }
    case "browser_tabs":
      return { title: "List task tabs", meta: "current connection" };
    case "browser_handoff": {
      const completion = toRecord(args.completion);
      return {
        title: "Hand off to user",
        meta: humanize(fieldString(completion, "kind") ?? "manual completion"),
      };
    }
    case "browser_credentials": {
      const action = fieldString(args, "action") ?? "prepare";
      return {
        title: action === "prepare"
          ? "Prepare 1Password credentials"
          : action === "next"
            ? "Try next 1Password login"
            : "Fill 1Password login",
        meta: action === "prepare" ? "origin-bound" : "values stay hidden",
      };
    }
    case "browser_commit":
      return { title: "Commit staged action", meta: "approved one-use token" };
    case "browser_finish":
      return {
        title: "Finish browser task",
        meta: fieldString(args, "disposition") ?? "automatic cleanup",
      };
    case "browser_developer":
      return { title: "Developer action", meta: fieldString(args, "action") };
  }
}

function describeActions(args: Record<string, unknown>): { title: string; meta?: string } {
  const actions = actionDescriptions(args);
  return actions.length === 1
    ? splitActionDescription(actions[0])
    : { title: `Run ${actions.length} browser actions` };
}

function actionDescriptions(args: Record<string, unknown>): string[] {
  const actions = Array.isArray(args.actions) ? args.actions.map(toRecord) : [];
  return actions.map((action) => {
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
    if (kind === "type" || kind === "fill") {
      target = joinMeta(selectorMeta(fieldString(action, "ref")), charCount(fieldString(action, "text")));
    } else if (kind === "select") {
      target = joinMeta(selectorMeta(fieldString(action, "ref")), "value hidden");
    } else if (kind === "drag") {
      target = joinMeta(selectorMeta(fieldString(action, "ref")), "→", selectorMeta(fieldString(action, "target_ref")));
    } else if (kind === "navigate") {
      target = safeUrl(fieldString(action, "url"));
    } else if (kind === "scroll") {
      target = joinMeta(
        selectorMeta(fieldString(action, "ref")),
        `${fieldNumber(action, "delta_x") ?? 0},${fieldNumber(action, "delta_y") ?? 0}`,
      );
    } else if (kind === "dialog") {
      target = fieldString(action, "decision");
    } else if (kind === "upload_file") {
      target = countSummary(Array.isArray(action.files) ? action.files : [], "file");
    } else {
      target = selectorMeta(fieldString(action, "ref"));
    }
    return joinMeta(titles[kind] ?? humanize(kind), target) ?? humanize(kind);
  });
}

function splitActionDescription(value: string): { title: string; meta?: string } {
  const [title, ...meta] = value.split(" · ");
  return { title, ...(meta.length === 0 ? {} : { meta: meta.join(" · ") }) };
}

function summarizeResult(
  method: ToolMethod,
  args: Record<string, unknown>,
  details: unknown,
  status: OperationCardStatus,
): string {
  const result = toRecord(details);
  if (status === "awaiting_approval") {
    const effect = fieldString(result, "effect");
    return effect ? `Approval required for ${effect}` : "Human approval required";
  }
  switch (method) {
    case "browser_open":
      return fieldString(args, "mode") === "adopt_active"
        ? "Active tab adopted"
        : fieldString(args, "placement") === "new_window"
          ? "Task window opened"
          : "Task tab opened";
    case "browser_snapshot": {
      const mode = fieldString(args, "mode");
      if (mode === "accessibility") {
        const compactCount = fieldNumber(result, "nodes_count");
        return compactCount === undefined
          ? countSummary(observationItems(details), "node")
          : countLabel(compactCount, "node");
      }
      if (mode === "screenshot") return "Screenshot captured";
      const text = fieldString(result, "content") ?? fieldString(result, mode === "html" ? "html" : "text");
      const compactCharacters = fieldNumber(result, "content_characters") ??
        fieldNumber(result, `${mode ?? "content"}_characters`);
      const characters = text?.length ?? compactCharacters;
      return characters === undefined
        ? `${humanize(mode ?? "page")} snapshot ready`
        : `${characters.toLocaleString()} characters read`;
    }
    case "browser_act": {
      const actions = Array.isArray(args.actions) ? args.actions.length : 0;
      return `${actions} browser action${actions === 1 ? "" : "s"} executed`;
    }
    case "browser_wait":
      return "Wait condition observed";
    case "browser_tabs":
      return typeof result.tabs_count === "number"
        ? countLabel(result.tabs_count, "task tab")
        : countSummary(Array.isArray(result.tabs) ? result.tabs : [], "task tab");
    case "browser_handoff":
      return status === "awaiting_user" ? "Waiting for user" : "User handoff completed";
    case "browser_credentials": {
      const credentialStatus = fieldString(result, "status");
      if (credentialStatus === "ready") {
        const count = fieldNumber(result, "candidate_count") ?? 0;
        return `${count} matching login${count === 1 ? "" : "s"} ready`;
      }
      if (credentialStatus === "filled") return "Credentials filled";
      return credentialStatus ? humanize(credentialStatus) : "Credential action completed";
    }
    case "browser_commit":
      return "Staged action executed";
    case "browser_finish": {
      if (result.finished === false) {
        return `Task finalization deferred · ${humanize(fieldString(result, "deferred") ?? "not ready")}`;
      }
      const closed = Array.isArray(result.closed_tab_ids) ? result.closed_tab_ids.length : 0;
      const retained = Array.isArray(result.retained_tab_ids) ? result.retained_tab_ids.length : 0;
      return `Browser task finished · ${closed} closed · ${retained} retained`;
    }
    case "browser_developer":
      return "Developer action executed";
  }
}

function resultStatus(
  method: ToolMethod,
  result: ToolResult,
  options: RenderOptions,
  details: Record<string, unknown>,
): OperationCardStatus {
  const outcome = fieldString(toRecord(details._agenttab), "outcome") ?? fieldString(details, "outcome");
  if (outcome === "unknown") return "uncertain";
  if (method === "browser_handoff" && outcome === "needs_user") return "awaiting_user";
  if (method === "browser_credentials" && outcome === "needs_user") return "awaiting_user";
  if (options.isPartial === true) {
    return method === "browser_handoff" || method === "browser_credentials"
      ? "awaiting_user"
      : "running";
  }
  if (result.isError === true) return "blocked";
  if (typeof details.staged_token === "string" || details.awaiting_human_approval === true) {
    return "awaiting_approval";
  }
  if (method === "browser_handoff") return "observed";
  if (method === "browser_snapshot" || method === "browser_wait" || method === "browser_tabs") {
    return "observed";
  }
  return "executed";
}

function operationContext(
  method: ToolMethod,
  args: Record<string, unknown>,
  details: Record<string, unknown> = {},
): OperationCard["context"] {
  const presentation = toRecord(details._agenttab);
  const tabs = Array.isArray(details.tabs) ? details.tabs.map(toRecord) : [];
  const taskIds = tabs
    .map((tab) => fieldString(tab, "task_id") ?? fieldString(tab, "taskId"))
    .filter((taskId): taskId is string => taskId !== undefined);
  const commonTaskId = taskIds.length > 0 && taskIds.every((taskId) => taskId === taskIds[0])
    ? taskIds[0]
    : undefined;
  return {
    taskId: fieldString(presentation, "task_id") ??
      fieldString(details, "task_id") ??
      fieldString(details, "taskId") ??
      commonTaskId,
    tabId: fieldNumber(details, "tab_id") ?? fieldNumber(args, "tab_id"),
    pageRevision: fieldNumber(details, "page_revision") ?? fieldNumber(args, "expected_page_revision"),
    owned: method !== "browser_developer",
  };
}

function contextMeta(context: OperationCard["context"]): string[] {
  return present(
    context.taskId ? `task ${shortId(context.taskId)}` : undefined,
    tabMeta(context.tabId),
    context.pageRevision === undefined ? undefined : `rev ${context.pageRevision}`,
    context.owned ? "task-owned" : undefined,
  );
}

function operationSteps(status: OperationCardStatus, method: ToolMethod): readonly OperationCardStep[] {
  if (method === "browser_handoff") {
    switch (status) {
      case "planned":
        return [
          { label: "Intent", state: "active" },
          { label: "Human", state: "pending" },
          { label: "Resume", state: "pending" },
        ];
      case "awaiting_user":
        return [
          { label: "Intent", state: "done" },
          { label: "Human", state: "active" },
          { label: "Resume", state: "pending" },
        ];
      case "observed":
        return [
          { label: "Intent", state: "done" },
          { label: "Human", state: "done" },
          { label: "Resume", state: "done" },
        ];
      case "blocked":
        return [
          { label: "Intent", state: "done" },
          { label: "Handoff", state: "blocked" },
          { label: "Resume", state: "pending" },
        ];
      default:
        break;
    }
  }
  switch (status) {
    case "planned":
      return [
        { label: "Intent", state: "active" },
        { label: "Decision", state: "pending" },
        { label: "Execute", state: "pending" },
        { label: "Observe", state: "pending" },
      ];
    case "running":
      return [
        { label: "Intent", state: "done" },
        { label: "Decision", state: "active" },
        { label: "Execute", state: "pending" },
        { label: "Observe", state: "pending" },
      ];
    case "awaiting_approval":
      return [
        { label: "Intent", state: "done" },
        { label: "Approval", state: "active" },
        { label: "Execute", state: "pending" },
        { label: "Observe", state: "pending" },
      ];
    case "awaiting_user":
      return [
        { label: "Intent", state: "done" },
        { label: "Decision", state: "done" },
        { label: "Human", state: "active" },
        { label: "Observe", state: "pending" },
      ];
    case "executed":
      return [
        { label: "Intent", state: "done" },
        { label: "Decision", state: "done" },
        { label: "Execute", state: "done" },
        { label: "Observe", state: "active" },
      ];
    case "observed":
      return [
        { label: "Intent", state: "done" },
        { label: "Decision", state: "done" },
        { label: "Execute", state: "done" },
        { label: "Observe", state: "done" },
      ];
    case "uncertain":
      return [
        { label: "Intent", state: "done" },
        { label: "Execute", state: "uncertain" },
        { label: "Reconcile", state: "active" },
      ];
    case "blocked":
      return [
        { label: "Intent", state: "done" },
        { label: "Operation", state: "blocked" },
        { label: "Observe", state: "pending" },
      ];
  }
}

function renderSteps(steps: readonly OperationCardStep[]): string {
  const marker: Record<OperationCardStep["state"], string> = {
    done: "✓",
    active: "▶",
    pending: "·",
    blocked: "×",
    uncertain: "?",
  };
  return steps.map((step) => `${marker[step.state]} ${step.label}`).join("  ");
}

function statusLabel(status: OperationCardStatus): string {
  return STATUS_LABEL[status];
}

function sensitiveInputNotices(args: Record<string, unknown>): string[] {
  const actions = Array.isArray(args.actions) ? args.actions.map(toRecord) : [];
  const hiddenValues = actions.filter((action) => {
    const kind = fieldString(action, "kind");
    return kind === "type" || kind === "fill" || kind === "select" || kind === "upload_file";
  }).length;
  const hiddenTokens = typeof args.staged_token === "string" ? 1 : 0;
  const hidden = hiddenValues + hiddenTokens;
  return hidden === 0
    ? []
    : [`Privacy · ${hidden} sensitive input${hidden === 1 ? "" : "s"} hidden`];
}

function resultNotices(status: OperationCardStatus, details: Record<string, unknown>): string[] {
  const notices: string[] = [];
  if (status === "awaiting_approval") {
    notices.push("Policy · Consequential action paused before execution");
  }
  if (status === "uncertain") {
    notices.push("Safety · Execution may have occurred; inspect live state before retrying");
  }
  if (status === "blocked") {
    const code = fieldString(details, "code");
    notices.push(code ? `Blocked · ${humanize(code)}` : "Blocked · No browser state was assumed");
  }
  if (containsSensitiveKey(details)) {
    notices.push("Privacy · Sensitive fields redacted below");
  }
  return notices;
}

function containsSensitiveKey(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsSensitiveKey(entry, seen));
  return Object.entries(value).some(([key, entry]) =>
    SENSITIVE_KEY.test(key) || containsSensitiveKey(entry, seen)
  );
}

function present(...values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function extractEvidence(details: Record<string, unknown>): string[] {
  const evidence: string[] = [];
  const openedTabs = Array.isArray(details.opened_tabs) ? details.opened_tabs.length : 0;
  const closedTabs = Array.isArray(details.closed_tabs) ? details.closed_tabs.length : 0;
  if (openedTabs > 0) evidence.push(`Evidence · ${openedTabs} new tab${openedTabs === 1 ? "" : "s"}`);
  if (closedTabs > 0) evidence.push(`Evidence · ${closedTabs} tab${closedTabs === 1 ? "" : "s"} closed`);
  const dialog = toRecord(details.dialog);
  const dialogStatus = fieldString(dialog, "status");
  if (dialogStatus) {
    evidence.push(`Dialog · ${humanize(fieldString(dialog, "type") ?? "modal")} ${dialogStatus}`);
  }
  const download = toRecord(details.download);
  const downloadState = fieldString(download, "state");
  if (downloadState) evidence.push(`Download · ${humanize(downloadState)}`);
  return evidence;
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
  if (text) return text.split("\n", 1)[0];
  const code = fieldString(toRecord(result.details), "code");
  return code ? humanize(code) : "AgentTab action failed";
}

function targetMeta(condition: Record<string, unknown>): string | undefined {
  const kind = fieldString(condition, "kind");
  const value = fieldString(condition, "value");
  if (!value) return undefined;
  if (kind === "selector") return selectorMeta(value);
  return kind === "text" || kind === "url" ? quote(value) : value;
}


function countSummary(values: unknown[], noun: string): string {
  return countLabel(values.length, noun);
}

function countLabel(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
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

function renderHeader(
  theme: RenderTheme,
  title: string,
  meta: string | undefined,
  width: number,
  color = "toolTitle",
): string {
  const safeWidth = Math.max(1, width || 1);
  if (!meta) return fg(theme, color, bold(theme, truncate(title, safeWidth)));
  const available = safeWidth - title.length - 3;
  if (available < 4) return fg(theme, color, bold(theme, truncate(title, safeWidth)));
  return `${fg(theme, color, bold(theme, title))}${fg(theme, "muted", ` · ${truncate(meta, available)}`)}`;
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

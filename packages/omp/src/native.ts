import {
  contextMeta,
  createCallCard,
  createResultCard,
  expandedLines,
  type OperationCard,
  type OperationCardStatus,
  type OperationCardStep,
  type RenderOptions,
  type ToolResult,
} from "./render";
import type { ToolMethod } from "./tool-method";

/**
 * Semantic tool views for terminals that speak the Tern Surface Protocol.
 *
 * omp calls `describeCall`/`describeResult` instead of `renderCall`/`renderResult`
 * there and draws the frame, status motion, timer, collapse, and screenshot
 * images itself; these views supply only the head data and body nodes. The
 * shapes mirror omp's `NativeToolView` and TSP wire nodes structurally, so the
 * adapter needs no omp import.
 */

type Tone = "neutral" | "accent" | "info" | "success" | "warning" | "error" | "pending" | "muted";

interface Span {
  readonly t: string;
  readonly s?: string;
}

type Text = string | readonly Span[];

export interface NativeNode {
  readonly k: string;
  readonly p?: Readonly<Record<string, unknown>>;
  readonly c?: readonly NativeNode[];
  readonly key?: string;
}

export interface NativeToolView {
  readonly tool?: {
    readonly title?: Text;
    readonly target?: Text;
    readonly targetKind?: "command" | "path" | "pattern" | "query" | "text";
    readonly meta?: readonly Text[];
    readonly badges?: readonly { text: string; tone?: Tone; title?: string }[];
    readonly note?: Text;
  };
  readonly body?: readonly NativeNode[];
  readonly tone?: Tone;
  readonly inline?: boolean;
}

const ATTENTION_BADGE: Partial<Record<OperationCardStatus, { text: string; tone: Tone; title: string }>> = {
  awaiting_user: { text: "needs you", tone: "warning", title: "Waiting on human-only input in the task tab" },
  awaiting_approval: { text: "review", tone: "warning", title: "Paused for AgentTab popup review before execution" },
  uncertain: { text: "uncertain", tone: "warning", title: "Execution may have occurred; inspect live state before retrying" },
};

const STATUS_TONE: Partial<Record<OperationCardStatus, Tone>> = {
  awaiting_user: "warning",
  awaiting_approval: "warning",
  uncertain: "warning",
  blocked: "error",
};

const STEP_STYLE: Readonly<Record<OperationCardStep["state"], { mark: string; style: string }>> = {
  done: { mark: "✓", style: "success" },
  active: { mark: "▶", style: "accent strong" },
  pending: { mark: "·", style: "muted" },
  blocked: { mark: "×", style: "error" },
  uncertain: { mark: "?", style: "warning" },
};

const callViews = new WeakMap<object, Map<string, NativeToolView>>();
const resultViews = new WeakMap<object, Map<string, NativeToolView>>();

export function describeCallView(method: ToolMethod, args: unknown): NativeToolView {
  return memo(callViews, args, method, () => {
    const card = createCallCard(method, args);
    const body = [...actionList(card), ...noticeNodes(card.notices)];
    return {
      tool: head(card, card),
      ...(body.length === 0 ? { inline: true } : { body }),
    };
  });
}

export function describeResultView(
  method: ToolMethod,
  result: ToolResult,
  options: RenderOptions,
  args: unknown,
): NativeToolView {
  const key = `${method}\0${options.isPartial === true ? "p" : ""}${options.expanded === true ? "x" : ""}`;
  return memo(resultViews, result, key, () => {
    const call = createCallCard(method, args);
    const card = createResultCard(method, result, options, args);
    const attention = ATTENTION_BADGE[card.status] !== undefined || card.status === "blocked";
    const body: NativeNode[] = [];
    if (attention) body.push(flowNode(card.steps));
    body.push(...actionList(card), ...noticeNodes(card.notices));
    if (card.evidence.length > 0) body.push(evidenceNode(card.evidence));
    const details = detailsNode(card, options.expanded === true);
    if (details !== undefined) body.push(details);
    const tone = STATUS_TONE[card.status];
    return {
      tool: head(call, card),
      ...(body.length === 0 ? { inline: true } : { body }),
      ...(tone === undefined ? {} : { tone }),
    };
  });
}

/** Head: the call's verb and target once, the outcome and tab context as facts, attention as a badge. */
function head(call: OperationCard, card: OperationCard): NonNullable<NativeToolView["tool"]> {
  const outcome = card === call || card.status === "running" || card.title === call.title ? undefined : card.title;
  // Task id and ownership hold for every card of a task; repeating them per call is noise.
  const meta = [
    ...(outcome === undefined ? [] : [outcome]),
    ...contextMeta({ ...card.context, taskId: undefined, owned: false }),
  ];
  const badge = ATTENTION_BADGE[card.status];
  const target = call.meta.join(" · ");
  return {
    title: call.title,
    ...(target ? { target, targetKind: "text" as const } : {}),
    ...(meta.length === 0 ? {} : { meta }),
    ...(badge === undefined ? {} : { badges: [badge] }),
  };
}

function flowNode(steps: readonly OperationCardStep[]): NativeNode {
  const spans: Span[] = [{ t: "Flow  ", s: "muted" }];
  steps.forEach((step, index) => {
    if (index > 0) spans.push({ t: "  ", s: "muted" });
    const style = STEP_STYLE[step.state];
    spans.push({ t: `${style.mark} ${step.label}`, s: style.style });
  });
  return { k: "text", p: { spans, wrap: "word" }, key: "flow" };
}

/** Numbered steps of a multi-action batch; a single action already is the head. */
function actionList(card: OperationCard): NativeNode[] {
  if (card.actions.length < 2) return [];
  return [{
    k: "kv",
    p: { items: card.actions.map((action, index) => ({ k: `${index + 1}.`, v: action })), layout: "grid" },
    key: "actions",
  }];
}

function noticeNodes(notices: readonly string[]): NativeNode[] {
  return notices.map((notice, index) => {
    const [label, ...rest] = notice.split(" · ");
    const style = label === "Blocked" ? "error" : "warning";
    const spans: Span[] = rest.length === 0
      ? [{ t: notice, s: style }]
      : [{ t: `${label}  `, s: `${style} strong` }, { t: rest.join(" · "), s: style }];
    return { k: "text", p: { spans, wrap: "word" }, key: `notice${index}` };
  });
}

function evidenceNode(evidence: readonly string[]): NativeNode {
  return {
    k: "kv",
    p: {
      items: evidence.map((entry) => {
        const [label, ...rest] = entry.split(" · ");
        return { k: label, v: [{ t: rest.join(" · "), s: "success" }] };
      }),
      layout: "grid",
    },
    key: "evidence",
  };
}

/** The redacted structured result, folded unless the transcript is expanded. */
function detailsNode(card: OperationCard, expanded: boolean): NativeNode | undefined {
  if (card.details === undefined) return undefined;
  const { _agenttab: _presentation, ...rest } = toRecord(card.details);
  const payload = Object.keys(rest).length === 0 ? undefined : rest;
  if (payload === undefined) return undefined;
  return {
    k: "section",
    p: { head: [{ t: "Result", s: "muted" }, { t: "  redacted", s: "dim" }], collapsible: true, collapsed: !expanded },
    c: [{ k: "code", p: { text: expandedLines(payload).join("\n"), lang: "json" } }],
    key: "details",
  };
}

function memo(
  cache: WeakMap<object, Map<string, NativeToolView>>,
  owner: unknown,
  key: string,
  build: () => NativeToolView,
): NativeToolView {
  if (owner === null || typeof owner !== "object") return build();
  let entries = cache.get(owner);
  if (entries === undefined) {
    entries = new Map();
    cache.set(owner, entries);
  }
  let view = entries.get(key);
  if (view === undefined) {
    view = build();
    entries.set(key, view);
  }
  return view;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

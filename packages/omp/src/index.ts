import { randomUUID } from "node:crypto";
import {
  AgentTabClient,
  AgentTabError,
  AgentTabTransportError,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MAX_DIMENSION,
  SNAPSHOT_TEXT_MAX_BYTES,
  STANDARD_ACTION_VALUE_MAX_CHARS,
  createUuidV7,
  createResumeCapabilityStore,
  type MethodParams,
  type MutationMethod,
} from "../../sdk-typescript/src/index";
import { piSchema } from "./pi-schema";
import {
  createCallComponent,
  createResultComponent,
  type RenderOptions,
  type RenderTheme,
  type ToolResult,
} from "./render";
import type { ToolMethod } from "./tool-method";


interface SchemaNode {
  int(): SchemaNode;
  max(value: number): SchemaNode;
  min(value: number): SchemaNode;
  optional(): SchemaNode;
  regex(pattern: RegExp): SchemaNode;
  strict(): SchemaNode;
}

interface ZodApi {
  array(schema: SchemaNode): SchemaNode;
  boolean(): SchemaNode;
  union(schemas: SchemaNode[]): SchemaNode;
  enum(values: readonly string[]): SchemaNode;
  literal(value: string | boolean): SchemaNode;
  number(): SchemaNode;
  object(properties: Record<string, SchemaNode>): SchemaNode;
  record(key: SchemaNode, value: SchemaNode): SchemaNode;
  string(): SchemaNode;
  unknown(): SchemaNode;
}

export interface AgentApi {
  zod?: ZodApi;
  setLabel?(label: string): void;
  registerTool(tool: Record<string, unknown>): void;
}

interface ToolExecutionContext {
  sessionManager?: {
    getSessionId?(): string;
  };
}

type ClientFactory = (context?: ToolExecutionContext) => Promise<AgentTabClient>;

const MUTATIONS = new Set<ToolMethod>([
  "browser_open",
  "browser_act",
  "browser_handoff",
  "browser_commit",
  "browser_developer",
]);
const INLINE_RESULT_MAX_BYTES = 8 * 1024;
const IDEMPOTENCY_KEY_CACHE_MAX_ENTRIES = 4_096;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class InvocationIdempotencyKeys {
  readonly #keys = new Map<string, string>();

  for(invocationId: string): string {
    if (UUID_V7.test(invocationId)) return invocationId.toLowerCase();
    const current = this.#keys.get(invocationId);
    if (current !== undefined) return current;
    const created = createUuidV7();
    if (this.#keys.size >= IDEMPOTENCY_KEY_CACHE_MAX_ENTRIES) {
      const oldest = this.#keys.keys().next().value;
      if (oldest !== undefined) this.#keys.delete(oldest);
    }
    this.#keys.set(invocationId, created);
    return created;
  }
}

function isMutation(method: ToolMethod): method is MutationMethod {
  return MUTATIONS.has(method);
}

function contextConversationId(context: ToolExecutionContext | undefined): string | undefined {
  try {
    const sessionId = context?.sessionManager?.getSessionId?.();
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

function compactLargeValue(value: unknown, resultBytes: number): Record<string, unknown> {
  if (typeof value === "string") {
    return { value_characters: value.length, value_bytes: resultBytes, result_bytes: resultBytes };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { value, result_bytes: resultBytes };
  }
  const compact: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    const encoded = JSON.stringify(field) ?? "null";
    const fieldBytes = Buffer.byteLength(encoded, "utf8");
    if (fieldBytes <= 2 * 1024) {
      compact[key] = field;
    } else if (typeof field === "string") {
      compact[`${key}_characters`] = field.length;
      compact[`${key}_bytes`] = fieldBytes;
    } else if (Array.isArray(field)) {
      compact[`${key}_count`] = field.length;
      compact[`${key}_bytes`] = fieldBytes;
    } else {
      compact[`${key}_bytes`] = fieldBytes;
    }
  }
  compact.result_bytes = resultBytes;
  return compact;
}

const DEFINITIONS: ReadonlyArray<{
  name: ToolMethod;
  label: string;
  description: string;
  approval: "read" | "write";
  schema(z: ZodApi): SchemaNode;
}> = [
    {
      name: "browser_open",
      label: "Browser Open",
      description: "Create a task tab, create an unfocused task-owned window, or explicitly adopt the active tab.",
      approval: "write",
      schema: (z) => z.union([
        z.object({
          mode: z.literal("create"),
          url: z.string().regex(/^(https?:\/\/|about:)[^\s]+$/).optional(),
          placement: z.literal("task").optional(),
          background: z.boolean().optional(),
        }).strict(),
        z.object({
          mode: z.literal("create"),
          url: z.string().regex(/^(https?:\/\/|about:)[^\s]+$/).optional(),
          placement: z.literal("new_window"),
          background: z.literal(true).optional(),
        }).strict(),
        z.object({ mode: z.literal("adopt_active") }).strict(),
      ]),
    },
    {
      name: "browser_snapshot",
      label: "Browser Snapshot",
      description: "Read an accessibility snapshot with stable semantic refs, bounded text or HTML, or a screenshot from a task-owned tab.",
      approval: "read",
      schema: (z) => z.union([
        z.object({
          tab_id: z.number().int().min(0),
          mode: z.literal("accessibility"),
          root_ref: z.string().min(1).optional(),
          max_depth: z.number().int().min(1).max(200).optional(),
          max_nodes: z.number().int().min(1).max(5000).optional(),
        }).strict(),
        z.object({
          tab_id: z.number().int().min(0),
          mode: z.enum(["text", "html"]),
          selector: z.string().min(1).optional(),
          max_bytes: z.number().int().min(1).max(SNAPSHOT_TEXT_MAX_BYTES).optional(),
        }).strict(),
        z.object({
          tab_id: z.number().int().min(0),
          mode: z.literal("screenshot"),
          selector: z.string().min(1).optional(),
          full_page: z.boolean().optional(),
          format: z.enum(["png", "jpeg", "webp"]).optional(),
          quality: z.number().int().min(0).max(100).optional(),
          max_width: z.number().int().min(1).max(SCREENSHOT_MAX_DIMENSION).optional(),
          max_height: z.number().int().min(1).max(SCREENSHOT_MAX_DIMENSION).optional(),
          max_bytes: z.number().int().min(1).max(SCREENSHOT_MAX_BYTES).optional(),
        }).strict(),
      ]),
    },
    {
      name: "browser_act",
      label: "Browser Act",
      description: "Run typed actions against one task-owned tab and page revision; prefer a snapshot semantic_ref when available.",
      approval: "write",
      schema: (z) => {
        const ref = z.string().min(1).max(256);
        const action = z.union([
          z.object({ kind: z.literal("click"), ref }).strict(),
          z.object({ kind: z.literal("type"), ref, text: z.string().max(STANDARD_ACTION_VALUE_MAX_CHARS) }).strict(),
          z.object({ kind: z.literal("fill"), ref, text: z.string().max(STANDARD_ACTION_VALUE_MAX_CHARS) }).strict(),
          z.object({ kind: z.literal("select"), ref, value: z.string().max(STANDARD_ACTION_VALUE_MAX_CHARS) }).strict(),
          z.object({
            kind: z.literal("scroll"),
            ref: ref.optional(),
            delta_x: z.number().int().min(-100_000).max(100_000),
            delta_y: z.number().int().min(-100_000).max(100_000),
          }).strict(),
          z.object({ kind: z.literal("drag"), ref, target_ref: ref }).strict(),
          z.object({ kind: z.literal("navigate"), url: z.string().max(2048).regex(/^(https?:\/\/|about:)[^\s]+$/) }).strict(),
          z.object({ kind: z.literal("go_back") }).strict(),
          z.object({ kind: z.literal("go_forward") }).strict(),
          z.object({ kind: z.literal("reload"), bypass_cache: z.boolean().optional() }).strict(),
          z.object({ kind: z.literal("close") }).strict(),
          z.object({
            kind: z.literal("dialog"),
            decision: z.enum(["accept", "dismiss"]),
          }).strict(),
          z.object({
            kind: z.literal("upload_file"),
            ref,
            files: z.array(z.string().min(1).max(512)).min(1).max(4),
          }).strict(),
        ]);
        return z.object({
          tab_id: z.number().int().min(0),
          expected_page_revision: z.number().int().min(0),
          actions: z.array(action).min(1).max(64),
        }).strict();
      },
    },
    {
      name: "browser_wait",
      label: "Browser Wait",
      description: "Wait event-first for one load, URL, text, selector, network-idle, or download condition instead of sleeping.",
      approval: "read",
      schema: (z) => z.object({
        tab_id: z.number().int().min(0),
        condition: z.union([
          z.object({ kind: z.enum(["load", "network_idle", "download"]) }).strict(),
          z.object({ kind: z.enum(["url", "text", "selector"]), value: z.string().min(1).max(65_536) }).strict(),
        ]),
        timeout_ms: z.number().int().min(1).max(120_000).optional(),
      }).strict(),
    },
    {
      name: "browser_tabs",
      label: "Browser Tabs",
      description: "List only tabs owned by this task connection.",
      approval: "read",
      schema: (z) => z.object({}).strict(),
    },
    {
      name: "browser_handoff",
      label: "Browser Handoff",
      description: "Give the user control for credentials, MFA, CAPTCHA, or other human-only input.",
      approval: "write",
      schema: (z) => z.object({
        tab_id: z.number().int().min(0),
        expected_page_revision: z.number().int().min(0),
        prompt: z.string().min(1).max(2000),
        completion: z.union([
          z.object({ kind: z.enum(["navigation", "manual_done"]) }).strict(),
          z.object({ kind: z.enum(["url", "selector"]), value: z.string().min(1).max(65_536) }).strict(),
        ]),
        timeout_ms: z.number().int().min(1000).max(900_000).optional(),
      }).strict(),
    },
    {
      name: "browser_commit",
      label: "Browser Commit",
      description: "Execute one previously staged consequential action after semantic review.",
      approval: "write",
      schema: (z) => z.object({ staged_token: z.string().min(32).max(256) }).strict(),
    },
  ];

const DEVELOPER = {
  name: "browser_developer" as const,
  label: "Browser Developer",
  description: "Run an explicitly enabled developer-mode action outside the Standard tool surface.",
  approval: "write" as const,
  schema: (z: ZodApi) => z.object({
    action: z.string().min(1).max(128),
    params: z.record(z.string(), z.unknown()),
  }).strict(),
};

function success(
  value: unknown,
  presentation: { outcome: string; taskId?: string },
): Record<string, unknown> {
  const record = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const screenshot = record?.mode === "screenshot" &&
    record.encoding === "base64" &&
    typeof record.data === "string" &&
    typeof record.media_type === "string" &&
    /^image\/(png|jpeg|webp)$/.test(record.media_type);
  const text = screenshot
    ? undefined
    : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const resultBytes = text === undefined ? 0 : Buffer.byteLength(text, "utf8");
  const presentedValue = screenshot
    ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== "data" && key !== "encoding"))
    : resultBytes > INLINE_RESULT_MAX_BYTES ? compactLargeValue(value, resultBytes) : value;
  const details = presentedValue !== null && typeof presentedValue === "object" && !Array.isArray(presentedValue)
    ? {
      ...(presentedValue as Record<string, unknown>),
      _agenttab: {
        outcome: presentation.outcome,
        ...(presentation.taskId ? { task_id: presentation.taskId } : {}),
      },
    }
    : {
      value: presentedValue,
      _agenttab: {
        outcome: presentation.outcome,
        ...(presentation.taskId ? { task_id: presentation.taskId } : {}),
      },
    };
  return {
    content: screenshot
      ? [{ type: "image", data: record.data, mimeType: record.media_type }]
      : [{ type: "text", text }],
    details,
    ...(!screenshot && resultBytes <= INLINE_RESULT_MAX_BYTES
      ? { structuredContent: details }
      : {}),
  };
}

function failure(error: unknown, taskId?: string): Record<string, unknown> {
  if (error instanceof AgentTabError) {
    return {
      content: [{ type: "text", text: error.message }],
      details: {
        code: error.code,
        outcome: error.outcome,
        ...(error.recovery ? { recovery: error.recovery } : {}),
        ...(error.details ? { details: error.details } : {}),
        ...(taskId ? { _agenttab: { outcome: error.outcome, task_id: taskId } } : {}),
      },
      isError: true,
    };
  }
  if (error instanceof AgentTabTransportError) {
    return {
      content: [{ type: "text", text: error.message }],
      details: {
        code: error.code,
        outcome: error.outcome,
        method: error.method,
        ...(error.idempotencyKey ? { idempotency_key: error.idempotencyKey } : {}),
        ...(taskId ? { _agenttab: { outcome: error.outcome, task_id: taskId } } : {}),
      },
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export function makeExtension(clientFactory?: ClientFactory) {
  return function agentTabExtension(pi: AgentApi): void {
    const zod = pi.zod;
    const isOmp = zod !== undefined;
    if (isOmp) pi.setLabel?.("AgentTab");
    let defaultConnection: {
      conversationId?: string;
      capabilityStore: ReturnType<typeof createResumeCapabilityStore>;
    } | undefined;
    const connectClient = clientFactory ?? ((context?: ToolExecutionContext) => {
      if (defaultConnection === undefined) {
        const conversationId = process.env.AGENTTAB_CONVERSATION_ID ?? contextConversationId(context);
        defaultConnection = {
          ...(conversationId ? { conversationId } : {}),
          capabilityStore: createResumeCapabilityStore(isOmp ? "omp" : "pi", {
            scope: conversationId ?? `session-${randomUUID()}`,
          }),
        };
      }
      return AgentTabClient.connect({
        conversationId: defaultConnection.conversationId,
        capabilityStore: defaultConnection.capabilityStore,
      });
    });
    let client: AgentTabClient | undefined;
    let connecting: Promise<AgentTabClient> | undefined;
    let taskId: string | undefined;
    const invocationKeys = new InvocationIdempotencyKeys();
    const getClient = async (context?: ToolExecutionContext): Promise<AgentTabClient> => {
      if (client !== undefined && !client.closed) return client;
      const pending = connecting ??= connectClient(context);
      try {
        client = await pending;
        taskId = client.connection.task_id ?? taskId;
        return client;
      } finally {
        if (connecting === pending) connecting = undefined;
      }
    };
    const register = (definition: (typeof DEFINITIONS)[number] | typeof DEVELOPER) => {
      const renderers = isOmp
        ? {
          renderCall: (args: unknown, _options: RenderOptions, theme: RenderTheme) =>
            createCallComponent(definition.name, args, theme),
          renderResult: (result: ToolResult, options: RenderOptions, theme: RenderTheme, args: unknown) =>
            createResultComponent(definition.name, result, options, theme, args),
        }
        : {
          renderCall: (args: unknown, theme: RenderTheme) =>
            createCallComponent(definition.name, args, theme),
          renderResult: (
            result: ToolResult,
            options: RenderOptions,
            theme: RenderTheme,
            context: { args?: unknown },
          ) => createResultComponent(definition.name, result, options, theme, context.args),
        };
      pi.registerTool({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        ...(isOmp ? {
          loadMode: "discoverable",
          approval: definition.approval,
          strict: true,
        } : {}),
        parameters: isOmp ? definition.schema(zod) : piSchema(definition.name),
        ...renderers,
        execute: async (
          invocationId: string,
          params: Record<string, unknown>,
          _signal?: AbortSignal,
          _onUpdate?: unknown,
          context?: ToolExecutionContext,
        ) => {
          let invocationClient: AgentTabClient | undefined;
          try {
            invocationClient = await getClient(context);
            const response = await invocationClient.request(
              definition.name,
              params as MethodParams[ToolMethod],
              isMutation(definition.name)
                ? { idempotencyKey: invocationKeys.for(invocationId) }
                : {},
            );
            taskId = response.task?.task_id ?? taskId;
            if (!response.ok) throw new AgentTabError(response);
            return success(response.result, { outcome: response.outcome, taskId });
          } catch (error) {
            if (invocationClient?.closed && client === invocationClient) client = undefined;
            return failure(error, taskId);
          }
        },
      });
    };
    for (const definition of DEFINITIONS) register(definition);
    if (process.env.AGENTTAB_DEVELOPER === "1") register(DEVELOPER);
  };
}

export default makeExtension();

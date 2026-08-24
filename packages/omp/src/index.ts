import {
  AgentTabClient,
  AgentTabError,
  type MethodParams,
  type RpcMethod,
} from "../../sdk-typescript/src/index";

interface OmpApi {
  zod: any;
  setLabel?(label: string): void;
  registerTool(tool: Record<string, unknown>): void;
}

type ClientFactory = () => Promise<AgentTabClient>;

const DEFINITIONS: ReadonlyArray<{
  name: RpcMethod;
  label: string;
  description: string;
  approval: "read" | "write";
  schema(z: any): any;
}> = [
    {
      name: "browser_open",
      label: "Browser Open",
      description: "Create a background tab in this task workspace or explicitly adopt the active tab.",
      approval: "write",
      schema: (z) => z.discriminatedUnion("mode", [
        z.object({
          mode: z.literal("create"),
          url: z.string().regex(/^(https?:\/\/|about:)[^\s]+$/).optional(),
          background: z.boolean().optional(),
        }).strict(),
        z.object({ mode: z.literal("adopt_active") }).strict(),
      ]),
    },
    {
      name: "browser_snapshot",
      label: "Browser Snapshot",
      description: "Read an accessibility snapshot, bounded text or HTML, or a screenshot from a task-owned tab.",
      approval: "read",
      schema: (z) => z.discriminatedUnion("mode", [
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
          max_bytes: z.number().int().min(1).max(1_048_576).optional(),
        }).strict(),
        z.object({
          tab_id: z.number().int().min(0),
          mode: z.literal("screenshot"),
          selector: z.string().min(1).optional(),
          full_page: z.boolean().optional(),
        }).strict(),
      ]),
    },
    {
      name: "browser_act",
      label: "Browser Act",
      description: "Run an ordered batch of typed actions against one task-owned tab and page revision.",
      approval: "write",
      schema: (z) => {
        const ref = z.string().min(1).max(256);
        const action = z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("click"), ref }).strict(),
          z.object({ kind: z.literal("type"), ref, text: z.string().max(1_048_576) }).strict(),
          z.object({ kind: z.literal("fill"), ref, text: z.string().max(1_048_576) }).strict(),
          z.object({ kind: z.literal("select"), ref, value: z.string().max(65_536) }).strict(),
          z.object({
            kind: z.literal("scroll"),
            ref: ref.optional(),
            delta_x: z.number().int().min(-100_000).max(100_000),
            delta_y: z.number().int().min(-100_000).max(100_000),
          }).strict(),
          z.object({ kind: z.literal("drag"), ref, target_ref: ref }).strict(),
          z.object({ kind: z.literal("navigate"), url: z.string().regex(/^(https?:\/\/|about:)[^\s]+$/) }).strict(),
          z.object({ kind: z.literal("go_back") }).strict(),
          z.object({ kind: z.literal("go_forward") }).strict(),
          z.object({ kind: z.literal("reload"), bypass_cache: z.boolean().optional() }).strict(),
          z.object({ kind: z.literal("focus") }).strict(),
          z.object({ kind: z.literal("close") }).strict(),
          z.object({
            kind: z.literal("dialog"),
            decision: z.enum(["accept", "dismiss"]),
            prompt_text: z.string().max(65_536).optional(),
          }).strict(),
          z.object({
            kind: z.literal("upload_file"),
            ref,
            files: z.array(z.string().min(1)).min(1).max(32),
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
      description: "Wait for one schema-defined load, URL, text, selector, network-idle, or download condition.",
      approval: "read",
      schema: (z) => z.object({
        tab_id: z.number().int().min(0),
        condition: z.discriminatedUnion("kind", [
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
        completion: z.discriminatedUnion("kind", [
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
  schema: (z: any) => z.object({
    action: z.string().min(1).max(128),
    params: z.record(z.string(), z.unknown()),
  }).strict(),
};

function success(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    details: value,
    structuredContent: value,
  };
}

function failure(error: unknown): Record<string, unknown> {
  if (error instanceof AgentTabError) {
    return {
      content: [{ type: "text", text: error.message }],
      details: {
        code: error.code,
        outcome: error.outcome,
        ...(error.recovery ? { recovery: error.recovery } : {}),
        ...(error.details ? { details: error.details } : {}),
      },
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export function makeExtension(clientFactory: ClientFactory = () => AgentTabClient.connect({
  conversationId: process.env.AGENTTAB_CONVERSATION_ID,
})) {
  return function agentTabExtension(pi: OmpApi): void {
    if (!pi.zod) throw new Error("AgentTab's OMP adapter requires the OMP Zod extension API.");
    pi.setLabel?.("AgentTab");
    let client: AgentTabClient | undefined;
    const register = (definition: (typeof DEFINITIONS)[number] | typeof DEVELOPER) => {
      pi.registerTool({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        loadMode: "discoverable",
        approval: definition.approval,
        strict: true,
        parameters: definition.schema(pi.zod),
        execute: async (_id: string, params: Record<string, unknown>) => {
          try {
            client ??= await clientFactory();
            const result = await client.call(
              definition.name,
              params as MethodParams[RpcMethod],
            );
            return success(result);
          } catch (error) {
            return failure(error);
          }
        },
      });
    };
    for (const definition of DEFINITIONS) register(definition);
    if (process.env.AGENTTAB_DEVELOPER === "1") register(DEVELOPER);
  };
}

export default makeExtension();

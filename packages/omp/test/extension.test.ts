import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTabTransportError,
  FrameDecoder,
  encodeFrame,
  type AgentTabClient,
} from "../../sdk-typescript/src/index";
import { makeExtension, type AgentApi } from "../src/index";

const originalDeveloper = process.env.AGENTTAB_DEVELOPER;
afterEach(() => {
  if (originalDeveloper === undefined) delete process.env.AGENTTAB_DEVELOPER;
  else process.env.AGENTTAB_DEVELOPER = originalDeveloper;
});

const literalValues: unknown[] = [];
const enumValues: unknown[] = [];

function stubSchema(kind: string): Record<string, unknown> {
  let schema: Record<string, unknown>;
  schema = new Proxy({ kind }, {
    get: (target, property) => property in target
      ? Reflect.get(target, property)
      : (..._args: unknown[]) => schema,
  });
  return schema;
}

const zod: Record<string, unknown> = new Proxy({}, {
  get: (_target, property) => (...args: unknown[]) => {
    if (property === "literal") literalValues.push(args[0]);
    if (property === "enum" && Array.isArray(args[0])) enumValues.push(...args[0]);
    return stubSchema(String(property));
  },
});

function register(developer: boolean, runtime: "omp" | "pi" = "omp") {
  literalValues.length = 0;
  enumValues.length = 0;
  if (developer) process.env.AGENTTAB_DEVELOPER = "1";
  else delete process.env.AGENTTAB_DEVELOPER;
  const tools: Array<Record<string, unknown>> = [];
  const calls: unknown[] = [];
  const client = {
    connection: { task_id: "task-test-1234" },
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return {
        ok: true,
        outcome: "committed",
        request_id: "request-test",
        result: { tabs: [] },
      };
    },
  } as unknown as AgentTabClient;
  const api = {
    ...(runtime === "omp" ? { zod } : {}),
    registerTool: (tool: Record<string, unknown>) => tools.push(tool),
  };
  // The fluent Proxy implements the exact schema calls under test; the production runtime injects concrete Zod.
  const compatibleApi = api as unknown as AgentApi;
  makeExtension(async () => client)(compatibleApi);
  return { tools, calls, literalValues: [...literalValues], enumValues: [...enumValues] };
}

async function executeTool(
  tool: Record<string, unknown> | undefined,
  args: Record<string, unknown> = {},
  invocationId = "call-1",
  context?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const execute = tool?.execute;
  if (typeof execute !== "function") throw new Error("Registered tool has no execute function.");
  const value: unknown = await execute(invocationId, args, undefined, undefined, context);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Registered tool returned a non-object result.");
  }
  return value as Record<string, unknown>;
}

test("Standard OMP mode registers exactly seven Core RPC tools", () => {
  expect(register(false).tools.map((tool) => tool.name)).toEqual([
    "browser_open",
    "browser_snapshot",
    "browser_act",
    "browser_wait",
    "browser_tabs",
    "browser_handoff",
    "browser_commit",
  ]);
});

test("Standard OMP actions expose no direct focus transition", () => {
  const registered = register(false);
  expect(registered.literalValues).toContain("click");
  expect(registered.literalValues).not.toContain("focus");
});

test("Standard read and open tools expose provider-compatible object schemas", () => {
  const registered = register(false);
  const open = registered.tools.find((tool) => tool.name === "browser_open");
  const snapshot = registered.tools.find((tool) => tool.name === "browser_snapshot");
  expect(open?.parameters).toMatchObject({ kind: "object" });
  expect(snapshot?.parameters).toMatchObject({ kind: "object" });
  expect(registered.enumValues).toContain("new_window");
});

test("developer mode adds only browser_developer", () => {
  expect(register(true).tools.map((tool) => tool.name)).toEqual([
    "browser_open",
    "browser_snapshot",
    "browser_act",
    "browser_wait",
    "browser_tabs",
    "browser_handoff",
    "browser_commit",
    "browser_developer",
  ]);
});

test("registered tools call Core RPC without TCP or lease verbs", async () => {
  const { tools, calls } = register(false);
  const result = await executeTool(tools.find((tool) => tool.name === "browser_tabs"));
  expect(calls).toEqual([{ method: "browser_tabs", params: {} }]);
  expect(result.structuredContent).toEqual({
    tabs: [],
    _agenttab: { outcome: "committed", task_id: "task-test-1234" },
  });
  expect(result.details).toEqual({
    tabs: [],
    _agenttab: { outcome: "committed", task_id: "task-test-1234" },
  });
});

test("OMP forwards long-operation timeouts for SDK deadline selection", async () => {
  const { tools, calls } = register(false);
  await executeTool(tools.find((tool) => tool.name === "browser_wait"), {
    tab_id: 7,
    condition: { kind: "load" },
    timeout_ms: 120_000,
  });
  await executeTool(tools.find((tool) => tool.name === "browser_handoff"), {
    tab_id: 7,
    expected_page_revision: 3,
    prompt: "Complete MFA",
    completion: { kind: "manual_done" },
    timeout_ms: 900_000,
  });
  expect(calls).toEqual([
    {
      method: "browser_wait",
      params: {
        tab_id: 7,
        condition: { kind: "load" },
        timeout_ms: 120_000,
      },
    },
    {
      method: "browser_handoff",
      params: {
        tab_id: 7,
        expected_page_revision: 3,
        prompt: "Complete MFA",
        completion: { kind: "manual_done" },
        timeout_ms: 900_000,
      },
    },
  ]);
});

test("default OMP and Pi sessions confirm the initial capability before the next tool call", async () => {
  for (const runtime of ["omp", "pi"] as const) {
    const root = mkdtempSync(join(tmpdir(), `agenttab-${runtime}-`));
    const endpoint = join(root, "agenttab.sock");
    const previousSocket = process.env.AGENTTAB_SOCKET;
    const previousStateDir = process.env.AGENTTAB_STATE_DIR;
    const previousConversationId = process.env.AGENTTAB_CONVERSATION_ID;
    const sessionId = runtime === "omp"
      ? "018f22b2-4126-7c1a-8c31-3f45a783da45"
      : "018f22b2-4126-7c1a-8c31-3f45a783da46";
    const conversationIds: unknown[] = [];
    const methods: string[] = [];
    let confirmed = false;
    let activeSocket: Socket | undefined;
    const nativeServer = createServer((socket) => {
      activeSocket = socket;
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        for (const value of decoder.push(chunk) as Array<Record<string, unknown>>) {
          if (value.kind === "connect") {
            conversationIds.push(value.conversation_id);
            socket.write(encodeFrame({
              protocol: "agenttab.rpc",
              version: 1,
              kind: "connected",
              connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da43",
              resumed: false,
              state: "ready",
            }));
          } else if (value.kind === "resume_confirm") {
            confirmed = value.resume_capability === "a".repeat(32);
            socket.write(encodeFrame({
              protocol: "agenttab.rpc",
              version: 1,
              kind: "resume_confirmed",
              connection_id: value.connection_id,
            }));
          } else {
            methods.push(String(value.method));
            socket.write(encodeFrame({
              protocol: "agenttab.rpc",
              version: 1,
              request_id: value.request_id,
              ok: true,
              outcome: "completed",
              result: value.method === "browser_tabs" ? { tabs: [] } : { tab_id: 1 },
              ...(methods.length === 1
                ? {
                  task: {
                    task_id: "018f22b2-4126-7c1a-8c31-3f45a783da44",
                    resume_capability: "a".repeat(32),
                  },
                }
                : {}),
            }));
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      nativeServer.once("error", reject);
      nativeServer.listen(endpoint, resolve);
    });

    try {
      process.env.AGENTTAB_SOCKET = endpoint;
      process.env.AGENTTAB_STATE_DIR = join(root, "state");
      delete process.env.AGENTTAB_CONVERSATION_ID;
      const tools: Array<Record<string, unknown>> = [];
      const api = {
        ...(runtime === "omp" ? { zod } : {}),
        registerTool: (tool: Record<string, unknown>) => tools.push(tool),
      };
      makeExtension()(api as unknown as AgentApi);
      const first = await executeTool(
        tools.find((tool) => tool.name === "browser_open"),
        { mode: "create" },
        "call-open",
        { sessionManager: { getSessionId: () => sessionId } },
      );
      expect(first.details).toMatchObject({ tab_id: 1 });
      expect(confirmed).toBe(true);
      const second = await executeTool(tools.find((tool) => tool.name === "browser_tabs"));
      expect(second.details).toMatchObject({ tabs: [] });
      expect(methods).toEqual(["browser_open", "browser_tabs"]);
      expect(conversationIds).toEqual([sessionId]);
    } finally {
      activeSocket?.destroy();
      await new Promise<void>((resolve) => nativeServer.close(() => resolve()));
      if (previousSocket === undefined) delete process.env.AGENTTAB_SOCKET;
      else process.env.AGENTTAB_SOCKET = previousSocket;
      if (previousStateDir === undefined) delete process.env.AGENTTAB_STATE_DIR;
      else process.env.AGENTTAB_STATE_DIR = previousStateDir;
      if (previousConversationId === undefined) delete process.env.AGENTTAB_CONVERSATION_ID;
      else process.env.AGENTTAB_CONVERSATION_ID = previousConversationId;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("default OMP reconnect resumes the same task with the original capability store", async () => {
  const root = mkdtempSync(join(tmpdir(), "agenttab-omp-reconnect-"));
  const endpoint = join(root, "agenttab.sock");
  const previousSocket = process.env.AGENTTAB_SOCKET;
  const previousStateDir = process.env.AGENTTAB_STATE_DIR;
  const previousConversationId = process.env.AGENTTAB_CONVERSATION_ID;
  const sessionId = "018f22b2-4126-7c1a-8c31-3f45a783da47";
  const taskId = "018f22b2-4126-7c1a-8c31-3f45a783da48";
  const capabilities: unknown[] = [];
  const confirmations: unknown[] = [];
  const sockets: Socket[] = [];
  let connectionCount = 0;
  const nativeServer = createServer((socket) => {
    sockets.push(socket);
    const connectionNumber = ++connectionCount;
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (value.kind === "connect") {
          capabilities.push(value.resume_capability);
          socket.write(encodeFrame(connectionNumber === 1
            ? {
              protocol: "agenttab.rpc",
              version: 1,
              kind: "connected",
              connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da49",
              resumed: false,
              state: "ready",
            }
            : {
              protocol: "agenttab.rpc",
              version: 1,
              kind: "connected",
              connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da4a",
              resumed: true,
              task_id: taskId,
              resume_capability: "b".repeat(32),
              state: "ready",
            }));
        } else if (value.kind === "resume_confirm") {
          confirmations.push(value.resume_capability);
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            kind: "resume_confirmed",
            connection_id: value.connection_id,
          }));
        } else {
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            request_id: value.request_id,
            ok: true,
            outcome: "completed",
            result: connectionNumber === 1 ? { tab_id: 1 } : { tabs: [{ tab_id: 1 }] },
            ...(connectionNumber === 1
              ? { task: { task_id: taskId, resume_capability: "a".repeat(32) } }
              : {}),
          }));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    nativeServer.once("error", reject);
    nativeServer.listen(endpoint, resolve);
  });

  try {
    process.env.AGENTTAB_SOCKET = endpoint;
    process.env.AGENTTAB_STATE_DIR = join(root, "state");
    delete process.env.AGENTTAB_CONVERSATION_ID;
    const tools: Array<Record<string, unknown>> = [];
    makeExtension()({
      zod,
      registerTool: (tool: Record<string, unknown>) => tools.push(tool),
    } as unknown as AgentApi);
    const context = { sessionManager: { getSessionId: () => sessionId } };
    const opened = await executeTool(
      tools.find((tool) => tool.name === "browser_open"),
      { mode: "create" },
      "call-open",
      context,
    );
    expect(opened.details).toMatchObject({ tab_id: 1 });

    const firstSocket = sockets[0];
    if (!firstSocket) throw new Error("Expected the initial OMP socket");
    const closed = new Promise<void>((resolve) => firstSocket.once("close", resolve));
    firstSocket.destroy();
    await closed;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const tabs = await executeTool(
      tools.find((tool) => tool.name === "browser_tabs"),
      {},
      "call-tabs",
      context,
    );
    expect(tabs.details).toMatchObject({
      tabs: [{ tab_id: 1 }],
      _agenttab: { task_id: taskId },
    });
    expect(capabilities).toEqual([undefined, "a".repeat(32)]);
    expect(confirmations).toEqual(["a".repeat(32), "b".repeat(32)]);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => nativeServer.close(() => resolve()));
    if (previousSocket === undefined) delete process.env.AGENTTAB_SOCKET;
    else process.env.AGENTTAB_SOCKET = previousSocket;
    if (previousStateDir === undefined) delete process.env.AGENTTAB_STATE_DIR;
    else process.env.AGENTTAB_STATE_DIR = previousStateDir;
    if (previousConversationId === undefined) delete process.env.AGENTTAB_CONVERSATION_ID;
    else process.env.AGENTTAB_CONVERSATION_ID = previousConversationId;
    rmSync(root, { recursive: true, force: true });
  }
});

test("OMP reconnects after a closed client fails without replaying and reports the new task id", async () => {
  const tools: Array<Record<string, unknown>> = [];
  const calls: Array<{ client: string; method: string }> = [];
  const firstClient = {
    connection: { task_id: "task-old" },
    get closed() {
      return true;
    },
    request: async (method: string) => {
      calls.push({ client: "first", method });
      throw new Error("transport closed");
    },
  } as unknown as AgentTabClient;
  const secondClient = {
    connection: { task_id: "task-new" },
    get closed() {
      return false;
    },
    request: async (method: string) => {
      calls.push({ client: "second", method });
      return {
        ok: true,
        outcome: "committed",
        request_id: "request-new",
        result: { tabs: ["tab-new"] },
      };
    },
  } as unknown as AgentTabClient;
  let connections = 0;
  const api = {
    zod,
    registerTool: (tool: Record<string, unknown>) => tools.push(tool),
  };
  makeExtension(async () => {
    connections += 1;
    return connections === 1 ? firstClient : secondClient;
  })(api as unknown as AgentApi);
  const tool = tools.find((candidate) => candidate.name === "browser_tabs");
  const first = await executeTool(tool);
  expect(first).toMatchObject({
    content: [{ type: "text", text: "transport closed" }],
    isError: true,
  });
  expect(calls).toEqual([{ client: "first", method: "browser_tabs" }]);
  const second = await executeTool(tool);
  expect(second.details).toEqual({
    tabs: ["tab-new"],
    _agenttab: { outcome: "committed", task_id: "task-new" },
  });
  expect(connections).toBe(2);
  expect(calls).toEqual([
    { client: "first", method: "browser_tabs" },
    { client: "second", method: "browser_tabs" },
  ]);
});

test("OMP reports mutation transport failures as unknown with the reconciliation key", async () => {
  const tools: Array<Record<string, unknown>> = [];
  const client = {
    connection: { task_id: "task-timeout" },
    get closed() {
      return false;
    },
    request: async () => {
      throw new AgentTabTransportError("browser_open", {
        code: "request_timeout",
        idempotencyKey: "00000000-0000-7000-8000-000000000001",
        cause: new Error("request timed out"),
      });
    },
  } as unknown as AgentTabClient;
  const api = {
    zod,
    registerTool: (tool: Record<string, unknown>) => tools.push(tool),
  };
  makeExtension(async () => client)(api as unknown as AgentApi);
  const result = await executeTool(tools.find((candidate) => candidate.name === "browser_open"));
  expect(result).toMatchObject({
    content: [{ type: "text", text: "request timed out" }],
    details: {
      code: "request_timeout",
      outcome: "unknown",
      method: "browser_open",
      idempotency_key: "00000000-0000-7000-8000-000000000001",
    },
    isError: true,
  });
});

test("OMP retains a live client after an RPC error", async () => {
  const tools: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const client = {
    connection: { task_id: "task-live" },
    get closed() {
      return false;
    },
    request: async (method: string) => {
      calls.push(method);
      if (calls.length === 1) {
        return {
          ok: false,
          outcome: "denied",
          request_id: "request-denied",
          error: { code: "operation_denied", message: "application rejected" },
        };
      }
      return {
        ok: true,
        outcome: "committed",
        request_id: "request-live",
        result: { tabs: ["tab-live"] },
      };
    },
  } as unknown as AgentTabClient;
  let connections = 0;
  const api = {
    zod,
    registerTool: (tool: Record<string, unknown>) => tools.push(tool),
  };
  makeExtension(async () => {
    connections += 1;
    return client;
  })(api as unknown as AgentApi);
  const tool = tools.find((candidate) => candidate.name === "browser_tabs");
  const first = await executeTool(tool);
  expect(first).toMatchObject({
    details: { code: "operation_denied", outcome: "denied" },
    isError: true,
  });
  const second = await executeTool(tool);
  expect(second.details).toMatchObject({ tabs: ["tab-live"] });
  expect(connections).toBe(1);
  expect(calls).toEqual(["browser_tabs", "browser_tabs"]);
});

test("OMP reuses one UUIDv7 idempotency key for retries of a mutation invocation", async () => {
  const tools: Array<Record<string, unknown>> = [];
  const keys: unknown[] = [];
  const client = {
    connection: { task_id: "task-idempotent" },
    get closed() {
      return false;
    },
    request: async (_method: string, _params: unknown, options: { idempotencyKey?: string }) => {
      keys.push(options.idempotencyKey);
      return {
        ok: true,
        outcome: "completed",
        request_id: "request-idempotent",
        result: { tab_id: 7 },
      };
    },
  } as unknown as AgentTabClient;
  makeExtension(async () => client)({
    zod,
    registerTool: (tool: Record<string, unknown>) => tools.push(tool),
  } as unknown as AgentApi);
  const tool = tools.find((candidate) => candidate.name === "browser_open");
  await executeTool(tool, { mode: "create" }, "provider-call-a");
  await executeTool(tool, { mode: "create" }, "provider-call-a");
  await executeTool(tool, { mode: "create" }, "provider-call-b");
  expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
});

test("OMP returns screenshots as one native image payload", async () => {
  const tools: Array<Record<string, unknown>> = [];
  const client = {
    connection: { task_id: "task-image" },
    get closed() {
      return false;
    },
    request: async () => ({
      ok: true,
      outcome: "completed",
      request_id: "request-image",
      result: {
        mode: "screenshot",
        encoding: "base64",
        data: "aW1hZ2U=",
        media_type: "image/webp",
        format: "webp",
        page_revision: 4,
      },
    }),
  } as unknown as AgentTabClient;
  makeExtension(async () => client)({
    zod,
    registerTool: (tool: Record<string, unknown>) => tools.push(tool),
  } as unknown as AgentApi);
  const result = await executeTool(
    tools.find((candidate) => candidate.name === "browser_snapshot"),
    { tab_id: 1, mode: "screenshot", format: "webp" },
  );
  expect(result.content).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/webp" }]);
  expect(result.details).toEqual({
    mode: "screenshot",
    media_type: "image/webp",
    format: "webp",
    page_revision: 4,
    _agenttab: { outcome: "completed", task_id: "task-image" },
  });
  expect(JSON.stringify(result.details)).not.toContain("aW1hZ2U=");
  expect(result.structuredContent).toBeUndefined();
});

test("OMP keeps large snapshot content out of duplicate structured fields", async () => {
  const tools: Array<Record<string, unknown>> = [];
  const content = "x".repeat(12_000);
  const client = {
    connection: { task_id: "task-large" },
    get closed() {
      return false;
    },
    request: async () => ({
      ok: true,
      outcome: "completed",
      request_id: "request-large",
      result: { mode: "text", content, page_revision: 5 },
    }),
  } as unknown as AgentTabClient;
  makeExtension(async () => client)({
    zod,
    registerTool: (tool: Record<string, unknown>) => tools.push(tool),
  } as unknown as AgentApi);
  const result = await executeTool(
    tools.find((candidate) => candidate.name === "browser_snapshot"),
    { tab_id: 1, mode: "text" },
  );
  expect(result.content).toEqual([{
    type: "text",
    text: JSON.stringify({ mode: "text", content, page_revision: 5 }, null, 2),
  }]);
  expect(result.details).toMatchObject({
    mode: "text",
    content_characters: 12_000,
    page_revision: 5,
    _agenttab: { outcome: "completed", task_id: "task-large" },
  });
  expect(JSON.stringify(result.details)).not.toContain(content);
  expect(result.structuredContent).toBeUndefined();
});

test("OMP shares one in-flight Core connection across concurrent first calls", async () => {
  const tools: Array<Record<string, unknown>> = [];
  let connections = 0;
  const client = {
    connection: { task_id: "task-shared-connect" },
    get closed() {
      return false;
    },
    request: async () => ({
      ok: true,
      outcome: "completed",
      request_id: "request-shared-connect",
      result: { tabs: [] },
    }),
  } as unknown as AgentTabClient;
  makeExtension(async () => {
    connections += 1;
    await Promise.resolve();
    return client;
  })({
    zod,
    registerTool: (tool: Record<string, unknown>) => tools.push(tool),
  } as unknown as AgentApi);
  const tool = tools.find((candidate) => candidate.name === "browser_tabs");
  await Promise.all([
    executeTool(tool, {}, "call-tabs-1"),
    executeTool(tool, {}, "call-tabs-2"),
  ]);
  expect(connections).toBe(1);
});

test("OMP tools expose compact and expanded custom renderers", () => {
  for (const tool of register(false).tools) {
    expect(typeof tool.renderCall).toBe("function");
    expect(typeof tool.renderResult).toBe("function");
  }
});

test("Pi mode registers the same tools with TypeBox schemas and Pi metadata", () => {
  const tools = register(false, "pi").tools;
  expect(tools.map((tool) => tool.name)).toEqual([
    "browser_open",
    "browser_snapshot",
    "browser_act",
    "browser_wait",
    "browser_tabs",
    "browser_handoff",
    "browser_commit",
  ]);
  for (const tool of tools) {
    expect(tool.parameters).toBeObject();
    expect(tool.loadMode).toBeUndefined();
    expect(tool.approval).toBeUndefined();
    expect(tool.strict).toBeUndefined();
    expect(typeof tool.renderCall).toBe("function");
    expect(typeof tool.renderResult).toBe("function");
  }
  const snapshot = tools.find((tool) => tool.name === "browser_snapshot");
  const schema = JSON.stringify(snapshot?.parameters);
  expect(schema).toContain('"webp"');
  expect(schema).toContain('"max_width"');
  expect(schema).toContain('"maximum":750000');
});

test("Pi tools call the same Core RPC client", async () => {
  const { tools, calls } = register(false, "pi");
  await executeTool(tools.find((tool) => tool.name === "browser_tabs"));
  expect(calls).toEqual([{ method: "browser_tabs", params: {} }]);
});

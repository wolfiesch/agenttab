import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTabTransportError,
  FrameDecoder,
  encodeFrame,
  type AgentTabClient,
} from "../../sdk-typescript/src/index";
import {
  DEVELOPER_TOOL,
  McpServer,
  STANDARD_TOOLS,
  listedTools,
  readBoundedLines,
  serveMcp,
} from "../src/server";

describe("AgentTab MCP surface", () => {
  test("Standard mode exposes exactly seven Core RPC tools", () => {
    expect(STANDARD_TOOLS.map((tool) => tool.name)).toEqual([
      "browser_open",
      "browser_snapshot",
      "browser_act",
      "browser_wait",
      "browser_tabs",
      "browser_handoff",
      "browser_commit",
    ]);
    expect(listedTools(false)).toHaveLength(7);
    expect(listedTools(false).some((tool) => tool.name === DEVELOPER_TOOL.name)).toBe(false);
  });

  test("browser_open advertises task-owned background window creation", () => {
    const openTool = STANDARD_TOOLS.find((tool) => tool.name === "browser_open")!;
    expect(JSON.stringify(openTool.inputSchema)).toContain("\"new_window\"");
    expect(JSON.stringify(openTool.inputSchema)).toContain("\"background\":{\"const\":true}");
  });

  test("browser_snapshot advertises bounded screenshot encodings", () => {
    const snapshotTool = STANDARD_TOOLS.find((tool) => tool.name === "browser_snapshot")!;
    const schema = JSON.stringify(snapshotTool.inputSchema);
    expect(schema).toContain('"format":{"enum":["png","jpeg","webp"]');
    expect(schema).toContain('"max_width"');
    expect(schema).toContain('"maximum":750000');
    expect(schema).toContain('"maximum":1000000');
  });

  test("browser_act advertises no press action", () => {
    const actionTool = STANDARD_TOOLS.find((tool) => tool.name === "browser_act")!;
    expect(actionTool.inputSchema).not.toHaveProperty("$defs.press");
    expect(actionTool.inputSchema).not.toMatchObject({
      $defs: { action: { oneOf: expect.arrayContaining([{ $ref: "#/$defs/press" }]) } },
    });
  });

  test("browser_act exposes no direct focus transition", () => {
    const actionTool = STANDARD_TOOLS.find((tool) => tool.name === "browser_act")!;
    const definitions = actionTool.inputSchema.$defs as Record<string, any>;
    expect(definitions.history.properties.kind.enum).toEqual(["go_back", "go_forward"]);
    expect(JSON.stringify(actionTool.inputSchema)).not.toContain("\"focus\"");
  });

  test("developer mode adds only browser_developer", () => {
    expect(listedTools(true).map((tool) => tool.name)).toEqual([
      ...STANDARD_TOOLS.map((tool) => tool.name),
      "browser_developer",
    ]);
  });

  test("bounds stdin lines before parsing and recovers at the next newline", async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("12345");
      yield Buffer.from("6789\nok\r\n");
      yield Buffer.from("tail");
    }
    const entries = [];
    for await (const entry of readBoundedLines(chunks(), 8)) entries.push(entry);
    expect(entries).toEqual([
      { error: "AgentTab MCP request exceeds the 8-byte line limit" },
      { line: "ok" },
      { line: "tail" },
    ]);
  });

  test("accepts a line exactly at the stdin byte limit", async () => {
    async function* chunks(): AsyncGenerator<string> {
      yield "1234";
      yield "5678\n";
    }
    const entries = [];
    for await (const entry of readBoundedLines(chunks(), 8)) entries.push(entry);
    expect(entries).toEqual([{ line: "12345678" }]);
  });

  test("default session confirms its initial resume capability before the next tool call", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenttab-mcp-"));
    const endpoint = join(root, "agenttab.sock");
    const previousSocket = process.env.AGENTTAB_SOCKET;
    const previousStateDir = process.env.AGENTTAB_STATE_DIR;
    const previousConversationId = process.env.AGENTTAB_CONVERSATION_ID;
    const methods: string[] = [];
    let confirmed = false;
    const nativeServer = createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        for (const value of decoder.push(chunk) as Array<Record<string, unknown>>) {
          if (value.kind === "connect") {
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

    let server: McpServer | undefined;
    try {
      process.env.AGENTTAB_SOCKET = endpoint;
      process.env.AGENTTAB_STATE_DIR = join(root, "state");
      delete process.env.AGENTTAB_CONVERSATION_ID;
      server = new McpServer();
      const first = await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "browser_open", arguments: { mode: "create" } },
      }) as Record<string, unknown>;
      expect(first.structuredContent).toEqual({
        tab_id: 1,
        _agenttab: {
          outcome: "completed",
          task_id: "018f22b2-4126-7c1a-8c31-3f45a783da44",
        },
      });
      expect(confirmed).toBe(true);

      const second = await server.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "browser_tabs", arguments: {} },
      }) as Record<string, unknown>;
      expect(second.structuredContent).toEqual({
        tabs: [],
        _agenttab: {
          outcome: "completed",
          task_id: "018f22b2-4126-7c1a-8c31-3f45a783da44",
        },
      });
      expect(methods).toEqual(["browser_open", "browser_tabs"]);
    } finally {
      server?.close();
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

  test("evicts a closed client after a failed tool call and reconnects without replaying", async () => {
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
      close: () => undefined,
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
          outcome: "completed",
          request_id: "request-new",
          result: { tabs: ["tab-new"] },
        };
      },
      close: () => undefined,
    } as unknown as AgentTabClient;
    let connections = 0;
    const server = new McpServer({
      clientFactory: async () => {
        connections += 1;
        return connections === 1 ? firstClient : secondClient;
      },
    });
    const first = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_tabs", arguments: {} },
    }) as Record<string, unknown>;
    expect(first).toMatchObject({
      content: [{ type: "text", text: "transport closed" }],
      isError: true,
    });
    expect(calls).toEqual([{ client: "first", method: "browser_tabs" }]);
    const second = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "browser_tabs", arguments: {} },
    }) as Record<string, unknown>;
    expect(second.structuredContent).toEqual({
      tabs: ["tab-new"],
      _agenttab: { outcome: "completed", task_id: "task-new" },
    });
    expect(connections).toBe(2);
    expect(calls).toEqual([
      { client: "first", method: "browser_tabs" },
      { client: "second", method: "browser_tabs" },
    ]);
    server.close();
  });

  test("reports mutation transport failures as unknown with the reconciliation key", async () => {
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
      close: () => undefined,
    } as unknown as AgentTabClient;
    const server = new McpServer({ clientFactory: async () => client });
    const result = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "browser_open",
        arguments: { mode: "create", url: "https://example.com" },
      },
    }) as Record<string, unknown>;
    expect(result).toMatchObject({
      content: [{ type: "text", text: "request timed out" }],
      structuredContent: {
        code: "request_timeout",
        outcome: "unknown",
        method: "browser_open",
        idempotency_key: "00000000-0000-7000-8000-000000000001",
      },
      isError: true,
    });
    server.close();
  });

  test("retains a live client after an application error", async () => {
    const calls: string[] = [];
    const client = {
      connection: { task_id: "task-live" },
      get closed() {
        return false;
      },
      request: async (method: string) => {
        calls.push(method);
        if (calls.length === 1) throw new Error("application rejected");
        return {
          ok: true,
          outcome: "completed",
          request_id: "request-live",
          result: { tabs: ["tab-live"] },
        };
      },
      close: () => undefined,
    } as unknown as AgentTabClient;
    let connections = 0;
    const server = new McpServer({
      clientFactory: async () => {
        connections += 1;
        return client;
      },
    });
    const first = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_tabs", arguments: {} },
    }) as Record<string, unknown>;
    expect(first.isError).toBe(true);
    const second = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "browser_tabs", arguments: {} },
    }) as Record<string, unknown>;
    expect(second.structuredContent).toEqual({
      tabs: ["tab-live"],
      _agenttab: { outcome: "completed", task_id: "task-live" },
    });
    expect(connections).toBe(1);
    expect(calls).toEqual(["browser_tabs", "browser_tabs"]);
    server.close();
  });

  test("initialize and tools/call map directly to Core RPC", async () => {
    const calls: unknown[] = [];
    const client = {
      connection: { task_id: "task-direct" },
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return {
          ok: true,
          outcome: "completed",
          request_id: "request-direct",
          result: { tabs: [] },
        };
      },
      close: () => undefined,
    } as unknown as AgentTabClient;
    const server = new McpServer({ developer: false, clientFactory: async () => client });
    const initialized = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    }) as Record<string, unknown>;
    expect(initialized.protocolVersion).toBe("2025-03-26");
    const result = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "browser_tabs", arguments: {} },
    });
    expect(calls).toEqual([{ method: "browser_tabs", params: {} }]);
    expect(result).toEqual({
      content: [{ type: "text", text: "{\n  \"tabs\": []\n}" }],
      structuredContent: {
        tabs: [],
        _agenttab: { outcome: "completed", task_id: "task-direct" },
      },
    });
    server.close();
  });

  test("MCP forwards long-operation timeouts for SDK deadline selection", async () => {
    const calls: unknown[] = [];
    const client = {
      connection: { task_id: "task-timeout-forwarding" },
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return {
          ok: true,
          outcome: "completed",
          request_id: `request-${method}`,
          result: { matched: true },
        };
      },
      close: () => undefined,
    } as unknown as AgentTabClient;
    const server = new McpServer({ developer: false, clientFactory: async () => client });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "browser_wait",
        arguments: {
          tab_id: 7,
          condition: { kind: "load" },
          timeout_ms: 120_000,
        },
      },
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "browser_handoff",
        arguments: {
          tab_id: 7,
          expected_page_revision: 3,
          prompt: "Complete MFA",
          completion: { kind: "manual_done" },
          timeout_ms: 900_000,
        },
      },
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
    server.close();
  });

  test("reuses the JSON-RPC invocation idempotency key for mutation retries", async () => {
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
          result: { tab_id: 1 },
        };
      },
      close: () => undefined,
    } as unknown as AgentTabClient;
    const server = new McpServer({ clientFactory: async () => client });
    const call = (id: string | number, url?: string) => server.handle({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "browser_open", arguments: { mode: "create", ...(url ? { url } : {}) } },
    });
    await call(11);
    await call(11);
    await call(12);
    await call(11, "https://example.com");
    expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
    server.close();
  });

  test("summarizes large text content without duplicating the structured payload", async () => {
    const text = "x".repeat(12_000);
    const client = {
      connection: { task_id: "task-large" },
      get closed() {
        return false;
      },
      request: async () => ({
        ok: true,
        outcome: "completed",
        request_id: "request-large",
        result: { mode: "text", text, page_revision: 3 },
      }),
      close: () => undefined,
    } as unknown as AgentTabClient;
    const server = new McpServer({ clientFactory: async () => client });
    const result = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_snapshot", arguments: { tab_id: 1, mode: "text" } },
    }) as Record<string, any>;
    expect(result.content).toEqual([{
      type: "text",
      text: expect.stringMatching(/^AgentTab completed; full structured result attached \([0-9]+ bytes\)\.$/),
    }]);
    expect(result.structuredContent).toEqual({
      mode: "text",
      text,
      page_revision: 3,
      _agenttab: { outcome: "completed", task_id: "task-large" },
    });
    server.close();
  });

  test("returns screenshots once as MCP image content", async () => {
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
          byte_length: 5,
          page_revision: 8,
        },
      }),
      close: () => undefined,
    } as unknown as AgentTabClient;
    const server = new McpServer({ clientFactory: async () => client });
    const result = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "browser_snapshot",
        arguments: { tab_id: 1, mode: "screenshot", format: "webp" },
      },
    }) as Record<string, unknown>;
    expect(result).toEqual({
      content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/webp" }],
      structuredContent: {
        mode: "screenshot",
        media_type: "image/webp",
        format: "webp",
        byte_length: 5,
        page_revision: 8,
        _agenttab: { outcome: "completed", task_id: "task-image" },
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("aW1hZ2U=");
    server.close();
  });

  test("dispatches requests concurrently while serializing JSON-RPC output", async () => {
    let releaseWait!: () => void;
    const wait = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const client = {
      connection: { task_id: "task-concurrent" },
      get closed() {
        return false;
      },
      request: async () => {
        await wait;
        return {
          ok: true,
          outcome: "completed",
          request_id: "request-wait",
          result: { matched: true },
        };
      },
      close: () => undefined,
    } as unknown as AgentTabClient;
    const server = new McpServer({ clientFactory: async () => client });
    async function* input(): AsyncGenerator<string> {
      yield `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "browser_wait",
          arguments: { tab_id: 1, condition: { kind: "load" } },
        },
      })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`;
    }
    const responses: Array<Record<string, unknown>> = [];
    let activeWriters = 0;
    let maxActiveWriters = 0;
    let resolvePing!: () => void;
    const pingWritten = new Promise<void>((resolve) => {
      resolvePing = resolve;
    });
    const running = serveMcp(server, input(), async (line) => {
      activeWriters += 1;
      maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
      await Promise.resolve();
      const response = JSON.parse(line) as Record<string, unknown>;
      responses.push(response);
      if (response.id === 2) resolvePing();
      activeWriters -= 1;
    });
    await pingWritten;
    expect(responses.map((response) => response.id)).toEqual([2]);
    releaseWait();
    await running;
    expect(responses.map((response) => response.id)).toEqual([2, 1]);
    expect(maxActiveWriters).toBe(1);
    server.close();
  });

  test("shares one in-flight Core connection across concurrent first calls", async () => {
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
      close: () => undefined,
    } as unknown as AgentTabClient;
    const server = new McpServer({
      clientFactory: async () => {
        connections += 1;
        await Promise.resolve();
        return client;
      },
    });
    await Promise.all([1, 2].map((id) => server.handle({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "browser_tabs", arguments: {} },
    })));
    expect(connections).toBe(1);
    server.close();
  });
});

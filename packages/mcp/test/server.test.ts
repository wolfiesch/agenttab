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
      expect(first.structuredContent).toEqual({ tab_id: 1 });
      expect(confirmed).toBe(true);

      const second = await server.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "browser_tabs", arguments: {} },
      }) as Record<string, unknown>;
      expect(second.structuredContent).toEqual({ tabs: [] });
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
      get closed() {
        return true;
      },
      call: async (method: string) => {
        calls.push({ client: "first", method });
        throw new Error("transport closed");
      },
      close: () => undefined,
    } as unknown as AgentTabClient;
    const secondClient = {
      get closed() {
        return false;
      },
      call: async (method: string) => {
        calls.push({ client: "second", method });
        return { tabs: ["tab-new"] };
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
    expect(second.structuredContent).toEqual({ tabs: ["tab-new"] });
    expect(connections).toBe(2);
    expect(calls).toEqual([
      { client: "first", method: "browser_tabs" },
      { client: "second", method: "browser_tabs" },
    ]);
    server.close();
  });

  test("reports mutation transport failures as unknown with the reconciliation key", async () => {
    const client = {
      get closed() {
        return false;
      },
      call: async () => {
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
      get closed() {
        return false;
      },
      call: async (method: string) => {
        calls.push(method);
        if (calls.length === 1) throw new Error("application rejected");
        return { tabs: ["tab-live"] };
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
    expect(second.structuredContent).toEqual({ tabs: ["tab-live"] });
    expect(connections).toBe(1);
    expect(calls).toEqual(["browser_tabs", "browser_tabs"]);
    server.close();
  });

  test("initialize and tools/call map directly to Core RPC", async () => {
    const calls: unknown[] = [];
    const client = {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return { tabs: [] };
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
      structuredContent: { tabs: [] },
    });
    server.close();
  });
});

import { describe, expect, test } from "bun:test";
import type { AgentTabClient } from "../../sdk-typescript/src/index";
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

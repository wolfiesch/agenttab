import { describe, expect, test } from "bun:test";
import type { AgentTabClient } from "../../sdk-typescript/src/index";
import { DEVELOPER_TOOL, McpServer, STANDARD_TOOLS, listedTools } from "../src/server";

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

  test("developer mode adds only browser_developer", () => {
    expect(listedTools(true).map((tool) => tool.name)).toEqual([
      ...STANDARD_TOOLS.map((tool) => tool.name),
      "browser_developer",
    ]);
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

import { afterEach, expect, test } from "bun:test";
import type { AgentTabClient } from "../../sdk-typescript/src/index";
import { makeExtension, type AgentApi } from "../src/index";

const originalDeveloper = process.env.AGENTTAB_DEVELOPER;
afterEach(() => {
  if (originalDeveloper === undefined) delete process.env.AGENTTAB_DEVELOPER;
  else process.env.AGENTTAB_DEVELOPER = originalDeveloper;
});

const literalValues: unknown[] = [];
const schema: Record<string, unknown> = new Proxy({}, {
  get: () => (..._args: unknown[]) => schema,
});
const zod: Record<string, unknown> = new Proxy({}, {
  get: (_target, property) => (...args: unknown[]) => {
    if (property === "literal") literalValues.push(args[0]);
    return schema;
  },
});

function register(developer: boolean, runtime: "omp" | "pi" = "omp") {
  literalValues.length = 0;
  if (developer) process.env.AGENTTAB_DEVELOPER = "1";
  else delete process.env.AGENTTAB_DEVELOPER;
  const tools: Array<Record<string, unknown>> = [];
  const calls: unknown[] = [];
  const client = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { tabs: [] };
    },
  } as unknown as AgentTabClient;
  const api = {
    ...(runtime === "omp" ? { zod } : {}),
    registerTool: (tool: Record<string, unknown>) => tools.push(tool),
  };
  // The fluent Proxy implements the exact schema calls under test; the production runtime injects concrete Zod.
  const compatibleApi = api as unknown as AgentApi;
  makeExtension(async () => client)(compatibleApi);
  return { tools, calls, literalValues: [...literalValues] };
}

async function executeTool(tool: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
  const execute = tool?.execute;
  if (typeof execute !== "function") throw new Error("Registered tool has no execute function.");
  const value: unknown = await execute("call-1", {});
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
  expect(result.structuredContent).toEqual({ tabs: [] });
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
});

test("Pi tools call the same Core RPC client", async () => {
  const { tools, calls } = register(false, "pi");
  await executeTool(tools.find((tool) => tool.name === "browser_tabs"));
  expect(calls).toEqual([{ method: "browser_tabs", params: {} }]);
});

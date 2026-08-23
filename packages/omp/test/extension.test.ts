import { afterEach, expect, test } from "bun:test";
import type { AgentTabClient } from "../../sdk-typescript/src/index";
import { makeExtension } from "../src/index";

const originalDeveloper = process.env.AGENTTAB_DEVELOPER;
afterEach(() => {
  if (originalDeveloper === undefined) delete process.env.AGENTTAB_DEVELOPER;
  else process.env.AGENTTAB_DEVELOPER = originalDeveloper;
});

const schema: Record<string, unknown> = new Proxy({}, {
  get: () => (..._args: unknown[]) => schema,
});
const zod: Record<string, unknown> = new Proxy({}, {
  get: () => (..._args: unknown[]) => schema,
});

function register(developer: boolean) {
  if (developer) process.env.AGENTTAB_DEVELOPER = "1";
  else delete process.env.AGENTTAB_DEVELOPER;
  const tools: Array<Record<string, any>> = [];
  const calls: unknown[] = [];
  const client = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { tabs: [] };
    },
  } as unknown as AgentTabClient;
  makeExtension(async () => client)({
    zod,
    registerTool: (tool) => tools.push(tool),
  });
  return { tools, calls };
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
  const result = await tools.find((tool) => tool.name === "browser_tabs")!.execute("call-1", {});
  expect(calls).toEqual([{ method: "browser_tabs", params: {} }]);
  expect(result.structuredContent).toEqual({ tabs: [] });
});

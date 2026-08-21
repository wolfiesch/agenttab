import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeControl, executeState } from "./index.mjs";
import { BridgeError, BridgeTransport } from "./transport.mjs";

const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

describe("BridgeTransport", () => {
  test("serializes calls over one authenticated persistent connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-bridge-omp-"));
    const tokenFile = join(root, "token.txt");
    await writeFile(tokenFile, "test-token\n");
    let connections = 0;
    const actions = [];
    const server = net.createServer((socket) => {
      connections += 1;
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const request = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          expect(request.token).toBe("test-token");
          actions.push(request.action);
          socket.write(`${JSON.stringify({ success: true, result: request.action === "ping" ? "pong" : [] })}\n`);
        }
      });
    });
    await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
    const port = server.address().port;
    const client = new BridgeTransport({ port, tokenFile, connectTimeoutMs: 500 });
    cleanup.push(async () => {
      await client.close();
      await new Promise((accept) => server.close(accept));
      await rm(root, { recursive: true, force: true });
    });

    expect((await client.ready(500)).ready).toBe(true);
    expect(await client.call("getTabs")).toEqual([]);
    expect(actions).toEqual(["ping", "getTabs"]);
    expect(connections).toBe(1);
  });

  test("surfaces host denials without replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-bridge-omp-"));
    const tokenFile = join(root, "token.txt");
    await writeFile(tokenFile, "test-token\n");
    let requests = 0;
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        requests += 1;
        socket.write(`${JSON.stringify({ success: false, error: "denied", policyDenial: { remediation: "Allow the origin." } })}\n`);
      });
    });
    await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
    const client = new BridgeTransport({ port: server.address().port, tokenFile, connectTimeoutMs: 500 });
    cleanup.push(async () => {
      await client.close();
      await new Promise((accept) => server.close(accept));
      await rm(root, { recursive: true, force: true });
    });

    await expect(client.call("click", { tabId: 1 })).rejects.toBeInstanceOf(BridgeError);
    expect(requests).toBe(1);
  });
});

describe("OMP tool contract", () => {
  test("open preflights, leases, creates an owned session, and snapshots", async () => {
    const calls = [];
    const client = {
      call: async (action, payload) => {
        calls.push([action, payload]);
        if (action === "policyCheck") {
          return { plan: payload.plan.map((step) => ({ action: step.action, allowed: true, confirmationRequired: false })) };
        }
        if (action === "createTaskSession") return { sessionId: "session-1" };
        if (action === "navigateAndSnapshot") return { tabId: 42, snapshot: { nodes: [] } };
        if (action === "getTaskSessions") return { id: "session-1", tabIds: [42] };
        return { ok: true };
      },
    };

    const result = await executeControl({ action: "open", task_name: "test", url: "https://example.com" }, client);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.sessionId).toBe("session-1");
    expect(calls.map(([action]) => action)).toEqual([
      "lease",
      "policyCheck",
      "createTaskSession",
      "navigateAndSnapshot",
      "getTaskSessions",
    ]);
  });

  test("observe requires an explicit tab and preserves stable-ref options", async () => {
    let received;
    const client = { call: async (action, payload) => ((received = [action, payload]), { nodes: [] }) };
    const result = await executeState({ action: "observe", tab_id: 7, roles: ["button"], diff: true }, client);
    expect(result.isError).toBeUndefined();
    expect(received).toEqual(["observe", { tabId: 7, compact: true, limit: 50, roles: ["button"], diff: true }]);
  });

  test("fill maps to one explicit policy-governed browser action", async () => {
    const calls = [];
    const client = { call: async (action, payload) => (calls.push([action, payload]), { ok: true }) };
    const result = await executeControl({ action: "act", operation: "fill", tab_id: 9, selector: "ref=e3", text: "hello" }, client);
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([
      ["lease", { ttlMs: 300000 }],
      ["fill", { tabId: 9, selector: "ref=e3", text: "hello" }],
    ]);
  });
});

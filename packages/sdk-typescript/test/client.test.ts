import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import {
  AgentTabClient,
  AgentTabError,
  AgentTabTransportError,
  DEFAULT_BROWSER_HANDOFF_TIMEOUT_MS,
  DEFAULT_BROWSER_WAIT_TIMEOUT_MS,
  FrameDecoder,
  LONG_OPERATION_TRANSPORT_GRACE_MS,
  createUuidV7,
  createResumeCapabilityStore,
  encodeFrame,
  resolveTransportTimeoutMs,
  type BrowserAction,
} from "../src/index";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function listen(handler: (socket: Socket) => void): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "agenttab-sdk-"));
  roots.push(root);
  const endpoint = join(root, "agenttab.sock");
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve(endpoint));
  });
}

describe("Core RPC framing", () => {
  test("decodes fragmented and coalesced frames", () => {
    const decoder = new FrameDecoder();
    const first = encodeFrame({ value: 1 });
    const second = encodeFrame({ value: 2 });
    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([{ value: 1 }, { value: 2 }]);
  });

  test("rejects an oversize declaration before payload allocation", () => {
    const decoder = new FrameDecoder(8);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(9, 0);
    expect(() => decoder.push(header)).toThrow("declares 9 bytes; limit is 8");
  });

  test("encodes a schema-valid 64-action UTF-8 request above 64 KiB within the 1 MiB client limit", () => {
    const actions: BrowserAction[] = Array.from({ length: 64 }, () => ({
      kind: "type",
      ref: "e1@1",
      text: "🧪".repeat(2048),
    }));
    const frame = encodeFrame({
      protocol: "agenttab.rpc",
      version: 1,
      request_id: "00000000-0000-7000-8000-000000000001",
      idempotency_key: "00000000-0000-7000-8000-000000000002",
      method: "browser_act",
      params: { tab_id: 1, expected_page_revision: 1, actions },
    });

    expect(frame.readUInt32LE(0)).toBeGreaterThan(64 * 1024);
    expect(frame.readUInt32LE(0)).toBeLessThanOrEqual(1024 * 1024);
  });

  test("rejects a UTF-8 client frame above 1 MiB", () => {
    expect(() => encodeFrame({ text: "🧪".repeat(262_145) })).toThrow(
      "limit is 1048576",
    );
  });

  test("caps host response frames at 1 MiB", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(1024 * 1024 + 1, 0);
    expect(() => new FrameDecoder().push(header)).toThrow("declares 1048577 bytes; limit is 1048576");
  });

  test("UUIDv7 keys carry the timestamp and RFC variant", () => {
    const value = createUuidV7(1_787_524_800_000);
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16)).toBe(1_787_524_800_000);
  });
});

describe("Core RPC transport deadlines", () => {
  test("derives bounded long-operation deadlines from requested and protocol-default timeouts", () => {
    expect(resolveTransportTimeoutMs(
      "browser_wait",
      { tab_id: 1, condition: { kind: "load" } },
    )).toBe(DEFAULT_BROWSER_WAIT_TIMEOUT_MS + LONG_OPERATION_TRANSPORT_GRACE_MS);
    expect(resolveTransportTimeoutMs(
      "browser_wait",
      { tab_id: 1, condition: { kind: "load" }, timeout_ms: 120_000 },
    )).toBe(120_000 + LONG_OPERATION_TRANSPORT_GRACE_MS);
    expect(resolveTransportTimeoutMs(
      "browser_handoff",
      {
        tab_id: 1,
        expected_page_revision: 1,
        prompt: "Complete MFA",
        completion: { kind: "manual_done" },
      },
    )).toBe(DEFAULT_BROWSER_HANDOFF_TIMEOUT_MS + LONG_OPERATION_TRANSPORT_GRACE_MS);
    expect(resolveTransportTimeoutMs("browser_tabs", {}, 45_000)).toBe(45_000);
    expect(resolveTransportTimeoutMs(
      "browser_wait",
      { tab_id: 1, condition: { kind: "load" }, timeout_ms: 1 },
      45_000,
    )).toBe(45_000);
  });

  test("lets a requested browser_wait outlive a shorter generic client timeout", async () => {
    const endpoint = await listen((socket) => {
      const decoder = new FrameDecoder(1024 * 1024);
      socket.on("data", (chunk) => {
        for (const value of decoder.push(chunk) as Array<Record<string, unknown>>) {
          if (value.kind === "connect") {
            socket.write(encodeFrame({
              protocol: "agenttab.rpc",
              version: 1,
              kind: "connected",
              connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da42",
              resumed: false,
              state: "ready",
            }, 1024 * 1024));
            continue;
          }
          setTimeout(() => socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            request_id: value.request_id,
            ok: true,
            outcome: "completed",
            result: { matched: true },
          }, 1024 * 1024)), 30);
        }
      });
    });

    const client = await AgentTabClient.connect({ endpoint, requestTimeoutMs: 10 });
    await expect(client.call("browser_wait", {
      tab_id: 1,
      condition: { kind: "load" },
      timeout_ms: 1,
    })).resolves.toEqual({ matched: true });
    client.close();
  });
});

test("actWaitObserve replaces post-action sleeps with wait and fresh observation", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = Object.create(AgentTabClient.prototype) as AgentTabClient;
  client.request = (async (method: string, params: unknown) => {
    requests.push({ method, params });
    return {
      protocol: "agenttab.rpc",
      version: 1,
      request_id: "act-request",
      ok: true,
      outcome: "completed",
      result: { method },
    };
  }) as AgentTabClient["request"];
  client.call = (async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { method };
  }) as AgentTabClient["call"];

  await expect(client.actWaitObserve({
    act: {
      tab_id: 7,
      expected_page_revision: 3,
      actions: [{ kind: "click", ref: "a3:button:Continue" }],
    },
  })).resolves.toEqual({
    outcome: "completed",
    action: { method: "browser_act" },
    wait: { method: "browser_wait" },
    observation: { method: "browser_snapshot" },
  });
  expect(requests.map(({ method }) => method)).toEqual([
    "browser_act",
    "browser_wait",
    "browser_snapshot",
  ]);
  expect(requests[1].params).toEqual({
    tab_id: 7,
    condition: { kind: "network_idle" },
  });
  expect(requests[2].params).toEqual({ tab_id: 7, mode: "accessibility" });
});

test("actWaitObserve stops on non-completed successful action outcomes", async () => {
  for (const outcome of ["commit_required", "needs_user"] as const) {
    const client = Object.create(AgentTabClient.prototype) as AgentTabClient;
    client.request = (async () => ({
      protocol: "agenttab.rpc",
      version: 1,
      request_id: `${outcome}-request`,
      ok: true,
      outcome,
      result: { stopped: outcome },
    })) as AgentTabClient["request"];
    client.call = (async () => {
      throw new Error("wait or observation must not start");
    }) as AgentTabClient["call"];

    await expect(client.actWaitObserve({
      act: {
        tab_id: 7,
        expected_page_revision: 3,
        actions: [{ kind: "click", ref: "a3:button:Continue" }],
      },
    })).resolves.toEqual({
      outcome,
      action: { stopped: outcome },
    });
  }
});

if (false) {
  // @ts-expect-error Standard browser actions never expose an agent-controlled focus transition.
  const forbiddenFocusAction: BrowserAction = { kind: "focus" };
  void forbiddenFocusAction;
}

test("routes concurrent out-of-order responses by request id", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const endpoint = await listen((socket) => {
    const decoder = new FrameDecoder(64 * 1024);
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (value.kind === "connect") {
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            kind: "connected",
            connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da42",
            resumed: false,
            state: "ready",
          }, 1024 * 1024));
          continue;
        }
        requests.push(value);
        if (requests.length === 2) {
          for (const request of [requests[1], requests[0]]) {
            socket.write(encodeFrame({
              protocol: "agenttab.rpc",
              version: 1,
              request_id: request.request_id,
              ok: true,
              outcome: "completed",
              result: { method: request.method },
            }, 1024 * 1024));
          }
        }
      }
    });
  });

  const client = await AgentTabClient.connect({ endpoint });
  const open = client.call("browser_open", { mode: "create", url: "https://example.com" });
  const tabs = client.call("browser_tabs", {});
  await expect(open).resolves.toEqual({ method: "browser_open" });
  await expect(tabs).resolves.toEqual({ method: "browser_tabs" });
  expect(requests[0].idempotency_key).toMatch(/-7[0-9a-f]{3}-/);
  expect(requests[1]).not.toHaveProperty("idempotency_key");
  client.close();
});

test("exposes a generated key after a timeout so callers can retry without automatic replay", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const endpoint = await listen((socket) => {
    const decoder = new FrameDecoder(1024 * 1024);
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (value.kind === "connect") {
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            kind: "connected",
            connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da42",
            resumed: false,
            state: "ready",
          }, 1024 * 1024));
          continue;
        }
        requests.push(value);
        if (requests.length === 2) {
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            request_id: value.request_id,
            ok: true,
            outcome: "completed",
            result: { retried: true },
          }, 1024 * 1024));
        }
      }
    });
  });

  const client = await AgentTabClient.connect({ endpoint });
  let failure: unknown;
  try {
    await client.call("browser_open", { mode: "create", url: "https://example.com" }, { timeoutMs: 100 });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(AgentTabTransportError);
  const transportError = failure as AgentTabTransportError;
  expect(transportError.code).toBe("request_timeout");
  expect(transportError.method).toBe("browser_open");
  expect(transportError.outcome).toBe("unknown");
  expect(transportError.idempotencyKey).toMatch(/-7[0-9a-f]{3}-/);
  expect(transportError.cause).toBeInstanceOf(Error);
  expect(client.closed).toBe(false);
  await expect(client.call(
    "browser_open",
    { mode: "create", url: "https://example.com" },
    { idempotencyKey: transportError.idempotencyKey },
  )).resolves.toEqual({ retried: true });
  expect(requests).toHaveLength(2);
  expect(requests[0].idempotency_key).toBe(transportError.idempotencyKey);
  expect(requests[1].idempotency_key).toBe(transportError.idempotencyKey);
  client.close();
});

test("exposes a caller-supplied key after connection close so callers can retry it", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let connections = 0;
  const endpoint = await listen((socket) => {
    const connection = connections++;
    const decoder = new FrameDecoder(1024 * 1024);
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (value.kind === "connect") {
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            kind: "connected",
            connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da42",
            resumed: false,
            state: "ready",
          }, 1024 * 1024));
          continue;
        }
        requests.push(value);
        if (connection === 0) {
          socket.end();
        } else {
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            request_id: value.request_id,
            ok: true,
            outcome: "completed",
            result: { retried: true },
          }, 1024 * 1024));
        }
      }
    });
  });

  const suppliedKey = "caller-supplied-idempotency-key";
  const client = await AgentTabClient.connect({ endpoint });
  let failure: unknown;
  try {
    await client.call(
      "browser_open",
      { mode: "create", url: "https://example.com" },
      { idempotencyKey: suppliedKey },
    );
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(AgentTabTransportError);
  const transportError = failure as AgentTabTransportError;
  expect(transportError.code).toBe("connection_closed");
  expect(transportError.method).toBe("browser_open");
  expect(transportError.outcome).toBe("unknown");
  expect(transportError.idempotencyKey).toBe(suppliedKey);
  expect(transportError.cause).toBeInstanceOf(Error);
  expect(client.closed).toBe(true);
  expect(connections).toBe(1);

  const retry = await AgentTabClient.connect({ endpoint });
  await expect(retry.call(
    "browser_open",
    { mode: "create", url: "https://example.com" },
    { idempotencyKey: transportError.idempotencyKey },
  )).resolves.toEqual({ retried: true });
  expect(requests).toHaveLength(2);
  expect(requests[0].idempotency_key).toBe(suppliedKey);
  expect(requests[1].idempotency_key).toBe(suppliedKey);
  retry.close();
});

test("does not create a new task when a stored resume capability is rejected", async () => {
  let connections = 0;
  const endpoint = await listen((socket) => {
    connections += 1;
    const decoder = new FrameDecoder(1024 * 1024);
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (value.kind !== "connect") continue;
        socket.write(encodeFrame({
          protocol: "agenttab.rpc",
          version: 1,
          kind: "connected",
          connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da42",
          resumed: false,
          state: "ready",
        }, 1024 * 1024));
      }
    });
  });

  const capability = "a".repeat(32);
  const store = {
    path: "memory",
    load: async () => capability,
    loadPending: async () => undefined,
    save: async () => undefined,
    prepareReplacement: async () => undefined,
    activateReplacement: async () => undefined,
  };
  await expect(AgentTabClient.connect({
    endpoint,
    capabilityStore: store,
  })).rejects.toThrow("rejected the stored resume capability");
  expect(connections).toBe(1);
});

test("retries the active capability after a pending replacement is rejected", async () => {
  const activeCapability = "a".repeat(32);
  const pendingCapability = "b".repeat(32);
  const replacementCapability = "c".repeat(32);
  const attempted: string[] = [];
  let activated: string | undefined;
  let connectionIndex = 0;
  const endpoint = await listen((socket) => {
    const index = connectionIndex++;
    const decoder = new FrameDecoder(1024 * 1024);
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (value.kind === "connect") {
          attempted.push(String(value.resume_capability));
          if (index === 0) {
            socket.end(encodeFrame({
              protocol: "agenttab.rpc",
              version: 1,
              kind: "connected",
              connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da41",
              resumed: false,
              state: "ready",
            }, 1024 * 1024));
          } else {
            socket.write(encodeFrame({
              protocol: "agenttab.rpc",
              version: 1,
              kind: "connected",
              connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da42",
              resumed: true,
              task_id: "018f22b2-4126-7c1a-8c31-3f45a783da43",
              resume_capability: replacementCapability,
              state: "ready",
            }, 1024 * 1024));
          }
        } else if (value.kind === "resume_confirm") {
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            kind: "resume_confirmed",
            connection_id: value.connection_id,
          }, 1024 * 1024));
        }
      }
    });
  });
  const store = {
    path: "memory",
    load: async () => activeCapability,
    loadPending: async () => pendingCapability,
    save: async () => undefined,
    prepareReplacement: async () => undefined,
    activateReplacement: async (capability: string) => { activated = capability; },
  };

  const client = await AgentTabClient.connect({ endpoint, capabilityStore: store });
  expect(attempted).toEqual([pendingCapability, activeCapability]);
  expect(activated).toBe(replacementCapability);
  client.close();
});

test("durably saves and confirms initial and resumed capability delivery", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenttab-sdk-state-"));
  roots.push(stateDir);
  const store = createResumeCapabilityStore("mcp", { scope: "conversation-1", stateDir });
  const initialCapability = "a".repeat(32);
  const replacementCapability = "b".repeat(32);
  let initialConfirmed = false;

  const firstEndpoint = await listen((socket) => {
    const decoder = new FrameDecoder(1024 * 1024);
    socket.on("data", async (chunk) => {
      for (const value of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (value.kind === "connect") {
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            kind: "connected",
            connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da43",
            resumed: false,
            state: "ready",
          }, 1024 * 1024));
        } else if (value.kind === "resume_confirm") {
          initialConfirmed = value.resume_capability === initialCapability
            && await store.load() === initialCapability;
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            kind: "resume_confirmed",
            connection_id: value.connection_id,
          }, 1024 * 1024));
        } else {
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            request_id: value.request_id,
            ok: true,
            outcome: "completed",
            result: { task: "created" },
            task: {
              task_id: "018f22b2-4126-7c1a-8c31-3f45a783da44",
              resume_capability: initialCapability,
            },
          }, 1024 * 1024));
        }
      }
    });
  });
  const firstClient = await AgentTabClient.connect({ endpoint: firstEndpoint, capabilityStore: store });
  await expect(firstClient.call("browser_open", { mode: "create" })).resolves.toEqual({ task: "created" });
  expect(initialConfirmed).toBe(true);
  expect(await store.load()).toBe(initialCapability);
  firstClient.close();

  let resumedWith: unknown;
  let confirmed = false;
  const secondEndpoint = await listen((socket) => {
    const decoder = new FrameDecoder(1024 * 1024);
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (value.kind === "connect") {
          resumedWith = value.resume_capability;
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            kind: "connected",
            connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da45",
            resumed: true,
            task_id: "018f22b2-4126-7c1a-8c31-3f45a783da44",
            resume_capability: replacementCapability,
            state: "ready",
          }, 1024 * 1024));
        } else if (value.kind === "resume_confirm") {
          confirmed = value.resume_capability === replacementCapability;
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            kind: "resume_confirmed",
            connection_id: value.connection_id,
          }, 1024 * 1024));
        }
      }
    });
  });
  const secondClient = await AgentTabClient.connect({ endpoint: secondEndpoint, capabilityStore: store });
  expect(resumedWith).toBe(initialCapability);
  expect(confirmed).toBe(true);
  expect(await store.load()).toBe(replacementCapability);
  expect(await store.loadPending()).toBeUndefined();
  if (process.platform !== "win32") expect(statSync(store.path).mode & 0o077).toBe(0);
  secondClient.close();
});

test("retains an unconfirmed initial capability after durable save failure", async () => {
  const capability = "i".repeat(32);
  const methods: unknown[] = [];
  let confirmations = 0;
  let saves = 0;
  let persisted: string | undefined;
  const store = {
    path: "memory",
    load: async () => persisted,
    loadPending: async () => undefined,
    save: async (value: string) => {
      saves += 1;
      if (saves === 1) throw new Error("fsync failed");
      persisted = value;
    },
    prepareReplacement: async () => undefined,
    activateReplacement: async () => undefined,
  };
  const endpoint = await listen((socket) => {
    const decoder = new FrameDecoder(1024 * 1024);
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (value.kind === "connect") {
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            kind: "connected",
            connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da46",
            resumed: false,
            state: "ready",
          }, 1024 * 1024));
        } else if (value.kind === "resume_confirm") {
          confirmations += 1;
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            kind: "resume_confirmed",
            connection_id: value.connection_id,
          }, 1024 * 1024));
        } else {
          methods.push(value.method);
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            request_id: value.request_id,
            ok: true,
            outcome: "completed",
            result: { method: value.method },
            ...(methods.length === 1 ? {
              task: {
                task_id: "018f22b2-4126-7c1a-8c31-3f45a783da47",
                resume_capability: capability,
              },
            } : {}),
          }, 1024 * 1024));
        }
      }
    });
  });

  const client = await AgentTabClient.connect({ endpoint, capabilityStore: store });
  let failure: unknown;
  try {
    await client.call("browser_open", { mode: "create" });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AgentTabError);
  expect((failure as AgentTabError).code).toBe("capability_persistence_failed");
  expect(confirmations).toBe(0);
  expect(client.pendingResumeCapability).toBe(capability);
  expect(client.resumeCapability).toBeUndefined();

  await store.save(capability);
  await client.confirmResumeCapability();
  expect(confirmations).toBe(1);
  expect(client.resumeCapability).toBe(capability);
  expect(client.pendingResumeCapability).toBeUndefined();
  await expect(client.call("browser_tabs", {})).resolves.toEqual({ method: "browser_tabs" });
  expect(methods).toEqual(["browser_open", "browser_tabs"]);
  client.close();
});

test("published SDK dist completes durable resume confirmation", async () => {
  const publishedEntry = new URL("../dist/index.js", import.meta.url);
  const published = await import(publishedEntry.href);
  const stateDir = mkdtempSync(join(tmpdir(), "agenttab-sdk-dist-state-"));
  roots.push(stateDir);
  const store = published.createResumeCapabilityStore("mcp", {
    scope: "published-dist",
    stateDir,
  });
  const activeCapability = "g".repeat(32);
  const replacementCapability = "h".repeat(32);
  await store.save(activeCapability);
  let confirmed = false;
  const endpoint = await listen((socket) => {
    const decoder = new FrameDecoder(1024 * 1024);
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (value.kind === "connect") {
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            kind: "connected",
            connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da47",
            resumed: true,
            task_id: "018f22b2-4126-7c1a-8c31-3f45a783da44",
            resume_capability: replacementCapability,
            state: "ready",
          }, 1024 * 1024));
        } else if (value.kind === "resume_confirm") {
          confirmed = value.resume_capability === replacementCapability;
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            kind: "resume_confirmed",
            connection_id: value.connection_id,
          }, 1024 * 1024));
        }
      }
    });
  });

  const client = await published.AgentTabClient.connect({
    endpoint,
    capabilityStore: store,
    connectTimeoutMs: 500,
  });
  expect(confirmed).toBe(true);
  expect(await store.load()).toBe(replacementCapability);
  expect(await store.loadPending()).toBeUndefined();
  client.close();
});

test("retains the active capability while a replacement is awaiting host confirmation", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenttab-sdk-state-"));
  roots.push(stateDir);
  const store = createResumeCapabilityStore("mcp", { scope: "conversation-2", stateDir });
  const active = "c".repeat(32);
  const candidate = "d".repeat(32);
  await store.save(active);
  await store.prepareReplacement(active, candidate);
  expect(await store.load()).toBe(active);
  expect(await store.loadPending()).toBe(candidate);
  await store.activateReplacement(candidate);
  expect(await store.load()).toBe(candidate);
  expect(await store.loadPending()).toBeUndefined();
});

test("does not confirm a replacement when durable staging fails", async () => {
  let confirmations = 0;
  const endpoint = await listen((socket) => {
    const decoder = new FrameDecoder(1024 * 1024);
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (value.kind === "connect") {
          socket.write(encodeFrame({
            protocol: "agenttab.rpc",
            version: 1,
            kind: "connected",
            connection_id: "018f22b2-4126-7c1a-8c31-3f45a783da46",
            resumed: true,
            task_id: "018f22b2-4126-7c1a-8c31-3f45a783da44",
            resume_capability: "f".repeat(32),
            state: "ready",
          }, 1024 * 1024));
        } else if (value.kind === "resume_confirm") {
          confirmations += 1;
        }
      }
    });
  });
  const store = {
    path: "memory",
    load: async () => "e".repeat(32),
    loadPending: async () => undefined,
    save: async () => undefined,
    prepareReplacement: async () => { throw new Error("fsync failed"); },
    activateReplacement: async () => undefined,
  };
  await expect(AgentTabClient.connect({ endpoint, capabilityStore: store })).rejects.toThrow("fsync failed");
  expect(confirmations).toBe(0);
});

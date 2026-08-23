import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import {
  AgentTabClient,
  FrameDecoder,
  createUuidV7,
  encodeFrame,
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

  test("UUIDv7 keys carry the timestamp and RFC variant", () => {
    const value = createUuidV7(1_787_524_800_000);
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16)).toBe(1_787_524_800_000);
  });
});

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

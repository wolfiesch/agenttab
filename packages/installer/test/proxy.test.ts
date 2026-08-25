import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, FrameDecoder } from "../../sdk-typescript/src/index";
import { startProxyServer } from "../src/proxy";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function listen(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve());
  });
}

async function frames(socket: Socket, count: number): Promise<unknown[]> {
  const decoder = new FrameDecoder(64 * 1024);
  return new Promise((resolve, reject) => {
    const values: unknown[] = [];
    socket.on("data", (chunk) => {
      try {
        values.push(...decoder.push(chunk));
        if (values.length >= count) resolve(values);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

describe("agenttab proxy", () => {
  test("rejects a bad bearer before IPC and forwards bytes after a valid bearer", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttab-proxy-test-"));
    roots.push(root);
    const token = "correct-token-with-at-least-thirty-two-characters";
    const tokenFile = join(root, "proxy.token");
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    const endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\agenttab-proxy-test-${process.pid}-${randomUUID()}`
      : join(root, "agenttab.sock");
    let upstreamConnections = 0;
    const upstream = createServer((socket) => {
      upstreamConnections += 1;
      socket.pipe(socket);
    });
    servers.push(upstream);
    await listen(upstream, endpoint);
    const proxy = await startProxyServer({ tokenFile, port: 0, endpoint });
    servers.push(proxy.server);

    const invalid = createConnection({ host: proxy.host, port: proxy.port });
    await new Promise<void>((resolve) => invalid.once("connect", resolve));
    const invalidFrames = frames(invalid, 1);
    invalid.write(encodeFrame({ protocol: "agenttab.proxy", version: 1, token: `${token}-wrong` }, 4096));
    expect(await invalidFrames).toEqual([{ protocol: "agenttab.proxy", version: 1, ok: false, error: "authentication failed" }]);
    invalid.destroy();
    expect(upstreamConnections).toBe(0);

    const valid = createConnection({ host: proxy.host, port: proxy.port });
    await new Promise<void>((resolve) => valid.once("connect", resolve));
    const validFrames = frames(valid, 2);
    const payload = encodeFrame({ probe: "forwarded" });
    valid.write(Buffer.concat([
      encodeFrame({ protocol: "agenttab.proxy", version: 1, token }, 4096),
      payload,
    ]));
    expect(await validFrames).toEqual([
      { protocol: "agenttab.proxy", version: 1, ok: true },
      { probe: "forwarded" },
    ]);
    expect(upstreamConnections).toBe(1);
    valid.destroy();
  });

  test("refuses a group-readable token file on Unix", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "agenttab-proxy-mode-test-"));
    roots.push(root);
    const tokenFile = join(root, "proxy.token");
    await writeFile(tokenFile, "token-with-at-least-thirty-two-characters\n", { mode: 0o644 });
    await chmod(tokenFile, 0o644);
    await expect(startProxyServer({ tokenFile, port: 0, endpoint: join(root, "missing.sock") })).rejects.toThrow("mode 0600");
  });
});

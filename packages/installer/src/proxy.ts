import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { encodeFrame, resolveEndpoint } from "../../sdk-typescript/src/index";

const AUTH_MAX_BYTES = 4096;

function sameToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

async function readToken(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("proxy token path must be a regular file");
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o077) !== 0) throw new Error("proxy token file must have mode 0600");
    if (typeof process.geteuid === "function" && metadata.uid !== process.geteuid()) {
      throw new Error("proxy token file must belong to the current user");
    }
  }
  const token = (await readFile(path, "utf8")).trim();
  if (token.length < 32 || token.length > 1024) throw new Error("proxy token must contain 32 to 1024 characters");
  return token;
}

function authenticate(socket: Socket, expectedToken: string, endpoint: string): void {
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const fail = (message: string) => {
    socket.write(encodeFrame({ protocol: "agenttab.proxy", version: 1, ok: false, error: message }, AUTH_MAX_BYTES));
    socket.end();
  };
  const onData = (chunk: Buffer) => {
    buffered = buffered.byteLength === 0 ? chunk : Buffer.concat([buffered, chunk]);
    if (buffered.byteLength < 4) return;
    const declared = buffered.readUInt32LE(0);
    if (declared > AUTH_MAX_BYTES) {
      fail("authentication frame too large");
      return;
    }
    if (buffered.byteLength < 4 + declared) return;
    socket.off("data", onData);
    let value: unknown;
    try {
      value = JSON.parse(buffered.subarray(4, 4 + declared).toString("utf8"));
    } catch {
      fail("invalid authentication frame");
      return;
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).protocol !== "agenttab.proxy" ||
      (value as Record<string, unknown>).version !== 1 ||
      typeof (value as Record<string, unknown>).token !== "string" ||
      !sameToken((value as Record<string, string>).token, expectedToken)
    ) {
      fail("authentication failed");
      return;
    }
    const remaining = buffered.subarray(4 + declared);
    const upstream = createConnection(endpoint);
    const onConnectError = () => fail("local AgentTab IPC unavailable");
    upstream.once("error", onConnectError);
    upstream.once("connect", () => {
      upstream.off("error", onConnectError);
      upstream.on("error", () => socket.destroy());
      socket.write(encodeFrame({ protocol: "agenttab.proxy", version: 1, ok: true }, AUTH_MAX_BYTES));
      if (remaining.byteLength) upstream.write(remaining);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    socket.once("close", () => upstream.destroy());
  };
  socket.on("data", onData);
}

export interface ProxyServer {
  server: Server;
  host: string;
  port: number;
}

export async function startProxyServer(options: {
  tokenFile: string;
  port?: number;
  host?: string;
  endpoint?: string;
}): Promise<ProxyServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("AgentTab proxy may bind only to loopback");
  const port = options.port ?? 9224;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("proxy port must be 0 to 65535");
  const token = await readToken(options.tokenFile);
  const endpoint = options.endpoint ?? resolveEndpoint();
  const server = createServer((socket) => authenticate(socket, token, endpoint));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  return { server, host, port: typeof address === "object" && address ? address.port : port };
}

export async function runProxy(options: {
  tokenFile: string;
  port?: number;
  host?: string;
  endpoint?: string;
}): Promise<void> {
  const started = await startProxyServer(options);
  console.log(JSON.stringify({ success: true, host: started.host, port: started.port, protocol: "agenttab.proxy/1" }));
  await new Promise<void>((resolve) => {
    const close = () => started.server.close(() => resolve());
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";

export const RPC_PROTOCOL = "agenttab.rpc" as const;
export const RPC_VERSION = 1 as const;
export const CLIENT_TO_HOST_MAX_BYTES = 64 * 1024;
export const HOST_TO_CLIENT_MAX_BYTES = 1024 * 1024;

export type BrowserOpenParams =
  | { mode: "create"; url?: string; background?: boolean }
  | { mode: "adopt_active" };

export type BrowserSnapshotParams =
  | { tab_id: number; mode: "accessibility"; root_ref?: string; max_depth?: number; max_nodes?: number }
  | { tab_id: number; mode: "text" | "html"; selector?: string; max_bytes?: number }
  | { tab_id: number; mode: "screenshot"; selector?: string; full_page?: boolean };

export type BrowserAction =
  | { kind: "click"; ref: string }
  | { kind: "type" | "fill"; ref: string; text: string }
  | { kind: "select"; ref: string; value: string }
  | { kind: "scroll"; delta_x: number; delta_y: number; ref?: string }
  | { kind: "drag"; ref: string; target_ref: string }
  | { kind: "navigate"; url: string }
  | { kind: "go_back" | "go_forward" | "focus" | "close" }
  | { kind: "reload"; bypass_cache?: boolean }
  | { kind: "dialog"; decision: "accept" | "dismiss"; prompt_text?: string }
  | { kind: "upload_file"; ref: string; files: string[] };

export interface BrowserActParams {
  tab_id: number;
  expected_page_revision: number;
  actions: BrowserAction[];
}

export type BrowserWaitCondition =
  | { kind: "load" | "network_idle" | "download" }
  | { kind: "url" | "text" | "selector"; value: string };

export interface BrowserWaitParams {
  tab_id: number;
  condition: BrowserWaitCondition;
  timeout_ms?: number;
}

export interface BrowserHandoffParams {
  tab_id: number;
  expected_page_revision: number;
  prompt: string;
  completion:
  | { kind: "navigation" | "manual_done" }
  | { kind: "url" | "selector"; value: string };
  timeout_ms?: number;
}

export interface BrowserCommitParams {
  staged_token: string;
}

export interface BrowserDeveloperParams {
  action: string;
  params: Record<string, unknown>;
}

export interface MethodParams {
  browser_open: BrowserOpenParams;
  browser_snapshot: BrowserSnapshotParams;
  browser_act: BrowserActParams;
  browser_wait: BrowserWaitParams;
  browser_tabs: Record<string, never>;
  browser_handoff: BrowserHandoffParams;
  browser_commit: BrowserCommitParams;
  browser_developer: BrowserDeveloperParams;
  "agenttab.status": Record<string, never>;
}

export type RpcMethod = keyof MethodParams;
export type MutationMethod =
  | "browser_open"
  | "browser_act"
  | "browser_handoff"
  | "browser_commit"
  | "browser_developer";

export interface ConnectionAck {
  protocol: typeof RPC_PROTOCOL;
  version: typeof RPC_VERSION;
  kind: "connected";
  connection_id: string;
  resumed: boolean;
  task_id?: string;
  resume_capability?: string;
  state?: "starting" | "reconciling" | "ready" | "paused" | "terminal";
}

export type Outcome = "completed" | "not_started" | "unknown" | "needs_user" | "commit_required";

export interface RpcResponse<T = unknown> {
  protocol: typeof RPC_PROTOCOL;
  version: typeof RPC_VERSION;
  request_id: string;
  ok: boolean;
  outcome: Outcome;
  result?: T;
  error?: {
    code: string;
    message: string;
    recovery?: string;
    details?: Record<string, unknown>;
  };
  task?: { task_id: string; resume_capability?: string };
}

export class AgentTabError extends Error {
  readonly code: string;
  readonly outcome: Outcome;
  readonly recovery?: string;
  readonly details?: Record<string, unknown>;

  constructor(response: RpcResponse) {
    super(response.error?.message ?? "AgentTab request failed");
    this.name = "AgentTabError";
    this.code = response.error?.code ?? "unknown";
    this.outcome = response.outcome;
    this.recovery = response.error?.recovery;
    this.details = response.error?.details;
  }
}

export interface ClientOptions {
  conversationId?: string;
  resumeCapability?: string;
  endpoint?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const MUTATIONS = new Set<RpcMethod>([
  "browser_open",
  "browser_act",
  "browser_handoff",
  "browser_commit",
  "browser_developer",
]);

export function createUuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeFrame(value: unknown, limit = CLIENT_TO_HOST_MAX_BYTES): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength > limit) {
    throw new RangeError(`AgentTab frame is ${payload.byteLength} bytes; limit is ${limit}`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  readonly #limit: number;

  constructor(limit = HOST_TO_CLIENT_MAX_BYTES) {
    this.#limit = limit;
  }

  push(chunk: Buffer): unknown[] {
    this.#buffer = this.#buffer.byteLength === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const values: unknown[] = [];
    while (this.#buffer.byteLength >= 4) {
      const declared = this.#buffer.readUInt32LE(0);
      if (declared > this.#limit) {
        throw new RangeError(`AgentTab frame declares ${declared} bytes; limit is ${this.#limit}`);
      }
      if (this.#buffer.byteLength < 4 + declared) break;
      values.push(JSON.parse(this.#buffer.subarray(4, 4 + declared).toString("utf8")));
      this.#buffer = this.#buffer.subarray(4 + declared);
    }
    return values;
  }
}

function currentWindowsSid(): string {
  const output = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const match = output.match(/S-1-[0-9-]+/i);
  if (!match) throw new Error("Could not determine the current Windows user SID");
  return match[0];
}

export function resolveEndpoint(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.AGENTTAB_SOCKET) return environment.AGENTTAB_SOCKET;
  if (environment.AGENTTAB_PIPE_NAME) return environment.AGENTTAB_PIPE_NAME;
  if (platform() === "win32") return `\\\\.\\pipe\\agenttab-${currentWindowsSid()}`;

  const stateRoot = environment.AGENTTAB_STATE_DIR ?? join(environment.HOME ?? homedir(), ".agenttab");
  const runtimeRoot = environment.XDG_RUNTIME_DIR;
  if (runtimeRoot && existsSync(runtimeRoot)) {
    const metadata = statSync(runtimeRoot);
    const effectiveUid = process.geteuid?.();
    if (metadata.isDirectory() && effectiveUid !== undefined && metadata.uid === effectiveUid) {
      return join(runtimeRoot, "agenttab", "agenttab.sock");
    }
  }
  return join(stateRoot, "run", "agenttab.sock");
}

interface PendingRequest {
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class AgentTabClient {
  readonly connection: ConnectionAck;
  #socket: Socket;
  #pending = new Map<string, PendingRequest>();
  #requestTimeoutMs: number;
  #resumeCapability?: string;
  #closed = false;

  private constructor(socket: Socket, connection: ConnectionAck, requestTimeoutMs: number) {
    this.#socket = socket;
    this.connection = connection;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#resumeCapability = connection.resume_capability;
  }

  static async connect(options: ClientOptions = {}): Promise<AgentTabClient> {
    const endpoint = options.endpoint ?? resolveEndpoint();
    const socket = createConnection(endpoint);
    const decoder = new FrameDecoder();
    const timeoutMs = options.connectTimeoutMs ?? 5_000;

    const connected = await new Promise<ConnectionAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out after ${timeoutMs} ms connecting to AgentTab at ${endpoint}`));
      }, timeoutMs);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once("error", fail);
      socket.on("data", (chunk) => {
        try {
          for (const value of decoder.push(chunk)) {
            if (!isConnectionAck(value)) throw new Error("AgentTab sent a response before connection negotiation completed");
            clearTimeout(timer);
            socket.off("error", fail);
            resolve(value);
          }
        } catch (error) {
          socket.destroy();
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once("connect", () => {
        socket.write(
          encodeFrame({
            protocol: RPC_PROTOCOL,
            version: RPC_VERSION,
            kind: "connect",
            ...(options.conversationId ? { conversation_id: options.conversationId } : {}),
            ...(options.resumeCapability ? { resume_capability: options.resumeCapability } : {}),
          }),
        );
      });
    });

    socket.removeAllListeners("data");
    const client = new AgentTabClient(socket, connected, options.requestTimeoutMs ?? 30_000);
    client.#startReader(decoder);
    return client;
  }

  get resumeCapability(): string | undefined {
    return this.#resumeCapability;
  }

  async request<M extends RpcMethod, T = unknown>(
    method: M,
    params: MethodParams[M],
    options: { timeoutMs?: number; idempotencyKey?: string } = {},
  ): Promise<RpcResponse<T>> {
    if (this.#closed) throw new Error("AgentTab client is closed");
    const requestId = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    const response = new Promise<RpcResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`AgentTab ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(requestId, {
        resolve: resolve as (response: RpcResponse) => void,
        reject,
        timer,
      });
    });
    const request = {
      protocol: RPC_PROTOCOL,
      version: RPC_VERSION,
      request_id: requestId,
      ...(MUTATIONS.has(method)
        ? { idempotency_key: options.idempotencyKey ?? createUuidV7() }
        : {}),
      method,
      params,
    };
    this.#socket.write(encodeFrame(request));
    return response;
  }

  async call<M extends RpcMethod, T = unknown>(
    method: M,
    params: MethodParams[M],
    options: { timeoutMs?: number; idempotencyKey?: string } = {},
  ): Promise<T> {
    const response = await this.request<M, T>(method, params, options);
    if (!response.ok) throw new AgentTabError(response);
    return response.result as T;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.end();
    this.#rejectPending(new Error("AgentTab client closed"));
  }

  #startReader(decoder: FrameDecoder): void {
    this.#socket.on("data", (chunk) => {
      try {
        for (const value of decoder.push(chunk)) this.#handleResponse(value);
      } catch (error) {
        this.#socket.destroy();
        this.#rejectPending(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.#socket.on("error", (error) => this.#rejectPending(error));
    this.#socket.on("close", () => {
      this.#closed = true;
      this.#rejectPending(new Error("AgentTab connection closed"));
    });
  }

  #handleResponse(value: unknown): void {
    if (!isRpcResponse(value)) throw new Error("AgentTab sent an invalid RPC response");
    const pending = this.#pending.get(value.request_id);
    if (!pending) return;
    this.#pending.delete(value.request_id);
    clearTimeout(pending.timer);
    if (value.task?.resume_capability) this.#resumeCapability = value.task.resume_capability;
    pending.resolve(value);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConnectionAck(value: unknown): value is ConnectionAck {
  return (
    isRecord(value) &&
    value.protocol === RPC_PROTOCOL &&
    value.version === RPC_VERSION &&
    value.kind === "connected" &&
    typeof value.connection_id === "string" &&
    typeof value.resumed === "boolean"
  );
}

function isRpcResponse(value: unknown): value is RpcResponse {
  return (
    isRecord(value) &&
    value.protocol === RPC_PROTOCOL &&
    value.version === RPC_VERSION &&
    typeof value.request_id === "string" &&
    typeof value.ok === "boolean" &&
    typeof value.outcome === "string"
  );
}

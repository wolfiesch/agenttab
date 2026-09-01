import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

export const RPC_PROTOCOL = "agenttab.rpc" as const;
export const RPC_VERSION = 1 as const;
export const CLIENT_TO_HOST_MAX_BYTES = 1024 * 1024;
export const HOST_TO_CLIENT_MAX_BYTES = 1024 * 1024;

export const STANDARD_ACTION_VALUE_MAX_CHARS = 2048;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_BROWSER_WAIT_TIMEOUT_MS = 30_000;
export const DEFAULT_BROWSER_HANDOFF_TIMEOUT_MS = 300_000;
export const DEFAULT_BROWSER_CREDENTIALS_TIMEOUT_MS = 120_000;
// Core gives long-running extension operations five seconds to return after their
// declared timeout. Keep a second, bounded five-second margin for the response to
// cross the native and Core transports before the client classifies it as unknown.
export const LONG_OPERATION_TRANSPORT_GRACE_MS = 10_000;
export const SNAPSHOT_TEXT_MAX_BYTES = 1_000_000;
export const SCREENSHOT_MAX_BYTES = 750_000;
export const SCREENSHOT_MAX_DIMENSION = 16_384;

export type BrowserOpenParams =
  | { mode: "create"; url?: string; placement?: "task"; background?: boolean }
  | { mode: "create"; url?: string; placement: "new_window"; background?: true }
  | { mode: "adopt_active" };

export type BrowserSnapshotParams =
  | { tab_id: number; mode: "accessibility"; root_ref?: string; max_depth?: number; max_nodes?: number }
  | { tab_id: number; mode: "text" | "html"; selector?: string; match?: "first" | "last"; max_bytes?: number }
  | {
    tab_id: number;
    mode: "screenshot";
    selector?: string;
    full_page?: boolean;
    format?: "png" | "jpeg" | "webp";
    quality?: number;
    max_width?: number;
    max_height?: number;
    max_bytes?: number;
  };

export type BrowserAction =
  | { kind: "click"; ref: string }
  | { kind: "type" | "fill"; ref: string; text: string }
  | { kind: "select"; ref: string; value: string }
  | { kind: "scroll"; delta_x: number; delta_y: number; ref?: string }
  | { kind: "drag"; ref: string; target_ref: string }
  | { kind: "navigate"; url: string }
  | { kind: "go_back" | "go_forward" | "close" }
  | { kind: "reload"; bypass_cache?: boolean }
  | { kind: "dialog"; decision: "accept" | "dismiss" }
  | ({ kind: "upload_file"; files: string[] } & ({ ref: string; selector?: never } | { ref?: never; selector: string }));

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

export type BrowserCredentialsParams =
  | {
    action: "prepare";
    tab_id: number;
    expected_page_revision: number;
  }
  | {
    action: "fill" | "next";
    tab_id: number;
    expected_page_revision: number;
    credential_token: string;
    username_ref?: string;
    password_ref?: string;
    otp_ref?: string;
  };

export interface BrowserCommitParams {
  staged_token: string;
}

export interface BrowserDeveloperParams {
  action: string;
  params: Record<string, unknown>;
}

export interface AgenttabFinishParams {
  disposition?: "auto" | "close" | "keep";
  keep_tab_ids?: number[];
}

export interface AgenttabFinishResult {
  task_id?: string;
  finished: boolean;
  closed_tab_ids: number[];
  retained_tab_ids: number[];
  deferred?: "handoff_active" | "commit_review_active" | "user_confirmation";
}

export interface MethodParams {
  browser_open: BrowserOpenParams;
  browser_snapshot: BrowserSnapshotParams;
  browser_act: BrowserActParams;
  browser_wait: BrowserWaitParams;
  browser_tabs: Record<string, never>;
  browser_handoff: BrowserHandoffParams;
  browser_credentials: BrowserCredentialsParams;
  browser_commit: BrowserCommitParams;
  browser_developer: BrowserDeveloperParams;
  "agenttab.status": Record<string, never>;
  "agenttab.finish": AgenttabFinishParams;
  "agenttab.close": Record<string, never>;
}

export type RpcMethod = keyof MethodParams;
export type MutationMethod =
  | "browser_open"
  | "browser_act"
  | "browser_handoff"
  | "browser_credentials"
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

export type AgentTabTransportErrorCode =
  | "request_timeout"
  | "connection_closed"
  | "transport_error";

export class AgentTabTransportError extends Error {
  readonly code: AgentTabTransportErrorCode;
  readonly method: RpcMethod;
  readonly outcome = "unknown" as const;
  readonly idempotencyKey?: string;

  constructor(
    method: RpcMethod,
    options: {
      code?: AgentTabTransportErrorCode;
      idempotencyKey?: string;
      cause?: unknown;
    } = {},
  ) {
    const message = options.cause instanceof Error
      ? options.cause.message
      : "AgentTab transport failure";
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentTabTransportError";
    this.code = options.code ?? "transport_error";
    this.method = method;
    if (options.idempotencyKey !== undefined) {
      this.idempotencyKey = options.idempotencyKey;
    }
  }
}

export interface ResumeCapabilityStore {
  readonly path: string;
  load(): Promise<string | undefined>;
  loadPending(): Promise<string | undefined>;
  save(capability: string): Promise<void>;
  prepareReplacement(currentCapability: string, replacementCapability: string): Promise<void>;
  activateReplacement(replacementCapability: string): Promise<void>;
  clear(): Promise<void>;
}

interface StoredResumeCapability {
  schemaVersion: 1;
  resumeCapability: string;
  pendingResumeCapability?: string;
}

function validateResumeCapability(capability: string): void {
  if (capability.length < 32 || capability.length > 64) {
    throw new Error("AgentTab resume capability must contain 32 to 64 characters");
  }
}

async function prepareCapabilityDirectory(directory: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  let metadata: Stats;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`AgentTab client state path is not a regular directory: ${directory}`);
  }
  if (platform() !== "win32" && (metadata.mode & 0o077) !== 0) {
    if (!create) throw new Error(`AgentTab client state directory must be owner-only (0700): ${directory}`);
    await chmod(directory, 0o700);
  }
  return true;
}

export function createResumeCapabilityStore(
  namespace: string,
  options: { scope: string; stateDir?: string },
): ResumeCapabilityStore {
  if (!/^[a-z0-9_-]+$/.test(namespace)) {
    throw new Error("AgentTab capability store namespace must contain only lowercase letters, digits, dashes, or underscores");
  }
  if (options.scope.length === 0) {
    throw new Error("AgentTab capability store scope must not be empty");
  }
  const stateDir = options.stateDir ?? process.env.AGENTTAB_STATE_DIR ?? join(homedir(), ".agenttab");
  const scopeHash = createHash("sha256").update(options.scope).digest("hex").slice(0, 32);
  const directory = join(stateDir, "clients");
  const path = join(directory, `${namespace}-${scopeHash}.json`);

  async function loadStoredCapability(): Promise<StoredResumeCapability | undefined> {
    if (!await prepareCapabilityDirectory(directory, false)) return undefined;
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`AgentTab resume capability path is not a regular file: ${path}`);
    }
    if (platform() !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error(`AgentTab resume capability must be owner-only (0600): ${path}`);
    }
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      typeof value.resumeCapability !== "string" ||
      (value.pendingResumeCapability !== undefined && typeof value.pendingResumeCapability !== "string")
    ) {
      throw new Error(`AgentTab resume capability file is invalid: ${path}`);
    }
    validateResumeCapability(value.resumeCapability);
    if (value.pendingResumeCapability !== undefined) validateResumeCapability(value.pendingResumeCapability);
    return {
      schemaVersion: 1,
      resumeCapability: value.resumeCapability,
      ...(value.pendingResumeCapability !== undefined
        ? { pendingResumeCapability: value.pendingResumeCapability }
        : {}),
    };
  }

  async function saveStoredCapability(capability: StoredResumeCapability): Promise<void> {
    validateResumeCapability(capability.resumeCapability);
    if (capability.pendingResumeCapability !== undefined) {
      validateResumeCapability(capability.pendingResumeCapability);
    }
    await prepareCapabilityDirectory(directory, true);
    const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(capability)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, path);
      if (platform() !== "win32") await chmod(path, 0o600);
      const committed = await open(path, "r");
      try {
        await committed.sync();
      } finally {
        await committed.close();
      }
      if (platform() !== "win32") {
        const directoryHandle = await open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  return {
    path,
    async load(): Promise<string | undefined> {
      return (await loadStoredCapability())?.resumeCapability;
    },
    async loadPending(): Promise<string | undefined> {
      return (await loadStoredCapability())?.pendingResumeCapability;
    },
    async save(capability: string): Promise<void> {
      validateResumeCapability(capability);
      await saveStoredCapability({ schemaVersion: 1, resumeCapability: capability });
    },
    async prepareReplacement(currentCapability: string, replacementCapability: string): Promise<void> {
      validateResumeCapability(currentCapability);
      validateResumeCapability(replacementCapability);
      if (currentCapability === replacementCapability) {
        throw new Error("AgentTab resume capability replacement must differ from the current capability");
      }
      const stored = await loadStoredCapability();
      if (
        !stored ||
        (stored.resumeCapability !== currentCapability && stored.pendingResumeCapability !== currentCapability)
      ) {
        throw new Error("AgentTab resume capability store does not contain the capability being resumed");
      }
      await saveStoredCapability({
        schemaVersion: 1,
        resumeCapability: currentCapability,
        pendingResumeCapability: replacementCapability,
      });
    },
    async activateReplacement(replacementCapability: string): Promise<void> {
      validateResumeCapability(replacementCapability);
      const stored = await loadStoredCapability();
      if (!stored || stored.pendingResumeCapability !== replacementCapability) {
        throw new Error("AgentTab resume capability store does not contain the confirmed replacement");
      }
      await saveStoredCapability({ schemaVersion: 1, resumeCapability: replacementCapability });
    },
    async clear(): Promise<void> {
      const exists = await prepareCapabilityDirectory(directory, false);
      if (!exists) return;
      await rm(path, { force: true });
      if (platform() !== "win32") {
        const directoryHandle = await open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    },
  };
}

function capabilityPersistenceError(response: RpcResponse, error: unknown): AgentTabError {
  return new AgentTabError({
    protocol: RPC_PROTOCOL,
    version: RPC_VERSION,
    request_id: response.request_id,
    ok: false,
    outcome: response.outcome,
    error: {
      code: "capability_persistence_failed",
      message: `AgentTab completed the RPC but could not persist its resume capability: ${error instanceof Error ? error.message : String(error)
        }`,
      recovery: "Repair the owner-only AgentTab client state directory before restarting or retrying.",
    },
  });
}

export interface ClientOptions {
  conversationId?: string;
  resumeCapability?: string;
  endpoint?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  capabilityStore?: ResumeCapabilityStore;
}

const MUTATIONS = new Set<RpcMethod>([
  "browser_open",
  "browser_act",
  "browser_handoff",
  "browser_credentials",
  "browser_commit",
  "browser_developer",
]);

function longOperationTimeoutMs(
  method: RpcMethod,
  params: MethodParams[RpcMethod],
): number | undefined {
  let defaultTimeoutMs: number;
  if (method === "browser_wait") {
    defaultTimeoutMs = DEFAULT_BROWSER_WAIT_TIMEOUT_MS;
  } else if (method === "browser_handoff") {
    defaultTimeoutMs = DEFAULT_BROWSER_HANDOFF_TIMEOUT_MS;
  } else if (method === "browser_credentials") {
    defaultTimeoutMs = DEFAULT_BROWSER_CREDENTIALS_TIMEOUT_MS;
  } else {
    return undefined;
  }
  const requestedTimeoutMs = (params as { timeout_ms?: unknown }).timeout_ms;
  return typeof requestedTimeoutMs === "number"
    && Number.isSafeInteger(requestedTimeoutMs)
    && requestedTimeoutMs > 0
    ? requestedTimeoutMs
    : defaultTimeoutMs;
}

export function resolveTransportTimeoutMs(
  method: RpcMethod,
  params: MethodParams[RpcMethod],
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): number {
  const operationTimeoutMs = longOperationTimeoutMs(method, params);
  if (operationTimeoutMs === undefined) return requestTimeoutMs;
  return Math.max(
    requestTimeoutMs,
    operationTimeoutMs + LONG_OPERATION_TRANSPORT_GRACE_MS,
  );
}

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
  timer: NodeJS.Timeout;
  method: RpcMethod;
  idempotencyKey?: string;
}

interface PendingCapabilityConfirmation {
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface NegotiatedConnection {
  socket: Socket;
  decoder: FrameDecoder;
  connected: ConnectionAck;
}

async function negotiateConnection(
  endpoint: string,
  timeoutMs: number,
  conversationId: string | undefined,
  resumeCapability: string | undefined,
): Promise<NegotiatedConnection> {
  const socket = createConnection(endpoint);
  const decoder = new FrameDecoder();
  const connected = await new Promise<ConnectionAck>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out after ${timeoutMs} ms connecting to AgentTab at ${endpoint}`));
    }, timeoutMs);
    const closed = () => fail(new Error("AgentTab closed during connection negotiation"));
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.off("error", fail);
      socket.off("close", closed);
      reject(error);
    };
    const accept = (value: ConnectionAck) => {
      clearTimeout(timer);
      socket.off("error", fail);
      socket.off("close", closed);
      socket.removeAllListeners("data");
      resolve(value);
    };
    socket.once("error", fail);
    socket.once("close", closed);
    socket.on("data", (chunk) => {
      try {
        for (const value of decoder.push(chunk)) {
          if (!isConnectionAck(value)) throw new Error("AgentTab sent a response before connection negotiation completed");
          accept(value);
          return;
        }
      } catch (error) {
        socket.destroy();
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("connect", () => {
      socket.write(encodeFrame({
        protocol: RPC_PROTOCOL,
        version: RPC_VERSION,
        kind: "connect",
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(resumeCapability ? { resume_capability: resumeCapability } : {}),
      }));
    });
  });
  return { socket, decoder, connected };
}

async function confirmResumeCapability(
  socket: Socket,
  decoder: FrameDecoder,
  connection: ConnectionAck,
  capability: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out after ${timeoutMs} ms confirming the AgentTab resume capability`));
    }, timeoutMs);
    const closed = () => fail(new Error("AgentTab closed before accepting the resume confirmation"));
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.off("error", fail);
      socket.off("close", closed);
      socket.removeAllListeners("data");
      reject(error);
    };
    socket.once("error", fail);
    socket.once("close", closed);
    socket.on("data", (chunk) => {
      try {
        for (const value of decoder.push(chunk)) {
          if (!isResumeCapabilityConfirmed(value, connection.connection_id)) {
            throw new Error("AgentTab rejected or malformed the resume capability confirmation");
          }
          clearTimeout(timer);
          socket.off("error", fail);
          socket.off("close", closed);
          socket.removeAllListeners("data");
          resolve();
          return;
        }
      } catch (error) {
        socket.destroy();
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.write(encodeFrame({
      protocol: RPC_PROTOCOL,
      version: RPC_VERSION,
      kind: "resume_confirm",
      connection_id: connection.connection_id,
      resume_capability: capability,
    }));
  });
}

export class AgentTabClient {
  readonly connection: ConnectionAck;
  #socket: Socket;
  #pending = new Map<string, PendingRequest>();
  #requestTimeoutMs: number;
  #resumeCapability?: string;
  #pendingResumeCapability?: string;
  #capabilityStore?: ResumeCapabilityStore;
  #capabilityConfirmation?: PendingCapabilityConfirmation;
  #closed = false;
  private constructor(
    socket: Socket,
    connection: ConnectionAck,
    requestTimeoutMs: number,
    capabilityStore?: ResumeCapabilityStore,
  ) {
    this.#socket = socket;
    this.connection = connection;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#resumeCapability = connection.resume_capability;
    this.#capabilityStore = capabilityStore;
  }

  static async connect(options: ClientOptions = {}): Promise<AgentTabClient> {
    const endpoint = options.endpoint ?? resolveEndpoint();
    const timeoutMs = options.connectTimeoutMs ?? 5_000;
    const store = options.capabilityStore;
    if (options.resumeCapability && !store) {
      throw new Error("AgentTab refuses to resume without a persistent ResumeCapabilityStore");
    }
    const pendingCapability = options.resumeCapability ? undefined : await store?.loadPending();
    const activeCapability = options.resumeCapability ?? await store?.load();
    const candidates = [pendingCapability, activeCapability]
      .filter((value): value is string => value !== undefined)
      .filter((value, index, values) => values.indexOf(value) === index);
    let attemptedCapability: string | undefined;
    let negotiated: NegotiatedConnection | undefined;
    for (const capability of candidates.length === 0 ? [undefined] : candidates) {
      const attempt = await negotiateConnection(endpoint, timeoutMs, options.conversationId, capability);
      if (capability && !attempt.connected.resumed) {
        attempt.socket.destroy();
        if (capability !== activeCapability) continue;
        throw new Error(
          "AgentTab rejected the stored resume capability; remove that client state only when starting a new task is intended",
        );
      }
      attemptedCapability = capability;
      negotiated = attempt;
      break;
    }
    if (!negotiated) throw new Error("AgentTab could not establish a connection");

    const { socket, decoder, connected } = negotiated;
    if (connected.resumed) {
      const replacement = connected.resume_capability;
      if (!store || !attemptedCapability || !replacement) {
        socket.destroy();
        throw new Error("AgentTab resumed without the durable resume-confirmation prerequisites");
      }
      try {
        await store.prepareReplacement(attemptedCapability, replacement);
        await confirmResumeCapability(socket, decoder, connected, replacement, timeoutMs);
        await store.activateReplacement(replacement);
      } catch (error) {
        socket.destroy();
        throw new Error(
          `AgentTab could not complete durable resume-capability rotation: ${error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else if (connected.resume_capability) {
      socket.destroy();
      throw new Error("AgentTab returned an initial resume capability before creating a task");
    }
    const client = new AgentTabClient(
      socket,
      connected,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      store,
    );
    client.#startReader(decoder);
    return client;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get resumeCapability(): string | undefined {
    return this.#resumeCapability;
  }

  get pendingResumeCapability(): string | undefined {
    return this.#pendingResumeCapability;
  }

  async confirmResumeCapability(): Promise<void> {
    const capability = this.#pendingResumeCapability;
    if (!capability) {
      throw new Error("AgentTab has no pending resume capability to confirm");
    }
    if (this.#closed) throw new Error("AgentTab client is closed");
    await this.#confirmPendingCapability(capability);
    this.#resumeCapability = capability;
    this.#pendingResumeCapability = undefined;
  }

  async request<M extends RpcMethod, T = unknown>(
    method: M,
    params: MethodParams[M],
    options: { timeoutMs?: number; idempotencyKey?: string } = {},
  ): Promise<RpcResponse<T>> {
    if (this.#closed) throw new Error("AgentTab client is closed");
    if (this.#pendingResumeCapability) {
      throw new Error(
        "Persist pendingResumeCapability durably, then call confirmResumeCapability before RPC",
      );
    }
    const requestId = randomUUID();
    // A caller-supplied per-request timeout remains authoritative. Otherwise,
    // long-running methods inherit their operation timeout plus transport grace.
    const timeoutMs = options.timeoutMs ?? resolveTransportTimeoutMs(
      method,
      params,
      this.#requestTimeoutMs,
    );
    const idempotencyKey = MUTATIONS.has(method)
      ? options.idempotencyKey ?? createUuidV7()
      : undefined;
    const request = {
      protocol: RPC_PROTOCOL,
      version: RPC_VERSION,
      request_id: requestId,
      ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
      method,
      params,
    };
    const frame = encodeFrame(request);
    const response = new Promise<RpcResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        pending.reject(this.#transportError(
          pending,
          new Error(`AgentTab ${method} timed out after ${timeoutMs} ms`),
          "request_timeout",
        ));
      }, timeoutMs);
      this.#pending.set(requestId, {
        resolve: resolve as (response: RpcResponse) => void,
        reject,
        timer,
        method,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      });
    });
    try {
      this.#socket.write(frame, (error) => {
        if (error) this.#failTransport(error, "transport_error");
      });
    } catch (error) {
      this.#failTransport(error, "transport_error");
    }
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

  async finishTask(params: AgenttabFinishParams = {}): Promise<AgenttabFinishResult> {
    if (this.#closed) {
      return { finished: false, closed_tab_ids: [], retained_tab_ids: [] };
    }
    const result = await this.call<"agenttab.finish", AgenttabFinishResult>(
      "agenttab.finish",
      params,
    );
    if (result.finished) {
      await this.#capabilityStore?.clear();
      this.close();
    }
    return result;
  }

  async closeTask(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.call("agenttab.close", {});
      await this.#capabilityStore?.clear();
    } finally {
      this.close();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.end();
    this.#rejectCapabilityConfirmation(new Error("AgentTab client closed"));
    this.#rejectPending(new Error("AgentTab client closed"));
  }

  #startReader(decoder: FrameDecoder): void {
    this.#socket.on("data", (chunk) => {
      try {
        for (const value of decoder.push(chunk)) this.#handleResponse(value);
      } catch (error) {
        this.#failTransport(error, "transport_error");
      }
    });
    this.#socket.on("error", (error) => this.#failTransport(error, "transport_error"));
    this.#socket.on("close", () => this.#failTransport(
      new Error("AgentTab connection closed"),
      "connection_closed",
    ));
  }

  #handleResponse(value: unknown): void {
    if (isResumeCapabilityConfirmed(value, this.connection.connection_id)) {
      const confirmation = this.#capabilityConfirmation;
      if (!confirmation) {
        throw new Error("AgentTab confirmed an unexpected resume capability");
      }
      clearTimeout(confirmation.timer);
      this.#capabilityConfirmation = undefined;
      confirmation.resolve();
      return;
    }
    if (!isRpcResponse(value)) throw new Error("AgentTab sent an invalid RPC response");
    const pending = this.#pending.get(value.request_id);
    if (!pending) return;
    this.#pending.delete(value.request_id);
    clearTimeout(pending.timer);
    const capability = value.task?.resume_capability;
    if (!capability) {
      pending.resolve(value);
      return;
    }
    if (this.#pendingResumeCapability) {
      throw new Error("AgentTab delivered multiple unconfirmed resume capabilities");
    }
    this.#pendingResumeCapability = capability;
    if (!this.#capabilityStore) {
      pending.resolve(value);
      return;
    }
    void (async () => {
      try {
        await this.#capabilityStore!.save(capability);
      } catch (error) {
        pending.reject(capabilityPersistenceError(value, error));
        return;
      }
      try {
        await this.confirmResumeCapability();
        pending.resolve(value);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  }

  #confirmPendingCapability(capability: string): Promise<void> {
    if (this.#capabilityConfirmation) {
      throw new Error("AgentTab resume capability confirmation is already pending");
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#failTransport(
          new Error(`Timed out after ${this.#requestTimeoutMs} ms confirming the AgentTab resume capability`),
          "request_timeout",
        );
      }, this.#requestTimeoutMs);
      this.#capabilityConfirmation = { resolve, reject, timer };
      try {
        this.#socket.write(encodeFrame({
          protocol: RPC_PROTOCOL,
          version: RPC_VERSION,
          kind: "resume_confirm",
          connection_id: this.connection.connection_id,
          resume_capability: capability,
        }), (error) => {
          if (error) this.#failTransport(error, "transport_error");
        });
      } catch (error) {
        this.#failTransport(error, "transport_error");
      }
    });
  }

  #failTransport(error: unknown, code: AgentTabTransportErrorCode): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.#rejectCapabilityConfirmation(error);
    this.#rejectPending(error, code);
  }

  #transportError(
    pending: PendingRequest,
    cause: unknown,
    code: AgentTabTransportErrorCode,
  ): AgentTabTransportError {
    return new AgentTabTransportError(pending.method, {
      code,
      ...(pending.idempotencyKey !== undefined ? { idempotencyKey: pending.idempotencyKey } : {}),
      cause,
    });
  }

  #rejectCapabilityConfirmation(cause: unknown): void {
    const confirmation = this.#capabilityConfirmation;
    if (!confirmation) return;
    this.#capabilityConfirmation = undefined;
    clearTimeout(confirmation.timer);
    confirmation.reject(cause instanceof Error ? cause : new Error(String(cause)));
  }

  #rejectPending(cause: unknown, code?: AgentTabTransportErrorCode): void {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(code === undefined ? error : this.#transportError(pending, cause, code));
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
    typeof value.resumed === "boolean" &&
    (!value.resumed ||
      (typeof value.task_id === "string" && typeof value.resume_capability === "string"))
  );
}

function isResumeCapabilityConfirmed(value: unknown, connectionId: string): boolean {
  return (
    isRecord(value) &&
    value.protocol === RPC_PROTOCOL &&
    value.version === RPC_VERSION &&
    value.kind === "resume_confirmed" &&
    value.connection_id === connectionId
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

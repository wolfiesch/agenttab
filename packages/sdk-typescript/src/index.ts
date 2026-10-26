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
/** Unicode scalar values allowed in a `browser_act` intent caption. */
export const ACT_INTENT_MAX_CHARS = 120;
/** Tool-description sentence that teaches agents the `browser_act` intent contract. */
export const ACT_INTENT_GUIDANCE = `Optional \`intent\` (one line, up to ${ACT_INTENT_MAX_CHARS} characters) states the batch's purpose and becomes the on-screen pointer caption, for example "Open the bookmarks folder"; never put secrets or field values in it.`;
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

export const STANDARD_PRESS_KEYS = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Escape",
  "Tab",
  "Home",
  "End",
  "Space",
  "Backspace",
  "Delete",
  "a",
  "z",
  "y",
] as const;

export type BrowserOpenParams =
  | { mode: "create"; url?: string; placement?: "task"; background?: boolean }
  | { mode: "create"; url?: string; placement: "new_window"; background?: true }
  | { mode: "adopt_active" };

type FrameScoped = { frame_id?: string };
type Target = ({ ref: string; selector?: never } | { ref?: never; selector: string }) & FrameScoped;
type DownloadTarget = Target & { expect_download?: boolean };

export type BrowserSnapshotParams =
  | ({ tab_id: number; mode: "accessibility"; root_ref?: string; max_depth?: number; max_nodes?: number; query?: { role?: string; name?: string } } & FrameScoped)
  | ({ tab_id: number; mode: "text" | "html"; selector?: string; match?: "first" | "last"; max_bytes?: number } & FrameScoped)
  | ({
    tab_id: number;
    mode: "screenshot";
    selector?: string;
    full_page?: boolean;
    format?: "png" | "jpeg" | "webp";
    quality?: number;
    max_width?: number;
    max_height?: number;
    max_bytes?: number;
  } & FrameScoped);

export type ChallengeKind = "interstitial" | "widget" | "puzzle" | "block" | "rate_limit";
export type ChallengeInteraction = "automatic" | "human" | "none";
export type ChallengeState = "active" | "cleared" | "superseded";
export type ChallengeNext = "wait" | "handoff" | "retry_later" | "stop" | "none";

export interface ChallengeSurface {
  scope: "document" | "frame" | "element";
  frame_id?: string;
  frame_origin?: string;
  visible: boolean;
}

/**
 * One active or just-ended bot challenge episode on a task-owned tab, as defined by
 * schemas/rpc/v1/challenge.schema.json. Carries no page text, URL path or query,
 * sitekey, or response token.
 */
export interface ChallengeEvent {
  spec_version: 1;
  challenge_id: string;
  tab_id: number;
  page_revision: number;
  first_page_revision: number;
  first_detected_at_ms: number;
  detected_at_ms: number;
  page_origin: string;
  vendor: string;
  product: string;
  kind: ChallengeKind;
  interaction: ChallengeInteraction;
  state: ChallengeState;
  confidence: "high" | "medium" | "low";
  surface: ChallengeSurface;
  token_present?: boolean;
  signals: string[];
  next: ChallengeNext;
  wait_budget_ms?: number;
  retry_after_ms?: number;
  notice_id?: string;
  detector: { catalog_version: string; probe: "debugger" | "scripting" };
}

/**
 * Optional members that browser_open, browser_snapshot, browser_act, browser_wait,
 * and a browser_handoff resolve result add when a challenge is present. `status` is
 * "challenge_active" (act) or "challenge_needs_user" (wait) with outcome needs_user.
 */
export interface ChallengeBearingResult {
  challenge?: ChallengeEvent;
  status?: string;
}

/** Agent guidance for results that carry `challenge`; adapters add it to tool descriptions. */
export const CHALLENGE_GUIDANCE = {
  summary:
    "A result may carry `challenge`. While challenge.state is active, follow challenge.next: " +
    "wait (browser_wait with a challenge_cleared condition; no reload or clicks meanwhile), " +
    "handoff (tell the user in chat, then browser_handoff with a challenge_cleared completion), " +
    "retry_later (pause work on that origin until retry_after_ms passes), " +
    "stop (report the block and its origin; no handoff, reload, or retry). " +
    "Never act inside the challenge surface; reload at most once per episode.",
  wait:
    "When a result has `challenge` with state active and next wait, call this with " +
    "{ kind: \"challenge_cleared\", challenge_id } and timeout_ms = challenge.wait_budget_ms; " +
    "do not reload or click meanwhile.",
  handoff:
    "For a `challenge` with state active and next handoff, tell the user in chat what to complete, " +
    "then request with completion { kind: \"challenge_cleared\", value: challenge_id }. " +
    "After the user replies, call resolve; completion_not_met means it has not cleared.",
} as const;

export type BrowserPressKey = typeof STANDARD_PRESS_KEYS[number];
export type BrowserPressModifier = "Alt" | "Control" | "Meta" | "Shift";

export type BrowserAction =
  | ({ kind: "click" | "double_click" | "context_click" } & DownloadTarget)
  | ({ kind: "hover" } & Target)
  | ({ kind: "press"; key: BrowserPressKey; modifiers?: BrowserPressModifier[] } & DownloadTarget)
  | ({ kind: "type" | "fill"; text: string } & Target)
  | ({ kind: "select"; ref: string; value: string } & FrameScoped)
  | ({ kind: "scroll"; delta_x: number; delta_y: number; ref?: string } & FrameScoped)
  | ({ kind: "drag"; ref: string; target_ref: string } & FrameScoped)
  | { kind: "navigate"; url: string; expect_download?: boolean }
  | { kind: "go_back" | "go_forward"; expect_download?: boolean }
  | { kind: "reload"; bypass_cache?: boolean; expect_download?: boolean }
  | { kind: "close" }
  | { kind: "dialog"; decision: "accept"; prompt_text?: string }
  | { kind: "dialog"; decision: "dismiss"; prompt_text?: never }
  | ({ kind: "upload_file"; files: string[] } & Target);

export interface BrowserActParams {
  tab_id: number;
  expected_page_revision: number;
  actions: BrowserAction[];
  /** One-line purpose shown as the pointer caption, replacing the generated action label. */
  intent?: string;
}

export type BrowserWaitCondition =
  | { kind: "load" | "network_idle" }
  | { kind: "download"; after?: string }
  | { kind: "challenge_cleared"; challenge_id: string }
  | { kind: "url" | "text"; value: string }
  | { kind: "selector"; value: string; state?: "attached" | "detached" | "visible" | "hidden" | "enabled"; frame_id?: string }
  | { kind: "value"; selector: string; value: string; frame_id?: string };

export interface BrowserWaitParams {
  tab_id: number;
  condition: BrowserWaitCondition;
  timeout_ms?: number;
}

export type BrowserHandoffCompletion =
  | { kind: "url" | "selector"; value: string }
  | { kind: "challenge_cleared"; value: string };

export type BrowserHandoffParams =
  | {
    operation: "request";
    tab_id: number;
    expected_page_revision: number;
    prompt: string;
    completion?: BrowserHandoffCompletion;
    timeout_ms?: number;
  }
  | { operation: "status" | "resolve" | "dismiss"; notice_id: string };

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

export type BrowserProfileReadOperation =
  | "bookmarks_search"
  | "bookmarks_tree"
  | "history_search"
  | "sessions_recent"
  | "sessions_devices"
  | "downloads_search";

export type BrowserProfileWriteOperation =
  | "bookmarks_update"
  | "bookmarks_create"
  | "bookmarks_move"
  | "bookmarks_remove"
  | "sessions_restore"
  | "downloads_cancel"
  | "downloads_pause"
  | "downloads_resume";

export type BrowserProfileOperation = BrowserProfileReadOperation | BrowserProfileWriteOperation;

/** Bookmark ids are decimal strings; download ids are non-negative integers. */
export type BrowserProfileParams =
  | { operation: "bookmarks_search"; query: string; limit?: number }
  | { operation: "bookmarks_tree"; folder_id?: string; depth?: number }
  | { operation: "bookmarks_update"; id: string; title: string; url?: string }
  | { operation: "bookmarks_update"; id: string; title?: string; url: string }
  | { operation: "bookmarks_create"; parent_id: string; title: string; url?: string; index?: number }
  | { operation: "bookmarks_move"; id: string; parent_id: string; index?: number }
  | { operation: "bookmarks_remove"; id: string }
  | { operation: "history_search"; text: string; start_time?: number; end_time?: number; limit: number }
  | { operation: "sessions_recent" | "sessions_devices"; limit?: number }
  | { operation: "sessions_restore"; session_id: string }
  | {
    operation: "downloads_search";
    query?: string;
    state?: "in_progress" | "interrupted" | "complete";
    limit?: number;
  }
  | { operation: "downloads_cancel" | "downloads_pause" | "downloads_resume"; id: number };

export interface BrowserProfileBookmark {
  id: string;
  parent_id?: string;
  index?: number;
  title: string;
  url?: string;
  kind: "bookmark" | "folder";
  date_added_ms?: number;
}

export interface BrowserProfileBookmarkNode extends BrowserProfileBookmark {
  child_count?: number;
  children?: BrowserProfileBookmarkNode[];
}

export interface BrowserProfileSessionTab {
  session_id?: string;
  title: string;
  url: string;
}

export interface BrowserProfileSessionEntry {
  kind: "tab" | "window";
  session_id?: string;
  last_modified_ms: number;
  title?: string;
  url?: string;
  tab_count?: number;
  tabs?: BrowserProfileSessionTab[];
}

export interface BrowserProfileDownload {
  id: number;
  filename: string;
  url: string;
  final_url?: string;
  state: string;
  paused: boolean;
  bytes_received: number;
  total_bytes: number;
  error?: string;
  mime?: string;
  start_time_ms?: number;
  end_time_ms?: number;
}

/** Completed `browser_profile` results, discriminated by `operation`. */
export type BrowserProfileResult =
  | { operation: "bookmarks_search"; bookmarks: BrowserProfileBookmark[]; count: number; truncated: boolean }
  | { operation: "bookmarks_tree"; root: BrowserProfileBookmarkNode; node_count: number; truncated: boolean }
  | { operation: "bookmarks_update"; id: string; updated: ("title" | "url")[] }
  | { operation: "bookmarks_create" | "bookmarks_move"; id: string; parent_id: string; index: number }
  | { operation: "bookmarks_remove"; id: string; removed: true }
  | {
    operation: "history_search";
    items: {
      id: string;
      url: string;
      title: string;
      last_visit_time_ms?: number;
      visit_count: number;
      typed_count: number;
    }[];
    count: number;
  }
  | { operation: "sessions_recent"; sessions: BrowserProfileSessionEntry[]; count: number }
  | {
    operation: "sessions_devices";
    devices: { device_name: string; sessions: BrowserProfileSessionEntry[] }[];
    count: number;
  }
  | {
    operation: "sessions_restore";
    session_id: string;
    kind: "tab" | "window";
    opened: { tab_id: number; page_revision: number }[];
    skipped: number;
  }
  | { operation: "downloads_search"; downloads: BrowserProfileDownload[]; count: number }
  | {
    operation: "downloads_cancel" | "downloads_pause" | "downloads_resume";
    id: number;
    state: string;
    paused: boolean;
  };

export interface AgenttabFinishParams {
  disposition?: "auto" | "close" | "keep";
  keep_tab_ids?: number[];
}

export interface AgenttabFinishResult {
  task_id?: string;
  finished: boolean;
  closed_tab_ids: number[];
  retained_tab_ids: number[];
  deferred?: "commit_review_active" | "user_confirmation";
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
  browser_profile: BrowserProfileParams;
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

const MUTATIONS: ReadonlySet<string> = new Set<MutationMethod>([
  "browser_open",
  "browser_act",
  "browser_handoff",
  "browser_credentials",
  "browser_commit",
  "browser_developer",
]);

/** browser_profile operations that change the profile and therefore carry an idempotency key. */
export const PROFILE_WRITE_OPERATIONS: ReadonlySet<string> = new Set<BrowserProfileWriteOperation>([
  "bookmarks_update",
  "bookmarks_create",
  "bookmarks_move",
  "bookmarks_remove",
  "sessions_restore",
  "downloads_cancel",
  "downloads_pause",
  "downloads_resume",
]);

/**
 * True when a request must carry an idempotency key: every method-level mutation, plus
 * browser_profile write operations. browser_profile reads must be sent without a key.
 */
export function requiresIdempotencyKey(method: string, params: unknown): boolean {
  if (MUTATIONS.has(method)) return true;
  if (method !== "browser_profile") return false;
  if (typeof params !== "object" || params === null || !("operation" in params)) return false;
  const operation = params.operation;
  return typeof operation === "string" && PROFILE_WRITE_OPERATIONS.has(operation);
}

function longOperationTimeoutMs(
  method: RpcMethod,
  params: MethodParams[RpcMethod],
): number | undefined {
  let defaultTimeoutMs: number;
  if (method === "browser_wait") {
    defaultTimeoutMs = DEFAULT_BROWSER_WAIT_TIMEOUT_MS;
  } else if (
    method === "browser_handoff"
    && "operation" in params
    && params.operation === "request"
  ) {
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
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Timed out after ${timeoutMs} ms connecting to AgentTab at ${endpoint}`);
    }
    let handshakeWritten = false;
    let activeSocket: Socket | undefined;
    try {
      return await new Promise<NegotiatedConnection>((resolve, reject) => {
        const socket = createConnection(endpoint);
        activeSocket = socket;
        const decoder = new FrameDecoder();
        const timer = setTimeout(() => {
          cleanup();
          socket.destroy();
          reject(new Error(`Timed out after ${timeoutMs} ms connecting to AgentTab at ${endpoint}`));
        }, remainingMs);
        const cleanup = () => {
          clearTimeout(timer);
          socket.off("error", onError);
          socket.off("close", onClose);
          socket.off("data", onData);
          socket.off("connect", onConnect);
        };
        const fail = (error: Error) => {
          cleanup();
          socket.destroy();
          reject(error);
        };
        const onError = (error: Error) => fail(error);
        const onClose = () => fail(new Error("AgentTab closed during connection negotiation"));
        const onData = (chunk: Buffer) => {
          try {
            for (const value of decoder.push(chunk)) {
              if (!isConnectionAck(value)) throw new Error("AgentTab sent a response before connection negotiation completed");
              cleanup();
              resolve({ socket, decoder, connected: value });
              return;
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        };
        const onConnect = () => {
          handshakeWritten = true;
          socket.write(encodeFrame({
            protocol: RPC_PROTOCOL,
            version: RPC_VERSION,
            kind: "connect",
            ...(conversationId ? { conversation_id: conversationId } : {}),
            ...(resumeCapability ? { resume_capability: resumeCapability } : {}),
          }));
        };
        socket.once("error", onError);
        socket.once("close", onClose);
        socket.on("data", onData);
        socket.once("connect", onConnect);
      });
    } catch (error) {
      if (activeSocket) {
        activeSocket.destroy();
      }
      // Retry ONLY pre-connect transport failure before the handshake payload is written.
      // Once handshake write is dispatched, an ambiguous server ACK must never replay.
      const isTransient = !handshakeWritten && isRecord(error) && (
        error.code === "ECONNREFUSED" ||
        error.code === "ENOENT"
      );
      if (isTransient && deadline - Date.now() > 0) {
        const delay = Math.min(50, Math.max(0, deadline - Date.now()));
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        if (deadline - Date.now() > 0) {
          continue;
        }
      }
      throw error;
    }
  }
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
    const idempotencyKey = requiresIdempotencyKey(method, params)
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

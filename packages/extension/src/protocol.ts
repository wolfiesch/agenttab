import { hasOnlyKeys, isBoundedString, isIntegerInRange, isRecord } from "./type-guards";

export const NATIVE_PROTOCOL = "agenttab.native";
export const PROTOCOL_VERSION = 1;
export const SNAPSHOT_TEXT_MAX_BYTES = 1_000_000;
export const SCREENSHOT_MAX_BYTES = 750_000;
export const SCREENSHOT_MAX_DIMENSION = 16_384;

export type NativeMethod =
  | "browser_open"
  | "browser_snapshot"
  | "browser_act"
  | "browser_wait"
  | "browser_tabs"
  | "browser_handoff"
  | "browser_commit"
  | "browser_developer"
  | "commit_review_bind"
  | "commit_review_abandon";

const CORE_METHODS: Record<NativeMethod, true> = {
  browser_open: true,
  browser_snapshot: true,
  browser_act: true,
  browser_wait: true,
  browser_tabs: true,
  browser_handoff: true,
  browser_commit: true,
  browser_developer: true,
  commit_review_bind: true,
  commit_review_abandon: true,
};

const NATIVE_EVENTS: Record<NativeEventName, true> = {
  inventory: true,
  ownership_revoked: true,
  tab_removed: true,
  group_membership_changed: true,
  pause_changed: true,
  handoff_changed: true,
  commit_expired: true,
  commit_abandoned: true,
  popup_commit_approved: true,
  popup_commit_abandoned: true,
  extension_disconnected: true,
};

export type NativeEventName =
  | "inventory"
  | "ownership_revoked"
  | "tab_removed"
  | "group_membership_changed"
  | "pause_changed"
  | "handoff_changed"
  | "commit_expired"
  | "commit_abandoned"
  | "popup_commit_approved"
  | "popup_commit_abandoned"
  | "extension_disconnected";

export type Outcome =
  | "completed"
  | "not_started"
  | "unknown"
  | "needs_user"
  | "commit_required";

export interface NativeOriginPolicy {
  tab_id: number;
  allowed_origins: string[];
  denied_origins: string[];
}

export interface NativeCommand {
  protocol: typeof NATIVE_PROTOCOL;
  version: typeof PROTOCOL_VERSION;
  kind: "command";
  request_id: string;
  connection_id: string;
  task_id: string;
  method: NativeMethod;
  params: Record<string, unknown>;
  origin_policy?: NativeOriginPolicy;
}

export interface NativeCloseTask {
  protocol: typeof NATIVE_PROTOCOL;
  version: typeof PROTOCOL_VERSION;
  kind: "close_task";
  request_id: string;
  task_id: string;
}

export type NativeDispatchCommand = NativeCommand | NativeCloseTask;

export interface NativeEventAck {
  protocol: typeof NATIVE_PROTOCOL;
  version: typeof PROTOCOL_VERSION;
  kind: "event_ack";
  event: "handoff_changed" | "popup_commit_approved" | "popup_commit_abandoned";
  event_id: string;
  outcome?: Outcome;
  result?: Record<string, unknown>;
  error?: RpcError;
}

export interface NativeReady {
  protocol: typeof NATIVE_PROTOCOL;
  version: typeof PROTOCOL_VERSION;
  kind: "ready";
  host_version: string;
  state: "ready" | "paused";
  discard_staged_tokens?: string[];
}

export type NativeInboundMessage = NativeDispatchCommand | NativeReady | NativeEventAck;
export interface RpcError {
  code: string;
  message: string;
  recovery?: string;
  details?: Record<string, unknown>;
}

export interface StagedDialog {
  generation: number;
  fingerprint: string;
}

export interface StagedCommit {
  native_token: string;
  task_id: string;
  tab_id: number;
  page_revision: number;
  effect: string;
  fingerprint: string;
  expires_at_ms: number;
  review_handle?: string;
  approved?: boolean;
  action: Record<string, unknown>;
  preview: Record<string, unknown>;
  dialog?: StagedDialog;
}

export type PublicStagedCommit = Omit<StagedCommit, "action" | "preview" | "dialog">;

export interface NativeResponse {
  protocol: typeof NATIVE_PROTOCOL;
  version: typeof PROTOCOL_VERSION;
  kind: "response";
  request_id: string;
  outcome: Outcome;
  result?: unknown;
  error?: RpcError;
  staged?: PublicStagedCommit;
}

export interface NativeTab {
  tab_id: number;
  window_id: number;
  group_id: number;
  url: string;
  page_revision: number;
  task_id?: string | null;
}

export type NativeHandoff =
  | { active: false }
  | { active: true; task_id: string; tab_id: number; started_at_ms: number };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const URL_PATTERN = /^(https?:\/\/|about:)[^\s]+$/;

function commandError(message: string): never {
  throw Object.assign(new Error(message), { code: "invalid_request" });
}

function assertExactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  message = "parameters",
): Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, required, optional)) {
    commandError(`${message} contain missing or unknown fields`);
  }
  return value;
}

function assertUuid(value: unknown, field: string): string {
  if (!isBoundedString(value, 1, 128) || !UUID_PATTERN.test(value)) {
    commandError(`${field} must be a UUID`);
  }
  return value;
}

function assertTabId(value: unknown, field = "tab_id"): number {
  if (!isIntegerInRange(value, 0)) commandError(`${field} must be a non-negative integer`);
  return value;
}

function assertOriginPatterns(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    commandError(`${field} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

function assertOriginPolicy(value: unknown): NativeOriginPolicy {
  const policy = assertExactObject(
    value,
    ["tab_id", "allowed_origins", "denied_origins"],
    [],
    "origin_policy",
  );
  return {
    tab_id: assertTabId(policy.tab_id, "origin_policy.tab_id"),
    allowed_origins: assertOriginPatterns(policy.allowed_origins, "origin_policy.allowed_origins"),
    denied_origins: assertOriginPatterns(policy.denied_origins, "origin_policy.denied_origins"),
  };
}

function assertRevision(value: unknown): number {
  if (!isIntegerInRange(value, 0)) {
    commandError("expected_page_revision must be a non-negative integer");
  }
  return value;
}

function assertBoundedString(value: unknown, field: string, minimum: number, maximum: number): string {
  if (!isBoundedString(value, minimum, maximum)) {
    commandError(`${field} must be a string between ${minimum} and ${maximum} characters`);
  }
  return value;
}

function assertUrl(value: unknown, field = "url"): string {
  const url = assertBoundedString(value, field, 1, 16_384);
  if (!URL_PATTERN.test(url)) commandError(`${field} must be an http(s) or about URL without whitespace`);
  return url;
}

function assertAction(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.kind !== "string") {
    commandError("Each browser action requires a kind");
  }
  const action = value;
  switch (action.kind) {
    case "click":
      assertExactObject(action, ["kind", "ref"], [], "click action");
      assertBoundedString(action.ref, "click.ref", 1, 256);
      return action;
    case "type":
    case "fill":
      assertExactObject(action, ["kind", "ref", "text"], [], `${action.kind} action`);
      assertBoundedString(action.ref, `${action.kind}.ref`, 1, 256);
      assertBoundedString(action.text, `${action.kind}.text`, 0, 1_048_576);
      return action;
    case "select":
      assertExactObject(action, ["kind", "ref", "value"], [], "select action");
      assertBoundedString(action.ref, "select.ref", 1, 256);
      assertBoundedString(action.value, "select.value", 0, 65_536);
      return action;
    case "scroll":
      assertExactObject(action, ["kind", "delta_x", "delta_y"], ["ref"], "scroll action");
      if (action.ref !== undefined) assertBoundedString(action.ref, "scroll.ref", 1, 256);
      if (!isIntegerInRange(action.delta_x, -100_000, 100_000) || !isIntegerInRange(action.delta_y, -100_000, 100_000)) {
        commandError("scroll deltas must be integers between -100000 and 100000");
      }
      return action;
    case "drag":
      assertExactObject(action, ["kind", "ref", "target_ref"], [], "drag action");
      assertBoundedString(action.ref, "drag.ref", 1, 256);
      assertBoundedString(action.target_ref, "drag.target_ref", 1, 256);
      return action;
    case "navigate":
      assertExactObject(action, ["kind", "url"], [], "navigate action");
      assertUrl(action.url);
      return action;
    case "go_back":
    case "go_forward":
    case "close":
      assertExactObject(action, ["kind"], [], `${action.kind} action`);
      return action;
    case "reload":
      assertExactObject(action, ["kind"], ["bypass_cache"], "reload action");
      if (action.bypass_cache !== undefined && typeof action.bypass_cache !== "boolean") {
        commandError("reload.bypass_cache must be a boolean");
      }
      return action;
    case "dialog":
      assertExactObject(action, ["kind", "decision"], [], "dialog action");
      if (action.decision !== "accept" && action.decision !== "dismiss") {
        commandError("dialog.decision must be accept or dismiss");
      }
      return action;
    case "upload_file":
      assertExactObject(action, ["kind", "ref", "files"], [], "upload_file action");
      assertBoundedString(action.ref, "upload_file.ref", 1, 256);
      if (!Array.isArray(action.files) || action.files.length === 0 || action.files.length > 32 ||
        !action.files.every((file) => isBoundedString(file, 1, 16_384))) {
        commandError("upload_file.files must contain between 1 and 32 file paths");
      }
      return action;
    case "set_viewport":
      commandError("set_viewport is unavailable in Standard mode");
    case "press":
      commandError("press is unavailable in Standard mode because it has no identifiable target");
    default:
      commandError(`Unsupported standard action: ${action.kind}`);
  }
}

function assertSnapshotParams(value: unknown): Record<string, unknown> {
  const params = assertExactObject(
    value,
    ["tab_id", "mode"],
    [
      "root_ref",
      "max_depth",
      "max_nodes",
      "selector",
      "max_bytes",
      "full_page",
      "format",
      "quality",
      "max_width",
      "max_height",
    ],
    "browser_snapshot parameters",
  );
  assertTabId(params.tab_id);
  if (params.mode === "accessibility") {
    assertExactObject(params, ["tab_id", "mode"], ["root_ref", "max_depth", "max_nodes"], "accessibility snapshot parameters");
    if (params.root_ref !== undefined) assertBoundedString(params.root_ref, "root_ref", 1, 256);
    if (params.max_depth !== undefined && !isIntegerInRange(params.max_depth, 1, 200)) commandError("max_depth must be between 1 and 200");
    if (params.max_nodes !== undefined && !isIntegerInRange(params.max_nodes, 1, 5_000)) commandError("max_nodes must be between 1 and 5000");
    return params;
  }
  if (params.mode === "text" || params.mode === "html") {
    assertExactObject(params, ["tab_id", "mode"], ["selector", "max_bytes"], "text or html snapshot parameters");
    if (params.selector !== undefined) assertBoundedString(params.selector, "selector", 1, 65_536);
    if (params.max_bytes !== undefined && !isIntegerInRange(params.max_bytes, 1, SNAPSHOT_TEXT_MAX_BYTES)) {
      commandError(`max_bytes must be between 1 and ${SNAPSHOT_TEXT_MAX_BYTES}`);
    }
    return params;
  }
  if (params.mode === "screenshot") {
    assertExactObject(
      params,
      ["tab_id", "mode"],
      ["selector", "full_page", "format", "quality", "max_width", "max_height", "max_bytes"],
      "screenshot parameters",
    );
    if (params.selector !== undefined) assertBoundedString(params.selector, "selector", 1, 65_536);
    if (params.full_page !== undefined && typeof params.full_page !== "boolean") commandError("full_page must be a boolean");
    if (params.selector !== undefined && params.full_page === true) commandError("screenshot cannot combine selector and full_page");
    if (
      params.format !== undefined &&
      params.format !== "png" &&
      params.format !== "jpeg" &&
      params.format !== "webp"
    ) {
      commandError("format must be png, jpeg, or webp");
    }
    if (params.quality !== undefined) {
      if (!isIntegerInRange(params.quality, 0, 100)) commandError("quality must be between 0 and 100");
      if (params.format !== "jpeg" && params.format !== "webp") {
        commandError("quality requires format jpeg or webp");
      }
    }
    for (const field of ["max_width", "max_height"] as const) {
      if (params[field] !== undefined && !isIntegerInRange(params[field], 1, SCREENSHOT_MAX_DIMENSION)) {
        commandError(`${field} must be between 1 and ${SCREENSHOT_MAX_DIMENSION}`);
      }
    }
    if (params.max_bytes !== undefined && !isIntegerInRange(params.max_bytes, 1, SCREENSHOT_MAX_BYTES)) {
      commandError(`max_bytes must be between 1 and ${SCREENSHOT_MAX_BYTES}`);
    }
    return params;
  }
  commandError("Unsupported snapshot mode");
}

function assertWaitParams(value: unknown): Record<string, unknown> {
  const params = assertExactObject(value, ["tab_id", "condition"], ["timeout_ms"], "browser_wait parameters");
  assertTabId(params.tab_id);
  if (params.timeout_ms !== undefined && !isIntegerInRange(params.timeout_ms, 1, 120_000)) {
    commandError("timeout_ms must be between 1 and 120000");
  }
  if (!isRecord(params.condition) || typeof params.condition.kind !== "string") {
    commandError("browser_wait requires a condition");
  }
  const condition = params.condition;
  if (condition.kind === "load" || condition.kind === "network_idle" || condition.kind === "download") {
    assertExactObject(condition, ["kind"], [], "wait condition");
    return params;
  }
  if (condition.kind === "url" || condition.kind === "text" || condition.kind === "selector") {
    assertExactObject(condition, ["kind", "value"], [], "wait condition");
    assertBoundedString(condition.value, "condition.value", 1, 65_536);
    return params;
  }
  commandError(`Unsupported wait condition: ${condition.kind}`);
}

function assertHandoffParams(value: unknown): Record<string, unknown> {
  const params = assertExactObject(value, ["tab_id", "expected_page_revision", "prompt", "completion"], ["timeout_ms"], "browser_handoff parameters");
  assertTabId(params.tab_id);
  assertRevision(params.expected_page_revision);
  assertBoundedString(params.prompt, "prompt", 1, 2_000);
  if (params.timeout_ms !== undefined && !isIntegerInRange(params.timeout_ms, 1_000, 900_000)) {
    commandError("timeout_ms must be between 1000 and 900000");
  }
  if (!isRecord(params.completion) || typeof params.completion.kind !== "string") {
    commandError("browser_handoff requires a completion condition");
  }
  if (params.completion.kind === "navigation" || params.completion.kind === "manual_done") {
    assertExactObject(params.completion, ["kind"], [], "handoff completion");
  } else if (params.completion.kind === "url" || params.completion.kind === "selector") {
    assertExactObject(params.completion, ["kind", "value"], [], "handoff completion");
    assertBoundedString(params.completion.value, "completion.value", 1, 65_536);
  } else {
    commandError(`Unsupported handoff completion: ${params.completion.kind}`);
  }
  return params;
}

function assertDeveloperParams(value: unknown): Record<string, unknown> {
  const params = assertExactObject(value, ["action", "params"], [], "browser_developer parameters");
  assertBoundedString(params.action, "action", 3, 128);
  if (!isRecord(params.params)) commandError("browser_developer.params must be an object");
  return params;
}

function assertCommitReviewParams(
  value: unknown,
  method: "commit_review_bind" | "commit_review_abandon",
): Record<string, unknown> {
  const params = method === "commit_review_bind"
    ? assertExactObject(value, ["native_token", "review_handle", "tab_id"], [], `${method} parameters`)
    : assertExactObject(value, ["native_token", "tab_id"], [], `${method} parameters`);
  assertBoundedString(params.native_token, "native_token", 16, 256);
  assertTabId(params.tab_id);
  if (method === "commit_review_bind") {
    assertBoundedString(params.review_handle, "review_handle", 16, 256);
  }
  return params;
}

function validateParams(method: NativeMethod, value: unknown): Record<string, unknown> {
  switch (method) {
    case "browser_open": {
      const params = assertExactObject(value, ["mode"], ["url", "background", "placement"], "browser_open parameters");
      if (params.mode === "create") {
        assertExactObject(params, ["mode"], ["url", "background", "placement"], "browser_open create parameters");
        if (params.url !== undefined) assertUrl(params.url);
        if (params.background !== undefined && typeof params.background !== "boolean") commandError("background must be a boolean");
        if (params.placement !== undefined && params.placement !== "task" && params.placement !== "new_window") {
          commandError("placement must be task or new_window");
        }
        if (params.placement === "new_window" && params.background === false) {
          commandError("background must be true when placement is new_window");
        }
        return params;
      }
      if (params.mode === "adopt_active") {
        assertExactObject(params, ["mode"], [], "browser_open adopt_active parameters");
        return params;
      }
      commandError("browser_open.mode must be create or adopt_active");
    }
    case "browser_snapshot":
      return assertSnapshotParams(value);
    case "browser_act": {
      const params = assertExactObject(value, ["tab_id", "expected_page_revision", "actions"], [], "browser_act parameters");
      assertTabId(params.tab_id);
      assertRevision(params.expected_page_revision);
      if (!Array.isArray(params.actions) || params.actions.length === 0 || params.actions.length > 64) {
        commandError("actions must contain between 1 and 64 operations");
      }
      for (const action of params.actions) assertAction(action);
      return params;
    }
    case "browser_wait":
      return assertWaitParams(value);
    case "browser_tabs":
      return assertExactObject(value, [], [], "browser_tabs parameters");
    case "browser_handoff":
      return assertHandoffParams(value);
    case "browser_commit": {
      const params = assertExactObject(value, ["native_token"], [], "browser_commit parameters");
      assertBoundedString(params.native_token, "native_token", 16, 256);
      return params;
    }
    case "browser_developer":
      return assertDeveloperParams(value);
    case "commit_review_bind":
    case "commit_review_abandon":
      return assertCommitReviewParams(value, method);
  }
}

export function parseCommand(value: unknown): NativeCommand {
  if (!isRecord(value)) throw new Error("native command must be an object");
  if (!hasOnlyKeys(
    value,
    ["protocol", "version", "kind", "request_id", "connection_id", "task_id", "method", "params"],
    ["origin_policy"],
  )) {
    throw new Error("native command contains unknown fields");
  }
  if (value.protocol !== NATIVE_PROTOCOL || value.version !== PROTOCOL_VERSION || value.kind !== "command") {
    throw new Error("native command protocol or version mismatch");
  }
  if (!isBoundedString(value.request_id, 1, 128) || !isBoundedString(value.connection_id, 1, 128) ||
    !isBoundedString(value.task_id, 1, 128) || !UUID_PATTERN.test(value.request_id) ||
    !UUID_PATTERN.test(value.connection_id) || !UUID_PATTERN.test(value.task_id)) {
    throw new Error("native command IDs must be UUIDs");
  }
  if (typeof value.method !== "string" || !Object.hasOwn(CORE_METHODS, value.method)) {
    throw new Error("native command method is unsupported");
  }
  const originPolicy = value.origin_policy === undefined
    ? undefined
    : assertOriginPolicy(value.origin_policy);
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "command",
    request_id: value.request_id,
    connection_id: value.connection_id,
    task_id: value.task_id,
    method: value.method as NativeMethod,
    params: validateParams(value.method as NativeMethod, value.params),
    ...(originPolicy === undefined ? {} : { origin_policy: originPolicy }),
  };
}

function parseCloseTask(value: unknown): NativeCloseTask {
  if (!isRecord(value) || !hasOnlyKeys(value, ["protocol", "version", "kind", "request_id", "task_id"])) {
    commandError("native close_task contains missing or unknown fields");
  }
  if (value.protocol !== NATIVE_PROTOCOL || value.version !== PROTOCOL_VERSION || value.kind !== "close_task") {
    commandError("native close_task protocol or version mismatch");
  }
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "close_task",
    request_id: assertUuid(value.request_id, "request_id"),
    task_id: assertUuid(value.task_id, "task_id"),
  };
}

export function parseInboundNativeMessage(value: unknown): NativeInboundMessage {
  if (!isRecord(value) || value.protocol !== NATIVE_PROTOCOL || value.version !== PROTOCOL_VERSION || typeof value.kind !== "string") {
    throw new Error("native message protocol or version mismatch");
  }
  if (value.kind === "command") return parseCommand(value);
  if (value.kind === "close_task") return parseCloseTask(value);
  if (value.kind === "event_ack") {
    if (
      !hasOnlyKeys(
        value,
        ["protocol", "version", "kind", "event", "event_id"],
        ["outcome", "result", "error"],
      ) ||
      (value.event !== "handoff_changed" &&
        value.event !== "popup_commit_approved" &&
        value.event !== "popup_commit_abandoned") ||
      !isBoundedString(value.event_id, 16, 256)
    ) {
      throw new Error("native event acknowledgement is invalid");
    }
    if (value.event === "handoff_changed") {
      if (value.outcome !== undefined || value.result !== undefined || value.error !== undefined) {
        throw new Error("handoff acknowledgement must not contain a result");
      }
      return {
        protocol: NATIVE_PROTOCOL,
        version: PROTOCOL_VERSION,
        kind: "event_ack",
        event: "handoff_changed",
        event_id: value.event_id,
      };
    }
    if (
      (value.outcome !== "completed" && value.outcome !== "not_started" && value.outcome !== "unknown") ||
      (value.outcome === "completed"
        ? !isRecord(value.result) || value.error !== undefined
        : !isRecord(value.error) || value.result !== undefined) ||
      (isRecord(value.error) &&
        (!isBoundedString(value.error.code, 1, 128) || !isBoundedString(value.error.message, 1, 2_000)))
    ) {
      throw new Error("popup commit acknowledgement is invalid");
    }
    return {
      protocol: NATIVE_PROTOCOL,
      version: PROTOCOL_VERSION,
      kind: "event_ack",
      event: value.event,
      event_id: value.event_id,
      outcome: value.outcome,
      ...(isRecord(value.result) ? { result: value.result } : {}),
      ...(isRecord(value.error)
        ? {
          error: {
            code: value.error.code as string,
            message: value.error.message as string,
            ...(typeof value.error.recovery === "string" ? { recovery: value.error.recovery } : {}),
            ...(isRecord(value.error.details) ? { details: value.error.details } : {}),
          },
        }
        : {}),
    };
  }
  if (
    value.kind !== "ready" ||
    !hasOnlyKeys(value, ["protocol", "version", "kind", "host_version", "state"], ["discard_staged_tokens"]) ||
    !isBoundedString(value.host_version, 1, 128) ||
    (value.state !== "ready" && value.state !== "paused") ||
    (value.discard_staged_tokens !== undefined &&
      (!Array.isArray(value.discard_staged_tokens) ||
        !value.discard_staged_tokens.every((token) => isBoundedString(token, 16, 256))))
  ) {
    throw new Error("native ready message is invalid");
  }
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "ready",
    host_version: value.host_version,
    state: value.state,
    ...(value.discard_staged_tokens === undefined
      ? {}
      : { discard_staged_tokens: [...value.discard_staged_tokens] as string[] }),
  };
}
export function completed(requestId: string, result: unknown): NativeResponse {
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "response",
    request_id: requestId,
    outcome: "completed",
    result,
  };
}

export function needsUser(requestId: string, result: unknown): NativeResponse {
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "response",
    request_id: requestId,
    outcome: "needs_user",
    result,
  };
}

export function commitRequired(
  requestId: string,
  result: unknown,
  staged: StagedCommit,
): NativeResponse {
  const { action: _action, preview: _preview, dialog: _dialog, ...publicStaged } = staged;
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "response",
    request_id: requestId,
    outcome: "commit_required",
    result,
    staged: publicStaged,
  };
}

export function failed(
  requestId: string,
  code: string,
  message: string,
  outcome: Outcome = "not_started",
  recovery?: string,
  details?: Record<string, unknown>,
): NativeResponse {
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "response",
    request_id: requestId,
    outcome,
    error: { code, message, ...(recovery ? { recovery } : {}), ...(details ? { details } : {}) },
  };
}

export function nativeHello(
  extensionVersion: string,
  inventory: NativeTab[],
  paused: boolean,
  handoff: NativeHandoff,
  stagedCommits: PublicStagedCommit[],
) {
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "hello" as const,
    extension_version: extensionVersion,
    inventory,
    paused,
    handoff,
    staged_commits: stagedCommits,
  };
}

export function nativeEvent(event: string, payload: Record<string, unknown>, eventId?: string) {
  if (!Object.hasOwn(NATIVE_EVENTS, event)) throw new Error(`Unsupported native event: ${event}`);
  switch (event as NativeEventName) {
    case "inventory": {
      const eventPayload = assertExactObject(payload, ["inventory"], [], "inventory event payload");
      if (!Array.isArray(eventPayload.inventory)) commandError("inventory event must contain an inventory array");
      for (const tab of eventPayload.inventory) assertNativeTab(tab);
      break;
    }
    case "ownership_revoked":
    case "tab_removed":
    case "group_membership_changed": {
      const eventPayload = assertExactObject(payload, ["task_id", "tab_count"], [], "ownership event payload");
      assertUuid(eventPayload.task_id, "task_id");
      if (!isIntegerInRange(eventPayload.tab_count, 0)) commandError("tab_count must be a non-negative integer");
      break;
    }
    case "pause_changed": {
      const eventPayload = assertExactObject(payload, ["paused"], [], "pause event payload");
      if (typeof eventPayload.paused !== "boolean") commandError("pause event paused must be a boolean");
      break;
    }
    case "handoff_changed":
      assertNativeHandoff(payload);
      break;
    case "commit_expired":
    case "commit_abandoned": {
      const eventPayload = assertExactObject(payload, ["native_token"], [], "commit event payload");
      assertBoundedString(eventPayload.native_token, "native_token", 16, 256);
      break;
    }
    case "popup_commit_approved":
    case "popup_commit_abandoned": {
      const eventPayload = assertExactObject(
        payload,
        ["review_handle", "task_id", "tab_id"],
        [],
        "popup commit event payload",
      );
      assertBoundedString(eventPayload.review_handle, "review_handle", 16, 256);
      assertUuid(eventPayload.task_id, "task_id");
      assertTabId(eventPayload.tab_id);
      break;
    }
    case "extension_disconnected": {
      const eventPayload = assertExactObject(payload, ["reason"], [], "disconnect event payload");
      assertBoundedString(eventPayload.reason, "reason", 1, 2_000);
      break;
    }
  }
  if (eventId !== undefined) assertBoundedString(eventId, "event_id", 16, 256);
  if (
    (event === "popup_commit_approved" || event === "popup_commit_abandoned") &&
    eventId === undefined
  ) {
    commandError("popup commit events require an event_id");
  }
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "event" as const,
    event,
    payload,
    ...(eventId ? { event_id: eventId } : {}),
  };
}

function assertNativeTab(value: unknown): asserts value is NativeTab {
  const tab = assertExactObject(
    value,
    ["tab_id", "window_id", "group_id", "url", "page_revision"],
    ["task_id"],
    "native tab",
  );
  assertTabId(tab.tab_id);
  if (!isIntegerInRange(tab.window_id, 0)) commandError("window_id must be a non-negative integer");
  if (!isIntegerInRange(tab.group_id, -1)) commandError("group_id must be at least -1");
  assertBoundedString(tab.url, "url", 0, 16_384);
  if (!isIntegerInRange(tab.page_revision, 0)) commandError("page_revision must be a non-negative integer");
  if (tab.task_id !== undefined && tab.task_id !== null) {
    assertUuid(tab.task_id, "task_id");
  }
}

function assertNativeHandoff(value: unknown): asserts value is NativeHandoff {
  if (!isRecord(value) || typeof value.active !== "boolean") commandError("handoff event must specify active");
  if (!value.active) {
    assertExactObject(value, ["active"], [], "inactive handoff payload");
    return;
  }
  const handoff = assertExactObject(value, ["active", "task_id", "tab_id", "started_at_ms"], [], "active handoff payload");
  assertUuid(handoff.task_id, "task_id");
  assertTabId(handoff.tab_id);
  if (!isIntegerInRange(handoff.started_at_ms, 0)) commandError("started_at_ms must be a non-negative integer");
}

export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** UUIDv7 for host-side popup-approval idempotency records. */
export function randomUuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export async function sha256Hex(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

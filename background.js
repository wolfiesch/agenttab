// src/type-guards.ts
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyKeys(value, required, optional = []) {
  const allowed = {};
  for (const key of required)
    allowed[key] = true;
  for (const key of optional)
    allowed[key] = true;
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed[key]);
}
function isBoundedString(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}
function isIntegerInRange(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

// src/protocol.ts
var NATIVE_PROTOCOL = "agenttab.native";
var PROTOCOL_VERSION = 1;
var CORE_METHODS = {
  browser_open: true,
  browser_snapshot: true,
  browser_act: true,
  browser_wait: true,
  browser_tabs: true,
  browser_handoff: true,
  browser_commit: true,
  browser_developer: true,
  commit_review_bind: true,
  commit_review_abandon: true
};
var NATIVE_EVENTS = {
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
  extension_disconnected: true
};
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var URL_PATTERN = /^(https?:\/\/|about:)[^\s]+$/;
function commandError(message) {
  throw Object.assign(new Error(message), { code: "invalid_request" });
}
function assertExactObject(value, required, optional = [], message = "parameters") {
  if (!isRecord(value) || !hasOnlyKeys(value, required, optional)) {
    commandError(`${message} contain missing or unknown fields`);
  }
  return value;
}
function assertUuid(value, field) {
  if (!isBoundedString(value, 1, 128) || !UUID_PATTERN.test(value)) {
    commandError(`${field} must be a UUID`);
  }
  return value;
}
function assertTabId(value, field = "tab_id") {
  if (!isIntegerInRange(value, 0))
    commandError(`${field} must be a non-negative integer`);
  return value;
}
function assertOriginPatterns(value, field) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    commandError(`${field} must be an array of non-empty strings`);
  }
  return [...value];
}
function assertOriginPolicy(value) {
  const policy = assertExactObject(value, ["tab_id", "allowed_origins", "denied_origins"], [], "origin_policy");
  return {
    tab_id: assertTabId(policy.tab_id, "origin_policy.tab_id"),
    allowed_origins: assertOriginPatterns(policy.allowed_origins, "origin_policy.allowed_origins"),
    denied_origins: assertOriginPatterns(policy.denied_origins, "origin_policy.denied_origins")
  };
}
function assertRevision(value) {
  if (!isIntegerInRange(value, 0)) {
    commandError("expected_page_revision must be a non-negative integer");
  }
  return value;
}
function assertBoundedString(value, field, minimum, maximum) {
  if (!isBoundedString(value, minimum, maximum)) {
    commandError(`${field} must be a string between ${minimum} and ${maximum} characters`);
  }
  return value;
}
function assertUrl(value, field = "url") {
  const url = assertBoundedString(value, field, 1, 16384);
  if (!URL_PATTERN.test(url))
    commandError(`${field} must be an http(s) or about URL without whitespace`);
  return url;
}
function assertAction(value) {
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
      assertBoundedString(action.text, `${action.kind}.text`, 0, 1048576);
      return action;
    case "select":
      assertExactObject(action, ["kind", "ref", "value"], [], "select action");
      assertBoundedString(action.ref, "select.ref", 1, 256);
      assertBoundedString(action.value, "select.value", 0, 65536);
      return action;
    case "scroll":
      assertExactObject(action, ["kind", "delta_x", "delta_y"], ["ref"], "scroll action");
      if (action.ref !== undefined)
        assertBoundedString(action.ref, "scroll.ref", 1, 256);
      if (!isIntegerInRange(action.delta_x, -1e5, 1e5) || !isIntegerInRange(action.delta_y, -1e5, 1e5)) {
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
      if (!Array.isArray(action.files) || action.files.length === 0 || action.files.length > 32 || !action.files.every((file) => isBoundedString(file, 1, 16384))) {
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
function assertSnapshotParams(value) {
  const params = assertExactObject(value, ["tab_id", "mode"], ["root_ref", "max_depth", "max_nodes", "selector", "max_bytes", "full_page"], "browser_snapshot parameters");
  assertTabId(params.tab_id);
  if (params.mode === "accessibility") {
    assertExactObject(params, ["tab_id", "mode"], ["root_ref", "max_depth", "max_nodes"], "accessibility snapshot parameters");
    if (params.root_ref !== undefined)
      assertBoundedString(params.root_ref, "root_ref", 1, 256);
    if (params.max_depth !== undefined && !isIntegerInRange(params.max_depth, 1, 200))
      commandError("max_depth must be between 1 and 200");
    if (params.max_nodes !== undefined && !isIntegerInRange(params.max_nodes, 1, 5000))
      commandError("max_nodes must be between 1 and 5000");
    return params;
  }
  if (params.mode === "text" || params.mode === "html") {
    assertExactObject(params, ["tab_id", "mode"], ["selector", "max_bytes"], "text or html snapshot parameters");
    if (params.selector !== undefined)
      assertBoundedString(params.selector, "selector", 1, 65536);
    if (params.max_bytes !== undefined && !isIntegerInRange(params.max_bytes, 1, 1048576))
      commandError("max_bytes must be between 1 and 1048576");
    return params;
  }
  if (params.mode === "screenshot") {
    assertExactObject(params, ["tab_id", "mode"], ["selector", "full_page"], "screenshot parameters");
    if (params.selector !== undefined)
      assertBoundedString(params.selector, "selector", 1, 65536);
    if (params.full_page !== undefined && typeof params.full_page !== "boolean")
      commandError("full_page must be a boolean");
    if (params.selector !== undefined && params.full_page === true)
      commandError("screenshot cannot combine selector and full_page");
    return params;
  }
  commandError("Unsupported snapshot mode");
}
function assertWaitParams(value) {
  const params = assertExactObject(value, ["tab_id", "condition"], ["timeout_ms"], "browser_wait parameters");
  assertTabId(params.tab_id);
  if (params.timeout_ms !== undefined && !isIntegerInRange(params.timeout_ms, 1, 120000)) {
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
    assertBoundedString(condition.value, "condition.value", 1, 65536);
    return params;
  }
  commandError(`Unsupported wait condition: ${condition.kind}`);
}
function assertHandoffParams(value) {
  const params = assertExactObject(value, ["tab_id", "expected_page_revision", "prompt", "completion"], ["timeout_ms"], "browser_handoff parameters");
  assertTabId(params.tab_id);
  assertRevision(params.expected_page_revision);
  assertBoundedString(params.prompt, "prompt", 1, 2000);
  if (params.timeout_ms !== undefined && !isIntegerInRange(params.timeout_ms, 1000, 900000)) {
    commandError("timeout_ms must be between 1000 and 900000");
  }
  if (!isRecord(params.completion) || typeof params.completion.kind !== "string") {
    commandError("browser_handoff requires a completion condition");
  }
  if (params.completion.kind === "navigation" || params.completion.kind === "manual_done") {
    assertExactObject(params.completion, ["kind"], [], "handoff completion");
  } else if (params.completion.kind === "url" || params.completion.kind === "selector") {
    assertExactObject(params.completion, ["kind", "value"], [], "handoff completion");
    assertBoundedString(params.completion.value, "completion.value", 1, 65536);
  } else {
    commandError(`Unsupported handoff completion: ${params.completion.kind}`);
  }
  return params;
}
function assertDeveloperParams(value) {
  const params = assertExactObject(value, ["action", "params"], [], "browser_developer parameters");
  assertBoundedString(params.action, "action", 3, 128);
  if (!isRecord(params.params))
    commandError("browser_developer.params must be an object");
  return params;
}
function assertCommitReviewParams(value, method) {
  const params = method === "commit_review_bind" ? assertExactObject(value, ["native_token", "review_handle", "tab_id"], [], `${method} parameters`) : assertExactObject(value, ["native_token", "tab_id"], [], `${method} parameters`);
  assertBoundedString(params.native_token, "native_token", 16, 256);
  assertTabId(params.tab_id);
  if (method === "commit_review_bind") {
    assertBoundedString(params.review_handle, "review_handle", 16, 256);
  }
  return params;
}
function validateParams(method, value) {
  switch (method) {
    case "browser_open": {
      const params = assertExactObject(value, ["mode"], ["url", "background", "placement"], "browser_open parameters");
      if (params.mode === "create") {
        assertExactObject(params, ["mode"], ["url", "background", "placement"], "browser_open create parameters");
        if (params.url !== undefined)
          assertUrl(params.url);
        if (params.background !== undefined && typeof params.background !== "boolean")
          commandError("background must be a boolean");
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
      for (const action of params.actions)
        assertAction(action);
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
function parseCommand(value) {
  if (!isRecord(value))
    throw new Error("native command must be an object");
  if (!hasOnlyKeys(value, ["protocol", "version", "kind", "request_id", "connection_id", "task_id", "method", "params"], ["origin_policy"])) {
    throw new Error("native command contains unknown fields");
  }
  if (value.protocol !== NATIVE_PROTOCOL || value.version !== PROTOCOL_VERSION || value.kind !== "command") {
    throw new Error("native command protocol or version mismatch");
  }
  if (!isBoundedString(value.request_id, 1, 128) || !isBoundedString(value.connection_id, 1, 128) || !isBoundedString(value.task_id, 1, 128) || !UUID_PATTERN.test(value.request_id) || !UUID_PATTERN.test(value.connection_id) || !UUID_PATTERN.test(value.task_id)) {
    throw new Error("native command IDs must be UUIDs");
  }
  if (typeof value.method !== "string" || !Object.hasOwn(CORE_METHODS, value.method)) {
    throw new Error("native command method is unsupported");
  }
  const originPolicy = value.origin_policy === undefined ? undefined : assertOriginPolicy(value.origin_policy);
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "command",
    request_id: value.request_id,
    connection_id: value.connection_id,
    task_id: value.task_id,
    method: value.method,
    params: validateParams(value.method, value.params),
    ...originPolicy === undefined ? {} : { origin_policy: originPolicy }
  };
}
function parseCloseTask(value) {
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
    task_id: assertUuid(value.task_id, "task_id")
  };
}
function parseInboundNativeMessage(value) {
  if (!isRecord(value) || value.protocol !== NATIVE_PROTOCOL || value.version !== PROTOCOL_VERSION || typeof value.kind !== "string") {
    throw new Error("native message protocol or version mismatch");
  }
  if (value.kind === "command")
    return parseCommand(value);
  if (value.kind === "close_task")
    return parseCloseTask(value);
  if (value.kind === "event_ack") {
    if (!hasOnlyKeys(value, ["protocol", "version", "kind", "event", "event_id"], ["outcome", "result", "error"]) || value.event !== "handoff_changed" && value.event !== "popup_commit_approved" && value.event !== "popup_commit_abandoned" || !isBoundedString(value.event_id, 16, 256)) {
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
        event_id: value.event_id
      };
    }
    if (value.outcome !== "completed" && value.outcome !== "not_started" && value.outcome !== "unknown" || (value.outcome === "completed" ? !isRecord(value.result) || value.error !== undefined : !isRecord(value.error) || value.result !== undefined) || isRecord(value.error) && (!isBoundedString(value.error.code, 1, 128) || !isBoundedString(value.error.message, 1, 2000))) {
      throw new Error("popup commit acknowledgement is invalid");
    }
    return {
      protocol: NATIVE_PROTOCOL,
      version: PROTOCOL_VERSION,
      kind: "event_ack",
      event: value.event,
      event_id: value.event_id,
      outcome: value.outcome,
      ...isRecord(value.result) ? { result: value.result } : {},
      ...isRecord(value.error) ? {
        error: {
          code: value.error.code,
          message: value.error.message,
          ...typeof value.error.recovery === "string" ? { recovery: value.error.recovery } : {},
          ...isRecord(value.error.details) ? { details: value.error.details } : {}
        }
      } : {}
    };
  }
  if (value.kind !== "ready" || !hasOnlyKeys(value, ["protocol", "version", "kind", "host_version", "state"], ["discard_staged_tokens"]) || !isBoundedString(value.host_version, 1, 128) || value.state !== "ready" && value.state !== "paused" || value.discard_staged_tokens !== undefined && (!Array.isArray(value.discard_staged_tokens) || !value.discard_staged_tokens.every((token) => isBoundedString(token, 16, 256)))) {
    throw new Error("native ready message is invalid");
  }
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "ready",
    host_version: value.host_version,
    state: value.state,
    ...value.discard_staged_tokens === undefined ? {} : { discard_staged_tokens: [...value.discard_staged_tokens] }
  };
}
function completed(requestId, result) {
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "response",
    request_id: requestId,
    outcome: "completed",
    result
  };
}
function needsUser(requestId, result) {
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "response",
    request_id: requestId,
    outcome: "needs_user",
    result
  };
}
function commitRequired(requestId, result, staged) {
  const { action: _action, preview: _preview, dialog: _dialog, ...publicStaged } = staged;
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "response",
    request_id: requestId,
    outcome: "commit_required",
    result,
    staged: publicStaged
  };
}
function failed(requestId, code, message, outcome = "not_started", recovery, details) {
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "response",
    request_id: requestId,
    outcome,
    error: { code, message, ...recovery ? { recovery } : {}, ...details ? { details } : {} }
  };
}
function nativeHello(extensionVersion, inventory, paused, handoff, stagedCommits) {
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "hello",
    extension_version: extensionVersion,
    inventory,
    paused,
    handoff,
    staged_commits: stagedCommits
  };
}
function nativeEvent(event, payload, eventId) {
  if (!Object.hasOwn(NATIVE_EVENTS, event))
    throw new Error(`Unsupported native event: ${event}`);
  switch (event) {
    case "inventory": {
      const eventPayload = assertExactObject(payload, ["inventory"], [], "inventory event payload");
      if (!Array.isArray(eventPayload.inventory))
        commandError("inventory event must contain an inventory array");
      for (const tab of eventPayload.inventory)
        assertNativeTab(tab);
      break;
    }
    case "ownership_revoked":
    case "tab_removed":
    case "group_membership_changed": {
      const eventPayload = assertExactObject(payload, ["task_id", "tab_count"], [], "ownership event payload");
      assertUuid(eventPayload.task_id, "task_id");
      if (!isIntegerInRange(eventPayload.tab_count, 0))
        commandError("tab_count must be a non-negative integer");
      break;
    }
    case "pause_changed": {
      const eventPayload = assertExactObject(payload, ["paused"], [], "pause event payload");
      if (typeof eventPayload.paused !== "boolean")
        commandError("pause event paused must be a boolean");
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
      const eventPayload = assertExactObject(payload, ["review_handle", "task_id", "tab_id"], [], "popup commit event payload");
      assertBoundedString(eventPayload.review_handle, "review_handle", 16, 256);
      assertUuid(eventPayload.task_id, "task_id");
      assertTabId(eventPayload.tab_id);
      break;
    }
    case "extension_disconnected": {
      const eventPayload = assertExactObject(payload, ["reason"], [], "disconnect event payload");
      assertBoundedString(eventPayload.reason, "reason", 1, 2000);
      break;
    }
  }
  if (eventId !== undefined)
    assertBoundedString(eventId, "event_id", 16, 256);
  if ((event === "popup_commit_approved" || event === "popup_commit_abandoned") && eventId === undefined) {
    commandError("popup commit events require an event_id");
  }
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "event",
    event,
    payload,
    ...eventId ? { event_id: eventId } : {}
  };
}
function assertNativeTab(value) {
  const tab = assertExactObject(value, ["tab_id", "window_id", "group_id", "url", "page_revision"], ["task_id"], "native tab");
  assertTabId(tab.tab_id);
  if (!isIntegerInRange(tab.window_id, 0))
    commandError("window_id must be a non-negative integer");
  if (!isIntegerInRange(tab.group_id, -1))
    commandError("group_id must be at least -1");
  assertBoundedString(tab.url, "url", 0, 16384);
  if (!isIntegerInRange(tab.page_revision, 0))
    commandError("page_revision must be a non-negative integer");
  if (tab.task_id !== undefined && tab.task_id !== null) {
    assertUuid(tab.task_id, "task_id");
    if (tab.group_id < 0)
      commandError("task-owned native tabs must have a visible group");
  }
}
function assertNativeHandoff(value) {
  if (!isRecord(value) || typeof value.active !== "boolean")
    commandError("handoff event must specify active");
  if (!value.active) {
    assertExactObject(value, ["active"], [], "inactive handoff payload");
    return;
  }
  const handoff = assertExactObject(value, ["active", "task_id", "tab_id", "started_at_ms"], [], "active handoff payload");
  assertUuid(handoff.task_id, "task_id");
  assertTabId(handoff.tab_id);
  if (!isIntegerInRange(handoff.started_at_ms, 0))
    commandError("started_at_ms must be a non-negative integer");
}
function randomToken(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
function randomUuidV7() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Date.now();
  for (let index = 5;index >= 0; index -= 1) {
    bytes[index] = timestamp & 255;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = bytes[6] & 15 | 112;
  bytes[8] = bytes[8] & 63 | 128;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function canonicalize(value) {
  if (Array.isArray(value))
    return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}
async function sha256Hex(value) {
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// src/storage.ts
var STATE_KEY = "agenttabStateV1";
var LEGACY_TASKS_KEY = "chromeBridgeTaskSessions";
var LEGACY_PREFERENCES_KEY = "chromeBridgePreferences";
var SCHEMA_VERSION = 1;
var mutationQueue = Promise.resolve();
var initialization = null;
var initializedState = null;
function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    paused: false,
    developerMode: false,
    showAgentPointer: true,
    tasks: {},
    revisions: {},
    handoff: { active: false },
    stagedCommits: {},
    automationCleanup: {
      pending: false,
      tabIds: [],
      generation: 0,
      epoch: 0
    }
  };
}
function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function finiteInteger(value, minimum = 0) {
  return Number.isInteger(value) && Number(value) >= minimum;
}
function jsonEquivalent(left, right) {
  if (Object.is(left, right))
    return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => jsonEquivalent(value, right[index]));
  }
  const leftObject = objectValue(left);
  const rightObject = objectValue(right);
  if (!leftObject || !rightObject)
    return false;
  const leftKeys = Object.keys(leftObject);
  return leftKeys.length === Object.keys(rightObject).length && leftKeys.every((key) => Object.hasOwn(rightObject, key) && jsonEquivalent(leftObject[key], rightObject[key]));
}
var taskColors = ["purple", "cyan", "green", "yellow", "orange", "red", "pink", "blue"];
function parseState(value) {
  const raw = objectValue(value);
  if (!raw || raw.schemaVersion !== SCHEMA_VERSION)
    return null;
  if (typeof raw.paused !== "boolean" || typeof raw.developerMode !== "boolean" || typeof raw.showAgentPointer !== "boolean") {
    return null;
  }
  const tasksValue = objectValue(raw.tasks);
  const revisionsValue = objectValue(raw.revisions);
  const handoffValue = objectValue(raw.handoff);
  const commitsValue = objectValue(raw.stagedCommits);
  const cleanupValue = raw.automationCleanup === undefined ? {
    pending: false,
    tabIds: [],
    generation: 0,
    epoch: 0
  } : objectValue(raw.automationCleanup);
  if (!tasksValue || !revisionsValue || !handoffValue || !commitsValue || !cleanupValue)
    return null;
  if (typeof cleanupValue.pending !== "boolean" || !Array.isArray(cleanupValue.tabIds) || !cleanupValue.tabIds.every((tabId) => finiteInteger(tabId)) || new Set(cleanupValue.tabIds).size !== cleanupValue.tabIds.length || !finiteInteger(cleanupValue.generation) || !finiteInteger(cleanupValue.epoch)) {
    return null;
  }
  const tasks = {};
  const assignedTabIds = new Set;
  const assignedGroupIds = new Map;
  for (const [taskId, candidate] of Object.entries(tasksValue)) {
    const task = objectValue(candidate);
    if (!task || task.taskId !== taskId || typeof task.name !== "string" || !(task.groupId === null || finiteInteger(task.groupId)) || !Array.isArray(task.tabIds) || !task.tabIds.every((tabId) => finiteInteger(tabId)) || !taskColors.includes(task.color) || !["working", "needs_user", "completed"].includes(String(task.state)) || !finiteInteger(task.createdAt) || !finiteInteger(task.updatedAt)) {
      return null;
    }
    const tabIds = task.tabIds;
    if (new Set(tabIds).size !== tabIds.length || task.groupId === null && tabIds.length > 0 || tabIds.some((tabId) => assignedTabIds.has(tabId)) || task.groupId !== null && assignedGroupIds.has(task.groupId)) {
      return null;
    }
    for (const tabId of tabIds)
      assignedTabIds.add(tabId);
    if (task.groupId !== null)
      assignedGroupIds.set(task.groupId, taskId);
    tasks[taskId] = task;
  }
  const revisions = {};
  for (const [tabId, candidate] of Object.entries(revisionsValue)) {
    const revision = objectValue(candidate);
    if (!revision || !finiteInteger(revision.floor, 1) || !finiteInteger(revision.current, revision.floor) || revision.documentId !== undefined && typeof revision.documentId !== "string" || revision.loaderId !== undefined && typeof revision.loaderId !== "string") {
      return null;
    }
    revisions[tabId] = revision;
  }
  if (typeof handoffValue.active !== "boolean")
    return null;
  if (handoffValue.active && (typeof handoffValue.taskId !== "string" || !finiteInteger(handoffValue.tabId) || !finiteInteger(handoffValue.expectedRevision, 1) || typeof handoffValue.prompt !== "string" || !objectValue(handoffValue.completion) || !finiteInteger(handoffValue.startedAtMs) || !finiteInteger(handoffValue.timeoutMs, 1) || handoffValue.pendingClearEventId !== undefined && typeof handoffValue.pendingClearEventId !== "string")) {
    return null;
  }
  const stagedCommits = {};
  for (const [token, candidate] of Object.entries(commitsValue)) {
    const commit = objectValue(candidate);
    const dialog = commit?.dialog === undefined ? undefined : objectValue(commit.dialog);
    if (!commit || commit.native_token !== token || token.length < 16 || typeof commit.task_id !== "string" || !finiteInteger(commit.tab_id) || !finiteInteger(commit.page_revision, 1) || typeof commit.effect !== "string" || typeof commit.fingerprint !== "string" || commit.fingerprint.length < 32 || !finiteInteger(commit.expires_at_ms) || commit.review_handle !== undefined && (typeof commit.review_handle !== "string" || commit.review_handle.length < 16 || commit.review_handle.length > 256) || commit.approved !== undefined && typeof commit.approved !== "boolean" || commit.dialog !== undefined && (!dialog || !finiteInteger(dialog.generation, 1) || typeof dialog.fingerprint !== "string" || dialog.fingerprint.length < 32) || !objectValue(commit.action) || !objectValue(commit.preview)) {
      return null;
    }
    stagedCommits[token] = commit;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    paused: raw.paused,
    developerMode: raw.developerMode,
    showAgentPointer: raw.showAgentPointer,
    tasks,
    revisions,
    handoff: handoffValue,
    stagedCommits,
    automationCleanup: cleanupValue
  };
}
function legacyTasks(value) {
  if (value === undefined)
    return {};
  const raw = objectValue(value);
  if (!raw)
    throw new Error("Legacy AgentTab task state is malformed");
  const now = Date.now();
  const migrated = {};
  const assignedTabIds = new Set;
  const assignedGroupIds = new Set;
  for (const [taskId, candidate] of Object.entries(raw)) {
    const session = objectValue(candidate);
    if (!session || !Array.isArray(session.tabIds) || !session.tabIds.every((tabId) => finiteInteger(tabId)) || new Set(session.tabIds).size !== session.tabIds.length) {
      throw new Error("Legacy AgentTab task state contains an invalid task");
    }
    const tabIds = session.tabIds;
    const groupId = finiteInteger(session.groupId) ? session.groupId : null;
    if (groupId === null && tabIds.length > 0 || tabIds.some((tabId) => assignedTabIds.has(tabId)) || groupId !== null && assignedGroupIds.has(groupId)) {
      throw new Error("Legacy AgentTab task state has ambiguous ownership");
    }
    for (const tabId of tabIds)
      assignedTabIds.add(tabId);
    if (groupId !== null)
      assignedGroupIds.add(groupId);
    migrated[taskId] = {
      taskId,
      name: typeof session.name === "string" ? session.name : "Imported browser task",
      groupId,
      tabIds,
      color: taskColors.includes(session.color) ? session.color : "purple",
      state: ["working", "needs_user", "completed"].includes(String(session.state)) ? session.state : "working",
      createdAt: finiteInteger(session.createdAt) ? session.createdAt : now,
      updatedAt: finiteInteger(session.updatedAt) ? session.updatedAt : now,
      legacyImported: true
    };
  }
  return migrated;
}
async function removeLegacyState(keys) {
  if (keys.length === 0)
    return;
  await chrome.storage.local.remove(keys);
  const remaining = await chrome.storage.local.get(keys);
  if (keys.some((key) => Object.hasOwn(remaining, key))) {
    throw new Error("AgentTab legacy state cleanup read-back failed");
  }
}
async function loadInitialState() {
  if (!chrome.storage?.local)
    throw new Error("AgentTab requires chrome.storage.local");
  const stored = await chrome.storage.local.get([
    STATE_KEY,
    LEGACY_TASKS_KEY,
    LEGACY_PREFERENCES_KEY
  ]);
  if (Object.hasOwn(stored, STATE_KEY)) {
    const existing = parseState(stored[STATE_KEY]);
    if (!existing)
      throw new Error("Persisted AgentTab state is malformed");
    initializedState = existing;
    await removeLegacyState([LEGACY_TASKS_KEY, LEGACY_PREFERENCES_KEY].filter((key) => Object.hasOwn(stored, key)));
    return structuredClone(existing);
  }
  const next = defaultState();
  next.tasks = legacyTasks(stored[LEGACY_TASKS_KEY]);
  const preferences = objectValue(stored[LEGACY_PREFERENCES_KEY]);
  if (preferences && typeof preferences.showAgentPointer === "boolean") {
    next.showAgentPointer = preferences.showAgentPointer;
  }
  await chrome.storage.local.set({ [STATE_KEY]: next });
  const verified = parseState((await chrome.storage.local.get(STATE_KEY))[STATE_KEY]);
  if (!verified || !jsonEquivalent(verified, next)) {
    throw new Error("AgentTab state migration read-back failed");
  }
  initializedState = verified;
  await removeLegacyState([LEGACY_TASKS_KEY, LEGACY_PREFERENCES_KEY].filter((key) => Object.hasOwn(stored, key)));
  return structuredClone(verified);
}
async function initializeState() {
  if (initializedState)
    return structuredClone(initializedState);
  if (!initialization) {
    initialization = loadInitialState().finally(() => {
      initialization = null;
    });
  }
  return structuredClone(await initialization);
}
async function readState() {
  await mutationQueue;
  return initializeState();
}
function mutateState(mutator) {
  const operation = mutationQueue.then(async () => {
    const state = await initializeState();
    const result = await mutator(state);
    await chrome.storage.local.set({ [STATE_KEY]: state });
    const verified = parseState((await chrome.storage.local.get(STATE_KEY))[STATE_KEY]);
    if (!verified || !jsonEquivalent(verified, state)) {
      throw new Error("AgentTab state persistence read-back failed");
    }
    initializedState = verified;
    return result;
  });
  mutationQueue = operation.then(() => {
    return;
  }, () => {
    return;
  });
  return operation;
}

// src/browser.ts
var DEBUGGER_VERSION = "1.3";
var DEBUGGER_IDLE_MS = 30000;

class StandardBrowserRuntime {
  revisions;
  closeTab;
  emit;
  authorizeDebuggerUse;
  recordDebuggerCandidate;
  forgetDebuggerCandidate;
  adoptOwnedChild;
  sessions = new Map;
  expectedDetaches = new Map;
  debuggerCandidates = new Set;
  constructor(revisions, closeTab, emit, authorizeDebuggerUse = async () => {
    return;
  }, recordDebuggerCandidate = async () => {
    return;
  }, forgetDebuggerCandidate = async () => {
    return;
  }, adoptOwnedChild = async () => {
    return;
  }) {
    this.revisions = revisions;
    this.closeTab = closeTab;
    this.emit = emit;
    this.authorizeDebuggerUse = authorizeDebuggerUse;
    this.recordDebuggerCandidate = recordDebuggerCandidate;
    this.forgetDebuggerCandidate = forgetDebuggerCandidate;
    this.adoptOwnedChild = adoptOwnedChild;
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId === undefined)
        return;
      const expected = this.expectedDetaches.get(source.tabId) ?? 0;
      if (expected > 0) {
        if (expected === 1)
          this.expectedDetaches.delete(source.tabId);
        else
          this.expectedDetaches.set(source.tabId, expected - 1);
        return;
      }
      const session = this.sessions.get(source.tabId);
      if (session?.idleTimer)
        clearTimeout(session.idleTimer);
      this.sessions.delete(source.tabId);
      this.invalidateStagedDialogs(source.tabId);
    });
    chrome.debugger.onEvent.addListener((source, method, rawParams) => {
      if (source.tabId === undefined)
        return;
      const session = this.sessions.get(source.tabId);
      if (!session)
        return;
      const params = isRecord(rawParams) ? rawParams : {};
      if (method === "Network.requestWillBeSent" && typeof params.requestId === "string") {
        session.inflight.add(params.requestId);
        session.lastNetworkActivity = Date.now();
      } else if ((method === "Network.loadingFinished" || method === "Network.loadingFailed") && typeof params.requestId === "string") {
        session.inflight.delete(params.requestId);
        session.lastNetworkActivity = Date.now();
      } else if (method === "Page.javascriptDialogOpening") {
        session.dialogGeneration += 1;
        session.dialog = {
          generation: session.dialogGeneration,
          fingerprint: sha256Hex({
            type: typeof params.type === "string" ? params.type : null,
            message: typeof params.message === "string" ? params.message : null,
            default_prompt: typeof params.defaultPrompt === "string" ? params.defaultPrompt : null
          })
        };
        this.invalidateStagedDialogs(source.tabId);
      } else if (method === "Page.windowOpen") {
        const pending = session.pendingWindowOpen;
        session.pendingWindowOpen = undefined;
        if (pending && pending.expiresAt >= Date.now() && typeof params.url === "string" && params.url.length > 0) {
          this.adoptWindowOpenChild(source.tabId, params.url, pending);
        }
      } else if (method === "Page.javascriptDialogClosed") {
        session.dialogGeneration += 1;
        session.dialog = undefined;
        this.invalidateStagedDialogs(source.tabId);
      }
    });
    this.revisions.onChange((tabId) => this.invalidateStagedDialogs(tabId));
  }
  debuggerTabIds() {
    return [...this.debuggerCandidates];
  }
  restoreDebuggerCandidates(tabIds) {
    for (const tabId of tabIds)
      this.debuggerCandidates.add(tabId);
  }
  async detach(tabId) {
    const session = this.sessions.get(tabId);
    if (!session) {
      if (this.debuggerCandidates.has(tabId)) {
        await this.detachRecovered(tabId);
      } else {
        await this.invalidateStagedDialogs(tabId);
      }
      return;
    }
    if (session.idleTimer)
      clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
    if (session.detachPromise)
      return session.detachPromise;
    if (session.attachPromise) {
      const attaching = session.attachPromise;
      try {
        await attaching;
      } catch {}
      if (this.sessions.get(tabId) !== session)
        return;
      if (session.attachPromise === attaching)
        session.attachPromise = undefined;
      return this.detach(tabId);
    }
    if (!session.attached) {
      if (this.sessions.get(tabId) === session)
        this.sessions.delete(tabId);
      await this.invalidateStagedDialogs(tabId);
      return;
    }
    return this.detachTrackedSession(tabId, session);
  }
  async scrubForHandoff(recoveredTabIds = []) {
    const tabIds = [
      ...new Set([...this.sessions.keys(), ...this.debuggerCandidates, ...recoveredTabIds])
    ];
    const results = await Promise.allSettled(tabIds.map((tabId) => this.detachRecovered(tabId)));
    const failed2 = results.find((result) => result.status === "rejected");
    if (failed2)
      throw failed2.reason;
  }
  async detachRecovered(tabId) {
    if (this.sessions.has(tabId)) {
      await this.detach(tabId);
      return;
    }
    const targets = await chrome.debugger.getTargets();
    const target = targets.find((candidate) => candidate.attached === true && candidate.tabId === tabId);
    if (!target) {
      await this.invalidateStagedDialogs(tabId);
      await this.forgetTrackedDebuggerCandidate(tabId);
      return;
    }
    const expected = this.expectedDetaches.get(tabId) ?? 0;
    this.expectedDetaches.set(tabId, expected + 1);
    try {
      await chrome.debugger.detach({ tabId });
      await this.invalidateStagedDialogs(tabId);
      await this.forgetTrackedDebuggerCandidate(tabId);
    } catch (error) {
      this.consumeExpectedDetach(tabId);
      throw error;
    }
  }
  detachTrackedSession(tabId, session) {
    const expected = this.expectedDetaches.get(tabId) ?? 0;
    this.expectedDetaches.set(tabId, expected + 1);
    const detaching = (async () => {
      try {
        await chrome.debugger.detach({ tabId });
        if (this.sessions.get(tabId) === session)
          this.sessions.delete(tabId);
        await this.invalidateStagedDialogs(tabId);
        await this.forgetTrackedDebuggerCandidate(tabId);
      } catch (error) {
        this.consumeExpectedDetach(tabId);
        if (this.sessions.get(tabId) === session)
          session.detachPromise = undefined;
        this.scheduleIdleDetach(tabId, session);
        throw error;
      }
    })();
    session.detachPromise = detaching;
    return detaching;
  }
  async forgetTrackedDebuggerCandidate(tabId) {
    await this.forgetDebuggerCandidate(tabId);
    this.debuggerCandidates.delete(tabId);
  }
  consumeExpectedDetach(tabId) {
    const pendingExpected = this.expectedDetaches.get(tabId) ?? 0;
    if (pendingExpected <= 1)
      this.expectedDetaches.delete(tabId);
    else
      this.expectedDetaches.set(tabId, pendingExpected - 1);
  }
  async snapshot(tabId, params) {
    await this.authorizeDebuggerUse(tabId);
    const mode = params.mode;
    if (mode === "text" || mode === "html")
      return this.scriptSnapshot(tabId, mode, params);
    if (mode === "screenshot")
      return this.screenshot(tabId, params);
    if (mode !== "accessibility") {
      throw Object.assign(new Error("Unsupported snapshot mode"), { code: "invalid_request" });
    }
    const maxNodes = typeof params.max_nodes === "number" ? params.max_nodes : 1000;
    const maxDepth = typeof params.max_depth === "number" ? params.max_depth : 50;
    const before = await this.pageIdentity(tabId);
    const pageRevision = await this.revisions.observeDocument(tabId, before.documentId, before.loaderId);
    const result = typeof params.root_ref === "string" ? await this.send(tabId, "Accessibility.getPartialAXTree", {
      backendNodeId: this.backendNodeId(pageRevision, params.root_ref),
      fetchRelatives: true
    }) : await this.send(tabId, "Accessibility.getFullAXTree", { depth: maxDepth });
    const after = await this.pageIdentity(tabId);
    if (before.documentId !== after.documentId || before.loaderId !== after.loaderId) {
      const currentPageRevision = await this.revisions.observeDocument(tabId, after.documentId, after.loaderId);
      throw Object.assign(new Error("Page changed while capturing the accessibility tree"), {
        code: "stale_revision",
        currentPageRevision
      });
    }
    const nodes = Array.isArray(result.nodes) ? result.nodes.filter(isRecord) : [];
    const encoded = nodes.slice(0, maxNodes).map((node) => ({
      ...node.backendDOMNodeId ? { ref: `r${pageRevision}-${node.backendDOMNodeId}` } : {},
      role: typeof node.role?.value === "string" ? node.role.value : "unknown",
      name: typeof node.name?.value === "string" ? node.name.value : "",
      ...node.value?.value !== undefined ? { value: node.value.value } : {},
      ...node.description?.value !== undefined ? { description: node.description.value } : {},
      ...node.ignored ? { ignored: true } : {}
    }));
    return {
      tab_id: tabId,
      page_revision: pageRevision,
      mode,
      nodes: encoded,
      truncated: nodes.length > maxNodes
    };
  }
  async act(taskId, tabId, expectedRevision, actions) {
    await this.authorizeDebuggerUse(tabId);
    const pageRevision = await this.revisions.assertExpected(tabId, expectedRevision);
    if (!Array.isArray(actions) || actions.length === 0 || actions.length > 64) {
      throw Object.assign(new Error("actions must contain between 1 and 64 operations"), {
        code: "invalid_request"
      });
    }
    const validated = [];
    for (const action of actions) {
      if (!isRecord(action) || typeof action.kind !== "string") {
        throw Object.assign(new Error("Each browser action requires a kind"), { code: "invalid_request" });
      }
      validated.push(action);
    }
    const completedActions = [];
    for (const [index, action] of validated.entries()) {
      if (index < validated.length - 1 && (action.kind === "navigate" || action.kind === "go_back" || action.kind === "go_forward" || action.kind === "reload" || action.kind === "close")) {
        throw Object.assign(new Error(`${String(action.kind)} must be the final action in a batch`), {
          code: "invalid_request"
        });
      }
      await this.revisions.assertExpected(tabId, pageRevision);
      const stagedConsequence = await this.consequence(tabId, pageRevision, action);
      if (stagedConsequence) {
        const staged = {
          native_token: randomToken(),
          task_id: taskId,
          tab_id: tabId,
          page_revision: pageRevision,
          effect: stagedConsequence.effect,
          fingerprint: await this.stageFingerprint(taskId, tabId, pageRevision, action, stagedConsequence.target),
          expires_at_ms: Date.now() + 300000,
          action: { action },
          preview: {
            effect: stagedConsequence.effect,
            kind: action.kind,
            target: stagedConsequence.target,
            ...typeof action.ref === "string" ? { ref: action.ref } : {}
          },
          ...stagedConsequence.dialog !== undefined ? { dialog: stagedConsequence.dialog.binding } : {}
        };
        await mutateState((state) => {
          if (stagedConsequence.dialog !== undefined && this.sessions.get(tabId)?.dialog !== stagedConsequence.dialog.live) {
            throw Object.assign(new Error("JavaScript dialog changed before it could be staged"), {
              code: "invalid_request"
            });
          }
          state.stagedCommits[staged.native_token] = staged;
        });
        return {
          staged,
          result: {
            tab_id: tabId,
            page_revision: await this.revisions.current(tabId),
            actions: completedActions,
            staged_index: index
          }
        };
      }
      completedActions.push(await this.performAction(tabId, pageRevision, action));
    }
    return {
      result: {
        tab_id: tabId,
        page_revision: await this.revisions.current(tabId),
        actions: completedActions
      }
    };
  }
  async bindReview(taskId, params) {
    const nativeToken = params.native_token;
    const reviewHandle = params.review_handle;
    const tabId = params.tab_id;
    if (typeof nativeToken !== "string" || typeof reviewHandle !== "string" || !Number.isInteger(tabId)) {
      throw Object.assign(new Error("Commit review binding is malformed"), { code: "invalid_request" });
    }
    const bound = await mutateState((state) => {
      const staged = state.stagedCommits[nativeToken];
      if (!staged || staged.task_id !== taskId || staged.tab_id !== tabId || staged.review_handle !== undefined) {
        return false;
      }
      staged.review_handle = reviewHandle;
      staged.approved = false;
      return true;
    });
    if (!bound) {
      throw Object.assign(new Error("Commit review binding does not match a staged operation"), {
        code: "invalid_staged_token"
      });
    }
    return { review_bound: true };
  }
  async reviewBinding(reviewHandle) {
    const staged = Object.values((await readState()).stagedCommits).find((candidate) => candidate.review_handle === reviewHandle && candidate.approved !== true);
    if (!staged) {
      throw Object.assign(new Error("Commit review is no longer available"), {
        code: "invalid_staged_token"
      });
    }
    return { task_id: staged.task_id, tab_id: staged.tab_id };
  }
  async approveReview(reviewHandle) {
    return mutateState((state) => {
      const staged = Object.values(state.stagedCommits).find((candidate) => candidate.review_handle === reviewHandle && candidate.approved !== true);
      if (!staged)
        return false;
      staged.approved = true;
      return true;
    });
  }
  async abandonReview(reviewHandle) {
    return mutateState((state) => {
      const entry = Object.entries(state.stagedCommits).find(([, staged]) => staged.review_handle === reviewHandle);
      if (!entry)
        return false;
      delete state.stagedCommits[entry[0]];
      return true;
    });
  }
  async abandonNativeStage(taskId, nativeToken, tabId) {
    if (typeof nativeToken !== "string" || !Number.isInteger(tabId)) {
      throw Object.assign(new Error("Commit stage cleanup is malformed"), { code: "invalid_request" });
    }
    const abandoned = await mutateState((state) => {
      const staged = state.stagedCommits[nativeToken];
      if (!staged || staged.task_id !== taskId || staged.tab_id !== tabId)
        return false;
      delete state.stagedCommits[nativeToken];
      return true;
    });
    if (!abandoned) {
      throw Object.assign(new Error("Commit stage is invalid, used, or belongs to another task"), {
        code: "invalid_staged_token"
      });
    }
    return { abandoned: true };
  }
  async discardNativeStages(nativeTokens) {
    if (nativeTokens.length === 0)
      return;
    const tokens = new Set(nativeTokens);
    await mutateState((state) => {
      for (const token of tokens)
        delete state.stagedCommits[token];
    });
  }
  async abandonAllStages() {
    await mutateState((state) => {
      state.stagedCommits = {};
    });
  }
  async stagedTabId(taskId, nativeToken) {
    if (typeof nativeToken !== "string") {
      throw Object.assign(new Error("browser_commit requires a native token"), { code: "invalid_request" });
    }
    const staged = (await readState()).stagedCommits[nativeToken];
    if (!staged || staged.task_id !== taskId) {
      throw Object.assign(new Error("Staged commit token is invalid, used, or belongs to another task"), {
        code: "invalid_staged_token"
      });
    }
    return staged.tab_id;
  }
  async commit(taskId, params) {
    const nativeToken = params.native_token;
    const tabId = await this.stagedTabId(taskId, nativeToken);
    await this.authorizeDebuggerUse(tabId);
    const staged = (await readState()).stagedCommits[String(nativeToken)];
    if (!staged || staged.task_id !== taskId || staged.tab_id !== tabId) {
      throw Object.assign(new Error("Staged commit token is invalid, used, or belongs to another task"), {
        code: "invalid_staged_token"
      });
    }
    if (staged.expires_at_ms <= Date.now()) {
      await mutateState((state) => {
        delete state.stagedCommits[String(nativeToken)];
      });
      this.emit("commit_expired", { native_token: String(nativeToken) });
      throw Object.assign(new Error("Staged commit token expired"), { code: "staged_commit_expired" });
    }
    await this.revisions.assertExpected(staged.tab_id, staged.page_revision);
    const action = staged.action.action;
    if (!isRecord(action) || typeof action.kind !== "string") {
      await mutateState((state) => {
        delete state.stagedCommits[String(nativeToken)];
      });
      throw Object.assign(new Error("Staged operation is malformed"), { code: "staged_commit_mismatch" });
    }
    const stagedTarget = isRecord(staged.preview.target) ? staged.preview.target : null;
    const fingerprint = stagedTarget ? await this.stageFingerprint(taskId, staged.tab_id, staged.page_revision, action, stagedTarget) : "";
    if (fingerprint !== staged.fingerprint) {
      await mutateState((state) => {
        delete state.stagedCommits[String(nativeToken)];
      });
      throw Object.assign(new Error("Staged operation changed before Commit"), {
        code: "staged_commit_mismatch"
      });
    }
    const currentTarget = typeof action.ref === "string" ? await this.targetDescriptor(staged.tab_id, staged.page_revision, action.ref, action) : { kind: action.kind };
    if (await this.stageFingerprint(taskId, staged.tab_id, staged.page_revision, action, currentTarget) !== staged.fingerprint) {
      await mutateState((state) => {
        delete state.stagedCommits[String(nativeToken)];
      });
      throw Object.assign(new Error("Staged target changed before Commit"), {
        code: "staged_commit_mismatch"
      });
    }
    await mutateState((state) => {
      delete state.stagedCommits[String(nativeToken)];
    });
    const result = action.kind === "dialog" && action.decision === "accept" ? await this.acceptStagedDialog(staged.tab_id, action, staged.dialog) : await this.performAction(staged.tab_id, staged.page_revision, action);
    return {
      tab_id: staged.tab_id,
      page_revision: await this.revisions.current(staged.tab_id),
      actions: [result]
    };
  }
  async expireCommits() {
    const expired = await mutateState((state) => {
      const tokens = Object.values(state.stagedCommits).filter((staged) => staged.expires_at_ms <= Date.now()).map((staged) => staged.native_token);
      for (const token of tokens)
        delete state.stagedCommits[token];
      return tokens;
    });
    for (const nativeToken of expired) {
      this.emit("commit_expired", { native_token: nativeToken });
    }
  }
  async wait(tabId, params, revalidate) {
    if (!isRecord(params.condition) || typeof params.condition.kind !== "string") {
      throw Object.assign(new Error("browser_wait requires a condition"), { code: "invalid_request" });
    }
    const condition = params.condition;
    const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : 30000;
    const waitStartedAtMs = Date.now();
    const deadline = waitStartedAtMs + timeoutMs;
    do {
      await this.authorizeDebuggerUse(tabId);
      if (revalidate)
        await revalidate();
      const matched = await this.conditionMatched(tabId, condition, waitStartedAtMs);
      if (revalidate)
        await revalidate();
      if (matched) {
        return {
          tab_id: tabId,
          page_revision: await this.revisions.current(tabId),
          condition: condition.kind,
          matched: true
        };
      }
      const delay = Promise.withResolvers();
      setTimeout(delay.resolve, 100);
      await delay.promise;
    } while (Date.now() < deadline);
    throw Object.assign(new Error(`Timed out waiting for ${String(condition.kind)}`), {
      code: "wait_timeout",
      outcome: "unknown"
    });
  }
  async developer(tabId, action, params) {
    await this.authorizeDebuggerUse(tabId);
    const [domain, ...rest] = action.split(".");
    if (!domain || rest.length === 0) {
      throw Object.assign(new Error("Developer action must be a CDP Domain.method"), {
        code: "invalid_request"
      });
    }
    return this.send(tabId, action, params);
  }
  async scriptSnapshot(tabId, mode, params) {
    await this.authorizeDebuggerUse(tabId);
    const selector = typeof params.selector === "string" ? params.selector : null;
    const maxBytes = typeof params.max_bytes === "number" ? params.max_bytes : 256000;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (snapshotMode, targetSelector) => {
        const target = targetSelector ? document.querySelector(targetSelector) : document.documentElement;
        if (!target)
          throw new Error(`Selector did not match: ${targetSelector}`);
        return snapshotMode === "text" ? target.textContent ?? "" : target.outerHTML;
      },
      args: [mode, selector]
    });
    const pageRevision = await this.revisions.current(tabId);
    const bytes = new TextEncoder().encode(String(result ?? ""));
    const bounded = bytes.length > maxBytes ? new TextDecoder().decode(bytes.slice(0, maxBytes)) : String(result ?? "");
    return {
      tab_id: tabId,
      page_revision: pageRevision,
      mode,
      content: bounded,
      truncated: bytes.length > maxBytes
    };
  }
  async screenshot(tabId, params) {
    const before = await this.pageIdentity(tabId);
    const pageRevision = await this.revisions.observeDocument(tabId, before.documentId, before.loaderId);
    const capture = {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: params.full_page === true
    };
    if (typeof params.selector === "string") {
      const document2 = await this.send(tabId, "DOM.getDocument", { depth: 0 });
      if (!isRecord(document2.root) || typeof document2.root.nodeId !== "number") {
        throw Object.assign(new Error("Could not inspect screenshot document"), { code: "snapshot_failed" });
      }
      const selected = await this.send(tabId, "DOM.querySelector", {
        nodeId: document2.root.nodeId,
        selector: params.selector
      });
      if (typeof selected.nodeId !== "number" || selected.nodeId === 0) {
        throw Object.assign(new Error(`Selector did not match: ${params.selector}`), {
          code: "selector_not_found"
        });
      }
      const model = await this.send(tabId, "DOM.getBoxModel", { nodeId: selected.nodeId });
      if (!isRecord(model.model) || !Array.isArray(model.model.border)) {
        throw Object.assign(new Error("Selected element has no visible box"), { code: "snapshot_failed" });
      }
      const points = model.model.border.map(Number);
      const x = Math.min(points[0], points[2], points[4], points[6]);
      const y = Math.min(points[1], points[3], points[5], points[7]);
      capture.clip = {
        x,
        y,
        width: Math.max(points[0], points[2], points[4], points[6]) - x,
        height: Math.max(points[1], points[3], points[5], points[7]) - y,
        scale: 1
      };
    } else if (params.full_page === true) {
      const metrics = await this.send(tabId, "Page.getLayoutMetrics", {});
      if (isRecord(metrics.cssContentSize)) {
        capture.clip = {
          x: Number(metrics.cssContentSize.x ?? 0),
          y: Number(metrics.cssContentSize.y ?? 0),
          width: Number(metrics.cssContentSize.width ?? 0),
          height: Number(metrics.cssContentSize.height ?? 0),
          scale: 1
        };
      }
    }
    const result = await this.send(tabId, "Page.captureScreenshot", capture);
    const after = await this.pageIdentity(tabId);
    const currentPageRevision = await this.revisions.observeDocument(tabId, after.documentId, after.loaderId);
    if (before.documentId !== after.documentId || before.loaderId !== after.loaderId || currentPageRevision !== pageRevision) {
      throw Object.assign(new Error("Page changed while the screenshot was captured"), {
        code: "stale_revision",
        currentPageRevision
      });
    }
    return {
      tab_id: tabId,
      page_revision: pageRevision,
      mode: "screenshot",
      data: result.data,
      encoding: "base64",
      media_type: "image/png"
    };
  }
  async consequence(tabId, pageRevision, action) {
    if (action.kind === "close") {
      return {
        effect: "Close an AgentTab-owned browser tab",
        target: { kind: action.kind }
      };
    }
    if (action.kind === "upload_file") {
      const count = Array.isArray(action.files) ? action.files.length : 0;
      return {
        effect: `Upload ${count} ${count === 1 ? "file" : "files"} to the page`,
        target: typeof action.ref === "string" ? await this.targetDescriptor(tabId, pageRevision, action.ref) : { kind: action.kind }
      };
    }
    if (action.kind === "dialog" && action.decision === "accept") {
      return {
        effect: "Accept a browser confirmation dialog",
        target: { kind: action.kind },
        dialog: await this.stageDialog(tabId)
      };
    }
    if (action.kind !== "click" && action.kind !== "select" && action.kind !== "fill" && action.kind !== "type") {
      return null;
    }
    const target = await this.targetDescriptor(tabId, pageRevision, action.ref, action);
    const label = [
      target.role,
      target.text,
      target.aria_label,
      target.title,
      target.name,
      target.id,
      target.type,
      target.form_action,
      target.form_method,
      ...Array.isArray(target.associated_labels) ? target.associated_labels : [],
      ...Array.isArray(target.accessible_labels) ? target.accessible_labels : [],
      target.requested_value,
      target.requested_option_label
    ].filter((value) => typeof value === "string").join(" ").replace(/\s+/g, " ").trim();
    if (/\b(buy|purchase|pay|send|transfer|delete|remove|publish|post|deploy|merge|approve|authorize|grant|revoke|unsubscribe|cancel subscription|place order|checkout|submit order|confirm order|permission)\b/i.test(label)) {
      return {
        effect: `${action.kind === "click" ? "Activate" : "Change"} consequential control: ${label.slice(0, 160)}`,
        target
      };
    }
    return null;
  }
  async stageFingerprint(taskId, tabId, pageRevision, action, target) {
    return sha256Hex({ task_id: taskId, tab_id: tabId, page_revision: pageRevision, action, target });
  }
  async stageDialog(tabId) {
    await this.ensureAttached(tabId);
    const dialog = this.sessions.get(tabId)?.dialog;
    if (!dialog) {
      throw Object.assign(new Error("Accepting a dialog requires an open JavaScript dialog"), {
        code: "invalid_request"
      });
    }
    const fingerprint = await dialog.fingerprint;
    if (this.sessions.get(tabId)?.dialog !== dialog) {
      throw Object.assign(new Error("JavaScript dialog changed before it could be staged"), {
        code: "invalid_request"
      });
    }
    return { binding: { generation: dialog.generation, fingerprint }, live: dialog };
  }
  async acceptStagedDialog(tabId, action, stagedDialog) {
    if (!stagedDialog) {
      throw Object.assign(new Error("Staged dialog binding is missing"), { code: "staged_commit_mismatch" });
    }
    await this.ensureAttached(tabId);
    await this.authorizeDebuggerUse(tabId);
    const dialog = this.sessions.get(tabId)?.dialog;
    if (!dialog || dialog.generation !== stagedDialog.generation) {
      throw Object.assign(new Error("The staged JavaScript dialog is no longer open"), {
        code: "staged_commit_mismatch"
      });
    }
    const fingerprint = await dialog.fingerprint;
    if (fingerprint !== stagedDialog.fingerprint || this.sessions.get(tabId)?.dialog !== dialog || dialog.generation !== stagedDialog.generation) {
      throw Object.assign(new Error("The staged JavaScript dialog changed before Commit"), {
        code: "staged_commit_mismatch"
      });
    }
    await this.send(tabId, "Page.handleJavaScriptDialog", { accept: true });
    return { kind: "dialog", completed: true };
  }
  async invalidateStagedDialogs(tabId) {
    await mutateState((state) => {
      for (const [token, staged] of Object.entries(state.stagedCommits)) {
        const action = staged.action.action;
        if (staged.tab_id === tabId && isRecord(action) && action.kind === "dialog") {
          delete state.stagedCommits[token];
        }
      }
    });
  }
  async targetDescriptor(tabId, pageRevision, ref, action) {
    const requestedValue = action?.kind === "select" ? String(action.value ?? "") : action?.kind === "fill" || action?.kind === "type" ? String(action.text ?? "") : null;
    const backendNodeId = this.backendNodeId(pageRevision, ref);
    const resolved = await this.send(tabId, "DOM.resolveNode", { backendNodeId });
    if (!isRecord(resolved.object) || typeof resolved.object.objectId !== "string") {
      throw Object.assign(new Error("Snapshot ref no longer resolves"), { code: "stale_ref" });
    }
    const described = await this.send(tabId, "Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: "function(requestedValue){const f=this.form;const text=node=>String(node&&((node.innerText??node.textContent)??'')||'').trim();const ids=String(this.getAttribute('aria-labelledby')||'')+' '+String(this.getAttribute('aria-describedby')||'');const associated=(this.labels?Array.from(this.labels):[]).map(text).filter(Boolean);const accessible=[this.getAttribute('aria-label'),...ids.trim().split(/\\s+/).filter(Boolean).map(id=>text(document.getElementById(id)))].filter(value=>typeof value==='string'&&value.trim());const option=this.options&&requestedValue!==null?Array.from(this.options).find(candidate=>String(candidate.value)===requestedValue):null;return {tag:this.tagName,role:this.getAttribute('role'),text:[this.innerText,this.textContent].filter(Boolean).join(' '),aria_label:this.getAttribute('aria-label'),title:this.getAttribute('title'),name:this.getAttribute('name'),id:this.id,type:this.getAttribute('type'),autocomplete:this.getAttribute('autocomplete'),href:this.getAttribute('href'),form_action:f&&f.action,form_method:f&&f.method,form_enctype:f&&f.enctype,associated_labels:associated,accessible_labels:accessible,requested_value:requestedValue,requested_option_label:option?String(option.label||option.textContent||'').trim():null}}",
      arguments: [{ value: requestedValue }],
      returnByValue: true
    });
    if (!isRecord(described.result) || !isRecord(described.result.value)) {
      throw Object.assign(new Error("Snapshot ref no longer resolves"), { code: "stale_ref" });
    }
    return described.result.value;
  }
  async performAction(tabId, pageRevision, action) {
    await this.authorizeDebuggerUse(tabId);
    const kind = action.kind;
    if (kind === "navigate") {
      if (typeof action.url !== "string")
        throw Object.assign(new Error("navigate requires url"), { code: "invalid_request" });
      await chrome.tabs.update(tabId, { url: action.url });
      return { kind, started: true };
    }
    if (kind === "go_back") {
      await chrome.tabs.goBack(tabId);
      return { kind, started: true };
    }
    if (kind === "go_forward") {
      await chrome.tabs.goForward(tabId);
      return { kind, started: true };
    }
    if (kind === "reload") {
      await chrome.tabs.reload(tabId, { bypassCache: action.bypass_cache === true });
      return { kind, started: true };
    }
    if (kind === "close") {
      await this.closeTab(tabId);
      return { kind, completed: true };
    }
    if (kind === "set_viewport") {
      throw Object.assign(new Error("set_viewport is unavailable in Standard mode"), {
        code: "invalid_request"
      });
    }
    if (kind === "dialog") {
      if (action.decision === "accept") {
        throw Object.assign(new Error("Accepting a dialog requires a staged Commit"), {
          code: "invalid_request"
        });
      }
      await this.send(tabId, "Page.handleJavaScriptDialog", { accept: false });
      return { kind, completed: true };
    }
    if (kind === "scroll" && action.ref === undefined) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (deltaX, deltaY) => window.scrollBy(deltaX, deltaY),
        args: [Number(action.delta_x ?? 0), Number(action.delta_y ?? 0)]
      });
      return { kind, completed: true };
    }
    const backendNodeId = this.backendNodeId(pageRevision, action.ref);
    if (kind === "click") {
      const [activeTab, existingTabs] = await Promise.all([
        chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab),
        chrome.tabs.query({})
      ]);
      const session = this.sessions.get(tabId);
      const pendingWindowOpen = {
        existingTabIds: new Set(existingTabs.map((tab) => tab.id).filter((candidate) => Number.isInteger(candidate))),
        activeTabId: Number.isInteger(activeTab?.id) ? activeTab.id : undefined,
        activeWindowId: Number.isInteger(activeTab?.windowId) ? activeTab.windowId : undefined,
        expiresAt: Date.now() + 1000
      };
      if (session)
        session.pendingWindowOpen = pendingWindowOpen;
      try {
        await this.callOnNode(tabId, backendNodeId, "function(){this.click()}", [], true);
      } finally {
        const [currentActiveTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const actionOwnsFocusChange = currentActiveTab?.id !== activeTab?.id && (currentActiveTab?.id === tabId || currentActiveTab?.openerTabId === tabId);
        if (actionOwnsFocusChange && Number.isInteger(activeTab?.id) && Number.isInteger(activeTab?.windowId)) {
          const original = await chrome.tabs.get(activeTab.id).catch(() => null);
          if (original?.windowId === activeTab.windowId) {
            await chrome.tabs.update(activeTab.id, { active: true }).catch(() => {
              return;
            });
            await chrome.windows.update(activeTab.windowId, { focused: true }).catch(() => {
              return;
            });
          }
        }
        setTimeout(() => {
          if (session?.pendingWindowOpen === pendingWindowOpen) {
            session.pendingWindowOpen = undefined;
          }
        }, 1000);
      }
    } else if (kind === "type") {
      await this.callOnNode(tabId, backendNodeId, "function(value){const type=String(this.getAttribute&&this.getAttribute('type')||'').toLowerCase();const autocomplete=String(this.getAttribute&&this.getAttribute('autocomplete')||'').toLowerCase().split(/\\s+/);if(type==='password'||autocomplete.some(token=>token==='current-password'||token==='new-password'||token==='one-time-code'||token==='webauthn'||token.startsWith('cc-'))){return {agenttab_sensitive_field:true}}this.focus();if(this.isContentEditable){this.textContent=(this.textContent||'')+value}else{const current=String(this.value||'');const start=Number.isInteger(this.selectionStart)?this.selectionStart:current.length;const end=Number.isInteger(this.selectionEnd)?this.selectionEnd:start;this.value=current.slice(0,start)+value+current.slice(end);if(typeof this.setSelectionRange==='function'){const position=start+value.length;this.setSelectionRange(position,position)}}this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}))}", [{ value: String(action.text ?? "") }]);
    } else if (kind === "fill") {
      await this.callOnNode(tabId, backendNodeId, "function(value){const type=String(this.getAttribute&&this.getAttribute('type')||'').toLowerCase();const autocomplete=String(this.getAttribute&&this.getAttribute('autocomplete')||'').toLowerCase().split(/\\s+/);if(type==='password'||autocomplete.some(token=>token==='current-password'||token==='new-password'||token==='one-time-code'||token==='webauthn'||token.startsWith('cc-'))){return {agenttab_sensitive_field:true}}this.focus();this.value=value;this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));this.dispatchEvent(new Event('change',{bubbles:true}))}", [{ value: String(action.text ?? "") }]);
    } else if (kind === "select") {
      await this.callOnNode(tabId, backendNodeId, "function(value){this.value=value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}))}", [{ value: String(action.value ?? "") }]);
    } else if (kind === "scroll") {
      await this.callOnNode(tabId, backendNodeId, "function(x,y){this.scrollBy(x,y)}", [{ value: Number(action.delta_x ?? 0) }, { value: Number(action.delta_y ?? 0) }]);
    } else if (kind === "drag") {
      const targetBackendNodeId = this.backendNodeId(pageRevision, action.target_ref);
      const [source, target] = await Promise.all([
        this.nodeCenter(tabId, backendNodeId),
        this.nodeCenter(tabId, targetBackendNodeId)
      ]);
      await this.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: source.x, y: source.y, button: "left", clickCount: 1 });
      await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y, button: "left" });
      await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
    } else if (kind === "upload_file") {
      if (!Array.isArray(action.files) || !action.files.every((file) => typeof file === "string")) {
        throw Object.assign(new Error("upload_file requires file paths"), { code: "invalid_request" });
      }
      await this.send(tabId, "DOM.setFileInputFiles", { files: action.files, backendNodeId });
    } else {
      throw Object.assign(new Error(`Unsupported standard action: ${String(kind)}`), {
        code: "invalid_request"
      });
    }
    return { kind, completed: true };
  }
  async conditionMatched(tabId, condition, waitStartedAtMs) {
    const kind = condition.kind;
    if (kind === "load")
      return (await chrome.tabs.get(tabId)).status === "complete";
    if (kind === "url")
      return (await chrome.tabs.get(tabId)).url === condition.value;
    if (kind === "text" || kind === "selector") {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (conditionKind, value) => conditionKind === "text" ? (document.documentElement.textContent ?? "").includes(value) : document.querySelector(value) !== null,
        args: [kind, String(condition.value ?? "")]
      });
      return result === true;
    }
    if (kind === "network_idle") {
      await this.ensureAttached(tabId);
      const session = this.sessions.get(tabId);
      return Boolean(session && session.inflight.size === 0 && Date.now() - session.lastNetworkActivity >= 500);
    }
    if (kind === "download") {
      const downloads = await chrome.downloads.search({ state: "complete", limit: 1, orderBy: ["-endTime"] });
      const completedAtMs = Date.parse(downloads[0]?.endTime ?? "");
      return Number.isFinite(completedAtMs) && completedAtMs >= waitStartedAtMs;
    }
    throw Object.assign(new Error(`Unsupported wait condition: ${String(kind)}`), {
      code: "invalid_request"
    });
  }
  backendNodeId(pageRevision, ref) {
    const match = /^r(\d+)-(\d+)$/.exec(String(ref ?? ""));
    if (!match || Number(match[1]) !== pageRevision) {
      throw Object.assign(new Error("Snapshot ref belongs to a stale page revision"), {
        code: "stale_ref"
      });
    }
    return Number(match[2]);
  }
  async callOnNode(tabId, backendNodeId, functionDeclaration, args, userGesture = false) {
    try {
      const resolved = await this.send(tabId, "DOM.resolveNode", { backendNodeId });
      if (!resolved.object || typeof resolved.object !== "object" || !("objectId" in resolved.object)) {
        throw Object.assign(new Error("Snapshot ref no longer resolves"), { code: "stale_ref" });
      }
      const invoked = await this.send(tabId, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration,
        arguments: args,
        awaitPromise: true,
        returnByValue: true,
        userGesture
      });
      if (isRecord(invoked.result) && isRecord(invoked.result.value) && invoked.result.value.agenttab_sensitive_field === true) {
        throw Object.assign(new Error("Sensitive fields require a human Your Turn handoff"), {
          code: "sensitive_field_requires_handoff",
          recovery: "Start browser_handoff for this tab and let the human enter the sensitive value."
        });
      }
      if (isRecord(invoked.exceptionDetails)) {
        const text = typeof invoked.exceptionDetails.text === "string" ? invoked.exceptionDetails.text : "Page action raised an exception";
        throw Object.assign(new Error(text), { code: "action_failed" });
      }
    } catch (error) {
      if (isRecord(error) && error.code === "stale_ref") {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/no node with given id|could not find node|cannot find context|execution context was destroyed/i.test(message)) {
        throw Object.assign(new Error("Snapshot ref no longer resolves"), { code: "stale_ref" });
      }
      throw error;
    }
  }
  async adoptWindowOpenChild(parentTabId, openedUrl, pending) {
    for (let attempt = 0;attempt < 10; attempt += 1) {
      const tabs = await chrome.tabs.query({});
      const candidates = tabs.filter((tab) => Number.isInteger(tab.id) && !pending.existingTabIds.has(tab.id) && (tab.url === openedUrl || tab.pendingUrl === openedUrl));
      if (candidates.length === 1) {
        const childTabId = candidates[0].id;
        await this.adoptOwnedChild(parentTabId, childTabId);
        const [currentActiveTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (currentActiveTab?.id === childTabId && pending.activeTabId !== undefined && pending.activeWindowId !== undefined) {
          const original = await chrome.tabs.get(pending.activeTabId).catch(() => null);
          if (original?.windowId === pending.activeWindowId) {
            await chrome.tabs.update(pending.activeTabId, { active: true }).catch(() => {
              return;
            });
            await chrome.windows.update(pending.activeWindowId, { focused: true }).catch(() => {
              return;
            });
          }
        }
        return;
      }
      if (candidates.length > 1)
        return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  async nodeCenter(tabId, backendNodeId) {
    const model = await this.send(tabId, "DOM.getBoxModel", { backendNodeId });
    if (!model.model || typeof model.model !== "object" || !("content" in model.model) || !Array.isArray(model.model.content)) {
      throw Object.assign(new Error("Dragged ref has no box model"), { code: "stale_ref" });
    }
    const points = model.model.content.map(Number);
    return {
      x: (points[0] + points[2] + points[4] + points[6]) / 4,
      y: (points[1] + points[3] + points[5] + points[7]) / 4
    };
  }
  async pageIdentity(tabId) {
    const document2 = await this.send(tabId, "DOM.getDocument", { depth: 0 });
    const frameTree = await this.send(tabId, "Page.getFrameTree", {});
    const root = isRecord(document2.root) ? document2.root : null;
    const documentId = typeof root?.backendNodeId === "number" ? `backend:${root.backendNodeId}` : typeof root?.nodeId === "number" ? `frontend:${root.nodeId}` : undefined;
    const loaderId = this.frameLoaderId(frameTree);
    if (documentId === undefined && loaderId === undefined) {
      throw Object.assign(new Error("Could not identify the page document"), {
        code: "snapshot_failed"
      });
    }
    return {
      ...documentId !== undefined ? { documentId } : {},
      ...loaderId !== undefined ? { loaderId } : {}
    };
  }
  frameLoaderId(result) {
    if (!result.frameTree || typeof result.frameTree !== "object" || !("frame" in result.frameTree))
      return;
    const frame = result.frameTree.frame;
    if (!frame || typeof frame !== "object" || !("loaderId" in frame))
      return;
    return typeof frame.loaderId === "string" ? frame.loaderId : undefined;
  }
  async ensureAttached(tabId) {
    await this.authorizeDebuggerUse(tabId);
    let session = this.sessions.get(tabId);
    if (session?.detachPromise) {
      await session.detachPromise;
      session = this.sessions.get(tabId);
    }
    if (!session) {
      session = {
        attached: false,
        busyCount: 0,
        inflight: new Set,
        lastNetworkActivity: Date.now(),
        dialogGeneration: 0
      };
      this.sessions.set(tabId, session);
    }
    if (session.attachPromise) {
      await session.attachPromise;
      await this.authorizeDebuggerUse(tabId);
      return;
    }
    if (session.attached) {
      await this.authorizeDebuggerUse(tabId);
      return;
    }
    const attaching = (async () => {
      await this.authorizeDebuggerUse(tabId);
      this.debuggerCandidates.add(tabId);
      await this.recordDebuggerCandidate(tabId);
      await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
      session.attached = true;
      try {
        for (const method of [
          "Page.enable",
          "DOM.enable",
          "Accessibility.enable",
          "Runtime.enable",
          "Network.enable"
        ]) {
          await this.authorizeDebuggerUse(tabId);
          await chrome.debugger.sendCommand({ tabId }, method, {});
        }
      } catch (error) {
        try {
          await this.detachTrackedSession(tabId, session);
        } catch (detachError) {
          throw new AggregateError([error, detachError], "Debugger initialization and cleanup both failed");
        }
        throw error;
      }
    })();
    session.attachPromise = attaching;
    try {
      await attaching;
    } finally {
      if (this.sessions.get(tabId) === session)
        session.attachPromise = undefined;
    }
  }
  scheduleIdleDetach(tabId, session) {
    if (session.idleTimer)
      clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.detach(tabId).catch(() => {
        if (this.sessions.get(tabId) === session)
          this.scheduleIdleDetach(tabId, session);
      });
    }, DEBUGGER_IDLE_MS);
  }
  async send(tabId, method, params) {
    await this.ensureAttached(tabId);
    const session = this.sessions.get(tabId);
    if (!session?.attached) {
      throw Object.assign(new Error("Debugger detached before the command could run"), {
        code: "debugger_detached"
      });
    }
    if (session.idleTimer)
      clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
    session.busyCount += 1;
    try {
      await this.authorizeDebuggerUse(tabId);
      const result = await chrome.debugger.sendCommand({ tabId }, method, params);
      return isRecord(result) ? result : {};
    } finally {
      session.busyCount -= 1;
      if (this.sessions.get(tabId) === session && session.busyCount === 0) {
        this.scheduleIdleDetach(tabId, session);
      }
    }
  }
}

// src/scheduler.ts
class NotStartedError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "NotStartedError";
    this.code = code;
  }
}

class MutationScheduler {
  accepting = true;
  lifecycleAccepting = true;
  permissionsAvailable = true;
  admissionEpoch = 0;
  admissionFailure = {
    code: "paused",
    message: "AgentTab is paused"
  };
  tabTails = new Map;
  taskTails = new Map;
  globalTail = Promise.resolve();
  generations = new Map;
  generationReasons = new Map;
  pending = new Set;
  setInitialPaused(paused) {
    if (!paused)
      return;
    this.accepting = false;
    this.lifecycleAccepting = false;
    this.admissionEpoch += 1;
    this.admissionFailure = {
      code: "paused",
      message: "AgentTab is paused"
    };
  }
  isAccepting() {
    return this.accepting;
  }
  notStarted(message) {
    if (!this.permissionsAvailable) {
      return new NotStartedError("permissions_required", "AgentTab automation permissions have not been enabled");
    }
    return new NotStartedError(this.admissionFailure.code, message ?? this.admissionFailure.message);
  }
  enqueueTab(taskId, tabId, work) {
    if (!this.accepting)
      return Promise.reject(this.notStarted());
    const admissionEpoch = this.admissionEpoch;
    const generation = this.generations.get(tabId) ?? 0;
    const priorGlobal = this.globalTail;
    const priorTask = this.taskTails.get(taskId) ?? Promise.resolve();
    const priorTab = this.tabTails.get(tabId) ?? Promise.resolve();
    const result = priorGlobal.then(() => Promise.all([priorTask, priorTab])).then(async () => {
      if (!this.accepting || this.admissionEpoch !== admissionEpoch) {
        throw this.notStarted("AgentTab paused before this mutation was dispatched");
      }
      if ((this.generations.get(tabId) ?? 0) !== generation) {
        const reason = this.generationReasons.get(tabId) ?? {
          code: "ownership_revoked",
          message: "Tab ownership changed before this mutation was dispatched"
        };
        throw new NotStartedError(reason.code, reason.message);
      }
      return work();
    });
    this.rememberTabTail(taskId, tabId, result);
    this.track(result);
    return result;
  }
  enqueueGlobal(work) {
    if (!this.accepting)
      return Promise.reject(this.notStarted());
    const admissionEpoch = this.admissionEpoch;
    const priorGlobal = this.globalTail;
    const priorTabs = [...this.tabTails.values()];
    const result = priorGlobal.then(() => Promise.all(priorTabs)).then(async () => {
      if (!this.accepting || this.admissionEpoch !== admissionEpoch) {
        throw this.notStarted("AgentTab paused before this global mutation was dispatched");
      }
      return work();
    });
    this.globalTail = result.then(() => {
      return;
    }, () => {
      return;
    });
    this.track(result);
    return result;
  }
  readAfterWrites(tabId, work) {
    if (!this.accepting)
      return Promise.reject(this.notStarted());
    const admissionEpoch = this.admissionEpoch;
    const priorGlobal = this.globalTail;
    if (tabId === undefined) {
      const result2 = priorGlobal.then(async () => {
        if (!this.accepting || this.admissionEpoch !== admissionEpoch) {
          throw this.notStarted("AgentTab paused before this observation was dispatched");
        }
        return work();
      });
      this.globalTail = result2.then(() => {
        return;
      }, () => {
        return;
      });
      this.track(result2);
      return result2;
    }
    const priorTab = this.tabTails.get(tabId) ?? Promise.resolve();
    const result = priorGlobal.then(() => priorTab).then(async () => {
      if (!this.accepting || this.admissionEpoch !== admissionEpoch) {
        throw this.notStarted("AgentTab paused before this observation was dispatched");
      }
      return work();
    });
    this.rememberTabTail(undefined, tabId, result);
    this.track(result);
    return result;
  }
  revokeTab(tabId) {
    this.generationReasons.set(tabId, {
      code: "ownership_revoked",
      message: "Tab ownership changed before this mutation was dispatched"
    });
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
  }
  invalidateTab(tabId) {
    this.generationReasons.set(tabId, {
      code: "stale_revision",
      message: "Page navigation invalidated this queued mutation"
    });
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
  }
  revokePermissions() {
    this.permissionsAvailable = false;
    this.accepting = false;
    this.admissionEpoch += 1;
  }
  restorePermissions() {
    this.permissionsAvailable = true;
    this.accepting = this.lifecycleAccepting;
  }
  async drain() {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }
  disconnect() {
    this.accepting = false;
    this.lifecycleAccepting = false;
    this.admissionEpoch += 1;
    this.admissionFailure = {
      code: "paused",
      message: "AgentTab connection is unavailable"
    };
  }
  async pause() {
    this.accepting = false;
    this.lifecycleAccepting = false;
    this.admissionEpoch += 1;
    this.admissionFailure = {
      code: "paused",
      message: "AgentTab is paused"
    };
    await this.drain();
  }
  resume() {
    this.lifecycleAccepting = true;
    this.accepting = this.permissionsAvailable;
    this.admissionFailure = {
      code: "paused",
      message: "AgentTab is paused"
    };
  }
  rememberTabTail(taskId, tabId, result) {
    const tail = result.then(() => {
      return;
    }, () => {
      return;
    });
    this.tabTails.set(tabId, tail);
    if (taskId !== undefined)
      this.taskTails.set(taskId, tail);
    tail.then(() => {
      if (this.tabTails.get(tabId) === tail)
        this.tabTails.delete(tabId);
      if (taskId !== undefined && this.taskTails.get(taskId) === tail) {
        this.taskTails.delete(taskId);
      }
    });
  }
  track(operation) {
    this.pending.add(operation);
    operation.finally(() => this.pending.delete(operation)).catch(() => {
      return;
    });
  }
}

// src/handoff.ts
var HANDOFF_ALARM = "agenttab-handoff-timeout";
var DEFAULT_TIMEOUT_MS = 300000;

class HandoffController {
  scheduler;
  revisions;
  ownership;
  emit;
  transitionTail = Promise.resolve();
  scrubber = null;
  constructor(scheduler, revisions, ownership, emit) {
    this.scheduler = scheduler;
    this.revisions = revisions;
    this.ownership = ownership;
    this.emit = emit;
  }
  setScrubber(scrubber) {
    this.scrubber = scrubber;
  }
  restore() {
    return this.serialize(() => this.restoreNow());
  }
  begin(taskId, params, originGuard) {
    return this.serialize(() => this.beginNow(taskId, params, originGuard));
  }
  finish(completed2) {
    return this.serialize(() => this.finishNow(completed2));
  }
  acknowledgeEvent(event, eventId) {
    return this.serialize(() => this.acknowledgeEventNow(event, eventId));
  }
  pause() {
    return this.serialize(() => this.pauseNow());
  }
  resume() {
    return this.serialize(() => this.resumeNow());
  }
  async restoreNow() {
    const state = await readState();
    if (!state.handoff.active)
      return;
    const barrier = this.scheduler.pause();
    await barrier;
    const restored = await readState();
    if (!restored.handoff.active)
      return;
    if (restored.handoff.pendingClearEventId) {
      this.emit("handoff_changed", { active: false }, restored.handoff.pendingClearEventId);
      return;
    }
    if (restored.handoff.startedAtMs + restored.handoff.timeoutMs <= Date.now()) {
      await this.finishNow(false);
      return;
    }
    chrome.alarms.create(HANDOFF_ALARM, {
      when: restored.handoff.startedAtMs + restored.handoff.timeoutMs
    });
  }
  async beginNow(taskId, params, originGuard) {
    const tabId = params.tab_id;
    const timeoutMs = params.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : params.timeout_ms;
    if (!Number.isInteger(tabId) || typeof params.prompt !== "string" || !isRecord(params.completion) || !Number.isInteger(timeoutMs) || Number(timeoutMs) < 1) {
      throw Object.assign(new Error("Invalid browser_handoff parameters"), { code: "invalid_request" });
    }
    if (!this.scheduler.isAccepting()) {
      throw new NotStartedError("paused", "AgentTab is paused");
    }
    const current = await readState();
    if (current.handoff.active) {
      throw Object.assign(new Error("Another credential handoff is already active"), {
        code: "handoff_in_progress"
      });
    }
    if (current.paused)
      throw new NotStartedError("paused", "AgentTab is paused");
    const numericTabId = Number(tabId);
    await this.ownership.assertOwned(taskId, numericTabId);
    await this.revisions.assertExpected(numericTabId, params.expected_page_revision);
    const startedAt = Date.now();
    const next = {
      active: true,
      taskId,
      tabId: numericTabId,
      expectedRevision: Number(params.expected_page_revision),
      prompt: params.prompt,
      completion: params.completion,
      startedAtMs: startedAt,
      timeoutMs: Number(timeoutMs)
    };
    const barrier = this.scheduler.pause();
    let recorded = false;
    try {
      await mutateState((state) => {
        if (state.handoff.active) {
          throw Object.assign(new Error("Another credential handoff is already active"), {
            code: "handoff_in_progress"
          });
        }
        if (state.paused)
          throw new NotStartedError("paused", "AgentTab is paused");
        state.handoff = next;
      });
      recorded = true;
      await barrier;
      await this.ownership.assertOwned(taskId, numericTabId);
      await this.revisions.assertExpected(numericTabId, next.expectedRevision);
      if (originGuard)
        await originGuard();
      await this.ownership.setTaskState(taskId, "needs_user");
      chrome.alarms.create(HANDOFF_ALARM, { when: startedAt + next.timeoutMs });
      const tab = await chrome.tabs.update(numericTabId, { active: true });
      if (tab?.windowId !== undefined)
        await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.action.openPopup().catch(() => {
        return;
      });
      this.emit("handoff_changed", {
        active: true,
        task_id: taskId,
        tab_id: numericTabId,
        started_at_ms: startedAt
      });
      return {
        task_id: taskId,
        tab_id: numericTabId,
        prompt: params.prompt,
        started_at_ms: startedAt
      };
    } catch (error) {
      await barrier;
      if (recorded) {
        await mutateState((state) => {
          const handoff = state.handoff;
          if (handoff.active && handoff.taskId === taskId && handoff.tabId === numericTabId && handoff.startedAtMs === startedAt) {
            state.handoff = { active: false };
            const task = state.tasks[taskId];
            if (task?.state === "needs_user") {
              task.state = "working";
              task.updatedAt = Date.now();
            }
          }
        });
        await chrome.alarms.clear(HANDOFF_ALARM);
      }
      const recovered = await readState();
      if (!recovered.paused && !recovered.handoff.active)
        this.scheduler.resume();
      throw error;
    }
  }
  async finishNow(completed2) {
    const handoff = (await readState()).handoff;
    if (!handoff.active)
      return { completed: false, reason: "No credential handoff is active" };
    if (handoff.pendingClearEventId) {
      this.emit("handoff_changed", { active: false }, handoff.pendingClearEventId);
      return { completed: completed2 };
    }
    if (completed2 && !await this.completionMatched(handoff)) {
      return { completed: false, reason: "The handoff completion condition has not been met" };
    }
    await this.scrubber?.();
    const eventId = crypto.randomUUID();
    await mutateState((state) => {
      const active = state.handoff;
      if (!active.active || active.startedAtMs !== handoff.startedAtMs || active.pendingClearEventId) {
        throw Object.assign(new Error("Credential handoff changed while it was being completed"), {
          code: "handoff_changed"
        });
      }
      state.handoff = { ...active, pendingClearEventId: eventId };
    });
    await chrome.alarms.clear(HANDOFF_ALARM);
    this.emit("handoff_changed", { active: false }, eventId);
    return { completed: completed2 };
  }
  async acknowledgeEventNow(event, eventId) {
    if (event !== "handoff_changed" || typeof eventId !== "string" || eventId.length === 0)
      return;
    const handoff = (await readState()).handoff;
    if (!handoff.active || handoff.pendingClearEventId !== eventId)
      return;
    await mutateState((state) => {
      const active = state.handoff;
      if (!active.active || active.pendingClearEventId !== eventId)
        return;
      state.handoff = { active: false };
      const task = state.tasks[active.taskId];
      if (task) {
        task.state = "working";
        task.updatedAt = Date.now();
      }
    });
    await chrome.alarms.clear(HANDOFF_ALARM);
    await this.ownership.setTaskState(handoff.taskId, "working");
    const current = await readState();
    if (!current.paused && !current.handoff.active)
      this.scheduler.resume();
  }
  async pauseNow() {
    const barrier = this.scheduler.pause();
    await mutateState((state) => {
      state.paused = true;
    });
    await barrier;
    this.emit("pause_changed", { paused: true });
  }
  async resumeNow() {
    const state = await readState();
    if (state.handoff.active) {
      throw Object.assign(new Error("Finish or cancel credential handoff before resuming"), {
        code: "handoff_in_progress"
      });
    }
    await this.ownership.reconcile();
    await mutateState((next) => {
      if (next.handoff.active) {
        throw Object.assign(new Error("Finish or cancel credential handoff before resuming"), {
          code: "handoff_in_progress"
        });
      }
      next.paused = false;
    });
    this.scheduler.resume();
    this.emit("pause_changed", { paused: false });
  }
  async completionMatched(handoff) {
    const kind = handoff.completion.kind;
    if (kind === "manual_done")
      return true;
    if (kind === "navigation") {
      return await this.revisions.current(handoff.tabId) !== handoff.expectedRevision;
    }
    if (kind === "url") {
      const tab = await chrome.tabs.get(handoff.tabId).catch(() => null);
      return tab?.url === handoff.completion.value;
    }
    if (kind === "selector" && typeof handoff.completion.value === "string") {
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: handoff.tabId },
          func: (selector) => document.querySelector(selector) !== null,
          args: [handoff.completion.value]
        });
        return result === true;
      } catch {
        return false;
      }
    }
    return false;
  }
  serialize(operation) {
    const next = this.transitionTail.then(operation);
    this.transitionTail = next.then(() => {
      return;
    }, () => {
      return;
    });
    return next;
  }
}

// src/native.ts
var NATIVE_HOST = "dev.agenttab.host";
var RECONNECT_ALARM = "agenttab-native-reconnect";
var RECONNECT_MAX_MS = 30000;
function nativeInventory(inventory) {
  return inventory.map((tab) => ({
    tab_id: Number(tab.tab_id),
    window_id: Number(tab.window_id),
    group_id: Number(tab.group_id),
    url: String(tab.url ?? ""),
    page_revision: Number(tab.page_revision),
    ...typeof tab.task_id === "string" ? { task_id: tab.task_id } : {}
  }));
}

class NativeBridge {
  scheduler;
  ownership;
  handleCommand;
  onEventAcknowledged;
  onReady;
  discardStages;
  port = null;
  ready = false;
  reconnectAttempt = 0;
  pendingEventAcks = new Map;
  constructor(scheduler, ownership, handleCommand, onEventAcknowledged = () => {
    return;
  }, onReady = async () => {
    return;
  }, discardStages = async () => {
    return;
  }) {
    this.scheduler = scheduler;
    this.ownership = ownership;
    this.handleCommand = handleCommand;
    this.onEventAcknowledged = onEventAcknowledged;
    this.onReady = onReady;
    this.discardStages = discardStages;
  }
  async connect() {
    if (this.port)
      return;
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.port = port;
    this.ready = false;
    port.onMessage.addListener((message) => void this.onMessage(port, message));
    port.onDisconnect.addListener(() => void this.onDisconnect(port));
    try {
      const state = await readState();
      port.postMessage(nativeHello(chrome.runtime.getManifest().version, nativeInventory(await this.ownership.inventory()), state.paused, state.handoff.active ? {
        active: true,
        task_id: state.handoff.taskId,
        tab_id: state.handoff.tabId,
        started_at_ms: state.handoff.startedAtMs
      } : { active: false }, Object.values(state.stagedCommits).map(({
        action: _action,
        preview: _preview,
        dialog: _dialog,
        review_handle: _reviewHandle,
        approved: _approved,
        ...staged
      }) => staged)));
    } catch {
      this.onDisconnect(port);
    }
  }
  sendEvent(event, payload, eventId) {
    if (!this.port || !this.ready)
      return;
    try {
      const normalized = event === "inventory" && Array.isArray(payload.inventory) ? { inventory: nativeInventory(payload.inventory.filter(isRecord)) } : payload;
      this.port.postMessage(nativeEvent(event, normalized, eventId));
    } catch {
      this.onDisconnect(this.port);
    }
  }
  async approvePopupCommit(reviewHandle, taskId, tabId) {
    const acknowledgement = await this.requestPopupEvent("popup_commit_approved", {
      review_handle: reviewHandle,
      task_id: taskId,
      tab_id: tabId
    });
    if (acknowledgement.outcome !== "completed" || !acknowledgement.result) {
      const error = acknowledgement.error;
      throw Object.assign(new Error(error?.message ?? "AgentTab could not approve the staged action"), {
        code: error?.code ?? "popup_commit_failed",
        acknowledged: true
      });
    }
    return acknowledgement.result;
  }
  async abandonPopupCommit(reviewHandle, taskId, tabId) {
    const acknowledgement = await this.requestPopupEvent("popup_commit_abandoned", {
      review_handle: reviewHandle,
      task_id: taskId,
      tab_id: tabId
    });
    if (acknowledgement.outcome !== "completed" || !acknowledgement.result) {
      const error = acknowledgement.error;
      throw Object.assign(new Error(error?.message ?? "AgentTab could not abandon the staged action"), {
        code: error?.code ?? "popup_commit_failed",
        acknowledged: true
      });
    }
    return acknowledgement.result;
  }
  requestPopupEvent(event, payload) {
    const port = this.port;
    if (!port || !this.ready) {
      throw Object.assign(new Error("AgentTab host is disconnected; the staged action was not approved"), {
        code: "extension_disconnected"
      });
    }
    const eventId = randomUuidV7();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingEventAcks.delete(eventId);
        reject(Object.assign(new Error("AgentTab host did not acknowledge the staged action"), {
          code: "extension_disconnected"
        }));
      }, 30000);
      this.pendingEventAcks.set(eventId, { resolve, reject, timeout });
      try {
        port.postMessage(nativeEvent(event, payload, eventId));
      } catch {
        clearTimeout(timeout);
        this.pendingEventAcks.delete(eventId);
        reject(Object.assign(new Error("AgentTab host is disconnected; the staged action was not approved"), {
          code: "extension_disconnected"
        }));
      }
    });
  }
  async reconnectFromAlarm(alarmName) {
    if (alarmName !== RECONNECT_ALARM || this.port)
      return;
    await this.connect();
  }
  async onMessage(port, message) {
    let parsed;
    try {
      parsed = parseInboundNativeMessage(message);
    } catch (error) {
      if (isRecord(error) && error.code === "invalid_request" && isRecord(message) && typeof message.request_id === "string" && this.port === port) {
        port.postMessage(failed(message.request_id, "invalid_request", error instanceof Error ? error.message : String(error)));
        return;
      }
      if (this.port === port)
        port.disconnect();
      return;
    }
    if (parsed.kind === "event_ack") {
      const pending = this.pendingEventAcks.get(parsed.event_id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingEventAcks.delete(parsed.event_id);
        pending.resolve(parsed);
      } else if (this.ready) {
        this.onEventAcknowledged(parsed.event, parsed.event_id);
      }
      return;
    }
    if (parsed.kind === "ready") {
      try {
        await this.discardStages(parsed.discard_staged_tokens ?? []);
      } catch {
        if (this.port === port)
          port.disconnect();
        return;
      }
      this.ready = true;
      this.reconnectAttempt = 0;
      await chrome.alarms.clear(RECONNECT_ALARM);
      if (parsed.state === "paused") {
        await this.scheduler.pause();
        await mutateState((state2) => {
          state2.paused = true;
        });
        await this.onReady();
        return;
      }
      const state = await readState();
      if (!state.paused && !state.handoff.active)
        this.scheduler.resume();
      await this.onReady();
      return;
    }
    if (!this.ready) {
      if (this.port === port)
        port.disconnect();
      return;
    }
    let response;
    try {
      response = await this.handleCommand(parsed);
    } catch (error) {
      response = failed(parsed.request_id, isRecord(error) && typeof error.code === "string" ? error.code : "native_action_failed", error instanceof Error ? error.message : String(error), "unknown");
    }
    if (this.port !== port)
      return;
    try {
      port.postMessage(response);
    } catch {
      this.onDisconnect(port);
    }
  }
  onDisconnect(port) {
    if (this.port !== port)
      return;
    this.port = null;
    this.ready = false;
    for (const [eventId, pending] of this.pendingEventAcks) {
      clearTimeout(pending.timeout);
      pending.reject(Object.assign(new Error("AgentTab host disconnected before acknowledging the staged action"), {
        code: "extension_disconnected"
      }));
      this.pendingEventAcks.delete(eventId);
    }
    this.scheduler.disconnect();
    this.discardStages([]);
    this.scheduleReconnect();
  }
  scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    chrome.alarms.create(RECONNECT_ALARM, { when: Date.now() + delay });
  }
}

// src/ownership.ts
var GROUP_COLORS = ["purple", "cyan", "green", "yellow", "orange", "red", "pink", "blue"];
var NO_GROUP = -1;
function taskColor(taskId) {
  let hash = 2166136261;
  for (const character of taskId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return GROUP_COLORS[(hash >>> 0) % GROUP_COLORS.length];
}
function groupTitle(task, developerMode) {
  const symbol = task.state === "completed" ? "✓" : task.state === "needs_user" ? "↗" : "✦";
  const mode = developerMode ? "DEV " : "";
  return `${symbol} ${mode}${task.name}`.slice(0, 40);
}

class OwnershipLedger {
  scheduler;
  revisions;
  emit;
  transitionTail = Promise.resolve();
  constructor(scheduler, revisions, emit) {
    this.scheduler = scheduler;
    this.revisions = revisions;
    this.emit = emit;
  }
  reconcile() {
    return this.serialize(() => this.reconcileNow());
  }
  assertOwned(taskId, tabId) {
    return this.serialize(() => this.assertOwnedNow(taskId, tabId));
  }
  assertOwnedTab(tabId) {
    return this.serialize(async () => {
      const state = await readState();
      const task = Object.values(state.tasks).find((candidate) => candidate.tabIds.includes(tabId));
      if (!task) {
        throw Object.assign(new Error("Tab is not owned by AgentTab"), {
          code: "ownership_denied"
        });
      }
      return this.assertOwnedNow(task.taskId, tabId);
    });
  }
  open(taskId, params) {
    return this.serialize(() => this.openNow(taskId, params));
  }
  adoptActive(taskId) {
    return this.serialize(() => this.adoptActiveNow(taskId));
  }
  adoptOwnedChild(tab, sourceTabId) {
    return this.serialize(() => this.adoptOwnedChildNow(tab, sourceTabId));
  }
  revokeIfMoved(tabId) {
    return this.serialize(() => this.revokeIfMovedNow(tabId));
  }
  revoke(tabId, event) {
    return this.serialize(() => this.revokeNow(tabId, event));
  }
  closeTask(taskId) {
    return this.serialize(() => this.closeTaskNow(taskId));
  }
  async setTaskState(taskId, taskState) {
    const updated = await mutateState((state) => {
      const task = state.tasks[taskId];
      if (!task)
        return null;
      task.state = taskState;
      task.updatedAt = Date.now();
      return {
        groupId: task.groupId,
        title: groupTitle(task, state.developerMode),
        color: task.color
      };
    });
    if (updated?.groupId !== null && updated?.groupId !== undefined) {
      await chrome.tabGroups.update(updated.groupId, {
        title: updated.title,
        color: updated.color,
        collapsed: false
      }).catch(() => {
        return;
      });
    }
  }
  async setDeveloperMode(enabled) {
    const tasks = await mutateState((state) => {
      state.developerMode = enabled;
      return Object.values(state.tasks).map((task) => ({
        groupId: task.groupId,
        title: groupTitle(task, enabled),
        color: task.color
      }));
    });
    await Promise.all(tasks.filter((task) => task.groupId !== null).map((task) => chrome.tabGroups.update(task.groupId, {
      title: task.title,
      color: task.color,
      collapsed: false
    }).catch(() => {
      return;
    })));
  }
  async inventory() {
    const state = await readState();
    const tabs = await chrome.tabs.query({});
    const byId = new Map(tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => [tab.id, tab]));
    const inventory = [];
    for (const task of Object.values(state.tasks)) {
      if (task.groupId === null)
        continue;
      for (const tabId of task.tabIds) {
        const tab = byId.get(tabId);
        if (!tab || tab.groupId !== task.groupId || !Number.isInteger(tab.windowId))
          continue;
        const url = tab.url || tab.pendingUrl;
        if (!url)
          continue;
        inventory.push({
          tab_id: tabId,
          window_id: tab.windowId,
          group_id: task.groupId,
          url,
          page_revision: await this.revisions.ensure(tabId),
          task_id: task.taskId
        });
      }
    }
    return inventory;
  }
  async publishInventory() {
    await this.emitInventory();
  }
  async taskIdForTab(tabId) {
    const state = await readState();
    const task = Object.values(state.tasks).find((candidate) => candidate.tabIds.includes(tabId));
    return task?.groupId === null ? null : task?.taskId ?? null;
  }
  async reconcileNow() {
    const tabs = await chrome.tabs.query({});
    const byId = new Map(tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => [tab.id, tab]));
    const changedTasks = [];
    await mutateState((state) => {
      for (const task of Object.values(state.tasks)) {
        const revokedTabIds = task.tabIds.filter((tabId) => {
          const tab = byId.get(tabId);
          return !tab || task.groupId === null || tab.groupId !== task.groupId;
        });
        if (revokedTabIds.length === 0)
          continue;
        for (const tabId of revokedTabIds)
          this.scheduler.revokeTab(tabId);
        task.tabIds = task.tabIds.filter((tabId) => !revokedTabIds.includes(tabId));
        if (task.tabIds.length === 0)
          task.groupId = null;
        task.updatedAt = Date.now();
        changedTasks.push({ taskId: task.taskId, count: task.tabIds.length, revokedTabIds });
      }
    });
    for (const changed of changedTasks) {
      for (const tabId of changed.revokedTabIds)
        await this.revisions.remove(tabId);
      this.emit("ownership_revoked", { task_id: changed.taskId, tab_count: changed.count });
    }
    await this.emitInventory();
    return changedTasks.flatMap((changed) => changed.revokedTabIds);
  }
  async assertOwnedNow(taskId, tabId) {
    const state = await readState();
    const task = state.tasks[taskId];
    const ownerCount = Object.values(state.tasks).filter((candidate) => candidate.tabIds.includes(tabId)).length;
    if (!task || !task.tabIds.includes(tabId) || task.groupId === null || ownerCount !== 1) {
      throw Object.assign(new Error("Tab is not owned by this AgentTab task"), {
        code: "ownership_denied"
      });
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.groupId !== task.groupId) {
      await this.revokeNow(tabId, "ownership_revoked");
      throw Object.assign(new Error("Tab left its AgentTab task group"), {
        code: "ownership_revoked"
      });
    }
    const current = await readState();
    const currentTask = current.tasks[taskId];
    if (!currentTask || currentTask.groupId !== task.groupId || !currentTask.tabIds.includes(tabId) || Object.values(current.tasks).filter((candidate) => candidate.tabIds.includes(tabId)).length !== 1) {
      throw Object.assign(new Error("Tab ownership changed while it was being checked"), {
        code: "ownership_revoked"
      });
    }
    return currentTask;
  }
  async openNow(taskId, params) {
    if (params.mode === "adopt_active")
      return this.adoptActiveNow(taskId);
    if (params.mode !== "create") {
      throw Object.assign(new Error("browser_open mode must be create or adopt_active"), {
        code: "invalid_request"
      });
    }
    const placement = params.placement ?? "task";
    if (placement !== "task" && placement !== "new_window") {
      throw Object.assign(new Error("browser_open placement must be task or new_window"), {
        code: "invalid_request"
      });
    }
    if (placement === "new_window" && params.background === false) {
      throw Object.assign(new Error("A new task window must open in the background"), {
        code: "invalid_request",
        recovery: "Use browser_handoff when the human needs to focus the task tab."
      });
    }
    const url = typeof params.url === "string" ? params.url : "about:blank";
    const active = params.background === false;
    const existingTask = (await readState()).tasks[taskId];
    let tab;
    if (placement === "new_window") {
      if (existingTask && existingTask.tabIds.length > 0) {
        throw Object.assign(new Error("A task window can be created only before the task owns tabs"), {
          code: "task_window_conflict",
          recovery: "Use placement task for this task, or create a new task for a separate window."
        });
      }
      tab = await this.createTabInDedicatedWindow(url);
    } else {
      let taskWindowId;
      if (existingTask && existingTask.groupId !== null) {
        for (const tabId of existingTask.tabIds) {
          const candidate = await chrome.tabs.get(tabId).catch(() => null);
          if (candidate?.groupId === existingTask.groupId && Number.isInteger(candidate.windowId)) {
            taskWindowId = candidate.windowId;
            break;
          }
        }
      }
      tab = await this.createTabInUsableWindow(url, active, taskWindowId);
    }
    const createdTabId = tab.id;
    if (createdTabId === undefined)
      throw new Error("Chrome did not return a created tab ID");
    try {
      await this.grant(taskId, createdTabId, `Task ${taskId.slice(0, 8)}`);
    } catch (error) {
      await chrome.tabs.remove(createdTabId).catch(() => {
        return;
      });
      throw error;
    }
    return this.tabResult(createdTabId);
  }
  async adoptActiveNow(taskId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !Number.isInteger(tab.id)) {
      throw Object.assign(new Error("Chrome has no active tab to adopt"), {
        code: "no_active_tab"
      });
    }
    const tabId = tab.id;
    await this.grant(taskId, tabId, `Adopted ${taskId.slice(0, 8)}`);
    if (chrome.action?.setBadgeText) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#6d5dfc" }).catch(() => {
        return;
      });
      await chrome.action.setBadgeText({ tabId, text: "✦" }).catch(() => {
        return;
      });
      setTimeout(() => void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {
        return;
      }), 2000);
    }
    return this.tabResult(tabId);
  }
  async adoptOwnedChildNow(tab, sourceTabId) {
    const childTabId = tab.id;
    const openerTabId = sourceTabId ?? tab.openerTabId;
    if (typeof childTabId !== "number" || !Number.isInteger(childTabId) || typeof openerTabId !== "number" || !Number.isInteger(openerTabId)) {
      return;
    }
    const state = await readState();
    const parentTask = Object.values(state.tasks).find((task) => task.tabIds.includes(openerTabId));
    if (!parentTask)
      return;
    let ownedParent;
    try {
      ownedParent = await this.assertOwnedNow(parentTask.taskId, openerTabId);
    } catch {
      return;
    }
    try {
      const parent = await chrome.tabs.get(openerTabId).catch(() => null);
      const child = await chrome.tabs.get(childTabId).catch(() => null);
      if (!parent || !child)
        return;
      if (sourceTabId === undefined && child.groupId !== undefined && child.groupId !== NO_GROUP && child.groupId !== ownedParent.groupId) {
        return;
      }
      if (Number.isInteger(parent.windowId) && Number.isInteger(child.windowId) && parent.windowId !== child.windowId) {
        const [activeDestination] = await chrome.tabs.query({
          active: true,
          windowId: parent.windowId
        });
        await chrome.tabs.move(childTabId, {
          windowId: parent.windowId,
          index: -1
        });
        if (Number.isInteger(activeDestination?.id)) {
          await chrome.tabs.update(activeDestination.id, { active: true }).catch(() => {
            return;
          });
        }
        await chrome.windows.update(parent.windowId, { focused: true }).catch(() => {
          return;
        });
      }
      await this.grant(ownedParent.taskId, childTabId, ownedParent.name);
    } catch {}
  }
  async revokeIfMovedNow(tabId) {
    const state = await readState();
    const task = Object.values(state.tasks).find((candidate) => candidate.tabIds.includes(tabId));
    if (!task)
      return false;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || task.groupId === null || tab.groupId !== task.groupId) {
      return this.revokeNow(tabId, "group_membership_changed");
    }
    return false;
  }
  async revokeNow(tabId, event) {
    this.scheduler.revokeTab(tabId);
    const changed = await mutateState((state) => {
      for (const task of Object.values(state.tasks)) {
        if (!task.tabIds.includes(tabId))
          continue;
        task.tabIds = task.tabIds.filter((ownedTabId) => ownedTabId !== tabId);
        if (task.tabIds.length === 0)
          task.groupId = null;
        task.updatedAt = Date.now();
        return { taskId: task.taskId, count: task.tabIds.length };
      }
      return null;
    });
    if (!changed)
      return false;
    await this.revisions.remove(tabId);
    this.emit(event, {
      task_id: changed.taskId,
      tab_count: changed.count
    });
    await this.emitInventory();
    return true;
  }
  async closeTaskNow(taskId) {
    const existing = (await readState()).tasks[taskId];
    if (!existing)
      return [];
    for (const tabId of existing.tabIds)
      this.scheduler.revokeTab(tabId);
    const tabIds = await mutateState((state) => {
      const task = state.tasks[taskId];
      if (!task)
        return [];
      const ownedTabIds = [...task.tabIds];
      delete state.tasks[taskId];
      for (const [token, staged] of Object.entries(state.stagedCommits)) {
        if (staged.task_id === taskId)
          delete state.stagedCommits[token];
      }
      return ownedTabIds;
    });
    for (const tabId of tabIds)
      await this.revisions.remove(tabId);
    const closedTabIds = [];
    for (const tabId of tabIds) {
      try {
        await chrome.tabs.remove(tabId);
        closedTabIds.push(tabId);
      } catch {}
    }
    this.emit("tab_removed", { task_id: taskId, tab_count: 0 });
    await this.emitInventory();
    return closedTabIds;
  }
  async grant(taskId, tabId, name) {
    const before = await chrome.tabs.get(tabId);
    const state = await readState();
    const currentOwner = Object.values(state.tasks).find((task) => task.tabIds.includes(tabId));
    if (currentOwner && currentOwner.taskId !== taskId) {
      throw Object.assign(new Error("Tab is already owned by another AgentTab task"), {
        code: "ownership_denied"
      });
    }
    if (currentOwner && currentOwner.groupId === before.groupId && before.groupId !== NO_GROUP) {
      await this.revisions.ensure(tabId);
      return;
    }
    if (currentOwner)
      await this.revokeNow(tabId, "ownership_revoked");
    const refreshed = await readState();
    const refreshedTask = refreshed.tasks[taskId];
    let groupId;
    try {
      if (refreshedTask?.groupId !== null && refreshedTask?.groupId !== undefined) {
        groupId = await chrome.tabs.group({ tabIds: [tabId], groupId: refreshedTask.groupId });
      } else {
        groupId = await chrome.tabs.group({ tabIds: [tabId] });
      }
      const previewTask = refreshedTask ?? {
        taskId,
        name,
        groupId,
        tabIds: [],
        color: taskColor(taskId),
        state: "working",
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await chrome.tabGroups.update(groupId, {
        title: groupTitle(previewTask, refreshed.developerMode),
        color: previewTask.color,
        collapsed: false
      });
      const grouped = await chrome.tabs.get(tabId);
      if (grouped.groupId !== groupId)
        throw new Error("Chrome did not preserve the requested tab group");
      await this.revisions.ensure(tabId);
      await mutateState((next) => {
        const conflictingTask = Object.values(next.tasks).find((task2) => task2.taskId !== taskId && task2.tabIds.includes(tabId));
        if (conflictingTask) {
          throw Object.assign(new Error("Tab ownership changed while grouping"), {
            code: "ownership_denied"
          });
        }
        const task = next.tasks[taskId] ?? previewTask;
        task.groupId = groupId;
        if (!task.tabIds.includes(tabId))
          task.tabIds.push(tabId);
        task.updatedAt = Date.now();
        next.tasks[taskId] = task;
      });
    } catch (error) {
      if (before.groupId !== undefined && before.groupId >= 0) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: before.groupId }).catch(() => {
          return;
        });
      } else {
        await chrome.tabs.ungroup([tabId]).catch(() => {
          return;
        });
      }
      if (error instanceof Error && "code" in error)
        throw error;
      throw Object.assign(new Error(`Could not visibly group AgentTab tab: ${String(error)}`), {
        code: "grouping_failed"
      });
    }
    this.emit("group_membership_changed", {
      task_id: taskId,
      tab_count: (await readState()).tasks[taskId]?.tabIds.length ?? 0
    });
    await this.emitInventory();
  }
  async createTabInDedicatedWindow(url) {
    let windowId;
    let tabId;
    try {
      const createdWindow = await chrome.windows.create({
        url,
        focused: false,
        type: "normal",
        state: "normal"
      });
      if (!createdWindow)
        throw new Error("Chrome did not return a created window");
      windowId = createdWindow.id;
      const tab = createdWindow.tabs?.[0];
      tabId = tab?.id;
      if (!Number.isInteger(windowId) || !Number.isInteger(tabId)) {
        throw new Error("Chrome did not return a window and tab ID");
      }
      await chrome.windows.update(windowId, {
        focused: false,
        state: "normal"
      });
      return tab;
    } catch (error) {
      if (tabId !== undefined) {
        await chrome.tabs.remove(tabId).catch(() => {
          return;
        });
      } else if (windowId !== undefined) {
        await chrome.windows.remove(windowId).catch(() => {
          return;
        });
      }
      throw Object.assign(new Error(`Could not create a background task window: ${String(error)}`), {
        code: "window_creation_failed",
        recovery: "Retry with placement task, or create a new task window after Chrome can open a normal window."
      });
    }
  }
  async createTabInUsableWindow(url, active, preferredWindowId) {
    if (preferredWindowId !== undefined) {
      return chrome.tabs.create({ windowId: preferredWindowId, url, active });
    }
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
    const noSplit = chrome.tabs.SPLIT_VIEW_ID_NONE ?? NO_GROUP;
    const usable = windows.map((window2) => ({
      window: window2,
      activeTab: window2.tabs?.find((tab2) => tab2.active)
    })).filter(({ window: window2, activeTab }) => Number.isInteger(window2.id) && (!activeTab || activeTab.splitViewId === undefined || activeTab.splitViewId === noSplit)).sort((left, right) => (right.activeTab?.lastAccessed ?? 0) - (left.activeTab?.lastAccessed ?? 0))[0];
    if (usable?.window.id !== undefined) {
      return chrome.tabs.create({ windowId: usable.window.id, url, active });
    }
    const createdWindow = await chrome.windows.create({ url, focused: active, type: "normal" });
    const tab = createdWindow?.tabs?.[0];
    if (!tab)
      throw new Error("Chrome did not create a tab in the fallback window");
    return tab;
  }
  async tabResult(tabId) {
    const tab = await chrome.tabs.get(tabId);
    const state = await readState();
    const owner = Object.values(state.tasks).find((task) => task.tabIds.includes(tabId));
    return {
      tab_id: tabId,
      window_id: tab.windowId,
      group_id: tab.groupId,
      url: tab.url ?? "",
      page_revision: await this.revisions.current(tabId),
      tab_count: owner?.tabIds.length ?? 0
    };
  }
  async emitInventory() {
    this.emit("inventory", { inventory: await this.inventory() });
  }
  serialize(operation) {
    const next = this.transitionTail.then(operation);
    this.transitionTail = next.then(() => {
      return;
    }, () => {
      return;
    });
    return next;
  }
}

// src/revisions.ts
class RevisionTracker {
  changeListeners = new Set;
  onChange(listener) {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  async ensure(tabId) {
    return mutateState((state) => {
      const key = String(tabId);
      const existing = state.revisions[key];
      if (existing)
        return existing.current;
      state.revisions[key] = { floor: 1, current: 1 };
      return 1;
    });
  }
  async current(tabId) {
    const current = (await readState()).revisions[String(tabId)]?.current;
    return current ?? this.ensure(tabId);
  }
  async markNavigation(tabId) {
    const pageRevision = await mutateState((state) => {
      const key = String(tabId);
      const existing = state.revisions[key];
      const next = Math.max((existing?.current ?? 0) + 1, (existing?.floor ?? 0) + 1, 1);
      state.revisions[key] = { floor: next, current: next };
      return next;
    });
    await this.publishChange(tabId, pageRevision);
    return pageRevision;
  }
  async observeDocument(tabId, documentId, loaderId) {
    const observed = await mutateState((state) => {
      const key = String(tabId);
      const existing = state.revisions[key];
      if (!existing) {
        state.revisions[key] = {
          floor: 1,
          current: 1,
          ...documentId !== undefined ? { documentId } : {},
          ...loaderId !== undefined ? { loaderId } : {}
        };
        return { pageRevision: 1, changed: false };
      }
      const changed = documentId !== undefined && existing.documentId !== undefined && documentId !== existing.documentId || loaderId !== undefined && existing.loaderId !== undefined && loaderId !== existing.loaderId;
      const pageRevision = changed ? Math.max(existing.current + 1, existing.floor + 1) : existing.current;
      state.revisions[key] = {
        floor: Math.max(existing.floor, pageRevision),
        current: pageRevision,
        ...documentId !== undefined ? { documentId } : existing.documentId !== undefined ? { documentId: existing.documentId } : {},
        ...loaderId !== undefined ? { loaderId } : existing.loaderId !== undefined ? { loaderId: existing.loaderId } : {}
      };
      return { pageRevision, changed };
    });
    if (observed.changed)
      await this.publishChange(tabId, observed.pageRevision);
    return observed.pageRevision;
  }
  async assertExpected(tabId, expected) {
    if (!Number.isInteger(expected) || Number(expected) < 0) {
      throw Object.assign(new Error("expected_page_revision must be a non-negative integer"), {
        code: "invalid_request"
      });
    }
    const current = await this.current(tabId);
    if (current !== expected) {
      throw Object.assign(new Error(`Page revision changed from ${String(expected)} to ${current}`), { code: "stale_revision", currentPageRevision: current });
    }
    return current;
  }
  async remove(tabId) {
    const pageRevision = await mutateState((state) => {
      const key = String(tabId);
      const existing = state.revisions[key];
      const next = Math.max((existing?.current ?? 0) + 1, (existing?.floor ?? 0) + 1, 1);
      state.revisions[key] = { floor: next, current: next };
      return next;
    });
    await this.publishChange(tabId, pageRevision);
  }
  async publishChange(tabId, pageRevision) {
    for (const listener of this.changeListeners) {
      await listener(tabId, pageRevision);
    }
  }
}

// src/background.ts
var RUNTIME_INSTANCE_ID = crypto.randomUUID();
var automationRevocationGeneration = 0;
var automationCleanupEpoch = 0;
var AUTOMATION_CLEANUP_ALARM = "agenttabAutomationCleanup";
var AUTOMATION_CLEANUP_RETRY_BASE_MS = 1000;
var AUTOMATION_CLEANUP_RETRY_MAX_MS = 30000;
var automationCleanupPending = false;
var automationCleanupDelayMs = AUTOMATION_CLEANUP_RETRY_BASE_MS;
var automationCleanupTimer;
var automationCleanupQueue = Promise.resolve();
var PRE_DISPATCH_ERRORS = {
  invalid_request: true,
  ownership_denied: true,
  grouping_failed: true,
  ownership_revoked: true,
  no_active_tab: true,
  permissions_required: true,
  stale_revision: true,
  stale_ref: true,
  paused: true,
  developer_mode_required: true,
  invalid_staged_token: true,
  staged_commit_expired: true,
  staged_commit_mismatch: true,
  handoff_in_progress: true,
  handoff_blackout: true,
  origin_denied: true,
  origin_not_allowed: true,
  origin_unavailable: true,
  origin_policy_mismatch: true,
  scheme_denied: true,
  sensitive_field_requires_handoff: true
};
var scheduler = new MutationScheduler;
var revisions = new RevisionTracker;
var nativeBridge = null;
var emit = (event, payload, eventId) => nativeBridge?.sendEvent(event, payload, eventId);
var ownership = new OwnershipLedger(scheduler, revisions, emit);
async function recordDebuggerCandidate(tabId) {
  const current = await readState();
  if (current.automationCleanup.tabIds.includes(tabId))
    return;
  await mutateState((state) => {
    if (!state.automationCleanup.tabIds.includes(tabId)) {
      state.automationCleanup.tabIds.push(tabId);
    }
  });
}
async function forgetDebuggerCandidate(tabId) {
  const current = await readState();
  if (!current.automationCleanup.tabIds.includes(tabId))
    return;
  await mutateState((state) => {
    state.automationCleanup.tabIds = state.automationCleanup.tabIds.filter((candidate) => candidate !== tabId);
  });
}
var browser;
browser = new StandardBrowserRuntime(revisions, async (tabId) => {
  await ownership.revoke(tabId, "tab_removed");
  await browser.detach(tabId);
  await chrome.tabs.remove(tabId);
}, emit, authorizeOwnedTab, recordDebuggerCandidate, forgetDebuggerCandidate, async (parentTabId, childTabId) => {
  const child = await chrome.tabs.get(childTabId).catch(() => null);
  if (child)
    await ownership.adoptOwnedChild(child, parentTabId);
});
var handoff = new HandoffController(scheduler, revisions, ownership, emit);
handoff.setScrubber(() => browser.scrubForHandoff());
async function automationEnabled() {
  if (automationCleanupPending)
    return false;
  const state = await readState();
  if (state.automationCleanup.pending)
    return false;
  const [scripting, debuggerPermission] = await Promise.all([
    chrome.permissions.contains({ permissions: ["scripting"] }),
    chrome.permissions.contains({ permissions: ["debugger"] })
  ]);
  return scripting && debuggerPermission;
}
function automationRequired() {
  return Object.assign(new Error("AgentTab automation permissions have not been enabled"), {
    code: "permissions_required",
    recovery: "Open the AgentTab popup and choose Enable automation."
  });
}
async function authorizeOwnedTab(tabId) {
  if (!await automationEnabled())
    throw automationRequired();
  const taskId = await ownership.taskIdForTab(tabId);
  if (taskId === null) {
    throw Object.assign(new Error("Tab is not owned by an AgentTab task"), {
      code: "ownership_denied"
    });
  }
  await ownership.assertOwned(taskId, tabId);
  if (!await automationEnabled())
    throw automationRequired();
}
function cancelAutomationCleanupRetry() {
  if (automationCleanupTimer)
    clearTimeout(automationCleanupTimer);
  automationCleanupTimer = undefined;
  automationCleanupDelayMs = AUTOMATION_CLEANUP_RETRY_BASE_MS;
  chrome.alarms.clear(AUTOMATION_CLEANUP_ALARM);
}
function queueAutomationCleanup() {
  automationCleanupQueue = automationCleanupQueue.catch(() => {
    return;
  }).then(clearAutomationRuntime);
  return automationCleanupQueue;
}
function scheduleAutomationCleanupRetry() {
  if (automationCleanupTimer)
    return;
  const delay = automationCleanupDelayMs;
  automationCleanupTimer = setTimeout(() => {
    automationCleanupTimer = undefined;
    queueAutomationCleanup().catch((error) => {
      console.warn("AgentTab debugger cleanup retry failed", error);
    });
  }, delay);
  chrome.alarms.create(AUTOMATION_CLEANUP_ALARM, { when: Date.now() + delay });
  automationCleanupDelayMs = Math.min(delay * 2, AUTOMATION_CLEANUP_RETRY_MAX_MS);
}
async function persistAutomationCleanupRequest(requestedEpoch) {
  const tabIds = browser.debuggerTabIds();
  const cleanup = await mutateState((state) => {
    state.automationCleanup.pending = true;
    state.automationCleanup.epoch = Math.max(state.automationCleanup.epoch + 1, requestedEpoch);
    state.automationCleanup.tabIds = [
      ...new Set([...state.automationCleanup.tabIds, ...tabIds])
    ];
    return structuredClone(state.automationCleanup);
  });
  automationCleanupEpoch = Math.max(automationCleanupEpoch, cleanup.epoch);
}
async function clearAutomationRuntime() {
  if (!automationCleanupPending)
    return;
  try {
    await start();
    await scheduler.drain();
    const cleanup = await mutateState((state) => {
      state.automationCleanup.pending = true;
      state.automationCleanup.epoch = Math.max(state.automationCleanup.epoch, automationCleanupEpoch);
      state.automationCleanup.tabIds = [
        ...new Set([...state.automationCleanup.tabIds, ...browser.debuggerTabIds()])
      ];
      return structuredClone(state.automationCleanup);
    });
    await browser.scrubForHandoff(cleanup.tabIds);
    const completed2 = await mutateState((state) => {
      if (state.automationCleanup.epoch !== cleanup.epoch) {
        return structuredClone(state.automationCleanup);
      }
      state.automationCleanup.pending = false;
      state.automationCleanup.tabIds = [];
      state.automationCleanup.generation += 1;
      return structuredClone(state.automationCleanup);
    });
    automationCleanupEpoch = Math.max(automationCleanupEpoch, completed2.epoch);
    automationRevocationGeneration = Math.max(automationRevocationGeneration, completed2.generation);
    automationCleanupPending = completed2.pending || automationCleanupEpoch > completed2.epoch;
    if (automationCleanupPending) {
      queueAutomationCleanup().catch(() => {
        return;
      });
      return;
    }
    cancelAutomationCleanupRetry();
    if (await automationEnabled())
      scheduler.restorePermissions();
  } catch (error) {
    scheduleAutomationCleanupRetry();
    throw error;
  }
}
function tabId(params) {
  if (!Number.isInteger(params.tab_id) || Number(params.tab_id) < 0) {
    throw Object.assign(new Error("tab_id must be a non-negative integer"), {
      code: "invalid_request"
    });
  }
  return Number(params.tab_id);
}
function originMatches(pattern, url) {
  if (pattern === url.origin)
    return true;
  if (!pattern.startsWith("*."))
    return false;
  const suffix = pattern.slice(2);
  return url.hostname !== suffix && url.hostname.endsWith(`.${suffix}`);
}
async function assertCurrentOrigin(tabId2, policy) {
  if (policy === undefined)
    return;
  if (policy.tab_id !== tabId2) {
    throw Object.assign(new Error("origin_policy.tab_id does not match the command target"), {
      code: "origin_policy_mismatch"
    });
  }
  const tab = await chrome.tabs.get(tabId2);
  const rawUrl = tab.pendingUrl ?? tab.url;
  if (typeof rawUrl !== "string") {
    throw Object.assign(new Error("AgentTab cannot determine the target tab's current origin"), {
      code: "origin_unavailable"
    });
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error("AgentTab cannot determine the target tab's current origin"), {
      code: "origin_unavailable"
    });
  }
  if (url.protocol === "about:")
    return;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw Object.assign(new Error(`AgentTab Standard mode does not allow ${url.protocol.slice(0, -1)} URLs`), {
      code: "scheme_denied"
    });
  }
  if (policy.denied_origins.some((pattern) => originMatches(pattern, url))) {
    throw Object.assign(new Error(`AgentTab policy denies ${url.origin}`), {
      code: "origin_denied"
    });
  }
  if (policy.allowed_origins.length > 0 && !policy.allowed_origins.some((pattern) => originMatches(pattern, url))) {
    throw Object.assign(new Error(`AgentTab policy does not allow ${url.origin}`), {
      code: "origin_not_allowed"
    });
  }
}
function errorCode(error) {
  return isRecord(error) && typeof error.code === "string" ? error.code : "native_action_failed";
}
function errorRecovery(error) {
  return isRecord(error) && typeof error.recovery === "string" ? error.recovery : undefined;
}
function errorOutcome(error, mutating, code) {
  if (isRecord(error) && typeof error.outcome === "string") {
    const outcome = error.outcome;
    if (outcome === "not_started" || outcome === "unknown")
      return outcome;
  }
  return mutating && !PRE_DISPATCH_ERRORS[code] ? "unknown" : "not_started";
}
async function dispatch(command) {
  if (command.kind === "close_task") {
    try {
      const closedTabIds = await ownership.closeTask(command.task_id);
      return completed(command.request_id, {
        task_id: command.task_id,
        closed_tab_ids: closedTabIds
      });
    } catch (error) {
      return failed(command.request_id, errorCode(error), error instanceof Error ? error.message : String(error), "unknown");
    }
  }
  const params = command.params;
  const mutating = command.method === "browser_open" || command.method === "browser_act" || command.method === "browser_commit" || command.method === "browser_handoff" || command.method === "browser_developer";
  try {
    if (command.method === "commit_review_bind") {
      return completed(command.request_id, await browser.bindReview(command.task_id, params));
    }
    if (command.method === "commit_review_abandon") {
      return completed(command.request_id, await browser.abandonNativeStage(command.task_id, params.native_token, params.tab_id));
    }
    if ((await readState()).handoff.active) {
      throw Object.assign(new Error("Automation is disabled while credential handoff is active"), {
        code: "handoff_blackout",
        recovery: "Wait for the human to finish or cancel the active handoff."
      });
    }
    if (command.method !== "browser_open" && command.method !== "browser_tabs" && command.method !== "browser_handoff" && !await automationEnabled()) {
      throw automationRequired();
    }
    if (command.method === "browser_open") {
      return completed(command.request_id, await scheduler.enqueueGlobal(() => ownership.open(command.task_id, params)));
    }
    if (command.method === "browser_tabs") {
      const result = await scheduler.enqueueGlobal(() => ownership.inventory());
      return completed(command.request_id, {
        tabs: result.filter((tab) => tab.task_id === command.task_id)
      });
    }
    if (command.method === "browser_handoff") {
      if (!scheduler.isAccepting() || (await readState()).paused) {
        throw scheduler.notStarted("AgentTab is paused");
      }
      return needsUser(command.request_id, await handoff.begin(command.task_id, params, () => assertCurrentOrigin(tabId(params), command.origin_policy)));
    }
    if (command.method === "browser_commit") {
      const targetTabId2 = await browser.stagedTabId(command.task_id, params.native_token);
      const result = await scheduler.enqueueTab(command.task_id, targetTabId2, async () => {
        await ownership.assertOwned(command.task_id, targetTabId2);
        await assertCurrentOrigin(targetTabId2, command.origin_policy);
        return browser.commit(command.task_id, params);
      });
      return completed(command.request_id, result);
    }
    if (command.method === "browser_developer") {
      const state = await readState();
      if (!state.developerMode) {
        throw Object.assign(new Error("Developer mode is disabled in the AgentTab popup"), {
          code: "developer_mode_required",
          recovery: "Enable Developer mode in the AgentTab popup, then retry."
        });
      }
      const action = params.action;
      if (typeof action !== "string" || !isRecord(params.params)) {
        throw Object.assign(new Error("browser_developer requires action and params"), { code: "invalid_request" });
      }
      const targetTabId2 = tabId(params.params);
      const cdpParams = { ...params.params };
      delete cdpParams.tab_id;
      const result = await scheduler.enqueueTab(command.task_id, targetTabId2, async () => {
        await ownership.assertOwned(command.task_id, targetTabId2);
        await assertCurrentOrigin(targetTabId2, command.origin_policy);
        return browser.developer(targetTabId2, action, cdpParams);
      });
      return completed(command.request_id, result);
    }
    const targetTabId = tabId(params);
    if (command.method === "browser_snapshot" || command.method === "browser_wait") {
      const result = await scheduler.readAfterWrites(targetTabId, async () => {
        if (command.method === "browser_snapshot") {
          await ownership.assertOwned(command.task_id, targetTabId);
          await assertCurrentOrigin(targetTabId, command.origin_policy);
          return browser.snapshot(targetTabId, params);
        }
        const revalidate = async () => {
          if (!scheduler.isAccepting()) {
            throw scheduler.notStarted("AgentTab stopped the active browser wait");
          }
          await ownership.assertOwned(command.task_id, targetTabId);
          await assertCurrentOrigin(targetTabId, command.origin_policy);
          if (!scheduler.isAccepting()) {
            throw scheduler.notStarted("AgentTab stopped the active browser wait");
          }
        };
        return browser.wait(targetTabId, params, revalidate);
      });
      return completed(command.request_id, result);
    }
    if (command.method === "browser_act") {
      const execution = await scheduler.enqueueTab(command.task_id, targetTabId, async () => {
        await ownership.assertOwned(command.task_id, targetTabId);
        await assertCurrentOrigin(targetTabId, command.origin_policy);
        return browser.act(command.task_id, targetTabId, params.expected_page_revision, params.actions);
      });
      if (execution.staged) {
        return commitRequired(command.request_id, execution.result ?? {}, execution.staged);
      }
      return completed(command.request_id, execution.result ?? {});
    }
    throw Object.assign(new Error(`Unsupported Core method: ${command.method}`), {
      code: "unsupported_method"
    });
  } catch (error) {
    const code = error instanceof NotStartedError ? error.code : errorCode(error);
    return failed(command.request_id, code, error instanceof Error ? error.message : String(error), errorOutcome(error, mutating, code), errorRecovery(error), isRecord(error) && typeof error.currentPageRevision === "number" ? { current_page_revision: error.currentPageRevision } : undefined);
  }
}
nativeBridge = new NativeBridge(scheduler, ownership, dispatch, (event, eventId) => void handoff.acknowledgeEvent(event, eventId), () => handoff.restore(), async (nativeTokens) => {
  if (nativeTokens.length > 0) {
    await browser.discardNativeStages(nativeTokens);
    return;
  }
  await browser.abandonAllStages();
});
var startup = null;
function start() {
  if (startup)
    return startup;
  startup = (async () => {
    const state = await readState();
    browser.restoreDebuggerCandidates(state.automationCleanup.tabIds);
    automationCleanupPending = automationCleanupPending || state.automationCleanup.pending || state.automationCleanup.tabIds.length > 0;
    automationCleanupEpoch = Math.max(automationCleanupEpoch, state.automationCleanup.epoch);
    automationRevocationGeneration = Math.max(automationRevocationGeneration, state.automationCleanup.generation);
    scheduler.setInitialPaused(state.paused || state.handoff.active);
    if (!await automationEnabled())
      scheduler.revokePermissions();
    const revokedTabIds = await ownership.reconcile();
    await Promise.all(revokedTabIds.map((tabId2) => browser.detach(tabId2)));
    await browser.expireCommits();
    await handoff.restore();
    await nativeBridge?.connect();
  })();
  startup.then(() => {
    if (!automationCleanupPending)
      return;
    queueAutomationCleanup().catch((error) => {
      console.warn("AgentTab restored debugger cleanup failed; retry scheduled", error);
    });
  });
  return startup;
}
async function reconcileOwnership() {
  const revokedTabIds = await ownership.reconcile();
  await Promise.all(revokedTabIds.map((tabId2) => browser.detach(tabId2)));
}
chrome.tabs.onCreated.addListener((tab) => {
  start().then(() => ownership.adoptOwnedChild(tab));
});
chrome.tabs.onRemoved.addListener((removedTabId) => {
  start().then(async () => {
    await browser.detach(removedTabId);
    await ownership.revoke(removedTabId, "tab_removed");
  });
});
chrome.tabs.onUpdated.addListener((updatedTabId, changeInfo) => {
  start().then(async () => {
    const owner = await ownership.taskIdForTab(updatedTabId);
    if (!owner)
      return;
    if (changeInfo.status === "loading") {
      scheduler.invalidateTab(updatedTabId);
      await revisions.markNavigation(updatedTabId);
    }
    if ("groupId" in changeInfo) {
      const revoked = await ownership.revokeIfMoved(updatedTabId);
      if (revoked)
        await browser.detach(updatedTabId);
    }
    if (typeof changeInfo.url === "string" || changeInfo.status === "complete") {
      await ownership.publishInventory();
    }
  });
});
chrome.tabs.onAttached.addListener(() => void start().then(reconcileOwnership));
chrome.tabs.onDetached.addListener(() => void start().then(reconcileOwnership));
chrome.tabGroups.onRemoved.addListener(() => void start().then(reconcileOwnership));
chrome.runtime.onStartup.addListener(() => void start());
chrome.runtime.onInstalled.addListener(() => void start());
chrome.permissions.onRemoved.addListener((permissions) => {
  if (!permissions.permissions?.includes("scripting"))
    return;
  scheduler.revokePermissions();
  automationCleanupPending = true;
  automationCleanupEpoch += 1;
  const requestedEpoch = automationCleanupEpoch;
  persistAutomationCleanupRequest(requestedEpoch).then(queueAutomationCleanup).catch((error) => {
    scheduleAutomationCleanupRetry();
    console.warn("AgentTab debugger cleanup failed; retry scheduled", error);
  });
});
chrome.permissions.onAdded.addListener((permissions) => {
  if (!permissions.permissions?.includes("scripting"))
    return;
  start().then(async () => {
    if (automationCleanupPending) {
      await queueAutomationCleanup().catch((error) => {
        console.warn("AgentTab debugger cleanup after permission restoration failed", error);
      });
      return;
    }
    if (await automationEnabled())
      scheduler.restorePermissions();
  });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  start().then(async () => {
    if (alarm.name === RECONNECT_ALARM)
      await nativeBridge?.reconnectFromAlarm(alarm.name);
    if (alarm.name === HANDOFF_ALARM)
      await handoff.finish(false);
    if (alarm.name === AUTOMATION_CLEANUP_ALARM) {
      if (automationCleanupTimer)
        clearTimeout(automationCleanupTimer);
      automationCleanupTimer = undefined;
      await queueAutomationCleanup().catch(() => {
        return;
      });
    }
    await browser.expireCommits();
  });
});
async function handlePopupMessage(message) {
  if (message.kind === "wake")
    return { ready: true };
  if (message.kind === "runtime_instance")
    return { runtime_instance: RUNTIME_INSTANCE_ID };
  if (message.kind === "automation_revocation_state") {
    return { generation: automationRevocationGeneration };
  }
  if (message.kind === "get_ui_state") {
    const state = await readState();
    return {
      automation_enabled: await automationEnabled(),
      paused: state.paused,
      developer_mode: state.developerMode,
      handoff: state.handoff.active ? { prompt: state.handoff.prompt } : null,
      show_agent_pointer: state.showAgentPointer,
      tasks: Object.values(state.tasks).map((task) => ({
        task_id: task.taskId,
        name: task.name,
        state: task.state,
        color: task.color,
        tab_count: task.tabIds.length
      })),
      reviews: Object.values(state.stagedCommits).filter((staged) => typeof staged.review_handle === "string" && staged.approved !== true).map((staged) => ({
        review_handle: staged.review_handle,
        task_id: staged.task_id,
        tab_id: staged.tab_id,
        effect: staged.effect,
        expires_at_ms: staged.expires_at_ms
      }))
    };
  }
  if (message.kind === "set_pointer" && typeof message.enabled === "boolean") {
    const enabled = message.enabled;
    await mutateState((state) => {
      state.showAgentPointer = enabled;
    });
    return { enabled };
  }
  if (message.kind === "pause") {
    await handoff.pause();
    return { paused: true };
  }
  if (message.kind === "resume") {
    await handoff.resume();
    return { paused: false };
  }
  if (message.kind === "developer_mode" && typeof message.enabled === "boolean") {
    await ownership.setDeveloperMode(message.enabled);
    return { enabled: message.enabled };
  }
  if (message.kind === "handoff_finish" && typeof message.completed === "boolean") {
    return handoff.finish(message.completed);
  }
  if ((message.kind === "approve_popup_commit" || message.kind === "abandon_popup_commit") && typeof message.review_handle === "string") {
    const binding = await browser.reviewBinding(message.review_handle);
    const bridge = nativeBridge;
    if (!bridge) {
      throw Object.assign(new Error("AgentTab host is disconnected; the staged action was not approved"), {
        code: "extension_disconnected"
      });
    }
    try {
      const approving = message.kind === "approve_popup_commit";
      const result = approving ? await bridge.approvePopupCommit(message.review_handle, binding.task_id, binding.tab_id) : await bridge.abandonPopupCommit(message.review_handle, binding.task_id, binding.tab_id);
      if (approving) {
        await browser.approveReview(message.review_handle);
      } else {
        await browser.abandonReview(message.review_handle);
      }
      return result;
    } catch (error) {
      if (isRecord(error) && error.acknowledged === true) {
        await browser.abandonReview(message.review_handle);
      }
      throw error;
    }
  }
  if (message.kind === "close_task" && typeof message.task_id === "string") {
    await ownership.closeTask(message.task_id);
    return { closed: true };
  }
  throw new Error("Unsupported popup message");
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isRecord(message) || typeof message.kind !== "string")
    return;
  start().then(() => handlePopupMessage(message)).then(sendResponse, (error) => sendResponse({
    error: error instanceof Error ? error.message : String(error)
  }));
  return true;
});
start();

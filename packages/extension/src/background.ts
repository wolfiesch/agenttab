import { StandardBrowserRuntime } from "./browser";
import { HandoffController, HANDOFF_ALARM } from "./handoff";
import { NativeBridge, RECONNECT_ALARM } from "./native";
import { OwnershipLedger } from "./ownership";
import {
  commitRequired,
  completed,
  failed,
  needsUser,
  type NativeDispatchCommand,
  type NativeOriginPolicy,
  type NativeResponse,
  type Outcome,
} from "./protocol";
import { RevisionTracker } from "./revisions";
import {
  automationRoute,
  automationRouteFields,
  normalizeRestrictedOriginError,
  restrictedOriginError,
} from "./routes";
import { MutationScheduler, NotStartedError } from "./scheduler";
import { mutateState, readState } from "./storage";
import { isRecord } from "./type-guards";

const RUNTIME_INSTANCE_ID = crypto.randomUUID();
let automationRevocationGeneration = 0;
let automationCleanupEpoch = 0;
const AUTOMATION_CLEANUP_ALARM = "agenttabAutomationCleanup";
const AUTOMATION_CLEANUP_RETRY_BASE_MS = 1_000;
const AUTOMATION_CLEANUP_RETRY_MAX_MS = 30_000;
let automationCleanupPending = false;
let automationCleanupDelayMs = AUTOMATION_CLEANUP_RETRY_BASE_MS;
let automationCleanupTimer: ReturnType<typeof setTimeout> | undefined;
let automationCleanupQueue = Promise.resolve();

const PRE_DISPATCH_ERRORS: Record<string, true> = {
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
  history_origin_unverified: true,
  sensitive_field_requires_handoff: true,
};

const scheduler = new MutationScheduler();
const revisions = new RevisionTracker();
let nativeBridge: NativeBridge | null = null;
const emit = (event: string, payload: Record<string, unknown>, eventId?: string) =>
  nativeBridge?.sendEvent(event, payload, eventId);
const ownership = new OwnershipLedger(scheduler, revisions, emit);
async function recordDebuggerCandidate(tabId: number): Promise<void> {
  const current = await readState();
  if (current.automationCleanup.tabIds.includes(tabId)) return;
  await mutateState((state) => {
    if (!state.automationCleanup.tabIds.includes(tabId)) {
      state.automationCleanup.tabIds.push(tabId);
    }
  });
}

async function forgetDebuggerCandidate(tabId: number): Promise<void> {
  const current = await readState();
  if (!current.automationCleanup.tabIds.includes(tabId)) return;
  await mutateState((state) => {
    state.automationCleanup.tabIds =
      state.automationCleanup.tabIds.filter((candidate) => candidate !== tabId);
  });
}
let browser: StandardBrowserRuntime;
browser = new StandardBrowserRuntime(
  revisions,
  async (tabId) => {
    await handoff.cancelForTab(tabId);
    await ownership.revoke(tabId, "tab_removed");
    await browser.detach(tabId);
    await chrome.tabs.remove(tabId);
  },
  emit,
  authorizeOwnedTab,
  recordDebuggerCandidate,
  forgetDebuggerCandidate,
  async (parentTabId, childTabId) => {
    const child = await chrome.tabs.get(childTabId).catch(() => null);
    if (child) await ownership.adoptOwnedChild(child, parentTabId);
  },
);
const handoff = new HandoffController(scheduler, revisions, ownership, emit);
handoff.setScrubber(() => browser.scrubForHandoff());

async function automationEnabled(): Promise<boolean> {
  if (automationCleanupPending) return false;
  const state = await readState();
  if (state.automationCleanup.pending) return false;
  const [scripting, debuggerPermission] = await Promise.all([
    chrome.permissions.contains({ permissions: ["scripting"] }),
    chrome.permissions.contains({ permissions: ["debugger"] }),
  ]);
  return scripting && debuggerPermission;
}

function automationRequired(): Error {
  return Object.assign(new Error("AgentTab automation permissions have not been enabled"), {
    code: "permissions_required",
    recovery: "Open the AgentTab popup and choose Enable automation.",
  });
}

async function authorizeOwnedTab(tabId: number): Promise<void> {
  if (!(await automationEnabled())) throw automationRequired();
  const taskId = await ownership.taskIdForTab(tabId);
  if (taskId === null) {
    throw Object.assign(new Error("Tab is not owned by an AgentTab task"), {
      code: "ownership_denied",
    });
  }
  await ownership.assertOwned(taskId, tabId);
  if (!(await automationEnabled())) throw automationRequired();
}
function cancelAutomationCleanupRetry(): void {
  if (automationCleanupTimer) clearTimeout(automationCleanupTimer);
  automationCleanupTimer = undefined;
  automationCleanupDelayMs = AUTOMATION_CLEANUP_RETRY_BASE_MS;
  void chrome.alarms.clear(AUTOMATION_CLEANUP_ALARM);
}

function queueAutomationCleanup(): Promise<void> {
  automationCleanupQueue = automationCleanupQueue
    .catch(() => undefined)
    .then(clearAutomationRuntime);
  return automationCleanupQueue;
}

function scheduleAutomationCleanupRetry(): void {
  if (automationCleanupTimer) return;
  const delay = automationCleanupDelayMs;
  automationCleanupTimer = setTimeout(() => {
    automationCleanupTimer = undefined;
    void queueAutomationCleanup().catch((error) => {
      console.warn("AgentTab debugger cleanup retry failed", error);
    });
  }, delay);
  chrome.alarms.create(AUTOMATION_CLEANUP_ALARM, { when: Date.now() + delay });
  automationCleanupDelayMs = Math.min(delay * 2, AUTOMATION_CLEANUP_RETRY_MAX_MS);
}

async function persistAutomationCleanupRequest(requestedEpoch: number): Promise<void> {
  const tabIds = browser.debuggerTabIds();
  const cleanup = await mutateState((state) => {
    state.automationCleanup.pending = true;
    state.automationCleanup.epoch = Math.max(
      state.automationCleanup.epoch + 1,
      requestedEpoch,
    );
    state.automationCleanup.tabIds = [
      ...new Set([...state.automationCleanup.tabIds, ...tabIds]),
    ];
    return structuredClone(state.automationCleanup);
  });
  automationCleanupEpoch = Math.max(automationCleanupEpoch, cleanup.epoch);
}

async function clearAutomationRuntime(): Promise<void> {
  if (!automationCleanupPending) return;
  try {
    await start();
    await scheduler.drain();
    const cleanup = await mutateState((state) => {
      state.automationCleanup.pending = true;
      state.automationCleanup.epoch = Math.max(
        state.automationCleanup.epoch,
        automationCleanupEpoch,
      );
      state.automationCleanup.tabIds = [
        ...new Set([...state.automationCleanup.tabIds, ...browser.debuggerTabIds()]),
      ];
      return structuredClone(state.automationCleanup);
    });
    await browser.scrubForHandoff(cleanup.tabIds);
    const completed = await mutateState((state) => {
      if (state.automationCleanup.epoch !== cleanup.epoch) {
        return structuredClone(state.automationCleanup);
      }
      state.automationCleanup.pending = false;
      state.automationCleanup.tabIds = [];
      state.automationCleanup.generation += 1;
      return structuredClone(state.automationCleanup);
    });
    automationCleanupEpoch = Math.max(automationCleanupEpoch, completed.epoch);
    automationRevocationGeneration = Math.max(
      automationRevocationGeneration,
      completed.generation,
    );
    automationCleanupPending =
      completed.pending || automationCleanupEpoch > completed.epoch;
    if (automationCleanupPending) {
      void queueAutomationCleanup().catch(() => undefined);
      return;
    }
    cancelAutomationCleanupRetry();
    if (await automationEnabled()) scheduler.restorePermissions();
  } catch (error) {
    scheduleAutomationCleanupRetry();
    throw error;
  }
}

function tabId(params: Record<string, unknown>): number {
  if (!Number.isInteger(params.tab_id) || Number(params.tab_id) < 0) {
    throw Object.assign(new Error("tab_id must be a non-negative integer"), {
      code: "invalid_request",
    });
  }
  return Number(params.tab_id);
}

function originMatches(pattern: string, url: URL): boolean {
  if (pattern === url.origin) return true;
  if (!pattern.startsWith("*.")) return false;
  const suffix = pattern.slice(2);
  return url.hostname !== suffix && url.hostname.endsWith(`.${suffix}`);
}

function assertHistoryOriginKnown(
  actions: unknown,
  policy: NativeOriginPolicy | undefined,
): void {
  if (
    policy === undefined ||
    (policy.allowed_origins.length === 0 && policy.denied_origins.length === 0) ||
    !Array.isArray(actions)
  ) {
    return;
  }
  if (
    actions.some((action) =>
      isRecord(action) && (action.kind === "go_back" || action.kind === "go_forward")
    )
  ) {
    throw Object.assign(
      new Error("AgentTab cannot authorize a browser history destination before navigation"),
      {
        code: "history_origin_unverified",
        recovery: "Navigate explicitly to an allowed URL, or remove the managed origin restriction.",
      },
    );
  }
}

async function assertCurrentOrigin(tabId: number, policy: NativeOriginPolicy | undefined): Promise<void> {
  if (policy === undefined) return;
  if (policy.tab_id !== tabId) {
    throw Object.assign(new Error("origin_policy.tab_id does not match the command target"), {
      code: "origin_policy_mismatch",
    });
  }
  const tab = await chrome.tabs.get(tabId);
  const rawUrl = tab.pendingUrl ?? tab.url;
  if (typeof rawUrl !== "string") {
    throw Object.assign(new Error("AgentTab cannot determine the target tab's current origin"), {
      code: "origin_unavailable",
    });
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error("AgentTab cannot determine the target tab's current origin"), {
      code: "origin_unavailable",
    });
  }
  if (
    automationRoute(rawUrl) === "tab_only" &&
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    return;
  }
  if (url.protocol === "about:") return;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw Object.assign(new Error(`AgentTab Standard mode does not allow ${url.protocol.slice(0, -1)} URLs`), {
      code: "scheme_denied",
    });
  }
  if (policy.denied_origins.some((pattern) => originMatches(pattern, url))) {
    throw Object.assign(new Error(`AgentTab policy denies ${url.origin}`), {
      code: "origin_denied",
    });
  }
  if (
    policy.allowed_origins.length > 0 &&
    !policy.allowed_origins.some((pattern) => originMatches(pattern, url))
  ) {
    throw Object.assign(new Error(`AgentTab policy does not allow ${url.origin}`), {
      code: "origin_not_allowed",
    });
  }
}
async function assertHandoffRoute(
  targetTabId: number,
  params: Record<string, unknown>,
  policy: NativeOriginPolicy | undefined,
): Promise<void> {
  await assertCurrentOrigin(targetTabId, policy);
  const completion = params.completion;
  if (!isRecord(completion) || completion.kind !== "selector") return;
  const tab = await chrome.tabs.get(targetTabId);
  if (automationRoute(tab.pendingUrl ?? tab.url) !== "full") {
    throw restrictedOriginError("wait for a handoff selector");
  }
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "native_action_failed";
}

function errorRecovery(error: unknown): string | undefined {
  return isRecord(error) && typeof error.recovery === "string" ? error.recovery : undefined;
}

function errorOutcome(error: unknown, mutating: boolean, code: string): Outcome {
  if (isRecord(error) && typeof error.outcome === "string") {
    const outcome = error.outcome;
    if (outcome === "not_started" || outcome === "unknown") return outcome;
  }
  return mutating && !PRE_DISPATCH_ERRORS[code] ? "unknown" : "not_started";
}

async function dispatch(command: NativeDispatchCommand): Promise<NativeResponse> {
  if (command.kind === "close_task") {
    try {
      const closedTabIds = await ownership.closeTask(command.task_id);
      await handoff.cancelForTask(command.task_id);
      return completed(command.request_id, {
        task_id: command.task_id,
        closed_tab_ids: closedTabIds,
      });
    } catch (error) {
      return failed(
        command.request_id,
        errorCode(error),
        error instanceof Error ? error.message : String(error),
        "unknown",
      );
    }
  }
  const params = command.params;
  const mutating = command.method === "browser_open" || command.method === "browser_act" || command.method === "browser_commit" || command.method === "browser_handoff" || command.method === "browser_developer";
  try {
    if (command.method === "commit_review_bind") {
      return completed(command.request_id, await browser.bindReview(command.task_id, params));
    }
    if (command.method === "commit_review_abandon") {
      return completed(
        command.request_id,
        await browser.abandonNativeStage(command.task_id, params.native_token, params.tab_id),
      );
    }
    if ((await readState()).handoff.active) {
      throw Object.assign(new Error("Automation is disabled while credential handoff is active"), {
        code: "handoff_blackout",
        recovery: "Wait for the human to finish or cancel the active handoff.",
      });
    }
    if (
      command.method !== "browser_open" &&
      command.method !== "browser_tabs" &&
      command.method !== "browser_handoff" &&
      !(await automationEnabled())
    ) {
      throw automationRequired();
    }
    if (command.method === "browser_open") {
      return completed(command.request_id, await scheduler.enqueueGlobal(() => ownership.open(command.task_id, params)));
    }
    if (command.method === "browser_tabs") {
      const result = await scheduler.enqueueGlobal(() => ownership.inventory());
      return completed(command.request_id, {
        tabs: result
          .filter((tab) => tab.task_id === command.task_id)
          .map((tab) => ({ ...tab, ...automationRouteFields(typeof tab.url === "string" ? tab.url : undefined) })),
      });
    }
    if (command.method === "browser_handoff") {
      if (!scheduler.isAccepting() || (await readState()).paused) {
        throw scheduler.notStarted("AgentTab is paused");
      }
      return needsUser(
        command.request_id,
        await handoff.begin(
          command.task_id,
          params,
          () => assertHandoffRoute(tabId(params), params, command.origin_policy),
        ),
      );
    }
    if (command.method === "browser_commit") {
      const targetTabId = await browser.stagedTabId(command.task_id, params.native_token);
      const result = await scheduler.enqueueTab(command.task_id, targetTabId, async () => {
        await ownership.assertOwned(command.task_id, targetTabId);
        await assertCurrentOrigin(targetTabId, command.origin_policy);
        return browser.commit(command.task_id, params);
      });
      return completed(command.request_id, result);
    }
    if (command.method === "browser_developer") {
      const state = await readState();
      if (!state.developerMode) {
        throw Object.assign(new Error("Developer mode is disabled in the AgentTab popup"), {
          code: "developer_mode_required",
          recovery: "Enable Developer mode in the AgentTab popup, then retry.",
        });
      }
      const action = params.action;
      if (typeof action !== "string" || !isRecord(params.params)) {
        throw Object.assign(new Error("browser_developer requires action and params"), { code: "invalid_request" });
      }
      const targetTabId = tabId(params.params);
      const cdpParams = { ...params.params };
      delete cdpParams.tab_id;
      const result = await scheduler.enqueueTab(command.task_id, targetTabId, async () => {
        await ownership.assertOwned(command.task_id, targetTabId);
        await assertCurrentOrigin(targetTabId, command.origin_policy);
        return browser.developer(targetTabId, action, cdpParams);
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
        assertHistoryOriginKnown(params.actions, command.origin_policy);
        await assertCurrentOrigin(targetTabId, command.origin_policy);
        return browser.act(command.task_id, targetTabId, params.expected_page_revision, params.actions);
      });
      if (execution.staged) {
        return commitRequired(command.request_id, execution.result ?? {}, execution.staged);
      }
      return completed(command.request_id, execution.result ?? {});
    }
    throw Object.assign(new Error(`Unsupported Core method: ${command.method}`), {
      code: "unsupported_method",
    });
  } catch (error) {
    const normalized = normalizeRestrictedOriginError(error, command.method);
    const code = normalized instanceof NotStartedError ? normalized.code : errorCode(normalized);
    return failed(
      command.request_id,
      code,
      normalized instanceof Error ? normalized.message : String(normalized),
      errorOutcome(normalized, mutating, code),
      errorRecovery(normalized),
      isRecord(normalized) && typeof normalized.currentPageRevision === "number"
        ? { current_page_revision: normalized.currentPageRevision }
        : undefined,
    );
  }
}

nativeBridge = new NativeBridge(
  scheduler,
  ownership,
  dispatch,
  (event, eventId) => void handoff.acknowledgeEvent(event, eventId),
  () => handoff.restore(),
  async (nativeTokens) => {
    if (nativeTokens.length > 0) {
      await browser.discardNativeStages(nativeTokens);
      return;
    }
    await browser.abandonAllStages();
  },
);

let startup: Promise<void> | null = null;
function start(): Promise<void> {
  if (startup) return startup;
  startup = (async () => {
    const state = await readState();
    browser.restoreDebuggerCandidates(state.automationCleanup.tabIds);
    automationCleanupPending =
      automationCleanupPending ||
      state.automationCleanup.pending ||
      state.automationCleanup.tabIds.length > 0;
    automationCleanupEpoch = Math.max(
      automationCleanupEpoch,
      state.automationCleanup.epoch,
    );
    automationRevocationGeneration = Math.max(
      automationRevocationGeneration,
      state.automationCleanup.generation,
    );
    scheduler.setInitialPaused(state.paused || state.handoff.active);
    if (!(await automationEnabled())) scheduler.revokePermissions();
    const revokedTabIds = await ownership.reconcile();
    await Promise.all(revokedTabIds.map((tabId) => handoff.cancelForTab(tabId)));
    await Promise.all(revokedTabIds.map((tabId) => browser.detach(tabId)));
    await browser.expireCommits();
    await handoff.restore();
    await nativeBridge?.connect();
  })();
  void startup.then(() => {
    if (!automationCleanupPending) return;
    void queueAutomationCleanup().catch((error) => {
      console.warn("AgentTab restored debugger cleanup failed; retry scheduled", error);
    });
  });
  return startup;
}

async function reconcileOwnership(): Promise<void> {
  const revokedTabIds = await ownership.reconcile();
  await Promise.all(revokedTabIds.map((tabId) => handoff.cancelForTab(tabId)));
  await Promise.all(revokedTabIds.map((tabId) => browser.detach(tabId)));
}

chrome.tabs.onCreated.addListener((tab: { id?: number; openerTabId?: number }) => {
  void start().then(() => ownership.adoptOwnedChild(tab));
});
chrome.tabs.onRemoved.addListener((removedTabId: number) => {
  void start().then(async () => {
    await handoff.cancelForTab(removedTabId);
    await browser.detach(removedTabId);
    await ownership.revoke(removedTabId, "tab_removed");
  });
});
chrome.tabs.onUpdated.addListener((updatedTabId, changeInfo) => {
  void start().then(async () => {
    const owner = await ownership.taskIdForTab(updatedTabId);
    if (!owner) return;
    if (changeInfo.status === "loading") {
      scheduler.invalidateTab(updatedTabId);
      await revisions.markNavigation(updatedTabId);
    }
    if ("groupId" in changeInfo) {
      const revoked = await ownership.revokeIfMoved(updatedTabId);
      if (revoked) {
        await handoff.cancelForTab(updatedTabId);
        await browser.detach(updatedTabId);
      }
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
  if (!permissions.permissions?.includes("scripting")) return;
  scheduler.revokePermissions();
  automationCleanupPending = true;
  automationCleanupEpoch += 1;
  const requestedEpoch = automationCleanupEpoch;
  void persistAutomationCleanupRequest(requestedEpoch)
    .then(queueAutomationCleanup)
    .catch((error) => {
      scheduleAutomationCleanupRetry();
      console.warn("AgentTab debugger cleanup failed; retry scheduled", error);
    });
});

chrome.permissions.onAdded.addListener((permissions) => {
  if (!permissions.permissions?.includes("scripting")) return;
  void start().then(async () => {
    if (automationCleanupPending) {
      await queueAutomationCleanup().catch((error) => {
        console.warn("AgentTab debugger cleanup after permission restoration failed", error);
      });
      return;
    }
    if (await automationEnabled()) scheduler.restorePermissions();
  });
});
chrome.alarms.onAlarm.addListener((alarm: { name: string }) => {
  void start().then(async () => {
    if (alarm.name === RECONNECT_ALARM) await nativeBridge?.reconnectFromAlarm(alarm.name);
    if (alarm.name === HANDOFF_ALARM) await handoff.finish(false);
    if (alarm.name === AUTOMATION_CLEANUP_ALARM) {
      if (automationCleanupTimer) clearTimeout(automationCleanupTimer);
      automationCleanupTimer = undefined;
      await queueAutomationCleanup().catch(() => undefined);
    }
    await browser.expireCommits();
  });
});

async function handlePopupMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (message.kind === "wake") return { ready: true };
  if (message.kind === "runtime_instance") return { runtime_instance: RUNTIME_INSTANCE_ID };
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
        tab_count: task.tabIds.length,
      })),
      reviews: Object.values(state.stagedCommits)
        .filter((staged) => typeof staged.review_handle === "string" && staged.approved !== true)
        .map((staged) => ({
          review_handle: staged.review_handle,
          task_id: staged.task_id,
          tab_id: staged.tab_id,
          effect: staged.effect,
          expires_at_ms: staged.expires_at_ms,
        })),
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
  if (
    (message.kind === "approve_popup_commit" || message.kind === "abandon_popup_commit") &&
    typeof message.review_handle === "string"
  ) {
    const binding = await browser.reviewBinding(message.review_handle);
    const bridge = nativeBridge;
    if (!bridge) {
      throw Object.assign(new Error("AgentTab host is disconnected; the staged action was not approved"), {
        code: "extension_disconnected",
      });
    }
    try {
      const approving = message.kind === "approve_popup_commit";
      const result = approving
        ? await bridge.approvePopupCommit(message.review_handle, binding.task_id, binding.tab_id)
        : await bridge.abandonPopupCommit(message.review_handle, binding.task_id, binding.tab_id);
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
    await handoff.cancelForTask(message.task_id);
    return { closed: true };
  }
  throw new Error("Unsupported popup message");
}

chrome.runtime.onMessage.addListener((
  message: unknown,
  sender: { id?: string },
  sendResponse: (response: Record<string, unknown>) => void,
) => {
  if (sender.id !== chrome.runtime.id || !isRecord(message) || typeof message.kind !== "string") return undefined;
  void start()
    .then(() => handlePopupMessage(message))
    .then(
      sendResponse,
      (error: unknown) => sendResponse({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  return true;
});

void start();

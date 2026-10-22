import type { ChallengeEvent } from "./challenge";
import { clearChallengeTask } from "./challenge-store";
import { removeTabIfPresent, StandardBrowserRuntime } from "./browser";
import { HandoffController, HANDOFF_ALARM } from "./handoff";
import { NativeBridge, RECONNECT_ALARM } from "./native";
import { OwnershipLedger } from "./ownership";
import { ProfileRuntime, profileReviewDetail } from "./profile";
import {
  commitRequired,
  completed,
  failed,
  needsUser,
  PROFILE_STAGE_TAB_ID,
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
import { IdempotentStartup, StartupOperationQueue } from "./startup";
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
/** Longest a `browser_open` or a batch's final navigation waits for the page's load to finish. */
const LOAD_SETTLE_TIMEOUT_MS = 10_000;
const NAVIGATION_ACTION_KINDS: Readonly<Record<string, true>> = {
  navigate: true,
  go_back: true,
  go_forward: true,
  reload: true,
};
const tabLoadWaiters = new Map<number, Set<() => void>>();
/** Tabs whose `complete` event the tab-event queue has processed; removal prunes it to open tabs. */
const processedTabLoads = new Set<number>();

/** Tab events a batch's final navigation waits on; the queue reports them after processing them. */
interface NavigationWatch {
  /** The queue processed a `loading` event since the watch began. */
  started: boolean;
  /** Resolves once the queue processes a `complete` event, or the tab closes. */
  loaded: Promise<void>;
  markLoaded(): void;
}
const navigationWatches = new Map<number, Set<NavigationWatch>>();

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
  bookmark_not_found: true,
  bookmark_root_immutable: true,
  bookmark_folder_not_empty: true,
  session_not_found: true,
  download_not_found: true,
  origin_policy_unverifiable: true,

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
    await ownership.revoke(tabId, "tab_removed");
    await browser.detach(tabId);
    await removeTabIfPresent(tabId);
  },
  emit,
  authorizeOwnedTab,
  recordDebuggerCandidate,
  forgetDebuggerCandidate,
  async (parentTabId, childTabId) => {
    const child = await chrome.tabs.get(childTabId).catch(() => null);
    if (child) await ownership.adoptOwnedChild(child, parentTabId);
  },
  (parentTabId, url) => ownership.openRequestedChild(parentTabId, url),
);
const handoff = new HandoffController(scheduler, revisions, ownership, emit);
handoff.setScrubber((tabId) => browser.discardHumanInteractionCapture(tabId));
handoff.setChallengeScanner((taskId, tabId) => browser.scanChallengeEpisodes(taskId, tabId));
// Runs inside a global scheduler slot, so it opens through the ledger directly rather than re-entering the queue.
const profile = new ProfileRuntime(async (taskId, url) => {
  const opened = await ownership.open(taskId, { mode: "create", url, background: true });
  return { tab_id: Number(opened.tab_id), page_revision: Number(opened.page_revision) };
});
const PROFILE_READ_OPERATIONS: Readonly<Record<string, true>> = {
  bookmarks_search: true,
  bookmarks_tree: true,
  history_search: true,
  sessions_recent: true,
  sessions_devices: true,
  downloads_search: true,
};

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
  if (!isRecord(completion) || (completion.kind !== "selector" && completion.kind !== "challenge_cleared")) return;
  const tab = await chrome.tabs.get(targetTabId);
  if (automationRoute(tab.pendingUrl ?? tab.url) !== "full") {
    throw restrictedOriginError(
      completion.kind === "selector" ? "wait for a handoff selector" : "wait for a handoff challenge",
    );
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

/**
 * Adds the detector's `challenge` member to a result when the tab has an active or just-ended episode.
 * A result whose operation already attached one (a wait, or an act the guard refused) is returned as is,
 * without a second scan. `observed` is an ended-episode event an earlier scan in the same operation
 * consumed; it is reported only when this scan has nothing newer to say.
 */
async function withChallenge(
  taskId: string,
  tabId: number,
  result: Record<string, unknown>,
  observed?: ChallengeEvent,
): Promise<Record<string, unknown>> {
  if (result.challenge !== undefined) return result;
  const challenge = (await browser.scanChallenge(taskId, tabId)) ?? observed;
  return challenge === undefined ? result : { ...result, challenge };
}

async function dispatch(command: NativeDispatchCommand): Promise<NativeResponse> {
  if (command.kind === "close_task" || command.kind === "finish_task") {
    try {
      const result = command.kind === "close_task"
        ? {
          task_id: command.task_id,
          closed_tab_ids: await ownership.closeTask(command.task_id),
        }
        : await ownership.finishTask(
          command.task_id,
          command.disposition,
          command.keep_tab_ids,
        );
      if (command.kind === "close_task" || result.finished === true) {
        await handoff.clearForTask(command.task_id);
        await clearChallengeTask(command.task_id).catch((error) => {
          console.warn("AgentTab challenge episode cleanup failed", error);
        });
      }
      return completed(command.request_id, result);
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
  const mutating = command.method === "browser_open" || command.method === "browser_act" || command.method === "browser_commit" || command.method === "browser_handoff" || command.method === "browser_developer" || command.method === "browser_credentials_fill" ||
    (command.method === "browser_profile" && PROFILE_READ_OPERATIONS[String(params.operation)] !== true);
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
    // Profile operations need no site access, so they bypass the automation gate and revoked
    // automation permissions; pause and disconnect still refuse them.
    if (command.method === "browser_profile") {
      if ((await readState()).paused) throw new NotStartedError("paused", "AgentTab is paused");
      if (
        params.operation === "sessions_restore" &&
        command.origin_policy !== undefined &&
        (command.origin_policy.allowed_origins.length > 0 || command.origin_policy.denied_origins.length > 0)
      ) {
        throw Object.assign(new Error("AgentTab cannot verify a restored session against the managed origin policy"), {
          code: "origin_policy_unverifiable",
        });
      }
      const execution = await scheduler.enqueueProfile(mutating, () => profile.run(command.task_id, params));
      return execution.staged
        ? commitRequired(command.request_id, execution.result, execution.staged)
        : completed(command.request_id, execution.result);
    }
    if (
      command.method === "browser_commit" &&
      typeof params.native_token === "string" &&
      (await readState()).stagedCommits[params.native_token]?.tab_id === PROFILE_STAGE_TAB_ID
    ) {
      const nativeToken = params.native_token;
      const result = await scheduler.enqueueProfile(true, () => profile.commit(command.task_id, nativeToken));
      return completed(command.request_id, result);
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
      const opened = await scheduler.enqueueGlobal(() => ownership.open(command.task_id, params));
      const settled = await settleOpenedTab(command.task_id, opened, params.mode === "create");
      return completed(
        command.request_id,
        typeof settled.tab_id === "number"
          ? await withChallenge(command.task_id, settled.tab_id, settled)
          : settled,
      );
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
      const operation = params.operation;
      if (operation === "request") {
        return completed(
          command.request_id,
          await handoff.request(
            command.task_id,
            params,
            () => assertHandoffRoute(tabId(params), params, command.origin_policy),
          ),
        );
      }
      if (operation === "status") {
        return completed(command.request_id, await handoff.status(command.task_id, String(params.notice_id)));
      }
      if (operation === "resolve") {
        return completed(command.request_id, await handoff.resolve(command.task_id, String(params.notice_id)));
      }
      if (operation === "dismiss") {
        return completed(command.request_id, await handoff.dismiss(command.task_id, String(params.notice_id)));
      }
      throw Object.assign(new Error("Unsupported browser_handoff operation"), { code: "invalid_request" });
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
    if (command.method === "browser_credentials_fill") {
      const targetTabId = tabId(params);
      const result = await scheduler.enqueueTab(command.task_id, targetTabId, async () => {
        await ownership.assertOwned(command.task_id, targetTabId);
        await assertCurrentOrigin(targetTabId, command.origin_policy);
        return browser.fillCredentials(
          command.task_id,
          targetTabId,
          params.expected_page_revision,
          params.fields,
        );
      });
      return completed(command.request_id, result);
    }
    const targetTabId = tabId(params);
    if (command.method === "browser_snapshot" || command.method === "browser_wait") {
      const result = await scheduler.readAfterWrites(targetTabId, async () => {
        if (command.method === "browser_snapshot") {
          await ownership.assertOwned(command.task_id, targetTabId);
          await assertCurrentOrigin(targetTabId, command.origin_policy);
          const snapshot = await browser.snapshot(command.task_id, targetTabId, params);
          return withChallenge(command.task_id, targetTabId, snapshot);
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
        const waited = await browser.wait(targetTabId, params, revalidate, command.task_id);
        return withChallenge(command.task_id, targetTabId, waited);
      });
      return command.method === "browser_wait" && result.status === "challenge_needs_user"
        ? needsUser(command.request_id, result)
        : completed(command.request_id, result);
    }
    if (command.method === "browser_act") {
      const actions: unknown[] = Array.isArray(params.actions) ? params.actions : [];
      const finalAction = actions.at(-1);
      const endsInNavigation = isRecord(finalAction) && NAVIGATION_ACTION_KINDS[String(finalAction.kind)] === true;
      let watch: NavigationWatch | undefined;
      try {
        const execution = await scheduler.enqueueTab(command.task_id, targetTabId, async () => {
          await ownership.assertOwned(command.task_id, targetTabId);
          assertHistoryOriginKnown(params.actions, command.origin_policy);
          await assertCurrentOrigin(targetTabId, command.origin_policy);
          // Registered before the action runs, so a fast load cannot finish unobserved.
          if (endsInNavigation) watch = watchNavigation(targetTabId);
          const execution = await browser.act(command.task_id, targetTabId, params.expected_page_revision, params.actions);
          // The navigated page is scanned once its load settles, outside this tab slot.
          if (watch !== undefined && navigationStarted(execution.result)) return execution;
          return {
            ...execution,
            result: await withChallenge(
              command.task_id,
              targetTabId,
              execution.result ?? {},
              execution.endedChallenge,
            ),
          };
        });
        if (watch !== undefined && navigationStarted(execution.result)) {
          await settleNavigation(watch, targetTabId);
          execution.result = await observeNavigatedPage(
            command.task_id,
            targetTabId,
            execution.result ?? {},
            execution.endedChallenge,
          );
        }
        if (execution.staged) {
          return commitRequired(command.request_id, execution.result ?? {}, execution.staged);
        }
        if (execution.needsUser) {
          return needsUser(command.request_id, execution.result ?? {});
        }
        return completed(command.request_id, execution.result ?? {});
      } finally {
        if (watch !== undefined) unwatchNavigation(targetTabId, watch);
      }
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
      errorDetails(normalized),
    );
  }
}

nativeBridge = new NativeBridge(
  scheduler,
  ownership,
  dispatch,
  () => handoff.restore(),
  async (nativeTokens) => {
    if (nativeTokens.length > 0) {
      await browser.discardNativeStages(nativeTokens);
      return;
    }
    await browser.abandonAllStages();
  },
);

async function initializeRuntime(): Promise<void> {
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
  scheduler.setInitialPaused(state.paused);
  if (await automationEnabled()) {
    scheduler.restorePermissions();
  } else {
    scheduler.revokePermissions();
  }
  const revokedTabIds = await ownership.reconcile();
  await Promise.all(revokedTabIds.map((tabId) => handoff.cancelForTab(tabId)));
  await Promise.all(revokedTabIds.map((tabId) => browser.detach(tabId)));
  await browser.expireCommits();
  await handoff.restore();
  await nativeBridge?.connect();
  if (automationCleanupPending) {
    void queueAutomationCleanup().catch((error) => {
      console.warn("AgentTab restored debugger cleanup failed; retry scheduled", error);
    });
  }
}

const startup = new IdempotentStartup(initializeRuntime);
const startupOperations = new StartupOperationQueue(
  startup,
  (error) => {
    console.warn("AgentTab startup failed; the next event will retry initialization", error);
  },
  (error) => {
    console.warn("AgentTab background operation failed", error);
  },
);
function start(): Promise<void> {
  return startup.start();
}

function runAfterStart(operation: () => void | Promise<void> = () => undefined): void {
  startupOperations.enqueue(operation);
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!isRecord(error)) return undefined;
  const details = {
    ...(typeof error.currentPageRevision === "number" ? { current_page_revision: error.currentPageRevision } : {}),
    ...(typeof error.failedActionIndex === "number" ? { failed_action_index: error.failedActionIndex } : {}),
    ...(Array.isArray(error.completedActions) ? { completed_actions: error.completedActions } : {}),
    ...(isRecord(error.challengeEvent) ? { challenge: error.challengeEvent } : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * Return an opened tab only after its first navigation is reflected in its page revision.
 * Chrome starts loading a created tab after `tabs.create` returns, and the queued `loading`
 * event bumps the revision; returning before that hands the caller a revision that is stale
 * on first use. A created http(s) tab waits until the event queue has processed its `complete`
 * event, which Chrome delivers after that `loading` event; `tabs.get` status alone can report
 * `complete` before the `loading` callback is delivered. The wait runs outside the global
 * scheduler because the queued tab events take ownership transitions that `browser_open`
 * would otherwise hold.
 */
async function settleOpenedTab(
  taskId: string,
  opened: Record<string, unknown>,
  created: boolean,
): Promise<Record<string, unknown>> {
  const tabId = opened.tab_id;
  if (typeof tabId !== "number") return opened;
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiters = tabLoadWaiters.get(tabId) ?? new Set<() => void>();
  waiters.add(release);
  tabLoadWaiters.set(tabId, waiters);
  let cancelDeadline: () => void = () => undefined;
  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, LOAD_SETTLE_TIMEOUT_MS);
    cancelDeadline = () => clearTimeout(timer);
  });
  try {
    const navigating = created && /^https?:/i.test(String(opened.url));
    const tab = navigating ? undefined : await chrome.tabs.get(tabId).catch(() => null);
    if (!processedTabLoads.has(tabId) && (navigating || (tab && tab.status !== "complete"))) {
      await Promise.race([loaded, deadline]);
    }
    // Tab events drain serially, so this barrier runs after any revision bump or removal already dispatched.
    await Promise.race([new Promise<void>((resolve) => runAfterStart(resolve)), deadline]);
    const settled = await ownership.describeTab(tabId).catch(() => null);
    if (!settled || (await ownership.taskIdForTab(tabId)) !== taskId) {
      throw Object.assign(new Error("The opened tab was closed or left its task before it finished loading"), {
        code: "ownership_revoked",
        recovery: "Call browser_open again.",
      });
    }
    return settled;
  } finally {
    cancelDeadline();
    waiters.delete(release);
    if (waiters.size === 0) tabLoadWaiters.delete(tabId);
  }
}

function watchNavigation(tabId: number): NavigationWatch {
  let markLoaded!: () => void;
  const loaded = new Promise<void>((resolve) => {
    markLoaded = resolve;
  });
  const watch: NavigationWatch = { started: false, loaded, markLoaded };
  const watches = navigationWatches.get(tabId) ?? new Set<NavigationWatch>();
  watches.add(watch);
  navigationWatches.set(tabId, watches);
  return watch;
}

function unwatchNavigation(tabId: number, watch: NavigationWatch): void {
  const watches = navigationWatches.get(tabId);
  watches?.delete(watch);
  if (watches?.size === 0) navigationWatches.delete(tabId);
}

/** True when the batch's last completed action started a navigation. */
function navigationStarted(result: Record<string, unknown> | undefined): boolean {
  const last = Array.isArray(result?.actions) ? result.actions.at(-1) : undefined;
  return isRecord(last) && NAVIGATION_ACTION_KINDS[String(last.kind)] === true && last.started === true;
}

/**
 * Waits for the navigation a batch's final action started, so the result can describe the page it
 * reached. `navigate`, history, and `reload` return once Chrome accepts the navigation, while the
 * previous document is often still current; a revision and challenge scan taken then describe the old
 * page. Chrome marks a tab `loading` when a cross-document navigation starts, so when the tab is loading
 * or the queue already processed its `loading` event, this waits until the queue has processed the
 * `complete` event, bounded like `browser_open`. A same-document navigation never starts a load and
 * returns at once. The wait runs outside the scheduler for the reason `settleOpenedTab` does.
 */
async function settleNavigation(watch: NavigationWatch, tabId: number): Promise<void> {
  let cancelDeadline: () => void = () => undefined;
  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, LOAD_SETTLE_TIMEOUT_MS);
    cancelDeadline = () => clearTimeout(timer);
  });
  // Tab events drain serially, so these barriers run after every event Chrome already dispatched.
  const drained = () => Promise.race([new Promise<void>((resolve) => runAfterStart(resolve)), deadline]);
  try {
    await drained();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status !== "loading" && !watch.started) return;
    await Promise.race([watch.loaded, deadline]);
    await drained();
  } finally {
    cancelDeadline();
  }
}

/**
 * The act result for the page a final navigation reached: its current revision and challenge scan.
 * The navigation already ran, so an observation that cannot complete returns the result unchanged
 * instead of failing the act.
 */
async function observeNavigatedPage(
  taskId: string,
  tabId: number,
  result: Record<string, unknown>,
  observed?: ChallengeEvent,
): Promise<Record<string, unknown>> {
  try {
    return await scheduler.readAfterWrites(tabId, async () => {
      if ((await ownership.taskIdForTab(tabId)) !== taskId) return result;
      const current = { ...result, page_revision: await revisions.current(tabId) };
      return withChallenge(taskId, tabId, current, observed);
    });
  } catch {
    return result;
  }
}

async function reconcileOwnership(): Promise<void> {
  const revokedTabIds = await ownership.reconcile();
  await Promise.all(revokedTabIds.map((tabId) => handoff.cancelForTab(tabId)));
  await Promise.all(revokedTabIds.map((tabId) => browser.detach(tabId)));
}

chrome.tabs.onCreated.addListener((tab: { id?: number; openerTabId?: number }) => {
  if (!Number.isInteger(tab.id) || !Number.isInteger(tab.openerTabId)) return;
  runAfterStart(() => ownership.adoptOwnedChild(tab));
});
chrome.tabs.onRemoved.addListener((removedTabId: number) => {
  for (const releaseWaiter of tabLoadWaiters.get(removedTabId) ?? []) releaseWaiter();
  for (const watch of navigationWatches.get(removedTabId) ?? []) watch.markLoaded();
  runAfterStart(async () => {
    // Queued after any `complete` handler for this tab, so a late handler cannot re-add it.
    processedTabLoads.delete(removedTabId);
    const owner = await ownership.taskIdForTab(removedTabId);
    if (!owner && !browser.tracksTab(removedTabId)) return;
    await handoff.cancelForTab(removedTabId);
    await browser.detach(removedTabId);
    await ownership.revoke(removedTabId, "tab_removed");
  });
});
chrome.tabs.onUpdated.addListener((updatedTabId, changeInfo) => {
  if (
    changeInfo.status !== "loading" &&
    changeInfo.status !== "complete" &&
    typeof changeInfo.url !== "string" &&
    !("groupId" in changeInfo)
  ) {
    return;
  }
  runAfterStart(async () => {
    try {
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
    } finally {
      if (changeInfo.status === "loading") {
        for (const watch of navigationWatches.get(updatedTabId) ?? []) watch.started = true;
      }
      if (changeInfo.status === "complete") {
        processedTabLoads.add(updatedTabId);
        for (const releaseWaiter of tabLoadWaiters.get(updatedTabId) ?? []) releaseWaiter();
        for (const watch of navigationWatches.get(updatedTabId) ?? []) watch.markLoaded();
      }
    }
  });
});
const reconcileOwnedTab = (tabId: number): void => {
  runAfterStart(async () => {
    if (!(await ownership.taskIdForTab(tabId)) && !browser.tracksTab(tabId)) return;
    await reconcileOwnership();
  });
};
chrome.tabs.onAttached.addListener(reconcileOwnedTab);
chrome.tabs.onDetached.addListener(reconcileOwnedTab);
chrome.tabGroups.onRemoved.addListener((group: { id?: number }) => {
  if (!Number.isInteger(group.id)) return;
  runAfterStart(async () => {
    if (!(await ownership.hasOwnedGroup(group.id as number))) return;
    await reconcileOwnership();
  });
});
chrome.runtime.onStartup.addListener(() => runAfterStart());
chrome.runtime.onInstalled.addListener(() => runAfterStart());
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
  runAfterStart(async () => {
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
  runAfterStart(async () => {
    if (alarm.name === RECONNECT_ALARM) await nativeBridge?.reconnectFromAlarm(alarm.name);
    if (alarm.name === HANDOFF_ALARM) await handoff.expire();
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
      notices: Object.values(state.notices).map((notice) => ({
        notice_id: notice.noticeId,
        task_id: notice.taskId,
        tab_id: notice.tabId,
        prompt: notice.prompt,
        status: notice.status,
        started_at_ms: notice.startedAtMs,
        expires_at_ms: notice.expiresAtMs,
      })),
      paused: state.paused,
      developer_mode: state.developerMode,
      skip_commit_review: state.skipCommitReview,

      show_agent_pointer: state.showAgentPointer,
      cleanup_policy: state.cleanupPolicy,
      tasks: Object.values(state.tasks).map((task) => ({
        task_id: task.taskId,
        name: task.name,
        state: task.state,
        color: task.color,
        tab_count: task.tabIds.length,
      })),
      reviews: Object.values(state.stagedCommits)
        .filter((staged) => typeof staged.review_handle === "string" && staged.approved !== true)
        .map((staged) => {
          const detail = profileReviewDetail(staged);
          return {
            review_handle: staged.review_handle,
            task_id: staged.task_id,
            tab_id: staged.tab_id,
            effect: staged.effect,
            expires_at_ms: staged.expires_at_ms,
            ...(detail !== undefined ? { detail } : {}),
          };
        }),
    };
  }
  if (message.kind === "set_pointer" && typeof message.enabled === "boolean") {
    const enabled = message.enabled;
    await mutateState((state) => {
      state.showAgentPointer = enabled;
    });
    return { enabled };
  }
  if (message.kind === "set_skip_commit_review" && typeof message.enabled === "boolean") {
    const enabled = message.enabled;
    await mutateState((state) => {
      state.skipCommitReview = enabled;
      if (enabled) state.stagedCommits = {};
    });
    return { enabled };
  }
  if (
    message.kind === "set_cleanup_policy" &&
    (message.policy === "automatic" || message.policy === "ask" || message.policy === "keep")
  ) {
    const policy = message.policy;
    await mutateState((state) => {
      state.cleanupPolicy = policy;
    });
    return { policy };
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
  if (message.kind === "handoff_open" && typeof message.notice_id === "string") {
    return handoff.openFromPopup(message.notice_id);
  }
  if (message.kind === "handoff_dismiss" && typeof message.notice_id === "string") {
    return handoff.dismissFromPopup(message.notice_id);
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
  if (
    (message.kind === "close_task" || message.kind === "keep_task") &&
    typeof message.task_id === "string"
  ) {
    const disposition = message.kind === "close_task" ? "close" : "keep";
    const result = await ownership.finishTask(message.task_id, disposition);
    if (result.finished === true) {
      await handoff.clearForTask(message.task_id);
      await clearChallengeTask(message.task_id).catch((error) => {
        console.warn("AgentTab challenge episode cleanup failed", error);
      });
    }
    return result;
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

runAfterStart();

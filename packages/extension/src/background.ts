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
import { MutationScheduler, NotStartedError } from "./scheduler";
import { mutateState, readState } from "./storage";
import { isRecord } from "./type-guards";

const RUNTIME_INSTANCE_ID = crypto.randomUUID();
let automationRevocationGeneration = 0;

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
  sensitive_field_requires_handoff: true,
};

const scheduler = new MutationScheduler();
const revisions = new RevisionTracker();
let nativeBridge: NativeBridge | null = null;
const emit = (event: string, payload: Record<string, unknown>, eventId?: string) =>
  nativeBridge?.sendEvent(event, payload, eventId);
const ownership = new OwnershipLedger(scheduler, revisions, emit);
let browser: StandardBrowserRuntime;
browser = new StandardBrowserRuntime(
  revisions,
  async (tabId) => {
    await ownership.revoke(tabId, "tab_removed");
    await browser.detach(tabId);
    await chrome.tabs.remove(tabId);
  },
  emit,
);
const handoff = new HandoffController(scheduler, revisions, ownership, emit);
handoff.setScrubber(() => browser.scrubForHandoff());

async function automationEnabled(): Promise<boolean> {
  const [scripting, debuggerPermission] = await Promise.all([
    chrome.permissions.contains({ permissions: ["scripting"] }),
    chrome.permissions.contains({ permissions: ["debugger"] }),
  ]);
  return scripting && debuggerPermission;
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
      throw Object.assign(new Error("AgentTab automation permissions have not been enabled"), {
        code: "permissions_required",
        recovery: "Open the AgentTab popup and choose Enable automation.",
      });
    }
    if (command.method === "browser_open") {
      return completed(command.request_id, await scheduler.enqueueGlobal(() => ownership.open(command.task_id, params)));
    }
    if (command.method === "browser_tabs") {
      const result = await scheduler.enqueueGlobal(() => ownership.inventory());
      return completed(command.request_id, {
        tabs: result.filter((tab) => tab.task_id === command.task_id),
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
          () => assertCurrentOrigin(tabId(params), command.origin_policy),
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
    const code = error instanceof NotStartedError ? error.code : errorCode(error);
    return failed(
      command.request_id,
      code,
      error instanceof Error ? error.message : String(error),
      errorOutcome(error, mutating, code),
      errorRecovery(error),
      isRecord(error) && typeof error.currentPageRevision === "number"
        ? { current_page_revision: error.currentPageRevision }
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
);

let startup: Promise<void> | null = null;
function start(): Promise<void> {
  if (startup) return startup;
  startup = (async () => {
    const state = await readState();
    scheduler.setInitialPaused(state.paused || state.handoff.active);
    if (!(await automationEnabled())) scheduler.revokePermissions();
    await ownership.reconcile();
    await browser.expireCommits();
    await handoff.restore();
    await nativeBridge?.connect();
  })();
  return startup;
}

chrome.tabs.onCreated.addListener((tab: { id?: number; openerTabId?: number }) => {
  void start().then(() => ownership.adoptOwnedChild(tab));
});
chrome.tabs.onRemoved.addListener((removedTabId: number) => {
  void start().then(async () => {
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
    if ("groupId" in changeInfo) await ownership.revokeIfMoved(updatedTabId);
    if (typeof changeInfo.url === "string" || changeInfo.status === "complete") {
      await ownership.publishInventory();
    }
  });
});
chrome.tabs.onAttached.addListener(() => void start().then(() => ownership.reconcile()));
chrome.tabs.onDetached.addListener(() => void start().then(() => ownership.reconcile()));
chrome.tabGroups.onRemoved.addListener(() => void start().then(() => ownership.reconcile()));
chrome.runtime.onStartup.addListener(() => void start());
chrome.runtime.onInstalled.addListener(() => void start());
chrome.permissions.onRemoved.addListener((permissions) => {
  if (!permissions.permissions?.some((permission) => permission === "scripting" || permission === "debugger")) {
    return;
  }
  scheduler.revokePermissions();
  automationRevocationGeneration += 1;
  void start().then(() => browser.scrubForHandoff());
});

chrome.permissions.onAdded.addListener((permissions) => {
  if (!permissions.permissions?.some((permission) => permission === "scripting" || permission === "debugger")) {
    return;
  }
  void automationEnabled().then((enabled) => {
    if (enabled) scheduler.restorePermissions();
  });
});
chrome.alarms.onAlarm.addListener((alarm: { name: string }) => {
  void start().then(async () => {
    if (alarm.name === RECONNECT_ALARM) await nativeBridge?.reconnectFromAlarm(alarm.name);
    if (alarm.name === HANDOFF_ALARM) await handoff.finish(false);
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
        focus_tab_id: task.tabIds[0] ?? null,
      })),
    };
  }
  if (message.kind === "focus_task" && typeof message.task_id === "string") {
    const task = (await readState()).tasks[message.task_id];
    const tabId = task?.tabIds[0];
    if (!Number.isInteger(tabId)) return { focused: false };
    const tab = await chrome.tabs.update(Number(tabId), { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return { focused: true };
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
  if (message.kind === "close_task" && typeof message.task_id === "string") {
    await ownership.closeTask(message.task_id);
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

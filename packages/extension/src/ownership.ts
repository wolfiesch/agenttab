import { MutationScheduler } from "./scheduler";
import { mutateState, readState, type TaskColor, type TaskRecord } from "./storage";
import { automationRouteFields } from "./routes";
import { RevisionTracker } from "./revisions";

const GROUP_COLORS: readonly TaskColor[] = ["purple", "cyan", "green", "yellow", "orange", "red", "pink", "blue"];
const NO_GROUP = -1;

type EventSink = (event: string, payload: Record<string, unknown>) => void;

interface TabLike {
  id?: number;
  windowId?: number;
  groupId?: number;
  openerTabId?: number;
  active?: boolean;
  url?: string;
  pendingUrl?: string;
  lastAccessed?: number;
  splitViewId?: number;
}

function taskColor(taskId: string): TaskColor {
  let hash = 2166136261;
  for (const character of taskId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return GROUP_COLORS[(hash >>> 0) % GROUP_COLORS.length];
}

function groupTitle(task: TaskRecord, developerMode: boolean): string {
  const symbol = task.state === "completed" ? "✓" : task.state === "needs_user" ? "↗" : "✦";
  const mode = developerMode ? "DEV " : "";
  return `${symbol} ${mode}${task.name}`.slice(0, 40);
}

export class OwnershipLedger {
  private transitionTail: Promise<unknown> = Promise.resolve();
  private inventoryTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly scheduler: MutationScheduler,
    private readonly revisions: RevisionTracker,
    private readonly emit: EventSink,
  ) { }

  reconcile(): Promise<number[]> {
    return this.serialize(() => this.reconcileNow());
  }

  assertOwned(taskId: string, tabId: number): Promise<TaskRecord> {
    return this.serialize(() => this.assertOwnedNow(taskId, tabId));
  }

  assertOwnedTab(tabId: number): Promise<TaskRecord> {
    return this.serialize(async () => {
      const state = await readState();
      const task = Object.values(state.tasks).find((candidate) => candidate.tabIds.includes(tabId));
      if (!task) {
        throw Object.assign(new Error("Tab is not owned by AgentTab"), {
          code: "ownership_denied",
        });
      }
      return this.assertOwnedNow(task.taskId, tabId);
    });
  }

  open(taskId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.serialize(() => this.openNow(taskId, params));
  }

  adoptActive(taskId: string): Promise<Record<string, unknown>> {
    return this.serialize(() => this.adoptActiveNow(taskId));
  }

  adoptOwnedChild(tab: TabLike, sourceTabId?: number): Promise<void> {
    return this.serialize(() => this.adoptOwnedChildNow(tab, sourceTabId));
  }

  revokeIfMoved(tabId: number): Promise<boolean> {
    return this.serialize(() => this.revokeIfMovedNow(tabId));
  }

  revoke(
    tabId: number,
    event: "ownership_revoked" | "group_membership_changed" | "tab_removed",
  ): Promise<boolean> {
    return this.serialize(() => this.revokeNow(tabId, event));
  }

  closeTask(taskId: string): Promise<number[]> {
    return this.serialize(() => this.closeTaskNow(taskId));
  }

  async setTaskState(
    taskId: string,
    taskState: "working" | "needs_user" | "completed",
  ): Promise<void> {
    const updated = await mutateState((state) => {
      const task = state.tasks[taskId];
      if (!task) return null;
      task.state = taskState;
      task.updatedAt = Date.now();
      return {
        groupId: task.groupId,
        title: groupTitle(task, state.developerMode),
        color: task.color,
      };
    });
    if (updated?.groupId !== null && updated?.groupId !== undefined) {
      await chrome.tabGroups.update(updated.groupId, {
        title: updated.title,
        color: updated.color,
        collapsed: false,
      }).catch(() => undefined);
    }
  }

  async setDeveloperMode(enabled: boolean): Promise<void> {
    const tasks = await mutateState((state) => {
      state.developerMode = enabled;
      return Object.values(state.tasks).map((task) => ({
        groupId: task.groupId,
        title: groupTitle(task, enabled),
        color: task.color,
      }));
    });
    await Promise.all(
      tasks
        .filter((task): task is typeof task & { groupId: number } => task.groupId !== null)
        .map((task) =>
          chrome.tabGroups.update(task.groupId, {
            title: task.title,
            color: task.color,
            collapsed: false,
          }).catch(() => undefined),
        ),
    );
  }

  async inventory(): Promise<Array<Record<string, unknown>>> {
    const state = await readState();
    const tabs = (await chrome.tabs.query({})) as TabLike[];
    const byId = new Map(
      tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => [tab.id as number, tab]),
    );
    const inventory: Array<Record<string, unknown>> = [];
    for (const task of Object.values(state.tasks)) {
      if (task.groupId === null) continue;
      for (const tabId of task.tabIds) {
        const tab = byId.get(tabId);
        if (!tab || tab.groupId !== task.groupId || !Number.isInteger(tab.windowId)) continue;
        const url = tab.pendingUrl || tab.url;
        if (!url) continue;
        inventory.push({
          tab_id: tabId,
          window_id: tab.windowId,
          group_id: task.groupId,
          url,
          page_revision: await this.revisions.ensure(tabId),
          task_id: task.taskId,
        });
      }
    }
    return inventory;
  }

  async publishInventory(): Promise<void> {
    await this.emitInventory();
  }

  async taskIdForTab(tabId: number): Promise<string | null> {
    const state = await readState();
    const task = Object.values(state.tasks).find((candidate) => candidate.tabIds.includes(tabId));
    return task?.groupId === null ? null : task?.taskId ?? null;
  }

  async hasOwnedGroup(groupId: number): Promise<boolean> {
    const state = await readState();
    return Object.values(state.tasks).some((task) => task.groupId === groupId);
  }

  private async reconcileNow(): Promise<number[]> {
    const tabs = (await chrome.tabs.query({})) as TabLike[];
    const byId = new Map(
      tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => [tab.id as number, tab]),
    );
    const changedTasks: Array<{ taskId: string; count: number; revokedTabIds: number[] }> = [];
    await mutateState((state) => {
      for (const task of Object.values(state.tasks)) {
        const revokedTabIds = task.tabIds.filter((tabId) => {
          const tab = byId.get(tabId);
          return !tab || task.groupId === null || tab.groupId !== task.groupId;
        });
        if (revokedTabIds.length === 0) continue;
        for (const tabId of revokedTabIds) this.scheduler.revokeTab(tabId);
        task.tabIds = task.tabIds.filter((tabId) => !revokedTabIds.includes(tabId));
        if (task.tabIds.length === 0) task.groupId = null;
        task.updatedAt = Date.now();
        changedTasks.push({ taskId: task.taskId, count: task.tabIds.length, revokedTabIds });
      }
    });
    for (const changed of changedTasks) {
      for (const tabId of changed.revokedTabIds) await this.revisions.remove(tabId);
      this.emit("ownership_revoked", { task_id: changed.taskId, tab_count: changed.count });
    }
    await this.emitInventory();
    return changedTasks.flatMap((changed) => changed.revokedTabIds);
  }

  private async assertOwnedNow(taskId: string, tabId: number): Promise<TaskRecord> {
    const state = await readState();
    const task = state.tasks[taskId];
    const ownerCount = Object.values(state.tasks).filter((candidate) => candidate.tabIds.includes(tabId)).length;
    if (!task || !task.tabIds.includes(tabId) || task.groupId === null || ownerCount !== 1) {
      throw Object.assign(new Error("Tab is not owned by this AgentTab task"), {
        code: "ownership_denied",
      });
    }
    const tab = (await chrome.tabs.get(tabId).catch(() => null)) as TabLike | null;
    if (!tab || tab.groupId !== task.groupId) {
      await this.revokeNow(tabId, "ownership_revoked");
      throw Object.assign(new Error("Tab left its AgentTab task group"), {
        code: "ownership_revoked",
      });
    }
    const current = await readState();
    const currentTask = current.tasks[taskId];
    if (
      !currentTask ||
      currentTask.groupId !== task.groupId ||
      !currentTask.tabIds.includes(tabId) ||
      Object.values(current.tasks).filter((candidate) => candidate.tabIds.includes(tabId)).length !== 1
    ) {
      throw Object.assign(new Error("Tab ownership changed while it was being checked"), {
        code: "ownership_revoked",
      });
    }
    return currentTask;
  }

  private async openNow(taskId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (params.mode === "adopt_active") return this.adoptActiveNow(taskId);
    if (params.mode !== "create") {
      throw Object.assign(new Error("browser_open mode must be create or adopt_active"), {
        code: "invalid_request",
      });
    }
    const placement = params.placement ?? "task";
    if (placement !== "task" && placement !== "new_window") {
      throw Object.assign(new Error("browser_open placement must be task or new_window"), {
        code: "invalid_request",
      });
    }
    if (placement === "new_window" && params.background === false) {
      throw Object.assign(new Error("A new task window must open in the background"), {
        code: "invalid_request",
        recovery: "Use browser_handoff when the human needs to focus the task tab.",
      });
    }
    const url = typeof params.url === "string" ? params.url : "about:blank";
    const active = params.background === false;
    const existingTask = (await readState()).tasks[taskId];
    let tab: TabLike;
    if (placement === "new_window") {
      if (existingTask && existingTask.tabIds.length > 0) {
        throw Object.assign(new Error("A task window can be created only before the task owns tabs"), {
          code: "task_window_conflict",
          recovery: "Use placement task for this task, or create a new task for a separate window.",
        });
      }
      tab = await this.createTabInDedicatedWindow(url);
    } else {
      let taskWindowId: number | undefined;
      if (existingTask && existingTask.groupId !== null) {
        for (const tabId of existingTask.tabIds) {
          const candidate = (await chrome.tabs.get(tabId).catch(() => null)) as TabLike | null;
          if (candidate?.groupId === existingTask.groupId && Number.isInteger(candidate.windowId)) {
            taskWindowId = candidate.windowId;
            break;
          }
        }
      }
      tab = await this.createTabInUsableWindow(url, active, taskWindowId);
    }
    const createdTabId = tab.id;
    if (createdTabId === undefined) throw new Error("Chrome did not return a created tab ID");
    try {
      await this.grant(taskId, createdTabId, `Task ${taskId.slice(0, 8)}`);
    } catch (error) {
      await chrome.tabs.remove(createdTabId).catch(() => undefined);
      throw error;
    }
    return this.tabResult(createdTabId);
  }

  private async adoptActiveNow(taskId: string): Promise<Record<string, unknown>> {
    const [tab] = (await chrome.tabs.query({ active: true, currentWindow: true })) as TabLike[];
    if (!tab || !Number.isInteger(tab.id)) {
      throw Object.assign(new Error("Chrome has no active tab to adopt"), {
        code: "no_active_tab",
      });
    }
    const tabId = tab.id as number;
    await this.grant(taskId, tabId, `Adopted ${taskId.slice(0, 8)}`);
    if (chrome.action?.setBadgeText) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#6d5dfc" }).catch(() => undefined);
      await chrome.action.setBadgeText({ tabId, text: "✦" }).catch(() => undefined);
      setTimeout(() => void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined), 2000);
    }
    return this.tabResult(tabId);
  }

  private async adoptOwnedChildNow(tab: TabLike, sourceTabId?: number): Promise<void> {
    const childTabId = tab.id;
    const openerTabId = sourceTabId ?? tab.openerTabId;
    if (
      typeof childTabId !== "number" ||
      !Number.isInteger(childTabId) ||
      typeof openerTabId !== "number" ||
      !Number.isInteger(openerTabId)
    ) {
      return;
    }

    const state = await readState();
    const parentTask = Object.values(state.tasks).find((task) => task.tabIds.includes(openerTabId));
    if (!parentTask) return;

    let ownedParent: TaskRecord;
    try {
      ownedParent = await this.assertOwnedNow(parentTask.taskId, openerTabId);
    } catch {
      return;
    }

    try {
      const parent = (await chrome.tabs.get(openerTabId).catch(() => null)) as TabLike | null;
      const child = (await chrome.tabs.get(childTabId).catch(() => null)) as TabLike | null;
      if (!parent || !child) return;
      if (
        sourceTabId === undefined &&
        child.groupId !== undefined &&
        child.groupId !== NO_GROUP &&
        child.groupId !== ownedParent.groupId
      ) {
        return;
      }
      if (
        Number.isInteger(parent.windowId) &&
        Number.isInteger(child.windowId) &&
        parent.windowId !== child.windowId
      ) {
        const [activeDestination] = (await chrome.tabs.query({
          active: true,
          windowId: parent.windowId,
        })) as TabLike[];
        await chrome.tabs.move(childTabId, {
          windowId: parent.windowId as number,
          index: -1,
        });
        if (Number.isInteger(activeDestination?.id)) {
          await chrome.tabs.update(activeDestination.id as number, { active: true }).catch(() => undefined);
        }
      }
      await this.grant(ownedParent.taskId, childTabId, ownedParent.name);
    } catch {
      // A popup or Chrome grouping race is not authority to close a user tab.
    }
  }

  private async revokeIfMovedNow(tabId: number): Promise<boolean> {
    const state = await readState();
    const task = Object.values(state.tasks).find((candidate) => candidate.tabIds.includes(tabId));
    if (!task) return false;
    const tab = (await chrome.tabs.get(tabId).catch(() => null)) as TabLike | null;
    if (!tab || task.groupId === null || tab.groupId !== task.groupId) {
      return this.revokeNow(tabId, "group_membership_changed");
    }
    return false;
  }

  private async revokeNow(
    tabId: number,
    event: "ownership_revoked" | "group_membership_changed" | "tab_removed",
  ): Promise<boolean> {
    this.scheduler.revokeTab(tabId);
    const changed = await mutateState((state) => {
      for (const task of Object.values(state.tasks)) {
        if (!task.tabIds.includes(tabId)) continue;
        task.tabIds = task.tabIds.filter((ownedTabId) => ownedTabId !== tabId);
        if (task.tabIds.length === 0) task.groupId = null;
        task.updatedAt = Date.now();
        return { taskId: task.taskId, count: task.tabIds.length };
      }
      return null;
    });
    if (!changed) return false;
    await this.revisions.remove(tabId);
    this.emit(event, {
      task_id: changed.taskId,
      tab_count: changed.count,
    });
    await this.emitInventory();
    return true;
  }

  private async closeTaskNow(taskId: string): Promise<number[]> {
    const existing = (await readState()).tasks[taskId];
    if (!existing) return [];
    for (const tabId of existing.tabIds) this.scheduler.revokeTab(tabId);
    const tabIds = await mutateState((state) => {
      const task = state.tasks[taskId];
      if (!task) return [];
      const ownedTabIds = [...task.tabIds];
      delete state.tasks[taskId];
      for (const [token, staged] of Object.entries(state.stagedCommits)) {
        if (staged.task_id === taskId) delete state.stagedCommits[token];
      }
      for (const [key, allowance] of Object.entries(state.policyAllowances)) {
        if (allowance.scope === "task" && allowance.taskId === taskId) {
          delete state.policyAllowances[key];
        }
      }
      return ownedTabIds;
    });
    for (const tabId of tabIds) await this.revisions.remove(tabId);
    const closedTabIds: number[] = [];
    for (const tabId of tabIds) {
      try {
        await chrome.tabs.remove(tabId);
        closedTabIds.push(tabId);
      } catch {
        // Ownership is already durably removed; a missing/closed tab is safe.
      }
    }
    this.emit("tab_removed", { task_id: taskId, tab_count: 0 });
    await this.emitInventory();
    return closedTabIds;
  }

  private async grant(taskId: string, tabId: number, name: string): Promise<void> {
    const before = (await chrome.tabs.get(tabId)) as TabLike;
    const state = await readState();
    const currentOwner = Object.values(state.tasks).find((task) => task.tabIds.includes(tabId));
    if (currentOwner && currentOwner.taskId !== taskId) {
      throw Object.assign(new Error("Tab is already owned by another AgentTab task"), {
        code: "ownership_denied",
      });
    }
    if (currentOwner && currentOwner.groupId === before.groupId && before.groupId !== NO_GROUP) {
      await this.revisions.ensure(tabId);
      return;
    }
    if (currentOwner) await this.revokeNow(tabId, "ownership_revoked");

    const refreshed = await readState();
    const refreshedTask = refreshed.tasks[taskId];
    let groupId: number;
    try {
      if (refreshedTask?.groupId !== null && refreshedTask?.groupId !== undefined) {
        groupId = await chrome.tabs.group({ tabIds: [tabId], groupId: refreshedTask.groupId });
      } else {
        groupId = await chrome.tabs.group({ tabIds: [tabId] });
      }
      const previewTask: TaskRecord = refreshedTask ?? {
        taskId,
        name,
        groupId,
        tabIds: [],
        color: taskColor(taskId),
        state: "working",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await chrome.tabGroups.update(groupId, {
        title: groupTitle(previewTask, refreshed.developerMode),
        color: previewTask.color,
        collapsed: false,
      });
      const grouped = (await chrome.tabs.get(tabId)) as TabLike;
      if (grouped.groupId !== groupId) throw new Error("Chrome did not preserve the requested tab group");
      await this.revisions.ensure(tabId);
      await mutateState((next) => {
        const conflictingTask = Object.values(next.tasks).find(
          (task) => task.taskId !== taskId && task.tabIds.includes(tabId),
        );
        if (conflictingTask) {
          throw Object.assign(new Error("Tab ownership changed while grouping"), {
            code: "ownership_denied",
          });
        }
        const task = next.tasks[taskId] ?? previewTask;
        task.groupId = groupId;
        if (!task.tabIds.includes(tabId)) task.tabIds.push(tabId);
        task.updatedAt = Date.now();
        next.tasks[taskId] = task;
      });
    } catch (error) {
      if (before.groupId !== undefined && before.groupId >= 0) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: before.groupId }).catch(() => undefined);
      } else {
        await chrome.tabs.ungroup([tabId]).catch(() => undefined);
      }
      if (error instanceof Error && "code" in error) throw error;
      throw Object.assign(new Error(`Could not visibly group AgentTab tab: ${String(error)}`), {
        code: "grouping_failed",
      });
    }
    this.emit("group_membership_changed", {
      task_id: taskId,
      tab_count: (await readState()).tasks[taskId]?.tabIds.length ?? 0,
    });
    await this.emitInventory();
  }

  private async createTabInDedicatedWindow(url: string): Promise<TabLike> {
    let windowId: number | undefined;
    let tabId: number | undefined;
    try {
      const createdWindow = await chrome.windows.create({
        url,
        focused: false,
        type: "normal",
        state: "normal",
      });
      if (!createdWindow) throw new Error("Chrome did not return a created window");
      windowId = createdWindow.id;
      const tab = createdWindow.tabs?.[0] as TabLike | undefined;
      tabId = tab?.id;
      if (!Number.isInteger(windowId) || !Number.isInteger(tabId)) {
        throw new Error("Chrome did not return a window and tab ID");
      }
      await chrome.windows.update(windowId as number, {
        focused: false,
        state: "normal",
      });
      return tab as TabLike;
    } catch (error) {
      if (tabId !== undefined) {
        await chrome.tabs.remove(tabId).catch(() => undefined);
      } else if (windowId !== undefined) {
        await chrome.windows.remove(windowId).catch(() => undefined);
      }
      throw Object.assign(new Error(`Could not create a background task window: ${String(error)}`), {
        code: "window_creation_failed",
        recovery: "Retry with placement task, or create a new task window after Chrome can open a normal window.",
      });
    }
  }

  private async createTabInUsableWindow(
    url: string,
    active: boolean,
    preferredWindowId?: number,
  ): Promise<TabLike> {
    if (preferredWindowId !== undefined) {
      return chrome.tabs.create({ windowId: preferredWindowId, url, active });
    }
    const windows = (await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] })) as Array<{
      id?: number;
      tabs?: TabLike[];
    }>;
    const noSplit = chrome.tabs.SPLIT_VIEW_ID_NONE ?? NO_GROUP;
    const usable = windows
      .map((window) => ({
        window,
        activeTab: window.tabs?.find((tab) => tab.active),
      }))
      .filter(({ window, activeTab }) =>
        Number.isInteger(window.id) && (!activeTab || activeTab.splitViewId === undefined || activeTab.splitViewId === noSplit),
      )
      .sort((left, right) => (right.activeTab?.lastAccessed ?? 0) - (left.activeTab?.lastAccessed ?? 0))[0];
    if (usable?.window.id !== undefined) {
      return chrome.tabs.create({ windowId: usable.window.id, url, active });
    }
    const createdWindow = await chrome.windows.create({ url, focused: active, type: "normal" });
    const tab = createdWindow?.tabs?.[0];
    if (!tab) throw new Error("Chrome did not create a tab in the fallback window");
    return tab;
  }

  private async tabResult(tabId: number): Promise<Record<string, unknown>> {
    const tab = (await chrome.tabs.get(tabId)) as TabLike;
    const state = await readState();
    const owner = Object.values(state.tasks).find((task) => task.tabIds.includes(tabId));
    const url = tab.pendingUrl ?? tab.url ?? "";
    return {
      tab_id: tabId,
      window_id: tab.windowId,
      group_id: tab.groupId,
      url,
      page_revision: await this.revisions.current(tabId),
      tab_count: owner?.tabIds.length ?? 0,
      ...automationRouteFields(url),
    };
  }

  private async emitInventory(): Promise<void> {
    const publication = this.inventoryTail.then(async () => {
      this.emit("inventory", { inventory: await this.inventory() });
    });
    this.inventoryTail = publication.catch(() => undefined);
    await publication;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transitionTail.then(operation);
    this.transitionTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

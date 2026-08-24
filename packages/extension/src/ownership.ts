import { MutationScheduler } from "./scheduler";
import { mutateState, readState, type TaskColor, type TaskRecord } from "./storage";
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

  constructor(
    private readonly scheduler: MutationScheduler,
    private readonly revisions: RevisionTracker,
    private readonly emit: EventSink,
  ) { }

  reconcile(): Promise<void> {
    return this.serialize(() => this.reconcileNow());
  }

  assertOwned(taskId: string, tabId: number): Promise<TaskRecord> {
    return this.serialize(() => this.assertOwnedNow(taskId, tabId));
  }

  open(taskId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.serialize(() => this.openNow(taskId, params));
  }

  adoptActive(taskId: string): Promise<Record<string, unknown>> {
    return this.serialize(() => this.adoptActiveNow(taskId));
  }

  adoptOwnedChild(tab: TabLike): Promise<void> {
    return this.serialize(() => this.adoptOwnedChildNow(tab));
  }

  revokeIfMoved(tabId: number): Promise<void> {
    return this.serialize(() => this.revokeIfMovedNow(tabId));
  }

  revoke(
    tabId: number,
    event: "ownership_revoked" | "group_membership_changed" | "tab_removed",
  ): Promise<void> {
    return this.serialize(() => this.revokeNow(tabId, event));
  }

  closeTask(taskId: string): Promise<void> {
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
        const url = tab.url || tab.pendingUrl;
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

  private async reconcileNow(): Promise<void> {
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
    const url = typeof params.url === "string" ? params.url : "about:blank";
    const active = params.background === false;
    const tab = await this.createTabInUsableWindow(url, active);
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

  private async adoptOwnedChildNow(tab: TabLike): Promise<void> {
    const childTabId = tab.id;
    if (typeof childTabId !== "number" || !Number.isInteger(childTabId)) return;

    const state = await readState();
    const openerTabId = tab.openerTabId;
    let parentTask = typeof openerTabId === "number" && Number.isInteger(openerTabId)
      ? Object.values(state.tasks).find((task) => task.tabIds.includes(openerTabId))
      : undefined;
    if (!parentTask && typeof tab.groupId === "number" && tab.groupId !== NO_GROUP) {
      parentTask = Object.values(state.tasks).find((task) => task.groupId === tab.groupId);
    }
    if (!parentTask) return;

    let ownedParent: TaskRecord | null = null;
    let ownedParentTabId: number | null = null;
    const candidateParentTabIds = typeof openerTabId === "number" &&
      parentTask.tabIds.includes(openerTabId)
      ? [openerTabId]
      : parentTask.tabIds;
    for (const candidateTabId of candidateParentTabIds) {
      try {
        ownedParent = await this.assertOwnedNow(parentTask.taskId, candidateTabId);
        ownedParentTabId = candidateTabId;
        break;
      } catch {
        // A child already placed in the task group can use any still-valid task tab as its anchor.
      }
    }
    if (!ownedParent || ownedParentTabId === null) return;

    try {
      const parent = (await chrome.tabs.get(ownedParentTabId).catch(() => null)) as TabLike | null;
      const child = (await chrome.tabs.get(childTabId).catch(() => null)) as TabLike | null;
      if (!parent || !child) {
        if (child) await chrome.tabs.remove(childTabId).catch(() => undefined);
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
        await chrome.windows.update(parent.windowId as number, { focused: true }).catch(() => undefined);
      }
      await this.grant(ownedParent.taskId, childTabId, ownedParent.name);
    } catch {
      await chrome.tabs.remove(childTabId).catch(() => undefined);
    }
  }

  private async revokeIfMovedNow(tabId: number): Promise<void> {
    const state = await readState();
    const task = Object.values(state.tasks).find((candidate) => candidate.tabIds.includes(tabId));
    if (!task) return;
    const tab = (await chrome.tabs.get(tabId).catch(() => null)) as TabLike | null;
    if (!tab || task.groupId === null || tab.groupId !== task.groupId) {
      await this.revokeNow(tabId, "group_membership_changed");
    }
  }

  private async revokeNow(
    tabId: number,
    event: "ownership_revoked" | "group_membership_changed" | "tab_removed",
  ): Promise<void> {
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
    if (!changed) return;
    await this.revisions.remove(tabId);
    this.emit(event, {
      task_id: changed.taskId,
      tab_count: changed.count,
    });
    await this.emitInventory();
  }

  private async closeTaskNow(taskId: string): Promise<void> {
    const existing = (await readState()).tasks[taskId];
    if (!existing) return;
    for (const tabId of existing.tabIds) this.scheduler.revokeTab(tabId);
    const tabIds = await mutateState((state) => {
      const task = state.tasks[taskId];
      if (!task) return [];
      const ownedTabIds = [...task.tabIds];
      delete state.tasks[taskId];
      for (const [token, staged] of Object.entries(state.stagedCommits)) {
        if (staged.task_id === taskId) delete state.stagedCommits[token];
      }
      return ownedTabIds;
    });
    for (const tabId of tabIds) await this.revisions.remove(tabId);
    if (tabIds.length > 0) await chrome.tabs.remove(tabIds).catch(() => undefined);
    this.emit("tab_removed", { task_id: taskId, tab_count: 0 });
    await this.emitInventory();
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

  private async createTabInUsableWindow(url: string, active: boolean): Promise<TabLike> {
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
    return {
      tab_id: tabId,
      window_id: tab.windowId,
      group_id: tab.groupId,
      url: tab.url ?? "",
      page_revision: await this.revisions.current(tabId),
      tab_count: owner?.tabIds.length ?? 0,
    };
  }

  private async emitInventory(): Promise<void> {
    this.emit("inventory", { inventory: await this.inventory() });
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

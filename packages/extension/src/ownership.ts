import { MutationScheduler } from "./scheduler";
import { mutateState, readState, type TaskColor, type TaskRecord } from "./storage";
import { automationRouteFields } from "./routes";
import { RevisionTracker } from "./revisions";

const GROUP_COLORS: readonly TaskColor[] = ["purple", "cyan", "green", "yellow", "orange", "red", "pink", "blue"];
const NO_GROUP = -1;
const OWNERSHIP_REVOKED = {
  code: "ownership_revoked",
  message: "Tab ownership changed before this operation was dispatched",
};

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
  private globalTransitionTail: Promise<unknown> = Promise.resolve();
  private readonly actorTransitionTails = new Map<string, Promise<unknown>>();
  private readonly cosmeticTransitionTails = new Map<string, Promise<unknown>>();
  private inventoryTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly scheduler: MutationScheduler,
    private readonly revisions: RevisionTracker,
    private readonly emit: EventSink,
  ) { }

  reconcile(): Promise<number[]> {
    return this.serializeGlobal(() => this.reconcileNow());
  }

  assertOwned(taskId: string, tabId: number): Promise<TaskRecord> {
    return this.serializeActors(
      [this.taskActor(taskId), this.tabActor(tabId)],
      () => this.assertOwnedNow(taskId, tabId),
    );
  }

  async assertOwnedTab(tabId: number): Promise<TaskRecord> {
    const taskId = await this.taskIdForTab(tabId);
    return this.serializeActors(this.owningTabActors(tabId, taskId), async () => {
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
    return this.serializeActor(this.taskActor(taskId), () => this.openNow(taskId, params));
  }

  adoptActive(taskId: string): Promise<Record<string, unknown>> {
    return this.serializeActor(this.taskActor(taskId), () => this.adoptActiveNow(taskId));
  }

  async adoptOwnedChild(tab: TabLike, sourceTabId?: number): Promise<void> {
    const childTabId = Number.isInteger(tab.id) ? tab.id as number : -1;
    const openerTabId = Number.isInteger(sourceTabId)
      ? sourceTabId as number
      : Number.isInteger(tab.openerTabId)
        ? tab.openerTabId as number
        : null;
    const taskId = openerTabId === null ? null : await this.taskIdForTab(openerTabId);
    const actors = [this.tabActor(childTabId)];
    if (openerTabId !== null) actors.push(this.tabActor(openerTabId));
    if (taskId !== null) actors.push(this.taskActor(taskId));
    return this.serializeActors(
      actors,
      () => this.adoptOwnedChildNow(tab, sourceTabId),
    );
  }

  async revokeIfMoved(tabId: number): Promise<boolean> {
    const taskId = await this.taskIdForTab(tabId);
    return this.serializeActors(
      this.owningTabActors(tabId, taskId),
      () => this.serializeCosmeticActors(
        this.owningTabActors(tabId, taskId),
        () => this.revokeIfMovedNow(tabId),
      ),
    );
  }

  async revoke(
    tabId: number,
    event: "ownership_revoked" | "group_membership_changed" | "tab_removed",
  ): Promise<boolean> {
    const taskId = await this.taskIdForTab(tabId);
    return this.serializeActors(
      this.owningTabActors(tabId, taskId),
      () => this.serializeCosmeticActors(
        this.owningTabActors(tabId, taskId),
        () => this.revokeNow(tabId, event),
      ),
    );
  }

  closeTask(taskId: string): Promise<number[]> {
    return this.scheduler.enqueueTaskClose(
      taskId,
      () => this.closeTaskAfterDrainingTabs(taskId),
    );
  }

  setTaskState(
    taskId: string,
    taskState: "working" | "needs_user" | "completed",
  ): Promise<void> {
    return this.serializeActor(
      this.taskActor(taskId),
      async () => {
        const task = (await readState()).tasks[taskId];
        const actors = [
          this.taskActor(taskId),
          ...(task?.tabIds ?? []).map((tabId) => this.tabActor(tabId)),
        ];
        return this.serializeCosmeticActors(
          actors,
          () => this.setTaskStateNow(taskId, taskState),
        );
      },
    );
  }

  private async setTaskStateNow(
    taskId: string,
    taskState: "working" | "needs_user" | "completed",
  ): Promise<void> {
    const updated = await mutateState((state) => {
      const task = state.tasks[taskId];
      if (!task) return null;
      task.state = taskState;
      task.updatedAt = Date.now();
      return {
        taskId: task.taskId,
        groupId: task.groupId,
        title: groupTitle(task, state.developerMode),
        color: task.color,
      };
    });
    if (updated?.groupId === null || updated?.groupId === undefined) return;
    const groupId = updated.groupId;
    const current = (await readState()).tasks[updated.taskId];
    if (!current || current.groupId !== groupId) return;
    if (await this.groupContainsOwnedTab(groupId, current.tabIds)) {
      await chrome.tabGroups.update(groupId, {
        title: updated.title,
        color: updated.color,
        collapsed: false,
      }).catch(() => undefined);
    } else {
      await this.clearCosmeticGroup(updated.taskId, groupId);
    }
  }

  setDeveloperMode(enabled: boolean): Promise<void> {
    return this.serializeGlobal(() => this.setDeveloperModeNow(enabled));
  }

  private async setDeveloperModeNow(enabled: boolean): Promise<void> {
    const tasks = await mutateState((state) => {
      state.developerMode = enabled;
      return Object.values(state.tasks).map((task) => ({
        taskId: task.taskId,
        groupId: task.groupId,
        tabIds: [...task.tabIds],
        title: groupTitle(task, enabled),
        color: task.color,
      }));
    });
    await Promise.all(
      tasks.map(async (task) => {
        if (task.groupId === null) return;
        if (await this.groupContainsOwnedTab(task.groupId, task.tabIds)) {
          await chrome.tabGroups.update(task.groupId, {
            title: task.title,
            color: task.color,
            collapsed: false,
          }).catch(() => undefined);
        } else {
          await this.clearCosmeticGroup(task.taskId, task.groupId);
        }
      }),
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
      for (const tabId of task.tabIds) {
        const tab = byId.get(tabId);
        if (!tab || !Number.isInteger(tab.windowId)) continue;
        const url = tab.pendingUrl || tab.url;
        if (!url) continue;
        inventory.push({
          tab_id: tabId,
          window_id: tab.windowId,
          group_id: Number.isInteger(tab.groupId) ? tab.groupId : NO_GROUP,
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
    return task?.taskId ?? null;
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
    const cosmeticChanges: Array<{ taskId: string; count: number }> = [];
    await mutateState((state) => {
      for (const task of Object.values(state.tasks)) {
        const revokedTabIds = task.tabIds.filter((tabId) => !byId.has(tabId));
        const retainedTabIds = task.tabIds.filter((tabId) => byId.has(tabId));
        const staleGroup = task.groupId !== null && !retainedTabIds.some(
          (tabId) => byId.get(tabId)?.groupId === task.groupId,
        );
        if (revokedTabIds.length === 0 && !staleGroup) continue;
        for (const tabId of revokedTabIds) this.scheduler.blockTab(tabId, OWNERSHIP_REVOKED);
        task.tabIds = retainedTabIds;
        if (task.tabIds.length === 0 || staleGroup) task.groupId = null;
        task.updatedAt = Date.now();
        if (revokedTabIds.length > 0) {
          changedTasks.push({ taskId: task.taskId, count: task.tabIds.length, revokedTabIds });
        }
        if (staleGroup) cosmeticChanges.push({ taskId: task.taskId, count: task.tabIds.length });
      }
    });
    for (const changed of changedTasks) {
      for (const tabId of changed.revokedTabIds) {
        await this.revisions.remove(tabId);
        this.scheduler.retireTabWhenIdle(tabId);
      }
      this.emit("ownership_revoked", { task_id: changed.taskId, tab_count: changed.count });
    }
    for (const changed of cosmeticChanges) {
      this.emit("group_membership_changed", {
        task_id: changed.taskId,
        tab_count: changed.count,
      });
    }
    await this.emitInventory();
    return changedTasks.flatMap((changed) => changed.revokedTabIds);
  }

  private async assertOwnedNow(taskId: string, tabId: number): Promise<TaskRecord> {
    const state = await readState();
    const task = state.tasks[taskId];
    const ownerCount = Object.values(state.tasks).filter((candidate) => candidate.tabIds.includes(tabId)).length;
    if (!task || !task.tabIds.includes(tabId) || ownerCount !== 1) {
      throw Object.assign(new Error("Tab is not owned by this AgentTab task"), {
        code: "ownership_denied",
      });
    }
    const tab = (await chrome.tabs.get(tabId).catch(() => null)) as TabLike | null;
    if (!tab) {
      await this.serializeCosmeticActors(
        [this.taskActor(taskId), this.tabActor(tabId)],
        () => this.revokeNow(tabId, "ownership_revoked"),
      );
      throw Object.assign(new Error("The task-owned tab no longer exists"), {
        code: "ownership_revoked",
      });
    }
    const current = await readState();
    const currentTask = current.tasks[taskId];
    if (
      !currentTask ||
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
    await this.assertTaskOpen(taskId);
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
      if (existingTask) {
        for (const tabId of existingTask.tabIds) {
          const candidate = (await chrome.tabs.get(tabId).catch(() => null)) as TabLike | null;
          if (candidate && typeof candidate.windowId === "number" && Number.isInteger(candidate.windowId)) {
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
    const current = Object.values(state.tasks).find((candidate) => candidate.tabIds.includes(tabId));
    if (!current) return false;
    if (
      current.groupId !== null &&
      !(await this.groupContainsOwnedTab(current.groupId, current.tabIds))
    ) {
      await this.clearCosmeticGroup(current.taskId, current.groupId);
    }
    this.emit("group_membership_changed", {
      task_id: current.taskId,
      tab_count: current.tabIds.length,
    });
    await this.emitInventory();
    return false;
  }

  private async revokeNow(
    tabId: number,
    event: "ownership_revoked" | "group_membership_changed" | "tab_removed",
  ): Promise<boolean> {
    this.scheduler.blockTab(tabId, OWNERSHIP_REVOKED);
    const before = await readState();
    const ownerBefore = Object.values(before.tasks).find((task) => task.tabIds.includes(tabId));
    const retainedGroup = ownerBefore?.groupId === null || ownerBefore?.groupId === undefined
      ? null
      : (await this.groupContainsOwnedTab(
        ownerBefore.groupId,
        ownerBefore.tabIds.filter((ownedTabId) => ownedTabId !== tabId),
      ))
        ? ownerBefore.groupId
        : null;
    const changed = await mutateState((state) => {
      for (const task of Object.values(state.tasks)) {
        if (!task.tabIds.includes(tabId)) continue;
        task.tabIds = task.tabIds.filter((ownedTabId) => ownedTabId !== tabId);
        if (task.tabIds.length === 0) {
          task.groupId = null;
        } else if (task.groupId === ownerBefore?.groupId) {
          task.groupId = retainedGroup;
        }
        task.updatedAt = Date.now();
        return { taskId: task.taskId, count: task.tabIds.length };
      }
      return null;
    });
    if (!changed) {
      this.scheduler.retireTabWhenIdle(tabId);
      return false;
    }
    await this.revisions.remove(tabId);
    this.emit(event, {
      task_id: changed.taskId,
      tab_count: changed.count,
    });
    await this.emitInventory();
    this.scheduler.retireTabWhenIdle(tabId);
    return true;
  }

  private async closeTaskAfterDrainingTabs(taskId: string): Promise<number[]> {
    const drainedTabIds = new Set<number>();
    while (true) {
      const snapshotTabIds = [...((await readState()).tasks[taskId]?.tabIds ?? [])];
      const newlyDiscovered = snapshotTabIds.filter((tabId) => !drainedTabIds.has(tabId));
      const initialDrains = newlyDiscovered.map((tabId) => {
        drainedTabIds.add(tabId);
        return this.scheduler.blockTab(tabId, OWNERSHIP_REVOKED);
      });
      await Promise.all(initialDrains);

      const attempt = await this.serializeActors(
        [this.taskActor(taskId), ...snapshotTabIds.map((tabId) => this.tabActor(tabId))],
        async () => {
          const currentTabIds = [...((await readState()).tasks[taskId]?.tabIds ?? [])];
          const undrained = currentTabIds.filter((tabId) => !drainedTabIds.has(tabId));
          if (undrained.length > 0) {
            const drains = undrained.map((tabId) => {
              drainedTabIds.add(tabId);
              return this.scheduler.blockTab(tabId, OWNERSHIP_REVOKED);
            });
            return { kind: "drain" as const, drains };
          }
          const closedTabIds = await this.serializeCosmeticActors(
            [this.taskActor(taskId), ...currentTabIds.map((tabId) => this.tabActor(tabId))],
            () => this.closeTaskNow(taskId),
          );
          return { kind: "closed" as const, closedTabIds };
        },
      );
      if (attempt.kind === "closed") return attempt.closedTabIds;
      // The task actor is released before waiting, so an active tab operation
      // can finish ownership revalidation instead of deadlocking with close.
      await Promise.all(attempt.drains);
    }
  }

  private async closeTaskNow(taskId: string): Promise<number[]> {
    const tabIds = await mutateState((state) => {
      if (state.taskTombstones[taskId] === undefined) {
        state.taskTombstones[taskId] = Date.now();
      }
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
    for (const tabId of tabIds) this.scheduler.retireTabWhenIdle(tabId);
    return closedTabIds;
  }

  private grant(taskId: string, tabId: number, name: string): Promise<void> {
    return this.serializeCosmeticActors(
      [this.taskActor(taskId), this.tabActor(tabId)],
      () => this.grantNow(taskId, tabId, name),
    );
  }

  private async grantNow(taskId: string, tabId: number, name: string): Promise<void> {
    await chrome.tabs.get(tabId);
    const state = await readState();
    if (state.taskTombstones[taskId] !== undefined) throw this.closedTaskError();
    const currentOwner = Object.values(state.tasks).find((task) => task.tabIds.includes(tabId));
    if (currentOwner && currentOwner.taskId !== taskId) {
      throw Object.assign(new Error("Tab is already owned by another AgentTab task"), {
        code: "ownership_denied",
      });
    }
    if (currentOwner) {
      await this.revisions.ensure(tabId);
      return;
    }

    const refreshed = await readState();
    const refreshedTask = refreshed.tasks[taskId];
    let groupId: number | null = refreshedTask?.groupId ?? null;
    if (
      refreshedTask &&
      groupId !== null &&
      !(await this.groupContainsOwnedTab(groupId, refreshedTask.tabIds))
    ) {
      await this.clearCosmeticGroup(taskId, groupId);
      groupId = null;
    }
    const previewTask: TaskRecord = refreshedTask
      ? { ...refreshedTask, groupId }
      : {
        taskId,
        name,
        groupId: null,
        tabIds: [],
        color: taskColor(taskId),
        state: "working",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    await this.revisions.ensure(tabId);
    await mutateState((next) => {
      if (next.taskTombstones[taskId] !== undefined) throw this.closedTaskError();
      const conflictingTask = Object.values(next.tasks).find(
        (task) => task.taskId !== taskId && task.tabIds.includes(tabId),
      );
      if (conflictingTask) {
        throw Object.assign(new Error("Tab ownership changed while it was being adopted"), {
          code: "ownership_denied",
        });
      }
      const task = next.tasks[taskId] ?? previewTask;
      if (!task.tabIds.includes(tabId)) task.tabIds.push(tabId);
      task.updatedAt = Date.now();
      next.tasks[taskId] = task;
    });

    try {
      if (groupId !== null) {
        groupId = await chrome.tabs.group({ tabIds: [tabId], groupId });
      } else {
        groupId = await chrome.tabs.group({ tabIds: [tabId] });
      }
      await chrome.tabGroups.update(groupId, {
        title: groupTitle(previewTask, refreshed.developerMode),
        color: previewTask.color,
        collapsed: false,
      });
      const grouped = (await chrome.tabs.get(tabId)) as TabLike;
      if (grouped.groupId !== groupId) throw new Error("Chrome did not preserve the requested tab group");
      await mutateState((next) => {
        const task = next.tasks[taskId];
        if (task?.tabIds.includes(tabId)) task.groupId = groupId;
      });
    } catch {
      // Tab groups are a best-effort visual aid. The durable task ledger is authoritative.
    }
    this.emit("group_membership_changed", {
      task_id: taskId,
      tab_count: (await readState()).tasks[taskId]?.tabIds.length ?? 0,
    });
    await this.emitInventory();
  }

  private async groupContainsOwnedTab(groupId: number, tabIds: readonly number[]): Promise<boolean> {
    for (const tabId of tabIds) {
      const tab = (await chrome.tabs.get(tabId).catch(() => null)) as TabLike | null;
      if (tab?.groupId === groupId) return true;
    }
    return false;
  }

  private async clearCosmeticGroup(taskId: string, expectedGroupId: number): Promise<void> {
    await mutateState((state) => {
      const task = state.tasks[taskId];
      if (!task || task.groupId !== expectedGroupId) return;
      task.groupId = null;
      task.updatedAt = Date.now();
    });
  }

  private async assertTaskOpen(taskId: string): Promise<void> {
    if ((await readState()).taskTombstones[taskId] !== undefined) {
      throw this.closedTaskError();
    }
  }

  private closedTaskError(): Error & { code: string; recovery: string } {
    return Object.assign(
      new Error("This AgentTab task is closed and cannot own new tabs"),
      {
        code: "task_closed",
        recovery: "Start a new AgentTab task instead of reusing a closed task capability.",
      },
    );
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
      group_id: Number.isInteger(tab.groupId) ? tab.groupId : NO_GROUP,
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

  private taskActor(taskId: string): string {
    return `task:${taskId}`;
  }

  private tabActor(tabId: number): string {
    return `tab:${tabId}`;
  }

  private serializeActor<T>(actor: string, operation: () => Promise<T>): Promise<T> {
    return this.serializeActors([actor], operation);
  }

  private owningTabActors(tabId: number, taskId: string | null): string[] {
    return taskId === null
      ? [this.tabActor(tabId)]
      : [this.taskActor(taskId), this.tabActor(tabId)];
  }

  private serializeActors<T>(actors: readonly string[], operation: () => Promise<T>): Promise<T> {
    const uniqueActors = [...new Set(actors)].sort();
    const priorGlobal = this.globalTransitionTail;
    const priorActors = uniqueActors.map(
      (actor) => this.actorTransitionTails.get(actor) ?? Promise.resolve(),
    );
    const next = priorGlobal.then(() => Promise.all(priorActors)).then(operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    for (const actor of uniqueActors) this.actorTransitionTails.set(actor, tail);
    void tail.then(() => {
      for (const actor of uniqueActors) {
        if (this.actorTransitionTails.get(actor) === tail) this.actorTransitionTails.delete(actor);
      }
    });
    return next;
  }

  private serializeGlobal<T>(operation: () => Promise<T>): Promise<T> {
    const priorGlobal = this.globalTransitionTail;
    const priorActors = [...this.actorTransitionTails.values()];
    const next = priorGlobal.then(() => Promise.all(priorActors)).then(operation);
    this.globalTransitionTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private serializeCosmeticActors<T>(
    actors: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const uniqueActors = [...new Set(actors)].sort();
    const priorActors = uniqueActors.map(
      (actor) => this.cosmeticTransitionTails.get(actor) ?? Promise.resolve(),
    );
    const next = Promise.all(priorActors).then(operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    for (const actor of uniqueActors) this.cosmeticTransitionTails.set(actor, tail);
    void tail.then(() => {
      for (const actor of uniqueActors) {
        if (this.cosmeticTransitionTails.get(actor) === tail) {
          this.cosmeticTransitionTails.delete(actor);
        }
      }
    });
    return next;
  }

}

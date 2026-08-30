import { MutationScheduler, NotStartedError } from "./scheduler";
import { mutateState, readState, type HandoffRecord } from "./storage";
import { RevisionTracker } from "./revisions";
import { OwnershipLedger } from "./ownership";
import { isRecord } from "./type-guards";

const HANDOFF_ALARM = "agenttab-handoff-timeout";
const DEFAULT_TIMEOUT_MS = 300_000;
type EventSink = (event: string, payload: Record<string, unknown>, eventId?: string) => void;
type OriginGuard = () => Promise<void>;

export class HandoffController {
  private transitionTail: Promise<unknown> = Promise.resolve();
  private scrubber: (() => Promise<void>) | null = null;

  constructor(
    private readonly scheduler: MutationScheduler,
    private readonly revisions: RevisionTracker,
    private readonly ownership: OwnershipLedger,
    private readonly emit: EventSink,
  ) { }

  setScrubber(scrubber: () => Promise<void>): void {
    this.scrubber = scrubber;
  }

  restore(): Promise<void> {
    return this.serialize(() => this.restoreNow());
  }

  begin(
    taskId: string,
    params: Record<string, unknown>,
    originGuard?: OriginGuard,
  ): Promise<Record<string, unknown>> {
    return this.serialize(() => this.beginNow(taskId, params, originGuard));
  }

  finish(completed: boolean): Promise<{ completed: boolean; reason?: string }> {
    return this.serialize(() => this.finishNow(completed));
  }
  cancelForTab(tabId: number): Promise<boolean> {
    return this.serialize(() => this.cancelMatchingNow((handoff) => handoff.tabId === tabId));
  }

  cancelForTask(taskId: string): Promise<boolean> {
    return this.serialize(() => this.cancelMatchingNow((handoff) => handoff.taskId === taskId));
  }


  acknowledgeEvent(event: string, eventId: string): Promise<void> {
    return this.serialize(() => this.acknowledgeEventNow(event, eventId));
  }

  pause(): Promise<void> {
    return this.serialize(() => this.pauseNow());
  }

  resume(): Promise<void> {
    return this.serialize(() => this.resumeNow());
  }

  private async restoreNow(): Promise<void> {
    const state = await readState();
    if (!state.handoff.active) return;
    const barrier = this.scheduler.pause();
    await barrier;
    const restored = await readState();
    if (!restored.handoff.active) return;
    if (restored.handoff.pendingClearEventId) {
      this.emit("handoff_changed", { active: false }, restored.handoff.pendingClearEventId);
      return;
    }
    if (restored.handoff.startedAtMs + restored.handoff.timeoutMs <= Date.now()) {
      await this.finishNow(false);
      return;
    }
    chrome.alarms.create(HANDOFF_ALARM, {
      when: restored.handoff.startedAtMs + restored.handoff.timeoutMs,
    });
  }

  private async beginNow(
    taskId: string,
    params: Record<string, unknown>,
    originGuard?: OriginGuard,
  ): Promise<Record<string, unknown>> {
    const tabId = params.tab_id;
    const timeoutMs = params.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : params.timeout_ms;
    if (
      !Number.isInteger(tabId) ||
      typeof params.prompt !== "string" ||
      !isRecord(params.completion) ||
      !Number.isInteger(timeoutMs) ||
      Number(timeoutMs) < 1
    ) {
      throw Object.assign(new Error("Invalid browser_handoff parameters"), { code: "invalid_request" });
    }
    if (!this.scheduler.isAccepting()) {
      throw new NotStartedError("paused", "AgentTab is paused");
    }
    const current = await readState();
    if (current.handoff.active) {
      throw Object.assign(new Error("Another credential handoff is already active"), {
        code: "handoff_in_progress",
      });
    }
    if (current.paused) throw new NotStartedError("paused", "AgentTab is paused");

    const numericTabId = Number(tabId);
    await this.ownership.assertOwned(taskId, numericTabId);
    await this.revisions.assertExpected(numericTabId, params.expected_page_revision);
    const startedAt = Date.now();
    const next: HandoffRecord = {
      active: true,
      taskId,
      tabId: numericTabId,
      expectedRevision: Number(params.expected_page_revision),
      prompt: params.prompt,
      completion: params.completion,
      startedAtMs: startedAt,
      timeoutMs: Number(timeoutMs),
    };

    const barrier = this.scheduler.pause();
    let recorded = false;
    try {
      await mutateState((state) => {
        if (state.handoff.active) {
          throw Object.assign(new Error("Another credential handoff is already active"), {
            code: "handoff_in_progress",
          });
        }
        if (state.paused) throw new NotStartedError("paused", "AgentTab is paused");
        state.handoff = next;
      });
      recorded = true;
      await barrier;
      await this.ownership.assertOwned(taskId, numericTabId);
      await this.revisions.assertExpected(numericTabId, next.expectedRevision);
      if (originGuard) await originGuard();
      await this.ownership.setTaskState(taskId, "needs_user");
      chrome.alarms.create(HANDOFF_ALARM, { when: startedAt + next.timeoutMs });
      const tab = await chrome.tabs.update(numericTabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.action.openPopup().catch(() => undefined);
      this.emit("handoff_changed", {
        active: true,
        task_id: taskId,
        tab_id: numericTabId,
        started_at_ms: startedAt,
      });
      return {
        task_id: taskId,
        tab_id: numericTabId,
        prompt: params.prompt,
        started_at_ms: startedAt,
      };
    } catch (error) {
      await barrier;
      if (recorded) {
        await mutateState((state) => {
          const handoff = state.handoff;
          if (
            handoff.active &&
            handoff.taskId === taskId &&
            handoff.tabId === numericTabId &&
            handoff.startedAtMs === startedAt
          ) {
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
      if (!recovered.paused && !recovered.handoff.active) this.scheduler.resume();
      throw error;
    }
  }

  private async finishNow(completed: boolean): Promise<{ completed: boolean; reason?: string }> {
    const handoff = (await readState()).handoff;
    if (!handoff.active) return { completed: false, reason: "No credential handoff is active" };
    if (handoff.pendingClearEventId) {
      this.emit("handoff_changed", { active: false }, handoff.pendingClearEventId);
      return { completed };
    }
    if (completed && !(await this.completionMatched(handoff))) {
      return { completed: false, reason: "The handoff completion condition has not been met" };
    }
    await this.scrubber?.();
    const eventId = crypto.randomUUID();
    await mutateState((state) => {
      const active = state.handoff;
      if (!active.active || active.startedAtMs !== handoff.startedAtMs || active.pendingClearEventId) {
        throw Object.assign(new Error("Credential handoff changed while it was being completed"), {
          code: "handoff_changed",
        });
      }
      state.handoff = { ...active, pendingClearEventId: eventId };
    });
    await chrome.alarms.clear(HANDOFF_ALARM);
    this.emit("handoff_changed", { active: false }, eventId);
    return { completed };
  }

  private async acknowledgeEventNow(event: string, eventId: string): Promise<void> {
    if (event !== "handoff_changed" || typeof eventId !== "string" || eventId.length === 0) return;
    const handoff = (await readState()).handoff;
    if (!handoff.active || handoff.pendingClearEventId !== eventId) return;
    await mutateState((state) => {
      const active = state.handoff;
      if (!active.active || active.pendingClearEventId !== eventId) return;
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
    if (!current.paused && !current.handoff.active) this.scheduler.resume();
  }

  private async cancelMatchingNow(
    matches: (handoff: Extract<HandoffRecord, { active: true }>) => boolean,
  ): Promise<boolean> {
    const eventId = crypto.randomUUID();
    const pendingEventId = await mutateState((state) => {
      const active = state.handoff;
      if (!active.active || !matches(active)) return null;
      if (active.pendingClearEventId) return active.pendingClearEventId;
      state.handoff = { ...active, pendingClearEventId: eventId };
      return eventId;
    });
    if (!pendingEventId) return false;
    await chrome.alarms.clear(HANDOFF_ALARM);
    this.emit("handoff_changed", { active: false }, pendingEventId);
    return true;
  }

  private async pauseNow(): Promise<void> {
    const barrier = this.scheduler.pause();
    await mutateState((state) => {
      state.paused = true;
    });
    await barrier;
    this.emit("pause_changed", { paused: true });
  }

  private async resumeNow(): Promise<void> {
    const state = await readState();
    if (state.handoff.active) {
      throw Object.assign(new Error("Finish or cancel credential handoff before resuming"), {
        code: "handoff_in_progress",
      });
    }
    await this.ownership.reconcile();
    await mutateState((next) => {
      if (next.handoff.active) {
        throw Object.assign(new Error("Finish or cancel credential handoff before resuming"), {
          code: "handoff_in_progress",
        });
      }
      next.paused = false;
    });
    this.scheduler.resume();
    this.emit("pause_changed", { paused: false });
  }

  private async completionMatched(handoff: Extract<HandoffRecord, { active: true }>): Promise<boolean> {
    const kind = handoff.completion.kind;
    if (kind === "manual_done") return true;
    if (kind === "navigation") {
      return (await this.revisions.current(handoff.tabId)) !== handoff.expectedRevision;
    }
    if (kind === "url") {
      const tab = await chrome.tabs.get(handoff.tabId).catch(() => null);
      return tab?.url === handoff.completion.value;
    }
    if (kind === "selector" && typeof handoff.completion.value === "string") {
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: handoff.tabId },
          func: (selector: string) => document.querySelector(selector) !== null,
          args: [handoff.completion.value],
        });
        return result === true;
      } catch {
        return false;
      }
    }
    return false;
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

export { HANDOFF_ALARM };

import { MutationScheduler, NotStartedError } from "./scheduler";
import { mutateState, readState, type HandoffNotice, type NoticeStatus } from "./storage";
import { RevisionTracker } from "./revisions";
import { OwnershipLedger } from "./ownership";
import { isRecord } from "./type-guards";

const HANDOFF_ALARM = "agenttab-handoff-timeout";
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_NOTICES = 100;
type PrivacyScrubber = (tabId: number) => Promise<void>;
type EventSink = (event: string, payload: Record<string, unknown>) => void;

type NoticeCompletion = { kind: "url" | "selector"; value: string };

function noticeResult(notice: HandoffNotice): Record<string, unknown> {
  return {
    notice_id: notice.noticeId,
    task_id: notice.taskId,
    tab_id: notice.tabId,
    prompt: notice.prompt,
    status: notice.status,
    started_at_ms: notice.startedAtMs,
    expires_at_ms: notice.expiresAtMs,
  };
}

function terminal(status: NoticeStatus): boolean {
  return status !== "open";
}

export class HandoffController {
  private transitionTail: Promise<unknown> = Promise.resolve();
  private scrubber: PrivacyScrubber | null = null;

  constructor(
    private readonly scheduler: MutationScheduler,
    private readonly revisions: RevisionTracker,
    private readonly ownership: OwnershipLedger,
    private readonly emit: EventSink = () => undefined,
  ) { }

  setScrubber(scrubber: PrivacyScrubber): void {
    this.scrubber = scrubber;
  }

  restore(): Promise<void> {
    return this.serialize(() => this.restoreNow());
  }

  request(
    taskId: string,
    params: Record<string, unknown>,
    originGuard?: () => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const tabId = params.tab_id;
    if (!Number.isInteger(tabId)) return this.serialize(() => this.requestNow(taskId, params, originGuard));
    return this.serialize(() =>
      this.scheduler.enqueueTab(
        taskId,
        Number(tabId),
        () => this.requestNow(taskId, params, originGuard),
      ),
    );
  }

  status(taskId: string, noticeId: string): Promise<Record<string, unknown>> {
    return this.serialize(async () => {
      await this.expireNow();
      return noticeResult(await this.noticeForTask(taskId, noticeId));
    });
  }

  resolve(taskId: string, noticeId: string): Promise<Record<string, unknown>> {
    return this.serialize(() => this.resolveNow(taskId, noticeId));
  }

  dismiss(taskId: string, noticeId: string): Promise<Record<string, unknown>> {
    return this.serialize(() => this.dismissNow(taskId, noticeId));
  }

  dismissFromPopup(noticeId: string): Promise<Record<string, unknown>> {
    return this.serialize(() => this.dismissNow(undefined, noticeId));
  }

  openFromPopup(noticeId: string): Promise<Record<string, unknown>> {
    return this.serialize(async () => {
      await this.expireNow();
      const notice = await this.noticeForTask(undefined, noticeId);
      if (notice.status !== "open") return noticeResult(notice);
      await this.ownership.assertOwned(notice.taskId, notice.tabId);
      const tab = await chrome.tabs.update(notice.tabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return { ...noticeResult(notice), focused: true };
    });
  }

  expire(): Promise<void> {
    return this.serialize(() => this.expireNow());
  }

  cancelForTab(tabId: number): Promise<boolean> {
    return this.serialize(() => this.dismissMatchingNow((notice) => notice.tabId === tabId));
  }

  clearForTask(taskId: string): Promise<boolean> {
    return this.serialize(async () => {
      const cleared = await mutateState((state) => {
        const noticeIds = Object.values(state.notices)
          .filter((notice) => notice.taskId === taskId)
          .map((notice) => notice.noticeId);
        for (const noticeId of noticeIds) delete state.notices[noticeId];
        return noticeIds.length > 0;
      });
      if (cleared) await this.scheduleExpiry();
      return cleared;
    });
  }

  pause(): Promise<void> {
    return this.serialize(async () => {
      const barrier = this.scheduler.pause();
      await mutateState((state) => {
        state.paused = true;
      });
      await barrier;
      this.emit("pause_changed", { paused: true });
    });
  }

  resume(): Promise<void> {
    return this.serialize(async () => {
      await this.ownership.reconcile();
      await mutateState((state) => {
        state.paused = false;
      });
      this.scheduler.resume();
      this.emit("pause_changed", { paused: false });
    });
  }

  private async restoreNow(): Promise<void> {
    await this.expireNow();
  }

  private async requestNow(
    taskId: string,
    params: Record<string, unknown>,
    originGuard?: () => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const tabId = params.tab_id;
    const timeoutMs = params.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : params.timeout_ms;
    const completion = params.completion;
    if (
      !Number.isInteger(tabId) ||
      typeof params.prompt !== "string" ||
      !Number.isInteger(timeoutMs) ||
      Number(timeoutMs) < 1 ||
      (completion !== undefined && !this.validCompletion(completion))
    ) {
      throw Object.assign(new Error("Invalid browser_handoff request parameters"), { code: "invalid_request" });
    }
    if (!this.scheduler.isAccepting() || (await readState()).paused) {
      throw new NotStartedError("paused", "AgentTab is paused");
    }

    const numericTabId = Number(tabId);
    const expectedRevision = params.expected_page_revision;
    await this.ownership.assertOwned(taskId, numericTabId);
    await this.revisions.assertExpected(numericTabId, expectedRevision);
    if (originGuard) await originGuard();
    // Detaching this exact tab prevents an existing passive debugger session from
    // remaining attached while the human interacts. It never pauses other tasks.
    await this.scrubber?.(numericTabId);

    await this.ownership.assertOwned(taskId, numericTabId);
    await this.revisions.assertExpected(numericTabId, expectedRevision);

    const startedAtMs = Date.now();
    const notice: HandoffNotice = {
      noticeId: crypto.randomUUID(),
      taskId,
      tabId: numericTabId,
      expectedRevision: Number(expectedRevision),
      prompt: params.prompt,
      ...(completion === undefined ? {} : { completion: completion as NoticeCompletion }),
      status: "open",
      startedAtMs,
      expiresAtMs: startedAtMs + Number(timeoutMs),
    };
    await mutateState((state) => {
      if (state.paused) throw new NotStartedError("paused", "AgentTab is paused");
      if (!state.tasks[taskId]?.tabIds.includes(numericTabId)) {
        throw Object.assign(new Error("Tab ownership changed before the handoff notice was recorded"), {
          code: "ownership_revoked",
        });
      }
      for (const existing of Object.values(state.notices)) {
        if (existing.taskId === taskId && existing.tabId === numericTabId && existing.status === "open") {
          existing.status = "dismissed";
        }
      }
      state.notices[notice.noticeId] = notice;
      this.trimNotices(state.notices);
    });
    await this.scheduleExpiry();
    return noticeResult(notice);
  }

  private async resolveNow(taskId: string, noticeId: string): Promise<Record<string, unknown>> {
    await this.expireNow();
    const notice = await this.noticeForTask(taskId, noticeId);
    if (terminal(notice.status)) return noticeResult(notice);
    if (notice.completion && !(await this.completionMatched(notice))) {
      throw Object.assign(new Error("The handoff completion condition has not been met"), {
        code: "completion_not_met",
      });
    }
    return this.setStatus(noticeId, "resolved");
  }

  private async dismissNow(taskId: string | undefined, noticeId: string): Promise<Record<string, unknown>> {
    await this.expireNow();
    const notice = await this.noticeForTask(taskId, noticeId);
    if (terminal(notice.status)) return noticeResult(notice);
    return this.setStatus(noticeId, "dismissed");
  }

  private async expireNow(): Promise<void> {
    const now = Date.now();
    await mutateState((state) => {
      for (const notice of Object.values(state.notices)) {
        if (notice.status === "open" && notice.expiresAtMs <= now) notice.status = "expired";
      }
      this.trimNotices(state.notices);
    });
    await this.scheduleExpiry();
  }

  private async dismissMatchingNow(matches: (notice: HandoffNotice) => boolean): Promise<boolean> {
    const changed = await mutateState((state) => {
      let dismissed = false;
      for (const notice of Object.values(state.notices)) {
        if (notice.status === "open" && matches(notice)) {
          notice.status = "dismissed";
          dismissed = true;
        }
      }
      this.trimNotices(state.notices);
      return dismissed;
    });
    if (changed) await this.scheduleExpiry();
    return changed;
  }

  private async setStatus(noticeId: string, status: Exclude<NoticeStatus, "open">): Promise<Record<string, unknown>> {
    const next = await mutateState((state) => {
      const notice = state.notices[noticeId];
      if (!notice) throw Object.assign(new Error("Handoff notice does not exist"), { code: "notice_not_found" });
      if (notice.status === "open") notice.status = status;
      this.trimNotices(state.notices);
      return structuredClone(notice);
    });
    await this.scheduleExpiry();
    return noticeResult(next);
  }

  private async noticeForTask(taskId: string | undefined, noticeId: string): Promise<HandoffNotice> {
    if (typeof noticeId !== "string" || noticeId.length === 0) {
      throw Object.assign(new Error("notice_id must be a non-empty string"), { code: "invalid_request" });
    }
    const notice = (await readState()).notices[noticeId];
    if (!notice) throw Object.assign(new Error("Handoff notice does not exist"), { code: "notice_not_found" });
    if (taskId !== undefined && notice.taskId !== taskId) {
      throw Object.assign(new Error("Handoff notice belongs to another task"), { code: "ownership_denied" });
    }
    return notice;
  }

  private async scheduleExpiry(): Promise<void> {
    const nextExpiry = Object.values((await readState()).notices)
      .filter((notice) => notice.status === "open")
      .reduce<number | undefined>((earliest, notice) =>
        earliest === undefined || notice.expiresAtMs < earliest ? notice.expiresAtMs : earliest,
      undefined);
    await chrome.alarms.clear(HANDOFF_ALARM);
    if (nextExpiry !== undefined) chrome.alarms.create(HANDOFF_ALARM, { when: nextExpiry });
  }

  private async completionMatched(notice: HandoffNotice): Promise<boolean> {
    if (!notice.completion) return true;
    await this.ownership.assertOwned(notice.taskId, notice.tabId);
    if (notice.completion.kind === "url") {
      const tab = await chrome.tabs.get(notice.tabId).catch(() => null);
      return tab?.url === notice.completion.value;
    }
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: notice.tabId },
        func: (selector: string) => document.querySelector(selector) !== null,
        args: [notice.completion.value],
      });
      return result === true;
    } catch {
      return false;
    }
  }

  private validCompletion(value: unknown): value is NoticeCompletion {
    return isRecord(value) &&
      (value.kind === "url" || value.kind === "selector") &&
      typeof value.value === "string";
  }

  private trimNotices(notices: Record<string, HandoffNotice>): void {
    const terminalNotices = Object.values(notices)
      .filter((notice) => terminal(notice.status))
      .sort((left, right) => left.startedAtMs - right.startedAtMs);
    for (const notice of terminalNotices.slice(0, Math.max(0, Object.keys(notices).length - MAX_NOTICES))) {
      delete notices[notice.noticeId];
    }
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

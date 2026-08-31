export class NotStartedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NotStartedError";
    this.code = code;
  }
}

type Work<T> = () => Promise<T>;

export class MutationScheduler {
  private accepting = true;
  private lifecycleAccepting = true;
  private permissionsAvailable = true;
  private admissionEpoch = 0;
  private admissionFailure = {
    code: "paused",
    message: "AgentTab is paused",
  };
  private readonly tabTails = new Map<number, Promise<unknown>>();
  private readonly taskLifecycleTails = new Map<string, Promise<unknown>>();
  private globalTail: Promise<unknown> = Promise.resolve();
  private readonly generations = new Map<number, number>();
  private readonly generationReasons = new Map<number, { code: string; message: string }>();
  private readonly blockedTabs = new Map<number, { code: string; message: string }>();
  private readonly closedTasks = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();

  setInitialPaused(paused: boolean): void {
    if (!paused) {
      this.lifecycleAccepting = true;
      this.accepting = this.permissionsAvailable;
      return;
    }
    this.accepting = false;
    this.lifecycleAccepting = false;
    this.admissionEpoch += 1;
    this.admissionFailure = {
      code: "paused",
      message: "AgentTab is paused",
    };
  }

  isAccepting(): boolean {
    return this.accepting;
  }

  restoreClosedTasks(taskIds: readonly string[]): void {
    for (const taskId of taskIds) this.closedTasks.add(taskId);
  }

  isTaskClosed(taskId: string): boolean {
    return this.closedTasks.has(taskId);
  }

  assertTabAccepting(tabId: number, pausedMessage?: string): void {
    if (!this.accepting) throw this.notStarted(pausedMessage);
    const blocked = this.blockedTabs.get(tabId);
    if (blocked) throw new NotStartedError(blocked.code, blocked.message);
  }

  notStarted(message?: string): NotStartedError {
    if (!this.permissionsAvailable) {
      return new NotStartedError(
        "permissions_required",
        "AgentTab automation permissions have not been enabled",
      );
    }
    return new NotStartedError(
      this.admissionFailure.code,
      message ?? this.admissionFailure.message,
    );
  }

  taskClosed(): NotStartedError {
    return new NotStartedError(
      "task_closed",
      "This AgentTab task is closed and cannot admit more browser work",
    );
  }

  enqueueTab<T>(taskId: string, tabId: number, work: Work<T>): Promise<T> {
    if (this.closedTasks.has(taskId)) return Promise.reject(this.taskClosed());
    try {
      this.assertTabAccepting(tabId);
    } catch (error) {
      return Promise.reject(error);
    }
    const admissionEpoch = this.admissionEpoch;
    const generation = this.generations.get(tabId) ?? 0;
    const priorGlobal = this.globalTail;
    const priorTab = this.tabTails.get(tabId) ?? Promise.resolve();
    const result = priorGlobal.then(() => priorTab).then(async () => {
      if (!this.accepting || this.admissionEpoch !== admissionEpoch) {
        throw this.notStarted("AgentTab paused before this mutation was dispatched");
      }
      if (this.closedTasks.has(taskId)) throw this.taskClosed();
      const currentBlock = this.blockedTabs.get(tabId);
      if (currentBlock) {
        throw new NotStartedError(currentBlock.code, currentBlock.message);
      }
      if ((this.generations.get(tabId) ?? 0) !== generation) {
        const reason = this.generationReasons.get(tabId) ?? {
          code: "ownership_revoked",
          message: "Tab ownership changed before this mutation was dispatched",
        };
        throw new NotStartedError(reason.code, reason.message);
      }
      return work();
    });
    this.rememberTabTail(tabId, result);
    this.track(result);
    return result;
  }

  enqueueTaskLifecycle<T>(taskId: string, work: Work<T>): Promise<T> {
    if (this.closedTasks.has(taskId)) return Promise.reject(this.taskClosed());
    if (!this.accepting) return Promise.reject(this.notStarted());
    const admissionEpoch = this.admissionEpoch;
    const priorTask = this.taskLifecycleTails.get(taskId) ?? Promise.resolve();
    const result = priorTask.then(async () => {
      if (!this.accepting || this.admissionEpoch !== admissionEpoch) {
        throw this.notStarted("AgentTab paused before this task operation was dispatched");
      }
      if (this.closedTasks.has(taskId)) throw this.taskClosed();
      return work();
    });
    this.rememberTaskLifecycleTail(taskId, result);
    this.track(result);
    return result;
  }

  enqueueTaskClose<T>(taskId: string, work: Work<T>): Promise<T> {
    this.closedTasks.add(taskId);
    const priorTask = this.taskLifecycleTails.get(taskId) ?? Promise.resolve();
    const result = priorTask.then(work);
    this.rememberTaskLifecycleTail(taskId, result);
    this.track(result);
    return result;
  }

  private rememberTaskLifecycleTail<T>(taskId: string, result: Promise<T>): void {
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.taskLifecycleTails.set(taskId, tail);
    void tail.then(() => {
      if (this.taskLifecycleTails.get(taskId) === tail) this.taskLifecycleTails.delete(taskId);
    });
  }

  enqueueGlobal<T>(work: Work<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(this.notStarted());
    const admissionEpoch = this.admissionEpoch;
    const priorGlobal = this.globalTail;
    const priorTabs = [...this.tabTails.values()];
    const result = priorGlobal.then(() => Promise.all(priorTabs)).then(async () => {
      if (!this.accepting || this.admissionEpoch !== admissionEpoch) {
        throw this.notStarted("AgentTab paused before this global mutation was dispatched");
      }
      return work();
    });
    this.globalTail = result.then(
      () => undefined,
      () => undefined,
    );
    this.track(result);
    return result;
  }

  readAfterWrites<T>(tabId: number | undefined, work: Work<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(this.notStarted());
    if (tabId !== undefined) {
      try {
        this.assertTabAccepting(tabId);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const admissionEpoch = this.admissionEpoch;
    const priorGlobal = this.globalTail;
    if (tabId === undefined) {
      const result = priorGlobal.then(async () => {
        if (!this.accepting || this.admissionEpoch !== admissionEpoch) {
          throw this.notStarted("AgentTab paused before this observation was dispatched");
        }
        return work();
      });
      this.globalTail = result.then(
        () => undefined,
        () => undefined,
      );
      this.track(result);
      return result;
    }

    const priorTab = this.tabTails.get(tabId) ?? Promise.resolve();
    const result = priorGlobal.then(() => priorTab).then(async () => {
      if (!this.accepting || this.admissionEpoch !== admissionEpoch) {
        throw this.notStarted("AgentTab paused before this observation was dispatched");
      }
      const currentBlock = this.blockedTabs.get(tabId);
      if (currentBlock) {
        throw new NotStartedError(currentBlock.code, currentBlock.message);
      }
      return work();
    });
    this.rememberTabTail(tabId, result);
    this.track(result);
    return result;
  }

  revokeTab(tabId: number): void {
    this.invalidateQueuedTab(tabId, {
      code: "ownership_revoked",
      message: "Tab ownership changed before this mutation was dispatched",
    });
  }

  invalidateTab(tabId: number): void {
    this.invalidateQueuedTab(tabId, {
      code: "stale_revision",
      message: "Page navigation invalidated this queued mutation",
    });
  }

  blockTab(
    tabId: number,
    reason = {
      code: "handoff_blackout",
      message: "Automation is disabled while the human controls this tab",
    },
  ): Promise<void> {
    this.blockedTabs.set(tabId, reason);
    this.generationReasons.set(tabId, reason);
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
    const tail = this.tabTails.get(tabId);
    return tail ? tail.then(() => undefined) : Promise.resolve();
  }

  unblockTab(tabId: number): void {
    this.blockedTabs.delete(tabId);
    if (!this.tabTails.has(tabId)) {
      this.generations.delete(tabId);
      this.generationReasons.delete(tabId);
    }
  }

  isTabBlocked(tabId: number): boolean {
    return this.blockedTabs.has(tabId);
  }

  retireTabWhenIdle(tabId: number): void {
    const tail = this.tabTails.get(tabId);
    const retire = () => {
      this.tabTails.delete(tabId);
      this.blockedTabs.delete(tabId);
      this.generations.delete(tabId);
      this.generationReasons.delete(tabId);
    };
    if (!tail) {
      retire();
      return;
    }
    void tail.then(retire);
  }

  revokePermissions(): void {
    this.permissionsAvailable = false;
    this.accepting = false;
    this.admissionEpoch += 1;
  }

  restorePermissions(): void {
    this.permissionsAvailable = true;
    this.accepting = this.lifecycleAccepting;
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  disconnect(): void {
    this.accepting = false;
    this.lifecycleAccepting = false;
    this.admissionEpoch += 1;
    this.admissionFailure = {
      code: "paused",
      message: "AgentTab connection is unavailable",
    };
  }

  async pause(): Promise<void> {
    this.accepting = false;
    this.lifecycleAccepting = false;
    this.admissionEpoch += 1;
    this.admissionFailure = {
      code: "paused",
      message: "AgentTab is paused",
    };
    await this.drain();
  }

  resume(): void {
    this.lifecycleAccepting = true;
    this.accepting = this.permissionsAvailable;
    this.admissionFailure = {
      code: "paused",
      message: "AgentTab is paused",
    };
  }

  private rememberTabTail<T>(tabId: number, result: Promise<T>): void {
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tabTails.set(tabId, tail);
    void tail.then(() => {
      if (this.tabTails.get(tabId) === tail) {
        this.tabTails.delete(tabId);
        if (!this.blockedTabs.has(tabId)) {
          this.generations.delete(tabId);
          this.generationReasons.delete(tabId);
        }
      }
    });
  }

  private invalidateQueuedTab(
    tabId: number,
    reason: { code: string; message: string },
  ): void {
    if (!this.tabTails.has(tabId)) {
      this.generations.delete(tabId);
      this.generationReasons.delete(tabId);
      return;
    }
    this.generationReasons.set(tabId, reason);
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
  }

  private track<T>(operation: Promise<T>): void {
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => undefined);
  }
}

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
  private readonly taskTails = new Map<string, Promise<unknown>>();
  private globalTail: Promise<unknown> = Promise.resolve();
  private readonly generations = new Map<number, number>();
  private readonly generationReasons = new Map<number, { code: string; message: string }>();
  private readonly pending = new Set<Promise<unknown>>();

  setInitialPaused(paused: boolean): void {
    if (!paused) return;
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

  enqueueTab<T>(taskId: string, tabId: number, work: Work<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(this.notStarted());
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
          message: "Tab ownership changed before this mutation was dispatched",
        };
        throw new NotStartedError(reason.code, reason.message);
      }
      return work();
    });
    this.rememberTabTail(taskId, tabId, result);
    this.track(result);
    return result;
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
      return work();
    });
    this.rememberTabTail(undefined, tabId, result);
    this.track(result);
    return result;
  }

  revokeTab(tabId: number): void {
    this.generationReasons.set(tabId, {
      code: "ownership_revoked",
      message: "Tab ownership changed before this mutation was dispatched",
    });
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
  }

  invalidateTab(tabId: number): void {
    this.generationReasons.set(tabId, {
      code: "stale_revision",
      message: "Page navigation invalidated this queued mutation",
    });
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
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
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  resume(): void {
    this.lifecycleAccepting = true;
    this.accepting = this.permissionsAvailable;
    this.admissionFailure = {
      code: "paused",
      message: "AgentTab is paused",
    };
  }

  private rememberTabTail<T>(taskId: string | undefined, tabId: number, result: Promise<T>): void {
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tabTails.set(tabId, tail);
    if (taskId !== undefined) this.taskTails.set(taskId, tail);
    void tail.then(() => {
      if (this.tabTails.get(tabId) === tail) this.tabTails.delete(tabId);
      if (taskId !== undefined && this.taskTails.get(taskId) === tail) {
        this.taskTails.delete(taskId);
      }
    });
  }

  private track<T>(operation: Promise<T>): void {
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => undefined);
  }
}

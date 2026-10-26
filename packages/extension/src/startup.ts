import { settledWithin } from "./bounded";

export type StartupPhase = "idle" | "starting" | "ready";

export class IdempotentStartup {
  private current: Promise<void> | null = null;
  private currentPhase: StartupPhase = "idle";
  private readonly readyListeners = new Set<() => void>();

  constructor(private readonly initialize: () => Promise<void>) { }

  get phase(): StartupPhase {
    return this.currentPhase;
  }

  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    if (this.currentPhase === "ready") this.reportReady(listener);
    return () => this.readyListeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.current) return this.current;

    this.currentPhase = "starting";
    const initialization = Promise.resolve().then(() => this.initialize());
    let lifecycle: Promise<void>;
    lifecycle = initialization.then(
      () => {
        if (this.current !== lifecycle) return;
        this.currentPhase = "ready";
        for (const listener of this.readyListeners) this.reportReady(listener);
      },
      (error: unknown) => {
        if (this.current === lifecycle) {
          this.current = null;
          this.currentPhase = "idle";
        }
        throw error;
      },
    );
    this.current = lifecycle;
    return lifecycle;
  }

  private reportReady(listener: () => void): void {
    try {
      listener();
    } catch {
      // Recovery observers must not poison successful initialization.
    }
  }
}

type StartupOperation = () => void | Promise<void>;

/**
 * Longest one queued operation may hold the queue. Tab events, alarms (including native
 * reconnect), and `browser_open` load barriers all drain through this one queue, so an
 * operation awaiting something that never settles would otherwise stall every later one.
 * Every bounded wait an operation legitimately makes is far shorter.
 */
export const STARTUP_OPERATION_TIMEOUT_MS = 30_000;

export class StartupOperationQueue {
  private readonly pending: StartupOperation[] = [];
  private draining: Promise<void> | null = null;
  private retryAfterDrain = false;

  constructor(
    private readonly startup: IdempotentStartup,
    private readonly onStartupError: (error: unknown) => void = () => undefined,
    private readonly onOperationError: (error: unknown) => void = () => undefined,
  ) {
    this.startup.onReady(() => this.requestDrain());
  }

  enqueue(operation: StartupOperation = () => undefined): void {
    this.pending.push(operation);
    this.requestDrain();
  }

  private requestDrain(): void {
    if (this.pending.length === 0) return;
    if (this.draining) {
      this.retryAfterDrain = true;
      return;
    }
    this.beginDrain();
  }

  private beginDrain(): void {
    const drain = this.drain();
    this.draining = drain;
    void drain.finally(() => {
      if (this.draining !== drain) return;
      this.draining = null;
      const shouldRetry = this.retryAfterDrain;
      this.retryAfterDrain = false;
      if (this.pending.length > 0 && (this.startup.phase === "ready" || shouldRetry)) {
        this.beginDrain();
      }
    }).catch(() => undefined);
  }

  private async drain(): Promise<void> {
    try {
      await this.startup.start();
    } catch (error) {
      this.report(this.onStartupError, error);
      return;
    }

    while (this.pending.length > 0) {
      const operation = this.pending.shift();
      if (!operation) continue;
      try {
        // An operation still running at the cap keeps running but no longer holds the queue.
        if (!(await settledWithin(operation(), STARTUP_OPERATION_TIMEOUT_MS))) {
          throw new Error(
            `AgentTab background operation still running after ${STARTUP_OPERATION_TIMEOUT_MS} ms; later operations no longer wait for it`,
          );
        }
      } catch (error) {
        this.report(this.onOperationError, error);
      }
    }
  }

  private report(callback: (error: unknown) => void, error: unknown): void {
    try {
      callback(error);
    } catch {
      // Diagnostics must not poison lifecycle recovery.
    }
  }
}

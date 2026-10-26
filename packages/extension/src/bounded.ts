/**
 * Waits for `work` for at most `limitMs`. Resolves `true` when it fulfills in time and rejects
 * with its error when it fails in time. Resolves `false` once the limit passes first; `work`
 * keeps running, and its later outcome is left to whoever else holds it.
 */
export async function settledWithin(work: unknown, limitMs: number): Promise<boolean> {
  const { promise: expired, resolve: expire } = Promise.withResolvers<false>();
  const timer = setTimeout(() => expire(false), limitMs);
  try {
    return await Promise.race([Promise.resolve(work).then(() => true as const), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A serial operation chain whose operations hold it for at most `holdMs` each. An operation that
 * overruns is reported and keeps running, and its caller still receives its eventual result, but
 * the next operation starts. Without the cap, one operation awaiting something that never settles
 * would stall every later operation for the life of the service worker.
 */
export class BoundedChain {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly name: string,
    private readonly holdMs: number,
    private readonly onOverrun: (error: Error) => void = (error) => console.warn(error),
  ) { }

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    const running = previous.then(operation);
    // Time the hold from when the operation starts, not when it is queued, so operations that
    // waited behind a stuck one still run one at a time.
    this.tail = previous
      .then(() => settledWithin(running, this.holdMs))
      .then(
        (settled) => {
          if (!settled) this.onOverrun(this.overrun());
        },
        () => undefined,
      );
    return running;
  }

  private overrun(): Error {
    return new Error(
      `AgentTab ${this.name} operation still running after ${this.holdMs} ms; later operations no longer wait for it`,
    );
  }
}

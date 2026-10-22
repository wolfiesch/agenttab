import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { StandardBrowserRuntime } from "../src/browser";
import { RevisionTracker } from "../src/revisions";
import { resetStateForTest } from "../src/storage";

const TAB = 51;
const OTHER_TAB = 52;
const START_URL = "https://app.example/inbox";

type NavigationDetails = { tabId: number; frameId: number; url: string; error?: string; documentLifecycle?: string };
type NavigationEventName =
  | "onCommitted"
  | "onCompleted"
  | "onErrorOccurred"
  | "onHistoryStateUpdated"
  | "onReferenceFragmentUpdated";

let localStore: Record<string, unknown>;
let sessionStore: Record<string, unknown>;
let tab: { id: number; status: string; url: string };
let navigationListeners: Record<NavigationEventName, Array<(details: NavigationDetails) => void>>;

function navigationEvent(name: NavigationEventName) {
  return {
    addListener(listener: (details: NavigationDetails) => void) {
      navigationListeners[name].push(listener);
    },
  };
}

function fire(name: NavigationEventName, details: Partial<NavigationDetails> & { url?: string }): void {
  const full: NavigationDetails = { tabId: TAB, frameId: 0, url: tab.url, ...details };
  for (const listener of navigationListeners[name]) listener(full);
}

function installChromeMock(options: { webNavigation?: boolean } = {}): void {
  localStore = {};
  sessionStore = {};
  tab = { id: TAB, status: "loading", url: START_URL };
  navigationListeners = {
    onCommitted: [],
    onCompleted: [],
    onErrorOccurred: [],
    onHistoryStateUpdated: [],
    onReferenceFragmentUpdated: [],
  };
  const storageArea = (store: () => Record<string, unknown>) => ({
    async get(keys: string | string[] | null) {
      if (keys === null) return structuredClone(store());
      const selected = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(selected.filter((key) => key in store()).map((key) => [key, structuredClone(store()[key])]));
    },
    async set(values: Record<string, unknown>) {
      Object.assign(store(), structuredClone(values));
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store()[key];
    },
  });
  Object.assign(globalThis, {
    chrome: {
      storage: {
        local: storageArea(() => localStore),
        session: storageArea(() => sessionStore),
        onChanged: { addListener() {} },
      },
      debugger: {
        onDetach: { addListener() {} },
        onEvent: { addListener() {} },
      },
      tabs: {
        async get(tabId: number) {
          return { ...tab, id: tabId };
        },
      },
      ...(options.webNavigation === false
        ? {}
        : {
          webNavigation: {
            onCommitted: navigationEvent("onCommitted"),
            onCompleted: navigationEvent("onCompleted"),
            onErrorOccurred: navigationEvent("onErrorOccurred"),
            onHistoryStateUpdated: navigationEvent("onHistoryStateUpdated"),
            onReferenceFragmentUpdated: navigationEvent("onReferenceFragmentUpdated"),
          },
        }),
    },
  });
  resetStateForTest();
}

function newRuntime(): StandardBrowserRuntime {
  return new StandardBrowserRuntime(new RevisionTracker(), async () => undefined, () => undefined, async () => undefined);
}

async function flushPromiseQueue(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

async function advanceTimers(milliseconds: number): Promise<void> {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) {
    vi.advanceTimersByTime(Math.min(50, milliseconds - elapsed));
    await flushPromiseQueue();
  }
}

/** Starts a wait and lets it reach its polling loop before events are fired. */
async function startWait(
  runtime: StandardBrowserRuntime,
  condition: Record<string, unknown>,
  timeoutMs = 2_000,
): Promise<{ result: Promise<Record<string, unknown>>; settled: () => boolean }> {
  let done = false;
  const result = runtime.wait(TAB, { condition, timeout_ms: timeoutMs });
  result.then(() => { done = true; }, () => { done = true; });
  await flushPromiseQueue();
  return { result, settled: () => done };
}

beforeEach(() => {
  vi.useFakeTimers();
  installChromeMock();
});
afterEach(() => vi.useRealTimers());

describe("browser_wait load with top-frame navigation events", () => {
  test("resolves on a top-frame completion while tab polling still reports loading", async () => {
    const runtime = newRuntime();
    const waiting = await startWait(runtime, { kind: "load" });
    fire("onCommitted", { url: "https://app.example/next" });
    fire("onCompleted", { url: "https://app.example/next" });
    await advanceTimers(200);
    await expect(waiting.result).resolves.toMatchObject({ tab_id: TAB, condition: "load", matched: true });
  });

  test("ignores subframe completions", async () => {
    const runtime = newRuntime();
    const waiting = await startWait(runtime, { kind: "load" });
    fire("onCompleted", { frameId: 7, url: "https://ads.example/frame" });
    await advanceTimers(250);
    expect(waiting.settled()).toBe(false);
    fire("onCompleted", {});
    await advanceTimers(200);
    await expect(waiting.result).resolves.toMatchObject({ matched: true });
  });

  test("a completion followed by a newer top-frame commit waits for that newer load", async () => {
    const runtime = newRuntime();
    const waiting = await startWait(runtime, { kind: "load" });
    fire("onCompleted", { url: "https://app.example/first" });
    fire("onCommitted", { url: "https://app.example/redirected" });
    await advanceTimers(250);
    expect(waiting.settled()).toBe(false);
    fire("onCompleted", { url: "https://app.example/redirected" });
    await advanceTimers(200);
    await expect(waiting.result).resolves.toMatchObject({ matched: true });
  });

  test("a completion before the wait started does not satisfy it", async () => {
    const runtime = newRuntime();
    fire("onCompleted", {});
    const waiting = await startWait(runtime, { kind: "load" }, 300);
    await advanceTimers(500);
    await expect(waiting.result).rejects.toMatchObject({ code: "wait_timeout" });
  });

  test("events on other tabs are ignored", async () => {
    const runtime = newRuntime();
    const waiting = await startWait(runtime, { kind: "load" }, 400);
    fire("onCompleted", { tabId: OTHER_TAB });
    await advanceTimers(600);
    await expect(waiting.result).rejects.toMatchObject({ code: "wait_timeout" });
  });

  test("still resolves through tab polling", async () => {
    const runtime = newRuntime();
    const waiting = await startWait(runtime, { kind: "load" });
    tab.status = "complete";
    await advanceTimers(200);
    await expect(waiting.result).resolves.toMatchObject({ matched: true });
  });

  test("still resolves through tab polling when webNavigation is unavailable", async () => {
    installChromeMock({ webNavigation: false });
    const runtime = newRuntime();
    const waiting = await startWait(runtime, { kind: "load" });
    tab.status = "complete";
    await advanceTimers(200);
    await expect(waiting.result).resolves.toMatchObject({ matched: true });
  });
});

describe("browser_wait url with top-frame navigation events", () => {
  test("matches a single-page-app history-state update before tab polling sees it", async () => {
    const runtime = newRuntime();
    const target = "https://app.example/inbox/thread-9";
    const waiting = await startWait(runtime, { kind: "url", value: target });
    fire("onHistoryStateUpdated", { url: target });
    await advanceTimers(200);
    await expect(waiting.result).resolves.toMatchObject({ condition: "url", matched: true });
    expect(tab.url).toBe(START_URL);
  });

  test("matches a fragment update", async () => {
    const runtime = newRuntime();
    const target = `${START_URL}#settings`;
    const waiting = await startWait(runtime, { kind: "url", value: target });
    fire("onReferenceFragmentUpdated", { url: target });
    await advanceTimers(200);
    await expect(waiting.result).resolves.toMatchObject({ matched: true });
  });

  test("does not match a subframe history-state update or a different URL", async () => {
    const runtime = newRuntime();
    const target = "https://app.example/inbox/thread-9";
    const waiting = await startWait(runtime, { kind: "url", value: target }, 500);
    fire("onHistoryStateUpdated", { frameId: 3, url: target });
    fire("onHistoryStateUpdated", { url: "https://app.example/inbox/thread-10" });
    await advanceTimers(700);
    await expect(waiting.result).rejects.toMatchObject({ code: "wait_timeout" });
  });

  test("still matches through tab polling", async () => {
    const runtime = newRuntime();
    const target = "https://app.example/done";
    const waiting = await startWait(runtime, { kind: "url", value: target });
    tab.url = target;
    await advanceTimers(200);
    await expect(waiting.result).resolves.toMatchObject({ matched: true });
  });
});

describe("browser_wait navigation failures", () => {
  test("a top-frame navigation error fails a load wait with the net error and no URL", async () => {
    const runtime = newRuntime();
    const failedUrl = "https://private.example/account?token=secret";
    // A long timeout shows the failure surfaces from the event, not from timing out.
    const waiting = await startWait(runtime, { kind: "load" }, 30_000);
    fire("onErrorOccurred", { url: failedUrl, error: "net::ERR_NAME_NOT_RESOLVED" });
    // Chrome shows an error page, so tab polling alone would report a finished load.
    tab.status = "complete";
    tab.url = failedUrl;
    await advanceTimers(200);
    const error = await waiting.result.then(() => undefined, (caught: unknown) => caught as Error & Record<string, unknown>);
    expect(error).toMatchObject({ code: "navigation_failed", outcome: "unknown" });
    expect(error?.message).toContain("net::ERR_NAME_NOT_RESOLVED");
    expect(error?.message).not.toContain("private.example");
  });

  test("a top-frame navigation error fails a url wait even when the tab shows the target URL", async () => {
    const runtime = newRuntime();
    const target = "https://app.example/unreachable";
    const waiting = await startWait(runtime, { kind: "url", value: target });
    tab.url = target;
    fire("onErrorOccurred", { url: target, error: "net::ERR_CONNECTION_REFUSED" });
    await advanceTimers(200);
    await expect(waiting.result).rejects.toMatchObject({ code: "navigation_failed" });
  });

  test("an aborted or subframe navigation does not fail the wait", async () => {
    const runtime = newRuntime();
    const waiting = await startWait(runtime, { kind: "load" });
    fire("onErrorOccurred", { error: "net::ERR_ABORTED" });
    fire("onErrorOccurred", { frameId: 4, error: "net::ERR_CONNECTION_RESET" });
    await advanceTimers(250);
    expect(waiting.settled()).toBe(false);
    fire("onCompleted", {});
    await advanceTimers(200);
    await expect(waiting.result).resolves.toMatchObject({ matched: true });
  });

  test("a newer top-frame commit after an error keeps the wait alive", async () => {
    const runtime = newRuntime();
    const waiting = await startWait(runtime, { kind: "load" });
    fire("onErrorOccurred", { error: "net::ERR_TIMED_OUT" });
    fire("onCommitted", { url: "https://app.example/retry" });
    fire("onCompleted", { url: "https://app.example/retry" });
    await advanceTimers(200);
    await expect(waiting.result).resolves.toMatchObject({ matched: true });
  });

  test("a finished wait no longer reacts to navigation events", async () => {
    const runtime = newRuntime();
    tab.status = "complete";
    const first = await startWait(runtime, { kind: "load" });
    await advanceTimers(200);
    await expect(first.result).resolves.toMatchObject({ matched: true });
    fire("onErrorOccurred", { error: "net::ERR_FAILED" });
    tab.status = "loading";
    const waiting = await startWait(runtime, { kind: "load" });
    fire("onCompleted", {});
    await advanceTimers(200);
    await expect(waiting.result).resolves.toMatchObject({ matched: true });
  });
});

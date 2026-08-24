import { beforeEach, describe, expect, test } from "bun:test";
import { StandardBrowserRuntime } from "../src/browser";
import { HandoffController, HANDOFF_ALARM } from "../src/handoff";
import { NativeBridge, RECONNECT_ALARM } from "../src/native";
import { OwnershipLedger } from "../src/ownership";
import { parseCommand, type NativeOriginPolicy } from "../src/protocol";
import { RevisionTracker } from "../src/revisions";
import { MutationScheduler } from "../src/scheduler";
import { mutateState, readState, resetStateForTest, STATE_KEY } from "../src/storage";

const LEGACY_TASKS_KEY = "chromeBridgeTaskSessions";
const LEGACY_PREFERENCES_KEY = "chromeBridgePreferences";
const TASK_A = "018f47b8-2f80-7c20-9c77-f8a38c9e621e";
const TASK_B = "018f47b8-2f80-7c20-9c77-f8a38c9e621f";

interface MockTab {
  id: number;
  windowId: number;
  groupId: number;
  active?: boolean;
  openerTabId?: number;
  url?: string;
  pendingUrl?: string;
  status?: string;
  lastAccessed?: number;
  splitViewId?: number;
}

class MockNativePort {
  readonly posted: unknown[] = [];
  readonly messageListeners: Array<(message: unknown) => void> = [];
  readonly disconnectListeners: Array<() => void> = [];
  disconnectCount = 0;

  readonly onMessage = {
    addListener: (listener: (message: unknown) => void): void => {
      this.messageListeners.push(listener);
    },
  };

  readonly onDisconnect = {
    addListener: (listener: () => void): void => {
      this.disconnectListeners.push(listener);
    },
  };

  postMessage(message: unknown): void {
    this.posted.push(clone(message));
  }

  disconnect(): void {
    this.disconnectCount += 1;
    for (const listener of this.disconnectListeners) listener();
  }

  receive(message: unknown): void {
    for (const listener of this.messageListeners) listener(clone(message));
  }
}

let persisted: Record<string, unknown>;
let debuggerCalls: string[];
let tabStore: Map<number, MockTab>;
let removedTabIds: number[];
let failGrouping: boolean;
let nextTabId: number;
let nextGroupId: number;
let scriptResult: boolean;
let alarmCreates: Array<{ name: string; when: number }>;
let alarmClears: string[];
let nativePort: MockNativePort | null;
let tabRemovalProbe: (() => void | Promise<void>) | null;
let normalizeStoredObjectKeys: boolean;
let focusedWindowUpdates: number[];
let focusStealOnClickTabId: number | null;
let callFunctionException: boolean;
let debuggerCommandOverride:
  | ((method: string, params: Record<string, unknown>) => Record<string, unknown> | undefined)
  | null;
let completedDownloads: Array<Record<string, unknown>>;
interface DebuggerCommand {
  method: string;
  params: Record<string, unknown>;
}

type PopupMessageListener = (
  message: unknown,
  sender: { id?: string },
  sendResponse: (response: Record<string, unknown>) => void,
) => boolean | undefined;
type PermissionRemovedListener = (permissions: { permissions?: string[] }) => void;

const EXTENSION_ID = "agenttab-test-extension";

let debuggerCommands: DebuggerCommand[];
let automationPermission: boolean;
let permissionRequests: Array<Record<string, unknown>>;
let permissionRequestResult: boolean;
let popupMessageListeners: PopupMessageListener[];
let permissionRemovedListeners: PermissionRemovedListener[];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function recursivelySortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(recursivelySortObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, recursivelySortObjectKeys(entry)]),
  );
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition did not settle within the bounded wait");
}

function installChromeMock(): void {
  persisted = {};
  debuggerCalls = [];
  tabStore = new Map();
  removedTabIds = [];
  failGrouping = false;
  nextTabId = 100;
  nextGroupId = 50;
  scriptResult = true;
  alarmCreates = [];
  alarmClears = [];
  nativePort = null;
  tabRemovalProbe = null;
  normalizeStoredObjectKeys = false;
  focusedWindowUpdates = [];
  focusStealOnClickTabId = null;
  debuggerCommands = [];
  callFunctionException = false;
  debuggerCommandOverride = null;
  completedDownloads = [];
  automationPermission = true;
  permissionRequests = [];
  permissionRequestResult = true;
  popupMessageListeners = [];
  permissionRemovedListeners = [];
  const listeners = { detach: [] as Array<(...args: unknown[]) => void>, event: [] as Array<(...args: unknown[]) => void> };
  const createTab = (url = "about:blank", active = false, windowId = 1): MockTab => {
    const tab = { id: nextTabId++, windowId, groupId: -1, active, url, status: "complete" };
    tabStore.set(tab.id, tab);
    return tab;
  };
  Object.assign(globalThis, {
    chrome: {
      storage: {
        local: {
          async get(keys: string | string[] | null) {
            if (keys === null) return clone(persisted);
            const selected = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(selected.filter((key) => key in persisted).map((key) => [key, clone(persisted[key])]));
          },
          async set(values: Record<string, unknown>) {
            Object.assign(
              persisted,
              normalizeStoredObjectKeys ? recursivelySortObjectKeys(values) : clone(values),
            );
          },
          async remove(keys: string | string[]) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete persisted[key];
          },
        },
      },
      debugger: {
        onDetach: { addListener(listener: (...args: unknown[]) => void) { listeners.detach.push(listener); } },
        onEvent: { addListener(listener: (...args: unknown[]) => void) { listeners.event.push(listener); } },
        async attach() { debuggerCalls.push("attach"); },
        async detach() { debuggerCalls.push("detach"); },
        async sendCommand(_target: unknown, method: string, params: Record<string, unknown>) {
          debuggerCalls.push(method);
          debuggerCommands.push({ method, params: clone(params) });
          const overridden = debuggerCommandOverride?.(method, clone(params));
          if (overridden !== undefined) return clone(overridden);
          if (method === "DOM.getDocument") return { root: { nodeId: 1, backendNodeId: 1 } };
          if (method === "Page.getFrameTree") {
            return { frameTree: { frame: { loaderId: "loader-default" } } };
          }
          if (method === "DOM.resolveNode") return { object: { objectId: `node-${String(params.backendNodeId)}` } };
          if (method === "DOM.getBoxModel") return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
          if (method === "Runtime.callFunctionOn" && callFunctionException) {
            return { exceptionDetails: { text: "Uncaught" } };
          }
          if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration).includes("const f=this.form")) {
            return { result: { value: { tag: "BUTTON", text: "Place order" } } };
          }
          if (
            method === "Runtime.callFunctionOn" &&
            params.functionDeclaration === "function(){this.click()}" &&
            focusStealOnClickTabId !== null
          ) {
            const target = tabStore.get(focusStealOnClickTabId);
            if (target) {
              for (const tab of tabStore.values()) {
                if (tab.windowId === target.windowId) tab.active = false;
              }
              target.active = true;
            }
          }
          return {};
        },
      },
      tabs: {
        onCreated: { addListener() { } },
        onRemoved: { addListener() { } },
        onUpdated: { addListener() { } },
        onAttached: { addListener() { } },
        onDetached: { addListener() { } },
        SPLIT_VIEW_ID_NONE: -1,
        async get(tabId: number) {
          return clone(tabStore.get(tabId) ?? {
            id: tabId,
            windowId: 1,
            groupId: -1,
            status: "complete",
            url: "https://example.test/",
          });
        },
        async query(query: Record<string, unknown>) {
          let tabs = [...tabStore.values()];
          if (typeof query.windowId === "number") tabs = tabs.filter((tab) => tab.windowId === query.windowId);
          if (query.active === true) tabs = tabs.filter((tab) => tab.active);
          return clone(tabs);
        },
        async create(options: Record<string, unknown>) {
          return clone(createTab(
            typeof options.url === "string" ? options.url : "about:blank",
            options.active === true,
            typeof options.windowId === "number" ? options.windowId : 1,
          ));
        },
        async move(tabIds: number | number[], options: { windowId: number; index: number }) {
          const moved: MockTab[] = [];
          for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
            const tab = tabStore.get(tabId);
            if (!tab) continue;
            if (tab.active) {
              for (const candidate of tabStore.values()) {
                if (candidate.windowId === options.windowId) candidate.active = false;
              }
            }
            tab.windowId = options.windowId;
            moved.push(tab);
          }
          return clone(Array.isArray(tabIds) ? moved : moved[0]);
        },
        async group(options: { tabIds: number | number[]; groupId?: number }) {
          if (failGrouping) throw new Error("grouping unavailable");
          const groupId = options.groupId ?? nextGroupId++;
          for (const tabId of Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds]) {
            const tab = tabStore.get(tabId);
            if (tab) tab.groupId = groupId;
          }
          return groupId;
        },
        async ungroup(tabIds: number | number[]) {
          for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
            const tab = tabStore.get(tabId);
            if (tab) tab.groupId = -1;
          }
        },
        async remove(tabIds: number | number[]) {
          if (tabRemovalProbe) await tabRemovalProbe();
          for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
            removedTabIds.push(tabId);
            tabStore.delete(tabId);
          }
        },
        async update(tabId: number, changes: Record<string, unknown>) {
          const tab = tabStore.get(tabId) ?? {
            id: tabId,
            windowId: 1,
            groupId: -1,
            status: "complete",
            url: "https://example.test/",
          };
          if (changes.active === true) {
            for (const candidate of tabStore.values()) {
              if (candidate.id !== tabId && candidate.windowId === tab.windowId) candidate.active = false;
            }
          }
          Object.assign(tab, changes);
          tabStore.set(tabId, tab);
          return clone(tab);
        },
        async goBack() { },
        async goForward() { },
        async reload() { },
      },
      scripting: { async executeScript() { return [{ result: scriptResult }]; } },
      windows: {
        async getAll() {
          return [{ id: 1, tabs: clone([...tabStore.values()]) }];
        },
        async create(options: Record<string, unknown>) {
          return {
            id: 2,
            tabs: [clone(createTab(
              typeof options.url === "string" ? options.url : "about:blank",
              options.focused === true,
              2,
            ))],
          };
        },
        async update(windowId: number, changes: Record<string, unknown>) {
          if (changes.focused === true) focusedWindowUpdates.push(windowId);
        },
      },
      tabGroups: {
        async update() { },
        onRemoved: { addListener() { } },
      },
      downloads: { async search() { return clone(completedDownloads); } },
      alarms: {
        create(name: string, options: { when: number }) {
          alarmCreates.push({ name, when: options.when });
        },
        async clear(name: string) {
          alarmClears.push(name);
          return true;
        },
        onAlarm: { addListener() { } },
      },
      action: {
        async setBadgeText() { },
        async setBadgeBackgroundColor() { },
        async openPopup() { },
      },
      permissions: {
        async contains() { return automationPermission; },
        async request(request: Record<string, unknown>) {
          permissionRequests.push(clone(request));
          automationPermission = permissionRequestResult;
          return permissionRequestResult;
        },
        onRemoved: {
          addListener(listener: PermissionRemovedListener) {
            permissionRemovedListeners.push(listener);
          },
        },
      },
      runtime: {
        id: EXTENSION_ID,
        getManifest() { return { version: "0.2.0" }; },
        connectNative() {
          if (!nativePort) throw new Error("native host unavailable");
          return nativePort;
        },
        onMessage: {
          addListener(listener: PopupMessageListener) {
            popupMessageListeners.push(listener);
          },
        },
        onStartup: { addListener() { } },
        onInstalled: { addListener() { } },
      },
    },
  });
  resetStateForTest();
}

async function seedTask(taskId: string, tabIds: number[], groupId = 5): Promise<void> {
  for (const tabId of tabIds) {
    tabStore.set(tabId, {
      id: tabId,
      windowId: 1,
      groupId,
      url: "https://example.test/",
      status: "complete",
    });
  }
  await mutateState((state) => {
    state.tasks[taskId] = {
      taskId,
      name: `Task ${taskId.slice(0, 8)}`,
      groupId,
      tabIds: [...tabIds],
      color: "purple",
      state: "working",
      createdAt: 1,
      updatedAt: 1,
    };
  });
}
const NATIVE_CONNECTION_ID = "018f47b8-2f80-7c20-9c77-f8a38c9e6220";

async function sendNativeCommand(
  requestId: string,
  taskId: string,
  method: string,
  params: Record<string, unknown>,
  originPolicy?: NativeOriginPolicy,
): Promise<Record<string, unknown>> {
  const port = nativePort;
  if (!port) throw new Error("native port is unavailable");
  port.receive({
    protocol: "agenttab.native",
    version: 1,
    kind: "command",
    request_id: requestId,
    task_id: taskId,
    connection_id: NATIVE_CONNECTION_ID,
    method,
    params,
    ...(originPolicy === undefined ? {} : { origin_policy: originPolicy }),
  });
  await waitForCondition(() =>
    port.posted.some(
      (message) =>
        message !== null &&
        typeof message === "object" &&
        (message as Record<string, unknown>).kind === "response" &&
        (message as Record<string, unknown>).request_id === requestId,
    ),
  );
  const response = port.posted.findLast(
    (message) =>
      message !== null &&
      typeof message === "object" &&
      (message as Record<string, unknown>).kind === "response" &&
      (message as Record<string, unknown>).request_id === requestId,
  );
  if (!response || typeof response !== "object") throw new Error("native command did not produce a response");
  return response as Record<string, unknown>;
}

async function sendPopupMessage(message: unknown): Promise<unknown> {
  const listener = popupMessageListeners.at(-1);
  if (!listener) throw new Error("popup message listener is unavailable");
  return new Promise((resolve) => {
    let settled = false;
    const keepChannelOpen = listener(message, { id: EXTENSION_ID }, (response) => {
      settled = true;
      resolve(response);
    });
    if (keepChannelOpen !== true && !settled) resolve(undefined);
  });
}

beforeEach(installChromeMock);

describe("native protocol", () => {
  test("accepts only strict versioned Core commands", () => {
    const command = parseCommand({
      protocol: "agenttab.native",
      version: 1,
      kind: "command",
      request_id: "018f47b8-2f80-7c20-9c77-f8a38c9e621d",
      task_id: "018f47b8-2f80-7c20-9c77-f8a38c9e621e",
      connection_id: "018f47b8-2f80-7c20-9c77-f8a38c9e621f",
      method: "browser_tabs",
      params: {},
    });
    expect(command.method).toBe("browser_tabs");
    expect(() => parseCommand({ ...command, extra: true })).toThrow("unknown fields");
    expect(() => parseCommand({ ...command, version: 2 })).toThrow("mismatch");
    expect(() => parseCommand({ ...command, task_id: "not-a-uuid" })).toThrow("UUIDs");
    expect(parseCommand({
      ...command,
      origin_policy: {
        tab_id: 42,
        allowed_origins: ["https://example.test"],
        denied_origins: ["*.blocked.test"],
      },
    }).origin_policy).toEqual({
      tab_id: 42,
      allowed_origins: ["https://example.test"],
      denied_origins: ["*.blocked.test"],
    });
    expect(() => parseCommand({
      ...command,
      origin_policy: {
        tab_id: 42,
        allowed_origins: [""],
        denied_origins: [],
      },
    })).toThrow("non-empty strings");
  });
});

describe("mutation scheduler", () => {
  test("serializes one tab while allowing another tab to progress", async () => {
    const scheduler = new MutationScheduler();
    const firstGate = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = scheduler.enqueueTab("task-a", 1, async () => {
      order.push("first-start");
      await firstGate.promise;
      order.push("first-end");
    });
    const second = scheduler.enqueueTab("task-a", 1, async () => { order.push("second"); });
    const other = scheduler.enqueueTab("task-b", 2, async () => { order.push("other"); });
    await other;
    expect(order).toEqual(["first-start", "other"]);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "other", "first-end", "second"]);
  });

  test("global mutations exclude tab writers admitted on either side", async () => {
    const scheduler = new MutationScheduler();
    const firstGate = Promise.withResolvers<void>();
    const firstStarted = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = scheduler.enqueueTab("task-a", 1, async () => {
      order.push("tab-start");
      firstStarted.resolve();
      await firstGate.promise;
      order.push("tab-end");
    });
    const global = scheduler.enqueueGlobal(async () => {
      order.push("global");
    });
    const later = scheduler.enqueueTab("task-b", 2, async () => {
      order.push("later-tab");
    });

    await firstStarted.promise;
    expect(order).toEqual(["tab-start"]);
    firstGate.resolve();
    await Promise.all([first, global, later]);
    expect(order).toEqual(["tab-start", "tab-end", "global", "later-tab"]);
  });

  test("holds an observation behind its tab writer without blocking another tab", async () => {
    const scheduler = new MutationScheduler();
    const writerGate = Promise.withResolvers<void>();
    const writerStarted = Promise.withResolvers<void>();
    const order: string[] = [];
    const writer = scheduler.enqueueTab(TASK_A, 41, async () => {
      order.push("writer-start");
      writerStarted.resolve();
      await writerGate.promise;
      order.push("writer-end");
    });
    const sameTabRead = scheduler.readAfterWrites(41, async () => {
      order.push("same-tab-read");
    });
    const otherTabRead = scheduler.readAfterWrites(42, async () => {
      order.push("other-tab-read");
    });

    await writerStarted.promise;
    await otherTabRead;
    expect(order).toEqual(["writer-start", "other-tab-read"]);

    writerGate.resolve();
    await Promise.all([writer, sameTabRead]);
    expect(order).toEqual(["writer-start", "other-tab-read", "writer-end", "same-tab-read"]);
  });

  test("navigation rejects an admitted mutation before it starts", async () => {
    const scheduler = new MutationScheduler();
    const firstGate = Promise.withResolvers<void>();
    const firstStarted = Promise.withResolvers<void>();
    const first = scheduler.enqueueTab("task-a", 4, () => {
      firstStarted.resolve();
      return firstGate.promise;
    });
    const stale = scheduler.enqueueTab("task-a", 4, async () => "should not run");
    const staleOutcome = stale.then(
      () => null,
      (error: unknown) => error,
    );
    await firstStarted.promise;
    scheduler.invalidateTab(4);
    firstGate.resolve();
    await first;
    expect(await staleOutcome).toMatchObject({ code: "stale_revision" });
  });

  test("pause lets the active write finish and rejects queued and new writes", async () => {
    const scheduler = new MutationScheduler();
    const activeGate = Promise.withResolvers<void>();
    const activeStarted = Promise.withResolvers<void>();
    const active = scheduler.enqueueTab(TASK_A, 4, async () => {
      activeStarted.resolve();
      await activeGate.promise;
      return "finished";
    });
    const queued = scheduler.enqueueTab(TASK_A, 4, async () => "must not run");
    const queuedOutcome = queued.then(
      () => null,
      (error: unknown) => error,
    );
    await activeStarted.promise;

    const paused = scheduler.pause();
    await expect(scheduler.enqueueTab(TASK_B, 5, async () => "must not run")).rejects.toMatchObject({
      code: "paused",
    });
    activeGate.resolve();

    expect(await active).toBe("finished");
    await paused;
    expect(await queuedOutcome).toMatchObject({ code: "paused" });
    expect(scheduler.isAccepting()).toBe(false);
  });
});

describe("durable extension state", () => {
  test("migrates legacy task ownership and verifies the persisted replacement", async () => {
    persisted[LEGACY_TASKS_KEY] = {
      "018f47b8-2f80-7c20-9c77-f8a38c9e621e": {
        name: "Imported task",
        groupId: 9,
        tabIds: [41],
        color: "cyan",
        state: "working",
      },
    };
    persisted[LEGACY_PREFERENCES_KEY] = { showAgentPointer: false };
    const state = await readState();
    expect(Object.values(state.tasks)[0]).toMatchObject({ groupId: 9, tabIds: [41], legacyImported: true });
    expect(state.showAgentPointer).toBe(false);
    expect(persisted[STATE_KEY]).toBeDefined();
    expect(persisted[LEGACY_TASKS_KEY]).toBeUndefined();
    expect(persisted[LEGACY_PREFERENCES_KEY]).toBeUndefined();
  });

  test("accepts Chrome storage read-back with normalized object-key order", async () => {
    normalizeStoredObjectKeys = true;
    await mutateState((state) => {
      state.tasks[TASK_A] = {
        taskId: TASK_A,
        name: "Key-order-safe task",
        groupId: 9,
        tabIds: [41],
        color: "cyan",
        state: "working",
        createdAt: 1,
        updatedAt: 2,
      };
    });

    expect((await readState()).tasks[TASK_A]).toMatchObject({
      name: "Key-order-safe task",
      groupId: 9,
      tabIds: [41],
    });
  });
});

describe("page revision monotonicity", () => {
  test("persists the revision floor across service-worker restarts", async () => {
    await mutateState((state) => {
      state.revisions["5"] = { floor: 10, current: 10, documentId: "document-a", loaderId: "loader-a" };
    });
    resetStateForTest();

    const restored = new RevisionTracker();
    expect(await restored.ensure(5)).toBe(10);
    expect(await restored.observeDocument(5, "document-a", "loader-a")).toBe(10);
    expect(await restored.observeDocument(5, "document-b", "loader-b")).toBe(11);

    resetStateForTest();
    expect(await new RevisionTracker().ensure(5)).toBe(11);
    expect((await readState()).revisions["5"]).toMatchObject({ floor: 11, current: 11 });
  });

  test("rejects an old page revision after navigation", async () => {
    const revisions = new RevisionTracker();
    const original = await revisions.ensure(6);
    expect(await revisions.markNavigation(6)).toBe(original + 1);
    await expect(revisions.assertExpected(6, original)).rejects.toMatchObject({
      code: "stale_revision",
      currentPageRevision: original + 1,
    });
  });

  test("keeps a snapshot revision stable until Chrome reports a new document", async () => {
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined);
    const first = await runtime.snapshot(61, { mode: "accessibility" });
    const second = await runtime.snapshot(61, { mode: "accessibility" });

    expect(first.page_revision).toBe(1);
    expect(second.page_revision).toBe(1);
    expect((await readState()).revisions["61"]).toMatchObject({ floor: 1, current: 1 });
    await runtime.detach(61);
  });

  test("rejects an accessibility snapshot when the document changes during capture", async () => {
    let frameTreeReads = 0;
    debuggerCommandOverride = (method) => {
      if (method === "Page.getFrameTree") {
        frameTreeReads += 1;
        return {
          frameTree: {
            frame: { loaderId: frameTreeReads === 1 ? "loader-before" : "loader-after" },
          },
        };
      }
      return undefined;
    };
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined);

    await expect(runtime.snapshot(61, { mode: "accessibility" })).rejects.toMatchObject({
      code: "stale_revision",
      currentPageRevision: 2,
    });
    expect((await readState()).revisions["61"]).toMatchObject({ floor: 2, current: 2 });
  });

  test("matches only downloads completed after the wait starts", async () => {
    completedDownloads = [{
      id: 1,
      state: "complete",
      endTime: new Date(Date.now() - 60_000).toISOString(),
    }];
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined);

    await expect(runtime.wait(61, {
      condition: { kind: "download" },
      timeout_ms: 1,
    })).rejects.toMatchObject({ code: "wait_timeout" });

    completedDownloads = [];
    const waiting = runtime.wait(61, {
      condition: { kind: "download" },
      timeout_ms: 500,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    completedDownloads = [{
      id: 2,
      state: "complete",
      endTime: new Date().toISOString(),
    }];
    await expect(waiting).resolves.toMatchObject({
      tab_id: 61,
      condition: "download",
      matched: true,
    });
  });

  test("types into a background field through one DOM mutation", async () => {
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined);
    const pageRevision = await revisions.ensure(63);

    await runtime.act(TASK_A, 63, pageRevision, [
      { kind: "type", ref: `r${pageRevision}-22`, text: "x" },
    ]);

    const calls = debuggerCommands.filter(({ method }) => method === "Runtime.callFunctionOn");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params.functionDeclaration).toContain("InputEvent('input'");
    expect(debuggerCalls).not.toContain("Input.insertText");
  });

  test("rejects a page action that raises in the target document", async () => {
    callFunctionException = true;
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined);
    const pageRevision = await revisions.ensure(64);

    await expect(
      runtime.act(TASK_A, 64, pageRevision, [
        { kind: "type", ref: `r${pageRevision}-22`, text: "x" },
      ]),
    ).rejects.toMatchObject({ code: "action_failed" });
  });

  test("advances a tab revision past its generation floor after revocation and re-adoption", async () => {
    await seedTask(TASK_A, [62]);
    const tab = tabStore.get(62);
    if (!tab) throw new Error("missing test tab");
    tab.active = true;
    const scheduler = new MutationScheduler();
    const revisions = new RevisionTracker();
    const ownership = new OwnershipLedger(scheduler, revisions, () => undefined);
    await revisions.ensure(62);
    const beforeRevocation = await revisions.markNavigation(62);

    await ownership.revoke(62, "ownership_revoked");
    const adopted = await ownership.adoptActive(TASK_A);

    expect(adopted).toMatchObject({ tab_id: 62 });
    expect(Number(adopted.page_revision)).toBeGreaterThan(beforeRevocation);
    expect(await revisions.current(62)).toBeGreaterThan(beforeRevocation);
    expect((await readState()).revisions["62"]?.floor).toBeGreaterThan(beforeRevocation);
  });
});

describe("ownership and task isolation", () => {
  test("removes a newly created tab when visible grouping fails", async () => {
    const scheduler = new MutationScheduler();
    const revisions = new RevisionTracker();
    const ownership = new OwnershipLedger(scheduler, revisions, () => undefined);
    failGrouping = true;

    await expect(ownership.open(TASK_A, { mode: "create", url: "https://example.test/new" }))
      .rejects.toMatchObject({ code: "grouping_failed" });

    expect(removedTabIds).toEqual([100]);
    expect((await readState()).tasks).toEqual({});
  });

  test("publishes a loading tab's pending URL in native inventory", async () => {
    await seedTask(TASK_A, [31], 7);
    const tab = tabStore.get(31);
    if (!tab) throw new Error("missing test tab");
    delete tab.url;
    tab.pendingUrl = "https://example.test/loading";
    const ownership = new OwnershipLedger(
      new MutationScheduler(),
      new RevisionTracker(),
      () => undefined,
    );

    expect(await ownership.inventory()).toEqual([{
      tab_id: 31,
      window_id: 1,
      group_id: 7,
      url: "https://example.test/loading",
      page_revision: 1,
      task_id: TASK_A,
    }]);
  });

  test("reconciliation revokes a moved tab and its queued mutation", async () => {
    await seedTask(TASK_A, [11, 12]);
    const moved = tabStore.get(12);
    if (!moved) throw new Error("missing test tab");
    moved.groupId = 9;

    const scheduler = new MutationScheduler();
    const revisions = new RevisionTracker();
    const events: string[] = [];
    const ownership = new OwnershipLedger(scheduler, revisions, (event) => events.push(event));
    const activeGate = Promise.withResolvers<void>();
    const activeStarted = Promise.withResolvers<void>();
    const active = scheduler.enqueueTab(TASK_A, 12, async () => {
      activeStarted.resolve();
      await activeGate.promise;
    });
    const queued = scheduler.enqueueTab(TASK_A, 12, async () => "must not run");
    const queuedOutcome = queued.then(
      () => null,
      (error: unknown) => error,
    );
    await activeStarted.promise;

    await ownership.reconcile();
    activeGate.resolve();
    await active;

    expect((await readState()).tasks[TASK_A]?.tabIds).toEqual([11]);
    expect(await queuedOutcome).toMatchObject({ code: "ownership_revoked" });
    expect(events).toContain("ownership_revoked");
  });

  test("inherits opener ownership across popup windows and restores the destination selection", async () => {
    await seedTask(TASK_A, [21]);
    tabStore.set(20, {
      id: 20,
      windowId: 1,
      groupId: -1,
      active: true,
      url: "https://example.test/active",
    });
    const scheduler = new MutationScheduler();
    const revisions = new RevisionTracker();
    const ownership = new OwnershipLedger(scheduler, revisions, () => undefined);
    tabStore.set(22, {
      id: 22,
      windowId: 2,
      groupId: -1,
      active: true,
      openerTabId: 21,
      url: "https://example.test/child",
    });

    await ownership.adoptOwnedChild(tabStore.get(22) ?? {});
    expect((await readState()).tasks[TASK_A]?.tabIds).toEqual([21, 22]);
    expect(tabStore.get(22)).toMatchObject({ windowId: 1, groupId: 5, active: false });
    expect(tabStore.get(20)?.active).toBe(true);
    expect(focusedWindowUpdates).toEqual([1]);
    let taskDeletedBeforeRemove = false;
    tabRemovalProbe = async () => {
      taskDeletedBeforeRemove = (await readState()).tasks[TASK_A] === undefined;
    };
    await ownership.closeTask(TASK_A);

    expect(taskDeletedBeforeRemove).toBe(true);
    expect(removedTabIds).toEqual([21, 22]);
    expect((await readState()).tasks[TASK_A]).toBeUndefined();
  });

  test("inherits task-group ownership when Chrome reports an unowned opener", async () => {
    await seedTask(TASK_A, [21]);
    tabStore.set(99, {
      id: 99,
      windowId: 1,
      groupId: -1,
      active: true,
      url: "chrome-extension://agenttab/popup.html",
    });
    tabStore.set(22, {
      id: 22,
      windowId: 1,
      groupId: 5,
      active: false,
      openerTabId: 99,
      url: "https://example.test/child",
    });
    const ownership = new OwnershipLedger(
      new MutationScheduler(),
      new RevisionTracker(),
      () => undefined,
    );

    await ownership.adoptOwnedChild(tabStore.get(22) ?? {});

    expect((await readState()).tasks[TASK_A]?.tabIds).toEqual([21, 22]);
    expect(tabStore.get(22)).toMatchObject({ windowId: 1, groupId: 5, active: false });
    expect(tabStore.get(99)?.active).toBe(true);
  });

  test("closes a task before a queued tab mutation can execute", async () => {
    await seedTask(TASK_A, [23]);
    const scheduler = new MutationScheduler();
    const ownership = new OwnershipLedger(scheduler, new RevisionTracker(), () => undefined);
    const activeGate = Promise.withResolvers<void>();
    const activeStarted = Promise.withResolvers<void>();
    const active = scheduler.enqueueTab(TASK_A, 23, async () => {
      activeStarted.resolve();
      await activeGate.promise;
    });
    const queued = scheduler.enqueueTab(TASK_A, 23, async () => "must not run");
    const queuedOutcome = queued.then(
      () => null,
      (error: unknown) => error,
    );

    await activeStarted.promise;
    await ownership.closeTask(TASK_A);
    activeGate.resolve();
    await active;

    expect(await queuedOutcome).toMatchObject({ code: "ownership_revoked" });
    expect(removedTabIds).toEqual([23]);
    expect((await readState()).tasks[TASK_A]).toBeUndefined();
  });
});

describe("handoff and pause barriers", () => {
  test("keeps the global pause active until the completion condition matches", async () => {
    await seedTask(TASK_A, [31]);
    const scheduler = new MutationScheduler();
    const revisions = new RevisionTracker();
    const events: string[] = [];
    let clearEventId: string | undefined;
    const ownership = new OwnershipLedger(scheduler, revisions, (event) => events.push(event));
    const handoff = new HandoffController(scheduler, revisions, ownership, (event, _payload, eventId) => {
      events.push(event);
      if (event === "handoff_changed" && eventId) clearEventId = eventId;
    });
    const pageRevision = await revisions.ensure(31);
    scriptResult = false;

    await handoff.begin(TASK_A, {
      tab_id: 31,
      expected_page_revision: pageRevision,
      prompt: "Complete authentication",
      completion: { kind: "selector", value: "#signed-in" },
      timeout_ms: 60_000,
    });

    expect(scheduler.isAccepting()).toBe(false);
    expect((await readState()).handoff.active).toBe(true);
    expect((await readState()).tasks[TASK_A]?.state).toBe("needs_user");
    expect(await handoff.finish(true)).toMatchObject({
      completed: false,
      reason: "The handoff completion condition has not been met",
    });
    expect(scheduler.isAccepting()).toBe(false);
    expect((await readState()).handoff.active).toBe(true);

    scriptResult = true;
    expect(await handoff.finish(true)).toEqual({ completed: true });
    expect(scheduler.isAccepting()).toBe(false);
    const pendingHandoff = (await readState()).handoff;
    if (!pendingHandoff.active || !pendingHandoff.pendingClearEventId || !clearEventId) {
      throw new Error("handoff completion must await a native acknowledgment");
    }
    expect(clearEventId).toBe(pendingHandoff.pendingClearEventId);
    await handoff.acknowledgeEvent("handoff_changed", clearEventId);
    expect(scheduler.isAccepting()).toBe(true);
    expect((await readState()).handoff).toEqual({ active: false });
    expect((await readState()).tasks[TASK_A]?.state).toBe("working");
    expect(events.filter((event) => event === "handoff_changed")).toHaveLength(2);
  });

  test("requires acknowledgment to clear an expired handoff without resuming manual Pause", async () => {
    await seedTask(TASK_A, [32]);
    const scheduler = new MutationScheduler();
    const revisions = new RevisionTracker();
    const ownership = new OwnershipLedger(scheduler, revisions, () => undefined);
    let clearEventId: string | undefined;
    const handoff = new HandoffController(scheduler, revisions, ownership, (event, _payload, eventId) => {
      if (event === "handoff_changed" && eventId) clearEventId = eventId;
    });
    const pageRevision = await revisions.ensure(32);
    await mutateState((state) => {
      state.paused = true;
      state.tasks[TASK_A].state = "needs_user";
      state.handoff = {
        active: true,
        taskId: TASK_A,
        tabId: 32,
        expectedRevision: pageRevision,
        prompt: "Expired",
        completion: { kind: "manual_done" },
        startedAtMs: 1,
        timeoutMs: 1,
      };
    });
    scheduler.setInitialPaused(true);

    await handoff.restore();

    const pendingState = await readState();
    if (!pendingState.handoff.active || !pendingState.handoff.pendingClearEventId || !clearEventId) {
      throw new Error("expired handoff must await a native acknowledgment");
    }
    expect(clearEventId).toBe(pendingState.handoff.pendingClearEventId);
    expect(pendingState.paused).toBe(true);
    expect(scheduler.isAccepting()).toBe(false);
    await handoff.acknowledgeEvent("handoff_changed", clearEventId);
    const state = await readState();
    expect(state.handoff).toEqual({ active: false });
    expect(state.paused).toBe(true);
    expect(state.tasks[TASK_A]?.state).toBe("working");
    expect(scheduler.isAccepting()).toBe(false);
    expect(alarmClears).toContain(HANDOFF_ALARM);
  });
});

describe("native bridge transport", () => {
  test("reconciles hello, resets backoff only after ready, and pauses on disconnect", async () => {
    const scheduler = new MutationScheduler();
    const revisions = new RevisionTracker();
    const ownership = new OwnershipLedger(scheduler, revisions, () => undefined);
    await seedTask(TASK_A, [44], 12);
    const port = new MockNativePort();
    nativePort = port;
    scheduler.disconnect();
    const bridge = new NativeBridge(scheduler, ownership, async (command) => ({
      protocol: "agenttab.native",
      version: 1,
      kind: "response",
      request_id: command.request_id,
      outcome: "completed",
      result: {},
    }));

    await bridge.connect();
    expect(port.posted[0]).toMatchObject({
      protocol: "agenttab.native",
      version: 1,
      kind: "hello",
      extension_version: "0.2.0",
      inventory: [{
        tab_id: 44,
        window_id: 1,
        group_id: 12,
        url: "https://example.test/",
        page_revision: 1,
        task_id: TASK_A,
      }],
      paused: false,
      handoff: { active: false },
      staged_commits: [],
    });
    expect(scheduler.isAccepting()).toBe(false);

    port.receive({
      protocol: "agenttab.native",
      version: 1,
      kind: "ready",
      host_version: "0.2.0",
      state: "ready",
    });
    await waitForCondition(() => scheduler.isAccepting());
    expect(scheduler.isAccepting()).toBe(true);
    expect(alarmClears).toContain(RECONNECT_ALARM);

    const disconnectedAt = Date.now();
    port.disconnect();
    expect(scheduler.isAccepting()).toBe(false);
    expect(alarmCreates.at(-1)).toMatchObject({ name: RECONNECT_ALARM });
    expect(alarmCreates.at(-1)?.when).toBeGreaterThanOrEqual(disconnectedAt + 1_000);
    expect(alarmCreates.at(-1)?.when).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  test("disconnects on a malformed ready frame", async () => {
    const scheduler = new MutationScheduler();
    const ownership = new OwnershipLedger(scheduler, new RevisionTracker(), () => undefined);
    const port = new MockNativePort();
    nativePort = port;
    const bridge = new NativeBridge(scheduler, ownership, async () => {
      throw new Error("command handler must not run");
    });
    await bridge.connect();

    port.receive({
      protocol: "agenttab.native",
      version: 1,
      kind: "ready",
      host_version: "0.2.0",
      state: "ready",
      unexpected: true,
    });

    expect(port.disconnectCount).toBe(1);
    expect(scheduler.isAccepting()).toBe(false);
  });
});

describe("consequential action staging", () => {
  test("stages a purchase-like click, commits it once, and consumes the token", async () => {
    tabStore.set(90, { id: 90, windowId: 1, groupId: -1, active: true });
    tabStore.set(7, { id: 7, windowId: 1, groupId: -1, active: false });
    focusStealOnClickTabId = 7;
    const revisions = new RevisionTracker();
    const events: string[] = [];
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, (event) => events.push(event));
    const pageRevision = await revisions.ensure(7);
    const prepared = await runtime.act(
      "018f47b8-2f80-7c20-9c77-f8a38c9e621e",
      7,
      pageRevision,
      [{ kind: "click", ref: `r${pageRevision}-22` }],
    );
    expect(prepared.staged?.effect).toContain("Place order");
    expect(debuggerCalls.filter((call) => call === "Runtime.callFunctionOn")).toHaveLength(1);
    const token = prepared.staged?.native_token;
    expect(typeof token).toBe("string");
    const result = await runtime.commit("018f47b8-2f80-7c20-9c77-f8a38c9e621e", { native_token: token });
    expect(result.actions).toHaveLength(1);
    expect(tabStore.get(90)?.active).toBe(true);
    expect(tabStore.get(7)?.active).toBe(false);
    expect(focusedWindowUpdates).toEqual([1]);
    expect(
      debuggerCommands.filter(
        ({ method, params }) =>
          method === "Runtime.callFunctionOn" &&
          params.functionDeclaration === "function(){this.click()}" &&
          params.userGesture === true,
      ),
    ).toHaveLength(1);
    await expect(
      runtime.commit("018f47b8-2f80-7c20-9c77-f8a38c9e621e", { native_token: token }),
    ).rejects.toMatchObject({ code: "invalid_staged_token" });
    await runtime.detach(7);
    expect(events).toEqual([]);
  });
  test("preserves a concurrent human tab selection during a task click", async () => {
    tabStore.set(90, { id: 90, windowId: 1, groupId: -1, active: true });
    tabStore.set(7, { id: 7, windowId: 1, groupId: -1, active: false });
    tabStore.set(91, { id: 91, windowId: 1, groupId: -1, active: false });
    focusStealOnClickTabId = 91;
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined);
    const pageRevision = await revisions.ensure(7);
    const prepared = await runtime.act(TASK_A, 7, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);

    await runtime.commit(TASK_A, { native_token: prepared.staged?.native_token });

    expect(tabStore.get(90)?.active).toBe(false);
    expect(tabStore.get(91)?.active).toBe(true);
    expect(focusedWindowUpdates).toEqual([]);
  });


  test("rejects and deletes an expired staged token", async () => {
    const revisions = new RevisionTracker();
    const events: string[] = [];
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, (event) => events.push(event));
    const pageRevision = await revisions.ensure(8);
    const prepared = await runtime.act(TASK_A, 8, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);
    const token = prepared.staged?.native_token;
    if (!token) throw new Error("expected staged token");
    await mutateState((state) => {
      state.stagedCommits[token].expires_at_ms = 0;
    });

    await expect(runtime.commit(TASK_A, { native_token: token })).rejects.toMatchObject({
      code: "staged_commit_expired",
    });
    expect((await readState()).stagedCommits[token]).toBeUndefined();
    expect(events).toEqual(["commit_expired"]);
  });

  test("rejects a tampered staged action before dispatch", async () => {
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined);
    const pageRevision = await revisions.ensure(9);
    const prepared = await runtime.act(TASK_A, 9, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);
    const token = prepared.staged?.native_token;
    if (!token) throw new Error("expected staged token");
    await mutateState((state) => {
      state.stagedCommits[token].action = {
        actions: [{ kind: "type", ref: `r${pageRevision}-22`, text: "tampered" }],
      };
    });

    await expect(runtime.commit(TASK_A, { native_token: token })).rejects.toMatchObject({
      code: "staged_commit_mismatch",
    });
    expect(debuggerCalls.filter((call) => call === "Runtime.callFunctionOn")).toHaveLength(1);
  });

  test("binds staged actions to their original task and page revision", async () => {
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined);
    const pageRevision = await revisions.ensure(10);
    const prepared = await runtime.act(TASK_A, 10, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);
    const token = prepared.staged?.native_token;
    if (!token) throw new Error("expected staged token");

    await expect(runtime.commit(TASK_B, { native_token: token })).rejects.toMatchObject({
      code: "invalid_staged_token",
    });
    expect((await readState()).stagedCommits[token]).toBeDefined();

    await revisions.markNavigation(10);
    await expect(runtime.commit(TASK_A, { native_token: token })).rejects.toMatchObject({
      code: "stale_revision",
    });
    expect(debuggerCalls.filter((call) => call === "Runtime.callFunctionOn")).toHaveLength(1);
  });

  test("prunes expired staged commits while preserving valid ones", async () => {
    const revisions = new RevisionTracker();
    const events: string[] = [];
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, (event) => events.push(event));
    const pageRevision = await revisions.ensure(11);
    const first = await runtime.act(TASK_A, 11, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);
    const second = await runtime.act(TASK_A, 11, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-23` },
    ]);
    const expiredToken = first.staged?.native_token;
    const validToken = second.staged?.native_token;
    if (!expiredToken || !validToken) throw new Error("expected staged tokens");
    await mutateState((state) => {
      state.stagedCommits[expiredToken].expires_at_ms = 0;
    });

    await runtime.expireCommits();

    const state = await readState();
    expect(state.stagedCommits[expiredToken]).toBeUndefined();
    expect(state.stagedCommits[validToken]).toBeDefined();
    expect(events).toEqual(["commit_expired"]);
  });
});

describe("extension entrypoint admission boundaries", () => {
  test("enforces popup sender, permission, pause, handoff, commit, developer, and cleanup gates", async () => {
    const port = new MockNativePort();
    nativePort = port;
    // The background entrypoint must load after the Chrome mock is installed.
    await import("../src/background");
    await waitForCondition(() =>
      port.posted.some(
        (message) =>
          message !== null &&
          typeof message === "object" &&
          (message as Record<string, unknown>).kind === "hello",
      ),
    );
    port.receive({
      protocol: "agenttab.native",
      version: 1,
      kind: "ready",
      host_version: "0.2.0",
      state: "ready",
    });
    await waitForCondition(() => alarmClears.includes(RECONNECT_ALARM));

    const popupListener = popupMessageListeners.at(-1);
    if (!popupListener) throw new Error("popup message listener is unavailable");
    expect(await sendPopupMessage({ kind: "runtime_instance" })).toMatchObject({
      runtime_instance: expect.any(String),
    });
    expect(
      popupListener({ kind: "get_ui_state" }, { id: "other-extension" }, () => undefined),
    ).toBeUndefined();

    const opened = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6221",
      TASK_A,
      "browser_open",
      { mode: "create", url: "https://example.test/workspace" },
    );
    expect(opened).toMatchObject({
      outcome: "completed",
      result: {
        tab_id: 100,
        group_id: 50,
        page_revision: 1,
        tab_count: 1,
      },
    });
    expect(await sendPopupMessage({ kind: "get_ui_state" })).toMatchObject({
      automation_enabled: true,
      paused: false,
      developer_mode: false,
      handoff: null,
      tasks: [{ task_id: TASK_A, state: "working", tab_count: 1 }],
    });

    const currentOriginPolicy: NativeOriginPolicy = {
      tab_id: 100,
      allowed_origins: ["https://example.test"],
      denied_origins: [],
    };
    const allowedAtExecution = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6237",
      TASK_A,
      "browser_snapshot",
      { tab_id: 100, mode: "text" },
      currentOriginPolicy,
    );
    expect(allowedAtExecution).toMatchObject({ outcome: "completed" });
    const openedTab = tabStore.get(100);
    if (!openedTab) throw new Error("opened task tab is unavailable");
    openedTab.url = "https://redirected.test/account";
    const commandsBeforeRedirectRejection = debuggerCommands.length;
    const redirectedOrigin = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6238",
      TASK_A,
      "browser_snapshot",
      { tab_id: 100, mode: "accessibility" },
      currentOriginPolicy,
    );
    expect(redirectedOrigin).toMatchObject({
      outcome: "not_started",
      error: { code: "origin_not_allowed" },
    });
    expect(debuggerCommands).toHaveLength(commandsBeforeRedirectRejection);
    openedTab.url = "https://checkout.example.test/cart";
    const deniedMutation = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6239",
      TASK_A,
      "browser_act",
      {
        tab_id: 100,
        expected_page_revision: 1,
        actions: [{ kind: "scroll", delta_x: 0, delta_y: 1 }],
      },
      {
        tab_id: 100,
        allowed_origins: ["*.example.test"],
        denied_origins: ["https://checkout.example.test"],
      },
    );
    expect(deniedMutation).toMatchObject({
      outcome: "not_started",
      error: { code: "origin_denied" },
    });
    expect(debuggerCommands).toHaveLength(commandsBeforeRedirectRejection);
    openedTab.url = "https://example.test/workspace";

    automationPermission = false;
    const deniedBeforePermission = debuggerCommands.length;
    const permissionDenied = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6222",
      TASK_A,
      "browser_snapshot",
      { tab_id: 100, mode: "accessibility" },
    );
    expect(permissionDenied).toMatchObject({
      outcome: "not_started",
      error: {
        code: "permissions_required",
        recovery: "Open the AgentTab popup and choose Enable automation.",
      },
    });
    expect(debuggerCommands).toHaveLength(deniedBeforePermission);

    // The popup calls chrome.permissions.request directly inside the user click.
    automationPermission = true;
    expect(permissionRequests).toEqual([]);

    expect(await sendPopupMessage({ kind: "pause" })).toEqual({ paused: true });
    expect((await readState()).paused).toBe(true);
    const deniedWhilePaused = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6223",
      TASK_A,
      "browser_act",
      {
        tab_id: 100,
        expected_page_revision: 1,
        actions: [{ kind: "click", ref: "r1-22" }],
      },
    );
    expect(deniedWhilePaused).toMatchObject({
      outcome: "not_started",
      error: { code: "paused" },
    });
    expect(debuggerCommands).toHaveLength(deniedBeforePermission);
    expect(await sendPopupMessage({ kind: "resume" })).toEqual({ paused: false });

    const staleRevision = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6224",
      TASK_A,
      "browser_act",
      {
        tab_id: 100,
        expected_page_revision: 0,
        actions: [{ kind: "click", ref: "r0-22" }],
      },
    );
    expect(staleRevision).toMatchObject({
      outcome: "not_started",
      error: {
        code: "stale_revision",
        details: { current_page_revision: 1 },
      },
    });
    expect(debuggerCommands).toHaveLength(deniedBeforePermission);

    const handoff = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6225",
      TASK_A,
      "browser_handoff",
      {
        tab_id: 100,
        expected_page_revision: 1,
        prompt: "Complete the sign-in yourself",
        completion: { kind: "manual_done" },
      },
    );
    expect(handoff).toMatchObject({ outcome: "needs_user", result: { task_id: TASK_A, tab_id: 100 } });
    expect((await readState()).handoff).toMatchObject({ active: true, taskId: TASK_A, tabId: 100 });
    const deniedDuringHandoff = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6226",
      TASK_A,
      "browser_snapshot",
      { tab_id: 100, mode: "accessibility" },
    );
    expect(deniedDuringHandoff).toMatchObject({
      outcome: "not_started",
      error: { code: "handoff_blackout" },
    });
    expect(debuggerCommands).toHaveLength(deniedBeforePermission);
    expect(await sendPopupMessage({ kind: "handoff_finish", completed: true })).toEqual({ completed: true });
    const pendingHandoff = (await readState()).handoff;
    if (!pendingHandoff.active || !pendingHandoff.pendingClearEventId) {
      throw new Error("handoff completion must await a native acknowledgment");
    }
    expect((await readState()).paused).toBe(false);
    port.receive({
      protocol: "agenttab.native",
      version: 1,
      kind: "event_ack",
      event: "handoff_changed",
      event_id: pendingHandoff.pendingClearEventId,
    });
    for (let attempt = 0; attempt < 20 && (await readState()).handoff.active; attempt += 1) {
      await Promise.resolve();
    }
    expect((await readState()).handoff).toEqual({ active: false });

    const developerDenied = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6227",
      TASK_A,
      "browser_developer",
      { action: "Runtime.evaluate", params: { tab_id: 100, expression: "document.title" } },
    );
    expect(developerDenied).toMatchObject({
      outcome: "not_started",
      error: { code: "developer_mode_required" },
    });
    expect(debuggerCommands).toHaveLength(deniedBeforePermission);
    expect(await sendPopupMessage({ kind: "developer_mode", enabled: true })).toEqual({ enabled: true });
    const developerEnabled = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6228",
      TASK_A,
      "browser_developer",
      { action: "Runtime.evaluate", params: { tab_id: 100, expression: "document.title" } },
    );
    expect(developerEnabled).toMatchObject({ outcome: "completed" });
    expect(
      debuggerCommands.some(
        ({ method, params }) => method === "Runtime.evaluate" && params.expression === "document.title",
      ),
    ).toBe(true);

    expect(await sendPopupMessage({ kind: "automation_revocation_state" })).toEqual({ generation: 0 });
    const detachCountBeforeRevocation = debuggerCalls.filter((call) => call === "detach").length;
    automationPermission = false;
    for (const listener of permissionRemovedListeners) listener({ permissions: ["debugger"] });
    await waitForCondition(
      () => debuggerCalls.filter((call) => call === "detach").length === detachCountBeforeRevocation + 1,
    );
    expect(await sendPopupMessage({ kind: "automation_revocation_state" })).toEqual({ generation: 1 });
    const deniedAfterRevocation = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6236",
      TASK_A,
      "browser_snapshot",
      { tab_id: 100, mode: "accessibility" },
    );
    expect(deniedAfterRevocation).toMatchObject({
      outcome: "not_started",
      error: { code: "permissions_required" },
    });
    automationPermission = true;

    const staged = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6229",
      TASK_A,
      "browser_act",
      {
        tab_id: 100,
        expected_page_revision: 1,
        actions: [
          { kind: "scroll", delta_x: 3, delta_y: 4 },
          { kind: "click", ref: "r1-22" },
          { kind: "press", key: "Enter" },
        ],
      },
    );
    expect(staged).toMatchObject({
      outcome: "commit_required",
      result: {
        tab_id: 100,
        page_revision: 1,
        actions: [{ kind: "scroll", completed: true }],
        staged_index: 1,
      },
      staged: { task_id: TASK_A, tab_id: 100, page_revision: 1 },
    });
    const stagedMetadata = staged.staged;
    if (
      stagedMetadata === null ||
      typeof stagedMetadata !== "object" ||
      typeof (stagedMetadata as Record<string, unknown>).native_token !== "string"
    ) {
      throw new Error("consequential action did not return a staged token");
    }
    const stagedToken = (stagedMetadata as Record<string, string>).native_token;
    expect(
      debuggerCommands.filter(
        ({ method, params }) =>
          method === "Runtime.callFunctionOn" &&
          params.functionDeclaration === "function(){this.click()}" &&
          params.userGesture === true,
      ),
    ).toHaveLength(0);
    expect(debuggerCommands.filter(({ method }) => method === "Input.dispatchKeyEvent")).toHaveLength(0);

    const committed = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6230",
      TASK_A,
      "browser_commit",
      { native_token: stagedToken },
    );
    expect(committed).toMatchObject({
      outcome: "completed",
      result: { tab_id: 100, actions: [{ kind: "click", completed: true }] },
    });
    expect(
      debuggerCommands.filter(
        ({ method, params }) =>
          method === "Runtime.callFunctionOn" &&
          params.functionDeclaration === "function(){this.click()}" &&
          params.userGesture === true,
      ),
    ).toHaveLength(1);
    expect(debuggerCommands.filter(({ method }) => method === "Input.dispatchKeyEvent")).toHaveLength(0);
    const replayed = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6231",
      TASK_A,
      "browser_commit",
      { native_token: stagedToken },
    );
    expect(replayed).toMatchObject({
      outcome: "not_started",
      error: { code: "invalid_staged_token" },
    });

    const abandoned = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6232",
      TASK_A,
      "browser_act",
      { tab_id: 100, expected_page_revision: 1, actions: [{ kind: "close" }] },
    );
    expect(abandoned).toMatchObject({ outcome: "commit_required" });
    expect(Object.values((await readState()).stagedCommits)).toContainEqual(
      expect.objectContaining({ task_id: TASK_A, tab_id: 100 }),
    );
    expect(await sendPopupMessage({ kind: "close_task", task_id: TASK_A })).toEqual({ closed: true });
    expect(removedTabIds).toContain(100);
    expect((await readState()).tasks[TASK_A]).toBeUndefined();
    expect(Object.values((await readState()).stagedCommits)).not.toContainEqual(
      expect.objectContaining({ task_id: TASK_A }),
    );
    const deniedAfterCleanup = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6233",
      TASK_A,
      "browser_snapshot",
      { tab_id: 100, mode: "accessibility" },
    );
    expect(deniedAfterCleanup).toMatchObject({
      outcome: "not_started",
      error: { code: "ownership_denied" },
    });
  });
});

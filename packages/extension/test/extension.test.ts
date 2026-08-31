import { beforeEach, describe, expect, test, vi } from "bun:test";
import { StandardBrowserRuntime } from "../src/browser";
import { HandoffController, HANDOFF_ALARM } from "../src/handoff";
import { NativeBridge, RECONNECT_ALARM } from "../src/native";
import { OwnershipLedger } from "../src/ownership";
import { parseCommand, parseInboundNativeMessage, type NativeOriginPolicy } from "../src/protocol";
import { RevisionTracker } from "../src/revisions";
import { automationRoute, normalizeRestrictedOriginError } from "../src/routes";
import { MutationScheduler } from "../src/scheduler";
import { IdempotentStartup, StartupOperationQueue } from "../src/startup";
import {
  mutateState,
  policyAllowanceKey,
  readState,
  resetStateForTest,
  STATE_KEY,
} from "../src/storage";
import { isRecord } from "../src/type-guards";

const LEGACY_TASKS_KEY = "chromeBridgeTaskSessions";
const LEGACY_PREFERENCES_KEY = "chromeBridgePreferences";
const TASK_A = "018f47b8-2f80-7c20-9c77-f8a38c9e621e";
const TASK_B = "018f47b8-2f80-7c20-9c77-f8a38c9e621f";
const TASK_C = "018f47b8-2f80-7c20-9c77-f8a38c9e6220";

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
    nativePostProbe?.(message);
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
let scriptResult: unknown;
let scriptingCallCount: number;
let alarmCreates: Array<{ name: string; when: number }>;
let alarmClears: string[];
let alarmListeners: Array<(alarm: { name: string }) => void>;
let nativePort: MockNativePort | null;
let tabRemovalProbe: (() => void | Promise<void>) | null;
let nativePostProbe: ((message: unknown) => void) | null;
let normalizeStoredObjectKeys: boolean;
let focusedWindowUpdates: number[];
let activeWindowId: number;
let createdWindowOptions: Array<Record<string, unknown>>;
let windowUpdates: Array<{ windowId: number; changes: Record<string, unknown> }>;
let focusStealOnClickTabId: number | null;
let callFunctionException: boolean;
let debuggerCommandOverride:
  | ((method: string, params: Record<string, unknown>) => Record<string, unknown> | undefined)
  | null;
let debuggerAttachGate: Promise<void> | null;
let completedDownloads: Array<Record<string, unknown>>;
let debuggerDetachFailures: number;
let debuggerAttachedTabIds: Set<number>;
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
type PermissionAddedListener = (permissions: { permissions?: string[] }) => void;
type TabUpdatedListener = (
  tabId: number,
  changeInfo: Record<string, unknown>,
) => void;
type TabCreatedListener = (tab: { id?: number; openerTabId?: number }) => void;
type TabRemovedListener = (tabId: number) => void;
type TabAttachedListener = (tabId: number) => void;
type TabDetachedListener = (tabId: number) => void;
type TabGroupRemovedListener = (group: { id?: number }) => void;
type AlarmListener = (alarm: { name: string }) => void;

const EXTENSION_ID = "agenttab-test-extension";

let debuggerCommands: DebuggerCommand[];
let automationPermission: boolean;
let permissionRequests: Array<Record<string, unknown>>;
let permissionRequestResult: boolean;
let popupMessageListeners: PopupMessageListener[];
let permissionRemovedListeners: PermissionRemovedListener[];
let permissionAddedListeners: PermissionAddedListener[];
let tabCreatedListeners: TabCreatedListener[];
let tabRemovedListeners: TabRemovedListener[];
let tabUpdatedListeners: TabUpdatedListener[];
let tabAttachedListeners: TabAttachedListener[];
let tabDetachedListeners: TabDetachedListener[];
let tabGroupRemovedListeners: TabGroupRemovedListener[];
let debuggerEventListeners: Array<(...args: unknown[]) => void>;
let debuggerDetachListeners: Array<(...args: unknown[]) => void>;
let popupRuntimeHandler: (message: Record<string, unknown>) => unknown | Promise<unknown>;
let storageGetCount: number;
let storageSetCount: number;
let storageRemoveCount: number;
let tabQueryCount: number;

function clone<T>(value: T): T {
  return structuredClone(value);
}

class PopupTestElement {
  textContent = "";
  value = "";
  hidden = false;
  className = "";
  title = "";
  type = "";
  disabled = false;
  checked = false;
  readonly dataset: Record<string, string> = {};
  readonly children: PopupTestElement[] = [];
  readonly style = { setProperty() { } };
  private readonly listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  append(...children: PopupTestElement[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: PopupTestElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }
  setAttribute(_name: string, _value: string): void { }
  focus(): void { }
}

class PopupTestSpanElement extends PopupTestElement { }
class PopupTestButtonElement extends PopupTestElement { }
class PopupTestParagraphElement extends PopupTestElement { }
class PopupTestInputElement extends PopupTestElement { }
class PopupTestSelectElement extends PopupTestElement { }
class PopupTestDivElement extends PopupTestElement { }
class PopupTestListElement extends PopupTestElement { }

interface PopupTestSurface {
  get(id: string): PopupTestElement;
}

let popupModuleNonce = 0;

function installPopupDocument(): PopupTestSurface {
  const nodes = new Map<string, PopupTestElement>();
  const add = <T extends PopupTestElement>(id: string, Element: new () => T): void => {
    nodes.set(id, new Element());
  };
  add("status", PopupTestSpanElement);
  add("developer-chip", PopupTestSpanElement);
  add("automation-detail", PopupTestElement);
  add("pause", PopupTestButtonElement);
  add("runtime-error", PopupTestParagraphElement);
  add("permission", PopupTestElement);
  add("enable", PopupTestButtonElement);
  add("permission-error", PopupTestParagraphElement);
  add("automation-setting", PopupTestDivElement);
  add("disable", PopupTestButtonElement);
  add("developer", PopupTestElement);
  add("developer-off", PopupTestButtonElement);
  add("handoff", PopupTestElement);
  add("handoff-prompt", PopupTestParagraphElement);
  add("handoff-cancel", PopupTestButtonElement);
  add("handoff-done", PopupTestButtonElement);
  add("handoff-error", PopupTestParagraphElement);
  add("task-count", PopupTestSpanElement);
  add("tasks", PopupTestListElement);
  add("task-error", PopupTestParagraphElement);
  add("pointer", PopupTestInputElement);
  add("pointer-detail", PopupTestElement);
  add("settings-error", PopupTestParagraphElement);
  add("policy-profile", PopupTestSelectElement);
  add("policy-detail", PopupTestElement);
  add("allowance-setting", PopupTestDivElement);
  add("allowance-detail", PopupTestElement);
  add("clear-allowances", PopupTestButtonElement);
  add("reviews", PopupTestElement);
  add("review-list", PopupTestListElement);
  add("review-error", PopupTestParagraphElement);
  Object.assign(globalThis as Record<string, unknown>, {
    document: {
      body: new PopupTestElement(),
      getElementById(id: string) {
        return nodes.get(id) ?? null;
      },
      createElement() {
        return new PopupTestElement();
      },
    },
    HTMLElement: PopupTestElement,
    HTMLSpanElement: PopupTestSpanElement,
    HTMLButtonElement: PopupTestButtonElement,
    HTMLParagraphElement: PopupTestParagraphElement,
    HTMLInputElement: PopupTestInputElement,
    HTMLSelectElement: PopupTestSelectElement,
    HTMLDivElement: PopupTestDivElement,
    HTMLUListElement: PopupTestListElement,
  });
  return {
    get(id: string): PopupTestElement {
      const element = nodes.get(id);
      if (!element) throw new Error(`popup test element "${id}" is missing`);
      return element;
    },
  };
}

async function loadPopup(): Promise<PopupTestSurface> {
  const surface = installPopupDocument();
  // Each test needs a distinct evaluation of this side-effecting popup module.
  await import(`../src/popup.ts?popup-test=${popupModuleNonce += 1}`);
  await flushPromiseQueue();
  return surface;
}

function popupUiState(paused = false): Record<string, unknown> {
  return {
    automation_enabled: true,
    paused,
    developer_mode: false,
    policy_profile: "autopilot",
    policy_allowance_count: 0,
    show_agent_pointer: false,
    handoff: null,
    tasks: [],
    reviews: [],
  };
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

async function flushPromiseQueue(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

async function advanceTimers(milliseconds: number): Promise<void> {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) {
    vi.advanceTimersByTime(Math.min(50, milliseconds - elapsed));
    await flushPromiseQueue();
  }
  if (milliseconds === 0) {
    vi.advanceTimersByTime(0);
    await flushPromiseQueue();
  }
}

function emitDebuggerEvent(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): void {
  for (const listener of debuggerEventListeners) {
    listener({ tabId }, method, clone(params));
  }
}

function emitDebuggerDetach(tabId: number): void {
  for (const listener of debuggerDetachListeners) listener({ tabId });
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
  scriptingCallCount = 0;
  alarmCreates = [];
  alarmClears = [];
  alarmListeners = [];
  nativePort = null;
  tabRemovalProbe = null;
  nativePostProbe = null;
  normalizeStoredObjectKeys = false;
  focusedWindowUpdates = [];
  activeWindowId = 1;
  createdWindowOptions = [];
  windowUpdates = [];
  focusStealOnClickTabId = null;
  debuggerCommands = [];
  debuggerDetachFailures = 0;
  debuggerAttachedTabIds = new Set();
  callFunctionException = false;
  debuggerCommandOverride = null;
  debuggerAttachGate = null;
  completedDownloads = [];
  automationPermission = true;
  permissionRequests = [];
  permissionRequestResult = true;
  popupMessageListeners = [];
  permissionAddedListeners = [];
  tabCreatedListeners = [];
  tabRemovedListeners = [];
  tabUpdatedListeners = [];
  tabAttachedListeners = [];
  tabDetachedListeners = [];
  tabGroupRemovedListeners = [];
  permissionRemovedListeners = [];
  debuggerEventListeners = [];
  debuggerDetachListeners = [];
  popupRuntimeHandler = () => popupUiState();
  storageGetCount = 0;
  storageSetCount = 0;
  storageRemoveCount = 0;
  tabQueryCount = 0;
  const listeners = {
    detach: debuggerDetachListeners,
    event: debuggerEventListeners,
  };
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
            storageGetCount += 1;
            if (keys === null) return clone(persisted);
            const selected = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(selected.filter((key) => key in persisted).map((key) => [key, clone(persisted[key])]));
          },
          async set(values: Record<string, unknown>) {
            storageSetCount += 1;
            Object.assign(
              persisted,
              normalizeStoredObjectKeys ? recursivelySortObjectKeys(values) : clone(values),
            );
          },
          async remove(keys: string | string[]) {
            storageRemoveCount += 1;
            for (const key of Array.isArray(keys) ? keys : [keys]) delete persisted[key];
          },
        },
        onChanged: { addListener() { } },
      },
      debugger: {
        onDetach: { addListener(listener: (...args: unknown[]) => void) { listeners.detach.push(listener); } },
        onEvent: { addListener(listener: (...args: unknown[]) => void) { listeners.event.push(listener); } },
        async getTargets() {
          return [...debuggerAttachedTabIds].map((tabId) => ({
            id: `tab-${tabId}`,
            type: "page",
            title: `Tab ${tabId}`,
            url: tabStore.get(tabId)?.url ?? "https://example.test/",
            attached: true,
            tabId,
          }));
        },
        async attach(target: { tabId: number }) {
          debuggerCalls.push("attach");
          if (debuggerAttachGate) await debuggerAttachGate;
          debuggerAttachedTabIds.add(target.tabId);
        },
        async detach(target: { tabId: number }) {
          debuggerCalls.push("detach");
          if (debuggerDetachFailures > 0) {
            debuggerDetachFailures -= 1;
            throw new Error("debugger detach failed");
          }
          debuggerAttachedTabIds.delete(target.tabId);
        },
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
        onCreated: {
          addListener(listener: TabCreatedListener) {
            tabCreatedListeners.push(listener);
          },
        },
        onRemoved: {
          addListener(listener: TabRemovedListener) {
            tabRemovedListeners.push(listener);
          },
        },
        onUpdated: {
          addListener(listener: TabUpdatedListener) {
            tabUpdatedListeners.push(listener);
          },
        },
        onAttached: {
          addListener(listener: TabAttachedListener) {
            tabAttachedListeners.push(listener);
          },
        },
        onDetached: {
          addListener(listener: TabDetachedListener) {
            tabDetachedListeners.push(listener);
          },
        },
        SPLIT_VIEW_ID_NONE: -1,
        async get(tabId: number) {
          return clone({
            id: tabId,
            windowId: 1,
            groupId: -1,
            status: "complete",
            url: "https://example.test/",
            ...tabStore.get(tabId),
          });
        },
        async query(query: Record<string, unknown>) {
          tabQueryCount += 1;
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
      scripting: {
        async executeScript() {
          scriptingCallCount += 1;
          return [{ result: scriptResult }];
        },
      },
      windows: {
        async getAll() {
          return [{ id: 1, tabs: clone([...tabStore.values()]) }];
        },
        async create(options: Record<string, unknown>) {
          createdWindowOptions.push(clone(options));
          return {
            id: 2,
            state: typeof options.state === "string" ? options.state : "normal",
            tabs: [clone(createTab(
              typeof options.url === "string" ? options.url : "about:blank",
              options.focused === true,
              2,
            ))],
          };
        },
        async update(windowId: number, changes: Record<string, unknown>) {
          windowUpdates.push({ windowId, changes: clone(changes) });
          if (changes.focused === true) {
            focusedWindowUpdates.push(windowId);
            activeWindowId = windowId;
          }
          return { id: windowId, state: changes.state ?? "normal" };
        },
        async remove(windowId: number) {
          for (const [tabId, tab] of tabStore) {
            if (tab.windowId === windowId) tabStore.delete(tabId);
          }
        },
      },
      tabGroups: {
        async update() { },
        onRemoved: {
          addListener(listener: TabGroupRemovedListener) {
            tabGroupRemovedListeners.push(listener);
          },
        },
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
        onAlarm: {
          addListener(listener: AlarmListener) {
            alarmListeners.push(listener);
          },
        },
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
        onAdded: {
          addListener(listener: PermissionAddedListener) {
            permissionAddedListeners.push(listener);
          },
        },
        onRemoved: {
          addListener(listener: PermissionRemovedListener) {
            permissionRemovedListeners.push(listener);
          },
        },
      },
      runtime: {
        id: EXTENSION_ID,
        getManifest() { return { version: "2.0.0" }; },
        connectNative() {
          if (!nativePort) throw new Error("native host unavailable");
          return nativePort;
        },
        async sendMessage(message: unknown) {
          if (!isRecord(message)) throw new Error("popup message must be a record");
          return popupRuntimeHandler(message);
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

async function sendNativeCloseTask(
  requestId: string,
  taskId: string,
): Promise<Record<string, unknown>> {
  const port = nativePort;
  if (!port) throw new Error("native port is unavailable");
  port.receive({
    protocol: "agenttab.native",
    version: 1,
    kind: "close_task",
    request_id: requestId,
    task_id: taskId,
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
  if (!response || typeof response !== "object") throw new Error("native close_task did not produce a response");
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

describe("popup background responses", () => {
  test("accepts successful popup response records", async () => {
    let paused = false;
    popupRuntimeHandler = (message) => {
      if (message.kind === "get_ui_state") return popupUiState(paused);
      if (message.kind === "pause") {
        paused = true;
        return { paused: true };
      }
      throw new Error(`unexpected popup message ${String(message.kind)}`);
    };

    const popup = await loadPopup();
    popup.get("pause").dispatch("click");
    await flushPromiseQueue();

    expect(popup.get("status").textContent).toBe("Paused");
    expect(popup.get("runtime-error").hidden).toBe(true);
  });

  test("displays background error records through the popup guard", async () => {
    popupRuntimeHandler = (message) => {
      if (message.kind === "get_ui_state") return popupUiState();
      if (message.kind === "pause") return { error: "Native host disconnected." };
      throw new Error(`unexpected popup message ${String(message.kind)}`);
    };

    const popup = await loadPopup();
    popup.get("pause").dispatch("click");
    await flushPromiseQueue();

    expect(popup.get("runtime-error").hidden).toBe(false);
    expect(popup.get("runtime-error").textContent).toBe("Native host disconnected.");
  });

  test("persists the selected action policy without changing browser permissions", async () => {
    let profile = "autopilot";
    popupRuntimeHandler = (message) => {
      if (message.kind === "get_ui_state") {
        return { ...popupUiState(), policy_profile: profile };
      }
      if (message.kind === "set_policy_profile" && typeof message.profile === "string") {
        profile = message.profile;
        return { profile };
      }
      throw new Error(`unexpected popup message ${String(message.kind)}`);
    };

    const popup = await loadPopup();
    popup.get("policy-profile").value = "strict";
    popup.get("policy-profile").dispatch("change");
    await flushPromiseQueue();

    expect(profile).toBe("strict");
    expect(popup.get("policy-detail").textContent).toContain("owned-tab close");
    expect(permissionRequests).toEqual([]);
  });

  test("clears remembered approvals from settings", async () => {
    let allowanceCount = 2;
    popupRuntimeHandler = (message) => {
      if (message.kind === "get_ui_state") {
        return { ...popupUiState(), policy_allowance_count: allowanceCount };
      }
      if (message.kind === "clear_policy_allowances") {
        const cleared = allowanceCount;
        allowanceCount = 0;
        return { cleared };
      }
      throw new Error(`unexpected popup message ${String(message.kind)}`);
    };

    const popup = await loadPopup();
    expect(popup.get("allowance-setting").hidden).toBe(false);
    expect(popup.get("allowance-detail").textContent).toBe("2 remembered decisions");
    popup.get("clear-allowances").dispatch("click");
    await flushPromiseQueue();

    expect(allowanceCount).toBe(0);
    expect(popup.get("allowance-setting").hidden).toBe(true);
  });

  test("labels a global effect allowance as applying on all sites", async () => {
    popupRuntimeHandler = (message) => {
      if (message.kind === "get_ui_state") {
        return {
          ...popupUiState(),
          reviews: [{
            review_handle: "review-handle-global-label",
            task_id: TASK_A,
            tab_id: 7,
            effect: "Send message",
            expires_at_ms: Date.now() + 60_000,
            policy_effect: "external_communication",
            origin: "https://example.test",
          }],
        };
      }
      throw new Error(`unexpected popup message ${String(message.kind)}`);
    };

    const popup = await loadPopup();
    const reviewRow = popup.get("review-list").children[0];
    const scope = reviewRow?.children[2]?.children[0];
    const labels = scope?.children.map((option) => option.textContent) ?? [];

    expect(labels).toContain("Remember on all sites");
    expect(labels).not.toContain("Remember effect category");
  });
});

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

  test("accepts only background creation for a dedicated task window", () => {
    const command = {
      protocol: "agenttab.native",
      version: 1,
      kind: "command",
      request_id: "018f47b8-2f80-7c20-9c77-f8a38c9e621d",
      task_id: TASK_A,
      connection_id: NATIVE_CONNECTION_ID,
      method: "browser_open",
      params: {
        mode: "create",
        url: "https://example.test/workspace",
        placement: "new_window",
        background: true,
      },
    };

    expect(parseCommand(command).params).toEqual(command.params);
    expect(() => parseCommand({
      ...command,
      params: { ...command.params, background: false },
    })).toThrow("background must be true");
    expect(() => parseCommand({
      ...command,
      params: { ...command.params, placement: "unowned_window" },
    })).toThrow("placement must be task or new_window");
  });

  test("validates bounded screenshot encoding parameters", () => {
    const command = {
      protocol: "agenttab.native",
      version: 1,
      kind: "command",
      request_id: "018f47b8-2f80-7c20-9c77-f8a38c9e621d",
      task_id: TASK_A,
      connection_id: NATIVE_CONNECTION_ID,
      method: "browser_snapshot",
      params: {
        tab_id: 42,
        mode: "screenshot",
        format: "webp",
        quality: 72,
        max_width: 1280,
        max_height: 720,
        max_bytes: 500_000,
      },
    };

    expect(parseCommand(command).params).toEqual(command.params);
    expect(() => parseCommand({
      ...command,
      params: { ...command.params, format: "png", quality: 72 },
    })).toThrow("quality requires format jpeg or webp");
    expect(() => parseCommand({
      ...command,
      params: { ...command.params, max_bytes: 750_001 },
    })).toThrow("max_bytes must be between 1 and 750000");
    expect(() => parseCommand({
      ...command,
      params: { ...command.params, selector: "main", full_page: true },
    })).toThrow("screenshot cannot combine selector and full_page");
    expect(() => parseCommand({
      ...command,
      params: { tab_id: 42, mode: "html", max_bytes: 1_000_001 },
    })).toThrow("max_bytes must be between 1 and 1000000");
  });

  test("rejects removed focus and prompt-input action capabilities", () => {
    const command = {
      protocol: "agenttab.native",
      version: 1,
      kind: "command",
      request_id: "018f47b8-2f80-7c20-9c77-f8a38c9e621d",
      task_id: "018f47b8-2f80-7c20-9c77-f8a38c9e621e",
      connection_id: "018f47b8-2f80-7c20-9c77-f8a38c9e621f",
      method: "browser_act",
      params: {
        tab_id: 42,
        expected_page_revision: 1,
        actions: [{ kind: "dialog", decision: "accept" }],
      },
    };
    expect(parseCommand(command).method).toBe("browser_act");
    expect(() => parseCommand({
      ...command,
      params: { ...command.params, actions: [{ kind: "focus" }] },
    })).toThrow("Unsupported standard action: focus");
    expect(() => parseCommand({
      ...command,
      params: {
        ...command.params,
        actions: [{ kind: "dialog", decision: "accept", prompt_text: "secret" }],
      },
    })).toThrow("unknown fields");
  });

  test("accepts only the strict native close_task lifecycle command", () => {
    const closeTask = parseInboundNativeMessage({
      protocol: "agenttab.native",
      version: 1,
      kind: "close_task",
      request_id: "018f47b8-2f80-7c20-9c77-f8a38c9e621d",
      task_id: TASK_A,
    });
    expect(closeTask).toMatchObject({ kind: "close_task", task_id: TASK_A });
    expect(() => parseInboundNativeMessage({
      protocol: "agenttab.native",
      version: 1,
      kind: "close_task",
      request_id: "018f47b8-2f80-7c20-9c77-f8a38c9e621d",
      task_id: TASK_A,
      connection_id: NATIVE_CONNECTION_ID,
    })).toThrow("unknown fields");
  });
});

describe("automation route classification", () => {
  test("reserves browser-restricted origins for tab lifecycle controls", () => {
    for (const url of [
      "chrome://settings/",
      "chrome-extension://abcdefghijklmnop/options.html",
      "devtools://devtools/bundled/inspector.html",
      "https://chromewebstore.google.com/detail/example",
      "https://chrome.google.com/webstore/devconsole/example",
    ]) {
      expect(automationRoute(url)).toBe("tab_only");
    }
    expect(automationRoute("https://example.test/workspace")).toBe("full");
    expect(normalizeRestrictedOriginError(
      new Error("Cannot access a chrome:// URL"),
      "capture a text snapshot",
    )).toMatchObject({
      code: "browser_restricted_origin",
      outcome: "not_started",
    });
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

  test("prunes idle tab generations and invalidation reasons", async () => {
    const scheduler = new MutationScheduler();
    const internal = scheduler as unknown as {
      generations: Map<number, number>;
      generationReasons: Map<number, { code: string; message: string }>;
    };

    scheduler.invalidateTab(404);
    expect(internal.generations.size).toBe(0);
    expect(internal.generationReasons.size).toBe(0);

    const activeGate = Promise.withResolvers<void>();
    const activeStarted = Promise.withResolvers<void>();
    const active = scheduler.enqueueTab(TASK_A, 41, async () => {
      activeStarted.resolve();
      await activeGate.promise;
    });
    const stale = scheduler.enqueueTab(TASK_A, 41, async () => "must not run");
    const staleOutcome = stale.then(
      () => null,
      (error: unknown) => error,
    );
    await activeStarted.promise;

    scheduler.invalidateTab(41);
    expect(internal.generations.get(41)).toBe(1);
    expect(internal.generationReasons.get(41)?.code).toBe("stale_revision");

    activeGate.resolve();
    await active;
    expect(await staleOutcome).toMatchObject({ code: "stale_revision" });
    await flushPromiseQueue();
    expect(internal.generations.size).toBe(0);
    expect(internal.generationReasons.size).toBe(0);
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

  test("permission revocation rejects an admitted queued tabs action before it can run", async () => {
    const scheduler = new MutationScheduler();
    const activeGate = Promise.withResolvers<void>();
    const activeStarted = Promise.withResolvers<void>();
    let queriedTabs = false;
    const active = scheduler.enqueueTab(TASK_A, 4, async () => {
      activeStarted.resolve();
      await activeGate.promise;
    });
    const queuedTabs = scheduler.enqueueGlobal(async () => {
      queriedTabs = true;
      await chrome.tabs.query({});
    });
    await activeStarted.promise;

    scheduler.revokePermissions();
    activeGate.resolve();
    await active;

    await expect(queuedTabs).rejects.toMatchObject({
      code: "permissions_required",
    });
    expect(queriedTabs).toBe(false);
  });

  test("restoring permissions does not bypass pause or disconnect", async () => {
    const scheduler = new MutationScheduler();

    await scheduler.pause();
    scheduler.revokePermissions();
    scheduler.restorePermissions();
    await expect(scheduler.enqueueGlobal(async () => "must not run")).rejects.toMatchObject({
      code: "paused",
    });

    scheduler.resume();
    expect(await scheduler.enqueueGlobal(async () => "resumed")).toBe("resumed");

    scheduler.disconnect();
    scheduler.revokePermissions();
    scheduler.restorePermissions();
    await expect(scheduler.enqueueGlobal(async () => "must not run")).rejects.toMatchObject({
      code: "paused",
      message: "AgentTab connection is unavailable",
    });
  });

  test("reapplying an unpaused initial state recovers a partial startup attempt", () => {
    const scheduler = new MutationScheduler();
    scheduler.setInitialPaused(true);
    expect(scheduler.isAccepting()).toBe(false);

    scheduler.setInitialPaused(false);
    expect(scheduler.isAccepting()).toBe(true);

    scheduler.revokePermissions();
    scheduler.setInitialPaused(false);
    expect(scheduler.isAccepting()).toBe(false);
    scheduler.restorePermissions();
    expect(scheduler.isAccepting()).toBe(true);
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
    expect(state.policyProfile).toBe("strict");
    expect(persisted[STATE_KEY]).toBeDefined();
    expect(persisted[LEGACY_TASKS_KEY]).toBeUndefined();
    expect(persisted[LEGACY_PREFERENCES_KEY]).toBeUndefined();
    expect(storageSetCount).toBe(1);
    expect(storageGetCount).toBe(3);
    expect(storageRemoveCount).toBe(1);
  });

  test("skips no-op persistence and avoids hot-path write verification reads", async () => {
    await readState();
    const initialGets = storageGetCount;
    const initialSets = storageSetCount;

    await mutateState(() => undefined);
    expect(storageGetCount).toBe(initialGets);
    expect(storageSetCount).toBe(initialSets);

    await mutateState((state) => {
      state.showAgentPointer = false;
    });
    expect(storageGetCount).toBe(initialGets);
    expect(storageSetCount).toBe(initialSets + 1);

    resetStateForTest();
    expect((await readState()).showAgentPointer).toBe(false);
    expect(storageGetCount).toBe(initialGets + 1);
  });

  test("accepts normalized persisted object-key order after restart", async () => {
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
    resetStateForTest();

    expect((await readState()).tasks[TASK_A]).toMatchObject({
      name: "Key-order-safe task",
      groupId: 9,
      tabIds: [41],
    });
  });

  test("still rejects malformed persisted state during startup", async () => {
    await readState();
    persisted[STATE_KEY] = { schemaVersion: 1, paused: "not-a-boolean" };
    resetStateForTest();

    await expect(readState()).rejects.toThrow("Persisted AgentTab state is malformed");
  });

  test("defaults fresh state to Autopilot but migrates incomplete policy state to Strict", async () => {
    await readState();
    const freshState = clone(persisted[STATE_KEY]) as Record<string, unknown>;
    expect(freshState).toMatchObject({ policyProfile: "autopilot", policyAllowances: {} });

    for (const missingFields of [
      ["policyProfile"],
      ["policyAllowances"],
      ["policyProfile", "policyAllowances"],
    ]) {
      const existingState = clone(freshState);
      if (missingFields.length === 1 && missingFields[0] === "policyProfile") {
        existingState.policyAllowances = {
          [policyAllowanceKey("effect", "external_communication")]: {
            scope: "effect",
            effect: "external_communication",
            createdAt: 1,
          },
        };
      }
      if (missingFields.length === 1 && missingFields[0] === "policyAllowances") {
        existingState.policyProfile = "review_selected";
      }
      for (const field of missingFields) delete existingState[field];
      persisted[STATE_KEY] = existingState;
      resetStateForTest();

      expect(await readState()).toMatchObject({
        policyProfile: "strict",
        policyAllowances: {},
      });
      expect(persisted[STATE_KEY]).toMatchObject({
        policyProfile: "strict",
        policyAllowances: {},
      });
    }

    persisted[STATE_KEY] = { ...freshState, policyProfile: "invalid" };
    resetStateForTest();
    await expect(readState()).rejects.toThrow("Persisted AgentTab state is malformed");

    persisted[STATE_KEY] = { ...freshState, policyProfile: "review_selected" };
    resetStateForTest();
    expect((await readState()).policyProfile).toBe("review_selected");
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

  test("does not persist unchanged revision observations", async () => {
    const revisions = new RevisionTracker();
    expect(await revisions.observeDocument(7, "document-a", "loader-a")).toBe(1);
    const initialGets = storageGetCount;
    const initialSets = storageSetCount;

    expect(await revisions.ensure(7)).toBe(1);
    expect(await revisions.observeDocument(7, "document-a", "loader-a")).toBe(1);
    expect(await revisions.observeDocument(7, "document-a", "loader-a")).toBe(1);
    expect(storageGetCount).toBe(initialGets);
    expect(storageSetCount).toBe(initialSets);

    expect(await revisions.markNavigation(7)).toBe(2);
    expect(storageGetCount).toBe(initialGets);
    expect(storageSetCount).toBe(initialSets + 1);
  });

  test("keeps a snapshot revision stable until Chrome reports a new document", async () => {
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
    const first = await runtime.snapshot(61, { mode: "accessibility" });
    const second = await runtime.snapshot(61, { mode: "accessibility" });

    expect(first.page_revision).toBe(1);
    expect(second.page_revision).toBe(1);
    expect((await readState()).revisions["61"]).toMatchObject({ floor: 1, current: 1 });
    await runtime.detach(61);
  });

  test("retries a content match when navigation replaces the probed document", async () => {
    tabStore.set(61, {
      id: 61,
      windowId: 1,
      groupId: -1,
      url: "https://example.test/",
      status: "complete",
    });
    let documentReads = 0;
    debuggerCommandOverride = (method) => {
      if (method !== "DOM.getDocument") return undefined;
      documentReads += 1;
      const backendNodeId = documentReads === 1 ? 1 : 2;
      return { root: { nodeId: backendNodeId, backendNodeId } };
    };
    const runtime = new StandardBrowserRuntime(
      new RevisionTracker(),
      async () => undefined,
      () => undefined,
      async () => undefined,
    );

    const result = await runtime.wait(61, {
      condition: { kind: "selector", value: "#ready" },
      timeout_ms: 500,
    });

    expect(scriptingCallCount).toBe(2);
    expect(result).toMatchObject({ matched: true, page_revision: 2 });
    await runtime.detach(61);
  });

  test("serializes concurrent attachment and keeps a failed detach recoverable", async () => {
    const runtime = new StandardBrowserRuntime(
      new RevisionTracker(),
      async () => undefined,
      () => undefined,
    );

    await Promise.all([
      runtime.snapshot(62, { mode: "accessibility" }),
      runtime.snapshot(62, { mode: "accessibility" }),
    ]);
    expect(debuggerCalls.filter((call) => call === "attach")).toHaveLength(1);

    debuggerDetachFailures = 1;
    await expect(runtime.detach(62)).rejects.toThrow("debugger detach failed");
    await expect(runtime.detach(62)).resolves.toBeUndefined();
    expect(debuggerCalls.filter((call) => call === "detach")).toHaveLength(2);
  });

  test("waits for a page load already active when network tracking attaches", async () => {
    vi.useFakeTimers();
    try {
      const flushPromiseQueue = async (): Promise<void> => {
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      };
      const advanceTimers = async (milliseconds: number): Promise<void> => {
        for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) {
          vi.advanceTimersByTime(Math.min(50, milliseconds - elapsed));
          await flushPromiseQueue();
        }
        if (milliseconds === 0) {
          vi.advanceTimersByTime(0);
          await flushPromiseQueue();
        }
      };
      let releaseAttach!: () => void;
      debuggerAttachGate = new Promise<void>((resolve) => {
        releaseAttach = resolve;
      });
      debuggerCommandOverride = (method) => {
        if (method === "Network.enable") {
          setTimeout(() => {
            emitDebuggerEvent(61, "Network.requestWillBeSent", { requestId: "racing-enable" });
          }, 0);
        }
        return undefined;
      };
      tabStore.set(61, {
        id: 61,
        windowId: 1,
        groupId: -1,
        url: "https://example.test/",
        status: "loading",
      });
      const runtime = new StandardBrowserRuntime(
        new RevisionTracker(),
        async () => undefined,
        () => undefined,
      );

      emitDebuggerEvent(61, "Network.requestWillBeSent", { requestId: "already-active" });
      let settled = false;
      const waiting = runtime.wait(61, {
        condition: { kind: "network_idle" },
        timeout_ms: 3_000,
      }).then((result) => {
        settled = true;
        return result;
      });
      for (let turn = 0; turn < 20 && !debuggerCalls.includes("attach"); turn += 1) {
        await Promise.resolve();
      }
      expect(debuggerCalls).toContain("attach");
      releaseAttach();
      for (let turn = 0; turn < 20 && !debuggerCalls.includes("Network.enable"); turn += 1) {
        await Promise.resolve();
      }
      expect(debuggerCalls).toContain("Network.enable");
      await advanceTimers(0);
      emitDebuggerEvent(61, "Network.loadingFinished", { requestId: "racing-enable" });

      await advanceTimers(550);
      expect(settled).toBe(false);

      const tab = tabStore.get(61);
      if (!tab) throw new Error("missing task tab");
      tab.status = "complete";
      const completedAt = Date.now();
      emitDebuggerEvent(61, "Network.loadingFinished", { requestId: "already-active" });

      await advanceTimers(450);
      expect(settled).toBe(false);
      await advanceTimers(100);
      await expect(waiting).resolves.toMatchObject({
        tab_id: 61,
        condition: "network_idle",
        matched: true,
      });
      expect(Date.now() - completedAt).toBeGreaterThanOrEqual(500);
      await runtime.detach(61);
    } finally {
      vi.useRealTimers();
    }
  });

  test("retains a partially initialized debugger session until cleanup succeeds", async () => {
    const recorded: number[] = [];
    const forgotten: number[] = [];
    let failEnable = true;
    debuggerCommandOverride = (method) => {
      if (method === "Page.enable" && failEnable) {
        failEnable = false;
        throw new Error("debugger initialization failed");
      }
      return undefined;
    };
    debuggerDetachFailures = 1;
    const runtime = new StandardBrowserRuntime(
      new RevisionTracker(),
      async () => undefined,
      () => undefined,
      async () => undefined,
      async (tabId) => {
        recorded.push(tabId);
      },
      async (tabId) => {
        forgotten.push(tabId);
      },
    );

    await expect(runtime.snapshot(63, { mode: "accessibility" })).rejects.toThrow(
      "Debugger initialization and cleanup both failed",
    );
    expect(recorded).toEqual([63]);
    expect(debuggerAttachedTabIds.has(63)).toBe(true);
    expect(forgotten).toEqual([]);

    await runtime.detach(63);
    expect(debuggerAttachedTabIds.has(63)).toBe(false);
    expect(forgotten).toEqual([63]);
    expect(debuggerCalls.filter((call) => call === "detach")).toHaveLength(2);
  });

  test("recovers a persisted debugger candidate after the runtime restarts", async () => {
    debuggerAttachedTabIds.add(64);
    const forgotten: number[] = [];
    const runtime = new StandardBrowserRuntime(
      new RevisionTracker(),
      async () => undefined,
      () => undefined,
      async () => undefined,
      async () => undefined,
      async (tabId) => {
        forgotten.push(tabId);
      },
    );

    await runtime.scrubForHandoff([64]);

    expect(debuggerAttachedTabIds.has(64)).toBe(false);
    expect(forgotten).toEqual([64]);
    expect(debuggerCalls.filter((call) => call === "detach")).toHaveLength(1);
  });

  test("retains a debugger candidate across external detach and reattachment", async () => {
    const recorded: number[] = [];
    const forgotten: number[] = [];
    const runtime = new StandardBrowserRuntime(
      new RevisionTracker(),
      async () => undefined,
      () => undefined,
      async () => undefined,
      async (tabId) => {
        recorded.push(tabId);
      },
      async (tabId) => {
        forgotten.push(tabId);
      },
    );

    await runtime.snapshot(65, { mode: "accessibility" });
    debuggerAttachedTabIds.delete(65);
    emitDebuggerDetach(65);
    await Promise.resolve();

    expect(runtime.debuggerTabIds()).toEqual([65]);
    expect(forgotten).toEqual([]);
    await runtime.snapshot(65, { mode: "accessibility" });
    expect(recorded).toEqual([65, 65]);
    expect(debuggerCalls.filter((call) => call === "attach")).toHaveLength(2);

    await runtime.detach(65);
    expect(forgotten).toEqual([65]);
  });

  test("detaches a restored debugger candidate during ownership revocation", async () => {
    debuggerAttachedTabIds.add(66);
    const forgotten: number[] = [];
    const runtime = new StandardBrowserRuntime(
      new RevisionTracker(),
      async () => undefined,
      () => undefined,
      async () => undefined,
      async () => undefined,
      async (tabId) => {
        forgotten.push(tabId);
      },
    );
    runtime.restoreDebuggerCandidates([66]);

    await runtime.detach(66);

    expect(debuggerAttachedTabIds.has(66)).toBe(false);
    expect(runtime.debuggerTabIds()).toEqual([]);
    expect(forgotten).toEqual([66]);
  });

  test("authorizes every debugger initialization command", async () => {
    let authorizationChecks = 0;
    const runtime = new StandardBrowserRuntime(
      new RevisionTracker(),
      async () => undefined,
      () => undefined,
      async () => {
        authorizationChecks += 1;
        if (authorizationChecks === 5) {
          throw Object.assign(new Error("ownership changed during debugger initialization"), {
            code: "ownership_revoked",
          });
        }
      },
    );

    await expect(runtime.snapshot(67, { mode: "accessibility" })).rejects.toMatchObject({
      code: "ownership_revoked",
    });

    expect(debuggerCommands.map(({ method }) => method)).toEqual(["Page.enable"]);
    expect(debuggerAttachedTabIds.has(67)).toBe(false);
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
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);

    await expect(runtime.snapshot(61, { mode: "accessibility" })).rejects.toMatchObject({
      code: "stale_revision",
      currentPageRevision: 2,
    });
    expect((await readState()).revisions["61"]).toMatchObject({ floor: 2, current: 2 });
  });

  test("rejects a full-page screenshot when the document changes during capture", async () => {
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
      if (method === "Page.captureScreenshot") return { data: "captured-stale-page" };
      return undefined;
    };
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);

    await expect(runtime.snapshot(61, { mode: "screenshot", full_page: true })).rejects.toMatchObject({
      code: "stale_revision",
      currentPageRevision: 2,
    });
    expect(debuggerCalls).toContain("Page.getLayoutMetrics");
    expect(debuggerCalls.filter((call) => call === "Page.captureScreenshot")).toHaveLength(1);
    expect((await readState()).revisions["61"]).toMatchObject({ floor: 2, current: 2 });
  });

  test("passes bounded screenshot encoding and scaling controls to Chrome", async () => {
    debuggerCommandOverride = (method) => {
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: {
            pageX: 10,
            pageY: 20,
            clientWidth: 2000,
            clientHeight: 1000,
          },
        };
      }
      if (method === "Page.captureScreenshot") return { data: "AAAA" };
      return undefined;
    };
    const runtime = new StandardBrowserRuntime(
      new RevisionTracker(),
      async () => undefined,
      () => undefined,
      async () => undefined,
    );

    const result = await runtime.snapshot(62, {
      mode: "screenshot",
      format: "jpeg",
      quality: 68,
      max_width: 1000,
      max_height: 800,
      max_bytes: 10,
    });

    expect(result).toMatchObject({
      mode: "screenshot",
      format: "jpeg",
      media_type: "image/jpeg",
      encoding: "base64",
      data: "AAAA",
      byte_length: 3,
    });
    const capture = debuggerCommands.find((command) => command.method === "Page.captureScreenshot");
    expect(capture?.params).toMatchObject({
      format: "jpeg",
      quality: 68,
      clip: { x: 10, y: 20, width: 2000, height: 1000, scale: 0.5 },
    });
  });

  test("returns a small actionable error before an oversized screenshot reaches Core", async () => {
    debuggerCommandOverride = (method) => {
      if (method === "Page.captureScreenshot") return { data: "A".repeat(1_000_004) };
      return undefined;
    };
    const runtime = new StandardBrowserRuntime(
      new RevisionTracker(),
      async () => undefined,
      () => undefined,
      async () => undefined,
    );

    await expect(runtime.snapshot(63, { mode: "screenshot" })).rejects.toMatchObject({
      code: "snapshot_too_large",
      recovery: expect.stringContaining("jpeg or webp"),
    });
  });

  test("truncates JSON-expanding text snapshots to the deliverable Core budget", async () => {
    scriptResult = "\u0000".repeat(300_000);
    const runtime = new StandardBrowserRuntime(
      new RevisionTracker(),
      async () => undefined,
      () => undefined,
      async () => undefined,
    );

    const result = await runtime.snapshot(64, { mode: "html", max_bytes: 300_000 });

    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(1_032_000);
  });

  test("rejects text and HTML snapshots when the document changes during capture", async () => {
    for (const [index, mode] of (["text", "html"] as const).entries()) {
      const tabId = 68 + index;
      let frameTreeReads = 0;
      scriptResult = mode === "text" ? "captured text" : "<main>captured html</main>";
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
      const runtime = new StandardBrowserRuntime(
        new RevisionTracker(),
        async () => undefined,
        () => undefined,
        async () => undefined,
      );
      const scriptCalls = scriptingCallCount;

      await expect(runtime.snapshot(tabId, { mode })).rejects.toMatchObject({
        code: "stale_revision",
        currentPageRevision: 2,
      });

      expect(scriptingCallCount).toBe(scriptCalls + 1);
      expect((await readState()).revisions[String(tabId)]).toMatchObject({ floor: 2, current: 2 });
      await runtime.detach(tabId);
    }
  });

  test("matches only tab-scoped downloads completed after the wait starts", async () => {
    vi.useFakeTimers();
    try {
      const flushPromiseQueue = async (): Promise<void> => {
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      };
      const advanceTimers = async (milliseconds: number): Promise<void> => {
        for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) {
          vi.advanceTimersByTime(Math.min(50, milliseconds - elapsed));
          await flushPromiseQueue();
        }
      };
      const runtime = new StandardBrowserRuntime(
        new RevisionTracker(),
        async () => undefined,
        () => undefined,
        async () => undefined,
      );
      await runtime.snapshot(61, { mode: "accessibility" });

      completedDownloads = [{
        id: 1,
        state: "complete",
        endTime: new Date(Date.now() - 60_000).toISOString(),
      }];
      emitDebuggerEvent(61, "Page.downloadWillBegin", { guid: "stale" });
      emitDebuggerEvent(61, "Page.downloadProgress", { guid: "stale", state: "completed" });
      vi.advanceTimersByTime(1);
      const staleWait = runtime.wait(61, {
        condition: { kind: "download" },
        timeout_ms: 1,
      });
      await flushPromiseQueue();
      await advanceTimers(200);
      await expect(staleWait).rejects.toMatchObject({ code: "wait_timeout" });

      let settled = false;
      const waiting = runtime.wait(61, {
        condition: { kind: "download" },
        timeout_ms: 1_000,
      }).then((result) => {
        settled = true;
        return result;
      });
      await flushPromiseQueue();
      completedDownloads = [{
        id: 2,
        state: "complete",
        endTime: new Date().toISOString(),
      }];
      emitDebuggerEvent(62, "Page.downloadWillBegin", { guid: "other-tab" });
      emitDebuggerEvent(62, "Page.downloadProgress", { guid: "other-tab", state: "completed" });
      await advanceTimers(100);
      expect(settled).toBe(false);

      emitDebuggerEvent(61, "Page.downloadWillBegin", { guid: "target-tab" });
      emitDebuggerEvent(61, "Page.downloadProgress", { guid: "target-tab", state: "completed" });
      await advanceTimers(100);
      await expect(waiting).resolves.toMatchObject({
        tab_id: 61,
        condition: "download",
        matched: true,
      });
      await runtime.detach(61);
    } finally {
      vi.useRealTimers();
    }
  });

  test("holds an existing debugger session through a network-idle wait", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new StandardBrowserRuntime(
        new RevisionTracker(),
        async () => undefined,
        () => undefined,
        async () => undefined,
      );
      await runtime.snapshot(61, { mode: "accessibility" });
      emitDebuggerEvent(61, "Network.requestWillBeSent", { requestId: "still-loading" });

      let settled = false;
      const waiting = runtime.wait(61, {
        condition: { kind: "network_idle" },
        timeout_ms: 31_000,
      }).then((result) => {
        settled = true;
        return result;
      });
      await flushPromiseQueue();

      await advanceTimers(30_000);
      expect(debuggerCalls.filter((call) => call === "detach")).toHaveLength(0);
      expect(debuggerAttachedTabIds.has(61)).toBe(true);
      expect(settled).toBe(false);

      emitDebuggerEvent(61, "Network.loadingFinished", { requestId: "still-loading" });
      await advanceTimers(600);
      await expect(waiting).resolves.toMatchObject({
        tab_id: 61,
        condition: "network_idle",
        matched: true,
      });
      await runtime.detach(61);
    } finally {
      vi.useRealTimers();
    }
  });

  test("schedules idle detach after a newly attached network-idle wait completes", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new StandardBrowserRuntime(
        new RevisionTracker(),
        async () => undefined,
        () => undefined,
        async () => undefined,
      );
      const waiting = runtime.wait(61, {
        condition: { kind: "network_idle" },
        timeout_ms: 1_000,
      });
      await flushPromiseQueue();
      await advanceTimers(600);
      await expect(waiting).resolves.toMatchObject({
        tab_id: 61,
        condition: "network_idle",
        matched: true,
      });
      expect(debuggerAttachedTabIds.has(61)).toBe(true);

      await advanceTimers(30_000);
      expect(debuggerCalls.filter((call) => call === "detach")).toHaveLength(1);
      expect(debuggerAttachedTabIds.has(61)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("schedules idle detach after network-idle timeout and revalidation failure", async () => {
    vi.useFakeTimers();
    try {
      tabStore.set(61, {
        id: 61,
        windowId: 1,
        groupId: -1,
        url: "https://example.test/",
        status: "loading",
      });
      const runtime = new StandardBrowserRuntime(
        new RevisionTracker(),
        async () => undefined,
        () => undefined,
        async () => undefined,
      );

      const timedOut = runtime.wait(61, {
        condition: { kind: "network_idle" },
        timeout_ms: 100,
      });
      await flushPromiseQueue();
      await advanceTimers(200);
      await expect(timedOut).rejects.toMatchObject({ code: "wait_timeout", outcome: "unknown" });
      expect(debuggerAttachedTabIds.has(61)).toBe(true);

      await advanceTimers(30_000);
      expect(debuggerAttachedTabIds.has(61)).toBe(false);

      const revalidationError = Object.assign(new Error("ownership changed"), { code: "ownership_revoked" });
      await expect(runtime.wait(
        62,
        { condition: { kind: "network_idle" }, timeout_ms: 1_000 },
        async () => {
          throw revalidationError;
        },
      )).rejects.toBe(revalidationError);
      expect(debuggerAttachedTabIds.has(62)).toBe(true);

      await advanceTimers(30_000);
      expect(debuggerCalls.filter((call) => call === "detach")).toHaveLength(2);
      expect(debuggerAttachedTabIds.has(62)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops a browser wait after the user moves its tab out of the task group", async () => {
    await seedTask(TASK_A, [61], 5);
    scriptResult = false;
    const scheduler = new MutationScheduler();
    const revisions = new RevisionTracker();
    const ownership = new OwnershipLedger(scheduler, revisions, () => undefined);
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
    let ownershipChecks = 0;
    const waiting = runtime.wait(
      61,
      {
        condition: { kind: "selector", value: "#never" },
        timeout_ms: 1_000,
      },
      async () => {
        ownershipChecks += 1;
        await ownership.assertOwned(TASK_A, 61);
      },
    );
    await waitForCondition(() => ownershipChecks >= 2);
    const tab = tabStore.get(61);
    if (!tab) throw new Error("missing task tab");
    tab.groupId = 9;

    await expect(waiting).rejects.toMatchObject({ code: "ownership_revoked" });
    expect(ownershipChecks).toBeGreaterThan(2);
  });
  test("stops a page-content wait before probing a newly restricted route", async () => {
    await seedTask(TASK_A, [61], 5);
    scriptResult = false;
    const runtime = new StandardBrowserRuntime(
      new RevisionTracker(),
      async () => undefined,
      () => undefined,
      async () => undefined,
    );
    const waiting = runtime.wait(61, {
      condition: { kind: "selector", value: "#never" },
      timeout_ms: 1_000,
    });
    await waitForCondition(() => scriptingCallCount >= 1);
    const probesBeforeNavigation = scriptingCallCount;
    const tab = tabStore.get(61);
    if (!tab) throw new Error("missing task tab");
    tab.pendingUrl = "chrome://settings/";

    await expect(waiting).rejects.toMatchObject({ code: "browser_restricted_origin" });
    expect(scriptingCallCount).toBe(probesBeforeNavigation);
  });
  test("rejects download waits on browser-restricted routes before debugger attachment", async () => {
    await seedTask(TASK_A, [61], 5);
    const tab = tabStore.get(61);
    if (!tab) throw new Error("missing task tab");
    tab.pendingUrl = "chrome://settings/";
    const runtime = new StandardBrowserRuntime(
      new RevisionTracker(),
      async () => undefined,
      () => undefined,
      async () => undefined,
    );
    const debuggerCallsBeforeWait = debuggerCalls.length;
    const scriptingCallsBeforeWait = scriptingCallCount;

    await expect(runtime.wait(61, {
      condition: { kind: "download" },
      timeout_ms: 1_000,
    })).rejects.toMatchObject({ code: "browser_restricted_origin" });
    expect(debuggerCalls).toHaveLength(debuggerCallsBeforeWait);
    expect(scriptingCallCount).toBe(scriptingCallsBeforeWait);
  });


  test("types into a background field through one DOM mutation", async () => {
    debuggerCommandOverride = (method, params) => {
      if (
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes("const f=this.form")
      ) {
        return {
          result: {
            value: {
              tag: "INPUT",
              role: "textbox",
              aria_label: "Search query",
              name: "query",
              form_action: "https://example.test/search",
              form_method: "get",
            },
          },
        };
      }
      return undefined;
    };
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
    const pageRevision = await revisions.ensure(63);

    await runtime.act(TASK_A, 63, pageRevision, [
      { kind: "type", ref: `r${pageRevision}-22`, text: "x" },
    ]);

    const calls = debuggerCommands.filter(
      ({ method, params }) =>
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes("InputEvent('input'"),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params.functionDeclaration).toContain("InputEvent('input'");
    expect(debuggerCalls).not.toContain("Input.insertText");
  });

  test("fills contenteditable fields and uses native setters for fill and type", async () => {
    class SyntheticEvent {
      readonly bubbles: boolean;

      constructor(
        readonly type: string,
        init: Record<string, unknown> = {},
      ) {
        this.bubbles = init.bubbles === true;
      }
    }
    class NativeInput {
      nativeValue = "before";
      focused = 0;
      readonly events: Array<{ type: string; bubbles: boolean }> = [];
      selectionStart = 2;
      selectionEnd = 4;
      readonly selectionUpdates: Array<[number, number]> = [];

      get value(): string {
        return this.nativeValue;
      }

      set value(value: string) {
        this.nativeValue = value;
      }

      getAttribute(): null {
        return null;
      }

      focus(): void {
        this.focused += 1;
      }

      setSelectionRange(start: number, end: number): void {
        this.selectionStart = start;
        this.selectionEnd = end;
        this.selectionUpdates.push([start, end]);
      }

      dispatchEvent(event: SyntheticEvent): boolean {
        this.events.push({ type: event.type, bubbles: event.bubbles });
        return true;
      }
    }
    const contenteditable = {
      isContentEditable: true,
      textContent: "before",
      focused: 0,
      events: [] as Array<{ type: string; bubbles: boolean }>,
      getAttribute: (): null => null,
      focus(): void {
        this.focused += 1;
      },
      dispatchEvent(event: SyntheticEvent): boolean {
        this.events.push({ type: event.type, bubbles: event.bubbles });
        return true;
      },
    };
    const formattedChild = { textContent: "formatted" };
    const insertedNodes: Array<{ textContent: string }> = [];
    const rangeCalls: string[] = [];
    const range = {
      commonAncestorContainer: formattedChild,
      deleteContents(): void {
        rangeCalls.push("deleteContents");
      },
      insertNode(node: { textContent: string }): void {
        rangeCalls.push("insertNode");
        insertedNodes.push(node);
      },
      setStartAfter(node: { textContent: string }): void {
        rangeCalls.push(`setStartAfter:${node.textContent}`);
      },
      collapse(toStart: boolean): void {
        rangeCalls.push(`collapse:${toStart}`);
      },
    };
    const selectionCalls: string[] = [];
    const selection = {
      rangeCount: 1,
      getRangeAt: (): typeof range => range,
      removeAllRanges(): void {
        selectionCalls.push("removeAllRanges");
      },
      addRange(added: typeof range): void {
        if (added !== range) throw new Error("unexpected contenteditable range");
        selectionCalls.push("addRange");
      },
    };
    const typedContenteditable = {
      isContentEditable: true,
      childNodes: [formattedChild],
      focused: 0,
      events: [] as Array<{ type: string; bubbles: boolean }>,
      getAttribute: (): null => null,
      ownerDocument: {
        getSelection: (): typeof selection => selection,
        createRange: (): typeof range => range,
        createTextNode: (textContent: string): { textContent: string } => ({ textContent }),
      },
      contains(node: unknown): boolean {
        return node === formattedChild;
      },
      focus(): void {
        this.focused += 1;
      },
      dispatchEvent(event: SyntheticEvent): boolean {
        this.events.push({ type: event.type, bubbles: event.bubbles });
        return true;
      },
    };
    Object.defineProperty(typedContenteditable, "textContent", {
      configurable: true,
      get: () => "formatted",
      set: () => {
        throw new Error("type must preserve contenteditable child DOM");
      },
    });
    const input = new NativeInput();
    const typedInput = new NativeInput();
    const interceptedDirectAssignments: string[] = [];
    for (const target of [input, typedInput]) {
      Object.defineProperty(target, "value", {
        configurable: true,
        set(value: string) {
          interceptedDirectAssignments.push(value);
        },
      });
    }
    const globals: Record<string, PropertyDescriptor | undefined> = {
      Event: Object.getOwnPropertyDescriptor(globalThis, "Event"),
      InputEvent: Object.getOwnPropertyDescriptor(globalThis, "InputEvent"),
      HTMLInputElement: Object.getOwnPropertyDescriptor(globalThis, "HTMLInputElement"),
      HTMLTextAreaElement: Object.getOwnPropertyDescriptor(globalThis, "HTMLTextAreaElement"),
    };
    Object.defineProperties(globalThis, {
      Event: { configurable: true, writable: true, value: SyntheticEvent },
      InputEvent: { configurable: true, writable: true, value: SyntheticEvent },
      HTMLInputElement: { configurable: true, writable: true, value: NativeInput },
      HTMLTextAreaElement: { configurable: true, writable: true, value: class { } },
    });
    debuggerCommandOverride = (method, params) => {
      if (
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes("const f=this.form")
      ) {
        return {
          result: {
            value: {
              tag: "INPUT",
              role: "textbox",
              aria_label: "Profile note",
              name: "note",
              form_action: "https://example.test/profile",
              form_method: "get",
            },
          },
        };
      }
      if (
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes("agenttab_sensitive_field")
      ) {
        const target = String(params.objectId).endsWith("-22")
          ? contenteditable
          : String(params.objectId).endsWith("-23")
            ? input
            : String(params.objectId).endsWith("-24")
              ? typedInput
              : typedContenteditable;
        const declaration = Function(`return (${String(params.functionDeclaration)})`)() as (
          this: typeof contenteditable | typeof typedContenteditable | NativeInput,
          value: string,
        ) => unknown;
        const args = Array.isArray(params.arguments) ? params.arguments : [];
        const argument = args[0];
        const value =
          argument !== null && typeof argument === "object" && "value" in argument
            ? String(argument.value ?? "")
            : "";
        return { result: { value: declaration.call(target, value) } };
      }
      return undefined;
    };
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
    const pageRevision = await revisions.ensure(63);

    try {
      await runtime.act(TASK_A, 63, pageRevision, [
        { kind: "fill", ref: `r${pageRevision}-22`, text: "content replacement" },
        { kind: "fill", ref: `r${pageRevision}-23`, text: "native setter" },
        { kind: "type", ref: `r${pageRevision}-24`, text: "X" },
        { kind: "type", ref: `r${pageRevision}-25`, text: " at caret" },
      ]);
    } finally {
      for (const [key, descriptor] of Object.entries(globals)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }

    expect(contenteditable.textContent).toBe("content replacement");
    expect(contenteditable.focused).toBe(1);
    expect(contenteditable.events).toEqual([
      { type: "input", bubbles: true },
      { type: "change", bubbles: true },
    ]);
    expect(input.nativeValue).toBe("native setter");
    expect(typedInput.nativeValue).toBe("beXre");
    expect(typedInput.selectionUpdates).toEqual([[3, 3]]);
    expect(typedContenteditable.childNodes).toEqual([formattedChild]);
    expect(insertedNodes).toEqual([{ textContent: " at caret" }]);
    expect(rangeCalls).toEqual([
      "deleteContents",
      "insertNode",
      "setStartAfter: at caret",
      "collapse:true",
    ]);
    expect(selectionCalls).toEqual(["removeAllRanges", "addRange"]);
    expect(typedContenteditable.focused).toBe(1);
    expect(typedContenteditable.events).toEqual([{ type: "input", bubbles: true }]);
    expect(interceptedDirectAssignments).toEqual([]);
    expect(input.focused).toBe(1);
    expect(input.events).toEqual([
      { type: "input", bubbles: true },
      { type: "change", bubbles: true },
    ]);
    expect(typedInput.focused).toBe(1);
    expect(typedInput.events).toEqual([
      { type: "input", bubbles: true },
    ]);
  });

  test("routes password and payment fields through a human handoff before staging", async () => {
    let mutationCalls = 0;
    debuggerCommandOverride = (method, params) => {
      if (
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes("const f=this.form")
      ) {
        const objectId = String(params.objectId);
        const attributes: Record<string, string> = objectId.endsWith("-22")
          ? { type: "password" }
          : objectId.endsWith("-23")
            ? { autocomplete: "section-checkout billing cc-number" }
            : objectId.endsWith("-24")
              ? { autocomplete: "cc-exp-month" }
              : objectId.endsWith("-25")
                ? { name: "card-number", "aria-label": "Card number", inputmode: "numeric" }
                : objectId.endsWith("-26")
                  ? { name: "otp", "aria-label": "Verification code", inputmode: "numeric" }
                  : objectId.endsWith("-27")
                    ? { type: "number", name: "pin" }
                    : objectId.endsWith("-28")
                      ? { "aria-label": "Passcode" }
                      : objectId.endsWith("-29")
                        ? { type: "text", name: "password" }
                        : objectId.endsWith("-30")
                          ? { name: "totp" }
                          : objectId.endsWith("-31")
                            ? { "aria-label": "2FA code" }
                            : objectId.endsWith("-32")
                              ? { placeholder: "Two-factor code" }
                              : objectId.endsWith("-33")
                                ? { "aria-label": "Card expiration month" }
                                : objectId.endsWith("-34")
                                  ? { name: "cardExpiryYear" }
                                  : objectId.endsWith("-35")
                                    ? { type: "text", name: "security_code" }
                                    : objectId.endsWith("-36")
                                      ? { name: "cvv2" }
                                      : objectId.endsWith("-37")
                                        ? { name: "cid" }
                                        : objectId.endsWith("-38")
                                          ? { name: "cardVerificationValue" }
                                          : objectId.endsWith("-39")
                                            ? { name: "mfaCode" }
                                            : objectId.endsWith("-40")
                                              ? { "aria-label": "MFA token" }
                                              : objectId.endsWith("-41")
                                                ? { name: "multiFactorAuthenticationCode" }
                                                : objectId.endsWith("-42")
                                                  ? { name: "captcha", "aria-label": "Enter CAPTCHA" }
                                                  : objectId.endsWith("-43")
                                                    ? { name: "h-captcha-response" }
                                                    : { name: "g-recaptcha-response" };
        const target = {
          form: null,
          labels: [],
          options: [],
          ownerDocument: { getElementById() { return null; } },
          tagName: objectId.endsWith("-24") || objectId.endsWith("-33") || objectId.endsWith("-34") ? "SELECT" : "INPUT",
          innerText: "",
          textContent: "",
          id: "",
          getAttribute(name: string) {
            return attributes[name] ?? "";
          },
        };
        const declaration = Function(`return (${String(params.functionDeclaration)})`)() as (
          this: typeof target,
          value: string,
        ) => unknown;
        const args = Array.isArray(params.arguments) ? params.arguments : [];
        const argument = args[0];
        const value =
          argument !== null && typeof argument === "object" && "value" in argument
            ? String(argument.value ?? "")
            : "";
        return { result: { value: declaration.call(target, value) } };
      }
      if (
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes("agenttab_sensitive_field")
      ) {
        mutationCalls += 1;
      }
      return undefined;
    };
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
    const pageRevision = await revisions.ensure(63);

    for (const action of [
      { kind: "type", ref: `r${pageRevision}-22`, text: "password" },
      { kind: "fill", ref: `r${pageRevision}-23`, text: "4111111111111111" },
      { kind: "select", ref: `r${pageRevision}-24`, value: "08" },
      { kind: "fill", ref: `r${pageRevision}-25`, text: "4111111111111111" },
      { kind: "type", ref: `r${pageRevision}-26`, text: "123456" },
      { kind: "fill", ref: `r${pageRevision}-27`, text: "1234" },
      { kind: "type", ref: `r${pageRevision}-28`, text: "123456" },
      { kind: "fill", ref: `r${pageRevision}-29`, text: "password" },
      { kind: "type", ref: `r${pageRevision}-30`, text: "123456" },
      { kind: "fill", ref: `r${pageRevision}-31`, text: "123456" },
      { kind: "type", ref: `r${pageRevision}-32`, text: "123456" },
      { kind: "select", ref: `r${pageRevision}-33`, value: "08" },
      { kind: "fill", ref: `r${pageRevision}-35`, text: "123" },
      { kind: "select", ref: `r${pageRevision}-34`, value: "2030" },
      { kind: "fill", ref: `r${pageRevision}-36`, text: "123" },
      { kind: "fill", ref: `r${pageRevision}-37`, text: "123" },
      { kind: "fill", ref: `r${pageRevision}-38`, text: "123" },
      { kind: "fill", ref: `r${pageRevision}-39`, text: "123456" },
      { kind: "fill", ref: `r${pageRevision}-40`, text: "123456" },
      { kind: "fill", ref: `r${pageRevision}-41`, text: "123456" },
      { kind: "fill", ref: `r${pageRevision}-42`, text: "human-response" },
      { kind: "fill", ref: `r${pageRevision}-43`, text: "human-response" },
      { kind: "fill", ref: `r${pageRevision}-44`, text: "human-response" },
    ]) {
      await expect(runtime.act(TASK_A, 63, pageRevision, [action])).rejects.toMatchObject({
        code: "sensitive_field_requires_handoff",
        recovery: "Start browser_handoff for this tab and let the human enter the sensitive value.",
      });
    }

    expect(mutationCalls).toBe(0);
    expect((await readState()).stagedCommits).toEqual({});
  });

  test("rechecks inferred sensitivity immediately before mutation", async () => {
    let assignments = 0;
    let dispatchedEvents = 0;
    debuggerCommandOverride = (method, params) => {
      if (
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes("const f=this.form")
      ) {
        return {
          result: {
            value: {
              tag: "INPUT",
              role: "textbox",
              aria_label: "Account reference",
              autocomplete: "",
              form_action: "https://example.test/profile",
              form_method: "get",
            },
          },
        };
      }
      if (
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes("agenttab_sensitive_field")
      ) {
        const target = {
          tagName: "INPUT",
          id: "",
          labels: [],
          ownerDocument: { getElementById() { return null; } },
          getAttribute(name: string) {
            if (name === "aria-label") return "Passcode";
            return "";
          },
          set value(_value: string) {
            assignments += 1;
          },
          dispatchEvent() {
            dispatchedEvents += 1;
          },
        };
        const declaration = Function(`return (${String(params.functionDeclaration)})`)() as (
          this: typeof target,
          value: string,
        ) => unknown;
        const args = Array.isArray(params.arguments) ? params.arguments : [];
        const argument = args[0];
        const value =
          argument !== null && typeof argument === "object" && "value" in argument
            ? String(argument.value ?? "")
            : "";
        return { result: { value: declaration.call(target, value) } };
      }
      return undefined;
    };
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
    const pageRevision = await revisions.ensure(63);

    await expect(
      runtime.act(TASK_A, 63, pageRevision, [
        { kind: "fill", ref: `r${pageRevision}-24`, text: "4111111111111111" },
      ]),
    ).rejects.toMatchObject({
      code: "sensitive_field_requires_handoff",
      recovery: "Start browser_handoff for this tab and let the human enter the sensitive value.",
    });
    expect(assignments).toBe(0);
    expect(dispatchedEvents).toBe(0);
  });

  test("rejects a page action that raises in the target document", async () => {
    debuggerCommandOverride = (method, params) => {
      if (
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes("const f=this.form")
      ) {
        return {
          result: {
            value: {
              tag: "INPUT",
              role: "textbox",
              aria_label: "Search query",
              name: "query",
              form_action: "https://example.test/search",
              form_method: "get",
            },
          },
        };
      }
      return undefined;
    };
    callFunctionException = true;
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
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

  test("creates an unfocused normal window only for an empty task", async () => {
    const ownership = new OwnershipLedger(
      new MutationScheduler(),
      new RevisionTracker(),
      () => undefined,
    );

    const opened = await ownership.open(TASK_A, {
      mode: "create",
      url: "https://example.test/workspace",
      placement: "new_window",
    });

    expect(opened).toMatchObject({ window_id: 2, group_id: 50, tab_count: 1 });
    expect(createdWindowOptions).toEqual([{
      url: "https://example.test/workspace",
      focused: false,
      type: "normal",
      state: "normal",
    }]);
    expect(windowUpdates).toEqual([{
      windowId: 2,
      changes: { focused: false, state: "normal" },
    }]);
    expect(focusedWindowUpdates).toEqual([]);
    expect(tabStore.get(100)).toMatchObject({ windowId: 2, groupId: 50, active: false });

    await expect(ownership.open(TASK_A, {
      mode: "create",
      placement: "new_window",
    })).rejects.toMatchObject({
      code: "task_window_conflict",
      recovery: "Use placement task for this task, or create a new task for a separate window.",
    });
    expect(createdWindowOptions).toHaveLength(1);
  });
  test("creates additional task tabs in the existing task window", async () => {
    await seedTask(TASK_A, [31], 7);
    const taskTab = tabStore.get(31);
    if (!taskTab) throw new Error("missing task tab");
    taskTab.active = true;
    taskTab.lastAccessed = 1;
    tabStore.set(90, {
      id: 90,
      windowId: 2,
      groupId: -1,
      active: true,
      lastAccessed: 100,
      url: "https://human.example/",
      status: "complete",
    });
    Object.assign(chrome.windows, {
      async getAll() {
        return [
          { id: 1, tabs: clone([...tabStore.values()].filter((tab) => tab.windowId === 1)) },
          { id: 2, tabs: clone([...tabStore.values()].filter((tab) => tab.windowId === 2)) },
        ];
      },
    });
    const ownership = new OwnershipLedger(
      new MutationScheduler(),
      new RevisionTracker(),
      () => undefined,
    );

    const opened = await ownership.open(TASK_A, {
      mode: "create",
      url: "https://example.test/additional",
      background: true,
    });

    expect(opened).toMatchObject({ window_id: 1, group_id: 7, tab_count: 2 });
    expect(tabStore.get(100)).toMatchObject({ windowId: 1, groupId: 7 });
    expect(tabStore.get(90)).toMatchObject({ windowId: 2, active: true });
  });


  test("publishes a loading tab's pending URL instead of its previous URL", async () => {
    await seedTask(TASK_A, [31], 7);
    const tab = tabStore.get(31);
    if (!tab) throw new Error("missing test tab");
    tab.url = "https://example.test/previous";
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

  test("does not persist a matching ownership reconciliation", async () => {
    await seedTask(TASK_A, [31], 7);
    const revisions = new RevisionTracker();
    await revisions.ensure(31);
    const ownership = new OwnershipLedger(
      new MutationScheduler(),
      revisions,
      () => undefined,
    );
    const initialGets = storageGetCount;
    const initialSets = storageSetCount;

    expect(await ownership.reconcile()).toEqual([]);
    expect(storageGetCount).toBe(initialGets);
    expect(storageSetCount).toBe(initialSets);
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

  test("inherits opener ownership across popup windows without changing the active Chrome window", async () => {
    await seedTask(TASK_A, [21]);
    tabStore.set(20, {
      id: 20,
      windowId: 1,
      groupId: -1,
      active: true,
      url: "https://example.test/active",
    });
    tabStore.set(30, {
      id: 30,
      windowId: 3,
      groupId: -1,
      active: true,
      url: "https://example.test/user",
    });
    activeWindowId = 3;
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
    expect(focusedWindowUpdates).toEqual([]);
    expect(activeWindowId).toBe(3);
    let taskDeletedBeforeRemove = false;
    tabRemovalProbe = async () => {
      taskDeletedBeforeRemove = (await readState()).tasks[TASK_A] === undefined;
    };
    await mutateState((state) => {
      state.policyAllowances[policyAllowanceKey("task", "financial", TASK_A)] = {
        scope: "task",
        taskId: TASK_A,
        effect: "financial",
        createdAt: 1,
      };
      state.policyAllowances[policyAllowanceKey("effect", "upload")] = {
        scope: "effect",
        effect: "upload",
        createdAt: 2,
      };
    });
    await ownership.closeTask(TASK_A);

    expect(taskDeletedBeforeRemove).toBe(true);
    expect(removedTabIds).toEqual([21, 22]);
    expect((await readState()).tasks[TASK_A]).toBeUndefined();
    expect((await readState()).policyAllowances).toEqual({
      [policyAllowanceKey("effect", "upload")]: {
        scope: "effect",
        effect: "upload",
        createdAt: 2,
      },
    });
  });

  test("keeps ownership deleted when one Chrome tab is already unavailable", async () => {
    await seedTask(TASK_A, [21, 22]);
    const scheduler = new MutationScheduler();
    const ownership = new OwnershipLedger(
      scheduler,
      new RevisionTracker(),
      () => undefined,
    );
    const removeTab = chrome.tabs.remove.bind(chrome.tabs);
    chrome.tabs.remove = (async (tabIds: number | number[]) => {
      const tabId = Array.isArray(tabIds) ? tabIds[0] : tabIds;
      if (tabId === 22) throw new Error("tab already closed");
      await removeTab(tabId);
    }) as typeof chrome.tabs.remove;

    expect(await ownership.closeTask(TASK_A)).toEqual([21]);
    expect(removedTabIds).toEqual([21]);
    expect((await readState()).tasks[TASK_A]).toBeUndefined();
  });

  test("does not adopt a tab opened by an unowned opener even when Chrome groups it with a task", async () => {
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

    expect((await readState()).tasks[TASK_A]?.tabIds).toEqual([21]);
    expect(tabStore.get(22)).toMatchObject({ windowId: 1, groupId: 5, active: false });
    expect(removedTabIds).toEqual([]);
  });

  test("adopts a debugger-correlated popup despite Chrome's wrong opener and inherited group", async () => {
    await seedTask(TASK_A, [21]);
    tabStore.set(99, {
      id: 99,
      windowId: 1,
      groupId: 9,
      active: true,
      url: "chrome-extension://agenttab/popup.html",
    });
    tabStore.set(22, {
      id: 22,
      windowId: 1,
      groupId: 9,
      active: false,
      openerTabId: 99,
      url: "https://example.test/child",
    });
    const ownership = new OwnershipLedger(
      new MutationScheduler(),
      new RevisionTracker(),
      () => undefined,
    );

    await ownership.adoptOwnedChild(tabStore.get(22) ?? {}, 21);

    expect((await readState()).tasks[TASK_A]?.tabIds).toEqual([21, 22]);
    expect(tabStore.get(22)).toMatchObject({ windowId: 1, groupId: 5, active: false });
  });

  test("preserves a child in a foreign tab group despite its owned opener", async () => {
    await seedTask(TASK_A, [21]);
    tabStore.set(22, {
      id: 22,
      windowId: 1,
      groupId: 9,
      active: false,
      openerTabId: 21,
      url: "https://example.test/child",
    });
    const ownership = new OwnershipLedger(
      new MutationScheduler(),
      new RevisionTracker(),
      () => undefined,
    );

    await ownership.adoptOwnedChild(tabStore.get(22) ?? {});

    expect((await readState()).tasks[TASK_A]?.tabIds).toEqual([21]);
    expect(tabStore.get(22)).toMatchObject({ windowId: 1, groupId: 9, active: false });
    expect(removedTabIds).toEqual([]);
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

  test("requires acknowledgment when an owned handoff tab or task disappears", async () => {
    await seedTask(TASK_A, [33]);
    await seedTask(TASK_B, [34], 6);
    const scheduler = new MutationScheduler();
    const revisions = new RevisionTracker();
    const events: Array<{ event: string; payload: Record<string, unknown>; eventId?: string }> = [];
    const ownership = new OwnershipLedger(scheduler, revisions, () => undefined);
    const handoff = new HandoffController(scheduler, revisions, ownership, (event, payload, eventId) => {
      events.push({ event, payload, eventId });
    });
    let scrubCalls = 0;
    handoff.setScrubber(async () => {
      scrubCalls += 1;
    });
    const firstRevision = await revisions.ensure(33);
    await handoff.begin(TASK_A, {
      tab_id: 33,
      expected_page_revision: firstRevision,
      prompt: "Complete authentication",
      completion: { kind: "manual_done" },
    });

    expect(await handoff.cancelForTab(999)).toBe(false);
    expect(await handoff.cancelForTab(33)).toBe(true);
    const firstPending = (await readState()).handoff;
    expect((await readState()).tasks[TASK_A]?.state).toBe("needs_user");
    expect(scheduler.isAccepting()).toBe(false);
    const firstClearEventId = events.at(-1)?.eventId;
    if (!firstPending.active || !firstPending.pendingClearEventId || !firstClearEventId) {
      throw new Error("tab cancellation did not create a pending handoff event");
    }
    expect(typeof firstPending.pendingClearEventId).toBe("string");
    expect(firstClearEventId).toBe(firstPending.pendingClearEventId);
    await handoff.acknowledgeEvent("handoff_changed", firstClearEventId);
    expect((await readState()).handoff).toEqual({ active: false });
    expect((await readState()).tasks[TASK_A]?.state).toBe("working");
    expect(scheduler.isAccepting()).toBe(true);

    const secondRevision = await revisions.ensure(34);
    await handoff.begin(TASK_B, {
      tab_id: 34,
      expected_page_revision: secondRevision,
      prompt: "Complete payment",
      completion: { kind: "manual_done" },
    });

    expect(await handoff.cancelForTask(TASK_A)).toBe(false);
    expect(await handoff.cancelForTask(TASK_B)).toBe(true);
    const secondPending = (await readState()).handoff;
    expect((await readState()).tasks[TASK_B]?.state).toBe("needs_user");
    expect(scheduler.isAccepting()).toBe(false);
    const secondClearEventId = events.at(-1)?.eventId;
    if (!secondPending.active || !secondPending.pendingClearEventId || !secondClearEventId) {
      throw new Error("task cancellation did not create a pending handoff event");
    }
    expect(typeof secondPending.pendingClearEventId).toBe("string");
    expect(secondClearEventId).toBe(secondPending.pendingClearEventId);
    await handoff.acknowledgeEvent("handoff_changed", secondClearEventId);
    expect((await readState()).handoff).toEqual({ active: false });
    expect((await readState()).tasks[TASK_B]?.state).toBe("working");
    expect(scheduler.isAccepting()).toBe(true);
    expect(events.filter(({ event, payload, eventId }) =>
      event === "handoff_changed" && payload.active === false && typeof eventId === "string"
    )).toHaveLength(2);
    expect(alarmClears.filter((name) => name === HANDOFF_ALARM)).toHaveLength(4);
    expect(scrubCalls).toBe(2);
  });

  test("clears a restored handoff for a tab revoked during initial reconciliation", async () => {
    await seedTask(TASK_A, [35]);
    const scheduler = new MutationScheduler();
    const revisions = new RevisionTracker();
    const ownership = new OwnershipLedger(scheduler, revisions, () => undefined);
    const clearEventIds: string[] = [];
    const handoff = new HandoffController(scheduler, revisions, ownership, (event, _payload, eventId) => {
      if (event === "handoff_changed" && eventId) clearEventIds.push(eventId);
    });
    let scrubCalls = 0;
    handoff.setScrubber(async () => {
      scrubCalls += 1;
    });
    const pageRevision = await revisions.ensure(35);
    await handoff.begin(TASK_A, {
      tab_id: 35,
      expected_page_revision: pageRevision,
      prompt: "Complete authentication",
      completion: { kind: "manual_done" },
    });
    tabStore.delete(35);

    const revokedTabIds = await ownership.reconcile();
    await Promise.all(revokedTabIds.map((tabId) => handoff.cancelForTab(tabId)));
    await handoff.restore();

    expect(revokedTabIds).toEqual([35]);
    const pending = (await readState()).handoff;
    expect(scheduler.isAccepting()).toBe(false);
    const clearEventId = clearEventIds.at(-1);
    if (!pending.active || !pending.pendingClearEventId || !clearEventId) {
      throw new Error("startup reconciliation did not create a pending handoff event");
    }
    expect(typeof pending.pendingClearEventId).toBe("string");
    expect(clearEventIds).toEqual([pending.pendingClearEventId, pending.pendingClearEventId]);
    expect(clearEventId).toBe(pending.pendingClearEventId);
    await handoff.acknowledgeEvent("handoff_changed", clearEventId);
    expect((await readState()).handoff).toEqual({ active: false });
    expect(scheduler.isAccepting()).toBe(true);
    expect(scrubCalls).toBe(1);
    expect(alarmClears).toContain(HANDOFF_ALARM);
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
      extension_version: "2.0.0",
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
    expect(port.posted[0]).not.toHaveProperty("policy_profile");
    expect(scheduler.isAccepting()).toBe(false);
    await mutateState((state) => {
      state.policyProfile = "strict";
    });

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
    expect(port.posted).not.toContainEqual(expect.objectContaining({ event: "policy_changed" }));

    const disconnectedAt = Date.now();
    port.disconnect();
    expect(scheduler.isAccepting()).toBe(false);
    expect(alarmCreates.at(-1)).toMatchObject({ name: RECONNECT_ALARM });
    expect(alarmCreates.at(-1)?.when).toBeGreaterThanOrEqual(disconnectedAt + 30_000);
    expect(alarmCreates.at(-1)?.when).toBeLessThanOrEqual(Date.now() + 30_000);

    const reconnectPort = new MockNativePort();
    nativePort = reconnectPort;
    await bridge.reconnectFromAlarm(RECONNECT_ALARM);
    reconnectPort.receive({
      protocol: "agenttab.native",
      version: 1,
      kind: "ready",
      host_version: "0.2.0",
      state: "ready",
    });
    await waitForCondition(() => scheduler.isAccepting());
  });

  test("uses an in-worker timer for fast reconnects with a 30-second alarm fallback", async () => {
    const scheduler = new MutationScheduler();
    const ownership = new OwnershipLedger(scheduler, new RevisionTracker(), () => undefined);
    const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
    const disconnectedAt = 123_000;
    const bridge = new NativeBridge(
      scheduler,
      ownership,
      async () => {
        throw new Error("command handler must not run");
      },
      undefined,
      undefined,
      undefined,
      {
        now: () => disconnectedAt,
        schedule: (callback, delayMs) => {
          const timer = { callback, delayMs, cancelled: false };
          scheduled.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      },
    );

    await bridge.connect();

    expect(alarmCreates).toEqual([{
      name: RECONNECT_ALARM,
      when: disconnectedAt + 30_000,
    }]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(1_000);

    scheduled[0]?.callback();
    await waitForCondition(() => scheduled.length === 2);
    expect(scheduled[1]?.delayMs).toBe(2_000);
    expect(alarmCreates).toHaveLength(1);

    const recoveredPort = new MockNativePort();
    nativePort = recoveredPort;

    scheduled[1]?.callback();
    await waitForCondition(() => recoveredPort.posted.length > 0);
    expect(recoveredPort.posted[0]).toMatchObject({ kind: "hello" });
    expect(alarmCreates).toHaveLength(1);

    recoveredPort.receive({
      protocol: "agenttab.native",
      version: 1,
      kind: "ready",
      host_version: "0.2.0",
      state: "ready",
    });
    await waitForCondition(() => alarmClears.includes(RECONNECT_ALARM));
  });

  test("recycles a connected native port that never completes its ready handshake", async () => {
    const scheduler = new MutationScheduler();
    const ownership = new OwnershipLedger(scheduler, new RevisionTracker(), () => undefined);
    const hangingPort = new MockNativePort();
    nativePort = hangingPort;
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const now = 456_000;
    const bridge = new NativeBridge(
      scheduler,
      ownership,
      async () => {
        throw new Error("command handler must not run");
      },
      undefined,
      undefined,
      undefined,
      {
        now: () => now,
        schedule: (callback, delayMs) => {
          scheduled.push({ callback, delayMs });
          return () => undefined;
        },
      },
    );

    await bridge.connect();
    expect(hangingPort.posted[0]).toMatchObject({ kind: "hello" });
    expect(alarmCreates).toEqual([{
      name: RECONNECT_ALARM,
      when: now + 30_000,
    }]);

    await bridge.reconnectFromAlarm(RECONNECT_ALARM);

    expect(hangingPort.disconnectCount).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(1_000);
    expect(alarmCreates).toHaveLength(2);

    const recoveredPort = new MockNativePort();
    nativePort = recoveredPort;
    scheduled[0]?.callback();
    await waitForCondition(() => recoveredPort.posted.length > 0);
    recoveredPort.receive({
      protocol: "agenttab.native",
      version: 1,
      kind: "ready",
      host_version: "0.2.0",
      state: "ready",
    });
    await waitForCondition(() => scheduler.isAccepting());
  });

  test("serializes commands behind ready reconciliation", async () => {
    const scheduler = new MutationScheduler();
    const ownership = new OwnershipLedger(scheduler, new RevisionTracker(), () => undefined);
    const port = new MockNativePort();
    nativePort = port;
    const reconciliationStarted = Promise.withResolvers<void>();
    const allowReconciliation = Promise.withResolvers<void>();
    const handledRequests: string[] = [];
    const bridge = new NativeBridge(
      scheduler,
      ownership,
      async (command) => {
        handledRequests.push(command.request_id);
        return {
          protocol: "agenttab.native",
          version: 1,
          kind: "response",
          request_id: command.request_id,
          outcome: "completed",
          result: {},
        };
      },
      undefined,
      undefined,
      async () => {
        reconciliationStarted.resolve();
        await allowReconciliation.promise;
      },
    );
    await bridge.connect();

    port.receive({
      protocol: "agenttab.native",
      version: 1,
      kind: "ready",
      host_version: "0.2.0",
      state: "ready",
      discard_staged_tokens: [],
    });
    port.receive({
      protocol: "agenttab.native",
      version: 1,
      kind: "command",
      request_id: "018f47b8-2f80-7c20-9c77-f8a38c9e6230",
      task_id: TASK_A,
      connection_id: NATIVE_CONNECTION_ID,
      method: "browser_tabs",
      params: {},
    });
    await reconciliationStarted.promise;
    expect(handledRequests).toEqual([]);
    expect(port.disconnectCount).toBe(0);

    allowReconciliation.resolve();
    await waitForCondition(() => handledRequests.length === 1);
    expect(handledRequests).toEqual(["018f47b8-2f80-7c20-9c77-f8a38c9e6230"]);
    expect(port.posted.at(-1)).toMatchObject({
      kind: "response",
      request_id: "018f47b8-2f80-7c20-9c77-f8a38c9e6230",
      outcome: "completed",
    });
  });

  test("omits oversized URLs from inventory events without disconnecting", async () => {
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
    });
    await waitForCondition(() => alarmClears.includes(RECONNECT_ALARM));

    bridge.sendEvent("inventory", {
      inventory: [{
        tab_id: 44,
        window_id: 1,
        group_id: 12,
        url: `https://example.test/${"x".repeat(16_384)}`,
        page_revision: 1,
      }],
    });

    expect(port.posted.at(-1)).toMatchObject({
      kind: "event",
      event: "inventory",
      payload: { inventory: [{ tab_id: 44, url: "" }] },
    });
    expect(port.disconnectCount).toBe(0);
  });

  test("serializes inventory snapshots so a slow older snapshot cannot publish last", async () => {
    const scheduler = new MutationScheduler();
    const revisions = new RevisionTracker();
    const events: Array<Record<string, unknown>> = [];
    const ownership = new OwnershipLedger(scheduler, revisions, (event, payload) => {
      if (event === "inventory") events.push(payload);
    });
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let inventoryCalls = 0;
    ownership.inventory = async () => {
      inventoryCalls += 1;
      const revision = inventoryCalls;
      if (revision === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return [{
        tab_id: 44,
        window_id: 1,
        group_id: 12,
        url: "https://example.test/",
        page_revision: revision,
        task_id: TASK_A,
      }];
    };

    const firstPublication = ownership.publishInventory();
    await firstStarted.promise;
    const secondPublication = ownership.publishInventory();
    await flushPromiseQueue();
    expect(inventoryCalls).toBe(1);

    releaseFirst.resolve();
    await Promise.all([firstPublication, secondPublication]);

    expect(inventoryCalls).toBe(2);
    expect(events.map((payload) => {
      const inventory = payload.inventory as Array<Record<string, unknown>>;
      return inventory[0]?.page_revision;
    })).toEqual([1, 2]);
  });


  test("processes event acknowledgments while a command remains in flight", async () => {
    const scheduler = new MutationScheduler();
    scheduler.disconnect();
    const ownership = new OwnershipLedger(scheduler, new RevisionTracker(), () => undefined);
    const port = new MockNativePort();
    nativePort = port;
    const commandStarted = Promise.withResolvers<void>();
    const releaseCommand = Promise.withResolvers<void>();
    const requestId = "018f47b8-2f80-7c20-9c77-f8a38c9e6231";
    const bridge = new NativeBridge(scheduler, ownership, async (command) => {
      commandStarted.resolve();
      await releaseCommand.promise;
      return {
        protocol: "agenttab.native",
        version: 1,
        kind: "response",
        request_id: command.request_id,
        outcome: "completed",
        result: {},
      };
    });
    await bridge.connect();
    port.receive({
      protocol: "agenttab.native",
      version: 1,
      kind: "ready",
      host_version: "0.2.0",
      state: "ready",
    });
    await waitForCondition(() => alarmClears.includes(RECONNECT_ALARM));

    port.receive({
      protocol: "agenttab.native",
      version: 1,
      kind: "command",
      request_id: requestId,
      task_id: TASK_A,
      connection_id: NATIVE_CONNECTION_ID,
      method: "browser_wait",
      params: { tab_id: 44, condition: { kind: "load" } },
    });
    await commandStarted.promise;
    const approval = bridge.approvePopupCommit("review-handle-while-waiting", TASK_A, 44);
    const event = port.posted.at(-1) as Record<string, unknown>;
    const eventId = event.event_id;
    if (typeof eventId !== "string") throw new Error("popup approval event id is missing");
    let approvalSettled = false;
    const settledApproval = approval.then((result) => {
      approvalSettled = true;
      return result;
    });
    port.receive({
      protocol: "agenttab.native",
      version: 1,
      kind: "event_ack",
      event: "popup_commit_approved",
      event_id: eventId,
      outcome: "completed",
      result: { receipt_id: "receipt-while-waiting" },
    });

    await waitForCondition(() => approvalSettled);
    await expect(settledApproval).resolves.toEqual({ receipt_id: "receipt-while-waiting" });
    expect(port.posted.some(
      (message) =>
        message !== null &&
        typeof message === "object" &&
        (message as Record<string, unknown>).kind === "response" &&
        (message as Record<string, unknown>).request_id === requestId,
    )).toBe(false);

    releaseCommand.resolve();
    await waitForCondition(() =>
      port.posted.some(
        (message) =>
          message !== null &&
          typeof message === "object" &&
          (message as Record<string, unknown>).kind === "response" &&
          (message as Record<string, unknown>).request_id === requestId,
      ),
    );
  });

  test("sends a popup approval by opaque review handle and requires a host acknowledgment", async () => {
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
    });
    await waitForCondition(() => alarmClears.includes(RECONNECT_ALARM));

    const approval = bridge.approvePopupCommit("review-handle-opaque", TASK_A, 44);
    const event = port.posted.at(-1) as Record<string, unknown>;
    expect(event).toMatchObject({
      kind: "event",
      event: "popup_commit_approved",
      payload: { review_handle: "review-handle-opaque", task_id: TASK_A, tab_id: 44 },
    });
    expect(JSON.stringify(event)).not.toContain("native_token");
    const eventId = event.event_id;
    if (typeof eventId !== "string") throw new Error("popup approval event id is missing");
    port.receive({
      protocol: "agenttab.native",
      version: 1,
      kind: "event_ack",
      event: "popup_commit_approved",
      event_id: eventId,
      outcome: "completed",
      result: { receipt_id: "receipt-popup-approval" },
    });
    await expect(approval).resolves.toEqual({ receipt_id: "receipt-popup-approval" });
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

    await waitForCondition(() => port.disconnectCount === 1);
    expect(scheduler.isAccepting()).toBe(false);
  });
});

describe("startup lifecycle", () => {
  test("shares concurrent initialization and retries after a rejected attempt", async () => {
    let attempts = 0;
    const startup = new IdempotentStartup(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient startup failure");
    });

    const first = startup.start();
    const concurrent = startup.start();
    expect(first).toBe(concurrent);
    expect(startup.phase).toBe("starting");
    await expect(first).rejects.toThrow("transient startup failure");
    expect(startup.phase).toBe("idle");

    await expect(startup.start()).resolves.toBeUndefined();
    expect(startup.phase).toBe("ready");
    await expect(startup.start()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  test("replays queued Chrome event work after a later event retries startup", async () => {
    let attempts = 0;
    const startupErrors: unknown[] = [];
    const completed = Promise.withResolvers<void>();
    const operations: string[] = [];
    const startup = new IdempotentStartup(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("storage temporarily unavailable");
    });
    const queue = new StartupOperationQueue(
      startup,
      (error) => startupErrors.push(error),
    );

    queue.enqueue(() => {
      operations.push("tab-created");
    });
    await waitForCondition(() => startupErrors.length === 1);
    expect(operations).toEqual([]);

    queue.enqueue(() => {
      operations.push("tab-updated");
      completed.resolve();
    });
    await completed.promise;

    expect(attempts).toBe(2);
    expect(operations).toEqual(["tab-created", "tab-updated"]);
  });

  test("drains retained Chrome event work when a direct caller retries startup", async () => {
    let attempts = 0;
    const startupFailed = Promise.withResolvers<void>();
    const operationCompleted = Promise.withResolvers<void>();
    const startup = new IdempotentStartup(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("storage temporarily unavailable");
    });
    const queue = new StartupOperationQueue(
      startup,
      () => startupFailed.resolve(),
    );

    queue.enqueue(() => operationCompleted.resolve());
    await startupFailed.promise;
    await startup.start();
    await operationCompleted.promise;

    expect(attempts).toBe(2);
  });
});

describe("action policy profiles", () => {
  test("defaults to unattended Autopilot while preserving review profiles", async () => {
    tabStore.set(7, {
      id: 7,
      windowId: 1,
      groupId: -1,
      active: false,
      url: "https://shop.example.test/cart",
    });
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(
      revisions,
      async () => undefined,
      () => undefined,
      async () => undefined,
    );
    const pageRevision = await revisions.ensure(7);

    expect((await readState()).policyProfile).toBe("autopilot");
    const automaticPurchase = await runtime.act(TASK_A, 7, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);
    expect(automaticPurchase).toMatchObject({
      result: { actions: [{ kind: "click", completed: true }] },
    });
    expect(automaticPurchase.staged).toBeUndefined();
    const automaticUpload = await runtime.act(TASK_A, 7, pageRevision, [
      { kind: "upload_file", ref: `r${pageRevision}-23`, files: ["/staged/report.pdf"] },
    ]);
    expect(automaticUpload).toMatchObject({
      result: { actions: [{ kind: "upload_file", completed: true }] },
    });
    expect(debuggerCommands).toContainEqual({
      method: "DOM.setFileInputFiles",
      params: { backendNodeId: 23, files: ["/staged/report.pdf"] },
    });
    emitDebuggerEvent(7, "Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Continue?",
    });
    const automaticDialog = await runtime.act(TASK_A, 7, pageRevision, [
      { kind: "dialog", decision: "accept" },
    ]);
    expect(automaticDialog).toMatchObject({
      result: { actions: [{ kind: "dialog", completed: true }] },
    });
    expect(debuggerCommands).toContainEqual({
      method: "Page.handleJavaScriptDialog",
      params: { accept: true },
    });
    const automaticClose = await runtime.act(TASK_A, 7, pageRevision, [{ kind: "close" }]);
    expect(automaticClose).toMatchObject({
      result: { actions: [{ kind: "close", completed: true }] },
    });

    await mutateState((state) => {
      state.policyProfile = "review_selected";
    });
    const reviewedPurchase = await runtime.act(TASK_A, 7, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);
    expect(reviewedPurchase.staged).toMatchObject({
      preview: { policy_effect: "financial", origin: "https://shop.example.test" },
    });
    const selectedClose = await runtime.act(TASK_A, 7, pageRevision, [{ kind: "close" }]);
    expect(selectedClose.staged).toBeUndefined();

    await mutateState((state) => {
      state.policyProfile = "strict";
    });
    const strictClose = await runtime.act(TASK_A, 7, pageRevision, [{ kind: "close" }]);
    expect(strictClose.staged).toMatchObject({
      preview: { policy_effect: "owned_tab_close", origin: "https://shop.example.test" },
    });
  });

  test("remembers an approval for the selected site and effect", async () => {
    tabStore.set(8, {
      id: 8,
      windowId: 1,
      groupId: -1,
      url: "https://shop.example.test/cart",
    });
    await mutateState((state) => {
      state.policyProfile = "review_selected";
    });
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(
      revisions,
      async () => undefined,
      () => undefined,
      async () => undefined,
    );
    const pageRevision = await revisions.ensure(8);
    const first = await runtime.act(TASK_A, 8, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);
    const token = first.staged?.native_token;
    if (!token) throw new Error("expected a reviewed purchase");
    const reviewHandle = "review-handle-policy-remember";
    await runtime.bindReview(TASK_A, {
      native_token: token,
      review_handle: reviewHandle,
      tab_id: 8,
    });
    await expect(runtime.approveReview(reviewHandle, "domain")).resolves.toBe(true);
    expect(Object.values((await readState()).policyAllowances)).toContainEqual(
      expect.objectContaining({
        scope: "domain",
        origin: "https://shop.example.test",
        effect: "financial",
      }),
    );

    const repeated = await runtime.act(TASK_A, 8, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);
    expect(repeated.staged).toBeUndefined();
    expect(repeated).toMatchObject({
      result: { actions: [{ kind: "click", completed: true }] },
    });
  });

  test("keeps task and global-effect approvals category-bound", async () => {
    tabStore.set(9, {
      id: 9,
      windowId: 1,
      groupId: -1,
      url: "https://shop.example.test/cart",
    });
    await mutateState((state) => {
      state.policyProfile = "review_selected";
    });
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(
      revisions,
      async () => undefined,
      () => undefined,
      async () => undefined,
    );
    const pageRevision = await revisions.ensure(9);
    const first = await runtime.act(TASK_A, 9, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);
    if (!first.staged?.native_token) throw new Error("expected a task-scoped review");
    await runtime.bindReview(TASK_A, {
      native_token: first.staged.native_token,
      review_handle: "review-handle-task-scope",
      tab_id: 9,
    });
    await runtime.approveReview("review-handle-task-scope", "task");

    const tab = tabStore.get(9);
    if (!tab) throw new Error("missing action-policy test tab");
    tab.url = "https://other.example.test/checkout";
    expect((await runtime.act(TASK_A, 9, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ])).staged).toBeUndefined();

    const otherTask = await runtime.act(TASK_B, 9, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);
    if (!otherTask.staged?.native_token) throw new Error("task approval crossed task boundary");
    await runtime.bindReview(TASK_B, {
      native_token: otherTask.staged.native_token,
      review_handle: "review-handle-effect-scope",
      tab_id: 9,
    });
    await runtime.approveReview("review-handle-effect-scope", "effect");

    tab.url = "https://third.example.test/cart";
    expect((await runtime.act(TASK_C, 9, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ])).staged).toBeUndefined();

    debuggerCommandOverride = (method, params) => {
      if (
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes("const f=this.form")
      ) {
        return { result: { value: { tag: "BUTTON", text: "Delete account" } } };
      }
      return undefined;
    };
    const destructive = await runtime.act(TASK_C, 9, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);
    expect(destructive.staged?.preview).toMatchObject({ policy_effect: "destructive" });
  });

  test("treats Send payment as financial despite a global communication allowance", async () => {
    tabStore.set(10, {
      id: 10,
      windowId: 1,
      groupId: -1,
      url: "https://pay.example.test/confirm",
    });
    await mutateState((state) => {
      state.policyProfile = "review_selected";
      state.policyAllowances[policyAllowanceKey("effect", "external_communication")] = {
        scope: "effect",
        effect: "external_communication",
        createdAt: 1,
      };
    });
    debuggerCommandOverride = (method, params) => {
      if (
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes("const f=this.form")
      ) {
        return {
          result: {
            value: {
              tag: "BUTTON",
              text: "Send payment",
              aria_label: "Send payment",
            },
          },
        };
      }
      return undefined;
    };
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(
      revisions,
      async () => undefined,
      () => undefined,
      async () => undefined,
    );
    const pageRevision = await revisions.ensure(10);

    const result = await runtime.act(TASK_A, 10, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);

    expect(result.staged?.preview).toMatchObject({
      policy_effect: "financial",
      origin: "https://pay.example.test",
    });
  });
});

describe("consequential action staging", () => {
  beforeEach(async () => {
    await mutateState((state) => {
      state.policyProfile = "review_selected";
    });
  });

  test("stages a purchase-like click, commits it once, and consumes the token", async () => {
    tabStore.set(90, { id: 90, windowId: 1, groupId: -1, active: true });
    tabStore.set(7, { id: 7, windowId: 1, groupId: -1, active: false });
    focusStealOnClickTabId = 7;
    const revisions = new RevisionTracker();
    const events: string[] = [];
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, (event) => events.push(event), async () => undefined);
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
  test("classifies page-owned target semantics without treating caller-entered values as consequences", async () => {
    debuggerCommandOverride = (method, params) => {
      if (
        method !== "Runtime.callFunctionOn" ||
        !String(params.functionDeclaration).includes("const f=this.form")
      ) {
        return undefined;
      }
      const objectId = String(params.objectId);
      const firstArgument = Array.isArray(params.arguments) ? params.arguments[0] : undefined;
      const requestedValue = (
        firstArgument !== null &&
        typeof firstArgument === "object" &&
        typeof (firstArgument as Record<string, unknown>).value === "string"
      )
        ? (firstArgument as Record<string, string>).value
        : null;
      const expectedValue = objectId.endsWith("-22")
        ? "Remove filter"
        : objectId.endsWith("-23")
          ? "Post title"
          : objectId.endsWith("-24")
            ? "please send the report"
            : objectId.endsWith("-25")
              ? "account-ending-1234"
              : null;
      expect(requestedValue).toBe(expectedValue);
      return {
        result: {
          value: {
            tag: objectId.endsWith("-22") || objectId.endsWith("-25")
              ? "SELECT"
              : objectId.endsWith("-26")
                ? "BUTTON"
                : "INPUT",
            role: objectId.endsWith("-22") || objectId.endsWith("-25")
              ? "combobox"
              : objectId.endsWith("-26")
                ? "button"
                : "textbox",
            text: objectId.endsWith("-26") ? "Submit order" : "Editor control",
            aria_label: objectId.endsWith("-26") ? "Submit order" : "Editor control",
            name: "editor-control",
            associated_labels: ["Editor control"],
            accessible_labels: ["Editor control"],
            requested_value: requestedValue,
            requested_option_label: objectId.endsWith("-25")
              ? "Delete account"
              : objectId.endsWith("-22")
                ? "Keep current filter"
                : null,
            form_action: "https://example.test/profile",
            form_method: "get",
          },
        },
      };
    };
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
    const pageRevision = await revisions.ensure(8);

    for (const action of [
      { kind: "select", ref: `r${pageRevision}-22`, value: "Remove filter" },
      { kind: "fill", ref: `r${pageRevision}-23`, text: "Post title" },
      { kind: "type", ref: `r${pageRevision}-24`, text: "please send the report" },
    ] as const) {
      const completed = await runtime.act(TASK_A, 8, pageRevision, [action]);
      expect(completed).toMatchObject({
        result: {
          tab_id: 8,
          page_revision: pageRevision,
          actions: [{ kind: action.kind, completed: true }],
        },
      });
      expect(completed.staged).toBeUndefined();
    }

    expect(
      debuggerCommands.filter(
        ({ method, params }) =>
          method === "Runtime.callFunctionOn" &&
          /this\.value=|dispatchEvent/.test(String(params.functionDeclaration)),
      ),
    ).toHaveLength(3);

    const destructiveSelection = await runtime.act(TASK_A, 8, pageRevision, [
      { kind: "select", ref: `r${pageRevision}-25`, value: "account-ending-1234" },
    ]);
    expect(destructiveSelection).toMatchObject({
      result: {
        tab_id: 8,
        page_revision: pageRevision,
        actions: [],
        staged_index: 0,
      },
      staged: {
        effect: expect.stringContaining("Delete account"),
        preview: { kind: "select" },
      },
    });

    const submitOrder = await runtime.act(TASK_A, 8, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-26` },
    ]);
    expect(submitOrder).toMatchObject({
      result: {
        tab_id: 8,
        page_revision: pageRevision,
        actions: [],
        staged_index: 0,
      },
      staged: {
        effect: expect.stringContaining("Submit order"),
        preview: { kind: "click" },
      },
    });

    const consequentialDispatches = debuggerCommands.filter(
      ({ method, params }) =>
        method === "Runtime.callFunctionOn" &&
        /this\.value=|dispatchEvent/.test(String(params.functionDeclaration)),
    );
    expect(consequentialDispatches).toHaveLength(3);
  });
  test("retains an approved popup review until Commit and clears an abandoned review", async () => {
    tabStore.set(7, { id: 7, windowId: 1, groupId: -1, active: false });
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
    const pageRevision = await revisions.ensure(7);
    const prepared = await runtime.act(TASK_A, 7, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);
    const nativeToken = prepared.staged?.native_token;
    if (typeof nativeToken !== "string") throw new Error("consequential action did not stage");

    await runtime.bindReview(TASK_A, {
      native_token: nativeToken,
      review_handle: "popup-review-handle",
      tab_id: 7,
    });
    expect(await runtime.reviewBinding("popup-review-handle")).toMatchObject({
      task_id: TASK_A,
      tab_id: 7,
    });
    expect(await runtime.approveReview("popup-review-handle")).toBe(true);
    expect((await readState()).stagedCommits[nativeToken]).toMatchObject({
      review_handle: "popup-review-handle",
      approved: true,
    });
    await expect(runtime.reviewBinding("popup-review-handle")).rejects.toMatchObject({
      code: "invalid_staged_token",
    });
    await expect(runtime.commit(TASK_A, { native_token: nativeToken })).resolves.toMatchObject({
      actions: [{ kind: "click", completed: true }],
    });
    expect((await readState()).stagedCommits[nativeToken]).toBeUndefined();

    const abandoned = await runtime.act(TASK_A, 7, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-23` },
    ]);
    const abandonedToken = abandoned.staged?.native_token;
    if (typeof abandonedToken !== "string") throw new Error("consequential action did not stage");
    await runtime.bindReview(TASK_A, {
      native_token: abandonedToken,
      review_handle: "popup-review-handle-abandoned",
      tab_id: 7,
    });
    expect(await runtime.abandonReview("popup-review-handle-abandoned")).toBe(true);
    await expect(runtime.stagedTabId(TASK_A, abandonedToken)).rejects.toMatchObject({
      code: "invalid_staged_token",
    });
  });
  test("preserves a concurrent human tab selection during a task click", async () => {
    tabStore.set(90, { id: 90, windowId: 1, groupId: -1, active: true });
    tabStore.set(7, { id: 7, windowId: 1, groupId: -1, active: false });
    tabStore.set(91, { id: 91, windowId: 1, groupId: -1, active: false });
    focusStealOnClickTabId = 91;
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
    const pageRevision = await revisions.ensure(7);
    const prepared = await runtime.act(TASK_A, 7, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);

    await runtime.commit(TASK_A, { native_token: prepared.staged?.native_token });

    expect(tabStore.get(90)?.active).toBe(false);
    expect(tabStore.get(91)?.active).toBe(true);
    expect(focusedWindowUpdates).toEqual([]);
  });

  test("correlates a background popup with its task source when Chrome reports the active tab as opener", async () => {
    const popupUrl = "https://example.test/popup";
    tabStore.set(90, { id: 90, windowId: 1, groupId: -1, active: true });
    tabStore.set(7, { id: 7, windowId: 1, groupId: -1, active: false });
    const adopted: Array<{ parentTabId: number; childTabId: number }> = [];
    debuggerCommandOverride = (method, params) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration === "function(){this.click()}") {
        for (const tab of tabStore.values()) {
          if (tab.windowId === 1) tab.active = false;
        }
        tabStore.set(91, {
          id: 91,
          windowId: 1,
          groupId: -1,
          active: true,
          openerTabId: 90,
          url: popupUrl,
        });
        emitDebuggerEvent(7, "Page.windowOpen", { url: popupUrl, userGesture: true });
      }
      return undefined;
    };
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(
      revisions,
      async () => undefined,
      () => undefined,
      async () => undefined,
      async () => undefined,
      async () => undefined,
      async (parentTabId, childTabId) => {
        adopted.push({ parentTabId, childTabId });
      },
    );
    const pageRevision = await revisions.ensure(7);
    const prepared = await runtime.act(TASK_A, 7, pageRevision, [
      { kind: "click", ref: `r${pageRevision}-22` },
    ]);

    await runtime.commit(TASK_A, { native_token: prepared.staged?.native_token });
    await waitForCondition(() => adopted.length === 1 && tabStore.get(90)?.active === true);

    expect(adopted).toEqual([{ parentTabId: 7, childTabId: 91 }]);
    expect(tabStore.get(90)?.active).toBe(true);
    expect(tabStore.get(91)?.active).toBe(false);
    expect(focusedWindowUpdates).toEqual([1]);
  });

  test("rejects dialog acceptance staging when no JavaScript dialog is open", async () => {
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
    const pageRevision = await revisions.ensure(12);

    await expect(runtime.act(TASK_A, 12, pageRevision, [{ kind: "dialog", decision: "accept" }])).rejects
      .toMatchObject({ code: "invalid_request" });
    expect(debuggerCalls).not.toContain("Page.handleJavaScriptDialog");
  });

  test("accepts a staged dialog only while the same dialog remains open", async () => {
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
    const pageRevision = await revisions.ensure(13);
    await runtime.snapshot(13, { mode: "accessibility" });
    emitDebuggerEvent(13, "Page.javascriptDialogOpening", {
      type: "prompt",
      message: "Enter the confirmation phrase",
      defaultPrompt: "draft",
    });

    const prepared = await runtime.act(TASK_A, 13, pageRevision, [
      { kind: "dialog", decision: "accept" },
    ]);
    const token = prepared.staged?.native_token;
    if (!token) throw new Error("expected staged dialog token");
    expect(prepared.staged?.dialog).toMatchObject({ generation: 1, fingerprint: expect.any(String) });

    await expect(runtime.commit(TASK_A, { native_token: token })).resolves.toMatchObject({
      actions: [{ kind: "dialog", completed: true }],
    });
    expect(
      debuggerCommands.findLast(({ method }) => method === "Page.handleJavaScriptDialog"),
    ).toEqual({
      method: "Page.handleJavaScriptDialog",
      params: { accept: true },
    });
  });

  test("invalidates a staged dialog token when the dialog is replaced", async () => {
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
    const pageRevision = await revisions.ensure(14);
    await runtime.snapshot(14, { mode: "accessibility" });
    emitDebuggerEvent(14, "Page.javascriptDialogOpening", {
      type: "confirm",
      message: "First confirmation",
    });
    const prepared = await runtime.act(TASK_A, 14, pageRevision, [
      { kind: "dialog", decision: "accept" },
    ]);
    const token = prepared.staged?.native_token;
    if (!token) throw new Error("expected staged dialog token");

    emitDebuggerEvent(14, "Page.javascriptDialogClosed");
    emitDebuggerEvent(14, "Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Replacement confirmation",
    });
    await waitForCondition(() => persisted[STATE_KEY] !== undefined);
    await waitForCondition(() => {
      const state = persisted[STATE_KEY] as { stagedCommits?: Record<string, unknown> };
      return state.stagedCommits?.[token] === undefined;
    });

    await expect(runtime.commit(TASK_A, { native_token: token })).rejects.toMatchObject({
      code: "invalid_staged_token",
    });
    expect(debuggerCalls).not.toContain("Page.handleJavaScriptDialog");
  });

  test("invalidates a staged dialog token when page revision changes", async () => {
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
    const pageRevision = await revisions.ensure(15);
    await runtime.snapshot(15, { mode: "accessibility" });
    emitDebuggerEvent(15, "Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Navigate away?",
    });
    const prepared = await runtime.act(TASK_A, 15, pageRevision, [
      { kind: "dialog", decision: "accept" },
    ]);
    const token = prepared.staged?.native_token;
    if (!token) throw new Error("expected staged dialog token");

    await revisions.markNavigation(15);
    expect((await readState()).stagedCommits[token]).toBeUndefined();
    await expect(runtime.commit(TASK_A, { native_token: token })).rejects.toMatchObject({
      code: "invalid_staged_token",
    });
    expect(debuggerCalls).not.toContain("Page.handleJavaScriptDialog");
  });

  test("invalidates a staged dialog token when its document identity changes", async () => {
    const revisions = new RevisionTracker();
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
    const pageRevision = await revisions.ensure(16);
    await runtime.snapshot(16, { mode: "accessibility" });
    emitDebuggerEvent(16, "Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Replace document?",
    });
    const prepared = await runtime.act(TASK_A, 16, pageRevision, [
      { kind: "dialog", decision: "accept" },
    ]);
    const token = prepared.staged?.native_token;
    if (!token) throw new Error("expected staged dialog token");

    await revisions.observeDocument(16, "backend:replacement", "replacement-loader");
    expect((await readState()).stagedCommits[token]).toBeUndefined();
    await expect(runtime.commit(TASK_A, { native_token: token })).rejects.toMatchObject({
      code: "invalid_staged_token",
    });
    expect(debuggerCalls).not.toContain("Page.handleJavaScriptDialog");
  });
  test("rejects and deletes an expired staged token", async () => {
    const revisions = new RevisionTracker();
    const events: string[] = [];
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, (event) => events.push(event), async () => undefined);
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
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
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
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
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
    const runtime = new StandardBrowserRuntime(revisions, async () => undefined, (event) => events.push(event), async () => undefined);
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

    const writesBeforeUnrelatedEvents = storageSetCount;
    const queriesBeforeUnrelatedEvents = tabQueryCount;
    for (const listener of tabCreatedListeners) {
      listener({ id: 900 });
      listener({ id: 901, openerTabId: 902 });
    }
    for (const listener of tabRemovedListeners) listener(900);
    for (const listener of tabUpdatedListeners) listener(900, { favIconUrl: "https://example.test/icon.png" });
    for (const listener of tabAttachedListeners) listener(900);
    for (const listener of tabDetachedListeners) listener(900);
    for (const listener of tabGroupRemovedListeners) listener({ id: 900 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await flushPromiseQueue();
    expect(storageSetCount).toBe(writesBeforeUnrelatedEvents);
    expect(tabQueryCount).toBe(queriesBeforeUnrelatedEvents);

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
    const historyDestinationUnverified = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6400",
      TASK_A,
      "browser_act",
      {
        tab_id: 100,
        expected_page_revision: 1,
        actions: [{ kind: "go_back" }],
      },
      currentOriginPolicy,
    );
    expect(historyDestinationUnverified).toMatchObject({
      outcome: "not_started",
      error: {
        code: "history_origin_unverified",
        recovery: expect.stringContaining("Navigate explicitly"),
      },
    });

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
        recovery: "Reload or reinstall AgentTab so Chrome restores its required permissions.",
      },
    });
    expect(debuggerCommands).toHaveLength(deniedBeforePermission);

    // Pause is logical state; the popup never mutates required Chrome permissions.
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

    const press = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6240",
      TASK_A,
      "browser_act",
      {
        tab_id: 100,
        expected_page_revision: 1,
        actions: [{ kind: "press", ref: "r1-22", key: "Enter" }],
      },
    );
    expect(press).toMatchObject({
      outcome: "not_started",
      error: { code: "invalid_request" },
    });
    expect(debuggerCommands).toHaveLength(deniedBeforePermission);


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

    expect(await sendPopupMessage({
      kind: "set_policy_profile",
      profile: "review_selected",
    })).toEqual({ profile: "review_selected" });
    expect((await readState()).policyProfile).toBe("review_selected");
    expect(port.posted).not.toContainEqual(expect.objectContaining({ event: "policy_changed" }));

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
          { kind: "type", ref: "r1-22", text: "after staged click" },
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
    const reviewHandle = "opaque-popup-review-handle";
    await expect(
      sendNativeCommand(
        "018f47b8-2f80-7c20-9c77-f8a38c9e6250",
        TASK_A,
        "commit_review_bind",
        { native_token: stagedToken, review_handle: reviewHandle, tab_id: 100 },
      ),
    ).resolves.toMatchObject({ outcome: "completed", result: { review_bound: true } });
    expect(await sendPopupMessage({ kind: "get_ui_state" })).toMatchObject({
      reviews: [{
        review_handle: reviewHandle,
        task_id: TASK_A,
        tab_id: 100,
      }],
    });
    const approval = sendPopupMessage({
      kind: "approve_popup_commit",
      review_handle: reviewHandle,
    });
    await waitForCondition(() =>
      port.posted.some(
        (message) =>
          isRecord(message) &&
          message.kind === "event" &&
          message.event === "popup_commit_approved" &&
          isRecord(message.payload) &&
          message.payload.review_handle === reviewHandle,
      ),
    );
    const approvalEvent = port.posted.findLast(
      (message) =>
        isRecord(message) &&
        message.kind === "event" &&
        message.event === "popup_commit_approved" &&
        isRecord(message.payload) &&
        message.payload.review_handle === reviewHandle,
    );
    if (!isRecord(approvalEvent) || typeof approvalEvent.event_id !== "string") {
      throw new Error("popup approval event is missing");
    }
    port.receive({
      protocol: "agenttab.native",
      version: 1,
      kind: "event_ack",
      event: "popup_commit_approved",
      event_id: approvalEvent.event_id,
      outcome: "completed",
      result: { approved: true },
    });
    await expect(approval).resolves.toEqual({ approved: true });
    expect((await readState()).stagedCommits[stagedToken]).toMatchObject({
      review_handle: reviewHandle,
      approved: true,
    });
    expect(await sendPopupMessage({ kind: "get_ui_state" })).toMatchObject({ reviews: [] });
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

    expect(await sendPopupMessage({ kind: "set_policy_profile", profile: "strict" }))
      .toEqual({ profile: "strict" });
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
    const closingHandoff = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6241",
      TASK_A,
      "browser_handoff",
      {
        tab_id: 100,
        expected_page_revision: 1,
        prompt: "Finish before closing",
        completion: { kind: "manual_done" },
      },
    );
    expect(closingHandoff).toMatchObject({ outcome: "needs_user" });
    let handoffClearPostedAfterTabRemoval = false;
    nativePostProbe = (message) => {
      if (
        isRecord(message) &&
        message.kind === "event" &&
        message.event === "handoff_changed" &&
        typeof message.event_id === "string" &&
        isRecord(message.payload) &&
        message.payload.active === false
      ) {
        handoffClearPostedAfterTabRemoval = removedTabIds.includes(100);
        port.receive({
          protocol: "agenttab.native",
          version: 1,
          kind: "event_ack",
          event: "handoff_changed",
          event_id: message.event_id,
        });
      }
    };
    let taskDeletedBeforeRemove = false;
    tabRemovalProbe = async () => {
      taskDeletedBeforeRemove = (await readState()).tasks[TASK_A] === undefined;
    };
    const closedByHost = await sendNativeCloseTask(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6234",
      TASK_A,
    );
    expect(closedByHost).toMatchObject({
      outcome: "completed",
      result: { task_id: TASK_A, closed_tab_ids: [100] },
    });
    expect(removedTabIds).toContain(100);
    expect(handoffClearPostedAfterTabRemoval).toBe(true);
    for (let attempt = 0; attempt < 20 && (await readState()).handoff.active; attempt += 1) {
      await Promise.resolve();
    }
    expect((await readState()).handoff).toEqual({ active: false });
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
    expect(taskDeletedBeforeRemove).toBe(true);
    expect(await sendPopupMessage({ kind: "automation_revocation_state" })).toEqual({ generation: 0 });
    debuggerAttachedTabIds.add(101);
    await mutateState((state) => {
      state.automationCleanup.tabIds = [101];
    });
    const detachCountBeforeRevocation = debuggerCalls.filter((call) => call === "detach").length;
    debuggerDetachFailures = 2;
    automationPermission = false;
    for (const listener of permissionRemovedListeners) listener({ permissions: ["scripting"] });
    const tabsDeniedSynchronously = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6236",
      TASK_A,
      "browser_tabs",
      {},
    );
    expect(tabsDeniedSynchronously).toMatchObject({
      outcome: "not_started",
      error: { code: "permissions_required" },
    });
    await waitForCondition(
      () => debuggerCalls.filter((call) => call === "detach").length === detachCountBeforeRevocation + 1,
    );
    expect(await sendPopupMessage({ kind: "automation_revocation_state" })).toEqual({ generation: 0 });
    const cleanupAlarm = alarmCreates.find((alarm) => alarm.name === "agenttabAutomationCleanup");
    expect(cleanupAlarm).toBeDefined();
    if (!cleanupAlarm) throw new Error("cleanup alarm was not scheduled");
    automationPermission = true;
    for (const listener of permissionAddedListeners) listener({ permissions: ["scripting"] });
    await waitForCondition(
      () => debuggerCalls.filter((call) => call === "detach").length === detachCountBeforeRevocation + 2,
    );
    expect(await sendPopupMessage({ kind: "get_ui_state" })).toMatchObject({
      automation_enabled: false,
    });
    expect((await readState()).automationCleanup).toMatchObject({
      pending: true,
      generation: 0,
    });
    const deniedDuringRegrantCleanup = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6301",
      TASK_A,
      "browser_tabs",
      {},
    );
    expect(deniedDuringRegrantCleanup).toMatchObject({
      outcome: "not_started",
      error: { code: "permissions_required" },
    });
    for (const listener of alarmListeners) listener({ name: cleanupAlarm.name });
    await waitForCondition(
      () => debuggerCalls.filter((call) => call === "detach").length === detachCountBeforeRevocation + 3,
    );
    await waitForCondition(() => alarmClears.includes(cleanupAlarm.name));
    expect(await sendPopupMessage({ kind: "automation_revocation_state" })).toEqual({ generation: 1 });
    expect(await sendPopupMessage({ kind: "get_ui_state" })).toMatchObject({
      automation_enabled: true,
    });
    expect((await readState()).automationCleanup).toEqual({
      pending: false,
      tabIds: [],
      generation: 1,
      epoch: 1,
    });
    expect(await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6302",
      TASK_A,
      "browser_tabs",
      {},
    )).toMatchObject({ outcome: "completed" });

    const reopened = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6303",
      TASK_B,
      "browser_open",
      { mode: "create", url: "https://example.test/moved" },
    );
    expect(reopened).toMatchObject({
      outcome: "completed",
      result: { tab_id: 101, group_id: 51 },
    });
    expect(await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6304",
      TASK_B,
      "browser_snapshot",
      { tab_id: 101, mode: "accessibility" },
    )).toMatchObject({ outcome: "completed" });
    expect((await readState()).automationCleanup.tabIds).toEqual([101]);

    const restricted = await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6305",
      TASK_C,
      "browser_open",
      { mode: "create", url: "https://chromewebstore.google.com/devconsole/example" },
    );
    expect(restricted).toMatchObject({
      outcome: "completed",
      result: {
        tab_id: 102,
        automation_route: "tab_only",
        route_reason: "browser_restricted_origin",
      },
    });
    if (!isRecord(restricted.result) || typeof restricted.result.page_revision !== "number") {
      throw new Error("restricted task tab did not return a page revision");
    }
    const restrictedPageRevision = restricted.result.page_revision;
    expect(await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6306",
      TASK_C,
      "browser_tabs",
      {},
    )).toMatchObject({
      outcome: "completed",
      result: {
        tabs: [{
          tab_id: 102,
          automation_route: "tab_only",
          route_reason: "browser_restricted_origin",
        }],
      },
    });
    const debuggerCommandsBeforeRestrictedSnapshot = debuggerCommands.length;
    const scriptingCallsBeforeRestrictedSnapshot = scriptingCallCount;
    expect(await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6307",
      TASK_C,
      "browser_snapshot",
      { tab_id: 102, mode: "text" },
    )).toMatchObject({
      outcome: "not_started",
      error: {
        code: "browser_restricted_origin",
        recovery: expect.stringContaining("Do not retry"),
      },
    });
    expect(debuggerCommands).toHaveLength(debuggerCommandsBeforeRestrictedSnapshot);
    expect(scriptingCallCount).toBe(scriptingCallsBeforeRestrictedSnapshot);
    expect(await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6308",
      TASK_C,
      "browser_handoff",
      {
        tab_id: 102,
        expected_page_revision: restrictedPageRevision,
        prompt: "Complete the browser-owned form",
        completion: { kind: "selector", value: "#complete" },
        timeout_ms: 1_000,
      },
    )).toMatchObject({
      outcome: "not_started",
      error: { code: "browser_restricted_origin" },
    });
    expect((await readState()).handoff).toEqual({ active: false });
    expect(scriptingCallCount).toBe(scriptingCallsBeforeRestrictedSnapshot);
    const restrictedTab = tabStore.get(102);
    if (!restrictedTab) throw new Error("restricted task tab is unavailable");
    restrictedTab.url = "chrome://settings/";
    expect(await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6309",
      TASK_C,
      "browser_snapshot",
      { tab_id: 102, mode: "text" },
      { tab_id: 102, allowed_origins: [], denied_origins: [] },
    )).toMatchObject({
      outcome: "not_started",
      error: { code: "browser_restricted_origin" },
    });
    expect(debuggerCommands).toHaveLength(debuggerCommandsBeforeRestrictedSnapshot);
    expect(scriptingCallCount).toBe(scriptingCallsBeforeRestrictedSnapshot);
    expect(await sendNativeCommand(
      "018f47b8-2f80-7c20-9c77-f8a38c9e6310",
      TASK_C,
      "browser_act",
      {
        tab_id: 102,
        expected_page_revision: restrictedPageRevision,
        actions: [{ kind: "navigate", url: "https://example.test/supported" }],
      },
    )).toMatchObject({ outcome: "completed" });
    const detachCountBeforeMove = debuggerCalls.filter((call) => call === "detach").length;
    const movedTab = tabStore.get(101);
    if (!movedTab) throw new Error("task tab for move test is unavailable");
    movedTab.groupId = 99;
    for (const listener of tabUpdatedListeners) listener(101, { groupId: 99 });
    await waitForCondition(
      () => debuggerCalls.filter((call) => call === "detach").length === detachCountBeforeMove + 1,
    );
    expect(debuggerAttachedTabIds.has(101)).toBe(false);
    expect((await readState()).automationCleanup.tabIds).toEqual([]);
    expect((await readState()).tasks[TASK_B]).toMatchObject({ groupId: null, tabIds: [] });
  });
});

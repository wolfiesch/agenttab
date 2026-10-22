import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { RECONNECT_ALARM } from "../src/native";
import { ProfileRuntime } from "../src/profile";
import { NATIVE_PROTOCOL, parseCommand, PROTOCOL_VERSION } from "../src/protocol";
import { mutateState, readState, resetStateForTest } from "../src/storage";
import { isRecord } from "../src/type-guards";

const TASK_A = "018f47b8-2f80-7c20-9c77-f8a38c9e621e";
const TASK_B = "018f47b8-2f80-7c20-9c77-f8a38c9e621f";
const CONNECTION_ID = "018f47b8-2f80-7c20-9c77-f8a38c9e6220";
const EXTENSION_ID = "agenttab-profile-test-extension";

// Private profile data that must only ever leave through a read operation's result.
const PRIVATE_TITLE = "Private Bank Login";
const PRIVATE_URL = "https://bank.private.example/account?session=s3cret";
const PRIVATE_FOLDER = "Secret Medical Folder";
const PRIVATE_HISTORY_QUERY = "symptom lookup";
const PRIVATE_HISTORY_URL = "https://health.private.example/results";
const PRIVATE_SESSION_TITLE = "Closed Private Tab";
const PRIVATE_SESSION_URL = "https://mail.private.example/inbox";
const PRIVATE_DOWNLOAD = "lab-results-confidential.pdf";
const PRIVATE_DOWNLOAD_URL = "https://files.private.example/lab-results-confidential.pdf";
const PRIVATE_STRINGS = [
  PRIVATE_TITLE,
  PRIVATE_URL,
  PRIVATE_FOLDER,
  PRIVATE_HISTORY_QUERY,
  PRIVATE_HISTORY_URL,
  PRIVATE_SESSION_TITLE,
  PRIVATE_SESSION_URL,
  PRIVATE_DOWNLOAD,
  PRIVATE_DOWNLOAD_URL,
];

interface FakeBookmark {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  dateAdded?: number;
  unmodifiable?: "managed";
}

interface FakeTab {
  id: number;
  windowId: number;
  groupId: number;
  active: boolean;
  url: string;
  status: string;
}

interface ApiCall {
  api: string;
  args: unknown[];
}

type Listener = (...args: unknown[]) => unknown;

let bookmarks: Map<string, FakeBookmark>;
let children: Map<string, string[]>;
let nextBookmarkId: number;
let calls: ApiCall[];
let historyItems: chrome.history.HistoryItem[];
let recentSessions: chrome.sessions.Session[];
let deviceSessions: chrome.sessions.Device[];
let downloadItems: Map<number, chrome.downloads.DownloadItem>;
let tabStore: Map<number, FakeTab>;
let nextTabId: number;
let nextGroupId: number;
let automationPermission: boolean;
let persistedLocal: Record<string, unknown>;
let persistedSession: Record<string, unknown>;
let nativePort: MockNativePort | null = null;
// Listener registries outlive per-test data resets: the background entrypoint registers once.
const listeners = new Map<string, Listener[]>();
const alarmClears: string[] = [];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function record(api: string, ...args: unknown[]): void {
  calls.push({ api, args: clone(args) });
}

function callsTo(api: string): ApiCall[] {
  return calls.filter((call) => call.api === api);
}

function profileApiCalls(): ApiCall[] {
  return calls.filter((call) => /^(bookmarks|history|sessions|downloads)\./.test(call.api));
}

function chromeEvent(name: string) {
  return {
    addListener(listener: Listener) {
      const registered = listeners.get(name) ?? [];
      registered.push(listener);
      listeners.set(name, registered);
    },
    removeListener(listener: Listener) {
      listeners.set(name, (listeners.get(name) ?? []).filter((candidate) => candidate !== listener));
    },
  };
}

function emit(name: string, ...args: unknown[]): void {
  for (const listener of listeners.get(name) ?? []) listener(...args);
}

function addBookmark(node: FakeBookmark): void {
  bookmarks.set(node.id, node);
  if (node.parentId !== undefined) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  if (node.url === undefined && !children.has(node.id)) children.set(node.id, []);
}

function bookmarkView(id: string): chrome.bookmarks.BookmarkTreeNode {
  const node = bookmarks.get(id);
  if (!node) throw new Error("Can't find bookmark for id.");
  const index = node.parentId === undefined ? undefined : (children.get(node.parentId) ?? []).indexOf(id);
  return clone({
    id: node.id,
    title: node.title,
    syncing: false,
    ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
    ...(index !== undefined ? { index } : {}),
    ...(node.url !== undefined ? { url: node.url } : {}),
    ...(node.dateAdded !== undefined ? { dateAdded: node.dateAdded } : {}),
    ...(node.unmodifiable !== undefined ? { unmodifiable: node.unmodifiable } : {}),
  }) as chrome.bookmarks.BookmarkTreeNode;
}

function bookmarkSubtree(id: string): chrome.bookmarks.BookmarkTreeNode {
  const view = bookmarkView(id);
  if (view.url !== undefined) return view;
  return { ...view, children: (children.get(id) ?? []).map(bookmarkSubtree) };
}

function detachBookmark(id: string): void {
  const node = bookmarks.get(id);
  if (node?.parentId === undefined) return;
  children.set(node.parentId, (children.get(node.parentId) ?? []).filter((candidate) => candidate !== id));
}

function seedBookmarks(): void {
  bookmarks = new Map();
  children = new Map();
  nextBookmarkId = 100;
  addBookmark({ id: "0", title: "" });
  addBookmark({ id: "1", parentId: "0", title: "Bookmarks bar" });
  addBookmark({ id: "2", parentId: "0", title: "Other bookmarks" });
  addBookmark({ id: "10", parentId: "1", title: PRIVATE_TITLE, url: PRIVATE_URL, dateAdded: 1_700_000_000_000 });
  addBookmark({ id: "20", parentId: "1", title: PRIVATE_FOLDER });
  addBookmark({ id: "21", parentId: "20", title: "Nested bookmark", url: "https://nested.example/" });
  addBookmark({ id: "22", parentId: "20", title: "Nested folder" });
  addBookmark({ id: "30", parentId: "2", title: "Empty folder" });
  addBookmark({ id: "40", parentId: "2", title: "Managed", unmodifiable: "managed" });
}

function sessionTab(sessionId: string, url: string, title = "Tab"): chrome.tabs.Tab {
  return { sessionId, url, title, index: 0, pinned: false, highlighted: false, windowId: 1, active: false, incognito: false, selected: false, discarded: false, autoDiscardable: true, groupId: -1, frozen: false } as chrome.tabs.Tab;
}

function windowSession(sessionId: string, urls: string[]): chrome.sessions.Session {
  return {
    lastModified: 1_700_000_100,
    window: {
      sessionId,
      tabs: urls.map((url, index) => sessionTab(`${sessionId}-${index}`, url)),
    } as chrome.windows.Window,
  };
}

function download(id: number, overrides: Partial<chrome.downloads.DownloadItem> = {}): chrome.downloads.DownloadItem {
  return {
    id,
    filename: PRIVATE_DOWNLOAD,
    url: PRIVATE_DOWNLOAD_URL,
    finalUrl: PRIVATE_DOWNLOAD_URL,
    state: "in_progress",
    paused: false,
    bytesReceived: 10,
    totalBytes: 100,
    startTime: "2026-01-02T03:04:05.000Z",
    mime: "application/pdf",
    ...overrides,
  } as chrome.downloads.DownloadItem;
}

function resetFakeData(): void {
  seedBookmarks();
  calls = [];
  historyItems = [
    { id: "h1", url: PRIVATE_HISTORY_URL, title: "Results", lastVisitTime: 1_700_000_000_000, visitCount: 3, typedCount: 1 },
  ];
  recentSessions = [
    { lastModified: 1_700_000_000, tab: sessionTab("tab-1", PRIVATE_SESSION_URL, PRIVATE_SESSION_TITLE) },
    windowSession("win-1", [
      "https://one.example/",
      "javascript:alert(document.cookie)",
      "http://two.example/",
      "chrome://settings/",
      "file:///etc/hosts",
      "",
      "data:text/html,<b>x</b>",
      "HTTPS://three.example/",
    ]),
    windowSession("win-big", Array.from({ length: 30 }, (_, index) => `https://many.example/${index}`)),
  ];
  deviceSessions = [
    {
      deviceName: "Laptop",
      sessions: [{ lastModified: 1_700_000_200, tab: sessionTab("device-tab-1", "https://synced.example/page", "Synced") }],
    },
  ];
  downloadItems = new Map([
    [7, download(7)],
    [8, download(8, { state: "complete", paused: false, finalUrl: "https://cdn.example/redirected.pdf", endTime: "2026-01-02T03:05:05.000Z" })],
  ]);
  tabStore = new Map([[1, { id: 1, windowId: 1, groupId: -1, active: true, url: "https://human.example/", status: "complete" }]]);
  nextTabId = 500;
  nextGroupId = 60;
  automationPermission = true;
  persistedLocal = {};
  persistedSession = {};
}

class MockNativePort {
  readonly posted: Array<Record<string, unknown>> = [];
  private readonly messageListeners: Listener[] = [];
  private readonly disconnectListeners: Listener[] = [];
  readonly onMessage = { addListener: (listener: Listener) => void this.messageListeners.push(listener) };
  readonly onDisconnect = { addListener: (listener: Listener) => void this.disconnectListeners.push(listener) };

  postMessage(message: unknown): void {
    if (isRecord(message)) this.posted.push(clone(message));
  }

  disconnect(): void {
    for (const listener of this.disconnectListeners) listener();
  }

  receive(message: unknown): void {
    for (const listener of this.messageListeners) listener(clone(message));
  }
}

function storageArea(store: () => Record<string, unknown>) {
  return {
    async get(keys: string | string[] | null) {
      if (keys === null) return clone(store());
      const selected = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(selected.filter((key) => key in store()).map((key) => [key, clone(store()[key])]));
    },
    async set(values: Record<string, unknown>) {
      Object.assign(store(), clone(values));
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store()[key];
    },
  };
}

function installChrome(): void {
  const createTab = (url: string, active: boolean, windowId: number): FakeTab => {
    if (active) {
      for (const tab of tabStore.values()) if (tab.windowId === windowId) tab.active = false;
    }
    const tab = { id: nextTabId++, windowId, groupId: -1, active, url, status: "complete" };
    tabStore.set(tab.id, tab);
    return tab;
  };
  Object.assign(globalThis, {
    chrome: {
      storage: {
        local: storageArea(() => persistedLocal),
        session: storageArea(() => persistedSession),
        onChanged: chromeEvent("storage.onChanged"),
      },
      bookmarks: {
        async get(id: string) {
          record("bookmarks.get", id);
          return [bookmarkView(id)];
        },
        async getSubTree(id: string) {
          record("bookmarks.getSubTree", id);
          return [bookmarkSubtree(id)];
        },
        async getChildren(id: string) {
          record("bookmarks.getChildren", id);
          if (!bookmarks.has(id)) throw new Error("Can't find parent bookmark for id.");
          return (children.get(id) ?? []).map(bookmarkView);
        },
        async search(query: string) {
          record("bookmarks.search", query);
          return [...bookmarks.values()]
            .filter((node) => node.id !== "0" && (node.title.includes(query) || node.url?.includes(query)))
            .map((node) => bookmarkView(node.id));
        },
        async update(id: string, changes: { title?: string; url?: string }) {
          record("bookmarks.update", id, changes);
          const node = bookmarks.get(id);
          if (!node) throw new Error("Can't find bookmark for id.");
          Object.assign(node, changes);
          return bookmarkView(id);
        },
        async create(details: { parentId: string; title?: string; url?: string; index?: number }) {
          record("bookmarks.create", details);
          const id = String(nextBookmarkId++);
          addBookmark({ id, parentId: details.parentId, title: details.title ?? "", ...(details.url !== undefined ? { url: details.url } : {}) });
          if (details.index !== undefined) {
            const siblings = (children.get(details.parentId) ?? []).filter((candidate) => candidate !== id);
            siblings.splice(details.index, 0, id);
            children.set(details.parentId, siblings);
          }
          return bookmarkView(id);
        },
        async move(id: string, destination: { parentId: string; index?: number }) {
          record("bookmarks.move", id, destination);
          const node = bookmarks.get(id);
          if (!node) throw new Error("Can't find bookmark for id.");
          detachBookmark(id);
          node.parentId = destination.parentId;
          const siblings = children.get(destination.parentId) ?? [];
          siblings.splice(destination.index ?? siblings.length, 0, id);
          children.set(destination.parentId, siblings);
          return bookmarkView(id);
        },
        async remove(id: string) {
          record("bookmarks.remove", id);
          if (!bookmarks.has(id)) throw new Error("Can't find bookmark for id.");
          detachBookmark(id);
          bookmarks.delete(id);
        },
      },
      history: {
        async search(query: chrome.history.HistoryQuery) {
          record("history.search", query);
          return clone(historyItems);
        },
      },
      sessions: {
        MAX_SESSION_RESULTS: 25,
        async getRecentlyClosed(filter?: chrome.sessions.Filter) {
          record("sessions.getRecentlyClosed", filter);
          return clone(recentSessions);
        },
        async getDevices(filter?: chrome.sessions.Filter) {
          record("sessions.getDevices", filter);
          return clone(deviceSessions);
        },
        async restore(sessionId?: string) {
          record("sessions.restore", sessionId);
          throw new Error("sessions.restore activates the restored entry and must not be called");
        },
      },
      downloads: {
        async search(query: chrome.downloads.DownloadQuery) {
          record("downloads.search", query);
          if (typeof query.id === "number") {
            const item = downloadItems.get(query.id);
            return item ? [clone(item)] : [];
          }
          return [...downloadItems.values()].map(clone);
        },
        async cancel(id: number) {
          record("downloads.cancel", id);
          const item = downloadItems.get(id);
          if (item) Object.assign(item, { state: "interrupted", error: "USER_CANCELED", paused: false });
        },
        async pause(id: number) {
          record("downloads.pause", id);
          const item = downloadItems.get(id);
          if (item) item.paused = true;
        },
        async resume(id: number) {
          record("downloads.resume", id);
          const item = downloadItems.get(id);
          if (item) item.paused = false;
        },
      },
      debugger: {
        onDetach: chromeEvent("debugger.onDetach"),
        onEvent: chromeEvent("debugger.onEvent"),
        async getTargets() { return []; },
        async attach() { record("debugger.attach"); },
        async detach() {},
        async sendCommand() { return {}; },
      },
      scripting: {
        async executeScript() {
          record("scripting.executeScript");
          return [{ result: true }];
        },
      },
      tabs: {
        onCreated: chromeEvent("tabs.onCreated"),
        onRemoved: chromeEvent("tabs.onRemoved"),
        onUpdated: chromeEvent("tabs.onUpdated"),
        onAttached: chromeEvent("tabs.onAttached"),
        onDetached: chromeEvent("tabs.onDetached"),
        SPLIT_VIEW_ID_NONE: -1,
        async get(tabId: number) {
          const tab = tabStore.get(tabId);
          if (!tab) throw new Error(`No tab with id: ${tabId}.`);
          return clone(tab);
        },
        async query(query: Record<string, unknown>) {
          let tabs = [...tabStore.values()];
          if (query.active === true) tabs = tabs.filter((tab) => tab.active);
          return clone(tabs);
        },
        async create(options: Record<string, unknown>) {
          record("tabs.create", options);
          const tab = createTab(
            typeof options.url === "string" ? options.url : "about:blank",
            options.active !== false,
            typeof options.windowId === "number" ? options.windowId : 1,
          );
          queueMicrotask(() => emit("tabs.onUpdated", tab.id, { status: "complete" }, clone(tab)));
          return clone(tab);
        },
        async update(tabId: number, changes: Record<string, unknown>) {
          record("tabs.update", tabId, changes);
          const tab = tabStore.get(tabId);
          if (tab) Object.assign(tab, changes);
          return clone(tab);
        },
        async group(options: { tabIds: number | number[]; groupId?: number }) {
          const groupId = options.groupId ?? nextGroupId++;
          for (const tabId of Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds]) {
            const tab = tabStore.get(tabId);
            if (tab) tab.groupId = groupId;
          }
          return groupId;
        },
        async ungroup() {},
        async move() { return []; },
        async remove(tabIds: number | number[]) {
          for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) tabStore.delete(tabId);
        },
        async goBack() {},
        async goForward() {},
        async reload() {},
      },
      windows: {
        async getAll() {
          return [{ id: 1, type: "normal", tabs: clone([...tabStore.values()].filter((tab) => tab.windowId === 1)) }];
        },
        async create(options: Record<string, unknown>) {
          record("windows.create", options);
          return { id: 2, tabs: [clone(createTab(String(options.url ?? "about:blank"), options.focused === true, 2))] };
        },
        async update(windowId: number, changes: Record<string, unknown>) {
          record("windows.update", windowId, changes);
          return { id: windowId };
        },
        async remove() {},
      },
      tabGroups: {
        async update() {},
        onRemoved: chromeEvent("tabGroups.onRemoved"),
      },
      alarms: {
        create() {},
        async clear(name: string) {
          alarmClears.push(name);
          return true;
        },
        onAlarm: chromeEvent("alarms.onAlarm"),
      },
      action: {
        async setBadgeText() {},
        async setBadgeBackgroundColor() {},
        async openPopup() {},
      },
      permissions: {
        async contains() { return automationPermission; },
        async request() { return automationPermission; },
        onAdded: chromeEvent("permissions.onAdded"),
        onRemoved: chromeEvent("permissions.onRemoved"),
      },
      runtime: {
        id: EXTENSION_ID,
        getManifest() { return { version: "2.0.0" }; },
        connectNative() {
          if (!nativePort) throw new Error("native host unavailable");
          return nativePort;
        },
        async sendMessage() { return {}; },
        onMessage: chromeEvent("runtime.onMessage"),
        onStartup: chromeEvent("runtime.onStartup"),
        onInstalled: chromeEvent("runtime.onInstalled"),
      },
    },
  });
}

function profileCommand(params: Record<string, unknown>): unknown {
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "command",
    request_id: TASK_A,
    connection_id: CONNECTION_ID,
    task_id: TASK_A,
    method: "browser_profile",
    params,
  };
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
let consoleSpies: Array<Mock<(...args: unknown[]) => void>> = [];

function spyOnConsole(): void {
  consoleSpies = CONSOLE_METHODS.map((method) => spyOn(console, method).mockImplementation(() => undefined));
}

function restoreConsole(): void {
  for (const spy of consoleSpies) spy.mockRestore();
  consoleSpies = [];
}

function consoleOutput(): string {
  return consoleSpies
    .flatMap((spy) => spy.mock.calls)
    .map((args) => args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack ?? ""}` : JSON.stringify(arg) ?? String(arg))).join(" "))
    .join("\n");
}

function expectNoPrivateData(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of PRIVATE_STRINGS) expect(text).not.toContain(secret);
}

installChrome();

function newRuntime(): { runtime: ProfileRuntime; opened: Array<{ taskId: string; url: string }> } {
  const opened: Array<{ taskId: string; url: string }> = [];
  const runtime = new ProfileRuntime(async (taskId, url) => {
    opened.push({ taskId, url });
    return { tab_id: 900 + opened.length, page_revision: 1 };
  });
  return { runtime, opened };
}

describe("browser_profile parameter validation", () => {
  const accepts = (params: Record<string, unknown>) =>
    expect(() => parseCommand(profileCommand(params))).not.toThrow();
  const rejects = (params: Record<string, unknown>) =>
    expect(() => parseCommand(profileCommand(params))).toThrow();

  test("accepts a well-formed request for every operation", () => {
    accepts({ operation: "bookmarks_search", query: "bank", limit: 100 });
    accepts({ operation: "bookmarks_tree" });
    accepts({ operation: "bookmarks_tree", folder_id: "1", depth: 5 });
    accepts({ operation: "bookmarks_update", id: "10", title: "" });
    accepts({ operation: "bookmarks_update", id: "10", url: "https://example.test/" });
    accepts({ operation: "bookmarks_create", parent_id: "1", title: "Folder" });
    accepts({ operation: "bookmarks_create", parent_id: "1", title: "Page", url: "chrome://settings/", index: 0 });
    accepts({ operation: "bookmarks_move", id: "10", parent_id: "2", index: 100_000 });
    accepts({ operation: "bookmarks_remove", id: "10" });
    accepts({ operation: "history_search", text: "", limit: 1 });
    accepts({ operation: "history_search", text: "x", limit: 100, start_time: 0, end_time: 0 });
    accepts({ operation: "sessions_recent", limit: 25 });
    accepts({ operation: "sessions_devices" });
    accepts({ operation: "sessions_restore", session_id: "win-1" });
    accepts({ operation: "downloads_search", query: "report", state: "complete", limit: 100 });
    accepts({ operation: "downloads_cancel", id: 0 });
    accepts({ operation: "downloads_pause", id: 7 });
    accepts({ operation: "downloads_resume", id: 7 });
  });

  test("rejects non-numeric, empty, and non-string bookmark ids", () => {
    for (const id of ["", "abc", "-1", "1.5", "1e3", " 10", "10 ", "123456789012345678901", 10, null]) {
      rejects({ operation: "bookmarks_update", id, title: "x" });
      rejects({ operation: "bookmarks_remove", id });
      rejects({ operation: "bookmarks_move", id, parent_id: "1" });
      rejects({ operation: "bookmarks_move", id: "10", parent_id: id });
      rejects({ operation: "bookmarks_create", parent_id: id, title: "x" });
      rejects({ operation: "bookmarks_tree", folder_id: id });
    }
  });

  test("rejects script, data, and other non-navigable bookmark URLs", () => {
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "about:blank",
      "https://",
      "https://exa mple.test/",
      "",
      `https://example.test/${"a".repeat(2_048)}`,
    ]) {
      rejects({ operation: "bookmarks_update", id: "10", url });
      rejects({ operation: "bookmarks_create", parent_id: "1", title: "x", url });
    }
  });

  test("rejects out-of-range limits, depths, indexes, and times", () => {
    for (const limit of [0, -1, 1.5, 101, "10"]) {
      rejects({ operation: "bookmarks_search", query: "x", limit });
      rejects({ operation: "history_search", text: "x", limit });
      rejects({ operation: "downloads_search", limit });
    }
    for (const limit of [0, 26]) {
      rejects({ operation: "sessions_recent", limit });
      rejects({ operation: "sessions_devices", limit });
    }
    rejects({ operation: "history_search", text: "x" });
    rejects({ operation: "history_search", text: "x", limit: 5, start_time: -1 });
    rejects({ operation: "history_search", text: "x", limit: 5, end_time: Number.POSITIVE_INFINITY });
    rejects({ operation: "history_search", text: "x", limit: 5, start_time: 10, end_time: 5 });
    rejects({ operation: "history_search", text: "x".repeat(257), limit: 5 });
    for (const depth of [0, 6, 2.5]) rejects({ operation: "bookmarks_tree", depth });
    for (const index of [-1, 100_001, 0.5]) {
      rejects({ operation: "bookmarks_create", parent_id: "1", title: "x", index });
      rejects({ operation: "bookmarks_move", id: "10", parent_id: "1", index });
    }
    for (const id of [-1, 1.5, "7", null]) rejects({ operation: "downloads_pause", id });
  });

  test("rejects missing fields, unknown fields, and unsupported operations", () => {
    rejects({ operation: "bookmarks_search" });
    rejects({ operation: "bookmarks_search", query: "" });
    rejects({ operation: "bookmarks_update", id: "10" });
    rejects({ operation: "bookmarks_update", id: "10", title: "x", parent_id: "1" });
    rejects({ operation: "bookmarks_remove", id: "10", force: true });
    rejects({ operation: "bookmarks_create", parent_id: "1" });
    rejects({ operation: "sessions_restore", session_id: "" });
    rejects({ operation: "sessions_restore", session_id: "win 1" });
    rejects({ operation: "downloads_search", state: "paused" });
    rejects({ operation: "downloads_open", id: 7 });
    rejects({ operation: "bookmarks_remove_tree", id: "20" });
    rejects({ id: "10" });
  });
});

describe("bookmark operations", () => {
  let runtime: ProfileRuntime;

  beforeEach(() => {
    resetFakeData();
    resetStateForTest();
    ({ runtime } = newRuntime());
  });

  test("bookmarks_search returns matching nodes up to the limit", async () => {
    const { result } = await runtime.run(TASK_A, { operation: "bookmarks_search", query: "Nested", limit: 1 });
    expect(callsTo("bookmarks.search")).toEqual([{ api: "bookmarks.search", args: ["Nested"] }]);
    expect(result).toMatchObject({ operation: "bookmarks_search", count: 1, truncated: true });
    expect(result.bookmarks).toEqual([expect.objectContaining({ id: "21", kind: "bookmark", url: "https://nested.example/" })]);
  });

  test("bookmarks_tree defaults to the root at depth 1 and summarizes deeper folders", async () => {
    const { result } = await runtime.run(TASK_A, { operation: "bookmarks_tree" });
    expect(callsTo("bookmarks.getSubTree")[0]?.args).toEqual(["0"]);
    expect(result).toEqual({
      operation: "bookmarks_tree",
      node_count: 3,
      truncated: false,
      root: {
        id: "0",
        title: "",
        kind: "folder",
        child_count: 2,
        children: [
          { id: "1", parent_id: "0", index: 0, title: "Bookmarks bar", kind: "folder", child_count: 2 },
          { id: "2", parent_id: "0", index: 1, title: "Other bookmarks", kind: "folder", child_count: 2 },
        ],
      },
    });
  });

  test("bookmarks_tree reports a missing folder", async () => {
    await expect(runtime.run(TASK_A, { operation: "bookmarks_tree", folder_id: "999" })).rejects.toMatchObject({
      code: "bookmark_not_found",
    });
  });

  test("bookmarks_update passes only the requested fields to Chrome", async () => {
    const titled = await runtime.run(TASK_A, { operation: "bookmarks_update", id: "10", title: "Renamed" });
    const both = await runtime.run(TASK_A, { operation: "bookmarks_update", id: "10", title: "", url: "https://new.example/" });
    expect(callsTo("bookmarks.update")).toEqual([
      { api: "bookmarks.update", args: ["10", { title: "Renamed" }] },
      { api: "bookmarks.update", args: ["10", { title: "", url: "https://new.example/" }] },
    ]);
    expect(titled.result).toEqual({ operation: "bookmarks_update", id: "10", updated: ["title"] });
    expect(both.result).toEqual({ operation: "bookmarks_update", id: "10", updated: ["title", "url"] });
  });

  test("bookmarks_update refuses folder URLs, roots, managed nodes, and missing ids", async () => {
    await expect(runtime.run(TASK_A, { operation: "bookmarks_update", id: "20", url: "https://x.example/" }))
      .rejects.toMatchObject({ code: "invalid_request" });
    for (const id of ["0", "1", "2"]) {
      await expect(runtime.run(TASK_A, { operation: "bookmarks_update", id, title: "x" }))
        .rejects.toMatchObject({ code: "bookmark_root_immutable" });
    }
    await expect(runtime.run(TASK_A, { operation: "bookmarks_update", id: "40", title: "x" }))
      .rejects.toMatchObject({ code: "bookmark_root_immutable" });
    await expect(runtime.run(TASK_A, { operation: "bookmarks_update", id: "999", title: "x" }))
      .rejects.toMatchObject({ code: "bookmark_not_found" });
    expect(callsTo("bookmarks.update")).toEqual([]);
  });

  test("bookmarks_create creates bookmarks and folders with the requested placement", async () => {
    const bookmark = await runtime.run(TASK_A, {
      operation: "bookmarks_create",
      parent_id: "1",
      title: "Docs",
      url: "https://docs.example/",
      index: 1,
    });
    const folder = await runtime.run(TASK_A, { operation: "bookmarks_create", parent_id: "2", title: "Projects" });
    expect(callsTo("bookmarks.create")).toEqual([
      { api: "bookmarks.create", args: [{ parentId: "1", title: "Docs", url: "https://docs.example/", index: 1 }] },
      { api: "bookmarks.create", args: [{ parentId: "2", title: "Projects" }] },
    ]);
    expect(bookmark.result).toEqual({ operation: "bookmarks_create", id: "100", parent_id: "1", index: 1 });
    expect(folder.result).toEqual({ operation: "bookmarks_create", id: "101", parent_id: "2", index: 2 });
  });

  test("bookmarks_create refuses non-folder, root, and managed parents and out-of-range indexes", async () => {
    await expect(runtime.run(TASK_A, { operation: "bookmarks_create", parent_id: "10", title: "x" }))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(runtime.run(TASK_A, { operation: "bookmarks_create", parent_id: "0", title: "x" }))
      .rejects.toMatchObject({ code: "bookmark_root_immutable" });
    await expect(runtime.run(TASK_A, { operation: "bookmarks_create", parent_id: "40", title: "x" }))
      .rejects.toMatchObject({ code: "bookmark_root_immutable" });
    await expect(runtime.run(TASK_A, { operation: "bookmarks_create", parent_id: "30", title: "x", index: 1 }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(callsTo("bookmarks.create")).toEqual([]);
  });

  test("bookmarks_move passes the destination to Chrome", async () => {
    const moved = await runtime.run(TASK_A, { operation: "bookmarks_move", id: "10", parent_id: "30", index: 0 });
    const appended = await runtime.run(TASK_A, { operation: "bookmarks_move", id: "21", parent_id: "30" });
    expect(callsTo("bookmarks.move")).toEqual([
      { api: "bookmarks.move", args: ["10", { parentId: "30", index: 0 }] },
      { api: "bookmarks.move", args: ["21", { parentId: "30" }] },
    ]);
    expect(moved.result).toEqual({ operation: "bookmarks_move", id: "10", parent_id: "30", index: 0 });
    expect(appended.result).toEqual({ operation: "bookmarks_move", id: "21", parent_id: "30", index: 1 });
  });

  test("bookmarks_move refuses cycles, roots, non-folders, and out-of-range indexes", async () => {
    await expect(runtime.run(TASK_A, { operation: "bookmarks_move", id: "20", parent_id: "20" }))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(runtime.run(TASK_A, { operation: "bookmarks_move", id: "20", parent_id: "22" }))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(runtime.run(TASK_A, { operation: "bookmarks_move", id: "1", parent_id: "2" }))
      .rejects.toMatchObject({ code: "bookmark_root_immutable" });
    await expect(runtime.run(TASK_A, { operation: "bookmarks_move", id: "10", parent_id: "21" }))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(runtime.run(TASK_A, { operation: "bookmarks_move", id: "10", parent_id: "30", index: 2 }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(callsTo("bookmarks.move")).toEqual([]);
  });

  test("Chrome API failures surface as profile_api_failed", async () => {
    const update = spyOn(chrome.bookmarks, "update").mockImplementation(async () => {
      throw new Error("Can't modify managed bookmarks.");
    });
    try {
      await expect(runtime.run(TASK_A, { operation: "bookmarks_update", id: "10", title: "x" }))
        .rejects.toMatchObject({ code: "profile_api_failed" });
    } finally {
      update.mockRestore();
    }
  });
});

describe("bookmarks_remove staging and commit", () => {
  let runtime: ProfileRuntime;

  beforeEach(async () => {
    resetFakeData();
    resetStateForTest();
    ({ runtime } = newRuntime());
    await mutateState((state) => {
      state.skipCommitReview = true;
    });
  });

  async function stage(id = "10", taskId = TASK_A): Promise<string> {
    const execution = await runtime.run(taskId, { operation: "bookmarks_remove", id });
    if (!execution.staged) throw new Error("bookmarks_remove did not stage");
    return execution.staged.native_token;
  }

  test("stages instead of removing even when commit review is skipped", async () => {
    expect((await readState()).skipCommitReview).toBe(true);
    const execution = await runtime.run(TASK_A, { operation: "bookmarks_remove", id: "10" });
    expect(execution.staged).toMatchObject({ task_id: TASK_A, action: { operation: "bookmarks_remove", bookmark_id: "10" } });
    expect(execution.result).toEqual({ operation: "bookmarks_remove", id: "10" });
    expect(callsTo("bookmarks.remove")).toEqual([]);
    expect(bookmarks.has("10")).toBe(true);
    const token = execution.staged?.native_token ?? "";
    expect((await readState()).stagedCommits[token]).toBeDefined();
  });

  test("the staged effect and fingerprint carry no bookmark title or URL", async () => {
    const execution = await runtime.run(TASK_A, { operation: "bookmarks_remove", id: "10" });
    const { preview: _preview, ...journaled } = execution.staged ?? {};
    expectNoPrivateData(journaled);
    expectNoPrivateData(execution.result);
  });

  test("commit removes the bookmark when it is unchanged and consumes the token", async () => {
    const token = await stage();
    expect(await runtime.commit(TASK_A, token)).toEqual({ operation: "bookmarks_remove", id: "10", removed: true });
    expect(callsTo("bookmarks.remove")).toEqual([{ api: "bookmarks.remove", args: ["10"] }]);
    expect(bookmarks.has("10")).toBe(false);
    expect((await readState()).stagedCommits[token]).toBeUndefined();
    await expect(runtime.commit(TASK_A, token)).rejects.toMatchObject({ code: "invalid_staged_token" });
    expect(callsTo("bookmarks.remove")).toHaveLength(1);
  });

  test("commit removes an empty folder", async () => {
    const token = await stage("30");
    await runtime.commit(TASK_A, token);
    expect(callsTo("bookmarks.remove")).toEqual([{ api: "bookmarks.remove", args: ["30"] }]);
  });

  for (const [label, change] of [
    ["retitled", () => Object.assign(bookmarks.get("10") ?? {}, { title: "Renamed elsewhere" })],
    ["re-pointed", () => Object.assign(bookmarks.get("10") ?? {}, { url: "https://other.example/" })],
    ["moved", () => {
      detachBookmark("10");
      Object.assign(bookmarks.get("10") ?? {}, { parentId: "30" });
      children.get("30")?.push("10");
    }],
    ["deleted", () => {
      detachBookmark("10");
      bookmarks.delete("10");
    }],
  ] as const) {
    test(`commit refuses and discards the stage when the bookmark was ${label} after staging`, async () => {
      const token = await stage();
      change();
      await expect(runtime.commit(TASK_A, token)).rejects.toMatchObject({ code: "staged_commit_mismatch" });
      expect(callsTo("bookmarks.remove")).toEqual([]);
      expect((await readState()).stagedCommits[token]).toBeUndefined();
    });
  }

  test("commit refuses another task's token without consuming it", async () => {
    const token = await stage();
    await expect(runtime.commit(TASK_B, token)).rejects.toMatchObject({ code: "invalid_staged_token" });
    expect(callsTo("bookmarks.remove")).toEqual([]);
    expect((await readState()).stagedCommits[token]).toBeDefined();
  });

  test("commit refuses an expired stage", async () => {
    const token = await stage();
    await mutateState((state) => {
      const staged = state.stagedCommits[token];
      if (staged) staged.expires_at_ms = Date.now() - 1;
    });
    await expect(runtime.commit(TASK_A, token)).rejects.toMatchObject({ code: "staged_commit_expired" });
    expect(callsTo("bookmarks.remove")).toEqual([]);
    expect((await readState()).stagedCommits[token]).toBeUndefined();
  });

  test("refuses to stage a non-empty folder, a root, or a managed node", async () => {
    await expect(runtime.run(TASK_A, { operation: "bookmarks_remove", id: "20" }))
      .rejects.toMatchObject({ code: "bookmark_folder_not_empty" });
    await expect(runtime.run(TASK_A, { operation: "bookmarks_remove", id: "1" }))
      .rejects.toMatchObject({ code: "bookmark_root_immutable" });
    await expect(runtime.run(TASK_A, { operation: "bookmarks_remove", id: "40" }))
      .rejects.toMatchObject({ code: "bookmark_root_immutable" });
    expect(Object.keys((await readState()).stagedCommits)).toEqual([]);
  });
});

describe("history, sessions, and downloads", () => {
  let runtime: ProfileRuntime;
  let opened: Array<{ taskId: string; url: string }>;

  beforeEach(() => {
    resetFakeData();
    resetStateForTest();
    ({ runtime, opened } = newRuntime());
  });

  test("history_search without start_time searches all retained history", async () => {
    const { result } = await runtime.run(TASK_A, { operation: "history_search", text: PRIVATE_HISTORY_QUERY, limit: 5 });
    expect(callsTo("history.search")).toEqual([
      { api: "history.search", args: [{ text: PRIVATE_HISTORY_QUERY, startTime: 0, maxResults: 5 }] },
    ]);
    expect(result).toEqual({
      operation: "history_search",
      count: 1,
      items: [{
        id: "h1",
        url: PRIVATE_HISTORY_URL,
        title: "Results",
        last_visit_time_ms: 1_700_000_000_000,
        visit_count: 3,
        typed_count: 1,
      }],
    });
  });

  test("history_search forwards an explicit time window", async () => {
    await runtime.run(TASK_A, { operation: "history_search", text: "", limit: 10, start_time: 1_000, end_time: 2_000 });
    expect(callsTo("history.search")[0]?.args).toEqual([{ text: "", startTime: 1_000, endTime: 2_000, maxResults: 10 }]);
  });

  test("sessions_recent and sessions_devices map Chrome sessions with millisecond times", async () => {
    const recent = await runtime.run(TASK_A, { operation: "sessions_recent", limit: 3 });
    expect(callsTo("sessions.getRecentlyClosed")[0]?.args).toEqual([{ maxResults: 3 }]);
    expect(recent.result).toMatchObject({
      count: 3,
      sessions: [
        {
          kind: "tab",
          session_id: "tab-1",
          last_modified_ms: 1_700_000_000_000,
          title: PRIVATE_SESSION_TITLE,
          url: PRIVATE_SESSION_URL,
        },
        { kind: "window", session_id: "win-1", last_modified_ms: 1_700_000_100_000, tab_count: 8 },
        { kind: "window", session_id: "win-big", tab_count: 30 },
      ],
    });

    const devices = await runtime.run(TASK_A, { operation: "sessions_devices" });
    expect(callsTo("sessions.getDevices")[0]?.args).toEqual([{ maxResults: 10 }]);
    expect(devices.result).toMatchObject({
      count: 1,
      devices: [{ device_name: "Laptop", sessions: [{ kind: "tab", session_id: "device-tab-1" }] }],
    });
  });

  test("sessions_restore opens only http(s) URLs as task tabs and never calls sessions.restore", async () => {
    const { result } = await runtime.run(TASK_A, { operation: "sessions_restore", session_id: "win-1" });
    expect(opened).toEqual([
      { taskId: TASK_A, url: "https://one.example/" },
      { taskId: TASK_A, url: "http://two.example/" },
      { taskId: TASK_A, url: "HTTPS://three.example/" },
    ]);
    expect(result).toEqual({
      operation: "sessions_restore",
      session_id: "win-1",
      kind: "window",
      opened: [
        { tab_id: 901, page_revision: 1 },
        { tab_id: 902, page_revision: 1 },
        { tab_id: 903, page_revision: 1 },
      ],
      skipped: 5,
    });
    expect(callsTo("sessions.restore")).toEqual([]);
  });

  test("sessions_restore caps a window at 25 tabs", async () => {
    const { result } = await runtime.run(TASK_A, { operation: "sessions_restore", session_id: "win-big" });
    expect(opened).toHaveLength(25);
    expect(opened.map((entry) => entry.url)).toEqual(Array.from({ length: 25 }, (_, index) => `https://many.example/${index}`));
    expect(result).toMatchObject({ kind: "window", skipped: 5 });
    expect(result.opened).toHaveLength(25);
    expect(callsTo("sessions.restore")).toEqual([]);
  });

  test("sessions_restore finds single tabs and synced device sessions", async () => {
    const recentTab = await runtime.run(TASK_A, { operation: "sessions_restore", session_id: "tab-1" });
    const synced = await runtime.run(TASK_A, { operation: "sessions_restore", session_id: "device-tab-1" });
    expect(opened.map((entry) => entry.url)).toEqual([PRIVATE_SESSION_URL, "https://synced.example/page"]);
    expect(recentTab.result).toMatchObject({ kind: "tab", skipped: 0 });
    expect(synced.result).toMatchObject({ kind: "tab", skipped: 0 });
    expectNoPrivateData(recentTab.result);
  });

  test("sessions_restore of a non-web tab opens nothing", async () => {
    recentSessions = [{ lastModified: 1, tab: sessionTab("tab-js", "javascript:void(0)") }];
    const { result } = await runtime.run(TASK_A, { operation: "sessions_restore", session_id: "tab-js" });
    expect(opened).toEqual([]);
    expect(result).toMatchObject({ kind: "tab", opened: [], skipped: 1 });
  });

  test("sessions_restore reports an unknown session without opening tabs", async () => {
    await expect(runtime.run(TASK_A, { operation: "sessions_restore", session_id: "gone" }))
      .rejects.toMatchObject({ code: "session_not_found" });
    expect(opened).toEqual([]);
    expect(callsTo("sessions.restore")).toEqual([]);
  });

  test("sessions_restore marks a partial restore as unknown", async () => {
    let attempts = 0;
    const failing = new ProfileRuntime(async () => {
      attempts += 1;
      if (attempts === 2) throw new Error("tab creation failed");
      return { tab_id: 900 + attempts, page_revision: 1 };
    });
    await expect(failing.run(TASK_A, { operation: "sessions_restore", session_id: "win-1" }))
      .rejects.toMatchObject({ outcome: "unknown" });
  });

  test("downloads_search maps the query and results", async () => {
    const { result } = await runtime.run(TASK_A, {
      operation: "downloads_search",
      query: "  lab   results ",
      state: "complete",
      limit: 5,
    });
    expect(callsTo("downloads.search")).toEqual([{
      api: "downloads.search",
      args: [{ limit: 5, orderBy: ["-startTime"], query: ["lab", "results"], state: "complete" }],
    }]);
    expect(result.count).toBe(2);
    expect(result.downloads).toEqual([
      {
        id: 7,
        filename: PRIVATE_DOWNLOAD,
        url: PRIVATE_DOWNLOAD_URL,
        state: "in_progress",
        paused: false,
        bytes_received: 10,
        total_bytes: 100,
        mime: "application/pdf",
        start_time_ms: Date.parse("2026-01-02T03:04:05.000Z"),
      },
      expect.objectContaining({
        id: 8,
        final_url: "https://cdn.example/redirected.pdf",
        end_time_ms: Date.parse("2026-01-02T03:05:05.000Z"),
      }),
    ]);
  });

  test("downloads_search defaults to the 25 most recent downloads", async () => {
    await runtime.run(TASK_A, { operation: "downloads_search" });
    expect(callsTo("downloads.search")[0]?.args).toEqual([{ limit: 25, orderBy: ["-startTime"] }]);
  });

  test("download controls call the matching Chrome API and report the resulting state", async () => {
    const paused = await runtime.run(TASK_A, { operation: "downloads_pause", id: 7 });
    const resumed = await runtime.run(TASK_A, { operation: "downloads_resume", id: 7 });
    const cancelled = await runtime.run(TASK_A, { operation: "downloads_cancel", id: 7 });
    expect(calls.filter((call) => /^downloads\.(pause|resume|cancel)$/.test(call.api))).toEqual([
      { api: "downloads.pause", args: [7] },
      { api: "downloads.resume", args: [7] },
      { api: "downloads.cancel", args: [7] },
    ]);
    expect(paused.result).toEqual({ operation: "downloads_pause", id: 7, state: "in_progress", paused: true });
    expect(resumed.result).toEqual({ operation: "downloads_resume", id: 7, state: "in_progress", paused: false });
    expect(cancelled.result).toEqual({ operation: "downloads_cancel", id: 7, state: "interrupted", paused: false });
  });

  test("download controls refuse an unknown download", async () => {
    await expect(runtime.run(TASK_A, { operation: "downloads_cancel", id: 404 }))
      .rejects.toMatchObject({ code: "download_not_found" });
    expect(calls.filter((call) => /^downloads\.(pause|resume|cancel)$/.test(call.api))).toEqual([]);
  });
});

describe("private profile data stays out of logs and write results", () => {
  afterEach(restoreConsole);

  test("no operation logs and write results carry identifiers only", async () => {
    resetFakeData();
    resetStateForTest();
    const { runtime } = newRuntime();
    spyOnConsole();

    await runtime.run(TASK_A, { operation: "bookmarks_search", query: PRIVATE_TITLE, limit: 5 });
    await runtime.run(TASK_A, { operation: "bookmarks_tree", depth: 5 });
    await runtime.run(TASK_A, { operation: "history_search", text: PRIVATE_HISTORY_QUERY, limit: 5 });
    await runtime.run(TASK_A, { operation: "sessions_recent" });
    await runtime.run(TASK_A, { operation: "sessions_devices" });
    await runtime.run(TASK_A, { operation: "downloads_search", query: PRIVATE_DOWNLOAD });

    const writes = [
      await runtime.run(TASK_A, { operation: "bookmarks_update", id: "21", title: PRIVATE_TITLE, url: PRIVATE_URL }),
      await runtime.run(TASK_A, { operation: "bookmarks_create", parent_id: "30", title: PRIVATE_FOLDER, url: PRIVATE_URL }),
      await runtime.run(TASK_A, { operation: "bookmarks_move", id: "10", parent_id: "30" }),
      await runtime.run(TASK_A, { operation: "sessions_restore", session_id: "tab-1" }),
      await runtime.run(TASK_A, { operation: "downloads_pause", id: 7 }),
    ];
    for (const write of writes) expectNoPrivateData(write.result);

    const removal = await runtime.run(TASK_A, { operation: "bookmarks_remove", id: "10" });
    const { preview: _preview, ...journaled } = removal.staged ?? {};
    expectNoPrivateData(journaled);
    expectNoPrivateData(removal.result);
    expectNoPrivateData(await runtime.commit(TASK_A, removal.staged?.native_token ?? ""));

    const failures = [
      runtime.run(TASK_A, { operation: "bookmarks_update", id: "20", url: PRIVATE_URL }),
      runtime.run(TASK_A, { operation: "sessions_restore", session_id: "missing" }),
    ];
    for (const failure of failures) {
      const error = await failure.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expectNoPrivateData(error instanceof Error ? error.message : "");
    }

    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });
});

describe("browser_profile through the extension entrypoint", () => {
  let port: MockNativePort;
  // Each command needs a distinct request id; the counter fills the UUID's last group.
  let requestCounter = 0;

  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      // The background settles through storage promise chains and microtask-dispatched tab events;
      // a zero-delay macrotask yield lets them run without guessing a duration.
      await Bun.sleep(0);
    }
    throw new Error("condition did not settle within the bounded wait");
  }

  async function send(method: string, params: Record<string, unknown>, taskId = TASK_A): Promise<Record<string, unknown>> {
    requestCounter += 1;
    const requestId = `018f47b8-2f80-7c20-9c77-${(0x700000000000 + requestCounter).toString(16)}`;
    port.receive({
      protocol: NATIVE_PROTOCOL,
      version: PROTOCOL_VERSION,
      kind: "command",
      request_id: requestId,
      task_id: taskId,
      connection_id: CONNECTION_ID,
      method,
      params,
    });
    const isResponse = (message: Record<string, unknown>) => message.kind === "response" && message.request_id === requestId;
    await waitFor(() => port.posted.some(isResponse));
    const response = port.posted.find(isResponse);
    if (!response) throw new Error("no response");
    return response;
  }

  async function popup(message: Record<string, unknown>): Promise<unknown> {
    const listener = listeners.get("runtime.onMessage")?.at(-1);
    if (!listener) throw new Error("popup listener is unavailable");
    const { promise, resolve } = Promise.withResolvers<unknown>();
    listener(message, { id: EXTENSION_ID }, resolve);
    return promise;
  }

  function stagedToken(response: Record<string, unknown>): string {
    const token = isRecord(response.staged) ? response.staged.native_token : undefined;
    if (typeof token !== "string") throw new Error("response carries no staged native token");
    return token;
  }

  beforeAll(async () => {
    resetFakeData();
    resetStateForTest();
    installChrome();
    port = new MockNativePort();
    nativePort = port;
    spyOnConsole();
    // The specifier is built at runtime so this file evaluates its own background instance bound to
    // this file's Chrome fake, separate from any instance another test file already loaded.
    const backgroundModule = "../src/background.ts?profile-test";
    await import(backgroundModule);
    await waitFor(() => port.posted.some((message) => message.kind === "hello"));
    port.receive({ protocol: NATIVE_PROTOCOL, version: PROTOCOL_VERSION, kind: "ready", host_version: "0.2.0", state: "ready" });
    await waitFor(() => alarmClears.includes(RECONNECT_ALARM));
  });

  test("bookmarks_remove returns commit_required with skip-review on, and browser_commit removes it", async () => {
    expect((await readState()).skipCommitReview).toBe(true);
    const staged = await send("browser_profile", { operation: "bookmarks_remove", id: "10" });
    const token = stagedToken(staged);
    expect(staged).toMatchObject({
      outcome: "commit_required",
      result: { operation: "bookmarks_remove", id: "10" },
      staged: { task_id: TASK_A },
    });
    expect(isRecord(staged.staged) && "preview" in staged.staged).toBe(false);
    expectNoPrivateData(staged);
    expect(callsTo("bookmarks.remove")).toEqual([]);

    const committed = await send("browser_commit", { native_token: token });
    expect(committed).toMatchObject({ outcome: "completed", result: { id: "10", removed: true } });
    expect(callsTo("bookmarks.remove")).toEqual([{ api: "bookmarks.remove", args: ["10"] }]);
  });

  test("browser_commit refuses a bookmark that changed after staging", async () => {
    const token = stagedToken(await send("browser_profile", { operation: "bookmarks_remove", id: "21" }));
    Object.assign(bookmarks.get("21") ?? {}, { title: "Changed by the human" });
    const committed = await send("browser_commit", { native_token: token });
    expect(committed).toMatchObject({ outcome: "not_started", error: { code: "staged_commit_mismatch" } });
    expect(bookmarks.has("21")).toBe(true);
  });

  test("sessions_restore opens background task tabs without focusing any window or tab", async () => {
    calls = [];
    const restored = await send("browser_profile", { operation: "sessions_restore", session_id: "win-1" });
    expect(restored).toMatchObject({ outcome: "completed", result: { kind: "window", skipped: 5 } });
    const created = callsTo("tabs.create").map((call) => call.args[0]).filter(isRecord);
    expect(created.map((options) => options.url)).toEqual([
      "https://one.example/",
      "http://two.example/",
      "HTTPS://three.example/",
    ]);
    for (const options of created) expect(options.active).toBe(false);
    expect(callsTo("windows.create")).toEqual([]);
    expect(callsTo("windows.update").filter((call) => isRecord(call.args[1]) && call.args[1].focused === true)).toEqual([]);
    expect(callsTo("tabs.update").filter((call) => isRecord(call.args[1]) && call.args[1].active === true)).toEqual([]);
    expect(callsTo("sessions.restore")).toEqual([]);
    expect(tabStore.get(1)?.active).toBe(true);
    const opened = isRecord(restored.result) && Array.isArray(restored.result.opened) ? restored.result.opened : [];
    expect(opened).toHaveLength(3);
    for (const tab of opened) expect(isRecord(tab) ? tabStore.get(Number(tab.tab_id))?.active : undefined).toBe(false);
  });

  test("Pause blocks profile reads and writes before they reach Chrome", async () => {
    expect(await popup({ kind: "pause" })).toEqual({ paused: true });
    calls = [];
    for (const params of [
      { operation: "bookmarks_search", query: "bank" },
      { operation: "history_search", text: "", limit: 5 },
      { operation: "bookmarks_update", id: "21", title: "x" },
      { operation: "sessions_restore", session_id: "tab-1" },
      { operation: "downloads_cancel", id: 7 },
    ]) {
      expect(await send("browser_profile", params)).toMatchObject({ outcome: "not_started", error: { code: "paused" } });
    }
    expect(profileApiCalls()).toEqual([]);
    expect(callsTo("tabs.create")).toEqual([]);

    expect(await popup({ kind: "resume" })).toEqual({ paused: false });
    expect(await send("browser_profile", { operation: "bookmarks_search", query: "Nested" })).toMatchObject({
      outcome: "completed",
    });
  });

  test("profile operations keep working after automation permissions are revoked, and Pause still blocks them", async () => {
    automationPermission = false;
    emit("permissions.onRemoved", { permissions: ["scripting", "debugger"] });
    // Site automation is refused, proving the revocation took effect.
    expect(await send("browser_tabs", {})).toMatchObject({ outcome: "not_started" });
    calls = [];
    expect(await send("browser_profile", { operation: "bookmarks_search", query: "Nested" })).toMatchObject({
      outcome: "completed",
      result: { count: 1 },
    });
    expect(await send("browser_profile", { operation: "downloads_pause", id: 7 })).toMatchObject({
      outcome: "completed",
      result: { paused: true },
    });
    const token = stagedToken(await send("browser_profile", { operation: "bookmarks_remove", id: "30" }));
    expect(await send("browser_commit", { native_token: token })).toMatchObject({
      outcome: "completed",
      result: { id: "30", removed: true },
    });
    expect(callsTo("debugger.attach")).toEqual([]);
    expect(callsTo("scripting.executeScript")).toEqual([]);
    // Restoring opens tabs, so it keeps browser_open's permission admission.
    expect(await send("browser_profile", { operation: "sessions_restore", session_id: "win-1" })).toMatchObject({
      outcome: "not_started",
    });
    expect(callsTo("tabs.create")).toEqual([]);

    expect(await popup({ kind: "pause" })).toEqual({ paused: true });
    calls = [];
    for (const params of [
      { operation: "bookmarks_search", query: "Nested" },
      { operation: "downloads_resume", id: 7 },
    ]) {
      expect(await send("browser_profile", params)).toMatchObject({ outcome: "not_started", error: { code: "paused" } });
    }
    expect(profileApiCalls()).toEqual([]);
    expect(await popup({ kind: "resume" })).toEqual({ paused: false });
    expect(await send("browser_profile", { operation: "downloads_resume", id: 7 })).toMatchObject({
      outcome: "completed",
      result: { paused: false },
    });
  });

  test("no private profile data reached the console or a non-read response", async () => {
    await send("browser_profile", { operation: "history_search", text: PRIVATE_HISTORY_QUERY, limit: 5 });
    expectNoPrivateData(consoleOutput());
    restoreConsole();
    const readOperations: Record<string, true> = {
      bookmarks_search: true,
      bookmarks_tree: true,
      history_search: true,
      sessions_recent: true,
      sessions_devices: true,
      downloads_search: true,
    };
    for (const message of port.posted) {
      if (message.kind === "response" && isRecord(message.result) && readOperations[String(message.result.operation)]) continue;
      // Inventory events describe task-owned tabs, including restored ones, by design.
      if (message.kind === "event" && message.event === "inventory") continue;
      expectNoPrivateData(message);
    }
  });
});

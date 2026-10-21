import { beforeEach, describe, expect, test } from "bun:test";
import { StandardBrowserRuntime } from "../src/browser";
import type { ChallengeEvent, ChallengePageFacts, FrameFact, Signature } from "../src/challenge";
import { CHALLENGE_CATALOG } from "../src/challenge-catalog";
import {
  classifyGuardedAction,
  decideContainment,
  parseSurfaceEvidence,
  probeSurfaceEvidence,
  SURFACE_PROBE_DECLARATION,
  surfaceMatchers,
  urlInSurface,
  type SurfaceEvidence,
} from "../src/challenge-guard";
import { CHALLENGE_STORAGE_KEY, readTaskEpisodes } from "../src/challenge-store";
import { needsUser, parseCommand } from "../src/protocol";
import { RevisionTracker } from "../src/revisions";
import { resetStateForTest } from "../src/storage";

const TASK = "018f47b8-2f80-7c20-9c77-f8a38c9e621e";
const OTHER_TASK = "018f47b8-2f80-7c20-9c77-f8a38c9e621f";
const TAB = 41;
const OTHER_TAB = 42;
const ORIGIN = "https://shop.example";
const TURNSTILE_PATH = "/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0/rcv/";
const TURNSTILE_URL = `https://challenges.cloudflare.com${TURNSTILE_PATH}`;
const TURNSTILE_TOKEN = 'input[name="cf-turnstile-response"]';

// ---------------------------------------------------------------------------
// Page fixtures (what chrome.scripting reports to the detector)
// ---------------------------------------------------------------------------

function pageFacts(overrides: Partial<ChallengePageFacts> = {}): ChallengePageFacts {
  return { page_origin: ORIGIN, scripts: [], frames: [], elements: [], tokens: [], ...overrides };
}

function frameFact(host: string, path: string, overrides: Partial<FrameFact> = {}): FrameFact {
  return { host, path, query: {}, origin: `https://${host}`, visible: true, width: 300, height: 65, ...overrides };
}

const clean = () => pageFacts();
const turnstileActive = () => pageFacts({ frames: [frameFact("challenges.cloudflare.com", TURNSTILE_PATH)] });
const turnstileSolved = () =>
  pageFacts({
    frames: [frameFact("challenges.cloudflare.com", TURNSTILE_PATH)],
    tokens: [{ selector: TURNSTILE_TOKEN, present: true, non_empty: true }],
  });
const cloudflareInterstitial = () =>
  pageFacts({
    scripts: [{ host: "shop.example", path: "/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1", query: {} }],
  });
const hcaptchaHuman = () =>
  pageFacts({ frames: [frameFact("newassets.hcaptcha.com", "/captcha/v1/abc/static/hcaptcha.html", { width: 303, height: 78 })] });

// ---------------------------------------------------------------------------
// Chrome mock: just enough for StandardBrowserRuntime scans, waits, and acts
// ---------------------------------------------------------------------------

interface Command {
  method: string;
  params: Record<string, unknown>;
}

let localStore: Record<string, unknown>;
let sessionStore: Record<string, unknown>;
let factsFor: (scanNumber: number) => ChallengePageFacts;
let factsScans: number;
let scanTimes: number[];
let focusProbes: number;
let focusEvidence: SurfaceEvidence | undefined;
let nodeEvidence: (objectId: string) => unknown;
let commands: Command[];
let frameTree: unknown;
let tabUpdates: Array<Record<string, unknown>>;
let debuggerRefused: boolean;
let pageAgentRequests: Array<Record<string, unknown>>;
let agentSurface: (id: number) => unknown;
const eventListeners: Array<(...args: unknown[]) => void> = [];

function defaultFrameTree(): unknown {
  return {
    frame: { id: "top", loaderId: "loader-top", url: `${ORIGIN}/` },
    childFrames: [
      {
        frame: { id: "vendor-frame", parentId: "top", loaderId: "loader-vendor", url: TURNSTILE_URL },
      },
      {
        frame: { id: "plain-frame", parentId: "top", loaderId: "loader-plain", url: "https://ads.example/slot" },
      },
    ],
  };
}

function installChromeMock(): void {
  localStore = {};
  sessionStore = {};
  factsFor = clean;
  factsScans = 0;
  scanTimes = [];
  focusProbes = 0;
  focusEvidence = { hit: false, frames: [] };
  nodeEvidence = () => ({ hit: false, frames: [] });
  commands = [];
  frameTree = defaultFrameTree();
  tabUpdates = [];
  debuggerRefused = false;
  pageAgentRequests = [];
  agentSurface = () => ({ hit: false, frames: [] });
  eventListeners.length = 0;
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
        onEvent: { addListener(listener: (...args: unknown[]) => void) { eventListeners.push(listener); } },
        async getTargets() { return []; },
        async attach() {
          if (debuggerRefused) throw new Error("Cannot access a chrome-extension:// URL of different extension");
        },
        async detach() {},
        async sendCommand(target: { tabId: number }, method: string, params: Record<string, unknown>) {
          commands.push({ method, params: structuredClone(params) });
          switch (method) {
            case "Runtime.enable":
              for (const listener of eventListeners) {
                listener({ tabId: target.tabId }, "Runtime.executionContextCreated", {
                  context: { id: 7, auxData: { frameId: "vendor-frame" } },
                });
                listener({ tabId: target.tabId }, "Runtime.executionContextCreated", {
                  context: { id: 8, auxData: { frameId: "plain-frame" } },
                });
              }
              return {};
            case "Page.getFrameTree":
              return { frameTree };
            case "DOM.getDocument":
              return { root: { nodeId: 1, backendNodeId: 1 } };
            case "Runtime.evaluate":
              return { result: { objectId: "document-object" } };
            case "DOM.requestNode":
              return { nodeId: 5 };
            case "DOM.querySelectorAll":
              return { nodeIds: [21] };
            case "DOM.describeNode":
              return { node: { backendNodeId: Number(params.nodeId) + 100 } };
            case "DOM.resolveNode":
              return { object: { objectId: `node-${String(params.backendNodeId)}` } };
            case "Runtime.callFunctionOn": {
              const declaration = String(params.functionDeclaration);
              if (declaration === SURFACE_PROBE_DECLARATION) {
                return { result: { value: nodeEvidence(String(params.objectId)) } };
              }
              return { result: { value: { tag: "BUTTON", text: "Buy" } } };
            }
            default:
              return {};
          }
        },
      },
      tabs: {
        async get(tabId: number) {
          return { id: tabId, windowId: 1, groupId: -1, status: "complete", url: `${ORIGIN}/` };
        },
        async query() { return []; },
        async update(tabId: number, changes: Record<string, unknown>) {
          tabUpdates.push({ tabId, ...changes });
          return { id: tabId, windowId: 1, groupId: -1, ...changes };
        },
        async reload() {},
        async goBack() {},
        async goForward() {},
        async remove() {},
      },
      action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
      windows: { async update() { return {}; } },
      scripting: {
        async executeScript(details: { func: { name: string }; args?: unknown[] }) {
          if (details.func.name === "runPageAgentRequest") {
            const request = details.args?.[0] as Record<string, unknown>;
            pageAgentRequests.push(structuredClone(request));
            const result = request.op === "select"
              ? { id: request.selector === "#widget-host" ? 9 : 3 }
              : request.op === "surface"
              ? agentSurface(Number(request.id))
              : request.op === "describe"
              ? { tag: "BUTTON", text: "Buy" }
              : undefined;
            return [{ result: structuredClone(result), documentId: "doc-1" }];
          }
          if (details.func.name === "collectChallengeFacts") {
            factsScans += 1;
            scanTimes.push(Date.now());
            return [{ result: structuredClone(factsFor(factsScans)) }];
          }
          if (details.func.name === "probeSurfaceEvidence") {
            focusProbes += 1;
            return [{ result: structuredClone(focusEvidence) }];
          }
          return [{ result: undefined }];
        },
      },
    },
  });
  resetStateForTest();
}

beforeEach(installChromeMock);

function newRuntime(revisions = new RevisionTracker()): StandardBrowserRuntime {
  return new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
}

/** Runs one scan against the current page facts and returns the episode it opened. */
async function openEpisode(runtime: StandardBrowserRuntime, facts: ChallengePageFacts): Promise<ChallengeEvent> {
  factsFor = () => facts;
  const scanned = await runtime.scanChallengeEpisodes(TASK, TAB);
  expect(scanned?.event?.state).toBe("active");
  return scanned!.event!;
}

function waitFor(runtime: StandardBrowserRuntime, challengeId: string, options: { tab?: number; task?: string; timeout?: number } = {}) {
  return runtime.wait(
    options.tab ?? TAB,
    { condition: { kind: "challenge_cleared", challenge_id: challengeId }, timeout_ms: options.timeout ?? 5_000 },
    undefined,
    options.task ?? TASK,
  );
}

const userGestureCalls = () =>
  commands.filter((command) => command.method === "Runtime.callFunctionOn" && command.params.userGesture === true);
const inputCalls = () => [...userGestureCalls(), ...commands.filter((command) => command.method.startsWith("Input."))];

/** Rewrites an episode in the persisted store, as time passing would. */
async function ageEpisode(challengeId: string, ageMs: number): Promise<void> {
  const table = sessionStore[CHALLENGE_STORAGE_KEY] as Record<string, Array<Record<string, unknown>>>;
  for (const episode of table[TASK]!) {
    if (episode.challenge_id === challengeId) episode.first_detected_at_ms = Date.now() - ageMs;
  }
}

// ---------------------------------------------------------------------------
// challenge_cleared wait
// ---------------------------------------------------------------------------

describe("browser_wait challenge_cleared", () => {
  test("an unknown id, another task, another tab, or an ended episode is challenge_not_found/not_started", async () => {
    const runtime = newRuntime();
    const event = await openEpisode(runtime, turnstileActive());
    const missing = `chl_${"a".repeat(20)}`;
    for (const attempt of [
      () => waitFor(runtime, missing),
      () => waitFor(runtime, event.challenge_id, { task: OTHER_TASK }),
      () => waitFor(runtime, event.challenge_id, { tab: OTHER_TAB }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: "challenge_not_found", outcome: "not_started" });
    }

    factsFor = clean;
    const ended = await runtime.scanChallengeEpisodes(TASK, TAB);
    expect(ended?.event).toMatchObject({ challenge_id: event.challenge_id, state: "superseded" });
    await expect(waitFor(runtime, event.challenge_id)).rejects.toMatchObject({
      code: "challenge_not_found",
      outcome: "not_started",
    });
  });

  test("a wait never attaches the debugger itself", async () => {
    const runtime = newRuntime();
    const event = await openEpisode(runtime, hcaptchaHuman());
    commands.length = 0;
    await waitFor(runtime, event.challenge_id);
    expect(commands).toEqual([]);
  });

  test("returns the terminal event when the challenge clears, and the next result does not repeat it", async () => {
    const runtime = newRuntime();
    const event = await openEpisode(runtime, turnstileActive());
    expect(event).toMatchObject({ next: "wait", interaction: "automatic" });
    // Seed scan was scan 1; the wait's first scan still sees the widget, its second sees the token.
    factsFor = (scan) => (scan >= 3 ? turnstileSolved() : turnstileActive());

    const result = await waitFor(runtime, event.challenge_id);
    expect(result).toMatchObject({
      tab_id: TAB,
      page_revision: 1,
      condition: "challenge_cleared",
      matched: true,
      challenge: { challenge_id: event.challenge_id, state: "cleared", next: "none", token_present: true },
    });
    expect(result.status).toBeUndefined();
    expect(await runtime.scanChallenge(TASK, TAB)).toBeUndefined();
    expect(await runtime.scanChallengeEpisodes(TASK, TAB)).toMatchObject({ episodes: [{ state: "cleared" }] });
  });

  test("a superseded episode also completes the wait", async () => {
    const runtime = newRuntime();
    const event = await openEpisode(runtime, turnstileActive());
    factsFor = (scan) => (scan >= 2 ? clean() : turnstileActive());
    const result = await waitFor(runtime, event.challenge_id);
    expect(result).toMatchObject({ matched: true, challenge: { state: "superseded" } });
  });

  test("returns needs_user once the automatic budget is spent", async () => {
    const runtime = newRuntime();
    const event = await openEpisode(runtime, turnstileActive());
    expect(event.wait_budget_ms).toBeGreaterThan(1_000);
    // 13.8 s into a 15 s budget leaves 1.2 s: still a wait on the first poll, a handoff on the second.
    await ageEpisode(event.challenge_id, 13_800);
    factsFor = turnstileActive;
    const before = factsScans;

    const result = await waitFor(runtime, event.challenge_id);
    expect(factsScans - before).toBe(2);
    expect(result).toMatchObject({
      tab_id: TAB,
      condition: "challenge_cleared",
      matched: false,
      status: "challenge_needs_user",
      challenge: { challenge_id: event.challenge_id, state: "active", next: "handoff" },
    });
  });

  test("a human episode returns needs_user on the first scan", async () => {
    const runtime = newRuntime();
    const event = await openEpisode(runtime, hcaptchaHuman());
    expect(event).toMatchObject({ interaction: "human", next: "handoff" });
    const before = factsScans;
    const result = await waitFor(runtime, event.challenge_id);
    expect(factsScans - before).toBe(1);
    expect(result).toMatchObject({ matched: false, status: "challenge_needs_user", challenge: { next: "handoff" } });
  });

  test("times out with wait_timeout carrying the latest event, polling no faster than every 500 ms", async () => {
    const runtime = newRuntime();
    const event = await openEpisode(runtime, turnstileActive());
    factsFor = turnstileActive;
    // A virtual clock makes the poll spacing exact: sleeping advances time and nothing else does.
    const realNow = Date.now;
    const realSetTimeout = globalThis.setTimeout;
    let clock = realNow();
    Date.now = () => clock;
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      clock += delay ?? 0;
      queueMicrotask(callback);
      return 0;
    }) as unknown as typeof setTimeout;
    let error: Record<string, unknown> | undefined;
    try {
      error = await waitFor(runtime, event.challenge_id, { timeout: 1_300 }).then(
        () => undefined,
        (caught: unknown) => caught as Record<string, unknown>,
      );
    } finally {
      Date.now = realNow;
      globalThis.setTimeout = realSetTimeout;
    }
    expect(error).toMatchObject({ code: "wait_timeout", outcome: "unknown" });
    expect(error?.challengeEvent).toMatchObject({ challenge_id: event.challenge_id, state: "active", next: "wait" });
    const waitScans = scanTimes.slice(1);
    expect(waitScans.map((time) => time - waitScans[0]!)).toEqual([0, 500, 1_000]);
  });

  test("a scan that fails keeps the wait polling until the timeout", async () => {
    const runtime = newRuntime();
    const event = await openEpisode(runtime, turnstileActive());
    factsFor = () => {
      throw new Error("page is gone");
    };
    await expect(waitFor(runtime, event.challenge_id, { timeout: 600 })).rejects.toMatchObject({
      code: "wait_timeout",
    });
    expect(factsScans).toBeGreaterThanOrEqual(2);
  });

  test("runs the revalidation callback around every scan", async () => {
    const runtime = newRuntime();
    const event = await openEpisode(runtime, hcaptchaHuman());
    let calls = 0;
    await runtime.wait(
      TAB,
      { condition: { kind: "challenge_cleared", challenge_id: event.challenge_id }, timeout_ms: 5_000 },
      async () => {
        calls += 1;
      },
      TASK,
    );
    expect(calls).toBe(2);
    const stop = Object.assign(new Error("ownership changed"), { code: "ownership_revoked" });
    await expect(
      runtime.wait(
        TAB,
        { condition: { kind: "challenge_cleared", challenge_id: event.challenge_id }, timeout_ms: 5_000 },
        async () => {
          throw stop;
        },
        TASK,
      ),
    ).rejects.toBe(stop);
  });
});

describe("browser_wait challenge_cleared parameters", () => {
  const request = (condition: unknown) =>
    parseCommand({
      protocol: "agenttab.native",
      version: 1,
      kind: "command",
      request_id: "018f47b8-2f80-7c20-9c77-f8a38c9e6221",
      connection_id: "018f47b8-2f80-7c20-9c77-f8a38c9e6220",
      task_id: TASK,
      method: "browser_wait",
      params: { tab_id: TAB, condition, timeout_ms: 1_000 },
    });

  test("accepts exactly the contract shape", () => {
    const condition = { kind: "challenge_cleared", challenge_id: "chl_3k9w2m7q8x1v5b0n4c6z" };
    expect(request(condition).params.condition).toEqual(condition);
  });

  test("builds a needs_user response that carries the result and no error", () => {
    expect(needsUser("req-1", { status: "challenge_active" })).toEqual({
      protocol: "agenttab.native",
      version: 1,
      kind: "response",
      request_id: "req-1",
      outcome: "needs_user",
      result: { status: "challenge_active" },
    });
  });

  test("rejects extra keys, missing ids, and malformed ids", () => {
    for (const condition of [
      { kind: "challenge_cleared" },
      { kind: "challenge_cleared", challenge_id: "chl_3k9w2m7q8x1v5b0n4c6z", value: "x" },
      { kind: "challenge_cleared", challenge_id: "chl_short" },
      { kind: "challenge_cleared", challenge_id: "chl_3K9W2M7Q8X1V5B0N4C6Z" },
      { kind: "challenge_cleared", challenge_id: "3k9w2m7q8x1v5b0n4c6z" },
      { kind: "challenge_cleared", challenge_id: 7 },
    ]) {
      expect(() => request(condition)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// browser_act guard
// ---------------------------------------------------------------------------

describe("browser_act challenge guard", () => {
  test("a document-scope episode refuses element actions but lets navigation through", async () => {
    const runtime = newRuntime();
    const event = await openEpisode(runtime, cloudflareInterstitial());
    expect(event).toMatchObject({ kind: "interstitial", state: "active" });

    const refused = await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "#buy" }]);
    expect(refused.needsUser).toBe(true);
    expect(refused.staged).toBeUndefined();
    expect(refused.result).toMatchObject({
      tab_id: TAB,
      page_revision: 1,
      actions: [],
      status: "challenge_active",
      challenge: { challenge_id: event.challenge_id, state: "active", kind: "interstitial" },
    });
    expect(inputCalls()).toEqual([]);

    const navigated = await runtime.act(TASK, TAB, 1, [{ kind: "navigate", url: "https://shop.example/next" }]);
    expect(navigated.needsUser).toBeUndefined();
    expect(navigated.result).toMatchObject({ actions: [{ kind: "navigate", started: true }] });
    expect(tabUpdates).toEqual([{ tabId: TAB, url: "https://shop.example/next" }]);
  });

  test("a document-scope episode refuses a targetless scroll; a reload and a dialog dismissal proceed", async () => {
    const runtime = newRuntime();
    await openEpisode(runtime, cloudflareInterstitial());
    const scrolled = await runtime.act(TASK, TAB, 1, [{ kind: "scroll", delta_y: 200 }]);
    expect(scrolled).toMatchObject({ needsUser: true, result: { status: "challenge_active", actions: [] } });
    const reloaded = await runtime.act(TASK, TAB, 1, [{ kind: "reload" }]);
    expect(reloaded.needsUser).toBeUndefined();
    expect(reloaded.result).toMatchObject({ actions: [{ kind: "reload", started: true }] });
  });

  test("a widget episode refuses a click inside the vendor iframe and allows one outside it", async () => {
    const runtime = newRuntime();
    const event = await openEpisode(runtime, turnstileActive());
    expect(event.kind).toBe("widget");

    const inside = await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "label", frame_id: "vendor-frame" }]);
    expect(inside).toMatchObject({
      needsUser: true,
      result: { status: "challenge_active", actions: [], challenge: { challenge_id: event.challenge_id } },
    });
    expect(inputCalls()).toEqual([]);

    const outside = await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "#buy" }]);
    expect(outside.needsUser).toBeUndefined();
    expect(outside.result).toMatchObject({ actions: [{ kind: "click", completed: true }] });
    expect(userGestureCalls()).toHaveLength(1);

    const unrelatedFrame = await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "a", frame_id: "plain-frame" }]);
    expect(unrelatedFrame.needsUser).toBeUndefined();
    expect(userGestureCalls()).toHaveLength(2);
  });

  test("on the scripting route, the page agent decides containment without the debugger", async () => {
    debuggerRefused = true;
    const runtime = newRuntime();
    await openEpisode(runtime, turnstileActive());
    agentSurface = (id) => ({ hit: id === 9, frames: [] });

    const inside = await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "#widget-host" }]);
    expect(inside).toMatchObject({ needsUser: true, result: { status: "challenge_active", actions: [] } });
    expect(pageAgentRequests.filter((request) => request.op === "act")).toEqual([]);

    const outside = await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "#buy" }]);
    expect(outside.needsUser).toBeUndefined();
    expect(outside.result).toMatchObject({ actions: [{ kind: "click", completed: true, page_route: "scripting" }] });
    expect(pageAgentRequests.filter((request) => request.op === "surface")).toEqual([
      { op: "surface", id: 9, selectors: expect.any(Array) },
      { op: "surface", id: 3, selectors: expect.any(Array) },
    ]);
    expect(pageAgentRequests.filter((request) => request.op === "act")).toEqual([{ op: "act", id: 3, kind: "click" }]);
    expect(commands.map((command) => command.method)).not.toContain("Page.getFrameTree");
  });

  test("a batch runs its prefix, stops before the refused action, and dispatches no input for it", async () => {
    const runtime = newRuntime();
    await openEpisode(runtime, turnstileActive());
    const execution = await runtime.act(TASK, TAB, 1, [
      { kind: "click", selector: "#first" },
      { kind: "click", selector: "button", frame_id: "vendor-frame" },
      { kind: "click", selector: "#never" },
    ]);
    expect(execution.needsUser).toBe(true);
    expect(execution.result).toMatchObject({
      tab_id: TAB,
      page_revision: 1,
      actions: [{ kind: "click", completed: true }],
      status: "challenge_active",
      challenge: { state: "active", kind: "widget" },
    });
    expect((execution.result?.actions as unknown[]).length).toBe(1);
    expect(userGestureCalls()).toHaveLength(1);
    expect(execution.result).not.toHaveProperty("staged_index");
  });

  test("an element inside the surface, or in a frame nested in it, is refused", async () => {
    const runtime = newRuntime();
    await openEpisode(runtime, turnstileActive());
    nodeEvidence = () => ({ hit: true, frames: [] });
    const byElement = await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "#host-child" }]);
    expect(byElement.needsUser).toBe(true);
    nodeEvidence = () => ({ hit: false, frames: [TURNSTILE_URL] });
    const byIframe = await runtime.act(TASK, TAB, 1, [{ kind: "hover", selector: "#nested" }]);
    expect(byIframe.needsUser).toBe(true);
    expect(inputCalls()).toEqual([]);
  });

  test("a frame-level scroll is judged by its frame", async () => {
    const runtime = newRuntime();
    await openEpisode(runtime, turnstileActive());
    const inside = await runtime.act(TASK, TAB, 1, [{ kind: "scroll", frame_id: "vendor-frame", delta_y: 50 }]);
    expect(inside.needsUser).toBe(true);
    const outside = await runtime.act(TASK, TAB, 1, [{ kind: "scroll", frame_id: "plain-frame", delta_y: 50 }]);
    expect(outside.needsUser).toBeUndefined();
  });

  test("a targetless scroll follows the focused element under embedded scope", async () => {
    const runtime = newRuntime();
    await openEpisode(runtime, turnstileActive());
    focusEvidence = { hit: false, frames: [TURNSTILE_URL] };
    const refused = await runtime.act(TASK, TAB, 1, [{ kind: "scroll", delta_y: 100 }]);
    expect(refused).toMatchObject({ needsUser: true, result: { status: "challenge_active" } });
    focusEvidence = { hit: false, frames: [] };
    const allowed = await runtime.act(TASK, TAB, 1, [{ kind: "scroll", delta_y: 100 }]);
    expect(allowed.needsUser).toBeUndefined();
    expect(allowed.result).toMatchObject({ actions: [{ kind: "scroll", completed: true }] });
    focusEvidence = undefined;
    const unknown = await runtime.act(TASK, TAB, 1, [{ kind: "scroll", delta_y: 100 }]);
    expect(unknown.needsUser).toBe(true);
    expect(focusProbes).toBe(3);
  });

  test("undeterminable containment counts as inside only while an episode is active", async () => {
    const runtime = newRuntime();
    nodeEvidence = () => undefined;
    const idle = await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "#buy" }]);
    expect(idle.needsUser).toBeUndefined();
    expect(userGestureCalls()).toHaveLength(1);

    await openEpisode(runtime, turnstileActive());
    const guarded = await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "#buy" }]);
    expect(guarded.needsUser).toBe(true);
    expect(userGestureCalls()).toHaveLength(1);
  });

  test("an unreadable frame tree counts as inside while an episode is active", async () => {
    const runtime = newRuntime();
    await openEpisode(runtime, turnstileActive());
    frameTree = { frame: { id: "top", loaderId: "loader-top", url: `${ORIGIN}/` }, childFrames: [] };
    // The target resolves in a frame the tree no longer lists, so its ancestry cannot be followed.
    const error = await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "a", frame_id: "plain-frame" }]).then(
      () => undefined,
      (caught: unknown) => caught as Record<string, unknown>,
    );
    expect(error).toMatchObject({ code: "frame_not_found" });
    expect(inputCalls()).toEqual([]);
  });

  test("does not rescan when no episode is active and the revision is unchanged", async () => {
    const revisions = new RevisionTracker();
    const runtime = newRuntime(revisions);
    await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "#a" }]);
    expect(factsScans).toBe(1);
    await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "#b" }, { kind: "click", selector: "#c" }]);
    await runtime.act(TASK, TAB, 1, [{ kind: "navigate", url: "https://shop.example/x" }]);
    expect(factsScans).toBe(1);

    // A new page revision is rescanned, once.
    const next = await revisions.markNavigation(TAB);
    await runtime.act(TASK, TAB, next, [{ kind: "click", selector: "#d" }, { kind: "click", selector: "#e" }]);
    expect(factsScans).toBe(2);
  });

  test("an episode that cleared since the last scan no longer refuses", async () => {
    const runtime = newRuntime();
    const event = await openEpisode(runtime, turnstileActive());
    factsFor = turnstileSolved;
    const execution = await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "button", frame_id: "vendor-frame" }]);
    expect(execution.needsUser).toBeUndefined();
    expect(execution.result).toMatchObject({ actions: [{ kind: "click", completed: true }] });
    // The rescan consumed the episode's end, so the execution carries it forward exactly once.
    expect(execution.endedChallenge).toMatchObject({ challenge_id: event.challenge_id, state: "cleared" });
    expect(await runtime.scanChallenge(TASK, TAB)).toBeUndefined();
  });

  test("an episode that is still active at the batch start is refreshed before it refuses", async () => {
    const runtime = newRuntime();
    const event = await openEpisode(runtime, turnstileActive());
    await ageEpisode(event.challenge_id, 14_500);
    factsFor = turnstileActive;
    const execution = await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "label", frame_id: "vendor-frame" }]);
    expect(execution.result?.challenge).toMatchObject({ challenge_id: event.challenge_id, next: "handoff" });
    expect((await readTaskEpisodes(TASK))[0]).toMatchObject({ next: "handoff" });
  });

  test("a guard rescan opens a new episode that refuses in the same batch", async () => {
    const runtime = newRuntime();
    factsFor = cloudflareInterstitial;
    const execution = await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "#buy" }]);
    expect(execution.needsUser).toBe(true);
    expect(execution.result).toMatchObject({ status: "challenge_active", challenge: { kind: "interstitial" } });
    expect(inputCalls()).toEqual([]);
  });

  test("scripted episodes of another task never guard this task's tab", async () => {
    const runtime = newRuntime();
    factsFor = turnstileActive;
    await runtime.scanChallengeEpisodes(OTHER_TASK, TAB);
    factsFor = clean;
    const execution = await runtime.act(TASK, TAB, 1, [{ kind: "click", selector: "label", frame_id: "vendor-frame" }]);
    expect(execution.needsUser).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pure guard helpers
// ---------------------------------------------------------------------------

const turnstile = CHALLENGE_CATALOG.signatures.find((signature) => signature.id === "cloudflare.turnstile") as Signature;

describe("challenge guard classification", () => {
  test("guards element actions, targeted scroll, and targetless press and scroll; never navigation", () => {
    for (const kind of ["click", "double_click", "context_click", "hover", "type", "fill", "select", "drag", "upload_file"]) {
      expect(classifyGuardedAction({ kind, ref: "r" })).toBe("targeted");
    }
    expect(classifyGuardedAction({ kind: "press", key: "Enter", selector: "#a" })).toBe("targeted");
    expect(classifyGuardedAction({ kind: "press", key: "Enter" })).toBe("targetless");
    expect(classifyGuardedAction({ kind: "scroll", ref: "r" })).toBe("targeted");
    expect(classifyGuardedAction({ kind: "scroll", frame_id: "f" })).toBe("targeted");
    expect(classifyGuardedAction({ kind: "scroll", delta_y: 1 })).toBe("targetless");
    for (const kind of ["navigate", "reload", "go_back", "go_forward", "close", "dialog", "set_viewport", "constructor"]) {
      expect(classifyGuardedAction({ kind })).toBe("none");
    }
  });
});

describe("challenge guard surfaces", () => {
  test("derives frame and element leaves from a signature, skipping negated conditions", () => {
    expect(surfaceMatchers(turnstile)).toEqual({
      frames: [{ host: ["challenges.cloudflare.com"] }],
      selectors: [".cf-turnstile"],
    });
    expect(surfaceMatchers(undefined)).toEqual({ frames: [], selectors: [] });
    const negated: Signature = {
      ...turnstile,
      signals: [
        {
          signal: "x.frame",
          confidence: "high",
          when: { all: [{ frame: { host: ["w.example"] } }, { not: { frame: { host: ["skip.example"] } } }, { not: { element: { selector: ".skip" } } }] },
        },
      ],
    };
    expect(surfaceMatchers(negated)).toEqual({ frames: [{ host: ["w.example"] }], selectors: [] });
  });

  test("matches frame URLs with the detector's host, suffix, path, and query rules", () => {
    const matchers = {
      frames: [
        { host_suffix: ["hcaptcha.com"] },
        { host: ["www.google.com"], path_prefix: ["/recaptcha/api2/anchor"], query_absent: { name: "size", equals: "invisible" } },
      ],
      selectors: [],
    };
    expect(urlInSurface(matchers, "https://newassets.hcaptcha.com/captcha/v1/x")).toBe(true);
    expect(urlInSurface(matchers, "https://HCAPTCHA.com/")).toBe(true);
    expect(urlInSurface(matchers, "https://evilhcaptcha.com/")).toBe(false);
    expect(urlInSurface(matchers, "https://www.google.com/recaptcha/api2/anchor?k=1")).toBe(true);
    expect(urlInSurface(matchers, "https://www.google.com/recaptcha/api2/anchor?size=invisible")).toBe(false);
    expect(urlInSurface(matchers, "https://www.google.com/maps")).toBe(false);
    expect(urlInSurface(matchers, "about:blank")).toBe(false);
    expect(urlInSurface(matchers, "not a url")).toBe(false);
  });

  test("combines evidence: any match is inside, only complete evidence is outside", () => {
    const matchers = surfaceMatchers(turnstile);
    const none: SurfaceEvidence = { hit: false, frames: [] };
    expect(decideContainment(matchers, [], none)).toBe("outside");
    expect(decideContainment(matchers, ["https://ads.example/slot"], none)).toBe("outside");
    expect(decideContainment(matchers, [TURNSTILE_URL], none)).toBe("inside");
    expect(decideContainment(matchers, [], { hit: true, frames: [] })).toBe("inside");
    expect(decideContainment(matchers, [], { hit: false, frames: [TURNSTILE_URL] })).toBe("inside");
    // A positive match wins even when the rest is unknown.
    expect(decideContainment(matchers, [TURNSTILE_URL], undefined)).toBe("inside");
    expect(decideContainment(matchers, undefined, { hit: true, frames: [] })).toBe("inside");
    // Incomplete evidence never proves "outside".
    expect(decideContainment(matchers, undefined, none)).toBe("unknown");
    expect(decideContainment(matchers, [], undefined)).toBe("unknown");
    expect(decideContainment(matchers, [undefined], none)).toBe("unknown");
    expect(decideContainment(matchers, [""], none)).toBe("unknown");
  });

  test("validates page-side evidence", () => {
    expect(parseSurfaceEvidence({ hit: true, frames: ["https://a.example/"] })).toEqual({ hit: true, frames: ["https://a.example/"] });
    for (const bad of [undefined, null, 3, {}, { hit: "yes", frames: [] }, { hit: true, frames: [1] }, { hit: true }]) {
      expect(parseSurfaceEvidence(bad)).toBeUndefined();
    }
  });
});

interface FakeNode {
  nodeType: number;
  tagName?: string;
  src?: string;
  parentElement: FakeNode | null;
  ownerDocument: FakeDocument | null;
  matches?: (selector: string) => boolean;
  getAttribute?: (name: string) => string | null;
  getRootNode?: () => { nodeType: number; host?: FakeNode };
}
interface FakeDocument {
  nodeType: 9;
  defaultView: { frameElement: FakeNode | null } | null;
  ownerDocument: null;
}

describe("probeSurfaceEvidence", () => {
  const topDocument: FakeDocument = { nodeType: 9, defaultView: { frameElement: null }, ownerDocument: null };

  function element(tag: string, parent: FakeNode | null, document: FakeDocument, extra: Partial<FakeNode> = {}): FakeNode {
    return {
      nodeType: 1,
      tagName: tag,
      parentElement: parent,
      ownerDocument: document,
      matches: () => false,
      getAttribute: () => null,
      getRootNode: () => ({ nodeType: 9 }),
      ...extra,
    };
  }

  const probe = (start: FakeNode, selectors: string[]) =>
    probeSurfaceEvidence(start as unknown as Node, selectors, false);

  test("reports a selector match on the node or any ancestor", () => {
    const host = element("DIV", null, topDocument, { matches: (selector) => selector === ".frc-captcha" });
    const button = element("BUTTON", element("SPAN", host, topDocument), topDocument);
    expect(probe(button, [".frc-captcha"])).toEqual({ hit: true, frames: [] });
    expect(probe(button, [".other"])).toEqual({ hit: false, frames: [] });
  });

  test("an invalid selector cannot match and does not throw", () => {
    const button = element("BUTTON", null, topDocument, {
      matches: (selector) => {
        if (selector === "!!") throw new Error("SyntaxError");
        return selector === "button";
      },
    });
    expect(probe(button, ["!!", "button"])).toEqual({ hit: true, frames: [] });
  });

  test("crosses a same-origin frame boundary and reports the iframe sources, innermost first", () => {
    const outer = element("IFRAME", null, topDocument, { src: "https://widget.example/outer" });
    const middleDocument: FakeDocument = { nodeType: 9, defaultView: { frameElement: outer }, ownerDocument: null };
    const inner = element("IFRAME", null, middleDocument, { src: "https://challenges.cloudflare.com/inner" });
    const innerDocument: FakeDocument = { nodeType: 9, defaultView: { frameElement: inner }, ownerDocument: null };
    const button = element("BUTTON", null, innerDocument);
    expect(probe(button, [])).toEqual({
      hit: false,
      frames: ["https://challenges.cloudflare.com/inner", "https://widget.example/outer"],
    });
  });

  test("an iframe element target reports its own src, falling back to the attribute", () => {
    const iframe = element("IFRAME", null, topDocument, { getAttribute: (name) => (name === "src" ? "/embedded" : null) });
    expect(probe(iframe, [])).toEqual({ hit: false, frames: ["/embedded"] });
  });

  test("walks out of a shadow root through its host", () => {
    const host = element("DIV", null, topDocument, { matches: (selector) => selector === "altcha-widget" });
    const shadowRoot = { nodeType: 11, host };
    const inShadow = element("INPUT", null, topDocument, { getRootNode: () => shadowRoot });
    expect(probe(inShadow, ["altcha-widget"])).toEqual({ hit: true, frames: [] });
  });

  test("a blocked frameElement read ends the walk instead of throwing", () => {
    const blocked: FakeDocument = {
      nodeType: 9,
      get defaultView(): never {
        throw new Error("cross-origin");
      },
      ownerDocument: null,
    } as unknown as FakeDocument;
    expect(probe(element("BUTTON", null, blocked), [])).toEqual({ hit: false, frames: [] });
  });
});

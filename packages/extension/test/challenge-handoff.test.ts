import { beforeEach, describe, expect, test } from "bun:test";
import { StandardBrowserRuntime } from "../src/browser";
import type { ChallengeEvent, ChallengePageFacts, FrameFact } from "../src/challenge";
import { CHALLENGE_STORAGE_KEY, readTaskEpisodes } from "../src/challenge-store";
import { HandoffController } from "../src/handoff";
import { OwnershipLedger } from "../src/ownership";
import { RevisionTracker } from "../src/revisions";
import { MutationScheduler } from "../src/scheduler";
import { mutateState, readState, resetStateForTest } from "../src/storage";

const TASK = "018f47b8-2f80-7c20-9c77-f8a38c9e621e";
const OTHER_TASK = "018f47b8-2f80-7c20-9c77-f8a38c9e621f";
const TAB = 41;
const OTHER_TAB = 42;
const FOREIGN_TAB = 43;
const GROUP = 5;
const OTHER_GROUP = 6;
const ORIGIN = "https://shop.example";
const TURNSTILE_PATH = "/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0/rcv/";
const TURNSTILE_TOKEN = 'input[name="cf-turnstile-response"]';

function frameFact(host: string, path: string): FrameFact {
  return { host, path, query: {}, origin: `https://${host}`, visible: true, width: 300, height: 65 };
}
const pageFacts = (overrides: Partial<ChallengePageFacts> = {}): ChallengePageFacts => ({
  page_origin: ORIGIN,
  scripts: [],
  frames: [],
  elements: [],
  tokens: [],
  ...overrides,
});
const clean = () => pageFacts();
const turnstileActive = () => pageFacts({ frames: [frameFact("challenges.cloudflare.com", TURNSTILE_PATH)] });
const turnstileSolved = () =>
  pageFacts({
    frames: [frameFact("challenges.cloudflare.com", TURNSTILE_PATH)],
    tokens: [{ selector: TURNSTILE_TOKEN, present: true, non_empty: true }],
  });

let localStore: Record<string, unknown>;
let sessionStore: Record<string, unknown>;
let facts: () => ChallengePageFacts;
let scanCount: number;
let scrubbed: number[];

function installChromeMock(): void {
  localStore = {};
  sessionStore = {};
  facts = clean;
  scanCount = 0;
  scrubbed = [];
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
        async getTargets() { return []; },
        async attach() {},
        async detach() {},
        async sendCommand() { return {}; },
      },
      tabs: {
        async get(tabId: number) {
          return { id: tabId, windowId: 1, groupId: tabId === FOREIGN_TAB ? OTHER_GROUP : GROUP, status: "complete", url: `${ORIGIN}/` };
        },
        async query() { return []; },
        async update(tabId: number, changes: Record<string, unknown>) { return { id: tabId, windowId: 1, ...changes }; },
      },
      alarms: { create() {}, async clear() { return true; } },
      action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
      windows: { async update() { return {}; } },
      scripting: {
        async executeScript(details: { func: { name: string } }) {
          if (details.func.name === "collectChallengeFacts") {
            scanCount += 1;
            return [{ result: structuredClone(facts()) }];
          }
          return [{ result: undefined }];
        },
      },
    },
  });
  resetStateForTest();
}

async function seedTask(taskId: string, tabIds: number[], groupId = GROUP): Promise<void> {
  await mutateState((state) => {
    state.tasks[taskId] = {
      taskId,
      name: `Task ${taskId.slice(0, 8)}`,
      groupId,
      tabIds: [...tabIds],
      createdTabIds: [],
      color: "purple",
      state: "working",
      createdAt: 1,
      updatedAt: 1,
    };
  });
}

interface Harness {
  runtime: StandardBrowserRuntime;
  handoff: HandoffController;
  revisions: RevisionTracker;
}

async function harness(): Promise<Harness> {
  await seedTask(TASK, [TAB, OTHER_TAB]);
  await seedTask(OTHER_TASK, [FOREIGN_TAB], OTHER_GROUP);
  const scheduler = new MutationScheduler();
  const revisions = new RevisionTracker();
  const ownership = new OwnershipLedger(scheduler, revisions, () => undefined);
  const handoff = new HandoffController(scheduler, revisions, ownership);
  handoff.setScrubber(async (tabId) => {
    scrubbed.push(tabId);
  });
  const runtime = new StandardBrowserRuntime(revisions, async () => undefined, () => undefined, async () => undefined);
  handoff.setChallengeScanner((taskId, tabId) => runtime.scanChallengeEpisodes(taskId, tabId));
  for (const tabId of [TAB, OTHER_TAB, FOREIGN_TAB]) await revisions.ensure(tabId);
  return { runtime, handoff, revisions };
}

async function openEpisode(
  runtime: StandardBrowserRuntime,
  page: () => ChallengePageFacts,
  taskId = TASK,
  tabId = TAB,
): Promise<ChallengeEvent> {
  facts = page;
  const scanned = await runtime.scanChallengeEpisodes(taskId, tabId);
  expect(scanned?.event?.state).toBe("active");
  return scanned!.event!;
}

async function requestFor(
  setup: Harness,
  challengeId: string,
  options: { task?: string; tab?: number } = {},
): Promise<Record<string, unknown>> {
  const tabId = options.tab ?? TAB;
  return setup.handoff.request(options.task ?? TASK, {
    operation: "request",
    tab_id: tabId,
    expected_page_revision: await setup.revisions.current(tabId),
    prompt: "Complete the challenge",
    completion: { kind: "challenge_cleared", value: challengeId },
    timeout_ms: 60_000,
  });
}

beforeEach(installChromeMock);

describe("browser_handoff challenge_cleared request", () => {
  test("an unknown, other-task, other-tab, or ended episode is challenge_not_found/not_started and creates no notice", async () => {
    const setup = await harness();
    const event = await openEpisode(setup.runtime, turnstileActive);
    const scrubbedBefore = scrubbed.length;
    for (const attempt of [
      () => requestFor(setup, `chl_${"a".repeat(20)}`),
      () => requestFor(setup, event.challenge_id, { task: OTHER_TASK, tab: FOREIGN_TAB }),
      () => requestFor(setup, event.challenge_id, { tab: OTHER_TAB }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: "challenge_not_found", outcome: "not_started" });
    }

    facts = clean;
    expect((await setup.runtime.scanChallengeEpisodes(TASK, TAB))?.event).toMatchObject({
      challenge_id: event.challenge_id,
      state: "superseded",
    });
    await expect(requestFor(setup, event.challenge_id)).rejects.toMatchObject({
      code: "challenge_not_found",
      outcome: "not_started",
    });
    expect(Object.values((await readState()).notices)).toEqual([]);
    expect(scrubbed.length).toBe(scrubbedBefore);
  });

  test("a malformed challenge id is an invalid request", async () => {
    const setup = await harness();
    await expect(requestFor(setup, "chl_short")).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("binds the notice to the episode so every later event carries notice_id", async () => {
    const setup = await harness();
    const event = await openEpisode(setup.runtime, turnstileActive);
    expect(event.notice_id).toBeUndefined();

    const notice = await requestFor(setup, event.challenge_id);
    const noticeId = String(notice.notice_id);
    expect(notice).toMatchObject({ status: "open", tab_id: TAB });
    expect(Object.values((await readState()).notices)).toContainEqual(
      expect.objectContaining({ noticeId, completion: { kind: "challenge_cleared", value: event.challenge_id } }),
    );

    const stored = await readTaskEpisodes(TASK);
    expect(stored).toMatchObject([{ challenge_id: event.challenge_id, notice_id: noticeId }]);
    const rescanned = await setup.runtime.scanChallengeEpisodes(TASK, TAB);
    expect(rescanned?.event).toMatchObject({ challenge_id: event.challenge_id, state: "active", notice_id: noticeId });

    facts = turnstileSolved;
    const terminal = await setup.runtime.scanChallengeEpisodes(TASK, TAB);
    expect(terminal?.event).toMatchObject({ challenge_id: event.challenge_id, state: "cleared", notice_id: noticeId });
  });

  test("dismissing the notice leaves the episode untouched", async () => {
    const setup = await harness();
    const event = await openEpisode(setup.runtime, turnstileActive);
    const notice = await requestFor(setup, event.challenge_id);
    const before = await readTaskEpisodes(TASK);
    await setup.handoff.dismiss(TASK, String(notice.notice_id));
    expect(await readTaskEpisodes(TASK)).toEqual(before);
    expect(before[0]).toMatchObject({ state: "active", notice_id: notice.notice_id });
  });
});

describe("browser_handoff challenge_cleared resolve", () => {
  test("before the challenge clears, resolve fails with the active event and the notice stays open", async () => {
    const setup = await harness();
    const event = await openEpisode(setup.runtime, turnstileActive);
    const noticeId = String((await requestFor(setup, event.challenge_id)).notice_id);
    const scansBefore = scanCount;

    const failure = await setup.handoff.resolve(TASK, noticeId).then(
      () => undefined,
      (error: unknown) => error as Record<string, unknown>,
    );
    expect(failure).toMatchObject({
      code: "completion_not_met",
      challengeEvent: { challenge_id: event.challenge_id, state: "active", notice_id: noticeId },
    });
    expect(scanCount).toBe(scansBefore + 1);
    expect((await setup.handoff.status(TASK, noticeId)).status).toBe("open");
  });

  test("after the challenge clears, resolve rescans and returns the terminal event with the notice id", async () => {
    const setup = await harness();
    const event = await openEpisode(setup.runtime, turnstileActive);
    const noticeId = String((await requestFor(setup, event.challenge_id)).notice_id);
    facts = turnstileSolved;

    const resolved = await setup.handoff.resolve(TASK, noticeId);
    expect(resolved).toMatchObject({
      notice_id: noticeId,
      status: "resolved",
      challenge: { challenge_id: event.challenge_id, state: "cleared", next: "none", token_present: true, notice_id: noticeId },
    });
    expect((await setup.handoff.status(TASK, noticeId)).status).toBe("resolved");

    const again = await setup.handoff.resolve(TASK, noticeId);
    expect(again).toMatchObject({ status: "resolved", challenge: { state: "cleared", notice_id: noticeId } });
  });

  test("a superseded episode counts as success", async () => {
    const setup = await harness();
    const event = await openEpisode(setup.runtime, turnstileActive);
    const noticeId = String((await requestFor(setup, event.challenge_id)).notice_id);
    facts = clean;
    expect(await setup.handoff.resolve(TASK, noticeId)).toMatchObject({
      status: "resolved",
      challenge: { challenge_id: event.challenge_id, state: "superseded", notice_id: noticeId },
    });
  });

  test("an episode that ended before the rescan still resolves from the stored state", async () => {
    const setup = await harness();
    const event = await openEpisode(setup.runtime, turnstileActive);
    const noticeId = String((await requestFor(setup, event.challenge_id)).notice_id);
    facts = turnstileSolved;
    await setup.runtime.scanChallengeEpisodes(TASK, TAB);
    expect(await setup.handoff.resolve(TASK, noticeId)).toMatchObject({
      status: "resolved",
      challenge: { state: "cleared", notice_id: noticeId },
    });
  });

  test("a notice dismissed before resolve reports no challenge", async () => {
    const setup = await harness();
    const event = await openEpisode(setup.runtime, turnstileActive);
    const noticeId = String((await requestFor(setup, event.challenge_id)).notice_id);
    await setup.handoff.dismiss(TASK, noticeId);
    const result = await setup.handoff.resolve(TASK, noticeId);
    expect(result.status).toBe("dismissed");
    expect(result.challenge).toBeUndefined();
  });

  test("the store key holds the bound notice id in the persisted episode", async () => {
    const setup = await harness();
    const event = await openEpisode(setup.runtime, turnstileActive);
    const noticeId = String((await requestFor(setup, event.challenge_id)).notice_id);
    const table = sessionStore[CHALLENGE_STORAGE_KEY] as Record<string, Array<Record<string, unknown>>>;
    expect(table[TASK]?.[0]?.notice_id).toBe(noticeId);
  });
});

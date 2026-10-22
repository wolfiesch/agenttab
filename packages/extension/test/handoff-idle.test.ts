import { beforeEach, describe, expect, test } from "bun:test";
import { HandoffController } from "../src/handoff";
import { OwnershipLedger } from "../src/ownership";
import { RevisionTracker } from "../src/revisions";
import { MutationScheduler } from "../src/scheduler";
import { mutateState, resetStateForTest } from "../src/storage";

const TASK = "018f47b8-2f80-7c20-9c77-f8a38c9e6301";
const OTHER_TASK = "018f47b8-2f80-7c20-9c77-f8a38c9e6302";
const NOTICE = "notice-idle-1";

let localStore: Record<string, unknown>;
let sessionStore: Record<string, unknown>;
let idleQueries: number[];

function installChromeMock(idle?: { queryState(detectionIntervalInSeconds: number): Promise<string> }): void {
  localStore = {};
  sessionStore = {};
  idleQueries = [];
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
      alarms: { create() {}, async clear() { return true; } },
      ...(idle === undefined ? {} : { idle }),
    },
  });
  resetStateForTest();
}

function idleReporting(state: string) {
  return {
    async queryState(detectionIntervalInSeconds: number) {
      idleQueries.push(detectionIntervalInSeconds);
      return state;
    },
  };
}

function controller(): HandoffController {
  const scheduler = new MutationScheduler();
  const revisions = new RevisionTracker();
  return new HandoffController(scheduler, revisions, new OwnershipLedger(scheduler, revisions, () => undefined));
}

async function seedNotice(overrides: { startedAtMs?: number; expiresAtMs?: number } = {}): Promise<void> {
  await mutateState((state) => {
    state.notices[NOTICE] = {
      noticeId: NOTICE,
      taskId: TASK,
      tabId: 9,
      expectedRevision: 1,
      prompt: "Sign in, then tell the agent.",
      status: "open",
      startedAtMs: overrides.startedAtMs ?? Date.now(),
      expiresAtMs: overrides.expiresAtMs ?? Date.now() + 300_000,
    };
  });
}

beforeEach(() => installChromeMock());

describe("browser_handoff status user idle state", () => {
  for (const state of ["active", "idle", "locked"]) {
    test(`reports ${state} from chrome.idle alongside the notice`, async () => {
      installChromeMock(idleReporting(state));
      await seedNotice();
      const status = await controller().status(TASK, NOTICE);
      expect(status).toMatchObject({ notice_id: NOTICE, task_id: TASK, status: "open", user_idle_state: state });
      expect(idleQueries).toHaveLength(1);
      expect(Number.isInteger(idleQueries[0]) && idleQueries[0]! > 0).toBe(true);
    });
  }

  test("reports idle state for a notice that has already expired", async () => {
    installChromeMock(idleReporting("locked"));
    await seedNotice({ startedAtMs: Date.now() - 10_000, expiresAtMs: Date.now() - 1 });
    await expect(controller().status(TASK, NOTICE)).resolves.toMatchObject({
      status: "expired",
      user_idle_state: "locked",
    });
  });

  test("omits the field when chrome.idle is unavailable or fails", async () => {
    await seedNotice();
    const withoutIdle = await controller().status(TASK, NOTICE);
    expect(withoutIdle).toMatchObject({ notice_id: NOTICE, status: "open" });
    expect("user_idle_state" in withoutIdle).toBe(false);

    installChromeMock({
      async queryState() {
        throw new Error("idle query failed");
      },
    });
    await seedNotice();
    const failed = await controller().status(TASK, NOTICE);
    expect(failed).toMatchObject({ notice_id: NOTICE, status: "open" });
    expect("user_idle_state" in failed).toBe(false);
  });

  test("does not query idle state for another task's notice", async () => {
    installChromeMock(idleReporting("active"));
    await seedNotice();
    await expect(controller().status(OTHER_TASK, NOTICE)).rejects.toMatchObject({ code: "ownership_denied" });
    expect(idleQueries).toEqual([]);
  });

  test("dismiss results carry no idle state", async () => {
    installChromeMock(idleReporting("idle"));
    await seedNotice();
    const dismissed = await controller().dismiss(TASK, NOTICE);
    expect(dismissed).toMatchObject({ status: "dismissed" });
    expect("user_idle_state" in dismissed).toBe(false);
  });
});

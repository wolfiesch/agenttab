import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { AgentPointer } from "../src/pointer";
import { resetStateForTest } from "../src/storage";

const TAB = 7;

interface Injection {
  op: string;
  finish: (result: unknown) => void;
}

let injections: Injection[];

function installChromeMock(): void {
  injections = [];
  const store: Record<string, unknown> = {};
  const storageArea = {
    async get(keys: string | string[] | null) {
      if (keys === null) return structuredClone(store);
      const selected = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(selected.filter((key) => key in store).map((key) => [key, structuredClone(store[key])]));
    },
    async set(values: Record<string, unknown>) {
      Object.assign(store, structuredClone(values));
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
  };
  Object.assign(globalThis, {
    chrome: {
      storage: { local: storageArea, session: storageArea, onChanged: { addListener() {} } },
      scripting: {
        executeScript(details: { args: [{ op: string }] }) {
          const { promise, resolve } = Promise.withResolvers<unknown>();
          injections.push({ op: details.args[0].op, finish: (result) => resolve([{ result }]) });
          return promise;
        },
      },
    },
  });
  resetStateForTest();
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("agent pointer", () => {
  beforeEach(() => {
    installChromeMock();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("conceals a pointer whose injection finishes after the scene timeout", async () => {
    const pointer = new AgentPointer(async () => ({}));
    const announced = pointer.announce(TAB, "Open the bookmarks folder");
    await flush();
    expect(injections.map((injection) => injection.op)).toEqual(["announce"]);

    // The busy page outlasts the scene timeout; the action stops waiting.
    vi.advanceTimersByTime(2_000);
    await announced;

    // A capture taken while that injection is still running must conceal.
    const whilePending = pointer.whileConcealed(TAB, async () => "pending capture");
    await flush();
    expect(injections.map((injection) => injection.op)).toEqual(["announce", "conceal"]);
    injections[1].finish({ shown: false });
    await flush();
    expect(injections.map((injection) => injection.op)).toEqual(["announce", "conceal", "reveal"]);
    injections[2].finish({ shown: false });
    expect(await whilePending).toBe("pending capture");

    // The late injection shows the pointer; later captures still conceal it.
    injections[0].finish({ shown: true, at: { x: 10, y: 20 } });
    await flush();
    const afterArrival = pointer.whileConcealed(TAB, async () => "late capture");
    await flush();
    expect(injections.at(-1)?.op).toBe("conceal");
    injections.at(-1)?.finish({ shown: false });
    await flush();
    injections.at(-1)?.finish({ shown: false });
    expect(await afterArrival).toBe("late capture");
  });

  test("skips concealment once no pointer is shown or pending", async () => {
    const pointer = new AgentPointer(async () => ({}));
    const announced = pointer.announce(TAB, "Scroll page");
    await flush();
    injections[0].finish({ shown: false });
    await announced;

    expect(await pointer.whileConcealed(TAB, async () => "capture")).toBe("capture");
    expect(injections.map((injection) => injection.op)).toEqual(["announce"]);
  });
});

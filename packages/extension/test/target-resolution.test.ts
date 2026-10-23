import { describe, expect, test } from "bun:test";
import { TargetRefRegistry, type TargetBinding, type TargetRefStorage } from "../src/target-resolution";

function memoryStorage(store: Record<string, unknown> = {}): TargetRefStorage & { store: Record<string, unknown>; failWrites: boolean } {
  const area = {
    store,
    failWrites: false,
    async get(keys: string[]) {
      return Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, structuredClone(store[key])]));
    },
    async set(items: Record<string, unknown>) {
      if (area.failWrites) throw new Error("QUOTA_BYTES quota exceeded");
      Object.assign(store, structuredClone(items));
    },
    async remove(keys: string[]) {
      for (const key of keys) delete store[key];
    },
  };
  return area;
}

/** A registry as a service worker sees it; a second one over the same storage is the worker after a restart. */
function registry(storage: TargetRefStorage, liveTabs: number[] = [19, 20]): TargetRefRegistry {
  return new TargetRefRegistry(() => storage, async () => new Set(liveTabs));
}

const baseline: TargetBinding = {
  backendNodeId: 41,
  documentId: "child:loader-1:41",
  frameId: "child",
  pageRevision: 7,
  taskId: "task-a",
  tabId: 19,
};

describe("target bindings", () => {
  test("binds refs to their task, document, frame, and revision", async () => {
    const refs = registry(memoryStorage());
    const ref = refs.mint(baseline);

    expect(await refs.lookup(ref)).toEqual(baseline);
    expect(ref.length).toBeLessThanOrEqual(256);
  });

  test("does not collapse task, frame, document, or revision bindings", () => {
    const refs = registry(memoryStorage());
    const variants = [
      { ...baseline, taskId: "task-b" },
      { ...baseline, frameId: "replacement-frame" },
      { ...baseline, documentId: "child:loader-2:41" },
      { ...baseline, pageRevision: 8 },
      { ...baseline, tabId: 20 },
    ];

    expect(new Set(variants.map((variant) => refs.mint(variant))).has(refs.mint(baseline))).toBe(false);
  });

  test("keeps long bindings opaque and within the public ref contract", async () => {
    const refs = registry(memoryStorage());
    const ref = refs.mint({
      ...baseline,
      documentId: "d".repeat(128),
      frameId: "f".repeat(128),
      taskId: "t".repeat(128),
    });

    expect(ref.length).toBeLessThanOrEqual(256);
    expect(ref).not.toContain("d".repeat(16));
    expect((await refs.lookup(ref))?.documentId).toHaveLength(128);
  });

  test("rejects malformed or unknown target refs", async () => {
    const refs = registry(memoryStorage());
    expect(await refs.lookup("r7-41")).toBeNull();
    expect(await refs.lookup("rt1.invalid*")).toBeNull();
    expect(await refs.lookup(undefined)).toBeNull();
  });
});

describe("target refs across service worker restarts", () => {
  test("resolve refs minted and stored before the restart", async () => {
    const storage = memoryStorage();
    const before = registry(storage);
    const top = before.mint(baseline);
    const scripted = before.mint({ ...baseline, tabId: 20, frameId: "scripting", route: "scripting" });
    await before.persist();

    const after = registry(storage);
    expect(await after.lookup(top)).toEqual(baseline);
    expect(await after.lookup(scripted)).toEqual({ ...baseline, tabId: 20, frameId: "scripting", route: "scripting" });
  });

  test("keep stored refs when the new worker mints before its first lookup", async () => {
    const storage = memoryStorage();
    const before = registry(storage);
    const old = before.mint(baseline);
    await before.persist();

    const after = registry(storage);
    const fresh = after.mint({ ...baseline, backendNodeId: 42 });
    await after.persist();

    const later = registry(storage);
    expect(await later.lookup(old)).toEqual(baseline);
    expect((await later.lookup(fresh))?.backendNodeId).toBe(42);
  });

  test("drop refs for tabs closed while no worker was running", async () => {
    const storage = memoryStorage();
    const before = registry(storage);
    const closed = before.mint(baseline);
    const open = before.mint({ ...baseline, tabId: 20 });
    await before.persist();

    const after = registry(storage, [20]);
    expect(await after.lookup(closed)).toBeNull();
    expect(await after.lookup(open)).not.toBeNull();
    await after.persist();
    expect(Object.keys(storage.store).sort()).toEqual(["agenttab.targetRefs", "agenttab.targetRefs.20"]);
  });

  test("drop a tab's refs once it mints refs for a newer page revision", async () => {
    const storage = memoryStorage();
    const refs = registry(storage);
    const stale = refs.mint(baseline);
    const current = refs.mint({ ...baseline, pageRevision: 8 });
    await refs.persist();

    expect(await refs.lookup(stale)).toBeNull();
    const after = registry(storage);
    expect(await after.lookup(stale)).toBeNull();
    expect((await after.lookup(current))?.pageRevision).toBe(8);
  });

  test("forget a closed tab and clear everything at browser start", async () => {
    const storage = memoryStorage();
    const refs = registry(storage);
    const closing = refs.mint(baseline);
    const staying = refs.mint({ ...baseline, tabId: 20 });
    await refs.persist();

    await refs.forgetTab(19);
    expect(await registry(storage).lookup(closing)).toBeNull();
    expect(await registry(storage).lookup(staying)).not.toBeNull();

    await refs.clear();
    expect(storage.store).toEqual({});
    expect(await refs.lookup(staying)).toBeNull();
  });

  test("retry a failed write on the next persist", async () => {
    const storage = memoryStorage();
    const refs = registry(storage);
    const ref = refs.mint(baseline);
    storage.failWrites = true;
    await expect(refs.persist()).rejects.toThrow("quota");
    storage.failWrites = false;
    await refs.persist();

    expect(await registry(storage).lookup(ref)).toEqual(baseline);
  });

  test("ignore malformed stored rows", async () => {
    const storage = memoryStorage({
      "agenttab.targetRefs": [19],
      "agenttab.targetRefs.19": {
        documents: ["doc"],
        frames: ["frame"],
        tasks: ["task"],
        refs: [["good", 41, 0, 0, 7, 0, 0], ["bad-document", 41, 3, 0, 7, 0, 0], ["bad-node", "41", 0, 0, 7, 0, 0]],
      },
    });
    const refs = registry(storage);

    expect(await refs.lookup("rt1.good")).toEqual({
      backendNodeId: 41, documentId: "doc", frameId: "frame", pageRevision: 7, taskId: "task", tabId: 19,
    });
    expect(await refs.lookup("rt1.bad-document")).toBeNull();
    expect(await refs.lookup("rt1.bad-node")).toBeNull();
  });
});

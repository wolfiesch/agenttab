import { describe, expect, test } from "bun:test";
import { mintTargetRef, parseTargetRef } from "../src/target-resolution";

describe("target bindings", () => {
  test("binds refs to their task, document, frame, and revision", () => {
    const ref = mintTargetRef({
      backendNodeId: 41,
      documentId: "child:loader-1:41",
      frameId: "child",
      pageRevision: 7,
      taskId: "task-a",
      tabId: 19,
    });

    expect(parseTargetRef(ref)).toEqual({
      backendNodeId: 41,
      documentId: "child:loader-1:41",
      frameId: "child",
      pageRevision: 7,
      taskId: "task-a",
      tabId: 19,
    });
    expect(ref.length).toBeLessThanOrEqual(256);
  });

  test("does not collapse task, frame, document, or revision bindings", () => {
    const baseline = {
      backendNodeId: 41,
      documentId: "child:loader-1:41",
      frameId: "child",
      pageRevision: 7,
      taskId: "task-a",
      tabId: 19,
    };
    const variants = [
      { ...baseline, taskId: "task-b" },
      { ...baseline, frameId: "replacement-frame" },
      { ...baseline, documentId: "child:loader-2:41" },
      { ...baseline, pageRevision: 8 },
      { ...baseline, tabId: 20 },
    ];

    expect(new Set(variants.map(mintTargetRef)).has(mintTargetRef(baseline))).toBe(false);
  });

  test("keeps long bindings opaque and within the public ref contract", () => {
    const ref = mintTargetRef({
      backendNodeId: 41,
      documentId: "d".repeat(128),
      frameId: "f".repeat(128),
      pageRevision: 7,
      taskId: "t".repeat(128),
      tabId: 19,
    });

    expect(ref.length).toBeLessThanOrEqual(256);
    expect(ref).not.toContain("d".repeat(16));
    expect(parseTargetRef(ref)?.documentId).toHaveLength(128);
  });

  test("rejects malformed or tampered target refs", () => {
    expect(parseTargetRef("r7-41")).toBeNull();
    expect(parseTargetRef("rt1.invalid*")).toBeNull();
  });
});

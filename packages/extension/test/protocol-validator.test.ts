import { describe, expect, test } from "bun:test";
import { NATIVE_PROTOCOL, parseCommand, PROTOCOL_VERSION } from "../src/protocol";

const ID = "018f47b8-2f80-7c20-9c77-f8a38c9e621e";

function command(method: string, params: Record<string, unknown>): unknown {
  return {
    protocol: NATIVE_PROTOCOL,
    version: PROTOCOL_VERSION,
    kind: "command",
    request_id: ID,
    connection_id: ID,
    task_id: ID,
    method,
    params,
  };
}

describe("native protocol reliability contracts", () => {
  test("accepts scoped gestures, editor chords, prompt payloads, and download expectations", () => {
    expect(() => parseCommand(command("browser_act", {
      tab_id: 1,
      expected_page_revision: 2,
      actions: [
        { kind: "double_click", ref: "rt1.target", frame_id: "frame-1", expect_download: true },
        { kind: "press", selector: "input", key: "z", modifiers: ["Control", "Shift"] },
        { kind: "dialog", decision: "accept", prompt_text: "answer" },
      ],
    }))).not.toThrow();
    expect(() => parseCommand(command("browser_wait", {
      tab_id: 1,
      condition: { kind: "value", selector: "input", value: "ready", frame_id: "frame-1" },
    }))).not.toThrow();
  });

  test("rejects unsafe chords and unsupported fields", () => {
    for (const action of [
      { kind: "press", ref: "rt1.target", key: "a" },
      { kind: "hover", ref: "rt1.target", expect_download: true },
      { kind: "dialog", decision: "dismiss", prompt_text: "forbidden" },
    ]) {
      expect(() => parseCommand(command("browser_act", {
        tab_id: 1,
        expected_page_revision: 2,
        actions: [action],
      }))).toThrow();
    }
    expect(() => parseCommand(command("browser_wait", {
      tab_id: 1,
      condition: { kind: "download", after: "" },
    }))).toThrow();
  });
});

describe("browser_snapshot accessibility query", () => {
  test("accepts optional predicates with frame and root scoping", () => {
    for (const query of [{}, { role: "BUTTON" }, { name: "message" }, { role: "button", name: "More message options" }]) {
      expect(parseCommand(command("browser_snapshot", {
        tab_id: 1, mode: "accessibility", frame_id: "frame-1", root_ref: "rt1.root", max_nodes: 1, query,
      })).params.query).toEqual(query);
    }
  });

  test("rejects invalid predicates and query in every other mode", () => {
    for (const query of [
      null, [], "button", 1, { role: null }, { name: null }, { role: 1 }, { name: true },
      { role: "" }, { name: "" }, { role: "x".repeat(257) }, { name: "x".repeat(2049) },
      { description: "message" }, { role: "button", extra: true },
    ]) {
      expect(() => parseCommand(command("browser_snapshot", { tab_id: 1, mode: "accessibility", query }))).toThrow();
    }
    for (const mode of ["text", "html", "screenshot"]) {
      expect(() => parseCommand(command("browser_snapshot", { tab_id: 1, mode, query: { role: "button" } }))).toThrow();
    }
  });
});

describe("browser_handoff challenge_cleared completion", () => {
  const request = (completion: unknown) =>
    command("browser_handoff", {
      operation: "request",
      tab_id: 1,
      expected_page_revision: 2,
      prompt: "Complete the challenge",
      completion,
    });

  test("accepts a challenge id value", () => {
    const completion = { kind: "challenge_cleared", value: "chl_3k9w2m7q8x1v5b0n4c6z" };
    expect(parseCommand(request(completion)).params.completion).toEqual(completion);
  });

  test("rejects malformed ids, missing values, and extra keys", () => {
    for (const completion of [
      { kind: "challenge_cleared" },
      { kind: "challenge_cleared", value: "chl_short" },
      { kind: "challenge_cleared", value: "xyz_3k9w2m7q8x1v5b0n4c6z" },
      { kind: "challenge_cleared", value: "chl_3K9W2M7Q8X1V5B0N4C6Z" },
      { kind: "challenge_cleared", value: "chl_3k9w2m7q8x1v5b0n4c6zz" },
      { kind: "challenge_cleared", value: "chl_3k9w2m7q8x1v5b0n4c6z", extra: true },
      { kind: "challenge_cleared", challenge_id: "chl_3k9w2m7q8x1v5b0n4c6z" },
    ]) {
      expect(() => parseCommand(request(completion))).toThrow();
    }
  });
});

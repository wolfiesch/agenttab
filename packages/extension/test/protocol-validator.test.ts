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

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { extractAssistantTurn, nextAssistantProgress } from "../src/driver.js";

describe("extractAssistantTurn", () => {
  test("returns only assistant prose and approved generated images", () => {
    const turn = extractAssistantTurn(`
      <div data-message-author-role="assistant">
        <div class="markdown"><p>Hello <strong>world</strong>.</p></div>
        <img src="https://files.oaiusercontent.com/generated/image.png">
        <img src="https://example.com/tracker.png">
        <button>Copy</button>
      </div>
    `);
    expect(turn.text).toBe("Hello world.");
    expect(turn.imageUrls).toEqual(["https://files.oaiusercontent.com/generated/image.png"]);
    expect(turn.fingerprint).toBe("Hello world.\u0000https://files.oaiusercontent.com/generated/image.png");
  });

  test("rejects deceptive generated-image hostnames", () => {
    const turn = extractAssistantTurn(`
      <div class="markdown">Image only</div>
      <img src="https://oaiusercontent.com.attacker.example/image.png">
    `);
    expect(turn.imageUrls).toEqual([]);
  });
});

describe("nextAssistantProgress", () => {
  test("keeps waiting when polling still sees the previous assistant turn", () => {
    expect(nextAssistantProgress({
      assistantCount: 2,
      lastAssistantFingerprint: "previous",
      awaitingAssistant: true,
    }, "previous")).toBeUndefined();
  });

  test("counts and records a new assistant turn", () => {
    expect(nextAssistantProgress({
      assistantCount: 2,
      lastAssistantFingerprint: "previous",
      awaitingAssistant: true,
    }, "next")).toEqual({
      assistantCount: 3,
      lastAssistantFingerprint: "next",
      awaitingAssistant: false,
    });
  });

  test("records baseline content without incrementing the assistant count", () => {
    expect(nextAssistantProgress({
      assistantCount: 0,
      lastAssistantFingerprint: "",
      awaitingAssistant: false,
    }, "baseline")).toEqual({
      assistantCount: 0,
      lastAssistantFingerprint: "baseline",
      awaitingAssistant: false,
    });
  });
});

test("rejects browser sessions outside the GPT-Control ownership namespace", async () => {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../src/driver.ts")],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  child.stdin.write(JSON.stringify({
    version: 1,
    action: "create",
    params: { name: "foreign-session", url: "https://example.com" },
  }));
  child.stdin.end();

  const response = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(1);
  expect(response).toEqual({
    version: 1,
    ok: false,
    error: "name must start with gpt-control:",
  });
});

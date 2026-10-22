import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAssistantTurn, findDownloadedImage, nextAssistantProgress, shareLabelFor } from "../src/driver.js";

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

  test("reads image-only turns: ChatGPT blob images, no control labels", () => {
    const turn = extractAssistantTurn(`
      <div data-testid="generated-image-gallery">
        <button aria-label="Generated image 1"><img src="blob:https://chatgpt.com/6a8feb64-4550-4148-ab34-4a3101d26886"></button>
        <button aria-label="Edit generated image 1">Edit</button>
        <img src="blob:https://attacker.example/6a8feb64-4550-4148-ab34-4a3101d26886">
      </div>
    `);
    expect(turn.text).toBe("");
    expect(turn.imageUrls).toEqual(["blob:https://chatgpt.com/6a8feb64-4550-4148-ab34-4a3101d26886"]);
  });

  test("recognizes authenticated ChatGPT generated images", () => {
    const url = "https://chatgpt.com/backend-api/estuary/content?id=file_fixture&sig=fixture";
    const turn = extractAssistantTurn(`
      <div data-testid="generated-image-gallery">
        <button aria-label="Generated image 1"><img alt="Generated image 1" src="${url}"></button>
        <button>Edit</button>
      </div>
    `);
    expect(turn.imageUrls).toEqual([url]);
    expect(turn.text).toBe("");
  });

  test.each([
    "https://chatgpt.com.attacker.example/backend-api/estuary/content?id=file_fixture",
    "https://chatgpt.com/backend-api/account?id=file_fixture",
    "https://chatgpt.com/backend-api/estuary/content",
    "http://chatgpt.com/backend-api/estuary/content?id=file_fixture",
    "https://user@chatgpt.com/backend-api/estuary/content?id=file_fixture",
  ])("rejects non-image or untrusted endpoint %s", (url) => {
    expect(extractAssistantTurn(`<img src="${url}">`).imageUrls).toEqual([]);
  });
});

test("selects newly named images while excluding old, partial, and symlink files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "image-download-"));
  try {
    const expected = "Sunlit Fox and Blue Teacup.png";
    await writeFile(join(directory, expected), "existing");
    await writeFile(join(directory, "Sunlit Fox and Blue Teacup (1).png.crdownload"), "partial");
    await symlink(join(directory, expected), join(directory, "Sunlit Fox and Blue Teacup (3).png"));
    await writeFile(join(directory, "unrelated.png"), "unrelated concurrent download");
    const downloaded = join(directory, "Sunlit Fox and Blue Teacup (1).png");
    await writeFile(downloaded, "new");
    expect(await findDownloadedImage(directory, new Set([expected]), 0, expected)).toBe(downloaded);
    await writeFile(join(directory, "Sunlit Fox and Blue Teacup (2).png"), "other");
    await expect(findDownloadedImage(directory, new Set([expected]), 0, expected)).rejects.toThrow("found 2");
    await expect(findDownloadedImage(directory, new Set([expected]), Date.now() + 60_000, expected)).rejects.toThrow("found 0");
    await expect(findDownloadedImage(directory, new Set(), 0, "../outside.png")).rejects.toThrow("safe PNG");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("shareLabelFor", () => {
  const first = "blob:https://chatgpt.com/6a8feb64-4550-4148-ab34-4a3101d26886";
  const second = "https://chatgpt.com/backend-api/estuary/content?id=file_2";
  const gallery = `
    <div data-testid="generated-image-gallery">
      <button aria-label="Generated image 1"><img src="${first}"></button>
      <button aria-label="Edit generated image 1"></button>
      <button aria-label="Share generated image 1"></button>
      <button aria-label="Generated image 2"><img alt="Generated image 2" src="${second}"></button>
      <button aria-label="Share generated image 2"></button>
    </div>`;

  test("maps each image, including one labeled only on its button, to its own Share button", () => {
    expect(shareLabelFor(gallery, first)).toBe("Share generated image 1");
    expect(shareLabelFor(gallery, second)).toBe("Share generated image 2");
  });

  test("rejects images that are absent or whose Share buttons do not line up", () => {
    expect(() => shareLabelFor(gallery, "blob:https://chatgpt.com/00000000-0000-4000-8000-000000000000")).toThrow("no longer");
    expect(() => shareLabelFor(gallery.replace('<button aria-label="Share generated image 2"></button>', ""), second))
      .toThrow("Found 1 image share buttons for 2 generated images");
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

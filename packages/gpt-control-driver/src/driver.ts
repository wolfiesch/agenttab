#!/usr/bin/env node
import {
  AgentTabClient,
  AgentTabError,
  createResumeCapabilityStore,
  type BrowserAction,
} from "../../sdk-typescript/src/index.js";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parse } from "node-html-parser";

const COMMIT_REVIEW_TIMEOUT_MS = 300_000;
const COMMIT_REVIEW_POLL_MS = 500;
const STATE_DIRECTORY = join(process.env.AGENTTAB_STATE_DIR ?? join(homedir(), ".agenttab"), "gpt-control");
const PROTOCOL_VERSION = 1;
// ChatGPT marks each assistant reply with a screen-reader heading followed by the reply body. The older
// `data-message-author-role` attribute survives only on an empty placeholder, so it is the fallback.
const ASSISTANT_SELECTORS = ['h4[data-conversation-role="assistant"] + *', '[data-message-author-role="assistant"]'] as const;
// Present only while ChatGPT is still streaming text or rendering an image.
const BUSY_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop" i]';
const CHATGPT_ORIGIN = "https://chatgpt.com";
const DOWNLOAD_DIRECTORY = process.env.AGENTTAB_DOWNLOAD_DIR ?? join(homedir(), "Downloads");
const DOWNLOAD_NAME_PATTERN = /^ChatGPT Image .*\.png$/;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const FILE_INPUT_SELECTOR = 'input[type="file"]';
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_HOSTS = ["oaiusercontent.com", "files.openai.com"] as const;
const BLOB_IMAGE_PATTERN = /^blob:https:\/\/chatgpt\.com\/[0-9a-f-]{36}$/i;

interface DriverRequest {
  version: number;
  action: string;
  params: Record<string, unknown>;
}

export interface DriverSession {
  sessionId: string;
  pageId: number;
  name: string;
  url: string;
}

interface SessionMetadata extends DriverSession {
  schemaVersion: 1;
  assistantCount: number;
  lastAssistantFingerprint: string;
  awaitingAssistant: boolean;
  state: "working" | "needs_user" | "completed";
}

interface AccessibilityNode {
  ref?: string;
  role?: string;
  name?: string;
}

interface AccessibilitySnapshot {
  page_revision: number;
  nodes: AccessibilityNode[];
}

interface HtmlSnapshot {
  page_revision: number;
  content: string;
}

interface ScreenshotSnapshot {
  data: string;
}

function sessionPath(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("Invalid GPT-Control browser session id");
  return join(STATE_DIRECTORY, `${sessionId}.json`);
}

async function prepareStateDirectory(): Promise<void> {
  const directory = STATE_DIRECTORY;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`AgentTab GPT-Control state path is not a regular directory: ${directory}`);
  }
  if (platform() !== "win32" && (metadata.mode & 0o077) !== 0) await chmod(directory, 0o700);
}

function validMetadata(value: unknown): value is SessionMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schemaVersion === 1
    && typeof candidate.sessionId === "string"
    && SESSION_ID_PATTERN.test(candidate.sessionId)
    && Number.isInteger(candidate.pageId)
    && Number(candidate.pageId) >= 0
    && typeof candidate.name === "string"
    && candidate.name.startsWith("gpt-control:")
    && typeof candidate.url === "string"
    && Number.isInteger(candidate.assistantCount)
    && Number(candidate.assistantCount) >= 0
    && typeof candidate.lastAssistantFingerprint === "string"
    && typeof candidate.awaitingAssistant === "boolean"
    && (candidate.state === "working" || candidate.state === "needs_user" || candidate.state === "completed");
}

async function readMetadata(sessionId: string): Promise<SessionMetadata> {
  const path = sessionPath(sessionId);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`AgentTab GPT-Control session state is not a regular file: ${path}`);
  }
  if (platform() !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`AgentTab GPT-Control session state must be owner-only (0600): ${path}`);
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!validMetadata(parsed) || parsed.sessionId !== sessionId) {
    throw new Error(`AgentTab GPT-Control session state is invalid: ${path}`);
  }
  return parsed;
}

async function writeMetadata(metadata: SessionMetadata): Promise<void> {
  await prepareStateDirectory();
  const path = sessionPath(metadata.sessionId);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    if (platform() !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}


async function connectSession(sessionId: string): Promise<AgentTabClient> {
  return AgentTabClient.connect({
    conversationId: `gpt-control:${sessionId}`,
    capabilityStore: createResumeCapabilityStore("gpt_control", { scope: sessionId }),
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== "string") throw new Error(`${field} must be a string`);
  return value[field];
}

function sessionField(value: Record<string, unknown>): DriverSession {
  const session = record(value.session, "session");
  const pageId = session.pageId;
  if (!Number.isInteger(pageId) || Number(pageId) < 0) throw new Error("session.pageId must be a non-negative integer");
  return {
    sessionId: stringField(session, "sessionId"),
    pageId: Number(pageId),
    name: stringField(session, "name"),
    url: stringField(session, "url"),
  };
}

async function tabRevision(client: AgentTabClient, tabId: number): Promise<number> {
  const snapshot = await client.call<"browser_snapshot", AccessibilitySnapshot>("browser_snapshot", {
    tab_id: tabId,
    mode: "accessibility",
    max_depth: 2,
    max_nodes: 10,
  });
  if (!Number.isInteger(snapshot.page_revision)) throw new Error("AgentTab snapshot omitted page_revision");
  return snapshot.page_revision;
}

async function completeAction(
  client: AgentTabClient,
  tabId: number,
  pageRevision: number,
  actions: BrowserAction[],
): Promise<void> {
  const response = await client.request("browser_act", {
    tab_id: tabId,
    expected_page_revision: pageRevision,
    actions,
  });
  if (!response.ok) throw new AgentTabError(response);
  if (response.outcome === "completed") return;
  if (response.outcome !== "commit_required") {
    throw new Error(`AgentTab browser_act returned unexpected outcome ${response.outcome}`);
  }
  const staged = record(response.result, "staged browser action");
  const stagedToken = stringField(staged, "staged_token");
  const deadline = Date.now() + COMMIT_REVIEW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const committed = await client.request("browser_commit", { staged_token: stagedToken });
    if (!committed.ok) throw new AgentTabError(committed);
    if (committed.outcome === "completed") return;
    if (committed.outcome !== "commit_required") {
      throw new Error(`AgentTab browser_commit returned unexpected outcome ${committed.outcome}`);
    }
    await new Promise((resolve) => setTimeout(resolve, COMMIT_REVIEW_POLL_MS));
  }
  throw new Error(
    `AgentTab Commit review was not approved within ${COMMIT_REVIEW_TIMEOUT_MS} ms; approve the staged action in the AgentTab popup and retry`,
  );
}

async function waitForComposer(client: AgentTabClient, tabId: number, timeoutMs: number): Promise<AccessibilitySnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastNodes: AccessibilityNode[] = [];
  while (Date.now() < deadline) {
    const snapshot = await client.call<"browser_snapshot", AccessibilitySnapshot>("browser_snapshot", {
      tab_id: tabId,
      mode: "accessibility",
      max_depth: 80,
      max_nodes: 5_000,
    });
    lastNodes = snapshot.nodes;
    if (findComposer(snapshot.nodes)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const names = lastNodes.map((node) => node.name).filter(Boolean).slice(-10).join(", ");
  throw new Error(`ChatGPT prompt composer did not appear within ${timeoutMs} ms${names ? `; last controls: ${names}` : ""}`);
}

function findComposer(nodes: AccessibilityNode[]): AccessibilityNode | undefined {
  const textboxes = nodes.filter((node) => node.role === "textbox" && typeof node.ref === "string");
  return textboxes.find((node) => /message|ask|prompt|chatgpt/i.test(node.name ?? "")) ?? textboxes.at(-1);
}

function findSendButton(nodes: AccessibilityNode[]): AccessibilityNode | undefined {
  const buttons = nodes.filter((node) => node.role === "button" && typeof node.ref === "string");
  return buttons.find((node) => /^(send|send prompt|send message)$/i.test((node.name ?? "").trim()))
    ?? buttons.find((node) => /send/i.test(node.name ?? ""));
}

async function createSession(name: string, url: string): Promise<DriverSession> {
  if (!name.startsWith("gpt-control:")) throw new Error("name must start with gpt-control:");
  const sessionId = randomUUID();
  const client = await connectSession(sessionId);
  try {
    const opened = await client.call<"browser_open", Record<string, unknown>>("browser_open", {
      mode: "create",
      url,
      placement: "task",
      background: true,
    });
    const pageId = opened.tab_id;
    if (!Number.isInteger(pageId) || Number(pageId) < 0) throw new Error("AgentTab browser_open omitted tab_id");
    await client.call("browser_wait", {
      tab_id: Number(pageId),
      condition: { kind: "load" },
      timeout_ms: 60_000,
    }, { timeoutMs: 70_000 });
    const session: DriverSession = { sessionId, pageId: Number(pageId), name, url };
    await writeMetadata({
      ...session,
      schemaVersion: 1,
      assistantCount: 0,
      lastAssistantFingerprint: "",
      awaitingAssistant: false,
      state: "working",
    });
    return session;
  } catch (error) {
    await client.closeTask().catch(() => undefined);
    throw error;
  } finally {
    client.close();
  }
}

async function showSession(sessionId: string): Promise<DriverSession> {
  const metadata = await readMetadata(sessionId);
  const client = await connectSession(sessionId);
  try {
    const result = await client.call<"browser_tabs", { tabs: Array<Record<string, unknown>> }>("browser_tabs", {});
    const tab = result.tabs.find((candidate) => candidate.tab_id === metadata.pageId);
    if (!tab) throw new Error(`AgentTab task ${sessionId} no longer owns page ${metadata.pageId}`);
    const url = typeof tab.url === "string" ? tab.url : metadata.url;
    if (url !== metadata.url) await writeMetadata({ ...metadata, url });
    return { sessionId, pageId: metadata.pageId, name: metadata.name, url };
  } finally {
    client.close();
  }
}

async function uploadFiles(session: DriverSession, files: readonly string[]): Promise<void> {
  if (files.length === 0) return;
  for (const file of files) {
    if (!isAbsolute(file)) throw new Error(`Attachment path must be absolute: ${file}`);
  }
  const client = await connectSession(session.sessionId);
  try {
    const revision = await tabRevision(client, session.pageId);
    await completeAction(client, session.pageId, revision, [{
      kind: "upload_file",
      selector: FILE_INPUT_SELECTOR,
      files: [...files],
    }]);
  } finally {
    client.close();
  }
}

async function submitPrompt(session: DriverSession, prompt: string): Promise<void> {
  const client = await connectSession(session.sessionId);
  try {
    const composerSnapshot = await waitForComposer(client, session.pageId, 60_000);
    const composer = findComposer(composerSnapshot.nodes);
    if (!composer?.ref) throw new Error("ChatGPT prompt composer has no AgentTab ref");
    await completeAction(client, session.pageId, composerSnapshot.page_revision, [{
      kind: "fill",
      ref: composer.ref,
      text: prompt,
    }]);

    const sendSnapshot = await waitForComposer(client, session.pageId, 30_000);
    const sendButton = findSendButton(sendSnapshot.nodes);
    if (!sendButton?.ref) throw new Error("ChatGPT send button did not appear after filling the prompt");
    await completeAction(client, session.pageId, sendSnapshot.page_revision, [{
      kind: "click",
      ref: sendButton.ref,
    }]);
    const metadata = await readMetadata(session.sessionId);
    await writeMetadata({ ...metadata, awaitingAssistant: true, state: "working" });
  } finally {
    client.close();
  }
}

function approvedImageUrl(raw: string): string | undefined {
  // Generated images render from same-origin blob URLs; only the page can resolve them (see saveImage).
  if (BLOB_IMAGE_PATTERN.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase();
  return IMAGE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? url.href : undefined;
}

export function extractAssistantTurn(html: string): { text: string; imageUrls: string[]; fingerprint: string } {
  const root = parse(html);
  const images: string[] = [];
  const seen = new Set<string>();
  for (const image of root.querySelectorAll("img")) {
    const approved = approvedImageUrl(image.getAttribute("src") ?? "");
    if (!approved || seen.has(approved)) continue;
    seen.add(approved);
    images.push(approved);
  }
  // Image turns have no `.markdown` body; their buttons ("Edit", share) are controls, not model output.
  const content = root.querySelector(".markdown") ?? root;
  if (content === root) for (const control of root.querySelectorAll("button")) control.remove();
  const text = content.structuredText
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, imageUrls: images, fingerprint: `${text}\u0000${images.join(",")}` };
}

export function nextAssistantProgress(
  current: { assistantCount: number; lastAssistantFingerprint: string; awaitingAssistant: boolean },
  fingerprint: string,
): { assistantCount: number; lastAssistantFingerprint: string; awaitingAssistant: false } | undefined {
  if (fingerprint === current.lastAssistantFingerprint) return undefined;
  return {
    assistantCount: current.assistantCount + (current.awaitingAssistant ? 1 : 0),
    lastAssistantFingerprint: fingerprint,
    awaitingAssistant: false,
  };
}

/**
 * Returns the outerHTML of the first or last match, or undefined when nothing matches. Depending on the
 * extension build a miss is either a `Selector did not match` error or empty content; a real element's
 * outerHTML is never empty, so both mean the same thing.
 */
async function matchedHtml(
  client: AgentTabClient,
  tabId: number,
  selector: string,
  match: "first" | "last",
  maxBytes: number,
): Promise<string | undefined> {
  try {
    const snapshot = await client.call<"browser_snapshot", HtmlSnapshot>("browser_snapshot", {
      tab_id: tabId,
      mode: "html",
      selector,
      match,
      max_bytes: maxBytes,
    });
    return snapshot.content || undefined;
  } catch (error) {
    if (error instanceof AgentTabError && error.code === "snapshot_failed" && /Selector did not match/.test(error.message)) return undefined;
    throw error;
  }
}

async function readAssistant(session: DriverSession): Promise<{ count: number; text: string; imageUrls: string[] }> {
  const client = await connectSession(session.sessionId);
  try {
    const metadata = await readMetadata(session.sessionId);
    const unchanged = { count: metadata.assistantCount, text: "", imageUrls: [] };
    // A turn that is still streaming, or an image still rendering progressive previews, is not a reply yet.
    if (await matchedHtml(client, session.pageId, BUSY_SELECTOR, "first", 256)) return unchanged;
    let html: string | undefined;
    for (const selector of ASSISTANT_SELECTORS) {
      html = await matchedHtml(client, session.pageId, selector, "last", 1_000_000);
      if (html) break;
    }
    if (!html) return unchanged;
    const turn = extractAssistantTurn(html);
    const progress = nextAssistantProgress(metadata, turn.fingerprint);
    if (progress) await writeMetadata({ ...metadata, ...progress });
    return {
      count: progress?.assistantCount ?? metadata.assistantCount,
      text: turn.text,
      imageUrls: turn.imageUrls,
    };
  } finally {
    client.close();
  }
}

async function waitForDownload(since: number): Promise<string> {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const name of await readdir(DOWNLOAD_DIRECTORY)) {
      if (!DOWNLOAD_NAME_PATTERN.test(name)) continue;
      const path = join(DOWNLOAD_DIRECTORY, name);
      const info = await stat(path).catch(() => undefined);
      if (info?.isFile() && info.birthtimeMs >= since && info.size > 0) return path;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 250);
    await promise;
  }
  throw new Error(`ChatGPT image download did not appear in ${DOWNLOAD_DIRECTORY} within ${DOWNLOAD_TIMEOUT_MS} ms; set AGENTTAB_DOWNLOAD_DIR if Chrome saves elsewhere`);
}

async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(source, destination);
    await rm(source, { force: true });
  }
}

async function buttonNodes(client: AgentTabClient, tabId: number, name: RegExp): Promise<{ revision: number; buttons: AccessibilityNode[] }> {
  const snapshot = await client.call<"browser_snapshot", AccessibilitySnapshot>("browser_snapshot", {
    tab_id: tabId,
    mode: "accessibility",
    max_depth: 80,
    max_nodes: 5_000,
  });
  const buttons = snapshot.nodes.filter((node) => node.role === "button" && typeof node.ref === "string" && name.test(node.name ?? ""));
  return { revision: snapshot.page_revision, buttons };
}

/**
 * Saves a generated image at full resolution. Its blob URL resolves only inside the page, so the image is
 * downloaded through ChatGPT's own share dialog and moved from Chrome's download directory to `outputPath`.
 */
async function saveImage(session: DriverSession, url: string, outputPath: string): Promise<string> {
  if (!isAbsolute(outputPath)) throw new Error("Image output path must be absolute");
  if (!BLOB_IMAGE_PATTERN.test(url)) throw new Error("save_image accepts only ChatGPT blob image URLs");
  const client = await connectSession(session.sessionId);
  try {
    // Standard actions target accessibility refs, so the image's share button is found by document position:
    // the Nth generated image in the thread owns the Nth "Share generated image" button.
    const thread = await matchedHtml(client, session.pageId, "main", "last", 1_000_000);
    if (!thread) throw new Error("ChatGPT thread is not rendered");
    const sources = parse(thread)
      .querySelectorAll('[data-testid="generated-image-gallery"] img[alt^="Generated image"]')
      .map((image) => image.getAttribute("src"));
    const index = sources.lastIndexOf(url);
    if (index < 0) throw new Error("Generated image is no longer in the ChatGPT thread");
    const share = await buttonNodes(client, session.pageId, /^Share generated image \d+$/);
    if (share.buttons.length !== sources.length) {
      throw new Error(`Found ${share.buttons.length} image share buttons for ${sources.length} generated images`);
    }
    const since = Date.now();
    await completeAction(client, session.pageId, share.revision, [{ kind: "click", ref: share.buttons[index].ref! }]);
    await client.call("browser_wait", {
      tab_id: session.pageId,
      condition: { kind: "selector", value: '[role="dialog"] button[aria-label="Download"]' },
      timeout_ms: 10_000,
    }, { timeoutMs: 20_000 });
    const download = await buttonNodes(client, session.pageId, /^Download$/);
    const button = download.buttons.at(-1);
    if (!button?.ref) throw new Error("ChatGPT share dialog has no Download button");
    await completeAction(client, session.pageId, download.revision, [{ kind: "click", ref: button.ref }]);
    const downloaded = await waitForDownload(since);
    await mkdir(dirname(outputPath), { recursive: true });
    await moveFile(downloaded, outputPath);
    await chmod(outputPath, 0o600);
    if (await matchedHtml(client, session.pageId, '[role="dialog"]', "last", 256)) {
      const close = await buttonNodes(client, session.pageId, /^Close/);
      const closeButton = close.buttons.at(-1);
      if (closeButton?.ref) await completeAction(client, session.pageId, close.revision, [{ kind: "click", ref: closeButton.ref }]);
    }
    return outputPath;
  } finally {
    client.close();
  }
}

async function setState(sessionId: string, state: SessionMetadata["state"]): Promise<void> {
  const metadata = await readMetadata(sessionId);
  await writeMetadata({ ...metadata, state });
}

async function closeSession(sessionId: string): Promise<void> {
  await readMetadata(sessionId);
  const client = await connectSession(sessionId);
  try {
    await client.closeTask();
    await rm(sessionPath(sessionId), { force: true });
  } finally {
    client.close();
  }
}

async function captureScreenshot(session: DriverSession, outputPath: string): Promise<string> {
  if (!isAbsolute(outputPath)) throw new Error("Screenshot output path must be absolute");
  const client = await connectSession(session.sessionId);
  try {
    const snapshot = await client.call<"browser_snapshot", ScreenshotSnapshot>("browser_snapshot", {
      tab_id: session.pageId,
      mode: "screenshot",
      format: "png",
      max_width: 1024,
      max_height: 768,
      max_bytes: 750_000,
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(snapshot.data, "base64"), { mode: 0o600 });
    return outputPath;
  } finally {
    client.close();
  }
}

async function probe(): Promise<Record<string, unknown>> {
  const client = await AgentTabClient.connect();
  try {
    const status = await client.call<"agenttab.status", Record<string, unknown>>("agenttab.status", {});
    const state = typeof status.state === "string" ? status.state : "unknown";
    return state === "ready"
      ? { ready: true, driver: "agenttab" }
      : { ready: false, driver: "agenttab", reason: `AgentTab runtime state is ${state}` };
  } finally {
    client.close();
  }
}

async function dispatch(request: DriverRequest): Promise<unknown> {
  const params = request.params;
  switch (request.action) {
    case "probe":
      return probe();
    case "create":
      return createSession(stringField(params, "name"), stringField(params, "url"));
    case "show":
      return showSession(stringField(params, "sessionId"));
    case "upload": {
      const session = sessionField(params);
      if (!Array.isArray(params.files) || !params.files.every((file) => typeof file === "string")) {
        throw new Error("files must be an array of paths");
      }
      await uploadFiles(session, params.files);
      return null;
    }
    case "submit":
      await submitPrompt(sessionField(params), stringField(params, "prompt"));
      return null;
    case "snapshot":
      return readAssistant(sessionField(params));
    case "set_state": {
      const state = stringField(params, "state");
      if (state !== "working" && state !== "needs_user" && state !== "completed") {
        throw new Error("state must be working, needs_user, or completed");
      }
      await setState(stringField(params, "sessionId"), state);
      return null;
    }
    case "close":
      await closeSession(stringField(params, "sessionId"));
      return null;
    case "screenshot":
      return captureScreenshot(sessionField(params), stringField(params, "outputPath"));
    case "save_image":
      return saveImage(sessionField(params), stringField(params, "url"), stringField(params, "outputPath"));
    default:
      throw new Error(`Unsupported GPT-Control browser driver action: ${request.action}`);
  }
}

function parseRequest(raw: string): DriverRequest {
  const value: unknown = JSON.parse(raw);
  const request = record(value, "browser driver request");
  if (request.version !== PROTOCOL_VERSION) throw new Error(`Unsupported browser driver protocol version: ${String(request.version)}`);
  if (typeof request.action !== "string") throw new Error("Browser driver request requires action");
  return {
    version: request.version,
    action: request.action,
    params: record(request.params, "browser driver params"),
  };
}

async function main(): Promise<void> {
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
      process.stdin.on("error", reject);
    });
    const result = await dispatch(parseRequest(raw));
    process.stdout.write(`${JSON.stringify({ version: PROTOCOL_VERSION, ok: true, result })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ version: PROTOCOL_VERSION, ok: false, error: message })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();

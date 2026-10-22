import {
  PROFILE_BOOKMARK_REMOVE_EFFECT,
  PROFILE_STAGE_TAB_ID,
  isProfileStage,
  randomToken,
  sha256Hex,
  type StagedCommit,
} from "./protocol";
import { mutateState, readState } from "./storage";
import { isRecord } from "./type-guards";

/**
 * Profile-scoped operations over Chrome bookmarks, history, sessions, and downloads.
 *
 * Titles, URLs, and filenames leave this module only in the result returned to the caller.
 * Write results carry identifiers and state alone, because the host journals write responses.
 * Nothing here logs.
 */

export interface ProfileExecution {
  result: Record<string, unknown>;
  staged?: StagedCommit;
}

/** Opens one URL as a background tab owned by the task and reports its tab id and revision. */
export type BackgroundTabOpener = (taskId: string, url: string) => Promise<{ tab_id: number; page_revision: number }>;

type BookmarkNode = chrome.bookmarks.BookmarkTreeNode;

const BOOKMARK_ROOT_ID = "0";
const TREE_NODE_LIMIT = 500;
const STAGE_TTL_MS = 300_000;
/** chrome.sessions.MAX_SESSION_RESULTS; restore looks up the entry across this full window. */
const SESSION_LOOKUP_LIMIT = 25;
/** A restored window opens at most this many tabs; the rest are reported as skipped. */
const RESTORE_TAB_LIMIT = 25;

function profileError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra });
}

async function chromeCall<T>(call: () => Promise<T>, what: string): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw profileError("profile_api_failed", `Chrome could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function limitOf(params: Record<string, unknown>, fallback: number): number {
  return typeof params.limit === "number" ? params.limit : fallback;
}

function bookmarkView(node: BookmarkNode): Record<string, unknown> {
  const folder = node.url === undefined;
  return {
    id: node.id,
    ...(node.parentId !== undefined ? { parent_id: node.parentId } : {}),
    ...(node.index !== undefined ? { index: node.index } : {}),
    title: node.title,
    ...(folder ? {} : { url: node.url }),
    kind: folder ? "folder" : "bookmark",
    ...(node.dateAdded !== undefined ? { date_added_ms: node.dateAdded } : {}),
  };
}

function tabEntry(tab: chrome.tabs.Tab): Record<string, unknown> {
  return {
    ...(tab.sessionId !== undefined ? { session_id: tab.sessionId } : {}),
    title: tab.title ?? "",
    url: tab.url ?? "",
  };
}

function sessionEntry(session: chrome.sessions.Session): Record<string, unknown> | null {
  // Chrome reports session times in epoch seconds.
  const lastModifiedMs = session.lastModified * 1_000;
  if (session.tab) {
    return {
      kind: "tab",
      ...(session.tab.sessionId !== undefined ? { session_id: session.tab.sessionId } : {}),
      last_modified_ms: lastModifiedMs,
      title: session.tab.title ?? "",
      url: session.tab.url ?? "",
    };
  }
  if (session.window) {
    const tabs = session.window.tabs ?? [];
    return {
      kind: "window",
      ...(session.window.sessionId !== undefined ? { session_id: session.window.sessionId } : {}),
      last_modified_ms: lastModifiedMs,
      tab_count: tabs.length,
      tabs: tabs.map(tabEntry),
    };
  }
  return null;
}

function epochMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function downloadView(item: chrome.downloads.DownloadItem): Record<string, unknown> {
  const startTime = epochMs(item.startTime);
  const endTime = epochMs(item.endTime);
  return {
    id: item.id,
    filename: item.filename,
    url: item.url,
    ...(item.finalUrl && item.finalUrl !== item.url ? { final_url: item.finalUrl } : {}),
    state: item.state,
    paused: item.paused,
    bytes_received: item.bytesReceived,
    total_bytes: item.totalBytes,
    ...(item.error !== undefined ? { error: item.error } : {}),
    ...(item.mime ? { mime: item.mime } : {}),
    ...(startTime !== undefined ? { start_time_ms: startTime } : {}),
    ...(endTime !== undefined ? { end_time_ms: endTime } : {}),
  };
}

export class ProfileRuntime {
  constructor(private readonly openBackgroundTab: BackgroundTabOpener) {}

  /** Runs one validated browser_profile operation; bookmarks_remove only stages. */
  async run(taskId: string, params: Record<string, unknown>): Promise<ProfileExecution> {
    const operation = String(params.operation);
    const result = await this.execute(taskId, operation, params);
    if ("staged" in result && result.staged !== undefined) return result as ProfileExecution;
    return { result: { operation, ...result } };
  }

  /** Executes an approved bookmark removal stage after confirming the bookmark is unchanged. */
  async commit(taskId: string, nativeToken: string): Promise<Record<string, unknown>> {
    const staged = (await readState()).stagedCommits[nativeToken];
    if (!staged || staged.task_id !== taskId || !isProfileStage(staged)) {
      throw profileError("invalid_staged_token", "Staged commit token is invalid, used, or belongs to another task");
    }
    const discard = () => mutateState((state) => {
      delete state.stagedCommits[nativeToken];
    });
    if (staged.expires_at_ms <= Date.now()) {
      await discard();
      throw profileError("staged_commit_expired", "Staged commit token expired");
    }
    const id = staged.action.bookmark_id;
    if (staged.action.operation !== "bookmarks_remove" || typeof id !== "string") {
      await discard();
      throw profileError("staged_commit_mismatch", "Staged operation is malformed");
    }
    const node = await this.bookmark(id).catch(() => null);
    if (!node || (await this.removalFingerprint(nativeToken, taskId, node)) !== staged.fingerprint) {
      await discard();
      throw profileError("staged_commit_mismatch", "The bookmark changed before Commit");
    }
    await discard();
    await chromeCall(() => chrome.bookmarks.remove(id), "remove the bookmark");
    return { operation: "bookmarks_remove", id, removed: true };
  }

  private async execute(
    taskId: string,
    operation: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | ProfileExecution> {
    switch (operation) {
      case "bookmarks_search":
        return this.bookmarksSearch(String(params.query), limitOf(params, 25));
      case "bookmarks_tree":
        return this.bookmarksTree(
          typeof params.folder_id === "string" ? params.folder_id : BOOKMARK_ROOT_ID,
          typeof params.depth === "number" ? params.depth : 1,
        );
      case "bookmarks_update":
        return this.bookmarksUpdate(params);
      case "bookmarks_create":
        return this.bookmarksCreate(params);
      case "bookmarks_move":
        return this.bookmarksMove(params);
      case "bookmarks_remove":
        return this.stageBookmarkRemoval(taskId, String(params.id));
      case "history_search":
        return this.historySearch(params);
      case "sessions_recent":
        return this.sessionsRecent(limitOf(params, 10));
      case "sessions_devices":
        return this.sessionsDevices(limitOf(params, 10));
      case "sessions_restore":
        return this.sessionsRestore(taskId, String(params.session_id));
      case "downloads_search":
        return this.downloadsSearch(params);
      case "downloads_cancel":
      case "downloads_pause":
      case "downloads_resume":
        return this.downloadControl(operation, Number(params.id));
    }
    throw profileError("invalid_request", `Unsupported browser_profile operation: ${operation}`);
  }

  private async bookmark(id: string): Promise<BookmarkNode> {
    let nodes: BookmarkNode[];
    try {
      nodes = await chrome.bookmarks.get(id);
    } catch {
      throw profileError("bookmark_not_found", `Bookmark ${id} does not exist`);
    }
    const node = nodes[0];
    if (!node) throw profileError("bookmark_not_found", `Bookmark ${id} does not exist`);
    return node;
  }

  private async mutableBookmark(id: string): Promise<BookmarkNode> {
    const node = await this.bookmark(id);
    if (node.id === BOOKMARK_ROOT_ID || node.parentId === BOOKMARK_ROOT_ID || node.unmodifiable !== undefined) {
      throw profileError("bookmark_root_immutable", `Bookmark ${id} is a root or managed node and cannot be changed`);
    }
    return node;
  }

  /** A folder that can receive children: not the invisible root and not managed. */
  private async destinationFolder(id: string): Promise<BookmarkNode> {
    const folder = await this.bookmark(id);
    if (folder.url !== undefined) throw profileError("invalid_request", `Bookmark ${id} is not a folder`);
    if (folder.id === BOOKMARK_ROOT_ID || folder.unmodifiable !== undefined) {
      throw profileError("bookmark_root_immutable", `Folder ${id} cannot hold bookmarks`);
    }
    return folder;
  }

  private async bookmarksSearch(query: string, limit: number): Promise<Record<string, unknown>> {
    const nodes = await chromeCall(() => chrome.bookmarks.search(query), "search bookmarks");
    const bookmarks = nodes.slice(0, limit).map(bookmarkView);
    return { bookmarks, count: bookmarks.length, truncated: nodes.length > limit };
  }

  private async bookmarksTree(folderId: string, depth: number): Promise<Record<string, unknown>> {
    let subtree: BookmarkNode[];
    try {
      subtree = await chrome.bookmarks.getSubTree(folderId);
    } catch {
      throw profileError("bookmark_not_found", `Bookmark ${folderId} does not exist`);
    }
    const top = subtree[0];
    if (!top) throw profileError("bookmark_not_found", `Bookmark ${folderId} does not exist`);
    let nodeCount = 0;
    let truncated = false;
    const visit = (node: BookmarkNode, remaining: number): Record<string, unknown> => {
      nodeCount += 1;
      const view = bookmarkView(node);
      if (node.url !== undefined) return view;
      const children = node.children ?? [];
      const summary: Record<string, unknown> = { ...view, child_count: children.length };
      if (remaining <= 0) return summary;
      const included: Record<string, unknown>[] = [];
      for (const child of children) {
        if (nodeCount >= TREE_NODE_LIMIT) {
          truncated = true;
          break;
        }
        included.push(visit(child, remaining - 1));
      }
      return { ...summary, children: included };
    };
    const root = visit(top, depth);
    return { root, node_count: nodeCount, truncated };
  }

  private async bookmarksUpdate(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(params.id);
    const node = await this.mutableBookmark(id);
    const changes: { title?: string; url?: string } = {};
    const updated: string[] = [];
    if (typeof params.title === "string") {
      changes.title = params.title;
      updated.push("title");
    }
    if (typeof params.url === "string") {
      if (node.url === undefined) throw profileError("invalid_request", `Bookmark ${id} is a folder and has no url`);
      changes.url = params.url;
      updated.push("url");
    }
    await chromeCall(() => chrome.bookmarks.update(id, changes), "update the bookmark");
    return { id, updated };
  }

  private async bookmarksCreate(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parentId = String(params.parent_id);
    await this.destinationFolder(parentId);
    const index = typeof params.index === "number" ? params.index : undefined;
    if (index !== undefined) await this.assertIndex(parentId, index);
    const created = await chromeCall(
      () => chrome.bookmarks.create({
        parentId,
        title: String(params.title),
        ...(typeof params.url === "string" ? { url: params.url } : {}),
        ...(index !== undefined ? { index } : {}),
      }),
      "create the bookmark",
    );
    return { id: created.id, parent_id: created.parentId ?? parentId, index: created.index ?? index ?? 0 };
  }

  private async bookmarksMove(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(params.id);
    const parentId = String(params.parent_id);
    await this.mutableBookmark(id);
    await this.destinationFolder(parentId);
    for (let cursor: string | undefined = parentId; cursor !== undefined && cursor !== BOOKMARK_ROOT_ID;) {
      if (cursor === id) throw profileError("invalid_request", "A folder cannot move into itself or its descendants");
      cursor = (await this.bookmark(cursor)).parentId;
    }
    const index = typeof params.index === "number" ? params.index : undefined;
    if (index !== undefined) await this.assertIndex(parentId, index);
    const moved = await chromeCall(
      () => chrome.bookmarks.move(id, { parentId, ...(index !== undefined ? { index } : {}) }),
      "move the bookmark",
    );
    return { id, parent_id: moved.parentId ?? parentId, index: moved.index ?? index ?? 0 };
  }

  private async assertIndex(parentId: string, index: number): Promise<void> {
    const children = await chromeCall(() => chrome.bookmarks.getChildren(parentId), "read the folder");
    if (index > children.length) {
      throw profileError("invalid_request", `index must be at most ${children.length} for folder ${parentId}`);
    }
  }

  private async stageBookmarkRemoval(taskId: string, id: string): Promise<ProfileExecution> {
    const node = await this.mutableBookmark(id);
    if (node.url === undefined) {
      const children = await chromeCall(() => chrome.bookmarks.getChildren(id), "read the folder");
      if (children.length > 0) {
        throw profileError("bookmark_folder_not_empty", `Folder ${id} is not empty; move or remove its contents first`);
      }
    }
    const nativeToken = randomToken();
    // Bookmark removal always stages, whatever the popup's skip-review setting says.
    const staged: StagedCommit = {
      native_token: nativeToken,
      task_id: taskId,
      tab_id: PROFILE_STAGE_TAB_ID,
      page_revision: 0,
      effect: PROFILE_BOOKMARK_REMOVE_EFFECT,
      fingerprint: await this.removalFingerprint(nativeToken, taskId, node),
      expires_at_ms: Date.now() + STAGE_TTL_MS,
      action: { operation: "bookmarks_remove", bookmark_id: id },
      // Local to the extension: the popup shows it so the human sees what would be removed.
      preview: {
        effect: PROFILE_BOOKMARK_REMOVE_EFFECT,
        kind: node.url === undefined ? "folder" : "bookmark",
        id,
        title: node.title,
        ...(node.url !== undefined ? { url: node.url } : {}),
      },
    };
    await mutateState((state) => {
      state.stagedCommits[nativeToken] = staged;
    });
    return { staged, result: { operation: "bookmarks_remove", id } };
  }

  /** Salted with the stage token, so the journaled fingerprint cannot be matched against guessed URLs. */
  private removalFingerprint(nativeToken: string, taskId: string, node: BookmarkNode): Promise<string> {
    return sha256Hex({
      native_token: nativeToken,
      task_id: taskId,
      operation: "bookmarks_remove",
      id: node.id,
      parent_id: node.parentId ?? null,
      title: node.title,
      url: node.url ?? null,
    });
  }

  private async historySearch(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query: chrome.history.HistoryQuery = {
      text: String(params.text),
      // Chrome defaults to the last 24 hours; an omitted start_time searches all retained history.
      startTime: typeof params.start_time === "number" ? params.start_time : 0,
      maxResults: limitOf(params, 25),
      ...(typeof params.end_time === "number" ? { endTime: params.end_time } : {}),
    };
    const items = await chromeCall(() => chrome.history.search(query), "search history");
    return {
      items: items.map((item) => ({
        id: item.id,
        url: item.url ?? "",
        title: item.title ?? "",
        ...(item.lastVisitTime !== undefined ? { last_visit_time_ms: item.lastVisitTime } : {}),
        visit_count: item.visitCount ?? 0,
        typed_count: item.typedCount ?? 0,
      })),
      count: items.length,
    };
  }

  private async sessionsRecent(limit: number): Promise<Record<string, unknown>> {
    const sessions = await chromeCall(
      () => chrome.sessions.getRecentlyClosed({ maxResults: limit }),
      "read recently closed sessions",
    );
    const entries = sessions.map(sessionEntry).filter((entry) => entry !== null);
    return { sessions: entries, count: entries.length };
  }

  private async sessionsDevices(limit: number): Promise<Record<string, unknown>> {
    const devices = await chromeCall(() => chrome.sessions.getDevices({ maxResults: limit }), "read synced devices");
    return {
      devices: devices.map((device) => ({
        device_name: device.deviceName,
        sessions: device.sessions.map(sessionEntry).filter((entry) => entry !== null),
      })),
      count: devices.length,
    };
  }

  /**
   * Reopens a closed or synced entry as background task tabs. chrome.sessions.restore is never used:
   * it activates the restored tab or window, which would take focus from the human.
   */
  private async sessionsRestore(taskId: string, sessionId: string): Promise<Record<string, unknown>> {
    const recent = await chromeCall(
      () => chrome.sessions.getRecentlyClosed({ maxResults: SESSION_LOOKUP_LIMIT }),
      "read recently closed sessions",
    );
    const devices = await chrome.sessions.getDevices({ maxResults: SESSION_LOOKUP_LIMIT }).catch(() => []);
    const candidates = [...recent, ...devices.flatMap((device) => device.sessions)];
    let kind: "tab" | "window" | null = null;
    let urls: string[] = [];
    for (const session of candidates) {
      if (session.tab?.sessionId === sessionId) {
        kind = "tab";
        urls = [session.tab.url ?? ""];
        break;
      }
      if (session.window?.sessionId === sessionId) {
        kind = "window";
        urls = (session.window.tabs ?? []).map((tab) => tab.url ?? "");
        break;
      }
    }
    if (kind === null) {
      throw profileError("session_not_found", "No recently closed or synced session has that session_id", {
        recovery: "List sessions_recent or sessions_devices again and use a current session_id.",
      });
    }
    const openable = urls.filter((url) => /^https?:\/\//i.test(url));
    const toOpen = openable.slice(0, RESTORE_TAB_LIMIT);
    const opened: Array<{ tab_id: number; page_revision: number }> = [];
    for (const url of toOpen) {
      try {
        opened.push(await this.openBackgroundTab(taskId, url));
      } catch (error) {
        if (opened.length === 0) throw error;
        // Tabs already opened stay owned by the task; report a partial restore as unknown.
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: "unknown" });
      }
    }
    return { session_id: sessionId, kind, opened, skipped: urls.length - opened.length };
  }

  private async downloadsSearch(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const limit = limitOf(params, 25);
    const query: chrome.downloads.DownloadQuery = {
      limit,
      orderBy: ["-startTime"],
      ...(typeof params.query === "string"
        ? { query: params.query.split(/\s+/).filter((term) => term.length > 0) }
        : {}),
      ...(typeof params.state === "string" ? { state: params.state as `${chrome.downloads.State}` } : {}),
    } as chrome.downloads.DownloadQuery;
    const items = await chromeCall(() => chrome.downloads.search(query), "search downloads");
    return { downloads: items.map(downloadView), count: items.length };
  }

  private async download(id: number): Promise<chrome.downloads.DownloadItem> {
    const [item] = await chromeCall(() => chrome.downloads.search({ id }), "read the download");
    if (!item) throw profileError("download_not_found", `Download ${id} does not exist`);
    return item;
  }

  private async downloadControl(operation: string, id: number): Promise<Record<string, unknown>> {
    await this.download(id);
    if (operation === "downloads_cancel") {
      await chromeCall(() => chrome.downloads.cancel(id), "cancel the download");
    } else if (operation === "downloads_pause") {
      await chromeCall(() => chrome.downloads.pause(id), "pause the download");
    } else {
      await chromeCall(() => chrome.downloads.resume(id), "resume the download");
    }
    // The Chrome call already ran, so a failed re-lookup (for example, an entry erased in
    // between) cannot prove the control had no effect.
    let after: chrome.downloads.DownloadItem;
    try {
      after = await this.download(id);
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: "unknown" });
    }
    return { id, state: after.state, paused: after.paused };
  }
}

/** Popup-only description of a profile stage, read from the extension-local preview. */
export function profileReviewDetail(staged: StagedCommit): string | undefined {
  if (!isProfileStage(staged) || !isRecord(staged.preview)) return undefined;
  const title = typeof staged.preview.title === "string" && staged.preview.title !== ""
    ? staged.preview.title
    : "(untitled)";
  const url = typeof staged.preview.url === "string" ? staged.preview.url : undefined;
  return url === undefined ? `Folder: ${title}` : `${title} — ${url}`;
}

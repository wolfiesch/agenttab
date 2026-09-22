import { RevisionTracker } from "./revisions";
import {
  dispatchDomClick,
  dispatchDomFill,
  dispatchDomPress,
  dispatchDomSelect,
  dispatchDomType,
  pageDomActionDeclaration,
  validatePressChord,
} from "./input-actions";
import { automationRoute, restrictedOriginError } from "./routes";
import { isRecord } from "./type-guards";
import {
  mintTargetRef,
  parseTargetRef,
  type ResolvedTarget,
} from "./target-resolution";
import {
  SCREENSHOT_MAX_BYTES,
  SNAPSHOT_TEXT_MAX_BYTES,
  randomToken,
  sha256Hex,
  type StagedCommit,
  type StagedDialog,
} from "./protocol";
import { mutateState, readState } from "./storage";

export async function removeTabIfPresent(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    const tabStillExists = await chrome.tabs.get(tabId).then(() => true, () => false);
    if (tabStillExists) throw error;
  }
}

const DEBUGGER_VERSION = "1.3";
const DEBUGGER_IDLE_MS = 30_000;
// Leaves more than 16 KiB for the Core response envelope and task binding inside
// the 1 MiB host-to-client frame. Screenshot base64 data is separately capped at
// 1,000,000 characters (750,000 decoded bytes).
const SNAPSHOT_RESULT_BUDGET_BYTES = 1_032_000;
const TAB_ONLY_ACTIONS: Readonly<Record<string, true>> = {
  navigate: true,
  go_back: true,
  go_forward: true,
  reload: true,
  close: true,
};
const TAB_ONLY_WAIT_CONDITIONS: Readonly<Record<string, true>> = {
  load: true,
  url: true,
};
const SUPPORTED_WAIT_CONDITIONS: Readonly<Record<string, true>> = {
  load: true,
  url: true,
  text: true,
  selector: true,
  value: true,
  network_idle: true,
  download: true,
};
function validateKeyboardAction(action: Record<string, unknown>): void {
  if (action.kind !== "press") return;
  const modifiers = action.modifiers;
  if (typeof action.key !== "string" ||
      modifiers !== undefined && (!Array.isArray(modifiers) ||
        !modifiers.every((modifier) => typeof modifier === "string"))) {
    throw Object.assign(new Error("press requires a supported key and modifier list"), {
      code: "invalid_request",
    });
  }
  const invalid = validatePressChord(action.key, modifiers ?? []);
  if (invalid) {
    throw Object.assign(new Error(invalid.agenttab_invalid_request), { code: "invalid_request" });
  }
}
const SENSITIVE_FIELD_CHECK = "const type=String(this.getAttribute&&this.getAttribute('type')||'').toLowerCase();const autocomplete=String(this.getAttribute&&this.getAttribute('autocomplete')||'').toLowerCase().split(/\\s+/);const text=node=>String(node&&((node.innerText??node.textContent)??'')||'').trim();const ids=String(this.getAttribute&&this.getAttribute('aria-labelledby')||'')+' '+String(this.getAttribute&&this.getAttribute('aria-describedby')||'');const associated=(this.labels?Array.from(this.labels):[]).map(text).filter(Boolean);const root=this.ownerDocument||document;const accessible=[this.getAttribute&&this.getAttribute('aria-label'),...ids.trim().split(/\\s+/).filter(Boolean).map(id=>text(root.getElementById(id)))].filter(value=>typeof value==='string'&&value.trim());const role=String(this.getAttribute&&this.getAttribute('role')||'').toLowerCase();const rawDescriptor=[this.getAttribute&&this.getAttribute('name'),this.id,this.getAttribute&&this.getAttribute('aria-label'),this.getAttribute&&this.getAttribute('title'),this.getAttribute&&this.getAttribute('placeholder'),...associated,...accessible].filter(Boolean).join(' ');const descriptor=rawDescriptor.replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();const compactDescriptor=descriptor.replace(/\\s+/g,'');const tag=String(this.tagName||'').toUpperCase();const editable=tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||this.isContentEditable===true||role==='textbox'||role==='combobox'||role==='spinbutton';const namedSecret=/\\b(password|otp|totp|mfa(?: code|token)?|2fa(?: code)?|(?:two|multi) factor (?:authentication )?(?:code|token)|one time (?:code|password)|verification code|authentication code|auth code|(?:re ?|h ?)?captcha|(?:cvv|cvc|cvn)\\d*|cid|security code|card security code|card verification (?:value|code|number)|card number|credit card number|cc number|card (?:expiration|expiry) (?:date|month|year)|bank account number|routing number|iban)\\b/.test(descriptor)||['password','onetimecode','onetimepassword','verificationcode','authenticationcode','authcode','totp','2fa','2facode','twofactorcode','twofactortoken','twofactorauthenticationcode','multifactorcode','multifactortoken','multifactorauthenticationcode','captcha','cid','securitycode','cardverificationvalue','cardverificationcode','cardverificationnumber','cardnumber','creditcardnumber','ccnumber','cardsecuritycode','cardexpirationdate','cardexpirationmonth','cardexpirationyear','cardexpirydate','cardexpirymonth','cardexpiryyear','bankaccountnumber','routingnumber'].some(term=>compactDescriptor.includes(term));const tokenSecret=/\\b(pin|passcode)\\b/.test(descriptor);const sensitiveField=type==='password'||autocomplete.some(token=>token==='current-password'||token==='new-password'||token==='one-time-code'||token==='webauthn'||token.startsWith('cc-'))||(editable&&(namedSecret||tokenSecret));";
const DOM_SENSITIVE_ACTION_PRELUDE =
  `${SENSITIVE_FIELD_CHECK}if(sensitiveField){return {agenttab_sensitive_field:true}}`;
const DOWNLOAD_CURSOR_RETENTION_MS = 120_000;
const MAX_DOWNLOAD_CURSORS = 512;
const MAX_DOWNLOAD_CURSORS_PER_TAB = 32;

interface JavaScriptDialog {
  generation: number;
  type: string | null;
  fingerprint: Promise<string>;
}

interface PendingWindowOpen {
  existingTabIds: Set<number>;
  activeTabId?: number;
  activeWindowId?: number;
  expiresAt: number;
}

type DownloadStatus = "in_progress" | "completed" | "canceled";
type DownloadCursorState = "armed" | "bound" | "completed" | "canceled" | "ambiguous" | "detached";

interface DownloadMetadata {
  guid: string;
  status: "completed";
  url?: string;
  suggestedFilename?: string;
}

interface DownloadCursor {
  token: string;
  taskId: string;
  tabId: number;
  armedAt: number;
  expiresAt: number;
  state: DownloadCursorState;
  guid?: string;
  download?: DownloadMetadata;
}

interface TrackedDownload {
  startedAt: number;
  status: DownloadStatus;
  completedAt?: number;
  url?: string;
  suggestedFilename?: string;
  cursor?: DownloadCursor;
}

interface DebugSession {
  attached: boolean;
  attachPromise?: Promise<void>;
  detachPromise?: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  busyCount: number;
  inflight: Set<string>;
  lastNetworkActivity: number;
  pageLoadInFlight: boolean;
  downloads: Map<string, TrackedDownload>;
  dialogGeneration: number;
  dialog?: JavaScriptDialog;
  pendingWindowOpen?: PendingWindowOpen;
  frameContexts: Map<string, number>;
  frameSessions: Map<string, string>;
}

interface AxValue {
  value?: unknown;
}

interface AxNode {
  nodeId?: string;
  backendDOMNodeId?: number;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  properties?: Array<{ name?: string; value?: AxValue }>;
}
interface PageIdentity {
  documentId?: string;
  loaderId?: string;
}
interface FrameIdentity {
  frameId: string;
  loaderId?: string;
  url?: string;
}

interface FrameDocument extends FrameIdentity {
  documentId: string;
  rootNodeId: number;
  sessionId?: string;
  contextId?: number;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function utf8Prefix(bytes: Uint8Array, maxBytes: number): string {
  let end = Math.min(bytes.length, Math.max(0, Math.floor(maxBytes)));
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return utf8Decoder.decode(bytes.subarray(0, end));
}

function serializedBytes(value: unknown): number {
  return utf8Encoder.encode(JSON.stringify(value)).length;
}

function snapshotTooLarge(message: string, recovery: string): Error {
  return Object.assign(new Error(message), { code: "snapshot_too_large", recovery });
}

function assertDeliverableSnapshot(result: Record<string, unknown>): Record<string, unknown> {
  if (serializedBytes(result) <= SNAPSHOT_RESULT_BUDGET_BYTES) return result;
  throw snapshotTooLarge(
    "Snapshot cannot fit in the AgentTab Core response budget",
    "Request a narrower selector, lower max_bytes/max_nodes, or reduce screenshot dimensions and quality.",
  );
}

// Accessibility snapshots mint refs from the debugger-backed accessibility tree,
// but some frameworks render editable elements that never enter that tree (for
// example pre-hydration composers). These editables are still addressable by
// backend node id, so full-tree snapshots append DOM fallback nodes for them.
const DOM_EDITABLE_FALLBACK_SELECTOR = "textarea,input,[contenteditable]";
const DOM_EDITABLE_FALLBACK_LIMIT = 40;
// Work bound for pathological pages: scanning stops after this many DOM
// inspections even if fewer than DOM_EDITABLE_FALLBACK_LIMIT nodes were
// accepted, so snapshot latency stays bounded on input-heavy documents.
const DOM_EDITABLE_FALLBACK_INSPECT_LIMIT = 400;
const DOM_EDITABLE_INPUT_TYPES: Record<string, true> = {
  "": true,
  text: true,
  search: true,
  email: true,
  url: true,
  tel: true,
  number: true,
};

function domEditableFallbackNode(
  node: Record<string, unknown>,
  pageRevision: number,
): Record<string, unknown> | null {
  const backendNodeId = node.backendNodeId;
  if (typeof backendNodeId !== "number") return null;
  const attributes = Array.isArray(node.attributes) ? node.attributes : [];
  const attr = (name: string): string | undefined => {
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      if (attributes[index] === name) return attributes[index + 1];
    }
    return undefined;
  };
  const tag = String(node.localName ?? node.nodeName ?? "").toLowerCase();
  const editable =
    tag === "textarea" ||
    (tag === "input"
      ? DOM_EDITABLE_INPUT_TYPES[(attr("type") ?? "").toLowerCase()] === true
      : attr("contenteditable") !== undefined &&
        (attr("contenteditable") ?? "").toLowerCase() !== "false");
  if (!editable) return null;
  const name =
    attr("aria-label") ||
    attr("placeholder") ||
    attr("name") ||
    attr("title") ||
    attr("id") ||
    tag;
  return {
    ref: `r${pageRevision}-${backendNodeId}`,
    role: "textbox",
    name,
    ...(typeof node.value === "string" && node.value.length > 0 ? { value: node.value } : {}),
    dom_fallback: true,
  };
}

function base64ByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

type CloseTab = (tabId: number) => Promise<void>;
type EventSink = (event: string, payload: Record<string, unknown>) => void;
type AuthorizeDebuggerUse = (tabId: number) => Promise<void>;
type DebuggerLifecycle = (tabId: number) => Promise<void>;
type AdoptOwnedChild = (parentTabId: number, childTabId: number) => Promise<void>;

export interface ActionExecution {
  result?: Record<string, unknown>;
  staged?: StagedCommit;
}
export interface TargetResolutionRequest {
  pageRevision: number;
  taskId?: string;
  ref?: unknown;
  selector?: string;
  frameId?: string;
  actionKind?: string;
}

interface PreparedDialog {
  binding: StagedDialog;
  live: JavaScriptDialog;
}

interface StagedConsequence {
  effect: string;
  target: Record<string, unknown>;
  dialog?: PreparedDialog;
}



export class StandardBrowserRuntime {
  private readonly sessions = new Map<number, DebugSession>();
  private readonly downloadCursors = new Map<string, DownloadCursor>();
  private readonly expectedDetaches = new Map<number, number>();
  private readonly debuggerCandidates = new Set<number>();

  constructor(
    private readonly revisions: RevisionTracker,
    private readonly closeTab: CloseTab,
    private readonly emit: EventSink,
    private readonly authorizeDebuggerUse: AuthorizeDebuggerUse = async () => undefined,
    private readonly recordDebuggerCandidate: DebuggerLifecycle = async () => undefined,
    private readonly forgetDebuggerCandidate: DebuggerLifecycle = async () => undefined,
    private readonly adoptOwnedChild: AdoptOwnedChild = async () => undefined,
  ) {
    chrome.debugger.onDetach.addListener((source: { tabId?: number }) => {
      if (source.tabId === undefined) return;
      if (this.consumeExpectedDetach(source.tabId)) return;
      this.invalidateDetachedSession(source.tabId);
    });
    chrome.debugger.onEvent.addListener(
      (source, method: string, rawParams?: object) => {
        if (source.tabId === undefined) return;
        const session = this.sessions.get(source.tabId);
        if (!session) return;
        const params = isRecord(rawParams) ? rawParams : {};
        if (
          method === "Runtime.executionContextCreated" &&
          isRecord(params.context) &&
          typeof params.context.id === "number" &&
          isRecord(params.context.auxData) &&
          typeof params.context.auxData.frameId === "string"
        ) {
          session.frameContexts.set(params.context.auxData.frameId, params.context.id);
        } else if (
          method === "Target.attachedToTarget" &&
          typeof params.sessionId === "string" &&
          isRecord(params.targetInfo) &&
          params.targetInfo.type === "iframe" &&
          typeof params.targetInfo.targetId === "string"
        ) {
          session.frameSessions.set(params.targetInfo.targetId, params.sessionId);
          void this.initializeChildFrameSession(source.tabId, params.sessionId);
        } else if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
          for (const [frameId, sessionId] of session.frameSessions) {
            if (sessionId !== params.sessionId) continue;
            session.frameSessions.delete(frameId);
            session.frameContexts.delete(frameId);
          }
        } else if (method === "Network.requestWillBeSent" && typeof params.requestId === "string") {
          session.inflight.add(params.requestId);
          session.lastNetworkActivity = Date.now();
        } else if (
          (method === "Network.loadingFinished" || method === "Network.loadingFailed") &&
          typeof params.requestId === "string"
        ) {
          session.inflight.delete(params.requestId);
          session.lastNetworkActivity = Date.now();
          // chrome.downloads has no initiator tab. Page events are routed from
          // the attached tab and carry the GUID that joins start and progress.
        } else if (method === "Page.downloadWillBegin" && typeof params.guid === "string") {
          this.trackDownloadWillBegin(source.tabId, session, params);
        } else if (method === "Page.downloadProgress" && typeof params.guid === "string") {
          this.trackDownloadProgress(session, params.guid, params.state);
        } else if (method === "Page.javascriptDialogOpening") {
          session.dialogGeneration += 1;
          session.dialog = {
            generation: session.dialogGeneration,
            type: typeof params.type === "string" ? params.type : null,
            fingerprint: sha256Hex({
              type: typeof params.type === "string" ? params.type : null,
              message: typeof params.message === "string" ? params.message : null,
              default_prompt: typeof params.defaultPrompt === "string" ? params.defaultPrompt : null,
            }),
          };
          void this.invalidateStagedDialogs(source.tabId);
        } else if (method === "Page.windowOpen") {
          const pending = session.pendingWindowOpen;
          session.pendingWindowOpen = undefined;
          if (
            pending &&
            pending.expiresAt >= Date.now() &&
            typeof params.url === "string" &&
            params.url.length > 0
          ) {
            void this.adoptWindowOpenChild(source.tabId, params.url, pending);
          }
        } else if (method === "Page.javascriptDialogClosed") {
          session.dialogGeneration += 1;
          session.dialog = undefined;
          void this.invalidateStagedDialogs(source.tabId);
        }
      },
    );
    this.revisions.onChange((tabId) => this.invalidateStagedDialogs(tabId));
  }

  debuggerTabIds(): number[] {
    return [...this.debuggerCandidates];
  }

  tracksTab(tabId: number): boolean {
    return this.sessions.has(tabId) || this.debuggerCandidates.has(tabId);
  }

  /**
   * Arms target-scoped Page download correlation immediately before a
   * download-capable action is dispatched. The opaque cursor is task-bound.
   */
  async armDownload(taskId: string, tabId: number): Promise<string> {
    await this.ensureAttached(tabId);
    this.pruneDownloadState();
    this.invalidatePendingDownloadAttribution(tabId);
    const pendingForTab = [...this.downloadCursors.values()].filter(
      (cursor) =>
        cursor.tabId === tabId &&
        (cursor.state === "armed" || cursor.state === "bound"),
    ).length;
    if (
      this.downloadCursors.size >= MAX_DOWNLOAD_CURSORS ||
      pendingForTab >= MAX_DOWNLOAD_CURSORS_PER_TAB
    ) {
      throw Object.assign(new Error("Too many download actions are awaiting attribution"), {
        code: "download_attribution_limit",
      });
    }
    const token = randomToken();
    this.downloadCursors.set(token, {
      token,
      taskId,
      tabId,
      armedAt: Date.now(),
      expiresAt: Date.now() + DOWNLOAD_CURSOR_RETENTION_MS,
      state: "armed",
    });
    return token;
  }

  invalidatePendingDownloadAttribution(tabId: number): void {
    const expiresAt = Date.now() + DOWNLOAD_CURSOR_RETENTION_MS;
    for (const cursor of this.downloadCursors.values()) {
      if (cursor.tabId === tabId && cursor.state === "armed") {
        cursor.state = "ambiguous";
        cursor.expiresAt = expiresAt;
      }
    }
  }

  restoreDebuggerCandidates(tabIds: readonly number[]): void {
    for (const tabId of tabIds) this.debuggerCandidates.add(tabId);
  }

  async detach(tabId: number): Promise<void> {
    const session = this.sessions.get(tabId);
    if (!session) {
      if (this.debuggerCandidates.has(tabId)) {
        await this.detachRecovered(tabId);
      } else {
        this.invalidateDownloadTracking(tabId);
        await this.invalidateStagedDialogs(tabId);
      }
      return;
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
    if (session.detachPromise) return session.detachPromise;
    if (session.attachPromise) {
      const attaching = session.attachPromise;
      try {
        await attaching;
      } catch {
        // Initialization failure can leave an attached session requiring cleanup.
      }
      if (this.sessions.get(tabId) !== session) return;
      if (session.attachPromise === attaching) session.attachPromise = undefined;
      return this.detach(tabId);
    }
    if (!session.attached) {
      if (this.sessions.get(tabId) === session) this.sessions.delete(tabId);
      this.invalidateDownloadTracking(tabId);
      await this.invalidateStagedDialogs(tabId);
      return;
    }
    return this.detachTrackedSession(tabId, session);
  }

  async scrubForHandoff(recoveredTabIds: readonly number[] = []): Promise<void> {
    const tabIds = [
      ...new Set([...this.sessions.keys(), ...this.debuggerCandidates, ...recoveredTabIds]),
    ];
    const results = await Promise.allSettled(tabIds.map((tabId) => this.detachRecovered(tabId)));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  async discardHumanInteractionCapture(tabId: number): Promise<void> {
    // A browser_handoff notice applies only to its owned tab. Detach any CDP
    // session there before human input without disrupting unrelated tasks.
    await this.detach(tabId);
  }

  private async detachRecovered(tabId: number): Promise<void> {
    if (this.sessions.has(tabId)) {
      await this.detach(tabId);
      return;
    }
    const targets = await chrome.debugger.getTargets();
    const target = targets.find(
      (candidate: { attached?: boolean; tabId?: number }) =>
        candidate.attached === true && candidate.tabId === tabId,
    );
    if (!target) {
      this.invalidateDownloadTracking(tabId);
      await this.invalidateStagedDialogs(tabId);
      await this.forgetTrackedDebuggerCandidate(tabId);
      return;
    }
    const expected = this.expectedDetaches.get(tabId) ?? 0;
    this.expectedDetaches.set(tabId, expected + 1);
    try {
      await chrome.debugger.detach({ tabId });
      this.invalidateDownloadTracking(tabId);
      await this.invalidateStagedDialogs(tabId);
      await this.forgetTrackedDebuggerCandidate(tabId);
    } catch (error) {
      this.consumeExpectedDetach(tabId);
      throw error;
    }
  }

  private detachTrackedSession(tabId: number, session: DebugSession): Promise<void> {
    const expected = this.expectedDetaches.get(tabId) ?? 0;
    this.expectedDetaches.set(tabId, expected + 1);
    const detaching = (async () => {
      try {
        await chrome.debugger.detach({ tabId });
        if (this.sessions.get(tabId) === session) this.sessions.delete(tabId);
        this.invalidateDownloadTracking(tabId);
        await this.invalidateStagedDialogs(tabId);
        await this.forgetTrackedDebuggerCandidate(tabId);
      } catch (error) {
        this.consumeExpectedDetach(tabId);
        if (this.sessions.get(tabId) === session) session.detachPromise = undefined;
        this.scheduleIdleDetach(tabId, session);
        throw error;
      }
    })();
    session.detachPromise = detaching;
    return detaching;
  }

  private async forgetTrackedDebuggerCandidate(tabId: number): Promise<void> {
    await this.forgetDebuggerCandidate(tabId);
    this.debuggerCandidates.delete(tabId);
  }

  private consumeExpectedDetach(tabId: number): boolean {
    const pendingExpected = this.expectedDetaches.get(tabId) ?? 0;
    if (pendingExpected === 0) return false;
    if (pendingExpected === 1) this.expectedDetaches.delete(tabId);
    else this.expectedDetaches.set(tabId, pendingExpected - 1);
    return true;
  }

  private invalidateDetachedSession(tabId: number, session = this.sessions.get(tabId)): void {
    if (session?.idleTimer) clearTimeout(session.idleTimer);
    if (session && this.sessions.get(tabId) === session) this.sessions.delete(tabId);
    this.invalidateDownloadTracking(tabId);
    void this.invalidateStagedDialogs(tabId);
  }

  private async requireFullAutomationRoute(tabId: number, operation: string): Promise<void> {
    const tab = await chrome.tabs.get(tabId);
    if (automationRoute(tab.pendingUrl ?? tab.url) !== "full") {
      throw restrictedOriginError(operation);
    }
  }

  private trackDownloadWillBegin(
    tabId: number,
    session: DebugSession,
    params: Record<string, unknown>,
  ): void {
    this.pruneDownloadState();
    const now = Date.now();
    const candidates = [...this.downloadCursors.values()].filter(
      (cursor) => cursor.tabId === tabId && cursor.state === "armed" && cursor.expiresAt >= now,
    );
    const hasAmbiguityTombstone = [...this.downloadCursors.values()].some(
      (cursor) => cursor.tabId === tabId && cursor.state === "ambiguous" && cursor.expiresAt >= now,
    );
    const cursor = !hasAmbiguityTombstone && candidates.length === 1 ? candidates[0] : undefined;
    if (hasAmbiguityTombstone || candidates.length > 1) {
      for (const candidate of candidates) candidate.state = "ambiguous";
    }
    session.downloads.set(String(params.guid), {
      startedAt: now,
      status: "in_progress",
      ...(typeof params.url === "string" ? { url: params.url } : {}),
      ...(typeof params.suggestedFilename === "string"
        ? { suggestedFilename: params.suggestedFilename }
        : {}),
      ...(cursor ? { cursor } : {}),
    });
  }

  private trackDownloadProgress(
    session: DebugSession,
    guid: string,
    state: unknown,
  ): void {
    const download = session.downloads.get(guid);
    if (!download || (state !== "completed" && state !== "canceled")) return;
    const now = Date.now();
    download.status = state;
    download.completedAt = now;
    if (!download.cursor) return;
    download.cursor.state = state;
    download.cursor.expiresAt = now + DOWNLOAD_CURSOR_RETENTION_MS;
    if (state === "completed") {
      download.cursor.download = {
        guid,
        status: "completed",
        ...(download.url !== undefined ? { url: download.url } : {}),
        ...(download.suggestedFilename !== undefined
          ? { suggestedFilename: download.suggestedFilename }
          : {}),
      };
    }
  }

  private invalidateDownloadTracking(tabId: number): void {
    for (const cursor of this.downloadCursors.values()) {
      if (
        cursor.tabId === tabId &&
        (cursor.state === "armed" || cursor.state === "bound")
      ) {
        cursor.state = "detached";
        cursor.expiresAt = Date.now() + DOWNLOAD_CURSOR_RETENTION_MS;
      }
    }
  }

  private pruneDownloadState(): void {
    const now = Date.now();
    for (const [token, cursor] of this.downloadCursors) {
      if (cursor.expiresAt < now) this.downloadCursors.delete(token);
    }
    for (const session of this.sessions.values()) {
      for (const [guid, download] of session.downloads) {
        if (download.startedAt + DOWNLOAD_CURSOR_RETENTION_MS < now) {
          session.downloads.delete(guid);
        }
      }
    }
  }

  private downloadCursorMatch(
    taskId: string | undefined,
    tabId: number,
    condition: Record<string, unknown>,
  ): DownloadMetadata | undefined {
    if (typeof condition.after !== "string") return undefined;
    this.pruneDownloadState();
    if (taskId === undefined) {
      throw Object.assign(new Error("Download cursors require a task-bound browser wait"), {
        code: "invalid_download_cursor",
      });
    }
    const cursor = this.downloadCursors.get(condition.after);
    if (!cursor || cursor.taskId !== taskId || cursor.tabId !== tabId) {
      throw Object.assign(new Error("Download cursor is invalid or belongs to another task"), {
        code: "invalid_download_cursor",
      });
    }
    if (cursor.state === "completed" && cursor.download) return cursor.download;
    if (cursor.state === "canceled") {
      throw Object.assign(new Error("The correlated download was canceled"), {
        code: "download_canceled",
        outcome: "unknown",
      });
    }
    if (cursor.state === "ambiguous" || cursor.state === "detached") {
      throw Object.assign(new Error("Download attribution was lost before completion"), {
        code: "download_attribution_lost",
        outcome: "unknown",
      });
    }
    return undefined;
  }

  async snapshot(
    taskId: string,
    tabId: number,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.authorizeDebuggerUse(tabId);
    const mode = params.mode;
    if (mode !== "text" && mode !== "html" && mode !== "screenshot" && mode !== "accessibility") {
      throw Object.assign(new Error("Unsupported snapshot mode"), { code: "invalid_request" });
    }
    const frameId = typeof params.frame_id === "string" ? params.frame_id : undefined;
    await this.requireFullAutomationRoute(tabId, `capture a ${mode} snapshot`);
    if (mode === "text" || mode === "html") {
      return assertDeliverableSnapshot(await this.scriptSnapshot(tabId, mode, params));
    }
    if (mode === "screenshot") {
      if (frameId !== undefined) {
        throw Object.assign(new Error("Frame-scoped screenshots are not available"), { code: "frame_unavailable" });
      }
      return assertDeliverableSnapshot(await this.screenshot(tabId, params));
    }
    const rootBinding = parseTargetRef(params.root_ref);
    const requestedFrameId = frameId ?? rootBinding?.frameId;
    const frameDocument = await this.frameDocument(tabId, requestedFrameId);
    const topDocument = requestedFrameId === undefined
      ? frameDocument
      : await this.frameDocument(tabId);
    const isTopFrame = frameDocument.frameId === topDocument.frameId;
    const pageRevision = await this.revisions.observeDocument(
      tabId, topDocument.documentId, topDocument.loaderId,
    );
    const maxNodes = typeof params.max_nodes === "number" ? params.max_nodes : 1000;
    const maxDepth = typeof params.max_depth === "number" ? params.max_depth : 50;
    const rootTarget = typeof params.root_ref === "string"
      ? await this.resolveTarget(tabId, {
        pageRevision,
        ...(taskId !== undefined ? { taskId } : {}),
        ref: params.root_ref,
        ...(frameId !== undefined ? { frameId } : {}),
      })
      : undefined;
    const result = rootTarget !== undefined
      ? await this.send(tabId, "Accessibility.getPartialAXTree", {
        backendNodeId: rootTarget.backendNodeId,
        fetchRelatives: true,
      }, false, rootTarget.sessionId)
      : await this.send(tabId, "Accessibility.getFullAXTree", {
        depth: maxDepth,
        ...(frameId !== undefined ? { frameId } : {}),
      }, false, frameDocument.sessionId);
    const nodes = (Array.isArray(result.nodes) ? result.nodes.filter(isRecord) : []) as AxNode[];
    const axBackendIds = new Set<number>();
    for (const node of nodes) {
      if (typeof node.backendDOMNodeId === "number") axBackendIds.add(node.backendDOMNodeId);
    }
    const domFallbackNodes = rootTarget === undefined
      ? await this.#domEditableFallbackNodes(tabId, pageRevision, axBackendIds, frameDocument, taskId)
      : [];
    const after = await this.frameDocument(tabId, frameDocument.frameId);
    if (frameDocument.documentId !== after.documentId) {
      const currentPageRevision = isTopFrame
        ? await this.revisions.observeDocument(tabId, after.documentId, after.loaderId)
        : await this.revisions.current(tabId);
      throw Object.assign(new Error("Frame changed while capturing the accessibility tree"), {
        code: "stale_revision",
        currentPageRevision,
      });
    }
    const mintRef = (backendNodeId: number): string => mintTargetRef({
        tabId,
        backendNodeId,
        documentId: frameDocument.documentId,
        frameId: frameDocument.frameId,
        pageRevision,
        taskId,
      });
    const encoded = nodes.slice(0, Math.max(0, maxNodes - domFallbackNodes.length)).map((node) => ({
      ...(typeof node.backendDOMNodeId === "number" ? { ref: mintRef(node.backendDOMNodeId) } : {}),
      ...(typeof node.backendDOMNodeId === "number" ? { frame_id: frameDocument.frameId } : {}),
      role: typeof node.role?.value === "string" ? node.role.value : "unknown",
      name: typeof node.name?.value === "string" ? node.name.value : "",
      ...(node.value?.value !== undefined ? { value: node.value.value } : {}),
      ...(node.description?.value !== undefined ? { description: node.description.value } : {}),
      ...(node.ignored ? { ignored: true } : {}),
    }));
    const combined = [...domFallbackNodes, ...encoded];
    const frames: Array<Record<string, unknown>> = [];
    const frameTree = await this.send(tabId, "Page.getFrameTree", {});
    const pendingFrames: Array<{ tree: unknown; parent?: string }> = [{ tree: frameTree.frameTree }];
    for (const tree of await this.attachedFrameTrees(tabId)) pendingFrames.push({ tree });
    const seenFrames = new Set<string>();
    while (pendingFrames.length > 0 && frames.length < 256) {
      const entry = pendingFrames.pop();
      if (!entry || !isRecord(entry.tree) || !isRecord(entry.tree.frame)) continue;
      const frame = entry.tree.frame;
      if (typeof frame.id !== "string" || seenFrames.has(frame.id)) continue;
      seenFrames.add(frame.id);
      const parentId = entry.parent ?? (typeof frame.parentId === "string" ? frame.parentId : undefined);
      frames.push({
        frame_id: frame.id,
        ...(parentId !== undefined ? { parent_frame_id: parentId } : {}),
        ...(typeof frame.url === "string" ? { url: frame.url } : {}),
      });
      if (Array.isArray(entry.tree.childFrames)) {
        for (const tree of entry.tree.childFrames) pendingFrames.push({ tree, parent: frame.id });
      }
    }
    return assertDeliverableSnapshot({
      tab_id: tabId,
      page_revision: pageRevision,
      frame_id: frameDocument.frameId,
      frames,
      ...(pendingFrames.length > 0 ? { frames_truncated: true, frames_limit: 256 } : {}),
      mode,
      nodes: combined.slice(0, maxNodes),
      truncated: nodes.length + domFallbackNodes.length > maxNodes,
      ...(domFallbackNodes.length > 0 ? { dom_fallback_nodes: domFallbackNodes.length } : {}),
    });
  }

  async #domEditableFallbackNodes(
    tabId: number,
    pageRevision: number,
    axBackendIds: ReadonlySet<number>,
    document: FrameDocument,
    taskId: string,
  ): Promise<Array<Record<string, unknown>>> {
    try {
      const selected = await this.send(tabId, "DOM.querySelectorAll", {
        nodeId: document.rootNodeId,
        selector: DOM_EDITABLE_FALLBACK_SELECTOR,
      }, false, document.sessionId);
      const nodeIds = Array.isArray(selected.nodeIds)
        ? selected.nodeIds.filter(
          (candidate): candidate is number => typeof candidate === "number" && candidate !== 0,
        )
        : [];
      const fallback: Array<Record<string, unknown>> = [];
      let inspected = 0;
      for (const nodeId of nodeIds) {
        if (fallback.length >= DOM_EDITABLE_FALLBACK_LIMIT) break;
        if (inspected >= DOM_EDITABLE_FALLBACK_INSPECT_LIMIT) break;
        inspected += 1;
        const described = await this.send(tabId, "DOM.describeNode", { nodeId, depth: 0 }, false, document.sessionId);
        const node = isRecord(described.node) ? described.node : null;
        if (!node || typeof node.backendNodeId !== "number") continue;
        if (axBackendIds.has(node.backendNodeId)) continue;
        const encoded = domEditableFallbackNode(node, pageRevision);
        if (encoded) {
          fallback.push({
            ...encoded,
            ref: mintTargetRef({
                tabId,
                backendNodeId: node.backendNodeId,
                documentId: document.documentId,
                frameId: document.frameId,
                pageRevision,
                taskId,
              }),
            frame_id: document.frameId,
          });
        }
      }
      return fallback;
    } catch {
      return [];
    }
  }


  async act(
    taskId: string,
    tabId: number,
    expectedRevision: unknown,
    actions: unknown,
  ): Promise<ActionExecution> {
    await this.authorizeDebuggerUse(tabId);
    const pageRevision = await this.revisions.assertExpected(tabId, expectedRevision);
    if (!Array.isArray(actions) || actions.length === 0 || actions.length > 64) {
      throw Object.assign(new Error("actions must contain between 1 and 64 operations"), {
        code: "invalid_request",
      });
    }
    const validated: Array<Record<string, unknown>> = [];
    for (const action of actions) {
      if (!isRecord(action) || typeof action.kind !== "string") {
        throw Object.assign(new Error("Each browser action requires a kind"), { code: "invalid_request" });
      }
      validated.push(action);
    }
    if (validated.some((action) => TAB_ONLY_ACTIONS[String(action.kind)] !== true)) {
      await this.requireFullAutomationRoute(tabId, "perform page actions");
    }
    const completedActions: Array<Record<string, unknown>> = [];
    for (const [index, action] of validated.entries()) {
      if (
        index < validated.length - 1 &&
        (action.kind === "navigate" ||
          action.kind === "go_back" ||
          action.kind === "go_forward" ||
          action.kind === "reload" ||
          action.kind === "close")
      ) {
        throw Object.assign(new Error(`${String(action.kind)} must be the final action in a batch`), {
          code: "invalid_request",
        });
      }
      await this.revisions.assertExpected(tabId, pageRevision);
      const hasRef = typeof action.ref === "string";
      const hasSelector = typeof action.selector === "string";
      if (
        action.kind === "click" ||
        action.kind === "hover" ||
        action.kind === "double_click" ||
        action.kind === "context_click" ||
        action.kind === "type" ||
        action.kind === "fill" ||
        action.kind === "select" ||
        action.kind === "press" ||
        action.kind === "upload_file"
      ) {
        if (hasRef === hasSelector) {
          throw Object.assign(new Error(`${action.kind} requires exactly one of ref or selector`), {
            code: "invalid_request",
          });
        }
      }
      validateKeyboardAction(action);
      const resolvedTarget = hasSelector || hasRef
        ? await this.resolveTarget(tabId, {
          taskId,
          pageRevision,
          ...(hasRef ? { ref: String(action.ref) } : { selector: String(action.selector) }),
          ...(typeof action.frame_id === "string" ? { frameId: action.frame_id } : {}),
          actionKind: String(action.kind),
        })
        : undefined;
      const stagedConsequence = await this.consequence(tabId, action, resolvedTarget);
      if (stagedConsequence && !(await readState()).skipCommitReview) {
        const staged: StagedCommit = {
          native_token: randomToken(),
          task_id: taskId,
          tab_id: tabId,
          page_revision: pageRevision,
          effect: stagedConsequence.effect,
          fingerprint: await this.stageFingerprint(
            taskId,
            tabId,
            pageRevision,
            action,
            stagedConsequence.target,
          ),
          expires_at_ms: Date.now() + 300_000,
          action: { action },
          preview: {
            effect: stagedConsequence.effect,
            kind: action.kind,
            target: stagedConsequence.target,
            ...(typeof action.ref === "string" ? { ref: action.ref } : {}),
            ...(typeof action.selector === "string" ? { selector: action.selector } : {}),
            ...(typeof action.frame_id === "string" ? { frame_id: action.frame_id } : {}),
            ...(typeof action.key === "string" ? { key: action.key, modifiers: action.modifiers ?? [] } : {}),
            ...(typeof action.prompt_text === "string" ? { prompt_text: action.prompt_text } : {}),
            ...(action.expect_download === true ? { expect_download: true } : {}),
          },
          ...(stagedConsequence.dialog !== undefined ? { dialog: stagedConsequence.dialog.binding } : {}),
        };
        await mutateState((state) => {
          if (
            stagedConsequence.dialog !== undefined &&
            this.sessions.get(tabId)?.dialog !== stagedConsequence.dialog.live
          ) {
            throw Object.assign(new Error("JavaScript dialog changed before it could be staged"), {
              code: "invalid_request",
            });
          }
          state.stagedCommits[staged.native_token] = staged;
        });
        return {
          staged,
          result: {
            tab_id: tabId,
            page_revision: await this.revisions.current(tabId),
            actions: completedActions,
            staged_index: index,
          },
        };
      }
      completedActions.push(await this.performAction(taskId, tabId, pageRevision, action, resolvedTarget));
    }
    return {
      result: {
        tab_id: tabId,
        page_revision: await this.revisions.current(tabId),
        actions: completedActions,
      },
    };
  }

  async fillCredentials(
    taskId: string,
    tabId: number,
    expectedRevision: unknown,
    fields: unknown,
  ): Promise<Record<string, unknown>> {
    await this.authorizeDebuggerUse(tabId);
    const pageRevision = await this.revisions.assertExpected(tabId, expectedRevision);
    await this.requireFullAutomationRoute(tabId, "fill credentials");
    if (!Array.isArray(fields) || fields.length === 0 || fields.length > 3) {
      throw Object.assign(new Error("Credential fields must contain between 1 and 3 entries"), {
        code: "invalid_request",
      });
    }
    for (const field of fields) {
      if (
        !isRecord(field) ||
        typeof field.kind !== "string" ||
        typeof field.ref !== "string" ||
        typeof field.value !== "string"
      ) {
        throw Object.assign(new Error("Credential field is malformed"), { code: "invalid_request" });
      }
      await this.revisions.assertExpected(tabId, pageRevision);
      const target = await this.resolveTarget(tabId, {
        taskId,
        pageRevision,
        ref: field.ref,
      });
      const topFrame = await this.frameIdentity(tabId);
      if (target.frameId !== topFrame.frameId) {
        const targetFrame = await this.frameIdentity(tabId, target.frameId);
        const sameOrigin = (() => {
          if (topFrame.url === undefined || targetFrame.url === undefined) return false;
          try {
            return new URL(topFrame.url).origin === new URL(targetFrame.url).origin;
          } catch {
            return false;
          }
        })();
        if (!sameOrigin) {
          throw Object.assign(
            new Error("Credentials cannot be filled in a cross-origin frame without frame-specific authorization"),
            { code: "cross_origin_credentials_forbidden" },
          );
        }
      }
      await this.callOnNode(
        tabId,
        target.backendNodeId,
        `function(value,kind){
          const input=this;
          const isInput=input instanceof HTMLInputElement;
          const isTextarea=input instanceof HTMLTextAreaElement;
          if(!isInput&&!isTextarea)throw new Error("Credential target is not an input");
          const type=(isInput?input.type:"text").toLowerCase();
          const autocomplete=(input.getAttribute("autocomplete")||"").toLowerCase();
          const valid=kind==="password"
            ? isInput&&(type==="password"||autocomplete.includes("password"))
            : kind==="otp"
              ? isInput&&(autocomplete==="one-time-code"||["text","tel","number"].includes(type))
              : ["text","email","tel"].includes(type)||isTextarea;
          if(!valid)throw new Error("Credential target kind does not match the requested field");
          input.focus();
          const prototype=isInput?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;
          const setter=Object.getOwnPropertyDescriptor(prototype,"value")&&Object.getOwnPropertyDescriptor(prototype,"value").set;
          if(!setter)throw new Error("Credential target has no value setter");
          setter.call(input,value);
          input.dispatchEvent(new Event("input",{bubbles:true,composed:true}));
          input.dispatchEvent(new Event("change",{bubbles:true,composed:true}));
        }`,
        [{ value: field.value }, { value: field.kind }],
        false,
        target,
      );
    }
    return {
      tab_id: tabId,
      page_revision: await this.revisions.current(tabId),
      filled_fields: fields.length,
    };
  }

  async bindReview(taskId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const nativeToken = params.native_token;
    const reviewHandle = params.review_handle;
    const tabId = params.tab_id;
    if (
      typeof nativeToken !== "string" ||
      typeof reviewHandle !== "string" ||
      !Number.isInteger(tabId)
    ) {
      throw Object.assign(new Error("Commit review binding is malformed"), { code: "invalid_request" });
    }
    const bound = await mutateState((state) => {
      const staged = state.stagedCommits[nativeToken];
      if (
        !staged ||
        staged.task_id !== taskId ||
        staged.tab_id !== tabId ||
        staged.review_handle !== undefined
      ) {
        return false;
      }
      staged.review_handle = reviewHandle;
      staged.approved = false;
      return true;
    });
    if (!bound) {
      throw Object.assign(new Error("Commit review binding does not match a staged operation"), {
        code: "invalid_staged_token",
      });
    }
    return { review_bound: true };
  }

  async reviewBinding(reviewHandle: string): Promise<{ task_id: string; tab_id: number }> {
    const staged = Object.values((await readState()).stagedCommits).find(
      (candidate) => candidate.review_handle === reviewHandle && candidate.approved !== true,
    );
    if (!staged) {
      throw Object.assign(new Error("Commit review is no longer available"), {
        code: "invalid_staged_token",
      });
    }
    return { task_id: staged.task_id, tab_id: staged.tab_id };
  }

  async approveReview(reviewHandle: string): Promise<boolean> {
    return mutateState((state) => {
      const staged = Object.values(state.stagedCommits).find(
        (candidate) => candidate.review_handle === reviewHandle && candidate.approved !== true,
      );
      if (!staged) return false;
      staged.approved = true;
      return true;
    });
  }

  async abandonReview(reviewHandle: string): Promise<boolean> {
    return mutateState((state) => {
      const entry = Object.entries(state.stagedCommits).find(
        ([, staged]) => staged.review_handle === reviewHandle,
      );
      if (!entry) return false;
      delete state.stagedCommits[entry[0]];
      return true;
    });
  }

  async abandonNativeStage(
    taskId: string,
    nativeToken: unknown,
    tabId: unknown,
  ): Promise<Record<string, unknown>> {
    if (typeof nativeToken !== "string" || !Number.isInteger(tabId)) {
      throw Object.assign(new Error("Commit stage cleanup is malformed"), { code: "invalid_request" });
    }
    const abandoned = await mutateState((state) => {
      const staged = state.stagedCommits[nativeToken];
      if (!staged || staged.task_id !== taskId || staged.tab_id !== tabId) return false;
      delete state.stagedCommits[nativeToken];
      return true;
    });
    if (!abandoned) {
      throw Object.assign(new Error("Commit stage is invalid, used, or belongs to another task"), {
        code: "invalid_staged_token",
      });
    }
    return { abandoned: true };
  }

  async discardNativeStages(nativeTokens: readonly string[]): Promise<void> {
    if (nativeTokens.length === 0) return;
    const tokens = new Set(nativeTokens);
    await mutateState((state) => {
      for (const token of tokens) delete state.stagedCommits[token];
    });
  }

  async abandonAllStages(): Promise<void> {
    await mutateState((state) => {
      state.stagedCommits = {};
    });
  }

  async stagedTabId(taskId: string, nativeToken: unknown): Promise<number> {
    if (typeof nativeToken !== "string") {
      throw Object.assign(new Error("browser_commit requires a native token"), { code: "invalid_request" });
    }
    const staged = (await readState()).stagedCommits[nativeToken];
    if (!staged || staged.task_id !== taskId) {
      throw Object.assign(new Error("Staged commit token is invalid, used, or belongs to another task"), {
        code: "invalid_staged_token",
      });
    }
    return staged.tab_id;
  }

  async commit(taskId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const nativeToken = params.native_token;
    const tabId = await this.stagedTabId(taskId, nativeToken);
    await this.authorizeDebuggerUse(tabId);
    const staged = (await readState()).stagedCommits[String(nativeToken)];
    if (!staged || staged.task_id !== taskId || staged.tab_id !== tabId) {
      throw Object.assign(new Error("Staged commit token is invalid, used, or belongs to another task"), {
        code: "invalid_staged_token",
      });
    }
    if (staged.expires_at_ms <= Date.now()) {
      await mutateState((state) => {
        delete state.stagedCommits[String(nativeToken)];
      });
      this.emit("commit_expired", { native_token: String(nativeToken) });
      throw Object.assign(new Error("Staged commit token expired"), { code: "staged_commit_expired" });
    }
    await this.revisions.assertExpected(staged.tab_id, staged.page_revision);
    const action = staged.action.action;
    if (!isRecord(action) || typeof action.kind !== "string") {
      await mutateState((state) => {
        delete state.stagedCommits[String(nativeToken)];
      });
      throw Object.assign(new Error("Staged operation is malformed"), { code: "staged_commit_mismatch" });
    }
    if (TAB_ONLY_ACTIONS[action.kind] !== true) {
      await this.requireFullAutomationRoute(tabId, "commit a page action");
    }
    const stagedTarget = isRecord(staged.preview.target) ? staged.preview.target : null;
    const fingerprint = stagedTarget
      ? await this.stageFingerprint(taskId, staged.tab_id, staged.page_revision, action, stagedTarget)
      : "";
    if (fingerprint !== staged.fingerprint) {
      await mutateState((state) => {
        delete state.stagedCommits[String(nativeToken)];
      });
      throw Object.assign(new Error("Staged operation changed before Commit"), {
        code: "staged_commit_mismatch",
      });
    }
    let checkedTarget: ResolvedTarget | undefined;
    let currentTarget: Record<string, unknown>;
    try {
      validateKeyboardAction(action);
      if (typeof action.ref === "string" || typeof action.selector === "string") {
        checkedTarget = await this.resolveTarget(staged.tab_id, {
          taskId,
          pageRevision: staged.page_revision,
          ...(typeof action.ref === "string" ? { ref: action.ref } : { selector: String(action.selector) }),
          ...(typeof action.frame_id === "string" ? { frameId: action.frame_id } : {}),
          actionKind: action.kind,
        });
        currentTarget = await this.targetDescriptorForBackendNode(
          staged.tab_id, checkedTarget.backendNodeId, action, checkedTarget,
        );
      } else {
        currentTarget = { kind: action.kind };
      }
    } catch (error) {
      await mutateState((state) => {
        delete state.stagedCommits[String(nativeToken)];
      });
      throw Object.assign(new Error("Staged target changed before Commit"), {
        code: "staged_commit_mismatch",
        cause: error,
      });
    }
    if (
      await this.stageFingerprint(taskId, staged.tab_id, staged.page_revision, action, currentTarget) !==
      staged.fingerprint
    ) {
      await mutateState((state) => {
        delete state.stagedCommits[String(nativeToken)];
      });
      throw Object.assign(new Error("Staged target changed before Commit"), {
        code: "staged_commit_mismatch",
      });
    }
    await mutateState((state) => {
      delete state.stagedCommits[String(nativeToken)];
    });
    const result = action.kind === "dialog" && action.decision === "accept"
      ? await this.acceptStagedDialog(staged.tab_id, action, staged.dialog)
      : await this.performAction(taskId, staged.tab_id, staged.page_revision, action, checkedTarget);
    return {
      tab_id: staged.tab_id,
      page_revision: await this.revisions.current(staged.tab_id),
      actions: [result],
    };
  }

  async expireCommits(): Promise<void> {
    const expired = await mutateState((state) => {
      const tokens = Object.values(state.stagedCommits)
        .filter((staged) => staged.expires_at_ms <= Date.now())
        .map((staged) => staged.native_token);
      for (const token of tokens) delete state.stagedCommits[token];
      return tokens;
    });
    for (const nativeToken of expired) {
      this.emit("commit_expired", { native_token: nativeToken });
    }
  }

  async wait(
    tabId: number,
    params: Record<string, unknown>,
    revalidate?: () => Promise<void>,
    taskId?: string,
  ): Promise<Record<string, unknown>> {
    if (!isRecord(params.condition) || typeof params.condition.kind !== "string") {
      throw Object.assign(new Error("browser_wait requires a condition"), { code: "invalid_request" });
    }
    const condition = params.condition;
    const conditionKind = String(condition.kind);
    if (SUPPORTED_WAIT_CONDITIONS[conditionKind] !== true) {
      throw Object.assign(new Error(`Unsupported wait condition: ${conditionKind}`), {
        code: "invalid_request",
      });
    }
    const requiresFullAutomationRoute = TAB_ONLY_WAIT_CONDITIONS[conditionKind] !== true;
    await this.authorizeDebuggerUse(tabId);
    if (requiresFullAutomationRoute) {
      await this.requireFullAutomationRoute(tabId, `wait for page ${conditionKind}`);
    }
    const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : 30_000;
    const waitStartedAtMs = Date.now();
    const deadline = waitStartedAtMs + timeoutMs;
    const retainedDownload = conditionKind === "download"
      ? this.downloadCursorMatch(taskId, tabId, condition)
      : undefined;
    let debuggerSession =
      (conditionKind === "network_idle" || (conditionKind === "download" && !retainedDownload))
        ? await this.acquireDebuggerBusyLease(tabId)
        : undefined;
    try {
      do {
        await this.authorizeDebuggerUse(tabId);
        if (revalidate) await revalidate();
        if (requiresFullAutomationRoute) {
          await this.requireFullAutomationRoute(tabId, `wait for page ${conditionKind}`);
        }
        if (
          debuggerSession &&
          (this.sessions.get(tabId) !== debuggerSession || !debuggerSession.attached)
        ) {
          debuggerSession = await this.acquireDebuggerBusyLease(tabId, debuggerSession);
        }
        const matched = retainedDownload ??
          await this.conditionMatched(tabId, condition, waitStartedAtMs, debuggerSession, taskId);
        if (revalidate) await revalidate();
        if (matched) {
          return {
            tab_id: tabId,
            page_revision: await this.revisions.current(tabId),
            condition: conditionKind,
            matched: true,
            ...(matched !== true
              ? {
                download: {
                  guid: matched.guid,
                  status: matched.status,
                  ...(matched.url !== undefined ? { url: matched.url } : {}),
                  ...(matched.suggestedFilename !== undefined
                    ? { suggested_filename: matched.suggestedFilename }
                    : {}),
                },
              }
              : {}),
          };
        }
        const delay = Promise.withResolvers<void>();
        setTimeout(delay.resolve, 100);
        await delay.promise;
      } while (Date.now() < deadline);
      throw Object.assign(new Error(`Timed out waiting for ${String(condition.kind)}`), {
        code: "wait_timeout",
        outcome: "unknown",
      });
    } finally {
      if (debuggerSession) this.releaseDebuggerBusyLease(tabId, debuggerSession);
    }
  }

  async developer(tabId: number, action: string, params: Record<string, unknown>): Promise<unknown> {
    await this.authorizeDebuggerUse(tabId);
    const [domain, ...rest] = action.split(".");
    if (!domain || rest.length === 0) {
      throw Object.assign(new Error("Developer action must be a CDP Domain.method"), {
        code: "invalid_request",
      });
    }
    await this.requireFullAutomationRoute(tabId, `run ${action}`);
    return this.send(tabId, action, params);
  }

  private async scriptSnapshot(
    tabId: number,
    mode: "text" | "html",
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.authorizeDebuggerUse(tabId);
    const selector = typeof params.selector === "string" ? params.selector : null;
    const selectorMatch = params.match === "last" ? "last" : "first";
    const requestedMaxBytes = typeof params.max_bytes === "number"
      ? Math.min(params.max_bytes, SNAPSHOT_TEXT_MAX_BYTES)
      : 256_000;
    const frameId = typeof params.frame_id === "string" ? params.frame_id : undefined;
    const before = await this.pageIdentity(tabId, frameId);
    const topBefore = frameId === undefined ? before : await this.pageIdentity(tabId);
    const pageRevision = await this.revisions.observeDocument(tabId, topBefore.documentId, topBefore.loaderId);
    const readContent = (
      snapshotMode: "text" | "html",
      targetSelector: string | null,
      targetMatch: "first" | "last",
    ): string => {
      const matches = targetSelector ? document.querySelectorAll(targetSelector) : [];
      const target = targetSelector
        ? targetMatch === "last" ? matches[matches.length - 1] : matches[0]
        : document.documentElement;
      if (!target) throw new Error(`Selector did not match: ${targetSelector}`);
      return snapshotMode === "text" ? target.textContent ?? "" : target.outerHTML;
    };
    let result: unknown;
    if (frameId === undefined) {
      const [captured] = await chrome.scripting.executeScript({
        target: { tabId }, func: readContent, args: [mode, selector, selectorMatch],
      });
      result = captured.result;
    } else {
      const frame = await this.frameDocument(tabId, frameId);
      const resolved = await this.send(tabId, "DOM.resolveNode", {
        nodeId: frame.rootNodeId,
        ...(frame.contextId !== undefined ? { executionContextId: frame.contextId } : {}),
      }, false, frame.sessionId);
      if (!isRecord(resolved.object) || typeof resolved.object.objectId !== "string") {
        throw Object.assign(new Error("Frame document no longer resolves"), { code: "stale_ref" });
      }
      const captured = await this.send(tabId, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: readContent.toString(),
        arguments: [{ value: mode }, { value: selector }, { value: selectorMatch }],
        returnByValue: true,
      }, false, frame.sessionId);
      if (isRecord(captured.exceptionDetails) || !isRecord(captured.result) ||
          typeof captured.result.value !== "string") {
        throw Object.assign(new Error("Could not read the requested frame content"), { code: "snapshot_failed" });
      }
      result = captured.result.value;
    }
    const after = await this.pageIdentity(tabId, frameId);
    const topAfter = frameId === undefined ? after : await this.pageIdentity(tabId);
    const currentPageRevision = await this.revisions.observeDocument(tabId, topAfter.documentId, topAfter.loaderId);
    if (
      before.documentId !== after.documentId ||
      before.loaderId !== after.loaderId ||
      currentPageRevision !== pageRevision
    ) {
      throw Object.assign(new Error(`Page changed while the ${mode} snapshot was captured`), {
        code: "stale_revision",
        currentPageRevision,
      });
    }
    const bytes = utf8Encoder.encode(String(result ?? ""));
    const requestedBytes = Math.min(bytes.length, requestedMaxBytes);
    const buildResult = (byteLimit: number): Record<string, unknown> => {
      const content = utf8Prefix(bytes, byteLimit);
      const contentBytes = utf8Encoder.encode(content).length;
      return {
        tab_id: tabId,
        page_revision: pageRevision,
        ...(frameId !== undefined ? { frame_id: frameId } : {}),
        mode,
        content,
        truncated: contentBytes < bytes.length,
      };
    };
    const bounded = buildResult(requestedBytes);
    if (serializedBytes(bounded) <= SNAPSHOT_RESULT_BUDGET_BYTES) return bounded;

    // JSON escaping can expand HTML/text (for example quotes or control bytes).
    // Binary-search the largest UTF-8 prefix whose complete result remains
    // deliverable instead of letting Core replace it with response_too_large.
    let lower = 0;
    let upper = requestedBytes;
    while (lower < upper) {
      const candidate = Math.ceil((lower + upper) / 2);
      const resultAtCandidate = buildResult(candidate);
      if (serializedBytes(resultAtCandidate) <= SNAPSHOT_RESULT_BUDGET_BYTES) {
        lower = candidate;
      } else {
        upper = candidate - 1;
      }
    }
    return buildResult(lower);
  }

  private async screenshot(tabId: number, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const before = await this.pageIdentity(tabId);
    const pageRevision = await this.revisions.observeDocument(tabId, before.documentId, before.loaderId);
    const format = params.format === "jpeg" || params.format === "webp" ? params.format : "png";
    const capture: Record<string, unknown> = {
      format,
      fromSurface: true,
      captureBeyondViewport: params.full_page === true,
    };
    if (typeof params.quality === "number") capture.quality = params.quality;
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    if (typeof params.selector === "string") {
      const document = await this.send(tabId, "DOM.getDocument", { depth: 0 });
      if (!isRecord(document.root) || typeof document.root.nodeId !== "number") {
        throw Object.assign(new Error("Could not inspect screenshot document"), { code: "snapshot_failed" });
      }
      const selected = await this.send(tabId, "DOM.querySelector", {
        nodeId: document.root.nodeId,
        selector: params.selector,
      });
      if (typeof selected.nodeId !== "number" || selected.nodeId === 0) {
        throw Object.assign(new Error(`Selector did not match: ${params.selector}`), {
          code: "selector_not_found",
        });
      }
      const model = await this.send(tabId, "DOM.getBoxModel", { nodeId: selected.nodeId });
      if (!isRecord(model.model) || !Array.isArray(model.model.border)) {
        throw Object.assign(new Error("Selected element has no visible box"), { code: "snapshot_failed" });
      }
      const points = model.model.border.map(Number);
      const x = Math.min(points[0], points[2], points[4], points[6]);
      const y = Math.min(points[1], points[3], points[5], points[7]);
      clip = {
        x,
        y,
        width: Math.max(points[0], points[2], points[4], points[6]) - x,
        height: Math.max(points[1], points[3], points[5], points[7]) - y,
        scale: 1,
      };
    } else if (
      params.full_page === true ||
      typeof params.max_width === "number" ||
      typeof params.max_height === "number"
    ) {
      const metrics = await this.send(tabId, "Page.getLayoutMetrics", {});
      const viewport = params.full_page === true
        ? metrics.cssContentSize ?? metrics.contentSize
        : metrics.cssVisualViewport ?? metrics.visualViewport ?? metrics.cssLayoutViewport ?? metrics.layoutViewport;
      if (isRecord(viewport)) {
        clip = {
          x: Number(viewport.x ?? viewport.pageX ?? viewport.offsetX ?? 0),
          y: Number(viewport.y ?? viewport.pageY ?? viewport.offsetY ?? 0),
          width: Number(viewport.width ?? viewport.clientWidth ?? 0),
          height: Number(viewport.height ?? viewport.clientHeight ?? 0),
          scale: 1,
        };
      }
    }
    if (clip) {
      if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || clip.width <= 0 || clip.height <= 0) {
        throw Object.assign(new Error("Screenshot capture area is invalid"), { code: "snapshot_failed" });
      }
      const maxWidth = typeof params.max_width === "number" ? params.max_width : clip.width;
      const maxHeight = typeof params.max_height === "number" ? params.max_height : clip.height;
      clip.scale = Math.min(1, maxWidth / clip.width, maxHeight / clip.height);
      capture.clip = clip;
    } else if (typeof params.max_width === "number" || typeof params.max_height === "number") {
      throw Object.assign(new Error("Could not inspect the screenshot viewport"), { code: "snapshot_failed" });
    }
    const result = await this.send(tabId, "Page.captureScreenshot", capture);
    const after = await this.pageIdentity(tabId);
    const currentPageRevision = await this.revisions.observeDocument(tabId, after.documentId, after.loaderId);
    if (
      before.documentId !== after.documentId ||
      before.loaderId !== after.loaderId ||
      currentPageRevision !== pageRevision
    ) {
      throw Object.assign(new Error("Page changed while the screenshot was captured"), {
        code: "stale_revision",
        currentPageRevision,
      });
    }
    if (typeof result.data !== "string") {
      throw Object.assign(new Error("Chrome returned an invalid screenshot payload"), { code: "snapshot_failed" });
    }
    const byteLength = base64ByteLength(result.data);
    if (byteLength === null) {
      throw Object.assign(new Error("Chrome returned malformed screenshot data"), { code: "snapshot_failed" });
    }
    const maxBytes = typeof params.max_bytes === "number"
      ? Math.min(params.max_bytes, SCREENSHOT_MAX_BYTES)
      : SCREENSHOT_MAX_BYTES;
    if (byteLength > maxBytes) {
      throw snapshotTooLarge(
        `Screenshot is ${byteLength} bytes; the requested deliverable limit is ${maxBytes} bytes`,
        "Use jpeg or webp, lower quality, set max_width/max_height, or capture a narrower selector.",
      );
    }
    return {
      tab_id: tabId,
      page_revision: pageRevision,
      mode: "screenshot",
      data: result.data,
      encoding: "base64",
      media_type: `image/${format}`,
      format,
      byte_length: byteLength,
    };
  }


  private async consequence(
    tabId: number,
    action: Record<string, unknown>,
    resolvedTarget?: ResolvedTarget,
  ): Promise<StagedConsequence | null> {
    if (action.kind === "close") {
      return {
        effect: "Close an AgentTab-owned browser tab",
        target: { kind: action.kind },
      };
    }
    if (action.kind === "upload_file") {
      const count = Array.isArray(action.files) ? action.files.length : 0;
      if (!resolvedTarget) throw Object.assign(new Error("Upload requires a resolved target"), { code: "invalid_request" });
      const target = await this.targetDescriptorForBackendNode(
        tabId, resolvedTarget.backendNodeId, action, resolvedTarget,
      );
      return {
        effect: `Upload ${count} ${count === 1 ? "file" : "files"} to the page`,
        target,
      };
    }
    if (action.kind === "dialog" && action.decision === "accept") {
      return {
        effect: "Accept a browser confirmation dialog",
        target: { kind: action.kind },
        dialog: await this.stageDialog(tabId, action),
      };
    }
    if (
      action.kind !== "click" &&
      action.kind !== "hover" &&
      action.kind !== "double_click" &&
      action.kind !== "context_click" &&
      action.kind !== "select" &&
      action.kind !== "fill" &&
      action.kind !== "type" &&
      action.kind !== "press"
    ) {
      return null;
    }
    const hasRef = typeof action.ref === "string";
    const hasSelector = typeof action.selector === "string";
    if (hasRef === hasSelector) {
      throw Object.assign(new Error(`${action.kind} requires exactly one of ref or selector`), {
        code: "invalid_request",
      });
    }
    if (!resolvedTarget) throw Object.assign(new Error("Action requires a resolved target"), { code: "invalid_request" });
    const target = await this.targetDescriptorForBackendNode(
      tabId, resolvedTarget.backendNodeId, action, resolvedTarget,
    );
    // Review new gestures and chords before unlabelled custom page handlers run.
    if (action.kind === "hover" || action.kind === "double_click" || action.kind === "context_click" ||
        action.kind === "press" && Array.isArray(action.modifiers) && action.modifiers.length > 0) {
      return {
        effect: action.kind === "press"
          ? `Press ${[...(Array.isArray(action.modifiers) ? action.modifiers : []), action.key].join("+")} on the reviewed control`
          : `Perform ${action.kind} on the reviewed control`,
        target,
      };
    }
    const label = [
      target.role,
      target.text,
      target.aria_label,
      target.title,
      target.name,
      target.id,
      target.type,
      target.form_action,
      target.form_method,
      ...(Array.isArray(target.associated_labels) ? target.associated_labels : []),
      ...(Array.isArray(target.accessible_labels) ? target.accessible_labels : []),
      target.requested_option_label,
    ].filter((value): value is string => typeof value === "string").join(" ").replace(/\s+/g, " ").trim();
    if (action.kind === "press" && action.key !== "Enter" && action.key !== "Space") return null;
    const formActivation =
      action.kind === "press" &&
      typeof target.form_action === "string" &&
      (
        action.key === "Enter" && (target.tag === "INPUT" || target.tag === "TEXTAREA" || target.tag === "BUTTON") ||
        action.key === "Space" && (target.tag === "BUTTON" || target.type === "submit" || target.type === "reset")
      );
    if (
      formActivation ||
      /\b(buy|purchase|pay|send|transfer|delete|remove|publish|post|deploy|merge|approve|authorize|grant|revoke|unsubscribe|cancel subscription|place order|checkout|submit order|confirm order|permission)\b/i.test(
        label,
      )
    ) {
      return {
        effect: formActivation
          ? `Activate form control by pressing ${String(action.key)}`
          : `${action.kind === "click" || action.kind === "press" ? "Activate" : "Change"} consequential control: ${label.slice(0, 160)}`,
        target,
      };
    }
    return null;
  }

  private async stageFingerprint(
    taskId: string,
    tabId: number,
    pageRevision: number,
    action: Record<string, unknown>,
    target: Record<string, unknown>,
  ): Promise<string> {
    return sha256Hex({ task_id: taskId, tab_id: tabId, page_revision: pageRevision, action, target });
  }


  private async stageDialog(
    tabId: number,
    action?: Record<string, unknown>,
  ): Promise<PreparedDialog> {
    await this.ensureAttached(tabId);
    const dialog = this.sessions.get(tabId)?.dialog;
    if (!dialog) {
      throw Object.assign(new Error("Accepting a dialog requires an open JavaScript dialog"), {
        code: "invalid_request",
      });
    }
    this.assertDialogPrompt(action, dialog, "invalid_request");
    const fingerprint = await dialog.fingerprint;
    if (this.sessions.get(tabId)?.dialog !== dialog) {
      throw Object.assign(new Error("JavaScript dialog changed before it could be staged"), {
        code: "invalid_request",
      });
    }
    return { binding: { generation: dialog.generation, fingerprint }, live: dialog };
  }

  private async acceptStagedDialog(
    tabId: number,
    action: Record<string, unknown>,
    stagedDialog: StagedDialog | undefined,
  ): Promise<Record<string, unknown>> {
    if (!stagedDialog) {
      throw Object.assign(new Error("Staged dialog binding is missing"), { code: "staged_commit_mismatch" });
    }
    await this.ensureAttached(tabId);
    await this.authorizeDebuggerUse(tabId);
    const dialog = this.sessions.get(tabId)?.dialog;
    if (!dialog || dialog.generation !== stagedDialog.generation) {
      throw Object.assign(new Error("The staged JavaScript dialog is no longer open"), {
        code: "staged_commit_mismatch",
      });
    }
    const fingerprint = await dialog.fingerprint;
    if (
      fingerprint !== stagedDialog.fingerprint ||
      this.sessions.get(tabId)?.dialog !== dialog ||
      dialog.generation !== stagedDialog.generation
    ) {
      throw Object.assign(new Error("The staged JavaScript dialog changed before Commit"), {
        code: "staged_commit_mismatch",
      });
    }
    this.assertDialogPrompt(action, dialog, "staged_commit_mismatch");
    const promptText = typeof action.prompt_text === "string" ? action.prompt_text : undefined;
    await this.send(tabId, "Page.handleJavaScriptDialog", {
      accept: true,
      ...(promptText !== undefined ? { promptText } : {}),
    });
    return { kind: "dialog", completed: true };
  }

  private assertDialogPrompt(
    action: Record<string, unknown> | undefined,
    dialog: JavaScriptDialog,
    code: "invalid_request" | "staged_commit_mismatch",
  ): void {
    if (typeof action?.prompt_text !== "string") return;
    if (dialog.type === "prompt") return;
    throw Object.assign(new Error("prompt_text can only accept a JavaScript prompt"), { code });
  }

  private async invalidateStagedDialogs(tabId: number): Promise<void> {
    await mutateState((state) => {
      for (const [token, staged] of Object.entries(state.stagedCommits)) {
        const action = staged.action.action;
        if (staged.tab_id === tabId && isRecord(action) && action.kind === "dialog") {
          delete state.stagedCommits[token];
        }
      }
    });
  }


  async targetDescriptorForBackendNode(
    tabId: number,
    backendNodeId: number,
    action?: Record<string, unknown>,
    target?: ResolvedTarget,
  ): Promise<Record<string, unknown>> {
    const requestedValue = action?.kind === "select"
      ? String(action.value ?? "")
      : action?.kind === "fill" || action?.kind === "type"
        ? String(action.text ?? "")
        : action?.kind === "press"
          ? String(action.key ?? "")
          : null;
    const resolved = await this.send(tabId, "DOM.resolveNode", {
      backendNodeId,
      ...(target?.contextId !== undefined ? { executionContextId: target.contextId } : {}),
    }, false, target?.sessionId);
    if (!isRecord(resolved.object) || typeof resolved.object.objectId !== "string") {
      throw Object.assign(new Error("Snapshot ref no longer resolves"), { code: "stale_ref" });
    }
    const described = await this.send(tabId, "Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration:
        `function(requestedValue){${SENSITIVE_FIELD_CHECK}if(requestedValue!==null&&sensitiveField){return {agenttab_sensitive_field:true}}const f=this.form;const option=this.options&&requestedValue!==null?Array.from(this.options).find(candidate=>String(candidate.value)===requestedValue):null;return {tag:this.tagName,role:this.getAttribute('role'),text:[this.innerText,this.textContent].filter(Boolean).join(' '),aria_label:this.getAttribute('aria-label'),title:this.getAttribute('title'),name:this.getAttribute('name'),id:this.id,type:this.getAttribute('type'),autocomplete:this.getAttribute('autocomplete'),href:this.getAttribute('href'),form_action:f&&f.action,form_method:f&&f.method,form_enctype:f&&f.enctype,associated_labels:associated,accessible_labels:accessible,requested_option_label:option?[option.label,option.textContent].filter(Boolean).join(' ').trim():null}}`,
      arguments: [{ value: requestedValue }],
      returnByValue: true,
    }, false, target?.sessionId);
    if (!isRecord(described.result) || !isRecord(described.result.value)) {
      throw Object.assign(new Error("Snapshot ref no longer resolves"), { code: "stale_ref" });
    }
    if (described.result.value.agenttab_sensitive_field === true) {
      throw Object.assign(new Error("Sensitive fields require a human Your Turn handoff"), {
        code: "sensitive_field_requires_handoff",
        recovery: "Start browser_handoff for this tab and let the human enter the sensitive value.",
      });
    }
    return {
      ...described.result.value,
      backend_node_id: backendNodeId,
      ...(target !== undefined ? { frame_id: target.frameId, document_id: target.documentId } : {}),
    };
  }

  private async performAction(
    taskId: string,
    tabId: number,
    pageRevision: number,
    action: Record<string, unknown>,
    resolvedTarget?: ResolvedTarget,
  ): Promise<Record<string, unknown>> {
    await this.authorizeDebuggerUse(tabId);
    const kind = action.kind;
    validateKeyboardAction(action);
    this.invalidatePendingDownloadAttribution(tabId);
    const downloadCursor = action.expect_download === true
      ? await this.armDownload(taskId, tabId)
      : undefined;
    const downloadResult = downloadCursor === undefined ? {} : { download_cursor: downloadCursor };
    if (kind === "navigate") {
      if (typeof action.url !== "string") throw Object.assign(new Error("navigate requires url"), { code: "invalid_request" });
      await chrome.tabs.update(tabId, { url: action.url });
      return { kind, started: true, ...downloadResult };
    }
    if (kind === "go_back") {
      await chrome.tabs.goBack(tabId);
      return { kind, started: true, ...downloadResult };
    }
    if (kind === "go_forward") {
      await chrome.tabs.goForward(tabId);
      return { kind, started: true, ...downloadResult };
    }
    if (kind === "reload") {
      await chrome.tabs.reload(tabId, { bypassCache: action.bypass_cache === true });
      return { kind, started: true, ...downloadResult };
    }
    if (kind === "close") {
      await this.closeTab(tabId);
      return { kind, completed: true };
    }
    if (kind === "set_viewport") {
      throw Object.assign(new Error("set_viewport is unavailable in Standard mode"), {
        code: "invalid_request",
      });
    }
    if (kind === "dialog") {
      if (action.decision === "accept") {
        throw Object.assign(new Error("Accepting a dialog requires a staged Commit"), {
          code: "invalid_request",
        });
      }
      await this.send(tabId, "Page.handleJavaScriptDialog", { accept: false });
      return { kind, completed: true };
    }
    if (kind === "scroll" && action.ref === undefined && action.frame_id === undefined) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (deltaX: number, deltaY: number) => window.scrollBy(deltaX, deltaY),
        args: [Number(action.delta_x ?? 0), Number(action.delta_y ?? 0)],
      });
      return { kind, completed: true };
    }
    const hasRef = typeof action.ref === "string";
    const hasSelector = typeof action.selector === "string";
    if (
      kind === "click" ||
      kind === "hover" ||
      kind === "double_click" ||
      kind === "context_click" ||
      kind === "type" ||
      kind === "fill" ||
      kind === "select" ||
      kind === "press" ||
      kind === "upload_file"
    ) {
      if (hasRef === hasSelector) {
        throw Object.assign(new Error(`${kind} requires exactly one of ref or selector`), {
          code: "invalid_request",
        });
      }
    }
    const target = resolvedTarget ?? await this.resolveTarget(tabId, {
      taskId,
      pageRevision,
      ...(hasRef ? { ref: String(action.ref) } : {
        selector: kind === "scroll" ? "html" : String(action.selector),
      }),
      ...(typeof action.frame_id === "string" ? { frameId: action.frame_id } : {}),
      actionKind: String(kind),
    });
    const backendNodeId = target.backendNodeId;
    if (kind === "click" || kind === "press") {
      const [activeTab, existingTabs] = await Promise.all([
        chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab),
        chrome.tabs.query({}),
      ]);
      const session = this.sessions.get(tabId);
      const pendingWindowOpen: PendingWindowOpen = {
        existingTabIds: new Set(
          existingTabs
            .map((tab) => tab.id)
            .filter((candidate): candidate is number => Number.isInteger(candidate)),
        ),
        activeTabId: Number.isInteger(activeTab?.id) ? activeTab.id : undefined,
        activeWindowId: Number.isInteger(activeTab?.windowId) ? activeTab.windowId : undefined,
        expiresAt: Date.now() + 1_000,
      };
      if (session) session.pendingWindowOpen = pendingWindowOpen;
      try {
        await this.callOnNode(
          tabId,
          backendNodeId,
          kind === "click"
            ? pageDomActionDeclaration(dispatchDomClick)
            : pageDomActionDeclaration(dispatchDomPress, DOM_SENSITIVE_ACTION_PRELUDE),
          kind === "click" ? [] : [{ value: action.key }, { value: action.modifiers ?? [] }],
          true,
          target,
        );
      } finally {
        const [currentActiveTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const actionOwnsFocusChange =
          currentActiveTab?.id !== activeTab?.id &&
          (currentActiveTab?.id === tabId || currentActiveTab?.openerTabId === tabId);
        if (
          actionOwnsFocusChange &&
          Number.isInteger(activeTab?.id) &&
          Number.isInteger(activeTab?.windowId)
        ) {
          const original = await chrome.tabs.get(activeTab.id as number).catch(() => null);
          if (original?.windowId === activeTab.windowId) {
            await chrome.tabs.update(activeTab.id as number, { active: true }).catch(() => undefined);
            await chrome.windows.update(activeTab.windowId as number, { focused: true }).catch(() => undefined);
          }
        }
        setTimeout(() => {
          if (session?.pendingWindowOpen === pendingWindowOpen) {
            session.pendingWindowOpen = undefined;
          }
        }, 1_000);
      }
    } else if (kind === "type") {
      await this.callOnNode(
        tabId,
        backendNodeId,
        pageDomActionDeclaration(dispatchDomType, DOM_SENSITIVE_ACTION_PRELUDE),
        [{ value: String(action.text ?? "") }],
        true,
        target,
      );
    } else if (kind === "fill") {
      await this.callOnNode(
        tabId,
        backendNodeId,
        pageDomActionDeclaration(dispatchDomFill, DOM_SENSITIVE_ACTION_PRELUDE),
        [{ value: String(action.text ?? "") }],
        true,
        target,
      );
    } else if (kind === "select") {
      await this.callOnNode(
        tabId,
        backendNodeId,
        pageDomActionDeclaration(dispatchDomSelect, DOM_SENSITIVE_ACTION_PRELUDE),
        [{ value: String(action.value ?? "") }],
        true,
        target,
      );
    } else if (kind === "scroll") {
      await this.callOnNode(
        tabId,
        backendNodeId,
        "function(x,y){this.scrollBy(x,y)}",
        [{ value: Number(action.delta_x ?? 0) }, { value: Number(action.delta_y ?? 0) }],
        false,
        target,
      );
    } else if (kind === "drag") {
      const dropTarget = await this.resolveTarget(tabId, {
        taskId, pageRevision, ref: String(action.target_ref), actionKind: "drag",
        ...(typeof action.frame_id === "string" ? { frameId: action.frame_id } : {}),
      });
      if (target.sessionId !== dropTarget.sessionId || target.frameId !== dropTarget.frameId) {
        throw Object.assign(new Error("Drag endpoints must belong to the same frame"), { code: "invalid_request" });
      }
      const [sourcePoint, dropPoint] = await Promise.all([
        this.pointerTargetPoint(tabId, target),
        this.pointerTargetPoint(tabId, dropTarget),
      ]);
      await this.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...sourcePoint, button: "left", buttons: 1, clickCount: 1 }, false, target.sessionId);
      try {
        await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...dropPoint, button: "left", buttons: 1 }, false, target.sessionId);
      } finally {
        await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...dropPoint, button: "left", buttons: 0, clickCount: 1 }, false, target.sessionId);
      }
    } else if (kind === "hover" || kind === "double_click" || kind === "context_click") {
      const point = await this.pointerTargetPoint(tabId, target);
      await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none", buttons: 0 }, false, target.sessionId);
      if (kind !== "hover") {
        const button = kind === "context_click" ? "right" : "left";
        const buttons = kind === "context_click" ? 2 : 1;
        for (let clickCount = 1; clickCount <= (kind === "double_click" ? 2 : 1); clickCount += 1) {
          await this.pointerTargetPoint(tabId, target, point);
          await this.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button, buttons, clickCount }, false, target.sessionId);
          await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button, buttons: 0, clickCount }, false, target.sessionId);
        }
      }
    } else if (kind === "upload_file") {
      if (!Array.isArray(action.files) || !action.files.every((file) => typeof file === "string")) {
        throw Object.assign(new Error("upload_file requires file paths"), { code: "invalid_request" });
      }
      await this.send(tabId, "DOM.setFileInputFiles", { files: action.files, backendNodeId }, false, target.sessionId);
    } else {
      throw Object.assign(new Error(`Unsupported standard action: ${String(kind)}`), {
        code: "invalid_request",
      });
    }
    return { kind, completed: true, ...downloadResult };
  }
  private async conditionMatched(
    tabId: number,
    condition: Record<string, unknown>,
    waitStartedAtMs: number,
    debuggerSession?: DebugSession,
    taskId?: string,
  ): Promise<boolean | DownloadMetadata> {
    const kind = condition.kind;
    if (kind === "load") return (await chrome.tabs.get(tabId)).status === "complete";
    if (kind === "url") return (await chrome.tabs.get(tabId)).url === condition.value;
    if (kind === "text") {
      const before = await this.pageIdentity(tabId);
      const matchedRevision = await this.revisions.observeDocument(
        tabId,
        before.documentId,
        before.loaderId,
      );
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (value: string) => (document.documentElement.textContent ?? "").includes(value),
        args: [String(condition.value ?? "")],
      });
      if (result !== true) return false;
      const after = await this.pageIdentity(tabId);
      const currentRevision = await this.revisions.observeDocument(
        tabId,
        after.documentId,
        after.loaderId,
      );
      return (
        before.documentId === after.documentId &&
        before.loaderId === after.loaderId &&
        matchedRevision === currentRevision
      );
    }
    if (kind === "selector" || kind === "value") {
      const selector = kind === "selector" ? condition.value : condition.selector;
      if (typeof selector !== "string") {
        throw Object.assign(new Error(`Wait condition ${String(kind)} requires a selector`), {
          code: "invalid_request",
        });
      }
      const frameId = typeof condition.frame_id === "string" ? condition.frame_id : undefined;
      const before = await this.frameDocument(tabId, frameId);
      const rootFrame = await this.frameIdentity(tabId);
      const isTopFrame = before.frameId === rootFrame.frameId;
      const beforeRevision = isTopFrame
        ? await this.revisions.observeDocument(tabId, before.documentId, before.loaderId)
        : await this.revisions.current(tabId);
      const state = condition.state;
      let target: ResolvedTarget;
      try {
        target = await this.resolveTarget(tabId, {
          pageRevision: beforeRevision,
          selector,
          ...(frameId !== undefined ? { frameId } : {}),
          ...(taskId !== undefined ? { taskId } : {}),
        });
      } catch (error) {
        if (isRecord(error) && error.code === "selector_not_found") {
          const stable = await this.waitFrameUnchanged(
            tabId,
            before,
            isTopFrame,
            beforeRevision,
          );
          return kind === "selector" && state === "detached" && stable;
        }
        throw error;
      }
      if (
        target.documentId !== before.documentId ||
        !(await this.waitFrameUnchanged(tabId, before, isTopFrame, beforeRevision))
      ) {
        return false;
      }
      if (kind === "selector" && state === "detached") return false;
      const observed = await this.inspectWaitTarget(tabId, target);
      if (!(await this.waitFrameUnchanged(tabId, before, isTopFrame, beforeRevision))) {
        return false;
      }
      if (kind === "value") return observed.value === String(condition.value ?? "");
      if (state === "visible") return observed.visible === true;
      if (state === "hidden") return observed.visible === false;
      if (state === "enabled") return observed.enabled === true;
      return observed.connected === true;
    }
    if (kind === "network_idle") {
      const session = debuggerSession;
      if (!session || this.sessions.get(tabId) !== session || !session.attached) return false;
      if (session.pageLoadInFlight) {
        if ((await chrome.tabs.get(tabId)).status === "loading") return false;
        session.pageLoadInFlight = false;
        session.lastNetworkActivity = Date.now();
      }
      return session.inflight.size === 0 && Date.now() - session.lastNetworkActivity >= 500;
    }
    if (kind === "download") {
      const retained = this.downloadCursorMatch(taskId, tabId, condition);
      if (retained) return retained;
      const session = debuggerSession;
      if (!session || this.sessions.get(tabId) !== session || !session.attached) return false;
      this.pruneDownloadState();
      for (const [guid, download] of session.downloads) {
        if (download.status !== "completed" || download.completedAt === undefined) continue;
        if (download.completedAt < waitStartedAtMs) continue;
        return {
          guid,
          status: "completed",
          ...(download.url !== undefined ? { url: download.url } : {}),
          ...(download.suggestedFilename !== undefined
            ? { suggestedFilename: download.suggestedFilename }
            : {}),
        };
      }
      return false;
    }
    throw Object.assign(new Error(`Unsupported wait condition: ${String(kind)}`), {
      code: "invalid_request",
    });
  }
  private async waitFrameUnchanged(
    tabId: number,
    before: FrameDocument,
    isTopFrame: boolean,
    beforeRevision: number,
  ): Promise<boolean> {
    try {
      const after = await this.frameDocument(tabId, before.frameId);
      if (after.documentId !== before.documentId) {
        if (isTopFrame) {
          await this.revisions.observeDocument(tabId, after.documentId, after.loaderId);
        }
        return false;
      }
      if (!isTopFrame) return true;
      return (
        await this.revisions.observeDocument(tabId, after.documentId, after.loaderId)
      ) === beforeRevision;
    } catch (error) {
      if (
        isRecord(error) &&
        (error.code === "frame_not_found" || error.code === "frame_unavailable" || error.code === "stale_ref")
      ) {
        return false;
      }
      throw error;
    }
  }

  private async inspectWaitTarget(
    tabId: number,
    target: ResolvedTarget,
  ): Promise<Record<string, unknown>> {
    const resolved = await this.send(
      tabId,
      "DOM.resolveNode",
      { backendNodeId: target.backendNodeId },
      false,
      target.sessionId,
    );
    const object = isRecord(resolved.object) ? resolved.object : null;
    if (typeof object?.objectId !== "string") {
      throw Object.assign(new Error("Wait selector no longer resolves"), { code: "stale_ref" });
    }
    const inspected = await this.send(
      tabId,
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration:
          "function(){const style=getComputedStyle(this);const box=this.getBoundingClientRect();const connected=this.isConnected===true;const visible=connected&&style.display!=='none'&&style.visibility!=='hidden'&&style.visibility!=='collapse'&&Number(style.opacity)!==0&&box.width>0&&box.height>0;const disabled=this.matches(':disabled')||this.getAttribute('aria-disabled')==='true';const raw=this.value;return {connected,visible,enabled:connected&&!disabled,value:typeof raw==='string'?raw:String(this.textContent??'')}}",
        returnByValue: true,
      },
      false,
      target.sessionId,
    );
    const result = isRecord(inspected.result) ? inspected.result : null;
    if (!isRecord(result?.value)) {
      throw Object.assign(new Error("Wait selector no longer resolves"), { code: "stale_ref" });
    }
    return result.value;
  }


  async resolveTarget(
    tabId: number,
    request: TargetResolutionRequest,
  ): Promise<ResolvedTarget> {
    const ref = request.ref;
    const selector = request.selector;
    const hasRef = ref !== undefined;
    const hasSelector = selector !== undefined;
    if (hasRef === hasSelector || (hasSelector && typeof selector !== "string")) {
      throw Object.assign(new Error("Target resolution requires exactly one of ref or selector"), {
        code: "invalid_request",
      });
    }
    if (typeof selector === "string") {
      const document = await this.frameDocument(tabId, request.frameId);
      const backendNodeId = await this.backendNodeIdForDocument(tabId, document, selector);
      return {
        tabId,
        backendNodeId,
        documentId: document.documentId,
        frameId: document.frameId,
        pageRevision: request.pageRevision,
        taskId: request.taskId ?? "",
        ...(document.sessionId !== undefined ? { sessionId: document.sessionId } : {}),
        ...(document.contextId !== undefined ? { contextId: document.contextId } : {}),
      };
    }
    const binding = parseTargetRef(request.ref);
    if (binding === null) {
      throw Object.assign(new Error("Snapshot ref is not task-bound"), { code: "stale_ref" });
    }
    if (
      binding.tabId !== tabId ||
      binding.pageRevision !== request.pageRevision ||
      binding.taskId !== request.taskId ||
      (request.frameId !== undefined && binding.frameId !== request.frameId)
    ) {
      throw Object.assign(new Error("Snapshot ref belongs to a different task, frame, or page revision"), {
        code: "stale_ref",
      });
    }
    const document = await this.frameDocument(tabId, binding.frameId);
    if (document.documentId !== binding.documentId) {
      throw Object.assign(new Error("Snapshot ref belongs to a stale frame document"), { code: "stale_ref" });
    }
    return {
      ...binding,
      ...(document.sessionId !== undefined ? { sessionId: document.sessionId } : {}),
      ...(document.contextId !== undefined ? { contextId: document.contextId } : {}),
    };
  }

  async backendNodeIdFromSelector(
    tabId: number,
    selector: string,
    _actionKind?: string,
    frameId?: string,
  ): Promise<number> {
    const document = await this.frameDocument(tabId, frameId);
    return this.backendNodeIdForDocument(tabId, document, selector);
  }

  private async backendNodeIdForDocument(
    tabId: number,
    document: FrameDocument,
    selector: string,
  ): Promise<number> {
    const openShadowMatch = await this.openShadowBackendNodeId(tabId, document, selector);
    if (openShadowMatch !== null) return openShadowMatch;
    const selected = await this.send(tabId, "DOM.querySelectorAll", {
      nodeId: document.rootNodeId,
      selector,
    }, false, document.sessionId);
    const nodeIds = Array.isArray(selected.nodeIds)
      ? selected.nodeIds.filter((nodeId): nodeId is number => typeof nodeId === "number" && nodeId !== 0)
      : typeof selected.nodeId === "number" && selected.nodeId !== 0
        ? [selected.nodeId]
        : [];
    if (nodeIds.length === 0) {
      throw Object.assign(new Error(`Selector did not match: ${selector}`), {
        code: "selector_not_found",
      });
    }
    if (nodeIds.length > 1) {
      throw Object.assign(new Error(`Selector matched ${nodeIds.length} elements: ${selector}`), {
        code: "ambiguous_selector",
      });
    }
    return this.backendNodeIdForNodeId(tabId, nodeIds[0], document);
  }

  private async openShadowBackendNodeId(
    tabId: number,
    document: FrameDocument,
    selector: string,
  ): Promise<number | null> {
    const evaluated = await this.send(tabId, "Runtime.evaluate", {
      expression: "document",
      returnByValue: false,
      ...(document.contextId !== undefined ? { contextId: document.contextId } : {}),
    }, false, document.sessionId);
    const evaluatedResult = isRecord(evaluated.result) ? evaluated.result : null;
    if (typeof evaluatedResult?.objectId !== "string") return null;
    const count = await this.send(tabId, "Runtime.callFunctionOn", {
      objectId: evaluatedResult.objectId,
      functionDeclaration: `function(selector){const matches=new Set();const visit=root=>{for(const element of root.querySelectorAll(selector))matches.add(element);for(const host of root.querySelectorAll("*"))if(host.shadowRoot)visit(host.shadowRoot)};visit(this);return matches.size}`,
      arguments: [{ value: selector }],
      returnByValue: true,
    }, false, document.sessionId);
    const counted = isRecord(count.result) ? count.result : null;
    if (typeof counted?.value !== "number") return null;
    if (counted.value === 0) {
      throw Object.assign(new Error(`Selector did not match: ${selector}`), {
        code: "selector_not_found",
      });
    }
    if (counted.value > 1) {
      throw Object.assign(new Error(`Selector matched ${counted.value} elements: ${selector}`), {
        code: "ambiguous_selector",
      });
    }
    const matched = await this.send(tabId, "Runtime.callFunctionOn", {
      objectId: evaluatedResult.objectId,
      functionDeclaration: `function(selector){const matches=[];const visit=root=>{for(const element of root.querySelectorAll(selector))matches.push(element);for(const host of root.querySelectorAll("*"))if(host.shadowRoot)visit(host.shadowRoot)};visit(this);return matches[0]}`,
      arguments: [{ value: selector }],
      returnByValue: false,
    }, false, document.sessionId);
    const matchedResult = isRecord(matched.result) ? matched.result : null;
    if (typeof matchedResult?.objectId !== "string") {
      throw Object.assign(new Error("Selected target could not be resolved"), { code: "action_failed" });
    }
    const requested = await this.send(tabId, "DOM.requestNode", { objectId: matchedResult.objectId }, false, document.sessionId);
    if (typeof requested.nodeId !== "number") {
      throw Object.assign(new Error("Selected target could not be resolved"), { code: "action_failed" });
    }
    return this.backendNodeIdForNodeId(tabId, requested.nodeId, document);
  }

  private async backendNodeIdForNodeId(
    tabId: number,
    nodeId: number,
    document: FrameDocument,
  ): Promise<number> {
    const described = await this.send(tabId, "DOM.describeNode", {
      nodeId,
      depth: 0,
    }, false, document.sessionId);
    const node = isRecord(described.node) ? described.node : null;
    if (typeof node?.backendNodeId !== "number") {
      throw Object.assign(new Error("Selected target could not be resolved"), { code: "action_failed" });
    }
    return node.backendNodeId;
  }

  async callOnNode(
    tabId: number,
    backendNodeId: number,
    functionDeclaration: string,
    args: Array<Record<string, unknown>>,
    userGesture = false,
    target?: ResolvedTarget,
  ): Promise<void> {
    try {
      const resolved = await this.send(tabId, "DOM.resolveNode", {
        backendNodeId,
        ...(target?.contextId !== undefined ? { executionContextId: target.contextId } : {}),
      }, false, target?.sessionId);
      if (!isRecord(resolved.object) || typeof resolved.object.objectId !== "string") {
        throw Object.assign(new Error("Snapshot ref no longer resolves"), { code: "stale_ref" });
      }
      const invoked = await this.send(tabId, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration,
        arguments: args,
        awaitPromise: true,
        returnByValue: true,
        userGesture,
      }, false, target?.sessionId);
      if (
        isRecord(invoked.result) &&
        isRecord(invoked.result.value) &&
        invoked.result.value.agenttab_sensitive_field === true
      ) {
        throw Object.assign(new Error("Sensitive fields require a human Your Turn handoff"), {
          code: "sensitive_field_requires_handoff",
          recovery: "Start browser_handoff for this tab and let the human enter the sensitive value.",
        });
      }
      if (
        isRecord(invoked.result) &&
        isRecord(invoked.result.value) &&
        typeof invoked.result.value.agenttab_invalid_request === "string"
      ) {
        throw Object.assign(new Error(invoked.result.value.agenttab_invalid_request), {
          code: "invalid_request",
        });
      }
      if (isRecord(invoked.exceptionDetails)) {
        const text =
          typeof invoked.exceptionDetails.text === "string"
            ? invoked.exceptionDetails.text
            : "Page action raised an exception";
        throw Object.assign(new Error(text), { code: "action_failed" });
      }
    } catch (error) {
      if (isRecord(error) && error.code === "stale_ref") throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/no node with given id|could not find node|cannot find context|execution context was destroyed/i.test(message)) {
        throw Object.assign(new Error("Snapshot ref no longer resolves"), { code: "stale_ref" });
      }
      throw error;
    }
  }
  private async adoptWindowOpenChild(
    parentTabId: number,
    openedUrl: string,
    pending: PendingWindowOpen,
  ): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const tabs = await chrome.tabs.query({});
      const candidates = tabs.filter((tab) =>
        Number.isInteger(tab.id) &&
        !pending.existingTabIds.has(tab.id as number) &&
        (tab.url === openedUrl || tab.pendingUrl === openedUrl),
      );
      if (candidates.length === 1) {
        const childTabId = candidates[0].id as number;
        await this.adoptOwnedChild(parentTabId, childTabId);
        const [currentActiveTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (
          currentActiveTab?.id === childTabId &&
          pending.activeTabId !== undefined &&
          pending.activeWindowId !== undefined
        ) {
          const original = await chrome.tabs.get(pending.activeTabId).catch(() => null);
          if (original?.windowId === pending.activeWindowId) {
            await chrome.tabs.update(pending.activeTabId, { active: true }).catch(() => undefined);
            await chrome.windows.update(pending.activeWindowId, { focused: true }).catch(() => undefined);
          }
        }
        return;
      }
      if (candidates.length > 1) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  private async pointerTargetPoint(
    tabId: number,
    target: ResolvedTarget,
    expectedPoint?: { x: number; y: number },
  ): Promise<{ x: number; y: number }> {
    const document = await this.frameDocument(tabId, target.frameId);
    if (document.documentId !== target.documentId) {
      throw Object.assign(new Error("Pointer target document changed"), { code: "stale_ref" });
    }
    const point = await this.nodeCenter(tabId, target.backendNodeId, target);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) ||
        expectedPoint && (point.x !== expectedPoint.x || point.y !== expectedPoint.y)) {
      throw Object.assign(new Error("Pointer target moved before the gesture completed"), { code: "action_failed" });
    }
    const hit = await this.send(tabId, "DOM.getNodeForLocation", {
      x: Math.round(point.x),
      y: Math.round(point.y),
      includeUserAgentShadowDOM: true,
    }, false, target.sessionId);
    if (typeof hit.backendNodeId !== "number") {
      throw Object.assign(new Error("Pointer target is outside the visible viewport"), { code: "action_failed" });
    }
    const [owner, hitNode] = await Promise.all([
      this.send(tabId, "DOM.resolveNode", {
        backendNodeId: target.backendNodeId,
        ...(target.contextId !== undefined ? { executionContextId: target.contextId } : {}),
      }, false, target.sessionId),
      this.send(tabId, "DOM.resolveNode", {
        backendNodeId: hit.backendNodeId,
        ...(target.contextId !== undefined ? { executionContextId: target.contextId } : {}),
      }, false, target.sessionId),
    ]);
    if (!isRecord(owner.object) || typeof owner.object.objectId !== "string" ||
        !isRecord(hitNode.object) || typeof hitNode.object.objectId !== "string") {
      throw Object.assign(new Error("Pointer target no longer resolves"), { code: "stale_ref" });
    }
    const checked = await this.send(tabId, "Runtime.callFunctionOn", {
      objectId: owner.object.objectId,
      functionDeclaration: "function(hit){if(!this.isConnected)return false;for(let node=hit;node;node=node.parentNode||(node.getRootNode&&node.getRootNode().host)){if(node===this)return true}return false}",
      arguments: [{ objectId: hitNode.object.objectId }],
      returnByValue: true,
    }, false, target.sessionId);
    if (!isRecord(checked.result) || checked.result.value !== true) {
      throw Object.assign(new Error("Another element obscures the reviewed pointer target"), { code: "action_failed" });
    }
    return point;
  }

  async nodeCenter(
    tabId: number,
    backendNodeId: number,
    target?: ResolvedTarget,
  ): Promise<{ x: number; y: number }> {
    const model = await this.send(tabId, "DOM.getBoxModel", { backendNodeId }, false, target?.sessionId);
    if (!model.model || typeof model.model !== "object" || !("content" in model.model) || !Array.isArray(model.model.content)) {
      throw Object.assign(new Error("Dragged ref has no box model"), { code: "stale_ref" });
    }
    const points = model.model.content.map(Number);
    return {
      x: (points[0] + points[2] + points[4] + points[6]) / 4,
      y: (points[1] + points[3] + points[5] + points[7]) / 4,
    };
  }

  private async pageIdentity(tabId: number, frameId?: string): Promise<PageIdentity> {
    const document = await this.frameDocument(tabId, frameId);
    return {
      documentId: document.documentId,
      ...(document.loaderId !== undefined ? { loaderId: document.loaderId } : {}),
    };
  }

  private async frameIdentities(
    tabId: number,
    requestedFrameId?: string,
  ): Promise<{ frame: FrameIdentity; root: FrameIdentity }> {
    const result = await this.send(tabId, "Page.getFrameTree", {});
    const rootTree = isRecord(result.frameTree) ? result.frameTree : null;
    const identity = (tree: unknown): FrameIdentity | null => {
      if (!isRecord(tree) || !isRecord(tree.frame)) return null;
      const rawFrame = tree.frame;
      return {
        frameId: typeof rawFrame.id === "string" ? rawFrame.id : "top",
        ...(typeof rawFrame.loaderId === "string" ? { loaderId: rawFrame.loaderId } : {}),
        ...(typeof rawFrame.url === "string" ? { url: rawFrame.url } : {}),
      };
    };
    const root = identity(rootTree);
    if (root === null) {
      throw Object.assign(new Error(`Frame is not reachable from this tab: ${String(requestedFrameId)}`), {
        code: "frame_not_found",
      });
    }
    if (requestedFrameId === undefined || requestedFrameId === root.frameId) {
      return { frame: root, root };
    }
    const pending: unknown[] = isRecord(rootTree) && Array.isArray(rootTree.childFrames)
      ? [...rootTree.childFrames]
      : [];
    pending.push(...await this.attachedFrameTrees(tabId));
    while (pending.length > 0) {
      const tree = pending.pop();
      const frame = identity(tree);
      if (frame === null) continue;
      if (frame.frameId === requestedFrameId) return { frame, root };
      if (isRecord(tree) && Array.isArray(tree.childFrames)) {
        pending.push(...tree.childFrames);
      }
    }
    throw Object.assign(new Error(`Frame is not reachable from this tab: ${String(requestedFrameId)}`), {
      code: "frame_not_found",
    });
  }

  private async attachedFrameTrees(tabId: number): Promise<unknown[]> {
    const trees: unknown[] = [];
    const session = this.sessions.get(tabId);
    if (!session) return trees;
    for (const sessionId of new Set(session.frameSessions.values())) {
      const result = await this.send(tabId, "Page.getFrameTree", {}, false, sessionId);
      if (isRecord(result.frameTree)) trees.push(result.frameTree);
    }
    return trees;
  }

  private async frameIdentity(tabId: number, requestedFrameId?: string): Promise<FrameIdentity> {
    return (await this.frameIdentities(tabId, requestedFrameId)).frame;
  }


  private async frameDocument(tabId: number, requestedFrameId?: string): Promise<FrameDocument> {
    const { frame, root } = await this.frameIdentities(tabId, requestedFrameId);
    const session = this.sessions.get(tabId);
    const sessionId = frame.frameId === root.frameId ? undefined : session?.frameSessions.get(frame.frameId);
    if (sessionId !== undefined || frame.frameId === root.frameId) {
      const document = await this.send(tabId, "DOM.getDocument", { depth: 0 }, false, sessionId);
      const rawRoot = isRecord(document.root) ? document.root : null;
      if (
        rawRoot === null ||
        typeof rawRoot.nodeId !== "number" ||
        typeof rawRoot.backendNodeId !== "number"
      ) {
        throw Object.assign(new Error("Could not inspect the requested frame document"), {
          code: "frame_unavailable",
        });
      }
      return {
        ...frame,
        rootNodeId: rawRoot.nodeId,
        documentId: `${frame.frameId}:${frame.loaderId ?? ""}:${rawRoot.backendNodeId}`,
        ...(sessionId !== undefined ? { sessionId } : {}),
      };
    }
    const contextId = session?.frameContexts.get(frame.frameId);
    if (contextId === undefined) {
      throw Object.assign(
        new Error("Frame-scoped control is unavailable because Chrome did not expose a debugger execution context"),
        { code: "frame_unavailable" },
      );
    }
    const evaluated = await this.send(tabId, "Runtime.evaluate", {
      expression: "document",
      contextId,
      returnByValue: false,
    });
    const object = isRecord(evaluated.result) ? evaluated.result : null;
    if (typeof object?.objectId !== "string") {
      throw Object.assign(new Error("Frame document execution context is no longer available"), {
        code: "stale_ref",
      });
    }
    const requested = await this.send(tabId, "DOM.requestNode", { objectId: object.objectId });
    if (typeof requested.nodeId !== "number") {
      throw Object.assign(new Error("Could not inspect the requested frame document"), {
        code: "frame_unavailable",
      });
    }
    const described = await this.send(tabId, "DOM.describeNode", { nodeId: requested.nodeId, depth: 0 });
    const node = isRecord(described.node) ? described.node : null;
    if (typeof node?.backendNodeId !== "number") {
      throw Object.assign(new Error("Could not inspect the requested frame document"), {
        code: "frame_unavailable",
      });
    }
    return {
      ...frame,
      rootNodeId: requested.nodeId,
      documentId: `${frame.frameId}:${frame.loaderId ?? ""}:${node.backendNodeId}`,
      contextId,
    };
  }

  private async initializeChildFrameSession(tabId: number, sessionId: string): Promise<void> {
    for (const method of ["Page.enable", "DOM.enable", "Accessibility.enable", "Runtime.enable"]) {
      await this.send(tabId, method, {}, false, sessionId);
    }
    await this.send(tabId, "Target.setAutoAttach", {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    }, false, sessionId);
  }

  private async ensureAttached(tabId: number): Promise<void> {
    await this.authorizeDebuggerUse(tabId);
    let session = this.sessions.get(tabId);
    if (session?.detachPromise) {
      await session.detachPromise;
      session = this.sessions.get(tabId);
    }
    if (!session) {
      session = {
        attached: false,
        busyCount: 0,
        inflight: new Set(),
        lastNetworkActivity: Date.now(),
        pageLoadInFlight: false,
        downloads: new Map(),
        dialogGeneration: 0,
        frameContexts: new Map(),
        frameSessions: new Map(),
      };
      this.sessions.set(tabId, session);
    }
    if (session.attachPromise) {
      await session.attachPromise;
      await this.authorizeDebuggerUse(tabId);
      return;
    }
    if (session.attached) {
      await this.authorizeDebuggerUse(tabId);
      return;
    }

    const attaching = (async () => {
      await this.authorizeDebuggerUse(tabId);
      this.debuggerCandidates.add(tabId);
      await this.recordDebuggerCandidate(tabId);
      await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
      session.attached = true;
      try {
        for (const method of [
          "Page.enable",
          "DOM.enable",
          "Accessibility.enable",
          "Runtime.enable",
          "Network.enable",
        ]) {
          await this.authorizeDebuggerUse(tabId);
          await chrome.debugger.sendCommand({ tabId }, method, {});
          if (method === "Network.enable") {
            session.pageLoadInFlight = (await chrome.tabs.get(tabId)).status === "loading";
            session.lastNetworkActivity = Date.now();
          }
        }
        await this.authorizeDebuggerUse(tabId);
        await chrome.debugger.sendCommand(
          { tabId },
          "Target.setAutoAttach",
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        );
        // Run animation-frame-driven widgets in background tabs without activating Chrome.
        // Chrome clears this target-scoped override when the debugger detaches.
        await this.authorizeDebuggerUse(tabId);
        await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
      } catch (error) {
        try {
          await this.detachTrackedSession(tabId, session);
        } catch (detachError) {
          throw new AggregateError(
            [error, detachError],
            "Debugger initialization and cleanup both failed",
          );
        }
        throw error;
      }
    })();
    session.attachPromise = attaching;
    try {
      await attaching;
    } finally {
      if (this.sessions.get(tabId) === session) session.attachPromise = undefined;
    }
  }

  private async acquireDebuggerBusyLease(tabId: number, activeSession?: DebugSession): Promise<DebugSession> {
    await this.ensureAttached(tabId);
    const session = this.sessions.get(tabId);
    if (!session?.attached) {
      throw Object.assign(new Error("Debugger detached before the command could run"), {
        code: "debugger_detached",
      });
    }
    if (session === activeSession) return session;
    if (activeSession) this.releaseDebuggerBusyLease(tabId, activeSession);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
    session.busyCount += 1;
    return session;
  }

  private releaseDebuggerBusyLease(tabId: number, session: DebugSession): void {
    session.busyCount -= 1;
    if (this.sessions.get(tabId) === session && session.busyCount === 0) {
      this.scheduleIdleDetach(tabId, session);
    }
  }

  private scheduleIdleDetach(tabId: number, session: DebugSession): void {
    if (session.busyCount > 0) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (session.busyCount > 0) return;
      void this.detach(tabId).catch(() => {
        if (this.sessions.get(tabId) === session) this.scheduleIdleDetach(tabId, session);
      });
    }, DEBUGGER_IDLE_MS);
  }

  private async send(
    tabId: number,
    method: string,
    params: Record<string, unknown>,
    recovered = false,
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const session = await this.acquireDebuggerBusyLease(tabId);
    let detached = false;
    try {
      await this.authorizeDebuggerUse(tabId);
      const target: chrome.debugger.DebuggerSession = sessionId === undefined ? { tabId } : { tabId, sessionId };
      const result: unknown = await chrome.debugger.sendCommand(target, method, params);
      return isRecord(result) ? result : {};
    } catch (error) {
      if (
        recovered ||
        !(error instanceof Error && /debugger is not attached to the tab/i.test(error.message))
      ) {
        throw error;
      }
      detached = true;
      this.invalidateDetachedSession(tabId, session);
    } finally {
      this.releaseDebuggerBusyLease(tabId, session);
    }
    if (detached) return this.send(tabId, method, params, true, sessionId);
    throw new Error("unreachable debugger recovery state");
  }
}

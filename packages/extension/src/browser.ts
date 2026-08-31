import { RevisionTracker } from "./revisions";
import { automationRoute, restrictedOriginError } from "./routes";
import { isRecord } from "./type-guards";
import {
  SCREENSHOT_MAX_BYTES,
  SNAPSHOT_TEXT_MAX_BYTES,
  randomToken,
  sha256Hex,
  type StagedCommit,
  type StagedDialog,
} from "./protocol";
import { mutateState, readState } from "./storage";

const DEBUGGER_VERSION = "1.3";
const DEBUGGER_IDLE_MS = 30_000;
// Leaves more than 16 KiB for the Core response envelope and task binding inside
// the 1 MiB host-to-client frame. Screenshot base64 data is separately capped at
// 1,000,000 characters (750,000 decoded bytes).
const SNAPSHOT_RESULT_BUDGET_BYTES = 1_032_000;
const WAIT_REVALIDATE_MS = 500;
const NETWORK_IDLE_MS = 500;
const DOM_OBSERVER_SCAN_INTERVAL_MS = 50;
const SEMANTIC_REF_MAX_CHARS = 256;
const SEMANTIC_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);
const LAZY_DEBUGGER_DOMAINS = new Set(["DOM", "Accessibility", "Runtime"]);
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
  network_idle: true,
  download: true,
};
const SENSITIVE_FIELD_CHECK = "const type=String(this.getAttribute&&this.getAttribute('type')||'').toLowerCase();const autocomplete=String(this.getAttribute&&this.getAttribute('autocomplete')||'').toLowerCase().split(/\\s+/);const text=node=>String(node&&((node.innerText??node.textContent)??'')||'').trim();const ids=String(this.getAttribute&&this.getAttribute('aria-labelledby')||'')+' '+String(this.getAttribute&&this.getAttribute('aria-describedby')||'');const associated=(this.labels?Array.from(this.labels):[]).map(text).filter(Boolean);const root=this.ownerDocument||document;const accessible=[this.getAttribute&&this.getAttribute('aria-label'),...ids.trim().split(/\\s+/).filter(Boolean).map(id=>text(root.getElementById(id)))].filter(value=>typeof value==='string'&&value.trim());const role=String(this.getAttribute&&this.getAttribute('role')||'').toLowerCase();const rawDescriptor=[this.getAttribute&&this.getAttribute('name'),this.id,this.getAttribute&&this.getAttribute('aria-label'),this.getAttribute&&this.getAttribute('title'),this.getAttribute&&this.getAttribute('placeholder'),...associated,...accessible].filter(Boolean).join(' ');const descriptor=rawDescriptor.replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();const compactDescriptor=descriptor.replace(/\\s+/g,'');const tag=String(this.tagName||'').toUpperCase();const editable=tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||this.isContentEditable===true||role==='textbox'||role==='combobox'||role==='spinbutton';const namedSecret=/\\b(password|otp|totp|mfa(?: code|token)?|2fa(?: code)?|(?:two|multi) factor (?:authentication )?(?:code|token)|one time (?:code|password)|verification code|authentication code|auth code|(?:re ?|h ?)?captcha|(?:cvv|cvc|cvn)\\d*|cid|security code|card security code|card verification (?:value|code|number)|card number|credit card number|cc number|card (?:expiration|expiry) (?:date|month|year)|bank account number|routing number|iban)\\b/.test(descriptor)||['password','onetimecode','onetimepassword','verificationcode','authenticationcode','authcode','totp','2fa','2facode','twofactorcode','twofactortoken','twofactorauthenticationcode','multifactorcode','multifactortoken','multifactorauthenticationcode','captcha','cid','securitycode','cardverificationvalue','cardverificationcode','cardverificationnumber','cardnumber','creditcardnumber','ccnumber','cardsecuritycode','cardexpirationdate','cardexpirationmonth','cardexpirationyear','cardexpirydate','cardexpirymonth','cardexpiryyear','bankaccountnumber','routingnumber'].some(term=>compactDescriptor.includes(term));const tokenSecret=/\\b(pin|passcode)\\b/.test(descriptor);const sensitiveField=type==='password'||autocomplete.some(token=>token==='current-password'||token==='new-password'||token==='one-time-code'||token==='webauthn'||token.startsWith('cc-'))||(editable&&(namedSecret||tokenSecret));";

interface JavaScriptDialog {
  generation: number;
  fingerprint: Promise<string>;
}

interface PendingWindowOpen {
  existingTabIds: Set<number>;
  activeTabId?: number;
  activeWindowId?: number;
  expiresAt: number;
}

interface TrackedDownload {
  startedAt: number;
  completedAt?: number;
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
  enabledDomains: Set<string>;
  domainEnableTail: Promise<void>;
  dialog?: JavaScriptDialog;
  pendingWindowOpen?: PendingWindowOpen;
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

function base64ByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

interface SemanticTarget {
  pageRevision: number;
  role: string;
  name: string;
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
  private readonly expectedDetaches = new Map<number, number>();
  private readonly debuggerCandidates = new Set<number>();
  private readonly waitSignals = new Map<number, Set<() => void>>();

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
      const expected = this.expectedDetaches.get(source.tabId) ?? 0;
      if (expected > 0) {
        if (expected === 1) this.expectedDetaches.delete(source.tabId);
        else this.expectedDetaches.set(source.tabId, expected - 1);
        return;
      }
      const session = this.sessions.get(source.tabId);
      if (session?.idleTimer) clearTimeout(session.idleTimer);
      this.sessions.delete(source.tabId);
      this.signalWaiters(source.tabId);
      void this.invalidateStagedDialogs(source.tabId);
    });
    chrome.debugger.onEvent.addListener(
      (source, method: string, rawParams?: object) => {
        if (source.tabId === undefined) return;
        const session = this.sessions.get(source.tabId);
        if (!session) return;
        const params = isRecord(rawParams) ? rawParams : {};
        let shouldSignalWaiters = false;
        if (method === "Network.requestWillBeSent" && typeof params.requestId === "string") {
          session.inflight.add(params.requestId);
          session.lastNetworkActivity = Date.now();
        } else if (
          (method === "Network.loadingFinished" || method === "Network.loadingFailed") &&
          typeof params.requestId === "string"
        ) {
          session.inflight.delete(params.requestId);
          session.lastNetworkActivity = Date.now();
          // A network-idle waiter cannot match while any request remains. Wake
          // it only when the burst drains instead of revalidating on every
          // resource completion.
          shouldSignalWaiters = session.inflight.size === 0;
          // chrome.downloads has no initiator tab. Debugger events are scoped by source.tabId,
          // so a matching Page GUID is the only completion proof accepted here.
        } else if (method === "Page.downloadWillBegin" && typeof params.guid === "string") {
          session.downloads.set(params.guid, { startedAt: Date.now() });
        } else if (method === "Page.downloadProgress" && typeof params.guid === "string") {
          const download = session.downloads.get(params.guid);
          if (params.state === "completed" && download) {
            download.completedAt = Date.now();
            shouldSignalWaiters = true;
          } else if (params.state === "canceled") {
            session.downloads.delete(params.guid);
          }
        } else if (method === "Page.javascriptDialogOpening") {
          session.dialogGeneration += 1;
          session.dialog = {
            generation: session.dialogGeneration,
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
        if (shouldSignalWaiters) this.signalWaiters(source.tabId);
      },
    );
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (
        changeInfo.status === "loading" ||
        changeInfo.status === "complete" ||
        typeof changeInfo.url === "string"
      ) {
        this.signalWaiters(tabId);
      }
    });
    this.revisions.onChange((tabId) => this.invalidateStagedDialogs(tabId));
  }

  debuggerTabIds(): number[] {
    return [...this.debuggerCandidates];
  }

  tracksTab(tabId: number): boolean {
    return this.sessions.has(tabId) || this.debuggerCandidates.has(tabId);
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
      await this.invalidateStagedDialogs(tabId);
      await this.forgetTrackedDebuggerCandidate(tabId);
      return;
    }
    const expected = this.expectedDetaches.get(tabId) ?? 0;
    this.expectedDetaches.set(tabId, expected + 1);
    try {
      await chrome.debugger.detach({ tabId });
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

  private consumeExpectedDetach(tabId: number): void {
    const pendingExpected = this.expectedDetaches.get(tabId) ?? 0;
    if (pendingExpected <= 1) this.expectedDetaches.delete(tabId);
    else this.expectedDetaches.set(tabId, pendingExpected - 1);
  }

  private async requireFullAutomationRoute(tabId: number, operation: string): Promise<void> {
    const tab = await chrome.tabs.get(tabId);
    if (automationRoute(tab.pendingUrl ?? tab.url) !== "full") {
      throw restrictedOriginError(operation);
    }
  }

  async snapshot(tabId: number, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.authorizeDebuggerUse(tabId);
    const mode = params.mode;
    if (mode !== "text" && mode !== "html" && mode !== "screenshot" && mode !== "accessibility") {
      throw Object.assign(new Error("Unsupported snapshot mode"), { code: "invalid_request" });
    }
    await this.requireFullAutomationRoute(tabId, `capture a ${mode} snapshot`);
    if (mode === "text" || mode === "html") {
      return assertDeliverableSnapshot(await this.scriptSnapshot(tabId, mode, params));
    }
    if (mode === "screenshot") {
      return assertDeliverableSnapshot(await this.screenshot(tabId, params));
    }
    const maxNodes = typeof params.max_nodes === "number" ? params.max_nodes : 1000;
    const maxDepth = typeof params.max_depth === "number" ? params.max_depth : 50;
    const before = await this.pageIdentity(tabId);
    const pageRevision = await this.revisions.observeDocument(
      tabId,
      before.documentId,
      before.loaderId,
    );
    const result = typeof params.root_ref === "string"
      ? await this.send(tabId, "Accessibility.getPartialAXTree", {
        backendNodeId: await this.resolveBackendNodeId(tabId, pageRevision, params.root_ref),
        fetchRelatives: true,
      })
      : await this.send(tabId, "Accessibility.getFullAXTree", { depth: maxDepth });
    const after = await this.pageIdentity(tabId);
    if (before.documentId !== after.documentId || before.loaderId !== after.loaderId) {
      const currentPageRevision = await this.revisions.observeDocument(
        tabId,
        after.documentId,
        after.loaderId,
      );
      throw Object.assign(new Error("Page changed while capturing the accessibility tree"), {
        code: "stale_revision",
        currentPageRevision,
      });
    }
    const nodes = (Array.isArray(result.nodes) ? result.nodes.filter(isRecord) : []) as AxNode[];
    const semanticCounts = new Map<string, number>();
    for (const node of nodes) {
      const role = this.axText(node.role?.value);
      const name = this.axText(node.name?.value);
      if (!node.ignored && node.backendDOMNodeId && SEMANTIC_ROLES.has(role) && name.length > 0) {
        const key = this.semanticKey(role, name);
        semanticCounts.set(key, (semanticCounts.get(key) ?? 0) + 1);
      }
    }
    const encoded = nodes.slice(0, maxNodes).map((node) => {
      const role = this.axText(node.role?.value) || "unknown";
      const name = this.axText(node.name?.value);
      const nodeRef = node.backendDOMNodeId
        ? `r${pageRevision}-${node.backendDOMNodeId}`
        : undefined;
      const semanticRef =
        !node.ignored &&
        nodeRef !== undefined &&
        SEMANTIC_ROLES.has(role) &&
        name.length > 0 &&
        semanticCounts.get(this.semanticKey(role, name)) === 1
          ? this.encodeSemanticRef(pageRevision, role, name)
          : undefined;
      return {
        ...(nodeRef !== undefined ? { ref: nodeRef } : {}),
        ...(semanticRef !== undefined ? { semantic_ref: semanticRef } : {}),
        role,
        name,
        ...(node.value?.value !== undefined ? { value: node.value.value } : {}),
        ...(node.description?.value !== undefined ? { description: node.description.value } : {}),
        ...(node.ignored ? { ignored: true } : {}),
      };
    });
    return assertDeliverableSnapshot({
      tab_id: tabId,
      page_revision: pageRevision,
      mode,
      nodes: encoded,
      truncated: nodes.length > maxNodes,
    });
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
      const resolvedTargets = new Map<string, number>();
      const stagedConsequence = await this.consequence(
        tabId,
        pageRevision,
        action,
        resolvedTargets,
      );
      if (stagedConsequence) {
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
      completedActions.push(await this.performAction(
        tabId,
        pageRevision,
        action,
        resolvedTargets,
      ));
    }
    return {
      result: {
        tab_id: tabId,
        page_revision: await this.revisions.current(tabId),
        actions: completedActions,
      },
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
    const resolvedTargets = new Map<string, number>();
    const currentTarget = typeof action.ref === "string"
      ? await this.targetDescriptor(
        staged.tab_id,
        staged.page_revision,
        action.ref,
        action,
        resolvedTargets,
      )
      : { kind: action.kind };
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
      : await this.performAction(
        staged.tab_id,
        staged.page_revision,
        action,
        resolvedTargets,
      );
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
    let debuggerSession =
      conditionKind === "network_idle" || conditionKind === "download"
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
        const matched = await this.conditionMatched(tabId, condition, waitStartedAtMs, debuggerSession);
        if (revalidate) await revalidate();
        if (matched) {
          return {
            tab_id: tabId,
            page_revision: await this.revisions.current(tabId),
            condition: conditionKind,
            matched: true,
          };
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        if (conditionKind === "text" || conditionKind === "selector") {
          const observerStartedAt = Date.now();
          const observerSliceMs = Math.min(remainingMs, WAIT_REVALIDATE_MS);
          const observed = await this.waitForDomCondition(
            tabId,
            condition,
            observerSliceMs,
          );
          if (observed) continue;
          const unusedSliceMs = observerSliceMs - (Date.now() - observerStartedAt);
          const observerRemainingMs = deadline - Date.now();
          if (unusedSliceMs > 0 && observerRemainingMs > 0) {
            await this.waitForTabSignal(
              tabId,
              Math.min(unusedSliceMs, observerRemainingMs),
            );
          }
          continue;
        }
        await this.waitForTabSignal(
          tabId,
          Math.min(
            remainingMs,
            this.nextWaitDelay(conditionKind, debuggerSession, waitStartedAtMs),
          ),
        );
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
    const result = await this.send(tabId, action, params);
    if (action.endsWith(".disable")) {
      // Developer mode can invalidate the Standard runtime's domain cache.
      // Recycle the attachment so the next Standard call re-establishes a
      // known Page, Network, and lazy-domain baseline.
      await this.detach(tabId);
    }
    return result;
  }

  private async scriptSnapshot(
    tabId: number,
    mode: "text" | "html",
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.authorizeDebuggerUse(tabId);
    const selector = typeof params.selector === "string" ? params.selector : null;
    const requestedMaxBytes = typeof params.max_bytes === "number"
      ? Math.min(params.max_bytes, SNAPSHOT_TEXT_MAX_BYTES)
      : 256_000;
    const before = await this.pageIdentity(tabId);
    const pageRevision = await this.revisions.observeDocument(tabId, before.documentId, before.loaderId);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (snapshotMode: "text" | "html", targetSelector: string | null) => {
        const target = targetSelector ? document.querySelector(targetSelector) : document.documentElement;
        if (!target) throw new Error(`Selector did not match: ${targetSelector}`);
        return snapshotMode === "text" ? target.textContent ?? "" : target.outerHTML;
      },
      args: [mode, selector],
    });
    const after = await this.pageIdentity(tabId);
    const currentPageRevision = await this.revisions.observeDocument(tabId, after.documentId, after.loaderId);
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
    pageRevision: number,
    action: Record<string, unknown>,
    resolvedTargets: Map<string, number>,
  ): Promise<StagedConsequence | null> {
    if (action.kind === "close") {
      return {
        effect: "Close an AgentTab-owned browser tab",
        target: { kind: action.kind },
      };
    }
    if (action.kind === "upload_file") {
      const count = Array.isArray(action.files) ? action.files.length : 0;
      return {
        effect: `Upload ${count} ${count === 1 ? "file" : "files"} to the page`,
        target: typeof action.ref === "string"
          ? await this.targetDescriptor(tabId, pageRevision, action.ref, undefined, resolvedTargets)
          : { kind: action.kind },
      };
    }
    if (action.kind === "dialog" && action.decision === "accept") {
      return {
        effect: "Accept a browser confirmation dialog",
        target: { kind: action.kind },
        dialog: await this.stageDialog(tabId),
      };
    }
    if (
      action.kind !== "click" &&
      action.kind !== "select" &&
      action.kind !== "fill" &&
      action.kind !== "type"
    ) {
      return null;
    }
    const target = await this.targetDescriptor(
      tabId,
      pageRevision,
      action.ref,
      action,
      resolvedTargets,
    );
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
      // Classify the page-owned control semantics, never caller-entered text or values.
      // The selected option label is resolved from the page and can describe an
      // immediately consequential selection even when its submitted value is opaque.
      target.requested_option_label,
    ].filter((value): value is string => typeof value === "string").join(" ").replace(/\s+/g, " ").trim();
    if (
      /\b(buy|purchase|pay|send|transfer|delete|remove|publish|post|deploy|merge|approve|authorize|grant|revoke|unsubscribe|cancel subscription|place order|checkout|submit order|confirm order|permission)\b/i.test(
        label,
      )
    ) {
      return {
        effect: `${action.kind === "click" ? "Activate" : "Change"} consequential control: ${label.slice(0, 160)}`,
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

  private async stageDialog(tabId: number): Promise<PreparedDialog> {
    await this.ensureAttached(tabId);
    const dialog = this.sessions.get(tabId)?.dialog;
    if (!dialog) {
      throw Object.assign(new Error("Accepting a dialog requires an open JavaScript dialog"), {
        code: "invalid_request",
      });
    }
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
    await this.send(tabId, "Page.handleJavaScriptDialog", { accept: true });
    return { kind: "dialog", completed: true };
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

  private async targetDescriptor(
    tabId: number,
    pageRevision: number,
    ref: unknown,
    action?: Record<string, unknown>,
    resolvedTargets?: Map<string, number>,
  ): Promise<Record<string, unknown>> {
    const requestedValue = action?.kind === "select"
      ? String(action.value ?? "")
      : action?.kind === "fill" || action?.kind === "type"
        ? String(action.text ?? "")
        : null;
    const backendNodeId = await this.resolveBackendNodeId(
      tabId,
      pageRevision,
      ref,
      resolvedTargets,
    );
    const resolved = await this.send(tabId, "DOM.resolveNode", { backendNodeId });
    if (!isRecord(resolved.object) || typeof resolved.object.objectId !== "string") {
      throw Object.assign(new Error("Snapshot ref no longer resolves"), { code: "stale_ref" });
    }
    const described = await this.send(tabId, "Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration:
        `function(requestedValue){${SENSITIVE_FIELD_CHECK}if(requestedValue!==null&&sensitiveField){return {agenttab_sensitive_field:true}}const f=this.form;const option=this.options&&requestedValue!==null?Array.from(this.options).find(candidate=>String(candidate.value)===requestedValue):null;return {tag:this.tagName,role:this.getAttribute('role'),text:[this.innerText,this.textContent].filter(Boolean).join(' '),aria_label:this.getAttribute('aria-label'),title:this.getAttribute('title'),name:this.getAttribute('name'),id:this.id,type:this.getAttribute('type'),autocomplete:this.getAttribute('autocomplete'),href:this.getAttribute('href'),form_action:f&&f.action,form_method:f&&f.method,form_enctype:f&&f.enctype,associated_labels:associated,accessible_labels:accessible,requested_value:requestedValue,requested_option_label:option?String(option.label||option.textContent||'').trim():null}}`,
      arguments: [{ value: requestedValue }],
      returnByValue: true,
    });
    if (!isRecord(described.result) || !isRecord(described.result.value)) {
      throw Object.assign(new Error("Snapshot ref no longer resolves"), { code: "stale_ref" });
    }
    if (described.result.value.agenttab_sensitive_field === true) {
      throw Object.assign(new Error("Sensitive fields require a human Your Turn handoff"), {
        code: "sensitive_field_requires_handoff",
        recovery: "Start browser_handoff for this tab and let the human enter the sensitive value.",
      });
    }
    return described.result.value;
  }

  private async performAction(
    tabId: number,
    pageRevision: number,
    action: Record<string, unknown>,
    resolvedTargets: Map<string, number> = new Map(),
  ): Promise<Record<string, unknown>> {
    await this.authorizeDebuggerUse(tabId);
    const kind = action.kind;
    if (kind === "navigate") {
      if (typeof action.url !== "string") throw Object.assign(new Error("navigate requires url"), { code: "invalid_request" });
      await chrome.tabs.update(tabId, { url: action.url });
      return { kind, started: true };
    }
    if (kind === "go_back") {
      await chrome.tabs.goBack(tabId);
      return { kind, started: true };
    }
    if (kind === "go_forward") {
      await chrome.tabs.goForward(tabId);
      return { kind, started: true };
    }
    if (kind === "reload") {
      await chrome.tabs.reload(tabId, { bypassCache: action.bypass_cache === true });
      return { kind, started: true };
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
    if (kind === "scroll" && action.ref === undefined) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (deltaX: number, deltaY: number) => window.scrollBy(deltaX, deltaY),
        args: [Number(action.delta_x ?? 0), Number(action.delta_y ?? 0)],
      });
      return { kind, completed: true };
    }
    const backendNodeId = await this.resolveBackendNodeId(
      tabId,
      pageRevision,
      action.ref,
      resolvedTargets,
    );
    if (kind === "click") {
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
        await this.callOnNode(tabId, backendNodeId, "function(){this.click()}", [], true);
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
        `function(value){${SENSITIVE_FIELD_CHECK}if(sensitiveField){return {agenttab_sensitive_field:true}}this.focus();if(this.isContentEditable){const doc=this.ownerDocument;const selection=doc.getSelection();let range=selection&&selection.rangeCount>0?selection.getRangeAt(0):null;if(!range||!this.contains(range.commonAncestorContainer)){range=doc.createRange();range.selectNodeContents(this);range.collapse(false)}range.deleteContents();const node=doc.createTextNode(value);range.insertNode(node);range.setStartAfter(node);range.collapse(true);if(selection){selection.removeAllRanges();selection.addRange(range)}}else{const prototype=this instanceof HTMLInputElement?HTMLInputElement.prototype:this instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:null;const descriptor=prototype&&Object.getOwnPropertyDescriptor(prototype,'value');const getter=descriptor&&descriptor.get;const setter=descriptor&&descriptor.set;const current=String(typeof getter==='function'?getter.call(this):(this.value||''));const start=Number.isInteger(this.selectionStart)?this.selectionStart:current.length;const end=Number.isInteger(this.selectionEnd)?this.selectionEnd:start;const next=current.slice(0,start)+value+current.slice(end);if(typeof setter==='function'){setter.call(this,next)}else{this.value=next}if(typeof this.setSelectionRange==='function'){const position=start+value.length;this.setSelectionRange(position,position)}}this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}))}`,
        [{ value: String(action.text ?? "") }],
      );
    } else if (kind === "fill") {
      await this.callOnNode(
        tabId,
        backendNodeId,
        `function(value){${SENSITIVE_FIELD_CHECK}if(sensitiveField){return {agenttab_sensitive_field:true}}this.focus();if(this.isContentEditable){this.textContent=value}else{const prototype=this instanceof HTMLInputElement?HTMLInputElement.prototype:this instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:null;const setter=prototype&&Object.getOwnPropertyDescriptor(prototype,'value')?.set;if(typeof setter==='function'){setter.call(this,value)}else{this.value=value}}this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));this.dispatchEvent(new Event('change',{bubbles:true}))}`,
        [{ value: String(action.text ?? "") }],
      );
    } else if (kind === "select") {
      await this.callOnNode(
        tabId,
        backendNodeId,
        `function(value){${SENSITIVE_FIELD_CHECK}if(sensitiveField){return {agenttab_sensitive_field:true}}this.value=value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}))}`,
        [{ value: String(action.value ?? "") }],
      );
    } else if (kind === "scroll") {
      await this.callOnNode(
        tabId,
        backendNodeId,
        "function(x,y){this.scrollBy(x,y)}",
        [{ value: Number(action.delta_x ?? 0) }, { value: Number(action.delta_y ?? 0) }],
      );
    } else if (kind === "drag") {
      const targetBackendNodeId = await this.resolveBackendNodeId(
        tabId,
        pageRevision,
        action.target_ref,
        resolvedTargets,
      );
      const [source, target] = await Promise.all([
        this.nodeCenter(tabId, backendNodeId),
        this.nodeCenter(tabId, targetBackendNodeId),
      ]);
      await this.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: source.x, y: source.y, button: "left", clickCount: 1 });
      await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y, button: "left" });
      await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
    } else if (kind === "upload_file") {
      if (!Array.isArray(action.files) || !action.files.every((file) => typeof file === "string")) {
        throw Object.assign(new Error("upload_file requires file paths"), { code: "invalid_request" });
      }
      await this.send(tabId, "DOM.setFileInputFiles", { files: action.files, backendNodeId });
    } else {
      throw Object.assign(new Error(`Unsupported standard action: ${String(kind)}`), {
        code: "invalid_request",
      });
    }
    return { kind, completed: true };
  }

  private async conditionMatched(
    tabId: number,
    condition: Record<string, unknown>,
    waitStartedAtMs: number,
    debuggerSession?: DebugSession,
  ): Promise<boolean> {
    const kind = condition.kind;
    if (kind === "load") return (await chrome.tabs.get(tabId)).status === "complete";
    if (kind === "url") return (await chrome.tabs.get(tabId)).url === condition.value;
    if (kind === "text" || kind === "selector") {
      const before = await this.pageIdentity(tabId);
      const matchedRevision = await this.revisions.observeDocument(
        tabId,
        before.documentId,
        before.loaderId,
      );
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (conditionKind: string, value: string) =>
          conditionKind === "text"
            ? (document.documentElement.textContent ?? "").includes(value)
            : document.querySelector(value) !== null,
        args: [kind, String(condition.value ?? "")],
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
    if (kind === "network_idle") {
      const session = debuggerSession;
      if (!session || this.sessions.get(tabId) !== session || !session.attached) return false;
      if (session.pageLoadInFlight) {
        if ((await chrome.tabs.get(tabId)).status === "loading") return false;
        session.pageLoadInFlight = false;
        session.lastNetworkActivity = Date.now();
      }
      const quietSince = Math.max(session.lastNetworkActivity, waitStartedAtMs);
      return session.inflight.size === 0 && Date.now() - quietSince >= NETWORK_IDLE_MS;
    }
    if (kind === "download") {
      const session = debuggerSession;
      if (!session || this.sessions.get(tabId) !== session || !session.attached) return false;
      for (const [guid, download] of session.downloads) {
        if (download.completedAt === undefined) continue;
        session.downloads.delete(guid);
        if (download.completedAt >= waitStartedAtMs) return true;
      }
      return false;
    }
    throw Object.assign(new Error(`Unsupported wait condition: ${String(kind)}`), {
      code: "invalid_request",
    });
  }

  private async waitForDomCondition(
    tabId: number,
    condition: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<boolean> {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (kind: string, value: string, timeout: number, scanInterval: number) =>
          new Promise<boolean>((resolve) => {
            const matches = () =>
              kind === "text"
                ? (document.documentElement.textContent ?? "").includes(value)
                : document.querySelector(value) !== null;
            if (matches()) {
              resolve(true);
              return;
            }
            let settled = false;
            let scanTimer: ReturnType<typeof setTimeout> | undefined;
            const finish = (matched: boolean) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (scanTimer !== undefined) clearTimeout(scanTimer);
              observer.disconnect();
              removeEventListener("pagehide", pageHidden);
              resolve(matched);
            };
            const observer = new MutationObserver(() => {
              // A dynamic page may deliver mutations at animation-frame rate.
              // Coalesce them so a wait never rescans the whole DOM at that rate.
              if (settled || scanTimer !== undefined) return;
              scanTimer = setTimeout(() => {
                scanTimer = undefined;
                if (matches()) finish(true);
              }, scanInterval);
            });
            const pageHidden = () => finish(false);
            const timer = setTimeout(() => finish(false), timeout);
            observer.observe(document.documentElement, {
              // Attribute changes can affect a CSS selector, but cannot change
              // the textContent tested by a text wait.
              attributes: kind === "selector",
              childList: true,
              characterData: kind === "text",
              subtree: true,
            });
            addEventListener("pagehide", pageHidden, { once: true });
            // Close the check/observe race without falling back to a poll.
            if (matches()) finish(true);
          }),
        args: [
          String(condition.kind),
          String(condition.value ?? ""),
          timeoutMs,
          DOM_OBSERVER_SCAN_INTERVAL_MS,
        ],
      });
      return result === true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/execution context was destroyed|frame was removed|cannot access contents of url/i.test(message)) {
        return false;
      }
      throw error;
    }
  }

  private nextWaitDelay(
    conditionKind: string,
    session?: DebugSession,
    waitStartedAtMs = 0,
  ): number {
    if (
      conditionKind === "network_idle" &&
      session &&
      !session.pageLoadInFlight &&
      session.inflight.size === 0
    ) {
      return Math.max(
        1,
        Math.min(
          WAIT_REVALIDATE_MS,
          NETWORK_IDLE_MS - (Date.now() - Math.max(session.lastNetworkActivity, waitStartedAtMs)),
        ),
      );
    }
    return WAIT_REVALIDATE_MS;
  }

  private waitForTabSignal(tabId: number, timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.waitSignals.get(tabId) ?? new Set<() => void>();
      this.waitSignals.set(tabId, waiters);
      let timer: ReturnType<typeof setTimeout>;
      const wake = () => {
        clearTimeout(timer);
        waiters.delete(wake);
        if (waiters.size === 0) this.waitSignals.delete(tabId);
        resolve();
      };
      waiters.add(wake);
      timer = setTimeout(wake, timeoutMs);
    });
  }

  private signalWaiters(tabId: number): void {
    const waiters = this.waitSignals.get(tabId);
    if (!waiters) return;
    for (const wake of [...waiters]) wake();
  }

  private axText(value: unknown): string {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  private semanticKey(role: string, name: string): string {
    return `${role}\u0000${name}`;
  }

  private encodeSemanticRef(pageRevision: number, role: string, name: string): string | undefined {
    const ref = `a${pageRevision}:${encodeURIComponent(role)}:${encodeURIComponent(name)}`;
    return ref.length <= SEMANTIC_REF_MAX_CHARS ? ref : undefined;
  }

  private decodeSemanticRef(ref: unknown): SemanticTarget | null {
    const match = /^a(\d+):([^:]+):(.*)$/.exec(String(ref ?? ""));
    if (!match) return null;
    try {
      const role = decodeURIComponent(match[2]);
      const name = decodeURIComponent(match[3]);
      if (!SEMANTIC_ROLES.has(role) || name.length === 0) return null;
      return { pageRevision: Number(match[1]), role, name };
    } catch {
      return null;
    }
  }

  private async resolveBackendNodeId(
    tabId: number,
    pageRevision: number,
    ref: unknown,
    resolvedTargets?: Map<string, number>,
  ): Promise<number> {
    const cacheKey = String(ref ?? "");
    const cached = resolvedTargets?.get(cacheKey);
    if (cached !== undefined) return cached;
    const match = /^r(\d+)-(\d+)$/.exec(String(ref ?? ""));
    if (match) {
      if (Number(match[1]) !== pageRevision) {
        throw Object.assign(new Error("Snapshot ref belongs to a stale page revision"), {
          code: "stale_ref",
        });
      }
      const backendNodeId = Number(match[2]);
      resolvedTargets?.set(cacheKey, backendNodeId);
      return backendNodeId;
    }
    const semantic = this.decodeSemanticRef(ref);
    if (!semantic || semantic.pageRevision !== pageRevision) {
      throw Object.assign(new Error("Snapshot ref belongs to a stale page revision"), {
        code: "stale_ref",
      });
    }
    const before = await this.pageIdentity(tabId);
    const beforeRevision = await this.revisions.observeDocument(
      tabId,
      before.documentId,
      before.loaderId,
    );
    if (beforeRevision !== pageRevision) {
      throw Object.assign(new Error("Semantic ref belongs to a stale page document"), {
        code: "stale_ref",
        currentPageRevision: beforeRevision,
        recovery: "Take a fresh accessibility snapshot and retry.",
      });
    }
    const document = await this.send(tabId, "DOM.getDocument", { depth: 0 });
    if (!isRecord(document.root) || typeof document.root.nodeId !== "number") {
      throw Object.assign(new Error("Could not inspect the semantic target document"), {
        code: "target_not_found",
        recovery: "Take a fresh accessibility snapshot and retry.",
      });
    }
    const result = await this.send(tabId, "Accessibility.queryAXTree", {
      nodeId: document.root.nodeId,
      accessibleName: semantic.name,
      role: semantic.role,
    });
    const after = await this.pageIdentity(tabId);
    const afterRevision = await this.revisions.observeDocument(
      tabId,
      after.documentId,
      after.loaderId,
    );
    if (
      before.documentId !== after.documentId ||
      before.loaderId !== after.loaderId ||
      afterRevision !== pageRevision
    ) {
      throw Object.assign(new Error("Page changed while resolving the semantic ref"), {
        code: "stale_ref",
        currentPageRevision: afterRevision,
        recovery: "Take a fresh accessibility snapshot and retry.",
      });
    }
    const nodes = (Array.isArray(result.nodes) ? result.nodes.filter(isRecord) : []) as AxNode[];
    const matches = nodes.filter((node) =>
      !node.ignored &&
      typeof node.backendDOMNodeId === "number" &&
      this.axText(node.role?.value) === semantic.role &&
      this.axText(node.name?.value) === semantic.name,
    );
    if (matches.length === 1) {
      const backendNodeId = matches[0].backendDOMNodeId as number;
      resolvedTargets?.set(cacheKey, backendNodeId);
      return backendNodeId;
    }
    const candidates = matches.slice(0, 8).map((node) => ({
      ref: `r${pageRevision}-${String(node.backendDOMNodeId)}`,
      role: this.axText(node.role?.value),
      name: this.axText(node.name?.value),
      ...(node.description?.value !== undefined
        ? { description: String(node.description.value).slice(0, 160) }
        : {}),
    }));
    if (matches.length === 0) {
      throw Object.assign(
        new Error(`Semantic target no longer exists: ${semantic.role} “${semantic.name}”`),
        {
          code: "target_not_found",
          recovery: "Take a fresh accessibility snapshot and retry with its semantic_ref or ref.",
          details: { role: semantic.role, name: semantic.name, match_count: 0 },
        },
      );
    }
    throw Object.assign(
      new Error(
        `Semantic target is ambiguous: ${matches.length} ${semantic.role} elements are named “${semantic.name}”`,
      ),
      {
        code: "ambiguous_target",
        recovery: "Use one of details.candidates.ref from a fresh accessibility snapshot.",
        details: {
          role: semantic.role,
          name: semantic.name,
          match_count: matches.length,
          candidates,
          candidates_truncated: matches.length > candidates.length,
        },
      },
    );
  }

  private async callOnNode(
    tabId: number,
    backendNodeId: number,
    functionDeclaration: string,
    args: Array<Record<string, unknown>>,
    userGesture = false,
  ): Promise<void> {
    try {
      const resolved = await this.send(tabId, "DOM.resolveNode", { backendNodeId });
      if (!resolved.object || typeof resolved.object !== "object" || !("objectId" in resolved.object)) {
        throw Object.assign(new Error("Snapshot ref no longer resolves"), { code: "stale_ref" });
      }
      const invoked = await this.send(tabId, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration,
        arguments: args,
        awaitPromise: true,
        returnByValue: true,
        userGesture,
      });
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

      if (isRecord(invoked.exceptionDetails)) {
        const text =
          typeof invoked.exceptionDetails.text === "string"
            ? invoked.exceptionDetails.text
            : "Page action raised an exception";
        throw Object.assign(new Error(text), { code: "action_failed" });
      }
    } catch (error) {
      if (isRecord(error) && error.code === "stale_ref") {
        throw error;
      }
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

  private async nodeCenter(tabId: number, backendNodeId: number): Promise<{ x: number; y: number }> {
    const model = await this.send(tabId, "DOM.getBoxModel", { backendNodeId });
    if (!model.model || typeof model.model !== "object" || !("content" in model.model) || !Array.isArray(model.model.content)) {
      throw Object.assign(new Error("Dragged ref has no box model"), { code: "stale_ref" });
    }
    const points = model.model.content.map(Number);
    return {
      x: (points[0] + points[2] + points[4] + points[6]) / 4,
      y: (points[1] + points[3] + points[5] + points[7]) / 4,
    };
  }

  private async pageIdentity(tabId: number): Promise<PageIdentity> {
    const document = await this.send(tabId, "DOM.getDocument", { depth: 0 });
    const frameTree = await this.send(tabId, "Page.getFrameTree", {});
    const root = isRecord(document.root) ? document.root : null;
    const documentId = typeof root?.backendNodeId === "number"
      ? `backend:${root.backendNodeId}`
      : typeof root?.nodeId === "number"
        ? `frontend:${root.nodeId}`
        : undefined;
    const loaderId = this.frameLoaderId(frameTree);
    if (documentId === undefined && loaderId === undefined) {
      throw Object.assign(new Error("Could not identify the page document"), {
        code: "snapshot_failed",
      });
    }
    return {
      ...(documentId !== undefined ? { documentId } : {}),
      ...(loaderId !== undefined ? { loaderId } : {}),
    };
  }

  private frameLoaderId(result: Record<string, unknown>): string | undefined {
    if (!result.frameTree || typeof result.frameTree !== "object" || !("frame" in result.frameTree)) return undefined;
    const frame = result.frameTree.frame;
    if (!frame || typeof frame !== "object" || !("loaderId" in frame)) return undefined;
    return typeof frame.loaderId === "string" ? frame.loaderId : undefined;
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
        enabledDomains: new Set(),
        domainEnableTail: Promise.resolve(),
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
        // Page and Network events must be observed for the lifetime of an
        // attachment so dialogs, popups, downloads, and in-flight requests are
        // not missed. Command-only domains are enabled on first use below.
        await this.enableDebuggerDomain(tabId, session, "Page");
        await this.enableDebuggerDomain(tabId, session, "Network");
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

  private async enableDebuggerDomain(
    tabId: number,
    session: DebugSession,
    domain: string,
  ): Promise<void> {
    if (session.enabledDomains.has(domain)) return;
    const enabling = session.domainEnableTail.then(async () => {
      if (session.enabledDomains.has(domain)) return;
      if (this.sessions.get(tabId) !== session || !session.attached) {
        throw Object.assign(new Error("Debugger detached before its domain could be enabled"), {
          code: "debugger_detached",
        });
      }
      await this.authorizeDebuggerUse(tabId);
      await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {});
      session.enabledDomains.add(domain);
      if (domain === "Network") {
        session.pageLoadInFlight = (await chrome.tabs.get(tabId)).status === "loading";
        session.lastNetworkActivity = Date.now();
      }
    });
    session.domainEnableTail = enabling.then(
      () => undefined,
      () => undefined,
    );
    await enabling;
  }

  private async enableCommandDomain(
    tabId: number,
    session: DebugSession,
    method: string,
  ): Promise<void> {
    const separator = method.indexOf(".");
    const domain = separator > 0 ? method.slice(0, separator) : "";
    if (!LAZY_DEBUGGER_DOMAINS.has(domain)) return;
    try {
      await this.enableDebuggerDomain(tabId, session, domain);
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
  }

  private async send(tabId: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = await this.acquireDebuggerBusyLease(tabId);
    try {
      await this.enableCommandDomain(tabId, session, method);
      await this.authorizeDebuggerUse(tabId);
      const result: unknown = await chrome.debugger.sendCommand({ tabId }, method, params);
      return isRecord(result) ? result : {};
    } finally {
      this.releaseDebuggerBusyLease(tabId, session);
    }
  }
}

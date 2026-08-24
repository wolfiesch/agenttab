import { RevisionTracker } from "./revisions";
import { isRecord } from "./type-guards";
import { randomToken, sha256Hex, type StagedCommit } from "./protocol";
import { mutateState, readState } from "./storage";

const DEBUGGER_VERSION = "1.3";
const DEBUGGER_IDLE_MS = 30_000;

interface DebugSession {
  attached: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  inflight: Set<string>;
  lastNetworkActivity: number;
  dialogOpen: boolean;
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

type CloseTab = (tabId: number) => Promise<void>;
type EventSink = (event: string, payload: Record<string, unknown>) => void;

export interface ActionExecution {
  result?: Record<string, unknown>;
  staged?: StagedCommit;
}



export class StandardBrowserRuntime {
  private readonly sessions = new Map<number, DebugSession>();

  constructor(
    private readonly revisions: RevisionTracker,
    private readonly closeTab: CloseTab,
    private readonly emit: EventSink,
  ) {
    chrome.debugger.onDetach.addListener((source: { tabId?: number }) => {
      if (source.tabId !== undefined) this.sessions.delete(source.tabId);
    });
    chrome.debugger.onEvent.addListener(
      (source, method: string, rawParams?: object) => {
        if (source.tabId === undefined) return;
        const session = this.sessions.get(source.tabId);
        if (!session) return;
        const params = isRecord(rawParams) ? rawParams : {};
        if (method === "Network.requestWillBeSent" && typeof params.requestId === "string") {
          session.inflight.add(params.requestId);
          session.lastNetworkActivity = Date.now();
        } else if (
          (method === "Network.loadingFinished" || method === "Network.loadingFailed") &&
          typeof params.requestId === "string"
        ) {
          session.inflight.delete(params.requestId);
          session.lastNetworkActivity = Date.now();
        } else if (method === "Page.javascriptDialogOpening") {
          session.dialogOpen = true;
        } else if (method === "Page.javascriptDialogClosed") {
          session.dialogOpen = false;
        }
      },
    );
  }

  async detach(tabId: number): Promise<void> {
    const session = this.sessions.get(tabId);
    if (session?.idleTimer) clearTimeout(session.idleTimer);
    this.sessions.delete(tabId);
    if (session?.attached) await chrome.debugger.detach({ tabId }).catch(() => undefined);
  }
  async scrubForHandoff(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((tabId) => this.detach(tabId)));
  }

  async snapshot(tabId: number, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const mode = params.mode;
    if (mode === "text" || mode === "html") return this.scriptSnapshot(tabId, mode, params);
    if (mode === "screenshot") return this.screenshot(tabId, params);
    if (mode !== "accessibility") {
      throw Object.assign(new Error("Unsupported snapshot mode"), { code: "invalid_request" });
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
        backendNodeId: this.backendNodeId(pageRevision, params.root_ref),
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
    const encoded = nodes.slice(0, maxNodes).map((node) => ({
      ...(node.backendDOMNodeId
        ? { ref: `r${pageRevision}-${node.backendDOMNodeId}` }
        : {}),
      role: typeof node.role?.value === "string" ? node.role.value : "unknown",
      name: typeof node.name?.value === "string" ? node.name.value : "",
      ...(node.value?.value !== undefined ? { value: node.value.value } : {}),
      ...(node.description?.value !== undefined ? { description: node.description.value } : {}),
      ...(node.ignored ? { ignored: true } : {}),
    }));
    return {
      tab_id: tabId,
      page_revision: pageRevision,
      mode,
      nodes: encoded,
      truncated: nodes.length > maxNodes,
    };
  }

  async act(
    taskId: string,
    tabId: number,
    expectedRevision: unknown,
    actions: unknown,
  ): Promise<ActionExecution> {
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
      const stagedConsequence = await this.consequence(tabId, pageRevision, action);
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
        };
        await mutateState((state) => {
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
      completedActions.push(await this.performAction(tabId, pageRevision, action));
    }
    return {
      result: {
        tab_id: tabId,
        page_revision: await this.revisions.current(tabId),
        actions: completedActions,
      },
    };
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
    const staged = (await readState()).stagedCommits[String(nativeToken)];
    if (!staged || staged.task_id !== taskId || staged.tab_id !== tabId) {
      throw Object.assign(new Error("Staged commit token is invalid, used, or belongs to another task"), {
        code: "invalid_staged_token",
      });
    }
    if (staged.expires_at_ms < Date.now()) {
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
    const currentTarget = typeof action.ref === "string"
      ? await this.targetDescriptor(staged.tab_id, staged.page_revision, action.ref)
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
    const result = await this.performAction(staged.tab_id, staged.page_revision, action);
    return {
      tab_id: staged.tab_id,
      page_revision: await this.revisions.current(staged.tab_id),
      actions: [result],
    };
  }

  async expireCommits(): Promise<void> {
    const expired = await mutateState((state) => {
      const tokens = Object.values(state.stagedCommits)
        .filter((staged) => staged.expires_at_ms < Date.now())
        .map((staged) => staged.native_token);
      for (const token of tokens) delete state.stagedCommits[token];
      return tokens;
    });
    for (const nativeToken of expired) {
      this.emit("commit_expired", { native_token: nativeToken });
    }
  }

  async wait(tabId: number, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!isRecord(params.condition) || typeof params.condition.kind !== "string") {
      throw Object.assign(new Error("browser_wait requires a condition"), { code: "invalid_request" });
    }
    const condition = params.condition;
    const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : 30_000;
    const waitStartedAtMs = Date.now();
    const deadline = waitStartedAtMs + timeoutMs;
    do {
      const matched = await this.conditionMatched(tabId, condition, waitStartedAtMs);
      if (matched) {
        return {
          tab_id: tabId,
          page_revision: await this.revisions.current(tabId),
          condition: condition.kind,
          matched: true,
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
  }

  async developer(tabId: number, action: string, params: Record<string, unknown>): Promise<unknown> {
    const [domain, ...rest] = action.split(".");
    if (!domain || rest.length === 0) {
      throw Object.assign(new Error("Developer action must be a CDP Domain.method"), {
        code: "invalid_request",
      });
    }
    return this.send(tabId, action, params);
  }

  private async scriptSnapshot(
    tabId: number,
    mode: "text" | "html",
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const selector = typeof params.selector === "string" ? params.selector : null;
    const maxBytes = typeof params.max_bytes === "number" ? params.max_bytes : 256_000;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (snapshotMode: "text" | "html", targetSelector: string | null) => {
        const target = targetSelector ? document.querySelector(targetSelector) : document.documentElement;
        if (!target) throw new Error(`Selector did not match: ${targetSelector}`);
        return snapshotMode === "text" ? target.textContent ?? "" : target.outerHTML;
      },
      args: [mode, selector],
    });
    const pageRevision = await this.revisions.current(tabId);
    const bytes = new TextEncoder().encode(String(result ?? ""));
    const bounded = bytes.length > maxBytes ? new TextDecoder().decode(bytes.slice(0, maxBytes)) : String(result ?? "");
    return {
      tab_id: tabId,
      page_revision: pageRevision,
      mode,
      content: bounded,
      truncated: bytes.length > maxBytes,
    };
  }

  private async screenshot(tabId: number, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const capture: Record<string, unknown> = {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: params.full_page === true,
    };
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
      capture.clip = {
        x,
        y,
        width: Math.max(points[0], points[2], points[4], points[6]) - x,
        height: Math.max(points[1], points[3], points[5], points[7]) - y,
        scale: 1,
      };
    } else if (params.full_page === true) {
      const metrics = await this.send(tabId, "Page.getLayoutMetrics", {});
      if (isRecord(metrics.cssContentSize)) {
        capture.clip = {
          x: Number(metrics.cssContentSize.x ?? 0),
          y: Number(metrics.cssContentSize.y ?? 0),
          width: Number(metrics.cssContentSize.width ?? 0),
          height: Number(metrics.cssContentSize.height ?? 0),
          scale: 1,
        };
      }
    }
    const result = await this.send(tabId, "Page.captureScreenshot", capture);
    return {
      tab_id: tabId,
      page_revision: await this.revisions.current(tabId),
      mode: "screenshot",
      data: result.data,
      encoding: "base64",
      media_type: "image/png",
    };
  }


  private async consequence(
    tabId: number,
    pageRevision: number,
    action: Record<string, unknown>,
  ): Promise<{ effect: string; target: Record<string, unknown> } | null> {
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
          ? await this.targetDescriptor(tabId, pageRevision, action.ref)
          : { kind: action.kind },
      };
    }
    if (action.kind === "dialog" && action.decision === "accept") {
      return {
        effect: "Accept a browser confirmation dialog",
        target: { kind: action.kind },
      };
    }
    if (action.kind !== "click") return null;
    const target = await this.targetDescriptor(tabId, pageRevision, action.ref);
    const label = [
      target.text,
      target.aria_label,
      target.title,
      target.name,
      target.id,
      target.type,
      target.form_action,
      target.form_method,
    ].filter((value) => typeof value === "string").join(" ").replace(/\s+/g, " ").trim();
    if (
      /\b(buy|purchase|pay|send|transfer|delete|remove|publish|post|deploy|merge|approve|authorize|grant|revoke|unsubscribe|cancel subscription|place order|checkout|submit order|confirm order|permission)\b/i.test(
        label,
      )
    ) {
      return {
        effect: `Activate consequential control: ${label.slice(0, 160)}`,
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

  private async targetDescriptor(
    tabId: number,
    pageRevision: number,
    ref: unknown,
  ): Promise<Record<string, unknown>> {
    const backendNodeId = this.backendNodeId(pageRevision, ref);
    const resolved = await this.send(tabId, "DOM.resolveNode", { backendNodeId });
    if (!isRecord(resolved.object) || typeof resolved.object.objectId !== "string") {
      throw Object.assign(new Error("Snapshot ref no longer resolves"), { code: "stale_ref" });
    }
    const described = await this.send(tabId, "Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration:
        "function(){const f=this.form;return {tag:this.tagName,role:this.getAttribute('role'),text:[this.innerText,this.textContent].filter(Boolean).join(' '),aria_label:this.getAttribute('aria-label'),title:this.getAttribute('title'),name:this.getAttribute('name'),id:this.id,type:this.getAttribute('type'),autocomplete:this.getAttribute('autocomplete'),href:this.getAttribute('href'),form_action:f&&f.action,form_method:f&&f.method,form_enctype:f&&f.enctype}}",
      returnByValue: true,
    });
    if (!isRecord(described.result) || !isRecord(described.result.value)) {
      throw Object.assign(new Error("Snapshot ref no longer resolves"), { code: "stale_ref" });
    }
    return described.result.value;
  }

  private async performAction(
    tabId: number,
    pageRevision: number,
    action: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
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
    if (kind === "focus") {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return { kind, completed: true };
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
      await this.send(tabId, "Page.handleJavaScriptDialog", {
        accept: action.decision === "accept",
        ...(typeof action.prompt_text === "string" ? { promptText: action.prompt_text } : {}),
      });
      return { kind, completed: true };
    }
    if (kind === "press") {
      throw Object.assign(new Error("press is unavailable in Standard mode because it has no identifiable target"), {
        code: "invalid_request",
      });
    }
    if (kind === "scroll" && action.ref === undefined) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (deltaX: number, deltaY: number) => window.scrollBy(deltaX, deltaY),
        args: [Number(action.delta_x ?? 0), Number(action.delta_y ?? 0)],
      });
      return { kind, completed: true };
    }
    const backendNodeId = this.backendNodeId(pageRevision, action.ref);
    if (kind === "click") {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
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
      }
    } else if (kind === "type") {
      await this.callOnNode(
        tabId,
        backendNodeId,
        "function(value){this.focus();if(this.isContentEditable){this.textContent=(this.textContent||'')+value}else{const current=String(this.value||'');const start=Number.isInteger(this.selectionStart)?this.selectionStart:current.length;const end=Number.isInteger(this.selectionEnd)?this.selectionEnd:start;this.value=current.slice(0,start)+value+current.slice(end);if(typeof this.setSelectionRange==='function'){const position=start+value.length;this.setSelectionRange(position,position)}}this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}))}",
        [{ value: String(action.text ?? "") }],
      );
    } else if (kind === "fill") {
      await this.callOnNode(
        tabId,
        backendNodeId,
        "function(value){this.focus();this.value=value;this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));this.dispatchEvent(new Event('change',{bubbles:true}))}",
        [{ value: String(action.text ?? "") }],
      );
    } else if (kind === "select") {
      await this.callOnNode(
        tabId,
        backendNodeId,
        "function(value){this.value=value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}))}",
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
      const targetBackendNodeId = this.backendNodeId(pageRevision, action.target_ref);
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
  ): Promise<boolean> {
    const kind = condition.kind;
    if (kind === "load") return (await chrome.tabs.get(tabId)).status === "complete";
    if (kind === "url") return (await chrome.tabs.get(tabId)).url === condition.value;
    if (kind === "text" || kind === "selector") {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (conditionKind: string, value: string) =>
          conditionKind === "text"
            ? (document.documentElement.textContent ?? "").includes(value)
            : document.querySelector(value) !== null,
        args: [kind, String(condition.value ?? "")],
      });
      return result === true;
    }
    if (kind === "network_idle") {
      await this.ensureAttached(tabId);
      const session = this.sessions.get(tabId);
      return Boolean(session && session.inflight.size === 0 && Date.now() - session.lastNetworkActivity >= 500);
    }
    if (kind === "download") {
      const downloads = await chrome.downloads.search({ state: "complete", limit: 1, orderBy: ["-endTime"] });
      const completedAtMs = Date.parse(downloads[0]?.endTime ?? "");
      return Number.isFinite(completedAtMs) && completedAtMs >= waitStartedAtMs;
    }
    throw Object.assign(new Error(`Unsupported wait condition: ${String(kind)}`), {
      code: "invalid_request",
    });
  }
  private backendNodeId(pageRevision: number, ref: unknown): number {
    const match = /^r(\d+)-(\d+)$/.exec(String(ref ?? ""));
    if (!match || Number(match[1]) !== pageRevision) {
      throw Object.assign(new Error("Snapshot ref belongs to a stale page revision"), {
        code: "stale_ref",
      });
    }
    return Number(match[2]);
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
    let session = this.sessions.get(tabId);
    if (!session) {
      session = { attached: false, inflight: new Set(), lastNetworkActivity: Date.now(), dialogOpen: false };
      this.sessions.set(tabId, session);
    }
    if (!session.attached) {
      await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
      session.attached = true;
      await Promise.all([
        chrome.debugger.sendCommand({ tabId }, "Page.enable", {}),
        chrome.debugger.sendCommand({ tabId }, "DOM.enable", {}),
        chrome.debugger.sendCommand({ tabId }, "Accessibility.enable", {}),
        chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {}),
        chrome.debugger.sendCommand({ tabId }, "Network.enable", {}),
      ]);
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => void this.detach(tabId), DEBUGGER_IDLE_MS);
  }

  private async send(tabId: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureAttached(tabId);
    const result: unknown = await chrome.debugger.sendCommand({ tabId }, method, params);
    return isRecord(result) ? result : {};
  }
}

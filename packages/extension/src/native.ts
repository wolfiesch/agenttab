import {
  failed,
  nativeEvent,
  nativeHello,
  parseInboundNativeMessage,
  randomUuidV7,
  type NativeDispatchCommand,
  type NativeEventAck,
  type NativeInboundMessage,
  type NativeResponse,
  type NativeTab,
} from "./protocol";
import { MutationScheduler } from "./scheduler";
import { mutateState, readState } from "./storage";
import { OwnershipLedger } from "./ownership";
import { isRecord } from "./type-guards";

declare const AGENTTAB_NATIVE_HOST: string;
const NATIVE_HOST = typeof AGENTTAB_NATIVE_HOST === "string" ? AGENTTAB_NATIVE_HOST : "dev.agenttab.host";
const RECONNECT_ALARM = "agenttab-native-reconnect";
const RECONNECT_MAX_MS = 30_000;
type CommandHandler = (command: NativeDispatchCommand) => Promise<NativeResponse>;
type StageDiscarder = (nativeTokens: readonly string[]) => Promise<void>;
interface PendingEventAck {
  resolve: (ack: NativeEventAck) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
interface ReadyReconciliation {
  port: NativePort;
  promise: Promise<void>;
}

interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

function nativeInventory(inventory: Array<Record<string, unknown>>): NativeTab[] {
  return inventory.map((tab) => ({
    tab_id: Number(tab.tab_id),
    window_id: Number(tab.window_id),
    group_id: Number(tab.group_id),
    url: String(tab.url ?? ""),
    page_revision: Number(tab.page_revision),
    ...(typeof tab.task_id === "string" ? { task_id: tab.task_id } : {}),
  }));
}

export class NativeBridge {
  private port: NativePort | null = null;
  private ready = false;
  private reconnectAttempt = 0;
  private readonly pendingEventAcks = new Map<string, PendingEventAck>();
  private readyReconciliation: ReadyReconciliation | null = null;
  constructor(
    private readonly scheduler: MutationScheduler,
    private readonly ownership: OwnershipLedger,
    private readonly handleCommand: CommandHandler,
    private readonly onEventAcknowledged: (event: string, eventId: string) => void = () => undefined,
    private readonly onReady: () => Promise<void> = async () => undefined,
    private readonly discardStages: StageDiscarder = async () => undefined,
  ) { }

  async connect(): Promise<void> {
    if (this.port) return;
    let port: NativePort;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.port = port;
    this.ready = false;
    this.readyReconciliation = null;
    port.onMessage.addListener((message: unknown) => {
      void this.onMessage(port, message).catch(() => {
        if (this.port === port) port.disconnect();
      });
    });
    port.onDisconnect.addListener(() => void this.onDisconnect(port));
    try {
      const state = await readState();
      port.postMessage(nativeHello(
        chrome.runtime.getManifest().version,
        nativeInventory(await this.ownership.inventory()),
        state.paused,
        state.handoff.active
          ? {
            active: true,
            task_id: state.handoff.taskId,
            tab_id: state.handoff.tabId,
            started_at_ms: state.handoff.startedAtMs,
          }
          : { active: false },
        Object.values(state.stagedCommits).map(({
          action: _action,
          preview: _preview,
          dialog: _dialog,
          review_handle: _reviewHandle,
          approved: _approved,
          ...staged
        }) => staged),
      ));
    } catch {
      this.onDisconnect(port);
    }
  }

  sendEvent(event: string, payload: Record<string, unknown>, eventId?: string): void {
    if (!this.port || !this.ready) return;
    try {
      const normalized = event === "inventory" && Array.isArray(payload.inventory)
        ? { inventory: nativeInventory(payload.inventory.filter(isRecord)) }
        : payload;
      this.port.postMessage(nativeEvent(event, normalized, eventId));
    } catch {
      this.onDisconnect(this.port);
    }
  }


  async approvePopupCommit(
    reviewHandle: string,
    taskId: string,
    tabId: number,
  ): Promise<Record<string, unknown>> {
    const acknowledgement = await this.requestPopupEvent("popup_commit_approved", {
      review_handle: reviewHandle,
      task_id: taskId,
      tab_id: tabId,
    });
    if (acknowledgement.outcome !== "completed" || !acknowledgement.result) {
      const error = acknowledgement.error;
      throw Object.assign(new Error(error?.message ?? "AgentTab could not approve the staged action"), {
        code: error?.code ?? "popup_commit_failed",
        acknowledged: true,
      });
    }
    return acknowledgement.result;
  }

  async abandonPopupCommit(
    reviewHandle: string,
    taskId: string,
    tabId: number,
  ): Promise<Record<string, unknown>> {
    const acknowledgement = await this.requestPopupEvent("popup_commit_abandoned", {
      review_handle: reviewHandle,
      task_id: taskId,
      tab_id: tabId,
    });
    if (acknowledgement.outcome !== "completed" || !acknowledgement.result) {
      const error = acknowledgement.error;
      throw Object.assign(new Error(error?.message ?? "AgentTab could not abandon the staged action"), {
        code: error?.code ?? "popup_commit_failed",
        acknowledged: true,
      });
    }
    return acknowledgement.result;
  }

  private requestPopupEvent(
    event: "popup_commit_approved" | "popup_commit_abandoned",
    payload: Record<string, unknown>,
  ): Promise<NativeEventAck> {
    const port = this.port;
    if (!port || !this.ready) {
      throw Object.assign(new Error("AgentTab host is disconnected; the staged action was not approved"), {
        code: "extension_disconnected",
      });
    }
    const eventId = randomUuidV7();
    return new Promise<NativeEventAck>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingEventAcks.delete(eventId);
        reject(Object.assign(new Error("AgentTab host did not acknowledge the staged action"), {
          code: "extension_disconnected",
        }));
      }, 30_000);
      this.pendingEventAcks.set(eventId, { resolve, reject, timeout });
      try {
        port.postMessage(nativeEvent(event, payload, eventId));
      } catch {
        clearTimeout(timeout);
        this.pendingEventAcks.delete(eventId);
        reject(Object.assign(new Error("AgentTab host is disconnected; the staged action was not approved"), {
          code: "extension_disconnected",
        }));
      }
    });
  }
  async reconnectFromAlarm(alarmName: string): Promise<void> {
    if (alarmName !== RECONNECT_ALARM || this.port) return;
    await this.connect();
  }
  private async onMessage(port: NativePort, message: unknown): Promise<void> {
    if (this.port !== port) return;
    let parsed: NativeInboundMessage;
    try {
      parsed = parseInboundNativeMessage(message);
    } catch (error) {
      if (
        isRecord(error) &&
        error.code === "invalid_request" &&
        isRecord(message) &&
        typeof message.request_id === "string" &&
        this.port === port
      ) {
        port.postMessage(failed(message.request_id, "invalid_request", error instanceof Error ? error.message : String(error)));
        return;
      }
      if (this.port === port) port.disconnect();
      return;
    }
    if (parsed.kind === "event_ack") {
      const pending = this.pendingEventAcks.get(parsed.event_id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingEventAcks.delete(parsed.event_id);
        pending.resolve(parsed);
      } else if (this.ready) {
        this.onEventAcknowledged(parsed.event, parsed.event_id);
      }
      return;
    }
    if (parsed.kind === "ready") {
      if (this.readyReconciliation?.port === port) {
        port.disconnect();
        return;
      }
      const promise = this.reconcileReady(port, parsed);
      const reconciliation = { port, promise };
      this.readyReconciliation = reconciliation;
      try {
        await promise;
      } finally {
        if (this.readyReconciliation === reconciliation) this.readyReconciliation = null;
      }
      return;
    }
    const reconciliation = this.readyReconciliation;
    if (reconciliation?.port === port) {
      await reconciliation.promise;
      if (this.port !== port) return;
    }
    if (!this.ready) {
      if (this.port === port) port.disconnect();
      return;
    }
    let response: NativeResponse;
    try {
      response = await this.handleCommand(parsed);
    } catch (error) {
      response = failed(
        parsed.request_id,
        isRecord(error) && typeof error.code === "string" ? error.code : "native_action_failed",
        error instanceof Error ? error.message : String(error),
        "unknown",
      );
    }
    if (this.port !== port) return;
    try {
      port.postMessage(response);
    } catch {
      this.onDisconnect(port);
    }
  }

  private async reconcileReady(
    port: NativePort,
    parsed: Extract<NativeInboundMessage, { kind: "ready" }>,
  ): Promise<void> {
    try {
      await this.discardStages(parsed.discard_staged_tokens ?? []);
      if (this.port !== port) return;
    } catch {
      if (this.port === port) port.disconnect();
      return;
    }
    this.ready = true;
    this.reconnectAttempt = 0;
    await chrome.alarms.clear(RECONNECT_ALARM);
    if (this.port !== port) return;
    if (parsed.state === "paused") {
      await this.scheduler.pause();
      if (this.port !== port) return;
      await mutateState((state) => {
        state.paused = true;
      });
      if (this.port !== port) return;
      await this.onReady();
      return;
    }
    const state = await readState();
    if (this.port !== port) return;
    if (!state.paused && !state.handoff.active) this.scheduler.resume();
    await this.onReady();
  }

  private onDisconnect(port: NativePort): void {
    if (this.port !== port) return;
    this.port = null;
    this.ready = false;
    this.readyReconciliation = null;
    for (const [eventId, pending] of this.pendingEventAcks) {
      clearTimeout(pending.timeout);
      pending.reject(Object.assign(new Error("AgentTab host disconnected before acknowledging the staged action"), {
        code: "extension_disconnected",
      }));
      this.pendingEventAcks.delete(eventId);
    }
    this.scheduler.disconnect();
    void this.discardStages([]);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    chrome.alarms.create(RECONNECT_ALARM, { when: Date.now() + delay });
  }
}

export { RECONNECT_ALARM };

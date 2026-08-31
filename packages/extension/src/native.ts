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
const RECONNECT_ALARM_FLOOR_MS = 30_000;
const NATIVE_URL_MAX_CHARS = 16_384;
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

interface NativeHandshakeAttempt {
  port: NativePort;
  advertisedCapabilities: boolean;
  helloSent: boolean;
  receivedMessage: boolean;
  locallyClosed: boolean;
}

interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface ReconnectTiming {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

const DEFAULT_RECONNECT_TIMING: ReconnectTiming = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

function nativeInventory(inventory: Array<Record<string, unknown>>): NativeTab[] {
  return inventory.map((tab) => {
    const url = String(tab.url ?? "");
    return {
      tab_id: Number(tab.tab_id),
      window_id: Number(tab.window_id),
      group_id: Number(tab.group_id),
      url: url.length <= NATIVE_URL_MAX_CHARS ? url : "",
      page_revision: Number(tab.page_revision),
      ...(typeof tab.task_id === "string" ? { task_id: tab.task_id } : {}),
    };
  });
}

export class NativeBridge {
  private port: NativePort | null = null;
  private ready = false;
  private reconnectAttempt = 0;
  private cancelReconnectTimer: (() => void) | null = null;
  private reconnectFallbackAtMs: number | null = null;
  private readonly pendingEventAcks = new Map<string, PendingEventAck>();
  private readyReconciliation: ReadyReconciliation | null = null;
  private protocolIncompatible = false;
  // Do not alternate handshake shapes inside the existing reconnect loop.
  private useLegacyV1Handshake = false;
  private handshakeAttempt: NativeHandshakeAttempt | null = null;
  constructor(
    private readonly scheduler: MutationScheduler,
    private readonly ownership: OwnershipLedger,
    private readonly handleCommand: CommandHandler,
    private readonly onEventAcknowledged: (event: string, eventId: string) => void = () => undefined,
    private readonly onReady: () => Promise<void> = async () => undefined,
    private readonly discardStages: StageDiscarder = async () => undefined,
    private readonly reconnectTiming: ReconnectTiming = DEFAULT_RECONNECT_TIMING,
  ) { }

  async connect(): Promise<void> {
    if (this.protocolIncompatible || this.port) return;
    this.clearReconnectTimer();
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
    const handshakeAttempt: NativeHandshakeAttempt = {
      port,
      advertisedCapabilities: !this.useLegacyV1Handshake,
      helloSent: false,
      receivedMessage: false,
      locallyClosed: false,
    };
    this.handshakeAttempt = handshakeAttempt;
    this.ensureReconnectAlarm(RECONNECT_ALARM_FLOOR_MS);
    port.onMessage.addListener((message: unknown) => {
      void this.onMessage(port, message).catch(() => {
        if (this.port === port) this.disconnectLocally(port);
      });
    });
    port.onDisconnect.addListener(() => void this.onDisconnect(port));
    try {
      const state = await readState();
      const hello = nativeHello(
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
        handshakeAttempt.advertisedCapabilities,
      );
      handshakeAttempt.helloSent = true;
      port.postMessage(hello);
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
    if (alarmName !== RECONNECT_ALARM) return;
    this.reconnectFallbackAtMs = null;
    this.clearReconnectTimer();
    if (this.port) {
      if (this.ready) return;
      this.disconnectLocally(this.port);
      return;
    }
    await this.connect();
  }
  private async onMessage(port: NativePort, message: unknown): Promise<void> {
    if (this.port !== port) return;
    if (this.handshakeAttempt?.port === port) this.handshakeAttempt.receivedMessage = true;
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
      if (this.port === port) this.disconnectLocally(port);
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
    if (parsed.kind === "incompatible") {
      this.protocolIncompatible = true;
      this.clearReconnectTimer();
      this.reconnectFallbackAtMs = null;
      await chrome.alarms.clear(RECONNECT_ALARM);
      console.error(`${parsed.message} ${parsed.recovery}`);
      this.disconnectLocally(port);
      return;
    }
    if (parsed.kind === "ready") {
      if (this.readyReconciliation?.port === port) {
        this.disconnectLocally(port);
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
      if (this.port === port) this.disconnectLocally(port);
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
      if (this.port === port) this.disconnectLocally(port);
      return;
    }
    this.ready = true;
    this.handshakeAttempt = null;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.reconnectFallbackAtMs = null;
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
    const attempt = this.handshakeAttempt?.port === port ? this.handshakeAttempt : null;
    const retryLegacyHandshake =
      !this.protocolIncompatible &&
      attempt?.advertisedCapabilities === true &&
      attempt.helloSent &&
      !attempt.receivedMessage &&
      !attempt.locallyClosed;
    this.port = null;
    this.ready = false;
    this.readyReconciliation = null;
    this.handshakeAttempt = null;
    for (const [eventId, pending] of this.pendingEventAcks) {
      clearTimeout(pending.timeout);
      pending.reject(Object.assign(new Error("AgentTab host disconnected before acknowledging the staged action"), {
        code: "extension_disconnected",
      }));
      this.pendingEventAcks.delete(eventId);
    }
    this.scheduler.disconnect();
    if (retryLegacyHandshake) {
      this.useLegacyV1Handshake = true;
      void this.connect();
      return;
    }
    void this.discardStages([]);
    this.scheduleReconnect();
  }

  private disconnectLocally(port: NativePort): void {
    if (this.handshakeAttempt?.port === port) this.handshakeAttempt.locallyClosed = true;
    port.disconnect();
  }

  private scheduleReconnect(): void {
    if (this.protocolIncompatible || this.port || this.cancelReconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.ensureReconnectAlarm(delay);
    if (delay < RECONNECT_ALARM_FLOOR_MS) {
      this.cancelReconnectTimer = this.reconnectTiming.schedule(() => {
        this.cancelReconnectTimer = null;
        if (!this.port) void this.connect();
      }, delay);
    }
  }

  private clearReconnectTimer(): void {
    if (this.cancelReconnectTimer === null) return;
    this.cancelReconnectTimer();
    this.cancelReconnectTimer = null;
  }

  private ensureReconnectAlarm(delayMs: number): void {
    const now = this.reconnectTiming.now();
    if (this.reconnectFallbackAtMs !== null && this.reconnectFallbackAtMs > now) return;
    this.reconnectFallbackAtMs = now + Math.max(delayMs, RECONNECT_ALARM_FLOOR_MS);
    chrome.alarms.create(RECONNECT_ALARM, { when: this.reconnectFallbackAtMs });
  }
}

export { RECONNECT_ALARM };

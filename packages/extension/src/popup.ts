import { STATE_KEY } from "./storage";
import { isRecord } from "./type-guards";

type Lifecycle = "disabled" | "ready" | "paused" | "your-turn" | "error";

interface TaskView {
  taskId: string;
  name: string;
  state: string;
  tabCount: number;
  /** number: focusable tab; null: none reachable; undefined: not reported. */
  focusTabId: number | null | undefined;
  color: string | null;
}

interface ReviewView {
  reviewHandle: string;
  taskId: string;
  tabId: number;
  effect: string;
  expiresAtMs: number;
}

interface UiState {
  automationEnabled: boolean;
  paused: boolean;
  developerMode: boolean;
  pointer: boolean | null;
  handoffPrompt: string | null;
  tasks: TaskView[];
  reviews: ReviewView[];
}

/** Chrome's dark tab-group palette, so a popup row matches its group strip. */
const TASK_COLORS: Record<string, string> = {
  purple: "#a78bfa",
  cyan: "#78d9ec",
  green: "#81c995",
  yellow: "#fdd663",
  orange: "#fcad70",
  red: "#f28b82",
  pink: "#ff8bcb",
  blue: "#8ab4f8",
};

/** How one persisted task state reads in the popup list. */
interface TaskGlyph {
  label: string;
  symbol: string;
}

const TASK_STATES: Record<string, TaskGlyph> = {
  working: { label: "Working", symbol: "✦" },
  needs_user: { label: "Needs you", symbol: "↗" },
  completed: { label: "Finished", symbol: "✓" },
};

const STATUS_TEXT: Record<Lifecycle, string> = {
  disabled: "Setup needed",
  ready: "Ready",
  paused: "Paused",
  "your-turn": "Your turn",
  error: "Unavailable",
};

function element<T extends HTMLElement>(id: string, type: new (...args: never[]) => T): T {
  const candidate = document.getElementById(id);
  if (!(candidate instanceof type)) throw new Error(`Missing popup element #${id}`);
  return candidate;
}

const status = element("status", HTMLSpanElement);
const developerChip = element("developer-chip", HTMLSpanElement);
const automationDetail = element("automation-detail", HTMLElement);
const pauseButton = element("pause", HTMLButtonElement);
const runtimeError = element("runtime-error", HTMLParagraphElement);
const permissionPanel = element("permission", HTMLElement);
const enableButton = element("enable", HTMLButtonElement);
const permissionError = element("permission-error", HTMLParagraphElement);
const automationSetting = element("automation-setting", HTMLDivElement);
const disableButton = element("disable", HTMLButtonElement);
const developerPanel = element("developer", HTMLElement);
const developerOff = element("developer-off", HTMLButtonElement);
const handoffPanel = element("handoff", HTMLElement);
const handoffPrompt = element("handoff-prompt", HTMLParagraphElement);
const handoffCancel = element("handoff-cancel", HTMLButtonElement);
const handoffDone = element("handoff-done", HTMLButtonElement);
const handoffError = element("handoff-error", HTMLParagraphElement);
const taskCount = element("task-count", HTMLSpanElement);
const taskList = element("tasks", HTMLUListElement);
const taskError = element("task-error", HTMLParagraphElement);
const pointerToggle = element("pointer", HTMLInputElement);
const pointerDetail = element("pointer-detail", HTMLElement);
const settingsError = element("settings-error", HTMLParagraphElement);
const reviews = element("reviews", HTMLElement);
const reviewList = element("review-list", HTMLUListElement);
const reviewError = element("review-error", HTMLParagraphElement);

let current: UiState | null = null;
let pending = false;
let handoffShown = false;
let confirming: string | null = null;
let confirmEpoch = 0;

function show(target: HTMLElement, text: string): void {
  target.textContent = text;
  target.hidden = false;
}

function hide(target: HTMLElement): void {
  target.textContent = "";
  target.hidden = true;
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  const text = String(error);
  return text === "" ? "AgentTab could not complete that action." : text;
}

/**
  * Every popup control answers with a record. `undefined` means the service
  * worker never replied, which the popup must surface instead of looking idle.
  */
async function send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response: unknown = await chrome.runtime.sendMessage(message);
  if (!isRecord(response)) {
    throw new Error(
      `AgentTab's background runtime did not answer "${String(message.kind)}". Reload AgentTab from chrome://extensions, then try again.`,
    );
  }
  return response;
}

function parseTask(value: Record<string, unknown>): TaskView | null {
  if (typeof value.task_id !== "string") return null;
  const name = typeof value.name === "string" && value.name.trim() !== "" ? value.name : "AgentTab task";
  return {
    taskId: value.task_id,
    name,
    state: typeof value.state === "string" ? value.state : "working",
    tabCount: typeof value.tab_count === "number" ? value.tab_count : 0,
    focusTabId: typeof value.focus_tab_id === "number"
      ? value.focus_tab_id
      : "focus_tab_id" in value ? null : undefined,
    color: typeof value.color === "string" ? value.color : null,
  };
}

function parseReview(value: Record<string, unknown>): ReviewView | null {
  if (
    typeof value.review_handle !== "string" ||
    typeof value.task_id !== "string" ||
    typeof value.tab_id !== "number" ||
    typeof value.effect !== "string" ||
    typeof value.expires_at_ms !== "number"
  ) {
    return null;
  }
  return {
    reviewHandle: value.review_handle,
    taskId: value.task_id,
    tabId: value.tab_id,
    effect: value.effect,
    expiresAtMs: value.expires_at_ms,
  };
}

async function load(): Promise<UiState> {
  const response = await send({ kind: "get_ui_state" });
  const handoff = isRecord(response.handoff) ? response.handoff : null;
  const prompt = handoff && typeof handoff.prompt === "string" && handoff.prompt.trim() !== ""
    ? handoff.prompt
    : "Finish the requested step in the focused tab, then choose I'm done.";
  return {
    automationEnabled: response.automation_enabled === true,
    paused: response.paused === true,
    developerMode: response.developer_mode === true,
    pointer: typeof response.show_agent_pointer === "boolean" ? response.show_agent_pointer : null,
    handoffPrompt: handoff === null ? null : prompt,
    tasks: Array.isArray(response.tasks)
      ? response.tasks
        .filter(isRecord)
        .map(parseTask)
        .filter((task): task is TaskView => task !== null)
      : [],
    reviews: Array.isArray(response.reviews)
      ? response.reviews
        .filter(isRecord)
        .map(parseReview)
        .filter((review): review is ReviewView => review !== null)
      : [],
  };
}

function lifecycle(state: UiState): Lifecycle {
  if (state.handoffPrompt !== null) return "your-turn";
  if (!state.automationEnabled) return "disabled";
  return state.paused ? "paused" : "ready";
}

function admissionDetail(phase: Lifecycle, paused: boolean): string {
  if (phase === "your-turn") return "Held until you finish or cancel the step above.";
  if (paused) return "Queued agent work is refused. Work already dispatched still finishes.";
  if (phase === "disabled") return "Agents can open task tabs, but page reads and actions stay blocked.";
  return "Agents can open task tabs and act inside them.";
}

function disarm(): void {
  confirmEpoch += 1;
  confirming = null;
}

function arm(taskId: string): void {
  const epoch = ++confirmEpoch;
  confirming = taskId;
  setTimeout(() => {
    if (epoch !== confirmEpoch) return;
    disarm();
    if (current) render(current);
  }, 5_000);
  if (current) render(current);
}

function emptyRow(): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "empty";
  row.textContent = "No task groups yet. Ask an agent to open a tab and it shows up here.";
  return row;
}

function renderTask(task: TaskView, developerMode: boolean): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "task";
  const color: string | undefined = task.color === null ? undefined : TASK_COLORS[task.color];
  if (color !== undefined) row.style.setProperty("--task-color", color);

  const glyph: TaskGlyph | undefined = TASK_STATES[task.state];
  const symbol = document.createElement("span");
  symbol.className = "task-symbol";
  symbol.textContent = glyph?.symbol ?? "✦";
  symbol.setAttribute("aria-hidden", "true");

  const copy = document.createElement("div");
  copy.className = "task-copy";
  const name = document.createElement("strong");
  name.textContent = task.name;
  const detail = document.createElement("small");
  detail.textContent = `${glyph?.label ?? task.state} · ${task.tabCount} ${task.tabCount === 1 ? "tab" : "tabs"}`;
  copy.append(name, detail);
  row.append(symbol, copy);

  if (developerMode) {
    const badge = document.createElement("span");
    badge.className = "task-badge";
    badge.textContent = "Dev";
    badge.title = "Developer mode exposes raw DevTools Protocol calls for this task";
    row.append(badge);
  }

  // `null` means the runtime reported no reachable tab, so no dead control is
  // rendered; `undefined` means it reported nothing and the click reports back.
  if (task.focusTabId !== null) {
    const focus = document.createElement("button");
    focus.type = "button";
    focus.className = "link";
    focus.textContent = "Focus";
    focus.setAttribute("aria-label", `Focus ${task.name}`);
    focus.addEventListener("click", () => {
      void guard(taskError, async () => {
        const result = await send({ kind: "focus_task", task_id: task.taskId });
        if (result.focused !== true) {
          throw new Error(`${task.name} has no reachable tab to focus. Finish it, or let the agent open a new tab.`);
        }
      });
    });
    row.append(focus);
  }

  const armed = confirming === task.taskId;
  const finish = document.createElement("button");
  finish.type = "button";
  finish.className = "link";
  finish.textContent = armed ? "Confirm" : "Finish";
  finish.setAttribute(
    "aria-label",
    armed
      ? `Confirm finishing ${task.name} and closing its ${task.tabCount === 1 ? "tab" : "tabs"}`
      : `Finish ${task.name} and close its ${task.tabCount === 1 ? "tab" : "tabs"}`,
  );
  if (armed) finish.dataset.confirm = "1";
  finish.addEventListener("click", () => {
    if (confirming !== task.taskId) {
      hide(taskError);
      arm(task.taskId);
      return;
    }
    void guard(taskError, async () => {
      await send({ kind: "close_task", task_id: task.taskId });
      disarm();
    });
  });

  row.append(finish);
  return row;
}

function renderReview(review: ReviewView): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "review";
  const effect = document.createElement("strong");
  effect.textContent = review.effect;
  const expiry = document.createElement("small");
  const seconds = Math.max(0, Math.ceil((review.expiresAtMs - Date.now()) / 1_000));
  expiry.textContent = seconds === 1 ? "Expires in 1 second" : `Expires in ${seconds} seconds`;
  const actions = document.createElement("div");
  actions.className = "review-actions";
  const abandon = document.createElement("button");
  abandon.type = "button";
  abandon.className = "quiet";
  abandon.textContent = "Decline";
  abandon.addEventListener("click", () => {
    void guard(reviewError, async () => {
      await send({ kind: "abandon_popup_commit", review_handle: review.reviewHandle });
    });
  });
  const approve = document.createElement("button");
  approve.type = "button";
  approve.textContent = "Approve";
  approve.addEventListener("click", () => {
    void guard(reviewError, async () => {
      await send({ kind: "approve_popup_commit", review_handle: review.reviewHandle });
    });
  });
  actions.append(abandon, approve);
  row.append(effect, expiry, actions);
  return row;
}

function render(state: UiState): void {
  const phase = lifecycle(state);
  document.body.dataset.state = phase;
  status.textContent = STATUS_TEXT[phase];

  permissionPanel.hidden = state.automationEnabled;
  if (state.automationEnabled) hide(permissionError);
  automationSetting.hidden = !state.automationEnabled;

  automationDetail.textContent = admissionDetail(phase, state.paused);
  pauseButton.textContent = state.paused ? "Resume agents" : "Pause agents";
  pauseButton.dataset.mode = state.paused ? "resume" : "pause";
  pauseButton.disabled = phase === "your-turn";

  developerChip.hidden = !state.developerMode;
  developerPanel.hidden = !state.developerMode;

  handoffPanel.hidden = state.handoffPrompt === null;
  if (state.handoffPrompt !== null) {
    handoffPrompt.textContent = state.handoffPrompt;
    if (!handoffShown) {
      handoffShown = true;
      handoffPanel.focus();
    }
  } else {
    handoffShown = false;
    hide(handoffError);
  }

  reviews.hidden = state.reviews.length === 0;
  reviewList.replaceChildren(...state.reviews.map(renderReview));
  if (state.reviews.length === 0) hide(reviewError);

  pointerToggle.disabled = state.pointer === null;
  pointerToggle.checked = state.pointer === true;
  pointerDetail.textContent = state.pointer === null
    ? "Unavailable: the runtime did not report a pointer preference."
    : "Show where an agent clicks in a visible tab.";

  taskCount.textContent = String(state.tasks.length);
  if (confirming !== null && !state.tasks.some((task) => task.taskId === confirming)) disarm();
  taskList.replaceChildren(
    ...(state.tasks.length === 0
      ? [emptyRow()]
      : state.tasks.map((task) => renderTask(task, state.developerMode))),
  );
}

function fatal(error: unknown): void {
  current = null;
  document.body.dataset.state = "error";
  status.textContent = STATUS_TEXT.error;
  automationDetail.textContent = "AgentTab could not read its runtime state.";
  show(runtimeError, describe(error));
}

/**
  * Serializes popup actions, keeps a failure visible next to its control, and
  * always re-reads authoritative state afterwards so the UI cannot drift.
  */
async function guard(target: HTMLElement, action: () => Promise<void>): Promise<boolean> {
  if (pending) return false;
  pending = true;
  document.body.dataset.busy = "1";
  hide(target);
  try {
    await action();
  } catch (error) {
    show(target, describe(error));
  }
  try {
    const state = await load();
    current = state;
    render(state);
  } catch (error) {
    fatal(error);
  } finally {
    pending = false;
    delete document.body.dataset.busy;
  }
  return true;
}

function reload(): void {
  if (pending) return;
  void load()
    .then((state) => {
      current = state;
      render(state);
    })
    .catch(fatal);
}

enableButton.addEventListener("click", () => {
  void guard(permissionError, async () => {
    const granted = await chrome.permissions.request({ permissions: ["scripting", "debugger"] });
    if (!granted) {
      throw new Error("Chrome denied AgentTab automation. AgentTab stays installed and disabled until you enable it here.");
    }
  });
});

disableButton.addEventListener("click", () => {
  void guard(settingsError, async () => {
    await chrome.permissions.remove({ permissions: ["scripting", "debugger"] });
    const [scripting, debuggerPermission] = await Promise.all([
      chrome.permissions.contains({ permissions: ["scripting"] }),
      chrome.permissions.contains({ permissions: ["debugger"] }),
    ]);
    if (scripting || debuggerPermission) {
      throw new Error("Chrome kept an automation permission. Disable AgentTab from chrome://extensions, then try again.");
    }
  });
});

pauseButton.addEventListener("click", () => {
  const mode = pauseButton.dataset.mode;
  void guard(runtimeError, async () => {
    if (mode !== "pause" && mode !== "resume") throw new Error("Pause is unavailable right now.");
    await send({ kind: mode });
  });
});

developerOff.addEventListener("click", () => {
  void guard(runtimeError, async () => {
    await send({ kind: "developer_mode", enabled: false });
  });
});

pointerToggle.addEventListener("change", () => {
  const enabled = pointerToggle.checked;
  void guard(settingsError, async () => {
    await send({ kind: "set_pointer", enabled });
  }).then((ran) => {
    if (!ran) pointerToggle.checked = !enabled;
  });
});

handoffCancel.addEventListener("click", () => {
  void guard(handoffError, async () => {
    await send({ kind: "handoff_finish", completed: false });
  });
});

handoffDone.addEventListener("click", () => {
  void guard(handoffError, async () => {
    const result = await send({ kind: "handoff_finish", completed: true });
    if (result.completed !== true) {
      throw new Error(
        typeof result.reason === "string" && result.reason !== ""
          ? result.reason
          : "AgentTab could not confirm that the step finished.",
      );
    }
  });
});

chrome.permissions.onAdded.addListener(reload);
chrome.permissions.onRemoved.addListener(reload);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && STATE_KEY in changes) reload();
});

reload();

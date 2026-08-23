// src/storage.ts
var STATE_KEY = "agenttabStateV1";
var LEGACY_TASKS_KEY = "chromeBridgeTaskSessions";
var LEGACY_PREFERENCES_KEY = "chromeBridgePreferences";
var SCHEMA_VERSION = 1;
var mutationQueue = Promise.resolve();
var initialization = null;
var initializedState = null;
function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    paused: false,
    developerMode: false,
    showAgentPointer: true,
    tasks: {},
    revisions: {},
    handoff: { active: false },
    stagedCommits: {}
  };
}
function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function finiteInteger(value, minimum = 0) {
  return Number.isInteger(value) && Number(value) >= minimum;
}
function jsonEquivalent(left, right) {
  if (Object.is(left, right))
    return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => jsonEquivalent(value, right[index]));
  }
  const leftObject = objectValue(left);
  const rightObject = objectValue(right);
  if (!leftObject || !rightObject)
    return false;
  const leftKeys = Object.keys(leftObject);
  return leftKeys.length === Object.keys(rightObject).length && leftKeys.every((key) => Object.hasOwn(rightObject, key) && jsonEquivalent(leftObject[key], rightObject[key]));
}
var taskColors = ["purple", "cyan", "green", "yellow", "orange", "red", "pink", "blue"];
function parseState(value) {
  const raw = objectValue(value);
  if (!raw || raw.schemaVersion !== SCHEMA_VERSION)
    return null;
  if (typeof raw.paused !== "boolean" || typeof raw.developerMode !== "boolean" || typeof raw.showAgentPointer !== "boolean") {
    return null;
  }
  const tasksValue = objectValue(raw.tasks);
  const revisionsValue = objectValue(raw.revisions);
  const handoffValue = objectValue(raw.handoff);
  const commitsValue = objectValue(raw.stagedCommits);
  if (!tasksValue || !revisionsValue || !handoffValue || !commitsValue)
    return null;
  const tasks = {};
  const assignedTabIds = new Set;
  const assignedGroupIds = new Map;
  for (const [taskId, candidate] of Object.entries(tasksValue)) {
    const task = objectValue(candidate);
    if (!task || task.taskId !== taskId || typeof task.name !== "string" || !(task.groupId === null || finiteInteger(task.groupId)) || !Array.isArray(task.tabIds) || !task.tabIds.every((tabId) => finiteInteger(tabId)) || !taskColors.includes(task.color) || !["working", "needs_user", "completed"].includes(String(task.state)) || !finiteInteger(task.createdAt) || !finiteInteger(task.updatedAt)) {
      return null;
    }
    const tabIds = task.tabIds;
    if (new Set(tabIds).size !== tabIds.length || task.groupId === null && tabIds.length > 0 || tabIds.some((tabId) => assignedTabIds.has(tabId)) || task.groupId !== null && assignedGroupIds.has(task.groupId)) {
      return null;
    }
    for (const tabId of tabIds)
      assignedTabIds.add(tabId);
    if (task.groupId !== null)
      assignedGroupIds.set(task.groupId, taskId);
    tasks[taskId] = task;
  }
  const revisions = {};
  for (const [tabId, candidate] of Object.entries(revisionsValue)) {
    const revision = objectValue(candidate);
    if (!revision || !finiteInteger(revision.floor, 1) || !finiteInteger(revision.current, revision.floor) || revision.documentId !== undefined && typeof revision.documentId !== "string" || revision.loaderId !== undefined && typeof revision.loaderId !== "string") {
      return null;
    }
    revisions[tabId] = revision;
  }
  if (typeof handoffValue.active !== "boolean")
    return null;
  if (handoffValue.active && (typeof handoffValue.taskId !== "string" || !finiteInteger(handoffValue.tabId) || !finiteInteger(handoffValue.expectedRevision, 1) || typeof handoffValue.prompt !== "string" || !objectValue(handoffValue.completion) || !finiteInteger(handoffValue.startedAtMs) || !finiteInteger(handoffValue.timeoutMs, 1) || handoffValue.pendingClearEventId !== undefined && typeof handoffValue.pendingClearEventId !== "string")) {
    return null;
  }
  const stagedCommits = {};
  for (const [token, candidate] of Object.entries(commitsValue)) {
    const commit = objectValue(candidate);
    if (!commit || commit.native_token !== token || token.length < 16 || typeof commit.task_id !== "string" || !finiteInteger(commit.tab_id) || !finiteInteger(commit.page_revision, 1) || typeof commit.effect !== "string" || typeof commit.fingerprint !== "string" || commit.fingerprint.length < 32 || !finiteInteger(commit.expires_at_ms) || !objectValue(commit.action) || !objectValue(commit.preview)) {
      return null;
    }
    stagedCommits[token] = commit;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    paused: raw.paused,
    developerMode: raw.developerMode,
    showAgentPointer: raw.showAgentPointer,
    tasks,
    revisions,
    handoff: handoffValue,
    stagedCommits
  };
}
function legacyTasks(value) {
  if (value === undefined)
    return {};
  const raw = objectValue(value);
  if (!raw)
    throw new Error("Legacy AgentTab task state is malformed");
  const now = Date.now();
  const migrated = {};
  const assignedTabIds = new Set;
  const assignedGroupIds = new Set;
  for (const [taskId, candidate] of Object.entries(raw)) {
    const session = objectValue(candidate);
    if (!session || !Array.isArray(session.tabIds) || !session.tabIds.every((tabId) => finiteInteger(tabId)) || new Set(session.tabIds).size !== session.tabIds.length) {
      throw new Error("Legacy AgentTab task state contains an invalid task");
    }
    const tabIds = session.tabIds;
    const groupId = finiteInteger(session.groupId) ? session.groupId : null;
    if (groupId === null && tabIds.length > 0 || tabIds.some((tabId) => assignedTabIds.has(tabId)) || groupId !== null && assignedGroupIds.has(groupId)) {
      throw new Error("Legacy AgentTab task state has ambiguous ownership");
    }
    for (const tabId of tabIds)
      assignedTabIds.add(tabId);
    if (groupId !== null)
      assignedGroupIds.add(groupId);
    migrated[taskId] = {
      taskId,
      name: typeof session.name === "string" ? session.name : "Imported browser task",
      groupId,
      tabIds,
      color: taskColors.includes(session.color) ? session.color : "purple",
      state: ["working", "needs_user", "completed"].includes(String(session.state)) ? session.state : "working",
      createdAt: finiteInteger(session.createdAt) ? session.createdAt : now,
      updatedAt: finiteInteger(session.updatedAt) ? session.updatedAt : now,
      legacyImported: true
    };
  }
  return migrated;
}
async function removeLegacyState(keys) {
  if (keys.length === 0)
    return;
  await chrome.storage.local.remove(keys);
  const remaining = await chrome.storage.local.get(keys);
  if (keys.some((key) => Object.hasOwn(remaining, key))) {
    throw new Error("AgentTab legacy state cleanup read-back failed");
  }
}
async function loadInitialState() {
  if (!chrome.storage?.local)
    throw new Error("AgentTab requires chrome.storage.local");
  const stored = await chrome.storage.local.get([
    STATE_KEY,
    LEGACY_TASKS_KEY,
    LEGACY_PREFERENCES_KEY
  ]);
  if (Object.hasOwn(stored, STATE_KEY)) {
    const existing = parseState(stored[STATE_KEY]);
    if (!existing)
      throw new Error("Persisted AgentTab state is malformed");
    initializedState = existing;
    await removeLegacyState([LEGACY_TASKS_KEY, LEGACY_PREFERENCES_KEY].filter((key) => Object.hasOwn(stored, key)));
    return structuredClone(existing);
  }
  const next = defaultState();
  next.tasks = legacyTasks(stored[LEGACY_TASKS_KEY]);
  const preferences = objectValue(stored[LEGACY_PREFERENCES_KEY]);
  if (preferences && typeof preferences.showAgentPointer === "boolean") {
    next.showAgentPointer = preferences.showAgentPointer;
  }
  await chrome.storage.local.set({ [STATE_KEY]: next });
  const verified = parseState((await chrome.storage.local.get(STATE_KEY))[STATE_KEY]);
  if (!verified || !jsonEquivalent(verified, next)) {
    throw new Error("AgentTab state migration read-back failed");
  }
  initializedState = verified;
  await removeLegacyState([LEGACY_TASKS_KEY, LEGACY_PREFERENCES_KEY].filter((key) => Object.hasOwn(stored, key)));
  return structuredClone(verified);
}
async function initializeState() {
  if (initializedState)
    return structuredClone(initializedState);
  if (!initialization) {
    initialization = loadInitialState().finally(() => {
      initialization = null;
    });
  }
  return structuredClone(await initialization);
}
async function readState() {
  await mutationQueue;
  return initializeState();
}
function mutateState(mutator) {
  const operation = mutationQueue.then(async () => {
    const state = await initializeState();
    const result = await mutator(state);
    await chrome.storage.local.set({ [STATE_KEY]: state });
    const verified = parseState((await chrome.storage.local.get(STATE_KEY))[STATE_KEY]);
    if (!verified || !jsonEquivalent(verified, state)) {
      throw new Error("AgentTab state persistence read-back failed");
    }
    initializedState = verified;
    return result;
  });
  mutationQueue = operation.then(() => {
    return;
  }, () => {
    return;
  });
  return operation;
}

// src/type-guards.ts
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyKeys(value, required, optional = []) {
  const allowed = {};
  for (const key of required)
    allowed[key] = true;
  for (const key of optional)
    allowed[key] = true;
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed[key]);
}
function isBoundedString(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}
function isIntegerInRange(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

// src/popup.ts
var TASK_COLORS = {
  purple: "#a78bfa",
  cyan: "#78d9ec",
  green: "#81c995",
  yellow: "#fdd663",
  orange: "#fcad70",
  red: "#f28b82",
  pink: "#ff8bcb",
  blue: "#8ab4f8"
};
var TASK_STATES = {
  working: { label: "Working", symbol: "✦" },
  needs_user: { label: "Needs you", symbol: "↗" },
  completed: { label: "Finished", symbol: "✓" }
};
var STATUS_TEXT = {
  disabled: "Setup needed",
  ready: "Ready",
  paused: "Paused",
  "your-turn": "Your turn",
  error: "Unavailable"
};
function element(id, type) {
  const candidate = document.getElementById(id);
  if (!(candidate instanceof type))
    throw new Error(`Missing popup element #${id}`);
  return candidate;
}
var status = element("status", HTMLSpanElement);
var developerChip = element("developer-chip", HTMLSpanElement);
var automationDetail = element("automation-detail", HTMLElement);
var pauseButton = element("pause", HTMLButtonElement);
var runtimeError = element("runtime-error", HTMLParagraphElement);
var permissionPanel = element("permission", HTMLElement);
var enableButton = element("enable", HTMLButtonElement);
var permissionError = element("permission-error", HTMLParagraphElement);
var automationSetting = element("automation-setting", HTMLDivElement);
var disableButton = element("disable", HTMLButtonElement);
var developerPanel = element("developer", HTMLElement);
var developerOff = element("developer-off", HTMLButtonElement);
var handoffPanel = element("handoff", HTMLElement);
var handoffPrompt = element("handoff-prompt", HTMLParagraphElement);
var handoffCancel = element("handoff-cancel", HTMLButtonElement);
var handoffDone = element("handoff-done", HTMLButtonElement);
var handoffError = element("handoff-error", HTMLParagraphElement);
var taskCount = element("task-count", HTMLSpanElement);
var taskList = element("tasks", HTMLUListElement);
var taskError = element("task-error", HTMLParagraphElement);
var pointerToggle = element("pointer", HTMLInputElement);
var pointerDetail = element("pointer-detail", HTMLElement);
var settingsError = element("settings-error", HTMLParagraphElement);
var current = null;
var pending = false;
var handoffShown = false;
var confirming = null;
var confirmEpoch = 0;
function show(target, text) {
  target.textContent = text;
  target.hidden = false;
}
function hide(target) {
  target.textContent = "";
  target.hidden = true;
}
function describe(error) {
  if (error instanceof Error && error.message !== "")
    return error.message;
  const text = String(error);
  return text === "" ? "AgentTab could not complete that action." : text;
}
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!isRecord(response)) {
    throw new Error(`AgentTab's background runtime did not answer "${String(message.kind)}". Reload AgentTab from chrome://extensions, then try again.`);
  }
  return response;
}
function parseTask(value) {
  if (typeof value.task_id !== "string")
    return null;
  const name = typeof value.name === "string" && value.name.trim() !== "" ? value.name : "AgentTab task";
  return {
    taskId: value.task_id,
    name,
    state: typeof value.state === "string" ? value.state : "working",
    tabCount: typeof value.tab_count === "number" ? value.tab_count : 0,
    focusTabId: typeof value.focus_tab_id === "number" ? value.focus_tab_id : ("focus_tab_id" in value) ? null : undefined,
    color: typeof value.color === "string" ? value.color : null
  };
}
async function load() {
  const response = await send({ kind: "get_ui_state" });
  const handoff = isRecord(response.handoff) ? response.handoff : null;
  const prompt = handoff && typeof handoff.prompt === "string" && handoff.prompt.trim() !== "" ? handoff.prompt : "Finish the requested step in the focused tab, then choose I'm done.";
  return {
    automationEnabled: response.automation_enabled === true,
    paused: response.paused === true,
    developerMode: response.developer_mode === true,
    pointer: typeof response.show_agent_pointer === "boolean" ? response.show_agent_pointer : null,
    handoffPrompt: handoff === null ? null : prompt,
    tasks: Array.isArray(response.tasks) ? response.tasks.filter(isRecord).map(parseTask).filter((task) => task !== null) : []
  };
}
function lifecycle(state) {
  if (state.handoffPrompt !== null)
    return "your-turn";
  if (!state.automationEnabled)
    return "disabled";
  return state.paused ? "paused" : "ready";
}
function admissionDetail(phase, paused) {
  if (phase === "your-turn")
    return "Held until you finish or cancel the step above.";
  if (paused)
    return "Queued agent work is refused. Work already dispatched still finishes.";
  if (phase === "disabled")
    return "Agents can open task tabs, but page reads and actions stay blocked.";
  return "Agents can open task tabs and act inside them.";
}
function disarm() {
  confirmEpoch += 1;
  confirming = null;
}
function arm(taskId) {
  const epoch = ++confirmEpoch;
  confirming = taskId;
  setTimeout(() => {
    if (epoch !== confirmEpoch)
      return;
    disarm();
    if (current)
      render(current);
  }, 5000);
  if (current)
    render(current);
}
function emptyRow() {
  const row = document.createElement("li");
  row.className = "empty";
  row.textContent = "No task groups yet. Ask an agent to open a tab and it shows up here.";
  return row;
}
function renderTask(task, developerMode) {
  const row = document.createElement("li");
  row.className = "task";
  const color = task.color === null ? undefined : TASK_COLORS[task.color];
  if (color !== undefined)
    row.style.setProperty("--task-color", color);
  const glyph = TASK_STATES[task.state];
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
  if (task.focusTabId !== null) {
    const focus = document.createElement("button");
    focus.type = "button";
    focus.className = "link";
    focus.textContent = "Focus";
    focus.setAttribute("aria-label", `Focus ${task.name}`);
    focus.addEventListener("click", () => {
      guard(taskError, async () => {
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
  finish.setAttribute("aria-label", armed ? `Confirm finishing ${task.name} and closing its ${task.tabCount === 1 ? "tab" : "tabs"}` : `Finish ${task.name} and close its ${task.tabCount === 1 ? "tab" : "tabs"}`);
  if (armed)
    finish.dataset.confirm = "1";
  finish.addEventListener("click", () => {
    if (confirming !== task.taskId) {
      hide(taskError);
      arm(task.taskId);
      return;
    }
    guard(taskError, async () => {
      await send({ kind: "close_task", task_id: task.taskId });
      disarm();
    });
  });
  row.append(finish);
  return row;
}
function render(state) {
  const phase = lifecycle(state);
  document.body.dataset.state = phase;
  status.textContent = STATUS_TEXT[phase];
  permissionPanel.hidden = state.automationEnabled;
  if (state.automationEnabled)
    hide(permissionError);
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
  pointerToggle.disabled = state.pointer === null;
  pointerToggle.checked = state.pointer === true;
  pointerDetail.textContent = state.pointer === null ? "Unavailable: the runtime did not report a pointer preference." : "Show where an agent clicks in a visible tab.";
  taskCount.textContent = String(state.tasks.length);
  if (confirming !== null && !state.tasks.some((task) => task.taskId === confirming))
    disarm();
  taskList.replaceChildren(...state.tasks.length === 0 ? [emptyRow()] : state.tasks.map((task) => renderTask(task, state.developerMode)));
}
function fatal(error) {
  current = null;
  document.body.dataset.state = "error";
  status.textContent = STATUS_TEXT.error;
  automationDetail.textContent = "AgentTab could not read its runtime state.";
  show(runtimeError, describe(error));
}
async function guard(target, action) {
  if (pending)
    return false;
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
function reload() {
  if (pending)
    return;
  load().then((state) => {
    current = state;
    render(state);
  }).catch(fatal);
}
enableButton.addEventListener("click", () => {
  guard(permissionError, async () => {
    const granted = await chrome.permissions.request({ permissions: ["scripting"] });
    if (!granted) {
      throw new Error("Chrome denied the scripting permission. AgentTab stays installed and disabled until you enable it here.");
    }
  });
});
disableButton.addEventListener("click", () => {
  guard(settingsError, async () => {
    await chrome.permissions.remove({ permissions: ["scripting"] });
    if (await chrome.permissions.contains({ permissions: ["scripting"] })) {
      throw new Error("Chrome kept the scripting permission. Disable AgentTab from chrome://extensions, then try again.");
    }
  });
});
pauseButton.addEventListener("click", () => {
  const mode = pauseButton.dataset.mode;
  guard(runtimeError, async () => {
    if (mode !== "pause" && mode !== "resume")
      throw new Error("Pause is unavailable right now.");
    await send({ kind: mode });
  });
});
developerOff.addEventListener("click", () => {
  guard(runtimeError, async () => {
    await send({ kind: "developer_mode", enabled: false });
  });
});
pointerToggle.addEventListener("change", () => {
  const enabled = pointerToggle.checked;
  guard(settingsError, async () => {
    await send({ kind: "set_pointer", enabled });
  }).then((ran) => {
    if (!ran)
      pointerToggle.checked = !enabled;
  });
});
handoffCancel.addEventListener("click", () => {
  guard(handoffError, async () => {
    await send({ kind: "handoff_finish", completed: false });
  });
});
handoffDone.addEventListener("click", () => {
  guard(handoffError, async () => {
    const result = await send({ kind: "handoff_finish", completed: true });
    if (result.completed !== true) {
      throw new Error(typeof result.reason === "string" && result.reason !== "" ? result.reason : "AgentTab could not confirm that the step finished.");
    }
  });
});
chrome.permissions.onAdded.addListener(reload);
chrome.permissions.onRemoved.addListener(reload);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && STATE_KEY in changes)
    reload();
});
reload();

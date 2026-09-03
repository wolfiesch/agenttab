import type { StagedCommit } from "./protocol";

export const STATE_KEY = "agenttabStateV1";
const LEGACY_TASKS_KEY = "chromeBridgeTaskSessions";
const LEGACY_PREFERENCES_KEY = "chromeBridgePreferences";
const SCHEMA_VERSION = 1;

export type TaskState = "working" | "needs_user" | "completed";

export type TaskColor = "purple" | "cyan" | "green" | "yellow" | "orange" | "red" | "pink" | "blue";

export type CleanupPolicy = "automatic" | "ask" | "keep";

export interface TaskRecord {
  taskId: string;
  name: string;
  groupId: number | null;
  tabIds: number[];
  createdTabIds: number[];
  color: TaskColor;
  state: TaskState;
  createdAt: number;
  updatedAt: number;
  legacyImported?: boolean;
}

export interface RevisionRecord {
  floor: number;
  current: number;
  documentId?: string;
  loaderId?: string;
}

export type HandoffRecord =
  | { active: false }
  | {
    active: true;
    taskId: string;
    tabId: number;
    expectedRevision: number;
    prompt: string;
    completion: Record<string, unknown>;
    startedAtMs: number;
    timeoutMs: number;
    pendingClearEventId?: string;
  };

export interface AutomationCleanupRecord {
  pending: boolean;
  tabIds: number[];
  generation: number;
  epoch: number;
}

export interface ExtensionState {
  schemaVersion: typeof SCHEMA_VERSION;
  paused: boolean;
  developerMode: boolean;
  skipCommitReview: boolean;
  showAgentPointer: boolean;
  cleanupPolicy: CleanupPolicy;
  tasks: Record<string, TaskRecord>;
  revisions: Record<string, RevisionRecord>;
  handoff: HandoffRecord;
  stagedCommits: Record<string, StagedCommit>;
  automationCleanup: AutomationCleanupRecord;
}

let mutationQueue: Promise<unknown> = Promise.resolve();
let initialization: Promise<ExtensionState> | null = null;
let initializedState: ExtensionState | null = null;

function defaultState(): ExtensionState {
  return {
    schemaVersion: SCHEMA_VERSION,
    paused: false,
    developerMode: false,
    skipCommitReview: true,
    showAgentPointer: true,
    cleanupPolicy: "automatic",
    tasks: {},
    revisions: {},
    handoff: { active: false },
    stagedCommits: {},
    automationCleanup: {
      pending: false,
      tabIds: [],
      generation: 0,
      epoch: 0,
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteInteger(value: unknown, minimum = 0): value is number {
  return Number.isInteger(value) && Number(value) >= minimum;
}

function jsonEquivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEquivalent(value, right[index]))
    );
  }
  const leftObject = objectValue(left);
  const rightObject = objectValue(right);
  if (!leftObject || !rightObject) return false;
  const leftKeys = Object.keys(leftObject);
  return (
    leftKeys.length === Object.keys(rightObject).length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightObject, key) && jsonEquivalent(leftObject[key], rightObject[key]),
    )
  );
}
const taskColors: readonly TaskColor[] = ["purple", "cyan", "green", "yellow", "orange", "red", "pink", "blue"];

function parseState(value: unknown): ExtensionState | null {
  const raw = objectValue(value);
  if (!raw || raw.schemaVersion !== SCHEMA_VERSION) return null;
  if (
    typeof raw.paused !== "boolean" ||
    typeof raw.developerMode !== "boolean" ||
    typeof raw.showAgentPointer !== "boolean"
  ) {
    return null;
  }
  const tasksValue = objectValue(raw.tasks);
  const revisionsValue = objectValue(raw.revisions);
  const handoffValue = objectValue(raw.handoff);
  const commitsValue = objectValue(raw.stagedCommits);
  const cleanupValue = raw.automationCleanup === undefined
    ? {
      pending: false,
      tabIds: [],
      generation: 0,
      epoch: 0,
    }
    : objectValue(raw.automationCleanup);
  if (!tasksValue || !revisionsValue || !handoffValue || !commitsValue || !cleanupValue) return null;
  if (
    typeof cleanupValue.pending !== "boolean" ||
    !Array.isArray(cleanupValue.tabIds) ||
    !cleanupValue.tabIds.every((tabId) => finiteInteger(tabId)) ||
    new Set(cleanupValue.tabIds).size !== cleanupValue.tabIds.length ||
    !finiteInteger(cleanupValue.generation) ||
    !finiteInteger(cleanupValue.epoch)
  ) {
    return null;
  }

  const tasks: Record<string, TaskRecord> = {};
  const assignedTabIds = new Set<number>();
  const assignedGroupIds = new Map<number, string>();
  for (const [taskId, candidate] of Object.entries(tasksValue)) {
    const task = objectValue(candidate);
    if (
      !task ||
      task.taskId !== taskId ||
      typeof task.name !== "string" ||
      !(task.groupId === null || finiteInteger(task.groupId)) ||
      !Array.isArray(task.tabIds) ||
      !task.tabIds.every((tabId) => finiteInteger(tabId)) ||
      !(task.createdTabIds === undefined || (
        Array.isArray(task.createdTabIds) &&
        task.createdTabIds.every((tabId) => finiteInteger(tabId))
      )) ||
      !taskColors.includes(task.color as TaskColor) ||
      !["working", "needs_user", "completed"].includes(String(task.state)) ||
      !finiteInteger(task.createdAt) ||
      !finiteInteger(task.updatedAt)
    ) {
      return null;
    }
    const tabIds = task.tabIds as number[];
    // Legacy builds tracked task-created tabs for cleanup even after the tab left the task,
    // so persisted createdTabIds may reference tabs that are no longer members. Sanitize to
    // the current subset invariant instead of rejecting the whole persisted state, which
    // would brick startup on data written by an older build.
    const createdTabIds = [...new Set((task.createdTabIds ?? []) as number[])]
      .filter((tabId) => tabIds.includes(tabId));
    if (
      new Set(tabIds).size !== tabIds.length ||
      (task.groupId === null && tabIds.length > 0) ||
      tabIds.some((tabId) => assignedTabIds.has(tabId)) ||
      (task.groupId !== null && assignedGroupIds.has(task.groupId as number))
    ) {
      return null;
    }
    for (const tabId of tabIds) assignedTabIds.add(tabId);
    if (task.groupId !== null) assignedGroupIds.set(task.groupId as number, taskId);
    tasks[taskId] = {
      ...(task as unknown as TaskRecord),
      createdTabIds,
    };
  }

  const revisions: Record<string, RevisionRecord> = {};
  for (const [tabId, candidate] of Object.entries(revisionsValue)) {
    const revision = objectValue(candidate);
    if (
      !revision ||
      !finiteInteger(revision.floor, 1) ||
      !finiteInteger(revision.current, revision.floor as number) ||
      (revision.documentId !== undefined && typeof revision.documentId !== "string") ||
      (revision.loaderId !== undefined && typeof revision.loaderId !== "string")
    ) {
      return null;
    }
    revisions[tabId] = revision as unknown as RevisionRecord;
  }

  if (typeof handoffValue.active !== "boolean") return null;
  if (
    handoffValue.active &&
    (typeof handoffValue.taskId !== "string" ||
      !finiteInteger(handoffValue.tabId) ||
      !finiteInteger(handoffValue.expectedRevision, 1) ||
      typeof handoffValue.prompt !== "string" ||
      !objectValue(handoffValue.completion) ||
      !finiteInteger(handoffValue.startedAtMs) ||
      !finiteInteger(handoffValue.timeoutMs, 1) ||
      (handoffValue.pendingClearEventId !== undefined &&
        typeof handoffValue.pendingClearEventId !== "string"))
  ) {
    return null;
  }

  const stagedCommits: Record<string, StagedCommit> = {};
  for (const [token, candidate] of Object.entries(commitsValue)) {
    const commit = objectValue(candidate);
    const dialog =
      commit?.dialog === undefined ? undefined : objectValue(commit.dialog);
    if (
      !commit ||
      commit.native_token !== token ||
      token.length < 16 ||
      typeof commit.task_id !== "string" ||
      !finiteInteger(commit.tab_id) ||
      !finiteInteger(commit.page_revision, 1) ||
      typeof commit.effect !== "string" ||
      typeof commit.fingerprint !== "string" ||
      commit.fingerprint.length < 32 ||
      !finiteInteger(commit.expires_at_ms) ||
      (commit.review_handle !== undefined &&
        (typeof commit.review_handle !== "string" ||
          commit.review_handle.length < 16 ||
          commit.review_handle.length > 256)) ||
      (commit.approved !== undefined && typeof commit.approved !== "boolean") ||
      (commit.dialog !== undefined &&
        (!dialog ||
          !finiteInteger(dialog.generation, 1) ||
          typeof dialog.fingerprint !== "string" ||
          dialog.fingerprint.length < 32)) ||
      !objectValue(commit.action) ||
      !objectValue(commit.preview)
    ) {
      return null;
    }
    stagedCommits[token] = commit as unknown as StagedCommit;
  }

  const cleanupPolicy = raw.cleanupPolicy ?? "automatic";
  if (!["automatic", "ask", "keep"].includes(String(cleanupPolicy))) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    paused: raw.paused,
    developerMode: raw.developerMode,
    skipCommitReview: raw.skipCommitReview !== false,
    showAgentPointer: raw.showAgentPointer,
    cleanupPolicy: cleanupPolicy as CleanupPolicy,
    tasks,
    revisions,
    handoff: handoffValue as unknown as HandoffRecord,
    stagedCommits,
    automationCleanup: cleanupValue as unknown as AutomationCleanupRecord,
  };
}

function legacyTasks(value: unknown): Record<string, TaskRecord> {
  if (value === undefined) return {};
  const raw = objectValue(value);
  if (!raw) throw new Error("Legacy AgentTab task state is malformed");
  const now = Date.now();
  const migrated: Record<string, TaskRecord> = {};
  const assignedTabIds = new Set<number>();
  const assignedGroupIds = new Set<number>();
  for (const [taskId, candidate] of Object.entries(raw)) {
    const session = objectValue(candidate);
    if (
      !session ||
      !Array.isArray(session.tabIds) ||
      !session.tabIds.every((tabId) => finiteInteger(tabId)) ||
      new Set(session.tabIds as number[]).size !== session.tabIds.length
    ) {
      throw new Error("Legacy AgentTab task state contains an invalid task");
    }
    const tabIds = session.tabIds as number[];
    const groupId = finiteInteger(session.groupId) ? session.groupId : null;
    if (
      (groupId === null && tabIds.length > 0) ||
      tabIds.some((tabId) => assignedTabIds.has(tabId)) ||
      (groupId !== null && assignedGroupIds.has(groupId))
    ) {
      throw new Error("Legacy AgentTab task state has ambiguous ownership");
    }
    for (const tabId of tabIds) assignedTabIds.add(tabId);
    if (groupId !== null) assignedGroupIds.add(groupId);
    migrated[taskId] = {
      taskId,
      name: typeof session.name === "string" ? session.name : "Imported browser task",
      groupId,
      tabIds,
      createdTabIds: [],
      color: taskColors.includes(session.color as TaskColor) ? (session.color as TaskColor) : "purple",
      state: ["working", "needs_user", "completed"].includes(String(session.state))
        ? (session.state as TaskState)
        : "working",
      createdAt: finiteInteger(session.createdAt) ? session.createdAt : now,
      updatedAt: finiteInteger(session.updatedAt) ? session.updatedAt : now,
      legacyImported: true,
    };
  }
  return migrated;
}

async function removeLegacyState(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await chrome.storage.local.remove(keys);
  const remaining = await chrome.storage.local.get(keys);
  if (keys.some((key) => Object.hasOwn(remaining, key))) {
    throw new Error("AgentTab legacy state cleanup read-back failed");
  }
}

async function loadInitialState(): Promise<ExtensionState> {
  if (!chrome.storage?.local) throw new Error("AgentTab requires chrome.storage.local");
  const stored = await chrome.storage.local.get([
    STATE_KEY,
    LEGACY_TASKS_KEY,
    LEGACY_PREFERENCES_KEY,
  ]);
  if (Object.hasOwn(stored, STATE_KEY)) {
    const existing = parseState(stored[STATE_KEY]);
    if (!existing) throw new Error("Persisted AgentTab state is malformed");
    initializedState = existing;
    await removeLegacyState(
      [LEGACY_TASKS_KEY, LEGACY_PREFERENCES_KEY].filter((key) => Object.hasOwn(stored, key)),
    );
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
  await removeLegacyState(
    [LEGACY_TASKS_KEY, LEGACY_PREFERENCES_KEY].filter((key) => Object.hasOwn(stored, key)),
  );
  return structuredClone(verified);
}

async function initializeState(): Promise<ExtensionState> {
  if (initializedState) return structuredClone(initializedState);
  if (!initialization) {
    initialization = loadInitialState().finally(() => {
      initialization = null;
    });
  }
  return structuredClone(await initialization);
}

export async function readState(): Promise<ExtensionState> {
  await mutationQueue;
  return initializeState();
}

export function mutateState<T>(
  mutator: (state: ExtensionState) => T | Promise<T>,
): Promise<T> {
  const operation = mutationQueue.then(async () => {
    const state = await initializeState();
    // initializeState returns a clone, so the cached value remains a stable
    // baseline while the mutator works without another whole-state clone.
    const before = initializedState;
    const result = await mutator(state);
    if (before && jsonEquivalent(before, state)) return result;
    // Keep the cache isolated from objects retained by the mutator/caller,
    // matching Chrome storage's structured-clone boundary without a readback.
    const persisted = structuredClone(state);
    const verified = parseState(persisted);
    if (!verified || !jsonEquivalent(verified, state)) {
      throw new Error("AgentTab state mutation produced malformed state");
    }
    await chrome.storage.local.set({ [STATE_KEY]: state });
    initializedState = verified;
    return result;
  });
  mutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export function resetStateForTest(): void {
  initialization = null;
  initializedState = null;
  mutationQueue = Promise.resolve();
}

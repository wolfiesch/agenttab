
export interface TargetBinding {
  /**
   * Debugger backend node id, or the page agent's element id when `route` is
   * `"scripting"`. Scripting refs bind to Chrome's `documentId`.
   */
  backendNodeId: number;
  documentId: string;
  frameId: string;
  pageRevision: number;
  taskId: string;
  tabId: number;
  route?: "scripting";
}

export interface ResolvedTarget extends TargetBinding {
  sessionId?: string;
  contextId?: number;
}

/** The subset of `chrome.storage.StorageArea` the registry uses. */
export interface TargetRefStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

const REF_PREFIX = "rt1.";
const MAX_TARGET_REFS = 32_768;
const MAX_TARGET_REFS_PER_TAB = 8_192;
const INDEX_KEY = "agenttab.targetRefs";
const tabKey = (tabId: number): string => `${INDEX_KEY}.${tabId}`;

/** A stored ref row: id after the prefix, node, document, frame, revision, task, scripting route. */
type StoredRef = [string, number, number, number, number, number, 0 | 1];

/** One tab's refs in mint order, with repeated strings stored once. */
interface StoredTabRefs {
  documents: string[];
  frames: string[];
  tasks: string[];
  refs: StoredRef[];
}

/**
 * Maps opaque snapshot refs to the targets they were minted for. Refs are kept
 * in memory and mirrored to storage, so they outlive a service worker restart
 * or an extension reload; a binding still has to match the live document
 * before it resolves.
 */
export class TargetRefRegistry {
  readonly #refs = new Map<string, TargetBinding>();
  readonly #refsByTab = new Map<number, Set<string>>();
  readonly #dirtyTabs = new Set<number>();
  #loaded: Promise<void> | undefined;
  #writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: () => TargetRefStorage,
    private readonly liveTabIds: () => Promise<ReadonlySet<number>>,
  ) {}

  mint(binding: TargetBinding): string {
    // A newer page revision makes the tab's older refs unusable.
    for (const ref of this.#refsByTab.get(binding.tabId) ?? []) {
      if ((this.#refs.get(ref)?.pageRevision ?? binding.pageRevision) < binding.pageRevision) this.#remove(ref);
    }
    let ref = `${REF_PREFIX}${crypto.randomUUID()}`;
    while (this.#refs.has(ref)) ref = `${REF_PREFIX}${crypto.randomUUID()}`;
    this.#add(ref, binding);
    return ref;
  }

  /** Returns the binding a ref was minted for, or `null` for a ref this browser session never minted. */
  async lookup(ref: unknown): Promise<TargetBinding | null> {
    if (typeof ref !== "string" || !ref.startsWith(REF_PREFIX)) return null;
    const known = this.#refs.get(ref);
    if (known !== undefined) return known;
    await this.#load();
    return this.#refs.get(ref) ?? null;
  }

  /** Writes refs minted or removed since the last write. Call before handing refs out. */
  persist(): Promise<void> {
    const write = this.#writes.then(async () => {
      await this.#load();
      if (this.#dirtyTabs.size === 0) return;
      const tabIds = [...this.#dirtyTabs];
      this.#dirtyTabs.clear();
      const items: Record<string, unknown> = { [INDEX_KEY]: [...this.#refsByTab.keys()] };
      const removed: string[] = [];
      for (const tabId of tabIds) {
        const tabRefs = this.#refsByTab.get(tabId);
        if (tabRefs === undefined) removed.push(tabKey(tabId));
        else items[tabKey(tabId)] = this.#encode(tabRefs);
      }
      try {
        await this.storage().set(items);
        if (removed.length > 0) await this.storage().remove(removed);
      } catch (error) {
        for (const tabId of tabIds) this.#dirtyTabs.add(tabId);
        throw error;
      }
    });
    this.#writes = write.catch(() => undefined);
    return write;
  }

  /** Drops a closed tab's refs. */
  async forgetTab(tabId: number): Promise<void> {
    await this.#load();
    const tabRefs = this.#refsByTab.get(tabId);
    if (tabRefs === undefined && !this.#dirtyTabs.has(tabId)) return;
    for (const ref of tabRefs ?? []) this.#remove(ref);
    await this.persist();
  }

  /** Drops every ref, for a browser start where earlier tab ids no longer mean anything. */
  clear(): Promise<void> {
    const cleared = this.#writes.then(async () => {
      await this.#loaded?.catch(() => undefined);
      const index = (await this.storage().get([INDEX_KEY]))[INDEX_KEY];
      const tabIds = Array.isArray(index) ? index.filter(Number.isSafeInteger) : [];
      await this.storage().remove([INDEX_KEY, ...tabIds.map(tabKey)]);
      this.#refs.clear();
      this.#refsByTab.clear();
      this.#dirtyTabs.clear();
      this.#loaded = Promise.resolve();
    });
    this.#writes = cleared.catch(() => undefined);
    return cleared;
  }

  #load(): Promise<void> {
    this.#loaded ??= (async () => {
      const storage = this.storage();
      const index = (await storage.get([INDEX_KEY]))[INDEX_KEY];
      const tabIds = Array.isArray(index) ? index.filter(Number.isSafeInteger) : [];
      if (tabIds.length === 0) return;
      const [stored, live] = await Promise.all([storage.get(tabIds.map(tabKey)), this.liveTabIds()]);
      // Refs minted in this worker before the load are the newest, so they go last.
      const minted = [...this.#refs];
      this.#refs.clear();
      this.#refsByTab.clear();
      const dirty = new Set(this.#dirtyTabs);
      for (const tabId of tabIds) {
        // Tabs closed while no worker was listening.
        if (!live.has(tabId)) {
          dirty.add(tabId);
          continue;
        }
        for (const [ref, binding] of decodeTabRefs(tabId, stored[tabKey(tabId)])) this.#add(ref, binding);
      }
      // Loaded tabs match storage already; only earlier changes and closed tabs need a write.
      this.#dirtyTabs.clear();
      for (const tabId of dirty) this.#dirtyTabs.add(tabId);
      for (const [ref, binding] of minted) this.#add(ref, binding);
      // Refs minted here for a newer page revision supersede the stored ones.
      for (const tabRefs of [...this.#refsByTab.values()]) {
        const bindings = [...tabRefs].map((ref) => [ref, this.#refs.get(ref)] as const);
        const latest = Math.max(...bindings.map(([, binding]) => binding?.pageRevision ?? 0));
        for (const [ref, binding] of bindings) if ((binding?.pageRevision ?? latest) < latest) this.#remove(ref);
      }
    })().catch((error: unknown) => {
      this.#loaded = undefined;
      throw error;
    });
    return this.#loaded;
  }

  #add(ref: string, binding: TargetBinding): void {
    const tabRefs = this.#refsByTab.get(binding.tabId) ?? new Set<string>();
    while (tabRefs.size >= MAX_TARGET_REFS_PER_TAB) {
      const oldest = tabRefs.values().next().value;
      if (typeof oldest !== "string") break;
      this.#remove(oldest);
    }
    while (this.#refs.size >= MAX_TARGET_REFS) {
      const oldest = this.#refs.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#remove(oldest);
    }
    this.#refs.set(ref, binding);
    tabRefs.add(ref);
    this.#refsByTab.set(binding.tabId, tabRefs);
    this.#dirtyTabs.add(binding.tabId);
  }

  #remove(ref: string): void {
    const binding = this.#refs.get(ref);
    if (!binding) return;
    this.#refs.delete(ref);
    this.#dirtyTabs.add(binding.tabId);
    const tabRefs = this.#refsByTab.get(binding.tabId);
    if (!tabRefs) return;
    tabRefs.delete(ref);
    if (tabRefs.size === 0) this.#refsByTab.delete(binding.tabId);
  }

  #encode(tabRefs: ReadonlySet<string>): StoredTabRefs {
    const tables = { documents: new Map<string, number>(), frames: new Map<string, number>(), tasks: new Map<string, number>() };
    const intern = (table: Map<string, number>, value: string): number => {
      let index = table.get(value);
      if (index === undefined) table.set(value, index = table.size);
      return index;
    };
    const refs: StoredRef[] = [];
    for (const ref of tabRefs) {
      const binding = this.#refs.get(ref);
      if (binding === undefined) continue;
      refs.push([
        ref.slice(REF_PREFIX.length),
        binding.backendNodeId,
        intern(tables.documents, binding.documentId),
        intern(tables.frames, binding.frameId),
        binding.pageRevision,
        intern(tables.tasks, binding.taskId),
        binding.route === "scripting" ? 1 : 0,
      ]);
    }
    return {
      documents: [...tables.documents.keys()],
      frames: [...tables.frames.keys()],
      tasks: [...tables.tasks.keys()],
      refs,
    };
  }
}

function decodeTabRefs(tabId: number, value: unknown): Array<[string, TargetBinding]> {
  if (typeof value !== "object" || value === null) return [];
  const { documents, frames, tasks, refs } = value as Partial<StoredTabRefs>;
  if (!isStringArray(documents) || !isStringArray(frames) || !isStringArray(tasks) || !Array.isArray(refs)) return [];
  const decoded: Array<[string, TargetBinding]> = [];
  for (const row of refs as unknown[]) {
    if (!Array.isArray(row) || row.length !== 7) continue;
    const [id, backendNodeId, document, frame, pageRevision, task, scripting] = row as unknown[];
    const documentId = typeof document === "number" ? documents[document] : undefined;
    const frameId = typeof frame === "number" ? frames[frame] : undefined;
    const taskId = typeof task === "number" ? tasks[task] : undefined;
    if (
      typeof id !== "string" || !Number.isSafeInteger(backendNodeId) || !Number.isSafeInteger(pageRevision) ||
      documentId === undefined || frameId === undefined || taskId === undefined || (scripting !== 0 && scripting !== 1)
    ) {
      continue;
    }
    decoded.push([`${REF_PREFIX}${id}`, {
      backendNodeId: backendNodeId as number,
      documentId,
      frameId,
      pageRevision: pageRevision as number,
      taskId,
      tabId,
      ...(scripting === 1 ? { route: "scripting" as const } : {}),
    }]);
  }
  return decoded;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export const targetRefs = new TargetRefRegistry(
  () => chrome.storage.local,
  async () => new Set((await chrome.tabs.query({})).flatMap((tab) => tab.id === undefined ? [] : [tab.id])),
);

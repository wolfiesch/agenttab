
export interface TargetBinding {
  backendNodeId: number;
  documentId: string;
  frameId: string;
  pageRevision: number;
  taskId: string;
  tabId: number;
}

export interface ResolvedTarget extends TargetBinding {
  sessionId?: string;
  contextId?: number;
}

const REF_PREFIX = "rt1.";
const MAX_TARGET_REFS = 32_768;
const MAX_TARGET_REFS_PER_TAB = 8_192;
const refs = new Map<string, TargetBinding>();
const refsByTab = new Map<number, Set<string>>();

function removeTargetRef(ref: string): void {
  const binding = refs.get(ref);
  if (!binding) return;
  refs.delete(ref);
  const tabRefs = refsByTab.get(binding.tabId);
  if (!tabRefs) return;
  tabRefs.delete(ref);
  if (tabRefs.size === 0) refsByTab.delete(binding.tabId);
}

export function mintTargetRef(binding: TargetBinding): string {
  const tabRefs = refsByTab.get(binding.tabId) ?? new Set<string>();
  refsByTab.set(binding.tabId, tabRefs);
  while (tabRefs.size >= MAX_TARGET_REFS_PER_TAB) {
    const oldest = tabRefs.values().next().value;
    if (typeof oldest !== "string") break;
    removeTargetRef(oldest);
  }
  while (refs.size >= MAX_TARGET_REFS) {
    const oldest = refs.keys().next().value;
    if (typeof oldest !== "string") break;
    removeTargetRef(oldest);
  }
  let ref = `${REF_PREFIX}${crypto.randomUUID()}`;
  while (refs.has(ref)) ref = `${REF_PREFIX}${crypto.randomUUID()}`;
  refs.set(ref, binding);
  tabRefs.add(ref);
  return ref;
}

export function parseTargetRef(ref: unknown): TargetBinding | null {
  if (typeof ref !== "string" || !ref.startsWith(REF_PREFIX)) return null;
  return refs.get(ref) ?? null;
}

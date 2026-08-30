import { mutateState, readState } from "./storage";

type RevisionChangeListener = (tabId: number, pageRevision: number) => void | Promise<void>;

export class RevisionTracker {
  private readonly changeListeners = new Set<RevisionChangeListener>();

  onChange(listener: RevisionChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  async ensure(tabId: number): Promise<number> {
    return mutateState((state) => {
      const key = String(tabId);
      const existing = state.revisions[key];
      if (existing) return existing.current;
      state.revisions[key] = { floor: 1, current: 1 };
      return 1;
    });
  }

  async current(tabId: number): Promise<number> {
    const current = (await readState()).revisions[String(tabId)]?.current;
    return current ?? this.ensure(tabId);
  }

  async markNavigation(tabId: number): Promise<number> {
    const pageRevision = await mutateState((state) => {
      const key = String(tabId);
      const existing = state.revisions[key];
      const next = Math.max((existing?.current ?? 0) + 1, (existing?.floor ?? 0) + 1, 1);
      state.revisions[key] = { floor: next, current: next };
      return next;
    });
    await this.publishChange(tabId, pageRevision);
    return pageRevision;
  }

  async observeDocument(
    tabId: number,
    documentId: string | undefined,
    loaderId: string | undefined,
  ): Promise<number> {
    const observed = await mutateState((state) => {
      const key = String(tabId);
      const existing = state.revisions[key];
      if (!existing) {
        state.revisions[key] = {
          floor: 1,
          current: 1,
          ...(documentId !== undefined ? { documentId } : {}),
          ...(loaderId !== undefined ? { loaderId } : {}),
        };
        return { pageRevision: 1, changed: false };
      }
      const changed =
        (documentId !== undefined && existing.documentId !== undefined && documentId !== existing.documentId) ||
        (loaderId !== undefined && existing.loaderId !== undefined && loaderId !== existing.loaderId);
      const pageRevision = changed
        ? Math.max(existing.current + 1, existing.floor + 1)
        : existing.current;
      state.revisions[key] = {
        floor: Math.max(existing.floor, pageRevision),
        current: pageRevision,
        ...(documentId !== undefined
          ? { documentId }
          : existing.documentId !== undefined ? { documentId: existing.documentId } : {}),
        ...(loaderId !== undefined
          ? { loaderId }
          : existing.loaderId !== undefined ? { loaderId: existing.loaderId } : {}),
      };
      return { pageRevision, changed };
    });
    if (observed.changed) await this.publishChange(tabId, observed.pageRevision);
    return observed.pageRevision;
  }

  async assertExpected(tabId: number, expected: unknown): Promise<number> {
    if (!Number.isInteger(expected) || Number(expected) < 0) {
      throw Object.assign(new Error("expected_page_revision must be a non-negative integer"), {
        code: "invalid_request",
      });
    }
    const current = await this.current(tabId);
    if (current !== expected) {
      throw Object.assign(
        new Error(`Page revision changed from ${String(expected)} to ${current}`),
        { code: "stale_revision", currentPageRevision: current },
      );
    }
    return current;
  }

  async remove(tabId: number): Promise<void> {
    const pageRevision = await mutateState((state) => {
      const key = String(tabId);
      const existing = state.revisions[key];
      const next = Math.max((existing?.current ?? 0) + 1, (existing?.floor ?? 0) + 1, 1);
      state.revisions[key] = { floor: next, current: next };
      return next;
    });
    await this.publishChange(tabId, pageRevision);
  }

  private async publishChange(tabId: number, pageRevision: number): Promise<void> {
    for (const listener of this.changeListeners) {
      await listener(tabId, pageRevision);
    }
  }
}

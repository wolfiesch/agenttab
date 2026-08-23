import { mutateState, readState } from "./storage";

export class RevisionTracker {
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
    return mutateState((state) => {
      const key = String(tabId);
      const existing = state.revisions[key];
      const next = Math.max((existing?.current ?? 0) + 1, (existing?.floor ?? 0) + 1, 1);
      state.revisions[key] = { floor: next, current: next };
      return next;
    });
  }

  async observeDocument(
    tabId: number,
    documentId: string | undefined,
    loaderId: string | undefined,
  ): Promise<number> {
    return mutateState((state) => {
      const key = String(tabId);
      const existing = state.revisions[key];
      if (!existing) {
        state.revisions[key] = {
          floor: 1,
          current: 1,
          ...(documentId !== undefined ? { documentId } : {}),
          ...(loaderId !== undefined ? { loaderId } : {}),
        };
        return 1;
      }
      const changed =
        (documentId !== undefined && existing.documentId !== undefined && documentId !== existing.documentId) ||
        (loaderId !== undefined && existing.loaderId !== undefined && loaderId !== existing.loaderId);
      const current = changed
        ? Math.max(existing.current + 1, existing.floor + 1)
        : existing.current;
      state.revisions[key] = {
        floor: Math.max(existing.floor, current),
        current,
        ...(documentId !== undefined
          ? { documentId }
          : existing.documentId !== undefined ? { documentId: existing.documentId } : {}),
        ...(loaderId !== undefined
          ? { loaderId }
          : existing.loaderId !== undefined ? { loaderId: existing.loaderId } : {}),
      };
      return current;
    });
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
    await mutateState((state) => {
      const key = String(tabId);
      const existing = state.revisions[key];
      const next = Math.max((existing?.current ?? 0) + 1, (existing?.floor ?? 0) + 1, 1);
      state.revisions[key] = { floor: next, current: next };
    });
  }
}

import { settledWithin } from "./bounded";

/**
 * How long AgentTab waits for Chrome to close tabs it removes. `chrome.tabs.remove` settles only
 * once Chrome destroys the tab, and a page's beforeunload "Leave site?" prompt postpones that
 * until someone answers it; a background tab shows the prompt only when it is activated. Removal
 * stays requested after the wait, so the tab still closes if the user confirms leaving.
 */
export const TAB_REMOVAL_WAIT_MS = 2_000;

export type TabRemoval =
  | { tabId: number; state: "closed" }
  | { tabId: number; state: "pending" }
  | { tabId: number; state: "failed"; error: unknown };

/** Requests every removal at once and reports each tab's state when they settle or the wait ends. */
export async function removeTabs(tabIds: readonly number[]): Promise<TabRemoval[]> {
  const removals: TabRemoval[] = tabIds.map((tabId) => ({ tabId, state: "pending" }));
  await settledWithin(
    Promise.all(tabIds.map((tabId, index) => chrome.tabs.remove(tabId).then(
      () => {
        removals[index] = { tabId, state: "closed" };
      },
      (error: unknown) => {
        removals[index] = { tabId, state: "failed", error };
      },
    ))),
    TAB_REMOVAL_WAIT_MS,
  );
  return [...removals];
}

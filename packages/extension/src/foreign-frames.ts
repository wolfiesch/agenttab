/**
 * Page-side function, injected with `chrome.scripting.executeScript` into every frame of a task-owned
 * tab. It removes iframes that another extension embedded in the page, such as a password manager's
 * inline autofill menu, and returns how many it removed.
 *
 * Chrome refuses `chrome.debugger.attach` for any tab holding another extension's frame, and detaches a
 * session already attached as soon as such a frame appears ("Cannot access a chrome-extension:// URL of
 * different extension"). Without the debugger, AgentTab loses trusted input, so a site that ignores
 * synthetic clicks cannot be submitted. Removing the overlay frame lets the attach succeed; the other
 * extension re-creates its overlay the next time it needs one.
 *
 * Password managers mount these frames inside closed shadow roots, which only `chrome.dom` can open.
 * The function must stay self-contained: Chrome serializes it into the page.
 */
export function removeForeignExtensionFrames(ownOrigin: string): number {
  // Content scripts get `chrome.dom`; the open `shadowRoot` is the fallback where it is missing.
  const dom = typeof chrome === "undefined" ? undefined : chrome.dom;
  const openRoot = (element: Element): ShadowRoot | null =>
    typeof dom?.openOrClosedShadowRoot === "function" && element instanceof HTMLElement
      ? dom.openOrClosedShadowRoot(element)
      : element.shadowRoot;
  let removed = 0;
  const visit = (root: Document | ShadowRoot): void => {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement) {
        const source = element.src;
        if (source.startsWith("chrome-extension://") && !source.startsWith(`${ownOrigin}/`)) {
          element.remove();
          removed += 1;
          continue;
        }
      }
      const shadow = openRoot(element);
      if (shadow !== null) visit(shadow);
    }
  };
  visit(document);
  return removed;
}

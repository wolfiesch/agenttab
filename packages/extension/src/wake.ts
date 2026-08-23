void (async () => {
  const reloadRequested = new URLSearchParams(window.location.search).get("reload") === "1";
  if (reloadRequested) {
    // Remove the trigger before reloading so a document Chrome preserves cannot loop.
    window.history.replaceState(null, "", window.location.pathname);
    chrome.runtime.reload();
    return;
  }
  // No receiver is expected while the service worker is still starting; the wake
  // tab must still disappear rather than leave an unhandled rejection behind.
  await chrome.runtime.sendMessage({ kind: "wake" }).catch(() => undefined);
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id === undefined) window.close();
    else await chrome.tabs.remove(tab.id);
  } catch {
    window.close();
  }
})();

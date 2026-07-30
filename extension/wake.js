(async () => {
  const reloadRequested = new URLSearchParams(window.location.search).get("reload") === "1";
  if (reloadRequested) {
    // Remove the trigger before the extension reload invalidates this page, so
    // any document Chrome preserves or reloads cannot enter a reload loop.
    window.history.replaceState(null, "", window.location.pathname);
    chrome.runtime.reload();
    return;
  }
  try {
    await chrome.runtime.sendMessage({ action: "wakeNativeHost" });
  } finally {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab && tab.id !== undefined) await chrome.tabs.remove(tab.id);
    } catch (error) {
      window.close();
    }
  }
})();

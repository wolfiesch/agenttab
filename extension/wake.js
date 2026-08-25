// src/wake.ts
(async () => {
  const reloadRequested = new URLSearchParams(window.location.search).get("reload") === "1";
  if (reloadRequested) {
    window.history.replaceState(null, "", window.location.pathname);
    chrome.runtime.reload();
    return;
  }
  await chrome.runtime.sendMessage({ kind: "wake" }).catch(() => {
    return;
  });
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id === undefined)
      window.close();
    else
      await chrome.tabs.remove(tab.id);
  } catch {
    window.close();
  }
})();

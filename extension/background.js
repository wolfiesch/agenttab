let nativePort = null;
const HEARTBEAT_ALARM = "chromeBridgeHeartbeat";
const HEARTBEAT_MINUTES = 0.5;
const RECONNECT_ALARM = "chromeBridgeReconnect";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_FACTOR = 2;
const RECONNECT_CAP_MS = 30000;
const TASK_SESSIONS_KEY = "chromeBridgeTaskSessions";
const BRIDGE_PREFERENCES_KEY = "chromeBridgePreferences";
const TASK_DEBUGGER_IDLE_MS = 30000;
const TASK_GROUP_COLORS = ["purple", "cyan", "green", "yellow", "orange", "red", "pink", "blue"];
const TASK_GROUP_STATES = {
  working: { symbol: "✦", label: "Working", prefix: "" },
  needs_user: { symbol: "↗", label: "Needs your help", prefix: "Review needed: " },
  completed: { symbol: "✓", label: "Completed", prefix: "" },
};
// Persist retry state across SW suspension. A bare module variable is lost when
// the MV3 service worker suspends, so we keep backoff state in chrome.storage.
// The manifest grants "storage"; prefer storage.session (resets on browser
// restart, no disk churn) and fall back to storage.local, then an in-memory copy
// so the worker never throws even if storage is unavailable.
const reconnectStore =
  (chrome.storage && (chrome.storage.session || chrome.storage.local)) || null;
let reconnectStateFallback = { attempt: 0, delay: RECONNECT_BASE_MS };

async function getReconnectState() {
  if (!reconnectStore) return { ...reconnectStateFallback };
  const data = await reconnectStore.get("reconnectState");
  return data.reconnectState || { attempt: 0, delay: RECONNECT_BASE_MS };
}

async function setReconnectState(state) {
  reconnectStateFallback = state;
  if (!reconnectStore) return;
  await reconnectStore.set({ reconnectState: state });
}

async function resetBackoff() {
  await setReconnectState({ attempt: 0, delay: RECONNECT_BASE_MS });
  await chrome.alarms.clear(RECONNECT_ALARM);
}

async function scheduleReconnect() {
  const state = await getReconnectState();
  const currentDelay = state.delay || RECONNECT_BASE_MS;
  // Durable mechanism: an alarm survives SW suspension. Alarms only fire on a
  // ~30s granularity in practice, so also fire an OPPORTUNISTIC immediate
  // setTimeout fast-path; the alarm remains the authoritative retry trigger.
  const jitter = Math.random() * 0.3 * currentDelay;
  const delayMs = Math.min(currentDelay + jitter, RECONNECT_CAP_MS);
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: delayMs / 60000 });
  setTimeout(connectToHost, delayMs);
  const nextDelay = Math.min(currentDelay * RECONNECT_FACTOR, RECONNECT_CAP_MS);
  await setReconnectState({ attempt: (state.attempt || 0) + 1, delay: nextDelay });
}
const monitors = new Map();
const interceptors = new Map();
const taskDebuggerStates = new Map();
const expectedDebuggerDetaches = new Map();
let nextTaskDebuggerGeneration = 1;
let taskSessionMutationQueue = Promise.resolve();
const MONITOR_LIMIT = 200;
// Screencast buffers live only in service-worker memory: a worker restart ends
// the recording and drops whatever was buffered. Bounded by BOTH a frame count
// and a total base64 size so a long capture cannot exhaust worker memory.
const screencasts = new Map();
const SCREENCAST_FRAME_LIMIT = 600;
const SCREENCAST_BYTE_LIMIT = 50 * 1024 * 1024;

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;

  if (method === "Fetch.requestPaused" && interceptors.has(source.tabId)) {
    const interceptor = interceptors.get(source.tabId);
    const request = params.request || {};
    const redacted = redactUrl(request.url || "");
    const record = {
      requestId: params.requestId,
      ts: Date.now(),
      url: redacted.url,
      hasQuery: redacted.hasQuery,
      method: request.method || "GET",
      resourceType: params.resourceType || "Document"
    };
    pushLimited(interceptor.requests, record);

    const mode = interceptor.mode;
    const target = { tabId: source.tabId };

    if (mode === "continue") {
      chrome.debugger.sendCommand(target, "Fetch.continueRequest", {
        requestId: params.requestId
      }, (result) => {
        if (chrome.runtime.lastError) {
          console.warn("Fetch.continueRequest failed:", chrome.runtime.lastError.message);
        }
      });
    } else if (mode === "abort") {
      chrome.debugger.sendCommand(target, "Fetch.failRequest", {
        requestId: params.requestId,
        errorReason: "Aborted"
      }, (result) => {
        if (chrome.runtime.lastError) {
          console.warn("Fetch.failRequest failed:", chrome.runtime.lastError.message);
        }
      });
    } else if (mode === "fulfill") {
      const responseCode = interceptor.status ?? 200;
      const responseHeaders = [
        { name: "Content-Type", value: "text/plain" }
      ];
      const encodedBody = toBase64(interceptor.body || "");
      chrome.debugger.sendCommand(target, "Fetch.fulfillRequest", {
        requestId: params.requestId,
        responseCode,
        responseHeaders,
        body: encodedBody
      }, (result) => {
        if (chrome.runtime.lastError) {
          console.warn("Fetch.fulfillRequest failed:", chrome.runtime.lastError.message);
        }
      });
    }
    return;
  }

  if (method === "Page.screencastFrame" && screencasts.has(source.tabId)) {
    const session = screencasts.get(source.tabId);
    const data = typeof params.data === "string" ? params.data : "";
    if (data) {
      session.frames.push({
        base64: data,
        metadata: params.metadata || null,
        timestamp: Date.now()
      });
      session.bytes += data.length;
      session.captured += 1;
      // Drop OLDEST frames past either bound and account for every drop, so a
      // caller can tell a gapped recording from a complete one.
      while (session.frames.length > SCREENCAST_FRAME_LIMIT || session.bytes > SCREENCAST_BYTE_LIMIT) {
        const evicted = session.frames.shift();
        if (!evicted) break;
        session.bytes -= evicted.base64.length;
        session.droppedFrames += 1;
      }
    }
    // Mandatory: Chrome stops emitting frames until each one is acknowledged.
    if (params.sessionId !== undefined && params.sessionId !== null) {
      chrome.debugger.sendCommand({ tabId: source.tabId }, "Page.screencastFrameAck", {
        sessionId: params.sessionId
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn("Page.screencastFrameAck failed:", chrome.runtime.lastError.message);
        }
      });
    }
    return;
  }

  if (!monitors.has(source.tabId)) return;
  const monitor = monitors.get(source.tabId);
  const ts = Date.now();

  if (method === "Runtime.consoleAPICalled") {
    pushLimited(monitor.console, {
      ts,
      type: params.type || "console",
      level: params.type || "log",
      text: (params.args || []).map(stringifyRemoteValue).join(" "),
      args: (params.args || []).map(stringifyRemoteValue),
      stack: captureStackFrames(params.stackTrace)
    });
    return;
  }

  if (method === "Log.entryAdded") {
    const entry = params.entry || {};
    // Log entries carry a stack only for script errors; when they don't, the
    // entry's own url/line is the single generated location we can report.
    // LogEntry.lineNumber is 1-based, unlike call-frame lines, so normalize it
    // to the 0-based convention every frame here uses.
    const stack = captureStackFrames(entry.stackTrace);
    if (stack.length === 0 && entry.url) {
      stack.push({
        url: entry.url,
        lineNumber: typeof entry.lineNumber === "number" ? Math.max(0, entry.lineNumber - 1) : null,
        columnNumber: null,
        functionName: "",
        scriptId: null
      });
    }
    pushLimited(monitor.console, {
      ts,
      type: "log",
      level: entry.level || "info",
      text: entry.text || "",
      args: [],
      stack
    });
    return;
  }

  if (method === "Network.requestWillBeSent") {
    const request = params.request || {};
    const redacted = redactUrl(request.url || "");
    monitor.network.set(params.requestId, {
      requestId: params.requestId,
      ts,
      method: request.method || "GET",
      url: redacted.url,
      hasQuery: redacted.hasQuery,
      type: params.type || null,
      status: null,
      mimeType: null
    });
    trimNetwork(monitor.network);
    return;
  }

  if (method === "Network.responseReceived") {
    const response = params.response || {};
    const existing = monitor.network.get(params.requestId);
    if (existing) {
      existing.status = response.status ?? null;
      existing.mimeType = response.mimeType || null;
    }
    return;
  }

  if (method === "Page.javascriptDialogOpening") {
    pushLimited(monitor.dialogs, {
      ts,
      type: params.type || null,
      message: params.message || "",
      defaultPrompt: params.defaultPrompt || ""
    });
  }
});

chrome.debugger.onDetach.addListener((source) => {
  const tabId = source.tabId;
  if (tabId === undefined || tabId === null) return;
  const expected = expectedDebuggerDetaches.get(tabId) || 0;
  if (expected > 0) {
    if (expected === 1) expectedDebuggerDetaches.delete(tabId);
    else expectedDebuggerDetaches.set(tabId, expected - 1);
    return;
  }
  const state = taskDebuggerStates.get(tabId);
  if (state?.timer) clearTimeout(state.timer);
  taskDebuggerStates.delete(tabId);
  monitors.delete(tabId);
  interceptors.delete(tabId);
});

function scheduleHeartbeat() {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
}

function sendHeartbeat() {
  if (!nativePort) {
    connectToHost();
    return;
  }
  try {
    nativePort.postMessage({ action: "heartbeat", ts: Date.now() });
  } catch (error) {
    console.warn("Heartbeat failed:", error);
    nativePort = null;
    // Don't wait for the next heartbeat alarm; schedule a backed-off reconnect now.
    scheduleReconnect();
  }
}
function connectToHost() {
  if (nativePort) return;
  const hostName = "com.automation.bridge";
  console.log("Connecting to native host:", hostName);
  try {
    nativePort = chrome.runtime.connectNative(hostName);
  } catch (error) {
    console.error("Failed to connect native host:", error);
    nativePort = null;
    scheduleReconnect();
    return;
  }

  nativePort.onMessage.addListener((message) => {
    console.log("Received message from native host:", message);
    handleMessageFromHost(message);
  });

  nativePort.onDisconnect.addListener(() => {
    console.warn("Disconnected from native host:", chrome.runtime.lastError);
    nativePort = null;
    scheduleReconnect();
  });

  // Connection established: reset backoff and clear any pending reconnect alarm.
  resetBackoff();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;
  if (message.action === "wakeNativeHost") {
    connectToHost();
    sendResponse({ success: true });
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId !== undefined) {
      setTimeout(() => chrome.tabs.remove(tabId), 50);
    }
    return false;
  }
  if (message.action === "getBridgeStatus" || message.action === "setBridgePreference") {
    (async () => {
      try {
        if (message.action === "setBridgePreference") {
          await setBridgePreference(message.key, message.value);
        }
        sendResponse(await getBridgeStatus());
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleHeartbeat();
  connectToHost();
});
chrome.runtime.onStartup.addListener(() => {
  if (chrome.storage && chrome.storage.local) chrome.storage.local.remove(TASK_SESSIONS_KEY);
  scheduleHeartbeat();
  connectToHost();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) sendHeartbeat();
  else if (alarm.name === RECONNECT_ALARM) connectToHost();
});
scheduleHeartbeat();
connectToHost();

async function handleMessageFromHost(message) {
  const { id, action, payload } = message;
  try {
    const result = await dispatchAction(action, payload);
    sendResponseToHost({ id, success: true, result });
  } catch (error) {
    sendResponseToHost({ id, success: false, error: error.message });
  }
}

async function runBatch(steps, defaultTabId, stopOnError) {
  if (!Array.isArray(steps)) {
    throw new Error("batch requires a steps array");
  }
  // Wait actions (waitForLoad/waitForSelector/waitForText/waitForUrl) are
  // ordinary dispatch entries, so they interleave with mutating steps for free.
  // stopOnError defaults to true: the first failing step aborts the batch.
  const halt = stopOnError !== false;
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    if (step.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    }
    if (!step.action) {
      results.push(null);
      continue;
    }
    const stepPayload = step.payload ? { ...step.payload } : {};
    if (stepPayload.tabId === undefined && defaultTabId !== undefined) {
      stepPayload.tabId = defaultTabId;
    }
    if (stepPayload.timeoutMs === undefined && step.timeoutMs !== undefined) {
      stepPayload.timeoutMs = step.timeoutMs;
    }
    try {
      const stepResult = await dispatchAction(step.action, stepPayload);
      if (stepResult && typeof stepResult === "object" && stepResult.success === false) {
        throw new Error(stepResult.error || stepResult.err || "step reported success=false");
      }
      results.push(stepResult);
    } catch (error) {
      const message = `batch step ${i} (${step.action}) failed: ${error.message}`;
      if (halt) throw new Error(message);
      results.push({ success: false, step: i, action: step.action, err: message });
    }
  }
  return results;
}

async function dispatchAction(action, payload) {
    let result;
    switch (action) {
      case "batch":
        result = await runBatch(payload.steps, payload.tabId, payload.stopOnError);
        break;
      case "ping":
        result = "pong";
        break;
      case "navigate":
        result = await navigateToUrl(payload.url, payload.active);
        break;
      case "getTabs":
        result = await getTabs();
        break;
      case "createTaskSession":
        result = await createTaskSession(payload.name);
        break;
      case "navigateTaskSession":
        result = await navigateTaskSession(payload.sessionId, payload.url, payload.active, payload.reuse);
        break;
      case "getTaskSessions":
        result = await getTaskSessions(payload.sessionId);
        break;
      case "updateTaskSessionState":
        result = await updateTaskSessionState(payload.sessionId, payload.state);
        break;
      case "closeTaskSession":
        result = await closeTaskSession(payload.sessionId);
        break;
      case "executeScript":
        result = await runScriptInTab(payload.tabId, payload.code);
        break;
      case "executeScriptCDP":
        result = await runScriptWithDebugger(payload.tabId, payload.code);
        break;
      case "click":
        result = await clickSelector(payload.tabId, payload.selector);
        break;
      case "clickAt":
        result = await clickAt(payload.tabId, payload.x, payload.y);
        break;
      case "type":
        result = await typeSelector(payload.tabId, payload.selector, payload.text);
        break;
      case "observe":
        result = await observeTab(payload.tabId, payload);
        break;
      case "getCookies":
        result = await chrome.cookies.getAll({ domain: payload.domain });
        break;
      case "activateTab":
        result = await activateTab(payload.tabId);
        break;
      case "closeTab":
        result = await closeTab(payload.tabId);
        break;
      case "reload":
        result = await reloadTab(payload.tabId);
        break;
      case "windowControl":
        result = await windowControl(payload);
        break;
      case "goBack":
        result = await goHistory(payload.tabId, -1);
        break;
      case "goForward":
        result = await goHistory(payload.tabId, 1);
        break;
      case "waitForLoad":
        result = await waitForLoad(payload.tabId, payload.timeoutMs);
        break;
      case "waitForSelector":
        result = await waitForSelector(payload.tabId, payload.selector, payload.timeoutMs);
        break;
      case "waitForText":
        result = await waitForText(payload.tabId, payload.text, payload.timeoutMs);
        break;
      case "waitForUrl":
        result = await waitForUrl(payload.tabId, payload.substring, payload.timeoutMs);
        break;
      case "getCurrentState":
        result = await getCurrentState(payload.tabId);
        break;
      case "screenshot":
        result = await captureScreenshot(payload.tabId, payload.format, payload.quiet);
        break;
      case "printToPDF":
        result = await printToPDF(payload.tabId, payload);
        break;
      case "extractText":
        result = await extractText(payload.tabId, payload.maxChars, payload.scanPromptInjection);
        break;
      case "extractStructured":
        result = await extractStructured(payload.tabId, payload.schema, payload.selector, payload.maxChars);
        break;
      case "scanPromptInjection":
        result = await scanPromptInjection(payload.tabId, payload.selector, payload.maxChars);
        break;
      case "getHTML":
        result = await getHTML(payload.tabId, payload.scanPromptInjection);
        break;
      case "hover":
        result = await hoverSelector(payload.tabId, payload.selector);
        break;
      case "scroll":
        result = await scrollTarget(payload.tabId, payload.deltaX, payload.deltaY, payload.selector);
        break;
      case "press":
        result = await pressKey(payload.tabId, payload.key);
        break;
      case "drag":
        result = await dragSelector(payload.tabId, payload.fromSelector, payload.toSelector);
        break;
      case "fill":
        result = await fillSelector(payload.tabId, payload.selector, payload.text);
        break;
      case "select":
        result = await selectOption(payload.tabId, payload.selector, payload.value);
        break;
      case "githubAttachUploadedFiles":
        result = await githubAttachUploadedFiles(payload.tabId, payload.inputSelector, payload.formSelector, payload.timeoutMs);
        break;
      case "githubSubmitComment":
        result = await githubSubmitComment(payload.tabId, payload.formSelector, payload.timeoutMs);
        break;
      case "githubAttachPrBody":
        result = await githubAttachPrBody(payload.tabId, payload.files, payload.timeoutMs);
        if (result?.success === false) throw new Error(result.err || 'GitHub PR-body attachment failed');
        break;
      case "uploadFile":
        result = await uploadFile(payload.tabId, payload.selector, payload.files);
        break;
      case "setViewport":
        result = await setViewport(payload.tabId, payload.width, payload.height, payload.deviceScaleFactor);
        break;
      case "setCpuThrottling":
        result = await setCpuThrottling(payload.tabId, payload.rate);
        break;
      case "setNetworkConditions":
        result = await setNetworkConditions(payload.tabId, payload.offline, payload.latency, payload.downloadThroughput, payload.uploadThroughput);
        break;
      case "clearNetworkConditions":
        result = await clearNetworkConditions(payload.tabId);
        break;
      case "setColorScheme":
        result = await setColorScheme(payload.tabId, payload.scheme);
        break;
      case "setUserAgent":
        result = await setUserAgent(payload.tabId, payload.userAgent);
        break;
      case "startMonitoring":
        result = await startMonitoring(payload.tabId);
        break;
      case "stopMonitoring":
        result = await stopMonitoring(payload.tabId);
        break;
      case "startScreencast":
        result = await startScreencast(payload.tabId, payload);
        break;
      case "screencastFrames":
        result = screencastFrames(payload.tabId, payload.consume !== false);
        break;
      case "stopScreencast":
        result = await stopScreencast(payload.tabId);
        break;
      case "consoleMessages":
        result = await consoleMessages(payload.tabId, payload);
        break;
      case "networkRequests":
        result = networkRequests(payload.tabId);
        break;
      case "handleDialog":
        result = await handleDialog(payload.tabId, payload.accept, payload.promptText);
        break;
      case "downloadUrl":
        result = await downloadUrl(payload.url, payload.filename);
        break;
      case "storageState":
        result = await getStorageState(payload.tabId);
        break;
      case "setGeolocation":
        result = await setGeolocation(payload.tabId, payload.latitude, payload.longitude, payload.accuracy);
        break;
      case "clearGeolocation":
        result = await clearGeolocation(payload.tabId);
        break;
      case "startInterception":
        result = await startInterception(payload.tabId, payload.urlPattern, payload.mode, payload.status, payload.body);
        break;
      case "stopInterception":
        result = await stopInterception(payload.tabId);
        break;
      case "interceptedRequests":
        result = interceptedRequests(payload.tabId);
        break;
      case "performanceMetrics":
        result = await performanceMetrics(payload.tabId);
        break;
      case "sessionStatus":
        result = await sessionStatus(payload.domains);
        break;
      case "waitForHandoff":
        result = await waitForHandoff(payload);
        break;
      case "setCookie":
        result = await setCookie(payload);
        break;
      case "deleteCookie":
        result = await deleteCookie(payload.url, payload.name);
        break;
      case "setStorageItem":
        result = await setStorageItem(payload.tabId, payload.scope, payload.key, payload.value);
        break;
      case "removeStorageItem":
        result = await removeStorageItem(payload.tabId, payload.scope, payload.key);
        break;
      case "clearStorage":
        result = await clearStorage(payload.tabId, payload.scope);
        break;
      case "searchHistory":
        result = await searchHistory(payload.query, payload.maxResults, payload.startTime);
        break;
      case "searchBookmarks":
        result = await searchBookmarks(payload.query);
        break;
      case "searchTabs":
        result = await searchTabs(payload);
        break;
      case "startWorkflowRecording":
        result = await startWorkflowRecording(payload);
        break;
      case "stopWorkflowRecording":
        result = stopWorkflowRecording(payload);
        break;
      case "replayWorkflow":
        result = await replayWorkflow(payload);
        break;
      case "resolveCachedSelector":
        result = await resolveCachedSelector(payload);
        break;
      case "cacheSelectors":
        result = cacheSelectors(payload);
        break;
      case "__tabOrigin":
        result = await tabOrigin(payload.tabId);
        break;
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
    // ST3: append this dispatch to every matching active recording. Recording
    // observes bridge traffic only, so nothing a human does in the tab is
    // captured, and a failed action is never recorded.
    await recordDispatchedAction(action, payload, result);
    return result;
}

function sendResponseToHost(response) {
  if (nativePort) {
    nativePort.postMessage(response);
  } else {
    console.error("Cannot send response, nativePort is disconnected.");
  }
}

async function navigateToUrl(url, active = false) {
  const tab = await chrome.tabs.create({ url, active: active === true });
  return { tabId: tab.id };
}

async function getTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    highlighted: tab.highlighted,
    title: tab.title,
    url: tab.url,
    status: tab.status
  }));
}

async function loadTaskSessions() {
  const store = chrome.storage && chrome.storage.local;
  if (!store) return {};
  const data = await store.get(TASK_SESSIONS_KEY);
  return data[TASK_SESSIONS_KEY] || {};
}

async function saveTaskSessions(sessions) {
  const store = chrome.storage && chrome.storage.local;
  if (store) await store.set({ [TASK_SESSIONS_KEY]: sessions });
}

async function loadBridgePreferences() {
  const store = chrome.storage && chrome.storage.local;
  if (!store) return { showAgentPointer: true };
  const data = await store.get(BRIDGE_PREFERENCES_KEY);
  return { showAgentPointer: true, ...(data[BRIDGE_PREFERENCES_KEY] || {}) };
}

async function setBridgePreference(key, value) {
  if (key !== "showAgentPointer") throw new Error("unknown bridge preference");
  const preferences = await loadBridgePreferences();
  preferences[key] = value === true;
  const store = chrome.storage && chrome.storage.local;
  if (store) await store.set({ [BRIDGE_PREFERENCES_KEY]: preferences });
  return preferences;
}

function normalizedTaskName(name) {
  const cleaned = String(name || "Browser task")
    .replace(/^[✦↗✓]\s*/, "")
    .replace(/^Review needed:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Browser task";
}

function taskGroupColor(sessionId) {
  let hash = 2166136261;
  for (const char of String(sessionId || "task")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return TASK_GROUP_COLORS[(hash >>> 0) % TASK_GROUP_COLORS.length];
}

function taskGroupTitle(session) {
  const state = TASK_GROUP_STATES[session.state] || TASK_GROUP_STATES.working;
  const available = Math.max(1, 40 - state.symbol.length - 1);
  const name = `${state.prefix}${normalizedTaskName(session.name)}`.slice(0, available).trimEnd();
  return `${state.symbol} ${name}`;
}

async function refreshTaskGroup(session) {
  if (!chrome.tabGroups || !Number.isInteger(session.groupId) || session.groupId < 0) return;
  try {
    await chrome.tabGroups.update(session.groupId, {
      title: taskGroupTitle(session),
      color: session.color || taskGroupColor(session.sessionId),
      collapsed: false,
    });
  } catch (error) {
    console.warn("Could not update task group visual state:", error);
  }
}

async function updateTaskSessionState(sessionId, state) {
  if (!TASK_GROUP_STATES[state]) throw new Error("state must be working, needs_user, or completed");
  const session = await mutateTaskSessions(async (sessions) => {
    const current = sessions[sessionId];
    if (!current) throw new Error("unknown task session");
    current.state = state;
    current.color ||= taskGroupColor(current.sessionId);
    current.updatedAt = Date.now();
    return { value: { ...current }, changed: true };
  });
  try {
    await refreshTaskGroup(session);
  } catch (error) {
    console.warn("Could not update task group state:", error);
  }
  return session;
}

async function getBridgeStatus() {
  const [preferences, sessions] = await Promise.all([loadBridgePreferences(), getTaskSessions()]);
  const active = sessions
    .filter((session) => (session.tabIds || []).length > 0)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  const state = active ? (TASK_GROUP_STATES[active.state] || TASK_GROUP_STATES.working) : null;
  return {
    connected: nativePort !== null,
    quietReads: true,
    showAgentPointer: preferences.showAgentPointer !== false,
    activeTask: active ? {
      name: normalizedTaskName(active.name),
      state: active.state || "working",
      stateLabel: state.label,
      symbol: state.symbol,
      color: active.color || taskGroupColor(active.sessionId),
    } : null,
  };
}

function mutateTaskSessions(mutator) {
  const operation = taskSessionMutationQueue.then(async () => {
    const sessions = await loadTaskSessions();
    const outcome = await mutator(sessions);
    if (outcome.changed) await saveTaskSessions(sessions);
    return outcome.value;
  });
  taskSessionMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function newTaskSessionId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function validSessionOwnedTabs(session) {
  const valid = [];
  const hasGroup = Number.isInteger(session.groupId) && session.groupId >= 0;
  for (const tabId of session.tabIds || []) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && (!hasGroup || tab.groupId === session.groupId)) valid.push(tabId);
    } catch (error) {
      // Closed tabs and tabs moved out of the task group are no longer owned.
    }
  }
  return valid;
}

async function findTaskSessionForTab(tabId) {
  return mutateTaskSessions(async (sessions) => {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      let changed = false;
      for (const session of Object.values(sessions)) {
        if ((session.tabIds || []).includes(tabId)) {
          session.tabIds = session.tabIds.filter((ownedId) => ownedId !== tabId);
          session.updatedAt = Date.now();
          changed = true;
        }
      }
      return { value: null, changed };
    }

    const groupSession = Object.values(sessions).find((session) =>
      Number.isInteger(session.groupId) && session.groupId >= 0 && tab.groupId === session.groupId
    );
    if (groupSession) {
      let changed = false;
      for (const session of Object.values(sessions)) {
        const owned = (session.tabIds || []).includes(tabId);
        if (session === groupSession) {
          if (!owned) {
            session.tabIds = [...(session.tabIds || []), tabId];
            session.updatedAt = Date.now();
            changed = true;
          }
        } else if (owned) {
          session.tabIds = session.tabIds.filter((ownedId) => ownedId !== tabId);
          session.updatedAt = Date.now();
          changed = true;
        }
      }
      return { value: { sessionId: groupSession.sessionId, session: groupSession }, changed };
    }

    const directSession = Object.values(sessions).find((session) => (session.tabIds || []).includes(tabId));
    if (directSession && (!Number.isInteger(directSession.groupId) || directSession.groupId < 0)) {
      return { value: { sessionId: directSession.sessionId, session: directSession }, changed: false };
    }
    if (directSession) {
      directSession.tabIds = directSession.tabIds.filter((ownedId) => ownedId !== tabId);
      directSession.updatedAt = Date.now();
      return { value: null, changed: true };
    }
    return { value: null, changed: false };
  });
}

async function detachTaskDebugger(tabId, force = false) {
  const state = taskDebuggerStates.get(tabId);
  if (!state) return false;
  if (state.phase === "attaching") {
    try {
      await state.attachPromise;
    } catch (error) {
      return false;
    }
    return detachTaskDebugger(tabId, force);
  }
  if (state.phase === "detaching") return state.detachPromise;
  if (!force && (state.busyCount > 0 || state.holders.size > 0)) return false;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (force) {
    monitors.delete(tabId);
    interceptors.delete(tabId);
    state.holders.clear();
  }
  state.phase = "detaching";
  const expected = expectedDebuggerDetaches.get(tabId) || 0;
  expectedDebuggerDetaches.set(tabId, expected + 1);
  state.detachPromise = (async () => {
    try {
      await debuggerDetach({ tabId });
      if (taskDebuggerStates.get(tabId) === state) taskDebuggerStates.delete(tabId);
      return true;
    } catch (error) {
      const pendingExpected = expectedDebuggerDetaches.get(tabId) || 0;
      if (pendingExpected <= 1) expectedDebuggerDetaches.delete(tabId);
      else expectedDebuggerDetaches.set(tabId, pendingExpected - 1);
      if (taskDebuggerStates.get(tabId) === state) {
        state.phase = "attached";
        state.detachPromise = null;
        if (!force) scheduleTaskDebuggerDetach(tabId);
      }
      throw error;
    }
  })();
  return state.detachPromise;
}

function scheduleTaskDebuggerDetach(tabId) {
  const state = taskDebuggerStates.get(tabId);
  if (!state || state.phase !== "attached" || state.busyCount > 0 || state.holders.size > 0) return;
  if (state.timer) clearTimeout(state.timer);
  state.lastUsedAt = Date.now();
  state.timer = setTimeout(() => {
    detachTaskDebugger(tabId).catch((error) => {
      console.warn(`Could not detach idle task debugger for tab ${tabId}:`, error.message);
    });
  }, TASK_DEBUGGER_IDLE_MS);
}

async function acquireTaskDebugger(tabId, sessionId, holder = null) {
  const target = { tabId };
  while (true) {
    let state = taskDebuggerStates.get(tabId);
    if (state && state.sessionId !== sessionId) {
      await detachTaskDebugger(tabId, true);
      continue;
    }
    if (state?.phase === "detaching") {
      try {
        await state.detachPromise;
      } catch (error) {
        if (taskDebuggerStates.get(tabId) === state && state.phase === "attached") continue;
        throw error;
      }
      continue;
    }
    if (state?.phase === "attaching") {
      await state.attachPromise;
      continue;
    }
    if (!state) {
      const alreadyAttached = monitors.has(tabId) || interceptors.has(tabId);
      state = {
        sessionId,
        phase: alreadyAttached ? "attached" : "attaching",
        generation: nextTaskDebuggerGeneration++,
        attachPromise: null,
        detachPromise: null,
        lastUsedAt: Date.now(),
        timer: null,
        busyCount: 0,
        holders: new Set([
          ...(monitors.has(tabId) ? ["monitor"] : []),
          ...(interceptors.has(tabId) ? ["interceptor"] : []),
        ]),
      };
      taskDebuggerStates.set(tabId, state);
      if (!alreadyAttached) {
        state.attachPromise = debuggerAttach(target).then(() => {
          if (taskDebuggerStates.get(tabId) === state) state.phase = "attached";
        }).catch((error) => {
          if (taskDebuggerStates.get(tabId) === state) taskDebuggerStates.delete(tabId);
          throw error;
        });
        await state.attachPromise;
      }
      continue;
    }
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.lastUsedAt = Date.now();
    if (holder) state.holders.add(holder);
    else state.busyCount += 1;
    return { tabId, target, state, generation: state.generation, holder };
  }
}

function releaseTaskDebugger(lease) {
  const current = taskDebuggerStates.get(lease.tabId);
  if (current !== lease.state || current.generation !== lease.generation) return;
  if (lease.holder) current.holders.delete(lease.holder);
  else current.busyCount = Math.max(0, current.busyCount - 1);
  scheduleTaskDebuggerDetach(lease.tabId);
}

async function withTaskDebugger(tabId, sessionId, fn) {
  const lease = await acquireTaskDebugger(tabId, sessionId);
  try {
    return await fn(lease.target);
  } finally {
    releaseTaskDebugger(lease);
  }
}

async function detachTaskSessionDebuggers(sessionId) {
  const tabIds = [...taskDebuggerStates.entries()]
    .filter(([, state]) => state.sessionId === sessionId)
    .map(([tabId]) => tabId);
  await Promise.all(tabIds.map((tabId) => detachTaskDebugger(tabId, true)));
}

async function createTaskSession(name) {
  return mutateTaskSessions(async (sessions) => {
    const sessionId = newTaskSessionId();
    sessions[sessionId] = {
      sessionId,
      name: normalizedTaskName(name),
      state: "working",
      color: taskGroupColor(sessionId),
      tabIds: [],
      groupId: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    return { value: sessions[sessionId], changed: true };
  });
}

async function getTaskSessions(sessionId) {
  return mutateTaskSessions(async (sessions) => {
    let changed = false;
    for (const session of Object.values(sessions)) {
      const valid = await validSessionOwnedTabs(session);
      if (valid.length !== (session.tabIds || []).length) {
        session.tabIds = valid;
        session.updatedAt = Date.now();
        changed = true;
      }
    }
    if (sessionId && !sessions[sessionId]) throw new Error("unknown task session");
    return { value: sessionId ? sessions[sessionId] : Object.values(sessions), changed };
  });
}

async function groupTaskTab(session, tabId) {
  if (!chrome.tabs.group || !chrome.tabGroups) return;
  try {
    const options = { tabIds: [tabId] };
    if (Number.isInteger(session.groupId)) options.groupId = session.groupId;
    session.groupId = await chrome.tabs.group(options);
    await refreshTaskGroup(session);
  } catch (error) {
    console.warn("Could not group task tab:", error);
    session.groupId = null;
    try {
      session.groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await refreshTaskGroup(session);
    } catch (retryError) {
      console.warn("Could not create replacement task group:", retryError);
    }
  }
}

async function navigateTaskSession(sessionId, url, active = false, reuse = true) {
  return mutateTaskSessions(async (sessions) => {
    const session = sessions[sessionId];
    if (!session) throw new Error("unknown task session");
    session.tabIds = await validSessionOwnedTabs(session);
    let tab = null;
    if (reuse !== false && session.tabIds.length) {
      const reusedTabId = session.tabIds[0];
      try {
        tab = await chrome.tabs.update(reusedTabId, { url, active: active === true });
        if (active === true && tab.windowId !== undefined) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      } catch (error) {
        tab = await chrome.tabs.create({ url, active: active === true });
        session.tabIds = session.tabIds.filter((tabId) => tabId !== reusedTabId);
        session.tabIds.push(tab.id);
        await groupTaskTab(session, tab.id);
      }
    } else {
      tab = await chrome.tabs.create({ url, active: active === true });
      session.tabIds.push(tab.id);
      await groupTaskTab(session, tab.id);
    }
    session.updatedAt = Date.now();
    return { value: { sessionId, tabId: tab.id, windowId: tab.windowId, active: tab.active }, changed: true };
  });
}

async function closeTaskSession(sessionId) {
  const tabIds = await mutateTaskSessions(async (sessions) => {
    const session = sessions[sessionId];
    if (!session) throw new Error("unknown task session");
    const ownedTabIds = await validSessionOwnedTabs(session);
    delete sessions[sessionId];
    return { value: ownedTabIds, changed: true };
  });
  await detachTaskSessionDebuggers(sessionId);
  // Delete ownership first. chrome.tabs.remove emits onRemoved events; if the
  // record still exists, an event listener can race and re-save an empty copy.
  if (tabIds.length) {
    try {
      await chrome.tabs.remove(tabIds);
    } catch (error) {
      // A tab can close between the ownership check and remove(). Ownership is
      // already durably deleted, so this race should not fail the close call.
      console.warn("Could not remove every task-session tab:", error);
    }
  }
  return { success: true, sessionId, closedTabIds: tabIds };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = taskDebuggerStates.get(tabId);
  if (state?.timer) clearTimeout(state.timer);
  taskDebuggerStates.delete(tabId);
  // A closed tab can never be drained; free its frame buffer immediately.
  screencasts.delete(tabId);
  monitors.delete(tabId);
  interceptors.delete(tabId);
  await mutateTaskSessions(async (sessions) => {
    let changed = false;
    for (const session of Object.values(sessions)) {
      if ((session.tabIds || []).includes(tabId)) {
        session.tabIds = session.tabIds.filter((ownedId) => ownedId !== tabId);
        session.updatedAt = Date.now();
        changed = true;
      }
    }
    return { value: undefined, changed };
  });
});

// Reserved internal action used by the native host's tab-origin policy check.
// Returns only the target tab's URL/origin (no page content) so the host can
// evaluate site policy for tab-scoped actions before forwarding them. When no
// tabId is given, resolves the active tab, then the first tab.
async function tabOrigin(tabId) {
  let tab;
  if (tabId === undefined || tabId === null) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
    if (!tab) {
      const all = await chrome.tabs.query({});
      tab = all && all[0];
    }
  } else {
    tab = await chrome.tabs.get(tabId);
  }
  if (!tab) throw new Error("no such tab");
  let origin = null;
  try {
    origin = tab.url ? new URL(tab.url).origin : null;
  } catch (e) {
    origin = null;
  }
  return { tabId: tab.id ?? null, url: tab.url || null, origin };
}

async function activateTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  return { success: true, tabId, windowId: tab.windowId ?? null };
}

async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
  return { success: true, tabId };
}

async function reloadTab(tabId) {
  await chrome.tabs.reload(tabId);
  return { success: true, tabId };
}

const WINDOW_STATES = new Set(["normal", "minimized", "maximized"]);

// Single window-management entry point. `list` deliberately reports only
// structural window facts (id, focus, state, type, tab count) and never tab
// URLs or titles, so a raw response cannot leak private browsing context.
async function windowControl(payload) {
  const options = payload && typeof payload === "object" ? payload : {};
  const op = typeof options.op === "string" ? options.op : "";
  const requireWindowId = () => {
    const windowId = Number(options.windowId);
    if (!Number.isInteger(windowId)) return null;
    return windowId;
  };
  switch (op) {
    case "list": {
      const windows = await chrome.windows.getAll({ populate: true });
      return {
        success: true,
        windows: windows.map((win) => ({
          id: win.id,
          focused: win.focused === true,
          state: win.state || null,
          type: win.type || null,
          tabCount: Array.isArray(win.tabs) ? win.tabs.length : 0
        }))
      };
    }
    case "create": {
      const createOptions = { focused: options.focused === true };
      if (options.url) createOptions.url = options.url;
      if (options.state !== undefined && options.state !== null) {
        if (!WINDOW_STATES.has(options.state)) {
          return { success: false, err: `windowControl state must be one of ${[...WINDOW_STATES].join(", ")}` };
        }
        createOptions.state = options.state;
        // Chrome rejects an explicit focus preference alongside a non-normal
        // window state; the state itself already decides visibility.
        if (options.state !== "normal") delete createOptions.focused;
      }
      const win = await chrome.windows.create(createOptions);
      return {
        success: true,
        windowId: win.id,
        focused: win.focused === true,
        state: win.state || null,
        type: win.type || null,
        tabCount: Array.isArray(win.tabs) ? win.tabs.length : 0
      };
    }
    case "focus": {
      const windowId = requireWindowId();
      if (windowId === null) return { success: false, err: "windowControl focus requires a numeric windowId" };
      const win = await chrome.windows.update(windowId, { focused: true });
      return { success: true, windowId, focused: win.focused === true, state: win.state || null };
    }
    case "setState": {
      const windowId = requireWindowId();
      if (windowId === null) return { success: false, err: "windowControl setState requires a numeric windowId" };
      if (!WINDOW_STATES.has(options.state)) {
        return { success: false, err: `windowControl state must be one of ${[...WINDOW_STATES].join(", ")}` };
      }
      const win = await chrome.windows.update(windowId, { state: options.state });
      return { success: true, windowId, state: win.state || null, focused: win.focused === true };
    }
    case "close": {
      const windowId = requireWindowId();
      if (windowId === null) return { success: false, err: "windowControl close requires a numeric windowId" };
      const target = await chrome.windows.get(windowId, { populate: false });
      const all = await chrome.windows.getAll({ populate: false });
      const normalWindows = all.filter((win) => win.type === "normal");
      if (target.type === "normal" && normalWindows.length <= 1) {
        return {
          success: false,
          err: "refusing to close the last remaining normal browser window",
          reason: "lastNormalWindow",
          windowId
        };
      }
      await chrome.windows.remove(windowId);
      return { success: true, windowId, closed: true };
    }
    default:
      return { success: false, err: "windowControl op must be list, create, focus, setState, or close" };
  }
}

async function goHistory(tabId, delta) {
  return withDebugger(tabId, async (target) => {
    const history = await debuggerCommand(target, 'Page.getNavigationHistory', {});
    const targetIndex = history.currentIndex + delta;
    if (targetIndex < 0 || targetIndex >= history.entries.length) {
      return { success: false, err: "No history entry in requested direction" };
    }
    const entryId = history.entries[targetIndex].id;
    await debuggerCommand(target, 'Page.navigateToHistoryEntry', { entryId });
    return { success: true, tabId, entryId };
  });
}

async function runScriptInTab(tabId, code) {
  const response = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: 'MAIN',
    func: (codeString) => {
      try {
        return { success: true, val: (0, eval)(codeString) };
      } catch (err) {
        return { success: false, err: err.message };
      }
    },
    args: [code]
  });
  return response[0].result;
}

function debuggerAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, '1.3', () => {
      const err = chrome.runtime.lastError;
      err ? reject(new Error(err.message)) : resolve();
    });
  });
}

function debuggerCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const err = chrome.runtime.lastError;
      err ? reject(new Error(err.message)) : resolve(result);
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      const err = chrome.runtime.lastError;
      err ? reject(new Error(err.message)) : resolve();
    });
  });
}

async function withDebugger(tabId, fn) {
  const target = { tabId };
  const taskState = taskDebuggerStates.get(tabId);
  if (taskState && (taskState.phase !== "attached" || taskState.busyCount > 0 || taskState.holders.size > 0)) {
    return withTaskDebugger(tabId, taskState.sessionId, fn);
  }
  const taskSession = await findTaskSessionForTab(tabId);
  if (taskSession) return withTaskDebugger(tabId, taskSession.sessionId, fn);
  if (monitors.has(tabId) || interceptors.has(tabId) || screencasts.has(tabId)) return fn(target);
  await debuggerAttach(target);
  try {
    return await fn(target);
  } finally {
    await debuggerDetach(target);
  }
}

async function evaluateWithDebugger(target, expression) {
  const result = await debuggerCommand(target, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true
  });
  if (result.exceptionDetails) {
    return { success: false, err: result.exceptionDetails.text || 'Runtime.evaluate exception', details: result.exceptionDetails };
  }
  return { success: true, val: result.result?.value ?? result.result?.description ?? null };
}

async function runScriptWithDebugger(tabId, code) {
  return withDebugger(tabId, (target) => evaluateWithDebugger(target, code));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deadlineFrom(timeoutMs) {
  return Date.now() + Math.max(0, timeoutMs || 10000);
}

async function waitForLoad(tabId, timeoutMs) {
  const deadline = deadlineFrom(timeoutMs);
  while (Date.now() <= deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return { success: true, tabId, status: "complete" };
    await sleep(250);
  }
  return { success: false, err: "Timed out waiting for tab load", timeoutMs };
}

async function waitForUrl(tabId, substring, timeoutMs) {
  if (!substring) return { success: false, err: "Missing URL substring" };
  const deadline = deadlineFrom(timeoutMs);
  while (Date.now() <= deadline) {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";
    if (url.includes(substring)) return { success: true, tabId, url };
    await sleep(250);
  }
  return { success: false, err: "Timed out waiting for URL", substring, timeoutMs };
}

function parseLocatorToken(rawToken, rawLocator) {
  const token = String(rawToken ?? "").trim();
  if (!token) throw new Error(`Missing final selector in ${rawLocator}`);
  if (token.startsWith("css=")) {
    const selector = token.slice("css=".length).trim();
    if (!selector) throw new Error(`Missing CSS selector in ${rawLocator}`);
    return { kind: "css", selector };
  }
  if (token.startsWith("text=")) {
    const text = token.slice("text=".length).trim();
    if (!text) throw new Error(`Missing text in ${rawLocator}`);
    return { kind: "text", text };
  }
  if (token.startsWith("label=")) {
    const text = token.slice("label=".length).trim();
    if (!text) throw new Error(`Missing label text in ${rawLocator}`);
    return { kind: "label", text };
  }
  if (token.startsWith("aria=")) {
    const name = token.slice("aria=".length).trim();
    if (!name) throw new Error(`Missing accessible name in ${rawLocator}`);
    return { kind: "aria", name };
  }
  if (token.startsWith("role=")) {
    const roleSpec = token.slice("role=".length).trim();
    const match = roleSpec.match(/^([A-Za-z][A-Za-z0-9_-]*)(?:\[name=([^\]]+)\])?$/);
    if (!match) throw new Error(`Invalid role locator in ${rawLocator}`);
    return { kind: "role", role: match[1].toLowerCase(), name: match[2] };
  }
  if (token.startsWith("ref=")) {
    const ref = token.slice("ref=".length).trim();
    if (!/^e[0-9]+$/.test(ref)) throw new Error(`Invalid element ref in ${rawLocator}`);
    return { kind: "ref", ref };
  }
  return { kind: "css", selector: token };
}

function scanLocatorSeparators(raw, separator) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      continue;
    }
    if (ch === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }
    if (bracketDepth === 0 && parenDepth === 0 && raw.startsWith(separator, i)) {
      parts.push(raw.slice(start, i).trim());
      i += separator.length - 1;
      start = i + 1;
    }
  }
  parts.push(raw.slice(start).trim());
  return parts;
}

function hasUnsupportedLocatorToken(raw) {
  return scanLocatorSeparators(raw, ">>>>").length > 1 || scanLocatorSeparators(raw, "<<<").length > 1;
}

// A ref that is not in the tab's live registry MUST fail loudly: falling back
// to CSS parsing would silently click whatever "e12" happens to match.
class StaleRefError extends Error {
  constructor(ref) {
    super(`Unknown or stale element ref ${ref}; re-run observe`);
    this.name = "StaleRefError";
    this.ref = ref;
  }
}

function staleRefResponse(ref) {
  return {
    success: false,
    error: "staleRef",
    err: `Unknown or stale element ref ${ref}; re-run observe`,
    ref,
    hint: "re-run observe"
  };
}

function locatorError(error) {
  if (error instanceof StaleRefError) return staleRefResponse(error.ref);
  return { success: false, err: error.message };
}

function parseActionLocator(selector, tabId) {
  const raw = String(selector ?? "");
  if (hasUnsupportedLocatorToken(raw)) {
    throw new Error(`Unsupported selector token in ${raw}`);
  }
  const shadowParts = scanLocatorSeparators(raw, ">>>");
  if (!shadowParts[0]?.trim()) {
    throw new Error(`Missing final selector in ${raw}`);
  }
  if (shadowParts.some((part, index) => index > 0 && !part.trim())) {
    throw new Error(`Missing final selector in ${raw}`);
  }
  const frameParts = scanLocatorSeparators(shadowParts[0], ">>");
  const frames = [];
  let target = null;
  for (let i = 0; i < frameParts.length; i++) {
    const part = frameParts[i].trim();
    if (!part) {
      throw new Error(`Missing final selector in ${raw}`);
    }
    if (part.startsWith("frame=") && target === null) {
      const frameSelector = part.slice("frame=".length).trim();
      if (!frameSelector) {
        throw new Error(`Missing frame selector in ${raw}`);
      }
      frames.push(frameSelector);
      continue;
    }
    if (i < frameParts.length - 1) {
      throw new Error(`Unsupported selector token in ${raw}`);
    }
    target = parseLocatorToken(part, raw);
  }
  if (!target) {
    throw new Error(`Missing final selector in ${raw}`);
  }
  const shadowSegments = shadowParts.slice(1).map((part) => parseLocatorToken(part, raw));
  bindLocatorRefs([target, ...shadowSegments], tabId);
  return {
    frames,
    target,
    selector: target.kind === "css" ? target.selector : null,
    shadowSegments
  };
}

function locatorResolverSource() {
  return `
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visibleText = (el) => normalize(el.innerText || el.textContent || '');
    const isVisible = (el) => {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0 || el.getClientRects().length > 0;
    };
    const byIdText = (id) => normalize((id || '').split(/\\s+/).map((part) => document.getElementById(part)?.innerText || document.getElementById(part)?.textContent || '').join(' '));
    const labelText = (el) => {
      const labels = el.labels ? Array.from(el.labels).map((label) => visibleText(label)).filter(Boolean) : [];
      if (labels.length) return normalize(labels.join(' '));
      const id = el.getAttribute('id');
      if (id) {
        const explicit = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (explicit) return visibleText(explicit);
      }
      const wrapped = el.closest('label');
      if (wrapped) return visibleText(wrapped);
      return '';
    };
    const accessibleName = (el) => normalize(
      el.getAttribute('aria-label') ||
      byIdText(el.getAttribute('aria-labelledby')) ||
      labelText(el) ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      visibleText(el)
    );
    const implicitRole = (el) => {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(type))) return 'button';
      if (tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden'].includes(type))) return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'input' && type === 'checkbox') return 'checkbox';
      if (tag === 'input' && type === 'radio') return 'radio';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'img') return 'img';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return '';
    };
    const candidateElements = (root) => {
      const all = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
      return all.filter(isVisible);
    };
    const deepestTextMatch = (root, expected) => {
      const wanted = normalize(expected);
      const candidates = candidateElements(root);
      const pick = (contains) => candidates
        .filter((el) => {
          const text = visibleText(el);
          if (contains ? !text.includes(wanted) : text !== wanted) return false;
          return !Array.from(el.children || []).some((child) => isVisible(child) && (contains ? visibleText(child).includes(wanted) : visibleText(child) === wanted));
        })
        .sort((a, b) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (b.getBoundingClientRect().width * b.getBoundingClientRect().height))[0] || null;
      return pick(false) || pick(true);
    };
    const resolveToken = (root, token) => {
      if (!token || token.kind === 'css') {
        const selector = token?.selector || '';
        const el = root.querySelector(selector);
        return el ? { success: true, el } : { success: false, err: 'No element found for selector ' + selector };
      }
      if (token.kind === 'ref') {
        const store = self.__chromeBridgeRefs;
        const el = store && typeof store.get === 'function' ? store.get(token.ref) : null;
        if (!el || !el.isConnected) {
          return { success: false, error: 'staleRef', err: 'Stale element ref ' + token.ref + '; re-run observe', hint: 're-run observe' };
        }
        return { success: true, el };
      }
      if (token.kind === 'text') {
        const el = deepestTextMatch(root, token.text);
        return el ? { success: true, el } : { success: false, err: 'No element found for text ' + token.text };
      }
      if (token.kind === 'label') {
        const wanted = normalize(token.text);
        const controls = candidateElements(root).filter((el) => /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName));
        const el = controls.find((item) => labelText(item) === wanted || item.getAttribute('aria-label') === wanted || byIdText(item.getAttribute('aria-labelledby')) === wanted || item.getAttribute('placeholder') === wanted) ||
          controls.find((item) => labelText(item).includes(wanted) || normalize(item.getAttribute('aria-label')).includes(wanted) || byIdText(item.getAttribute('aria-labelledby')).includes(wanted) || normalize(item.getAttribute('placeholder')).includes(wanted));
        return el ? { success: true, el } : { success: false, err: 'No form control found for label ' + token.text };
      }
      if (token.kind === 'aria') {
        const wanted = normalize(token.name);
        const matches = candidateElements(root);
        const el = matches.find((item) => accessibleName(item) === wanted) ||
          matches.find((item) => accessibleName(item).includes(wanted));
        return el ? { success: true, el } : { success: false, err: 'No element found for accessible name ' + token.name };
      }
      if (token.kind === 'role') {
        const name = normalize(token.name);
        const matches = candidateElements(root).filter((el) => (el.getAttribute('role') || implicitRole(el)) === token.role);
        const el = matches.find((item) => !name || accessibleName(item) === name) || matches.find((item) => name && accessibleName(item).includes(name));
        return el ? { success: true, el } : { success: false, err: 'No element found for role ' + token.role + (name ? ' name ' + name : '') };
      }
      return { success: false, err: 'Unsupported locator kind ' + token.kind };
    };
    const resolveLocator = (locator) => {
      let resolved = resolveToken(document, locator.target || { kind: 'css', selector: locator.selector });
      if (!resolved.success) return resolved;
      let el = resolved.el;
      for (const segment of locator.shadowSegments || []) {
        if (!el.shadowRoot) return { success: false, err: 'No open shadow root for selector segment ' + (segment.selector || segment.text || segment.role || segment.kind) };
        resolved = resolveToken(el.shadowRoot, segment);
        if (!resolved.success) return resolved;
        el = resolved.el;
      }
      return { success: true, el };
    };
  `;
}

function elementResolverExpression(locator, mode) {
  return `(() => {
    ${locatorResolverSource()}
    const resolved = resolveLocator(${JSON.stringify(locator)});
    if (!resolved.success) return resolved;
    const el = resolved.el;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    if (${JSON.stringify(mode)} === 'focus' || ${JSON.stringify(mode)} === 'clear') {
      el.focus();
    }
    if (${JSON.stringify(mode)} === 'clear') {
      if ('value' in el) {
        el.value = '';
      } else {
        el.textContent = '';
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    }
    return {
      success: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      tagName: el.tagName,
      text: el.innerText || el.value || el.getAttribute('aria-label') || '',
      value: 'value' in el ? el.value : el.textContent
    };
  })()`;
}

function actionTargetExpression(locator, mode) {
  return elementResolverExpression(locator, mode);
}

function domClickExpression(locator) {
  return `(() => {
    ${locatorResolverSource()}
    const resolved = resolveLocator(${JSON.stringify(locator)});
    if (!resolved.success) return resolved;
    const matched = resolved.el;
    const el = typeof matched.click === 'function'
      ? matched
      : matched.closest?.('button, a, input, select, textarea, [role]') || matched;
    if (typeof el.click !== 'function') {
      return { success: false, err: 'Matched element is not clickable' };
    }
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
      buttons: 1,
      clickCount: 1
    };
    el.dispatchEvent(new MouseEvent('mousedown', eventInit));
    el.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 }));
    el.click();
    return {
      success: true,
      tagName: el.tagName,
      text: el.innerText || el.value || el.getAttribute('aria-label') || '',
      value: 'value' in el ? el.value : el.textContent
    };
  })()`;
}

function domScrollExpression(locator, deltaX, deltaY) {
  const locatorJson = locator ? JSON.stringify(locator) : "null";
  return `(() => {
    ${locator ? locatorResolverSource() : ""}
    const dx = ${JSON.stringify(deltaX)};
    const dy = ${JSON.stringify(deltaY)};
    if (${locatorJson} === null) {
      window.scrollBy(dx, dy);
      return { success: true, deltaX: dx, deltaY: dy };
    }
    const resolved = resolveLocator(${locatorJson});
    if (!resolved.success) return resolved;
    const el = resolved.el;
    if (typeof el.scrollBy === 'function') {
      el.scrollBy(dx, dy);
    } else {
      el.scrollLeft += dx;
      el.scrollTop += dy;
    }
    return { success: true, deltaX: dx, deltaY: dy, tagName: el.tagName };
  })()`;
}


function domSelectExpression(locator, value) {
  return `(() => {
    ${locatorResolverSource()}
    const resolved = resolveLocator(${JSON.stringify(locator)});
    if (!resolved.success) return resolved;
    const el = resolved.el;
    const value = ${JSON.stringify(value)};
    if (el.tagName !== 'SELECT') return { success: false, err: 'Element is not a SELECT' };
    const option = Array.from(el.options).find((item) => item.value === value || item.text === value);
    if (!option) return { success: false, err: 'No option matched value/text: ' + value };
    el.value = option.value;
    option.selected = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, value: el.value, selectedText: option.text };
  })()`;
}

function elementObjectExpression(locator) {
  return `(() => {
    ${locatorResolverSource()}
    const resolved = resolveLocator(${JSON.stringify(locator)});
    if (!resolved.success) throw new Error(resolved.err || 'Element not found');
    return resolved.el;
  })()`;
}

function domDragExpression(fromLocator, toLocator) {
  return `(() => {
    ${locatorResolverSource()}
    const from = resolveLocator(${JSON.stringify(fromLocator)});
    if (!from.success) return from;
    const to = resolveLocator(${JSON.stringify(toLocator)});
    if (!to.success) return to;
    from.el.scrollIntoView({ block: 'center', inline: 'center' });
    to.el.scrollIntoView({ block: 'center', inline: 'center' });
    const fromRect = from.el.getBoundingClientRect();
    const toRect = to.el.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    const eventInit = { bubbles: true, cancelable: true, composed: true, dataTransfer };
    from.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, clientX: fromRect.left + fromRect.width / 2, clientY: fromRect.top + fromRect.height / 2, button: 0, buttons: 1 }));
    from.el.dispatchEvent(new DragEvent('dragstart', eventInit));
    to.el.dispatchEvent(new DragEvent('dragenter', eventInit));
    to.el.dispatchEvent(new DragEvent('dragover', eventInit));
    const dropped = to.el.dispatchEvent(new DragEvent('drop', eventInit));
    from.el.dispatchEvent(new DragEvent('dragend', eventInit));
    to.el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, clientX: toRect.left + toRect.width / 2, clientY: toRect.top + toRect.height / 2, button: 0, buttons: 0 }));
    return { success: true, from: from.el.tagName, to: to.el.tagName, dropped };
  })()`;
}

async function evaluateInContext(target, expression, contextId) {
  const params = {
    expression,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true
  };
  if (contextId !== null && contextId !== undefined) {
    params.contextId = contextId;
  }
  const result = await debuggerCommand(target, 'Runtime.evaluate', params);
  if (result.exceptionDetails) {
    return { success: false, err: result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate exception', details: result.exceptionDetails };
  }
  return { success: true, val: result.result?.value };
}

function frameSelectorProbeExpression(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { success: false, err: 'No frame found for selector ' + ${JSON.stringify(selector)} };
    const frames = Array.from(document.querySelectorAll('iframe,frame'));
    const rect = el.getBoundingClientRect();
    return {
      success: true,
      frameIndex: frames.indexOf(el),
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      clientLeft: el.clientLeft || 0,
      clientTop: el.clientTop || 0
    };
  })()`;
}

function directChildFrames(frameTree, frameId) {
  if (!frameTree) return [];
  if (frameTree.frame?.id === frameId) return frameTree.childFrames || [];
  for (const child of frameTree.childFrames || []) {
    const found = directChildFrames(child, frameId);
    if (found.length || child.frame?.id === frameId) return found;
  }
  return [];
}

async function frameExecutionContext(target, frameId) {
  const world = await debuggerCommand(target, 'Page.createIsolatedWorld', {
    frameId,
    worldName: 'chrome-native-bridge',
    grantUniveralAccess: true
  });
  return world.executionContextId;
}

async function describeTopFrameElement(target, rootNodeId, selector) {
  const queried = await debuggerCommand(target, 'DOM.querySelector', { nodeId: rootNodeId, selector });
  if (!queried.nodeId) return null;
  const described = await debuggerCommand(target, 'DOM.describeNode', { nodeId: queried.nodeId, depth: 1, pierce: false });
  return described.node || null;
}



async function resolveActionTarget(tabId, locator, attachedTarget) {
  const run = async (target) => {
    const pageTree = await debuggerCommand(target, 'Page.getFrameTree', {});
    const topFrameId = pageTree.frameTree.frame.id;
    const doc = await debuggerCommand(target, 'DOM.getDocument', { depth: 1, pierce: false });
    let currentFrameId = topFrameId;
    let currentContextId = null;
    let currentRootNodeId = doc.root.nodeId;
    let offsetX = 0;
    let offsetY = 0;

    for (const frameSelector of locator.frames) {
      let describedNode = null;
      if (currentRootNodeId !== null) {
        describedNode = await describeTopFrameElement(target, currentRootNodeId, frameSelector);
      }
      const frameProbe = await evaluateInContext(target, frameSelectorProbeExpression(frameSelector), currentContextId);
      const frameInfo = frameProbe.val || {};
      if (!frameProbe.success || frameInfo.success === false) {
        return { success: false, err: `No frame found for selector ${frameSelector}` };
      }
      let childFrameId = describedNode?.frameId || describedNode?.contentDocument?.frameId || null;
      const children = directChildFrames(pageTree.frameTree, currentFrameId);
      if (!childFrameId && frameInfo.frameIndex >= 0 && children[frameInfo.frameIndex]) {
        childFrameId = children[frameInfo.frameIndex].frame.id;
      }
      if (!childFrameId || !children.some((child) => child.frame.id === childFrameId)) {
        return { success: false, err: `No frame found for selector ${frameSelector}` };
      }
      offsetX += (frameInfo.x || 0) + (frameInfo.clientLeft || 0);
      offsetY += (frameInfo.y || 0) + (frameInfo.clientTop || 0);
      currentFrameId = childFrameId;
      currentContextId = await frameExecutionContext(target, currentFrameId);
      currentRootNodeId = null;
    }

    // Element refs resolve from the live CDP node rather than a re-query, so
    // stage them into the execution context the action will actually run in.
    const staged = await stageLocatorRefs(target, [locator], currentContextId);
    if (staged.success === false) return staged;

    const lookup = await evaluateInContext(target, actionTargetExpression(locator, 'center'), currentContextId);
    const value = lookup.val || lookup;
    if (!lookup.success || value.success === false) return value;
    return {
      ...value,
      x: (value.x || 0) + offsetX,
      y: (value.y || 0) + offsetY,
      frameId: currentFrameId,
      contextId: currentContextId,
      locator
    };
  };
  if (attachedTarget) return run(attachedTarget);
  return withDebugger(tabId, run);
}

async function focusActionTarget(target, resolved, clear) {
  const lookup = await evaluateInContext(target, actionTargetExpression(resolved.locator, clear ? 'clear' : 'focus'), resolved.contextId);
  const value = lookup.val || lookup;
  if (!lookup.success || value.success === false) return value;
  return value;
}

async function waitForSelector(tabId, selector, timeoutMs) {
  let locator;
  try {
    locator = parseActionLocator(selector, tabId);
  } catch (error) {
    return locatorError(error);
  }
  const deadline = deadlineFrom(timeoutMs);
  while (Date.now() <= deadline) {
    const found = await resolveActionTarget(tabId, locator);
    if (found.success !== false) return { success: true, selector };
    await sleep(250);
  }
  return { success: false, err: "Timed out waiting for selector", selector, timeoutMs };
}

async function pageContainsText(tabId, text) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (expected) => (document.body?.innerText || document.documentElement?.innerText || '').includes(expected),
      args: [String(text || '')]
    });
    return results[0]?.result === true;
  } catch (error) {
    return false;
  }
}

async function waitForText(tabId, text, timeoutMs) {
  const deadline = deadlineFrom(timeoutMs);
  while (Date.now() <= deadline) {
    if (await pageContainsText(tabId, text)) return { success: true, text };
    await sleep(250);
  }
  return { success: false, err: "Timed out waiting for text", text, timeoutMs };
}

async function getCurrentState(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const observe = await observeTab(tabId, { compact: true, limit: 50 });
  return {
    success: true,
    tab: {
      id: tab.id,
      windowId: tab.windowId,
      active: tab.active,
      status: tab.status,
      title: tab.title,
      url: tab.url
    },
    observe
  };
}

async function captureScreenshot(tabId, format, quiet = true) {
  const screenshotFormat = format || "png";
  if (quiet) {
    return withDebugger(tabId, async (target) => {
      const result = await debuggerCommand(target, "Page.captureScreenshot", { format: screenshotFormat });
      const mimeType = screenshotFormat === "jpeg" ? "image/jpeg" : "image/png";
      return { success: true, mimeType, dataUrl: `data:${mimeType};base64,${result.data}` };
    });
  }
  const activated = await activateTab(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(activated.windowId, { format: screenshotFormat });
  const mimeType = screenshotFormat === "jpeg" ? "image/jpeg" : "image/png";
  return { success: true, mimeType, dataUrl };
}

// Background-safe PDF export over the same debugger-attach path as screenshot.
// Returns base64 only; writing the file is the caller's job so raw PDF bytes
// never travel through a transcript.
async function printToPDF(tabId, options) {
  const opts = options && typeof options === "object" ? options : {};
  const params = { transferMode: "ReturnAsBase64" };
  const positive = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  };
  if (opts.landscape !== undefined) params.landscape = opts.landscape === true;
  if (opts.printBackground !== undefined) params.printBackground = opts.printBackground === true;
  for (const name of ["scale", "paperWidth", "paperHeight"]) {
    if (opts[name] === undefined || opts[name] === null) continue;
    const parsed = positive(opts[name]);
    if (parsed === null) return { success: false, err: `printToPDF ${name} must be a positive number` };
    params[name] = parsed;
  }
  if (opts.pageRanges !== undefined && opts.pageRanges !== null) {
    if (typeof opts.pageRanges !== "string") {
      return { success: false, err: 'printToPDF pageRanges must be a string such as "1-3,5"' };
    }
    if (opts.pageRanges) params.pageRanges = opts.pageRanges;
  }
  return withDebugger(tabId, async (target) => {
    const result = await debuggerCommand(target, "Page.printToPDF", params);
    const base64 = result && typeof result.data === "string" ? result.data : "";
    if (!base64) return { success: false, err: "Page.printToPDF returned no data" };
    return { success: true, mimeType: "application/pdf", base64 };
  });
}

async function extractText(tabId, maxChars, scanInjection) {
  const limit = maxChars || 20000;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (maxLength) => {
      const raw = document.body ? document.body.innerText : document.documentElement?.innerText;
      const text = raw || '';
      return { text: text.slice(0, maxLength), originalLength: text.length };
    },
    args: [limit]
  });
  const result = results[0]?.result || { text: '', originalLength: 0 };
  const out = {
    success: true,
    text: result.text,
    truncated: result.originalLength > limit,
    chars: result.text.length
  };
  if (scanInjection === true) out.injectionScan = scanTextForInjection(out.text);
  return out;
}

async function getHTML(tabId, scanInjection) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.documentElement?.outerHTML || ''
  });
  const html = results[0]?.result || '';
  const out = { success: true, html };
  if (scanInjection === true) out.injectionScan = scanTextForInjection(html);
  return out;
}

// ST6: heuristic prompt-injection signatures. Page text is data, never
// instruction: these patterns only flag text that *looks* like it is trying to
// steer an agent, its tools, its secrets, or its policy. A hit is a warning for
// the operator, never an authorization decision, and a miss is not a clean bill
// of health.
const PROMPT_INJECTION_SIGNATURES = [
  { kind: "instructionOverride", severity: "high", pattern: /(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier|above|preceding)\s+(?:instructions?|prompts?|rules?|directions?|guidance)/ },
  { kind: "instructionOverride", severity: "medium", pattern: /\b(?:new|updated|revised)\s+(?:system\s+)?instructions?\s*:/ },
  { kind: "systemPromptDisclosure", severity: "high", pattern: /(?:reveal|show|print|repeat|output|disclose|dump)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:system\s+prompt|initial\s+instructions|hidden\s+(?:prompt|instructions)|developer\s+(?:prompt|message))/ },
  { kind: "credentialExfiltration", severity: "high", pattern: /(?:send|post|upload|exfiltrate|leak|email|share|transmit)\s+(?:me\s+|us\s+)?(?:the\s+|your\s+|all\s+)?(?:api\s+keys?|access\s+tokens?|tokens?|passwords?|credentials?|secrets?|cookies?|session\s+(?:id|token))/ },
  { kind: "credentialExfiltration", severity: "high", pattern: /(?:copy|dump|read|grab)\s+(?:the\s+|all\s+|my\s+)?(?:cookies?|local\s?storage|session\s?storage|browser\s+storage|keychain|bridge[_-]?token|\.env)/ },
  { kind: "shellExecution", severity: "high", pattern: /(?:run|execute|exec|paste)\s+(?:the\s+following\s+|this\s+)?(?:shell|bash|zsh|powershell|terminal|system)?\s*(?:command|script)/ },
  { kind: "shellExecution", severity: "high", pattern: /curl\s+\S+\s*\|\s*(?:ba|z)?sh/ },
  { kind: "policyTampering", severity: "high", pattern: /(?:disable|bypass|turn\s+off|skip|remove|relax)\s+(?:the\s+|any\s+|all\s+)?(?:polic(?:y|ies)|safety(?:\s+checks?)?|guardrails?|confirmations?|security\s+checks?|sandbox|allowlist)/ },
  { kind: "operatorConcealment", severity: "high", pattern: /(?:do\s+not|don't|never)\s+(?:tell|inform|notify|mention\s+(?:this\s+)?to|show|ask)\s+(?:the\s+)?(?:user|human|operator|owner)/ },
  { kind: "permissionCoercion", severity: "medium", pattern: /(?:click|press|choose|select|tap)\s+(?:on\s+)?(?:the\s+)?["']?(?:allow|accept|approve|confirm|grant|continue|yes)\b/ },
  { kind: "permissionCoercion", severity: "medium", pattern: /(?:approve|confirm|authorize)\s+(?:this|the)\s+(?:action|request|payment|transfer|purchase)/ },
  { kind: "toolRedirection", severity: "medium", pattern: /\b(?:ai|agent|assistant|language\s+model|llm|chatgpt|claude|copilot|gemini)\b\s*[,:]?\s*(?:you\s+(?:must|should|shall|will|need\s+to|are\s+required\s+to)|please\s+(?:now\s+)?(?:run|open|navigate|send|call))/ },
  { kind: "toolRedirection", severity: "medium", pattern: /<\s*\/?\s*(?:system|assistant|developer|instructions?)\s*>/ },
  { kind: "dataExfiltration", severity: "medium", pattern: /https?:\/\/\S*[?&](?:token|api[_-]?key|secret|password|cookie|session)=/ }
];

const INJECTION_SNIPPET_CHARS = 160;
const INJECTION_MATCHES_PER_SIGNATURE = 3;
const INJECTION_MAX_MATCHES = 25;

// Scans text already inside the extension. Only bounded snippets leave here, so
// a scan never becomes a second channel for the full page body.
function scanTextForInjection(text) {
  const source = typeof text === "string" ? text : "";
  const matches = [];
  for (const signature of PROMPT_INJECTION_SIGNATURES) {
    if (matches.length >= INJECTION_MAX_MATCHES) break;
    const regex = new RegExp(signature.pattern.source, "gi");
    let found = 0;
    let hit;
    while ((hit = regex.exec(source)) !== null) {
      if (hit[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      const start = Math.max(0, hit.index - 24);
      const snippet = source.slice(start, start + INJECTION_SNIPPET_CHARS).replace(/\s+/g, " ").trim();
      matches.push({ kind: signature.kind, severity: signature.severity, snippet });
      found += 1;
      if (found >= INJECTION_MATCHES_PER_SIGNATURE || matches.length >= INJECTION_MAX_MATCHES) break;
    }
  }
  const risk = matches.some((m) => m.severity === "high")
    ? "high"
    : matches.some((m) => m.severity === "medium") ? "medium" : "low";
  return { risk, matches, scannedChars: source.length };
}

function scopedTextExpression(locator, maxChars) {
  return `(() => {
    ${locator ? locatorResolverSource() : ""}
    let root = document.body || document.documentElement;
    ${locator ? `const resolved = resolveLocator(${JSON.stringify(locator)});
    if (!resolved.success) return resolved;
    root = resolved.el;` : ""}
    const raw = root ? (root.innerText || root.textContent || '') : '';
    const limit = ${JSON.stringify(maxChars)};
    return { success: true, text: raw.slice(0, limit), originalLength: raw.length };
  })()`;
}

function clampChars(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), 200000);
}

// Reads text from a selector subtree (or the whole body) in the main frame.
// Cross-origin iframe subtrees are out of reach here; scope to the frame's own
// tab instead.
async function extractScopedText(tabId, selector, maxChars) {
  const limit = clampChars(maxChars, 20000);
  let locator = null;
  if (selector) {
    try {
      locator = parseActionLocator(selector, tabId);
    } catch (error) {
      return locatorError(error);
    }
  }
  return withDebugger(tabId, async (target) => {
    const result = await evaluateWithDebugger(target, scopedTextExpression(locator, limit));
    if (!result.success) return result;
    const value = result.val || {};
    if (value.success === false) return value;
    const text = typeof value.text === "string" ? value.text : "";
    return {
      success: true,
      text,
      chars: text.length,
      truncated: Number(value.originalLength || 0) > limit
    };
  });
}

async function scanPromptInjection(tabId, selector, maxChars) {
  const extracted = await extractScopedText(tabId, selector, maxChars);
  if (extracted.success === false) return extracted;
  const scan = scanTextForInjection(extracted.text);
  return {
    success: true,
    risk: scan.risk,
    matches: scan.matches,
    scannedChars: scan.scannedChars,
    truncated: extracted.truncated === true
  };
}

// ST5: schema-driven extraction. The subset is deliberately tiny (object,
// array, string, number, boolean, enum, required, properties, items) so both
// the extractor and the validator stay deterministic and reviewable.
const STRUCTURED_SCHEMA_VERSION = "json-schema-subset/1";
const STRUCTURED_SCHEMA_KEYWORDS = new Set(["type", "properties", "required", "items", "enum", "title", "description"]);
const STRUCTURED_SCALAR_TYPES = new Set(["string", "number", "boolean"]);

function schemaError(path, code, message) {
  return { path: path || "$", code, message };
}

// Rejects anything outside the subset up front: an unsupported keyword must not
// be silently ignored, or callers would believe a constraint was enforced.
function validateSchemaSubset(schema, path, errors) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(schemaError(path, "unsupportedSchema", "Schema nodes must be JSON objects"));
    return;
  }
  for (const keyword of Object.keys(schema)) {
    if (!STRUCTURED_SCHEMA_KEYWORDS.has(keyword)) {
      errors.push(schemaError(path, "unsupportedSchema", `Unsupported schema keyword: ${keyword}`));
    }
  }
  const type = schema.type;
  if (type !== undefined) {
    if (typeof type !== "string" || !(STRUCTURED_SCALAR_TYPES.has(type) || type === "object" || type === "array")) {
      errors.push(schemaError(path, "unsupportedSchema", "type must be one of object, array, string, number, boolean"));
      return;
    }
  } else if (!Array.isArray(schema.enum)) {
    errors.push(schemaError(path, "unsupportedSchema", "Schema nodes require a type (or an enum)"));
    return;
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      errors.push(schemaError(path, "unsupportedSchema", "enum must be a non-empty array"));
    } else if (schema.enum.some((item) => !["string", "number", "boolean"].includes(typeof item))) {
      errors.push(schemaError(path, "unsupportedSchema", "enum members must be strings, numbers, or booleans"));
    }
  }
  if (type === "object") {
    if (schema.properties === undefined || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
      errors.push(schemaError(path, "unsupportedSchema", "object schemas require a properties map"));
      return;
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string")) {
        errors.push(schemaError(path, "unsupportedSchema", "required must be an array of property names"));
      } else {
        for (const name of schema.required) {
          if (!Object.prototype.hasOwnProperty.call(schema.properties, name)) {
            errors.push(schemaError(path, "unsupportedSchema", `required names an unknown property: ${name}`));
          }
        }
      }
    }
    for (const [name, child] of Object.entries(schema.properties)) {
      validateSchemaSubset(child, `${path}.${name}`, errors);
    }
    return;
  }
  if (type === "array") {
    if (schema.items === undefined) {
      errors.push(schemaError(path, "unsupportedSchema", "array schemas require items"));
      return;
    }
    validateSchemaSubset(schema.items, `${path}[]`, errors);
    return;
  }
  if (schema.properties !== undefined || schema.items !== undefined || schema.required !== undefined) {
    errors.push(schemaError(path, "unsupportedSchema", "properties, items, and required apply only to object/array schemas"));
  }
}

function normalizeFieldKey(value) {
  return String(value === undefined || value === null ? "" : value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function fieldAliases(name, schema) {
  const aliases = new Set();
  const add = (value) => {
    const key = normalizeFieldKey(value);
    if (key) aliases.add(key);
  };
  add(name);
  add(String(name || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
  if (schema && typeof schema.title === "string") add(schema.title);
  return aliases;
}

function coerceScalarValue(schema, raw) {
  const text = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!text) return { ok: false, reason: "empty value" };
  const type = schema.type || (Array.isArray(schema.enum) ? typeof schema.enum[0] : "string");
  let value;
  if (type === "number") {
    const match = text.replace(/[,\u00a0]/g, "").match(/-?\d+(?:\.\d+)?/);
    if (!match) return { ok: false, reason: `not a number: ${text.slice(0, 40)}` };
    value = Number(match[0]);
    if (!Number.isFinite(value)) return { ok: false, reason: `not a number: ${text.slice(0, 40)}` };
  } else if (type === "boolean") {
    if (/^(true|yes|y|on|enabled|checked|1)$/i.test(text)) value = true;
    else if (/^(false|no|n|off|disabled|unchecked|0)$/i.test(text)) value = false;
    else return { ok: false, reason: `not a boolean: ${text.slice(0, 40)}` };
  } else {
    value = text;
  }
  if (Array.isArray(schema.enum)) {
    const member = schema.enum.find((item) => normalizeFieldKey(item) === normalizeFieldKey(value));
    if (member === undefined) return { ok: false, reason: `value is not in enum: ${text.slice(0, 40)}` };
    value = member;
  }
  return { ok: true, value };
}

function lookupPairValue(evidence, aliases) {
  const exact = evidence.pairs.find((pair) => aliases.has(pair.normalizedKey));
  if (exact) return exact.value;
  const partial = evidence.pairs.find((pair) => Array.from(aliases).some((alias) => alias.length >= 4 && (pair.normalizedKey.includes(alias) || alias.includes(pair.normalizedKey))));
  return partial ? partial.value : null;
}

function extractObjectValue(schema, evidence, path, errors) {
  const required = Array.isArray(schema.required) ? schema.required : [];
  const data = {};
  let matched = 0;
  for (const [name, child] of Object.entries(schema.properties || {})) {
    const childPath = `${path}.${name}`;
    const extracted = extractSchemaValue(child, name, evidence, childPath, errors);
    if (extracted.found) {
      data[name] = extracted.value;
      matched += 1;
      continue;
    }
    // Optional fields are omitted rather than guessed; required fields report.
    if (required.includes(name)) {
      errors.push(schemaError(childPath, "missingRequired", extracted.reason || `No confident value found for required field ${name}`));
    }
  }
  return { found: matched > 0 || Object.keys(schema.properties || {}).length === 0, value: data };
}

function extractArrayValue(schema, name, evidence, path, errors) {
  const items = schema.items || {};
  if (items.type === "object") {
    const properties = Object.entries(items.properties || {});
    const aliasMap = properties.map(([propName, propSchema]) => ({ propName, propSchema, aliases: fieldAliases(propName, propSchema) }));
    const table = evidence.tables.find((candidate) => candidate.normalizedHeaders.some((header) => aliasMap.some((entry) => entry.aliases.has(header))));
    if (!table) return { found: false, reason: `No table matched item properties for ${name}` };
    const required = Array.isArray(items.required) ? items.required : [];
    const rows = [];
    table.rows.forEach((cells, index) => {
      const row = {};
      let filled = 0;
      for (const entry of aliasMap) {
        const column = table.normalizedHeaders.findIndex((header) => entry.aliases.has(header));
        if (column < 0 || column >= cells.length) continue;
        const coerced = coerceScalarValue(entry.propSchema, cells[column]);
        if (!coerced.ok) continue;
        row[entry.propName] = coerced.value;
        filled += 1;
      }
      if (filled === 0) return;
      for (const propName of required) {
        if (!Object.prototype.hasOwnProperty.call(row, propName)) {
          errors.push(schemaError(`${path}[${index}].${propName}`, "missingRequired", `Row ${index} has no confident value for required field ${propName}`));
        }
      }
      rows.push(row);
    });
    if (!rows.length) return { found: false, reason: `Table for ${name} produced no usable rows` };
    return { found: true, value: rows };
  }
  const aliases = fieldAliases(name, schema);
  const list = evidence.lists.find((candidate) => aliases.has(candidate.normalizedLabel)) ||
    evidence.lists.find((candidate) => candidate.normalizedLabel && Array.from(aliases).some((alias) => alias.length >= 4 && candidate.normalizedLabel.includes(alias)));
  let raws = list ? list.items : null;
  if (!raws) {
    const pairValue = lookupPairValue(evidence, aliases);
    if (pairValue) raws = pairValue.split(/\s*[;,\n]\s*/).filter(Boolean);
  }
  if (!raws || !raws.length) return { found: false, reason: `No list or delimited value matched ${name}` };
  const values = [];
  for (const raw of raws) {
    const coerced = coerceScalarValue(items, raw);
    if (coerced.ok) values.push(coerced.value);
  }
  if (!values.length) return { found: false, reason: `No item in ${name} matched the item schema` };
  return { found: true, value: values };
}

function extractSchemaValue(schema, name, evidence, path, errors) {
  const type = schema.type || "string";
  if (type === "object") return extractObjectValue(schema, evidence, path, errors);
  if (type === "array") return extractArrayValue(schema, name, evidence, path, errors);
  const aliases = fieldAliases(name, schema);
  const raw = lookupPairValue(evidence, aliases);
  if (raw === null) return { found: false, reason: `No labelled value matched ${name}` };
  const coerced = coerceScalarValue(schema, raw);
  if (!coerced.ok) {
    errors.push(schemaError(path, "typeMismatch", coerced.reason));
    return { found: false, reason: coerced.reason };
  }
  return { found: true, value: coerced.value };
}

// Second pass over the produced data: the extractor is heuristic, the validator
// is not, so nothing ships that the schema does not describe.
function validateStructuredData(schema, value, path, errors) {
  const type = schema.type || (Array.isArray(schema.enum) ? typeof schema.enum[0] : "string");
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(schemaError(path, "typeMismatch", "expected an object"));
      return;
    }
    const properties = schema.properties || {};
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(schemaError(`${path}.${key}`, "unexpectedProperty", "value is not described by the schema"));
        delete value[key];
        continue;
      }
      validateStructuredData(properties[key], value[key], `${path}.${key}`, errors);
    }
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(schemaError(`${path}.${key}`, "missingRequired", "required field is absent from the extracted data"));
      }
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      errors.push(schemaError(path, "typeMismatch", "expected an array"));
      return;
    }
    value.forEach((item, index) => validateStructuredData(schema.items || {}, item, `${path}[${index}]`, errors));
    return;
  }
  if (typeof value !== type) {
    errors.push(schemaError(path, "typeMismatch", `expected ${type}`));
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(schemaError(path, "enumMismatch", "value is not an enum member"));
  }
}

// In-page evidence harvest. Only label/value pairs, table shapes, and list
// items come back; the raw body text stays in the page.
function structuredHarvestExpression(locator, maxChars) {
  return `(() => {
    ${locator ? locatorResolverSource() : ""}
    let root = document.body || document.documentElement;
    ${locator ? `const resolved = resolveLocator(${JSON.stringify(locator)});
    if (!resolved.success) return resolved;
    root = resolved.el;` : ""}
    if (!root) return { success: false, err: 'No document body to extract from' };
    const limit = ${JSON.stringify(maxChars)};
    const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const pairs = [];
    const seen = new Set();
    const addPair = (key, value, source) => {
      if (pairs.length >= 500) return;
      const k = clean(key);
      const v = clean(value);
      if (!k || !v || k.length > 120 || v.length > 2000) return;
      const dedupe = source + '|' + k.toLowerCase() + '|' + v;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      pairs.push({ key: k, value: v, source });
    };
    const text = (el) => (el ? (el.innerText || el.textContent || '') : '');
    for (const dt of root.querySelectorAll('dt')) {
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD') addPair(text(dt), text(dd), 'definitionList');
    }
    for (const row of root.querySelectorAll('tr')) {
      const header = row.querySelector(':scope > th');
      const cells = Array.from(row.querySelectorAll(':scope > td'));
      if (header && cells.length === 1) addPair(text(header), text(cells[0]), 'tableRow');
    }
    const controlValue = (el) => {
      if (el.tagName === 'SELECT') {
        const option = el.selectedOptions && el.selectedOptions[0];
        return option ? (option.text || option.value) : el.value;
      }
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return el.checked ? 'true' : 'false';
      if ('value' in el && typeof el.value === 'string') return el.value;
      return text(el);
    };
    const labelFor = (el) => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria;
      const id = el.getAttribute('id');
      if (id) {
        const label = root.querySelector('label[for="' + CSS.escape(id) + '"]') || document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (label) return text(label);
      }
      const wrapping = el.closest ? el.closest('label') : null;
      if (wrapping) return text(wrapping);
      return el.getAttribute('name') || el.getAttribute('placeholder') || '';
    };
    for (const el of root.querySelectorAll('input, textarea, select')) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'password' || type === 'hidden' || type === 'file') continue;
      addPair(labelFor(el), controlValue(el), 'formControl');
      const name = el.getAttribute('name');
      if (name) addPair(name, controlValue(el), 'nameAttribute');
    }
    for (const el of root.querySelectorAll('[itemprop], [data-field]')) {
      const key = el.getAttribute('itemprop') || el.getAttribute('data-field');
      addPair(key, el.getAttribute('content') || text(el), 'microdata');
    }
    for (const el of root.querySelectorAll('[aria-label]')) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) continue;
      addPair(el.getAttribute('aria-label'), text(el), 'ariaLabel');
    }
    for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const next = heading.nextElementSibling;
      if (next && !/^H[1-6]$/.test(next.tagName)) addPair(text(heading), text(next), 'heading');
    }
    const body = (root.innerText || root.textContent || '').slice(0, limit);
    for (const line of body.split(/\\n+/)) {
      const match = line.match(/^\\s*([^:\\t]{1,60}?)\\s*:\\s*(.+?)\\s*$/);
      if (match) addPair(match[1], match[2], 'textLine');
    }
    const tables = [];
    for (const table of root.querySelectorAll('table')) {
      if (tables.length >= 20) break;
      const firstRow = table.querySelector('tr');
      const headerCells = Array.from(table.querySelectorAll('thead th'));
      const headerRow = headerCells.length ? headerCells : Array.from(firstRow ? firstRow.querySelectorAll('th') : []);
      const headers = headerRow.map((cell) => clean(text(cell)));
      if (headers.length < 2) continue;
      const rows = [];
      for (const row of table.querySelectorAll('tr')) {
        const cells = Array.from(row.querySelectorAll(':scope > td'));
        if (cells.length < 2) continue;
        rows.push(cells.map((cell) => clean(text(cell))));
        if (rows.length >= 200) break;
      }
      if (rows.length) tables.push({ headers, rows });
    }
    const lists = [];
    for (const list of root.querySelectorAll('ul, ol')) {
      if (lists.length >= 50) break;
      const items = Array.from(list.querySelectorAll(':scope > li')).map((li) => clean(text(li))).filter(Boolean).slice(0, 200);
      if (!items.length) continue;
      const previous = list.previousElementSibling;
      const label = list.getAttribute('aria-label') || (previous ? clean(text(previous)) : '');
      lists.push({ label: clean(label).slice(0, 120), items });
    }
    return { success: true, pairs, tables, lists, chars: body.length, truncated: (root.innerText || root.textContent || '').length > limit };
  })()`;
}

const STRUCTURED_SOURCE_PRIORITY = ["definitionList", "tableRow", "formControl", "microdata", "ariaLabel", "nameAttribute", "heading", "textLine"];

function buildStructuredEvidence(harvest) {
  const pairs = (Array.isArray(harvest.pairs) ? harvest.pairs : [])
    .map((pair, index) => ({
      normalizedKey: normalizeFieldKey(pair.key),
      value: typeof pair.value === "string" ? pair.value : "",
      rank: STRUCTURED_SOURCE_PRIORITY.indexOf(pair.source),
      index
    }))
    .filter((pair) => pair.normalizedKey && pair.value)
    .sort((a, b) => {
      const left = a.rank < 0 ? STRUCTURED_SOURCE_PRIORITY.length : a.rank;
      const right = b.rank < 0 ? STRUCTURED_SOURCE_PRIORITY.length : b.rank;
      return left === right ? a.index - b.index : left - right;
    });
  const tables = (Array.isArray(harvest.tables) ? harvest.tables : []).map((table) => ({
    normalizedHeaders: (Array.isArray(table.headers) ? table.headers : []).map((header) => normalizeFieldKey(header)),
    rows: (Array.isArray(table.rows) ? table.rows : []).filter((row) => Array.isArray(row))
  }));
  const lists = (Array.isArray(harvest.lists) ? harvest.lists : []).map((list) => ({
    normalizedLabel: normalizeFieldKey(list.label),
    items: (Array.isArray(list.items) ? list.items : []).filter((item) => typeof item === "string" && item)
  }));
  return { pairs, tables, lists };
}

async function extractStructured(tabId, schema, selector, maxChars) {
  const schemaErrors = [];
  validateSchemaSubset(schema, "$", schemaErrors);
  if (schemaErrors.length) {
    return {
      success: false,
      err: `Schema is outside the supported subset: ${schemaErrors[0].message}`,
      errors: schemaErrors,
      schemaVersion: STRUCTURED_SCHEMA_VERSION
    };
  }
  const limit = clampChars(maxChars, 20000);
  let locator = null;
  if (selector) {
    try {
      locator = parseActionLocator(selector, tabId);
    } catch (error) {
      return locatorError(error);
    }
  }
  const harvest = await withDebugger(tabId, async (target) => {
    const result = await evaluateWithDebugger(target, structuredHarvestExpression(locator, limit));
    if (!result.success) return result;
    const value = result.val || {};
    if (value.success === false) return value;
    return { success: true, harvest: value };
  });
  if (harvest.success === false) return harvest;
  const evidence = buildStructuredEvidence(harvest.harvest);
  const errors = [];
  const extracted = extractSchemaValue(schema, "$", evidence, "$", errors);
  const data = extracted.found ? extracted.value : (schema.type === "array" ? [] : (schema.type === "object" ? {} : null));
  if (!extracted.found && schema.type !== "object") {
    errors.push(schemaError("$", "missingRequired", extracted.reason || "No confident value found for the root schema"));
  }
  // A root scalar that matched nothing is already reported above; re-validating
  // the null placeholder would only add a redundant type error.
  if (extracted.found || schema.type === "object" || schema.type === "array") {
    validateStructuredData(schema, data, "$", errors);
  }
  // The extraction pass and the validation pass can flag the same field; report
  // each path/code once, keeping the more specific extraction message.
  const seenErrors = new Set();
  const uniqueErrors = errors.filter((item) => {
    const key = `${item.path}|${item.code}`;
    if (seenErrors.has(key)) return false;
    seenErrors.add(key);
    return true;
  });
  return {
    success: true,
    data,
    errors: uniqueErrors,
    schemaVersion: STRUCTURED_SCHEMA_VERSION,
    chars: Number(harvest.harvest.chars || 0),
    truncated: harvest.harvest.truncated === true
  };
}

async function getElementCenter(target, selector) {
  let locator;
  try {
    locator = parseActionLocator(selector, target.tabId);
  } catch (error) {
    return locatorError(error);
  }
  return resolveActionTarget(target.tabId, locator, target);
}

async function isTabActive(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active !== true || tab.windowId === undefined) return false;
    const window = await chrome.windows.get(tab.windowId);
    return window.focused === true;
  } catch (error) {
    return false;
  }
}

async function showAgentPointer(tabId, x, y, click = false) {
  const preferences = await loadBridgePreferences();
  if (preferences.showAgentPointer === false || !(await isTabActive(tabId))) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (left, top, shouldClick) => {
        const id = "__chrome_bridge_pointer__";
        document.getElementById(id)?.remove();
        const host = document.createElement("div");
        host.id = id;
        host.setAttribute("aria-hidden", "true");
        host.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:1px;height:1px;z-index:2147483647;pointer-events:none;contain:layout style paint`;
        const root = host.attachShadow({ mode: "closed" });
        const style = document.createElement("style");
        style.textContent = `
          :host{all:initial;pointer-events:none}
          .pointer{position:absolute;left:-5px;top:-5px;width:21px;height:27px;transform:translate(-2px,-2px) rotate(-12deg);filter:drop-shadow(0 4px 8px rgba(17,19,24,.36));animation:bridge-arrive 160ms cubic-bezier(.2,.8,.2,1) both}
          .pointer:before{content:"";position:absolute;inset:0;background:linear-gradient(145deg,#f5f0e8 8%,#9b6cff 54%,#47d7c8 100%);clip-path:polygon(0 0,79% 62%,51% 65%,66% 100%,51% 100%,37% 69%,17% 89%);}
          .pointer:after{content:"✦";position:absolute;left:17px;top:-11px;color:#47d7c8;font:700 12px system-ui;text-shadow:0 0 9px rgba(71,215,200,.95)}
          .ripple{position:absolute;left:-15px;top:-15px;width:30px;height:30px;border:2px solid #9b6cff;border-radius:50%;box-shadow:0 0 0 5px rgba(71,215,200,.16);animation:bridge-ripple 460ms ease-out both}
          @keyframes bridge-arrive{from{opacity:0;transform:translate(-7px,-7px) rotate(-12deg) scale(.72)}to{opacity:1;transform:translate(-2px,-2px) rotate(-12deg) scale(1)}}
          @keyframes bridge-ripple{from{opacity:.92;transform:scale(.28)}to{opacity:0;transform:scale(1.45)}}
          @media (prefers-reduced-motion:reduce){.pointer,.ripple{animation-duration:.01ms!important}}
        `;
        const pointer = document.createElement("div");
        pointer.className = "pointer";
        root.append(style, pointer);
        if (shouldClick) {
          const ripple = document.createElement("div");
          ripple.className = "ripple";
          root.appendChild(ripple);
        }
        (document.body || document.documentElement).appendChild(host);
        setTimeout(() => host.remove(), shouldClick ? 650 : 900);
      },
      args: [x, y, click === true],
    });
    return true;
  } catch (_error) {
    return false;
  }
}

async function clickSelector(tabId, selector) {
  return withDebugger(tabId, async (target) => {
    const lookup = await getElementCenter(target, selector);
    if (lookup.success === false) return lookup;
    if (lookup.contextId !== null && lookup.contextId !== undefined || !(await isTabActive(tabId))) {
      const click = await evaluateInContext(target, domClickExpression(lookup.locator), lookup.contextId);
      const value = click.val || click;
      if (!click.success || value.success === false) return value;
      return { success: true, tagName: value.tagName, text: value.text };
    }
    const { x, y } = lookup;
    const pointerShown = await showAgentPointer(tabId, x, y, true);
    if (pointerShown) await sleep(160);
    await debuggerCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await debuggerCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await debuggerCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    return { success: true, tagName: lookup.tagName, text: lookup.text };
  });
}

// Coordinate click. This bypasses selector resolution entirely, so there is no
// element identity to audit; the example policy confirmation-gates it.
async function clickAt(tabId, x, y) {
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0) {
    return { success: false, err: "clickAt requires non-negative numeric x and y viewport coordinates" };
  }
  return withDebugger(tabId, async (target) => {
    await debuggerCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0 });
    await debuggerCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 });
    await debuggerCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 });
    return { success: true, tabId, x: px, y: py };
  });
}

async function typeSelector(tabId, selector, text) {
  return withDebugger(tabId, async (target) => {
    const lookup = await getElementCenter(target, selector);
    if (lookup.success === false) return lookup;
    const focus = await focusActionTarget(target, lookup, false);
    if (focus.success === false) return focus;
    await debuggerCommand(target, 'Input.insertText', { text });
    const value = await focusActionTarget(target, lookup, false);
    if (value.success === false) return value;
    return { success: true, tagName: focus.tagName, value: value.value };
  });
}

async function hoverSelector(tabId, selector) {
  return withDebugger(tabId, async (target) => {
    const lookup = await getElementCenter(target, selector);
    if (lookup.success === false) return lookup;
    const pointerShown = await showAgentPointer(tabId, lookup.x, lookup.y, false);
    if (pointerShown) await sleep(100);
    await debuggerCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: lookup.x, y: lookup.y, button: 'none' });
    return { success: true, tagName: lookup.tagName, text: lookup.text };
  });
}

async function scrollTarget(tabId, deltaX, deltaY, selector) {
  return withDebugger(tabId, async (target) => {
    let point;
    let locator = null;
    if (selector) {
      try {
        locator = parseActionLocator(selector, tabId);
      } catch (error) {
        return locatorError(error);
      }
      point = await resolveActionTarget(tabId, locator, target);
      if (point.success === false) return point;
    } else {
      const center = await evaluateWithDebugger(target, '({ x: innerWidth / 2, y: innerHeight / 2 })');
      if (!center.success) return center;
      point = center.val;
    }
    if (!(await isTabActive(tabId))) {
      const scrolled = await evaluateInContext(target, domScrollExpression(locator, deltaX, deltaY), point.contextId);
      const value = scrolled.val || scrolled;
      if (!scrolled.success || value.success === false) return value;
      return value;
    }
    await debuggerCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY });
    return { success: true, deltaX, deltaY };
  });
}

function keyDefinition(key) {
  const map = {
    Enter: { key: 'Enter', code: 'Enter', vk: 13 },
    Escape: { key: 'Escape', code: 'Escape', vk: 27 },
    Tab: { key: 'Tab', code: 'Tab', vk: 9 },
    Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
    Delete: { key: 'Delete', code: 'Delete', vk: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    Home: { key: 'Home', code: 'Home', vk: 36 },
    End: { key: 'End', code: 'End', vk: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
    Space: { key: ' ', code: 'Space', vk: 32 }
  };
  if (map[key]) return map[key];
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return { key, code: `Key${upper}`, vk: upper.charCodeAt(0) };
  }
  return null;
}

async function pressKey(tabId, keySpec) {
  return withDebugger(tabId, async (target) => {
    const parts = String(keySpec || '').split('+').filter(Boolean);
    const key = parts.pop();
    const modifierMap = { Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Command: 4, Cmd: 4, Shift: 8 };
    let modifiers = 0;
    for (const part of parts) modifiers |= modifierMap[part] || 0;
    const def = keyDefinition(key);
    if (!def) return { success: false, err: `Unsupported key: ${key}` };
    if (key.length === 1 && modifiers === 0) {
      await debuggerCommand(target, 'Input.insertText', { text: key });
      return { success: true, key: keySpec };
    }
    const event = {
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      nativeVirtualKeyCode: def.vk,
      modifiers
    };
    await debuggerCommand(target, 'Input.dispatchKeyEvent', { ...event, type: 'keyDown' });
    await debuggerCommand(target, 'Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
    return { success: true, key: keySpec };
  });
}

async function dragSelector(tabId, fromSelector, toSelector) {
  return withDebugger(tabId, async (target) => {
    let fromLocator;
    let toLocator;
    try {
      fromLocator = parseActionLocator(fromSelector, tabId);
      toLocator = parseActionLocator(toSelector, tabId);
    } catch (error) {
      return locatorError(error);
    }
    const from = await resolveActionTarget(tabId, fromLocator, target);
    if (from.success === false) return from;
    const to = await resolveActionTarget(tabId, toLocator, target);
    if (to.success === false) return to;
    if (from.contextId !== to.contextId) {
      return { success: false, err: 'Drag source and target must be in the same frame context' };
    }
    const drag = await evaluateInContext(target, domDragExpression(fromLocator, toLocator), from.contextId);
    const value = drag.val || drag;
    if (!drag.success || value.success === false) return value;
    return { success: true, from: fromSelector, to: toSelector, dom: value };
  });
}

async function fillSelector(tabId, selector, text) {
  return withDebugger(tabId, async (target) => {
    const lookup = await getElementCenter(target, selector);
    if (lookup.success === false) return lookup;
    const focus = await focusActionTarget(target, lookup, true);
    if (focus.success === false) return focus;
    await debuggerCommand(target, 'Input.insertText', { text });
    const value = await focusActionTarget(target, lookup, false);
    if (value.success === false) return value;
    return { success: true, tagName: focus.tagName, value: value.value };
  });
}

async function selectOption(tabId, selector, value) {
  return withDebugger(tabId, async (target) => {
    let locator;
    try {
      locator = parseActionLocator(selector, tabId);
    } catch (error) {
      return locatorError(error);
    }
    const resolved = await resolveActionTarget(tabId, locator, target);
    if (resolved.success === false) return resolved;
    const result = await evaluateInContext(target, domSelectExpression(locator, value), resolved.contextId);
    return result.val || result;
  });
}

async function assertGitHubTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let origin = null;
  try {
    origin = tab.url ? new URL(tab.url).origin : null;
  } catch (error) {
    origin = null;
  }
  if (origin !== "https://github.com") {
    return { success: false, err: "GitHub action requires a https://github.com tab", origin, url: tab.url || null };
  }
  return { success: true, origin, url: tab.url || null };
}

function githubAttachExpression(locator, formSelector, timeoutMs) {
  return `(() => new Promise((resolve) => {
    ${locatorResolverSource()}
    const inputResult = resolveLocator(${JSON.stringify(locator)});
    if (!inputResult.success) {
      resolve(inputResult);
      return;
    }
    const input = inputResult.el;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') {
      resolve({ success: false, err: 'GitHub attachment target must be a file input' });
      return;
    }
    if (!input.files || input.files.length === 0) {
      resolve({ success: false, err: 'No files are set on the GitHub attachment input' });
      return;
    }
    const attachment = input.closest('file-attachment');
    if (!attachment || typeof attachment.attach !== 'function') {
      resolve({ success: false, err: 'No GitHub file-attachment.attach(input.files) component found' });
      return;
    }
    const formSelector = ${JSON.stringify(formSelector || null)};
    const explicitRoot = formSelector ? document.querySelector(formSelector) : null;
    if (formSelector && !explicitRoot) {
      resolve({ success: false, err: 'No GitHub comment form matched formSelector' });
      return;
    }
    const root = explicitRoot || input.closest('form') || attachment.closest('form') || document.querySelector('.js-comment-form');
    if (!root) {
      resolve({ success: false, err: 'No GitHub comment form found for attachment' });
      return;
    }
    const textarea = root.querySelector('textarea');
    if (!textarea) {
      resolve({ success: false, err: 'No GitHub comment textarea found for attachment' });
      return;
    }
    const timeoutMs = ${JSON.stringify(timeoutMs || 30000)};
    const deadline = Date.now() + timeoutMs;
    const assetPattern = /user-attachments\\/assets\\/[A-Za-z0-9._-]+/g;
    Promise.resolve(attachment.attach(input.files)).catch((error) => {
      resolve({ success: false, err: String(error && error.message || error) });
    });
    const poll = () => {
      const value = textarea.value || '';
      const assets = Array.from(new Set(value.match(assetPattern) || []));
      if (!value.includes('Uploading') && assets.length >= input.files.length) {
        resolve({ success: true, files: input.files.length, assets, valueLength: value.length });
        return;
      }
      if (Date.now() > deadline) {
        resolve({ success: false, err: 'Timed out waiting for GitHub attachment markdown', files: input.files.length, assets, uploading: value.includes('Uploading') });
        return;
      }
      setTimeout(poll, 250);
    };
    poll();
  }))()`;
}

function githubSubmitExpression(formSelector, timeoutMs) {
  return `(() => new Promise((resolve) => {
    const formSelector = ${JSON.stringify(formSelector || null)};
    const explicitRoot = formSelector ? document.querySelector(formSelector) : null;
    if (formSelector && !explicitRoot) {
      resolve({ success: false, err: 'No GitHub comment form matched formSelector' });
      return;
    }
    const activeForm = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.js-comment-form') : null;
    const commentForms = Array.from(document.querySelectorAll('.js-comment-form'));
    const root = explicitRoot || activeForm || (commentForms.length === 1 ? commentForms[0] : null);
    if (!root) {
      resolve({ success: false, err: 'No GitHub comment form found' });
      return;
    }
    const allowedLabels = new Set(['Comment', 'Add comment']);
    const forbiddenLabels = new Set(['Close with comment']);
    const buttons = Array.from(root.querySelectorAll('button[type="submit"], input[type="submit"]'))
      .filter((button) => !button.disabled && button.offsetParent !== null)
      .map((button) => ({ button, text: ((button.innerText || button.value || button.textContent || '').trim().replace(/\\s+/g, ' ')) }));
    const forbidden = buttons.find(({ text }) => forbiddenLabels.has(text));
    if (forbidden) {
      resolve({ success: false, err: 'Refusing to click GitHub Close with comment button' });
      return;
    }
    const matches = buttons.filter(({ text }) => allowedLabels.has(text));
    if (matches.length !== 1) {
      resolve({ success: false, err: 'Expected exactly one GitHub Comment or Add comment submit button', labels: buttons.map(({ text }) => text) });
      return;
    }
    matches[0].button.click();
    const timeoutMs = ${JSON.stringify(timeoutMs || 10000)};
    setTimeout(() => resolve({ success: true, label: matches[0].text }), Math.min(timeoutMs, 1000));
  }))()`;
}

async function githubAttachUploadedFiles(tabId, inputSelector, formSelector, timeoutMs) {
  const gate = await assertGitHubTab(tabId);
  if (gate.success === false) return gate;
  return withDebugger(tabId, async (target) => {
    let locator;
    try {
      locator = parseActionLocator(inputSelector, tabId);
    } catch (error) {
      return locatorError(error);
    }
    const resolved = await resolveActionTarget(tabId, locator, target);
    if (resolved.success === false) return resolved;
    const result = await evaluateInContext(target, githubAttachExpression(locator, formSelector, timeoutMs), resolved.contextId);
    return result.val || result;
  });
}

async function githubSubmitComment(tabId, formSelector, timeoutMs) {
  const gate = await assertGitHubTab(tabId);
  if (gate.success === false) return gate;
  return withDebugger(tabId, async (target) => {
    const result = await evaluateInContext(target, githubSubmitExpression(formSelector, timeoutMs), null);
    return result.val || result;
  });
}

function githubPrBodyEditorExpression(timeoutMs) {
  return `(() => new Promise((resolve) => {
    const timeoutMs = ${JSON.stringify(timeoutMs || 30000)};
    const deadline = Date.now() + timeoutMs;
    const root = document.querySelector('.js-command-palette-pull-body');
    if (!root) {
      resolve({ success: false, err: 'No GitHub pull-request body container found' });
      return;
    }
    const findEditor = () => {
      const form = root.querySelector('form.js-comment-update');
      const textarea = form && form.querySelector('textarea.js-comment-field');
      const input = form && form.querySelector('file-attachment input[type="file"]');
      const attachment = input && input.closest('file-attachment');
      return form && textarea && input && attachment && form.offsetParent !== null
        ? { form, textarea, input, attachment }
        : null;
    };
    const waitForEditor = () => {
      const editor = findEditor();
      if (editor) {
        resolve({ success: true });
        return;
      }
      if (Date.now() > deadline) {
        resolve({ success: false, err: 'Timed out waiting for GitHub pull-request body editor' });
        return;
      }
      setTimeout(waitForEditor, 200);
    };
    if (findEditor()) {
      resolve({ success: true, alreadyOpen: true });
      return;
    }
    const menu = root.querySelector('summary[aria-haspopup="menu"]');
    if (!menu || !menu.querySelector('svg[aria-label="Show options"]')) {
      resolve({ success: false, err: 'No GitHub pull-request body options menu found' });
      return;
    }
    menu.click();
    const waitForEdit = () => {
      const editButtons = Array.from(root.querySelectorAll('button.js-comment-edit-button[aria-label="Edit comment"]'))
        .filter((button) => button.offsetParent !== null);
      if (editButtons.length === 1) {
        editButtons[0].click();
        waitForEditor();
        return;
      }
      if (Date.now() > deadline) {
        resolve({ success: false, err: 'Timed out waiting for GitHub pull-request body Edit action', matches: editButtons.length });
        return;
      }
      setTimeout(waitForEdit, 200);
    };
    waitForEdit();
  }))()`;
}

function githubPrBodyInputExpression() {
  return `(() => {
    const root = document.querySelector('.js-command-palette-pull-body');
    const form = root && root.querySelector('form.js-comment-update');
    const inputs = form && form.offsetParent !== null
      ? Array.from(form.querySelectorAll('file-attachment input[type="file"]'))
      : [];
    if (inputs.length !== 1) throw new Error('Expected exactly one GitHub pull-request body file input');
    return inputs[0];
  })()`;
}

function githubPrBodyAttachAndSaveExpression(fileCount, timeoutMs) {
  return `(() => new Promise((resolve) => {
    const root = document.querySelector('.js-command-palette-pull-body');
    const form = root && root.querySelector('form.js-comment-update');
    const textarea = form && form.querySelector('textarea.js-comment-field');
    const input = form && form.querySelector('file-attachment input[type="file"]');
    const attachment = input && input.closest('file-attachment');
    if (!form || !textarea || !input || !attachment || typeof attachment.attach !== 'function') {
      resolve({ success: false, err: 'GitHub pull-request body attachment editor is incomplete' });
      return;
    }
    if (!input.files || input.files.length !== ${JSON.stringify(fileCount)}) {
      resolve({ success: false, err: 'GitHub pull-request body file input did not receive every requested file', files: input.files ? input.files.length : 0 });
      return;
    }
    const assetPattern = /https:\/\/github\.com\/user-attachments\/assets\/[A-Za-z0-9._-]+/g;
    const before = new Set((textarea.value || '').match(assetPattern) || []);
    const timeoutMs = ${JSON.stringify(timeoutMs || 30000)};
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    Promise.resolve(attachment.attach(input.files)).catch((error) => {
      if (!settled) {
        settled = true;
        resolve({ success: false, err: String(error && error.message || error) });
      }
    });
    const poll = () => {
      if (settled) return;
      const value = textarea.value || '';
      const assets = Array.from(new Set(value.match(assetPattern) || []));
      const addedAssets = assets.filter((asset) => !before.has(asset));
      const uploading = /Uploading/i.test(value);
      if (!uploading && addedAssets.length >= ${JSON.stringify(fileCount)}) {
        const submitButtons = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]'))
          .filter((button) => !button.disabled && button.offsetParent !== null)
          .map((button) => ({ button, text: ((button.innerText || button.value || button.textContent || '').trim().replace(/\\s+/g, ' ')) }))
          .filter(({ text }) => text === 'Update comment' || text === 'Save');
        if (submitButtons.length !== 1) {
          settled = true;
          resolve({ success: false, err: 'Expected exactly one GitHub pull-request body save button', labels: submitButtons.map(({ text }) => text), addedAssets });
          return;
        }
        submitButtons[0].button.click();
        const label = submitButtons[0].text;
        const waitForSave = () => {
          const editorVisible = form.querySelector('textarea.js-comment-field') && form.offsetParent !== null;
          if (!editorVisible) {
            settled = true;
            resolve({ success: true, files: ${JSON.stringify(fileCount)}, assets: addedAssets, saved: true, label });
            return;
          }
          if (Date.now() > deadline) {
            settled = true;
            resolve({ success: false, err: 'Timed out waiting for GitHub pull-request body save', files: ${JSON.stringify(fileCount)}, assets: addedAssets });
            return;
          }
          setTimeout(waitForSave, 200);
        };
        waitForSave();
        return;
      }
      if (Date.now() > deadline) {
        settled = true;
        resolve({ success: false, err: 'Timed out waiting for GitHub pull-request body attachment markdown', files: ${JSON.stringify(fileCount)}, addedAssets, uploading });
        return;
      }
      setTimeout(poll, 250);
    };
    poll();
  }))()`;
}

async function githubAttachPrBody(tabId, files, timeoutMs) {
  const gate = await assertGitHubTab(tabId);
  if (gate.success === false) return gate;
  let path = null;
  try {
    path = new URL(gate.url).pathname;
  } catch (error) {
    path = null;
  }
  if (!path || !/^\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/.test(path)) {
    return { success: false, err: 'GitHub PR-body attachment requires a /owner/repo/pull/number page', path };
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { success: false, err: 'At least one attachment file is required' };
  }
  return withDebugger(tabId, async (target) => {
    const opened = await evaluateInContext(target, githubPrBodyEditorExpression(timeoutMs), null);
    const openedValue = opened.val || opened;
    if (!opened.success || openedValue.success === false) return openedValue;

    const evaluated = await debuggerCommand(target, 'Runtime.evaluate', {
      expression: githubPrBodyInputExpression(),
      awaitPromise: true,
      returnByValue: false,
      allowUnsafeEvalBlockedByCSP: true
    });
    if (evaluated.exceptionDetails || !evaluated.result?.objectId) {
      return { success: false, err: evaluated.exceptionDetails?.exception?.description || evaluated.exceptionDetails?.text || 'No GitHub pull-request body file input object found' };
    }
    await debuggerCommand(target, 'DOM.setFileInputFiles', { objectId: evaluated.result.objectId, files });
    const attached = await evaluateInContext(target, githubPrBodyAttachAndSaveExpression(files.length, timeoutMs), null);
    return attached.val || attached;
  });
}

async function uploadFile(tabId, selector, files) {
  return withDebugger(tabId, async (target) => {
    let locator;
    try {
      locator = parseActionLocator(selector, tabId);
    } catch (error) {
      return locatorError(error);
    }
    const resolved = await resolveActionTarget(tabId, locator, target);
    if (resolved.success === false) return resolved;
    const params = {
      expression: elementObjectExpression(locator),
      awaitPromise: true,
      returnByValue: false,
      allowUnsafeEvalBlockedByCSP: true
    };
    if (resolved.contextId !== null && resolved.contextId !== undefined) {
      params.contextId = resolved.contextId;
    }
    const evaluated = await debuggerCommand(target, "Runtime.evaluate", params);
    if (evaluated.exceptionDetails) {
      return { success: false, err: evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || 'Runtime.evaluate exception', details: evaluated.exceptionDetails };
    }
    if (!evaluated.result?.objectId) {
      return { success: false, err: 'No element object resolved for selector: ' + selector };
    }
    await debuggerCommand(target, 'DOM.setFileInputFiles', { objectId: evaluated.result.objectId, files });
    return { success: true, selector, files: files.length };
  });
}

async function setViewport(tabId, width, height, deviceScaleFactor) {
  if (width <= 0 || height <= 0) return { success: false, err: "Viewport width and height must be positive" };
  return withDebugger(tabId, async (target) => {
    const scale = deviceScaleFactor || 1;
    await debuggerCommand(target, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    return { success: true, width, height, deviceScaleFactor: scale };
  });
}

async function setCpuThrottling(tabId, rate) {
  const throttlingRate = Number(rate);
  if (!Number.isFinite(throttlingRate) || throttlingRate < 1) return { success: false, err: 'CPU throttling rate must be >= 1' };
  return withDebugger(tabId, async (target) => {
    await debuggerCommand(target, 'Emulation.setCPUThrottlingRate', { rate: throttlingRate });
    return { success: true, tabId, rate: throttlingRate };
  });
}

async function setNetworkConditions(tabId, offline, latency, downloadThroughput, uploadThroughput) {
  const conditions = {
    offline: !!offline,
    latency: latency !== undefined && latency !== null ? Number(latency) : 0,
    downloadThroughput: downloadThroughput !== undefined && downloadThroughput !== null ? Number(downloadThroughput) : -1,
    uploadThroughput: uploadThroughput !== undefined && uploadThroughput !== null ? Number(uploadThroughput) : -1
  };
  return withDebugger(tabId, async (target) => {
    await debuggerCommand(target, 'Network.enable', {});
    await debuggerCommand(target, 'Network.emulateNetworkConditions', conditions);
    return { success: true, tabId, offline: conditions.offline };
  });
}

async function clearNetworkConditions(tabId) {
  return withDebugger(tabId, async (target) => {
    await debuggerCommand(target, 'Network.enable', {});
    await debuggerCommand(target, 'Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    return { success: true, tabId };
  });
}

async function setColorScheme(tabId, scheme) {
  if (!['light', 'dark', 'no-preference'].includes(scheme)) return { success: false, err: 'scheme must be light|dark|no-preference' };
  return withDebugger(tabId, async (target) => {
    await debuggerCommand(target, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    return { success: true, tabId, scheme };
  });
}

async function setUserAgent(tabId, userAgent) {
  if (typeof userAgent !== 'string' || !userAgent.trim()) return { success: false, err: 'userAgent must be a non-empty string' };
  return withDebugger(tabId, async (target) => {
    await debuggerCommand(target, 'Network.enable', {});
    await debuggerCommand(target, 'Network.setUserAgentOverride', { userAgent });
    return { success: true, tabId };
  });
}

// HI2/HI3: stable per-tab element refs plus the previous observe snapshot used
// for diffing. This lives only in service-worker memory: a worker restart or a
// navigation invalidates every ref for that tab. The counter never rewinds, so
// a ref minted before a navigation can never silently point at a new element.
const REF_SNAPSHOT_CAP = 5000;
const REF_PAGE_STORE_LIMIT = 8;
const refRegistries = new Map();

function refRegistry(tabId) {
  let registry = refRegistries.get(tabId);
  if (!registry) {
    registry = { counter: 0, epoch: 0, byRef: new Map(), byKey: new Map(), snapshot: null, snapshotEpoch: null };
    refRegistries.set(tabId, registry);
  }
  return registry;
}

function invalidateRefs(tabId) {
  const registry = refRegistries.get(tabId);
  if (!registry) return;
  registry.byRef.clear();
  registry.byKey.clear();
  registry.snapshot = null;
  registry.snapshotEpoch = null;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  refRegistries.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") invalidateRefs(tabId);
});

function observeNodeKey(node) {
  return node.backendDOMNodeId ? `dom:${node.backendDOMNodeId}` : `ax:${node.nodeId}`;
}

function assignRef(registry, node) {
  const key = observeNodeKey(node);
  let ref = registry.byKey.get(key);
  if (!ref) {
    registry.counter += 1;
    ref = `e${registry.counter}`;
    registry.byKey.set(key, ref);
  }
  registry.byRef.set(ref, { key, backendDOMNodeId: node.backendDOMNodeId || null });
  return ref;
}

function trimRefRegistry(registry) {
  while (registry.byRef.size > REF_SNAPSHOT_CAP) {
    const oldest = registry.byRef.keys().next().value;
    const entry = registry.byRef.get(oldest);
    registry.byRef.delete(oldest);
    if (entry) registry.byKey.delete(entry.key);
  }
}

function diffSnapshots(previous, current) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [ref, node] of current) {
    const before = previous.get(ref);
    if (!before) {
      added.push(node);
      continue;
    }
    if (before.role !== node.role || before.name !== node.name || (before.value ?? null) !== (node.value ?? null)) {
      changed.push(node);
    }
  }
  for (const ref of previous.keys()) {
    if (!current.has(ref)) removed.push(ref);
  }
  return { added, removed, changed };
}

function bindLocatorRefs(tokens, tabId) {
  const registry = tabId === undefined || tabId === null ? null : refRegistries.get(tabId);
  for (const token of tokens) {
    if (!token || token.kind !== "ref") continue;
    const entry = registry ? registry.byRef.get(token.ref) : null;
    if (!entry || !entry.backendDOMNodeId) throw new StaleRefError(token.ref);
    token.backendDOMNodeId = entry.backendDOMNodeId;
  }
}

const REF_STAGE_FUNCTION = `function (ref) {
  const view = (this.ownerDocument && this.ownerDocument.defaultView) || self;
  const store = view.__chromeBridgeRefs instanceof Map ? view.__chromeBridgeRefs : new Map();
  view.__chromeBridgeRefs = store;
  store.delete(ref);
  store.set(ref, this);
  while (store.size > ${REF_PAGE_STORE_LIMIT}) store.delete(store.keys().next().value);
  return true;
}`;

// Resolve each ref token against its live CDP node and stash the element in the
// page so the injected resolver can pick it up by ref. A node that no longer
// resolves is a stale ref, never a fallback to selector matching.
async function stageLocatorRefs(target, locators, contextId) {
  const tokens = [];
  for (const locator of locators) {
    if (!locator) continue;
    for (const token of [locator.target, ...(locator.shadowSegments || [])]) {
      if (token && token.kind === "ref") tokens.push(token);
    }
  }
  if (!tokens.length) return { success: true, staged: 0 };
  for (const token of tokens) {
    if (!token.backendDOMNodeId) return staleRefResponse(token.ref);
    let objectId = null;
    const resolveParams = { backendNodeId: token.backendDOMNodeId };
    if (contextId !== null && contextId !== undefined) resolveParams.executionContextId = contextId;
    try {
      const resolved = await debuggerCommand(target, 'DOM.resolveNode', resolveParams);
      objectId = resolved?.object?.objectId || null;
    } catch (error) {
      objectId = null;
    }
    if (!objectId) return staleRefResponse(token.ref);
    try {
      await debuggerCommand(target, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: REF_STAGE_FUNCTION,
        arguments: [{ value: token.ref }],
        returnByValue: true
      });
    } catch (error) {
      return staleRefResponse(token.ref);
    }
    try {
      await debuggerCommand(target, 'Runtime.releaseObject', { objectId });
    } catch (error) {
      // Releasing the handle is best-effort; the page store owns the element.
    }
  }
  return { success: true, staged: tokens.length };
}

async function observeTab(tabId, options = {}) {
  return withDebugger(tabId, async (target) => {
    const ax = await debuggerCommand(target, 'Accessibility.getFullAXTree', {});
    const compact = options.compact === true;
    const requestedRoles = Array.isArray(options.roles)
      ? new Set(options.roles.map((role) => String(role || '').toLowerCase()).filter(Boolean))
      : null;
    const requestedName = String(options.name || '').trim().toLowerCase();
    const rawLimit = Number(options.limit);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.floor(rawLimit))) : (compact ? 50 : 250);
    let nodes = (ax.nodes || []).filter((node) => !node.ignored);
    if (requestedRoles && requestedRoles.size) {
      nodes = nodes.filter((node) => requestedRoles.has(String(node.role?.value || '').toLowerCase()));
    }
    if (requestedName) {
      nodes = nodes.filter((node) => String(node.name?.value || '').toLowerCase().includes(requestedName));
    }
    if (compact) {
      const usefulRoles = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'tab', 'heading', 'img']);
      nodes = nodes.filter((node) => usefulRoles.has(String(node.role?.value || '').toLowerCase()) || node.name?.value || node.value?.value);
    }
    const registry = refRegistry(tabId);
    const current = new Map();
    const results = nodes.slice(0, limit).map((node) => {
      const ref = assignRef(registry, node);
      const basic = {
        ref,
        role: node.role?.value || null,
        name: node.name?.value || '',
      };
      if (node.value?.value != null) basic.value = node.value.value;
      const entry = compact ? basic : {
        nodeId: node.nodeId,
        backendDOMNodeId: node.backendDOMNodeId || null,
        ...basic,
        description: node.description?.value || null,
        properties: Object.fromEntries((node.properties || []).map((prop) => [prop.name, prop.value?.value ?? prop.value?.description ?? null]))
      };
      if (current.size < REF_SNAPSHOT_CAP) current.set(ref, entry);
      return entry;
    });
    trimRefRegistry(registry);
    const baseSnapshot = registry.snapshot;
    const baseEpoch = registry.snapshotEpoch;
    registry.epoch += 1;
    const epoch = registry.epoch;
    registry.snapshot = current;
    registry.snapshotEpoch = epoch;
    if (options.diff !== true) return results;
    if (!baseSnapshot) return { success: true, tabId, epoch, diffBase: true, nodes: results };
    return { success: true, tabId, baseEpoch, epoch, ...diffSnapshots(baseSnapshot, current) };
  });
}

async function startMonitoring(tabId) {
  if (monitors.has(tabId)) return { success: true, tabId, already: true };
  const target = { tabId };
  const taskSession = await findTaskSessionForTab(tabId);
  const taskLease = taskSession
    ? await acquireTaskDebugger(tabId, taskSession.sessionId, "monitor")
    : null;
  const attachedHere = !interceptors.has(tabId) && !screencasts.has(tabId) && !taskLease;
  if (attachedHere) {
    await debuggerAttach(target);
  }
  monitors.set(tabId, { console: [], network: new Map(), dialogs: [] });
  try {
    await debuggerCommand(target, 'Runtime.enable', {});
    await debuggerCommand(target, 'Log.enable', {});
    await debuggerCommand(target, 'Network.enable', {});
    await debuggerCommand(target, 'Page.enable', {});
  } catch (error) {
    monitors.delete(tabId);
    if (taskLease) {
      releaseTaskDebugger(taskLease);
    } else if (attachedHere && !interceptors.has(tabId) && !screencasts.has(tabId)) {
      await debuggerDetach(target);
    }
    throw error;
  }
  return { success: true, tabId, already: false };
}

async function stopMonitoring(tabId) {
  if (!monitors.has(tabId)) return { success: true, tabId, alreadyStopped: true };
  monitors.delete(tabId);
  const state = taskDebuggerStates.get(tabId);
  if (state) {
    state.holders.delete("monitor");
    scheduleTaskDebuggerDetach(tabId);
  } else if (!interceptors.has(tabId) && !screencasts.has(tabId)) {
    await debuggerDetach({ tabId });
  }
  return { success: true, tabId };
}

async function startScreencast(tabId, options = {}) {
  if (screencasts.has(tabId)) return { success: true, tabId, recording: true, already: true };
  const format = options.format === "png" ? "png" : "jpeg";
  const rawQuality = Number(options.quality);
  const quality = Number.isFinite(rawQuality) ? Math.min(100, Math.max(1, Math.round(rawQuality))) : 70;
  const rawEvery = Number(options.everyNthFrame);
  const everyNthFrame = Number.isFinite(rawEvery) && rawEvery >= 1 ? Math.round(rawEvery) : 1;
  const params = { format, everyNthFrame };
  // CDP applies quality to jpeg only; sending it with png is meaningless.
  if (format === "jpeg") params.quality = quality;
  const maxWidth = Number(options.maxWidth);
  if (Number.isFinite(maxWidth) && maxWidth > 0) params.maxWidth = Math.round(maxWidth);
  const maxHeight = Number(options.maxHeight);
  if (Number.isFinite(maxHeight) && maxHeight > 0) params.maxHeight = Math.round(maxHeight);
  const target = { tabId };
  // Same ownership rule as startMonitoring: attach only if nothing else already
  // holds the debugger for this tab, so recording never activates the tab.
  const heldByOther = monitors.has(tabId) || interceptors.has(tabId);
  if (!heldByOther) await debuggerAttach(target);
  screencasts.set(tabId, {
    frames: [],
    bytes: 0,
    droppedFrames: 0,
    captured: 0,
    format,
    startedAt: Date.now()
  });
  try {
    await debuggerCommand(target, 'Page.enable', {});
    await debuggerCommand(target, 'Page.startScreencast', params);
  } catch (error) {
    screencasts.delete(tabId);
    if (!heldByOther) await debuggerDetach(target);
    throw error;
  }
  return {
    success: true,
    tabId,
    recording: true,
    already: false,
    format,
    quality: params.quality ?? null,
    everyNthFrame,
    frameLimit: SCREENCAST_FRAME_LIMIT,
    byteLimit: SCREENCAST_BYTE_LIMIT
  };
}

function screencastFrames(tabId, consume = true) {
  const session = screencasts.get(tabId);
  if (!session) return { success: false, err: `Screencast is not active for tab ${tabId}; run startScreencast first` };
  const frames = session.frames;
  const droppedFrames = session.droppedFrames;
  if (consume) {
    session.frames = [];
    session.bytes = 0;
    session.droppedFrames = 0;
  }
  return {
    success: true,
    tabId,
    recording: true,
    consumed: consume,
    format: session.format,
    frameCount: frames.length,
    capturedFrames: session.captured,
    droppedFrames,
    frames
  };
}

async function stopScreencast(tabId) {
  const session = screencasts.get(tabId);
  if (!session) return { success: true, tabId, recording: false, alreadyStopped: true, remainingFrames: 0 };
  const remainingFrames = session.frames.length;
  const droppedFrames = session.droppedFrames;
  const capturedFrames = session.captured;
  // Delete first so the frame listener stops buffering (and stops acking) while
  // the stop command is in flight.
  screencasts.delete(tabId);
  const target = { tabId };
  try {
    await debuggerCommand(target, 'Page.stopScreencast', {});
  } catch (error) {
    // The tab may already be gone; the session is stopped either way.
  }
  if (!monitors.has(tabId) && !interceptors.has(tabId)) {
    await debuggerDetach(target);
  }
  return {
    success: true,
    tabId,
    recording: false,
    alreadyStopped: false,
    remainingFrames,
    droppedFrames,
    capturedFrames
  };
}

// HI7: raw generated locations for every captured console/error stack frame.
// CDP reports 0-based line/column; we pass them through untouched so a caller
// can correlate with `Debugger` output, and any resolved original location
// uses the same 0-based convention.
const STACK_FRAME_LIMIT = 20;

function captureStackFrames(stackTrace) {
  const frames = [];
  let trace = stackTrace;
  // Walk async parents too: the interesting frame for a console error raised in
  // a promise chain often lives above the synchronous callFrames.
  while (trace && frames.length < STACK_FRAME_LIMIT) {
    for (const frame of trace.callFrames || []) {
      if (frames.length >= STACK_FRAME_LIMIT) break;
      frames.push({
        url: frame.url || "",
        lineNumber: typeof frame.lineNumber === "number" ? frame.lineNumber : null,
        columnNumber: typeof frame.columnNumber === "number" ? frame.columnNumber : null,
        functionName: frame.functionName || "",
        scriptId: frame.scriptId || null
      });
    }
    trace = trace.parent;
  }
  return frames;
}

// --- HI7: best-effort source-map resolution --------------------------------
// Parsed maps live in service-worker memory only, keyed per (tab, script URL),
// and are dropped when the tab closes. Source TEXT is never retained or
// returned: we read a script solely to find its sourceMappingURL comment, and
// `sourcesContent` from the map is ignored. A sourceMappingURL that resolves
// off the script's own origin is refused rather than fetched, so resolution
// never reaches a third-party origin.
const SOURCE_MAP_CACHE_LIMIT = 100;
const SOURCE_MAP_SOURCE_BYTES = 8 * 1024 * 1024;
const sourceMapCache = new Map();

function sourceMapCacheKey(tabId, scriptUrl) {
  return `${tabId}\n${scriptUrl}`;
}

function sourceMapCacheGet(key) {
  if (!sourceMapCache.has(key)) return undefined;
  const entry = sourceMapCache.get(key);
  // Re-insert so the bounded cache evicts genuinely cold scripts, not the hot
  // bundle that every stack frame points at.
  sourceMapCache.delete(key);
  sourceMapCache.set(key, entry);
  return entry;
}

function sourceMapCacheSet(key, entry) {
  sourceMapCache.set(key, entry);
  while (sourceMapCache.size > SOURCE_MAP_CACHE_LIMIT) {
    const oldest = sourceMapCache.keys().next();
    if (oldest.done) break;
    sourceMapCache.delete(oldest.value);
  }
  return entry;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const prefix = `${tabId}\n`;
  for (const key of [...sourceMapCache.keys()]) {
    if (key.startsWith(prefix)) sourceMapCache.delete(key);
  }
});

const VLQ_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VLQ_DIGITS = new Map([...VLQ_ALPHABET].map((char, index) => [char, index]));

// Minimal source-map v3 base64 VLQ decoder. Returns null for any malformed
// segment so a corrupt map is reported as `invalid` instead of silently
// producing bogus original positions.
function decodeVlq(segment) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = VLQ_DIGITS.get(char);
    if (digit === undefined) return null;
    value += (digit & 31) * Math.pow(2, shift);
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    const negative = (value & 1) === 1;
    value = Math.floor(value / 2);
    values.push(negative ? -value : value);
    value = 0;
    shift = 0;
  }
  if (shift !== 0) return null;
  return values;
}

// `mappings` -> one array of segments per generated line, each segment already
// carrying absolute (not delta) indices.
function decodeMappings(mappings) {
  const lines = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;
  for (const group of mappings.split(";")) {
    const segments = [];
    let generatedColumn = 0;
    if (group) {
      for (const raw of group.split(",")) {
        if (!raw) continue;
        const fields = decodeVlq(raw);
        if (!fields || fields.length === 0) return null;
        generatedColumn += fields[0];
        if (fields.length === 1) {
          segments.push({ generatedColumn, sourceIndex: -1, originalLine: -1, originalColumn: -1, nameIndex: -1 });
          continue;
        }
        if (fields.length < 4) return null;
        sourceIndex += fields[1];
        originalLine += fields[2];
        originalColumn += fields[3];
        const named = fields.length > 4;
        if (named) nameIndex += fields[4];
        segments.push({
          generatedColumn,
          sourceIndex,
          originalLine,
          originalColumn,
          nameIndex: named ? nameIndex : -1
        });
      }
      segments.sort((a, b) => a.generatedColumn - b.generatedColumn);
    }
    lines.push(segments);
  }
  return lines;
}

function resolveSourcePath(source, sourceRoot, mapUrl) {
  const prefixed = sourceRoot ? `${String(sourceRoot).replace(/\/?$/, "/")}${source}` : source;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(prefixed)) return prefixed;
  if (!mapUrl || mapUrl.startsWith("data:")) return prefixed;
  try {
    return new URL(prefixed, mapUrl).href;
  } catch (error) {
    return prefixed;
  }
}

function parseSourceMap(text, mapUrl) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return null;
  }
  if (!raw || raw.version !== 3 || typeof raw.mappings !== "string") return null;
  // Index maps (`sections`) are out of scope for this minimal decoder.
  if (Array.isArray(raw.sections)) return null;
  const lines = decodeMappings(raw.mappings);
  if (!lines) return null;
  const sources = (Array.isArray(raw.sources) ? raw.sources : [])
    .map((source) => resolveSourcePath(String(source ?? ""), raw.sourceRoot, mapUrl));
  const names = (Array.isArray(raw.names) ? raw.names : []).map((name) => String(name ?? ""));
  // `sourcesContent` is deliberately dropped: we resolve positions, never text.
  return { lines, sources, names };
}

function resolveMappedPosition(map, lineNumber, columnNumber) {
  if (typeof lineNumber !== "number" || lineNumber < 0) return null;
  const segments = map.lines[lineNumber];
  if (!segments || segments.length === 0) return null;
  const column = typeof columnNumber === "number" && columnNumber >= 0 ? columnNumber : 0;
  let match = null;
  for (const segment of segments) {
    if (segment.generatedColumn > column) break;
    match = segment;
  }
  // A frame left of the first mapping on the line still belongs to that line's
  // first mapped region far more often than to nothing at all.
  if (!match) match = segments[0];
  if (!match || match.sourceIndex < 0) return null;
  const source = map.sources[match.sourceIndex];
  if (source === undefined) return null;
  return {
    source,
    name: match.nameIndex >= 0 ? (map.names[match.nameIndex] ?? null) : null,
    lineNumber: match.originalLine,
    columnNumber: match.originalColumn
  };
}

function sourceMappingUrlFrom(scriptSource) {
  // Only the LAST comment counts, and it must not be inside the code we skim:
  // bundlers always emit it on its own trailing line.
  const pattern = /^[#@]\s*sourceMappingURL=(\S+)\s*$/;
  const tail = scriptSource.slice(-4096).split("\n");
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const line = tail[index].trim();
    if (!line.startsWith("//") && !line.startsWith("/*")) continue;
    const body = line.replace(/^\/\*/, "").replace(/\*\/$/, "").replace(/^\/\//, "").trim();
    const match = pattern.exec(body);
    if (match) return match[1];
  }
  return null;
}

async function scriptSourceFor(context, scriptUrl, scriptId) {
  // Prefer CDP: it returns exactly the bytes the page executed, including
  // sources a plain fetch would re-request (or be denied).
  if (scriptId && !context.debuggerFailed) {
    try {
      if (!context.debuggerEnabled) {
        await debuggerCommand({ tabId: context.tabId }, "Debugger.enable", {});
        context.debuggerEnabled = true;
      }
      const response = await debuggerCommand({ tabId: context.tabId }, "Debugger.getScriptSource", { scriptId });
      if (response && typeof response.scriptSource === "string") return response.scriptSource;
    } catch (error) {
      // One failure means the domain is unusable for this pass; stop retrying.
      if (!context.debuggerEnabled) context.debuggerFailed = true;
    }
  }
  try {
    const response = await fetch(scriptUrl, { credentials: "omit", cache: "force-cache" });
    if (!response.ok) return null;
    const text = await response.text();
    return text.length > SOURCE_MAP_SOURCE_BYTES ? null : text;
  } catch (error) {
    return null;
  }
}

async function releaseScriptSourceContext(context) {
  if (!context.debuggerEnabled) return;
  context.debuggerEnabled = false;
  try {
    await debuggerCommand({ tabId: context.tabId }, "Debugger.disable", {});
  } catch (error) {
    // The tab may have navigated or closed; nothing to unwind.
  }
}

async function loadSourceMapEntry(context, scriptUrl, scriptId) {
  if (!scriptUrl || !/^https?:/i.test(scriptUrl)) return { status: "notFound" };
  const key = sourceMapCacheKey(context.tabId, scriptUrl);
  const cached = sourceMapCacheGet(key);
  if (cached) return cached;
  const source = await scriptSourceFor(context, scriptUrl, scriptId);
  if (source === null) return sourceMapCacheSet(key, { status: "notFound" });
  const mappingUrl = sourceMappingUrlFrom(source);
  if (!mappingUrl) return sourceMapCacheSet(key, { status: "notFound" });

  let mapText = null;
  let mapUrl = null;
  if (mappingUrl.startsWith("data:")) {
    const comma = mappingUrl.indexOf(",");
    const header = comma >= 0 ? mappingUrl.slice(5, comma) : "";
    if (comma < 0 || !/^application\/json/i.test(header)) {
      return sourceMapCacheSet(key, { status: "invalid" });
    }
    const payload = mappingUrl.slice(comma + 1);
    try {
      mapText = /;base64$/i.test(header) ? atob(payload) : decodeURIComponent(payload);
    } catch (error) {
      return sourceMapCacheSet(key, { status: "invalid" });
    }
  } else {
    let resolved;
    try {
      resolved = new URL(mappingUrl, scriptUrl);
    } catch (error) {
      return sourceMapCacheSet(key, { status: "invalid" });
    }
    // Hard boundary: only the script's own origin may be contacted for a map.
    if (resolved.origin !== new URL(scriptUrl).origin) {
      return sourceMapCacheSet(key, { status: "crossOriginRefused" });
    }
    mapUrl = resolved.href;
    try {
      const response = await fetch(mapUrl, { credentials: "omit", cache: "force-cache" });
      if (!response.ok) return sourceMapCacheSet(key, { status: "notFound" });
      mapText = await response.text();
    } catch (error) {
      return sourceMapCacheSet(key, { status: "notFound" });
    }
  }

  const map = parseSourceMap(mapText, mapUrl || scriptUrl);
  if (!map) return sourceMapCacheSet(key, { status: "invalid" });
  return sourceMapCacheSet(key, { status: "ok", map });
}

async function resolveConsoleSourceMaps(tabId, messages) {
  const context = { tabId, debuggerEnabled: false, debuggerFailed: false };
  const scripts = new Set();
  let framesConsidered = 0;
  let framesResolved = 0;
  try {
    for (const message of messages) {
      for (const frame of message.stack) {
        framesConsidered += 1;
        const entry = await loadSourceMapEntry(context, frame.url, frame.scriptId);
        if (entry.status !== "ok") {
          frame.sourceMapStatus = entry.status;
          continue;
        }
        scripts.add(frame.url);
        const original = resolveMappedPosition(entry.map, frame.lineNumber, frame.columnNumber);
        if (!original) {
          frame.sourceMapStatus = "unmapped";
          continue;
        }
        frame.originalLocation = original;
        framesResolved += 1;
      }
    }
  } finally {
    await releaseScriptSourceContext(context);
  }
  return { framesConsidered, framesResolved, mappedScripts: scripts.size };
}

async function consoleMessages(tabId, options = {}) {
  const monitor = monitors.get(tabId);
  if (!monitor) return { success: false, err: `Monitoring is not active for tab ${tabId}; run startMonitoring first` };
  // Copy entries (and their frames) so resolution never mutates the buffer a
  // later plain consoleMessages call will return.
  const messages = monitor.console.map((entry) => ({
    ...entry,
    args: [...(entry.args || [])],
    stack: (entry.stack || []).map((frame) => ({ ...frame }))
  }));
  if (options.resolveSourceMaps !== true) return { success: true, tabId, messages };
  const stats = await resolveConsoleSourceMaps(tabId, messages);
  return { success: true, tabId, sourceMapsResolved: true, ...stats, messages };
}

function networkRequests(tabId) {
  const monitor = monitors.get(tabId);
  if (!monitor) return { success: false, err: `Monitoring is not active for tab ${tabId}; run startMonitoring first` };
  return { success: true, tabId, requests: [...monitor.network.values()] };
}

async function handleDialog(tabId, accept, promptText) {
  try {
    return await withDebugger(tabId, async (target) => {
      const params = { accept };
      if (promptText != null) params.promptText = promptText;
      await debuggerCommand(target, 'Page.handleJavaScriptDialog', params);
      return { success: true, tabId, accept };
    });
  } catch (error) {
    return { success: false, err: error.message };
  }
}

function pushLimited(items, item) {
  items.push(item);
  if (items.length > MONITOR_LIMIT) items.splice(0, items.length - MONITOR_LIMIT);
}

function trimNetwork(items) {
  while (items.size > MONITOR_LIMIT) {
    const first = items.keys().next().value;
    items.delete(first);
  }
}

function stringifyRemoteValue(arg) {
  return String(arg.value ?? arg.description ?? arg.type ?? '');
}

function redactUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return { url: parsed.origin + parsed.pathname, hasQuery: Boolean(parsed.search) };
  } catch (_error) {
    return { url: rawUrl.split('?')[0], hasQuery: rawUrl.includes('?') };
  }
}

async function downloadUrl(url, filename) {
  const options = { url: url, saveAs: false };
  if (filename) {
    options.filename = filename;
  }
  const downloadId = await chrome.downloads.download(options);
  return { downloadId };
}

async function getStorageState(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || "";
  let origin = "";
  try {
    if (url) {
      origin = new URL(url).origin;
    }
  } catch (e) {
    // Ignore invalid URL
  }

  let localStorageVal = {};
  let sessionStorageVal = {};

  if (origin && origin !== "null" && origin.startsWith("http")) {
    try {
      const storageRes = await withDebugger(tabId, async (target) => {
        return await evaluateWithDebugger(target, `(() => {
          const ls = {};
          const ss = {};
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              ls[k] = localStorage.getItem(k);
            }
          } catch(e) {}
          try {
            for (let i = 0; i < sessionStorage.length; i++) {
              const k = sessionStorage.key(i);
              ss[k] = sessionStorage.getItem(k);
            }
          } catch(e) {}
          return { localStorage: ls, sessionStorage: ss };
        })()`);
      });

      if (storageRes.success && storageRes.val) {
        localStorageVal = storageRes.val.localStorage || {};
        sessionStorageVal = storageRes.val.sessionStorage || {};
      }
    } catch (e) {
      // Ignore debugger or evaluation errors
    }
  }

  let cookies = [];
  if (origin && origin.startsWith("http")) {
    try {
      cookies = await chrome.cookies.getAll({ url: origin });
    } catch (e) {
      // Ignore cookie errors
    }
  }

  return {
    origin,
    cookies,
    localStorage: localStorageVal,
    sessionStorage: sessionStorageVal
  };
}

async function setGeolocation(tabId, latitude, longitude, accuracy) {
  const tab = await chrome.tabs.get(tabId);
  let origin = "";
  try {
    origin = new URL(tab.url).origin;
  } catch (e) {}

  return withDebugger(tabId, async (target) => {
    let grantError = null;
    if (origin && origin.startsWith("http")) {
      try {
        await chrome.contentSettings.location.set({
          primaryPattern: `${origin}/*`,
          setting: 'allow'
        });
      } catch (contentSettingsError) {
        try {
          await debuggerCommand(target, 'Browser.setPermission', {
            permission: { name: 'geolocation' },
            setting: 'granted',
            origin: origin
          });
        } catch (setPermissionError) {
          try {
            await debuggerCommand(target, 'Browser.grantPermissions', {
              permissions: ['geolocation'],
              origin: origin
            });
          } catch (grantPermissionsError) {
            grantError = `${contentSettingsError.message}; ${setPermissionError.message}; ${grantPermissionsError.message}`;
          }
        }
      }
    }
    const params = {
      latitude: Number(latitude),
      longitude: Number(longitude),
      accuracy: accuracy !== undefined && accuracy !== null ? Number(accuracy) : 100
    };
    await debuggerCommand(target, 'Emulation.setGeolocationOverride', params);
    return { success: true, tabId, latitude, longitude, accuracy: params.accuracy, grantError };
  });
}

async function clearGeolocation(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let origin = "";
  try {
    origin = new URL(tab.url).origin;
  } catch (e) {}
  if (origin && origin.startsWith("http")) {
    try {
      await chrome.contentSettings.location.set({
        primaryPattern: `${origin}/*`,
        setting: 'ask'
      });
    } catch (_error) {}
  }
  await withDebugger(tabId, async (target) => {
    await debuggerCommand(target, 'Emulation.clearGeolocationOverride', {});
  });
  return { success: true, tabId };
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binString = "";
  for (let i = 0; i < bytes.length; i++) {
    binString += String.fromCharCode(bytes[i]);
  }
  return btoa(binString);
}

async function startInterception(tabId, urlPattern, mode, status, body) {
  const target = { tabId };
  const taskSession = await findTaskSessionForTab(tabId);
  const taskLease = taskSession
    ? await acquireTaskDebugger(tabId, taskSession.sessionId, "interceptor")
    : null;
  const attachedHere = !monitors.has(tabId) && !interceptors.has(tabId) && !screencasts.has(tabId) && !taskLease;
  if (attachedHere) {
    await debuggerAttach(target);
  }

  const interceptor = {
    urlPattern,
    mode,
    status: (status !== undefined && status !== null) ? parseInt(status, 10) : 200,
    body: body || "",
    requests: []
  };
  interceptors.set(tabId, interceptor);

  try {
    await debuggerCommand(target, 'Fetch.enable', {
      patterns: [{ urlPattern: urlPattern, requestStage: "Request" }]
    });
    return { success: true, tabId, urlPattern, mode };
  } catch (error) {
    interceptors.delete(tabId);
    if (taskLease) {
      releaseTaskDebugger(taskLease);
    } else if (attachedHere && !monitors.has(tabId) && !screencasts.has(tabId)) {
      await debuggerDetach(target);
    }
    throw error;
  }
}

async function stopInterception(tabId) {
  if (!interceptors.has(tabId)) return { success: true, tabId, alreadyStopped: true };
  const target = { tabId };
  try {
    await debuggerCommand(target, 'Fetch.disable', {});
  } catch (error) {
    console.warn("Fetch.disable failed:", error.message);
  }
  interceptors.delete(tabId);
  const state = taskDebuggerStates.get(tabId);
  if (state) {
    state.holders.delete("interceptor");
    scheduleTaskDebuggerDetach(tabId);
  } else if (!monitors.has(tabId) && !screencasts.has(tabId)) {
    await debuggerDetach(target);
  }
  return { success: true, tabId };
}

function interceptedRequests(tabId) {
  const interceptor = interceptors.get(tabId);
  if (!interceptor) {
    return { success: false, err: `Interception is not active for tab ${tabId}; run startInterception first` };
  }
  return { success: true, tabId, requests: [...interceptor.requests] };
}

async function performanceMetrics(tabId) {
  return withDebugger(tabId, async (target) => {
    await debuggerCommand(target, 'Performance.enable', {});
    try {
      const response = await debuggerCommand(target, 'Performance.getMetrics', {});
      const metrics = {};
      if (response && response.metrics) {
        for (const item of response.metrics) {
          metrics[item.name] = item.value;
        }
      }
      return { success: true, tabId, metrics };
    } finally {
      await debuggerCommand(target, 'Performance.disable', {}).catch(() => {});
    }
  });
}

const SESSION_COOKIE_HINTS = ["session", "sess", "sid", "auth", "token", "login", "logged_in", "jwt", "remember"];

async function sessionStatus(domains) {
  if (!Array.isArray(domains) || domains.length === 0) return { sessions: [] };
  const sessions = [];
  for (const domain of domains) {
    const cookies = await chrome.cookies.getAll({ domain });
    const cookieNames = cookies.map((cookie) => cookie.name);
    const hasSessionCookie = cookieNames.some((name) => {
      const lower = name.toLowerCase();
      return SESSION_COOKIE_HINTS.some((hint) => lower.includes(hint));
    });
    sessions.push({
      domain,
      cookieCount: cookies.length,
      cookieNames,
      hasSessionCookie,
      loggedIn: hasSessionCookie
    });
  }
  return { sessions };
}

async function readBodyLengthInTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (document.body?.innerText || '').length
    });
    return Number.isFinite(results[0]?.result) ? results[0].result : -1;
  } catch (error) {
    return -1;
  }
}

async function handoffBodyLength(tabId) {
  return readBodyLengthInTab(tabId);
}

async function handoffResult(tabId, mode, startedAt) {
  const tab = await chrome.tabs.get(tabId);
  const redacted = redactUrl(tab.url || "");
  return {
    success: true,
    handedOff: true,
    mode,
    elapsedMs: Date.now() - startedAt,
    tabId,
    finalUrl: redacted.url,
    finalUrlHasQuery: redacted.hasQuery,
  };
}

async function showHandoffOverlay(tabId, message) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (msg) => {
        const id = "__chrome_bridge_handoff__";
        document.getElementById(id)?.remove();
        const host = document.createElement("div");
        host.id = id;
        host.setAttribute("role", "status");
        host.setAttribute("aria-live", "polite");
        host.style.cssText = "position:fixed;bottom:24px;left:50%;width:min(420px,calc(100vw - 32px));z-index:2147483647;pointer-events:none;transform:translateX(-50%);contain:layout style paint";
        const root = host.attachShadow({ mode: "closed" });
        const card = document.createElement("div");
        card.innerHTML = `
          <style>
            :host{all:initial;pointer-events:none}
            .card{position:relative;display:flex;gap:12px;align-items:center;padding:13px 15px;border:1px solid #343a45;border-radius:15px;background:#111318;color:#f5f0e8;box-shadow:0 14px 40px rgba(0,0,0,.36);font-family:"Avenir Next","Segoe UI",sans-serif;overflow:hidden;animation:bridge-card-in 180ms cubic-bezier(.2,.8,.2,1) both}
            .card:before{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(90deg,#9b6cff,#47d7c8)}
            .mark{position:relative;width:34px;height:34px;flex:0 0 auto;border-radius:10px;background:#191c22}
            .mark:before,.mark:after{content:"";position:absolute;top:8px;width:11px;height:17px;border:2px solid;border-radius:5px}.mark:before{left:6px;border-color:#9b6cff}.mark:after{right:6px;border-color:#47d7c8}.spark{position:absolute;left:14px;top:8px;color:#f5f0e8;font:700 12px system-ui}
            strong{display:block;font-size:13px;line-height:1.2}p{margin:4px 0 0;color:#abb0ba;font-size:12px;line-height:1.35}
            @keyframes bridge-card-in{from{opacity:0;transform:translateY(9px) scale(.98)}to{opacity:1;transform:none}}
            @media (prefers-reduced-motion:reduce){.card{animation-duration:.01ms!important}}
          </style>
          <div class="card"><div class="mark" aria-hidden="true"><span class="spark">✦</span></div><div><strong>Chrome Bridge needs your help</strong><p></p></div></div>`;
        card.querySelector("p").textContent = String(msg || "Please complete this step, then continue.");
        root.appendChild(card);
        (document.body || document.documentElement).appendChild(host);
      },
      args: [message || ""],
    });
  } catch (_e) {
    // Overlay is best-effort (blocked by strict CSP / unsupported pages); the
    // handoff still proceeds without it.
  }
}

async function hideHandoffOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => document.getElementById("__chrome_bridge_handoff__")?.remove(),
    });
  } catch (_e) {
    // Best-effort cleanup.
  }
}

async function waitForHandoff(payload) {
  payload = payload || {};
  const until = payload.until || {};
  const mode = until.mode || "manual";
  const timeoutMs = payload.timeoutMs || 120000;
  let tabId = payload.tabId;
  if (tabId === undefined || tabId === null) {
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = active[0] && active[0].id;
  }
  if (tabId === undefined || tabId === null) {
    return { success: false, err: "No target tab for handoff" };
  }
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  const taskSession = await findTaskSessionForTab(tabId);
  const previousState = taskSession?.session?.state || "working";
  if (taskSession) await updateTaskSessionState(taskSession.sessionId, "needs_user");
  const startedAt = Date.now();
  await showHandoffOverlay(tabId, payload.message);
  const timeoutErr = { success: false, err: `handoff timeout after ${timeoutMs}ms (${mode})` };
  const settle = async (found) => found ? await handoffResult(tabId, mode, startedAt) : timeoutErr;
  try {
    if (mode === "selector") {
      const found = await waitForSelector(tabId, until.selector, timeoutMs);
      return await settle(found.success);
    }
    if (mode === "url") {
      const found = await waitForUrl(tabId, until.urlSubstring, timeoutMs);
      return await settle(found.success);
    }
    if (mode === "text") {
      const found = await waitForText(tabId, until.text, timeoutMs);
      return await settle(found.success);
    }
    const startUrl = (await chrome.tabs.get(tabId)).url || "";
    let startLen = await handoffBodyLength(tabId);
    const deadline = deadlineFrom(timeoutMs);
    while (Date.now() <= deadline) {
      await sleep(250);
      const currentUrl = (await chrome.tabs.get(tabId)).url || "";
      const currentLen = await handoffBodyLength(tabId);
      if (currentUrl !== startUrl) return await settle(true);
      if (startLen < 0) {
        if (currentLen >= 0) startLen = currentLen;
        continue;
      }
      if (currentLen >= 0 && currentLen !== startLen) return await settle(true);
    }
    return await settle(false);
  } finally {
    await hideHandoffOverlay(tabId);
    if (taskSession) {
      try {
        await updateTaskSessionState(taskSession.sessionId, previousState);
      } catch (_error) {
        // The task can be closed while the user is completing a handoff.
      }
    }
  }
}

// Cookie and web-storage write ops. Responses echo identifiers only (cookie
// name/domain, storage scope/key) and never the stored value, so raw output can
// be pasted without leaking credentials.
async function setCookie(payload) {
  payload = payload || {};
  if (!payload.url) return { success: false, err: "url is required" };
  if (typeof payload.name !== "string" || payload.name.length === 0) {
    return { success: false, err: "name is required" };
  }
  const details = {
    url: payload.url,
    name: payload.name,
    value: payload.value === undefined || payload.value === null ? "" : String(payload.value),
  };
  if (payload.domain) details.domain = payload.domain;
  if (payload.path) details.path = payload.path;
  if (payload.secure !== undefined) details.secure = payload.secure === true;
  if (payload.httpOnly !== undefined) details.httpOnly = payload.httpOnly === true;
  if (payload.sameSite) details.sameSite = payload.sameSite;
  if (payload.expirationDate !== undefined && payload.expirationDate !== null) {
    details.expirationDate = Number(payload.expirationDate);
  }
  let cookie;
  try {
    cookie = await chrome.cookies.set(details);
  } catch (error) {
    return { success: false, err: error.message };
  }
  if (!cookie) {
    return { success: false, err: "chrome.cookies.set stored nothing (check url, secure, and sameSite constraints)" };
  }
  // Name and domain only: never echo the value back to the client.
  return { success: true, name: cookie.name, domain: cookie.domain };
}

async function deleteCookie(url, name) {
  if (!url) return { success: false, err: "url is required" };
  if (typeof name !== "string" || name.length === 0) return { success: false, err: "name is required" };
  let removed;
  try {
    removed = await chrome.cookies.remove({ url, name });
  } catch (error) {
    return { success: false, err: error.message };
  }
  if (!removed) return { success: false, err: "No cookie matched the given url and name" };
  return { success: true, name: removed.name, removed: true };
}

const STORAGE_SCOPES = { local: "localStorage", session: "sessionStorage" };

function storageObjectName(scope) {
  return STORAGE_SCOPES[scope];
}

// Runs a storage mutation in the tab through the same debugger evaluation path
// storageState uses for reads. Returns { success, origin, val } or a failure.
async function evaluateStorageOp(tabId, expression) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    return { success: false, err: error.message };
  }
  let origin = "";
  try {
    if (tab.url) origin = new URL(tab.url).origin;
  } catch (e) {
    // Ignore invalid URL
  }
  if (!origin || origin === "null" || !origin.startsWith("http")) {
    return { success: false, err: "Storage writes require an http/https tab origin" };
  }
  const res = await withDebugger(tabId, async (target) => evaluateWithDebugger(target, expression));
  if (!res.success) return res;
  const val = res.val || {};
  if (val.ok !== true) return { success: false, err: val.err || "Storage operation failed" };
  return { success: true, origin, val };
}

async function setStorageItem(tabId, scope, key, value) {
  const objectName = storageObjectName(scope);
  if (!objectName) return { success: false, err: 'scope must be "local" or "session"' };
  if (typeof key !== "string" || key.length === 0) return { success: false, err: "key is required" };
  const stored = value === undefined || value === null ? "" : String(value);
  const expression = `(() => { try { ${objectName}.setItem(${JSON.stringify(key)}, ${JSON.stringify(stored)}); return { ok: true }; } catch (e) { return { ok: false, err: e.message }; } })()`;
  const res = await evaluateStorageOp(tabId, expression);
  if (!res.success) return res;
  // Scope and key only: the written value is never echoed back.
  return { success: true, scope, key, origin: res.origin };
}

async function removeStorageItem(tabId, scope, key) {
  const objectName = storageObjectName(scope);
  if (!objectName) return { success: false, err: 'scope must be "local" or "session"' };
  if (typeof key !== "string" || key.length === 0) return { success: false, err: "key is required" };
  const expression = `(() => { try { const had = ${objectName}.getItem(${JSON.stringify(key)}) !== null; ${objectName}.removeItem(${JSON.stringify(key)}); return { ok: true, existed: had }; } catch (e) { return { ok: false, err: e.message }; } })()`;
  const res = await evaluateStorageOp(tabId, expression);
  if (!res.success) return res;
  return { success: true, scope, key, existed: res.val.existed === true, origin: res.origin };
}

async function clearStorage(tabId, scope) {
  const requested = scope || "both";
  const scopes = requested === "both" ? ["local", "session"] : [requested];
  for (const one of scopes) {
    if (!storageObjectName(one)) {
      return { success: false, err: 'scope must be "local", "session", or "both"' };
    }
  }
  const cleared = [];
  let origin = "";
  for (const one of scopes) {
    const objectName = storageObjectName(one);
    const expression = `(() => { try { const n = ${objectName}.length; ${objectName}.clear(); return { ok: true, keysRemoved: n }; } catch (e) { return { ok: false, err: e.message }; } })()`;
    const res = await evaluateStorageOp(tabId, expression);
    if (!res.success) return res;
    origin = res.origin;
    cleared.push({ scope: one, keysRemoved: res.val.keysRemoved });
  }
  // Key counts only: cleared keys and values are never reported.
  return { success: true, scope: requested, cleared, origin };
}

async function searchHistory(query, maxResults, startTime) {
  const requested = parseInt(maxResults, 10);
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 20, 1), 100);
  const search = { text: typeof query === "string" ? query : "", maxResults: limit };
  if (startTime !== undefined && startTime !== null) search.startTime = Number(startTime);
  const items = await chrome.history.search(search);
  return {
    success: true,
    count: items.length,
    items: items.map((item) => ({
      url: item.url,
      title: item.title,
      lastVisitTime: item.lastVisitTime,
      visitCount: item.visitCount,
    })),
  };
}

// Walks parentId links up to the bookmark root so each hit reports the folder
// path a human would recognize. Paths are cached per parent within one search.
async function bookmarkFolderPath(parentId, cache) {
  if (!parentId) return "";
  if (cache.has(parentId)) return cache.get(parentId);
  const parts = [];
  let current = parentId;
  while (current) {
    let node;
    try {
      const nodes = await chrome.bookmarks.get(current);
      node = nodes && nodes[0];
    } catch (error) {
      break;
    }
    if (!node) break;
    if (node.title) parts.unshift(node.title);
    current = node.parentId;
  }
  const path = parts.join("/");
  cache.set(parentId, path);
  return path;
}

async function searchBookmarks(query) {
  const nodes = await chrome.bookmarks.search(typeof query === "string" ? query : "");
  const cache = new Map();
  const items = [];
  for (const node of nodes) {
    items.push({
      id: node.id,
      title: node.title,
      url: node.url,
      folderPath: await bookmarkFolderPath(node.parentId, cache),
    });
  }
  return { success: true, count: items.length, items };
}

// Chrome refuses script injection into its own web store; skip those tabs
// instead of reporting a per-tab failure.
function isUnscriptableSearchUrl(url) {
  return /^https?:\/\/chromewebstore\.google\.com/.test(url)
    || /^https?:\/\/chrome\.google\.com\/webstore/.test(url);
}

// Injected into each searched tab by searchTabs. Returns bounded snippets
// (match text plus 80 characters of context each side), never full page text.
function pageTextMatches(query, isRegex, caseSensitive, maxMatches) {
  try {
    const raw = document.body ? document.body.innerText : document.documentElement.innerText;
    const text = raw || "";
    const snippets = [];
    let count = 0;
    const push = (index, length) => {
      count++;
      const start = Math.max(0, index - 80);
      const end = Math.min(text.length, index + length + 80);
      snippets.push({
        index,
        text: text.slice(start, end).replace(/\s+/g, " ").trim(),
        truncatedStart: start > 0,
        truncatedEnd: end < text.length,
      });
    };
    if (isRegex) {
      const re = new RegExp(query, caseSensitive ? "g" : "gi");
      let match;
      while ((match = re.exec(text)) !== null) {
        const length = match[0].length;
        push(match.index, length || 1);
        if (length === 0) re.lastIndex++;
        if (count >= maxMatches) break;
      }
    } else {
      const haystack = caseSensitive ? text : text.toLowerCase();
      const needle = caseSensitive ? query : query.toLowerCase();
      let from = 0;
      while (needle) {
        const index = haystack.indexOf(needle, from);
        if (index === -1) break;
        push(index, needle.length);
        from = index + needle.length;
        if (count >= maxMatches) break;
      }
    }
    return { ok: true, matchCount: count, snippets };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

async function searchTabs(payload) {
  payload = payload || {};
  const query = typeof payload.query === "string" ? payload.query : "";
  if (!query) return { success: false, err: "query is required" };
  const isRegex = payload.isRegex === true;
  const caseSensitive = payload.caseSensitive === true;
  const requested = parseInt(payload.maxMatchesPerTab, 10);
  const maxPerTab = Math.min(Math.max(Number.isFinite(requested) ? requested : 5, 1), 20);
  if (isRegex) {
    try {
      new RegExp(query);
    } catch (error) {
      return { success: false, err: `Invalid regex: ${error.message}` };
    }
  }
  const tabs = await chrome.tabs.query({});
  const matches = [];
  let searchedTabs = 0;
  let skippedTabs = 0;
  for (const tab of tabs) {
    const url = tab.url || "";
    if (tab.id === undefined || !/^https?:\/\//.test(url) || isUnscriptableSearchUrl(url)) {
      skippedTabs++;
      continue;
    }
    let host = "";
    try {
      host = new URL(url).host;
    } catch (e) {
      skippedTabs++;
      continue;
    }
    let hit;
    try {
      const response = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: pageTextMatches,
        args: [query, isRegex, caseSensitive, maxPerTab],
      });
      hit = response && response[0] && response[0].result;
    } catch (error) {
      skippedTabs++;
      continue;
    }
    if (!hit || hit.ok !== true) {
      skippedTabs++;
      continue;
    }
    searchedTabs++;
    if (hit.matchCount > 0) {
      // Origin host only, never the full URL with path and query.
      matches.push({ tabId: tab.id, domain: host, matchCount: hit.matchCount, snippets: hit.snippets });
    }
  }
  return {
    success: true,
    searchedTabs,
    skippedTabs,
    matchingTabs: matches.length,
    maxMatchesPerTab: maxPerTab,
    matches,
  };
}

// --- ST3: bridge-action workflow recording ---------------------------------
//
// A recording captures only what the BRIDGE dispatched: every mutating action
// that successfully returns from dispatchAction is appended to each matching
// active recording. Human clicks and keystrokes in the tab are never observed,
// so a workflow can only ever reproduce automation the caller already had the
// policy grants to perform. Recordings live solely in service-worker memory: a
// worker restart drops them, which is why `stopWorkflowRecording` returns the
// serialized workflow for the caller to persist.
const WORKFLOW_VERSION = 1;
const WORKFLOW_STEP_LIMIT = 500;
// A recorded human pause can be minutes long; replay waits at most this per
// step so a workflow never stalls the bridge on a gap nobody meant to keep.
const WORKFLOW_MAX_STEP_WAIT_MS = 10000;
const REDACTED_VALUE = "<redacted>";
const workflowRecordings = new Map();
let workflowRecordingCounter = 0;
// Replay dispatches through the same table, so suppress recording while a
// replay is running: otherwise replaying into an active recording would append
// a second copy of every step.
let workflowReplayDepth = 0;

// Actions worth replaying: they change browser or page state. Read-only
// actions (observe, extractText, consoleMessages, ...), host-side verbs, and
// the recording/replay control actions themselves are deliberately absent.
const RECORDABLE_ACTIONS = new Set([
  "navigate", "navigateTaskSession", "activateTab", "closeTab", "reload", "goBack", "goForward",
  "windowControl", "click", "clickAt", "type", "fill", "select", "hover", "scroll", "press", "drag",
  "uploadFile", "githubAttachUploadedFiles", "githubSubmitComment", "githubAttachPrBody",
  "executeScript", "executeScriptCDP", "handleDialog", "downloadUrl",
  "setViewport", "setCpuThrottling", "setNetworkConditions", "clearNetworkConditions",
  "setColorScheme", "setUserAgent", "setGeolocation", "clearGeolocation",
  "setCookie", "deleteCookie", "setStorageItem", "removeStorageItem", "clearStorage",
  "waitForLoad", "waitForSelector", "waitForText", "waitForUrl"
]);

// Per-action payload fields holding a value a human typed or stored. Recorded
// as `<redacted>` unless the call opted in with `recordSensitive: true`.
const WORKFLOW_SENSITIVE_FIELDS = {
  type: ["text"],
  fill: ["text"],
  setCookie: ["value"],
  setStorageItem: ["value"],
  handleDialog: ["promptText"]
};

// Transport/control keys that describe the request rather than the action.
const WORKFLOW_SKIPPED_PAYLOAD_KEYS = new Set([
  "recordSensitive", "bindings", "cache", "workflow", "confirmationToken", "dryRun", "traceId"
]);

// Any credential-shaped key is redacted regardless of action, so a future
// action carrying a secret field is covered before anyone remembers to list it.
const WORKFLOW_SECRET_KEY_PATTERN = /(token|password|passwd|secret|credential|authorization|api[-_]?key)/i;

function workflowBindingKey(stepIndex, field) {
  return `step${stepIndex}.${field}`;
}

function isWorkflowSensitiveField(action, key, value) {
  if (typeof value !== "string" || !value.length) return false;
  if (WORKFLOW_SECRET_KEY_PATTERN.test(key)) return true;
  return (WORKFLOW_SENSITIVE_FIELDS[action] || []).includes(key);
}

// Returns the payload as recorded plus the binding keys replay will demand.
function scrubRecordedPayload(action, payload, stepIndex, recordSensitive) {
  const scrubbed = {};
  const bindingKeys = [];
  for (const [key, value] of Object.entries(payload && typeof payload === "object" ? payload : {})) {
    if (WORKFLOW_SKIPPED_PAYLOAD_KEYS.has(key)) continue;
    if (!recordSensitive && isWorkflowSensitiveField(action, key, value)) {
      scrubbed[key] = REDACTED_VALUE;
      bindingKeys.push(workflowBindingKey(stepIndex, key));
      continue;
    }
    scrubbed[key] = value;
  }
  return { payload: scrubbed, bindingKeys };
}

// Shape only: never the returned text, HTML, cookie value, or element content.
function summarizeRecordedResult(result) {
  if (result === null || result === undefined) return { success: true, type: "empty" };
  if (Array.isArray(result)) return { success: true, type: "array", length: result.length };
  if (typeof result !== "object") return { success: true, type: typeof result };
  return { success: result.success !== false, type: "object", keys: Object.keys(result).slice(0, 12) };
}

async function recordingTabOrigin(tabId) {
  try {
    const info = await tabOrigin(tabId);
    return info.origin || null;
  } catch (error) {
    return null;
  }
}

async function recordDispatchedAction(action, payload, result) {
  if (!workflowRecordings.size || workflowReplayDepth > 0) return;
  if (!RECORDABLE_ACTIONS.has(action)) return;
  if (result && typeof result === "object" && !Array.isArray(result) && result.success === false) return;
  const tabId = typeof payload?.tabId === "number" ? payload.tabId : null;
  const origin = tabId === null ? null : await recordingTabOrigin(tabId);
  const now = Date.now();
  for (const recording of workflowRecordings.values()) {
    // A tab-scoped recording keeps tab-scoped steps for its own tab plus
    // profile-wide steps (setCookie, downloadUrl, ...) that carry no tabId.
    if (recording.tabId !== null && tabId !== null && recording.tabId !== tabId) continue;
    if (recording.steps.length >= WORKFLOW_STEP_LIMIT) {
      recording.truncated = true;
      continue;
    }
    const index = recording.steps.length;
    // Opt-in is either recording-wide or per call: `recordSensitive: true` in
    // the action's own payload keeps that one call's typed value verbatim.
    const keepSensitive = recording.recordSensitive || payload?.recordSensitive === true;
    const { payload: scrubbed, bindingKeys } = scrubRecordedPayload(action, payload, index, keepSensitive);
    const step = {
      action,
      payload: scrubbed,
      tsDeltaMs: Math.max(0, now - recording.lastTs),
      resultSummary: summarizeRecordedResult(result)
    };
    if (bindingKeys.length) {
      step.requiresValue = true;
      step.bindingKeys = bindingKeys;
    }
    recording.steps.push(step);
    recording.lastTs = now;
    if (origin) recording.origins.add(origin);
  }
}

// Serialized in the shared workflow format: {version, name, steps, policy}.
// `wait` is the recorded inter-step gap, clamped; the redaction bookkeeping
// (`requiresValue`, `bindingKeys`) rides along as additive per-step keys.
function serializeRecording(recording) {
  const steps = recording.steps.map((step) => {
    const entry = { action: step.action, payload: step.payload };
    const wait = Math.min(step.tsDeltaMs, WORKFLOW_MAX_STEP_WAIT_MS);
    if (wait > 0) entry.wait = wait;
    if (step.requiresValue) {
      entry.requiresValue = true;
      entry.bindingKeys = step.bindingKeys;
    }
    return entry;
  });
  return {
    version: WORKFLOW_VERSION,
    name: recording.name,
    createdAt: new Date(recording.startedAt).toISOString(),
    steps,
    policy: { requiredOrigins: [...recording.origins] }
  };
}

async function startWorkflowRecording(payload) {
  const tabId = typeof payload?.tabId === "number" ? payload.tabId : null;
  if (tabId !== null) {
    try {
      await chrome.tabs.get(tabId);
    } catch (error) {
      return { success: false, err: `No such tab ${tabId}` };
    }
  }
  workflowRecordingCounter += 1;
  const recordingId = `wf${workflowRecordingCounter}-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  const recording = {
    id: recordingId,
    name: String(payload?.name || `recording-${workflowRecordingCounter}`),
    tabId,
    recordSensitive: payload?.recordSensitive === true,
    startedAt,
    lastTs: startedAt,
    steps: [],
    origins: new Set(),
    truncated: false
  };
  workflowRecordings.set(recordingId, recording);
  return {
    success: true,
    recordingId,
    name: recording.name,
    tabId,
    scope: tabId === null ? "global" : "tab",
    recordSensitive: recording.recordSensitive,
    startedAt,
    stepLimit: WORKFLOW_STEP_LIMIT
  };
}

function stopWorkflowRecording(payload) {
  let recordingId = payload?.recordingId;
  if (!recordingId && workflowRecordings.size === 1) {
    recordingId = workflowRecordings.keys().next().value;
  }
  const recording = recordingId ? workflowRecordings.get(recordingId) : null;
  if (!recording) {
    return {
      success: false,
      err: recordingId ? `Unknown recording ${recordingId}` : "stopWorkflowRecording requires a recordingId",
      active: [...workflowRecordings.keys()]
    };
  }
  workflowRecordings.delete(recording.id);
  const workflow = serializeRecording(recording);
  const requiresBindings = workflow.steps.flatMap((step) => step.bindingKeys || []);
  return {
    success: true,
    recordingId: recording.id,
    name: recording.name,
    tabId: recording.tabId,
    stepCount: workflow.steps.length,
    redactedSteps: workflow.steps.filter((step) => step.requiresValue).length,
    requiresBindings,
    requiredOrigins: workflow.policy.requiredOrigins,
    durationMs: Date.now() - recording.startedAt,
    truncated: recording.truncated,
    workflow
  };
}

// --- ST4: semantic-selector resolution cache and self-healing --------------
//
// Only SEMANTIC selectors (text=, label=, role=, aria=) are cacheable: they
// describe intent, so re-resolving one after the DOM shifts still targets what
// the author meant. A CSS selector is a literal address and is never
// retargeted - a failing CSS step fails, it does not silently pick a different
// element. The cache maps (urlPattern, semantic selector) to the concrete CSS
// path last known to resolve to that element.
const SELECTOR_CACHE_LIMIT = 500;
const SEMANTIC_SELECTOR_PREFIXES = ["text=", "label=", "role=", "aria="];
const CACHEABLE_SELECTOR_ACTIONS = new Set(["click", "type", "fill", "select", "hover"]);
const selectorCache = new Map();

function isSemanticSelector(selector) {
  const raw = String(selector ?? "").trim();
  return SEMANTIC_SELECTOR_PREFIXES.some((prefix) => raw.startsWith(prefix));
}

function selectorCacheKey(urlPattern, selector) {
  return `${urlPattern}\n${selector}`;
}

function selectorCacheSet(entry) {
  const key = selectorCacheKey(entry.urlPattern, entry.selector);
  selectorCache.delete(key);
  selectorCache.set(key, entry);
  while (selectorCache.size > SELECTOR_CACHE_LIMIT) {
    selectorCache.delete(selectorCache.keys().next().value);
  }
}

// Entries supplied by a caller's file-backed cache. Only well-formed semantic
// entries are merged, so an edited cache file cannot inject a CSS retarget.
function mergeSelectorCache(entries) {
  let merged = 0;
  for (const raw of Array.isArray(entries) ? entries : []) {
    if (!raw || typeof raw !== "object") continue;
    const urlPattern = String(raw.urlPattern || "");
    const selector = String(raw.selector || "");
    const resolvedSelector = String(raw.resolvedSelector || "");
    if (!urlPattern || !selector || !resolvedSelector) continue;
    if (!isSemanticSelector(selector)) continue;
    selectorCacheSet({
      urlPattern,
      selector,
      resolvedSelector,
      lastSuccess: Number(raw.lastSuccess) || 0
    });
    merged += 1;
  }
  return merged;
}

function selectorCacheEntries() {
  return [...selectorCache.values()].map((entry) => ({ ...entry }));
}

// Origin plus pathname: the same page across query strings and fragments, but
// never a different site or route sharing a control's accessible name.
async function selectorUrlPattern(tabId, explicit) {
  if (explicit) return String(explicit);
  const info = await tabOrigin(tabId);
  if (!info.url) return info.origin || "";
  try {
    const parsed = new URL(info.url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (error) {
    return info.origin || "";
  }
}

// Derives a document-unique CSS path for the element a locator resolves to,
// preferring id, then a small set of stable attributes, then an nth-of-type
// path anchored at the nearest such attribute. Returns success: false rather
// than an ambiguous path, so a cached selector always addresses one element.
function stableSelectorExpression(locator) {
  return `(() => {
    ${locatorResolverSource()}
    const resolved = resolveLocator(${JSON.stringify(locator)});
    if (!resolved.success) return resolved;
    const escapeCss = (value) => (self.CSS && CSS.escape) ? CSS.escape(String(value)) : String(value).replace(/[^A-Za-z0-9_-]/g, (ch) => '\\\\' + ch);
    const unique = (sel) => {
      try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
    };
    const anchorFor = (el) => {
      if (el.id && unique('#' + escapeCss(el.id))) return '#' + escapeCss(el.id);
      for (const attr of ['data-testid', 'data-test-id', 'data-test', 'name', 'aria-label']) {
        const value = el.getAttribute ? el.getAttribute(attr) : null;
        if (!value) continue;
        const sel = el.tagName.toLowerCase() + '[' + attr + '="' + String(value).replace(/["\\\\]/g, '\\\\$&') + '"]';
        if (unique(sel)) return sel;
      }
      return null;
    };
    const direct = anchorFor(resolved.el);
    if (direct) return { success: true, selector: direct };
    const parts = [];
    let node = resolved.el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      const anchor = anchorFor(node);
      if (anchor) {
        parts.unshift(anchor);
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const twins = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (twins.length > 1) part += ':nth-of-type(' + (twins.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    const path = parts.join(' > ');
    if (!path || !unique(path)) return { success: false, err: 'No stable selector for the resolved element' };
    return { success: true, selector: path };
  })()`;
}

// Mints an observe-compatible ref for the resolved element by describing its
// live CDP node, so a ref handed back here is interchangeable with one from
// observe and is invalidated by the same navigation/restart rules.
async function mintRefForLocator(target, tabId, locator, contextId) {
  const params = {
    expression: elementObjectExpression(locator),
    awaitPromise: true,
    returnByValue: false,
    allowUnsafeEvalBlockedByCSP: true
  };
  if (contextId !== null && contextId !== undefined) params.contextId = contextId;
  let objectId = null;
  try {
    const evaluated = await debuggerCommand(target, "Runtime.evaluate", params);
    if (evaluated.exceptionDetails) return null;
    objectId = evaluated.result?.objectId || null;
    if (!objectId) return null;
    const described = await debuggerCommand(target, "DOM.describeNode", { objectId });
    const backendDOMNodeId = described?.node?.backendNodeId || null;
    if (!backendDOMNodeId) return null;
    const registry = refRegistry(tabId);
    const ref = assignRef(registry, { backendDOMNodeId });
    trimRefRegistry(registry);
    return ref;
  } catch (error) {
    return null;
  } finally {
    if (objectId) {
      try {
        await debuggerCommand(target, "Runtime.releaseObject", { objectId });
      } catch (error) {
        // Releasing the handle is best-effort.
      }
    }
  }
}

// Resolves one selector and reports the concrete CSS path plus a ref for it.
// Frame- and shadow-scoped locators resolve normally but are reported
// `cacheable: false`: their CSS path is relative to another document, so
// replaying it against the top document would address the wrong element.
async function resolveSelectorTarget(tabId, selector) {
  let locator;
  try {
    locator = parseActionLocator(selector, tabId);
  } catch (error) {
    return locatorError(error);
  }
  const scoped = locator.frames.length > 0 || (locator.shadowSegments || []).length > 0;
  return withDebugger(tabId, async (target) => {
    const resolved = await resolveActionTarget(tabId, locator, target);
    if (resolved.success === false) return resolved;
    const ref = await mintRefForLocator(target, tabId, locator, resolved.contextId);
    if (scoped) {
      return { success: true, selector, ref, resolvedSelector: null, cacheable: false, tagName: resolved.tagName || null };
    }
    const derived = await evaluateInContext(target, stableSelectorExpression(locator), resolved.contextId);
    const value = derived.val || derived;
    if (!derived.success || value.success === false) {
      return { success: true, selector, ref, resolvedSelector: null, cacheable: false, tagName: resolved.tagName || null };
    }
    return { success: true, selector, ref, resolvedSelector: value.selector, cacheable: true, tagName: resolved.tagName || null };
  });
}

async function resolveCachedSelector(payload) {
  const tabId = payload?.tabId;
  const selector = String(payload?.selector ?? "").trim();
  if (typeof tabId !== "number") return { success: false, err: "resolveCachedSelector requires a numeric tabId" };
  if (!selector) return { success: false, err: "resolveCachedSelector requires a selector" };
  if (Array.isArray(payload.cache)) mergeSelectorCache(payload.cache);
  const semantic = isSemanticSelector(selector);
  const urlPattern = await selectorUrlPattern(tabId, payload.urlPattern);
  const key = selectorCacheKey(urlPattern, selector);
  const cached = payload.refresh === true ? null : selectorCache.get(key);
  if (cached) {
    const hit = await resolveSelectorTarget(tabId, cached.resolvedSelector);
    if (hit.success !== false) {
      cached.lastSuccess = Date.now();
      return {
        success: true, tabId, urlPattern, selector,
        resolvedSelector: cached.resolvedSelector, ref: hit.ref,
        cached: true, selfHealed: false, entry: { ...cached }
      };
    }
    selectorCache.delete(key);
  }
  const fresh = await resolveSelectorTarget(tabId, selector);
  if (fresh.success === false) return fresh;
  let entry = null;
  if (semantic && fresh.cacheable && fresh.resolvedSelector) {
    entry = { urlPattern, selector, resolvedSelector: fresh.resolvedSelector, lastSuccess: Date.now() };
    selectorCacheSet(entry);
  }
  return {
    success: true, tabId, urlPattern, selector,
    resolvedSelector: fresh.resolvedSelector, ref: fresh.ref,
    cacheable: Boolean(fresh.cacheable), cached: false,
    selfHealed: Boolean(cached), entry: entry ? { ...entry } : null
  };
}

function cacheSelectors(payload) {
  const op = String(payload?.op || "list");
  if (op === "clear") {
    const cleared = selectorCache.size;
    selectorCache.clear();
    return { success: true, op, cleared };
  }
  if (op === "import") {
    const merged = mergeSelectorCache(payload?.entries);
    return { success: true, op, merged, entries: selectorCache.size };
  }
  if (op === "list" || op === "export") {
    return { success: true, op, entries: selectorCacheEntries(), limit: SELECTOR_CACHE_LIMIT };
  }
  return { success: false, err: `Unknown cacheSelectors op: ${op}` };
}

// --- ST3/ST4: replay -------------------------------------------------------

function workflowStepBindingKeys(step, index) {
  if (Array.isArray(step?.bindingKeys) && step.bindingKeys.length) return step.bindingKeys.map(String);
  const keys = [];
  for (const [field, value] of Object.entries(step?.payload || {})) {
    if (value === REDACTED_VALUE) keys.push(workflowBindingKey(index, field));
  }
  return keys;
}

function applyWorkflowBindings(stepPayload, index, bindings) {
  for (const [field, value] of Object.entries(stepPayload)) {
    if (value !== REDACTED_VALUE) continue;
    stepPayload[field] = bindings[workflowBindingKey(index, field)];
  }
}

// Replays a semantic selector through the cache. Returns the selector to use
// plus whether the cached mapping had to be re-resolved. A CSS selector is
// returned untouched: it is never re-pointed at another element.
async function selectorForReplay(action, stepPayload) {
  const selector = stepPayload.selector;
  if (!CACHEABLE_SELECTOR_ACTIONS.has(action)) return { selector, selfHealed: false };
  if (typeof stepPayload.tabId !== "number") return { selector, selfHealed: false };
  if (!isSemanticSelector(selector)) return { selector, selfHealed: false };
  const resolution = await resolveCachedSelector({ tabId: stepPayload.tabId, selector });
  if (resolution.success === false) return { selector, selfHealed: false };
  return {
    selector: resolution.resolvedSelector || selector,
    selfHealed: resolution.selfHealed === true,
    cached: resolution.cached === true,
    urlPattern: resolution.urlPattern
  };
}

async function replayWorkflow(payload) {
  const workflow = payload?.workflow;
  if (!workflow || typeof workflow !== "object") {
    return { success: false, err: "replayWorkflow requires a workflow object" };
  }
  if (workflow.version !== undefined && Number(workflow.version) !== WORKFLOW_VERSION) {
    return { success: false, err: `Unsupported workflow version ${workflow.version}; expected ${WORKFLOW_VERSION}` };
  }
  const steps = Array.isArray(workflow.steps) ? workflow.steps : null;
  if (!steps) return { success: false, err: "workflow.steps must be an array" };
  if (steps.length > WORKFLOW_STEP_LIMIT) {
    return { success: false, err: `Workflow has ${steps.length} steps; the limit is ${WORKFLOW_STEP_LIMIT}` };
  }
  const bindings = payload.bindings && typeof payload.bindings === "object" ? payload.bindings : {};
  const defaultTabId = typeof payload.tabId === "number" ? payload.tabId : undefined;
  if (Array.isArray(payload.cache)) mergeSelectorCache(payload.cache);

  // Refuse the WHOLE workflow before running any step when a redacted value has
  // no binding: a half-run workflow that stops at the password field has
  // already mutated the page.
  const missingBindings = [];
  steps.forEach((step, index) => {
    for (const key of workflowStepBindingKeys(step, index)) {
      if (typeof bindings[key] !== "string") missingBindings.push(key);
    }
  });
  if (missingBindings.length) {
    return {
      success: false,
      error: "missingBindings",
      err: `Workflow needs values for redacted fields: ${missingBindings.join(", ")}`,
      missingBindings
    };
  }

  const requiredOrigins = Array.isArray(workflow.policy?.requiredOrigins)
    ? workflow.policy.requiredOrigins.map(String).filter(Boolean)
    : [];
  const halt = payload.stopOnError !== false;
  const results = [];
  let selfHealedSteps = 0;
  let failed = 0;

  workflowReplayDepth += 1;
  try {
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index] || {};
      const entry = { step: index, action: step.action || null };
      if (!step.action) {
        results.push({ ...entry, skipped: true });
        continue;
      }
      const wait = Math.min(Math.max(0, Number(step.wait) || 0), WORKFLOW_MAX_STEP_WAIT_MS);
      if (wait > 0) await sleep(wait);
      const stepPayload = { ...(step.payload || {}) };
      // A caller-supplied tabId retargets every tab-scoped step at that tab: a
      // recorded tab id refers to a tab that is almost certainly gone. Steps
      // that carry no tabId are profile-wide (setCookie, downloadUrl) and stay
      // that way, except selector actions, which need a tab to resolve against.
      if (defaultTabId !== undefined && (stepPayload.tabId !== undefined || CACHEABLE_SELECTOR_ACTIONS.has(step.action))) {
        stepPayload.tabId = defaultTabId;
      }
      applyWorkflowBindings(stepPayload, index, bindings);

      // Origin gate: a recorded workflow reproduces mutating actions, so it may
      // only run where it was recorded.
      if (requiredOrigins.length && typeof stepPayload.tabId === "number") {
        const origin = await recordingTabOrigin(stepPayload.tabId);
        if (!origin || !requiredOrigins.includes(origin)) {
          const denial = { ...entry, success: false, error: "originMismatch", err: `Tab origin ${origin || "unknown"} is not in the workflow's requiredOrigins`, origin };
          results.push(denial);
          failed += 1;
          if (halt) break;
          continue;
        }
      }

      const healing = await selectorForReplay(step.action, stepPayload);
      const originalSelector = stepPayload.selector;
      if (healing.selector !== undefined) stepPayload.selector = healing.selector;
      try {
        let result = await dispatchAction(step.action, stepPayload);
        let selfHealed = healing.selfHealed === true;
        const cachedMiss = result && typeof result === "object" && !Array.isArray(result) && result.success === false;
        // A cached CSS path that resolves but no longer behaves gets one
        // re-resolution through the original semantic selector.
        if (cachedMiss && healing.cached && originalSelector !== stepPayload.selector) {
          const refreshed = await resolveCachedSelector({ tabId: stepPayload.tabId, selector: originalSelector, refresh: true });
          if (refreshed.success !== false) {
            stepPayload.selector = refreshed.resolvedSelector || originalSelector;
            result = await dispatchAction(step.action, stepPayload);
            selfHealed = true;
          }
        }
        if (result && typeof result === "object" && !Array.isArray(result) && result.success === false) {
          failed += 1;
          results.push({ ...entry, success: false, selfHealed, err: result.err || result.error || "step reported success=false" });
          if (halt) break;
          continue;
        }
        if (selfHealed) selfHealedSteps += 1;
        results.push({ ...entry, success: true, selfHealed, resultSummary: summarizeRecordedResult(result) });
      } catch (error) {
        failed += 1;
        results.push({ ...entry, success: false, selfHealed: healing.selfHealed === true, err: error.message });
        if (halt) break;
      }
    }
  } finally {
    workflowReplayDepth -= 1;
  }

  return {
    success: failed === 0,
    name: workflow.name || null,
    version: WORKFLOW_VERSION,
    tabId: defaultTabId ?? null,
    stepCount: steps.length,
    ranSteps: results.length,
    failedSteps: failed,
    selfHealedSteps,
    steps: results,
    cache: selectorCacheEntries()
  };
}

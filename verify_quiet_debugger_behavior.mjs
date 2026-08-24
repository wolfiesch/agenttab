#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const BACKGROUND = new URL('./background.js', import.meta.url);
const SESSION_KEY = 'chromeBridgeTaskSessions';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function flush(count = 6) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

export function createHarness({ sessions = {}, tabs = {}, preferences = {}, reconnectState = null } = {}) {
  const listeners = { detach: null, removed: null };
  const localState = {
    [SESSION_KEY]: clone(sessions),
    chromeBridgePreferences: { showAgentPointer: true, ...clone(preferences) },
  };
  if (reconnectState) localState.reconnectState = clone(reconnectState);
  const tabState = new Map(Object.entries(tabs).map(([id, tab]) => [Number(id), { id: Number(id), ...clone(tab) }]));
  const attachedTabs = new Set();
  const heldTabGets = new Map();
  const pendingDetaches = [];
  const lateDetachEvents = [];
  const fakeTimers = new Map();
  const nativeMessages = [];
  let nativeMessageListener = null;
  let nativeDisconnectListener = null;
  let nextTimerId = 1;
  let nextTabId = 1000;

  const controller = {
    attachCalls: 0,
    detachCalls: 0,
    commandMethods: [],
    scriptCalls: [],
    tabGroupUpdates: [],
    groupCalls: 0,
    failNextTabGroupUpdate: false,
    delayDetach: false,
    detachEventAfterCallback: false,
    failNextDetach: false,
    scriptResult: [],
    nativeMessages,
    emitNativeMessage(message) {
      assert.ok(nativeMessageListener, 'expected native message listener');
      nativeMessageListener(clone(message));
    },
    disconnectNative() {
      assert.ok(nativeDisconnectListener, 'expected native disconnect listener');
      nativeDisconnectListener();
    },
    commandResult(method) {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { success: true, x: 10, y: 20, width: 30, height: 40 } } };
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: '1', role: { value: 'slider' }, name: { value: 'Volume' }, value: { value: 50 }, properties: [] },
            { nodeId: '2', role: { value: 'spinbutton' }, name: { value: 'Quantity' }, value: { value: 2 }, properties: [] },
            { nodeId: '3', role: { value: 'button' }, name: { value: 'Save' }, properties: [] },
            { nodeId: '4', role: { value: 'button' }, name: { value: 'Upload' }, properties: [] },
          ]
        };
      }
      return {};
    },
    releaseDetach() {
      const pending = pendingDetaches.shift();
      assert.ok(pending, 'expected a pending debugger detach');
      attachedTabs.delete(pending.tabId);
      if (controller.detachEventAfterCallback) {
        pending.callback();
        lateDetachEvents.push(pending.tabId);
      } else {
        listeners.detach?.({ tabId: pending.tabId }, 'canceled_by_user');
        pending.callback();
      }
    },
    emitLateDetach() {
      const tabId = lateDetachEvents.shift();
      assert.ok(tabId, 'expected a late debugger detach event');
      listeners.detach?.({ tabId }, 'canceled_by_user');
    },
    holdTabGet(tabId) {
      let release;
      let markStarted;
      const promise = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { markStarted = resolve; });
      heldTabGets.set(tabId, { promise, started, release, markStarted });
      return { started, release };
    },
  };

  const runtime = {
    lastError: null,
    connectNative() {
      return {
        onMessage: { addListener(listener) { nativeMessageListener = listener; } },
        onDisconnect: { addListener(listener) { nativeDisconnectListener = listener; } },
        postMessage(message) { nativeMessages.push(clone(message)); },
      };
    },
    onMessage: { addListener() {} },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
  };

  function callbackWithError(callback, message) {
    runtime.lastError = { message };
    try { callback(); } finally { runtime.lastError = null; }
  }

  const chrome = {
    runtime,
    storage: {
      session: {
        async get(key) { return { [key]: clone(localState[key]) }; },
        async set(values) { Object.assign(localState, clone(values)); },
      },
      local: {
        async get(key) { return { [key]: clone(localState[key]) }; },
        async set(values) { Object.assign(localState, clone(values)); },
        async remove(key) { delete localState[key]; },
      },
    },
    alarms: {
      create() {},
      async clear() { return true; },
      onAlarm: { addListener() {} },
    },
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener(listener) { listeners.detach = listener; } },
      attach(target, _version, callback) {
        controller.attachCalls += 1;
        if (attachedTabs.has(target.tabId)) {
          callbackWithError(callback, 'Another debugger is already attached');
          return;
        }
        attachedTabs.add(target.tabId);
        callback();
      },
      detach(target, callback) {
        controller.detachCalls += 1;
        if (controller.failNextDetach) {
          controller.failNextDetach = false;
          callbackWithError(callback, 'Detach failed');
          return;
        }
        if (controller.delayDetach) {
          pendingDetaches.push({ tabId: target.tabId, callback });
          return;
        }
        attachedTabs.delete(target.tabId);
        listeners.detach?.({ tabId: target.tabId }, 'canceled_by_user');
        callback();
      },
      sendCommand(_target, method, params, callback) {
        controller.commandMethods.push(method);
        callback(controller.commandResult(method, params));
      },
    },
    scripting: {
      async executeScript(options) {
        controller.scriptCalls.push(options);
        return clone(controller.scriptResult);
      },
    },
    tabs: {
      onCreated: { addListener(listener) { listeners.created = listener; } },
      onRemoved: { addListener(listener) { listeners.removed = listener; } },
      onUpdated: { addListener() {} },
      async get(tabId) {
        const held = heldTabGets.get(tabId);
        if (held) {
          held.markStarted();
          await held.promise;
          heldTabGets.delete(tabId);
        }
        const tab = tabState.get(tabId);
        if (!tab) throw new Error('No tab with id');
        return clone(tab);
      },
      async query() { return [...tabState.values()].map(clone); },
      async create(options) {
        const tab = { id: nextTabId++, windowId: 1, groupId: -1, active: !!options.active, url: options.url, status: 'complete' };
        tabState.set(tab.id, tab);
        return clone(tab);
      },
      async update(tabId, options) {
        const tab = tabState.get(tabId);
        if (!tab) throw new Error('No tab with id');
        Object.assign(tab, options);
        return clone(tab);
      },
      async remove(tabIds) {
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          tabState.delete(tabId);
          listeners.removed?.(tabId);
        }
      },
      async group({ tabIds, groupId }) {
        controller.groupCalls += 1;
        const chosen = Number.isInteger(groupId) ? groupId : 77;
        for (const tabId of tabIds) tabState.get(tabId).groupId = chosen;
        return chosen;
      },
      async reload() {},
    },
    tabGroups: {
      async update(groupId, options) {
        controller.tabGroupUpdates.push({ groupId, options: clone(options) });
        if (controller.failNextTabGroupUpdate) {
          controller.failNextTabGroupUpdate = false;
          throw new Error('Group disappeared');
        }
      },
    },
    windows: {
      async get(windowId) { return { id: windowId, focused: windowId === 1 }; },
      async update() {},
    },
    cookies: { async getAll() { return []; } },
    downloads: { async download() { return 1; } },
    contentSettings: { location: { async set() {} } },
  };

  const context = vm.createContext({
    chrome,
    console: { debug() {}, log() {}, warn() {}, error() {} },
    URL,
    TextEncoder,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    crypto: { randomUUID: () => `session-${Math.random()}` },
    setTimeout(callback) {
      const id = nextTimerId++;
      fakeTimers.set(id, callback);
      return id;
    },
    clearTimeout(id) { fakeTimers.delete(id); },
  });
  const source = fs.readFileSync(BACKGROUND, 'utf8') + `
    globalThis.__bridgeTest = {
      observeTab,
      dispatchAction,
      findTaskSessionForTab,
      closeTaskSession,
      getTaskSessions,
      withDebugger,
      withTaskDebugger,
      detachTaskDebugger,
      resolveActionTarget,
      clickSelector,
      startMonitoring,
      stopMonitoring,
      loadTaskSessions,
      createTaskSession,
      navigateTaskSession,
      updateTaskSessionState,
      groupTaskTab,
      taskGroupColor,
      taskGroupTitle,
      getBridgeStatus,
      setBridgePreference,
      showAgentPointer,
      showHandoffOverlay,
      debuggerStates: typeof taskDebuggerStates === 'undefined' ? taskDebuggers : taskDebuggerStates,
    };
  `;
  vm.runInContext(source, context, { filename: 'background.js' });

  return {
    api: context.__bridgeTest,
    controller,
    sessions: () => clone(localState[SESSION_KEY] || {}),
    reconnectState: () => clone(localState.reconnectState),
  };
}

async function testCompactObserveUsesBrowserAccessibility() {
  const harness = createHarness({
    sessions: { S: { sessionId: 'S', groupId: 7, tabIds: [1] } },
    tabs: { 1: { groupId: 7, url: 'https://example.com', status: 'complete' } },
  });
  const nodes = await harness.api.observeTab(1, { compact: true, limit: 10 });
  assert.ok(harness.controller.commandMethods.includes('Accessibility.getFullAXTree'));
  assert.deepEqual(Array.from(nodes, (node) => node.role), ['slider', 'spinbutton', 'button', 'button']);
  assert.deepEqual(Array.from(nodes, (node) => node.name), ['Volume', 'Quantity', 'Save', 'Upload']);
}

async function testAcquireWaitsForDetach() {
  const harness = createHarness({
    sessions: { S: { sessionId: 'S', groupId: 7, tabIds: [1] } },
    tabs: { 1: { groupId: 7, url: 'https://example.com' } },
  });
  await harness.api.withTaskDebugger(1, 'S', async () => 'first');
  harness.controller.delayDetach = true;
  const detaching = harness.api.detachTaskDebugger(1);
  await flush();
  const acquiring = harness.api.withTaskDebugger(1, 'S', async () => 'second')
    .then((value) => ({ value }), (error) => ({ error }));
  await flush();
  assert.equal(harness.controller.attachCalls, 1, 'acquire must wait while detach is incomplete');
  harness.controller.releaseDetach();
  await detaching;
  const outcome = await acquiring;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value, 'second');
  assert.equal(harness.controller.attachCalls, 2);
}

async function testMonitoringCannotDetachActiveCommand() {
  const harness = createHarness({
    sessions: { S: { sessionId: 'S', groupId: 7, tabIds: [1] } },
    tabs: { 1: { groupId: 7, url: 'https://example.com' } },
  });
  await harness.api.startMonitoring(1);
  let releaseCommand;
  const commandGate = new Promise((resolve) => { releaseCommand = resolve; });
  const command = harness.api.withDebugger(1, async () => {
    await commandGate;
    return 'done';
  });
  await flush();
  await harness.api.stopMonitoring(1);
  assert.equal(await harness.api.detachTaskDebugger(1), false, 'active command must block idle detach');
  assert.equal(harness.controller.detachCalls, 0);
  releaseCommand();
  assert.equal(await command, 'done');
  assert.equal(await harness.api.detachTaskDebugger(1), true);
  assert.equal(harness.controller.detachCalls, 1);
}

async function testDetachFailureKeepsRecoverableState() {
  const harness = createHarness({
    sessions: { S: { sessionId: 'S', groupId: 7, tabIds: [1] } },
    tabs: { 1: { groupId: 7, url: 'https://example.com' } },
  });
  await harness.api.withTaskDebugger(1, 'S', async () => 'first');
  harness.controller.failNextDetach = true;
  await assert.rejects(harness.api.detachTaskDebugger(1), /Detach failed/);
  assert.equal(harness.api.debuggerStates.get(1)?.phase, 'attached');
  assert.equal(await harness.api.withTaskDebugger(1, 'S', async () => 'recovered'), 'recovered');
  assert.equal(harness.controller.attachCalls, 1, 'recovery must retain the existing attachment');
}

async function testLateDetachEventCannotDeleteNewGeneration() {
  const harness = createHarness({
    sessions: { S: { sessionId: 'S', groupId: 7, tabIds: [1] } },
    tabs: { 1: { groupId: 7, url: 'https://example.com' } },
  });
  await harness.api.withTaskDebugger(1, 'S', async () => 'first');
  harness.controller.delayDetach = true;
  harness.controller.detachEventAfterCallback = true;
  const detaching = harness.api.detachTaskDebugger(1);
  await flush();
  harness.controller.releaseDetach();
  await detaching;
  await harness.api.withTaskDebugger(1, 'S', async () => 'second');
  const current = harness.api.debuggerStates.get(1);
  harness.controller.emitLateDetach();
  assert.equal(harness.api.debuggerStates.get(1), current);
  assert.equal(await harness.api.withTaskDebugger(1, 'S', async () => 'third'), 'third');
}

async function testConcurrentGroupAdoptionsAreSerialized() {
  const harness = createHarness({
    sessions: { S: { sessionId: 'S', groupId: 7, tabIds: [] } },
    tabs: {
      10: { groupId: 7, url: 'https://example.com/10' },
      11: { groupId: 7, url: 'https://example.com/11' },
    },
  });
  await Promise.all([
    harness.api.findTaskSessionForTab(10),
    harness.api.findTaskSessionForTab(11),
  ]);
  assert.deepEqual(harness.sessions().S.tabIds.sort((a, b) => a - b), [10, 11]);
}

async function testConcurrentCloseCannotResurrectSession() {
  const harness = createHarness({
    sessions: { S: { sessionId: 'S', groupId: 7, tabIds: [] } },
    tabs: { 12: { groupId: 7, url: 'https://example.com/12' } },
  });
  const held = harness.controller.holdTabGet(12);
  const adoption = harness.api.findTaskSessionForTab(12);
  await held.started;
  const close = harness.api.closeTaskSession('S');
  await flush();
  held.release();
  await Promise.all([adoption, close]);
  assert.equal(harness.sessions().S, undefined);
}

async function testCurrentGroupReassignsOwnership() {
  const harness = createHarness({
    sessions: {
      A: { sessionId: 'A', groupId: 7, tabIds: [20] },
      B: { sessionId: 'B', groupId: 8, tabIds: [] },
    },
    tabs: { 20: { groupId: 8, url: 'https://example.com/20' } },
  });
  const found = await harness.api.findTaskSessionForTab(20);
  assert.equal(found.sessionId, 'B');
  assert.deepEqual(harness.sessions().A.tabIds, []);
  assert.deepEqual(harness.sessions().B.tabIds, [20]);
}

async function testIdleDebuggerDoesNotHideCurrentGroup() {
  const harness = createHarness({
    sessions: {
      A: { sessionId: 'A', groupId: 7, tabIds: [21] },
      B: { sessionId: 'B', groupId: 8, tabIds: [] },
    },
    tabs: { 21: { groupId: 8, url: 'https://example.com/21' } },
  });
  await harness.api.withTaskDebugger(21, 'A', async () => 'old');
  assert.equal(await harness.api.withDebugger(21, async () => 'new'), 'new');
  assert.equal(harness.api.debuggerStates.get(21)?.sessionId, 'B');
  assert.deepEqual(harness.sessions().A.tabIds, []);
  assert.deepEqual(harness.sessions().B.tabIds, [21]);
}

async function testCloseDoesNotRemoveTabMovedToAnotherGroup() {
  const harness = createHarness({
    sessions: { A: { sessionId: 'A', groupId: 7, tabIds: [22] } },
    tabs: { 22: { groupId: 8, url: 'https://example.com/22' } },
  });
  const result = await harness.api.closeTaskSession('A');
  assert.deepEqual(Array.from(result.closedTabIds), []);
}

async function testTopDocumentSelectorSkipsFrameTreeAndDocumentLookups() {
  const harness = createHarness({
    tabs: { 30: { groupId: -1, url: 'https://example.com', status: 'complete' } },
  });
  const result = await harness.api.resolveActionTarget(30, {
    frames: [],
    target: { kind: 'css', selector: '#save' },
  });
  assert.equal(result.success, true);
  assert.equal(harness.controller.commandMethods.includes('Page.getFrameTree'), false);
  assert.equal(harness.controller.commandMethods.includes('DOM.getDocument'), false);
}

async function testFramedClickInsideActiveModalIsAllowed() {
  const harness = createHarness({
    tabs: { 32: { active: false, windowId: 1, groupId: -1, url: 'https://example.com', status: 'complete' } },
  });
  const frame = {};
  const modal = {
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
    getAttribute: (name) => name === 'role' ? 'dialog' : name === 'aria-label' ? 'Payment' : null,
    contains: (candidate) => candidate === frame,
  };
  const page = {
    querySelectorAll: () => [modal],
    querySelector: (selector) => selector === '#payment-frame' ? frame : null,
  };
  let evaluation = 0;
  harness.controller.commandResult = (method, params) => {
    if (method === 'Runtime.evaluate') {
      evaluation += 1;
      if (evaluation === 1) {
        const value = vm.runInNewContext(params.expression, {
          document: page,
          getComputedStyle: () => ({
            display: 'block',
            visibility: 'visible',
            pointerEvents: 'auto',
          }),
        });
        return { result: { value } };
      }
      const values = [
        {
          success: true,
          frameIndex: 0,
          x: 5,
          y: 7,
          clientLeft: 0,
          clientTop: 0,
        },
        { success: true, x: 10, y: 20, width: 30, height: 40 },
      ];
      return { result: { value: values[evaluation - 2] } };
    }
    if (method === 'Page.getFrameTree') {
      return {
        frameTree: {
          frame: { id: 'top' },
          childFrames: [{ frame: { id: 'child' } }],
        },
      };
    }
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 2 };
    if (method === 'DOM.describeNode') return { node: { frameId: 'child' } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
    return {};
  };

  const result = await harness.api.resolveActionTarget(32, {
    frames: ['#payment-frame'],
    target: { kind: 'css', selector: '#submit-payment' },
    selector: '#submit-payment',
    shadowSegments: [],
  }, null, 'click');

  assert.equal(result.success, true);
  assert.equal(result.frameId, 'child');
  assert.equal(result.contextId, 42);
  assert.equal(result.x, 15);
  assert.equal(result.y, 27);
}



async function testPointerRenderingDoesNotDelayFocusedClick() {
  const harness = createHarness({
    tabs: { 31: { active: true, windowId: 1, groupId: -1, url: 'https://example.com', status: 'complete' } },
  });
  const result = await harness.api.clickSelector(31, '#save', 0);
  assert.equal(result.success, true);
  assert.deepEqual(
    harness.controller.commandMethods.filter((method) => method === 'Input.dispatchMouseEvent'),
    ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent'],
  );
  await flush();
  assert.equal(harness.controller.scriptCalls.length, 1);
}


async function testReconnectBackoffResetsOnlyAfterHostAcknowledges() {
  const harness = createHarness({
    reconnectState: { attempt: 4, delay: 16000 },
  });
  await flush();
  assert.deepEqual(harness.reconnectState(), { attempt: 4, delay: 16000 });
  assert.deepEqual(harness.controller.nativeMessages[0], {
    action: 'hostHandshake',
    protocolVersion: 1,
  });
  harness.controller.emitNativeMessage({
    action: 'hostAcknowledged',
    protocolVersion: 1,
  });
  await flush();
  assert.deepEqual(harness.reconnectState(), { attempt: 0, delay: 1000 });
}


async function testPingRuntimeInstanceIsPrivateAndStable() {
  const harness = createHarness();
  assert.equal(await harness.api.dispatchAction('ping', {}, null), 'pong');
  assert.equal(await harness.api.dispatchAction('ping', { runtimeInstance: false }, null), 'pong');
  const first = await harness.api.dispatchAction('ping', { runtimeInstance: true }, null);
  const second = await harness.api.dispatchAction('ping', { runtimeInstance: true }, null);
  assert.match(first, /^source:session-/);
  assert.equal(second, first);
}


const tests = [
  testCompactObserveUsesBrowserAccessibility,
  testAcquireWaitsForDetach,
  testMonitoringCannotDetachActiveCommand,
  testDetachFailureKeepsRecoverableState,
  testLateDetachEventCannotDeleteNewGeneration,
  testConcurrentGroupAdoptionsAreSerialized,
  testConcurrentCloseCannotResurrectSession,
  testCurrentGroupReassignsOwnership,
  testIdleDebuggerDoesNotHideCurrentGroup,
  testTopDocumentSelectorSkipsFrameTreeAndDocumentLookups,
  testCloseDoesNotRemoveTabMovedToAnotherGroup,
  testFramedClickInsideActiveModalIsAllowed,
  testPointerRenderingDoesNotDelayFocusedClick,
  testReconnectBackoffResetsOnlyAfterHostAcknowledges,
  testPingRuntimeInstanceIsPrivateAndStable,
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const test of tests) {
    await test();
    process.stdout.write(`PASS ${test.name}\n`);
  }
  process.stdout.write('Quiet debugger behavioral contract OK\n');
}

# Semantic automation

AgentTab can run reliable browser loops without fixed post-action sleeps. This is additive to Core RPC v1: existing revisioned refs and separate `browser_act`, `browser_wait`, and `browser_snapshot` calls continue to work unchanged.

## Prefer semantic refs

An accessibility snapshot still returns an exact node `ref` such as `r7-204`. For a uniquely named actionable role, it also returns a `semantic_ref` such as `a7:button:Continue`.

- The page revision remains part of the ref, so navigation cannot silently retarget an old action.
- The role and accessible name are resolved against the current accessibility tree. A same-document SPA rerender may replace backend node `204` and the semantic ref can still resolve.
- A semantic ref is emitted only for a unique, named actionable target in the captured tree. Long names that cannot fit the protocol's 256-character ref bound retain only their exact ref.
- If a later tree has no match, AgentTab returns `target_not_found` with `outcome: not_started`.
- If a later tree has multiple matches, AgentTab returns `ambiguous_target` with `outcome: not_started`. `error.details.candidates` contains at most eight exact refs from a fresh live-tree resolution; take a new snapshot and choose using surrounding context.

Exact refs remain useful when two controls intentionally share a role and name. Semantic resolution does not guess by DOM order, fuzzy text, coordinates, or the previously matching backend node.

## Wait on state, not time

`browser_wait` uses a hybrid event engine:

| Condition | Primary wake-up | Bounded fallback |
|---|---|---|
| `load`, `url` | `chrome.tabs.onUpdated` | 500 ms ownership and policy revalidation |
| `network_idle`, `download` | tab-scoped CDP network/download events | quiet-window deadline and 500 ms revalidation |
| `text`, `selector` | page `MutationObserver` | 500 ms observer slice and revalidation |

Every timer and page observer is removed on match, navigation, error, or timeout. The requested `timeout_ms` is a real deadline, not a retry count. The heartbeat handles a browser event that arrives between the state check and listener registration while keeping ownership revocation and route changes responsive.

Network idle means the task tab has no tracked in-flight request and has remained quiet for 500 ms. It is not a claim that application work has completed. Prefer a specific selector, text, or URL condition when the page exposes one.

## Act → wait → observe

The TypeScript and Python SDKs provide an optional convenience workflow. It issues ordinary Core v1 requests in order, so results, idempotency, Commit, handoff, and recovery semantics stay visible.

```ts
const result = await client.actWaitObserve({
  act: {
    tab_id: tabId,
    expected_page_revision: pageRevision,
    actions: [{ kind: "click", ref: continueButton.semantic_ref }],
  },
  wait: { kind: "selector", value: "[data-step='shipping']" },
  waitTimeoutMs: 15_000,
  observe: { mode: "accessibility", max_nodes: 500 },
});
```

```python
result = client.act_wait_observe(
    {
        "tab_id": tab_id,
        "expected_page_revision": page_revision,
        "actions": [{"kind": "click", "ref": continue_button["semantic_ref"]}],
    },
    wait={"kind": "selector", "value": "[data-step='shipping']"},
    wait_timeout_ms=15_000,
    observe={"mode": "accessibility", "max_nodes": 500},
)
```

When `wait` is omitted, the helper uses `load` after navigation/history/reload, `network_idle` after click/select/drag/dialog/upload, and no wait after local input or scrolling. It returns a fresh accessibility snapshot unless `observe=False`. Pass `wait=false` in TypeScript or `wait=False` in Python to observe immediately. Closing a tab returns after the action and skips wait and observation.

The returned object always includes `outcome`, copied from the `browser_act` Core response, and `action`, containing that response's result payload. `wait` and `observation` are present only when the action outcome is `completed`. A successful `commit_required` or `needs_user` response is returned immediately so callers can commit or hand off without accidentally starting a wait against an action that did not run.

An explicit page postcondition is preferable to the inferred default. The helper is intentionally not one opaque server transaction: failed action responses and unknown transport outcomes still raise the SDK's normal errors before any wait or observation begins.

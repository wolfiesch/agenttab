# AgentTab measurement rules

This repository does not contain a current v2 benchmark harness or published v2 benchmark result. Do not reuse legacy timing tables, adapter comparisons, or scorecards as AgentTab v2 performance evidence.

## What a performance claim requires

Every measured claim must retain a raw artifact and record:

- the exact source commit, dirty-state status, build identity, host version, extension version, and adapter version;
- the complete scenario and success criterion, including URL or controlled fixture, requested action, payload size, and whether an external side effect was intentionally avoided;
- hardware, OS, browser channel/version, Chrome profile class, network conditions, and display/browser state where relevant;
- configuration that can affect the result, including Standard or Developer mode, browser permissions, action policy, IPC endpoint, proxy use, and timeout;
- iteration count, warmup policy, cache state, concurrency, retry policy, start/end time, and per-iteration raw output;
- summary method, exclusions, failures, timeouts, and the raw artifact path.

Separate observed measurements from interpretation. For example, a measured latency distribution may support a statement about that scenario on that machine. It does not establish universal browser performance, safety, availability, or superiority over another product.

## Scenario design

Use controlled fixtures for interaction and Commit measurements. A valid scenario should name the browser path, page readiness condition, snapshot mode, ref revision, action sequence, expected outcome, and timing boundary. Keep authenticated checks limited to benign actions or staged-but-uncommitted effects.

Measure cold and warm paths separately. Distinguish process startup, Native Messaging handshake, host reconciliation, first debugger attach, ordinary request IPC, page work, and response serialization. Report separate-tab and same-tab behavior explicitly; do not infer concurrency from a scheduler that may serialize task work.

When comparing another surface, run the same scenario, user-visible success criterion, browser/profile class, network condition, and iteration policy. Record each tool's version and configuration. Do not compare a local fixture for one tool with a remote authenticated flow for another.

## Commit and handoff measurements

Do not convert security barriers into speed-only scores. If measuring Commit, record classification result, stage creation, human review delay as a separate interval, revalidation outcome, and execution or refusal. Never Commit a real consequential action only to collect a timing number.

If measuring handoff, record only safe lifecycle timestamps such as request accepted, blackout active, completion acknowledged, and resume ready. Do not record keys, secrets, page contents, screenshots, or human input.

## Publishing a result

Before publishing or quoting a result, reproduce it from a clean checkout or documented artifact, retain the raw data, and review it for secrets, identities, URLs, local paths, and profile metadata. Label the result with its date and configuration. If the raw artifact is unavailable, present no numerical claim.

Benchmark evidence is distinct from release evidence. A fast local result does not prove signed packaging, public availability, Chrome Web Store approval, or production reliability.

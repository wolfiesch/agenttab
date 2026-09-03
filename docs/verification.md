# Verification and release evidence

AgentTab verification has distinct evidence layers. Passing a source test is not proof of a real signed package, Chrome Web Store item, registry package, hosted page, or public release. `2.0.0-rc.1` is prerelease and unreleased.

## Offline source gates

Run these from the repository root when validating source changes:

```bash
bun install --frozen-lockfile
bun run workspace:typecheck
bun run workspace:test
bun run workspace:build
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=packages/sdk-python python3 -m unittest discover -s packages/sdk-python/tests -v
PYTHONDONTWRITEBYTECODE=1 python3 tests/architecture/verify_permissions.py
cargo test --locked --manifest-path tests/architecture/ipc-probe/Cargo.toml
PYTHONDONTWRITEBYTECODE=1 python3 tests/architecture/verify_protocol_schemas.py
PYTHONDONTWRITEBYTECODE=1 python3 tests/architecture/verify_identity.py
PYTHONDONTWRITEBYTECODE=1 python3 tests/architecture/verify_forbidden_surface.py
cargo fmt --all --manifest-path host-rs/Cargo.toml -- --check
cargo test --workspace --locked --manifest-path host-rs/Cargo.toml
cargo build --release --locked --manifest-path host-rs/Cargo.toml -p agenttab-host
```

The workspace checks TypeScript adapters, extension code, installer, OMP adapter, and package builds. The architecture gates cover manifest identity, required and optional permission behavior, RPC schemas, forbidden legacy surface, and Rust IPC framing. They do not operate a real signed-in browser.

## Pull request routing

Pull requests that change only `README.md`, `CHANGELOG.md`, `LICENSE`, documentation files ending in `.md`, `.rst`, or `.txt` under `docs/`, or a top-level `.github/*.md` file use the lightweight CI lane. The classifier still scans added public text for credentials, private paths, session identifiers, and private hosts. Source, manifest, workflow, nested GitHub, executable documentation, mixed, empty, or ambiguous changes use the full cross-platform lane.

Branch protection requires the stable `verify` check. The automatic review ruleset requests a fresh review after every push. Before merging, confirm that the latest automated review commit matches the current pull-request head; if the commits differ, request another review. Unresolved review threads remain merge blockers.

## Live browser evidence

Use a disposable Chrome profile and a disposable test account. Reload the unpacked extension through Chrome's extension UI, then observe the actual surface after every UI action. Exercise:

1. required `debugger` availability plus optional `scripting` grant and revocation from the popup;
2. host handshake and reconciliation to ready;
3. create and adopt-active task tabs, child popup inheritance, visible grouping, and ownership revocation after an ungroup or move;
4. accessibility, text, HTML, and screenshot snapshots; stale revision/ref rejection; wait conditions; and debugger detach/restart;
5. ready, working, needs-you, resumed, and finished popup states;
6. Pause, restart while paused, reconciliation, and Resume;
7. nonblocking `browser_handoff`, including concurrent snapshots and mutations plus host and extension restart during the handoff;
8. default inline execution for recognizable consequential controls, then YOLO opt-out with staging, changed-target rejection, and one unchanged Commit execution.

Never Commit a real send, purchase, delete, permission grant, or upload against a live account merely to prove the barrier. Use controlled fixtures and stop at the staged preview for live authenticated checks.

## Platform evidence

Linux and Windows IPC behavior requires the platform-specific jobs in CI:

```bash
cargo test --locked --manifest-path tests/architecture/ipc-probe/Cargo.toml
cargo test --workspace --locked --manifest-path host-rs/Cargo.toml
```

On Windows, additionally prove the current-user SID pipe name, DACL, remote-client rejection, and client SID verification. On Unix, prove the private runtime directory, socket mode, same-user peer check, stale-socket handling, and second-host lock. Source-level success on one platform is not portability evidence for another.

Installer tests use temporary user/config homes and cover transactional configuration changes, malformed configuration preservation, rollback, proxy authentication, and repeat-install behavior. A successful test fixture is not a clean-machine install of a signed release.

## Packaged artifact evidence

The store package is produced locally by `scripts/package_extension_store.py`. Verify the exact ZIP that will be reviewed or installed, its exhaustive member manifest, manifest-referenced assets, and a clean-profile load. Verify release archives only after they are built from a frozen source revision.

For each release candidate, record the source commit, tag, target triple, unsigned staging digest, final artifact digest, artifact-manifest signature, platform signature result, installer version mapping, and clean-machine install result. The installer expects an Ed25519-signed artifact manifest plus Apple code signing on macOS, Authenticode on Windows, and signed-manifest verification on Linux.

The checked-in release trust configuration contains the stable Ed25519 verification public key. That key alone does not prove that a release was signed, published, or installed; verify the signature and platform signing of the exact artifacts independently.

## Publication evidence

These external gates are **unverified** until independently observed on the exact release version and digest:

- repository rename and final repository identity;
- GitHub release assets and checksums;
- npm, PyPI, and prerelease-channel package ownership and publication;
- signing, notarization, Authenticode timestamping, provenance, and SBOM publication;
- Chrome Web Store item ownership and status, package upload, review, trusted-tester install, and production availability;
- a controlled site and privacy-policy URL;
- final domain, support, and store links.

Do not label a release stable, publish a stable install path, or claim availability before all required external gates are verified. Existing public `v1.0.1` is legacy context only, not evidence that v2 is available.

## Evidence record

For every claim, retain the command or scenario, exact source revision, platform and browser version, configuration, account/profile class, cache state, iteration count, timeout, raw artifact path, output, and timestamp. Separate observed facts from inferences. Scrub identities, secrets, URLs, local paths, cookies, page content, resume capabilities, and raw audit records before sharing evidence.

# AgentTab v2 launch gates

AgentTab v2 is currently `2.0.0-rc.1`, a local prerelease. This page records launch gates, not a feature wish list. A checked-in implementation is not a completed launch gate until its required evidence exists.

## Local implementation gates

| Gate | Current source state | Required evidence before promotion |
| --- | --- | --- |
| Product identity | Source identifies AgentTab, `dev.agenttab.host`, `agenttab`, and AgentTab Core RPC v1. | Exact-head identity and forbidden-surface gates. |
| Standard boundary | Source schemas define seven Standard browser tools; Developer mode adds `browser_developer`. | Schema, adapter discovery, and real-extension checks. |
| Task safety | Source implements server-bound tasks, visible groups, revisions, logical Pause, handoff blackout, persistent action-policy profiles, remembered approvals, and staged Commit records. | Controlled browser fixtures covering restart, required-permission continuity, policy profiles, stale revisions, and one-use Commit. |
| Rust runtime | Source contains the Rust host, native bridge, same-user IPC, SQLite journal, and local audit. | Exact-head Rust, IPC, Linux, macOS, and Windows gates. |
| Installer | Source contains a transactional Node-compatible installer and advanced loopback proxy. | Clean user-home and clean-machine install proof using the packaged signed bytes. |
| Extension package | Source contains canonical extension build and store-package tooling. | Inspect and install the exact packaged ZIP in a clean profile. |

## External launch gates

The following gates are unverified in this checkout and block a stable v2 launch:

| Gate | Required evidence |
| --- | --- |
| Release signing | Ed25519 manifest key pinned for the intended channel, final manifest signature, Apple code signing and notarization where required, Windows Authenticode with timestamping, and Linux artifact signature verification. |
| Artifact publication | Immutable GitHub release assets, checksums, provenance/SBOM, and every required target built from the same approved source revision. |
| Package coordinates | Verified publisher ownership and publication for the intended npm and PyPI packages, with exact package-to-tag mapping. |
| Chrome Web Store | New AgentTab item, immutable item ID, exact store ZIP, controlled tester install, review/approval status, and production availability when launch is authorized. |
| Website and privacy | A controlled public hosting URL, privacy policy, support link, and release/checksum links verified against the final artifact. |
| Repository/public surface | Final repository identity, redirect behavior after any rename, verified homepage/topics/description, and public copy that matches the released artifact. |
| Release readiness | Current exact-head CI, resolved actionable review issues, audited launch proof, and all external URLs checked after publication. |

No stable installation call to action belongs on a public surface until the relevant registry, Web Store, site, signing, and platform gates have all passed. The intended local installer command is `npx agenttab install`; this source tree does not prove that a public package or registry entry is available.

## Release progression

1. Freeze an RC source revision and issue a new RC for every fix. Never replace an existing artifact.
2. Build and verify all target artifacts, store ZIP, adapters, and installer from that revision.
3. Complete controlled tester review and record exact digests and platform evidence.
4. After final integration, repeat exact-head gates and produce final signed bytes once.
5. Publish only after each target, account, digest, signing result, and destination is verified. Abort the release boundary on any mismatch.
6. Expose stable quickstarts only after public dependencies are reachable and first-success installation is observed.

## Non-goals and boundaries

- Task groups are a coordination boundary, not profile isolation.
- Commit reduces recognizable consequential actions but cannot prove webpage semantics.
- Handoff protects AgentTab observation during human input, not a compromised device or browser profile.
- A local source test, RC artifact, draft item, or planned domain is not a public availability claim.

Legacy v1.0.1 remains historical migration context until a final stable v2 launch. This roadmap intentionally contains no v1 operational path.

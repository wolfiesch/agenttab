# Protocol development

AgentTab keeps wire behavior reviewable without asking contributors to synchronize lists by hand.
The canonical catalog is [`protocol/agenttab-v1.json`](../protocol/agenttab-v1.json). It owns protocol
names and versions, feature names, frame limits, outcomes, RPC method metadata, native methods and
events, and the mapping from each RPC method to its JSON Schema input.

The JSON Schemas under [`schemas/`](../schemas/) remain the canonical structural definitions for
requests, responses, connection negotiation, native messages, and tool inputs. The generator checks
that their method branches, mutation requirements, outcomes, schema IDs, and registered files agree
with the catalog. MCP consumes the input schemas directly. Rust, TypeScript, Python, and the extension
consume small committed generated catalogs so release artifacts do not need Python at runtime.

## Changing the protocol

1. Edit the catalog and the affected JSON Schemas together.
2. Run `python3 scripts/generate_protocol.py` (or `bun run protocol:generate`).
3. Review the generated diff; generated files are committed.
4. Run `python3 scripts/generate_protocol.py --check` and the normal workspace tests.

CI and release jobs run the check offline and fail when generated files drift. Do not edit files marked
`@generated` directly.

## Compatibility contract

Core `connect` and native `hello` messages may include `supported_versions` and
`supported_features`. Version 1 messages that omit both fields retain their original behavior and
receive the original acknowledgement shape. When a peer advertises capabilities, the host selects an
overlapping version and returns only the feature intersection. Feature names are additive; code must
not infer support for an unadvertised feature.

An incompatible Core connection receives a bounded `kind: "incompatible"` frame before the host
closes the stream. An incompatible native hello receives the corresponding native frame. Both include
the requested protocol/version, host-supported versions, and a recovery instruction. This replaces an
ambiguous EOF while still refusing silent major-version downgrade.

Capability-advertising clients first send the enriched v1 handshake. If a peer closes or rejects that
transport before sending any acknowledgement, the TypeScript and Python SDKs retry once on a new
connection with the exact legacy-v1 handshake. The extension does the same and keeps using legacy v1
for that service-worker lifetime. A timeout, any Core response bytes, any received native message, or
an explicit `incompatible` frame never triggers the fallback. This bounded asymmetric-upgrade path lets
an auto-updated client reach an older strict-v1 host without turning real incompatibility into a retry
loop.

Version and feature fields are optional specifically so the current v1 clients and extension continue
to connect to a newer host. A future major may advertise several supported versions, but it must use
the version selected by the host for every subsequent frame. Removing or changing an existing feature,
method, outcome, or schema constraint requires a new protocol major and a migration note.

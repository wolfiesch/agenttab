# Zig host (transport prototype)

`host-zig/` is a Zig implementation of the native-host transport layer: Chrome
native-messaging framing on stdin/stdout, the token-gated newline-delimited
JSON TCP API on `127.0.0.1:$BRIDGE_PORT`, request-id correlation between TCP
clients and the extension, and stripping of host-only fields (`token`,
`confirmationToken`, `dryRun`, `traceparent`) before anything is forwarded.

**It is not a drop-in replacement for `bridge.py` or `host-rs`.** The policy
engine (action/origin gates, leases, confirmations, DLP, egress allowlist,
audit, policy bundles, telemetry) is not implemented. Registering it as the
`com.automation.bridge` host would forward every valid-token request to the
extension unfiltered. Use it for transport benchmarking and contract work
only.

## Build

```bash
cd host-zig
zig build --release=safe        # zig-out/bin/bridge-host-zig
zig build --release=small       # smaller binary, same behavior
```

Built and verified with Zig 0.16.0. The implementation uses `std.c` (sockets,
files, pthreads) rather than `std.Io`, so it needs no event-loop instance and
is insulated from `std` reorganization.

Cross-compilation needs no target toolchains:

```bash
zig build --release=safe -Dtarget=x86_64-linux-gnu  -p zig-out-linux-x64
zig build --release=safe -Dtarget=aarch64-linux-musl -p zig-out-linux-arm64
```

Both Linux artifacts built in 24 s from a cold cache on an M4 Pro; the musl
build is fully static. The x86_64 artifact was smoke-tested on the Hostinger
VPS (starts, listens, rejects an invalid token). Note `/tmp` on that VPS is
mounted noexec; run the binary from a home directory.

## Verify

```bash
PYTHONDONTWRITEBYTECODE=1 python3 verify_zig_host.py
```

Same contract as `verify_rust_host.py` (port 9226): small round-trip, 500 KB
framing integrity, invalid-token rejection, plus named-token acceptance
(`BRIDGE_TOKENS_FILE`) and clean exit on stdin EOF. All five cases pass.

## Measured comparison

Benchmarked 2026-08-20 on the M4 Pro (macOS 26.2), mock extension answering
every framed command immediately, 10 cold starts, 300 sequential
authenticated pings, 20 runs of a 500 KB response. Caveat: `bridge.py` and
`host-rs` evaluate the full policy engine per request; `host-zig` does not,
so per-request latency comparisons carry that asymmetry. Cold start, memory,
and framing costs are directly comparable.

| Metric | python `bridge.py` | rust `host-rs` | zig `host-zig` (ReleaseSafe) |
| --- | --- | --- | --- |
| Cold start to port ready (median) | 54.2 ms | 4.4 ms | 1.6 ms |
| RSS after ready | 33.3 MB | 6.5 MB | 1.6 MB |
| RSS after 500 KB load | 37.0 MB | 10.1 MB | 2.2 MB |
| Ping round trip (median) | 136 us | 97 us | 111 us |
| Ping round trip (p99) | 257 us | 159 us | 181 us |
| 500 KB response round trip (median) | 2.17 ms | 1.36 ms | 1.54 ms |
| Binary size | n/a (interpreter) | 3.1 MB | 576 KB (safe) / 219 KB (small) |

Takeaways:

- Per-request latency is not the win: the Rust host is slightly faster on
  round trips even while running its policy engine.
- The wins are cold start, resident memory, binary size, and zero-toolchain
  cross-compilation, which matter for distribution (a static sub-600 KB
  artifact per platform with no Cargo or Python on the build host).
- A production Zig host would need the full policy engine ported, roughly
  5,000 lines of behavior parity in `host-rs`, before any of the above
  justifies switching. The transport layer itself is ~550 lines of Zig.

## Behavior notes

- Token files are re-read on every auth attempt instead of mtime-cached
  (files are under 1 KB; behavior is strictly fresher than the other hosts).
- Response timeout defaults to 120 s, override with
  `BRIDGE_RESP_TIMEOUT_SECONDS`.
- Request ids are UUIDv4 strings from `/dev/urandom`, with a seeded
  splitmix64 fallback that guarantees uniqueness only.

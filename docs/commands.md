# AgentTab command reference

AgentTab v2 is `2.0.0-rc.1` source and is not publicly published. The commands below describe the current `agenttab` CLI source. A command that starts with `npx agenttab` is a future public-package command and must not be treated as available today.

Commands intended to be copied contain no user-controlled paths, shell interpolation, token, or quoting. They have the same shape in POSIX shells, PowerShell, and `cmd.exe`. Uppercase values in the reference, such as `PATH`, are metavariables that must be supplied through the relevant client's configuration rather than copied as a command.

## Command summary

```text
agenttab --help
agenttab --version
agenttab install [--version X.Y.Z] [--verify-readiness] [--development --manifest-url URL --signature-url URL]
agenttab update --version X.Y.Z [--verify-readiness]
agenttab rollback [--dry-run]
agenttab uninstall [--dry-run]
agenttab prune [--keep N] [--dry-run]
agenttab status
agenttab doctor [--layer installation|ipc|protocol|host|extension|all]
agenttab mcp
agenttab proxy --token-file PATH [--port 9224]
```

There is no Standard-mode `--port`, no Standard-mode token command, no Python-host command, and no legacy task or lease command.

The CLI rejects unknown commands, unknown or duplicate options, missing option values, and positional arguments after a command. Boolean options do not accept values: use `--dry-run` to enable a dry run and omit it otherwise. In particular, `--dry-run false` and `--dry-run=false` are errors rather than real-install requests.

## `agenttab install`

The intended post-launch install command is:

```text
npx agenttab install
```

It is not usable until the package and signed release artifacts are public. The installer always resolves an exact version rather than `latest`, verifies the signed artifact manifest, requires the matching immutable `vX.Y.Z` asset, verifies the archive plus both host executables, installs transactionally, writes an install receipt, registers the `agenttab-native` relay as `dev.agenttab.host`, and plans supported local client configuration updates. Stable installs also attempt to start the persistent Core with the platform's per-user service manager; on-demand shim startup remains the no-elevation fallback. See [Setup](setup.md) for current source, prerelease, and future stable state.

### Install options

| Option | Current behavior |
|---|---|
| `--version X.Y.Z` | Selects the exact semantic version. The default is the CLI package version, currently `2.0.0-rc.1`. Prerelease suffixes are accepted. |
| `--development` | Enables an approved development-artifact flow. It is required for `file:` artifact URLs and for an explicit public key. It does not turn an arbitrary local build into a supported install. |
| `--manifest-url URL` | Overrides the exact versioned artifact-manifest URL. Non-development URLs must use HTTPS and cannot be a `latest` URL. |
| `--signature-url URL` | Overrides the manifest signature URL. Without it, the CLI uses the manifest URL plus `.sig`. |
| `--public-key PATH` | Reads the manifest verification key from a local file. This is accepted only with `--development`. |
| `--state-dir PATH` | Overrides the installer staging, version, receipt, extension, and wrapper directory. This is distinct from the Rust host default on Windows. |
| `--home PATH` | Overrides the home root used to locate per-user browser registration and supported client configuration files. |
| `--dry-run` | Renders the proposed transaction and returns a planned extension state without applying the file transaction. |
| `--verify-readiness` | Before committing activation, verifies the receipt, IPC endpoint, exact RPC version, exact running host version, and extension routing with one disposable background tab. A failure rolls files, client configuration, and Windows default registry values back together. |
| `--no-open-browser` | With readiness verification, prevents the installer from launching Chrome before it waits for IPC. |

The CLI prints a semantic diff before changing files, skips malformed supported client configuration instead of mutating it, backs up prior changed files, and rolls back touched files if the multi-file transaction or readiness gate fails. The schema-v2 receipt records exact hashes and modes for installed files, the previous file values, semantic client-configuration values, Windows registry default values, and the prior active receipt. Receipts are mode `0600`. It does not silently enable a browser extension. When an extension must be loaded manually, the result includes its directory and instructions.

## Update, rollback, uninstall, and prune

`agenttab update --version X.Y.Z` requires an exact version newer than the active receipt. The executing installer bundle must itself be that exact version, because its CLI, OMP adapter, and extension bytes are part of the activation; an older installed CLI tells the user to run the exact newer installer package instead of mixing versions. It verifies the same immutable signed inputs as install, stages the new version beside the old one, then activates the wrapper, native-host registration, supported client entries, receipt, and optional readiness check as one transaction. It never resolves `latest`; a downgrade uses `agenttab rollback`.

`agenttab rollback` restores the immediately previous activation recorded by the active receipt. It preflights every owned activation file, client entry, and Windows registry default and aborts the whole rollback before changing anything if any one of them drifted. Version artifacts remain available until prune or uninstall. `agenttab uninstall` walks the authenticated active receipt chain, restores values that still exactly match AgentTab's installed values, and removes exact version artifacts. `agenttab prune --keep N` replays inactive artifact ownership newest to oldest, restoring any pre-existing file recorded by the receipt rather than blindly deleting it; it retains receipts as an audit trail.

All lifecycle commands are conservative. A file with a changed hash or mode, an edited `mcpServers.agenttab` value, an edited OMP sequence item, or a changed Windows registry default value is reported as preserved; rollback treats any such preservation as a reason to abort without flipping the active receipt. JSON/YAML cleanup changes only the owned property or sequence item and preserves unrelated edits. Windows cleanup uses default-value deletion (`/ve`) and never recursively deletes a browser/vendor registry key. No command recursively deletes a home, state, version, config, or registry tree. Use `--dry-run` to inspect the complete changed-resource list without applying it.

Install, update, rollback, uninstall, and prune take one cross-process lock for the selected state directory before reading authoritative state. Before their first mutation they record exact before/installed file states and Windows default values, and they preflight the same-directory hard links required on every target filesystem. Unsupported filesystems such as configurations of exFAT or SMB fail before a target is changed. If a process stops before its commit marker is durable, the next mutating command recovers that intent while holding the same lock. Recovery restores only resources that still equal either side of the recorded transaction; a concurrent edit is preserved and blocks further mutation with the exact conflicting resource named. Unix transaction namespace boundaries request filesystem durability with directory barriers. Node does not expose the equivalent Windows directory barrier, so Windows recovery is process-crash atomic but does not claim sudden power-loss atomicity; `agenttab doctor --layer installation` reports that limitation.

The current source contains the stable Ed25519 verification public key, but no matching signed release artifacts or public package have been verified or published. Therefore the default command cannot complete a live installation yet.

## `agenttab status`

```text
agenttab status
```

Connects to local AgentTab IPC and prints the Core `agenttab.status` result as JSON. The status response reports the host lifecycle state, exact host version, protocol version, whether a handoff is active, and the current connection's task identifier when one exists.

Use this only after the extension and native host are installed. It does not start a browser, create a task, use a port, or authenticate with a token.

## `agenttab doctor`

```text
agenttab doctor --layer ipc
```

```text
agenttab doctor --layer extension
```

`--layer` accepts `installation`, `ipc`, `protocol`, `host`, `extension`, or `all`; it defaults to `all`. These are distinct checks:

- `installation` verifies the active receipt and its exact files, semantic client entries, and Windows default values. Its evidence also reports the platform's transaction-recovery scope, including the Windows power-loss limitation.
- `ipc` proves a connection to the per-user host endpoint.
- `protocol` compares the SDK, connection acknowledgment, and host-reported RPC versions.
- `host` requires the ready lifecycle and an exact running-host version match with the active receipt.
- `extension` compares the connected extension's native hello version with the bundled extension version in the active receipt, then creates one disposable background `about:blank` task tab and validates its tab/revision response. The initial task capability is intentionally not confirmed; closing the diagnostic connection invokes the host's exact-task cleanup.

The command prints independent evidence and recovery for every selected layer. It does not relabel a single status RPC as an extension check and does not reload Chrome for you.

## `agenttab mcp` and `agenttab-mcp`

```text
agenttab mcp
```

Starts the AgentTab MCP server over stdin and stdout. It accepts no CLI options. The packaged `agenttab-mcp` binary starts the same server and also accepts no CLI options. Both expose seven Standard tools by default. Use the configured `agenttab` wrapper after a local installation, or the `agenttab-mcp` package binary only after that package is published.

The installer writes supported MCP client entries as an absolute local AgentTab wrapper plus `mcp`. For a manual configuration, use `agenttab mcp` only when that wrapper is on the client's `PATH`. The exact stdio configuration and protocol behavior are in [MCP](mcp.md).

## Adapter environment

| Variable | Current adapter behavior |
|---|---|
| `AGENTTAB_DEVELOPER=1` | Adds `browser_developer` to MCP and OMP discovery. The extension still rejects it unless the user has enabled persistent Developer mode in the AgentTab popup. |
| `AGENTTAB_CONVERSATION_ID` | Overrides the durable resume-capability scope. OMP and Pi otherwise use their stable harness session ID automatically; stdio MCP can use this variable when its client has a stable conversation scope across process restarts. It is metadata, not authorization. |
| `AGENTTAB_STATE_DIR` | Overrides the adapter capability-store root and the Unix socket fallback. The Rust host also honors it as its state root. |
| `AGENTTAB_SOCKET` | Overrides the local endpoint used by an adapter. |
| `AGENTTAB_PIPE_NAME` | Overrides the local Windows named-pipe endpoint used by an adapter. |
| `OMP_AGENT_HOME` | Selects the OMP config root that the installer checks for `config.yml`. |

Endpoint overrides are for a configured local runtime. They do not enable remote access and should not be used to recreate a Standard-mode TCP setup.

## Advanced `agenttab proxy`

```text
agenttab proxy --token-file PATH [--port 9224]
```

This is the only TCP listener in the CLI, and it is deliberately outside normal AgentTab setup. It binds loopback only, defaulting to `127.0.0.1:9224`; `--port 0` requests an ephemeral loopback port. It requires `--token-file` and reads a token of 32 to 1024 characters. On Unix the file must be a current-user regular file with mode `0600`.

The proxy speaks its own `agenttab.proxy/1` authentication frame before forwarding bytes to local AgentTab IPC. It is not an MCP transport, is not used by Standard mode, cannot bind an external interface, and must not be presented as a replacement for the OS-native IPC boundary.

## What the installer configures

When present and structurally valid, the installer adds `mcpServers.agenttab` with the local AgentTab wrapper and `mcp` argument to these per-user configurations:

- Claude Desktop
- Cursor
- Windsurf
- a standard `~/.config/mcp/mcp.json` file
- OMP `config.yml`, as the local AgentTab OMP extension path

Malformed JSON or YAML is reported and left untouched. The installer does not install a global MCP server, create a registry token, or take ownership of unrelated client entries.

## Related documentation

- [Setup, identities, endpoints, migration, and uninstall status](setup.md)
- [MCP setup, tools, outcomes, Commit, and handoff](mcp.md)
- [Core RPC request schema](../schemas/rpc/v1/request.schema.json)
- [Core RPC response schema](../schemas/rpc/v1/response.schema.json)

# AgentTab command reference

AgentTab v2 is `2.0.0-rc.1` source and is not publicly published. The commands below describe the current `agenttab` CLI source. A command that starts with `npx agenttab` is a future public-package command and must not be treated as available today.

Commands intended to be copied contain no user-controlled paths, shell interpolation, token, or quoting. They have the same shape in POSIX shells, PowerShell, and `cmd.exe`. Uppercase values in the reference, such as `PATH`, are metavariables that must be supplied through the relevant client's configuration rather than copied as a command.

## Command summary

```text
agenttab install [--version X.Y.Z] [--verify-readiness] [--development --manifest-url URL --signature-url URL]
agenttab status
agenttab doctor [--layer ipc|extension]
agenttab mcp
agenttab proxy --token-file PATH [--port 9224]
```

There is no `agenttab uninstall`, no Standard-mode `--port`, no Standard-mode token command, no Python-host command, and no legacy task or lease command.

## `agenttab install`

The intended post-launch install command is:

```text
npx agenttab install
```

It is not usable until the package and signed release artifacts are public. The installer always resolves an exact version rather than `latest`, verifies the signed artifact manifest, requires the matching immutable `vX.Y.Z` asset, verifies the asset hash and platform signature, installs transactionally, writes an install receipt, registers `dev.agenttab.host`, and plans supported local client configuration updates. See [Setup](setup.md) for current source, prerelease, and future stable state.

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
| `--verify-readiness` | After installation, connects through the local IPC path, creates a disposable background task tab, captures an accessibility snapshot, and closes the tab. |
| `--no-open-browser` | With readiness verification, prevents the installer from launching Chrome before it waits for IPC. |

The CLI prints a semantic diff before changing files, skips malformed supported client configuration instead of mutating it, backs up prior changed files, and rolls back touched files if the multi-file transaction fails. It does not silently enable a browser extension. When an extension must be loaded manually, the result includes its directory and instructions.

The current source has no configured stable trust key and no public package. Therefore the default command deliberately cannot demonstrate a live installation yet.

## `agenttab status`

```text
agenttab status
```

Connects to local AgentTab IPC and prints the Core `agenttab.status` result as JSON. The status response reports the host lifecycle state, protocol version, whether a handoff is active, and the current connection's task identifier when one exists.

Use this only after the extension and native host are installed. It does not start a browser, create a task, use a port, or authenticate with a token.

## `agenttab doctor`

```text
agenttab doctor --layer ipc
```

```text
agenttab doctor --layer extension
```

`--layer` accepts only `ipc` or `extension`; it defaults to `ipc`. The command runs the same status request and prints JSON. On failure, it returns a layer-specific recovery message:

- `ipc`: open Chrome with AgentTab enabled, then rerun `agenttab doctor --layer ipc`.
- `extension`: reload AgentTab in `chrome://extensions`, then rerun `agenttab doctor --layer extension`.

The extension layer is a diagnostic label around the status check. It does not reload Chrome for you.

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
| `AGENTTAB_CONVERSATION_ID` | Scopes an MCP or OMP durable resume-capability store to one conversation. It is metadata, not authorization. |
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

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { RPC_PROTOCOL, RPC_VERSION, type AgentTabClient } from "../../sdk-typescript/src/index";
import { doctor, prune, queryRegistryValue, rollback, uninstall } from "../src/lifecycle";
import {
  activeStatePath,
  canonicalJson,
  referenceForReceipt,
  sha256,
  type ActiveReceiptReference,
  type FileOwnership,
  type FileSnapshot,
  type InstallReceiptV2,
  type RegistryOwnership,
} from "../src/receipt";
import type { ConfigOwnership } from "../src/configs";
import { TransactionConflictError, transactionJournalPath } from "../src/transaction";

const temporaryRoots: string[] = [];
const restoreEnvironment: Array<() => void> = [];

afterEach(async () => {
  for (const restore of restoreEnvironment.splice(0).reverse()) restore();
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenttab-lifecycle-test-"));
  temporaryRoots.push(root);
  return root;
}

function snapshot(content: string | null, mode = 0o600): FileSnapshot {
  if (content === null) return { exists: false };
  const bytes = Buffer.from(content);
  return {
    exists: true,
    sha256: sha256(bytes),
    contentBase64: bytes.toString("base64"),
    mode,
  };
}

function ownedFile(options: {
  path: string;
  role: FileOwnership["role"];
  installed: string;
  previous: string | null;
  mode?: number;
}): FileOwnership {
  return {
    path: options.path,
    role: options.role,
    installedSha256: sha256(Buffer.from(options.installed)),
    installedMode: options.mode ?? 0o600,
    previous: snapshot(options.previous, options.mode ?? 0o600),
    owned: true,
  };
}

async function writeReceipt(
  stateDir: string,
  name: string,
  receipt: InstallReceiptV2,
): Promise<{ reference: ActiveReceiptReference; bytes: Buffer }> {
  const path = join(stateDir, "receipts", `${name}.json`);
  const bytes = canonicalJson(receipt);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { mode: 0o600 });
  return { reference: referenceForReceipt(receipt.version, path, bytes), bytes };
}

interface Fixture {
  root: string;
  home: string;
  stateDir: string;
  wrapper: string;
  artifactV1: string;
  artifactV2: string;
  jsonConfig: string;
  ompConfig: string;
  v1: ActiveReceiptReference;
  v2: ActiveReceiptReference;
  registryKey: string;
}

async function lifecycleFixture(
  registry: RegistryOwnership[] = [],
  artifactV1Previous: string | null = null,
): Promise<Fixture> {
  const root = await temporaryRoot();
  const home = join(root, "home");
  const stateDir = join(home, ".agenttab");
  const wrapper = join(stateDir, "bin", "agenttab");
  const artifactV1 = join(stateDir, "versions", "v2.0.0", "host");
  const artifactV2 = join(stateDir, "versions", "v2.0.1", "host");
  const jsonConfig = join(home, ".config", "mcp", "mcp.json");
  const ompConfig = join(home, ".omp", "agent", "config.yml");
  const registryKey = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.agenttab.host";
  await Promise.all([
    mkdir(dirname(wrapper), { recursive: true }),
    mkdir(dirname(artifactV1), { recursive: true }),
    mkdir(dirname(artifactV2), { recursive: true }),
    mkdir(dirname(jsonConfig), { recursive: true }),
    mkdir(dirname(ompConfig), { recursive: true }),
  ]);
  await writeFile(wrapper, "wrapper-v2", { mode: 0o600 });
  await writeFile(artifactV1, "artifact-v1", { mode: 0o600 });
  await writeFile(artifactV2, "artifact-v2", { mode: 0o600 });
  await writeFile(jsonConfig, `${JSON.stringify({
    unrelated: "later edit",
    mcpServers: {
      other: { command: "other" },
      agenttab: { command: wrapper, args: ["mcp"] },
    },
  }, null, 2)}\n`);
  await writeFile(ompConfig, "extensions:\n  - unrelated-extension\n  - /adapter-v2.mjs\n");

  const v1Configs: ConfigOwnership[] = [{
    kind: "json_property",
    client: "stdio MCP",
    path: jsonConfig,
    property: ["mcpServers", "agenttab"],
    installedValue: { command: wrapper, args: ["mcp"] },
    previous: { exists: true, value: { command: "user-agenttab", args: [] } },
    owned: true,
  }, {
    kind: "yaml_sequence_item",
    client: "OMP",
    path: ompConfig,
    property: "extensions",
    value: "/adapter-v1.mjs",
    installedPresent: true,
    previousPresent: false,
    owned: true,
  }];
  const v1Receipt: InstallReceiptV2 = {
    schemaVersion: 2,
    activationId: "v1",
    activatedAt: "2026-01-01T00:00:00.000Z",
    version: "2.0.0",
    target: "fixture",
    platform: "linux",
    stateDir,
    home,
    manifestSha256: "1".repeat(64),
    assetSha256: "2".repeat(64),
    hostSha256: sha256(Buffer.from("artifact-v1")),
    shimSha256: "8".repeat(64),
    cliSha256: "3".repeat(64),
    ompSha256: "4".repeat(64),
    extensionSha256: "5".repeat(64),
    extensionVersion: "2.0.0",
    daemonService: { manager: "systemd", managed: false },
    previousActive: { exists: false },
    previousReceipt: null,
    files: [
      ownedFile({ path: wrapper, role: "activation", installed: "wrapper-v1", previous: "user-wrapper" }),
      ownedFile({ path: artifactV1, role: "artifact", installed: "artifact-v1", previous: artifactV1Previous }),
    ],
    configs: v1Configs,
    registry: registry.map((entry) => ({
      ...entry,
      installedValue: "/manifest-v1.json",
      previous: { existed: false, value: null },
    })),
  };
  const writtenV1 = await writeReceipt(stateDir, "v1", v1Receipt);
  const activeV1Bytes = canonicalJson({ schemaVersion: 1, ...writtenV1.reference });

  const v2Receipt: InstallReceiptV2 = {
    ...v1Receipt,
    activationId: "v2",
    activatedAt: "2026-01-02T00:00:00.000Z",
    version: "2.0.1",
    manifestSha256: "6".repeat(64),
    assetSha256: "7".repeat(64),
    hostSha256: sha256(Buffer.from("artifact-v2")),
    extensionVersion: "2.0.1",
    previousActive: {
      exists: true,
      sha256: sha256(activeV1Bytes),
      contentBase64: activeV1Bytes.toString("base64"),
      mode: 0o600,
    },
    previousReceipt: writtenV1.reference,
    files: [
      ownedFile({ path: wrapper, role: "activation", installed: "wrapper-v2", previous: "wrapper-v1" }),
      ownedFile({ path: artifactV2, role: "artifact", installed: "artifact-v2", previous: null }),
    ],
    configs: [{
      kind: "yaml_sequence_item",
      client: "OMP",
      path: ompConfig,
      property: "extensions",
      value: "/adapter-v1.mjs",
      installedPresent: false,
      previousPresent: true,
      owned: true,
    }, {
      kind: "yaml_sequence_item",
      client: "OMP",
      path: ompConfig,
      property: "extensions",
      value: "/adapter-v2.mjs",
      installedPresent: true,
      previousPresent: false,
      owned: true,
    }],
    registry,
  };
  const writtenV2 = await writeReceipt(stateDir, "v2", v2Receipt);
  await writeFile(activeStatePath(stateDir), canonicalJson({ schemaVersion: 1, ...writtenV2.reference }), { mode: 0o600 });
  return {
    root,
    home,
    stateDir,
    wrapper,
    artifactV1,
    artifactV2,
    jsonConfig,
    ompConfig,
    v1: writtenV1.reference,
    v2: writtenV2.reference,
    registryKey,
  };
}

describe("consumer lifecycle", () => {
  test("rolls back activation, then uninstalls every exact artifact while preserving unrelated config", async () => {
    const fixture = await lifecycleFixture();
    const rolledBack = await rollback({ stateDir: fixture.stateDir, home: fixture.home, platform: "linux" });
    expect(rolledBack.activeVersion).toBe("2.0.0");
    expect(await readFile(fixture.wrapper, "utf8")).toBe("wrapper-v1");
    const ompAfterRollback = await readFile(fixture.ompConfig, "utf8");
    expect(ompAfterRollback).toContain("/adapter-v1.mjs");
    expect(ompAfterRollback).not.toContain("/adapter-v2.mjs");
    expect(JSON.parse(await readFile(activeStatePath(fixture.stateDir), "utf8")).version).toBe("2.0.0");
    expect(await readFile(fixture.artifactV2, "utf8")).toBe("artifact-v2");

    const removed = await uninstall({ stateDir: fixture.stateDir, home: fixture.home, platform: "linux" });
    expect(removed.activeVersion).toBeNull();
    expect(await readFile(fixture.wrapper, "utf8")).toBe("user-wrapper");
    const json = JSON.parse(await readFile(fixture.jsonConfig, "utf8"));
    expect(json.unrelated).toBe("later edit");
    expect(json.mcpServers.other).toEqual({ command: "other" });
    expect(json.mcpServers.agenttab).toEqual({ command: "user-agenttab", args: [] });
    const ompAfterUninstall = await readFile(fixture.ompConfig, "utf8");
    expect(ompAfterUninstall).toContain("unrelated-extension");
    expect(ompAfterUninstall).not.toContain("adapter-v1");
    await expect(readFile(fixture.artifactV1)).rejects.toThrow();
    await expect(readFile(fixture.artifactV2)).rejects.toThrow();
    await expect(readFile(activeStatePath(fixture.stateDir))).rejects.toThrow();
    const repeated = await uninstall({ stateDir: fixture.stateDir, home: fixture.home, platform: "linux" });
    expect(repeated.changed).toEqual([]);
    expect(repeated.activeVersion).toBeNull();
  });

  test("preserves later user edits and reports every ownership conflict", async () => {
    const fixture = await lifecycleFixture();
    await writeFile(fixture.wrapper, "user-edited-wrapper");
    const json = JSON.parse(await readFile(fixture.jsonConfig, "utf8"));
    json.mcpServers.agenttab = { command: "user-edited-command" };
    await writeFile(fixture.jsonConfig, `${JSON.stringify(json, null, 2)}\n`);

    const result = await uninstall({ stateDir: fixture.stateDir, home: fixture.home, platform: "linux" });
    expect(await readFile(fixture.wrapper, "utf8")).toBe("user-edited-wrapper");
    expect(JSON.parse(await readFile(fixture.jsonConfig, "utf8")).mcpServers.agenttab).toEqual({ command: "user-edited-command" });
    expect(result.preserved.map((entry) => entry.resource)).toContain(fixture.wrapper);
    expect(result.preserved.some((entry) => entry.resource.includes("mcpServers.agenttab"))).toBe(true);
  });

  test("fault injection restores files and active state as one transaction", async () => {
    const fixture = await lifecycleFixture();
    const activeBefore = await readFile(activeStatePath(fixture.stateDir));
    await expect(rollback({
      stateDir: fixture.stateDir,
      home: fixture.home,
      platform: "linux",
      transactionFailAfter: 2,
    })).rejects.toThrow("Injected transaction failure");
    expect(await readFile(fixture.wrapper, "utf8")).toBe("wrapper-v2");
    expect(await readFile(activeStatePath(fixture.stateDir))).toEqual(activeBefore);
    expect(await readFile(fixture.ompConfig, "utf8")).toContain("/adapter-v2.mjs");
  });

  test("aborts rollback before any mutation when an active resource drifted", async () => {
    const fixture = await lifecycleFixture();
    const activeBefore = await readFile(activeStatePath(fixture.stateDir));
    await writeFile(fixture.wrapper, "user-edited-wrapper");

    await expect(rollback({
      stateDir: fixture.stateDir,
      home: fixture.home,
      platform: "linux",
    })).rejects.toThrow("rollback aborted because active resources drifted");

    expect(await readFile(fixture.wrapper, "utf8")).toBe("user-edited-wrapper");
    expect(await readFile(fixture.ompConfig, "utf8")).toContain("/adapter-v2.mjs");
    expect(await readFile(activeStatePath(fixture.stateDir))).toEqual(activeBefore);
  });

  test("aborts rollback before changing activation when owned config drifted", async () => {
    const fixture = await lifecycleFixture();
    const activeBefore = await readFile(activeStatePath(fixture.stateDir));
    await writeFile(fixture.ompConfig, "extensions:\n  - user-extension\n");

    await expect(rollback({
      stateDir: fixture.stateDir,
      home: fixture.home,
      platform: "linux",
    })).rejects.toThrow("rollback aborted because active resources drifted");

    expect(await readFile(fixture.wrapper, "utf8")).toBe("wrapper-v2");
    expect(await readFile(fixture.ompConfig, "utf8")).toContain("user-extension");
    expect(await readFile(activeStatePath(fixture.stateDir))).toEqual(activeBefore);
  });

  test("prune removes only exact artifacts outside the requested rollback window", async () => {
    const fixture = await lifecycleFixture();
    const result = await prune({ stateDir: fixture.stateDir, home: fixture.home, platform: "linux", keep: 0 });
    expect(result.activeVersion).toBe("2.0.1");
    await expect(readFile(fixture.artifactV1)).rejects.toThrow();
    expect(await readFile(fixture.artifactV2, "utf8")).toBe("artifact-v2");
    expect(await readFile(fixture.v1.receiptPath, "utf8")).toContain('"schemaVersion": 2');
    await expect(rollback({ stateDir: fixture.stateDir, home: fixture.home, platform: "linux" }))
      .rejects.toThrow("previous-version artifact is unavailable");
  });

  test("prune restores a pre-existing file displaced by an inactive artifact", async () => {
    const fixture = await lifecycleFixture([], "pre-existing-host");
    const result = await prune({ stateDir: fixture.stateDir, home: fixture.home, platform: "linux", keep: 0 });
    expect(result.preserved).toEqual([]);
    expect(await readFile(fixture.artifactV1, "utf8")).toBe("pre-existing-host");
    expect(await readFile(fixture.artifactV2, "utf8")).toBe("artifact-v2");
    const repeated = await prune({ stateDir: fixture.stateDir, home: fixture.home, platform: "linux", keep: 0 });
    expect(repeated.changed).toEqual([]);
    expect(repeated.preserved).toEqual([]);
  });

  test("prune orders and deduplicates inactive ownership history newest to oldest", async () => {
    const fixture = await lifecycleFixture([], "pre-existing-host");
    const v1 = JSON.parse(await readFile(fixture.v1.receiptPath, "utf8")) as InstallReceiptV2;
    const inactive: InstallReceiptV2 = {
      ...v1,
      activationId: "inactive-newer",
      activatedAt: "2026-01-03T00:00:00.000Z",
      version: "2.0.0-repacked",
      previousReceipt: null,
      files: [ownedFile({
        path: fixture.artifactV1,
        role: "artifact",
        installed: "artifact-v1-newer",
        previous: "artifact-v1",
      })],
      configs: [],
      registry: [],
    };
    await writeReceipt(fixture.stateDir, "inactive-newer", inactive);
    await writeReceipt(fixture.stateDir, "inactive-newer-copy", inactive);
    await writeFile(fixture.artifactV1, "artifact-v1-newer", { mode: 0o600 });

    const result = await prune({ stateDir: fixture.stateDir, home: fixture.home, platform: "linux", keep: 0 });
    expect(result.preserved).toEqual([]);
    expect(await readFile(fixture.artifactV1, "utf8")).toBe("pre-existing-host");
  });

  test("prune never reverses artifact paths referenced by active or kept receipts", async () => {
    const fixture = await lifecycleFixture();

    // v1 -> v2 -> rollback to v1
    await rollback({ stateDir: fixture.stateDir, home: fixture.home, platform: "linux" });
    const activeV1 = await readFile(activeStatePath(fixture.stateDir), "utf8");
    const oldV2 = JSON.parse(await readFile(fixture.v2.receiptPath, "utf8")) as InstallReceiptV2;

    // Reactivating v2 reuses its exact artifact. The old v2 receipt still claims
    // ownership, while the new active receipt correctly records that it did not
    // create the already-present path.
    const v2Again: InstallReceiptV2 = {
      ...oldV2,
      activationId: "v2-again",
      activatedAt: "2026-01-03T00:00:00.000Z",
      previousActive: snapshot(activeV1),
      previousReceipt: fixture.v1,
      files: oldV2.files.map((file) => file.path === fixture.artifactV2
        ? { ...file, previous: snapshot("artifact-v2"), owned: false }
        : file),
    };
    const activeV2Again = await writeReceipt(fixture.stateDir, "v2-again", v2Again);
    await writeFile(
      activeStatePath(fixture.stateDir),
      canonicalJson({ schemaVersion: 1, ...activeV2Again.reference }),
      { mode: 0o600 },
    );

    // A separate inactive receipt targets the artifact in the kept v1 receipt.
    const v1 = JSON.parse(await readFile(fixture.v1.receiptPath, "utf8")) as InstallReceiptV2;
    await writeReceipt(fixture.stateDir, "inactive-v1-owner", {
      ...v1,
      activationId: "inactive-v1-owner",
      activatedAt: "2026-01-01T12:00:00.000Z",
      previousReceipt: null,
      files: [ownedFile({
        path: fixture.artifactV1,
        role: "artifact",
        installed: "artifact-v1",
        previous: null,
      })],
      configs: [],
      registry: [],
    });

    const result = await prune({ stateDir: fixture.stateDir, home: fixture.home, platform: "linux", keep: 1 });

    expect(result.changed).not.toContain(fixture.artifactV1);
    expect(result.changed).not.toContain(fixture.artifactV2);
    expect(await readFile(fixture.artifactV1, "utf8")).toBe("artifact-v1");
    expect(await readFile(fixture.artifactV2, "utf8")).toBe("artifact-v2");
  });

  test("doctor reports distinct installation, IPC, protocol, host, and extension evidence", async () => {
    const fixture = await lifecycleFixture();
    const calls: string[] = [];
    const connect = (async () => ({
      connection: {
        protocol: RPC_PROTOCOL,
        version: RPC_VERSION,
        kind: "connected",
        connection_id: "fixture",
        resumed: false,
        state: "ready",
      },
      call: async (method: string) => {
        calls.push(method);
        if (method === "agenttab.status") {
          return {
            state: "ready",
            protocol_version: RPC_VERSION,
            host_version: "2.0.1",
            extension_version: "2.0.1",
          };
        }
        if (method === "browser_open") return { tab_id: 41, page_revision: 7 };
        throw new Error(`unexpected method ${method}`);
      },
      close: () => undefined,
    }) as unknown as AgentTabClient) as typeof AgentTabClient.connect;

    const result = await doctor({
      stateDir: fixture.stateDir,
      home: fixture.home,
      platform: "linux",
      connect,
      extensionDeadlineMs: 100,
    });
    expect(result.success).toBe(true);
    expect(result.checks.map((entry) => entry.layer)).toEqual([
      "installation",
      "ipc",
      "protocol",
      "host",
      "extension",
    ]);
    expect(calls).toEqual(["agenttab.status", "agenttab.status", "browser_open"]);

    calls.length = 0;
    const ipcOnly = await doctor({
      stateDir: fixture.stateDir,
      home: fixture.home,
      platform: "linux",
      layer: "ipc",
      connect,
    });
    expect(ipcOnly.success).toBe(true);
    expect(ipcOnly.checks.map((entry) => entry.layer)).toEqual(["ipc"]);
    expect(calls).toEqual([]);

    const windowsInstallation = await doctor({
      stateDir: fixture.stateDir,
      home: fixture.home,
      platform: "win32",
      layer: "installation",
    });
    expect(windowsInstallation.success).toBe(true);
    expect(windowsInstallation.checks[0].detail).toContain("process crashes, not sudden power loss");
    expect(windowsInstallation.checks[0].evidence?.transactionRecovery).toEqual({
      scope: "process_crash",
      limitation: "Node does not expose a Windows directory durability barrier; sudden power-loss namespace atomicity is not claimed",
    });
  });
});

async function installRegistryShim(
  root: string,
  initial: Record<string, string | { type: string; value: string }>,
): Promise<{ statePath: string; logPath: string }> {
  const bin = join(root, "registry-bin");
  const statePath = join(root, "registry.json");
  const logPath = join(root, "registry.log");
  await mkdir(bin, { recursive: true });
  await writeFile(statePath, JSON.stringify(initial));
  await writeFile(join(bin, "reg.exe"), `#!/usr/bin/env python3
import json, os, sys
path = os.environ["AGENTTAB_REGISTRY_FIXTURE"]
log = os.environ["AGENTTAB_REGISTRY_LOG"]
args = sys.argv[1:]
with open(log, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(args) + "\\n")
try:
    with open(path, encoding="utf-8") as handle:
        values = json.load(handle)
except FileNotFoundError:
    values = {}
command, key = args[0], args[1]
if command == "query":
    if os.environ.get("AGENTTAB_REGISTRY_QUERY_ERROR_KEY") == key:
        print("ERROR: Access is denied.", file=sys.stderr)
        sys.exit(5)
    if key not in values:
        print(os.environ.get("AGENTTAB_REGISTRY_NOT_FOUND_TEXT", "Registry value not found."), file=sys.stderr)
        sys.exit(3)
    entry = values[key]
    value_type = entry.get("type", "REG_SZ") if isinstance(entry, dict) else "REG_SZ"
    value = entry.get("value", "") if isinstance(entry, dict) else entry
    if os.environ.get("AGENTTAB_REGISTRY_FAIL_QUERY_VALUE") == value:
        print("ERROR: Injected registry query failure.", file=sys.stderr)
        sys.exit(5)
    print("    (Default)    " + value_type + "    " + value)
    sys.exit(0)
if command == "add":
    value = args[args.index("/d") + 1]
    if os.environ.get("AGENTTAB_REGISTRY_FAIL_ADD_VALUE") == value:
        print("ERROR: Injected registry add failure.", file=sys.stderr)
        sys.exit(5)
    values[key] = value
elif command == "delete":
    if "/ve" not in args:
        sys.exit(9)
    if os.environ.get("AGENTTAB_REGISTRY_FAIL_DELETE_KEY") == key:
        print("ERROR: Injected registry delete failure.", file=sys.stderr)
        sys.exit(5)
    values.pop(key, None)
else:
    sys.exit(2)
with open(path, "w", encoding="utf-8") as handle:
    json.dump(values, handle)
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  const previousFixture = process.env.AGENTTAB_REGISTRY_FIXTURE;
  const previousLog = process.env.AGENTTAB_REGISTRY_LOG;
  const previousExecutable = process.env.AGENTTAB_REG_EXE;
  process.env.PATH = previousPath ? `${bin}${delimiter}${previousPath}` : bin;
  process.env.AGENTTAB_REGISTRY_FIXTURE = statePath;
  process.env.AGENTTAB_REGISTRY_LOG = logPath;
  process.env.AGENTTAB_REG_EXE = join(bin, "reg.exe");
  restoreEnvironment.push(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousFixture === undefined) delete process.env.AGENTTAB_REGISTRY_FIXTURE;
    else process.env.AGENTTAB_REGISTRY_FIXTURE = previousFixture;
    if (previousLog === undefined) delete process.env.AGENTTAB_REGISTRY_LOG;
    else process.env.AGENTTAB_REGISTRY_LOG = previousLog;
    if (previousExecutable === undefined) delete process.env.AGENTTAB_REG_EXE;
    else process.env.AGENTTAB_REG_EXE = previousExecutable;
  });
  return { statePath, logPath };
}

function setRegistryFault(name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  restoreEnvironment.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

describe("Windows lifecycle fixtures", () => {
  test("distinguishes absence and exact REG_SZ data from query failures or unsupported types", async () => {
    const root = await temporaryRoot();
    const empty = "HKCU\\Software\\AgentTabTest\\Empty";
    const spaces = "HKCU\\Software\\AgentTabTest\\Spaces";
    const unsupported = "HKCU\\Software\\AgentTabTest\\Unsupported";
    const denied = "HKCU\\Software\\AgentTabTest\\Denied";
    await installRegistryShim(root, {
      [empty]: "",
      [spaces]: "  C:\\manifest.json  ",
      [unsupported]: { type: "REG_DWORD", value: "1" },
      [denied]: "value",
    });
    setRegistryFault("AGENTTAB_REGISTRY_NOT_FOUND_TEXT", "Der Registrierungsschluessel wurde nicht gefunden.");

    expect(queryRegistryValue("HKCU\\Software\\AgentTabTest\\Missing"))
      .toEqual({ existed: false, value: null });
    expect(queryRegistryValue(empty)).toEqual({ existed: true, value: "" });
    expect(queryRegistryValue(spaces)).toEqual({ existed: true, value: "  C:\\manifest.json  " });
    expect(() => queryRegistryValue(unsupported)).toThrow("unsupported type REG_DWORD");
    setRegistryFault("AGENTTAB_REGISTRY_QUERY_ERROR_KEY", denied);
    expect(() => queryRegistryValue(denied)).toThrow("could not query registry default");
  });

  test("aborts before mutation when an active registry default has an unsupported type", async () => {
    const root = await temporaryRoot();
    const key = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.agenttab.host";
    await installRegistryShim(root, { [key]: { type: "REG_EXPAND_SZ", value: "/manifest-v2.json" } });
    const fixture = await lifecycleFixture([{
      key,
      installedValue: "/manifest-v2.json",
      previous: { existed: true, value: "/manifest-v1.json" },
      owned: true,
    }]);
    const activeBefore = await readFile(activeStatePath(fixture.stateDir));

    await expect(rollback({ stateDir: fixture.stateDir, home: fixture.home, platform: "win32" }))
      .rejects.toThrow("unsupported type REG_EXPAND_SZ");
    expect(await readFile(fixture.wrapper, "utf8")).toBe("wrapper-v2");
    expect(await readFile(activeStatePath(fixture.stateDir))).toEqual(activeBefore);
  });

  test("aborts rollback atomically when the registry default drifted", async () => {
    const root = await temporaryRoot();
    const key = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.agenttab.host";
    await installRegistryShim(root, { [key]: "/user-manifest.json" });
    const fixture = await lifecycleFixture([{
      key,
      installedValue: "/manifest-v2.json",
      previous: { existed: true, value: "/manifest-v1.json" },
      owned: true,
    }]);
    const activeBefore = await readFile(activeStatePath(fixture.stateDir));

    await expect(rollback({ stateDir: fixture.stateDir, home: fixture.home, platform: "win32" }))
      .rejects.toThrow("rollback aborted because active resources drifted");
    expect(await readFile(fixture.wrapper, "utf8")).toBe("wrapper-v2");
    expect(await readFile(activeStatePath(fixture.stateDir))).toEqual(activeBefore);
    expect(queryRegistryValue(key)).toEqual({ existed: true, value: "/user-manifest.json" });
  });

  test("restores only exact default values and never recursively deletes registry keys", async () => {
    const root = await temporaryRoot();
    const key = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.agenttab.host";
    const registry = await installRegistryShim(root, { [key]: "/manifest-v2.json" });
    const fixture = await lifecycleFixture([{
      key,
      installedValue: "/manifest-v2.json",
      previous: { existed: true, value: "/manifest-v1.json" },
      owned: true,
    }]);
    expect(queryRegistryValue(key)).toEqual({ existed: true, value: "/manifest-v2.json" });

    const rolledBack = await rollback({ stateDir: fixture.stateDir, home: fixture.home, platform: "win32" });
    expect(rolledBack.changed).toContain(key);
    expect(JSON.parse(await readFile(registry.statePath, "utf8"))[key]).toBe("/manifest-v1.json");
    await uninstall({ stateDir: fixture.stateDir, home: fixture.home, platform: "win32" });
    expect(JSON.parse(await readFile(registry.statePath, "utf8"))[key]).toBeUndefined();
    const commands = (await readFile(registry.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    for (const args of commands.filter((entry) => entry[0] === "delete")) expect(args).toContain("/ve");
  });

  test("preserves an existing empty registry default value", async () => {
    const root = await temporaryRoot();
    const key = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.agenttab.host";
    const registry = await installRegistryShim(root, { [key]: "/manifest-v2.json" });
    const fixture = await lifecycleFixture([{
      key,
      installedValue: "/manifest-v2.json",
      previous: { existed: true, value: "" },
      owned: true,
    }]);

    await rollback({ stateDir: fixture.stateDir, home: fixture.home, platform: "win32" });
    expect(queryRegistryValue(key)).toEqual({ existed: true, value: "" });
    expect(JSON.parse(await readFile(registry.statePath, "utf8"))[key]).toBe("");
  });

  test("registry fault injection restores registry, files, and active receipt", async () => {
    const root = await temporaryRoot();
    const key = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.agenttab.host";
    const registry = await installRegistryShim(root, { [key]: "/manifest-v2.json" });
    const fixture = await lifecycleFixture([{
      key,
      installedValue: "/manifest-v2.json",
      previous: { existed: true, value: "/manifest-v1.json" },
      owned: true,
    }]);
    const activeBefore = await readFile(activeStatePath(fixture.stateDir));

    await expect(rollback({
      stateDir: fixture.stateDir,
      home: fixture.home,
      platform: "win32",
      registryFailAfter: 1,
    })).rejects.toThrow("Injected registry failure");

    expect(JSON.parse(await readFile(registry.statePath, "utf8"))[key]).toBe("/manifest-v2.json");
    expect(await readFile(fixture.wrapper, "utf8")).toBe("wrapper-v2");
    expect(await readFile(activeStatePath(fixture.stateDir))).toEqual(activeBefore);
  });

  test("retains its recovery journal when immediate registry rollback cannot restore", async () => {
    const root = await temporaryRoot();
    const key = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.agenttab.host";
    const registry = await installRegistryShim(root, { [key]: "/manifest-v2.json" });
    const fixture = await lifecycleFixture([{
      key,
      installedValue: "/manifest-v2.json",
      previous: { existed: true, value: "/manifest-v1.json" },
      owned: true,
    }]);
    const activeBefore = await readFile(activeStatePath(fixture.stateDir));
    setRegistryFault("AGENTTAB_REGISTRY_FAIL_ADD_VALUE", "/manifest-v2.json");

    let failure: unknown;
    try {
      await rollback({
        stateDir: fixture.stateDir,
        home: fixture.home,
        platform: "win32",
        registryFailAfter: 1,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TransactionConflictError);
    expect((failure as TransactionConflictError).recoveryIncomplete).toBe(true);
    expect(existsSync(transactionJournalPath(fixture.stateDir))).toBe(true);
    expect(JSON.parse(await readFile(registry.statePath, "utf8"))[key]).toBe("/manifest-v1.json");
    expect(await readFile(fixture.wrapper, "utf8")).toBe("wrapper-v2");
    expect(await readFile(activeStatePath(fixture.stateDir))).toEqual(activeBefore);

    delete process.env.AGENTTAB_REGISTRY_FAIL_ADD_VALUE;
    const retried = await rollback({ stateDir: fixture.stateDir, home: fixture.home, platform: "win32" });
    expect(retried.activeVersion).toBe("2.0.0");
    expect(existsSync(transactionJournalPath(fixture.stateDir))).toBe(false);
  });

  test("does not report uninstall success when deleting a registry default fails", async () => {
    const root = await temporaryRoot();
    const key = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.agenttab.host";
    const registry = await installRegistryShim(root, { [key]: "/manifest-v2.json" });
    const fixture = await lifecycleFixture([{
      key,
      installedValue: "/manifest-v2.json",
      previous: { existed: false, value: null },
      owned: true,
    }]);
    setRegistryFault("AGENTTAB_REGISTRY_FAIL_DELETE_KEY", key);

    await expect(uninstall({ stateDir: fixture.stateDir, home: fixture.home, platform: "win32" }))
      .rejects.toThrow("could not delete registry default");
    expect(JSON.parse(await readFile(registry.statePath, "utf8"))[key]).toBe("/manifest-v2.json");
  });

  test("recovers a crash after registry activation before retrying rollback", async () => {
    const root = await temporaryRoot();
    const key = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.agenttab.host";
    const registry = await installRegistryShim(root, { [key]: "/manifest-v2.json" });
    const fixture = await lifecycleFixture([{
      key,
      installedValue: "/manifest-v2.json",
      previous: { existed: true, value: "/manifest-v1.json" },
      owned: true,
    }]);

    await expect(rollback({
      stateDir: fixture.stateDir,
      home: fixture.home,
      platform: "win32",
      transactionCrashAfterExternal: true,
    })).rejects.toThrow("Injected transaction crash after external changes");
    expect(JSON.parse(await readFile(registry.statePath, "utf8"))[key]).toBe("/manifest-v1.json");

    const retried = await rollback({ stateDir: fixture.stateDir, home: fixture.home, platform: "win32" });
    expect(retried.activeVersion).toBe("2.0.0");
    expect(await readFile(fixture.wrapper, "utf8")).toBe("wrapper-v1");
    expect(JSON.parse(await readFile(registry.statePath, "utf8"))[key]).toBe("/manifest-v1.json");
  });

  test("retains the journal when registry restoration during crash recovery fails", async () => {
    const root = await temporaryRoot();
    const key = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.agenttab.host";
    const registry = await installRegistryShim(root, { [key]: "/manifest-v2.json" });
    const fixture = await lifecycleFixture([{
      key,
      installedValue: "/manifest-v2.json",
      previous: { existed: true, value: "/manifest-v1.json" },
      owned: true,
    }]);
    await expect(rollback({
      stateDir: fixture.stateDir,
      home: fixture.home,
      platform: "win32",
      transactionCrashAfterExternal: true,
    })).rejects.toThrow("Injected transaction crash after external changes");
    setRegistryFault("AGENTTAB_REGISTRY_FAIL_ADD_VALUE", "/manifest-v2.json");

    let failure: unknown;
    try {
      await rollback({ stateDir: fixture.stateDir, home: fixture.home, platform: "win32" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TransactionConflictError);
    expect((failure as TransactionConflictError).recoveryIncomplete).toBe(true);
    expect(existsSync(transactionJournalPath(fixture.stateDir))).toBe(true);
    expect(JSON.parse(await readFile(registry.statePath, "utf8"))[key]).toBe("/manifest-v1.json");

    delete process.env.AGENTTAB_REGISTRY_FAIL_ADD_VALUE;
    await rollback({ stateDir: fixture.stateDir, home: fixture.home, platform: "win32" });
    expect(existsSync(transactionJournalPath(fixture.stateDir))).toBe(false);
  });
});

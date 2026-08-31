import { execFileSync } from "node:child_process";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { homedir, platform as currentPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDocument, isSeq } from "yaml";
import {
  AgentTabClient,
  AgentTabError,
  RPC_PROTOCOL,
  RPC_VERSION,
  resolveEndpoint,
  type ConnectionAck,
} from "../../sdk-typescript/src/index";
import identityJson from "../../../config/identity.json" with { type: "json" };
import type { ConfigOwnership, JsonConfigOwnership, YamlConfigOwnership } from "./configs";
import {
  activeStatePath,
  expectationFromSnapshot,
  loadActiveReceipt,
  readOptionalBytes,
  readReceipt,
  receiptDirectory,
  sha256,
  snapshotBytes,
  type ActiveInstallState,
  type ActiveReceiptReference,
  type FileOwnership,
  type FileSnapshot,
  type InstallReceiptV2,
  type RegistryOwnership,
  type RegistrySnapshot,
} from "./receipt";
import { withStateDirectoryLock } from "./state-lock";
import {
  activateDaemonService,
  deactivateDaemonService,
  planDaemonService,
  type DaemonServicePlan,
} from "./service";
import {
  applyTransaction,
  expectationFor,
  pendingTransactionExists,
  recoverPendingTransaction,
  TransactionConflictError,
  type DurableExternalChange,
  type ExternalRecoveryHandler,
  type FileExpectation,
  type PlannedChange,
  type PlannedFile,
  type TransactionResult,
} from "./transaction";

const identity = identityJson as { nativeHost: string };

export interface LifecycleOptions {
  stateDir?: string;
  home?: string;
  platform?: NodeJS.Platform;
  dryRun?: boolean;
  print?: (line: string) => void;
  transactionFailAfter?: number;
  transactionCrashAfter?: number;
  transactionCrashAfterExternal?: boolean;
  registryFailAfter?: number;
}

export interface LifecycleResult {
  operation: "rollback" | "uninstall" | "prune";
  changed: string[];
  unchanged: string[];
  preserved: Array<{ resource: string; reason: string }>;
  activeVersion: string | null;
  transaction: TransactionResult;
}

export type RegistryValue = RegistrySnapshot;

export interface RegistryChange {
  key: string;
  expected: RegistryValue;
  target: RegistryValue;
}

export function windowsRegistryKeys(): string[] {
  return [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${identity.nativeHost}`,
    `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${identity.nativeHost}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${identity.nativeHost}`,
  ];
}

function queryRegistryValueWithPowerShell(key: string): RegistryValue {
  const literal = key.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$full = '${literal}'`,
    "if (-not $full.StartsWith('HKCU\\')) { throw 'Only HKCU registry values are supported' }",
    "$path = $full.Substring(5)",
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $false)",
    "if ($null -eq $key) { [ordered]@{ existed = $false } | ConvertTo-Json -Compress; exit 0 }",
    "try {",
    "  if (-not ($key.GetValueNames() -contains '')) { [ordered]@{ existed = $false } | ConvertTo-Json -Compress; exit 0 }",
    "  $kind = $key.GetValueKind('').ToString()",
    "  $value = $key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "  [ordered]@{ existed = $true; kind = $kind; value = [string]$value } | ConvertTo-Json -Compress",
    "} finally { $key.Dispose() }",
  ].join("; ");
  let output: string;
  try {
    output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`AgentTab could not query registry default ${key} with the Windows registry API`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch (error) {
    throw new Error(`AgentTab Windows registry query returned malformed structured output for ${key}`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`AgentTab Windows registry query returned invalid structured output for ${key}`);
  }
  const entry = value as Record<string, unknown>;
  if (entry.existed === false) return { existed: false, value: null };
  if (entry.existed !== true || typeof entry.kind !== "string" || typeof entry.value !== "string") {
    throw new Error(`AgentTab Windows registry query returned invalid structured output for ${key}`);
  }
  if (entry.kind !== "String") throw new Error(`AgentTab registry default ${key} has unsupported type ${entry.kind}`);
  return { existed: true, value: entry.value };
}

export function queryRegistryValue(key: string): RegistryValue {
  if (process.platform === "win32" && process.env.AGENTTAB_REG_EXE === undefined) {
    return queryRegistryValueWithPowerShell(key);
  }
  let output: string;
  try {
    output = execFileSync(process.env.AGENTTAB_REG_EXE ?? "reg.exe", ["query", key, "/ve"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  } catch (error) {
    const failure = error as Error & { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const diagnostic = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
    if (
      (process.env.AGENTTAB_REG_EXE !== undefined && failure.status === 3)
      || (failure.status === 1 && /unable to find the specified registry key or value/i.test(diagnostic))
    ) {
      return { existed: false, value: null };
    }
    throw new Error(`AgentTab could not query registry default ${key}: ${diagnostic.trim() || failure.message}`, { cause: error });
  }
  const rows = output.split(/\r?\n/).flatMap((line) => {
    const match = /\b(REG_[A-Z0-9_]+)\b/.exec(line);
    return match && match.index !== undefined ? [{ line, type: match[1], end: match.index + match[1].length }] : [];
  });
  if (rows.length !== 1) throw new Error(`AgentTab registry query returned malformed output for ${key}`);
  const row = rows[0];
  if (row.type !== "REG_SZ") throw new Error(`AgentTab registry default ${key} has unsupported type ${row.type}`);
  const remainder = row.line.slice(row.end);
  const value = remainder.startsWith("    ")
    ? remainder.slice(4)
    : remainder.startsWith("\t")
      ? remainder.slice(1)
      : null;
  if (value === null) throw new Error(`AgentTab registry query returned an ambiguous REG_SZ value for ${key}`);
  return { existed: true, value };
}

function sameRegistryValue(left: RegistryValue, right: RegistryValue): boolean {
  return left.existed === right.existed
    && (!left.existed || (right.existed && left.value === right.value));
}

function setRegistryValue(key: string, value: RegistryValue): void {
  if (!value.existed) {
    // Delete only the default value. Never recursively delete a browser/vendor key.
    try {
      execFileSync(process.env.AGENTTAB_REG_EXE ?? "reg.exe", ["delete", key, "/ve", "/f"], {
        stdio: "pipe",
        env: { ...process.env },
      });
    } catch (error) {
      const current = queryRegistryValue(key);
      if (!current.existed) return;
      throw new Error(`AgentTab could not delete registry default ${key}`, { cause: error });
    }
    return;
  }
  execFileSync(process.env.AGENTTAB_REG_EXE ?? "reg.exe", ["add", key, "/ve", "/t", "REG_SZ", "/d", value.value, "/f"], {
    stdio: "pipe",
    env: { ...process.env },
  });
}

function registryRecoveryConflict(context: string, key: string, error: unknown): TransactionConflictError {
  if (error instanceof TransactionConflictError && error.recoveryIncomplete) return error;
  return new TransactionConflictError(
    `${context} (${error instanceof Error ? error.message : String(error)})`,
    [key],
    true,
  );
}

export async function applyRegistryChanges(
  changes: RegistryChange[],
  failAfter?: number,
): Promise<() => Promise<void>> {
  const applied: Array<{ key: string; before: RegistryValue }> = [];
  const safelyRestore = async (): Promise<void> => {
    const restore: Array<{ key: string; before: RegistryValue }> = [];
    const problems: string[] = [];
    for (const entry of applied) {
      const change = changes.find((candidate) => candidate.key === entry.key)!;
      try {
        const current = queryRegistryValue(entry.key);
        if (sameRegistryValue(current, entry.before)) continue;
        if (!sameRegistryValue(current, change.target)) {
          problems.push(entry.key);
          continue;
        }
        restore.push(entry);
      } catch (error) {
        problems.push(...registryRecoveryConflict("AgentTab could not preflight registry rollback", entry.key, error).resources);
      }
    }
    for (const entry of [...restore].reverse()) {
      const change = changes.find((candidate) => candidate.key === entry.key)!;
      try {
        const current = queryRegistryValue(entry.key);
        if (sameRegistryValue(current, entry.before)) continue;
        if (!sameRegistryValue(current, change.target)) {
          problems.push(entry.key);
          continue;
        }
        setRegistryValue(entry.key, entry.before);
        if (!sameRegistryValue(queryRegistryValue(entry.key), entry.before)) {
          throw new Error("registry value did not reach its rollback state");
        }
      } catch (error) {
        problems.push(...registryRecoveryConflict("AgentTab could not restore a registry value during transaction rollback", entry.key, error).resources);
      }
    }
    if (problems.length > 0) {
      throw new TransactionConflictError(
        "AgentTab preserved registry values changed during transaction rollback",
        [...new Set(problems)],
        true,
      );
    }
  };
  try {
    for (const change of changes) {
      const current = queryRegistryValue(change.key);
      if (!sameRegistryValue(current, change.expected)) {
        throw new Error(`registry value changed before activation: ${change.key}`);
      }
      if (sameRegistryValue(current, change.target)) continue;
      applied.push({ key: change.key, before: current });
      setRegistryValue(change.key, change.target);
      if (!sameRegistryValue(queryRegistryValue(change.key), change.target)) {
        throw new Error(`registry value did not reach its planned state: ${change.key}`);
      }
      if (failAfter !== undefined && applied.length === failAfter) {
        throw new Error(`Injected registry failure after ${applied.length} values`);
      }
    }
  } catch (error) {
    try {
      await safelyRestore();
    } catch (rollbackError) {
      if (rollbackError instanceof TransactionConflictError) {
        throw new TransactionConflictError(
          `AgentTab registry transaction failed and preserved concurrent changes (${error instanceof Error ? error.message : String(error)})`,
          rollbackError.resources,
          true,
        );
      }
      throw registryRecoveryConflict(
        `AgentTab registry transaction failed and rollback is incomplete (${error instanceof Error ? error.message : String(error)})`,
        applied.at(-1)?.key ?? "Windows registry",
        rollbackError,
      );
    }
    throw error;
  }
  return safelyRestore;
}

export function registryChangesForJournal(changes: RegistryChange[]): DurableExternalChange[] {
  return changes.map((change) => ({
    kind: "windows_registry_default",
    resource: change.key,
    before: change.expected,
    after: change.target,
  }));
}

function registryValueFromJournal(value: unknown): RegistryValue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (entry.existed === false && entry.value === null) return { existed: false, value: null };
  if (entry.existed === true && typeof entry.value === "string") return { existed: true, value: entry.value };
  return null;
}

const registryRecoveryHandler: ExternalRecoveryHandler = {
  async inspect(change) {
    if (!windowsRegistryKeys().includes(change.resource)) return "conflict";
    const before = registryValueFromJournal(change.before);
    const after = registryValueFromJournal(change.after);
    if (!before || !after) return "conflict";
    try {
      const current = queryRegistryValue(change.resource);
      if (sameRegistryValue(current, before)) return "before";
      if (sameRegistryValue(current, after)) return "after";
      return "conflict";
    } catch (error) {
      throw registryRecoveryConflict("AgentTab could not inspect a registry value during crash recovery", change.resource, error);
    }
  },
  async restore(change) {
    const before = registryValueFromJournal(change.before);
    const after = registryValueFromJournal(change.after);
    if (!windowsRegistryKeys().includes(change.resource) || !before || !after) {
      throw new TransactionConflictError("AgentTab preserved a registry value changed during crash recovery", [change.resource], true);
    }
    try {
      const current = queryRegistryValue(change.resource);
      if (sameRegistryValue(current, before)) return;
      if (!sameRegistryValue(current, after)) {
        throw new TransactionConflictError("AgentTab preserved a registry value changed during crash recovery", [change.resource], true);
      }
      setRegistryValue(change.resource, before);
      if (!sameRegistryValue(queryRegistryValue(change.resource), before)) {
        throw new Error("registry value did not reach its recovery state");
      }
    } catch (error) {
      throw registryRecoveryConflict("AgentTab could not restore a registry value during crash recovery", change.resource, error);
    }
  },
};

export async function withInstallerStateMutation<T>(
  stateDir: string,
  operation: string,
  dryRun: boolean | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  return withStateDirectoryLock(stateDir, operation, async () => {
    if (dryRun) {
      if (await pendingTransactionExists(stateDir)) {
        throw new Error(`AgentTab cannot dry-run while an interrupted transaction requires recovery: ${stateDir}`);
      }
    } else {
      await recoverPendingTransaction(stateDir, { windows_registry_default: registryRecoveryHandler });
    }
    return callback();
  });
}

function currentPaths(options: LifecycleOptions): { stateDir: string; home: string; platform: NodeJS.Platform } {
  const home = resolve(options.home ?? homedir());
  return {
    home,
    stateDir: resolve(options.stateDir ?? join(home, ".agenttab")),
    platform: options.platform ?? currentPlatform(),
  };
}

function daemonPlanForReceipt(receipt: InstallReceiptV2): DaemonServicePlan {
  const hostPath = join(
    receipt.stateDir,
    "versions",
    `v${receipt.version}`,
    receipt.target,
    receipt.platform === "win32" ? "agenttab-host.exe" : "agenttab-host",
  );
  return planDaemonService({
    platform: receipt.platform,
    home: receipt.home,
    hostPath,
    stateDir: receipt.stateDir,
  });
}

async function reconcileDaemonService(
  action: "activate" | "deactivate",
  receipt: InstallReceiptV2,
  preserved: LifecycleResult["preserved"],
  print?: (line: string) => void,
): Promise<void> {
  if (!receipt.daemonService.managed) return;
  const plan = daemonPlanForReceipt(receipt);
  try {
    if (action === "activate") await activateDaemonService(plan);
    else await deactivateDaemonService(plan);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    preserved.push({
      resource: `daemon service (${plan.manager})`,
      reason: `${action} failed; the native relay remains available as an on-demand fallback: ${reason}`,
    });
    print?.(`Could not ${action} the ${plan.manager} daemon service; on-demand relay fallback remains available: ${reason}`);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotMatches(snapshot: FileSnapshot, bytes: Buffer | null, mode?: number): boolean {
  if (!snapshot.exists) return bytes === null;
  return bytes !== null
    && sha256(bytes) === snapshot.sha256
    && (snapshot.mode === undefined || mode === undefined || snapshot.mode === mode);
}

async function modeOptional(path: string, bytes: Buffer | null): Promise<number | undefined> {
  return bytes !== null && process.platform !== "win32" ? (await stat(path)).mode & 0o777 : undefined;
}

function planFromSnapshot(
  path: string,
  target: FileSnapshot,
  label: string,
  expectedBefore?: FileExpectation,
  statePointer = false,
): PlannedChange {
  if (!target.exists) return { operation: "delete", path, label, expectedBefore, statePointer };
  const bytes = snapshotBytes(target)!;
  if (sha256(bytes) !== target.sha256) throw new Error(`receipt snapshot hash mismatch for ${path}`);
  return {
    path,
    content: bytes,
    ...(target.mode === undefined ? {} : { mode: target.mode }),
    label,
    expectedBefore,
    statePointer,
  };
}

async function planFileReversal(
  receipts: InstallReceiptV2[],
  roles: Set<FileOwnership["role"]>,
  preserved: LifecycleResult["preserved"],
  excludedPaths: ReadonlySet<string> = new Set(),
): Promise<PlannedChange[]> {
  const byPath = new Map<string, FileOwnership[]>();
  for (const receipt of receipts) {
    for (const file of receipt.files) {
      if (!file.owned || !roles.has(file.role) || excludedPaths.has(file.path)) continue;
      const entries = byPath.get(file.path) ?? [];
      entries.push(file);
      byPath.set(file.path, entries);
    }
  }
  const plans: PlannedChange[] = [];
  for (const [path, entries] of byPath) {
    const current = await readOptionalBytes(path);
    const currentMode = await modeOptional(path, current);
    const matchesInstalled = (entry: FileOwnership, bytes: Buffer | null, mode?: number): boolean =>
      bytes !== null
      && sha256(bytes) === entry.installedSha256
      && (entry.installedMode === undefined || mode === undefined || entry.installedMode === mode);
    const start = entries.findIndex((entry) => matchesInstalled(entry, current, currentMode));
    if (start === -1) {
      const fullyReversed = entries.at(-1)!.previous;
      if (snapshotMatches(fullyReversed, current, currentMode)) continue;
      preserved.push({ resource: path, reason: "value or mode changed after AgentTab activation" });
      continue;
    }
    let virtualBytes = current;
    let virtualMode = currentMode;
    let blocked = false;
    for (const entry of entries.slice(start)) {
      if (blocked) continue;
      if (!matchesInstalled(entry, virtualBytes, virtualMode)) {
        preserved.push({ resource: path, reason: "value or mode changed after AgentTab activation" });
        blocked = true;
        continue;
      }
      virtualBytes = snapshotBytes(entry.previous);
      virtualMode = entry.previous.exists ? entry.previous.mode : undefined;
    }
    const target: FileSnapshot = virtualBytes === null
      ? { exists: false }
      : {
          exists: true,
          sha256: sha256(virtualBytes),
          contentBase64: virtualBytes.toString("base64"),
          ...(virtualMode === undefined ? {} : { mode: virtualMode }),
        };
    if (!snapshotMatches(target, current, currentMode)) {
      plans.push(planFromSnapshot(path, target, `restore ${path}`, expectationFor(current, currentMode)));
    }
  }
  return plans;
}

interface ConfigDocumentState {
  source: string;
  changed: boolean;
  blocked: Set<string>;
}

async function planConfigReversal(
  receipts: InstallReceiptV2[],
  preserved: LifecycleResult["preserved"],
): Promise<PlannedFile[]> {
  const operations = new Map<string, ConfigOwnership[]>();
  for (const receipt of receipts) {
    for (const config of receipt.configs) {
      if (!config.owned) continue;
      const entries = operations.get(config.path) ?? [];
      entries.push(config);
      operations.set(config.path, entries);
    }
  }
  const plans: PlannedFile[] = [];
  for (const [path, entries] of operations) {
    const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (source === null) {
      preserved.push({ resource: path, reason: "configuration file was removed after AgentTab activation" });
      continue;
    }
    const sourceBytes = Buffer.from(source, "utf8");
    const sourceMode = await modeOptional(path, sourceBytes);
    const state: ConfigDocumentState = { source, changed: false, blocked: new Set() };
    const jsonEntries = entries.filter((entry): entry is JsonConfigOwnership => entry.kind === "json_property");
    if (jsonEntries.length > 0) {
      let value: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(source);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("top level is not an object");
        value = parsed as Record<string, unknown>;
      } catch (error) {
        preserved.push({ resource: path, reason: `configuration is no longer valid JSON: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      for (const entry of jsonEntries) {
        const key = "mcpServers.agenttab";
        if (state.blocked.has(key)) continue;
        const servers = value.mcpServers;
        const record = typeof servers === "object" && servers !== null && !Array.isArray(servers)
          ? servers as Record<string, unknown>
          : null;
        const exists = record !== null && Object.prototype.hasOwnProperty.call(record, "agenttab");
        const currentValue = exists ? record!.agenttab : undefined;
        if (!exists || !sameJson(currentValue, entry.installedValue)) {
          preserved.push({ resource: `${path}#${key}`, reason: "value changed after AgentTab activation" });
          state.blocked.add(key);
          continue;
        }
        if (entry.previous.exists) {
          record!.agenttab = structuredClone(entry.previous.value);
        } else {
          delete record!.agenttab;
        }
        state.changed = true;
      }
      if (state.changed) state.source = `${JSON.stringify(value, null, 2)}\n`;
    }

    const yamlEntries = entries.filter((entry): entry is YamlConfigOwnership => entry.kind === "yaml_sequence_item");
    if (yamlEntries.length > 0) {
      const document = parseDocument(state.source);
      if (document.errors.length > 0) {
        preserved.push({ resource: path, reason: `configuration is no longer valid YAML: ${document.errors[0].message}` });
        continue;
      }
      const extensions = document.get("extensions", true);
      if (extensions !== undefined && !isSeq(extensions)) {
        preserved.push({ resource: `${path}#extensions`, reason: "extensions is no longer a YAML sequence" });
        continue;
      }
      const values = isSeq(extensions) ? extensions.items.map((item) => String(item)) : [];
      let yamlChanged = false;
      for (const entry of yamlEntries) {
        const key = `extensions:${entry.value}`;
        if (state.blocked.has(key)) continue;
        const present = values.includes(entry.value);
        if (present !== entry.installedPresent) {
          preserved.push({ resource: `${path}#${key}`, reason: "sequence item changed after AgentTab activation" });
          state.blocked.add(key);
          continue;
        }
        if (entry.previousPresent && !present) values.push(entry.value);
        if (!entry.previousPresent && present) values.splice(values.indexOf(entry.value), 1);
        yamlChanged = yamlChanged || present !== entry.previousPresent;
      }
      if (yamlChanged) {
        document.set("extensions", values);
        state.source = document.toString();
        state.changed = true;
      }
    }
    if (state.changed) {
      plans.push({
        path,
        content: state.source,
        label: `restore AgentTab entries in ${path}`,
        expectedBefore: expectationFor(sourceBytes, sourceMode),
      });
    }
  }
  return plans;
}

function planRegistryReversal(
  receipts: InstallReceiptV2[],
  preserved: LifecycleResult["preserved"],
): RegistryChange[] {
  const byKey = new Map<string, RegistryOwnership[]>();
  for (const receipt of receipts) {
    for (const entry of receipt.registry) {
      if (!entry.owned) continue;
      const entries = byKey.get(entry.key) ?? [];
      entries.push(entry);
      byKey.set(entry.key, entries);
    }
  }
  const changes: RegistryChange[] = [];
  for (const [key, entries] of byKey) {
    const current = queryRegistryValue(key);
    let virtual = current;
    let blocked = false;
    for (const entry of entries) {
      if (blocked) continue;
      const expected: RegistryValue = { existed: true, value: entry.installedValue };
      if (!sameRegistryValue(virtual, expected)) {
        preserved.push({ resource: key, reason: "registry default value changed after AgentTab activation" });
        blocked = true;
        continue;
      }
      virtual = entry.previous;
    }
    if (!sameRegistryValue(current, virtual)) changes.push({ key, expected: current, target: virtual });
  }
  return changes;
}

async function loadReceiptChain(
  stateDir: string,
): Promise<{
  active: ActiveInstallState;
  activeSnapshot: FileSnapshot;
  receipts: InstallReceiptV2[];
  references: ActiveReceiptReference[];
}> {
  const loaded = await loadActiveReceipt(stateDir);
  if (!loaded) throw new Error("AgentTab is not installed in this state directory");
  const receipts: InstallReceiptV2[] = [];
  const references: ActiveReceiptReference[] = [];
  const seen = new Set<string>();
  const seenActivations = new Set<string>();
  let reference: ActiveReceiptReference | null = loaded.state;
  while (reference) {
    if (seen.has(reference.receiptPath)) throw new Error("AgentTab receipt history contains a cycle");
    seen.add(reference.receiptPath);
    const entry = await readReceipt(reference, stateDir);
    if (seenActivations.has(entry.receipt.activationId)) {
      throw new Error("AgentTab receipt history contains a duplicate activation");
    }
    seenActivations.add(entry.receipt.activationId);
    receipts.push(entry.receipt);
    references.push(reference);
    reference = entry.receipt.previousReceipt;
  }
  return { active: loaded.state, activeSnapshot: loaded.stateSnapshot, receipts, references };
}

async function applyLifecycleTransaction(options: {
  operation: LifecycleResult["operation"];
  stateDir: string;
  plans: PlannedChange[];
  registry: RegistryChange[];
  preserved: LifecycleResult["preserved"];
  activeVersion: string | null;
  dryRun?: boolean;
  print?: (line: string) => void;
  transactionFailAfter?: number;
  transactionCrashAfter?: number;
  transactionCrashAfterExternal?: boolean;
  registryFailAfter?: number;
}): Promise<LifecycleResult> {
  const transaction = await applyTransaction(options.plans, {
    dryRun: options.dryRun,
    failAfter: options.transactionFailAfter,
    crashAfter: options.transactionCrashAfter,
    crashAfterExternal: options.transactionCrashAfterExternal,
    printDiff: options.print,
    journal: {
      stateDir: options.stateDir,
      operation: options.operation,
      external: registryChangesForJournal(options.registry),
    },
    applyExternal: options.registry.length === 0
      ? undefined
      : () => applyRegistryChanges(options.registry, options.registryFailAfter),
  });
  return {
    operation: options.operation,
    changed: transaction.changed,
    unchanged: transaction.unchanged,
    preserved: options.preserved,
    activeVersion: options.activeVersion,
    transaction,
  };
}

async function rollbackUnlocked(options: LifecycleOptions): Promise<LifecycleResult> {
  const { stateDir, platform } = currentPaths(options);
  const chain = await loadReceiptChain(stateDir);
  const current = chain.receipts[0];
  if (!current.previousReceipt) throw new Error("AgentTab has no previous activation to roll back to");
  const previous = chain.receipts[1];
  if (!previous) throw new Error("AgentTab previous activation receipt is unavailable");
  for (const file of previous.files) {
    if (file.role !== "artifact") continue;
    const bytes = await readOptionalBytes(file.path);
    const mode = await modeOptional(file.path, bytes);
    if (
      bytes === null
      || sha256(bytes) !== file.installedSha256
      || (file.installedMode !== undefined && mode !== undefined && file.installedMode !== mode)
    ) {
      throw new Error(`AgentTab cannot roll back because a previous-version artifact is unavailable or changed: ${file.path}`);
    }
  }
  if (!current.previousActive.exists) throw new Error("AgentTab rollback receipt is missing its previous active state");
  const previousActiveBytes = snapshotBytes(current.previousActive)!;
  const parsedPrevious = JSON.parse(previousActiveBytes.toString("utf8")) as ActiveInstallState;
  if (
    parsedPrevious.receiptPath !== current.previousReceipt.receiptPath
    || parsedPrevious.receiptSha256 !== current.previousReceipt.receiptSha256
    || parsedPrevious.version !== current.previousReceipt.version
  ) throw new Error("AgentTab rollback receipt does not match its previous active state");

  const preserved: LifecycleResult["preserved"] = [];
  const activationPlans = await planFileReversal([current], new Set(["activation"]), preserved);
  const configPlans = await planConfigReversal([current], preserved);
  const registry = platform === "win32" ? planRegistryReversal([current], preserved) : [];
  if (preserved.length > 0) {
    throw new Error(
      `AgentTab rollback aborted because active resources drifted: ${preserved.map((entry) => entry.resource).join(", ")}`,
    );
  }
  const plans: PlannedChange[] = [
    ...activationPlans,
    ...configPlans,
    planFromSnapshot(
      activeStatePath(stateDir),
      current.previousActive,
      "restore previous AgentTab activation",
      expectationFromSnapshot(chain.activeSnapshot),
      true,
    ),
  ];
  const result = await applyLifecycleTransaction({
    operation: "rollback",
    stateDir,
    plans,
    registry,
    preserved,
    activeVersion: current.previousReceipt.version,
    ...options,
  });
  if (!options.dryRun) {
    await reconcileDaemonService("activate", previous, preserved, options.print);
  }
  return result;
}

export async function rollback(options: LifecycleOptions = {}): Promise<LifecycleResult> {
  const { stateDir } = currentPaths(options);
  return withInstallerStateMutation(stateDir, "rollback", options.dryRun, () => rollbackUnlocked(options));
}

async function uninstallUnlocked(options: LifecycleOptions): Promise<LifecycleResult> {
  const { stateDir, platform } = currentPaths(options);
  if (!await loadActiveReceipt(stateDir)) {
    return {
      operation: "uninstall",
      changed: [],
      unchanged: [],
      preserved: [],
      activeVersion: null,
      transaction: { changed: [], unchanged: [], backups: [] },
    };
  }
  const chain = await loadReceiptChain(stateDir);
  const allReceipts = await receiptFiles(stateDir);
  const chainPaths = new Set(chain.references.map((reference) => reference.receiptPath));
  const inactiveReceipts = allReceipts.filter((entry) => !chainPaths.has(entry.path));
  const preserved: LifecycleResult["preserved"] = [];
  const oldest = chain.receipts.at(-1)!;
  const artifactHistory = newestReceiptHistory([
    ...chain.receipts,
    ...inactiveReceipts.map((entry) => entry.receipt),
  ]);
  const plans: PlannedChange[] = [
    ...await planFileReversal(chain.receipts, new Set(["activation"]), preserved),
    ...await planFileReversal(artifactHistory, new Set(["artifact"]), preserved),
    ...await planConfigReversal(chain.receipts, preserved),
    planFromSnapshot(
      activeStatePath(stateDir),
      oldest.previousActive,
      "remove AgentTab active activation",
      expectationFromSnapshot(chain.activeSnapshot),
      true,
    ),
  ];
  for (const reference of chain.references) {
    const current = await readOptionalBytes(reference.receiptPath);
    if (current && sha256(current) === reference.receiptSha256) {
      plans.push({
        operation: "delete",
        path: reference.receiptPath,
        label: "remove exact AgentTab receipt",
        expectedBefore: expectationFor(current, await modeOptional(reference.receiptPath, current)),
        statePointer: true,
      });
    } else {
      preserved.push({ resource: reference.receiptPath, reason: "receipt changed after activation" });
    }
  }
  for (const entry of inactiveReceipts) {
    const current = await readOptionalBytes(entry.path);
    if (current?.equals(entry.bytes)) {
      plans.push({
        operation: "delete",
        path: entry.path,
        label: "remove exact inactive AgentTab receipt",
        expectedBefore: expectationFor(current, await modeOptional(entry.path, current)),
        statePointer: true,
      });
    } else {
      preserved.push({ resource: entry.path, reason: "inactive receipt changed after activation" });
    }
  }
  const registry = platform === "win32" ? planRegistryReversal(chain.receipts, preserved) : [];
  const current = chain.receipts[0];
  if (!options.dryRun) {
    await reconcileDaemonService("deactivate", current, preserved, options.print);
  }
  try {
    return await applyLifecycleTransaction({
      operation: "uninstall",
      stateDir,
      plans,
      registry,
      preserved,
      activeVersion: null,
      ...options,
    });
  } catch (error) {
    if (!options.dryRun) {
      await reconcileDaemonService("activate", current, preserved, options.print);
    }
    throw error;
  }
}

export async function uninstall(options: LifecycleOptions = {}): Promise<LifecycleResult> {
  const { stateDir } = currentPaths(options);
  return withInstallerStateMutation(stateDir, "uninstall", options.dryRun, () => uninstallUnlocked(options));
}

function newestReceiptHistory(receipts: InstallReceiptV2[]): InstallReceiptV2[] {
  const seen = new Map<string, string>();
  return [...receipts]
    .sort((left, right) => right.activatedAt.localeCompare(left.activatedAt) || right.activationId.localeCompare(left.activationId))
    .filter((receipt) => {
      const fingerprint = sha256(Buffer.from(JSON.stringify(receipt)));
      const previous = seen.get(receipt.activationId);
      if (previous && previous !== fingerprint) {
        throw new Error(`AgentTab receipt history contains conflicting activation ${receipt.activationId}`);
      }
      if (previous) return false;
      seen.set(receipt.activationId, fingerprint);
      return true;
    });
}

async function receiptFiles(stateDir: string): Promise<Array<{ path: string; receipt: InstallReceiptV2; bytes: Buffer }>> {
  let names: string[];
  try {
    names = await readdir(receiptDirectory(stateDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found: Array<{ path: string; receipt: InstallReceiptV2; bytes: Buffer }> = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const path = join(receiptDirectory(stateDir), name);
    try {
      const bytes = await readFile(path);
      const value = JSON.parse(bytes.toString("utf8")) as { version?: unknown };
      if (typeof value.version !== "string") continue;
      const loaded = await readReceipt({ version: value.version, receiptPath: path, receiptSha256: sha256(bytes) }, stateDir);
      found.push({ path, receipt: loaded.receipt, bytes: loaded.bytes });
    } catch {
      // An unknown or edited file in the receipt directory is never a prune target.
    }
  }
  const seen = new Map<string, string>();
  return found
    .sort((left, right) =>
      right.receipt.activatedAt.localeCompare(left.receipt.activatedAt) || right.path.localeCompare(left.path)
    )
    .filter((entry) => {
      const fingerprint = sha256(entry.bytes);
      const previous = seen.get(entry.receipt.activationId);
      if (previous && previous !== fingerprint) {
        throw new Error(`AgentTab receipt directory contains conflicting activation ${entry.receipt.activationId}`);
      }
      if (previous) return false;
      seen.set(entry.receipt.activationId, fingerprint);
      return true;
    });
}

async function pruneUnlocked(options: LifecycleOptions & { keep?: number }): Promise<LifecycleResult> {
  const { stateDir } = currentPaths(options);
  const keep = options.keep ?? 1;
  if (!Number.isSafeInteger(keep) || keep < 0) throw new Error("prune keep must be a non-negative integer");
  if (!await loadActiveReceipt(stateDir)) {
    return {
      operation: "prune",
      changed: [],
      unchanged: [],
      preserved: [],
      activeVersion: null,
      transaction: { changed: [], unchanged: [], backups: [] },
    };
  }
  const chain = await loadReceiptChain(stateDir);
  const protectedChain = chain.receipts.slice(0, keep + 1);
  const protectedReceipts = new Set(chain.references.slice(0, keep + 1).map((reference) => reference.receiptPath));
  // A newer inactive receipt may claim ownership of the same immutable artifact
  // reused by the active or retained rollback window. Receipt ownership alone is
  // not permission to reverse a path still referenced by a protected activation.
  const protectedArtifactPaths = new Set(
    protectedChain.flatMap((receipt) => receipt.files
      .filter((file) => file.role === "artifact")
      .map((file) => file.path)),
  );
  const preserved: LifecycleResult["preserved"] = [];
  const inactive = (await receiptFiles(stateDir)).filter((entry) => !protectedReceipts.has(entry.path));
  const plans = await planFileReversal(
    newestReceiptHistory(inactive.map((entry) => entry.receipt)),
    new Set(["artifact"]),
    preserved,
    protectedArtifactPaths,
  );
  return applyLifecycleTransaction({
    operation: "prune",
    stateDir,
    plans,
    registry: [],
    preserved,
    activeVersion: chain.active.version,
    ...options,
  });
}

export async function prune(options: LifecycleOptions & { keep?: number } = {}): Promise<LifecycleResult> {
  const { stateDir } = currentPaths(options);
  return withInstallerStateMutation(stateDir, "prune", options.dryRun, () => pruneUnlocked(options));
}

export type DoctorLayer = "installation" | "ipc" | "protocol" | "host" | "extension";

export interface DoctorCheck {
  layer: DoctorLayer;
  success: boolean;
  detail: string;
  recovery?: string;
  evidence?: Record<string, unknown>;
}

export interface DoctorResult {
  success: boolean;
  version?: string;
  checks: DoctorCheck[];
}

export interface DoctorOptions extends LifecycleOptions {
  layer?: DoctorLayer | "all";
  connect?: typeof AgentTabClient.connect;
  extensionDeadlineMs?: number;
  waitForReady?: boolean;
}

function check(layer: DoctorLayer, success: boolean, detail: string, evidence?: Record<string, unknown>): DoctorCheck {
  const recovery: Partial<Record<DoctorLayer, string>> = {
    installation: "Run agenttab update with an exact signed version, or restore the reported changed file.",
    ipc: "Open Chrome with AgentTab enabled, then rerun agenttab doctor --layer ipc.",
    protocol: "Update AgentTab so the CLI, host, and extension use the same protocol version.",
    host: "Run agenttab update with the intended exact version, then restart Chrome.",
    extension: "Reload AgentTab in chrome://extensions and enable automation, then rerun this check.",
  };
  return { layer, success, detail, ...(success ? {} : { recovery: recovery[layer] }), ...(evidence ? { evidence } : {}) };
}

export async function activeReceiptDrift(
  receipt: InstallReceiptV2,
  platform: NodeJS.Platform,
): Promise<string[]> {
  const failures: string[] = [];
  for (const file of receipt.files) {
    const entry = await lstat(file.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!entry?.isFile()) {
      failures.push(file.path);
      continue;
    }
    const bytes = await readOptionalBytes(file.path);
    const mode = await modeOptional(file.path, bytes);
    if (
      bytes === null
      || sha256(bytes) !== file.installedSha256
      || (file.installedMode !== undefined && mode !== undefined && file.installedMode !== mode)
    ) failures.push(file.path);
  }
  for (const config of receipt.configs) {
    const source = await readFile(config.path, "utf8").catch(() => null);
    if (source === null) {
      failures.push(config.path);
      continue;
    }
    if (config.kind === "json_property") {
      try {
        const parsed = JSON.parse(source) as { mcpServers?: { agenttab?: unknown } };
        if (!sameJson(parsed.mcpServers?.agenttab, config.installedValue)) failures.push(`${config.path}#mcpServers.agenttab`);
      } catch {
        failures.push(config.path);
      }
    } else {
      const document = parseDocument(source);
      const extensions = document.get("extensions", true);
      const values = isSeq(extensions) ? extensions.items.map((item) => String(item)) : [];
      if (values.includes(config.value) !== config.installedPresent) failures.push(`${config.path}#extensions:${config.value}`);
    }
  }
  if (platform === "win32") {
    for (const entry of receipt.registry) {
      if (!sameRegistryValue(queryRegistryValue(entry.key), { existed: true, value: entry.installedValue })) {
        failures.push(entry.key);
      }
    }
  }
  return failures;
}

async function installationCheck(receipt: InstallReceiptV2, platform: NodeJS.Platform): Promise<DoctorCheck> {
  const failures = await activeReceiptDrift(receipt, platform);
  const recoveryGuarantee = platform === "win32"
    ? {
        scope: "process_crash",
        limitation: "Node does not expose a Windows directory durability barrier; sudden power-loss namespace atomicity is not claimed",
      }
    : { scope: "filesystem_barriers_requested" };
  return failures.length === 0
    ? check(
        "installation",
        true,
        `receipt and ${receipt.files.length} installed files/config registrations match` +
          (platform === "win32" ? "; transaction recovery covers process crashes, not sudden power loss" : ""),
        { version: receipt.version, transactionRecovery: recoveryGuarantee },
      )
    : check("installation", false, `${failures.length} owned resource(s) no longer match the active receipt`, {
        resources: failures,
        transactionRecovery: recoveryGuarantee,
      });
}

async function connectWithRetry(
  connect: typeof AgentTabClient.connect,
  deadline: number,
  endpoint: string,
): Promise<AgentTabClient> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connect({ endpoint, connectTimeoutMs: 500, requestTimeoutMs: 10_000 });
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw lastError instanceof Error ? lastError : new Error("AgentTab did not become ready");
}

export async function doctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const { stateDir, platform } = currentPaths(options);
  const selected = options.layer ?? "all";
  const wants = (layer: DoctorLayer): boolean => selected === "all" || selected === layer;
  const checks: DoctorCheck[] = [];
  let active: Awaited<ReturnType<typeof loadActiveReceipt>>;
  try {
    active = await loadActiveReceipt(stateDir);
    if (!active) throw new Error("no active AgentTab receipt");
    if (wants("installation")) checks.push(await installationCheck(active.receipt, platform));
  } catch (error) {
    if (wants("installation") || selected === "all") {
      checks.push(check("installation", false, error instanceof Error ? error.message : String(error)));
    }
    return { success: false, checks };
  }
  if (selected === "installation") return { success: checks.every((entry) => entry.success), version: active.receipt.version, checks };

  const connect = options.connect ?? AgentTabClient.connect.bind(AgentTabClient);
  const endpoint = resolveEndpoint({ ...process.env, AGENTTAB_STATE_DIR: stateDir });
  const runtimeLayers = (["ipc", "protocol", "host"] as const).filter(wants);
  let runtimeClient: AgentTabClient | undefined;
  if (runtimeLayers.length > 0) {
    try {
      runtimeClient = options.waitForReady
        ? await connectWithRetry(connect, Date.now() + (options.extensionDeadlineMs ?? 20_000), endpoint)
        : await connect({ endpoint, connectTimeoutMs: 500, requestTimeoutMs: 10_000 });
      if (wants("ipc")) checks.push(check("ipc", true, "connected to the per-user AgentTab host endpoint"));
      let status: Record<string, unknown> | undefined;
      if (wants("protocol") || wants("host")) {
        const deadline = Date.now() + (options.extensionDeadlineMs ?? 20_000);
        do {
          status = await runtimeClient.call<"agenttab.status", Record<string, unknown>>("agenttab.status", {});
          if (!options.waitForReady || status.state === "ready" || Date.now() >= deadline) break;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        } while (true);
      }
      if (wants("protocol")) {
        const success = runtimeClient.connection.protocol === RPC_PROTOCOL
          && runtimeClient.connection.version === RPC_VERSION
          && status?.protocol_version === RPC_VERSION;
        checks.push(check("protocol", success, success
          ? `client, connection, and host agree on ${RPC_PROTOCOL} v${RPC_VERSION}`
          : "client, connection, and host protocol versions do not agree", {
            connectionProtocol: runtimeClient.connection.protocol,
            connectionVersion: runtimeClient.connection.version,
            hostVersion: status?.protocol_version,
          }));
      }
      if (wants("host")) {
        const exact = status?.host_version === active.receipt.version && status.state === "ready";
        checks.push(check("host", exact, exact
          ? `host ${active.receipt.version} is ready and matches the active receipt`
          : `running host ${String(status?.host_version ?? "unknown")} does not match active receipt ${active.receipt.version}`, {
            lifecycle: status?.state,
            runningVersion: status?.host_version,
            installedVersion: active.receipt.version,
          }));
      }
    } catch (error) {
      for (const layer of runtimeLayers) {
        if (layer === "ipc" && runtimeClient) continue;
        checks.push(check(layer, false, error instanceof Error ? error.message : String(error)));
      }
    } finally {
      runtimeClient?.close();
    }
  }

  if (wants("extension")) {
    let client: AgentTabClient | undefined;
    try {
      const deadline = Date.now() + (options.extensionDeadlineMs ?? 20_000);
      client = await connect({ endpoint, connectTimeoutMs: 500, requestTimeoutMs: 10_000 });
      const extensionStatus = await client.call<"agenttab.status", Record<string, unknown>>("agenttab.status", {});
      if (extensionStatus.extension_version !== active.receipt.extensionVersion) {
        throw new Error(
          `connected extension ${String(extensionStatus.extension_version ?? "unknown")} does not match active receipt ${active.receipt.extensionVersion}`,
        );
      }
      let opened: Record<string, unknown> | undefined;
      while (!opened && Date.now() < deadline) {
        try {
          opened = await client.call<"browser_open", Record<string, unknown>>(
            "browser_open",
            { mode: "create", url: "about:blank", background: true },
          );
        } catch (error) {
          if (!(error instanceof AgentTabError && error.code === "runtime_not_ready" && error.outcome === "not_started")) throw error;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        }
      }
      if (!opened || !Number.isInteger(Number(opened.tab_id)) || !Number.isInteger(Number(opened.page_revision))) {
        throw new Error("extension did not return a disposable task tab and page revision");
      }
      checks.push(check("extension", true, "extension created a disposable background task tab", {
        extensionVersion: extensionStatus.extension_version,
        tabId: opened.tab_id,
        pageRevision: opened.page_revision,
      }));
    } catch (error) {
      checks.push(check("extension", false, error instanceof Error ? error.message : String(error)));
    } finally {
      // The first task capability is deliberately left unconfirmed. Host disconnect
      // semantics close that exact disposable task/tab without a broad browser sweep.
      client?.close();
    }
  }
  return { success: checks.length > 0 && checks.every((entry) => entry.success), version: active.receipt.version, checks };
}

export async function verifyRuntimeReadiness(options: DoctorOptions & { version: string }): Promise<void> {
  const result = await doctor({ ...options, layer: "all", waitForReady: true });
  const failed = result.checks.find((entry) => !entry.success);
  if (!result.success || failed || result.version !== options.version) {
    const layer = failed?.layer ?? "host";
    const message = failed?.detail ?? `active version ${String(result.version)} does not match ${options.version}`;
    const error = new Error(`${layer}: ${message}`) as Error & { layer?: string; recovery?: string };
    error.layer = layer;
    error.recovery = failed?.recovery;
    throw error;
  }
}

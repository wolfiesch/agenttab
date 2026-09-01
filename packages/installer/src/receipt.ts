import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import identityJson from "../../../config/identity.json" with { type: "json" };
import type { ConfigOwnership } from "./configs";
import type { DaemonServiceManager } from "./service";
import type { FileExpectation, PlannedFile } from "./transaction";

const nativeHost = (identityJson as { nativeHost: string }).nativeHost;

export interface MissingSnapshot {
  exists: false;
}

export interface ExistingSnapshot {
  exists: true;
  sha256: string;
  contentBase64: string;
  mode?: number;
}

export type FileSnapshot = MissingSnapshot | ExistingSnapshot;

export interface FileOwnership {
  path: string;
  role: "artifact" | "activation";
  installedSha256: string;
  installedMode?: number;
  previous: FileSnapshot;
  owned: boolean;
}

export type RegistrySnapshot =
  | { existed: false; value: null }
  | { existed: true; value: string };

export interface RegistryOwnership {
  key: string;
  installedValue: string;
  previous: RegistrySnapshot;
  owned: boolean;
}

export interface ActiveReceiptReference {
  version: string;
  receiptPath: string;
  receiptSha256: string;
}

export interface InstallReceiptV2 {
  schemaVersion: 2;
  activationId: string;
  activatedAt: string;
  version: string;
  target: string;
  platform: NodeJS.Platform;
  stateDir: string;
  home: string;
  manifestSha256: string;
  assetSha256: string;
  hostSha256: string;
  shimSha256: string;
  cliSha256: string;
  ompSha256: string;
  extensionSha256: string;
  extensionVersion: string;
  daemonService: {
    manager: DaemonServiceManager;
    managed: boolean;
  };
  previousActive: FileSnapshot;
  previousReceipt: ActiveReceiptReference | null;
  files: FileOwnership[];
  configs: ConfigOwnership[];
  registry: RegistryOwnership[];
}

export interface ActiveInstallState extends ActiveReceiptReference {
  schemaVersion: 1;
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readOptionalBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function snapshotFile(path: string): Promise<FileSnapshot> {
  const bytes = await readOptionalBytes(path);
  if (bytes === null) return { exists: false };
  return snapshotForBytes(
    bytes,
    process.platform === "win32" ? undefined : (await stat(path)).mode & 0o777,
  );
}

export function snapshotForBytes(bytes: Buffer, mode?: number): ExistingSnapshot {
  return {
    exists: true,
    sha256: sha256(bytes),
    contentBase64: bytes.toString("base64"),
    ...(mode === undefined ? {} : { mode }),
  };
}

export function expectationFromSnapshot(snapshot: FileSnapshot): FileExpectation {
  return snapshot.exists
    ? { exists: true, sha256: snapshot.sha256, ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode }) }
    : { exists: false };
}

export function snapshotBytes(snapshot: FileSnapshot): Buffer | null {
  return snapshot.exists ? Buffer.from(snapshot.contentBase64, "base64") : null;
}

export function plannedBytes(file: PlannedFile): Buffer {
  return Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
}

export async function ownershipForFile(
  file: PlannedFile,
  role: FileOwnership["role"],
): Promise<FileOwnership> {
  const bytes = plannedBytes(file);
  const previous = await snapshotFile(file.path);
  const observed = expectationFromSnapshot(previous);
  if (file.expectedBefore) {
    const matches = file.expectedBefore.exists === observed.exists
      && (!file.expectedBefore.exists || (observed.exists
        && file.expectedBefore.sha256 === observed.sha256
        && (file.expectedBefore.mode === undefined
          || observed.mode === undefined
          || file.expectedBefore.mode === observed.mode)));
    if (!matches) throw new Error(`AgentTab file changed before its ownership snapshot: ${file.path}`);
  } else {
    file.expectedBefore = observed;
  }
  const contentMatches = previous.exists && previous.sha256 === sha256(bytes);
  const modeMatches = file.mode === undefined || !previous.exists || previous.mode === undefined || previous.mode === file.mode;
  return {
    path: file.path,
    role,
    installedSha256: sha256(bytes),
    ...(file.mode === undefined ? {} : { installedMode: file.mode }),
    previous,
    owned: !contentMatches || !modeMatches,
  };
}

export function activeStatePath(stateDir: string): string {
  return join(stateDir, "active-install.json");
}

export function receiptDirectory(stateDir: string): string {
  return join(stateDir, "receipts");
}

export function newReceiptPath(stateDir: string, version: string): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
  return join(receiptDirectory(stateDir), `${timestamp}-${randomUUID()}-v${version}.json`);
}

export function pathInside(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(relation));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validReference(value: unknown, stateDir: string): value is ActiveReceiptReference {
  return isRecord(value)
    && typeof value.version === "string"
    && typeof value.receiptPath === "string"
    && pathInside(receiptDirectory(stateDir), value.receiptPath)
    && typeof value.receiptSha256 === "string"
    && /^[0-9a-f]{64}$/.test(value.receiptSha256);
}

function validSnapshot(value: unknown): value is FileSnapshot {
  if (!isRecord(value) || typeof value.exists !== "boolean") return false;
  if (!value.exists) return Object.keys(value).every((key) => key === "exists");
  if (
    typeof value.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.sha256)
    || typeof value.contentBase64 !== "string"
    || (value.mode !== undefined && (!Number.isSafeInteger(value.mode) || Number(value.mode) < 0 || Number(value.mode) > 0o777))
  ) return false;
  const bytes = Buffer.from(value.contentBase64, "base64");
  return bytes.toString("base64") === value.contentBase64 && sha256(bytes) === value.sha256;
}

function validConfig(value: unknown, _home: string): boolean {
  if (
    !isRecord(value)
    || typeof value.path !== "string"
    || !isAbsolute(value.path)
    || typeof value.owned !== "boolean"
    || typeof value.client !== "string"
  ) return false;
  if (value.kind === "json_property") {
    return Array.isArray(value.property)
      && value.property.length === 2
      && value.property[0] === "mcpServers"
      && value.property[1] === "agenttab"
      && Object.prototype.hasOwnProperty.call(value, "installedValue")
      && isRecord(value.previous)
      && (value.previous.exists === false
        ? !Object.prototype.hasOwnProperty.call(value.previous, "value")
        : value.previous.exists === true && Object.prototype.hasOwnProperty.call(value.previous, "value"));
  }
  return value.kind === "yaml_sequence_item"
    && value.client === "OMP"
    && value.property === "extensions"
    && typeof value.value === "string"
    && typeof value.installedPresent === "boolean"
    && typeof value.previousPresent === "boolean";
}

function validRegistry(value: unknown): boolean {
  const allowed = [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${nativeHost}`,
    `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${nativeHost}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${nativeHost}`,
  ];
  return isRecord(value)
    && typeof value.key === "string"
    && allowed.includes(value.key)
    && typeof value.installedValue === "string"
    && typeof value.owned === "boolean"
    && isRecord(value.previous)
    && (value.previous.existed === false
      ? value.previous.value === null
      : value.previous.existed === true && typeof value.previous.value === "string");
}

function parseActiveState(bytes: Buffer, stateDir: string): ActiveInstallState {
  const path = activeStatePath(stateDir);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`AgentTab active-install state is malformed: ${path}`);
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !validReference(value, stateDir)) {
    throw new Error(`AgentTab active-install state is invalid: ${path}`);
  }
  return value as unknown as ActiveInstallState;
}

export async function readActiveState(stateDir: string): Promise<ActiveInstallState | null> {
  const bytes = await readOptionalBytes(activeStatePath(stateDir));
  return bytes === null ? null : parseActiveState(bytes, stateDir);
}

export async function readReceipt(
  reference: ActiveReceiptReference,
  stateDir: string,
): Promise<{ receipt: InstallReceiptV2; bytes: Buffer }> {
  if (!pathInside(receiptDirectory(stateDir), reference.receiptPath)) {
    throw new Error("AgentTab receipt reference escapes the receipt directory");
  }
  const bytes = await readFile(reference.receiptPath);
  if (sha256(bytes) !== reference.receiptSha256) {
    throw new Error(`AgentTab receipt hash mismatch: ${reference.receiptPath}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`AgentTab receipt is malformed: ${reference.receiptPath}`);
  }
  if (
    !isRecord(value)
    || value.schemaVersion !== 2
    || typeof value.activationId !== "string"
    || value.activationId.length === 0
    || typeof value.activatedAt !== "string"
    || Number.isNaN(Date.parse(value.activatedAt))
    || new Date(value.activatedAt).toISOString() !== value.activatedAt
    || value.version !== reference.version
    || typeof value.target !== "string"
    || !["darwin", "linux", "win32"].includes(String(value.platform))
    || value.stateDir !== stateDir
    || typeof value.home !== "string"
    || !isAbsolute(value.home)
    || typeof value.extensionVersion !== "string"
    || value.extensionVersion.length === 0
    || !isRecord(value.daemonService)
    || !["launchd", "systemd", "scheduled_task"].includes(String(value.daemonService.manager))
    || typeof value.daemonService.managed !== "boolean"
    || (value.platform === "darwin" && value.daemonService.manager !== "launchd")
    || (value.platform === "linux" && value.daemonService.manager !== "systemd")
    || (value.platform === "win32" && value.daemonService.manager !== "scheduled_task")
    || [
      value.manifestSha256,
      value.assetSha256,
      value.hostSha256,
      value.shimSha256,
      value.cliSha256,
      value.ompSha256,
      value.extensionSha256,
    ].some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
    || typeof value.previousActive !== "object"
    || !validSnapshot(value.previousActive)
    || (value.previousReceipt !== null && !validReference(value.previousReceipt, stateDir))
    || !Array.isArray(value.files)
    || !Array.isArray(value.configs)
    || !Array.isArray(value.registry)
  ) {
    throw new Error(`AgentTab receipt has an invalid schema or identity: ${reference.receiptPath}`);
  }
  for (const file of value.files) {
    if (
      !isRecord(file)
      || typeof file.path !== "string"
      || (file.role !== "artifact" && file.role !== "activation")
      || (file.role === "artifact"
        ? !pathInside(stateDir, file.path)
        : !pathInside(stateDir, file.path) && !pathInside(value.home as string, file.path))
      || typeof file.installedSha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(file.installedSha256)
      || (file.installedMode !== undefined
        && (!Number.isSafeInteger(file.installedMode) || Number(file.installedMode) < 0 || Number(file.installedMode) > 0o777))
      || typeof file.owned !== "boolean"
      || !validSnapshot(file.previous)
    ) {
      throw new Error(`AgentTab receipt contains an invalid file path: ${reference.receiptPath}`);
    }
  }
  if (!value.configs.every((entry) => validConfig(entry, value.home as string))) {
    throw new Error(`AgentTab receipt contains invalid client configuration ownership: ${reference.receiptPath}`);
  }
  if (!value.registry.every(validRegistry)) {
    throw new Error(`AgentTab receipt contains invalid registry ownership: ${reference.receiptPath}`);
  }
  return { receipt: value as unknown as InstallReceiptV2, bytes };
}

export async function loadActiveReceipt(
  stateDir: string,
): Promise<{
  state: ActiveInstallState;
  stateBytes: Buffer;
  stateSnapshot: FileSnapshot;
  receiptSnapshot: FileSnapshot;
  receipt: InstallReceiptV2;
  bytes: Buffer;
} | null> {
  const path = activeStatePath(stateDir);
  const stateBytes = await readOptionalBytes(path);
  if (stateBytes === null) return null;
  const state = parseActiveState(stateBytes, stateDir);
  const stateMode = process.platform === "win32" ? undefined : (await stat(path)).mode & 0o777;
  const loaded = await readReceipt(state, stateDir);
  const receiptMode = process.platform === "win32" ? undefined : (await stat(state.receiptPath)).mode & 0o777;
  return {
    state,
    stateBytes,
    stateSnapshot: snapshotForBytes(stateBytes, stateMode),
    receiptSnapshot: snapshotForBytes(loaded.bytes, receiptMode),
    ...loaded,
  };
}

export function referenceForReceipt(
  version: string,
  receiptPath: string,
  receiptBytes: Buffer,
): ActiveReceiptReference {
  return { version, receiptPath, receiptSha256: sha256(receiptBytes) };
}

export function receiptParentDirectory(receiptPath: string): string {
  return dirname(receiptPath);
}

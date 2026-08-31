import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  link,
  lstat,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { canonicalPathThroughExistingAncestor, canonicalStateDirectoryPath } from "./state-lock";

export interface MissingFileExpectation {
  exists: false;
}

export interface ExistingFileExpectation {
  exists: true;
  sha256: string;
  mode?: number;
}

export type FileExpectation = MissingFileExpectation | ExistingFileExpectation;

export interface PlannedFile {
  operation?: "write";
  path: string;
  content: Buffer | string;
  mode?: number;
  label: string;
  semanticDiff?: string;
  expectedBefore?: FileExpectation;
  /** Active-state pointers are restored even when another resource must be preserved. */
  statePointer?: boolean;
}

export interface PlannedDeletion {
  operation: "delete";
  path: string;
  label: string;
  semanticDiff?: string;
  expectedBefore?: FileExpectation;
  statePointer?: boolean;
}

export type PlannedChange = PlannedFile | PlannedDeletion;

export interface TransactionResult {
  changed: string[];
  unchanged: string[];
  backups: string[];
}

export interface DurableExternalChange {
  kind: string;
  resource: string;
  before: unknown;
  after: unknown;
}

export interface ExternalRecoveryHandler {
  inspect(change: DurableExternalChange): Promise<"before" | "after" | "conflict">;
  restore(change: DurableExternalChange): Promise<void>;
}

interface PreparedChange {
  operation: "write" | "delete";
  path: string;
  label: string;
  semanticDiff?: string;
  mode?: number;
  bytes: Buffer | null;
  original: Buffer | null;
  originalMode?: number;
  beforeIdentity?: string;
  before: FileExpectation;
  after: FileExpectation;
  stagedPath?: string;
  backupPath?: string;
  backupPreexisting?: boolean;
  quarantinePath?: string;
  rollbackPath: string;
  statePointer?: boolean;
  /** Runtime-only causal state; never inferred from bytes that a user may reproduce. */
  mutationState?: "untouched" | "displaced" | "installed";
}

interface JournalFile {
  operation: "write" | "delete";
  path: string;
  before: FileExpectation;
  after: FileExpectation;
  backupPath?: string;
  backupPreexisting?: boolean;
  stagedPath?: string;
  quarantinePath?: string;
  rollbackPath: string;
  statePointer?: boolean;
}

interface TransactionJournal {
  schemaVersion: 1;
  transactionId: string;
  operation: string;
  stateDir: string;
  createdAt: string;
  files: JournalFile[];
  external: DurableExternalChange[];
}

class InjectedCrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InjectedCrashError";
  }
}

class CommitPublicationUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommitPublicationUncertainError";
  }
}

class IntentPublicationUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IntentPublicationUncertainError";
  }
}

interface InspectedFile {
  bytes: Buffer | null;
  mode?: number;
  identity?: string;
  expectation: FileExpectation;
}

export class TransactionConflictError extends Error {
  readonly resources: string[];
  readonly recoveryIncomplete: boolean;

  constructor(message: string, resources: string[], recoveryIncomplete = false) {
    super(`${message}: ${resources.join(", ")}`);
    this.name = "TransactionConflictError";
    this.resources = resources;
    this.recoveryIncomplete = recoveryIncomplete;
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function expectationFor(bytes: Buffer | null, mode?: number): FileExpectation {
  return bytes === null
    ? { exists: false }
    : { exists: true, sha256: digest(bytes), ...(mode === undefined ? {} : { mode }) };
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function inspectFile(path: string): Promise<InspectedFile> {
  let pathStats;
  try {
    pathStats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { bytes: null, expectation: { exists: false } };
    }
    throw error;
  }
  if (!pathStats.isFile()) {
    throw new TransactionConflictError(
      "AgentTab preserved a non-regular file that cannot be represented by an install receipt",
      [path],
    );
  }
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { bytes: null, expectation: { exists: false } };
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (opened.dev !== pathStats.dev || opened.ino !== pathStats.ino || !opened.isFile()) {
      throw new TransactionConflictError("AgentTab preserved a file replaced during inspection", [path]);
    }
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (afterRead.dev !== opened.dev || afterRead.ino !== opened.ino || !afterRead.isFile()) {
      throw new TransactionConflictError("AgentTab preserved a file replaced during inspection", [path]);
    }
    const mode = process.platform === "win32" ? undefined : afterRead.mode & 0o777;
    return {
      bytes,
      mode,
      identity: `${afterRead.dev}:${afterRead.ino}`,
      expectation: expectationFor(bytes, mode),
    };
  } finally {
    await handle.close();
  }
}

function sameExpectation(left: FileExpectation, right: FileExpectation): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return left.sha256 === right.sha256
    && (left.mode === undefined || right.mode === undefined || left.mode === right.mode);
}

function sameFileIdentity(left: InspectedFile, right: InspectedFile | null): boolean {
  return left.identity !== undefined && left.identity === right?.identity;
}

async function durableWrite(path: string, bytes: Buffer, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== "win32"
      || !["EACCES", "EBADF", "EISDIR", "EINVAL", "ENOSYS", "ENOTSUP", "EPERM"].includes(code ?? "")
    ) throw error;
  }
}

function backupPath(path: string, original: Buffer): string {
  return `${path}.agenttab-backup-${digest(original).slice(0, 12)}`;
}

export function transactionJournalPath(stateDir: string): string {
  return join(canonicalStateDirectoryPath(stateDir), "transaction-intent.json");
}

export async function pendingTransactionExists(stateDir: string): Promise<boolean> {
  return (await readOptional(transactionJournalPath(stateDir))) !== null;
}

function transactionCommitPath(stateDir: string): string {
  return `${transactionJournalPath(stateDir)}.committed`;
}

async function ensureBackup(file: PreparedChange): Promise<boolean> {
  if (file.original === null || !file.backupPath) return false;
  const existing = await readOptional(file.backupPath);
  if (existing !== null) {
    if (!existing.equals(file.original)) {
      throw new Error(`AgentTab transaction backup does not match its expected content: ${file.backupPath}`);
    }
    return false;
  }
  const staged = `${file.backupPath}.stage-${randomUUID()}`;
  await durableWrite(staged, file.original, file.originalMode ?? 0o600);
  try {
    await link(staged, file.backupPath);
    await syncDirectory(dirname(file.backupPath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await readOptional(file.backupPath);
    if (raced === null || !raced.equals(file.original)) {
      throw new Error(`AgentTab transaction backup does not match its expected content: ${file.backupPath}`);
    }
    return false;
  } finally {
    await removeIfPresent(staged);
  }
}

async function preflightHardLinkSupport(
  files: PreparedChange[],
  options: { fail?: boolean; crashAfterProbe?: boolean } = {},
): Promise<void> {
  for (const file of files) {
    const source = file.operation === "write" ? file.stagedPath : file.backupPath;
    if (!source) {
      throw new Error(`AgentTab cannot preflight transaction publication for ${file.path}`);
    }
    if (options.fail) {
      throw new Error(`AgentTab target filesystem does not support required same-directory hard links: ${dirname(file.path)}`);
    }
    try {
      await link(source, file.rollbackPath);
    } catch (error) {
      throw new Error(
        `AgentTab target filesystem does not support required same-directory hard links: ${dirname(file.path)}`,
        { cause: error },
      );
    }
    if (options.crashAfterProbe) {
      throw new InjectedCrashError("Injected transaction crash after hard-link preflight publication");
    }
    const [sourceEntry, probeEntry] = await Promise.all([
      inspectFile(source),
      inspectFile(file.rollbackPath),
    ]);
    if (!sameFileIdentity(sourceEntry, probeEntry)) {
      throw new Error(`AgentTab hard-link preflight did not preserve file identity: ${file.path}`);
    }
    await removeIfPresent(file.rollbackPath);
    await syncDirectory(dirname(file.path));
  }
}

async function removeIfPresent(path: string): Promise<void> {
  await rm(path, { force: true });
}

async function cleanupSidecars(
  files: Array<{ stagedPath?: string; quarantinePath?: string; rollbackPath?: string }>,
): Promise<void> {
  const targetDirectories = new Set<string>();
  for (const file of files) {
    for (const path of [file.stagedPath, file.quarantinePath, file.rollbackPath]) {
      if (!path) continue;
      await removeIfPresent(path);
      targetDirectories.add(dirname(path));
    }
  }
  for (const directory of targetDirectories) await syncDirectory(directory);
}

async function cleanupJournal(
  stateDir: string,
  files: Array<{ stagedPath?: string; quarantinePath?: string; rollbackPath?: string }>,
  transactionId?: string,
  afterIntentRemoval?: () => Promise<void>,
): Promise<void> {
  await cleanupSidecars(files);

  if (transactionId) {
    await removeIfPresent(`${transactionJournalPath(stateDir)}.publishing`);
    await removeIfPresent(`${transactionCommitPath(stateDir)}.publishing`);
    await syncDirectory(resolve(stateDir));
  }

  // These are separate durability boundaries. If cleanup stops between them,
  // intent-absent/marker-present still means committed; journal-present/marker-
  // absent is never published for a committed transaction.
  await removeIfPresent(transactionJournalPath(stateDir));
  await syncDirectory(resolve(stateDir));
  await afterIntentRemoval?.();
  await removeIfPresent(transactionCommitPath(stateDir));
  try {
    await syncDirectory(resolve(stateDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function cleanupUncommittedJournal(journal: TransactionJournal): Promise<void> {
  const conflicts: string[] = [];
  const backupDirectories = new Set<string>();
  for (const file of journal.files) {
    if (!file.backupPath || file.backupPreexisting !== false) continue;
    try {
      const current = await inspectFile(file.backupPath);
      if (!current.expectation.exists) continue;
      if (!sameExpectation(current.expectation, file.before)) {
        conflicts.push(file.backupPath);
        continue;
      }
      await removeIfPresent(file.backupPath);
      backupDirectories.add(dirname(file.backupPath));
    } catch {
      conflicts.push(file.backupPath);
    }
  }
  for (const directory of backupDirectories) await syncDirectory(directory);
  if (conflicts.length > 0) {
    throw new TransactionConflictError(
      "AgentTab preserved transaction backups changed during uncommitted cleanup",
      conflicts,
      true,
    );
  }
  await cleanupJournal(journal.stateDir, journal.files, journal.transactionId);
}

function journalBytes(journal: TransactionJournal): Buffer {
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
}

async function writeIntent(journal: TransactionJournal, afterPublish?: () => Promise<void>): Promise<void> {
  const path = transactionJournalPath(journal.stateDir);
  if (await readOptional(path)) throw new Error(`AgentTab has an unrecovered transaction intent: ${path}`);
  if (await readOptional(transactionCommitPath(journal.stateDir))) {
    throw new Error(`AgentTab has an unrecovered transaction commit marker: ${transactionCommitPath(journal.stateDir)}`);
  }
  const staged = `${path}.publishing`;
  await removeIfPresent(staged);
  await syncDirectory(dirname(path));
  await durableWrite(staged, journalBytes(journal), 0o600);
  let published = false;
  try {
    await link(staged, path);
    published = true;
    await afterPublish?.();
    await syncDirectory(dirname(path));
  } catch (error) {
    if (!published && (error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`AgentTab has an unrecovered transaction intent: ${path}`);
    }
    if (published) {
      try {
        await removeIfPresent(path);
        await syncDirectory(dirname(path));
      } catch (cleanupError) {
        throw new IntentPublicationUncertainError(
          `AgentTab could not determine whether its transaction intent is durable: ${path}`,
          { cause: cleanupError },
        );
      }
    }
    throw error;
  } finally {
    await removeIfPresent(staged);
  }
}

async function markCommitted(journal: TransactionJournal, afterPublish?: () => Promise<void>): Promise<void> {
  const path = transactionCommitPath(journal.stateDir);
  const staged = `${path}.publishing`;
  await removeIfPresent(staged);
  await durableWrite(staged, Buffer.from(`${journal.transactionId}\n`, "utf8"), 0o600);
  let published = false;
  try {
    await link(staged, path);
    published = true;
    await afterPublish?.();
    await syncDirectory(dirname(path));
  } catch (error) {
    if (!published && (error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CommitPublicationUncertainError(`AgentTab transaction has an unexpected commit marker: ${path}`, { cause: error });
    }
    if (published) {
      try {
        await removeIfPresent(path);
        await syncDirectory(dirname(path));
      } catch (cleanupError) {
        throw new CommitPublicationUncertainError(
          `AgentTab could not determine whether its commit marker is durable: ${path}`,
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
}

export function transactionPathIdentity(path: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = platform === "win32" ? win32.resolve(path) : resolve(path);
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function validSidecarPath(
  candidate: unknown,
  target: string,
  marker: "stage" | "displaced" | "rollback",
  platform: NodeJS.Platform = process.platform,
): candidate is string {
  if (typeof candidate !== "string") return false;
  const paths = platform === "win32" ? win32 : { basename, dirname, isAbsolute };
  if (!paths.isAbsolute(candidate)) return false;
  if (transactionPathIdentity(paths.dirname(candidate), platform) !== transactionPathIdentity(paths.dirname(target), platform)) {
    return false;
  }
  const candidateName = paths.basename(candidate);
  const expectedPrefix = `${paths.basename(target)}.agenttab-${marker}-`;
  const comparableName = platform === "win32" ? candidateName.toLocaleLowerCase("en-US") : candidateName;
  const comparablePrefix = platform === "win32" ? expectedPrefix.toLocaleLowerCase("en-US") : expectedPrefix;
  return comparableName.startsWith(comparablePrefix)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidateName.slice(expectedPrefix.length),
    );
}

function validExpectation(value: unknown): value is FileExpectation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (entry.exists === false) return Object.keys(entry).every((key) => key === "exists");
  return entry.exists === true
    && typeof entry.sha256 === "string"
    && /^[0-9a-f]{64}$/.test(entry.sha256)
    && (entry.mode === undefined || (Number.isSafeInteger(entry.mode) && Number(entry.mode) >= 0 && Number(entry.mode) <= 0o777));
}

function parseJournal(bytes: Buffer, stateDir: string): TransactionJournal {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`AgentTab transaction intent is malformed: ${transactionJournalPath(stateDir)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`AgentTab transaction intent is invalid: ${transactionJournalPath(stateDir)}`);
  }
  const journal = value as Partial<TransactionJournal>;
  if (
    journal.schemaVersion !== 1
    || typeof journal.transactionId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(journal.transactionId)
    || typeof journal.operation !== "string"
    || typeof journal.stateDir !== "string"
    || !isAbsolute(journal.stateDir)
    || transactionPathIdentity(journal.stateDir) !== transactionPathIdentity(stateDir)
    || !Array.isArray(journal.files)
    || !Array.isArray(journal.external)
  ) throw new Error(`AgentTab transaction intent is invalid: ${transactionJournalPath(stateDir)}`);
  const paths = new Set<string>();
  for (const file of journal.files) {
    const pathIdentity = typeof file?.path === "string" ? transactionPathIdentity(file.path) : "";
    if (
      typeof file !== "object"
      || file === null
      || Array.isArray(file)
      || (file.operation !== "write" && file.operation !== "delete")
      || typeof file.path !== "string"
      || !isAbsolute(file.path)
      || paths.has(pathIdentity)
      || !validExpectation(file.before)
      || !validExpectation(file.after)
      || (file.statePointer !== undefined && typeof file.statePointer !== "boolean")
      || (file.before.exists
        ? typeof file.backupPath !== "string"
          || transactionPathIdentity(file.backupPath) !== transactionPathIdentity(`${file.path}.agenttab-backup-${file.before.sha256.slice(0, 12)}`)
          || typeof file.backupPreexisting !== "boolean"
        : file.backupPath !== undefined || file.backupPreexisting !== undefined)
      || (file.operation === "write"
        ? !validSidecarPath(file.stagedPath, file.path, "stage")
        : file.stagedPath !== undefined)
      || (file.before.exists
        ? !validSidecarPath(file.quarantinePath, file.path, "displaced")
        : file.quarantinePath !== undefined)
      || !validSidecarPath(file.rollbackPath, file.path, "rollback")
    ) throw new Error(`AgentTab transaction intent contains an invalid file entry: ${transactionJournalPath(stateDir)}`);
    paths.add(pathIdentity);
  }
  for (const external of journal.external) {
    if (
      typeof external !== "object"
      || external === null
      || Array.isArray(external)
      || typeof external.kind !== "string"
      || typeof external.resource !== "string"
      || !("before" in external)
      || !("after" in external)
    ) throw new Error(`AgentTab transaction intent contains an invalid external entry: ${transactionJournalPath(stateDir)}`);
  }
  return journal as TransactionJournal;
}

async function restoreFile(
  file: Pick<PreparedChange, "operation" | "path" | "before" | "after" | "original" | "originalMode" | "backupPath" | "stagedPath" | "quarantinePath" | "rollbackPath">,
  afterRollbackRename?: () => Promise<void>,
): Promise<void> {
  const current = await inspectFile(file.path);
  if (sameExpectation(current.expectation, file.before)) return;
  const staged = file.stagedPath ? await inspectFile(file.stagedPath) : null;
  const installedIdentityMatches = (entry: InspectedFile): boolean => file.operation === "delete"
    ? !entry.expectation.exists
    : staged !== null
      && sameExpectation(staged.expectation, file.after)
      && sameFileIdentity(entry, staged);
  const original = file.before.exists
    ? file.original ?? (file.backupPath ? await readOptional(file.backupPath) : null)
    : null;
  if (file.before.exists && (original === null || digest(original) !== file.before.sha256)) {
    throw new TransactionConflictError("AgentTab cannot recover a missing or changed transaction backup", [file.backupPath ?? file.path], true);
  }

  const publishOriginal = async (): Promise<void> => {
    if (!file.before.exists) return;
    let source: string | undefined;
    if (file.quarantinePath && sameExpectation((await inspectFile(file.quarantinePath)).expectation, file.before)) {
      source = file.quarantinePath;
    }
    if (!source && file.backupPath && sameExpectation((await inspectFile(file.backupPath)).expectation, file.before)) {
      source = file.backupPath;
    }
    if (!source) {
      throw new TransactionConflictError("AgentTab cannot recover a missing or changed transaction backup", [file.backupPath ?? file.path], true);
    }
    try {
      await link(source, file.path);
      await syncDirectory(dirname(file.path));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new TransactionConflictError("AgentTab preserved a concurrent file created during transaction rollback", [file.path], true);
    }
  };

  const rollbackDisplaced = await inspectFile(file.rollbackPath);
  if (rollbackDisplaced.expectation.exists) {
    if (current.expectation.exists) {
      throw new TransactionConflictError("AgentTab preserved concurrent file states during transaction rollback", [file.path, file.rollbackPath], true);
    }
    if (!sameExpectation(rollbackDisplaced.expectation, file.after) || !installedIdentityMatches(rollbackDisplaced)) {
      try {
        await link(file.rollbackPath, file.path);
        await syncDirectory(dirname(file.path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new TransactionConflictError("AgentTab could not relink a displaced concurrent file", [file.path, file.rollbackPath], true);
        }
      }
      throw new TransactionConflictError("AgentTab preserved a file changed during transaction rollback", [file.path, file.rollbackPath], true);
    }
    await publishOriginal();
    await removeIfPresent(file.rollbackPath);
    await syncDirectory(dirname(file.path));
    return;
  }

  if (!current.expectation.exists && file.before.exists && file.quarantinePath) {
    const quarantined = await inspectFile(file.quarantinePath);
    if (quarantined.expectation.exists) {
      try {
        await link(file.quarantinePath, file.path);
        await syncDirectory(dirname(file.path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new TransactionConflictError("AgentTab could not relink a displaced file", [file.path, file.quarantinePath], true);
        }
      }
      if (!sameExpectation(quarantined.expectation, file.before)) {
        throw new TransactionConflictError("AgentTab preserved a file changed before transaction mutation", [file.path, file.quarantinePath], true);
      }
      return;
    }
  }
  if (!sameExpectation(current.expectation, file.after)) {
    throw new TransactionConflictError("AgentTab preserved a file changed during transaction rollback", [file.path], true);
  }
  if (file.operation === "write" && !installedIdentityMatches(current)) {
    throw new TransactionConflictError("AgentTab preserved a same-content file replaced during transaction rollback", [file.path], true);
  }
  if (!current.expectation.exists && !file.after.exists && file.before.exists) {
    await publishOriginal();
    return;
  }
  try {
    await rename(file.path, file.rollbackPath);
  } catch {
    throw new TransactionConflictError(
      "AgentTab preserved a file changed during transaction rollback",
      [file.path],
      true,
    );
  }
  await afterRollbackRename?.();
  let displaced: InspectedFile | null = null;
  try {
    displaced = await inspectFile(file.rollbackPath);
  } catch {
    // Keep a raced non-regular entry visible at its live name without
    // following it or overwriting a second concurrent entry.
  }
  if (!displaced || !sameExpectation(displaced.expectation, file.after) || !installedIdentityMatches(displaced)) {
    try {
      await link(file.rollbackPath, file.path);
      await syncDirectory(dirname(file.path));
    } catch {
      // Both names are retained when a concurrent writer occupied the target.
    }
    throw new TransactionConflictError("AgentTab preserved a file changed during transaction rollback", [file.path], true);
  }
  if (!file.before.exists) {
    await removeIfPresent(file.rollbackPath);
    await syncDirectory(dirname(file.path));
    return;
  }
  await publishOriginal();
  await removeIfPresent(file.rollbackPath);
  await syncDirectory(dirname(file.path));
}

async function applyPreparedChange(
  file: PreparedChange,
  mutationState: (state: NonNullable<PreparedChange["mutationState"]>) => void,
  afterRename?: () => Promise<void>,
  afterQuarantine?: () => Promise<void>,
): Promise<void> {
  if (!file.before.exists) {
    if (file.operation === "delete") return;
    try {
      await link(file.stagedPath!, file.path);
      mutationState("installed");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new TransactionConflictError("AgentTab preserved a file created immediately before mutation", [file.path], true);
    }
  }

  try {
    await rename(file.path, file.quarantinePath!);
    mutationState("displaced");
  } catch {
    throw new TransactionConflictError("AgentTab preserved a file changed immediately before mutation", [file.path], true);
  }
  await afterRename?.();
  let displaced: InspectedFile | null = null;
  try {
    displaced = await inspectFile(file.quarantinePath!);
  } catch {
    // A raced symlink or other unsupported entry must be put back without
    // following or rewriting it.
  }
  if (
    !displaced
    || !sameExpectation(displaced.expectation, file.before)
    || (file.beforeIdentity !== undefined && displaced.identity !== file.beforeIdentity)
  ) {
    try {
      await link(file.quarantinePath!, file.path);
      await removeIfPresent(file.quarantinePath!);
      await syncDirectory(dirname(file.path));
      mutationState("untouched");
    } catch {
      // Retain the displaced value if a concurrent writer occupied the target.
    }
    throw new TransactionConflictError("AgentTab preserved a file changed immediately before mutation", [file.path], true);
  }
  await afterQuarantine?.();
  if (file.operation === "delete") {
    mutationState("installed");
    return;
  }
  try {
    await link(file.stagedPath!, file.path);
    mutationState("installed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new TransactionConflictError("AgentTab preserved a file created during mutation", [file.path], true);
  }
}

async function preflightRollback(files: PreparedChange[]): Promise<void> {
  const conflicts: string[] = [];
  for (const file of files) {
    try {
      const current = await inspectFile(file.path);
      if (!sameExpectation(current.expectation, file.after)) conflicts.push(file.path);
    } catch (error) {
      conflicts.push(...(error instanceof TransactionConflictError ? error.resources : [file.path]));
    }
  }
  if (conflicts.length > 0) {
    throw new TransactionConflictError("AgentTab preserved files changed during transaction rollback", conflicts, true);
  }
}

async function restoreRecoverableFiles(
  files: PreparedChange[],
  afterRollbackRename?: () => Promise<void>,
): Promise<string[]> {
  const problems: string[] = [];
  const reversed = [...files].reverse();
  const ordered = [
    ...reversed.filter((file) => !file.statePointer),
    ...reversed.filter((file) => file.statePointer),
  ];
  for (const file of ordered) {
    try {
      const current = await inspectFile(file.path);
      if (sameExpectation(current.expectation, file.before)) continue;
      if (file.mutationState === "displaced") {
        const quarantined = file.quarantinePath ? await inspectFile(file.quarantinePath) : null;
        if (current.expectation.exists || !quarantined || !sameExpectation(quarantined.expectation, file.before)) {
          problems.push(file.path);
          continue;
        }
        await restoreFile(file, afterRollbackRename);
        continue;
      }
      if (!sameExpectation(current.expectation, file.after)) {
        const quarantined = file.quarantinePath ? await inspectFile(file.quarantinePath) : null;
        const displaced = !current.expectation.exists && quarantined?.expectation.exists;
        if (!displaced) {
          problems.push(file.path);
          continue;
        }
      }
      await restoreFile(file, afterRollbackRename);
    } catch (error) {
      if (error instanceof InjectedCrashError) throw error;
      if (error instanceof TransactionConflictError) problems.push(...error.resources);
      else problems.push(file.path);
    }
  }
  return problems;
}

export function renderDiff(label: string, before: Buffer | null, after: Buffer | null): string {
  const shortDigest = (value: Buffer | null): string => value ? digest(value).slice(0, 12) : "absent";
  return [
    `--- ${label} (sha256:${shortDigest(before)})`,
    `+++ ${label} (sha256:${shortDigest(after)})`,
  ].join("\n");
}

export async function recoverPendingTransaction(
  stateDir: string,
  handlers: Readonly<Record<string, ExternalRecoveryHandler>> = {},
): Promise<{ recovered: boolean; operation?: string }> {
  const resolvedStateDir = canonicalStateDirectoryPath(stateDir);
  const path = transactionJournalPath(resolvedStateDir);
  const bytes = await readOptional(path);
  if (bytes === null) {
    await removeIfPresent(transactionCommitPath(resolvedStateDir));
    await removeIfPresent(`${transactionJournalPath(resolvedStateDir)}.publishing`);
    await removeIfPresent(`${transactionCommitPath(resolvedStateDir)}.publishing`);
    try {
      await syncDirectory(resolvedStateDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { recovered: false };
  }
  const journal = parseJournal(bytes, resolvedStateDir);
  const commit = await readOptional(transactionCommitPath(resolvedStateDir));
  if (commit?.toString("utf8").trim() === journal.transactionId) {
    // A marker observed after a process crash may have been linked immediately
    // before that crash. Make the observed commit boundary durable before
    // deleting any rollback evidence from target directories.
    await syncDirectory(resolvedStateDir);
    await cleanupJournal(resolvedStateDir, journal.files, journal.transactionId);
    return { recovered: false, operation: journal.operation };
  }
  if (commit !== null) {
    throw new TransactionConflictError(
      "AgentTab preserved a transaction with a mismatched commit marker",
      [transactionCommitPath(resolvedStateDir)],
      true,
    );
  }

  const fileStates = new Map<string, "before" | "after" | "displaced" | "rollback_displaced">();
  const externalStates = new Map<DurableExternalChange, "before" | "after">();
  const conflicts: string[] = [];
  for (const file of journal.files) {
    let current: InspectedFile;
    let quarantined: InspectedFile | null;
    let rollbackDisplaced: InspectedFile;
    let staged: InspectedFile | null;
    try {
      [current, quarantined, rollbackDisplaced, staged] = await Promise.all([
        inspectFile(file.path),
        file.quarantinePath ? inspectFile(file.quarantinePath) : Promise.resolve(null),
        inspectFile(file.rollbackPath),
        file.stagedPath ? inspectFile(file.stagedPath) : Promise.resolve(null),
      ]);
    } catch (error) {
      // A non-regular entry is never followed or rewritten. If the live name
      // vanished, try to relink one journaled displaced directory entry so it
      // is visible to the user, then retain the journal and report the paths.
      try {
        const live = await lstat(file.path).catch((entryError: NodeJS.ErrnoException) => {
          if (entryError.code === "ENOENT") return null;
          throw entryError;
        });
        if (!live) {
          for (const source of [file.rollbackPath, file.quarantinePath]) {
            if (!source) continue;
            try {
              await link(source, file.path);
              await syncDirectory(dirname(file.path));
              break;
            } catch (linkError) {
              const code = (linkError as NodeJS.ErrnoException).code;
              if (code !== "ENOENT" && code !== "EEXIST") conflicts.push(source);
            }
          }
        }
      } catch {
        // The durable journal retains every exact path for manual repair.
      }
      conflicts.push(
        ...(error instanceof TransactionConflictError ? error.resources : [file.path]),
        ...(file.quarantinePath ? [file.quarantinePath] : []),
        file.rollbackPath,
      );
      continue;
    }
    const relinkUnexpected = async (source: string): Promise<void> => {
      if (current.expectation.exists) return;
      try {
        await link(source, file.path);
        await syncDirectory(dirname(file.path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") conflicts.push(source);
      }
    };
    if (quarantined?.expectation.exists && !sameExpectation(quarantined.expectation, file.before)) {
      await relinkUnexpected(file.quarantinePath!);
      conflicts.push(file.path, file.quarantinePath!);
      continue;
    }
    const rollbackIsPreflightProbe = rollbackDisplaced.expectation.exists
      && sameExpectation(rollbackDisplaced.expectation, file.operation === "write" ? file.after : file.before)
      && sameExpectation(current.expectation, file.before);
    if (
      rollbackDisplaced.expectation.exists
      && !sameExpectation(rollbackDisplaced.expectation, file.after)
      && !rollbackIsPreflightProbe
    ) {
      await relinkUnexpected(file.rollbackPath);
      conflicts.push(file.path, file.rollbackPath);
      continue;
    }

    let state: "before" | "after" | "displaced" | "rollback_displaced" | null = null;
    if (sameExpectation(current.expectation, file.before)) {
      state = "before";
    } else if (rollbackDisplaced.expectation.exists) {
      const rollbackOwned = file.operation === "write"
        && staged !== null
        && sameExpectation(staged.expectation, file.after)
        && sameFileIdentity(rollbackDisplaced, staged);
      if (!current.expectation.exists && rollbackOwned) state = "rollback_displaced";
    } else if (file.operation === "write") {
      const currentOwned = staged !== null
        && sameExpectation(staged.expectation, file.after)
        && sameExpectation(current.expectation, file.after)
        && sameFileIdentity(current, staged);
      if (currentOwned) state = "after";
      else if (!current.expectation.exists && file.before.exists && quarantined && sameExpectation(quarantined.expectation, file.before)) {
        state = "displaced";
      }
    } else if (
      !current.expectation.exists
      && file.before.exists
      && quarantined
      && sameExpectation(quarantined.expectation, file.before)
    ) {
      state = "after";
    }

    if (state === null) {
      conflicts.push(file.path, ...(rollbackDisplaced.expectation.exists ? [file.rollbackPath] : []));
      continue;
    }
    fileStates.set(file.path, state);
    if (file.before.exists && state !== "before") {
      const quarantineValid = quarantined !== null && sameExpectation(quarantined.expectation, file.before);
      const backup = file.backupPath ? await inspectFile(file.backupPath).catch(() => null) : null;
      if (!quarantineValid && (!backup || !sameExpectation(backup.expectation, file.before))) {
        conflicts.push(file.backupPath ?? file.path);
      }
    }
  }
  for (const external of journal.external) {
    const handler = handlers[external.kind];
    if (!handler) {
      conflicts.push(external.resource);
      continue;
    }
    try {
      const state = await handler.inspect(external);
      if (state === "conflict") conflicts.push(external.resource);
      else externalStates.set(external, state);
    } catch (error) {
      conflicts.push(...(error instanceof TransactionConflictError ? error.resources : [external.resource]));
    }
  }

  // Restore every independently recoverable resource even if another one
  // conflicts. This keeps a registry failure or raced artifact from preventing
  // an active-state pointer restoration attempt.
  for (const external of [...journal.external].reverse()) {
    if (externalStates.get(external) !== "after") continue;
    try {
      await handlers[external.kind].restore(external);
    } catch (error) {
      conflicts.push(...(error instanceof TransactionConflictError ? error.resources : [external.resource]));
    }
  }
  const recoverable = journal.files.filter((file) =>
    fileStates.get(file.path) === "after"
    || fileStates.get(file.path) === "displaced"
    || fileStates.get(file.path) === "rollback_displaced"
  );
  const ordered = [
    ...[...recoverable].reverse().filter((file) => !file.statePointer),
    ...[...recoverable].reverse().filter((file) => file.statePointer),
  ];
  for (const file of ordered) {
    try {
      await restoreFile({
        operation: file.operation,
        path: file.path,
        before: file.before,
        after: file.after,
        original: null,
        ...(file.before.exists ? { originalMode: file.before.mode } : {}),
        backupPath: file.backupPath,
        stagedPath: file.stagedPath,
        quarantinePath: file.quarantinePath,
        rollbackPath: file.rollbackPath,
      });
    } catch (error) {
      conflicts.push(...(error instanceof TransactionConflictError ? error.resources : [file.path]));
    }
  }
  if (conflicts.length > 0) {
    throw new TransactionConflictError(
      `AgentTab preserved resources changed while recovering interrupted ${journal.operation}`,
      [...new Set(conflicts)],
      true,
    );
  }
  await cleanupUncommittedJournal(journal);
  return { recovered: true, operation: journal.operation };
}

export async function applyTransaction(
  files: PlannedChange[],
  options: {
    dryRun?: boolean;
    printDiff?: (diff: string) => void;
    failAfter?: number;
    crashAfter?: number;
    crashAfterQuarantineRename?: boolean;
    crashAfterQuarantine?: boolean;
    crashAfterRollbackRename?: boolean;
    crashAfterExternal?: boolean;
    /** Fault injection for proving unsupported target filesystems fail before mutation. */
    failHardLinkPreflight?: boolean;
    /** Fault injection for recovery of the journaled hard-link probe name. */
    crashAfterHardLinkProbe?: boolean;
    /** Test hook used to exercise a write occurring in the final pre-mutation window. */
    beforeMutation?: (path: string) => Promise<void>;
    /** Test hook immediately after intent publication but before its durability barrier. */
    afterIntentPublish?: () => Promise<void>;
    /** Test hook immediately after commit-marker publication but before its durability barrier. */
    afterCommitPublish?: () => Promise<void>;
    /** Test hook for validating that commit publication is a one-way boundary. */
    afterCommit?: () => Promise<void>;
    /** Test hook between durable intent cleanup and commit-marker cleanup. */
    afterIntentCleanup?: () => Promise<void>;
    afterApply?: () => Promise<void>;
    applyExternal?: () => Promise<() => Promise<void>>;
    journal?: { stateDir: string; operation: string; external?: DurableExternalChange[] };
  } = {},
): Promise<TransactionResult> {
  const prepared: PreparedChange[] = [];
  const unchanged: string[] = [];
  const seenPaths = new Set<string>();

  for (const file of files) {
    if (!isAbsolute(file.path)) throw new Error(`AgentTab transaction path must be absolute: ${file.path}`);
    const pathIdentity = transactionPathIdentity(file.path);
    if (seenPaths.has(pathIdentity)) throw new Error(`AgentTab transaction contains duplicate path: ${file.path}`);
    seenPaths.add(pathIdentity);
    const current = await inspectFile(file.path);
    if (file.expectedBefore && !sameExpectation(current.expectation, file.expectedBefore)) {
      throw new TransactionConflictError("AgentTab preserved a file changed before transaction preparation", [file.path]);
    }
    if (file.operation === "delete") {
      if (current.bytes === null) {
        unchanged.push(file.path);
        continue;
      }
      options.printDiff?.(file.semanticDiff ?? renderDiff(file.label, current.bytes, null));
      prepared.push({
        ...file,
        operation: "delete",
        bytes: null,
        original: current.bytes,
        originalMode: current.mode,
        before: current.expectation,
        after: { exists: false },
        backupPath: backupPath(file.path, current.bytes),
        quarantinePath: `${file.path}.agenttab-displaced-${randomUUID()}`,
        rollbackPath: `${file.path}.agenttab-rollback-${randomUUID()}`,
      });
      continue;
    }
    const bytes = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
    const targetMode = file.mode ?? current.mode ?? 0o600;
    const after = expectationFor(bytes, process.platform === "win32" ? undefined : targetMode);
    if (current.bytes?.equals(bytes) && sameExpectation(current.expectation, after)) {
      unchanged.push(file.path);
      continue;
    }
    options.printDiff?.(file.semanticDiff ?? renderDiff(file.label, current.bytes, bytes));
    prepared.push({
      ...file,
      operation: "write",
      bytes,
      original: current.bytes,
      originalMode: current.mode,
      before: current.expectation,
      after,
      stagedPath: `${file.path}.agenttab-stage-${randomUUID()}`,
      ...(current.bytes ? { backupPath: backupPath(file.path, current.bytes) } : {}),
      ...(current.bytes ? { quarantinePath: `${file.path}.agenttab-displaced-${randomUUID()}` } : {}),
      rollbackPath: `${file.path}.agenttab-rollback-${randomUUID()}`,
    });
  }

  const external = options.journal?.external ?? [];
  const changedResources = [
    ...prepared.map((file) => file.path),
    ...external.map((entry) => entry.resource),
  ];
  if (options.dryRun) {
    return { changed: changedResources, unchanged, backups: [] };
  }
  if ((external.length > 0) !== (options.applyExternal !== undefined)) {
    throw new Error("AgentTab transaction external changes and apply handler must be provided together");
  }
  if (prepared.length === 0 && external.length === 0) {
    await options.afterApply?.();
    return { changed: [], unchanged, backups: [] };
  }

  for (const file of prepared) {
    if (!file.backupPath) continue;
    const existingBackup = await inspectFile(file.backupPath);
    if (existingBackup.expectation.exists && !sameExpectation(existingBackup.expectation, file.before)) {
      throw new TransactionConflictError("AgentTab preserved a changed transaction backup", [file.backupPath]);
    }
    file.backupPreexisting = existingBackup.expectation.exists;
  }

  let journal: TransactionJournal | undefined;
  if (options.journal) {
    journal = {
      schemaVersion: 1,
      transactionId: randomUUID(),
      operation: options.journal.operation,
      stateDir: canonicalStateDirectoryPath(options.journal.stateDir),
      createdAt: new Date().toISOString(),
      files: prepared.map((file) => ({
        operation: file.operation,
        path: file.path,
        before: file.before,
        after: file.after,
        ...(file.backupPath ? { backupPath: file.backupPath } : {}),
        ...(file.backupPath ? { backupPreexisting: file.backupPreexisting ?? false } : {}),
        ...(file.stagedPath ? { stagedPath: file.stagedPath } : {}),
        ...(file.quarantinePath ? { quarantinePath: file.quarantinePath } : {}),
        rollbackPath: file.rollbackPath,
        ...(file.statePointer ? { statePointer: true } : {}),
      })),
      external,
    };
    await writeIntent(journal, options.afterIntentPublish);
  }

  const backups: string[] = [];
  try {
    for (const file of prepared) {
      if (file.operation === "write") {
        await durableWrite(file.stagedPath!, file.bytes!, file.mode ?? file.originalMode ?? 0o600);
      }
    }
    for (const file of prepared) {
      if (await ensureBackup(file)) backups.push(file.backupPath!);
    }
    await preflightHardLinkSupport(prepared, {
      fail: options.failHardLinkPreflight,
      crashAfterProbe: options.crashAfterHardLinkProbe,
    });
  } catch (error) {
    if (error instanceof InjectedCrashError || error instanceof IntentPublicationUncertainError) throw error;
    const cleanupProblems: string[] = [];
    try {
      if (journal) await cleanupUncommittedJournal(journal);
      else {
        for (const backup of backups) {
          const file = prepared.find((entry) => entry.backupPath === backup)!;
          const current = await inspectFile(backup);
          if (sameExpectation(current.expectation, file.before)) await removeIfPresent(backup);
          else cleanupProblems.push(backup);
        }
        await cleanupSidecars(prepared);
      }
    } catch (cleanupError) {
      cleanupProblems.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
    if (cleanupProblems.length > 0) {
      throw new TransactionConflictError(
        `AgentTab transaction setup failed and cleanup is incomplete (${error instanceof Error ? error.message : String(error)})`,
        cleanupProblems,
        true,
      );
    }
    throw error;
  }

  const applied: PreparedChange[] = [];
  let undoExternal: (() => Promise<void>) | undefined;
  let committed = false;
  try {
    for (const file of prepared) {
      if (file.statePointer) await preflightRollback(applied);
      const immediatelyBefore = await inspectFile(file.path);
      if (!sameExpectation(immediatelyBefore.expectation, file.before)) {
        throw new TransactionConflictError("AgentTab preserved a file changed immediately before mutation", [file.path]);
      }
      file.beforeIdentity = immediatelyBefore.identity;
      await options.beforeMutation?.(file.path);
      file.mutationState = "untouched";
      try {
        await applyPreparedChange(
          file,
          (state) => { file.mutationState = state; },
          options.crashAfterQuarantineRename
            ? async () => { throw new InjectedCrashError("Injected transaction crash after quarantine rename"); }
            : undefined,
          options.crashAfterQuarantine
            ? async () => { throw new InjectedCrashError("Injected transaction crash after quarantine"); }
            : undefined,
        );
      } catch (error) {
        if (error instanceof InjectedCrashError) throw error;
        if (file.mutationState !== "untouched") applied.push(file);
        if (error instanceof TransactionConflictError) throw error;
        throw new TransactionConflictError(
          `AgentTab file mutation failed with recovery pending (${error instanceof Error ? error.message : String(error)})`,
          [file.path],
          true,
        );
      }
      applied.push(file);
      await syncDirectory(dirname(file.path));
      if (options.crashAfter !== undefined && applied.length === options.crashAfter) {
        throw new InjectedCrashError(`Injected transaction crash after ${applied.length} files`);
      }
      if (options.failAfter !== undefined && applied.length === options.failAfter) {
        throw new Error(`Injected transaction failure after ${applied.length} files`);
      }
    }
    await preflightRollback(applied);
    undoExternal = await options.applyExternal?.();
    if (options.crashAfterExternal) throw new InjectedCrashError("Injected transaction crash after external changes");
    await options.afterApply?.();
    await preflightRollback(applied);
    if (journal) {
      await markCommitted(journal, options.afterCommitPublish);
      committed = true;
      await options.afterCommit?.();
      await cleanupJournal(journal.stateDir, journal.files, journal.transactionId, options.afterIntentCleanup);
    } else {
      await cleanupSidecars(prepared);
    }
  } catch (error) {
    if (error instanceof InjectedCrashError) throw error;
    if (error instanceof CommitPublicationUncertainError) {
      throw new Error(
        `AgentTab transaction commit outcome is pending durable recovery: ${error.message}`,
      );
    }
    if (committed) {
      throw new Error(
        `AgentTab transaction committed but durable cleanup is pending: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const recoveryProblems: string[] = error instanceof TransactionConflictError && error.recoveryIncomplete
      ? [...error.resources]
      : [];
    let externalIncomplete = undoExternal === undefined
      && external.length > 0
      && (error as { recoveryIncomplete?: unknown }).recoveryIncomplete === true;
    try {
      await preflightRollback(applied);
    } catch (rollbackError) {
      if (rollbackError instanceof TransactionConflictError) recoveryProblems.push(...rollbackError.resources);
      else recoveryProblems.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
    }
    if (!externalIncomplete && undoExternal) {
      try {
        await undoExternal();
      } catch (undoError) {
        externalIncomplete = true;
        if (undoError instanceof TransactionConflictError) recoveryProblems.push(...undoError.resources);
        else recoveryProblems.push(`external rollback: ${undoError instanceof Error ? undoError.message : String(undoError)}`);
      }
    }
    recoveryProblems.push(...await restoreRecoverableFiles(
      applied,
      options.crashAfterRollbackRename
        ? async () => { throw new InjectedCrashError("Injected transaction crash after rollback rename"); }
        : undefined,
    ));
    if (!externalIncomplete && recoveryProblems.length === 0) {
      if (journal) await cleanupUncommittedJournal(journal);
      else await cleanupSidecars(prepared);
      throw error;
    }
    throw new TransactionConflictError(
      `AgentTab transaction failed and preserved concurrent changes (${error instanceof Error ? error.message : String(error)})`,
      [...new Set(recoveryProblems.length > 0 ? recoveryProblems : external.map((entry) => entry.resource))],
      true,
    );
  }

  return { changed: changedResources, unchanged, backups };
}

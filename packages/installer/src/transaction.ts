import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname } from "node:path";

export interface PlannedFile {
  path: string;
  content: Buffer | string;
  mode?: number;
  label: string;
  semanticDiff?: string;
}

export interface TransactionResult {
  changed: string[];
  unchanged: string[];
  backups: string[];
}

interface PreparedFile extends PlannedFile {
  bytes: Buffer;
  original: Buffer | null;
  originalMode?: number;
  stagedPath: string;
  backupPath?: string;
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function durableWrite(path: string, bytes: Buffer, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
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
    if (process.platform !== "win32") throw error;
  }
}

function backupPath(path: string, original: Buffer): string {
  return `${path}.agenttab-backup-${createHash("sha256").update(original).digest("hex").slice(0, 12)}`;
}

export function renderDiff(label: string, before: Buffer | null, after: Buffer): string {
  const digest = (value: Buffer | null): string =>
    value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : "absent";
  return [
    `--- ${label} (sha256:${digest(before)})`,
    `+++ ${label} (sha256:${digest(after)})`,
  ].join("\n");
}

export async function applyTransaction(
  files: PlannedFile[],
  options: {
    dryRun?: boolean;
    printDiff?: (diff: string) => void;
    failAfter?: number;
    afterApply?: () => Promise<void>;
  } = {},
): Promise<TransactionResult> {
  const prepared: PreparedFile[] = [];
  const unchanged: string[] = [];

  for (const file of files) {
    const bytes = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
    const original = await readOptional(file.path);
    const originalMode = original && process.platform !== "win32"
      ? (await stat(file.path)).mode & 0o777
      : undefined;
    const modeMatches = file.mode === undefined || originalMode === undefined || originalMode === file.mode;
    if (original?.equals(bytes) && modeMatches) {
      unchanged.push(file.path);
      continue;
    }
    options.printDiff?.(file.semanticDiff ?? renderDiff(file.label, original, bytes));
    prepared.push({
      ...file,
      bytes,
      original,
      originalMode,
      stagedPath: `${file.path}.agenttab-stage-${randomUUID()}`,
      ...(original ? { backupPath: backupPath(file.path, original) } : {}),
    });
  }

  if (options.dryRun) {
    return { changed: [], unchanged, backups: [] };
  }
  if (prepared.length === 0) {
    await options.afterApply?.();
    return { changed: [], unchanged, backups: [] };
  }

  for (const file of prepared) {
    await durableWrite(file.stagedPath, file.bytes, file.mode ?? file.originalMode ?? 0o600);
  }

  const applied: PreparedFile[] = [];
  const backups: string[] = [];
  try {
    for (const file of prepared) {
      if (file.original && file.backupPath && !(await readOptional(file.backupPath))) {
        await copyFile(file.path, file.backupPath);
        await chmod(file.backupPath, file.originalMode ?? 0o600);
        backups.push(file.backupPath);
      }
      await rename(file.stagedPath, file.path);
      applied.push(file);
      await syncDirectory(dirname(file.path));
      if (options.failAfter !== undefined && applied.length === options.failAfter) {
        throw new Error(`Injected transaction failure after ${applied.length} files`);
      }
    }
    await options.afterApply?.();
  } catch (error) {
    for (const file of applied.reverse()) {
      if (file.original === null) {
        await rm(file.path, { force: true });
      } else {
        const restore = `${file.path}.agenttab-restore-${randomUUID()}`;
        await durableWrite(restore, file.original, file.originalMode ?? 0o600);
        await rename(restore, file.path);
        await syncDirectory(dirname(file.path));
      }
    }
    for (const file of prepared) await rm(file.stagedPath, { force: true });
    throw error;
  }

  return { changed: prepared.map((file) => file.path), unchanged, backups };
}

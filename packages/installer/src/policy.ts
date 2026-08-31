import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { parse, resolve } from "node:path";

const POLICY_KEYS = new Set([
  "developer_enabled",
  "audit_enabled",
  "denied_origins",
  "allowed_origins",
  "dlp_allowed_roots",
  "dlp_max_file_bytes",
  "redact_patterns",
]);

const POLICY_WRITE_LOCK = ".policy-write.lock";
const POLICY_LOCK_TIMEOUT_MS = 10_000;
const POLICY_LOCK_RETRY_MS = 20;

interface UploadPolicyResultBase {
  policyFile: string;
  allowedRoot: string;
}

export type UploadPolicyResult = UploadPolicyResultBase & (
  | { added: true; restartRequired: true }
  | { added: false; restartRequired: false }
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function acquirePolicyWriteLock(stateRoot: string): Promise<string> {
  const lockDirectory = resolve(stateRoot, POLICY_WRITE_LOCK);
  const deadline = Date.now() + POLICY_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      // Creating one fixed directory is atomic across processes on every
      // supported platform. The critical section is deliberately tiny and the
      // empty directory is removed in finally, so no advisory-lock dependency
      // or platform-specific file-lock API is required by this one-shot CLI.
      await mkdir(lockDirectory, { mode: 0o700 });
      return lockDirectory;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for another AgentTab policy update at ${lockDirectory}. ` +
          `If no agenttab policy command is running, remove that stale lock directory and retry.`,
        );
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, POLICY_LOCK_RETRY_MS));
    }
  }
}

function validatePolicy(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("AgentTab policy must contain one JSON object");
  const unknown = Object.keys(value).filter((key) => !POLICY_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`AgentTab policy contains unknown field ${unknown[0]}`);
  for (const key of ["developer_enabled", "audit_enabled"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`AgentTab policy ${key} must be a boolean`);
    }
  }
  for (const key of ["denied_origins", "allowed_origins", "dlp_allowed_roots", "redact_patterns"] as const) {
    if (
      value[key] !== undefined &&
      (!Array.isArray(value[key]) || !(value[key] as unknown[]).every((entry) => typeof entry === "string"))
    ) {
      throw new Error(`AgentTab policy ${key} must be an array of strings`);
    }
  }
  if (
    value.dlp_max_file_bytes !== undefined &&
    (!Number.isSafeInteger(value.dlp_max_file_bytes) || Number(value.dlp_max_file_bytes) <= 0)
  ) {
    throw new Error("AgentTab policy dlp_max_file_bytes must be a positive safe integer");
  }
  return value;
}

export function hostStateRoot(configured?: string): string {
  if (configured) return resolve(configured);
  if (process.env.AGENTTAB_STATE_DIR) return resolve(process.env.AGENTTAB_STATE_DIR);
  if (platform() === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) throw new Error("LOCALAPPDATA is required to locate AgentTab policy");
    return resolve(localAppData, "AgentTab");
  }
  return resolve(homedir(), ".agenttab");
}

async function prepareStateRoot(configured?: string): Promise<string> {
  const stateRoot = hostStateRoot(configured);
  if (stateRoot === parse(stateRoot).root) {
    throw new Error("AgentTab state directory must be narrower than a filesystem root");
  }
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const metadata = await lstat(stateRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("AgentTab state directory must be a real directory");
  }
  if (
    typeof process.getuid === "function" &&
    typeof metadata.uid === "number" &&
    metadata.uid !== process.getuid()
  ) {
    throw new Error("AgentTab state directory must be owned by the current user");
  }
  if (platform() !== "win32") await chmod(stateRoot, 0o700);
  return stateRoot;
}

export async function allowUploadRoot(
  requestedRoot: string,
  options: { stateDir?: string } = {},
): Promise<UploadPolicyResult> {
  if (requestedRoot.trim() === "") throw new Error("Upload root must not be empty");
  const allowedRoot = await realpath(resolve(requestedRoot));
  const metadata = await stat(allowedRoot);
  if (!metadata.isDirectory()) throw new Error("Upload root must be an existing directory");
  if (allowedRoot === parse(allowedRoot).root) {
    throw new Error("Upload root must be narrower than a filesystem root");
  }
  if (typeof process.getuid === "function" && typeof metadata.uid === "number" && metadata.uid !== process.getuid()) {
    throw new Error("Upload root must be owned by the current user");
  }

  const stateRoot = await prepareStateRoot(options.stateDir);
  const policyFile = resolve(stateRoot, "policy.json");
  const lockDirectory = await acquirePolicyWriteLock(stateRoot);
  try {
    let policy: Record<string, unknown> = {};
    try {
      policy = validatePolicy(JSON.parse(await readFile(policyFile, "utf8")));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const roots = Array.isArray(policy.dlp_allowed_roots)
      ? [...policy.dlp_allowed_roots] as string[]
      : [];
    const added = !roots.includes(allowedRoot);
    if (!added) {
      await chmod(policyFile, 0o600);
      return {
        policyFile,
        allowedRoot,
        added: false,
        restartRequired: false,
      };
    }
    roots.push(allowedRoot);
    policy.dlp_allowed_roots = roots;

    const temporary = `${policyFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(policy, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, policyFile);
      await chmod(policyFile, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return {
      policyFile,
      allowedRoot,
      added: true,
      restartRequired: true,
    };
  } finally {
    await rmdir(lockDirectory);
  }
}

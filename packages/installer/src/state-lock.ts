import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { basename, dirname, resolve } from "node:path";

interface LockClaim {
  token: string;
  pid: number;
  osPid?: number;
  endpoint: string | null;
  processIdentity: string | null;
  operation: string;
  acquiredAt: string;
  choosing: boolean;
  ticket?: number;
}

const HEARTBEAT_INTERVAL_MS = 1_000;
const HEARTBEAT_GRACE_MS = 5_000;

export interface InstallerStateLock {
  path: string;
  release(): Promise<void>;
}

export function canonicalPathThroughExistingAncestor(path: string): string {
  const resolved = resolve(path);
  const missing: string[] = [];
  let cursor = resolved;
  while (true) {
    try {
      const canonicalAncestor = realpathSync.native(cursor);
      return resolve(canonicalAncestor, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolved;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function canonicalStateDirectoryPath(stateDir: string): string {
  return canonicalPathThroughExistingAncestor(stateDir);
}

export function stateDirectoryLockPath(stateDir: string): string {
  return `${canonicalStateDirectoryPath(stateDir)}.installer-lock`;
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not supported by every platform/filesystem.
  }
}

async function writeClaim(path: string, claim: LockClaim): Promise<void> {
  const staged = `${path}.stage-${randomUUID()}`;
  const handle = await open(staged, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(claim)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(staged, path);
  await syncDirectory(dirname(path));
}

function lockEndpoint(stateDir: string, token: string): string {
  const stateHash = createHash("sha256").update(stateDirectoryLockPath(stateDir)).digest("hex").slice(0, 20);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\agenttab-installer-${stateHash}-${token}`
    : `/tmp/agenttab-installer-${stateHash}-${token}.sock`;
}

async function listenForLiveness(endpoint: string): Promise<Server | null> {
  const server = createServer((socket) => socket.end());
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.off("error", reject);
        resolveListen();
      });
    });
    return server;
  } catch {
    // Some sandboxed runtimes prohibit even local IPC. The OS birth-token
    // fallback below still provides crash/PID-reuse-safe ownership checks.
    return null;
  }
}

async function endpointIsLive(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const socket = createConnection(endpoint);
    let settled = false;
    const finish = (live: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(live);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code !== "ENOENT" && error.code !== "ECONNREFUSED");
    });
    socket.setTimeout(500, () => finish(true));
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function processIdentity(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const [bootId, stat] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readFile(`/proc/${pid}/stat`, "utf8"),
      ]);
      const fieldsAfterName = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fieldsAfterName[19] ? `linux:${bootId.trim()}:${fieldsAfterName[19]}` : null;
    }
    if (!processExists(pid)) return null;
    if (process.platform === "darwin") {
      const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      }).trim();
      return started ? `darwin:${started}` : null;
    }
    if (process.platform === "win32") {
      const started = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ], { encoding: "utf8", windowsHide: true }).trim();
      return started ? `win32:${started}` : null;
    }
  } catch {
    // If no OS birth identity is available, conservatively keep a live PID.
  }
  return null;
}

async function operatingSystemPid(): Promise<number> {
  if (process.platform !== "linux") return process.pid;
  try {
    const stat = await readFile("/proc/self/stat", "utf8");
    const pid = Number(stat.slice(0, stat.indexOf(" ")));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : process.pid;
  } catch {
    return process.pid;
  }
}

async function heartbeatIsFresh(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs <= HEARTBEAT_GRACE_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // An unreadable owner claim is not safe to steal while its PID exists.
    return true;
  }
}

async function claimIsLive(path: string, claim: LockClaim): Promise<boolean> {
  if (!Number.isInteger(claim.pid) || claim.pid <= 0) return false;
  if (claim.endpoint && await endpointIsLive(claim.endpoint)) return true;
  const identityPid = claim.osPid ?? claim.pid;
  if (!claim.processIdentity) {
    return processExists(claim.pid) && await heartbeatIsFresh(path);
  }
  const current = await processIdentity(identityPid);
  if (current !== null) return current === claim.processIdentity;
  // Identity probing can fail transiently. A live PID plus a fresh owner
  // heartbeat receives a bounded grace period, never an indefinite PID-only
  // lease that could survive PID reuse.
  return processExists(claim.pid) && await heartbeatIsFresh(path);
}

async function readLiveClaims(directory: string): Promise<Array<{ path: string; claim: LockClaim }>> {
  const names = await readdir(directory);
  const claims: Array<{ path: string; claim: LockClaim }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = `${directory}/${name}`;
    let claim: LockClaim;
    try {
      claim = JSON.parse(await readFile(path, "utf8")) as LockClaim;
      if (
        !claim ||
        typeof claim.token !== "string" ||
        (claim.osPid !== undefined && (!Number.isInteger(claim.osPid) || claim.osPid <= 0)) ||
        (claim.endpoint !== null && typeof claim.endpoint !== "string") ||
        (claim.processIdentity !== null && typeof claim.processIdentity !== "string") ||
        typeof claim.operation !== "string" ||
        typeof claim.choosing !== "boolean"
      ) {
        throw new Error("invalid lock claim");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`AgentTab installer lock claim is unreadable: ${path}`);
    }
    if (await claimIsLive(path, claim)) {
      claims.push({ path, claim });
    } else {
      // Claim names are unique and immutable to their owner, so removing a claim
      // proven dead cannot race with a replacement process.
      await rm(path, { force: true });
      if (claim.endpoint && process.platform !== "win32") await rm(claim.endpoint, { force: true });
    }
  }
  return claims;
}

function compareClaims(left: LockClaim, right: LockClaim): number {
  return (left.ticket ?? Number.MAX_SAFE_INTEGER) - (right.ticket ?? Number.MAX_SAFE_INTEGER) ||
    left.token.localeCompare(right.token);
}

export async function acquireInstallerStateLock(
  stateDir: string,
  operation: string,
): Promise<InstallerStateLock> {
  const directory = stateDirectoryLockPath(stateDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const proposedEndpoint = lockEndpoint(stateDir, token);
  const livenessServer = await listenForLiveness(proposedEndpoint);
  const endpoint = livenessServer ? proposedEndpoint : null;
  const osPid = await operatingSystemPid();
  const ownerIdentity = await processIdentity(osPid);
  if (!livenessServer && !ownerIdentity) {
    throw new Error("AgentTab cannot establish an OS-backed installer state lock in this runtime");
  }
  const claimPath = `${directory}/${token}.json`;
  const base: LockClaim = {
    token,
    pid: process.pid,
    osPid,
    endpoint,
    processIdentity: ownerIdentity,
    operation,
    acquiredAt: new Date().toISOString(),
    choosing: true,
  };
  try {
    await writeClaim(claimPath, base);
  } catch (error) {
    if (livenessServer) await new Promise<void>((resolveClose) => livenessServer.close(() => resolveClose()));
    if (endpoint && process.platform !== "win32") await rm(endpoint, { force: true });
    throw error;
  }

  let released = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const release = async (): Promise<void> => {
    if (released) return;
    await rm(claimPath, { force: true });
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    if (livenessServer) await new Promise<void>((resolveClose) => livenessServer.close(() => resolveClose()));
    if (endpoint && process.platform !== "win32") await rm(endpoint, { force: true });
    await syncDirectory(directory);
  };

  try {
    const initial = await readLiveClaims(directory);
    const maxTicket = initial.reduce(
      (maximum, entry) => Math.max(maximum, entry.claim.choosing ? 0 : (entry.claim.ticket ?? 0)),
      0,
    );
    const chosen: LockClaim = { ...base, choosing: false, ticket: maxTicket + 1 };
    await writeClaim(claimPath, chosen);
    heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(claimPath, now, now).catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    // Let contenders that published `choosing` finish selecting their ticket.
    const deadline = Date.now() + 1_000;
    let contenders = await readLiveClaims(directory);
    while (contenders.some((entry) => entry.claim.token !== token && entry.claim.choosing)) {
      if (Date.now() >= deadline) {
        throw new Error("Timed out while another AgentTab installer chose a state lock ticket");
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      contenders = await readLiveClaims(directory);
    }

    const winner = contenders
      .map((entry) => entry.claim)
      .filter((claim) => !claim.choosing)
      .sort(compareClaims)[0];
    if (!winner || winner.token !== token) {
      throw new Error(
        `AgentTab installer state is locked by ${winner?.operation ?? "another operation"}` +
          `${winner ? ` (pid ${winner.pid})` : ""}`,
      );
    }
    return { path: directory, release };
  } catch (error) {
    await release();
    throw error;
  }
}

export async function withStateDirectoryLock<T>(
  stateDir: string,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  const lock = await acquireInstallerStateLock(stateDir, operation);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}

export const withInstallerStateLock = withStateDirectoryLock;

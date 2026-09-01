import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireInstallerStateLock, stateDirectoryLockPath, withInstallerStateLock } from "../src/state-lock";
import {
  applyTransaction,
  expectationFor,
  recoverPendingTransaction,
  transactionJournalPath,
  transactionPathIdentity,
} from "../src/transaction";

const temporaryRoots: string[] = [];

interface SyncableFileHandle {
  sync(): Promise<void>;
  stat(): Promise<{ dev: number; ino: number; isDirectory(): boolean }>;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("file transaction", () => {
  test("restores a renamed destination when syncing its directory fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttab-transaction-test-"));
    temporaryRoots.push(root);
    const destination = join(root, "config.json");
    await writeFile(destination, "before");

    const rootStats = await stat(root);
    const handle = await open(destination, "r");
    const fileHandlePrototype = Object.getPrototypeOf(handle) as SyncableFileHandle;
    await handle.close();
    const originalSync = fileHandlePrototype.sync;
    let failNextRootDirectorySync = true;
    fileHandlePrototype.sync = async function(this: SyncableFileHandle): Promise<void> {
      const current = await this.stat();
      if (
        failNextRootDirectorySync
        && current.isDirectory()
        && current.dev === rootStats.dev
        && current.ino === rootStats.ino
      ) {
        failNextRootDirectorySync = false;
        throw new Error("Injected directory sync failure");
      }
      await originalSync.call(this);
    };

    try {
      await expect(applyTransaction([
        { path: destination, content: "after", label: "config" },
      ])).rejects.toThrow("Injected directory sync failure");
      expect(await readFile(destination, "utf8")).toBe("before");
    } finally {
      fileHandlePrototype.sync = originalSync;
    }
  });

  test("repairs mode drift when file content is unchanged", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "agenttab-transaction-mode-test-"));
    temporaryRoots.push(root);
    const destination = join(root, "config.json");
    await writeFile(destination, "unchanged");
    await chmod(destination, 0o644);

    const result = await applyTransaction([
      { path: destination, content: "unchanged", mode: 0o600, label: "config" },
    ]);

    expect(result.changed).toEqual([destination]);
    expect(result.unchanged).toEqual([]);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
  });

  test("restores an exact deletion when a later transactional change fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttab-transaction-delete-test-"));
    temporaryRoots.push(root);
    const removed = join(root, "removed.txt");
    const changed = join(root, "changed.txt");
    await writeFile(removed, "owned");
    await writeFile(changed, "before");

    await expect(applyTransaction([
      { operation: "delete", path: removed, label: "owned file" },
      { path: changed, content: "after", label: "changed file" },
    ], { failAfter: 2 })).rejects.toThrow("Injected transaction failure");

    expect(await readFile(removed, "utf8")).toBe("owned");
    expect(await readFile(changed, "utf8")).toBe("before");
  });

  test("reports dry-run changes without writing them", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttab-transaction-dry-run-test-"));
    temporaryRoots.push(root);
    const destination = join(root, "planned.txt");
    const result = await applyTransaction([
      { path: destination, content: "planned", label: "planned file", expectedBefore: { exists: false } },
    ], { dryRun: true });
    expect(result.changed).toEqual([destination]);
    expect(existsSync(destination)).toBe(false);
  });

  test("rejects stale plans and rechecks expected-before immediately before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttab-transaction-cas-test-"));
    temporaryRoots.push(root);
    const destination = join(root, "config.json");
    await writeFile(destination, "planned-before");
    const expectedBefore = expectationFor(Buffer.from("planned-before"));
    await writeFile(destination, "edit-before-transaction");
    await expect(applyTransaction([
      { path: destination, content: "installed", label: "config", expectedBefore },
    ])).rejects.toThrow("changed before transaction preparation");
    expect(await readFile(destination, "utf8")).toBe("edit-before-transaction");

    await writeFile(destination, "planned-before");
    await expect(applyTransaction([
      { path: destination, content: "installed", label: "config" },
    ], {
      printDiff: () => writeFileSync(destination, "edit-after-preparation"),
    })).rejects.toThrow("changed immediately before mutation");
    expect(await readFile(destination, "utf8")).toBe("edit-after-preparation");

    await writeFile(destination, "planned-before");
    await expect(applyTransaction([
      { path: destination, content: "installed", label: "config" },
    ], {
      journal: { stateDir: root, operation: "cas-race" },
      beforeMutation: async () => writeFile(destination, "edit-in-final-window"),
    })).rejects.toThrow("changed immediately before mutation");
    expect(await readFile(destination, "utf8")).toBe("edit-in-final-window");
    expect(existsSync(transactionJournalPath(root))).toBe(true);
  });

  test("never claims a concurrent same-content file after a no-clobber publication loses", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-equal-race-test-"));
    temporaryRoots.push(stateDir);
    const destination = join(stateDir, "new.txt");

    await expect(applyTransaction([
      { path: destination, content: "same-bytes", label: "new file", expectedBefore: { exists: false } },
    ], {
      journal: { stateDir, operation: "equal-race" },
      beforeMutation: async () => writeFile(destination, "same-bytes"),
    })).rejects.toThrow("preserved a file created immediately before mutation");

    expect(await readFile(destination, "utf8")).toBe("same-bytes");
    await expect(recoverPendingTransaction(stateDir)).rejects.toThrow("preserved resources changed");
    expect(await readFile(destination, "utf8")).toBe("same-bytes");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(true);
  });

  test("relinks a raced value after a crash immediately following quarantine rename", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-quarantine-race-test-"));
    temporaryRoots.push(stateDir);
    const destination = join(stateDir, "active.txt");
    await writeFile(destination, "expected-before");

    await expect(applyTransaction([
      { path: destination, content: "installed", label: "active file" },
    ], {
      journal: { stateDir, operation: "quarantine-race" },
      beforeMutation: async () => writeFile(destination, "concurrent-edit"),
      crashAfterQuarantineRename: true,
    })).rejects.toThrow("crash after quarantine rename");
    expect(existsSync(destination)).toBe(false);

    await expect(recoverPendingTransaction(stateDir)).rejects.toThrow("preserved resources changed");
    expect(await readFile(destination, "utf8")).toBe("concurrent-edit");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(true);
  });

  test("preserves concurrent edits instead of overwriting them during exception rollback", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-rollback-cas-test-"));
    temporaryRoots.push(stateDir);
    const destination = join(stateDir, "active.txt");
    await writeFile(destination, "before");
    await expect(applyTransaction([
      { path: destination, content: "installed", label: "active file" },
    ], {
      journal: { stateDir, operation: "test" },
      afterApply: async () => {
        await writeFile(destination, "concurrent-user-edit");
        throw new Error("readiness failed");
      },
    })).rejects.toThrow("preserved concurrent changes");
    expect(await readFile(destination, "utf8")).toBe("concurrent-user-edit");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(true);
    await expect(recoverPendingTransaction(stateDir)).rejects.toThrow("preserved resources changed");
    expect(await readFile(destination, "utf8")).toBe("concurrent-user-edit");
  });

  test("recovers an interrupted durable transaction idempotently", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-recovery-test-"));
    temporaryRoots.push(stateDir);
    const destination = join(stateDir, "active.txt");
    await writeFile(destination, "before");
    await expect(applyTransaction([
      { path: destination, content: "installed", label: "active file" },
    ], {
      journal: { stateDir, operation: "update" },
      crashAfter: 1,
    })).rejects.toThrow("Injected transaction crash");
    expect(await readFile(destination, "utf8")).toBe("installed");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(true);

    expect(await recoverPendingTransaction(stateDir)).toEqual({ recovered: true, operation: "update" });
    expect(await readFile(destination, "utf8")).toBe("before");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(false);
    expect(await recoverPendingTransaction(stateDir)).toEqual({ recovered: false });
  });

  test("recovers a crash after the atomic destination quarantine", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-quarantine-test-"));
    temporaryRoots.push(stateDir);
    const destination = join(stateDir, "active.txt");
    await writeFile(destination, "before");

    await expect(applyTransaction([
      { path: destination, content: "after", label: "active file" },
    ], {
      journal: { stateDir, operation: "update" },
      crashAfterQuarantine: true,
    })).rejects.toThrow("crash after quarantine");
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(transactionJournalPath(stateDir))).toBe(true);

    expect(await recoverPendingTransaction(stateDir)).toEqual({ recovered: true, operation: "update" });
    expect(await readFile(destination, "utf8")).toBe("before");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(false);
  });

  test("recovers a journaled crash after rollback displaced the installed live target", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-rollback-displacement-test-"));
    temporaryRoots.push(stateDir);
    const destination = join(stateDir, "active.txt");
    await writeFile(destination, "before");

    await expect(applyTransaction([
      { path: destination, content: "installed", label: "active file" },
    ], {
      journal: { stateDir, operation: "rollback-displacement" },
      failAfter: 1,
      crashAfterRollbackRename: true,
    })).rejects.toThrow("crash after rollback rename");
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(transactionJournalPath(stateDir))).toBe(true);

    expect(await recoverPendingTransaction(stateDir)).toEqual({ recovered: true, operation: "rollback-displacement" });
    expect(await readFile(destination, "utf8")).toBe("before");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(false);
  });

  test("fails hard-link preflight and cleans setup artifacts before target mutation", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-link-preflight-test-"));
    temporaryRoots.push(stateDir);
    const destination = join(stateDir, "active.txt");
    await writeFile(destination, "before");

    await expect(applyTransaction([
      { path: destination, content: "after", label: "active file" },
    ], {
      journal: { stateDir, operation: "unsupported-filesystem" },
      failHardLinkPreflight: true,
    })).rejects.toThrow("does not support required same-directory hard links");

    expect(await readFile(destination, "utf8")).toBe("before");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(false);
    expect((await readdir(stateDir)).filter((name) => name.includes(".agenttab-") || name.startsWith("transaction-intent"))).toEqual([]);
  });

  test("removes an intent whose publication cannot cross its durability barrier", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-intent-barrier-test-"));
    temporaryRoots.push(stateDir);
    const destination = join(stateDir, "active.txt");
    await writeFile(destination, "before");

    await expect(applyTransaction([
      { path: destination, content: "after", label: "active file" },
    ], {
      journal: { stateDir, operation: "intent-barrier" },
      afterIntentPublish: async () => { throw new Error("Injected intent directory barrier failure"); },
    })).rejects.toThrow("Injected intent directory barrier failure");

    expect(await readFile(destination, "utf8")).toBe("before");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(false);
    expect((await readdir(stateDir)).filter((name) => name.startsWith("transaction-intent"))).toEqual([]);
  });

  test("recovers a crash that leaves the journaled hard-link capability probe", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-link-probe-crash-test-"));
    temporaryRoots.push(stateDir);
    const destination = join(stateDir, "active.txt");
    await writeFile(destination, "before");

    await expect(applyTransaction([
      { path: destination, content: "after", label: "active file" },
    ], {
      journal: { stateDir, operation: "probe-crash" },
      crashAfterHardLinkProbe: true,
    })).rejects.toThrow("crash after hard-link preflight publication");
    expect(await readFile(destination, "utf8")).toBe("before");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(true);

    expect(await recoverPendingTransaction(stateDir)).toEqual({ recovered: true, operation: "probe-crash" });
    expect(await readFile(destination, "utf8")).toBe("before");
    expect((await readdir(stateDir)).filter((name) => name.includes(".agenttab-") || name.startsWith("transaction-intent"))).toEqual([]);
  });

  test("rejects symlink targets without replacing the link or its referent", async () => {
    if (process.platform === "win32") return;
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-symlink-test-"));
    temporaryRoots.push(stateDir);
    const referent = join(stateDir, "referent.txt");
    const destination = join(stateDir, "config.json");
    await writeFile(referent, "user-owned");
    await symlink(referent, destination);

    await expect(applyTransaction([
      { path: destination, content: "installed", label: "config" },
    ], { journal: { stateDir, operation: "symlink" } })).rejects.toThrow("non-regular file");
    expect(await readlink(destination)).toBe(referent);
    expect(await readFile(referent, "utf8")).toBe("user-owned");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(false);
  });

  test("never rolls back after the durable commit boundary is published", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-commit-test-"));
    temporaryRoots.push(stateDir);
    const destination = join(stateDir, "active.txt");
    await writeFile(destination, "before");

    await expect(applyTransaction([
      { path: destination, content: "committed", label: "active file" },
    ], {
      journal: { stateDir, operation: "update" },
      afterCommit: async () => { throw new Error("Injected cleanup failure"); },
    })).rejects.toThrow("committed but durable cleanup is pending");
    expect(await readFile(destination, "utf8")).toBe("committed");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(true);

    expect(await recoverPendingTransaction(stateDir)).toEqual({ recovered: false, operation: "update" });
    expect(await readFile(destination, "utf8")).toBe("committed");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(false);
  });

  test("treats intent-absent marker-present cleanup interruption as committed", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-cleanup-boundary-test-"));
    temporaryRoots.push(stateDir);
    const destination = join(stateDir, "active.txt");
    await writeFile(destination, "before");

    await expect(applyTransaction([
      { path: destination, content: "committed", label: "active file" },
    ], {
      journal: { stateDir, operation: "cleanup-boundary" },
      afterIntentCleanup: async () => { throw new Error("Injected crash between cleanup barriers"); },
    })).rejects.toThrow("committed but durable cleanup is pending");
    expect(await readFile(destination, "utf8")).toBe("committed");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(false);
    expect(existsSync(`${transactionJournalPath(stateDir)}.committed`)).toBe(true);

    expect(await recoverPendingTransaction(stateDir)).toEqual({ recovered: false });
    expect(await readFile(destination, "utf8")).toBe("committed");
    expect(existsSync(`${transactionJournalPath(stateDir)}.committed`)).toBe(false);
  });

  test("rolls back when commit publication cannot cross its durability barrier", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-commit-barrier-test-"));
    temporaryRoots.push(stateDir);
    const destination = join(stateDir, "active.txt");
    await writeFile(destination, "before");

    await expect(applyTransaction([
      { path: destination, content: "not-committed", label: "active file" },
    ], {
      journal: { stateDir, operation: "commit-barrier" },
      afterCommitPublish: async () => { throw new Error("Injected commit directory barrier failure"); },
    })).rejects.toThrow("Injected commit directory barrier failure");
    expect(await readFile(destination, "utf8")).toBe("before");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(false);
  });

  test("restores external after-state and the active pointer despite an unrelated recovery conflict", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-external-recovery-test-"));
    temporaryRoots.push(stateDir);
    const artifact = join(stateDir, "artifact.txt");
    const pointer = join(stateDir, "active-install.json");
    await writeFile(artifact, "artifact-before");
    await writeFile(pointer, "pointer-before");
    let registryValue = "registry-before";
    const external = {
      kind: "fixture",
      resource: "fixture-registry",
      before: "registry-before",
      after: "registry-after",
    };

    await expect(applyTransaction([
      { path: artifact, content: "artifact-after", label: "artifact" },
      { path: pointer, content: "pointer-after", label: "pointer", statePointer: true },
    ], {
      journal: { stateDir, operation: "external-recovery", external: [external] },
      applyExternal: async () => {
        registryValue = "registry-after";
        return async () => { registryValue = "registry-before"; };
      },
      crashAfterExternal: true,
    })).rejects.toThrow("crash after external changes");
    await writeFile(artifact, "concurrent-user-edit");

    await expect(recoverPendingTransaction(stateDir, {
      fixture: {
        async inspect() { return registryValue === "registry-after" ? "after" : "before"; },
        async restore() { registryValue = "registry-before"; },
      },
    })).rejects.toThrow("preserved resources changed");
    expect(registryValue).toBe("registry-before");
    expect(await readFile(pointer, "utf8")).toBe("pointer-before");
    expect(await readFile(artifact, "utf8")).toBe("concurrent-user-edit");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(true);
  });

  test("attempts active-pointer recovery even when external restoration fails", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agenttab-transaction-external-failure-test-"));
    temporaryRoots.push(stateDir);
    const pointer = join(stateDir, "active-install.json");
    await writeFile(pointer, "pointer-before");
    const external = { kind: "fixture", resource: "fixture-registry", before: "before", after: "after" };

    await expect(applyTransaction([
      { path: pointer, content: "pointer-after", label: "pointer", statePointer: true },
    ], {
      journal: { stateDir, operation: "external-failure", external: [external] },
      applyExternal: async () => async () => undefined,
      crashAfterExternal: true,
    })).rejects.toThrow("crash after external changes");

    await expect(recoverPendingTransaction(stateDir, {
      fixture: {
        async inspect() { return "after"; },
        async restore() { throw new Error("injected external restore failure"); },
      },
    })).rejects.toThrow("fixture-registry");
    expect(await readFile(pointer, "utf8")).toBe("pointer-before");
    expect(existsSync(transactionJournalPath(stateDir))).toBe(true);
  });

  test("uses case-insensitive physical journal identities on Windows", () => {
    expect(transactionPathIdentity("C:\\Users\\Alice\\AgentTab", "win32"))
      .toBe(transactionPathIdentity("c:\\users\\ALICE\\agenttab", "win32"));
    expect(transactionPathIdentity("/Case/Sensitive", "linux"))
      .not.toBe(transactionPathIdentity("/case/sensitive", "linux"));
  });

  test("rejects live cross-process contention without disturbing the owner's claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttab-state-lock-test-"));
    temporaryRoots.push(root);
    const stateDir = join(root, "state");
    const ready = join(root, "ready");
    const release = join(root, "release");
    const moduleUrl = pathToFileURL(fileURLToPath(new URL("../src/state-lock.ts", import.meta.url))).href;
    const child = Bun.spawn([process.execPath, "-e", [
      `import { existsSync } from "node:fs";`,
      `import { writeFile } from "node:fs/promises";`,
      `import { withInstallerStateLock } from ${JSON.stringify(moduleUrl)};`,
      `await withInstallerStateLock(${JSON.stringify(stateDir)}, "child", async () => {`,
      `  await writeFile(${JSON.stringify(ready)}, "ready");`,
      `  while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
      "});",
    ].join("\n")], { stdout: "ignore", stderr: "pipe" });
    let childExited = false;
    try {
      for (let attempt = 0; attempt < 500 && !existsSync(ready); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(ready)).toBe(true);
      const lockDirectory = stateDirectoryLockPath(stateDir);
      const childClaims = (await readdir(lockDirectory)).filter((name) => name.endsWith(".json"));
      expect(childClaims).toHaveLength(1);
      await expect(withInstallerStateLock(stateDir, "parent", async () => undefined)).rejects.toThrow("locked by child");
      expect((await readdir(lockDirectory)).filter((name) => name.endsWith(".json"))).toEqual(childClaims);

      await writeFile(release, "release");
      expect(await child.exited).toBe(0);
      childExited = true;
      await withInstallerStateLock(stateDir, "parent", async () => undefined);
      expect((await readdir(lockDirectory)).filter((name) => name.endsWith(".json"))).toEqual([]);
    } finally {
      if (!childExited) {
        await writeFile(release, "release").catch(() => undefined);
        child.kill();
        await child.exited.catch(() => undefined);
      }
    }
  });

  test("reclaims a claim left by a SIGKILLed lock owner", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "agenttab-state-lock-sigkill-test-"));
    temporaryRoots.push(root);
    const stateDir = join(root, "state");
    const ready = join(root, "ready");
    const moduleUrl = pathToFileURL(fileURLToPath(new URL("../src/state-lock.ts", import.meta.url))).href;
    const child = Bun.spawn([process.execPath, "-e", [
      `import { writeFile } from "node:fs/promises";`,
      `import { withInstallerStateLock } from ${JSON.stringify(moduleUrl)};`,
      `await withInstallerStateLock(${JSON.stringify(stateDir)}, "killed-child", async () => {`,
      `  await writeFile(${JSON.stringify(ready)}, "ready");`,
      "  await new Promise(() => undefined);",
      "});",
    ].join("\n")], { stdout: "ignore", stderr: "pipe" });
    let childExited = false;
    try {
      for (let attempt = 0; attempt < 500 && !existsSync(ready); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(ready)).toBe(true);
      const lockDirectory = stateDirectoryLockPath(stateDir);
      expect((await readdir(lockDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);

      child.kill("SIGKILL");
      await child.exited;
      childExited = true;
      await withInstallerStateLock(stateDir, "recovery", async () => undefined);
      expect((await readdir(lockDirectory)).filter((name) => name.endsWith(".json"))).toEqual([]);
    } finally {
      if (!childExited) {
        child.kill("SIGKILL");
        await child.exited.catch(() => undefined);
      }
    }
  });

  test("does not confuse a reused live PID with the original lock owner", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "agenttab-state-lock-pid-reuse-test-"));
    temporaryRoots.push(root);
    const stateDir = join(root, "state");
    const directory = stateDirectoryLockPath(stateDir);
    await mkdir(directory, { recursive: true });
    const selfStat = await readFile("/proc/self/stat", "utf8");
    const operatingSystemPid = Number(selfStat.slice(0, selfStat.indexOf(" ")));
    await writeFile(join(directory, "stale.json"), JSON.stringify({
      token: "stale",
      pid: process.pid,
      osPid: operatingSystemPid,
      endpoint: null,
      processIdentity: "linux:different-boot:different-start",
      operation: "stale-owner",
      acquiredAt: new Date(0).toISOString(),
      choosing: false,
      ticket: 1,
    }));

    await withInstallerStateLock(stateDir, "replacement", async () => undefined);
    expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  test("bounds legacy PID-only claims by the owner heartbeat", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "agenttab-state-lock-heartbeat-test-"));
    temporaryRoots.push(root);
    const stateDir = join(root, "state");
    const directory = stateDirectoryLockPath(stateDir);
    await mkdir(directory, { recursive: true });
    const selfStat = await readFile("/proc/self/stat", "utf8");
    const operatingSystemPid = Number(selfStat.slice(0, selfStat.indexOf(" ")));
    const claimPath = join(directory, "legacy.json");
    await writeFile(claimPath, JSON.stringify({
      token: "legacy",
      pid: process.pid,
      osPid: operatingSystemPid,
      endpoint: null,
      processIdentity: null,
      operation: "legacy-owner",
      acquiredAt: new Date(0).toISOString(),
      choosing: false,
      ticket: 1,
    }));

    await expect(withInstallerStateLock(stateDir, "fresh-contender", async () => undefined))
      .rejects.toThrow("locked by legacy-owner");

    const stale = new Date(Date.now() - 60_000);
    await utimes(claimPath, stale, stale);
    await withInstallerStateLock(stateDir, "stale-recovery", async () => undefined);
    expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  test("allows release to be retried after its claim removal fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttab-state-lock-release-test-"));
    temporaryRoots.push(root);
    const stateDir = join(root, "state");
    const lock = await acquireInstallerStateLock(stateDir, "release-test");
    const claimName = (await readdir(lock.path)).find((name) => name.endsWith(".json"))!;
    const claimPath = join(lock.path, claimName);
    await rm(claimPath);
    await mkdir(claimPath);

    await expect(lock.release()).rejects.toThrow();
    await rm(claimPath, { recursive: true });
    await lock.release();
    await withInstallerStateLock(stateDir, "after-retry", async () => undefined);
  });

  test("canonicalizes nested missing state paths through symlinked ancestors", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "agenttab-state-lock-alias-test-"));
    temporaryRoots.push(root);
    const physical = join(root, "physical");
    const alias = join(root, "alias");
    await mkdir(physical);
    await symlink(physical, alias);
    const physicalState = join(physical, "missing", "nested", "state");
    const aliasState = join(alias, "missing", "nested", "state");
    expect(stateDirectoryLockPath(aliasState)).toBe(stateDirectoryLockPath(physicalState));

    const lock = await acquireInstallerStateLock(aliasState, "alias-owner");
    try {
      await expect(acquireInstallerStateLock(physicalState, "physical-contender"))
        .rejects.toThrow("locked by alias-owner");
    } finally {
      await lock.release();
    }
  });
});

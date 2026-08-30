import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTransaction } from "../src/transaction";

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
});

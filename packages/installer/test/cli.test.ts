import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = join(packageRoot, "src", "cli.ts");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runCli(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("installer CLI arguments", () => {
  test("prints lifecycle help and package version without starting a command", async () => {
    const help = await runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("agenttab update --version X.Y.Z");
    expect(help.stdout).toContain("agenttab uninstall");
    expect(help.stderr).toBe("");

    const version = await runCli(["--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe(packageJson.version);
    expect(version.stderr).toBe("");
  });

  test("requires an exact update version before download or mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttab-cli-update-test-"));
    temporaryRoots.push(root);
    const stateDir = join(root, "state");
    const result = await runCli(["update", "--state-dir", stateDir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agenttab update requires an exact --version X.Y.Z");
    expect(existsSync(stateDir)).toBe(false);
  });

  test("rejects malformed lifecycle and install flags before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttab-cli-flags-test-"));
    temporaryRoots.push(root);
    const stateDir = join(root, "state");
    const cases = [
      [["install", "--dry-run", "false", "--state-dir", stateDir], "Unexpected argument for agenttab install: false"],
      [["uninstall", "--dry-run=false", "--state-dir", stateDir], "--dry-run does not take a value"],
      [["rollback", "--dry-rnu", "--state-dir", stateDir], "Unknown option for agenttab rollback: --dry-rnu"],
      [["prune", "--keep", "-1", "--state-dir", stateDir], "--keep must be a non-negative integer"],
      [["doctor", "--layer", "status", "--state-dir", stateDir], "--layer must be installation, ipc, protocol, host, extension, or all"],
    ] as const;
    for (const [args, message] of cases) {
      const result = await runCli([...args]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(message);
    }
    expect(existsSync(stateDir)).toBe(false);
  }, 20_000);

  test("rejects duplicate and command-specific options", async () => {
    const cases = [
      [["install", "--dry-run", "--dry-run"], "Duplicate option for agenttab install: --dry-run"],
      [["status", "--layer", "ipc"], "Unknown option for agenttab status: --layer"],
      [["install", "--version"], "--version requires a value"],
    ] as const;
    for (const [args, message] of cases) {
      const result = await runCli([...args]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(message);
    }
  }, 20_000);
});

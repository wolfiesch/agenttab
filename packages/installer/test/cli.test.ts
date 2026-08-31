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
  test("prints help without starting a command", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("agenttab install");
    expect(result.stderr).toBe("");
  });

  test("prints the package version", async () => {
    const result = await runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
    expect(result.stderr).toBe("");
  });

  test("rejects a value after a boolean flag before installation can start", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttab-cli-test-"));
    temporaryRoots.push(root);
    const stateDir = join(root, "state");
    const result = await runCli([
      "install",
      "--dry-run",
      "false",
      "--state-dir",
      stateDir,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unexpected argument for agenttab install: false");
    expect(existsSync(stateDir)).toBe(false);
  });

  test("rejects typo, duplicate, and command-specific options", async () => {
    const cases = [
      [["install", "--dry-rnu"], "Unknown option for agenttab install: --dry-rnu"],
      [["install", "--dry-run", "--dry-run"], "Duplicate option for agenttab install: --dry-run"],
      [["status", "--layer", "ipc"], "Unknown option for agenttab status: --layer"],
      [["install", "--version"], "--version requires a value"],
      [["install", "--dry-run=false"], "--dry-run does not take a value"],
    ] as const;
    for (const [args, message] of cases) {
      const result = await runCli([...args]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(message);
    }
  });
});

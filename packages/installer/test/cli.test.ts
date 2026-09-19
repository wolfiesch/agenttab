import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { encodeFrame, FrameDecoder } from "../../sdk-typescript/src/index";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = join(packageRoot, "src", "cli.ts");
const temporaryRoots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: packageRoot,
    env: { ...process.env, ...env },
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

describe("agenttab doctor", () => {
  test("rejects invalid doctor layer", async () => {
    const result = await runCli(["doctor", "--layer", "invalid"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--layer must be ipc or extension");
  });

  test("returns structured error on IPC layer when host is unreachable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttab-doctor-test-"));
    temporaryRoots.push(root);
    const nonExistentSocket = join(root, "missing.sock");
    const result = await runCli(["doctor", "--layer", "ipc"], {
      AGENTTAB_SOCKET: nonExistentSocket,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim() || result.stderr.trim());
    expect(parsed.success).toBe(false);
    expect(parsed.layer).toBe("ipc");
    expect(parsed.recovery).toContain("Open Chrome with the AgentTab extension enabled");
  });

  test("returns structured error on extension layer when host is unreachable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttab-doctor-test-"));
    temporaryRoots.push(root);
    const nonExistentSocket = join(root, "missing.sock");
    const result = await runCli(["doctor", "--layer", "extension"], {
      AGENTTAB_SOCKET: nonExistentSocket,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim() || result.stderr.trim());
    expect(parsed.success).toBe(false);
    expect(parsed.layer).toBe("extension");
    expect(parsed.recovery).toContain("Reload AgentTab in chrome://extensions");
  });

  test("doctor reports failure if runtime state is reconciling", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttab-doctor-mock-"));
    temporaryRoots.push(root);
    const socketPath = join(root, "agenttab.sock");

    const server = createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.write(
        encodeFrame({
          protocol: "agenttab.rpc",
          version: 1,
          kind: "connected",
          connection_id: crypto.randomUUID(),
          resumed: false,
          state: "reconciling",
        }),
      );
      socket.on("data", (chunk) => {
        for (const frame of decoder.push(chunk)) {
          const req = frame as { request_id: string; method: string };
          if (req.method === "agenttab.status") {
            socket.write(
              encodeFrame({
                protocol: "agenttab.rpc",
                version: 1,
                request_id: req.request_id,
                ok: true,
                outcome: "completed",
                result: { state: "reconciling", protocol_version: 1 },
              }),
            );
          }
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));

    const resultIpc = await runCli(["doctor", "--layer", "ipc"], { AGENTTAB_SOCKET: socketPath });
    expect(resultIpc.exitCode).toBe(1);
    const parsedIpc = JSON.parse(resultIpc.stdout.trim());
    expect(parsedIpc.success).toBe(false);
    expect(parsedIpc.layer).toBe("ipc");
    expect(parsedIpc.error).toContain("reconciling");

    const resultExt = await runCli(["doctor", "--layer", "extension"], { AGENTTAB_SOCKET: socketPath });
    expect(resultExt.exitCode).toBe(1);
    const parsedExt = JSON.parse(resultExt.stdout.trim());
    expect(parsedExt.success).toBe(false);
    expect(parsedExt.layer).toBe("extension");
    expect(parsedExt.error).toContain("reconciling");
  });

  test("doctor reports success and performs browser_tabs roundtrip on extension layer", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttab-doctor-ready-"));
    temporaryRoots.push(root);
    const socketPath = join(root, "agenttab.sock");

    let browserTabsCalled = false;
    let closeTaskCalled = false;

    const server = createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.write(
        encodeFrame({
          protocol: "agenttab.rpc",
          version: 1,
          kind: "connected",
          connection_id: crypto.randomUUID(),
          resumed: false,
          state: "ready",
        }),
      );
      socket.on("data", (chunk) => {
        for (const frame of decoder.push(chunk)) {
          const req = frame as { request_id: string; method: string };
          if (req.method === "agenttab.status") {
            socket.write(
              encodeFrame({
                protocol: "agenttab.rpc",
                version: 1,
                request_id: req.request_id,
                ok: true,
                outcome: "completed",
                result: { state: "ready", protocol_version: 1 },
              }),
            );
          } else if (req.method === "browser_tabs") {
            browserTabsCalled = true;
            socket.write(
              encodeFrame({
                protocol: "agenttab.rpc",
                version: 1,
                request_id: req.request_id,
                ok: true,
                outcome: "completed",
                result: { tabs: [{ tab_id: 101, url: "https://agenttab.dev", title: "AgentTab" }] },
              }),
            );
          } else if (req.method === "agenttab.close") {
            closeTaskCalled = true;
            socket.write(
              encodeFrame({
                protocol: "agenttab.rpc",
                version: 1,
                request_id: req.request_id,
                ok: true,
                outcome: "completed",
                result: { closed: true },
              }),
            );
          }
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));

    // 1. IPC layer
    const resultIpc = await runCli(["doctor", "--layer", "ipc"], { AGENTTAB_SOCKET: socketPath });
    expect(resultIpc.exitCode).toBe(0);
    const parsedIpc = JSON.parse(resultIpc.stdout.trim());
    expect(parsedIpc.success).toBe(true);
    expect(parsedIpc.result.state).toBe("ready");

    // 2. Extension layer
    const resultExt = await runCli(["doctor", "--layer", "extension"], { AGENTTAB_SOCKET: socketPath });
    expect(resultExt.exitCode).toBe(0);
    const parsedExt = JSON.parse(resultExt.stdout.trim());
    expect(parsedExt.success).toBe(true);
    expect(parsedExt.result.state).toBe("ready");
    expect(parsedExt.result.probe).toBe("browser_tabs");
    expect(parsedExt.result.tabs_count).toBe(1);
    expect(browserTabsCalled).toBe(true);
    expect(closeTaskCalled).toBe(true);
  });
});

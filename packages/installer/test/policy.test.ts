import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowUploadRoot } from "../src/policy";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenttab-policy-test-"));
  temporaryRoots.push(root);
  return root;
}

async function allowUploadRootInChild(uploadRoot: string, stateDir: string): Promise<void> {
  const child = Bun.spawn([
    process.execPath,
    "-e",
    [
      "const moduleUrl = process.env.AGENTTAB_POLICY_TEST_MODULE;",
      "const uploadRoot = process.env.AGENTTAB_POLICY_TEST_UPLOAD_ROOT;",
      "const stateDir = process.env.AGENTTAB_POLICY_TEST_STATE_DIR;",
      "if (!moduleUrl || !uploadRoot || !stateDir) throw new Error('missing policy test environment');",
      "const { allowUploadRoot } = await import(moduleUrl);",
      "await allowUploadRoot(uploadRoot, { stateDir });",
    ].join("\n"),
  ], {
    env: {
      ...process.env,
      AGENTTAB_POLICY_TEST_MODULE: new URL("../src/policy.ts", import.meta.url).href,
      AGENTTAB_POLICY_TEST_UPLOAD_ROOT: uploadRoot,
      AGENTTAB_POLICY_TEST_STATE_DIR: stateDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`policy child failed (${exitCode}): ${stderr || stdout}`);
  }
}

describe("upload policy", () => {
  test("adds one canonical upload root while preserving managed policy", async () => {
    const root = await temporaryRoot();
    const stateDir = join(root, "state");
    const uploadRoot = join(root, "workspace");
    await Promise.all([
      mkdir(stateDir, { recursive: true }),
      mkdir(uploadRoot, { recursive: true }),
    ]);
    await writeFile(join(stateDir, "policy.json"), JSON.stringify({
      audit_enabled: false,
      allowed_origins: ["https://example.test"],
    }));
    const canonicalUploadRoot = await realpath(uploadRoot);

    const first = await allowUploadRoot(uploadRoot, { stateDir });
    expect(first).toMatchObject({ allowedRoot: canonicalUploadRoot, added: true, restartRequired: true });
    expect(JSON.parse(await readFile(join(stateDir, "policy.json"), "utf8"))).toEqual({
      audit_enabled: false,
      allowed_origins: ["https://example.test"],
      dlp_allowed_roots: [canonicalUploadRoot],
    });
    if (process.platform !== "win32") {
      expect((await stat(join(stateDir, "policy.json"))).mode & 0o777).toBe(0o600);
    }
  });

  test("reports no restart and leaves policy content unchanged for a repeated no-op", async () => {
    const root = await temporaryRoot();
    const stateDir = join(root, "state");
    const uploadRoot = join(root, "workspace");
    await Promise.all([
      mkdir(stateDir, { recursive: true }),
      mkdir(uploadRoot, { recursive: true }),
    ]);
    const canonicalUploadRoot = await realpath(uploadRoot);
    await allowUploadRoot(uploadRoot, { stateDir });
    const before = await readFile(join(stateDir, "policy.json"), "utf8");

    const result = await allowUploadRoot(uploadRoot, { stateDir });

    expect(result).toEqual({
      policyFile: join(stateDir, "policy.json"),
      allowedRoot: canonicalUploadRoot,
      added: false,
      restartRequired: false,
    });
    expect(await readFile(join(stateDir, "policy.json"), "utf8")).toBe(before);
  });

  test("serializes concurrent distinct-root updates across processes", async () => {
    const root = await temporaryRoot();
    const stateDir = join(root, "state");
    const uploadRoots = Array.from({ length: 8 }, (_, index) => join(root, `workspace-${index}`));
    await Promise.all(uploadRoots.map((uploadRoot) => mkdir(uploadRoot, { recursive: true })));
    const canonicalUploadRoots = await Promise.all(uploadRoots.map((uploadRoot) => realpath(uploadRoot)));

    await Promise.all(uploadRoots.map((uploadRoot) => allowUploadRootInChild(uploadRoot, stateDir)));

    const policy = JSON.parse(await readFile(join(stateDir, "policy.json"), "utf8"));
    expect([...policy.dlp_allowed_roots].sort()).toEqual([...canonicalUploadRoots].sort());
  });

  test("rejects files, filesystem roots, and malformed existing policy", async () => {
    const root = await temporaryRoot();
    const stateDir = join(root, "state");
    const file = join(root, "file.txt");
    await mkdir(stateDir, { recursive: true });
    await writeFile(file, "fixture");
    await expect(allowUploadRoot(file, { stateDir })).rejects.toThrow("existing directory");
    await expect(allowUploadRoot(process.platform === "win32" ? "C:\\" : "/", { stateDir }))
      .rejects.toThrow("narrower than a filesystem root");
    await expect(allowUploadRoot(root, {
      stateDir: process.platform === "win32" ? "C:\\" : "/",
    })).rejects.toThrow("state directory must be narrower");
    await writeFile(join(stateDir, "policy.json"), JSON.stringify({ unexpected: true }));
    await expect(allowUploadRoot(root, { stateDir })).rejects.toThrow("unknown field unexpected");
  });
});

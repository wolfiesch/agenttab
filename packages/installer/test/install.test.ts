import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  detectLegacy,
  install,
  targetTriple,
  verifySignedManifest,
  type RuntimeAssets,
} from "../src/install";
import { applyTransaction } from "../src/transaction";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenttab-installer-test-"));
  temporaryRoots.push(root);
  return root;
}

function sha256(bytes: Buffer): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function platformSignature(): "apple_code_signing" | "authenticode" | "signed_manifest" {
  if (process.platform === "darwin") return "apple_code_signing";
  if (process.platform === "win32") return "authenticode";
  return "signed_manifest";
}

function systemExecutable(): string {
  if (process.platform === "win32") return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
  return "/usr/bin/true";
}

async function runtimeAssets(root: string): Promise<RuntimeAssets> {
  const runtime = join(root, "runtime");
  const extensionDir = join(runtime, "extension");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(join(runtime, "cli.mjs"), "#!/usr/bin/env node\nconsole.log('agenttab fixture')\n");
  await writeFile(join(runtime, "omp.mjs"), "export default function () {}\n");
  await writeFile(join(extensionDir, "manifest.json"), `${JSON.stringify({ manifest_version: 3, name: "AgentTab", version: "2.0.0" })}\n`);
  await writeFile(join(extensionDir, "background.js"), "void 0;\n");
  return {
    cliBundlePath: join(runtime, "cli.mjs"),
    ompBundlePath: join(runtime, "omp.mjs"),
    extensionDir,
  };
}

async function signedFixture(root: string, version = "2.0.0-rc.1") {
  const target = targetTriple();
  const assetName = `agenttab-host-v${version}-${target}.tar.gz`;
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  const binaryName = process.platform === "win32" ? "agenttab-host.exe" : "agenttab-host";
  await copyFile(systemExecutable(), join(source, binaryName));
  await chmod(join(source, binaryName), 0o755);
  const archivePath = join(root, assetName);
  execFileSync("tar", ["-czf", archivePath, "-C", source, binaryName]);
  const archive = await readFile(archivePath);
  const manifest = {
    schemaVersion: 1,
    repository: "wolfiesch/agenttab",
    version,
    tag: `v${version}`,
    assets: [{
      name: assetName,
      kind: "host",
      target,
      sha256: sha256(archive),
      bytes: archive.byteLength,
      platformSignature: platformSignature(),
      url: pathToFileURL(archivePath).href,
    }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signature = sign(null, manifestBytes, privateKey);
  const manifestPath = join(root, "artifact-manifest.json");
  const signaturePath = join(root, "artifact-manifest.json.sig");
  await writeFile(manifestPath, manifestBytes);
  await writeFile(signaturePath, `${signature.toString("base64")}\n`);
  return {
    manifestBytes,
    signature,
    manifestUrl: pathToFileURL(manifestPath).href,
    signatureUrl: pathToFileURL(signaturePath).href,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("release trust", () => {
  test("accepts an exact Ed25519 signature and rejects tampering", async () => {
    const root = await temporaryRoot();
    const fixture = await signedFixture(root);
    expect(verifySignedManifest(fixture.manifestBytes, Buffer.from(fixture.signature.toString("base64")), fixture.publicKeyPem).version).toBe("2.0.0-rc.1");
    const tampered = Buffer.from(fixture.manifestBytes);
    tampered[tampered.byteLength - 2] ^= 1;
    expect(() => verifySignedManifest(tampered, Buffer.from(fixture.signature.toString("base64")), fixture.publicKeyPem)).toThrow("signature verification failed");
  });

  test("maps every supported host target explicitly", () => {
    expect(targetTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(targetTriple("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(targetTriple("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
    expect(targetTriple("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(targetTriple("win32", "arm64")).toBe("aarch64-pc-windows-msvc");
    expect(targetTriple("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(() => targetTriple("freebsd", "x64")).toThrow("does not publish");
  });
});

describe("file transaction", () => {
  test("restores every destination after an injected partial failure", async () => {
    const root = await temporaryRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    await writeFile(first, "before-one");
    await writeFile(second, "before-two");
    await expect(applyTransaction([
      { path: first, content: "after-one", label: "first" },
      { path: second, content: "after-two", label: "second" },
    ], { failAfter: 1 })).rejects.toThrow("Injected transaction failure");
    expect(await readFile(first, "utf8")).toBe("before-one");
    expect(await readFile(second, "utf8")).toBe("before-two");
  });
});

describe("end-to-end development install", () => {
  test("installs side by side, skips malformed configs, and repeats without writes", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const stateDir = join(home, ".agenttab");
    const windsurf = join(home, ".codeium", "windsurf", "mcp_config.json");
    const omp = join(home, ".omp", "config.yml");
    await mkdir(join(home, ".codeium", "windsurf"), { recursive: true });
    await mkdir(join(home, ".omp"), { recursive: true });
    await writeFile(windsurf, "{malformed");
    await writeFile(omp, "extensions:\n  - existing-extension\n");
    const legacyRoot = process.platform === "darwin"
      ? join(home, "Library", "Application Support", "chrome-native-bridge")
      : join(home, ".config", "chrome-native-bridge");
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(join(legacyRoot, "bridge_policy.json"), "{}\n");

    const fixture = await signedFixture(root);
    const assets = await runtimeAssets(root);
    const output: string[] = [];
    const options = {
      version: "2.0.0-rc.1",
      development: true,
      manifestUrl: fixture.manifestUrl,
      signatureUrl: fixture.signatureUrl,
      publicKeyPem: fixture.publicKeyPem,
      home,
      stateDir,
      runtimeAssets: assets,
      skipReadiness: true,
      openBrowser: false,
      print: (line: string) => output.push(line),
    } as const;
    const first = await install(options);
    expect(first.transaction.changed.length).toBeGreaterThan(6);
    expect(first.skippedConfigs).toHaveLength(1);
    expect(first.skippedConfigs[0]).toMatchObject({ client: "Windsurf", path: windsurf });
    expect(first.skippedConfigs[0].reason).toStartWith("malformed JSON:");
    expect(await readFile(windsurf, "utf8")).toBe("{malformed");
    expect(first.legacy.stateArtifacts).toContain(join(legacyRoot, "bridge_policy.json"));
    expect(first.legacy.unpackedExtensionId).toBe("idnlffjfkgcnjfdhocemdeihhejpamkc");
    expect(output.join("\n")).not.toContain("bridge_policy.json\n{}");

    const mtimes = new Map<string, number>();
    for (const path of first.transaction.changed) mtimes.set(path, (await stat(path)).mtimeMs);
    const second = await install(options);
    expect(second.transaction.changed).toEqual([]);
    for (const [path, mtime] of mtimes) expect((await stat(path)).mtimeMs).toBe(mtime);
  });

  test("dry-run verifies artifacts and produces no installation state", async () => {
    const root = await temporaryRoot();
    const fixture = await signedFixture(root);
    const assets = await runtimeAssets(root);
    const home = join(root, "dry-home");
    const stateDir = join(home, ".agenttab");
    const result = await install({
      version: "2.0.0-rc.1",
      development: true,
      manifestUrl: fixture.manifestUrl,
      signatureUrl: fixture.signatureUrl,
      publicKeyPem: fixture.publicKeyPem,
      home,
      stateDir,
      runtimeAssets: assets,
      dryRun: true,
      skipReadiness: true,
      openBrowser: false,
      print: () => undefined,
    });
    expect(result.transaction.changed).toEqual([]);
    expect(existsSync(stateDir)).toBe(false);
  });

  test("reports the frozen v1 recovery identity without mutating it", async () => {
    const root = await temporaryRoot();
    const report = detectLegacy(root, process.platform);
    expect(report.recoveryTag).toBe("v1.0.1");
    expect(report.unpackedExtensionStatus).toBe("manual_check_required");
  });
});

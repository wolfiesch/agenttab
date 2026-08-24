import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";
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

async function signedArchiveFixture(
  root: string,
  {
    archive,
    assetName,
    platformSignature: signatureType,
    target,
    version = "2.0.0-rc.1",
  }: {
    archive: Buffer;
    assetName: string;
    platformSignature: "apple_code_signing" | "authenticode" | "signed_manifest";
    target: string;
    version?: string;
  },
) {
  const archivePath = join(root, assetName);
  await writeFile(archivePath, archive);
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
      platformSignature: signatureType,
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

interface ZipFixtureEntry {
  name: string;
  bytes: Buffer;
  mode?: number;
}

function crc32(bytes: Buffer): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) * 0xedb8_8320);
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function zipArchive(entries: ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.bytes);
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(entry.bytes.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(entry.bytes.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100755) << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralDirectory.push(central, name);
    localOffset += local.byteLength + name.byteLength + compressed.byteLength;
  }

  const directory = Buffer.concat(centralDirectory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function signedWindowsZipFixture(root: string, archive: Buffer) {
  const version = "2.0.0-rc.1";
  const target = targetTriple("win32", "x64");
  return signedArchiveFixture(root, {
    archive,
    assetName: `agenttab-host-v${version}-${target}.zip`,
    platformSignature: "authenticode",
    target,
    version,
  });
}

async function addPowerShellShim(root: string): Promise<() => void> {
  if (process.platform === "win32") return () => undefined;
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const shim = join(bin, "powershell.exe");
  await writeFile(shim, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = previous ? `${bin}${delimiter}${previous}` : bin;
  return () => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
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
  return signedArchiveFixture(root, {
    archive: await readFile(archivePath),
    assetName,
    platformSignature: platformSignature(),
    target,
    version,
  });
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

describe("Windows host archives", () => {
  test("selects the Windows ZIP contract and safely extracts the expected executable", async () => {
    const root = await temporaryRoot();
    const executable = process.platform === "win32"
      ? await readFile(systemExecutable())
      : Buffer.from("AgentTab Windows host fixture");
    const fixture = await signedWindowsZipFixture(root, zipArchive([{
      name: "agenttab-host.exe",
      bytes: executable,
    }]));
    const restorePowerShell = await addPowerShellShim(root);
    try {
      const result = await install({
        version: "2.0.0-rc.1",
        development: true,
        manifestUrl: fixture.manifestUrl,
        signatureUrl: fixture.signatureUrl,
        publicKeyPem: fixture.publicKeyPem,
        home: join(root, "home"),
        stateDir: join(root, "state"),
        platform: "win32",
        arch: "x64",
        runtimeAssets: await runtimeAssets(root),
        dryRun: true,
        skipReadiness: true,
        openBrowser: false,
        print: () => undefined,
      });
      expect(result.target).toBe("x86_64-pc-windows-msvc");
      expect(result.transaction.changed).toEqual([]);
    } finally {
      restorePowerShell();
    }
  });

  test("requires the published ZIP asset for Windows", async () => {
    const root = await temporaryRoot();
    const version = "2.0.0-rc.1";
    const target = targetTriple("win32", "x64");
    const fixture = await signedArchiveFixture(root, {
      archive: Buffer.from("not a ZIP"),
      assetName: `agenttab-host-v${version}-${target}.tar.gz`,
      platformSignature: "authenticode",
      target,
      version,
    });
    await expect(install({
      version,
      development: true,
      manifestUrl: fixture.manifestUrl,
      signatureUrl: fixture.signatureUrl,
      publicKeyPem: fixture.publicKeyPem,
      platform: "win32",
      arch: "x64",
      dryRun: true,
      skipReadiness: true,
      openBrowser: false,
      print: () => undefined,
    })).rejects.toThrow(`agenttab-host-v${version}-${target}.zip`);
  });

  test("rejects malformed, absolute, traversing, symlink, and multi-member ZIPs", async () => {
    const archives = [
      Buffer.from("not a ZIP"),
      zipArchive([{ name: "/agenttab-host.exe", bytes: Buffer.from("host") }]),
      zipArchive([{ name: "../agenttab-host.exe", bytes: Buffer.from("host") }]),
      zipArchive([{ name: "agenttab-host.exe", bytes: Buffer.from("host"), mode: 0o120777 }]),
      zipArchive([
        { name: "agenttab-host.exe", bytes: Buffer.from("host") },
        { name: "unexpected.txt", bytes: Buffer.from("unexpected") },
      ]),
    ];
    for (const archive of archives) {
      const root = await temporaryRoot();
      const fixture = await signedWindowsZipFixture(root, archive);
      await expect(install({
        version: "2.0.0-rc.1",
        development: true,
        manifestUrl: fixture.manifestUrl,
        signatureUrl: fixture.signatureUrl,
        publicKeyPem: fixture.publicKeyPem,
        platform: "win32",
        arch: "x64",
        dryRun: true,
        skipReadiness: true,
        openBrowser: false,
        print: () => undefined,
      })).rejects.toThrow("host ZIP");
    }
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

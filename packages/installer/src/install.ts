import { execFile, execFileSync } from "node:child_process";
import { createHash, verify as verifySignature } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { arch as currentArch, homedir, platform as currentPlatform, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import identityJson from "../../../config/identity.json" with { type: "json" };
import trustJson from "../../../config/release-trust.json" with { type: "json" };
import migrationJson from "../../../config/migration-v1.json" with { type: "json" };
import { planClientConfigs } from "./configs";
import {
  applyRegistryChanges,
  activeReceiptDrift,
  queryRegistryValue,
  registryChangesForJournal,
  verifyRuntimeReadiness,
  withInstallerStateMutation,
  windowsRegistryKeys,
} from "./lifecycle";
import {
  activeStatePath,
  canonicalJson,
  expectationFromSnapshot,
  loadActiveReceipt,
  newReceiptPath,
  ownershipForFile,
  readOptionalBytes,
  referenceForReceipt,
  type InstallReceiptV2,
  type RegistryOwnership,
} from "./receipt";
import {
  activateDaemonService,
  planDaemonService,
  type DaemonServiceManager,
} from "./service";
import { applyTransaction, type FileExpectation, type PlannedFile, type TransactionResult } from "./transaction";
import { fileURLToPath } from "node:url";

const identity = identityJson as {
  product: string;
  version: string;
  nativeHost: string;
  developmentExtension: { id: string; publicKey: string };
  webStoreExtensionId: string | null;
};
const trust = trustJson as {
  repository: string;
  developmentPublicKeyPem: string | null;
  stablePublicKeyPem: string | null;
};
const migration = migrationJson as {
  tag: string;
  nativeHost: string;
  developmentExtensionId: string;
  stateArtifacts: string[];
};

interface ArtifactEntry {
  name: string;
  kind: "host";
  target: string;
  sha256: string;
  bytes: number;
  platformSignature: "apple_code_signing" | "authenticode" | "signed_manifest";
  url: string;
}

interface ArtifactManifest {
  schemaVersion: 1;
  repository: string;
  version: string;
  tag: string;
  assets: ArtifactEntry[];
}

export interface RuntimeAssets {
  /** Exact version represented by these bundled CLI/OMP/extension bytes. */
  version?: string;
  cliBundlePath: string;
  ompBundlePath: string;
  extensionDir: string;
}

export interface InstallOptions {
  version: string;
  manifestUrl?: string;
  signatureUrl?: string;
  development?: boolean;
  stateDir?: string;
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  runtimeAssets?: RuntimeAssets;
  publicKeyPem?: string;
  dryRun?: boolean;
  verifyReadiness?: boolean;
  openBrowser?: boolean;
  print?: (line: string) => void;
  transactionFailAfter?: number;
  transactionCrashAfter?: number;
  transactionCrashAfterExternal?: boolean;
  registryFailAfter?: number;
  /** Fault-injection hook for verifying plan-to-transaction compare-and-swap behavior. */
  beforeTransaction?: () => Promise<void>;
}

export interface LegacyReport {
  nativeHostRegistrations: string[];
  stateArtifacts: string[];
  unpackedExtensionId: string;
  unpackedExtensionStatus: "manual_check_required";
  recoveryTag: string;
}

export interface InstallResult {
  version: string;
  target: string;
  stateDir: string;
  transaction: TransactionResult;
  skippedConfigs: Array<{ client: string; path: string; reason: string }>;
  legacy: LegacyReport;
  extension: {
    path: string;
    status: "planned" | "manual_load_required" | "verified";
    instructions: string[];
  };
  readiness: {
    passed: boolean;
    skipped: boolean;
    reason?: "dry_run" | "manual_extension_load";
  };
  service: {
    manager: DaemonServiceManager;
    status: "active" | "planned" | "shim_fallback";
    reason?: string;
  };
}

export class InstallError extends Error {
  readonly layer: string;
  readonly recovery: string;

  constructor(layer: string, message: string, recovery: string) {
    super(`${layer}: ${message}`);
    this.name = "InstallError";
    this.layer = layer;
    this.recovery = recovery;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`artifact manifest ${field} must be a non-empty string`);
  return value;
}

function parseManifest(bytes: Buffer): ArtifactManifest {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.assets)) {
    throw new Error("artifact manifest must use schemaVersion 1 and contain assets");
  }
  const assets = value.assets.map((entry, index): ArtifactEntry => {
    if (!isRecord(entry)) throw new Error(`artifact manifest assets[${index}] must be an object`);
    const platformSignature = requireString(entry.platformSignature, `assets[${index}].platformSignature`);
    if (!["apple_code_signing", "authenticode", "signed_manifest"].includes(platformSignature)) {
      throw new Error(`artifact manifest assets[${index}].platformSignature is unsupported`);
    }
    if (entry.kind !== "host" || !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0) {
      throw new Error(`artifact manifest assets[${index}] has invalid kind or byte count`);
    }
    const digest = requireString(entry.sha256, `assets[${index}].sha256`);
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`artifact manifest assets[${index}].sha256 is invalid`);
    return {
      name: requireString(entry.name, `assets[${index}].name`),
      kind: "host",
      target: requireString(entry.target, `assets[${index}].target`),
      sha256: digest,
      bytes: Number(entry.bytes),
      platformSignature: platformSignature as ArtifactEntry["platformSignature"],
      url: requireString(entry.url, `assets[${index}].url`),
    };
  });
  return {
    schemaVersion: 1,
    repository: requireString(value.repository, "repository"),
    version: requireString(value.version, "version"),
    tag: requireString(value.tag, "tag"),
    assets,
  };
}

function decodeSignature(bytes: Buffer): Buffer {
  const encoded = bytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("artifact manifest signature must be base64");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength !== 64) throw new Error("artifact manifest signature must be a 64-byte Ed25519 signature");
  return decoded;
}

export function verifySignedManifest(
  manifestBytes: Buffer,
  signatureBytes: Buffer,
  publicKeyPem: string,
): ArtifactManifest {
  if (!verifySignature(null, manifestBytes, publicKeyPem, decodeSignature(signatureBytes))) {
    throw new Error("artifact manifest signature verification failed");
  }
  return parseManifest(manifestBytes);
}

function validVersion(version: string): string {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid AgentTab version: ${version}`);
  }
  return version;
}

export function targetTriple(platform: NodeJS.Platform = currentPlatform(), architecture: string = currentArch()): string {
  const key = `${platform}/${architecture}`;
  const targets: Record<string, string> = {
    "darwin/arm64": "aarch64-apple-darwin",
    "darwin/x64": "x86_64-apple-darwin",
    "linux/arm64": "aarch64-unknown-linux-gnu",
    "linux/x64": "x86_64-unknown-linux-gnu",
    // Windows on ARM runs the signed x64 host through built-in application emulation.
    "win32/arm64": "x86_64-pc-windows-msvc",
    "win32/x64": "x86_64-pc-windows-msvc",
  };
  const target = targets[key];
  if (!target) throw new Error(`AgentTab does not publish a host for ${key}`);
  return target;
}

function hostAssetName(version: string, target: string, platform: NodeJS.Platform): string {
  return `agenttab-host-v${version}-${target}.${platform === "win32" ? "zip" : "tar.gz"}`;
}

const GITHUB_RELEASE_ASSET_HOSTS: Record<string, true> = {
  "objects.githubusercontent.com": true,
  "release-assets.githubusercontent.com": true,
};

function trustedReleaseSource(url: URL): boolean {
  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
  if (url.hostname === "github.com") {
    return url.pathname.startsWith(`/${trust.repository}/releases/download/`) && !url.pathname.includes("/latest");
  }
  return GITHUB_RELEASE_ASSET_HOSTS[url.hostname] === true
    && url.pathname.startsWith("/github-production-release-asset-");
}

function releaseSourceDescription(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

async function fetchBytes(url: string, development: boolean): Promise<Buffer> {
  if (url.startsWith("file:")) {
    if (!development) throw new Error("file URLs are allowed only for a development install");
    return readFile(fileURLToPath(url));
  }
  if (!url.startsWith("https://")) throw new Error(`installer URL must use HTTPS: ${url}`);
  const requestedUrl = new URL(url);
  if (!development && !trustedReleaseSource(requestedUrl)) {
    throw new Error(`installer URL must be a trusted GitHub release source: ${releaseSourceDescription(requestedUrl)}`);
  }
  const response = await fetch(url, { redirect: "follow" });
  const finalUrl = new URL(response.url);
  if (!development && !trustedReleaseSource(finalUrl)) {
    throw new Error(`download resolved outside trusted GitHub release sources: ${releaseSourceDescription(finalUrl)}`);
  }
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function defaultManifestUrl(version: string): string {
  return `https://github.com/${trust.repository}/releases/download/v${version}/artifact-manifest.json`;
}

function validateManifestIdentity(manifest: ArtifactManifest, version: string): void {
  if (manifest.repository !== trust.repository) throw new Error(`artifact repository must be ${trust.repository}`);
  if (manifest.version !== version || manifest.tag !== `v${version}`) {
    throw new Error(`artifact manifest identity does not match immutable tag v${version}`);
  }
}

function validateAssetUrl(asset: ArtifactEntry, version: string, development: boolean): void {
  if (development && asset.url.startsWith("file:")) return;
  const expected = `https://github.com/${trust.repository}/releases/download/v${version}/${asset.name}`;
  if (asset.url !== expected) throw new Error(`artifact URL must be the immutable release asset ${expected}`);
}

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x0605_4b50;
const ZIP_CENTRAL_DIRECTORY_FILE = 0x0201_4b50;
const ZIP_LOCAL_FILE = 0x0403_4b50;
const ZIP_UTF8_FLAG = 0x0800;
const MAX_HOST_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) * 0xedb8_8320);
  return value >>> 0;
});

function zipError(message: string): Error {
  return new Error(`host ZIP ${message}`);
}

function zipUInt16(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw zipError("is truncated");
  return bytes.readUInt16LE(offset);
}

function zipUInt32(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw zipError("is truncated");
  return bytes.readUInt32LE(offset);
}

function crc32(bytes: Buffer): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffff_ffff) >>> 0;
}

function zipMemberName(bytes: Buffer): string {
  const name = bytes.toString("utf8");
  if (!Buffer.from(name, "utf8").equals(bytes)) throw zipError("contains a non-UTF-8 member name");
  if (
    name.length === 0 ||
    name.includes("\0") ||
    name.startsWith("/") ||
    name.startsWith("\\") ||
    /^[A-Za-z]:/.test(name) ||
    name.split(/[\\/]/).some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw zipError("contains an unsafe member path");
  }
  return name;
}

function assertZipRegularFile(creator: number, attributes: number): void {
  if (creator === 3 || creator === 19) {
    const fileType = (attributes >>> 16) & 0o170000;
    if (fileType !== 0o100000) throw zipError("member is not a regular file");
    return;
  }
  if ((attributes & 0x10) !== 0) throw zipError("member is a directory");
}

function zipEndOfCentralDirectory(archive: Buffer): number {
  const minimumOffset = Math.max(0, archive.byteLength - 0xffff - 22);
  for (let offset = archive.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (zipUInt32(archive, offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = zipUInt16(archive, offset + 20);
    if (offset + 22 + commentLength === archive.byteLength) return offset;
  }
  throw zipError("is missing its end-of-central-directory record");
}

interface ZipExecutable {
  name: string;
  flags: number;
  method: number;
  expectedCrc: number;
  compressedSize: number;
  uncompressedSize: number;
  nameBytes: Buffer;
  localOffset: number;
}

function extractWindowsZipExecutables(archive: Buffer, expectedNames: string[]): Map<string, Buffer> {
  const endOffset = zipEndOfCentralDirectory(archive);
  const disk = zipUInt16(archive, endOffset + 4);
  const centralDirectoryDisk = zipUInt16(archive, endOffset + 6);
  const entriesOnDisk = zipUInt16(archive, endOffset + 8);
  const entries = zipUInt16(archive, endOffset + 10);
  const centralDirectorySize = zipUInt32(archive, endOffset + 12);
  const centralDirectoryOffset = zipUInt32(archive, endOffset + 16);
  if (
    disk !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== expectedNames.length ||
    entries !== expectedNames.length
  ) {
    throw zipError(`must contain exactly ${expectedNames.join(" and ")}`);
  }
  if (centralDirectoryOffset + centralDirectorySize !== endOffset) {
    throw zipError("has an invalid central directory");
  }
  const expected = new Set(expectedNames);
  const members: ZipExecutable[] = [];
  let centralOffset = centralDirectoryOffset;
  for (let index = 0; index < entries; index += 1) {
    if (zipUInt32(archive, centralOffset) !== ZIP_CENTRAL_DIRECTORY_FILE) {
      throw zipError("has an invalid central-directory member");
    }
    const flags = zipUInt16(archive, centralOffset + 8);
    const method = zipUInt16(archive, centralOffset + 10);
    const expectedCrc = zipUInt32(archive, centralOffset + 16);
    const compressedSize = zipUInt32(archive, centralOffset + 20);
    const uncompressedSize = zipUInt32(archive, centralOffset + 24);
    const nameLength = zipUInt16(archive, centralOffset + 28);
    const extraLength = zipUInt16(archive, centralOffset + 30);
    const memberCommentLength = zipUInt16(archive, centralOffset + 32);
    const memberDisk = zipUInt16(archive, centralOffset + 34);
    const creator = zipUInt16(archive, centralOffset + 4) >>> 8;
    const attributes = zipUInt32(archive, centralOffset + 38);
    const localOffset = zipUInt32(archive, centralOffset + 42);
    const centralEnd = centralOffset + 46 + nameLength + extraLength + memberCommentLength;
    if (centralEnd > endOffset || memberDisk !== 0) throw zipError("has an invalid central-directory member");
    if ((flags & ~ZIP_UTF8_FLAG) !== 0 || (method !== 0 && method !== 8)) {
      throw zipError("uses unsupported encryption, streaming, or compression");
    }
    if (uncompressedSize === 0 || uncompressedSize > MAX_HOST_EXECUTABLE_BYTES) {
      throw zipError("has an invalid executable size");
    }
    const nameBytes = archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength);
    const name = zipMemberName(nameBytes);
    if (!expected.delete(name)) throw zipError(`must contain exactly ${expectedNames.join(" and ")}`);
    assertZipRegularFile(creator, attributes);
    members.push({ name, flags, method, expectedCrc, compressedSize, uncompressedSize, nameBytes, localOffset });
    centralOffset = centralEnd;
  }
  if (centralOffset !== endOffset || expected.size !== 0) {
    throw zipError(`must contain exactly ${expectedNames.join(" and ")}`);
  }

  const executables = new Map<string, Buffer>();
  const localMembers = [...members].sort((left, right) => left.localOffset - right.localOffset);
  let expectedLocalOffset = 0;
  for (const member of localMembers) {
    const { localOffset } = member;
    if (localOffset !== expectedLocalOffset || zipUInt32(archive, localOffset) !== ZIP_LOCAL_FILE) {
      throw zipError("has an invalid local member");
    }
    const localFlags = zipUInt16(archive, localOffset + 6);
    const localMethod = zipUInt16(archive, localOffset + 8);
    const localCrc = zipUInt32(archive, localOffset + 14);
    const localCompressedSize = zipUInt32(archive, localOffset + 18);
    const localUncompressedSize = zipUInt32(archive, localOffset + 22);
    const localNameLength = zipUInt16(archive, localOffset + 26);
    const localExtraLength = zipUInt16(archive, localOffset + 28);
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + member.compressedSize;
    if (
      localFlags !== member.flags ||
      localMethod !== member.method ||
      localCrc !== member.expectedCrc ||
      localCompressedSize !== member.compressedSize ||
      localUncompressedSize !== member.uncompressedSize ||
      !localName.equals(member.nameBytes) ||
      dataEnd > centralDirectoryOffset
    ) {
      throw zipError("has inconsistent local-member metadata");
    }
    let executable: Buffer;
    try {
      const data = archive.subarray(dataStart, dataEnd);
      executable = member.method === 0
        ? Buffer.from(data)
        : inflateRawSync(data, { maxOutputLength: member.uncompressedSize });
    } catch {
      throw zipError("contains invalid compressed executable data");
    }
    if (executable.byteLength !== member.uncompressedSize || crc32(executable) !== member.expectedCrc) {
      throw zipError("contains an invalid executable payload");
    }
    executables.set(member.name, executable);
    expectedLocalOffset = dataEnd;
  }
  if (expectedLocalOffset !== centralDirectoryOffset) throw zipError("has unindexed local data");
  return executables;
}

async function extractHost(archive: Buffer, stateDir: string, platform: NodeJS.Platform): Promise<{ hostBytes: Buffer; shimBytes: Buffer; tempDir: string }> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(join(stateDir, ".install-"));
  const binaryName = platform === "win32" ? "agenttab-host.exe" : "agenttab-host";
  const shimName = platform === "win32" ? "agenttab-native.exe" : "agenttab-native";
  if (platform === "win32") {
    try {
      const hostPath = join(tempDir, binaryName);
      const shimPath = join(tempDir, shimName);
      const executables = extractWindowsZipExecutables(archive, [binaryName, shimName]);
      const hostBytes = executables.get(binaryName)!;
      const shimBytes = executables.get(shimName)!;
      await writeFile(hostPath, hostBytes, { mode: 0o700 });
      await writeFile(shimPath, shimBytes, { mode: 0o700 });
      await chmod(hostPath, 0o755);
      await chmod(shimPath, 0o755);
      return { hostBytes, shimBytes, tempDir };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  const archivePath = join(tempDir, "host.tar.gz");
  await writeFile(archivePath, archive, { mode: 0o600 });
  const listing = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((name) => name.replace(/^\.\//, ""));
  if (listing.length !== 2 || new Set(listing).size !== 2 || !listing.includes(binaryName) || !listing.includes(shimName)) {
    throw new Error(`host archive must contain exactly ${binaryName} and ${shimName}`);
  }
  if (listing.some((name) => name.startsWith("/") || name.split("/").includes(".."))) {
    throw new Error("host archive contains an unsafe path");
  }
  execFileSync("tar", ["-xzf", archivePath, "-C", tempDir]);
  const hostPath = join(tempDir, binaryName);
  const shimPath = join(tempDir, shimName);
  const metadata = await lstat(hostPath);
  const shimMetadata = await lstat(shimPath);
  if (!metadata.isFile() || !shimMetadata.isFile()) throw new Error("host archive did not extract regular executables");
  await chmod(hostPath, 0o755);
  await chmod(shimPath, 0o755);
  return { hostBytes: await readFile(hostPath), shimBytes: await readFile(shimPath), tempDir };
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function verifyPlatformSignature(
  hostPath: string,
  entry: ArtifactEntry,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "darwin") {
    if (entry.platformSignature !== "apple_code_signing") throw new Error("macOS host must declare Apple code signing");
    execFileSync("codesign", ["--verify", "--strict", "--verbose=2", hostPath], { stdio: "pipe" });
    return;
  }
  if (platform === "win32") {
    if (entry.platformSignature !== "authenticode") throw new Error("Windows host must declare Authenticode");
    const command = `$s=Get-AuthenticodeSignature -LiteralPath ${quotePowerShell(hostPath)}; if ($s.Status -ne 'Valid') { throw $s.Status }`;
    execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { stdio: "pipe", env: { ...process.env } },
    );
    return;
  }
  if (entry.platformSignature !== "signed_manifest") throw new Error("Linux host must be covered by the signed artifact manifest");
}

async function collectDirectoryPlans(sourceRoot: string, destinationRoot: string, label: string): Promise<PlannedFile[]> {
  const plans: PlannedFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const source = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${label} source must not contain symlinks: ${source}`);
      if (entry.isDirectory()) await visit(source);
      else if (entry.isFile()) {
        plans.push({
          path: join(destinationRoot, relative(sourceRoot, source)),
          content: await readFile(source),
          mode: 0o600,
          label: `${label}/${relative(sourceRoot, source)}`,
        });
      }
    }
  };
  await visit(sourceRoot);
  return plans;
}

function extensionDigest(plans: PlannedFile[]): string {
  const hash = createHash("sha256");
  for (const plan of [...plans].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(plan.path);
    hash.update(Buffer.isBuffer(plan.content) ? plan.content : Buffer.from(plan.content));
  }
  return hash.digest("hex");
}

function extensionVersion(plans: PlannedFile[], extensionRoot: string): string {
  const manifest = plans.find((plan) => plan.path === join(extensionRoot, "manifest.json"));
  if (!manifest) throw new Error("AgentTab extension bundle is missing manifest.json");
  const parsed: unknown = JSON.parse(
    (Buffer.isBuffer(manifest.content) ? manifest.content : Buffer.from(manifest.content)).toString("utf8"),
  );
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || typeof (parsed as Record<string, unknown>).version !== "string"
  ) throw new Error("AgentTab extension manifest has no version");
  return (parsed as Record<string, unknown>).version as string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function nativeManifest(shimPath: string): string {
  const extensionIds = [identity.developmentExtension.id, identity.webStoreExtensionId].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return `${JSON.stringify({
    name: identity.nativeHost,
    description: "AgentTab local browser runtime",
    path: shimPath,
    type: "stdio",
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  }, null, 2)}\n`;
}

function nativeManifestPaths(home: string, stateDir: string, platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return [
      join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${identity.nativeHost}.json`),
      join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts", `${identity.nativeHost}.json`),
      join(home, "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts", `${identity.nativeHost}.json`),
    ];
  }
  if (platform === "linux") {
    return [
      join(home, ".config", "google-chrome", "NativeMessagingHosts", `${identity.nativeHost}.json`),
      join(home, ".config", "chromium", "NativeMessagingHosts", `${identity.nativeHost}.json`),
      join(home, ".config", "microsoft-edge", "NativeMessagingHosts", `${identity.nativeHost}.json`),
    ];
  }
  return [join(stateDir, "native-messaging", `${identity.nativeHost}.json`)];
}

function legacyManifestPaths(home: string, platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return [
      join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${migration.nativeHost}.json`),
      join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts", `${migration.nativeHost}.json`),
      join(home, "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts", `${migration.nativeHost}.json`),
    ];
  }
  if (platform === "linux") {
    return [
      join(home, ".config", "google-chrome", "NativeMessagingHosts", `${migration.nativeHost}.json`),
      join(home, ".config", "chromium", "NativeMessagingHosts", `${migration.nativeHost}.json`),
      join(home, ".config", "microsoft-edge", "NativeMessagingHosts", `${migration.nativeHost}.json`),
    ];
  }
  return [];
}

export function detectLegacy(home: string, platform: NodeJS.Platform = currentPlatform()): LegacyReport {
  const roots = platform === "darwin"
    ? [join(home, "Library", "Application Support", "chrome-native-bridge")]
    : [join(home, ".config", "chrome-native-bridge")];
  return {
    nativeHostRegistrations: legacyManifestPaths(home, platform).filter(existsSync),
    stateArtifacts: roots.flatMap((root) => migration.stateArtifacts.map((name) => join(root, name))).filter(existsSync),
    unpackedExtensionId: migration.developmentExtensionId,
    unpackedExtensionStatus: "manual_check_required",
    recoveryTag: migration.tag,
  };
}

function startBrowser(platform: NodeJS.Platform): void {
  if (platform === "darwin") {
    execFile("open", ["-gja", "Google Chrome"], () => undefined);
  } else if (platform === "win32") {
    execFile("cmd.exe", ["/d", "/s", "/c", "start", "", "chrome.exe"], () => undefined);
  } else {
    execFile("google-chrome", ["--no-first-run"], () => undefined);
  }
}

function runtimeAssetsFromBundle(): RuntimeAssets {
  const root = dirname(fileURLToPath(import.meta.url));
  return {
    version: identity.version,
    cliBundlePath: join(root, "cli.mjs"),
    ompBundlePath: join(root, "omp.mjs"),
    extensionDir: join(root, "extension"),
  };
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): { core: number[]; pre: string[] | null } => {
    const [core, prerelease] = value.split("-", 2);
    return { core: core.split(".").map(Number), pre: prerelease === undefined ? null : prerelease.split(".") };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.pre[index];
    const bv = b.pre[index];
    if (av === bv) continue;
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1;
    const an = /^[0-9]+$/.test(av) ? Number(av) : null;
    const bn = /^[0-9]+$/.test(bv) ? Number(bv) : null;
    if (an !== null && bn !== null) return an < bn ? -1 : 1;
    if (an !== null || bn !== null) return an !== null ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

async function installInternal(options: InstallOptions & { activation: "install" | "update" }): Promise<InstallResult> {
  const version = validVersion(options.version);
  const development = options.development === true;
  const platform = options.platform ?? currentPlatform();
  const target = targetTriple(platform, options.arch ?? currentArch());
  const home = resolve(options.home ?? homedir());
  const stateDir = resolve(options.stateDir ?? join(home, ".agenttab"));
  const print = options.print ?? ((line: string) => console.log(line));
  const active = await loadActiveReceipt(stateDir);
  if (options.activation === "update") {
    if (!active) throw new Error("agenttab update requires an existing managed AgentTab installation");
    if (compareVersions(version, active.receipt.version) <= 0) {
      throw new Error(`agenttab update requires a version newer than ${active.receipt.version}; use agenttab rollback for a downgrade`);
    }
  } else if (active && active.receipt.version !== version) {
    throw new Error(`AgentTab ${active.receipt.version} is active; use agenttab update --version ${version} to activate a newer version`);
  }
  const runtime = options.runtimeAssets ?? runtimeAssetsFromBundle();
  if (runtime.version !== undefined && runtime.version !== version) {
    throw new Error(
      `installer runtime ${runtime.version} cannot activate AgentTab ${version}; run the exact AgentTab ${version} installer package`,
    );
  }
  const manifestUrl = options.manifestUrl ?? defaultManifestUrl(version);
  if (manifestUrl.includes("/latest")) throw new Error("installer must never resolve a latest release URL");
  const signatureUrl = options.signatureUrl ?? `${manifestUrl}.sig`;
  const publicKeyPem = options.publicKeyPem ?? (development ? trust.developmentPublicKeyPem : trust.stablePublicKeyPem);
  if (!publicKeyPem) throw new Error("stable release trust key is not configured; install an explicitly signed prerelease instead");

  const [manifestBytes, signatureBytes] = await Promise.all([
    fetchBytes(manifestUrl, development),
    fetchBytes(signatureUrl, development),
  ]);
  const manifest = verifySignedManifest(manifestBytes, signatureBytes, publicKeyPem);
  validateManifestIdentity(manifest, version);
  const assetName = hostAssetName(version, target, platform);
  const asset = manifest.assets.find((entry) => entry.kind === "host" && entry.target === target && entry.name === assetName);
  if (!asset) throw new Error(`artifact manifest has no exact host asset ${assetName}`);
  validateAssetUrl(asset, version, development);

  const versionRoot = join(stateDir, "versions", `v${version}`);
  const hostPath = join(versionRoot, target, platform === "win32" ? "agenttab-host.exe" : "agenttab-host");
  const shimPath = join(versionRoot, target, platform === "win32" ? "agenttab-native.exe" : "agenttab-native");
  const runtimeConfigPath = join(versionRoot, target, "agenttab-runtime.json");
  const manifestSha = sha256(manifestBytes);
  let hostBytes: Buffer;
  let shimBytes: Buffer;
  if (
    active?.receipt.version === version &&
    active.receipt.target === target &&
    active.receipt.manifestSha256 === manifestSha &&
    active.receipt.assetSha256 === asset.sha256 &&
    existsSync(hostPath) &&
    existsSync(shimPath)
  ) {
    [hostBytes, shimBytes] = await Promise.all([readFile(hostPath), readFile(shimPath)]);
    if (sha256(hostBytes) !== active.receipt.hostSha256) throw new Error("installed AgentTab host does not match its receipt");
    if (sha256(shimBytes) !== active.receipt.shimSha256) throw new Error("installed AgentTab native shim does not match its receipt");
    await verifyPlatformSignature(hostPath, asset, platform);
    await verifyPlatformSignature(shimPath, asset, platform);
  } else {
    const archive = await fetchBytes(asset.url, development);
    if (archive.byteLength !== asset.bytes) throw new Error(`host asset byte count mismatch: expected ${asset.bytes}, got ${archive.byteLength}`);
    if (sha256(archive) !== asset.sha256) throw new Error("host asset SHA-256 mismatch");
    const extracted = await extractHost(archive, options.dryRun ? tmpdir() : stateDir, platform);
    try {
      hostBytes = extracted.hostBytes;
      shimBytes = extracted.shimBytes;
      await verifyPlatformSignature(join(extracted.tempDir, basename(hostPath)), asset, platform);
      await verifyPlatformSignature(join(extracted.tempDir, basename(shimPath)), asset, platform);
    } finally {
      await rm(extracted.tempDir, { recursive: true, force: true });
    }
  }

  const cliBytes = await readFile(runtime.cliBundlePath);
  const ompBytes = await readFile(runtime.ompBundlePath);
  const cliPath = join(versionRoot, "agenttab-cli.mjs");
  const ompPath = join(versionRoot, "omp.mjs");
  const extensionRoot = join(versionRoot, "extension");
  const extensionPlans = await collectDirectoryPlans(runtime.extensionDir, extensionRoot, "AgentTab extension");
  const cliCommand = platform === "win32" ? join(stateDir, "bin", "agenttab.cmd") : join(stateDir, "bin", "agenttab");
  const wrapper = platform === "win32"
    ? `@\"${process.execPath}\" \"${cliPath}\" %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliPath)} \"$@\"\n`;
  const manifestContent = nativeManifest(shimPath);
  const runtimeConfig = `${JSON.stringify({ schemaVersion: 1, stateDir }, null, 2)}\n`;
  const manifestPaths = nativeManifestPaths(home, stateDir, platform);
  const configPlan = await planClientConfigs({
    home,
    cliPath: cliCommand,
    ompAdapterPath: ompPath,
    platform,
    previousOwnership: active?.receipt.configs,
  });
  const servicePlan = planDaemonService({ platform, home, hostPath, stateDir });
  const artifactFiles: PlannedFile[] = [
    { path: hostPath, content: hostBytes, mode: 0o755, label: "AgentTab host" },
    { path: shimPath, content: shimBytes, mode: 0o755, label: "AgentTab native shim" },
    { path: runtimeConfigPath, content: runtimeConfig, mode: 0o600, label: "AgentTab runtime configuration" },
    { path: cliPath, content: cliBytes, mode: 0o755, label: "AgentTab CLI" },
    { path: ompPath, content: ompBytes, mode: 0o600, label: "AgentTab OMP adapter" },
    ...extensionPlans,
  ];
  const activationFiles: PlannedFile[] = [
    { path: cliCommand, content: wrapper, mode: platform === "win32" ? 0o600 : 0o755, label: "AgentTab command" },
    ...manifestPaths.map((path) => ({
      path,
      content: manifestContent,
      mode: 0o600,
      label: `${identity.product} native host registration`,
      semanticDiff: [
        `--- native host ${identity.nativeHost}`,
        `+++ native host ${identity.nativeHost}`,
        `+path: ${shimPath}`,
        `+allowed_origins: ${[identity.developmentExtension.id, identity.webStoreExtensionId].filter(Boolean).join(", ")}`,
      ].join("\n"),
    })),
    ...(development ? [] : servicePlan.files),
  ];
  const cliSha = sha256(cliBytes);
  const ompSha = sha256(ompBytes);
  const extensionSha = extensionDigest(extensionPlans);
  const installedExtensionVersion = extensionVersion(extensionPlans, extensionRoot);
  const isRepeat = active?.receipt.version === version
    && active.receipt.target === target
    && active.receipt.manifestSha256 === manifestSha
    && active.receipt.assetSha256 === asset.sha256
    && active.receipt.hostSha256 === sha256(hostBytes)
    && active.receipt.shimSha256 === sha256(shimBytes)
    && active.receipt.cliSha256 === cliSha
    && active.receipt.ompSha256 === ompSha
    && active.receipt.extensionSha256 === extensionSha
    && active.receipt.extensionVersion === installedExtensionVersion
    && active.receipt.daemonService.manager === servicePlan.manager
    && active.receipt.daemonService.managed === !development;
  if (active?.receipt.version === version && !isRepeat) {
    throw new Error(`AgentTab ${version} runtime assets do not match its active receipt; use a new signed version`);
  }
  if (isRepeat) {
    const drift = await activeReceiptDrift(active!.receipt, platform);
    if (drift.length > 0) {
      throw new Error(
        `AgentTab ${version} active resources changed after installation: ${drift.join(", ")}`,
      );
    }
    const plannedFiles = [
      ...artifactFiles.map((file) => ({ file, role: "artifact" as const })),
      ...activationFiles.map((file) => ({ file, role: "activation" as const })),
    ];
    if (
      active!.receipt.files.length !== plannedFiles.length
      || active!.receipt.files.some((owned) =>
        !plannedFiles.some((planned) => planned.file.path === owned.path && planned.role === owned.role)
      )
    ) throw new Error(`AgentTab ${version} active receipt file set does not match this installer runtime`);
    for (const { file: planned, role } of plannedFiles) {
      const prior = active!.receipt.files.find((file) => file.role === role && file.path === planned.path);
      if (!prior) throw new Error(`AgentTab ${version} active receipt does not own expected file: ${planned.path}`);
      planned.expectedBefore = {
        exists: true,
        sha256: prior.installedSha256,
        ...(prior.installedMode === undefined ? {} : { mode: prior.installedMode }),
      } satisfies FileExpectation;
    }
  }

  if (active && active.receipt.version !== version) {
    for (const planned of activationFiles) {
      const prior = active.receipt.files.find((file) => file.role === "activation" && file.path === planned.path);
      if (!prior) continue;
      planned.expectedBefore = {
        exists: true,
        sha256: prior.installedSha256,
        ...(prior.installedMode === undefined ? {} : { mode: prior.installedMode }),
      };
      const current = await readOptionalBytes(planned.path);
      const currentMode = current && process.platform !== "win32" ? (await stat(planned.path)).mode & 0o777 : undefined;
      if (
        current === null
        || sha256(current) !== prior.installedSha256
        || (prior.installedMode !== undefined && currentMode !== undefined && prior.installedMode !== currentMode)
      ) {
        throw new Error(`AgentTab activation file changed after ${active.receipt.version}: ${planned.path}`);
      }
    }
  }

  const registry: RegistryOwnership[] = [];
  const registryChanges: Parameters<typeof applyRegistryChanges>[0] = [];
  if (platform === "win32") {
    for (const key of windowsRegistryKeys()) {
      const current = queryRegistryValue(key);
      const prior = active?.receipt.registry.find((entry) => entry.key === key);
      if (active && prior && (current.existed !== true || current.value !== prior.installedValue)) {
        throw new Error(`AgentTab registry value changed after ${active.receipt.version}: ${key}`);
      }
      const installedValue = manifestPaths[0];
      const owned = current.existed !== true || current.value !== installedValue;
      registry.push({ key, installedValue, previous: current, owned });
      if (!isRepeat && owned) registryChanges.push({ key, expected: current, target: { existed: true, value: installedValue } });
    }
  }

  let receiptPath: string;
  let receiptBytes: Buffer;
  let activeBytes: Buffer;
  let receipt: InstallReceiptV2;
  if (isRepeat) {
    receiptPath = active.state.receiptPath;
    receiptBytes = active.bytes;
    activeBytes = canonicalJson(active.state);
    receipt = active.receipt;
  } else {
    receiptPath = newReceiptPath(stateDir, version);
    const previousActive = active?.stateSnapshot ?? { exists: false as const };
    const ownedFiles = await Promise.all([
      ...artifactFiles.map((file) => ownershipForFile(file, "artifact")),
      ...activationFiles.map((file) => ownershipForFile(file, "activation")),
    ]);
    receipt = {
      schemaVersion: 2,
      activationId: basename(receiptPath, ".json"),
      activatedAt: new Date().toISOString(),
      version,
      target,
      platform,
      stateDir,
      home,
      manifestSha256: manifestSha,
      assetSha256: asset.sha256,
      hostSha256: sha256(hostBytes),
      shimSha256: sha256(shimBytes),
      cliSha256: cliSha,
      ompSha256: ompSha,
      extensionSha256: extensionSha,
      extensionVersion: installedExtensionVersion,
      daemonService: { manager: servicePlan.manager, managed: !development },
      previousActive,
      previousReceipt: active ? {
        version: active.state.version,
        receiptPath: active.state.receiptPath,
        receiptSha256: active.state.receiptSha256,
      } : null,
      files: ownedFiles,
      configs: configPlan.ownership,
      registry,
    };
    receiptBytes = canonicalJson(receipt);
    activeBytes = canonicalJson({
      schemaVersion: 1,
      ...referenceForReceipt(version, receiptPath, receiptBytes),
    });
  }

  const files: PlannedFile[] = [
    ...artifactFiles,
    ...activationFiles,
    ...configPlan.files,
    {
      path: receiptPath,
      content: receiptBytes,
      mode: 0o600,
      label: "AgentTab activation receipt",
      expectedBefore: isRepeat
        ? expectationFromSnapshot(active!.receiptSnapshot)
        : { exists: false },
    },
    {
      path: activeStatePath(stateDir),
      content: activeBytes,
      mode: 0o600,
      label: "AgentTab active activation",
      expectedBefore: expectationFromSnapshot(active?.stateSnapshot ?? { exists: false }),
      statePointer: true,
    },
  ];

  await options.beforeTransaction?.();
  let service: InstallResult["service"] = {
    manager: servicePlan.manager,
    status: development ? "shim_fallback" : options.dryRun ? "planned" : "shim_fallback",
    ...(development ? { reason: "development installs use on-demand daemon startup" } : {}),
  };
  const transaction = await applyTransaction(files, {
    dryRun: options.dryRun,
    failAfter: options.transactionFailAfter,
    crashAfter: options.transactionCrashAfter,
    crashAfterExternal: options.transactionCrashAfterExternal,
    printDiff: (diff) => print(diff),
    journal: {
      stateDir,
      operation: options.activation,
      external: registryChangesForJournal(registryChanges),
    },
    applyExternal: registryChanges.length === 0
      ? undefined
      : () => applyRegistryChanges(registryChanges, options.registryFailAfter),
    afterApply: options.dryRun ? undefined : async () => {
      try {
        if (options.verifyReadiness === true) {
          if (options.openBrowser !== false) startBrowser(platform);
          await verifyRuntimeReadiness({ stateDir, home, platform, version });
        }
      } catch (error) {
        if (error instanceof InstallError) throw error;
        const enriched = error as Error & { layer?: string; recovery?: string };
        if (enriched.layer) {
          throw new InstallError(enriched.layer, enriched.message, enriched.recovery ?? `agenttab doctor --layer ${enriched.layer}`);
        }
        throw error;
      }
    },
  });

  if (!development && !options.dryRun) {
    try {
      await activateDaemonService(servicePlan);
      service = { manager: servicePlan.manager, status: "active" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      service = { manager: servicePlan.manager, status: "shim_fallback", reason };
      print(`Could not activate the ${servicePlan.manager} user service; Chrome will start the daemon on demand: ${reason}`);
    }
  }

  for (const skipped of configPlan.skipped) {
    print(`Skipped ${skipped.client} config at ${skipped.path}: ${skipped.reason}`);
  }
  const legacy = detectLegacy(home, platform);
  if (legacy.nativeHostRegistrations.length || legacy.stateArtifacts.length) {
    print(`Chrome Bridge ${legacy.recoveryTag} remains untouched. Prove AgentTab first, then disable extension ${legacy.unpackedExtensionId} manually.`);
  }

  const instructions = [
    "Open chrome://extensions in Chrome.",
    "Enable Developer mode.",
    `Choose Load unpacked and select ${extensionRoot}.`,
    "Confirm that AgentTab is enabled, then run agenttab doctor --layer extension.",
  ];
  let readiness: InstallResult["readiness"];
  let extensionStatus: InstallResult["extension"]["status"];
  if (options.dryRun === true) {
    readiness = { passed: false, skipped: true, reason: "dry_run" };
    extensionStatus = "planned";
  } else if (options.verifyReadiness === true) {
    readiness = { passed: true, skipped: false };
    extensionStatus = "verified";
  } else {
    readiness = { passed: false, skipped: true, reason: "manual_extension_load" };
    extensionStatus = "manual_load_required";
    print(`AgentTab extension setup is required. Load unpacked from ${extensionRoot}`);
    for (const instruction of instructions) print(`  ${instruction}`);
  }
  return {
    version,
    target,
    stateDir,
    transaction,
    skippedConfigs: configPlan.skipped,
    legacy,
    extension: { path: extensionRoot, status: extensionStatus, instructions },
    readiness,
    service,
  };
}

export async function install(options: InstallOptions): Promise<InstallResult> {
  const home = resolve(options.home ?? homedir());
  const stateDir = resolve(options.stateDir ?? join(home, ".agenttab"));
  return withInstallerStateMutation(
    stateDir,
    "install",
    options.dryRun,
    () => installInternal({ ...options, activation: "install" }),
  );
}

export async function update(options: InstallOptions): Promise<InstallResult> {
  const home = resolve(options.home ?? homedir());
  const stateDir = resolve(options.stateDir ?? join(home, ".agenttab"));
  return withInstallerStateMutation(
    stateDir,
    "update",
    options.dryRun,
    () => installInternal({ ...options, activation: "update" }),
  );
}

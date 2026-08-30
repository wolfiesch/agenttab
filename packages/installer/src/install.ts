import { execFile, execFileSync } from "node:child_process";
import { createHash, verify as verifySignature } from "node:crypto";
import {
  chmod,
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
import { setTimeout as delay } from "node:timers/promises";
import { AgentTabClient, AgentTabError, type ConnectionAck } from "../../sdk-typescript/src/index";
import identityJson from "../../../config/identity.json" with { type: "json" };
import trustJson from "../../../config/release-trust.json" with { type: "json" };
import migrationJson from "../../../config/migration-v1.json" with { type: "json" };
import { planClientConfigs } from "./configs";
import { applyTransaction, type PlannedFile, type TransactionResult } from "./transaction";
import { fileURLToPath } from "node:url";

const identity = identityJson as {
  product: string;
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

interface InstallReceipt {
  schemaVersion: 1;
  version: string;
  target: string;
  manifestSha256: string;
  assetSha256: string;
  hostSha256: string;
  cliSha256: string;
  ompSha256: string;
  extensionSha256: string;
}

export interface RuntimeAssets {
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

async function fetchBytes(url: string, development: boolean): Promise<Buffer> {
  if (url.startsWith("file:")) {
    if (!development) throw new Error("file URLs are allowed only for a development install");
    return readFile(fileURLToPath(url));
  }
  if (!url.startsWith("https://")) throw new Error(`installer URL must use HTTPS: ${url}`);
  const response = await fetch(url, { redirect: "error" });
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

function extractWindowsZipHost(archive: Buffer, binaryName: string): Buffer {
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
    entriesOnDisk !== 1 ||
    entries !== 1
  ) {
    throw zipError(`must contain exactly ${binaryName}`);
  }
  if (centralDirectoryOffset + centralDirectorySize !== endOffset) {
    throw zipError("has an invalid central directory");
  }
  const centralOffset = centralDirectoryOffset;
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
  if (centralEnd !== endOffset || memberDisk !== 0) throw zipError("has an invalid central-directory member");
  if ((flags & ~ZIP_UTF8_FLAG) !== 0 || (method !== 0 && method !== 8)) {
    throw zipError("uses unsupported encryption, streaming, or compression");
  }
  if (uncompressedSize === 0 || uncompressedSize > MAX_HOST_EXECUTABLE_BYTES) {
    throw zipError("has an invalid executable size");
  }

  const nameBytes = archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength);
  const name = zipMemberName(nameBytes);
  if (name !== binaryName) throw zipError(`must contain exactly ${binaryName}`);
  assertZipRegularFile(creator, attributes);
  if (localOffset !== 0 || zipUInt32(archive, localOffset) !== ZIP_LOCAL_FILE) {
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
  const dataEnd = dataStart + compressedSize;
  if (
    localFlags !== flags ||
    localMethod !== method ||
    localCrc !== expectedCrc ||
    localCompressedSize !== compressedSize ||
    localUncompressedSize !== uncompressedSize ||
    !localName.equals(nameBytes) ||
    dataEnd !== centralOffset
  ) {
    throw zipError("has inconsistent local-member metadata");
  }

  let executable: Buffer;
  try {
    const data = archive.subarray(dataStart, dataEnd);
    executable = method === 0
      ? Buffer.from(data)
      : inflateRawSync(data, { maxOutputLength: uncompressedSize });
  } catch {
    throw zipError("contains invalid compressed executable data");
  }
  if (executable.byteLength !== uncompressedSize || crc32(executable) !== expectedCrc) {
    throw zipError("contains an invalid executable payload");
  }
  return executable;
}

async function readJsonOptional<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function extractHost(archive: Buffer, stateDir: string, platform: NodeJS.Platform): Promise<{ bytes: Buffer; tempDir: string }> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(join(stateDir, ".install-"));
  const binaryName = platform === "win32" ? "agenttab-host.exe" : "agenttab-host";
  if (platform === "win32") {
    try {
      const hostPath = join(tempDir, binaryName);
      const bytes = extractWindowsZipHost(archive, binaryName);
      await writeFile(hostPath, bytes, { mode: 0o700 });
      await chmod(hostPath, 0o755);
      return { bytes, tempDir };
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
  if (listing.length !== 1 || listing[0] !== binaryName) {
    throw new Error(`host archive must contain exactly ${binaryName}`);
  }
  if (listing.some((name) => name.startsWith("/") || name.split("/").includes(".."))) {
    throw new Error("host archive contains an unsafe path");
  }
  execFileSync("tar", ["-xzf", archivePath, "-C", tempDir]);
  const hostPath = join(tempDir, binaryName);
  const metadata = await stat(hostPath);
  if (!metadata.isFile()) throw new Error("host archive did not extract a regular file");
  await chmod(hostPath, 0o755);
  return { bytes: await readFile(hostPath), tempDir };
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function nativeManifest(hostPath: string): string {
  const extensionIds = [identity.developmentExtension.id, identity.webStoreExtensionId].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return `${JSON.stringify({
    name: identity.nativeHost,
    description: "AgentTab local browser runtime",
    path: hostPath,
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

interface RegistryValue {
  existed: boolean;
  value: string | null;
}

function windowsRegistryKeys(): string[] {
  return [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${identity.nativeHost}`,
    `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${identity.nativeHost}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${identity.nativeHost}`,
  ];
}

function queryRegistryValue(key: string): RegistryValue {
  try {
    const output = execFileSync("reg.exe", ["query", key, "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const match = output.match(/REG_SZ\s+([^\r\n]*)/);
    return { existed: true, value: match?.[1]?.trim() || null };
  } catch {
    return { existed: false, value: null };
  }
}

async function registerWindows(manifestPath: string): Promise<void> {
  const snapshots = new Map<string, RegistryValue>();
  const changed: string[] = [];
  try {
    for (const key of windowsRegistryKeys()) {
      const current = queryRegistryValue(key);
      snapshots.set(key, current);
      if (current.value === manifestPath) continue;
      execFileSync("reg.exe", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { stdio: "pipe" });
      changed.push(key);
    }
  } catch (error) {
    for (const key of changed.reverse()) {
      const previous = snapshots.get(key)!;
      if (!previous.existed) execFileSync("reg.exe", ["delete", key, "/f"], { stdio: "pipe" });
      else if (previous.value === null) execFileSync("reg.exe", ["delete", key, "/ve", "/f"], { stdio: "pipe" });
      else execFileSync("reg.exe", ["add", key, "/ve", "/t", "REG_SZ", "/d", previous.value, "/f"], { stdio: "pipe" });
    }
    throw error;
  }
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

function isRetryableReadinessError(error: unknown): error is AgentTabError {
  return error instanceof AgentTabError
    && error.code === "runtime_not_ready"
    && error.outcome === "not_started";
}

async function runReadiness(openBrowser: boolean, platform: NodeJS.Platform): Promise<void> {
  if (openBrowser) startBrowser(platform);
  const deadline = Date.now() + 20_000;
  let client: AgentTabClient | undefined;
  let connectError: unknown;
  while (Date.now() < deadline) {
    try {
      client = await AgentTabClient.connect({ connectTimeoutMs: 500, requestTimeoutMs: 10_000 });
      break;
    } catch (error) {
      connectError = error;
      await delay(250);
    }
  }
  if (!client) {
    throw new InstallError("ipc", connectError instanceof Error ? connectError.message : "AgentTab host did not become ready", "agenttab doctor --layer ipc");
  }
  let lifecycleState: ConnectionAck["state"] = client.connection.state;
  while (lifecycleState !== "ready" && Date.now() < deadline) {
    try {
      const status = await client.call<"agenttab.status", { state?: unknown }>("agenttab.status", {});
      lifecycleState = typeof status.state === "string"
        ? status.state as ConnectionAck["state"]
        : undefined;
      connectError = new Error(`AgentTab host is ${lifecycleState ?? "in an unknown lifecycle state"}`);
    } catch (error) {
      connectError = error;
    }
    if (lifecycleState !== "ready") await delay(250);
  }
  if (lifecycleState !== "ready") {
    client.close();
    throw new InstallError("ipc", connectError instanceof Error ? connectError.message : "AgentTab host did not become ready", "agenttab doctor --layer ipc");
  }
  let tabId: number | undefined;
  let revision: number | undefined;
  try {
    let opened: Record<string, unknown> | undefined;
    while (opened === undefined && Date.now() < deadline) {
      try {
        opened = await client.call<"browser_open", Record<string, unknown>>(
          "browser_open",
          { mode: "create", url: "about:blank", background: true },
        );
      } catch (error) {
        if (!isRetryableReadinessError(error)) throw error;
        const remaining = deadline - Date.now();
        if (remaining > 0) await delay(Math.min(250, remaining));
      }
    }
    if (opened === undefined) {
      throw new Error("AgentTab extension did not become ready before the readiness deadline");
    }
    tabId = Number(opened.tab_id);
    revision = Number(opened.page_revision);
    if (!Number.isInteger(tabId) || !Number.isInteger(revision)) throw new Error("browser_open did not return tab_id and page_revision");
    const snapshot = await client.call<"browser_snapshot", Record<string, unknown>>(
      "browser_snapshot",
      { tab_id: tabId, mode: "accessibility", max_nodes: 10 },
    );
    const latestRevision = Number(snapshot.page_revision);
    if (Number.isInteger(latestRevision)) revision = latestRevision;
  } catch (error) {
    throw new InstallError("extension", error instanceof Error ? error.message : String(error), "agenttab doctor --layer extension");
  } finally {
    if (tabId !== undefined && revision !== undefined) {
      await client.call("browser_act", {
        tab_id: tabId,
        expected_page_revision: revision,
        actions: [{ kind: "close" }],
      }).catch(() => undefined);
    }
    client.close();
  }
}

function runtimeAssetsFromBundle(): RuntimeAssets {
  const root = dirname(fileURLToPath(import.meta.url));
  return {
    cliBundlePath: join(root, "cli.mjs"),
    ompBundlePath: join(root, "omp.mjs"),
    extensionDir: join(root, "extension"),
  };
}

export async function install(options: InstallOptions): Promise<InstallResult> {
  const version = validVersion(options.version);
  const development = options.development === true;
  const platform = options.platform ?? currentPlatform();
  const target = targetTriple(platform, options.arch ?? currentArch());
  const home = resolve(options.home ?? homedir());
  const stateDir = resolve(options.stateDir ?? join(home, ".agenttab"));
  const print = options.print ?? ((line: string) => console.log(line));
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
  const receiptPath = join(versionRoot, "install-receipt.json");
  const manifestSha = sha256(manifestBytes);
  const priorReceipt = await readJsonOptional<InstallReceipt>(receiptPath);
  let hostBytes: Buffer;
  if (
    priorReceipt?.schemaVersion === 1 &&
    priorReceipt.version === version &&
    priorReceipt.target === target &&
    priorReceipt.manifestSha256 === manifestSha &&
    priorReceipt.assetSha256 === asset.sha256 &&
    existsSync(hostPath)
  ) {
    hostBytes = await readFile(hostPath);
    if (sha256(hostBytes) !== priorReceipt.hostSha256) throw new Error("installed AgentTab host does not match its receipt");
    await verifyPlatformSignature(hostPath, asset, platform);
  } else {
    const archive = await fetchBytes(asset.url, development);
    if (archive.byteLength !== asset.bytes) throw new Error(`host asset byte count mismatch: expected ${asset.bytes}, got ${archive.byteLength}`);
    if (sha256(archive) !== asset.sha256) throw new Error("host asset SHA-256 mismatch");
    const extracted = await extractHost(archive, options.dryRun ? tmpdir() : stateDir, platform);
    try {
      hostBytes = extracted.bytes;
      await verifyPlatformSignature(join(extracted.tempDir, basename(hostPath)), asset, platform);
    } finally {
      await rm(extracted.tempDir, { recursive: true, force: true });
    }
  }

  const runtime = options.runtimeAssets ?? runtimeAssetsFromBundle();
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
  const receipt: InstallReceipt = {
    schemaVersion: 1,
    version,
    target,
    manifestSha256: manifestSha,
    assetSha256: asset.sha256,
    hostSha256: sha256(hostBytes),
    cliSha256: sha256(cliBytes),
    ompSha256: sha256(ompBytes),
    extensionSha256: extensionDigest(extensionPlans),
  };
  const manifestContent = nativeManifest(hostPath);
  const manifestPaths = nativeManifestPaths(home, stateDir, platform);
  const configPlan = await planClientConfigs({ home, cliPath: cliCommand, ompAdapterPath: ompPath, platform });
  const files: PlannedFile[] = [
    { path: hostPath, content: hostBytes, mode: 0o755, label: "AgentTab host" },
    { path: cliPath, content: cliBytes, mode: 0o755, label: "AgentTab CLI" },
    { path: ompPath, content: ompBytes, mode: 0o600, label: "AgentTab OMP adapter" },
    { path: cliCommand, content: wrapper, mode: platform === "win32" ? 0o600 : 0o755, label: "AgentTab command" },
    ...extensionPlans,
    ...manifestPaths.map((path) => ({
      path,
      content: manifestContent,
      mode: 0o600,
      label: `${identity.product} native host registration`,
      semanticDiff: [
        `--- native host ${identity.nativeHost}`,
        `+++ native host ${identity.nativeHost}`,
        `+path: ${hostPath}`,
        `+allowed_origins: ${[identity.developmentExtension.id, identity.webStoreExtensionId].filter(Boolean).join(", ")}`,
      ].join("\n"),
    })),
    ...configPlan.files,
    { path: receiptPath, content: `${JSON.stringify(receipt, null, 2)}\n`, mode: 0o600, label: "AgentTab install receipt" },
  ];

  const transaction = await applyTransaction(files, {
    dryRun: options.dryRun,
    failAfter: options.transactionFailAfter,
    printDiff: (diff) => print(diff),
    afterApply: platform === "win32" ? () => registerWindows(manifestPaths[0]) : undefined,
  });

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
    await runReadiness(options.openBrowser !== false, platform);
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
  };
}

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import trustJson from "../../../config/release-trust.json" with { type: "json" };

const trust = trustJson as { repository: string; stablePublicKeyPem: string | null };
const targets = [
  ["aarch64-apple-darwin", "apple_code_signing", "tar.gz"],
  ["x86_64-apple-darwin", "apple_code_signing", "tar.gz"],
  ["aarch64-unknown-linux-gnu", "signed_manifest", "tar.gz"],
  ["x86_64-unknown-linux-gnu", "signed_manifest", "tar.gz"],
  ["x86_64-pc-windows-msvc", "authenticode", "zip"],
] as const;

function argument(name: string, required = true): string | undefined {
  const index = Bun.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (value?.startsWith("--")) throw new Error(`--${name} requires a value`);
  if (!value && required) throw new Error(`--${name} is required`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("artifact manifest must contain a JSON object");
  }
  return value as Record<string, unknown>;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeSignature(bytes: Buffer): Buffer {
  const encoded = bytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("release signature must be base64");
  }
  const signature = Buffer.from(encoded, "base64");
  if (signature.byteLength !== 64) throw new Error("release signature must contain 64 Ed25519 bytes");
  return signature;
}

const version = argument("version")!;
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("--version must be an exact semantic version");
}
const assetsDir = argument("assets-dir")!;
const verifyOnly = Bun.argv.includes("--verify-only");
const publicKeyPath = argument("public-key", false);
const publicKeyPem = publicKeyPath
  ? await readFile(publicKeyPath, "utf8")
  : trust.stablePublicKeyPem;
if (!publicKeyPem) throw new Error("stable release public key is not configured");



const manifestPath = join(assetsDir, "artifact-manifest.json");
const manifest = await readFile(manifestPath);
const parsed = record(JSON.parse(manifest.toString("utf8")));
if (
  parsed.schemaVersion !== 1
  || parsed.repository !== trust.repository
  || parsed.version !== version
  || parsed.tag !== `v${version}`
  || !Array.isArray(parsed.assets)
  || parsed.assets.length !== targets.length
) {
  throw new Error("artifact manifest identity or target set is invalid");
}
for (const [index, [target, platformSignature, extension]] of targets.entries()) {
  const asset = record(parsed.assets[index]);
  const name = `agenttab-host-v${version}-${target}.${extension}`;
  if (
    asset.name !== name
    || asset.kind !== "host"
    || asset.target !== target
    || asset.platformSignature !== platformSignature
    || asset.url !== `https://github.com/${trust.repository}/releases/download/v${version}/${name}`
  ) {
    throw new Error(`artifact manifest host entry ${index} is invalid`);
  }
  const bytes = await readFile(join(assetsDir, name));
  if (asset.bytes !== bytes.byteLength || asset.sha256 !== digest(bytes)) {
    throw new Error(`artifact manifest digest does not match ${name}`);
  }
}

const checksumsPath = join(assetsDir, "SHA256SUMS");
const checksums = await readFile(checksumsPath);
const checksumEntries = new Map<string, string>();
for (const line of checksums.toString("utf8").trimEnd().split("\n")) {
  const match = /^([0-9a-f]{64})  ([^/]+)$/.exec(line);
  if (!match || checksumEntries.has(match[2])) throw new Error("SHA256SUMS is malformed");
  checksumEntries.set(match[2], match[1]);
}
const files = (await readdir(assetsDir))
  .filter((name) => name !== "SHA256SUMS" && !name.endsWith(".sig"))
  .sort();
if (JSON.stringify([...checksumEntries.keys()].sort()) !== JSON.stringify(files)) {
  throw new Error("SHA256SUMS must cover every unsigned release file exactly once");
}
for (const [name, expectedDigest] of checksumEntries) {
  const metadata = await stat(join(assetsDir, name));
  if (!metadata.isFile() || digest(await readFile(join(assetsDir, name))) !== expectedDigest) {
    throw new Error(`SHA256SUMS does not match ${name}`);
  }
}

const signatureInputs = [
  ["artifact-manifest.json.sig", manifest],
  ["SHA256SUMS.sig", checksums],
] as const;
if (verifyOnly) {
  for (const [name, bytes] of signatureInputs) {
    const signature = decodeSignature(await readFile(join(assetsDir, name)));
    if (!verify(null, bytes, publicKeyPem, signature)) throw new Error(`${name} verification failed`);
  }
  console.log(`Verified AgentTab v${version} manifest and checksum signatures`);
} else {
  const privateKeyPath = argument("private-key")!;
  const privateKey = createPrivateKey(await readFile(privateKeyPath, "utf8"));
  const expectedPublic = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  const actualPublic = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (!actualPublic.equals(expectedPublic)) {
    throw new Error("release private key does not match the frozen release public key");
  }
  for (const [name, bytes] of signatureInputs) {
    const signature = sign(null, bytes, privateKey);
    if (!verify(null, bytes, publicKeyPem, signature)) throw new Error(`${name} self-check failed`);
    await writeFile(join(assetsDir, name), `${signature.toString("base64")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
  }
  console.log(`Signed AgentTab v${version} manifest and checksums for ${targets.length} exact host assets`);
}

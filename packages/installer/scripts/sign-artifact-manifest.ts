import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import trustJson from "../../../config/release-trust.json" with { type: "json" };

const trust = trustJson as { repository: string; stablePublicKeyPem: string | null };
const targets = [
  ["aarch64-apple-darwin", "apple_code_signing"],
  ["x86_64-apple-darwin", "apple_code_signing"],
  ["aarch64-unknown-linux-gnu", "signed_manifest"],
  ["x86_64-unknown-linux-gnu", "signed_manifest"],
  ["aarch64-pc-windows-msvc", "authenticode"],
  ["x86_64-pc-windows-msvc", "authenticode"],
] as const;

function argument(name: string): string {
  const index = Bun.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`--${name} is required`);
  return value;
}

const version = argument("version");
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("--version must be an exact semantic version");
const assetsDir = argument("assets-dir");
const privateKeyPath = argument("private-key");
if (!trust.stablePublicKeyPem) throw new Error("stable release public key is not configured");
const privateKey = createPrivateKey(await readFile(privateKeyPath, "utf8"));
const expectedPublic = createPublicKey(trust.stablePublicKeyPem).export({ type: "spki", format: "der" });
const actualPublic = createPublicKey(privateKey).export({ type: "spki", format: "der" });
if (!actualPublic.equals(expectedPublic)) throw new Error("release private key does not match the frozen stable public key");

const assets = [];
for (const [target, platformSignature] of targets) {
  const name = `agenttab-host-v${version}-${target}.tar.gz`;
  const path = join(assetsDir, name);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`missing release asset ${name}`);
  const bytes = await readFile(path);
  assets.push({
    name,
    kind: "host",
    target,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    platformSignature,
    url: `https://github.com/${trust.repository}/releases/download/v${version}/${name}`,
  });
}
const manifest = Buffer.from(`${JSON.stringify({
  schemaVersion: 1,
  repository: trust.repository,
  version,
  tag: `v${version}`,
  assets,
}, null, 2)}\n`);
const signature = sign(null, manifest, privateKey);
if (!verify(null, manifest, trust.stablePublicKeyPem, signature)) throw new Error("release manifest signature self-check failed");
await writeFile(join(assetsDir, "artifact-manifest.json"), manifest, { mode: 0o644 });
await writeFile(join(assetsDir, "artifact-manifest.json.sig"), `${signature.toString("base64")}\n`, { mode: 0o644 });
console.log(`Signed AgentTab v${version} manifest for ${assets.length} exact host assets`);

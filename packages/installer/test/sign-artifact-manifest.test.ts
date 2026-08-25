import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
const version = "2.0.0-rc.1";
const repository = "wolfiesch/agenttab";
const targets = [
  ["aarch64-apple-darwin", "apple_code_signing", "tar.gz"],
  ["x86_64-apple-darwin", "apple_code_signing", "tar.gz"],
  ["aarch64-unknown-linux-gnu", "signed_manifest", "tar.gz"],
  ["x86_64-unknown-linux-gnu", "signed_manifest", "tar.gz"],
  ["x86_64-pc-windows-msvc", "authenticode", "zip"],
] as const;
const script = join(dirname(fileURLToPath(import.meta.url)), "../scripts/sign-artifact-manifest.ts");

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function runSigner(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const process = Bun.spawn(["bun", "run", script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: await process.exited,
    stderr: await new Response(process.stderr).text(),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("signs and independently verifies the exact release manifest and checksums", async () => {
  const root = await mkdtemp(join(tmpdir(), "agenttab-signing-test-"));
  roots.push(root);
  const assetsDir = join(root, "release");
  await mkdir(assetsDir);

  const assets = [];
  for (const [target, platformSignature, extension] of targets) {
    const name = `agenttab-host-v${version}-${target}.${extension}`;
    const bytes = Buffer.from(`signed-host-fixture:${target}\n`);
    await writeFile(join(assetsDir, name), bytes);
    assets.push({
      name,
      kind: "host",
      target,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      platformSignature,
      url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
    });
  }
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    repository,
    version,
    tag: `v${version}`,
    assets,
  }, null, 2)}\n`);
  await writeFile(join(assetsDir, "artifact-manifest.json"), manifest);
  const unsignedNames = (await readdir(assetsDir)).sort();
  const checksums = Buffer.from((await Promise.all(unsignedNames.map(async (name) => (
    `${sha256(await readFile(join(assetsDir, name)))}  ${name}\n`
  )))).join(""));
  await writeFile(join(assetsDir, "SHA256SUMS"), checksums);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(root, "release-private.pem");
  const publicKeyPath = join(root, "release-public.pem");
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  await writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));

  const signed = await runSigner([
    "--version", version,
    "--assets-dir", assetsDir,
    "--private-key", privateKeyPath,
    "--public-key", publicKeyPath,
  ]);
  expect(signed).toMatchObject({ exitCode: 0, stderr: "" });

  for (const [name, bytes] of [
    ["artifact-manifest.json.sig", manifest],
    ["SHA256SUMS.sig", checksums],
  ] as const) {
    const signature = Buffer.from((await readFile(join(assetsDir, name), "utf8")).trim(), "base64");
    expect(verify(null, bytes, publicKey, signature)).toBe(true);
  }

  const verified = await runSigner([
    "--version", version,
    "--assets-dir", assetsDir,
    "--verify-only",
    "--public-key", publicKeyPath,
  ]);
  expect(verified).toMatchObject({ exitCode: 0, stderr: "" });

  await writeFile(join(assetsDir, assets[0].name), "tampered");
  const rejected = await runSigner([
    "--version", version,
    "--assets-dir", assetsDir,
    "--verify-only",
    "--public-key", publicKeyPath,
  ]);
  expect(rejected.exitCode).not.toBe(0);
  expect(rejected.stderr).toContain(`artifact manifest digest does not match ${assets[0].name}`);
});

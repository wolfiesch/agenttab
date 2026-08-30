import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(packageRoot, "src");
const repoRoot = join(packageRoot, "..", "..");
const identity = JSON.parse(
  await readFile(join(repoRoot, "config", "identity.json"), "utf8"),
) as {
  version: string;
  chromeManifestVersion: string;
  nativeHost: string;
  developmentExtension: { id: string; publicKey: string };
  webStoreExtensionId: string | null;
};
const channel = process.env.AGENTTAB_EXTENSION_CHANNEL ?? "development";
if (channel !== "development" && channel !== "store") {
  throw new Error(`Unsupported AGENTTAB_EXTENSION_CHANNEL: ${channel}`);
}
const extensionIdFromKey = (publicKey: string): string => {
  const alphabet = "abcdefghijklmnop";
  return createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("hex")
    .slice(0, 32)
    .split("")
    .map((nibble) => alphabet[Number.parseInt(nibble, 16)])
    .join("");
};
const derivedDevelopmentId = extensionIdFromKey(identity.developmentExtension.publicKey);
if (derivedDevelopmentId !== identity.developmentExtension.id) {
  throw new Error(
    `Development extension identity mismatch: config has ${identity.developmentExtension.id}, key derives ${derivedDevelopmentId}`,
  );
}
const outputRoot = join(packageRoot, "dist");
const compatibilityFiles = [
  "manifest.json",
  "background.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "wake.html",
  "wake.js",
];
const iconSource = join(sourceRoot, "icons", "icon-source.svg");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const result = await Bun.build({
  entrypoints: [
    join(sourceRoot, "background.ts"),
    join(sourceRoot, "popup.ts"),
    join(sourceRoot, "wake.ts"),
  ],
  outdir: outputRoot,
  target: "browser",
  format: "esm",
  splitting: false,
  sourcemap: "none",
  minify: false,
  naming: "[dir]/[name].[ext]",
  define: {
    AGENTTAB_NATIVE_HOST: JSON.stringify(identity.nativeHost),
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const name of ["manifest.json", "popup.html", "popup.css", "wake.html"]) {
  await writeFile(join(outputRoot, name), await readFile(join(sourceRoot, name)));
}
await mkdir(join(outputRoot, "icons"), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await cp(join(sourceRoot, "icons", `icon${size}.png`), join(outputRoot, "icons", `icon${size}.png`));
}

const manifest = JSON.parse(await readFile(join(outputRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
if (packageManifest.version !== identity.version) {
  throw new Error(`Extension package version must match frozen identity ${identity.version}`);
}
if (manifest.version !== identity.chromeManifestVersion || manifest.version_name !== identity.version) {
  throw new Error(`Extension manifest versions must be ${identity.chromeManifestVersion} / ${identity.version}`);
}
if (channel === "development") {
  manifest.key = identity.developmentExtension.publicKey;
} else {
  if (!identity.webStoreExtensionId) {
    throw new Error("Store extension build requires config/identity.json webStoreExtensionId");
  }
  delete manifest.key;
}
const required = ["nativeMessaging", "debugger", "tabs", "tabGroups", "storage", "alarms", "downloads"];
const optional = ["scripting"];
const forbiddenKeys = ["content_scripts", "web_accessible_resources", "externally_connectable", "side_panel", "commands"];
for (const key of forbiddenKeys) {
  if (key in manifest) throw new Error(`Forbidden manifest surface: ${key}`);
}
if (JSON.stringify(manifest.permissions) !== JSON.stringify(required)) {
  throw new Error(`Required permission drift: ${JSON.stringify(manifest.permissions)}`);
}
if (JSON.stringify(manifest.optional_permissions) !== JSON.stringify(optional)) {
  throw new Error(`Optional permission drift: ${JSON.stringify(manifest.optional_permissions)}`);
}
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(["<all_urls>"])) {
  throw new Error(`Host permission drift: ${JSON.stringify(manifest.host_permissions)}`);
}
await writeFile(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

for (const output of result.outputs) {
  const source = await output.text();
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source)) {
    throw new Error(`Dynamic code execution found in ${basename(output.path)}`);
  }
}
if (channel === "development") {
  const extensionMirror = join(repoRoot, "extension");
  await rm(extensionMirror, { recursive: true, force: true });
  await mkdir(extensionMirror, { recursive: true });
  await rm(join(repoRoot, "icons"), { recursive: true, force: true });
  for (const root of [repoRoot, extensionMirror]) {
    for (const name of compatibilityFiles) {
      await cp(join(outputRoot, name), join(root, name));
    }
    await cp(join(outputRoot, "icons"), join(root, "icons"), { recursive: true });
    await cp(iconSource, join(root, "icons", "icon-source.svg"));
  }
}

console.log(
  `Built AgentTab ${channel} extension ${String(manifest.version)} for ${channel === "development" ? identity.developmentExtension.id : identity.webStoreExtensionId
  } at ${outputRoot}`,
);

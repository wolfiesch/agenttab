import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const packageRoot = new URL("..", import.meta.url).pathname;
const sourceRoot = join(packageRoot, "src");
const outputRoot = join(packageRoot, "dist");

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
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const name of ["manifest.json", "popup.html", "popup.css", "wake.html"]) {
  await writeFile(join(outputRoot, name), await readFile(join(sourceRoot, name)));
}
await cp(join(sourceRoot, "icons"), join(outputRoot, "icons"), { recursive: true });

const manifest = JSON.parse(await readFile(join(outputRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
const required = ["nativeMessaging", "tabs", "tabGroups", "storage", "alarms", "downloads"];
const optional = ["scripting", "debugger"];
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

for (const output of result.outputs) {
  const source = await output.text();
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source)) {
    throw new Error(`Dynamic code execution found in ${basename(output.path)}`);
  }
}

console.log(`Built AgentTab extension ${String(manifest.version)} at ${outputRoot}`);

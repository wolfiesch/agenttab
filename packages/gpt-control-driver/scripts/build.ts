#!/usr/bin/env bun
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(root, "dist");
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "src", "driver.ts")],
  outdir: outputDirectory,
  naming: "driver.mjs",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await chmod(join(outputDirectory, "driver.mjs"), 0o755);
console.log(`Built AgentTab GPT-Control driver at ${join(outputDirectory, "driver.mjs")}`);

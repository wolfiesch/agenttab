import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packagesRoot = join(root, "..");
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const extensionBuild = Bun.spawn([
  process.execPath,
  "run",
  "--cwd",
  join(packagesRoot, "extension"),
  "build",
], { stdout: "inherit", stderr: "inherit" });
if (await extensionBuild.exited !== 0) process.exit(1);

const [cli, omp] = await Promise.all([
  Bun.build({
    entrypoints: [join(root, "src", "cli.ts")],
    outdir: dist,
    naming: "cli.mjs",
    target: "node",
    format: "esm",
    minify: false,
    sourcemap: "none",
    banner: "#!/usr/bin/env node",
  }),
  Bun.build({
    entrypoints: [join(packagesRoot, "omp", "src", "index.ts")],
    outdir: dist,
    naming: "omp.mjs",
    target: "node",
    format: "esm",
    minify: false,
    sourcemap: "none",
  }),
]);
for (const result of [cli, omp]) {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}
await chmod(join(dist, "cli.mjs"), 0o755);
await cp(join(packagesRoot, "extension", "dist"), join(dist, "extension"), { recursive: true });
console.log(`Built AgentTab installer at ${dist}`);

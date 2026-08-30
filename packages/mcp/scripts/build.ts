import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "dist", "server.mjs");
await rm(join(root, "dist"), { recursive: true, force: true });
await mkdir(join(root, "dist"), { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "src", "cli.ts")],
  outdir: join(root, "dist"),
  naming: "server.mjs",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
  banner: "#!/usr/bin/env node",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await chmod(output, 0o755);
console.log(`Built agenttab-mcp at ${output}`);

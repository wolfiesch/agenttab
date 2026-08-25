import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "dist", "index.mjs");
await rm(join(root, "dist"), { recursive: true, force: true });
await mkdir(join(root, "dist"), { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "src", "index.ts")],
  outdir: join(root, "dist"),
  naming: "index.mjs",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`Built AgentTab OMP adapter at ${output}`);

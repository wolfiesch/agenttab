import { copyFile, mkdir, rm } from "node:fs/promises";

const packageRoot = new URL("../", import.meta.url);
const sourceRoot = new URL("src/", packageRoot);
const outputRoot = new URL("dist/", packageRoot);
const staticFiles = ["index.html", "privacy/index.html", "support/index.html", "styles.css"] as const;

await rm(outputRoot, { recursive: true, force: true });

for (const file of staticFiles) {
  const output = new URL(file, outputRoot);
  await mkdir(new URL(".", output), { recursive: true });
  await copyFile(new URL(file, sourceRoot), output);
}

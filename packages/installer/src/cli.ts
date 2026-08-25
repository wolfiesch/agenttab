import { readFile } from "node:fs/promises";
import { AgentTabClient } from "../../sdk-typescript/src/index";
import { main as mcpMain } from "../../mcp/src/server";
import packageJson from "../package.json" with { type: "json" };
import { install, InstallError } from "./install";
import { runProxy } from "./proxy";

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals >= 0) {
      flags.set(value.slice(2, equals), value.slice(equals + 1));
      continue;
    }
    const name = value.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  return value;
}

function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

function usage(): never {
  console.error([
    "Usage:",
    "  agenttab install [--version X.Y.Z] [--verify-readiness] [--development --manifest-url URL --signature-url URL]",
    "  agenttab status",
    "  agenttab doctor [--layer ipc|extension]",
    "  agenttab mcp",
    "  agenttab proxy --token-file PATH [--port 9224]",
  ].join("\n"));
  process.exit(2);
}

async function status(): Promise<unknown> {
  const client = await AgentTabClient.connect();
  try {
    return await client.call("agenttab.status", {});
  } finally {
    client.close();
  }
}

async function run(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.positional[0];
  if (!command) usage();

  if (command === "mcp") {
    await mcpMain();
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify(await status(), null, 2));
    return;
  }
  if (command === "doctor") {
    const layer = stringFlag(parsed, "layer") ?? "ipc";
    if (layer !== "ipc" && layer !== "extension") throw new Error("--layer must be ipc or extension");
    try {
      const result = await status();
      console.log(JSON.stringify({ success: true, layer, result }, null, 2));
    } catch (error) {
      console.log(JSON.stringify({
        success: false,
        layer,
        error: error instanceof Error ? error.message : String(error),
        recovery: layer === "ipc"
          ? "Open Chrome with the AgentTab extension enabled, then rerun agenttab doctor --layer ipc."
          : "Reload AgentTab in chrome://extensions, then rerun agenttab doctor --layer extension.",
      }, null, 2));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "proxy") {
    const tokenFile = stringFlag(parsed, "token-file");
    if (!tokenFile) throw new Error("agenttab proxy requires --token-file");
    const portValue = stringFlag(parsed, "port");
    await runProxy({
      tokenFile,
      ...(portValue ? { port: Number(portValue) } : {}),
    });
    return;
  }
  if (command === "install") {
    const development = boolFlag(parsed, "development");
    const publicKeyPath = stringFlag(parsed, "public-key");
    if (publicKeyPath && !development) throw new Error("--public-key is allowed only with --development");
    const result = await install({
      version: stringFlag(parsed, "version") ?? packageJson.version,
      development,
      manifestUrl: stringFlag(parsed, "manifest-url"),
      signatureUrl: stringFlag(parsed, "signature-url"),
      stateDir: stringFlag(parsed, "state-dir"),
      home: stringFlag(parsed, "home"),
      publicKeyPem: publicKeyPath ? await readFile(publicKeyPath, "utf8") : undefined,
      dryRun: boolFlag(parsed, "dry-run"),
      verifyReadiness: boolFlag(parsed, "verify-readiness"),
      openBrowser: !boolFlag(parsed, "no-open-browser"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  usage();
}

try {
  await run();
} catch (error) {
  if (error instanceof InstallError) {
    console.error(JSON.stringify({ success: false, layer: error.layer, error: error.message, recovery: error.recovery }, null, 2));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}

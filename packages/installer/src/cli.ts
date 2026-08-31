import { readFile } from "node:fs/promises";
import { AgentTabClient } from "../../sdk-typescript/src/index";
import { main as mcpMain } from "../../mcp/src/server";
import packageJson from "../package.json" with { type: "json" };
import { install, InstallError, update, type InstallOptions } from "./install";
import { doctor, prune, rollback, uninstall, type DoctorLayer, type LifecycleOptions } from "./lifecycle";
import { runProxy } from "./proxy";

interface ParsedArgs {
  flags: Map<string, string | true>;
}

type FlagKind = "boolean" | "string";

const ARTIFACT_FLAGS: Readonly<Record<string, FlagKind>> = {
  development: "boolean",
  "dry-run": "boolean",
  home: "string",
  "manifest-url": "string",
  "no-open-browser": "boolean",
  "public-key": "string",
  "signature-url": "string",
  "state-dir": "string",
  "verify-readiness": "boolean",
  version: "string",
};

const LIFECYCLE_FLAGS: Readonly<Record<string, FlagKind>> = {
  "dry-run": "boolean",
  home: "string",
  "state-dir": "string",
};

const COMMAND_FLAGS: Record<string, Readonly<Record<string, FlagKind>>> = {
  install: ARTIFACT_FLAGS,
  update: ARTIFACT_FLAGS,
  rollback: LIFECYCLE_FLAGS,
  uninstall: LIFECYCLE_FLAGS,
  prune: { ...LIFECYCLE_FLAGS, keep: "string" },
  status: {},
  doctor: { home: "string", layer: "string", "state-dir": "string" },
  mcp: {},
  proxy: { port: "string", "token-file": "string" },
};

function parseArgs(command: string, args: string[]): ParsedArgs {
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) throw new Error(`Unknown command: ${command}`);
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      throw new Error(`Unexpected argument for agenttab ${command}: ${value}`);
    }
    const equals = value.indexOf("=");
    const name = value.slice(2, equals >= 0 ? equals : undefined);
    const kind = allowed[name];
    if (!name || !kind) throw new Error(`Unknown option for agenttab ${command}: --${name}`);
    if (flags.has(name)) throw new Error(`Duplicate option for agenttab ${command}: --${name}`);
    if (kind === "boolean") {
      if (equals >= 0) throw new Error(`--${name} does not take a value`);
      flags.set(name, true);
      continue;
    }
    const inlineValue = equals >= 0 ? value.slice(equals + 1) : undefined;
    const next = inlineValue ?? args[index + 1];
    if (!next || (inlineValue === undefined && next.startsWith("--"))) {
      throw new Error(`--${name} requires a value`);
    }
    flags.set(name, next);
    if (inlineValue === undefined) index += 1;
  }
  return { flags };
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  return value;
}

function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

const USAGE = [
  "Usage:",
  "  agenttab --help",
  "  agenttab --version",
  "  agenttab install [--version X.Y.Z] [--verify-readiness] [--development --manifest-url URL --signature-url URL]",
  "  agenttab update --version X.Y.Z [--verify-readiness]",
  "  agenttab rollback [--dry-run]",
  "  agenttab uninstall [--dry-run]",
  "  agenttab prune [--keep N] [--dry-run]",
  "  agenttab status",
  "  agenttab doctor [--layer installation|ipc|protocol|host|extension|all]",
  "  agenttab mcp",
  "  agenttab proxy --token-file PATH [--port 9224]",
].join("\n");

function usage(exitCode: 0 | 2 = 2): never {
  if (exitCode === 0) console.log(USAGE);
  else console.error(USAGE);
  process.exit(exitCode);
}

async function status(): Promise<unknown> {
  const client = await AgentTabClient.connect();
  try {
    return await client.call("agenttab.status", {});
  } finally {
    client.close();
  }
}

function lifecycleOptions(parsed: ParsedArgs): LifecycleOptions {
  return {
    stateDir: stringFlag(parsed, "state-dir"),
    home: stringFlag(parsed, "home"),
    dryRun: boolFlag(parsed, "dry-run"),
  };
}

async function artifactOptions(parsed: ParsedArgs, requireVersion: boolean): Promise<InstallOptions> {
  const development = boolFlag(parsed, "development");
  const publicKeyPath = stringFlag(parsed, "public-key");
  if (publicKeyPath && !development) throw new Error("--public-key is allowed only with --development");
  const version = stringFlag(parsed, "version");
  if (requireVersion && !version) throw new Error("agenttab update requires an exact --version X.Y.Z");
  return {
    version: version ?? packageJson.version,
    development,
    manifestUrl: stringFlag(parsed, "manifest-url"),
    signatureUrl: stringFlag(parsed, "signature-url"),
    stateDir: stringFlag(parsed, "state-dir"),
    home: stringFlag(parsed, "home"),
    publicKeyPem: publicKeyPath ? await readFile(publicKeyPath, "utf8") : undefined,
    dryRun: boolFlag(parsed, "dry-run"),
    verifyReadiness: boolFlag(parsed, "verify-readiness"),
    openBrowser: !boolFlag(parsed, "no-open-browser"),
  };
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--help") usage(0);
  if (argv.length === 1 && argv[0] === "--version") {
    console.log(packageJson.version);
    return;
  }
  const command = argv[0];
  if (!command) usage();
  if (command.startsWith("--")) throw new Error(`Unknown global option: ${command}`);
  if (!COMMAND_FLAGS[command]) throw new Error(`Unknown command: ${command}`);
  if (argv.length === 2 && argv[1] === "--help") usage(0);
  const parsed = parseArgs(command, argv.slice(1));

  if (command === "mcp") {
    await mcpMain();
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify(await status(), null, 2));
    return;
  }
  if (command === "doctor") {
    const layer = stringFlag(parsed, "layer") ?? "all";
    if (!["installation", "ipc", "protocol", "host", "extension", "all"].includes(layer)) {
      throw new Error("--layer must be installation, ipc, protocol, host, extension, or all");
    }
    const result = await doctor({
      stateDir: stringFlag(parsed, "state-dir"),
      home: stringFlag(parsed, "home"),
      layer: layer as DoctorLayer | "all",
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exitCode = 1;
    return;
  }
  if (command === "proxy") {
    const tokenFile = stringFlag(parsed, "token-file");
    if (!tokenFile) throw new Error("agenttab proxy requires --token-file");
    const portValue = stringFlag(parsed, "port");
    if (portValue !== undefined && (!/^\d+$/.test(portValue) || Number(portValue) > 65_535)) {
      throw new Error("--port must be an integer from 0 to 65535");
    }
    await runProxy({
      tokenFile,
      ...(portValue ? { port: Number(portValue) } : {}),
    });
    return;
  }
  if (command === "install" || command === "update") {
    const options = await artifactOptions(parsed, command === "update");
    console.log(JSON.stringify(command === "install" ? await install(options) : await update(options), null, 2));
    return;
  }
  if (command === "rollback") {
    console.log(JSON.stringify(await rollback(lifecycleOptions(parsed)), null, 2));
    return;
  }
  if (command === "uninstall") {
    console.log(JSON.stringify(await uninstall(lifecycleOptions(parsed)), null, 2));
    return;
  }
  if (command === "prune") {
    const keepValue = stringFlag(parsed, "keep");
    if (keepValue !== undefined && !/^\d+$/.test(keepValue)) throw new Error("--keep must be a non-negative integer");
    console.log(JSON.stringify(await prune({ ...lifecycleOptions(parsed), ...(keepValue ? { keep: Number(keepValue) } : {}) }), null, 2));
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

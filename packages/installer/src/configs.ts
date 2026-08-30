import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDocument, isSeq } from "yaml";
import type { PlannedFile } from "./transaction";

export interface ConfigPlan {
  files: PlannedFile[];
  skipped: Array<{ client: string; path: string; reason: string }>;
}

interface JsonClient {
  client: string;
  path: string;
}

function configExistsOrClientInstalled(path: string): boolean {
  return existsSync(path) || existsSync(dirname(path));
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function jsonClients(home: string, currentPlatform: NodeJS.Platform): JsonClient[] {
  const claude = currentPlatform === "darwin"
    ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : currentPlatform === "win32"
      ? join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json")
      : join(home, ".config", "Claude", "claude_desktop_config.json");
  return [
    { client: "Claude Desktop", path: claude },
    { client: "Cursor", path: join(home, ".cursor", "mcp.json") },
    { client: "Windsurf", path: join(home, ".codeium", "windsurf", "mcp_config.json") },
    { client: "stdio MCP", path: join(home, ".config", "mcp", "mcp.json") },
  ];
}

function parseJsonConfig(source: string | null): Record<string, unknown> {
  if (source === null) return {};
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("top level must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function planJsonClient(
  spec: JsonClient,
  cliPath: string,
): Promise<PlannedFile | { reason: string } | null> {
  if (!configExistsOrClientInstalled(spec.path)) return null;
  const source = await readText(spec.path);
  let config: Record<string, unknown>;
  try {
    config = parseJsonConfig(source);
  } catch (error) {
    return { reason: `malformed JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const current = config.mcpServers;
  if (current !== undefined && (typeof current !== "object" || current === null || Array.isArray(current))) {
    return { reason: "mcpServers must be a JSON object" };
  }
  const servers = (current ?? {}) as Record<string, unknown>;
  servers.agenttab = { command: cliPath, args: ["mcp"] };
  config.mcpServers = servers;
  return {
    path: spec.path,
    content: `${JSON.stringify(config, null, 2)}\n`,
    mode: 0o600,
    label: `${spec.client} config`,
    semanticDiff: [
      `--- ${spec.client}: mcpServers.agenttab`,
      `+++ ${spec.client}: mcpServers.agenttab`,
      `+command: ${cliPath}`,
      "+args: [mcp]",
    ].join("\n"),
  };
}

async function planOmp(home: string, adapterPath: string): Promise<PlannedFile | { path: string; reason: string } | null> {
  const path = process.env.OMP_AGENT_HOME
    ? join(process.env.OMP_AGENT_HOME, "config.yml")
    : join(home, ".omp", "agent", "config.yml");
  if (!configExistsOrClientInstalled(path)) return null;
  const source = await readText(path);
  const document = parseDocument(source ?? "{}\n");
  if (document.errors.length > 0) {
    return { path, reason: `malformed YAML: ${document.errors[0].message}` };
  }
  const extensions = document.get("extensions", true);
  if (extensions !== undefined && !isSeq(extensions)) {
    return { path, reason: "extensions must be a YAML sequence" };
  }
  const values = isSeq(extensions) ? extensions.items.map((item) => String(item)) : [];
  if (!values.includes(adapterPath)) values.push(adapterPath);
  document.set("extensions", values);
  return {
    path,
    content: document.toString(),
    mode: 0o600,
    label: "OMP config",
    semanticDiff: [
      "--- OMP: extensions",
      "+++ OMP: extensions",
      `+${adapterPath}`,
    ].join("\n"),
  };
}

export async function planClientConfigs(options: {
  home: string;
  cliPath: string;
  ompAdapterPath: string;
  platform?: NodeJS.Platform;
}): Promise<ConfigPlan> {
  const files: PlannedFile[] = [];
  const skipped: ConfigPlan["skipped"] = [];
  for (const spec of jsonClients(options.home, options.platform ?? process.platform)) {
    const planned = await planJsonClient(spec, options.cliPath);
    if (!planned) continue;
    if ("reason" in planned) {
      skipped.push({ client: spec.client, path: spec.path, reason: planned.reason });
    } else {
      files.push(planned);
    }
  }
  const omp = await planOmp(options.home, options.ompAdapterPath);
  if (omp) {
    if ("reason" in omp) skipped.push({ client: "OMP", path: omp.path, reason: omp.reason });
    else files.push(omp);
  }
  return { files, skipped };
}

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseDocument, isSeq } from "yaml";
import { expectationFor, type PlannedFile } from "./transaction";

export interface ConfigPlan {
  files: PlannedFile[];
  ownership: ConfigOwnership[];
  skipped: Array<{ client: string; path: string; reason: string }>;
}

export interface JsonConfigOwnership {
  kind: "json_property";
  client: string;
  path: string;
  property: ["mcpServers", "agenttab"];
  installedValue: unknown;
  previous: { exists: false } | { exists: true; value: unknown };
  owned: boolean;
}

export interface YamlConfigOwnership {
  kind: "yaml_sequence_item";
  client: "OMP";
  path: string;
  property: "extensions";
  value: string;
  installedPresent: boolean;
  previousPresent: boolean;
  owned: boolean;
}

export type ConfigOwnership = JsonConfigOwnership | YamlConfigOwnership;

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

async function textExpectation(path: string, source: string | null) {
  if (source === null) return expectationFor(null);
  const mode = process.platform === "win32" ? undefined : (await stat(path)).mode & 0o777;
  return expectationFor(Buffer.from(source, "utf8"), mode);
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
  previousOwnership: ConfigOwnership[],
): Promise<{ file: PlannedFile | null; ownership: JsonConfigOwnership } | { reason: string; ownership?: JsonConfigOwnership } | null> {
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
  const previous = Object.prototype.hasOwnProperty.call(servers, "agenttab")
    ? { exists: true as const, value: structuredClone(servers.agenttab) }
    : { exists: false as const };
  const previousValue = previous.exists ? previous.value : undefined;
  const installedValue = { command: cliPath, args: ["mcp"] };
  const prior = previousOwnership.find((entry): entry is JsonConfigOwnership =>
    entry.kind === "json_property" && entry.path === spec.path
  );
  if (prior && JSON.stringify(previousValue) !== JSON.stringify(prior.installedValue)) {
    return {
      reason: "mcpServers.agenttab changed after the previous AgentTab activation",
      ownership: { ...prior, previous, owned: false },
    };
  }
  const owned = JSON.stringify(previousValue) !== JSON.stringify(installedValue);
  servers.agenttab = installedValue;
  config.mcpServers = servers;
  return {
    file: owned ? {
      path: spec.path,
      content: `${JSON.stringify(config, null, 2)}\n`,
      mode: 0o600,
      label: `${spec.client} config`,
      expectedBefore: await textExpectation(spec.path, source),
      semanticDiff: [
        `--- ${spec.client}: mcpServers.agenttab`,
        `+++ ${spec.client}: mcpServers.agenttab`,
        `+command: ${cliPath}`,
        "+args: [mcp]",
      ].join("\n"),
    } : null,
    ownership: {
      kind: "json_property",
      client: spec.client,
      path: spec.path,
      property: ["mcpServers", "agenttab"],
      installedValue,
      previous,
      owned,
    },
  };
}

async function planOmp(
  home: string,
  adapterPath: string,
  previousOwnership: ConfigOwnership[],
): Promise<{ file: PlannedFile | null; ownership: YamlConfigOwnership[] } | { path: string; reason: string } | null> {
  const path = process.env.OMP_AGENT_HOME
    ? resolve(process.env.OMP_AGENT_HOME, "config.yml")
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
  const originalValues = [...values];
  const ownership: YamlConfigOwnership[] = [];
  for (const prior of previousOwnership) {
    if (
      prior.kind !== "yaml_sequence_item" ||
      prior.path !== path ||
      !prior.owned ||
      !prior.installedPresent ||
      prior.value === adapterPath
    ) continue;
    const matching = values.filter((value) => value === prior.value).length;
    if (matching !== 1) continue;
    const index = values.indexOf(prior.value);
    values.splice(index, 1);
    ownership.push({
      kind: "yaml_sequence_item",
      client: "OMP",
      path,
      property: "extensions",
      value: prior.value,
      installedPresent: false,
      previousPresent: true,
      owned: true,
    });
  }
  const previousPresent = values.includes(adapterPath);
  if (!previousPresent) values.push(adapterPath);
  ownership.push({
    kind: "yaml_sequence_item",
    client: "OMP",
    path,
    property: "extensions",
    value: adapterPath,
    installedPresent: true,
    previousPresent,
    owned: !previousPresent,
  });
  document.set("extensions", values);
  return {
    file: JSON.stringify(values) === JSON.stringify(originalValues) ? null : {
      path,
      content: document.toString(),
      mode: 0o600,
      label: "OMP config",
      expectedBefore: await textExpectation(path, source),
      semanticDiff: [
        "--- OMP: extensions",
        "+++ OMP: extensions",
        ...ownership.filter((entry) => entry.owned).map((entry) => `${entry.installedPresent ? "+" : "-"}${entry.value}`),
      ].join("\n"),
    },
    ownership,
  };
}

export async function planClientConfigs(options: {
  home: string;
  cliPath: string;
  ompAdapterPath: string;
  platform?: NodeJS.Platform;
  previousOwnership?: ConfigOwnership[];
}): Promise<ConfigPlan> {
  const files: PlannedFile[] = [];
  const ownership: ConfigOwnership[] = [];
  const skipped: ConfigPlan["skipped"] = [];
  const previousOwnership = options.previousOwnership ?? [];
  for (const spec of jsonClients(options.home, options.platform ?? process.platform)) {
    const planned = await planJsonClient(spec, options.cliPath, previousOwnership);
    if (!planned) continue;
    if ("reason" in planned) {
      skipped.push({ client: spec.client, path: spec.path, reason: planned.reason });
      if (planned.ownership) ownership.push(planned.ownership);
    } else {
      if (planned.file) files.push(planned.file);
      ownership.push(planned.ownership);
    }
  }
  const omp = await planOmp(options.home, options.ompAdapterPath, previousOwnership);
  if (omp) {
    if ("reason" in omp) skipped.push({ client: "OMP", path: omp.path, reason: omp.reason });
    else {
      if (omp.file) files.push(omp.file);
      ownership.push(...omp.ownership);
    }
  }
  return { files, ownership, skipped };
}

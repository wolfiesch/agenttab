import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { PlannedFile } from "./transaction";

export type DaemonServiceManager = "launchd" | "systemd" | "scheduled_task";

export interface DaemonServiceCommand {
  executable: string;
  args: string[];
  ignoreFailure?: boolean;
}

export interface DaemonServicePlan {
  manager: DaemonServiceManager;
  files: PlannedFile[];
  commands: DaemonServiceCommand[];
}

interface PlanOptions {
  platform: NodeJS.Platform;
  home: string;
  hostPath: string;
  stateDir: string;
  userId?: number;
}

function rejectControlCharacters(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("daemon service paths must not contain control characters");
  return value;
}

function xmlEscape(value: string): string {
  return rejectControlCharacters(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  return `"${rejectControlCharacters(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")}"`;
}

function windowsTaskCommand(hostPath: string): string {
  const path = rejectControlCharacters(hostPath);
  if (path.includes('"')) throw new Error("Windows daemon path must not contain a quote");
  return `"${path}" daemon`;
}

export function planDaemonService(options: PlanOptions): DaemonServicePlan {
  if (options.platform === "darwin") {
    const label = "dev.agenttab.daemon";
    const path = join(options.home, "Library", "LaunchAgents", `${label}.plist`);
    const domain = `gui/${options.userId ?? process.getuid?.() ?? 0}`;
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEscape(options.hostPath)}</string><string>daemon</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>AGENTTAB_STATE_DIR</key><string>${xmlEscape(options.stateDir)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>1</integer>
</dict>
</plist>
`;
    return {
      manager: "launchd",
      files: [{ path, content, mode: 0o600, label: "AgentTab launchd agent" }],
      commands: [
        { executable: "launchctl", args: ["bootout", `${domain}/${label}`], ignoreFailure: true },
        { executable: "launchctl", args: ["bootstrap", domain, path] },
        { executable: "launchctl", args: ["kickstart", "-k", `${domain}/${label}`] },
      ],
    };
  }

  if (options.platform === "win32") {
    const task = "AgentTab Daemon";
    return {
      manager: "scheduled_task",
      files: [],
      commands: [
        { executable: "schtasks.exe", args: ["/End", "/TN", task], ignoreFailure: true },
        {
          executable: "schtasks.exe",
          args: [
            "/Create", "/TN", task, "/SC", "ONLOGON", "/TR", windowsTaskCommand(options.hostPath),
            "/RL", "LIMITED", "/F",
          ],
        },
        { executable: "schtasks.exe", args: ["/Run", "/TN", task] },
      ],
    };
  }

  if (options.platform !== "linux") throw new Error(`unsupported daemon service platform: ${options.platform}`);
  const path = join(options.home, ".config", "systemd", "user", "agenttab.service");
  const content = `[Unit]
Description=AgentTab per-user browser runtime

[Service]
Type=simple
ExecStart=${systemdQuote(options.hostPath)} daemon
Environment=${systemdQuote(`AGENTTAB_STATE_DIR=${options.stateDir}`)}
Restart=on-failure
RestartSec=1

[Install]
WantedBy=default.target
`;
  return {
    manager: "systemd",
    files: [{ path, content, mode: 0o600, label: "AgentTab systemd user service" }],
    commands: [
      { executable: "systemctl", args: ["--user", "daemon-reload"] },
      { executable: "systemctl", args: ["--user", "enable", "--now", "agenttab.service"] },
      { executable: "systemctl", args: ["--user", "restart", "agenttab.service"] },
    ],
  };
}

export async function activateDaemonService(plan: DaemonServicePlan): Promise<void> {
  for (const command of plan.commands) {
    try {
      execFileSync(command.executable, command.args, { stdio: "pipe", env: { ...process.env } });
    } catch (error) {
      if (!command.ignoreFailure) throw error;
    }
  }
}

export function daemonServiceDeactivationCommands(
  plan: DaemonServicePlan,
): DaemonServiceCommand[] {
  if (plan.manager === "launchd") {
    const bootout = plan.commands.find((command) => command.executable === "launchctl" && command.args[0] === "bootout");
    if (!bootout) throw new Error("launchd service plan has no bootout command");
    return [{ ...bootout, ignoreFailure: true }];
  }
  if (plan.manager === "scheduled_task") {
    return [
      { executable: "schtasks.exe", args: ["/End", "/TN", "AgentTab Daemon"], ignoreFailure: true },
      { executable: "schtasks.exe", args: ["/Delete", "/TN", "AgentTab Daemon", "/F"], ignoreFailure: true },
    ];
  }
  return [
    { executable: "systemctl", args: ["--user", "disable", "--now", "agenttab.service"] },
    { executable: "systemctl", args: ["--user", "daemon-reload"] },
  ];
}

export async function deactivateDaemonService(plan: DaemonServicePlan): Promise<void> {
  await activateDaemonService({ ...plan, commands: daemonServiceDeactivationCommands(plan) });
}

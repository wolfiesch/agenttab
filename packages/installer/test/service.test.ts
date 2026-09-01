import { describe, expect, test } from "bun:test";
import { daemonServiceDeactivationCommands, planDaemonService } from "../src/service";

describe("persistent daemon service plans", () => {
  test("uses a restartable per-user systemd service without privilege escalation", () => {
    const plan = planDaemonService({
      platform: "linux",
      home: "/home/agent user",
      hostPath: "/home/agent user/.agenttab/agenttab-host",
      stateDir: "/home/agent user/.agenttab",
    });
    expect(plan.manager).toBe("systemd");
    expect(plan.files[0].path).toBe("/home/agent user/.config/systemd/user/agenttab.service");
    expect(String(plan.files[0].content)).toContain('ExecStart="/home/agent user/.agenttab/agenttab-host" daemon');
    expect(String(plan.files[0].content)).toContain("Restart=on-failure");
    expect(plan.commands.map((command) => [command.executable, ...command.args])).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "agenttab.service"],
      ["systemctl", "--user", "restart", "agenttab.service"],
    ]);
  });

  test("uses a KeepAlive launch agent in the current GUI domain", () => {
    const plan = planDaemonService({
      platform: "darwin",
      home: "/Users/test",
      hostPath: "/Users/test/Agent & Tab/agenttab-host",
      stateDir: "/Users/test/.agenttab",
      userId: 501,
    });
    expect(plan.manager).toBe("launchd");
    expect(String(plan.files[0].content)).toContain("<key>KeepAlive</key><true/>");
    expect(String(plan.files[0].content)).toContain("Agent &amp; Tab");
    expect(plan.commands[0]).toEqual({
      executable: "launchctl",
      args: ["bootout", "gui/501/dev.agenttab.daemon"],
      ignoreFailure: true,
    });
    expect(plan.commands.at(-1)?.args).toEqual(["kickstart", "-k", "gui/501/dev.agenttab.daemon"]);
  });

  test("uses a current-user limited scheduled task and restarts it on upgrade", () => {
    const plan = planDaemonService({
      platform: "win32",
      home: "C:\\Users\\test",
      hostPath: "C:\\Users\\test\\AgentTab\\agenttab-host.exe",
      stateDir: "C:\\Users\\test\\AgentTab",
    });
    expect(plan.manager).toBe("scheduled_task");
    expect(plan.commands[0]).toMatchObject({
      executable: "schtasks.exe",
      args: ["/End", "/TN", "AgentTab Daemon"],
      ignoreFailure: true,
    });
    expect(plan.commands[1].args).toContain("LIMITED");
    expect(plan.commands[1].args).toContain('"C:\\Users\\test\\AgentTab\\agenttab-host.exe" daemon');
    expect(plan.commands[2].args).toEqual(["/Run", "/TN", "AgentTab Daemon"]);
    expect(daemonServiceDeactivationCommands(plan).map((command) => command.args[0])).toEqual(["/End", "/Delete"]);
  });

  test("stops and disables the user service during uninstall", () => {
    const plan = planDaemonService({
      platform: "linux",
      home: "/home/test",
      hostPath: "/home/test/.agenttab/agenttab-host",
      stateDir: "/home/test/.agenttab",
    });
    expect(daemonServiceDeactivationCommands(plan)).toEqual([
      { executable: "systemctl", args: ["--user", "disable", "--now", "agenttab.service"] },
      { executable: "systemctl", args: ["--user", "daemon-reload"] },
    ]);
  });

  test("rejects service-definition injection", () => {
    expect(() => planDaemonService({
      platform: "linux",
      home: "/home/test",
      hostPath: "/home/test/host\nExecStart=/tmp/evil",
      stateDir: "/home/test/.agenttab",
    })).toThrow("control characters");
    expect(() => planDaemonService({
      platform: "win32",
      home: "C:\\Users\\test",
      hostPath: 'C:\\bad" /RU SYSTEM',
      stateDir: "C:\\Users\\test\\AgentTab",
    })).toThrow("must not contain a quote");
  });
});

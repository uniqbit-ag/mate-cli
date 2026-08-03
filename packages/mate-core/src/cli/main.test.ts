import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { resetActiveDistribution, setActiveDistribution } from "../distribution";
import * as updateChecker from "../lib/update-checker";
import type { Plugin, PluginCliCommand } from "../tools/setup/plugin";
import { PluginRegistry } from "../tools/setup/registry";
import * as artifactCmd from "./commands/artifact/artifact";
import * as capCmd from "./commands/cap";
import * as companionCmd from "./commands/companion/companion";
import * as configCmd from "./commands/config";
import * as doctorCmd from "./commands/doctor";
import * as installCmd from "./commands/install";
import * as claudeCmd from "./commands/launch/claude";
import * as opencodeCmd from "./commands/launch/opencode";
import * as pluginCmd from "./commands/plugin/plugin";
import * as reportCmd from "./commands/report";
import * as updateCmd from "./commands/update";
import { main, type MainDeps } from "./main";

const BUILT_IN_COMMANDS = [
  "install",
  "plugin",
  "artifact",
  "companion",
  "claude",
  "opencode",
  "report",
  "config",
  "doctor",
  "cap",
  "update",
];

describe("command gating", () => {
  const dispatched: string[] = [];
  const spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    dispatched.length = 0;
    const record = (name: string) => async () => {
      dispatched.push(name);
    };
    spies.push(
      spyOn(updateCmd, "runUpdateCommand").mockImplementation(record("update")),
      spyOn(doctorCmd, "runDoctorCommand").mockImplementation(record("doctor")),
      spyOn(companionCmd, "runCompanionCommand").mockImplementation(record("companion")),
      spyOn(configCmd, "runConfigCommand").mockImplementation(record("config")),
      spyOn(reportCmd, "runReportCommand").mockImplementation(record("report")),
      spyOn(claudeCmd, "runLaunchClaudeCommand").mockImplementation(record("claude")),
      spyOn(opencodeCmd, "runLaunchOpenCodeCommand").mockImplementation(record("opencode")),
      spyOn(artifactCmd, "runArtifactCommand").mockImplementation(record("artifact")),
      spyOn(capCmd, "runCapCommand").mockImplementation(record("cap")),
      spyOn(installCmd, "runInstallCommand").mockImplementation(async () => {
        dispatched.push("install");
        return true;
      }),
      spyOn(pluginCmd, "runPluginCommand").mockImplementation(record("plugin")),
      spyOn(updateChecker, "scheduleBackgroundCheck").mockImplementation(() => {}),
      spyOn(updateChecker, "showUpdateBannerIfAvailable").mockImplementation(async () => {}),
      spyOn(updateChecker, "enforceUpdateIfRequired").mockImplementation(async () => false),
    );
  });

  afterEach(() => {
    while (spies.length > 0) spies.pop()?.mockRestore();
  });

  function recordingDeps(overrides: { companion?: boolean; installOk?: boolean } = {}) {
    const gateCalls: string[] = [];
    const deps: MainDeps = {
      ensureUnambiguousCompanion: async () => {
        gateCalls.push("companion");
        return overrides.companion ?? true;
      },
      inspectInstallPreflight: async () => {
        gateCalls.push("install");
        return overrides.installOk === false
          ? { ok: false, reason: "test preflight" }
          : { ok: true };
      },
      hydrateDynamicPlugins: async () => {},
    };
    return { gateCalls, deps };
  }

  test("every built-in command dispatches through its declared gates", async () => {
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    try {
      for (const command of BUILT_IN_COMMANDS) {
        const { deps } = recordingDeps();
        await main(["node", "mate", command], deps);
      }
      expect([...dispatched].sort()).toEqual([...BUILT_IN_COMMANDS].sort());
      expect(errors.filter((line) => line.startsWith("Unknown command"))).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("update and doctor dispatch without companion selection or install preflight", async () => {
    for (const command of ["update", "doctor"]) {
      const { gateCalls, deps } = recordingDeps({ companion: false, installOk: false });
      await main(["node", "mate", command], deps);
      expect(gateCalls).toEqual([]);
    }
    expect(dispatched).toEqual(["update", "doctor"]);
  });

  test("companion setup, link, list, and unknown subcommands dispatch without companion selection or preflight", async () => {
    for (const subcommand of ["setup", "link", "list", "nope"]) {
      const { gateCalls, deps } = recordingDeps({ companion: false, installOk: false });
      await main(["node", "mate", "companion", subcommand], deps);
      expect(gateCalls).toEqual([]);
    }
    expect(dispatched).toEqual(["companion", "companion", "companion", "companion"]);
  });

  test("companion open and tui require an unambiguous companion but no install", async () => {
    const originalExitCode = process.exitCode;
    try {
      for (const subcommand of ["open", "tui"]) {
        const { gateCalls, deps } = recordingDeps({ companion: false });
        process.exitCode = 0;
        await main(["node", "mate", "companion", subcommand], deps);
        expect(gateCalls).toEqual(["companion"]);
        expect(process.exitCode).toBe(1);
      }
      expect(dispatched).toEqual([]);
    } finally {
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test("launch commands run companion selection before the install preflight", async () => {
    const { gateCalls, deps } = recordingDeps();
    await main(["node", "mate", "claude"], deps);
    expect(gateCalls).toEqual(["companion", "install"]);
    expect(dispatched).toEqual(["claude"]);
  });

  test("an ambiguous companion still blocks launch commands", async () => {
    const originalExitCode = process.exitCode;
    try {
      const { gateCalls, deps } = recordingDeps({ companion: false });
      process.exitCode = 0;
      await main(["node", "mate", "claude"], deps);
      expect(gateCalls).toEqual(["companion"]);
      expect(dispatched).toEqual([]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test("an unknown command fails fast before any gate", async () => {
    const originalExitCode = process.exitCode;
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    try {
      const { gateCalls, deps } = recordingDeps();
      process.exitCode = 0;
      await main(["node", "mate", "foobbar"], deps);
      expect(errors[0]).toBe("Unknown command: foobbar");
      expect(gateCalls).toEqual([]);
      expect(dispatched).toEqual([]);
      expect(process.exitCode).toBe(1);
    } finally {
      errorSpy.mockRestore();
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test("config and companion list dispatch when installation is incomplete", async () => {
    for (const argv of [["config"], ["companion", "list"]]) {
      const { gateCalls, deps } = recordingDeps({ installOk: false });
      await main(["node", "mate", ...argv], deps);
      expect(gateCalls).not.toContain("install");
    }
    expect(dispatched).toEqual(["config", "companion"]);
  });

  test("report is blocked when installation is incomplete", async () => {
    const originalExitCode = process.exitCode;
    try {
      const { gateCalls, deps } = recordingDeps({ installOk: false });
      process.exitCode = 0;
      await main(["node", "mate", "report"], deps);
      expect(gateCalls).toEqual(["install"]);
      expect(dispatched).toEqual([]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test("install-gated commands are blocked when installation is incomplete", async () => {
    const originalExitCode = process.exitCode;
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    try {
      const { gateCalls, deps } = recordingDeps({ installOk: false });
      process.exitCode = 0;
      await main(["node", "mate", "claude"], deps);
      expect(gateCalls).toEqual(["companion", "install"]);
      expect(dispatched).toEqual([]);
      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toContain("install");
    } finally {
      errorSpy.mockRestore();
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test("an enforced update still blocks normal commands", async () => {
    const originalExitCode = process.exitCode;
    const enforce = spyOn(updateChecker, "enforceUpdateIfRequired").mockImplementation(
      async () => true,
    );
    spies.push(enforce);
    try {
      const { gateCalls, deps } = recordingDeps();
      process.exitCode = 0;
      await main(["node", "mate", "report"], deps);
      expect(process.exitCode).toBe(1);
      expect(gateCalls).toEqual([]);
      expect(dispatched).toEqual([]);
    } finally {
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test("recovery commands bypass an enforced update", async () => {
    const enforce = spyOn(updateChecker, "enforceUpdateIfRequired").mockImplementation(
      async () => true,
    );
    spies.push(enforce);
    const { deps } = recordingDeps();
    await main(["node", "mate", "update"], deps);
    await main(["node", "mate", "companion", "setup"], deps);
    expect(enforce).not.toHaveBeenCalled();
    expect(dispatched).toEqual(["update", "companion"]);
  });

  test("help and version bypass every gate", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const { gateCalls, deps } = recordingDeps({ companion: false, installOk: false });
      for (const command of ["help", "--help", "-h"]) {
        await main(["node", "mate", command], deps);
      }
      await main(["node", "mate", "--version"], deps);
      expect(gateCalls).toEqual([]);
      expect(dispatched).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("plugin CLI commands", () => {
  const okDeps: MainDeps = {
    ensureUnambiguousCompanion: async () => true,
    inspectInstallPreflight: async () => ({ ok: true }),
    hydrateDynamicPlugins: async () => {},
  };

  function makePlugin(id: string, cliCommands?: PluginCliCommand[], cliNamespace?: string): Plugin {
    return {
      id,
      kind: "capability",
      label: id,
      description: "",
      defaultSelected: false,
      isEnabled: () => true,
      async apply() {},
      async teardown() {},
      cliCommands,
      cliNamespace,
    };
  }

  function activate(...plugins: Plugin[]): void {
    setActiveDistribution({
      config: { runtime: "bun", version: "1.0.0" },
      registry: new PluginRegistry(plugins),
    });
  }

  afterEach(() => {
    resetActiveDistribution();
  });

  test("dispatches `<distribution> cap <pluginId> <name>` to the plugin's run with remaining argv", async () => {
    const received: string[][] = [];
    activate(
      makePlugin("acme", [
        {
          name: "mcp",
          description: "Start the acme MCP server.",
          run: async (argv) => {
            received.push(argv);
          },
        },
      ]),
    );

    await main(["node", "mate", "cap", "acme", "mcp", "--flag"], okDeps);

    expect(received).toEqual([["--flag"]]);
  });

  test("cliNamespace overrides the plugin id as the cap namespace", async () => {
    const originalExitCode = process.exitCode;
    const received: string[][] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    activate(
      makePlugin(
        "acme-discovery",
        [
          {
            name: "mcp",
            description: "Start the MCP server.",
            run: async (argv) => {
              received.push(argv);
            },
          },
        ],
        "acme",
      ),
    );

    try {
      await main(["node", "mate", "cap", "acme", "mcp"], okDeps);
      expect(received).toEqual([[]]);

      await main(["node", "mate", "cap", "acme-discovery", "mcp"], okDeps);
      expect(received).toEqual([[]]);
      expect(process.exitCode).toBe(1);
    } finally {
      stderrSpy.mockRestore();
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test("a plugin without cliCommands does not claim a cap namespace", async () => {
    const originalExitCode = process.exitCode;
    const writes: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    activate(makePlugin("acme"));

    try {
      await main(["node", "mate", "cap", "acme", "mcp"], okDeps);
      expect(writes.join("")).toContain("unknown capability command: acme");
      expect(process.exitCode).toBe(1);
    } finally {
      stderrSpy.mockRestore();
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test("an unknown subcommand under a plugin namespace fails and lists the available commands", async () => {
    const originalExitCode = process.exitCode;
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    activate(
      makePlugin("acme", [
        { name: "mcp", description: "Start the acme MCP server.", run: async () => {} },
      ]),
    );

    try {
      await main(["node", "mate", "cap", "acme", "nope"], okDeps);
      expect(errors[0]).toBe("Unknown command: cap acme nope");
      expect(errors[1]).toContain("mate cap acme mcp");
      expect(process.exitCode).toBe(1);
    } finally {
      errorSpy.mockRestore();
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test("plugin commands are not mounted at the top level and cannot shadow framework commands", async () => {
    const originalExitCode = process.exitCode;
    const received: string[][] = [];
    const logs: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    activate(
      makePlugin("acme", [
        {
          name: "help",
          description: "Plugin-owned help.",
          run: async (argv) => {
            received.push(argv);
          },
        },
      ]),
    );

    try {
      await main(["node", "mate", "help"], okDeps);
      expect(received).toEqual([]);
      expect(logs.length).toBeGreaterThan(0);

      await main(["node", "mate", "acme", "help"], okDeps);
      expect(received).toEqual([]);
      expect(process.exitCode).toBe(1);

      await main(["node", "mate", "cap", "acme", "help"], okDeps);
      expect(received).toEqual([[]]);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = originalExitCode ?? 0;
    }
  });
});

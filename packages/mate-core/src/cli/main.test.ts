import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { resetActiveDistribution, setActiveDistribution } from "../distribution";
import type { Plugin, PluginCliCommand } from "../tools/setup/plugin";
import { PluginRegistry } from "../tools/setup/registry";
import { isInstallRecoveryCommand, main, type MainDeps } from "./main";

describe("isInstallRecoveryCommand", () => {
  test("keeps install lifecycle recovery commands available", () => {
    expect(isInstallRecoveryCommand("install")).toBe(true);
    expect(isInstallRecoveryCommand("update")).toBe(true);
    expect(isInstallRecoveryCommand("doctor")).toBe(true);
    expect(isInstallRecoveryCommand("--help")).toBe(true);
    expect(isInstallRecoveryCommand("companion", "setup")).toBe(true);
    expect(isInstallRecoveryCommand("companion", "link")).toBe(true);
  });

  test("does not exempt normal commands", () => {
    expect(isInstallRecoveryCommand("report")).toBe(false);
    expect(isInstallRecoveryCommand("cap", "index")).toBe(false);
  });

  test("selects a companion before normal command install preflight", async () => {
    const originalExitCode = process.exitCode;
    let selected = false;
    let preflightSawSelection = false;

    try {
      await main(["node", "mate", "report"], {
        ensureUnambiguousCompanion: async () => {
          selected = true;
          return true;
        },
        inspectInstallPreflight: async () => {
          preflightSawSelection = selected;
          return { ok: false, reason: "test preflight" };
        },
      });
    } finally {
      process.exitCode = originalExitCode ?? 0;
    }

    expect(preflightSawSelection).toBe(true);
    expect(process.exitCode).toBe(originalExitCode ?? 0);
  });

  test("recovery commands still run when the version guard reports an unsatisfied engines.mate", async () => {
    const originalExitCode = process.exitCode;
    const engineGuardFailure = {
      ok: false,
      reason:
        "This companion requires mate-cli >=99.0.0, but 0.14.3 is installed. Run `mate update`.",
    };
    let preflightCalls = 0;
    const deps = {
      ensureUnambiguousCompanion: async () => true,
      inspectInstallPreflight: async () => {
        preflightCalls++;
        return engineGuardFailure;
      },
    };
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await main(["node", "mate", "doctor"], deps);
    } finally {
      logSpy.mockRestore();
      process.exitCode = originalExitCode ?? 0;
    }

    expect(preflightCalls).toBe(0);
    expect(process.exitCode).toBe(originalExitCode ?? 0);
  });

  test("help/--help/-h bypass the version guard entirely", async () => {
    const originalExitCode = process.exitCode;
    let preflightCalls = 0;
    const deps = {
      ensureUnambiguousCompanion: async () => true,
      inspectInstallPreflight: async () => {
        preflightCalls++;
        return { ok: false, reason: "engines.mate mismatch" };
      },
    };
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await main(["node", "mate", "help"], deps);
      await main(["node", "mate", "--help"], deps);
      await main(["node", "mate", "-h"], deps);
    } finally {
      logSpy.mockRestore();
      process.exitCode = originalExitCode ?? 0;
    }

    expect(preflightCalls).toBe(0);
    expect(process.exitCode).toBe(originalExitCode ?? 0);
  });
});

describe("plugin CLI commands", () => {
  const okDeps: MainDeps = {
    ensureUnambiguousCompanion: async () => true,
    inspectInstallPreflight: async () => ({ ok: true }),
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
      config: { name: "acme-mate", runtime: "bun", version: "1.0.0" },
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
      expect(errors[1]).toContain("acme-mate cap acme mcp");
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

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createTempDir } from "../../../../../test/fixtures";
import { resetActiveDistribution, setActiveDistribution } from "../../distribution";
import type { launchAgent } from "../../lib/triage/launch";
import { launchedTriageSessionDir, triageRoot } from "../../lib/triage/session";
import { appendEvent, appendReport } from "../../runtime/friction-log";
import { PluginRegistry } from "../../tools/setup/registry";
import * as doctorCmd from "./doctor";
import { runTriageCommand, type TriageDeps } from "./triage";

const roots: string[] = [];
let out: string[];
let err: string[];
const spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  setActiveDistribution({
    config: { runtime: "bun", version: "1.2.3" },
    registry: new PluginRegistry([]),
  });
  out = [];
  err = [];
  spies.push(
    spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.join(" "));
    }),
    spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      err.push(args.join(" "));
    }),
  );
});

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
  resetActiveDistribution();
  process.exitCode = 0;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function setup(installed: string[]) {
  const root = await createTempDir("mate-triage-command-");
  roots.push(root);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const name of installed) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
  }
  const launches: Array<Parameters<typeof launchAgent>[0]> = [];
  const deps: TriageDeps = {
    cwd: root,
    env: { HOME: path.join(root, "home"), PATH: bin },
    ask: null,
    collectDoctor: async () => ({ kind: "core" }),
    launch: async (options) => {
      launches.push(options);
      return 3;
    },
  };
  return { root, deps, launches };
}

describe("mate triage", () => {
  test("--no-launch prints the session paths, starts nothing and exits zero", async () => {
    const { deps, launches } = await setup(["claude"]);

    await runTriageCommand(["--no-launch"], deps);

    expect(launches).toEqual([]);
    expect(process.exitCode || 0).toBe(0);
    const printed = out.join("\n");
    for (const file of ["context.md", "PLAYBOOK.md", "prompt.md"]) {
      const line = printed.split("\n").find((entry) => entry.endsWith(file));
      expect(line && fs.existsSync(line.split(": ").at(-1)!.trim())).toBe(true);
    }
  });

  test("collects the doctor report without repairing the repository link", async () => {
    const { deps } = await setup([]);
    const doctor = spyOn(doctorCmd, "collectDoctorReport").mockImplementation(
      async () => ({}) as doctorCmd.DoctorReport,
    );
    spies.push(doctor);

    await runTriageCommand(["--no-launch"], { ...deps, collectDoctor: undefined });

    expect(doctor).toHaveBeenCalledWith(expect.objectContaining({ write: false }));
  });

  test("starts the only installed agent in the session folder and ends with its exit code", async () => {
    const { deps, launches } = await setup(["claude"]);

    await runTriageCommand([], deps);

    expect(launches).toHaveLength(1);
    expect(launches[0]!.agent).toBe("claude");
    expect(fs.existsSync(path.join(launches[0]!.sessionDir, "PLAYBOOK.md"))).toBe(true);
    expect(process.exitCode).toBe(3);
  });

  test("lets the agent's commands use the session folder only while the agent runs", async () => {
    const { deps } = await setup(["claude"]);
    const launched = (dir: string) =>
      launchedTriageSessionDir(dir, {
        homeDir: deps.env!.HOME,
        isAncestor: (pid) => pid === process.pid,
      });
    let dir = "";
    let during: string | null = null;

    await runTriageCommand([], {
      ...deps,
      launch: async (options) => {
        dir = options.sessionDir;
        during = launched(dir);
        return 0;
      },
    });

    expect(during).toBe(fs.realpathSync(dir));
    expect(launched(dir)).toBeNull();
  });

  test("starts no agent inside an agent session and exits zero", async () => {
    const { deps, launches } = await setup(["claude"]);

    await runTriageCommand([], { ...deps, env: { ...deps.env, CLAUDE_CODE_SESSION_ID: "s1" } });

    expect(launches).toEqual([]);
    expect(process.exitCode || 0).toBe(0);
    expect(out.join("\n")).toContain("in your own terminal");
  });

  test("starts the agent named by --agent", async () => {
    const { deps, launches } = await setup(["claude", "opencode"]);

    await runTriageCommand(["--agent", "opencode"], deps);

    expect(launches.map((launch) => launch.agent)).toEqual(["opencode"]);
  });

  test("fails when the requested agent is not installed", async () => {
    const { deps, launches } = await setup(["claude"]);

    await runTriageCommand(["--agent=opencode"], deps);

    expect(launches).toEqual([]);
    expect(err.join("\n")).toContain("OpenCode was not found");
    expect(process.exitCode).toBe(1);
  });

  test("asks in the terminal when both agents are installed", async () => {
    const { deps, launches } = await setup(["claude", "opencode"]);
    const asked: string[][] = [];

    await runTriageCommand([], {
      ...deps,
      ask: async (choices) => {
        asked.push(choices);
        return "opencode";
      },
    });

    expect(asked).toEqual([["claude", "opencode"]]);
    expect(launches.map((launch) => launch.agent)).toEqual(["opencode"]);
  });

  test("names --agent when both are installed and no terminal can ask", async () => {
    const { deps, launches } = await setup(["claude", "opencode"]);

    await runTriageCommand([], deps);

    expect(launches).toEqual([]);
    expect(err.join("\n")).toContain("--agent claude or --agent opencode");
    expect(process.exitCode).toBe(1);
  });

  test("prints the paths and exits non-zero when no agent is installed", async () => {
    const { deps, launches } = await setup([]);

    await runTriageCommand([], deps);

    expect(launches).toEqual([]);
    expect(out.join("\n")).toContain("prompt.md");
    expect(err.join("\n")).toContain("No agent was found");
    expect(process.exitCode).toBe(1);
  });

  describe("with a Triage Target", () => {
    const fingerprint = "command:artifact submit:1";

    function recordEvent(home: string, companion: string) {
      return appendEvent(
        {
          kind: "command-failure",
          fingerprint,
          mateVersion: "1.2.3",
          runtime: "claude",
          sessionId: "s1",
          companion,
          repositoryPath: null,
          detail: {},
        },
        { homeDir: home },
      )!;
    }

    function recordReport(home: string, companion: string, eventId: string | null) {
      return appendReport(
        {
          eventId,
          kind: "bug",
          cost: null,
          subject: "acme",
          expected: "acme",
          evidence: null,
          workaround: null,
          mateVersion: "1.2.3",
          companion,
          sessionId: null,
          runtime: null,
        },
        { homeDir: home },
      );
    }

    test("starts a session from a recorded fingerprint", async () => {
      const { deps, root } = await setup([]);
      recordEvent(deps.env!.HOME!, root);

      await runTriageCommand([fingerprint, "--no-launch"], deps);

      expect(process.exitCode || 0).toBe(0);
      const context = out
        .find((line) => line.trim().startsWith("context:"))!
        .split(": ")
        .at(-1)!;
      const text = fs.readFileSync(context.trim(), "utf8");
      expect(text).toContain(`Triage Target: \`${fingerprint}\``);
      expect(text).toContain(`Invoked as: \`mate triage "${fingerprint}" --no-launch\``);
    });

    test("inside an agent session, names the target in the command to run", async () => {
      const { deps, root } = await setup(["claude"]);
      recordEvent(deps.env!.HOME!, root);

      await runTriageCommand([fingerprint], {
        ...deps,
        env: { ...deps.env, CLAUDE_CODE_SESSION_ID: "s1" },
      });

      expect(out.join("\n")).toContain(`Run \`mate triage "${fingerprint}"\` in your own terminal`);
    });

    test("finds a Free Report by its id in upper case", async () => {
      const { deps, root } = await setup([]);
      const report = recordReport(deps.env!.HOME!, root, null);

      await runTriageCommand([report.id.toUpperCase(), "--no-launch"], deps);

      expect(err).toEqual([]);
      expect(process.exitCode || 0).toBe(0);
    });

    test("refuses an unknown target, writes no session and prunes none", async () => {
      const { deps } = await setup([]);
      const old = path.join(triageRoot(deps.env!.HOME), "2020-01-01T00-00-00-000Z");
      fs.mkdirSync(old, { recursive: true });

      await runTriageCommand(["refusal:acme:none", "--no-launch"], deps);

      expect(err.join("\n")).toContain("refusal:acme:none");
      expect(process.exitCode).toBe(1);
      expect(fs.readdirSync(triageRoot(deps.env!.HOME))).toEqual([path.basename(old)]);
    });

    test("refuses a report on an event and names its fingerprint", async () => {
      const { deps, root } = await setup([]);
      const home = deps.env!.HOME!;
      const event = recordEvent(home, root);
      const report = recordReport(home, root, event.id);

      await runTriageCommand([report.id, "--no-launch"], deps);

      expect(err.join("\n")).toContain(`fingerprint ${fingerprint}. Triage that fingerprint`);
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(triageRoot(home))).toBe(false);
    });

    test("refuses an empty target with the usage", async () => {
      const { deps } = await setup([]);

      await runTriageCommand([""], deps);

      expect(err.join("\n")).toContain("the Triage Target is empty");
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(triageRoot(deps.env!.HOME))).toBe(false);
    });

    test("refuses two targets with the usage", async () => {
      const { deps } = await setup([]);

      await runTriageCommand(["refusal:artifact:write", "refusal:secret:read"], deps);

      expect(err.join("\n")).toContain("Usage:");
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(triageRoot(deps.env!.HOME))).toBe(false);
    });
  });

  test("refuses an unknown agent before writing a session", async () => {
    const { deps, root } = await setup(["claude"]);

    await runTriageCommand(["--agent", "acme"], deps);

    expect(err.join("\n")).toContain("--agent must be one of: claude, opencode");
    expect(fs.existsSync(path.join(root, "home"))).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});

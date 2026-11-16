import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createTempDir } from "../../../../../test/fixtures";
import { resetActiveDistribution, setActiveDistribution } from "../../distribution";
import type { launchAgent } from "../../lib/triage/launch";
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

  test("refuses an unknown agent before writing a session", async () => {
    const { deps, root } = await setup(["claude"]);

    await runTriageCommand(["--agent", "acme"], deps);

    expect(err.join("\n")).toContain("--agent must be one of: claude, opencode");
    expect(fs.existsSync(path.join(root, "home"))).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});

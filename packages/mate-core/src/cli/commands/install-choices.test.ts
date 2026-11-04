import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { createMate } from "../../create-mate";
import { resetActiveDistribution } from "../../distribution";
import { runInstallPlan } from "../../lib/install";
import { MemberChoicesStore } from "../../lib/member-choices";
import type { CapabilityPlugin } from "../../tools/setup/plugin";
import { parseMemberChoiceFlags, runInstallCommand } from "./install";

/** A capability whose tool the companion recommends, installed into memory. */
function recommendedTool() {
  const state = { installed: false, installs: 0 };
  const plugin: CapabilityPlugin = {
    id: "acme-tool",
    kind: "capability",
    label: "Acme Tool",
    description: "A recommended tool.",
    defaultSelected: false,
    isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "acme-tool"),
    getInstallRequirements: () => [
      {
        id: "capability:acme-tool",
        label: "Acme Tool CLI",
        group: "companion",
        source: "Acme capability",
        command: "install acme-tool",
        recommendedBy: ["acme-tool"],
        detect: () => state.installed,
        install: async () => {
          state.installs += 1;
          state.installed = true;
        },
      },
    ],
    async apply() {},
    async teardown() {},
  };
  return { plugin, state };
}

describe("mate install and the companion's recommended tools", () => {
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
  const originalExitCode = process.exitCode;
  let home: string;
  let companion: string;
  let store: MemberChoicesStore;
  let output: string[];
  let originalLog: typeof console.log;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "mate-install-choices-"));
    process.env.HOME = home;
    // Bun itself satisfies the core requirement, so nothing real is installed.
    process.env.PATH = path.dirname(process.execPath);
    companion = path.join(home, "companion");
    await fs.mkdir(path.join(companion, ".mate", "config"), { recursive: true });
    await fs.writeFile(
      path.join(companion, ".mate", "config", "framework.yaml"),
      "type: companion\nallowedAgents: []\ncapabilities:\n  - name: acme-tool\n",
    );
    process.env.MATE_ARTIFACT_PATH = companion;
    process.exitCode = 0;
    store = new MemberChoicesStore(path.join(home, ".mate", "member-choices.yaml"));
    output = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output.push(args.join(" "));
    };
  });

  afterEach(async () => {
    console.log = originalLog;
    resetActiveDistribution();
    process.exitCode = originalExitCode;
    await fs.rm(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalArtifactPath === undefined) delete process.env.MATE_ARTIFACT_PATH;
    else process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
  });

  function useDistribution(plugin: CapabilityPlugin): void {
    createMate({ config: { runtime: "bun", version: "1.0.0" }, plugins: [plugin] });
  }

  test("--yes alone does not install a recommended tool and says how to get it", async () => {
    const { plugin, state } = recommendedTool();
    useDistribution(plugin);

    expect(await runInstallCommand(["--yes"], companion, { memberChoicesStore: store })).toBe(true);

    expect(state.installs).toBe(0);
    expect(output.join("\n")).toContain("Acme Tool: not chosen yet");
    expect(output.join("\n")).toContain("mate install --with acme-tool");
    expect(await store.read(companion)).toEqual({});
  });

  test("--with installs a recommended tool and remembers the choice", async () => {
    const { plugin, state } = recommendedTool();
    useDistribution(plugin);

    await runInstallCommand(["--yes", "--with", "acme-tool"], companion, {
      memberChoicesStore: store,
    });

    expect(state.installs).toBe(1);
    expect(await store.read(companion)).toEqual({ "acme-tool": "accepted" });
  });

  test("a terminal asks once; a declined tool is neither installed nor asked about again", async () => {
    const { plugin, state } = recommendedTool();
    useDistribution(plugin);
    const confirm = mock(async () => false);
    const deps = {
      memberChoicesStore: store,
      confirm,
      isTTY: true,
      renderExecution: (plan: Parameters<typeof runInstallPlan>[0]) => runInstallPlan(plan),
    };

    expect(await runInstallCommand([], companion, deps)).toBe(true);
    expect(await runInstallCommand([], companion, deps)).toBe(true);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]).toEqual([
      "This companion recommends Acme Tool. Install it for you? [y/N] ",
    ]);
    expect(state.installs).toBe(0);
    expect(await store.read(companion)).toEqual({ "acme-tool": "declined" });
    expect(output.join("\n")).toContain("Acme Tool: declined");
  });

  test("accepting in a terminal installs without a second confirmation", async () => {
    const { plugin, state } = recommendedTool();
    useDistribution(plugin);
    const confirm = mock(async () => true);

    await runInstallCommand([], companion, {
      memberChoicesStore: store,
      confirm,
      isTTY: true,
      renderExecution: (plan) => runInstallPlan(plan),
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(state.installs).toBe(1);
    expect(await store.read(companion)).toEqual({ "acme-tool": "accepted" });
  });

  test("--without records a decline that a later --with overrides", async () => {
    const { plugin, state } = recommendedTool();
    useDistribution(plugin);

    await runInstallCommand(["--yes", "--without=acme-tool"], companion, {
      memberChoicesStore: store,
    });
    expect(await store.read(companion)).toEqual({ "acme-tool": "declined" });
    expect(state.installs).toBe(0);

    await runInstallCommand(["--yes", "--with", "acme-tool"], companion, {
      memberChoicesStore: store,
    });
    expect(await store.read(companion)).toEqual({ "acme-tool": "accepted" });
    expect(state.installs).toBe(1);
  });
});

describe("parseMemberChoiceFlags", () => {
  test("reads repeated and comma-separated --with/--without", () => {
    expect(
      parseMemberChoiceFlags([
        "--yes",
        "--with",
        "rtk",
        "--with=tokensave,graphify",
        "--without",
        "context-mode",
      ]),
    ).toEqual({
      rtk: "accepted",
      tokensave: "accepted",
      graphify: "accepted",
      "context-mode": "declined",
    });
  });

  test("refuses a flag without a capability id", () => {
    expect(parseMemberChoiceFlags(["--with"])).toEqual({
      error: "--with requires a capability id",
    });
    expect(parseMemberChoiceFlags(["--without", "--yes"])).toEqual({
      error: "--without requires a capability id",
    });
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import type { InstallPlan } from "../../lib/install";
import { runInstallCommand } from "./install";
import type { PluginDeclaration } from "../../lib/orchestrator/types";
import * as frozenModule from "../../tools/setup/dynamic-plugins/frozen";
import * as hydrateModule from "../../tools/setup/dynamic-plugins/hydrate";
import * as installModule from "../../tools/setup/dynamic-plugins/install";
import * as verifyModule from "../../tools/setup/dynamic-plugins/verify";

/**
 * Core requirements would shell out to network installers, so only plan
 * inspection and execution are stubbed; context, reconcile and state are real.
 */
const STUBBED_INSTALLERS = {
  inspectPlan: async (plan: InstallPlan) => ({ ...plan, requirements: [], deferred: [] }),
  runPlan: async () => ({ ok: true, results: [] }),
};

/** One entry per workspace install: its companion-relative root and the packages it was given. */
type WorkspaceCall = [workspace: string, packages: string[]];
const ordinaryCalls: WorkspaceCall[] = [];
const frozenCalls: WorkspaceCall[] = [];

const packages = (declarations: PluginDeclaration[]) => declarations.map((d) => d.package);

const spies: Array<{ mockRestore: () => void }> = [];

const originalHome = process.env.HOME;
const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
const originalAudience = process.env.MATE_AUDIENCE;
let home: string;
let companion: string;

const BASE = { package: "@acme/base", version: "1.0.0" };
const ANALYST = { package: "@acme/analyst", version: "1.0.0" };
const REVIEWER = { package: "@acme/reviewer", version: "2.0.0" };

beforeEach(async () => {
  ordinaryCalls.length = 0;
  frozenCalls.length = 0;
  spies.push(
    spyOn(installModule, "installDeclaredPlugins").mockImplementation(
      async (workspaceRoot: string, declarations: PluginDeclaration[]) => {
        ordinaryCalls.push([path.relative(companion, workspaceRoot), packages(declarations)]);
        return [];
      },
    ),
    spyOn(frozenModule, "installDeclaredPluginsFrozen").mockImplementation(
      async (workspaceRoot: string, declarations: PluginDeclaration[]) => {
        frozenCalls.push([path.relative(companion, workspaceRoot), packages(declarations)]);
        return [];
      },
    ),
    spyOn(hydrateModule, "hydrateDynamicPlugins").mockImplementation(async () => {}),
    spyOn(verifyModule, "verifyDeclaredPlugins").mockImplementation(async () => []),
  );
  process.exitCode = 0;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "mate-install-audiences-"));
  process.env.HOME = home;
  delete process.env.MATE_AUDIENCE;
  companion = path.join(home, "companion");
  await fs.mkdir(path.join(companion, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(companion, ".mate", "config", "framework.yaml"),
    JSON.stringify({
      packageManagers: [],
      capabilities: [],
      plugins: [BASE],
      audiences: { ba: { plugins: [ANALYST] }, qa: { plugins: [REVIEWER] } },
    }),
  );
  process.env.MATE_ARTIFACT_PATH = companion;
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  process.exitCode = 0;
  await fs.rm(home, { recursive: true, force: true });
  for (const [key, value] of [
    ["HOME", originalHome],
    ["MATE_ARTIFACT_PATH", originalArtifactPath],
    ["MATE_AUDIENCE", originalAudience],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const SHARED = path.join(".mate", "plugins");
const audienceWorkspace = (name: string) => path.join(SHARED, "audiences", name);

test("ordinary install with no audience installs the base plugins only", async () => {
  expect(await runInstallCommand(["--yes"], companion, STUBBED_INSTALLERS)).toBe(true);

  expect(ordinaryCalls).toEqual([[SHARED, ["@acme/base"]]]);
});

test("ordinary install adds the selected audience's own workspace and no other", async () => {
  process.env.MATE_AUDIENCE = "ba";

  expect(await runInstallCommand(["--yes"], companion, STUBBED_INSTALLERS)).toBe(true);

  expect(ordinaryCalls).toEqual([
    [SHARED, ["@acme/base"]],
    [audienceWorkspace("ba"), ["@acme/analyst"]],
  ]);
});

test("frozen install restores the base and the selected audience, each from its workspace", async () => {
  for (const audience of [undefined, "ba", "qa"]) {
    if (audience) process.env.MATE_AUDIENCE = audience;
    else delete process.env.MATE_AUDIENCE;
    expect(
      await runInstallCommand(["--yes", "--frozen-plugins"], companion, STUBBED_INSTALLERS),
    ).toBe(true);
  }

  expect(frozenCalls).toEqual([
    [SHARED, ["@acme/base"]],
    [SHARED, ["@acme/base"]],
    [audienceWorkspace("ba"), ["@acme/analyst"]],
    [SHARED, ["@acme/base"]],
    [audienceWorkspace("qa"), ["@acme/reviewer"]],
  ]);
});

test("an install names each audience whose plugins it removed and how to restore them", async () => {
  const tree = path.join(companion, audienceWorkspace("ba"), "node_modules");
  await fs.mkdir(tree, { recursive: true });
  const log = spyOn(console, "log").mockImplementation(() => {});

  try {
    expect(await runInstallCommand(["--yes"], companion, STUBBED_INSTALLERS)).toBe(true);
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain('"ba"');
    expect(output).toContain("MATE_AUDIENCE=ba mate install");
  } finally {
    log.mockRestore();
  }

  await expect(fs.access(tree)).rejects.toThrow();
});

test("an install with nothing to remove names no audience", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});

  try {
    expect(await runInstallCommand(["--yes"], companion, STUBBED_INSTALLERS)).toBe(true);
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("removed");
  } finally {
    log.mockRestore();
  }
});

test("an unknown audience exits 1 before any install, naming requested and declared", async () => {
  process.env.MATE_AUDIENCE = "dev";
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

  try {
    expect(
      await runInstallCommand(["--yes", "--frozen-plugins"], companion, STUBBED_INSTALLERS),
    ).toBe(false);
    expect(await runInstallCommand(["--yes"], companion, STUBBED_INSTALLERS)).toBe(false);
    const output = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain('"dev"');
    expect(output).toContain("ba, qa");
  } finally {
    stderr.mockRestore();
  }

  expect(process.exitCode).toBe(1);
  expect(ordinaryCalls).toEqual([]);
  expect(frozenCalls).toEqual([]);
});

test("without audiences the declared base list installs unchanged", async () => {
  await fs.writeFile(
    path.join(companion, ".mate", "config", "framework.yaml"),
    JSON.stringify({ packageManagers: [], capabilities: [], plugins: [BASE] }),
  );

  expect(await runInstallCommand(["--yes"], companion, STUBBED_INSTALLERS)).toBe(true);

  expect(ordinaryCalls).toEqual([[SHARED, ["@acme/base"]]]);
});

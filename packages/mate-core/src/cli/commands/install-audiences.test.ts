import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";

import * as realInstall from "../../lib/install";
import type { PluginDeclaration } from "../../lib/orchestrator/types";
import * as frozenModule from "../../tools/setup/dynamic-plugins/frozen";
import * as hydrateModule from "../../tools/setup/dynamic-plugins/hydrate";
import * as installModule from "../../tools/setup/dynamic-plugins/install";
import * as verifyModule from "../../tools/setup/dynamic-plugins/verify";

mock.module("../../lib/install", () => ({
  ...realInstall,
  inspectInstallPlan: async (plan: realInstall.InstallPlan) => ({ ...plan, requirements: [] }),
  runInstallPlan: async () => ({ ok: true, results: [] }),
}));

const ordinaryCalls: PluginDeclaration[][] = [];
const frozenCalls: PluginDeclaration[][] = [];

const spies: Array<{ mockRestore: () => void }> = [];

const { runInstallCommand } = await import("./install");

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
      async (_companion: string, declarations: PluginDeclaration[]) => {
        ordinaryCalls.push(declarations);
        return [];
      },
    ),
    spyOn(frozenModule, "installDeclaredPluginsFrozen").mockImplementation(
      async (_companion: string, declarations: PluginDeclaration[]) => {
        frozenCalls.push(declarations);
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

const packages = (declarations: PluginDeclaration[]) => declarations.map((d) => d.package);

test("ordinary install writes the union of base and every audience with no audience selected", async () => {
  expect(await runInstallCommand(["--yes"], companion)).toBe(true);

  expect(ordinaryCalls.map(packages)).toEqual([["@acme/base", "@acme/analyst", "@acme/reviewer"]]);
});

test("frozen install restores the same union for every valid audience and for none", async () => {
  for (const audience of [undefined, "ba", "qa"]) {
    if (audience) process.env.MATE_AUDIENCE = audience;
    else delete process.env.MATE_AUDIENCE;
    expect(await runInstallCommand(["--yes", "--frozen-plugins"], companion)).toBe(true);
  }

  expect(frozenCalls.map(packages)).toEqual([
    ["@acme/base", "@acme/analyst", "@acme/reviewer"],
    ["@acme/base", "@acme/analyst", "@acme/reviewer"],
    ["@acme/base", "@acme/analyst", "@acme/reviewer"],
  ]);
});

test("an unknown audience exits 1 before any install, naming requested and declared", async () => {
  process.env.MATE_AUDIENCE = "dev";
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

  try {
    expect(await runInstallCommand(["--yes", "--frozen-plugins"], companion)).toBe(false);
    expect(await runInstallCommand(["--yes"], companion)).toBe(false);
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

  expect(await runInstallCommand(["--yes"], companion)).toBe(true);

  expect(ordinaryCalls.map(packages)).toEqual([["@acme/base"]]);
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import type { PluginDeclaration } from "../lib/orchestrator/types";
import * as hydrateModule from "./setup/dynamic-plugins/hydrate";
import * as installModule from "./setup/dynamic-plugins/install";
import { executeSetup } from "./setup";

const installCalls: PluginDeclaration[][] = [];
const spies: Array<{ mockRestore: () => void }> = [];

const originalHome = process.env.HOME;
const originalAudience = process.env.MATE_AUDIENCE;
let home: string;
let companion: string;

beforeEach(async () => {
  installCalls.length = 0;
  spies.push(
    spyOn(installModule, "installDeclaredPlugins").mockImplementation(
      async (_companion: string, declarations: PluginDeclaration[]) => {
        installCalls.push(declarations);
        return [];
      },
    ),
    spyOn(hydrateModule, "hydrateDynamicPlugins").mockImplementation(async () => {}),
  );
  home = await fs.mkdtemp(path.join(os.tmpdir(), "mate-setup-audiences-"));
  process.env.HOME = home;
  delete process.env.MATE_AUDIENCE;
  companion = path.join(home, "companion");
  await fs.mkdir(path.join(companion, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(companion, ".mate", "config", "framework.yaml"),
    JSON.stringify({
      allowedAgents: [],
      packageManagers: [],
      capabilities: [],
      plugins: [{ package: "@acme/base", version: "1.0.0" }],
      audiences: { ba: { plugins: [{ package: "@acme/analyst", version: "1.0.0" }] } },
    }),
  );
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await fs.rm(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAudience === undefined) delete process.env.MATE_AUDIENCE;
  else process.env.MATE_AUDIENCE = originalAudience;
});

test("setup installs base and every audience's plugins whatever the selection", async () => {
  for (const audience of [undefined, "ba"]) {
    if (audience) process.env.MATE_AUDIENCE = audience;
    else delete process.env.MATE_AUDIENCE;
    await executeSetup({}, { cwd: companion });
  }

  expect(installCalls.map((calls) => calls.map((d) => d.package))).toEqual([
    ["@acme/base", "@acme/analyst"],
    ["@acme/base", "@acme/analyst"],
  ]);
});

test("setup keeps the audiences block in the saved configuration", async () => {
  await executeSetup({}, { cwd: companion });

  const saved = await fs.readFile(
    path.join(companion, ".mate", "config", "framework.yaml"),
    "utf8",
  );
  expect(saved).toContain("audiences:");
  expect(saved).toContain("@acme/analyst");
  expect(saved.match(/@acme\/analyst/g)).toHaveLength(1);
});

test("setup rejects an unknown audience before installing", async () => {
  process.env.MATE_AUDIENCE = "qa";

  await expect(executeSetup({}, { cwd: companion })).rejects.toThrow(/"qa".*ba/);

  expect(installCalls).toEqual([]);
});

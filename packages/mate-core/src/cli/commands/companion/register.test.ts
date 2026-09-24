import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { resetActiveDistribution, setActiveDistribution } from "../../../distribution";
import { PluginRegistry } from "../../../tools/setup/registry";
import * as dynamicPlugins from "../../../tools/setup/dynamic-plugins/hydrate";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { main } from "../../main";
import { companionRegisterCommandDeps } from "./register";

const tempRoots: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function makeCompanion(root: string): Promise<string> {
  const companionPath = path.join(root, "acme");
  await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(companionPath, ".mate", "config", "framework.yaml"),
    "type: companion\nallowedAgents:\n  - claude\n",
    "utf8",
  );
  return companionPath;
}

let originalCreateStore: typeof companionRegisterCommandDeps.createGlobalConfigStore;
let stdout: string;
let stderr: string;

beforeEach(() => {
  /** A leaked non-zero status from an earlier file would otherwise read as this command's. */
  process.exitCode = 0;
  originalCreateStore = companionRegisterCommandDeps.createGlobalConfigStore;
  stdout = "";
  stderr = "";
  setActiveDistribution({
    config: { runtime: "bun", version: "test" },
    registry: new PluginRegistry([]),
  });
  spies.push(
    spyOn(dynamicPlugins, "hydrateDynamicPlugins").mockImplementation(async () => {}),
    spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }),
    spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }),
  );
});

afterEach(async () => {
  spies.splice(0).forEach((spy) => spy.mockRestore());
  resetActiveDistribution();
  process.exitCode = 0;
  companionRegisterCommandDeps.createGlobalConfigStore = originalCreateStore;
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("mate companion register", () => {
  test("registers a configured companion non-interactively, end to end", async () => {
    const home = await makeTempDir("register-home-");
    const root = await makeTempDir("register-repo-");
    const registryPath = path.join(home, "config.yaml");
    companionRegisterCommandDeps.createGlobalConfigStore = () =>
      new GlobalConfigStore(registryPath);
    const companionPath = await makeCompanion(root);

    await main(["bun", "mate", "companion", "register", companionPath]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain(companionPath);
    const registry = await fs.readFile(registryPath, "utf8");
    expect(registry).toContain(companionPath);
  });

  test("refuses a directory with no companion configuration and exits non-zero", async () => {
    const home = await makeTempDir("register-home-bare-");
    const root = await makeTempDir("register-repo-bare-");
    const registryPath = path.join(home, "config.yaml");
    companionRegisterCommandDeps.createGlobalConfigStore = () =>
      new GlobalConfigStore(registryPath);
    const bare = path.join(root, "bare");
    await fs.mkdir(bare, { recursive: true });

    await main(["bun", "mate", "companion", "register", bare]);

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain("nothing to register");
    expect(await fs.readdir(bare)).toEqual([]);
  });
});

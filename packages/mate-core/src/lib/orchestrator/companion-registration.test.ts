import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { registerConfiguredCompanion } from "./companion-registration";
import { GlobalConfigStore } from "./global-config-store";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

const CONFIG_YAML = [
  "type: companion",
  "allowedAgents:",
  "  - claude",
  "packageManagers:",
  "  - bun",
  "capabilities:",
  "  - name: context-mode",
  "",
].join("\n");

async function makeCompanion(root: string, contents = CONFIG_YAML): Promise<string> {
  const companionPath = path.join(root, "companion");
  await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(companionPath, ".mate", "config", "framework.yaml"),
    contents,
    "utf8",
  );
  return companionPath;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("registerConfiguredCompanion", () => {
  test("registers a configured companion without reading stdin or writing its config", async () => {
    const root = await makeTempDir("companion-register-");
    const companionPath = await makeCompanion(root);
    const configFile = path.join(companionPath, ".mate", "config", "framework.yaml");
    const before = await fs.readFile(configFile, "utf8");
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));

    let stdinReads = 0;
    const stdin = process.stdin as unknown as { read: () => unknown };
    const originalRead = stdin.read;
    stdin.read = () => {
      stdinReads++;
      return null;
    };

    try {
      const result = await registerConfiguredCompanion(companionPath, { globalConfigStore });

      expect(result).toEqual({ ok: true, companionPath, alreadyRegistered: false });
    } finally {
      stdin.read = originalRead;
    }

    expect(stdinReads).toBe(0);
    expect(await globalConfigStore.list()).toEqual([companionPath]);
    expect(await fs.readFile(configFile, "utf8")).toBe(before);
    expect(await fs.readFile(path.join(root, "config.yaml"), "utf8")).toContain(companionPath);
  });

  test("refuses a directory carrying no companion configuration and creates none", async () => {
    const root = await makeTempDir("companion-register-bare-");
    const bare = path.join(root, "bare");
    await fs.mkdir(bare, { recursive: true });
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));

    const result = await registerConfiguredCompanion(bare, { globalConfigStore });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("nothing to register");
    expect(await globalConfigStore.list()).toEqual([]);
    expect(await fs.readdir(bare)).toEqual([]);
  });

  test("refuses a working-repo framework rather than registering it", async () => {
    const root = await makeTempDir("companion-register-working-");
    const companionPath = await makeCompanion(root, "type: working\n");
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));

    const result = await registerConfiguredCompanion(companionPath, { globalConfigStore });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not a companion");
    expect(await globalConfigStore.list()).toEqual([]);
  });

  test("registering an already-registered companion leaves exactly one entry", async () => {
    const root = await makeTempDir("companion-register-idempotent-");
    const companionPath = await makeCompanion(root);
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));

    await registerConfiguredCompanion(companionPath, { globalConfigStore });
    const second = await registerConfiguredCompanion(companionPath, { globalConfigStore });

    expect(second).toEqual({ ok: true, companionPath, alreadyRegistered: true });
    expect(await globalConfigStore.list()).toEqual([companionPath]);
  });
});

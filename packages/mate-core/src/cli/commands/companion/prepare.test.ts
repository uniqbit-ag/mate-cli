import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { resetActiveDistribution, setActiveDistribution } from "../../../distribution";
import {
  CONTEXT_MODE_PACKAGE_NAME,
  CONTEXT_MODE_VERSION,
  validateContextModePackage,
} from "../../../lib/context-mode-package";
import { fingerprintWorkspace } from "../../../lib/prebuilt-workspace-prepare";
import { PluginRegistry } from "../../../tools/setup/registry";
import * as dynamicPlugins from "../../../tools/setup/dynamic-plugins/hydrate";
import { main } from "../../main";

const tempRoots: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

const CONTEXT_MODE_ASSETS = [
  ".claude-plugin/plugin.json",
  "hooks/hooks.json",
  "skills/context-mode/SKILL.md",
  "build/adapters/opencode/plugin.js",
];

let stdout: string;
let stderr: string;
let originalFetch: typeof globalThis.fetch;
let networkAttempts: number;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/** A fully installed prebuilt workspace, as a build host would hand one over. */
async function makeBundle(): Promise<string> {
  const bundle = await makeTempDir("prepare-bundle-");
  await fs.writeFile(
    path.join(bundle, "package.json"),
    `${JSON.stringify({ private: true, dependencies: { [CONTEXT_MODE_PACKAGE_NAME]: CONTEXT_MODE_VERSION } }, null, 2)}\n`,
    "utf8",
  );
  const packageDir = path.join(bundle, "node_modules", CONTEXT_MODE_PACKAGE_NAME);
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: CONTEXT_MODE_PACKAGE_NAME, version: CONTEXT_MODE_VERSION, dependencies: { "tiny-dep": "^1.0.0" } }, null, 2)}\n`,
    "utf8",
  );
  for (const asset of CONTEXT_MODE_ASSETS) {
    await fs.mkdir(path.dirname(path.join(packageDir, asset)), { recursive: true });
    await fs.writeFile(path.join(packageDir, asset), "{}", "utf8");
  }
  const depDir = path.join(bundle, "node_modules", "tiny-dep");
  await fs.mkdir(depDir, { recursive: true });
  await fs.writeFile(
    path.join(depDir, "package.json"),
    `${JSON.stringify({ name: "tiny-dep", version: "1.2.3" }, null, 2)}\n`,
    "utf8",
  );
  return bundle;
}

const SELECTIONS =
  "type: companion\nallowedAgents:\n  - opencode\ncapabilities:\n  - name: context-mode\n";

/** A sanitized fresh checkout: selections recorded, local workspace absent. */
async function makeFreshCompanion(): Promise<string> {
  const root = await makeTempDir("prepare-companion-");
  const companionPath = path.join(root, "acme");
  await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(companionPath, ".mate", "config", "framework.yaml"),
    SELECTIONS,
    "utf8",
  );
  return companionPath;
}

beforeEach(() => {
  process.exitCode = 0;
  stdout = "";
  stderr = "";
  networkAttempts = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    networkAttempts++;
    throw new Error("outbound networking is disabled");
  }) as typeof globalThis.fetch;
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
  globalThis.fetch = originalFetch;
  resetActiveDistribution();
  process.exitCode = 0;
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("mate companion prepare", () => {
  test("prepares a fresh companion offline, leaving the bundle and selections untouched", async () => {
    const companionPath = await makeFreshCompanion();
    const bundle = await makeBundle();
    const bundleBefore = await fingerprintWorkspace(bundle);

    await main(["node", "mate", "companion", "prepare", "--from", bundle, companionPath]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain("Prepared local dependencies");

    /** The complete required installed graph works at its new location. */
    await expect(validateContextModePackage(companionPath)).resolves.toBeUndefined();

    expect(await fingerprintWorkspace(bundle)).toBe(bundleBefore);
    expect(
      await fs.readFile(path.join(companionPath, ".mate", "config", "framework.yaml"), "utf8"),
    ).toBe(SELECTIONS);
    expect(networkAttempts).toBe(0);
  });

  test("a second run against the same bundle reuses the prepared workspace", async () => {
    const companionPath = await makeFreshCompanion();
    const bundle = await makeBundle();

    await main(["node", "mate", "companion", "prepare", "--from", bundle, companionPath]);
    stdout = "";
    await main(["node", "mate", "companion", "prepare", "--from", bundle, companionPath]);

    expect(stdout).toContain("Reused local dependencies");
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("an unusable bundle is reported by name and prepares nothing", async () => {
    const companionPath = await makeFreshCompanion();
    const bundle = await makeBundle();
    await fs.rm(path.join(bundle, "node_modules", CONTEXT_MODE_PACKAGE_NAME, "hooks"), {
      recursive: true,
      force: true,
    });

    await main(["node", "mate", "companion", "prepare", "--from", bundle, companionPath]);

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain(CONTEXT_MODE_PACKAGE_NAME);
    expect(stderr).toContain("hooks/hooks.json");
    await expect(
      fs.access(path.join(companionPath, ".mate", "plugins", ".local")),
    ).rejects.toThrow();
  });

  test("normal workstation behaviour is intact: no bundle, no preparation", async () => {
    const companionPath = await makeFreshCompanion();

    await main(["node", "mate", "companion", "prepare", companionPath]);

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain("--from");
    await expect(
      fs.access(path.join(companionPath, ".mate", "plugins", ".local")),
    ).rejects.toThrow();
    expect(
      await fs.readFile(path.join(companionPath, ".mate", "config", "framework.yaml"), "utf8"),
    ).toBe(SELECTIONS);
  });
});

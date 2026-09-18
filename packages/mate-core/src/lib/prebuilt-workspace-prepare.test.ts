import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { CONTEXT_MODE_PACKAGE_NAME, CONTEXT_MODE_VERSION } from "./context-mode-package";
import type { PrebuiltWorkspaceTarget } from "./prebuilt-workspace";

import {
  fingerprintWorkspace,
  prebuiltWorkspaceDeps,
  preparePrebuiltWorkspace,
} from "./prebuilt-workspace-prepare";

const tempRoots: string[] = [];
const originalCopy = prebuiltWorkspaceDeps.copy;

const TARGET: PrebuiltWorkspaceTarget = { platform: "linux", arch: "arm64", nodeVersion: "24.0.0" };

const CONTEXT_MODE_ASSETS = [
  ".claude-plugin/plugin.json",
  "hooks/hooks.json",
  "skills/context-mode/SKILL.md",
  "build/adapters/opencode/plugin.js",
];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prepare-workspace-"));
  tempRoots.push(dir);
  return dir;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function makeBundle(marker: string): Promise<string> {
  const bundle = await makeTempDir();
  await writeJson(path.join(bundle, "package.json"), {
    private: true,
    dependencies: { [CONTEXT_MODE_PACKAGE_NAME]: CONTEXT_MODE_VERSION },
  });
  const packageDir = path.join(bundle, "node_modules", CONTEXT_MODE_PACKAGE_NAME);
  await writeJson(path.join(packageDir, "package.json"), {
    name: CONTEXT_MODE_PACKAGE_NAME,
    version: CONTEXT_MODE_VERSION,
  });
  for (const asset of CONTEXT_MODE_ASSETS) {
    await fs.mkdir(path.dirname(path.join(packageDir, asset)), { recursive: true });
    await fs.writeFile(path.join(packageDir, asset), marker, "utf8");
  }
  return bundle;
}

async function makeCompanion(): Promise<string> {
  const companionPath = await makeTempDir();
  await writeJson(path.join(companionPath, ".mate", "config", "framework.yaml"), {});
  await fs.writeFile(
    path.join(companionPath, ".mate", "config", "framework.yaml"),
    "type: companion\ncapabilities:\n  - name: context-mode\n",
    "utf8",
  );
  await fs.mkdir(path.join(companionPath, ".mate", "plugins"), { recursive: true });
  await fs.writeFile(
    path.join(companionPath, ".mate", "plugins", "committed.txt"),
    "tracked\n",
    "utf8",
  );
  return companionPath;
}

function workspaceOf(companionPath: string): string {
  return path.join(companionPath, ".mate", "plugins", ".local");
}

async function markerOf(workspacePath: string): Promise<string> {
  return fs.readFile(
    path.join(workspacePath, "node_modules", CONTEXT_MODE_PACKAGE_NAME, "hooks", "hooks.json"),
    "utf8",
  );
}

afterEach(async () => {
  prebuiltWorkspaceDeps.copy = originalCopy;
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("preparePrebuiltWorkspace", () => {
  test("prepares a fresh companion whose local workspace is absent", async () => {
    const companionPath = await makeCompanion();
    const bundle = await makeBundle("v1");
    const configBefore = await fs.readFile(
      path.join(companionPath, ".mate", "config", "framework.yaml"),
      "utf8",
    );

    const result = await preparePrebuiltWorkspace(companionPath, bundle, TARGET);

    expect(result).toMatchObject({
      ok: true,
      reused: false,
      workspacePath: workspaceOf(companionPath),
    });
    expect(await markerOf(workspaceOf(companionPath))).toBe("v1");
    expect(
      await fs.readFile(path.join(companionPath, ".mate", "config", "framework.yaml"), "utf8"),
    ).toBe(configBefore);
    expect(
      await fs.readFile(path.join(companionPath, ".mate", "plugins", "committed.txt"), "utf8"),
    ).toBe("tracked\n");
  });

  test("a repeated run against a matching workspace recopies nothing", async () => {
    const companionPath = await makeCompanion();
    const bundle = await makeBundle("v1");
    await preparePrebuiltWorkspace(companionPath, bundle, TARGET);

    let copies = 0;
    prebuiltWorkspaceDeps.copy = async (source, destination) => {
      copies++;
      return originalCopy(source, destination);
    };
    const result = await preparePrebuiltWorkspace(companionPath, bundle, TARGET);

    expect(result).toMatchObject({ ok: true, reused: true });
    expect(copies).toBe(0);
    expect(await markerOf(workspaceOf(companionPath))).toBe("v1");
  });

  test("a changed bundle is staged and then replaces the generated workspace", async () => {
    const companionPath = await makeCompanion();
    await preparePrebuiltWorkspace(companionPath, await makeBundle("v1"), TARGET);

    const upgraded = await makeBundle("v2");
    await fs.rm(path.join(upgraded, "node_modules", CONTEXT_MODE_PACKAGE_NAME, "build"), {
      recursive: true,
      force: true,
    });
    await fs.mkdir(
      path.join(
        upgraded,
        "node_modules",
        CONTEXT_MODE_PACKAGE_NAME,
        "build",
        "adapters",
        "opencode",
      ),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(
        upgraded,
        "node_modules",
        CONTEXT_MODE_PACKAGE_NAME,
        "build",
        "adapters",
        "opencode",
        "plugin.js",
      ),
      "v2",
      "utf8",
    );

    const result = await preparePrebuiltWorkspace(companionPath, upgraded, TARGET);

    expect(result).toMatchObject({ ok: true });
    expect(await markerOf(workspaceOf(companionPath))).toBe("v2");
    expect(await fs.readdir(path.join(companionPath, ".mate", "plugins"))).toEqual(
      expect.arrayContaining([".local", "committed.txt"]),
    );
    expect(await fs.readdir(path.join(companionPath, ".mate", "plugins"))).not.toContain(
      ".local.staging",
    );
  });

  test("an interrupted copy preserves the existing workspace and presents no partial one", async () => {
    const companionPath = await makeCompanion();
    await preparePrebuiltWorkspace(companionPath, await makeBundle("v1"), TARGET);

    prebuiltWorkspaceDeps.copy = async (source, destination) => {
      await fs.mkdir(destination, { recursive: true });
      throw new Error("interrupted");
    };
    const result = await preparePrebuiltWorkspace(companionPath, await makeBundle("v2"), TARGET);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.join("\n")).toContain("interrupted");
    expect(await markerOf(workspaceOf(companionPath))).toBe("v1");
    expect(await fs.readdir(path.join(companionPath, ".mate", "plugins"))).not.toContain(
      ".local.staging",
    );
  });

  test("an invalid bundle is refused before anything is copied", async () => {
    const companionPath = await makeCompanion();
    await preparePrebuiltWorkspace(companionPath, await makeBundle("v1"), TARGET);

    const broken = await makeBundle("v2");
    await fs.rm(path.join(broken, "node_modules", CONTEXT_MODE_PACKAGE_NAME, "hooks"), {
      recursive: true,
      force: true,
    });
    prebuiltWorkspaceDeps.copy = async () => {
      throw new Error("nothing may be copied from an invalid bundle");
    };

    const result = await preparePrebuiltWorkspace(companionPath, broken, TARGET);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.join("\n")).toContain("hooks/hooks.json");
    expect(await markerOf(workspaceOf(companionPath))).toBe("v1");
  });
});

describe("preparation is filesystem-only", () => {
  /**
   * A package manager or an installation script can only run through a
   * child-process API, so the preparation modules must reach for none.
   */
  test("the preparation modules invoke no child process", async () => {
    for (const module of ["./prebuilt-workspace-prepare.ts", "./prebuilt-workspace.ts"]) {
      const source = await fs.readFile(path.join(import.meta.dirname, module), "utf8");
      expect(source).not.toContain("child_process");
      expect(source).not.toMatch(/\bspawn(Sync)?\s*\(/);
      expect(source).not.toMatch(/\bexec(Sync|File)?\s*\(/);
    }
  });
});

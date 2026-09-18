import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { CONTEXT_MODE_PACKAGE_NAME, CONTEXT_MODE_VERSION } from "./context-mode-package";
import { validatePrebuiltWorkspace, type PrebuiltWorkspaceTarget } from "./prebuilt-workspace";

const tempRoots: string[] = [];

const TARGET: PrebuiltWorkspaceTarget = {
  platform: "linux",
  arch: "arm64",
  nodeVersion: "24.0.0",
};

const CONTEXT_MODE_ASSETS = [
  ".claude-plugin/plugin.json",
  "hooks/hooks.json",
  "skills/context-mode/SKILL.md",
  "build/adapters/opencode/plugin.js",
];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prebuilt-bundle-"));
  tempRoots.push(dir);
  return dir;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function installPackage(
  bundle: string,
  name: string,
  manifest: Record<string, unknown>,
  assets: string[] = [],
): Promise<string> {
  const dir = path.join(bundle, "node_modules", ...name.split("/"));
  await writeJson(path.join(dir, "package.json"), { name, ...manifest });
  for (const asset of assets) {
    await fs.mkdir(path.dirname(path.join(dir, asset)), { recursive: true });
    await fs.writeFile(path.join(dir, asset), "{}", "utf8");
  }
  return dir;
}

/** A bundle that passes every check, as a starting point each case then breaks. */
async function makeValidBundle(): Promise<string> {
  const bundle = await makeTempDir();
  await writeJson(path.join(bundle, "package.json"), {
    private: true,
    dependencies: { [CONTEXT_MODE_PACKAGE_NAME]: CONTEXT_MODE_VERSION },
  });
  await installPackage(
    bundle,
    CONTEXT_MODE_PACKAGE_NAME,
    { version: CONTEXT_MODE_VERSION, dependencies: { "tiny-dep": "^1.0.0" } },
    CONTEXT_MODE_ASSETS,
  );
  await installPackage(bundle, "tiny-dep", { version: "1.2.3" });
  return bundle;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("validatePrebuiltWorkspace", () => {
  test("accepts a complete, correctly pinned bundle for the target", async () => {
    const bundle = await makeValidBundle();

    const result = await validatePrebuiltWorkspace(bundle, TARGET);

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.packages).toEqual({ [CONTEXT_MODE_PACKAGE_NAME]: CONTEXT_MODE_VERSION });
  });

  test("a corrupt bundle fails by name without installing anything", async () => {
    const bundle = await makeValidBundle();
    await fs.writeFile(
      path.join(bundle, "node_modules", CONTEXT_MODE_PACKAGE_NAME, "package.json"),
      "{ not json",
      "utf8",
    );

    const result = await validatePrebuiltWorkspace(bundle, TARGET);

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain(CONTEXT_MODE_PACKAGE_NAME);
  });

  test("a bundle with no framework-generated manifest is refused outright", async () => {
    const bundle = await makeTempDir();

    const result = await validatePrebuiltWorkspace(bundle, TARGET);

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("no framework-generated package.json");
  });

  test("an incomplete installed copy names the missing assets", async () => {
    const bundle = await makeValidBundle();
    await fs.rm(path.join(bundle, "node_modules", CONTEXT_MODE_PACKAGE_NAME, "hooks"), {
      recursive: true,
      force: true,
    });

    const result = await validatePrebuiltWorkspace(bundle, TARGET);

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("hooks/hooks.json");
  });

  test("an incomplete dependency graph names the unresolved dependency", async () => {
    const bundle = await makeValidBundle();
    await fs.rm(path.join(bundle, "node_modules", "tiny-dep"), { recursive: true, force: true });

    const result = await validatePrebuiltWorkspace(bundle, TARGET);

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain(
      `tiny-dep: required by ${CONTEXT_MODE_PACKAGE_NAME} but not installed in the bundle.`,
    );
  });

  test("a wrong-version bundle names the package and both versions", async () => {
    const bundle = await makeValidBundle();
    await writeJson(path.join(bundle, "package.json"), {
      private: true,
      dependencies: { [CONTEXT_MODE_PACKAGE_NAME]: "0.0.1" },
    });

    const result = await validatePrebuiltWorkspace(bundle, TARGET);

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain(CONTEXT_MODE_VERSION);
    expect(result.failures.join("\n")).toContain("0.0.1");
  });

  test("an installed copy at the wrong version is named", async () => {
    const bundle = await makeValidBundle();
    await writeJson(path.join(bundle, "node_modules", CONTEXT_MODE_PACKAGE_NAME, "package.json"), {
      name: CONTEXT_MODE_PACKAGE_NAME,
      version: "0.0.1",
    });

    const result = await validatePrebuiltWorkspace(bundle, TARGET);

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain(`expected ${CONTEXT_MODE_VERSION} installed`);
  });

  test("a wrong-architecture bundle names the package and the target", async () => {
    const bundle = await makeValidBundle();
    await installPackage(bundle, "native-dep", {
      version: "1.0.0",
      os: ["darwin"],
      cpu: ["x64"],
    });
    await writeJson(path.join(bundle, "node_modules", CONTEXT_MODE_PACKAGE_NAME, "package.json"), {
      name: CONTEXT_MODE_PACKAGE_NAME,
      version: CONTEXT_MODE_VERSION,
      dependencies: { "tiny-dep": "^1.0.0", "native-dep": "^1.0.0" },
    });

    const result = await validatePrebuiltWorkspace(bundle, TARGET);

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("native-dep: built for darwin");
    expect(result.failures.join("\n")).toContain("native-dep: built for x64");
  });

  test("a bundle carrying a package the distribution does not own is refused", async () => {
    const bundle = await makeValidBundle();
    await writeJson(path.join(bundle, "package.json"), {
      private: true,
      dependencies: { [CONTEXT_MODE_PACKAGE_NAME]: CONTEXT_MODE_VERSION, "some-tool": "1.0.0" },
    });

    const result = await validatePrebuiltWorkspace(bundle, TARGET);

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("some-tool: not a distribution-owned dependency");
  });

  test("a runtime the installed graph does not support is named with both versions", async () => {
    const bundle = await makeValidBundle();
    await installPackage(bundle, "tiny-dep", { version: "1.2.3", engines: { node: ">=99.0.0" } });

    const result = await validatePrebuiltWorkspace(bundle, { ...TARGET, nodeVersion: "24.0.0" });

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("tiny-dep: requires Node.js >=99.0.0");
    expect(result.failures.join("\n")).toContain("24.0.0");
  });
});

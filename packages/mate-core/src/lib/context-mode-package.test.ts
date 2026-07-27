import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  CONTEXT_MODE_VERSION,
  getContextModePackageReference,
  getContextModePackageRoot,
  isContextModeNodeVersionSupported,
  isContextModePackageReference,
  validateContextModePackage,
} from "./context-mode-package";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("context-mode package contract", () => {
  test("uses one exact package reference", () => {
    expect(getContextModePackageReference()).toBe(`context-mode@${CONTEXT_MODE_VERSION}`);
    expect(isContextModePackageReference("context-mode")).toBe(true);
    expect(isContextModePackageReference(getContextModePackageReference())).toBe(true);
    expect(isContextModePackageReference("context-mode-fork@1.0.0")).toBe(false);
  });

  test("enforces the pinned Node.js engine floor", () => {
    expect(isContextModeNodeVersionSupported("v22.4.9")).toBe(false);
    expect(isContextModeNodeVersionSupported("v22.5.0")).toBe(true);
    expect(isContextModeNodeVersionSupported("v24.0.0")).toBe(true);
  });

  test("validates the exact version and required provider assets", async () => {
    const companionPath = await fs.mkdtemp(path.join(os.tmpdir(), "mate-context-package-"));
    tempRoots.push(companionPath);
    const root = getContextModePackageRoot(companionPath);
    for (const asset of [
      ".claude-plugin/plugin.json",
      "hooks/hooks.json",
      "skills/context-mode/SKILL.md",
      "build/adapters/opencode/plugin.js",
    ]) {
      const assetPath = path.join(root, asset);
      await fs.mkdir(path.dirname(assetPath), { recursive: true });
      await fs.writeFile(assetPath, "{}\n");
    }
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ version: CONTEXT_MODE_VERSION }),
    );

    await expect(validateContextModePackage(companionPath)).resolves.toBeUndefined();
    await fs.rm(path.join(root, "hooks", "hooks.json"));
    await expect(validateContextModePackage(companionPath)).rejects.toThrow();
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { FRAMEWORK_NAME } from "../../framework";
import { companionRegistryPath, readCompanionRegistry } from "./companion-registry-reader";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeRegistry(companionPath: string, contents: string): Promise<void> {
  const registryPath = companionRegistryPath(companionPath);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, contents, "utf8");
}

describe("readCompanionRegistry", () => {
  test("returns linked repos from a valid registry", async () => {
    const companionPath = await makeTempDir("companion-registry-valid-");
    await writeRegistry(companionPath, "repos:\n  - id: app\n    path: /repos/app\n");

    const result = await readCompanionRegistry(companionPath);

    expect(result.repos).toEqual([{ id: "app", path: "/repos/app" }]);
  });

  test("drops malformed entries missing id or path", async () => {
    const companionPath = await makeTempDir("companion-registry-malformed-");
    await writeRegistry(
      companionPath,
      "repos:\n  - id: app\n    path: /repos/app\n  - path: /repos/no-id\n  - id: no-path\n",
    );

    const result = await readCompanionRegistry(companionPath);

    expect(result.repos).toEqual([{ id: "app", path: "/repos/app" }]);
  });

  test("returns an empty list when repos is absent", async () => {
    const companionPath = await makeTempDir("companion-registry-norepos-");
    await writeRegistry(companionPath, "version: 1\n");

    const result = await readCompanionRegistry(companionPath);

    expect(result.repos).toEqual([]);
  });

  test("throws ENOENT when the registry file is missing", async () => {
    const companionPath = await makeTempDir("companion-registry-missing-");

    await expect(readCompanionRegistry(companionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not perform legacy-field migration writes", async () => {
    const companionPath = await makeTempDir("companion-registry-no-migration-");
    await writeRegistry(
      companionPath,
      "activeRepoId: app\nrepos:\n  - id: app\n    path: /repos/app\n",
    );
    const registryPath = companionRegistryPath(companionPath);
    const before = await fs.readFile(registryPath, "utf8");

    await readCompanionRegistry(companionPath);

    const after = await fs.readFile(registryPath, "utf8");
    expect(after).toBe(before);
  });

  test("registry path is nested under the companion's framework config dir", async () => {
    const companionPath = "/tmp/example-companion";

    expect(companionRegistryPath(companionPath)).toBe(
      path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "registry.yaml"),
    );
  });
});

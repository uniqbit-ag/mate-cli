import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { migrateConfigDir } from "./migration";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("migrateConfigDir", () => {
  test("is a no-op when current dir already exists", async () => {
    const root = await makeTempDir("migration-noop-");
    const currentDir = path.join(root, "current");
    const legacyDir = path.join(root, "legacy");

    await fs.mkdir(currentDir, { recursive: true });
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, "marker.txt"), "legacy", "utf8");

    await migrateConfigDir(currentDir, [legacyDir]);

    await fs.access(legacyDir);
    await fs.access(currentDir);
  });

  test("renames legacy dir to current when current is absent", async () => {
    const root = await makeTempDir("migration-rename-");
    const currentDir = path.join(root, "current");
    const legacyDir = path.join(root, "legacy");

    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, "marker.txt"), "legacy content", "utf8");

    await migrateConfigDir(currentDir, [legacyDir]);

    await fs.access(currentDir);
    await expect(fs.access(legacyDir)).rejects.toThrow();
    const content = await fs.readFile(path.join(currentDir, "marker.txt"), "utf8");
    expect(content).toBe("legacy content");
  });

  test("skips absent legacy dirs and migrates the next present one", async () => {
    const root = await makeTempDir("migration-skip-");
    const currentDir = path.join(root, "current");
    const missingLegacy = path.join(root, "missing");
    const presentLegacy = path.join(root, "present");

    await fs.mkdir(presentLegacy, { recursive: true });
    await fs.writeFile(path.join(presentLegacy, "data.txt"), "present", "utf8");

    await migrateConfigDir(currentDir, [missingLegacy, presentLegacy]);

    await fs.access(currentDir);
    const content = await fs.readFile(path.join(currentDir, "data.txt"), "utf8");
    expect(content).toBe("present");
  });

  test("is a no-op when current and all legacy dirs are absent", async () => {
    const root = await makeTempDir("migration-all-absent-");
    const currentDir = path.join(root, "current");
    const legacyDir = path.join(root, "legacy");

    await migrateConfigDir(currentDir, [legacyDir]);

    await expect(fs.access(currentDir)).rejects.toThrow();
  });
});

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("published core package", () => {
  test("packs executable CLI wrappers and the subpath entrypoints", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-core-package-smoke-"));
    tempRoots.push(root);
    const packageRoot = path.join(import.meta.dirname, "..");
    const pack = spawnSync("bun", ["pm", "pack", "--destination", root], {
      cwd: packageRoot,
      env: { ...process.env, CI: "1" },
      encoding: "utf8",
    });

    expect(pack.status).toBe(0);
    const tarball = (await fs.readdir(root)).find((entry) => entry.endsWith(".tgz"));
    expect(tarball).toBeDefined();

    const extracted = path.join(root, "extracted");
    await fs.mkdir(extracted);
    const unpack = spawnSync("tar", ["-xzf", path.join(root, tarball!), "-C", extracted], {
      encoding: "utf8",
    });
    expect(unpack.status).toBe(0);

    for (const name of ["openspec", "graphify"]) {
      const wrapperPath = path.join(extracted, "package", "wrappers", "bin", name);
      const stat = await fs.stat(wrapperPath);
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    }

    for (const entry of ["index.ts", "plugins.ts", "runtime/index.ts", "opencode/index.ts"]) {
      await expect(fs.stat(path.join(extracted, "package", "src", entry))).resolves.toBeDefined();
    }
  });
});

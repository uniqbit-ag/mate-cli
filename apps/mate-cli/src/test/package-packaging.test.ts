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

describe("published package", () => {
  test("packs the bin bootstrap (wrappers ship in @uniqbit/mate-core)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-package-smoke-"));
    tempRoots.push(root);
    const packageRoot = path.join(import.meta.dirname, "../..");
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

    // Wrappers are packaged by @uniqbit/mate-core now; the distribution
    // tarball ships only the bin and distribution config.
    await expect(fs.stat(path.join(extracted, "package", "wrappers"))).rejects.toThrow();

    const bootstrap = path.join(extracted, "package", "src", "cli-bootstrap.cjs");
    await expect(fs.stat(bootstrap)).resolves.toBeDefined();
    await expect(fs.readFile(bootstrap, "utf8")).resolves.toContain("Install Bun now?");
  });
});

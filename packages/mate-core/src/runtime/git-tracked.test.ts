import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git } from "../../test/git-checkouts";
import { gitTrackedUnder } from "./git-tracked";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-tracked-"));
  roots.push(dir);
  return dir;
}

describe("gitTrackedUnder", () => {
  test("lists a tracked file below a folder and leaves out other files", async () => {
    const dir = await tempDir();
    git(dir, "init", "-q");
    await fs.mkdir(path.join(dir, "acme", "deep"), { recursive: true });
    await fs.writeFile(path.join(dir, "acme", "deep", "tracked.txt"), "x");
    await fs.writeFile(path.join(dir, "acme", "untracked.txt"), "x");
    await fs.writeFile(path.join(dir, "other.txt"), "x");
    git(dir, "add", "acme/deep/tracked.txt", "other.txt");

    expect(await gitTrackedUnder(dir, ["acme"])).toEqual(["acme/deep/tracked.txt"]);
  });

  test("reads a folder outside Git as untracked", async () => {
    expect(await gitTrackedUnder(await tempDir(), ["acme"])).toEqual([]);
  });
});

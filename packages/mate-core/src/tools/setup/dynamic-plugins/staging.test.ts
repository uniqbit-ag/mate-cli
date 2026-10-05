import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { verifyTrackedPluginOutputs } from "./staging";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const TRACKED = "instructions.md";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args],
    { cwd },
  );
  if (result.status !== 0) throw new Error(String(result.stderr));
}

async function repo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "staging-"));
  roots.push(dir);
  git(dir, "init", "-q");
  await fs.writeFile(path.join(dir, TRACKED), "committed\n");
  await fs.writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

describe("verifyTrackedPluginOutputs", () => {
  test("a matching projection leaves the checkout clean", async () => {
    const dir = await repo();
    const drift = await verifyTrackedPluginOutputs(dir, async (staged) => {
      await fs.writeFile(path.join(staged, TRACKED), "committed\n");
      await fs.writeFile(path.join(staged, "ignored.txt"), "local\n");
    });
    expect(drift).toEqual([]);
  });

  test("reports changed and new generated files without touching the live checkout", async () => {
    const dir = await repo();
    const drift = await verifyTrackedPluginOutputs(dir, async (staged) => {
      await fs.writeFile(path.join(staged, TRACKED), "changed\n");
      await fs.writeFile(path.join(staged, "new.md"), "new\n");
    });
    expect(drift.toSorted()).toEqual([TRACKED, "new.md"]);
    expect(await fs.readFile(path.join(dir, TRACKED), "utf8")).toBe("committed\n");
    await expect(fs.access(path.join(dir, "new.md"))).rejects.toThrow();
  });

  test("refuses a checkout with its own edits", async () => {
    const dir = await repo();
    await fs.writeFile(path.join(dir, TRACKED), "edited\n");
    await expect(verifyTrackedPluginOutputs(dir, async () => {})).rejects.toThrow(/instructions/);
    expect(await fs.readFile(path.join(dir, TRACKED), "utf8")).toBe("edited\n");
  });
});

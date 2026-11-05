import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { isSkillIgnoreEntry, skillIgnoreEntries, untrackSkillCopies } from "./mate-skill-copies";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

/** A companion committing a Mate skill copy in both roots and a team skill. */
async function makeCompanion(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-skill-copies-"));
  tempRoots.push(root);
  git(root, "init", "-q");
  await write(root, ".claude/skills/mate-propose-change/SKILL.md", "propose\n");
  await write(root, ".agents/skills/mate-propose-change/references/acme.md", "acme\n");
  await write(root, ".claude/skills/mate-acme/SKILL.md", "team\n");
  await write(root, ".agents/skills/acme/SKILL.md", "team\n");
  git(root, "add", ".");
  git(root, "-c", "user.email=acme@example.com", "-c", "user.name=acme", "commit", "-qm", "init");
  return root;
}

describe("skillIgnoreEntries", () => {
  test("lists both roots per exact name", () => {
    expect(skillIgnoreEntries(["mate-propose-change"])).toEqual([
      ".claude/skills/mate-propose-change/",
      ".agents/skills/mate-propose-change/",
    ]);
    expect(isSkillIgnoreEntry(".claude/skills/mate-propose-change/")).toBe(true);
    expect(isSkillIgnoreEntry("node_modules/")).toBe(false);
  });
});

describe("untrackSkillCopies", () => {
  test("untracks listed copies, keeps them on disk and leaves team skills tracked", async () => {
    const root = await makeCompanion();

    const removed = await untrackSkillCopies(root, [
      "node_modules/",
      ...skillIgnoreEntries(["mate-propose-change"]),
    ]);

    expect(removed.toSorted()).toEqual([
      ".agents/skills/mate-propose-change/references/acme.md",
      ".claude/skills/mate-propose-change/SKILL.md",
    ]);
    expect(git(root, "ls-files").trim().split("\n")).toEqual([
      ".agents/skills/acme/SKILL.md",
      ".claude/skills/mate-acme/SKILL.md",
    ]);
    expect(git(root, "diff", "--cached", "--name-status").trim().split("\n").toSorted()).toEqual([
      "D\t.agents/skills/mate-propose-change/references/acme.md",
      "D\t.claude/skills/mate-propose-change/SKILL.md",
    ]);
    expect(
      await fs.readFile(path.join(root, ".claude/skills/mate-propose-change/SKILL.md"), "utf8"),
    ).toBe("propose\n");
  });

  test("returns removals an earlier run left staged, and nothing once committed", async () => {
    const root = await makeCompanion();
    const entries = skillIgnoreEntries(["mate-propose-change"]);
    const first = await untrackSkillCopies(root, entries);

    expect((await untrackSkillCopies(root, entries)).toSorted()).toEqual(first.toSorted());
    expect(await untrackSkillCopies(root, skillIgnoreEntries(["mate-grill-me"]))).toEqual([]);
    git(root, "-c", "user.email=acme@example.com", "-c", "user.name=acme", "commit", "-qm", "rm");
    expect(await untrackSkillCopies(root, entries)).toEqual([]);
  });

  test("untracks a copy whose staged edit differs from both HEAD and the file", async () => {
    const root = await makeCompanion();
    const copy = ".claude/skills/mate-propose-change/SKILL.md";
    await write(root, copy, "staged edit\n");
    git(root, "add", copy);
    await write(root, copy, "synced\n");

    expect(await untrackSkillCopies(root, skillIgnoreEntries(["mate-propose-change"]))).toContain(
      copy,
    );
    expect(git(root, "ls-files", "--", copy)).toBe("");
    expect(await fs.readFile(path.join(root, copy), "utf8")).toBe("synced\n");
  });

  test("does nothing outside a Git repository", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-skill-copies-nogit-"));
    tempRoots.push(root);
    await write(root, ".claude/skills/mate-propose-change/SKILL.md", "propose\n");

    expect(await untrackSkillCopies(root, skillIgnoreEntries(["mate-propose-change"]))).toEqual([]);
  });
});

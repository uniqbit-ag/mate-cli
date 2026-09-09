import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  reconcileWorkingRepoClaudeSkillLinks,
  removeWorkingRepoClaudeSkillLinks,
} from "./projection-claude-skills";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function makeFixture(prefix: string): Promise<{ repoPath: string; companionPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const repoPath = path.join(root, "repo");
  const companionPath = path.join(root, "companion");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(path.join(companionPath, ".claude", "skills", "acme"), { recursive: true });
  await fs.writeFile(
    path.join(companionPath, ".claude", "skills", "acme", "SKILL.md"),
    "acme skill\n",
    "utf8",
  );
  await fs.mkdir(path.join(companionPath, ".claude", "skills", "not-a-skill"), {
    recursive: true,
  });
  return { repoPath, companionPath };
}

describe("Claude working-repository skill links", () => {
  test("links companion skills without replacing user-owned skills", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-skill-links-");
    const custom = path.join(repoPath, ".claude", "skills", "custom", "SKILL.md");
    await fs.mkdir(path.dirname(custom), { recursive: true });
    await fs.writeFile(custom, "user skill\n", "utf8");

    await expect(
      reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true, [companionPath]),
    ).resolves.toBe("written");

    const link = path.join(repoPath, ".claude", "skills", "acme");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(link)).toBe(
      await fs.realpath(path.join(companionPath, ".claude", "skills", "acme")),
    );
    expect(await fs.readFile(custom, "utf8")).toBe("user skill\n");
    await expect(
      fs.access(path.join(repoPath, ".claude", "skills", "not-a-skill")),
    ).rejects.toThrow();
  });

  test("repins existing Mate links but preserves unrelated links", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-skill-repin-");
    const otherRoot = path.join(path.dirname(companionPath), "other");
    const otherSkill = path.join(otherRoot, ".claude", "skills", "acme");
    await fs.mkdir(otherSkill, { recursive: true });
    await fs.writeFile(path.join(otherSkill, "SKILL.md"), "other skill\n", "utf8");
    const userTarget = path.join(path.dirname(companionPath), "user-skill");
    await fs.mkdir(userTarget, { recursive: true });
    await fs.writeFile(path.join(userTarget, "SKILL.md"), "user skill\n", "utf8");
    const skillsRoot = path.join(repoPath, ".claude", "skills");
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.symlink(otherSkill, path.join(skillsRoot, "acme"), "dir");
    await fs.symlink(userTarget, path.join(skillsRoot, "user"), "dir");

    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true, [
      companionPath,
      otherRoot,
    ]);

    expect(await fs.realpath(path.join(skillsRoot, "acme"))).toBe(
      await fs.realpath(path.join(companionPath, ".claude", "skills", "acme")),
    );
    expect(await fs.realpath(path.join(skillsRoot, "user"))).toBe(await fs.realpath(userTarget));
  });

  test("removes only Mate links", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-skill-remove-");
    const custom = path.join(repoPath, ".claude", "skills", "custom");
    await fs.mkdir(custom, { recursive: true });
    await fs.writeFile(path.join(custom, "SKILL.md"), "user skill\n", "utf8");
    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true, [companionPath]);

    await expect(removeWorkingRepoClaudeSkillLinks(repoPath, [companionPath])).resolves.toBe(
      "removed",
    );
    await expect(fs.access(path.join(repoPath, ".claude", "skills", "acme"))).rejects.toThrow();
    await expect(fs.readFile(path.join(custom, "SKILL.md"), "utf8")).resolves.toBe("user skill\n");
  });
});

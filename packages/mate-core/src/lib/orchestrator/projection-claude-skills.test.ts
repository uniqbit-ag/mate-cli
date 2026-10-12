import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  links,
  manifestPath,
  readManifest,
  wrappedFor,
} from "../../runtime/runtime-document-manifest";
import {
  reconcileWorkingRepoClaudeSkillLinks,
  removeWorkingRepoClaudeSkillLinks,
} from "./projection-claude-skills";

const tempRoots: string[] = [];
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

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

async function addCompanion(root: string, name: string, skill: string): Promise<string> {
  const companionPath = path.join(root, name);
  await fs.mkdir(path.join(companionPath, ".claude", "skills", skill), { recursive: true });
  await fs.writeFile(path.join(companionPath, ".claude", "skills", skill, "SKILL.md"), "s\n");
  return companionPath;
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
    await fs.symlink(otherSkill, path.join(skillsRoot, "acme"), directoryLinkType);
    await fs.symlink(userTarget, path.join(skillsRoot, "user"), directoryLinkType);

    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true, [
      companionPath,
      otherRoot,
    ]);

    expect(await fs.realpath(path.join(skillsRoot, "acme"))).toBe(
      await fs.realpath(path.join(companionPath, ".claude", "skills", "acme")),
    );
    expect(await fs.realpath(path.join(skillsRoot, "user"))).toBe(await fs.realpath(userTarget));
  });

  test("keeps current skill links unchanged on repeated reconciliation", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-skill-current-");
    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true, [companionPath]);
    const link = path.join(repoPath, ".claude", "skills", "acme");
    const before = await fs.readlink(link);

    await expect(
      reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true, [companionPath]),
    ).resolves.toBe("current");

    expect(await fs.readlink(link)).toBe(before);
  });

  test("removes stale Mate links when Claude is disabled", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-skill-disabled-");
    const custom = path.join(repoPath, ".claude", "skills", "custom", "SKILL.md");
    await fs.mkdir(path.dirname(custom), { recursive: true });
    await fs.writeFile(custom, "user skill\n", "utf8");
    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true, [companionPath]);

    await expect(
      reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, false, [companionPath]),
    ).resolves.toBe("written");

    await expect(fs.access(path.join(repoPath, ".claude", "skills", "acme"))).rejects.toThrow();
    await expect(fs.readFile(custom, "utf8")).resolves.toBe("user skill\n");
    await expect(
      fs.readFile(path.join(companionPath, ".claude", "skills", "acme", "SKILL.md"), "utf8"),
    ).resolves.toBe("acme skill\n");
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

  test("records each link it creates with its target", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-skill-record-");

    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true);

    const manifest = await readManifest(repoPath);
    expect(links(manifest, "claude")).toEqual({
      ".claude/skills/acme": {
        runtime: "claude",
        target: path.join(companionPath, ".claude", "skills", "acme"),
      },
    });
    expect(wrappedFor(manifest, "claude")).toBe(true);
  });

  test("re-pinning replaces a same-name recorded link without a registry", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-skill-same-name-");
    const acmeB = await addCompanion(path.dirname(companionPath), "acme-b", "acme");
    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true);

    await expect(reconcileWorkingRepoClaudeSkillLinks(repoPath, acmeB, true)).resolves.toBe(
      "written",
    );

    const target = path.join(acmeB, ".claude", "skills", "acme");
    expect(await fs.realpath(path.join(repoPath, ".claude", "skills", "acme"))).toBe(
      await fs.realpath(target),
    );
    expect(links(await readManifest(repoPath), "claude")).toEqual({
      ".claude/skills/acme": { runtime: "claude", target },
    });
  });

  test("re-pinning away from an unregistered companion removes its recorded link", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-skill-unregistered-");
    const acmeB = await addCompanion(path.dirname(companionPath), "acme-b", "other");
    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true);

    await reconcileWorkingRepoClaudeSkillLinks(repoPath, acmeB, true);

    await expect(fs.lstat(path.join(repoPath, ".claude", "skills", "acme"))).rejects.toThrow();
    expect(Object.keys(links(await readManifest(repoPath)))).toEqual([".claude/skills/other"]);
  });

  test("a repointed link is left in place and its record dropped", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-skill-repointed-");
    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true);
    const link = path.join(repoPath, ".claude", "skills", "acme");
    const mine = path.join(path.dirname(companionPath), "mine");
    await fs.mkdir(mine, { recursive: true });
    await fs.unlink(link);
    await fs.symlink(mine, link, directoryLinkType);

    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true);
    expect(await fs.realpath(link)).toBe(await fs.realpath(mine));
    expect(links(await readManifest(repoPath))).toEqual({});

    await removeWorkingRepoClaudeSkillLinks(repoPath, [companionPath]);
    expect(await fs.realpath(link)).toBe(await fs.realpath(mine));
  });

  test("adopts and records a link an earlier release created", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-skill-adopt-");
    const otherRoot = await addCompanion(path.dirname(companionPath), "registered", "legacy");
    const skillsRoot = path.join(repoPath, ".claude", "skills");
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.symlink(
      path.join(otherRoot, ".claude", "skills", "legacy"),
      path.join(skillsRoot, "legacy"),
      directoryLinkType,
    );

    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true, [otherRoot]);

    await expect(fs.lstat(path.join(skillsRoot, "legacy"))).rejects.toThrow();
    expect(Object.keys(links(await readManifest(repoPath)))).toEqual([".claude/skills/acme"]);
  });

  test("removal withdraws recorded links without a registry and deletes the manifest", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-skill-remove-record-");
    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true);

    await expect(removeWorkingRepoClaudeSkillLinks(repoPath)).resolves.toBe("removed");

    await expect(fs.lstat(path.join(repoPath, ".claude", "skills", "acme"))).rejects.toThrow();
    await expect(fs.access(manifestPath(repoPath))).rejects.toThrow();
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { links, readManifest } from "../../runtime/runtime-document-manifest";
import {
  reconcileWorkingRepoClaudeCommandLinks,
  removeWorkingRepoClaudeCommandLinks,
} from "./projection-claude-commands";
import { reconcileWorkingRepoClaudeSkillLinks } from "./projection-claude-skills";

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
  await fs.mkdir(repoPath, { recursive: true });
  const companionPath = await addCompanion(root, "companion");
  return { repoPath, companionPath };
}

async function addCompanion(root: string, name: string): Promise<string> {
  const companionPath = path.join(root, name);
  const opsx = path.join(companionPath, ".claude", "commands", "opsx");
  await fs.mkdir(opsx, { recursive: true });
  await fs.writeFile(path.join(opsx, "propose.md"), `${name} propose\n`, "utf8");
  return companionPath;
}

function commandsPath(root: string, ...names: string[]): string {
  return path.join(root, ".claude", "commands", ...names);
}

describe("Claude working-repository command links", () => {
  test("links a companion command directory and records it", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-command-links-");

    await expect(
      reconcileWorkingRepoClaudeCommandLinks(repoPath, companionPath, true, [companionPath]),
    ).resolves.toBe("written");

    const link = commandsPath(repoPath, "opsx");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(link, "propose.md"), "utf8")).toBe("companion propose\n");
    expect(links(await readManifest(repoPath), "claude")).toEqual({
      ".claude/commands/opsx": { runtime: "claude", target: commandsPath(companionPath, "opsx") },
    });
  });

  test("skips loose command files and directories without markdown", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-command-ineligible-");
    await fs.writeFile(commandsPath(companionPath, "loose.md"), "loose\n", "utf8");
    await fs.mkdir(commandsPath(companionPath, "empty"), { recursive: true });
    await fs.writeFile(commandsPath(companionPath, "empty", "notes.txt"), "x\n", "utf8");

    await reconcileWorkingRepoClaudeCommandLinks(repoPath, companionPath, true, [companionPath]);

    expect((await fs.readdir(commandsPath(repoPath))).toSorted()).toEqual(["opsx"]);
  });

  test("a user-owned command directory wins the name and is not recorded", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-command-user-");
    const userFile = commandsPath(repoPath, "opsx", "mine.md");
    await fs.mkdir(path.dirname(userFile), { recursive: true });
    await fs.writeFile(userFile, "mine\n", "utf8");

    await reconcileWorkingRepoClaudeCommandLinks(repoPath, companionPath, true, [companionPath]);

    expect((await fs.lstat(commandsPath(repoPath, "opsx"))).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(userFile, "utf8")).toBe("mine\n");
    expect(links(await readManifest(repoPath), "claude")).toEqual({});
  });

  test("re-pinning to another companion repoints the link", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-command-repin-");
    const other = await addCompanion(path.dirname(companionPath), "other");
    await reconcileWorkingRepoClaudeCommandLinks(repoPath, companionPath, true, [companionPath]);

    await reconcileWorkingRepoClaudeCommandLinks(repoPath, other, true, [companionPath, other]);

    expect(await fs.readFile(commandsPath(repoPath, "opsx", "propose.md"), "utf8")).toBe(
      "other propose\n",
    );
    expect(links(await readManifest(repoPath), "claude")).toEqual({
      ".claude/commands/opsx": { runtime: "claude", target: commandsPath(other, "opsx") },
    });
  });

  test("adopts an unrecorded link into a registered companion", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-command-adopt-");
    await fs.mkdir(commandsPath(repoPath), { recursive: true });
    await fs.symlink(commandsPath(companionPath, "opsx"), commandsPath(repoPath, "opsx"), "dir");

    await reconcileWorkingRepoClaudeCommandLinks(repoPath, companionPath, true, [companionPath]);

    expect(links(await readManifest(repoPath), "claude")).toEqual({
      ".claude/commands/opsx": { runtime: "claude", target: commandsPath(companionPath, "opsx") },
    });
  });

  test("Claude disabled removes the links and prunes the empty folder", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-command-disabled-");
    await reconcileWorkingRepoClaudeCommandLinks(repoPath, companionPath, true, [companionPath]);

    await expect(
      reconcileWorkingRepoClaudeCommandLinks(repoPath, companionPath, false, [companionPath]),
    ).resolves.toBe("written");

    await expect(fs.access(path.join(repoPath, ".claude"))).rejects.toThrow();
    expect(await fs.readFile(commandsPath(companionPath, "opsx", "propose.md"), "utf8")).toBe(
      "companion propose\n",
    );
  });

  test("removal keeps user commands and is idempotent", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-command-remove-");
    await reconcileWorkingRepoClaudeCommandLinks(repoPath, companionPath, true, [companionPath]);
    const userFile = commandsPath(repoPath, "deploy.md");
    await fs.writeFile(userFile, "deploy\n", "utf8");

    await expect(removeWorkingRepoClaudeCommandLinks(repoPath, [companionPath])).resolves.toBe(
      "removed",
    );
    await expect(removeWorkingRepoClaudeCommandLinks(repoPath, [companionPath])).resolves.toBe(
      "absent",
    );

    await expect(fs.lstat(commandsPath(repoPath, "opsx"))).rejects.toThrow();
    expect(await fs.readFile(userFile, "utf8")).toBe("deploy\n");
  });

  test("skill and command reconciles keep each other's records", async () => {
    const { repoPath, companionPath } = await makeFixture("claude-command-coexist-");
    const skill = path.join(companionPath, ".claude", "skills", "acme");
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, "SKILL.md"), "acme\n", "utf8");

    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true, [companionPath]);
    await reconcileWorkingRepoClaudeCommandLinks(repoPath, companionPath, true, [companionPath]);
    expect(Object.keys(links(await readManifest(repoPath), "claude")).toSorted()).toEqual([
      ".claude/commands/opsx",
      ".claude/skills/acme",
    ]);
    await fs.rm(skill, { recursive: true });
    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true, [companionPath]);

    expect(links(await readManifest(repoPath), "claude")).toEqual({
      ".claude/commands/opsx": { runtime: "claude", target: commandsPath(companionPath, "opsx") },
    });
  });
});

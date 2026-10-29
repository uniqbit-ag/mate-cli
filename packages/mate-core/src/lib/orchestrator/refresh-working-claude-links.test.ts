import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { reconcileWorkingRepoClaudeCommandLinks } from "./projection-claude-commands";
import { reconcileWorkingRepoClaudeSkillLinks } from "./projection-claude-skills";
import { refreshWorkingClaudeLinks, type LinkRefreshDeps } from "./refresh-working-claude-links";
import type { FrameworkConfig } from "./types";

const CLAUDE: FrameworkConfig = { type: "companion", allowedAgents: ["claude"] };

let root: string;
let companionPath: string;
let repoPath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "refresh-claude-links-"));
  companionPath = path.join(root, "companion");
  repoPath = path.join(root, "repo");
  await fs.mkdir(repoPath, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function addSkill(name: string): Promise<void> {
  const dir = path.join(companionPath, ".claude", "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `${name}\n`);
}

function deps(overrides: Partial<LinkRefreshDeps> = {}): LinkRefreshDeps {
  return {
    readRegistry: async () => [{ id: "acme/shop", path: repoPath }],
    isWrappedForClaude: async () => true,
    registeredCompanionPaths: async () => [companionPath],
    reconcileSkillLinks: reconcileWorkingRepoClaudeSkillLinks,
    reconcileCommandLinks: reconcileWorkingRepoClaudeCommandLinks,
    ...overrides,
  };
}

const skillLinks = (): Promise<string[]> =>
  fs.readdir(path.join(repoPath, ".claude", "skills")).then((names) => names.toSorted());

describe("refreshWorkingClaudeLinks", () => {
  test("links an added skill and withdraws the link of a removed one", async () => {
    await addSkill("mate-artifact-publish");
    await reconcileWorkingRepoClaudeSkillLinks(repoPath, companionPath, true, [companionPath]);
    expect(await skillLinks()).toEqual(["mate-artifact-publish"]);

    // The update renames the skill: the old directory goes, the new one arrives.
    await fs.rm(path.join(companionPath, ".claude", "skills", "mate-artifact-publish"), {
      recursive: true,
    });
    await addSkill("mate-publish-artifact");

    const results = await refreshWorkingClaudeLinks(companionPath, CLAUDE, deps());
    expect(results).toEqual([
      { repository: { id: "acme/shop", path: repoPath }, outcome: "written" },
    ]);
    expect(await skillLinks()).toEqual(["mate-publish-artifact"]);
  });

  test("withdraws the links of removed OpenSpec skills and opsx commands", async () => {
    await addSkill("openspec-explore");
    await addSkill("mate-explore-change");
    const opsx = path.join(companionPath, ".claude", "commands", "opsx");
    await fs.mkdir(opsx, { recursive: true });
    await fs.writeFile(path.join(opsx, "propose.md"), "propose\n");
    await refreshWorkingClaudeLinks(companionPath, CLAUDE, deps());
    expect(await skillLinks()).toEqual(["mate-explore-change", "openspec-explore"]);
    await expect(fs.access(path.join(repoPath, ".claude", "commands", "opsx"))).resolves.toBeNull();

    // Companion update removes the OpenSpec-generated output.
    await fs.rm(path.join(companionPath, ".claude", "skills", "openspec-explore"), {
      recursive: true,
    });
    await fs.rm(path.join(companionPath, ".claude", "commands"), { recursive: true });

    await refreshWorkingClaudeLinks(companionPath, CLAUDE, deps());
    expect(await skillLinks()).toEqual(["mate-explore-change"]);
    await expect(fs.lstat(path.join(repoPath, ".claude", "commands", "opsx"))).rejects.toThrow();
  });

  test("reports current when the links already match", async () => {
    await addSkill("mate-show-me");
    await refreshWorkingClaudeLinks(companionPath, CLAUDE, deps());
    const results = await refreshWorkingClaudeLinks(companionPath, CLAUDE, deps());
    expect(results.map((result) => result.outcome)).toEqual(["current"]);
  });

  test("leaves a repository that is not wrapped for Claude alone", async () => {
    await addSkill("mate-show-me");
    const reconcileSkillLinks = mock(reconcileWorkingRepoClaudeSkillLinks);
    const results = await refreshWorkingClaudeLinks(
      companionPath,
      CLAUDE,
      deps({ isWrappedForClaude: async () => false, reconcileSkillLinks }),
    );
    expect(results).toEqual([]);
    expect(reconcileSkillLinks).not.toHaveBeenCalled();
  });

  test("withdraws the links when the companion no longer allows Claude", async () => {
    await addSkill("mate-show-me");
    await refreshWorkingClaudeLinks(companionPath, CLAUDE, deps());
    await refreshWorkingClaudeLinks(
      companionPath,
      { type: "companion", allowedAgents: ["opencode"] },
      deps(),
    );
    await expect(fs.access(path.join(repoPath, ".claude", "skills"))).rejects.toThrow();
  });

  test("reports a failing repository and continues with the next", async () => {
    await addSkill("mate-show-me");
    const other = path.join(root, "other");
    await fs.mkdir(other);
    const results = await refreshWorkingClaudeLinks(
      companionPath,
      CLAUDE,
      deps({
        readRegistry: async () => [
          { id: "acme/broken", path: "/nonexistent/broken" },
          { id: "acme/other", path: other },
        ],
        isWrappedForClaude: async (candidate) => {
          if (candidate === "/nonexistent/broken") throw new Error("unreadable manifest");
          return true;
        },
      }),
    );
    expect(results.map((result) => [result.repository?.id, result.outcome])).toEqual([
      ["acme/broken", "failed"],
      ["acme/other", "written"],
    ]);
    expect(results[0].error).toBe("unreadable manifest");
  });

  test("reports an unreadable repository list as one failure", async () => {
    const results = await refreshWorkingClaudeLinks(
      companionPath,
      CLAUDE,
      deps({
        readRegistry: async () => {
          throw new Error("bad registry");
        },
      }),
    );
    expect(results).toEqual([{ repository: null, outcome: "failed", error: "bad registry" }]);
  });
});

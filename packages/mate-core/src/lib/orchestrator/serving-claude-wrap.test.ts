import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree } from "../../../test/git-checkouts";
import { linkedClone, type LinkedClone } from "../../../test/linked-clone";
import { planClaudeDelivery } from "../../runtime/claude-delivery-plan";
import { readWrapStateSync, joinedClaudeWrapState } from "../../runtime/wrap-state";
import { reconcileWorkingRepoClaudeSkillLinks } from "./projection-claude-skills";
import { runtimeDocumentDeps } from "./projection-runtime-documents";
import { writeRepoLocalRegistryEntry } from "./repository-link";
import { reconcileServingClaudeWrap } from "./serving-claude-wrap";
import { runWrapPass } from "./wrap-pass";

/** The main worktree's Claude wrap serves its linked worktrees (design Decisions 12 and 13). */

const roots: string[] = [];
const originalHomeDir = runtimeDocumentDeps.homeDir;

afterEach(async () => {
  runtimeDocumentDeps.homeDir = originalHomeDir;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface Served extends LinkedClone {
  worktree: string;
}

/** A linked clone with an adopted sibling worktree; `~/.claude.json` lands in the clone's folder. */
async function servedClone(): Promise<Served> {
  const clone = await linkedClone(roots);
  const home = path.join(clone.root, "home");
  await fs.mkdir(home);
  runtimeDocumentDeps.homeDir = () => home;
  const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
  await writeRepoLocalRegistryEntry(
    worktree,
    clone.companionPath,
    { id: "acme", path: worktree },
    "git",
  );
  return { ...clone, worktree };
}

const worktreeRepository = (clone: Served) => ({ id: "acme", path: clone.worktree });
const mainRepository = (clone: Served) => ({ id: "acme", path: clone.main });

async function settingsHooks(checkout: string): Promise<Record<string, unknown[]>> {
  const raw = await fs
    .readFile(path.join(checkout, ".claude", "settings.local.json"), "utf8")
    .catch(() => "{}");
  return (JSON.parse(raw) as { hooks?: Record<string, unknown[]> }).hooks ?? {};
}

function groupKeys(hooks: Record<string, unknown[]>): string[] {
  return Object.entries(hooks).flatMap(([event, groups]) =>
    groups.map((group) => `${event}:${JSON.stringify(group)}`),
  );
}

describe("reconcileServingClaudeWrap", () => {
  test("never creates a missing serving wrap unless asked to", async () => {
    const clone = await servedClone();

    expect(
      await reconcileServingClaudeWrap(clone.companionPath, worktreeRepository(clone), {
        create: false,
      }),
    ).toBeNull();
    expect(readWrapStateSync(clone.main).runtimes.has("claude")).toBe(false);
  });

  test("creates it when asked, and reconciles an existing one either way", async () => {
    const clone = await servedClone();

    const created = await reconcileServingClaudeWrap(
      clone.companionPath,
      worktreeRepository(clone),
      { create: true },
    );
    const reconciled = await reconcileServingClaudeWrap(
      clone.companionPath,
      worktreeRepository(clone),
      { create: false },
    );

    expect(created?.repository).toEqual(mainRepository(clone));
    expect(created?.result.kind).toBe("written");
    expect(reconciled?.result.kind).toBe("current");
    expect(readWrapStateSync(clone.main).runtimes.has("claude")).toBe(true);
  });

  test("a main worktree serves itself", async () => {
    const clone = await servedClone();

    expect(
      await reconcileServingClaudeWrap(clone.companionPath, mainRepository(clone), {
        create: true,
      }),
    ).toBeNull();
  });
});

describe("a worktree's own Claude wrap beside the serving one", () => {
  test("leaves out every hook group the serving wrap carries, so each loads once", async () => {
    const clone = await servedClone();
    await runWrapPass(clone.companionPath, mainRepository(clone), { runtimes: ["claude"] });

    await runWrapPass(clone.companionPath, worktreeRepository(clone), { runtimes: ["claude"] });

    const main = groupKeys(await settingsHooks(clone.main));
    const own = groupKeys(await settingsHooks(clone.worktree));
    expect(main.length).toBeGreaterThan(0);
    expect(own.filter((key) => main.includes(key))).toEqual([]);
    expect(readWrapStateSync(clone.worktree).carriedClaudeHookGroups).toEqual([]);
    expect(readWrapStateSync(clone.worktree).runtimes.has("claude")).toBe(true);
  });

  test("carries the hook groups itself while no serving wrap exists", async () => {
    const clone = await servedClone();

    await runWrapPass(clone.companionPath, worktreeRepository(clone), { runtimes: ["claude"] });

    expect(JSON.stringify(await settingsHooks(clone.worktree))).toContain("session-prepare");
  });

  test("a launch in the worktree leaves to the wraps every hook group either carries", async () => {
    const clone = await servedClone();
    const main = await runWrapPass(clone.companionPath, mainRepository(clone), {
      runtimes: ["claude"],
    });
    const own = await runWrapPass(clone.companionPath, worktreeRepository(clone), {
      runtimes: ["claude"],
    });
    if (main.kind === "failed" || own.kind === "failed") throw new Error("wrap failed");

    const plan = planClaudeDelivery(
      "managed-repo",
      joinedClaudeWrapState(own.wrapState, main.wrapState),
    );

    expect(plan.hooks.launchSettingsExclude).toEqual(main.wrapState.carriedClaudeHookGroups);
  });
});

describe("companion skill links in a served worktree", () => {
  async function companionSkill(clone: Served): Promise<void> {
    const skill = path.join(clone.companionPath, ".claude", "skills", "acme-skill");
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, "SKILL.md"), "# acme\n");
  }

  const skills = (checkout: string) => path.join(checkout, ".claude", "skills");

  test("none in the worktree while the main worktree carries them, withdrawing earlier ones", async () => {
    const clone = await servedClone();
    await companionSkill(clone);
    await reconcileWorkingRepoClaudeSkillLinks(clone.worktree, clone.companionPath, true);
    expect(await fs.readdir(skills(clone.worktree))).toEqual(["acme-skill"]);

    await reconcileWorkingRepoClaudeSkillLinks(clone.main, clone.companionPath, true);
    await reconcileWorkingRepoClaudeSkillLinks(clone.worktree, clone.companionPath, true);

    expect(await fs.readdir(skills(clone.main))).toEqual(["acme-skill"]);
    expect(await fs.exists(skills(clone.worktree))).toBe(false);
  });

  test("links as before in a worktree whose .claude/skills holds the operator's own", async () => {
    const clone = await servedClone();
    await companionSkill(clone);
    await reconcileWorkingRepoClaudeSkillLinks(clone.main, clone.companionPath, true);
    await fs.mkdir(path.join(skills(clone.worktree), "own-skill"), { recursive: true });

    await reconcileWorkingRepoClaudeSkillLinks(clone.worktree, clone.companionPath, true);

    expect((await fs.readdir(skills(clone.worktree))).toSorted()).toEqual([
      "acme-skill",
      "own-skill",
    ]);
  });
});

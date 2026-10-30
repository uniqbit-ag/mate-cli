import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { addWorktree } from "../../../test/git-checkouts";
import { linkedClone, type LinkedClone } from "../../../test/linked-clone";
import { CLAUDE_SETTINGS_DOCUMENT, manifestPath } from "../../runtime/runtime-document-manifest";
import { collectDoctorReport, runDoctorCommand } from "./doctor";

/** The doctor's Checkout section (share-repository-link-across-worktrees, design Decision 15). */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const PREPARE = {
  hooks: [{ type: "command", command: "node /acme/claude-plugin/hooks/session-prepare.mjs" }],
};
const BANNER = { hooks: [{ type: "command", command: "node /acme/banner.mjs" }] };

/** A Claude wrap whose settings carry `groups` at SessionStart. */
function wrapForClaude(checkout: string, groups: object[]): void {
  fs.writeFileSync(
    manifestPath(checkout),
    JSON.stringify({
      documents: {
        [CLAUDE_SETTINGS_DOCUMENT]: [
          { at: ["hooks", "SessionStart"], kind: "list", values: groups },
        ],
      },
    }),
  );
}

function depsIn(clone: LinkedClone, cwd: string) {
  return {
    cwd,
    globalConfigStore: clone.store,
    pathValue: "",
    hydratePlugins: async () => {},
    inspectPlugins: async () => ({ failures: [], capabilities: [] }),
    inspectClaudePlugins: () => ({ plugins: [], failures: [] }),
  };
}

function doctorIn(clone: LinkedClone, cwd: string) {
  return collectDoctorReport(depsIn(clone, cwd));
}

async function renderedDoctorIn(clone: LinkedClone, cwd: string): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation(
    (...args: unknown[]) => void lines.push(args.join(" ")),
  );
  try {
    await runDoctorCommand([], depsIn(clone, cwd));
  } finally {
    log.mockRestore();
  }
  return lines.join("\n");
}

describe("mate doctor in the Checkouts of one clone", () => {
  test("names the Registered Checkout in it", async () => {
    const clone = await linkedClone(roots);
    const report = await doctorIn(clone, clone.main);
    expect(report.checkout).toEqual({
      root: clone.main,
      role: "registered",
      repositoryId: "acme",
      registeredCheckout: clone.main,
      servingClaudeWrap: clone.main,
    });
  });

  test("names another Checkout, its Registered Checkout and the Claude wrap serving it", async () => {
    const clone = await linkedClone(roots);
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    const report = await doctorIn(clone, path.join(worktree, "."));
    expect(report.checkout).toMatchObject({
      root: worktree,
      role: "other",
      repositoryId: "acme",
      registeredCheckout: clone.main,
      servingClaudeWrap: clone.main,
    });
    expect(report.checkout?.servingWrapWarning).toBeUndefined();
    expect(await renderedDoctorIn(clone, worktree)).toContain("another Checkout of acme");
  });

  test("warns when the serving wrap carries no session-prepare hook for a Checkout wrapped for Claude", async () => {
    const clone = await linkedClone(roots);
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    wrapForClaude(clone.main, [BANNER]);
    const warning = (await doctorIn(clone, worktree)).checkout?.servingWrapWarning;
    expect(warning).toContain(path.join(clone.main, ".claude", "settings.local.json"));
    expect(warning).toContain("mate wrap");
  });

  test("stays quiet once either settings file carries the session-prepare hook", async () => {
    const clone = await linkedClone(roots);
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    wrapForClaude(clone.main, [BANNER, PREPARE]);
    expect((await doctorIn(clone, worktree)).checkout?.servingWrapWarning).toBeUndefined();

    wrapForClaude(clone.main, [BANNER]);
    wrapForClaude(worktree, [PREPARE]);
    expect((await doctorIn(clone, worktree)).checkout?.servingWrapWarning).toBeUndefined();
  });

  test("stays quiet for a Checkout wrapped for no Claude", async () => {
    const clone = await linkedClone(roots);
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    expect((await doctorIn(clone, worktree)).checkout?.servingWrapWarning).toBeUndefined();
  });

  test("names a moved worktree its clone no longer recognizes, and `git worktree repair`", async () => {
    const clone = await linkedClone(roots);
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    const moved = path.join(clone.root, "acme-moved");
    fs.renameSync(worktree, moved);
    const report = await doctorIn(clone, moved);
    expect(report.checkout).toMatchObject({
      root: fs.realpathSync(moved),
      role: "not-recognized",
      registeredCheckout: null,
    });
    expect(await renderedDoctorIn(clone, moved)).toContain("git worktree repair");
  });
});

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, initRepo } from "../../test/git-checkouts";
import { createTempDir } from "../../../../test/fixtures";
import { companionFrameworkConfigPath } from "../runtime/policy";
import { buildRtkWorktreeGit } from "./rtk-worktree-git";

const roots: string[] = [];
const SHIM = path.resolve(import.meta.dirname, "../../claude-plugin/hooks/rtk-worktree-git.mjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function enteredWorktree() {
  const root = await createTempDir("mate-rtk-worktree-git-");
  roots.push(root);
  const main = initRepo(path.join(root, "acme"));
  const worktree = addWorktree(main, path.join(root, "acme.worktrees", "ws1"));
  return { root, main, worktree };
}

function payload(cwd: string, command: string) {
  return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd };
}

const selected = { rtkSelected: () => true };
const rewrite = (command: string) =>
  command.startsWith("git ")
    ? command.replace(/^git /, "rtk git ").replace("&& ls", "&& rtk ls")
    : null;

describe("rtk worktree git hook", () => {
  test("denies git in a moved session, naming the runnable command", async () => {
    const { main, worktree } = await enteredWorktree();
    const env = { CLAUDE_PROJECT_DIR: main };

    const output = JSON.parse(
      buildRtkWorktreeGit(payload(worktree, "git status --short"), env, { ...selected, rewrite })
        .stdout,
    );
    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
      "Run instead: RTK_DISABLED=1 git status --short",
    );
    expect(output.hookSpecificOutput.updatedInput).toBeUndefined();

    const chain = JSON.parse(
      buildRtkWorktreeGit(payload(worktree, "git status && ls"), env, { ...selected, rewrite })
        .stdout,
    );
    expect(chain.hookSpecificOutput.permissionDecisionReason).toContain(
      "Run instead: RTK_DISABLED=1 git status && rtk ls",
    );
  });

  test("stays silent without RTK, outside a moved session, and for commands RTK runs no git for", async () => {
    const { main, worktree } = await enteredWorktree();
    const moved = { CLAUDE_PROJECT_DIR: main };
    const silent = { exitCode: 0, stdout: "" };

    expect(
      buildRtkWorktreeGit(payload(worktree, "git status"), moved, {
        rtkSelected: () => false,
        rewrite,
      }),
    ).toEqual(silent);
    expect(
      buildRtkWorktreeGit(
        payload(worktree, "git status"),
        { CLAUDE_PROJECT_DIR: worktree },
        {
          ...selected,
          rewrite,
        },
      ),
    ).toEqual(silent);
    expect(
      buildRtkWorktreeGit(payload(main, "git status"), moved, { ...selected, rewrite }),
    ).toEqual(silent);
    expect(
      buildRtkWorktreeGit(payload(worktree, "RTK_DISABLED=1 git status"), moved, {
        ...selected,
        rewrite,
      }),
    ).toEqual(silent);
    expect(
      buildRtkWorktreeGit(payload(worktree, "git status"), moved, {
        ...selected,
        rewrite: () => null,
      }),
    ).toEqual(silent);
  });

  test("malformed input yields no output", () => {
    expect(buildRtkWorktreeGit(null, {}, selected)).toEqual({ exitCode: 0, stdout: "" });
    expect(buildRtkWorktreeGit({ cwd: "/acme" }, {}, selected)).toEqual({
      exitCode: 0,
      stdout: "",
    });
    expect(buildRtkWorktreeGit({ tool_input: { command: "git status" } }, {}, selected)).toEqual({
      exitCode: 0,
      stdout: "",
    });
  });

  test("the plugin shim asks rtk and denies only where the module does", async () => {
    const { root, main, worktree } = await enteredWorktree();
    const companion = path.join(root, "acme-companion");
    const config = companionFrameworkConfigPath(companion);
    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.writeFile(config, "capabilities:\n  - name: rtk\n");
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(
      path.join(bin, "rtk"),
      '#!/bin/sh\ncase "$2" in git*) echo "rtk $2"; exit 3;; *) exit 1;; esac\n',
      { mode: 0o755 },
    );
    const env = {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? root,
      CLAUDE_PROJECT_DIR: main,
      MATE_ARTIFACT_PATH: companion,
    };
    const run = (cwd: string, command: string) =>
      spawnSync("node", [SHIM], {
        input: JSON.stringify(payload(cwd, command)),
        encoding: "utf8",
        env,
      });

    const denied = run(worktree, "git status");
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason).toContain(
      "Run instead: RTK_DISABLED=1 git status",
    );
    expect(run(main, "git status").stdout).toBe("");
    expect(run(worktree, "ls -la").stdout).toBe("");
  }, 20000);
});

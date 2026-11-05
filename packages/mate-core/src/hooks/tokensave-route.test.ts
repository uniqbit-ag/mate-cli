import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, initRepo } from "../../test/git-checkouts";
import { createTempDir } from "../../../../test/fixtures";
import { TOKENSAVE_DB } from "../runtime/tokensave-route";
import { buildTokensaveRoute } from "./tokensave-route";

const roots: string[] = [];
const SHIM = path.resolve(import.meta.dirname, "../../claude-plugin/hooks/tokensave-route.mjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function indexedWorktree() {
  const root = await createTempDir("mate-tokensave-hook-");
  roots.push(root);
  const main = initRepo(path.join(root, "acme"));
  const worktree = addWorktree(main, path.join(root, "acme.worktrees", "fix"));
  for (const checkout of [main, worktree]) {
    await fs.mkdir(path.join(checkout, ".tokensave"), { recursive: true });
    await fs.writeFile(path.join(checkout, TOKENSAVE_DB), "");
  }
  return { main, worktree };
}

function payload(cwd: string, toolInput: Record<string, unknown> = { query: "alpha" }) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "mcp__tokensave__tokensave_search",
    tool_input: toolInput,
    cwd,
  };
}

describe("tokensave route hook", () => {
  test("rewrites a call from an indexed worktree, with no permission decision", async () => {
    const { worktree } = await indexedWorktree();
    const output = JSON.parse(buildTokensaveRoute(payload(worktree)).stdout);

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { query: "alpha", graph_root: worktree },
      },
    });
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test("stays silent in the main checkout, without a cwd, and on input that is not JSON", async () => {
    const { main } = await indexedWorktree();

    expect(buildTokensaveRoute(payload(main))).toEqual({ exitCode: 0, stdout: "" });
    expect(buildTokensaveRoute({ tool_input: {} })).toEqual({ exitCode: 0, stdout: "" });
    expect(buildTokensaveRoute(null)).toEqual({ exitCode: 0, stdout: "" });
  });

  test("a second loaded copy adds nothing to a routed call", async () => {
    const { worktree } = await indexedWorktree();
    const first = JSON.parse(buildTokensaveRoute(payload(worktree)).stdout);

    expect(
      buildTokensaveRoute(payload(worktree, first.hookSpecificOutput.updatedInput)).stdout,
    ).toBe("");
  });

  test("the plugin shim emits what the module builds", async () => {
    const { worktree, main } = await indexedWorktree();
    const run = (cwd: string) =>
      spawnSync("node", [SHIM], { input: JSON.stringify(payload(cwd)), encoding: "utf8" });

    const routed = run(worktree);
    expect(routed.status).toBe(0);
    expect(routed.stdout).toBe(buildTokensaveRoute(payload(worktree)).stdout);
    expect(run(main).stdout).toBe("");
  }, 20000);
});

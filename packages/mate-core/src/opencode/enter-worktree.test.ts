import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, initRepo } from "../../test/git-checkouts";
import { companionLinkPath } from "../runtime/repo-local";
import type { CompanionContext } from "./companion-policy";
import { ENTER_WORKTREE_TOOL, registerEnterWorktree } from "./enter-worktree";

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Execute = (
  input: unknown,
  tool: { sessionID: string },
) => Promise<{ content: string; metadata: Record<string, unknown> }>;

/** `<root>/web` linked to `<root>/companion`, with a worktree at `<root>/web.worktrees/acme-fix`. */
function layout() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-enter-")));
  tempRoots.push(root);
  const companionPath = path.join(root, "companion");
  fs.mkdirSync(companionPath);
  const web = initRepo(path.join(root, "web"));
  const worktree = addWorktree(web, path.join(root, "web.worktrees", "acme-fix"));
  linkTo(worktree, companionPath);
  return { root, companionPath, web, worktree };
}

function linkTo(repo: string, companion: string): void {
  fs.mkdirSync(path.dirname(companionLinkPath(repo)), { recursive: true });
  fs.symlinkSync(companion, companionLinkPath(repo));
}

async function tool(context: Partial<CompanionContext>) {
  const moves: unknown[] = [];
  let execute: Execute | undefined;
  const api = {
    tool: {
      transform: async (transform: (editor: { add: (tool: unknown) => void }) => void) => {
        transform({
          add: (entry) => {
            const added = entry as { name: string; execute: Execute };
            if (added.name === ENTER_WORKTREE_TOOL) execute = added.execute;
          },
        });
      },
    },
    session: { move: async (input: unknown) => void moves.push(input) },
  };
  await registerEnterWorktree(
    api as never,
    {
      frameworkName: "mate",
      ...context,
    } as CompanionContext,
  );
  return {
    moves,
    execute: (target: unknown) => execute!({ path: target }, { sessionID: "ses_acme" }),
  };
}

describe("mate_enter_worktree", () => {
  test("moves the calling session into a worktree of its repository", async () => {
    const { companionPath, web, worktree } = layout();
    const { moves, execute } = await tool({ companionPath, repositoryPath: web });
    const result = await execute(worktree);
    expect(moves).toEqual([{ sessionID: "ses_acme", directory: worktree }]);
    expect(result.metadata).toEqual({ moved: true, directory: worktree });
    expect(result.content).toContain(worktree);
  });

  test("refuses a folder inside a worktree and says it must be the root", async () => {
    const { companionPath, web, worktree } = layout();
    const inner = path.join(worktree, "packages", "acme");
    fs.mkdirSync(inner, { recursive: true });
    const { moves, execute } = await tool({ companionPath, repositoryPath: web });
    const result = await execute(inner);
    expect(moves).toEqual([]);
    expect(result.content).toContain(`${inner} is not the root of a Git worktree`);
  });

  test("refuses a worktree of another repository", async () => {
    const { root, companionPath, web } = layout();
    const api = initRepo(path.join(root, "api"));
    const other = addWorktree(api, path.join(root, "api.worktrees", "acme-fix"));
    linkTo(other, companionPath);
    const { moves, execute } = await tool({ companionPath, repositoryPath: web });
    const result = await execute(other);
    expect(moves).toEqual([]);
    expect(result.metadata).toEqual({ moved: false });
    expect(result.content).toContain(`is not a linked worktree of ${web}`);
  });

  test("refuses a plain directory and the main checkout", async () => {
    const { root, companionPath, web } = layout();
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    const { moves, execute } = await tool({ companionPath, repositoryPath: web });
    expect((await execute(plain)).metadata).toEqual({ moved: false });
    expect((await execute(web)).metadata).toEqual({ moved: false });
    expect(moves).toEqual([]);
  });

  test("refuses a worktree linked to another companion", async () => {
    const { root, web } = layout();
    const other = path.join(root, "other-companion");
    fs.mkdirSync(other);
    const { moves, execute } = await tool({ companionPath: other, repositoryPath: web });
    const result = await execute(path.join(root, "web.worktrees", "acme-fix"));
    expect(moves).toEqual([]);
    expect(result.content).toContain(`is not linked to the companion ${other}`);
  });

  test("refuses input without a path", async () => {
    const { companionPath, web } = layout();
    const { moves, execute } = await tool({ companionPath, repositoryPath: web });
    expect((await execute(undefined)).content).toContain("the path must be a string");
    expect(moves).toEqual([]);
  });
});

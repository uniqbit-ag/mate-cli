import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, initRepo } from "../../test/git-checkouts";
import { createTempDir } from "../../../../test/fixtures";
import { routeTokensaveInput, TOKENSAVE_DB } from "./tokensave-route";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await createTempDir("mate-tokensave-route-");
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function indexed(checkout: string): Promise<string> {
  await fs.mkdir(path.join(checkout, ".tokensave"), { recursive: true });
  await fs.writeFile(path.join(checkout, TOKENSAVE_DB), "");
  return checkout;
}

async function checkouts() {
  const main = initRepo(path.join(await tempRoot(), "acme"));
  const worktree = addWorktree(main, path.join(path.dirname(main), "acme.worktrees", "fix"));
  return { main, worktree };
}

describe("routeTokensaveInput", () => {
  test("an indexed linked worktree sets graph_root to its root, from any folder inside", async () => {
    const { main, worktree } = await checkouts();
    await indexed(main);
    await indexed(worktree);
    const nested = path.join(worktree, "src", "acme");
    await fs.mkdir(nested, { recursive: true });

    expect(routeTokensaveInput(worktree, { query: "alpha" })).toEqual({
      query: "alpha",
      graph_root: worktree,
    });
    expect(routeTokensaveInput(nested, { query: "alpha" })).toEqual({
      query: "alpha",
      graph_root: worktree,
    });
    expect(routeTokensaveInput(worktree, undefined)).toEqual({ graph_root: worktree });
  });

  test("the main checkout passes unchanged", async () => {
    const { main } = await checkouts();
    await indexed(main);

    expect(routeTokensaveInput(main, { query: "alpha" })).toBeUndefined();
  });

  test("a worktree without an index passes unchanged and gets none", async () => {
    const { main, worktree } = await checkouts();
    await indexed(main);

    expect(routeTokensaveInput(worktree, { query: "alpha" })).toBeUndefined();
    expect(await fs.exists(path.join(worktree, ".tokensave"))).toBe(false);
  });

  test("an explicit graph_root wins", async () => {
    const { worktree } = await checkouts();
    await indexed(worktree);

    expect(routeTokensaveInput(worktree, { graph_root: "/src/other" })).toBeUndefined();
  });

  test("a folder outside Git passes unchanged", async () => {
    const plain = await tempRoot();

    expect(routeTokensaveInput(plain, { query: "alpha" })).toBeUndefined();
  });

  test("an unreadable layout or a missing folder passes unchanged", async () => {
    const broken = await tempRoot();
    await fs.writeFile(path.join(broken, ".git"), "gitdir: /nonexistent/acme\n");
    await indexed(broken);

    expect(routeTokensaveInput(broken, { query: "alpha" })).toBeUndefined();
    expect(routeTokensaveInput(path.join(broken, "gone"), { query: "alpha" })).toBeUndefined();
    expect(routeTokensaveInput(broken, "not an object")).toBeUndefined();
  });
});

import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, initRepo } from "../../test/git-checkouts";
import { createTempDir } from "../../../../test/fixtures";
import {
  isRoutableTokensaveTool,
  refreshWorktreeIndex,
  ROUTE_SYNC_MARKER,
  routeTokensaveInput,
  TOKENSAVE_DB,
} from "./tokensave-route";

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

const SEARCH = "mcp__tokensave__tokensave_search";

function route(directory: string, input: unknown, tool = SEARCH, refresh = () => {}) {
  return routeTokensaveInput(tool, directory, input, { refresh });
}

describe("routeTokensaveInput", () => {
  test("an indexed linked worktree sets graph_root to its root, from any folder inside", async () => {
    const { main, worktree } = await checkouts();
    await indexed(main);
    await indexed(worktree);
    const nested = path.join(worktree, "src", "acme");
    await fs.mkdir(nested, { recursive: true });

    expect(route(worktree, { query: "alpha" })).toEqual({
      query: "alpha",
      graph_root: worktree,
    });
    expect(route(nested, { query: "alpha" })).toEqual({
      query: "alpha",
      graph_root: worktree,
    });
    expect(route(worktree, undefined)).toEqual({ graph_root: worktree });
  });

  test("the main checkout passes unchanged", async () => {
    const { main } = await checkouts();
    await indexed(main);

    expect(route(main, { query: "alpha" })).toBeUndefined();
  });

  test("a worktree without an index passes unchanged and gets none", async () => {
    const { main, worktree } = await checkouts();
    await indexed(main);

    expect(route(worktree, { query: "alpha" })).toBeUndefined();
    expect(await fs.exists(path.join(worktree, ".tokensave"))).toBe(false);
  });

  test("an explicit graph_root wins", async () => {
    const { worktree } = await checkouts();
    await indexed(worktree);

    expect(route(worktree, { graph_root: "/src/other" })).toBeUndefined();
  });

  test("a folder outside Git passes unchanged", async () => {
    const plain = await tempRoot();

    expect(route(plain, { query: "alpha" })).toBeUndefined();
  });

  test("an unreadable layout or a missing folder passes unchanged", async () => {
    const broken = await tempRoot();
    await fs.writeFile(path.join(broken, ".git"), "gitdir: /nonexistent/acme\n");
    await indexed(broken);

    expect(route(broken, { query: "alpha" })).toBeUndefined();
    expect(route(path.join(broken, "gone"), { query: "alpha" })).toBeUndefined();
    expect(route(broken, "not an object")).toBeUndefined();
  });

  test("only graph query tools that take graph_root are routed, by Claude or OpenCode name", async () => {
    const { worktree } = await checkouts();
    await indexed(worktree);

    expect(route(worktree, { task: "alpha" }, "tokensave_tokensave_context")).toEqual({
      task: "alpha",
      graph_root: worktree,
    });
    for (const tool of [
      "mcp__tokensave__tokensave_str_replace",
      "mcp__tokensave__tokensave_more",
      "mcp__tokensave__tokensave_branch_search",
      "mcp__tokensave__tokensave_record_decision",
      "tokensave_tokensave_replace_lines",
    ]) {
      expect(route(worktree, { path: "src/acme.ts" }, tool)).toBeUndefined();
    }
  });

  test("a routed call refreshes the worktree index first; an unrouted one does not", async () => {
    const { main, worktree } = await checkouts();
    await indexed(main);
    await indexed(worktree);
    const refreshed: string[] = [];
    const refresh = (root: string) => refreshed.push(root);

    route(worktree, { query: "alpha" }, SEARCH, refresh);
    route(main, { query: "alpha" }, SEARCH, refresh);
    route(worktree, { path: "a" }, "mcp__tokensave__tokensave_str_replace", refresh);
    expect(refreshed).toEqual([worktree]);

    const failing = () => {
      throw new Error("tokensave missing");
    };
    expect(route(worktree, { query: "alpha" }, SEARCH, failing)).toEqual({
      query: "alpha",
      graph_root: worktree,
    });
  });

  test("inert at a mirrored umbrella worktree; routes inside its child worktree", async () => {
    const root = await tempRoot();
    const mirrored = path.join(root, "acme.worktrees", "acme-fix");
    await fs.mkdir(path.join(root, "acme"));
    const api = initRepo(path.join(root, "acme", "api"));
    const child = addWorktree(api, path.join(mirrored, "api"));
    await indexed(mirrored);
    await indexed(child);

    expect(route(mirrored, { query: "alpha" })).toBeUndefined();
    expect(route(child, { query: "alpha" })).toEqual({ query: "alpha", graph_root: child });
  });
});

describe("routeTokensaveInput with a served directory", () => {
  function served(directory: string, servedDirectory: string, refresh = () => {}) {
    return routeTokensaveInput(SEARCH, directory, { query: "alpha" }, { refresh, servedDirectory });
  }

  test("the served worktree passes unchanged and is not refreshed, from any folder inside", async () => {
    const { main, worktree } = await checkouts();
    await indexed(main);
    await indexed(worktree);
    const nested = path.join(worktree, "src", "acme");
    await fs.mkdir(nested, { recursive: true });
    const refreshed: string[] = [];
    const refresh = (root: string) => refreshed.push(root);

    expect(served(worktree, worktree, refresh)).toBeUndefined();
    expect(served(nested, worktree, refresh)).toBeUndefined();
    expect(served(worktree, nested, refresh)).toBeUndefined();
    expect(refreshed).toEqual([]);
  });

  test("a symlink to the served worktree counts as the served worktree", async () => {
    const { main, worktree } = await checkouts();
    await indexed(main);
    await indexed(worktree);
    const link = path.join(await tempRoot(), "acme-link");
    await fs.symlink(worktree, link);

    expect(served(worktree, link)).toBeUndefined();
    expect(served(link, worktree)).toBeUndefined();
  });

  test("a session served from the main checkout or another worktree is routed", async () => {
    const { main, worktree } = await checkouts();
    await indexed(main);
    await indexed(worktree);
    const other = addWorktree(main, path.join(path.dirname(main), "acme.worktrees", "other"));

    expect(served(worktree, main)).toEqual({ query: "alpha", graph_root: worktree });
    expect(served(worktree, other)).toEqual({ query: "alpha", graph_root: worktree });
    expect(served(worktree, "")).toEqual({ query: "alpha", graph_root: worktree });
  });
});

describe("isRoutableTokensaveTool", () => {
  test("names outside tokensave are not routable", () => {
    expect(isRoutableTokensaveTool("mcp__tokensave__tokensave_search")).toBe(true);
    expect(isRoutableTokensaveTool("acme_search")).toBe(false);
    expect(isRoutableTokensaveTool("execute")).toBe(false);
  });
});

describe("refreshWorktreeIndex", () => {
  test("a recent marker skips the sync", async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, ".tokensave"), { recursive: true });
    const marker = path.join(root, ROUTE_SYNC_MARKER);
    await fs.writeFile(marker, "");
    const before = (await fs.stat(marker)).mtimeMs;

    refreshWorktreeIndex(root);
    expect((await fs.stat(marker)).mtimeMs).toBe(before);
  });
});

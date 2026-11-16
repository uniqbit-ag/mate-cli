import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { umbrellaChildrenOf } from "../lib/orchestrator/umbrella-checkouts";
import { gitEnvironment } from "./companion-git";
import { repositoryPath } from "./forge-remote";
import { umbrellaChildIdentities } from "./umbrella-folder";

let root: string;
let umbrella: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-umbrella-ids-")));
  umbrella = path.join(root, "acme");
  fs.mkdirSync(umbrella);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Without an inherited `GIT_DIR`, which would point these calls at the outer repository. */
function git(...args: string[]): void {
  execFileSync("git", args, { env: gitEnvironment() });
}

function repo(dir: string, origin?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git("init", "-q", dir);
  if (origin) git("-C", dir, "remote", "add", "origin", origin);
  return dir;
}

describe("umbrellaChildIdentities", () => {
  test("names forge children in folder order, as umbrellaChildrenOf does", async () => {
    repo(path.join(umbrella, "web"), "https://github.com/acme/web.git");
    repo(path.join(umbrella, "api"), "git@github.com:acme/api.git");
    repo(path.join(umbrella, "scratch"));

    expect(umbrellaChildIdentities(umbrella)).toEqual([
      { path: path.join(umbrella, "api"), repository: "acme/api" },
      { path: path.join(umbrella, "web"), repository: "acme/web" },
    ]);
    const viaGit = await umbrellaChildrenOf(umbrella);
    expect(viaGit.map((child) => repositoryPath(child.remote!))).toEqual(["acme/api", "acme/web"]);
  });

  test("reads a worktree child's origin from its shared Git folder", () => {
    const api = repo(path.join(umbrella, "api"), "git@github.com:acme/api.git");
    git("-C", api, "commit", "-q", "--allow-empty", "-m", "init");
    const mirrored = path.join(root, "acme.worktrees", "acme-login");
    fs.mkdirSync(mirrored, { recursive: true });
    git("-C", api, "worktree", "add", "-q", path.join(mirrored, "api"));

    expect(umbrellaChildIdentities(mirrored)).toEqual([
      { path: path.join(mirrored, "api"), repository: "acme/api" },
    ]);
  });
});

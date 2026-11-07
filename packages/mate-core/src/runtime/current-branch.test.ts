import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { currentBranch } from "./current-branch";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-current-branch-")));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-C", cwd, "-c", "user.name=acme", "-c", "user.email=acme@example.com", ...args],
    { stdio: "ignore" },
  );
}

function link(folder: string): void {
  fs.mkdirSync(path.join(folder, ".mate", "config"), { recursive: true });
  fs.writeFileSync(path.join(folder, ".mate", "config", "registry.yaml"), "companions: []\n");
}

function umbrella(): string {
  const folder = path.join(root, "acme");
  for (const name of ["api", "web"]) {
    const child = path.join(folder, name);
    fs.mkdirSync(child, { recursive: true });
    git(child, "init", "-q", "-b", "main");
    git(child, "commit", "-q", "--allow-empty", "-m", "init");
  }
  link(folder);
  return folder;
}

describe("currentBranch", () => {
  test("the branch checked out in a checkout", async () => {
    const folder = umbrella();
    expect(await currentBranch(path.join(folder, "api"))).toBe("main");
  });

  test("null in an Umbrella Repository", async () => {
    expect(await currentBranch(umbrella())).toBeNull();
  });

  test("a mirrored worktree's first attached child's branch", async () => {
    const folder = umbrella();
    const mirrored = path.join(root, "acme.worktrees", "acme-fix");
    fs.mkdirSync(mirrored, { recursive: true });
    for (const name of ["api", "web"]) {
      git(
        path.join(folder, name),
        "worktree",
        "add",
        "-q",
        "-b",
        "workset/acme-fix",
        path.join(mirrored, name),
      );
    }
    link(mirrored);
    expect(await currentBranch(mirrored)).toBe("workset/acme-fix");

    git(path.join(mirrored, "web"), "switch", "-q", "-c", "spike");
    expect(await currentBranch(mirrored)).toBe("workset/acme-fix");

    git(path.join(mirrored, "api"), "switch", "-q", "--detach");
    expect(await currentBranch(mirrored)).toBe("spike");

    git(path.join(mirrored, "web"), "switch", "-q", "--detach");
    expect(await currentBranch(mirrored)).toBeNull();
  });
});

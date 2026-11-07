import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/** Test fixture: a linked umbrella `acme` with `api/` and `web/`, as mate-core lays it out. */

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run("git", ["-c", "user.name=acme", "-c", "user.email=acme@example.com", ...args], { cwd });

async function link(folder: string): Promise<void> {
  await fs.mkdir(path.join(folder, ".mate", "config"), { recursive: true });
  await fs.writeFile(path.join(folder, ".mate", "config", "registry.yaml"), "version: 1\n");
}

export interface UmbrellaFixture {
  root: string;
  umbrella: string;
  api: string;
  web: string;
  /** `<umbrella>.worktrees/acme-fix`, holding `api` and `web` on `workset/acme-fix`. */
  mirrored: string;
  /** A worktree of `api` outside the umbrella, on `spike`. */
  scratch: string;
  /** A folder neither in Git nor linked. */
  plain: string;
}

export async function umbrellaFixture(): Promise<UmbrellaFixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acme-umbrella-")));
  const umbrella = path.join(root, "acme");
  const mirrored = path.join(root, "acme.worktrees", "acme-fix");
  const scratch = path.join(root, "scratch");
  const plain = path.join(root, "plain");
  await Promise.all([link(umbrella), link(mirrored), fs.mkdir(plain)]);
  const children: string[] = [];
  for (const name of ["api", "web"]) {
    const child = path.join(umbrella, name);
    children.push(child);
    // oxlint-disable no-await-in-loop -- fixture setup, one child after another
    await fs.mkdir(child);
    await git(child, "init", "--quiet", "--initial-branch=main");
    await git(child, "remote", "add", "origin", `git@github.com:acme/${name}.git`);
    await git(child, "commit", "--quiet", "--allow-empty", "-m", "init");
    await git(
      child,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "workset/acme-fix",
      path.join(mirrored, name),
    );
    // oxlint-enable no-await-in-loop
  }
  await git(children[0]!, "worktree", "add", "--quiet", "-b", "spike", scratch);
  return { root, umbrella, api: children[0]!, web: children[1]!, mirrored, scratch, plain };
}

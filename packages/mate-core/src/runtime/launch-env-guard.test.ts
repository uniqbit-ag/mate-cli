import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hasLaunchEnvironment } from "./env";
import { guardLaunchEnvironment, launchEnvironmentApplies } from "./launch-env-guard";

let root: string;
let repo: string;
let companion: string;
let other: string;

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "acme",
      GIT_AUTHOR_EMAIL: "acme@example.com",
      GIT_COMMITTER_NAME: "acme",
      GIT_COMMITTER_EMAIL: "acme@example.com",
    },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acme-launch-env-")));
  repo = path.join(root, "acme");
  companion = path.join(root, "acme-companion");
  other = path.join(root, "acme-api");
  for (const dir of [repo, companion, other]) fs.mkdirSync(dir);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const launch = () => ({
  MATE_REPO_PATH: repo,
  MATE_ARTIFACT_PATH: companion,
  MATE_REPO_ID: "acme",
  MATE_POLICY_JSON: "{}",
});

describe("launch environment guard", () => {
  test("applies in the repository, a subfolder, a linked worktree, and the companion", () => {
    const sub = path.join(repo, "src");
    fs.mkdirSync(sub);
    const worktree = path.join(root, "acme.worktrees", "queue");
    git(repo, "worktree", "add", "-q", "-b", "workset/queue", worktree);
    for (const dir of [repo, sub, worktree, companion]) {
      expect(launchEnvironmentApplies(launch(), dir)).toBe(true);
    }
  });

  test("a foreign directory drops the whole launch environment", () => {
    const env: Record<string, string | undefined> = { ...launch(), PATH: "/bin" };
    guardLaunchEnvironment(env, other);
    expect(env).toEqual({ PATH: "/bin" });
    expect(hasLaunchEnvironment(env)).toBe(false);
  });

  test("the launch's own directory keeps it", () => {
    const env: Record<string, string | undefined> = launch();
    guardLaunchEnvironment(env, repo);
    expect(env).toEqual(launch());
  });

  test("empty values are dropped and do not count as a launch", () => {
    const env: Record<string, string | undefined> = {
      ...launch(),
      MATE_REACT_DOCTOR_BIN_PATH: "",
      MATE_GUIDANCE_JSON: "",
    };
    guardLaunchEnvironment(env, repo);
    expect(env).toEqual(launch());
    expect(hasLaunchEnvironment({ MATE_REPO_PATH: "", MATE_NAME: "" })).toBe(false);
  });

  test("an environment naming no Working Repository applies everywhere", () => {
    expect(launchEnvironmentApplies({ MATE_ARTIFACT_PATH: companion }, other)).toBe(true);
    expect(launchEnvironmentApplies({ MATE_NAME: "mate" }, other)).toBe(true);
  });
});

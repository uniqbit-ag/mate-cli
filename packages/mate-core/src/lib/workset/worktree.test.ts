import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { git, initRepo } from "../../../test/git-checkouts";
import { ARTIFACT_REFUSAL_HEADLINE } from "../../runtime/artifact-refusal";
import { MATE_ENV } from "../../runtime/env-names";
import { readProjectionFile } from "../../runtime/projection";
import { refreshRuntimeDirectory } from "../runtime-directory-refresh";
import { runtimeDocumentDeps } from "../orchestrator/projection-runtime-documents";
import { findRepoLocalLinkTo, writeRepoLocalRegistryEntry } from "../orchestrator/repository-link";
import { umbrellaChildrenOf } from "../orchestrator/umbrella-checkouts";
import { runWrapPass } from "../orchestrator/wrap-pass";
import { readWorksets } from "./record";
import {
  createChangeWorktrees,
  createWorksetWorktrees,
  type GitRunner,
  type GitRunOptions,
  type InstallRunner,
  pruneWorksetWorktrees,
  type WorktreeDeps,
} from "./worktree";

let root: string;
let companion: string;

beforeEach(() => {
  // Real path: macOS hands out /var/... for /private/var/...
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-worktree-")));
  companion = path.join(root, "acme-companion");
  fs.mkdirSync(path.join(companion, ".mate", "config"), { recursive: true });
  fs.writeFileSync(path.join(companion, ".mate", "config", "framework.yaml"), "type: companion\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A main checkout at `main` (default `<root>/src/<name>`) cloned from a local bare origin,
 * whose `origin` reads as `https://git.acme.test/acme/<name>.git` and fetches from the bare one.
 */
function checkout(
  name: string,
  files: Record<string, string> = {},
  main = path.join(root, "src", name),
): string {
  fs.mkdirSync(path.join(root, "sources"), { recursive: true });
  const source = initRepo(path.join(root, "sources", name));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), content);
  }
  if (Object.keys(files).length > 0) {
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "files");
  }
  const bare = path.join(root, "origins", `${name}.git`);
  git(root, "clone", "-q", "--bare", source, bare);
  fs.mkdirSync(path.dirname(main), { recursive: true });
  git(root, "clone", "-q", bare, main);
  const url = `https://git.acme.test/acme/${name}.git`;
  git(main, "remote", "set-url", "origin", url);
  git(main, "config", `url.${bare}.insteadOf`, url);
  return main;
}

function link(...checkouts: string[]): void {
  const repos = checkouts.map((repo) => `  - id: ${path.basename(repo)}\n    path: ${repo}\n`);
  fs.writeFileSync(
    path.join(companion, ".mate", "config", "registry.yaml"),
    `repos:\n${repos.join("")}`,
  );
}

function workset(id: string, ...repositories: string[]): void {
  listing(id, repositories, []);
}

function listing(id: string, repositories: string[], changes: string[]): void {
  fs.mkdirSync(path.join(companion, "worksets"), { recursive: true });
  fs.writeFileSync(
    path.join(companion, "worksets", `${id}.yaml`),
    `id: ${id}\ntitle: ${id}\nrepositories: [${repositories.join(", ")}]\nchanges: [${changes.join(", ")}]\n`,
  );
}

/** An active change whose proposal scopes name the repositories, each with area `.`. */
function change(name: string, ...repositories: string[]): void {
  const dir = path.join(companion, "openspec", "changes", name);
  fs.mkdirSync(dir, { recursive: true });
  const scopes = repositories.map((repository) => `  - repository: ${repository}\n    area: .\n`);
  fs.writeFileSync(
    path.join(dir, "proposal.md"),
    `---\nchange: ${name}\nscopes:\n${scopes.join("")}---\n\n## Why\n`,
  );
}

/** Writes the change's `delivery.yaml` from the lines after `change`. */
function record(name: string, body: string): void {
  fs.writeFileSync(
    path.join(companion, "openspec", "changes", name, "delivery.yaml"),
    `version: 1\nchange: ${name}\n${body}`,
  );
}

function branches(repo: string): string {
  return git(repo, "branch", "--list", "--format=%(refname:short) %(upstream:short)");
}

function installs(ok = true): { calls: [string, string[]][]; install: InstallRunner } {
  const calls: [string, string[]][] = [];
  return {
    calls,
    install: async (cwd, command) => {
      calls.push([cwd, command]);
      return ok;
    },
  };
}

const options = { install: true, streamInstall: false };

/** The real `git`, as a runner a test can wrap. */
const realGit: GitRunner = async (cwd, args) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
};

describe("createWorksetWorktrees", () => {
  test("one repository: a new branch from origin/HEAD, linked, with the companion registry unchanged", async () => {
    const web = checkout("web");
    link(web);
    workset("acme-login", "acme/web");
    const registry = fs.readFileSync(path.join(companion, ".mate", "config", "registry.yaml"));
    const result = await createWorksetWorktrees(companion, "acme-login", options);
    const target = path.join(root, "src", "web.worktrees", "acme-login");
    expect(result.ok).toBe(true);
    expect(result.repositories).toMatchObject([
      { repository: "acme/web", path: target, branch: "workset/acme-login", action: "created" },
    ]);
    expect(git(target, "symbolic-ref", "--short", "HEAD").trim()).toBe("workset/acme-login");
    expect(branches(web)).toContain("workset/acme-login \n");
    expect(fs.existsSync(path.join(target, ".mate"))).toBe(true);
    expect(fs.readFileSync(path.join(companion, ".mate", "config", "registry.yaml"))).toEqual(
      registry,
    );
  });

  test("a clone without origin/HEAD starts the new branch from origin/<default>", async () => {
    const web = checkout("web");
    git(web, "remote", "set-head", "origin", "--delete");
    // Git 2.48+ would otherwise recreate it on the plan-phase fetch.
    git(web, "config", "remote.origin.followRemoteHEAD", "never");
    link(web);
    workset("acme-login", "acme/web");
    const result = await createWorksetWorktrees(companion, "acme-login", options);
    const target = path.join(root, "src", "web.worktrees", "acme-login");
    expect(result.ok).toBe(true);
    expect(git(target, "rev-parse", "HEAD")).toBe(git(web, "rev-parse", "origin/main"));
  });

  test("the plan-phase fetch never prompts and is bounded", async () => {
    const web = checkout("web");
    link(web);
    workset("acme-login", "acme/web");
    const fetches: (GitRunOptions | undefined)[] = [];
    const recording: GitRunner = async (cwd, args, runOptions) => {
      if (args[0] === "fetch") fetches.push(runOptions);
      return realGit(cwd, args);
    };
    await createWorksetWorktrees(companion, "acme-login", options, { git: recording });
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.timeoutMs).toBeGreaterThan(0);
  });

  test("several repositories each get a worktree next to their main checkout", async () => {
    const web = checkout("web");
    const api = checkout("api");
    link(web, api);
    workset("acme-login", "acme/web", "acme/api");
    const result = await createWorksetWorktrees(companion, "acme-login", options);
    expect(result.ok).toBe(true);
    for (const name of ["web", "api"]) {
      expect(fs.existsSync(path.join(root, "src", `${name}.worktrees`, "acme-login", ".git"))).toBe(
        true,
      );
    }
  });

  test("a repository not linked here creates nothing for any repository", async () => {
    const web = checkout("web");
    link(web);
    workset("acme-login", "acme/web", "acme/api");
    const result = await createWorksetWorktrees(companion, "acme-login", options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.join("\n")).toContain("acme/api: not linked");
    expect(fs.existsSync(path.join(root, "src", "web.worktrees"))).toBe(false);
  });

  test("an unknown Workset names the id and every invalid record", async () => {
    link(checkout("web"));
    fs.mkdirSync(path.join(companion, "worksets"), { recursive: true });
    fs.writeFileSync(path.join(companion, "worksets", "broken.yaml"), "id: other\n");
    const result = await createWorksetWorktrees(companion, "acme-login", options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toBe("no valid Workset acme-login");
    expect(result.diagnostics[1]).toStartWith(path.join("worksets", "broken.yaml"));
  });

  test("only a remote branch: the new local branch tracks it", async () => {
    const web = checkout("web");
    git(web, "push", "-q", "origin", "HEAD:refs/heads/workset/acme-login");
    link(web);
    workset("acme-login", "acme/web");
    const result = await createWorksetWorktrees(companion, "acme-login", options);
    expect(result.ok).toBe(true);
    expect(branches(web)).toContain("workset/acme-login origin/workset/acme-login");
  });

  test("a branch checked out in the main checkout names that path", async () => {
    const web = checkout("web");
    git(web, "switch", "-q", "-c", "workset/acme-login");
    link(web);
    workset("acme-login", "acme/web");
    const result = await createWorksetWorktrees(companion, "acme-login", options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      `acme/web: workset/acme-login is already checked out at ${web}`,
    ]);
    expect(fs.existsSync(path.join(root, "src", "web.worktrees"))).toBe(false);
  });

  test("a branch identity collision reports the diagnostics", async () => {
    link(checkout("web"));
    workset("acme-login", "acme/web");
    fs.mkdirSync(path.join(companion, "openspec", "changes", "acme-login"), { recursive: true });
    const result = await createWorksetWorktrees(companion, "acme-login", options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.join("\n")).toContain("collide");
    expect(fs.existsSync(path.join(root, "src", "web.worktrees"))).toBe(false);
  });

  test("a second run reuses the worktree and runs no install", async () => {
    link(checkout("web", { "bun.lock": "{}\n" }));
    workset("acme-login", "acme/web");
    const { calls, install } = installs();
    await createWorksetWorktrees(companion, "acme-login", options, { install });
    const second = await createWorksetWorktrees(companion, "acme-login", options, { install });
    expect(second.ok).toBe(true);
    expect(second.repositories[0]).toMatchObject({
      action: "reused",
      install: { command: "bun install", outcome: "skipped" },
    });
    expect(calls).toHaveLength(1);
  });

  test("a worktree whose checkout is gone is not reused and its folder is left alone", async () => {
    link(checkout("web"));
    workset("acme-login", "acme/web");
    const target = path.join(root, "src", "web.worktrees", "acme-login");
    await createWorksetWorktrees(companion, "acme-login", options);
    // What a hand-cleaned worktree leaves behind: the folder without its checkout.
    for (const entry of fs.readdirSync(target)) {
      if (entry !== ".mate") fs.rmSync(path.join(target, entry), { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(target, ".mate"), { recursive: true });
    const result = await createWorksetWorktrees(companion, "acme-login", options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.join("\n")).toContain("stale worktree entry");
    expect(result.diagnostics.join("\n")).toContain("git worktree prune");
    expect(fs.readdirSync(target)).toEqual([".mate"]);
  });

  test("a stale entry whose folder is gone names the repair", async () => {
    link(checkout("web"));
    workset("acme-login", "acme/web");
    const target = path.join(root, "src", "web.worktrees", "acme-login");
    await createWorksetWorktrees(companion, "acme-login", options);
    fs.rmSync(target, { recursive: true, force: true });
    const result = await createWorksetWorktrees(companion, "acme-login", options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.join("\n")).toContain("stale worktree entry");
    expect(fs.existsSync(target)).toBe(false);
  });

  test("a foreign directory at the target path is left unchanged", async () => {
    link(checkout("web"));
    workset("acme-login", "acme/web");
    const target = path.join(root, "src", "web.worktrees", "acme-login");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "notes.txt"), "keep\n");
    const result = await createWorksetWorktrees(companion, "acme-login", options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.join("\n")).toContain(target);
    expect(fs.readdirSync(target)).toEqual(["notes.txt"]);
  });

  test("a bun repository runs bun install in the worktree", async () => {
    link(checkout("web", { "bun.lock": "{}\n", "package-lock.json": "{}\n" }));
    workset("acme-login", "acme/web");
    const { calls, install } = installs();
    const result = await createWorksetWorktrees(companion, "acme-login", options, { install });
    const target = path.join(root, "src", "web.worktrees", "acme-login");
    expect(calls).toEqual([[target, ["bun", "install"]]]);
    expect(result.repositories[0]!.install).toEqual({ command: "bun install", outcome: "ok" });
  });

  test("a failed install keeps the worktree and fails the run", async () => {
    link(checkout("web", { "yarn.lock": "\n" }));
    workset("acme-login", "acme/web");
    const { install } = installs(false);
    const result = await createWorksetWorktrees(companion, "acme-login", options, { install });
    expect(result.ok).toBe(false);
    expect(result.repositories[0]).toMatchObject({
      install: { command: "yarn install", outcome: "failed" },
      error: "yarn install failed",
    });
    expect(fs.existsSync(path.join(root, "src", "web.worktrees", "acme-login", ".git"))).toBe(true);
  });

  test("--no-install skips the install and says so", async () => {
    link(checkout("web", { "bun.lock": "{}\n" }));
    workset("acme-login", "acme/web");
    const { calls, install } = installs();
    const result = await createWorksetWorktrees(
      companion,
      "acme-login",
      { install: false, streamInstall: false },
      { install },
    );
    expect(calls).toEqual([]);
    expect(result.repositories[0]!.install).toEqual({
      command: "bun install",
      outcome: "skipped",
      reason: "--no-install",
    });
  });

  test("a failed fetch warns and continues from local refs", async () => {
    const web = checkout("web");
    git(web, "config", "--unset", `url.${path.join(root, "origins", "web.git")}.insteadOf`);
    link(web);
    workset("acme-login", "acme/web");
    const result = await createWorksetWorktrees(companion, "acme-login", options);
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toStartWith("acme/web: fetching origin failed");
  });

  test("env files are reported by path only and never copied", async () => {
    const web = checkout("web", {
      ".gitignore": ".env*\nnode_modules/\n",
      "apps/acme/.keep": "",
    });
    fs.writeFileSync(path.join(web, ".env"), "ACME_TOKEN=fake-value\n");
    fs.writeFileSync(path.join(web, ".env.example"), "ACME_TOKEN=\n");
    fs.writeFileSync(path.join(web, "apps", "acme", ".env.local"), "ACME_TOKEN=fake-value\n");
    fs.mkdirSync(path.join(web, "node_modules", "acme"), { recursive: true });
    fs.writeFileSync(path.join(web, "node_modules", "acme", ".env"), "ACME_TOKEN=fake-value\n");
    link(web);
    workset("acme-login", "acme/web");
    const result = await createWorksetWorktrees(companion, "acme-login", options);
    const target = path.join(root, "src", "web.worktrees", "acme-login");
    expect(result.repositories[0]!.missingEnv).toEqual([".env", "apps/acme/.env.local"]);
    expect(fs.existsSync(path.join(target, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(target, "apps", "acme", ".env.local"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("fake-value");
  });
});

describe("createChangeWorktrees", () => {
  describe("a companion registry entry naming a removed folder", () => {
    const stale = () => path.join(root, "src", "web.worktrees", "old");

    function linkStale(): void {
      fs.writeFileSync(
        path.join(companion, ".mate", "config", "registry.yaml"),
        `repos:\n  - id: web\n    path: ${stale()}\n`,
      );
    }

    test("uses the current checkout when its repo-local link names the companion", async () => {
      const web = checkout("web");
      linkStale();
      await writeRepoLocalRegistryEntry(web, companion, { id: "web", path: web }, "git");
      change("acme-fix", "acme/web");
      const result = await createChangeWorktrees(companion, "acme-fix", options, {
        cwd: () => web,
      });
      const target = path.join(root, "src", "web.worktrees", "acme-fix");
      expect(result.diagnostics).toEqual([]);
      expect(result.repositories).toMatchObject([{ repository: "acme/web", path: target }]);
      const local = fs.readFileSync(path.join(target, ".mate", "config", "registry.yaml"), "utf8");
      expect(local).toContain("id: web");
    });

    test("names the missing folder when the current checkout links another companion", async () => {
      const web = checkout("web");
      linkStale();
      const other = path.join(root, "acme-other");
      fs.mkdirSync(other);
      await writeRepoLocalRegistryEntry(web, other, { id: "web", path: web }, "git");
      change("acme-fix", "acme/web");
      const result = await createChangeWorktrees(companion, "acme-fix", options, {
        cwd: () => web,
      });
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual([
        `acme/web: not linked to ${companion} on this machine (registered path ${stale()} does not exist)`,
      ]);
      expect(fs.existsSync(path.join(root, "src", "web.worktrees", "acme-fix"))).toBe(false);
    });
  });

  test("a change no record lists gets a worktree named after it and writes no record", async () => {
    link(checkout("web"));
    change("acme-fix", "acme/web");
    const result = await createChangeWorktrees(companion, "acme-fix", options);
    expect(result.ok).toBe(true);
    expect(result.workset).toBe("acme-fix");
    expect(result.repositories).toMatchObject([
      {
        repository: "acme/web",
        path: path.join(root, "src", "web.worktrees", "acme-fix"),
        branch: "workset/acme-fix",
        action: "created",
      },
    ]);
    expect(fs.existsSync(path.join(companion, "worksets"))).toBe(false);
  });

  test("a change listed in a record uses the record's id and every record repository", async () => {
    link(checkout("web"), checkout("api"));
    listing("acme-login", ["acme/web", "acme/api"], ["acme-form"]);
    change("acme-form", "acme/web");
    const result = await createChangeWorktrees(companion, "acme-form", options);
    expect(result.ok).toBe(true);
    expect(result.workset).toBe("acme-login");
    expect(result.repositories.map((entry) => [entry.repository, entry.branch])).toEqual([
      ["acme/web", "workset/acme-login"],
      ["acme/api", "workset/acme-login"],
    ]);
  });

  test("a change in two records names both and creates nothing", async () => {
    link(checkout("web"));
    listing("acme-one", ["acme/web"], ["acme-a"]);
    listing("acme-two", ["acme/web"], ["acme-a"]);
    change("acme-a", "acme/web");
    const result = await createChangeWorktrees(companion, "acme-a", options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.join("\n")).toContain("acme-one, acme-two");
    expect(fs.existsSync(path.join(root, "src", "web.worktrees"))).toBe(false);
  });

  test("an unknown change names it and creates nothing", async () => {
    link(checkout("web"));
    const result = await createChangeWorktrees(companion, "acme-missing", options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(["no active change acme-missing"]);
    expect(fs.existsSync(path.join(root, "src", "web.worktrees"))).toBe(false);
  });

  test("a given ticket names the new branch", async () => {
    link(checkout("web"));
    change("acme-fix", "acme/web");
    const result = await createChangeWorktrees(companion, "acme-fix", {
      ...options,
      ticket: "ABC-123",
    });
    expect(result.repositories).toMatchObject([{ branch: "workset/ABC-123-acme-fix" }]);
  });

  test("a later slice gets its dependency's open branch", async () => {
    const web = checkout("web");
    link(web);
    git(web, "branch", "workset/acme-api");
    change("acme-api", "acme/web");
    record("acme-api", "deliveries:\n  - repository: acme/web\n    branch: workset/acme-api\n");
    change("acme-worker", "acme/web");
    fs.writeFileSync(
      path.join(companion, "openspec", "changes", "acme-worker", "design.md"),
      "---\nchange: acme-worker\ndependsOn: [acme-api]\n---\n",
    );
    const result = await createChangeWorktrees(companion, "acme-worker", options);
    expect(result.repositories).toMatchObject([{ branch: "workset/acme-api" }]);
  });

  test("a canary ticket in a record names nothing", async () => {
    link(checkout("web"));
    change("acme-fix", "acme/web");
    record("acme-fix", "ticket: ABC-123\ndeliveries: []\n");
    const result = await createChangeWorktrees(companion, "acme-fix", options);
    expect(result.repositories).toMatchObject([{ branch: "workset/acme-fix" }]);
  });

  test("an unrecorded workset/<id> does not take a given ticket's place", async () => {
    const web = checkout("web");
    link(web);
    git(web, "branch", "workset/acme-fix");
    change("acme-fix", "acme/web");
    const result = await createChangeWorktrees(companion, "acme-fix", {
      ...options,
      ticket: "ABC-123",
    });
    expect(result.repositories).toMatchObject([{ branch: "workset/ABC-123-acme-fix" }]);
    expect(result.warnings.join()).toContain("Existing workset/acme-fix is not used");
  });

  test("a ticket branch pushed elsewhere is found again without the ticket", async () => {
    const web = checkout("web");
    link(web);
    git(web, "push", "-q", "origin", "HEAD:refs/heads/workset/ABC-123-acme-fix");
    // Only the origin has it: drop the tracking ref the push left behind.
    git(web, "update-ref", "-d", "refs/remotes/origin/workset/ABC-123-acme-fix");
    change("acme-fix", "acme/web");
    const result = await createChangeWorktrees(companion, "acme-fix", options);
    expect(result.repositories).toMatchObject([
      { branch: "workset/ABC-123-acme-fix", action: "created" },
    ]);
    expect(branches(web)).toContain("workset/ABC-123-acme-fix origin/workset/ABC-123-acme-fix");
  });

  test("an inherited branch reuses its dependency's worktree", async () => {
    const web = checkout("web");
    link(web);
    change("acme-api", "acme/web");
    const api = await createChangeWorktrees(companion, "acme-api", options);
    record("acme-api", "deliveries:\n  - repository: acme/web\n    branch: workset/acme-api\n");
    change("acme-worker", "acme/web");
    fs.writeFileSync(
      path.join(companion, "openspec", "changes", "acme-worker", "design.md"),
      "---\nchange: acme-worker\ndependsOn: [acme-api]\n---\n",
    );
    const result = await createChangeWorktrees(companion, "acme-worker", options);
    expect(result.ok).toBe(true);
    expect(result.repositories).toMatchObject([
      { branch: "workset/acme-api", path: api.repositories[0]!.path, action: "reused" },
    ]);
    expect(result.warnings.join()).toContain("inherited from acme-api; reusing its worktree");
  });

  test("an inherited branch checked out in the main checkout is refused", async () => {
    const web = checkout("web");
    link(web);
    git(web, "switch", "-q", "-c", "workset/acme-api");
    change("acme-api", "acme/web");
    record("acme-api", "deliveries:\n  - repository: acme/web\n    branch: workset/acme-api\n");
    change("acme-worker", "acme/web");
    fs.writeFileSync(
      path.join(companion, "openspec", "changes", "acme-worker", "design.md"),
      "---\nchange: acme-worker\ndependsOn: [acme-api]\n---\n",
    );
    const result = await createChangeWorktrees(companion, "acme-worker", options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.join()).toContain(
      "workset/acme-api, inherited from acme-api, is checked out in",
    );
  });

  test("a recorded branch is the worktree's branch", async () => {
    link(checkout("web"));
    listing("acme-login", ["acme/web"], ["acme-form"]);
    change("acme-form", "acme/web");
    record("acme-form", "deliveries:\n  - repository: acme/web\n    branch: feature/acme\n");
    const result = await createChangeWorktrees(companion, "acme-form", options);
    expect(result.repositories).toMatchObject([{ branch: "feature/acme", action: "created" }]);
  });

  test("an implicit change without scoped repositories creates nothing", async () => {
    link(checkout("web"));
    change("acme-fix");
    const result = await createChangeWorktrees(companion, "acme-fix", options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(["change acme-fix names no repository in its scopes"]);
    expect(fs.existsSync(path.join(root, "src", "web.worktrees"))).toBe(false);
  });
});

/** A Workset of one change whose Delivery Record names `workset/<id>` in `acme/web`. */
function delivered(id: string): void {
  listing(id, ["acme/web"], [id]);
  change(id, "acme/web");
  record(id, `deliveries:\n  - repository: acme/web\n    branch: workset/${id}\n`);
}

describe("pruneWorksetWorktrees", () => {
  async function prepared(): Promise<{ web: string; target: string }> {
    const web = checkout("web");
    link(web);
    delivered("acme-login");
    await createWorksetWorktrees(companion, "acme-login", options);
    return { web, target: path.join(root, "src", "web.worktrees", "acme-login") };
  }

  async function done(...ids: string[]) {
    return (await readWorksets(companion)).worksets.filter((record) => ids.includes(record.id));
  }

  test("removes a worktree outside Mate's path that has the Delivery Branch", async () => {
    const web = checkout("web");
    link(web);
    delivered("acme-login");
    const scratch = path.join(root, "src", "acme-scratch");
    git(web, "worktree", "add", "-q", "-b", "workset/acme-login", scratch, "origin/HEAD");
    const result = await pruneWorksetWorktrees(companion, await done("acme-login"));
    expect(result.removed).toEqual([
      { workset: "acme-login", repository: "acme/web", path: scratch },
    ]);
    expect(fs.existsSync(scratch)).toBe(false);
  });

  test("finds the Delivery Branch in an archived change", async () => {
    const { target } = await prepared();
    const archive = path.join(companion, "openspec", "changes", "archive");
    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(
      path.join(companion, "openspec", "changes", "acme-login"),
      path.join(archive, "2026-11-05-acme-login"),
    );
    const result = await pruneWorksetWorktrees(companion, await done("acme-login"));
    expect(result.removed.map((entry) => entry.path)).toEqual([target]);
  });

  test("leaves the main checkout on the Delivery Branch", async () => {
    const web = checkout("web");
    link(web);
    delivered("acme-login");
    git(web, "switch", "-q", "-c", "workset/acme-login");
    const result = await pruneWorksetWorktrees(companion, await done("acme-login"));
    expect(result).toEqual({ removed: [], kept: [], warnings: [] });
    expect(fs.existsSync(web)).toBe(true);
  });

  test("leaves worktrees on another branch or a detached HEAD", async () => {
    const web = checkout("web");
    link(web);
    delivered("acme-login");
    const other = path.join(root, "src", "acme-other");
    const detached = path.join(root, "src", "acme-detached");
    git(web, "worktree", "add", "-q", "-b", "workset/acme-other", other, "origin/HEAD");
    git(web, "worktree", "add", "-q", "--detach", detached, "origin/HEAD");
    const result = await pruneWorksetWorktrees(companion, await done("acme-login"));
    expect(result).toEqual({ removed: [], kept: [], warnings: [] });
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(detached)).toBe(true);
  });

  test("keeps a worktree that holds the working directory", async () => {
    const { target } = await prepared();
    const result = await pruneWorksetWorktrees(companion, await done("acme-login"), {
      cwd: () => path.join(target, "src"),
    });
    expect(result.kept).toEqual([
      {
        workset: "acme-login",
        repository: "acme/web",
        path: target,
        reason: "in use (current directory)",
      },
    ]);
    expect(fs.existsSync(target)).toBe(true);
  });

  test("keeps a stale worktree entry and names the repair", async () => {
    const { target } = await prepared();
    fs.rmSync(target, { recursive: true, force: true });
    const result = await pruneWorksetWorktrees(companion, await done("acme-login"));
    expect(result.removed).toEqual([]);
    expect(result.kept[0]?.reason).toContain("stale worktree entry");
  });

  test("a not-applicable delivery names no branch", async () => {
    const { target } = await prepared();
    record("acme-login", "deliveries:\n  - repository: acme/web\n    notApplicable: docs only\n");
    const result = await pruneWorksetWorktrees(companion, await done("acme-login"));
    expect(result).toEqual({ removed: [], kept: [], warnings: [] });
    expect(fs.existsSync(target)).toBe(true);
  });

  test("removes a clean worktree of a Done Workset and keeps its branch", async () => {
    const { web, target } = await prepared();
    const result = await pruneWorksetWorktrees(companion, await done("acme-login"));
    expect(result.removed).toEqual([
      { workset: "acme-login", repository: "acme/web", path: target },
    ]);
    expect(fs.existsSync(target)).toBe(false);
    expect(git(web, "worktree", "list")).not.toContain("acme-login");
    expect(branches(web)).toContain("workset/acme-login");
  });

  test("keeps a worktree with a commit on no remote and names the reason", async () => {
    const { target } = await prepared();
    git(target, "commit", "-q", "--allow-empty", "-m", "local");
    const result = await pruneWorksetWorktrees(companion, await done("acme-login"));
    expect(result.kept).toEqual([
      {
        workset: "acme-login",
        repository: "acme/web",
        path: target,
        reason: "commits on no remote",
      },
    ]);
    expect(fs.existsSync(target)).toBe(true);
  });

  test("keeps a worktree with untracked files", async () => {
    const { target } = await prepared();
    fs.writeFileSync(path.join(target, "draft.txt"), "wip\n");
    const result = await pruneWorksetWorktrees(companion, await done("acme-login"));
    expect(result.kept[0]?.reason).toBe("uncommitted changes or untracked files");
  });

  test("keeps a locked worktree without unwrapping it", async () => {
    const { web, target } = await prepared();
    git(web, "worktree", "lock", target);
    let unwrapped = false;
    const result = await pruneWorksetWorktrees(companion, await done("acme-login"), {
      unwrap: async () => {
        unwrapped = true;
      },
    });
    expect(result.kept[0]?.reason).toBe("locked");
    expect(unwrapped).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });

  test("leaves the worktrees of Worksets that are not Done", async () => {
    const { target } = await prepared();
    const result = await pruneWorksetWorktrees(companion, await done());
    expect(result).toEqual({ removed: [], kept: [], warnings: [] });
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe("wrapping worktrees", () => {
  const originalHomeDir = runtimeDocumentDeps.homeDir;
  let home: string;

  // Wrapped hook commands name the runtime link.
  beforeAll(async () => {
    await refreshRuntimeDirectory();
  });

  beforeEach(() => {
    // Local-scope MCP lands in the user's home; never the real one.
    home = path.join(root, "home");
    fs.mkdirSync(home);
    runtimeDocumentDeps.homeDir = () => home;
    fs.writeFileSync(
      path.join(companion, ".mate", "config", "framework.yaml"),
      "type: companion\nallowedAgents:\n  - claude\n  - opencode\ncapabilities:\n  - name: tokensave\n",
    );
  });

  afterEach(() => {
    runtimeDocumentDeps.homeDir = originalHomeDir;
  });

  async function wrappedMain(): Promise<string> {
    const web = checkout("web");
    link(web);
    await writeRepoLocalRegistryEntry(web, companion, { id: "web", path: web }, "existing");
    const wrapped = await runWrapPass(companion, { id: "web", path: web });
    expect(wrapped.kind).not.toBe("failed");
    return web;
  }

  function claudeProjects(): Record<string, { mcpServers?: Record<string, unknown> }> {
    const file = path.join(home, ".claude.json");
    if (!fs.existsSync(file)) return {};
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { projects?: object }).projects ?? {};
  }

  const target = () => path.join(root, "src", "web.worktrees", "acme-login");

  test("a wrapped main checkout gets a wrapped worktree and both stay clean", async () => {
    const web = await wrappedMain();
    workset("acme-login", "acme/web");
    const result = await createWorksetWorktrees(companion, "acme-login", options);
    expect(result.ok).toBe(true);
    expect(result.repositories[0]!.wrap).toEqual({
      runtimes: ["claude", "opencode"],
      outcome: "ok",
    });
    expect(readProjectionFile(target())?.projection).toMatchObject({
      companionPath: companion,
      repositoryPath: target(),
    });
    expect(fs.existsSync(path.join(target(), ".claude", "settings.local.json"))).toBe(true);
    expect(fs.existsSync(path.join(target(), ".opencode", "opencode.json"))).toBe(true);
    expect(Object.keys(claudeProjects()[target()]?.mcpServers ?? {})).toEqual(["tokensave"]);
    expect(git(target(), "status", "--short")).toBe("");
    expect(git(web, "status", "--short")).toBe("");
  }, 30000);

  test("an unwrapped main checkout gets only the link", async () => {
    link(checkout("web"));
    workset("acme-login", "acme/web");
    let wrapped = false;
    const result = await createWorksetWorktrees(companion, "acme-login", options, {
      wrap: async () => ((wrapped = true), null),
    });
    expect(result.ok).toBe(true);
    expect(result.repositories[0]!.wrap).toEqual({
      runtimes: [],
      outcome: "skipped",
      reason: "main checkout not wrapped",
    });
    expect(wrapped).toBe(false);
    expect(fs.existsSync(path.join(target(), ".mate"))).toBe(true);
    expect(readProjectionFile(target())).toBeNull();
    expect(fs.existsSync(path.join(target(), ".claude"))).toBe(false);
  });

  test("a reused worktree is wrapped again", async () => {
    await wrappedMain();
    workset("acme-login", "acme/web");
    await createWorksetWorktrees(companion, "acme-login", options);
    fs.rmSync(path.join(target(), ".claude", "settings.local.json"));
    const second = await createWorksetWorktrees(companion, "acme-login", options);
    expect(second.repositories[0]).toMatchObject({ action: "reused", wrap: { outcome: "ok" } });
    expect(fs.existsSync(path.join(target(), ".claude", "settings.local.json"))).toBe(true);
  }, 30000);

  test("the worktree's link repeats the main checkout's id, not the origin's name", async () => {
    const web = checkout("web");
    fs.writeFileSync(
      path.join(companion, ".mate", "config", "registry.yaml"),
      `repos:\n  - id: acme-core\n    path: ${web}\n`,
    );
    workset("acme-login", "acme/web");
    const ids: string[] = [];
    await createWorksetWorktrees(companion, "acme-login", options, {
      writeLink: async (_repo, _companion, repository) => {
        ids.push(repository.id);
      },
    });
    expect(ids).toEqual(["acme-core"]);
  });

  test("a reused worktree whose refresh fails keeps its earlier wrap and only warns", async () => {
    await wrappedMain();
    workset("acme-login", "acme/web");
    await createWorksetWorktrees(companion, "acme-login", options);
    const second = await createWorksetWorktrees(companion, "acme-login", options, {
      wrap: async () => "acme refused",
    });
    expect(second.ok).toBe(true);
    expect(second.repositories[0]!.error).toBeUndefined();
    expect(second.warnings).toEqual([
      "acme/web: wrapping the worktree failed: acme refused; its earlier wrap stays",
    ]);
  }, 30000);

  test("a failed wrap keeps the worktree and fails its repository", async () => {
    await wrappedMain();
    workset("acme-login", "acme/web");
    const result = await createWorksetWorktrees(companion, "acme-login", options, {
      wrap: async () => "acme refused",
    });
    expect(result.ok).toBe(false);
    expect(result.repositories[0]).toMatchObject({
      wrap: { outcome: "failed", reason: "acme refused" },
      error: "wrapping the worktree failed: acme refused",
    });
    expect(fs.existsSync(path.join(target(), ".git"))).toBe(true);
  }, 30000);

  test("the guard of a wrapped worktree blocks an artifact write in an unmanaged session", async () => {
    const web = await wrappedMain();
    workset("acme-login", "acme/web");
    await createWorksetWorktrees(companion, "acme-login", options);
    // Claude Code runs the main worktree's local settings hooks in its linked worktrees.
    const settings = JSON.parse(
      fs.readFileSync(path.join(web, ".claude", "settings.local.json"), "utf8"),
    ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const guard = settings.hooks.PreToolUse![0]!.hooks[0]!.command;
    const env: Record<string, string | undefined> = { ...process.env };
    for (const name of Object.values(MATE_ENV)) delete env[name];
    const blocked = spawnSync("sh", ["-c", guard], {
      cwd: target(),
      env,
      encoding: "utf8",
      input: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: path.join(target(), "design.md") },
      }),
    });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain(ARTIFACT_REFUSAL_HEADLINE);
  }, 30000);

  test("prune removes the wrap with the worktree", async () => {
    await wrappedMain();
    delivered("acme-login");
    await createWorksetWorktrees(companion, "acme-login", options);
    expect(claudeProjects()[target()]).toBeDefined();
    const done = (await readWorksets(companion)).worksets;
    const result = await pruneWorksetWorktrees(companion, done);
    expect(result.removed.map((entry) => entry.path)).toEqual([target()]);
    expect(fs.existsSync(target())).toBe(false);
    expect(claudeProjects()[target()]).toBeUndefined();
  }, 30000);

  test("a worktree git refuses to remove is wrapped again", async () => {
    await wrappedMain();
    delivered("acme-login");
    await createWorksetWorktrees(companion, "acme-login", options);
    const done = (await readWorksets(companion)).worksets;
    const wrapped: string[] = [];
    const result = await pruneWorksetWorktrees(companion, done, {
      git: async (cwd, args) =>
        args[0] === "worktree" && args[1] === "remove"
          ? { code: 128, stdout: "", stderr: "fatal: acme refused" }
          : realGit(cwd, args),
      wrap: async (_companion, repository) => (wrapped.push(repository.path), null),
    });
    expect(result.kept[0]?.reason).toBe("fatal: acme refused");
    expect(wrapped).toEqual([target()]);
  }, 30000);

  test("a failed unwrap keeps the worktree and names the reason", async () => {
    await wrappedMain();
    delivered("acme-login");
    await createWorksetWorktrees(companion, "acme-login", options);
    const done = (await readWorksets(companion)).worksets;
    const result = await pruneWorksetWorktrees(companion, done, {
      unwrap: async () => {
        throw new Error("acme locked");
      },
    });
    expect(result.removed).toEqual([]);
    expect(result.kept[0]?.reason).toBe("removing its wrap failed: acme locked");
    expect(fs.existsSync(target())).toBe(true);
  }, 30000);
});

describe("worktree tokensave index", () => {
  const target = () => path.join(root, "src", "web.worktrees", "acme-login");

  function indexStore(checkout: string, config: Record<string, unknown>): void {
    fs.mkdirSync(path.join(checkout, ".tokensave"), { recursive: true });
    fs.writeFileSync(path.join(checkout, ".tokensave", "tokensave.db"), "");
    fs.writeFileSync(path.join(checkout, ".tokensave", "config.json"), JSON.stringify(config));
  }

  /** A fake tokensave whose `init` creates the store it would. */
  function tokensave(failure: string | null = null, available = true) {
    const calls: [string, string[]][] = [];
    return {
      calls,
      runner: {
        available: () => available,
        run: async (cwd: string, args: string[]) => {
          calls.push([cwd, args]);
          if (!failure && args[0] === "init") indexStore(cwd, { root_dir: cwd, auto_track: true });
          return failure;
        },
      },
    };
  }

  function indexedMain(): void {
    const web = checkout("web");
    indexStore(web, { cpu_usage: "balanced" });
    link(web);
    workset("acme-login", "acme/web");
  }

  test("an indexed main checkout seeds the worktree with its profile and Mate's posture", async () => {
    indexedMain();
    const { calls, runner } = tokensave();
    const result = await createWorksetWorktrees(companion, "acme-login", options, {
      tokensave: runner,
    });
    expect(result.repositories[0]!.index).toEqual({ outcome: "ok" });
    expect(calls).toEqual([
      [target(), ["init", target(), "--no-git-hook", "--cpu-usage", "balanced"]],
    ]);
    const config = JSON.parse(
      fs.readFileSync(path.join(target(), ".tokensave", "config.json"), "utf8"),
    );
    expect(config).toMatchObject({ auto_track: false, suppress_scope_warning: true });
  });

  test("--no-install still seeds the index", async () => {
    indexedMain();
    const { calls, runner } = tokensave();
    const result = await createWorksetWorktrees(
      companion,
      "acme-login",
      { ...options, install: false },
      { tokensave: runner },
    );
    expect(result.repositories[0]!.index.outcome).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  test("an unindexed main checkout runs no tokensave command", async () => {
    link(checkout("web"));
    workset("acme-login", "acme/web");
    const { calls, runner } = tokensave();
    const result = await createWorksetWorktrees(companion, "acme-login", options, {
      tokensave: runner,
    });
    expect(result.repositories[0]!.index).toEqual({
      outcome: "skipped",
      reason: "main checkout not indexed",
    });
    expect(calls).toEqual([]);
  });

  test("tokensave missing from PATH skips with a reason", async () => {
    indexedMain();
    const { calls, runner } = tokensave(null, false);
    const result = await createWorksetWorktrees(companion, "acme-login", options, {
      tokensave: runner,
    });
    expect(result.repositories[0]!.index).toEqual({
      outcome: "skipped",
      reason: "tokensave not on PATH",
    });
    expect(calls).toEqual([]);
  });

  test("a reused worktree with an index syncs it", async () => {
    indexedMain();
    const first = tokensave();
    await createWorksetWorktrees(companion, "acme-login", options, { tokensave: first.runner });
    const { calls, runner } = tokensave();
    const second = await createWorksetWorktrees(companion, "acme-login", options, {
      tokensave: runner,
    });
    expect(second.repositories[0]).toMatchObject({ action: "reused", index: { outcome: "ok" } });
    expect(calls).toEqual([[target(), ["sync"]]]);
  });

  test("a failed init keeps the worktree, warns, and leaves the result ok", async () => {
    indexedMain();
    const { runner } = tokensave("tokensave init exited 1: acme");
    const result = await createWorksetWorktrees(companion, "acme-login", options, {
      tokensave: runner,
    });
    expect(result.ok).toBe(true);
    expect(result.repositories[0]!.error).toBeUndefined();
    expect(result.repositories[0]!.index).toEqual({
      outcome: "failed",
      reason: "tokensave init exited 1: acme",
    });
    expect(result.warnings).toContain(
      "acme/web: tokensave index step failed: tokensave init exited 1: acme",
    );
    expect(fs.existsSync(path.join(target(), ".git"))).toBe(true);
  });
});

describe("Umbrella Repository worktrees", () => {
  const umbrella = () => path.join(root, "src", "acme");
  const mirror = (id = "acme-fix") => path.join(root, "src", "acme.worktrees", id);

  /** The umbrella `<root>/src/acme`, no Git checkout, holding a checkout per name, linked alone. */
  function umbrellaOf(...names: string[]): string[] {
    const children = names.map((name) => checkout(name, {}, path.join(umbrella(), name)));
    link(umbrella());
    return children;
  }

  /** Stubs that wrap nothing and record what would be wrapped. */
  function wrapStubs(wrappedFor: Record<string, string[]>) {
    const wrapped: [string, string, string[]][] = [];
    return {
      wrapped,
      deps: {
        readWrapState: async (checkoutPath: string) => ({
          runtimes: new Set(wrappedFor[checkoutPath] ?? []),
        }),
        wrap: async (_companion: string, repository: { id: string; path: string }, runtimes) => {
          wrapped.push([repository.id, repository.path, [...runtimes]]);
          return null;
        },
      } as Partial<WorktreeDeps>,
    };
  }

  test("children get worktrees in one mirrored folder, linked under the umbrella's id", async () => {
    const [api, web] = umbrellaOf("api", "web");
    workset("acme-fix", "acme/api", "acme/web");
    const registry = fs.readFileSync(path.join(companion, ".mate", "config", "registry.yaml"));
    const result = await createWorksetWorktrees(companion, "acme-fix", options);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.repositories).toMatchObject([
      {
        repository: "acme/api",
        path: path.join(mirror(), "api"),
        checkout: api,
        action: "created",
      },
      {
        repository: "acme/web",
        path: path.join(mirror(), "web"),
        checkout: web,
        action: "created",
      },
    ]);
    expect(result.repositories[0]!.wrap).toEqual({
      runtimes: [],
      outcome: "skipped",
      reason: "served by the mirrored worktree",
    });
    expect(result.umbrella).toMatchObject({
      path: umbrella(),
      worktree: mirror(),
      action: "created",
      repositories: ["acme/api", "acme/web"],
    });
    const link = fs.readFileSync(path.join(mirror(), ".mate", "config", "registry.yaml"), "utf8");
    expect(link).toContain("id: acme");
    expect(link).toContain(`path: ${mirror()}`);
    expect(fs.existsSync(path.join(mirror(), "api", ".mate"))).toBe(false);
    expect(git(path.join(mirror(), "api"), "status", "--short")).toBe("");
    expect(git(api!, "status", "--short")).toBe("");
    expect(fs.readFileSync(path.join(companion, ".mate", "config", "registry.yaml"))).toEqual(
      registry,
    );
  });

  describe("mirrored worktree index", () => {
    /** A fake tokensave whose `init` writes the store it would. */
    function tokensave(failure: string | null = null) {
      const calls: [string, string[]][] = [];
      const runner = {
        available: () => true,
        run: async (cwd: string, args: string[]) => {
          calls.push([cwd, args]);
          if (!failure && args[0] === "init") {
            fs.mkdirSync(path.join(cwd, ".tokensave"), { recursive: true });
            fs.writeFileSync(path.join(cwd, ".tokensave", "tokensave.db"), "");
          }
          return failure;
        },
      };
      return { calls, runner };
    }

    function indexUmbrella(): void {
      fs.mkdirSync(path.join(umbrella(), ".tokensave"), { recursive: true });
      fs.writeFileSync(path.join(umbrella(), ".tokensave", "tokensave.db"), "");
    }

    test("an indexed umbrella seeds the mirrored worktree's index", async () => {
      umbrellaOf("api");
      indexUmbrella();
      workset("acme-fix", "acme/api");
      const { calls, runner } = tokensave();
      const result = await createWorksetWorktrees(companion, "acme-fix", options, {
        tokensave: runner,
      });
      expect(result.umbrella?.index).toEqual({ outcome: "ok" });
      expect(calls).toContainEqual([mirror(), ["init", mirror(), "--no-git-hook"]]);
      expect(fs.existsSync(path.join(mirror(), ".tokensave", "tokensave.db"))).toBe(true);
    });

    test("an unindexed umbrella skips with a reason", async () => {
      umbrellaOf("api");
      workset("acme-fix", "acme/api");
      const { calls, runner } = tokensave();
      const result = await createWorksetWorktrees(companion, "acme-fix", options, {
        tokensave: runner,
      });
      expect(result.umbrella?.index).toEqual({
        outcome: "skipped",
        reason: "umbrella not indexed",
      });
      expect(calls.filter(([cwd]) => cwd === mirror())).toEqual([]);
    });

    test("a failed index keeps the worktree, warns, and leaves the result ok", async () => {
      umbrellaOf("api");
      indexUmbrella();
      workset("acme-fix", "acme/api");
      const { runner } = tokensave("tokensave init exited 1: acme");
      const result = await createWorksetWorktrees(companion, "acme-fix", options, {
        tokensave: runner,
      });
      expect(result.ok).toBe(true);
      expect(result.umbrella).toMatchObject({
        index: { outcome: "failed", reason: "tokensave init exited 1: acme" },
      });
      expect(result.umbrella?.error).toBeUndefined();
      expect(result.warnings).toContain(
        `${umbrella()}: tokensave index step failed: tokensave init exited 1: acme`,
      );
      expect(fs.existsSync(path.join(mirror(), "api", ".git"))).toBe(true);
    });
  });

  test("a Workset naming one of two children gets only its worktree", async () => {
    umbrellaOf("api", "web");
    workset("acme-fix", "acme/api");
    const result = await createWorksetWorktrees(companion, "acme-fix", options);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(mirror(), "api", ".git"))).toBe(true);
    expect(fs.existsSync(path.join(mirror(), "web"))).toBe(false);
  });

  test("a mixed Workset puts the umbrella child in the mirror and the other beside its checkout", async () => {
    umbrellaOf("api");
    const tools = checkout("tools");
    link(umbrella(), tools);
    workset("acme-fix", "acme/api", "acme/tools");
    const result = await createWorksetWorktrees(companion, "acme-fix", options);
    expect(result.ok).toBe(true);
    expect(result.repositories.map((entry) => entry.path)).toEqual([
      path.join(mirror(), "api"),
      path.join(root, "src", "tools.worktrees", "acme-fix"),
    ]);
    expect(result.umbrella?.worktree).toBe(mirror());
  });

  test("a rerun reuses the mirrored folder and its worktrees", async () => {
    umbrellaOf("api", "web");
    workset("acme-fix", "acme/api", "acme/web");
    await createWorksetWorktrees(companion, "acme-fix", options);
    const second = await createWorksetWorktrees(companion, "acme-fix", options);
    expect(second.ok).toBe(true);
    expect(second.repositories.map((entry) => entry.action)).toEqual(["reused", "reused"]);
    expect(second.umbrella?.action).toBe("reused");
  });

  test("a run interrupted before linking the mirror is completed by the next", async () => {
    umbrellaOf("api", "web");
    workset("acme-fix", "acme/api", "acme/web");
    await createWorksetWorktrees(companion, "acme-fix", options);
    fs.rmSync(path.join(mirror(), ".mate"), { recursive: true });
    const second = await createWorksetWorktrees(companion, "acme-fix", options);
    expect(second.diagnostics).toEqual([]);
    expect(second.ok).toBe(true);
    expect(second.repositories.map((entry) => entry.action)).toEqual(["reused", "reused"]);
    expect(second.umbrella?.action).toBe("created");
    expect(await findRepoLocalLinkTo(mirror(), companion)).toEqual({ id: "acme", path: mirror() });
  });

  test("OS metadata alone does not make the mirror's path foreign", async () => {
    umbrellaOf("api");
    workset("acme-fix", "acme/api");
    fs.mkdirSync(mirror(), { recursive: true });
    fs.writeFileSync(path.join(mirror(), ".DS_Store"), "");
    const result = await createWorksetWorktrees(companion, "acme-fix", options);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("a mirror folder linked to another companion is refused", async () => {
    umbrellaOf("api");
    workset("acme-fix", "acme/api");
    const config = path.join(mirror(), ".mate", "config");
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(
      path.join(config, "registry.yaml"),
      `companions:\n  - path: ${path.join(root, "acme-other")}\n    repositoryId: acme\n`,
    );
    const result = await createWorksetWorktrees(companion, "acme-fix", options);
    expect(result.diagnostics).toEqual([
      `${mirror()} exists and is not the mirrored worktree of ${umbrella()}`,
    ]);
    expect(fs.existsSync(path.join(mirror(), "api"))).toBe(false);
  });

  test("an umbrella child that is a worktree of a checkout elsewhere stays the umbrella's", async () => {
    umbrellaOf("api");
    const elsewhere = checkout("web");
    git(elsewhere, "worktree", "add", "-q", "-b", "acme-hand", path.join(umbrella(), "web"));
    workset("acme-fix", "acme/api", "acme/web");
    const result = await createWorksetWorktrees(companion, "acme-fix", options);
    expect(result.diagnostics).toEqual([]);
    expect(result.repositories.map((entry) => entry.path)).toEqual([
      path.join(mirror(), "api"),
      path.join(mirror(), "web"),
    ]);
    expect(result.umbrella?.path).toBe(umbrella());
  });

  test("each umbrella child's origin is read once per run", async () => {
    umbrellaOf("api", "web");
    workset("acme-fix", "acme/api", "acme/web");
    const reads: string[] = [];
    const counting: GitRunner = async (cwd, args) => {
      if (args.join(" ") === "config --get remote.origin.url") reads.push(cwd);
      return realGit(cwd, args);
    };
    const result = await createWorksetWorktrees(companion, "acme-fix", options, { git: counting });
    expect(result.ok).toBe(true);
    expect(reads.toSorted()).toEqual([path.join(umbrella(), "api"), path.join(umbrella(), "web")]);
  });

  test("a hand-made worktree inside the umbrella does not take the umbrella's link", async () => {
    const [api] = umbrellaOf("api");
    await writeRepoLocalRegistryEntry(
      umbrella(),
      companion,
      { id: "acme", path: umbrella() },
      "existing",
    );
    const hotfix = path.join(umbrella(), "api-hotfix");
    git(api!, "worktree", "add", "-q", "-b", "acme-hotfix", hotfix);
    expect(await findRepoLocalLinkTo(path.join(api!), companion)).toEqual({
      id: "acme",
      path: umbrella(),
    });
    expect(await findRepoLocalLinkTo(hotfix, companion)).toBeNull();
  });

  test("a foreign folder at the mirror's path is refused and nothing is created", async () => {
    umbrellaOf("api");
    workset("acme-fix", "acme/api");
    fs.mkdirSync(mirror(), { recursive: true });
    fs.writeFileSync(path.join(mirror(), "notes.md"), "acme\n");
    const result = await createWorksetWorktrees(companion, "acme-fix", options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      `${mirror()} exists and is not the mirrored worktree of ${umbrella()}`,
    ]);
    expect(fs.existsSync(path.join(mirror(), "api"))).toBe(false);
  });

  test("the mirror is wrapped for exactly the umbrella's runtimes; the children are not", async () => {
    umbrellaOf("api", "web");
    workset("acme-fix", "acme/api", "acme/web");
    const { wrapped, deps } = wrapStubs({ [umbrella()]: ["claude"] });
    const result = await createWorksetWorktrees(companion, "acme-fix", options, deps);
    expect(result.umbrella?.wrap).toEqual({ runtimes: ["claude"], outcome: "ok" });
    expect(wrapped).toEqual([["acme", mirror(), ["claude"]]]);
  });

  test("a failed mirror wrap is reported and keeps the worktrees", async () => {
    umbrellaOf("api");
    workset("acme-fix", "acme/api");
    const result = await createWorksetWorktrees(companion, "acme-fix", options, {
      ...wrapStubs({ [umbrella()]: ["claude"] }).deps,
      wrap: async () => "acme refused",
    });
    expect(result.ok).toBe(false);
    expect(result.umbrella?.error).toBe("wrapping the worktree failed: acme refused");
    expect(fs.existsSync(path.join(mirror(), "api", ".git"))).toBe(true);
  });

  test("a session in the mirrored folder resolves the companion and the children inside it", async () => {
    umbrellaOf("api", "web");
    workset("acme-fix", "acme/api", "acme/web");
    await createWorksetWorktrees(companion, "acme-fix", options);
    expect(await findRepoLocalLinkTo(mirror(), companion)).toEqual({
      id: "acme",
      path: mirror(),
    });
    expect((await umbrellaChildrenOf(mirror())).map((entry) => entry.path)).toEqual([
      path.join(mirror(), "api"),
      path.join(mirror(), "web"),
    ]);
    // As a child of the umbrella finds the umbrella's link.
    fs.mkdirSync(path.join(mirror(), "api", "src"));
    expect(await findRepoLocalLinkTo(path.join(mirror(), "api", "src"), companion)).toEqual({
      id: "acme",
      path: mirror(),
    });
  });

  test("from the mirror, another Workset still mirrors the real umbrella", async () => {
    umbrellaOf("api");
    workset("acme-fix", "acme/api");
    workset("acme-two", "acme/api");
    await createWorksetWorktrees(companion, "acme-fix", options);
    // The umbrella's registry entry is gone; only the mirror's own link names it.
    fs.writeFileSync(path.join(companion, ".mate", "config", "registry.yaml"), "repos: []\n");
    const result = await createWorksetWorktrees(companion, "acme-two", options, {
      cwd: () => mirror(),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.repositories.map((entry) => entry.path)).toEqual([
      path.join(mirror("acme-two"), "api"),
    ]);
    expect(result.umbrella?.path).toBe(umbrella());
  });

  describe("prune", () => {
    /** A Done Workset of one change delivered on `workset/acme-fix` in each named child. */
    async function prepared(...names: string[]): Promise<void> {
      umbrellaOf(...names);
      const repositories = names.map((name) => `acme/${name}`);
      listing("acme-fix", repositories, ["acme-fix"]);
      change("acme-fix", ...repositories);
      record(
        "acme-fix",
        `deliveries:\n${repositories
          .map((repository) => `  - repository: ${repository}\n    branch: workset/acme-fix\n`)
          .join("")}`,
      );
      const created = await createWorksetWorktrees(companion, "acme-fix", options);
      expect(created.ok).toBe(true);
    }

    const done = async () => (await readWorksets(companion)).worksets;

    test("removes the children, then the unwrapped mirror and its empty parent", async () => {
      await prepared("api", "web");
      const result = await pruneWorksetWorktrees(companion, await done());
      expect(result.removed.map((entry) => entry.path)).toEqual([
        path.join(mirror(), "api"),
        path.join(mirror(), "web"),
      ]);
      expect(result.umbrellas).toEqual({
        removed: [{ workset: "acme-fix", umbrella: umbrella(), path: mirror() }],
        kept: [],
      });
      expect(fs.existsSync(mirror())).toBe(false);
      expect(fs.existsSync(path.dirname(mirror()))).toBe(false);
      expect(fs.existsSync(umbrella())).toBe(true);
    });

    test("a kept child keeps the mirror, still linked", async () => {
      await prepared("api", "web");
      fs.writeFileSync(path.join(mirror(), "api", "draft.txt"), "wip\n");
      const result = await pruneWorksetWorktrees(companion, await done());
      expect(result.kept.map((entry) => entry.path)).toEqual([path.join(mirror(), "api")]);
      expect(result.umbrellas?.kept).toEqual([
        {
          workset: "acme-fix",
          umbrella: umbrella(),
          path: mirror(),
          reason: "still holds api",
        },
      ]);
      expect(fs.existsSync(path.join(mirror(), ".mate", "config", "registry.yaml"))).toBe(true);
    });

    test("a stray file keeps the mirror and the file", async () => {
      await prepared("api");
      fs.writeFileSync(path.join(mirror(), "notes.md"), "acme\n");
      const result = await pruneWorksetWorktrees(companion, await done());
      expect(result.removed.map((entry) => entry.path)).toEqual([path.join(mirror(), "api")]);
      expect(result.umbrellas?.kept[0]?.reason).toBe("still holds notes.md");
      expect(fs.readFileSync(path.join(mirror(), "notes.md"), "utf8")).toBe("acme\n");
    });

    test("OS metadata does not keep the mirror", async () => {
      await prepared("api");
      fs.writeFileSync(path.join(mirror(), ".DS_Store"), "");
      const result = await pruneWorksetWorktrees(companion, await done());
      expect(result.umbrellas?.removed.map((entry) => entry.path)).toEqual([mirror()]);
      expect(fs.existsSync(mirror())).toBe(false);
    });

    test("a mirror that stays after unwrapping is linked again, so a later prune finds it", async () => {
      await prepared("api");
      const unwrap = async (folder: string) => {
        fs.rmSync(path.join(folder, ".mate"), { recursive: true, force: true });
        fs.writeFileSync(path.join(folder, "acme-left.txt"), "");
      };
      const first = await pruneWorksetWorktrees(companion, await done(), { unwrap });
      expect(first.umbrellas?.kept[0]?.reason).toBe("unwrapping left acme-left.txt");
      expect(await findRepoLocalLinkTo(mirror(), companion)).toEqual({
        id: "acme",
        path: mirror(),
      });
      const second = await pruneWorksetWorktrees(companion, await done());
      expect(second.umbrellas?.kept[0]?.reason).toBe("still holds acme-left.txt");
    });

    test("a failed unwrap keeps the mirror and names the reason", async () => {
      await prepared("api");
      let unwrapped: string[] = [];
      const result = await pruneWorksetWorktrees(companion, await done(), {
        unwrap: async (folder) => {
          unwrapped = [...unwrapped, folder];
          throw new Error("acme locked");
        },
      });
      // A child worktree carries no wrap, so only the mirror is unwrapped.
      expect(unwrapped).toEqual([mirror()]);
      expect(result.removed.map((entry) => entry.path)).toEqual([path.join(mirror(), "api")]);
      expect(result.umbrellas?.kept[0]?.reason).toBe("removing its wrap failed: acme locked");
      expect(fs.existsSync(mirror())).toBe(true);
    });

    test("a child's worktree outside the mirror is unwrapped before removal", async () => {
      const [api] = umbrellaOf("api");
      listing("acme-fix", ["acme/api"], ["acme-fix"]);
      change("acme-fix", "acme/api");
      record("acme-fix", "deliveries:\n  - repository: acme/api\n    branch: workset/acme-fix\n");
      const hand = path.join(root, "acme-hand");
      git(api!, "worktree", "add", "-q", "-b", "workset/acme-fix", hand);
      const unwrapped: string[] = [];
      const result = await pruneWorksetWorktrees(companion, await done(), {
        unwrap: async (folder) => {
          unwrapped.push(folder);
        },
      });
      expect(unwrapped).toEqual([hand]);
      expect(result.removed.map((entry) => entry.path)).toEqual([hand]);
      expect(fs.existsSync(hand)).toBe(false);
    });
  });

  test("an umbrella linked through a symlink is one umbrella, mirrored beside the real folder", async () => {
    umbrellaOf("api", "web");
    const alias = path.join(root, "src", "acme-alias");
    fs.symlinkSync(umbrella(), alias);
    link(alias);
    workset("acme-fix", "acme/api", "acme/web");
    workset("acme-two", "acme/api", "acme/web");
    const first = await createWorksetWorktrees(companion, "acme-fix", options);
    expect(first.diagnostics).toEqual([]);
    expect(first.umbrella).toMatchObject({ path: umbrella(), worktree: mirror() });
    // From the mirror, its own link and the registry's alias name the same umbrella.
    const second = await createWorksetWorktrees(companion, "acme-two", options, {
      cwd: () => mirror(),
    });
    expect(second.diagnostics).toEqual([]);
    expect(second.umbrella?.worktree).toBe(mirror("acme-two"));
  });
});

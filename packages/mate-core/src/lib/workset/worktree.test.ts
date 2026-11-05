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
import { writeRepoLocalRegistryEntry } from "../orchestrator/repository-link";
import { runWrapPass } from "../orchestrator/wrap-pass";
import { readWorksets } from "./record";
import {
  createChangeWorktrees,
  createWorksetWorktrees,
  type GitRunner,
  type InstallRunner,
  pruneWorksetWorktrees,
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
 * A main checkout at `<root>/src/<name>` cloned from a local bare origin, whose `origin`
 * reads as `https://git.acme.test/acme/<name>.git` and fetches from the bare one.
 */
function checkout(name: string, files: Record<string, string> = {}): string {
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
  const main = path.join(root, "src", name);
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

  test("an implicit change without scoped repositories creates nothing", async () => {
    link(checkout("web"));
    change("acme-fix");
    const result = await createChangeWorktrees(companion, "acme-fix", options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(["change acme-fix names no repository in its scopes"]);
    expect(fs.existsSync(path.join(root, "src", "web.worktrees"))).toBe(false);
  });
});

describe("pruneWorksetWorktrees", () => {
  async function prepared(): Promise<{ web: string; target: string }> {
    const web = checkout("web");
    link(web);
    workset("acme-login", "acme/web");
    await createWorksetWorktrees(companion, "acme-login", options);
    return { web, target: path.join(root, "src", "web.worktrees", "acme-login") };
  }

  async function done(...ids: string[]) {
    return (await readWorksets(companion)).worksets.filter((record) => ids.includes(record.id));
  }

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
    await wrappedMain();
    workset("acme-login", "acme/web");
    await createWorksetWorktrees(companion, "acme-login", options);
    const settings = JSON.parse(
      fs.readFileSync(path.join(target(), ".claude", "settings.local.json"), "utf8"),
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
    workset("acme-login", "acme/web");
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
    workset("acme-login", "acme/web");
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
    workset("acme-login", "acme/web");
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

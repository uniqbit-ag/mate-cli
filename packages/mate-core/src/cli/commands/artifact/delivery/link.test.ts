import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WorkingRepoGit } from "../../../../lib/delivery/branches";
import { DELIVERY_FILE } from "../../../../lib/delivery/record";
import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import { runArtifactLinkCommand, type LinkCommandDeps, type LinkResult } from "./link";

const TOKEN = "ghp_TOKEN_MUST_NOT_LEAK";
const REPO = "acme/acme-app";
const API = "https://api.github.com/repos/acme/acme-app";

let companion: string;
let out: string[];
let err: string[];

function repoGit(overrides: Partial<WorkingRepoGit> = {}): WorkingRepoGit {
  return {
    currentBranch: async () => "change/x",
    defaultBranch: async () => "main",
    remoteUrl: async () => "git@github.com:acme/acme-app.git",
    unpushedCommits: async () => [],
    branchExists: async () => false,
    hasRef: async () => false,
    ...overrides,
  };
}

function respond(routes: Record<string, { status: number; body: unknown }>) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1];
    return new Response(JSON.stringify(route?.body ?? {}), { status: route?.status ?? 404 });
  };
  return { calls, fetch };
}

function deps(overrides: Partial<LinkCommandDeps> = {}): LinkCommandDeps {
  return {
    ensureUnambiguousCompanion: async () => true,
    resolveContext: async () =>
      ({
        companionPath: companion,
        repositoryId: "acme-app",
        repository: { id: "acme-app", path: "/repo" },
      }) as unknown as LaunchContext,
    loadCapabilities: async () => [{ name: "openspec", protectedBranches: ["release/*"] }],
    workingRepoGit: () => repoGit(),
    resolveToken: async () => null,
    now: () => new Date("2026-10-28T10:00:00.000Z"),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...overrides,
  };
}

async function run(
  argv: string[],
  overrides: Partial<LinkCommandDeps> = {},
): Promise<LinkResult[]> {
  out = [];
  err = [];
  await runArtifactLinkCommand([...argv, "--json"], deps(overrides));
  return out.length ? (JSON.parse(out[0]) as LinkResult[]) : [];
}

async function readRaw(change: string): Promise<string> {
  return fs.readFile(path.join(companion, "openspec", "changes", change, DELIVERY_FILE), "utf8");
}

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-link-"));
  for (const change of ["x", "a", "b"]) {
    await fs.mkdir(path.join(companion, "openspec", "changes", change), { recursive: true });
  }
  process.exitCode = 0;
});

afterEach(async () => {
  await fs.rm(companion, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("mate artifact link", () => {
  test("read-only defaults and invalid-record diagnostics are exposed without writes", async () => {
    expect((await run(["x"]))[0]).toMatchObject({ defaultBranch: "workset/x", diagnostics: [] });
    await fs.mkdir(path.join(companion, "worksets"));
    await fs.writeFile(path.join(companion, "worksets/acme-invalid.yaml"), "id: wrong\n");
    const [result] = await run(["x"]);
    expect(result.defaultBranch).toBeNull();
    expect(result.diagnostics.join()).toContain("worksets/acme-invalid.yaml");
    expect(err.join()).toContain("worksets/acme-invalid.yaml");
    await expect(readRaw("x")).rejects.toThrow();
  });

  test("one linked change is recorded on the agent session it runs in; a batch is not", async () => {
    const attributed: unknown[] = [];
    const attribute = async (
      attribution: { change: string },
      env?: Record<string, string | undefined>,
    ) => {
      attributed.push([attribution.change, env?.CLAUDE_CODE_SESSION_ID]);
      return null;
    };
    const sessionEnv = { CLAUDE_CODE_SESSION_ID: "0b7c-acme" };
    await run(["x"], { attribute, sessionEnv });
    await run(["a", "b"], { attribute, sessionEnv });
    expect(attributed).toEqual([["x", "0b7c-acme"]]);
  });

  test("every result, read-only included, reports whether the session is isolated", async () => {
    const repo = path.join(companion, "acme-app");
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    const resolveContext = async () =>
      ({
        companionPath: companion,
        repositoryId: "acme-app",
        repository: { id: "acme-app", path: repo },
      }) as unknown as LaunchContext;
    const attribute = async () => null;
    const config = path.join(companion, "claude-config");
    const jobDir = path.join(config, "jobs", "acme");
    await fs.mkdir(jobDir, { recursive: true });
    const writeJob = (state: object) =>
      fs.writeFile(path.join(jobDir, "state.json"), JSON.stringify(state));
    const isolated = async (argv: string[], sessionEnv: Record<string, string>) =>
      (await run(argv, { attribute, resolveContext, sessionEnv })).map(
        (result) => result.session.isolated,
      );
    const bg = { CLAUDE_JOB_DIR: jobDir, CLAUDE_CONFIG_DIR: config };

    await writeJob({});
    const [read] = await run(["x"], { attribute, resolveContext, sessionEnv: bg });
    expect(read.session).toEqual({ isolated: true });
    expect(await readRaw("x").catch(() => null)).toBeNull();
    expect(await isolated(["a", "b"], bg)).toEqual([true, true]);

    // The VS Code extension launches with `--settings` that turn isolation off.
    const inPlace = JSON.stringify({ worktree: { bgIsolation: "none" } });
    await writeJob({ respawnFlags: ["--bg", "--settings", inPlace] });
    expect(await isolated(["x"], bg)).toEqual([false]);
    await writeJob({ bgIsolation: "none" });
    expect(await isolated(["x"], bg)).toEqual([false]);
    expect(await isolated(["x"], { CLAUDE_CONFIG_DIR: config })).toEqual([false]);
  });

  test("regrouping preserves recorded delivery until an explicit branch edit", async () => {
    await run(["x", "--branch", "workset/x"]);
    await fs.mkdir(path.join(companion, "worksets"));
    await fs.writeFile(
      path.join(companion, "worksets/acme-login.yaml"),
      `id: acme-login\nrepositories: [${REPO}]\nchanges: [x]\n`,
    );
    const [read] = await run(["x"]);
    // The recorded branch stays the Workset's Delivery Branch.
    expect(read.defaultBranch).toBe("workset/x");
    expect(read.record.deliveries[0].branch).toBe("workset/x");
    expect(await readRaw("x")).toContain("workset/x");
    const [edited] = await run(["x", "--branch", "workset/acme-login"]);
    expect(edited.record.deliveries[0].branch).toBe("workset/acme-login");
  });

  describe("--ticket", () => {
    const jira = { loadCapabilities: async () => [{ name: "openspec", ticket: "jira" }] };

    test("records the branch the ticket names, not the ticket", async () => {
      const [result] = await run(["x", "--ticket", "abc-123"], jira);
      expect(result).toMatchObject({
        ticketFormat: "jira",
        defaultBranch: "workset/ABC-123-x",
        record: { deliveries: [{ repository: REPO, branch: "workset/ABC-123-x" }] },
      });
      expect(await readRaw("x")).not.toContain("ticket");
    });

    test("is refused together with --branch or --not-applicable", async () => {
      await run(["x", "--branch", "workset/ABC-123-x", "--ticket", "ABC-123"], jira);
      expect(err.join()).toContain("excludes --branch and --not-applicable");
      expect(process.exitCode).toBe(1);
      await expect(readRaw("x")).rejects.toThrow();
    });

    test("an invalid key names the format and writes nothing", async () => {
      await run(["x", "--ticket", "abc123"], jira);
      expect(err.join()).toContain("Jira key such as ABC-123");
      expect(process.exitCode).toBe(1);
      await expect(readRaw("x")).rejects.toThrow();
    });

    test("is refused while tickets are off", async () => {
      await run(["x", "--ticket", "ABC-123"]);
      expect(err.join()).toContain("ticket: jira");
      expect(process.exitCode).toBe(1);
      await expect(readRaw("x")).rejects.toThrow();
    });

    test("an unknown setting counts as off and is warned about", async () => {
      const [result] = await run(["x"], {
        loadCapabilities: async () => [{ name: "openspec", ticket: "linear" }],
      });
      expect(result.ticketFormat).toBe("none");
      expect(err.join()).toContain('Unknown ticket setting "linear"');
    });

    test("reading reports defaultBranch and ticketCandidate and writes nothing", async () => {
      await run(["x", "--ticket", "ABC-123"], jira);
      const [ticketed] = await run(["x"], jira);
      expect(ticketed).toMatchObject({
        defaultBranch: "workset/ABC-123-x",
        ticketCandidate: "ABC-123",
      });
      const [candidate] = await run(["a"], {
        ...jira,
        workingRepoGit: () => repoGit({ currentBranch: async () => "feature/ABC-9-retry" }),
      });
      expect(candidate.ticketCandidate).toBe("ABC-9");
      await expect(readRaw("a")).rejects.toThrow();
    });
  });

  test("regrouping reports differing recorded branches", async () => {
    await run(["x", "--branch", "workset/x"]);
    await run(["a", "--branch", "workset/acme-login"]);
    await fs.mkdir(path.join(companion, "worksets"));
    await fs.writeFile(
      path.join(companion, "worksets/acme-login.yaml"),
      `id: acme-login\nrepositories: [${REPO}]\nchanges: [x, a]\n`,
    );
    const [read] = await run(["x"]);
    expect(read.defaultBranch).toBeNull();
    expect(read.record.deliveries[0].branch).toBe("workset/x");
    expect(err.join()).toContain("record different branches");
  });

  test("--fetch needs --refresh", async () => {
    await runArtifactLinkCommand(["x", "--fetch"], deps());
    expect(err.join("\n")).toContain("--fetch needs --refresh");
    expect(process.exitCode).toBe(1);
  });

  test("--branch records the Working Repository's delivery branch", async () => {
    const [result] = await run(["x", "--branch", "change/x"]);
    expect(result.record.deliveries).toEqual([{ repository: REPO, branch: "change/x" }]);
    expect(result.settlement.status).toBe("waiting");
    expect(await readRaw("x")).toContain("change/x");
  });

  test("a protected branch is refused without --direct and recorded as direct with it", async () => {
    for (const branch of ["main", "release/2"]) {
      await run(["x", "--branch", branch]);
      expect(process.exitCode).toBe(1);
      expect(err[0]).toContain("--direct");
      process.exitCode = 0;
    }
    const [result] = await run(["x", "--branch", "main", "--direct"]);
    expect(result.record.deliveries[0]).toEqual({ repository: REPO, branch: "main", direct: true });
  });

  test("--direct records a direct delivery on an unprotected branch", async () => {
    const [result] = await run(["x", "--branch", "change/x", "--direct"]);
    expect(result.record.deliveries[0]).toEqual({
      repository: REPO,
      branch: "change/x",
      direct: true,
    });
  });

  test("a repeated or bare value flag is refused instead of read as absent", async () => {
    for (const argv of [
      ["x", "--repository", "acme/a", "--repository", "acme/b", "--branch", "change/x"],
      ["x", "--branch"],
      ["x", "--branch", "change/x", "--pr"],
    ]) {
      await run(argv);
      expect(process.exitCode).toBe(1);
      expect(err[0]).toContain("takes exactly one value");
      process.exitCode = 0;
    }
    await expect(readRaw("x")).rejects.toThrow();
  });

  test("another repository without forge access is recorded without a warning", async () => {
    const [result] = await run(["x", "--repository", "acme/acme-lib", "--branch", "develop"]);
    expect(result.record.deliveries).toEqual([{ repository: "acme/acme-lib", branch: "develop" }]);
    expect(err).toEqual([]);
  });

  test("a branch protected only on the forge is recorded without asking the forge", async () => {
    const { calls, fetch } = respond({});
    const [result] = await run(["x", "--branch", "staging/acme"], {
      forge: { fetch },
      resolveToken: async () => ({ token: TOKEN, source: "MATE_GIT_TOKEN" }),
    });
    expect(result.record.deliveries).toEqual([{ repository: REPO, branch: "staging/acme" }]);
    expect(calls).toEqual([]);
  });

  test("a confirmation without a recorded branch is refused and writes nothing", async () => {
    await run(["x", "--confirm-merged"]);
    expect(process.exitCode).toBe(1);
    await expect(readRaw("x")).rejects.toThrow();
  });

  test("an edit without an origin remote names --repository", async () => {
    await run(["x", "--branch", "change/x"], {
      workingRepoGit: () => repoGit({ remoteUrl: async () => null }),
    });
    expect(process.exitCode).toBe(1);
    expect(err[0]).toBe(
      "mate: the Working Repository has no origin remote to identify it; pass --repository <org/repo>.",
    );
    process.exitCode = 0;
  });

  test("--repository must be a repository path and a case variant keeps the Working Repository's delivery", async () => {
    await run(["x", "--repository", "acme-app", "--branch", "change/x"]);
    expect(process.exitCode).toBe(1);
    expect(err[0]).toBe(
      "mate: --repository expects a repository path such as <org/repo> or <group/subgroup/repo>.",
    );
    await expect(readRaw("x")).rejects.toThrow();
    process.exitCode = 0;

    const [result] = await run(["x", "--repository", "Acme/Acme-App", "--branch", "change/x"]);
    expect(result.record.deliveries).toEqual([{ repository: REPO, branch: "change/x" }]);
  });

  test("an unknown change is refused", async () => {
    await run(["nope", "--branch", "b"]);
    expect(process.exitCode).toBe(1);
    expect(err[0]).toContain("nope");
  });

  test("the token never reaches output, errors, or delivery.yaml", async () => {
    const { fetch } = respond({
      [`${API}/pulls?`]: { status: 403, body: { message: `token ${TOKEN} lacks access` } },
    });
    await run(["x", "--branch", "change/x"]);
    const [result] = await run(["x", "--refresh"], {
      forge: { fetch },
      resolveToken: async () => ({ token: TOKEN, source: "MATE_GIT_TOKEN" }),
    });
    expect(result.outcomes[0]).toMatchObject({
      needsAnswer: true,
      answerReason: "forge-failure",
      failure: { reason: "permission", permission: "Pull requests: read" },
    });
    expect([...out, ...err].join("\n")).not.toContain(TOKEN);
    expect(await readRaw("x")).not.toContain(TOKEN);

    out = [];
    await runArtifactLinkCommand(["x", "--refresh"], {
      ...deps({
        forge: { fetch },
        resolveToken: async () => ({ token: TOKEN, source: "MATE_GIT_TOKEN" }),
      }),
    });
    expect([...out, ...err].join("\n")).not.toContain(TOKEN);
    expect(out.join("\n")).toContain("Pull requests: read");
  });

  test("a direct delivery's refresh asks the user and records nothing", async () => {
    await run(["x", "--branch", "main", "--direct"]);
    const [result] = await run(["x", "--refresh"]);
    expect(result.outcomes[0]).toMatchObject({ answerReason: "direct", needsAnswer: true });
    expect(result.outcomes[0]).not.toHaveProperty("evidence");
    expect(result.record.deliveries[0].merge).toBeUndefined();

    out = [];
    await runArtifactLinkCommand(["x", "--refresh"], deps());
    expect(out).toContain("  main: needs an answer (direct)");
  });
});

describe("repository identity", () => {
  const NESTED = "acme/platform/api";
  const scoped = async (repository: string) =>
    fs.writeFile(
      path.join(companion, "openspec", "changes", "x", "proposal.md"),
      `---\nscopes:\n  - repository: ${repository}\n    area: .\n---\n`,
    );

  test("a nested remote keys the delivery by its full path and settles the nested scope", async () => {
    await scoped(NESTED);
    const [result] = await run(["x", "--branch", "change/x"], {
      workingRepoGit: () =>
        repoGit({ remoteUrl: async () => "git@gitlab.acme.dev:acme/platform/api.git" }),
    });
    expect(result.record.deliveries).toEqual([{ repository: NESTED, branch: "change/x" }]);
    expect(result.settlement.missing ?? []).toEqual([]);
  });

  test("a linked repository's host is used, so a GitLab repository gets no GitHub request", async () => {
    const { calls, fetch } = respond({});
    const [result] = await run(["x", "--repository", "acme/platform/web", "--branch", "develop"], {
      loadLinkedRepositories: async () => [
        { id: "acme-app", path: "/repo" },
        { id: "web", path: "/web" },
      ],
      workingRepoGit: (repoPath) =>
        repoGit(
          repoPath === "/web"
            ? { remoteUrl: async () => "https://gitlab.acme.dev/acme/platform/web.git" }
            : {},
        ),
      forge: { fetch },
      resolveToken: async () => ({ token: TOKEN, source: "MATE_GIT_TOKEN" }),
    });
    expect(result.record.deliveries).toEqual([
      { repository: "acme/platform/web", branch: "develop" },
    ]);
    expect(calls).toEqual([]);
  });

  test("a delivery outside the scopes is warned about without changing the record or exit code", async () => {
    await scoped("acme/api");
    const [result] = await run(["x", "--repository", "acme/web", "--branch", "change/x"]);
    expect(process.exitCode).toBe(0);
    expect(result.settlement.unscoped).toEqual([{ repository: "acme/web" }]);
    expect(err).toContain("warning: acme/web matches none of x's scopes.");
    expect(await readRaw("x")).toContain("repository: acme/web");
  });

  test("a matching scope spelling, ignoring case, stays quiet", async () => {
    await scoped("Acme/Acme-App");
    const [result] = await run(["x", "--branch", "change/x"]);
    expect(result.settlement.unscoped).toEqual([]);
    expect(err.filter((line) => line.includes("matches none"))).toEqual([]);
  });

  test("an unimplemented dependency is warned about and never blocks the record", async () => {
    const changes = path.join(companion, "openspec", "changes");
    await fs.writeFile(path.join(changes, "x", "proposal.md"), "---\ndependsOn: [a, b]\n---\n");
    await fs.writeFile(path.join(changes, "a", "tasks.md"), "- [x] 1.1 done\n- [ ] 1.2 open\n");
    await fs.writeFile(path.join(changes, "b", "tasks.md"), "- [x] 1.1 done\n");
    const [result] = await run(["x", "--branch", "change/x"]);
    expect(process.exitCode).toBe(0);
    expect(result.warnings).toEqual([expect.objectContaining({ kind: "dependency", change: "a" })]);
    expect(err).toEqual([`warning: ${result.warnings[0].message}`]);
    expect(await readRaw("x")).toContain("branch: change/x");
  });

  test("an unlinked repository is looked up on the Working Repository's host", async () => {
    const { calls, fetch } = respond({});
    await run(["x", "--repository", "acme/acme-lib", "--branch", "develop"], {
      forge: { fetch },
      resolveToken: async () => ({ token: TOKEN, source: "MATE_GIT_TOKEN" }),
    });
    expect(calls[0]).toStartWith("https://api.github.com/repos/acme/acme-lib");
  });
});

describe("mate artifact link in an Umbrella Repository", () => {
  let umbrella: string;
  const ORIGINS: Record<string, string> = {
    api: "git@github.com:acme/api.git",
    web: "https://github.com/acme/web.git",
  };

  beforeEach(async () => {
    umbrella = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "artifact-link-acme-")));
    for (const child of Object.keys(ORIGINS)) {
      await fs.mkdir(path.join(umbrella, child, ".git"), { recursive: true });
    }
  });

  afterEach(async () => {
    await fs.rm(umbrella, { recursive: true, force: true });
  });

  async function scope(change: string, ...repositories: string[]): Promise<void> {
    const scopes = repositories.map((repository) => `  - repository: ${repository}\n    area: .\n`);
    await fs.writeFile(
      path.join(companion, "openspec", "changes", change, "proposal.md"),
      `---\nchange: ${change}\nscopes:\n${scopes.join("")}---\n\n## Why\n`,
    );
  }

  const inUmbrella = (): Partial<LinkCommandDeps> => ({
    resolveContext: async () =>
      ({
        companionPath: companion,
        repositoryId: "acme",
        repository: { id: "acme", path: umbrella },
      }) as unknown as LaunchContext,
    workingRepoGit: (repoPath) =>
      repoGit({ remoteUrl: async () => ORIGINS[path.basename(repoPath)] ?? null }),
    readChildOrigin: async (checkout) => ORIGINS[path.basename(checkout)] ?? null,
  });

  test("one scoped child takes the delivery", async () => {
    await scope("x", "acme/api");
    const [result] = await run(["x", "--branch", "workset/x"], inUmbrella());
    expect(process.exitCode).toBe(0);
    expect(result.record.deliveries).toEqual([{ repository: "acme/api", branch: "workset/x" }]);
  });

  test("two scoped children are refused and name both", async () => {
    await scope("x", "acme/api", "acme/web");
    await run(["x", "--branch", "workset/x"], inUmbrella());
    expect(process.exitCode).toBe(1);
    expect(err[0]).toContain("acme/api, acme/web");
    expect(err[0]).toContain("--repository");
    await expect(readRaw("x")).rejects.toThrow();
    process.exitCode = 0;
  });

  test("an explicit repository is recorded, and a read needs none", async () => {
    await scope("x", "acme/api", "acme/web");
    const [read] = await run(["x"], inUmbrella());
    expect(process.exitCode).toBe(0);
    expect(read.record.deliveries).toEqual([]);
    const [result] = await run(
      ["x", "--repository", "acme/web", "--branch", "workset/x"],
      inUmbrella(),
    );
    expect(result.record.deliveries).toEqual([{ repository: "acme/web", branch: "workset/x" }]);
  });

  test("an unknown change is refused as unknown, not for the umbrella", async () => {
    await run(["acme-typo", "--branch", "workset/x"], inUmbrella());
    expect(process.exitCode).toBe(1);
    expect(err[0]).toBe('mate: no active or archived change named "acme-typo".');
    process.exitCode = 0;
  });

  test("a refresh through the one scoped child still refreshes every delivery", async () => {
    await scope("x", "acme/api");
    await run(["x", "--branch", "main", "--direct"], inUmbrella());
    await run(["x", "--repository", "acme/web", "--branch", "main", "--direct"], inUmbrella());
    const [result] = await run(["x", "--refresh"], inUmbrella());
    expect(process.exitCode).toBe(0);
    expect(result.outcomes.map((outcome) => outcome.repository)).toEqual(["acme/api", "acme/web"]);
  });
});

/** @test-requires sockets */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parse } from "yaml";

import {
  DEFAULT_TEST_TIMEOUT_MS,
  type E2EScenario,
  createScenario,
  initWorkingRepoGit,
  linkRepository,
  runGit,
  runMate,
  setupCompanion,
  writeAdapterStub,
  removeScenarios,
} from "./cli-e2e-support";

setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);
afterEach(removeScenarios);

describe("worktree Checkouts (share-repository-link-across-worktrees)", () => {
  /** A linked clone with one commit, so `git worktree add` has a branch to check out. */
  async function linkedClone(prefix: string): Promise<E2EScenario> {
    const scenario = await createScenario(prefix);
    initWorkingRepoGit(scenario);
    await fs.writeFile(path.join(scenario.working, "README.md"), "# app\n", "utf8");
    runGit(scenario.working, ["add", "README.md"]);
    runGit(scenario.working, [
      "-c",
      "user.email=mate-e2e@example.com",
      "-c",
      "user.name=Mate E2E",
      "commit",
      "-qm",
      "initial",
    ]);
    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);
    return scenario;
  }

  async function addWorktree(
    scenario: E2EScenario,
    folder: string,
    branch: string,
  ): Promise<string> {
    runGit(scenario.working, ["worktree", "add", "-q", "-b", branch, folder]);
    return fs.realpath(folder);
  }

  async function registryText(scenario: E2EScenario): Promise<string> {
    return fs.readFile(path.join(scenario.companion, ".mate", "config", "registry.yaml"), "utf8");
  }

  type Layout = "sibling" | "nested" | "elsewhere" | "bare";

  /** A bare clone whose first worktree, the scenario's working folder, is linked. */
  async function linkedBareClone(prefix: string): Promise<{ scenario: E2EScenario; bare: string }> {
    const scenario = await createScenario(prefix);
    const seed = path.join(scenario.root, "seed");
    runGit(scenario.root, ["init", "-q", "--initial-branch=main", seed]);
    await fs.writeFile(path.join(seed, "README.md"), "# app\n", "utf8");
    runGit(seed, ["add", "README.md"]);
    runGit(seed, [
      "-c",
      "user.email=mate-e2e@example.com",
      "-c",
      "user.name=Mate E2E",
      "commit",
      "-qm",
      "initial",
    ]);
    const bare = path.join(scenario.root, "app.git");
    runGit(scenario.root, ["clone", "-q", "--bare", seed, bare]);
    runGit(bare, ["worktree", "add", "-q", scenario.working, "main"]);
    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);
    return { scenario, bare };
  }

  /** The linked Checkout, and another Checkout of its clone in `layout`. */
  async function checkoutsIn(layout: Layout): Promise<{ scenario: E2EScenario; other: string }> {
    const prefix = `mate-cli-e2e-worktree-${layout}-`;
    if (layout === "bare") {
      const { scenario, bare } = await linkedBareClone(prefix);
      const other = path.join(scenario.root, "app-fix");
      runGit(bare, ["worktree", "add", "-q", "-b", "fix", other]);
      return { scenario, other: await fs.realpath(other) };
    }
    const scenario = await linkedClone(prefix);
    const folders: Record<Exclude<Layout, "bare">, string> = {
      sibling: path.join(scenario.root, "app-fix"),
      nested: path.join(scenario.working, ".claude", "worktrees", "fix"),
      elsewhere: path.join(scenario.root, "elsewhere", "deep", "fix"),
    };
    return { scenario, other: await addWorktree(scenario, folders[layout], "fix") };
  }

  async function repositoryLinkAt(checkout: string): Promise<{ id: string; path: string }> {
    const raw = await fs.readFile(path.join(checkout, ".mate", "config", "registry.yaml"), "utf8");
    return (parse(raw) as { repository: { id: string; path: string } }).repository;
  }

  for (const layout of ["sibling", "nested", "elsewhere", "bare"] as const) {
    test(`in a ${layout} worktree, resolve, launch, prepare, wrap and cleanup keep one entry per clone`, async () => {
      const { scenario, other } = await checkoutsIn(layout);
      const capturePath = await writeAdapterStub(scenario, "claude");
      const registry = await registryText(scenario);
      const entries = (parse(registry) as { repos: { id: string; path: string }[] }).repos;
      expect(entries.map(({ id, path: entryPath }) => ({ id, path: entryPath }))).toEqual([
        { id: "app", path: scenario.working },
      ]);

      const doctor = await runMate(scenario, { cwd: other, args: ["doctor", "--json"] });
      const report = JSON.parse(doctor.stdout) as {
        repositoryId: string | null;
        companionPath: string | null;
        checkout?: { role: string; registeredCheckout: string | null };
      };
      expect(report).toMatchObject({
        repositoryId: "app",
        companionPath: scenario.companion,
        checkout: { role: "other", registeredCheckout: scenario.working },
      });

      const launch = await runMate(scenario, {
        cwd: other,
        args: ["claude", "--print", "hello"],
        input: "y\n",
        env: { MATE_E2E_CAPTURE_PATH: capturePath },
      });
      expect(launch.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        cwd: string;
        env: Record<string, string | null>;
      };
      expect(capture.cwd).toBe(other);
      expect(capture.env.MATE_REPO_PATH).toBe(other);

      const prepare = await runMate(scenario, {
        cwd: other,
        args: ["session", "prepare", "--repo", other, "--json"],
      });
      expect(prepare.exitCode).toBe(0);
      const wrap = await runMate(scenario, { cwd: other, args: ["wrap"] });
      expect(wrap.exitCode).toBe(0);

      expect(await repositoryLinkAt(scenario.working)).toEqual({
        id: "app",
        path: scenario.working,
      });
      expect(await repositoryLinkAt(other)).toEqual({ id: "app", path: other });
      expect(await registryText(scenario)).toBe(registry);

      const cleanup = await runMate(scenario, { cwd: other, args: ["working", "cleanup"] });
      expect(cleanup.exitCode).toBe(0);
      expect(cleanup.stdout).toContain(`${other} is another Checkout of app`);
      expect(existsSync(path.join(scenario.working, ".mate", "config", "registry.yaml"))).toBe(
        true,
      );
      expect(await registryText(scenario)).toBe(registry);
    }, 120_000);
  }

  test("mate claude in a nested worktree starts Claude in the worktree, naming it in MATE_REPO_PATH", async () => {
    const scenario = await linkedClone("mate-cli-e2e-worktree-launch-");
    const capturePath = await writeAdapterStub(scenario, "claude");
    const worktree = await addWorktree(
      scenario,
      path.join(scenario.working, ".claude", "worktrees", "feature"),
      "feature",
    );
    const registry = await registryText(scenario);

    const result = await runMate(scenario, {
      cwd: worktree,
      args: ["claude", "--print", "hello"],
      input: "y\n",
      env: { MATE_E2E_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
      cwd: string;
      env: Record<string, string | null>;
    };
    expect(capture.cwd).toBe(worktree);
    expect(capture.env.MATE_REPO_PATH).toBe(worktree);
    expect(capture.env.MATE_REPO_ID).toBe("app");
    expect(await registryText(scenario)).toBe(registry);
  });

  test("two concurrent mate session prepare runs adopt one new worktree once", async () => {
    const scenario = await linkedClone("mate-cli-e2e-worktree-prepare-");
    expect((await runMate(scenario, { cwd: scenario.working, args: ["wrap"] })).exitCode).toBe(0);
    const worktree = await addWorktree(scenario, path.join(scenario.root, "app-fix"), "fix");
    const registry = await registryText(scenario);

    const runs = await Promise.all(
      [0, 1].map(() =>
        runMate(scenario, {
          cwd: worktree,
          args: ["session", "prepare", "--repo", worktree, "--json"],
        }),
      ),
    );

    for (const run of runs) expect(run.exitCode).toBe(0);
    const link = parse(
      await fs.readFile(path.join(worktree, ".mate", "config", "registry.yaml"), "utf8"),
    ) as { repository: { id: string; path: string }; companions: { path: string }[] };
    expect(link.repository).toEqual({ id: "app", path: worktree });
    expect(link.companions.map((pointer) => pointer.path)).toEqual([scenario.companion]);
    const projection = parse(
      await fs.readFile(path.join(worktree, ".mate", "projection.yaml"), "utf8"),
    ) as { repositoryPath: string; repositoryId: string };
    expect(projection).toMatchObject({ repositoryPath: worktree, repositoryId: "app" });
    expect(await fs.readlink(path.join(worktree, ".mate", "companion"))).toBe(scenario.companion);
    expect(await registryText(scenario)).toBe(registry);
    /**
     * One run wrapped it, or both did; a run that found the lock held left the
     * wrap to the other. The main worktree's settings carry the session-prepare
     * hook that serves it, so its own leave that hook out.
     */
    const hooksOf = async (checkout: string) =>
      JSON.stringify(
        (
          JSON.parse(
            await fs.readFile(path.join(checkout, ".claude", "settings.local.json"), "utf8"),
          ) as { hooks?: unknown }
        ).hooks ?? {},
      );
    expect(await hooksOf(scenario.working)).toContain("session-prepare");
    expect(await hooksOf(worktree)).not.toContain("session-prepare");
  });

  test("mate claude in a sibling worktree loads each hook group once across the settings it reads", async () => {
    const scenario = await linkedClone("mate-cli-e2e-worktree-hooks-");
    const capturePath = await writeAdapterStub(scenario, "claude");
    const worktree = await addWorktree(scenario, path.join(scenario.root, "app-fix"), "fix");

    const result = await runMate(scenario, {
      cwd: worktree,
      args: ["claude", "--print", "hello"],
      input: "y\n",
      env: { MATE_E2E_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const { argv } = JSON.parse(await fs.readFile(capturePath, "utf8")) as { argv: string[] };
    expect(argv).not.toContain("--mcp-config");
    const settingsAt = argv.indexOf("--settings");
    const files = [
      path.join(scenario.working, ".claude", "settings.local.json"),
      path.join(worktree, ".claude", "settings.local.json"),
      ...(settingsAt >= 0 ? [argv[settingsAt + 1]!] : []),
    ];
    const keys: string[] = [];
    for (const file of files) {
      const raw = await fs.readFile(file, "utf8").catch(() => "{}");
      const hooks = (JSON.parse(raw) as { hooks?: Record<string, unknown[]> }).hooks ?? {};
      for (const [event, groups] of Object.entries(hooks)) {
        for (const group of groups) keys.push(`${event} ${JSON.stringify(group)}`);
      }
    }
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
    expect(keys.some((key) => key.startsWith("SubagentStart "))).toBe(true);
    expect(keys.some((key) => key.includes("session-prepare"))).toBe(true);
  });
});

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { getWrapperBinPath } from "./lib/package-paths";
import { runtimeWrapperBinPath } from "./runtime/runtime-directory";
import { openSpecCliDeps } from "./lib/openspec-cli";
import { checkStoreRegistration, openSpecStoreDeps } from "./lib/orchestrator/openspec-store";
import type { ProjectionEntryOutcome } from "./lib/orchestrator/projection-types";
import { writeRepoLocalRegistryEntry } from "./lib/orchestrator/repository-link";
import type { LinkedRepository } from "./lib/orchestrator/types";
import { project } from "./lib/orchestrator/working-repo-projection";
import { resolveCommandOnPath } from "./tools/setup/utils";
import { findRealOpenSpec } from "../test/real-openspec";

/**
 * The store pointer against the real OpenSpec CLI, through the real wrapper,
 * with OpenSpec's data and config directories isolated per test. Skipped where
 * no real `openspec` is installed.
 */

const SCHEMA_SOURCE = path.join(import.meta.dirname, "templates", "capabilities", "openspec-cap");
/**
 * Where a projection says the wrappers live, under the test run's HOME; linked
 * to the package's wrappers the way the runtime directory is.
 */
const WRAPPER_BIN = runtimeWrapperBinPath();
fs.mkdirSync(path.dirname(path.dirname(WRAPPER_BIN)), { recursive: true });
fs.rmSync(path.dirname(WRAPPER_BIN), { recursive: true, force: true });
fs.symlinkSync(path.dirname(getWrapperBinPath()), path.dirname(WRAPPER_BIN));

const REAL_OPENSPEC = findRealOpenSpec();
const NODE_DIR = path.dirname(
  resolveCommandOnPath("node", process.env.PATH ?? "") ?? "/usr/bin/node",
);

const tempRoots: string[] = [];
const originalDeps = { ...openSpecStoreDeps };
const originalCliDeps = { ...openSpecCliDeps };

afterEach(() => {
  Object.assign(openSpecStoreDeps, originalDeps);
  Object.assign(openSpecCliDeps, originalCliDeps);
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  companion: string;
  env: NodeJS.ProcessEnv;
  /** How many times Mate looked for the binary to register with. */
  registrations: () => number;
}

/** Isolated OpenSpec state and a companion that is a `mate-v1` OpenSpec root. */
function makeSandbox(): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openspec-e2e-")));
  tempRoots.push(root);
  const companion = path.join(root, "acme-companion");
  fs.mkdirSync(path.join(companion, "openspec", "schemas"), { recursive: true });
  fs.cpSync(
    path.join(SCHEMA_SOURCE, "mate-v1"),
    path.join(companion, "openspec", "schemas", "mate-v1"),
    {
      recursive: true,
    },
  );
  fs.writeFileSync(path.join(companion, "openspec", "config.yaml"), "schema: mate-v1\n");

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("MATE_")) env[key] = value;
  }
  env.XDG_DATA_HOME = path.join(root, "data");
  env.XDG_CONFIG_HOME = path.join(root, "config");
  env.PATH = [WRAPPER_BIN, path.dirname(REAL_OPENSPEC!), NODE_DIR, "/usr/bin", "/bin"].join(
    path.delimiter,
  );

  let registrations = 0;
  openSpecStoreDeps.env = () => env;
  openSpecCliDeps.locate = () => {
    registrations += 1;
    return { bin: REAL_OPENSPEC! };
  };
  return { root, companion, env, registrations: () => registrations };
}

/** A linked Git Working Repository with one commit and a nested package. */
async function makeRepo(
  sandbox: Sandbox,
  name: string,
  gitignore?: string,
): Promise<LinkedRepository> {
  const repoPath = path.join(sandbox.root, name);
  fs.mkdirSync(path.join(repoPath, "packages", "web"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "packages", "web", "index.ts"), "export {};\n");
  if (gitignore !== undefined) fs.writeFileSync(path.join(repoPath, ".gitignore"), gitignore);
  execFileSync("git", ["init", "-q"], { cwd: repoPath });
  execFileSync("git", ["add", "-A"], { cwd: repoPath });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoPath });
  const repository = { id: name, path: repoPath };
  await writeRepoLocalRegistryEntry(repoPath, sandbox.companion, repository, "git");
  return repository;
}

function projectWrap(sandbox: Sandbox, repository: LinkedRepository) {
  return project("wrap", {
    repoPath: repository.path,
    companionPath: sandbox.companion,
    repository,
  });
}

function pointerOutcome(outcomes: ProjectionEntryOutcome[]): ProjectionEntryOutcome {
  return outcomes.find((outcome) => outcome.id === "openspec-store-pointer")!;
}

/** Runs `openspec` as an agent would: through the wrapper, from inside the repository. */
function openspec(sandbox: Sandbox, cwd: string, args: string[]) {
  const result = spawnSync(path.join(WRAPPER_BIN, "openspec"), args, {
    cwd,
    env: sandbox.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`openspec ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** The real binary directly, bypassing the wrapper, as an operator might. */
function realOpenspec(sandbox: Sandbox, cwd: string, args: string[]) {
  return execFileSync(REAL_OPENSPEC!, args, { cwd, env: sandbox.env, encoding: "utf8" });
}

function allowedEditRoots(sandbox: Sandbox, cwd: string, extra: string[] = []): string[] {
  const status = JSON.parse(
    openspec(sandbox, cwd, ["status", "--change", "demo", "--json", ...extra]),
  );
  return status.actionContext.allowedEditRoots;
}

function gitStatus(repoPath: string): string {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoPath,
    encoding: "utf8",
  });
}

function registeredStoreIds(sandbox: Sandbox): string[] {
  const registry = fs.readFileSync(
    path.join(sandbox.env.XDG_DATA_HOME!, "openspec", "stores", "registry.yaml"),
    "utf8",
  );
  return [...registry.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((match) => match[1]);
}

/** Enough content for `validate`, `show` and `archive` to accept the change. */
function fillChange(sandbox: Sandbox, name: string): void {
  const change = path.join(sandbox.companion, "openspec", "changes", name);
  fs.writeFileSync(
    path.join(change, "proposal.md"),
    "## Why\n\nThe demo needs a reason that is long enough.\n\n## What Changes\n\n- Adds a demo.\n",
  );
  fs.mkdirSync(path.join(change, "specs", "demo"), { recursive: true });
  fs.writeFileSync(
    path.join(change, "specs", "demo", "spec.md"),
    "## ADDED Requirements\n\n### Requirement: Demo\nThe system SHALL demo.\n\n#### Scenario: Demo runs\n- **WHEN** it runs\n- **THEN** it demos\n",
  );
}

describe.skipIf(!REAL_OPENSPEC)("the OpenSpec store pointer with the real CLI", () => {
  test("names the Working Repository as edit root, with and without --store", async () => {
    const sandbox = makeSandbox();
    const acme = await makeRepo(sandbox, "acme");
    await projectWrap(sandbox, acme);
    const web = path.join(acme.path, "packages", "web");
    openspec(sandbox, web, ["new", "change", "demo"]);

    expect(allowedEditRoots(sandbox, web)).toEqual([acme.path, sandbox.companion]);
    expect(allowedEditRoots(sandbox, web, ["--store", "acme-companion"])).toEqual([
      acme.path,
      sandbox.companion,
    ]);
    expect(openspec(sandbox, web, ["templates", "--json"])).toContain("mate-v1");
  });

  test("two checkouts of one companion share a single registration", async () => {
    const sandbox = makeSandbox();
    const acme = await makeRepo(sandbox, "acme");
    const acme2 = await makeRepo(sandbox, "acme-2");
    await projectWrap(sandbox, acme);
    await projectWrap(sandbox, acme2);
    openspec(sandbox, acme.path, ["new", "change", "demo"]);

    for (const repo of [acme, acme2]) {
      expect(fs.readFileSync(path.join(repo.path, "openspec", "config.yaml"), "utf8")).toContain(
        "store: acme-companion",
      );
      expect(allowedEditRoots(sandbox, path.join(repo.path, "packages", "web"))[0]).toBe(repo.path);
    }
    expect(registeredStoreIds(sandbox)).toEqual(["acme-companion"]);
    expect(sandbox.registrations()).toBe(1);
  });

  test("a session projection heals a repository without a pointer, then spawns nothing", async () => {
    const sandbox = makeSandbox();
    const acme = await makeRepo(sandbox, "acme");
    const session = () =>
      project("session", {
        repoPath: acme.path,
        companionPath: sandbox.companion,
        repository: acme,
      });

    await session();

    expect(fs.readFileSync(path.join(acme.path, ".git", "info", "exclude"), "utf8")).toContain(
      "/openspec/\n",
    );
    expect(fs.existsSync(path.join(acme.path, "openspec", "config.yaml"))).toBe(true);
    expect(await checkStoreRegistration(sandbox.companion, "acme-companion")).toEqual({
      state: "registered",
    });
    expect(pointerOutcome((await session()).outcomes).state).toBe("current");
    expect(sandbox.registrations()).toBe(1);
  });

  test("OpenSpec commands from the repository leave its Git status empty", async () => {
    const sandbox = makeSandbox();
    const acme = await makeRepo(sandbox, "acme");
    await projectWrap(sandbox, acme);
    const web = path.join(acme.path, "packages", "web");
    expect(gitStatus(acme.path)).toBe("");

    const steps: Array<() => unknown> = [
      () => openspec(sandbox, web, ["new", "change", "demo"]),
      () => fillChange(sandbox, "demo"),
      () => openspec(sandbox, web, ["status", "--change", "demo", "--json"]),
      () => openspec(sandbox, web, ["instructions", "apply", "--change", "demo", "--json"]),
      () => openspec(sandbox, web, ["list", "--json"]),
      () => openspec(sandbox, web, ["validate", "demo"]),
      () => openspec(sandbox, web, ["show", "demo", "--json"]),
      () => openspec(sandbox, web, ["archive", "demo", "--yes"]),
      () => realOpenspec(sandbox, acme.path, ["init", "--tools", "none"]),
      () => realOpenspec(sandbox, acme.path, ["update"]),
    ];
    const pointer = fs.readFileSync(path.join(acme.path, "openspec", "config.yaml"), "utf8");
    for (const step of steps) {
      step();
      expect(gitStatus(acme.path)).toBe("");
    }

    expect(fs.readFileSync(path.join(acme.path, "openspec", "config.yaml"), "utf8")).toBe(pointer);
    expect(fs.readdirSync(path.join(sandbox.companion, "openspec", "changes", "archive"))).toEqual([
      expect.stringMatching(/-demo$/),
    ]);
  });

  test("a .gitignore that re-includes the pointer gets no pointer, only a warning", async () => {
    const sandbox = makeSandbox();
    const acme = await makeRepo(sandbox, "acme", "!openspec/\n");

    const pointer = pointerOutcome((await projectWrap(sandbox, acme)).outcomes);

    expect(pointer.state).toBe("skipped");
    expect(pointer.warnings?.join("\n")).toContain("not ignored by Git");
    expect(fs.existsSync(path.join(acme.path, "openspec", "config.yaml"))).toBe(false);
    expect(gitStatus(acme.path)).toBe("");
  });
});

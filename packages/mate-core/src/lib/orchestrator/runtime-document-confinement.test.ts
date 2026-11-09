import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { addWorktree, git, initRepo } from "../../../test/git-checkouts";
import { runUnwrapCommand } from "../../cli/commands/unwrap";
import { FRAMEWORK_NAME } from "../../framework";
import { manifestPath } from "../../runtime/runtime-document-manifest";
import { TOKENSAVE_CLAUDE_MD_MARKER } from "../../tools/setup/capabilities/tokensave-shared";
import { reconcileWorkingRepoCopyExcludes } from "../../tools/setup/working-repo-local-state";
import { GlobalConfigStore } from "./global-config-store";
import { reconcileCompanionCopies } from "./projection-opencode-copies";
import { runtimeDocumentDeps } from "./projection-runtime-documents";
import { writeRepoLocalRegistryEntry } from "./repository-link";
import type { LinkedRepository } from "./types";
import { unproject, unwrapWorkingRuntimeDocuments } from "./working-repo-projection";
import { runWrapPass, wrapPassDeps } from "./wrap-pass";

/**
 * A committed manifest, `.claude` or `.opencode` is repository content: every
 * pass must leave what lies outside the repository byte-identical. Every
 * "outside" path here is inside the test's own temporary root.
 */

const tempRoots: string[] = [];
const originalHomeDir = runtimeDocumentDeps.homeDir;
let home = "";
let originalExitCode: number | undefined;

beforeEach(async () => {
  originalExitCode = process.exitCode;
  process.exitCode = 0;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "acme-confine-home-"));
  tempRoots.push(home);
  runtimeDocumentDeps.homeDir = () => home;
});

afterEach(async () => {
  runtimeDocumentDeps.homeDir = originalHomeDir;
  process.exitCode = originalExitCode ?? 0;
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const BOTH_AGENTS = "allowedAgents:\n  - claude\n  - opencode\ncapabilities: []\n";
const CLAUDE_ONLY = "allowedAgents:\n  - claude\ncapabilities: []\n";
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

interface Fixture {
  root: string;
  companionPath: string;
  repository: LinkedRepository;
  store: GlobalConfigStore;
}

async function put(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

async function linkedRepo(config = BOTH_AGENTS): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-confine-"));
  tempRoots.push(root);
  const repoPath = initRepo(path.join(root, "working"));
  const companionPath = path.join(root, "companion");
  await put(path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"), config);
  await put(path.join(companionPath, ".opencode", "commands", "acme.md"), "acme\n");
  const repository: LinkedRepository = { id: "acme", path: repoPath };
  await writeRepoLocalRegistryEntry(repoPath, companionPath, repository, "git");
  const store = new GlobalConfigStore(path.join(root, "registry", "config.yaml"));
  return { root, companionPath, repository, store };
}

async function addSkill(companionPath: string, name: string): Promise<void> {
  await put(path.join(companionPath, ".claude", "skills", name, "SKILL.md"), "s\n");
}

async function writeManifest(repoPath: string, manifest: unknown): Promise<void> {
  await put(manifestPath(repoPath), json(manifest));
}

function wrap(fixture: Fixture, runtimes?: Array<"claude" | "opencode">) {
  return runWrapPass(fixture.companionPath, fixture.repository, runtimes ? { runtimes } : {}, {
    ...wrapPassDeps,
    globalConfigStore: fixture.store,
  });
}

/** `mate unwrap`, with its output as warnings and its exit code. */
async function unwrapCommand(fixture: Fixture): Promise<{ warnings: string[]; exitCode: number }> {
  const err: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => void err.push(args.map(String).join(" ")),
  );
  try {
    await runUnwrapCommand([], fixture.repository.path, {
      unwrapWorkingRuntimeDocuments: (repoPath) =>
        unwrapWorkingRuntimeDocuments(repoPath, fixture.store),
    });
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
  return { warnings: err, exitCode: Number(process.exitCode ?? 0) };
}

async function cleanup(fixture: Fixture): Promise<string[]> {
  const result = await unproject({
    repoPath: fixture.repository.path,
    registeredCompanionPaths: await fixture.store.list(),
  });
  return [...result.warnings, ...result.outcomes.flatMap((outcome) => outcome.warnings ?? [])];
}

async function wrapWarnings(fixture: Fixture): Promise<string[]> {
  const result = await wrap(fixture);
  if (result.kind === "failed") throw new Error(result.message);
  return result.warnings;
}

/** Every file below `dir`, with its bytes; links by their target. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    const file = path.join(entry.parentPath, entry.name);
    const key = path.relative(dir, file);
    if (entry.isSymbolicLink()) files[key] = `-> ${await fs.readlink(file)}`;
    else if (entry.isFile()) files[key] = await fs.readFile(file, "utf8");
    else files[key] = "<dir>";
  }
  return files;
}

const ignored = (key: string) => `records ${key}, which is not a destination`;

describe("a manifest recording destinations outside the closed set", () => {
  const OUTSIDE_DOCUMENT = "../acme-outside.json";
  const USER_SETTINGS = "~/.claude/settings.json";

  async function hostile(config: string): Promise<Fixture & { victim: string; outside: string[] }> {
    const fixture = await linkedRepo(config);
    const victim = path.join(fixture.root, "acme-victim.txt");
    const outside = [
      path.join(fixture.root, "acme-outside.json"),
      victim,
      path.join(home, ".claude", "settings.json"),
    ];
    await put(outside[0]!, json({ acme: true }));
    await put(victim, "victim\n");
    await put(outside[2]!, json({ sandbox: { enabled: true } }));
    await put(
      path.join(fixture.repository.path, ".claude", "settings.local.json"),
      json({ env: { ACME: "1" } }),
    );
    await writeManifest(fixture.repository.path, {
      documents: {
        ".claude/settings.local.json": [{ at: ["env"], kind: "map", entries: { ACME: "1" } }],
        [OUTSIDE_DOCUMENT]: [{ at: ["acme"], kind: "value", value: true }],
        [USER_SETTINGS]: [{ at: ["sandbox", "enabled"], kind: "value", value: true }],
      },
      copies: { [victim]: { runtime: "opencode", sha256: "0".repeat(64) } },
    });
    return { ...fixture, victim, outside };
  }

  test.each([
    [
      "mate unwrap",
      BOTH_AGENTS,
      async (fixture: Fixture) => (await unwrapCommand(fixture)).warnings,
    ],
    ["a wrap pass reconciling OpenCode copies", BOTH_AGENTS, wrapWarnings],
    ["a wrap pass withdrawing them", CLAUDE_ONLY, wrapWarnings],
    ["working-repository cleanup", BOTH_AGENTS, cleanup],
  ])("%s leaves every outside file byte-identical and names each key", async (_, config, pass) => {
    const fixture = await hostile(config);
    const before = await Promise.all(fixture.outside.map((file) => fs.readFile(file, "utf8")));

    const warnings = await pass(fixture);

    expect(await Promise.all(fixture.outside.map((file) => fs.readFile(file, "utf8")))).toEqual(
      before,
    );
    for (const key of [OUTSIDE_DOCUMENT, fixture.victim, USER_SETTINGS]) {
      expect(warnings.some((warning) => warning.includes(ignored(key)))).toBe(true);
    }
  });

  test("mate unwrap still withdraws Mate's own document and exits zero", async () => {
    const fixture = await hostile(BOTH_AGENTS);

    const { exitCode } = await unwrapCommand(fixture);

    expect(exitCode).toBe(0);
    await expect(
      fs.access(path.join(fixture.repository.path, ".claude", "settings.local.json")),
    ).rejects.toThrow();
  });
});

describe("a forged region in the user Claude config", () => {
  test("leaves another project's servers alone while this repository's region is reconciled", async () => {
    const fixture = await linkedRepo(
      "allowedAgents:\n  - claude\ncapabilities:\n  - name: tokensave\n",
    );
    const other = { mcpServers: { acme: { command: "acme" } } };
    const localConfig = path.join(home, ".claude.json");
    await put(localConfig, json({ projects: { "/x/acme-other": other } }));
    await writeManifest(fixture.repository.path, {
      documents: {
        "~/.claude.json": [
          {
            at: ["projects", "/x/acme-other", "mcpServers"],
            kind: "map",
            entries: other.mcpServers,
          },
        ],
      },
    });
    const projects = async () =>
      (JSON.parse(await fs.readFile(localConfig, "utf8")) as { projects: Record<string, unknown> })
        .projects;
    const own = path.resolve(fixture.repository.path);

    expect((await wrap(fixture, ["claude"])).kind).not.toBe("failed");
    expect((await projects())["/x/acme-other"]).toEqual(other);
    expect(Object.keys((await projects())[own] as object)).toEqual(["mcpServers"]);

    await unwrapCommand(fixture);
    expect((await projects())["/x/acme-other"]).toEqual(other);
    expect((await projects())[own]).toBeUndefined();
  });
});

describe("another Checkout's invalid copy record", () => {
  test("derives no line in the shared exclude file", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acme-confine-clone-")));
    tempRoots.push(root);
    const companionPath = path.join(root, "companion");
    await put(path.join(companionPath, ".opencode", "commands", "acme.md"), "acme\n");
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-feature"));
    /** A newline splits into lines no need can match; U+0001 stays on one line. */
    const forged = [".opencode/forged.md\n*", ".opencode/forged\u0001.md"];
    await writeManifest(worktree, {
      documents: {},
      copies: Object.fromEntries(
        forged.map((key) => [key, { runtime: "opencode", sha256: "0".repeat(64) }]),
      ),
    });
    /** The lines a release without the record rules wrote for them. */
    await reconcileWorkingRepoCopyExcludes(worktree, forged, async () => []);

    await reconcileCompanionCopies(main, companionPath);

    const lines = (await fs.readFile(path.join(main, ".git", "info", "exclude"), "utf8")).split(
      "\n",
    );
    expect(lines.filter((line) => line.includes("forged") || line.trim() === "\\*")).toEqual([]);
  });
});

describe("a symlinked .claude", () => {
  async function symlinkedClaude(fixture: Fixture): Promise<string> {
    const outside = path.join(fixture.root, "acme-outside-claude");
    await put(path.join(outside, "settings.local.json"), json({ acme: true }));
    await fs.mkdir(path.join(outside, "skills"), { recursive: true });
    await fs.symlink(outside, path.join(fixture.repository.path, ".claude"));
    return outside;
  }
  const namesClaude = (warnings: string[]) =>
    warnings.some((warning) => warning.includes(".claude is a symbolic link"));

  test("a wrap pass adds nothing beside a foreign link outside", async () => {
    const fixture = await linkedRepo(CLAUDE_ONLY);
    await addSkill(fixture.companionPath, "acme");
    const outside = await symlinkedClaude(fixture);
    const foreign = path.join(fixture.root, "acme-foreign");
    await fs.mkdir(foreign);
    await fs.symlink(foreign, path.join(outside, "skills", "foreign"));
    const before = await snapshot(outside);

    const warnings = await wrapWarnings(fixture);

    expect(await snapshot(outside)).toEqual(before);
    expect(namesClaude(warnings)).toBe(true);
  });

  test.each([
    ["mate unwrap", async (fixture: Fixture) => (await unwrapCommand(fixture)).warnings],
    ["working-repository cleanup", cleanup],
  ])("%s keeps a companion link outside", async (_, pass) => {
    const fixture = await linkedRepo(CLAUDE_ONLY);
    await addSkill(fixture.companionPath, "acme");
    await fixture.store.register(fixture.companionPath);
    const outside = await symlinkedClaude(fixture);
    await fs.symlink(
      path.join(fixture.companionPath, ".claude", "skills", "acme"),
      path.join(outside, "skills", "acme"),
    );
    const before = await snapshot(outside);

    const warnings = await pass(fixture);

    expect(await snapshot(outside)).toEqual(before);
    expect(namesClaude(warnings)).toBe(true);
  });
});

test("a wrap pass leaves the file behind a symlinked CLAUDE.md as it was", async () => {
  const fixture = await linkedRepo(CLAUDE_ONLY);
  const outside = path.join(fixture.root, "acme-outside-claude-md");
  await put(path.join(outside, "CLAUDE.md"), `# Acme\n\n${TOKENSAVE_CLAUDE_MD_MARKER}\n`);
  const link = path.join(fixture.repository.path, "CLAUDE.md");
  await fs.symlink(path.join(outside, "CLAUDE.md"), link);
  const before = await snapshot(outside);

  await wrapWarnings(fixture);

  expect(await snapshot(outside)).toEqual(before);
  expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
});

describe("a symlinked .opencode", () => {
  test("no wrap or unwrap writes or deletes through it", async () => {
    const fixture = await linkedRepo(BOTH_AGENTS);
    const outside = path.join(fixture.root, "acme-outside-opencode");
    await put(path.join(outside, "commands", "acme.md"), "outside\n");
    await fs.symlink(outside, path.join(fixture.repository.path, ".opencode"));
    await writeManifest(fixture.repository.path, {
      documents: {},
      copies: { ".opencode/commands/acme.md": { runtime: "opencode", sha256: "0".repeat(64) } },
    });
    const before = await snapshot(outside);

    await wrapWarnings(fixture);
    expect(await snapshot(outside)).toEqual(before);
    await unwrapCommand(fixture);
    expect(await snapshot(outside)).toEqual(before);
  });
});

describe("a Git-tracked manifest", () => {
  test("withdraws nothing and warns how to untrack it", async () => {
    const fixture = await linkedRepo(BOTH_AGENTS);
    const repoPath = fixture.repository.path;
    const own = path.join(repoPath, ".opencode", "commands", "acme.md");
    await put(own, "the repository's own\n");
    await writeManifest(repoPath, {
      documents: {},
      copies: { ".opencode/commands/acme.md": { runtime: "opencode", sha256: "0".repeat(64) } },
    });
    git(repoPath, "add", "-f", ".mate/runtime-documents.json", ".opencode/commands/acme.md");
    git(repoPath, "commit", "-q", "-m", "acme");
    const manifest = await fs.readFile(manifestPath(repoPath), "utf8");
    const untrack = (warnings: string[]) =>
      warnings.some(
        (warning) =>
          warning.includes(".mate/runtime-documents.json") &&
          warning.includes("git rm --cached .mate/runtime-documents.json"),
      );

    expect(untrack(await wrapWarnings(fixture))).toBe(true);
    expect(untrack((await unwrapCommand(fixture)).warnings)).toBe(true);

    expect(await fs.readFile(own, "utf8")).toBe("the repository's own\n");
    expect(await fs.readFile(manifestPath(repoPath), "utf8")).toBe(manifest);
  });
});

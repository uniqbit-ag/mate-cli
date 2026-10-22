import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { FRAMEWORK_NAME } from "../../framework";
import { runtimeDocumentDeps } from "./projection-runtime-documents";
import { writeRepoLocalRegistryEntry } from "./repository-link";
import type { LinkedRepository } from "./types";
import { links, manifestPath, readManifest } from "../../runtime/runtime-document-manifest";
import { readWrapState } from "../../runtime/wrap-state";
import { unproject, unwrapWorkingRuntimeDocuments } from "./working-repo-projection";
import { GlobalConfigStore } from "./global-config-store";
import { runWrapPass, wrapPassDeps } from "./wrap-pass";
import { prepareSession, sessionPrepareDeps } from "./session-prepare";
import { syncWorkingRepoClaudeAdditionalDirectories } from "./projection-claude-entry";
import { openSpecStoreDeps } from "./openspec-store";
import { writeOpenSpecRegistry } from "../../../test/openspec-store-stub";

const tempRoots: string[] = [];
const originalHomeDir = runtimeDocumentDeps.homeDir;

beforeEach(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acme-home-"));
  tempRoots.push(home);
  runtimeDocumentDeps.homeDir = () => home;
});

afterEach(async () => {
  runtimeDocumentDeps.homeDir = originalHomeDir;
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function isWrappedFor(repoPath: string, runtime: "claude" | "opencode"): Promise<boolean> {
  return (await readWrapState(repoPath)).runtimes.has(runtime);
}

const BOTH_AGENTS = "allowedAgents:\n  - claude\n  - opencode\ncapabilities: []\n";

async function writeCompanionConfig(companionPath: string, yaml: string): Promise<void> {
  await fs.mkdir(path.join(companionPath, `.${FRAMEWORK_NAME}`, "config"), { recursive: true });
  await fs.writeFile(
    path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
    yaml,
  );
}

async function linkedRepo(): Promise<{ companionPath: string; repository: LinkedRepository }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-wrap-pass-"));
  tempRoots.push(root);
  const repoPath = path.join(root, "working");
  const companionPath = path.join(root, "companion");
  await fs.mkdir(repoPath, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoPath });
  await writeCompanionConfig(companionPath, BOTH_AGENTS);
  await fs.mkdir(path.join(companionPath, ".opencode", "commands"), { recursive: true });
  await fs.writeFile(path.join(companionPath, ".opencode", "commands", "acme.md"), "acme\n");
  const repository: LinkedRepository = { id: "acme", path: repoPath };
  await writeRepoLocalRegistryEntry(repoPath, companionPath, repository, "git");
  return { companionPath, repository };
}

async function addSkill(companionPath: string, name: string): Promise<void> {
  await fs.mkdir(path.join(companionPath, ".claude", "skills", name), { recursive: true });
  await fs.writeFile(path.join(companionPath, ".claude", "skills", name, "SKILL.md"), "s\n");
}

/** A registry naming no companion: withdrawal must rest on the manifest alone. */
function emptyRegistry(companionPath: string): GlobalConfigStore {
  return new GlobalConfigStore(path.join(path.dirname(companionPath), "empty", "config.yaml"));
}

const exists = (candidate: string): Promise<boolean> =>
  fs.lstat(candidate).then(
    () => true,
    () => false,
  );

describe("an OpenCode-only wrap pass", () => {
  test("wraps the repository for OpenCode and not for Claude", async () => {
    const { companionPath, repository } = await linkedRepo();

    const result = await runWrapPass(companionPath, repository, { runtimes: ["opencode"] });

    expect(result.kind).toBe("written");
    expect(result).toMatchObject({
      documents: [path.join(".opencode", "opencode.json")],
      writtenDocuments: [path.join(".opencode", "opencode.json")],
      changed: { written: [".opencode/commands/acme.md"], removed: [] },
      warnings: [],
    });
    expect(await isWrappedFor(repository.path, "opencode")).toBe(true);
    expect(await isWrappedFor(repository.path, "claude")).toBe(false);
    expect(await exists(path.join(repository.path, `.${FRAMEWORK_NAME}`, "projection.yaml"))).toBe(
      true,
    );
    await expect(fs.access(path.join(repository.path, ".claude"))).rejects.toThrow();
  });

  test("records no skill links", async () => {
    const { companionPath, repository } = await linkedRepo();
    await addSkill(companionPath, "acme");

    await runWrapPass(companionPath, repository, { runtimes: ["opencode"] });

    expect(links(await readManifest(repository.path))).toEqual({});
    expect(await exists(path.join(repository.path, ".claude", "skills", "acme"))).toBe(false);
  });

  test("leaves the Claude documents of an earlier full wrap in place", async () => {
    const { companionPath, repository } = await linkedRepo();
    await runWrapPass(companionPath, repository);

    await runWrapPass(companionPath, repository, { runtimes: ["opencode"] });

    expect(await isWrappedFor(repository.path, "claude")).toBe(true);
  });
});

describe("the runtimes a wrap pass reports", () => {
  test("a Claude-only pass reports Claude even when an entry reports changed paths", async () => {
    const { companionPath, repository } = await linkedRepo();
    await writeCompanionConfig(companionPath, "allowedAgents:\n  - claude\ncapabilities: []\n");
    const project: typeof wrapPassDeps.project = async (scope, input) => {
      const result = await wrapPassDeps.project(scope, input);
      return {
        ...result,
        outcomes: result.outcomes.map((outcome) =>
          outcome.id === "claude-skill-links"
            ? { ...outcome, changed: { written: [".claude/skills/acme"], removed: [] } }
            : outcome,
        ),
      };
    };

    const result = await runWrapPass(companionPath, repository, {}, { ...wrapPassDeps, project });

    if (result.kind === "failed") throw new Error(result.message);
    expect(result.changed.written).toEqual([".claude/skills/acme"]);
    expect([...result.runtimes]).toEqual(["claude"]);
    expect([...result.wrapState.runtimes]).toEqual(["claude"]);
  });

  test("an OpenCode-only pass reports OpenCode alone", async () => {
    const { companionPath, repository } = await linkedRepo();

    const result = await runWrapPass(companionPath, repository, { runtimes: ["opencode"] });

    if (result.kind === "failed") throw new Error(result.message);
    expect([...result.runtimes]).toEqual(["opencode"]);
  });

  test("a full pass reports both runtimes and the wrap state it recorded", async () => {
    const { companionPath, repository } = await linkedRepo();

    const result = await runWrapPass(companionPath, repository);

    if (result.kind === "failed") throw new Error(result.message);
    expect([...result.runtimes].sort()).toEqual(["claude", "opencode"]);
    expect(result.wrapState.carriedClaudeHookGroups).toEqual(
      (await readWrapState(repository.path)).carriedClaudeHookGroups,
    );
    expect(result.wrapState.carriedClaudeHookGroups.length).toBeGreaterThan(0);
  });

  test("a current pass still reports the recorded wrap state", async () => {
    const { companionPath, repository } = await linkedRepo();
    await runWrapPass(companionPath, repository);

    const result = await runWrapPass(companionPath, repository);

    if (result.kind === "failed") throw new Error(result.message);
    expect(result.kind).toBe("current");
    expect([...result.wrapState.runtimes].sort()).toEqual(["claude", "opencode"]);
  });
});

describe("an attended Claude prepare", () => {
  const original = { ...sessionPrepareDeps };

  afterEach(() => {
    Object.assign(sessionPrepareDeps, original);
  });

  test.each([
    ["never wrapped", async () => {}],
    [
      "wrapped only for OpenCode",
      async (companionPath: string, repository: LinkedRepository) => {
        await runWrapPass(companionPath, repository, { runtimes: ["opencode"] });
      },
    ],
  ] as const)("wraps a repository %s for Claude", async (_label, before) => {
    const { companionPath, repository } = await linkedRepo();
    await addSkill(companionPath, "acme");
    await before(companionPath, repository);
    sessionPrepareDeps.syncCompanionGit = (async () => ({
      skipped: true,
      changed: false,
      companionPath,
    })) as never;
    sessionPrepareDeps.syncCompanionFiles = async () => ({ directories: [], warnings: [] });
    sessionPrepareDeps.runCapabilityPreflight = async () => {};

    const result = await prepareSession({
      runtime: "claude",
      companionPath,
      repository,
      mode: "attended",
    });

    expect(result.ok).toBe(true);
    expect(await isWrappedFor(repository.path, "claude")).toBe(true);
    expect(await exists(path.join(repository.path, ".claude", "skills", "acme"))).toBe(true);
  });
});

describe("a full wrap pass", () => {
  test("writes the pair, both runtimes' documents and the copies in one pass", async () => {
    const { companionPath, repository } = await linkedRepo();

    const result = await runWrapPass(companionPath, repository);

    expect(result.kind).toBe("written");
    if (result.kind === "failed") return;
    expect(result.projectionRoot).toBe(path.join(repository.path, `.${FRAMEWORK_NAME}`));
    expect(result.documents).toEqual(
      expect.arrayContaining([
        path.join(".claude", "settings.local.json"),
        path.join(".opencode", "opencode.json"),
      ]),
    );
    expect(result.changed.written).toEqual([".opencode/commands/acme.md"]);
    expect(await isWrappedFor(repository.path, "claude")).toBe(true);
    expect(await isWrappedFor(repository.path, "opencode")).toBe(true);
  });

  test("a second pass with no intervening change is current and changes nothing", async () => {
    const { companionPath, repository } = await linkedRepo();
    await runWrapPass(companionPath, repository);

    const result = await runWrapPass(companionPath, repository);

    expect(result).toMatchObject({
      kind: "current",
      changed: { written: [], removed: [] },
      warnings: [],
    });
  });

  test("a current Claude pass leaves ~/.claude.json unwritten", async () => {
    const { companionPath, repository } = await linkedRepo();
    await writeCompanionConfig(
      companionPath,
      "allowedAgents:\n  - claude\ncapabilities:\n  - name: tokensave\n",
    );
    await runWrapPass(companionPath, repository, { runtimes: ["claude"] });
    const globalConfig = path.join(runtimeDocumentDeps.homeDir(), ".claude.json");
    const bytes = await fs.readFile(globalConfig, "utf8");
    expect(bytes).toContain("mcpServers");
    const before = await fs.stat(globalConfig);

    const result = await runWrapPass(companionPath, repository, { runtimes: ["claude"] });

    expect(result.kind).toBe("current");
    expect((await fs.stat(globalConfig)).mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(globalConfig, "utf8")).toBe(bytes);
  });

  test("a Capability enabled after the wrap reaches the settings and survives a launch", async () => {
    const { companionPath, repository } = await linkedRepo();
    await writeCompanionConfig(companionPath, "allowedAgents:\n  - claude\ncapabilities: []\n");
    await runWrapPass(companionPath, repository, { runtimes: ["claude"] });
    await writeCompanionConfig(
      companionPath,
      "allowedAgents:\n  - claude\ncapabilities:\n  - name: tokensave\n",
    );
    const settingsPath = path.join(repository.path, ".claude", "settings.local.json");
    const commands = async (): Promise<string[]> => {
      const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string; args?: string[] }> }>>;
      };
      return Object.values(settings.hooks).flatMap((groups) =>
        groups.flatMap((group) =>
          group.hooks.map((hook) => [hook.command, ...(hook.args ?? [])].join(" ")),
        ),
      );
    };

    await runWrapPass(companionPath, repository, { runtimes: ["claude"] });
    const wrapped = await commands();
    expect(wrapped.some((command) => command.includes("hook-pre-tool-use"))).toBe(true);
    expect(wrapped.some((command) => command.includes("session-prepare.mjs"))).toBe(true);

    /** The launch scope's legacy strip leaves what the wrap placed. */
    expect(
      await syncWorkingRepoClaudeAdditionalDirectories(
        repository.path,
        companionPath,
        emptyRegistry(companionPath),
      ),
    ).toBe("current");
    expect(await commands()).toEqual(wrapped);
  });

  test("unwrap tolerates keys Claude Code itself already removed", async () => {
    const { companionPath, repository } = await linkedRepo();
    await runWrapPass(companionPath, repository, { runtimes: ["claude"] });
    const settingsPath = path.join(repository.path, ".claude", "settings.local.json");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
    delete settings.hooks;
    delete settings.env;
    settings.acme = true;
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    const result = await unwrapWorkingRuntimeDocuments(repository.path);

    expect(result.kind).toBe("unwrapped");
    expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toMatchObject({ acme: true });
  });

  test("a failed projection pair still reconciles the documents and fails the pass", async () => {
    const { companionPath, repository } = await linkedRepo();
    const root = path.join(repository.path, `.${FRAMEWORK_NAME}`);
    /** Only the pair can fail: its file's place is taken by a directory. */
    await fs.mkdir(path.join(root, "projection.yaml", "blocked"), { recursive: true });

    const result = await runWrapPass(companionPath, repository);

    expect(result).toEqual({
      kind: "failed",
      message: expect.stringContaining("failed to write the projection for acme:"),
    });
    expect(await isWrappedFor(repository.path, "opencode")).toBe(true);
    expect(await exists(path.join(repository.path, ".opencode", "commands", "acme.md"))).toBe(true);
  });

  test("re-pinning to a companion with a same-name skill re-points the link", async () => {
    const { companionPath: acmeA, repository } = await linkedRepo();
    const acmeB = path.join(path.dirname(acmeA), "acme-b");
    await writeCompanionConfig(acmeB, BOTH_AGENTS);
    for (const companion of [acmeA, acmeB]) {
      await fs.mkdir(path.join(companion, ".claude", "skills", "review"), { recursive: true });
      await fs.writeFile(path.join(companion, ".claude", "skills", "review", "SKILL.md"), "r\n");
    }
    const globalConfigStore = new GlobalConfigStore(
      path.join(path.dirname(acmeA), "global", "config.yaml"),
    );
    await globalConfigStore.register(acmeA);
    await globalConfigStore.register(acmeB);
    const deps = { ...wrapPassDeps, globalConfigStore };
    await runWrapPass(acmeA, repository, {}, deps);

    await runWrapPass(acmeB, repository, {}, deps);

    expect(await fs.realpath(path.join(repository.path, ".claude", "skills", "review"))).toBe(
      await fs.realpath(path.join(acmeB, ".claude", "skills", "review")),
    );
  });

  test("unwrap withdraws recorded skill links without a registry", async () => {
    const { companionPath, repository } = await linkedRepo();
    await addSkill(companionPath, "acme");
    const globalConfigStore = emptyRegistry(companionPath);
    await runWrapPass(companionPath, repository, {}, { ...wrapPassDeps, globalConfigStore });
    expect(await exists(path.join(repository.path, ".claude", "skills", "acme"))).toBe(true);

    const result = await unwrapWorkingRuntimeDocuments(repository.path, globalConfigStore);

    expect(result.kind).toBe("unwrapped");
    expect(await exists(path.join(repository.path, ".claude", "skills", "acme"))).toBe(false);
    expect(await exists(manifestPath(repository.path))).toBe(false);
  });

  test("cleanup withdraws recorded skill links without a registry", async () => {
    const { companionPath, repository } = await linkedRepo();
    await addSkill(companionPath, "acme");
    const globalConfigStore = emptyRegistry(companionPath);
    await runWrapPass(companionPath, repository, {}, { ...wrapPassDeps, globalConfigStore });

    await unproject({ repoPath: repository.path, registeredCompanionPaths: [] });

    expect(await exists(path.join(repository.path, ".claude", "skills", "acme"))).toBe(false);
  });

  test("reports a relative companion path ahead of entry warnings and prints nothing", async () => {
    const { companionPath, repository } = await linkedRepo();
    await fs.writeFile(
      path.join(companionPath, ".opencode", "opencode.json"),
      JSON.stringify({ instructions: ["./guide.md"] }),
    );
    const printed: unknown[] = [];
    const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      printed.push(args);
    });

    let result: Awaited<ReturnType<typeof runWrapPass>>;
    try {
      result = await runWrapPass(companionPath, repository);
    } finally {
      error.mockRestore();
    }

    expect(result).toMatchObject({
      warnings: [expect.stringContaining("instructions.0")],
    });
    expect(printed).toEqual([]);
  });

  test("a companion that drops OpenCode has its copies withdrawn", async () => {
    const { companionPath, repository } = await linkedRepo();
    await runWrapPass(companionPath, repository);
    await writeCompanionConfig(companionPath, "allowedAgents:\n  - claude\ncapabilities: []\n");

    const result = await runWrapPass(companionPath, repository);

    expect(result).toMatchObject({
      kind: "written",
      changed: { written: [], removed: [".opencode/commands/acme.md"] },
    });
    expect(await exists(path.join(repository.path, ".opencode", "commands", "acme.md"))).toBe(
      false,
    );
  });
});

describe("a failing OpenSpec store entry", () => {
  const originalStoreDeps = { ...openSpecStoreDeps };
  const originalPrepareDeps = { ...sessionPrepareDeps };

  afterEach(() => {
    Object.assign(openSpecStoreDeps, originalStoreDeps);
    Object.assign(sessionPrepareDeps, originalPrepareDeps);
  });

  /** A companion that is an OpenSpec root whose store id another path already holds. */
  async function conflictingStore(): Promise<{
    companionPath: string;
    repository: LinkedRepository;
  }> {
    const linked = await linkedRepo();
    await fs.mkdir(path.join(linked.companionPath, "openspec"), { recursive: true });
    const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "acme-openspec-data-"));
    tempRoots.push(dataHome);
    await writeOpenSpecRegistry(dataHome, { companion: "/somewhere/else" });
    openSpecStoreDeps.env = () => ({ ...process.env, XDG_DATA_HOME: dataHome });
    openSpecStoreDeps.resolveBinary = () => undefined;
    return linked;
  }

  test("warns and the pass still succeeds", async () => {
    const { companionPath, repository } = await conflictingStore();

    const result = await runWrapPass(companionPath, repository);

    if (result.kind === "failed") throw new Error(result.message);
    expect(result.warnings).toContainEqual(
      expect.stringContaining(
        `failed to write ${path.join("openspec", "config.yaml")} for acme: OpenSpec store id "companion" is already registered at /somewhere/else`,
      ),
    );
  });

  test.each([
    ["claude", "attended"],
    ["opencode", "attended"],
  ] as const)("reaches the warnings of a %s prepare, which stays ok", async (runtime, mode) => {
    const { companionPath, repository } = await conflictingStore();
    sessionPrepareDeps.syncCompanionGit = (async () => ({
      skipped: true,
      changed: false,
      companionPath,
    })) as never;
    sessionPrepareDeps.syncCompanionFiles = async () => ({ directories: [], warnings: [] });
    sessionPrepareDeps.runCapabilityPreflight = async () => {};

    const result = await prepareSession({ runtime, companionPath, repository, mode });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(expect.stringContaining("/somewhere/else"));
  });
});

describe("the Claude plugins a wrap pass names", () => {
  test("names an enabled Capability that ships a Claude plugin folder, checking no folder", async () => {
    const { companionPath, repository } = await linkedRepo();
    await writeCompanionConfig(
      companionPath,
      "allowedAgents:\n  - claude\n  - opencode\ncapabilities:\n  - name: context-mode\n",
    );

    const result = await runWrapPass(companionPath, repository);

    if (result.kind === "failed") throw new Error(result.message);
    expect(result.claudePluginCapabilities).toEqual(["context-mode"]);
    /** The package is not installed, and the pass says nothing about it: launches report that. */
    expect(result.warnings.join("\n")).not.toContain("context-mode");
  });

  test("names none when no enabled Capability ships one", async () => {
    const { companionPath, repository } = await linkedRepo();

    const result = await runWrapPass(companionPath, repository);

    if (result.kind === "failed") throw new Error(result.message);
    expect(result.claudePluginCapabilities).toEqual([]);
  });
});

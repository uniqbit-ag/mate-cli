import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "bun:test";

import { getActiveDistribution, setActiveDistribution } from "../../distribution";
import { FRAMEWORK_NAME } from "../../framework";
import { parseProjectionYaml, type ProjectionFile } from "../../runtime/projection";
import { renderWorkingRuntimeDocuments } from "../../tools/setup";
import {
  OPENCODE_PLUGIN_PACKAGE_NAME,
  getOpenCodeCacheDir,
  getOpenCodePluginPackageReference,
  opencodePluginCacheDeps,
  warmOpenCodePluginCache,
} from "../opencode-plugin-package";
import { GlobalConfigStore } from "./global-config-store";
import { runtimeDocumentDeps } from "./projection-runtime-documents";
import { firstFailure, type RenderedRuntimeDocument } from "./projection-types";
import { writeRepoLocalRegistryEntry } from "./repo-local-registry";
import type { LinkedRepository } from "./types";
import {
  describe as describeProjection,
  project,
  projectWorkingRepository,
  projectWorkingRepositoryBestEffort,
  projectWorkingRuntimeDocuments,
  unproject,
} from "./working-repo-projection";

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.chmod(path.join(root, "working", `.${FRAMEWORK_NAME}`), 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("projectWorkingRepository", () => {
  const projectionDir = (repoPath: string) => path.join(repoPath, `.${FRAMEWORK_NAME}`);
  const yamlPath = (repoPath: string) => path.join(projectionDir(repoPath), "projection.yaml");

  async function readProjection(repoPath: string): Promise<ProjectionFile | null> {
    return parseProjectionYaml(await fs.readFile(yamlPath(repoPath), "utf8"));
  }

  async function makeLinkedRepo(prefix: string): Promise<{
    repoPath: string;
    companionPath: string;
    otherCompanionPath: string;
    repository: LinkedRepository;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempRoots.push(root);
    const repoPath = path.join(root, "working");
    const companionPath = path.join(root, "companion");
    const otherCompanionPath = path.join(root, "other-companion");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(companionPath, { recursive: true });
    await fs.mkdir(otherCompanionPath, { recursive: true });
    const repository: LinkedRepository = { id: "app", path: repoPath };
    await writeRepoLocalRegistryEntry(repoPath, companionPath, repository, "git");
    return { repoPath, companionPath, otherCompanionPath, repository };
  }

  test("reports the Projection Root and the companion it wrote", async () => {
    const { repoPath, companionPath, repository } = await makeLinkedRepo("projection-write-");

    const result = await projectWorkingRepository(companionPath, repository);

    expect(result).toEqual({
      kind: "written",
      projectionRoot: projectionDir(repoPath),
      companionPath,
    });
    expect((await readProjection(repoPath))?.projection.companionPath).toBe(companionPath);
  });

  test("reports an unchanged projection as current without rewriting it", async () => {
    const { repoPath, companionPath, repository } = await makeLinkedRepo("projection-current-");
    await projectWorkingRepository(companionPath, repository);
    const before = await fs.readFile(yamlPath(repoPath), "utf8");

    const result = await projectWorkingRepository(companionPath, repository);

    expect(result.kind).toBe("current");
    expect(await fs.readFile(yamlPath(repoPath), "utf8")).toBe(before);
  });

  test("re-pinning a different companion rewrites despite an unchanged stamp", async () => {
    const { repoPath, companionPath, otherCompanionPath, repository } =
      await makeLinkedRepo("projection-repin-");
    await projectWorkingRepository(companionPath, repository);
    const stamp = (await readProjection(repoPath))!.stamp;

    const result = await projectWorkingRepository(otherCompanionPath, repository);

    expect(result.kind).toBe("written");
    const rewritten = (await readProjection(repoPath))!;
    expect(rewritten.projection.companionPath).toBe(otherCompanionPath);
    expect(rewritten.stamp).toBe(stamp);
  });

  test("reports a failed write instead of throwing, leaving the previous pair intact", async () => {
    const { repoPath, companionPath, otherCompanionPath, repository } =
      await makeLinkedRepo("projection-failed-");
    await projectWorkingRepository(companionPath, repository);
    const before = await fs.readFile(yamlPath(repoPath), "utf8");
    await fs.chmod(projectionDir(repoPath), 0o555);

    const result = await projectWorkingRepository(otherCompanionPath, repository);

    expect(result.kind).toBe("failed");
    expect(await fs.readFile(yamlPath(repoPath), "utf8")).toBe(before);
  });

  test("the best-effort wrapper warns on failure and returns the same result", async () => {
    const { repoPath, companionPath, repository } = await makeLinkedRepo("projection-warn-");
    await fs.mkdir(projectionDir(repoPath), { recursive: true });
    await fs.chmod(projectionDir(repoPath), 0o555);

    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    let result: Awaited<ReturnType<typeof projectWorkingRepositoryBestEffort>>;
    try {
      result = await projectWorkingRepositoryBestEffort(companionPath, repository);
    } finally {
      console.error = original;
    }

    expect(result.kind).toBe("failed");
    expect(lines.join("\n")).toContain("failed to write the projection for app");
  });
});

/**
 * The invariant `mate wrap` users care about most, and the reason this module
 * exists: what `project` writes, `unproject` takes back out, byte for byte.
 */
describe("the projection round-trip", () => {
  async function exists(candidate: string): Promise<boolean> {
    return fs
      .access(candidate)
      .then(() => true)
      .catch(() => false);
  }

  interface Tree {
    files: Record<string, string>;
    dirs: string[];
    /** Recorded by target, never walked: following one would leave the tree. */
    links: Record<string, string>;
    gitExclude: string;
    gitStatus: string;
  }

  async function snapshot(repoPath: string): Promise<Tree> {
    const files: Record<string, string> = {};
    const links: Record<string, string> = {};
    const dirs: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        const rel = path.relative(repoPath, full);
        if (rel === ".git") continue;
        if (item.isSymbolicLink()) {
          links[rel] = await fs.readlink(full);
        } else if (item.isDirectory()) {
          dirs.push(rel);
          await walk(full);
        } else {
          files[rel] = await fs.readFile(full, "utf8");
        }
      }
    }
    await walk(repoPath);
    dirs.sort();
    return {
      files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
      dirs,
      links: Object.fromEntries(Object.entries(links).sort(([a], [b]) => a.localeCompare(b))),
      gitExclude: await fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8"),
      gitStatus: (await execFileAsync("git", ["-C", repoPath, "status", "--porcelain"])).stdout,
    };
  }

  const userSettings = {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo acme" }] }] },
    permissions: { allow: ["Bash(ls:*)"] },
    acmeSetting: true,
  };

  async function makeSeededRepo(
    prefix: string,
    options: { claudeDir?: boolean } = {},
  ): Promise<{ repoPath: string; companionPath: string; repository: LinkedRepository }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempRoots.push(root);
    const repoPath = path.join(root, "working");
    const companionPath = path.join(root, "companion");
    await fs.mkdir(companionPath, { recursive: true });
    await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
    await execFileAsync("git", ["init", "-q", repoPath]);

    await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export const acme = 1;\n", "utf8");
    await execFileAsync("git", ["-C", repoPath, "add", "src/index.ts"]);
    await fs.writeFile(path.join(repoPath, "untracked.txt"), "keep\n", "utf8");
    await fs.writeFile(path.join(repoPath, "CLAUDE.md"), "# Acme\n\nUser notes.\n", "utf8");
    await fs.appendFile(path.join(repoPath, ".git", "info", "exclude"), "build/\n*.log\n", "utf8");

    if (options.claudeDir !== false) {
      await fs.mkdir(path.join(repoPath, ".claude"), { recursive: true });
      await fs.writeFile(path.join(repoPath, ".claude", "notes.md"), "user notes\n", "utf8");
      await fs.writeFile(
        path.join(repoPath, ".claude", "settings.local.json"),
        `${JSON.stringify(userSettings, null, 2)}\n`,
        "utf8",
      );
    }

    return { repoPath, companionPath, repository: { id: "acme", path: repoPath } };
  }

  async function projectEveryScope(
    repoPath: string,
    companionPath: string,
    repository: LinkedRepository,
    capabilities: Array<{ name: string }> = [],
  ): Promise<void> {
    const store = new GlobalConfigStore(path.join(repoPath, "..", "global-config.yaml"));
    await store.register(companionPath);
    const config = { allowedAgents: ["claude"], capabilities };
    await project("link", { repoPath, companionPath, repository, source: "git" });
    await project("session", { repoPath, companionPath, repository });
    await project("launch", { repoPath, companionPath, config, globalConfigStore: store });
    await project("workspace", { repoPath, companionPath });
    await project("wrap", {
      repoPath,
      companionPath,
      repository,
      config,
      globalConfigStore: store,
      runtimeDocuments: await renderWorkingRuntimeDocuments(companionPath, config, repoPath),
    });
  }

  test("every file's bytes and every directory's presence survive project then unproject", async () => {
    const { repoPath, companionPath, repository } = await makeSeededRepo("projection-roundtrip-");
    const before = await snapshot(repoPath);

    await projectEveryScope(repoPath, companionPath, repository);
    const projected = await snapshot(repoPath);
    expect(Object.keys(projected.files)).toContain(
      path.join(`.${FRAMEWORK_NAME}`, "projection.yaml"),
    );

    await unproject({ repoPath, registeredCompanionPaths: [companionPath] });

    expect(await snapshot(repoPath)).toEqual(before);
  });

  test("a directory Mate created is gone and one the user had survives with its files", async () => {
    const { repoPath, companionPath, repository } = await makeSeededRepo("projection-dirs-", {
      claudeDir: false,
    });
    const before = await snapshot(repoPath);

    await projectEveryScope(repoPath, companionPath, repository);
    expect(await exists(path.join(repoPath, ".claude"))).toBe(true);
    expect(await exists(path.join(repoPath, `.${FRAMEWORK_NAME}`))).toBe(true);

    await unproject({ repoPath, registeredCompanionPaths: [companionPath] });

    expect(await exists(path.join(repoPath, ".claude"))).toBe(false);
    expect(await exists(path.join(repoPath, `.${FRAMEWORK_NAME}`))).toBe(false);
    expect(await snapshot(repoPath)).toEqual(before);

    const kept = await makeSeededRepo("projection-dirs-kept-");
    await projectEveryScope(kept.repoPath, kept.companionPath, kept.repository);
    await unproject({ repoPath: kept.repoPath, registeredCompanionPaths: [kept.companionPath] });
    expect(await fs.readFile(path.join(kept.repoPath, ".claude", "notes.md"), "utf8")).toBe(
      "user notes\n",
    );
  });

  test("a Capability's exclusion is retained and named, not forgotten", async () => {
    const { repoPath, companionPath, repository } = await makeSeededRepo("projection-retained-");
    await projectEveryScope(repoPath, companionPath, repository, [{ name: "tokensave" }]);

    const { outcomes } = await unproject({
      repoPath,
      registeredCompanionPaths: [companionPath],
    });

    expect(outcomes.find((outcome) => outcome.id === "capability-excludes")?.state).toBe(
      "retained",
    );
    expect(await fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8")).toContain(
      ".tokensave/\n",
    );
  });

  test("unprojecting twice removes nothing further and leaves the tree unchanged", async () => {
    const { repoPath, companionPath, repository } = await makeSeededRepo("projection-twice-");
    await projectEveryScope(repoPath, companionPath, repository);
    await unproject({ repoPath, registeredCompanionPaths: [companionPath] });
    const afterFirst = await snapshot(repoPath);

    const second = await unproject({ repoPath, registeredCompanionPaths: [companionPath] });

    expect(second.outcomes.some((outcome) => outcome.state === "removed")).toBe(false);
    expect(await snapshot(repoPath)).toEqual(afterFirst);
  });
});

/**
 * Artifacts reachable by ordinary path traversal — and a link that is removed
 * without ever reaching what it points at.
 */
describe("the companion link", () => {
  const linkPath = (repoPath: string) => path.join(repoPath, `.${FRAMEWORK_NAME}`, "companion");

  async function makeLinkedRepo(prefix: string): Promise<{
    root: string;
    repoPath: string;
    companionPath: string;
    repository: LinkedRepository;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempRoots.push(root);
    const repoPath = path.join(root, "working");
    const companionPath = path.join(root, "companion");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(path.join(companionPath, "openspec"), { recursive: true });
    await fs.writeFile(path.join(companionPath, "openspec", "spec.md"), "# Acme\n", "utf8");
    return { root, repoPath, companionPath, repository: { id: "acme", path: repoPath } };
  }

  /** Walks the Companion Repository itself, so "untouched" is asserted on bytes. */
  async function companionFiles(companionPath: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    async function walk(dir: string): Promise<void> {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) await walk(full);
        else files[path.relative(companionPath, full)] = await fs.readFile(full, "utf8");
      }
    }
    await walk(companionPath);
    return files;
  }

  test("resolves to the projected companion, artifacts and all", async () => {
    const { repoPath, companionPath, repository } = await makeLinkedRepo("companion-link-");

    await project("session", { repoPath, companionPath, repository });

    expect((await fs.lstat(linkPath(repoPath))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(linkPath(repoPath))).toBe(await fs.realpath(companionPath));
    expect(await fs.readFile(path.join(linkPath(repoPath), "openspec", "spec.md"), "utf8")).toBe(
      "# Acme\n",
    );
  });

  test("a re-pin repoints it, and an unchanged pin rewrites nothing", async () => {
    const { root, repoPath, companionPath, repository } = await makeLinkedRepo("companion-repin-");
    const other = path.join(root, "other-companion");
    await fs.mkdir(other, { recursive: true });
    await project("session", { repoPath, companionPath, repository });

    const again = await project("session", { repoPath, companionPath, repository });
    const repinned = await project("session", { repoPath, companionPath: other, repository });

    const stateOf = (result: Awaited<ReturnType<typeof project>>) =>
      result.outcomes.find((outcome) => outcome.id === "companion-link")?.state;
    expect(stateOf(again)).toBe("current");
    expect(stateOf(repinned)).toBe("written");
    expect(await fs.realpath(linkPath(repoPath))).toBe(await fs.realpath(other));
  });

  test("a link that cannot be created is reported without failing the projection", async () => {
    const { repoPath, companionPath, repository } = await makeLinkedRepo("companion-degraded-");
    const store = new GlobalConfigStore(path.join(repoPath, "..", "global-config.yaml"));
    await store.register(companionPath);
    const config = { allowedAgents: ["claude"], capabilities: [] };
    /** Stands in for a platform that permits neither a symlink nor a junction. */
    await fs.mkdir(path.join(repoPath, `.${FRAMEWORK_NAME}`), { recursive: true });
    await fs.writeFile(linkPath(repoPath), "not a link\n", "utf8");

    const result = await project("wrap", {
      repoPath,
      companionPath,
      repository,
      config,
      globalConfigStore: store,
      runtimeDocuments: await renderWorkingRuntimeDocuments(companionPath, config, repoPath),
    });

    const states = new Map(result.outcomes.map((outcome) => [outcome.id, outcome.state]));
    expect(states.get("companion-link")).toBe("failed");
    expect(states.get("claude-working-settings")).toBe("written");
    expect(firstFailure(result.outcomes)).toBeNull();
  });

  test("removal deletes the link, not what it points at", async () => {
    const { repoPath, companionPath, repository } = await makeLinkedRepo("companion-removal-");
    await project("session", { repoPath, companionPath, repository });
    const before = await companionFiles(companionPath);

    const { outcomes } = await unproject({ repoPath });

    expect(outcomes.find((outcome) => outcome.id === "companion-link")?.state).toBe("removed");
    expect(await fs.lstat(linkPath(repoPath)).catch(() => null)).toBeNull();
    expect(await companionFiles(companionPath)).toEqual(before);
    expect(
      (await unproject({ repoPath })).outcomes.find((outcome) => outcome.id === "companion-link")
        ?.state,
    ).toBe("absent");
  });
});

/**
 * Every value these documents carry is pinned to the mate that wrote it — the
 * OpenCode plugin package's version above all. A repository is wrapped once and
 * launched for the rest of its life, so the launch scope renders them again
 * rather than leaving a working repository pointing at whichever release
 * happened to wrap it.
 */
describe("the runtime documents under a launch", () => {
  const originalHomeDir = runtimeDocumentDeps.homeDir;
  const originalDistribution = getActiveDistribution();
  const config = { allowedAgents: ["claude", "opencode"], capabilities: [{ name: "tokensave" }] };

  afterEach(() => {
    runtimeDocumentDeps.homeDir = originalHomeDir;
    setActiveDistribution(originalDistribution);
  });

  async function makeWrappable(prefix: string): Promise<{
    repoPath: string;
    companionPath: string;
    /** One pass of a scope, as the mate at `version` would have run it. */
    at(scope: "launch" | "wrap", version: string): Promise<Awaited<ReturnType<typeof project>>>;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempRoots.push(root);
    const repoPath = path.join(root, "working");
    const companionPath = path.join(root, "companion");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(companionPath, { recursive: true });
    /** Local scope lands in the user's home; a test must never use the real one. */
    runtimeDocumentDeps.homeDir = () => root;
    const repository: LinkedRepository = { id: "acme", path: repoPath };
    const store = new GlobalConfigStore(path.join(root, "global-config.yaml"));
    await store.register(companionPath);

    return {
      repoPath,
      companionPath,
      at: async (scope, version) => {
        setActiveDistribution({
          ...originalDistribution,
          config: { ...originalDistribution.config, version },
        });
        return project(scope, {
          repoPath,
          companionPath,
          repository,
          config,
          globalConfigStore: store,
          runtimeDocuments: await renderWorkingRuntimeDocuments(companionPath, config, repoPath),
        });
      },
    };
  }

  interface OpenCodeDocument {
    plugin?: string[];
    mcp?: Record<string, unknown>;
    permission?: { external_directory?: Record<string, string> };
  }

  async function readOpenCode(repoPath: string): Promise<OpenCodeDocument> {
    return JSON.parse(
      await fs.readFile(path.join(repoPath, ".opencode", "opencode.json"), "utf8"),
    ) as OpenCodeDocument;
  }

  function stateOf(result: Awaited<ReturnType<typeof project>>, id: string): string | undefined {
    return result.outcomes.find((outcome) => outcome.id === id)?.state;
  }

  test("a launch re-pins the plugin reference the wrap baked in", async () => {
    const { repoPath, at } = await makeWrappable("projection-launch-repin-");
    await at("wrap", "0.15.5");
    expect((await readOpenCode(repoPath)).plugin).toEqual([
      getOpenCodePluginPackageReference("0.15.5"),
    ]);

    const launched = await at("launch", "0.16.0");

    expect(stateOf(launched, "opencode-runtime-document")).toBe("written");
    /** One entry, not the old one with its successor beside it. */
    expect((await readOpenCode(repoPath)).plugin).toEqual([
      getOpenCodePluginPackageReference("0.16.0"),
    ]);
  });

  test("a launch at the version that wrapped rewrites nothing", async () => {
    const { repoPath, at } = await makeWrappable("projection-launch-current-");
    await at("wrap", "0.15.5");
    const target = path.join(repoPath, ".opencode", "opencode.json");
    const before = await fs.readFile(target, "utf8");

    const launched = await at("launch", "0.15.5");

    expect(stateOf(launched, "opencode-runtime-document")).toBe("current");
    expect(await fs.readFile(target, "utf8")).toBe(before);
  });

  /**
   * Re-rendering reconciles the whole destination, so a launch whose render
   * omitted a document would withdraw it rather than leave it. The launch
   * renders exactly what the wrap renders, and this is what says so.
   */
  test("a launch keeps every region the wrap placed, in every destination", async () => {
    const { repoPath, companionPath, at } = await makeWrappable("projection-launch-keeps-");
    await at("wrap", "0.15.5");
    const wrapped = await readOpenCode(repoPath);
    const settingsPath = path.join(repoPath, ".claude", "settings.local.json");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
    const localConfigPath = path.join(runtimeDocumentDeps.homeDir(), ".claude.json");
    const localConfig = await fs.readFile(localConfigPath, "utf8");
    expect(Object.keys(wrapped.mcp ?? {})).toEqual(["tokensave"]);

    await at("launch", "0.16.0");

    const launched = await readOpenCode(repoPath);
    expect(launched.mcp).toEqual(wrapped.mcp!);
    expect(launched.permission?.external_directory?.[companionPath]).toBe("allow");
    expect(launched.permission).toEqual(wrapped.permission!);
    expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual(settings);
    expect(await fs.readFile(localConfigPath, "utf8")).toBe(localConfig);
  });

  /**
   * The pre-fetch and the projection have to name one version. An Unmanaged
   * OpenCode session resolves the plugin the projected document names, and a
   * version the cache never warmed sends it to the registry at startup — the
   * launch that fails offline. Both derive from the running mate; this is the
   * assertion that holds them to it.
   */
  test("pins the version the plugin cache pre-fetches", async () => {
    const { repoPath, at } = await makeWrappable("projection-launch-warm-");
    await at("launch", "0.16.0");
    const cacheHome = await fs.mkdtemp(path.join(os.tmpdir(), "projection-launch-cache-"));
    tempRoots.push(cacheHome);

    const originalRunInstall = opencodePluginCacheDeps.runInstall;
    opencodePluginCacheDeps.runInstall = ((cwd: string) => {
      const manifest = path.join(
        cwd,
        "node_modules",
        ...OPENCODE_PLUGIN_PACKAGE_NAME.split("/"),
        "package.json",
      );
      fsSync.mkdirSync(path.dirname(manifest), { recursive: true });
      fsSync.writeFileSync(manifest, "{}\n");
      return { error: undefined, status: 0, stderr: "" };
    }) as typeof opencodePluginCacheDeps.runInstall;
    let warmed: Awaited<ReturnType<typeof warmOpenCodePluginCache>>;
    try {
      warmed = await warmOpenCodePluginCache(undefined, { XDG_CACHE_HOME: cacheHome });
    } finally {
      opencodePluginCacheDeps.runInstall = originalRunInstall;
    }

    expect(warmed.ok).toBe(true);
    /** The spec directory the warm created is named by the projected reference. */
    const pinned = (await readOpenCode(repoPath)).plugin![0]!;
    const specDir = path.join(
      getOpenCodeCacheDir({ XDG_CACHE_HOME: cacheHome }),
      "packages",
      pinned,
    );
    const manifest = JSON.parse(await fs.readFile(path.join(specDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({ [OPENCODE_PLUGIN_PACKAGE_NAME]: "0.16.0" });
  });

  /**
   * `unproject` takes back what the manifest records, and the launch that
   * re-pinned is the pass that recorded last — so a re-pinned repository is
   * still restorable to the bytes it had before any of this.
   */
  test("cleanup after a re-pinning launch leaves nothing of Mate's behind", async () => {
    const { repoPath, companionPath, at } = await makeWrappable("projection-launch-cleanup-");
    await at("wrap", "0.15.5");
    await at("launch", "0.16.0");

    await unproject({ repoPath, registeredCompanionPaths: [companionPath] });

    expect(
      await fs
        .readFile(path.join(repoPath, ".opencode", "opencode.json"), "utf8")
        .catch(() => null),
    ).toBeNull();
    expect(
      await fs
        .readFile(path.join(repoPath, ".claude", "settings.local.json"), "utf8")
        .catch(() => null),
    ).toBeNull();
  });
});

describe("the owner's reporting", () => {
  test("writes catalogue order, putting the managed exclude block before what it covers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "projection-order-"));
    tempRoots.push(root);
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });
    await execFileAsync("git", ["init", "-q", repoPath]);

    const result = await project("link", {
      repoPath,
      companionPath: path.join(root, "companion"),
      repository: { id: "acme", path: repoPath },
      source: "git",
    });

    expect(result.outcomes.map((outcome) => outcome.id)).toEqual([
      "git-excludes",
      "projection-root",
      "companion-link",
      "repo-local-framework",
      "repo-local-registry",
    ]);
    expect(result.outcomes.every((outcome) => outcome.state === "written")).toBe(true);
  });

  test("skips an entry whose input was not supplied and still attempts the rest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "projection-skipped-"));
    tempRoots.push(root);
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });

    const result = await project("session", { repoPath });

    expect(result.outcomes.map((outcome) => [outcome.id, outcome.state])).toEqual([
      ["git-excludes", "current"],
      ["projection-root", "written"],
      ["companion-link", "skipped"],
      ["projection-pair", "skipped"],
    ]);
  });

  test("reports one unwritable entry as failed without stopping the others", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "projection-partial-"));
    tempRoots.push(root);
    const repoPath = path.join(root, "working");
    await fs.mkdir(path.join(repoPath, `.${FRAMEWORK_NAME}`), { recursive: true });
    await fs.chmod(path.join(repoPath, `.${FRAMEWORK_NAME}`), 0o555);

    const result = await project("link", {
      repoPath,
      companionPath: path.join(root, "companion"),
      repository: { id: "acme", path: repoPath },
      source: "git",
    });

    const states = new Map(result.outcomes.map((outcome) => [outcome.id, outcome.state]));
    expect(states.get("repo-local-framework")).toBe("failed");
    expect(states.get("repo-local-registry")).toBe("failed");
    expect(
      result.outcomes.find((outcome) => outcome.id === "repo-local-framework")?.error,
    ).toBeInstanceOf(Error);
  });

  test("describe reports presence per entry and writes nothing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "projection-describe-"));
    tempRoots.push(root);
    const repoPath = path.join(root, "working");
    const companionPath = path.join(root, "companion");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(companionPath, { recursive: true });
    await execFileAsync("git", ["init", "-q", repoPath]);
    const repository: LinkedRepository = { id: "acme", path: repoPath };
    await project("link", { repoPath, companionPath, repository, source: "git" });
    await project("session", { repoPath, companionPath, repository });

    const described = await describeProjection(repoPath);

    expect(described.root).toBe(path.join(repoPath, `.${FRAMEWORK_NAME}`));
    expect(described.projection?.projection.companionPath).toBe(companionPath);
    const presence = new Map(described.entries.map((entry) => [entry.id, entry.present]));
    expect(presence.get("git-excludes")).toBe(true);
    expect(presence.get("repo-local-registry")).toBe(true);
    expect(presence.get("projection-pair")).toBe(true);
    expect(presence.get("workspace-document")).toBe(false);
    expect(presence.get("claude-working-settings")).toBe(false);
  });
});

/**
 * A runtime document Git already tracks: the managed exclude cannot hide it,
 * and the companion paths Mate writes into it are this machine's.
 */
describe("a tracked runtime document", () => {
  const document: RenderedRuntimeDocument = {
    path: ".opencode/opencode.json",
    regions: [{ at: ["plugin"], kind: "list", values: ["@acme/plugin@1.0.0"] }],
  };
  const config = { allowedAgents: ["opencode"], capabilities: [] };

  async function makeRepo(
    prefix: string,
    options: { git?: boolean; track?: boolean } = {},
  ): Promise<{ repoPath: string; companionPath: string; repository: LinkedRepository }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempRoots.push(root);
    const repoPath = path.join(root, "working");
    const companionPath = path.join(root, "companion");
    await fs.mkdir(path.join(repoPath, ".opencode"), { recursive: true });
    await fs.mkdir(companionPath, { recursive: true });
    if (options.git !== false) await execFileAsync("git", ["init", "-q", repoPath]);
    if (options.track) {
      await fs.writeFile(path.join(repoPath, ".opencode", "opencode.json"), "{}\n", "utf8");
      await execFileAsync("git", ["-C", repoPath, "add", "--force", ".opencode/opencode.json"]);
    }
    return { repoPath, companionPath, repository: { id: "acme", path: repoPath } };
  }

  async function collectWarnings(run: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      await run();
    } finally {
      console.error = original;
    }
    return lines;
  }

  test("warns on the wrap pass and still writes the document", async () => {
    const { repoPath, companionPath, repository } = await makeRepo("projection-tracked-", {
      track: true,
    });

    let result: Awaited<ReturnType<typeof projectWorkingRuntimeDocuments>> | undefined;
    const lines = await collectWarnings(async () => {
      result = await projectWorkingRuntimeDocuments(companionPath, repository, config, [document]);
    });

    expect(result?.kind).toBe("written");
    expect(await fs.readFile(path.join(repoPath, ".opencode", "opencode.json"), "utf8")).toContain(
      "@acme/plugin@1.0.0",
    );
    expect(lines.join("\n")).toContain(
      `${FRAMEWORK_NAME}: warning: .opencode/opencode.json is tracked by Git in acme;`,
    );
    expect(lines.join("\n")).toContain("git rm --cached .opencode/opencode.json");
  });

  test("says nothing about a document Git does not track", async () => {
    const { companionPath, repository } = await makeRepo("projection-untracked-");

    const lines = await collectWarnings(async () => {
      await projectWorkingRuntimeDocuments(companionPath, repository, config, [document]);
    });

    expect(lines).toEqual([]);
  });

  test("a directory that is no Git repository writes without failing", async () => {
    const { repoPath, companionPath, repository } = await makeRepo("projection-nogit-", {
      git: false,
    });

    let result: Awaited<ReturnType<typeof projectWorkingRuntimeDocuments>> | undefined;
    const lines = await collectWarnings(async () => {
      result = await projectWorkingRuntimeDocuments(companionPath, repository, config, [document]);
    });

    expect(lines).toEqual([]);
    expect(result?.kind).toBe("written");
    expect(await fs.readFile(path.join(repoPath, ".opencode", "opencode.json"), "utf8")).toContain(
      "@acme/plugin@1.0.0",
    );
  });

  /** The launch scope renders the same documents on every start; only wrap says it. */
  test("the launch scope writes the same tracked document silently", async () => {
    const { repoPath, companionPath, repository } = await makeRepo("projection-launch-quiet-", {
      track: true,
    });

    const lines = await collectWarnings(async () => {
      await project("launch", {
        repoPath,
        companionPath,
        repository,
        config,
        runtimeDocuments: [document],
      });
    });

    expect(lines).toEqual([]);
    expect(await fs.readFile(path.join(repoPath, ".opencode", "opencode.json"), "utf8")).toContain(
      "@acme/plugin@1.0.0",
    );
  });
});

/**
 * The seam the design rests on: the owner stays free of Agent Runtime format
 * knowledge, which is what lets a second runtime arrive as a declaration.
 */
describe("the owner's dependencies", () => {
  test("imports no Agent Runtime format module", async () => {
    const source = await fs.readFile(
      path.join(import.meta.dir, "working-repo-projection.ts"),
      "utf8",
    );

    expect(source).not.toContain("claude");
    expect(source).not.toContain("opencode");
    expect(source).not.toContain("providers/");
  });
});

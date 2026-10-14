import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "bun:test";

import { getActiveDistribution, setActiveDistribution } from "../../distribution";
import { FRAMEWORK_NAME } from "../../framework";
import { parseProjectionYaml, type ProjectionFile } from "../../runtime/projection";
import { renderWorkingRuntimeDocuments } from "../../tools/setup";
import { runtimeOpenCodePluginRoot } from "../../runtime/runtime-directory";
import { projectionEntries } from "./projection-entries";
import { GlobalConfigStore } from "./global-config-store";
import { runtimeDocumentDeps } from "./projection-runtime-documents";
import { firstFailure } from "./projection-types";
import type { RenderedRuntimeDocument } from "../../runtime/runtime-document-manifest";
import { writeRepoLocalRegistryEntry } from "./repository-link";
import type { LinkedRepository } from "./types";
import {
  describe as describeProjection,
  project,
  projectWorkingRepository,
  projectWorkingRepositoryBestEffort,
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
      runtimeDocuments: (await renderWorkingRuntimeDocuments(companionPath, config, repoPath))
        .documents,
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
      runtimeDocuments: (await renderWorkingRuntimeDocuments(companionPath, config, repoPath))
        .documents,
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
 * machine-local OpenCode plugin root above all. A repository is wrapped once and
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
    at(
      scope: "launch" | "wrap",
      version: string,
      assetRoots?: string[],
    ): Promise<Awaited<ReturnType<typeof project>>>;
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
      at: async (scope, version, assetRoots) => {
        setActiveDistribution({
          ...originalDistribution,
          config: { ...originalDistribution.config, version, assetRoots },
        });
        return project(scope, {
          repoPath,
          companionPath,
          repository,
          config,
          globalConfigStore: store,
          runtimeDocuments: (await renderWorkingRuntimeDocuments(companionPath, config, repoPath))
            .documents,
        });
      },
    };
  }

  interface OpenCodeDocument {
    plugins?: string[];
    mcp?: { servers?: Record<string, unknown> };
    permissions?: Array<{ action: string; resource: string; effect: string }>;
  }

  async function readOpenCode(repoPath: string): Promise<OpenCodeDocument> {
    return JSON.parse(
      await fs.readFile(path.join(repoPath, ".opencode", "opencode.json"), "utf8"),
    ) as OpenCodeDocument;
  }

  function stateOf(result: Awaited<ReturnType<typeof project>>, id: string): string | undefined {
    return result.outcomes.find((outcome) => outcome.id === id)?.state;
  }

  test("the wrapped plugin root is the runtime link, so a new install changes nothing", async () => {
    const { repoPath, at } = await makeWrappable("projection-launch-repin-");
    const assets = await fs.mkdtemp(path.join(os.tmpdir(), "projection-launch-assets-"));
    tempRoots.push(assets);
    await fs.mkdir(path.join(assets, "opencode-plugin"));
    await at("wrap", "0.15.5");
    expect((await readOpenCode(repoPath)).plugins).toEqual([runtimeOpenCodePluginRoot()]);

    const launched = await at("launch", "0.16.0", [assets]);

    expect(stateOf(launched, "opencode-runtime-document")).toBe("current");
    expect((await readOpenCode(repoPath)).plugins).toEqual([runtimeOpenCodePluginRoot()]);
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
    expect(Object.keys(wrapped.mcp?.servers ?? {})).toEqual(["tokensave"]);

    await at("launch", "0.16.0");

    const launched = await readOpenCode(repoPath);
    expect(launched.mcp?.servers).toEqual(wrapped.mcp?.servers);
    expect(launched.permissions).toContainEqual({
      action: "external_directory",
      resource: companionPath,
      effect: "allow",
    });
    expect(launched.permissions).toEqual(wrapped.permissions);
    expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual(settings);
    expect(await fs.readFile(localConfigPath, "utf8")).toBe(localConfig);
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
      ["openspec-store-exclude", "current"],
      ["openspec-store-pointer", "skipped"],
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
    regions: [{ at: ["plugins"], kind: "list", values: ["@acme/plugin@1.0.0"] }],
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

  async function collectStderr(run: () => Promise<void>): Promise<string[]> {
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

  async function wrap(
    repoPath: string,
    companionPath: string,
    repository: LinkedRepository,
  ): Promise<{ warnings: string[]; state?: string; stderr: string[] }> {
    let result: Awaited<ReturnType<typeof project>> | undefined;
    const stderr = await collectStderr(async () => {
      result = await project("wrap", {
        repoPath,
        companionPath,
        repository,
        config,
        runtimes: ["opencode"],
        runtimeDocuments: [document],
      });
    });
    const outcome = result?.outcomes.find((entry) => entry.id === "opencode-runtime-document");
    return { warnings: outcome?.warnings ?? [], state: outcome?.state, stderr };
  }

  test("warns in the outcome of the pass that writes it, and still writes it", async () => {
    const { repoPath, companionPath, repository } = await makeRepo("projection-tracked-", {
      track: true,
    });

    const { warnings, state, stderr } = await wrap(repoPath, companionPath, repository);

    expect(state).toBe("written");
    expect(stderr).toEqual([]);
    expect(await fs.readFile(path.join(repoPath, ".opencode", "opencode.json"), "utf8")).toContain(
      "@acme/plugin@1.0.0",
    );
    expect(warnings.join("\n")).toContain(".opencode/opencode.json is tracked by Git in acme;");
    expect(warnings.join("\n")).toContain("git rm --cached .opencode/opencode.json");
  });

  test("an unchanged tracked document does not warn again", async () => {
    const { repoPath, companionPath, repository } = await makeRepo("projection-tracked-again-", {
      track: true,
    });
    await wrap(repoPath, companionPath, repository);

    const { warnings, state } = await wrap(repoPath, companionPath, repository);

    expect(state).toBe("current");
    expect(warnings).toEqual([]);
  });

  test("says nothing about a document Git does not track", async () => {
    const { repoPath, companionPath, repository } = await makeRepo("projection-untracked-");

    const { warnings, state } = await wrap(repoPath, companionPath, repository);

    expect(state).toBe("written");
    expect(warnings).toEqual([]);
  });

  test("a directory that is no Git repository writes without failing", async () => {
    const { repoPath, companionPath, repository } = await makeRepo("projection-nogit-", {
      git: false,
    });

    const { warnings, state, stderr } = await wrap(repoPath, companionPath, repository);

    expect(warnings).toEqual([]);
    expect(stderr).toEqual([]);
    expect(state).toBe("written");
    expect(await fs.readFile(path.join(repoPath, ".opencode", "opencode.json"), "utf8")).toContain(
      "@acme/plugin@1.0.0",
    );
  });

  /** The launch scope renders the same documents on every start; it prints nothing. */
  test("the launch scope writes the same tracked document without printing", async () => {
    const { repoPath, companionPath, repository } = await makeRepo("projection-launch-quiet-", {
      track: true,
    });

    const lines = await collectStderr(async () => {
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

/**
 * An OpenCode Session Prepare runs the wrap pass alone, so every entry the
 * launch scope writes for OpenCode has to be in the wrap scope too.
 */
describe("one projection pass for OpenCode", () => {
  test("the wrap scope covers every launch-scope entry that applies to OpenCode", () => {
    const uncovered = projectionEntries()
      .filter((entry) => entry.scopes.includes("launch"))
      .filter((entry) => !entry.runtime || entry.runtime === "opencode")
      .filter((entry) => !entry.scopes.includes("wrap"))
      .map((entry) => entry.id);

    expect(uncovered).toEqual([]);
  });

  test("a wrap pass writes a Capability's exclusion and strips the legacy CLAUDE.md append", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "projection-wrap-launch-"));
    tempRoots.push(root);
    const repoPath = path.join(root, "working");
    const companionPath = path.join(root, "companion");
    await fs.mkdir(path.join(repoPath, ".git", "info"), { recursive: true });
    await fs.mkdir(companionPath, { recursive: true });
    const repository: LinkedRepository = { id: "acme", path: repoPath };

    const result = await project("wrap", {
      repoPath,
      companionPath,
      repository,
      config: { allowedAgents: ["opencode"], capabilities: [{ name: "tokensave" }] } as never,
      runtimes: ["opencode"],
    });

    expect(firstFailure(result.outcomes)).toBeFalsy();
    const ids = result.outcomes.map((outcome) => outcome.id);
    expect(ids).toContain("capability-excludes");
    expect(ids).toContain("legacy-tokensave-claude-md");
    expect(await fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8")).toContain(
      ".tokensave/",
    );
  });

  test("the wrap scope declares the projection pair and the companion copies", () => {
    const wrapIds = projectionEntries()
      .filter((entry) => entry.scopes.includes("wrap"))
      .map((entry) => entry.id);

    expect(wrapIds).toContain("projection-pair");
    expect(wrapIds).toContain("opencode-companion-copies");
    expect(wrapIds.at(-1)).toBe("opencode-companion-copies");
  });

  test("an OpenCode-restricted wrap attempts no Claude entry and every untagged one", async () => {
    const { repoPath, companionPath, repository } = await copiesFixture("projection-wrap-runtime-");
    const result = await project("wrap", {
      repoPath,
      companionPath,
      repository,
      config: { allowedAgents: ["opencode"], capabilities: [] } as never,
      runtimes: ["opencode"],
      runtimeDocuments: [],
    });

    const ids = result.outcomes.map((outcome) => outcome.id);
    const claudeIds = projectionEntries()
      .filter((entry) => entry.runtime === "claude")
      .map((entry) => entry.id);
    const untagged = projectionEntries()
      .filter((entry) => entry.scopes.includes("wrap") && !entry.runtime)
      .map((entry) => entry.id);
    expect(ids.filter((id) => claudeIds.includes(id))).toEqual([]);
    expect(ids).toEqual(expect.arrayContaining(untagged));
    expect(ids).toContain("projection-pair");
  });
});

async function copiesFixture(
  prefix: string,
): Promise<{ repoPath: string; companionPath: string; repository: LinkedRepository }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const repoPath = path.join(root, "working");
  const companionPath = path.join(root, "companion");
  await fs.mkdir(path.join(companionPath, ".opencode", "commands"), { recursive: true });
  await fs.writeFile(path.join(companionPath, ".opencode", "commands", "acme.md"), "acme\n");
  await fs.mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init", "-q", repoPath]);
  return { repoPath, companionPath, repository: { id: "acme", path: repoPath } };
}

/** Every write reports the same outcome shape, whichever form the entry returned. */
describe("wrap-scope outcomes", () => {
  test("every wrap-scope entry's outcome has the normalized shape", async () => {
    const { repoPath, companionPath, repository } = await copiesFixture("projection-shape-");
    const config = { allowedAgents: ["claude", "opencode"], capabilities: [] };

    const result = await project("wrap", {
      repoPath,
      companionPath,
      repository,
      config,
      runtimeDocuments: (await renderWorkingRuntimeDocuments(companionPath, config, repoPath))
        .documents,
    });

    const wrapIds = projectionEntries()
      .filter((entry) => entry.scopes.includes("wrap"))
      .map((entry) => entry.id);
    expect(result.outcomes.map((outcome) => outcome.id)).toEqual(wrapIds);
    for (const outcome of result.outcomes) {
      expect(["written", "current", "skipped"]).toContain(outcome.state);
      if (outcome.warnings !== undefined) {
        expect(outcome.warnings.length).toBeGreaterThan(0);
        for (const warning of outcome.warnings) expect(typeof warning).toBe("string");
      }
      if (outcome.changed !== undefined) {
        expect(Array.isArray(outcome.changed.written)).toBe(true);
        expect(Array.isArray(outcome.changed.removed)).toBe(true);
        expect(outcome.changed.written.length + outcome.changed.removed.length).toBeGreaterThan(0);
      }
    }
    const copies = result.outcomes.find((outcome) => outcome.id === "opencode-companion-copies");
    expect(copies?.changed).toEqual({ written: [".opencode/commands/acme.md"], removed: [] });
  });
});

describe("the companion copies entry", () => {
  test("withdraws every owned copy once the companion drops OpenCode", async () => {
    const { repoPath, companionPath, repository } = await copiesFixture("projection-copies-drop-");
    await project("wrap", {
      repoPath,
      companionPath,
      repository,
      config: { allowedAgents: ["opencode"], capabilities: [] } as never,
    });
    expect(await fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8")).toContain(
      "acme.md",
    );

    const result = await project("wrap", {
      repoPath,
      companionPath,
      repository,
      config: { allowedAgents: ["claude"], capabilities: [] } as never,
    });

    const copies = result.outcomes.find((outcome) => outcome.id === "opencode-companion-copies");
    expect(copies?.state).toBe("written");
    expect(copies?.changed).toEqual({ written: [], removed: [".opencode/commands/acme.md"] });
    expect(
      await fs.access(path.join(repoPath, ".opencode")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8")).not.toContain(
      "acme.md",
    );
  });

  test("reports a shadowed companion file as a warning in its outcome", async () => {
    const { repoPath, companionPath, repository } = await copiesFixture(
      "projection-copies-shadow-",
    );
    await fs.mkdir(path.join(repoPath, ".opencode", "commands"), { recursive: true });
    await fs.writeFile(path.join(repoPath, ".opencode", "commands", "acme.md"), "repo\n");

    const result = await project("wrap", {
      repoPath,
      companionPath,
      repository,
      config: { allowedAgents: ["opencode"], capabilities: [] } as never,
    });

    const warnings =
      result.outcomes.find((outcome) => outcome.id === "opencode-companion-copies")?.warnings ?? [];
    expect(warnings.join("\n")).toContain(".opencode/commands/acme.md");
    expect(warnings.join("\n")).toContain(
      path.join(companionPath, ".opencode", "commands", "acme.md"),
    );
  });

  test("is skipped without a companion config", async () => {
    const { repoPath, companionPath, repository } = await copiesFixture("projection-copies-skip-");

    const result = await project("wrap", { repoPath, companionPath, repository });

    expect(
      result.outcomes.find((outcome) => outcome.id === "opencode-companion-copies")?.state,
    ).toBe("skipped");
  });
});

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "bun:test";

import { FRAMEWORK_NAME } from "../../framework";
import { parseProjectionYaml, type ProjectionFile } from "../../runtime/projection";
import { renderWorkingRuntimeDocuments } from "../../tools/setup";
import { GlobalConfigStore } from "./global-config-store";
import { firstFailure } from "./projection-types";
import { writeRepoLocalRegistryEntry } from "./repo-local-registry";
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
    expect(
      await fs.readFile(path.join(linkPath(repoPath), "openspec", "spec.md"), "utf8"),
    ).toBe("# Acme\n");
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

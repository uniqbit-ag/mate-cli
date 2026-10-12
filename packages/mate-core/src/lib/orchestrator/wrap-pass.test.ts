import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { FRAMEWORK_NAME } from "../../framework";
import { runtimeDocumentDeps } from "./projection-runtime-documents";
import { writeRepoLocalRegistryEntry } from "./repo-local-registry";
import type { LinkedRepository } from "./types";
import { links, manifestPath, readManifest } from "../../runtime/runtime-document-manifest";
import {
  isWorkingRepositoryWrapped,
  unproject,
  unwrapWorkingRuntimeDocuments,
} from "./working-repo-projection";
import { GlobalConfigStore } from "./global-config-store";
import { runWrapPass, wrapPassDeps } from "./wrap-pass";

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
    expect(await isWorkingRepositoryWrapped(repository.path, "opencode")).toBe(true);
    expect(await isWorkingRepositoryWrapped(repository.path, "claude")).toBe(false);
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

    expect(await isWorkingRepositoryWrapped(repository.path, "claude")).toBe(true);
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
    expect(await isWorkingRepositoryWrapped(repository.path, "claude")).toBe(true);
    expect(await isWorkingRepositoryWrapped(repository.path, "opencode")).toBe(true);
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
    expect(await isWorkingRepositoryWrapped(repository.path, "opencode")).toBe(true);
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

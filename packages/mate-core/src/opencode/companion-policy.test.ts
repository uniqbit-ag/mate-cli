import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import {
  buildArtifactError,
  readContext,
  shouldBlockArtifactWrite,
  type CompanionContext,
} from "./companion-policy";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function initGitRepo(root: string): Promise<void> {
  spawnSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
}

async function wrapRepo(repoRoot: string, companionPath: string): Promise<void> {
  const registryPath = repoLocalRegistryPath(repoRoot);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, "companions: []\n", "utf8");
  writeProjectionPair(repoRoot, {
    stamp: "deadbeef",
    projection: {
      version: "0.0.0",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme",
      wrapperBinPath: path.join(companionPath, "wrappers", "bin"),
      reactDoctorBinPath: path.join(companionPath, "react-doctor"),
      graphifyOut: path.join(companionPath, ".graphify", "acme", "graphify-out"),
    },
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("readContext", () => {
  test("reports the companion a projection resolves when the environment is empty", async () => {
    const repo = await makeTempDir("mate-readcontext-wrapped-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await fs.writeFile(path.join(companion, "AGENTS.md"), "projected agents\n", "utf8");
    await wrapRepo(repo, companion);

    const context = readContext({}, repo);

    expect(context.companionPath).toBe(companion);
    expect(context.repositoryPath).toBe(repo);
    expect(context.agentsMd).toBe("projected agents\n");
  });

  test("is a no-op under a launch: the resolved companion is the environment value", async () => {
    const repo = await makeTempDir("mate-readcontext-launched-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await fs.writeFile(path.join(companion, "AGENTS.md"), "launched agents\n", "utf8");
    const projected = path.join(repo, "projected");
    await fs.mkdir(projected, { recursive: true });
    await wrapRepo(repo, projected);

    const context = readContext({ MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo }, repo);

    expect(context.companionPath).toBe(companion);
    expect(context.agentsMd).toBe("launched agents\n");
  });

  test("reports a stale projection, naming mate wrap", async () => {
    const repo = await makeTempDir("mate-readcontext-stale-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await wrapRepo(repo, companion);

    const context = readContext({}, repo);

    expect(context.companionPath).toBe(companion);
    expect(context.stalenessLines.join("\n")).toContain("mate wrap");
  });

  test("a managed session carries no staleness", async () => {
    const repo = await makeTempDir("mate-readcontext-managed-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await wrapRepo(repo, companion);

    expect(
      readContext({ MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo }, repo).stalenessLines,
    ).toEqual([]);
  });

  test("resolves nothing in an unwrapped repository with an empty environment", async () => {
    const repo = await makeTempDir("mate-readcontext-unwrapped-");

    const context = readContext({}, repo);

    expect(context.companionPath).toBe("");
    expect(context.repositoryPath).toBe("");
    expect(context.agentsMd).toBe("");
  });
});

function makeContext(repo: string, companion: string): CompanionContext {
  return {
    frameworkName: "mate",
    companionPath: companion,
    graphifyEnabled: false,
    gitAutoModeEnabled: false,
    repositoryPath: repo,
    repositoryId: "app",
    policyJson: "{}",
    agentsMd: "",
    stalenessLines: [],
  };
}

describe("OpenCode companion policy", () => {
  test("allows gitignored artifact writes in the working repository", async () => {
    const repo = await makeTempDir("mate-opencode-ignored-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    await fs.mkdir(path.join(repo, "scratch"), { recursive: true });
    await fs.writeFile(path.join(repo, ".gitignore"), "scratch/*.md\n", "utf8");

    const context = makeContext(repo, companion);
    expect(shouldBlockArtifactWrite(context, path.join(repo, "scratch", "note.md"))).toBe(false);
  });

  test("blocks non-gitignored artifact writes in the working repository", async () => {
    const repo = await makeTempDir("mate-opencode-blocked-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);

    const context = makeContext(repo, companion);
    expect(shouldBlockArtifactWrite(context, path.join(repo, "scratch", "note.md"))).toBe(true);
    expect(buildArtifactError(context, path.join(repo, "scratch", "note.md"))).toContain(
      "artifact writes must go to the companion framework path",
    );
  });

  test("allows product documentation and storybook paths in the working repository", async () => {
    const repo = await makeTempDir("mate-opencode-docs-allow-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await fs.mkdir(path.join(repo, "apps", "docs"), { recursive: true });
    await fs.writeFile(path.join(repo, "apps", "docs", "package.json"), "{}\n", "utf8");
    await fs.mkdir(path.join(repo, "docs"), { recursive: true });
    await fs.writeFile(path.join(repo, "docs", "package.json"), "{}\n", "utf8");
    await initGitRepo(repo);

    const context = makeContext(repo, companion);
    expect(
      shouldBlockArtifactWrite(
        context,
        path.join(repo, "apps", "docs", "content", "docs", "index.mdx"),
      ),
    ).toBe(false);
    expect(shouldBlockArtifactWrite(context, path.join(repo, "docs", "content", "index.mdx"))).toBe(
      false,
    );
    expect(shouldBlockArtifactWrite(context, path.join(repo, ".storybook", "preview.ts"))).toBe(
      false,
    );
    expect(shouldBlockArtifactWrite(context, path.join(repo, "storybook", "intro.mdx"))).toBe(
      false,
    );
  });

  test("still blocks artifact folders under product docs", async () => {
    const repo = await makeTempDir("mate-opencode-docs-block-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await fs.mkdir(path.join(repo, "apps", "docs-without-package"), { recursive: true });
    await initGitRepo(repo);

    const context = makeContext(repo, companion);
    expect(
      shouldBlockArtifactWrite(
        context,
        path.join(repo, "apps", "docs-without-package", "guide.md"),
      ),
    ).toBe(true);
    expect(shouldBlockArtifactWrite(context, path.join(repo, "docs", "usage.md"))).toBe(true);
    expect(
      shouldBlockArtifactWrite(context, path.join(repo, "docs", "decisions", "ADR-001.md")),
    ).toBe(true);
    expect(
      shouldBlockArtifactWrite(context, path.join(repo, "docs", "prd", "new-feature.md")),
    ).toBe(true);
    expect(shouldBlockArtifactWrite(context, path.join(repo, "docs", "usage", "tasks.md"))).toBe(
      true,
    );
  });
});

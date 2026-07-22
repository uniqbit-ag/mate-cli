import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildArtifactError,
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

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeContext(repo: string, companion: string): CompanionContext {
  return {
    frameworkName: "mate",
    companionPath: companion,
    graphifyEnabled: false,
    gitAutoModeEnabled: false,
    repositoryPath: repo,
    repositoryId: "app",
    repositoryProfile: "default",
    policyJson: "{}",
    agentsMd: "",
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

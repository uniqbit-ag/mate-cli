import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { version } from "../../../../package.json";
import { writeRepoLocalRegistryEntry } from "../../../lib/orchestrator/repo-local-registry";
import { renderBanner, resolveCompanionPath, resolveRepoPath, resolveShell } from "./tui";

const execFileAsync = promisify(execFile);

async function initGitRepo(repoPath: string): Promise<void> {
  await fs.mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init", "-q", repoPath]);
}

const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
const originalRepoPath = process.env.MATE_REPO_PATH;

afterEach(async () => {
  if (originalArtifactPath === undefined) {
    delete process.env.MATE_ARTIFACT_PATH;
  } else {
    process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
  }
  if (originalRepoPath === undefined) {
    delete process.env.MATE_REPO_PATH;
  } else {
    process.env.MATE_REPO_PATH = originalRepoPath;
  }
});

describe("renderBanner", () => {
  test("includes title and paths", () => {
    const banner = renderBanner("/path/to/repo", "/path/to/companion");
    expect(banner).toContain(`mate v${version}`);
    expect(banner).not.toContain("MATE | managed companion terminal");
    expect(banner).toContain("/path/to/repo");
    expect(banner).toContain("/path/to/companion");
  });

  test("aligns all content lines to same width", () => {
    const banner = renderBanner("/short", "/very-long-companion-path-that-should-align");
    const contentLines = banner.split("\n").filter((l) => l.startsWith("│"));
    expect(contentLines.every((l) => l.length === contentLines[0].length)).toBe(true);
  });

  test("uses unicode box-drawing characters", () => {
    const banner = renderBanner("/repo", "/companion");
    expect(banner).toMatch(/╭.*╮/);
    expect(banner).toMatch(/╰.*╯/);
  });

  test("border rows match content row width", () => {
    const banner = renderBanner("/short", "/very-long-companion-path-that-should-align");
    const rows = banner.split("\n");
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
  });
});

describe("resolveShell", () => {
  const originalShell = process.env.SHELL;

  afterEach(() => {
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
  });

  test("falls back to /bin/sh when SHELL is unset", () => {
    delete process.env.SHELL;
    expect(resolveShell()).toBe("/bin/sh");
  });

  test("falls back to /bin/sh when SHELL points to non-existent binary", () => {
    process.env.SHELL = "/nonexistent/shell";
    expect(resolveShell()).toBe("/bin/sh");
  });

  test("uses SHELL when it points to valid binary", () => {
    process.env.SHELL = "/bin/sh";
    expect(resolveShell()).toBe("/bin/sh");
  });
});

describe("resolveCompanionPath", () => {
  test("resolves the repo-local companion when MATE_ARTIFACT_PATH is unset", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tui-resolver-"));
    const repoPath = path.join(root, "repo");
    const companionPath = path.join(root, "companion");

    try {
      await fs.mkdir(path.join(repoPath, ".mate", "config"), { recursive: true });
      await fs.mkdir(companionPath, { recursive: true });
      await fs.writeFile(
        path.join(repoPath, ".mate", "config", "registry.yaml"),
        `companions:\n  - path: ${companionPath}\n    repositoryId: test-repo\n`,
        "utf8",
      );
      delete process.env.MATE_ARTIFACT_PATH;
      delete process.env.MATE_REPO_PATH;

      expect(await resolveCompanionPath(repoPath)).toBe(companionPath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("uses MATE_REPO_PATH when resolving from a companion shell", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tui-env-resolver-"));
    const repoPath = path.join(root, "repo");
    const companionPath = path.join(root, "companion");

    try {
      await fs.mkdir(path.join(repoPath, ".mate", "config"), { recursive: true });
      await fs.mkdir(companionPath, { recursive: true });
      await fs.writeFile(
        path.join(repoPath, ".mate", "config", "registry.yaml"),
        `companions:\n  - path: ${companionPath}\n    repositoryId: test-repo\n`,
        "utf8",
      );
      delete process.env.MATE_ARTIFACT_PATH;
      process.env.MATE_REPO_PATH = repoPath;

      expect(await resolveCompanionPath(companionPath)).toBe(companionPath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolveRepoPath", () => {
  test("resolves the linked repository path from the repo-local registry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tui-repo-resolver-"));
    const repoPath = path.join(root, "repo");

    try {
      await initGitRepo(repoPath);
      await writeRepoLocalRegistryEntry(
        repoPath,
        "/tmp/companion",
        { id: "app", path: repoPath, profile: "default" },
        "git",
      );

      expect(await resolveRepoPath(repoPath)).toBe(path.resolve(repoPath));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to cwd when no repo-local registry entry exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tui-repo-resolver-fallback-"));

    try {
      expect(await resolveRepoPath(root)).toBe(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

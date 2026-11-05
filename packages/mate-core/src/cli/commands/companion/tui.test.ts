import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { version } from "../../../../package.json";
import { writeRepoLocalRegistryEntry } from "../../../lib/orchestrator/repository-link";
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
  test("prints the version and aligned path lines without a box", () => {
    const banner = renderBanner("/path/to/repo", "/path/to/companion", { color: false });
    expect(banner.split("\n")).toEqual([
      `mate v${version}`,
      "  repo  /path/to/repo",
      "  mate  /path/to/companion",
    ]);
    expect(banner).not.toMatch(/[╭╮╰╯│─]/);
  });

  test("never pads or truncates long paths", () => {
    const long = `/acme/${"very-long-segment/".repeat(12)}companion`;
    const banner = renderBanner("/short", long, { color: false });
    expect(banner).toContain(`  mate  ${long}`);
    expect(banner.split("\n").every((line) => line === line.trimEnd())).toBe(true);
  });

  test("accents mate only when colour is on", () => {
    const colored = renderBanner("/repo", "/companion", { color: true });
    expect(colored.split("\n")[0]).toBe(`\u001b[38;2;46;125;91mmate\u001b[39m v${version}`);
    expect(colored.split("\n").slice(1).join("")).not.toContain("\u001b");
  });

  test("prints no escape codes with NO_COLOR or a non-TTY stdout", () => {
    const originalIsTTY = process.stdout.isTTY;
    const originalNoColor = process.env.NO_COLOR;
    try {
      process.stdout.isTTY = true;
      process.env.NO_COLOR = "1";
      expect(renderBanner("/repo", "/companion")).not.toContain("\u001b");

      delete process.env.NO_COLOR;
      process.stdout.isTTY = false;
      expect(renderBanner("/repo", "/companion")).not.toContain("\u001b");
    } finally {
      process.stdout.isTTY = originalIsTTY;
      if (originalNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = originalNoColor;
    }
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
        { id: "app", path: repoPath },
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

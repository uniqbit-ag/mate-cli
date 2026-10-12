import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { copies } from "../../runtime/runtime-document-manifest";
import { readManifest } from "../../runtime/runtime-document-manifest";
import { unproject, unwrapWorkingRuntimeDocuments } from "./working-repo-projection";
import { reconcileCompanionCopies, removeCompanionCopies } from "./projection-opencode-copies";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{ companionPath: string; repoPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-copies-"));
  tempRoots.push(root);
  const companionPath = path.join(root, "companion");
  const repoPath = path.join(root, "working");
  await fs.mkdir(path.join(companionPath, ".opencode"), { recursive: true });
  await fs.mkdir(repoPath, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoPath });
  return { companionPath, repoPath };
}

async function put(root: string, rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
}

async function exists(candidate: string): Promise<boolean> {
  return fs
    .lstat(candidate)
    .then(() => true)
    .catch(() => false);
}

function gitStatus(repoPath: string): string {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoPath,
    encoding: "utf8",
  });
}

async function exclude(repoPath: string): Promise<string> {
  return fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8").catch(() => "");
}

describe("copying the companion .opencode folder", () => {
  test("copies files as regular, git-excluded files", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(companionPath, ".opencode/commands/acme.md", "acme command\n");
    await put(companionPath, ".opencode/skills/acme/SKILL.md", "acme skill\n");

    const report = await reconcileCompanionCopies(repoPath, companionPath);

    const copy = path.join(repoPath, ".opencode", "commands", "acme.md");
    expect(report.state).toBe("written");
    expect(report.changed?.written).toEqual([
      ".opencode/commands/acme.md",
      ".opencode/skills/acme/SKILL.md",
    ]);
    expect((await fs.lstat(copy)).isFile()).toBe(true);
    expect(await fs.readFile(copy, "utf8")).toBe("acme command\n");
    expect(Object.keys(copies(await readManifest(repoPath), "opencode")).sort()).toEqual([
      ".opencode/commands/acme.md",
      ".opencode/skills/acme/SKILL.md",
    ]);
    expect(await exclude(repoPath)).toContain("/.opencode/commands/acme.md");
    expect(gitStatus(repoPath)).not.toContain("acme.md");
  });

  test("copies a symlinked companion file as a regular file", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(companionPath, "shared/acme.md", "linked\n");
    await fs.mkdir(path.join(companionPath, ".opencode", "commands"), { recursive: true });
    await fs.symlink(
      path.join(companionPath, "shared", "acme.md"),
      path.join(companionPath, ".opencode", "commands", "acme.md"),
    );

    await reconcileCompanionCopies(repoPath, companionPath);

    const copy = path.join(repoPath, ".opencode", "commands", "acme.md");
    expect((await fs.lstat(copy)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(copy, "utf8")).toBe("linked\n");
  });

  test("skips opencode.json, node_modules and .DS_Store", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(companionPath, ".opencode/opencode.json", "{}");
    await put(companionPath, ".opencode/node_modules/acme/index.js", "x");
    await put(companionPath, ".opencode/.DS_Store", "x");
    await put(companionPath, ".opencode/commands/.DS_Store", "x");

    await reconcileCompanionCopies(repoPath, companionPath);

    expect(await exists(path.join(repoPath, ".opencode", "opencode.json"))).toBe(false);
    expect(await exists(path.join(repoPath, ".opencode", "node_modules"))).toBe(false);
    expect(await exists(path.join(repoPath, ".opencode", ".DS_Store"))).toBe(false);
    expect(copies(await readManifest(repoPath))).toEqual({});
  });

  test("an unchanged companion writes nothing", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(companionPath, ".opencode/commands/acme.md", "acme\n");
    await reconcileCompanionCopies(repoPath, companionPath);
    const copy = path.join(repoPath, ".opencode", "commands", "acme.md");
    const before = (await fs.stat(copy)).mtimeMs;
    const excludeBefore = await exclude(repoPath);

    const report = await reconcileCompanionCopies(repoPath, companionPath);

    expect(report.state).toBe("current");
    expect(report.changed).toEqual({ written: [], removed: [] });
    expect((await fs.stat(copy)).mtimeMs).toBe(before);
    expect(await exclude(repoPath)).toBe(excludeBefore);
  });

  test("updates a changed source and withdraws a removed one", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(companionPath, ".opencode/commands/acme.md", "v1\n");
    await put(companionPath, ".opencode/commands/gone/old.md", "old\n");
    await reconcileCompanionCopies(repoPath, companionPath);
    await put(companionPath, ".opencode/commands/acme.md", "v2\n");
    await fs.rm(path.join(companionPath, ".opencode", "commands", "gone"), { recursive: true });

    const report = await reconcileCompanionCopies(repoPath, companionPath);

    expect(await fs.readFile(path.join(repoPath, ".opencode/commands/acme.md"), "utf8")).toBe(
      "v2\n",
    );
    expect(await exists(path.join(repoPath, ".opencode", "commands", "gone"))).toBe(false);
    expect(report.changed).toEqual({
      written: [".opencode/commands/acme.md"],
      removed: [".opencode/commands/gone/old.md"],
    });
    expect(Object.keys(copies(await readManifest(repoPath)))).toEqual([
      ".opencode/commands/acme.md",
    ]);
    expect(await exclude(repoPath)).not.toContain("old.md");
  });

  test("overwrites a locally edited copy and says where to edit instead", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(companionPath, ".opencode/commands/acme.md", "v1\n");
    await reconcileCompanionCopies(repoPath, companionPath);
    await put(repoPath, ".opencode/commands/acme.md", "local edit\n");
    await put(companionPath, ".opencode/commands/acme.md", "v2\n");

    const report = await reconcileCompanionCopies(repoPath, companionPath);

    expect(await fs.readFile(path.join(repoPath, ".opencode/commands/acme.md"), "utf8")).toBe(
      "v2\n",
    );
    expect((report.warnings ?? []).join("\n")).toContain(
      path.join(companionPath, ".opencode", "commands", "acme.md"),
    );
  });

  test("a repository-owned file wins with a warning and is not recorded", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(repoPath, ".opencode/commands/acme.md", "repo\n");
    execFileSync("git", ["add", "."], { cwd: repoPath });
    await put(companionPath, ".opencode/commands/acme.md", "companion\n");

    const report = await reconcileCompanionCopies(repoPath, companionPath);

    expect(await fs.readFile(path.join(repoPath, ".opencode/commands/acme.md"), "utf8")).toBe(
      "repo\n",
    );
    expect(copies(await readManifest(repoPath))).toEqual({});
    expect((report.warnings ?? []).join("\n")).toContain("shadow");
    expect((report.warnings ?? []).join("\n")).toContain(".opencode/commands/acme.md");
  });

  test("an untracked file identical to the companion file is not recorded", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(repoPath, ".opencode/commands/acme.md", "acme\n");
    await put(companionPath, ".opencode/commands/acme.md", "acme\n");

    const report = await reconcileCompanionCopies(repoPath, companionPath);

    expect(copies(await readManifest(repoPath))).toEqual({});
    expect((report.warnings ?? []).join("\n")).toContain("shadow");
  });

  test("keeps a local edit while the companion source is unchanged", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(companionPath, ".opencode/commands/acme.md", "v1\n");
    await reconcileCompanionCopies(repoPath, companionPath);
    await put(repoPath, ".opencode/commands/acme.md", "local edit\n");

    const report = await reconcileCompanionCopies(repoPath, companionPath);

    expect(await fs.readFile(path.join(repoPath, ".opencode/commands/acme.md"), "utf8")).toBe(
      "local edit\n",
    );
    expect(report.changed?.written).toEqual([]);
  });

  test("a tracked file identical to the companion file stays repository-owned", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(repoPath, ".opencode/commands/acme.md", "acme\n");
    execFileSync("git", ["add", "."], { cwd: repoPath });
    await put(companionPath, ".opencode/commands/acme.md", "acme\n");

    const report = await reconcileCompanionCopies(repoPath, companionPath);

    expect(copies(await readManifest(repoPath))).toEqual({});
    expect((report.warnings ?? []).join("\n")).toContain("shadow");
  });
});

/** Stands in for any failure between two copies: a directory nothing may write into. */
async function readOnlyDirectory(repoPath: string, rel: string): Promise<() => Promise<void>> {
  const dir = path.join(repoPath, rel);
  await fs.mkdir(dir, { recursive: true });
  await fs.chmod(dir, 0o555);
  return () => fs.chmod(dir, 0o755);
}

describe("an interrupted reconcile", () => {
  test("leaves every copy already written recorded and covered by its exclude line", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(companionPath, ".opencode/commands/acme.md", "acme\n");
    await put(companionPath, ".opencode/skills/acme.md", "skill\n");
    const restore = await readOnlyDirectory(repoPath, ".opencode/skills");

    try {
      await expect(reconcileCompanionCopies(repoPath, companionPath)).rejects.toThrow();

      expect(await exists(path.join(repoPath, ".opencode", "commands", "acme.md"))).toBe(true);
      expect(Object.keys(copies(await readManifest(repoPath), "opencode"))).toContain(
        ".opencode/commands/acme.md",
      );
      expect(await exclude(repoPath)).toContain("/.opencode/commands/acme.md");
      expect(gitStatus(repoPath)).not.toContain("acme.md");
    } finally {
      await restore();
    }
    const report = await reconcileCompanionCopies(repoPath, companionPath);
    expect(report.warnings ?? []).toEqual([]);
    expect(report.changed?.written).toEqual([".opencode/skills/acme.md"]);
  });

  test("keeps a withdrawn copy's exclude line until the copy is gone", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(companionPath, ".opencode/commands/acme.md", "acme\n");
    await reconcileCompanionCopies(repoPath, companionPath);
    await fs.chmod(path.join(repoPath, ".opencode", "commands"), 0o555);

    try {
      await expect(removeCompanionCopies(repoPath)).rejects.toThrow();

      expect(await exists(path.join(repoPath, ".opencode", "commands", "acme.md"))).toBe(true);
      expect(gitStatus(repoPath)).not.toContain("acme.md");
    } finally {
      await fs.chmod(path.join(repoPath, ".opencode", "commands"), 0o755);
    }
  });
});

describe("withdrawing the copies", () => {
  test("removes owned copies, their excludes and emptied directories only", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(companionPath, ".opencode/commands/acme.md", "acme\n");
    await put(companionPath, ".opencode/agents/acme.md", "agent\n");
    await put(repoPath, ".opencode/commands/own.md", "repo\n");
    await reconcileCompanionCopies(repoPath, companionPath);

    expect(await removeCompanionCopies(repoPath)).toBe("removed");

    expect(await exists(path.join(repoPath, ".opencode", "commands", "acme.md"))).toBe(false);
    expect(await exists(path.join(repoPath, ".opencode", "agents"))).toBe(false);
    expect(await fs.readFile(path.join(repoPath, ".opencode/commands/own.md"), "utf8")).toBe(
      "repo\n",
    );
    expect(await exclude(repoPath)).not.toContain("acme.md");
    expect(copies(await readManifest(repoPath))).toEqual({});
    expect(await removeCompanionCopies(repoPath)).toBe("absent");
  });
});

describe("unwrapping and cleanup reach the copies", () => {
  test("unwrap withdraws the copies and reports them", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(companionPath, ".opencode/commands/acme.md", "acme\n");
    await reconcileCompanionCopies(repoPath, companionPath);

    const result = await unwrapWorkingRuntimeDocuments(repoPath);

    expect(result).toMatchObject({ kind: "unwrapped", copies: [".opencode/commands/acme.md"] });
    expect(await exists(path.join(repoPath, ".opencode"))).toBe(false);
  });

  test("working cleanup withdraws the copies", async () => {
    const { companionPath, repoPath } = await fixture();
    await put(companionPath, ".opencode/commands/acme.md", "acme\n");
    await reconcileCompanionCopies(repoPath, companionPath);

    const result = await unproject({ repoPath });

    expect(result.outcomes.find((o) => o.id === "opencode-companion-copies")?.state).toBe(
      "removed",
    );
    expect(await exists(path.join(repoPath, ".opencode", "commands", "acme.md"))).toBe(false);
  });
});

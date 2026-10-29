import { afterEach, describe, expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { addWorktree, git, initRepo } from "../../../test/git-checkouts";
import { createTempDir } from "../../../../../test/fixtures";
import {
  addExcludeLine,
  editExcludeFile,
  ensureWorkingRepoLocalExcludes,
  reconcileWorkingRepoCopyExcludes,
  removeWorkingRepoLocalExcludes,
} from "./working-repo-local-state";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const noNeeds = async () => [];

async function makeRepo(prefix: string): Promise<string> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(repoPath);
  await execFileAsync("git", ["init", "-q", repoPath]);
  return repoPath;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("working repository local excludes", () => {
  test("reconciles one root-anchored managed block and migrates legacy entries", async () => {
    const repoPath = await makeRepo("mate-working-excludes-");
    const excludePath = path.join(repoPath, ".git", "info", "exclude");
    await fs.writeFile(
      excludePath,
      ["# user rule", "*.local", ".mate/", ".claude/settings.local.json", ""].join("\n"),
      "utf8",
    );

    await ensureWorkingRepoLocalExcludes(repoPath);
    const first = await fs.readFile(excludePath, "utf8");
    await ensureWorkingRepoLocalExcludes(repoPath);
    const second = await fs.readFile(excludePath, "utf8");

    expect(second).toBe(first);
    expect(first).toContain("# user rule\n*.local\n");
    expect(first).not.toContain(".claude/settings.local.json");
    expect(first.match(/# mate managed: start/g)).toHaveLength(1);
    expect(first.match(/# mate managed: end/g)).toHaveLength(1);
    for (const entry of ["/.mate/", "/.claude/", "/.opencode/opencode.json", "/.agents/"]) {
      expect(first.split("\n").filter((line) => line === entry)).toHaveLength(1);
    }
  });

  test("keeps the repository's own .opencode files visible to Git", async () => {
    const repoPath = await makeRepo("mate-working-excludes-opencode-");
    await ensureWorkingRepoLocalExcludes(repoPath);
    await fs.mkdir(path.join(repoPath, ".opencode", "commands"), { recursive: true });
    await fs.writeFile(path.join(repoPath, ".opencode", "commands", "acme.md"), "acme\n");
    await fs.writeFile(path.join(repoPath, ".opencode", "opencode.json"), "{}\n");

    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoPath,
      encoding: "utf8",
    });
    expect(status).toContain(".opencode/commands/acme.md");
    expect(status).not.toContain("opencode.json");
  });

  test("leaves a block that follows the managed one where it is", async () => {
    const repoPath = await makeRepo("mate-working-excludes-order-");
    await ensureWorkingRepoLocalExcludes(repoPath);
    await reconcileWorkingRepoCopyExcludes(repoPath, [".opencode/commands/acme.md"], noNeeds);

    expect(await ensureWorkingRepoLocalExcludes(repoPath)).toBe(false);
    expect(
      (await reconcileWorkingRepoCopyExcludes(repoPath, [".opencode/commands/acme.md"], noNeeds))
        .changed,
    ).toBe(false);
  });

  test("preserves equivalent user rules outside the managed block", async () => {
    const repoPath = await makeRepo("mate-working-user-excludes-");
    const excludePath = path.join(repoPath, ".git", "info", "exclude");
    await fs.writeFile(excludePath, "/.claude/\n", "utf8");

    await ensureWorkingRepoLocalExcludes(repoPath);
    await removeWorkingRepoLocalExcludes(repoPath);

    expect(await fs.readFile(excludePath, "utf8")).toBe("/.claude/\n");
  });

  test("a .git file naming a Git folder of its own uses that folder's exclude file", async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mate-working-worktree-"));
    tempRoots.push(repoPath);
    const gitDir = path.join(repoPath, ".worktrees", "repo-git");
    await fs.mkdir(path.join(gitDir, "info"), { recursive: true });
    await fs.writeFile(path.join(repoPath, ".git"), "gitdir: .worktrees/repo-git\n", "utf8");

    await ensureWorkingRepoLocalExcludes(repoPath);
    const excludePath = path.join(gitDir, "info", "exclude");
    expect(await fs.readFile(excludePath, "utf8")).toContain("/.agents/");

    await removeWorkingRepoLocalExcludes(repoPath);
    expect(await fs.readFile(excludePath, "utf8")).toBe("");
  });

  test("a linked worktree writes the shared exclude file, never its private one", async () => {
    const root = await createTempDir("mate-working-linked-");
    tempRoots.push(root);
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-feature"));
    const privateExclude = path.join(main, ".git", "worktrees", "acme-feature", "info", "exclude");
    await fs.mkdir(path.dirname(privateExclude), { recursive: true });
    await fs.writeFile(privateExclude, "# mate managed: start\n/.mate/\n# mate managed: end\n");

    await ensureWorkingRepoLocalExcludes(worktree);
    await fs.mkdir(path.join(worktree, ".mate"));

    expect(await fs.readFile(path.join(main, ".git", "info", "exclude"), "utf8")).toContain(
      "/.agents/",
    );
    expect(git(worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");

    await removeWorkingRepoLocalExcludes(worktree);
    expect(await fs.readFile(privateExclude, "utf8")).toBe(
      "# mate managed: start\n/.mate/\n# mate managed: end\n",
    );
  });

  test("root patterns ignore untracked root state without hiding nested or tracked files", async () => {
    const repoPath = await makeRepo("mate-working-root-patterns-");
    await ensureWorkingRepoLocalExcludes(repoPath);
    await fs.mkdir(path.join(repoPath, ".claude"), { recursive: true });
    await fs.writeFile(path.join(repoPath, ".claude", "tracked.json"), "{}\n", "utf8");
    await execFileAsync("git", ["-C", repoPath, "add", "-f", ".claude/tracked.json"]);
    await fs.writeFile(path.join(repoPath, ".claude", "local.json"), "{}\n", "utf8");
    await fs.mkdir(path.join(repoPath, "fixtures", ".claude"), { recursive: true });
    await fs.writeFile(path.join(repoPath, "fixtures", ".claude", "visible.json"), "{}\n", "utf8");

    const tracked = await execFileAsync("git", [
      "-C",
      repoPath,
      "ls-files",
      ".claude/tracked.json",
    ]);
    const ignored = await execFileAsync("git", [
      "-C",
      repoPath,
      "check-ignore",
      ".claude/local.json",
    ]);
    const nested = await execFileAsync("git", [
      "-C",
      repoPath,
      "ls-files",
      "--others",
      "--exclude-standard",
      "fixtures/.claude/visible.json",
    ]);

    expect(tracked.stdout.trim()).toBe(".claude/tracked.json");
    expect(ignored.stdout.trim()).toBe(".claude/local.json");
    expect(nested.stdout.trim()).toBe("fixtures/.claude/visible.json");
  });
});

describe("the exclude-file writer", () => {
  async function makeClone(): Promise<{ main: string; worktree: string; excludePath: string }> {
    const root = await createTempDir("mate-exclude-writer-");
    tempRoots.push(root);
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-feature"));
    return { main, worktree, excludePath: path.join(main, ".git", "info", "exclude") };
  }

  test("parallel edits from two Checkouts of one clone keep every line", async () => {
    const { main, worktree, excludePath } = await makeClone();
    const entries = Array.from({ length: 8 }, (_, index) => `/acme-${index}/`);

    await Promise.all(
      entries.map((entry, index) => addExcludeLine(index % 2 === 0 ? main : worktree, entry)),
    );

    const lines = (await fs.readFile(excludePath, "utf8")).split("\n");
    for (const entry of entries) expect(lines).toContain(entry);
  });

  test("lines the edit does not touch stay byte-identical", async () => {
    const { main, excludePath } = await makeClone();
    const user = "# acme rules\r\n  *.indented\n\n*.log\n\n";
    await fs.writeFile(excludePath, user, "utf8");

    expect(await addExcludeLine(main, "/acme/")).toBe(true);
    expect(await addExcludeLine(main, "/acme/")).toBe(false);

    expect(await fs.readFile(excludePath, "utf8")).toBe(`${user}/acme/\n`);
  });

  test("a failed write leaves the previous file", async () => {
    const { main, excludePath } = await makeClone();
    await fs.writeFile(excludePath, "*.log\n", "utf8");
    await fs.chmod(path.dirname(excludePath), 0o555);

    try {
      await expect(editExcludeFile(main, (lines) => [...lines, "/acme/"])).rejects.toThrow();
    } finally {
      await fs.chmod(path.dirname(excludePath), 0o755);
    }
    expect(await fs.readFile(excludePath, "utf8")).toBe("*.log\n");
  });
  test("a file it cannot read fails the edit and keeps its lines", async () => {
    const { main, excludePath } = await makeClone();
    await fs.writeFile(excludePath, "*.log\n", "utf8");
    await fs.chmod(excludePath, 0o000);

    try {
      await expect(addExcludeLine(main, "/acme/")).rejects.toThrow();
    } finally {
      await fs.chmod(excludePath, 0o644);
    }
    expect(await fs.readFile(excludePath, "utf8")).toBe("*.log\n");
  });

  test("a read-only file is refused", async () => {
    const { main, excludePath } = await makeClone();
    await fs.writeFile(excludePath, "*.log\n", "utf8");
    await fs.chmod(excludePath, 0o444);

    try {
      await expect(addExcludeLine(main, "/acme/")).rejects.toThrow();
      expect(await fs.readFile(excludePath, "utf8")).toBe("*.log\n");
    } finally {
      await fs.chmod(excludePath, 0o644);
    }
  });

  test("a symlinked file stays a link, and its target keeps its mode", async () => {
    const { main, excludePath } = await makeClone();
    const target = path.join(path.dirname(main), "acme-exclude");
    await fs.writeFile(target, "*.log\n", { encoding: "utf8", mode: 0o600 });
    await fs.chmod(target, 0o600);
    await fs.rm(excludePath, { force: true });
    await fs.symlink(target, excludePath);

    expect(await addExcludeLine(main, "/acme/")).toBe(true);

    expect((await fs.lstat(excludePath)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("*.log\n/acme/\n");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });
});

describe("removals that another Checkout still needs", () => {
  async function makeClone() {
    const root = await createTempDir("mate-exclude-keep-");
    tempRoots.push(root);
    const main = initRepo(path.join(root, "acme"));
    const first = addWorktree(main, path.join(root, "acme-a"));
    const second = addWorktree(main, path.join(root, "acme-b"));
    return { main, first, second, excludePath: path.join(main, ".git", "info", "exclude") };
  }

  const dropAcmeLines = (lines: string[], keep: ReadonlySet<string>) =>
    lines.filter((line) => keep.has(line) || !line.startsWith("/acme-"));

  test("asks each other Checkout and keeps only the lines they need", async () => {
    const { main, first, second, excludePath } = await makeClone();
    await fs.writeFile(excludePath, "*.log\n/acme-a/\n/acme-b/\n", "utf8");
    const asked: string[] = [];

    const result = await editExcludeFile(main, dropAcmeLines, async (checkout) => {
      asked.push(checkout);
      return checkout === first ? ["/acme-a/", "/acme-unrelated/"] : [];
    });

    expect(asked.toSorted()).toEqual([first, second].toSorted());
    expect(result).toEqual({ changed: true, kept: ["/acme-a/"], keptFor: [first] });
    expect(await fs.readFile(excludePath, "utf8")).toBe("*.log\n/acme-a/\n");
  });

  test("the managed block stays while another Checkout has a Projection Root", async () => {
    const { main, first, excludePath } = await makeClone();
    const before = await fs.readFile(excludePath, "utf8");
    await ensureWorkingRepoLocalExcludes(main);
    await fs.mkdir(path.join(first, ".mate"));

    const kept = await removeWorkingRepoLocalExcludes(main);

    expect(kept.keptFor).toEqual([first]);
    expect(await fs.readFile(excludePath, "utf8")).toContain("# mate managed: start");

    await fs.rm(path.join(first, ".mate"), { recursive: true });
    const removed = await removeWorkingRepoLocalExcludes(main);

    expect(removed).toEqual({ changed: true, kept: [], keptFor: [] });
    expect(await fs.readFile(excludePath, "utf8")).toBe(before);
  });

  test("an edit that removes nothing never asks another Checkout", async () => {
    const { main, excludePath } = await makeClone();
    await fs.writeFile(excludePath, "*.log\n", "utf8");
    let asked = false;

    const result = await editExcludeFile(
      main,
      (lines) => [...lines, "/acme-a/"],
      async () => {
        asked = true;
        return [];
      },
    );

    expect(asked).toBe(false);
    expect(result).toEqual({ changed: true, kept: [], keptFor: [] });
  });

  test("legacy lines stay while another Checkout has a Projection Root and no block", async () => {
    const { main, first, excludePath } = await makeClone();
    await fs.writeFile(excludePath, "*.log\n.mate/\n", "utf8");
    await fs.mkdir(path.join(first, ".mate"));

    const kept = await removeWorkingRepoLocalExcludes(main);

    expect(kept).toEqual({ changed: false, kept: [".mate/"], keptFor: [first] });
    expect(await fs.readFile(excludePath, "utf8")).toBe("*.log\n.mate/\n");
  });

  test("legacy lines beside a kept block still go", async () => {
    const { main, first, excludePath } = await makeClone();
    await ensureWorkingRepoLocalExcludes(main);
    await fs.appendFile(excludePath, ".mate/\n", "utf8");
    await fs.mkdir(path.join(first, ".mate"));

    const kept = await removeWorkingRepoLocalExcludes(main);

    expect(kept.kept).not.toContain(".mate/");
    const lines = (await fs.readFile(excludePath, "utf8")).split("\n");
    expect(lines).toContain("# mate managed: start");
    expect(lines).not.toContain(".mate/");
  });

  test("a locked worktree whose folder is away keeps every line", async () => {
    const { main, first, second, excludePath } = await makeClone();
    await ensureWorkingRepoLocalExcludes(main);
    git(main, "worktree", "lock", first);
    await fs.rm(first, { recursive: true, force: true });

    const kept = await removeWorkingRepoLocalExcludes(main);

    expect(kept.keptFor).toEqual([first]);
    expect(kept.keptFor).not.toContain(second);
    expect(await fs.readFile(excludePath, "utf8")).toContain("# mate managed: start");
  });

  test("a Checkout whose state cannot be read keeps every line", async () => {
    const { main, first, excludePath } = await makeClone();
    await fs.writeFile(excludePath, "*.log\n/acme-a/\n/acme-b/\n", "utf8");

    const result = await editExcludeFile(main, dropAcmeLines, async (checkout) => {
      if (checkout === first)
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return [];
    });

    expect(result).toEqual({ changed: false, kept: ["/acme-a/", "/acme-b/"], keptFor: [first] });
    expect(await fs.readFile(excludePath, "utf8")).toBe("*.log\n/acme-a/\n/acme-b/\n");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { promisify } from "node:util";

import {
  collectMarkdownTree,
  createVaultManager,
  resolveVaultPath,
  versionToken,
  type VaultGitRunner,
  type VaultTreeNode,
  type VaultWatcher,
} from "./vault";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-vault-"));
  roots.push(root);
  return root;
}

function flatten(nodes: VaultTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "file" ? [node.path.split(path.sep).join("/")] : flatten(node.children ?? []),
  );
}

async function markdownPaths(root: string): Promise<string[]> {
  return flatten(await collectMarkdownTree(root)).sort();
}

function countingGit(): { git: VaultGitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: VaultGitRunner = async (args, input) => {
    calls.push(args);
    const result = spawnSync("git", args, { input: input ?? "", encoding: "utf8" });
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
  return { git, calls };
}

type Listener = (event: string, filename: string | Buffer | null) => void;

function recordingWatch(fail?: (directory: string) => boolean) {
  const listeners = new Map<string, Listener>();
  const open = new Set<string>();
  const watch = (directory: string, listener: Listener): VaultWatcher => {
    if (fail?.(directory))
      throw new Error("ENOSPC: System limit for number of file watchers reached");
    listeners.set(directory, listener);
    open.add(directory);
    return {
      close() {
        open.delete(directory);
      },
    };
  };
  return { watch, listeners, open };
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function gitFixture(): Promise<string> {
  const root = await fs.realpath(await fixture());
  await execFile("git", ["-C", root, "init", "--quiet"]);
  return root;
}

async function writeMany(directory: string, count: number): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  for (let start = 0; start < count; start += 500) {
    await Promise.all(
      Array.from({ length: Math.min(500, count - start) }, (_unused, offset) =>
        fs.writeFile(path.join(directory, `file-${start + offset}.md`), "x"),
      ),
    );
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("resolveVaultPath", () => {
  test("rejects traversal, absolute paths, escaping links, and non-markdown paths", async () => {
    const root = await fixture();
    const outside = await fixture();
    await fs.writeFile(path.join(root, "note.md"), "note");
    await fs.writeFile(path.join(outside, "outside.md"), "outside");
    await fs.symlink(path.join(outside, "outside.md"), path.join(root, "link.md"));

    await expect(resolveVaultPath(root, "../outside.md")).rejects.toThrow();
    await expect(resolveVaultPath(root, path.join(root, "note.md"))).rejects.toThrow();
    await expect(resolveVaultPath(root, "link.md")).rejects.toThrow();
    await expect(resolveVaultPath(root, "note.txt")).rejects.toThrow();
    await expect(resolveVaultPath(path.join(root, "missing"), "note.md")).rejects.toThrow();
  });

  test("resolves missing markdown below an existing root for creation", async () => {
    const root = await fixture();
    await expect(resolveVaultPath(root, "docs/new.md")).resolves.toMatchObject({
      relative: "docs/new.md",
    });
  });
});

describe("markdown tree and tokens", () => {
  test("lists root, docs, and openspec markdown but not ignored or git internals", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    await fs.mkdir(path.join(root, "ignored"), { recursive: true });
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, "README.md"), "readme");
    await fs.writeFile(path.join(root, "docs", "notes.md"), "notes");
    await fs.writeFile(path.join(root, "openspec", "spec.md"), "spec");
    await fs.writeFile(path.join(root, "ignored", "secret.md"), "secret");
    await fs.writeFile(path.join(root, ".git", "internal.md"), "internal");
    await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n");
    await execFile("git", ["-C", root, "init", "--quiet"]);

    const tree = await collectMarkdownTree(root);
    const paths = JSON.stringify(tree);
    expect(paths).toContain("README.md");
    expect(paths).toContain("docs");
    expect(paths).toContain("openspec");
    expect(paths).not.toContain("secret.md");
    expect(paths).not.toContain("internal.md");
  });

  test("lists tracked and untracked markdown, never ignored, git internals, or escaping links", async () => {
    const root = await fixture();
    const outside = await fixture();
    await execFile("git", ["-C", root, "init", "--quiet"]);
    await fs.mkdir(path.join(root, "docs", "deep"), { recursive: true });
    await fs.mkdir(path.join(root, "ignored"), { recursive: true });
    await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n*.local.md\n");
    await fs.writeFile(path.join(root, "tracked.md"), "tracked");
    await fs.writeFile(path.join(root, "docs", "deep", "untracked.md"), "untracked");
    await fs.writeFile(path.join(root, "ignored", "secret.md"), "secret");
    await fs.writeFile(path.join(root, "draft.local.md"), "draft");
    await fs.writeFile(path.join(root, "forced.local.md"), "forced");
    await fs.writeFile(path.join(root, ".git", "internal.md"), "internal");
    await fs.writeFile(path.join(root, "notes.txt"), "not markdown");
    await fs.writeFile(path.join(outside, "outside.md"), "outside");
    await fs.symlink(path.join(outside, "outside.md"), path.join(root, "escape.md"));
    await fs.symlink(outside, path.join(root, "escape-dir"));
    await fs.writeFile(path.join(root, "gone.md"), "gone");
    await execFile("git", ["-C", root, "add", "tracked.md", "gone.md", ".gitignore"]);
    await execFile("git", ["-C", root, "add", "--force", "forced.local.md"]);
    await fs.unlink(path.join(root, "gone.md"));

    expect(await markdownPaths(root)).toEqual(["docs/deep/untracked.md", "tracked.md"]);
  });

  test("lists a companion that is not a git checkout", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, "README.md"), "readme");
    await fs.writeFile(path.join(root, "docs", "notes.md"), "notes");
    await fs.writeFile(path.join(root, ".git", "internal.md"), "internal");

    expect(await markdownPaths(root)).toEqual(["README.md", "docs/notes.md"]);
  });

  test("reports a failing ls-files in a git checkout instead of walking", async () => {
    const root = await gitFixture();
    await fs.writeFile(path.join(root, "note.md"), "note");
    let walked = false;
    const git: VaultGitRunner = async () => ({
      code: 128,
      stdout: "",
      stderr: "fatal: detected dubious ownership in repository",
    });
    await expect(
      collectMarkdownTree(root, {
        git,
        fs: {
          readdir: async () => {
            walked = true;
            return [];
          },
        },
      }),
    ).rejects.toThrow("git ls-files failed: fatal: detected dubious ownership");
    expect(walked).toBe(false);
  });

  test("starts at most two git processes and never stats ignored content", async () => {
    for (const count of [10, 10_000]) {
      const root = await gitFixture();
      await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n");
      await fs.writeFile(path.join(root, "README.md"), "readme");
      await writeMany(path.join(root, "node_modules", "pkg"), count);
      const { git, calls } = countingGit();
      const touched: string[] = [];
      const tree = await collectMarkdownTree(root, {
        git,
        fs: {
          realpath: async (target) => {
            touched.push(target);
            return fs.realpath(target);
          },
          stat: async (target) => {
            touched.push(target);
            return fs.stat(target);
          },
        },
      });
      expect(flatten(tree)).toEqual(["README.md"]);
      expect(calls.length).toBeLessThanOrEqual(2);
      expect(touched.filter((target) => target.includes("node_modules"))).toEqual([]);
    }
  }, 30_000);

  test("lists a submodule as one entry and does not descend into it", async () => {
    const root = await gitFixture();
    await fs.writeFile(path.join(root, "README.md"), "readme");
    await fs.mkdir(path.join(root, "sub"));
    await execFile("git", ["-C", path.join(root, "sub"), "init", "--quiet"]);
    await fs.writeFile(path.join(root, "sub", "inner.md"), "inner");
    await execFile("git", [
      "-C",
      root,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"1".repeat(40)},sub`,
    ]);

    expect(await markdownPaths(root)).toEqual(["README.md"]);
  });

  test("changes with content and remains stable for unchanged content", () => {
    expect(versionToken("same")).toBe(versionToken("same"));
    expect(versionToken("same")).not.toBe(versionToken("changed"));
  });
});

describe("vault manager", () => {
  test("caches and refreshes trees, creates files, and serializes saves", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "note.md"), "one");
    let walks = 0;
    const watcher = () => ({ close() {} });
    const manager = createVaultManager({ watch: watcher });
    const first = await manager.tree(root);
    walks += first.tree.length;
    const second = await manager.tree(root);
    expect(second.tree).toEqual(first.tree);
    const opened = await manager.open(root, "note.md");
    const saved = await manager.save(root, "note.md", "two", opened.token);
    expect(saved.kind).toBe("saved");
    expect(await fs.readFile(path.join(root, "note.md"), "utf8")).toBe("two");
    const created = await manager.save(root, "docs/new.md", "new");
    expect(created.kind).toBe("saved");
    expect(JSON.stringify((await manager.tree(root)).tree)).toContain("new.md");
    expect(walks).toBe(1);
    const token = (await manager.open(root, "note.md")).token;
    const results = await Promise.all([
      manager.save(root, "note.md", "three", token),
      manager.save(root, "note.md", "four", token),
    ]);
    expect(results.map((result) => result.kind)).toEqual(["saved", "conflict"]);
    manager.stop();
  });

  test("invalidates the tree for external additions and removals", async () => {
    const root = await fixture();
    let listener: ((event: string, filename: string | Buffer | null) => void) | undefined;
    const manager = createVaultManager({
      watch: (_root, next) => {
        listener = next;
        return { close() {} };
      },
    });
    await manager.tree(root);
    await fs.writeFile(path.join(root, "added.md"), "added");
    listener?.("rename", "added.md");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(JSON.stringify((await manager.tree(root)).tree)).toContain("added.md");
    await fs.unlink(path.join(root, "added.md"));
    listener?.("rename", "added.md");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(JSON.stringify((await manager.tree(root)).tree)).not.toContain("added.md");
    manager.stop();
  });

  test("reports an explicit refresh path when watching is unavailable", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "note.md"), "note");
    const manager = createVaultManager({
      watch: () => {
        throw new Error("watch unavailable");
      },
    });
    const result = await manager.tree(root);
    expect(result.tree).toHaveLength(1);
    expect(result.watching).toBe(false);
    expect(result.warning).toContain("Live updates are unavailable");
    expect((await manager.refresh(root)).tree).toHaveLength(1);
    manager.stop();
  });

  test("watches listed directories and their ancestors, never ignored ones", async () => {
    const root = await gitFixture();
    await fs.writeFile(path.join(root, ".gitignore"), ".mate/plugins/.local/\n");
    await fs.mkdir(path.join(root, "docs", "a"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "a", "b.md"), "b");
    await fs.mkdir(path.join(root, ".mate"));
    await fs.writeFile(path.join(root, ".mate", "notes.md"), "notes");
    await writeMany(path.join(root, ".mate", "plugins", ".local", "node_modules", "pkg"), 50);
    const recorder = recordingWatch();
    const manager = createVaultManager({ watch: recorder.watch });
    await manager.tree(root);
    await settle();
    expect([...recorder.open].sort()).toEqual(
      [
        root,
        path.join(root, ".mate"),
        path.join(root, "docs"),
        path.join(root, "docs", "a"),
      ].sort(),
    );
    manager.stop();
    expect(recorder.open.size).toBe(0);
  });

  test("answers an unchanged tree without git and relists after a change", async () => {
    const root = await gitFixture();
    await fs.mkdir(path.join(root, "docs"));
    await fs.writeFile(path.join(root, "docs", "note.md"), "note");
    const { git, calls } = countingGit();
    const recorder = recordingWatch();
    const manager = createVaultManager({ git, watch: recorder.watch });
    await manager.tree(root);
    await settle();
    const afterFirst = calls.length;
    await manager.tree(root);
    expect(calls.length).toBe(afterFirst);

    await fs.writeFile(path.join(root, "docs", "added.md"), "added");
    recorder.listeners.get(path.join(root, "docs"))?.("rename", "added.md");
    await settle(50);
    expect(flatten((await manager.tree(root)).tree)).toContain("docs/added.md");

    await fs.unlink(path.join(root, "docs", "added.md"));
    recorder.listeners.get(path.join(root, "docs"))?.("rename", "added.md");
    await settle(50);
    expect(flatten((await manager.tree(root)).tree)).not.toContain("docs/added.md");

    await fs.mkdir(path.join(root, "docs", "fresh"));
    await fs.writeFile(path.join(root, "docs", "fresh", "new.md"), "new");
    recorder.listeners.get(path.join(root, "docs"))?.("rename", "fresh");
    await settle(50);
    expect(flatten((await manager.tree(root)).tree)).toContain("docs/fresh/new.md");
    await settle();
    expect(recorder.open.has(path.join(root, "docs", "fresh"))).toBe(true);
    manager.stop();
  });

  test("watches a new empty directory at once, but not a new ignored one", async () => {
    const root = await gitFixture();
    await fs.writeFile(path.join(root, ".gitignore"), "build/\n");
    await fs.writeFile(path.join(root, "README.md"), "readme");
    const recorder = recordingWatch();
    const manager = createVaultManager({ watch: recorder.watch });
    await manager.tree(root);
    await settle();

    await fs.mkdir(path.join(root, "fresh", "deeper"), { recursive: true });
    await fs.mkdir(path.join(root, "build", "out"), { recursive: true });
    recorder.listeners.get(root)?.("rename", "fresh");
    recorder.listeners.get(root)?.("rename", "build");
    await settle(100);
    expect(recorder.open.has(path.join(root, "fresh", "deeper"))).toBe(true);
    expect([...recorder.open].filter((directory) => directory.includes("build"))).toEqual([]);

    await fs.writeFile(path.join(root, "fresh", "deeper", "note.md"), "note");
    recorder.listeners.get(path.join(root, "fresh", "deeper"))?.("rename", "note.md");
    await settle(50);
    expect(flatten((await manager.tree(root)).tree)).toContain("fresh/deeper/note.md");
    await settle();
    expect(recorder.open.has(path.join(root, "fresh", "deeper"))).toBe(true);
    manager.stop();
  });

  test("delivers outside writes and removals through directory watchers", async () => {
    const root = await gitFixture();
    await fs.mkdir(path.join(root, "docs"));
    await fs.writeFile(path.join(root, "docs", "note.md"), "one");
    const recorder = recordingWatch();
    const manager = createVaultManager({ watch: recorder.watch });
    await manager.tree(root);
    await manager.open(root, "docs/note.md");
    await settle();
    const events: { kind: string; content?: string; token?: string }[] = [];
    const unsubscribe = manager.subscribe(root, path.join("docs", "note.md"), (event) =>
      events.push(event),
    );
    await settle();

    await fs.writeFile(path.join(root, "docs", "note.md"), "outside");
    recorder.listeners.get(path.join(root, "docs"))?.("change", "note.md");
    await settle(100);
    expect(events.at(-1)).toMatchObject({
      kind: "changed",
      content: "outside",
      token: versionToken("outside"),
    });

    await fs.unlink(path.join(root, "docs", "note.md"));
    recorder.listeners.get(path.join(root, "docs"))?.("rename", "note.md");
    await settle(100);
    expect(events.at(-1)).toMatchObject({ kind: "removed" });

    unsubscribe();
    manager.stop();
    expect(recorder.open.size).toBe(0);
  });

  test("falls back to an explicit refresh when a directory cannot be watched", async () => {
    const root = await gitFixture();
    await fs.mkdir(path.join(root, "docs"));
    await fs.writeFile(path.join(root, "docs", "note.md"), "note");
    const recorder = recordingWatch((directory) => directory !== root);
    const manager = createVaultManager({ watch: recorder.watch });
    await manager.tree(root);
    await settle();
    const result = await manager.tree(root);
    expect(result.watching).toBe(false);
    expect(result.warning).toContain("Live updates are unavailable");
    expect(recorder.open.size).toBe(0);
    await fs.writeFile(path.join(root, "docs", "later.md"), "later");
    expect(flatten((await manager.refresh(root)).tree)).toContain("docs/later.md");
    manager.stop();
  });

  test("refuses stale content and reports an observed overwritten version", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "note.md"), "one");
    let listener: ((event: string, filename: string | Buffer | null) => void) | undefined;
    const manager = createVaultManager({
      watch: (_root, next) => {
        listener = next;
        return { close() {} };
      },
      beforeWrite: async (file) => {
        await fs.writeFile(file, "agent");
        listener?.("change", "note.md");
      },
    });
    const opened = await manager.open(root, "note.md");
    await fs.writeFile(path.join(root, "note.md"), "outside");
    const conflict = await manager.save(root, "note.md", "human", opened.token);
    expect(conflict).toMatchObject({ kind: "conflict", content: "outside" });

    const current = await manager.open(root, "note.md");
    const events: unknown[] = [];
    const unsubscribe = manager.subscribe(root, "note.md", (event) => events.push(event));
    const saved = await manager.save(root, "note.md", "human", current.token);
    expect(saved.kind).toBe("saved");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "overwritten", content: "agent" })]),
    );
    expect(manager.getRecovery(root, "note.md")).toMatchObject({ recoveredContent: "agent" });
    unsubscribe();
    manager.stop();
  });

  test("refuses creation when a file appears before the atomic link", async () => {
    const root = await fixture();
    let started = false;
    const manager = createVaultManager({
      watch: () => ({ close() {} }),
      beforeWrite: async (file) => {
        if (!started) {
          started = true;
          await fs.writeFile(file, "other");
        }
      },
    });
    const result = await manager.save(root, "new.md", "human");
    expect(result).toMatchObject({ kind: "conflict", content: "other" });
    expect(await fs.readFile(path.join(root, "new.md"), "utf8")).toBe("other");
    manager.stop();
  });
});

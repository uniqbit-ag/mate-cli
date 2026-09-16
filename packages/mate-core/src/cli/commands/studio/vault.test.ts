import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { collectMarkdownTree, createVaultManager, resolveVaultPath, versionToken } from "./vault";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-vault-"));
  roots.push(root);
  return root;
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

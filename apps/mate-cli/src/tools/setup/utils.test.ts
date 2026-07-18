import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { isCommandOnPath, mergeDir, pruneEmptyAncestors } from "./utils";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("mergeDir", () => {
  test("copies all files from src into dest", async () => {
    const root = await makeTempDir("mate-mergeDir-basic-");
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");

    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "a.txt"), "aaa", "utf8");
    await fs.writeFile(path.join(src, "b.txt"), "bbb", "utf8");

    await mergeDir(src, dest);

    expect(await fs.readFile(path.join(dest, "a.txt"), "utf8")).toBe("aaa");
    expect(await fs.readFile(path.join(dest, "b.txt"), "utf8")).toBe("bbb");
  });

  test("overwrites existing files in dest with src content", async () => {
    const root = await makeTempDir("mate-mergeDir-overwrite-");
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");

    await fs.mkdir(src);
    await fs.mkdir(dest);
    await fs.writeFile(path.join(src, "x.txt"), "new", "utf8");
    await fs.writeFile(path.join(dest, "x.txt"), "old", "utf8");

    await mergeDir(src, dest);

    expect(await fs.readFile(path.join(dest, "x.txt"), "utf8")).toBe("new");
  });

  test("preserves existing files in dest that are not in src", async () => {
    const root = await makeTempDir("mate-mergeDir-preserve-");
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");

    await fs.mkdir(src);
    await fs.mkdir(dest);
    await fs.writeFile(path.join(src, "a.txt"), "from-src", "utf8");
    await fs.writeFile(path.join(dest, "user.txt"), "user-file", "utf8");

    await mergeDir(src, dest);

    expect(await fs.readFile(path.join(dest, "user.txt"), "utf8")).toBe("user-file");
  });

  test("recursively copies nested directories", async () => {
    const root = await makeTempDir("mate-mergeDir-nested-");
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");

    await fs.mkdir(path.join(src, "sub"), { recursive: true });
    await fs.writeFile(path.join(src, "sub", "file.txt"), "nested", "utf8");

    await mergeDir(src, dest);

    expect(await fs.readFile(path.join(dest, "sub", "file.txt"), "utf8")).toBe("nested");
  });

  test("creates dest directory when it does not exist", async () => {
    const root = await makeTempDir("mate-mergeDir-mkdir-");
    const src = path.join(root, "src");
    const dest = path.join(root, "dest-new");

    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "f.txt"), "x", "utf8");

    await mergeDir(src, dest);

    await fs.access(dest);
  });
});

describe("pruneEmptyAncestors", () => {
  test("removes empty directories up to but not including stopAt", async () => {
    const root = await makeTempDir("mate-prune-basic-");

    const dir = path.join(root, "a", "b", "c");
    await fs.mkdir(dir, { recursive: true });

    await pruneEmptyAncestors(dir, root);

    await expect(fs.access(path.join(root, "a"))).rejects.toThrow();
    await fs.access(root);
  });

  test("stops at a non-empty directory", async () => {
    const root = await makeTempDir("mate-prune-stop-");

    const dir = path.join(root, "a", "b", "c");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(root, "a", "keep.txt"), "x", "utf8");

    await pruneEmptyAncestors(dir, root);

    await fs.access(path.join(root, "a"));
    await expect(fs.access(path.join(root, "a", "b"))).rejects.toThrow();
  });

  test("does nothing when dir equals stopAt", async () => {
    const root = await makeTempDir("mate-prune-noop-");

    await pruneEmptyAncestors(root, root);

    await fs.access(root);
  });

  test("does nothing when dir does not exist", async () => {
    const root = await makeTempDir("mate-prune-missing-");

    await pruneEmptyAncestors(path.join(root, "nonexistent"), root);

    await fs.access(root);
  });
});

describe("isCommandOnPath", () => {
  test("returns true when the command executable is on PATH", async () => {
    const root = await makeTempDir("mate-isonpath-found-");
    const binPath = path.join(root, "bin");
    await fs.mkdir(binPath);
    const cmd = path.join(binPath, "my-tool");
    await fs.writeFile(cmd, "#!/bin/sh\n", "utf8");
    await fs.chmod(cmd, 0o755);

    expect(isCommandOnPath("my-tool", binPath)).toBe(true);
  });

  test("returns false when the command is not in any PATH directory", () => {
    expect(isCommandOnPath("definitely-not-a-real-tool-xyz", "/no/such/path")).toBe(false);
  });

  test("returns false for an empty PATH string", () => {
    expect(isCommandOnPath("sh", "")).toBe(false);
  });

  test("returns false when directory exists but file is not executable", async () => {
    const root = await makeTempDir("mate-isonpath-noexec-");
    const binPath = path.join(root, "bin");
    await fs.mkdir(binPath);
    const cmd = path.join(binPath, "no-exec");
    await fs.writeFile(cmd, "#!/bin/sh\n", "utf8");
    await fs.chmod(cmd, 0o644); // readable but not executable

    expect(isCommandOnPath("no-exec", binPath)).toBe(false);
  });
});

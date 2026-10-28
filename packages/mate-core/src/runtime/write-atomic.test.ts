import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { writeAtomic, writeAtomicThroughLink } from "./write-atomic";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const dir of tempRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "write-atomic-"));
  tempRoots.push(dir);
  return dir;
}

describe("writeAtomicThroughLink", () => {
  test("an existing file keeps its mode", async () => {
    const file = path.join(await tempDir(), "AGENTS.md");
    await fs.writeFile(file, "old\n", { mode: 0o600 });
    const previousUmask = process.umask(0o022);
    try {
      await writeAtomicThroughLink(file, "new\n");
    } finally {
      process.umask(previousUmask);
    }

    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(file, "utf8")).toBe("new\n");
  });

  test("a read-only file is refused and left as it was", async () => {
    const file = path.join(await tempDir(), "AGENTS.md");
    await fs.writeFile(file, "old\n", { mode: 0o444 });

    await expect(writeAtomicThroughLink(file, "new\n")).rejects.toMatchObject({ code: "EACCES" });
    expect(await fs.readFile(file, "utf8")).toBe("old\n");
  });

  test("a hardlinked file is written in place, so every link sees the new text", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "AGENTS.md");
    const sibling = path.join(dir, "acme-AGENTS.md");
    await fs.writeFile(file, "old\n");
    await fs.link(file, sibling);

    await writeAtomicThroughLink(file, "new\n");

    expect(await fs.readFile(sibling, "utf8")).toBe("new\n");
    expect((await fs.stat(file)).ino).toBe((await fs.stat(sibling)).ino);
  });

  test("a dangling link stays a link and its target is created", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "target.md");
    const link = path.join(dir, "LINKED.md");
    await fs.symlink("target.md", link);

    await writeAtomicThroughLink(link, "created\n");

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("created\n");
  });

  test("a chain of links ends at the real file", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "real.md");
    await fs.writeFile(file, "old\n");
    await fs.symlink("real.md", path.join(dir, "middle.md"));
    await fs.symlink("middle.md", path.join(dir, "outer.md"));

    await writeAtomicThroughLink(path.join(dir, "outer.md"), "new\n");

    expect((await fs.lstat(path.join(dir, "outer.md"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("new\n");
  });

  test("a relative link through a linked directory resolves against the real directory", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(root, "a", "rules.md"), "old\n");
    await fs.writeFile(path.join(root, "rules.md"), "unrelated\n");
    await fs.symlink(path.join(root, "a", "b"), path.join(root, "linked"));
    await fs.symlink("../rules.md", path.join(root, "a", "b", "AGENTS.md"));

    await writeAtomicThroughLink(path.join(root, "linked", "AGENTS.md"), "new\n");

    expect(await fs.readFile(path.join(root, "a", "rules.md"), "utf8")).toBe("new\n");
    expect(await fs.readFile(path.join(root, "rules.md"), "utf8")).toBe("unrelated\n");
  });

  test("the temporary file is never wider than the target while it holds the contents", async () => {
    const file = path.join(await tempDir(), "AGENTS.md");
    await fs.writeFile(file, "old\n", { mode: 0o600 });
    const original = fs.writeFile.bind(fs);
    let modeWhileWritten = 0;
    const spy = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await original(...args);
      modeWhileWritten = (await fs.stat(args[0] as string)).mode & 0o777;
    });
    const previousUmask = process.umask(0o022);
    try {
      await writeAtomicThroughLink(file, "secret\n");
    } finally {
      process.umask(previousUmask);
      spy.mockRestore();
    }

    expect(modeWhileWritten).toBe(0o600);
  });
});

describe("writeAtomic", () => {
  test("a requested mode stays subject to the umask", async () => {
    const file = path.join(await tempDir(), "launcher");
    const previousUmask = process.umask(0o077);
    try {
      await writeAtomic(file, "#!/bin/sh\n", 0o755);
    } finally {
      process.umask(previousUmask);
    }

    expect((await fs.stat(file)).mode & 0o777).toBe(0o700);
  });
});

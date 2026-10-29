import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, spyOn, test } from "bun:test";

import { companionLinkPath } from "../../runtime/repo-local";
import { linkCompanion } from "./projection-companion-link";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<{ repoPath: string; companionPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-link-"));
  tempRoots.push(root);
  const repoPath = path.join(root, "working");
  const companionPath = path.join(root, "companion");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(companionPath, { recursive: true });
  return { repoPath, companionPath };
}

test("a link a concurrent writer created to the same companion counts as current", async () => {
  const { repoPath, companionPath } = await scratch();
  const symlink = fs.symlink.bind(fs);
  const racing = spyOn(fs, "symlink").mockImplementation(async (target, link, type) => {
    await symlink(target, link, type);
    throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
  });

  try {
    expect(await linkCompanion(repoPath, companionPath)).toBe("current");
  } finally {
    racing.mockRestore();
  }
  expect(await fs.readlink(companionLinkPath(repoPath))).toBe(companionPath);
});

test("a link a concurrent writer created to another companion still fails", async () => {
  const { repoPath, companionPath } = await scratch();
  const other = path.join(path.dirname(companionPath), "other");
  await fs.mkdir(other);
  const symlink = fs.symlink.bind(fs);
  const racing = spyOn(fs, "symlink").mockImplementation(async (_target, link, type) => {
    await symlink(other, link, type);
    throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
  });

  try {
    await expect(linkCompanion(repoPath, companionPath)).rejects.toThrow("EEXIST");
  } finally {
    racing.mockRestore();
  }
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { readSessionNotes, recordSessionNotes } from "./session-notes";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acme-notes-"));
  tempRoots.push(dir);
  return dir;
}

describe("recordSessionNotes", () => {
  /** The background sync's report overlaps the next prepare's; neither may drop the other's phase. */
  test("overlapping records each keep the other's phase", async () => {
    const repoPath = await repo();

    await Promise.all([
      recordSessionNotes(repoPath, "prepare", ["preflight: acme"]),
      recordSessionNotes(repoPath, "sync", ["git-sync: offline"]),
    ]);

    expect(readSessionNotes(repoPath).toSorted()).toEqual(["git-sync: offline", "preflight: acme"]);
  });

  test("a clear that overlaps an earlier record is not undone by it", async () => {
    const repoPath = await repo();
    await recordSessionNotes(repoPath, "prepare", ["preflight: acme"]);

    await Promise.all([
      recordSessionNotes(repoPath, "sync", []),
      recordSessionNotes(repoPath, "prepare", []),
    ]);

    expect(readSessionNotes(repoPath)).toEqual([]);
  });
});

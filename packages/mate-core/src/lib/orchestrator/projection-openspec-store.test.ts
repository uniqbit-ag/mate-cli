import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, initRepo } from "../../../test/git-checkouts";
import { generatedHeader } from "../../runtime/projection";
import {
  OPENSPEC_POINTER_EXCLUDE,
  pointerIgnoreProblem,
  readStorePointer,
  reconcileStorePointerExclude,
  removeStorePointer,
  removeStorePointerExclude,
  storePointerIneligibility,
  writeStorePointer,
} from "./projection-openspec-store";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const dir of tempRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function makeRepo(options: { git?: boolean } = {}): Promise<string> {
  const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openspec-pointer-")));
  tempRoots.push(repo);
  if (options.git ?? true) execFileSync("git", ["init", "-q"], { cwd: repo });
  return repo;
}

const pointerPath = (repo: string) => path.join(repo, "openspec", "config.yaml");

describe("store pointer", () => {
  test("is written with the Mate marker and the store id", async () => {
    const repo = await makeRepo();
    expect(await writeStorePointer(repo, "acme-companion")).toBe("written");
    expect(await fs.readFile(pointerPath(repo), "utf8")).toBe(
      `${generatedHeader()}\nstore: acme-companion\n`,
    );
    expect(await readStorePointer(repo)).toEqual({ kind: "mate", id: "acme-companion" });
  });

  test("is current when it already names the id, and rewritten when stale", async () => {
    const repo = await makeRepo();
    await writeStorePointer(repo, "acme-companion");
    expect(await writeStorePointer(repo, "acme-companion")).toBe("current");
    expect(await writeStorePointer(repo, "renamed")).toBe("written");
    expect(await readStorePointer(repo)).toEqual({ kind: "mate", id: "renamed" });
  });

  test("a config without the marker is foreign", async () => {
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, "openspec"));
    await fs.writeFile(pointerPath(repo), "schema: spec-driven\n");
    expect(await readStorePointer(repo)).toEqual({ kind: "foreign" });
  });

  test("no config is absent", async () => {
    expect(await readStorePointer(await makeRepo())).toEqual({ kind: "absent" });
  });
});

describe("storePointerIneligibility", () => {
  test("a repository without openspec/ or with only Mate's pointer is eligible", async () => {
    const repo = await makeRepo();
    expect(await storePointerIneligibility(repo)).toBeNull();
    await writeStorePointer(repo, "acme-companion");
    expect(await storePointerIneligibility(repo)).toBeNull();
  });

  test("a foreign config makes it ineligible, naming the path", async () => {
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, "openspec"));
    await fs.writeFile(pointerPath(repo), "schema: spec-driven\n");
    expect(await storePointerIneligibility(repo)).toContain(pointerPath(repo));
  });

  test.each(["specs", "changes"])("an own openspec/%s makes it ineligible", async (dir) => {
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, "openspec", dir), { recursive: true });
    expect(await storePointerIneligibility(repo)).toContain(path.join(repo, "openspec", dir));
  });
});

describe("pointerIgnoreProblem", () => {
  test("none once the exclusion line is on disk", async () => {
    const repo = await makeRepo();
    await fs.appendFile(
      path.join(repo, ".git", "info", "exclude"),
      `${OPENSPEC_POINTER_EXCLUDE}\n`,
    );
    expect(await pointerIgnoreProblem(repo)).toBeNull();
  });

  /** Git does not name a directory-level negation, so only the outcome is checked. */
  test("reports a rule that re-includes the folder", async () => {
    const repo = await makeRepo();
    await fs.appendFile(
      path.join(repo, ".git", "info", "exclude"),
      `${OPENSPEC_POINTER_EXCLUDE}\n`,
    );
    await fs.writeFile(path.join(repo, ".gitignore"), "!openspec/\n");
    expect(await pointerIgnoreProblem(repo)).toContain("not ignored by Git");
  });

  test("a file-level re-include cannot reach into the excluded folder", async () => {
    const repo = await makeRepo();
    await fs.appendFile(
      path.join(repo, ".git", "info", "exclude"),
      `${OPENSPEC_POINTER_EXCLUDE}\n`,
    );
    await fs.writeFile(path.join(repo, ".gitignore"), "!openspec/config.yaml\n");
    expect(await pointerIgnoreProblem(repo)).toBeNull();
  });

  test("reports a missing exclusion", async () => {
    expect(await pointerIgnoreProblem(await makeRepo())).not.toBeNull();
  });

  test("none outside Git, where no diff can show the pointer", async () => {
    expect(await pointerIgnoreProblem(await makeRepo({ git: false }))).toBeNull();
  });
});

describe("removeStorePointer", () => {
  test("deletes Mate's pointer and prunes the emptied openspec/", async () => {
    const repo = await makeRepo();
    await writeStorePointer(repo, "acme-companion");
    expect(await removeStorePointer(repo)).toBe("removed");
    expect(await fs.stat(path.join(repo, "openspec")).catch(() => null)).toBeNull();
    expect(await removeStorePointer(repo)).toBe("absent");
  });

  test("keeps openspec/ when it holds anything else", async () => {
    const repo = await makeRepo();
    await writeStorePointer(repo, "acme-companion");
    await fs.writeFile(path.join(repo, "openspec", "notes.md"), "mine\n");
    expect(await removeStorePointer(repo)).toBe("removed");
    expect(await fs.readFile(path.join(repo, "openspec", "notes.md"), "utf8")).toBe("mine\n");
  });

  test("never touches a foreign config", async () => {
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, "openspec"));
    await fs.writeFile(pointerPath(repo), "schema: spec-driven\n");
    expect(await removeStorePointer(repo)).toBe("absent");
    expect(await fs.readFile(pointerPath(repo), "utf8")).toBe("schema: spec-driven\n");
  });
});

describe("the pointer line across Checkouts of one clone", () => {
  async function clone(): Promise<{ main: string; worktree: string; excludePath: string }> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openspec-clone-")));
    tempRoots.push(root);
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-feature"));
    await reconcileStorePointerExclude(main);
    await writeStorePointer(main, "acme-companion");
    return { main, worktree, excludePath: path.join(main, ".git", "info", "exclude") };
  }

  test("an ineligible worktree keeps a sibling's line and warns", async () => {
    const { worktree, excludePath } = await clone();
    await fs.mkdir(path.join(worktree, "openspec", "changes"), { recursive: true });

    const report = await reconcileStorePointerExclude(worktree);

    expect(await fs.readFile(excludePath, "utf8")).toContain(`${OPENSPEC_POINTER_EXCLUDE}\n`);
    expect(report).toMatchObject({ state: "current" });
    expect(typeof report === "object" && report.warnings?.[0]).toContain(
      path.join(worktree, "openspec"),
    );
  });

  test("cleanup keeps the line another Checkout's pointer needs", async () => {
    const { main, worktree, excludePath } = await clone();
    await writeStorePointer(worktree, "acme-companion");
    await removeStorePointer(main);

    expect(await removeStorePointerExclude(main)).toMatchObject({
      state: "retained",
      keptFor: [worktree],
    });
    expect(await fs.readFile(excludePath, "utf8")).toContain(`${OPENSPEC_POINTER_EXCLUDE}\n`);
    expect(await pointerIgnoreProblem(worktree)).toBeNull();
  });

  test("cleanup keeps the line while another Checkout's pointer is unreadable", async () => {
    const { main, worktree, excludePath } = await clone();
    await writeStorePointer(worktree, "acme-companion");
    await fs.chmod(pointerPath(worktree), 0o000);
    await removeStorePointer(main);

    try {
      expect(await removeStorePointerExclude(main)).toMatchObject({ keptFor: [worktree] });
      expect(await fs.readFile(excludePath, "utf8")).toContain(`${OPENSPEC_POINTER_EXCLUDE}\n`);
    } finally {
      await fs.chmod(pointerPath(worktree), 0o644);
    }
  });

  test("the last Checkout with a pointer removes the line", async () => {
    const { main, excludePath } = await clone();
    await removeStorePointer(main);

    expect(await removeStorePointerExclude(main)).toBe("removed");
    expect(await fs.readFile(excludePath, "utf8")).not.toContain(OPENSPEC_POINTER_EXCLUDE);
  });
});

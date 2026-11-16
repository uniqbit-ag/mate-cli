import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { git, initRepo } from "../../../test/git-checkouts";
import type { GitRunner } from "./worktree";
import { copyIncludedFiles, selectIncludedFiles } from "./worktree-include";

let root: string;
let main: string;

const realGit: GitRunner = async (cwd, args, options = {}) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", input: options.input });
  return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-worktree-include-")));
  main = initRepo(path.join(root, "acme"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, content = "ACME_TOKEN=fake-value\n", base = main): void {
  fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
  fs.writeFileSync(path.join(base, file), content);
}

function commit(...files: string[]): void {
  git(main, "add", "--", ...files);
  git(main, "commit", "-q", "-m", "files");
}

describe("selectIncludedFiles", () => {
  test("a committed include file selects ignored, untracked matches only", async () => {
    write(".gitignore", ".env*\n.npmrc\n");
    write(".worktreeinclude", ".env\n.npmrc\npackage.json\nnotes.txt\n");
    write("package.json", "{}\n");
    commit(".gitignore", ".worktreeinclude", "package.json");
    write(".env");
    write(".npmrc");
    write("notes.txt");
    const selection = await selectIncludedFiles(realGit, main);
    expect(selection).toEqual({
      sources: [".worktreeinclude"],
      paths: [".env", ".npmrc"],
      warnings: [],
    });
  });

  test("an ignored local file adds patterns and its negation excludes committed ones", async () => {
    write(".gitignore", ".env*\n.worktreeinclude.local\n");
    write(".worktreeinclude", ".env*\n");
    write(".worktreeinclude.local", "!.env.production\napps/acme/.env.local\n");
    write(".env");
    write(".env.production");
    write("apps/acme/.env.local");
    const selection = await selectIncludedFiles(realGit, main);
    expect(selection.sources).toEqual([".worktreeinclude", ".worktreeinclude.local"]);
    expect(selection.paths).toEqual([".env", "apps/acme/.env.local"]);
  });

  test.each([
    ["tracked", true],
    ["not ignored", false],
  ])("a local file that is %s is skipped with a warning", async (_label, tracked) => {
    write(".gitignore", ".env\n");
    write(".worktreeinclude.local", ".env\n");
    if (tracked) commit(".gitignore", ".worktreeinclude.local");
    write(".env");
    const selection = await selectIncludedFiles(realGit, main);
    expect(selection.sources).toEqual([]);
    expect(selection.paths).toEqual([]);
    expect(selection.warnings).toEqual([".worktreeinclude.local skipped: Git does not ignore it"]);
  });

  test("only an ignored local file is enough", async () => {
    write(".gitignore", ".env\n.worktreeinclude.local\n");
    write(".worktreeinclude.local", ".env\n");
    write(".env");
    const selection = await selectIncludedFiles(realGit, main);
    expect(selection.sources).toEqual([".worktreeinclude.local"]);
    expect(selection.paths).toEqual([".env"]);
  });

  test("leading **/, matched directories and non-ASCII names all select", async () => {
    write(".gitignore", ".env\ncerts/\nconfig/\n");
    write(".worktreeinclude", "**/.env\ncerts/\nconfig/*.yaml\n");
    write(".env");
    write("apps/acme/.env");
    write("certs/acme.pem");
    write("certs/acme.key");
    write("certs/nested/acme.crt");
    write("config/größe.yaml");
    const selection = await selectIncludedFiles(realGit, main);
    expect(selection.paths).toEqual(
      [
        ".env",
        "apps/acme/.env",
        "certs/acme.key",
        "certs/acme.pem",
        "certs/nested/acme.crt",
        "config/größe.yaml",
      ].toSorted(),
    );
  });

  test("files inside node_modules are never selected", async () => {
    write(".gitignore", ".env\nnode_modules/\n");
    write(".worktreeinclude", ".env\n");
    write(".env");
    write("node_modules/acme/.env");
    write("apps/acme/node_modules/acme/.env");
    expect((await selectIncludedFiles(realGit, main)).paths).toEqual([".env"]);
  });

  test("no include file selects nothing", async () => {
    write(".gitignore", ".env\n");
    write(".env");
    expect(await selectIncludedFiles(realGit, main)).toEqual({
      sources: [],
      paths: [],
      warnings: [],
    });
  });
});

describe("copyIncludedFiles", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = path.join(root, "acme.worktrees", "acme-login");
    fs.mkdirSync(worktree, { recursive: true });
  });

  const selection = (...paths: string[]) => ({
    sources: [".worktreeinclude"],
    paths,
    warnings: [],
  });

  test("copies contents and permission bits, creating parents", async () => {
    write(".env");
    write("apps/acme/.env.local", "ACME_LOCAL=1\n");
    fs.chmodSync(path.join(main, ".env"), 0o600);
    const outcome = await copyIncludedFiles(
      main,
      worktree,
      selection(".env", "apps/acme/.env.local"),
    );
    expect(outcome).toEqual({
      sources: [".worktreeinclude"],
      copied: [".env", "apps/acme/.env.local"],
      failed: [],
    });
    expect(fs.readFileSync(path.join(worktree, "apps", "acme", ".env.local"), "utf8")).toBe(
      "ACME_LOCAL=1\n",
    );
    expect(fs.statSync(path.join(worktree, ".env")).mode & 0o777).toBe(0o600);
  });

  test("an existing path is kept and not reported", async () => {
    write(".env");
    write(".env", "ACME_TOKEN=other\n", worktree);
    const outcome = await copyIncludedFiles(main, worktree, selection(".env"));
    expect(outcome.copied).toEqual([]);
    expect(outcome.failed).toEqual([]);
    expect(fs.readFileSync(path.join(worktree, ".env"), "utf8")).toBe("ACME_TOKEN=other\n");
  });

  test("a symbolic link is skipped without writing or failing", async () => {
    write("secrets/acme.env");
    fs.symlinkSync(path.join(main, "secrets", "acme.env"), path.join(main, ".env"));
    write(".npmrc");
    const outcome = await copyIncludedFiles(main, worktree, selection(".env", ".npmrc"));
    expect(outcome.copied).toEqual([".npmrc"]);
    expect(outcome.failed).toEqual([]);
    expect(fs.existsSync(path.join(worktree, ".env"))).toBe(false);
  });

  test("a parent symlinked out of the worktree is refused", async () => {
    write("apps/acme/.env");
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(worktree, "apps"), { recursive: true });
    fs.symlinkSync(outside, path.join(worktree, "apps", "acme"));
    const outcome = await copyIncludedFiles(main, worktree, selection("apps/acme/.env"));
    expect(outcome.failed).toEqual([{ path: "apps/acme/.env", reason: "outside the worktree" }]);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("a deeper path under a parent symlinked out of the worktree creates nothing outside", async () => {
    write("apps/acme/sub/.env");
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(worktree, "apps"), { recursive: true });
    fs.symlinkSync(outside, path.join(worktree, "apps", "acme"));
    const outcome = await copyIncludedFiles(main, worktree, selection("apps/acme/sub/.env"));
    expect(outcome.failed).toEqual([
      { path: "apps/acme/sub/.env", reason: "outside the worktree" },
    ]);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("a root name starting with two dots is inside the worktree", async () => {
    write("..env.backup");
    const outcome = await copyIncludedFiles(main, worktree, selection("..env.backup"));
    expect(outcome).toEqual({
      sources: [".worktreeinclude"],
      copied: ["..env.backup"],
      failed: [],
    });
  });

  test("a failed copy names its error code, never contents", async () => {
    write(".npmrc");
    write(".env");
    const missing = await copyIncludedFiles(main, worktree, selection("gone.env", ".env"));
    expect(missing.copied).toEqual([".env"]);
    expect(missing.failed).toEqual([{ path: "gone.env", reason: "ENOENT" }]);
    expect(JSON.stringify(missing)).not.toContain("fake-value");
  });
});

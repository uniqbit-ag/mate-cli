import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  addLocalRepository,
  FACTORY_LOCAL_FILE,
  readLocalRepositories,
  removeLocalRepository,
} from "./factory-local";

const WEB = "https://git.acme.test/acme/web.git";
const API = "git@git.acme.test:acme/api.git";

let companion: string;
const file = () => path.join(companion, FACTORY_LOCAL_FILE);

beforeEach(() => {
  companion = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-factory-local-")));
});

afterEach(() => fs.rmSync(companion, { recursive: true, force: true }));

const git = () => execFileSync("git", ["init", "-q", companion]);
const status = () =>
  execFileSync("git", ["-C", companion, "status", "--porcelain"], { encoding: "utf8" });

describe("reading the list", () => {
  test("a missing file is an empty list", async () => {
    expect(await readLocalRepositories(companion)).toEqual({ urls: [], problem: null });
  });

  test("lists the clone URLs in file order", async () => {
    fs.writeFileSync(file(), `repositories:\n  - ${WEB}\n  - ${API}\n`);
    expect(await readLocalRepositories(companion)).toEqual({ urls: [WEB, API], problem: null });
  });

  test("an entry that names no org/repository makes the list unreadable, naming file and entry", async () => {
    fs.writeFileSync(file(), `repositories:\n  - ${WEB}\n  - https://git.acme.test/web\n`);
    const result = await readLocalRepositories(companion);
    expect(result.urls).toEqual([]);
    expect(result.problem).toContain(FACTORY_LOCAL_FILE);
    expect(result.problem).toContain("https://git.acme.test/web");
  });

  test.each([
    ["not yaml: [", /not valid YAML/],
    ["- a\n- b\n", /mapping/],
    ["repositories: nope\n", /must be a list/],
    ["repositories:\n  - 3\n", /names no org\/repository/],
  ])("%j is reported, not thrown", async (text, pattern) => {
    fs.writeFileSync(file(), text);
    expect((await readLocalRepositories(companion)).problem).toMatch(pattern);
  });

  test("a file that cannot be read is reported, not thrown", async () => {
    fs.mkdirSync(file());
    const result = await readLocalRepositories(companion);
    expect(result.urls).toEqual([]);
    expect(result.problem).toMatch(new RegExp(`^${FACTORY_LOCAL_FILE} could not be read`));
  });
});

describe("adding and removing", () => {
  test("adds in order, and an entry already listed under the same repository is left alone", async () => {
    expect(await addLocalRepository(companion, WEB)).toEqual({ added: true, warning: null });
    expect(await addLocalRepository(companion, API)).toMatchObject({ added: true });
    const before = fs.readFileSync(file(), "utf8");
    expect(await addLocalRepository(companion, "git@git.acme.test:acme/web.git")).toEqual({
      added: false,
      warning: null,
    });
    expect(fs.readFileSync(file(), "utf8")).toBe(before);
    expect((await readLocalRepositories(companion)).urls).toEqual([WEB, API]);
  });

  test("removes only the named repository and leaves the others in order", async () => {
    await addLocalRepository(companion, WEB);
    await addLocalRepository(companion, API);
    expect(await removeLocalRepository(companion, "acme/web")).toBe(true);
    expect(await removeLocalRepository(companion, "acme/web")).toBe(false);
    expect((await readLocalRepositories(companion)).urls).toEqual([API]);
  });

  test("keeps keys it does not manage", async () => {
    fs.writeFileSync(file(), `future:\n  setting: 1\nrepositories:\n  - ${WEB}\n`);
    await addLocalRepository(companion, API);
    await removeLocalRepository(companion, "acme/web");
    const text = fs.readFileSync(file(), "utf8");
    expect(text).toContain("future:");
    expect(text).toContain("setting: 1");
    expect((await readLocalRepositories(companion)).urls).toEqual([API]);
  });

  test("an unusable file is never overwritten", async () => {
    fs.writeFileSync(file(), "repositories:\n  - https://git.acme.test/web\n");
    await expect(addLocalRepository(companion, WEB)).rejects.toThrow(/names no org\/repository/);
    await expect(removeLocalRepository(companion, "acme/web")).rejects.toThrow();
    expect(fs.readFileSync(file(), "utf8")).toBe("repositories:\n  - https://git.acme.test/web\n");
  });

  test("a URL with no org/repository is refused", async () => {
    await expect(addLocalRepository(companion, "https://git.acme.test/web")).rejects.toThrow();
    expect(fs.existsSync(file())).toBe(false);
  });

  test("concurrent adds both land and leave no temporary file", async () => {
    await Promise.all([addLocalRepository(companion, WEB), addLocalRepository(companion, API)]);
    expect((await readLocalRepositories(companion)).urls.toSorted()).toEqual([API, WEB].toSorted());
    expect(fs.readdirSync(companion)).toEqual([FACTORY_LOCAL_FILE]);
  });
});

describe("keeping the file out of Git", () => {
  test("the first write excludes it once and leaves the tree clean", async () => {
    git();
    await addLocalRepository(companion, WEB);
    await addLocalRepository(companion, API);
    await removeLocalRepository(companion, "acme/web");
    const exclude = fs.readFileSync(path.join(companion, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === FACTORY_LOCAL_FILE)).toHaveLength(1);
    expect(status()).toBe("");
  });

  test("an existing exclude without a final newline keeps its lines", async () => {
    git();
    fs.writeFileSync(path.join(companion, ".git", "info", "exclude"), "*.log");
    await addLocalRepository(companion, WEB);
    expect(fs.readFileSync(path.join(companion, ".git", "info", "exclude"), "utf8")).toBe(
      `*.log\n${FACTORY_LOCAL_FILE}\n`,
    );
  });

  test("outside a Git repository the file is written and no exclude file appears", async () => {
    await addLocalRepository(companion, WEB);
    expect(fs.existsSync(file())).toBe(true);
    expect(fs.existsSync(path.join(companion, ".git"))).toBe(false);
  });

  test("an unwritable exclude is a warning, and the repository is still added", async () => {
    git();
    const exclude = path.join(companion, ".git", "info", "exclude");
    fs.rmSync(exclude, { force: true });
    fs.mkdirSync(exclude);
    const result = await addLocalRepository(companion, WEB);
    expect(result.added).toBe(true);
    expect(result.warning).toContain("exclude");
    expect((await readLocalRepositories(companion)).urls).toEqual([WEB]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { changeFolderNames, changeFolders, OPENSPEC_CHANGE_FOLDERS } from "./change-folders";
import { defaultWorkflow, parseWorkflow } from "./declaration";

const declared = (archive: string) => {
  const parsed = parseWorkflow(`version: 1
artifacts:
  acme-notes:
    change: notes/{name}/
${archive}    published: [notes/index.md]
    publish:
      apply: { run: "acme-notes merge {change}" }
stages:
  - id: submit
    artifact: acme-notes
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  return parsed.workflow;
};

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-change-folders-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const folders = (...relative: string[]) =>
  Promise.all(relative.map((dir) => fs.mkdir(path.join(root, dir), { recursive: true })));

describe("changeFolders", () => {
  test("the built-in type keeps its changes in openspec/changes", () => {
    expect(changeFolders(defaultWorkflow())).toEqual(OPENSPEC_CHANGE_FOLDERS);
  });

  test("a declared submit type keeps them below its templates' roots", () => {
    expect(changeFolders(declared(""))).toEqual({ source: "notes" });
    expect(changeFolders(declared("    archive: history/notes/{id}/\n"))).toEqual({
      source: "notes",
      archiveRoot: "history/notes",
    });
  });
});

describe("changeFolderNames", () => {
  test("sorted folder names, never the archive folder, dot-folders or files", async () => {
    await folders(
      "openspec/changes/acme-login",
      "openspec/changes/acme-fix",
      "openspec/changes/archive/2026-01-02-acme-old",
      "openspec/changes/.hidden",
    );
    await fs.writeFile(path.join(root, "openspec", "changes", "acme-file"), "");
    expect(await changeFolderNames(root, OPENSPEC_CHANGE_FOLDERS)).toEqual([
      "acme-fix",
      "acme-login",
    ]);
  });

  test("archive is a change of a type that keeps no archive there", async () => {
    await folders("notes/archive", "notes/acme-glossary");
    expect(await changeFolderNames(root, { source: "notes" })).toEqual([
      "acme-glossary",
      "archive",
    ]);
  });

  test("a missing source folder has no changes", async () => {
    expect(await changeFolderNames(root, OPENSPEC_CHANGE_FOLDERS)).toEqual([]);
  });
});

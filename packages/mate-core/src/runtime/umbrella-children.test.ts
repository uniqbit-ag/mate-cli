import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { repoLocalRegistryPath } from "./repo-local";
import { UMBRELLA_CHILDREN_MAX_CHARS, umbrellaChildrenBlock } from "./umbrella-children";

let root: string;
let umbrella: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-umbrella-block-")));
  umbrella = path.join(root, "acme");
  link(umbrella);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function link(dir: string): void {
  fs.mkdirSync(path.dirname(repoLocalRegistryPath(dir)), { recursive: true });
  fs.writeFileSync(repoLocalRegistryPath(dir), "companions: []\n");
}

/** A checkout from files alone: a `.git` folder whose config names `origin`. */
function child(name: string, repository = `acme/${name}`): void {
  const gitDir = path.join(umbrella, name, ".git");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(
    path.join(gitDir, "config"),
    `[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:${repository}.git\n`,
  );
}

const children = (block: string) => [...block.matchAll(/<child /g)].length;

describe("umbrellaChildrenBlock", () => {
  test("lists two children by identity and folder", () => {
    child("web");
    child("api");
    expect(umbrellaChildrenBlock(umbrella)).toBe(
      [
        `<umbrella-children folder="${umbrella}" count="2">`,
        '  <child repository="acme/api" folder="api" />',
        '  <child repository="acme/web" folder="web" />',
        "  Each child is a Working Repository of its own. The Working Repository of a piece of work is the child it concerns.",
        "</umbrella-children>",
      ].join("\n"),
    );
  });

  test("lists 20 children", () => {
    for (let at = 0; at < 20; at += 1) child(`acme-${String(at).padStart(2, "0")}`);
    const block = umbrellaChildrenBlock(umbrella);
    expect(children(block)).toBe(20);
    expect(block.length).toBeLessThanOrEqual(UMBRELLA_CHILDREN_MAX_CHARS);
  });

  test("counts 21 children without listing them", () => {
    for (let at = 0; at < 21; at += 1) child(`acme-${String(at).padStart(2, "0")}`);
    const block = umbrellaChildrenBlock(umbrella);
    expect(children(block)).toBe(0);
    expect(block).toContain('count="21"');
    expect(block).toContain("`git -C <child> config --get remote.origin.url`");
  });

  test("counts 20 long-named children whose list passes the character bound", () => {
    const long = "x".repeat(60);
    for (let at = 0; at < 20; at += 1) child(`${long}-${at}`, `acme/${long}-${at}`);
    const block = umbrellaChildrenBlock(umbrella);
    expect(children(block)).toBe(0);
    expect(block).toContain('count="20"');
    expect(block.length).toBeLessThanOrEqual(UMBRELLA_CHILDREN_MAX_CHARS);
  });

  test("yields nothing for a Git checkout", () => {
    child("api");
    fs.mkdirSync(path.join(umbrella, ".git"));
    expect(umbrellaChildrenBlock(umbrella)).toBe("");
  });
});

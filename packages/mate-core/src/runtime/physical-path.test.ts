import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { canonicalPath, normalisedCanonicalPath, physicalPath } from "./physical-path";

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** `forward` links to `outside/sub`, so `forward/../companion` is `outside/companion`; `companion` is the decoy. */
function linkFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "physical-path-")));
  tempRoots.push(root);
  const real = path.join(root, "outside", "companion");
  fs.mkdirSync(path.join(root, "outside", "sub"), { recursive: true });
  fs.mkdirSync(real, { recursive: true });
  fs.mkdirSync(path.join(root, "companion"), { recursive: true });
  fs.symlinkSync(path.join(root, "outside", "sub"), path.join(root, "forward"));
  return { root, real, configured: `${path.join(root, "forward")}/../companion` };
}

describe("physicalPath", () => {
  test("follows a link before the `..` after it", () => {
    const { real, configured } = linkFixture();
    expect(physicalPath(configured)).toBe(real);
  });
});

describe("canonicalPath", () => {
  test("a `link/..` spelling becomes where it leads, not the decoy it normalises to", () => {
    const { real, configured } = linkFixture();
    expect(canonicalPath(configured)).toBe(real);
  });

  test("a path without `..` is only normalised and made absolute", () => {
    const { root } = linkFixture();
    expect(canonicalPath(`${root}/./companion/`)).toBe(path.join(root, "companion"));
    expect(canonicalPath("relative/dir")).toBe(path.resolve("relative/dir"));
  });

  test("a `..` that no link changes keeps the normalised spelling", () => {
    const { root } = linkFixture();
    expect(canonicalPath(`${root}/outside/../companion`)).toBe(path.join(root, "companion"));
  });

  test("a path that does not exist stays as written, and empty stays empty", () => {
    const { root } = linkFixture();
    const missing = `${root}/forward/../missing`;
    expect(canonicalPath(missing)).toBe(missing);
    expect(canonicalPath("")).toBe("");
  });
});

describe("normalisedCanonicalPath", () => {
  test("answers where an existing `link/..` spelling leads", () => {
    const { real, configured } = linkFixture();
    expect(normalisedCanonicalPath(configured)).toBe(real);
  });

  test("refuses a missing place a link leads to, instead of the decoy the spelling names", () => {
    const { root, real, configured } = linkFixture();
    fs.rmSync(real, { recursive: true });
    expect(fs.existsSync(path.join(root, "companion"))).toBe(true);
    expect(normalisedCanonicalPath(configured)).toBeNull();
  });

  test("normalises a missing path whose `..` no link changes", () => {
    const { root } = linkFixture();
    expect(normalisedCanonicalPath(`${root}/outside/../gone`)).toBe(path.join(root, "gone"));
    expect(normalisedCanonicalPath("relative/dir")).toBe(path.resolve("relative/dir"));
  });
});

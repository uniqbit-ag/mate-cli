import { describe, expect, test } from "bun:test";

import { folderPattern, matchesPattern, patternsOverlap } from "./globs";

describe("matchesPattern", () => {
  test.each([
    ["notes/index.md", "notes/index.md", true],
    ["notes/index.md", "notes/other.md", false],
    ["notes/*.md", "notes/a.md", true],
    ["notes/*.md", "notes/sub/a.md", false],
    ["notes/**", "notes/sub/a.md", true],
    ["notes/**/a.md", "notes/a.md", true],
    ["notes/?.md", "notes/ab.md", false],
    ["notes/a.md", "notes/aXmd", false],
  ])("%s against %s", (pattern, file, expected) => {
    expect(matchesPattern(pattern, file)).toBe(expected);
  });

  test("a folder template covers the files in its folders, not its siblings", () => {
    const pattern = folderPattern("notes/{name}/");
    expect(matchesPattern(pattern, "notes/acme-glossary/brief.md")).toBe(true);
    expect(matchesPattern(pattern, "notes/acme-glossary/sub/plan.md")).toBe(true);
    expect(matchesPattern(pattern, "notes/index.md")).toBe(false);
  });
});

describe("patternsOverlap", () => {
  test.each([
    ["notes/**", "notes/archive/*/**", true],
    ["notes/index.md", "notes/*/*/**", false],
    ["notes/*.md", "notes/index.*", true],
    ["notes/*.md", "notes/*.txt", false],
    ["**/*.md", ".mate/**", true],
    ["notes/**", "memos/**", false],
  ])("%s and %s", (a, b, expected) => {
    expect(patternsOverlap(a, b)).toBe(expected);
    expect(patternsOverlap(b, a)).toBe(expected);
  });
});

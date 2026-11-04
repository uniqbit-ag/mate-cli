import { describe, expect, test } from "bun:test";
import { parse } from "jsonc-parser";

import { mergeWorkspaceDocument, type WorkspaceDocumentMerge } from "./workspace-document";

const documentDir = "/acme/repo/.mate";
const managedFolders = ["/acme/repo", "/acme/companion"];

function mergedText(merge: WorkspaceDocumentMerge): string {
  if (merge.kind !== "changed") throw new Error(`expected a change, got ${merge.kind}`);
  return merge.text;
}

const merged = (existing: string | null, folders = managedFolders) =>
  mergeWorkspaceDocument({ existing, documentDir, folders });

describe("mergeWorkspaceDocument", () => {
  test("creates a missing document with the managed folders and settings", () => {
    const text = mergedText(merged(null));

    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      folders: [{ path: "/acme/repo" }, { path: "/acme/companion" }],
      settings: { "git.detectWorktrees": true, "scm.alwaysShowRepositories": true },
    });
  });

  test("keeps a folder the developer added and adds no managed folder twice", () => {
    const existing = JSON.stringify({
      folders: [{ path: "/acme/repo" }, { path: "/acme/extra" }, { path: "/acme/companion" }],
      settings: { "git.detectWorktrees": true, "scm.alwaysShowRepositories": true },
    });

    expect(merged(existing)).toEqual({ kind: "unchanged" });
  });

  test("appends a newly linked companion after the existing entries", () => {
    const existing = JSON.stringify({ folders: [{ path: "/acme/repo" }, { path: "/acme/extra" }] });

    expect(parse(mergedText(merged(existing))).folders).toEqual([
      { path: "/acme/repo" },
      { path: "/acme/extra" },
      { path: "/acme/companion" },
    ]);
  });

  test("dedupes a relative folder path against the document directory", () => {
    const existing = JSON.stringify({
      folders: [{ path: ".." }, { path: "../../companion" }],
      settings: { "git.detectWorktrees": true, "scm.alwaysShowRepositories": true },
    });

    expect(merged(existing)).toEqual({ kind: "unchanged" });
  });

  test("keeps comments and trailing commas", () => {
    const existing = `{
  // acme note
  "folders": [
    { "path": "/acme/repo", },
  ],
  "settings": {
    "editor.tabSize": 4,
  },
}
`;
    const text = mergedText(merged(existing));

    expect(text).toContain("// acme note");
    expect(text).toContain('"editor.tabSize": 4,');
    expect(text).toMatch(/},\n {2}\],/);
    expect(parse(text)).toEqual({
      folders: [{ path: "/acme/repo" }, { path: "/acme/companion" }],
      settings: {
        "editor.tabSize": 4,
        "git.detectWorktrees": true,
        "scm.alwaysShowRepositories": true,
      },
    });
  });

  test("adds absent managed settings and keeps a developer value", () => {
    const existing = JSON.stringify({
      folders: managedFolders.map((folder) => ({ path: folder })),
      settings: { "git.detectWorktrees": false, "files.exclude": { dist: true } },
    });

    expect(parse(mergedText(merged(existing))).settings).toEqual({
      "git.detectWorktrees": false,
      "files.exclude": { dist: true },
      "scm.alwaysShowRepositories": true,
    });
  });

  test("leaves an up-to-date document unchanged", () => {
    const existing = mergedText(merged(null));

    expect(merged(existing)).toEqual({ kind: "unchanged" });
  });

  test.each([
    ['{ "folders": [', /^invalid JSONC: .+ at line 1$/],
    ["", /^invalid JSONC: /],
    ["[]", /^root is not an object$/],
    ['{ "folders": {} }', /^"folders" is not an array$/],
    ['{ "settings": [] }', /^"settings" is not an object$/],
  ])("rejects %j", (existing, problem) => {
    const merge = merged(existing);

    expect(merge.kind).toBe("invalid");
    expect(merge.kind === "invalid" ? merge.problem : "").toMatch(problem);
  });
});

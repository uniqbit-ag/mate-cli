import { describe, expect, test } from "bun:test";

import { deriveGraphifyCommandArgs } from "./graphify";

describe("deriveGraphifyCommandArgs", () => {
  const repoPath = "/tmp/work";
  const paths = {
    graphifyOut: "/tmp/companion/.graphify/app/graphify-out",
    graphJson: "/tmp/companion/.graphify/app/graphify-out/graph.json",
  };

  test("routes build compatibility alias to extract with repository path and companion-managed output root", () => {
    expect(deriveGraphifyCommandArgs(["build", "--mode", "deep"], repoPath, paths)).toEqual([
      "extract",
      repoPath,
      "--out",
      "/tmp/companion/.graphify/app",
      "--mode",
      "deep",
    ]);
  });

  test("appends default graph path to query when none is provided", () => {
    expect(deriveGraphifyCommandArgs(["query", "symbol:Mate"], repoPath, paths)).toEqual([
      "query",
      "symbol:Mate",
      "--graph",
      paths.graphJson,
    ]);
  });

  test("does not append graph path when query already provides one", () => {
    expect(
      deriveGraphifyCommandArgs(
        ["query", "symbol:Mate", "--graph", "/tmp/custom/graph.json"],
        repoPath,
        paths,
      ),
    ).toEqual(["query", "symbol:Mate", "--graph", "/tmp/custom/graph.json"]);
  });

  test("routes lookup compatibility alias through query with the default graph path", () => {
    expect(deriveGraphifyCommandArgs(["lookup", "Mate"], repoPath, paths)).toEqual([
      "query",
      "Mate",
      "--graph",
      paths.graphJson,
    ]);
  });

  test("defaults extract to the linked working repository when no path is provided", () => {
    expect(deriveGraphifyCommandArgs(["extract", "--no-cluster"], repoPath, paths)).toEqual([
      "extract",
      repoPath,
      "--out",
      "/tmp/companion/.graphify/app",
      "--no-cluster",
    ]);
  });

  test("keeps explicit extract path and out overrides authoritative", () => {
    expect(
      deriveGraphifyCommandArgs(
        ["extract", "/tmp/custom-repo", "--out", "/tmp/custom-store", "--mode", "deep"],
        repoPath,
        paths,
      ),
    ).toEqual(["extract", "/tmp/custom-repo", "--out", "/tmp/custom-store", "--mode", "deep"]);
  });

  test("passes through path-first --update form unchanged", () => {
    expect(deriveGraphifyCommandArgs([repoPath, "--update", "--force"], repoPath, paths)).toEqual([
      repoPath,
      "--update",
      "--force",
    ]);
  });

  test("appends default graph path to path queries", () => {
    expect(deriveGraphifyCommandArgs(["path", "AuthModule", "Database"], repoPath, paths)).toEqual([
      "path",
      "AuthModule",
      "Database",
      "--graph",
      paths.graphJson,
    ]);
  });

  test("passes through unknown subcommands unchanged", () => {
    expect(deriveGraphifyCommandArgs(["stats", "--json"], repoPath, paths)).toEqual([
      "stats",
      "--json",
    ]);
  });
});

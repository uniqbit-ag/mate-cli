import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { deriveGraphifyCommandArgs, isGraphifyExtraction, runGraphifyCapCommand } from "./graphify";

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

describe("runGraphifyCapCommand secret gate", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    process.exitCode = 0;
    await Promise.all(
      tempRoots.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })),
    );
  });

  async function fixture() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "graphify-gate-"));
    tempRoots.push(root);
    const repo = path.join(root, "repo");
    const companion = path.join(root, "companion");
    await fsp.mkdir(repo, { recursive: true });
    await fsp.mkdir(companion, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    const graphifyOut = path.join(companion, ".graphify", "acme", "graphify-out");
    const resolveForCapability = (async () => ({
      companionPath: companion,
      repositoryId: "acme",
      repository: { id: "acme", path: repo },
      configStore: { load: async () => ({ capabilities: [{ name: "graphify" }] }) },
      workingRepoStore: { load: async () => ({ repos: [] }) },
    })) as never;
    return { repo, companion, graphifyOut, resolveForCapability };
  }

  function fakeSpawn(onRun: (args: string[]) => void = () => {}) {
    const calls: string[][] = [];
    const spawn = ((_command: string, args: string[]) => {
      calls.push(args);
      onRun(args);
      return { status: 0 };
    }) as never;
    return { calls, spawn };
  }

  const deps = (extra: object) => ({ ensureUnambiguousCompanion: async () => true, ...extra });

  test("writes the secret region before an extraction runs", async () => {
    const { repo, resolveForCapability } = await fixture();
    let ignoreAtRun = "";
    const { spawn } = fakeSpawn(() => {
      ignoreAtRun = fs.readFileSync(path.join(repo, ".graphifyignore"), "utf8");
    });

    await runGraphifyCapCommand(
      [".", "--update", "--code-only"],
      deps({ resolveForCapability, spawn }),
    );

    expect(ignoreAtRun).toContain("# mate:secrets begin");
    expect(process.exitCode).toBe(0);
  });

  test("warns and still runs when the region can't be written", async () => {
    const { repo, resolveForCapability } = await fixture();
    await fsp.writeFile(path.join(repo, ".graphifyignore"), "dist/\n");
    await fsp.chmod(path.join(repo, ".graphifyignore"), 0o444);
    const { calls, spawn } = fakeSpawn();
    try {
      await runGraphifyCapCommand([".", "--update"], deps({ resolveForCapability, spawn }));
    } finally {
      await fsp.chmod(path.join(repo, ".graphifyignore"), 0o644);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--exclude");
    expect(process.exitCode).toBe(0);
  });

  test("passes --exclude to `<path> --update` and extract, but not to the update subcommand", async () => {
    const { resolveForCapability } = await fixture();
    const { calls, spawn } = fakeSpawn();

    await runGraphifyCapCommand(
      [".", "--update", "--code-only"],
      deps({ resolveForCapability, spawn }),
    );
    await runGraphifyCapCommand(["extract"], deps({ resolveForCapability, spawn }));
    await runGraphifyCapCommand(["update"], deps({ resolveForCapability, spawn }));

    expect(calls[0].slice(0, 5)).toEqual([".", "--update", "--code-only", "--exclude", ".env"]);
    expect(calls[1]).toContain("--exclude");
    expect(calls[2]).not.toContain("--exclude");
  });

  test("leaves a secret file out of the output and keeps the run successful", async () => {
    const { graphifyOut, resolveForCapability } = await fixture();
    const { spawn } = fakeSpawn(() => {
      fs.mkdirSync(graphifyOut, { recursive: true });
      fs.writeFileSync(
        path.join(graphifyOut, "graph.json"),
        JSON.stringify({
          nodes: [
            { id: "a", source_file: "src/app.ts" },
            { id: "b", source_file: ".env.local" },
          ],
          links: [],
        }),
      );
    });

    await runGraphifyCapCommand([".", "--update"], deps({ resolveForCapability, spawn }));

    const graph = JSON.parse(fs.readFileSync(path.join(graphifyOut, "graph.json"), "utf8"));
    expect(graph.nodes.map((node: { id: string }) => node.id)).toEqual(["a"]);
    expect(process.exitCode).toBe(0);
  });

  test("leaves the ignore file alone for a query", async () => {
    const { repo, resolveForCapability } = await fixture();
    const { calls, spawn } = fakeSpawn();

    await runGraphifyCapCommand(["query", "Mate"], deps({ resolveForCapability, spawn }));

    expect(calls).toHaveLength(1);
    expect(fs.existsSync(path.join(repo, ".graphifyignore"))).toBe(false);
  });

  test("classifies extraction commands", () => {
    expect(isGraphifyExtraction(["extract", "/r"])).toBe(true);
    expect(isGraphifyExtraction([".", "--update"])).toBe(true);
    expect(isGraphifyExtraction(["query", "x"])).toBe(false);
  });
});

describe("graphify call sites", () => {
  test("only runGraphifyCapCommand spawns graphify, so no extraction bypasses the secret gate", () => {
    const srcRoot = path.resolve(import.meta.dirname, "../../..");
    const spawnsGraphify =
      /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*["'`]graphify\b|\brun\w*Command\(\s*["'`]graphify\s+(?:\.|update|extract|watch)\b/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
          if (spawnsGraphify.test(fs.readFileSync(full, "utf8"))) {
            offenders.push(path.relative(srcRoot, full));
          }
        }
      }
    };
    walk(srcRoot);

    expect(offenders).toEqual([path.join("cli", "commands", "cap", "graphify.ts")]);
  });
});

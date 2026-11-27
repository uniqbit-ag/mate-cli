import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import type { ResolveResult } from "../../../../lib/delivery/staging/resolve";
import { runArtifactResolveCommand, type ResolveCommandDeps } from "./resolve";

let root: string;
let out: string[];
let err: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-resolve-"));
  out = [];
  err = [];
  process.exitCode = 0;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});

function deps(result: ResolveResult, calls: unknown[][] = []): ResolveCommandDeps {
  return {
    ensureUnambiguousCompanion: async () => true,
    resolveContext: async () =>
      ({
        companionPath: "/acme-companion",
        repositoryId: "acme",
        configStore: { load: async () => ({}) },
        workingRepoStore: {},
      }) as unknown as LaunchContext,
    loadCapabilities: async () => [{ name: "openspec" }],
    resolve: async (...args) => {
      calls.push(args);
      return result;
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
}

const resolved: ResolveResult = {
  change: "acme-alpha",
  status: "resolved",
  group: "acme_product/workset/acme-alpha",
  message: "Resolved.",
};

describe("mate artifact resolve", () => {
  test("rewrites the requirement of a submitted change with the file's text", async () => {
    const file = path.join(root, "text.md");
    fs.writeFileSync(file, "The widget SHALL glow and hum.\n");
    const calls: unknown[][] = [];

    await runArtifactResolveCommand(
      [
        "acme-alpha",
        "--capability",
        "widget",
        "--requirement",
        "Widget renders",
        "--file",
        file,
        "--json",
      ],
      deps(resolved, calls),
    );

    expect(calls).toEqual([
      [
        "/acme-companion",
        "acme-alpha",
        [
          {
            part: { capability: "widget", requirement: "Widget renders" },
            text: "The widget SHALL glow and hum.\n",
          },
        ],
      ],
    ]);
    expect(JSON.parse(out[0]!)).toEqual(resolved);
    expect(process.exitCode).toBe(0);
  });

  test("pairs repeated triples in order", async () => {
    const renders = path.join(root, "renders.md");
    const sizes = path.join(root, "sizes.md");
    fs.writeFileSync(renders, "The widget SHALL hum.\n");
    fs.writeFileSync(sizes, "The widget SHALL scale.\n");
    const calls: unknown[][] = [];

    await runArtifactResolveCommand(
      [
        "acme-alpha",
        "--capability",
        "widget",
        "--requirement",
        "Widget renders",
        "--file",
        renders,
        "--capability",
        "widget",
        "--requirement",
        "Widget sizes",
        "--file",
        sizes,
      ],
      deps(resolved, calls),
    );

    expect(calls[0]?.[2]).toEqual([
      {
        part: { capability: "widget", requirement: "Widget renders" },
        text: "The widget SHALL hum.\n",
      },
      {
        part: { capability: "widget", requirement: "Widget sizes" },
        text: "The widget SHALL scale.\n",
      },
    ]);
  });

  test("refuses without every flag, a change name or a readable file", async () => {
    await runArtifactResolveCommand(["acme-alpha", "--capability", "widget"], deps(resolved));
    await runArtifactResolveCommand(
      ["../acme", "--capability", "c", "--requirement", "r", "--file", "f"],
      deps(resolved),
    );
    await runArtifactResolveCommand(
      ["acme-alpha", "--capability", "c", "--requirement", "r", "--file", path.join(root, "none")],
      deps(resolved),
    );

    expect(err).toEqual([
      "mate: artifact resolve requires --capability, --requirement and --file, once per requirement.",
      "mate: artifact resolve requires one submitted change name.",
      `mate: ${path.join(root, "none")} cannot be read or is empty.`,
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("a refused resolution exits non-zero", async () => {
    const file = path.join(root, "text.md");
    fs.writeFileSync(file, "text\n");

    await runArtifactResolveCommand(
      ["acme-alpha", "--capability", "c", "--requirement", "r", "--file", file],
      deps({ ...resolved, status: "refused", message: "mate: refused." }),
    );

    expect(out).toEqual([]);
    expect(err).toEqual(["mate: refused."]);
    expect(process.exitCode).toBe(1);
  });
});

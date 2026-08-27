import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { buildBanner } from "./hooks/session-banner";
import { evaluate } from "./hooks/validate-artifact-path";
import { readContext } from "./opencode/companion-policy";
import { resolveProjection, writeProjectionPair } from "./runtime/projection";
import { repoLocalFrameworkPath, repoLocalRegistryPath } from "./runtime/repo-local";

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

/** A companion carries `config/framework.yaml`; only a Working Repository carries the registry. */
function companionRepository(): string {
  const root = makeTempDir("guardrail-companion-repo-");
  const frameworkPath = repoLocalFrameworkPath(root);
  fs.mkdirSync(path.dirname(frameworkPath), { recursive: true });
  fs.writeFileSync(frameworkPath, "capabilities: []\n", "utf8");
  return root;
}

function unwrappedWorkingRepository(): string {
  const root = makeTempDir("guardrail-unwrapped-repo-");
  const registryPath = repoLocalRegistryPath(root);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, "companions: []\n", "utf8");
  return root;
}

function expectEveryArtifactInert(cwd: string): void {
  expect(
    evaluate(
      { tool_name: "Write", tool_input: { file_path: path.join(cwd, "design.md") } },
      {},
      cwd,
    ).exitCode,
  ).toBe(0);
  expect(buildBanner({}, cwd)).toEqual({ exitCode: 0, stdout: "" });

  const context = readContext({}, cwd);
  expect(context.companionPath).toBe("");
  expect(context.repositoryPath).toBe("");
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("unmanaged session guardrail", () => {
  test("a companion repository resolves no projection", () => {
    const companion = companionRepository();
    writeProjectionPair(companion, {
      stamp: "deadbeef",
      projection: {
        version: "0.0.0",
        companionPath: companion,
        repositoryPath: companion,
        repositoryId: "acme",
        wrapperBinPath: path.join(companion, "wrappers", "bin"),
        reactDoctorBinPath: path.join(companion, "react-doctor"),
        graphifyOut: path.join(companion, ".graphify", "acme", "graphify-out"),
      },
    });

    expect(resolveProjection(companion)).toBeNull();
    expectEveryArtifactInert(companion);
  });

  test("an unwrapped Working Repository leaves every companion artifact inert", () => {
    const repo = unwrappedWorkingRepository();

    expect(resolveProjection(repo)).toBeNull();
    expectEveryArtifactInert(repo);
  });
});

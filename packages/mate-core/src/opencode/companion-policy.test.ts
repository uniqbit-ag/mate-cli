import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { readContext } from "./companion-policy";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function wrapRepo(repoRoot: string, companionPath: string): Promise<void> {
  const registryPath = repoLocalRegistryPath(repoRoot);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, "companions: []\n", "utf8");
  writeProjectionPair(repoRoot, {
    stamp: "deadbeef",
    projection: {
      version: "0.0.0",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme",
      wrapperBinPath: path.join(companionPath, "wrappers", "bin"),
      reactDoctorBinPath: path.join(companionPath, "react-doctor"),
      graphifyOut: path.join(companionPath, ".graphify", "acme", "graphify-out"),
    },
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("readContext", () => {
  test("reports the companion a projection resolves when the environment is empty", async () => {
    const repo = await makeTempDir("mate-readcontext-wrapped-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await fs.writeFile(path.join(companion, "AGENTS.md"), "projected agents\n", "utf8");
    await wrapRepo(repo, companion);

    const context = readContext({}, repo);

    expect(context.companionPath).toBe(companion);
    expect(context.repositoryPath).toBe(repo);
    expect(context.agentsMd).toBe("projected agents\n");
  });

  test("is a no-op under a launch: the resolved companion is the environment value", async () => {
    const repo = await makeTempDir("mate-readcontext-launched-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await fs.writeFile(path.join(companion, "AGENTS.md"), "launched agents\n", "utf8");
    const projected = path.join(repo, "projected");
    await fs.mkdir(projected, { recursive: true });
    await wrapRepo(repo, projected);

    const context = readContext({ MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo }, repo);

    expect(context.companionPath).toBe(companion);
    expect(context.agentsMd).toBe("launched agents\n");
  });

  test("reports a stale projection, naming mate wrap", async () => {
    const repo = await makeTempDir("mate-readcontext-stale-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await wrapRepo(repo, companion);

    const context = readContext({}, repo);

    expect(context.companionPath).toBe(companion);
    expect(context.stalenessLines.join("\n")).toContain("mate wrap");
  });

  test("a managed session carries no staleness", async () => {
    const repo = await makeTempDir("mate-readcontext-managed-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await wrapRepo(repo, companion);

    expect(
      readContext({ MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo }, repo).stalenessLines,
    ).toEqual([]);
  });

  test("resolves nothing in an unwrapped repository with an empty environment", async () => {
    const repo = await makeTempDir("mate-readcontext-unwrapped-");

    const context = readContext({}, repo);

    expect(context.companionPath).toBe("");
    expect(context.repositoryPath).toBe("");
    expect(context.agentsMd).toBe("");
  });
});

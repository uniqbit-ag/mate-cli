import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { buildSessionGuidance } from "./session-guidance";

const tempRoots: string[] = [];
const REGISTRY_CONTENT = "companions: []\n";

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/** A wrapped Working Repository beside a companion with `capabilities` enabled. */
function wrapRepo(capabilities: string[] = []): { repoRoot: string; companionPath: string } {
  const root = makeTempDir("session-guidance-");
  const repoRoot = path.join(root, "working");
  const companionPath = path.join(root, "companion");

  const configPath = path.join(companionPath, ".mate", "config", "framework.yaml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `capabilities:\n${capabilities.map((name) => `  - name: ${name}\n`).join("")}`,
    "utf8",
  );

  const registryPath = repoLocalRegistryPath(repoRoot);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, REGISTRY_CONTENT, "utf8");
  writeProjectionPair(repoRoot, {
    stamp: "stamp",
    projection: {
      version: "0.0.0",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme",
      wrapperBinPath: path.join(companionPath, ".mate", "wrappers", "bin"),
      reactDoctorBinPath: path.join(companionPath, "react-doctor"),
      graphifyOut: path.join(companionPath, ".graphify", "acme", "graphify-out"),
    },
  });

  return { repoRoot, companionPath };
}

function additionalContext(stdout: string): string {
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("session-guidance hook module", () => {
  test("emits the companion policy as SessionStart additionalContext", () => {
    const { repoRoot, companionPath } = wrapRepo();

    const result = buildSessionGuidance({}, repoRoot);

    expect(result.exitCode).toBe(0);
    const context = additionalContext(result.stdout);
    expect(context).toContain("<companion-policy ");
    expect(context).toContain(companionPath);
    expect(context).toContain(repoRoot);
    expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  test("names the projected wrapper bin, not the running installation's", () => {
    const { repoRoot, companionPath } = wrapRepo();

    const context = additionalContext(buildSessionGuidance({}, repoRoot).stdout);

    expect(context).toContain(path.join(companionPath, ".mate", "wrappers", "bin", "openspec"));
  });

  /** Predicates are read live, so a capability toggled after the wrap crosses over. */
  test("reflects capabilities enabled after the wrap without a re-wrap", () => {
    const { repoRoot } = wrapRepo(["tokensave", "openspec"]);

    const context = additionalContext(buildSessionGuidance({}, repoRoot).stdout);

    expect(context).toContain("<codebase-exploration-rules ");
    expect(context).toContain('rule id="openspec-finish"');
  });

  test("omits exploration rules when no exploration capability is enabled", () => {
    const { repoRoot } = wrapRepo(["react-doctor"]);

    const context = additionalContext(buildSessionGuidance({}, repoRoot).stdout);

    expect(context).not.toContain("<codebase-exploration-rules ");
  });

  /**
   * The launch appended the guidance already. Emitting here too would double it
   * in exactly the session that is configured correctly.
   */
  test("emits nothing for a managed session", () => {
    const { repoRoot, companionPath } = wrapRepo();

    const result = buildSessionGuidance({ MATE_ARTIFACT_PATH: companionPath }, repoRoot);

    expect(result).toEqual({ exitCode: 0, stdout: "" });
  });

  test("emits nothing in an unwrapped repository", () => {
    const result = buildSessionGuidance({}, makeTempDir("session-guidance-bare-"));

    expect(result).toEqual({ exitCode: 0, stdout: "" });
  });
});

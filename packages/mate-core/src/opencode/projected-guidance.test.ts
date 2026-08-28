import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { buildOpenCodeGuidance } from "../runtime/companion-guidance";
import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { resolveOpenCodeGuidance } from "./projected-guidance";

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function wrapRepo(capabilities: string[] = []): { repoRoot: string; companionPath: string } {
  const root = makeTempDir("opencode-guidance-");
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
  fs.writeFileSync(registryPath, "companions: []\n", "utf8");
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

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveOpenCodeGuidance", () => {
  test("prefers the launch payload over the projection", () => {
    const { repoRoot } = wrapRepo(["tokensave"]);
    const injected = buildOpenCodeGuidance([{ name: "openspec" }]);

    const { guidance, errors } = resolveOpenCodeGuidance(
      { MATE_GUIDANCE_JSON: JSON.stringify(injected) },
      repoRoot,
    );

    expect(errors).toEqual([]);
    expect(guidance?.companionGuidance).toContain('rule id="openspec-finish"');
    expect(guidance?.codebaseExplorationGuidance).toBe("");
  });

  /** The payload the plugin would have received from a launch, built from files. */
  test("builds the launch payload from the projection when no launch injected one", () => {
    const { repoRoot } = wrapRepo(["tokensave", "openspec"]);

    const { guidance, errors } = resolveOpenCodeGuidance({}, repoRoot);

    expect(errors).toEqual([]);
    expect(guidance).toEqual(buildOpenCodeGuidance([{ name: "tokensave" }, { name: "openspec" }]));
  });

  /** Placeholders, not resolved paths: the plugin materializes them itself. */
  test("keeps the $MATE_* placeholders in the projected payload", () => {
    const { repoRoot } = wrapRepo();

    const { guidance } = resolveOpenCodeGuidance({}, repoRoot);

    expect(guidance?.companionGuidance).toContain("$MATE_ARTIFACT_PATH");
    expect(guidance?.companionGuidance).toContain("$MATE_WRAPPER_BIN_PATH");
  });

  /**
   * A launch that failed to inject is broken, and the projection must not
   * quietly stand in for it — that would hide a misconfigured `mate opencode`.
   */
  test("a launch environment without a payload stays a startup error", () => {
    const { repoRoot, companionPath } = wrapRepo();

    const { guidance, errors } = resolveOpenCodeGuidance(
      { MATE_ARTIFACT_PATH: companionPath },
      repoRoot,
    );

    expect(guidance).toBeNull();
    expect(errors).toEqual(["missing MATE_GUIDANCE_JSON in the launch environment"]);
  });

  test("is inert with neither a payload nor a projection", () => {
    const result = resolveOpenCodeGuidance({}, makeTempDir("opencode-guidance-bare-"));

    expect(result).toEqual({ guidance: null, errors: [] });
  });

  test("reports a malformed payload rather than falling back", () => {
    const { repoRoot } = wrapRepo();

    const { guidance, errors } = resolveOpenCodeGuidance({ MATE_GUIDANCE_JSON: "{" }, repoRoot);

    expect(guidance).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });
});

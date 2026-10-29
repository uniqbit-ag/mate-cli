import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { buildOpenCodeGuidance } from "../runtime/companion-guidance";
import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { trustProjection } from "../../test/trusted-projection";
import { resolveOpenCodeGuidance } from "./projected-guidance";

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/** `env` is a plain session's, whose Mate configuration trusts the projection. */
function wrapRepo(capabilities: string[] = []): {
  root: string;
  repoRoot: string;
  companionPath: string;
  env: { HOME: string };
} {
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

  const home = path.join(root, "home");
  const env = trustProjection({ home, companionPath, repoRoot, repositoryId: "acme" });
  return { root, repoRoot, companionPath, env };
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
    expect(guidance?.companionGuidance).toContain('rule id="openspec-publish"');
    expect(guidance?.codebaseExplorationGuidance).toBe("");
  });

  /** The payload the plugin would have received from a launch, built from files. */
  test("builds the launch payload from the projection when no launch injected one", () => {
    const { repoRoot, env } = wrapRepo(["tokensave", "openspec"]);

    const { guidance, errors } = resolveOpenCodeGuidance(env, repoRoot);

    expect(errors).toEqual([]);
    expect(guidance).toEqual(buildOpenCodeGuidance([{ name: "tokensave" }, { name: "openspec" }]));
  });

  /** Placeholders, not resolved paths: the plugin materializes them itself. */
  test("keeps the $MATE_* placeholders in the projected payload", () => {
    const { repoRoot, env } = wrapRepo();

    const { guidance } = resolveOpenCodeGuidance(env, repoRoot);

    expect(guidance?.companionGuidance).toContain("$MATE_ARTIFACT_PATH");
    expect(guidance?.companionGuidance).toContain("$MATE_WRAPPER_BIN_PATH");
  });

  /**
   * The plugin hands over `{}` for inherited `MATE_*` variables
   * (`pluginLaunchEnvironment`), so any variable that reaches here is a launch's
   * and no projection is read.
   */
  test("a launch environment without a payload builds no projected guidance", () => {
    const { repoRoot, env } = wrapRepo(["tokensave"]);

    const result = resolveOpenCodeGuidance(
      { ...env, MATE_ARTIFACT_PATH: "/other/companion", MATE_REPO_PATH: "/other/repo" },
      repoRoot,
    );

    expect(result).toEqual({ guidance: null, errors: [] });
  });

  test("is inert for a projection Session Resolution refuses", () => {
    const { root, repoRoot } = wrapRepo(["tokensave"]);

    const result = resolveOpenCodeGuidance({ HOME: path.join(root, "other-home") }, repoRoot);

    expect(result).toEqual({ guidance: null, errors: [] });
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

  test("reads the secret guardrails switch live from the companion", () => {
    const { repoRoot, companionPath, env } = wrapRepo();
    expect(resolveOpenCodeGuidance(env, repoRoot).guidance?.companionGuidance).toContain(
      'id="secret-handling"',
    );

    const configPath = path.join(companionPath, ".mate", "config", "framework.yaml");
    fs.writeFileSync(configPath, "secrets:\n  guardrails: false\n", "utf8");
    expect(resolveOpenCodeGuidance(env, repoRoot).guidance?.companionGuidance).not.toContain(
      "secret-handling",
    );
  });
});

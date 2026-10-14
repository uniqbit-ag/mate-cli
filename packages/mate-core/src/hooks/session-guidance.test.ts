import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { audienceLayerDir } from "../runtime/audience-layer";
import { writeProjectionPair } from "../runtime/projection";
import {
  CLAUDE_SETTINGS_DOCUMENT,
  EMPTY_MANIFEST,
  manifestPath,
  serializeManifest,
  withAudience,
  withDocument,
} from "../runtime/runtime-document-manifest";
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
    expect(context).toContain('rule id="openspec-publish"');
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

  describe("a checkout wrapped for an audience", () => {
    /** Records `audience` in the wrap and renders its layer with `guidance` in `CLAUDE.md`. */
    function wrapForAudience(audience: string | null, guidance: string) {
      const { repoRoot, companionPath } = wrapRepo();
      const manifest = withAudience(
        withDocument(EMPTY_MANIFEST, CLAUDE_SETTINGS_DOCUMENT, []),
        audience,
      );
      fs.writeFileSync(manifestPath(repoRoot), serializeManifest(manifest) ?? "", "utf8");
      for (const name of ["ba", "qa"]) {
        const version = path.join(audienceLayerDir(companionPath, name), "f1");
        fs.mkdirSync(version, { recursive: true });
        fs.writeFileSync(
          path.join(version, "CLAUDE.md"),
          `<!-- mate:managed:${name}-plugin:abc start -->\n${guidance.replace("ba", name)}\n<!-- mate:managed:${name}-plugin:abc end -->\n`,
          "utf8",
        );
        fs.rmSync(path.join(audienceLayerDir(companionPath, name), "current"), { force: true });
        fs.symlinkSync("f1", path.join(audienceLayerDir(companionPath, name), "current"));
        tempRoots.push(audienceLayerDir(companionPath, name));
      }
      return { repoRoot };
    }

    test("appends the wrapped audience's layer guidance after the companion policy", () => {
      const { repoRoot } = wrapForAudience("ba", "Guidance for ba.");

      const context = additionalContext(buildSessionGuidance({}, repoRoot).stdout);

      expect(context).toContain("Guidance for ba.");
      expect(context).not.toContain("Guidance for qa.");
      expect(context).not.toContain("mate:managed");
      expect(context.indexOf("Guidance for ba.")).toBeGreaterThan(
        context.indexOf("<companion-policy "),
      );
    });

    test("a checkout wrapped for base gets no layer guidance, whatever MATE_AUDIENCE says", () => {
      const { repoRoot } = wrapForAudience(null, "Guidance for ba.");

      const context = additionalContext(
        buildSessionGuidance({ MATE_AUDIENCE: "ba" }, repoRoot).stdout,
      );

      expect(context).not.toContain("Guidance for");
    });
  });
});

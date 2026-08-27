import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { MATE_ENV, isManagedCompanionContext, readCompanionRuntimeContext } from "./env";
import { companionFrameworkConfigPath } from "./policy";
import { writeProjectionPair, type MateProjection } from "./projection";
import { repoLocalRegistryPath } from "./repo-local";

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/**
 * A Working Repository with a repo-local registry, a projection, and the
 * companion the projection points at. Returns the repo root to resolve from.
 */
function makeProjectedRepo(
  overrides: Partial<MateProjection> = {},
  companionConfig = "allowedAgents:\n  - claude\ncapabilities:\n  - name: graphify\ngit: auto\n",
): { repoRoot: string; companionPath: string } {
  const root = makeTempDir("env-projected-");
  const repoRoot = path.join(root, "working");
  const companionPath = path.join(root, "companion");

  const registryPath = repoLocalRegistryPath(repoRoot);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, "companions: []\n", "utf8");

  const configPath = companionFrameworkConfigPath(companionPath);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, companionConfig, "utf8");

  writeProjectionPair(repoRoot, {
    stamp: "stamp",
    projection: {
      version: "0.15.5",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme",
      wrapperBinPath: "/install/mate/wrappers/bin",
      reactDoctorBinPath: "/install/mate/node_modules/.bin/react-doctor",
      graphifyOut: path.join(companionPath, ".graphify", "acme", "graphify-out"),
      ...overrides,
    },
  });

  return { repoRoot, companionPath };
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("MATE_ENV", () => {
  test("exposes the stable launch environment variable names", () => {
    expect(MATE_ENV.frameworkName).toBe("MATE_NAME");
    expect(MATE_ENV.version).toBe("MATE_VERSION");
    expect(MATE_ENV.companionPath).toBe("MATE_ARTIFACT_PATH");
    expect(MATE_ENV.wrapperBinPath).toBe("MATE_WRAPPER_BIN_PATH");
    expect(MATE_ENV.repositoryPath).toBe("MATE_REPO_PATH");
    expect(MATE_ENV.repositoryId).toBe("MATE_REPO_ID");
    expect(MATE_ENV.policyJson).toBe("MATE_POLICY_JSON");
    expect(MATE_ENV.graphifyEnabled).toBe("MATE_GRAPHIFY_ENABLED");
    expect(MATE_ENV.gitAutoMode).toBe("MATE_GIT_AUTO_MODE");
    expect(MATE_ENV.reactDoctorEnabled).toBe("MATE_REACT_DOCTOR_ENABLED");
    expect(MATE_ENV.reactDoctorBinPath).toBe("MATE_REACT_DOCTOR_BIN_PATH");
    expect(MATE_ENV.guidanceJson).toBe("MATE_GUIDANCE_JSON");
  });
});

describe("readCompanionRuntimeContext", () => {
  test("normalizes a fully managed environment", () => {
    const context = readCompanionRuntimeContext({
      MATE_NAME: "acme-mate",
      MATE_ARTIFACT_PATH: "/companions/acme",
      MATE_REPO_PATH: "/repos/acme",
      MATE_REPO_ID: "acme",
      MATE_POLICY_JSON: '{"allowedAgents":["opencode"]}',
      MATE_GRAPHIFY_ENABLED: "1",
      MATE_GIT_AUTO_MODE: "0",
      MATE_REACT_DOCTOR_ENABLED: "1",
    });

    expect(context).toEqual({
      frameworkName: "acme-mate",
      companionPath: "/companions/acme",
      repositoryPath: "/repos/acme",
      repositoryId: "acme",
      policyJson: '{"allowedAgents":["opencode"]}',
      graphifyEnabled: true,
      gitAutoModeEnabled: false,
      reactDoctorEnabled: true,
    });
  });

  test("falls back to inert defaults when neither the environment nor a projection resolves", () => {
    const context = readCompanionRuntimeContext({}, makeTempDir("env-unprojected-"));

    expect(context.frameworkName).toBe("mate");
    expect(context.companionPath).toBe("");
    expect(context.repositoryPath).toBe("");
    expect(context.policyJson).toBe("{}");
    expect(context.graphifyEnabled).toBe(false);
    expect(context.gitAutoModeEnabled).toBe(false);
    expect(context.reactDoctorEnabled).toBe(false);
  });

  test("treats non-'1' flag values as disabled", () => {
    const context = readCompanionRuntimeContext({
      MATE_GRAPHIFY_ENABLED: "true",
      MATE_GIT_AUTO_MODE: "yes",
      MATE_REACT_DOCTOR_ENABLED: "0",
    });

    expect(context.graphifyEnabled).toBe(false);
    expect(context.gitAutoModeEnabled).toBe(false);
    expect(context.reactDoctorEnabled).toBe(false);
  });
});

describe("readCompanionRuntimeContext file-backed composition", () => {
  test("resolves a full context from files with an empty environment", () => {
    const { repoRoot, companionPath } = makeProjectedRepo();

    const context = readCompanionRuntimeContext({}, repoRoot);

    expect(context).toEqual({
      frameworkName: "mate",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme",
      policyJson: JSON.stringify({ allowedAgents: ["claude"] }),
      graphifyEnabled: true,
      gitAutoModeEnabled: true,
      reactDoctorEnabled: false,
    });
    expect(isManagedCompanionContext(context)).toBe(true);
  });

  test("resolves from a nested subdirectory of the Working Repository", () => {
    const { repoRoot, companionPath } = makeProjectedRepo();
    const nested = path.join(repoRoot, "packages", "acme");
    fs.mkdirSync(nested, { recursive: true });

    expect(readCompanionRuntimeContext({}, nested).companionPath).toBe(companionPath);
  });

  test("reads predicates live from the companion rather than from the projection", () => {
    const { repoRoot, companionPath } = makeProjectedRepo();
    fs.writeFileSync(
      companionFrameworkConfigPath(companionPath),
      "allowedAgents: []\ncapabilities:\n  - name: react-doctor\n",
      "utf8",
    );

    const context = readCompanionRuntimeContext({}, repoRoot);

    expect(context.graphifyEnabled).toBe(false);
    expect(context.reactDoctorEnabled).toBe(true);
    expect(context.gitAutoModeEnabled).toBe(false);
    expect(context.policyJson).toBe(JSON.stringify({ allowedAgents: [] }));
  });

  test("a managed session ignores a projection naming a different companion", () => {
    const { repoRoot } = makeProjectedRepo();

    const context = readCompanionRuntimeContext(
      {
        MATE_ARTIFACT_PATH: "/companions/from-env",
        MATE_REPO_PATH: "/repos/from-env",
        MATE_REPO_ID: "from-env",
      },
      repoRoot,
    );

    expect(context.companionPath).toBe("/companions/from-env");
    expect(context.repositoryPath).toBe("/repos/from-env");
    expect(context.repositoryId).toBe("from-env");
  });

  test("a truncated projection cannot break a managed session", () => {
    const { repoRoot } = makeProjectedRepo();
    const yamlPath = path.join(repoRoot, ".mate", "projection.yaml");
    fs.writeFileSync(yamlPath, fs.readFileSync(yamlPath, "utf8").slice(0, 40), "utf8");

    const context = readCompanionRuntimeContext(
      { MATE_ARTIFACT_PATH: "/companions/from-env", MATE_REPO_PATH: "/repos/from-env" },
      repoRoot,
    );

    expect(context.companionPath).toBe("/companions/from-env");
  });

  test("a truncated projection yields an inert context for an unmanaged session", () => {
    const { repoRoot } = makeProjectedRepo();
    const yamlPath = path.join(repoRoot, ".mate", "projection.yaml");
    fs.writeFileSync(yamlPath, fs.readFileSync(yamlPath, "utf8").slice(0, 40), "utf8");

    expect(readCompanionRuntimeContext({}, repoRoot).companionPath).toBe("");
  });

  test("any MATE_ variable present keeps the environment authoritative", () => {
    const { repoRoot } = makeProjectedRepo();

    expect(readCompanionRuntimeContext({ MATE_NAME: "acme-mate" }, repoRoot)).toEqual({
      frameworkName: "acme-mate",
      companionPath: "",
      repositoryPath: "",
      repositoryId: "",
      policyJson: "{}",
      graphifyEnabled: false,
      gitAutoModeEnabled: false,
      reactDoctorEnabled: false,
    });
  });
});

describe("isManagedCompanionContext", () => {
  test("requires both companion and repository paths", () => {
    const managed = readCompanionRuntimeContext({
      MATE_ARTIFACT_PATH: "/companions/acme",
      MATE_REPO_PATH: "/repos/acme",
    });
    const missingRepo = readCompanionRuntimeContext({
      MATE_ARTIFACT_PATH: "/companions/acme",
    });
    const missingCompanion = readCompanionRuntimeContext({
      MATE_REPO_PATH: "/repos/acme",
    });

    expect(isManagedCompanionContext(managed)).toBe(true);
    expect(isManagedCompanionContext(missingRepo)).toBe(false);
    expect(isManagedCompanionContext(missingCompanion)).toBe(false);
  });
});

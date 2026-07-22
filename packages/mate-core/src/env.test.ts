import { describe, expect, test } from "bun:test";

import { MATE_ENV, isManagedCompanionContext, readCompanionRuntimeContext } from "./env";

describe("MATE_ENV", () => {
  test("exposes the stable launch environment variable names", () => {
    expect(MATE_ENV.frameworkName).toBe("MATE_NAME");
    expect(MATE_ENV.version).toBe("MATE_VERSION");
    expect(MATE_ENV.companionPath).toBe("MATE_ARTIFACT_PATH");
    expect(MATE_ENV.wrapperBinPath).toBe("MATE_WRAPPER_BIN_PATH");
    expect(MATE_ENV.repositoryPath).toBe("MATE_REPO_PATH");
    expect(MATE_ENV.repositoryId).toBe("MATE_REPO_ID");
    expect(MATE_ENV.repositoryProfile).toBe("MATE_REPO_PROFILE");
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
      MATE_REPO_PROFILE: "default",
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
      repositoryProfile: "default",
      policyJson: '{"allowedAgents":["opencode"]}',
      graphifyEnabled: true,
      gitAutoModeEnabled: false,
      reactDoctorEnabled: true,
    });
  });

  test("falls back to inert defaults when the environment is unmanaged", () => {
    const context = readCompanionRuntimeContext({});

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

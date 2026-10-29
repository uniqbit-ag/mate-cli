import { describe, expect, test } from "bun:test";

import { MATE_ENV } from "./env-names";

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

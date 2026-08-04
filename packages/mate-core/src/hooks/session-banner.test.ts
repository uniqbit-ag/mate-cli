import { describe, expect, test } from "bun:test";

import { buildBanner } from "./session-banner";

describe("session-banner hook module", () => {
  test("emits a systemMessage banner with repo and artifact paths", () => {
    const result = buildBanner({
      MATE_REPO_PATH: "/work/acme",
      MATE_ARTIFACT_PATH: "/companions/acme-companion",
      MATE_VERSION: "1.2.3",
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { systemMessage: string };
    expect(payload.systemMessage).toContain("mate v1.2.3");
    expect(payload.systemMessage).toContain("/work/acme");
    expect(payload.systemMessage).toContain("/companions/acme-companion");
  });

  test("falls back to unknown version", () => {
    const result = buildBanner({
      MATE_REPO_PATH: "/work/acme",
      MATE_ARTIFACT_PATH: "/companions/acme-companion",
    });
    expect(JSON.parse(result.stdout).systemMessage).toContain("mate vunknown");
  });

  test("stays silent outside managed sessions", () => {
    expect(buildBanner({})).toEqual({ exitCode: 0, stdout: "" });
    expect(buildBanner({ MATE_REPO_PATH: "/work/acme" })).toEqual({ exitCode: 0, stdout: "" });
    expect(buildBanner({ MATE_ARTIFACT_PATH: "/companions/x" })).toEqual({
      exitCode: 0,
      stdout: "",
    });
  });
});

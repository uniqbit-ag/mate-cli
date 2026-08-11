import { describe, expect, test } from "bun:test";

import { InvalidDoctorResponseError, parseDoctorReport } from "./doctor-schema";

describe("parseDoctorReport", () => {
  test("parses a full report", () => {
    const raw = JSON.stringify({
      multipleCompanions: [{ companionPath: "/c/a", repositoryId: "app" }],
      policyError: "no repository id",
      toolInstallations: [{ tool: "openspec", status: "missing" }],
      requiredPluginDrift: [{ pluginId: "tokensave", kind: "required", reason: "not installed" }],
      engineRequirement: { ok: false, detail: "requires >=1.0.0" },
      hub: { members: [{ id: "m1", path: "/hub/m1", exists: true, commitStatus: "drifted" }] },
      resolutionFailures: [{ companionPath: "/c/b", message: "unreadable config" }],
    });

    expect(parseDoctorReport(raw)).toEqual({
      multipleCompanions: [{ companionPath: "/c/a", repositoryId: "app" }],
      policyError: "no repository id",
      toolInstallations: [{ tool: "openspec", status: "missing" }],
      requiredPluginDrift: [{ pluginId: "tokensave", reason: "not installed" }],
      engineRequirement: { ok: false, detail: "requires >=1.0.0" },
      hubMembers: [{ id: "m1", path: "/hub/m1", exists: true, commitStatus: "drifted" }],
      resolutionFailures: [{ companionPath: "/c/b", message: "unreadable config" }],
    });
  });

  test("defaults every optional section for a minimal report", () => {
    expect(parseDoctorReport(JSON.stringify({}))).toEqual({
      multipleCompanions: [],
      policyError: undefined,
      toolInstallations: [],
      requiredPluginDrift: [],
      engineRequirement: undefined,
      hubMembers: [],
      resolutionFailures: [],
    });
  });

  test("rejects malformed JSON", () => {
    expect(() => parseDoctorReport("not json")).toThrow(InvalidDoctorResponseError);
  });

  test("rejects a non-object top level", () => {
    expect(() => parseDoctorReport(JSON.stringify([]))).toThrow(InvalidDoctorResponseError);
  });

  test("drops a malformed hub member instead of throwing", () => {
    const raw = JSON.stringify({ hub: { members: [{ id: "m1" }, { id: "m2", path: "/hub/m2" }] } });

    expect(parseDoctorReport(raw).hubMembers).toEqual([
      { id: "m2", path: "/hub/m2", exists: false, commitStatus: "ok" },
    ]);
  });
});

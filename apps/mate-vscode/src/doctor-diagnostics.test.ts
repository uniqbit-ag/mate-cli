import { afterEach, describe, expect, mock, test } from "bun:test";

import { createVscodeMock } from "./test-support/vscode-mock";

afterEach(() => {
  mock.restore();
});

async function load() {
  return import("./doctor-diagnostics");
}

function reportJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    multipleCompanions: [],
    toolInstallations: [],
    requiredPluginDrift: [],
    resolutionFailures: [],
    ...overrides,
  });
}

describe("collectDoctorFindings", () => {
  test("maps a resolution failure to a file-scoped finding", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { collectDoctorFindings } = await load();
    const { parseDoctorReport } = await import("./doctor-schema");

    const report = parseDoctorReport(
      reportJson({ resolutionFailures: [{ companionPath: "/c/a", message: "unreadable config" }] }),
    );

    const findings = collectDoctorFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.filePath).toBe("/c/a");
    expect(findings[0]?.message).toContain("unreadable config");
  });

  test("maps a missing tool to a workspace-scoped finding (no filePath)", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { collectDoctorFindings } = await load();
    const { parseDoctorReport } = await import("./doctor-schema");

    const report = parseDoctorReport(
      reportJson({ toolInstallations: [{ tool: "openspec", status: "missing" }] }),
    );

    const findings = collectDoctorFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.filePath).toBeUndefined();
    expect(findings[0]?.message).toContain("openspec");
  });

  test("produces no findings for a clean report", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { collectDoctorFindings } = await load();
    const { parseDoctorReport } = await import("./doctor-schema");

    expect(collectDoctorFindings(parseDoctorReport(reportJson()))).toEqual([]);
  });
});

describe("DoctorDiagnostics.refresh", () => {
  test("populates the diagnostic collection keyed by file URI for a file-scoped finding", async () => {
    const { module, diagnosticCollections } = createVscodeMock();
    mock.module("vscode", () => module);
    const { DoctorDiagnostics } = await load();

    const diagnostics = new DoctorDiagnostics({
      options: () => ({}),
      runMateCli: async () => ({
        code: 0,
        stdout: reportJson({ resolutionFailures: [{ companionPath: "/c/a", message: "boom" }] }),
        stderr: "",
      }),
    });

    await diagnostics.refresh();

    expect(diagnosticCollections[0]?.size).toBe(1);
  });

  test("clears the collection when mate doctor reports no findings", async () => {
    const { module, diagnosticCollections } = createVscodeMock();
    mock.module("vscode", () => module);
    const { DoctorDiagnostics } = await load();

    const diagnostics = new DoctorDiagnostics({
      options: () => ({}),
      runMateCli: async () => ({ code: 0, stdout: reportJson(), stderr: "" }),
    });

    await diagnostics.refresh();

    expect(diagnosticCollections[0]?.size).toBe(0);
  });

  test("clears the collection without throwing when mate is unavailable", async () => {
    const { module, diagnosticCollections } = createVscodeMock();
    mock.module("vscode", () => module);
    const { DoctorDiagnostics } = await load();

    const diagnostics = new DoctorDiagnostics({
      options: () => ({}),
      runMateCli: async () => ({ code: 1, stdout: "", stderr: "mate: not found" }),
    });

    await diagnostics.refresh();

    expect(diagnosticCollections[0]?.size).toBe(0);
  });
});

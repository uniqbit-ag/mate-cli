import { describe, expect, spyOn, test } from "bun:test";

import { isInstallRecoveryCommand, main } from "./main";

describe("isInstallRecoveryCommand", () => {
  test("keeps install lifecycle recovery commands available", () => {
    expect(isInstallRecoveryCommand("install")).toBe(true);
    expect(isInstallRecoveryCommand("update")).toBe(true);
    expect(isInstallRecoveryCommand("doctor")).toBe(true);
    expect(isInstallRecoveryCommand("--help")).toBe(true);
    expect(isInstallRecoveryCommand("companion", "setup")).toBe(true);
    expect(isInstallRecoveryCommand("companion", "link")).toBe(true);
  });

  test("does not exempt normal commands", () => {
    expect(isInstallRecoveryCommand("report")).toBe(false);
    expect(isInstallRecoveryCommand("cap", "index")).toBe(false);
  });

  test("selects a companion before normal command install preflight", async () => {
    const originalExitCode = process.exitCode;
    let selected = false;
    let preflightSawSelection = false;

    try {
      await main(["node", "mate", "report"], {
        ensureUnambiguousCompanion: async () => {
          selected = true;
          return true;
        },
        inspectInstallPreflight: async () => {
          preflightSawSelection = selected;
          return { ok: false, reason: "test preflight" };
        },
      });
    } finally {
      process.exitCode = originalExitCode ?? 0;
    }

    expect(preflightSawSelection).toBe(true);
    expect(process.exitCode).toBe(originalExitCode ?? 0);
  });

  test("recovery commands still run when the version guard reports an unsatisfied engines.mate", async () => {
    const originalExitCode = process.exitCode;
    const engineGuardFailure = {
      ok: false,
      reason:
        "This companion requires mate-cli >=99.0.0, but 0.14.3 is installed. Run `mate update`.",
    };
    let preflightCalls = 0;
    const deps = {
      ensureUnambiguousCompanion: async () => true,
      inspectInstallPreflight: async () => {
        preflightCalls++;
        return engineGuardFailure;
      },
    };
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await main(["node", "mate", "doctor"], deps);
    } finally {
      logSpy.mockRestore();
      process.exitCode = originalExitCode ?? 0;
    }

    expect(preflightCalls).toBe(0);
    expect(process.exitCode).toBe(originalExitCode ?? 0);
  });

  test("help/--help/-h bypass the version guard entirely", async () => {
    const originalExitCode = process.exitCode;
    let preflightCalls = 0;
    const deps = {
      ensureUnambiguousCompanion: async () => true,
      inspectInstallPreflight: async () => {
        preflightCalls++;
        return { ok: false, reason: "engines.mate mismatch" };
      },
    };
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await main(["node", "mate", "help"], deps);
      await main(["node", "mate", "--help"], deps);
      await main(["node", "mate", "-h"], deps);
    } finally {
      logSpy.mockRestore();
      process.exitCode = originalExitCode ?? 0;
    }

    expect(preflightCalls).toBe(0);
    expect(process.exitCode).toBe(originalExitCode ?? 0);
  });
});

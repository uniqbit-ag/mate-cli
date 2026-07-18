import { describe, expect, test } from "bun:test";

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
});

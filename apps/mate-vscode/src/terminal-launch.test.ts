import { describe, expect, test } from "bun:test";

import { buildTerminalLaunchPlan, type PairingLaunchContext } from "./terminal-launch";

const PAIRING: PairingLaunchContext = {
  repositoryId: "app",
  repositoryPath: "/repos/app",
  companionPath: "/companions/a",
};

describe("buildTerminalLaunchPlan", () => {
  test("pins the working repository as cwd", () => {
    const plan = buildTerminalLaunchPlan("opencode", PAIRING, "darwin");

    expect(plan.cwd).toBe("/repos/app");
  });

  test("supplies the pairing through Mate's stable launch environment variables", () => {
    const plan = buildTerminalLaunchPlan("claude", PAIRING, "darwin");

    expect(plan.env).toEqual({
      MATE_REPO_PATH: "/repos/app",
      MATE_ARTIFACT_PATH: "/companions/a",
      MATE_REPO_ID: "app",
    });
  });

  test("never interpolates a path into the command line", () => {
    const plan = buildTerminalLaunchPlan("opencode", PAIRING, "darwin");

    expect(plan.commandLine).toBe("mate opencode");
    expect(plan.commandLine).not.toContain("/repos/app");
    expect(plan.commandLine).not.toContain("/companions/a");
  });

  test("selects the fixed command for each supported agent", () => {
    expect(buildTerminalLaunchPlan("opencode", PAIRING).commandLine).toBe("mate opencode");
    expect(buildTerminalLaunchPlan("claude", PAIRING).commandLine).toBe("mate claude");
  });

  for (const platform of ["darwin", "linux", "win32"] as const) {
    test(`produces the identical launch plan on ${platform}`, () => {
      const plan = buildTerminalLaunchPlan("opencode", PAIRING, platform);

      expect(plan).toEqual({
        name: "Mate OpenCode · app",
        cwd: "/repos/app",
        env: {
          MATE_REPO_PATH: "/repos/app",
          MATE_ARTIFACT_PATH: "/companions/a",
          MATE_REPO_ID: "app",
        },
        commandLine: "mate opencode",
      });
    });
  }
});

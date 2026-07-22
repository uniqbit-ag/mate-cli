import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CapabilityConfig } from "../../../lib/orchestrator/types";
import { runTokensaveCapCommand } from "./tokensave";

const repoPath = "/tmp/work-repo";

function makeResolveForLaunch(capabilities: CapabilityConfig[]) {
  return async () => ({
    repositoryId: "repo-1",
    configStore: {
      load: async () => ({ capabilities }),
    },
    workingRepoStore: {
      load: async () => ({
        repos: [{ id: "repo-1", path: repoPath }],
      }),
    },
  });
}

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe("runTokensaveCapCommand", () => {
  test("installs tokensave before invoking the CLI when it is missing", async () => {
    const ensureInstalled = mock(async () => true);
    const spawn = mock(() => ({ status: 0, error: undefined }));

    await runTokensaveCapCommand(["sync"], {
      resolveForLaunch: makeResolveForLaunch([
        { name: "tokensave" },
      ]) as typeof makeResolveForLaunch,
      ensureInstalled,
      spawn: spawn as typeof spawn,
    });

    expect(ensureInstalled).toHaveBeenCalledWith(repoPath);
    expect(spawn).toHaveBeenCalledWith("tokensave", ["sync"], {
      cwd: repoPath,
      stdio: "inherit",
    });
    expect(process.exitCode).toBe(0);
  });

  test("fails fast when tokensave installation fails", async () => {
    const ensureInstalled = mock(async () => false);
    const spawn = mock(() => ({ status: 0, error: undefined }));

    await runTokensaveCapCommand(["sync"], {
      resolveForLaunch: makeResolveForLaunch([
        { name: "tokensave" },
      ]) as typeof makeResolveForLaunch,
      ensureInstalled,
      spawn: spawn as typeof spawn,
    });

    expect(ensureInstalled).toHaveBeenCalledWith(repoPath);
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

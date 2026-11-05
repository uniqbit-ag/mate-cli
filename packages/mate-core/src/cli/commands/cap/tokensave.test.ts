import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { createTempDir } from "../../../../../../test/fixtures";
import { addWorktree, initRepo } from "../../../../test/git-checkouts";
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

  test("runs in the linked worktree of the working repository it is called from", async () => {
    const root = await createTempDir("mate-cap-tokensave-");
    try {
      const main = initRepo(path.join(root, "acme"));
      const worktree = addWorktree(main, path.join(root, "acme.worktrees", "fix"));
      const spawn = mock(() => ({ status: 0, error: undefined }));
      const resolveForLaunch = async () => ({
        ...(await makeResolveForLaunch([{ name: "tokensave" }])()),
        repository: { id: "repo-1", path: main },
      });

      await runTokensaveCapCommand(["sync"], {
        resolveForLaunch: resolveForLaunch as never,
        ensureInstalled: async () => true,
        spawn: spawn as never,
        cwd: () => worktree,
      });

      expect(spawn).toHaveBeenCalledWith("tokensave", ["sync"], {
        cwd: worktree,
        stdio: "inherit",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

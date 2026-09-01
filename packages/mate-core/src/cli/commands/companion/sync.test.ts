import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { CompanionGitSyncError } from "../../../lib/orchestrator/companion-git-sync";
import { emptyCompanionPolicy, type CompanionPolicy } from "../../../runtime/policy";
import { companionSyncDeps, runCompanionSyncCommand } from "./sync";

const original = { ...companionSyncDeps };

function policy(gitAutoMode: boolean): CompanionPolicy {
  return { ...emptyCompanionPolicy(), gitAutoMode };
}

function captureOutput(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    },
  };
}

let originalExitCode: number | undefined;

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = 0;
});

afterEach(() => {
  Object.assign(companionSyncDeps, original);
  process.exitCode = originalExitCode ?? 0;
});

describe("mate companion sync", () => {
  test("synchronizes interactively and reports the companion and that it changed", async () => {
    const syncCompanionGit = mock(async () => ({
      skipped: false,
      changed: true,
      companionPath: "/tmp/acme-companion",
    }));
    Object.assign(companionSyncDeps, {
      resolveCompanionPath: async () => "/tmp/acme-companion",
      resolveRepoPath: async () => "/tmp/acme",
      readCompanionPolicy: () => policy(true),
      syncCompanionGit,
    });

    const captured = captureOutput();
    try {
      await runCompanionSyncCommand();
    } finally {
      captured.restore();
    }

    expect(syncCompanionGit).toHaveBeenCalledWith("/tmp/acme-companion", "/tmp/acme", true);
    expect(captured.out.join("")).toContain("/tmp/acme-companion");
    expect(captured.out.join("")).toContain("updated");
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("reports that nothing changed", async () => {
    Object.assign(companionSyncDeps, {
      resolveCompanionPath: async () => "/tmp/acme-companion",
      resolveRepoPath: async () => "/tmp/acme",
      readCompanionPolicy: () => policy(true),
      syncCompanionGit: async () => ({
        skipped: false,
        changed: false,
        companionPath: "/tmp/acme-companion",
      }),
    });

    const captured = captureOutput();
    try {
      await runCompanionSyncCommand();
    } finally {
      captured.restore();
    }

    expect(captured.out.join("")).toContain("no changes");
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("exits non-zero with the preflight's own detail when it cannot complete", async () => {
    Object.assign(companionSyncDeps, {
      resolveCompanionPath: async () => "/tmp/acme-companion",
      resolveRepoPath: async () => "/tmp/acme",
      readCompanionPolicy: () => policy(true),
      syncCompanionGit: async () => {
        throw new CompanionGitSyncError("/tmp/acme-companion", "The merge left conflicts.", [
          "openspec/changes/acme/proposal.md",
        ]);
      },
    });

    const captured = captureOutput();
    try {
      await runCompanionSyncCommand();
    } finally {
      captured.restore();
    }

    expect(captured.err.join("")).toContain("The merge left conflicts.");
    expect(captured.err.join("")).toContain("openspec/changes/acme/proposal.md");
    expect(process.exitCode).toBe(1);
  });

  test("reports nothing to synchronize when the companion is not a Git working tree", async () => {
    Object.assign(companionSyncDeps, {
      resolveCompanionPath: async () => "/tmp/acme-companion",
      resolveRepoPath: async () => "/tmp/acme",
      readCompanionPolicy: () => policy(true),
      syncCompanionGit: async () => ({
        skipped: true,
        changed: false,
        companionPath: "/tmp/acme-companion",
      }),
    });

    const captured = captureOutput();
    try {
      await runCompanionSyncCommand();
    } finally {
      captured.restore();
    }

    expect(captured.out.join("")).toContain("nothing to synchronize");
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("refuses without fetching when the Git policy is not automatic", async () => {
    const syncCompanionGit = mock(async () => ({
      skipped: false,
      changed: false,
      companionPath: "/tmp/acme-companion",
    }));
    Object.assign(companionSyncDeps, {
      resolveCompanionPath: async () => "/tmp/acme-companion",
      resolveRepoPath: async () => "/tmp/acme",
      readCompanionPolicy: () => policy(false),
      syncCompanionGit,
    });

    const captured = captureOutput();
    try {
      await runCompanionSyncCommand();
    } finally {
      captured.restore();
    }

    expect(syncCompanionGit).not.toHaveBeenCalled();
    expect(captured.err.join("")).toContain("Git policy disables synchronization");
    expect(process.exitCode).toBe(1);
  });

  test("refuses with link guidance when no companion resolves", async () => {
    Object.assign(companionSyncDeps, {
      resolveCompanionPath: async () => undefined,
      resolveProjectedCompanionPath: () => undefined,
      resolveRepoPath: async () => "/tmp/acme",
      readCompanionPolicy: () => policy(true),
      syncCompanionGit: async () => {
        throw new Error("must not run");
      },
    });

    const captured = captureOutput();
    try {
      await runCompanionSyncCommand();
    } finally {
      captured.restore();
    }

    expect(captured.err.join("")).toContain("companion link");
    expect(process.exitCode).toBe(1);
  });

  test("passes no working-repo path when the companion is the resolved repository", async () => {
    const syncCompanionGit = mock(async () => ({
      skipped: false,
      changed: false,
      companionPath: "/tmp/acme-companion",
    }));
    Object.assign(companionSyncDeps, {
      resolveCompanionPath: async () => "/tmp/acme-companion",
      resolveRepoPath: async () => "/tmp/acme-companion",
      readCompanionPolicy: () => policy(true),
      syncCompanionGit,
    });

    const captured = captureOutput();
    try {
      await runCompanionSyncCommand();
    } finally {
      captured.restore();
    }

    expect(syncCompanionGit).toHaveBeenCalledWith("/tmp/acme-companion", undefined, true);
  });
});

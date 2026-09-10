import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import type { CapabilityConfig } from "../../../../lib/orchestrator/types";
import { WorkingRepoRequiredError } from "../../../../lib/orchestrator/types";
import { runArtifactPublishCommand, type PublishCommandDeps } from "./command";
import type { ArtifactFinisher, FinisherFactory } from "./finisher";
import type { GitOps } from "./git";

const COMPANION = "/companion";

function makeContext(): LaunchContext {
  return {
    companionPath: COMPANION,
    repositoryId: "repo",
    configStore: {} as LaunchContext["configStore"],
    workingRepoStore: {} as LaunchContext["workingRepoStore"],
  };
}

// A finisher that records what the command asked of it. detectProduced returns null and
// produce/commit are wired so the happy path runs end to end through a stub git.
function recordingFinisher(record: string[], enabled = true): ArtifactFinisher {
  return {
    type: "openspec",
    disabledReason: "mate: the openspec capability must be enabled to run artifact publish.",
    isEnabled: (caps) => enabled && caps.some((c) => c.name === "openspec"),
    async validate() {
      record.push("validate");
      return { valid: true, errors: [] };
    },
    async isComplete() {
      record.push("isComplete");
      return { complete: true, total: 1, remaining: 0 };
    },
    async detectProduced() {
      record.push("detectProduced");
      return null;
    },
    async produce() {
      record.push("produce");
      return {
        ok: true,
        produced: { anchorName: "2026-07-14-x", commitPaths: ["openspec"] },
        message: "",
      };
    },
  };
}

function stubGit(record: string[] = []): GitOps {
  return {
    async headRef() {
      return "HEAD";
    },
    async changedPaths() {
      return [];
    },
    async add() {},
    async hasStagedChanges() {
      return true;
    },
    async commit() {},
    async restorePaths() {},
    async hasUpstream() {
      return false;
    },
    async fetch() {},
    async rebaseOntoUpstream() {
      return { ok: true, conflictedPaths: [] };
    },
    async tagExists() {
      return false;
    },
    async tag() {},
    async push() {
      record.push("push");
      return { ok: true, error: "" };
    },
  };
}

interface HarnessOptions {
  capabilities?: CapabilityConfig[];
  resolveError?: unknown;
  finisherFor?: (type: string) => FinisherFactory | undefined;
  gitError?: string;
  gitRecord?: string[];
}

function makeDeps(
  record: string[],
  options: HarnessOptions = {},
): {
  deps: PublishCommandDeps;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: PublishCommandDeps = {
    resolveContext: async () => {
      if (options.resolveError) throw options.resolveError;
      return makeContext();
    },
    loadCapabilities: async () => options.capabilities ?? [{ name: "openspec" }],
    selectFinisher: options.finisherFor ?? (() => () => recordingFinisher(record)),
    git: () => {
      if (options.gitError) throw new Error(options.gitError);
      return stubGit(options.gitRecord);
    },
    stdout: (l) => stdout.push(l),
    stderr: (l) => stderr.push(l),
  };
  return { deps, stdout, stderr };
}

beforeEach(() => {
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = 0;
});

describe("runArtifactPublishCommand", () => {
  test("missing change name fails without resolving context", async () => {
    const record: string[] = [];
    const { deps, stderr } = makeDeps(record);

    await runArtifactPublishCommand(["--json"], deps);

    expect(record).toEqual([]);
    expect(stderr.join("\n")).toContain("requires a change name");
    expect(process.exitCode).toBe(1);
  });

  test("resolves the positional name even when --type precedes it", async () => {
    const record: string[] = [];
    let selectedType = "";
    const { deps } = makeDeps(record, {
      finisherFor: (type) => {
        selectedType = type;
        return () => recordingFinisher(record);
      },
    });

    await runArtifactPublishCommand(["--type", "openspec", "my-change", "--json"], deps);

    expect(selectedType).toBe("openspec");
    expect(record).toContain("produce");
  });

  test("unknown artifact type fails clearly", async () => {
    const record: string[] = [];
    const { deps, stderr } = makeDeps(record, { finisherFor: () => undefined });

    await runArtifactPublishCommand(["my-change", "--type", "adr"], deps);

    expect(stderr.join("\n")).toContain('unknown artifact type "adr"');
    expect(process.exitCode).toBe(1);
  });

  test("disabled finisher is a no-op with message", async () => {
    const record: string[] = [];
    const { deps, stderr } = makeDeps(record, { capabilities: [{ name: "graphify" }] });

    await runArtifactPublishCommand(["my-change"], deps);

    expect(record).toEqual([]);
    expect(stderr.join("\n")).toContain("openspec capability");
    expect(process.exitCode).toBe(0);
  });

  test("outside companion context yields WorkingRepoRequiredError handling, no mutation", async () => {
    const record: string[] = [];
    const { deps, stderr } = makeDeps(record, {
      resolveError: new WorkingRepoRequiredError("cap"),
    });

    await runArtifactPublishCommand(["my-change"], deps);

    expect(record).toEqual([]);
    expect(stderr.join("\n")).toContain("working repository");
    expect(process.exitCode).toBe(1);
  });

  test("--no-push is honoured when it precedes the name", async () => {
    const record: string[] = [];
    const gitRecord: string[] = [];
    const { deps, stdout } = makeDeps(record, { gitRecord });

    await runArtifactPublishCommand(["--no-push", "my-change", "--json"], deps);

    const result = JSON.parse(stdout[0] ?? "{}") as { status: string; name: string };
    expect(result.name).toBe("my-change");
    expect(result.status).toBe("skipped");
    expect(gitRecord).not.toContain("push");
  });

  test("--force preceding the name still bypasses the completeness guard", async () => {
    const record: string[] = [];
    const { deps } = makeDeps(record);

    await runArtifactPublishCommand(["--force", "my-change", "--json"], deps);

    expect(record).toContain("produce");
    expect(record).not.toContain("isComplete");
  });

  test("serializes a Git-root guard failure as JSON before any finish mutation", async () => {
    const record: string[] = [];
    const { deps, stdout } = makeDeps(record, { gitError: "working repo target" });

    await runArtifactPublishCommand(["my-change", "--json"], deps);

    const result = JSON.parse(stdout[0] ?? "{}") as { status: string; message: string };
    expect(result.status).toBe("error");
    expect(result.message).toContain("publish Git guard rejected");
    expect(result.message).toContain("working repo target");
    expect(record).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});

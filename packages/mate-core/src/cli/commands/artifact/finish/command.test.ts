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

// A finisher that records what the command asked of it. `resolve` succeeds so the happy
// path runs end to end through a stub git; `resolveError` drives the refusal cases.
function recordingFinisher(
  record: string[],
  options: { enabled?: boolean; resolveError?: string } = {},
): ArtifactFinisher {
  const enabled = options.enabled ?? true;
  return {
    type: "openspec",
    disabledReason: "mate: the openspec capability must be enabled to run artifact publish.",
    isEnabled: (caps) => enabled && caps.some((c) => c.name === "openspec"),
    async resolve(target) {
      record.push(`resolve:${target}`);
      return options.resolveError
        ? { ok: false, message: options.resolveError }
        : { ok: true, resolved: { anchorName: "2026-07-14-x", commitPaths: ["openspec"] } };
    },
  };
}

function stubGit(record: string[] = [], branch = "main"): GitOps {
  return {
    async currentBranch() {
      return branch;
    },
    async defaultBranch() {
      return "main";
    },
    async changedPaths() {
      return [];
    },
    async stagedPaths() {
      return [];
    },
    async add() {},
    async hasStagedChanges() {
      return true;
    },
    async commit() {},
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
  resolveFailure?: string;
  branch?: string;
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
    selectFinisher:
      options.finisherFor ??
      (() => () => recordingFinisher(record, { resolveError: options.resolveFailure })),
    git: () => {
      if (options.gitError) throw new Error(options.gitError);
      return stubGit(options.gitRecord, options.branch);
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
    expect(stderr.join("\n")).toContain("requires an archive anchor or change name");
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
    expect(record).toContain("resolve:my-change");
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

  test("--force is no longer a flag, so it is read as the positional target", async () => {
    const record: string[] = [];
    const { deps, stdout } = makeDeps(record);

    await runArtifactPublishCommand(["--force", "my-change", "--json"], deps);

    /** `--force` consumes `my-change` as its value, leaving no positional at all. */
    const result = JSON.parse(stdout[0] ?? "{}") as { name?: string };
    expect(result.name).toBeUndefined();
    expect(record).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("an unresolvable target is reported without any mutation", async () => {
    const record: string[] = [];
    const { deps, stdout } = makeDeps(record, {
      resolveFailure: "mate: my-change is still active. Run `openspec archive my-change` first.",
    });

    await runArtifactPublishCommand(["my-change", "--json"], deps);

    const result = JSON.parse(stdout[0] ?? "{}") as {
      step: string;
      status: string;
      message: string;
    };
    expect(result.step).toBe("resolve");
    expect(result.status).toBe("error");
    expect(result.message).toContain("openspec archive my-change");
    expect(process.exitCode).toBe(1);
  });

  test("an ambiguous target is refused with every matching anchor", async () => {
    const record: string[] = [];
    const { deps, stdout } = makeDeps(record, {
      resolveFailure: 'mate: "x" matches 2 archives (2026-08-26-x, 2026-09-02-x).',
    });

    await runArtifactPublishCommand(["x", "--json"], deps);

    const result = JSON.parse(stdout[0] ?? "{}") as { step: string; message: string };
    expect(result.step).toBe("resolve");
    expect(result.message).toContain("2026-08-26-x");
    expect(result.message).toContain("2026-09-02-x");
  });

  test("an off-default branch is refused after resolve and before any mutation", async () => {
    const record: string[] = [];
    const gitRecord: string[] = [];
    const { deps, stdout } = makeDeps(record, { branch: "feature/x", gitRecord });

    await runArtifactPublishCommand(["my-change", "--json"], deps);

    const result = JSON.parse(stdout[0] ?? "{}") as {
      step: string;
      status: string;
      message: string;
    };
    expect(result.step).toBe("branch-guard");
    expect(result.status).toBe("error");
    expect(result.message).toContain("feature/x");
    expect(gitRecord).not.toContain("push");
    expect(process.exitCode).toBe(1);
  });

  test("serializes a Git-root guard failure as JSON before any publish mutation", async () => {
    const record: string[] = [];
    const { deps, stdout } = makeDeps(record, { gitError: "working repo target" });

    await runArtifactPublishCommand(["my-change", "--json"], deps);

    const result = JSON.parse(stdout[0] ?? "{}") as {
      status: string;
      step: string;
      message: string;
    };
    expect(result.step).toBe("resolve");
    expect(result.status).toBe("error");
    expect(result.message).toContain("publish Git guard rejected");
    expect(result.message).toContain("working repo target");
    expect(record).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});

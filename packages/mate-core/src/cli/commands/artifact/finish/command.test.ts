import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readDeliveryRecord } from "../../../../lib/delivery/record";
import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import type { CapabilityConfig } from "../../../../lib/orchestrator/types";
import { WorkingRepoRequiredError } from "../../../../lib/orchestrator/types";
import type { WorksetRecord } from "../../../../lib/workset/record";
import type { PruneResult, PruneTarget } from "../../../../lib/workset/worktree";
import { runArtifactPublishCommand, type PublishCommandDeps } from "./command";
import type { FinishResult } from "./engine";
import type { ArtifactFinisher, FinisherFactory } from "./finisher";
import { type GitOps, RemoteFetchError } from "./git";
import type { WorktreeCleanupDeps } from "./worktree-cleanup";
import type { PublicationResult, PublishDeps } from "../../../../lib/delivery/staging/publish";

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
    expect(stderr.join("\n")).toContain(
      "requires a Delivery Group, a change name or archive anchor",
    );
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

/** Publication-unit selection: `--specs` and `--all` alongside the positional change target. */
describe("runArtifactPublishCommand — publication units", () => {
  const SPEC = "openspec/specs/widget-api/spec.md";

  interface UnitOptions {
    changed?: string[];
    companionPath?: string;
    specStatus?: "ok" | "conflict" | "error";
    changeStatus?: "ok" | "conflict" | "error";
  }

  function unitDeps(
    record: string[],
    options: UnitOptions = {},
  ): { deps: PublishCommandDeps; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const companionPath = options.companionPath ?? COMPANION;

    /** Stands in for a real publication: records the call and forces the wanted status. */
    const staged = (label: string, status: "ok" | "conflict" | "error"): ArtifactFinisher => ({
      type: "openspec",
      disabledReason: "disabled",
      isEnabled: () => true,
      async resolve(target) {
        record.push(`${label}:${target}`);
        return status === "error"
          ? { ok: false, message: `${label} refused` }
          : {
              ok: true,
              resolved: { anchorName: "2026-09-14", commitPaths: [SPEC] },
            };
      },
    });

    const deps: PublishCommandDeps = {
      resolveContext: async () => ({ ...makeContext(), companionPath }),
      loadCapabilities: async () => [{ name: "openspec" }],
      selectFinisher: () => () => staged("change", options.changeStatus ?? "ok"),
      specsFinisher: (_context, paths) => {
        record.push(`specs:${paths.join(",")}`);
        return staged("specsRun", options.specStatus ?? "ok");
      },
      git: () => ({
        ...stubGit([], "main"),
        async changedPaths() {
          return options.changed ?? [];
        },
        async hasUpstream() {
          return options.specStatus === "conflict";
        },
        async rebaseOntoUpstream() {
          return options.specStatus === "conflict"
            ? { ok: false, conflictedPaths: [SPEC] }
            : { ok: true, conflictedPaths: [] };
        },
      }),
      now: () => new Date(2026, 8, 14),
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    };
    return { deps, stdout, stderr };
  }

  test("a bare name alongside --specs is refused as a different publication unit", async () => {
    const record: string[] = [];
    const { deps, stderr } = unitDeps(record);

    await runArtifactPublishCommand(["my-change", "--specs"], deps);

    expect(record).toEqual([]);
    expect(stderr.join("\n")).toContain("different publication units");
    expect(process.exitCode).toBe(1);
  });

  test("--all combined with any other target is refused", async () => {
    const record: string[] = [];
    const { deps, stderr } = unitDeps(record);

    await runArtifactPublishCommand(["my-change", "--all"], deps);

    expect(record).toEqual([]);
    expect(stderr.join("\n")).toContain("--all already publishes");
    expect(process.exitCode).toBe(1);
  });

  test("no target at all names the three forms", async () => {
    const record: string[] = [];
    const { deps, stderr } = unitDeps(record);

    await runArtifactPublishCommand([], deps);

    expect(record).toEqual([]);
    expect(stderr.join("\n")).toContain("--specs");
    expect(stderr.join("\n")).toContain("--all");
    expect(process.exitCode).toBe(1);
  });

  test("a change literally named specs still resolves as a change", async () => {
    const record: string[] = [];
    const { deps } = unitDeps(record);

    await runArtifactPublishCommand(["specs"], deps);

    expect(record).toEqual(["change:specs"]);
  });

  test("--specs publishes every drifted spec", async () => {
    const record: string[] = [];
    const { deps } = unitDeps(record, { changed: [SPEC] });

    await runArtifactPublishCommand(["--specs"], deps);

    expect(record).toEqual([`specs:${SPEC}`, "specsRun:--specs"]);
    expect(process.exitCode).toBe(0);
  });

  test("--specs narrows to the supplied paths", async () => {
    const record: string[] = [];
    const other = "openspec/specs/other-api/spec.md";
    const { deps } = unitDeps(record, { changed: [SPEC, other] });

    await runArtifactPublishCommand(["--specs", other], deps);

    expect(record[0]).toBe(`specs:${other}`);
  });

  test("--specs refuses a supplied path that is not drifted", async () => {
    const record: string[] = [];
    const { deps, stderr } = unitDeps(record, { changed: [] });

    await runArtifactPublishCommand(["--specs", SPEC], deps);

    expect(record).toEqual([]);
    expect(stderr.join("\n")).toContain("not drifted");
    expect(process.exitCode).toBe(1);
  });

  test("--specs --json names a drift failure on stderr", async () => {
    const { deps, stdout, stderr } = unitDeps([], { changed: [] });

    await runArtifactPublishCommand(["--specs", SPEC, "--json"], deps);

    expect(stderr.join("\n")).toContain("not drifted");
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ name: "--specs", status: "error" });
    expect(process.exitCode).toBe(1);
  });

  test("--specs refuses a supplied path outside the canonical spec tree", async () => {
    const record: string[] = [];
    const { deps, stderr } = unitDeps(record, { changed: [SPEC] });

    await runArtifactPublishCommand(["--specs", "openspec/changes/my-change/proposal.md"], deps);

    expect(record).toEqual([]);
    expect(stderr.join("\n")).toContain("not a canonical spec");
    expect(process.exitCode).toBe(1);
  });

  test("--specs with no drift is a clean no-op", async () => {
    const record: string[] = [];
    const { deps, stdout } = unitDeps(record, { changed: [] });

    await runArtifactPublishCommand(["--specs"], deps);

    expect(record).toEqual([]);
    expect(stdout.join("\n")).toContain("nothing to publish");
    expect(process.exitCode).toBe(0);
  });

  test("--specs --json reports the no-op as skipped with a null tag", async () => {
    const record: string[] = [];
    const { deps, stdout } = unitDeps(record, { changed: [] });

    await runArtifactPublishCommand(["--specs", "--json"], deps);

    const result = JSON.parse(stdout[0] ?? "{}") as Record<string, unknown>;
    expect(result.status).toBe("skipped");
    expect(result.tag).toBeNull();
    expect(result.local).toEqual({ committed: false, tagged: false, pushed: false });
    expect(process.exitCode).toBe(0);
  });

  test("--all with an empty queue succeeds and emits an empty array", async () => {
    const record: string[] = [];
    const { deps, stdout } = unitDeps(record, { changed: [] });

    await runArtifactPublishCommand(["--all", "--json"], deps);

    expect(record).toEqual([]);
    expect(JSON.parse(stdout[0] ?? "null")).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  test("--all publishes remaining drift after the changes", async () => {
    const record: string[] = [];
    const { deps, stdout } = unitDeps(record, { changed: [SPEC] });

    await runArtifactPublishCommand(["--all", "--json"], deps);

    expect(record).toEqual([`specs:${SPEC}`, "specsRun:--specs"]);
    expect((JSON.parse(stdout[0] ?? "[]") as unknown[]).length).toBe(1);
  });

  test("--all emits one array, not one JSON document per publication", async () => {
    const record: string[] = [];
    const { deps, stdout } = unitDeps(record, { changed: [SPEC] });

    await runArtifactPublishCommand(["--all", "--json"], deps);

    expect(stdout.length).toBe(1);
    expect(Array.isArray(JSON.parse(stdout[0]))).toBe(true);
  });

  test("--all halts at a conflict and still reports what ran", async () => {
    const record: string[] = [];
    const { deps, stdout } = unitDeps(record, { changed: [SPEC], specStatus: "conflict" });

    await runArtifactPublishCommand(["--all", "--json"], deps);

    const results = JSON.parse(stdout[0] ?? "[]") as Array<{ status: string }>;
    expect(results.at(-1)?.status).toBe("conflict");
  });
});

/** `--all` sequencing against real archive directories on disk. */
describe("runArtifactPublishCommand — --all sequencing", () => {
  const SPEC = "openspec/specs/widget-api/spec.md";
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function companionWithArchives(
    anchors: string[],
    held: readonly string[] = [],
  ): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-publish-all-"));
    roots.push(dir);
    for (const anchor of anchors) {
      const archive = path.join(dir, "openspec", "changes", "archive", anchor);
      await fs.mkdir(archive, { recursive: true });
      await fs.writeFile(path.join(archive, "proposal.md"), "archived\n", "utf8");
      const state = held.includes(anchor) ? "open" : "merged";
      await fs.writeFile(
        path.join(archive, "delivery.yaml"),
        `version: 1\ndeliveries:\n  - repository: acme/app\n    branch: change/x\n    merge:\n      state: ${state}\n      source: user\n`,
        "utf8",
      );
    }
    return dir;
  }

  function deps(
    record: string[],
    companionPath: string,
    changed: string[],
    changeStatus: "ok" | "error" = "ok",
  ): { deps: PublishCommandDeps; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      stdout,
      stderr,
      deps: {
        resolveContext: async () => ({ ...makeContext(), companionPath }),
        loadCapabilities: async () => [{ name: "openspec" }],
        selectFinisher: () => () => ({
          type: "openspec",
          disabledReason: "disabled",
          isEnabled: () => true,
          async resolve(target) {
            record.push(`change:${target}`);
            return changeStatus === "error"
              ? { ok: false, message: "refused" }
              : { ok: true, resolved: { anchorName: target, commitPaths: ["openspec"] } };
          },
        }),
        specsFinisher: (_c, paths) => {
          record.push(`specs:${paths.join(",")}`);
          return {
            type: "openspec",
            disabledReason: "disabled",
            isEnabled: () => true,
            async resolve() {
              return { ok: true, resolved: { anchorName: "2026-09-14", commitPaths: paths } };
            },
          };
        },
        git: () => ({
          ...stubGit([], "main"),
          async changedPaths() {
            return changed;
          },
        }),
        stdout: (l) => stdout.push(l),
        stderr: (l) => stderr.push(l),
      },
    };
  }

  test("publishes every pending change in discovery order, then the remaining drift", async () => {
    const companion = await companionWithArchives(["2026-09-10-alpha", "2026-09-14-beta"]);
    const record: string[] = [];
    const changed = [
      "openspec/changes/archive/2026-09-14-beta/",
      "openspec/changes/archive/2026-09-10-alpha/",
      SPEC,
    ];
    const { deps: d } = deps(record, companion, changed);

    await runArtifactPublishCommand(["--all", "--json"], d);

    expect(record).toEqual(["change:2026-09-10-alpha", "change:2026-09-14-beta", `specs:${SPEC}`]);
  });

  test("a held-back archive is skipped and the merged ones still publish", async () => {
    const companion = await companionWithArchives(
      ["2026-09-10-alpha", "2026-09-14-beta"],
      ["2026-09-10-alpha"],
    );
    const record: string[] = [];
    const changed = [
      "openspec/changes/archive/2026-09-14-beta/",
      "openspec/changes/archive/2026-09-10-alpha/",
    ];
    const { deps: d, stdout } = deps(record, companion, changed);

    await runArtifactPublishCommand(["--all", "--json"], d);

    expect(record).toEqual(["change:2026-09-14-beta"]);
    const results = JSON.parse(stdout[0]) as Array<{
      name: string;
      status: string;
      message: string;
    }>;
    expect(results[0]).toMatchObject({ name: "2026-09-10-alpha", status: "skipped" });
    expect(results[0].message).toContain("held back");
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("a change failure halts the queue before any later publication", async () => {
    const companion = await companionWithArchives(["2026-09-10-alpha", "2026-09-14-beta"]);
    const record: string[] = [];
    const changed = [
      "openspec/changes/archive/2026-09-10-alpha/",
      "openspec/changes/archive/2026-09-14-beta/",
      SPEC,
    ];
    const { deps: d, stdout, stderr } = deps(record, companion, changed, "error");

    await runArtifactPublishCommand(["--all", "--json"], d);

    expect(record).toEqual(["change:2026-09-10-alpha"]);
    expect(stdout).toHaveLength(1);
    const results = JSON.parse(stdout[0] ?? "[]") as Array<{ status: string; message: string }>;
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("error");
    expect(stderr).toContain(results[0].message);
  });

  test("a deferred publication halts the queue without failing the run", async () => {
    const companion = await companionWithArchives(["2026-09-10-alpha", "2026-09-14-beta"]);
    const record: string[] = [];
    const changed = [
      "openspec/changes/archive/2026-09-10-alpha/",
      "openspec/changes/archive/2026-09-14-beta/",
    ];
    const { deps: d, stdout } = deps(record, companion, changed);
    const base = d.git!;
    d.git = (...args) => ({
      ...base(...args),
      async hasUpstream() {
        return true;
      },
      async fetch() {
        throw new RemoteFetchError("git fetch failed: Permission denied (publickey).", true);
      },
    });

    await runArtifactPublishCommand(["--all", "--json"], d);

    expect(record).toEqual(["change:2026-09-10-alpha"]);
    const results = JSON.parse(stdout[0] ?? "[]") as Array<{ status: string; step: string }>;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "deferred", step: "sync-remote" });
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("a secret-scan failure halts the queue at that publication", async () => {
    const companion = await companionWithArchives(["2026-09-10-alpha", "2026-09-14-beta"]);
    const record: string[] = [];
    const changed = [
      "openspec/changes/archive/2026-09-10-alpha/",
      "openspec/changes/archive/2026-09-14-beta/",
    ];
    const { deps: d, stdout } = deps(record, companion, changed);
    d.scanPublication = async () => ({
      skipped: false,
      findings: [{ path: "openspec/x.md", line: 2, ruleId: "x/rule" }],
    });

    await runArtifactPublishCommand(["--all", "--json"], d);

    expect(record).toEqual(["change:2026-09-10-alpha"]);
    const results = JSON.parse(stdout[0] ?? "[]") as Array<{
      step: string;
      secretFindings?: unknown[];
    }>;
    expect(results.length).toBe(1);
    expect(results[0].step).toBe("secret-scan");
    expect(results[0].secretFindings).toEqual([
      { path: "openspec/x.md", line: 2, ruleId: "x/rule" },
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("a change that already committed its spec leaves no drift to publish", async () => {
    const companion = await companionWithArchives(["2026-09-14-widget"]);
    const archive = path.join(
      companion,
      "openspec/changes/archive/2026-09-14-widget/specs/widget-api",
    );
    await fs.mkdir(archive, { recursive: true });
    await fs.writeFile(path.join(archive, "spec.md"), "delta\n", "utf8");
    const record: string[] = [];
    const changed = ["openspec/changes/archive/2026-09-14-widget/", SPEC];
    const { deps: d } = deps(record, companion, changed);

    await runArtifactPublishCommand(["--all", "--json"], d);

    expect(record).toEqual(["change:2026-09-14-widget"]);
  });

  test("cleans up completed Worksets once, after every publication", async () => {
    const companion = await companionWithArchives(["2026-09-10-alpha", "2026-09-14-beta"]);
    const record: string[] = [];
    const changed = [
      "openspec/changes/archive/2026-09-10-alpha/",
      "openspec/changes/archive/2026-09-14-beta/",
    ];
    const { deps: d, stdout } = deps(record, companion, changed);
    d.worktreeCleanup = {
      readWorksets: async () => ({ worksets: [], problems: [] }),
      pruneWorktrees: async (_companion, targets) => {
        record.push(`prune:${targets.map((target) => target.id).join(",")}`);
        return { removed: [], kept: [], warnings: [] };
      },
    };

    await runArtifactPublishCommand(["--all", "--json"], d);

    expect(record).toEqual([
      "change:2026-09-10-alpha",
      "change:2026-09-14-beta",
      "prune:alpha",
      "prune:beta",
    ]);
    const results = JSON.parse(stdout[0] ?? "[]") as FinishResult[];
    expect(results.map((result) => result.worktrees)).toEqual([
      { removed: [], kept: [], warnings: [] },
      { removed: [], kept: [], warnings: [] },
    ]);
  });
});

describe("runArtifactPublishCommand — worktree cleanup", () => {
  const ANCHOR = "2026-07-14-x";
  const EMPTY: PruneResult = { removed: [], kept: [], warnings: [] };

  function worksetRecord(id: string, changes: string[]): WorksetRecord {
    return {
      id,
      title: id,
      intent: "",
      repositories: ["acme/web"],
      changes,
      createdAt: "2026-07-01T00:00:00.000Z",
      extra: {},
    } as unknown as WorksetRecord;
  }

  /** A companion where `x` is in Workset `acme-login`, whose derived stage is `stage`. */
  function explicit(stage: string, calls: PruneTarget[][]): WorktreeCleanupDeps {
    const record = worksetRecord("acme-login", ["x", "y"]);
    return {
      readWorksets: async () => ({ worksets: [record], problems: [] }),
      worksetStages: async () =>
        ({
          worksets: [{ record, derived: { stage, label: stage, turn: "agent", problems: [] } }],
          problems: [],
        }) as unknown as Awaited<ReturnType<NonNullable<WorktreeCleanupDeps["worksetStages"]>>>,
      pruneWorktrees: async (_companion, targets) => {
        calls.push([...targets]);
        return EMPTY;
      },
    };
  }

  function implicit(calls: PruneTarget[][], result: PruneResult = EMPTY): WorktreeCleanupDeps {
    return {
      readWorksets: async () => ({ worksets: [], problems: [] }),
      pruneWorktrees: async (_companion, targets) => {
        calls.push([...targets]);
        return result;
      },
    };
  }

  test("a single --json publication prints one object that carries the worktrees", async () => {
    const calls: PruneTarget[][] = [];
    const { deps, stdout } = makeDeps([]);
    deps.worktreeCleanup = implicit(calls, {
      removed: [{ workset: "x", repository: "acme/web", path: "/acme/web.worktrees/x" }],
      kept: [],
      warnings: [],
    });

    await runArtifactPublishCommand(["x", "--json"], deps);

    expect(stdout).toHaveLength(1);
    const result = JSON.parse(stdout[0]!) as FinishResult;
    expect(result.status).toBe("ok");
    expect(result.worktrees?.removed[0]?.path).toBe("/acme/web.worktrees/x");
  });

  test("an implicit Workset is cleaned up as soon as its change is published", async () => {
    const calls: PruneTarget[][] = [];
    const { deps } = makeDeps([]);
    deps.worktreeCleanup = implicit(calls);

    await runArtifactPublishCommand(["x", "--json"], deps);

    expect(calls).toEqual([[{ id: "x", changes: [ANCHOR] }]]);
  });

  test("the last change of an explicit Workset cleans up the whole Workset", async () => {
    const calls: PruneTarget[][] = [];
    const { deps } = makeDeps([]);
    deps.worktreeCleanup = explicit("done", calls);

    await runArtifactPublishCommand(["x", "--json"], deps);

    expect(calls).toEqual([[{ id: "acme-login", changes: ["x", "y"] }]]);
  });

  test("one of two changes of a Workset cleans up nothing", async () => {
    const calls: PruneTarget[][] = [];
    const { deps, stdout } = makeDeps([]);
    deps.worktreeCleanup = explicit("publish", calls);

    await runArtifactPublishCommand(["x", "--json"], deps);

    expect(calls).toEqual([]);
    expect((JSON.parse(stdout[0]!) as FinishResult).worktrees).toBeUndefined();
  });

  test("a failing cleanup keeps the publication ok and reports a warning", async () => {
    const { deps, stdout } = makeDeps([]);
    deps.worktreeCleanup = {
      readWorksets: async () => ({ worksets: [], problems: [] }),
      pruneWorktrees: async () => {
        throw new Error("cannot list the worktrees of acme/web");
      },
    };

    await runArtifactPublishCommand(["x", "--json"], deps);

    const result = JSON.parse(stdout[0]!) as FinishResult;
    expect(result.status).toBe("ok");
    expect(result.worktrees?.warnings).toEqual([
      "worktree cleanup failed: cannot list the worktrees of acme/web",
    ]);
    expect(process.exitCode).toBe(0);
  });

  test("human output names removed and kept worktrees after the result", async () => {
    const { deps, stdout, stderr } = makeDeps([]);
    deps.worktreeCleanup = implicit([], {
      removed: [{ workset: "x", repository: "acme/web", path: "/acme/a" }],
      kept: [
        {
          workset: "x",
          repository: "acme/web",
          path: "/acme/b",
          reason: "uncommitted changes or untracked files",
        },
      ],
      warnings: [],
    });

    await runArtifactPublishCommand(["x"], deps);

    expect(stdout).toHaveLength(1);
    expect(stderr).toEqual([
      "mate: removed worktree /acme/a",
      "mate: kept worktree /acme/b (uncommitted changes or untracked files)",
    ]);
  });

  test("an error never cleans up", async () => {
    const calls: PruneTarget[][] = [];
    const { deps, stdout } = makeDeps([], { resolveFailure: "mate: x is still active." });
    deps.worktreeCleanup = implicit(calls);

    await runArtifactPublishCommand(["x", "--json"], deps);

    expect(calls).toEqual([]);
    expect((JSON.parse(stdout[0]!) as FinishResult).worktrees).toBeUndefined();
  });

  test("a conflict never cleans up", async () => {
    const calls: PruneTarget[][] = [];
    const { deps } = makeDeps([]);
    deps.git = () => ({
      ...stubGit(),
      async hasUpstream() {
        return true;
      },
      async rebaseOntoUpstream() {
        return { ok: false, conflictedPaths: ["openspec/x.md"] };
      },
    });
    deps.worktreeCleanup = implicit(calls);

    await runArtifactPublishCommand(["x", "--json"], deps);

    expect(calls).toEqual([]);
  });

  test("a deferred publication never cleans up", async () => {
    const calls: PruneTarget[][] = [];
    const { deps, stdout } = makeDeps([]);
    deps.git = () => ({
      ...stubGit(),
      async hasUpstream() {
        return true;
      },
      async fetch() {
        throw new RemoteFetchError("git fetch failed: Permission denied (publickey).", true);
      },
    });
    deps.worktreeCleanup = implicit(calls);

    await runArtifactPublishCommand(["x", "--json"], deps);

    expect((JSON.parse(stdout[0]!) as FinishResult).status).toBe("deferred");
    expect(calls).toEqual([]);
  });

  test("--specs never cleans up", async () => {
    const calls: PruneTarget[][] = [];
    const { deps } = makeDeps([]);
    deps.git = () => ({
      ...stubGit(),
      async changedPaths() {
        return ["openspec/specs/widget-api/spec.md"];
      },
    });
    deps.specsFinisher = () => recordingFinisher([]);
    deps.worktreeCleanup = implicit(calls);

    await runArtifactPublishCommand(["--specs", "--json"], deps);

    expect(calls).toEqual([]);
  });
});

describe("runArtifactPublishCommand — Delivery Groups", () => {
  const GROUP = "acme_product/workset/acme-login";

  function publication(
    group: string,
    status: PublicationResult["status"],
    extra: Partial<PublicationResult> = {},
  ): PublicationResult {
    return {
      status,
      group,
      changes: ["acme-login"],
      records: status === "ok" ? ["2026-11-15-acme-login"] : [],
      conflictedPaths: [],
      warnings: [],
      message: `${group}: ${status}`,
      ...extra,
    };
  }

  /** A companion in a temp folder whose submitted acme-login records its acme/product branch. */
  async function submittedAcmeLogin(): Promise<{ dir: string; change: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-publish-group-"));
    const change = path.join(dir, "openspec", "changes", "acme-login");
    await fs.mkdir(change, { recursive: true });
    await fs.writeFile(
      path.join(change, "delivery.yaml"),
      "version: 1\nchange: acme-login\nstate: submitted\ndeliveries:\n  - repository: acme/product\n    branch: workset/acme-login\n",
    );
    return { dir, change };
  }

  /** A delivery environment with no Working Repository and nothing linked. */
  const UNLINKED = {
    ensureUnambiguousCompanion: async () => true,
    loadLinkedRepositories: async () => [],
    loadGitAutoMode: async () => false,
  };

  function groupDeps(
    calls: { target: string; deps: PublishDeps }[],
    statuses: Record<string, PublicationResult["status"]> = {},
  ) {
    const record: string[] = [];
    const harness = makeDeps(record);
    harness.deps.hasRemote = async () => true;
    harness.deps.unpushedPublication = async () => false;
    harness.deps.worktreeCleanup = { readWorksets: async () => ({ worksets: [], errors: [] }) };
    harness.deps.publishSubmitted = async (_companion, target, deps) => {
      calls.push({ target, deps });
      return publication(target, statuses[target] ?? "ok", {
        ...(statuses[target] === "ok" || !statuses[target] ? { commit: "a".repeat(40) } : {}),
      });
    };
    return { ...harness, record };
  }

  test("publishes a Delivery Group from any machine and reports its commit, no tag", async () => {
    const calls: { target: string; deps: PublishDeps }[] = [];
    const { deps, stdout, record } = groupDeps(calls);

    await runArtifactPublishCommand([GROUP, "--json"], deps);

    expect(calls.map((call) => call.target)).toEqual([GROUP]);
    expect(record).toEqual([]);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      status: "ok",
      group: GROUP,
      tag: null,
      commit: "a".repeat(40),
      anchors: ["2026-11-15-acme-login"],
    });
    expect(process.exitCode).toBe(0);
  });

  test("a submitted change name publishes its group; an anchor uses the checkout", async () => {
    const calls: { target: string; deps: PublishDeps }[] = [];
    const { deps, record } = groupDeps(calls);

    await runArtifactPublishCommand(["acme-login", "--json"], deps);
    await runArtifactPublishCommand(["2026-07-14-acme-legacy", "--json"], deps);

    expect(calls.map((call) => call.target)).toEqual(["acme-login"]);
    expect(record).toContain("resolve:2026-07-14-acme-legacy");
  });

  test("a held group or one awaiting a publisher does not fail the command", async () => {
    const calls: { target: string; deps: PublishDeps }[] = [];
    const { deps, stderr } = groupDeps(calls, { [GROUP]: "held" });

    await runArtifactPublishCommand([GROUP], deps);

    expect(stderr).toContain(`${GROUP}: held`);
    expect(process.exitCode).toBe(0);
  });

  test("a group --refresh leaves held names the lookups that need an answer", async () => {
    const { dir } = await submittedAcmeLogin();
    const { deps, stdout, stderr } = groupDeps([]);
    deps.settleLinked = async () => ({ recorded: [], warning: null });
    deps.deliveryEnvironment = UNLINKED;
    deps.publishSubmitted = async (_companion, target, publish) => {
      expect(await publish.settle!(dir, ["acme-login"])).toBeNull();
      return publication(target, "held", { reason: "unmerged" });
    };

    try {
      await runArtifactPublishCommand([GROUP, "--refresh", "--json"], deps);
      await runArtifactPublishCommand([GROUP, "--refresh"], deps);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }

    const result = JSON.parse(stdout[0]!) as FinishResult;
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        repository: "acme/product",
        branch: "workset/acme-login",
        needsAnswer: true,
        answerReason: "no-checkout",
      }),
    ]);
    expect(stderr.at(-1)).toBe(
      `${GROUP}: held\n  workset/acme-login: acme/product is not linked on this machine; needs an answer\n  Answer with --confirm-merged, --confirm-open or --confirm-dropped.`,
    );
    expect(process.exitCode).toBe(0);
  });

  /** A Working Repository acme/web, which the acme/product group records no delivery for. */
  const IN_ACME_WEB = {
    ...UNLINKED,
    resolveContext: async () => ({
      ...makeContext(),
      repository: { id: "acme-web", path: "/acme/web" },
    }),
    workingRepoGit: () => ({
      currentBranch: async () => "main",
      defaultBranch: async () => "main",
      remoteUrl: async () => "git@github.com:acme/web.git",
      unpushedCommits: async () => [],
      branchExists: async () => false,
      hasRef: async () => false,
    }),
  };

  test.each([
    ["no Working Repository", UNLINKED],
    ["a Working Repository of another repository", IN_ACME_WEB],
  ])(
    "--confirm-merged with %s records the merge for the group's repository",
    async (_, environment) => {
      const { dir, change } = await submittedAcmeLogin();
      const { deps } = groupDeps([]);
      deps.deliveryEnvironment = environment;
      let settled: string | null | undefined;
      deps.publishSubmitted = async (_companion, target, publish) => {
        settled = await publish.settle!(dir, ["acme-login"]);
        return publication(target, "ok", { commit: "a".repeat(40) });
      };

      try {
        await runArtifactPublishCommand([GROUP, "--confirm-merged", "--json"], deps);
        expect(settled).toBeNull();
        const record = await readDeliveryRecord(change);
        expect(record?.deliveries).toEqual([
          expect.objectContaining({
            repository: "acme/product",
            merge: expect.objectContaining({ state: "merged", source: "user" }),
          }),
        ]);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("--all tries every group, dependencies first by the queue, and exits non-zero on a conflict", async () => {
    const calls: { target: string; deps: PublishDeps }[] = [];
    const { deps, stdout } = groupDeps(calls, { "acme_product/workset/acme-a": "conflict" });
    deps.publicationQueue = async () => ({
      groups: ["acme_product/workset/acme-a", GROUP],
      fresh: true,
    });

    await runArtifactPublishCommand(["--all", "--json"], deps);

    expect(calls.map((call) => call.target)).toEqual(["acme_product/workset/acme-a", GROUP]);
    expect(calls.every((call) => call.deps.withDependencies === false)).toBe(true);
    expect((JSON.parse(stdout[0]!) as FinishResult[]).map((result) => result.status)).toEqual([
      "conflict",
      "ok",
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("--all reuses the queue's fetch only when it succeeded", async () => {
    for (const fresh of [true, false]) {
      const calls: { target: string; deps: PublishDeps }[] = [];
      const { deps } = groupDeps(calls);
      deps.publicationQueue = async () => ({ groups: [GROUP], fresh });

      // oxlint-disable-next-line no-await-in-loop -- one run per case
      await runArtifactPublishCommand(["--all", "--json"], deps);

      expect(calls[0]!.deps.fresh).toBe(fresh ? true : undefined);
    }
  });

  test("--refresh settles the group and its dependencies; --confirm-* only the named group", async () => {
    const calls: { target: string; deps: PublishDeps }[] = [];
    const { deps } = groupDeps(calls);
    const settled: string[] = [];
    deps.settleLinked = async (environment) => {
      settled.push(environment.companionPath);
      return { recorded: [], warning: "recording merges failed" };
    };

    await runArtifactPublishCommand([GROUP, "--refresh"], deps);
    await runArtifactPublishCommand([GROUP, "--confirm-merged"], deps);

    // Merges linked checkouts settle are recorded once, before the group, only with --refresh.
    expect(settled).toHaveLength(1);
    expect(calls[0]!.deps.settle).toBeDefined();
    expect(calls[0]!.deps.settleDependency).toBeDefined();
    expect(calls[1]!.deps.settle).toBeDefined();
    expect(calls[1]!.deps.settleDependency).toBeUndefined();
  });

  test("--confirm-* with --all is refused before anything runs", async () => {
    const calls: { target: string; deps: PublishDeps }[] = [];
    const { deps, stderr } = groupDeps(calls);

    await runArtifactPublishCommand(["--all", "--confirm-merged"], deps);

    expect(calls).toEqual([]);
    expect(stderr.join("\n")).toContain("--confirm-* answers for the Delivery Group of one target");
    expect(process.exitCode).toBe(1);
  });
});

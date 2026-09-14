import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

  async function companionWithArchives(anchors: string[]): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-publish-all-"));
    roots.push(dir);
    for (const anchor of anchors) {
      const archive = path.join(dir, "openspec", "changes", "archive", anchor);
      await fs.mkdir(archive, { recursive: true });
      await fs.writeFile(path.join(archive, "proposal.md"), "archived\n", "utf8");
    }
    return dir;
  }

  function deps(
    record: string[],
    companionPath: string,
    changed: string[],
    changeStatus: "ok" | "error" = "ok",
  ): { deps: PublishCommandDeps; stdout: string[] } {
    const stdout: string[] = [];
    return {
      stdout,
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

  test("a change failure halts the queue before any later publication", async () => {
    const companion = await companionWithArchives(["2026-09-10-alpha", "2026-09-14-beta"]);
    const record: string[] = [];
    const changed = [
      "openspec/changes/archive/2026-09-10-alpha/",
      "openspec/changes/archive/2026-09-14-beta/",
      SPEC,
    ];
    const { deps: d, stdout } = deps(record, companion, changed, "error");

    await runArtifactPublishCommand(["--all", "--json"], d);

    expect(record).toEqual(["change:2026-09-10-alpha"]);
    const results = JSON.parse(stdout[0] ?? "[]") as Array<{ status: string }>;
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("error");
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
});

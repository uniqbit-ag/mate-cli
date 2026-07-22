import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { type FinishResult, runFinishEngine } from "./engine";
import type { ArtifactFinisher, Produced } from "./finisher";
import type { GitOps, RebaseResult } from "./git";

const ANCHOR = "2026-07-14-my-change";
const COMMIT_PATHS = [
  "openspec/changes/my-change",
  `openspec/changes/archive/${ANCHOR}`,
  "openspec/specs/a",
];
const PRODUCED: Produced = { anchorName: ANCHOR, commitPaths: COMMIT_PATHS };

type GitCall = { op: string; args: unknown[] };

interface FakeGitOptions {
  head?: string;
  changedPaths?: string[];
  stagedPaths?: string[];
  hasStaged?: boolean;
  hasUpstream?: boolean;
  rebase?: RebaseResult;
  tagExists?: boolean;
  pushOk?: boolean;
  pushError?: string;
  failOn?: Partial<Record<keyof GitOps, boolean>>;
}

function makeGit(options: FakeGitOptions = {}): { git: GitOps; calls: GitCall[] } {
  const calls: GitCall[] = [];
  const record = <T>(op: keyof GitOps, args: unknown[], value: T): T => {
    calls.push({ op, args });
    if (options.failOn?.[op]) throw new Error(`git ${op} failed`);
    return value;
  };
  const git: GitOps = {
    async headRef() {
      return record("headRef", [], options.head ?? "HEAD_SHA");
    },
    async changedPaths() {
      return record("changedPaths", [], options.changedPaths ?? []);
    },
    async stagedPaths() {
      return record("stagedPaths", [], options.stagedPaths ?? options.changedPaths ?? []);
    },
    async add(paths) {
      return record("add", [paths], undefined);
    },
    async hasStagedChanges(paths) {
      return record("hasStagedChanges", [paths], options.hasStaged ?? true);
    },
    async commit(message, paths) {
      return record("commit", [message, paths], undefined);
    },
    async restorePaths(ref, paths) {
      return record("restorePaths", [ref, paths], undefined);
    },
    async hasUpstream() {
      return record("hasUpstream", [], options.hasUpstream ?? true);
    },
    async fetch() {
      return record("fetch", [], undefined);
    },
    async rebaseOntoUpstream() {
      return record("rebaseOntoUpstream", [], options.rebase ?? { ok: true, conflictedPaths: [] });
    },
    async tagExists(name) {
      return record("tagExists", [name], options.tagExists ?? false);
    },
    async tag(name, message) {
      return record("tag", [name, message], undefined);
    },
    async push() {
      calls.push({ op: "push", args: [] });
      return { ok: options.pushOk ?? true, error: options.pushError ?? "" };
    },
  };
  return { git, calls };
}

interface FakeFinisherOptions {
  valid?: boolean;
  validationErrors?: string[];
  complete?: boolean;
  total?: number;
  remaining?: number;
  detected?: Produced | null;
  produceOk?: boolean;
  producedAnchor?: string | null;
  capSync?: boolean | "absent";
}

function makeFinisher(options: FakeFinisherOptions = {}): {
  finisher: ArtifactFinisher;
  calls: string[];
} {
  const calls: string[] = [];
  const finisher: ArtifactFinisher = {
    type: "openspec",
    disabledReason: "disabled",
    isEnabled: () => true,
    async validate(name) {
      calls.push(`validate:${name}`);
      return { valid: options.valid ?? true, errors: options.validationErrors ?? [] };
    },
    async isComplete(name) {
      calls.push(`isComplete:${name}`);
      return {
        complete: options.complete ?? true,
        total: options.total ?? 5,
        remaining: options.remaining ?? 0,
      };
    },
    async detectProduced(name) {
      calls.push(`detectProduced:${name}`);
      return options.detected ?? null;
    },
    async produce(name) {
      calls.push(`produce:${name}`);
      return {
        ok: options.produceOk ?? true,
        produced:
          options.producedAnchor === null
            ? null
            : { anchorName: options.producedAnchor ?? ANCHOR, commitPaths: COMMIT_PATHS },
        message: "archived",
      };
    },
  };
  if (options.capSync !== "absent") {
    finisher.capSync = async () => {
      calls.push("capSync");
      return options.capSync ?? true;
    };
  }
  return { finisher, calls };
}

interface Harness {
  git: GitOps;
  gitCalls: GitCall[];
  finisher: ArtifactFinisher;
  finisherCalls: string[];
  stdout: string[];
  stderr: string[];
}

function harness(g: FakeGitOptions = {}, f: FakeFinisherOptions = {}): Harness {
  const { git, calls: gitCalls } = makeGit(g);
  const { finisher, calls: finisherCalls } = makeFinisher(f);
  return { git, gitCalls, finisher, finisherCalls, stdout: [], stderr: [] };
}

function runEngine(
  h: Harness,
  options: { name?: string; force?: boolean; noPush?: boolean } = {},
): Promise<FinishResult> {
  return runFinishEngine(
    h.finisher,
    {
      name: options.name ?? "my-change",
      force: options.force ?? false,
      noPush: options.noPush ?? false,
    },
    { git: h.git, json: true, stdout: (l) => h.stdout.push(l), stderr: (l) => h.stderr.push(l) },
  );
}

const ops = (h: Harness) => h.gitCalls.map((c) => c.op);

beforeEach(() => {
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = 0;
});

describe("runFinishEngine — fresh finish", () => {
  test("happy path: validate → produce → cap sync → commit → sync → tag → push", async () => {
    const h = harness();

    const result = await runEngine(h);

    expect(h.finisherCalls).toEqual([
      "detectProduced:my-change",
      "validate:my-change",
      "isComplete:my-change",
      "produce:my-change",
      "capSync",
    ]);
    expect(ops(h)).toEqual([
      "headRef",
      "add",
      "hasStagedChanges",
      "commit",
      "hasUpstream",
      "fetch",
      "rebaseOntoUpstream",
      "tagExists",
      "tag",
      "push",
    ]);
    expect(result.status).toBe("ok");
    expect(result.resumed).toBe(false);
    expect(result.local).toEqual({ committed: true, tagged: true, pushed: true });
    expect(process.exitCode).toBe(0);
  });

  test("validation failure is never bypassable, even with --force", async () => {
    const h = harness({}, { valid: false, validationErrors: ["missing spec"] });

    const result = await runEngine(h, { force: true });

    expect(h.finisherCalls).toEqual(["detectProduced:my-change", "validate:my-change"]);
    expect(ops(h)).toEqual([]);
    expect(result.step).toBe("validate");
    expect(process.exitCode).toBe(1);
  });

  test("incomplete change is refused without --force", async () => {
    const h = harness({}, { complete: false, remaining: 2 });

    const result = await runEngine(h);

    expect(result.step).toBe("complete-guard");
    expect(ops(h)).not.toContain("commit");
    expect(process.exitCode).toBe(1);
  });

  test("unrelated dirty work is preserved without --force", async () => {
    const h = harness({ changedPaths: ["README.md"] });

    const result = await runEngine(h);

    expect(result.status).toBe("ok");
    expect(h.finisherCalls).toContain("produce:my-change");
  });

  test("--force overrides the completeness guard", async () => {
    const h = harness({ changedPaths: ["README.md"] }, { complete: false });

    const result = await runEngine(h, { force: true });

    expect(h.finisherCalls).not.toContain("isComplete:my-change");
    expect(ops(h)).not.toContain("changedPaths");
    expect(result.status).toBe("ok");
  });

  test("commit stages only the finisher's scoped paths", async () => {
    const h = harness();

    await runEngine(h);

    const add = h.gitCalls.find((c) => c.op === "add");
    expect(add?.args).toEqual([COMMIT_PATHS]);
  });

  test("produce failure does not destroy unrelated work", async () => {
    const h = harness({ head: "PRIOR" }, { produceOk: false, producedAnchor: null });

    const result = await runEngine(h);

    expect(ops(h)).not.toContain("restorePaths");
    expect(ops(h)).not.toContain("commit");
    expect(result.step).toBe("produce");
    expect(result.message).toContain("retained for inspection");
    expect(process.exitCode).toBe(1);
  });

  test("cap sync failure retains the produced artifact for resume", async () => {
    const h = harness({ head: "PRIOR_UNPUSHED" }, { capSync: false });

    const result = await runEngine(h);

    expect(ops(h)).not.toContain("restorePaths");
    expect(ops(h)).not.toContain("commit");
    expect(result.step).toBe("cap-sync");
    expect(result.message).toContain("retained");
    expect(result.message).toContain("resume");
  });

  test("commit failure retains the produced artifact for resume", async () => {
    const h = harness({ failOn: { commit: true } });

    const result = await runEngine(h);

    expect(ops(h)).not.toContain("restorePaths");
    expect(ops(h)).not.toContain("tag");
    expect(result.step).toBe("commit");
    expect(result.status).toBe("error");
    expect(result.message).toContain("retained");
    expect(result.message).toContain("resume");
    expect(result.local.committed).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  test("tag name derives from the produced anchor", async () => {
    const h = harness({}, { producedAnchor: "2020-01-01-legacy" });

    const result = await runEngine(h);

    expect(h.gitCalls.find((c) => c.op === "tag")?.args[0]).toBe("openspec/2020-01-01-legacy");
    expect(result.tag).toBe("openspec/2020-01-01-legacy");
  });

  test("--no-push does every local step but skips sync and push", async () => {
    const h = harness();

    const result = await runEngine(h, { noPush: true });

    expect(ops(h)).toEqual(["headRef", "add", "hasStagedChanges", "commit", "tagExists", "tag"]);
    expect(result.status).toBe("skipped");
    expect(result.local).toEqual({ committed: true, tagged: true, pushed: false });
    expect(process.exitCode).toBe(0);
  });

  test("rebase conflict stops before tag with structured handoff", async () => {
    const h = harness({ rebase: { ok: false, conflictedPaths: ["openspec/specs/a/spec.md"] } });

    const result = await runEngine(h);

    expect(ops(h)).toContain("commit");
    expect(ops(h)).not.toContain("tag");
    expect(ops(h)).not.toContain("resetHard");
    expect(result.step).toBe("sync-remote");
    expect(result.status).toBe("conflict");
    expect(result.conflictedPaths).toEqual(["openspec/specs/a/spec.md"]);
    expect(result.local).toEqual({ committed: true, tagged: false, pushed: false });
    expect(process.exitCode).toBe(1);
  });

  test("post-tag push failure retains commit + tag (no rollback)", async () => {
    const h = harness({ pushOk: false, pushError: "rejected" });

    const result = await runEngine(h);

    expect(ops(h)).not.toContain("resetHard");
    expect(result.step).toBe("push");
    expect(result.local).toEqual({ committed: true, tagged: true, pushed: false });
    expect(process.exitCode).toBe(1);
  });

  test("existing tag is not recreated (idempotent tagging)", async () => {
    const h = harness({ tagExists: true });

    const result = await runEngine(h);

    expect(ops(h)).not.toContain("tag");
    expect(result.local.tagged).toBe(true);
    expect(result.status).toBe("ok");
  });
});

describe("runFinishEngine — resume (already produced)", () => {
  test("skips validate/complete/produce and finishes commit → tag → push", async () => {
    const h = harness(
      { stagedPaths: [`openspec/changes/archive/${ANCHOR}/proposal.md`] },
      { detected: PRODUCED },
    );

    const result = await runEngine(h);

    expect(h.finisherCalls).toEqual(["detectProduced:my-change", "capSync"]);
    expect(h.finisherCalls).not.toContain("validate:my-change");
    expect(h.finisherCalls).not.toContain("produce:my-change");
    expect(result.resumed).toBe(true);
    expect(result.tag).toBe(`openspec/${ANCHOR}`);
    expect(result.local).toEqual({ committed: true, tagged: true, pushed: true });
    expect(process.exitCode).toBe(0);
  });

  test("unrelated staged changes do not block a scoped resume", async () => {
    const inScope = harness({ stagedPaths: ["openspec/specs/a/spec.md"] }, { detected: PRODUCED });
    const outScope = harness(
      { stagedPaths: ["openspec/specs/a/spec.md", "src/other.ts"] },
      { detected: PRODUCED },
    );

    const okResult = await runEngine(inScope);
    const badResult = await runEngine(outScope);

    expect(okResult.status).toBe("ok");
    expect(badResult.status).toBe("ok");
  });

  test("dirty guard ignores unrelated unstaged paths when only artifact paths are staged", async () => {
    const h = harness(
      {
        changedPaths: ["openspec/specs/a/spec.md", "src/other.ts", "notes.txt"],
        stagedPaths: ["openspec/specs/a/spec.md"],
      },
      { detected: PRODUCED },
    );

    const result = await runEngine(h);

    expect(result.status).toBe("ok");
    expect(ops(h)).not.toContain("changedPaths");
    expect(ops(h)).not.toContain("stagedPaths");
  });

  test("staged paths from another openspec change remain outside the finish commit", async () => {
    const h = harness(
      { stagedPaths: ["openspec/changes/other-change/proposal.md"] },
      { detected: PRODUCED },
    );

    const result = await runEngine(h);

    expect(result.status).toBe("ok");
    expect(ops(h)).toContain("commit");
  });

  test("nothing to commit (prior finish already committed) skips commit and pushes", async () => {
    const h = harness({ hasStaged: false }, { detected: PRODUCED });

    const result = await runEngine(h);

    expect(ops(h)).toContain("add");
    expect(ops(h)).not.toContain("commit");
    expect(result.local.committed).toBe(true);
    expect(result.local.pushed).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  test("cap sync failure never destroys the developer's manual produce", async () => {
    const h = harness(
      { stagedPaths: [`openspec/changes/archive/${ANCHOR}/proposal.md`] },
      { detected: PRODUCED, capSync: false },
    );

    const result = await runEngine(h);

    expect(ops(h)).not.toContain("resetHard");
    expect(ops(h)).not.toContain("resetSoft");
    expect(result.step).toBe("cap-sync");
    expect(process.exitCode).toBe(1);
  });
});

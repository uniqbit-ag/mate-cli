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
const RESOLVED: Produced = { anchorName: ANCHOR, commitPaths: COMMIT_PATHS };

type GitCall = { op: string; args: unknown[] };

interface FakeGitOptions {
  currentBranch?: string | null;
  defaultBranch?: string;
  changedPaths?: string[];
  stagedPaths?: string[];
  hasStaged?: boolean;
  hasUpstream?: boolean;
  rebase?: RebaseResult;
  tagExists?: boolean;
  /** Per-name tag existence; takes precedence over the blanket `tagExists`. */
  existingTags?: string[];
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
    async currentBranch() {
      return record(
        "currentBranch",
        [],
        options.currentBranch === undefined ? "main" : options.currentBranch,
      );
    },
    async defaultBranch() {
      return record("defaultBranch", [], options.defaultBranch ?? "main");
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
      const exists = options.existingTags
        ? options.existingTags.includes(name)
        : (options.tagExists ?? false);
      return record("tagExists", [name], exists);
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
  resolved?: Produced;
  resolveError?: string;
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
    async resolve(target) {
      calls.push(`resolve:${target}`);
      return options.resolveError
        ? { ok: false, message: options.resolveError }
        : { ok: true, resolved: options.resolved ?? RESOLVED };
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
  options: { name?: string; noPush?: boolean } = {},
): Promise<FinishResult> {
  return runFinishEngine(
    h.finisher,
    { name: options.name ?? "my-change", noPush: options.noPush ?? false },
    { git: h.git, json: true, stdout: (l) => h.stdout.push(l), stderr: (l) => h.stderr.push(l) },
  );
}

const ops = (h: Harness) => h.gitCalls.map((c) => c.op);

/** No step may reset, restore, or delete a path: the archive is durable input. */
const MUTATING_UNDO_OPS = ["restorePaths", "resetHard", "resetSoft"];

function expectNoUndo(h: Harness): void {
  for (const op of MUTATING_UNDO_OPS) expect(ops(h)).not.toContain(op);
}

beforeEach(() => {
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = 0;
});

describe("runFinishEngine — publication pipeline", () => {
  test("happy path: resolve → branch guard → cap sync → commit → sync → tag → push", async () => {
    const h = harness();

    const result = await runEngine(h);

    expect(h.finisherCalls).toEqual(["resolve:my-change", "capSync"]);
    expect(ops(h)).toEqual([
      "defaultBranch",
      "currentBranch",
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

  test("the pipeline has no validate, complete-guard, or produce step", async () => {
    const h = harness();

    await runEngine(h);

    for (const gone of ["validate", "isComplete", "produce"]) {
      expect(h.finisherCalls.join(",")).not.toContain(gone);
    }
  });

  test("an unresolvable target fails at resolve and mutates nothing", async () => {
    const h = harness({}, { resolveError: "mate: not archived; run `openspec archive x` first." });

    const result = await runEngine(h);

    expect(ops(h)).toEqual([]);
    expect(result.step).toBe("resolve");
    expect(result.status).toBe("error");
    expect(result.anchorName).toBeNull();
    expect(result.message).toContain("openspec archive");
    expect(process.exitCode).toBe(1);
  });

  test("commit stages only the finisher's scoped paths", async () => {
    const h = harness();

    await runEngine(h);

    expect(h.gitCalls.find((c) => c.op === "add")?.args).toEqual([COMMIT_PATHS]);
  });

  test("cap sync failure leaves the archive on disk and never commits", async () => {
    const h = harness({}, { capSync: false });

    const result = await runEngine(h);

    expectNoUndo(h);
    expect(ops(h)).not.toContain("commit");
    expect(ops(h)).not.toContain("tag");
    expect(result.step).toBe("cap-sync");
    expect(result.message).toContain("left in place");
    expect(process.exitCode).toBe(1);
  });

  test("commit failure leaves the archive in place for a retry", async () => {
    const h = harness({ failOn: { commit: true } });

    const result = await runEngine(h);

    expectNoUndo(h);
    expect(ops(h)).not.toContain("tag");
    expect(result.step).toBe("commit");
    expect(result.status).toBe("error");
    expect(result.message).toContain("left in place");
    expect(result.local.committed).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  test("unrelated dirty work survives a failure untouched", async () => {
    const h = harness({ changedPaths: ["README.md", "notes.txt"] }, { capSync: false });

    await runEngine(h);

    expectNoUndo(h);
    /** The engine never even inspects unrelated paths; there is no dirty guard left. */
    expect(ops(h)).not.toContain("changedPaths");
    expect(ops(h)).not.toContain("stagedPaths");
  });

  test("tag name derives from the resolved anchor", async () => {
    const h = harness(
      {},
      { resolved: { anchorName: "2020-01-01-legacy", commitPaths: COMMIT_PATHS } },
    );

    const result = await runEngine(h);

    expect(h.gitCalls.find((c) => c.op === "tag")?.args[0]).toBe("openspec/2020-01-01-legacy");
    expect(result.tag).toBe("openspec/2020-01-01-legacy");
  });

  test("--no-push does every local step but skips sync and push", async () => {
    const h = harness();

    const result = await runEngine(h, { noPush: true });

    expect(ops(h)).toEqual([
      "defaultBranch",
      "currentBranch",
      "add",
      "hasStagedChanges",
      "commit",
      "tagExists",
      "tag",
    ]);
    expect(result.status).toBe("skipped");
    expect(result.local).toEqual({ committed: true, tagged: true, pushed: false });
    expect(process.exitCode).toBe(0);
  });

  test("rebase conflict stops before tag with structured handoff", async () => {
    const h = harness({ rebase: { ok: false, conflictedPaths: ["openspec/specs/a/spec.md"] } });

    const result = await runEngine(h);

    expect(ops(h)).toContain("commit");
    expect(ops(h)).not.toContain("tag");
    expectNoUndo(h);
    expect(result.step).toBe("sync-remote");
    expect(result.status).toBe("conflict");
    expect(result.conflictedPaths).toEqual(["openspec/specs/a/spec.md"]);
    expect(result.local).toEqual({ committed: true, tagged: false, pushed: false });
    expect(process.exitCode).toBe(1);
  });

  test("post-tag push failure retains commit + tag for retry", async () => {
    const h = harness({ pushOk: false, pushError: "rejected" });

    const result = await runEngine(h);

    expectNoUndo(h);
    expect(result.step).toBe("push");
    expect(result.status).toBe("error");
    expect(result.message).toContain("retained locally");
    expect(result.local).toEqual({ committed: true, tagged: true, pushed: false });
    expect(process.exitCode).toBe(1);
  });
});

describe("runFinishEngine — resumed publication", () => {
  test("an existing tag is not recreated and reports resumed", async () => {
    const h = harness({ tagExists: true });

    const result = await runEngine(h);

    expect(ops(h)).not.toContain("tag");
    expect(result.resumed).toBe(true);
    expect(result.local.tagged).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.message).toContain("resumed");
  });

  test("nothing to commit means a prior publication committed this anchor", async () => {
    const h = harness({ hasStaged: false });

    const result = await runEngine(h);

    expect(ops(h)).toContain("add");
    expect(ops(h)).not.toContain("commit");
    expect(result.resumed).toBe(true);
    expect(result.local.committed).toBe(true);
    expect(result.local.pushed).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  test("a first publication is not reported as resumed", async () => {
    const h = harness();

    const result = await runEngine(h);

    expect(result.resumed).toBe(false);
    expect(result.message).not.toContain("resumed");
  });
});

describe("runFinishEngine — default-branch guard", () => {
  test("the companion's default branch passes through to cap sync", async () => {
    const h = harness({ currentBranch: "main", defaultBranch: "main" });

    const result = await runEngine(h);

    expect(h.finisherCalls).toContain("capSync");
    expect(result.status).toBe("ok");
  });

  test("a feature branch is refused before any mutation", async () => {
    const h = harness({ currentBranch: "feature/x", defaultBranch: "main" });

    const result = await runEngine(h);

    expect(h.finisherCalls).toEqual(["resolve:my-change"]);
    expect(ops(h)).toEqual(["defaultBranch", "currentBranch"]);
    expect(result.step).toBe("branch-guard");
    expect(result.status).toBe("error");
    expect(result.message).toContain("feature/x");
    expect(result.message).toContain("main");
    expect(process.exitCode).toBe(1);
  });

  test("a detached HEAD is refused", async () => {
    const h = harness({ currentBranch: null });

    const result = await runEngine(h);

    expect(ops(h)).not.toContain("add");
    expect(result.step).toBe("branch-guard");
    expect(result.message).toContain("detached");
    expect(process.exitCode).toBe(1);
  });

  test("--no-push is guarded too, because the local tag is the same anchor", async () => {
    const h = harness({ currentBranch: "feature/x" });

    const result = await runEngine(h, { noPush: true });

    expect(ops(h)).not.toContain("commit");
    expect(ops(h)).not.toContain("tag");
    expect(result.step).toBe("branch-guard");
    expect(result.status).toBe("error");
  });

  test("a companion with no configured remote HEAD falls back to its resolved default", async () => {
    const h = harness({ currentBranch: "trunk", defaultBranch: "trunk" });

    const result = await runEngine(h);

    expect(result.status).toBe("ok");
    expect(result.step).toBe("done");
  });
});

describe("runFinishEngine — tag namespace and commit subject", () => {
  const tagged = (h: Harness): GitCall | undefined => h.gitCalls.find((c) => c.op === "tag");
  const committed = (h: Harness): GitCall | undefined => h.gitCalls.find((c) => c.op === "commit");

  test("a finisher supplying neither field keeps the pre-change tag and subject", async () => {
    const h = harness();

    const result = await runEngine(h);

    expect(result.tag).toBe(`openspec/${ANCHOR}`);
    expect(tagged(h)?.args[0]).toBe(`openspec/${ANCHOR}`);
    expect(committed(h)?.args[0]).toBe(`chore(openspec): finish ${ANCHOR}`);
  });

  test("a finisher supplying both fields drives the tag and the subject", async () => {
    const resolved: Produced = {
      anchorName: "2026-09-14",
      commitPaths: ["openspec/specs/widget-api/spec.md"],
      tagNamespace: "openspec/specs",
      commitSubject: "chore(openspec): sync canonical specs",
    };
    const h = harness({}, { resolved });

    const result = await runEngine(h);

    expect(result.status).toBe("ok");
    expect(result.tag).toBe("openspec/specs/2026-09-14");
    expect(tagged(h)?.args[0]).toBe("openspec/specs/2026-09-14");
    expect(committed(h)?.args[0]).toBe("chore(openspec): sync canonical specs");
    expect(committed(h)?.args[1]).toEqual(["openspec/specs/widget-api/spec.md"]);
  });

  test("the pipeline order is identical whichever fields the finisher supplies", async () => {
    const bare = harness();
    const custom = harness(
      {},
      {
        resolved: {
          anchorName: "2026-09-14",
          commitPaths: ["openspec/specs/widget-api/spec.md"],
          tagNamespace: "openspec/specs",
          commitSubject: "chore(openspec): sync canonical specs",
        },
      },
    );

    await runEngine(bare);
    await runEngine(custom);

    expect(ops(custom)).toEqual(ops(bare));
  });
});

describe("runFinishEngine — tag collision policy", () => {
  const specs = (overrides: Partial<Produced> = {}): Produced => ({
    anchorName: "2026-09-14",
    commitPaths: ["openspec/specs/widget-api/spec.md"],
    tagNamespace: "openspec/specs",
    commitSubject: "chore(openspec): sync canonical specs",
    tagCollision: "suffix",
    ...overrides,
  });
  const tagNames = (h: Harness): unknown[] =>
    h.gitCalls.filter((c) => c.op === "tag").map((c) => c.args[0]);

  test("a free name is taken as-is", async () => {
    const h = harness({ existingTags: [] }, { resolved: specs() });

    const result = await runEngine(h);

    expect(result.tag).toBe("openspec/specs/2026-09-14");
    expect(tagNames(h)).toEqual(["openspec/specs/2026-09-14"]);
  });

  test("a taken name yields the next free suffix and never moves the existing tag", async () => {
    const h = harness({ existingTags: ["openspec/specs/2026-09-14"] }, { resolved: specs() });

    const result = await runEngine(h);

    expect(result.tag).toBe("openspec/specs/2026-09-14.2");
    expect(tagNames(h)).toEqual(["openspec/specs/2026-09-14.2"]);
  });

  test("suffix selection skips every taken name", async () => {
    const h = harness(
      { existingTags: ["openspec/specs/2026-09-14", "openspec/specs/2026-09-14.2"] },
      { resolved: specs() },
    );

    const result = await runEngine(h);

    expect(result.tag).toBe("openspec/specs/2026-09-14.3");
  });

  test("a resumed run reuses its existing tag rather than taking a suffix", async () => {
    const h = harness(
      { hasStaged: false, existingTags: ["openspec/specs/2026-09-14"] },
      { resolved: specs() },
    );

    const result = await runEngine(h);

    expect(result.resumed).toBe(true);
    expect(result.tag).toBe("openspec/specs/2026-09-14");
    expect(tagNames(h)).toEqual([]);
  });

  test("the default policy still reuses a taken tag", async () => {
    const h = harness({ tagExists: true }, { resolved: specs({ tagCollision: undefined }) });

    const result = await runEngine(h);

    expect(result.resumed).toBe(true);
    expect(result.tag).toBe("openspec/specs/2026-09-14");
    expect(tagNames(h)).toEqual([]);
  });

  test("suffix probing happens after the remote sync so fetched tags are seen", async () => {
    const h = harness({ existingTags: ["openspec/specs/2026-09-14"] }, { resolved: specs() });

    await runEngine(h);

    const order = ops(h);
    expect(order.indexOf("fetch")).toBeLessThan(order.indexOf("tag"));
    expect(order.indexOf("rebaseOntoUpstream")).toBeLessThan(order.indexOf("tag"));
  });
});

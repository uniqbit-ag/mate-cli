import { afterEach, describe, expect, test } from "bun:test";

import { unlinkedRecord, upsertDelivery, type DeliveryRecord } from "./record";
import type { Containment, FetchResult, MergeGit, PatchMatch, PullRef } from "./merge-git";
import { refreshRecord, type LocalMergeAccess } from "./refresh";
import { parseRemote } from "./remote";

const REPO = "acme/acme-app";
const now = () => new Date("2026-10-28T10:00:00.000Z");
const HEAD = "a".repeat(40);
const SQUASH = "b".repeat(40);
const OTHER = "c".repeat(40);

const linked = (branch = "change/x") => upsertDelivery(unlinkedRecord("x"), REPO, { branch });

interface LocalState {
  tip?: string | null;
  known?: string[];
  /** The local branch, when it differs from the remote tip. */
  localTip?: string;
  /** Commits ahead of the remote tip. */
  ahead?: string[];
  onDefault?: string[];
  /** Heads on the default branch's own first-parent line: a fast-forward or no own commits. */
  firstParent?: string[];
  /** The first-parent check failed. */
  firstParentUnknown?: boolean;
  containing?: Containment;
  match?: PatchMatch | null;
  fetch?: FetchResult;
  pullRefs?: PullRef[];
  pullHead?: string | null;
  origin?: string;
}

/** A checkout whose answers are fixed; records which queries ran. */
function local(state: LocalState, calls: string[] = []): () => Promise<LocalMergeAccess> {
  const git: MergeGit = {
    isRepository: async () => true,
    originUrl: async () => state.origin ?? "git@github.com:acme/acme-app.git",
    tip: async () => {
      calls.push("tip");
      return state.tip === undefined ? HEAD : state.tip;
    },
    localTip: async () => state.localTip ?? null,
    remoteTip: async () => (state.tip === undefined ? HEAD : state.tip),
    dirtyWorktree: async () => null,
    aheadOf: async (_base, candidate) => (state.ahead ?? []).includes(candidate),
    hasCommit: async (commit) => {
      calls.push(`hasCommit ${commit}`);
      return (state.known ?? []).includes(commit);
    },
    isAncestor: async (commit) => {
      calls.push("isAncestor");
      return (state.onDefault ?? []).includes(commit);
    },
    onFirstParent: async (commit) =>
      state.firstParentUnknown ? null : (state.firstParent ?? []).includes(commit),
    patchMatch: async () => {
      calls.push("patchMatch");
      return state.match ?? null;
    },
    supportsContainment: async () => true,
    contains: async () => null,
    firstContaining: async () => {
      calls.push("firstContaining");
      return state.containing ?? "none";
    },
    lastFetchedAt: async () => "2026-11-01T00:00:00.000Z",
    fetch: async () => ({ ok: true }),
    pullRefs: async () => state.pullRefs ?? [],
    fetchPullHead: async (number, ref) => {
      calls.push(`fetchPullHead ${ref}/${number}`);
      return state.pullHead ?? null;
    },
  };
  return async () => ({
    git,
    defaultBranch: "main",
    fetch: async () => {
      calls.push("fetch");
      return state.fetch ?? { ok: true };
    },
    remote: async () => parseRemote((await git.originUrl()) ?? ""),
    pullRefs: async () => {
      calls.push("pullRefs");
      return git.pullRefs();
    },
  });
}

describe("refreshRecord", () => {
  test("a merge commit settles with source git and records the head", async () => {
    const { record, outcomes } = await refreshRecord(linked(), {
      now,
      localAccess: local({ onDefault: [HEAD] }),
    });
    expect(outcomes).toEqual([
      { repository: REPO, branch: "change/x", result: "merged", needsAnswer: false },
    ]);
    expect(record.deliveries[0]).toEqual({
      repository: REPO,
      branch: "change/x",
      head: HEAD,
      merge: { state: "merged", source: "git", checkedAt: now().toISOString() },
    });
  });

  test("a merge commit only suggests for a head recorded as unpushed", async () => {
    // The head may be the tip the branch started from, merged with that other branch.
    const recorded = upsertDelivery(linked(), REPO, { head: HEAD, unpushed: true });
    const { record, outcomes } = await refreshRecord(recorded, {
      now,
      localAccess: local({ tip: null, localTip: HEAD, known: [HEAD], onDefault: [HEAD] }),
    });
    expect(outcomes[0]).toMatchObject({
      result: "unknown",
      needsAnswer: true,
      answerReason: "likely-merged",
      suggestion: { commit: HEAD, style: "merge" },
    });
    expect(record.deliveries[0].merge).toBeUndefined();
  });

  test("a default-branch commit containing the head settles with its commit and time", async () => {
    const { record, outcomes } = await refreshRecord(linked(), {
      now,
      localAccess: local({
        containing: { commit: SQUASH, committedAt: "2026-10-27T09:00:00.000Z" },
      }),
    });
    expect(outcomes[0]).toMatchObject({ result: "merged", needsAnswer: false });
    expect(record.deliveries[0].merge).toEqual({
      state: "merged",
      source: "git",
      checkedAt: now().toISOString(),
      mergeCommit: SQUASH,
      mergedAt: "2026-10-27T09:00:00.000Z",
    });
  });

  test("a final merge, from git or an earlier Mate's forge, is not checked again", async () => {
    for (const source of ["git", "forge"] as const) {
      const calls: string[] = [];
      const settled = upsertDelivery(linked(), REPO, {
        merge: { state: "merged", source, checkedAt: "earlier", mergeCommit: SQUASH },
      });
      const { record, outcomes } = await refreshRecord(settled, {
        now,
        localAccess: local({}, calls),
        fetch: true,
      });
      expect(record).toEqual(settled);
      expect(outcomes).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  test("a user's merged or dropped answer stands without a Git command", async () => {
    for (const state of ["merged", "closed-unmerged"] as const) {
      const calls: string[] = [];
      const answered = upsertDelivery(linked(), REPO, {
        merge: { state, source: "user", checkedAt: "earlier" },
      });
      const { record } = await refreshRecord(answered, { now, localAccess: local({}, calls) });
      expect(record).toEqual(answered);
      expect(calls).toEqual([]);
    }
  });

  test("a user's not-yet-merged answer is settled by Git", async () => {
    const answered = upsertDelivery(linked(), REPO, {
      merge: { state: "open", source: "user", checkedAt: "earlier" },
    });
    const { record } = await refreshRecord(answered, {
      now,
      localAccess: local({ onDefault: [HEAD] }),
    });
    expect(record.deliveries[0].merge).toMatchObject({ state: "merged", source: "git" });
  });

  test("a head on the default branch's own line is only a fast-forward suggestion", async () => {
    const { record, outcomes } = await refreshRecord(linked(), {
      now,
      localAccess: local({ onDefault: [HEAD], firstParent: [HEAD] }),
    });
    expect(outcomes[0]).toMatchObject({
      needsAnswer: true,
      answerReason: "likely-merged",
      suggestion: { commit: HEAD, style: "fast-forward" },
    });
    expect(record.deliveries[0].merge).toBeUndefined();
  });

  test("a local branch ahead of the merged remote tip is the head and settles nothing", async () => {
    const { record, outcomes } = await refreshRecord(linked(), {
      now,
      localAccess: local({ onDefault: [HEAD], localTip: OTHER, ahead: [OTHER] }),
    });
    expect(outcomes[0]).toMatchObject({ result: "unknown", answerReason: "not-on-default" });
    expect(outcomes[0]).not.toHaveProperty("unpushed");
    expect(record.deliveries[0]).toEqual({
      repository: REPO,
      branch: "change/x",
      head: OTHER,
      unpushed: true,
    });
  });

  test("a recorded head ahead of the remote tip stays the head", async () => {
    const recorded = upsertDelivery(linked(), REPO, { head: OTHER });
    const { record, outcomes } = await refreshRecord(recorded, {
      now,
      localAccess: local({ onDefault: [HEAD], known: [OTHER], ahead: [OTHER] }),
    });
    expect(outcomes[0]).toMatchObject({ result: "unknown", needsAnswer: true });
    expect(record.deliveries[0]).toEqual({
      repository: REPO,
      branch: "change/x",
      head: OTHER,
      unpushed: true,
    });
  });

  test("a head that reached the remote loses its unpushed mark", async () => {
    const recorded = upsertDelivery(linked(), REPO, { head: HEAD, unpushed: true });
    const { record } = await refreshRecord(recorded, {
      now,
      localAccess: local({ known: [HEAD] }),
    });
    expect(record.deliveries[0]).toEqual({ repository: REPO, branch: "change/x", head: HEAD });
  });

  test("an unpushed head the checkout lacks is not replaced by the fetched tip or the PR", async () => {
    const record = upsertDelivery(linked(), REPO, {
      pr: "https://github.com/acme/acme-app/pull/7",
      head: OTHER,
      unpushed: true,
    });
    const calls: string[] = [];
    const { record: next, outcomes } = await refreshRecord(record, {
      now,
      localAccess: local({ tip: HEAD, known: [], onDefault: [HEAD], pullHead: HEAD }, calls),
      fetch: true,
    });
    expect(outcomes[0]).toMatchObject({
      result: "unknown",
      needsAnswer: true,
      answerReason: "not-on-default",
    });
    expect(calls.some((call) => call.startsWith("fetchPullHead"))).toBe(false);
    expect(next).toEqual(record);
  });

  test("a first-parent check that failed asks instead of settling", async () => {
    const { record, outcomes } = await refreshRecord(linked(), {
      now,
      localAccess: local({ onDefault: [HEAD], firstParentUnknown: true }),
    });
    expect(outcomes[0]).toMatchObject({
      result: "unknown",
      needsAnswer: true,
      answerReason: "likely-merged",
    });
    expect(record.deliveries[0].merge).toBeUndefined();
  });

  test("when containment cannot tell, a patch match is a suggestion that records nothing", async () => {
    const { record, outcomes } = await refreshRecord(linked(), {
      now,
      localAccess: local({ containing: "unknown", match: { commit: SQUASH, style: "squash" } }),
    });
    expect(outcomes[0]).toMatchObject({
      result: "unknown",
      needsAnswer: true,
      answerReason: "likely-merged",
      suggestion: { commit: SQUASH, style: "squash" },
    });
    expect(record.deliveries[0].merge).toBeUndefined();
    expect(record.deliveries[0].head).toBe(HEAD);
  });

  test("a head no commit contains waits, with the last fetch time and no patch match", async () => {
    const calls: string[] = [];
    const { outcomes } = await refreshRecord(linked(), { now, localAccess: local({}, calls) });
    expect(outcomes[0]).toMatchObject({
      needsAnswer: true,
      answerReason: "not-on-default",
      fetchedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(outcomes[0]).not.toHaveProperty("fetch");
    expect(calls).not.toContain("patchMatch");
  });

  test("a branch deleted on the remote whose content never arrived asks to drop", async () => {
    const record = upsertDelivery(linked(), REPO, { head: HEAD });
    const deleted = { tip: null, known: [HEAD], fetch: { ok: true, branchDeleted: true } };
    const { record: next, outcomes } = await refreshRecord(record, {
      now,
      localAccess: local(deleted),
      fetch: true,
    });
    expect(outcomes[0]).toMatchObject({ needsAnswer: true, answerReason: "branch-deleted" });
    expect(next.deliveries[0].merge).toBeUndefined();

    // Without a fetch a missing branch is no evidence.
    const { outcomes: local_ } = await refreshRecord(record, { now, localAccess: local(deleted) });
    expect(local_[0]).toMatchObject({ answerReason: "not-on-default" });
  });

  test("a recorded head the checkout lacks keeps an older tip from settling", async () => {
    const record = upsertDelivery(linked(), REPO, { head: OTHER });
    const stale = { tip: HEAD, known: [], onDefault: [HEAD] };
    const { record: next, outcomes } = await refreshRecord(record, {
      now,
      localAccess: local(stale),
    });
    expect(outcomes[0]).toMatchObject({
      result: "unknown",
      needsAnswer: true,
      answerReason: "not-on-default",
    });
    expect(next.deliveries[0].merge).toBeUndefined();

    // A fetch shows the branch as the remote has it: its tip decides.
    const fetched = await refreshRecord(record, { now, localAccess: local(stale), fetch: true });
    expect(fetched.outcomes[0]).toMatchObject({ result: "merged" });
  });

  test("a branch deleted after a squash merge is recorded through its head", async () => {
    const record = upsertDelivery(linked(), REPO, { head: HEAD });
    const { record: next, outcomes } = await refreshRecord(record, {
      now,
      localAccess: local({
        tip: null,
        known: [HEAD],
        fetch: { ok: true, branchDeleted: true },
        containing: { commit: SQUASH, committedAt: "2026-10-27T09:00:00.000Z" },
      }),
      fetch: true,
    });
    expect(outcomes[0]).toMatchObject({ result: "merged", needsAnswer: false });
    expect(next.deliveries[0].merge).toMatchObject({ source: "git", mergeCommit: SQUASH });
  });

  test("a malformed recorded head never reaches Git", async () => {
    const record: DeliveryRecord = {
      ...linked(),
      deliveries: [{ repository: REPO, branch: "change/x", head: "--output=/tmp/acme" }],
    };
    const calls: string[] = [];
    const { outcomes } = await refreshRecord(record, {
      now,
      localAccess: local({ tip: null }, calls),
    });
    expect(calls.some((call) => call.includes("--output"))).toBe(false);
    expect(outcomes[0]).toMatchObject({ needsAnswer: true, answerReason: "not-on-default" });
  });

  test("without a linked checkout the delivery needs an answer", async () => {
    const { record, outcomes } = await refreshRecord(linked(), {
      now,
      localAccess: async () => null,
    });
    expect(record).toEqual(linked());
    expect(outcomes[0]).toEqual({
      repository: REPO,
      branch: "change/x",
      result: "unknown",
      needsAnswer: true,
      answerReason: "no-checkout",
    });
  });

  test("a direct delivery always needs the user's answer and never reaches Git", async () => {
    const calls: string[] = [];
    const direct = upsertDelivery(unlinkedRecord("x"), REPO, { branch: "main", direct: true });
    const { record, outcomes } = await refreshRecord(direct, {
      now,
      localAccess: local({ onDefault: [HEAD] }, calls),
      fetch: true,
    });
    expect(outcomes[0]).toEqual({
      repository: REPO,
      branch: "main",
      result: "unknown",
      needsAnswer: true,
      answerReason: "direct",
    });
    expect(record.deliveries[0].merge).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("a shared branch is looked up once per run", async () => {
    const calls: string[] = [];
    const cache = new Map();
    for (const name of ["a", "b"]) {
      const record = upsertDelivery(unlinkedRecord(name), REPO, { branch: "change/shared" });
      await refreshRecord(record, { now, localAccess: local({}, calls), cache });
    }
    expect(calls.filter((call) => call === "tip")).toHaveLength(1);
  });

  test("a direct and a PR delivery of one branch never share a cached answer", async () => {
    const cache = new Map();
    const pr = upsertDelivery(unlinkedRecord("a"), REPO, { branch: "main" });
    const direct = upsertDelivery(unlinkedRecord("b"), REPO, { branch: "main", direct: true });
    await refreshRecord(pr, { now, localAccess: local({ onDefault: [HEAD] }), cache });
    const { outcomes } = await refreshRecord(direct, {
      now,
      localAccess: local({ onDefault: [HEAD] }),
      cache,
    });
    expect(outcomes[0]).toMatchObject({ answerReason: "direct" });
  });

  test("not-applicable deliveries are never looked up", async () => {
    const calls: string[] = [];
    const record = upsertDelivery(unlinkedRecord("x"), REPO, { notApplicable: "docs only" });
    const { outcomes } = await refreshRecord(record, { now, localAccess: local({}, calls) });
    expect(outcomes).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("fetch runs only when asked, and a failed fetch still checks local refs", async () => {
    const calls: string[] = [];
    await refreshRecord(linked(), { now, localAccess: local({}, calls) });
    expect(calls).not.toContain("fetch");
    expect(calls).not.toContain("pullRefs");

    const { outcomes } = await refreshRecord(linked(), {
      now,
      localAccess: local(
        { onDefault: [HEAD], fetch: { ok: false, message: "git fetch failed: offline" } },
        calls,
      ),
      fetch: true,
    });
    expect(calls).toContain("fetch");
    expect(outcomes[0]).toMatchObject({
      result: "merged",
      fetch: { ok: false, message: "git fetch failed: offline" },
    });
  });
});

describe("refreshRecord PR lookup", () => {
  const pulls: PullRef[] = [
    { number: 40, ref: "pull", commit: HEAD },
    { number: 42, ref: "pull", commit: HEAD },
    { number: 43, ref: "pull", commit: OTHER },
  ];

  test("the one PR whose head is the delivery's head is recorded, with the checkout's host", async () => {
    const { record, outcomes } = await refreshRecord(linked(), {
      now,
      localAccess: local({
        pullRefs: pulls.filter((pull) => pull.number !== 40),
        origin: "git@github.com:acme/acme-app.git",
      }),
      fetch: true,
    });
    expect(outcomes[0]).toMatchObject({ pr: "https://github.com/acme/acme-app/pull/42" });
    expect(record.deliveries[0].pr).toBe("https://github.com/acme/acme-app/pull/42");
  });

  test("several PRs on the delivery's head record none: a fork may open one on it", async () => {
    const { record } = await refreshRecord(linked(), {
      now,
      localAccess: local({ pullRefs: pulls, origin: "git@github.com:acme/acme-app.git" }),
      fetch: true,
    });
    expect(record.deliveries[0].pr).toBeUndefined();
  });

  test("a GitLab merge request gets its own URL form", async () => {
    const { record } = await refreshRecord(linked(), {
      now,
      localAccess: local({
        pullRefs: [{ number: 7, ref: "merge-requests", commit: HEAD }],
        origin: "git@gitlab.com:acme/acme-app.git",
      }),
      fetch: true,
    });
    expect(record.deliveries[0].pr).toBe("https://gitlab.com/acme/acme-app/-/merge_requests/7");
  });

  test("a self-hosted host settles from Git and records no PR URL", async () => {
    const { record } = await refreshRecord(linked(), {
      now,
      localAccess: local({
        pullRefs: pulls,
        origin: "git@git.acme.dev:acme/acme-app.git",
        containing: { commit: SQUASH, committedAt: "2026-10-27T09:00:00.000Z" },
      }),
      fetch: true,
    });
    expect(record.deliveries[0].merge).toMatchObject({ state: "merged", source: "git" });
    expect(record.deliveries[0].pr).toBeUndefined();
  });

  test("a recorded PR is kept and no listing runs for it", async () => {
    const calls: string[] = [];
    const record = upsertDelivery(linked(), REPO, {
      pr: "https://github.com/acme/acme-app/pull/9",
    });
    const { record: next } = await refreshRecord(record, {
      now,
      localAccess: local({ pullRefs: pulls, onDefault: [HEAD] }, calls),
      fetch: true,
    });
    expect(next.deliveries[0]).toMatchObject({
      pr: "https://github.com/acme/acme-app/pull/9",
      merge: { state: "merged" },
    });
    expect(calls).not.toContain("pullRefs");
  });

  test("a deleted branch without a head is recovered from its recorded PR's head ref", async () => {
    const calls: string[] = [];
    const record = upsertDelivery(linked(), REPO, {
      pr: "https://github.com/acme/acme-app/pull/42",
    });
    const { record: next } = await refreshRecord(record, {
      now,
      localAccess: local(
        {
          tip: null,
          pullHead: HEAD,
          containing: { commit: SQUASH, committedAt: "2026-10-27T09:00:00.000Z" },
        },
        calls,
      ),
      fetch: true,
    });
    expect(calls).toContain("fetchPullHead pull/42");
    expect(next.deliveries[0]).toMatchObject({ head: HEAD, merge: { state: "merged" } });
  });

  test("a recorded PR of another repository is never fetched", async () => {
    const calls: string[] = [];
    const record = upsertDelivery(linked(), REPO, {
      pr: "https://github.com/acme/acme-lib/pull/42",
    });
    const { record: next } = await refreshRecord(record, {
      now,
      localAccess: local({ tip: null, pullHead: HEAD }, calls),
      fetch: true,
    });
    expect(calls.some((call) => call.startsWith("fetchPullHead"))).toBe(false);
    expect(next.deliveries[0]?.merge?.state).not.toBe("merged");
  });

  test("without a fetch no PR head ref is fetched", async () => {
    const calls: string[] = [];
    const record = upsertDelivery(linked(), REPO, {
      pr: "https://github.com/acme/acme-app/pull/42",
    });
    await refreshRecord(record, { now, localAccess: local({ tip: null, pullHead: HEAD }, calls) });
    expect(calls.some((call) => call.startsWith("fetchPullHead"))).toBe(false);
  });
});

describe("refreshRecord network use", () => {
  const savedFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  test("no HTTP request is sent", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      throw new Error("no request expected");
    }) as unknown as typeof fetch;
    const { record } = await refreshRecord(linked(), {
      now,
      localAccess: local({ containing: { commit: SQUASH, committedAt: "t" }, pullRefs: [] }),
      fetch: true,
    });
    expect(record.deliveries[0].merge).toMatchObject({ source: "git" });
    expect(requests).toEqual([]);
  });
});

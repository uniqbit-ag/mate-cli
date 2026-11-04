import { describe, expect, test } from "bun:test";

import type { ForgeAdapter, PullClassification } from "./forge";
import { unlinkedRecord, upsertDelivery } from "./record";
import type { MergeGit, PatchMatch } from "./merge-git";
import { refreshRecord, type ForgeAccess, type LocalMergeAccess } from "./refresh";

const REPO = "acme/acme-app";
const now = () => new Date("2026-10-28T10:00:00.000Z");

function adapter(answer: PullClassification, calls: string[] = []): ForgeAdapter {
  return {
    id: "github",
    async defaultBranch() {
      return { ok: true, value: "main" };
    },
    async pullsForBranch(_repo, branch) {
      calls.push(branch);
      return { ok: true, value: answer };
    },
  };
}

const access = (forge: ForgeAdapter) => async (): Promise<ForgeAccess> => ({
  adapter: forge,
  repo: { host: "github.com", owner: "acme", repo: "acme-app" },
});

const linked = (branch = "change/x") => upsertDelivery(unlinkedRecord("x"), REPO, { branch });

describe("refreshRecord", () => {
  test("a user's merged or dropped answer is not overwritten by the forge", async () => {
    for (const state of ["merged", "closed-unmerged"] as const) {
      const calls: string[] = [];
      const answered = upsertDelivery(linked(), REPO, {
        merge: { state, source: "user", checkedAt: "earlier" },
      });
      const { record, outcomes } = await refreshRecord(answered, {
        now,
        forgeAccess: access(adapter({ kind: "open", pr: { number: 7, url: "u7" } }, calls)),
      });
      expect(record).toEqual(answered);
      expect(outcomes).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  test("a user's not-yet-merged answer is still settled by the forge", async () => {
    const answered = upsertDelivery(linked(), REPO, {
      merge: { state: "open", source: "user", checkedAt: "earlier" },
    });
    const { record } = await refreshRecord(answered, {
      now,
      forgeAccess: access(adapter({ kind: "merged", pr: { number: 7, url: "u7" } })),
    });
    expect(record.deliveries[0].merge).toMatchObject({ state: "merged", source: "forge" });
  });

  test("a merged PR is recorded with source forge and full provenance", async () => {
    const forge = adapter({
      kind: "merged",
      pr: { number: 7, url: "u7", mergedAt: "m", mergeCommit: "c", mergedBy: "octo" },
    });
    const { record, outcomes } = await refreshRecord(linked(), { now, forgeAccess: access(forge) });
    expect(record.deliveries[0]).toEqual({
      repository: REPO,
      branch: "change/x",
      pr: "u7",
      merge: {
        state: "merged",
        source: "forge",
        checkedAt: "2026-10-28T10:00:00.000Z",
        mergedAt: "m",
        mergeCommit: "c",
        mergedBy: "octo",
      },
    });
    expect(outcomes).toEqual([
      { repository: REPO, branch: "change/x", result: "merged", pr: "u7", needsAnswer: false },
    ]);
  });

  test("without a token nothing is recorded and an answer is needed", async () => {
    const { record, outcomes } = await refreshRecord(linked(), {
      now,
      forgeAccess: async () => ({ unavailable: "no-token" }),
    });
    expect(record).toEqual(linked());
    expect(outcomes[0]).toMatchObject({ needsAnswer: true, answerReason: "no-token" });
  });

  test("an ambiguous branch lists candidates and records nothing", async () => {
    const candidates = [
      { number: 1, url: "u1", state: "merged" as const },
      { number: 2, url: "u2", state: "open" as const },
    ];
    const { record, outcomes } = await refreshRecord(linked(), {
      now,
      forgeAccess: access(adapter({ kind: "ambiguous", candidates })),
    });
    expect(record.deliveries[0].merge).toBeUndefined();
    expect(outcomes[0]).toMatchObject({ result: "ambiguous", candidates, needsAnswer: true });
  });

  test("a direct delivery always needs the user's answer", async () => {
    const direct = upsertDelivery(unlinkedRecord("x"), REPO, { branch: "main", direct: true });
    const { record, outcomes } = await refreshRecord(direct, {
      now,
      forgeAccess: access(adapter({ kind: "none" })),
    });
    expect(outcomes[0]).toEqual({
      repository: REPO,
      branch: "main",
      result: "unknown",
      needsAnswer: true,
      answerReason: "direct",
    });
    expect(record.deliveries[0].merge).toBeUndefined();
  });

  test("a shared branch is looked up once per run", async () => {
    const calls: string[] = [];
    const forge = adapter({ kind: "open", pr: { number: 3, url: "u3" } }, calls);
    const cache = new Map();
    for (const name of ["a", "b", "c"]) {
      const record = upsertDelivery(unlinkedRecord(name), REPO, { branch: "feature/f" });
      await refreshRecord(record, { now, forgeAccess: access(forge), cache });
    }
    expect(calls).toEqual(["feature/f"]);
  });

  test("a direct and a PR delivery of one branch never share a cached answer", async () => {
    const calls: string[] = [];
    const cache = new Map();
    const options = {
      now,
      forgeAccess: access(adapter({ kind: "none" }, calls)),
      cache,
    };
    const direct = upsertDelivery(unlinkedRecord("a"), REPO, { branch: "main", direct: true });
    const viaPr = upsertDelivery(unlinkedRecord("b"), REPO, { branch: "main" });
    await refreshRecord(direct, options);
    const { record, outcomes } = await refreshRecord(viaPr, options);
    expect(calls).toEqual(["main"]);
    expect(outcomes[0]).toMatchObject({ result: "none", answerReason: "no-pr" });
    expect(record.deliveries[0].merge).toBeUndefined();
  });

  test("not-applicable deliveries are never looked up", async () => {
    const calls: string[] = [];
    const record = upsertDelivery(unlinkedRecord("x"), REPO, { notApplicable: "spec only" });
    const { outcomes } = await refreshRecord(record, {
      now,
      forgeAccess: access(adapter({ kind: "none" }, calls)),
    });
    expect(outcomes).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a recorded PR closed unmerged does not hide a newer PR from the same branch", async () => {
    const asked: Array<number | undefined> = [];
    const forge: ForgeAdapter = {
      id: "github",
      async defaultBranch() {
        return { ok: true, value: "main" };
      },
      async pullsForBranch(_repo, _branch, prNumber) {
        asked.push(prNumber);
        return prNumber === 1
          ? { ok: true, value: { kind: "closed-unmerged", pr: { number: 1, url: "u/pull/1" } } }
          : { ok: true, value: { kind: "merged", pr: { number: 2, url: "u/pull/2" } } };
      },
    };
    const dropped = upsertDelivery(linked(), REPO, {
      pr: "u/pull/1",
      merge: { state: "closed-unmerged", source: "forge", checkedAt: "earlier" },
    });
    const { record } = await refreshRecord(dropped, { now, forgeAccess: access(forge) });
    expect(asked).toEqual([1, undefined]);
    expect(record.deliveries[0]).toMatchObject({
      pr: "u/pull/2",
      merge: { state: "merged", source: "forge" },
    });
  });

  test("a recorded PR that is the branch's only one stays closed unmerged", async () => {
    const calls: string[] = [];
    const forge = adapter({ kind: "closed-unmerged", pr: { number: 1, url: "u/pull/1" } }, calls);
    const recorded = upsertDelivery(linked(), REPO, { pr: "u/pull/1" });
    const { record } = await refreshRecord(recorded, { now, forgeAccess: access(forge) });
    expect(calls).toHaveLength(2);
    expect(record.deliveries[0].merge?.state).toBe("closed-unmerged");
  });
});

const HEAD = "a".repeat(40);
const SQUASH = "b".repeat(40);

interface LocalState {
  tip?: string | null;
  known?: string[];
  onDefault?: string[];
  /** Heads on the default branch's own first-parent line: a fast-forward or no own commits. */
  firstParent?: string[];
  match?: PatchMatch | null;
  fetchOk?: boolean;
}

/** A checkout whose answers are fixed; records which queries ran. */
function local(state: LocalState, calls: string[] = []): () => Promise<LocalMergeAccess> {
  const git: MergeGit = {
    isRepository: async () => true,
    tip: async () => {
      calls.push("tip");
      return state.tip === undefined ? HEAD : state.tip;
    },
    hasCommit: async (commit) => (state.known ?? []).includes(commit),
    isAncestor: async (commit) => {
      calls.push("isAncestor");
      return (state.onDefault ?? []).includes(commit);
    },
    onFirstParent: async (commit) => (state.firstParent ?? []).includes(commit),
    patchMatch: async () => state.match ?? null,
    lastFetchedAt: async () => "2026-11-01T00:00:00.000Z",
    fetch: async () => ({ ok: true }),
  };
  return async () => ({
    git,
    defaultBranch: "main",
    fetch: async () => {
      calls.push("fetch");
      return state.fetchOk === false
        ? { ok: false, message: "git fetch failed: offline" }
        : { ok: true };
    },
  });
}

const noToken = async (): Promise<ForgeAccess> => ({ unavailable: "no-token" });

describe("refreshRecord with a local checkout", () => {
  test("without a token Git settles a merge and records the head", async () => {
    const { record, outcomes } = await refreshRecord(linked(), {
      now,
      forgeAccess: noToken,
      localAccess: local({ onDefault: [HEAD] }),
    });
    expect(outcomes[0]).toMatchObject({ result: "merged", needsAnswer: false });
    expect(record.deliveries[0]).toMatchObject({
      head: HEAD,
      merge: { state: "merged", source: "git", checkedAt: now().toISOString() },
    });
  });

  test("the forge answer wins and Git only adds the head", async () => {
    const calls: string[] = [];
    const { record } = await refreshRecord(linked(), {
      now,
      forgeAccess: access(adapter({ kind: "open", pr: { number: 7, url: "u7" } })),
      localAccess: local({ onDefault: [HEAD] }, calls),
    });
    expect(record.deliveries[0].merge).toMatchObject({ state: "open", source: "forge" });
    expect(record.deliveries[0].head).toBe(HEAD);
    expect(calls).toEqual(["tip"]);
  });

  test("a head on the default branch's own line is only a fast-forward suggestion", async () => {
    const { record, outcomes } = await refreshRecord(linked(), {
      now,
      forgeAccess: noToken,
      localAccess: local({ onDefault: [HEAD], firstParent: [HEAD] }),
    });
    expect(outcomes[0]).toMatchObject({
      needsAnswer: true,
      answerReason: "likely-merged",
      suggestion: { commit: HEAD, style: "fast-forward" },
    });
    expect(record.deliveries[0].merge).toBeUndefined();
  });

  test("a patch-identity match is a suggestion and records no merge", async () => {
    const { record, outcomes } = await refreshRecord(linked(), {
      now,
      forgeAccess: noToken,
      localAccess: local({ match: { commit: SQUASH, style: "squash" } }),
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

  test("a head nowhere on the default branch asks, with the last fetch time", async () => {
    const { outcomes } = await refreshRecord(linked(), {
      now,
      forgeAccess: noToken,
      localAccess: local({}),
    });
    expect(outcomes[0]).toMatchObject({
      needsAnswer: true,
      answerReason: "not-on-default",
      fetchedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(outcomes[0]).not.toHaveProperty("fetch");
  });

  test("a deleted branch is answered through the recorded head", async () => {
    const record = upsertDelivery(linked(), REPO, { head: HEAD });
    const { outcomes } = await refreshRecord(record, {
      now,
      forgeAccess: noToken,
      localAccess: local({ tip: null, known: [HEAD], onDefault: [HEAD] }),
    });
    expect(outcomes[0]).toMatchObject({ result: "merged" });
  });

  test("a direct delivery never reaches local Git", async () => {
    const calls: string[] = [];
    const direct = upsertDelivery(unlinkedRecord("x"), REPO, { branch: "main", direct: true });
    const { outcomes } = await refreshRecord(direct, {
      now,
      forgeAccess: noToken,
      localAccess: local({ onDefault: [HEAD] }, calls),
      fetch: true,
    });
    expect(outcomes[0]).toMatchObject({ answerReason: "direct" });
    expect(calls).toEqual([]);
  });

  test("a user's not-yet-merged answer is settled by Git", async () => {
    const answered = upsertDelivery(linked(), REPO, {
      merge: { state: "open", source: "user", checkedAt: "earlier" },
    });
    const { record } = await refreshRecord(answered, {
      now,
      forgeAccess: noToken,
      localAccess: local({ onDefault: [HEAD] }),
    });
    expect(record.deliveries[0].merge).toMatchObject({ state: "merged", source: "git" });
  });

  test("fetch runs only when asked, and a failed fetch still checks local refs", async () => {
    const calls: string[] = [];
    await refreshRecord(linked(), { now, forgeAccess: noToken, localAccess: local({}, calls) });
    expect(calls).not.toContain("fetch");

    const { outcomes } = await refreshRecord(linked(), {
      now,
      forgeAccess: noToken,
      localAccess: local({ onDefault: [HEAD], fetchOk: false }, calls),
      fetch: true,
    });
    expect(calls).toContain("fetch");
    expect(outcomes[0]).toMatchObject({
      result: "merged",
      fetch: { ok: false, message: "git fetch failed: offline" },
    });
  });

  test("without a checkout the forge's reason stands", async () => {
    const { outcomes } = await refreshRecord(linked(), {
      now,
      forgeAccess: noToken,
      localAccess: async () => null,
    });
    expect(outcomes[0]).toMatchObject({ answerReason: "no-token" });
  });
});

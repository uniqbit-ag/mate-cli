import { describe, expect, test } from "bun:test";

import type { ForgeAdapter, PullClassification } from "./forge";
import { unlinkedRecord, upsertDelivery } from "./record";
import { refreshRecord, type ForgeAccess } from "./refresh";

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
});

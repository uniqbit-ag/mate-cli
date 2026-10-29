import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProtectionReason, WorkingRepoGit } from "./branches";
import type { DeliveryEnvironment } from "./environment";
import type { ForgeAdapter, PullClassification } from "./forge";
import {
  DELIVERY_FILE,
  readDeliveryRecord,
  unlinkedRecord,
  upsertDelivery,
  writeDeliveryRecord,
} from "./record";
import {
  recordDelivery,
  type DeliveryOutcome,
  type DeliveryRefusal,
  type DeliveryRequest,
  type DeliveryResult,
} from "./record-delivery";
import type { RepositoryAccess } from "./repository-access";

const APP = "acme/acme-app";
const LIB = "acme/acme-lib";
const NOW = "2026-10-28T10:00:00.000Z";

let companion: string;

interface FakeRepository {
  protectedBranches?: Record<string, ProtectionReason>;
  pulls?: PullClassification;
  noToken?: boolean;
}

/** One fake RepositoryAccess per repository, counting forge pull lookups. */
function fakeAccess(repositories: Record<string, FakeRepository> = {}) {
  const lookups: string[] = [];
  const accessFor = (repository: string): RepositoryAccess => {
    const fake = repositories[repository] ?? {};
    const adapter: ForgeAdapter = {
      id: "github",
      defaultBranch: async () => ({ ok: true, value: "main" }),
      pullsForBranch: async (_repo, branch) => {
        lookups.push(`${repository}#${branch}`);
        return { ok: true, value: fake.pulls ?? { kind: "none" } };
      },
    };
    return {
      defaultBranch: async () => "main",
      protection: async (branch) => {
        const reason = fake.protectedBranches?.[branch] ?? null;
        return { protected: reason !== null, reason };
      },
      forge: async () =>
        fake.noToken
          ? { unavailable: "no-token" }
          : { adapter, repo: { host: "github.com", owner: "acme", repo: repository } },
    };
  };
  return { accessFor, lookups };
}

function git(existing: string[] = []): WorkingRepoGit {
  return {
    currentBranch: async () => "change/x",
    defaultBranch: async () => "main",
    remoteUrl: async () => "git@github.com:acme/acme-app.git",
    unpushedCommits: async () => [],
    branchExists: async (branch) => existing.includes(branch),
  };
}

function environment(
  options: { slug?: string | null; branches?: string[] } = {},
): DeliveryEnvironment {
  const slug = options.slug === undefined ? APP : options.slug;
  return {
    companionPath: companion,
    workingRepo: { path: "/repo", slug, forgeRepo: null, git: git(options.branches) },
    protectedPatterns: [],
  };
}

const changeDir = (name: string) => path.join(companion, "openspec", "changes", name);

async function run(
  request: DeliveryRequest,
  repositories: Record<string, FakeRepository> = {},
  env: DeliveryEnvironment = environment(),
): Promise<DeliveryOutcome & { lookups: string[] }> {
  const { accessFor, lookups } = fakeAccess(repositories);
  const outcome = await recordDelivery(env, request, {
    now: () => new Date(NOW),
    repositoryAccess: accessFor,
  });
  return { ...outcome, lookups };
}

function results(outcome: DeliveryOutcome): DeliveryResult[] {
  if (!("results" in outcome)) throw new Error(`expected results, got ${JSON.stringify(outcome)}`);
  return outcome.results;
}

const written = (change: string) => readDeliveryRecord(changeDir(change));

async function link(change: string, branch: string, repository = APP): Promise<void> {
  await writeDeliveryRecord(
    changeDir(change),
    upsertDelivery(unlinkedRecord(change), repository, { branch }),
  );
}

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "record-delivery-"));
  for (const change of ["x", "a", "b"]) await fs.mkdir(changeDir(change), { recursive: true });
});

afterEach(async () => {
  await fs.rm(companion, { recursive: true, force: true });
});

describe("recordDelivery refusals", () => {
  const cases: Array<{
    name: string;
    request: DeliveryRequest;
    repositories?: Record<string, FakeRepository>;
    env?: () => DeliveryEnvironment;
    refusal: DeliveryRefusal;
  }> = [
    {
      name: "an unknown change",
      request: { changes: ["nope"], edit: { delivery: { branch: "b", direct: false } } },
      refusal: { reason: "unknown-change", change: "nope" },
    },
    {
      name: "an edit without an identifiable repository",
      request: { changes: ["x"], edit: { delivery: { notApplicable: "docs" } } },
      env: () => environment({ slug: null }),
      refusal: { reason: "no-repository" },
    },
    {
      name: "a protected branch without direct",
      request: { changes: ["x"], edit: { delivery: { branch: "main", direct: false } } },
      repositories: { [APP]: { protectedBranches: { main: "default" } } },
      refusal: { reason: "protected-branch", branch: "main", protection: "default" },
    },
    {
      name: "another repository's protected branch",
      request: {
        changes: ["x"],
        repository: LIB,
        edit: { delivery: { branch: "release/2", direct: false } },
      },
      repositories: { [LIB]: { protectedBranches: { "release/2": "pattern" } } },
      refusal: { reason: "protected-branch", branch: "release/2", protection: "pattern" },
    },
    {
      name: "a PR without a delivery branch",
      request: { changes: ["x"], edit: { pr: "https://github.com/acme/acme-app/pull/1" } },
      refusal: { reason: "no-delivery-branch", change: "x", repository: APP, for: "pr" },
    },
    {
      name: "a confirmation without a delivery branch",
      request: { changes: ["x"], edit: { confirm: "merged" } },
      refusal: { reason: "no-delivery-branch", change: "x", repository: APP, for: "confirm" },
    },
  ];

  for (const { name, request, repositories, env, refusal } of cases) {
    test(`refuses ${name} and writes nothing`, async () => {
      const outcome = await run(request, repositories, env?.());
      expect("refusal" in outcome && outcome.refusal).toEqual(refusal);
      expect(await written("x")).toBeNull();
    });
  }

  test("an archived change is unknown unless archived changes are included", async () => {
    const archived = path.join(companion, "openspec", "changes", "archive", "2026-10-01-old");
    await fs.mkdir(archived, { recursive: true });
    const edit = { delivery: { branch: "change/old", direct: false } };
    expect((await run({ changes: ["old"], edit })).refusal).toEqual({
      reason: "unknown-change",
      change: "old",
    });
    const [result] = results(await run({ changes: ["old"], edit, includeArchived: true }));
    expect(result).toMatchObject({
      archived: true,
      path: "openspec/changes/archive/2026-10-01-old",
    });
    expect(await readDeliveryRecord(archived)).toMatchObject({
      deliveries: [{ repository: APP, branch: "change/old" }],
    });
  });

  test("a refusal for a later change leaves earlier changes unwritten", async () => {
    await link("a", "change/a");
    const outcome = await run({ changes: ["a", "b"], edit: { pr: "https://x/pull/1" } });
    expect("refusal" in outcome && outcome.refusal).toMatchObject({ change: "b", for: "pr" });
    expect((await written("a"))?.deliveries[0].pr).toBeUndefined();
  });
});

describe("recordDelivery edits", () => {
  test("a branch is recorded for the Working Repository and written", async () => {
    const [result] = results(
      await run({ changes: ["x"], edit: { delivery: { branch: "change/x", direct: false } } }),
    );
    expect(result).toMatchObject({
      change: "x",
      path: "openspec/changes/x",
      archived: false,
      settlement: { status: "waiting" },
    });
    expect((await written("x"))?.deliveries).toEqual([{ repository: APP, branch: "change/x" }]);
  });

  test("a protected branch is recorded as a direct delivery without a protection check", async () => {
    const [result] = results(
      await run(
        { changes: ["x"], edit: { delivery: { branch: "main", direct: true } } },
        { [APP]: { protectedBranches: { main: "default" } } },
      ),
    );
    expect(result.record.deliveries).toEqual([{ repository: APP, branch: "main", direct: true }]);
  });

  test("--direct records a direct delivery on an unprotected branch", async () => {
    const [result] = results(
      await run({ changes: ["x"], edit: { delivery: { branch: "change/x", direct: true } } }),
    );
    expect(result.record.deliveries).toEqual([
      { repository: APP, branch: "change/x", direct: true },
    ]);
  });

  test("a named repository's delivery is edited instead of the Working Repository's", async () => {
    const [result] = results(
      await run({
        changes: ["x"],
        repository: LIB,
        edit: { delivery: { branch: "change/x", direct: false } },
      }),
    );
    expect(result.record.deliveries).toEqual([{ repository: LIB, branch: "change/x" }]);
  });

  test("a not-applicable reason is recorded", async () => {
    const [result] = results(
      await run({ changes: ["x"], edit: { delivery: { notApplicable: "specification only" } } }),
    );
    expect(result.settlement.status).toBe("not-applicable");
  });

  test("several changes share one branch in one call", async () => {
    const all = results(
      await run({
        changes: ["a", "b"],
        edit: { delivery: { branch: "feature/f", direct: false } },
      }),
    );
    expect(all.map((result) => result.record.deliveries[0].branch)).toEqual([
      "feature/f",
      "feature/f",
    ]);
    expect((await written("b"))?.deliveries[0].branch).toBe("feature/f");
  });

  test("a PR is recorded on an existing branch", async () => {
    await link("x", "change/x");
    const pr = "https://github.com/acme/acme-app/pull/9";
    const [result] = results(await run({ changes: ["x"], edit: { pr } }));
    expect(result.record.deliveries[0].pr).toBe(pr);
  });

  test("a confirmation is recorded with source user and the clock", async () => {
    await link("x", "change/x");
    for (const [confirm, status] of [
      ["merged", "merged"],
      ["closed-unmerged", "dropped"],
      ["open", "waiting"],
    ] as const) {
      const [result] = results(await run({ changes: ["x"], edit: { confirm } }));
      expect(result.record.deliveries[0].merge).toEqual({
        state: confirm,
        source: "user",
        checkedAt: NOW,
      });
      expect(result.settlement.status).toBe(status);
    }
  });

  test("without an edit or refresh the record is only read", async () => {
    const [result] = results(await run({ changes: ["x"] }));
    expect(result.settlement.status).toBe("unlinked");
    await expect(fs.stat(path.join(changeDir("x"), DELIVERY_FILE))).rejects.toThrow();
  });
});

describe("recordDelivery refresh", () => {
  const merged: PullClassification = {
    kind: "merged",
    pr: { number: 70, url: "https://github.com/acme/acme-app/pull/70", mergedBy: "acme-bot" },
  };

  test("a merged PR is recorded with source forge", async () => {
    await link("x", "change/x");
    const [result] = results(
      await run({ changes: ["x"], refresh: true }, { [APP]: { pulls: merged } }),
    );
    expect(result.record.deliveries[0]).toMatchObject({
      pr: "https://github.com/acme/acme-app/pull/70",
      merge: { state: "merged", source: "forge", mergedBy: "acme-bot", checkedAt: NOW },
    });
    expect((await written("x"))?.deliveries[0].merge?.state).toBe("merged");
  });

  test("without a token the outcome asks for an answer and the forge is not asked", async () => {
    await link("x", "change/x");
    const outcome = await run({ changes: ["x"], refresh: true }, { [APP]: { noToken: true } });
    expect(outcome.lookups).toEqual([]);
    expect(results(outcome)[0].outcomes[0]).toMatchObject({
      needsAnswer: true,
      answerReason: "no-token",
    });
  });

  test("a confirmation after a refresh wins over the forge answer", async () => {
    await link("x", "change/x");
    const [result] = results(
      await run(
        { changes: ["x"], refresh: true, edit: { confirm: "closed-unmerged" } },
        { [APP]: { pulls: merged } },
      ),
    );
    expect(result.record.deliveries[0].merge).toMatchObject({
      state: "closed-unmerged",
      source: "user",
    });
  });

  test("a direct delivery is never settled by a refresh; it goes to the user", async () => {
    await writeDeliveryRecord(
      changeDir("x"),
      upsertDelivery(unlinkedRecord("x"), APP, { branch: "main", direct: true }),
    );
    const outcome = await run({ changes: ["x"], refresh: true }, { [APP]: { pulls: merged } });
    const [result] = results(outcome);
    expect(result.record.deliveries[0].merge).toBeUndefined();
    expect(result.outcomes[0]).toEqual({
      repository: APP,
      branch: "main",
      result: "unknown",
      needsAnswer: true,
      answerReason: "direct",
    });
    expect(outcome.lookups).toEqual([]);
  });

  test("changes sharing a branch ask the forge once", async () => {
    await link("a", "feature/f");
    await link("b", "feature/f");
    const outcome = await run({ changes: ["a", "b"], refresh: true }, { [APP]: { pulls: merged } });
    expect(outcome.lookups).toEqual([`${APP}#feature/f`]);
    expect(results(outcome).map((result) => result.settlement.status)).toEqual([
      "merged",
      "merged",
    ]);
  });

  test("a named repository limits the refresh to its delivery", async () => {
    await writeDeliveryRecord(
      changeDir("x"),
      upsertDelivery(upsertDelivery(unlinkedRecord("x"), APP, { branch: "a" }), LIB, {
        branch: "b",
      }),
    );
    const outcome = await run({ changes: ["x"], repository: LIB, refresh: true });
    expect(outcome.lookups).toEqual([`${LIB}#b`]);
  });

  test("the PR number of an edited PR picks the lookup", async () => {
    await link("x", "change/x");
    const asked: Array<number | undefined> = [];
    const { accessFor } = fakeAccess();
    const access = accessFor(APP);
    const forge = await access.forge();
    if (!("adapter" in forge)) throw new Error("expected an adapter");
    forge.adapter.pullsForBranch = async (_repo, _branch, prNumber) => {
      asked.push(prNumber);
      return { ok: true, value: { kind: "none" } };
    };
    await recordDelivery(
      environment(),
      { changes: ["x"], refresh: true, edit: { pr: "https://github.com/acme/acme-app/pull/12" } },
      {
        now: () => new Date(NOW),
        repositoryAccess: () => ({ ...access, forge: async () => forge }),
      },
    );
    // No PR #12 on the forge, so the branch is asked about without it.
    expect(asked).toEqual([12, undefined]);
  });

  test("an edited PR number is not applied to another repository's delivery", async () => {
    await writeDeliveryRecord(
      changeDir("x"),
      upsertDelivery(upsertDelivery(unlinkedRecord("x"), APP, { branch: "a" }), LIB, {
        branch: "b",
      }),
    );
    const asked: Record<string, Array<number | undefined>> = {};
    const { accessFor } = fakeAccess();
    await recordDelivery(
      environment(),
      { changes: ["x"], refresh: true, edit: { pr: "https://github.com/acme/acme-app/pull/12" } },
      {
        now: () => new Date(NOW),
        repositoryAccess: (repository) => {
          const access = accessFor(repository);
          return {
            ...access,
            forge: async () => {
              const forge = await access.forge();
              if (!("adapter" in forge)) throw new Error("expected an adapter");
              forge.adapter.pullsForBranch = async (_repo, _branch, prNumber) => {
                (asked[repository] ??= []).push(prNumber);
                return { ok: true, value: { kind: "none" } };
              };
              return forge;
            },
          };
        },
      },
    );
    expect(asked).toEqual({ [APP]: [12, undefined], [LIB]: [undefined] });
  });
});

describe("recordDelivery requireDelivery", () => {
  test("without a delivery it answers needsBranch, suggesting the existing default branch", async () => {
    const outcome = await run(
      { changes: ["x"], refresh: true, requireDelivery: true },
      {},
      environment({ branches: ["change/x"] }),
    );
    expect("needsBranch" in outcome && outcome.needsBranch).toMatchObject({
      change: "x",
      suggestedBranch: "change/x",
      record: { deliveries: [] },
    });
    expect(outcome.lookups).toEqual([]);
    expect(await written("x")).toBeNull();
  });

  test("no suggestion when the default branch does not exist", async () => {
    const outcome = await run({ changes: ["x"], requireDelivery: true });
    expect("needsBranch" in outcome && outcome.needsBranch.suggestedBranch).toBeNull();
  });

  test("a delivery edit answers the question and the record is refreshed and written", async () => {
    const [result] = results(
      await run({
        changes: ["x"],
        refresh: true,
        requireDelivery: true,
        edit: { delivery: { branch: "change/x", direct: false } },
      }),
    );
    expect(result.outcomes).toHaveLength(1);
    expect((await written("x"))?.deliveries[0].branch).toBe("change/x");
  });

  test("a refresh writes an unlinked record when no delivery is required", async () => {
    const [result] = results(await run({ changes: ["x"], refresh: true }));
    expect(result.settlement.status).toBe("unlinked");
    expect(await written("x")).toMatchObject({ deliveries: [] });
  });
});

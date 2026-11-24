import { afterEach, describe, expect, test } from "bun:test";

import type { WorkingRepoGit } from "./branches";
import type { DeliveryEnvironment } from "./environment";
import type { MergeGit } from "./merge-git";
import { unlinkedRecord, upsertDelivery } from "./record";
import { refreshRecord } from "./refresh";
import { repositoryAccessFor, type Checkout } from "./repository-access";

const APP = "acme/acme-app";
const LIB = "acme/acme-lib";
const HEAD = "a".repeat(40);

function git(overrides: Partial<WorkingRepoGit> = {}): WorkingRepoGit {
  return {
    currentBranch: async () => "change/x",
    defaultBranch: async () => "trunk",
    remoteUrl: async () => "git@github.com:acme/acme-app.git",
    unpushedCommits: async () => [],
    branchExists: async () => false,
    hasRef: async () => false,
    ...overrides,
  };
}

function environment(
  overrides: Partial<WorkingRepoGit> = {},
  checkouts: Record<string, string> = {},
): DeliveryEnvironment {
  return {
    companionPath: "/companion",
    workingRepo: { path: "/repo", slug: APP, git: git(overrides) },
    protectedPatterns: ["release/*"],
    checkoutOf: async (repository) => checkouts[repository] ?? null,
  };
}

interface FakeCheckout {
  isRepository?: boolean;
  defaultBranch?: string;
  origin?: string;
  fetches?: string[];
  listings?: string[];
}

/** A checkout whose answers are fixed: the head is merged by a squash on the default branch. */
function fakeCheckout(options: FakeCheckout = {}): Checkout {
  const merge: MergeGit = {
    isRepository: async () => options.isRepository ?? true,
    originUrl: async () => options.origin ?? null,
    tip: async () => HEAD,
    localTip: async () => null,
    remoteTip: async () => null,
    dirtyWorktree: async () => null,
    aheadOf: async () => false,
    hasCommit: async () => false,
    isAncestor: async () => false,
    onFirstParent: async () => false,
    patchMatch: async () => null,
    supportsContainment: async () => true,
    contains: async () => true,
    firstContaining: async () => ({ commit: "b".repeat(40), committedAt: "t" }),
    lastFetchedAt: async () => null,
    fetch: async (_default, branch) => {
      options.fetches?.push(branch);
      return { ok: true };
    },
    pullRefs: async () => {
      options.listings?.push("ls-remote");
      return [{ number: 42, ref: "pull", commit: HEAD }];
    },
    fetchPullHead: async () => null,
  };
  return { git: merge, defaultBranch: async () => options.defaultBranch ?? "trunk" };
}

describe("repositoryAccessFor", () => {
  test("the Working Repository reads its default branch from local Git", async () => {
    expect(await repositoryAccessFor(environment())(APP).defaultBranch()).toBe("trunk");
  });

  test("another repository reads its default branch from its linked checkout, else main", async () => {
    const linked = environment({}, { [LIB]: "/lib" });
    const access = repositoryAccessFor(linked, {
      openCheckout: () => fakeCheckout({ defaultBranch: "develop" }),
    });
    expect(await access(LIB).defaultBranch()).toBe("develop");
    expect(await repositoryAccessFor(environment())(LIB).defaultBranch()).toBe("main");
  });

  test("protection: default branch and patterns", async () => {
    const access = repositoryAccessFor(environment())(APP);
    expect(await access.protection("trunk")).toEqual({ protected: true, reason: "default" });
    expect(await access.protection("release/1.0")).toEqual({
      protected: true,
      reason: "pattern",
    });
    expect((await access.protection("change/x")).protected).toBe(false);
    // An unlinked repository compares against `main`.
    expect(await repositoryAccessFor(environment())(LIB).protection("main")).toMatchObject({
      protected: true,
    });
  });
});

describe("repositoryAccessFor local checkouts", () => {
  test("a repository without a checkout, or a path that is not a work tree, has none", async () => {
    const env = environment({}, { [APP]: "/repo" });
    expect(
      await repositoryAccessFor(env, { openCheckout: () => fakeCheckout() })(LIB).local?.(),
    ).toBeNull();
    expect(
      await repositoryAccessFor(env, {
        openCheckout: () => fakeCheckout({ isRepository: false }),
      })(APP).local?.(),
    ).toBeNull();
  });

  test("the checkout's default branch is used, each branch fetched and pull refs listed once", async () => {
    const fetches: string[] = [];
    const listings: string[] = [];
    const env = environment({}, { [APP]: "/repo" });
    const local = await repositoryAccessFor(env, {
      openCheckout: () => fakeCheckout({ fetches, listings }),
    })(APP).local?.();
    expect(local?.defaultBranch).toBe("trunk");
    await local?.fetch("change/x");
    await local?.fetch("change/x");
    await local?.fetch("change/y");
    expect(fetches).toEqual(["change/x", "change/y"]);
    await local?.pullRefs();
    await local?.pullRefs();
    expect(listings).toHaveLength(1);
  });
});

describe("linked-only inspection", () => {
  const savedFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  test("a record naming an unlinked repository opens no checkout and sends no request", async () => {
    const opened: string[] = [];
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      throw new Error("no request expected");
    }) as unknown as typeof fetch;
    const access = repositoryAccessFor(environment(), {
      openCheckout: (path) => {
        opened.push(path);
        return fakeCheckout();
      },
    });
    const record = upsertDelivery(unlinkedRecord("x"), "acme/secret-service", {
      branch: "change/x",
    });
    const { record: next, outcomes } = await refreshRecord(record, {
      now: () => new Date(),
      localAccess: async (repository) => (await access(repository).local?.()) ?? null,
      fetch: true,
    });
    expect(outcomes[0]).toMatchObject({ needsAnswer: true, answerReason: "no-checkout" });
    expect(next).toEqual(record);
    expect(opened).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("the PR host comes only from the linked checkout's origin", async () => {
    const refresh = async (origin: string) => {
      const access = repositoryAccessFor(environment({}, { [LIB]: "/lib" }), {
        openCheckout: () => fakeCheckout({ origin }),
      });
      const record = upsertDelivery(unlinkedRecord("x"), LIB, { branch: "change/x" });
      return refreshRecord(record, {
        now: () => new Date(),
        localAccess: async (repository) => (await access(repository).local?.()) ?? null,
        fetch: true,
      });
    };
    const github = await refresh("git@github.com:acme/acme-lib.git");
    expect(github.record.deliveries[0]).toMatchObject({
      pr: "https://github.com/acme/acme-lib/pull/42",
      merge: { state: "merged", source: "git" },
    });
    const selfHosted = await refresh("git@gitlab.acme.dev:acme/acme-lib.git");
    expect(selfHosted.record.deliveries[0].merge).toMatchObject({ state: "merged" });
    expect(selfHosted.record.deliveries[0].pr).toBeUndefined();
  });
});

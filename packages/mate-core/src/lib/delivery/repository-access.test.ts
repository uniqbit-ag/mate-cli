import { describe, expect, test } from "bun:test";

import type { WorkingRepoGit } from "./branches";
import type { DeliveryEnvironment } from "./environment";
import type { ForgeAdapter, ForgeOutcome, ForgeRepo } from "./forge";
import { repositoryAccessFor } from "./repository-access";

const APP = "acme/acme-app";
const LIB = "acme/acme-lib";
const TOKEN = { token: "t", source: "MATE_GIT_TOKEN" as const };

function git(overrides: Partial<WorkingRepoGit> = {}): WorkingRepoGit {
  return {
    currentBranch: async () => "change/x",
    defaultBranch: async () => "trunk",
    remoteUrl: async () => "git@github.com:acme/acme-app.git",
    unpushedCommits: async () => [],
    branchExists: async () => false,
    ...overrides,
  };
}

function environment(overrides: Partial<WorkingRepoGit> = {}): DeliveryEnvironment {
  return {
    companionPath: "/companion",
    workingRepo: {
      path: "/repo",
      slug: APP,
      forgeRepo: { host: "github.com", owner: "acme", repo: "acme-app" },
      git: git(overrides),
    },
    protectedPatterns: ["release/*"],
  };
}

interface ForgeAnswers {
  defaultBranch?: ForgeOutcome<string>;
}

/** Forge fetch stub answering the GitHub repository endpoint. */
function forgeFetch(answers: ForgeAnswers, calls: string[] = []) {
  return async (url: string): Promise<Response> => {
    calls.push(url);
    const answer = answers.defaultBranch;
    if (!answer) return new Response("{}", { status: 404 });
    if (!answer.ok) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ default_branch: answer.value }), { status: 200 });
  };
}

describe("repositoryAccessFor", () => {
  test("the Working Repository reads its default branch from local Git", async () => {
    const access = repositoryAccessFor(environment(), { resolveToken: async () => null })(APP);
    expect(await access.defaultBranch()).toBe("trunk");
  });

  test("another repository reads its default branch from the forge", async () => {
    const access = repositoryAccessFor(environment(), {
      resolveToken: async () => TOKEN,
      forge: { fetch: forgeFetch({ defaultBranch: { ok: true, value: "develop" } }) },
    })(LIB);
    expect(await access.defaultBranch()).toBe("develop");
  });

  test("another repository falls back to main without a token or after a failed lookup", async () => {
    const noToken = repositoryAccessFor(environment(), { resolveToken: async () => null })(LIB);
    expect(await noToken.defaultBranch()).toBe("main");
    const failed = repositoryAccessFor(environment(), {
      resolveToken: async () => TOKEN,
      forge: { fetch: forgeFetch({ defaultBranch: { ok: false } as ForgeOutcome<string> }) },
    })(LIB);
    expect(await failed.defaultBranch()).toBe("main");
  });

  test("protection: default branch and patterns, never the forge", async () => {
    const calls: string[] = [];
    const access = repositoryAccessFor(environment(), {
      resolveToken: async () => TOKEN,
      forge: { fetch: forgeFetch({}, calls) },
    })(APP);
    expect(await access.protection("trunk")).toEqual({ protected: true, reason: "default" });
    expect(await access.protection("release/2")).toEqual({ protected: true, reason: "pattern" });
    expect(await access.protection("change/x")).toEqual({ protected: false, reason: null });
    expect(calls).toEqual([]);
  });

  test("another repository compares against its forge default branch, else main", async () => {
    const noToken = repositoryAccessFor(environment(), { resolveToken: async () => null })(LIB);
    expect(await noToken.protection("main")).toEqual({ protected: true, reason: "default" });
    expect(await noToken.protection("develop")).toEqual({ protected: false, reason: null });
    const known = repositoryAccessFor(environment(), {
      resolveToken: async () => TOKEN,
      forge: { fetch: forgeFetch({ defaultBranch: { ok: true, value: "develop" } }) },
    })(LIB);
    expect(await known.protection("develop")).toEqual({ protected: true, reason: "default" });
    expect(await known.protection("change/x")).toEqual({ protected: false, reason: null });
  });

  test("forge access names the missing token or an unsupported host", async () => {
    expect(
      await repositoryAccessFor(environment(), { resolveToken: async () => null })(APP).forge(),
    ).toEqual({ unavailable: "no-token" });
    const gitlab = environment();
    gitlab.workingRepo!.forgeRepo = { host: "gitlab.com", owner: "acme", repo: "acme-app" };
    expect(
      await repositoryAccessFor(gitlab, { resolveToken: async () => TOKEN })(APP).forge(),
    ).toEqual({ unavailable: "unsupported-host" });
  });

  test("an unlinked repository takes the Working Repository's host", async () => {
    const access = await repositoryAccessFor(environment(), { resolveToken: async () => TOKEN })(
      LIB,
    ).forge();
    expect("repo" in access && access.repo).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "acme-lib",
    } satisfies ForgeRepo);
    expect("adapter" in access && (access.adapter as ForgeAdapter).id).toBe("github");
  });

  test("a linked repository's own host wins, so a GitLab repository sends no GitHub request", async () => {
    const calls: string[] = [];
    const linked = environment();
    linked.hostOf = async (repository) => (repository === LIB ? "gitlab.acme.dev" : "github.com");
    const access = repositoryAccessFor(linked, {
      resolveToken: async () => TOKEN,
      forge: { fetch: forgeFetch({ defaultBranch: { ok: true, value: "develop" } }, calls) },
    })(LIB);
    expect(await access.forge()).toEqual({ unavailable: "unsupported-host" });
    expect(await access.defaultBranch()).toBe("main");
    expect(calls).toEqual([]);
  });

  test("a nested path is never split into a wrong owner", async () => {
    const nested = environment();
    nested.hostOf = async () => "gitlab.acme.dev";
    const access = repositoryAccessFor(nested, { resolveToken: async () => TOKEN });
    expect(await access("acme/platform/web").forge()).toEqual({ unavailable: "unsupported-host" });

    const github = await repositoryAccessFor(environment(), {
      resolveToken: async () => TOKEN,
    })("acme/platform/web").forge();
    expect("repo" in github && github.repo).toEqual({
      host: "github.com",
      owner: "acme/platform",
      repo: "web",
    } satisfies ForgeRepo);
  });

  test("without any known host another repository asks instead of assuming github.com", async () => {
    let resolved = 0;
    const bare: DeliveryEnvironment = { ...environment(), workingRepo: null };
    const access = repositoryAccessFor(bare, {
      resolveToken: async () => {
        resolved += 1;
        return TOKEN;
      },
    })(LIB);
    expect(await access.forge()).toEqual({ unavailable: "unsupported-host" });
    expect(resolved).toBe(0);
  });

  test("the token is resolved at most once, and only when a lookup needs it", async () => {
    let resolved = 0;
    const accessFor = repositoryAccessFor(environment(), {
      resolveToken: async () => {
        resolved += 1;
        return TOKEN;
      },
      forge: { fetch: forgeFetch({ protected: { ok: true, value: false } }) },
    });
    await accessFor(APP).defaultBranch();
    await accessFor(APP).protection("trunk");
    expect(resolved).toBe(0);
    await accessFor(APP).protection("change/x");
    await accessFor(LIB).forge();
    await accessFor(APP).forge();
    expect(resolved).toBe(1);
  });
});

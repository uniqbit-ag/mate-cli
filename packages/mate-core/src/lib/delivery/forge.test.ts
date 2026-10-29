import { describe, expect, test } from "bun:test";

import {
  forgeFor,
  forgeRepoOf,
  githubForge,
  parseRemote,
  repositoryPath,
  type ForgeRepo,
} from "./forge";

const TOKEN = "ghp_SECRET_VALUE_123";
const REPO: ForgeRepo = { host: "github.com", owner: "acme", repo: "acme-app" };

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(
  routes: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: route.headers,
    });
  };
  return { calls, fetchFn };
}

const API = "https://api.github.com/repos/acme/acme-app";
const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  html_url: `https://github.com/acme/acme-app/pull/${number}`,
  state: "closed",
  merged_at: null,
  ...extra,
});

describe("parseRemote", () => {
  test("normalizes SSH and HTTPS remotes", () => {
    expect(parseRemote("git@github.com:acme/acme-app.git")).toEqual(REPO);
    expect(parseRemote("https://github.com/acme/acme-app")).toEqual(REPO);
    expect(parseRemote("ssh://git@github.com:22/acme/acme-app.git")).toEqual(REPO);
    expect(parseRemote("https://user:pw@github.com/acme/acme-app.git")).toEqual(REPO);
    expect(parseRemote("github-work:acme/acme-app.git")).toEqual({
      ...REPO,
      host: "github-work",
    });
    expect(parseRemote("C:/acme/acme-app")).toBeNull();
    expect(parseRemote("not a url")).toBeNull();
  });

  test("a nested group keeps every namespace segment in every remote form", () => {
    const nested: ForgeRepo = { host: "gitlab.acme.dev", owner: "acme/platform", repo: "api" };
    expect(parseRemote("git@gitlab.acme.dev:acme/platform/api.git")).toEqual(nested);
    expect(parseRemote("https://gitlab.acme.dev/acme/platform/api.git")).toEqual(nested);
    expect(parseRemote("ssh://git@gitlab.acme.dev/acme/platform/api")).toEqual(nested);
    expect(parseRemote("https://user:pw@gitlab.acme.dev/acme/platform/api.git/")).toEqual(nested);
    expect(repositoryPath(nested)).toBe("acme/platform/api");
    expect(repositoryPath(REPO)).toBe("acme/acme-app");
  });

  test("forgeRepoOf splits at the last segment", () => {
    expect(forgeRepoOf("GitHub.com", "acme/acme-app")).toEqual(REPO);
    expect(forgeRepoOf("gitlab.acme.dev", "acme/platform/api")?.owner).toBe("acme/platform");
    expect(forgeRepoOf("github.com", "acme")).toBeNull();
  });

  test("only github.com has a forge adapter", () => {
    expect(forgeFor(REPO, TOKEN)?.id).toBe("github");
    expect(forgeFor({ ...REPO, host: "gitlab.com" }, TOKEN)).toBeNull();
  });
});

describe("githubForge", () => {
  test("a merged PR carries merge time, merge commit, and merger", async () => {
    const { fetchFn, calls } = fakeFetch({
      [`${API}/pulls?`]: { status: 200, body: [pull(70, { merged_at: "2026-10-27T09:00:00Z" })] },
      [`${API}/pulls/70`]: {
        status: 200,
        body: pull(70, {
          merged_at: "2026-10-27T09:00:00Z",
          merge_commit_sha: "abc123",
          merged_by: { login: "acme-bot" },
        }),
      },
    });
    const result = await githubForge(TOKEN, { fetch: fetchFn }).pullsForBranch(REPO, "change/x");
    expect(result).toEqual({
      ok: true,
      value: {
        kind: "merged",
        pr: {
          number: 70,
          url: "https://github.com/acme/acme-app/pull/70",
          mergedAt: "2026-10-27T09:00:00Z",
          mergeCommit: "abc123",
          mergedBy: "acme-bot",
        },
      },
    });
    expect(calls[0].url).toBe(`${API}/pulls?head=acme%3Achange%2Fx&state=all&per_page=100`);
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("a squash merge is merged because merged_at is set", async () => {
    const merged = pull(5, { merged_at: "2026-10-01T00:00:00Z", merge_commit_sha: "squash1" });
    const { fetchFn } = fakeFetch({
      [`${API}/pulls?`]: { status: 200, body: [merged] },
      [`${API}/pulls/5`]: { status: 200, body: merged },
    });
    const result = await githubForge(TOKEN, { fetch: fetchFn }).pullsForBranch(REPO, "b");
    expect(result.ok && result.value.kind).toBe("merged");
  });

  test("open, closed-unmerged, and none are classified", async () => {
    const cases: Array<[unknown[], string]> = [
      [[pull(1, { state: "open" })], "open"],
      [[pull(2)], "closed-unmerged"],
      [[], "none"],
    ];
    for (const [body, kind] of cases) {
      const { fetchFn } = fakeFetch({ [`${API}/pulls?`]: { status: 200, body } });
      const result = await githubForge(TOKEN, { fetch: fetchFn }).pullsForBranch(REPO, "b");
      expect(result.ok && result.value.kind).toBe(kind);
    }
  });

  test("a reused branch with several PRs is ambiguous unless one is chosen", async () => {
    const body = [pull(9, { merged_at: "2026-01-01T00:00:00Z" }), pull(12, { state: "open" })];
    const { fetchFn } = fakeFetch({ [`${API}/pulls?`]: { status: 200, body } });
    const forge = githubForge(TOKEN, { fetch: fetchFn });
    const ambiguous = await forge.pullsForBranch(REPO, "b");
    expect(ambiguous.ok && ambiguous.value).toEqual({
      kind: "ambiguous",
      candidates: [
        { number: 9, url: "https://github.com/acme/acme-app/pull/9", state: "merged" },
        { number: 12, url: "https://github.com/acme/acme-app/pull/12", state: "open" },
      ],
    });
    const chosen = await forge.pullsForBranch(REPO, "b", 12);
    expect(chosen.ok && chosen.value.kind).toBe("open");
  });

  test("a fork's PR is found on its parent repository", async () => {
    const UPSTREAM = "https://api.github.com/repos/acme-upstream/acme-app";
    const { fetchFn, calls } = fakeFetch({
      [`${API}/pulls?`]: { status: 200, body: [] },
      [`${UPSTREAM}/pulls?`]: { status: 200, body: [pull(5, { state: "open" })] },
      [API]: { status: 200, body: { parent: { full_name: "acme-upstream/acme-app" } } },
    });
    const result = await githubForge(TOKEN, { fetch: fetchFn }).pullsForBranch(REPO, "change/x");
    expect(result.ok && result.value.kind).toBe("open");
    expect(calls.at(-1)?.url).toBe(
      `${UPSTREAM}/pulls?head=acme%3Achange%2Fx&state=all&per_page=100`,
    );
  });

  test("the default branch comes from the repository", async () => {
    const { fetchFn } = fakeFetch({ [API]: { status: 200, body: { default_branch: "trunk" } } });
    expect(await githubForge(TOKEN, { fetch: fetchFn }).defaultBranch(REPO)).toEqual({
      ok: true,
      value: "trunk",
    });
  });

  test("a rate limit is reported as such", async () => {
    const { fetchFn } = fakeFetch({
      [`${API}/pulls?`]: {
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0" },
      },
    });
    const result = await githubForge(TOKEN, { fetch: fetchFn }).pullsForBranch(REPO, "b");
    expect(!result.ok && result.failure.reason).toBe("rate-limit");
  });

  test("a forbidden or hidden repository names the missing read permission", async () => {
    for (const status of [403, 404]) {
      const { fetchFn } = fakeFetch({ [`${API}/pulls?`]: { status, body: { message: "x" } } });
      const result = await githubForge(TOKEN, { fetch: fetchFn }).pullsForBranch(REPO, "b");
      expect(!result.ok && result.failure).toMatchObject({
        reason: "permission",
        permission: "Pull requests: read",
      });
    }
  });

  test("a rejected token and a network failure are failures, never results", async () => {
    const { fetchFn } = fakeFetch({ [`${API}/pulls?`]: { status: 401, body: {} } });
    const rejected = await githubForge(TOKEN, { fetch: fetchFn }).pullsForBranch(REPO, "b");
    expect(!rejected.ok && rejected.failure.reason).toBe("auth");

    const offline = await githubForge(TOKEN, {
      fetch: async () => {
        throw new Error(`connect failed with Bearer ${TOKEN}`);
      },
    }).pullsForBranch(REPO, "b");
    expect(!offline.ok && offline.failure.reason).toBe("network");
    expect(JSON.stringify(offline)).not.toContain(TOKEN);
  });

  test("a success answer with an unreadable body is a failure, never a throw", async () => {
    const fetchFn = async () => new Response("<html>portal</html>", { status: 200 });
    const result = await githubForge(TOKEN, { fetch: fetchFn }).pullsForBranch(REPO, "b");
    expect(!result.ok && result.failure.reason).toBe("unexpected");
  });

  test("a response echoing the token never carries it into the failure", async () => {
    const { fetchFn } = fakeFetch({
      [`${API}/pulls?`]: { status: 500, body: { message: `bad credentials ${TOKEN}` } },
    });
    const result = await githubForge(TOKEN, { fetch: fetchFn }).pullsForBranch(REPO, "b");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  test("requests go only to the GitHub API", async () => {
    const { fetchFn, calls } = fakeFetch({ [`${API}/pulls?`]: { status: 200, body: [] } });
    await githubForge(TOKEN, { fetch: fetchFn }).pullsForBranch(REPO, "b");
    expect(calls.every((call) => call.url.startsWith("https://api.github.com/"))).toBe(true);
  });
});

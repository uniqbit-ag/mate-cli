import { describe, expect, test } from "bun:test";

import {
  forgeRepoOf,
  parseRemote,
  pullRequestOf,
  pullRequestUrl,
  repositoryPath,
  type RemoteRepo,
} from "./remote";

const REPO: RemoteRepo = { host: "github.com", owner: "acme", repo: "acme-app" };

describe("parseRemote", () => {
  test("SSH, scp-style and HTTPS remotes name one repository; credentials are dropped", () => {
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

  test("a nested group keeps every segment before the repository", () => {
    const nested: RemoteRepo = { host: "gitlab.acme.dev", owner: "acme/platform", repo: "api" };
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
});

describe("pullRequestUrl", () => {
  test("GitHub, GitLab and Azure DevOps get a URL; any other host none", () => {
    expect(pullRequestUrl(parseRemote("git@github.com:acme/api.git")!, 42)).toBe(
      "https://github.com/acme/api/pull/42",
    );
    expect(pullRequestUrl(parseRemote("https://gitlab.com/acme/platform/api.git")!, 7)).toBe(
      "https://gitlab.com/acme/platform/api/-/merge_requests/7",
    );
    const azure = "https://dev.azure.com/acme/platform/_git/api/pullrequest/3";
    for (const url of [
      "https://dev.azure.com/acme/platform/_git/api",
      "git@ssh.dev.azure.com:v3/acme/platform/api",
      "acme@vs-ssh.visualstudio.com:v3/acme/platform/api",
      "https://acme.visualstudio.com/platform/_git/api",
      "https://acme.visualstudio.com/DefaultCollection/platform/_git/api",
    ]) {
      expect(pullRequestUrl(parseRemote(url)!, 3)).toBe(azure);
    }
    expect(pullRequestUrl(parseRemote("git@git.acme.dev:acme/api.git")!, 42)).toBeNull();
    expect(pullRequestUrl(parseRemote("git@bitbucket.org:acme/api.git")!, 42)).toBeNull();
  });

  test("a recorded URL names its PR number and ref family", () => {
    expect(pullRequestOf("https://github.com/acme/api/pull/42")).toEqual({
      number: 42,
      ref: "pull",
    });
    expect(pullRequestOf("https://gitlab.com/acme/api/-/merge_requests/7")).toEqual({
      number: 7,
      ref: "merge-requests",
    });
    expect(pullRequestOf("https://acme.dev/review/42")).toBeNull();
    expect(pullRequestOf(undefined)).toBeNull();
  });
});

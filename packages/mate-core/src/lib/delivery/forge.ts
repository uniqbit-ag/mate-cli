/**
 * Forge adapters answer read-only questions about a repository and its Delivery Branch:
 * the default branch, whether the branch is protected, and which PR has it as head. GitHub (github.com) is the only adapter; every other host
 * falls back to asking the user. Every failure is returned, never thrown, and the token
 * is scrubbed from anything a failure carries.
 */

import { errorMessage } from "../../runtime/error-message";
import { pickProvenance, type MergeProvenance, type MergeState } from "./record";

export interface ForgeRepo {
  host: string;
  /** Every path segment before the repository; nested groups keep theirs (`acme/platform`). */
  owner: string;
  repo: string;
}

export interface PullCandidate {
  number: number;
  url: string;
  state: MergeState;
}

export interface PullDetail extends MergeProvenance {
  number: number;
  url: string;
}

export type PullClassification =
  | { kind: "merged"; pr: PullDetail }
  | { kind: "open"; pr: PullDetail }
  | { kind: "closed-unmerged"; pr: PullDetail }
  | { kind: "ambiguous"; candidates: PullCandidate[] }
  | { kind: "none" };

export type ForgeFailureReason = "permission" | "rate-limit" | "auth" | "network" | "unexpected";

export interface ForgeFailure {
  reason: ForgeFailureReason;
  message: string;
  /** The fine-grained read permission a `permission` failure lacks. */
  permission?: string;
  /** The HTTP status the forge answered, when it answered. */
  status?: number;
}

export type ForgeOutcome<T> = { ok: true; value: T } | { ok: false; failure: ForgeFailure };

export interface ForgeAdapter {
  id: string;
  defaultBranch(repo: ForgeRepo): Promise<ForgeOutcome<string>>;
  /** Classifies the PRs whose head is `branch`; `prNumber` picks one of several. */
  pullsForBranch(
    repo: ForgeRepo,
    branch: string,
    prNumber?: number,
  ): Promise<ForgeOutcome<PullClassification>>;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<Response>;

export interface ForgeDeps {
  fetch?: FetchLike;
}

/** Parses SSH, scp-style, and HTTPS remotes; credentials in a URL are discarded. */
export function parseRemote(url: string): ForgeRepo | null {
  const cleaned = url.trim();
  let host: string;
  let remotePath: string;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(cleaned)) {
    try {
      const parsed = new URL(cleaned);
      host = parsed.hostname;
      remotePath = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    // `user@` is optional: an SSH config alias such as `work:org/repo` has none.
    const scp = /^(?:[^/\s@]+@)?([^/\s:]{2,}):(.+)$/.exec(cleaned);
    if (!scp) return null;
    host = scp[1];
    remotePath = scp[2];
  }
  if (!host) return null;
  return forgeRepoOf(host, remotePath.replace(/\.git\/?$/, ""));
}

/** Splits a repository path at its last segment; null below two segments. */
export function forgeRepoOf(host: string, path: string): ForgeRepo | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return {
    host: host.toLowerCase(),
    owner: parts.slice(0, -1).join("/"),
    repo: parts.at(-1) as string,
  };
}

/** The repository's identity: its full path on the host, `owner/repo`. */
export function repositoryPath(repo: ForgeRepo): string {
  return `${repo.owner}/${repo.repo}`;
}

/** The adapter for a remote's host, or null when the host has none. */
export function forgeFor(
  repo: ForgeRepo,
  token: string,
  deps: ForgeDeps = {},
): ForgeAdapter | null {
  return repo.host === "github.com" ? githubForge(token, deps) : null;
}

/** Replaces every occurrence of the token, so no failure text can carry it. */
function redactToken(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

const GITHUB_API = "https://api.github.com";

interface GithubPull {
  number: number;
  html_url: string;
  state: string;
  merged_at: string | null;
  merge_commit_sha?: string | null;
  merged_by?: { login?: string } | null;
}

function candidateState(pull: GithubPull): PullCandidate["state"] {
  if (pull.merged_at) return "merged";
  return pull.state === "open" ? "open" : "closed-unmerged";
}

function detail(pull: GithubPull): PullDetail {
  return {
    number: pull.number,
    url: pull.html_url,
    ...pickProvenance({
      mergedAt: pull.merged_at ?? undefined,
      mergeCommit: (pull.merged_at && pull.merge_commit_sha) || undefined,
      mergedBy: pull.merged_by?.login,
    }),
  };
}

function repoPath(repo: ForgeRepo): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

export function githubForge(token: string, deps: ForgeDeps = {}): ForgeAdapter {
  const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));

  async function get<T>(apiPath: string, permission: string): Promise<ForgeOutcome<T>> {
    let response: Response;
    try {
      response = await fetchFn(`${GITHUB_API}${apiPath}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "mate-cli",
        },
      });
    } catch (error) {
      return {
        ok: false,
        failure: {
          reason: "network",
          message: redactToken(`GitHub request failed: ${errorMessage(error)}`, token),
        },
      };
    }
    const fail = (
      reason: ForgeFailureReason,
      message: string,
      extra: Pick<ForgeFailure, "permission"> = {},
    ): ForgeOutcome<T> => ({
      ok: false,
      failure: {
        reason,
        message: redactToken(message, token),
        ...extra,
        ...(response.ok ? {} : { status: response.status }),
      },
    });
    if (response.ok) {
      try {
        return { ok: true, value: (await response.json()) as T };
      } catch (error) {
        return fail(
          "unexpected",
          `GitHub answered with an unreadable body: ${errorMessage(error)}`,
        );
      }
    }
    if (response.status === 401) return fail("auth", "GitHub rejected the token (401).");
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
      return fail("rate-limit", "GitHub API rate limit reached (403).");
    }
    if (response.status === 403 || response.status === 404) {
      return fail(
        "permission",
        `GitHub refused the request (${response.status}); the token needs ${permission} on this repository.`,
        { permission },
      );
    }
    return fail("unexpected", `GitHub answered ${response.status}.`);
  }

  return {
    id: "github",
    async defaultBranch(repo) {
      const result = await get<{ default_branch?: string }>(repoPath(repo), "Metadata: read");
      if (!result.ok) return result;
      const branch = result.value.default_branch;
      return branch
        ? { ok: true, value: branch }
        : {
            ok: false,
            failure: { reason: "unexpected", message: "GitHub named no default branch." },
          };
    },
    async pullsForBranch(repo, branch, prNumber) {
      const head = encodeURIComponent(`${repo.owner}:${branch}`);
      const listPulls = (target: string) =>
        get<GithubPull[]>(
          `${target}/pulls?head=${head}&state=all&per_page=100`,
          "Pull requests: read",
        );
      let listed = await listPulls(repoPath(repo));
      if (!listed.ok) return listed;
      let pullRepo = repoPath(repo);
      if (listed.value.length === 0) {
        // A fork's PR is opened on its parent; the head stays `<fork owner>:<branch>`.
        const metadata = await get<{ parent?: { full_name?: string } }>(
          repoPath(repo),
          "Metadata: read",
        );
        const parent = metadata.ok ? metadata.value.parent?.full_name : undefined;
        if (parent) {
          pullRepo = `/repos/${parent.split("/").map(encodeURIComponent).join("/")}`;
          listed = await listPulls(pullRepo);
          if (!listed.ok) return listed;
        }
      }
      const pulls =
        prNumber === undefined
          ? listed.value
          : listed.value.filter((entry) => entry.number === prNumber);
      if (pulls.length === 0) return { ok: true, value: { kind: "none" } };
      if (pulls.length > 1) {
        return {
          ok: true,
          value: {
            kind: "ambiguous",
            candidates: pulls
              .map((entry) => ({
                number: entry.number,
                url: entry.html_url,
                state: candidateState(entry),
              }))
              .toSorted((a, b) => a.number - b.number),
          },
        };
      }
      const [only] = pulls;
      const state = candidateState(only);
      if (state !== "merged") return { ok: true, value: { kind: state, pr: detail(only) } };
      // The list omits the merger; only the single-PR endpoint carries it.
      const full = await get<GithubPull>(`${pullRepo}/pulls/${only.number}`, "Pull requests: read");
      return { ok: true, value: { kind: "merged", pr: detail(full.ok ? full.value : only) } };
    },
  };
}

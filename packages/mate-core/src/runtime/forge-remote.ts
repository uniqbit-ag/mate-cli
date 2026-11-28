/** Repository identity from a Git remote URL; in `runtime/` so hooks and the OpenCode plugin can parse one. */

export interface RemoteRepo {
  host: string;
  /** Every path segment before the repository; nested groups keep theirs (`acme/platform`). */
  owner: string;
  repo: string;
}

/** Parses SSH, scp-style, and HTTPS remotes; credentials in a URL are discarded. */
export function parseRemote(url: string): RemoteRepo | null {
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
export function forgeRepoOf(host: string, path: string): RemoteRepo | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return {
    host: host.toLowerCase(),
    owner: parts.slice(0, -1).join("/"),
    repo: parts.at(-1) as string,
  };
}

/** The repository's identity: its full path on the host, `owner/repo`. */
export function repositoryPath(repo: RemoteRepo): string {
  return `${repo.owner}/${repo.repo}`;
}

/** `host/owner/repo` for a Git URL, so SSH and HTTPS forms of one repository are equal; null when unparsable. */
export function remoteIdentity(url: string): string | null {
  const repo = parseRemote(url);
  return repo ? `${repo.host}/${repositoryPath(repo)}` : null;
}
